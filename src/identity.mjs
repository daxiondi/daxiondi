/**
 * 客户端指纹、betas、cache TTL、错误映射与 stop_reason 映射。
 *
 * 职责：把要发往上游的请求"装扮"成官方 CLI 的样子——stainless 头、
 * user-agent、metadata.user_id、beta 顺序、缓存标记的 TTL 与数量、
 * 以及把上游错误/停止原因翻译成内核内部枚举。
 *
 * 关键约束：
 * 1. stainless 头是固定常量，来源版本号不要随意升级；上游按这组值判断客户端。
 * 2. beta 数组的顺序有语义：官方 beta 优先，调用方额外 beta 追加在后。
 * 3. cache marker 上限 4 个。超限时按 tools(倒序) → system(倒序) → messages
 *    的顺序删除；thinking / redacted_thinking 块的 marker 一律删除。
 * 4. metadata.user_id 超过 512 字节时按三级降级：先丢 extra，再只留 identity。
 * 5. 无代理时走 HTTP/2，有代理时退回 HTTP/1.1。这条决定 TLS ALPN 与帧结构，
 *    上游可以据此区分客户端，非代理场景保持 H2 才与官方一致。
 */

// ─────────────────── 指纹 ───────────────────

export const WRAP_OFFICIAL_STAINLESS = Object.freeze({
  lang: 'js',
  os: 'Linux',
  arch: 'x64',
  runtime: 'node',
  runtimeVersion: 'v26.3.0',
  packageVersion: '0.128.0',
})

export const STAINLESS_IDENTITY_KEYS = Object.freeze([
  'x-stainless-lang',
  'x-stainless-os',
  'x-stainless-arch',
  'x-stainless-runtime',
  'x-stainless-runtime-version',
  'x-stainless-package-version',
])

/** metadata.user_id 是 JSON 串，超 512 字节逐级降级 */
export const API_METADATA_MAX_ENCODED_BYTES = 512
/** 这些键名由客户端保留，不允许调用方通过 extra 覆盖 */
export const API_METADATA_RESERVED_KEYS = Object.freeze({
  ti: true, os: true, sb: true, he: true, uf: true, ap: true, tk: true,
})

export function officialCliVersion(env = process.env) {
  return String(env.CLAUDE_CODE_VERSION || '2.1.296')
}

export function officialCliUserAgent(env = process.env) {
  const entry = env.CLAUDE_CODE_ENTRYPOINT || 'sdk-cli'
  return `claude-cli/${officialCliVersion(env)} (external, ${entry})`
}

export function claudeCodeAppHeader(env = process.env) {
  return env.CLAUDE_CODE_SESSION_KIND === 'bg' ? 'cli-bg' : 'cli'
}

export function officialStainlessHeaders() {
  const s = WRAP_OFFICIAL_STAINLESS
  return {
    'x-stainless-lang': s.lang,
    'x-stainless-os': s.os,
    'x-stainless-arch': s.arch,
    'x-stainless-runtime': s.runtime,
    'x-stainless-runtime-version': s.runtimeVersion,
    'x-stainless-package-version': s.packageVersion,
    'x-stainless-retry-count': '0',
    'x-stainless-timeout': '600',
  }
}

/**
 * 组装 metadata.user_id，含三级降级。
 *
 * 只保留 string / number / boolean 三类标量值，对象与数组会被丢弃；
 * 保留键（ti/os/sb/he/uf/ap/tk）从 extra 里剔除，避免顶掉客户端字段。
 *
 * 降级顺序：{caller, extra, identity} → {caller, identity} → {identity}。
 * 每一步都重新测量字节数，超过 512 就进入下一级。
 */
export function assembleApiMetadata({ caller = {}, extra = {}, identity = {} }) {
  const cleanExtra = {}
  for (const key of Object.keys(extra)) {
    if (API_METADATA_RESERVED_KEYS[key]) continue
    const v = extra[key]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') cleanExtra[key] = v
  }
  const cleanIdentity = {}
  for (const key of Object.keys(identity)) {
    const v = identity[key]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') cleanIdentity[key] = v
  }
  let encoded = JSON.stringify({ ...caller, ...cleanExtra, ...cleanIdentity })
  if (encoded.length > API_METADATA_MAX_ENCODED_BYTES) {
    encoded = JSON.stringify({ ...caller, ...cleanIdentity })
    if (encoded.length > API_METADATA_MAX_ENCODED_BYTES) encoded = JSON.stringify(cleanIdentity)
  }
  return { user_id: encoded }
}

