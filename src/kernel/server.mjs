/**
 * 内核 HTTP 服务：把 vm2api 控制面要的 5 个端点实现出来。
 *
 * 职责：把「vm2api 的 Node 业务层」与「我们的 Node 内核」之间那 5 条 HTTP
 * 缝填上，让前者能完全替代后者（闭源 Rust 二进制）。
 *
 * 设计约束（都是从 vm2api 客户端代码反推出来的，改之前先读 contract.mjs）：
 *
 * 1. **两种监听模式**：unix socket（vm2api 的实际用法）与 TCP（本机调试、
 *    以及将来把内核放到另一台机器上跑）。listen 目标由 supervisor-compat 的
 *    listenTarget 决定，本文件不做二次判断。
 *
 * 2. **health 必须快**。supervisor 每 80ms 轮询一次、单次预算 400ms 就 destroy。
 *    因此 health 只读内存里的调度器状态，绝不碰磁盘、绝不等 CLI、绝不做网络。
 *    唯一可能慢的操作是 credentialState 的 fs.readFile（本地小文件，亚毫秒级），
 *    且加了 try/catch —— 它失败也只是让 credential_state 变成 missing。
 *
 * 3. **cancel 必须是真取消**。vm2api 的 cancelOnAbort 在客户端断开时拿
 *    envelope 里的 request_id 调这里。所以内核必须用**客户端给的 request_id**
 *    作 job 键，不能用自己生成的 UUID。做不到这一点，cancel 永远是空实现，
 *    客户端断开后 CLI 会继续烧额度直到自然结束 —— 这是原实现
 *    （server.mjs 里 `{cancelled:false, ok:true}`）最实际的缺陷。
 *
 * 4. **复用而非重写**。messages 走 server.mjs 的 prepareOutbound + frames.mjs
 *    的 CliHost 帧协议；Codex 走 codex-server.mjs 的 createCodexHandler。
 *    本文件只做「HTTP 契约翻译 + job 生命周期管理」，不复制业务逻辑。
 *
 * 5. **降级优先**。CLI 不可用时健康检查仍回 200（这是控制面能读到诊断信息的前提，
 *    见 scheduler.mjs 的约束 4），业务端点回 503 + 结构化错误。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  KERNEL_ENDPOINTS,
  KERNEL_AUTH_HEADERS,
  KERNEL_RESPONSE_HEADERS,
  KERNEL_TRAILER_HEADERS,
  isAuthed,
  requestIdFromBody,
} from './contract.mjs'
import {
  readinessPayload,
  listenTargets,
  supervisorView,
  kernelConfigFromFile,
  kernelConfigFromVN2,
  startupWarnings,
  SUPERVISOR_SLOTS,
} from './supervisor-compat.mjs'
import { KERNEL_ENGINE_LABEL } from './defaults.mjs'
import { workerError } from '../config.mjs'
import { SlotScheduler } from '../scheduler.mjs'
import { prepareOutbound } from '../server.mjs'
import { messageBody, messageHeaders, sseHeaders, streamMetaFromHeaders, mergeUsage } from '../sse.mjs'

/** 默认 body 上限：与 vm2api kernel.json 的 max_request_bytes 同档（64MiB）。 */
const DEFAULT_MAX_BODY = 64 * 1024 * 1024

/**
 * 构造内核 HTTP 服务。
 *
 * @param {object} opts
 * @param {object} opts.config  内核配置（supervisor-compat.kernelConfigFromFile 的产物）
 * @param {object} [opts.deps]  依赖注入点，全部可选。测试用它替换真 CLI / 真上游。
 * @param {object} [opts.deps.scheduler]   自定义调度器（默认 new SlotScheduler）
 * @param {Function} [opts.deps.prepare]   出站组装（默认 server.mjs 的 prepareOutbound）
 * @param {Function} [opts.deps.codexHandlerFactory] Codex handler 工厂（默认 createCodexHandler，惰性加载）
 * @param {object} [opts.deps.logger]      日志器（默认 console）
 * @returns {{server: import('node:http').Server, state: object, close: Function, start: Function}}
 */
