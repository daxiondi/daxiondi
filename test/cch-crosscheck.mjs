// cch 与上游实现逐字节比对
//
// test/fixtures/official-cch.mjs 是与上游实现对齐的对照版本。
// 本测试通过，说明 cch 计算与上游逐字节一致。
//
// 跑法：node test/cch-crosscheck.mjs

import { projectBillingFields, computeClaudeCodeCch, xxh64, CCH_XXH64_SEED } from '../src/cch.mjs'
import { projectForCch } from './fixtures/official-cch.mjs'

let pass = 0
let fail = 0

function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1
    console.log(`  ok    ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}`)
    console.log(`        得到 ${JSON.stringify(got)}`)
    console.log(`        期望 ${JSON.stringify(want)}`)
  }
}

// 覆盖各种边界的请求体
const CASES = [
  ['最简单', { model: 'claude-sonnet-5-5', max_tokens: 1000, messages: [{ role: 'user', content: 'hi' }] }],
  ['带 billing header', {
    model: 'claude-opus-5-5',
    max_tokens: 8192,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296; cch=abcde;' }],
    messages: [],
  }],
  ['带 fallbacks + credit_token', {
    model: 'claude-sonnet-5-5',
    max_tokens: 500,
    fallbacks: [{ a: 1 }, { b: '[x]' }],
    fallback_credit_token: 'tok123',
    messages: [],
  }],
  ['model 出现在字符串值里', {
    messages: [{ content: 'a"model":"fake' }],
    model: 'm',
    max_tokens: 9,
  }],
  ['max_tokens 是字符串（不该被切）', { model: 'm', max_tokens: 'not_a_number', messages: [] }],
  ['model 带反斜杠和引号', { model: 'a\\b"c', messages: [], max_tokens: 1 }],
  ['1h 缓存 + fallbacks=default', {
    model: 'x',
    messages: [{ content: [{ cache_control: { ttl: '1h' } }] }],
    fallbacks: 'default',
  }],
  ['嵌套 fallbacks 带方括号字符串', {
    model: 'x',
    max_tokens: 100,
    fallbacks: [{ note: 'has ] inside' }],
    messages: [],
  }],
  ['cch 已是 00000', {
    model: 'x',
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=00000;' }],
    messages: [],
  }],
  ['多个 model 键（嵌套）', {
    model: 'outer',
    messages: [{ role: 'user', content: 'x', model: 'inner' }],
    max_tokens: 10,
  }],
]

// 只投影首个 canonical system billing block —— messages 里的 billing 示例不能被改
// （这类示例在真实请求里很常见：用户贴日志、示例请求体等）
const BILLING_DEMO = 'x-anthropic-billing-header: cc_version=9.9.9; cch=fffff;'
const BILLING_REAL = 'x-anthropic-billing-header: cc_version=2.1.296; cch=abcde;'

console.log('billing block 定位（messages 里的示例不能被改写）\n')
{
  const sysAfter = JSON.stringify({
    model: 'm', max_tokens: 100,
    system: [{ type: 'text', text: BILLING_REAL }],
    messages: [{ role: 'user', content: BILLING_DEMO }],
  })
  const out = projectBillingFields(sysAfter)
  eq('messages 排在 system 后：真计费头归零', /2\.1\.296; cch=00000/.test(out), true)
  eq('messages 排在 system 后：示例不被改', /9\.9\.9; cch=fffff/.test(out), true)

  const sysBefore = JSON.stringify({
    messages: [{ role: 'user', content: BILLING_DEMO }],
    model: 'm', max_tokens: 100,
    system: [{ type: 'text', text: BILLING_REAL }],
  })
  const out2 = projectBillingFields(sysBefore)
  eq('messages 排在 system 前：真计费头归零', /2\.1\.296; cch=00000/.test(out2), true)
  eq('messages 排在 system 前：示例不被改', /9\.9\.9; cch=fffff/.test(out2), true)

  const onlyDemo = JSON.stringify({
    model: 'm', max_tokens: 100,
    messages: [{ role: 'user', content: BILLING_DEMO }],
  })
  eq('没有 system 时退回整段首个',
     /9\.9\.9; cch=00000/.test(projectBillingFields(onlyDemo)), true)
}

console.log('\ncch 投影：本实现 vs 上游实现\n')
for (const [name, obj] of CASES) {
  const text = JSON.stringify(obj)
  eq(name, projectBillingFields(text), projectForCch(text))
}

console.log('\ncch 值：两边哈希应相同\n')
for (const [name, obj] of CASES) {
  const text = JSON.stringify(obj)
  // 上游算法：先投影再算 xxh64 取低 20 bit
  // 上游算法：对「投影后的字节」做 xxh64，取低 20 bit
  const officialCch = (xxh64(Buffer.from(projectForCch(text), 'utf8'), CCH_XXH64_SEED) & 0xfffffn)
    .toString(16)
    .padStart(5, '0')
  const mineCch = computeClaudeCodeCch(Buffer.from(projectBillingFields(text), 'utf8'))
  eq(`${name} 的 cch`, mineCch, officialCch)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
