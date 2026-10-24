/**
 * 内核 HTTP 契约：vm2api 控制面 ↔ 我们的内核之间那一条缝的逐字段定义。
 *
 * 这份文件的唯一权威来源是 vm2api 的客户端代码，不是文档、不是猜测：
 *   src/lib/transport/go-worker-client.mjs      ← 真正的请求构造与响应解析都在这里
 *   src/lib/transport/rust-kernel-client.mjs   ← Claude 侧薄封装（socket=run/kernel.sock）
 *   src/lib/transport/codex-kernel-client.mjs  ← Codex 侧薄封装（socket=run/codex-kernel.sock）
 *   src/lib/transport/rust-kernel-supervisor.mjs ← 启动/就绪判定
 *
 * 几个从代码里读出来、但看文档绝对猜不到的事实：
 *
 * 1. 端点一共只有 4 个是真正走 socket 的：health / messages / cancel / codex/responses。
 *    `/internal/v1/models` 在 callWorkerGet 里被特判成
 *    `runSlotOauth(exec, 'models')`，也就是 `docker exec ... kin-worker oauth models`
 *    的 stdout JSON，**不经过内核 socket**。我们仍然实现它（面板/调试要用），
 *    但要清楚它不在替换的关键路径上。
 *
 * 2. 认证头有两个，且客户端每次都同时发：`x-kin-internal-token`（新名字，
 *    Rust/Codex 内核用）与 `x-internal-token`（旧名字，Go worker 用），值相同。
 *    只认后者会让真正的 vm2api 调用全部 401。
 *
 * 3. `request_id` 不是 envelope 的固有一部分，而是 callGoWorker 在发请求前
 *    现生成一个 UUID 塞进 body。客户端 abort 时用同一个 id 调
 *    `/internal/v1/cancel`，所以内核侧必须按这个 id 建立 job 映射，
 *    自己另生成一个 jobId 会让 cancel 永远打不中。
 *
 * 4. Codex 的 envelope 与 Claude 的 envelope 是两套字段集合。Claude 走
 *    workerEnvelope（body/headers/stream/delivery_mode/preserve_cache_breakpoints/
 *    cache_ttl），Codex 由 handle-codex 直接拼（body/headers/stream/session/options）。
 *    用同一套 schema 校验两边会漏字段。
 *
 * 5. 就绪判定的硬门槛是 `ready_slots > 0`（rustKernelCliReady）。ready_slots
 *    缺省（null/undefined）被当作 ready，0 被当作 busy —— 一个只报 ok:true
 *    但 ready_slots:0 的内核永远等不到 supervisor 的 started。
 *
 * 6. supervisor 没有任何版本握手。`version` / `worker_version` / `engine` 只被
 *    toPublicKernelHealth 读出来展示，不参与任何比较。所谓"伪装"只有两件事：
 *    `engine` 报 'rust'（控制面据此区分实现来源），以及 health 的字段集合齐全。
 */

/** 帧协议版本，与 src/frames.mjs 的 PROTOCOL_VERSION 同源（CLI 侧帧协议，不是 HTTP 协议）。 */
export const KERNEL_PROTOCOL_VERSION = 2

/**
 * 内核版本字符串。
 *
 * 控制面不比较它，只把它透出到面板。取值形态跟随 vm2api 自己的
 * `worker_version: 'wrap-1'` 风格：短、可辨识、不带 semver 语义，
 * 避免被误当成需要严格匹配的握手版本。
 */
export const KERNEL_VERSION = 'node-kernel-1'
export const KERNEL_WORKER_VERSION = 'node-kernel-1'

/**
 * 认证头。客户端两个都发；内核两个都收。
 *
 * 顺序即优先级：名字空间化的头优先，取不到再退回旧的。
 */
export const KERNEL_AUTH_HEADERS = Object.freeze(['x-kin-internal-token', 'x-internal-token'])

/**
 * 客户端在非流式 hop 上会读、并原样回传给客户端的响应头。
 *
 * - `x-terminal-state`：终态标记（verified / rejected / incomplete / transport_error），
 *   callGoWorker 把它塞进 result.terminalState。
 * - `x-rate-limit-headers`：JSON 字符串，publicHeaders 取出后由
 *   mergeRateLimitHeaders 展开成 anthropic-ratelimit-unified-* 一族。
 *   内核不透出就等于告诉调用方"上游没有任何额度信息"。
 */
