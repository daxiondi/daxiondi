/**
 * Chat Completions ↔ Responses 双向转换。
 *
 * 职责：把 OpenAI Chat Completions 的请求体转成 Codex 上游能吃的 Responses body，
 * 再把上游 Responses SSE 事件流转回 Chat Completions 的 SSE / 完整对象。
 *
 * 关键约束（都是上游契约里踩出来的，不要"优化"掉）：
 *
 * 1. 采样类参数在上游一律被拒（统一报 `{"detail":"Unsupported parameter: <name>"}`）：
 *      temperature / top_p / top_k / frequency_penalty / presence_penalty /
 *      stop / stop_sequences / seed / logprobs / top_logprobs / n / verbosity（顶层）
 *    Chat 客户端几乎总会带其中几个，因此缺省在入向转换时**丢弃**它们，
 *    并把字段名记进 `dropped` 供调用方回显（响应头 + WARN 日志）。
 *    真要透传可以显式打开 `passthroughSampling`，但那样上游会 400。
 *
 *    上游仍接受、因此必须保留的：`max_output_tokens`（由 max_tokens /
 *    max_completion_tokens 映射而来）、`text.format`、`text.verbosity`
 *    （注意 verbosity 只在 text 对象内被接受，顶层 verbosity 会 400）、
 *    `reasoning.effort`（由 reasoning_effort 映射而来）。
 *    完整矩阵见 research/live/FINDINGS.md 的「采样参数支持矩阵」。
 *
 * 2. tools 必须是**扁平**格式：`{type:'function', name, description, parameters, strict}`。
 *    Chat 的 `{type:'function', function:{...}}` 嵌套写法会被上游当成未知字段，
 *    工具定义静默失效（不报错，模型就是看不到工具）。所以必须展平。
 *
 * 3. `stream_options` 在 Responses 里不存在，透传会被当未知字段。
 *    流式 usage 由 Responses 的 `response.completed.usage` 提供，与这个开关无关。
 *
 * 4. 出向的 usage 字段名完全不同：Responses 是 input/output_tokens，
 *    Chat 是 prompt/completion_tokens。直接透传会让客户端统计全为 0。
 *
 * 本模块是纯函数集合，不做 IO，便于单测覆盖边界。
 */

import { randomUUID } from 'node:crypto'

// ─────────────── id 生成 ───────────────

/** Chat 侧对象 id 前缀 */
export const CHAT_ID_PREFIX = 'chatcmpl-'

/**
 * 生成合法的 `chatcmpl-` id。
 * 结构对齐 OpenAI：前缀 + 24 位小写十六进制（不用连字符，避免被客户端正则拒绝）。
 */
export function newChatCompletionId() {
  return CHAT_ID_PREFIX + randomUUID().replace(/-/g, '').slice(0, 24)
}

/** 判断一个字符串是否是本模块生成的合法 chatcmpl id */
export function isChatCompletionId(id) {
  return typeof id === 'string' && /^chatcmpl-[0-9a-f]{24}$/.test(id)
}

// ─────────────── content 归一化 ───────────────

/**
 * 把任意 content 压成纯文本。
 * Chat 的 content 可能是字符串、part 数组、或 null（纯 tool_calls 消息）。
 */
export function contentToText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let out = ''
    for (const p of content) {
      if (typeof p === 'string') { out += p; continue }
      if (!p || typeof p !== 'object') continue
      if (typeof p.text === 'string') out += p.text
    }
    return out
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text
  return ''
}

/**
 * Chat content → Responses content parts。
 *
 * part 类型按角色区分：assistant 用 `output_text`，其他用 `input_text`。
 * 这不是风格问题 —— 上游按 part 类型区分历史轮次是谁说的，混用会让
 * assistant 的历史被当成用户输入。
 *
 * @param {unknown} content
 * @param {'user'|'assistant'} role
 * @returns {Array<object>}
 */
