/**
 * Linux persona
 *
 * Linux 身份在这三组地方被看到，全部必须一致：
 *
 *   DMI/SMBIOS   /sys/class/dmi/id/{sys_vendor,product_name,product_serial,product_uuid,
 *                board_vendor,board_name,bios_vendor,bios_version,bios_date,chassis_*}
 *   系统文件     /etc/machine-id、/var/lib/dbus/machine-id、/etc/hostname、/etc/hosts
 *   命令         uname -a、hostnamectl、lscpu、free、lsblk、lspci
 *
 * 与 macOS/Windows 的差异：
 *   - machine-id 是 32 位小写 hex（不是 UUID，也不是注册表项）
 *   - hostname 常带云厂商后缀（如 ip-10-0-1-23、VM-4-12-ubuntu）
 *   - 同一台机器上 /etc/machine-id 与 /var/lib/dbus/machine-id 必须完全相同
 */

import { deriveSerial, deriveUuid, deriveMac, deriveHex32 } from './derive.mjs'
import { LINUX_OUI_POOL } from './fleet-plan.mjs'

export const KEY = 'linux'

/** 默认骨架：Dell PowerEdge R750，服务器常见配置 */
export const DEFAULTS = Object.freeze({
  platform: 'linux',

  // 骨架只是兜底。**实际值由 buildPersona 按 vmId 覆盖**（见
  // softwareForSlot），因为写死的默认值有两个硬伤：
  //   1. 20 个槽全一样 —— 那正是要消除的问题
  //   2. Ubuntu 24.04 + 6.8 内核 与宿主实际 5.15 矛盾 —— 改之前
  //      这里报 6.8.0-45-generic，而容器内 uname -r 是 5.15.0-164，
  //      两者放在一起就是"改了但没改干净"
  software: {
    distro_id: 'ubuntu',
    distro_name: 'Ubuntu',
    distro_version: '22.04.4 LTS',
    distro_codename: 'jammy',
    kernel_release: '5.15.0-91-generic',
    kernel_version: '#101-Ubuntu SMP Tue Nov 14 13:30:08 UTC 2023',
    arch: 'x86_64',
    libc: 'glibc 2.35',
  },

  hardware: {
    sys_vendor: 'Dell Inc.',
    product_name: 'PowerEdge R750',
    product_family: 'PowerEdge',
    product_serial: 'J7K2RM3',
    product_uuid: '4c4c4544-004a-3710-804a-b7c04f324d33',
    product_version: 'Not Specified',
    board_vendor: 'Dell Inc.',
    board_name: '0P4XX8',
    board_serial: '.J7K2RM3.CN123456789012.',
    board_version: 'A01',
    bios_vendor: 'Dell Inc.',
    bios_version: '1.9.2',
    bios_date: '09/12/2024',
    chassis_vendor: 'Dell Inc.',
    chassis_type: '23',
    chassis_serial: 'J7K2RM3',
    cpu_model: 'Intel(R) Xeon(R) Silver 4314 CPU @ 2.40GHz',
    cpu_vendor: 'GenuineIntel',
    cpu_family: '6',
    cpu_model_id: '106',
    cpu_stepping: '7',
    physical_cores: 16,
    logical_cores: 32,
    ram_bytes: 64 * 1024 ** 3,
    dimms: [
      { locator: 'A1', size_bytes: 32 * 1024 ** 3, speed_mts: 3200, type: 'DDR4' },
      { locator: 'A2', size_bytes: 32 * 1024 ** 3, speed_mts: 3200, type: 'DDR4' },
    ],
    disks: [
      { device: 'sda', model: 'Dell Virtual Disk', size_bytes: 480 * 1024 ** 3, rotational: false, serial: 'DELLVD0001' },
    ],
  },

  network: {
    // 云主机常见 Intel X710 / virtio
    interface: 'ens192',
    mac: '00:50:56:9a:3c:11',
    mac_source: 'vm-assigned',
  },

  naming: {
    // hostname 与 machine-id 有强关联：常见做法是带一段稳定后缀
    hostname: 'ip-10-0-1-23',
    domain: '',
  },

  storage: {
    root_fs: 'ext4',
    root_size_bytes: 480 * 1024 ** 3,
    root_used_bytes: 38 * 1024 ** 3,
  },
})