export const KERNEL_RESPONSE_HEADERS = Object.freeze([
  'x-terminal-state',
  'x-rate-limit-headers',
  'x-session-id',
  'x-slot',
  'x-generation',
  'x-request-id',
])

/**
 * Trailer 头：流式 hop 结束后由 mergeRateLimitHeaders(publicHeaders(res.trailers)) 读取。
 * 客户端明确请求 `te: trailers`，内核不发就是缺 meta（usage/model/stopReason 会退到 SSE 内联值）。
 */
export const KERNEL_TRAILER_HEADERS = Object.freeze([
  'x-kin-usage',
  'x-kin-model',
  'x-kin-stop-reason',
  'x-rate-limit-headers',
])

/**
 * Claude envelope 的字段集合（go-worker-client 的 workerEnvelope 产出 + request_id 注入）。
 *
 * 除 `body` 外没有必填项，但客户端一定会写 stream / delivery_mode /
 * preserve_cache_breakpoints / cache_ttl —— 它们由 Envelope 类（src/config.mjs）
 * 读取，缺键会走缺省值，因此内核侧要能容忍缺失。
 */
export const CLAUDE_ENVELOPE_FIELDS = Object.freeze([
  'request_context',
  'body',
  'headers',
  'stream',
  'delivery_mode',
  'preserve_cache_breakpoints',
  'cache_ttl',
  'request_id',
])

/**
 * Codex envelope 的字段集合（handle-codex 直接构造，见 src/lib/protocol/handle-codex.mjs）。
 *
 * 与 Claude 的关键差异：没有 delivery_mode / cache_ttl / preserve_cache_breakpoints，
 * 多了 session 与 options；`stream` 恒为 true（上游硬性要求）。
 */
export const CODEX_ENVELOPE_FIELDS = Object.freeze([
  'body',
  'headers',
  'stream',
  'session',
  'options',
  'previous_response_id',
  'session_id',
  'request_id',
])

/** request.options 的五个子字段（codexKernelRequestOptions + installation_id）。 */
export const CODEX_OPTIONS_FIELDS = Object.freeze([
  'upstream_transport',
  'user_agent',
  'client_features',
  'analytics',
  'installation_id',
])

/**
 * 端点契约表。
 *
 * 每个条目描述：method / path / 请求形状 / 响应形状 / 允许的状态码。
 * `validateAgainstContract` 直接读这张表，因此改这里就是改唯一的校验源。
 */