export function toResponsesContent(content, role = 'user') {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') {
    return content ? [{ type: textType, text: content }] : []
  }
  if (!Array.isArray(content)) return []

  const out = []
  for (const p of content) {
    if (typeof p === 'string') {
      if (p) out.push({ type: textType, text: p })
      continue
    }
    if (!p || typeof p !== 'object') continue

    if (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') {
      const text = String(p.text ?? '')
      if (text) out.push({ type: textType, text })
      continue
    }
    // 图片只在 user 侧有意义；assistant 侧的历史图片直接忽略
    if (role === 'assistant') continue
    if (p.type === 'image_url') {
      const image = p.image_url
      const url = typeof image === 'string' ? image : image?.url
      if (typeof url !== 'string' || !url) continue
      const part = { type: 'input_image', image_url: url }
      const detail = typeof image === 'object' ? image?.detail : undefined
      if (detail) part.detail = String(detail)
      out.push(part)
      continue
    }
    if (p.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url
      if (typeof url === 'string' && url) out.push({ type: 'input_image', image_url: url })
      continue
    }
  }
  return out
}

// ─────────────── tools / response_format ───────────────

/**
 * Chat tools → Responses tools（**扁平**化）。
 *
 * 支持三种输入形态：
 *   - Chat 标准嵌套 `{type:'function', function:{name, description, parameters}}`
 *   - 已经是 Responses 扁平 `{type:'function', name, ...}`（幂等）
 *   - 非 function 的内建工具 `{type:'web_search'}` 之类，原样保留
 *
 * 空名函数直接丢弃：上游对 name 为空会 400，而且一条坏定义会拖垮整份 tools。
 *
 * @param {Array<object>} tools
 * @returns {Array<object>}
 */
export function chatToolsToResponsesTools(tools) {
  if (!Array.isArray(tools)) return []
  const out = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const type = String(t.type || 'function')
    if (type !== 'function') {
      out.push({ ...t })
      continue
    }
    const fn = t.function && typeof t.function === 'object' ? t.function : t
    const name = typeof fn.name === 'string' ? fn.name.trim() : ''
    if (!name) continue
    const tool = { type: 'function', name }
    if (typeof fn.description === 'string' && fn.description) tool.description = fn.description
    if (fn.parameters && typeof fn.parameters === 'object') tool.parameters = fn.parameters
    else tool.parameters = { type: 'object', properties: {} }
    // strict 必须是布尔。上游对非布尔的 strict 会拒绝整条工具定义。
    if (typeof t.strict === 'boolean') tool.strict = t.strict
    else if (typeof fn.strict === 'boolean') tool.strict = fn.strict
    else tool.strict = false
    out.push(tool)
  }
  return out
}

/**
 * Chat tool_choice → Responses tool_choice。
 * 字符串三态直接可用；命名工具要从嵌套结构展平。
 */
export function chatToolChoiceToResponses(choice) {
  if (choice == null) return undefined
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
    return undefined
  }
  if (typeof choice === 'object') {
    const name = choice.function?.name ?? choice.name
    if (typeof name === 'string' && name.trim()) return { type: 'function', name: name.trim() }
  }
  return undefined
}

/**
 * Chat response_format → Responses `text.format`。
 *
 * 注意 json_schema 的字段要提一层：Chat 是 `{json_schema:{name,schema,strict}}`，
 * Responses 是 `{name,schema,strict}` 平铺在 format 里。
 */
export function chatResponseFormatToTextFormat(responseFormat) {
  if (!responseFormat || typeof responseFormat !== 'object') return undefined
  const type = String(responseFormat.type || '')
  if (type === 'text') return { type: 'text' }
  if (type === 'json_object') return { type: 'json_object' }
  if (type === 'json_schema') {
    const raw = responseFormat.json_schema && typeof responseFormat.json_schema === 'object'
      ? responseFormat.json_schema
      : responseFormat
    const format = { type: 'json_schema' }
    if (typeof raw.name === 'string' && raw.name) format.name = raw.name
    if (raw.schema && typeof raw.schema === 'object') format.schema = raw.schema
    if (typeof raw.strict === 'boolean') format.strict = raw.strict
    return format
  }
  return undefined
}

