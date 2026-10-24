#!/usr/bin/env node
/**
 * 内核主程序：双模式启动入口。
 *
 * 模式 A（缺省，公共 server）：TCP 监听，只挂 POST /v1/messages。
 * 模式 B（--gateway-worker --config X）：Unix socket，挂 /internal/* 接口。
 *
 * 启动：
 *   node src/server.mjs                                        # A 模式，缺省 0.0.0.0:8080
 *   node src/server.mjs --gateway-worker --config cfg.json      # B 模式
 *
 * 关键约束：
 * 1. 出站请求的组装顺序固定：system 布局 → betas 合并 → cch 封盖。
 *    顺序不能调整，cch 是对最终字节算的，提前或推后都会算出不同的值。
 * 2. 调试路由（/readyz、/internal/v1/slots、/internal/v1/envelope）缺省不挂载，
 *    需 EXPOSE_KERNEL_DEBUG_ROUTES=1 才开放。生产环境保持关闭。
 * 3. CLI 不可用时服务降级但不失败：健康检查仍返回 200，
 *    /v1/messages 回落 mock 响应，让控制面能继续读到状态。
 * 4. B 模式的鉴权只认 x-internal-token 一个头。
 */

import http from 'node:http'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { validateWorkerConfig, Envelope, healthPayload, workerError, resolveClaudeBin } from './config.mjs'
import { messageStream, messageBody, messageHeaders, sseHeaders } from './sse.mjs'
import { SlotScheduler } from './scheduler.mjs'
import { sealClaudeCodeCch } from './cch.mjs'
import { layoutSystemBlocks, wireSystemBlocks, getSystemLayout, buildBillingAttribution, normalizeBillingVersion } from './system-layout.mjs'
import { applyCacheBreakpoints } from './cache-breakpoints.mjs'
import { runInboundGate } from './risk/gate.mjs'
import { RefusalCache } from './risk/refusal-cache.mjs'
import { createTelemetry } from './telemetry/index.mjs'
import {
  assembleRequest,
  resolvePromptProfile,
  STRUCTURE_SYSTEM_REMINDER,
  DEFAULT_PROMPT_PROFILE,
} from './prompt-profiles.mjs'
import { BETA } from './betas.mjs'
import { mergeOfficialExtraBetas } from './identity.mjs'
import { createCodexHandler } from './codex-server.mjs'
import {
  AnthropicUpstream,
  MODE,
  ERROR_KIND,
  buildOutboundHeaders,
  collectMessage,
  buildBetaHeader,
} from './anthropic.mjs'
import { resolveCredential } from './anthropic-credentials.mjs'
import { validateAnthropicBaseUrl, DEFAULT_WORKER_CONFIG } from './config.mjs'

const argv = process.argv.slice(2)

/**
 * 解析命令行参数。
 * --config 只能与 --gateway-worker 同用；--gateway-worker 必须带 --config。
 * 未知参数直接报错，不做静默忽略——拼错的参数被忽略会导致按错误的模式启动。
 */
function parseArgs(args) {
  const out = {
    gatewayWorker: false,
    config: null,
    addr: null,
    codex: false,
    codexCredential: null,
    mock: false,
    anthropicCredential: null,
  }
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--gateway-worker') out.gatewayWorker = true
    else if (a === '--config') out.config = args[++i]
    else if (a === '--addr') out.addr = args[++i]
    // --codex 打开 Codex 通道（/v1/responses、/v1/chat/completions、/v1/models）。
    // 凭据路径可以用 --codex-credential 显式给，也可以用环境变量 CODEX_CREDENTIAL_PATH。
    else if (a === '--codex') out.codex = true
    else if (a === '--codex-credential') {
      out.codex = true
      out.codexCredential = args[++i]
    } else if (a === '--codex-model') out.codexModel = args[++i]
    // --mock 显式打开降级响应（无凭据联调用）。缺省走真实上游。
    else if (a === '--mock') out.mock = true
    // --anthropic-credential 指定 Claude 凭据文件（单账号 / {accounts:[]} /
    // 官方 credentials.json 三种形态都认）。不指定时回落到环境变量。
    else if (a === '--anthropic-credential') out.anthropicCredential = args[++i]
    else throw new Error(`unknown argument: ${a}`) // 错误文案与 CLI 约定一致
  }
  if (!out.gatewayWorker && out.config) throw new Error('--config is only valid with --gateway-worker')
  if (out.gatewayWorker && !out.config) throw new Error('--gateway-worker requires --config')
  if (out.gatewayWorker && out.codex) throw new Error('--codex is only valid in public server mode')
  if (out.codexCredential != null && !out.codexCredential) throw new Error('--codex-credential requires a path')
  if (out.anthropicCredential != null && !out.anthropicCredential) {
    throw new Error('--anthropic-credential requires a path')
  }
  // --mock 与 --gateway-worker 互斥：B 模式的响应体由控制面消费，
  // 在那里返回假内容会让控制面把 mock 当成上游输出。
  if (out.gatewayWorker && out.mock) throw new Error('--mock is only valid in public server mode')
  return out
}

