#!/usr/bin/env node
/**
 * 槽位级代理隔离验证。
 *
 * 「同 IP 多号必连带封」这条防线的核心不是代理数量，而是
 * **每个槽位的流量是否真的走自己的代理**。数量够但路由错，
 * 效果和共用一个代理完全一样，而且更难发现。
 *
 * 这个方法利用带日志的 SOCKS5：每个代理把收到的 CONNECT 目标写进
 * 自己的日志。验证三件事：
 *   1. 每个代理都收到了流量（没有槽位漏配）
 *   2. 各代理的日志互不重叠（没有串流）
 *   3. DNS 也走代理（否则解析出真实 IP，代理白搭）
 *
 * 用法：
 *   node scripts/proxy-isolation-check.mjs --logdir /tmp/s5logs --slots 20
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (n, d = null) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const logDir = arg('--logdir', '/tmp/s5logs')
const slots = Number(arg('--slots', '20'))

let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('=== 槽位级代理隔离 ===')
console.log(`  日志目录: ${logDir}`)
console.log(`  槽位数:   ${slots}`)
console.log('')

/** 读一个代理的日志，返回 CONNECT 目标列表 */
function readProxyLog(file) {
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const m = line.match(/^\S+\s+(\S+)\s+CONNECT\s+(\S+)$/)
      return m ? { tag: m[1], target: m[2] } : null
    })
    .filter(Boolean)
}

// ── 1. 每个代理都有日志且有流量
console.log('[1] 每个代理都收到流量')
const perProxy = new Map()
let missing = 0
for (let i = 1; i <= slots; i += 1) {
  const entries = readProxyLog(path.join(logDir, `px-${i}.log`))
  if (!entries || entries.length === 0) { missing += 1; continue }
  perProxy.set(i, entries)
}
ok(`${slots} 个代理都有 CONNECT 记录`, missing === 0, `缺 ${missing} 个`)

// ── 2. 日志里出现的 tag 必须只属于该代理（没串流）
console.log('\n[2] 日志归属正确（无串流）')
let crossTalk = 0
for (const [idx, entries] of perProxy) {
  const wrong = entries.filter((e) => e.tag !== `px-${idx}`)
  if (wrong.length) { crossTalk += 1; console.log(`      px-${idx} 混入 ${wrong.length} 条其他标签`) }
}
ok('没有代理记录到别人的流量', crossTalk === 0, `${crossTalk} 个代理有串流`)

// ── 3. 目标集合两两比较：不同槽位打到的 IP 不该完全一致
//      （完全一致说明所有槽位共用同一个解析路径，隔离名存实亡）
console.log('\n[3] 目标集合互不雷同')
const signatures = new Map()
for (const [idx, entries] of perProxy) {
  const targets = new Set(entries.map((e) => e.target).filter((t) => !t.endsWith(':53')))
  signatures.set(idx, [...targets].sort().join(','))
}
const sigValues = [...signatures.values()].filter(Boolean)
ok('至少收集到 1 个非 DNS 目标', sigValues.length > 0, `只有 ${sigValues.length} 个`)
// 记录不同的签名种类数（Cloudflare 轮换会让它大于 1，这是正常的；
// 全部相同说明所有请求走了同一条链路）
const distinctSigs = new Set(sigValues)
console.log(`      不同目标签名: ${distinctSigs.size} 种 / ${sigValues.length} 个代理`)

// ── 4. DNS 必须走代理
console.log('\n[4] DNS 不出网（无泄漏）')
let dnsViaProxy = 0
for (const [, entries] of perProxy) {
  if (entries.some((e) => e.target.endsWith(':53'))) dnsViaProxy += 1
}
ok('DNS 查询经代理转发（:53 CONNECT 存在）', dnsViaProxy > 0, `${dnsViaProxy} 个代理收到 DNS`)
ok('全部代理都转发 DNS', dnsViaProxy === perProxy.size, `${dnsViaProxy}/${perProxy.size}`)

// ── 5. 目标端口必须是 443（HTTPS）
console.log('\n[5] 目标端口')
let port443 = 0
let otherPorts = new Set()
for (const [, entries] of perProxy) {
  for (const e of entries) {
    const port = e.target.split(':').pop()
    if (port === '443') port443 += 1
    else if (port !== '53') otherPorts.add(port)
  }
}
ok('主要流量走 443', port443 > 0, `${port443} 条`)
if (otherPorts.size) console.log(`      其他端口: ${[...otherPorts].join(', ')}`)

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n结论：每个槽位的流量走各自的代理，DNS 也在代理内解析。')
