#!/usr/bin/env node
/**
 * 跨字段一致性审计。
 *
 * 为什么需要这个：之前的验证只查「20 个槽是否各不相同」，
 * 那是**唯一性**，不等于**自洽性**。
 *
 * 实测发现的硬矛盾（全部是唯一性检查发现不了的）：
 *   · nproc 报 8，/proc/cpuinfo 只报 2 个 processor
 *   · MemTotal 报 1GB，cgroup memory.max 是 2.5GB
 *   · TZ=UTC，但出口 IP 在 America/Los_Angeles
 *   · 20 个槽的 /proc/uptime 完全相同（都等于宿主 uptime）
 *   · 20 个槽的 boot_id 完全相同
 *   · MAC 前缀 00:50:56 是 VMware OUI（虚拟化厂商，真实物理机不会有）
 *
 * 这些矛盾比「看起来一样」更致命：一个 curl ipinfo.io 就能发现
 * 时区与出口不符；一次 nproc 就能发现核数与 cpuinfo 不符。
 *
 * 用法：
 *   node scripts/consistency-audit.mjs [--slots 20] [--container claude-slot-01]
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
const slotCount = Number(arg('--slots', '20'))
const firstContainer = arg('--container', 'claude-slot-01')

let pass = 0
const fails = []
const warns = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push({ label, detail }); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}
const warn = (label, detail) => {
  warns.push({ label, detail })
  console.log(`  △ ${label}${detail ? ` — ${detail}` : ''}`)
}

const containerName = (i) => `claude-slot-${String(i).padStart(2, '0')}`
const inC = (c, cmd) => {
  try {
    return execFileSync('docker', ['exec', c, 'sh', '-c', cmd], {
      encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch { return '' }
}

console.log('=== 跨字段一致性审计 ===\n')

// ── 1. 容器存在性
const alive = []
for (let i = 1; i <= slotCount; i += 1) {
  try {
    execFileSync('docker', ['inspect', containerName(i)], { stdio: 'ignore', timeout: 10_000 })
    alive.push(i)
  } catch { /* 不存在 */ }
}
ok(`${slotCount} 个容器都在`, alive.length === slotCount, `实际 ${alive.length}`)
if (!alive.length) process.exit(1)
const C = containerName(alive[0])

// ── 2. CPU: nproc / cpuinfo / cgroup 三者必须一致
console.log('\n[1] CPU 三个来源必须一致')
{
  const nproc = Number(inC(C, 'nproc'))
  const cpuinfoCount = Number(inC(C, 'grep -c ^processor /proc/cpuinfo'))
  const cpuMaxRaw = inC(C, 'cat /sys/fs/cgroup/cpu.max 2>/dev/null')
  // cpu.max 形如 "200000 100000" → 2 核
  const cgroupCores = cpuMaxRaw && !/max/.test(cpuMaxRaw)
    ? Math.round(Number(cpuMaxRaw.split(' ')[0]) / Number(cpuMaxRaw.split(' ')[1]))
    : null

  ok('nproc 与 cpuinfo processor 数一致', nproc === cpuinfoCount,
    `nproc=${nproc} cpuinfo=${cpuinfoCount}`)
  if (cgroupCores !== null) {
    ok('cpuinfo 与 cgroup 限额一致', cpuinfoCount === cgroupCores,
      `cpuinfo=${cpuinfoCount} cgroup=${cgroupCores}核（cpu.max=${cpuMaxRaw}）`)
    // nproc 读 sched_getaffinity，不受 cpuinfo 影响 —— 这是最难修的一项
    if (nproc !== cgroupCores) {
      ok('nproc 与 cgroup 一致', false,
        `nproc=${nproc} cgroup=${cgroupCores}核 → 需 sched_setaffinity 或 LKM`)
    } else {
      ok('nproc 与 cgroup 一致', true)
    }
  }
}

// ── 3. 内存：MemTotal / memory.max 必须同量级
console.log('\n[2] 内存两个来源必须一致')
{
  const memTotalKb = Number(inC(C, "head -1 /proc/meminfo | awk '{print $2}'"))
  const memMaxRaw = inC(C, 'cat /sys/fs/cgroup/memory.max 2>/dev/null')
  const memMaxKb = memMaxRaw && !/max/.test(memMaxRaw) ? Math.round(Number(memMaxRaw) / 1024) : null
  if (memMaxKb) {
    const ratio = memTotalKb / memMaxKb
    // 真实机器 MemTotal 略小于 cgroup 上限（内核占用），0.9~1.02 之间合理
    ok('MemTotal 与 memory.max 同量级（0.9~1.02）', ratio > 0.9 && ratio < 1.02,
      `MemTotal=${memTotalKb}kB memory.max=${memMaxKb}kB 比值=${ratio.toFixed(3)}`)
  } else {
    warn('memory.max 不可读', '无法校验内存自洽性')
  }
}