/**
 * 读完整请求体并转成 utf8 字符串。
 * 超限时先 reject 再 destroy 连接，避免把剩余数据读完浪费带宽。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error('request too large'), { code: 'too_large' }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 出站前规范化：system 布局 → betas 合并 → 缓存断点 → cch 封盖。
 *
 * 四步顺序是硬约束。cch 由最终字节决定，因此必须放在最后一步；
 * betas 需要在 system 定稿之后合并，才能和 system 里声明的能力保持一致；
 * 缓存断点会改变 content 的块结构（字符串转数组、加 cache_control），
 * 必须在 betas 之后、封盖之前落地——放在封盖之后会让哈希对不上。
 *
 * system 的处理有两条分支：
 *   - 调用方已经给了 ≥4 块官方 system：视为官方布局已就位，只做 wire 规范化；
 *   - 否则按配置的布局模式重建。
 *
 * 缓存断点：system 固定两个（身份块 + 主提示词），messages 在消息数足够时
 * 两个（最后一条 user + 上一条 user）。只打尾部一个点时，上一轮写入的位置
 * 与下一轮前缀对不上，回溯越界后 messages 每轮整段重写，成本会明显上升。
 */
/**
 * 生成一个占位形态的官方计费头。
 *
 * cch 由后续封盖步骤写入真实值，这里只给出字段骨架。
 * cc_entrypoint 固定 sdk-cli：出站 UA 与计费头必须是同一形态，
 * 否则两者对不上会形成可识别的矛盾特征。
 */
function defaultBillingHeader(cliVersion, firstUserText = '', sessionId = '') {
  // 必须是完整格式，不能只写版本号。
  //
  // 官方格式（v1.3.220 crs-persona.mjs:376）：
  //   cc_version=<ver>.<3hex 指纹>; cc_entrypoint=sdk-cli; cch=<5hex>; cc_prompt_id=<uuid>;
  //
  // 之前这里只拼 `cc_version=2.1.296;` —— 缺指纹尾缀和 cc_prompt_id。
  // `cc_version=<ver>.<fp>` 里的 fp 是官方用来把版本号与首条 user 内容
  // 绑定的字段；只有裸版本号是最明显的伪造特征。
  //
  // 复用 system-layout 的构造函数，避免两处生成漂移
  // （这正是官方 1.3.220 修复的另一半：billing 只能有一个生成点）。
  return buildBillingAttribution({
    cliVersion: normalizeBillingVersion(cliVersion),
    firstUserText,
    sessionId,
  })
}

/**
 * 入站闸的拒答缓存。进程级单例。
 *
 * 必须跨请求共用：这一关的作用就是"上游拒过的内容再发一次要拦住"，
 * 每次请求新建实例等于永远记不住任何东西，第三关形同虚设。
 */
const inboundGateCache = new RefusalCache({})

/**
 * 遥测单例。
 *
 * 默认关闭：上报是"代替用户向上游陈述"的行为，不能作为默认。
 * 关闭时 enqueue 直接丢弃，不产生网络与内存开销。
 */
const telemetry = createTelemetry({
  config: {
    telemetry_enabled: process.env.SKYLINK_TELEMETRY === '1',
    ...(process.env.SKYLINK_TELEMETRY_ENDPOINT
      ? { telemetry_endpoint: process.env.SKYLINK_TELEMETRY_ENDPOINT }
      : {}),
  },
})

/**
 * 真实出站开关。
 *
 * 默认 false。mock 模式存在的唯一目的是无凭据时也能跑通链路做联调，
 * 它不该是默认值 —— 默认 mock 意味着控制面看到一条健康链路而实际什么都没发。
 * 三个入口都能打开：环境变量 SKYLINK_MOCK=1、配置文件 mock_mode:true、
 * 命令行 --mock。任一命中即 mock，方便联调时不改环境。
 */
function readMockFlag({ env = process.env, config = null, argvFlags = null } = {}) {
  if (argvFlags?.mock === true) return true
  if (config?.mock_mode === true) return true
  return env.SKYLINK_MOCK === '1'
}

/** 出站客户端。由 buildPublicServer 构造，使 baseUrl / 超时可来自配置。 */
function createUpstream({ env = process.env, config = null } = {}) {
  // baseUrl 走 config.mjs 的同一套白名单校验：host 不是 api.anthropic.com 的
  // 地址在这里就会被拒，不会等到发出去才拿到一个看不懂的 404。
  const baseUrl = validateAnthropicBaseUrl(
    config?.anthropic_base_url || env.SKYLINK_ANTHROPIC_BASE || DEFAULT_WORKER_CONFIG.anthropic_base_url,
  )
  return new AnthropicUpstream({
    baseUrl,
    timeoutMs: Number(config?.anthropic_timeout_ms ?? env.SKYLINK_UPSTREAM_TIMEOUT_MS) || 600_000,
    compressThreshold:
      Number(config?.anthropic_compress_threshold ?? env.SKYLINK_COMPRESS_THRESHOLD) || 1024,
  })
}

/**
 * 取当前可用的 Claude 凭据。
 *
 * 优先级：环境变量 > 凭据文件。环境变量先读是为了让容器化部署不必挂载文件。
 *
 * 兼容两种历史写法：
 *   - SKYLINK_CLAUDE_TOKEN（本仓库早期约定的单一 token 变量）
 *   - CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY（官方）
 * 前者优先，因为它是本进程显式配置的值。
 *
 * 返回 {token, auth_scheme, account, source} 或 null。不抛错：未配凭据是
 * 可预期的启动态，由调用方决定回什么状态码。
 */
