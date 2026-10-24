/**
 * Codex 生图通道：`POST /v1/images/generations` + `POST /v1/images/edits`。
 *
 * 为什么不经内核：
 *   `kin-codex-kernel` 二进制里没有任何生图符号（`images/generations`、
 *   `image_generation`、`gpt-image` 全为 0 命中），内核只做 Responses 转发。
 *   上游的生图端点是 `chatgpt.com/backend-api/codex/images/*`，与 `/responses`
 *   同宿主不同路径，因此只能在 Node 层直连，把内核留在 Responses 那条链路上。
 *
 * 上游契约（读 vm2api v1.3.221 `handleCodexImages` / `postCodexJson` / `codex-models.mjs`
 * 与 codex-proxy-rs `gateway-api/src/openai/images` 得到）：
 *
 *   1. 端点：
 *        https://chatgpt.com/backend-api/codex/images/generations
 *        https://chatgpt.com/backend-api/codex/images/edits
 *   2. 请求头只要身份四件套 + `accept: application/json`：
 *        authorization / chatgpt-account-id / originator / user-agent / version
 *      注意这里**不压缩 body、不带 content-encoding**（Responses 那条链路才用 zstd），
 *      也**不发 session-id / x-codex-turn-id** —— 生图不是推理轮次。
 *   3. 客户端若给了 `x-codex-image-turn-id`，必须原样回传给上游，并同时拿它做
 *      调度粘性键（`codex-image-turn:<id>`），让同一轮编辑固定在同一个槽位。
 *   4. 请求体是**原生 Codex Images JSON**，原样透传。不做 Responses 那套
 *      `store/stream/client_metadata` 改写 —— 改了上游会当未知字段或直接报错。
 *   5. `image_generation_available` 排除 Free 计划槽位（codex-proxy-rs
 *      `credential/selector.rs`）。全池只有 Free 时返回 403
 *      `image_generation_unavailable`，不要拿 Free 号去打上游。
 *   6. 生图可能跑几分钟，超时给到 600s，且不设 total deadline（只有 transport 超时）。
 */

import fs from 'node:fs'

import { DEFAULT_CHATGPT_BASE, DEFAULT_CODEX_UA, parseUserAgent } from './codex.mjs'

// ─────────────── 模型 ───────────────

/**
 * 上游可用的图像模型。名字不是猜的：与 vm2api 的 IMAGE_TOOL_MODELS 一致，
 * 且 `gpt-image-2.5-flare` 是上游缺省模型（upstream_default）。
 */
export const IMAGE_MODELS = Object.freeze(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])

/** 上游缺省图像模型（客户端不传 model 时上游按它走） */
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5-flare'

/** 已知快照名 → 规范 id。上游对快照名也认，但策略判定要按规范 id 做。 */
export const IMAGE_MODEL_SNAPSHOTS = Object.freeze({
  'gpt-image-2.5-flare-2026-09-08': 'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst-2026-09-08': 'gpt-image-2.5-sunburst',
})

/** 生图请求超时：官方客户端不设 total deadline，这里给一个很宽的上限 */
export const IMAGE_TIMEOUT_MS = 600_000

/**
 * 选号等待上限（不是单请求超时）。
 *
 * 全池都在冷却时，继续等下去只会把客户端连接挂住 —— 生图本身已经要跑分钟级，
 * 再叠一个十分钟的排队等待，客户端只会先超时。给 30s 足够覆盖一个短暂的
 * 429 窗口，之后直接返回 429/503 让调用方自己决定重试时机。
 */
export const IMAGE_ADMISSION_WAIT_MS = 30_000

/**
 * 规范化为已知图像模型 id（含快照名与 `provider/id` 形态）；未知返回 null。
 * 未知模型不在这里拒绝：上游才是权威，本地拒掉会挡住新模型。
 */
export function canonicalImageModel(id) {
  const raw = String(id ?? '').trim()
  if (!raw) return null
  const bare = raw.split('/').filter(Boolean).pop() || raw
  const lower = bare.toLowerCase()
  if (IMAGE_MODEL_SNAPSHOTS[lower]) return IMAGE_MODEL_SNAPSHOTS[lower]
  return IMAGE_MODELS.includes(lower) ? lower : null
}

