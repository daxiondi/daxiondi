#!/usr/bin/env node
/**
 * 内核替换自检。
 *
 * 验证「vm2api 的 Node 控制面能用我们的内核」这件事本身。
 * 只做进程级验证（spawn + socket + health），不依赖 Docker 容器与代理，
 * 因此可以在任何一台开发机上跑通。
 *
 * 用法：
 *   node scripts/kernel-replace-check.mjs [--vm2api <path>]
 *
 * 退出码：0 全部通过 / 1 有失败项
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const vm2apiRoot = (() => {
  const i = argv.indexOf('--vm2api')
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1])
  const guess = path.resolve(new URL('../..', import.meta.url).pathname, 'vm2api')
  return fs.existsSync(guess) ? guess : null
})()

let pass = 0
const failures = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-replace-'))
const sock = path.join(tmp, 'api-kernel.sock')
const token = 'check-' + Math.random().toString(16).slice(2, 18)
const kernelBin = path.resolve(new URL('../src/kernel/server.mjs', import.meta.url).pathname)

console.log('=== 内核替换自检 ===')
console.log(`  内核: ${kernelBin}`)
console.log(`  socket: ${sock}`)
if (vm2apiRoot) console.log(`  vm2api: ${vm2apiRoot}`)
else console.log('  vm2api: 未找到（跳过依赖它的检查）')
console.log('')

// ── 1. 按控制面的启动约定拉起内核
console.log('[1] 启动约定（spawn(bin, ["-socket", p, "-token", t])）')
const child = spawn(process.execPath, [kernelBin, '-socket', sock, '-token', token], { stdio: 'ignore' })
let exited = null
child.on('exit', (code) => { exited = code })

const waitSock = async (ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) return true
    await new Promise((r) => setTimeout(r, 80))
  }
  return false
}

const gotSock = await waitSock(8000)
ok('socket 在 8s 内出现', gotSock, exited != null ? `进程已退出 code=${exited}` : '超时')

if (!gotSock) {
  console.log(`\n失败：${failures.length} 项`)
  child.kill('SIGKILL')
  process.exit(1)
}

// 权限必须是 0600：内含可写控制通道，同机其他用户不应能连
const mode = fs.statSync(sock).mode & 0o777
ok('socket 权限为 0600', mode === 0o600, '实际 ' + mode.toString(8))

// ── 2. health 与认证
console.log('\n[2] /internal/health 与认证')
const request = (headers) => new Promise((resolve) => {
  const req = http.request({ socketPath: sock, path: '/internal/health', method: 'GET', headers }, (res) => {
    let body = ''
    res.on('data', (c) => { body += c })
    res.on('end', () => resolve({ status: res.statusCode, body }))
  })
  req.on('error', (e) => resolve({ status: 0, body: String(e.message) }))
  req.end()
})

const okAuth = await request({ 'x-kin-internal-token': token })
ok('正确 token → 200', okAuth.status === 200, `实际 ${okAuth.status}`)

let health = null
try { health = JSON.parse(okAuth.body) } catch {}
ok('响应是 JSON', health != null)
ok('ok === true', health?.ok === true)
// supervisor 的判据：engine 为 rust 时直接认定进程存活
ok('engine === "rust"（supervisor 认这个值）', health?.engine === 'rust', health?.engine)
// ready_slots 为 0 且无 cli_pid 会被判 wedged 并触发重启
ok('ready_slots > 0', Number(health?.ready_slots) > 0, String(health?.ready_slots))
ok('slots_per_worker === 20', Number(health?.slots_per_worker) === 20, String(health?.slots_per_worker))

const badAuth = await request({ 'x-kin-internal-token': 'wrong-token' })
ok('错误 token → 401', badAuth.status === 401, `实际 ${badAuth.status}`)
const noAuth = await request({})
ok('无 token → 401', noAuth.status === 401, `实际 ${noAuth.status}`)

// ── 3. health 延迟：supervisor 单次探测预算 400ms
console.log('\n[3] health 延迟预算（supervisor 单次 400ms）')
const t0 = Date.now()
await request({ 'x-kin-internal-token': token })
const ms = Date.now() - t0
ok(`health 响应 < 400ms（实测 ${ms}ms）`, ms < 400, `${ms}ms`)

// ── 4. 用 vm2api 自己的 client 代码验证
if (vm2apiRoot) {
  console.log('\n[4] vm2api 自己的 client 代码')
  // client 从 token 文件读凭据，不走环境变量。
  // 不把文件放在它期望的位置，请求会带空 token 打过来，得到 401 ——
  // 那不是内核的问题，是自检脚本没准备好它的输入。
  const runDir = path.join(tmp, 'data', 'run')
  fs.mkdirSync(runDir, { recursive: true })
  const clientSock = path.join(runDir, 'api-kernel.sock')
  const clientToken = path.join(runDir, 'api-kernel.token')
  fs.writeFileSync(clientToken, token)
  process.env.KIN_API_KERNEL_SOCK = clientSock
  process.env.KIN_API_KERNEL_BIN = kernelBin
  try {
    const mod = await import(path.join(vm2apiRoot, 'src/lib/transport/api-kernel-client.mjs'))
    const cfg = { paths: { project: vm2apiRoot, data: path.join(tmp, 'data') } }
    // 内核监听在 sock；client 期望 clientSock。做一次软链把两者对上，
    // 这样验证的是「client 真的连上了我们的内核」，而不是文件摆放。
    try { fs.symlinkSync(sock, clientSock) } catch {}
    const snap = mod.apiKernelSnapshot(cfg)
    ok('apiKernelSnapshot 看到 socket', snap.socket === true)
    const h = await mod.apiKernelHealth(cfg)
    ok('apiKernelHealth 返回 ok', h?.ok === true, JSON.stringify(h).slice(0, 80))
  } catch (e) {
    ok('可加载 vm2api 的 client', false, String(e.message).slice(0, 100))
  }
}

// ── 收尾
child.kill('SIGKILL')
await new Promise((r) => setTimeout(r, 300))
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`)
if (failures.length) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n结论：控制面可以拉起我们的内核，且 health 满足 supervisor 的就绪判据。')
