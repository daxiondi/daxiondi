#!/usr/bin/env node
/**
 * 缓存断点的端到端验证脚本。
 *
 * 运行：node test/breakpoints-demo.mjs
 *
 * 构造一个 10 条消息的真实请求体，直接走 server.mjs 的 prepareOutbound
 * （system 布局 → betas 合并 → 缓存断点 → cch 封盖），打印：
 *   1. 断点位置
 *   2. 最终 body 的 cache_control 分布
 *   3. audit 结果
 *
 * 期望：messages 2 点 + system 2 点 = 4 点，且尾部两点分别落在最后两条
 * user 上；封盖后 billing header 里的 cch 是真实值而非占位符。
 */

import { layoutSystemBlocks } from '../src/system-layout.mjs'
import { applyCacheBreakpoints, auditCacheBreakpoints } from '../src/cache-breakpoints.mjs'
import { prepareOutbound } from '../src/server.mjs'
import { BETA } from '../src/betas.mjs'

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass += 1
    console.log('  ok   ', name)
  } else {
    fail += 1
    console.log('  FAIL ', name, '\n         got ', g, '\n         want', w)
  }
}

// ─────────────── 构造 10 条消息 ───────────────
// 真实对话形态：user / assistant 交替，assistant 里带 thinking + tool_use，
// 最后一条 user 带 tool_result（这是 Claude 通道最常见的收尾形态）。
const messages = []
for (let turn = 0; turn < 5; turn += 1) {
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: `第 ${turn + 1} 轮用户输入：请处理 case-${turn}。` }],
  })
  messages.push({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: `先看看 case-${turn} 是什么` },
      { type: 'text', text: `处理 case-${turn}` },
      { type: 'tool_use', id: `toolu_${turn}`, name: 'Read', input: { path: `/tmp/case-${turn}` } },
    ],
  })
}
// 末尾第 10 条改成 tool_result，保证以 user 结尾
messages[9] = {
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: 'toolu_4', content: 'ok' }],
}

const request = {
  model: 'claude-sonnet-5-5',
  max_tokens: 4096,
  system: layoutSystemBlocks({
    attribution: 'x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoint=cli;',
    leftover: '主提示词：按 tool 结果继续。',
    env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'identity', TZ: 'Asia/Shanghai' },
  }).map((text) => ({ type: 'text', text })),
  messages,
}

console.log('── 出站前 ──')
console.log(`  system 块: ${request.system.length}`)
console.log(`  messages : ${request.messages.length}`)
console.log(`  角色序列 : ${request.messages.map((m) => (m.role === 'user' ? 'u' : 'a')).join('')}`)

// ─────────────── 走真实出站流程 ───────────────
const body = prepareOutbound(JSON.parse(JSON.stringify(request)), { systemLayout: 'identity' })
const result = applyCacheBreakpoints(body, { ttl: '1h' })

console.log('\n── 断点位置 ──')
console.log(`  system   : [${result.system.join(', ')}]（块数 ${body.system.length}）`)
console.log(`  messages : [${result.messages.join(', ')}]`)
console.log(`  合计     : ${result.total} 点`)

// ─────────────── 打印最终结构 ───────────────
const shrink = (block) => {
  const out = { type: block.type }
  if (block.text) out.text = block.text.length > 28 ? `${block.text.slice(0, 28)}…` : block.text
  if (block.thinking) out.thinking = '…'
  if (block.tool_use_id) out.tool_use_id = block.tool_use_id
  if (block.id) out.id = block.id
  if (block.cache_control) out.cache_control = block.cache_control
  return out
}

console.log('\n── 最终 body 的 system ──')
body.system.forEach((block, i) => {
  console.log(`  [${i}] ${JSON.stringify(shrink(block))}`)
})

console.log('\n── 最终 body 的 messages ──')
body.messages.forEach((message, i) => {
  const marked = message.content.some((b) => b.cache_control)
  console.log(`  [${i}] ${message.role}${marked ? ' ◀ 断点' : ''}`)
  for (const block of message.content) console.log(`        ${JSON.stringify(shrink(block))}`)
})

