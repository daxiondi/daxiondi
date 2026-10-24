// outbound-shape 模块单测：归约规则、脱敏、diff、渲染，以及 fixture 回放。
// 运行：node test/outbound-shape.mjs
// 纯函数 + 真实构造链（动态 import），不联网、不开进程、不写 fixture。

import {
  diffShape,
  formatShape,
  billingFieldNames,
  isArrayMarker,
  looksLikeShape,
  shapeOf,
  unwrapShape,
  wrapShape,
  SHAPE_FORMAT,
} from '../src/outbound-shape.mjs'
// 回放段要用真实构造链：sys-layout → betas → cch，与 server.mjs 的 prepareOutbound 同序
import { buildOutbound, loadPipeline, FIXTURE_DIR } from '../scripts/outbound-replay.mjs'
import fsNode from 'node:fs'
import pathNode from 'node:path'

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log('  ok   ', name)
  } else {
    fail++
    console.log('  FAIL ', name, '\n         got ', g, '\n         want', w)
  }
}
const ok = (name, cond) => eq(name, Boolean(cond), true)

// ───────── 1. 基础类型的归约 ─────────

eq('字符串 → <text:字节数>', shapeOf('hello'), '<text:5>')
eq('空字符串 → <text:0>', shapeOf(''), '<text:0>')
eq('中文按 UTF-8 字节计（3 字节/字）', shapeOf('中文'), '<text:6>')
eq('emoji 按 UTF-8 字节计（4 字节）', shapeOf('😀'), '<text:4>')
eq('数字 → <number>', shapeOf(42), '<number>')
eq('浮点 → <number>', shapeOf(0.25), '<number>')
eq('NaN 也是数字', shapeOf(Number.NaN), '<number>')
eq('布尔 true → <bool>', shapeOf(true), '<bool>')
eq('布尔 false → <bool>', shapeOf(false), '<bool>')
eq('null → <null>', shapeOf(null), '<null>')
eq('undefined → <undefined>', shapeOf(undefined), '<undefined>')
eq('空对象 → {}', shapeOf({}), {})
eq('空数组 → {__array:0}', shapeOf([]), { __array: 0 })

// ───────── 2. 对象与数组结构 ─────────

eq('对象保留键名并递归', shapeOf({ a: 'x', b: 1 }), { a: '<text:1>', b: '<number>' })
eq('对象键顺序保留', Object.keys(shapeOf({ z: 1, a: 2, m: 3 })), ['z', 'a', 'm'])
eq(
  '三层嵌套结构完整',
  shapeOf({ a: { b: { c: 'deep' } } }),
  { a: { b: { c: '<text:4>' } } },
)
eq(
  '数组 → 长度 + 首元素结构',
  shapeOf(['a', 'bb', 'ccc']),
  { __array: 3, __item: '<text:1>' },
)
eq(
  '同构数组元素不产生 variants',
  shapeOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'bbbb' }]),
  { __array: 2, __item: { type: 'text', text: '<text:1>' } },
)
eq(
  '异构数组元素产生 variants',
  shapeOf([{ type: 'text' }, { type: 'image' }]),
  {
    __array: 2,
    __item: { type: 'text' },
    __variants: [{ type: 'text' }, { type: 'image' }],
  },
)
eq(
  '嵌套数组也归约',
  shapeOf({ matrix: [[1], [2, 3]] }),
  {
    matrix: {
      __array: 2,
      __item: { __array: 1, __item: '<number>' },
      // 长度是结构的一部分，[1] 与 [2,3] 属于不同结构
      __variants: [{ __array: 1, __item: '<number>' }, { __array: 2, __item: '<number>' }],
    },
  },
)
eq(
  '同长度的嵌套数组只有一种结构',
  shapeOf({ matrix: [[1], [2]] }),
  { matrix: { __array: 2, __item: { __array: 1, __item: '<number>' } } },
)

// ───────── 3. 枚举值例外 ─────────

eq('type 保留原值', shapeOf({ type: 'text' }), { type: 'text' })
eq('role 保留原值', shapeOf({ role: 'assistant' }), { role: 'assistant' })
eq('model 保留原值', shapeOf({ model: 'claude-opus-5-5' }), { model: 'claude-opus-5-5' })
eq('数组元素里的 type 也保留', shapeOf([{ type: 'tool_use' }]), {
  __array: 1,
  __item: { type: 'tool_use' },
})
eq('非枚举键的短字符串仍然脱敏', shapeOf({ id: 'msg_123' }), { id: '<text:7>' })
eq(
  '枚举键之外的同名字段不误判（大小写敏感）',
  shapeOf({ Model: 'claude-opus-5-5' }),
  { Model: '<text:15>' },
)

