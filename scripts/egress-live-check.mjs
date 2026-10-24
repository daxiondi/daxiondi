#!/usr/bin/env node
/**
 * 出口链路真实自检。
 *
 * 在真机（Linux + root + iptables + redsocks）上验证「容器流量确实走了代理」，
 * 而不是被直连放行。直连泄漏是这类部署最危险的失败模式：所有组件都"看起来正常"，
 * 但账号的出口 IP 其实是机房 IP。
 *
 * 用法：
 *   node scripts/egress-live-check.mjs --slot slot-01 --proxy-host 172.17.0.1 --proxy-port 1081
 *
 * 退出码：0 通过 / 1 失败
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const arg = (n, d = null) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const slot = arg('--slot', 'slot-01')
const container = arg('--container', `claude-slot-${slot.replace(/^slot-/, '')}`)
// 代理端口不能硬编码：每槽位独立代理时端口是 1101..1120，
// 写死 1081 会让整个自检直接报"代理连不上"，看着像部署坏了。
// 默认从 config/proxies.json 取第一个启用的条目，命令行可覆盖。
function defaultProxy() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/proxies.json'), 'utf8'))
    const list = Array.isArray(raw) ? raw : (raw.proxies || [])
    const first = list.find((p) => p && p.enabled !== false) || list[0]
    if (first) return { host: first.host, port: String(first.port) }
  } catch { /* 配置缺失就用兜底值 */ }
  return { host: '172.17.0.1', port: '1081' }
}
const fallbackProxy = defaultProxy()
const proxyHost = arg('--proxy-host', fallbackProxy.host)
const proxyPort = arg('--proxy-port', fallbackProxy.port)
const chain = `SKEG${slot.replace(/^slot-/, '')}`
const testUrl = arg('--url', 'http://1.1.1.1')

let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const sh = (cmd, args = [], opts = {}) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000, ...opts }) }
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message) }
  }
}

console.log('=== 出口链路自检 ===')
console.log(`  槽位: ${slot}  容器: ${container}`)
console.log(`  代理: ${proxyHost}:${proxyPort}`)
console.log('')

// ── 0. 前置工具。conntrack 缺失会让"清空连接表"静默失败，
//      旧的自环连接留在缓存里，后续所有测试结果都是假的。
console.log('[0] 前置工具')
const ct = sh('sh', ['-c', 'command -v conntrack'])
ok('conntrack 已安装', ct.ok && ct.out.trim().length > 0,
  '缺失时 conntrack -F 会静默失败，缓存里的旧连接会让测试结果失真')
const rs = sh('sh', ['-c', 'command -v redsocks'])
ok('redsocks 已安装', rs.ok && rs.out.trim().length > 0)

// ── 1. 容器在跑
console.log('\n[1] 容器与转发器')
const running = sh('docker', ['inspect', '-f', '{{.State.Running}}', container])
ok('容器在运行', running.out.trim() === 'true', running.err || running.out.trim())
const listening = sh('sh', ['-c', `ss -lnt | grep -c ':21'`])
ok('转发器端口在监听', Number(listening.out.trim()) > 0)

// ── 2. 清连接表（关键：不清就等于在测缓存）
console.log('\n[2] 清空连接表')
const flush = sh('conntrack', ['-F'])
ok('连接表已清空（有真实回执）', flush.ok, flush.err)

// ── 3. 直连泄漏检测：停代理 → 必须不通
// 这一步是整套检查的核心。如果关了代理还通，说明流量根本没走代理，
// 后面测到的"出口 IP"其实是机房 IP。
console.log('\n[3] 直连泄漏检测（关代理后必须不通）')
const proxyWasUp = sh('sh', ['-c', `timeout 3 bash -c 'echo > /dev/tcp/${proxyHost}/${proxyPort}'`]).ok
ok('代理当前可达（前提）', proxyWasUp, `${proxyHost}:${proxyPort} 连不上，先修代理`)

if (proxyWasUp) {
  const pidOut = sh('sh', ['-c', `ss -lntp | grep ':${proxyPort}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2`])
  const proxyPid = pidOut.out.trim()
  if (proxyPid) {
    sh('kill', ['-STOP', proxyPid])           // 冻结而非杀死：保留监听，只是不响应
    sh('conntrack', ['-F'])
    const blocked = sh('docker', ['exec', container, 'timeout', '8', 'curl', '-s', '-m', '6', '-o', '/dev/null', '-w', '%{http_code}', testUrl])
    sh('kill', ['-CONT', proxyPid])
    ok('代理挂起时请求失败（无直连泄漏）', blocked.out.trim() === '000' || !blocked.ok,
      `得到 ${blocked.out.trim()}，说明流量绕过了代理直连`)
  } else {
    ok('能定位代理进程 pid', false, '拿不到 pid，跳过泄漏检测（不是"通过"）')
  }
}

// ── 4. 代理恢复后必须通
console.log('\n[4] 代理恢复后可达')
sh('conntrack', ['-F'])
const good = sh('docker', ['exec', container, 'timeout', '15', 'curl', '-s', '-m', '12', '-o', '/dev/null', '-w', '%{http_code}', testUrl])
ok('经代理请求成功', good.out.trim() !== '000' && good.out.trim() !== '', `得到 ${good.out.trim()}`)

// ── 5. REDIRECT 计数确实增长
console.log('\n[5] REDIRECT 确实命中')
const counters = sh('sh', ['-c', `iptables -t nat -L ${chain} -n -v 2>/dev/null | awk 'NR>2 && /REDIRECT/ {print $1}' | paste -sd+ - | bc 2>/dev/null || echo 0`])
const total = Number(String(counters.out).trim()) || 0
ok('REDIRECT 计数 > 0', total > 0, `链 ${chain} 的 REDIRECT 命中数为 0，规则没生效`)

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n结论：容器流量确实经代理出网，无直连泄漏。')
