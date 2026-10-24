/**
 * 硬件伪装层的单元测试。
 *
 * 覆盖三样东西，都是「不测就会静默退化」的：
 *   1. procfs-fake  — 20 个槽的 CPU / 内存必须两两不同
 *   2. os-release-fake — 发行版必须两两不同，且与内核后缀自洽
 *   3. uts-fake     — release 必须两两不同，version 形态随发行版变化
 *
 * 为什么强调"静默"：这些字段全部相同也不会报错，只是所有槽看起来
 * 是同一台机器。只有主动断言才能发现。
 */
import {
  CPU_PROFILES, cpuProfileFor, renderCpuinfo, renderMeminfo, renderProcfsForSlot,
} from '../src/persona/procfs-fake.mjs'
import {
  OS_RELEASES, osReleaseForSlot, renderOsRelease, distroIdAt,
} from '../src/persona/os-release-fake.mjs'
import {
  RELEASE_POOL, DEBIAN_RELEASE_POOL, RHEL_RELEASE_POOL,
  utsForSlot, utsWritePayload,
} from '../src/persona/uts-fake.mjs'

let pass = 0
const fails = []
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass += 1; return }
  fails.push({ label, got, want })
  console.log(`  FAIL  ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`)
}

const SLOTS = Array.from({ length: 20 }, (_, i) => ({ vmId: `claude-slot-${String(i + 1).padStart(2, '0')}`, index: i }))

// ── 1. procfs：CPU 与内存必须逐槽不同
console.log('\n1. procfs 逐槽唯一')
{
  const models = new Set()
  const mhz = new Set()
  const mem = new Set()
  const combos = new Set()
  for (const s of SLOTS) {
    const r = renderProcfsForSlot({ vmId: s.vmId, index: s.index, cores: 2, memoryMb: 1024 })
    models.add(r.profile.name)
    mhz.add(r.profile.mhz)
    const memTotal = r.meminfo.split('\n')[0]
    mem.add(memTotal)
    combos.add(`${r.profile.name}|${r.profile.mhz}|${memTotal}`)
  }
  eq('20 槽 CPU 型号两两不同', models.size, 20)
  eq('20 槽 MemTotal 两两不同', mem.size, 20)
  eq('20 槽 型号+频率+内存 组合两两不同', combos.size, 20)
  // 频率不要求 20 个不同（抖动粒度有限），但必须明显分散
  eq('频率至少 15 档', mhz.size >= 15, true)
}

// ── 2. procfs 自洽性与内容正确性
console.log('\n2. procfs 内容正确性')
{
  const r = renderProcfsForSlot({ vmId: 'claude-slot-01', index: 0, cores: 4, memoryMb: 2048 })
  eq('cpuinfo 核数与请求一致', (r.cpuinfo.match(/^processor\t:/gm) || []).length, 4)
  eq('每个 processor 都有 model name', (r.cpuinfo.match(/^model name\t:/gm) || []).length, 4)
  // hypervisor 标志是虚拟化痕迹，必须去掉
  eq('不含 hypervisor 标志', /hypervisor/.test(r.cpuinfo), false)
  // 但真实能力位不能丢
  eq('保留 avx2', /\bavx2\b/.test(r.cpuinfo), true)
  eq('保留 sse4_2', /\bsse4_2\b/.test(r.cpuinfo), true)

  // MemTotal 必须小于 cgroup 上限（真实机器如此）
  const kb = Number(r.meminfo.match(/MemTotal:\s+(\d+)/)[1])
  eq('MemTotal 小于 2GB 上限', kb < 2048 * 1024, true)
  eq('MemTotal 大于 1.8GB（不能差太多）', kb > 1.8 * 1024 * 1024, true)
  eq('SwapTotal 为 0（容器默认无 swap）', /SwapTotal:\s+0 kB/.test(r.meminfo), true)
}

// ── 3. procfs 确定性
console.log('\n3. procfs 确定性')
{
  const a = renderProcfsForSlot({ vmId: 'same-id', index: 3, cores: 2, memoryMb: 1024 })
  const b = renderProcfsForSlot({ vmId: 'same-id', index: 3, cores: 2, memoryMb: 1024 })
  eq('同输入产生同 cpuinfo', a.cpuinfo, b.cpuinfo)
  eq('同输入产生同 meminfo', a.meminfo, b.meminfo)
  // 不同 index 必须不同（否则 20 个槽又撞了）
  const c = renderProcfsForSlot({ vmId: 'same-id', index: 4, cores: 2, memoryMb: 1024 })
  eq('不同 index 产生不同 cpuinfo', a.cpuinfo !== c.cpuinfo, true)
}

// ── 4. os-release 唯一性
console.log('\n4. os-release 逐槽唯一')
{
  const pretties = new Set()
  for (const s of SLOTS) pretties.add(osReleaseForSlot({ vmId: s.vmId, index: s.index }).pretty)
  eq('20 槽发行版标识两两不同', pretties.size, 20)
  eq('池子至少 20 项', OS_RELEASES.length >= 20, true)
}