// ───────── 4. cache_control / betas / billing ─────────

eq('cache_control 存在 → true', shapeOf({ cache_control: { type: 'ephemeral', ttl: '1h' } }), {
  cache_control: true,
})
eq('cache_control 为 null 也是 true（存在即标记）', shapeOf({ cache_control: null }), {
  cache_control: true,
})
eq(
  '数组元素里的 cache_control 位置保留',
  shapeOf({ content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }),
  { content: { __array: 1, __item: { type: 'text', text: '<text:2>', cache_control: true } } },
)
eq(
  'betas 列表保留 beta 名',
  shapeOf({ betas: ['claude-code-20250219', 'oauth-2025-04-20'] }),
  { betas: { __array: 2, __item: 'claude-code-20250219', __variants: ['claude-code-20250219', 'oauth-2025-04-20'] } },
)
eq(
  'anthropic-beta（带连字符）也按 beta 列表处理',
  shapeOf({ 'anthropic-beta': ['effort-2025-11-24'] }),
  { 'anthropic-beta': { __array: 1, __item: 'effort-2025-11-24' } },
)
eq(
  'billing header 只留字段名',
  shapeOf('x-anthropic-billing-header: cc_version=2.1.296; cch=5fa84; cc_prompt_id=abc;'),
  '<billing:cc_version,cch,cc_prompt_id>',
)
eq(
  'billing 字段名列表不含等号与值',
  billingFieldNames('x-anthropic-billing-header: a=1;b=2;c;'),
  ['a', 'b', 'c'],
)
eq(
  'system 数组里的 billing 块按 billing 归约',
  shapeOf({ system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1; cch=00000;' }] }),
  { system: { __array: 1, __item: { type: 'text', text: '<billing:cc_version,cch>' } } },
)

// ───────── 5. 脱敏有效性 ─────────

const secretBody = {
  model: 'claude-opus-5-5',
  system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296; cch=a1b2c;' },
    { type: 'text', text: 'SECRET-SYSTEM-PROMPT-MARKER', cache_control: { type: 'ephemeral' } },
  ],
  messages: [{ role: 'user', content: 'my private prompt 中文内容' }],
  metadata: { user_id: 'secret-user-id-abcdef' },
}
const secretShape = shapeOf(secretBody)
const secretText = JSON.stringify(secretShape)
ok('文本内容完全不出现（system）', !secretText.includes('SECRET-SYSTEM-PROMPT-MARKER'))
ok('文本内容完全不出现（messages）', !secretText.includes('private prompt'))
ok('文本内容完全不出现（metadata）', !secretText.includes('secret-user-id'))
ok('billing 值不出现（cch）', !secretText.includes('a1b2c'))
ok('枚举与结构仍然保留', secretText.includes('claude-opus-5-5') && secretText.includes('"role":"user"'))

// ───────── 6. diff ─────────

eq('相同 shape 无差异', diffShape(shapeOf({ a: 1 }), shapeOf({ a: 2 })), [])
eq(
  '非 strict 忽略文本长度',
  diffShape(shapeOf({ t: 'abc' }), shapeOf({ t: 'abcdefgh' })),
  [],
)
eq(
  'strict 检出文本长度差异',
  diffShape(shapeOf({ t: 'abc' }), shapeOf({ t: 'abcdefgh' }), '', { strict: true }),
  [{ path: 't', kind: 'value', expected: '<text:3>', actual: '<text:8>' }],
)
eq(
  '检出面值变化（枚举）',
  diffShape(shapeOf({ model: 'a' }), shapeOf({ model: 'b' })),
  [{ path: 'model', kind: 'value', expected: 'a', actual: 'b' }],
)
eq(
  '检出缺失字段',
  diffShape(shapeOf({ a: 1, b: 2 }), shapeOf({ a: 1 })),
  [{ path: 'b', kind: 'missing' }],
)
eq(
  '检出多余字段',
  diffShape(shapeOf({ a: 1 }), shapeOf({ a: 1, extra: true })),
  [{ path: 'extra', kind: 'extra' }],
)
eq(
  '检出数组长度差异',
  diffShape(shapeOf({ xs: [1, 2] }), shapeOf({ xs: [1, 2, 3] })),
  [{ path: 'xs.__array', kind: 'length', expected: 2, actual: 3 }],
)
eq(
  '检出深层嵌套差异（三层）',
  diffShape(shapeOf({ a: { b: { c: 'x' } } }), shapeOf({ a: { b: { c: 1 } } })),
  [{ path: 'a.b.c', kind: 'value', expected: '<text:1>', actual: '<number>' }],
)
eq(
  '检出键顺序变化',
  diffShape(shapeOf({ a: 1, b: 2 }), shapeOf({ b: 2, a: 1 })),
  [{ path: '.', kind: 'key_order', expected: ['a', 'b'], actual: ['b', 'a'] }],
)
eq(
  '检出类型变化（对象→数组）',
  diffShape(shapeOf({ a: { x: 1 } }), shapeOf({ a: [1] })),
  [{ path: 'a', kind: 'value', expected: 'object{1}', actual: 'array[1]' }],
)
eq(
  '检出 cache_control 位置新增',
  diffShape(shapeOf({ a: { type: 'text' } }), shapeOf({ a: { type: 'text', cache_control: {} } })),
  [{ path: 'a.cache_control', kind: 'extra' }],
)
eq(
  '检出数组元素结构变化',
  diffShape(shapeOf({ xs: [{ type: 'text' }] }), shapeOf({ xs: [{ type: 'image' }] })),
  [{ path: 'xs.__item.type', kind: 'value', expected: 'text', actual: 'image' }],
)
eq(
  '检出 variants 出现',
  diffShape(shapeOf([{ type: 'text' }]), shapeOf([{ type: 'text' }, { type: 'image' }])),
  [
    { path: '__array', kind: 'length', expected: 1, actual: 2 },
    { path: '__variants', kind: 'value', expected: 'single', actual: 'variants[2]' },
  ],
)
const multi = diffShape(
  shapeOf({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] }),
  shapeOf({ model: 'm', messages: [{ role: 'system', content: [{ type: 'text', text: 'a' }] }] }),
)
eq('深层差异路径格式正确', multi.map((d) => d.path), ['messages.__item.role'])

