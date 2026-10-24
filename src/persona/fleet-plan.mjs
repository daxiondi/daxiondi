/**
 * 多槽位资源与身份规划
 *
 * 解决的问题：
 *   一台机器上跑 N 个槽位，每个槽位要一套独立硬件身份。逐个手写 vm_id
 *   既容易重名，也容易算错资源。这里把「N 个槽位」当成一个整体来规划：
 *   一次算出 N 份 persona、N 份 docker 参数、以及一个总资源账单。
 *
 * 三条硬约束：
 *   1. 身份两两不同 —— MAC / UUID / 序列号 / 主机名，全部用集合去重校验。
 *      不是「理论上不同」，是算完拿 Set 数一遍，数量对不上就报错。
 *   2. 主机名符合平台命名规则 —— 复用各平台模块已导出的 HOSTNAME_RULES /
 *      OEM 规则，不在这里另立一套。
 *   3. 资源不够就明确报出来 —— 返回 ok:false + deficits 明细，
 *      不在内部偷偷缩减规格。缩减会让「计划」和「实际」脱节。
 */

import { buildPersona, PLATFORMS, isSupportedPlatform, REGISTRY } from './index.mjs'
import {
  dockerArgsForPersona,
  memoryLimitMb,
  cpuLimit,
  diskLimitMb,
  RESOURCE_RULES,
} from './docker-spec.mjs'
import {
  KVM_RESOURCE_RULES,
  detectDiskConflicts,
  kvmDiskFootprintMb,
  kvmDiskSerialFor,
  kvmInstanceIdFor,
  kvmMacFor,
  kvmMemoryFootprintMb,
  kvmMemoryMb,
  kvmPathsFor,
  kvmVcpus,
  personaMacOf,
  qemuArgsForPersona,
} from './kvm-spec.mjs'
import { deriveMac } from './derive.mjs'
import { shellJoin } from './docker-spec.mjs'

/** 槽位运行形态。'docker' 走容器，'kvm' 走虚拟机。 */
export const RUNTIMES = Object.freeze(['docker', 'kvm'])

/**
 * 平台对应的 MAC OUI。
 *
 * 与各平台 normalize() 里用的前缀保持一致 —— 那三个文件已经冻结，
 * 这里只是把前缀显式列出来做前置校验，两处不再各写一份逻辑：
 * 真正的 MAC 仍然由 platform.normalize 从 vm_id 派生。
 */
export const PLATFORM_OUI = Object.freeze({
  // 00:50:56 是 **VMware 的 OUI** —— 用它等于在 MAC 里写"我是虚拟机"。
  // 实测：容器内 `cat /sys/class/net/eth0/address` 直接读到 00:50:56:xx，
  // 任何查 OUI 表的代码一眼判定 VMware。
  //
  // 换成真实服务器/网卡厂商的 OUI。这些是 IEEE 分配给物理设备的，
  // 云主机与裸金属都会出现，不像 VMware/QEMU/VirtualBox 那样是虚拟化专有。
  linux: '3C:EC:EF',      // Super Micro Computer
  macos: 'F0:18:98',      // Apple（本来就是真的，保留）
  windows: 'A4:BB:6D',    // Intel Corporate（保留）
})

/**
 * Linux 可用的 OUI 池。
 *
 * 单一 OUI 会让 20 个槽的 MAC 前缀完全一致 —— 真实机房会有不同批次的网卡，
 * 前缀本来就该分散。这里列的都是 IEEE 分配给实体厂商的前缀，
 * 且**都不是**虚拟化厂商（VMware/QEMU/VirtualBox/Hyper-V/Xen/Docker）。
 *
 * 来源：IEEE OUI 公开注册表，挑的是服务器与网卡厂商。
 */
export const LINUX_OUI_POOL = Object.freeze([
  '3C:EC:EF',  // Super Micro Computer
  '00:25:90',  // Super Micro Computer
  '0C:C4:7A',  // Super Micro Computer
  'A0:36:9F',  // Intel Corporate
  '3C:FD:FE',  // Intel Corporate
  '00:1B:21',  // Intel Corporate
  'B4:96:91',  // Intel Corporate
  '00:0A:F7',  // Broadcom
  '14:02:EC',  // Hewlett Packard Enterprise
  '94:40:C9',  // Hewlett Packard Enterprise
  'D0:67:26',  // Hewlett Packard Enterprise
  '18:66:DA',  // Dell Inc.
  'F8:BC:12',  // Dell Inc.
  '00:14:22',  // Dell Inc.
  '54:48:10',  // Dell Inc.
  '00:1E:67',  // Intel Corporate
  '6C:92:BF',  // Intel Corporate
  'AC:1F:6B',  // Super Micro Computer
  '0C:42:A1',  // Mellanox Technologies
  'B8:59:9F',  // Mellanox Technologies
])

/**
 * 虚拟化厂商 OUI 黑名单。生成侧与校验侧都引用这一份，
 * 避免两处各写一份然后漂移。
 */
