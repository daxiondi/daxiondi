/**
 * CLI 子进程的 stdin/stdout 帧协议（协议版本 2）。
 *
 * 职责：定义内核与 CLI 宿主之间的双向帧格式——内核写 stdin（job_start /
 * cancel / ping 三种），CLI 上报 stdout（host_ready / slot_ready /
 * stream_event / job_done / job_error / cancel_ack / pong）。
 *
 * 关键约束：
 * 1. CLI 只接受 job_start / cancel / ping 三种 stdin 帧，其余类型静默丢弃，
 *    不返回错误。因此内核写错帧不会有任何反馈，只能靠 dones 帧超时发现。
 * 2. cancel 帧的第一字段是 job_id 而不是 request；slot_id 是可选字段
 *    （缺省时 CLI 按 job_id 反查）。字段顺序不影响 JSON 语义，但保持
 *    job_id 在前便于日志比对。
 * 3. host_ready 的五项校验（system_layout / protocol_version / slots /
 *    timezone / config_hash）任一不符，内核就拒绝注册该 slot。
 * 4. metadata.user_id 必须是 JSON 字符串再套一层，且 device_id 必须是
 *    64 位 hex、session_id 绝不能含 "@"（上游会以 has_at 拒绝）。
 */

import { createInterface } from "node:readline"
import { createRequire } from "node:module"

import {
  QUOTA_WINDOW_KEYS,
  WINDOW_MINUTES_BY_KEY,
  normalizeStatus,
  parseResetAt,
  toUsedPct,
} from './quota-window.mjs'

const require = createRequire(import.meta.url)

export const PROTOCOL_VERSION = 2

export const CLI_CAPABILITIES = Object.freeze([
  'multi_slot',
  'native_sse',
  'stateless',
  'ping',
  'classifier_request_context',
])

/** slot id 格式：s00 … s19（两位零填充，超过 99 会溢出成三位） */
export function slotId(index) {
  return `s${String(index).padStart(2, '0')}`
}

/** CLI 侧只接受这三种 stdin 帧，其余静默丢弃 */
export const STDIN_FRAME_TYPES = Object.freeze(['job_start', 'cancel', 'ping'])

// ── 真实 Claude Code CLI 的 stream-json 对话方言 ─────────────
//
// 上面那套 job_start/job_done 是自研宿主（假 CLI）的私有协议；真 CLI 只认
// 官方的 stream-json NDJSON：stdin 收 `user` / `control_request`，stdout 出
// `system` / `assistant` / `stream_event` / `rate_limit_event` / `result`。
// 两套协议在本文件里都有，靠 CliHost 的 dialect 区分，互不干扰。

/**
 * 拉起真 CLI 的必需参数。
 *
 * `-p` 只是 print 模式，缺 input-format 时 CLI 按 text 读 stdin，会一直阻塞到
 * EOF 才开始处理，我们发的 JSONL 一帧都进不去（实测报错：Input must be
 * provided either through stdin or as a prompt argument when using --print）。
 * `--output-format stream-json` 在 2.1.x 上强制要求 `--verbose`，否则直接报错退出。
 */
export const CLI_SPAWN_ARGS = Object.freeze([
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
])

/** 原生 stdin 帧类型：user 派活，control_request 走初始化 / 中断等控制面。 */
export const NATIVE_STDIN_FRAME_TYPES = Object.freeze(['user', 'control_request'])

/** 原生 stdout 帧类型（classifyStdoutFrame 识别的全集）。 */
export const NATIVE_STDOUT_FRAME_TYPES = Object.freeze([
  'system',
  'assistant',
  'stream_event',
  'rate_limit_event',
  'result',
  'control_response',
])

/** 没有 parent_tool_use_id 时填这个（官方 schema 是 string().nullable()，必须出现）。 */
export const NO_PARENT_TOOL = null

/**
 * 构造一条原生 user 帧。
 *
 * 三个字段缺一不可，且 content 必须是数组形态的 content block：
 *   - content: [{type:'text', text}] —— 传裸字符串也能被 CLI 接受，但会被当成
 *     一整块非结构化内容，官方 schema 走的是 block 数组；
 *   - parent_tool_use_id: null —— 顶层对话必须是 null，字段不能省；
 *   - session_id: UUID —— CLI 用它做会话归属与上下文续接。
 *
 * @returns {{type:'user', message:object, parent_tool_use_id:null, session_id:string}}
 */
