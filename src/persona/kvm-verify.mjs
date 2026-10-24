/**
 * KVM 虚拟机内自检
 *
 * 与 verify.mjs（Docker 版）的判定逻辑根本不同：
 *
 *   Docker 版验证的是「伪造层是否生效」——
 *   /sys/class/dmi/id/* 本来由内核按真实硬件填写，我们挂了个文件盖上去，
 *   所以要查「盖住了没有」。任何一个字段没盖住，就是宿主真实值漏出来。
 *
 *   KVM 版验证的是「QEMU 是否正确提供了硬件」——
 *   客户机里读到的 DMI 全部来自 QEMU 生成的 SMBIOS 表，内核只是把它翻译成
 *   sysfs 文件。所以这里不存在「伪造层」：读到的值就应该是 QEMU 收到的值。
 *   对不上只有一种解释：SMBIOS 参数传错了（转义错了、字段名错了、机器类型不支持）。
 *
 * 因此本模块的核心不是「查文件」，而是「交叉验证两条独立的读取路径」：
 *
 *   路径 A  sysfs      /sys/class/dmi/id/<field>          内核解析 SMBIOS 表后导出
 *   路径 B  dmidecode   dmidecode -s <keyword>            用户态重新解析同一张表
 *
 * 两条路径读到不同值，说明表本身有问题（例如 type 参数被 QEMU 截断）。
 * 只查一条路径无法发现这类问题。
 *
 * 所有外部读取走注入点（opts.exec / opts.readFile），所以测试里可以完整
 * 跑一遍判定而不需要真虚拟机，并且验证「值不符时确实报失败」——
 * 一个永远返回 pass 的自检等于没有自检。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import {
  QEMU_FIXED_CHASSIS_TYPE,
  productSerialOf,
  productUuidOf,
  sysVendorOf,
  productNameOf,
} from './kvm-spec.mjs'

/**
 * sysfs 字段 → `dmidecode -s` keyword。
 *
 * 这两套命名不一致是内核的决定，不是笔误：sysfs 用 sys_vendor，
 * dmidecode 用 system-manufacturer。猜错一个，两条路径就会读到两个不同字段，
 * 于是自检报「不一致」—— 而真正的不一致是我们自己造成的。
 */
export const KVM_DMI_TO_DMIDECODE = Object.freeze({
  sys_vendor: 'system-manufacturer',
  product_name: 'system-product-name',
  product_version: 'system-version',
  product_serial: 'system-serial-number',
  product_uuid: 'system-uuid',
  product_family: 'system-family',
  board_vendor: 'baseboard-manufacturer',
  board_name: 'baseboard-product-name',
  board_version: 'baseboard-version',
  board_serial: 'baseboard-serial-number',
  bios_vendor: 'bios-vendor',
  bios_version: 'bios-version',
  bios_date: 'bios-release-date',
  chassis_vendor: 'chassis-manufacturer',
  chassis_serial: 'chassis-serial-number',
})

/**
 * 每次自检必查的 sysfs 字段（顺序即输出顺序）。
 *
 * 与 KVM_DMI_TO_DMIDECODE 的键集合保持一致：映射表里有的字段，自检就要查，
 * 否则「映射表声明支持但从未验证」的字段就是一个静默缺口。
 */
export const KVM_VERIFY_FIELDS = Object.freeze([
  'sys_vendor',
  'product_name',
  'product_version',
  'product_serial',
  'product_uuid',
  'product_family',
  'board_vendor',
  'board_name',
  'board_version',
  'board_serial',
  'bios_vendor',
  'bios_version',
  'bios_date',
  'chassis_vendor',
  'chassis_serial',
])

/** 走 dmidecode 复核的 keyword（选这些是因为它们最容易被上游日志记录）。 */
export const KVM_VERIFY_KEYWORDS = Object.freeze([
  'system-manufacturer',
  'system-product-name',
  'system-serial-number',
  'system-uuid',
  'baseboard-manufacturer',
  'baseboard-product-name',
])

/** 判定：去空白后逐字相等。 */
function exact(expected, actual) {
  return String(actual ?? '').trim() === String(expected ?? '').trim()
}

/** UUID 判定：大小写不敏感（dmidecode 与 sysfs 的大小写习惯不同）。 */
function uuidEqual(expected, actual) {
  return String(actual ?? '').trim().toLowerCase() === String(expected ?? '').trim().toLowerCase()
}

/** MAC 判定：大小写不敏感。 */
function macEqual(expected, actual) {
  return String(actual ?? '').trim().toUpperCase() === String(expected ?? '').trim().toUpperCase()
}

/**
 * 默认执行器：SSH 进客户机。
 *
 * 用 `-o BatchMode=yes` 是刻意的：自检是自动化动作，不能停在交互提示上。
 * `-o StrictHostKeyChecking=accept-new` 让首次连接可用，同时不放弃后续校验。
 */