// ───────── 7. 渲染与包装 ─────────

const rendered = formatShape(secretShape)
ok('渲染包含字段名', rendered.includes('system') && rendered.includes('messages'))
ok('渲染不含原文', !rendered.includes('SECRET-SYSTEM-PROMPT-MARKER'))
ok('渲染标注数组长度', /array\[\d+\]/.test(rendered))
ok('渲染标注对象键数', /object\{\d+\}/.test(rendered))
const indented = formatShape({ a: 1 }, 4)
ok('indent 参数生效', indented.startsWith('    '))
eq('包装后可识别格式', wrapShape({ a: 1 }).__format, SHAPE_FORMAT)
eq(
  'unwrap 还原',
  unwrapShape(wrapShape({ a: 1 })),
  { shape: { a: 1 }, wrapped: true },
)
eq('unwrap 对非 shape 文档返回 wrapped=false', unwrapShape({ model: 'x' }).wrapped, false)
ok('looksLikeShape 识别骨架', looksLikeShape(shapeOf({ a: 1, b: 'x' })))
ok('looksLikeShape 拒绝请求体', !looksLikeShape({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }))
ok('isArrayMarker 识别数组标记', isArrayMarker({ __array: 2, __item: '<number>' }))
ok('isArrayMarker 拒绝普通对象', !isArrayMarker({ __array: 2, other: 1 }))

// ───────── 8. 空容器与极端嵌套 ─────────

