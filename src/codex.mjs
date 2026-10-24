/**
 * Codex 通道实现：凭据解析、Envelope 规范化、上游请求构造、账号调度。
 *
 * 关键约束：
 * 1. 凭据文件顶层必须是 {"accounts":[...]}。裸数组、{"items":[]}、
 *    {"credentials":[]}、{"account":{}} 这类写法在上游实现里会被解析成
 *    0 个账号且不报错——本模块改为显式报错，避免"看起来加载成功但没有任何账号"。
 * 2. Account 的 8 个字段里只有 id 必填，其余可缺省；但 expires_at 必须是 i64、
 *    rpm / max_concurrency 必须是 u32。类型不严格时会拖垮整份凭据列表，
 *    因此这里对每个账号严格校验并在出错时抛异常。
 * 3. Envelope 的 Responses 字段必须放在 body 键里。放顶层不报错，但会被
 *    静默丢掉，客户端拿到 200 和完整 SSE，模型其实什么也没收到。
 * 4. 调度器的选择顺序与亲和语义是上游约定，不是可优化项。详见
 *    AccountScheduler 的说明。
 */

import { createHash, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'

import { collectResponsesStream } from './codex-convert.mjs'
// 额度窗口模型（纯计算，无状态）：5h / 7d 的读数与阈值判定都来自这里，
// Codex 侧只负责「按账号读读数」和「打满时 park 到 reset」。
import { accountGate } from './quota-window.mjs'

// ─────────────── 凭据 ───────────────

/** 默认 ChatGPT 上游 base（固定 37 字节常量，不要加尾斜杠） */
export const DEFAULT_CHATGPT_BASE = 'https://chatgpt.com/backend-api/codex'
export const DEFAULT_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const DEFAULT_CODEX_UA = 'codex_cli_rs/0.160.0 (linux x86_64)'
export const ANALYTICS_PATH = '/analytics-events/events'

/** 上游 body 硬上限：超过 15MB 强制走 HTTP SSE，不试 WS */
export const WS_BODY_LIMIT = 0xf00000

/**
 * Account 的字段约束，顺序即字段声明顺序。
 * 只有 id 必填，其余字段缺省时按类型填空串或 null。
 */
export const ACCOUNT_FIELDS = Object.freeze([
  { name: 'id', type: 'string', required: true },
  { name: 'access_token', type: 'string', required: false },
  { name: 'refresh_token', type: 'string', required: false },
  { name: 'id_token', type: 'string', required: false },
  { name: 'expires_at', type: 'i64', required: false },
  { name: 'chatgpt_account_id', type: 'string', required: false },
  { name: 'rpm', type: 'u32', required: false },
  { name: 'max_concurrency', type: 'u32', required: false },
])

/** u32 范围检查 */
function isU32(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff
}

/** i64 范围检查 */
function isI64(v) {
  return typeof v === 'number' && Number.isInteger(v) &&
    v >= -9223372036854775808 && v <= 9223372036854775807
}

/**
 * 校验并规范化单个 Account。
 *
 * 之所以严格到抛错：`expires_at:"999"` / `rpm:"60"` / `rpm:-1` 这类类型错误
 * 在上游实现里会让**整份凭据列表变成空**，而不是只跳过出错的那一条。
 * 静默的后果是"所有请求突然都没有可用账号"，排查成本极高。
 * 因此这里选择立即报错，把问题暴露在加载阶段。
 */
export function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('account must be an object')
  }
  const out = {}
  for (const f of ACCOUNT_FIELDS) {
    const v = raw[f.name]
    if (v === undefined || v === null) {
      if (f.required) throw new Error(`account missing required field \`${f.name}\``)
      out[f.name] = f.type === 'string' ? '' : null
      continue
    }
    if (f.type === 'string') {
      if (typeof v !== 'string') {
        throw new Error(`account.${f.name} must be string, got ${typeof v}`)
      }
      out[f.name] = v
    } else if (f.type === 'u32') {
      if (!isU32(v)) throw new Error(`account.${f.name} must be u32, got ${JSON.stringify(v)}`)
      out[f.name] = v
    } else if (f.type === 'i64') {
      if (!isI64(v)) throw new Error(`account.${f.name} must be i64, got ${JSON.stringify(v)}`)
      out[f.name] = v
    }
  }
  return out
}

/**
 * 解析凭据文件。顶层**必须**是 `{"accounts":[...]}`。
 *
 * 其他形态（裸数组、带别的键名的数组容器）一律显式报错，
 * 不做"尽力猜测"的兼容——猜错会让整个账号池静默变空。
 */
export function parseCredentialFile(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch (e) {
    throw new Error(`credential file is not valid JSON: ${e.message}`)
  }
  if (Array.isArray(parsed)) {
    throw new Error('credential file must be {"accounts":[...]}, not a bare array')
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) {
    throw new Error('credential file must be {"accounts":[...]}')
  }
  return { accounts: parsed.accounts.map(normalizeAccount) }
}

// ─────────────── Envelope ───────────────

/** Envelope 的 7 个字段。它是 struct 而不是 tuple，字段按名匹配、与位置无关 */
export const ENVELOPE_FIELDS = Object.freeze([
  'body', 'headers', 'session', 'stream', 'options',
  'previous_response_id', 'session_id',
])

export const REQUEST_OPTIONS_FIELDS = Object.freeze([
  'upstream_transport', 'user_agent', 'client_features', 'analytics', 'installation_id',
])

export const SESSION_FIELDS = Object.freeze(['session_id', 'previous_response_id'])

/**
 * 规范化入站 Envelope。
 *
 * 最关键的一条：Responses 字段必须放进 `body` 键。
 * 放在顶层不会触发报错，但上游实现会静默转发 `{}`——客户端拿到 200 与完整
 * SSE 流，模型实际什么也没收到。这种失败最难排查，因此本实现把"顶层出现
 * 未知字段"当作显式错误，并在错误信息里列出泄漏的字段名。
 */
export function normalizeEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('envelope must be an object')
  }
  if (raw.body === undefined) {
    // 检查是否有 Responses 字段落在了顶层 —— 这是最容易犯的错
    const leaked = Object.keys(raw).filter((k) => !ENVELOPE_FIELDS.includes(k))
    if (leaked.length > 0) {
      throw new Error(
        `envelope.body is required; found Responses fields at top level: ${leaked.join(', ')} ` +
        '(they would be silently dropped)',
      )
    }
    throw new Error('envelope missing field `body`')
  }
  if (typeof raw.body !== 'object' || raw.body === null || Array.isArray(raw.body)) {
    throw new Error('envelope.body must be an object')
  }
  const options = raw.options && typeof raw.options === 'object' ? { ...raw.options } : null
  if (options?.installation_id != null) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(options.installation_id))) {
      throw new Error('options.installation_id must be a UUID')
    }
  }
  return {
    body: raw.body,
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
    session: raw.session && typeof raw.session === 'object' ? raw.session : null,
    // stream 缺省视为 true：只有显式传 false 才是非流式
    stream: raw.stream !== false,
    options,
    previous_response_id: raw.previous_response_id ?? null,
    session_id: raw.session_id ?? null,
  }
}

// ─────────────── 上游 URL ───────────────

/** base URL 末尾去 `/`，然后拼 `/responses` */
export function responsesUrl(base = DEFAULT_CHATGPT_BASE) {
  return `${String(base).replace(/\/+$/, '')}/responses`
}

/**
 * HTTP → WS 的 scheme 转换：https → wss、http → ws，路径同样拼 `/responses`。
 * 其他 scheme 原样保留前缀并默认用 wss。注意 ws 只配 http:// 才会降级。
 */
export function responsesWsUrl(base = DEFAULT_CHATGPT_BASE) {
  const trimmed = String(base).replace(/\/+$/, '')
  let scheme = 'wss://'
  let rest = trimmed
  if (trimmed.startsWith('https://')) rest = trimmed.slice(8)
  else if (trimmed.startsWith('http://')) {
    scheme = 'ws://'
    rest = trimmed.slice(7)
  }
  return `${scheme}${rest}/responses`
}

// ─────────────── 头部 ───────────────