function defaultSshExec({ sshTarget, keyPath, timeoutMs = 10_000 }) {
  const [host, port] = splitTarget(sshTarget)
  const base = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.max(1, Math.round(timeoutMs / 1000))}`,
    ...(keyPath ? ['-i', String(keyPath)] : []),
    '-p', String(port),
  ]
  return ({ command, args = [] }) => new Promise((resolve) => {
    const remote = [command, ...args].join(' ')
    execFile('ssh', [...base, host, remote], { timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        })
      })
  })
}

/** `user@host:port` 或 `host` → [user@host, port]。 */
export function splitTarget(target) {
  const raw = String(target ?? '')
  const m = /^(.*?):(\d+)$/.exec(raw)
  if (m) return [m[1], Number(m[2])]
  return [raw, 22]
}

/**
 * dmidecode 输出的解析：`Key: Value` 逐行。
 *
 * 只取第一个冒号，值里可能还有冒号（例如序列号 `.ABC:CN123.`）。
 */
export function parseDmidecodeFields(stdout) {
  const out = {}
  for (const line of String(stdout ?? '').split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

/**
 * 从 `dmidecode -t 1` 的完整输出里取系统信息。
 *
 * 只认 "System Information" 段：整个 -t 1 输出里还有别的 Key: Value，
 * 直接全表取值会把 "Wake-up Type" 之类的字段混进来。
 */
export function parseSystemInformation(stdout) {
  const text = String(stdout ?? '')
  const start = text.indexOf('System Information')
  if (start < 0) return {}
  const rest = text.slice(start)
  // 下一段以 "Handle " 开头
  const next = rest.indexOf('\nHandle ')
  return parseDmidecodeFields(next > 0 ? rest.slice(0, next) : rest)
}

/**
 * 在 KVM 客户机内校验 persona 是否被 QEMU 正确提供。
 *
 * @param {object} p
 * @param {string} p.sshTarget             user@host:port
 * @param {object} p.expected              qemuArgsForPersona 的返回，或 { persona, mac, smbios }
 * @param {string} [p.keyPath]             SSH 私钥
 * @param {Function} [p.exec]              ({command,args}) => {ok,stdout,stderr}
 * @param {Function} [p.readFile]          可选：本地读取覆盖（测试用）
 * @param {boolean} [p.requireDmidecode=true] 是否要求 dmidecode 可用
 * @returns {Promise<object>}
 */
export async function verifyKvmPersona({ sshTarget, expected, keyPath, exec, readFile, requireDmidecode = true } = {}) {
  if (!sshTarget) throw new Error('verifyKvmPersona requires sshTarget')
  if (!expected) throw new Error('verifyKvmPersona requires expected (a kvm-spec result)')

  const execFn = exec || defaultSshExec({ sshTarget, keyPath })
  const persona = expected.persona || null
  const mac = String(expected.mac || '')
  const smbios = expected.smbios || {}

  const run = async (command, args = []) => {
    const r = await execFn({ command, args })
    return {
      ok: Boolean(r?.ok),
      out: String(r?.stdout ?? ''),
      err: String(r?.stderr ?? ''),
    }
  }

  const checks = []
  const add = (name, want, got, pass, note) => {
    checks.push({ name, expected: want, actual: got, pass: Boolean(pass), ...(note ? { note } : {}) })
  }

  // ───── 期望值：取 SMBIOS 表（那是真正传给 QEMU 的东西），
  //      而不是 persona 原始字段。两者若有分叉，以 SMBIOS 为准，
  //      因为客户机看到的是它。
  const want = {
    sys_vendor: smbios[1]?.manufacturer ?? sysVendorOf(persona),
    product_name: smbios[1]?.product ?? productNameOf(persona),
    product_version: smbios[1]?.version ?? '',
    product_serial: smbios[1]?.serial ?? productSerialOf(persona),
    product_uuid: smbios[1]?.uuid ?? productUuidOf(persona),
    product_family: smbios[1]?.family ?? '',
    board_vendor: smbios[2]?.manufacturer ?? '',
    board_name: smbios[2]?.product ?? '',
    board_version: smbios[2]?.version ?? '',
    board_serial: smbios[2]?.serial ?? '',
    bios_vendor: smbios[0]?.vendor ?? '',
    bios_version: smbios[0]?.version ?? '',
    bios_date: smbios[0]?.date ?? '',
    chassis_vendor: smbios[3]?.manufacturer ?? '',
    chassis_serial: smbios[3]?.serial ?? '',
  }

  // ───── 路径 A：sysfs ─────
  // 逐个文件 cat。一次读多个文件（cat f1 f2 ...）会把内容连成一行，
  // 无法区分哪个字段失败，所以逐字段执行。
  const sysfs = {}
  for (const field of KVM_VERIFY_FIELDS) {
    const r = await run('cat', [`/sys/class/dmi/id/${field}`])
    sysfs[field] = r.out.trim()
    const isUuid = field === 'product_uuid'
    const pass = r.ok && (isUuid ? uuidEqual(want[field], r.out) : exact(want[field], r.out))
    add(`/sys/class/dmi/id/${field}`, want[field], sysfs[field], pass,
      r.ok ? undefined : `read failed: ${r.err || 'no such file'}`)
  }

  // ───── 路径 B：dmidecode ─────
  // 这条路径独立于 sysfs：dmidecode 自己解析 SMBIOS 表，不读 sysfs。
  // 两条路径不一致 = 表本身有问题。
  let dmidecodeAvailable = true
  for (const keyword of KVM_VERIFY_KEYWORDS) {
    const r = await run('dmidecode', ['-s', keyword])
    const field = Object.keys(KVM_DMI_TO_DMIDECODE).find((k) => KVM_DMI_TO_DMIDECODE[k] === keyword)
    const isUuid = keyword === 'system-uuid'
    const pass = r.ok && (isUuid ? uuidEqual(want[field], r.out) : exact(want[field], r.out))
    if (!r.ok) dmidecodeAvailable = false
    // requireDmidecode=false 时，dmidecode 缺失只作为「该路径跳过」记录，
    // 不计入失败。否则在没装 dmidecode 的精简镜像上，自检永远不通过 ——
    // 而 sysfs 那条路径已经把同样的值核对过了，结论并不受影响。
    if (!r.ok && !requireDmidecode) {
      checks.push({
        name: `dmidecode -s ${keyword}`,
        expected: want[field],
        actual: '',
        pass: true,
        skipped: true,
        note: `dmidecode 不可用，跳过该路径（sysfs 已核对）: ${r.err.slice(0, 80)}`,
      })
      continue
    }
    add(`dmidecode -s ${keyword}`, want[field], r.out.trim(), pass,
      r.ok ? undefined : `dmidecode unavailable or failed: ${r.err.slice(0, 80)}`)
  }

  // dmidecode -t 1 整段：验证表结构本身可读，而不只是单字段
  const t1 = await run('dmidecode', ['-t', '1'])
  if (t1.ok) {
    const sys = parseSystemInformation(t1.out)
    add('dmidecode -t 1 Manufacturer', want.sys_vendor, sys.Manufacturer || '',
      exact(want.sys_vendor, sys.Manufacturer || ''))
    add('dmidecode -t 1 Product Name', want.product_name, sys['Product Name'] || '',
      exact(want.product_name, sys['Product Name'] || ''))
    add('dmidecode -t 1 Serial Number', want.product_serial, sys['Serial Number'] || '',
      exact(want.product_serial, sys['Serial Number'] || ''))
    add('dmidecode -t 1 UUID', want.product_uuid, sys.UUID || '',
      uuidEqual(want.product_uuid, sys.UUID || ''))
    add('dmidecode -t 1 Family', want.product_family, sys.Family || '',
      !want.product_family || exact(want.product_family, sys.Family || ''),
      want.product_family ? undefined : 'persona 未声明 family，跳过')
  } else if (requireDmidecode) {
    add('dmidecode -t 1', 'readable', '', false, `dmidecode failed: ${t1.err.slice(0, 80)}`)
  } else {
    checks.push({
      name: 'dmidecode -t 1', expected: 'readable', actual: '', pass: true, skipped: true,
      note: `dmidecode 不可用，跳过该路径（sysfs 已核对）: ${t1.err.slice(0, 80)}`,
    })
  }

  // ───── 机箱类型：QEMU 固定值，验证的是「我们没指望它能被覆盖」─────
  const t3 = await run('dmidecode', ['-t', '3'])
  if (t3.ok) {
    const chassis = parseDmidecodeFields(t3.out)
    const typeText = String(chassis.Type || '')
    // QEMU 把 type 3 的 chassis type 写死为 0x01，dmidecode 显示成 "Other"。
    // 这里不做「等于 persona 期望值」的判定 —— 那个值传不进去。
    add('dmidecode -t 3 Type', 'Other', typeText,
      /^Other/i.test(typeText),
      'QEMU 固定 chassis type 为 1，命令行不可覆盖')
  }

  // ───── 主机名 ─────
  const hostname = String(persona?.naming?.hostname || persona?.naming?.computer_name || expected.vmId || '')
  if (hostname) {
    const hn = await run('hostname')
    add('hostname', hostname, hn.out.trim(), hn.ok && exact(hostname, hn.out))
    const un = await run('uname', ['-n'])
    add('uname -n', hostname, un.out.trim(), un.ok && exact(hostname, un.out))
  }

  // ───── 客户机内核：这是 KVM 相对容器的根本优势 ─────
  // uname -r 报的是客户机自己的内核版本，与宿主机无关。
  // 容器里这个值与宿主相同，是一眼可辨的差异；虚拟机里天然不同。
  const unameR = await run('uname', ['-r'])
  const guestKernel = unameR.out.trim()
  add('uname -r (guest kernel)', '(non-empty)', guestKernel,
    unameR.ok && guestKernel.length > 0,
    unameR.ok ? '客户机自带内核，与宿主机无关' : 'command failed')

  const uS = await run('uname', ['-s'])
  add('uname -s', 'Linux', uS.out.trim(), uS.ok && exact('Linux', uS.out))

  // 虚拟化标记：KVM 客户机里 /sys/hypervisor 或 CPUID hypervisor bit 会暴露
  // "KVM" 字样。这一点不必掩饰，但要如实报出来 —— 那是宿主选择的结果，
  // 不是 persona 参数能改的。
  const virt = await run('systemd-detect-virt')
  const virtOut = virt.out.trim()
  add('systemd-detect-virt', '(reported)', virtOut, true,
    virt.ok ? `客户机被识别为 ${virtOut || 'none'}` : 'systemd-detect-virt 不可用')

  // ───── MAC ─────
  const iface = String(persona?.network?.interface || 'eth0')
  const link = await run('cat', [`/sys/class/net/${iface}/address`])
  add(`/sys/class/net/${iface}/address`, mac, link.out.trim(), link.ok && macEqual(mac, link.out),
    link.ok ? undefined : `read failed: ${link.err || 'no such interface'}`)

  const ipLink = await run('ip', ['link', 'show'])
  const gotMac = (String(ipLink.out).match(/link\/ether\s+([0-9a-f:]{17})/i) || [])[1] || ''
  add('ip link show MAC', mac, gotMac, ipLink.ok && macEqual(mac, gotMac),
    ipLink.ok ? undefined : 'command failed')

  // ───── 磁盘序列号：QEMU 的 virtio-blk serial 会出现在 udev 里 ─────
  const wantDisk = String(expected.diskSerial || '')
  if (wantDisk) {
    const byId = await run('ls', ['/dev/disk/by-id'])
    const hit = String(byId.out).includes(wantDisk)
    add('/dev/disk/by-id virtio serial', wantDisk, hit ? wantDisk : '(missing)',
      byId.ok && hit, byId.ok ? undefined : 'ls failed')
  }

  const failed = checks.filter((c) => !c.pass)
  return {
    ok: failed.length === 0,
    vmId: String(expected.vmId || persona?.vm_id || ''),
    sshTarget: String(sshTarget),
    platform: String(expected.platform || persona?.platform || 'linux'),
    mac,
    uuid: want.product_uuid,
    serial: want.product_serial,
    guestKernel,
    dmidecodeAvailable,
    chassisType: QEMU_FIXED_CHASSIS_TYPE,
    checks,
    failed,
    summary: `${checks.length - failed.length}/${checks.length} passed`,
  }
}

/** 严格模式：任一检查失败即抛错，消息里列出全部不符项。 */
export async function assertKvmPersona(opts = {}) {
  const result = await verifyKvmPersona(opts)
  if (result.ok) return result
  const detail = result.failed
    .map((c) => `  - ${c.name}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`)
    .join('\n')
  const err = new Error(`kvm persona verification failed (${result.failed.length}/${result.checks.length}):\n${detail}`)
  err.code = 'KVM_PERSONA_VERIFY_FAILED'
  err.result = result
  throw err
}

/**
 * 未注入 SMBIOS 时的基线：同一台宿主上不做任何 -smbios 参数启动时读到的值。
 *
 * 用途是把「QEMU 默认值」和「我们的参数生效」区分开。QEMU 默认会填
 * `QEMU` / `Standard PC (Q35 + ICH9, 2009)` 这类字样 —— 那正是必须避免的。
 */
export const QEMU_DEFAULT_SMBIOS = Object.freeze({
  sys_vendor: 'QEMU',
  product_name: 'Standard PC (Q35 + ICH9, 2009)',
  bios_vendor: 'SeaBIOS',
  chassis_vendor: 'QEMU',
})

/**
 * 判定一组 sysfs 值是否仍然是 QEMU 默认值（即 SMBIOS 参数没生效）。
 * 返回命中的字段名列表；空数组表示没有命中默认值。
 */
export function detectDefaultSmbiosLeak(values) {
  const hits = []
  for (const [field, def] of Object.entries(QEMU_DEFAULT_SMBIOS)) {
    const got = String(values?.[field] ?? '').trim()
    if (!got) continue
    if (got === def) hits.push(field)
  }
  return hits
}

/** path 工具再导出：调用方拼路径时不必再 import node:path。 */
export { path as kvmNodePath }
export { fs as kvmFs }
