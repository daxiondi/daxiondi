/**
 * 出站补齐层（thinking-policy）的单元测试。
 *
 * 这一层的失败方式和清洗层相反：清洗层漏删是「多发字段」，补齐全漏是
 * 「少发字段」——后者不报错、不告警，只表现为同一条对话经过网关后
 * 思考深度被静默降级。因此每一条补齐项都要有独立断言，且必须有
 * 「调用方显式给值时不覆盖」的反向断言：补齐 ≠ 覆盖。
 *
 * 对齐依据：官方 vm2api v1.3.220 protocol/thinking.mjs、
 * protocol/anthropic-policy.mjs、protocol/model-policy.mjs。
 *
 * 运行：node test/thinking-policy.mjs
 */

import {
  DEFAULT_EFFORT,
  FALLBACK_THINKING_BUDGET,
  MIN_THINKING_BUDGET,
  MODEL_CAPABILITIES,
  OFFICIAL_THINKING_DISPLAY,
  applyDefaultMaxTokens,
  applyDegradationGuards,
  capabilitiesFor,
  capabilityModelId,
  clampThinkingBudget,
  defaultMaxTokensForModel,
  enforceThinkingTemperature,
  ensureAdaptiveThinking,
  ensureEffort,
  maxOutputTokensForModel,
  modelSupportsAdaptiveThinking,
  modelSupportsEffort,
  stripUnsupportedEffort,
} from '../src/thinking-policy.mjs'
import { AnthropicUpstream, MODE, headersToObject } from '../src/anthropic.mjs'
import { DROP_TOP, sanitizeAnthropicBody } from '../src/sanitize.mjs'

// ─────────────── 断言器 ───────────────

let pass = 0
const fails = []

function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1
    return
  }
  fails.push(label)
  console.log(`  FAIL  ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`)
}

function ok(label, value, detail) {
  if (value) {
    pass += 1
    return
  }
  fails.push(label)
  console.log(`  FAIL  ${label}${detail == null ? '' : `\n         ${detail}`}`)
}

/** 深拷贝，用来断言「入参未被修改」。 */
const clone = (v) => JSON.parse(JSON.stringify(v))

// ─────────────── 1. 能力矩阵 ───────────────

console.log('\n1. 能力矩阵')
{
  // 本仓库 prompt-profiles.mjs 的档位表里出现的模型，加上官方 seed 里同代的
  // sonnet-4-6。矩阵不覆盖这些 id 就等于把它们当未知模型处理（不补）。
  const OUR_MODELS = [
    'claude-sonnet-4-5', 'claude-sonnet-5', 'claude-sonnet-5-5',
    'claude-haiku-4-5', 'claude-haiku-5', 'claude-haiku-5-5',
    'claude-3-5-sonnet', 'claude-3-7-sonnet',
    'claude-opus-4-0', 'claude-opus-4-1', 'claude-opus-4-5', 'claude-opus-4-6',
    'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
    'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1',
  ]
  for (const model of OUR_MODELS) {
    ok(`${model} 在矩阵里`, capabilitiesFor(model) != null)
  }

  // 每个条目的字段必须齐、类型必须对，缺字段会让补齐逻辑静默失效
  for (const [id, caps] of Object.entries(MODEL_CAPABILITIES)) {
    eq(`${id} 字段集合`, Object.keys(caps).sort(), [
      'default_effort', 'default_max_tokens', 'max_output_tokens',
      'supports_adaptive_thinking', 'supports_effort', 'thinking_fallback_budget',
    ])
    ok(`${id} adaptive 是布尔`, typeof caps.supports_adaptive_thinking === 'boolean')
    ok(`${id} effort 是布尔`, typeof caps.supports_effort === 'boolean')
    ok(`${id} 缺省输出上限是正数`, caps.max_output_tokens > 0)
    ok(`${id} 缺省 max_tokens 不超过上限`, caps.default_max_tokens <= caps.max_output_tokens)
  }

  // 官方矩阵里的关键取值（这几个值直接决定补什么）
  eq('opus-5-5 支持 adaptive', modelSupportsAdaptiveThinking('claude-opus-5-5'), true)
  eq('opus-5-5 支持 effort', modelSupportsEffort('claude-opus-5-5'), true)
  eq('opus-5-5 缺省 effort 是 medium', capabilitiesFor('claude-opus-5-5').default_effort, 'medium')
  eq('opus-5 缺省 effort 走 high（无声明）', capabilitiesFor('claude-opus-5').default_effort, null)
  eq('opus-5 输出上限', maxOutputTokensForModel('claude-opus-5'), 128000)
  eq('sonnet-4-5 不支持 adaptive', modelSupportsAdaptiveThinking('claude-sonnet-4-5'), false)
  eq('sonnet-4-5 不支持 effort', modelSupportsEffort('claude-sonnet-4-5'), false)
  eq('haiku-4-5 不支持 adaptive', modelSupportsAdaptiveThinking('claude-haiku-4-5'), false)
  eq('haiku-5-5 支持 adaptive', modelSupportsAdaptiveThinking('claude-haiku-5-5'), true)
  eq('opus-4-1 不支持 adaptive（早于该能力）', modelSupportsAdaptiveThinking('claude-opus-4-1'), false)
  eq('opus-4-1 不支持 effort', modelSupportsEffort('claude-opus-4-1'), false)
  eq('opus-4-1 输出上限是真实值 32000', maxOutputTokensForModel('claude-opus-4-1'), 32000)
  eq('3.5 sonnet 输出上限 8192', maxOutputTokensForModel('claude-3-5-sonnet'), 8192)

  // 未知模型：全部判定为不支持
  for (const model of ['m', '', 'gpt-5', 'claude-unknown-9', null, undefined]) {
    eq(`未知模型 ${String(model)} 无能力条目`, capabilitiesFor(model), null)
    eq(`未知模型 ${String(model)} 不支持 adaptive`, modelSupportsAdaptiveThinking(model), false)
    eq(`未知模型 ${String(model)} 不支持 effort`, modelSupportsEffort(model), false)
    eq(`未知模型 ${String(model)} 无输出上限`, maxOutputTokensForModel(model), null)
    eq(`未知模型 ${String(model)} 无 max_tokens 缺省`, defaultMaxTokensForModel(model), null)
  }
}

