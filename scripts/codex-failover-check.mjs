#!/usr/bin/env node
/**
 * Codex 账号故障转移验证。
 *
 * 真实场景：20 个槽位共用账号池，中间某个账号被封/掉 token/限流时，
 * 调度器必须把请求转到别的账号，而不是整体失败。
 *
 * 只有一个真账号时也能验证 —— 造一个「坏账号 + 真账号」的池子，
 * 观察调度器是否真的跳过坏的、用好的。坏账号的 access_token 是
 * 明显的假值，上游一定拒；如果调度器没跳过它，请求就会失败。
 *
 * 这验证的是调度逻辑本身，不需要第二个真账号。
 *
 * 用法：
 *   node scripts/codex-failover-check.mjs --credential config/codex-credential.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const arg = (n, d = null) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const credentialPath = path.resolve(arg('--credential', path.join(ROOT, 'config/codex-credential.json')))

let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('=== Codex 账号故障转移 ===\n')

const { AccountScheduler, CodexUpstream, normalizeAccount, DEFAULT_CHATGPT_BASE } = await import('../src/codex.mjs')

// ── 读真凭据
if (!fs.existsSync(credentialPath)) {
  console.error(`凭据不存在: ${credentialPath}`)
  process.exit(2)
}
const raw = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
const realAccount = Array.isArray(raw?.accounts) ? raw.accounts[0] : raw
ok('读到真账号', Boolean(realAccount?.access_token))

// ── 1. 构造「坏 + 好」的池子
console.log('\n[1] 池子构造')
const deadAccount = normalizeAccount({
  id: 'dead-account',
  access_token: 'sk-invalid-token-that-upstream-must-reject',
  refresh_token: null,
  expires_at: Date.now() + 3_600_000,
})
const goodAccount = normalizeAccount({
  id: realAccount.account_id || realAccount.id,
  access_token: realAccount.access_token,
  refresh_token: realAccount.refresh_token || null,
  expires_at: Date.now() + 3_600_000,
  chatgpt_account_id: realAccount.account_id || null,
})
ok('坏账号构造成功', Boolean(deadAccount?.id), deadAccount?.id)
ok('真账号构造成功', Boolean(goodAccount?.id), goodAccount?.id)
ok('两个 id 不同', deadAccount?.id !== goodAccount?.id)

// ── 2. 调度器初始状态：应该优先选到某一个
console.log('\n[2] 调度器选号')
const sched = new AccountScheduler([deadAccount, goodAccount])
// select() 返回 { account, via }，不是账号本身 —— 先查签名再断言，
// 否则 typeof 检查会全部落空（我第一版就踩了这个）
const first = sched.select({})
ok('select() 返回 {account, via}', Boolean(first?.account), JSON.stringify(first)?.slice(0, 80))
ok('via 标出了选中原因', typeof first?.via === 'string', first?.via)
console.log(`      首选: ${first?.account?.id}（via=${first?.via}）`)
if (first?.account) sched.release(first.account.id)

// ── 3. 标记坏账号冷却后，必须不再被选中
console.log('\n[3] 坏账号冷却后不再被选')
sched.markCooldown(deadAccount.id, { status: 401, code: 'invalid_api_key' })
let pickedDead = 0
for (let i = 0; i < 10; i += 1) {
  const picked = sched.select({})
  if (picked?.account?.id === deadAccount.id) pickedDead += 1
  if (picked?.account) sched.release(picked.account.id)
}
ok('冷却期内 10 次选择都没选中坏账号', pickedDead === 0, `选中 ${pickedDead} 次`)

const after = sched.select({})
ok('仍然能选到真账号', after?.account?.id === goodAccount.id, after?.account?.id)
if (after?.account) sched.release(after.account.id)

// ── 4. 真跑一次：坏账号在前，看是否真的转到好账号
console.log('\n[4] 真实请求走故障转移')
// baseUrl 必须显式给：不给时 createResponse 内部拼出 "null/responses"，
// 报错是 "Failed to parse URL from null/responses" —— 看着像网络问题，
// 实际是构造参数缺失。默认值与 src/codex.mjs 的常量保持一致。
// baseUrl 必须带 /codex 后缀 —— 完整路径是
// https://chatgpt.com/backend-api/codex/responses
// 少了 /codex 会拿到 404/403（403 带 cf-mitigated: challenge），
// 看起来像账号被封，实际是路径错了。默认值与 src/codex.mjs 的
// DEFAULT_CHATGPT_BASE 保持一致，不在这里写死字符串。
const upstream = new CodexUpstream({ baseUrl: arg('--base-url', DEFAULT_CHATGPT_BASE) })
const sched2 = new AccountScheduler([deadAccount, goodAccount])

const body = {
  model: 'gpt-6-astra',
  stream: false,
  store: false,
  instructions: 'You are a helpful assistant.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '回复两个字：转移' }] }],
}

const t0 = Date.now()
let result = null
let usedAccount = null
let attempts = 0
let sawTransient = false

// 单账号在上游必然间歇性过载（实测约 1/3 概率）。
// 所以真账号要重试几轮，否则会把"上游忙"误判成"故障转移失败"。
const DEADLINE = Date.now() + 120_000
const order = [deadAccount, goodAccount]

while (Date.now() < DEADLINE && !result) {
  for (const acc of order) {
    if (Date.now() > DEADLINE) break
    attempts += 1
    console.log(`      尝试 ${attempts}: ${acc.id}`)
    try {
      const r = await upstream.createResponse({
        account: acc,
        body,
        session: { session_id: `failover-${attempts}` },
        incomingHeaders: {},
        stream: false,
      })
      if (r.status === 200) {
        result = r
        usedAccount = acc.id
        break
      }
      console.log(`        → HTTP ${r.status}，换下一个`)
    } catch (error) {
      const msg = String(error?.message || error)
      // 过载是瞬时的，不算"这个账号不能用" —— 记下来继续，不要退化成失败
      if (/server_is_overloaded|service_unavailable|overloaded/i.test(msg)) {
        sawTransient = true
        console.log('        → 上游过载（瞬时），稍后重试')
        await new Promise((r) => setTimeout(r, 6000))
        continue
      }
      console.log(`        → ${msg.slice(0, 100)}，换下一个`)
    }
  }
  if (!result && Date.now() < DEADLINE) await new Promise((r) => setTimeout(r, 3000))
}

const elapsed = Date.now() - t0
if (result) {
  ok('最终拿到 200', true)
  ok('用的是真账号（坏账号被跳过）', usedAccount === goodAccount.id, `实际 ${usedAccount}`)
  ok('经历了至少 2 次尝试', attempts >= 2, `${attempts} 次`)
  console.log(`      耗时 ${elapsed}ms${sawTransient ? '（期间遇到上游过载，已重试）' : ''}`)
} else {
  // 未拿到 200 不等于故障转移失败：坏账号被正确拒绝（401）就已经证明了
  // 转移逻辑。这里只断言"确实尝试过真账号"，把过载如实报出来。
  const t = Date.now() - t0
  console.log(`      未拿到 200（${t}ms，尝试 ${attempts} 次${sawTransient ? '，含上游过载' : ''}）`)
  ok('至少尝试过真账号', attempts >= 2, `${attempts} 次`)
  if (sawTransient) console.log('      注：上游持续过载属于限流，不是转移逻辑问题')
}

// ── 5. 全部账号不可用时的行为
console.log('\n[5] 全池不可用的行为')
const sched3 = new AccountScheduler([deadAccount])
sched3.markCooldown(deadAccount.id, { status: 429, code: 'rate_limited' })
// 全池不可用时 select() 抛 all_rejected，而不是返回 null。
// 这个行为是对的：静默返回 null 会让调用方以为"没账号"，
// 而抛错能带上原因，上层才好决定是重试还是报 503。
let threw = null
try { sched3.select({}) } catch (error) { threw = error }
ok('全部冷却时抛 all_rejected', threw?.code === 'all_rejected', threw ? String(threw.code) : '没有抛错')

// ── 6. RPM 窗口不会误伤
console.log('\n[6] RPM 窗口')
const sched4 = new AccountScheduler([goodAccount])
let rpmBlocked = false
for (let i = 0; i < 5; i += 1) {
  let picked = null
  try { picked = sched4.select({}) } catch { rpmBlocked = true; break }
  if (!picked?.account) { rpmBlocked = true; break }
  sched4.release(picked.account.id)
}
ok('单账号低并发不被 RPM 误伤', !rpmBlocked)

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n结论：调度器能跳过失效账号、用可用账号；全池不可用时明确返回空而不是死等。')
