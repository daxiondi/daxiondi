/**
 * Chat Completions ↔ Responses 双向转换的单元测试。
 *
 * 覆盖三类：
 *   1. 入向 Chat → Responses（messages / tools / 参数丢弃 / response_format）
 *   2. 出向 Responses → Chat（usage / finish_reason / 非流式聚合）
 *   3. SSE 事件流映射（文本增量、工具调用增量、异常收尾）
 *
 * 全部是纯函数测试，不碰网络。真实上游行为见 test/codex-live.mjs（默认不跑）。
 */

import {
  newChatCompletionId, isChatCompletionId, contentToText, toResponsesContent,
  chatToolsToResponsesTools, chatToolChoiceToResponses, chatResponseFormatToTextFormat,
  toolCallsToFunctionCallItems, chatMessagesToResponsesInput, chatToResponses,
  pickMaxOutputTokens, responsesUsageToChatUsage, responsesFinishReason,
  extractFromResponseOutput, responseToChatMessage, responsesToChatCompletion,
  chatSseFrame, chatChunk, responsesEventsToChatSse, collectResponsesStream,
  CHAT_DONE_FRAME, CHAT_ID_PREFIX, CHAT_DROPPED_FIELDS, SAMPLING_FIELDS,
} from '../src/codex-convert.mjs'

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) { pass += 1; console.log('  ok   ', name) }
  else { fail += 1; console.log('  FAIL ', name, '\n    got ', a, '\n    want', b) }
}
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ok   ', name) }
  else { fail += 1; console.log('  FAIL ', name, detail === undefined ? '' : `\n    ${detail}`) }
}

/** 把 SSE 帧文本解析回对象；`[DONE]` 返回字符串 'DONE' */
function parseFrames(text) {
  const out = []
  for (const block of String(text).split('\n\n')) {
    const line = block.trim()
    if (!line) continue
    if (!line.startsWith('data: ')) { out.push({ raw: line }); continue }
    const payload = line.slice(6)
    if (payload === '[DONE]') { out.push('DONE'); continue }
    out.push(JSON.parse(payload))
  }
  return out
}

/** 把事件对象数组包成异步迭代器（模拟 CodexUpstream.iterEvents 的输出） */
async function* asEvents(items) {
  for (const it of items) yield it
}
const ev = (event, data) => ({ event, data })

// ═══════════════ 1. id 与 content ═══════════════

console.log('\n1. id 生成与 content 归一化')

eq('id 前缀', CHAT_ID_PREFIX, 'chatcmpl-')
ok('id 形态合法', isChatCompletionId(newChatCompletionId()), newChatCompletionId())
eq('id 总长度（前缀 9 + 24 位 hex）', newChatCompletionId().length, 33)
eq('两次生成不同', newChatCompletionId() === newChatCompletionId(), false)
eq('非法 id 被拒', isChatCompletionId('chatcmpl-XYZ'), false)
eq('空串不是合法 id', isChatCompletionId(''), false)

eq('字符串 content 原样', contentToText('hello'), 'hello')
eq('null content → 空串', contentToText(null), '')
eq('part 数组拼接', contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
eq('对象 content 取 text', contentToText({ text: 'x' }), 'x')
eq('未知结构 → 空串', contentToText(42), '')

eq('user 文本 part 是 input_text',
  toResponsesContent('hi', 'user'), [{ type: 'input_text', text: 'hi' }])
eq('assistant 文本 part 是 output_text',
  toResponsesContent('hi', 'assistant'), [{ type: 'output_text', text: 'hi' }])
eq('空字符串不产生 part', toResponsesContent('', 'user'), [])
eq('image_url 转 input_image', toResponsesContent(
  [{ type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'high' } }], 'user'),
  [{ type: 'input_image', image_url: 'https://x/y.png', detail: 'high' }])
eq('assistant 侧图片被忽略', toResponsesContent([{ type: 'image_url', image_url: { url: 'u' } }], 'assistant'), [])

// ═══════════════ 2. tools ═══════════════

console.log('\n2. tools / tool_choice / response_format')

eq('Chat 嵌套 function 展平', chatToolsToResponsesTools([{
  type: 'function',
  function: { name: 'get_weather', description: 'd', parameters: { type: 'object', properties: {} } },
}]), [{
  type: 'function', name: 'get_weather', description: 'd',
  parameters: { type: 'object', properties: {} }, strict: false,
}])

