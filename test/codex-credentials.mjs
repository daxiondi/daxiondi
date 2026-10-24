/**
 * codex-credentials 与 Codex 配置项的单元测试。
 *
 * 覆盖：两种凭据形态、过期时间归一化、状态机档位、刷新注入点契约、
 * 以及 config.mjs 新增三个 Codex 配置项的缺省值与校验。
 *
 * 用法：node test/codex-credentials.mjs
 */

import {
  parseExpiry, singleAccountToAccount, isMultiAccountShape, parseCredentialText,
  loadCredentialFile, accountState, isUsable, checkAccounts, CredentialManager,
  EXPIRY_WARN_SECS, EXPIRY_CRITICAL_SECS,
} from '../src/codex-credentials.mjs'
import { validateCodexConfig, DEFAULT_WORKER_CONFIG } from '../src/config.mjs'

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const a = JSON.stringify(got); const b = JSON.stringify(want)
  if (a === b) { pass += 1; console.log('  ok   ', name) }
  else { fail += 1; console.log('  FAIL ', name, '\n    got ', a, '\n    want', b) }
}
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ok   ', name) }
  else { fail += 1; console.log('  FAIL ', name, detail === undefined ? '' : `\n    ${detail}`) }
}
const silentLogger = { warn() {}, info() {} }

// ═══════════════ 1. 时间归一化 ═══════════════

console.log('\n1. parseExpiry 时间归一化')

eq('ISO 字符串 → 秒', parseExpiry('2026-11-02T07:51:47+08:00'), 1793577107)
eq('UTC ISO → 秒', parseExpiry('1970-01-01T00:00:10Z'), 10)
eq('秒级数字原样', parseExpiry(1793577107), 1793577107)
eq('毫秒级数字降级到秒', parseExpiry(1793577107000), 1793577107)
eq('数字字符串当数字处理', parseExpiry('1793577107'), 1793577107)
eq('空串 → null', parseExpiry(''), null)
eq('null → null', parseExpiry(null), null)
eq('零 → null', parseExpiry(0), null)
eq('负数 → null', parseExpiry(-1), null)
eq('无法解析的字符串 → null', parseExpiry('not-a-date'), null)
eq('NaN → null', parseExpiry(NaN), null)

// ═══════════════ 2. 单账号形态 ═══════════════

console.log('\n2. 单账号 → Account 映射')

{
  const a = singleAccountToAccount({
    access_token: 'TOK',
    account_id: 'acct-1',
    expired: '2026-11-02T07:51:47+08:00',
    refresh_token: 'rt-1',
    id_token: 'id-1',
    email: 'x@y.z',
    type: 'codex',
  })
  eq('id 用 account_id', a.id, 'acct-1')
  eq('access_token 保留', a.access_token, 'TOK')
  eq('account_id → chatgpt_account_id', a.chatgpt_account_id, 'acct-1')
  eq('expired → expires_at（秒）', a.expires_at, 1793577107)
  eq('refresh_token 保留', a.refresh_token, 'rt-1')
  eq('id_token 保留', a.id_token, 'id-1')
  eq('缺省 rpm 是 null', a.rpm, null)
  eq('缺省 max_concurrency 是 null', a.max_concurrency, null)
}

{
  // account_id 缺失时回退 email，再回退 fallbackId
  const a = singleAccountToAccount({ access_token: 'T', email: 'e@x.y' })
  eq('无 account_id 时用 email 作 id', a.id, 'e@x.y')
  const b = singleAccountToAccount({ access_token: 'T' }, { fallbackId: 'fb' })
  eq('都没有时用 fallbackId', b.id, 'fb')
  const c = singleAccountToAccount({ access_token: 'T' })
  ok('最终兜底给随机 id', typeof c.id === 'string' && c.id.length > 0, c.id)
}

{
  let e = null
  try { singleAccountToAccount({ account_id: 'a' }) } catch (err) { e = err }
  ok('缺 access_token 抛错', e?.message.includes('access_token'), e?.message)

  e = null
  try { singleAccountToAccount({ access_token: 'T', account_id: 'a', disabled: true, email: 'x@y' }) } catch (err) { e = err }
  ok('disabled 账号抛错', e?.message.includes('disabled'), e?.message)
  ok('disabled 报错带 email 便于定位', e?.message.includes('x@y'), e?.message)
}