export const VIRTUAL_OUI = Object.freeze({
  '00:50:56': 'VMware',
  '00:0C:29': 'VMware',
  '00:05:69': 'VMware',
  '00:1C:14': 'VMware',
  '52:54:00': 'QEMU/KVM',
  '54:52:00': 'QEMU/KVM',
  '08:00:27': 'VirtualBox',
  '0A:00:27': 'VirtualBox',
  '00:15:5D': 'Hyper-V',
  '00:16:3E': 'Xen',
  '02:42:AC': 'Docker',
  '00:1C:42': 'Parallels',
})

/** 平台默认的宿主机名形态。保持与各平台命名规则一致。 */
export const HOSTNAME_STRATEGY = Object.freeze({
  linux: {
    // AWS 形态，符合 linux.mjs HOSTNAME_RULES['ip-']
    template: (i) => `ip-10-0-${Math.floor(i / 200) + 1}-${(i % 200) + 11}`,
    rule: () => REGISTRY.linux.HOSTNAME_RULES,
  },
  macos: {
    // <LocalHostName>.local，与 normalize 的推导方式一致
    template: (i) => `macos-${String(i + 1).padStart(2, '0')}.local`,
    rule: () => null,
  },
  windows: {
    // NetBIOS ≤ 15 字符，A-Z 0-9 -
    template: (i) => `DESKTOP-${String(i + 1).padStart(2, '0')}${suffix(i)}`,
    rule: () => null,
  },
})

/** 稳定但无规律的三字母后缀，让 Windows 机器名看起来不像序号 */
function suffix(i) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const a = alphabet[i % 26]
  const b = alphabet[Math.floor(i / 26) % 26]
  const c = alphabet[Math.floor(i / 676) % 26]
  return `${a}${b}${c}`
}

/**
 * 把槽位序号转成 vm_id。
 * 固定宽度，保证 claude-01 … claude-20 的字典序等于自然序 —— 排查日志时有用。
 */
export function slotVmId(prefix, index, width = 2) {
  return `${prefix}-${String(index + 1).padStart(width, '0')}`
}

/**
 * overrides 里改主机名。
 *
 * 各平台的命名真值字段名不同，必须分平台写；写错字段名会导致 normalize
 * 之后仍然用默认主机名，于是 N 个槽位撞名 —— 这类错在最终校验里会被抓住，
 * 但这里显式分派可以让它根本不会发生。
 */
export function hostnameOverrides(platform, hostname) {
  if (platform === 'linux') return { naming: { hostname } }
  if (platform === 'macos') {
    const local = String(hostname).replace(/\.local$/, '')
    return { naming: { hostname, local_hostname: local, computer_name: local } }
  }
  if (platform === 'windows') {
    return { naming: { computer_name: String(hostname).toUpperCase() } }
  }
  throw new Error(`unsupported platform: ${platform}`)
}

/** 取 persona 的规范主机名（三平台字段名不同） */
export function canonicalHostname(persona) {
  return String(
    persona.naming?.hostname || persona.naming?.computer_name || '',
  )
}

/** 取 persona 的规范 UUID（三平台字段名不同） */
export function canonicalUuid(persona) {
  return String(
    persona.hardware?.product_uuid || persona.hardware?.uuid || persona.hardware?.hardware_uuid || '',
  )
}

/** 取 persona 的规范序列号（三平台字段名不同） */
export function canonicalSerial(persona) {
  return String(persona.hardware?.product_serial || persona.hardware?.serial_number || '')
}

/**
 * 必须两两不同的字段 vs 应当共享的字段。
 *
 * 这个区分是自洽性的一部分，不是随手挑的：
 *
 *   唯一字段  MAC / UUID / 序列号 / 主机名 / machine-id
 *             —— 这些是「这台机器是谁」的标识，重复就等于承认是同一台。
 *
 *   共享字段  机型 / 厂商 / BIOS 版本与日期 / CPU 型号
 *             —— 同一批采购、同一机型、同一 BIOS 版本，这些本该相同。
 *             20 台机器 BIOS 日期各不相同反而是合成痕迹：没有哪个 IT 部门
 *             会凑齐 20 台不同 BIOS 日期的同型号机器。
 *
 * 所以规划的目标不是「所有字段都不同」，而是「该不同的不同、该相同的相同」。
 */
export const FLEET_UNIQUE_FIELDS = Object.freeze(['mac', 'uuid', 'serial', 'hostname', 'machineId'])
export const FLEET_SHARED_FIELDS = Object.freeze([
  'sys_vendor', 'product_name', 'board_vendor', 'board_name',
  'bios_vendor', 'bios_version', 'bios_date', 'cpu_model',
])

/**
 * 按 runtime 取资源规则。
 *
 * 两套规则的差异不是风格问题：容器的 `--cpus` 是 CFS 配额上限，超订没有成本；
 * 虚拟机的 vCPU 是真实宿主线程，每台还有独立内核与 QEMU 进程的固定开销。
 * 混用同一套规则会把 KVM 规划算得过于乐观。
 */
export function resourceRulesFor(runtime, overrides = {}) {
  const base = runtime === 'kvm' ? KVM_RESOURCE_RULES : RESOURCE_RULES
  return { ...base, ...(overrides || {}) }
}

/** 规范化 runtime 取值。 */
export function normalizeRuntime(value, fallback = 'docker') {
  const raw = String(value ?? '').trim().toLowerCase()
  if (RUNTIMES.includes(raw)) return raw
  if (!raw) return fallback
  throw new Error(`unsupported runtime: ${value} (available: ${RUNTIMES.join(', ')})`)
}