export const KERNEL_ENDPOINTS = Object.freeze({
  /**
   * 就绪与状态。supervisor 每 80ms 轮询一次，单次超时预算 400~800ms。
   *
   * 响应体字段的消费点（按读取顺序）：
   *   workerHealth → ok（要求 HTTP 200 且 body.ok === true）
   *   rustKernelProcessUp → ok / status / engine / worker_version
   *   rustKernelCliReady → ready_slots（null 视为 ready，0 视为 busy）
   *   toPublicKernelHealth → status / worker_version / version / engine / provider /
   *                          ready_slots / closed_slots / cli_restarts / recovering /
   *                          healthy / unhealthy_reason / cli_pid
   *   rustKernelBusy → healthy / recovering / ready_slots / cli_pid
   *   kernelJobsRunning → ready_slots / closed_slots（配合 kernel.json 的 slots_per_worker）
   */
  health: {
    method: 'GET',
    path: '/internal/health',
    auth: true,
    requestBody: null,
    responseFields: Object.freeze([
      ['ok', 'boolean', 'HTTP 200 且 ready_slots>0 时为 true；supervisor 用它判 ready'],
      ['status', 'number', '与 HTTP 状态码一致，rustKernelProcessUp 的兜底判据'],
      ['engine', 'string', "固定 'rust'，控制面据此区分实现来源"],
      ['healthy', 'boolean', 'false 表示内核自己已放弃恢复，watchdog 才会重启容器'],
      ['ready_slots', 'number', '空闲槽数。0 = 满载（不是死亡），缺省 = ready'],
      ['closed_slots', 'number', '已关闭/异常槽数，kernelJobsRunning 用来推算在途 job'],
      ['cli_pid', 'number|null', 'CLI 宿主 pid。监督逻辑靠它区分 busy 与 wedged'],
      ['cli_restarts', 'number', 'CLI 重启次数（诊断用）'],
      ['cli_started', 'boolean', '是否收到过 host_ready'],
      ['cli_error', 'object|null', 'CLI 失败时的 {code,bin,reason,message}'],
      ['cli_version', 'string|null', '来自 kernel.json，透出到面板'],
      ['recovering', 'boolean', '内核正在自恢复 CLI。控制面据此把槽当 busy 而不是死的'],
      ['unhealthy_reason', 'string|null', '放弃恢复的原因，watchdog 把它写进 fault'],
      ['provider', 'string', "kernel.json 的 runtime_kind，如 'local_cli'"],
      ['worker_version', 'string', '面板展示；也参与 rustKernelProcessUp 的兜底判定'],
      ['version', 'string', '同上，旧字段名'],
      ['vm_id', 'string', '槽位标识'],
      ['runtime_kind', 'string', '与 provider 同值'],
      ['delivery_mode', 'string', "'realtime' | 'verified'"],
      ['credential_state', 'string', 'missing / fresh / refreshable / window / expired...'],
      ['proxy_configured', 'boolean', ''],
      ['proxy_required', 'boolean', ''],
      ['uptime_seconds', 'number', ''],
      ['classifier_request_context', 'boolean', ''],
    ]),
    status: Object.freeze([200, 401, 503]),
  },

  /**
   * Claude 推理。唯一的业务大端点。
   *
   * 请求体 = Claude envelope（见 CLAUDE_ENVELOPE_FIELDS）。
   * 响应：
   *   - 流式（envelope.stream === true）：SSE，Anthropic Messages 事件序列。
   *     客户端把每行原样转给下游，同时自己 assemble 一份 message 用于判 complete：
   *     必须看到 `message_stop`（`sawMessageStop`），否则即使有 stop_reason 也可能判 incomplete。
   *   - 非流式：JSON，Anthropic Message（`type:'message'`，`content` 数组，`usage`）。
   *   - 失败：非 2xx + `{type:'error', error:{type, code, message}}`。
   *
   * 状态码语义（restoreKernelErrorStatus / restoreUncommittedHop 会重写一部分）：
   *   401 needs_refresh → 控制面走刷新流程，不重试
   *   402/403/429/529 → 账号/额度状态，FailoverRunner 换号
   *   502 provider_error → 被 map_kernel 折叠的上游失败
   *   503 slot_busy → 槽满，不换号只等待
   */
  messages: {
    method: 'POST',
    path: '/internal/v1/messages',
    auth: true,
    requestFields: CLAUDE_ENVELOPE_FIELDS,
    requestRequired: Object.freeze(['body']),
    responseFields: Object.freeze([
      ['type', 'string', "成功为 'message'，失败为 'error'"],
      ['role', 'string', "成功固定 'assistant'"],
      ['model', 'string', '回显实际模型'],
      ['content', 'array', '成功时为内容块数组'],
      ['stop_reason', 'string|null', ''],
      ['stop_sequence', 'string|null', ''],
      ['usage', 'object', 'input_tokens / output_tokens 等'],
      ['error', 'object', '失败时 {type, code, message}'],
      ['id', 'string', "msg_ 前缀"],
    ]),
    status: Object.freeze([200, 400, 401, 402, 403, 404, 413, 422, 429, 500, 502, 503, 529]),
  },

  /**
   * 模型清单。
   *
   * 注意：真实 vm2api 在 callWorkerGet 里把这条路特判成 docker exec 的
   * `kin-worker oauth models`，不经 socket。形状取自 runSlotOauth 的
   * payload.body 与 mock 分支：Anthropic 的 `{object:'list', data:[...]}`。
   * 我们实现它是为了面板/自检可用，且保持万一上游改回 hop 时形状一致。
   */
  models: {
    method: 'GET',
    path: '/internal/v1/models',
    auth: true,
    requestBody: null,
    responseFields: Object.freeze([
      ['object', 'string', "固定 'list'"],
      ['data', 'array', '每项 {id, object, owned_by, created?}'],
    ]),
    status: Object.freeze([200, 401, 502]),
  },

  /**
   * 取消在途 job。
   *
   * 请求体只有 `{request_id}`（cancelOnAbort 构造），`request_id` 就是
   * callGoWorker 塞进 messages envelope 的那个 UUID。
   * 客户端**不读响应体**，只 `res.resume()`；因此响应体形状自由，
   * 但状态码必须可解析（旧 worker 回 404 是合法的"没有这条路"）。
   */
  cancel: {
    method: 'POST',
    path: '/internal/v1/cancel',
    auth: true,
    requestFields: Object.freeze(['request_id']),
    requestRequired: Object.freeze(['request_id']),
    responseFields: Object.freeze([
      ['ok', 'boolean', '请求处理本身成功（不代表真的取消到了 job）'],
      ['cancelled', 'boolean', '是否命中在途 job'],
      ['request_id', 'string', '回显'],
    ]),
    status: Object.freeze([200, 400, 401, 404]),
  },

  /**
   * Codex 推理（Responses 协议）。
   *
   * envelope 由 handle-codex 直接构造，stream 恒 true（上游硬性要求 stream）。
   * 响应是 Responses 事件流（`event: response.completed` 等），
   * 客户端判 delivered 的依据是「2xx 且 usage token > 0」，
   * 所以 response.completed 里必须带 usage —— 只发文本不给 usage 会被当失败。
   * trailer 的 X-Kin-Usage 是另一条 usage 来源，两条都给最稳。
   */
  codexResponses: {
    method: 'POST',
    path: '/internal/v1/codex/responses',
    auth: true,
    requestFields: CODEX_ENVELOPE_FIELDS,
    requestRequired: Object.freeze(['body']),
    responseFields: Object.freeze([
      ['type', 'string', 'Responses 事件体，type 形如 response.completed'],
      ['response', 'object', '最终响应，含 output 与 usage'],
      ['error', 'object', '失败时 {type, code, message}'],
      ['usage', 'object', '顶层 usage（部分事件携带）'],
    ]),
    status: Object.freeze([200, 400, 401, 403, 429, 502, 503]),
  },
})