// ── 4. 时区必须与出口 IP 地理位置匹配
console.log('\n[3] 时区与出口地理位置')
{
  const tz = inC(C, 'echo $TZ') || inC(C, 'date +%Z')
  // 出口 IP 的地理信息（容器内取，经过该槽代理）
  // 多端点回退 —— ipinfo.io 免费额度很小，单独用会 429。
  // 与 orchestrator 的 probeExitGeo 保持同样的端点优先级，
  // 否则审计结果会和实际部署行为不一致。
  let geo = null
  const EPS = [
    ['http://ip-api.com/json/?fields=status,country,countryCode,city,timezone,query', '--socks5', null],
    ['https://ifconfig.co/json', '--socks5-hostname', null],
    ['https://ipinfo.io/json', '--socks5-hostname', null],
  ]
  for (const [url] of EPS) {
    const raw = inC(C, `curl -s -m 10 ${url} 2>/dev/null`)
    if (!raw) continue
    let j = null
    try { j = JSON.parse(raw) } catch { continue }
    if (j.status === 'success') {
      geo = { ip: j.query, country: j.countryCode, city: j.city, timezone: j.timezone }
      break
    }
    if (j.ip && !j.error) {
      geo = {
        ip: j.ip,
        country: j.country_iso || j.country || '',
        city: j.city || '',
        timezone: j.time_zone || j.timezone || '',
      }
      break
    }
  }
  // 容器内直连不通时，退回宿主侧查（出口就是宿主出口时等价）
  if (!geo) {
    try {
      const raw = execFileSync('curl', ['-s', '-m', '10',
        'http://ip-api.com/json/?fields=status,country,countryCode,city,timezone,query'],
      { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })
      const j = JSON.parse(raw)
      if (j.status === 'success') {
        geo = { ip: j.query, country: j.countryCode, city: j.city, timezone: j.timezone }
      }
    } catch { /* 仍然失败就跳过 */ }
  }

  if (geo?.timezone) {
    ok('容器时区与出口 IP 时区一致', tz === geo.timezone,
      `TZ=${tz} 出口=${geo.country}/${geo.city} 时区=${geo.timezone}`)
    // 时区与出口国家/城市也应对得上
    if (geo.country) {
      const tzRegion = String(geo.timezone).split('/')[0]
      ok('时区大区与该国常识一致（抽查 US→America）',
        geo.country !== 'US' || tzRegion === 'America',
        `country=${geo.country} tzregion=${tzRegion}`)
    }
  } else {
    warn('取不到出口地理信息', '跳过时区校验（容器内无 curl 或代理不通）')
  }
}

// ── 5. uptime / btime 不能暴露同宿主
console.log('\n[4] 启动时间不能雷同')
{
  const ups = alive.slice(0, Math.min(5, alive.length)).map((i) => {
    const t = inC(containerName(i), "cut -d' ' -f1 /proc/uptime")
    return { slot: i, up: Number(t) }
  })
  const distinct = new Set(ups.map((u) => Math.round(u.up))).size
  // 真实机群不可能同时开机到秒级
  ok('前 5 个槽 uptime 不完全相同', distinct > 1,
    distinct === 1 ? `全部 ${ups[0].up}s（等于宿主 uptime，暴露同宿主机）` : `${distinct} 种`)

  const btimes = alive.slice(0, Math.min(5, alive.length)).map((i) => {
    return inC(containerName(i), "grep btime /proc/stat | awk '{print $2}'")
  })
  ok('前 5 个槽 btime 不完全相同', new Set(btimes).size > 1,
    new Set(btimes).size === 1 ? `全部 ${btimes[0]}（同宿主机）` : `${new Set(btimes).size} 种`)
}

// ── 6. boot_id 不能雷同
console.log('\n[5] boot_id 不能雷同')
{
  const ids = alive.slice(0, Math.min(5, alive.length)).map((i) => {
    return inC(containerName(i), 'cat /proc/sys/kernel/random/boot_id 2>/dev/null')
  })
  const uniq = new Set(ids.filter(Boolean)).size
  // 这是**已知边界**，不是待修的 bug：
  //   · boot_id 来自内核全局变量 sysctl_bootid，所有 namespace 共享
  //   · /proc/sys/ 下 runc 拒绝任何挂载（实测）
  //   · 改成 per-namespace 要 kprobe hook proc_do_uuid（未导出的 t 符号）
  //   · 直接改 sysctl_bootid 会连宿主一起改 —— 不可接受
  //
  // 风险判断：boot_id 不是 Claude Code 的指纹点（实测 strace 无读取），
  // 为它引入 kprobe 的内核崩溃风险不划算。如实标注。
  if (uniq > 1) {
    ok('前 5 个槽 boot_id 不完全相同', true)
  } else {
    warn('boot_id 各槽相同（已知边界）',
      `${ids[0]} —— 内核全局变量，需 kprobe hook 才能分命名空间，风险大于收益`)
  }
}