eq('已扁平的定义幂等', chatToolsToResponsesTools([{
  type: 'function', name: 'f', parameters: { type: 'object', properties: {} },
}]), [{ type: 'function', name: 'f', parameters: { type: 'object', properties: {} }, strict: false }])

eq('空名函数被丢弃', chatToolsToResponsesTools([{ type: 'function', function: { name: '' } }]), [])
eq('缺 parameters 补空 schema', chatToolsToResponsesTools([{ type: 'function', name: 'f' }]), [{
  type: 'function', name: 'f', parameters: { type: 'object', properties: {} }, strict: false,
}])
eq('strict 从顶层取', chatToolsToResponsesTools([{ type: 'function', name: 'f', strict: true }])[0].strict, true)
eq('strict 从嵌套取', chatToolsToResponsesTools([
  { type: 'function', function: { name: 'f', strict: true } }])[0].strict, true)
eq('内建工具原样保留', chatToolsToResponsesTools([{ type: 'web_search' }]), [{ type: 'web_search' }])
eq('非数组返回空', chatToolsToResponsesTools(null), [])

eq('tool_choice auto 透传', chatToolChoiceToResponses('auto'), 'auto')
eq('tool_choice required 透传', chatToolChoiceToResponses('required'), 'required')
eq('tool_choice 未知字符串丢弃', chatToolChoiceToResponses('whatever'), undefined)
eq('tool_choice 命名工具展平',
  chatToolChoiceToResponses({ type: 'function', function: { name: 'f' } }),
  { type: 'function', name: 'f' })

eq('response_format json_object', chatResponseFormatToTextFormat({ type: 'json_object' }), { type: 'json_object' })
eq('response_format text', chatResponseFormatToTextFormat({ type: 'text' }), { type: 'text' })
eq('json_schema 字段提层', chatResponseFormatToTextFormat({
  type: 'json_schema',
  json_schema: { name: 'Out', schema: { type: 'object' }, strict: true },
}), { type: 'json_schema', name: 'Out', schema: { type: 'object' }, strict: true })
eq('缺 response_format 返回 undefined', chatResponseFormatToTextFormat(null), undefined)

// ═══════════════ 3. messages → input ═══════════════

console.log('\n3. messages → instructions / input')

{
  const r = chatMessagesToResponsesInput([
    { role: 'system', content: 'you are terse' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ])
  eq('system 提到 instructions', r.instructions, 'you are terse')
  eq('输入条数', r.input.length, 2)
  eq('user 消息结构', r.input[0], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] })
  eq('assistant 消息结构', r.input[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] })
}

{
  const r = chatMessagesToResponsesInput([
    { role: 'system', content: 'a' },
    { role: 'developer', content: 'b' },
  ])
  eq('多条 system/developer 合并', r.instructions, 'a\n\nb')
  eq('只有 instructions 没有 input', r.input, [])
}

{
  const r = chatMessagesToResponsesInput([
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ])
  eq('function_call 在文本消息之前',
    r.input.map((i) => i.type).join(','), 'message,function_call,function_call_output')
  eq('function_call 结构', r.input[1], {
    type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"x":1}',
  })
  eq('tool 消息转 function_call_output', r.input[2], {
    type: 'function_call_output', call_id: 'call_1', output: 'result',
  })
}

eq('arguments 对象被序列化', toolCallsToFunctionCallItems([
  { id: 'c', function: { name: 'f', arguments: { a: 1 } } }])[0].arguments, '{"a":1}')
eq('缺 call_id 仍生成 item（空串）', toolCallsToFunctionCallItems([
  { function: { name: 'f', arguments: '{}' } }])[0].call_id, '')
eq('空名 tool_call 丢弃', toolCallsToFunctionCallItems([{ id: 'c', function: {} }]), [])

// ═══════════════ 4. chatToResponses 整体 ═══════════════

console.log('\n4. chatToResponses 请求体转换')

{
  const { body, dropped } = chatToResponses({
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    temperature: 0.3,
    top_p: 0.9,
    stream: true,
    stream_options: { include_usage: true },
  })
  eq('model 透传', body.model, 'gpt-6-astra')
  eq('max_tokens → max_output_tokens', body.max_output_tokens, 128)
  eq('temperature 被丢弃（上游 400）', 'temperature' in body, false)
  eq('top_p 被丢弃（上游 400）', 'top_p' in body, false)
  eq('stream_options 不被透传', 'stream_options' in body, false)
  ok('dropped 记录 temperature', dropped.includes('temperature'), dropped.join(','))
  ok('dropped 记录 top_p', dropped.includes('top_p'), dropped.join(','))
  ok('dropped 记录 stream_options', dropped.includes('stream_options'), dropped.join(','))
}

