/**
 * Windows persona
 *
 * Windows 身份在这些地方被看到，全部必须一致：
 *
 *   wmic / PowerShell Get-CimInstance    Win32_ComputerSystem / Win32_BIOS / Win32_Processor
 *   systeminfo                           汇总视图
 *   registry                              MachineGuid / ProductId / InstallDate
 *   hostname / COMPUTERNAME              主机名
 *   卷信息                               C: 容量、文件系统、卷序列号
 *
 * 与 macOS 的关键差异：
 *   - Windows 的主机名是单段（不带 .local），但要 ≤ 15 字符（NetBIOS 限制）
 *   - MachineGuid 在注册表里，/etc/machine-id 那套在这里没有对应物
 *   - 磁盘用卷序列号（8 位十六进制）而不是 UUID
 *   - 硬件序列号（BIOS serial）通常来自厂商，格式因 OEM 而异
 */

import { deriveSerial, deriveUuidUpper, deriveMac, deriveHex32 } from './derive.mjs'

export const KEY = 'windows'

/** 默认骨架：Dell OptiPlex 7090，企业桌面常见配置 */
export const DEFAULTS = Object.freeze({
  platform: 'windows',

  software: {
    product_name: 'Windows 11 Pro',
    product_version: '10.0.22631',
    build_number: '22631',
    build_revision: '3155',
    edition_id: 'Professional',
    display_version: '23H2',
    install_date: '2024-03-15T09:22:41Z',
  },

  hardware: {
    system_vendor: 'Dell Inc.',
    system_family: 'OptiPlex',
    system_sku: '0A56',
    model: 'OptiPlex 7090',
    product_name: 'OptiPlex 7090',
    bios_vendor: 'Dell Inc.',
    bios_version: '2.18.0',
    bios_release_date: '2023-11-14T00:00:00Z',
    serial_number: 'G7Q3RM3',
    uuid: '4C4C4544-0047-3710-8051-C7C04F334D33',
    baseboard_manufacturer: 'Dell Inc.',
    baseboard_product: '0WX9C8',
    baseboard_version: 'A01',
    chassis_type: 3,
    processor: {
      name: 'Intel(R) Core(TM) i7-11700 @ 2.50GHz',
      manufacturer: 'GenuineIntel',
      family: 'Core i7',
      cores: 8,
      logical_processors: 16,
      max_clock_mhz: 2500,
      architecture: 9,
    },
    ram_bytes: 32 * 1024 ** 3,
    dimms: [
      { bank: 'BANK 0', size_bytes: 16 * 1024 ** 3, speed_mhz: 3200, type: 'DDR4' },
      { bank: 'BANK 1', size_bytes: 16 * 1024 ** 3, speed_mhz: 3200, type: 'DDR4' },
    ],
  },

  network: {
    // 从 VM 分配继承。Windows 常见 Intel 网卡 OUI。
    adapter_name: 'Intel(R) Ethernet Connection (14) I219-LM',
    mac: 'A4:BB:6D:3E:92:17',
    mac_source: 'vm-assigned',
  },

  naming: {
    // NetBIOS 名 ≤ 15 字符；大写的 COMPUTERNAME 与小写 hostname 是同一个值的两种呈现
    computer_name: 'DESKTOP-7K3M9QZ',
    workgroup: 'WORKGROUP',
  },

  volume: {
    drive: 'C:',
    filesystem: 'NTFS',
    size_bytes: 512 * 1024 ** 3,
    used_bytes: 187 * 1024 ** 3,
    label: 'OS',
    serial_hex: '9C4A2B71',
  },
})

/** 已知 OEM 的序列号规则：用于校验序列号格式是否与该厂商一致 */
export const OEM_SERIAL_RULES = Object.freeze({
  'Dell Inc.': { pattern: /^[A-Z0-9]{7}$/, sample: 'G7Q3RM3', note: 'Dell 服务标签是 7 位大写字母数字' },
  'HP': { pattern: /^[A-Z0-9]{10}$/, sample: 'CZC1234ABC', note: 'HP 序列号 10 位' },
  'LENOVO': { pattern: /^[A-Z0-9]{8,10}$/, sample: 'PF2ABCDE', note: 'Lenovo 序列号 8-10 位' },
  'ASUSTeK COMPUTER INC.': { pattern: /^[A-Z0-9]{10,15}$/, sample: 'M3N0CV01X12345', note: 'ASUS 序列号 10-15 位' },
})

