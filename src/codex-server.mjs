/**
 * 把 Codex 通道挂到 HTTP 面上。
 *
 * 职责：
 *   POST /v1/responses           —— OpenAI Responses 格式，透传上游后回流
 *   POST /v1/chat/completions    —— Chat Completions 格式，双向转换
 *   POST /v1/images/generations  —— 生图，直连上游 images 端点（不经内核）
 *   POST /v1/images/edits        —— 图片编辑，收 JSON 或 multipart
 *   GET  /v1/models              —— 上游可用模型清单（含图像模型）
 *   GET  /codex/healthz          —— 凭据与调度状态（只读，不泄露 token）
 *
 * 两种凭据模式走同一套代码路径：
 *   - 单账号文件（Codex CLI 导出的形状）→ 内部包成 1 个账号的调度器
 *   - 多账号 `{"accounts":[...]}`        → 直接进 AccountScheduler
 * 这样上层不需要分支：调度器对 1 个账号的行为和 N 个账号完全一致。
 *
 * 关键约束（踩过的坑，改之前先读 research/live/FINDINGS.md）：
 *
 * 1. **不能靠上游响应的 content-type 判断流式**。上游 SSE 响应的
 *    content-type 实测是 null，靠它判断会误判成非流式，然后对一条永不结束的
 *    事件流调 json()，表现为请求挂死到超时。本模块固定按"请求时就要了 SSE"
 *    判定，与 codex.mjs 的 CodexUpstream 保持一致。
 *
 * 2. **body 必须显式带 `stream: true`**，否则上游 400
 *    `Stream must be set to true`。这里永远以 stream=true 请求上游；
 *    客户端要非流式时，本地把事件流聚合完再一次性返回。
 *
 * 3. **不要手动设 content-length**。SSE 响应是分块下发的，手动写会截断。
 *    交给 node 用 chunked encoding。
 *
 * 4. 客户端断开要 abort 上游，否则上游会继续烧额度。
 */

import { randomUUID } from 'node:crypto'
import { AccountScheduler, executeCodexRequest, CodexUpstream } from './codex.mjs'
import { DEFAULT_CHATGPT_BASE } from './codex.mjs'
// 入站模型名重写：必须在任何按模型名分流的判定之前调用，见模块注释。
import { applyCodexModelMapping } from './codex-model-mapping.mjs'
// 额度窗口存储：按账号保存 5h / 7d 读数，reset 后惰性清零。
// Codex 侧只读复用（Claude 通道的 scheduler 用的是同一个类的另一个实例）。
import { QuotaStore } from './quota-store.mjs'
import { loadCredentials, CredentialManager, defaultLogger } from './codex-credentials.mjs'
import {
  chatToResponses, responsesEventsToChatSse, collectResponsesStream,
  responsesToChatCompletion, newChatCompletionId, chatSseFrame, CHAT_DONE_FRAME,
  SAMPLING_FIELDS, chatResponseFormatToTextFormat,
} from './codex-convert.mjs'
import { validateCodexConfig } from './config.mjs'
import {
  enabledImageModels, loadPlanTypes, withPlanTypes,
  createImageSender, handleImageGenerations, handleImageEdits,
} from './codex-images.mjs'

/** 默认模型：上游 /models 实测存在（见 FINDINGS.md） */
export const DEFAULT_CODEX_MODEL = 'gpt-6-astra'

/**
 * 对外列出的模型（与 config.mjs 的 codex_models 同一份来源）。
 *
 * 其中 `codex-auto-review` 不是上游认识的真实 id，而是入站别名：
 * 请求进来时由 codex-model-mapping.mjs 重写成 `gpt-6-luna` 再发上游。
 * 仍然列在 /v1/models 里是刻意的 —— 客户端要能发现这个别名存在。
 */
export const CODEX_MODELS = Object.freeze([
  'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-reserve', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'codex-auto-review',
])

/** 默认 body 上限，与公共 server 的其他路由一致 */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * 读取请求体。超限时 reject 并销毁连接，避免把剩余数据读完。
 */