/**
 * strip_identity 删除的 12 个键。
 *
 * 这些是身份/端点相关字段：透传到上游会暴露真实部署位置（base_url、hostname、
 * api_key 等），也会改变上游的行为（max_tokens、temperature 等）。
 * 因此发往上游前统一剔除，由本模块自己决定这些值。
 */
/**
 * service_tier 的取值改写。
 *
 * 上游只认三个档位，其中客户端常用的 `fast` 必须转成 `priority` ——
 * 直接把 `fast` 发过去会被当作未知档位忽略，等于没生效。
 *
 * 这个改写发生在两处，必须是同一份结果：
 *   - 请求体的 service_tier 字段
 *   - x-codex-routing-hint 头的 tier 段
 * 两处不一致会导致上游按 body 计费、按 header 路由，行为撕裂。
 */
export const SERVICE_TIER_REWRITE = Object.freeze({ fast: 'priority' })

/** 归一化 service_tier：去空白、小写比较、未知值原样返回 */
export function normalizeServiceTier(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const lower = s.toLowerCase()
  return SERVICE_TIER_REWRITE[lower] || s
}

export const STRIP_IDENTITY_KEYS = Object.freeze([
  'base_url', 'custom_base_url', 'endpoint', 'hostname', 'api_key', 'authorization',
  'client_metadata', 'user_id', 'max_output_tokens', 'max_tokens', 'temperature',
  'prompt_cache_retention',
])

/**
 * 允许从客户端透传到上游的请求头白名单。
 *
 * 名单之外的客户端头一律丢弃：上游只认识这些，多发的头会改变路由或触发风控。
 * 命中时同名（大小写无关）覆盖、否则追加。
 *
 * 注意：名单里的名字只是「上游认识这个头」，不等于「客户端可以决定它的值」。
 * 身份、会话、编码这几类由本模块决定，见 CLIENT_DECIDED_HEADERS。
 */
export const HEADER_PASSTHROUGH_ALLOWLIST = Object.freeze([
  'host', 'cookie', 'cookie2', 'version', 'x-api-key', 'user-agent', 'originator',
  'session-id', 'openai-beta', 'authorization', 'content-length', 'x-codex-turn-id',
  'x-openai-fedramp', 'x-codex-window-id', 'x-openai-subagent', 'chatgpt-account-id',
  'chatgpt-project-id', 'proxy-authorization', 'openai-organization',
  'x-codex-routing-hint', 'x-codex-beta-features', 'x-codex-turn-metadata',
  'x-codex-installation-id', 'x-codex-parent-thread-id',
  'x-openai-account-routing-override', 'x-openai-internal-codex-responses-lite',
  'thread-id', 'x-openai-memgen-request', 'x-codex-turn-state', 'x-client-request-id',
])

/**
 * 由本模块决定、客户端传入的值一律不采用的头。
 *
 * 这些头决定「这条请求是谁发的、属于哪一轮、体是怎么编的」，
 * 一旦交给客户端就会出现三类故障：
 *   - authorization / chatgpt-account-id：用到别人的凭据或别的账号；
 *   - session-id / x-codex-turn-id：多轮被归并成同一轮、或跨会话串味；
 *   - content-encoding：声明 zstd 但体不是 zstd，上游解压失败；
 *   - content-length：声明的长度与实际压缩后字节数无关，上游按错误长度读体。
 *
 * 合并阶段直接跳过它们，合并后再由 applyRequiredHeaders 用本模块的值写回；
 * content-length 属于「丢弃」而不是「覆盖」：本模块不产生该头，
 * 出站请求里不能出现它，交给运行时按实际字节数填写。
 */
export const CLIENT_DECIDED_HEADERS = Object.freeze([
  'authorization',
  'chatgpt-account-id',
  'session-id',
  'x-codex-turn-id',
  'content-encoding',
  'content-length',
])

/**
 * 合并客户端头之后必须由本模块写回的头（顺序即覆盖顺序）。
 *
 * 取 buildOutboundHeaders 的产物作为唯一来源，避免同一份值在多处各算一遍。
 */
export const REQUIRED_OUTBOUND_HEADERS = Object.freeze([
  'authorization',
  'chatgpt-account-id',
  'session-id',
  'x-codex-turn-id',
  'content-encoding',
])

/**
 * 把客户端头按白名单合并进目标头表。
 *
 * 白名单命中但属于 CLIENT_DECIDED_HEADERS 的头跳过：这些值由本模块决定。
 * @param {Record<string,string>} target 已构造好的头（会被就地修改）
 * @param {Record<string,string>} incoming 客户端原始头
 */
export function mergePassthroughHeaders(target, incoming = {}) {
  const allow = new Set(HEADER_PASSTHROUGH_ALLOWLIST)
  const decided = new Set(CLIENT_DECIDED_HEADERS)
  for (const [k, v] of Object.entries(incoming || {})) {
    const lower = String(k).toLowerCase()
    if (!allow.has(lower)) continue
    if (decided.has(lower)) continue
    target[lower] = v
  }
  return target
}

/**
 * 合并客户端头之后，把本模块决定的值统一写回。
 *
 * 只覆盖本模块确实产出了值的头（例如账号没有 chatgpt_account_id 时不写该头）。
 * content-length 不在此列：本模块不设它，并显式删除客户端留下的同名头，
 * 由运行时按实际字节数填写。
 *
 * @param {Record<string,string>} target 合并后的头（会被就地修改）
 * @param {Record<string,string>} own 本模块构造的头（buildOutboundHeaders 的产物）
 */
export function applyRequiredHeaders(target, own = {}) {
  for (const name of REQUIRED_OUTBOUND_HEADERS) {
    if (own[name] !== undefined) target[name] = own[name]
  }
  delete target['content-length']
  return target
}


/**
 * 把请求头的值转成合法的 HTTP 头字节。
 *
 * 规则：
 *   - 纯 ASCII：原样返回，不改变任何既有行为
 *   - 含非 ASCII：按 UTF-8 百分号编码，保证可逆且稳定（同一输入总是同一输出）
 *
 * 只处理值，不碰键名 —— 键名由本模块自己构造，本来就都是 ASCII。
 */
export function sanitizeHeaderValues(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (v == null) continue
    const s = String(v)
    // eslint-disable-next-line no-control-regex
    if (!/[^\x00-\xff]/.test(s)) {
      out[k] = s
      continue
    }
    out[k] = encodeURIComponent(s)
  }
  return out
}

/** 从 UA 切出 originator / version：`originator/version (rest)` */
export function parseUserAgent(ua = DEFAULT_CODEX_UA) {
  const s = String(ua)
  const [originator, rest = ''] = s.split('/')
  const version = rest.split(' ')[0]
  return { originator, version }
}

/**
 * 构造出站请求头。
 *
 * 注意 x-codex-turn-id 每次调用都现生成，调用方传进来的值不会被使用——
 * 上游用它做单轮追踪，复用旧值会让多轮请求被归并成同一轮。
 *
 * @param {{account:object, body:object, sessionId?:string, installationId?:string,
 *          userAgent?:string, preferWebsocket?:boolean, headers?:object}} p
 */
export function buildOutboundHeaders(p) {
  const account = p.account || {}
  const ua = p.userAgent || DEFAULT_CODEX_UA
  const { originator, version } = parseUserAgent(ua)
  const h = {
    'content-type': 'application/json',
    'content-encoding': 'zstd',
    accept: 'text/event-stream',
    authorization: `Bearer ${account.access_token || ''}`,
    'user-agent': ua,
    'session-id': p.sessionId || randomUUID(),
    'x-codex-turn-id': randomUUID(), // ← 每次新生成，客户端传入被忽略
  }
  if (p.preferWebsocket) h['openai-beta'] = 'responses_websockets=2026-02-06'
  if (account.chatgpt_account_id) h['chatgpt-account-id'] = account.chatgpt_account_id
  if (p.installationId) h['x-codex-installation-id'] = p.installationId
  const model = p.body?.model
  if (model) {
    // tier 必须用与请求体相同的归一化结果，否则 body 与 header 会不一致
    const tier = normalizeServiceTier(p.body?.service_tier)
    h['x-codex-routing-hint'] = tier ? `model=${model};tier=${tier}` : `model=${model}`
  }
  h.originator = originator
  h.version = version
  return h
}

// ─────────────── body 改写 ───────────────