export function createKernelServer({ config = {}, deps = {} } = {}) {
  const logger = deps.logger || console
  const maxBody = Number(config.kernel_max_request_bytes) || DEFAULT_MAX_BODY
  const prepare = deps.prepare || prepareOutbound
  const startedAt = Date.now()

  // ── 调度器：单宿主 + N 个逻辑槽。slots 必须与 kernel.json 的
  //    slots_per_worker 一致（supervisor 会强制改成 20），否则 ready_slots
  //    会与 kernelJobsRunning 的推算对不上，mount 出假的"在途"。
  const slots = Number(config.slots_per_worker) || SUPERVISOR_SLOTS

  // 纯 Codex 部署不该拉起 Claude CLI。
  //
  // 内核原先无条件构造 SlotScheduler，而它在 start() 时会 spawn claude。
  // 没装 claude 的机器上这就注定失败，health 于是报
  //   ok:false, cli_error:{code:'ENOENT', bin:'claude'}
  // 而 vm2api 的 codex supervisor 把 ok:false 判成"内核未就绪"，
  // 所有 GPT 请求 503 health_timeout —— 尽管 Codex 通道本身完全可用。
  //
  // 判据用 codex_credential_path：有它说明这是 GPT 槽，
  // Claude 侧不参与，CLI 也就没有拉起的必要。
  const codexOnly = Boolean(config.codex_credential_path) && !config.credential_path
  const scheduler =
    deps.scheduler ||
    new SlotScheduler({
      claudeBin: config.claude_bin || 'claude',
      slots: Math.min(slots, 20),
      // codexOnly 时禁掉 CLI 宿主：scheduler 不会 spawn claude，
      // cliError 保持 null，health 按通道就绪程度报 ok
      disableCli: codexOnly,
      env: {
        ...process.env,
        ...(config.timezone ? { CLAUDE_CODE_TIMEZONE: config.timezone } : {}),
        // 透传给 CLI 宿主的环境（测试用：把假 CLI 的 job 拖长以便验证取消）
        ...(config.cli_env && typeof config.cli_env === 'object' ? config.cli_env : {}),
      },
    })

  /**
   * 在途 job 表：request_id → { jobId, slot, sessionId, startedAt, cancelled }
   *
   * 键**必须**是客户端给的 request_id（envelope 里那个 UUID）。
   * 这张表是 cancel 端点唯一的数据来源。
   */
  const inflight = new Map()

  /** 已创建的监听实例，按 listenTargets 的顺序 */
  const servers = []

  const state = {
    startedAt,
    readySlots: 0,
    closedSlots: 0,
    cliPid: null,
    cliRestarts: 0,
    cliStarted: false,
    cliError: null,
    recovering: false,
    unhealthyReason: null,
    credentialState: 'missing',
    slotsPerWorker: slots,
    // Codex 通道的就绪状态。它没有 CLI 槽位（readySlots 恒为 0），
    // 但凭据可用时通道本身是能跑的 —— health 的 ok 判定要看这两个字段，
    // 否则 Codex-only 内核永远报 ok:false。
    codexReady: false,
    codexReadySlots: 0,
    requestCount: 0,
    cancelCount: 0,
    lastError: null,
  }

  // ── Codex handler：惰性构造。它要求凭据文件存在且合法，凭据缺失时
  //    构造会抛错；那条错误不能让整个内核起不来（Claude 通道仍然可用）。
  let codexHandler = null
  let codexError = null
  async function ensureCodex() {
    if (codexHandler || codexError) return codexHandler
    try {
      if (typeof deps.codexHandlerFactory === 'function') {
        codexHandler = await deps.codexHandlerFactory({ config })
      } else if (config.codex_credential_path) {
        // 惰性 import：codex-server.mjs 会拉起凭据加载与调度器，
        // 没有 Codex 通道的部署不该为此付出启动成本。
        const { createCodexHandler } = await import('../codex-server.mjs')
        codexHandler = createCodexHandler({
          credentialPath: config.codex_credential_path,
          defaultModel: config.codex_default_model,
          baseUrl: config.codex_base_url,
        })
      } else {
        codexError = new Error('codex_credential_path is not configured')
      }
      // 通道就绪：把容量写进 state，供 health 的 ok 判定使用。
      // 槽位数取调度器能接的账号数（没有账号就没有容量）。
      try {
        const snap = codexHandler?.scheduler?.snapshot?.() || {}
        const capacity = Number(snap.capacity ?? snap.accounts ?? 0) || 0
        state.codexReady = capacity > 0
        state.codexReadySlots = state.codexReady ? capacity : 0
      } catch {
        state.codexReady = false
        state.codexReadySlots = 0
      }
    } catch (error) {
      codexError = error
      state.codexReady = false
      state.codexReadySlots = 0
      logger.error?.(`[kernel] codex channel unavailable: ${error?.message || error}`)
    }
    return codexHandler
  }

  // ── 调度器状态同步：只读内存，不做 IO
  function syncState() {
    try {
      const readySlots = Number(scheduler.readySlots) || 0
      const cliError = scheduler.cliError || null
      // CLI 不可用时必须报 ready_slots = 0，哪怕逻辑槽全是 idle。
      // 报 20 会让 supervisor 的 rustKernelReachable 判 true，于是它认定
      // 「内核已就绪」，永不重启，而我们每个请求只能走降级分支——
      // 控制面看到的是一条健康的链路，实际什么都没在做。
      // 报 0 且 cli_pid=null 时 supervisor 走 wedged 分支（busy=false →
      // reachable=false → 重启），这正是想要的结果。
      state.readySlots = cliError && scheduler.host?.started !== true ? 0 : readySlots
      state.closedSlots = Number(scheduler.closedSlots) || 0
      state.cliPid = typeof scheduler.cliPid === 'number' ? scheduler.cliPid : null
      state.cliRestarts = Number(scheduler.restarts) || 0
      state.cliStarted = scheduler.host?.started === true
      state.cliError = cliError
      state.recovering = scheduler.recovering === true
      state.unhealthyReason =
        scheduler.unhealthyReason ||
        (cliError && state.cliStarted === false
          ? `cli unavailable: ${cliError.code || cliError.message || 'unknown'}`
          : null)
    } catch (error) {
      // 状态读取失败不该让 health 500：把失败本身变成 unhealthy_reason
      state.unhealthyReason = `state read failed: ${error?.message || error}`
    }
    return state
  }

  /**
   * 凭据状态。只读本地小文件，带缓存 1s —— supervisor 每 80ms 轮询，
   * 不缓存的话一个 20 槽实例每秒读 250 次凭据文件。
   */
  let credCache = { at: 0, value: 'missing' }
  function credentialState() {
    const now = Date.now()
    if (now - credCache.at < 1000) return credCache.value
    let value = 'missing'
    try {
      const raw = JSON.parse(fs.readFileSync(config.credential_path, 'utf8'))
      const oauth = raw?.claudeAiOauth
      if (oauth?.accessToken) {
        const exp = Number(oauth.expiresAt || 0)
        if (!exp) value = 'fresh'
        else if (now >= exp) value = oauth.refreshToken ? 'expired_refreshable' : 'expired'
        else if (exp - now < 60_000) value = 'refresh_window'
        else if (exp - now < 300_000) value = 'refreshable'
        else value = 'fresh'
      }
    } catch {
      value = 'missing'
    }
    credCache = { at: now, value }
    return value
  }

  function sendJson(res, status, obj, headers = {}) {
    const body = Buffer.from(JSON.stringify(obj))
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': body.length,
      ...headers,
    })
    res.end(body)
  }

  /** 错误响应统一走 config.mjs 的 workerError，与 vm2api 的判错字段完全同构。 */
  function sendError(res, status, code, message, type = 'worker_error', headers = {}) {
    sendJson(res, status, workerError(status, code, message, type), headers)
  }

  function readBody(req, limit = maxBody) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(Object.assign(new Error(`request exceeds ${limit} bytes`), { code: 'request_too_large' }))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  // ─────────────────────────────────────────── 端点实现

  /**
   * GET /internal/health
   *
   * 目标 < 100ms。整条路径只有内存读取 + 一个带 1s 缓存的凭据文件读。
   */
  function handleHealth(req, res) {
    syncState()
    state.credentialState = credentialState()

    // Codex 通道就绪判定必须在这里也做一次，不能只靠 ensureCodex 的副作用。
    //
    // ensureCodex 是惰性的：没人发过 Codex 请求，它就永远不会被调用，
    // state.codexReady 永远是 false —— 于是纯 Codex 内核的 health 一直报
    // ok:false，控制面据此认定"内核没起来"。而实际第一个请求打进来就能跑通。
    //
    // 这里只做廉价的同步判断：配置里有凭据路径、文件存在且能解析出账号。
    // 真正的构造仍然留给第一次请求，避免 health 路径做 IO 重活。
    if (!state.codexReady && config.codex_credential_path) {
      try {
        const raw = fs.readFileSync(config.codex_credential_path, 'utf8')
        const parsed = JSON.parse(raw)
        const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
        const usable = accounts.filter((a) => a && a.id && (a.access_token || a.refresh_token))
        state.codexReady = usable.length > 0
        state.codexReadySlots = usable.length
      } catch {
        // 凭据坏了不影响 health 返回：codexError 会在真正请求时给出具体原因
        state.codexReady = false
        state.codexReadySlots = 0
      }
    }

    const payload = readinessPayload(config, state)
    return sendJson(res, 200, payload, { 'x-request-id': req.headers['x-request-id'] || randomUUID() })
  }

  /**
   * POST /internal/v1/messages
   *
   * envelope 见 contract.mjs 的 CLAUDE_ENVELOPE_FIELDS。两种响应：
   *   stream=true  → SSE（Anthropic Messages 事件）
   *   stream=false → JSON Message
   *
   * 关键：job 键用客户端的 request_id。客户端断开时能精确 cancel 到这一个 job。
   */
  async function handleMessages(req, res) {
    let envelope
    try {
      envelope = JSON.parse((await readBody(req, maxBody)) || '{}')
    } catch (error) {
      const status = error?.code === 'request_too_large' ? 413 : 400
      return sendError(res, status, error?.code || 'invalid_json', String(error?.message || error))
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return sendError(res, 400, 'invalid_envelope', 'envelope must be a JSON object')
    }
    if (!envelope.body || typeof envelope.body !== 'object') {
      // 与 config.mjs 的 Envelope 类同一条文案，控制面按原文匹配
      return sendError(res, 400, 'invalid_request', 'missing field `body` at line 1 column 2')
    }

    const requestId = requestIdFromBody(envelope) || String(req.headers['x-request-id'] || '') || randomUUID()
    const body = envelope.body
    const model = String(body.model || '')
    if (!model) {
      return sendError(
        res,
        422,
        'missing_model',
        'Failed to deserialize the JSON body into the target type: missing field `model` at line 1 column 2',
        'invalid_request_error',
      )
    }

    // 凭据门禁：缺失或过期直接 401 needs_refresh，让控制面走刷新而不是重试。
    const cred = credentialState()
    if (cred === 'missing' || cred.startsWith('expired')) {
      return sendError(res, 401, 'needs_refresh', 'credential needs refresh', 'authentication_error', {
        'x-terminal-state': 'rejected',
      })
    }

    const sessionId = extractSessionId(body) || randomUUID()
    const requestContext = envelope.request_context || null
    const startedAtMs = Date.now()

    // 采集器必须在 submit **之前**建好并传进 onEvent：CLI 的帧可能在我们
    // 拿到 submitted 句柄之前就回来（submit 内部同步写 stdin），
    // 事后才挂回调会丢掉首批事件——流式表现为客户端收不到 message_start，
    // 非流式表现为 content 为空。
    const collector = createCollector({ stream: envelope.stream === true })
    let submitted = null
    if (!state.cliError) {
      try {
        submitted = scheduler.submit({
          sessionId,
          model,
          request: body,
          requestContext,
          onEvent: (event) => collector.push(event),
        })
      } catch (error) {
        state.lastError = error
        return sendError(res, 500, 'submit_failed', String(error?.message || error))
      }
    }
    if (submitted?.blocked) {
      // 配额熔断：给客户端一个可退避的时间点，而不是笼统的 503
      return sendError(res, 429, submitted.quota?.reason || 'quota_blocked', 'account quota window exhausted', 'rate_limit_error', {
        ...(submitted.quota?.resumeAt ? { 'retry-after': String(Math.max(1, Math.ceil((submitted.quota.resumeAt - Date.now()) / 1000))) } : {}),
      })
    }
    if (!submitted && !state.cliError) {
      return sendError(res, 503, 'slot_busy', 'no free slot', 'overloaded_error', {
        'x-terminal-state': 'rejected',
      })
    }

    const slotName = submitted?.slot || 's00'
    const jobId = submitted?.jobId || null
    state.requestCount += 1

    // 登记在途：cancel 端点按 request_id 反查
    const entry = { jobId, slot: slotName, sessionId, startedAt: startedAtMs, cancelled: false }
    inflight.set(requestId, entry)

    // 客户端断开 → 立刻 cancel，不必等 kernel 自己发现
    let closed = false
    res.on('close', () => {
      if (closed) return
      closed = true
      if (inflight.get(requestId) === entry) {
        cancelEntry(requestId, 'client_closed')
      }
    })

    try {
      // 降级模式（CLI 不可用）：与 server.mjs 的 B 模式一致，回可用的结构体
      // 而不是 503，让上游链路在 CLI 挂掉时仍有确定行为。
      if (state.cliError) {
        return await respondDegraded(res, { model, sessionId, slotName, requestId, stream: envelope.stream === true })
      }

      const outbound = prepare(body, {
        systemLayout: config.system_layout,
        panelTtl: config.default_cache_ttl,
        promptProfile: config.claude_prompt_profile,
        environment: config.timezone ? { timezone: config.timezone } : null,
      })

      if (envelope.stream === true) {
        return await streamJob({ req, res, entry, requestId, outbound, sessionId, slotName, submitted, collector })
      }
      return await bufferedJob({ res, entry, requestId, outbound, sessionId, slotName, submitted, collector })
    } finally {
      if (inflight.get(requestId) === entry) inflight.delete(requestId)
    }
  }

  /**
   * 流式：把采集到的事件**原样**转成 SSE 行。
   *
   * 不做任何改写 —— vm2api 的客户端自己 assemble 这些事件，它要上游原样，
   * 不是我们的解读。我们只负责在结束时补 trailer（usage/model/stop_reason）。
   */
  function streamJob({ req, res, entry, requestId, outbound, sessionId, slotName, submitted, collector }) {
    return new Promise((resolve) => {
      const headers = sseHeaders(
        { sessionId, slot: slotName, generation: 1 },
        req.headers['x-request-id'] || requestId,
      )
      headers.trailer = KERNEL_TRAILER_HEADERS.join(', ')
      headers['x-terminal-state'] = 'streaming'
      res.writeHead(200, headers)

      let finished = false
      // collector 在 submit 之前就建好了，因此它缓存的早期事件在这里统一补发，
      // 不会因为「回调挂晚了」而丢首包。
      //
      // 但也因此不能无条件原样转发：宿主要是只发 content_block_delta
      // （假 CLI 这类简化宿主就是这样），客户端拿到的流缺 message_start /
      // message_stop，Anthropic SDK 的 assembler 会直接报错或产出空消息。
      //
      // 所以这里补一道「协议骨架」：首包补 message_start，尾包补 message_stop。
      // 上游已经发过的就不重复补（用 sawStart / sawStop 记）。
      let sawStart = false
      let sawStop = false
      const writeEvent = (name, payload) => {
        if (finished) return
        try {
          // 带 event: 行更贴近上游格式；只有 data: 时 SDK 也能解析，
          // 但两种都发会让同一条事件被处理两次，所以按 name 是否给出二选一。
          res.write(name ? `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n` : `data: ${JSON.stringify(payload)}\n\n`)
        } catch {}
      }

      collector.attach((event) => {
        if (finished) return
        const type = String(event?.type || '')
        if (type === 'message_start') sawStart = true
        if (type === 'message_stop') sawStop = true
        // 首个非 message_start 事件之前，先垫一个 message_start，
        // 保证序列以它开头。
        if (!sawStart && type !== 'message_start') {
          sawStart = true
          writeEvent('message_start', {
            type: 'message_start',
            message: {
              id: collector.messageId || `msg_${requestId}`,
              type: 'message',
              role: 'assistant',
              model: collector.model || outbound?.model || '',
              content: [],
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })
        }
        writeEvent(null, event)
      })

      const finish = (meta = {}) => {
        if (finished) return
        finished = true
        const trailer = {}
        if (meta.usage) trailer['x-kin-usage'] = JSON.stringify(meta.usage)
        if (meta.model) trailer['x-kin-model'] = String(meta.model)
        if (meta.stopReason) trailer['x-kin-stop-reason'] = String(meta.stopReason)
        if (meta.terminalState) trailer['x-terminal-state'] = String(meta.terminalState)
        // trailer 必须在 end 之前写
        // 补 message_stop：客户端靠它判断流结束，缺了就一直在等。
        // 注意此时 finished 已经是 true（上面刚置的），不能再拿它判断。
        if (!sawStop) {
          sawStop = true
          try {
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
          } catch {}
        }
        try {
          res.addTrailers(trailer)
        } catch {}
        try {
          res.end()
        } catch {}
        resolve()
      }

      if (!submitted?.done) return finish({ terminalState: 'incomplete' })

      submitted.done
        .then(({ payload }) => {
          finish({
            usage: collector.usage || payload?.usage || null,
            model: payload?.headers?.['x-model'] || payload?.headers?.['x-kin-model'] || collector.model || outbound?.model || null,
            stopReason: payload?.stopReason || collector.stopReason || null,
            terminalState: entry.cancelled ? 'cancelled' : 'verified',
          })
        })
        .catch((error) => {
          // 已经写了 200 头，只能发一个 error 事件收尾（HTTP 状态改不了了）
          if (!collector.sawEvent) {
            try {
              res.write(
                `event: error\ndata: ${JSON.stringify({
                  type: 'error',
                  error: { type: 'api_error', code: error?.code || 'stream_error', message: String(error?.message || error) },
                })}\n\n`,
              )
            } catch {}
          }
          finish({ terminalState: entry.cancelled ? 'cancelled' : 'transport_error' })
        })
    })
  }

  /**
   * 非流式：等 job_done，把采集到的事件聚合成一条 Message。
   *
   * 为什么要自己聚合：内核只拿到帧，不解析上游 JSON 体。聚合目标是与
   * vm2api 的 createClaudeMessageAssembler **产出形状一致**（type/role/content/
   * usage/stop_reason），不追求内部实现一致。
   */
  function bufferedJob({ res, entry, requestId, outbound, sessionId, slotName, submitted, collector }) {
    return new Promise((resolve) => {
      if (!submitted?.done) {
        sendError(res, 503, 'slot_busy', 'no free slot', 'overloaded_error')
        return resolve()
      }
      submitted.done
        .then(({ payload }) => {
          if (collector.streamError) {
            return resolve(
              sendError(
                res,
                502,
                collector.streamError.error?.code || 'stream_error',
                collector.streamError.error?.message || 'stream failed',
                'api_error',
                { 'x-terminal-state': 'incomplete' },
              ),
            )
          }
          const finalUsage = mergeUsage(collector.usage, payload?.usage || null) || {
            input_tokens: 0,
            output_tokens: 0,
          }
          const finalModel =
            payload?.headers?.['x-model'] || payload?.headers?.['x-kin-model'] || collector.model || outbound?.model || ''
          const finalStop = payload?.stopReason || collector.stopReason || 'end_turn'
          const content = collector.contentBlocks()

          const message = {
            id: `msg_${randomUUID().replace(/-/g, '')}`,
            type: 'message',
            role: 'assistant',
            model: finalModel,
            content,
            stop_reason: finalStop,
            stop_sequence: null,
            usage: finalUsage,
          }
          const headers = messageHeaders({ sessionId, slot: slotName, generation: 1 }, requestId)
          headers['x-terminal-state'] = entry.cancelled ? 'cancelled' : 'verified'
          headers['x-rate-limit-headers'] = JSON.stringify(payload?.headers || {})
          return resolve(sendJson(res, 200, message, headers))
        })
        .catch((error) => {
          resolve(
            sendError(res, 502, error?.code || 'upstream_error', String(error?.message || error), 'api_error', {
              'x-terminal-state': entry.cancelled ? 'cancelled' : 'transport_error',
            }),
          )
        })
    })
  }

  /**
   * 无 CLI 时的降级响应：回 Message 形状，让控制面拿到结构正确的 200。
   * 与 server.mjs B 模式的降级语义一致（那里也是回 mock 而不是 503）。
   */
  function respondDegraded(res, { model, sessionId, slotName, requestId, stream }) {
    const ctx = {
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      model,
      text: 'kernel degraded: native cli host unavailable',
      inputTokens: 0,
      outputTokens: 0,
      slot: slotName,
      sessionId,
      generation: 1,
    }
    if (stream) {
      const headers = sseHeaders(ctx, requestId)
      headers['x-terminal-state'] = 'incomplete'
      res.writeHead(200, headers)
      res.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: { type: 'message', role: 'assistant', id: ctx.id, model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
        })}\n\n`,
      )
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', code: 'kernel_unavailable', message: 'native cli host unavailable' },
        })}\n\n`,
      )
      res.end()
      return Promise.resolve()
    }
    const headers = messageHeaders(ctx, requestId)
    headers['x-terminal-state'] = 'incomplete'
    sendJson(res, 200, messageBody(ctx), headers)
    return Promise.resolve()
  }

  /**
   * POST /internal/v1/cancel
   *
   * 真取消：命中 request_id 就调调度器的 cancel（它会给 CLI 写 cancel 帧）。
   * 客户端不读响应体，但我们要回可判读的状态码，便于面板与测试区分
   * 「取消到了」与「没有这个 job」。
   */
  async function handleCancel(req, res) {
    let payload
    try {
      payload = JSON.parse((await readBody(req, 1 << 20)) || '{}')
    } catch (error) {
      return sendError(res, 400, 'invalid_json', String(error?.message || error))
    }
    const requestId = requestIdFromBody(payload)
    if (!requestId) {
      return sendError(res, 400, 'missing_request_id', 'request_id is required')
    }
    const cancelled = cancelEntry(requestId, 'cancel_endpoint')
    return sendJson(res, 200, { ok: true, cancelled, request_id: requestId })
  }

  /**
   * 取消一个在途 entry。
   *
   * 幂等：重复 cancel 返回 true（entry 已在取消中或已没了），
   * 这样客户端断开 + 显式 cancel 同时发生的竞态不会给出矛盾结果。
   */
  function cancelEntry(requestId, reason) {
    const entry = inflight.get(requestId)
    if (!entry) return false
    if (entry.cancelled) return true
    entry.cancelled = true
    entry.cancelReason = reason
    state.cancelCount += 1
    try {
      if (entry.jobId) scheduler.cancel(entry.jobId)
    } catch (error) {
      logger.warn?.(`[kernel] cancel ${requestId} failed: ${error?.message || error}`)
    }
    return true
  }

  /**
   * GET /internal/v1/models
   *
   * 真实 vm2api 不过 socket 走这条（callWorkerGet 特判成 docker exec），
   * 但形状要保持 Anthropic 的 `{object:'list', data:[...]}`：
   * 万一上游改回 hop，形状不对会直接崩在调用方。
   */
  function handleModels(req, res) {
    const created = Math.floor(Date.now() / 1000)
    const data = modelList(config).map((id) => ({ id, object: 'model', created, owned_by: 'anthropic' }))
    return sendJson(res, 200, { object: 'list', data, has_more: false })
  }

  /**
   * POST /internal/v1/codex/responses
   *
   * envelope 是 Codex 那套（见 contract.mjs 的 CODEX_ENVELOPE_FIELDS）。
   * 直接交给 codex-server.mjs 的 handler：那里已经有完整的
   * Responses 协议处理、账号调度、SSE 转换。本函数只做协议适配：
   * 把内核 envelope 翻译成 codex-server 认识的 HTTP 请求对象。
   */
  async function handleCodexResponses(req, res) {
    // 先校验请求形状，再判通道可用性：形状错的请求无论通道是否就绪都是 400，
    // 报 503 会让调用方以为是临时故障而重试一个永远不会成功的请求。
    let envelope
    try {
      envelope = JSON.parse((await readBody(req, maxBody)) || '{}')
    } catch (error) {
      const status = error?.code === 'request_too_large' ? 413 : 400
      return sendError(res, status, error?.code || 'invalid_json', String(error?.message || error))
    }
    if (!envelope?.body || typeof envelope.body !== 'object') {
      return sendError(res, 400, 'invalid_request', 'envelope.body is required')
    }

    const handler = await ensureCodex()
    if (!handler) {
      return sendError(
        res,
        503,
        'codex_kernel_unavailable',
        `Codex kernel 未就绪（${codexError?.message || 'codex channel not configured'}）`,
        'api_error',
        { 'x-terminal-state': 'rejected' },
      )
    }

    // 把 envelope 摊平成 codex-server 期望的分发形态：
    //   - POST /v1/responses 的 body 就是 envelope.body
    //   - session 通过 session-id 头传（pickSessionId 读它）
    //
    // stream 的取值要跟调用方走，不能无条件 true。
    // 上游线协议确实恒为流式，但那是**内核→上游**这一段的事；
    // 内核→控制面这一段必须满足控制面的期望：
    //   callCodexKernel（非流式）期望 JSON，收到 SSE 会报 worker_invalid_json；
    //   streamCodexKernel（流式）期望 text/event-stream。
    // 原先这里写死 true，所有非流式调用一律 worker_invalid_json ——
    // vm2api 的 transport client 就属于这一类，整条跳直接不可用。
    const wantsStream = envelope.body.stream !== false && envelope.options?.stream !== false
    const body = { ...envelope.body, stream: true }
    const headers = { ...(envelope.headers || {}) }
    if (envelope.session?.session_id) headers['session-id'] = String(envelope.session.session_id)
    else if (envelope.session_id) headers['session-id'] = String(envelope.session_id)
    if (envelope.options?.installation_id) {
      headers['x-codex-installation-id'] = String(envelope.options.installation_id)
    }

    const synthetic = makeSyntheticRequest({ body, headers, url: '/v1/responses', method: 'POST' })
    const captured = makeCaptureResponse(res, { deferWrite: !wantsStream })
    try {
      const handled = await handler.handle(synthetic.req, captured.res)
      if (!handled) {
        return sendError(res, 404, 'codex_route_unhandled', 'codex handler did not accept the responses route')
      }
      const finished = await captured.done

      // 非流式：把捕获到的 SSE 聚合成单个 JSON response 再回给调用方。
      // 这里复用 codex-convert 的 collectResponsesStream —— 与上游侧聚合是
      // 同一份逻辑，避免"两层各写一个解析器、迟早对不上"。
      if (!wantsStream) {
        const { collectResponsesStream } = await import('../codex-convert.mjs')
        const raw = Buffer.concat(finished.chunks || []).toString('utf8')
        const events = (async function* () {
          for (const block of String(raw).split('\n\n')) {
            let eventName = null
            const dataLines = []
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
            }
            if (!dataLines.length) continue
            const payload = dataLines.join('\n')
            if (payload === '[DONE]') continue
            let parsed = payload
            try { parsed = JSON.parse(payload) } catch { /* 保留原文 */ }
            yield { event: eventName, data: parsed }
          }
        })()
        const aggregated = await collectResponsesStream(events)
        const json = JSON.stringify(aggregated)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(json),
        })
        res.end(json)
        return
      }
    } catch (error) {
      state.lastError = error
      if (!res.headersSent) {
        return sendError(res, 502, 'codex_hop_failed', String(error?.message || error), 'api_error')
      }
      try {
        res.end()
      } catch {}
    }
  }

  // ─────────────────────────────────────────── 路由与监听

  /**
   * 请求处理器。抽成独立函数是为了让任意多个 http.Server 实例共用它 ——
   * Node 的一个 Server 只能 listen 一次，而我们要同时在 kernel.sock 与
   * codex-kernel.sock 上监听（vm2api 的两套 supervisor 各 dial 一个）。
   */
  const handleRequest = async (req, res) => {
    const requestId = randomUUID()
    if (!req.headers['x-request-id']) req.headers['x-request-id'] = requestId

    let pathname = '/'
    try {
      pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/'
    } catch {
      return sendError(res, 400, 'invalid_url', 'cannot parse request url')
    }

    // ── 鉴权：先于路由判定，未认证的探测一律 401（与 api-kernel 的 Go 实现一致）
    if (!isAuthed(req.headers, config.internal_token)) {
      return sendJson(res, 401, workerError(401, 'internal_auth_failed', 'Internal worker authentication failed'), {
        'x-request-id': requestId,
        'www-authenticate': KERNEL_AUTH_HEADERS.join(', '),
      })
    }

    try {
      if (pathname === KERNEL_ENDPOINTS.health.path) {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
        return handleHealth(req, res)
      }
      if (pathname === KERNEL_ENDPOINTS.messages.path) {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
        return await handleMessages(req, res)
      }
      if (pathname === KERNEL_ENDPOINTS.models.path) {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
        return handleModels(req, res)
      }
      if (pathname === KERNEL_ENDPOINTS.cancel.path) {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
        return await handleCancel(req, res)
      }
      if (pathname === KERNEL_ENDPOINTS.codexResponses.path) {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
        return await handleCodexResponses(req, res)
      }
      return sendError(res, 404, 'not_found', `no route for ${req.method} ${pathname}`)
    } catch (error) {
      state.lastError = error
      logger.error?.(`[kernel] ${req.method} ${pathname} failed: ${error?.message || error}`)
      if (!res.headersSent) {
        return sendError(res, 500, 'internal_error', String(error?.message || error))
      }
      try {
        res.end()
      } catch {}
    }
  }

  /** 造一个绑好 handler 与超时策略的 Server。每个监听目标一个。 */
  function makeServer() {
    const srv = http.createServer(handleRequest)
    // 长跑请求：不设 server 级 timeout，超时由上游 idle 逻辑管理
    srv.requestTimeout = 0
    srv.headersTimeout = 60_000
    srv.keepAliveTimeout = 65_000
    return srv
  }

  /**
   * 启动监听。
   *
   * unix 模式的三个必须动作（顺序不能乱）：
   *   1. mkdir 父目录；
   *   2. unlink 残留 socket 文件（否则 EADDRINUSE，supervisor 只能看到 health_timeout）；
   *   3. listen 之后 chmod 0600（文件在 listen 之后才存在）。
   *
   * 最后顺手启动调度器（CLI）。启动失败不抛错：降级模式仍要能报健康。
   */
  async function start() {
    const targets = listenTargets(config)
    if (!targets.length) throw new Error('kernel has no listen target: set kernel_listen or socket_path')

    // unix 模式的三个必须动作（顺序不能乱）：
    //   1. mkdir 父目录；
    //   2. unlink 残留 socket（否则 EADDRINUSE，supervisor 只能看到 health_timeout）；
    //   3. listen 之后 chmod 0600（文件在 listen 之后才存在）。
    for (const target of targets) {
      if (!target.path) continue
      fs.mkdirSync(path.dirname(target.path), { recursive: true })
      try {
        fs.unlinkSync(target.path)
      } catch {}
    }

    // 每个监听目标一个 Server 实例：Node 的一个 Server 只能 listen 一次。
    // 全部共用 handleRequest，路由与鉴权逻辑只有一份。
    const addresses = []
    for (const target of targets) {
      const srv = makeServer()
      servers.push(srv)
      addresses.push({ target, address: await listenOn(srv, target, logger) })
    }

    // CLI 宿主：失败只记状态，不影响监听
    try {
      await scheduler.start()
    } catch (error) {
      state.cliError = error
      logger.error?.(`[kernel] cli host unavailable: ${error?.message || error}`)
    }
    syncState()
    return { targets, addresses, address: addresses[0] }
  }

  function close() {
    return new Promise((resolve) => {
      try {
        scheduler.stopAll?.()
      } catch {}
      let remaining = servers.length
      if (!remaining) return resolve()
      for (const srv of servers) {
        srv.close(() => {
          remaining -= 1
          if (remaining <= 0) resolve()
        })
      }
      // 有未完成的连接时 close 会等；兜底直接断开
      setTimeout(() => {
        for (const srv of servers) {
          try {
            srv.closeAllConnections?.()
          } catch {}
        }
        resolve()
      }, 500).unref?.()
    })
  }

  return {
    /** 主监听（第一个目标）的 Server，供需要单实例的调用方使用 */
    get server() {
      return servers[0] || null
    },
    /** 全部 Server 实例，按监听目标顺序 */
    get servers() {
      return [...servers];
    },
    state,
    scheduler,
    start,
    close,
    /** 暴露给测试：在途 job 表的只读快照 */
    inflightSnapshot: () => [...inflight.entries()].map(([id, e]) => ({ request_id: id, ...e, onEvent: undefined })),
    /** 暴露给测试与自检：当前 health payload（同步，不做 IO 之外的事） */
    healthPayload: () => {
      syncState()
      state.credentialState = credentialState()
      return readinessPayload(config, state)
    },
    /** 暴露给自检：supervisor 会怎么判我们 */
    supervisorView: () => supervisorView(readinessPayload(config, syncState())),
  }
}

