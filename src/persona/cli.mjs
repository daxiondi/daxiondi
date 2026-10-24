#!/usr/bin/env node
/**
 * persona 工具
 *
 * 单个槽位（原有行为，保持兼容）：
 *   node src/persona/cli.mjs --platform linux --vm-id vm-01 --out ./out
 *   node src/persona/cli.mjs --platform windows --vm-id vm-01 --dry-run
 *   node src/persona/cli.mjs --platform linux --vm-id vm-01 --commands-only
 *   node src/persona/cli.mjs --audit --platform macos --vm-id vm-01
 *
 * 执行层（新增）：
 *   node src/persona/cli.mjs docker   --platform linux --vm-id claude-01 [--network persona-net] [--out DIR]
 *   node src/persona/cli.mjs apply    --platform linux --vm-id claude-01 [--root /] [--plan]
 *   node src/persona/cli.mjs verify   --platform linux --vm-id claude-01 [--root /] [--json]
 *   node src/persona/cli.mjs fleet    --platform linux --count 20 [--host-memory-gb 64 --host-cpus 16 --out-root DIR] [--materialize]
 *
 * KVM 形态（虚拟机，硬件由 QEMU 的 SMBIOS 表提供）：
 *   node src/persona/cli.mjs kvm      --platform linux --vm-id claude-01 --bridge br0
 *   node src/persona/cli.mjs kvm-fleet --count 20 --bridge br0 --host-memory-gb 256 --host-cpus 64
 *   node src/persona/cli.mjs mixed    --claude-kvm 20 --codex-docker 2 --host-memory-gb 256 --host-cpus 64
 *   node src/persona/cli.mjs kvm-verify --ssh-target ubuntu@10.0.0.5:22 --vm-id claude-01
 *
 * 输出约定：`docker` / `kvm` 打参数，`verify` / `kvm-verify` 打检查表，
 * `fleet` / `kvm-fleet` / `mixed` 打分配表 + 资源账单。
 * 退出码：0 成功，1 参数错误，2 一致性/校验失败，3 资源不足。
 */

import fs from 'node:fs'
import path from 'node:path'
import { buildPersona, renderViews, auditPersona, PLATFORMS } from './index.mjs'

const SUBCOMMANDS = ['docker', 'apply', 'verify', 'fleet', 'kvm', 'kvm-fleet', 'kvm-verify', 'mixed']