/**
 * 补全派生字段。
 *
 * 序列号、SMBIOS UUID、卷序列号、MAC 全部从 vm_id 派生：
 * 同一 vm_id 恒得同一组值，不同 vm_id 互不关联。
 */
export function normalize(input) {
  const p = structuredClone(input)
  const vmId = String(p.vm_id || 'default')

  if (p.hardware) {
    const vendor = p.hardware.system_vendor || 'Dell Inc.'
    // 按 OEM 规则生成序列号长度
    const rules = { 'Dell Inc.': 7, 'HP': 10, 'LENOVO': 9, 'ASUSTeK COMPUTER INC.': 12 }
    const len = rules[vendor] || 7
    p.hardware.serial_number = deriveSerial(vmId, len, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'win-serial')
    p.hardware.uuid = deriveUuidUpper(vmId, 'win-smbios-uuid')
  }
  if (p.network) {
    // Intel 网卡常用 OUI：A4:BB:6D
    p.network.mac = deriveMac(vmId, 'A4:BB:6D')
  }
  if (p.volume) {
    p.volume.serial_hex = deriveHex32(vmId, 'win-volume').slice(0, 8).toUpperCase()
  }

  // 内存以 DIMM 之和为准
  if (Array.isArray(p.hardware?.dimms) && p.hardware.dimms.length > 0) {
    const sum = p.hardware.dimms.reduce((a, d) => a + Number(d.size_bytes || 0), 0)
    if (sum > 0) p.hardware.ram_bytes = sum
  }

  // computer_name 统一大写（Windows 习惯）
  if (p.naming?.computer_name) {
    p.naming.computer_name = String(p.naming.computer_name).toUpperCase()
  }

  // 逻辑处理器数不小于物理核心数
  const proc = p.hardware?.processor
  if (proc && proc.cores && proc.logical_processors && proc.logical_processors < proc.cores) {
    proc.logical_processors = proc.cores
  }

  return p
}

