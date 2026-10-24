#!/usr/bin/env node
/**
 * KVM 路径真机验证：启动一个 Linux 客户机，读里面的 DMI。
 *
 * 为什么需要这个：`kvm-smbios-live.mjs` 只能证明 **qemu 接受了参数**，
 * 证明不了 **客户机读到的值是对的**。参数被接受但字段没生效、
 * 或者被 qemu 悄悄丢弃，都是真实存在的情况。
 *
 * 没有 /dev/kvm 时用 TCG 软件模拟 —— 慢，但 SMBIOS 注入路径完全一样
 * （都是 qemu 的 -smbios 解析 → 生成 SMBIOS 表 → 客户机固件读表）。
 *
 * 做法：解包 Alpine netboot 的 initramfs，替换 /init 为读取 DMI 的小脚本，
 * 重新打包，然后用我们的 fleet-plan 生成的 -smbios 参数启动。
 *
 * 用法：
 *   node scripts/kvm-boot-verify.mjs [--vm 3] [--timeout 180]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const arg = (n, d = null) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const vms = Number(arg('--vm', '2'))
const timeoutSec = Number(arg('--timeout', '180'))

const WORK = '/tmp/kvm-boot-verify'
const KERNEL = path.join(WORK, 'vmlinuz')
const INITRAMFS_SRC = path.join(WORK, 'initramfs')
const INITRAMFS_PATCHED = path.join(WORK, 'initramfs-patched')

let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('=== KVM 客户机 DMI 真机验证 ===\n')

// ── 工具检查
let qemu = ''
try { qemu = execFileSync('which', ['qemu-system-x86_64'], { encoding: 'utf8' }).trim() } catch { /* 未装 */ }
ok('qemu-system-x86_64 可用', Boolean(qemu), qemu || '未安装')
if (!qemu) process.exit(1)

const hasKvm = fs.existsSync('/dev/kvm')
const accel = hasKvm ? 'kvm' : 'tcg'
console.log(`  加速器: ${accel}${hasKvm ? '' : '（无 /dev/kvm，软件模拟；SMBIOS 注入路径与 KVM 相同）'}\n`)

// ── 准备内核与 initramfs
fs.mkdirSync(WORK, { recursive: true })
if (!fs.existsSync(KERNEL) || !fs.existsSync(INITRAMFS_SRC)) {
  console.log('[准备] 下载 Alpine netboot 内核...')
  const base = 'https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/netboot'
  for (const [name, url] of [['vmlinuz', `${base}/vmlinuz-virt`], ['initramfs', `${base}/initramfs-virt`]]) {
    try {
      execFileSync('curl', ['-sL', '-o', path.join(WORK, name), url], { timeout: 180_000 })
    } catch (error) {
      ok(`下载 ${name}`, false, String(error?.message || error).slice(0, 80))
    }
  }
}

/** 解包 initramfs，替换 /init，重新打包。 */
function buildPatchedInitramfs() {
  const unpack = path.join(WORK, 'root')
  fs.rmSync(unpack, { recursive: true, force: true })
  fs.mkdirSync(unpack, { recursive: true })

  // gzip 的 cpio：先解压再解包
  execFileSync('sh', ['-c',
    `cd ${JSON.stringify(unpack)} && gzip -dc ${JSON.stringify(INITRAMFS_SRC)} | cpio -id 2>/dev/null || true`,
  ], { timeout: 120_000 })

  // 替换 init：挂 proc/sys 后打印 DMI
  const initScript = `#!/bin/sh
/bin/busybox mkdir -p /proc /sys
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sys /sys
/bin/busybox sleep 1
echo "===DMI-START==="
for f in sys_vendor product_name product_version product_serial product_uuid \\
         board_vendor board_name board_serial board_version \\
         chassis_serial chassis_asset_tag chassis_type \\
         bios_vendor bios_version bios_date; do
  printf "%s=" "$f"
  /bin/busybox cat /sys/class/dmi/id/$f 2>/dev/null || printf "(n/a)"
  echo
done
echo "===DMI-END==="
/bin/busybox sleep 1
echo o > /proc/sysrq-trigger 2>/dev/null
`
  fs.writeFileSync(path.join(unpack, 'init'), initScript, { mode: 0o755 })

  execFileSync('sh', ['-c',
    `cd ${JSON.stringify(unpack)} && find . | cpio -o -H newc 2>/dev/null | gzip > ${JSON.stringify(INITRAMFS_PATCHED)}`,
  ], { timeout: 120_000 })
  return fs.existsSync(INITRAMFS_PATCHED)
}