function parseArgs(argv) {
  const out = {
    subcommand: null,
    platform: null,
    vmId: null,
    out: null,
    outRoot: null,
    dryRun: false,
    commandsOnly: false,
    audit: false,
    overrides: {},
    json: false,
    // 执行层
    network: null,
    timezone: null,
    root: '/',
    plan: false,
    noWrappers: false,
    count: null,
    hostMemoryGb: null,
    hostCpus: null,
    hostDiskGb: null,
    vmIdPrefix: null,
    materialize: false,
    allowDeficit: false,
    cpusPerSlot: null,
    memoryMbPerSlot: null,
    cpuOversubscribe: null,
    // KVM 形态
    runtime: null,
    kvmRootDir: null,
    imagePath: null,
    bridge: null,
    accel: null,
    sshTarget: null,
    sshKey: null,
    diskGb: null,
    claudeKvm: null,
    codexDocker: null,
  }
  let i = 0
  if (argv.length > 0 && SUBCOMMANDS.includes(argv[0])) {
    out.subcommand = argv[0]
    i = 1
  }
  for (; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--platform') out.platform = argv[++i]
    else if (a === '--vm-id') out.vmId = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--out-root') out.outRoot = argv[++i]
    else if (a === '--overrides') out.overrides = JSON.parse(argv[++i])
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--commands-only') out.commandsOnly = true
    else if (a === '--audit') out.audit = true
    else if (a === '--json') out.json = true
    else if (a === '--network') out.network = argv[++i]
    else if (a === '--timezone') out.timezone = argv[++i]
    else if (a === '--root') out.root = argv[++i]
    else if (a === '--plan') out.plan = true
    else if (a === '--no-wrappers') out.noWrappers = true
    else if (a === '--count') out.count = Number(argv[++i])
    else if (a === '--host-memory-gb') out.hostMemoryGb = Number(argv[++i])
    else if (a === '--host-cpus') out.hostCpus = Number(argv[++i])
    else if (a === '--host-disk-gb') out.hostDiskGb = Number(argv[++i])
    else if (a === '--vm-id-prefix') out.vmIdPrefix = argv[++i]
    else if (a === '--materialize') out.materialize = true
    else if (a === '--allow-deficit') out.allowDeficit = true
    else if (a === '--cpus-per-slot') out.cpusPerSlot = Number(argv[++i])
    else if (a === '--memory-mb-per-slot') out.memoryMbPerSlot = Number(argv[++i])
    else if (a === '--cpu-oversubscribe') out.cpuOversubscribe = Number(argv[++i])
    else if (a === '--runtime') out.runtime = argv[++i]
    else if (a === '--kvm-root') out.kvmRootDir = argv[++i]
    else if (a === '--image') out.imagePath = argv[++i]
    else if (a === '--bridge') out.bridge = argv[++i]
    else if (a === '--accel') out.accel = argv[++i]
    else if (a === '--ssh-target') out.sshTarget = argv[++i]
    else if (a === '--ssh-key') out.sshKey = argv[++i]
    else if (a === '--disk-gb') out.diskGb = Number(argv[++i])
    else if (a === '--claude-kvm') out.claudeKvm = Number(argv[++i])
    else if (a === '--codex-docker') out.codexDocker = Number(argv[++i])
    else if (a === '-h' || a === '--help') out.help = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return out
}

function usage() {
  return `persona generator

单个槽位：
  --platform <${PLATFORMS.join('|')}>   目标平台
  --vm-id <id>                          VM 标识（决定派生的硬件标识）
  --out <dir>                           写入目录
  --overrides <json>                    覆盖默认字段
  --dry-run                             只列出文件，不写盘
  --commands-only                       只打印伪命令输出
  --audit                               只做一致性检查
  --json                                以 JSON 输出

执行层子命令：
  docker    生成 docker run 参数
  apply     在容器内应用 persona
  verify    在容器内自检 persona

  公共：--platform --vm-id --network --timezone --root --json
  apply ：--plan（只算不写）、--no-wrappers
  verify：--json

fleet 子命令（多槽位规划）：
  --count <n>              槽位数
  --platform <p>           平台，默认 linux
  --host-memory-gb <n>     主机内存
  --host-cpus <n>          主机 CPU 核数
  --host-disk-gb <n>       主机磁盘
  --out-root <dir>         persona 树落地根目录
  --vm-id-prefix <s>       vm_id 前缀，默认 claude
  --materialize            真正落盘（默认只规划）
  --allow-deficit          资源不足时仍然输出计划
  --cpus-per-slot <n>      每槽 CPU 核数（压到整数规格，默认按 persona 名义核数推导）
  --memory-mb-per-slot <n> 每槽内存上限 MiB（默认按名义内存 / 24 推导）
  --cpu-oversubscribe <n>  CPU 超订倍数（默认 1.0 = 不超订）
  --runtime <docker|kvm>   槽位运行形态，默认 docker
  --json

KVM 子命令（虚拟机形态，硬件由 QEMU 的 SMBIOS 表真实提供）：
  kvm        单个槽位的 QEMU 参数
  kvm-fleet  20 个 KVM 槽位的完整参数与资源账
  mixed      混合编排：一组走 KVM、一组走 Docker
  kvm-verify 经 SSH 进虚拟机核对 QEMU 是否把硬件交出去了

  --bridge <br>            网络桥（缺省回落 QEMU user 网络）
  --image <path>           基础 cloud image
  --kvm-root <dir>         槽位产物根目录，默认 /var/lib/persona-kvm
  --disk-gb <n>            系统盘标称容量
  --accel <kvm|tcg>        加速器，默认 kvm
  --claude-kvm <n>         混合编排中走 KVM 的槽位数
  --codex-docker <n>       混合编排中走 Docker 的槽位数
  --ssh-target <user@host:port>  自检目标
  --ssh-key <path>         自检私钥

退出码：0 成功，1 参数错误，2 一致性/校验失败，3 资源不足
`
}

function writeLine(s = '') {
  process.stdout.write(`${s}\n`)
}

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`)
  return code
}

// ─────────────── 子命令实现 ───────────────

async function cmdDocker(args) {
  const { dockerArgsForPersona, dockerRunCommand, shellJoin } = await import('./docker-spec.mjs')
  const spec = dockerArgsForPersona({
    platform: args.platform,
    vmId: args.vmId,
    outDir: args.out,
    overrides: args.overrides,
    network: args.network,
    timezone: args.timezone,
  })
  if (args.json) {
    writeLine(JSON.stringify({
      platform: spec.platform,
      vmId: spec.vmId,
      hostname: spec.hostname,
      dockerHostname: spec.dockerHostname,
      mac: spec.mac,
      memoryMb: spec.memoryMb,
      cpus: spec.cpus,
      args: spec.args,
      env: spec.env,
      mounts: spec.mounts,
      warnings: spec.warnings,
    }, null, 2))
    return 0
  }
  writeLine(`platform     : ${spec.platform}`)
  writeLine(`vm_id        : ${spec.vmId}`)
  writeLine(`hostname     : ${spec.hostname}`)
  writeLine(`--hostname   : ${spec.dockerHostname}`)
  writeLine(`MAC          : ${spec.mac}`)
  writeLine(`memory       : ${spec.memoryMb}m`)
  writeLine(`cpus         : ${spec.cpus}`)
  writeLine('')
  writeLine(`mounts (${spec.mounts.length}):`)
  const byRole = new Map()
  for (const m of spec.mounts) {
    const list = byRole.get(m.role) || []
    list.push(m)
    byRole.set(m.role, list)
  }
  for (const [role, list] of byRole) {
    writeLine(`  [${role}] ${list.length}`)
    const shown = role === 'file' ? list : list
    for (const m of shown) {
      writeLine(`    ${m.containerPath}  <-  ${m.hostPath}`)
    }
  }
  writeLine('')
  writeLine('docker run 参数：')
  writeLine(`  ${spec.args.join('\\\n    ')}`)
  writeLine('')
  writeLine('完整命令：')
  writeLine(`  ${shellJoin(dockerRunCommand(spec, { image: 'ubuntu:24.04' }))}`)
  for (const w of spec.warnings) writeLine(`\n注意：${w}`)
  return 0
}

async function cmdApply(args) {
  const { applyPersonaInContainer } = await import('./apply.mjs')
  const persona = buildPersona({ platform: args.platform, vmId: args.vmId, overrides: args.overrides })
  const report = await applyPersonaInContainer({
    persona,
    root: args.root,
    dryRun: args.plan,
    wrappers: !args.noWrappers,
    timezone: args.timezone,
  })
  if (args.json) {
    writeLine(JSON.stringify(report, null, 2))
    return report.ok ? 0 : 2
  }
  writeLine(`platform: ${report.platform}   vm_id: ${report.vmId}   root: ${report.root}${report.dryRun ? '   (plan)' : ''}`)
  writeLine('')
  const counts = {}
  for (const f of report.files) counts[f.action] = (counts[f.action] || 0) + 1
  writeLine(`files (${report.files.length}): ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  for (const f of report.files) {
    if (f.action === 'plan') continue
    writeLine(`  [${f.action}] ${f.containerPath}${f.reason ? ` (${f.reason})` : ''}`)
  }
  writeLine('')
  const wc = {}
  for (const w of report.wrappers) wc[w.action] = (wc[w.action] || 0) + 1
  writeLine(`wrappers (${report.wrappers.length}): ${Object.entries(wc).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  for (const w of report.wrappers) {
    writeLine(`  [${w.action}] ${w.path}`)
  }
  writeLine('')
  writeLine(`env: ${Object.entries(report.env).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (report.envApplied) writeLine(`profile: ${report.envProfilePath}`)
  for (const w of report.warnings) writeLine(`注意：${w}`)
  return report.ok ? 0 : 2
}

async function cmdVerify(args) {
  const { verifyPersonaInContainer } = await import('./verify.mjs')
  const persona = buildPersona({ platform: args.platform, vmId: args.vmId, overrides: args.overrides })
  const result = await verifyPersonaInContainer(persona, { root: args.root })
  if (args.json) {
    writeLine(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 2
  }
  writeLine(`platform: ${result.platform}   vm_id: ${result.vmId}   ${result.summary}`)
  writeLine('')
  const w = Math.max(...result.checks.map((c) => c.name.length), 8)
  for (const c of result.checks) {
    const mark = c.pass ? 'ok  ' : 'FAIL'
    writeLine(`  ${mark} ${c.name.padEnd(w)}  expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(c.actual)}${c.note ? `  (${c.note})` : ''}`)
  }
  if (!result.ok) {
    writeLine('')
    writeLine(`${result.failed.length} 项不符 —— persona 未完全生效`)
  }
  return result.ok ? 0 : 2
}

async function cmdFleet(args) {
  const { planFleet, materializeFleet, fleetManifest, maxSlotsForHost } = await import('./fleet-plan.mjs')
  if (!args.count || args.count <= 0) throw new Error('fleet 需要 --count')
  const hostResources = (args.hostMemoryGb != null && args.hostCpus != null)
    ? {
        memoryGb: args.hostMemoryGb,
        cpus: args.hostCpus,
        ...(args.hostDiskGb != null ? { diskGb: args.hostDiskGb } : {}),
      }
    : null

  const spec = {
    count: args.count,
    platform: args.platform || 'linux',
    hostResources,
    outDirRoot: args.outRoot,
    network: args.network,
    timezone: args.timezone,
    vmIdPrefix: args.vmIdPrefix || undefined,
  }

  // 每槽规格覆盖：只改容器配额，不动 persona 上报的名义硬件。
  // 这两件事必须能分开，否则「机器看起来是 64G/32 核」和「槽位实际能用多少」
  // 会被绑死，20 个槽位算下来要 1.2 TiB。
  const resourceRules = {}
  if (args.cpusPerSlot != null) {
    resourceRules.minCpus = args.cpusPerSlot
    resourceRules.maxCpus = args.cpusPerSlot
  }
  if (args.memoryMbPerSlot != null) {
    resourceRules.minMemoryMb = args.memoryMbPerSlot
    resourceRules.maxMemoryMb = args.memoryMbPerSlot
  }
  if (args.cpuOversubscribe != null) resourceRules.cpuOversubscribe = args.cpuOversubscribe
  if (Object.keys(resourceRules).length > 0) spec.resourceRules = resourceRules

  const plan = args.materialize
    ? await materializeFleet(spec)
    : planFleet(spec)

  if (args.json) {
    writeLine(JSON.stringify(fleetManifest(plan), null, 2))
    if (!plan.ok && !args.allowDeficit) return 3
    return 0
  }

  writeLine(`platform ${plan.platform}   count ${plan.count}   vm_id 前缀 ${plan.vmIdPrefix}`)
  writeLine('')
  // 分配表：只列关键字段，够看清互不相同
  const header = ['vm_id', 'hostname', 'MAC', 'serial', 'UUID'.slice(0, 8), 'mem', 'cpu']
  const rows = plan.slots.map((s) => [
    s.vmId,
    s.hostname,
    s.mac,
    s.serial,
    s.uuid.slice(0, 8),
    `${s.memoryMb}m`,
    String(s.cpus),
  ])
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))))
  writeLine(header.map((h, i) => padEnd(h, widths[i])).join('  '))
  writeLine(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of rows) writeLine(r.map((c, i) => padEnd(c ?? '', widths[i])).join('  '))

  writeLine('')
  writeLine('唯一性（集合去重后的大小 / 槽位数）：')
  for (const [k, v] of Object.entries(plan.uniqueFields)) {
    if (v === null) { writeLine(`  ${k.padEnd(10)} 不适用`); continue }
    const mark = v === plan.count ? 'ok' : 'FAIL'
    writeLine(`  ${k.padEnd(10)} ${v}/${plan.count}  ${mark}`)
  }
  writeLine('')
  writeLine('资源：')
  writeLine(`  每槽：${plan.perSlot.memoryMb} MiB / ${plan.perSlot.cpus} 核 / ${plan.perSlot.diskMb} MiB 盘`)
  writeLine(`  合计：${plan.totals.memoryMb} MiB / ${plan.totals.cpus} 核 / ${plan.totals.diskMb} MiB 盘`)
  writeLine(`  名义上：${(plan.totals.advertisedRamBytes / 1024 ** 3).toFixed(0)} GiB RAM / ${plan.totals.advertisedCores} 核（persona 上报值，非实际占用）`)
  if (plan.host) {
    writeLine(`  主机：${plan.host.memoryMb} MiB / ${plan.host.cpus} 核${plan.host.diskMb ? ` / ${plan.host.diskMb} MiB 盘` : ''}`)
    writeLine(`  预留：${plan.reserve.memoryMb} MiB / ${plan.reserve.cpus} 核 / ${plan.reserve.diskMb} MiB 盘（${Math.round(plan.rules.hostReserveRatio * 100)}%）`)
    const os = plan.rules.cpuOversubscribe
    writeLine(`  CPU 预算：${plan.cpuBudget} 核配额${os > 1 ? `（${os}× 超订）` : '（不超订）'}`)
  } else {
    writeLine('  主机：未提供 --host-memory-gb / --host-cpus，跳过容量校验')
    if (hostResources) {
      const m = maxSlotsForHost({ platform: plan.platform, hostResources })
      writeLine(`  反算：这台机器最多 ${m.slots} 个槽位（瓶颈 ${m.binding}）`)
    }
  }

  if (plan.deficits.length > 0) {
    writeLine('')
    writeLine('资源不足：')
    for (const d of plan.deficits) writeLine(`  - ${d.message}`)
  }
  if (plan.hostnameIssues.length > 0) {
    writeLine('')
    writeLine('主机名不符合平台规则：')
    for (const h of plan.hostnameIssues) writeLine(`  - ${h.vmId} ${h.hostname}（${h.note}）`)
  }
  if (plan.materialized) {
    writeLine('')
    writeLine(`已落盘 ${plan.materialized.length} 棵 persona 树`)
    if (plan.slots[0]?.outDir) writeLine(`根目录：${path.dirname(path.dirname(plan.slots[0].outDir))}`)
  }
  writeLine('')
  writeLine(plan.ok ? '规划通过' : '规划未通过')
  return plan.ok ? 0 : (plan.hostnameIssues.length > 0 ? 2 : 3)
}