/** 已知云厂商的 hostname 形态，用于校验 hostname 是否符合其命名规则 */
export const HOSTNAME_RULES = Object.freeze({
  'ip-': { pattern: /^ip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}$/, note: 'AWS 内网主机名形如 ip-10-0-1-23' },
  'VM-': { pattern: /^VM-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}$/, note: 'Azure 主机名形如 VM-4-12-1-23' },
})

/**
 * 补全派生字段。
 *
 * product_serial / product_uuid / machine_id / MAC 全部从 vm_id 派生。
 * 逐一派生而不是只派生 machine_id，是因为 DMI 序列号与 machine-id
 * 在上游日志里都会出现，两者若能互相推出关系也是关联特征。
 */
export function normalize(input) {
  const p = structuredClone(input)
  const vmId = String(p.vm_id || 'default')

  if (p.hardware) {
    p.hardware.product_serial = deriveSerial(vmId, 7, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'lnx-product-serial')
    p.hardware.board_serial = `.${p.hardware.product_serial}.CN${deriveHex32(vmId, 'lnx-board').slice(0, 12).toUpperCase()}.`
    p.hardware.chassis_serial = p.hardware.product_serial
    p.hardware.product_uuid = deriveUuid(vmId, 'lnx-product-uuid')
  }
  if (p.network) {
    // VMware OUI：00:50:56（云主机常见）
    // OUI 不能用 00:50:56（VMware）—— 那等于在 MAC 里写"我是虚拟机"。
    // 按 vmId 从真实厂商池里选，20 个槽前缀自然分散。
    {
      const pool = LINUX_OUI_POOL
      let h = 0x811c9dc5
      const key = String(vmId)
      for (let i = 0; i < key.length; i += 1) {
        h ^= key.charCodeAt(i)
        h = Math.imul(h, 0x01000193) >>> 0
      }
      p.network.mac = deriveMac(vmId, pool[h % pool.length])
    }
  }
  if (Array.isArray(p.hardware?.disks)) {
    p.hardware.disks = p.hardware.disks.map((d, i) => ({
      ...d,
      serial: deriveSerial(vmId, 10, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', `lnx-disk-${i}`),
    }))
  }

  // 内存以 DIMM 之和为准
  if (Array.isArray(p.hardware?.dimms) && p.hardware.dimms.length > 0) {
    const sum = p.hardware.dimms.reduce((a, d) => a + Number(d.size_bytes || 0), 0)
    if (sum > 0) p.hardware.ram_bytes = sum
  }

  // machine-id 从 product_uuid 确定性派生（32 位小写 hex）
  if (!p.machine_id && p.hardware?.product_uuid) {
    p.machine_id = machineIdFromUuid(p.hardware.product_uuid)
  }

  // 磁盘总量以 disks 之和为准
  if (Array.isArray(p.hardware?.disks) && p.hardware.disks.length > 0) {
    const sum = p.hardware.disks.reduce((a, d) => a + Number(d.size_bytes || 0), 0)
    if (sum > 0 && !p.storage?.root_size_bytes) p.storage.root_size_bytes = sum
  }

  return p
}

/** persona 内部约束检查 */
export function validate(p) {
  const issues = []

  // machine-id 格式
  if (!/^[0-9a-f]{32}$/.test(String(p.machine_id || ''))) {
    issues.push({
      code: 'machine_id_format',
      text: `machine-id "${p.machine_id}" 必须是 32 位小写十六进制`,
    })
  }

  // product_uuid 是小写 UUID
  if (p.hardware?.product_uuid &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.hardware.product_uuid)) {
    issues.push({
      code: 'product_uuid_format',
      text: 'hardware.product_uuid 必须是小写 UUID 形态',
    })
  }

  // hostname 合法性（RFC 1123）
  const hn = String(p.naming?.hostname || '')
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(hn)) {
    issues.push({
      code: 'hostname_invalid',
      text: `hostname "${hn}" 不符合 RFC 1123`,
    })
  }

  // 若 hostname 看起来像云厂商命名，必须匹配其规则
  for (const [prefix, rule] of Object.entries(HOSTNAME_RULES)) {
    if (hn.startsWith(prefix) && !rule.pattern.test(hn)) {
      issues.push({
        code: 'hostname_cloud_pattern',
        text: `hostname "${hn}" 以 ${prefix} 开头但不匹配规则（${rule.note}）`,
      })
    }
  }

  // 核心数关系
  if (p.hardware?.physical_cores && p.hardware?.logical_cores &&
      p.hardware.logical_cores < p.hardware.physical_cores) {
    issues.push({
      code: 'core_count_order',
      text: `逻辑核 ${p.hardware.logical_cores} 小于物理核 ${p.hardware.physical_cores}`,
    })
  }

  // 内存与 DIMM 自洽
  if (Array.isArray(p.hardware?.dimms) && p.hardware.dimms.length > 0) {
    const sum = p.hardware.dimms.reduce((a, d) => a + Number(d.size_bytes || 0), 0)
    if (sum !== p.hardware.ram_bytes) {
      issues.push({
        code: 'ram_dimms_mismatch',
        text: `ram_bytes ${p.hardware.ram_bytes} 与 DIMM 之和 ${sum} 不一致`,
      })
    }
  }

  // 根分区用量
  if (p.storage && Number(p.storage.root_used_bytes) > Number(p.storage.root_size_bytes)) {
    issues.push({
      code: 'root_used_exceeds_size',
      text: `根分区已用 ${p.storage.root_used_bytes} 超过总容量 ${p.storage.root_size_bytes}`,
    })
  }

  // MAC 单播
  if (p.network?.mac) {
    const first = parseInt(String(p.network.mac).slice(0, 2), 16)
    if (first & 0x01) {
      issues.push({ code: 'mac_multicast', text: `MAC ${p.network.mac} 是组播地址` })
    }
  }

  return issues
}