export function cliUserFrame({ text, sessionId, parentToolUseId = NO_PARENT_TOOL }) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: String(text ?? '') }],
    },
    parent_tool_use_id: parentToolUseId,
    session_id: sessionId,
  }
}

/** 控制面请求帧（initialize / interrupt / set_permission_mode）。 */
export function cliControlRequestFrame({ requestId, subtype, extra }) {
  return {
    type: 'control_request',
    request_id: requestId,
    request: { subtype, ...(extra && typeof extra === 'object' ? extra : {}) },
  }
}

/**
 * 把 Anthropic Messages body 摊平成一段纯文本。
 *
 * 真 CLI 的 user 帧不接 Messages 结构，只接消息内容。这里按官方语义拼接：
 * 多条 message 用空行分隔，content 支持字符串与 block 数组（只取 text 块），
 * system 作为前导说明附在最前面。
 */
export function textFromMessagesRequest(request) {
  const parts = []
  const system = request?.system
  if (typeof system === 'string' && system.trim()) parts.push(system.trim())
  else if (Array.isArray(system)) {
    const sysText = system
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (sysText) parts.push(sysText)
  }
  for (const message of Array.isArray(request?.messages) ? request.messages : []) {
    const content = message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    }
    if (text.trim()) parts.push(text)
  }
  return parts.join('\n\n')
}

/**
 * 从原生 rate_limit_event 的 rate_limit_info 提取两套窗口读数。
 *
 * 上游的 unifiedWindows 用 five_hour / seven_day 命名，utilization 是 0-1 的
 * ratio，resetsAt 是秒级时间戳。本仓库的窗口模型（quota-window.mjs）只认
 * '5h' / '7d' 两键、usedPct 是 0-100、resetAt 是毫秒，转换必须在这里做，
 * 否则 0.21 会被当成 0.21% 而不是 21%。
 *
 * 没有任何窗口数据时返回 null——调用方据此跳过本次更新，不要拿空值覆盖既有读数。
 *
 * @returns {{'5h':object|null, '7d':object|null, at:number, source:string}|null}
 */
export function quotaWindowsFromRateLimit(rateLimitInfo, { at = Date.now() } = {}) {
  const info = rateLimitInfo
  if (!info || typeof info !== 'object') return null
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {}
  // 顶层 status 描述的是 rateLimitType 指向的那个窗口（实测 five_hour）
  const topStatus = normalizeStatus(info.status)
  const typeKey = String(info.rateLimitType || '').toLowerCase()

  const pick = (entry, key) => {
    if (!entry || typeof entry !== 'object') return null
    const hasAny = entry.utilization != null || entry.resetsAt != null
    if (!hasAny) return null
    return {
      key,
      usedPct: toUsedPct(entry.utilization, 'ratio') ?? 0,
      resetAt: parseResetAt(entry.resetsAt),
      windowMinutes: WINDOW_MINUTES_BY_KEY[key],
      status: key === '5h' && (typeKey === 'five_hour' || typeKey === '') ? topStatus : null,
      source: 'cli',
      at,
      stale: false,
    }
  }

  const w5 = pick(unified.five_hour, '5h')
  const w7 = pick(unified.seven_day, '7d')
  if (!w5 && !w7) return null
  return { '5h': w5, '7d': w7, at, source: 'cli' }
}

/** 解析一行 stdin 数据；空行、非 JSON、缺 type、未知 type 一律返回 null */
export function parseStdinLine(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed.type !== 'string') return null
    if (!STDIN_FRAME_TYPES.includes(parsed.type)) return null
    return parsed
  } catch {
    return null
  }
}

// ── 内核侧：写 stdin 帧的工厂 ──────────────────────────────

/**
 * 启动一个 job。request 是完整 Anthropic Messages body。
 *
 * 字段顺序：job_id → slot_id → request → request_context。
 * JSON 对象键序不影响语义，但保持这个顺序便于与控制面日志逐行比对。
 * request_context 只在显式给出时带上，缺省不写该键。
 */