/**
 * 单槽位的规格计算，按 runtime 分派。
 *
 * @returns {{runtime:string, memoryMb:number, cpus:number, diskMb:number, footprintMb:number}}
 */
export function slotSpecFor({ persona, runtime, rules }) {
  if (runtime === 'kvm') {
    return {
      runtime,
      memoryMb: kvmMemoryMb(persona, rules),
      cpus: kvmVcpus(persona, rules),
      diskMb: kvmDiskNominalMb(rules),
      footprintMb: kvmMemoryFootprintMb(persona, rules),
      diskFootprintMb: kvmDiskFootprintMb(rules),
    }
  }
  return {
    runtime,
    memoryMb: memoryLimitMb(persona, rules),
    cpus: cpuLimit(persona, rules),
    diskMb: diskLimitMb(rules),
    footprintMb: memoryLimitMb(persona, rules),
    diskFootprintMb: diskLimitMb(rules),
  }
}

/** KVM 单槽磁盘标称容量（MiB）。qcow2 稀疏，标称不等于实际占用。 */
function kvmDiskNominalMb(rules) {
  return Math.round((rules.diskGb || 0) * 1024)
}

/**
 * 20 个槽位 → 完整规划。
 *
 * @param {object} spec
 * @param {number} spec.count                     槽位数
 * @param {string} spec.platform                  'linux' | 'macos' | 'windows'
 * @param {object} [spec.hostResources]           { memoryMb, cpus, diskMb }
 * @param {string} [spec.vmIdPrefix='claude']      vm_id 前缀
 * @param {string} [spec.outDirRoot]              落地根目录（不落盘，只写进参数）
 * @param {string} [spec.network]                 docker 网络名
 * @param {string} [spec.timezone='UTC']
 * @param {boolean} [spec.allowHostnameCollision=false] 仅调试用
 * @returns {object} 规划结果
 */