export function warnings(p) {
  const out = []
  const first = parseInt(String(p.network?.mac || '').slice(0, 2), 16)
  if (first & 0x02) {
    out.push({
      code: 'mac_local_administered',
      text: `MAC ${p.network.mac} 是本地管理地址，真机网卡通常用厂商 OUI`,
    })
  }
  // 物理核心数与 CPU 型号是否匹配（Xeon Silver 4314 是 16C32T）
  if (/4314/.test(p.hardware?.cpu_model || '') &&
      (p.hardware.physical_cores !== 16 || p.hardware.logical_cores !== 32)) {
    out.push({
      code: 'cpu_cores_suspect',
      text: 'Xeon Silver 4314 是 16 核 32 线程，当前核心数与该型号不符',
    })
  }
  return out
}

/** 渲染全部视图 */
export function render(p) {
  const hw = p.hardware
  const sw = p.software
  const nm = p.naming
  const net = p.network
  const st = p.storage

  const commands = {}

  // ── uname ──
  commands['uname -s'] = 'Linux'
  commands['uname -r'] = sw.kernel_release
  commands['uname -m'] = sw.arch
  commands['uname -n'] = nm.hostname
  commands['uname -a'] =
    `Linux ${nm.hostname} ${sw.kernel_release} ${sw.kernel_version} ${sw.arch} ${sw.arch} ${sw.arch} GNU/Linux`

  // ── hostnamectl ──
  commands.hostnamectl = [
    ` Static hostname: ${nm.hostname}`,
    `       Icon name: computer-server`,
    `         Chassis: server`,
    `        Machine ID: ${p.machine_id}`,
    `           Boot ID: ${bootIdFromMachineId(p.machine_id)}`,
    `  Operating System: ${sw.distro_name} ${sw.distro_version}`,
    `            Kernel: Linux ${sw.kernel_release}`,
    `      Architecture: ${sw.arch}`,
  ].join('\n')

  commands.hostname = nm.hostname

  // ── lscpu ──
  commands.lscpu = [
    `Architecture:            ${sw.arch}`,
    `  CPU op-mode(s):        32-bit, 64-bit`,
    `  Byte Order:            Little Endian`,
    `CPU(s):                  ${hw.logical_cores}`,
    `  On-line CPU(s) list:   0-${hw.logical_cores - 1}`,
    `Vendor ID:               ${hw.cpu_vendor}`,
    `  Model name:            ${hw.cpu_model}`,
    `    CPU family:          ${hw.cpu_family}`,
    `    Model:               ${hw.cpu_model_id}`,
    `    Stepping:            ${hw.cpu_stepping}`,
    `Thread(s) per core:    ${Math.round(hw.logical_cores / hw.physical_cores)}`,
    `Core(s) per socket:    ${hw.physical_cores}`,
    `Socket(s):             1`,
  ].join('\n')

  // ── free ──
  const totalKb = Math.round(hw.ram_bytes / 1024)
  const usedKb = Math.round(totalKb * 0.18)
  const freeKb = Math.round(totalKb * 0.62)
  const availKb = Math.round(totalKb * 0.74)
  const buffKb = totalKb - usedKb - freeKb
  commands.free = [
    '               total        used        free      shared  buff/cache   available',
    `Mem:        ${totalKb}     ${usedKb}     ${freeKb}        ${Math.round(totalKb * 0.004)}     ${buffKb}     ${availKb}`,
    `Swap:       ${Math.round(totalKb * 0.25)}           0     ${Math.round(totalKb * 0.25)}`,
  ].join('\n')

  // ── lsblk / df ──
  const rootGb = (st.root_size_bytes / 1000 ** 3).toFixed(1)
  commands.lsblk = [
    'NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS',
    `sda      8:0    0 ${rootGb}G  0 disk`,
    `└─sda1   8:1    0 ${rootGb}G  0 part /`,
  ].join('\n')

  commands['df -h'] = [
    'Filesystem      Size  Used Avail Use% Mounted on',
    `/dev/sda1       ${(st.root_size_bytes / 1024 ** 3).toFixed(0)}G  ${(st.root_used_bytes / 1024 ** 3).toFixed(0)}G  ${((st.root_size_bytes - st.root_used_bytes) / 1024 ** 3).toFixed(0)}G   ${Math.round((st.root_used_bytes / st.root_size_bytes) * 100)}% /`,
    `tmpfs            ${Math.round(hw.ram_bytes / 1024 ** 3 / 2)}G     0  ${Math.round(hw.ram_bytes / 1024 ** 3 / 2)}G   0% /dev/shm`,
  ].join('\n')

  // ── 网卡 ──
  commands['ip link show'] = [
    `2: ${net.interface}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000`,
    `    link/ether ${net.mac} brd ff:ff:ff:ff:ff:ff`,
  ].join('\n')

  // ── DMI 视图 ──
  const dmi = {
    sys_vendor: hw.sys_vendor,
    product_name: hw.product_name,
    product_family: hw.product_family,
    product_serial: hw.product_serial,
    product_uuid: hw.product_uuid,
    product_version: hw.product_version,
    board_vendor: hw.board_vendor,
    board_name: hw.board_name,
    board_serial: hw.board_serial,
    board_version: hw.board_version,
    bios_vendor: hw.bios_vendor,
    bios_version: hw.bios_version,
    bios_date: hw.bios_date,
    chassis_vendor: hw.chassis_vendor,
    chassis_type: hw.chassis_type,
    chassis_serial: hw.chassis_serial,
  }

  for (const [k, v] of Object.entries(dmi)) {
    commands[`cat /sys/class/dmi/id/${k}`] = `${v}\n`
  }

  // ── 落盘文件 ──
  const files = {
    'etc/machine-id': `${p.machine_id}\n`,
    'var/lib/dbus/machine-id': `${p.machine_id}\n`,
    'etc/hostname': `${nm.hostname}\n`,
    'etc/hosts': [
      '127.0.0.1\tlocalhost',
      `127.0.1.1\t${nm.hostname}`,
      '',
      '::1\tlocalhost ip6-localhost ip6-loopback',
      'ff02::1\tip6-allnodes',
      'ff02::2\tip6-allrouters',
      '',
    ].join('\n'),
    'etc/os-release': renderOsRelease(sw),
    ...Object.fromEntries(
      Object.entries(dmi).map(([k, v]) => [`sys/class/dmi/id/${k}`, `${v}\n`]),
    ),
    'etc/persona.json': `${JSON.stringify(p, null, 2)}\n`,
  }

  return { files, commands }
}