/**
 * 改写要发给上游的 Responses body。
 *
 * 三条固定动作：
 *   1. store 强制 false（上游不落库，避免把对话留在服务端）；
 *   2. 删掉 12 个身份键（见 STRIP_IDENTITY_KEYS）；
 *   3. session.session_id 存在时注入 client_metadata。
 *
 * client_metadata 里的键名是 `x-codex-installation-id`（带 x-codex- 前缀），
 * 不是 `installation_id`。写成后者上游不认，会当成未知字段忽略。
 */
export function buildOutboundBody({ body, session, installationId, turnId, clientFeatures = false } = {}) {
  const out = { ...(body || {}) }

  // store 强制 false：上游不接受 true，客户端传什么都以 false 发出
  out.store = false

  // stream 恒为 true，与调用方要的返回形态无关。
  // 上游对这个字段是强校验：缺失或为 false 都会 400 "Stream must be set to true"。
  // 客户端要非流式时，由上游流聚合出完整 response 再返回，
  // 而不是把 stream:false 发过去——那样只会收到 400。
  out.stream = true

  // service_tier 归一化：fast → priority
  const tier = normalizeServiceTier(out.service_tier)
  if (tier) out.service_tier = tier
  else delete out.service_tier

  for (const k of STRIP_IDENTITY_KEYS) delete out[k]

  // client_metadata 只在开启 client features 时注入。
  // 注意：不要用 session_id 是否存在作为条件 —— 那是另一个开关，
  // 两者独立，混用会导致 request 该注入时不注入、不该注入时乱注入。
  if (clientFeatures) {
    const meta = {
      turn_id: turnId || randomUUID(),
    }
    const sid = session?.session_id
    if (sid) meta.session_id = sid
    if (installationId) meta['x-codex-installation-id'] = installationId
    out.client_metadata = meta
  }

  return out
}

// ─────────────── 压缩与传输选择 ───────────────

/**
 * body 强制 zstd 压缩（Node 22+ 原生支持）。
 * 运行时不带 zstd 时退化为不压缩——此时上游可能表现不一致，
 * 因此生产环境应确保 Node 版本满足要求。
 */
export function compressBody(json) {
  const raw = Buffer.from(typeof json === 'string' ? json : JSON.stringify(json), 'utf8')
  if (typeof zlib.zstdCompressSync === 'function') {
    return zlib.zstdCompressSync(raw)
  }
  // 退化：不压缩（上游可能行为不一致）
  return raw
}

export function decompressBody(buf) {
  if (typeof zlib.zstdDecompressSync === 'function') {
    return zlib.zstdDecompressSync(buf)
  }
  return buf
}

/**
 * 选择传输方式。
 *
 * 超过 WS_BODY_LIMIT 一律走 HTTP SSE——WS 路径不承载大 body。
 * 未超限时按调用方的 requested 决定是否先试 WS；未显式要求就用 HTTP。
 *
 * @returns {'http'|'prefer_websocket'}
 */
export function chooseTransport({ requested, bodyBytes }) {
  if (bodyBytes > WS_BODY_LIMIT) return 'http'
  return requested === 'prefer_websocket' ? 'prefer_websocket' : 'http'
}

// ─────────────── 会话亲和调度 ───────────────

/**
 * 账号调度器
 *
 * 行为约定（这是上游的实际语义，不是优化空间）：
 *
 *   1. 会话亲和永久有效，没有过期时间。
 *      -(sessionId → accountId) 一旦绑定，除非该账号从池中移除，
 *        或者被新绑定顶替，否则一直生效。
 *      - 不要引入 TTL。真实机器上长时间交互的会话不会突然换账号，
 *        换账号会让上游把同一段对话当成两个用户。
 *
 *   2. 选择顺序固定为三段，命中即返回：
 *        ① session 键亲和
 *        ② thread 键亲和
 *        ③ 全表扫描，取第一个可接受的账号
 *      亲和命中后仍要过 canTake；不通过就回落到 ③。
 *
 *   3. ③ 是首个可用即选，不排序、不算负载加权。
 *      想改这一点要慎重：改成"最小负载"会改变账号使用分布，
 *      在账号之间额度不对等时反而更容易打到上限。
 *
 *   4. 请求失败不解除亲和。只有成功提交、且绑定需要变更时才清旧绑定。
 *
 *   5. 冷却时长优先用上游返回的 Retry-After，没有则默认 30 秒，
 *      429 时默认 60 秒。
 */

/** 默认冷却时长（秒） */
export const DEFAULT_COOLDOWN_SECS = 30
/** 429 时的默认冷却时长（秒） */
export const RATE_LIMIT_COOLDOWN_SECS = 60

/**
 * 上游过载（server_is_overloaded）时的冷却时长（秒）。
 *
 * 过载和 429 不是一回事：429 是"你的额度用完了，等久一点"，
 * 过载是"我这边忙，几秒后就好"。用同一个 30 秒会白白浪费额度 ——
 * 实测单账号连跑 6 次：前 3 次成功，第 4 次碰到过载，之后 30 秒内
 * 全部 503，明明上游早就恢复了。
 *
 * 取 5 秒：够让上游缓一下，又不至于把可用时间全耗在等冷却上。
 */
export const OVERLOAD_COOLDOWN_SECS = 5
/** 本地 RPM 统计的滑窗（秒） */
export const RPM_WINDOW_SECS = 60

/**
 * 额度 park 的兜底时长（秒）。
 *
 * 只在「上游明确说这个窗口已经用满、但没有给 reset 时间」时使用。
 * 没有它，账号会被永久判死（读数一直停在上限、又算不出恢复时间）；
 * 有了它，最坏情况也只是每 60 秒重新评估一次。
 */
export const QUOTA_PARK_FALLBACK_SECS = 60