// ─────────────── KVM 子命令 ───────────────

async function cmdKvm(args) {
  const { qemuArgsForPersona, qemuCommandLine } = await import('./kvm-spec.mjs')
  const persona = buildPersona({ platform: args.platform || 'linux', vmId: args.vmId, overrides: args.overrides })
  const spec = qemuArgsForPersona({
    persona,
    vmId: args.vmId,
    bridge: args.bridge,
    accel: args.accel || undefined,
    imagePath: args.imagePath,
    rootDir: args.kvmRootDir || undefined,
  })
  if (args.json) {
    writeLine(JSON.stringify({
      platform: spec.platform,
      vmId: spec.vmId,
      mac: spec.mac,
      uuid: spec.uuid,
      serial: spec.serial,
      diskSerial: spec.diskSerial,
      memoryMb: spec.memoryMb,
      vcpus: spec.vcpus,
      machine: spec.machine,
      bridge: spec.bridge,
      diskPath: spec.diskPath,
      paths: spec.paths,
      smbios: spec.smbios,
      argv: spec.argv,
      warnings: spec.warnings,
    }, null, 2))
    return 0
  }
  writeLine(`platform   : ${spec.platform}`)
  writeLine(`vm_id      : ${spec.vmId}`)
  writeLine(`machine    : ${spec.machine}`)
  writeLine(`MAC        : ${spec.mac}`)
  writeLine(`UUID       : ${spec.uuid}`)
  writeLine(`serial     : ${spec.serial}`)
  writeLine(`disk serial: ${spec.diskSerial}`)
  writeLine(`memory     : ${spec.memoryMb}m`)
  writeLine(`vcpus      : ${spec.vcpus}`)
  writeLine(`bridge     : ${spec.bridge || '(QEMU user 网络)'}`)
  writeLine(`disk       : ${spec.diskPath}`)
  writeLine('')
  writeLine('SMBIOS（客户机内核会读这些值填进 /sys/class/dmi/id/*）：')
  for (const type of [0, 1, 2, 3]) {
    writeLine(`  ${spec.smbios[type].arg}`)
  }
  writeLine(`  （type=3 的 chassis type 由 QEMU 固定为 ${spec.smbios[3].chassisType}，命令行不可覆盖）`)
  writeLine('')
  writeLine('完整命令：')
  writeLine(`  ${qemuCommandLine(spec)}`)
  for (const w of spec.warnings) writeLine(`\n注意：${w}`)
  return 0
}