// ─────────────── 入向：Chat → Responses ───────────────

/** 入向转换时会被丢弃、并记进 `dropped` 的 Chat 字段 */
export const CHAT_DROPPED_FIELDS = Object.freeze([
  'stream', 'stream_options', 'stop', 'stop_sequences', 'n', 'logprobs', 'top_logprobs',
  'presence_penalty', 'frequency_penalty', 'seed', 'user', 'store',
  'temperature', 'top_p', 'top_k', 'echo',
])

/**
 * 采样类字段：上游一律拒绝，默认丢弃。
 *
 * 与 CHAT_DROPPED_FIELDS 的区别：这一组是"采样语义"，
 * `passthroughSampling` 只影响这一组；其余字段（stream_options / user / store…）
 * 无论开关如何都不会发上游。
 */
export const SAMPLING_FIELDS = Object.freeze([
  'temperature', 'top_p', 'top_k',
  'frequency_penalty', 'presence_penalty',
  'stop', 'stop_sequences', 'seed',
  'logprobs', 'top_logprobs', 'n',
])

/** 入向转换时原样透传给 Responses 的 Chat 字段 */
export const CHAT_PASSTHROUGH_FIELDS = Object.freeze([
  'model', 'metadata', 'parallel_tool_calls', 'service_tier',
  'previous_response_id', 'reasoning_effort', 'verbosity',
])

/**
 * 处理单条 assistant 消息里的 tool_calls → Responses `function_call` items。
 * arguments 在 Chat 里是字符串，在 Responses 里也要求字符串；
 * 对象形态要序列化，否则上游会把整条 item 丢掉。
 */
export function toolCallsToFunctionCallItems(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  const out = []
  for (const c of toolCalls) {
    if (!c || typeof c !== 'object') continue
    const fn = c.function && typeof c.function === 'object' ? c.function : {}
    const name = typeof fn.name === 'string' ? fn.name : ''
    if (!name) continue
    let args = fn.arguments
    if (typeof args !== 'string') args = JSON.stringify(args ?? {})
    const item = { type: 'function_call', call_id: String(c.id ?? ''), name, arguments: args }
    out.push(item)
  }
  return out
}

/**
 * Chat messages → Responses 的 `instructions` + `input`。
 *
 * role 映射：
 *   system / developer → instructions（合并，\n\n 连接）
 *   user               → message(input_text)
 *   assistant          → function_call items + message(output_text)
 *   tool               → function_call_output（call_id 对齐 assistant 的 tool_call id）
 *
 * instructions 只有单一字符串字段，多条 system 会被合并 —— 顺序保留，
 * 这是有损的（上游拿不到"多条 system 的边界"），但不合并会直接丢掉后面的内容。
 *
 * @returns {{instructions:string|null, input:Array<object>}}
 */
export function chatMessagesToResponsesInput(messages = []) {
  const instructions = []
  const input = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue
    const role = String(m.role || 'user')

    if (role === 'system' || role === 'developer') {
      const text = contentToText(m.content)
      if (text) instructions.push(text)
      continue
    }

    if (role === 'tool') {
      const output = contentToText(m.content)
      input.push({
        type: 'function_call_output',
        call_id: String(m.tool_call_id ?? m.call_id ?? m.name ?? ''),
        output,
      })
      continue
    }

    if (role === 'assistant') {
      // 顺序固定：先 function_call，再文本 message。
      // 反过来会让上游认为模型先说了话再调工具，与 Chat 语义不一致。
      for (const item of toolCallsToFunctionCallItems(m.tool_calls)) input.push(item)
      const content = toResponsesContent(m.content, 'assistant')
      if (content.length > 0) input.push({ type: 'message', role: 'assistant', content })
      continue
    }

    const content = toResponsesContent(m.content, 'user')
    if (content.length === 0) continue
    input.push({ type: 'message', role: 'user', content })
  }
  return { instructions: instructions.length ? instructions.join('\n\n') : null, input }
}

