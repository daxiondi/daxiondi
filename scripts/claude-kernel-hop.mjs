#!/usr/bin/env node
/**
 * 验证内核的 Claude 通道（/internal/v1/messages）全链路可用。
 *
 * 没有真实 Claude 凭据时，用 test/fixtures 里的假 CLI 驱动：
 * 它按 frames.mjs 的协议版本 2 回帧，能覆盖
 *   控制面 → 内核 → CLI 帧往返 → SSE 回传
 * 这一整段。唯一不覆盖的是「内核 → api.anthropic.com」那最后一跳
 * （那需要真 token，且是上游的事，不是我们代码的正确性）。
 *
 * 目的：证明除真上游之外的所有环节都是通的 —— 拿到真 token 时不需要再调代码。
 *
 * 用法：
 *   node scripts/claude-kernel-hop.mjs [--slots 4] [--stream]
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const arg = (n, d = null) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const has = (n) => argv.includes(n)
const number = (n, d) => {
  const v = Number(arg(n))
  return Number.isFinite(v) && v > 0 ? v : d
}

const slots = number('--slots', 4)
const wantStream = has('--stream')
const runDir = arg('--run-dir', '/tmp/live-api-claude-hop')
const token = 'c'.repeat(48)

let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('=== 内核 Claude 通道全链路（假 CLI）===')
console.log(`  槽位: ${slots}   响应: ${wantStream ? 'stream' : 'json'}`)
console.log('')

fs.rmSync(runDir, { recursive: true, force: true })
fs.mkdirSync(runDir, { recursive: true })
const sockPath = path.join(runDir, 'api-kernel.sock')
const credentialPath = path.join(runDir, 'claude-cred.json')
const configPath = path.join(runDir, 'kernel-config.json')
const cliLogPath = path.join(runDir, 'fake-cli.log')

// 凭据必须是 fresh，否则 /internal/v1/messages 会先被 needs_refresh 拦掉
fs.writeFileSync(credentialPath, JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-fake-hop', expiresAt: Date.now() + 3_600_000 },
}), { mode: 0o600 })

const fakeCli = path.join(ROOT, 'test/fixtures/fake-cli.mjs')
if (!fs.existsSync(fakeCli)) {
  console.error(`假 CLI 不存在: ${fakeCli}`)
  process.exit(2)
}
const stagedCli = path.join(runDir, 'fake-cli.mjs')
fs.copyFileSync(fakeCli, stagedCli)
fs.chmodSync(stagedCli, 0o755)

fs.writeFileSync(configPath, JSON.stringify({
  vm_id: 'claude-hop',
  socket_path: sockPath,
  credential_path: credentialPath,
  internal_token: token,
  provider: 'local_cli',
  claude_bin: stagedCli,
  slots_per_worker: slots,
  // 显式用 cli_env 传假 CLI 的开关，不依赖 process.env 的隐式继承。
  // 之前只靠 spawn 的 env 传，看着应该能透传（SlotScheduler 里是 ...process.env），
  // 但实测假 CLI 收不到 FAKE_CLI_LOG —— 日志文件只有 host_ready/slot_ready，
  // 没有 job_start。而用 stdin 探针证明内核确实发出了 job_start。
  // 显式写在配置里就不必再猜继承链了。
  cli_env: {
    FAKE_CLI_LOG: cliLogPath,
    FAKE_CLI_SLOTS: String(slots),
  },
}, null, 2))

const child = spawn('node', [
  path.join(ROOT, 'src/kernel/server.mjs'),
  '-socket', sockPath,
  '-token', token,
  '-config', configPath,
], {
  cwd: ROOT,
  env: {
    ...process.env,
    CLAUDE_BIN: stagedCli,
    FAKE_CLI_SLOTS: String(slots),
    FAKE_CLI_LOG: cliLogPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let kernelLog = ''
child.stdout.on('data', (d) => { kernelLog += d.toString() })
child.stderr.on('data', (d) => {
  const s = d.toString()
  if (!/UNDICI|trace-warn|ExperimentalWarning/.test(s)) kernelLog += s
})

const waitFor = async (fn, { timeout = 25_000, step = 100 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return false
}

/** 走 Unix socket 发一个 HTTP 请求，返回 {status, headers, body}。 */
function request(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
    const headers = {
      host: 'localhost',
      'x-internal-token': token,
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      ...extraHeaders,
      connection: 'close',
    }
    const socket = net.connect(sockPath, () => {
      const head = [`${method} ${urlPath} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n')
      socket.write(head + payload)
    })
    const chunks = []
    socket.on('data', (c) => {
      chunks.push(c)
      // SSE 响应是 chunked + keep-alive：内核不会因为 connection: close
      // 就关掉连接（那样会把还在传的流截断），必须自己认 chunked 终止符。
      const raw = Buffer.concat(chunks).toString('utf8')
      // chunked 的终止是 `\r\n0\r\n`，后面可能还跟 trailer（内核会补
      // x-kin-usage / x-kin-model / x-terminal-state）。
      // 所以不能死等 `0\r\n\r\n` —— 有 trailer 时那个序列根本不出现，
      // 连接靠 keep-alive 撑着，测试会一直等到超时。
      if (/\r\n0\r\n/.test(raw)) socket.end()
    })
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const idx = raw.indexOf('\r\n\r\n')
      const head = idx >= 0 ? raw.slice(0, idx) : raw
      const rest = idx >= 0 ? raw.slice(idx + 4) : ''
      const status = Number((head.match(/^HTTP\/1\.[01] (\d+)/) || [])[1] || 0)
      const hdrs = {}
      for (const line of head.split('\r\n').slice(1)) {
        const i = line.indexOf(':')
        if (i > 0) hdrs[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
      }
      // chunked 解码
      let text = rest
      if (String(hdrs['transfer-encoding'] || '').includes('chunked')) {
        let out = ''
        let p = rest
        while (true) {
          const nl = p.indexOf('\r\n')
          if (nl < 0) break
          const size = parseInt(p.slice(0, nl), 16)
          if (!Number.isFinite(size) || size === 0) break
          out += p.slice(nl + 2, nl + 2 + size)
          p = p.slice(nl + 2 + size + 2)
        }
        text = out
      }
      resolve({ status, headers: hdrs, body: text })
    })
    socket.on('error', reject)
    socket.setTimeout(60_000, () => { socket.destroy(); reject(new Error('socket timeout')) })
  })
}

// ── 1. 内核起来 + CLI 真的被拉起
console.log('[1] 内核与 CLI 宿主')
const appeared = await waitFor(() => fs.existsSync(sockPath))
ok('内核 socket 已出现', appeared, sockPath)
if (!appeared) {
  console.log(`\n内核日志:\n${kernelLog.trim().split('\n').slice(-15).join('\n')}`)
  child.kill('SIGKILL')
  process.exit(1)
}

// 等 CLI 报告 slot_ready（假 CLI 是立即回的）
const readyOk = await waitFor(async () => {
  try {
    const r = await request('GET', '/internal/health')
    const j = JSON.parse(r.body || '{}')
    return Number(j.ready_slots) > 0
  } catch { return false }
})
ok('health 报告 ready_slots > 0', readyOk)

const health = await request('GET', '/internal/health')
const h = JSON.parse(health.body || '{}')
ok('health ok 为 true', h.ok === true, JSON.stringify(h).slice(0, 200))
ok('engine 是 rust', h.engine === 'rust', h.engine)
ok('cli_pid 非空（假 CLI 真被拉起）', h.cli_pid != null, String(h.cli_pid))
ok('ready_slots 等于配置的槽位数', Number(h.ready_slots) === slots, `got ${h.ready_slots} want ${slots}`)

// ── 2. 鉴权
console.log('\n[2] 内部 token 鉴权')
const noTok = await request('GET', '/internal/health', undefined, { 'x-internal-token': '' })
ok('缺 token → 401', noTok.status === 401, `status=${noTok.status}`)
const badTok = await request('GET', '/internal/health', undefined, { 'x-internal-token': 'wrong' })
ok('错 token → 401', badTok.status === 401, `status=${badTok.status}`)

// ── 3. 发一次真实的 messages 请求（走假 CLI 的帧往返）
console.log('\n[3] POST /internal/v1/messages')
// stream 在 envelope 顶层，不在 body 里。
// 契约见 contract.mjs：内核按 envelope.stream 决定走 SSE 还是聚合 JSON。
// 放进 body 的话 body.stream 会被原样转给上游（无害），
// 但内核自己的 collector 拿到 `undefined === true` → false，
// 于是按非流式处理、跳过事件采集，最终 content 是空文本而 usage 正常。
// 这个错误形态很有迷惑性：状态 200、结构完整、只有 text 是空串。
const envelope = {
  request_id: '11111111-2222-3333-4444-555555555555',
  stream: wantStream,
  body: {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 64,
    messages: [{ role: 'user', content: '回复两个字：通道' }],
  },
  session: { session_id: 'sess-hop-1' },
}
const t0 = Date.now()
let res
try {
  res = await request('POST', '/internal/v1/messages', envelope)
} catch (error) {
  ok('messages 请求返回', false, String(error?.message || error).slice(0, 160))
}
if (res) {
  const elapsed = Date.now() - t0
  ok('status 2xx', res.status >= 200 && res.status < 300, `status=${res.status} body=${res.body.slice(0, 200)}`)
  if (res.status >= 200 && res.status < 300) {
    if (wantStream) {
      ok('content-type 是 event-stream', String(res.headers['content-type'] || '').includes('event-stream'),
        res.headers['content-type'])
      ok('SSE 含 message_start', res.body.includes('message_start'))
      ok('SSE 含 message_stop', res.body.includes('message_stop'))
      const text = (res.body.match(/"text":"([^"]*)"/g) || []).join(' ')
      ok('SSE 里有文本增量', text.length > 0, text.slice(0, 120))
    } else {
      let json = null
      try { json = JSON.parse(res.body) } catch { /* 非 JSON */ }
      ok('响应是 JSON', json !== null, res.body.slice(0, 160))
      ok('type 是 message', json?.type === 'message', json?.type)
      ok('有 content 数组', Array.isArray(json?.content) && json.content.length > 0, JSON.stringify(json?.content)?.slice(0, 120))
      const text = (json?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
      ok('拿到文本', text.length > 0, text.slice(0, 80))
      if (text) console.log(`      文本: ${text.slice(0, 60)}`)
      ok('有 usage', Boolean(json?.usage), JSON.stringify(json?.usage)?.slice(0, 120))
    }
  }
  console.log(`      耗时: ${elapsed}ms`)
}

// ── 4. 帧日志：证明内核确实经 CLI 帧协议往返
console.log('\n[4] 帧协议往返')
const logOk = await waitFor(() => fs.existsSync(cliLogPath), { timeout: 8000 })
ok('假 CLI 有帧日志', logOk, cliLogPath)
if (logOk) {
  const frames = fs.readFileSync(cliLogPath, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const kinds = (dir) => frames.filter((f) => f.direction === dir).map((f) => f.frame?.type)
  const inKinds = kinds('in')
  const outKinds = kinds('out')
  ok('内核向 CLI 发过 job_start', inKinds.includes('job_start'), `in=${JSON.stringify([...new Set(inKinds)])}`)
  ok('CLI 回报过 host_ready', outKinds.includes('host_ready'), `out=${JSON.stringify([...new Set(outKinds)])}`)
  ok('CLI 回报过 slot_ready', outKinds.includes('slot_ready'))
  ok('CLI 回报过 job_done', outKinds.includes('job_done'), `out=${JSON.stringify([...new Set(outKinds)])}`)
  ok('CLI 回报过 stream_event', outKinds.includes('stream_event'))
}

child.kill('SIGTERM')
await new Promise((r) => setTimeout(r, 500))
try { child.kill('SIGKILL') } catch { /* 已退出 */ }

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  if (kernelLog.trim()) console.log(`\n内核日志（尾部）:\n${kernelLog.trim().split('\n').slice(-14).join('\n')}`)
  process.exit(1)
}
console.log('\n结论：内核 Claude 通道除「内核→api.anthropic.com」最后一跳外全部打通。')
console.log('      换真 token 时只需要把 credential_path 指向真凭据，代码不用改。')