/**
 * 解析生效的模型清单（可启停）。
 *
 * 接受三种形态，都是部署时从配置读到的形状：
 *   - 未设置 / null        → 全部 IMAGE_MODELS 启用
 *   - 数组                 → 数组里出现的 id 启用（其余停用）
 *   - `{id: {enabled}}` 映射 → 布尔语义，缺省启用
 *
 * @param {unknown} value
 * @returns {string[]} 启用的规范模型 id
 */
export function enabledImageModels(value) {
  if (value == null) return [...IMAGE_MODELS]
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const id = canonicalImageModel(item)
      if (id && !out.includes(id)) out.push(id)
    }
    return out
  }
  if (typeof value === 'object') {
    const out = []
    for (const id of IMAGE_MODELS) {
      const row = value[id] ?? value[canonicalImageModel(id)]
      if (row && typeof row === 'object' && row.enabled === false) continue
      if (row === false) continue
      out.push(id)
    }
    return out
  }
  return [...IMAGE_MODELS]
}

// ─────────────── 计划（plan）判定 ───────────────

/**
 * 该计划是否允许生图。Free 不允许（官方 `image_generation_available` 的口径）。
 *
 * 空值/未知计划一律放行：判断不了就不要提前拒掉可用槽位，
 * 真没权限时上游会给出明确错误，比本地瞎猜更可靠。
 *
 * @param {string|null|undefined} planType
 * @returns {boolean}
 */
export function imageGenerationAvailable(planType) {
  const plan = String(planType ?? '').trim().toLowerCase()
  if (!plan) return true
  return plan !== 'free'
}

/** 从 id_token（JWT）里读 chatgpt_plan_type；只读 payload，不验签。 */
export function planTypeFromIdToken(idToken) {
  const parts = String(idToken || '').split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const auth = payload?.['https://api.openai.com/auth']
    const plan = auth?.chatgpt_plan_type ?? payload?.chatgpt_plan_type
    return typeof plan === 'string' && plan.trim() ? plan.trim().toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * 从一个凭据条目里推断计划。
 *
 * 顺序：显式 `plan_type` → `chatgpt_plan_type` → id_token 的 auth 声明。
 * 单账号文件（Codex CLI 导出的形状）通常没有 plan 字段，只能靠 id_token。
 */
export function planTypeFromCredential(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  for (const key of ['plan_type', 'chatgpt_plan_type', 'plan']) {
    const v = src[key]
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase()
  }
  return planTypeFromIdToken(src.id_token)
}

/**
 * 读取凭据文件里的计划表：`{accountId: planType}`。
 *
 * 为什么不复用 codex-credentials.mjs：那边把账号规范化成调度用的 8 个字段，
 * `plan_type` 不在其中会被丢掉，而生图权限判定必须要它。这里只读不写，
 * 也不参与调度，纯补充信息；读不到就是空表（等价于"计划未知"，全部放行）。
 *
 * @param {string} credentialPath
 * @returns {Record<string, string>}
 */
export function loadPlanTypes(credentialPath) {
  if (!credentialPath) return {}
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
  } catch {
    return {}
  }
  const out = {}
  const rows = Array.isArray(parsed?.accounts)
    ? parsed.accounts
    : Array.isArray(parsed)
      ? parsed
      : [parsed]
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const id = row.id || row.account_id || row.chatgpt_account_id || row.email
    const plan = planTypeFromCredential(row)
    if (id && plan) out[String(id)] = plan
  }
  return out
}

/** 把计划表贴到账号列表上（不改原对象） */
export function withPlanTypes(accounts, planTypes = {}) {
  return (Array.isArray(accounts) ? accounts : []).map((acc) => ({
    ...acc,
    plan_type: acc.plan_type || planTypes[acc.id] || null,
  }))
}

// ─────────────── 错误体 ───────────────

/** OpenAI 风格错误体，字段与 codex-server.mjs 的 openAiError 一致 */
export function imageError(status, message, { type = 'invalid_request_error', code = null } = {}) {
  return { error: { message, type, param: null, code, status } }
}