// ── 5. os-release 内容合法性
console.log('\n5. os-release 内容合法性')
{
  for (const s of SLOTS) {
    const content = renderOsRelease({ vmId: s.vmId, index: s.index })
    // 必需字段
    for (const field of ['PRETTY_NAME', 'NAME', 'VERSION_ID', 'ID']) {
      eq(`${s.vmId} 含 ${field}`, new RegExp(`^${field}=`, 'm').test(content), true)
    }
    // ID 必须是合法的小写标识符。
    // 注意 RHEL 系（Rocky）写的是 ID="rocky"（带引号），而
    // Debian/Ubuntu 写 ID=ubuntu（不带）。两种都是合法的 os-release
    // 语法，所以要先剥引号再校验 —— 我第一版没剥，4 个槽误报。
    const rawId = content.match(/^ID=(.+)$/m)[1].replace(/^["']|["']$/g, '')
    eq(`${s.vmId} ID 合法`, /^[a-z][a-z0-9]*$/.test(rawId), true)
  }
}

// ── 6. uts 唯一性
console.log('\n6. UTS 逐槽唯一')
{
  const releases = new Set()
  const pairs = new Set()
  for (const s of SLOTS) {
    const distro = distroIdAt(s.index)
    const u = utsForSlot({ vmId: s.vmId, index: s.index, distro })
    releases.add(u.release)
    pairs.add(`${distro}|${u.release}`)
  }
  eq('20 槽 release 两两不同', releases.size, 20)
  eq('20 槽 发行版+release 两两不同', pairs.size, 20)
}

// ── 7. 内核后缀与发行版自洽（最关键）
console.log('\n7. 发行版与内核后缀自洽')
{
  const SUFFIX = { ubuntu: '-generic', debian: '-amd64', rocky: '.el9_' }
  let bad = 0
  for (const s of SLOTS) {
    const distro = distroIdAt(s.index)
    const u = utsForSlot({ vmId: s.vmId, index: s.index, distro })
    const want = SUFFIX[distro]
    if (want && !u.release.includes(want)) {
      bad += 1
      console.log(`          ${distro} 却得到 ${u.release}`)
    }
  }
  eq('20 槽全部后缀正确（-generic/-amd64/.el9_）', bad, 0)

  // version 字段形态也要跟随发行版
  const ubuntu = utsForSlot({ vmId: 'x', index: 0, distro: 'ubuntu' })
  const debian = utsForSlot({ vmId: 'x', index: 3, distro: 'debian' })
  const rocky = utsForSlot({ vmId: 'x', index: 5, distro: 'rocky' })
  eq('Ubuntu version 含 -Ubuntu SMP', /-Ubuntu SMP/.test(ubuntu.version), true)
  eq('Debian version 含 Debian', /Debian/.test(debian.version), true)
  eq('Rocky version 含 PREEMPT_DYNAMIC', /PREEMPT_DYNAMIC/.test(rocky.version), true)
}

// ── 8. uts 确定性
console.log('\n8. UTS 确定性')
{
  const a = utsForSlot({ vmId: 'stable', index: 2, distro: 'ubuntu' })
  const b = utsForSlot({ vmId: 'stable', index: 2, distro: 'ubuntu' })
  eq('同输入同 release', a.release, b.release)
  eq('同输入同 version', a.version, b.version)
}

// ── 9. utsWritePayload 格式
console.log('\n9. 写接口 payload 格式')
{
  const u = utsForSlot({ vmId: 'x', index: 0, distro: 'ubuntu' })
  const p = utsWritePayload({ pid: 12345, ...u })
  // 内核侧按前两个空格切分，第三段整段算 version（含空格）
  const parts = p.split(' ')
  eq('第一段是 pid', parts[0], '12345')
  eq('第二段是 release', parts[1], u.release)
  eq('第三段起是 version（含空格）', parts.slice(2).join(' '), u.version)
  // 非法 pid 必须抛错，不能静默写出坏数据
  let threw = null
  try { utsWritePayload({ pid: -1, ...u }) } catch (e) { threw = e }
  eq('非法 pid 抛错', threw !== null, true)
}

// ── 10. 池子规模足够覆盖槽位数
console.log('\n10. 池子容量')
{
  eq('Ubuntu release 池 >= 20', RELEASE_POOL.length >= 20, true)
  eq('Debian release 池 >= 8', DEBIAN_RELEASE_POOL.length >= 8, true)
  eq('RHEL release 池 >= 4', RHEL_RELEASE_POOL.length >= 4, true)
  // 池内不能有重复项 —— 有重复就等于池子变小
  eq('Ubuntu 池无重复', new Set(RELEASE_POOL).size, RELEASE_POOL.length)
  eq('Debian 池无重复', new Set(DEBIAN_RELEASE_POOL).size, DEBIAN_RELEASE_POOL.length)
  eq('RHEL 池无重复', new Set(RHEL_RELEASE_POOL).size, RHEL_RELEASE_POOL.length)
  eq('CPU 画像至少 20 种', CPU_PROFILES.length >= 20, true)
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails.slice(0, 20)) console.log(`  - ${f.label}`)
  process.exit(1)
}
console.log('\n结论：硬件伪装三层的唯一性与自洽性成立。')