export class AccountScheduler {
  /**
   * @param {Array<object>} accounts 账号列表，每项至少含 id
   * @param {object} [opts]
   * @param {() => number} [opts.now] 注入时钟，便于测试
   * @param {object|false|null} [opts.quota] 额度窗口读数来源，见 configureQuota
   * @param {object|null} [opts.logger] 日志出口（pino 风格 warn/info）；null 表示静默
   */
  constructor(accounts, { now = () => Date.now(), quota = null, logger = console } = {}) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('scheduler requires at least one account')
    }
    this.accounts = accounts.map((a) => ({ ...a }))
    this.now = now
    this.logger = logger || null

    // 两张亲和表：会话维度与线程维度
    this.sessionAffinity = new Map() // sessionId -> accountId
    this.threadAffinity = new Map()  // threadId  -> accountId

    // 会话计数（只供统计查询，不参与选择决策）
    this.sessionCount = new Map()    // sessionId -> number
    // 在途请求数
    this.inflight = new Map()        // accountId -> number
    // 本地 RPM 滑窗：accountId -> 最近请求时间戳数组
    this.rpmSamples = new Map()      // accountId -> number[]
    // 冷却截止时间：accountId -> timestamp
    this.cooldownUntil = new Map()   // accountId -> number
    // 额度 park：accountId -> { until, reason, level, parkedAt, fallback }
    // 与 cooldownUntil 分开存：成因不同（额度 vs 失败）、解除条件不同
    // （窗口 reset vs 固定时长），混在一起会丢掉成因，排查时看不出为什么被挡。
    this.parkedUntil = new Map()

    this.configureQuota(quota)
  }

  /**
   * 接线额度窗口读数。
   *
   * 两种读数来源都支持，二选一：
   *   - `windows(accountId) => {'5h':Window|null,'7d':Window|null} | null`
   *     由调度器自己用 accountGate 判阈值；
   *   - `gate(accountId) => accountGate 结果 | null`
   *     调用方已经判过（例如复用 QuotaStore.gate），调度器只读 allowed。
   *
   * 传函数而不是快照，是为了让每次 canTake 都看到当前读数：
   * 窗口 reset 是惰性清零的，持有快照会让账号在 reset 之后仍被挡在门外。
   * 读数来源缺失（没配置 / 账号从没请求过 / 无配额头）时一律放行 ——
   * 额度是追加条件，不能把「没有数据」当成「额度用满」。
   *
   * @param {object|false|null} quota
   * @param {Function} [quota.windows]
   * @param {Function} [quota.gate]
   * @param {number} [quota.warnPct] 预警阈值，缺省沿用 quota-window 的 85
   * @param {number} [quota.stopPct] 熔断阈值，缺省沿用 quota-window 的 95
   * @param {number} [quota.parkFallbackSecs] 兜底 park 时长
   */
  configureQuota(quota) {
    const src = quota && typeof quota === 'object' ? quota : null
    this.quotaWindows = typeof src?.windows === 'function' ? src.windows : null
    this.quotaGateReader = typeof src?.gate === 'function' ? src.gate : null
    this.quotaWarnPct = src?.warnPct
    this.quotaStopPct = src?.stopPct
    const fallback = Number(src?.parkFallbackSecs)
    this.quotaParkFallbackSecs = Number.isFinite(fallback) && fallback > 0
      ? fallback
      : QUOTA_PARK_FALLBACK_SECS
    // 没有读数来源时整条额度链路关闭，canTake 行为与旧版完全一致
    this.quotaEnabled = Boolean(this.quotaWindows || this.quotaGateReader)
    return this
  }

  /** 统一的日志出口。logger 为 null 时静默（测试里常用）。 */
  log(level, fields, message) {
    const logger = this.logger
    if (!logger) return
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.log
    if (typeof fn !== 'function') return
    fn.call(logger, fields, `[codex] ${message}`)
  }

  /**
   * 账号是否当前可用：未冷却、未 park、未超并发上限、未超 RPM、额度窗口未打满。
   *
   * max_concurrency 与 rpm 为 0 或未设置时视为不限。
   * RPM 统计用本地滑窗而不是上游计数，因此它只反映本实例的发送量；
   * 多实例共享同一账号时这个数字会偏小，属于已知局限。
   *
   * 判定顺序有讲究：**冷却与 park 在最前**。两者都是「已经知道不行」的结论，
   * 先判它们可以避免为必然被拒的账号做额度读取与 RPM 滑窗整理。
   * 额度判定放在最后，是纯粹的追加条件：前面三条通过之后才会被读到。
   */
  canTake(account) {
    const t = this.now()

    const until = this.cooldownUntil.get(account.id)
    if (until != null && t < until) return false

    // 额度 park：命中说明这个号在上一个窗口里已经打满，等到 reset 再放出来。
    //
    // 但 park 之后**必须复查一次读数**，不能只等 reset 时间：
    //   · 上游给的 reset 可能偏保守（我们按 95% 熔断，实际到 95% 就停，
    //     而 reset 是按 100% 用完估算的）
    //   · 没有 reset 时钟时退到 60s 兜底，这段时间里额度可能已经回落
    //   · 多个共享同一账号的实例，配额可能被别处释放
    //
    // 实测过的问题：两号都打满 → 都被 park → 把其中一个降到 10% 后
    // 仍然报 quota_exhausted，那个号被白白挡住一小时。
    // 所以 park 命中后先复查读数，读数已恢复就解除 park 并放行。
    if (this.isQuotaParked(account.id, t)) {
      const recheck = this.quotaVerdict(account.id)
      if (!recheck || recheck.allowed === false) return false
      // 读数显示已恢复：解除 park（记录一条日志，便于观察提前恢复的频率）
      this.unparkAccount(account.id)
      this.log('info', { account: account.id, reason: 'quota_recovered' },
        'quota park lifted early: reading below threshold')
    }

    const maxConcurrency = Number(account.max_concurrency || 0)
    if (maxConcurrency > 0) {
      const inUse = this.inflight.get(account.id) || 0
      if (inUse >= maxConcurrency) return false
    }

    const rpm = Number(account.rpm || 0)
    if (rpm > 0) {
      const samples = this.rpmSamples.get(account.id) || []
      const cutoff = t - RPM_WINDOW_SECS * 1000
      const recent = samples.filter((s) => s > cutoff)
      this.rpmSamples.set(account.id, recent)
      if (recent.length >= rpm) return false
    }

    // 额度窗口：读数是函数，每次现取，避免持有过期快照。
    // 无数据 / 未接线时 quotaVerdict 返回 null，这里直接放行。
    const verdict = this.quotaVerdict(account.id)
    if (verdict && verdict.allowed === false) {
      // 记下 park 直到窗口 reset。上游没给 reset 时钟时用兜底时长，
      // 否则这个号会被「读数停在上限且算不出恢复时间」永久挡在门外。
      this.parkAccount(account.id, {
        until: verdict.resumeAt,
        reason: verdict.reason || 'quota_exhausted',
        level: verdict.level || 'stop',
      })
      return false
    }

    return true
  }

  /**
   * 取某账号当前的额度判定。
   *
   * 返回 null 表示「没有可用的额度依据」，调用方必须按放行处理：
   *   - 没接线（quotaEnabled=false）
   *   - 账号从没收到过配额头
   *   - 读数来源本身出错
   *
   * 读数来源抛错不能让请求路径崩掉 —— 额度是旁路信号，上游拒绝才是权威。
   * 出错时打一条 WARN 后放行，让上游的 429 来做决定，冷却仍然兜底。
   *
   * @returns {null|{allowed:boolean, reason?:string, resumeAt?:number|null, level?:string}}
   */
  quotaVerdict(accountId) {
    if (!this.quotaEnabled) return null
    try {
      if (this.quotaGateReader) {
        const raw = this.quotaGateReader(accountId)
        if (!raw || typeof raw !== 'object') return null
        return {
          allowed: raw.allowed !== false,
          reason: raw.reason || null,
          resumeAt: Number.isFinite(Number(raw.resumeAt)) ? Number(raw.resumeAt) : null,
          level: raw.level || null,
        }
      }
      const windows = this.quotaWindows(accountId)
      if (!windows || typeof windows !== 'object') return null
      const gate = accountGate(windows, {
        warnPct: this.quotaWarnPct,
        stopPct: this.quotaStopPct,
        now: this.now(),
      })
      // 只有 stop 才拦；warn 放行（与 accountGate 的 degraded 语义一致）
      return {
        allowed: gate.allowed !== false,
        reason: gate.reason,
        resumeAt: Number.isFinite(Number(gate.resumeAt)) ? Number(gate.resumeAt) : null,
        level: gate.level,
        limited: gate.limited,
      }
    } catch (error) {
      this.log('warn', { account: accountId, error: String(error?.message || error) },
        'quota reading failed, allowing the account')
      return null
    }
  }

  /**
   * 把账号 park 到某个时间点，之后自动解除（不需要人工干预）。
   *
   * @param {string} accountId
   * @param {object} [opts]
   * @param {number|null} [opts.until] 解除时间（epoch ms）；缺失或已过期时用兜底时长
   * @param {string} [opts.reason] 成因，透出到日志与 snapshot
   * @param {string} [opts.level]
   * @returns {number} 实际 park 秒数
   */
  parkAccount(accountId, { until = null, reason = 'quota_exhausted', level = 'stop' } = {}) {
    const t = this.now()
    const target = Number(until)
    // reset 时间缺失 / 已过期 / 非有限值 → 兜底。已过期的 reset 不能用来解除 park，
    // 否则刚 park 就立刻解，等于没有 park。
    const useFallback = !Number.isFinite(target) || target <= t
    const resumeAt = useFallback ? t + this.quotaParkFallbackSecs * 1000 : target
    const secs = Math.max(1, Math.ceil((resumeAt - t) / 1000))
    this.parkedUntil.set(accountId, {
      until: resumeAt,
      reason,
      level,
      parkedAt: t,
      fallback: useFallback,
    })
    // 日志要能直接看出「这个号被 park 多久」，排障时不需要再算时间差
    this.log('warn', {
      account: accountId,
      reason,
      level,
      park_secs: secs,
      resume_at: new Date(resumeAt).toISOString(),
      fallback: useFallback,
    }, `account paused for quota: ${secs}s reason=${reason}`)
    return secs
  }

  /** 手动解除 park（运维/测试用；正常运行靠到期自动解除）。 */
  unparkAccount(accountId) {
    return this.parkedUntil.delete(accountId)
  }

  /**
   * 账号是否处于额度 park 中。
   *
   * 到期的 park **就地清掉**并返回 false：解除条件是「时间到了」，
   * 不需要任何人来重置状态，这正是 park 是软约束的含义。
   */
  isQuotaParked(accountId, now = this.now()) {
    const park = this.parkedUntil.get(accountId)
    if (!park) return false
    if (now < park.until) return true
    this.parkedUntil.delete(accountId)
    this.log('info', {
      account: accountId,
      reason: park.reason,
      parked_secs: Math.max(0, Math.round((now - park.parkedAt) / 1000)),
    }, 'account quota pause lifted')
    return false
  }

  /** 当前所有 park 里最早解除的时间（epoch ms），没有 park 时返回 null。 */
  soonestUnparkAt() {
    let best = null
    const t = this.now()
    for (const [accountId, park] of this.parkedUntil) {
      if (!this.isQuotaParked(accountId, t)) continue
      if (best == null || park.until < best) best = park.until
    }
    return best
  }

  /**
   * 选择一个账号。顺序见类注释：session 亲和 → thread 亲和 → 首个可用。
   *
   * 亲和命中也要走 hold() 占坑，否则 max_concurrency 对这条路径完全失效，
   * 一个被反复使用的亲和账号会无限并发。
   *
   * @param {{sessionId?:string, threadId?:string}} keys
   * @returns {{account:object, via:'session'|'thread'|'scan'}}
   * @throws 没有可用账号时抛错，错误码在 .code 上
   */
  select({ sessionId, threadId } = {}) {
    const sid = normalizeKey(sessionId)
    const tid = normalizeKey(threadId)

    // ① 会话亲和
    if (sid) {
      const boundId = this.sessionAffinity.get(sid)
      if (boundId != null) {
        const acc = this.accounts.find((a) => a.id === boundId)
        if (acc && this.canTake(acc)) {
          const picked = { account: acc, via: 'session' }
          // 亲和命中同样要占坑，否则 max_concurrency 对这条路径失效
          this.hold(picked, { sessionId: sid, threadId: tid })
          return picked
        }
      }
    }

    // ② 线程亲和
    if (tid) {
      const boundId = this.threadAffinity.get(tid)
      if (boundId != null) {
        const acc = this.accounts.find((a) => a.id === boundId)
        if (acc && this.canTake(acc)) {
          const picked = { account: acc, via: 'thread' }
          this.hold(picked, { sessionId: sid, threadId: tid })
          return picked
        }
      }
    }

    // ③ 首个可用
    for (const acc of this.accounts) {
      if (this.canTake(acc)) {
        const picked = { account: acc, via: 'scan' }
        this.hold(picked, { sessionId: sid, threadId: tid })
        return picked
      }
    }

    // 一个都选不出来。错误码要能区分成因：
    //   - 额度 park 挡下了所有候选 → quota_exhausted + retryAt（窗口 reset）
    //   - 其它（冷却/并发/RPM）→ 保持原样 all_rejected，对外语义不变
    // 区分开的价值：客户端能拿到一个「确实几点几分恢复」的退避依据，
    // 而不是把额度问题误读成普通的全账号失败。
    const err = new Error('no account can take this request')
    err.code = this.accounts.length === 0 ? 'no_candidates' : 'all_rejected'
    if (this.parkedUntil.size > 0) {
      const retryAt = this.soonestUnparkAt()
      const parkedAll = this.accounts.every((acc) => this.isQuotaParked(acc.id))
      if (parkedAll) {
        err.code = 'quota_exhausted'
        err.retryAt = retryAt
        const secs = retryAt == null ? null : Math.max(1, Math.ceil((retryAt - this.now()) / 1000))
        err.message = secs == null
          ? 'all accounts are parked on exhausted quota windows'
          : `all accounts are parked on exhausted quota windows; retry in ${secs}s`
      }
    }
    throw err
  }

  /** 记录一次选择（占坑 + 记 RPM 样本） */
  hold({ account }, { sessionId, threadId } = {}) {
    this.inflight.set(account.id, (this.inflight.get(account.id) || 0) + 1)
    const samples = this.rpmSamples.get(account.id) || []
    samples.push(this.now())
    this.rpmSamples.set(account.id, samples)

    // 只在尚无绑定时建立初始亲和。
    // 已有的绑定不在这里改 —— 否则"目标账号繁忙时回落"会污染亲和，
    // 导致下次又来回落，形成漂移。改绑定只发生在 commitSuccess。
    if (sessionId) {
      if (!this.sessionAffinity.has(sessionId)) {
        this.sessionAffinity.set(sessionId, account.id)
      }
      this.sessionCount.set(sessionId, (this.sessionCount.get(sessionId) || 0) + 1)
    }
    if (threadId) {
      if (!this.threadAffinity.has(threadId)) {
        this.threadAffinity.set(threadId, account.id)
      }
    }
  }

  /** 请求结束（无论成败都要调用，释放并发计数） */
  release(accountId) {
    const n = (this.inflight.get(accountId) || 1) - 1
    if (n <= 0) this.inflight.delete(accountId)
    else this.inflight.set(accountId, n)
  }

  /**
   * 请求成功。
   *
   * 只有在绑定需要变更时才清旧绑定 —— 失败路径绝不触碰亲和表。
   * 这条分工让"失败不回退亲和"与"成功才迁移账号"两个约束不会互相干扰。
   */
  commitSuccess({ sessionId, threadId, accountId } = {}) {
    const sid = normalizeKey(sessionId)
    const tid = normalizeKey(threadId)

    if (sid && accountId) {
      const prev = this.sessionAffinity.get(sid)
      if (prev != null && prev !== accountId) this.dropSticky({ sessionId: sid })
      this.sessionAffinity.set(sid, accountId)
    }
    if (tid && accountId) {
      const prev = this.threadAffinity.get(tid)
      if (prev != null && prev !== accountId) this.dropSticky({ threadId: tid })
      this.threadAffinity.set(tid, accountId)
    }
  }

  /** 解除亲和绑定（会话维度同时清掉计数） */
  dropSticky({ sessionId, threadId } = {}) {
    const sid = normalizeKey(sessionId)
    const tid = normalizeKey(threadId)
    if (sid) {
      this.sessionAffinity.delete(sid)
      this.sessionCount.delete(sid)
    }
    if (tid) this.threadAffinity.delete(tid)
  }

  /**
   * 把账号放入冷却。
   *
   * 时长优先级：Retry-After（有限且大于 0）→ 429 用 RATE_LIMIT_COOLDOWN_SECS
   * → 其余用 DEFAULT_COOLDOWN_SECS。解析结果不足 1 秒时抬到 1 秒，
   * 否则冷却等于空操作，账号会被立刻再次选中。
   *
   * @param {string} accountId
   * @param {object} [opts]
   * @param {number} [opts.status]      上游 HTTP 状态码
   * @param {number} [opts.retryAfter]  上游给的 Retry-After（秒）
   * @returns {number} 实际冷却秒数
   */
  /**
   * 给账号设冷却。
   *
   * @param {string} accountId
   * @param {object} [opts]
   * @param {number} [opts.status]     上游 HTTP 状态码（或错误态）
   * @param {number} [opts.retryAfter] 上游给的 Retry-After，优先使用
   * @param {string} [opts.code]       上游错误码；server_is_overloaded 走短冷却
   */
  markCooldown(accountId, { status, retryAfter, code } = {}) {
    let secs
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      secs = Math.floor(retryAfter)
    } else if (code && /server_is_overloaded|overloaded|service_unavailable|server_error|internal_error/i.test(String(code))) {
      // 过载是瞬时的，不该和普通故障一起吃满 30 秒
      secs = OVERLOAD_COOLDOWN_SECS
    } else {
      secs = status === 429 ? RATE_LIMIT_COOLDOWN_SECS : DEFAULT_COOLDOWN_SECS
    }
    // 解析出来的 0 也要抬到 1，避免冷却是空操作
    if (secs < 1) secs = 1
    this.cooldownUntil.set(accountId, this.now() + secs * 1000)
    return secs
  }

  /**
   * 账号列表变更时调用。
   *
   * 被移除的账号要连带清掉亲和、冷却与在途计数，否则亲和表会指向一个
   * 已不存在的账号 id：select 里 find 返回 undefined 就永远命中不了，
   * 表现为该 session 每次都回落扫描，亲和彻底失效。
   */
  setAccounts(accounts) {
    const ids = new Set(accounts.map((a) => a.id))
    for (const [sid, accId] of this.sessionAffinity) {
      if (!ids.has(accId)) this.sessionAffinity.delete(sid)
    }
    for (const [tid, accId] of this.threadAffinity) {
      if (!ids.has(accId)) this.threadAffinity.delete(tid)
    }
    for (const accId of this.cooldownUntil.keys()) {
      if (!ids.has(accId)) this.cooldownUntil.delete(accId)
    }
    for (const accId of this.inflight.keys()) {
      if (!ids.has(accId)) this.inflight.delete(accId)
    }
    // park 记录同样要按移除清理：残留项会让 select 的「全 park」判定误命中，
    // 把一个已不存在的账号算进 retryAt。
    for (const accId of this.parkedUntil.keys()) {
      if (!ids.has(accId)) this.parkedUntil.delete(accId)
    }
    this.accounts = accounts.map((a) => ({ ...a }))
  }

  /**
   * 统计快照，供健康检查与面板展示（只读，不改变任何调度状态）。
   *
   * 字段集合是面板的读取契约，额度信息不放这里：详见 quotaSnapshot()。
   */
  snapshot() {
    return {
      accounts: this.accounts.map((a) => ({
        id: a.id,
        inflight: this.inflight.get(a.id) || 0,
        cooldown_secs_left: Math.max(
          0,
          Math.ceil(((this.cooldownUntil.get(a.id) || 0) - this.now()) / 1000),
        ),
        rpm_used: (this.rpmSamples.get(a.id) || [])
          .filter((s) => s > this.now() - RPM_WINDOW_SECS * 1000).length,
      })),
      session_affinity: this.sessionAffinity.size,
      thread_affinity: this.threadAffinity.size,
    }
  }

  /**
   * 额度 park 快照（只读）。
   *
   * 与 snapshot() 分开是刻意的：哪个号被额度挡下、还要挡多久、成因是什么，
   * 是排障时最常查的一组数据，但它的字段集合与调度计数完全不同，
   * 混进 snapshot 只会让两边都更容易被误改。
   */
  quotaSnapshot() {
    const t = this.now()
    const parked = []
    for (const [accountId, park] of this.parkedUntil) {
      if (t >= park.until) continue
      parked.push({
        account_id: accountId,
        reason: park.reason,
        level: park.level,
        secs_left: Math.max(0, Math.ceil((park.until - t) / 1000)),
        parked_at: park.parkedAt,
        resume_at: park.until,
        fallback: park.fallback === true,
      })
    }
    parked.sort((a, b) => (a.secs_left - b.secs_left) || a.account_id.localeCompare(b.account_id))
    return {
      enabled: this.quotaEnabled,
      parked,
      soonest_unpark_at: parked.length ? parked[0].resume_at : null,
    }
  }
}