/** 统一的处理结果：status + body + headers，写响应由 HTTP 层负责 */
function failure(status, message, opts) {
  return { status, body: imageError(status, message, opts), headers: {}, accountId: null, attempts: 0 }
}

// ─────────────── multipart 解析 ───────────────

/** `multipart/form-data; boundary=...` 判定（大小写与参数顺序无关） */
export function isMultipartFormData(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase() === 'multipart/form-data'
}

/** 从 Content-Type 里取 boundary；取不到返回 null */
export function boundaryFromContentType(contentType) {
  const segments = String(contentType || '').split(';')
  if (segments.shift()?.trim().toLowerCase() !== 'multipart/form-data') return null
  for (const segment of segments) {
    const eq = segment.indexOf('=')
    if (eq < 0) continue
    if (segment.slice(0, eq).trim().toLowerCase() !== 'boundary') continue
    let value = segment.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    return value || null
  }
  return null
}

/** 头块 → 小写键表。中文文件名是原始 UTF-8 字节，优先按 UTF-8 解。 */
function decodeHeaderBlock(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return buf.toString('latin1')
  }
}

/** RFC 5987 扩展值：`UTF-8''%E4%B8%AD.png` */
function decodeExtendedValue(value) {
  const idx = String(value).indexOf("''")
  if (idx < 0) return String(value)
  try {
    return decodeURIComponent(String(value).slice(idx + 2))
  } catch {
    return String(value).slice(idx + 2)
  }
}

/**
 * 解析 `form-data; name="image"; filename="a.png"` 的参数段。
 * 手写扫描而不是 split(';')：引号内的分号是文件名的合法字符。
 */
function dispositionParams(value) {
  const s = String(value)
  const params = {}
  let i = 0
  while (i < s.length && s[i] !== ';') i += 1
  while (i < s.length) {
    i += 1 // 跳过 ';'
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1
    let name = ''
    while (i < s.length && s[i] !== '=' && s[i] !== ';') {
      name += s[i]
      i += 1
    }
    name = name.trim().toLowerCase()
    if (i < s.length && s[i] === ';') {
      if (name) params[name] = ''
      continue
    }
    if (i >= s.length) {
      if (name) params[name] = ''
      break
    }
    i += 1 // 跳过 '='
    let raw = ''
    if (s[i] === '"') {
      i += 1
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          i += 1
          raw += s[i]
          i += 1
          continue
        }
        raw += s[i]
        i += 1
      }
      i += 1 // 跳过收尾引号
    } else {
      while (i < s.length && s[i] !== ';') {
        raw += s[i]
        i += 1
      }
    }
    if (name) params[name] = raw
  }
  return params
}