// ─────────────────────────────────────────── 辅助

/**
 * 单次 listen，等回调回来再 resolve。
 *
 * 必须等回调：vm2api 的 supervisor 起内核后立刻开始 80ms 轮询，
 * 若我们在 listen 回调之前就认为"启动完成"（例如直接 await 一个已 resolve 的
 * promise），父进程可能在 socket 文件存在但未 bind 的窗口里发第一个
 * health 请求，拿到 ECONNREFUSED。虽然 supervisor 会重试，但那会浪费预算。
 */
function listenOn(server, target, logger) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      clearTimeout(warnTimer)
      reject(error)
    }
    const warnTimer = setTimeout(() => {
      logger.warn?.(`[kernel] listen still pending after 2s on ${target.path || `:${target.port}`}`)
    }, 2000)
    warnTimer.unref?.()
    server.once('error', onError)
    server.listen(target, () => {
      clearTimeout(warnTimer)
      server.removeListener('error', onError)
      if (target.path) {
        try {
          fs.chmodSync(target.path, 0o600)
        } catch {}
      }
      resolve(server.address())
    })
  })
}

/**
 * 事件采集器：在 submit 之前创建，先缓冲、后分流。
 *
 * 为什么需要它：scheduler.submit 会**同步**写 stdin（host.startJob），
 * 而 CLI 的回帧可能在任何 await 之前就返回（test/fixtures/fake-cli.mjs
 * 就是同步回两帧）。如果等 submit 返回后再挂 onEvent，首批事件已经丢了。
 *
 * 因此用法固定为：
 *   const collector = createCollector()
 *   const submitted = scheduler.submit({ ..., onEvent: (e) => collector.push(e) })
 *   collector.attach((e) => res.write(...))   // attach 时把已缓存的事件补发
 */