// ─────────────────── betas ───────────────────

export const OFFICIAL_MESSAGE_BETAS = Object.freeze([
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'per-turn-control-2026-07-01',
  'mid-conversation-tool-changes-2026-07-01',
  'effort-2025-11-24',
])

export const OFFICIAL_EXTRA_BETAS = Object.freeze([
  'thinking-token-count-2026-05-13',
  'mid-conversation-system-2026-04-07',
])

/**
 * 官方顺序优先，调用方额外的 betas 追加在后。
 *
 * 返回顺序由两段构成：先按 OFFICIAL_MESSAGE_BETAS 的定义序输出命中项，
 * 再按输入序追加剩余项。因此输入顺序不会打乱官方段的相对位置。
 */
export function mergeOfficialExtraBetas(betas = []) {
  const have = [...betas]
  for (const beta of OFFICIAL_EXTRA_BETAS) if (!have.includes(beta)) have.push(beta)
  const out = []
  for (const beta of OFFICIAL_MESSAGE_BETAS) if (have.includes(beta)) out.push(beta)
  for (const beta of have) if (!out.includes(beta)) out.push(beta)
  return out
}

// ─────────────────── cache TTL ───────────────────

export const MAX_CACHE_MARKERS = 4

/** 只认 5m / 1h 两种 TTL，其他值（含空值）返回 null */
export function normalizePanelCacheTtl(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === '5m' || raw === '1h') return raw
  return null
}

function cacheControlTtl(node) {
  if (!node || typeof node !== 'object' || !('cache_control' in node)) return undefined
  const control = node.cache_control
  if (!control || typeof control !== 'object' || !('ttl' in control)) return undefined
  return control.ttl
}

function noteExplicitTtl(node, seen) {
  if (Array.isArray(node)) {
    for (const item of node) noteExplicitTtl(item, seen)
    return
  }
  if (!node || typeof node !== 'object') return
  const ttl = normalizePanelCacheTtl(cacheControlTtl(node))
  if (ttl === '5m') seen.five = true
  else if (ttl === '1h') seen.hour = true
  if ('content' in node && Array.isArray(node.content)) noteExplicitTtl(node.content, seen)
}

/** 扫出显式 TTL；5m 优先于 1h（两者同时出现按 5m 处理） */
export function explicitCacheTtl(parts = []) {
  const seen = { five: false, hour: false }
  for (const part of parts) noteExplicitTtl(part, seen)
  if (seen.five) return '5m'
  if (seen.hour) return '1h'
  return null
}

/** 优先级：explicit → panel → 1h */
export function resolveKinCacheTtl({ system, tools, messages, panelTtl }) {
  return explicitCacheTtl([system, tools, messages]) ?? normalizePanelCacheTtl(panelTtl) ?? '1h'
}

function collectMarkers({ system, tools, messages }) {
  const hits = []
  const sys = Array.isArray(system) ? system : system != null ? [system] : []
  for (const block of sys) {
    if (block && typeof block === 'object' && block.cache_control) hits.push({ section: 'system', block })
  }
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool && typeof tool === 'object' && tool.cache_control) hits.push({ section: 'tools', block: tool })
    }
  }
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || !Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block && typeof block === 'object' && block.cache_control) hits.push({ section: 'messages', block })
      }
    }
  }
  return hits
}

/** thinking / redacted_thinking 块的 cache_control 一律删除（上游不接受这两类块的缓存标记） */
export function dropThinkingMarkers(params) {
  if (!Array.isArray(params.messages)) return
  for (const message of params.messages) {
    if (!message || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      if (block.type !== 'thinking' && block.type !== 'redacted_thinking') continue
      if ('cache_control' in block) delete block.cache_control
    }
  }
}

/**
 * 给单个块补 TTL。三种情况跳过：
 *   - 没有 cache_control；
 *   - cache_control 不是对象；
 *   - type 存在且不是 ephemeral，或已带合法 ttl。
 * 保留原 scope（global / org），其余字段重建。
 */
function stampBlock(block, ttl) {
  if (!block || typeof block !== 'object' || !block.cache_control) return
  const control = block.cache_control
  if (typeof control !== 'object') return
  if (control.type != null && control.type !== 'ephemeral') return
  if (control.ttl && normalizePanelCacheTtl(control.ttl)) return
  const next = { type: 'ephemeral', ttl }
  if (control.scope === 'global' || control.scope === 'org') next.scope = control.scope
  block.cache_control = next
}

