/**
 * billing 头交叉验证：我们 vs 官方 v1.3.220。
 *
 * 为什么这是最重要的一条：billing 头是上游判断"是不是官方客户端"的
 * 第一手依据。它的**字段集合、字段顺序、每个字段的取值**都必须一致。
 *
 * 实测发现我们有三处偏差（已修）：
 *   1. 多了 `prompt_version=<ver>` —— 官方 billing 里根本没这个字段
 *   2. cc_prompt_id 的 UUID 派生加了 `billing-prompt-id:` 前缀哈希 → 完全不同
 *   3. cc_prompt_id 变体位取单字符，官方取双字符
 *
 * 还有一处（defaultBillingHeader）只写裸版本号、缺 <ver>.<fp> 指纹尾缀。
 *
 * 这个测试逐字符比对，任何一处漂移都会失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OFFICIAL = path.resolve(HERE, '../../vm2api/src/lib/identity/crs-persona.mjs')
const OURS = path.resolve(HERE, '../src/system-layout.mjs')

if (!fs.existsSync(OFFICIAL)) {
  console.log('跳过：找不到官方 crs-persona.mjs（research/vm2api 不在 v1.3.220+）')
  console.log('通过 0 / 失败 0')
  process.exit(0)
}

const off = await import(`file://${OFFICIAL}`)
const ours = await import(`file://${OURS}`)

let pass = 0
const fails = []

function cmp(label, official, mine) {
  if (official === mine) { pass += 1; return }
  fails.push(label)
  console.log(`  FAIL  ${label}`)
  console.log(`        官方: ${official}`)
  console.log(`        我们: ${mine}`)
}

// 覆盖：短文本（不足 21 字节）、正常文本、自定义 sessionId、带/不带轮次索引、两个版本号
const CASES = [
  { text: 'hello world test', ver: '2.1.296', sid: '', idx: null, label: '常规文本' },
  { text: 'CALLER SYSTEM: answer in French.', ver: '2.1.296', sid: '', idx: null, label: '调用方 system 文本' },
  { text: 'a', ver: '2.1.296', sid: '', idx: null, label: '单字符（触发指纹补 0）' },
  { text: 'short', ver: '2.1.303', sid: '', idx: null, label: '303 档版本' },
  { text: 'x'.repeat(100), ver: '2.1.296', sid: '', idx: null, label: '长文本' },
  { text: '', ver: '2.1.296', sid: '', idx: null, label: '空文本' },
  { text: 'hello', ver: '2.1.296', sid: '11111111-2222-4333-8444-555555555555', idx: null, label: '给定 UUID sessionId' },
  { text: 'hello', ver: '2.1.296', sid: 'not-a-uuid', idx: null, label: '非 UUID sessionId' },
  { text: 'hello', ver: '2.1.296', sid: '', idx: { promptIndex: 0, turnIndex: 1 }, label: '轮次索引 0/1' },
  { text: 'hello', ver: '2.1.296', sid: '', idx: { promptIndex: 7, turnIndex: 12 }, label: '轮次索引 7/12' },
  { text: 'hello', ver: '2.1.296', sid: '', idx: { promptIndex: -1, turnIndex: 1 }, label: '非法负索引（应无 tail）' },
  { text: 'hello', ver: '2.1.296', sid: '', idx: { promptIndex: 1 }, label: '缺 turnIndex（应无 tail）' },
]

console.log('=== billing 头逐字符比对 ===\n')
for (const c of CASES) {
  const official = off.buildBillingAttributionText(c.text, c.ver, c.sid, c.idx)
  const mine = ours.buildBillingAttribution({
    firstUserText: c.text,
    cliVersion: c.ver,
    sessionId: c.sid,
    promptIndex: c.idx?.promptIndex,
    turnIndex: c.idx?.turnIndex,
  })
  cmp(c.label, official, mine)
}

// 结构性断言：不能被"两边都错"骗过
console.log('\n=== 结构性断言 ===\n')
{
  const b = ours.buildBillingAttribution({ firstUserText: 'hello', cliVersion: '2.1.296' })
  const ok1 = /^x-anthropic-billing-header: /.test(b)
  if (ok1) pass += 1; else { fails.push('前缀'); console.log('  FAIL  缺前缀') }

  const ok2 = /cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3};/.test(b)
  if (ok2) pass += 1; else { fails.push('指纹尾缀'); console.log(`  FAIL  cc_version 缺指纹尾缀: ${b}`) }

  const ok3 = /cc_entrypoint=sdk-cli;/.test(b)
  if (ok3) pass += 1; else { fails.push('entrypoint'); console.log('  FAIL  cc_entrypoint 不是 sdk-cli') }

  const ok4 = /cc_prompt_id=[0-9a-f-]{36};/.test(b)
  if (ok4) pass += 1; else { fails.push('prompt_id'); console.log('  FAIL  cc_prompt_id 形态不对') }

  const ok5 = !b.includes('prompt_version')
  if (ok5) pass += 1; else { fails.push('多余字段'); console.log('  FAIL  含官方没有的 prompt_version') }

  // 轮次索引合法性
  const noTail = ours.buildBillingAttribution({ firstUserText: 'h', cliVersion: '2.1.296' })
  if (!noTail.includes('cc_turn_origin')) pass += 1
  else { fails.push('无索引却有 tail'); console.log('  FAIL  无索引仍写 turn tail') }
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) process.exit(1)