function createCollector({ stream = false } = {}) {
  const buffer = []
  const sink = { fn: null, done: false }
  const state = {
    sawEvent: false,
    usage: null,
    model: null,
    stopReason: null,
    streamError: null,
  }
  // 内容块按 index 累积：text / thinking / tool_use 三种 delta 分别拼装
  const blocks = []
  const pending = new Map()

  function push(event) {
    if (!event || typeof event !== 'object') return
    state.sawEvent = true
    observe(event)
    if (sink.fn) {
      sink.fn(event)
      return
    }
    // 还没 attach：先缓存。有上限保护，避免异常流把内存拖爆。
    if (buffer.length < 4096) buffer.push(event)
  }

  function observe(event) {
    switch (event.type) {
      case 'message_start':
        if (event.message?.model) state.model = event.message.model
        state.usage = mergeUsage(state.usage, event.message?.usage || null)
        break
      case 'content_block_start':
        blocks[event.index ?? blocks.length] = { ...(event.content_block || {}) }
        break
      case 'content_block_delta': {
        const idx = event.index ?? 0
        const delta = event.delta || {}
        let piece = ''
        if (delta.type === 'text_delta') piece = String(delta.text || '')
        else if (delta.type === 'thinking_delta') piece = String(delta.thinking || '')
        else if (delta.type === 'input_json_delta') piece = String(delta.partial_json || '')
        if (piece) pending.set(idx, (pending.get(idx) || '') + piece)
        break
      }
      case 'message_delta':
        if (event.delta?.stop_reason) state.stopReason = event.delta.stop_reason
        state.usage = mergeUsage(state.usage, event.usage || null)
        break
      case 'error':
        state.streamError = event
        break
      default:
        break
    }
  }

  return {
    push,
    /** 挂上真正的下游 sink，并把此前缓存的事件按序补发 */
    attach(fn) {
      if (sink.fn) {
        sink.fn = fn
        return
      }
      sink.fn = fn
      const queued = buffer.splice(0, buffer.length)
      for (const event of queued) fn(event)
    },
    /**
     * 聚合出 content 数组。
     *
     * 注意 pending 里的 delta 可能**没有**对应的 content_block_start。
     * 上游（以及假 CLI 这类简化宿主）经常只发 delta，
     * 原先这里只遍历 blocks，于是 pending 里的文本被整段丢掉 ——
     * 表现是 content:[{type:'text',text:''}] 但 usage 正常，
     * 状态 200、结构完整，只有文本是空串，非常难查。
     *
     * 所以以 pending 的 index 并集为准：没有 start 的 index
     * 一律补成 text 块（不知道真实类型时 text 是最安全的默认）。
     */
    contentBlocks() {
      const indexes = new Set()
      for (let i = 0; i < blocks.length; i += 1) if (blocks[i]) indexes.add(i)
      for (const idx of pending.keys()) indexes.add(idx)
      const sorted = [...indexes].sort((a, b) => a - b)

      const out = []
      for (const idx of sorted) {
        const block = blocks[idx]
        const text = pending.get(idx)
        if (!block && text == null) continue
        const base = block || { type: 'text' }
        if (text == null) {
          out.push(base)
          continue
        }
        if (base.type === 'text' || base.type === undefined) out.push({ ...base, type: 'text', text })
        else if (base.type === 'thinking') out.push({ ...base, thinking: text })
        else if (base.type === 'tool_use') out.push({ ...base, input: safeJson(text) })
        else out.push(base)
      }
      return out.length ? out : [{ type: 'text', text: '' }]
    },
    get sawEvent() {
      return state.sawEvent
    },
    get usage() {
      return state.usage
    },
    get model() {
      return state.model
    },
    get stopReason() {
      return state.stopReason
    },
    get streamError() {
      return state.streamError
    },
  }
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, { allow })
  res.end()
}

