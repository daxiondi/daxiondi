/**
 * 入站待检测文本的整理。
 *
 * 职责：把一份入站 body 拆成带来源标签的文本段，做去重、抹平和解码，
 * 供风险审计五关共用。五个关卡看到的文本形状必须来自同一处，否则
 * 「第 1 关没命中、第 2 关命中」这类现象会变得无法复现。
 *
 * 关键约束：
 * 1. 来源标签（`user message 3` / `system` / `tool 定义`）是证据的一部分。
 *    决策模型要靠它区分「历史里引用了一段攻击文本」和「本次要求做这件事」，
 *    因此带标签的文档只给第 4 关用，硬正则与相似度用不带标签的纯正文。
 * 2. 去重键是「来源 + 规范化正文」。同一段正文出现在 system 与 user 里是
 *    两条独立证据，必须都保留；同一段正文被 inbound 与 body 各带一份时才是
 *    重复，只留一条。
 * 3. 抹平动态内容（`<total_tokens>` 计数之类）。这些值每轮都会变，不抹平
 *    会让精确指纹永远打不中，也会让相似签名始终偏低。
 * 4. 工具回传内容默认不进「用户正文」文档：它引用的是文件内容、命令输出和
 *    上游规则原文，扫它会造成大面积误伤。需要时用 includeToolResults 打开。
 */

/** 送进检测前统一的大小写与空白形式。 */
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\\\s+/g, '\\')
    .trim()
}

const VOLATILE_PATTERNS = Object.freeze([
  // 上下文计数：每一轮都不同
  /<total_tokens>\s*\d+\s*tokens?\s*(?:left|remaining)?\s*<\/total_tokens>/gi,
  // 剩余额度 / 已用 token 的裸计数行
  /\btokens?\s+(?:left|remaining)\s*[:=]\s*\d+/gi,
  // 请求与追踪标识
  /\b(?:request[_-]?id|trace[_-]?id|x-request-id)\s*[:=]\s*[A-Za-z0-9_-]{6,}/gi,
  // 账期时间戳
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g,
  // 进程 / 会话计数
  /\bpid\s*[:=]\s*\d+/gi,
])

/**
 * 把每轮都会变的片段替换成固定占位，保留其余结构。
 * 保留结构是有意的：抹平只去掉数值，不改变文本形状。
 */
export function stabilizeDynamic(value) {
  let out = String(value ?? '')
  for (const re of VOLATILE_PATTERNS) out = out.replace(re, (match) => replacedMarker(match))
  return out
}

function replacedMarker(match) {
  const text = String(match)
  if (/total_tokens/i.test(text)) return '<total_tokens>0 tokens left</total_tokens>'
  if (/tokens?\s+(?:left|remaining)/i.test(text)) return text.replace(/\d+/, '0')
  if (/request[_-]?id|trace[_-]?id/i.test(text)) return text.replace(/[:=]\s*\S+/, '= <id>')
  if (/pid/i.test(text)) return text.replace(/[:=]\s*\d+/, '= 0')
  return '<timestamp>'
}

const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'
const B64_MIN_RUN = 32
const B64_MAX_RUN = 64 * 1024
const B64_MAX_DECODED = 64 * 1024
const B64_MAX_SEGMENTS = 8
const B64_MAX_PASSES = 3

function lowerCode(code) {
  return code >= 65 && code <= 90 ? code + 32 : code
}