function parsePartHeaders(headerBuf) {
  const headers = {}
  const text = decodeHeaderBlock(headerBuf)
  for (const line of text.split('\r\n')) {
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  return headers
}

function parsePart(raw) {
  const split = raw.indexOf('\r\n\r\n')
  const headerBuf = split < 0 ? Buffer.alloc(0) : raw.subarray(0, split)
  const data = split < 0 ? Buffer.alloc(0) : raw.subarray(split + 4)
  const headers = parsePartHeaders(headerBuf)
  const disposition = headers['content-disposition'] || ''
  if (!/^form-data\b/i.test(disposition.trim())) {
    return { ok: false, message: 'multipart part is not form-data' }
  }
  const params = dispositionParams(disposition)
  const name = params.name
  if (!name) return { ok: false, message: 'multipart part is missing a name' }
  const filename = params['filename*'] != null
    ? decodeExtendedValue(params['filename*'])
    : params.filename
  return {
    ok: true,
    part: {
      name,
      filename: filename == null ? null : filename,
      contentType: headers['content-type'] || null,
      data,
    },
  }
}

/**
 * 原生 multipart/form-data 解析（不引第三方包）。
 *
 * 二进制安全的做法：只在 `\r\n--boundary` 上切分，绝不对整个 body 做字符串转换 ——
 * 图片是任意字节，转成字符串再转回会在遇到非法 UTF-8 序列时损坏内容。
 *
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {{ok:true, parts:Array<{name:string, filename:string|null, contentType:string|null, data:Buffer}>}
 *          | {ok:false, message:string}}
 */
export function parseMultipart(buffer, contentType) {
  const boundary = boundaryFromContentType(contentType)
  if (!boundary) return { ok: false, message: 'multipart body requires a boundary in Content-Type' }
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '')
  const delimiter = Buffer.from(`--${boundary}`, 'latin1')
  const separator = Buffer.from(`\r\n--${boundary}`, 'latin1')

  let cursor = buf.indexOf(delimiter)
  if (cursor < 0) {
    return { ok: false, message: `multipart body has no delimiter for boundary "${boundary}"` }
  }
  cursor += delimiter.length

  const parts = []
  for (;;) {
    if (cursor >= buf.length) return { ok: false, message: 'multipart body is truncated' }
    // 结束标记：`--boundary--`
    if (buf[cursor] === 0x2d && buf[cursor + 1] === 0x2d) return { ok: true, parts }
    if (buf[cursor] === 0x0d && buf[cursor + 1] === 0x0a) cursor += 2
    else return { ok: false, message: 'multipart part is malformed (expected CRLF after boundary)' }

    const end = buf.indexOf(separator, cursor)
    if (end < 0) return { ok: false, message: 'multipart body is truncated (missing closing boundary)' }
    const parsed = parsePart(buf.subarray(cursor, end))
    if (!parsed.ok) return parsed
    parts.push(parsed.part)
    cursor = end + separator.length
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 上传字节 → 上游期望的 `{image_url: data:<mime>;base64,...}`。
 *
 * MIME 靠魔数而不是客户端给的 filename/content-type：官方 Original 路径同样
 * 只看字节（"ignore file name and upload MIME"），客户端声明的类型不可信。
 */
export function imageReference(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '')
  let mime = null
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) mime = 'image/png'
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) mime = 'image/jpeg'
  else if (buf.length >= 12
    && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP') mime = 'image/webp'
  if (!mime) throw new TypeError('Image edit uploads must be PNG, JPEG or WebP')
  return { image_url: `data:${mime};base64,${buf.toString('base64')}` }
}

/** 需要保持数字类型的表单字段 */
const NUMERIC_FIELDS = new Set(['n', 'output_compression', 'partial_images'])

function scalarField(name, text) {
  if (NUMERIC_FIELDS.has(name)) {
    let value
    try {
      value = JSON.parse(text)
    } catch {
      value = undefined
    }
    if (typeof value !== 'number') {
      throw new TypeError('Image edit numeric fields must contain JSON numbers')
    }
    return value
  }
  if (name === 'stream') {
    let value
    try {
      value = JSON.parse(text)
    } catch {
      value = undefined
    }
    if (typeof value !== 'boolean') {
      throw new TypeError('Image edit stream field must contain a JSON boolean')
    }
    return value
  }
  // 其余字段原样保留名字与文本；未知字段不丢也不拒（上游可能新增参数）
  return text
}

/**
 * `/v1/images/edits` multipart → 原生 Codex Images JSON。
 *
 * 字段语义与 vm2api `image-edit-multipart.mjs` 一致（对齐 codex-proxy-rs 的
 * `gateway-api/src/openai/images/request.rs`）：
 *   - `image` / `image[]`：按**上传顺序**进 `images[]`，顺序是编辑语义的一部分
 *   - `mask`：进 `body.mask`
 *   - `n` / `output_compression` / `partial_images`：JSON 数字
 *   - `stream`：JSON 布尔
 *   - 其余：按文本保留
 *
 * @returns {{ok:true, body:object} | {ok:false, message:string}}
 */