eq('空对象在深层保留为 {}', shapeOf({ a: { b: {} } }), { a: { b: {} } })
eq('空数组在深层保留为 {__array:0}', shapeOf({ a: [{}, [], null] }), {
  a: { __array: 3, __item: {}, __variants: [{}, { __array: 0 }, '<null>'] },
})
eq('diff 检出空对象→有键', diffShape(shapeOf({ a: {} }), shapeOf({ a: { k: 1 } })), [
  { path: 'a.k', kind: 'extra' },
])
eq('diff 检出空数组→有元素', diffShape(shapeOf({ a: [] }), shapeOf({ a: [1] })), [
  { path: 'a.__array', kind: 'length', expected: 0, actual: 1 },
  { path: 'a.__item', kind: 'value', expected: '<absent>', actual: '<number>' },
])
const deep = { l1: { l2: { l3: { l4: { l5: 'deep text' } } } } }
const deepShape = shapeOf(deep)
eq(
  '五层嵌套结构保留',
  JSON.stringify(deepShape),
  JSON.stringify({ l1: { l2: { l3: { l4: { l5: '<text:9>' } } } } }),
)
eq(
  '五层嵌套的差异路径完整',
  diffShape(deepShape, shapeOf({ l1: { l2: { l3: { l4: { l5: 1 } } } } })).map((d) => d.path),
  ['l1.l2.l3.l4.l5'],
)

// ───────── 9. verify 工具的解析器（错误字段 / SSE 用量） ─────────

const verifyTool = await import('../scripts/outbound-verify.mjs')
eq(
  '解析 Anthropic 点路径错误字段',
  verifyTool.rejectedFields({ error: { message: 'messages.0.content.0.text: unexpected field' } }),
  ['messages.0.content.0.text'],
)
eq(
  '解析 extra inputs 错误',
  verifyTool.rejectedFields({ error: { message: 'Extra inputs are not permitted: temperature' } }),
  ['temperature'],
)
eq(
  '解析 Codex 未识别参数',
  verifyTool.rejectedFields({ detail: 'Unrecognized request argument supplied: reasoning.summary' }),
  ['reasoning.summary'],
)
eq('解析结构化 param 字段', verifyTool.rejectedFields({ error: { param: 'max_tokens', message: 'invalid' } }), [
  'max_tokens',
])
eq('无错误字段时返回空数组', verifyTool.rejectedFields({ error: { message: 'Bad Request' } }), [])

const sseText = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":0,"cache_read_input_tokens":10}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n')
const sse = verifyTool.consumeSse(sseText)
eq('SSE 累加输入 token', sse.usage.input, 25)
eq('SSE 累加输出 token', sse.usage.output, 5)
eq('SSE 合计 token', sse.usage.total, 30)
eq('SSE 缓存读 token', sse.usage.cache_read, 10)
eq('SSE 不去重事件名', sse.events.includes('message_start') && sse.events.includes('message_stop'), true)
eq('SSE 记录 stop_reason', sse.stopReasons, ['end_turn'])
eq(
  '非流式用量解析',
  verifyTool.consumeJson({ usage: { input_tokens: 7, output_tokens: 3 } }),
  { input: 7, output: 3, total: 10, cache_read: 0, cache_write: 0 },
)
eq(
  '配额头只挑配额相关项',
  Object.keys(
    verifyTool.quotaHeaders({
      'anthropic-ratelimit-input-tokens-remaining': '100',
      'x-codex-primary-used-percent': '0',
      'x-codex-turn-state': 'x'.repeat(500),
      'content-type': 'text/event-stream',
    }),
  ).sort(),
  ['anthropic-ratelimit-input-tokens-remaining', 'x-codex-primary-used-percent'],
)

// ───────── 10. 回放：fixture 目录 + 真实构造链 ─────────
//
// 这一段把 scripts/outbound-replay.mjs 的能力当断言跑：每条 fixture 都要回放通过，
// 同时验三件「防止回放退化成恒真」的事：
//   1. fixture 目录本身完整（名字唯一、expected_shape 齐全且确实是骨架）
//   2. expected_shape 里不含任何请求原文（脱敏真的生效了）
//   3. 改一处结构后 diff 能报出来
//
// 构造链用真实的 system-layout / identity / cch / frames，不开进程、不联网。

const pipeline = await loadPipeline()
if (pipeline.missing.length) {
  for (const item of pipeline.missing) console.log('  FAIL  构造链依赖不可用', item.module, item.error)
  console.log(`\n通过 0 / 失败 ${pipeline.missing.length}`)
  process.exit(1)
}

const files = fsNode
  .readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => pathNode.join(FIXTURE_DIR, name))

ok('fixture 目录存在且非空', files.length > 0)
ok('至少 3 个 fixture', files.length >= 3)

const docs = []
for (const file of files) {
  const doc = JSON.parse(fsNode.readFileSync(file, 'utf8'))
  docs.push({ file, doc })
}

// ───────── 1. fixture 自身完整性 ─────────