/** 兼容旧名：对外的历史导出名是 CodexScheduler，内部实现叫 AccountScheduler */
export { AccountScheduler as CodexScheduler }

/** 键规范化：去空白、空串视为未提供（避免空串被当成一个有效隔离的 key） */
function normalizeKey(key) {
  const s = String(key ?? '').trim()
  return s || null
}


// ─────────────── 上游 Retry-After 解析 ───────────────

/**
 * 从响应头里解析冷却时长（秒）。
 *
 * 三个来源，按优先级：
 *   1. x-codex-secondary-reset-after-seconds
 *   2. x-codex-primary-reset-after-seconds
 *   3. retry-after（大小写无关）
 *
 * 先取 secondary：它是更保守的窗口（次级限流恢复更晚），
 * 用 primary 会在次级限流仍生效时过早重试。
 *
 * 值必须是纯十进制数字，带正负号或非数字一律视为无效。
 *
 * @param {Record<string,string>} headers
 * @returns {number|null}
 */
export function parseRetryAfter(headers = {}) {
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = v

  const candidates = [
    'x-codex-secondary-reset-after-seconds',
    'x-codex-primary-reset-after-seconds',
    'retry-after',
  ]
  for (const name of candidates) {
    const raw = lower[name]
    if (raw == null) continue
    const parsed = parseSeconds(String(raw))
    if (parsed != null) return parsed
  }
  return null
}