/**
 * Chat Completions 请求体 → Codex Responses 请求体。
 *
 * 返回 `{ body, dropped }`：
 *   - `body` 是可直接交给 buildOutboundBody 的 Responses body
 *   - `dropped` 是被丢弃的字段名，调用方应打一次 debug 日志
 *
 * 注意 `stream` 不在这里决定：上游硬性要求 `stream:true`，由 buildOutboundBody 统一设。
 *
 * @param {object} chat
 * @param {{passthroughSampling?:boolean}} [opts]
 */
export function chatToResponses(chat = {}, { passthroughSampling = false } = {}) {
  const src = chat && typeof chat === 'object' ? chat : {}
  const dropped = []

  const { instructions, input } = chatMessagesToResponsesInput(src.messages)
  const body = { model: src.model }
  if (instructions) body.instructions = instructions
  body.input = input

  // max tokens：max_completion_tokens 优先（新字段），回退 max_tokens。
  // 只有正数才转：0 / -1 / 字符串在上游会被拒绝。
  const maxOut = pickMaxOutputTokens(src)
  if (maxOut != null) body.max_output_tokens = maxOut

  if (passthroughSampling) {
    if (isFiniteNumber(src.temperature)) body.temperature = src.temperature
    if (isFiniteNumber(src.top_p)) body.top_p = src.top_p
    if (isFiniteNumber(src.top_k)) body.top_k = src.top_k
  } else {
    for (const field of SAMPLING_FIELDS) {
      if (src[field] !== undefined) dropped.push(field)
    }
  }

  const tools = chatToolsToResponsesTools(src.tools)
  if (tools.length) body.tools = tools

  const toolChoice = chatToolChoiceToResponses(src.tool_choice)
  if (toolChoice !== undefined) body.tool_choice = toolChoice

  if (typeof src.parallel_tool_calls === 'boolean') body.parallel_tool_calls = src.parallel_tool_calls

  // text.format：response_format 与 chat 原生 text 两条来源，response_format 优先
  const format = chatResponseFormatToTextFormat(src.response_format)
  const text = {}
  if (format) text.format = format
  if (typeof src.verbosity === 'string' && src.verbosity) text.verbosity = src.verbosity
  if (Object.keys(text).length) body.text = text

  // reasoning_effort → reasoning.effort（Chat 的扁平字段在 Responses 里是嵌套对象）
  if (typeof src.reasoning_effort === 'string' && src.reasoning_effort) {
    body.reasoning = { effort: src.reasoning_effort }
  }

  if (src.metadata && typeof src.metadata === 'object' && !Array.isArray(src.metadata)) {
    body.metadata = { ...src.metadata }
  }
  if (typeof src.service_tier === 'string' && src.service_tier) body.service_tier = src.service_tier
  if (typeof src.previous_response_id === 'string' && src.previous_response_id) {
    body.previous_response_id = src.previous_response_id
  }

  // 其余显式声明会丢的字段：只在真的出现时记一笔。
  // 采样组已在上面按 passthroughSampling 处理过，这里跳过以免重复记录。
  // `stream` 也跳过：它由 HTTP 层消费（决定回流的形态），不算"被忽略的参数"，
  // 每个流式请求都报一次只会把真正被丢的字段淹掉。
  for (const field of CHAT_DROPPED_FIELDS) {
    if (SAMPLING_FIELDS.includes(field) || field === 'stream') continue
    if (src[field] !== undefined && !dropped.includes(field)) dropped.push(field)
  }
  // n=1 与 n 缺省是等价的，不值得报警
  if (src.n === 1) {
    const i = dropped.indexOf('n')
    if (i >= 0) dropped.splice(i, 1)
  }

  return { body, dropped }
}