// ═══════════════ 3. 文件解析 ═══════════════

console.log('\n3. 凭据文件解析（两种形态）')

{
  const r = parseCredentialText(JSON.stringify({ access_token: 'T', account_id: 'a' }))
  eq('单账号识别为 single', r.shape, 'single')
  eq('单账号产出一条', r.accounts.length, 1)

  const m = parseCredentialText(JSON.stringify({ accounts: [{ id: 'x', access_token: 'T' }] }))
  eq('多账号识别为 multi', m.shape, 'multi')
  eq('多账号产出条数', m.accounts.length, 1)
}

{
  let e = null
  try { parseCredentialText('not json') } catch (err) { e = err }
  ok('非 JSON 抛错', e?.message.includes('not valid JSON'), e?.message)

  e = null
  try { parseCredentialText('[{"id":"x"}]') } catch (err) { e = err }
  ok('裸数组被拒', e?.message.includes('bare array'), e?.message)

  e = null
  try { parseCredentialText('null') } catch (err) { e = err }
  ok('null 被拒', e?.message.includes('object'), e?.message)
}

eq('isMultiAccountShape 认 accounts', isMultiAccountShape({ accounts: [] }), true)
eq('isMultiAccountShape 不认单账号', isMultiAccountShape({ access_token: 'T' }), false)
eq('isMultiAccountShape 拒绝裸数组', isMultiAccountShape([1]), false)

{
  const dir = await import('node:fs').then((m) => m.promises.mkdtemp('/tmp/codexcred-'))
  const path = `${dir}/c.json`
  await import('node:fs').then((m) => m.promises.writeFile(path, JSON.stringify({ access_token: 'T', account_id: 'a' })))
  const r = loadCredentialFile(path)
  eq('从文件加载', r.accounts.length, 1)
  eq('返回路径', r.path, path)

  let e = null
  try { loadCredentialFile('/nonexistent/x.json') } catch (err) { e = err }
  ok('文件缺失抛错', e?.message.includes('read credential file'), e?.message)

  // 空账号列表必须报错，不能静默返回 []
  const emptyPath = `${dir}/e.json`
  await import('node:fs').then((m) => m.promises.writeFile(emptyPath, '{"accounts":[]}'))
  e = null
  try { loadCredentialFile(emptyPath) } catch (err) { e = err }
  ok('空账号列表抛错', e?.message.includes('no accounts'), e?.message)
}

// ═══════════════ 4. 状态机 ═══════════════

console.log('\n4. accountState 状态机')

const NOW = 1_800_000_000
eq('无 token → missing', accountState({ access_token: '' }, { now: NOW }), 'missing')
eq('无 expires_at → fresh', accountState({ access_token: 'T' }, { now: NOW }), 'fresh')
eq('到期很远 → fresh', accountState({ access_token: 'T', expires_at: NOW + 86400 }, { now: NOW }), 'fresh')
eq('1 小时内 → refreshable',
  accountState({ access_token: 'T', expires_at: NOW + EXPIRY_WARN_SECS - 1 }, { now: NOW }), 'refreshable')
eq('恰好 1 小时 → fresh',
  accountState({ access_token: 'T', expires_at: NOW + EXPIRY_WARN_SECS }, { now: NOW }), 'fresh')
eq('5 分钟内 → refresh_window',
  accountState({ access_token: 'T', expires_at: NOW + EXPIRY_CRITICAL_SECS - 1 }, { now: NOW }), 'refresh_window')
eq('已过期有 refresh → expired_refreshable',
  accountState({ access_token: 'T', expires_at: NOW - 1, refresh_token: 'rt' }, { now: NOW }), 'expired_refreshable')
eq('已过期无 refresh → expired',
  accountState({ access_token: 'T', expires_at: NOW - 1 }, { now: NOW }), 'expired')

eq('阈值常量 1 小时', EXPIRY_WARN_SECS, 3600)
eq('临界阈值 5 分钟', EXPIRY_CRITICAL_SECS, 300)