export function jobStartFrame({ slot, jobId, request, requestContext }) {
  return {
    type: 'job_start',
    job_id: jobId,
    slot_id: slot,
    request,
    ...(requestContext !== undefined ? { request_context: requestContext } : {}),
  }
}

/**
 * cancel 帧：第一字段是 job_id（不是 request）。
 *
 * slot_id 是可选字段，job_id 是必需字段。取消时先给出 job_id，
 * 由 CLI 侧按 job_id 定位 slot；slot_id 仅作为额外提示。
 * 注意 slot_id 为空字符串时不会写入该键（走 if 判断而不是判空）。
 */
export function cancelFrame({ slot, jobId }) {
  const frame = { type: 'cancel', job_id: jobId }
  if (slot) frame.slot_id = slot
  return frame
}

export function pingFrame(nonce) {
  return { type: 'ping', nonce }
}

// ── 内核侧：解析 CLI 上报的 stdout 帧 ──────────────────────

/**
 * 处理 CLI 的 stdout 帧。返回 { kind, payload } 便于上层 switch。
 * kind 取值：host_ready / slot_ready / stream_event / job_done / job_error / cancel_ack / pong / unknown
 *
 * 这里是 wire 字段名（snake_case）到内部字段名（camelCase）的唯一转换点，
 * 上层只依赖 payload 的内部命名。
 */
export function classifyStdoutFrame(frame) {
  if (!frame || typeof frame !== 'object') return { kind: 'unknown', payload: frame }
  switch (frame.type) {
    case 'host_ready':
      return {
        kind: 'host_ready',
        payload: {
          protocolVersion: frame.protocol_version,
          slots: frame.slots,
          systemLayout: frame.system_layout,
          timezone: frame.timezone,
          capabilities: frame.capabilities || [],
          configHash: frame.config_hash ?? null,
        },
      }
    case 'slot_ready':
      return { kind: 'slot_ready', payload: { slotId: frame.slot_id } }
    case 'stream_event':
      return { kind: 'stream_event', payload: { jobId: frame.job_id, slotId: frame.slot_id, event: frame.event } }
    case 'job_done':
      return {
        kind: 'job_done',
        payload: {
          jobId: frame.job_id,
          slotId: frame.slot_id,
          stopReason: frame.stop_reason || '',
          usage: frame.usage || {},
          headers: frame.headers || {},
        },
      }
    case 'job_error':
      return {
        kind: 'job_error',
        payload: {
          jobId: frame.job_id,
          slotId: frame.slot_id,
          error: frame.error,
          code: frame.code,
          status: frame.status,
          errorType: frame.error_type,
          retryAfter: frame.retry_after,
          requestId: frame.request_id,
          upstreamCode: frame.upstream_code,
        },
      }
    case 'cancel_ack':
      return { kind: 'cancel_ack', payload: { jobId: frame.job_id, slotId: frame.slot_id } }
    case 'pong':
      return { kind: 'pong', payload: { nonce: frame.nonce } }

    // ── 原生 stream-json 方言 ──
    // 真 CLI 不发 host_ready，就绪信号是第一条 system/init；帧里不带 job_id，
    // 归属靠 session_id + result_index 推断（见 scheduler 的 pendingTurn 队列）。

    case 'system':
      return classifySystemFrame(frame)
    case 'assistant':
      return {
        kind: 'assistant',
        payload: {
          message: frame.message || {},
          sessionId: frame.session_id ?? null,
          parentToolUseId: frame.parent_tool_use_id ?? NO_PARENT_TOOL,
          uuid: frame.uuid ?? null,
          requestId: frame.request_id ?? null,
        },
      }
    case 'rate_limit_event':
      return {
        kind: 'rate_limit_event',
        payload: {
          rateLimitInfo: frame.rate_limit_info || {},
          sessionId: frame.session_id ?? null,
          // 转成本仓库配额模型要的形状；无窗口数据时为 null
          windows: quotaWindowsFromRateLimit(frame.rate_limit_info, { at: Date.now() }),
        },
      }
    case 'result':
      return {
        kind: 'result',
        payload: {
          subtype: frame.subtype || '',
          isError: frame.is_error === true || String(frame.subtype || '') !== 'success',
          result: frame.result ?? '',
          stopReason: frame.stop_reason || '',
          sessionId: frame.session_id ?? null,
          uuid: frame.uuid ?? null,
          usage: frame.usage || {},
          modelUsage: frame.modelUsage || {},
          totalCostUsd: frame.total_cost_usd ?? null,
          durationMs: frame.duration_ms ?? null,
          durationApiMs: frame.duration_api_ms ?? null,
          numTurns: frame.num_turns ?? null,
          apiErrorStatus: frame.api_error_status ?? null,
          resultIndex: frame.result_index ?? null,
        },
      }
    case 'control_response':
      return {
        kind: 'control_response',
        payload: {
          requestId: frame.response?.request_id ?? frame.request_id ?? null,
          subtype: frame.response?.subtype || '',
          response: frame.response?.response ?? null,
        },
      }

    default:
      return { kind: 'unknown', payload: frame }
  }
}

