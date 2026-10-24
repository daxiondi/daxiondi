/**
 * Anthropic Messages API 出站客户端（HTTP + SSE）。
 *
 * 职责边界：输入是 prepareOutbound 组装好的 body，输出是上游的 SSE 流或
 * 聚合后的完整 message。本模块**不碰**提示词组装、不改缓存断点、不算 cch、
 * 不决定 beta 语义——那些在 prepareOutbound 里已经完成。它只负责
 * 「把组装好的东西按官方客户端的形态发出去，并把读回来的字节解释成事件」。
 *
 * 与 Codex 通道的差别：Codex 上游的线协议**恒为流式**，非流式只能靠聚合；
 * Anthropic 的 Messages API 两条线都支持（`stream:true` 出 SSE，
 * 不带 `stream` 出完整 JSON）。因此这里把「线协议形态」与「返回给调用方的形态」
 * 拆成两个独立开关（见 MODE）。
 *
 * 关键约束（每一条都对应一次真实被拒或一次形态暴露）：
 *
 * 1. **必须显式带 `stream:true` 才出 SSE**。传 `stream:false` 不是「非流式」，
 *    而是多出一个与官方客户端不符的字段；官方客户端非流式时**根本不发**这个键。
 *    因此非流式一律 `delete body.stream`，绝不写 false。
 *
 * 2. **不要手动设 content-length**。body 可能被 zstd 压缩，手写的长度会和
 *    实际字节数冲突；交给运行时按最终字节数填写。
 *
 * 3. **只有真压缩了才设 content-encoding**。运行时没有 zstd（Node < 22）时
 *    退化为明文，此时若还留着 `content-encoding: zstd`，上游会把明文当压缩体
 *    解析，返回一个不带错误信息的裸 `Bad Request`。
 *
 * 4. **betas 走请求头，不进 body**。`body.betas` 是内核内部字段，直接发给上游
 *    会 400 `unexpected field`；出站前必须摘掉并折进 `anthropic-beta`。
 *
 * 5. **请求头的取值必须成组**：user-agent 声明 cli，`x-app` 必须也是 cli；
 *    billing header 里的 `cc_entrypoint=sdk-cli` 与 UA 是同一组身份。三者对不上
 *    会形成一组可识别的矛盾特征。
 *
 * 6. **SSE 的 data 可能跨多行**。规范允许一个事件有多条 `data:` 行，客户端必须
 *    按 `\n` 拼接后再解析；只取最后一行会截断 JSON。
 *
 * 7. **流式判定不看响应 content-type**。上游的 SSE 响应偶有 content-type 缺失，
 *    靠它判断会对一条永不结束的事件流调 json()，表现为请求挂到超时。
 *    这里由调用方声明的 mode 决定，不看响应头。
 */

import zlib from 'node:zlib'
import {
  officialCliUserAgent,
  officialStainlessHeaders,
  claudeCodeAppHeader,
  mergeOfficialExtraBetas,
  resolveUpstreamProtocol,
} from './identity.mjs'
import { joinBetas, claudeCodeMimicryBetas } from './betas.mjs'
import { sanitizeAnthropicBody } from './sanitize.mjs'

// ─────────────────── 常量 ───────────────────

/** Messages API 的协议版本。这个值由上游固定，不是可配置项。 */
export const ANTHROPIC_VERSION = '2023-06-01'

export const DEFAULT_BASE_URL = 'https://api.anthropic.com'

/** 缺省整体超时。与官方 CLI 的 x-stainless-timeout（600s）同一档。 */
export const DEFAULT_TIMEOUT_MS = 600_000

/**
 * 压缩阈值。小于它的 body 压了反而更大（zstd 帧头 + 更快耗掉 CPU），
 * 上游也不要求压缩，因此只在超过阈值时才压。
 */
export const DEFAULT_COMPRESS_THRESHOLD = 1024

/** 错误响应体最多读这么多字节，避免一个畸形大响应把内存吃满 */
export const MAX_ERROR_BODY_BYTES = 256 * 1024

/** SSE 单帧上限。超限视为协议错误，直接终止而不是无限攒。 */
export const MAX_SSE_FRAME_BYTES = 4 * 1024 * 1024

export const ACCEPT_SSE = 'text/event-stream'
export const ACCEPT_JSON = 'application/json'

/** 线协议形态 + 返回形态的三个组合，见文件头说明。 */
export const MODE = Object.freeze({
  /** 上游 SSE，原样交出事件流 */
  STREAM: 'stream',
  /** 上游 SSE，本地聚合成完整 message 后交出 */
  AGGREGATE: 'aggregate',
  /** 上游 JSON（body 不带 stream 键），交出解析后的 JSON */
  DOCUMENT: 'document',
})

