#!/usr/bin/env node
/**
 * 多槽位 Codex 并发实测。
 *
 * 目的不是压测吞吐，而是验证三件事：
 *   1. 每个槽位容器都能独立经代理到达上游（不是只有 slot-01 能通）；
 *   2. 并发时调度器不会把同一个账号的并发打爆（上游按账号限流）；
 *   3. 失败能被正确归类（网络错 / 上游 4xx / 限流），而不是一律 timeout。
 *
 * 用法：
 *   node scripts/codex-fleet-check.mjs --credential config/codex-credential.json \
 *     --slots 20 --concurrency 5
 */
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const argv = process.argv.slice(2)
const arg = (n, d = null) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const credentialPath = arg('--credential', 'config/codex-credential.json')
const slotCount = Number(arg('--slots', '20'))
const concurrency = Number(arg('--concurrency', '5'))
const prompt = arg('--prompt', '回复两个字：通了')
const model = arg('--model', 'gpt-6-astra')
const timeoutMs = Number(arg('--timeout', '90000'))

const cred = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
const account = (cred.accounts || [])[0]
if (!account?.access_token) {
  console.error(`凭据里没有可用账号: ${credentialPath}`)
  process.exit(2)
}

// 请求体走文件传入，避免命令行转义把中文/引号吃掉
const reqPath = '/tmp/codex-fleet-req.json'
fs.writeFileSync(reqPath, JSON.stringify({
  model,
  stream: true,
  store: false,
  instructions: 'You are a helpful assistant.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
}))

const credInContainer = '/tmp/codex-fleet-cred.json'
fs.writeFileSync(credInContainer, JSON.stringify(account), { mode: 0o600 })

/** 在容器里跑一次请求，返回结构化结果。 */
async function runOne(slotId) {
  const container = `claude-slot-${slotId}`
  const t0 = Date.now()
  try {
    // token 与请求体先推进容器：容器里没有宿主文件系统
    await execFileAsync('docker', ['cp', credInContainer, `${container}:/tmp/c.json`], { timeout: 20_000 })
    await execFileAsync('docker', ['cp', reqPath, `${container}:/tmp/r.json`], { timeout: 20_000 })

    // 必须用换行拼装。
    // 之前用 join('') 拼成一行，`TOK=$(...)` 与后面的 curl 粘在一起，
    // shell 把整段当成一条命令，curl 根本没执行 —— 表现是 160ms 内
    // 以 000 失败，看起来像"网络不通"，实际是脚本自身的问题。
    const script = [
      'TOK=$(sed -n "s/.*\\"access_token\\":\\"\\{0,1\\}\\([^\\",]*\\).*/\\1/p" /tmp/c.json)',
      'AID=$(sed -n "s/.*\\"chatgpt_account_id\\":\\"\\{0,1\\}\\([^\\",]*\\).*/\\1/p" /tmp/c.json)',
      '[ -z "$AID" ] && AID=$(sed -n "s/.*\\"id\\":\\"\\{0,1\\}\\([^\\",]*\\).*/\\1/p" /tmp/c.json)',
      'if [ -z "$TOK" ]; then echo "NO_TOKEN" >&2; exit 3; fi',
      'curl -sS --max-time 60 -X POST "https://chatgpt.com/backend-api/codex/responses" \\',
      ' -H "authorization: Bearer $TOK" -H "chatgpt-account-id: $AID" \\',
      ' -H "content-type: application/json" -H "accept: text/event-stream" \\',
      ' --data-binary @/tmp/r.json -o /tmp/o.txt -w "%{http_code}"',
    ].join('\n')

    const { stdout } = await execFileAsync(
      'docker', ['exec', container, 'sh', '-c', script],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    )
    const status = String(stdout).trim().split('\n').pop() || '000'
    const elapsed = Date.now() - t0

    let text = ''
    let events = 0
    let streamError = ''
    try {
      const out = await execFileAsync('docker', ['exec', container, 'cat', '/tmp/o.txt'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })
      const body = String(out.stdout)
      for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const ev = JSON.parse(payload)
          events += 1
          if (ev.type === 'response.output_text.delta' && ev.delta) text += ev.delta
          // 上游过载时 HTTP 仍是 200，失败在流里。
          // 不抓这个的话，"200 + 无文本"会被误读成"我们的链路坏了"，
          // 实际是上游拒了 —— 两者的处理方式完全不同。
          if (ev.type === 'error' || ev.type === 'response.failed') {
            const e = ev.error || ev.response?.error || {}
            streamError = String(e.code || e.type || 'stream_failed')
          }
        } catch { /* 半行，跳过 */ }
      }
      if (status !== '200' && !text) text = body.slice(0, 160)
    } catch { /* 读不到输出不影响判定 */ }

    // 上游过载不算"链路失败"：链路是通的，是上游在限流。
    // 分出来单独统计，否则会以为部署有问题而去查代理。
    // 这些都属于"上游瞬时故障"：链路是通的，降并发或换号即可。
    // 不把它们归到过载类，就会被报成"上游拒绝"，让人去查请求体 —— 方向错了。
    const TRANSIENT = new Set([
      'server_is_overloaded', 'service_unavailable_error',
      'server_error', 'internal_error', 'overloaded_error',
    ])
    const overloaded = TRANSIENT.has(streamError)
    return {
      slotId,
      ok: status === '200' && text.length > 0,
      status, elapsed, events, text,
      streamError: streamError || null,
      overloaded,
      error: null,
    }
  } catch (error) {
    return {
      slotId, ok: false, status: '000', elapsed: Date.now() - t0, events: 0, text: '',
      error: String(error?.message || error).slice(0, 160),
    }
  }
}

