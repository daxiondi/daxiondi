/**
 * 容器内自检：确认 persona 真的生效了
 *
 * 为什么需要独立一层：
 *   apply 返回 `ok: true` 只说明「写文件没报错」。它没法知道命令包装脚本是否
 *   真的在 PATH 前面、挂载是否真的盖住了 /sys、docker 有没有因为参数不合法把
 *   --hostname 静默丢掉。这些只有「真的执行一次命令、真的读一次文件」才能确认。
 *
 * 所有外部读取都走注入点（opts.exec / opts.readFile / opts.root），
 * 因此这个模块既能在真容器里跑，也能在测试里用假命令跑，去验证它确实能
 * 报出「值与 persona 不符」这种情况 —— 一个永远返回 pass 的自检等于没有自检。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { buildPersona } from './index.mjs'
import { DMI_TO_DMIDECODE } from './docker-spec.mjs'
import { underRoot } from './apply.mjs'

/** 一条检查项的默认判定：去掉首尾空白后逐字相等 */
function exact(expected, actual) {
  return String(actual ?? '').trim() === String(expected ?? '').trim()
}

/** 大小写不敏感的 MAC 判定 */
function macEqual(expected, actual) {
  return String(actual ?? '').trim().toUpperCase() === String(expected ?? '').trim().toUpperCase()
}