/** 错误分类。控制面按 kind 决定刷新 / 退避 / 直接透出。 */
export const ERROR_KIND = Object.freeze({
  OK: 'ok',
  NEEDS_REFRESH: 'needs_refresh',
  RATE_LIMITED: 'rate_limited',
  OVERLOADED: 'overloaded',
  SERVER_ERROR: 'server_error',
  INVALID_REQUEST: 'invalid_request',
  NETWORK: 'network',
})

// ─────────────────── URL ───────────────────

/**
 * baseUrl → /v1/messages。
 *
 * baseUrl 可能是 `https://api.anthropic.com` 也可能带尾斜杠或已带 `/v1`，
 * 三种写法都要归一到同一个终点，否则会出现 `/v1/v1/messages`。
 */
export function messagesUrl(baseUrl = DEFAULT_BASE_URL) {
  const raw = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
  if (!raw) return `${DEFAULT_BASE_URL}/v1/messages`
  if (/\/v1$/i.test(raw)) return `${raw}/messages`
  return `${raw}/v1/messages`
}

// ─────────────────── betas ───────────────────

/**
 * 合并调用方声明的 beta（header + body 内部字段），去重保序，不注入任何东西。
 *
 * 纯合并：用于「我已经知道完整 beta 列表，只想去重」的场景，以及测试。
 * 出站请用 buildBetaHeader——它会在合并前注入官方拟真基础集。
 */
export function resolveBetaList({ headerBetas = [], bodyBetas = [] } = {}) {
  const out = []
  for (const beta of [...toBetaArray(headerBetas), ...toBetaArray(bodyBetas)]) {
    if (beta && !out.includes(beta)) out.push(beta)
  }
  return out
}

/**
 * 决定出站 `anthropic-beta` 的取值。
 *
 * 语义是「官方拟真基础集 ∪ 调用方额外声明」，而不是「调用方给了就只用调用方的」。
 * 这个区分很关键：`claude-code-20250219` 与 `oauth-2025-04-20` 不是可选特性开关，
 * 它们声明「这是一个 Claude Code 客户端、用 OAuth 鉴权」。缺了它们，上游会按
 * 另一版协议解释这份请求，表现为 OAuth token 被当成非法凭据直接 401。
 * 而 prompt-profiles 产出的 body.betas 往往只有 `extended-cache-ttl` 一项，
 * 若按「有则覆盖」处理，基础集会整段丢失。
 *
 * 排序走 mergeOfficialExtraBetas：官方枚举序在前（这一段决定上游按哪版协议解释），
 * 调用方额外项追加在后。顺序是协议语义，不能因输入顺序不同而变。
 *
 * @param {object} p
 * @param {string|string[]} [p.headerBetas] 入站 anthropic-beta 头
 * @param {string|string[]} [p.bodyBetas]   body 内部 betas 字段（内核内部约定，不出站）
 * @param {boolean} [p.includeMimicry]      是否注入拟真基础集，缺省 true
 */
export function buildBetaHeader({ headerBetas = [], bodyBetas = [], includeMimicry = true } = {}) {
  const extra = resolveBetaList({ headerBetas, bodyBetas })
  if (!includeMimicry) return extra
  return mergeOfficialExtraBetas([...claudeCodeMimicryBetas(), ...extra])
}

/** 头值可能已是逗号串，也可能是数组；两种都接。 */
function toBetaArray(value) {
  if (value == null) return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// ─────────────────── 请求头 ───────────────────

/**
 * 组装出站请求头。
 *
 * 顺序按「身份 → 协议 → 内容 → 客户端指纹」排，方便人读和 diff；
 * HTTP 语义上顺序不影响结果。
 *
 * `authScheme`：
 *   - 'oauth'（缺省）→ `authorization: Bearer <token>`，官方 CLI 登录态的做法
 *   - 'api_key'      → `x-api-key: <token>`，控制台 key 的做法
 * 两者互斥：同时发两个会被上游按不同的鉴权路径处理，行为不确定。
 *
 * 这里**不设** content-length / content-encoding：两者由 encodeBody 的结果决定。
 */
export function buildOutboundHeaders({
  token = '',
  authScheme = 'oauth',
  betas = [],
  accept = ACCEPT_SSE,
  env = process.env,
  extra = {},
} = {}) {
  const headers = {}
  if (authScheme === 'api_key') {
    if (token) headers['x-api-key'] = String(token)
  } else if (token) {
    headers.authorization = `Bearer ${token}`
  }
  headers['anthropic-version'] = ANTHROPIC_VERSION
  const betaHeader = joinBetas(betas)
  if (betaHeader) headers['anthropic-beta'] = betaHeader
  headers['user-agent'] = officialCliUserAgent(env)
  headers['x-app'] = claudeCodeAppHeader(env)
  headers['content-type'] = 'application/json'
  headers.accept = accept
  Object.assign(headers, officialStainlessHeaders())
  // 调用方额外头放最后，但仍要过一遍保留键过滤（见 stripForbiddenHeaders）
  for (const [key, value] of Object.entries(extra || {})) headers[key] = value
  return stripForbiddenHeaders(headers)
}

/** 这些头由传输层按实际字节数决定，调用方给的必须是噪声，一律剔除 */
const FORBIDDEN_HEADERS = Object.freeze(['content-length', 'transfer-encoding'])

/**
 * 剔除会与真实字节数冲突的头，并把键名统一成小写。
 * HTTP 头名大小写不敏感，但对象里留两种写法会让「有没有设过」这类判断出错。
 */
export function stripForbiddenHeaders(headers = {}) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue
    const lower = String(key).toLowerCase()
    if (FORBIDDEN_HEADERS.includes(lower)) continue
    out[lower] = typeof value === 'string' ? value : String(value)
  }
  return out
}