/**
 * 解析秒数：只接受纯十进制数字串。
 * 带符号（+/-）、小数、单位后缀、空串都返回 null，
 * 超过安全整数范围也返回 null。
 */
function parseSeconds(text) {
  const s = text.trim()
  if (!s) return null
  // 拒绝带符号的值
  if (s.startsWith('+') || s.startsWith('-')) return null
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  if (!Number.isSafeInteger(n)) return null
  return n
}


// ─────────────── 上游传输 ───────────────

/**
 * Codex 通道的上游客户端
 *
 * 与 Claude 通道的区别：Claude 通道由官方 CLI 子进程自己发请求，
 * Codex 通道没有中间进程，必须由本模块直接连上游。
 *
 * 上游地址：https://chatgpt.com/backend-api/codex/responses
 *
 * 三个必须做对的地方：
 *   1. body 必须 zstd 压缩，并带 content-encoding: zstd
 *   2. Responses 字段必须在 body 对象里（不是信封顶层）
 *   3. 失败要读 Retry-After，据此设冷却而不是盲目重试
 */
export class CodexUpstream {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs]
   * @param {Function} [opts.fetchImpl] 注入 fetch，便于测试
   */
  constructor({ baseUrl = DEFAULT_CHATGPT_BASE, timeoutMs = 120_000, fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch is not available; pass fetchImpl explicitly')
    }
    this.baseUrl = baseUrl
    this.timeoutMs = timeoutMs
    this.fetch = fetchImpl
  }

  /**
   * 发一次 Responses 请求。
   *
   * 头部分三步，顺序不能换：
   *   1. buildOutboundHeaders 构造本模块自己的头；
   *   2. mergePassthroughHeaders 合并白名单内的客户端头（身份/会话/编码类跳过）；
   *   3. applyRequiredHeaders 用第 1 步的值覆盖回去，并剔除 content-length。
   *
   * stream 入参只决定**返回给调用方的形态**：
   *   - 缺省取 body.stream；
   *   - true  → 原样交出上游事件流；
   *   - false → 把事件流聚合完整 response 后放进 json 返回。
   * 上游线协议恒为流式（见 UPNORMAL 说明），因此这里不会为 false 去改请求体：
   * 请求体由 buildOutboundBody 负责，那个函数总是发 stream:true。
   *
   * @param {object} p
   * @param {object} p.account      含 access_token / chatgpt_account_id
   * @param {object} p.body         已经过 buildOutboundBody 处理
   * @param {object} [p.session]
   * @param {object} [p.incomingHeaders] 客户端原始头，按白名单合并
   * @param {string} [p.userAgent]
   * @param {string} [p.installationId]
   * @param {boolean} [p.stream] 返回流还是聚合后的 json；缺省按 body.stream 取
   * @param {AbortSignal} [p.signal]
   * @returns {Promise<{status:number, headers:object, stream:ReadableStream|null, json:object|null, retryAfter:number|null}>}
   */
  async createResponse({
    account,
    body,
    session = null,
    incomingHeaders = {},
    userAgent,
    installationId,
    stream,
    signal,
  } = {}) {
    if (!account || !account.access_token) {
      throw new Error('account.access_token is required')
    }

    // 1. 先构造头与体，两处共用同一份 service_tier 归一化结果
    const ownHeaders = buildOutboundHeaders({
      account,
      body,
      sessionId: session?.session_id,
      installationId,
      userAgent,
    })
    const headers = { ...ownHeaders }
    mergePassthroughHeaders(headers, incomingHeaders)
    // 身份/会话/编码头必须由本模块决定：白名单合并会把客户端值写回来，这里统一覆盖
    applyRequiredHeaders(headers, ownHeaders)

    // 2. 体改写 + 压缩。
    //
    //    原先这里只补了 stream:true 就发出去，漏了 store:false。
    //    上游对两者都是强校验：
    //      stream 缺失/false → 400 "Stream must be set to true"
    //      store 缺失/true    → 400 "Store must be set to false"
    //    而 createResponse 是可以被直接调用的（脚本、测试、其它模块），
    //    不保证调用方先过了 buildOutboundBody —— 只兜 stream 不兜 store，
    //    就只有走完整链路的路径能通，直接调用一律 400。
    //
    //    改成直接复用 buildOutboundBody，两条兜底一次做完，
    //    避免同一个规则在两处各写一半、迟早再漂移。
    const wireBody = buildOutboundBody({ body, session, installationId })
    wireBody.stream = true
    const payload = JSON.stringify(wireBody)
    const compressed = compressBody(payload)
    // 压缩方式随体而定（运行时没有 zstd 时退化为明文），因此头必须跟着实际结果走
    headers['content-encoding'] = typeof zlib.zstdCompressSync === 'function' ? 'zstd' : 'identity'
    // 不手动设 content-length：让运行时按实际字节数填写，避免与服务端预期不一致
    delete headers['content-length']

    // 3. 发
    const url = responsesUrl(this.baseUrl)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true })
    }

    // HTTP 头只能是 ASCII（ByteString）。调用方传入的 session 标识可能含中文或其它
    // 非 ASCII 字符，直接写头会让 fetch 在构造请求时抛错，且错误信息与业务无关，
    // 排查成本极高。这里统一转义：纯 ASCII 原样保留，含非 ASCII 时转成可逆形式。
    const safeHeaders = sanitizeHeaderValues(headers)

    let res
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: safeHeaders,
        body: compressed,
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    const respHeaders = {}
    res.headers.forEach((v, k) => { respHeaders[String(k).toLowerCase()] = v })
    const retryAfter = parseRetryAfter(respHeaders)

    if (!res.ok) {
      let errJson = null
      try { errJson = await res.json() } catch { /* 非 JSON 响应 */ }
      return { status: res.status, headers: respHeaders, stream: null, json: errJson, retryAfter }
    }

    // 流式判定必须同时满足两条：
    //   1. 请求确实要了流式（显式 stream 入参，否则取 body.stream）；
    //   2. 响应带 body。
    // 不能看响应头里的 content-type：上游的 SSE 响应 content-type 为 null，
    // 靠它判断会误判成非流式，进而对一条永不结束的事件流调用 json()，
    // 表现为请求一直挂着直到超时。
    // 也不能只看请求头里的 accept：本模块恒定声明 text/event-stream，
    // 用它判断会让 stream:false 的请求也拿到流对象。
    const wantsStream = stream !== undefined ? stream !== false : body?.stream !== false
    if (wantsStream && res.body) {
      return { status: res.status, headers: respHeaders, stream: res.body, json: null, retryAfter }
    }

    // 非流式：调用方要的是完整结果。上游只走流式线协议，因此这里把事件流
    // 聚合为完整 response 再作为 json 返回。
    //
    // 聚合失败**必须**上抛，不能吞成 null。
    // 原先这里是 `catch { aggregated = null }`，然后照常返回 status: 200。
    // 上游过载时正是走这条路：HTTP 200 + 流里 response.failed → 聚合成 null
    // → 调用方收到 200 和空 body，完全不知道失败。实测 20 槽位并发时
    // 4/20 落进这个"假成功"，既没记录也没重试。
    //
    // 上抛后由 executeCodexRequest 的失败处理接管：按 code 判可重试、
    // 给账号设冷却、换号重试，语义和 HTTP 层 5xx 完全一致。
    if (res.body && !wantsStream) {
      const aggregated = await collectResponsesStream(this.iterEvents(res.body))
      return {
        status: res.status,
        headers: respHeaders,
        stream: null,
        json: aggregated,
        retryAfter,
        streamed: true,
      }
    }

    // 非流式且响应无 body
    let json = null
    try { json = await res.json() } catch { /* 空响应 */ }
    return { status: res.status, headers: respHeaders, stream: null, json, retryAfter }
  }

  /**
   * 把上游 SSE 流转成事件迭代器。
   * 逐帧解析 `event:` / `data:` 行，`[DONE]` 视为结束。
   */
  async *iterEvents(stream) {
    const decoder = new TextDecoder()
    let buf = ''
    let eventName = null
    let dataLines = []

    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line === '') {
          if (dataLines.length > 0) {
            const data = dataLines.join('\n')
            if (data !== '[DONE]') {
              let parsed = data
              try { parsed = JSON.parse(data) } catch { /* 保留原文 */ }
              yield { event: eventName, data: parsed }
            }
            eventName = null
            dataLines = []
          }
          continue
        }
        if (line.startsWith('event:')) eventName = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
    }
  }
}