async function cmdKvmFleet(args) {
  const { planFleet, fleetManifest } = await import('./fleet-plan.mjs')
  const count = Number(args.count || 20)
  const plan = planFleet({
    count,
    runtime: 'kvm',
    platform: args.platform || 'linux',
    hostResources: hostResourcesFrom(args),
    vmIdPrefix: args.vmIdPrefix || undefined,
    kvmRootDir: args.kvmRootDir || args.outRoot || undefined,
    imagePath: args.imagePath,
    bridge: args.bridge,
    resourceRules: resourceRulesFrom(args),
  })
  return printKvmPlan(plan, { json: args.json, manifest: fleetManifest, allowDeficit: args.allowDeficit })
}

async function cmdMixed(args) {
  const { planMixedFleet } = await import('./fleet-plan.mjs')
  const claudeCount = Number(args.claudeKvm || 20)
  const codexCount = Number(args.codexDocker || 2)
  const mixed = planMixedFleet({
    claude: {
      runtime: 'kvm',
      count: claudeCount,
      platform: args.platform || 'linux',
      kvmRootDir: args.kvmRootDir || args.outRoot || undefined,
      imagePath: args.imagePath,
      bridge: args.bridge,
    },
    codex: {
      runtime: 'docker',
      count: codexCount,
      platform: args.platform || 'linux',
      network: args.network,
      timezone: args.timezone,
    },
  }, { hostResources: hostResourcesFrom(args) })

  if (args.json) {
    const out = {
      ok: mixed.ok,
      totals: mixed.totals,
      reserveRatio: mixed.reserveRatio,
      deficits: mixed.deficits,
      crossCollisions: mixed.crossCollisions,
      diskConflicts: mixed.diskConflicts,
      groups: {},
    }
    for (const name of mixed.groupNames) {
      out.groups[name] = {
        runtime: mixed.groups[name].runtime,
        totals: mixed.groups[name].totals,
        slots: mixed.slots.filter((s) => s.group === name).map((s) => ({
          vmId: s.vmId,
          hostname: s.hostname,
          mac: s.mac,
          uuid: s.uuid,
          serial: s.serial,
          memoryMb: s.memoryMb,
          cpus: s.cpus,
          ...(s.runtime === 'kvm'
            ? { diskPath: s.kvm.paths.diskPath, argv: s.kvm.argv, smbios: s.kvm.smbios }
            : { args: s.docker.args }),
        })),
      }
    }
    writeLine(JSON.stringify(out, null, 2))
    return mixed.ok ? 0 : (mixed.deficits.length ? 3 : 2)
  }

  writeLine(`混合编排：Claude ${claudeCount} × KVM + Codex ${codexCount} × Docker`)
  writeLine('')
  const header = ['组', 'runtime', 'vm_id', 'hostname', 'MAC', 'mem', 'cpu', 'disk 标称/实际']
  const rows = mixed.slots.map((s) => [
    s.group,
    s.runtime,
    s.vmId,
    s.hostname,
    s.mac,
    `${s.memoryMb}m`,
    String(s.cpus),
    `${s.diskMb / 1024}G/${(s.diskFootprintMb / 1024).toFixed(1)}G`,
  ])
  writePlanTable(header, rows)
  writeLine('')
  writeLine('合计：')
  writeLine(`  槽位 ${mixed.totals.count}（${Object.entries(mixed.totals.byRuntime).map(([k, v]) => `${k}=${v}`).join(' ')}）`)
  writeLine(`  内存额度 ${mixed.totals.memoryMb} MiB / 实际占用 ${mixed.totals.footprintMb} MiB`)
  writeLine(`  CPU ${mixed.totals.cpus} 核`)
  writeLine(`  磁盘标称 ${(mixed.totals.diskMb / 1024 / 1024).toFixed(1)} TiB / 实际占用 ${(mixed.totals.diskFootprintMb / 1024 / 1024).toFixed(1)} TiB`)
  writeLine(`  统一预留比例 ${Math.round(mixed.reserveRatio * 100)}%（取各分组里最保守的）`)
  if (mixed.host) {
    writeLine(`  主机 ${mixed.host.memoryMb} MiB / ${mixed.host.cpus} 核${mixed.host.diskMb ? ` / ${(mixed.host.diskMb / 1024).toFixed(0)} GiB` : ''}`)
  } else {
    writeLine('  主机：未提供 --host-memory-gb / --host-cpus，跳过容量校验')
  }
  if (mixed.crossCollisions.length) {
    writeLine('')
    writeLine('跨分组身份冲突：')
    for (const c of mixed.crossCollisions) {
      writeLine(`  - ${c.field}: ${c.dupes.length} 处（例：${c.dupes[0].slots.join(' 与 ')}）`)
    }
  }
  if (mixed.diskConflicts.length) {
    writeLine('')
    writeLine('磁盘路径冲突：')
    for (const c of mixed.diskConflicts) writeLine(`  - ${c.kind} ${JSON.stringify(c)}`)
  }
  if (mixed.deficits.length) {
    writeLine('')
    writeLine('资源不足：')
    for (const d of mixed.deficits) writeLine(`  - ${d.message}`)
  }
  writeLine('')
  writeLine(mixed.ok ? '规划通过' : '规划未通过')
  return mixed.ok ? 0 : (mixed.deficits.length ? 3 : 2)
}