// ─────────────────── 请求体 ───────────────────

/**
 * 摘掉只属于内核内部、不能出站的字段。
 *
 * `betas` / `__betas__` 是 prompt-profiles 与 betas.mjs 之间的内部约定，
 * 上游 schema 里没有这两个键，带上去是 400 `unexpected field`。
 * 返回深拷贝：出站 body 的改写不能回流到调用方手里的对象。
 */
export function stripInternalFields(body) {
  if (!body || typeof body !== 'object') return {}
  // 委托给 sanitize.mjs 的完整清洗。
  //
  // 这里原来只删 betas / __betas__，其余全部透传 —— 包括
  // machine_id / device_id / account_uuid / session 这些内部标记。
  // 它们发给上游等于自证"请求被中间层加工过"，是直接的封号面。
  // 同时 OpenAI 残留（store / response_format / reasoning 等）
  // 会让 Anthropic schema 报 400 unexpected field。
  //
  // 对齐官方 v1.3.220 的 protocol/sanitize.mjs：60+ 键黑名单 +
  // 先救 response_format 成 output_config + 清 content 的 annotations。
  return sanitizeAnthropicBody(body)
}

/**
 * 按 mode 决定线协议字段。
 *
 * - stream / aggregate：显式 `stream:true`
 * - document：**删除** stream 键（不是写 false）
 *
 * 这一条是硬约束：官方客户端非流式时不带该键，写 false 等于凭空多一个字段。
 */
export function applyStreamFlag(body, mode) {
  const out = { ...body }
  if (mode === MODE.DOCUMENT) delete out.stream
  else out.stream = true
  return out
}

/**
 * 序列化 + 按阈值压缩。
 *
 * 返回值里的 `encoding` 是「实际发生了压缩」的唯一真相：
 * 头必须由它决定，不能由「我打算压缩」决定。运行时没有 zstd 时
 * 退化为明文并把 encoding 记成 null，此时绝不设 content-encoding。
 */
export function encodeBody(body, { threshold = DEFAULT_COMPRESS_THRESHOLD, zstd = zlib.zstdCompressSync } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  const raw = Buffer.from(text, 'utf8')
  const canCompress = typeof zstd === 'function'
  if (!canCompress || raw.length < threshold) {
    return { payload: raw, encoding: null, jsonText: text, wireBytes: raw.length }
  }
  const compressed = zstd(raw)
  const buf = Buffer.isBuffer(compressed) ? compressed : Buffer.from(compressed)
  // 压缩后反而更大时不设头：那不是压缩，只是加了帧头
  if (buf.length >= raw.length) {
    return { payload: raw, encoding: null, jsonText: text, wireBytes: raw.length }
  }
  return { payload: buf, encoding: 'zstd', jsonText: text, wireBytes: buf.length }
}

// ─────────────────── 错误分类 ───────────────────

/**
 * 状态码 → 语义分类。
 *
 * 分类决定调用方下一步动作，因此必须与上游语义一致：
 *   401 → 刷新凭据后重试（唯一会触发刷新的分支）
 *   429 → 按 retry-after 退避，不换号/不重试都会放大限流
 *   529 → 上游过载，整体退避，属于可重试
 *   5xx → 可重试，但要与 4xx 区分：4xx 重试只会重复浪费一次配额
 *   其他 4xx → 请求本身有问题，原样透出，不重试
 */
export function classifyStatus(status, { retryAfter = null } = {}) {
  const code = Number(status)
  if (code >= 200 && code < 300) return { kind: ERROR_KIND.OK, status: code, retryable: false, needs_refresh: false, retry_after: null }
  if (code === 401) {
    return { kind: ERROR_KIND.NEEDS_REFRESH, status: 401, retryable: false, needs_refresh: true, retry_after: null }
  }
  if (code === 429) {
    return { kind: ERROR_KIND.RATE_LIMITED, status: 429, retryable: true, needs_refresh: false, retry_after: retryAfter }
  }
  if (code === 529) {
    return { kind: ERROR_KIND.OVERLOADED, status: 529, retryable: true, needs_refresh: false, retry_after: retryAfter }
  }
  if (code >= 500) {
    return { kind: ERROR_KIND.SERVER_ERROR, status: code, retryable: true, needs_refresh: false, retry_after: retryAfter }
  }
  return { kind: ERROR_KIND.INVALID_REQUEST, status: code, retryable: false, needs_refresh: false, retry_after: null }
}