/** 默认命令执行器：走 PATH，返回 stdout；非零退出码当失败内容处理，不抛 */
function defaultExec({ command, args, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

/**
 * MAC 的可见来源有三个，按可靠性排序：
 *   /sys/class/net/<iface>/address   ← 最直接，纯文件读
 *   ip link show                     ← 经过包装脚本，能顺带验证包装是否生效
 *   /etc/persona.json 里的记录        ← 只证明写盘成功，不证明生效
 * 默认两个都查，任一不符即判失败。
 */
function defaultIface(persona) {
  return String(persona.network?.interface || 'eth0')
}

/**
 * 在容器内校验 persona 是否真的生效。
 *
 * @param {object} p   persona（或 { platform, vmId } 用来现构造）
 * @param {object} [opts]
 * @param {string} [opts.root='/']          容器内根前缀（测试时指向临时目录）
 * @param {Function} [opts.exec]            自定义命令执行器 ({command,args}) => {stdout,...}
 * @param {Function} [opts.readFile]        自定义文件读取 (absPath) => string（抛错表示读不到）
 * @param {string} [opts.interface]         网卡名，默认取 persona.network.interface
 * @param {boolean} [opts.requireWrappers=true] 是否要求命令包装已生效
 * @returns {Promise<{ok:boolean, checks:Array, failed:Array, platform:string, vmId:string}>}
 */
export async function verifyPersonaInContainer(p, opts = {}) {
  const persona = p?.hardware ? p : buildPersona({
    platform: opts.platform || p?.platform || 'linux',
    vmId: opts.vmId || p?.vmId || 'default',
    overrides: opts.overrides || {},
  })
  const platform = persona.platform
  const root = opts.root || '/'
  const exec = opts.exec || defaultExec
  const readFile = opts.readFile || ((abs) => fs.readFileSync(abs, 'utf8'))
  const read = (containerPath) => {
    try {
      return { ok: true, value: readFile(underRoot(root, containerPath)) }
    } catch (e) {
      return { ok: false, value: '', error: e.code || e.message }
    }
  }
  const run = async (command, args = []) => {
    const r = await exec({ command, args })
    return { ok: Boolean(r?.ok), out: String(r?.stdout ?? ''), err: String(r?.stderr ?? '') }
  }

  const checks = []
  const add = (name, expected, actual, pass, note = undefined) => {
    checks.push({ name, expected, actual, pass: Boolean(pass), ...(note ? { note } : {}) })
  }

  const visible = String(
    persona.naming?.hostname || persona.naming?.computer_name || '',
  )

  // ───── 命令层 ─────
  // 只查这些命令，是因为它们是「一眼看机器是谁」的那几个。
  // 命令名与平台相关：Windows 容器里没有 uname，直接跳过而不是记失败。
  if (platform === 'windows') {
    const r = await run('hostname', [])
    const expected = String(persona.naming?.computer_name || '')
    add('hostname', expected, r.out.trim(), r.ok && exact(expected, r.out), r.ok ? undefined : 'command failed')

    const env = await run('cmd', ['/c', 'echo %COMPUTERNAME%'])
    add('echo %COMPUTERNAME%', expected, env.out.trim(), env.ok && exact(expected, env.out))

    const reg = await run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\SystemInformation'])
    const uuidExpected = String(persona.hardware?.uuid || '')
    add(
      'reg SystemInformation UUID',
      uuidExpected.toLowerCase(),
      String(reg.out).toLowerCase().includes(uuidExpected.toLowerCase()) ? uuidExpected.toLowerCase() : '',
      reg.ok && String(reg.out).toLowerCase().includes(uuidExpected.toLowerCase()),
    )
  } else {
    // hostname
    const h = await run('hostname', [])
    add('hostname', visible, h.out.trim(), h.ok && exact(visible, h.out), h.ok ? undefined : 'command failed')

    // uname -n
    const u = await run('uname', ['-n'])
    add('uname -n', visible, u.out.trim(), u.ok && exact(visible, u.out), u.ok ? undefined : 'command failed')

    // uname -s / -r 顺带验证包装完整，不参与主机名判定，但能发现「只装了部分包装」
    if (platform === 'linux') {
      const us = await run('uname', ['-s'])
      add('uname -s', 'Linux', us.out.trim(), us.ok && exact('Linux', us.out))

      // uname -r：内核版本能否伪造，取决于虚拟化方式，不是配置问题。
      //
      //   kvm / 裸机 —— 客户机有自己的内核，SMBIOS 由 QEMU 写入，uname -r 是真值。
      //   docker     —— 容器共享宿主机内核，/proc/sys/kernel/osrelease 无法挂载
      //                 （runc 直接拒绝：cannot be mounted because it is inside /proc），
      //                 uname -r 永远返回宿主机版本。这是内核级限制，绕过它需要
      //                 syscall 拦截，代价远大于收益。
      //
      // 所以在 docker 下把这一项标成「不适用」并跳过。判失败会让每个 docker 槽位
      // 都启动失败 —— 而失败原因跟配置无关，永远修不好。
      const runtimeKind = String(opts.runtimeKind || opts.virtualization || 'docker').toLowerCase()
      const kernelForgeable = runtimeKind === 'kvm' || runtimeKind === 'native'
      const ur = await run('uname', ['-r'])
      const expectedRelease = String(persona.software?.kernel_release || '')
      if (kernelForgeable) {
        add('uname -r', expectedRelease, ur.out.trim(), ur.ok && exact(expectedRelease, ur.out))
      } else {
        checks.push({
          name: 'uname -r',
          expected: expectedRelease,
          actual: ur.out.trim(),
          pass: true,
          skipped: true,
          note: `docker 共享宿主机内核，无法伪造（需要 kvm）；期望 ${expectedRelease}，实际宿主机内核`,
        })
      }

      // hostnamectl：容器里通常不存在这个二进制（systemd 工具）。
      // 缺命令不等于 persona 没生效 —— 真正生效的是 /etc/hostname 与 /etc/machine-id，
      // 那两项在上面已经独立校验过了。这里缺命令时标跳过而不是失败。
      const hc = await run('hostnamectl', [])
      const staticName = (String(hc.out).match(/Static hostname:\s*(\S+)/) || [])[1] || ''
      const mid = String(persona.machine_id || '')
      const hcMid = (String(hc.out).match(/Machine ID:\s*([0-9a-f]{32})/) || [])[1] || ''
      if (hc.ok && String(hc.out).trim()) {
        add('hostnamectl Static hostname', visible, staticName, exact(visible, staticName))
        add('hostnamectl Machine ID', mid, hcMid, exact(mid, hcMid))
      } else {
        checks.push({
          name: 'hostnamectl', expected: visible, actual: '', pass: true, skipped: true,
          note: '容器内无 hostnamectl（systemd 工具），/etc/hostname 与 /etc/machine-id 已独立校验',
        })
      }
    }

    if (platform === 'macos') {
      const cn = await run('scutil', ['--get', 'ComputerName'])
      const expectedCn = String(persona.naming?.computer_name || '')
      add('scutil ComputerName', expectedCn, cn.out.trim(), cn.ok && exact(expectedCn, cn.out))

      const lh = await run('scutil', ['--get', 'LocalHostName'])
      const expectedLh = String(persona.naming?.local_hostname || visible.replace(/\.local$/, ''))
      add('scutil LocalHostName', expectedLh, lh.out.trim(), lh.ok && exact(expectedLh, lh.out))
    }
  }

  // ───── 文件层 ─────
  const machineId = String(persona.machine_id || '')
  if (platform === 'linux') {
    const f = read('/etc/machine-id')
    add(
      '/etc/machine-id',
      machineId,
      f.value.trim(),
      f.ok && exact(machineId, f.value),
      f.ok ? undefined : `read failed: ${f.error}`,
    )
    const d = read('/var/lib/dbus/machine-id')
    add(
      '/var/lib/dbus/machine-id',
      machineId,
      d.value.trim(),
      d.ok && exact(machineId, d.value),
      d.ok ? undefined : `read failed: ${d.error}`,
    )
  }

  const hf = read('/etc/hostname')
  add(
    '/etc/hostname',
    visible,
    hf.value.trim(),
    hf.ok && exact(visible, hf.value),
    hf.ok ? undefined : `read failed: ${hf.error}`,
  )

  if (platform === 'linux') {
    const osr = read('/etc/os-release')
    const expectedId = String(persona.software?.distro_id || '')
    const hasId = new RegExp(`^ID=${expectedId}$`, 'm').test(String(osr.value))
    add('/etc/os-release ID', expectedId, hasId ? expectedId : '(missing)', osr.ok && hasId,
      osr.ok ? undefined : `read failed: ${osr.error}`)
  }

  // ───── DMI 层（只有 Linux 有）─────
  if (platform === 'linux') {
    // sysfs 侧：只读文件，挂载层提供。
    // 抽查 4 个字段就够 —— 22 个字段全查会让自检输出冗长，而这 4 个是
    // 上游日志里出现频率最高的。
    for (const field of ['product_serial', 'product_uuid', 'sys_vendor', 'product_name']) {
      const expected = String(persona.hardware[field])
      const f = read(`/sys/class/dmi/id/${field}`)
      add(`/sys/class/dmi/id/${field}`, expected, f.value.trim(), f.ok && exact(expected, f.value),
        f.ok ? undefined : `read failed: ${f.error}`)
    }

    // dmidecode 侧：经过包装脚本。sysfs 与 dmidecode 必须报同一个值 ——
    // 两个来源分裂是最典型的一种半生效状态。
    //
    // 但 dmidecode 在 docker 里**不可能真跑通**：它靠读 /dev/mem 或
    // /sys/firmware/dmi/tables 取 SMBIOS 原始表，容器两者都没有
    // （实测 /dev/mem: No such file or directory）。真正能伪装的只有
    // /sys/class/dmi/id/*，那是 runc bind mount 覆盖的文件，
    // 上面 sysfs 那几项已经独立校验过了。
    //
    // 所以 docker 下只校验「包装脚本是否装上了」，不校验 dmidecode 能否出值；
    // kvm 下客户机内核按 QEMU 写的 SMBIOS 表生成 /sys 与 /dev/mem，
    // dmidecode 能真读，那时才做双源比对。
    const runtimeKind = String(opts.runtimeKind || opts.virtualization || 'docker').toLowerCase()
    const dmiReadable = runtimeKind === 'kvm' || runtimeKind === 'native'
    for (const keyword of ['system-serial-number', 'system-uuid']) {
      const field = DMI_TO_DMIDECODE[keyword]
      const expected = String(persona.hardware[field])
      const r = await run('dmidecode', ['-s', keyword])
      if (dmiReadable) {
        add(`dmidecode -s ${keyword}`, expected, r.out.trim(), r.ok && exact(expected, r.out),
          r.ok ? undefined : 'dmidecode unavailable or wrapper not in PATH')
      } else {
        // 只验「命令存在」，不看退出码。
        // dmidecode 装上了也会因为读不到 /dev/mem 而退出非零
        // （实测 `/dev/mem: No such file or directory`），
        // 用 r.ok 判定会把"装了但用不了"误报成"没装"，而后者才是真问题。
        const err = String(r.err || '')
        const absent = /not found|No such file|executable file/.test(err) && /dmidecode/.test(err)
        add(`包装脚本可达（${keyword}）`, 'present', absent ? 'absent' : 'present', !absent,
          absent ? 'dmidecode 未安装或不在 PATH' : 'docker 无 /dev/mem，取值由 sysfs 那几项校验')
      }
    }
  }

  // ───── 网络层 ─────
  const expectedMac = String(persona.network?.mac || persona.network?.en0_mac || '')
  const iface = String(opts.interface || defaultIface(persona))

  const sysMac = read(`/sys/class/net/${iface}/address`)
  if (sysMac.ok) {
    add(`/sys/class/net/${iface}/address`, expectedMac, sysMac.value.trim(),
      macEqual(expectedMac, sysMac.value))
  }

  if (platform !== 'windows') {
    const r = await run('ip', ['link', 'show'])
    const got = (String(r.out).match(/link\/ether\s+([0-9a-f:]{17})/i) || [])[1] || ''
    add('ip link show MAC', expectedMac, got, r.ok && macEqual(expectedMac, got),
      r.ok ? undefined : 'command failed')
  }

  const failed = checks.filter((c) => !c.pass)
  return {
    ok: failed.length === 0,
    platform,
    vmId: String(persona.vm_id),
    root,
    checks,
    failed,
    summary: `${checks.length - failed.length}/${checks.length} passed`,
  }
}

/**
 * 严格模式：任一检查失败即抛错，消息里列出全部不符项。
 * 给容器 entrypoint 用 —— 启动就报错，比带着错误身份跑一整天强。
 */
export async function assertPersonaInContainer(p, opts = {}) {
  const result = await verifyPersonaInContainer(p, opts)
  if (result.ok) return result
  const detail = result.failed
    .map((c) => `  - ${c.name}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(c.actual)}`)
    .join('\n')
  const err = new Error(`persona verification failed (${result.failed.length}/${result.checks.length}):\n${detail}`)
  err.code = 'PERSONA_VERIFY_FAILED'
  err.result = result
  throw err
}

/**
 * 未注入时的基线：在同一个环境里读一遍真实值。
 *
 * 用途是把「本来就这样」和「注入生效」区分开。如果基线值本身就等于
 * persona 值，说明这个环境恰好长得一样，那条检查没有判别力 —— 施工时
 * 必须知道这一点，否则会把巧合当成成功。
 */
export async function baselineWithoutPersona(opts = {}) {
  const root = opts.root || '/'
  const exec = opts.exec || defaultExec
  const readFile = opts.readFile || ((abs) => fs.readFileSync(abs, 'utf8'))
  const read = (containerPath) => {
    try {
      return readFile(underRoot(root, containerPath)).trim()
    } catch {
      return ''
    }
  }
  const run = async (command, args = []) => {
    const r = await exec({ command, args })
    return String(r?.stdout ?? '').trim()
  }
  return {
    hostname: await run('hostname', []),
    unameN: await run('uname', ['-n']),
    machineId: read('/etc/machine-id'),
    hostnameFile: read('/etc/hostname'),
    productSerial: read('/sys/class/dmi/id/product_serial'),
    productUuid: read('/sys/class/dmi/id/product_uuid'),
  }
}

/** Windows/macOS 也能查的通用项，供调用方按需拼装。 */
export const VERIFY_PATHS = Object.freeze({
  hostnameFile: '/etc/hostname',
  machineId: '/etc/machine-id',
  dbusMachineId: '/var/lib/dbus/machine-id',
  osRelease: '/etc/os-release',
  dmiDir: '/sys/class/dmi/id',
})

/** path 工具再导出：调用方拼路径时不必再 import node:path。 */
export { path as nodePath }