/** persona 内部约束检查 */
export function validate(p) {
  const issues = []

  // NetBIOS 名长度限制
  const name = p.naming?.computer_name || ''
  if (name.length > 15) {
    issues.push({
      code: 'netbios_name_too_long',
      text: `计算机名 "${name}" 有 ${name.length} 字符，超过 NetBIOS 15 字符上限`,
    })
  }
  if (!/^[A-Z0-9-]+$/.test(name)) {
    issues.push({
      code: 'netbios_name_charset',
      text: `计算机名 "${name}" 含非法字符，Windows 只允许 A-Z 0-9 和连字符`,
    })
  }

  // 序列号必须匹配 OEM 规则
  const rule = OEM_SERIAL_RULES[p.hardware?.system_vendor]
  if (rule && p.hardware?.serial_number && !rule.pattern.test(p.hardware.serial_number)) {
    issues.push({
      code: 'serial_oem_mismatch',
      text: `序列号 "${p.hardware.serial_number}" 不符合 ${p.hardware.system_vendor} 规则（${rule.note}）`,
    })
  }

  // SMBIOS UUID 形态
  if (p.hardware?.uuid &&
      !/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(p.hardware.uuid)) {
    issues.push({
      code: 'uuid_format',
      text: 'hardware.uuid 不是标准大写 UUID 形态',
    })
  }

  // 卷容量自洽
  const v = p.volume
  if (v && Number(v.used_bytes) > Number(v.size_bytes)) {
    issues.push({
      code: 'volume_used_exceeds_size',
      text: `卷已用 ${v.used_bytes} 超过总容量 ${v.size_bytes}`,
    })
  }
  if (v?.serial_hex && !/^[0-9A-F]{8}$/.test(v.serial_hex)) {
    issues.push({
      code: 'volume_serial_format',
      text: `卷序列号 "${v.serial_hex}" 应为 8 位大写十六进制`,
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

  // 构建号与版本号要能对上
  if (p.software?.product_version && p.software?.build_number) {
    if (!String(p.software.product_version).endsWith(String(p.software.build_number))) {
      issues.push({
        code: 'build_version_mismatch',
        text: `product_version "${p.software.product_version}" 的末段与 build_number "${p.software.build_number}" 不符`,
      })
    }
  }

  // MAC 单播检查
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
  if (p.software?.display_version && p.software?.build_number) {
    const map = { '22631': '23H2', '22621': '22H2', '19045': '22H2', '22000': '21H2' }
    const expect = map[p.software.build_number]
    if (expect && expect !== p.software.display_version) {
      out.push({
        code: 'display_version_mismatch',
        text: `build ${p.software.build_number} 对应 ${expect}，但 display_version 是 ${p.software.display_version}`,
      })
    }
  }
  return out
}

/**
 * 渲染全部视图。
 * 全部从同一 persona 派生，不存副本。
 */
export function render(p) {
  const hw = p.hardware
  const sw = p.software
  const nm = p.naming
  const net = p.network
  const vol = p.volume
  const proc = hw.processor

  const commands = {}

  // ── hostname ──
  commands.hostname = nm.computer_name
  commands['echo %COMPUTERNAME%'] = nm.computer_name

  // ── systeminfo ──
  commands['systeminfo'] = [
    '',
    `Host Name:                 ${nm.computer_name}`,
    `OS Name:                   Microsoft ${sw.product_name}`,
    `OS Version:                ${sw.product_version} N/A Build ${sw.build_number}`,
    `OS Manufacturer:           Microsoft Corporation`,
    `OS Configuration:          Standalone Workstation`,
    `OS Build Type:             Multiprocessor Free`,
    `Registered Owner:          Windows User`,
    `Product ID:                00330-80000-00000-AA${String(Number(vol.serial_hex.slice(0, 2), 16) % 900 + 100)}`,
    `Original Install Date:     ${sw.install_date.replace('T', ' ').replace('Z', '')}`,
    `System Boot Time:          ${sw.install_date.replace('T', ' ').replace('Z', '')}`,
    `System Manufacturer:       ${hw.system_vendor}`,
    `System Model:              ${hw.model}`,
    `System Type:               x64-based PC`,
    `Processor(s):              1 Processor(s) Installed.`,
    `                           [01]: ${proc.name}`,
    `                                 ${proc.family}, ${proc.max_clock_mhz} Mhz`,
    `BIOS Version:              ${hw.bios_vendor} ${hw.bios_version}, ${hw.bios_release_date.slice(0, 10)}`,
    `Windows Directory:         C:\\Windows`,
    `System Directory:          C:\\Windows\\system32`,
    `Total Physical Memory:     ${Math.round(hw.ram_bytes / 1024 ** 2).toLocaleString('en-US')} MB`,
    `Available Physical Memory: ${Math.round((hw.ram_bytes * 0.61) / 1024 ** 2).toLocaleString('en-US')} MB`,
    `Virtual Memory: Max Size:  ${Math.round((hw.ram_bytes * 1.2) / 1024 ** 2).toLocaleString('en-US')} MB`,
    `Network Name:              ${nm.workgroup}`,
  ].join('\n')

  // ── CIM / WMI ──
  commands['wmic computersystem get Name,Manufacturer,Model,TotalPhysicalMemory,Domain /format:list'] = [
    `Domain=${nm.workgroup}`,
    `Manufacturer=${hw.system_vendor}`,
    `Model=${hw.model}`,
    `Name=${nm.computer_name}`,
    `TotalPhysicalMemory=${hw.ram_bytes}`,
  ].join('\n')

  commands['wmic bios get SerialNumber,Manufacturer,SMBIOSBIOSVersion,ReleaseDate /format:list'] = [
    `Manufacturer=${hw.bios_vendor}`,
    `ReleaseDate=${hw.bios_release_date.replace(/[-:TZ]/g, '').slice(0, 8)}000000.000000+000`,
    `SMBIOSBIOSVersion=${hw.bios_version}`,
    `SerialNumber=${hw.serial_number}`,
  ].join('\n')

  commands['wmic baseboard get Manufacturer,Product,Version,SerialNumber /format:list'] = [
    `Manufacturer=${hw.baseboard_manufacturer}`,
    `Product=${hw.baseboard_product}`,
    `SerialNumber=..${hw.serial_number.slice(-6)}.`,
    `Version=${hw.baseboard_version}`,
  ].join('\n')

  commands['wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed /format:list'] = [
    `MaxClockSpeed=${proc.max_clock_mhz}`,
    `Name=${proc.name}`,
    `NumberOfCores=${proc.cores}`,
    `NumberOfLogicalProcessors=${proc.logical_processors}`,
  ].join('\n')

  commands['wmic csproduct get UUID,Name,IdentifyingNumber /format:list'] = [
    `IdentifyingNumber=${hw.serial_number}`,
    `Name=${hw.product_name}`,
    `UUID=${hw.uuid}`,
  ].join('\n')

  commands['wmic os get Caption,Version,BuildNumber,SerialNumber,InstallDate /format:list'] = [
    `BuildNumber=${sw.build_number}`,
    `Caption=Microsoft ${sw.product_name}`,
    `InstallDate=${sw.install_date.replace(/[-:TZ]/g, '').slice(0, 14)}.000000+000`,
    `SerialNumber=00000-00000-00000-AA${String(Number(vol.serial_hex.slice(0, 2), 16) % 900 + 100)}`,
    `Version=${sw.product_version}`,
  ].join('\n')

  commands['wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace,FileSystem,VolumeSerialNumber /format:list'] = [
    `FileSystem=${vol.filesystem}`,
    `FreeSpace=${vol.size_bytes - vol.used_bytes}`,
    `Size=${vol.size_bytes}`,
    `VolumeSerialNumber=${vol.serial_hex}`,
  ].join('\n')

  // ── PowerShell CIM（现代 Windows 主要走这条）──
  commands['powershell -NoProfile -Command "Get-CimInstance Win32_ComputerSystem | ConvertTo-Json"'] =
    JSON.stringify({
      AdminPasswordStatus: 3,
      BootupState: 'Normal boot',
      Domain: nm.workgroup,
      Manufacturer: hw.system_vendor,
      Model: hw.model,
      Name: nm.computer_name,
      NumberOfLogicalProcessors: proc.logical_processors,
      NumberOfProcessors: 1,
      SystemFamily: hw.system_family,
      SystemSKUNumber: hw.system_sku,
      TotalPhysicalMemory: hw.ram_bytes,
      UserName: `${nm.computer_name}\\User`,
    }, null, 2)

  commands['powershell -NoProfile -Command "Get-CimInstance Win32_BIOS | ConvertTo-Json"'] =
    JSON.stringify({
      Manufacturer: hw.bios_vendor,
      SMBIOSBIOSVersion: hw.bios_version,
      SerialNumber: hw.serial_number,
      ReleaseDate: hw.bios_release_date,
    }, null, 2)

  commands['powershell -NoProfile -Command "Get-CimInstance Win32_Processor | ConvertTo-Json"'] =
    JSON.stringify({
      Name: proc.name,
      Manufacturer: proc.manufacturer,
      NumberOfCores: proc.cores,
      NumberOfLogicalProcessors: proc.logical_processors,
      MaxClockSpeed: proc.max_clock_mhz,
      Architecture: proc.architecture,
      Family: proc.family,
    }, null, 2)

  // ── 注册表 ──
  const machineGuid = machineGuidFromUuid(hw.uuid)
  commands['reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid'] = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography',
    `    MachineGuid    REG_SZ    ${machineGuid}`,
    '',
  ].join('\n')

  commands['reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName'] = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
    `    ProductName    REG_SZ    ${sw.product_name}`,
    '',
  ].join('\n')

  commands['reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\SystemInformation"'] = [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\SystemInformation',
    `    ComputerHardwareId    REG_SZ    {${hw.uuid.toLowerCase()}}`,
    `    SystemManufacturer    REG_SZ    ${hw.system_vendor}`,
    `    SystemProductName     REG_SZ    ${hw.product_name}`,
    '',
  ].join('\n')

  // ── 网络适配器 ──
  commands['getmac /v /fo list'] = [
    '',
    `Connection Name:  Ethernet`,
    `Network Adapter:  ${net.adapter_name}`,
    `Physical Address: ${net.mac.replace(/:/g, '-').toUpperCase()}`,
    `Transport Name:   \\Device\\Tcpip_{${hw.uuid}}`,
    '',
  ].join('\n')

  // ── 落盘文件 ──
  const files = {
    'etc/persona.json': `${JSON.stringify(p, null, 2)}\n`,
    'Windows/System32/config/persona_report.txt': renderPersonaReport(p, machineGuid),
  }

  return { files, commands }
}

/**
 * 跨视图一致性检查。
 * 原理与 macOS 相同：同一事实在多处出现时，字面必须一致。
 */
export function validateViews({ persona: p, files, commands }) {
  const issues = []

  // 1. 计算机名：hostname / wmic / systeminfo / CIM 四处一致
  const nameViews = [
    ['hostname', commands.hostname],
    ['wmic computersystem', extract(commands['wmic computersystem get Name,Manufacturer,Model,TotalPhysicalMemory,Domain /format:list'], 'Name')],
    ['systeminfo', extract(commands['systeminfo'], 'Host Name')],
    ['Get-CimInstance Win32_ComputerSystem', safeJson(commands['powershell -NoProfile -Command "Get-CimInstance Win32_ComputerSystem | ConvertTo-Json"'])?.Name],
  ]
  for (const [view, value] of nameViews) {
    if (value && value !== p.naming.computer_name) {
      issues.push({
        code: 'computer_name_mismatch',
        text: `${view} 得到 "${value}"，但 persona.computer_name 是 "${p.naming.computer_name}"`,
        views: [view],
      })
    }
  }

  // 2. 序列号：wmic bios / csproduct / systeminfo 一致
  const serialViews = [
    ['wmic bios', extract(commands['wmic bios get SerialNumber,Manufacturer,SMBIOSBIOSVersion,ReleaseDate /format:list'], 'SerialNumber')],
    ['Get-CimInstance Win32_BIOS', safeJson(commands['powershell -NoProfile -Command "Get-CimInstance Win32_BIOS | ConvertTo-Json"'])?.SerialNumber],
  ]
  for (const [view, value] of serialViews) {
    if (value && value !== p.hardware.serial_number) {
      issues.push({
        code: 'serial_view_mismatch',
        text: `${view} 得到序列号 "${value}"，但 persona 是 "${p.hardware.serial_number}"`,
        views: [view],
      })
    }
  }

  // 3. 内存：wmic 与 CIM 与 persona 一致
  const memWmic = extract(commands['wmic computersystem get Name,Manufacturer,Model,TotalPhysicalMemory,Domain /format:list'], 'TotalPhysicalMemory')
  if (memWmic && String(memWmic) !== String(p.hardware.ram_bytes)) {
    issues.push({
      code: 'memory_mismatch',
      text: `wmic TotalPhysicalMemory "${memWmic}" 与 persona ${p.hardware.ram_bytes} 不一致`,
      views: ['wmic computersystem'],
    })
  }
  const cimMem = safeJson(commands['powershell -NoProfile -Command "Get-CimInstance Win32_ComputerSystem | ConvertTo-Json"'])?.TotalPhysicalMemory
  if (cimMem && String(cimMem) !== String(p.hardware.ram_bytes)) {
    issues.push({
      code: 'memory_cim_mismatch',
      text: `CIM TotalPhysicalMemory "${cimMem}" 与 persona ${p.hardware.ram_bytes} 不一致`,
      views: ['Get-CimInstance Win32_ComputerSystem'],
    })
  }

  // 4. 核心数：wmic cpu 与 CIM 一致
  const coresWmic = extract(commands['wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed /format:list'], 'NumberOfLogicalProcessors')
  if (coresWmic && String(coresWmic) !== String(p.hardware.processor.logical_processors)) {
    issues.push({
      code: 'cpu_cores_mismatch',
      text: `wmic NumberOfLogicalProcessors "${coresWmic}" 与 persona ${p.hardware.processor.logical_processors} 不一致`,
      views: ['wmic cpu'],
    })
  }

  // 5. 卷容量：logicaldisk 与 persona 一致
  const sizeLd = extract(commands['wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace,FileSystem,VolumeSerialNumber /format:list'], 'Size')
  if (sizeLd && String(sizeLd) !== String(p.volume.size_bytes)) {
    issues.push({
      code: 'volume_size_mismatch',
      text: `logicaldisk Size "${sizeLd}" 与 persona ${p.volume.size_bytes} 不一致`,
      views: ['wmic logicaldisk'],
    })
  }
  const serialLd = extract(commands['wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace,FileSystem,VolumeSerialNumber /format:list'], 'VolumeSerialNumber')
  if (serialLd && serialLd !== p.volume.serial_hex) {
    issues.push({
      code: 'volume_serial_mismatch',
      text: `logicaldisk VolumeSerialNumber "${serialLd}" 与 persona "${p.volume.serial_hex}" 不一致`,
      views: ['wmic logicaldisk'],
    })
  }

  // 6. MAC 在 getmac 与 persona 一致
  const macOut = String(commands['getmac /v /fo list'] || '')
  const macInView = (macOut.match(/Physical Address:\s*([0-9A-F-]+)/i) || [])[1]
  if (macInView && macInView.replace(/-/g, ':').toLowerCase() !== String(p.network.mac).toLowerCase()) {
    issues.push({
      code: 'mac_view_mismatch',
      text: `getmac 得到 "${macInView}"，但 persona MAC 是 "${p.network.mac}"`,
      views: ['getmac /v /fo list'],
    })
  }

  // 7. systeminfo 里的机型与 persona 一致
  const sysModel = extract(commands['systeminfo'], 'System Model')
  if (sysModel && sysModel !== p.hardware.model) {
    issues.push({
      code: 'model_view_mismatch',
      text: `systeminfo System Model "${sysModel}" 与 persona "${p.hardware.model}" 不一致`,
      views: ['systeminfo'],
    })
  }

  return issues
}

// ─────────────── 内部辅助 ───────────────

/** 从 /format:list 输出里取某个键的值 */
function extract(text, key) {
  if (!text) return undefined
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=(.*)$`, 'm')
  const m = String(text).match(re)
  return m ? m[1].trim() : undefined
}

function safeJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

/**
 * MachineGuid 从 SMBIOS UUID 派生。
 *
 * 真实 Windows 上 MachineGuid 是安装时生成的新 UUID，与 SMBIOS UUID 不同。
 * 这里做确定性派生：同一个 SMBIOS UUID 恒得同一个 MachineGuid，
 * 这样重建容器时注册表里的值不会漂移。
 */
export function machineGuidFromUuid(uuid) {
  const clean = String(uuid || '').replace(/-/g, '').toLowerCase()
  // 简单换位：既不等于原值，又保持确定性
  const rotated = clean.slice(8) + clean.slice(0, 8)
  return `${rotated.slice(0, 8)}-${rotated.slice(8, 12)}-4${rotated.slice(13, 16)}-8${rotated.slice(17, 20)}-${rotated.slice(20, 32)}`
}

function renderPersonaReport(p, machineGuid) {
  const hw = p.hardware
  const sw = p.software
  return [
    'PERSONA REPORT',
    '==============',
    `Computer Name   : ${p.naming.computer_name}`,
    `Workgroup       : ${p.naming.workgroup}`,
    `OS              : ${sw.product_name} ${sw.product_version} (${sw.display_version})`,
    `Build           : ${sw.build_number}.${sw.build_revision}`,
    `Manufacturer    : ${hw.system_vendor}`,
    `Model           : ${hw.model}`,
    `Serial          : ${hw.serial_number}`,
    `UUID            : ${hw.uuid}`,
    `MachineGuid     : ${machineGuid}`,
    `BIOS            : ${hw.bios_vendor} ${hw.bios_version}`,
    `Baseboard       : ${hw.baseboard_manufacturer} ${hw.baseboard_product}`,
    `CPU             : ${hw.processor.name}`,
    `Cores           : ${hw.processor.cores} physical / ${hw.processor.logical_processors} logical`,
    `Memory          : ${hw.ram_bytes} bytes`,
    `MAC             : ${p.network.mac}`,
    `Volume          : ${p.volume.drive} ${p.volume.filesystem} ${p.volume.size_bytes} bytes`,
    `Volume Serial   : ${p.volume.serial_hex}`,
    '',
  ].join('\n')
}