// ─────────────── 2. 模型 id 归一 ───────────────

console.log('\n2. 模型 id 归一')
{
  eq('点号版本归一', capabilityModelId('claude-opus-5.5'), 'claude-opus-5-5')
  eq('点号 4.7 归一', capabilityModelId('claude-opus-4.7'), 'claude-opus-4-7')
  eq('日期后缀剔除', capabilityModelId('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5')
  eq('[1m] 后缀剔除', capabilityModelId('claude-opus-5-5[1m]'), 'claude-opus-5-5')
  eq('provider 前缀剔除', capabilityModelId('anthropic/claude-opus-5-5'), 'claude-opus-5-5')
  eq('大写归一', capabilityModelId('Claude-Opus-5-5'), 'claude-opus-5-5')
  eq('裸 opus-4 视作 4.0', capabilityModelId('claude-opus-4'), 'claude-opus-4-0')
  eq('空串', capabilityModelId(''), '')
  eq('非字符串', capabilityModelId(null), '')

  // 归一后必须命中矩阵，否则真实请求里的这些写法会被当成未知模型
  ok('日期后缀形态命中矩阵', capabilitiesFor('claude-haiku-4-5-20251001') != null)
  ok('点号形态命中矩阵', capabilitiesFor('claude-opus-5.5') != null)
  ok('1m 形态命中矩阵', capabilitiesFor('claude-sonnet-5-5[1m]') != null)
}

// ─────────────── 3. max_tokens 缺省与上限 ───────────────

console.log('\n3. max_tokens 缺省与上限')
{
  // 缺失 → 补模型缺省
  eq('opus-5-5 缺 max_tokens 补 128000',
    applyDefaultMaxTokens({ model: 'claude-opus-5-5' }).max_tokens, 128000)
  eq('opus-5 缺 max_tokens 补 32000',
    applyDefaultMaxTokens({ model: 'claude-opus-5' }).max_tokens, 32000)
  eq('sonnet-4-5 缺 max_tokens 补 16384',
    applyDefaultMaxTokens({ model: 'claude-sonnet-4-5' }).max_tokens, 16384)
  eq('haiku-4-5 缺 max_tokens 补 8192',
    applyDefaultMaxTokens({ model: 'claude-haiku-4-5' }).max_tokens, 8192)

  // 已有合法值 → 绝不覆盖（补齐 ≠ 覆盖）
  eq('调用方的 200 保留', applyDefaultMaxTokens({ model: 'claude-opus-5-5', max_tokens: 200 }).max_tokens, 200)
  eq('调用方的 1000 保留', applyDefaultMaxTokens({ model: 'claude-sonnet-4-5', max_tokens: 1000 }).max_tokens, 1000)

  // 超过上限 → 夹到上限
  eq('opus-5 超上限被夹', applyDefaultMaxTokens({ model: 'claude-opus-5', max_tokens: 200000 }).max_tokens, 128000)
  eq('sonnet-4-5 超上限被夹', applyDefaultMaxTokens({ model: 'claude-sonnet-4-5', max_tokens: 100000 }).max_tokens, 64000)
  eq('opus-4-1 超上限被夹到 32000', applyDefaultMaxTokens({ model: 'claude-opus-4-1', max_tokens: 64000 }).max_tokens, 32000)
  eq('正好等于上限不动', applyDefaultMaxTokens({ model: 'claude-opus-5', max_tokens: 128000 }).max_tokens, 128000)

  // 非法值按缺失处理
  eq('max_tokens=0 视为缺失', applyDefaultMaxTokens({ model: 'claude-opus-5', max_tokens: 0 }).max_tokens, 32000)
  eq('max_tokens 负数视为缺失', applyDefaultMaxTokens({ model: 'claude-opus-5', max_tokens: -5 }).max_tokens, 32000)
  eq('max_tokens 非数字视为缺失', applyDefaultMaxTokens({ model: 'claude-opus-5', max_tokens: 'x' }).max_tokens, 32000)

  // 未知模型不猜
  eq('未知模型不补 max_tokens', 'max_tokens' in applyDefaultMaxTokens({ model: 'm' }), false)
  eq('未知模型不夹 max_tokens', applyDefaultMaxTokens({ model: 'm', max_tokens: 999999 }).max_tokens, 999999)

  // 不改入参
  const body = { model: 'claude-opus-5', max_tokens: 200000 }
  const snapshot = clone(body)
  applyDefaultMaxTokens(body)
  eq('applyDefaultMaxTokens 不改入参', JSON.stringify(body), JSON.stringify(snapshot))

  // 边界
  eq('null 原样返回', applyDefaultMaxTokens(null), null)
  eq('空对象原样返回', applyDefaultMaxTokens({}), {})
}

// ─────────────── 4. thinking budget 下限 ───────────────

console.log('\n4. thinking budget 下限')
{
  const enabled = (budget) => ({ model: 'claude-opus-5-5', thinking: { type: 'enabled', budget_tokens: budget } })

  eq('budget 500 抬到 1024', clampThinkingBudget(enabled(500)).thinking.budget_tokens, MIN_THINKING_BUDGET)
  eq('budget 1023 抬到 1024', clampThinkingBudget(enabled(1023)).thinking.budget_tokens, MIN_THINKING_BUDGET)
  eq('budget 1024 不动', clampThinkingBudget(enabled(1024)).thinking.budget_tokens, 1024)
  eq('budget 2000 不动', clampThinkingBudget(enabled(2000)).thinking.budget_tokens, 2000)
  eq('budget 0 补兜底值', clampThinkingBudget(enabled(0)).thinking.budget_tokens, FALLBACK_THINKING_BUDGET)
  eq('budget 负数补兜底值', clampThinkingBudget(enabled(-1)).thinking.budget_tokens, FALLBACK_THINKING_BUDGET)
  eq('budget 非数字补兜底值', clampThinkingBudget(enabled('x')).thinking.budget_tokens, FALLBACK_THINKING_BUDGET)
  eq('budget 缺失补兜底值',
    clampThinkingBudget({ model: 'claude-opus-5-5', thinking: { type: 'enabled' } }).thinking.budget_tokens,
    FALLBACK_THINKING_BUDGET)
  eq('数字字符串归一成数字', clampThinkingBudget(enabled('2000')).thinking.budget_tokens, 2000)

  // 只对 enabled 生效：adaptive 没有 budget 概念，disabled 不该补出 budget
  eq('adaptive 不动',
    clampThinkingBudget({ model: 'claude-opus-5-5', thinking: { type: 'adaptive', budget_tokens: 500 } }).thinking,
    { type: 'adaptive', budget_tokens: 500 })
  eq('disabled 不动',
    clampThinkingBudget({ model: 'claude-opus-5-5', thinking: { type: 'disabled' } }).thinking,
    { type: 'disabled' })
  eq('无 thinking 不补',
    'thinking' in clampThinkingBudget({ model: 'claude-opus-5-5' }), false)

  // 未知模型也夹：这是上游的硬约束，与模型能力无关
  eq('未知模型的 budget 也夹',
    clampThinkingBudget({ model: 'm', thinking: { type: 'enabled', budget_tokens: 10 } }).thinking.budget_tokens,
    MIN_THINKING_BUDGET)

  // 保留 thinking 上的其它字段（例如 display / block_binding）
  eq('clamp 保留 display',
    clampThinkingBudget({ model: 'claude-opus-5-5', thinking: { type: 'enabled', budget_tokens: 10, display: 'summarized' } }).thinking.display,
    'summarized')

  const body = enabled(10)
  const snapshot = clone(body)
  clampThinkingBudget(body)
  eq('clampThinkingBudget 不改入参', JSON.stringify(body), JSON.stringify(snapshot))
}

// ─────────────── 5. 补 adaptive thinking ───────────────

console.log('\n5. 补 adaptive thinking')
{
  // 支持 adaptive 的模型：缺失就补
  for (const model of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5-5',
    'claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-4-6']) {
    eq(`${model} 缺 thinking 补 adaptive+omitted`,
      ensureAdaptiveThinking({ model }).thinking,
      { type: 'adaptive', display: OFFICIAL_THINKING_DISPLAY })
  }

  // 不支持的模型：绝不补（打到 Haiku 4.5 / Sonnet 4.5 会 400）
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5',
    'claude-opus-4-1', 'claude-3-5-sonnet', 'claude-3-7-sonnet', 'm']) {
    eq(`${model} 不补 thinking`, 'thinking' in ensureAdaptiveThinking({ model }), false)
  }

  // 已有 thinking 但缺 display → 只补 display，其它字段不动
  eq('enabled 缺 display 只补 display',
    ensureAdaptiveThinking({ model: 'claude-opus-5-5', thinking: { type: 'enabled', budget_tokens: 2048 } }).thinking,
    { type: 'enabled', budget_tokens: 2048, display: OFFICIAL_THINKING_DISPLAY })
  eq('adaptive 缺 display 只补 display',
    ensureAdaptiveThinking({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' } }).thinking,
    { type: 'adaptive', display: OFFICIAL_THINKING_DISPLAY })
  eq('空字符串 display 视为缺失',
    ensureAdaptiveThinking({ model: 'claude-opus-5-5', thinking: { type: 'adaptive', display: '  ' } }).thinking.display,
    OFFICIAL_THINKING_DISPLAY)
  eq('补 display 保留 block_binding',
    ensureAdaptiveThinking({ model: 'claude-opus-5-5', thinking: { type: 'adaptive', block_binding: { x: 1 } } }).thinking.block_binding,
    { x: 1 })

  // 绝不覆盖调用方的 display —— 这是本层最重要的一条约束
  eq('display=summarized 不覆盖',
    ensureAdaptiveThinking({ model: 'claude-opus-5-5', thinking: { type: 'adaptive', display: 'summarized' } }).thinking,
    { type: 'adaptive', display: 'summarized' })
  eq('display=updates 不覆盖',
    ensureAdaptiveThinking({ model: 'claude-opus-5-5', thinking: { type: 'enabled', display: 'updates' } }).thinking,
    { type: 'enabled', display: 'updates' })
  eq('display=自定义值不覆盖',
    ensureAdaptiveThinking({ model: 'claude-opus-5-5', thinking: { type: 'adaptive', display: 'verbose' } }).thinking.display,
    'verbose')

  // disabled 不补 display（官方 thinkingNeedsOfficialDisplay 只认 enabled / adaptive）
  eq('disabled 不补 display',
    ensureAdaptiveThinking({ model: 'claude-opus-5-5', thinking: { type: 'disabled' } }).thinking,
    { type: 'disabled' })

  // 已有 display 时返回同一引用（不需要改动）
  const untouched = { model: 'claude-opus-5-5', thinking: { type: 'adaptive', display: 'summarized' } }
  eq('已完整时返回同一引用', ensureAdaptiveThinking(untouched) === untouched, true)

  // 非对象 thinking 不炸
  eq('字符串 thinking 不处理',
    ensureAdaptiveThinking({ model: 'claude-opus-5-5', thinking: 'adaptive' }).thinking, 'adaptive')

  const body = { model: 'claude-opus-5-5' }
  ensureAdaptiveThinking(body)
  eq('ensureAdaptiveThinking 不改入参', 'thinking' in body, false)
}

// ─────────────── 6. 补 effort ───────────────

console.log('\n6. 补 output_config.effort')
{
  // 支持 effort：缺失补模型缺省（无声明时 high）
  eq('opus-5 缺 effort 补 high',
    ensureEffort({ model: 'claude-opus-5' }).output_config, { effort: DEFAULT_EFFORT })
  eq('sonnet-5 缺 effort 补 high',
    ensureEffort({ model: 'claude-sonnet-5' }).output_config.effort, 'high')
  eq('opus-4-6 缺 effort 补 high',
    ensureEffort({ model: 'claude-opus-4-6' }).output_config.effort, 'high')
  // 模型自己有缺省值：medium
  eq('opus-5-5 缺 effort 补 medium',
    ensureEffort({ model: 'claude-opus-5-5' }).output_config.effort, 'medium')
  eq('sonnet-5-5 缺 effort 补 medium',
    ensureEffort({ model: 'claude-sonnet-5-5' }).output_config.effort, 'medium')
  eq('haiku-5-5 缺 effort 补 medium',
    ensureEffort({ model: 'claude-haiku-5-5' }).output_config.effort, 'medium')

  // 已有 effort → 绝不覆盖
  for (const effort of ['low', 'medium', 'xhigh', 'max', 'HIGH']) {
    eq(`调用方的 effort=${effort} 保留`,
      ensureEffort({ model: 'claude-opus-5-5', output_config: { effort } }).output_config.effort, effort)
  }
  eq('空串 effort 视为缺失',
    ensureEffort({ model: 'claude-opus-5-5', output_config: { effort: '' } }).output_config.effort, 'medium')
  eq('已有 effort 时返回同一引用',
    (() => {
      const body = { model: 'claude-opus-5-5', output_config: { effort: 'xhigh' } }
      return ensureEffort(body) === body
    })(), true)

  // output_config 的其它成员必须保留（format 是结构化输出，删了会掉格式）
  eq('补 effort 保留 format',
    ensureEffort({ model: 'claude-opus-5-5', output_config: { format: { type: 'json_schema' } } }).output_config,
    { format: { type: 'json_schema' }, effort: 'medium' })

  // 不支持的模型：删掉 effort（上游 400），空掉的 output_config 一并删
  eq('sonnet-4-5 删掉 effort',
    'output_config' in ensureEffort({ model: 'claude-sonnet-4-5', output_config: { effort: 'high' } }), false)
  eq('haiku-4-5 删掉 effort',
    'output_config' in ensureEffort({ model: 'claude-haiku-4-5', output_config: { effort: 'high' } }), false)
  eq('opus-4-5 删掉 effort',
    'output_config' in ensureEffort({ model: 'claude-opus-4-5', output_config: { effort: 'high' } }), false)
  eq('不支持模型删 effort 保留 format',
    ensureEffort({ model: 'claude-sonnet-4-5', output_config: { effort: 'high', format: { type: 'json_schema' } } }).output_config,
    { format: { type: 'json_schema' } })
  eq('不支持模型不补 effort',
    'output_config' in ensureEffort({ model: 'claude-sonnet-4-5' }), false)

  // 消息级 effort 同样要删（中途 effort 是 5.5 系的能力，旧模型不接受）
  const withMessageEffort = {
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'user', content: 'a' },
      { role: 'system', content: '', output_config: { effort: 'high' } },
      { role: 'user', content: 'b', output_config: { effort: 'low', format: { type: 'json_schema' } } },
    ],
  }
  const stripped = stripUnsupportedEffort(withMessageEffort)
  eq('消息级 effort 被删（空配置删键）', 'output_config' in stripped.messages[1], false)
  eq('消息级 effort 被删（保留 format）', stripped.messages[2].output_config, { format: { type: 'json_schema' } })
  eq('消息条数不变', stripped.messages.length, 3)
  eq('消息内容不变', stripped.messages[2].content, 'b')

  // 不认识的模型：不补也不删（我们不知道它支不支持）
  eq('未知模型不补 effort',
    'output_config' in ensureEffort({ model: 'm' }), false)
  eq('未知模型不删 effort',
    ensureEffort({ model: 'm', output_config: { effort: 'high' } }).output_config.effort, 'high')

  const body = { model: 'claude-opus-5-5' }
  ensureEffort(body)
  eq('ensureEffort 不改入参', 'output_config' in body, false)
}