// ─────────────── 请求执行（把调度 + 上游串起来） ───────────────

/**
 * 账号当前冷却的剩余秒数。
 *
 * 取调度器自己的时钟与 cooldownUntil，而不是记住"当初设了多少秒"：
 * 一次请求可能跨越多轮换号，理论剩余时间比初始值更能反映客户端该等多久。
 * 已过期或没有记录时返回 null；不足 1 秒抬到 1 秒，避免返回 0 让客户端立刻重试。
 *
 * @param {AccountScheduler} scheduler
 * @param {string} accountId
 * @returns {number|null}
 */
function cooldownRemainingSecs(scheduler, accountId) {
  const until = scheduler?.cooldownUntil?.get?.(accountId)
  if (!Number.isFinite(until)) return null
  const now = typeof scheduler.now === 'function' ? scheduler.now() : Date.now()
  const secs = Math.ceil((until - now) / 1000)
  return secs > 0 ? secs : 1
}

/**
 * 完整执行一次 Codex 请求：选账号 → 构造 → 发送 → 处理失败。
 *
 * 失败处理策略：
 *   - 429 / 5xx：给账号设冷却，换一个账号重试
 *   - 401：账号凭据失效，标记不可用并重试
 *   - 其他 4xx：直接返回给客户端，不重试（请求本身有问题）
 *
 * 并发占坑（inflight）的归属：
 *   选号时 scheduler.select 已经占坑。**成功路径故意不释放**，占坑要一直保留到
 *   调用方消费完响应为止（流式响应可能在返回后持续几十秒）。调用方读完流/写完
 *   响应体后，必须用返回值里的 accountId 调 scheduler.release(accountId)。
 *   失败路径（非 2xx、换号、4xx 直接返回前）在这里就地释放，因为这条路径上
 *   不会有响应体继续交给调用方。若成功路径也在这里 release，max_concurrency
 *   就等于只在建连瞬间生效，长流会把账号的并发额度放大到不可控。
 *
 * 返回值里的 accountId 就是调用方 release 需要的键；失败且没有可用账号时为 null
 * （此时没有任何占坑残留，调用方无需释放）。
 *
 * `onResult({accountId, status, headers})` 在**每一个**上游响应之后回调一次，
 * 包括中间被换掉的那些账号。额度窗口读数就挂在这条钩子上：x-codex-primary /
 * secondary 的用量与 reset 时间只在响应头里，换号重试时如果不记录中间账号的
 * 那一份，被换掉的号就会带着旧读数继续参与调度。回调抛错一律吞掉，
 * 观察数据的采集不该影响请求本身。
 *
 * 全部失败时的对外状态（这是限流语义的唯一出口，改之前想清楚）：
 *   - 本次请求里有账号被上游 429 打回冷却 → 429 + retryAfter
 *     （取所有 429 账号冷却剩余秒数的**最小值**：最早恢复的那个账号一可用，
 *      客户端就值得重试，报最大的那个会白等）
 *   - 全部失败但没有任何 429（401 / 5xx / 请求本身 4xx）→ 503
 *   - 一个可用账号都没有（no_candidates / 全部在冷却中）→ 503
 *   把 429 归一成 503 会让调用方失去退避依据，只能自己猜重试间隔。
 *
 * 冷却中而没有在本次请求里观测到 429 的账号不计入 retryAfter：
 * 调度器没有记录冷却的成因，凭空当 429 上报会把上游 5xx 也说成限流。
 *
 * @returns {Promise<{status:number, headers:object, stream:object|null, json:object|null,
 *                    retryAfter:number|null, accountId:string|null, attempts:number,
 *                    streamed:boolean}>}
 */