function indexFold(text, needle, from) {
  const first = lowerCode(needle.charCodeAt(0))
  const limit = text.length - needle.length
  for (let i = from; i <= limit; i += 1) {
    if (lowerCode(text.charCodeAt(i)) !== first) continue
    let ok = true
    for (let j = 1; j < needle.length; j += 1) {
      if (lowerCode(text.charCodeAt(i + j)) !== lowerCode(needle.charCodeAt(j))) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

/**
 * 去掉 `<system-reminder>` 包裹的块。客户端把自己的环境信息塞在这里，
 * 与请求意图无关；块内的内容随块一起去掉。
 */
function rawStripReminders(value) {
  let rest = String(value ?? '')
  if (indexFold(rest, REMINDER_OPEN, 0) < 0) return rest
  let out = ''
  for (;;) {
    const open = indexFold(rest, REMINDER_OPEN, 0)
    if (open < 0) {
      out += rest
      break
    }
    out += rest.slice(0, open)
    rest = rest.slice(open + REMINDER_OPEN.length)
    const close = indexFold(rest, REMINDER_CLOSE, 0)
    if (close < 0) break
    rest = rest.slice(close + REMINDER_CLOSE.length)
  }
  return out.trim()
}

/** 对外入口：enabled=false 时原样返回。 */
export function stripReminders(value, { enabled = true } = {}) {
  return enabled ? rawStripReminders(value) : String(value ?? '')
}

function isBase64Byte(code) {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47 ||
    code === 61
  )
}

function looksLikeText(value) {
  const chars = [...value]
  if (!chars.length) return false
  let printable = 0
  let letters = 0
  for (const ch of chars) {
    if (ch === '\n' || ch === '\r' || ch === '\t') {
      printable += 1
      continue
    }
    const code = ch.codePointAt(0)
    if (code !== 32 && (code <= 32 || code === 127)) continue
    printable += 1
    if (/\p{L}/u.test(ch)) letters += 1
  }
  return letters > 0 && printable * 10 >= chars.length * 9
}

function decodeTextRun(run) {
  const limit = run.length > B64_MAX_RUN ? run.slice(0, B64_MAX_RUN - (B64_MAX_RUN % 4)) : run
  if (limit.length % 4 !== 0) return ''
  let raw
  try {
    raw = Buffer.from(limit, 'base64')
  } catch {
    return ''
  }
  if (!raw.length) return ''
  const text = raw.toString('utf8')
  // 只接受可逆的编码：任何不可逆结果都当成普通文本原样保留。
  if (Buffer.from(text, 'utf8').compare(raw) !== 0) return ''
  if (Buffer.from(text).toString('base64') !== limit) return ''
  return looksLikeText(text) ? text : ''
}

function expandOnce(value) {
  let out = ''
  let last = 0
  let decoded = 0
  let segments = 0
  let changed = false
  for (let i = 0; i < value.length; ) {
    if (!isBase64Byte(value.charCodeAt(i))) {
      i += 1
      continue
    }
    let j = i
    while (j < value.length && isBase64Byte(value.charCodeAt(j))) j += 1
    const run = value.slice(i, j)
    if (run.length >= B64_MIN_RUN && segments < B64_MAX_SEGMENTS && decoded < B64_MAX_DECODED) {
      const plain = decodeTextRun(run)
      if (plain) {
        out += `${value.slice(last, i)}${plain}`
        last = j
        decoded += plain.length
        segments += 1
        changed = true
      }
    }
    i = j
  }
  if (!changed) return value
  return out + value.slice(last)
}

/** 展开正文里的 base64 段。哈希、id 和文件路径不会被解开，因此保持原样。 */
export function expandBase64(value) {
  let current = String(value ?? '')
  for (let pass = 0; pass < B64_MAX_PASSES; pass += 1) {
    const next = expandOnce(current)
    if (next === current) break
    current = next
  }
  return current
}

/** 完整预处理：去提醒块 → 展开 base64 → 抹平动态值 → 去首尾空白。 */
export function prepareText(value, { stripReminders: strip = true, expandEncoded = true, stabilize = true } = {}) {
  let out = String(value ?? '')
  if (strip) out = rawStripReminders(out)
  if (expandEncoded) out = expandBase64(out)
  if (stabilize) out = stabilizeDynamic(out)
  return out.trim()
}

const TOOL_RESULT_TYPES = Object.freeze(['tool_result', 'function_call_output', 'tool_response'])

function isToolResultBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false
  const type = String(block.type || '')
  if (!type) return false
  if (TOOL_RESULT_TYPES.includes(type)) return true
  return type.endsWith('_tool_result') || type.endsWith('_output')
}

/**
 * 取一段 content 的文本。includeToolResults=false 时跳过工具回传块，
 * 但保留同一条消息里用户自己写的部分。
 */
export function contentToText(content, { includeToolResults = true } = {}) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => contentToText(part, { includeToolResults }))
      .filter(Boolean)
      .join('\n')
  }
  if (!content || typeof content !== 'object') return ''
  if (!includeToolResults && isToolResultBlock(content)) return ''
  if (typeof content.text === 'string') return content.text
  // Responses 的 item 把正文再嵌一层：message → content → input_text。
  if (typeof content.content === 'string') return content.content
  if (Array.isArray(content.content)) return contentToText(content.content, { includeToolResults })
  return ''
}