/** 错误体统一形态：`{ok:false, error:{type,code,message,status}}`，与 config.mjs 的 workerError 同源。 */
export const ERROR_BODY_FIELDS = Object.freeze(['ok', 'error'])

/**
 * 从请求头取认证 token。
 *
 * 客户端两个头都发、值相同；这里按 KERNEL_AUTH_HEADERS 顺序取第一个非空的。
 * 只接受这两个名字 —— 别名的头越多，越容易在代理层产生歧义。
 */
export function bearerFromHeaders(headers = {}) {
  for (const name of KERNEL_AUTH_HEADERS) {
    const value = headers[name]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/**
 * 认证判定。
 *
 * 与 vm2api 的 `apiKernelHealth` 一致：没有配置 token 时也要求发 token
 * （配置为空说明部署有问题，放行会把内部端点暴露到 socket 上）。
 */
export function isAuthed(headers, expectedToken) {
  const expected = String(expectedToken || '')
  if (!expected) return false
  return bearerFromHeaders(headers) === expected
}

/**
 * 取 request_id。
 *
 * 优先 envelope 里的 request_id（callGoWorker 注入的那个 UUID），
 * 其次信封头 `x-request-id`（面板/手工 curl 会用），最后才回落到生成值。
 * 顺序不能反：cancel 只认 envelope 里那个 id。
 */
export function requestIdFromBody(body = {}) {
  const value = body?.request_id
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/**
 * 健康检查的「就绪」判定，照抄 rustKernelReachable 的三段逻辑。
 *
 * 供内核自检与测试共用：一条 payload 是否会让 supervisor 认为
 * 「起来了」。注意 ready_slots 缺省算 ready，这与 rustKernelCliReady 一致。
 */
export function healthIsReady(body) {
  if (!body || typeof body !== 'object') return false
  const up = body.ok === true || Number(body.status) === 200 || body.engine === 'rust' || !!body.worker_version
  if (!up) return false
  if (body.healthy === false) return false
  if (body.ready_slots == null) return true
  const n = Number(body.ready_slots)
  return Number.isFinite(n) && n > 0
}

/**
 * 逐字段校验一个请求/响应对是否符合契约。
 *
 * 只做「形状与语义」校验，不校验 token 本身（那是 isAuthed 的事）：
 * 把两件事混在一起会让兼容性测试无法区分「契约不对」和「钥匙不对」。
 *
 * @param {keyof KERNEL_ENDPOINTS} endpoint
 * @param {{method?:string, path?:string, headers?:object, body?:object}} req
 * @param {{status?:number, headers?:object, body?:object}} res
 * @returns {string[]} 问题列表，空数组表示合规
 */
export function validateAgainstContract(endpoint, req = {}, res = {}) {
  const problems = []
  const spec = KERNEL_ENDPOINTS[endpoint]
  if (!spec) return [`unknown endpoint: ${endpoint}`]

  // ── 请求行
  if (req.method != null && String(req.method).toUpperCase() !== spec.method) {
    problems.push(`method ${req.method} != ${spec.method}`)
  }
  if (req.path != null && normalizePath(req.path) !== spec.path) {
    problems.push(`path ${req.path} != ${spec.path}`)
  }

  // ── 请求体必填字段
  // req.body 未给出时整体跳过：调用方经常只验响应（尤其是从真实 HTTP 调用
  // 回来只想断言响应合约时）。要验请求就必须显式传 body。
  const required = spec.requestRequired || []
  if (required.length && req.body !== undefined) {
    if (!req.body || typeof req.body !== 'object') {
      problems.push('request body is required')
    } else {
      for (const field of required) {
        if (req.body[field] === undefined || req.body[field] === null) {
          problems.push(`request body missing required field: ${field}`)
        }
      }
      // 只报未知字段，不拦：控制面可能加字段，内核要容错
      const known = new Set(spec.requestFields || [])
      if (known.size) {
        for (const key of Object.keys(req.body)) {
          if (!known.has(key)) problems.push(`request body has unknown field: ${key}`)
        }
      }
    }
  }

  // ── 状态码
  if (res.status != null) {
    const status = Number(res.status)
    if (!spec.status.includes(status)) problems.push(`status ${status} not in ${spec.status.join('/')}`)
  }

  // ── 响应体
  const body = res.body
  if (res.status != null && Number(res.status) >= 200 && Number(res.status) < 300) {
    if (!body || typeof body !== 'object') {
      problems.push('response body is required for 2xx')
    } else if (body.ok === false || body.error) {
      problems.push('2xx response carries an error body')
    } else {
      for (const [field, kind] of responseRequirements(endpoint)) {
        if (body[field] === undefined) problems.push(`response body missing field: ${field}`)
        else if (!matchesKind(body[field], kind)) {
          problems.push(`response body field ${field} is not ${kind}`)
        }
      }
    }
  }
  if (res.status != null && Number(res.status) >= 400) {
    if (!body || typeof body !== 'object') {
      problems.push('error response must carry a JSON body')
    } else if (!body.error && !body.ok === true) {
      // Anthropic 形态 {type:'error',error:{...}} 与内核形态 {ok:false,error:{...}} 都接受
      if (!(body.type === 'error' && body.error)) problems.push('error response lacks error object')
    }
  }
  return problems
}

/**
 * 各端点在 2xx 上必须出现的字段。
 *
 * 表里 responseFields 是「可能出现的字段全集」（供参考与展示），
 * 这里只保留「缺了就会让客户端判错」的那几个。
 */
function responseRequirements(endpoint) {
  switch (endpoint) {
    case 'health':
      // supervisor 只看这几个；其余是面板展示，缺了不影响就绪
      return [
        ['ok', 'boolean'],
        ['ready_slots', 'number'],
        ['engine', 'string'],
      ]
    case 'messages':
      return [
        ['type', 'string'],
        ['content', 'array'],
        ['usage', 'object'],
      ]
    case 'models':
      return [['data', 'array']]
    case 'cancel':
      return [['ok', 'boolean']]
    case 'codexResponses':
      // 流式端点没有统一的 2xx JSON 体，校验交给 SSE 解析器
      return []
    default:
      return []
  }
}

function matchesKind(value, kind) {
  if (kind === 'array') return Array.isArray(value)
  if (kind === 'object') return !!value && typeof value === 'object' && !Array.isArray(value)
  if (kind === 'string') return typeof value === 'string'
  if (kind === 'boolean') return typeof value === 'boolean'
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value)
  return true
}

/** 去掉 query 与尾斜杠，便于比较路径 */
function normalizePath(p) {
  const raw = String(p || '')
  const q = raw.indexOf('?')
  const path = q >= 0 ? raw.slice(0, q) : raw
  return path.replace(/\/+$/, '') || '/'
}

/**
 * 一份端点的可读摘要，供日志与测试断言用。
 * 刻意不暴露字段说明（说明太长，日志里没用）。
 */
export function endpointSummary(endpoint) {
  const spec = KERNEL_ENDPOINTS[endpoint]
  if (!spec) return null
  return {
    endpoint,
    method: spec.method,
    path: spec.path,
    auth: spec.auth === true,
    status: [...spec.status],
  }
}