eq('fresh 可用', isUsable({ access_token: 'T', expires_at: NOW + 86400 }, { now: NOW }), true)
eq('expired 不可用', isUsable({ access_token: 'T', expires_at: NOW - 1 }, { now: NOW }), false)
eq('missing 不可用', isUsable({}, { now: NOW }), false)
eq('expired_refreshable 仍算可用（可救）',
  isUsable({ access_token: 'T', expires_at: NOW - 1, refresh_token: 'rt' }, { now: NOW }), true)

{
  const { warnings, usable } = checkAccounts([
    { id: 'a', access_token: 'T', expires_at: NOW + 86400 },
    { id: 'b', access_token: 'T', expires_at: NOW + 600 },
    { id: 'c', access_token: 'T', expires_at: NOW - 10 },
  ], { now: NOW })
  eq('fresh 无告警', warnings.some((w) => w.id === 'a'), false)
  eq('快到期有告警', warnings.find((w) => w.id === 'b')?.state, 'refreshable')
  eq('告警带剩余秒数', warnings.find((w) => w.id === 'b')?.seconds_left, 600)
  eq('过期账号进告警', warnings.find((w) => w.id === 'c')?.state, 'expired')
  eq('可用账号只两个', usable.map((a) => a.id), ['a', 'b'])
}

// ═══════════════ 5. CredentialManager 与刷新注入点 ═══════════════

console.log('\n5. CredentialManager 刷新注入点')

{
  let clock = NOW
  const mgr = new CredentialManager(
    [{ id: 'a', access_token: 'OLD', expires_at: NOW + 86400, refresh_token: 'rt' }],
    { now: () => clock, logger: silentLogger },
  )
  eq('未注入 refreshFn 时 canRefresh 为 false', mgr.canRefresh, false)
  eq('fresh 账号原样返回', (await mgr.ensureFresh('a')).access_token, 'OLD')

  clock = NOW + 100000 // 过期
  let e = null
  try { await mgr.ensureFresh('a') } catch (err) { e = err }
  eq('无 refreshFn 时过期抛 needs_refresh', e?.code, 'needs_refresh')
  ok('错误信息说明需要 PKCE', e?.message.includes('PKCE'), e?.message)

  e = null
  try { await mgr.ensureFresh('nope') } catch (err) { e = err }
  eq('未知账号抛 unknown_account', e?.code, 'unknown_account')
}

{
  let clock = NOW
  const calls = []
  const mgr = new CredentialManager(
    [{ id: 'a', access_token: 'OLD', expires_at: NOW + 10, refresh_token: 'rt-old' }],
    {
      now: () => clock,
      logger: silentLogger,
      refreshFn: async (acc) => {
        calls.push(acc.id)
        return { access_token: 'NEW', refresh_token: 'rt-new', expires_at: clock + 86400 }
      },
    },
  )
  eq('注入后 canRefresh 为 true', mgr.canRefresh, true)
  const acc = await mgr.ensureFresh('a')
  eq('refreshFn 被调用', calls, ['a'])
  eq('账号拿到新 token', acc.access_token, 'NEW')
  eq('refresh_token 被轮换', acc.refresh_token, 'rt-new')
  eq('expires_at 被更新', acc.expires_at, clock + 86400)
  eq('快照反映新状态', mgr.snapshot()[0].state, 'fresh')
  // 已经 fresh 了，再调不应重复刷新
  await mgr.ensureFresh('a')
  eq('fresh 时不重复刷新', calls.length, 1)
}

{
  // refreshFn 返回非法值必须抛，不能把空 token 写进账号
  const mgr = new CredentialManager(
    [{ id: 'a', access_token: 'OLD', expires_at: NOW - 1 }],
    { now: () => NOW, logger: silentLogger, refreshFn: async () => ({ access_token: '' }) },
  )
  let e = null
  try { await mgr.ensureFresh('a') } catch (err) { e = err }
  eq('refreshFn 返回空 token 抛 refresh_failed', e?.code, 'refresh_failed')
  eq('账号 token 未被写坏', mgr.accounts[0].access_token, 'OLD')

  e = null
  const mgr2 = new CredentialManager(
    [{ id: 'a', access_token: 'OLD', expires_at: NOW - 1 }],
    { now: () => NOW, logger: silentLogger, refreshFn: async () => null },
  )
  try { await mgr2.ensureFresh('a') } catch (err) { e = err }
  eq('refreshFn 返回 null 也抛', e?.code, 'refresh_failed')
}

