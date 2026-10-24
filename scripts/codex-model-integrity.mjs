#!/usr/bin/env node
/**
 * 上游是否静默降级模型。
 *
 * "降智" 最直接的形式就是：请求 gpt-6-astra，上游给你 gpt-5.6 的结果。
 * 服务端不报错、额度照扣、回复也像模像样 —— 只有对比响应里的 model
 * 字段才能发现。
 *
 * 这个脚本对每个已启用的模型发一次最小请求，比对：
 *   1. 请求的 model
 *   2. 响应里 service_tier / model 字段回显的 model
 * 不一致就是降级。同时记录 service_tier，priority 与 default 是不同档位。
 *
 * 用法：
 *   node scripts/codex-model-integrity.mjs --credential <path> [--models a,b,c]
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
const modelList = (arg('--models', '') || '').split(',').map((x) => x.trim()).filter(Boolean)

let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('=== 模型身份一致性（检测静默降级）===\n')

if (!fs.existsSync(credentialPath)) {
  console.error(`凭据不存在: ${credentialPath}`)
  process.exit(2)
}

const { CodexUpstream, normalizeAccount, DEFAULT_CHATGPT_BASE } = await import('../src/codex.mjs')
const { collectResponsesStream } = await import('../src/codex-convert.mjs')

const raw = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
const a = Array.isArray(raw?.accounts) ? raw.accounts[0] : raw
const account = normalizeAccount({
  id: a.account_id || a.id,
  access_token: a.access_token,
  refresh_token: a.refresh_token || null,
  expires_at: Date.now() + 3_600_000,
  chatgpt_account_id: a.account_id || null,
})
ok('账号可构造', Boolean(account?.access_token))

// 默认测这几个：astra 是主力，sol/luna 是同代不同规格，用来确认
// "不同 model 真的返回不同 model"（如果全部回显同一个，说明忽略了入参）
const MODELS = modelList.length ? modelList : ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']
const upstream = new CodexUpstream({ baseUrl: DEFAULT_CHATGPT_BASE })

/** 发一次最小请求，返回 {requested, echoed, tier, ok, transient} */
async function probe(model) {
  const body = {
    model,
    stream: true,
    store: false,
    instructions: 'Reply with exactly: ok',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ok' }] }],
  }
  try {
    const r = await upstream.createResponse({
      account, body, session: { session_id: `integrity-${model}` }, incomingHeaders: {}, stream: true,
    })
    if (r.status !== 200) {
      const text = r.json ? JSON.stringify(r.json) : ''
      const transient = /overloaded|unavailable|rate/i.test(text) || r.status === 429
      return { requested: model, status: r.status, ok: false, transient, echoed: null, tier: null }
    }
    let echoed = null
    let tier = null
    try {
      const agg = await collectResponsesStream(upstream.iterEvents(r.stream))
      echoed = agg?.model || null
      tier = agg?.service_tier || agg?.metadata?.service_tier || null
    } catch (error) {
      const msg = String(error?.message || error)
      if (/overloaded|unavailable|rate/i.test(msg)) {
        return { requested: model, status: 200, ok: false, transient: true, echoed: null, tier: null }
      }
      return { requested: model, status: 200, ok: false, transient: false, echoed: null, tier: null, error: msg.slice(0, 100) }
    }
    return { requested: model, status: 200, ok: true, transient: false, echoed, tier }
  } catch (error) {
    const msg = String(error?.message || error)
    const transient = /overloaded|unavailable|rate|timeout/i.test(msg)
    return { requested: model, status: 'ERR', ok: false, transient, echoed: null, tier: null, error: msg.slice(0, 100) }
  }
}

const results = []
for (const model of MODELS) {
  console.log(`[${model}]`)
  // 上游间歇过载，每个模型重试到拿到一次干净结果或超时
  let r = null
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    r = await probe(model)
    if (r.ok || !r.transient) break
    console.log('      上游过载，6s 后重试')
    await new Promise((res) => setTimeout(res, 6000))
  }
  results.push(r)

  if (r.ok) {
    ok('请求成功', true)
    ok('响应回显了 model', Boolean(r.echoed), String(r.echoed))
    if (r.echoed) {
      // 核心断言：回显的 model 必须与请求的一致
      const same = String(r.echoed).toLowerCase() === model.toLowerCase()
      ok(`model 未被降级（请求 ${model}）`, same, `上游回显 ${r.echoed}`)
    }
    console.log(`      service_tier: ${r.tier ?? '(未回显)'}`)
  } else if (r.transient) {
    console.log('      ⊘ 持续过载，跳过（不是降级）')
  } else {
    ok('请求成功', false, `status=${r.status} ${r.error || ''}`)
  }
}

// ── 跨模型对比：不同 model 不该回显同一个值
console.log('\n[跨模型对比]')
const echoedSet = new Set(results.filter((r) => r.ok && r.echoed).map((r) => String(r.echoed).toLowerCase()))
const requestedSet = new Set(results.filter((r) => r.ok).map((r) => r.requested.toLowerCase()))
if (echoedSet.size > 0 && requestedSet.size > 1) {
  ok('不同请求 model 回显不同', echoedSet.size === requestedSet.size,
    `请求 ${requestedSet.size} 种，回显 ${echoedSet.size} 种：${[...echoedSet].join(',')}`)
} else {
  console.log('  ⊘ 有效样本不足，跳过跨模型对比')
}

const degraded = results.filter((r) => r.ok && r.echoed && String(r.echoed).toLowerCase() !== r.requested.toLowerCase())
console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (degraded.length) {
  console.log('\n⚠ 检测到降级：')
  for (const d of degraded) console.log(`  - 请求 ${d.requested} → 回显 ${d.echoed}`)
}
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n结论：请求的 model 与上游回显一致，未检测到静默降级。')