// ─────────────── 7. thinking 开启时对齐 temperature ───────────────

console.log('\n7. thinking 开启时对齐 temperature')
{
  eq('enabled + 0.7 → 1',
    enforceThinkingTemperature({ thinking: { type: 'enabled' }, temperature: 0.7 }).temperature, 1)
  eq('adaptive + 无 temperature → 1',
    enforceThinkingTemperature({ thinking: { type: 'adaptive' } }).temperature, 1)
  eq('adaptive + 1 → 1',
    enforceThinkingTemperature({ thinking: { type: 'adaptive' }, temperature: 1 }).temperature, 1)
  eq('大小写容忍',
    enforceThinkingTemperature({ thinking: { type: 'ENABLED' }, temperature: 0 }).temperature, 1)

  // top_p / top_k 与 thinking 互斥，一并删掉
  const aligned = enforceThinkingTemperature({
    thinking: { type: 'enabled' }, temperature: 0.3, top_p: 0.9, top_k: 5,
  })
  eq('top_p 被删', 'top_p' in aligned, false)
  eq('top_k 被删', 'top_k' in aligned, false)
  eq('temperature 被强制为 1', aligned.temperature, 1)

  // 没有 thinking：一律不动
  eq('无 thinking 不动 temperature',
    enforceThinkingTemperature({ temperature: 0.3 }).temperature, 0.3)
  eq('无 thinking 保留 top_p',
    enforceThinkingTemperature({ temperature: 0.3, top_p: 0.9 }).top_p, 0.9)
  eq('disabled 不动 temperature',
    enforceThinkingTemperature({ thinking: { type: 'disabled' }, temperature: 0.3 }).temperature, 0.3)
  eq('disabled 保留 top_p',
    enforceThinkingTemperature({ thinking: { type: 'disabled' }, top_p: 0.9 }).top_p, 0.9)

  // 已是合法形态时返回同一引用
  const fine = { thinking: { type: 'adaptive' }, temperature: 1 }
  eq('已对齐时返回同一引用', enforceThinkingTemperature(fine) === fine, true)

  const body = { thinking: { type: 'adaptive' }, temperature: 0.5, top_p: 0.8 }
  const snapshot = clone(body)
  enforceThinkingTemperature(body)
  eq('enforceThinkingTemperature 不改入参', JSON.stringify(body), JSON.stringify(snapshot))
}