/**
 * session 提取：从 metadata.user_id 里取 session_id。
 *
 * user_id 可能是 JSON 字符串也可能是对象；解析失败按"无 session"处理，
 * 由调用方生成新的，而不是让请求失败。与 server.mjs 的 extractSessionId 同语义，
 * 但那个是私有函数，不改它的情况下这里保留一份最小实现。
 */
function extractSessionId(body) {
  const raw = body?.metadata?.user_id
  if (!raw) return undefined
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  const id = parsed?.session_id
  return typeof id === 'string' && id.trim() ? id.trim() : undefined
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * 模型清单。
 *
 * 优先用配置里的 codex_models / 缺省 anthropic 家族；控制面只把它当展示用，
 * 不做模型存在性校验（models.mjs 的注释明确写了「禁止 hop 槽位 /internal/v1/models」）。
 */
function modelList(config = {}) {
  const configured = Array.isArray(config.models) && config.models.length ? config.models : null
  if (configured) return configured
  return [
    'claude-opus-4-7',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
  ]
}

/**
 * 造一个「假 req」给 codex-server 用。
 *
 * codex-server 的 handler 接受真实的 IncomingMessage。为了避免为它复制一份
 * 请求解析逻辑（那会让两条路径的行为慢慢分叉），这里构造一个满足它
 * 实际读取范围的最小对象：method / url / headers / async iterator / on('close')。
 */
function makeSyntheticRequest({ body, headers, url, method }) {
  const payload = Buffer.from(JSON.stringify(body))
  const listeners = new Map()
  let consumed = false

  const req = {
    method,
    url,
    headers: { ...headers, 'content-type': 'application/json', 'content-length': String(payload.length) },
    /** codex-server 用 readRequestBody(req) 的 'data'/'end' 事件接口 */
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return req
    },
    removeListener(event, fn) {
      const list = listeners.get(event)
      if (list) listeners.set(event, list.filter((f) => f !== fn))
      return req
    },
    /** 部分实现用 for await (const c of req) */
    async *[Symbol.asyncIterator]() {
      if (!consumed) {
        consumed = true
        yield payload
      }
    },
    setTimeout() {},
    destroy() {},
  }

  // 下一个 tick 把数据喂给 'data' 监听者，模拟真实流的异步性
  queueMicrotask(() => {
    for (const fn of listeners.get('data') || []) fn(payload)
    for (const fn of listeners.get('end') || []) fn()
  })

  return { req }
}