export function planFleet(spec = {}) {
  const count = Number(spec.count)
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`count must be a positive integer, got ${spec.count}`)
  }
  const platform = String(spec.platform || 'linux')
  if (!isSupportedPlatform(platform)) {
    throw new Error(`unsupported platform: ${platform} (available: ${PLATFORMS.join(', ')})`)
  }
  const prefix = String(spec.vmIdPrefix || 'claude')
  const width = Math.max(2, String(count).length)
  const strategy = HOSTNAME_STRATEGY[platform]
  const runtime = normalizeRuntime(spec.runtime, 'docker')

  // 允许部署时按实际机器调规格（例如把每槽 CPU 压到 1 核）。
  // 只影响运行配额，不影响 persona 上报的名义硬件 —— 两者本来就是两回事。
  const rules = resourceRulesFor(runtime, spec.resourceRules)

  const slots = []
  for (let i = 0; i < count; i += 1) {
    const vmId = slotVmId(prefix, i, width)
    // 主机名序号按全局偏移走：混合编排时第二组从第一组之后接着数，
    // 否则 claude-01 与 codex-01 会拿到同一个 ip-10-0-1-11。
    const hostname = strategy.template(i + Number(spec.hostnameOffset || 0))
    const overrides = hostnameOverrides(platform, hostname)
    const outDir = spec.outDirRoot
      ? `${String(spec.outDirRoot).replace(/\/+$/, '')}/${platform}/${vmId}`
      : undefined

    const persona = buildPersona({ platform, vmId, overrides })

    if (runtime === 'kvm') {
      slots.push(kvmSlotRecord({
        index: i, vmId, persona, outDir, spec, rules, hostname,
      }))
      continue
    }

    const docker = dockerArgsForPersona({
      platform,
      vmId,
      persona,
      outDir,
      network: spec.network,
      timezone: spec.timezone,
      resourceRules: rules,
    })

    slots.push({
      index: i,
      vmId,
      runtime,
      outDir: docker.outDir,
      hostname: canonicalHostname(persona),
      dockerHostname: docker.dockerHostname,
      mac: docker.mac,
      uuid: canonicalUuid(persona),
      serial: canonicalSerial(persona),
      machineId: persona.machine_id ? String(persona.machine_id) : null,
      memoryMb: docker.memoryMb,
      cpus: docker.cpus,
      diskMb: docker.diskMb,
      footprintMb: docker.memoryMb,
      diskFootprintMb: docker.diskMb,
      advertised: docker.advertised,
      persona,
      docker,
      kvm: null,
    })
  }

  // ───── 唯一性：用集合数一遍，不靠「理论上应该不同」─────
  const uniq = (key) => new Set(slots.map((s) => String(s[key]).toUpperCase()))
  const collisions = []
  for (const key of ['mac', 'uuid', 'serial', 'hostname']) {
    const set = uniq(key)
    if (set.size !== slots.length) {
      const seen = new Map()
      const dupes = []
      for (const s of slots) {
        const k = String(s[key]).toUpperCase()
        if (seen.has(k)) dupes.push({ value: s[key], slots: [seen.get(k), s.vmId] })
        else seen.set(k, s.vmId)
      }
      collisions.push({ field: key, distinct: set.size, total: slots.length, dupes })
    }
  }
  // machine-id 单独处理：Windows / macOS 的 persona 没有 machine_id
  const withMachineId = slots.filter((s) => s.machineId)
  if (withMachineId.length > 0) {
    const set = new Set(withMachineId.map((s) => s.machineId))
    if (set.size !== withMachineId.length) {
      collisions.push({
        field: 'machineId',
        distinct: set.size,
        total: withMachineId.length,
        dupes: [],
      })
    }
  }
  if (collisions.length > 0 && !spec.allowHostnameCollision) {
    const detail = collisions
      .map((c) => `  - ${c.field}: ${c.distinct} 个不同 / ${c.total} 个槽位${c.dupes.length ? `（例：${c.dupes[0].slots.join(' 与 ')}）` : ''}`)
      .join('\n')
    throw new Error(`fleet identity collision:\n${detail}`)
  }

  // ───── 平台命名规则二次校验 ─────
  const hostnameIssues = []
  for (const s of slots) {
    const rules = REGISTRY[platform].HOSTNAME_RULES
    if (!rules) continue
    for (const [p, rule] of Object.entries(rules)) {
      if (s.hostname.startsWith(p) && !rule.pattern.test(s.hostname)) {
        hostnameIssues.push({ vmId: s.vmId, hostname: s.hostname, prefix: p, note: rule.note })
      }
    }
  }

  // ───── 资源汇总 ─────
  //
  // 两套账必须分开报：
  //   memoryMb / diskMb       → 分配给槽位的额度（Docker 的 cgroup 上限 /
  //                             KVM 的客户机内存与盘标称容量）
  //   footprintMb / diskFootprintMb → 宿主机实际要掏出来的量
  // KVM 的这两组数不同：客户机 2.5 GiB 之外还有 QEMU 进程开销；
  // 盘标称 40 GiB 但实际占用只有几 GiB。混成一个数会让规划要么过度保守、
  // 要么上线才发现放不下。
  const totals = {
    count,
    memoryMb: slots.reduce((a, s) => a + s.memoryMb, 0),
    cpus: slots.reduce((a, s) => a + s.cpus, 0),
    diskMb: slots.reduce((a, s) => a + s.diskMb, 0),
    footprintMb: slots.reduce((a, s) => a + (s.footprintMb ?? s.memoryMb), 0),
    diskFootprintMb: slots.reduce((a, s) => a + (s.diskFootprintMb ?? s.diskMb), 0),
    advertisedRamBytes: slots.reduce((a, s) => a + s.advertised.ramBytes, 0),
    advertisedCores: slots.reduce((a, s) => a + s.advertised.logicalCores, 0),
    byRuntime: countByRuntime(slots),
  }
  const perSlot = {
    memoryMb: Math.max(...slots.map((s) => s.memoryMb)),
    cpus: Math.max(...slots.map((s) => s.cpus)),
    diskMb: Math.max(...slots.map((s) => s.diskMb)),
    footprintMb: Math.max(...slots.map((s) => s.footprintMb ?? s.memoryMb)),
    diskFootprintMb: Math.max(...slots.map((s) => s.diskFootprintMb ?? s.diskMb)),
  }

  const host = normalizeHostResources(spec.hostResources)
  const reserve = host
    ? {
        memoryMb: Math.round(host.memoryMb * rules.hostReserveRatio),
        cpus: Math.round(host.cpus * rules.hostReserveRatio),
        diskMb: host.diskMb == null ? null : Math.round(host.diskMb * rules.hostReserveRatio),
      }
    : null

  // 容量校验按实际占用做，不按分配额度做。
  // Docker 槽位的两者相等（额度就是实际上限）；KVM 槽位的实际占用才是
  // 宿主机要承担的部分。
  const demandMemMb = totals.footprintMb
  const demandDiskMb = totals.diskFootprintMb

  const deficits = []
  if (host) {
    const availMem = host.memoryMb - reserve.memoryMb
    const availCpu = host.cpus - reserve.cpus
    const availDisk = host.diskMb == null ? null : host.diskMb - reserve.diskMb
    if (demandMemMb > availMem) {
      deficits.push({
        resource: 'memory',
        needMb: demandMemMb,
        allocatedMb: totals.memoryMb,
        availableMb: availMem,
        shortMb: demandMemMb - availMem,
        message: `内存不足：需要 ${demandMemMb} MiB（含 hypervisor 开销，槽位额度合计 ${totals.memoryMb} MiB），扣除宿主机预留 ${reserve.memoryMb} MiB 后可用 ${availMem} MiB，缺 ${demandMemMb - availMem} MiB`,
      })
    }
    const cpuBudget = Math.floor(availCpu * rules.cpuOversubscribe)
    if (totals.cpus > cpuBudget) {
      const oversubNote = rules.cpuOversubscribe > 1
        ? `（已按 ${rules.cpuOversubscribe}× 超订折算）`
        : ''
      deficits.push({
        resource: 'cpus',
        need: totals.cpus,
        available: cpuBudget,
        short: totals.cpus - cpuBudget,
        message: `CPU 不足：需要 ${totals.cpus} 核，扣除宿主机预留 ${reserve.cpus} 核后可用 ${availCpu} 核${oversubNote}，缺 ${totals.cpus - cpuBudget} 核`,
      })
    }
    if (availDisk != null && demandDiskMb > availDisk) {
      deficits.push({
        resource: 'disk',
        needMb: demandDiskMb,
        allocatedMb: totals.diskMb,
        availableMb: availDisk,
        shortMb: demandDiskMb - availDisk,
        message: `磁盘不足：需要 ${demandDiskMb} MiB（按实际占用估算，标称合计 ${totals.diskMb} MiB），扣除宿主机预留 ${reserve.diskMb} MiB 后可用 ${availDisk} MiB，缺 ${demandDiskMb - availDisk} MiB`,
      })
    }
  }

  // ───── KVM 专属：磁盘路径冲突 ─────
  // 20 个槽位的 diskPath 必须两两不同。相同就是两块 VM 写同一块 qcow2，
  // 后果是文件系统损坏 —— 这种错在规划阶段拦下来，不能留到启动时。
  const diskConflicts = runtime === 'kvm'
    ? detectDiskConflicts(slots.map((s) => ({ vmId: s.vmId, ...(s.kvm?.paths || {}) }))).conflicts
    : []

  return {
    ok: deficits.length === 0 && hostnameIssues.length === 0 && diskConflicts.length === 0,
    runtime,
    platform,
    count,
    vmIdPrefix: prefix,
    slots,
    rules,
    totals,
    perSlot,
    demand: { memoryMb: demandMemMb, diskMb: demandDiskMb },
    diskConflicts,
    host,
    reserve,
    cpuBudget: host ? Math.floor((host.cpus - reserve.cpus) * rules.cpuOversubscribe) : null,
    deficits,
    hostnameIssues,
    collisions,
    uniqueFields: {
      mac: uniq('mac').size,
      uuid: uniq('uuid').size,
      serial: uniq('serial').size,
      hostname: uniq('hostname').size,
      machineId: withMachineId.length ? new Set(withMachineId.map((s) => s.machineId)).size : null,
    },
  }
}