{
  const { body } = chatToResponses({ model: 'm', messages: [], max_completion_tokens: 64, max_tokens: 999 })
  eq('max_completion_tokens 优先于 max_tokens', body.max_output_tokens, 64)
}
eq('max_tokens=0 不被转', pickMaxOutputTokens({ max_tokens: 0 }), null)
eq('max_tokens 负数不被转', pickMaxOutputTokens({ max_tokens: -5 }), null)
eq('max_tokens 字符串不被转', pickMaxOutputTokens({ max_tokens: '128' }), null)
eq('无 max 字段返回 null', pickMaxOutputTokens({}), null)

{
  const { body } = chatToResponses({ model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'f' } }] })
  eq('tools 被展平进 body', body.tools[0].name, 'f')
  ok('tools 是扁平结构', !('function' in body.tools[0]), JSON.stringify(body.tools[0]))
}

{
  const { body } = chatToResponses({ model: 'm', messages: [], reasoning_effort: 'high', verbosity: 'low' })
  eq('reasoning_effort → reasoning.effort', body.reasoning, { effort: 'high' })
  eq('verbosity → text.verbosity', body.text.verbosity, 'low')
}

{
  const { body } = chatToResponses({
    model: 'm', messages: [],
    response_format: { type: 'json_schema', json_schema: { name: 'O', schema: { type: 'object' } } },
  })
  eq('response_format → text.format', body.text.format, {
    type: 'json_schema', name: 'O', schema: { type: 'object' },
  })
}

{
  const { body } = chatToResponses({ model: 'm', messages: [], temperature: 0.1 }, { passthroughSampling: true })
  eq('显式打开时 temperature 透传', body.temperature, 0.1)
}

{
  const { body } = chatToResponses({ model: 'm', messages: [], parallel_tool_calls: false, metadata: { k: 'v' } })
  eq('parallel_tool_calls 透传', body.parallel_tool_calls, false)
  eq('metadata 透传', body.metadata, { k: 'v' })
}

{
  const { dropped } = chatToResponses({ model: 'm', messages: [], n: 1 })
  ok('n=1 不记为丢弃', !dropped.includes('n'), dropped.join(','))
  const d2 = chatToResponses({ model: 'm', messages: [], n: 3 }).dropped
  ok('n=3 记为丢弃', d2.includes('n'), d2.join(','))
}

{
  // 采样参数支持矩阵的入向一侧：上游一律报
  // {"detail":"Unsupported parameter: <name>"}，全部不能出现在出站 body 里
  const full = chatToResponses({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.2,
    top_p: 0.8,
    top_k: 40,
    frequency_penalty: 0.1,
    presence_penalty: 0.1,
    stop: ['END'],
    stop_sequences: ['END'],
    seed: 7,
    logprobs: true,
    top_logprobs: 3,
    n: 2,
  })
  for (const f of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty',
    'stop', 'stop_sequences', 'seed', 'logprobs', 'top_logprobs', 'n']) {
    eq(`上游拒收的 ${f} 不出现在 body`, f in full.body, false)
    ok(`dropped 记录 ${f}`, full.dropped.includes(f), full.dropped.join(','))
  }
  // 接受的那些必须留着，丢掉就等于损失功能
  eq('max_output_tokens 保留',
    chatToResponses({ model: 'm', messages: [], max_tokens: 32 }).body.max_output_tokens, 32)
  eq('reasoning.effort 保留',
    chatToResponses({ model: 'm', messages: [], reasoning_effort: 'high' }).body.reasoning?.effort, 'high')
  eq('text.verbosity 保留',
    chatToResponses({ model: 'm', messages: [], verbosity: 'low' }).body.text?.verbosity, 'low')
}

