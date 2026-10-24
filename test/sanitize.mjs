/**
 * 出站请求体清洗的单元测试。
 *
 * 为什么这层必须有测试：它的失败**不会报错**，只会让内部字段
 * 悄悄发到上游。那是最直接的封号面，而且事后无法追溯。
 *
 * 对齐依据：官方 vm2api v1.3.220 `src/lib/protocol/sanitize.mjs`。
 */
import {
  DROP_TOP, DROP_CONTENT_KEYS, sanitizeAnthropicBody, droppedKeysOf,
  openaiResponseFormatToOutputConfig, applyStructuredOutput,
  stripIllegalContentFields, stripIllegalMessageContent,
} from '../src/sanitize.mjs'
import { stripInternalFields } from '../src/anthropic.mjs'

let pass = 0
const fails = []
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass += 1; return }
  fails.push(label)
  console.log(`  FAIL  ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`)
}

// ── 1. 内部标记绝不能出站（最关键）
console.log('\n1. 内部标记必须被丢弃')
{
  const INTERNAL = ['machine_id', 'device_id', 'account_uuid', 'session', 'betas', '__betas__']
  for (const k of INTERNAL) {
    const out = sanitizeAnthropicBody({ model: 'm', max_tokens: 1, [k]: 'secret' })
    eq(`${k} 被丢弃`, k in out, false)
  }
  // 一起出现也要全丢
  const body = { model: 'm', max_tokens: 1 }
  for (const k of INTERNAL) body[k] = 'x'
  const out = sanitizeAnthropicBody(body)
  eq('多个内部标记同时丢弃', INTERNAL.filter((k) => k in out), [])
  eq('droppedKeysOf 能列全', droppedKeysOf(body).sort(), [...INTERNAL].sort())
}

// ── 2. OpenAI 残留必须被丢弃
console.log('\n2. OpenAI 残留必须被丢弃')
{
  const OPENAI = ['store', 'reasoning', 'input', 'truncation', 'include',
    'previous_response_id', 'parallel_tool_calls', 'max_output_tokens',
    'stream_options', 'modalities', 'audio', 'prediction', 'seed', 'n']
  for (const k of OPENAI) {
    const out = sanitizeAnthropicBody({ model: 'm', max_tokens: 1, [k]: 'x' })
    eq(`OpenAI 残留 ${k} 被丢弃`, k in out, false)
  }
}

// ── 3. 官方字段必须保留
console.log('\n3. 官方字段必须保留')
{
  const KEEP = ['model', 'max_tokens', 'messages', 'system', 'tools',
    'tool_choice', 'temperature', 'top_p', 'top_k', 'stop_sequences',
    'thinking', 'output_config', 'metadata', 'service_tier']
  for (const k of KEEP) {
    const out = sanitizeAnthropicBody({ model: 'm', max_tokens: 1, [k]: k === 'messages' ? [] : 'x' })
    eq(`官方字段 ${k} 保留`, k in out, true)
  }
}

// ── 4. response_format 必须先救成 output_config
console.log('\n4. structured output 先救再删')
{
  const body = {
    model: 'm', max_tokens: 1,
    response_format: { type: 'json_schema', json_schema: { name: 'r', schema: { type: 'object' } } },
  }
  const out = sanitizeAnthropicBody(body)
  eq('response_format 被删', 'response_format' in out, false)
  eq('output_config 被救出', !!out.output_config, true)
  eq('schema 内容是 object', out.output_config?.format?.schema?.type, 'object')
  eq('name 被带上', out.output_config?.format?.name, 'r')

  // json_object 形态
  const o2 = sanitizeAnthropicBody({ model: 'm', max_tokens: 1, response_format: { type: 'json_object' } })
  eq('json_object 转成空 object schema', o2.output_config?.format?.schema?.type, 'object')

  // 已有 output_config 时不覆盖
  const o3 = sanitizeAnthropicBody({
    model: 'm', max_tokens: 1,
    output_config: { format: { type: 'json_schema', schema: { type: 'string' } } },
  })
  eq('已有 output_config 保留', o3.output_config.format.schema.type, 'string')
}

// ── 5. content 里的 annotations 必须删
console.log('\n5. content 非法字段清理')
{
  const out = sanitizeAnthropicBody({
    model: 'm', max_tokens: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', annotations: [{ x: 1 }] }] }],
  })
  eq('annotations 被删', 'annotations' in out.messages[0].content[0], false)
  eq('text 保留', out.messages[0].content[0].text, 'hi')

  // 字符串 content 不动
  const s = sanitizeAnthropicBody({
    model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'plain' }],
  })
  eq('字符串 content 原样', s.messages[0].content, 'plain')
}

// ── 6. 不改原对象
console.log('\n6. 不改原对象')
{
  const body = { model: 'm', max_tokens: 1, machine_id: 'x', messages: [] }
  const snapshot = JSON.stringify(body)
  sanitizeAnthropicBody(body)
  eq('入参未被修改', JSON.stringify(body), snapshot)
  eq('machine_id 仍在入参里', body.machine_id, 'x')
}

// ── 7. stripInternalFields 委托给 sanitize
console.log('\n7. stripInternalFields 已委托')
{
  const out = stripInternalFields({ model: 'm', max_tokens: 1, device_id: 'd', store: false })
  eq('经 stripInternalFields 也删 device_id', 'device_id' in out, false)
  eq('经 stripInternalFields 也删 store', 'store' in out, false)
  eq('model 保留', out.model, 'm')
}

// ── 8. 边界
console.log('\n8. 边界输入')
{
  eq('null 返回空对象', sanitizeAnthropicBody(null), {})
  eq('非对象返回空对象', sanitizeAnthropicBody('x'), {})
  eq('空对象返回空对象', sanitizeAnthropicBody({}), {})
  eq('undefined 值被跳过', 'a' in sanitizeAnthropicBody({ a: undefined, b: 1 }), false)
}

// ── 9. 黑名单本身健全
console.log('\n9. 黑名单健全性')
{
  eq('DROP_TOP 至少 50 项', DROP_TOP.size >= 50, true)
  // 关键封号键必须在里面
  for (const k of ['machine_id', 'device_id', 'account_uuid', 'session']) {
    eq(`DROP_TOP 含 ${k}`, DROP_TOP.has(k), true)
  }
  // 官方 schema 字段不能在黑名单里（否则误删）
  for (const k of ['model', 'max_tokens', 'messages', 'system', 'tools', 'thinking']) {
    eq(`DROP_TOP 不含 ${k}`, DROP_TOP.has(k), false)
  }
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) process.exit(1)