async function cmdKvmVerify(args) {
  const { verifyKvmPersona } = await import('./kvm-verify.mjs')
  const { qemuArgsForPersona } = await import('./kvm-spec.mjs')
  if (!args.sshTarget) throw new Error('kvm-verify 需要 --ssh-target <user@host:port>')
  const persona = buildPersona({ platform: args.platform || 'linux', vmId: args.vmId, overrides: args.overrides })
  const expected = qemuArgsForPersona({
    persona,
    vmId: args.vmId,
    bridge: args.bridge,
    rootDir: args.kvmRootDir || undefined,
  })
  const result = await verifyKvmPersona({
    sshTarget: args.sshTarget,
    keyPath: args.sshKey,
    expected,
  })
  if (args.json) {
    writeLine(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 2
  }
  writeLine(`vm_id ${result.vmId}   ${result.summary}   客户机内核 ${result.guestKernel || '(未知)'}`)
  writeLine('')
  const w = Math.max(...result.checks.map((c) => c.name.length), 8)
  for (const c of result.checks) {
    const mark = c.pass ? 'ok  ' : 'FAIL'
    writeLine(`  ${mark} ${padEnd(c.name, w)}  expected=${JSON.stringify(c.expected)} actual=${JSON.stringify(c.actual)}${c.note ? `  (${c.note})` : ''}`)
  }
  if (!result.ok) {
    writeLine('')
    writeLine(`${result.failed.length} 项不符 —— SMBIOS 参数没有正确落到客户机`)
  }
  return result.ok ? 0 : 2
}

function printKvmPlan(plan, { json, manifest, allowDeficit }) {
  if (json) {
    writeLine(JSON.stringify(manifest(plan), null, 2))
    return plan.ok || allowDeficit ? 0 : 3
  }
  writeLine(`runtime ${plan.runtime}   platform ${plan.platform}   count ${plan.count}   vm_id 前缀 ${plan.vmIdPrefix}`)
  writeLine('')
  const header = ['vm_id', 'hostname', 'MAC', 'UUID'.slice(0, 8), 'serial', 'mem', 'vcpu', 'disk']
  const rows = plan.slots.map((s) => [
    s.vmId,
    s.hostname,
    s.mac,
    s.uuid.slice(0, 8),
    s.serial,
    `${s.memoryMb}m`,
    String(s.cpus),
    `${(s.diskMb / 1024).toFixed(0)}G`,
  ])
  writePlanTable(header, rows)

  writeLine('')
  writeLine('唯一性（集合去重后的大小 / 槽位数）：')
  for (const [k, v] of Object.entries(plan.uniqueFields)) {
    if (v === null) { writeLine(`  ${k.padEnd(10)} 不适用`); continue }
    const mark = v === plan.count ? 'ok' : 'FAIL'
    writeLine(`  ${k.padEnd(10)} ${v}/${plan.count}  ${mark}`)
  }

  // 同型号字段必须共享：20 台机器 BIOS 版本各不相同才是合成痕迹。
  const shared = ['bios_version', 'product_name', 'sys_vendor', 'board_name']
  writeLine('')
  writeLine('同型号字段（应当共享，不该逐台变化）：')
  for (const field of shared) {
    const values = new Set(plan.slots.map((s) => {
      const t = field.startsWith('bios_') ? s.kvm.smbios[0] : (field === 'board_name' ? s.kvm.smbios[2] : s.kvm.smbios[1])
      const key = field === 'bios_version' ? 'version' : (field === 'board_name' ? 'product' : (field === 'sys_vendor' ? 'manufacturer' : 'product'))
      return String(t[key] ?? '')
    }))
    writeLine(`  ${field.padEnd(14)} ${values.size} 种  ${values.size === 1 ? 'ok' : '注意'}`)
  }

  writeLine('')
  writeLine('资源：')
  writeLine(`  每槽：客户机 ${plan.perSlot.memoryMb} MiB / ${plan.perSlot.cpus} vCPU / 盘标称 ${(plan.perSlot.diskMb / 1024).toFixed(0)} GiB`)
  writeLine(`  每槽实际占用：内存 ${plan.perSlot.footprintMb} MiB（含 hypervisor 开销）/ 盘 ${(plan.perSlot.diskFootprintMb / 1024).toFixed(1)} GiB`)
  writeLine(`  合计额度：${plan.totals.memoryMb} MiB / ${plan.totals.cpus} 核 / ${(plan.totals.diskMb / 1024 / 1024).toFixed(1)} TiB`)
  writeLine(`  合计实际：${plan.totals.footprintMb} MiB / ${(plan.totals.diskFootprintMb / 1024).toFixed(1)} GiB`)
  if (plan.host) {
    writeLine(`  主机：${plan.host.memoryMb} MiB / ${plan.host.cpus} 核${plan.host.diskMb ? ` / ${(plan.host.diskMb / 1024).toFixed(0)} GiB` : ''}`)
    writeLine(`  预留：${plan.reserve.memoryMb} MiB / ${plan.reserve.cpus} 核（${Math.round(plan.rules.hostReserveRatio * 100)}%）`)
  } else {
    writeLine('  主机：未提供 --host-memory-gb / --host-cpus，跳过容量校验')
  }
  if (plan.deficits.length) {
    writeLine('')
    writeLine('资源不足：')
    for (const d of plan.deficits) writeLine(`  - ${d.message}`)
  }
  if (plan.diskConflicts.length) {
    writeLine('')
    writeLine('磁盘路径冲突：')
    for (const c of plan.diskConflicts) writeLine(`  - ${c.kind}: ${JSON.stringify(c.slots || c)}`)
  }
  writeLine('')
  writeLine(plan.ok ? '规划通过' : '规划未通过')
  return plan.ok ? 0 : (plan.deficits.length ? 3 : 2)
}

function writePlanTable(header, rows) {
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))))
  writeLine(header.map((h, i) => padEnd(h, widths[i])).join('  '))
  writeLine(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of rows) writeLine(r.map((c, i) => padEnd(c ?? '', widths[i])).join('  '))
}