{
  // SAMPLING_FIELDS 与 CHAT_DROPPED_FIELDS 必须自洽：
  // 前者是"受 passthroughSampling 控制的那一组"，后者是全集，必须包含前者
  ok('SAMPLING_FIELDS 是 CHAT_DROPPED_FIELDS 的子集',
    SAMPLING_FIELDS.every((f) => CHAT_DROPPED_FIELDS.includes(f)), SAMPLING_FIELDS.join(','))
  // 采样组之外的字段打开 passthroughSampling 也不该被发上游
  const { body } = chatToResponses(
    { model: 'm', messages: [], user: 'u', store: true, stream_options: { include_usage: true } },
    { passthroughSampling: true },
  )
  for (const f of ['user', 'store', 'stream_options']) {
    eq(`passthroughSampling 也不放开 ${f}`, f in body, false)
  }
}

// ═══════════════ 5. usage / finish_reason ═══════════════

console.log('\n5. usage 与 finish_reason 转换')

eq('usage 字段名映射', responsesUsageToChatUsage({
  input_tokens: 12, output_tokens: 5, total_tokens: 17,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens_details: { reasoning_tokens: 2 },
}), {
  prompt_tokens: 12,
  completion_tokens: 5,
  total_tokens: 17,
  prompt_tokens_details: { cached_tokens: 3 },
  completion_tokens_details: { reasoning_tokens: 2 },
})

eq('usage 缺 total 时自动相加',
  responsesUsageToChatUsage({ input_tokens: 4, output_tokens: 6 }).total_tokens, 10)
eq('usage 为 null 时全 0', responsesUsageToChatUsage(null), {
  prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  prompt_tokens_details: { cached_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
})

eq('正常结束 → stop', responsesFinishReason({ status: 'completed' }), 'stop')
eq('被截断 → length',
  responsesFinishReason({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'length')
eq('内容过滤 → content_filter',
  responsesFinishReason({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), 'content_filter')
eq('有工具调用优先 → tool_calls',
  responsesFinishReason({ status: 'completed' }, { hasToolCalls: true }), 'tool_calls')

// ═══════════════ 6. output 解析与完整 completion ═══════════════

console.log('\n6. response 对象聚合')

const sampleResponse = {
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  model: 'gpt-6-astra',
  output: [
    {
      type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: '收到' }],
    },
  ],
  usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
}

eq('抽取文本', extractFromResponseOutput(sampleResponse.output).text, '收到')
eq('抽取工具调用', extractFromResponseOutput([
  { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' },
]).toolCalls, [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }])

const completion = responsesToChatCompletion(sampleResponse, { created: 1700000000 })
eq('completion object 类型', completion.object, 'chat.completion')
eq('completion id 合法', isChatCompletionId(completion.id), true)
eq('completion model', completion.model, 'gpt-6-astra')
eq('completion created 可控', completion.created, 1700000000)
eq('completion 内容', completion.choices[0].message.content, '收到')
eq('completion finish_reason', completion.choices[0].finish_reason, 'stop')
eq('completion usage', completion.usage.prompt_tokens, 12)

const toolCompletion = responsesToChatCompletion({
  status: 'completed', model: 'm',
  output: [{ type: 'function_call', call_id: 'c1', name: 'f', arguments: '{}' }],
  usage: null,
})
eq('工具调用时 finish_reason', toolCompletion.choices[0].finish_reason, 'tool_calls')
eq('工具调用时 content 为 null', toolCompletion.choices[0].message.content, null)

// ═══════════════ 7. SSE 出向映射 ═══════════════

console.log('\n7. Responses SSE → Chat SSE')

{
  const frames = []
  for await (const f of responsesEventsToChatSse(asEvents([
    ev('response.created', { type: 'response.created', response: { id: 'resp_1', model: 'gpt-6-astra' } }),
    ev('response.output_text.delta', { type: 'response.output_text.delta', delta: '收' }),
    ev('response.output_text.delta', { type: 'response.output_text.delta', delta: '到' }),
    ev('response.completed', {
      type: 'response.completed',
      response: {
        status: 'completed', model: 'gpt-6-astra',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '收到' }] }],
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      },
    }),
  ]), { model: 'gpt-6-astra', created: 1700000000 })) {
    frames.push(...parseFrames(f))
  }

  eq('首帧是 role 帧', frames[0].choices[0].delta, { role: 'assistant', content: '' })
  eq('第二帧是首个 delta', frames[1].choices[0].delta, { content: '收' })
  eq('第三帧是第二个 delta', frames[2].choices[0].delta, { content: '到' })
  eq('末帧前是 finish 帧', frames[3].choices[0].finish_reason, 'stop')
  eq('usage 挂在 finish 帧上', frames[3].usage.prompt_tokens, 12)
  eq('最后一帧是 [DONE]', frames[frames.length - 1], 'DONE')
  eq('所有 chunk 的 object 类型', frames[0].object, 'chat.completion.chunk')
  eq('chunk id 一致', frames[1].id, frames[0].id)
  eq('chunk id 合法', isChatCompletionId(frames[0].id), true)
  ok('没有 event: 行（只发 data）',
    frames.every((f) => typeof f === 'string' || !('raw' in f)),
    JSON.stringify(frames.find((f) => typeof f === 'object' && 'raw' in f)))
}