/**
 * retry-after → 秒。只接受两种形态：纯十进制秒数与 HTTP-date。
 * 其他形态（带单位、小数）返回 null，交给调用方用缺省退避。
 */
export function parseRetryAfter(headers) {
  const raw = headerOf(headers, 'retry-after')
  if (raw == null) return null
  const text = String(raw).trim()
  if (!text) return null
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  // HTTP-date 只认 IMF-fixdate / RFC 850 / asctime 三种官方形态。
  // 不直接 Date.parse 的原因：`1.5`、`30s` 这类串在 V8 里也会被宽松解析，
  // 于是一个本该被忽略的畸形值会变成一个"看起来合法"的 0 秒。
  if (!HTTP_DATE_RE.test(text)) return null
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return null
  const secs = Math.ceil((at - Date.now()) / 1000)
  return secs > 0 ? secs : 0
}

/** HTTP-date 的三种官方形态（RFC 7231 §7.1.1.1） */
const HTTP_DATE_RE = /^(?:[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]+, \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/

/** 从 Headers 实例或普通对象里取一个头（大小写不敏感） */
export function headerOf(headers, name) {
  if (!headers) return undefined
  const key = String(name).toLowerCase()
  if (typeof headers.get === 'function') {
    const v = headers.get(key)
    return v == null ? undefined : v
  }
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === key) return v == null ? undefined : String(v)
  }
  return undefined
}

/** Headers 实例 / 普通对象 → 全小写普通对象（响应头要原样透出给客户端） */
export function headersToObject(headers) {
  const out = {}
  if (!headers) return out
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value)
    })
    return out
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    out[String(key).toLowerCase()] = String(value)
  }
  return out
}

// ─────────────────── SSE 解析 ───────────────────

/**
 * 增量 SSE 解析器。
 *
 * 逐行处理，按空行切帧。三条容易漏的规则：
 *   1. `data:` 可重复多次，同一事件的多个 data 行按 `\n` 拼接；
 *   2. 以 `:` 开头的是注释（心跳），必须忽略而不是当数据；
 *   3. 帧末尾可能没有空行就断流（上游半包收尾），残留帧也要吐出。
 */
export class SseParser {
  constructor() {
    this.buf = ''
    this.event = null
    this.dataLines = []
    this.id = null
    this.bytes = 0
    this.stopped = false
    // 必须跨 chunk 复用同一个解码器。
    // {stream:true} 只是"允许这次不完整的多字节序列暂存到下一次"，
    // 暂存位置在解码器实例内部；每次 push 新建实例等于把暂存的尾字节丢掉，
    // 一个中文字符只要跨了 chunk 边界就会变成替换符。
    // 真实网络的 chunk 边界是任意的，所以这不是理论问题。
    this.decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null
  }

  /**
   * 吃一段字节/字符串，返回本段能完整切出的事件数组。
   * @param {string|Uint8Array} chunk
   */
  push(chunk) {
    if (typeof chunk === 'string') return this.#feed(chunk)
    if (!this.decoder) return this.#feed(Buffer.from(chunk).toString('utf8'))
    this.decoderStreamed = true
    return this.#feed(this.decoder.decode(chunk, { stream: true }))
  }

  /**
   * 收尾：把没有换行符结尾的最后一行补上，再吐出没有以空行结束的残留帧。
   *
   * 上游半包收尾（连接被切断、或客户端主动结束读取）时最后一帧往往既没有
   * 结尾换行也没有空行；不补这一步，最后一个事件会整帧丢掉。
   */
  flush() {
    const out = []
    // 收尾：把解码器里暂存的最后一个不完整序列吐出来。
    // 缺这一步时，流末尾落在多字节字符中间会静默丢字符（不上报错）。
    if (this.decoder && this.decoderStreamed) {
      try {
        const tail = this.decoder.decode()
        if (tail) this.buf += tail
      } catch {
        /* 截断序列无法还原，保持已解出的部分 */
      }
      this.decoderStreamed = false
    }
    if (this.buf) {
      const line = this.buf.replace(/\r$/, '')
      this.buf = ''
      if (line && !line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') this.event = value.trim()
        else if (field === 'data') this.dataLines.push(value)
        else if (field === 'id') this.id = value.trim()
      }
    }
    if (this.dataLines.length > 0) {
      const frame = this.#takeFrame()
      if (frame) out.push(frame)
    }
    this.event = null
    this.dataLines = []
    this.id = null
    return out
  }