function hostResourcesFrom(args) {
  if (args.hostMemoryGb == null || args.hostCpus == null) return null
  return {
    memoryGb: args.hostMemoryGb,
    cpus: args.hostCpus,
    ...(args.hostDiskGb != null ? { diskGb: args.hostDiskGb } : {}),
  }
}

function resourceRulesFrom(args) {
  const resourceRules = {}
  if (args.cpusPerSlot != null) {
    resourceRules.minVcpus = args.cpusPerSlot
    resourceRules.maxVcpus = args.cpusPerSlot
    resourceRules.minCpus = args.cpusPerSlot
    resourceRules.maxCpus = args.cpusPerSlot
  }
  if (args.memoryMbPerSlot != null) {
    resourceRules.minMemoryMb = args.memoryMbPerSlot
    resourceRules.maxMemoryMb = args.memoryMbPerSlot
  }
  if (args.cpuOversubscribe != null) resourceRules.cpuOversubscribe = args.cpuOversubscribe
  if (args.diskGb != null) resourceRules.diskGb = args.diskGb
  return Object.keys(resourceRules).length > 0 ? resourceRules : undefined
}

// 与 run-all.mjs / selfcheck 一致的中日韩宽度计算，避免中文列错位
function displayWidth(s) {
  let width = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0)
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