{
  // 工具调用：output_item.added + arguments 增量
  const frames = []
  for await (const f of responsesEventsToChatSse(asEvents([
    ev('response.created', { response: { model: 'm' } }),
    ev('response.output_item.added', {
      output_index: 0, item: { type: 'function_call', call_id: 'call_x', name: 'get_weather' },
    }),
    ev('response.function_call_arguments.delta', { output_index: 0, delta: '{"city"' }),
    ev('response.function_call_arguments.delta', { output_index: 0, delta: ':"SF"}' }),
    ev('response.completed', {
      response: {
        status: 'completed', model: 'm',
        output: [{ type: 'function_call', call_id: 'call_x', name: 'get_weather', arguments: '{"city":"SF"}' }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    }),
  ]), { created: 1 })) frames.push(...parseFrames(f))

  const firstTool = frames.find((f) => f.choices?.[0]?.delta?.tool_calls)
  eq('工具首帧带 id', firstTool.choices[0].delta.tool_calls[0].id, 'call_x')
  eq('工具首帧带 name', firstTool.choices[0].delta.tool_calls[0].function.name, 'get_weather')
  eq('工具首帧 arguments 为空串', firstTool.choices[0].delta.tool_calls[0].function.arguments, '')
  const argDeltas = frames
    .filter((f) => f.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments)
    .map((f) => f.choices[0].delta.tool_calls[0].function.arguments)
  eq('arguments 增量拼接', argDeltas.join(''), '{"city":"SF"}')
  const finish = frames.find((f) => f.choices?.[0]?.finish_reason)
  eq('工具调用 finish_reason', finish.choices[0].finish_reason, 'tool_calls')
  eq('工具调用后是 [DONE]', frames[frames.length - 1], 'DONE')
}

{
  // 事件流意外结束（无 completed）：必须补 stop + [DONE]，不能挂死
  const frames = []
  for await (const f of responsesEventsToChatSse(asEvents([
    ev('response.output_text.delta', { delta: 'x' }),
  ]), { created: 1 })) frames.push(...parseFrames(f))
  eq('无 completed 也发 finish', frames[frames.length - 2].choices[0].finish_reason, 'stop')
  eq('无 completed 也发 [DONE]', frames[frames.length - 1], 'DONE')
}

{
  // 上游报错：finish + error 帧
  const frames = []
  for await (const f of responsesEventsToChatSse(asEvents([
    ev('response.failed', { response: { error: { code: 'boom', message: 'upstream boom' } } }),
  ]), { created: 1 })) frames.push(...parseFrames(f))
  ok('failed 帧带 error', Boolean(frames.some((f) => f.error)), JSON.stringify(frames))
  eq('failed 仍以 [DONE] 收尾', frames[frames.length - 1], 'DONE')
}

{
  // includeUsage=false：finish 帧不应带 usage
  const frames = []
  for await (const f of responsesEventsToChatSse(asEvents([
    ev('response.completed', { response: { status: 'completed', output: [], usage: { input_tokens: 1 } } }),
  ]), { includeUsage: false })) frames.push(...parseFrames(f))
  const finish = frames.find((f) => f.choices?.[0]?.finish_reason)
  eq('includeUsage=false 时不带 usage', 'usage' in finish, false)
}

// ═══════════════ 8. 非流式聚合 ═══════════════

console.log('\n8. collectResponsesStream 非流式聚合')

{
  const response = await collectResponsesStream(asEvents([
    ev('response.created', { response: { id: 'resp_9', model: 'gpt-6-astra' } }),
    ev('response.output_text.delta', { delta: 'a' }),
    ev('response.output_text.delta', { delta: 'b' }),
    ev('response.completed', {
      response: {
        id: 'resp_9', status: 'completed', model: 'gpt-6-astra',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ab' }] }],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    }),
  ]))
  eq('聚合取 completed 的 response', response.id, 'resp_9')
  eq('聚合内容', extractFromResponseOutput(response.output).text, 'ab')
}

{
  // 没有 completed：用累积 delta 兜底
  const response = await collectResponsesStream(asEvents([
    ev('response.created', { response: { id: 'r2', model: 'm' } }),
    ev('response.output_text.delta', { delta: 'x' }),
    ev('response.output_text.delta', { delta: 'y' }),
  ]))
  eq('兜底 status 是 incomplete', response.status, 'incomplete')
  eq('兜底内容来自 delta', extractFromResponseOutput(response.output).text, 'xy')
  eq('兜底 incomplete 原因', response.incomplete_details.reason, 'stream_ended_without_completed')
}

{
  // 兜底路径下的工具参数累积
  const response = await collectResponsesStream(asEvents([
    ev('response.output_item.added', { output_index: 0, item: { type: 'function_call', call_id: 'c', name: 'f' } }),
    ev('response.function_call_arguments.delta', { output_index: 0, delta: '{"a"' }),
    ev('response.function_call_arguments.delta', { output_index: 0, delta: ':1}' }),
  ]))
  const { toolCalls } = extractFromResponseOutput(response.output)
  eq('兜底工具参数拼接', toolCalls[0].function.arguments, '{"a":1}')
}

// ═══════════════ 9. 帧格式 ═══════════════

console.log('\n9. 帧格式')

eq('chatSseFrame 以 data: 开头', chatSseFrame({ a: 1 }), 'data: {"a":1}\n\n')
eq('[DONE] 帧格式', CHAT_DONE_FRAME, 'data: [DONE]\n\n')
{
  const chunk = chatChunk({ id: 'chatcmpl-x', model: 'm', created: 1, delta: { content: 'a' } })
  eq('chunk 结构', chunk, {
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null, logprobs: null }],
  })
  const withUsage = chatChunk({ id: 'i', model: 'm', created: 1, delta: {}, usage: { prompt_tokens: 1 } })
  eq('带 usage 时附加字段', withUsage.usage, { prompt_tokens: 1 })
}


// ── 回归：流内失败必须当失败，不能当"没完成" ──
//
// 上游过载时 HTTP 状态码仍是 200，失败信息在流里：
//   event: error            {"error":{"code":"server_is_overloaded"}}
//   event: response.failed  {"response":{"status":"failed","error":{...}}}
// 原先两者都不认，循环结束后走兜底分支拼出 status:'incomplete' 的假成功。
// 实测 20 槽位并发时 4/20 落进这个状态：调用方拿到 200 + 空 output。
{
  const failedStream = async function* () {
    yield { event: 'response.created', data: { type: 'response.created', response: { id: 'r1', model: 'gpt-6-astra' } } }
    yield { event: 'response.in_progress', data: { type: 'response.in_progress' } }
    yield { event: 'error', data: { type: 'error', error: { message: 'Our servers are currently overloaded.', code: 'server_is_overloaded' } } }
    yield { event: 'response.failed', data: { type: 'response.failed', response: { id: 'r1', status: 'failed', error: { code: 'server_is_overloaded', message: 'overloaded' } } } }
  }
  let caught = null
  try {
    await collectResponsesStream(failedStream())
  } catch (error) {
    caught = error
  }
  ok('response.failed 会抛出而不是返回 incomplete', caught !== null)
  eq('抛出的错误码取自上游', caught?.code, 'server_is_overloaded')
  ok('错误信息带 overloaded', /overloaded/i.test(String(caught?.message || '')), caught?.message)
  ok('错误带 upstream 元信息', Boolean(caught?.upstream), JSON.stringify(caught?.upstream))

  // 只有 error 事件、没有 response.failed 也要能抓到
  const onlyErrorStream = async function* () {
    yield { event: 'error', data: { type: 'error', error: { code: 'boom', message: 'x' } } }
  }
  let caught2 = null
  try { await collectResponsesStream(onlyErrorStream()) } catch (e) { caught2 = e }
  ok('只有 error 事件也抛出', caught2 !== null)
  eq('错误码是 boom', caught2?.code, 'boom')

  // 正常流不受影响
  const goodStream = async function* () {
    yield { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '通' } }
    yield { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r2', status: 'completed', model: 'gpt-6-astra', output: [] } } }
  }
  const good = await collectResponsesStream(goodStream())
  eq('正常流仍返回 completed', good?.status, 'completed')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