/**
 * 跨视图一致性检查。
 *
 * Linux 上最容易被抓的两处：
 *   1. /etc/machine-id 与 /var/lib/dbus/machine-id 不一致
 *   2. DMI 的 product_serial 与 board_serial 自相矛盾
 */
export function validateViews({ persona: p, files, commands }) {
  const issues = []

  // 1. 两个 machine-id 必须完全相同
  const mid = (files['etc/machine-id'] || '').trim()
  const dbus = (files['var/lib/dbus/machine-id'] || '').trim()
  if (mid && dbus && mid !== dbus) {
    issues.push({
      code: 'machine_id_files_mismatch',
      text: `/etc/machine-id "${mid}" 与 /var/lib/dbus/machine-id "${dbus}" 不一致`,
      views: ['etc/machine-id', 'var/lib/dbus/machine-id'],
    })
  }
  if (mid && mid !== p.machine_id) {
    issues.push({
      code: 'machine_id_persona_mismatch',
      text: `/etc/machine-id "${mid}" 与 persona.machine_id "${p.machine_id}" 不一致`,
      views: ['etc/machine-id', 'persona.machine_id'],
    })
  }
  // hostnamectl 报的 Machine ID 必须相同
  const hm = String(commands.hostnamectl || '').match(/Machine ID:\s*([0-9a-f]{32})/)
  if (hm && hm[1] !== p.machine_id) {
    issues.push({
      code: 'hostnamectl_machine_id_mismatch',
      text: `hostnamectl 报 Machine ID "${hm[1]}"，与 persona 不一致`,
      views: ['hostnamectl', 'persona.machine_id'],
    })
  }

  // 2. hostname：uname -n / hostname / /etc/hostname / hostnamectl 四处一致
  const hostViews = [
    ['uname -n', commands['uname -n']],
    ['hostname', commands.hostname],
    ['etc/hostname', (files['etc/hostname'] || '').trim()],
  ]
  for (const [view, value] of hostViews) {
    if (value && value !== p.naming.hostname) {
      issues.push({
        code: 'hostname_view_mismatch',
        text: `${view} 得到 "${value}"，但 persona.hostname 是 "${p.naming.hostname}"`,
        views: [view],
      })
    }
  }
  const sh = String(commands.hostnamectl || '').match(/Static hostname:\s*(\S+)/)
  if (sh && sh[1] !== p.naming.hostname) {
    issues.push({
      code: 'hostnamectl_hostname_mismatch',
      text: `hostnamectl Static hostname "${sh[1]}" 与 persona 不一致`,
      views: ['hostnamectl'],
    })
  }

  // 3. DMI 与 persona 逐字段一致
  const dmiMap = {
    product_serial: p.hardware.product_serial,
    product_uuid: p.hardware.product_uuid,
    sys_vendor: p.hardware.sys_vendor,
    product_name: p.hardware.product_name,
    board_vendor: p.hardware.board_vendor,
    board_name: p.hardware.board_name,
    bios_vendor: p.hardware.bios_vendor,
    bios_version: p.hardware.bios_version,
  }
  for (const [field, expect] of Object.entries(dmiMap)) {
    const fromFile = (files[`sys/class/dmi/id/${field}`] || '').trim()
    const fromCmd = String(commands[`cat /sys/class/dmi/id/${field}`] || '').trim()
    if (fromFile && fromFile !== String(expect)) {
      issues.push({
        code: `dmi_file_${field}`,
        text: `sys/class/dmi/id/${field} 文件值 "${fromFile}" 与 persona "${expect}" 不一致`,
        views: [`sys/class/dmi/id/${field}`],
      })
    }
    if (fromCmd && fromCmd !== String(expect)) {
      issues.push({
        code: `dmi_cmd_${field}`,
        text: `cat /sys/class/dmi/id/${field} 输出 "${fromCmd}" 与 persona "${expect}" 不一致`,
        views: [`cat /sys/class/dmi/id/${field}`],
      })
    }
  }

  // 4. 内核版本：uname -r / uname -a / hostnamectl 一致
  if (!String(commands['uname -a']).includes(p.software.kernel_release)) {
    issues.push({
      code: 'uname_a_kernel_mismatch',
      text: 'uname -a 里没有出现 persona 的内核版本',
      views: ['uname -a'],
    })
  }
  if (!String(commands.hostnamectl).includes(p.software.kernel_release)) {
    issues.push({
      code: 'hostnamectl_kernel_mismatch',
      text: 'hostnamectl 里没有出现 persona 的内核版本',
      views: ['hostnamectl'],
    })
  }

  // 5. 核心数：lscpu 与 persona 一致
  const lscpuCores = String(commands.lscpu || '').match(/^CPU\(s\):\s*(\d+)/m)
  if (lscpuCores && Number(lscpuCores[1]) !== p.hardware.logical_cores) {
    issues.push({
      code: 'lscpu_cores_mismatch',
      text: `lscpu 报 ${lscpuCores[1]} 个 CPU，与 persona ${p.hardware.logical_cores} 不一致`,
      views: ['lscpu'],
    })
  }

  // 6. 内存：free 的 total 与 persona 一致（±1%）
  const freeTotal = String(commands.free || '').match(/^Mem:\s*(\d+)/m)
  if (freeTotal) {
    const expectKb = Math.round(p.hardware.ram_bytes / 1024)
    if (Math.abs(Number(freeTotal[1]) - expectKb) / expectKb > 0.01) {
      issues.push({
        code: 'free_memory_mismatch',
        text: `free 报 total ${freeTotal[1]} KB，与 persona ${expectKb} KB 不一致`,
        views: ['free'],
      })
    }
  }

  // 7. MAC：ip link 与 persona 一致
  const ipMac = String(commands['ip link show'] || '').match(/link\/ether\s+([0-9a-f:]{17})/i)
  if (ipMac && ipMac[1].toLowerCase() !== String(p.network.mac).toLowerCase()) {
    issues.push({
      code: 'mac_view_mismatch',
      text: `ip link 得到 MAC "${ipMac[1]}"，与 persona "${p.network.mac}" 不一致`,
      views: ['ip link show'],
    })
  }

  // 8. 根分区容量：df 与 persona 一致
  const dfLine = String(commands['df -h'] || '').split('\n')[1] || ''
  const dfSize = (dfLine.match(/\s(\d+)G\s/) || [])[1]
  if (dfSize) {
    const expectGb = Math.round(p.storage.root_size_bytes / 1024 ** 3)
    if (Math.abs(Number(dfSize) - expectGb) > 1) {
      issues.push({
        code: 'df_capacity_mismatch',
        text: `df 报根分区 ${dfSize}G，与 persona ${expectGb}G 不一致`,
        views: ['df -h'],
      })
    }
  }

  return issues
}