{
  // refreshFn 自己抛错：异常必须冒泡，账号保持原状
  const mgr = new CredentialManager(
    [{ id: 'a', access_token: 'OLD', expires_at: NOW - 1 }],
    { now: () => NOW, logger: silentLogger, refreshFn: async () => { throw new Error('oidc said no') } },
  )
  let e = null
  try { await mgr.ensureFresh('a') } catch (err) { e = err }
  ok('refreshFn 抛错时异常冒泡', e?.message === 'oidc said no', e?.message)
  eq('失败后 token 未变', mgr.accounts[0].access_token, 'OLD')
}

{
  let threw = null
  try { new CredentialManager([], { logger: silentLogger }) } catch (e) { threw = e }
  ok('空账号列表构造即抛错', threw?.message.includes('at least one account'), threw?.message)
}

{
  const mgr = new CredentialManager(
    [{ id: 'a', access_token: 'T', expires_at: NOW + 100, refresh_token: 'rt' }],
    { now: () => NOW, logger: silentLogger },
  )
  const snap = mgr.snapshot()
  eq('快照字段 id', snap[0].id, 'a')
  eq('快照 remaining', snap[0].seconds_left, 100)
  ok('快照不暴露 token', !JSON.stringify(snap).includes('"T"'), JSON.stringify(snap))
  eq('快照标记有 refresh_token', snap[0].has_refresh_token, true)
}

// ═══════════════ 6. 配置项 ═══════════════

console.log('\n6. Codex 配置项缺省值与校验')

eq('codex_credential_path 缺省空串', DEFAULT_WORKER_CONFIG.codex_credential_path, '')
eq('codex_base_url 缺省', DEFAULT_WORKER_CONFIG.codex_base_url, 'https://chatgpt.com/backend-api/codex')
eq('codex_default_model 缺省', DEFAULT_WORKER_CONFIG.codex_default_model, 'gpt-6-astra')
eq('codex_models 九项', DEFAULT_WORKER_CONFIG.codex_models.length, 9)
ok('codex_models 含缺省模型', DEFAULT_WORKER_CONFIG.codex_models.includes('gpt-6-astra'))

{
  const c = validateCodexConfig({})
  eq('空配置也能过校验', c.codex_default_model, 'gpt-6-astra')
  eq('空配置保留 base_url', c.codex_base_url, 'https://chatgpt.com/backend-api/codex')

  let e = null
  try { validateCodexConfig({ codex_base_url: 'http://chatgpt.com/backend-api/codex' }) } catch (err) { e = err }
  ok('http 被拒', e?.message.includes('must use https'), e?.message)

  e = null
  try { validateCodexConfig({ codex_base_url: 'https://evil.example.com/x' }) } catch (err) { e = err }
  ok('非 chatgpt.com host 被拒', e?.message.includes('chatgpt.com'), e?.message)

  e = null
  try { validateCodexConfig({ codex_base_url: 'not a url' }) } catch (err) { e = err }
  ok('非法 URL 被拒', e?.message.includes('must use https'), e?.message)

  e = null
  try { validateCodexConfig({ codex_default_model: 'gpt-5.1-codex' }) } catch (err) { e = err }
  ok('不支持的模型名被拒', e?.message.includes('must be one of'), e?.message)

  e = null
  try { validateCodexConfig({ codex_default_model: '' }) } catch (err) { e = err }
  ok('空模型名被拒', e?.message.includes('required'), e?.message)

  // 尾斜杠规范化
  eq('尾斜杠被去掉',
    validateCodexConfig({ codex_base_url: 'https://chatgpt.com/backend-api/codex/' }).codex_base_url,
    'https://chatgpt.com/backend-api/codex')

  eq('合法模型名通过', validateCodexConfig({ codex_default_model: 'gpt-6-luna' }).codex_default_model, 'gpt-6-luna')
  eq('credential_path 保留',
    validateCodexConfig({ codex_credential_path: '/tmp/c.json' }).codex_credential_path, '/tmp/c.json')

  e = null
  try { validateCodexConfig({ codex_credential_path: 123 }) } catch (err) { e = err }
  ok('非字符串 credential_path 被拒', e?.message.includes('must be a string'), e?.message)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