/**
 * 捕获式响应代理：把 codex-server 写出来的内容收集起来，再转写到真实 res。
 *
 * 需要它是因为 codex-server 的 handler 直接操作 IncomingMessage /
 * ServerResponse（writeHead / write / end）。直接塞真实 res 会让它写错头
 * （例如它写 200 而我们其实已经决定 502）。代理先缓冲，再统一落盘。
 */
function makeCaptureResponse(res, { deferWrite = false } = {}) {
  let status = 200
  let headers = {}
  const chunks = []
  let headersSent = false
  const listeners = new Map()

  const proxy = {
    get headersSent() {
      return headersSent
    },
    get writableEnded() {
      return proxy._ended === true
    },
    _ended: false,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()]
    },
    writeHead(code, maybeHeaders) {
      status = Number(code) || 200
      if (maybeHeaders && typeof maybeHeaders === 'object') {
        for (const [k, v] of Object.entries(maybeHeaders)) headers[String(k).toLowerCase()] = v
      }
      headersSent = true
      return proxy
    },
    write(chunk) {
      if (!headersSent) headersSent = true
      if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end(chunk) {
      if (chunk != null) proxy.write(chunk)
      proxy._ended = true
      // deferWrite：调用方要自己决定最终写什么（例如把 SSE 聚合成 JSON），
      // 这里只记录、不落盘。不延迟的话响应已经发出去，改不了了。
      if (deferWrite) {
        for (const fn of listeners.get('finish') || []) fn()
        for (const fn of listeners.get('close') || []) fn()
        return
      }
      // 统一转写到真实响应
      try {
        res.writeHead(status, headers)
      } catch {
        // 真实响应已经写过（例如 handler 中途自己写了错误），保持原样
      }
      for (const c of chunks) res.write(c)
      res.end()
      for (const fn of listeners.get('finish') || []) fn()
      for (const fn of listeners.get('close') || []) fn()
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return proxy
    },
    once(event, fn) {
      return proxy.on(event, fn)
    },
    removeListener() {
      return proxy
    },
    flushHeaders() {},
    addTrailers() {},
  }

  // codex-server 用 res.on('close') 挂 abort；这里在 end 时统一触发
  const done = new Promise((resolve) => {
    const check = () => {
      if (proxy._ended) resolve({ status, headers, chunks })
      else setTimeout(check, 5).unref?.()
    }
    check()
  })

  return { res: proxy, done }
}