export function readRequestBody(req, limit = DEFAULT_MAX_BODY_BYTES) {
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
 * 读取请求体，返回 Buffer。
 *
 * multipart 的图片是任意字节，先按 utf8 解成字符串再转回会损坏非法 UTF-8 序列，
 * 因此生图/编辑这两条路由必须用这个版本，不能用上面的字符串版。
 */
export function readRequestBodyRaw(req, limit = DEFAULT_MAX_BODY_BYTES) {
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
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 从 context 里挑出要透传给上游的客户端头。
 * 只透传与上游身份/路由相关的少数几个；其余一律丢弃——
 * 上游只认识这些头，多发的会改变路由或触发风控。
 */
export function pickIncomingHeaders(headers = {}) {
  const allow = [
    'session-id', 'x-codex-turn-id', 'x-codex-window-id', 'chatgpt-project-id',
    'openai-beta', 'x-codex-installation-id', 'thread-id',
  ]
  const out = {}
  for (const k of allow) {
    const v = headers[k]
    if (typeof v === 'string' && v) out[k] = v
  }
  return out
}

/** OpenAI 风格的错误体 */
export function openAiError(status, message, { type = 'invalid_request_error', code = null } = {}) {
  return { error: { message, type, param: null, code, status } }
}

/**
 * 构造 Codex HTTP 路由处理器。
 *
 * @param {object} opts
 * @param {string} opts.credentialPath 凭据文件
 * @param {string} [opts.baseUrl]      上游 base
 * @param {string} [opts.defaultModel]
 * @param {Function} [opts.fetchImpl]  注入 fetch（测试用）
 * @param {Function} [opts.refreshFn]  刷新实现注入点，见 codex-credentials.mjs
 * @param {object} [opts.logger]
 * @param {number} [opts.maxBodyBytes]
 * @param {number} [opts.maxAttempts]
 * @param {string[]|object} [opts.imageModels] 启用的图像模型（数组或 {id:{enabled}}），缺省取 codex_image_models
 * @param {number} [opts.imageTimeoutMs]  单次生图请求超时，缺省 600s
 * @param {number} [opts.imageDeadlineMs] 全池无可用号时的等待上限，缺省 30s
 * @param {object|false} [opts.quota]  额度窗口门禁：false 关闭；对象可含
 *        { enabled, warnPct, stopPct, now }。缺省走 quota-window 的 85/95 阈值
 */
export function createCodexHandler(opts = {}) {
  const cfg = validateCodexConfig({
    codex_credential_path: opts.credentialPath,
    codex_base_url: opts.baseUrl || DEFAULT_CHATGPT_BASE,
    codex_default_model: opts.defaultModel || DEFAULT_CODEX_MODEL,
    // 未显式注入时用配置里的清单；配置缺省即全启用
    ...(opts.imageModels !== undefined ? { codex_image_models: opts.imageModels } : {}),
  })
  const logger = opts.logger || defaultLogger
  const maxBodyBytes = opts.maxBodyBytes || DEFAULT_MAX_BODY_BYTES
  const maxAttempts = opts.maxAttempts || 3
  const imageModels = enabledImageModels(
    opts.imageModels !== undefined ? opts.imageModels : cfg.codex_image_models,
  )

  // 凭据加载失败在启动阶段就抛出：宁可起不来，也不要起来后每个请求都 503
  const loaded = loadCredentials(cfg.codex_credential_path, { logger })
  const manager = new CredentialManager(loaded.accounts, {
    refreshFn: opts.refreshFn || null,
    logger,
    path: loaded.path,
  })
  // 额度窗口读数。Codex 与 Claude 共用 quota-store / quota-window 这一套模型：
  // 上游的 x-codex-primary|secondary-used-percent + reset-at 与 Anthropic 的
  // unified 头被解析成同一形状的 5h / 7d 窗口，阈值判定也走同一个 accountGate。
  // 关掉的方式是传 quota: false（观察模式也可以传 { enabled: false }，
  // 头仍然记录、但不拦）。
  const quotaCfg = opts.quota && typeof opts.quota === 'object' ? opts.quota : {}
  const quotaEnabled = opts.quota !== false && quotaCfg.enabled !== false
  const quotaStore = opts.quota === false
    ? null
    : new QuotaStore({
      enabled: quotaEnabled,
      warnPct: quotaCfg.warnPct,
      stopPct: quotaCfg.stopPct,
      now: quotaCfg.now,
    })

  // 传的是读数函数而不是快照：窗口 reset 是惰性清零的，持有快照会让账号在
  // reset 之后仍被挡在门外。QuotaStore.gate 每次调用都按当前时间重算。
  const scheduler = new AccountScheduler(loaded.accounts, {
    ...(quotaCfg.now ? { now: quotaCfg.now } : {}),
    logger,
    quota: quotaStore ? { gate: (accountId) => quotaStore.gate(accountId) } : null,
  })
  const upstream = new CodexUpstream({
    baseUrl: cfg.codex_base_url,
    fetchImpl: opts.fetchImpl,
  })

  // 生图不走内核，也不走 CodexUpstream（那是 /responses 专用），单独一条发送通道。
  // 账号清单额外贴上 plan_type：Free 计划不接生图，调度前就要筛掉。
  const imageSender = createImageSender({
    baseUrl: cfg.codex_base_url,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.imageTimeoutMs,
  })
  const planTypes = loadPlanTypes(cfg.codex_credential_path)
  const imageAccounts = withPlanTypes(loaded.accounts, planTypes)

  const installationId = randomUUID()

  /**
   * 统一的请求执行：选号 → 上游 → 并发计数平衡。
   *
   * 为什么不直接按"成功/失败"释放：executeCodexRequest 只在一部分路径上 release
   * （非 2xx 时释放，2xx 时留 0 给调用方处理；重复账号 break 的路径则完全没释放）。
   * 按结果分支补 release 很容易漏掉某一条，漏掉的表现是 inflight 只增不减，
   * 最终 max_concurrency 把账号永久锁死。这里改成按差值校正：
   * 调用前后各读一次 inflight，把多出来的全部释放掉，无论中间走过哪条分支。
   */
  async function run(envelope, incomingHeaders, signal) {
    const before = new Map()
    for (const acc of scheduler.accounts) before.set(acc.id, scheduler.inflight.get(acc.id) || 0)

    const result = await executeCodexRequest({
      upstream,
      scheduler,
      accounts: loaded.accounts,
      envelope,
      installationId,
      incomingHeaders,
      maxAttempts,
      signal,
      // 每个上游响应都把配额头交给 QuotaStore：用量与 reset 时间只在响应头里，
      // 换号重试时被换掉的账号也要记，否则它带着旧读数继续参与调度。
      onResult: quotaStore
        ? ({ accountId, headers }) => {
          if (!accountId || !headers) return
          quotaStore.recordHeaders(accountId, headers)
        }
        : null,
    })

    for (const acc of scheduler.accounts) {
      let delta = (scheduler.inflight.get(acc.id) || 0) - (before.get(acc.id) || 0)
      while (delta > 0) { scheduler.release(acc.id); delta -= 1 }
    }
    return result
  }

  /**
   * 调度层自己产生的失败码：没有上游状态码可翻译，原样透出。
   *
   * 这些结果来自"没有可用账号 / 全账号都在冷却"，status 是本地决定的 503。
   * 不先拦住的话会落进下面的 5xx 分支，被改写成 502 upstream_error，
   * 与 HTTP 状态 503 互相矛盾。
   */
  const SCHEDULER_ERROR_CODES = new Set([
    'all_rejected', 'no_candidates', 'exhausted', 'no_account',
    // 额度 park 挡住全部候选：503 + quota_exhausted，与官方的号池语义一致
    'quota_exhausted',
  ])

  /** 把上游错误状态码翻译成客户端能理解的 OpenAI 错误 */
  function upstreamErrorBody(result) {
    const upstreamMsg = result.json?.detail
      || result.json?.error?.message
      || JSON.stringify(result.json || {}).slice(0, 500)
    const code = result.json?.error?.code
    if (SCHEDULER_ERROR_CODES.has(code)) {
      // 额度 park 挡住全部候选时 retryAfter 有值（窗口 reset 的秒数）：
      // 这个数字是确定的恢复时刻，必须透给客户端，否则它只能盲目重试。
      const retryAfter = Number.isFinite(result.retryAfter) ? result.retryAfter : null
      return {
        error: {
          message: result.json.error.message || 'no account can serve this request',
          type: 'service_unavailable_error',
          param: null,
          code,
          status: 503,
          ...(retryAfter != null ? { retry_after: retryAfter } : {}),
        },
      }
    }
    if (result.status === 401 || result.status === 403) {
      return openAiError(result.status, `upstream rejected credential: ${upstreamMsg}`, {
        type: 'authentication_error', code: 'upstream_unauthorized',
      })
    }
    if (result.status === 429) {
      // 429 是"限流"语义的唯一出口，必须让客户端拿到退避依据：
      //   - 响应头 Retry-After（HTTP 标准位置）
      //   - 响应体 error.retry_after（OpenAI 客户端里字段更顺手）
      // 两处同源，都取 result.retryAfter（executeCodexRequest 已归一到最短冷却）。
      const retryAfter = Number.isFinite(result.retryAfter) ? result.retryAfter : null
      return {
        error: {
          message: `upstream rate limited: ${upstreamMsg}`,
          type: 'rate_limit_error',
          param: null,
          code: 'rate_limited',
          status: 429,
          ...(retryAfter != null ? { retry_after: retryAfter } : {}),
        },
      }
    }
    if (result.status === 400 || result.status === 422) {
      return openAiError(result.status, upstreamMsg, { code: 'upstream_invalid_request' })
    }
    if (result.status >= 500) {
      return openAiError(502, `upstream error ${result.status}: ${upstreamMsg}`, {
        type: 'api_error', code: 'upstream_error',
      })
    }
    return openAiError(result.status || 502, upstreamMsg || 'upstream failed', { type: 'api_error' })
  }

  /**
   * 错误响应要带的头：上游诊断头 + 429 时的 Retry-After。
   *
   * Retry-After 只用秒数形态（不带 HTTP-date）：客户端 SDK 对整数的处理最一致，
   * 而且上游给的就是"剩余秒数"，换算成日期反而引入时钟偏差。
   */
  function upstreamErrorHeaders(result) {
    const h = upstreamHeadersFor(result)
    // 429（上游限流）与 503（额度 park 到窗口 reset）都带确定的恢复时长。
    // 403/401 这类没有退避语义的状态不带，避免客户端对一个永久失败反复重试。
    if ((result.status === 429 || result.status === 503) && Number.isFinite(result.retryAfter)) {
      h['Retry-After'] = String(result.retryAfter)
    }
    return h
  }

  /**
   * 被丢弃参数的对外回显。
   *
   * 静默丢弃是上一次踩过的坑：客户端把 temperature 传进来，拿到的结果与参数无关，
   * 却没有任何信号。响应头让"参数被忽略"这件事对客户端可见，
   * stderr 的 WARN 日志让运维侧也能看到（响应头只到请求方）。
   */
  function announceDropped(dropped, { model, route }) {
    if (!dropped.length) return {}
    logger.warn(
      { dropped, model, route },
      `request dropped unsupported parameters: ${dropped.join(',')}`,
    )
    return { 'X-Dropped-Params': dropped.join(',') }
  }

  /**
   * 从 Responses 请求体里摘掉上游不认的采样字段，返回被摘掉的字段名。
   *
   * 只在 Responses 路由用：Chat 路由由 chatToResponses 完成同样的判定。
   * 就地删除，因为 handler 紧接着就要把这个对象交给 executeCodexRequest。
   */
  function stripUnsupportedSampling(body) {
    const removed = []
    for (const field of SAMPLING_FIELDS) {
      if (body[field] !== undefined) {
        removed.push(field)
        delete body[field]
      }
    }
    return removed
  }

  /**
   * 顶层 `response_format` / `verbosity` → `text.{format,verbosity}`。
   *
   * 这两个字段上游只在 `text` 对象里认（顶层一律 400 Unsupported parameter），
   * 而不少客户端把 Chat 的扁平写法直接发到 Responses 路由上。
   * 已经显式给了 `text.format` / `text.verbosity` 时以客户端为准，不覆盖。
   */
  function hoistTextFields(body) {
    const hasFormat = body.response_format !== undefined
    const hasVerbosity = typeof body.verbosity === 'string' && body.verbosity
    if (!hasFormat && !hasVerbosity) return
    const text = body.text && typeof body.text === 'object' && !Array.isArray(body.text)
      ? { ...body.text }
      : {}
    if (hasFormat && text.format === undefined) {
      const format = chatResponseFormatToTextFormat(body.response_format)
      if (format) text.format = format
    }
    if (hasVerbosity && text.verbosity === undefined) text.verbosity = body.verbosity
    delete body.response_format
    delete body.verbosity
    if (Object.keys(text).length) body.text = text
  }

  /**
   * 请求前的凭据门禁。
   *
   * 过期且无法刷新时直接拒绝，不要拿死 token 打上游：
   * 上游会回 401，调度器把账号打进冷却，客户端拿到"认证失败"——
   * 三步都在描述同一个事实，但没人告诉调用方"该去刷新凭据了"。
   * 这里提前返回 401 + needs_refresh，与 server.mjs 的 B 模式语义一致。
   *
   * @returns {boolean} true 表示已放行，false 表示已写 401 响应
   */
  function guardCredential(res) {
    const snap = manager.snapshot()
    // expired_refreshable 只表示"有 refresh_token"，只有真的注入了 refreshFn
    // 才算可用。否则它是一个发不出请求的死号，放行等于让上游回 401。
    const usable = snap.filter((a) => a.state === 'fresh'
      || a.state === 'refreshable'
      || a.state === 'refresh_window'
      || (a.state === 'expired_refreshable' && manager.canRefresh))
    if (usable.length === 0) {
      sendJson(res, 401, openAiError(
        401,
        'codex credential expired and cannot be refreshed '
        + '(no refreshFn injected; OAuth PKCE flow required)',
        { type: 'authentication_error', code: 'needs_refresh' },
      ))
      return false
    }
    // 快到期（refresh_window / refreshable）时打 warning，便于提前介入人工刷新
    for (const a of usable) {
      if (a.state === 'refresh_window' || a.state === 'refreshable') {
        logger.warn(
          { account: a.id, credential_state: a.state, seconds_left: a.seconds_left },
          'codex credential is close to expiry',
        )
      }
    }
    return true
  }

  /** 上游诊断信息回写成响应头，方便排查额度/计划 */
  function upstreamHeadersFor(result) {
    const h = {}
    for (const [k, v] of Object.entries(result.headers || {})) {
      if (k.startsWith('x-codex-') && k !== 'x-codex-turn-state') h[k] = v
    }
    return h
  }

  /** 写 SSE 头。不设 content-length：分块下发由 node 自己处理。 */
  function writeSseHead(res, extra = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 关掉中间代理的缓冲，否则事件会被攒成一批才下发
      'x-accel-buffering': 'no',
      ...extra,
    })
  }

  function sendJson(res, status, obj, headers = {}) {
    const body = Buffer.from(JSON.stringify(obj))
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers })
    res.end(body)
  }

  /**
   * POST /v1/responses —— 天然同构，直接把 Responses body 转发上游。
   *
   * 客户端给的就是 Responses 请求体，所以不做字段改写了；
   * 上游必需的 stream/store 由 buildOutboundBody 统一补。
   */
  async function handleResponses(req, res, url) {
    let payload
    try {
      payload = JSON.parse((await readRequestBody(req, maxBodyBytes)) || '{}')
    } catch (e) {
      return sendJson(res, 400, openAiError(400, `invalid JSON body: ${e.message}`))
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return sendJson(res, 400, openAiError(400, 'body must be a JSON object'))
    }
    if (!guardCredential(res)) return

    const wantsStream = payload.stream !== false
    // 入站模型名重写必须发生在任何按模型名分流的判定之前：
    // `codex-auto-review` 是别名，直发上游会 400 并白白占掉一个账号的坑位。
    const requestedModel = payload.model || cfg.codex_default_model
    const model = applyCodexModelMapping(requestedModel)
    if (model !== requestedModel) {
      logger.info(
        { route: '/v1/responses', requested_model: requestedModel, upstream_model: model },
        'codex inbound model rewritten',
      )
    }
    const body = { ...payload, model }

    // Responses 请求体里也可能带上游不认的采样字段（很多客户端把 Chat 的字段
    // 顺手发到 Responses 路由上）。与 Chat 路径共用一套回显，免得同一个
    // "参数被忽略但没人知道"的问题在两条路由上重复出现。
    const dropped = stripUnsupportedSampling(body)
    hoistTextFields(body)
    const droppedHeaders = announceDropped(dropped, { model, route: '/v1/responses' })

    const sessionId = pickSessionId(req, payload)
    const envelope = {
      body,
      session: sessionId ? { session_id: sessionId } : null,
      stream: true, // 上游硬性要求
      options: null,
      previous_response_id: payload.previous_response_id ?? null,
      session_id: sessionId,
    }

    const ctrl = new AbortController()
    res.on('close', () => ctrl.abort())

    let result
    try {
      result = await run(envelope, pickIncomingHeaders(req.headers), ctrl.signal)
    } catch (e) {
      return sendJson(res, 502, openAiError(502, `upstream request failed: ${e.message}`, { type: 'api_error' }))
    }
    if (result.status < 200 || result.status >= 300) {
      return sendJson(res, result.status, upstreamErrorBody(result), {
        ...droppedHeaders, ...upstreamErrorHeaders(result),
      })
    }
    if (!result.stream) {
      // 非预期：上游给了 JSON。直接回流，保持格式一致。
      return sendJson(res, 200, result.json || {}, { ...droppedHeaders, ...upstreamHeadersFor(result) })
    }

    const events = upstream.iterEvents(result.stream)

    if (!wantsStream) {
      const response = await collectResponsesStream(events)
      return sendJson(res, 200, response, { ...droppedHeaders, ...upstreamHeadersFor(result) })
    }

    writeSseHead(res, { ...droppedHeaders, ...upstreamHeadersFor(result) })
    try {
      for await (const ev of events) {
        const name = ev.event || ev.data?.type || 'message'
        const data = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data)
        res.write(`event: ${name}\ndata: ${data}\n\n`)
      }
    } catch (e) {
      // 流中途出错：已经写了 200 头，只能发一个 error 事件收尾
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: openAiError(502, e.message).error })}\n\n`)
    }
    return res.end()
  }

  /**
   * POST /v1/chat/completions —— Chat 格式进出，内部做完双向转换。
   */
  async function handleChatCompletions(req, res) {
    let chat
    try {
      chat = JSON.parse((await readRequestBody(req, maxBodyBytes)) || '{}')
    } catch (e) {
      return sendJson(res, 400, openAiError(400, `invalid JSON body: ${e.message}`))
    }
    if (!chat || typeof chat !== 'object' || Array.isArray(chat)) {
      return sendJson(res, 400, openAiError(400, 'body must be a JSON object'))
    }
    if (!Array.isArray(chat.messages)) {
      return sendJson(res, 400, openAiError(400, '`messages` is required and must be an array'))
    }
    if (!guardCredential(res)) return

    const wantsStream = chat.stream === true
    // 同 Responses 路由：先重写别名，再进转换与调度
    const requestedModel = chat.model || cfg.codex_default_model
    const model = applyCodexModelMapping(requestedModel)
    if (model !== requestedModel) {
      logger.info(
        { route: '/v1/chat/completions', requested_model: requestedModel, upstream_model: model },
        'codex inbound model rewritten',
      )
    }
    const converted = chatToResponses({ ...chat, model })
    // 丢弃的采样字段要对外可见：响应头给客户端，WARN 日志给运维侧。
    const droppedHeaders = announceDropped(converted.dropped, { model, route: '/v1/chat/completions' })

    const sessionId = pickSessionId(req, chat)
    const envelope = {
      body: converted.body,
      session: sessionId ? { session_id: sessionId } : null,
      stream: true,
      options: null,
      previous_response_id: null,
      session_id: sessionId,
    }

    const ctrl = new AbortController()
    res.on('close', () => ctrl.abort())

    let result
    try {
      result = await run(envelope, pickIncomingHeaders(req.headers), ctrl.signal)
    } catch (e) {
      return sendJson(res, 502, openAiError(502, `upstream request failed: ${e.message}`, { type: 'api_error' }))
    }
    if (result.status < 200 || result.status >= 300) {
      return sendJson(res, result.status, upstreamErrorBody(result), {
        ...droppedHeaders, ...upstreamErrorHeaders(result),
      })
    }

    if (!result.stream) {
      // 上游给了 JSON 而不是事件流：同样要把丢弃信息带出去
      return sendJson(res, 200, result.json || {}, { ...droppedHeaders, ...upstreamHeadersFor(result) })
    }

    const events = upstream.iterEvents(result.stream)
    const completionId = newChatCompletionId()
    const created = Math.floor(Date.now() / 1000)

    if (!wantsStream) {
      const response = await collectResponsesStream(events)
      const completion = responsesToChatCompletion(response, { model, created, id: completionId })
      return sendJson(res, 200, completion, { ...droppedHeaders, ...upstreamHeadersFor(result) })
    }

    // usage 缺省带上：客户端 SDK 会忽略未知字段，而排查额度时它是唯一的来源。
    // 客户端显式 stream_options.include_usage=false 时尊重客户端。
    const includeUsage = chat.stream_options?.include_usage !== false

    writeSseHead(res, {
      ...droppedHeaders, ...upstreamHeadersFor(result), 'x-request-id': randomUUID(),
    })
    try {
      for await (const frame of responsesEventsToChatSse(events, {
        model, id: completionId, created, includeUsage,
      })) {
        res.write(frame)
      }
    } catch (e) {
      res.write(chatSseFrame({
        error: { type: 'api_error', code: 'stream_error', message: e.message },
      }))
      res.write(CHAT_DONE_FRAME)
    }
    return res.end()
  }

  /**
   * POST /v1/images/{generations,edits}
   *
   * 上游是 `chatgpt.com/backend-api/codex/images/*`，与 /responses 同宿主不同路径。
   * 内核二进制里没有生图符号（`images/generations`、`image_generation`、
   * `gpt-image` 全部 0 命中），所以这条链路只能在 Node 层直连上游，
   * 请求体原样透传——不做 Responses 那套 store/stream/client_metadata 改写。
   *
   * 三个只在生图上成立的约定：
   *   1. Free 计划不接生图 → 403 image_generation_unavailable（在 runImages 里判）
   *   2. 客户端给 `x-codex-image-turn-id` 时，用它做粘性键并原样回传上游，
   *      让同一轮编辑固定在同一槽位
   *   3. 生图是长跑（分钟级），超时给到 600s，客户端断开要 abort 上游
   */
  async function handleImages(req, res, kind) {
    const ctrl = new AbortController()
    res.on('close', () => ctrl.abort())

    let raw
    try {
      raw = await readRequestBodyRaw(req, maxBodyBytes)
    } catch (e) {
      const status = e.code === 'too_large' ? 413 : 400
      return sendJson(res, status, openAiError(status, `cannot read request body: ${e.message}`))
    }

    if (!guardCredential(res)) return

    const sessionId = typeof req.headers['x-codex-image-turn-id'] === 'string'
      ? `codex-image-turn:${req.headers['x-codex-image-turn-id']}`
      : null
    const base = {
      headers: req.headers,
      scheduler,
      accounts: imageAccounts,
      send: imageSender,
      imageModels,
      deadlineMs: opts.imageDeadlineMs,
      signal: ctrl.signal,
    }

    let result
    try {
      if (kind === 'generations') {
        let body
        try {
          body = JSON.parse(raw.toString('utf8') || '{}')
        } catch (e) {
          return sendJson(res, 400, openAiError(400, `invalid JSON body: ${e.message}`, { code: 'invalid_json' }))
        }
        result = await handleImageGenerations({ ...base, body })
      } else {
        result = await handleImageEdits({ ...base, raw, contentType: req.headers['content-type'] })
      }
    } catch (e) {
      return sendJson(res, 502, openAiError(502, `image upstream request failed: ${e.message}`, {
        type: 'api_error', code: 'upstream_transport',
      }))
    }

    // 客户端已断开：上游已经 abort、占坑也已经归还，这里只需把连接收尾。
    // 不再写 JSON 体（对端已经不读），但要 end，避免这个响应对象一直被挂着。
    if (result.cancelled || res.writableEnded) {
      if (!res.writableEnded) res.end()
      return
    }

    // 生图响应同样带 x-codex-* 用量头，一样要进额度存储：
    // 生图消耗的是同一份额度，漏记会让 5h 窗口的读数偏乐观。
    if (quotaStore && result.accountId && result.headers) {
      quotaStore.recordHeaders(result.accountId, result.headers)
    }
    logger.info(
      { route: `images.${kind}`, status: result.status, attempts: result.attempts, session: sessionId },
      'codex images request',
    )
    return sendJson(res, result.status, result.body, imageResponseHeaders(result.headers))
  }

  /**
   * 上游 images 响应头里只回传 x-codex-* 诊断字段。
   * `x-codex-turn-state` 是 Responses 多轮状态，生图没有这个概念，一并剔除。
   */
  function imageResponseHeaders(upstreamHeaders = {}) {
    const h = {}
    for (const [k, v] of Object.entries(upstreamHeaders)) {
      if (k.startsWith('x-codex-') && k !== 'x-codex-turn-state') h[k] = v
    }
    return h
  }

  /**
   * GET /v1/models
   *
   * 图像模型与对话模型同列在一个 list 里，靠 `owned_by: 'openai-image'` 区分。
   * 客户端按前缀猜模型家族的做法不可靠（`gpt-image-*` 也是 gpt- 开头），
   * 给一个显式的归属字段比让调用方字符串匹配更稳。
   */
  function handleModels(req, res) {
    const created = Math.floor(Date.now() / 1000)
    return sendJson(res, 200, {
      object: 'list',
      data: [
        ...CODEX_MODELS.map((id) => ({
          id, object: 'model', created, owned_by: 'openai',
        })),
        ...imageModels.map((id) => ({
          id, object: 'model', created, owned_by: 'openai-image',
        })),
      ],
    })
  }

  /**
   * GET /codex/healthz —— 只读状态；绝不返回 token 内容。
   *
   * "可用"的判定必须考虑刷新能力：`expired_refreshable` 只是"有 refresh_token、
   * 理论上可救"，如果没有注入 refreshFn，这个账号实际发不出请求。
   * 只按 state 名判断会给出 200 的假健康，把问题推到第一个真实请求上。
   */
  /**
   * 手动刷新额度 park。
   *
   * 为什么要有这个端点：自动复查只在有请求进来时发生，
   * 没有流量时被 park 的号会一直等到 reset。上游窗口可能提前重置，
   * 运维也可能刚调过配额 —— 这时候需要一个能主动触发的入口。
   */
  function handleQuotaRefresh(req, res) {
    const result = typeof scheduler.refreshQuotaParks === 'function'
      ? scheduler.refreshQuotaParks()
      : { checked: 0, resumed: [], stillParked: [], unsupported: true }
    // 刷新后把最新视图一起返回，省一次请求
    return sendJson(res, 200, {
      ...result,
      quota: typeof scheduler.quotaSnapshot === 'function' ? scheduler.quotaSnapshot() : null,
      accounts: manager.snapshot(),
    })
  }

  function handleHealth(req, res) {
    const snap = manager.snapshot()
    const usable = (state) => state === 'fresh' || state === 'refreshable' || state === 'refresh_window'
      || (state === 'expired_refreshable' && manager.canRefresh)
    const healthy = snap.some((a) => usable(a.state))
    return sendJson(res, healthy ? 200 : 503, {
      status: healthy ? 'ok' : 'needs_refresh',
      shape: loaded.shape,
      base_url: cfg.codex_base_url,
      default_model: cfg.codex_default_model,
      can_refresh: manager.canRefresh,
      accounts: snap,
      scheduler: scheduler.snapshot(),
      // 额度窗口快照：哪个号被打满、park 多久、几点恢复，都在这里看
      quota: quotaStore ? quotaStore.snapshot() : { enabled: false, accounts: [] },
      quota_park: scheduler.quotaSnapshot(),
    })
  }

  /**
   * 路由分发。返回 true 表示已处理，false 交给上层继续匹配。
   */
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname

    if (p === '/v1/models') {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return true
      }
      handleModels(req, res)
      return true
    }
    if (p === '/codex/healthz') {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return true
      }
      handleHealth(req, res)
      return true
    }
    if (p === '/codex/quota/refresh') {
      // POST：有副作用（会解除 park），不用 GET 避免被爬虫/预取误触发
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return true
      }
      handleQuotaRefresh(req, res)
      return true
    }
    if (p === '/v1/responses') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return true
      }
      await handleResponses(req, res, url)
      return true
    }
    if (p === '/v1/chat/completions') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return true
      }
      await handleChatCompletions(req, res)
      return true
    }
    if (p === '/v1/images/generations') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return true
      }
      await handleImages(req, res, 'generations')
      return true
    }
    if (p === '/v1/images/edits') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return true
      }
      await handleImages(req, res, 'edits')
      return true
    }
    return false
  }

  return {
    handle,
    scheduler,
    manager,
    upstream,
    quotaStore,
    config: cfg,
    accounts: loaded.accounts,
    imageAccounts,
    imageModels,
    credentialShape: loaded.shape,
  }
}

/**
 * session id 优先级：头 > body 里显式给的。都没有就返回 null，
 * 由调度器走"首个可用"而不是硬造一个 session（硬造会让每次请求都是新会话，
 * 亲和永远建立不起来）。
 */
function pickSessionId(req, payload = {}) {
  const fromHeader = req.headers['session-id'] || req.headers['x-session-id']
  if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim()
  const fromBody = payload.session_id || payload.user
  if (typeof fromBody === 'string' && fromBody.trim()) return fromBody.trim()
  return null
}