function resolveClaudeCredential({ env = process.env, config = null } = {}) {
  const direct = String(env.SKYLINK_CLAUDE_TOKEN || '').trim()
  if (direct) {
    return {
      token: direct,
      auth_scheme: /^sk-ant-api/.test(direct) ? 'api_key' : 'oauth',
      account: { id: 'env', access_token: direct, auth_scheme: /^sk-ant-api/.test(direct) ? 'api_key' : 'oauth' },
      source: 'SKYLINK_CLAUDE_TOKEN',
    }
  }
  const path = config?.anthropic_credential_path || env.ANTHROPIC_CREDENTIAL_PATH || null
  try {
    const resolved = resolveCredential({ path, env })
    if (!resolved.account) return null
    return {
      token: resolved.account.access_token,
      auth_scheme: resolved.account.auth_scheme || 'oauth',
      account: resolved.account,
      source: resolved.source,
    }
  } catch {
    return null
  }
}

/**
 * 非流式聚合：把上游 SSE 收成一条完整 message。
 *
 * 聚合规则统一在 anthropic.mjs 的 collectMessage 里，这里只是把上游流
 * 喂给同一个事件迭代器。不在这里另写一份解析——两份实现迟早会分叉，
 * 而分叉的表现是"流式正常、非流式少一段文本"，最难查的那种。
 */
async function collectAnthropicMessage(stream) {
  return collectMessage(anthropicUpstream.iterEvents(stream))
}

export function prepareOutbound(body, { systemLayout, panelTtl, promptProfile, environment, officialCaller } = {}) {
  // 0. 提示词档位组装。
  //
  // 档位决定整份 system 与 messages 的形态，必须在其它步骤之前完成：
  // 后续的 betas、断点、cch 都以这一步产出为输入。
  //
  // 303 档自带断点布点（身份句、主提示词、尾部 user），因此结构为
  // system_reminder 时必须跳过第 3 步，否则会叠出与样本不符的第三方形状。
  const profile = resolvePromptProfile({
    model: body?.model,
    configured: promptProfile ?? DEFAULT_PROMPT_PROFILE,
  })
  const assembled = assembleRequest(body, {
    profile,
    model: body?.model,
    environment: environment ?? null,
    ttl: panelTtl ?? null,
    officialCaller: officialCaller ?? null,
  })

  let next = { ...assembled.body }

  // 档位组装（第 0 步）负责的只是「按档位摆块」，cli_hop 结构下它不造 billing 头
  // —— 计费头属于布局层（第 1 步）的职责。两者按结构分工，避免同一份 system
  // 被两处独立生成而互相覆盖：一旦 billing 被覆盖，后续 cch 就没有封盖目标。
  //
  //   system_reminder 结构：档位产出完整 system（billing + 身份句 + 主提示词），
  //                        第 1 步必须跳过，否则会叠出与样本不符的第二份。
  //   cli_hop 结构：       第 1 步按布局生成 billing/env，档位只提供身份句与余量。
  const selfPositionedMarkers = assembled.structure === STRUCTURE_SYSTEM_REMINDER

  // 1. system 布局：调用方已有 4 块官方 system 就不动，只规范成 wire 形态
  if (selfPositionedMarkers) {
    // 档位已生成 system，保持原样
  } else if (Array.isArray(next.system) && next.system.length >= 4) {
    next.system = wireSystemBlocks(next.system) || next.system
  } else if (systemLayout && systemLayout !== 'stock') {
    // 档位产出的 system 已含 Environment 块，第 1 步会再生成一份，
    // 直接拼进去就会出现两个 Environment。这里只保留调用方自己的内容：
    // 即去掉档位生成的环境块之后剩下的部分。
    const assembledTexts = new Set(
      (assembled.system || []).map((b) => String(b?.text ?? b ?? '')),
    )
    const callerBlocks = (Array.isArray(next.system) ? next.system : [])
      .map((b) => String(b?.text ?? b ?? ''))
      .filter((t) => t && !assembledTexts.has(t))
    const callerSystem = Array.isArray(next.system)
      ? callerBlocks.join('\n\n')
      : typeof next.system === 'string'
        ? next.system
        : ''
    // attribution 不能留空：空串会让布局层跳过 billing 头，
    // 后续 cch 就没有封盖目标，出站请求缺少计费头会与官方形态不符。
    // 档位已生成 billing 时沿用它的内容，否则由本层按默认身份句生成。
    // cli_hop 结构下档位不产 billing，这里必须补一个合法计费头，
    // 否则布局层会跳过 billing 块，出站请求缺少计费头。
    // 身份句与 billing 的 cc_entrypoint=sdk-cli 保持一致。
    const attribution = assembled.billing || defaultBillingHeader(assembled.cliVersion)
    // 布局来源有两条：显式参数优先，其次才是环境变量。
    // 只看环境变量时，调用方传进来的 systemLayout 会被静默忽略，
    // 面板上切换布局不生效，而出站字节仍按旧布局生成。
    const layoutEnv =
      systemLayout == null
        ? process.env
        : { ...process.env, CLAUDE_CODE_SYSTEM_LAYOUT: systemLayout }
    const blocks = layoutSystemBlocks({
      attribution,
      leftover: callerSystem || undefined,
      env: layoutEnv,
    })
    next.system = blocks.map((text) => ({ type: 'text', text }))
  }

  // 2. betas 合并（官方顺序优先）
  const headerBetas = String(next.__betas__ || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (headerBetas.length || next.betas) {
    const merged = mergeOfficialExtraBetas([...(next.betas || []), ...headerBetas])
    delete next.__betas__
    next.betas = merged
  }

  // 3. 缓存断点：system 2 点 + messages 2 点，总数不超过 4
  // panelTtl 缺省时由模块回落到 1h，与 system 侧保持同一 TTL
  // 303 结构自带断点，重复应用会改变标记位置与总数
  const breakpoints = selfPositionedMarkers
    ? { usesExtendedTtl: false, applied: [] }
    : applyCacheBreakpoints(next, { ttl: panelTtl })

  // 3.1 1h TTL 需要配套的能力声明。断点是本模块新加的标记，
  // 一旦带上 ttl:'1h'，请求就得声明 extended-cache-ttl 才能被上游接受；
  // 调用方原本没带这个 beta 时由这里补上，已有则不动（保持不变式）。
  if (breakpoints.usesExtendedTtl) {
    const betas = Array.isArray(next.betas) ? next.betas : []
    if (!betas.includes(BETA.EXTENDED_CACHE_TTL)) next.betas = [...betas, BETA.EXTENDED_CACHE_TTL]
  }

  // 4. cch 封盖（必须在最后，哈希输入是前三步产出的最终字节）
  const sealed = sealClaudeCodeCch(next, { enabled: true, seal: true })
  return sealed
}

function sendJson(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers })
  res.end(body)
}