const names = docs.map((d) => d.doc.name)
eq('fixture 名字唯一', new Set(names).size, names.length)
for (const { file, doc } of docs) {
  const base = pathNode.basename(file)
  ok(`${base} 有 name`, typeof doc.name === 'string' && doc.name.length > 0)
  ok(`${base} 有 request.body`, Boolean(doc.request?.body) && typeof doc.request.body === 'object')
  ok(`${base} 有 expected_shape`, Boolean(doc.expected_shape) && typeof doc.expected_shape === 'object')
  ok(`${base} 的 expected_shape 确实是骨架`, looksLikeShape(doc.expected_shape))
}

// ───────── 2. 每条 fixture 回放通过 ─────────

for (const { file, doc } of docs) {
  const base = pathNode.basename(file)
  const built = buildOutbound(doc.request, pipeline)
  const actual = shapeOf(built.body)
  const diffs = diffShape(doc.expected_shape, actual)
  eq(`${base} 回放无差异`, diffs, [])
  ok(`${base} 构造链有步骤记录`, built.steps.length > 0)
}

// ───────── 3. 脱敏：expected_shape 里不含请求原文 ─────────

/** 收集 body 里所有长度 ≥12 的文本片段（这些最有可能是提示词原文） */
function textFragments(value, out = []) {
  if (typeof value === 'string') {
    if (value.length >= 12) out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) textFragments(item, out)
  } else if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) textFragments(inner, out)
  }
  return out
}

/**
 * 枚举键（type / role / model）的值按设计就是不脱敏的——它们是协议常量，
 * 骨架里出现属于预期，不能算泄露。先把这些值收集出来排除掉。
 */
const ENUM_KEYS = new Set(['type', 'role', 'model'])
function enumValues(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) enumValues(item, out)
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (ENUM_KEYS.has(key) && typeof inner === 'string') out.add(inner)
      else enumValues(inner, out)
    }
  }
  return out
}

let checkedFragments = 0
for (const { file, doc } of docs) {
  const base = pathNode.basename(file)
  const shapeText = JSON.stringify(doc.expected_shape)
  const exempt = enumValues(doc.request.body)
  const fragments = textFragments(doc.request.body).filter((fragment) => !exempt.has(fragment))
  const leaked = fragments.filter((fragment) => shapeText.includes(fragment))
  eq(`${base} expected_shape 不含请求原文`, leaked, [])
  checkedFragments += fragments.length
}
// 防止「脱敏检查恒真」：所有 fixture 加起来必须有足够多的真实文本片段被验过
ok('至少验过 10 段请求原文的脱敏', checkedFragments >= 10)

// ───────── 4. diff 不是恒真：改一处结构必须报出来 ─────────

const sample = docs[0]
const builtSample = buildOutbound(sample.doc.request, pipeline)
const mutated = structuredClone(shapeOf(builtSample.body))
mutated.__probe_extra = '<bool>'
const mutationDiffs = diffShape(sample.doc.expected_shape, mutated)
eq(
  '注入一个字段后 diff 能报出该字段',
  mutationDiffs.some((d) => d.path === '__probe_extra' && d.kind === 'extra'),
  true,
)

// ───────── 5. 构造链的三个分支都被覆盖 ─────────

const branches = new Set()
for (const { doc } of docs) {
  const built = buildOutbound(doc.request, pipeline)
  for (const step of built.steps) branches.add(step)
}
ok('覆盖 system:layout:zero', branches.has('system:layout:zero'))
ok('覆盖 system:layout:identity', branches.has('system:layout:identity'))
ok('覆盖 system:wire-normalize（调用方官方布局）', branches.has('system:wire-normalize'))
ok('覆盖 betas:merge', branches.has('betas:merge'))
ok('覆盖 cch:seal', branches.has('cch:seal'))

// ───────── 6. cch 真的被盖上了（不是占位符） ─────────

for (const { file, doc } of docs) {
  const base = pathNode.basename(file)
  const built = buildOutbound(doc.request, pipeline)
  const billing = (built.body.system || [])
    .map((block) => (typeof block === 'string' ? block : block?.text || ''))
    .find((text) => text.startsWith('x-anthropic-billing-header'))
  if (!billing) {
    eq(`${base} 无 billing 块（豁免 cch 检查）`, true, true)
    continue
  }
  ok(`${base} billing 的 cch 不是占位符`, /cch=(?!00000)[0-9a-f]{5};/.test(billing))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