/** 并发闸门：限制同时在跑的容器数，避免一次性打爆代理。 */
async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor
      cursor += 1
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

const slots = Array.from({ length: slotCount }, (_, i) => String(i + 1).padStart(2, '0'))
console.log('=== Codex 多槽位并发实测 ===')
console.log(`  账号: ${account.email || account.id}`)
console.log(`  模型: ${model}`)
console.log(`  槽位: ${slotCount}  并发: ${concurrency}`)
console.log('')

const t0 = Date.now()
const results = await pool(slots, concurrency, runOne)
const total = Date.now() - t0

const ok = results.filter((r) => r.ok)
const bad = results.filter((r) => !r.ok)

console.log('槽位   状态  HTTP   耗时      事件  文本')
console.log('────   ────  ────   ───────   ────  ────')
for (const r of results) {
  const line = [
    r.slotId.padEnd(6),
    r.ok ? 'ok  ' : 'FAIL',
    String(r.status).padEnd(6),
    `${r.elapsed}ms`.padEnd(9),
    String(r.events).padEnd(5),
    r.ok ? r.text.trim().replace(/\s+/g, ' ').slice(0, 24) : (r.error || r.text).slice(0, 40),
  ]
  console.log(line.join(' '))
}

console.log(`\n成功 ${ok.length} / 失败 ${bad.length} / 共 ${results.length}`)
if (ok.length) {
  const times = ok.map((r) => r.elapsed).sort((a, b) => a - b)
  const p50 = times[Math.floor(times.length * 0.5)]
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]
  console.log(`耗时: p50=${p50}ms  p95=${p95}ms  max=${times.at(-1)}ms  总墙钟=${total}ms`)
}

// 失败分类：三类，排查方向完全不同
if (bad.length) {
  const net = bad.filter((r) => r.status === '000')
  const overloaded = bad.filter((r) => r.status !== '000' && r.overloaded)
  const upstream = bad.filter((r) => r.status !== '000' && !r.overloaded)
  if (net.length) console.log(`\n网络类失败 ${net.length} 个（状态 000）：先查代理与 DNS`)
  if (overloaded.length) console.log(`上游过载 ${overloaded.length} 个（server_is_overloaded）：链路正常，是上游限流，需降低并发或加账号`)
  if (upstream.length) {
    console.log(`上游拒绝 ${upstream.length} 个：看响应体，可能是请求本身的问题`)
    // 只说"看响应体"等于没说 —— 现场早就没了。
    // 这里直接把每个的手上信息打出来，才能判断是账号、是模型、还是请求体。
    for (const r of upstream.slice(0, 5)) {
      // 非 200 时执行体被塞进了 text（见上面的 `if (status !== '200' && !text)`），
      // 所以拒绝详情要去 text 里看，不是单独一个 bodySnippet 字段。
      const bits = [
        `slot=${r.slotId}`,
        `status=${r.status}`,
        r.streamError ? `stream=${r.streamError}` : '',
        r.text ? `body=${String(r.text).slice(0, 160).replace(/\s+/g, ' ')}` : '',
      ].filter(Boolean)
      console.log(`    ${bits.join('  ')}`)
    }
  }
}

// 文本一致性：同一个 prompt 在多个槽位应得到同义回复（不要求逐字相同）
const texts = [...new Set(ok.map((r) => r.text.trim()))]
if (ok.length > 1) {
  console.log(`\n回复文本去重后 ${texts.length} 种: ${texts.slice(0, 4).join(' / ')}`)
}

process.exit(bad.length ? 1 : 0)