export function normalizeImageEditBody(buffer, contentType) {
  const parsed = parseMultipart(buffer, contentType)
  if (!parsed.ok) return { ok: false, message: parsed.message }

  const body = {}
  const images = []
  try {
    for (const part of parsed.parts) {
      const isFile = part.filename != null
      if (part.name === 'image' || part.name === 'image[]') {
        if (!isFile) throw new TypeError('Image edit `image` field must be a file upload')
        images.push(imageReference(part.data))
        continue
      }
      if (part.name === 'mask') {
        if (!isFile) throw new TypeError('Image edit `mask` field must be a file upload')
        body.mask = imageReference(part.data)
        continue
      }
      if (isFile) throw new TypeError('Only image, image[] and mask may contain image files')
      body[part.name] = scalarField(part.name, part.data.toString('utf8'))
    }
  } catch (error) {
    return { ok: false, message: error.message }
  }
  if (!images.length) return { ok: false, message: 'Image edit multipart requires an image or image[] upload' }
  body.images = images
  return { ok: true, body }
}

// ─────────────── 上游 ───────────────

/** 上游 images 端点，按 base 拼（base 与 Responses 共用 codex_base_url） */
export function imageUrls(base = DEFAULT_CHATGPT_BASE) {
  const b = String(base).replace(/\/+$/, '')
  return { generations: `${b}/images/generations`, edits: `${b}/images/edits` }
}

/**
 * 构造上游 images 请求头。
 *
 * 与 Responses 的差别是刻意的：
 *   - `accept: application/json`（不是 text/event-stream，生图不是流）
 *   - 不带 `content-encoding`、不带 `session-id`、不现造 `x-codex-turn-id`
 *   - `x-codex-image-turn-id` 只回传客户端给的值
 * 不发 content-length：交给运行时按实际字节数填。
 */
export function buildImageHeaders(account = {}, { turnId, turnMetadata, userAgent } = {}) {
  const ua = userAgent || DEFAULT_CODEX_UA
  const { originator, version } = parseUserAgent(ua)
  const headers = {
    authorization: `Bearer ${account.access_token || ''}`,
    'content-type': 'application/json',
    accept: 'application/json',
    originator,
    'user-agent': ua,
    version,
  }
  if (account.chatgpt_account_id) headers['chatgpt-account-id'] = account.chatgpt_account_id
  if (turnMetadata) headers['x-codex-turn-metadata'] = turnMetadata
  if (turnId) headers['x-codex-image-turn-id'] = turnId
  return headers
}

/**
 * 造一个发送函数：`send({account, kind, body, turnId, turnMetadata, signal})`。
 *
 * body 用明文 JSON 发出（与 vm2api postCodexJson 一致，生图端点不吃 zstd）。
 * 返回值恒为 `{status, headers, text}`，传输失败时 `{status: 0, error}`，
 * 与 codex.mjs 的调用约定保持同一种形状，调用方只按 status 分支。
 */