// ─────────────── 8. 串联与顺序依赖 ───────────────

console.log('\n8. applyDegradationGuards 串联')
{
  // 全缺的最小 body：五项一次补齐
  const minimal = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }
  const guarded = applyDegradationGuards(minimal)
  eq('补 max_tokens', guarded.max_tokens, 128000)
  eq('补 thinking', guarded.thinking, { type: 'adaptive', display: 'omitted' })
  eq('补 effort', guarded.output_config, { effort: 'medium' })
  eq('强制 temperature', guarded.temperature, 1)
  eq('原 body 未被修改',
    JSON.stringify(minimal),
    JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }))

  // 顺序依赖①：先补 max_tokens、再夹 budget —— 两者必须同时存在
  const orderA = applyDegradationGuards({
    model: 'claude-sonnet-5',
    thinking: { type: 'enabled', budget_tokens: 512 },
  })
  ok('顺序：max_tokens 与 budget 同时生效',
    orderA.max_tokens === 64000 && orderA.thinking.budget_tokens === MIN_THINKING_BUDGET,
    JSON.stringify(orderA))

  // 顺序依赖②：thinking 先补出来，temperature 才会被强制（第 5 步看第 3 步的结果）
  const orderB = applyDegradationGuards({ model: 'claude-opus-5', temperature: 0.2 })
  ok('顺序：先补 thinking 再对齐 temperature',
    orderB.thinking?.type === 'adaptive' && orderB.temperature === 1,
    JSON.stringify(orderB))

  // 顺序依赖③：模型不支持 adaptive 时不补 thinking，因此 temperature 保持调用方的值
  const orderC = applyDegradationGuards({ model: 'claude-sonnet-4-5', temperature: 0.2 })
  ok('顺序：不补 thinking 就不动 temperature',
    !('thinking' in orderC) && orderC.temperature === 0.2,
    JSON.stringify(orderC))

  // 调用方全都显式给值 → 一个字段都不改（补齐 ≠ 覆盖）
  const explicit = {
    model: 'claude-opus-5-5',
    max_tokens: 4096,
    temperature: 1,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'xhigh', format: { type: 'json_schema' } },
  }
  const explicitOut = applyDegradationGuards(explicit)
  eq('显式 max_tokens 保留', explicitOut.max_tokens, 4096)
  eq('显式 display 保留', explicitOut.thinking.display, 'summarized')
  eq('显式 effort 保留', explicitOut.output_config.effort, 'xhigh')
  eq('显式 format 保留', explicitOut.output_config.format, { type: 'json_schema' })
  eq('显式 temperature 保留', explicitOut.temperature, 1)

  // 旧模型：只补 max_tokens，不补 thinking / effort
  const oldModel = applyDegradationGuards({ model: 'claude-sonnet-4-5' })
  eq('旧模型补 max_tokens', oldModel.max_tokens, 16384)
  eq('旧模型不补 thinking', 'thinking' in oldModel, false)
  eq('旧模型不补 effort', 'output_config' in oldModel, false)

  // 旧模型带 thinking + 超预算：补 budget 与 temperature，但 effort 不补
  const oldThinking = applyDegradationGuards({
    model: 'claude-sonnet-4-5', thinking: { type: 'enabled', budget_tokens: 100 },
  })
  ok('旧模型 thinking 预算被抬到下限', oldThinking.thinking.budget_tokens === MIN_THINKING_BUDGET,
    JSON.stringify(oldThinking))
  ok('旧模型 thinking 开启仍对齐 temperature', oldThinking.temperature === 1, JSON.stringify(oldThinking))

  // 未知模型：整条链一个字段都不加
  const unknown = applyDegradationGuards({ model: 'm', messages: [] })
  eq('未知模型不补任何字段', Object.keys(unknown).sort(), ['messages', 'model'])
  eq('未知模型返回同一引用', unknown === applyDegradationGuards(unknown), true)

  // 幂等：重复应用不产生变化
  eq('幂等', applyDegradationGuards(guarded), guarded)

  // 边界
  eq('null 原样返回', applyDegradationGuards(null), null)
  eq('非对象原样返回', applyDegradationGuards('x'), 'x')

  // 五个独立函数都是可单测的纯函数（不共享可变状态）
  eq('独立函数也幂等',
    applyDefaultMaxTokens(applyDefaultMaxTokens({ model: 'claude-opus-5' })),
    applyDefaultMaxTokens({ model: 'claude-opus-5' }))
}