function systemFieldTexts(body) {
  if (!body || typeof body !== 'object') return []
  const out = []
  for (const field of ['system', 'instructions']) {
    const value = body[field]
    const role = field === 'instructions' ? 'instructions' : 'system'
    if (typeof value === 'string') {
      if (value.trim()) out.push({ source: role, text: value, role })
      continue
    }
    if (!Array.isArray(value)) continue
    const joined = contentToText(value)
    if (joined.trim()) out.push({ source: role, text: joined, role })
  }
  return out
}

function messageTexts(body, { includeToolResults = true, includeSystem = true } = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const out = []
  messages.forEach((message, index) => {
    const role = String(message?.role || 'unknown').toLowerCase()
    if (role === 'system' || role === 'developer') {
      if (!includeSystem) return
      const text = contentToText(message?.content, { includeToolResults })
      if (text.trim()) out.push({ source: `${role} message ${index + 1}`, text, role })
      return
    }
    if (role === 'assistant') return
    if (role === 'tool' || role === 'function') {
      if (!includeToolResults) return
      const text = contentToText(message?.content, { includeToolResults })
      if (text.trim()) out.push({ source: `${role} message ${index + 1}`, text, role })
      return
    }
    const text = contentToText(message?.content, { includeToolResults })
    if (text.trim()) out.push({ source: `${role} message ${index + 1}`, text, role })
  })
  return out
}

function inputTexts(body, { includeToolResults = true } = {}) {
  const input = body?.input
  if (typeof input === 'string') {
    return input.trim() ? [{ source: 'user input 1', text: input, role: 'user' }] : []
  }
  if (!Array.isArray(input)) return []
  const out = []
  input.forEach((item, index) => {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ source: `user input ${index + 1}`, text: item, role: 'user' })
      return
    }
    if (!item || typeof item !== 'object') return
    if (!includeToolResults && isToolResultBlock(item)) return
    const role = String(item.role || 'user').toLowerCase()
    if (role === 'assistant') return
    if (role === 'system' || role === 'developer') return
    if ((role === 'tool' || role === 'function') && !includeToolResults) return
    const text = contentToText(item.content === undefined ? item : item.content, { includeToolResults })
    if (text.trim()) out.push({ source: `${role} input ${index + 1}`, text, role })
  })
  return out
}

/** 工具定义只取名字与描述：schema 本身是结构，不含请求意图。 */
function toolTexts(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const out = []
  tools.forEach((tool, index) => {
    if (!tool || typeof tool !== 'object') return
    const name = String(tool.name || tool.function?.name || '').trim()
    const description = String(tool.description || tool.function?.description || '').trim()
    const text = [name, description].filter(Boolean).join('\n')
    if (text) out.push({ source: `tool 定义 ${index + 1}`, text, role: 'tool_def' })
  })
  return out
}

/**
 * 把入站 body（以及可选的已解析 inbound）拆成带来源标签的文本段。
 * @returns {Array<{ source: string, text: string, role: string }>}
 */
export function extractSegments(
  body,
  { includeToolResults = true, includeSystem = true, includeTools = false, inbound = null } = {},
) {
  const opts = { includeToolResults, includeSystem }
  const out = []
  for (const src of [inbound, body]) {
    if (!src || typeof src !== 'object') continue
    if (includeSystem) out.push(...systemFieldTexts(src))
    out.push(...messageTexts(src, opts))
    out.push(...inputTexts(src, opts))
  }
  if (includeTools) out.push(...toolTexts(body))
  return out
}