// ─────────────────────────────────────────── 命令行入口
//
// supervisor 起内核的方式是固定命令行（supervisor-compat 的 SUPERVISOR_START）：
//
//   kin-kernel --gateway-worker --config /run/kin/kernel.json
//
// 我们把入口做成**接受同一份 argv**，这样替换只需要把那个路径指向这个脚本，
// supervisor 一行都不用改。参数解析刻意宽松：
//   - `--gateway-worker` 接受但不需要动作（我们本来就只有一种模式）；
//   - `--config <path>` 给 kernel.json，用它投影出内核配置；
//   - 位置参数（kernel.json 路径）也接受，因为 codex-kernel-supervisor 起
//     自己的内核时用的是 `spawn(bin, [configPath])`，没有 --config 标志。
// 未知参数忽略而不是报错：supervisor 未来加参数时，报错会让内核直接退出，
// 表现为 health_timeout —— 最难排查的那一类故障。

/**
 * 解析内核启动参数。
 *
 * @param {string[]} argv 不含 node 与脚本名
 * @returns {{configPath:string|null, gatewayWorker:boolean, unknown:string[]}}
 */
export function parseKernelArgs(argv = []) {
  let configPath = null
  let gatewayWorker = false
  // -socket / -token 是控制面拉起内核时用的单横线形式（spawn(bin, ['-socket', p, '-token', t])）。
  // 不接受它们的话，控制面会认为内核起不来并直接退出进程。
  let socketPath = null
  let token = null
  const unknown = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--gateway-worker') gatewayWorker = true
    // -config 与 --config 都要认：-socket / -token 已经支持单横线
    // （控制面就是那样传的），config 若只认双横线，就会出现
    // 「socket 和 token 生效了、配置被忽略」这种最难查的半生效状态：
    // 内核起来了、health 有响应，但 codex_credential_path 全是空的。
    else if (arg === '--config' || arg === '-config') configPath = argv[++i] ?? null
    else if (arg.startsWith('--config=')) configPath = arg.slice('--config='.length)
    else if (arg.startsWith('-config=')) configPath = arg.slice('-config='.length)
    else if (arg === '-socket' || arg === '--socket') socketPath = argv[++i] ?? null
    else if (arg.startsWith('-socket=') || arg.startsWith('--socket=')) socketPath = arg.slice(arg.indexOf('=') + 1)
    else if (arg === '-token' || arg === '--token') token = argv[++i] ?? null
    else if (arg.startsWith('-token=') || arg.startsWith('--token=')) token = arg.slice(arg.indexOf('=') + 1)
    else if (!arg.startsWith('-') && !configPath) configPath = arg
    else unknown.push(arg)
  }
  return { configPath, gatewayWorker, socketPath, token, unknown }
}