// ─────────────── 9. 与清洗层的先后顺序 ───────────────

console.log('\n9. 与清洗层的先后顺序')
{
  // 补齐用的四个字段必须在黑名单之外：否则「先补后洗」会被洗掉，
  // 「先洗后补」的顺序就不只是性能问题，而是能不能出站的问题。
  for (const key of ['max_tokens', 'thinking', 'output_config', 'temperature']) {
    eq(`${key} 不在 DROP_TOP 里`, DROP_TOP.has(key), false)
  }

  // 真实顺序：先清洗，再补齐 —— 补出来的字段必须完整留在 body 里
  const sanitized = sanitizeAnthropicBody({
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning: 'should-drop',
    max_output_tokens: 999,
  })
  eq('清洗把 reasoning 删掉', 'reasoning' in sanitized, false)
  const after = applyDegradationGuards(sanitized)
  eq('清洗后补齐的 thinking 还在', after.thinking, { type: 'adaptive', display: 'omitted' })
  eq('清洗后补齐的 effort 还在', after.output_config, { effort: 'medium' })
  eq('清洗后补齐的 max_tokens 还在', after.max_tokens, 128000)

  // 反向验证：先补后洗也不会丢 —— 说明两层的字段集合确实不冲突
  const reversed = sanitizeAnthropicBody(applyDegradationGuards({ model: 'claude-opus-5-5' }))
  eq('先补后洗 thinking 仍在', reversed.thinking, { type: 'adaptive', display: 'omitted' })
  eq('先补后洗 effort 仍在', reversed.output_config, { effort: 'medium' })
}