/**
 * system 帧细分。init 是宿主就绪信号（实测每轮 user 帧之后都会重发一次），
 * status / thinking_tokens 是过程帧，归到 system_event 供上层记录。
 */
function classifySystemFrame(frame) {
  const subtype = String(frame.subtype || '')
  if (subtype === 'init') {
    return {
      kind: 'host_ready',
      payload: {
        protocolVersion: PROTOCOL_VERSION,
        // 真 CLI 不报槽数：它自己串行处理，槽位由本进程虚拟出来
        slots: null,
        systemLayout: frame.output_style ?? null,
        timezone: process.env.CLAUDE_CODE_TIMEZONE || null,
        capabilities: CLI_CAPABILITIES,
        configHash: null,
        sessionId: frame.session_id ?? null,
        model: frame.model ?? null,
        cliVersion: frame.claude_code_version ?? null,
        tools: Array.isArray(frame.tools) ? frame.tools : [],
        dialect: 'native',
      },
    }
  }
  return {
    kind: 'system_event',
    payload: {
      subtype,
      status: frame.status ?? null,
      sessionId: frame.session_id ?? null,
      uuid: frame.uuid ?? null,
    },
  }
}

/**
 * host_ready 五项校验，外加必需能力检查。
 *
 * 前五项是强校验：system_layout、protocol_version、slots、timezone，
 * 以及可选的 config_hash（expected 给出时才校验）。
 * config_hash 一致说明 CLI 与内核的配置快照相同，不一致往往意味着
 * CLI 用了旧的布局或旧的环境变量。
 *
 * 任一不符即返回 ok:false 并给出 reason，调用方据此拒绝注册 slot，
 * 日志文案为 native host ready validation failed, refusing to register slot。
 *
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateHostReady(hostReady, expected) {
  if (String(hostReady.systemLayout) !== String(expected.systemLayout)) {
    return { ok: false, reason: `system_layout ${hostReady.systemLayout} != expected ${expected.systemLayout}` }
  }
  if (String(hostReady.protocolVersion) !== String(expected.protocolVersion)) {
    return { ok: false, reason: `protocol_version ${hostReady.protocolVersion} != ${expected.protocolVersion}` }
  }
  if (Number(hostReady.slots) !== Number(expected.slots)) {
    return { ok: false, reason: `slots ${hostReady.slots} != configured slot_count ${expected.slots}` }
  }
  if (String(hostReady.timezone) !== String(expected.timezone)) {
    return { ok: false, reason: `timezone ${hostReady.timezone} != expected ${expected.timezone}` }
  }
  if (expected.configHash != null && String(hostReady.configHash) !== String(expected.configHash)) {
    return { ok: false, reason: `config_hash mismatch: cli=${hostReady.configHash} expected=${expected.configHash}` }
  }
  for (const cap of expected.requiredCapabilities || []) {
    if (!(hostReady.capabilities || []).includes(cap)) {
      return { ok: false, reason: `missing required capability ${cap}` }
    }
  }
  return { ok: true }
}

/**
 * 子进程启动失败的错误码到可读原因的映射。
 *
 * 只覆盖启动阶段可能出现的 errno。映射缺失时退回 error.message，
 * 保证任何未知错误码也能给出可读文案，而不是只留下一个裸数字。
 */