export async function executeCodexRequest({
  upstream,
  scheduler,
  accounts,
  envelope,
  installationId,
  userAgent,
  incomingHeaders = {},
  maxAttempts = 3,
  signal,
  stream,
  onResult = null,
}) {
  // 流式与否用同一个判断走完全链路。注意这个标志只影响**返回给调用方的形态**：
  // 上游线协议恒为 stream:true（body 由 buildOutboundBody 统一设），
  // 要非流式时由上游事件流聚合出完整 response 返回。
  const wantsStream = stream !== undefined ? stream !== false : envelope.stream !== false

  const body = buildOutboundBody({
    body: envelope.body,
    session: envelope.session,
    installationId,
    clientFeatures: Boolean(envelope.options?.client_features),
  })

  const tried = new Set()
  /** 本次请求里被上游 429 打回的账号 id（决定对外是否报 429） */
  const rateLimited = []
  let last = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let picked
    try {
      picked = scheduler.select({
        sessionId: envelope.session_id || envelope.session?.session_id,
      })
    } catch (e) {
      // 没有可用账号：可能是池子为空，也可能是全在冷却中。
      // 只有"本次请求观测到过 429"才对外报 429，否则保持 503。
      return exhaustedResult({ e, rateLimited, scheduler, attempts: tried.size, last })
    }

    const acc = picked.account
    if (tried.has(acc.id)) {
      // 选中的账号已经试过：本次 select 的占坑没人用，就地释放再退出
      scheduler.release(acc.id)
      break
    }
    tried.add(acc.id)

    // createResponse 会抛的情况：网络错、以及**流内失败**（上游过载时
    // HTTP 仍是 200，但流里发 response.failed / error，聚合阶段上抛）。
    //
    // 这里必须接住。不接的话异常会穿透整个函数，跳过换号逻辑，
    // 也跳过 scheduler.release —— 那个账号的并发额度就永久泄漏了，
    // 表现是「跑几十次之后突然所有账号都"没有可用名额"」。
    //
    // 归类规则与 HTTP 层保持一致：
    //   server_is_overloaded / 5xx 类  → 设冷却、换号
    //   其它（请求本身有问题）          → 不重试，原样上报
    let res
    try {
      res = await upstream.createResponse({
        account: acc,
        body,
        session: envelope.session,
        incomingHeaders,
        userAgent,
        installationId,
        stream: wantsStream,
        signal,
      })
    } catch (error) {
      scheduler.release(acc.id)
      // 客户端主动取消：直接把取消传出去，不要当成上游故障换号重试
      if (error?.name === 'AbortError' || signal?.aborted) throw error

      const code = String(error?.code || '')
      const transient = error?.upstream
        // server_error 也要算瞬时：上游内部错误（HTTP 200，流内报错）时
        // 立刻换号重试是对的，不换就会把一次可恢复的失败报成"上游拒绝"。
        // 实测抓到的形态：status=200 stream=server_error，
        // 被归进"上游拒绝"类，提示让人去查请求体 —— 方向完全错了。
        ? /overloaded|unavailable|timeout|rate|internal|server_error|server_is_overloaded/i.test(`${code} ${error.message}`)
        : true // 网络层异常（ECONNRESET / fetch failed / 超时）都算暂时性
      if (transient) {
        scheduler.markCooldown(acc.id, { status: error?.upstream?.status || 503, retryAfter: null, code })
        last = last || {
          status: 503,
          headers: {},
          stream: null,
          json: { error: { type: 'service_unavailable_error', code: code || 'upstream_stream_failed', message: String(error?.message || error) } },
          retryAfter: null,
        }
        continue
      }
      throw error
    }
    last = res
    // 每个上游响应都回调一次：额度读数（x-codex-*-used-percent / reset-at）
    // 只在这里拿得到，换号重试的中间账号同样要记。
    notifyResult(onResult, { accountId: acc.id, status: res.status, headers: res.headers })

    // 成功：提交亲和，并保留占坑给调用方（见函数注释）
    if (res.status >= 200 && res.status < 300) {
      scheduler.commitSuccess({
        sessionId: envelope.session_id || envelope.session?.session_id,
        accountId: acc.id,
      })
      return { ...res, accountId: acc.id, attempts: attempt, streamed: res.stream !== null }
    }

    // 失败：这条路径不会有响应体交给调用方，占坑在这里释放
    scheduler.release(acc.id)

    // 401：凭据问题，换号
    if (res.status === 401) {
      scheduler.markCooldown(acc.id, { status: 401, retryAfter: res.retryAfter })
      continue
    }
    // 429 / 5xx：限流或上游故障，换号
    if (res.status === 429 || res.status >= 500) {
      scheduler.markCooldown(acc.id, { status: res.status, retryAfter: res.retryAfter })
      if (res.status === 429) rateLimited.push(acc.id)
      continue
    }
    // 其他 4xx：请求本身有问题，不重试
    return { ...res, accountId: acc.id, attempts: attempt, streamed: false }
  }

  return exhaustedResult({ e: null, rateLimited, scheduler, attempts: tried.size, last })
}

/**
 * 全部账号都失败（或没有可用账号）时的对外结果。
 *
 * 决策顺序在 executeCodexRequest 的注释里；这里只落实现。
 * 429 的响应头只留上游诊断信息，Retry-After 由 HTTP 层按 retryAfter 字段设置，
 * 避免同一语义在两处各写一份、日后改动只改了一边。
 *
 * @param {object} p
 * @param {Error|null} p.e          select 抛出的错误（有可用账号时为空）
 * @param {string[]} p.rateLimited  本次请求里观测到 429 的账号 id
 * @param {number} p.attempts
 * @param {object|null} [p.last]    最后一次上游响应
 */
function exhaustedResult({ e = null, rateLimited = [], scheduler, attempts = 0, last = null }) {
  // 每个 429 账号的剩余冷却：取最短，最早能用的那个一恢复就值得重试
  const remaining = rateLimited
    .map((id) => cooldownRemainingSecs(scheduler, id))
    .filter((secs) => Number.isFinite(secs))
  const retryAfter = remaining.length ? Math.min(...remaining) : null
  const limited = retryAfter != null

  // 额度 park 造成的「无可用号」单独成一档。
  // 它和限流不是一回事：限流是上游已经拒绝过，我们的选择是退避重试；
  // 额度 park 是上游早就告诉过这个窗口满了，我们是主动不去撞。
  // 对外用 503 + quota_exhausted（与官方的 pool 语义一致），
  // 但额外给出 retry_after —— 窗口 reset 是确定的时刻，客户端没有理由盲目重试。
  const quotaRetryAt = !limited && Number.isFinite(Number(e?.retryAt)) ? Number(e.retryAt) : null
  const quotaSecs = quotaRetryAt == null
    ? null
    : Math.max(1, Math.ceil((quotaRetryAt - nowOf(scheduler)) / 1000))
  const quotaParked = quotaSecs != null

  const code = limited ? 'rate_limited' : (quotaParked ? 'quota_exhausted' : (e?.code || 'all_rejected'))
  const message = limited
    ? 'all accounts are rate limited by upstream'
    : (e?.message || 'all accounts failed')
  const effectiveRetryAfter = limited ? retryAfter : quotaSecs

  return {
    status: limited ? 429 : 503,
    // 上游的 x-codex-* 诊断头照旧透出：限流时正是排查额度最需要的信息
    headers: last?.headers || {},
    stream: null,
    json: {
      error: {
        type: limited ? 'rate_limit_error' : 'service_unavailable_error',
        code,
        message,
        ...(effectiveRetryAfter != null ? { retry_after: effectiveRetryAfter } : {}),
      },
    },
    retryAfter: effectiveRetryAfter,
    accountId: null,
    attempts,
    streamed: false,
  }
}

/** 调度器时钟（缺省回落到系统时钟），避免每个调用点各写一份。 */
function nowOf(scheduler) {
  return typeof scheduler?.now === 'function' ? scheduler.now() : Date.now()
}

/**
 * 上游响应回调的护栏。
 *
 * 采集（额度读数）属于旁路，任何异常都不能影响请求本身：
 * 一个写坏的观察者让正常请求失败，是最难排查的一类故障。
 */
function notifyResult(onResult, payload) {
  if (typeof onResult !== 'function') return
  try {
    onResult(payload)
  } catch {
    // 静默：观察数据的采集失败不该改变请求结果
  }
}