function padEnd(s, width) {
  const gap = width - displayWidth(s)
  return gap > 0 ? String(s) + ' '.repeat(gap) : String(s)
}

// ─────────────── 原有单槽位路径 ───────────────

function cmdSingle(args) {
  if (!args.platform || !args.vmId) {
    process.stderr.write(`--platform 和 --vm-id 都是必填\n\n${usage()}`)
    return 1
  }
  if (!PLATFORMS.includes(args.platform)) {
    process.stderr.write(`不支持的平台: ${args.platform}（可用: ${PLATFORMS.join(', ')}）\n`)
    return 1
  }

  let persona
  try {
    persona = buildPersona({ platform: args.platform, vmId: args.vmId, overrides: args.overrides })
  } catch (e) {
    process.stderr.write(`构造失败：\n${e.message}\n`)
    return 2
  }

  if (args.audit) {
    const issues = auditPersona(persona)
    if (issues.length === 0) {
      writeLine('一致性检查通过')
      return 0
    }
    for (const i of issues) writeLine(`[${i.severity}] ${i.code}: ${i.text}`)
    return issues.some((i) => i.severity === 'error') ? 2 : 0
  }

  const { files, commands } = renderViews(persona)

  if (args.json) {
    writeLine(JSON.stringify({ persona, files, commands }, null, 2))
    return 0
  }

  if (args.commandsOnly) {
    for (const [cmd, outText] of Object.entries(commands)) {
      writeLine(`$ ${cmd}\n${outText}\n`)
    }
    return 0
  }

  if (args.dryRun || (!args.out && !args.outRoot)) {
    writeLine(`platform: ${persona.platform}`)
    writeLine(`vm_id: ${persona.vm_id}`)
    writeLine('')
    writeLine(`will write ${Object.keys(files).length} files:`)
    for (const rel of Object.keys(files).sort()) writeLine(`  ${rel}`)
    writeLine('')
    writeLine(`commands available: ${Object.keys(commands).length}`)
    if (!args.dryRun && !args.out) writeLine('\n（未指定 --out，仅列出）')
    return 0
  }

  const dir = args.out || args.outRoot
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
  }
  writeLine(`写入 ${Object.keys(files).length} 个文件到 ${dir}`)
  return 0
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    return fail(`${e.message}\n\n${usage()}`, 1)
  }
  if (args.help) {
    process.stdout.write(usage())
    return 0
  }

  try {
    switch (args.subcommand) {
      case 'docker':
        if (!args.platform || !args.vmId) return fail('docker 需要 --platform 与 --vm-id', 1)
        return await cmdDocker(args)
      case 'apply':
        if (!args.platform || !args.vmId) return fail('apply 需要 --platform 与 --vm-id', 1)
        return await cmdApply(args)
      case 'verify':
        if (!args.platform || !args.vmId) return fail('verify 需要 --platform 与 --vm-id', 1)
        return await cmdVerify(args)
      case 'fleet':
        return await cmdFleet(args)
      case 'kvm':
        if (!args.vmId) return fail('kvm 需要 --vm-id', 1)
        return await cmdKvm(args)
      case 'kvm-fleet':
        return await cmdKvmFleet(args)
      case 'kvm-verify':
        if (!args.vmId) return fail('kvm-verify 需要 --vm-id', 1)
        return await cmdKvmVerify(args)
      case 'mixed':
        return await cmdMixed(args)
      default:
        return cmdSingle(args)
    }
  } catch (e) {
    return fail(`${e.message}`, 2)
  }
}

process.exit(await main())
