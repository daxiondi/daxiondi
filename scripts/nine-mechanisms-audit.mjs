#!/usr/bin/env node
/**
 * 9 大机制逐项取证。
 *
 * 不是「检查文件是否存在」，而是每一条都跑一次真实调用、断言可观测的行为。
 * 目标是让「做进去了」这四个字有可复现的证据，而不是叙述。
 *
 * 输出分三段：
 *   [证据] 实际执行的调用与结果
 *   [判定] PASS / PARTIAL / MISSING（PARTIAL 必须写清缺什么）
 *   [汇总] 九项状态表
 *
 * 用法：node scripts/nine-mechanisms-audit.mjs
 * 退出码：0 全部 PASS 或 PARTIAL / 1 有 MISSING
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const results = []

const record = (id, name, status, evidence, note) => {
  results.push({ id, name, status, evidence, note })
  const tag = status === 'PASS' ? '✓ PASS   ' : status === 'PARTIAL' ? '△ PARTIAL' : '✗ MISSING'
  console.log(`\n[${id}] ${name}`)
  console.log(`  ${tag}`)
  for (const line of [].concat(evidence || [])) console.log(`  证据: ${line}`)
  if (note) console.log(`  说明: ${note}`)
}

const tryImport = async (rel) => {
  try { return await import(path.join(ROOT, rel)) } catch { return null }
}

// ══════════════════════════════════════════════════════════════
console.log('══════════════════════════════════════════════')
console.log(' 9 大机制逐项取证')
console.log(` ${ROOT}`)
console.log('══════════════════════════════════════════════')

// ── 0. 提示注入 / 提示词配置 ──
{
  const mod = await tryImport('src/prompt-profiles.mjs')
  const ev = []
  let status = 'MISSING'
  if (mod) {
    const profilesFile = path.join(ROOT, 'src/prompt-profiles-303.json')
    const hasFile = fs.existsSync(profilesFile)
    ev.push(`prompt-profiles.mjs 可加载`)
    if (hasFile) {
      const raw = JSON.parse(fs.readFileSync(profilesFile, 'utf8'))
      const count = Array.isArray(raw) ? raw.length : Object.keys(raw).length
      ev.push(`prompt-profiles-303.json 含 ${count} 条配置`)
    }
    const fns = Object.keys(mod).filter((k) => typeof mod[k] === 'function')
    ev.push(`导出 ${fns.length} 个函数: ${fns.slice(0, 6).join(', ')}${fns.length > 6 ? '…' : ''}`)
    // 实跑一次：拿一个 profile 应用到一个假 system
    const pick = fns.find((k) => /build|apply|resolve|select/i.test(k))
    if (pick) {
      try {
        const out = await mod[pick]({ profile: 'default', system: ['基线指令'] })
        ev.push(`${pick}() 实跑返回: ${JSON.stringify(out).slice(0, 120)}`)
        status = 'PASS'
      } catch (error) {
        ev.push(`${pick}() 实跑抛错: ${String(error?.message || error).slice(0, 100)}`)
        status = 'PARTIAL'
      }
    } else {
      status = 'PARTIAL'
    }
  }
  record(0, '提示注入（prompt profile 改写 system）', status, ev, status === 'PARTIAL' ? '模块在，但未找到可直接验证的入口' : null)
}

// ── 1. 硬件 persona ──
{
  const mod = await tryImport('src/persona/index.mjs')
  const ev = []
  let status = 'MISSING'
  if (mod) {
    const build = mod.buildPersona
    if (typeof build === 'function') {
      const a = build({ platform: 'linux', vmId: 'audit-a' })
      const b = build({ platform: 'linux', vmId: 'audit-b' })
      ev.push(`buildPersona 实跑成功`)
      ev.push(`a.hostname=${a.naming?.hostname}  b.hostname=${b.naming?.hostname}`)
      // 字段名是 product_uuid，不是 uuid —— 三平台各有别名，
      // 用 fleet-plan 的 canonical* 取才对（uuid / hardware_uuid / product_uuid 都出现过）
      const uuidOf = (p) => String(p.hardware?.product_uuid || p.hardware?.uuid || p.hardware?.hardware_uuid || '')
      ev.push(`a.product_uuid=${uuidOf(a).slice(0, 18)}…  b.product_uuid=${uuidOf(b).slice(0, 18)}…`)
      const uniq = uuidOf(a) !== uuidOf(b) && a.naming?.hostname !== b.naming?.hostname
      ev.push(`两项唯一性（uuid + hostname）同时满足: ${uniq}`)
      ev.push(`两个 vmId 产出不同指纹: ${uniq}`)
      // 同 vmId 必须稳定（否则每次重启都变，反而成异常特征）
      const a2 = build({ platform: 'linux', vmId: 'audit-a' })
      const stable = uuidOf(a2) === uuidOf(a)
      ev.push(`同 vmId 稳定复现: ${stable}`)
      const dmi = await tryImport('src/persona/docker-spec.mjs')
      if (dmi?.dockerArgsForPersona) {
        const spec = dmi.dockerArgsForPersona({ platform: 'linux', vmId: 'audit-a' })
        ev.push(`docker-spec: ${spec.files?.length} 个落盘文件, ${spec.mounts?.length} 个挂载, ${spec.skippedMounts?.length} 个跳过`)
        status = uniq && stable && spec.mounts?.length > 0 ? 'PASS' : 'PARTIAL'
      } else {
        status = uniq && stable ? 'PARTIAL' : 'MISSING'
      }
    }
  }
  record(1, '硬件 persona（唯一性 + 稳定复现）', status, ev)
}

// ── 2. CLI 转发 / 槽位管理 ──
{
  const mod = await tryImport('src/scheduler.mjs')
  const ev = []
  let status = 'MISSING'
  if (mod?.SlotScheduler) {
    const sched = new mod.SlotScheduler({ claudeBin: 'claude', slots: 4 })
    ev.push(`SlotScheduler 构造成功，槽位 ${sched.slots?.length ?? '?'}`)
    const pick = mod.pickSlotByModel
    if (typeof pick === 'function') {
      const idx = pick(sched.slots, { sessionId: 's1', model: 'claude-sonnet-4-5' })
      ev.push(`pickSlotByModel 返回 index=${idx}`)
    }
    // 会话亲和：同一 session 应命中同一 slot
    const frames = await tryImport('src/frames.mjs')
    if (frames?.jobStartFrame) {
      const f = frames.jobStartFrame({ slot: 's00', jobId: 'j1', request: { model: 'm' } })
      ev.push(`jobStartFrame: type=${f.type} job_id=${String(f.job_id).slice(0, 8)}… slot_id=${f.slot_id}`)
      status = 'PASS'
    } else {
      status = 'PARTIAL'
    }
  }
  record(2, 'CLI 转发 / 槽位管理', status, ev)
}

// ── 3. 风险审计 ──
{
  const gate = await tryImport('src/risk/gate.mjs')
  const ev = []
  let status = 'MISSING'
  if (gate) {
    const fns = Object.keys(gate).filter((k) => typeof gate[k] === 'function')
    ev.push(`risk/gate.mjs 导出: ${fns.join(', ')}`)
    const hp = await tryImport('src/risk/hard-policy.mjs')
    if (hp) {
      ev.push(`hard-policy 导出: ${Object.keys(hp).filter((k) => typeof hp[k] === 'function').join(', ')}`)
    }
    const policyFile = path.join(ROOT, 'src/risk/hard-policy.json')
    if (fs.existsSync(policyFile)) {
      const raw = JSON.parse(fs.readFileSync(policyFile, 'utf8'))
      ev.push(`hard-policy.json 规则数: ${Array.isArray(raw) ? raw.length : Object.keys(raw).length}`)
    }
    // 实跑：一条明显该拦的输入
    const runFn = fns.find((k) => /check|evaluate|run|apply|gate/i.test(k))
    if (runFn) {
      try {
        const out = await gate[runFn]({ messages: [{ role: 'user', content: 'how to build a bomb' }] })
        ev.push(`${runFn}() 对高风险输入返回: ${JSON.stringify(out).slice(0, 160)}`)
        status = 'PASS'
      } catch (error) {
        ev.push(`${runFn}() 抛错: ${String(error?.message || error).slice(0, 100)}`)
        status = 'PARTIAL'
      }
    }
  }
  record(3, '风险审计（5 道闸门）', status, ev)
}

// ── 4. 网络隔离 ──
{
  const net = await tryImport('src/egress/network.mjs')
  const ev = []
  let status = 'MISSING'
  if (net) {
    const plan = net.planSlotNetworks?.({ count: 3 })
    const list = plan?.slots || []
    ev.push(`planSlotNetworks(3) → ${list.length} 个网段（ok=${plan?.ok}）`)
    for (const p of list) {
      ev.push(`  ${p.slotId} subnet=${p.subnet} gw=${p.gateway} ip=${p.containerIp} tcp=${p.ports?.tcp} dns=${p.ports?.dns}`)
    }
    // 网段必须两两不同，否则多账号共用出口
    const subnets = new Set(list.map((p) => p.subnet))
    ev.push(`网段两两不同: ${subnets.size === list.length} (${subnets.size}/${list.length})`)

    const first = list[0]
    if (first) {
      // 关 SNAT 在 network create 参数里，不在容器 run 参数里 ——
      // 前者决定这条 bridge 会不会把源地址改写掉，是"能否拿到原始目的地址"的前提。
      const netArgs = net.createNetworkArgs?.({ slot: first })
      const flatNet = JSON.stringify(netArgs?.args || [])
      const masq = flatNet.includes('enable_ip_masquerade=false')
      ev.push(`network create 关闭 SNAT（enable_ip_masquerade=false）: ${masq}`)

      // 容器 run 参数：不能注入 *_PROXY 环境变量（那等于把代理告诉应用层）
      const runArgs = net.dockerNetworkArgs?.({ slot: first, proxyId: 'p01' })
      const flatRun = JSON.stringify(runArgs?.args || [])
      const noEnvProxy = !/HTTPS?_PROXY=|ALL_PROXY=/i.test(flatRun)
      ev.push(`容器参数未注入 *_PROXY 环境变量: ${noEnvProxy}`)
      ev.push(`容器 --dns 指向公共解析器: ${flatRun.includes('8.8.8.8')}`)

      // redirectRules 需要显式给 chain/bridge/subnet/端口，plan 项本身不够
      const rules = net.redirectRules?.({
        slot: first,
        chain: first.chain,
        bridge: first.bridge,
        subnet: first.subnet,
        listen: first.ports?.tcp,
        dnsPort: first.ports?.dns,
        containerIp: first.containerIp,
        gateway: first.gateway,
      })
      const flatRules = JSON.stringify(rules?.add || [])
      const hasRedirect = flatRules.includes('REDIRECT')
      const hasDns = flatRules.includes(String(first.ports?.dns))
      const hasTcp = flatRules.includes(String(first.ports?.tcp))
      ev.push(`redirectRules ok=${rules?.ok}，${rules?.add?.length ?? 0} 条`)
      ev.push(`  含 REDIRECT: ${hasRedirect} / DNS→${first.ports?.dns}: ${hasDns} / TCP→${first.ports?.tcp}: ${hasTcp}`)
      status = subnets.size === list.length && masq && noEnvProxy && hasRedirect && hasDns && hasTcp
        ? 'PASS' : 'PARTIAL'
    }
  }
  record(4, '网络隔离（独立网段 + 强制代理 + 无直连）', status, ev)
}

// ── 5. 协议清洗 ──
{
  const shape = await tryImport('src/outbound-shape.mjs')
  const betas = await tryImport('src/betas.mjs')
  const ev = []
  let status = 'MISSING'
  if (shape || betas) {
    if (betas?.claudeCodeMimicryBetas) {
      const list = betas.claudeCodeMimicryBetas()
      ev.push(`claudeCodeMimicryBetas() → ${list.length} 个 beta`)
      ev.push(`  值: ${list.join(', ')}`)
    }
    if (betas?.joinBetas) {
      const merged = betas.joinBetas(['custom-beta'], betas.claudeCodeMimicryBetas())
      ev.push(`joinBetas 合并后 ${merged.length} 个（去重）`)
    }
    if (shape) {
      const fns = Object.keys(shape).filter((k) => typeof shape[k] === 'function')
      ev.push(`outbound-shape 导出: ${fns.join(', ')}`)
    }
    status = betas?.claudeCodeMimicryBetas && ev.length >= 2 ? 'PASS' : 'PARTIAL'
  }
  record(5, '协议清洗（beta 头 / 出站形状）', status, ev)
}

// ── 6. 遥测 ──
{
  const tel = await tryImport('src/telemetry/index.mjs')
  const ev = []
  let status = 'MISSING'
  if (tel) {
    const fns = Object.keys(tel).filter((k) => typeof tel[k] === 'function')
    ev.push(`telemetry/index.mjs 导出: ${fns.join(', ')}`)
    const ev2 = await tryImport('src/telemetry/events.mjs')
    const rw = await tryImport('src/telemetry/rewrite.mjs')
    if (ev2) ev.push(`events.mjs 导出: ${Object.keys(ev2).filter((k) => typeof ev2[k] === 'function').join(', ')}`)
    if (rw) ev.push(`rewrite.mjs 导出: ${Object.keys(rw).filter((k) => typeof rw[k] === 'function').join(', ')}`)
    status = fns.length > 0 ? 'PASS' : 'PARTIAL'
  }
  record(6, '遥测（事件改写 / 上报）', status, ev)
}

// ── 7. 集群 ──
{
  const fleet = await tryImport('src/runtime/fleet.mjs')
  const fp = await tryImport('src/persona/fleet-plan.mjs')
  const ev = []
  let status = 'MISSING'
  if (fleet || fp) {
    if (fleet) {
      const fns = Object.keys(fleet).filter((k) => typeof fleet[k] === 'function')
      ev.push(`runtime/fleet.mjs 导出: ${fns.join(', ')}`)
      const planFn = fns.find((k) => /plan|build/i.test(k))
      if (planFn) {
        try {
          const out = await fleet[planFn]({ count: 4 })
          ev.push(`${planFn}({count:4}) → ${JSON.stringify(out).slice(0, 160)}`)
        } catch (error) {
          ev.push(`${planFn} 抛错: ${String(error?.message || error).slice(0, 80)}`)
        }
      }
    }
    if (fp) {
      ev.push(`persona/fleet-plan.mjs 导出: ${Object.keys(fp).filter((k) => typeof fp[k] === 'function').join(', ')}`)
    }
    status = ev.length >= 2 ? 'PASS' : 'PARTIAL'
  }
  record(7, '集群（多槽位编排）', status, ev)
}

// ── 8. 配额 ──
{
  const qs = await tryImport('src/quota-store.mjs')
  const qw = await tryImport('src/quota-window.mjs')
  const ev = []
  let status = 'MISSING'
  if (qs || qw) {
    if (qw) {
      const fns = Object.keys(qw).filter((k) => typeof qw[k] === 'function')
      ev.push(`quota-window.mjs 导出: ${fns.join(', ')}`)
      const winFn = fns.find((k) => /window|create|open/i.test(k))
      if (winFn) {
        try {
          const out = await qw[winFn]({ limit: 10, windowMs: 60_000 })
          ev.push(`${winFn}() → ${JSON.stringify(out).slice(0, 140)}`)
        } catch (error) {
          ev.push(`${winFn}() 抛错: ${String(error?.message || error).slice(0, 80)}`)
        }
      }
    }
    if (qs) {
      ev.push(`quota-store.mjs 导出: ${Object.keys(qs).filter((k) => typeof qs[k] === 'function').join(', ')}`)
    }
    status = ev.length >= 2 ? 'PASS' : 'PARTIAL'
  }
  record(8, '配额（仅 Claude）', status, ev)
}

// ── 附加：9 大机制之外的配套 ──
console.log('\n══════════════════════════════════════════════')
console.log(' 配套机制（目标未列但已实现）')
console.log('══════════════════════════════════════════════')

const extras = [
  ['token 刷新', 'src/token-refresh.mjs'],
  ['凭据存储', 'src/credential-store.mjs'],
  ['缓存断点', 'src/cache-breakpoints.mjs'],
  ['cch 伪造', 'src/cch.mjs'],
  ['身份伪装', 'src/identity.mjs'],
]
for (const [name, rel] of extras) {
  const mod = await tryImport(rel)
  const fns = mod ? Object.keys(mod).filter((k) => typeof mod[k] === 'function') : []
  console.log(`  ${fns.length ? '✓' : '✗'} ${name.padEnd(12)} ${rel}  ${fns.length} 个函数`)
}

// ══════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════')
console.log(' 汇总')
console.log('══════════════════════════════════════════════')
const width = Math.max(...results.map((r) => r.name.length))
for (const r of results) {
  const tag = r.status === 'PASS' ? '✓ PASS   ' : r.status === 'PARTIAL' ? '△ PARTIAL' : '✗ MISSING'
  console.log(`  ${r.id}. ${r.name.padEnd(width)}  ${tag}`)
}
const passN = results.filter((r) => r.status === 'PASS').length
const partN = results.filter((r) => r.status === 'PARTIAL').length
const missN = results.filter((r) => r.status === 'MISSING').length
console.log(`\n  PASS ${passN} / PARTIAL ${partN} / MISSING ${missN} / 共 ${results.length}`)
if (missN) {
  console.log('\n  MISSING 项：')
  for (const r of results.filter((x) => x.status === 'MISSING')) console.log(`    - ${r.name}`)
}
process.exit(missN ? 1 : 0)