export function createImageSender({
  baseUrl = DEFAULT_CHATGPT_BASE,
  fetchImpl = globalThis.fetch,
  timeoutMs = IMAGE_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available; pass fetchImpl explicitly')
  const urls = imageUrls(baseUrl)

  return async function send({ account, kind, body, turnId, turnMetadata, signal }) {
    const url = urls[kind] || urls.generations
    const headers = buildImageHeaders(account, { turnId, turnMetadata })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    if (signal) {
      if (signal.aborted) ctrl.abort()
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true })
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      })
      const respHeaders = {}
      res.headers?.forEach?.((v, k) => { respHeaders[String(k).toLowerCase()] = v })
      return { status: Number(res.status) || 0, headers: respHeaders, text: await res.text() }
    } catch (error) {
      return {
        status: 0,
        headers: {},
        error: /abort/i.test(`${error?.name} ${error?.message}`) ? 'upstream_timeout' : 'upstream_transport',
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

// ─────────────── 选号 ───────────────

/**
 * 带排除集的选号。
 *
 * AccountScheduler.select 不接受 excluded，而 images 需要排掉 Free 槽位和本次
 * 已经试过的账号。这里复刻它的三段顺序（会话亲和 → 首个可用），并同样用
 * `hold()` 占坑 —— 不能只读 canTake 不占坑，否则 max_concurrency 对这条路径失效。
 *
 * 粘性键走 session 维度：`codex-image-turn:<id>`。
 */
export function selectImageAccount(scheduler, accounts, { sessionId, excluded = new Set() } = {}) {
  const usable = (acc) => acc && !excluded.has(acc.id) && scheduler.canTake(acc)

  if (sessionId) {
    const boundId = scheduler.sessionAffinity?.get(sessionId)
    if (boundId != null) {
      const acc = accounts.find((a) => a.id === boundId)
      if (usable(acc)) {
        const picked = { account: acc, via: 'session' }
        scheduler.hold(picked, { sessionId })
        return picked
      }
    }
  }
  for (const acc of accounts) {
    if (!usable(acc)) continue
    const picked = { account: acc, via: 'scan' }
    scheduler.hold(picked, { sessionId })
    return picked
  }
  const error = new Error('no image slot can take this request')
  error.code = accounts.length ? 'all_rejected' : 'no_candidates'
  throw error
}

/** 这些上游状态码换号重试；其余（含 4xx 请求错误）原样回给客户端 */
function isFailoverStatus(status) {
  const s = Number(status) || 0
  return s === 0 || s === 401 || s === 402 || s === 403 || s === 429 || s >= 500
}

function headerValue(headers, name) {
  const v = headers?.[name] ?? headers?.[name.toLowerCase()]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ─────────────── 主流程 ───────────────

/**
 * generations / edits 共用的执行体。
 *
 * 步骤与 vm2api handleCodexImages 对齐：
 *   1. body 必须是对象
 *   2. model 若给定：已知且被停用 → 400 model_disabled；未知 → 交给上游裁决
 *   3. 收集可用槽位，排除 Free 计划；全池只有 Free → 403 image_generation_unavailable
 *   4. 用 `x-codex-image-turn-id` 做粘性选号，循环 admit 候选直到成功或超时
 *   5. 上游 body 原样透传，不作任何改写
 *
 * @param {object} ctx
 * @param {'generations'|'edits'} ctx.kind
 * @param {object} ctx.body                原生 Images JSON（已归一化）
 * @param {object} [ctx.headers]           客户端请求头
 * @param {object} ctx.scheduler           AccountScheduler
 * @param {Array<object>} ctx.accounts     含 plan_type 的账号清单
 * @param {Function} ctx.send              发送函数，见 createImageSender
 * @param {string[]} [ctx.imageModels]     启用的模型；缺省全部启用
 * @param {number} [ctx.deadlineMs]        选号等待上限
 * @param {AbortSignal} [ctx.signal]       客户端断开
 * @param {() => number} [ctx.now]
 * @returns {Promise<{status:number, body:object, headers:object,
 *                    accountId:string|null, attempts:number, cancelled?:boolean}>}
 */
export async function runImages(ctx) {
  const {
    kind = 'generations',
    headers = {},
    scheduler,
    send,
    deadlineMs = IMAGE_ADMISSION_WAIT_MS,
    signal,
    now = () => Date.now(),
  } = ctx || {}
  const accounts = Array.isArray(ctx?.accounts) ? ctx.accounts : (scheduler?.accounts || [])
  const body = ctx?.body
  const enabled = Array.isArray(ctx?.imageModels) ? ctx.imageModels : [...IMAGE_MODELS]

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return failure(400, 'Images request body must be a JSON object', { code: 'invalid_request' })
  }

  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (model) {
    const canonical = canonicalImageModel(model)
    if (canonical && !enabled.includes(canonical)) {
      return failure(400, `image model '${model}' is disabled by gateway policy`, { code: 'model_disabled' })
    }
  }

  // Free 计划不接生图：先按计划筛，再谈调度
  const freeIds = new Set()
  const candidates = []
  for (const acc of accounts) {
    if (!acc || !acc.id) continue
    if (!imageGenerationAvailable(acc.plan_type)) freeIds.add(acc.id)
    else candidates.push(acc)
  }
  if (!candidates.length) {
    if (freeIds.size) {
      return failure(403, 'Image generation is not available on Free-plan slots', {
        type: 'permission_error',
        code: 'image_generation_unavailable',
      })
    }
    return failure(503, 'no Codex account is configured for image generation', {
      type: 'api_error',
      code: 'no_account',
    })
  }

  const imageTurnId = headerValue(headers, 'x-codex-image-turn-id')
  const turnMetadata = headerValue(headers, 'x-codex-turn-metadata')
  // 同一轮编辑钉在同一槽位；没有 turn id 时不造会话键，避免把无关请求串到一条亲和上
  const stickyKey = imageTurnId ? `codex-image-turn:${imageTurnId}` : null

  const excluded = new Set(freeIds)
  const deadline = now() + Math.max(0, Number(deadlineMs) || 0)
  let last = null
  let attempts = 0

  for (;;) {
    if (signal?.aborted) return { status: 499, body: {}, headers: {}, accountId: null, attempts, cancelled: true }
    if (attempts > 0 && now() >= deadline) break

    let picked
    try {
      picked = selectImageAccount(scheduler, candidates, { sessionId: stickyKey, excluded })
    } catch (error) {
      if (last) break
      const status = error.code === 'all_rejected' ? 429 : 503
      return failure(status, error.message, {
        type: status === 429 ? 'rate_limit_error' : 'api_error',
        code: error.code || 'no_account',
      })
    }

    const account = picked.account
    excluded.add(account.id)
    attempts += 1
    try {
      last = await send({ account, kind, body, turnId: imageTurnId, turnMetadata, signal })
    } finally {
      // 生图是一次性 JSON 响应，读完即归还并发额度，不存在长流占用
      scheduler.release(account.id)
    }

    if (last.status >= 200 && last.status < 300) {
      if (stickyKey) scheduler.commitSuccess({ sessionId: stickyKey, accountId: account.id })
      return {
        status: last.status,
        body: parseJson(last.text) ?? {},
        headers: last.headers || {},
        accountId: account.id,
        attempts,
      }
    }
    if (!isFailoverStatus(last.status)) break
    // 401/402/403/429/5xx 都要进冷却：不冷却的话下一轮扫描会立刻又把同一个坏号捞回来。
    // status 0（传输失败/超时）不冷却 —— 那多半是本地网络抖动，冷却一个健康号只会白等。
    if (last.status) scheduler.markCooldown(account.id, { status: last.status })
  }

  if (!last || !last.status) {
    const code = last?.error || 'upstream_transport'
    return {
      status: 502,
      body: imageError(502, 'Codex images upstream request failed', { type: 'api_error', code }),
      headers: {},
      accountId: null,
      attempts,
    }
  }
  const payload = parseJson(last.text)
  if (payload === undefined) {
    return {
      status: 502,
      body: imageError(502, `Codex images upstream answered ${last.status} without JSON`, {
        type: 'api_error',
        code: 'upstream_invalid_body',
      }),
      headers: {},
      accountId: null,
      attempts,
    }
  }
  return { status: last.status, body: payload, headers: last.headers || {}, accountId: null, attempts }
}

/** `POST /v1/images/generations` */
export async function handleImageGenerations(ctx) {
  return runImages({ ...ctx, kind: 'generations' })
}

/**
 * `POST /v1/images/edits`
 *
 * 两种入参形态都收：
 *   - `ctx.body`：已经解析好的原生 Images JSON
 *   - `ctx.raw` + `ctx.contentType`：原始字节。multipart 走归一化，
 *     其余按 JSON 解析（有客户端用 JSON 直传 `images[]`，这种不必强制换格式）
 */
export async function handleImageEdits(ctx) {
  let body = ctx?.body
  if (!body && ctx?.raw != null) {
    const raw = Buffer.isBuffer(ctx.raw) ? ctx.raw : Buffer.from(ctx.raw)
    if (isMultipartFormData(ctx.contentType)) {
      const normalized = normalizeImageEditBody(raw, ctx.contentType)
      if (!normalized.ok) {
        return failure(400, normalized.message, { code: 'invalid_image_edit' })
      }
      body = normalized.body
    } else {
      try {
        body = JSON.parse(raw.toString('utf8') || '{}')
      } catch (error) {
        return failure(400, `invalid JSON body: ${error.message}`, { code: 'invalid_json' })
      }
    }
  }
  return runImages({ ...ctx, kind: 'edits', body })
}