/**
 * 作为脚本运行时的入口。
 *
 * 返回值是 { kernel, config }，便于测试直接调用而不走 spawn。
 */
export async function runKernelMain({ argv = process.argv.slice(2), env = process.env, logger = console } = {}) {
  const args = parseKernelArgs(argv)
  if (args.unknown.length) {
    logger.warn?.(`[kernel] ignoring unknown arguments: ${args.unknown.join(' ')}`)
  }

  // argv 优先于环境变量：控制面每次拉起内核都会显式传 -socket/-token，
  // 环境变量只是本地手工启动时的兜底。反过来会让残留的环境变量
  // 悄悄盖掉控制面刚分配的值，两个实例抢同一个 socket。
  const fallback = {
    vm_id: String(env.KERNEL_VM_ID || ''),
    internal_token: String(args.token || env.KERNEL_INTERNAL_TOKEN || ''),
    socket_path: String(args.socketPath || env.KERNEL_SOCKET || ''),
    kernel_listen: String(env.KERNEL_LISTEN || 'unix'),
    kernel_tcp_host: String(env.KERNEL_TCP_HOST || '127.0.0.1'),
    kernel_tcp_port: Number(env.KERNEL_TCP_PORT) || 0,
    credential_path: String(env.KERNEL_CREDENTIAL_PATH || ''),
    claude_bin: String(env.CLAUDE_BIN || ''),
    slots_per_worker: Number(env.KERNEL_SLOTS) || 0,
    system_layout: String(env.CLAUDE_CODE_SYSTEM_LAYOUT || 'zero'),
    default_cache_ttl: String(env.KERNEL_CACHE_TTL || '1h'),
    timezone: String(env.CLAUDE_CODE_TIMEZONE || ''),
  }

  const config = args.configPath
    ? kernelConfigFromFile(args.configPath, { env, fallback })
    : kernelConfigFromVN2({}, { env, fallback })

  if (!config.internal_token) {
    // 没 token 的内核等于把 /internal/* 暴露在 socket 上；宁可不启动。
    throw new Error('kernel: internal_token is required (kernel.json or KERNEL_INTERNAL_TOKEN)')
  }

  for (const warning of startupWarnings({
    homeDir: env.HOME || '',
    socketPath: config.socket_path,
    kernelJsonPath: args.configPath || '',
    entryPath: new URL(import.meta.url).pathname,
  })) {
    logger.warn?.(`[kernel] ${warning}`)
  }

  const kernel = createKernelServer({ config, deps: { logger } })
  const info = await kernel.start()

  // supervisor 不看 stdout，但运维需要知道内核到底听了哪里。
  // 单行 JSON：与 src/server.mjs 的日志风格一致，便于日志采集。
  logger.log?.(
    JSON.stringify({
      level: 'INFO',
      fields: {
        message: 'kernel listening',
        vm_id: config.vm_id,
        engine: KERNEL_ENGINE_LABEL,
        slots_per_worker: config.slots_per_worker,
        config: args.configPath,
        addresses: info.addresses.map((a) => a.address),
      },
      target: 'kernel::node',
    }),
  )

  const shutdown = async () => {
    await kernel.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  return { kernel, config, info }
}

/** 只有作为入口脚本执行时才真正启动；被 import 时（测试）不监听。 */
function isEntrypoint() {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return new URL(import.meta.url).pathname === fs.realpathSync(invoked)
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  runKernelMain().catch((error) => {
    console.error(`[kernel] startup failed: ${error?.message || error}`)
    process.exit(1)
  })
}