  #feed(text) {
    this.buf += text
    const out = []
    let idx
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '')
      this.buf = this.buf.slice(idx + 1)
      this.bytes += line.length
      if (this.bytes > MAX_SSE_FRAME_BYTES) {
        throw Object.assign(new Error('sse frame too large'), { code: 'sse_frame_too_large' })
      }
      if (line === '') {
        const frame = this.#takeFrame()
        if (frame) out.push(frame)
        if (frame?.done) {
          this.stopped = true
          return out
        }
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      // 规范：冒号后若有一个空格，去掉它；多个空格保留
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') this.event = value.trim()
      else if (field === 'data') this.dataLines.push(value)
      else if (field === 'id') this.id = value.trim()
      // retry / 其他字段：与消息流无关，丢弃
    }
    return out
  }

  #takeFrame() {
    if (this.dataLines.length === 0) {
      this.event = null
      this.id = null
      return null
    }
    const data = this.dataLines.join('\n')
    const event = this.event
    const id = this.id
    this.event = null
    this.dataLines = []
    this.id = null
    if (data.trim() === '[DONE]') {
      return { event: event ?? 'done', data: '[DONE]', id, done: true }
    }
    let parsed = data
    try {
      parsed = JSON.parse(data)
    } catch {
      /* 非 JSON 的 data 原样保留：上游偶尔会发纯文本错误提示 */
    }
    return { event, data: parsed, id, done: false }
  }
}

/**
 * 一次性把整段文本解析成事件数组（测试与回放用）。
 * 与流式解析共用同一套规则，避免两套实现产生分歧。
 */
export function parseSseText(text) {
  const parser = new SseParser()
  return [...parser.push(String(text ?? '')), ...parser.flush()]
}

// ─────────────────── 聚合 ───────────────────

/**
 * 把 SSE 事件序列聚合成一个完整的 Messages 响应。
 *
 * 聚合规则（对应上游事件语义）：
 *   message_start        → id / model / role / usage 的初值
 *   content_block_start  → 在 index 位置开一个块（原样复制 content_block）
 *   content_block_delta  → 按 delta.type 追加：text_delta 拼文本、
 *                          input_json_delta 拼 tool_use 的参数 JSON、
 *                          thinking_delta / signature_delta 拼对应字段
 *   content_block_stop   → 收尾该块（tool_use 的 partial_json 解析成 input）
 *   message_delta        → stop_reason / stop_sequence / usage 的终值
 *   message_stop         → 结束
 *   error                → 抛错（带上游原始 error 对象）
 *
 * usage 用「深合并一层」：message_start 给 input_tokens，message_delta 给
 * output_tokens，两者必须叠加而不是覆盖。
 */
export function collectMessage(events) {
  const message = {
    id: null,
    type: 'message',
    role: 'assistant',
    model: null,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {},
  }
  const partialJson = new Map()
  let sawMessage = false
  let stopReasonSeen = false
  let stopSequenceSeen = false

  for (const frame of events) {
    if (!frame || frame.done) continue
    const data = frame.data
    if (!data || typeof data !== 'object') continue
    const type = data.type || frame.event

    if (type === 'error') {
      throw Object.assign(new Error(data?.error?.message || 'upstream stream error'), {
        code: 'upstream_stream_error',
        detail: data,
      })
    }
    if (type === 'message_start') {
      sawMessage = true
      const src = data.message || {}
      if (src.id) message.id = src.id
      if (src.model) message.model = src.model
      if (src.role) message.role = src.role
      if (src.type) message.type = src.type
      if (src.usage) message.usage = mergeUsage({}, src.usage)
      continue
    }
    if (type === 'content_block_start') {
      const index = Number.isInteger(data.index) ? data.index : message.content.length
      const block = data.content_block && typeof data.content_block === 'object'
        ? JSON.parse(JSON.stringify(data.content_block))
        : { type: 'text', text: '' }
      message.content[index] = block
      if (block.type === 'text' && typeof block.text !== 'string') block.text = ''
      if (block.type === 'tool_use') partialJson.set(index, '')
      continue
    }
    if (type === 'content_block_delta') {
      const index = Number.isInteger(data.index) ? data.index : 0
      const block = message.content[index]
      if (!block) continue
      const delta = data.delta || {}
      if (delta.type === 'text_delta') block.text = String(block.text ?? '') + String(delta.text ?? '')
      else if (delta.type === 'input_json_delta') {
        partialJson.set(index, (partialJson.get(index) ?? '') + String(delta.partial_json ?? ''))
      } else if (delta.type === 'thinking_delta') {
        block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? '')
      } else if (delta.type === 'signature_delta') {
        block.signature = String(block.signature ?? '') + String(delta.signature ?? '')
      } else if (delta.type === 'citations_delta' && delta.citation) {
        block.citations = [...(block.citations || []), delta.citation]
      }
      continue
    }
    if (type === 'content_block_stop') {
      const index = Number.isInteger(data.index) ? data.index : 0
      const block = message.content[index]
      const partial = partialJson.get(index)
      partialJson.delete(index)
      if (block && block.type === 'tool_use' && typeof partial === 'string') {
        try {
          block.input = partial ? JSON.parse(partial) : {}
        } catch {
          // 半截 JSON 不能当成功：把原文留在 input 之外，让调用方看见问题
          block.input = {}
          block.input_json = partial
        }
      }
      continue
    }
    if (type === 'message_delta') {
      const delta = data.delta || {}
      if ('stop_reason' in delta) {
        message.stop_reason = delta.stop_reason
        stopReasonSeen = true
      }
      if ('stop_sequence' in delta) {
        message.stop_sequence = delta.stop_sequence
        stopSequenceSeen = true
      }
      if (data.usage) message.usage = mergeUsage(message.usage, data.usage)
      continue
    }
    if (type === 'message_stop') continue
  }

  // 只出现过 message_start 却没见到 stop_reason：上游截断。
  // 不编造 end_turn，留 null 让调用方按「未知结束」处理。
  if (!sawMessage && message.content.length === 0) {
    throw Object.assign(new Error('upstream stream produced no message events'), { code: 'empty_stream' })
  }
  if (stopReasonSeen) message.stop_reason = message.stop_reason
  if (stopSequenceSeen) message.stop_sequence = message.stop_sequence
  // 稀疏数组（index 跳号）压缩成连续数组，否则 JSON.stringify 会补 null
  message.content = message.content.filter(Boolean)
  return message
}