/**
 * 取上游的 max_output_tokens。
 * 只用正整数：上游对 0 / 负数 / 字符串一律拒绝，与其让它 400，不如不回这个字段。
 */
export function pickMaxOutputTokens(src = {}) {
  for (const key of ['max_completion_tokens', 'max_tokens']) {
    const v = src[key]
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v
  }
  return null
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

// ─────────────── 出向：usage / finish_reason ───────────────

/**
 * Responses usage → Chat usage。
 *
 * 字段名完全不同，且要补两组 details（客户端 SDK 会读，缺了会拿到 undefined）：
 *   input_tokens  → prompt_tokens
 *   output_tokens → completion_tokens
 */
export function responsesUsageToChatUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {}
  const prompt = Number(u.input_tokens ?? 0) || 0
  const completion = Number(u.output_tokens ?? 0) || 0
  const total = Number.isFinite(u.total_tokens) ? Number(u.total_tokens) : prompt + completion
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    prompt_tokens_details: {
      cached_tokens: Number(u.input_tokens_details?.cached_tokens ?? 0) || 0,
    },
    completion_tokens_details: {
      reasoning_tokens: Number(u.output_tokens_details?.reasoning_tokens ?? 0) || 0,
    },
  }
}

/**
 * 推导 Chat 的 finish_reason。
 *
 * 顺序很重要：有工具调用就是 tool_calls，优先于 length ——
 * 否则被 max_output_tokens 截断的工具调用会被报成 length，客户端不会去执行工具。
 */
export function responsesFinishReason(response, { hasToolCalls = false } = {}) {
  if (hasToolCalls) return 'tool_calls'
  const status = response?.status
  const reason = response?.incomplete_details?.reason
  if (status === 'incomplete') {
    if (reason === 'max_output_tokens') return 'length'
    if (reason === 'content_filter') return 'content_filter'
    return 'length'
  }
  return 'stop'
}

/**
 * 从 Responses 的 output 数组里抽文本与工具调用。
 * output 里既有 message 也有 function_call，顺序即生成顺序。
 */
export function extractFromResponseOutput(output = []) {
  let text = ''
  const toolCalls = []
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        // output_text 是正常文本；refusal 也当文本回给客户端，不然内容会凭空消失
        if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text
        else if (part?.type === 'refusal' && typeof part.refusal === 'string') text += part.refusal
      }
      continue
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id || item.id || ''),
        type: 'function',
        function: {
          name: String(item.name || ''),
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      })
    }
  }
  return { text, toolCalls }
}

/** Responses response 对象 → Chat 的 assistant message */
export function responseToChatMessage(response) {
  const { text, toolCalls } = extractFromResponseOutput(response?.output)
  const message = { role: 'assistant', content: text }
  if (toolCalls.length) {
    message.content = text || null
    message.tool_calls = toolCalls
  }
  return message
}

/**
 * Responses response 对象 → 完整 `chat.completion`。
 *
 * @param {object} response 上游 response.completed 里的 response
 * @param {{model?:string, created?:number, id?:string}} [opts]
 */
export function responsesToChatCompletion(response, { model, created, id } = {}) {
  const message = responseToChatMessage(response)
  const hasToolCalls = Boolean(message.tool_calls?.length)
  return {
    id: id || newChatCompletionId(),
    object: 'chat.completion',
    created: created ?? Math.floor(Date.now() / 1000),
    model: model || response?.model || '',
    choices: [{
      index: 0,
      message,
      finish_reason: responsesFinishReason(response, { hasToolCalls }),
    }],
    usage: responsesUsageToChatUsage(response?.usage),
  }
}

// ─────────────── 出向：SSE ───────────────

/**
 * 一帧 Chat SSE。
 *
 * 只发 `data:` 行，不发 `event:` 行 —— OpenAI 官方的 chat 流就是这样，
 * 多一个 event 行会让部分老旧客户端把帧当未知事件丢掉。
 */
export function chatSseFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/** 流结束哨兵 */
export const CHAT_DONE_FRAME = 'data: [DONE]\n\n'