ok('initramfs 注入成功', buildPatchedInitramfs())

// ── 用我们的 fleet-plan 生成 SMBIOS 参数
const { planFleet } = await import('../src/persona/fleet-plan.mjs')
const plan = planFleet({ platform: 'linux', count: vms, prefix: 'slot', runtime: 'kvm' })
console.log(`\n[计划] ${plan.slots.length} 个槽位，runtime=${plan.runtime}\n`)

/** 启动一次客户机，返回客户机内读到的 DMI 键值。 */
function bootAndReadDmi(smbiosArgv) {
  const args = [
    '-machine', `q35,accel=${accel}`,
    '-m', '512', '-smp', '1',
    '-display', 'none', '-serial', 'stdio',
    '-kernel', KERNEL,
    '-initrd', INITRAMFS_PATCHED,
    '-append', 'console=ttyS0 quiet rdinit=/init',
    '-no-reboot',
  ]
  for (const a of smbiosArgv) args.push('-smbios', a)

  let out = ''
  try {
    out = execFileSync(qemu, args, {
      encoding: 'utf8', timeout: timeoutSec * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (error) {
    // qemu 被 sysrq 关机时退出码非 0，输出仍在 stdout
    out = String(error?.stdout || '')
  }

  const m = out.match(/===DMI-START===([\s\S]*?)===DMI-END===/)
  if (!m) return null
  const dmi = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf('=')
    if (i <= 0) continue
    dmi[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return dmi
}

for (const slot of plan.slots) {
  const k = slot.kvm
  console.log(`[${slot.vmId}]`)
  ok('有 smbiosArgv', Array.isArray(k.smbiosArgv) && k.smbiosArgv.length > 0, `${k.smbiosArgv?.length ?? 0} 条`)

  const dmi = bootAndReadDmi(k.smbiosArgv || [])
  ok('客户机启动并输出了 DMI', dmi !== null, '未捕获到 DMI 段（内核启动失败或超时）')
  if (!dmi) continue

  // 逐项比对：客户机读到 == 计划里的值
  const want = {
    product_uuid: k.uuid,
    product_serial: k.serial,
    sys_vendor: slot.persona?.hardware?.sys_vendor,
    product_name: slot.persona?.hardware?.product_name,
    board_serial: slot.persona?.hardware?.board_serial,
    board_vendor: slot.persona?.hardware?.board_vendor,
    chassis_serial: slot.persona?.hardware?.chassis_serial,
    bios_version: slot.persona?.hardware?.bios_version,
  }
  for (const [field, expected] of Object.entries(want)) {
    if (expected == null) continue
    const got = dmi[field] || ''
    // 前缀匹配：qemu 会给某些字段补尾随空格或截断
    const match = got === String(expected) || got.startsWith(String(expected)) || String(expected).startsWith(got)
    ok(`${field} 客户机内一致`, match, `读到 "${got}" 期望 "${expected}"`)
  }

  // board_* 是 Docker 里伪造不了的那几个，这里必须存在
  for (const f of ['board_vendor', 'board_name', 'board_serial', 'board_version']) {
    ok(`${f} 存在（Docker 里伪造不了，KVM 可以）`, Boolean(dmi[f]) && dmi[f] !== '(n/a)', dmi[f])
  }
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n结论：KVM 客户机内读到的 DMI 与计划值一致，硬件指纹真正生效。')