/**
 * 只补"缺 ttl 的 ephemeral marker"。
 * 请求里完全没有显式 TTL 时整体不做处理——此时上游使用默认 TTL，
 * 补值会凭空改变缓存行为。
 */
export function fillMissingCacheTtl(params, ttl) {
  if (!explicitCacheTtl([params.system, params.tools, params.messages])) return
  const sys = Array.isArray(params.system) ? params.system : [params.system]
  for (const block of sys) stampBlock(block, ttl)
  if (Array.isArray(params.tools)) for (const tool of params.tools) stampBlock(tool, ttl)
  if (!Array.isArray(params.messages)) return
  for (const message of params.messages) {
    if (!message || !Array.isArray(message.content)) continue
    for (const block of message.content) stampBlock(block, ttl)
  }
}

/**
 * 超限时删除多余 marker：先删 thinking 块上的，再按
 * tools(倒序) → system(倒序) → messages 的顺序删，直到落到上限。
 * 保留 messages 上的 marker 是有意的：它标记对话尾部，删掉会失去增量缓存收益。
 */
export function capCacheMarkers(params, maximum = MAX_CACHE_MARKERS) {
  dropThinkingMarkers(params)
  const live = collectMarkers(params).filter((loc) => loc.block.cache_control)
  if (live.length <= maximum) return
  const tools = live.filter((l) => l.section === 'tools')
  const system = live.filter((l) => l.section === 'system')
  const messages = live.filter((l) => l.section === 'messages')
  const order = [...tools.reverse(), ...system.reverse(), ...messages]
  for (const loc of order.slice(0, live.length - maximum)) delete loc.block.cache_control
}

/**
 * 只保留最后一个 message 块的 marker。
 *
 * 顺带做两件规范化：字符串 content 转成单 text 块；thinking 块从 content 里
 * 剥离（它们的 marker 也一并删除）。最后按 ensureTail 决定是否在尾部块上
 * 补一个 ephemeral marker。
 */
export function keepSingleMessageCacheMarker(messages, { ensureTail = false } = {}) {
  if (!Array.isArray(messages)) return
  const marked = []
  let tail = null
  for (const message of messages) {
    if (!message || typeof message !== 'object' || !('content' in message)) continue
    const content = message.content
    if (typeof content === 'string') {
      if (!content) continue
      const block = { type: 'text', text: content }
      message.content = [block]
      tail = [block]
      continue
    }
    if (!Array.isArray(content) || content.length === 0) continue
    const blocks = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        delete block.cache_control
        continue
      }
      blocks.push(block)
      if (block.cache_control) marked.push(block)
    }
    if (blocks.length > 0) tail = blocks
  }
  const anchor = tail?.[tail.length - 1]
  for (const block of marked) if (block !== anchor) delete block.cache_control
  if (!ensureTail || !anchor || anchor.cache_control) return
  anchor.cache_control = { type: 'ephemeral' }
}

// ─────────────────── 错误映射 ───────────────────

const TYPE_TO_STATUS = Object.freeze({
  rate_limit_error: 429,
  authentication_error: 401,
  permission_error: 403,
  invalid_request_error: 400,
  timeout_error: 504,
})

/**
 * 把上游错误规范化成内核的 job_error 结构。
 *
 * status 取值优先级：显式入参 → body.error.status（限 400–599）→ 按 type 查表 → 502。
 * 529 与 overloaded_error 单独归一，标记为 upstream_overloaded，
 * 控制面据此走重试而不是 failover。
 *
 * 输出结构是控制面的读取契约：字段名、错误码与截断长度都要保持一致，
 * 否则对端的 failover 判断会失效。
 */
export function classifyUpstreamError({ body, status, raw, headers }) {
  const inner = body?.error ?? body ?? {}
  const type = typeof inner.type === 'string' ? inner.type.trim() : ''
  let finalStatus = status
  if (finalStatus === undefined && typeof inner.status === 'number' && inner.status >= 400 && inner.status < 600) {
    finalStatus = inner.status
  }
  if (finalStatus === undefined) finalStatus = TYPE_TO_STATUS[type] ?? 502

  const clip = (s) => String(s || '').trim().slice(0, 300)
  const message = clip(inner.message || raw || `upstream HTTP ${finalStatus}`)
  const retryAfter = headerOf(headers, 'retry-after') || (typeof inner.retry_after === 'string' ? inner.retry_after : '')
  const upstreamCode = clip(inner.code).slice(0, 100)
  const requestId = (
    headerOf(headers, 'request-id') ||
    inner.request_id ||
    body?.request_id ||
    ''
  ).slice(0, 200)

  const base = {
    error: message,
    status: finalStatus,
    ...(retryAfter ? { retry_after: retryAfter } : {}),
    ...(upstreamCode ? { upstream_code: upstreamCode } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  }
  if (finalStatus === 529 || type === 'overloaded_error') {
    return { ...base, status: 529, code: 'upstream_overloaded', error_type: 'overloaded_error' }
  }
  return { ...base, code: 'upstream_error', error_type: type || 'api_error' }
}

function headerOf(headers, name) {
  if (!headers) return undefined
  if (typeof headers.get === 'function') {
    const v = headers.get(name)
    return typeof v === 'string' && v.trim() ? v.trim() : undefined
  }
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === name) {
      return typeof value === 'string' && value.trim() ? value.trim() : undefined
    }
  }
  return undefined
}