/**
 * usage 合并：对象合并一层，标量覆盖，数组整体替换。
 *
 * 只做一层是有意的：usage 的嵌套结构固定（input_tokens_details 之类），
 * 更深的层级整体替换即可，再递归只会把两轮快照混在一起。
 */
export function mergeUsage(current, next) {
  if (!next || typeof next !== 'object') return { ...(current || {}) }
  const out = { ...(current || {}) }
  for (const [key, value] of Object.entries(next)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const base = out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] : {}
      out[key] = { ...base, ...value }
    } else {
      out[key] = value
    }
  }
  return out
}

// ─────────────────── 出站客户端 ───────────────────

export class AnthropicUpstream {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl]      上游 base，缺省 https://api.anthropic.com
   * @param {Function} [opts.fetchImpl]  注入 fetch（测试用），缺省全局 fetch
   * @param {number} [opts.timeoutMs]    整体超时
   * @param {number} [opts.compressThreshold] 压缩阈值（字节）
   * @param {Function|null} [opts.zstd]  zstd 压缩实现，null 表示不压缩
   */
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    compressThreshold = DEFAULT_COMPRESS_THRESHOLD,
    zstd = zlib.zstdCompressSync ?? null,
    clock = () => Date.now(),
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch is not available; pass fetchImpl explicitly')
    }
    this.baseUrl = baseUrl
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
    this.compressThreshold = compressThreshold
    this.zstd = typeof zstd === 'function' ? zstd : null
    this.clock = clock
    /** 最近一次请求的观测记录，供 /status 与 smoke 脚本读取（不含 token） */
    this.lastRequest = null
  }

  /**
   * 发一次 Messages 请求。
   *
   * @param {object} p
   * @param {object} p.body       prepareOutbound 组装好的 body
   * @param {object} [p.headers]  已组装的头（可含 token）；缺字段时由本方法补齐
   * @param {string} [p.mode]     MODE 之一，缺省按 body.stream 推断
   * @param {AbortSignal} [p.signal]
   * @param {object} [p.env]      UA / x-app 取值用的环境
   * @returns {Promise<{status:number, ok:boolean, headers:object, stream:object|null,
   *   json:object|null, text:string|null, retryAfter:number|null,
   *   classification:object, mode:string, requestHeaders:object,
   *   wireBytes:number, encoding:string|null, streamed:boolean}>}
   */
  async createMessage({ body = {}, headers = {}, mode, signal, env = process.env } = {}) {
    const resolvedMode = mode ?? (body?.stream === true ? MODE.STREAM : MODE.DOCUMENT)
    if (!Object.values(MODE).includes(resolvedMode)) {
      throw new Error(`unknown mode: ${resolvedMode}`)
    }

    // 1. body：摘内部字段 → 定线协议 stream 标志
    const internal = stripInternalFields(body)
    const bodyBetas = toBetaArray(body?.betas ?? body?.__betas__)
    const wireBody = applyStreamFlag(internal, resolvedMode)

    // 2. 头：调用方给的头为准，缺的用身份模块补齐；beta 从 body 折进头
    const callerHeaders = stripForbiddenHeaders(headers)
    const betaList = buildBetaHeader({
      headerBetas: callerHeaders['anthropic-beta'],
      bodyBetas,
    })
    const built = buildOutboundHeaders({
      token: tokenFromHeaders(callerHeaders),
      authScheme: callerHeaders['x-api-key'] ? 'api_key' : 'oauth',
      betas: betaList,
      accept: resolvedMode === MODE.DOCUMENT ? ACCEPT_JSON : ACCEPT_SSE,
      env,
    })
    // 调用方的头覆盖默认值：允许显式指定 UA 版本等，但保留键仍被剔除
    const requestHeaders = stripForbiddenHeaders({ ...built, ...callerHeaders, 'anthropic-beta': joinBetas(betaList) })

    // 3. body 编码：编码结果决定 content-encoding（唯一真相）
    const encoded = encodeBody(wireBody, {
      threshold: this.compressThreshold,
      zstd: this.zstd,
    })
    if (encoded.encoding) requestHeaders['content-encoding'] = encoded.encoding
    else delete requestHeaders['content-encoding']
    // 不设 content-length：让运行时按最终字节数填
    delete requestHeaders['content-length']

    const url = messagesUrl(this.baseUrl)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error(`anthropic upstream timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
    let externalAbort = null
    if (signal) {
      externalAbort = () => ctrl.abort(signal.reason ?? new Error('client aborted'))
      if (signal.aborted) externalAbort()
      else signal.addEventListener('abort', externalAbort, { once: true })
    }

    this.lastRequest = {
      url,
      mode: resolvedMode,
      headers: redactHeaders(requestHeaders),
      bodyBytes: Buffer.byteLength(encoded.jsonText, 'utf8'),
      wireBytes: encoded.wireBytes,
      encoding: encoded.encoding,
      protocol: resolveUpstreamProtocol(env),
      at: this.clock(),
    }

    // 已 abort 的 signal 上 addEventListener 不会再触发，进了 fetch 就会永远挂着。
    // 这里直接短路：不该发一个已知要中止的请求，也不该把控制权交给一个可能永不
    // settle 的 promise。
    if (ctrl.signal.aborted) {
      clearTimeout(timer)
      if (externalAbort && signal) signal.removeEventListener?.('abort', externalAbort)
      return {
        status: 0,
        ok: false,
        headers: {},
        stream: null,
        json: null,
        text: null,
        retryAfter: null,
        classification: {
          kind: ERROR_KIND.NETWORK,
          status: 0,
          retryable: false,
          needs_refresh: false,
          retry_after: null,
          error: 'request aborted before dispatch',
          aborted: true,
        },
        mode: resolvedMode,
        requestHeaders: redactHeaders(requestHeaders),
        wireBytes: encoded.wireBytes,
        encoding: encoded.encoding,
        streamed: false,
      }
    }

    let res
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body: encoded.payload,
        signal: ctrl.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      if (externalAbort && signal) signal.removeEventListener?.('abort', externalAbort)
      const aborted = signal?.aborted === true
      return {
        status: 0,
        ok: false,
        headers: {},
        stream: null,
        json: null,
        text: null,
        retryAfter: null,
        classification: {
          kind: ERROR_KIND.NETWORK,
          status: 0,
          retryable: !aborted,
          needs_refresh: false,
          retry_after: null,
          error: error?.message || String(error),
          aborted,
        },
        mode: resolvedMode,
        requestHeaders: redactHeaders(requestHeaders),
        wireBytes: encoded.wireBytes,
        encoding: encoded.encoding,
        streamed: false,
      }
    }

    const respHeaders = headersToObject(res.headers)
    const retryAfter = parseRetryAfter(respHeaders)
    const requestMeta = {
      mode: resolvedMode,
      requestHeaders: redactHeaders(requestHeaders),
      wireBytes: encoded.wireBytes,
      encoding: encoded.encoding,
    }

    // 4. 非 2xx：读原始错误体，原样带给调用方（不包装成看不懂的字符串）
    if (!res.ok) {
      clearTimeout(timer)
      if (externalAbort && signal) signal.removeEventListener?.('abort', externalAbort)
      const raw = await readTextLimited(res.body, MAX_ERROR_BODY_BYTES)
      let json = null
      if (raw) {
        try {
          json = JSON.parse(raw)
        } catch {
          /* 上游偶尔返回纯文本（如裸 Bad Request），保留原文 */
        }
      }
      return {
        status: res.status,
        ok: false,
        headers: respHeaders,
        stream: null,
        json,
        text: raw || null,
        retryAfter,
        classification: classifyStatus(res.status, { retryAfter }),
        ...requestMeta,
        streamed: false,
      }
    }

    // 5. 成功分支。
    //    STREAM / AGGREGATE 不看响应 content-type：由请求模式决定形态。
    if (resolvedMode === MODE.STREAM) {
      // 头已到，超时定时器到此为止：长流不该被整体超时掐断，
      // 但外部 abort 仍然有效（ctrl 已挂在 body 读取上）。
      clearTimeout(timer)
      return {
        status: res.status,
        ok: true,
        headers: respHeaders,
        stream: res.body ?? null,
        json: null,
        text: null,
        retryAfter,
        classification: classifyStatus(res.status, { retryAfter }),
        ...requestMeta,
        streamed: true,
      }
    }

    if (resolvedMode === MODE.AGGREGATE) {
      try {
        const message = res.body ? await this.aggregate(res.body) : null
        return {
          status: res.status,
          ok: true,
          headers: respHeaders,
          stream: null,
          json: message,
          text: null,
          retryAfter,
          classification: classifyStatus(res.status, { retryAfter }),
          ...requestMeta,
          streamed: true,
        }
      } finally {
        clearTimeout(timer)
        if (externalAbort && signal) signal.removeEventListener?.('abort', externalAbort)
      }
    }

    // DOCUMENT：上游回完整 JSON
    clearTimeout(timer)
    if (externalAbort && signal) signal.removeEventListener?.('abort', externalAbort)
    const raw = await readTextLimited(res.body, MAX_ERROR_BODY_BYTES * 8)
    let json = null
    try {
      json = raw ? JSON.parse(raw) : null
    } catch {
      /* 非 JSON 成功响应极少见，保留原文交给调用方 */
    }
    return {
      status: res.status,
      ok: true,
      headers: respHeaders,
      stream: null,
      json,
      text: json ? null : raw || null,
      retryAfter,
      classification: classifyStatus(res.status, { retryAfter }),
      ...requestMeta,
      streamed: false,
    }
  }

  /**
   * 把上游 SSE 流转成事件迭代器。
   *
   * 接受三种输入：ReadableStream（fetch 的 body）、Node Readable、
   * 以及字符串/Buffer（测试与回放）。解析规则统一走 SseParser，
   * 因此流式与离线回放不会出现两套行为。
   */
  async *iterEvents(stream) {
    if (stream == null) return
    if (typeof stream === 'string' || Buffer.isBuffer(stream) || stream instanceof Uint8Array) {
      for (const frame of parseSseText(typeof stream === 'string' ? stream : new TextDecoder().decode(stream))) {
        yield frame
        if (frame.done) return
      }
      return
    }
    const parser = new SseParser()
    for await (const chunk of stream) {
      for (const frame of parser.push(chunk)) {
        yield frame
        if (frame.done) return
      }
      if (parser.stopped) return
    }
    for (const frame of parser.flush()) {
      yield frame
      if (frame.done) return
    }
  }

  /**
   * 迭代 + 聚合的便捷组合（测试与非流式路由共用）。
   *
   * iterEvents 产出的是异步迭代器，而 collectMessage 要的是同步可迭代对象，
   * 两者不能直接相接。这里先把流读进数组再交给聚合器 —— 聚合发生在
   * 完整响应之后，本来就需要把整条流读完，不存在边收边算的收益。
   */
  async aggregate(stream) {
    const frames = []
    for await (const frame of this.iterEvents(stream)) frames.push(frame)
    return collectMessage(frames)
  }
}

// ─────────────────── 辅助 ───────────────────

/** 从头里取出 token（Bearery 或 x-api-key） */
export function tokenFromHeaders(headers = {}) {
  const auth = headerOf(headers, 'authorization')
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(String(auth).trim())
    if (m) return m[1].trim()
  }
  const key = headerOf(headers, 'x-api-key')
  if (key) return String(key).trim()
  const own = headerOf(headers, 'anthropic-auth-token')
  return own ? String(own).trim() : ''
}

/**
 * 日志/报告用的头脱敏：只保留辨识形态需要的部分。
 *
 * token 一律替换成 `<redacted:N>`（N 是长度，足以判断「有没有取到」），
 * 其余头原样保留——UA / beta / stainless 这些本身就是我们要检查的指纹。
 */
export function redactHeaders(headers = {}) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase()
    if (lower === 'authorization' || lower === 'x-api-key') {
      const text = String(value)
      const token = lower === 'authorization' ? text.replace(/^Bearer\s+/i, '') : text
      out[lower] = lower === 'authorization'
        ? `Bearer <redacted:${token.length}>`
        : `<redacted:${token.length}>`
      continue
    }
    out[lower] = String(value)
  }
  return out
}

/** 读响应体，最多 limit 字节；超限截断而不是把连接读到超时 */
export async function readTextLimited(stream, limit = MAX_ERROR_BODY_BYTES) {
  if (!stream) return ''
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    const room = limit - size
    if (room <= 0) break
    chunks.push(buf.subarray(0, room))
    size += Math.min(buf.length, room)
    if (size >= limit) break
  }
  return Buffer.concat(chunks).toString('utf8')
}