/** 按 runtime 统计槽位数。 */
function countByRuntime(slots) {
  const out = {}
  for (const s of slots) {
    const k = s.runtime || 'docker'
    out[k] = (out[k] || 0) + 1
  }
  return out
}

/**
 * KVM 槽位的规划记录。
 *
 * 与 Docker 槽位的差别体现在三处，都必须在规划阶段就体现：
 *
 *   1. MAC 不用 persona 派生值。persona 的 normalize 用平台 OUI（linux 是
 *      00:50:56），那套值是为容器准备的；KVM 走自己的 OEM 与 OUI 池，
 *      因为虚拟机网卡的 MAC 会被客户机网卡驱动直接读出来。
 *   2. 内存按「客户机内存 + hypervisor 固定开销」算，不是只算客户机内存。
 *      20 台 VM 的 QEMU 进程本身要吃掉可观的内存。
 *   3. 磁盘同时报标称与上界：qcow2 是稀疏文件，40 GiB 标称刚建出来很小，
 *      但会随写入增长。只报其中一个数都会误导容量规划。
 */
function kvmSlotRecord({ index, vmId, persona, outDir, spec, rules, hostname }) {
  const memoryMb = kvmMemoryMb(persona, rules)
  const vcpus = kvmVcpus(persona, rules)
  const diskMb = kvmDiskNominalMb(rules)
  const footprintMb = memoryMb + rules.hypervisorOverheadMb
  const diskFootprintMb = kvmDiskFootprintMb(rules)
  const mac = kvmMacFor(vmId)
  const rootDir = spec.kvmRootDir
    ? String(spec.kvmRootDir).replace(/\/+$/, '')
    : String(spec.outDirRoot || '/var/lib/persona-kvm').replace(/\/+$/, '')
  const paths = kvmPathsFor({ rootDir, vmId })

  const kvm = qemuArgsForPersona({
    persona,
    vmId,
    diskPath: paths.diskPath,
    imagePath: spec.imagePath ? String(spec.imagePath) : null,
    memoryMb,
    vcpus,
    macAddress: mac,
    bridge: spec.bridge || null,
    // commaPolicy 必须能透传：规划层若不能显式选择策略，遇到带逗号的
    // 型号名（Apple 的 MacPro7,1）就只剩「改数据」一条路，而那是错的 ——
    // 逗号是真实内容。默认交给 kvm-spec 决定。
    ...(spec.commaPolicy ? { commaPolicy: String(spec.commaPolicy) } : {}),
    rootDir,
  })

  return {
    index,
    vmId,
    runtime: 'kvm',
    outDir: outDir || paths.slotDir,
    hostname: canonicalHostname(persona) || hostname,
    // KVM 不需要「容器主机名」这种规范化：虚拟机主机名由 cloud-init 与
    // 客户机内核直接持有，没有 RFC 1123 的额外约束。
    dockerHostname: null,
    mac,
    uuid: canonicalUuid(persona),
    serial: canonicalSerial(persona),
    machineId: persona.machine_id ? String(persona.machine_id) : null,
    memoryMb,
    cpus: vcpus,
    diskMb,
    footprintMb,
    diskFootprintMb,
    advertised: {
      ramBytes: Number(persona.hardware?.ram_bytes || 0),
      logicalCores: Number(persona.hardware?.logical_cores || 1),
    },
    persona,
    docker: null,
    diskSerial: kvm.diskSerial,
    instanceId: kvmInstanceIdFor(vmId),
    kvm: {
      ...kvm,
      argv: kvm.argv,
      paths,
      smbiosArgv: kvm.argv.filter((a, i, list) => list[i - 1] === '-smbios'),
    },
  }
}

