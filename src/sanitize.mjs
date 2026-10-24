/**
 * Anthropic Messages 出站请求体清洗。
 *
 * 这层的目标是**只让官方 schema 认识的字段出站**。两个动因：
 *
 *   1. **封号**：我们内部有 machine_id / device_id / account_uuid / session
 *      这类标记。它们一旦发给上游，等于主动告诉对方"这个请求被中间层
 *      加工过"。上游 schema 也不认这些键，会 400 unexpected field。
 *
 *   2. **400**：调用方可能从 OpenAI 风格接口过来，带 response_format /
 *      reasoning / store 之类残留。Anthropic 的 Messages schema 不接受。
 *
 * 对齐依据：官方 vm2api v1.3.220 `src/lib/protocol/sanitize.mjs`。
 * 我们最初只删了 betas / __betas__ 两个内部键，其余全部透传 ——
 * 这是实打实的封号风险，不是风格问题。
 */

/**
 * 顶层必须丢弃的键。
 *
 * 分三类，都来自实测：
 *   · 我们的内部标记（machine_id / device_id / …）
 *   · OpenAI / Responses 残留（store / reasoning / input / …）
 *   · 只在 SDK 层有意义、不该上线的（extra_body / extra_headers / settings）
 *
 * 大小写变体一起列 —— 调用方可能用 camelCase，上游 schema 只认 snake_case，
 * 漏一个就 400。
 */
export const DROP_TOP = new Set([
  // ── 我们的内部标记（最危险：泄漏 = 自证中间层）
  'machine_id',
  'device_id',
  'account_uuid',
  'session',
  'web_search',
  'betas',
  '__betas__',
  'kin_outbound_shape',
  'persona',
  'slot',
  // ── SDK / 传输层私有
  'settings',
  'claude_settings',
  'env',
  'extra_body',
  'extra_headers',
  'extra',
  'workspace',
  'rewrite',
  // ── OpenAI / Responses 残留
  'user',
  'user_id',
  'n',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'functions',
  'function_call',
  'response_format',
  'seed',
  'parallel_tool_calls',
  'reasoning_effort',
  'max_completion_tokens',
  'max_output_tokens',
  'store',
  'modalities',
  'audio',
  'prediction',
  'stream_options',
  'tool_resources',
  'instructions',
  'input',
  'truncation',
  'include',
  'previous_response_id',
  'reasoning',
  'prompt',
  'suffix',
  'best_of',
  'echo',
  // ── camelCase 变体
  'frequencyPenalty',
  'presencePenalty',
  'logitBias',
  'functionCall',
  'responseFormat',
  'maxCompletionTokens',
  'parallelToolCalls',
  'toolResources',
  'streamOptions',
  'previousResponseId',
  'reasoningEffort',
])

/**
 * content block 里上游 schema 会拒绝的字段。
 * `annotations` 是 OpenAI 的，Anthropic 的 TextBlock 不认。
 */
export const DROP_CONTENT_KEYS = new Set(['annotations'])

/**
 * 把 OpenAI 的 response_format / text.format 转成 Anthropic 的 output_config。
 *
 * 必须在删 response_format **之前**调用 —— 否则信息就丢了。
 * 这个方法本身就是"先救再删"的顺序。
 */
export function openaiResponseFormatToOutputConfig(responseFormat) {
  if (!responseFormat || typeof responseFormat !== 'object') return null
  const type = String(responseFormat.type || '').toLowerCase()

  if (type === 'json_schema') {
    const wrapper =
      responseFormat.json_schema && typeof responseFormat.json_schema === 'object'
        ? responseFormat.json_schema
        : responseFormat
    const schema = wrapper.schema || wrapper
    if (!schema || typeof schema !== 'object') return null
    const format = { type: 'json_schema', schema }
    if (wrapper.name) format.name = wrapper.name
    if (wrapper.description) format.description = wrapper.description
    return { format }
  }
  if (type === 'json_object') {
    return { format: { type: 'json_schema', schema: { type: 'object' } } }
  }
  return null
}

/** 在 response_format 被删掉之前，把它提升成 output_config。 */
export function applyStructuredOutput(out, source = {}) {
  if (!out || typeof out !== 'object') return out
  const config = out.output_config && typeof out.output_config === 'object'
    ? out.output_config
    : source.output_config
  if (config?.format) {
    out.output_config = config
    return out
  }
  const mapped = openaiResponseFormatToOutputConfig(source.response_format)
    || openaiResponseFormatToOutputConfig(source.text?.format)
  if (mapped || config) out.output_config = { ...config, ...mapped }
  return out
}

function stripIllegalContentBlock(block) {
  if (!block || typeof block !== 'object') return block
  let next = block
  for (const key of DROP_CONTENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) continue
    if (next === block) next = { ...block }
    delete next[key]
  }
  return next
}

/** 删 content 数组里每个 block 的非法字段。字符串 content 原样返回。 */
export function stripIllegalContentFields(content) {
  if (!Array.isArray(content)) return content
  let changed = false
  const out = content.map((block) => {
    const next = stripIllegalContentBlock(block)
    if (next !== block) changed = true
    return next
  })
  return changed ? out : content
}

/**
 * 对 messages 里每条 message 的 content 做非法字段清理。
 */
export function stripIllegalMessageContent(messages) {
  if (!Array.isArray(messages)) return messages
  let changed = false
  const out = messages.map((m) => {
    if (!m || typeof m !== 'object') return m
    const content = stripIllegalContentFields(m.content)
    if (content === m.content) return m
    changed = true
    return { ...m, content }
  })
  return changed ? out : messages
}

/**
 * 主入口：清洗出站 Anthropic 请求体。
 *
 * 顺序很重要：
 *   1. 先把 response_format 提升成 output_config（否则下一步删了就没了）
 *   2. 按黑名单删顶层键
 *   3. 清 content block 的非法字段
 *
 * @param {object} body 入站请求体
 * @returns {object} 新对象（不改原对象）
 */
export function sanitizeAnthropicBody(body) {
  if (!body || typeof body !== 'object') return {}

  // 1. 先救 structured output
  const promoted = applyStructuredOutput({ ...body }, body)

  // 2. 删顶层黑名单键
  const out = {}
  for (const [k, v] of Object.entries(promoted)) {
    if (v === undefined) continue
    if (DROP_TOP.has(k)) continue
    out[k] = v
  }

  // 3. 清 content 里的非法字段
  if (out.messages) out.messages = stripIllegalMessageContent(out.messages)

  return out
}

/**
 * 审计用：列出这个 body 里会被丢弃的键。
 * 测试与泄漏反扫都用它，避免各处重复实现判定逻辑。
 */
export function droppedKeysOf(body) {
  if (!body || typeof body !== 'object') return []
  return Object.keys(body).filter((k) => DROP_TOP.has(k))
}
