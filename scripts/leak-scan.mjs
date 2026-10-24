#!/usr/bin/env node
/**
 * 信息泄漏反扫。
 *
 * 此前所有验证都是「该藏的藏了吗」——那只能证明我们主动设置的值对了，
 * 证明不了「还有没有别的没藏」。这个脚本反过来：逐个检查容器内
 * 已知的、会暴露运行环境的特征点。
 *
 * 判据分三档：
 *   CLEAN   真实机器上也是这个样子 → 不构成泄漏
 *   LEAK    只有容器/虚拟化环境才有 → 需要处理
 *   SHARED  宿主机共享，无法在容器内伪造 → 记录，靠别的手段掩盖
 *
 * 用法：
 *   node scripts/leak-scan.mjs --container claude-slot-01
 */
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (n, d = null) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const container = arg('--container', 'claude-slot-01')

const sh = (cmd) => {
  try {
    return execFileSync('docker', ['exec', container, 'sh', '-c', cmd], {
      encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return String(error?.stdout || '') + String(error?.stderr || '')
  }
}

const rows = []
const add = (name, status, detail) => { rows.push({ name, status, detail }) }

console.log(`=== 信息泄漏反扫：${container} ===\n`)

// ── 1. 容器身份文件
{
  const out = sh('ls -la /.dockerenv 2>&1')
  const exists = /^[-rwx]/.test(out.trim())
  add('/.dockerenv', exists ? 'LEAK' : 'CLEAN',
    exists ? '文件存在，任何读取 /.dockerenv 的代码都能判定容器' : '不存在')
}

// ── 2. containerenv
{
  const out = sh('ls -la /run/.containerenv 2>&1')
  const exists = /^[-rwx]/.test(out.trim())
  add('/run/.containerenv', exists ? 'LEAK' : 'CLEAN', exists ? 'podman 容器标记' : '不存在')
}

// ── 3. cgroup：容器里是 0::/ 或 /docker/<id>
{
  const out = sh('cat /proc/1/cgroup 2>/dev/null').trim()
  const lines = out.split('\n').filter(Boolean)
  const hasDocker = /docker|kubepods|containerd|libpod/i.test(out)
  const isBare = lines.length > 0 && lines.every((l) => /^0::\/$/.test(l.trim()))
  // cgroup v2 在裸机上也可能出现 console.slice 之类，0::/ 是容器 + 私有 ns 的形态
  // cgroupns 两个选项实测都不理想：
  //   host    → 0::/system.slice/docker-<64位ID>.scope（直接泄漏容器 ID，更糟）
  //   private → 0::/                                         （当前，至少不带 ID）
  // 所以 private 已是较优解，标 UNFIXABLE 而不是 LEAK。
  add('/proc/1/cgroup', hasDocker ? 'LEAK' : isBare ? 'UNFIXABLE' : 'CLEAN',
    hasDocker ? `含容器标识: ${lines.find((l) => /docker|kube|containerd|libpod/i.test(l))?.trim().slice(0, 60)}`
      : isBare ? '0::/ —— cgroup v2 + 私有 ns；host 模式会暴露 64 位容器 ID，private 已是最优' : lines[0]?.slice(0, 60) || '空')
}

// ── 4. overlay 文件系统
{
  const n = Number(sh('grep -c "[[:space:]]overlay[[:space:]]" /proc/mounts 2>/dev/null').trim()) || 0
  // 双问题：既是容器文件系统特征，又会把宿主 snapshots 路径写进 /proc/mounts
  add('/proc/mounts overlay', n > 0 ? 'LEAK' : 'CLEAN',
    n > 0 ? `${n} 个 overlay 挂载 —— 容器特征，且暴露宿主快照路径` : '无')
}

// ── 5. 挂载源路径
{
  // 不能只查 /var/lib/docker —— containerd 是另一套路径，
  // 而 overlay 的 lowerdir/upperdir 恰恰是 containerd 的 snapshots 目录。
  // 只查 docker 会误判成 CLEAN（实测踩过）。
  const out = sh('grep -oE "/var/lib/(docker|containerd)[^ ,:]*" /proc/mounts 2>/dev/null | head -3').trim()
  add('挂载源路径', out ? 'LEAK' : 'CLEAN',
    out ? `暴露宿主快照路径: ${out.split('\n')[0].slice(0, 90)}` : '/var/lib/{docker,containerd} 未出现')
}

// ── 6. cgroup 里的 docker id
{
  const out = sh('grep -oE "[0-9a-f]{64}" /proc/self/cgroup 2>/dev/null | head -1').trim()
  add('cgroup 容器 ID', out ? 'LEAK' : 'CLEAN', out || '无 64 位容器 ID')
}

// ── 7. 内核版本（宿主机共享，无法在容器内伪造）
{
  const out = sh('uname -r 2>/dev/null').trim()
  const persona = sh('cat /proc/sys/kernel/osrelease 2>/dev/null').trim()
  // osrelease 是 /proc 里的，容器里改不了；uname 读的就是它
  add('uname -r / osrelease', 'SHARED',
    `${out || '?'} —— 容器共享宿主内核，runc 拒绝 bind-mount /proc/sys/kernel/osrelease`)
}

// ── 8. DMI 原始表：Docker 下无法伪造
{
  const out = sh('ls /sys/firmware/dmi/tables/ 2>&1').trim()
  const absent = /No such file|cannot access/i.test(out)
  // /sys 是内核 sysfs，runc 不能在其下创建挂载点（实测 /sys/firmware 与
  // /sys/firmware/dmi 都挂不上）。所以这张原始 ACPI 表在 Docker 里造不出来。
  //
  // 影响有限：dmidecode 需要 /dev/mem 或这张表，两者容器里都没有，
  // 它本来就会报错 —— 关键是不能让 /sys/class/dmi/id/* 也缺（那才是
  // 大多数程序读的地方，已通过整目录挂载修好）。
  //
  // 标 UNFIXABLE 而不是 LEAK：这是 Docker 的硬约束，不是没做。
  add('/sys/firmware/dmi（原始表）', absent ? 'UNFIXABLE' : 'CLEAN',
    absent ? 'sysfs 下无法挂载 —— Docker 硬约束，dmidecode 需 /dev/mem 本就不可用'
      : out.split('\n').slice(0, 3).join(', '))
}

// ── 8b. hypervisor 标记：有内容说明是虚拟机
{
  const out = sh('cat /sys/hypervisor/type 2>/dev/null').trim()
  const entries = sh('ls /sys/hypervisor/ 2>/dev/null').trim()
  const empty = !out && !entries
  add('/sys/hypervisor', empty ? 'CLEAN' : 'LEAK',
    empty ? '空（未暴露 Xen/KVM 标记）' : `type=${out} 内容=${entries}`)
}

// ── 9. 我们伪造的 DMI 是否齐全
{
  const keys = ['product_uuid', 'product_serial', 'sys_vendor', 'product_name', 'board_serial', 'chassis_serial']
  const got = []
  const missing = []
  for (const k of keys) {
    const v = sh(`cat /sys/class/dmi/id/${k} 2>/dev/null`).trim()
    if (v && !/No such file/i.test(v)) got.push(k)
    else missing.push(k)
  }
  add('/sys/class/dmi/id/*', missing.length ? 'LEAK' : 'CLEAN',
    missing.length ? `缺 ${missing.join(', ')}` : `${got.length}/${keys.length} 齐全`)
}

// ── 10. machine-id / hostname 一致性
{
  const mid = sh('cat /etc/machine-id 2>/dev/null').trim()
  const dbus = sh('cat /var/lib/dbus/machine-id 2>/dev/null').trim()
  const same = mid.length > 0 && mid === dbus
  add('machine-id 双份一致', same ? 'CLEAN' : 'LEAK',
    same ? '一致' : `/etc/machine-id=${mid.slice(0, 12)}… /var/lib/dbus/machine-id=${dbus.slice(0, 12) || '(缺)'}`)
}
{
  const h1 = sh('hostname 2>/dev/null').trim()
  const h2 = sh('cat /etc/hostname 2>/dev/null').trim()
  const h3 = sh('uname -n 2>/dev/null').trim()
  const allSame = h1 && h1 === h2 && h1 === h3
  add('hostname 三处一致', allSame ? 'CLEAN' : 'LEAK', `${h1} / ${h2} / ${h3}`)
}

// ── 11. 环境变量里的容器痕迹
{
  const out = sh('env 2>/dev/null | grep -icE "docker|kube|container|podman"').trim()
  const n = Number(out) || 0
  add('环境变量容器痕迹', n > 0 ? 'LEAK' : 'CLEAN', n > 0 ? `${n} 个可疑变量` : '无')
}

// ── 12. 网络接口名（容器常见 eth0，真机也常见，不算强特征）
{
  const out = sh('cat /proc/net/dev 2>/dev/null | tail -n +3 | awk -F: "{print \\$1}" | tr -d " " | grep -v "^$"').trim()
  const ifaces = out.split('\n').filter(Boolean)
  const suspicious = ifaces.filter((i) => /^(veth|docker|br-)/.test(i))
  add('网络接口名', suspicious.length ? 'LEAK' : 'CLEAN',
    suspicious.length ? `可疑: ${suspicious.join(', ')}` : ifaces.join(', ') || '空')
}

// ── 输出
console.log('')
const w = Math.max(...rows.map((r) => r.name.length))
const icon = { CLEAN: '✓', LEAK: '✗', SHARED: '△', UNFIXABLE: '⊘' }
for (const r of rows) {
  console.log(`  ${icon[r.status]} ${r.name.padEnd(w)}  [${r.status.padEnd(6)}] ${r.detail}`)
}

const leaks = rows.filter((r) => r.status === 'LEAK')
const shared = rows.filter((r) => r.status === 'SHARED')
const unfixable = rows.filter((r) => r.status === 'UNFIXABLE')
console.log(`\n  CLEAN ${rows.filter((r) => r.status === 'CLEAN').length} / LEAK ${leaks.length} / SHARED ${shared.length} / UNFIXABLE ${unfixable.length}`)
if (leaks.length) {
  console.log('\n  需要处理的泄漏：')
  for (const l of leaks) console.log(`    - ${l.name}：${l.detail}`)
}
if (shared.length) {
  console.log('\n  共享宿主机、容器内无法伪造（靠其他手段掩盖）：')
  for (const s of shared) console.log(`    - ${s.name}：${s.detail}`)
}
if (unfixable.length) {
  console.log('\n  Docker 硬约束，实测无法修复（不是没做）：')
  for (const u of unfixable) console.log(`    - ${u.name}：${u.detail}`)
}
process.exit(0)