/**
 * 主机资源归一化。允许 { memoryMb } 或 { memoryGb } 两种写法。
 */
export function normalizeHostResources(h = null) {
  if (!h) return null
  const memoryMb = h.memoryMb
    ?? (h.memoryGb != null ? Number(h.memoryGb) * 1024 : null)
    ?? (h.memoryBytes != null ? Number(h.memoryBytes) / 1024 ** 2 : null)
  const diskMb = h.diskMb
    ?? (h.diskGb != null ? Number(h.diskGb) * 1024 : null)
    ?? (h.diskBytes != null ? Number(h.diskBytes) / 1024 ** 2 : null)
  const cpus = h.cpus ?? h.cpuCores ?? null
  if (memoryMb == null || cpus == null) {
    throw new Error('hostResources 至少要给 memoryMb（或 memoryGb）和 cpus')
  }
  return {
    memoryMb: Math.round(Number(memoryMb)),
    cpus: Math.round(Number(cpus)),
    // null 表示「没给」，与「给了 0」是两件事：前者跳过磁盘校验，
    // 后者意味着这台机器一块盘都没有。混成同一个值会让不关心磁盘的调用方
    // 莫名其妙收到「磁盘不足」。
    diskMb: diskMb == null ? null : Math.round(Number(diskMb)),
  }
}

/**
 * 反算：给定主机资源，最多能放几个槽位。
 *
 * 用于「先看机器能撑几个，再定账号数」，比反复试 planFleet 快。
 */
export function maxSlotsForHost({ platform = 'linux', hostResources, vmIdPrefix = 'probe', resourceRules, runtime = 'docker' } = {}) {
  const host = normalizeHostResources(hostResources)
  const rt = normalizeRuntime(runtime, 'docker')
  const rules = resourceRulesFor(rt, resourceRules)
  // 用第一个槽位当样本。所有槽位规格相同（同一平台同一骨架），一个就够。
  const probe = buildPersona({
    platform,
    vmId: slotVmId(vmIdPrefix, 0),
    overrides: hostnameOverrides(platform, HOSTNAME_STRATEGY[platform].template(0)),
  })
  const spec = slotSpecFor({ persona: probe, runtime: rt, rules })
  const mem = spec.footprintMb
  const cpu = spec.cpus
  const disk = spec.diskFootprintMb
  const availMem = host.memoryMb * (1 - rules.hostReserveRatio)
  const availCpu = host.cpus * (1 - rules.hostReserveRatio) * rules.cpuOversubscribe
  const availDisk = host.diskMb == null ? null : host.diskMb * (1 - rules.hostReserveRatio)
  const limits = [
    { by: 'memory', slots: Math.floor(availMem / mem) },
    { by: 'cpus', slots: Math.floor(availCpu / cpu) },
    { by: 'disk', slots: availDisk == null ? Infinity : Math.floor(availDisk / disk) },
  ]
  const binding = limits.reduce((a, b) => (b.slots < a.slots ? b : a))
  return {
    runtime: rt,
    slots: Math.max(0, binding.slots),
    binding: binding.by,
    perSlot: {
      memoryMb: spec.memoryMb,
      footprintMb: spec.footprintMb,
      cpus: spec.cpus,
      diskMb: spec.diskMb,
      diskFootprintMb: spec.diskFootprintMb,
    },
    available: {
      memoryMb: Math.floor(availMem),
      cpus: Math.floor(availCpu),
      diskMb: availDisk == null ? null : Math.floor(availDisk),
    },
    byResource: limits,
  }
}

/**
 * 混合编排：不同分组走不同 runtime。
 *
 * 用法（用户的实际要求是 Claude 走 KVM、Codex 走 Docker）：
 *
 *   planMixedFleet({
 *     claude: { runtime: 'kvm', count: 20 },
 *     codex:  { runtime: 'docker', count: 2 },
 *   })
 *
 * 三点设计决定，都来自混合场景的真实约束：
 *
 *   1. 身份唯一性跨分组校验，不是分组内校验。两个分组的 vm_id 前缀不同
 *      （claude-01 / codex-01），但主机名 / MAC / UUID 仍可能撞 ——
 *      只要撞了，上游就能把两个槽位关联起来，分组本身没有意义。
 *
 *   2. 主机名序号按「全局偏移」分配。各平台的 HOSTNAME_STRATEGY 都从 0 开始，
 *      两组各自从 0 数必然撞（claude-01 与 codex-01 都是 ip-10-0-1-11）。
 *      所以第二组从第一组的数量之后接着数。
 *
 *   3. 主机资源按「全部分组之和」核对一次，不是每组各自核对。
 *      两组各自都够、合起来不够，是最容易漏掉的情况。
 *
 * @param {object} groups  { [groupName]: { runtime, count, platform?, vmIdPrefix?, resourceRules?, bridge?, imagePath? } }
 * @param {object} [opts]
 * @param {object} [opts.hostResources]
 * @param {string} [opts.platform='linux']
 * @returns {object}
 */