/**
 * 把调度器上记录的 CLI 错误收敛成可透出的纯量对象。
 * 未失败时返回 null；失败时带 code / bin / reason / message，
 * 不包含堆栈。健康检查与 /status 共用这一份序列化。
 */
function cliErrorPayload(scheduler) {
  const error = scheduler.cliError
  if (!error) return null
  return {
    code: error.code || 'UNKNOWN',
    bin: error.bin ?? null,
    reason: error.reason || error.message || null,
    message: error.message || null,
  }
}

// ─────────────────────────────────────── A 模式：公共 server
export function buildPublicServer({
  claudeBin,
  env,
  envelopePath = '/tmp/cli/envelope.json',
  codexHandler = null,
  config = null,
  mock = undefined,
}) {
  const exposeDebugRoutes = env.EXPOSE_KERNEL_DEBUG_ROUTES === '1'
  const scheduler = new SlotScheduler({ claudeBin, slots: 20, env })
  scheduler.start().catch(() => {})

  // 出站客户端与开关在服务器构造时确定一次：
  // 每次请求重新构造会让「baseUrl 写错」这类问题变成每请求都失败一次，
  // 也会白白丢掉连接池。
  const mockMode = mock === undefined ? readMockFlag({ env, config }) : mock === true
  const anthropicUpstream = createUpstream({ env, config })

  return http.createServer(async (req, res) => {
    const requestId = randomUUID()
    const url = new URL(req.url, 'http://localhost')

    // ── Codex 通道：先给它匹配，命中即返回 ──
    // 放在前面是因为它的路由路径（/v1/responses 等）与下面的 Claude 路由完全
    // 不重叠，先匹配不会有歧义，也能让 Codex 自己的 4xx/5xx 处理逻辑完整生效。
    if (codexHandler) {
      try {
        if (await codexHandler.handle(req, res)) return
      } catch (error) {
        // 兜底：handler 内部已处理绝大多数错误，这里只接意外异常，
        // 避免一个坏请求把整个 server 的 unhandledRejection 打出来
        if (!res.headersSent) {
          sendJson(res, 500, { error: { message: error.message, type: 'internal_error' } }, { 'x-request-id': requestId })
        } else {
          res.end()
        }
        return
      }
    }

    // ── 自检面：/healthz 与 /status 不需要鉴权 ──
    // /healthz 是给探针用的固定小载荷，字段集合不能变（控制面按整体比对）。
    // /status 承载诊断信息，CLI 启动失败的具体原因挂在这里。
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, {
        status: 'ok',
        workers: 1,
        capabilities: ['multi_slot', 'native_sse', 'stateless', 'ping'],
        max_body: 64 * 1024 * 1024,
        client_channel: 'sse',
      }, { 'x-request-id': requestId })
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      return sendJson(res, 200, {
        status: 'ok',
        workers: 1,
        capabilities: ['multi_slot', 'native_sse', 'stateless', 'ping'],
        max_body: 64 * 1024 * 1024,
        client_channel: 'sse',
        // CLI 不可用时进程仍然存活：这里如实报出降级状态与最近一次错误
        cli_started: scheduler.host.started === true,
        cli_error: cliErrorPayload(scheduler),
        ready_slots: scheduler.readySlots,
      }, { 'x-request-id': requestId })
    }
    // /readyz、/internal/v1/slots、/internal/v1/envelope 属于调试面，
    // 缺省不挂载（对外一律 404），需 EXPOSE_KERNEL_DEBUG_ROUTES=1 才开放。
    // 生产环境保持关闭，避免暴露内部调度状态。
    if (exposeDebugRoutes && req.method === 'GET' && url.pathname === '/readyz') {
      // CLI 不可用也算 ready：降级模式下服务仍可对外提供状态与错误信息
      const ready = scheduler.readySlots > 0 || Boolean(scheduler.cliError)
      const payload = ready
        ? { status: 'ready', cli_started: scheduler.host.started === true }
        : { status: 'booting', reason: 'no idle slot' }
      if (scheduler.cliError) payload.cli_error = cliErrorPayload(scheduler)
      return sendJson(res, ready ? 200 : 503, payload, { 'x-request-id': requestId })
    }
    if (exposeDebugRoutes && req.method === 'GET' && url.pathname === '/internal/v1/slots') {
      return sendJson(res, 200, {
        workers: scheduler.slots.map((s) => ({
          slot_id: s.id,
          busy: s.phase !== 'idle',
          session_id: s.sessionId || null,
          idle_secs: s.startedAt ? Math.floor((Date.now() - s.startedAt) / 1000) : 0,
        })),
      }, { 'x-request-id': requestId })
    }
    if (exposeDebugRoutes && url.pathname === '/internal/v1/envelope') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          mode: getSystemLayout(),
          path: envelopePath,
          note: 'official sentence lives in billing prompt_version',
          lock: 'identity block is not written in zero mode',
        }, { 'x-request-id': requestId })
      }
      // PUT 只影响进程级环境变量，不落盘：重启后回到环境配置的布局
      if (req.method === 'PUT') {
        try {
          const patch = JSON.parse((await readBody(req, 1 << 20)) || '{}')
          if (patch.mode) process.env.CLAUDE_CODE_SYSTEM_LAYOUT = String(patch.mode)
          if (patch.timezone) process.env.CLAUDE_CODE_TIMEZONE = String(patch.timezone)
          return sendJson(res, 200, { ok: true, mode: getSystemLayout() }, { 'x-request-id': requestId })
        } catch (error) {
          return sendJson(res, 400, { error: error.message }, { 'x-request-id': requestId })
        }
      }
    }

    if (url.pathname === '/v1/messages') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'x-request-id': requestId })
        return res.end()
      }
      let payload
      try {
        payload = JSON.parse(await readBody(req, 64 * 1024 * 1024))
      } catch {
        res.writeHead(400, { 'x-request-id': requestId })
        return res.end()
      }
      // 缺 model 时回 422 + 纯文本，文案与上游反序列化错误保持一致
      if (!payload?.model) {
        const msg = 'Failed to deserialize the JSON body into the target type: missing field `model` at line 1 column 2'
        res.writeHead(422, { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': requestId })
        return res.end(msg)
      }

      const sessionId = req.headers['x-session-id'] || randomUUID()

      // 入站风险闸：必须在调度槽位之前。
      // 放在这里而不是上游返回后，是因为被拦的请求一旦派给槽位就会真实消耗
      // 账号额度并留下请求指纹；事后再拦等于额度已经花掉了。
      // 未配置时 evaluateInbound 直接放行，不产生额外开销。
      const gate = await runInboundGate({
        body: payload,
        headers: req.headers,
        model: payload.model,
        sessionId,
        cache: inboundGateCache,
      })
      if (gate.action === 'block') {
        const status = Number(gate.status) || 403
        const body = JSON.stringify(gate.body ?? {
          type: 'error',
          error: { type: gate.code || 'policy_blocked', message: gate.message || 'request blocked' },
        })
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-request-id': requestId,
          'x-risk-stage': String(gate.stage ?? ''),
          'x-risk-code': String(gate.code || ''),
        })
        return res.end(body)
      }

      // 遥测：闸门放行后才记。被拦的请求不产生上游可见行为，
      // 记进去反而会让上报的事件序列与真实发出去的数量对不上。
      // 关闭时 enqueue 是空操作。
      telemetry.enqueue([telemetry.request({ request_id: requestId, model: payload.model, session_id: sessionId })])

      // CLI 宿主可用时走真实帧驱动；不可用时跳过提交，后面的响应体走 mock 内容。
      // 这条分支保证 CLI 挂掉时接口仍然可用（返回 200 + mock），而不是直接 503。
      let submitted = scheduler.cliError ? null : scheduler.submit({
        sessionId,
        model: payload.model,
        request: payload,
        onEvent: null,
      })
      if (scheduler.cliError) {
        // 降级模式：只要求还有空闲槽位，否则仍回 503
        const idx = scheduler.slots.findIndex((s) => s.phase === 'idle')
        if (idx < 0) return sendJson(res, 503, workerError(503, 'kernel_unavailable', 'no free slot'), { 'x-request-id': requestId })
        submitted = null
      }
      if (!scheduler.cliError && !submitted) {
        return sendJson(res, 503, workerError(503, 'kernel_unavailable', 'no free slot'), { 'x-request-id': requestId })
      }

      // 出站：第 0 步组装（提示词档位 + 断点 + cch），第 1 步真发上游。
      //
      // 组装结果必须原样作为 wire 体发出：cch 是对最终字节算的哈希，
      // 在这里再动任何字段都会让计费头与正文对不上。
      // 布局与档位必须显式给：缺省会走 stock 布局，那条路径不生成
      // 计费头，cch 就失去封盖目标，出站请求缺少计费头。
      const outbound = prepareOutbound(payload, {
        systemLayout: process.env.SKYLINK_SYSTEM_LAYOUT || 'identity',
        promptProfile: process.env.SKYLINK_PROMPT_PROFILE || undefined,
        panelTtl: process.env.SKYLINK_CACHE_TTL || '1h',
      })

      const slotName = submitted ? submitted.slot : scheduler.slots[scheduler.slots.findIndex((s) => s.phase === 'idle')]?.id || 's00'

      // mock 模式仅用于无凭据的本地联调，默认关闭。
      // 开着它而忘了关，控制面看到的是一条健康的链路，实际什么都没发出去。
      if (mockMode) {
        const prompt = (payload.messages || [])
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n')
        const ctx = {
          id: `msg_${randomUUID().replace(/-/g, '')}`,
          model: payload.model,
          text: `mock response: ${prompt} [session=${sessionId}, worker=${slotName}]`,
          inputTokens: 8,
          outputTokens: 38,
          slot: slotName,
          sessionId,
          generation: 1,
        }
        if (payload.stream === true) {
          res.writeHead(200, sseHeaders(ctx, requestId))
          for (const chunk of messageStream(ctx)) res.write(chunk)
          return res.end()
        }
        return sendJson(res, 200, messageBody(ctx), messageHeaders(ctx, requestId))
      }

      // 凭据：没有 token 时不装样子，直接 401 让调用方知道要配凭据。
      const credential = resolveClaudeCredential({ env, config })
      if (!credential) {
        return sendJson(
          res,
          401,
          workerError(
            401,
            'credential_missing',
            'Claude credential is not configured (set SKYLINK_CLAUDE_TOKEN / CLAUDE_CODE_OAUTH_TOKEN, or anthropic_credential_path)',
          ),
          // x-upstream-kind 与上游返回的分支用同一套取值，控制面只需要看这一个头。
          // 本地缺凭据等价于「凭据需要刷新」，因此填 needs_refresh。
          { 'x-request-id': requestId, 'x-upstream-kind': ERROR_KIND.NEEDS_REFRESH },
        )
      }

      // 出站模式由**入站请求**决定，但上游形态恒为 SSE：
      //   - 客户端要流式 → MODE.STREAM，把上游事件原样转发；
      //   - 客户端要非流式 → MODE.AGGREGATE，本地把事件聚合成完整 message。
      // 为什么不给非流式客户端发 DOCUMENT（body 不带 stream）：官方 CLI 的
      // 每一条 Messages 请求都是流式的，非流式形态在这里属于"多出来的一个变体"。
      // 走 AGGREGATE 的好处是出站字节恒定，抓包看不出客户端要没要流。
      const wantsStream = payload.stream === true
      const mode = wantsStream ? MODE.STREAM : MODE.AGGREGATE

      // 请求头：调用方显式给的 x-* 头可以让出站覆盖默认值（例如自定义 UA），
      // 但 token 与 beta 由本层决定：token 来自凭据，beta 从 body.betas 折进头。
      const outboundHeaders = buildOutboundHeaders({
        token: credential.token,
        authScheme: credential.auth_scheme,
        betas: buildBetaHeader({ bodyBetas: outbound?.betas ?? [] }),
        accept: 'text/event-stream',
        env,
      })

      let upstream
      try {
        upstream = await anthropicUpstream.createMessage({
          body: outbound,
          headers: outboundHeaders,
          mode,
          env,
        })
      } catch (error) {
        return sendJson(
          res,
          502,
          workerError(502, 'upstream_unreachable', `upstream request failed: ${error?.message || error}`),
          { 'x-request-id': requestId },
        )
      }

      // 网络层失败（fetch 抛错 / 超时 / abort）：没有 status 可透
      if (upstream.classification?.kind === ERROR_KIND.NETWORK) {
        return sendJson(
          res,
          502,
          workerError(502, 'upstream_unreachable', upstream.classification.error || 'upstream request failed'),
          { 'x-request-id': requestId },
        )
      }

      // 非 2xx 原样透出：上游的错误体是调用方唯一能据以判断的线索，
      // 重新包装成自己的格式只会把 401/429/529 的语义抹平。
      //
      // 唯一带内部分类的头是 x-upstream-kind：控制面据此决定刷新凭据
      // （needs_refresh）还是退避（rate_limited / overloaded），
      // 而不用自己去解析错误文本。
      if (!upstream.ok) {
        const status = Number(upstream.status) || 502
        const bodyText = upstream.text ?? (upstream.json ? JSON.stringify(upstream.json) : '')
        const passthrough = {
          'content-type': upstream.headers?.['content-type'] || 'application/json',
          'content-length': Buffer.byteLength(String(bodyText)),
          'x-request-id': requestId,
          'x-upstream-status': String(status),
          'x-upstream-kind': String(upstream.classification?.kind || ''),
        }
        if (upstream.retryAfter != null) passthrough['retry-after'] = String(upstream.retryAfter)
        res.writeHead(status, passthrough)
        return res.end(String(bodyText))
      }

      // 流式：上游给的就是 SSE，逐块转发。不解码再编码——二次编码会破坏
      // 事件的原始字节，也会让上游的注释型心跳（`: ping`）丢失。
      if (wantsStream) {
        res.writeHead(200, sseHeaders({
          id: `msg_${randomUUID().replace(/-/g, '')}`,
          model: payload.model,
          slot: slotName,
          sessionId,
          generation: 1,
        }, requestId))
        try {
          for await (const chunk of upstream.stream) res.write(chunk)
        } catch (error) {
          // 已经写了 200 头，只能靠中断连接让客户端知道流不完整
          res.destroy(error)
          return
        }
        return res.end()
      }

      // 非流式：上游给的是聚合好的 message（MODE.AGGREGATE 已在客户端内完成），
      // 这里补三个 x-* 头——客户端靠它们续接会话与判定并发。
      if (upstream.json) {
        return sendJson(res, 200, upstream.json, {
          'x-request-id': requestId,
          'x-upstream-status': '200',
          'x-session-id': sessionId,
          'x-slot': slotName,
          'x-generation': '1',
        })
      }

      // 上游 2xx 但没给出可聚合的事件：不编造内容，如实报错
      return sendJson(res, 502, workerError(502, 'upstream_empty_stream',
        'upstream returned 200 but produced no message events'), { 'x-request-id': requestId })
    }

    res.writeHead(404, { 'x-request-id': requestId })
    res.end()
  })
}

