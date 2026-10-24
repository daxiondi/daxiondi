#!/usr/bin/env node
/**
 * egress 命令行：规划 / 校验 / 生成 demo / 出口验证。
 *
 * 用法：
 *   node src/egress/cli.mjs plan                     # 打印 20 槽位规划表
 *   node src/egress/cli.mjs verify-config            # 校验 config/proxies.json
 *   node src/egress/cli.mjs emit --out /tmp/egress-demo
 *   node src/egress/cli.mjs slot 01                  # 打印单槽位完整配置
 *   node src/egress/cli.mjs probe                   # 真实探测代理健康（会联网）
 *
 * 约束：probe 是唯一会联网的命令，其余全部离线。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadProxyPool, defaultConfigPath, checkPoolHealth, redactProxy } from './pool.mjs'
import { buildFleetBlueprint, buildSlotBlueprint, renderFleetFiles } from './plan.mjs'
import { planSlotNetworks } from './network.mjs'
import { preflightEgress } from './verify.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

function parseArgs(argv) {
  const out = { cmd: argv[0] || 'plan', flags: {}, rest: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out.flags[key] = next
        i += 1
      } else out.flags[key] = true
    } else out.rest.push(a)
  }
  return out
}

function printTable(blueprint) {
  const head = ['槽位', '容器', 'network', 'bridge', 'subnet', '网关', '容器IP', 'tcp', 'dns', '代理']
  const rows = blueprint.table.map((r) => [
    r.slotId,
    r.container,
    r.network,
    r.bridge,
    r.subnet,
    r.gateway,
    r.containerIp,
    String(r.tcpPort),
    String(r.dnsPort),
    r.proxyId || '-',
  ])
  const widths = head.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i]))))
  const pad = (s, w) => `${s}${' '.repeat(Math.max(0, w - displayWidth(s)))}`
  console.log(head.map((h, i) => pad(h, widths[i])).join('  '))
  console.log(widths.map((w) => '─'.repeat(w)).join('  '))
  for (const r of rows) console.log(r.map((c, i) => pad(c, widths[i])).join('  '))
}

function displayWidth(s) {
  let w = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0)
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xff00 && cp <= 0xff60)
    w += wide ? 2 : 1
  }
  return w
}

/**
 * 落盘。默认 0600：单槽位 blueprint.json 内嵌 redsocks / sing-box 配置，
 * 里面是明文代理凭据；.sh 是可执行规则脚本，给 0755。
 */
function writeFiles(outDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(outDir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, { mode: rel.endsWith('.sh') ? 0o755 : 0o600 })
  }
  return Object.keys(files).length
}

async function main() {
  const { cmd, flags, rest } = parseArgs(process.argv.slice(2))
  const configPath = flags.config ? path.resolve(String(flags.config)) : defaultConfigPath(ROOT)

  if (cmd === 'plan') {
    const plan = planSlotNetworks({ count: Number(flags.count || 20) })
    if (!plan.ok) {
      console.error(plan.errors.join('\n'))
      process.exit(1)
    }
    const blueprint = buildFleetBlueprint({ proxies: [], strict: false, count: plan.count })
    printTable(blueprint)
    console.log(`\n共 ${blueprint.count} 个槽位，地址池 ${blueprint.subnetBase}`)
    return
  }

  if (cmd === 'verify-config') {
    const pool = loadProxyPool(configPath)
    console.log(`配置: ${pool.path}`)
    if (pool.warnings.length) {
      console.log('\n警告:')
      for (const w of pool.warnings) console.log(`  ! ${w}`)
    }
    if (!pool.ok) {
      console.log('\n错误:')
      for (const e of pool.errors) console.log(`  x ${e}`)
      process.exit(1)
    }
    console.log(`\n载入 ${pool.proxies.length} 条代理:`)
    for (const p of pool.proxies) {
      const r = redactProxy(p)
      console.log(`  ${r.id}  ${r.host}:${r.port}  region=${r.region || '-'}  exit=${r.expectedExitIp || '-'}${r.placeholder ? '  [占位]' : ''}`)
    }
    const blueprint = buildFleetBlueprint({ proxies: pool.proxies, strict: false })
    console.log(`\n可覆盖槽位: ${blueprint.count - blueprint.unbound.length}/${blueprint.count}`)
    if (blueprint.unbound.length) console.log(`未绑定: ${blueprint.unbound.join(', ')}`)
    return
  }

  if (cmd === 'emit') {
    const outDir = path.resolve(String(flags.out || '/tmp/egress-demo'))
    const pool = flags.config ? loadProxyPool(configPath) : { ok: true, proxies: [] }
    const blueprint = buildFleetBlueprint({ proxies: pool.proxies || [], strict: false })
    if (!blueprint.ok && blueprint.errors.length && !blueprint.slots.length) {
      console.error(blueprint.errors.join('\n'))
      process.exit(1)
    }
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })
    const files = renderFleetFiles(blueprint)
    const n = writeFiles(outDir, files)
    console.log(`已生成 ${n} 个文件 → ${outDir}`)
    console.log(`槽位 ${blueprint.count} 个，未绑定 ${blueprint.unbound.length} 个`)
    return
  }

  if (cmd === 'slot') {
    const slotId = String(rest[0] || flags.slot || '01')
    const plan = planSlotNetworks()
    const wanted = /^slot-\d+$/.test(slotId) ? slotId : `slot-${String(slotId).padStart(2, '0')}`
    const slot = plan.slots.find((s) => s.slotId === wanted)
    if (!slot) {
      console.error(`找不到槽位: ${slotId}`)
      process.exit(1)
    }
    const pool = loadProxyPool(configPath)
    const proxy = pool.ok ? pool.proxies.find((p) => p.id === flags.proxy) || pool.proxies[0] : null
    const bp = buildSlotBlueprint({ slot, proxy: proxy || null })
    console.log(JSON.stringify(bp, null, 2))
    return
  }

  if (cmd === 'probe') {
    const pool = loadProxyPool(configPath)
    if (!pool.ok) {
      for (const e of pool.errors) console.error(`x ${e}`)
      process.exit(1)
    }
    console.log(`探测 ${pool.proxies.length} 条代理…`)
    const results = await checkPoolHealth(pool.proxies, { concurrency: Number(flags.concurrency || 5) })
    for (const r of results) {
      const mark = r.skipped ? '-' : r.ok ? '✓' : '✗'
      console.log(`  ${mark} ${r.proxyId}  ${r.exitIp || '-'}  ${r.match === false ? 'EXPECT_MISMATCH' : ''} ${r.error || ''}`)
    }
    process.exit(results.some((r) => !r.ok && !r.skipped) ? 1 : 0)
  }

  if (cmd === 'preflight') {
    const pool = loadProxyPool(configPath)
    const plan = planSlotNetworks()
    for (const slot of plan.slots) {
      const proxy = pool.ok ? pool.proxies[plan.slots.indexOf(slot)] || null : null
      const r = preflightEgress({ proxy, slot })
      console.log(`${slot.slotId}  ${r.skipped ? 'skip' : 'ready'}  ${r.summary || ''}`)
    }
    return
  }

  console.error(`未知命令: ${cmd}\n可用: plan | verify-config | emit | slot | probe | preflight`)
  process.exit(2)
}

main()