export function planMixedFleet(groups = {}, opts = {}) {
  const names = Object.keys(groups || {})
  if (names.length === 0) throw new Error('planMixedFleet needs at least one group')

  const hostResources = opts.hostResources || null
  const defaultPlatform = String(opts.platform || 'linux')

  const plans = {}
  let hostnameOffset = 0
  for (const name of names) {
    const g = groups[name] || {}
    const runtime = normalizeRuntime(g.runtime, 'docker')
    const count = Number(g.count)
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(`group "${name}" needs a positive integer count, got ${g.count}`)
    }
    plans[name] = planFleet({
      count,
      runtime,
      platform: String(g.platform || defaultPlatform),
      vmIdPrefix: String(g.vmIdPrefix || name),
      outDirRoot: g.outDirRoot,
      kvmRootDir: g.kvmRootDir,
      imagePath: g.imagePath,
      bridge: g.bridge,
      network: g.network,
      timezone: g.timezone,
      resourceRules: g.resourceRules,
      hostResources: null, // 统一在下面算，避免每组各自报「不够」
      allowHostnameCollision: opts.allowHostnameCollision,
      hostnameOffset,
    })
    hostnameOffset += count
  }

  const allSlots = names.flatMap((n) => plans[n].slots.map((s) => ({ ...s, group: n })))

  // ───── 跨分组身份唯一性 ─────
  const crossCollisions = []
  for (const key of ['mac', 'uuid', 'serial', 'hostname']) {
    const seen = new Map()
    const dupes = []
    for (const s of allSlots) {
      const k = String(s[key]).toUpperCase()
      if (seen.has(k)) dupes.push({ value: s[key], slots: [seen.get(k), `${s.group}/${s.vmId}`] })
      else seen.set(k, `${s.group}/${s.vmId}`)
    }
    if (dupes.length > 0) {
      crossCollisions.push({ field: key, dupes })
    }
  }

  // ───── 跨分组磁盘路径唯一性（只有 KVM 分组有 diskPath）─────
  const kvmSlots = allSlots.filter((s) => s.runtime === 'kvm')
  const diskConflicts = detectDiskConflicts(
    kvmSlots.map((s) => ({ vmId: `${s.group}/${s.vmId}`, ...(s.kvm?.paths || {}) })),
  ).conflicts

  // ───── 统一容量核对 ─────
  const totalFootprintMb = allSlots.reduce((a, s) => a + (s.footprintMb ?? s.memoryMb), 0)
  const totalDiskFootprintMb = allSlots.reduce((a, s) => a + (s.diskFootprintMb ?? s.diskMb), 0)
  const totalCpus = allSlots.reduce((a, s) => a + s.cpus, 0)
  const totalAllocatedMb = allSlots.reduce((a, s) => a + s.memoryMb, 0)
  const totalDiskAllocatedMb = allSlots.reduce((a, s) => a + s.diskMb, 0)

  // 统一预留比例取所有分组里最保守的一个。
  const reserveRatio = Math.max(...names.map((n) => plans[n].rules.hostReserveRatio))

  const host = normalizeHostResources(hostResources)
  const deficits = []
  if (host) {
    const availMem = Math.round(host.memoryMb * (1 - reserveRatio))
    const availCpu = Math.round(host.cpus * (1 - reserveRatio))
    const availDisk = host.diskMb == null ? null : Math.round(host.diskMb * (1 - reserveRatio))
    if (totalFootprintMb > availMem) {
      deficits.push({
        resource: 'memory',
        needMb: totalFootprintMb,
        availableMb: availMem,
        shortMb: totalFootprintMb - availMem,
        message: `内存不足：混合编排需要 ${totalFootprintMb} MiB（额度合计 ${totalAllocatedMb} MiB），扣除 ${Math.round(reserveRatio * 100)}% 预留后可用 ${availMem} MiB，缺 ${totalFootprintMb - availMem} MiB`,
      })
    }
    if (totalCpus > availCpu) {
      deficits.push({
        resource: 'cpus',
        need: totalCpus,
        available: availCpu,
        short: totalCpus - availCpu,
        message: `CPU 不足：混合编排需要 ${totalCpus} 核，扣除预留后可用 ${availCpu} 核，缺 ${totalCpus - availCpu} 核`,
      })
    }
    if (availDisk != null && totalDiskFootprintMb > availDisk) {
      deficits.push({
        resource: 'disk',
        needMb: totalDiskFootprintMb,
        availableMb: availDisk,
        shortMb: totalDiskFootprintMb - availDisk,
        message: `磁盘不足：混合编排实际占用约 ${totalDiskFootprintMb} MiB（标称合计 ${totalDiskAllocatedMb} MiB），扣除预留后可用 ${availDisk} MiB，缺 ${totalDiskFootprintMb - availDisk} MiB`,
      })
    }
  }

  const ok = deficits.length === 0
    && crossCollisions.length === 0
    && diskConflicts.length === 0
    && names.every((n) => plans[n].hostnameIssues.length === 0)

  return {
    ok,
    groups: plans,
    groupNames: names,
    slots: allSlots,
    host,
    reserveRatio,
    totals: {
      count: allSlots.length,
      byRuntime: countByRuntime(allSlots),
      memoryMb: totalAllocatedMb,
      footprintMb: totalFootprintMb,
      cpus: totalCpus,
      diskMb: totalDiskAllocatedMb,
      diskFootprintMb: totalDiskFootprintMb,
    },
    crossCollisions,
    diskConflicts,
    deficits,
  }
}