// ─────────────────────────────────────── B 模式：gateway-worker
function buildGatewayWorkerServer(cfg, { claudeBin, env }) {
  const scheduler = new SlotScheduler({ claudeBin, slots: 4, env })
  scheduler.start().catch(() => {})
  const startedAt = Date.now()
  const tokenFile = `${cfg.socket_path.replace(/\/[^/]+$/, '')}/internal.token`

  // 只认 x-internal-token 一个头。其他同名变体（如 x-kin-internal-token）
  // 一律不接受，避免多个头并存时产生歧义。
  const authed = (req) => {
    const got = req.headers['x-internal-token']
    return Boolean(cfg.internal_token) && got === cfg.internal_token
  }

  return http.createServer(async (req, res) => {
    const requestId = randomUUID()
    const url = new URL(req.url, 'http://localhost')

    if (!authed(req)) {
      return sendJson(res, 401, workerError(401, 'internal_auth_failed', 'Internal worker authentication failed'))
    }

    if (url.pathname === '/internal/health' && req.method === 'GET') {
      const credState = credentialState(cfg.credential_path)
      return sendJson(
        res,
        200,
        healthPayload(cfg, {
          credentialState: credState,
          readySlots: scheduler.readySlots,
          closedSlots: scheduler.closedSlots,
          cliPid: scheduler.cliPid,
          cliRestarts: scheduler.restarts,
          cliStarted: scheduler.host.started === true,
          cliError: scheduler.cliError,
          startedAt,
        }),
      )
    }

    // cancel 目前是空实现：始终返回未取消，但保持 200 让控制面的调用不成灾
    if (url.pathname === '/internal/v1/cancel' && req.method === 'POST') {
      const raw = JSON.parse((await readBody(req, 1 << 20)) || '{}')
      return sendJson(res, 200, { cancelled: false, ok: true })
    }

    if (url.pathname === '/internal/v1/messages' && req.method === 'POST') {
      let envelope
      try {
        envelope = new Envelope(JSON.parse((await readBody(req, cfg.max_request_bytes)) || '{}'))
      } catch (error) {
        return sendJson(res, 400, workerError(400, error.code || 'invalid_request', error.message))
      }
      // 凭据缺失或已过期时直接回 401 needs_refresh，让控制面走刷新流程而不是重试
      const credState = credentialState(cfg.credential_path)
      if (credState === 'missing' || credState.startsWith('expired')) {
        return sendJson(res, 401, workerError(401, 'needs_refresh', 'credential needs refresh'))
      }
      const sessionId = extractSessionId(envelope.body) || randomUUID()
      let slotName = 's00'
      if (!scheduler.cliError) {
        const submitted = scheduler.submit({ sessionId, model: envelope.body?.model, request: envelope.body })
        if (!submitted) return sendJson(res, 503, workerError(503, 'slot_busy', 'no free slot'))
        slotName = submitted.slot
      }

      const ctx = {
        id: `msg_${randomUUID().replace(/-/g, '')}`,
        model: envelope.body.model,
        text: `gateway-worker response: ${JSON.stringify(envelope.body.messages || []).slice(0, 80)}`,
        inputTokens: 8,
        outputTokens: 38,
        slot: slotName,
        sessionId,
        generation: 1,
      }
      if (envelope.stream) {
        res.writeHead(200, sseHeaders(ctx, requestId))
        for (const chunk of messageStream(ctx)) res.write(chunk)
        return res.end()
      }
      return sendJson(res, 200, messageBody(ctx), messageHeaders(ctx, requestId))
    }

    res.writeHead(404, { 'x-request-id': requestId })
    res.end()
  })
}

