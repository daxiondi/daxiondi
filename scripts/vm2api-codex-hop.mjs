#!/usr/bin/env node
/**
 * 验证「vm2api 控制面 → 我们的内核」这条跳。
 *
 * 不启动整个 vm2api（那需要面板、数据库、worker 一堆东西），
 * 而是直接用它自己的 transport client —— 也就是它在生产里真正会走的那段代码。
 * 这样验证的才是「它的 client 能不能和我们的内核对上」，
 * 而不是「我手写的 socket 请求能不能通」。
 *
 * 用法：
 *   node scripts/vm2api-codex-hop.mjs --credential config/codex-credential.json
 *
 * 退出码：0 通过 / 1 失败
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

const credentialPath = path.resolve(arg('--credential', path.join(ROOT, 'config/codex-credential.json')))
const vm2apiRoot = path.resolve(arg('--vm2api', path.join(ROOT, '../vm2api')))
const runDir = arg('--run-dir', '/tmp/live-api-vm2api-hop')
const token = 'a'.repeat(48)

let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('=== vm2api 控制面 → 我们的内核 ===')
console.log(`  vm2api: ${vm2apiRoot}`)
console.log(`  凭据:   ${credentialPath}`)
console.log('')

if (!fs.existsSync(credentialPath)) {
  console.error(`凭据不存在: ${credentialPath}`)
  process.exit(2)
}

// ── 1. vm2api 的 client 能否 import（它依赖 node_modules）
console.log('[1] vm2api transport client 可加载')
let client = null
try {
  client = await import(path.join(vm2apiRoot, 'src/lib/transport/codex-kernel-client.mjs'))
  ok('codex-kernel-client.mjs 可 import', true)
} catch (error) {
  ok('codex-kernel-client.mjs 可 import', false, String(error?.message || error).slice(0, 120))
}
if (!client) {
  console.log('\n无法继续：client 加载失败')
  process.exit(1)
}

// ── 2. 按 vm2api 的约定准备目录与 token
console.log('\n[2] 按 vm2api 的路径约定准备')
fs.mkdirSync(runDir, { recursive: true })
const tokenPath = path.join(runDir, 'token')
fs.writeFileSync(tokenPath, token, { mode: 0o600 })

// vm2api 的 exec 形状：它从这里读 socket / token / run_dir
const exec = {
  vm: {
    runtime: {
      codex_kernel_socket: path.join(runDir, 'codex-kernel.sock'),
      worker_token_file: tokenPath,
      worker_run_dir: runDir,
    },
  },
}
let paths = null
try {
  paths = client.codexKernelPaths(exec)
  ok('codexKernelPaths 解析出 socket', Boolean(paths?.socketPath), JSON.stringify(paths))
  ok('socket 路径落在 run_dir 下', String(paths?.socketPath).startsWith(runDir))
} catch (error) {
  ok('codexKernelPaths 可用', false, String(error?.message || error).slice(0, 120))
}

// ── 3. 用 vm2api 的 launch 约定起我们的内核
// 它的 supervisor 是 spawn(bin, ['-socket', sock, '-token', tok]) 再轮询 health
console.log('\n[3] 用 vm2api 的启动约定拉起内核')
const sockPath = paths?.socketPath || path.join(runDir, 'codex-kernel.sock')
try { fs.unlinkSync(sockPath) } catch { /* 不存在正常 */ }

// 内核只认配置文件里的 codex_credential_path —— 环境变量不生效。
// 这是 vm2api 的既有契约（它把凭据路径写进 vm 配置再传 -config），
// 所以这里也必须走同一条路，否则 Codex 通道永远是 503。
const configPath = path.join(runDir, 'kernel-config.json')
fs.writeFileSync(configPath, JSON.stringify({
  vm_id: 'vm2api-hop',
  socket_path: sockPath,
  internal_token: token,
  provider: 'local_cli',
  codex_credential_path: credentialPath,
  codex_default_model: 'gpt-6-astra',
}, null, 2))