/** 只透传这几类限流域头（anthropic-ratelimit-* / retry-after / request-id） */
export function pickRateLimitHeaders(headers) {
  const out = {}
  if (!headers) return out
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers)
  for (const [key, value] of entries) {
    if (value == null || value === '') continue
    const lower = String(key).toLowerCase()
    if (lower.startsWith('anthropic-ratelimit-') || lower === 'retry-after' || lower === 'request-id') {
      out[lower] = String(value)
    }
  }
  return out
}

// ─────────────────── stop_reason 映射 ───────────────────

/** 内核内部枚举判别值。数值即 wire 上的编码，不可重排。 */
export const STOP_REASON_ENUM = Object.freeze({
  end_turn: 0,
  tool_use: 1,
  max_tokens: 2,
  stop_sequence: 3,
  pause_turn: 4,
  refusal: 5,
  model_context_window_exceeded: 6,
  unknown: 7,
})

/**
 * api 路径的 stop_reason 映射：8 态，先按长度窗口 [7,29] 过滤。
 * 长度窗口是上游枚举值的最短/最长边界，越界值直接判 unknown，
 * 避免拿异常长的输入做后续比较。
 */
export function mapStopReason(raw) {
  const s = String(raw ?? '')
  if (s.length < 7 || s.length > 29) return STOP_REASON_ENUM.unknown
  if (s === 'end_turn') return STOP_REASON_ENUM.end_turn
  if (s === 'tool_use') return STOP_REASON_ENUM.tool_use
  if (s === 'max_tokens') return STOP_REASON_ENUM.max_tokens
  if (s === 'stop_sequence') return STOP_REASON_ENUM.stop_sequence
  if (s === 'pause_turn') return STOP_REASON_ENUM.pause_turn
  if (s === 'refusal') return STOP_REASON_ENUM.refusal
  if (s === 'model_context_window_exceeded') return STOP_REASON_ENUM.model_context_window_exceeded
  return STOP_REASON_ENUM.unknown
}

/**
 * native CLI 路径的 stop_reason 映射：精简版，只认长度窗口 [7,13]，
 * 超长直接判 end_turn(0)。
 *
 * 这是两条路径的行为差异：native 路径的取值集合更窄，
 * 未识别的值兜底成 end_turn 而不是 unknown，调用方据此判断"正常结束"。
 */
export function nativeStopReason(raw) {
  const s = String(raw ?? '')
  if (s.length > 13) return STOP_REASON_ENUM.end_turn
  if (s === 'refusal') return STOP_REASON_ENUM.refusal
  if (s === 'tool_use') return STOP_REASON_ENUM.tool_use
  if (s === 'max_tokens') return STOP_REASON_ENUM.max_tokens
  if (s === 'stop_sequence') return STOP_REASON_ENUM.stop_sequence
  if (s === 'pause_turn') return STOP_REASON_ENUM.pause_turn
  return STOP_REASON_ENUM.end_turn
}

// ─────────── 上游 HTTP 协议选择 ───────────

/**
 * 官方 CLI 在**没有代理**时走 HTTP/2（undici Agent { allowH2: true }）。
 * 有代理时自动退回 HTTP/1.1。
 *
 * 这条对指纹很关键：HTTP/2 与 HTTP/1.1 的 TLS ALPN、帧结构都不同，
 * 上游能区分。自研若要拟真，无代理场景必须开 H2。
 *
 * @param {object} env process.env
 * @returns {'h2'|'h1'}
 */
export function resolveUpstreamProtocol(env = {}) {
  const proxied =
    env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY || env.http_proxy ||
    env.ANTHROPIC_UNIX_SOCKET
  return proxied ? 'h1' : 'h2'
}
