#!/usr/bin/env node
/**
 * Token 刷新的完整闭环实测。
 *
 * 为什么必须做这个：「老掉登录状态」最常见的根因是 refresh_token 轮换没处理对。
 * 实测确认 Codex 的 OAuth 端点**每次刷新都会下发新的 refresh_token**，
 * 旧的立即作废。任何一处没把新值存回去，下一次刷新就是拿废 token 去换，
 * 必然 401 —— 表现就是"跑着跑着突然掉登录"。
 *
 * 这个脚本用一个真实的 refresh_token 走完整流程：
 *   1. 真的调上游 OAuth 端点
 *   2. 验证返回了新 access_token
 *   3. 验证 refresh_token 确实轮换了（这是关键，不是所有 OAuth 都轮换）
 *   4. 验证轮换后的新 token 被正确保存
 *   5. 用新 access_token 真的请求上游，确认可用
 *
 * 注意：这会消耗 refresh_token。旧的那个在刷新后立即失效，
 * 所以脚本会把新凭据写回原文件（这就是生产的正确行为）。
 *
 * 用法：
 *   node scripts/token-refresh-live.mjs --credential <path> [--no-write]
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
const has = (n) => argv.includes(n)
const credentialPath = path.resolve(arg('--credential', path.join(ROOT, 'config/codex-credential.json')))
const writeBack = !has('--no-write')

let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('=== Token 刷新完整闭环 ===\n')
console.log(`凭据: ${credentialPath}`)
console.log(`写回: ${writeBack ? '是（生产行为）' : '否（只读测试）'}\n`)

if (!fs.existsSync(credentialPath)) {
  console.error('凭据不存在')
  process.exit(2)
}
const before = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
const oldAccess = String(before.access_token || '')
const oldRefresh = String(before.refresh_token || '')
ok('有 access_token', oldAccess.length > 0, `${oldAccess.length} 字节`)
ok('有 refresh_token', oldRefresh.length > 0, `${oldRefresh.length} 字节`)

// ── 1. 真实调用上游 OAuth
console.log('\n[1] 调用上游 OAuth 端点')
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
const UA = 'codex_cli_rs/0.160.0 (linux x86_64)'

const t0 = Date.now()
let status = 0
let payload = null
try {
  const res = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
    },
    body: String(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: oldRefresh,
      client_id: CLIENT_ID,
      scope: SCOPE,
    })),
    signal: AbortSignal.timeout(30_000),
  })
  status = res.status
  const text = await res.text()
  if (status === 200) payload = JSON.parse(text)
  else console.log(`      响应: ${text.slice(0, 200)}`)
} catch (error) {
  ok('OAuth 请求完成', false, String(error?.message || error).slice(0, 100))
}
const elapsed = Date.now() - t0
ok('HTTP 200', status === 200, `status=${status}`)
console.log(`      耗时 ${elapsed}ms`)
if (!payload) {
  console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
  process.exit(1)
}

// ── 2. 新 access_token
console.log('\n[2] 新 access_token')
ok('返回了 access_token', Boolean(payload.access_token), `${(payload.access_token || '').length} 字节`)
ok('access_token 确实变了', payload.access_token !== oldAccess)
ok('expires_in 合理（> 1 小时）', Number(payload.expires_in) > 3600, `${payload.expires_in}s`)

// ── 3. refresh_token 轮换（关键）
console.log('\n[3] refresh_token 轮换')
const newRefresh = String(payload.refresh_token || '')
ok('返回了 refresh_token', newRefresh.length > 0, `${newRefresh.length} 字节`)
ok('refresh_token 已轮换（不是旧值）', newRefresh !== oldRefresh,
  newRefresh === oldRefresh ? '上游返回了相同的值 —— 那样"没存回去"就不会坏事' : '')
console.log('      → 这是「老掉登录」的根因：旧 refresh_token 在刷新瞬间失效，')
console.log('        不把新值存回去，下次刷新就是拿废 token 去换，必然 401')

ok('返回了 id_token', Boolean(payload.id_token))

// ── 4. 写回凭据（生产行为）
console.log('\n[4] 写回凭据')
const expMs = Number(payload.expires_in) > 0 ? Date.now() + Number(payload.expires_in) * 1000 : 0
const after = {
  ...before,
  access_token: payload.access_token,
  refresh_token: newRefresh || oldRefresh,
  id_token: payload.id_token || before.id_token,
  expired: expMs ? new Date(expMs).toISOString() : before.expired,
  last_refresh: new Date().toISOString(),
}

if (writeBack) {
  const tmp = `${credentialPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(after, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, credentialPath)
  ok('凭据已写回', true)
  const reread = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
  ok('重读 access_token 是新值', reread.access_token === payload.access_token)
  ok('重读 refresh_token 是新值', reread.refresh_token === (newRefresh || oldRefresh))
  ok('文件权限 0600', (fs.statSync(credentialPath).mode & 0o777) === 0o600,
    (fs.statSync(credentialPath).mode & 0o777).toString(8))
} else {
  console.log('      （--no-write，跳过写回）')
}

// ── 5. 新 token 真能用
console.log('\n[5] 用新 access_token 请求上游')
let upStatus = 0
let upHasDelta = false
let upOverloaded = false
try {
  const r = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${payload.access_token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': UA,
      originator: 'codex_cli_rs',
    },
    body: JSON.stringify({
      model: 'gpt-6-astra', stream: true, store: false,
      instructions: 'Reply exactly: ok',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ok' }] }],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  upStatus = r.status
  const text = await r.text()
  upHasDelta = /response\.output_text\.delta/.test(text)
  upOverloaded = /server_is_overloaded|service_unavailable/.test(text)
  if (r.status === 200 && !upHasDelta && !upOverloaded) {
    console.log(`      SSE 片段: ${text.slice(0, 200)}`)
  }
} catch (error) {
  console.log(`      异常: ${String(error?.message || error).slice(0, 100)}`)
}
ok('上游返回 200', upStatus === 200, `status=${upStatus}`)
if (upStatus === 200) {
  // 单账号在上游会间歇性过载（实测约 1/3）。这不是 token 的问题 ——
  // 刷新链路本身已经由前 4 组断言证明了。把过载算成硬失败会让这个
  // 脚本在验收里随机变红，那种噪声比漏检更糟。
  if (upOverloaded) {
    console.log('      ⊘ 上游瞬时过载 —— token 有效（能通过鉴权），跳过文本增量断言')
  } else {
    ok('拿到文本增量', upHasDelta, '')
  }
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n结论：刷新链路完整可用，refresh_token 轮换被正确处理并写回。')
