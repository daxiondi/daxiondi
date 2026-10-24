/**
 * macOS persona
 *
 * 一个 macOS 身份会在这些地方被看到，全部必须一致：
 *
 *   uname()                  sysname / nodename / release / version / machine
 *   sw_vers                  产品名 / 版本 / 构建号
 *   scutil --get ComputerName / LocalHostName / HostName
 *   system_profiler SPHardwareDataType
 *   ioreg -l                 硬件树
 *   /etc/hostname
 *   diskutil list / df -h    磁盘布局
 *
 * 关键做法：以上全部从同一份 persona 渲染，不允许任何视图自己存字符串副本。
 * 曾经踩过的两个坑（现在由 validateViews 系统性拦住）：
 *   - uname 的 nodename 与 persona.hostname 不一致
 *   - smc_version 留空
 */

import { deriveSerial, deriveUuidUpper, deriveMac } from './derive.mjs'

export const KEY = 'macos'

/** 默认骨架：Mac Pro (2019)，最常见的 CI/桌面机型 */
export const DEFAULTS = Object.freeze({
  platform: 'macos',

  software: {
    product_name: 'macOS',
    product_version: '14.5',
    build_version: '23F79',
    kernel_release: '23.5.0',
    kernel_version:
      'Darwin Kernel Version 23.5.0: Wed May  1 20:09:52 PDT 2024; root:xnu-10063.121.3~5/RELEASE_X86_64',
    arch: 'x86_64',
  },

  hardware: {
    model_identifier: 'MacPro7,1',
    marketing_name: 'Mac Pro',
    board_id: 'Mac-27AD2F918AE68F61',
    boot_rom_version: '1968.140.7.0.0',
    smc_version: '1.0 (iBridge: 21.16.3052.0.0,0)',
    serial_number: 'C07HT5GZP7QN',
    mlb_serial: 'C0722456F4HM93BM2',
    hardware_uuid: '62902C93-564D-4389-9A28-F01898B558DD',
    physical_cores: 8,
    logical_cores: 16,
    cpu_brand: 'Intel(R) Xeon(R) W-3223 CPU @ 3.50GHz',
    ram_bytes: 32 * 1024 ** 3,
    dimms: [
      { slot: 'DIMM1', size_bytes: 16 * 1024 ** 3, speed: '2933 MHz', type: 'DDR4 ECC' },
      { slot: 'DIMM2', size_bytes: 16 * 1024 ** 3, speed: '2933 MHz', type: 'DDR4 ECC' },
    ],
  },

  network: {
    // mac 与 en0_mac 是同一个值的两个名字（Windows/Linux 用 mac，macOS 用 en0_mac）。
    // 从 VM 分配继承，宿主网络栈与 guest 内必须一致。
    mac: 'F0:18:98:B5:58:DD',
    en0_mac: 'F0:18:98:B5:58:DD',
    mac_source: 'vm-assigned',
  },

  naming: {
    // 唯一的主机名真值。uname / scutil / /etc/hostname 全部从这里派生。
    computer_name: 'Mac Pro',
    hostname: 'MacPro7,1.local',
    local_hostname: 'MacPro7,1',
  },

  volume: {
    size_bytes: 8 * 1024 ** 3,
    name: 'Macintosh HD',
    filesystem: 'apfs',
    physical_disk: 'disk0',
    container_device: 'disk1',
    system_volume: 'disk1s1',
    data_volume: 'disk1s2',
  },
})

/** APFS 固定切片（系统盘各分区的最小占用） */
export const APFS_SLICES = Object.freeze({
  system: 512 * 1024 ** 2,
  data: 1024 ** 3,
  preboot: 64 * 1024 ** 2,
  recovery: 256 * 1024 ** 2,
  vm: 64 * 1024 ** 2,
})