/**
 * 规划 + 落盘。
 *
 * KVM 槽位不落 persona 树：那些文件在容器里是「伪造层」，在虚拟机里没有意义
 * —— 客户机的 /sys/class/dmi/id/* 由内核按 SMBIOS 表生成，写文件过去只会
 * 与真实值冲突。所以 KVM 槽位只把 seed ISO / 盘路径算出来，不写 persona 树。
 */
export async function materializeFleet(spec = {}) {
  const { materializePersonaTree } = await import('./docker-spec.mjs')
  const plan = planFleet(spec)
  const materialized = []
  for (const slot of plan.slots) {
    if ((slot.runtime || 'docker') === 'kvm') {
      materialized.push({
        vmId: slot.vmId,
        runtime: 'kvm',
        hostname: slot.hostname,
        mac: slot.mac,
        outDir: slot.kvm.paths.slotDir,
        files: 0,
        argv: slot.kvm.argv,
        skipped: 'kvm 槽位的硬件由 QEMU 提供，不落 persona 文件树',
      })
      continue
    }
    const m = materializePersonaTree({
      platform: plan.platform,
      vmId: slot.vmId,
      outDir: slot.outDir,
      // overrides 必须带上：planFleet 已经把每个槽位的主机名算进 overrides，
      // 落盘时丢掉它，20 棵树的 /etc/hostname 会全是平台默认值 —— 身份在
      // 「规划表」里不同、在「真实文件」里相同，这是最难查的一类不一致。
      overrides: hostnameOverrides(plan.platform, slot.hostname),
      network: spec.network,
      timezone: spec.timezone,
      resourceRules: spec.resourceRules,
    })
    materialized.push({
      vmId: slot.vmId,
      runtime: 'docker',
      hostname: slot.hostname,
      mac: slot.mac,
      outDir: slot.outDir,
      files: m.written.length,
      args: m.args,
      env: m.env,
      mounts: m.mounts,
    })
  }
  return { ...plan, materialized }
}

/**
 * 生成一份总清单（JSON），供部署脚本直接读取。
 *
 * 按 runtime 出不同的字段组：docker 槽位给 args/env/mounts，kvm 槽位给
 * qemu argv / diskPath / pidFile。两者都塞进同一个 `args` 字段会让消费方
 * 分不清那是 `docker run` 的参数还是 QEMU 的参数。
 */
export function fleetManifest(plan) {
  return {
    runtime: plan.runtime || 'docker',
    platform: plan.platform,
    count: plan.count,
    ok: plan.ok,
    generatedAt: new Date().toISOString(),
    totals: plan.totals,
    perSlot: plan.perSlot,
    demand: plan.demand || null,
    host: plan.host,
    reserve: plan.reserve,
    deficits: plan.deficits,
    diskConflicts: plan.diskConflicts || [],
    slots: plan.slots.map((s) => {
      const base = {
        vmId: s.vmId,
        runtime: s.runtime || 'docker',
        hostname: s.hostname,
        mac: s.mac,
        uuid: s.uuid,
        serial: s.serial,
        machineId: s.machineId,
        memoryMb: s.memoryMb,
        cpus: s.cpus,
        diskMb: s.diskMb,
        footprintMb: s.footprintMb ?? null,
        diskFootprintMb: s.diskFootprintMb ?? null,
        outDir: s.outDir,
      }
      if ((s.runtime || 'docker') === 'kvm') {
        return {
          ...base,
          diskSerial: s.diskSerial,
          instanceId: s.instanceId,
          qemu: {
            argv: s.kvm.argv,
            commandLine: shellJoin(s.kvm.argv),
            diskPath: s.kvm.paths.diskPath,
            seedIsoPath: s.kvm.paths.seedIsoPath,
            pidFile: s.kvm.paths.pidFile,
            logPath: s.kvm.paths.logPath,
            qmpSocket: s.kvm.paths.qmpSocket,
          },
          smbios: s.kvm.smbios,
          warnings: s.kvm.warnings,
        }
      }
      return {
        ...base,
        dockerHostname: s.dockerHostname,
        args: s.docker.args,
        env: s.docker.env,
        mounts: s.docker.mounts.map((m) => ({
          containerPath: m.containerPath,
          hostPath: m.hostPath,
          mode: m.mode,
          role: m.role,
        })),
      }
    }),
  }
}

/** 把单个槽位的 QEMU 命令行渲染出来（展示 / 审计用）。 */
export function slotQemuCommand(slot) {
  const argv = slot?.kvm?.argv
  if (!Array.isArray(argv)) throw new Error(`slot ${slot?.vmId} is not a kvm slot`)
  return shellJoin(argv)
}