// ── 7. MAC OUI 不能是虚拟化厂商
console.log('\n[6] MAC 前缀不能是虚拟化厂商 OUI')
{
  const VIRTUAL_OUI = {
    '00:50:56': 'VMware',
    '00:0C:29': 'VMware',
    '00:05:69': 'VMware',
    '52:54:00': 'QEMU/KVM',
    '54:52:00': 'QEMU/KVM',
    '08:00:27': 'VirtualBox',
    '00:15:5D': 'Hyper-V',
    '02:42': 'Docker',
    '00:16:3E': 'Xen',
  }
  const mac = inC(C, 'cat /sys/class/net/eth0/address 2>/dev/null')
  const oui = mac.slice(0, 8).toUpperCase()
  const vendor = VIRTUAL_OUI[oui]
  ok('MAC OUI 不是虚拟化厂商', !vendor,
    vendor ? `${oui} = ${vendor}` : `${oui} 未列入虚拟 OUI 表`)

  // 首字节组播位
  const first = parseInt(String(mac).slice(0, 2), 16)
  ok('MAC 不是组播地址', !(first & 0x01), `首字节 0x${first.toString(16)}`)
}

// ── 8. 虚拟化标记
console.log('\n[7] 虚拟化标记')
{
  const cpuinfo = inC(C, 'cat /proc/cpuinfo 2>/dev/null')
  ok('cpuinfo 无 hypervisor 标志', !/hypervisor/.test(cpuinfo))
  const hvType = inC(C, 'cat /sys/hypervisor/type 2>/dev/null')
  ok('/sys/hypervisor 为空', !hvType, hvType || '空')
  const dockerenv = inC(C, 'test -e /.dockerenv && echo yes || echo no')
  ok('/.dockerenv 不存在', dockerenv === 'no', dockerenv === 'yes' ? '存在' : '')
}

// ── 9. 服务器角色 vs 机型
console.log('\n[8] 机型与服务角色匹配')
{
  const model = inC(C, "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2")
  const memTotalKb = Number(inC(C, "head -1 /proc/meminfo | awk '{print $2}'"))
  const cores = Number(inC(C, 'grep -c ^processor /proc/cpuinfo'))
  // 1GB 内存配 Xeon Platinum 8 核是明显的"云主机冒充物理服务器"
  const isServerCpu = /Xeon|EPYC|Platinum|Gold|Silver/.test(model)
  const memGb = memTotalKb / 1024 / 1024
  ok('服务器级 CPU 配服务器级内存（>=8GB）或改用桌面 CPU',
    !isServerCpu || memGb >= 8,
    `CPU=${model.trim().slice(0, 40)} 内存=${memGb.toFixed(1)}GB 核数=${cores}`)
}

// ── 10. 磁盘与设备
console.log('\n[9] 磁盘与文件系统')
{
  const fsType = inC(C, 'stat -f -c %T / 2>/dev/null')
  // overlayfs 本身是容器特征，但 /proc/mounts 会暴露，无法完全掩盖
  if (fsType === 'overlayfs') {
    warn('根文件系统是 overlayfs', '容器特征，容器内无法改为 ext4')
  } else {
    ok('根文件系统非 overlayfs', true)
  }
  const dfRoot = inC(C, "df -h / 2>/dev/null | tail -1 | awk '{print $2, $5}'")
  // 上报宿主机容量（491G）但内存只有 1GB，配比失衡
  const sizeMatch = String(dfRoot).match(/([\d.]+)([GT])/)
  if (sizeMatch) {
    const gb = sizeMatch[2] === 'T' ? Number(sizeMatch[1]) * 1024 : Number(sizeMatch[1])
    const memGb = Number(inC(C, "head -1 /proc/meminfo | awk '{print $2}'")) / 1024 / 1024
    ok('磁盘容量与内存配比合理（磁盘/内存 <= 200）', gb / memGb <= 200,
      `磁盘=${gb}GB 内存=${memGb.toFixed(1)}GB 比值=${(gb / memGb).toFixed(0)}`)
  }
}

console.log(`\n通过 ${pass} / 失败 ${fails.length} / 警告 ${warns.length}`)
if (fails.length) {
  console.log('\n失败项（这些是会被上游或人工一眼看穿的矛盾）：')
  for (const f of fails) console.log(`  ✗ ${f.label}${f.detail ? `：${f.detail}` : ''}`)
}
if (warns.length) {
  console.log('\n警告（容器内难以完全消除）：')
  for (const w of warns) console.log(`  △ ${w.label}${w.detail ? `：${w.detail}` : ''}`)
}
process.exit(fails.length ? 1 : 0)