/** 已知机型 → 主板 ID 对照。用于校验机型与主板是否匹配。 */
export const KNOWN_BOARDS = Object.freeze({
  'MacPro7,1': 'Mac-27AD2F918AE68F61',
  'MacPro6,1': 'Mac-F60DEB81FF30ACF6',
  'iMac20,1': 'Mac-CFF7D910A743CAAF',
  'iMacPro1,1': 'Mac-7BA5B2D9E42DDD94',
  'MacBookPro16,1': 'Mac-E1008331FDC96864',
  'MacBookPro18,3': 'Mac-7DF21CB3ED6977E5',
  'Macmini9,1': 'Mac-8ED6AF5B48C039E1',
  'MacBookAir10,1': 'Mac-4B682C642B45593E',
})

/**
 * 补全派生字段，并做规范化。
 *
 * 序列号、MLB、hardware_uuid、MAC 全部从 vm_id 派生：
 *   - 同一 vm_id 恒得同一组值，重建容器不漂移
 *   - 不同 vm_id 得不同值，避免一批 VM 共用同一硬件指纹
 */
export function normalize(input) {
  const p = structuredClone(input)
  const vmId = String(p.vm_id || 'default')

  if (p.hardware) {
    // Apple 序列号 12 位，字母数字；MLB 17 位
    p.hardware.serial_number = deriveSerial(vmId, 12, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789', 'apple-serial')
    p.hardware.mlb_serial = deriveSerial(vmId, 17, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789', 'apple-mlb')
    p.hardware.hardware_uuid = deriveUuidUpper(vmId, 'apple-hw-uuid')
  }
  if (p.network) {
    // Apple OUI：F0:18:98 是真实在用的前缀
    p.network.mac = deriveMac(vmId, 'F0:18:98')
    // en0 是 macOS 的网卡名；两者是同一个值的两个名字，必须同步
    p.network.en0_mac = p.network.mac
  }

  // 内存总量与 DIMM 必须自洽：以 DIMM 之和为准，避免两处各写一个数
  if (Array.isArray(p.hardware?.dimms) && p.hardware.dimms.length > 0) {
    const sum = p.hardware.dimms.reduce((a, d) => a + Number(d.size_bytes || 0), 0)
    if (sum > 0) p.hardware.ram_bytes = sum
  }

  // hostname 必须以 local_hostname 开头，缺了就从 computer_name 推
  if (p.naming && !p.naming.local_hostname) {
    p.naming.local_hostname = String(p.naming.hostname || '').replace(/\.local$/, '')
  }

  return p
}

/**
 * persona 内部约束检查。
 * 这些是「真机不可能出现」的组合，命中即说明构造有问题。
 */
export function validate(p) {
  const issues = []

  // 机型与主板必须匹配
  const expectedBoard = KNOWN_BOARDS[p.hardware?.model_identifier]
  if (expectedBoard && p.hardware.board_id !== expectedBoard) {
    issues.push({
      code: 'board_model_mismatch',
      text: `board_id ${p.hardware.board_id} 与机型 ${p.hardware.model_identifier} 不匹配，应为 ${expectedBoard}`,
    })
  }

  // SMC 版本不能为空（真机一定有）
  if (!p.hardware?.smc_version) {
    issues.push({
      code: 'smc_version_empty',
      text: 'smc_version 为空。真机 system_profiler / ioreg 都会报出 SMC 版本，留空会露。',
    })
  }

  // 序列号格式：Mac Pro 是 12 位，且与机型产地码相关
  if (p.hardware?.serial_number && !/^[A-Z0-9]{11,12}$/.test(p.hardware.serial_number)) {
    issues.push({
      code: 'serial_format',
      text: `序列号 ${p.hardware.serial_number} 格式不对，应为 11-12 位大写字母数字`,
    })
  }

  // MLB 是 17 位
  if (p.hardware?.mlb_serial && !/^[A-Z0-9]{17}$/.test(p.hardware.mlb_serial)) {
    issues.push({
      code: 'mlb_format',
      text: `MLB 序列号 ${p.hardware.mlb_serial} 格式不对，应为 17 位`,
    })
  }

  // hardware_uuid 是标准 UUID 形态
  if (p.hardware?.hardware_uuid &&
      !/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(p.hardware.hardware_uuid)) {
    issues.push({
      code: 'hardware_uuid_format',
      text: 'hardware_uuid 不是标准 UUID 形态',
    })
  }

  // 核心数关系
  if (p.hardware?.physical_cores && p.hardware?.logical_cores &&
      p.hardware.logical_cores < p.hardware.physical_cores) {
    issues.push({
      code: 'core_count_order',
      text: `逻辑核 ${p.hardware.logical_cores} 小于物理核 ${p.hardware.physical_cores}`,
    })
  }

  // 内存必须能被 DIMM 之和解释
  if (Array.isArray(p.hardware?.dimms) && p.hardware.dimms.length > 0) {
    const sum = p.hardware.dimms.reduce((a, d) => a + Number(d.size_bytes || 0), 0)
    if (sum !== p.hardware.ram_bytes) {
      issues.push({
        code: 'ram_dimms_mismatch',
        text: `ram_bytes ${p.hardware.ram_bytes} 与 DIMM 之和 ${sum} 不一致`,
      })
    }
  }

  // MAC 必须是单播地址
  if (p.network?.en0_mac) {
    const first = parseInt(String(p.network.en0_mac).slice(0, 2), 16)
    if (first & 0x01) {
      issues.push({
        code: 'mac_multicast',
        text: `MAC ${p.network.en0_mac} 是组播地址，网卡不会用`,
      })
    }
  }

  return issues
}

/**
 * 非致命提示：这些不算错，但值得知道。
 */
export function warnings(p) {
  const out = []
  const first = parseInt(String(p.network?.en0_mac || '').slice(0, 2), 16)
  if (first & 0x02) {
    out.push({
      code: 'mac_local_administered',
      text: `MAC ${p.network.en0_mac} 是本地管理地址（x2/x6/xA/xE 开头）。真机网卡用厂商 OUI，虚拟机常用本地管理地址。`,
    })
  }
  if (p.hardware?.model_identifier?.startsWith('MacPro') && p.hardware?.ram_bytes < 16 * 1024 ** 3) {
    out.push({
      code: 'ram_low_for_macpro',
      text: 'Mac Pro 配小于 16GB 内存不太常见',
    })
  }
  return out
}

/**
 * 渲染全部视图。
 *
 * 每个视图都从 persona 读取，不存副本 —— 这是防止漂移的唯一办法。
 */
export function render(p) {
  const hw = p.hardware
  const sw = p.software
  const nm = p.naming
  const net = p.network
  const vol = apfsLayout(p.volume)

  // ── 伪命令输出 ──
  const commands = {}

  commands.uname = `${sw.kernel_release}` // uname (无参数)
  commands['uname -a'] =
    `Darwin ${nm.local_hostname}.local ${sw.kernel_release} ${sw.kernel_version} ${sw.arch}`
  commands['uname -n'] = `${nm.local_hostname}.local`
  commands['uname -m'] = sw.arch
  commands['uname -s'] = 'Darwin'
  commands['uname -r'] = sw.kernel_release

  commands.sw_vers = [
    `ProductName:\t\t${sw.product_name}`,
    `ProductVersion:\t\t${sw.product_version}`,
    `BuildVersion:\t\t${sw.build_version}`,
  ].join('\n')
  commands['sw_vers -productName'] = sw.product_name
  commands['sw_vers -productVersion'] = sw.product_version
  commands['sw_vers -buildVersion'] = sw.build_version

  // scutil 从同一个 naming 真值派生
  commands['scutil --get ComputerName'] = nm.computer_name
  commands['scutil --get LocalHostName'] = nm.local_hostname
  commands['scutil --get HostName'] = nm.hostname

  commands['sysctl -n kern.osrelease'] = sw.kernel_release
  commands['sysctl -n kern.version'] = sw.kernel_version
  commands['sysctl -n hw.model'] = hw.model_identifier
  commands['sysctl -n hw.ncpu'] = String(hw.logical_cores)
  commands['sysctl -n hw.physicalcpu'] = String(hw.physical_cores)
  commands['sysctl -n hw.memsize'] = String(hw.ram_bytes)
  commands['sysctl -n hw.cpufamily'] = '4213859076'

  commands['system_profiler SPHardwareDataType'] = [
    'Hardware:',
    '',
    `    Hardware Overview:`,
    '',
    `      Model Name: ${hw.marketing_name}`,
    `      Model Identifier: ${hw.model_identifier}`,
    `      Model Number: ${hw.model_identifier}`,
    `      Chip: ${hw.cpu_brand}`,
    `      Total Number of Cores: ${hw.physical_cores} (${Math.floor(hw.physical_cores / 2)} Performance and ${Math.ceil(hw.physical_cores / 2)} Efficiency)`,
    `      Memory: ${(hw.ram_bytes / 1024 ** 3)} GB`,
    `      System Firmware Version: ${hw.boot_rom_version}`,
    `      SMC Version (system): ${hw.smc_version}`,
    `      Serial Number (system): ${hw.serial_number}`,
    `      Hardware UUID: ${hw.hardware_uuid}`,
    `      Provisioning UDID: ${hw.hardware_uuid.replace(/-/g, '')}`,
  ].join('\n')

  commands['system_profiler SPHardwareDataType -json'] = JSON.stringify({
    SPHardwareDataType: [{
      _name: 'hardware_overview',
      model_name: hw.marketing_name,
      model_identifier: hw.model_identifier,
      chip_type: hw.cpu_brand,
      total_number_of_cores: String(hw.physical_cores),
      physical_memory: `${hw.ram_bytes / 1024 ** 3} GB`,
      system_firmware_version: hw.boot_rom_version,
      smc_version_system: hw.smc_version,
      serial_number_system: hw.serial_number,
      hardware_uuid: hw.hardware_uuid,
    }],
  }, null, 2)

  commands['ioreg -rd1 -c IOPlatformExpertDevice'] = [
    '+-o Root  <class IORegistryEntry, id 0x100000100, retain 23>',
    '  +-o MacPro7,1  <class IOPlatformExpertDevice, id 0x100000101, registered, matched, active, busy 0, retain 12>',
    `    {`,
    `      "IOPlatformSerialNumber" = "${hw.serial_number}"`,
    `      "IOPlatformUUID" = "${hw.hardware_uuid}"`,
    `      "board-id" = <"${hw.board_id}">`,
    `      "model" = <"${hw.model_identifier}">`,
    `      "target-type" = <"Mac">`,
    `      "IOBusyInterest" = "boot"`,
    `    }`,
  ].join('\n')

  commands['ioreg -l | grep -i smc'] =
    `    "smc-version" = <"${hw.smc_version}">`

  commands['nvram -p'] = [
    `boot-args\t`,
    `csr-active-config\t%00%00%00%00`,
    `SystemAudioVolume\t%82`,
  ].join('\n')

  // 磁盘三命令共用同一份 layout
  commands['df -h'] = [
    'Filesystem      Size   Used  Avail Capacity  Mounted on',
    `/dev/${vol.sysvol}   ${(vol.total / 1024 ** 3).toFixed(1)}Gi  ${(vol.system_used / 1024 ** 3).toFixed(1)}Gi  ${(vol.free / 1024 ** 3).toFixed(1)}Gi    ${Math.round((vol.system_used / vol.total) * 100)}%    /`,
    `devfs           188Ki  188Ki    0Bi   100%    /dev`,
    `map auto_home     0Bi    0Bi    0Bi   100%    /System/Volumes/Data/home`,
  ].join('\n')

  commands['diskutil list'] = [
    `/dev/${vol.phys} (disk image):`,
    `   #:                       TYPE NAME                    SIZE       IDENTIFIER`,
    `   0:      GUID_partition_scheme                        *${(vol.total / 1024 ** 3).toFixed(1)} GB   ${vol.phys}`,
    `   1:                        EFI ⁨EFI⁩                     209.7 MB   ${vol.phys}s1`,
    `   2:                 Apple_APFS ⁨Container disk1⁩          ${(vol.total / 1000 ** 3).toFixed(1)} GB   ${vol.phys}s2`,
    '',
    `/dev/${vol.container} (synthesized):`,
    `   #:                       TYPE NAME                    SIZE       IDENTIFIER`,
    `   0:      APFS Container Scheme -                      +${(vol.total / 1000 ** 3).toFixed(1)} GB   ${vol.container}`,
    `                                 Physical Store ${vol.phys}s2`,
    `   1:                APFS Volume ⁨${vol.name}⁩               ${(vol.system_used / 1000 ** 3).toFixed(1)} GB    ${vol.sysvol}`,
    `   2:                APFS Volume ⁨Data⁩                      ${(vol.data_used / 1000 ** 3).toFixed(1)} GB    ${vol.datavol}`,
    `   3:              APFS Snapshot ⁨com.apple.os.update-⁩     ${(vol.system_used / 1000 ** 3).toFixed(1)} GB    ${vol.sysvol}s1`,
    `   4:                APFS Volume ⁨Preboot⁩                   ${(vol.preboot / 1000 ** 2).toFixed(0)} MB    ${vol.container}s1`,
    `   5:                APFS Volume ⁨Recovery⁩                  ${(vol.recovery / 1000 ** 3).toFixed(2)} GB    ${vol.container}s2`,
    `   6:                APFS Volume ⁨VM⁩                        ${(vol.vm / 1000 ** 2).toFixed(0)} MB    ${vol.container}s3`,
  ].join('\n')

  commands.mount = [
    `/dev/${vol.sysvol} on / (apfs, sealed, local, read-only, journaled)`,
    `devfs on /dev (devfs, local, nobrowse)`,
    `map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)`,
  ].join('\n')

  // ── 落盘文件 ──
  const files = {
    'etc/hostname': `${nm.hostname}\n`,
    'etc/macos_persona.json': `${JSON.stringify(p, null, 2)}\n`,
    'System/Library/CoreServices/SystemVersion.plist': renderSystemVersionPlist(sw),
    'System/Volumes/Data/.persona-volume': renderVolumeMarker(vol),
    'usr/local/lib/persona_volume.py': renderVolumeScript(),
  }

  return { files, commands }
}

/**
 * 跨视图一致性检查 —— 这套检查是防漂移的核心。
 *
 * 原理：同一事实（主机名、内核版本、内存、核心数、磁盘容量）在不同视图里必须字面一致。
 * 任何一处不一致，都会在交叉对比时暴露。
 */
export function validateViews({ persona: p, files, commands }) {
  const issues = []

  // 1. 主机名：uname -n / scutil / /etc/hostname 三处必须同源
  const fromUname = commands['uname -n']
  const fromScutil = commands['scutil --get HostName']
  const fromFile = (files['etc/hostname'] || '').trim()
  if (fromUname && p.naming.hostname && fromUname !== p.naming.hostname) {
    issues.push({
      code: 'uname_hostname_mismatch',
      text: `uname -n 得到 "${fromUname}"，但 persona hostname 是 "${p.naming.hostname}"`,
      views: ['uname -n', 'persona.hostname'],
    })
  }
  if (fromScutil && fromFile && fromScutil !== fromFile) {
    issues.push({
      code: 'scutil_hostname_mismatch',
      text: `scutil HostName "${fromScutil}" 与 /etc/hostname "${fromFile}" 不一致`,
      views: ['scutil --get HostName', 'etc/hostname'],
    })
  }

  // 2. 主机名去掉 .local 后，scutil LocalHostName 必须能对上
  const localFromHost = String(p.naming.hostname || '').replace(/\.local$/, '')
  if (commands['scutil --get LocalHostName'] &&
      commands['scutil --get LocalHostName'] !== localFromHost) {
    issues.push({
      code: 'scutil_localhost_mismatch',
      text: `scutil LocalHostName "${commands['scutil --get LocalHostName']}" 与 hostname 推导值 "${localFromHost}" 不一致`,
      views: ['scutil --get LocalHostName', 'persona.hostname'],
    })
  }

  // 3. 内核版本：uname -r 与 sysctl 必须一致
  if (commands['uname -r'] !== commands['sysctl -n kern.osrelease']) {
    issues.push({
      code: 'kernel_release_mismatch',
      text: `uname -r "${commands['uname -r']}" 与 sysctl kern.osrelease "${commands['sysctl -n kern.osrelease']}" 不一致`,
      views: ['uname -r', 'sysctl -n kern.osrelease'],
    })
  }

  // 4. 内存：sysctl hw.memsize 必须等于 persona.ram_bytes
  if (commands['sysctl -n hw.memsize'] !== String(p.hardware.ram_bytes)) {
    issues.push({
      code: 'memsize_mismatch',
      text: `sysctl hw.memsize "${commands['sysctl -n hw.memsize']}" 与 persona.ram_bytes ${p.hardware.ram_bytes} 不一致`,
      views: ['sysctl -n hw.memsize', 'persona.hardware.ram_bytes'],
    })
  }

  // 5. 核心数：sysctl 与 persona 必须一致
  if (commands['sysctl -n hw.ncpu'] !== String(p.hardware.logical_cores)) {
    issues.push({
      code: 'ncpu_mismatch',
      text: 'sysctl hw.ncpu 与 persona.logical_cores 不一致',
      views: ['sysctl -n hw.ncpu', 'persona.hardware.logical_cores'],
    })
  }

  // 6. 机型：sysctl hw.model 与 system_profiler 必须一致
  if (!String(commands['system_profiler SPHardwareDataType']).includes(p.hardware.model_identifier)) {
    issues.push({
      code: 'system_profiler_model_missing',
      text: 'system_profiler 输出里找不到 persona 的机型标识',
      views: ['system_profiler SPHardwareDataType'],
    })
  }

  // 7. SMC 版本必须在所有提到它的视图里出现同一个值
  const smcViews = [
    'system_profiler SPHardwareDataType',
    'ioreg -l | grep -i smc',
  ]
  for (const v of smcViews) {
    if (commands[v] && !String(commands[v]).includes(p.hardware.smc_version)) {
      issues.push({
        code: 'smc_version_view_mismatch',
        text: `${v} 里没有出现 persona 的 smc_version "${p.hardware.smc_version}"`,
        views: [v],
      })
    }
  }

  // 8. 磁盘：df 与 diskutil 报的总容量必须一致
  const vol = apfsLayout(p.volume)
  const dfLine = String(commands['df -h'] || '').split('\n')[1] || ''
  const dfTotal = (dfLine.match(/([0-9.]+)Gi/) || [])[1]
  if (dfTotal && Math.abs(Number(dfTotal) - vol.total / 1024 ** 3) > 0.15) {
    issues.push({
      code: 'disk_capacity_mismatch',
      text: `df 报的总容量 ${dfTotal}Gi 与 persona 卷大小 ${(vol.total / 1024 ** 3).toFixed(1)}Gi 不一致`,
      views: ['df -h', 'persona.volume.size_bytes'],
    })
  }

  // 9. 序列号在 system_profiler 与 ioreg 必须一致
  if (!String(commands['ioreg -rd1 -c IOPlatformExpertDevice']).includes(p.hardware.serial_number)) {
    issues.push({
      code: 'serial_ioreg_missing',
      text: 'ioreg 输出里找不到 persona 的序列号',
      views: ['ioreg -rd1 -c IOPlatformExpertDevice'],
    })
  }

  return issues
}

// ─────────────── 内部渲染辅助 ───────────────

/**
 * APFS 容量预算。
 *
 * 存在意义：让 df / diskutil / mount 报的数字互相自洽。
 * 做法是先算一份预算，所有命令从预算取值，而不是各自编数字。
 */
export function apfsLayout(cfg = {}) {
  const total = Number(cfg.size_bytes || DEFAULTS.volume.size_bytes)
  const system_used = APFS_SLICES.system
  const data_used = APFS_SLICES.data
  const preboot = APFS_SLICES.preboot
  const recovery = APFS_SLICES.recovery
  const vm = APFS_SLICES.vm
  const used = system_used + data_used + preboot + recovery + vm

  if (used >= total) {
    throw new Error(`volume.size_bytes ${total} is smaller than the fixed slices ${used}`)
  }
  const free = total - used
  const parts = [system_used, data_used, preboot, recovery, vm, free]
  if (parts.reduce((a, b) => a + b, 0) !== total) {
    throw new Error('volume budget sum mismatch')
  }
  if (parts.some((n) => n % 512 !== 0)) {
    throw new Error('volume budget is not a consistent multiple of 512')
  }
  if (parts.some((n) => n <= 0)) {
    throw new Error('volume budget has non-positive slice')
  }

  return {
    total,
    system_used,
    data_used,
    preboot,
    recovery,
    vm,
    free,
    name: cfg.name || 'Macintosh HD',
    filesystem: String(cfg.filesystem || 'apfs').toUpperCase(),
    phys: cfg.physical_disk || 'disk0',
    container: cfg.container_device || 'disk1',
    sysvol: cfg.system_volume || 'disk1s1',
    datavol: cfg.data_volume || 'disk1s2',
  }
}

function renderSystemVersionPlist(sw) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>ProductBuildVersion</key>
\t<string>${sw.build_version}</string>
\t<key>ProductCopyright</key>
\t<string>1983-2024 Apple Inc.</string>
\t<key>ProductName</key>
\t<string>${sw.product_name}</string>
\t<key>ProductVersion</key>
\t<string>${sw.product_version}</string>
</dict>
</plist>
`
}

function renderVolumeMarker(vol) {
  return `total=${vol.total}
system_used=${vol.system_used}
data_used=${vol.data_used}
preboot=${vol.preboot}
recovery=${vol.recovery}
vm=${vol.vm}
free=${vol.free}
`
}

function renderVolumeScript() {
  return `"""APFS container budget for diskutil, df, and mount.

All three commands read this single budget so their numbers never disagree.
"""
import json
import pathlib

MIB = 1024 ** 2
GIB = 1024 ** 3


def load_cfg():
    path = pathlib.Path(__file__).resolve().parents[3].joinpath("etc/macos_persona.json")
    return json.loads(path.read_text(encoding="utf-8"))


def layout(cfg=None):
    cfg = cfg if cfg is not None else load_cfg()
    vol = cfg.get("volume") or {}
    total = int(vol.get("size_bytes") or 8 * GIB)
    system_used = 512 * MIB
    data_used = 1 * GIB
    preboot = 64 * MIB
    recovery = 256 * MIB
    vm = 64 * MIB
    used = system_used + data_used + preboot + recovery + vm
    if used >= total:
        raise SystemExit(f"volume.size_bytes {total} is smaller than the fixed slices {used}")
    free = total - used
    parts = (system_used, data_used, preboot, recovery, vm, free)
    if sum(parts) != total or any(n % 512 for n in parts) or any(n <= 0 for n in parts):
        raise SystemExit("volume budget is not a consistent multiple of 512")
    return {
        "total": total,
        "system_used": system_used,
        "data_used": data_used,
        "preboot": preboot,
        "recovery": recovery,
        "vm": vm,
        "free": free,
        "name": vol.get("name") or "Macintosh HD",
        "filesystem": (vol.get("filesystem") or "apfs").upper(),
        "phys": vol.get("physical_disk") or "disk0",
        "container": vol.get("container_device") or "disk1",
        "sysvol": vol.get("system_volume") or "disk1s1",
        "datavol": vol.get("data_volume") or "disk1s2",
    }
`
}