export const SPAWN_ERROR_REASONS = Object.freeze({
  ENOENT: 'file not found: bin path does not exist',
  EACCES: 'not runnable: file exists but has no execute permission',
  EPERM: 'not runnable: operation not permitted for this user',
  ENOEXEC: 'not runnable: file format is not an executable',
  ENOTDIR: 'bin path component is not a directory',
  ELOOP: 'bin path resolves through too many symbolic links',
  ENAMETOOLONG: 'bin path is too long',
})

/**
 * 把 spawn 的原始错误整理成带上下文的 Error。
 *
 * 错误消息固定包含三要素：bin 路径、错误码、可读原因，便于从日志直接定位
 * 是路径写错还是权限没给。错误对象上同时挂 code / bin / reason，
 * 调用方可以按 code 判断降级策略，不必解析文案。
 */
export function spawnError(error, bin) {
  const code = error?.code || 'UNKNOWN'
  const reason = SPAWN_ERROR_REASONS[code] || error?.message || 'unknown spawn failure'
  const wrapped = new Error(`cli spawn failed: bin=${bin} code=${code} reason=${reason}`)
  wrapped.code = code
  wrapped.bin = bin
  wrapped.reason = reason
  if (error) wrapped.cause = error
  return wrapped
}

/**
 * 拉起一个 CLI 子进程并按帧协议驱动它。
 *
 * start() 返回的 Promise 只由 host_ready 帧 resolve；子进程启动失败或提前退出时
 * reject。未捕获拒绝由构造函数预先挂上的 catch 吞掉，避免崩溃——真正的处理方
 * 是 start() 的 await 调用点（见 scheduler 的降级分支）。
 *
 * 关键约束：spawn 的 'error' 事件必须绑定。bin 不存在或没有执行权限时 Node 会
 * 发这个事件，无人监听就是一个未捕获异常，会直接结束整个宿主进程。
 * 这里统一转成 this.ready 的 reject，并把错误留在 this.lastError 上供健康检查读取。
 *
 * stdout 一行一帧（NDJSON），非法行直接跳过。stderr 原样转发到本进程 stderr。
 */