/**
 * 按「来源 + 规范化正文」去重。同一正文来自不同来源时保留两份，
 * 同一正文被 inbound 与 body 各带一份时只留先出现的那份。
 */
export function dedupeSegments(segments) {
  const seen = new Set()
  const out = []
  for (const segment of segments || []) {
    if (!segment || typeof segment !== 'object') continue
    const text = String(segment.text ?? '')
    if (!text.trim()) continue
    const key = `${segment.source ?? ''}\u0000${normalizeText(text)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ source: String(segment.source ?? ''), text, role: String(segment.role ?? '') })
  }
  return out
}

/**
 * 用户正文文档：只取用户/开发者自己写的轮次，不含工具回传。
 * 第 2 关硬正则与第 3 关相似度用它——比较的是用户写下的内容。
 */
export function userDocument(body, options = {}) {
  const segments = dedupeSegments(
    extractSegments(body, {
      includeToolResults: options.includeToolResults === true,
      includeSystem: false,
      includeTools: false,
      inbound: options.inbound || null,
    }).filter((segment) => segment.role !== 'tool_def' && segment.role === 'user'),
  )
  return segments.map((segment) => normalizeText(segment.text)).join('\n')
}

/**
 * 带来源标签的文档：第 4 关决策模型用它。用户文本仍不含工具回传，
 * 但保留 system —— 角色扮演类请求常把正文放在 system 里。
 */
export function labeledDocument(body, options = {}) {
  const segments = dedupeSegments(
    extractSegments(body, {
      includeToolResults: options.includeToolResults === true,
      includeSystem: true,
      includeTools: options.includeTools === true,
      inbound: options.inbound || null,
    }),
  )
  return segments.map((segment) => `[${segment.source}]\n${normalizeText(segment.text)}`).join('\n')
}

/**
 * 最新一条用户正文。第 1 关蒸馏检测只看它：历史轮次里的针与指纹不再触发，
 * 否则同一次会话里问过一次就再也放不过。
 */
export function latestUserText(body, options = {}) {
  const segments = dedupeSegments(
    extractSegments(body, {
      includeToolResults: false,
      includeSystem: false,
      includeTools: false,
      inbound: options.inbound || null,
    }),
  ).filter((segment) => segment.role === 'user')
  if (!segments.length) return ''
  return segments[segments.length - 1].text
}

/** 一份 body 的结构特征：轮数、工具数、max_tokens。 */
export function extractStructure(body) {
  const src = body && typeof body === 'object' ? body : {}
  const messages = Array.isArray(src.messages) ? src.messages.length : 0
  const inputCount = src.input == null ? 0 : Array.isArray(src.input) ? src.input.length : 1
  const maxTokens = src.max_tokens ?? src.max_output_tokens ?? src.max_new_tokens
  return {
    messages_count: messages || (inputCount ? 1 : 0),
    tools_count: Array.isArray(src.tools) ? src.tools.length : 0,
    max_tokens: maxTokens == null ? null : Number(maxTokens),
  }
}

/**
 * 供五关共用的整理结果。
 * @returns {{ labeled: string, user: string, latest: string, structure: object, segments: Array }}
 */
export function prepareInbound(body, options = {}) {
  const segments = dedupeSegments(
    extractSegments(body, {
      includeToolResults: options.includeToolResults === true,
      includeSystem: true,
      includeTools: false,
      inbound: options.inbound || null,
    }),
  )
  const own = options.stripReminders === false ? (value) => String(value ?? '') : rawStripReminders
  const expand = options.expandEncoded === false ? (value) => value : expandBase64
  const finish = (value) => stabilizeDynamic(expand(own(String(value ?? '')))).trim()
  const labeled = segments.map((segment) => `[${segment.source}]\n${finish(segment.text)}`).join('\n')
  const user = segments
    .filter((segment) => segment.role === 'user')
    .map((segment) => normalizeText(finish(segment.text)))
    .join('\n')
  const latestSegment = [...segments].reverse().find((segment) => segment.role === 'user')
  return {
    labeled,
    user,
    latest: latestSegment ? finish(latestSegment.text) : '',
    structure: extractStructure(body),
    segments,
  }
}