/** Chat chunk 骨架 */
export function chatChunk({ id, model, created, delta, finishReason = null, usage, index = 0 }) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index, delta, finish_reason: finishReason, logprobs: null }],
  }
  if (usage) chunk.usage = usage
  return chunk
}

/**
 * 把 Responses 事件迭代器转成 Chat SSE 帧序列。
 *
 * 映射表：
 *   response.created                → 首帧（role: assistant, delta:{}）—— 让客户端立刻建结构
 *   response.output_text.delta      → delta.content
 *   response.output_item.added      → function_call 的首个 tool_calls delta（带 id/name）
 *   response.function_call_arguments.delta → tool_calls[].function.arguments 增量
 *   response.completed              → finish_reason + usage
 *   response.failed / response.incomplete → finish_reason（incomplete 走 length）
 *
 * 之后由调用方补 `[DONE]`（本生成器负责发，保持"一个生成器 = 一整条流"）。
 *
 * @param {AsyncIterable<{event:string|null, data:any}>} events
 * @param {{model?:string, id?:string, created?:number, includeUsage?:boolean}} [opts]
 */
export async function* responsesEventsToChatSse(events, {
  model, id, created, includeUsage = true,
} = {}) {
  const chunkId = id || newChatCompletionId()
  const ts = created ?? Math.floor(Date.now() / 1000)
  let respModel = model || ''
  let started = false
  let toolIndex = -1
  // output_index → Chat 的 tool_calls index。上游的 output_index 是全局序号，
  // 里面还夹着 message item，不能直接拿来当 Chat 的 tool index。
  const toolIndexByOutput = new Map()

  const emit = (delta, finishReason = null) => chatChunk({
    id: chunkId, model: respModel, created: ts, delta, finishReason,
  })

  for await (const ev of events) {
    const name = ev?.event || ev?.data?.type || ''
    const data = ev?.data || {}

    if (name === 'response.created' || name === 'response.in_progress') {
      if (started) continue
      const m = data.response?.model
      if (m && !model) respModel = m
      started = true
      yield chatSseFrame(emit({ role: 'assistant', content: '' }))
      continue
    }

    if (name === 'response.output_item.added') {
      const item = data.item
      if (item?.type === 'function_call') {
        toolIndex += 1
        if (typeof data.output_index === 'number') toolIndexByOutput.set(data.output_index, toolIndex)
        if (!started) {
          started = true
          yield chatSseFrame(emit({ role: 'assistant', content: '' }))
        }
        yield chatSseFrame(emit({
          tool_calls: [{
            index: toolIndex,
            id: String(item.call_id || item.id || ''),
            type: 'function',
            function: { name: String(item.name || ''), arguments: '' },
          }],
        }))
      }
      continue
    }

    if (name === 'response.function_call_arguments.delta') {
      const idx = toolIndexByOutput.has(data.output_index)
        ? toolIndexByOutput.get(data.output_index)
        : 0
      if (typeof data.delta === 'string' && data.delta) {
        yield chatSseFrame(emit({
          tool_calls: [{ index: idx, function: { arguments: data.delta } }],
        }))
      }
      continue
    }

    if (name === 'response.output_text.delta') {
      if (typeof data.delta === 'string' && data.delta) {
        if (!started) {
          started = true
          yield chatSseFrame(emit({ role: 'assistant', content: '' }))
        }
        yield chatSseFrame(emit({ content: data.delta }))
      }
      continue
    }

    if (name === 'response.completed' || name === 'response.incomplete') {
      const response = data.response || null
      if (response?.model && !model) respModel = response.model
      const { toolCalls } = extractFromResponseOutput(response?.output)
      const finish = responsesFinishReason(response, { hasToolCalls: toolCalls.length > 0 })
      const chunk = chatChunk({
        id: chunkId, model: respModel, created: ts,
        delta: {}, finishReason: finish,
        usage: includeUsage ? responsesUsageToChatUsage(response?.usage) : undefined,
      })
      yield chatSseFrame(chunk)
      yield CHAT_DONE_FRAME
      return
    }

    if (name === 'response.failed') {
      // 上游明确失败：先把 finish_reason 发出去，让客户端能收尾，
      // 再发一帧 error。不发 finish_reason 的话客户端会一直等 delta。
      yield chatSseFrame(emit({}, 'stop'))
      yield chatSseFrame({
        error: {
          type: 'upstream_error',
          code: data.response?.error?.code || 'response_failed',
          message: data.response?.error?.message || 'upstream reported response.failed',
        },
      })
      yield CHAT_DONE_FRAME
      return
    }
  }

  // 事件流意外结束（没有 completed）：仍要给出合法的收尾，
  // 否则客户端会挂到超时。
  yield chatSseFrame(emit({}, 'stop'))
  yield CHAT_DONE_FRAME
}