export class CliHost {
  constructor({ bin, env = process.env, slots = 20, onFrame, disableCli = false }) {
    this.bin = bin
    this.env = {
      ...env,
      // 这三个环境变量是 CLI 进入帧驱动模式的前提：
      // 关掉非流式回退、声明入口为 sdk-cli、声明用户类型为 external。
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      CLAUDE_CODE_ENTRYPOINT: env.CLAUDE_CODE_ENTRYPOINT || 'sdk-cli',
      USER_TYPE: env.USER_TYPE || 'external',
    }
    this.slots = slots
    this.onFrame = onFrame
    this.disableCli = disableCli === true
    this.child = null
    // 最近一次启动/运行期错误：{code, bin, reason, message}，供健康检查读取。
    // 成功拿到 host_ready 后清空，表示当前实例可用。
    this.lastError = null
    this.started = false
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve
      // 保留首个错误：spawn 失败时可能连发 error 与 exit，先到的那个
      // （从 errno 直接转来的 ENOENT / EACCES）诊断价值最高。
      this._rejectReady = (error) => {
        if (!this.lastError) this.lastError = error
        reject(error)
      }
    })
    // 避免 CLI 提前退出时出现未捕获拒绝：由 start() 的 await 方处理
    this.ready.catch(() => {})
  }

  start() {
    // 纯 Codex 部署：不 spawn CLI。
    //
    // 返回一个"已就绪但没有进程"的形态：ready 立刻 resolve、
    // started 保持 false、pid 为 null。scheduler 据此不会设置 cliError，
    // health 也就不会因为 "claude 不存在" 报 ok:false。
    //
    // 为什么需要这个：内核原先无条件拉起 CLI，没装 claude 的机器上
    // health 永远 ok:false，而 vm2api 的 codex supervisor 把 ok:false
    // 判成内核未就绪 → 所有 GPT 请求 503，尽管 Codex 通道完全可用。
    if (this.disableCli === true) {
      this.started = false
      this.pid = null
      this.ready = Promise.resolve({ slots: this.slots, disabled: true })
      return this.ready
    }
    const { spawn } = require("node:child_process")
    // CLI 以流式 JSON 模式起，然后等 stdin 帧。
    //
    // 四个参数缺一不可，任何一个缺失都会让这条通道整条不可用：
    //   -p                     非交互模式
    //   --input-format         必须显式声明 stream-json。缺省是 text，
    //                          CLI 会一直等 stdin 读到 EOF 才开始处理，
    //                          收到的 JSONL 帧一律被当成普通文本，且在没有
    //                          prompt 参数时直接以 code=1 退出。
    //   --output-format        必须 stream-json，否则拿回的是人读文本而非帧。
    //   --verbose              stream-json 输出格式的前置要求，缺了直接报错。
    //
    // spawn 本身对不存在的 bin 不抛错，而是稍后异步发 'error' 事件，
    // 因此错误处理必须在同一轮同步代码里绑定，晚一拍就会变成未捕获异常。
    const child = spawn(this.bin, [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child

    child.on('error', (error) => {
      // 启动失败：记录并 reject，绝不 throw 到顶层，也不退出进程。
      // 上层（scheduler）据此降级成无 CLI 模式继续提供健康检查。
      const wrapped = spawnError(error, this.bin)
      this.started = false
      console.error(`[cli] spawn failed: ${wrapped.message}`)
      this._rejectReady(wrapped)
    })

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let frame
      try {
        frame = JSON.parse(trimmed)
      } catch {
        return
      }
      const classified = classifyStdoutFrame(frame)
      if (classified.kind === 'host_ready') {
        this.started = true
        this.lastError = null
        this._resolveReady(classified.payload)
      }
      this.onFrame?.(classified)
    })
    child.stderr.on('data', (c) => process.stderr.write(`[cli] ${c}`))
    child.on('exit', (code, signal) => {
      this.started = false
      const error = new Error(`cli exited code=${code} signal=${signal ?? 'none'}`)
      error.code = 'ECLIEXIT'
      error.bin = this.bin
      error.reason = `process exited (code=${code}, signal=${signal ?? 'none'})`
      this._rejectReady(error)
    })
    return this.ready
  }

  /** 写一帧；stdin 不可写时返回 false，由调用方决定降级策略 */
  write(frame) {
    if (!this.child?.stdin?.writable) return false
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`)
      return true
    } catch {
      // stdin 在写完前被对端关掉（EPIPE）时不让异常冒到请求处理路径
      return false
    }
  }

  startJob({ slot, jobId, request, requestContext }) {
    return this.write(jobStartFrame({ slot, jobId, request, requestContext }))
  }

  cancel({ slot, jobId }) {
    return this.write(cancelFrame({ slot, jobId }))
  }

  ping(nonce = Date.now().toString(36)) {
    return this.write(pingFrame(nonce))
  }

  /**
   * 先关 stdin 再发 SIGTERM，让 CLI 有机会走完当前帧。
   *
   * 从未成功启动（spawn 就失败、或 stop 被重复调用）时必须可以安全执行：
   * child 为 null 或已退出都直接返回，不抛错、不产生告警。
   */
  stop() {
    const child = this.child
    this.started = false
    if (!child) return false
    // spawn 失败时 child.pid 为 undefined：进程从未存在，只需清引用
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      this.child = null
      return false
    }
    try {
      child.stdin?.end()
    } catch {}
    try {
      child.kill('SIGTERM')
    } catch {}
    return true
  }
}

// ─────────────── metadata.user_id 构造 ───────────────

/**
 * device_id 必须是 64 位 hex；不是就先 sha256 再发。
 * 空值用 fallback 参与哈希，保证同一进程内结果稳定。
 */
export function outboundDeviceId(raw, fallback = 'kin-vm') {
  const s = String(raw || '').trim()
  if (/^[0-9a-f]{64}$/i.test(s)) return s
  return sha256Hex(s || fallback)
}

function sha256Hex(s) {
  return require('node:crypto').createHash('sha256').update(String(s)).digest('hex')
}

/**
 * Anthropic Messages 的 metadata.user_id 是「JSON 字符串再套一层 string」。
 *
 * 两条硬约束（上游会直接拒绝，不会做任何清理）：
 *   1. device_id 必须 64-hex
 *   2. 绝不能出现 @ —— 上游返回 400，错误码 has_at
 *
 * 这里做前置校验并抛错，而不是把非法值透传出去：一旦发出去，
 * 失败会发生在上游而不是本地，排查成本高得多。
 */
export function formatMetadataUserId({ deviceId, accountUuid, sessionId }) {
  const sid = String(sessionId || '')
  if (sid.includes('@')) {
    throw new Error('metadata.user_id must not contain "@": upstream rejects with has_at')
  }
  return JSON.stringify({
    device_id: deviceId || '',
    account_uuid: accountUuid || '',
    session_id: sid,
  })
}

/**
 * 内核往 CLI 发 job_start 时，把 metadata.user_id 序列化成字符串塞进嵌套对象。
 *
 * 三种输入形态：
 *   - 已是字符串：原样透传，不重新序列化（避免改变调用方给的字节）；
 *   - 是对象：逐字段规范化（补齐 device_id 的 hex 形态、缺省字段补空串）；
 *   - 缺失：按当前 session 现造一个。
 */
export function buildCliMetadata({ request, headers }) {
  const sessionId = headers?.['x-session-id'] || request?.session_id || ''
  const existing = request?.metadata?.user_id
  if (typeof existing === 'string') {
    // 调用方已给字符串，原样透传
    return { user_id: existing }
  }
  if (existing && typeof existing === 'object') {
    return { user_id: formatMetadataUserId({
      deviceId: outboundDeviceId(existing.device_id),
      accountUuid: existing.account_uuid || '',
      sessionId: existing.session_id || sessionId,
    }) }
  }
  return { user_id: formatMetadataUserId({
    deviceId: outboundDeviceId(''),
    accountUuid: '',
    sessionId,
  }) }
}

// ─────────────── wireBody 合并 ───────────────

/** 19 个官方拥有字段，调用方不得覆盖 */
export const NATIVE_OWNED_FIELDS = Object.freeze([
  'model', 'messages', 'system', 'tools', 'tool_choice', 'thinking', 'metadata',
  'max_tokens', 'stream', 'temperature', 'top_p', 'top_k', 'stop_sequences',
  'betas', 'wireMessages', 'request_context', 'output_config',
  'context_management', 'safeguards',
])

/**
 * 10 个调用方可选字段：wire 里没有就必须删掉，不能留默认值。
 * 保留默认值会改变上游的计费与行为（例如把未指定的 max_tokens 补成默认值）。
 */
export const CALLER_OPTIONAL_FIELDS = Object.freeze([
  'tools', 'tool_choice', 'thinking', 'temperature', 'top_p', 'top_k',
  'stop_sequences', 'context_management', 'output_config', 'safeguards',
])

/**
 * 合并官方构造的 body 与调用方原始 body（wireBody）。
 *
 * 规则：
 *   1. 以官方 body 为基底；
 *   2. 官方拥有字段不允许被覆盖——调用方给了也忽略；
 *   3. 其余字段由调用方覆盖；
 *   4. 可选字段按"调用方有没有给"决定保留或删除；tools 额外要求必须是数组，
 *      否则保留官方值（防止非数组脏值破坏上游解析）。
 *
 * @param {object} official 官方构造的 body
 * @param {object} wire     调用方原始 body（wireBody）
 * @returns {object}
 */
export function mergeWireBody(official, wire) {
  const body = { ...official }
  if (!wire || typeof wire !== 'object') return body
  const owned = new Set(NATIVE_OWNED_FIELDS)
  for (const key of Object.keys(wire)) {
    if (!owned.has(key)) body[key] = wire[key]
  }
  for (const key of CALLER_OPTIONAL_FIELDS) {
    if (!Object.hasOwn(wire, key)) {
      delete body[key]
    } else if (key !== 'tools' || Array.isArray(wire.tools)) {
      body[key] = wire[key]
    }
  }
  return body
}
