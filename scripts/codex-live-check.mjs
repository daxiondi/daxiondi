#!/usr/bin/env node
/**
 * Codex 通道真实上游验证。
 *
 * 走的是内核形态：spawn 内核 → 打 /internal/v1/codex/responses → 上游。
 * 不是打 mock，也不是直连 codex-server，因此能同时验证「凭据可读」
 * 和「内核把 envelope 正确摊平成 codex 请求」这两件事。
 *
 * 用法：
 *   node scripts/codex-live-check.mjs --credential <path> [--model gpt-6-astra]
 *   node scripts/codex-live-check.mjs              # 用 SKYLINK_CODEX_CREDENTIAL
 *
 * 退出码：0 通 / 1 不通
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const credentialPath = arg('--credential') || process.env.SKYLINK_CODEX_CREDENTIAL || ''
const model = arg('--model') || 'gpt-6-astra'
const prompt = arg('--prompt') || '只回答两个字：通了'

if (!credentialPath || !fs.existsSync(credentialPath)) {
  console.error(`凭据文件不存在: ${credentialPath || '(未指定)'}`)
  console.error('用法: node scripts/codex-live-check.mjs --credential /path/to/credentials.json')
  process.exit(1)
}

// 凭据形状预检：字段类型错会在加载阶段整份列表变空，
// 表现是"所有请求突然没有可用账号"。先在这里点名，省得排查。
const raw = JSON.parse(fs.readFileSync(credentialPath, 'utf8'))
const accounts = Array.isArray(raw) ? raw : (raw.accounts || [raw])
if (!accounts.length) {
  console.error('凭据里没有任何账号')
  process.exit(1)
}
const a = accounts[0]
const problems = []
if (!a.id) problems.push('缺少 id（必填）')
if (typeof a.expires_at !== 'number') problems.push(`expires_at 必须是毫秒整数，当前 ${typeof a.expires_at}`)
if (!a.access_token) problems.push('缺少 access_token')
if (problems.length) {
  console.error('凭据字段有问题：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-'))
const socketPath = path.join(tmp, 'k.sock')
const token = 'live-' + Math.random().toString(16).slice(2, 14)
const kernelBin = path.resolve(new URL('../src/kernel/server.mjs', import.meta.url).pathname)

console.log('=== Codex 真实上游验证 ===')
console.log(`  凭据: ${credentialPath}`)
console.log(`  账号: ${String(a.id).slice(0, 12)}…  到期 ${new Date(a.expires_at).toISOString().slice(0, 10)}`)
console.log(`  模型: ${model}`)
console.log('')

const kernel = spawn(
  process.execPath,
  [kernelBin, '-socket', socketPath, '-token', token],
  {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      KERNEL_CODEX_CREDENTIAL_PATH: credentialPath,
      KERNEL_CODEX_MODEL: model,
    },
  },
)
let kernelErr = ''
kernel.stderr.on('data', (c) => { kernelErr += c })

const waitSock = async (ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return true
    await new Promise((r) => setTimeout(r, 80))
  }
  return false
}

const cleanup = () => { try { kernel.kill('SIGKILL') } catch {} try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} }

if (!(await waitSock(8000))) {
  console.error('内核没有起来')
  if (kernelErr) console.error(kernelErr.slice(0, 400))
  cleanup()
  process.exit(1)
}

const post = (bodyObj) => new Promise((resolve) => {
  const payload = Buffer.from(JSON.stringify(bodyObj))
  const req = http.request(
    {
      socketPath,
      path: '/internal/v1/codex/responses',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        'x-kin-internal-token': token,
      },
    },
    (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    },
  )
  req.on('error', (e) => resolve({ status: 0, text: String(e.message) }))
  req.end(payload)
})

const t0 = Date.now()
const r = await post({
  body: {
    model,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    stream: true,
  },
  stream: true,
  request_id: 'live-check-1',
})
const elapsed = Date.now() - t0

const events = [...r.text.matchAll(/^event: ([a-z._]+)$/gm)].map((m) => m[1])
const texts = [...r.text.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1]).filter(Boolean)
const answer = texts.length ? texts[texts.length - 1] : ''

console.log(`HTTP ${r.status}  ${elapsed}ms`)
console.log(`SSE 事件数: ${events.length}`)
if (events.length) {
  const counts = {}
  for (const e of events) counts[e] = (counts[e] || 0) + 1
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k} × ${v}`)
}
console.log(`回复文本: ${answer || '(空)'}`)
console.log('')

cleanup()

const okStatus = r.status === 200
const okEvents = events.includes('response.created') && events.some((e) => e === 'response.output_text.delta' || e === 'response.output_text.done')
const okText = answer.length > 0

if (okStatus && okEvents && okText) {
  console.log('结论：Codex 通道通到真实上游，内核 envelope 正确摊平。')
  process.exit(0)
}
console.log('结论：未通过')
if (!okStatus) console.log(`  - 状态码 ${r.status}`)
if (!okEvents) console.log(`  - SSE 事件序列不完整: ${events.slice(0, 5).join(', ')}`)
if (!okText) console.log('  - 没拿到回复文本')
if (r.status !== 200) console.log('  响应片段: ' + r.text.slice(0, 300))
process.exit(1)