/**
 * 从 metadata.user_id 里取 session_id。
 * user_id 可能是 JSON 字符串，也可能已经是对象；解析失败按"无 session"处理，
 * 由调用方生成新 session，而不是让请求失败。
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

/**
 * 凭据状态机：missing / fresh / refreshable / refresh_window / expired(_refreshable)。
 *
 * 按到期剩余时间切档：
 *   < 60s   → refresh_window（即将过期，应立即刷新）
 *   < 300s  → refreshable（可刷新）
 *   其余     → fresh
 * 已过期时有 refresh_token 记 expired_refreshable（可自愈），
 * 没有则记 expired（需要重新授权）。
 * 文件读不到或结构不对时记 missing。
 */
function credentialState(path) {
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'))
    const oauth = raw?.claudeAiOauth
    if (!oauth?.accessToken) return 'missing'
    const exp = Number(oauth.expiresAt || 0)
    const now = Date.now()
    if (!exp) return 'fresh'
    if (now >= exp) return oauth.refreshToken ? 'expired_refreshable' : 'expired'
    if (exp - now < 60_000) return 'refresh_window'
    if (exp - now < 300_000) return 'refreshable'
    return 'fresh'
  } catch {
    return 'missing'
  }
}

// ─────────────────────────────────────── 入口
function main() {
  const opts = parseArgs(argv)
  const env = process.env

  if (opts.gatewayWorker) {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(opts.config, 'utf8'))
    } catch (error) {
      throw new Error(`read worker config: ${error.message}`)
    }
    const cfg = validateWorkerConfig(raw)
    // claude_bin 的优先级在 config.mjs 的 resolveClaudeBin 里统一实现：
    // 配置文件 > 环境变量 CLAUDE_BIN > 缺省 'claude'。两者冲突时按配置文件执行。
    const resolvedBin = resolveClaudeBin({ configValue: raw?.claude_bin, env })
    if (resolvedBin.warning) {
      console.error(
        JSON.stringify({
          level: 'WARN',
          fields: { message: resolvedBin.warning, claude_bin: resolvedBin.bin, source: resolvedBin.source },
          target: 'kernel::gateway_worker::server',
        }),
      )
    }
    const claudeBin = resolvedBin.bin
    // 先建 socket 目录，再清掉遗留的 socket 文件，最后靠 listen 重建。
    // 权限在 listen 回调里改成 0600，因为文件要等 listen 之后才存在。
    fs.mkdirSync(cfg.socket_path.replace(/\/[^/]+$/, ''), { recursive: true })
    try {
      fs.unlinkSync(cfg.socket_path)
    } catch {}
    const server = buildGatewayWorkerServer(cfg, { claudeBin, env })
    server.listen(cfg.socket_path, () => {
      try {
        fs.chmodSync(cfg.socket_path, 0o600)
      } catch {}
      console.log(
        JSON.stringify({
          level: 'INFO',
          fields: {
            message: 'kernel gateway-worker listening',
            vm_id: cfg.vm_id,
            provider: cfg.runtime_kind,
            claude_bin: claudeBin,
            claude_bin_source: resolvedBin.source,
            socket: cfg.socket_path,
          },
          target: 'kernel::gateway_worker::server',
        }),
      )
    })
    return
  }

  // A 模式没有配置文件，只有环境变量与缺省值这两级
  const resolvedBin = resolveClaudeBin({ env })
  if (resolvedBin.warning) console.error(`[kernel] ${resolvedBin.warning}`)
  const claudeBin = resolvedBin.bin
  const addr = opts.addr || env.KERNEL_ADDR || '0.0.0.0:8080'
  const [host, port] = addr.split(':')

  // Codex 通道：--codex / --codex-credential / CODEX_CREDENTIAL_PATH 任一命中即挂载。
  // 凭据全部缺失时直接抛错（启动失败），而不是起一个所有请求都 503 的空壳。
  let codexHandler = null
  const codexCredential = opts.codexCredential || env.CODEX_CREDENTIAL_PATH || null
  if (opts.codex || codexCredential) {
    if (!codexCredential) throw new Error('--codex requires --codex-credential or CODEX_CREDENTIAL_PATH')
    codexHandler = createCodexHandler({
      credentialPath: codexCredential,
      defaultModel: opts.codexModel || env.CODEX_DEFAULT_MODEL,
      baseUrl: env.CODEX_BASE_URL,
    })
    console.log(
      JSON.stringify({
        level: 'INFO',
        fields: {
          message: 'codex channel enabled',
          credential: codexCredential,
          shape: codexHandler.credentialShape,
          accounts: codexHandler.accounts.length,
          default_model: codexHandler.config.codex_default_model,
        },
        target: 'kernel::codex',
      }),
    )
  }

  // A 模式没有配置文件：用环境变量拼出一份与 WorkerConfig 同形状的最小配置，
  // 让 buildPublicServer 只有一条读取路径（不出现"配置在 A 模式读不到"的分支）。
  const publicConfig = {
    mock_mode: opts.mock === true,
    anthropic_base_url: env.SKYLINK_ANTHROPIC_BASE || DEFAULT_WORKER_CONFIG.anthropic_base_url,
    anthropic_credential_path: opts.anthropicCredential || env.ANTHROPIC_CREDENTIAL_PATH || '',
    anthropic_timeout_ms:
      Number(env.SKYLINK_UPSTREAM_TIMEOUT_MS) || DEFAULT_WORKER_CONFIG.anthropic_timeout_ms,
    anthropic_compress_threshold:
      Number(env.SKYLINK_COMPRESS_THRESHOLD) || DEFAULT_WORKER_CONFIG.anthropic_compress_threshold,
  }
  const server = buildPublicServer({
    claudeBin,
    env,
    codexHandler,
    config: publicConfig,
    // 只有 --mock 显式给出时才把开关钉死为 true；否则留 undefined，
    // 让 buildPublicServer 自己去看 SKYLINK_MOCK / config.mock_mode。
    // 这里传 false 会压掉环境变量，联调时 `SKYLINK_MOCK=1 node src/server.mjs`
    // 就静默失效了。
    mock: opts.mock === true ? true : undefined,
  })
  server.listen(Number(port), host, () => {
    console.log(
      JSON.stringify({
        level: 'INFO',
        fields: {
          message: 'kernel listening',
          address: addr,
          workers: 1,
          slots_per_worker: 20,
          // provider 如实反映出站形态：mock 会把假内容当上游输出，
          // 部署后看到 provider=mock 就该知道这条链路没有真出网。
          // 判定复用 readMockFlag，不在这里重写一遍——否则 --mock 与
          // SKYLINK_MOCK=1 两条入口会给出不一致的 provider。
          provider: readMockFlag({ env, config: publicConfig, argvFlags: opts }) ? 'mock' : 'anthropic_api',
          anthropic_base_url: publicConfig.anthropic_base_url,
          anthropic_credential: publicConfig.anthropic_credential_path || 'env',
          claude_bin: claudeBin,
          claude_bin_source: resolvedBin.source,
        },
        target: 'kernel',
      }),
    )
  })
}

// 只有作为入口脚本执行时才启动；被 import 时（测试要复用 prepareOutbound）
// 不监听端口。argv[1] 在包装器（npm/pnpm 脚本）下可能是符号链接或相对路径，
// 因此两边都解析成真实路径再比；解析失败就按"不是入口"处理，不抛错。
function isEntrypoint() {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(invoked)
  } catch {
    return false
  }
}

if (isEntrypoint()) main()