// ─────────────── 封盖后的实际 wire 形态 ───────────────
const sealedSystem = Array.isArray(body.system) ? body.system : [body.system]
const sealedCch = /cch=([0-9a-f]{5});/.exec(sealedSystem[0].text)?.[1]
console.log('\n── 封盖后 ──')
console.log(`  billing cch : ${sealedCch}`)
console.log(`  betas       : ${JSON.stringify(body.betas || [])}`)

// ─────────────── 断言 ───────────────
console.log('\n── 断言 ──')
eq('消息条数为 10', body.messages.length, 10)
eq('system 断点为首末两块', result.system, [0, body.system.length - 1])
eq('messages 断点为最后两个 user', result.messages, [8, 9])
eq('messages 断点数量为 2', result.messages.length, 2)
eq('system 断点数量为 2', result.system.length, 2)
eq('断点总数为 4', result.total, 4)
eq('audit 无问题', auditCacheBreakpoints(body), [])

const sysMarkers = body.system.filter((b) => b.cache_control).length
const msgMarkers = body.messages.reduce(
  (n, m) => n + m.content.filter((b) => b.cache_control).length,
  0,
)
eq('实测 system 标记数', sysMarkers, 2)
eq('实测 messages 标记数', msgMarkers, 2)
eq('实测总数', sysMarkers + msgMarkers, 4)
eq('断点 TTL 一致为 1h', [...body.system, ...body.messages.flatMap((m) => m.content)]
  .filter((b) => b.cache_control)
  .every((b) => b.cache_control.ttl === '1h'), true)
eq('thinking 块未被打标', body.messages[1].content[0].cache_control, undefined)
eq('tool_use 块未被打标', body.messages[1].content[2].cache_control, undefined)
eq('尾部断点落在 tool_result 块', body.messages[9].content[0].cache_control.type, 'ephemeral')
eq('上一轮断点落在倒数第二条 user', body.messages[8].content[0].cache_control.type, 'ephemeral')

// 1h TTL 必须配套 extended-cache-ttl 能力声明
eq('1h 断点声明 extended-cache-ttl', (body.betas || []).includes(BETA.EXTENDED_CACHE_TTL), true)

// 封盖后 cch 正常
eq('封盖后 cch 非占位', sealedCch !== '00000' && /^[0-9a-f]{5}$/.test(String(sealedCch)), true)

// 幂等：同一份 body 再走一次断点，字节不变
const before = JSON.stringify(body)
applyCacheBreakpoints(body, { ttl: '1h' })
eq('重复调用字节不变', JSON.stringify(body), before)

// ─────────────── 对照组：3 条消息 ───────────────
const short = {
  system: layoutSystemBlocks({ attribution: '', env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'zero', TZ: 'UTC' } })
    .map((text) => ({ type: 'text', text })),
  messages: [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ],
}
const shortResult = applyCacheBreakpoints(short)
console.log('\n── 对照组：3 条消息 ──')
console.log(`  system [${shortResult.system.join(', ')}]  messages [${shortResult.messages.join(', ')}]  合计 ${shortResult.total} 点`)
eq('3 条消息只打一个 messages 断点', shortResult.messages, [2])
eq('3 条消息总点数为 3', shortResult.total, 3)

// ─────────────── 对照组：4 条消息恰好触发两个点 ───────────────
const justFour = {
  system: layoutSystemBlocks({ attribution: '', env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'zero', TZ: 'UTC' } })
    .map((text) => ({ type: 'text', text })),
  messages: [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
    { role: 'assistant', content: 'd' },
  ],
}
const fourResult = applyCacheBreakpoints(justFour)
console.log('\n── 对照组：4 条消息 ──')
console.log(`  system [${fourResult.system.join(', ')}]  messages [${fourResult.messages.join(', ')}]  合计 ${fourResult.total} 点`)
eq('4 条消息开始打两个 messages 断点', fourResult.messages, [0, 2])
eq('4 条消息总点数为 4', fourResult.total, 4)

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