// ─────────────── 内部辅助 ───────────────

/**
 * machine-id 从 SMBIOS UUID 确定性派生。
 *
 * 真实 Linux 上 machine-id 是 systemd 首次启动时随机生成的，
 * 但重建容器时如果随机，每次都会变，导致上层看到的指纹漂移。
 * 这里做成确定性派生：同一个 product_uuid 恒得同一个 machine-id。
 */
export function machineIdFromUuid(uuid) {
  const clean = String(uuid || '').replace(/-/g, '').toLowerCase()
  // 十六进制转置：保证输出仍是 32 位 hex，且不等于原值
  const out = []
  for (let i = 0; i < 32; i += 1) {
    out.push(clean[(i * 7 + 3) % 32])
  }
  return out.join('')
}

/** Boot ID 从 machine-id 派生（真实值是每次启动随机，这里确定性化） */
export function bootIdFromMachineId(machineId) {
  const h = String(machineId || '').padEnd(32, '0')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function renderOsRelease(sw) {
  return [
    `PRETTY_NAME="${sw.distro_name} ${sw.distro_version}"`,
    `NAME="${sw.distro_name}"`,
    `VERSION_ID="${sw.distro_version.split(' ')[0]}"`,
    `VERSION="${sw.distro_version} (${sw.distro_codename})"`,
    `VERSION_CODENAME=${sw.distro_codename}`,
    `ID=${sw.distro_id}`,
    `ID_LIKE=debian`,
    `HOME_URL="https://www.ubuntu.com/"`,
    `SUPPORT_URL="https://help.ubuntu.com/"`,
    `BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"`,
    '',
  ].join('\n')
}