/**
 * 聚合 Responses 事件流 → 完整 response 对象（用于非流式）。
 *
 * 优先用 `response.completed` 里的完整 response；上游没给时用累积的 delta 兜底
 * 拼一个最小可用的 response，保证非流式请求不会因为缺 completed 而返回空。
 */
export async function collectResponsesStream(events) {
  let completed = null
  let model = ''
  let responseId = ''
  let text = ''
  const toolCalls = []
  const toolIndex = new Map()

  for await (const ev of events) {
    const name = ev?.event || ev?.data?.type || ''
    const data = ev?.data || {}

    if (name === 'response.created') {
      responseId = data.response?.id || responseId
      model = data.response?.model || model
      continue
    }
    if (name === 'response.output_text.delta') {
      if (typeof data.delta === 'string') text += data.delta
      continue
    }
    if (name === 'response.output_item.added' && data.item?.type === 'function_call') {
      const idx = toolCalls.length
      toolCalls.push({
        type: 'function_call',
        call_id: String(data.item.call_id || ''),
        name: String(data.item.name || ''),
        arguments: '',
      })
      if (typeof data.output_index === 'number') toolIndex.set(data.output_index, idx)
      continue
    }
    if (name === 'response.function_call_arguments.delta') {
      const idx = toolIndex.has(data.output_index) ? toolIndex.get(data.output_index) : 0
      if (toolCalls[idx] && typeof data.delta === 'string') toolCalls[idx].arguments += data.delta
      continue
    }
    if (name === 'response.completed' || name === 'response.incomplete') {
      completed = data.response || null
      continue
    }

    // 流内失败必须当成失败，不能当"没完成"。
    //
    // 上游过载/出事故时，HTTP 状态码仍然是 200，失败信息在流里面：
    //   event: error
    //   {"type":"error","error":{"code":"server_is_overloaded",...}}
    //   event: response.failed
    //   {"type":"response.failed","response":{"status":"failed","error":{...}}}
    //
    // 原先这里两者都不认，循环结束后掉进下面的兜底分支，拼出一个
    // status:'incomplete' 的**假成功**响应 —— 调用方拿到 200 + 空 output，
    // 无从知道上游其实拒了。实测 20 槽位并发时 4/20 命中这个状态。
    if (name === 'response.failed' || name === 'error') {
      const err = data.response?.error || data.error || {}
      const code = String(err.code || err.type || 'stream_failed')
      const message = String(err.message || 'upstream stream failed')
      const failure = new Error(`upstream stream failed: ${code} ${message}`.trim())
      failure.code = code
      failure.upstream = { status: data.response?.status || 'failed', code, message }
      throw failure
    }
  }

  if (completed) return completed

  // 兜底：没有 completed 事件，用累积内容拼一个 response
  const output = []
  if (text) {
    output.push({
      type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text }],
    })
  }
  for (const call of toolCalls) output.push(call)
  return {
    id: responseId,
    object: 'response',
    status: 'incomplete',
    model,
    output,
    usage: null,
    incomplete_details: { reason: 'stream_ended_without_completed' },
  }
}