// ─────────────── 10. createMessage 接线 ───────────────

console.log('\n10. createMessage 接线（假 fetch）')

/** 最小 Response 替身：STREAM 模式只看状态与头。 */
function fakeResponse({ status = 200, headers = {}, body = null } = {}) {
  const store = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      forEach(cb) { store.forEach((v, k) => cb(v, k)) },
      get(k) { return store.has(String(k).toLowerCase()) ? store.get(String(k).toLowerCase()) : null },
      has(k) { return store.has(String(k).toLowerCase()) },
    },
    body,
  }
}

function makeFetch() {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    return fakeResponse({
      headers: { 'content-type': 'text/event-stream' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
          controller.close()
        },
      }),
    })
  }
  fn.calls = calls
  return fn
}

/** 取最后一次出站请求的 body（解压 → parse）。 */
function wiredBody(init) {
  const buf = Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body)
  return JSON.parse(buf.toString('utf8'))
}

{
  const fetchImpl = makeFetch()
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  const out = await upstream.createMessage({
    body: { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
    headers: { authorization: 'Bearer T' },
    mode: MODE.STREAM,
  })
  eq('状态码 200', out.status, 200)
  const wire = wiredBody(fetchImpl.calls[0].init)
  eq('wire 带 max_tokens', wire.max_tokens, 128000)
  eq('wire 带 thinking', wire.thinking, { type: 'adaptive', display: 'omitted' })
  eq('wire 带 effort', wire.output_config, { effort: 'medium' })
  eq('wire 带 temperature', wire.temperature, 1)
  eq('wire 保留 stream 标志', wire.stream, true)
  const sentHeaders = headersToObject(fetchImpl.calls[0].init.headers)
  ok('接线不影响 beta 头', typeof sentHeaders['anthropic-beta'] === 'string' && sentHeaders['anthropic-beta'].length > 0)
}

{
  // 调用方显式值经 createMessage 全程不被覆盖
  const fetchImpl = makeFetch()
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  await upstream.createMessage({
    body: {
      model: 'claude-opus-5-5',
      max_tokens: 512,
      temperature: 1,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
      messages: [],
    },
    headers: { authorization: 'Bearer T' },
    mode: MODE.STREAM,
  })
  const wire = wiredBody(fetchImpl.calls[0].init)
  eq('接线后 max_tokens 保留', wire.max_tokens, 512)
  eq('接线后 display 保留', wire.thinking.display, 'summarized')
  eq('接线后 effort 保留', wire.output_config.effort, 'xhigh')
}

{
  // 未知模型：接线后不应凭空多出任何字段（保守）
  const fetchImpl = makeFetch()
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  await upstream.createMessage({
    body: { model: 'm', messages: [] },
    headers: { authorization: 'Bearer T' },
    mode: MODE.STREAM,
  })
  const wire = wiredBody(fetchImpl.calls[0].init)
  eq('未知模型接线后字段集合', Object.keys(wire).sort(), ['messages', 'model', 'stream'])
}

{
  // DOCUMENT 模式仍然不带 stream 键（补齐不改变线协议）
  const fetchImpl = makeFetch()
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  await upstream.createMessage({
    body: { model: 'claude-opus-5', messages: [] },
    headers: { authorization: 'Bearer T' },
    mode: MODE.DOCUMENT,
  })
  const wire = wiredBody(fetchImpl.calls[0].init)
  eq('DOCUMENT 模式没有 stream 键', 'stream' in wire, false)
  eq('DOCUMENT 模式仍补齐 max_tokens', wire.max_tokens, 32000)
  eq('DOCUMENT 模式仍补齐 thinking', wire.thinking, { type: 'adaptive', display: 'omitted' })
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) process.exit(1)