const kernelBin = path.join(ROOT, 'src/kernel/server.mjs')
const child = spawn('node', [kernelBin, '-socket', sockPath, '-token', token, '-config', configPath], {
  cwd: ROOT,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let kernelLog = ''
child.stdout.on('data', (d) => { kernelLog += d.toString() })
child.stderr.on('data', (d) => {
  const s = d.toString()
  if (!/UNDICI|trace-warn/.test(s)) kernelLog += s
})

const waitFor = async (fn, { timeout = 20_000, step = 100 } = {}) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, step))
  }
  return false
}

const sockAppeared = await waitFor(() => fs.existsSync(sockPath))
ok('内核 socket 已出现', sockAppeared, sockPath)
ok('socket 权限 0600', (() => {
  try { return (fs.statSync(sockPath).mode & 0o777) === 0o600 } catch { return false }
})())

// ── 4. 用 vm2api 自己的 health client 探测
console.log('\n[4] vm2api 的 codexKernelHealth')
let health = null
try {
  health = await client.codexKernelHealth(exec)
  ok('codexKernelHealth 返回 ok', health?.ok === true, JSON.stringify(health).slice(0, 200))
  ok('source 被重写为 codex-kernel（不是 go-worker）',
    !String(health?.source || '').includes('go-worker'), `source=${health?.source}`)
} catch (error) {
  ok('codexKernelHealth 可用', false, String(error?.message || error).slice(0, 160))
}

// ── 5. 走 vm2api 的 callCodexKernel 发一次真实请求
console.log('\n[5] vm2api 的 callCodexKernel 发真实请求')
try {
  const result = await client.callCodexKernel({
    exec,
    token,
    body: {
      model: 'gpt-6-astra',
      stream: false,
      store: false,
      instructions: 'You are a helpful assistant.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '回复两个字：跳转' }] }],
    },
    timeoutMs: 90_000,
  })
  ok('callCodexKernel 没有抛错', true)
  ok('返回 status 2xx', Number(result?.status) >= 200 && Number(result?.status) < 300, `status=${result?.status}`)
  ok('via 被重写为 codex-kernel', String(result?.via || '').includes('codex-kernel'), `via=${result?.via}`)
  const text = extractText(result?.json ?? result?.body)
  ok('拿到回复文本', text.length > 0, JSON.stringify(result?.json ?? result?.body).slice(0, 200))
  if (text) console.log(`      文本: ${text}`)
} catch (error) {
  ok('callCodexKernel 可用', false, String(error?.message || error).slice(0, 200))
}

child.kill('SIGTERM')
await new Promise((r) => setTimeout(r, 400))
try { child.kill('SIGKILL') } catch { /* 已退出 */ }

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  if (kernelLog.trim()) console.log(`\n内核日志（尾部）:\n${kernelLog.trim().split('\n').slice(-12).join('\n')}`)
  process.exit(1)
}
console.log('\n结论：vm2api 控制面可以用自己的 client 拉到我们的内核并完成真实请求。')

/** 从可能的多层结构里挖出回复文本。 */
function extractText(payload) {
  const seen = new Set()
  const walk = (node, depth) => {
    if (!node || depth > 6 || seen.has(node)) return ''
    if (typeof node === 'string') return ''
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) {
        const t = walk(item, depth + 1)
        if (t) return t
      }
      return ''
    }
    if (typeof node === 'object') {
      // 内核 envelope 可能把 response 放在 json / body / data / response 下
      if (node.type === 'output_text' && typeof node.text === 'string' && node.text) return node.text
      for (const key of ['json', 'body', 'data', 'response', 'output', 'content', 'choices', 'message']) {
        if (key in node) {
          const t = walk(node[key], depth + 1)
          if (t) return t
        }
      }
    }
    return ''
  }
  const direct = walk(payload, 0)
  if (direct) return direct
  // 兜底：整个结构里找第一个非空 output_text
  try {
    const m = JSON.stringify(payload).match(/"text"\s*:\s*"([^"]{1,200})"/)
    return m ? m[1] : ''
  } catch { return '' }
}
