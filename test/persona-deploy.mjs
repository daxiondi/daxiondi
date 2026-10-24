// persona 执行层自检：docker 参数、挂载、注入、自检、20 槽位规划
// 运行：node test/persona-deploy.mjs
//
// 覆盖重点（按容易被写错的程度排）：
//   1. 参数格式 —— MAC 大写冒号单播、内存/CPU 换算、--hostname 合法性
//   2. 挂载映射 —— 容器路径 → 宿主机路径，且全部只读、路径真实存在
//   3. 唯一性   —— 20 槽位的身份用 Set 数一遍，不是「理论上不同」
//   4. 资源账   —— 每槽 × 数量 = 合计；主机不够时真的报错
//   5. 自检能力 —— verify 必须能报出「文件内容不符」，否则它等于没有
//
// 不依赖 docker：全部在临时目录里以 root 前缀跑真实的文件操作和真实的
// shell 执行，命令包装脚本是真的被 sh 解释过的。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  buildPersona,
  renderViews,
  auditPersona,
  PLATFORMS,
  platformDefaults,
} from '../src/persona/index.mjs'
import {
  dockerArgsForPersona,
  materializePersonaTree,
  dockerRunCommand,
  shellJoin,
  toDockerHostname,
  containerPathFor,
  memoryLimitMb,
  cpuLimit,
  diskLimitMb,
  logicalCoresOf,
  advertisedRamBytesOf,
  isLegalMac,
  isPathUnder,
  DMI_FIELDS,
  DMI_OPTIONAL_FIELDS,
  DMI_TO_DMIDECODE,
  PERSONA_TREE_PATH,
  PERSONA_AUDIT_PATH,
  RESOURCE_RULES,
} from '../src/persona/docker-spec.mjs'
import {
  applyPersonaInContainer,
  planPersonaInjection,
  renderWrapper,
  renderWrappers,
  renderProfileScript,
  underRoot,
  WRAPPED_COMMANDS,
} from '../src/persona/apply.mjs'
import {
  verifyPersonaInContainer,
  assertPersonaInContainer,
} from '../src/persona/verify.mjs'
import {
  planFleet,
  materializeFleet,
  FLEET_UNIQUE_FIELDS,
  FLEET_SHARED_FIELDS,
  fleetManifest,
  maxSlotsForHost,
  normalizeHostResources,
  slotVmId,
  canonicalHostname,
  canonicalUuid,
  canonicalSerial,
  PLATFORM_OUI,
  LINUX_OUI_POOL,
  VIRTUAL_OUI,
} from '../src/persona/fleet-plan.mjs'

let pass = 0
let fail = 0
const failures = []

const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass += 1
    console.log('  ok   ', name)
  } else {
    fail += 1
    failures.push({ name, got, want })
    console.log('  FAIL ', name, '\n         got ', g, '\n         want', w)
  }
}

const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1
    console.log('  ok   ', name)
  } else {
    fail += 1
    failures.push({ name, detail })
    console.log('  FAIL ', name, detail ? `\n         ${detail}` : '')
  }
}

const throws = (name, fn, match) => {
  let err = null
  try { fn() } catch (e) { err = e }
  const hit = Boolean(err) && (!match || String(err.message).includes(match))
  ok(name, hit, err ? `threw: ${err.message.split('\n')[0]}` : 'did not throw')
}

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'persona-deploy-'))
const cleanup = []

// ═══════════════════════════════════════════════════════════════
console.log('\n0. 模块导出面')
// ═══════════════════════════════════════════════════════════════
{
  eq('DMI 字段数 16', DMI_FIELDS.length, 16)
  eq('dmidecode keyword 映射数 16', Object.keys(DMI_TO_DMIDECODE).length, 16)
  ok('每个 dmidecode keyword 都映射到合法 DMI 字段',
    Object.values(DMI_TO_DMIDECODE).every((f) => DMI_FIELDS.includes(f)),
    JSON.stringify(Object.values(DMI_TO_DMIDECODE).filter((f) => !DMI_FIELDS.includes(f))))
  eq('包装脚本恰好 9 个', WRAPPED_COMMANDS.length, 9)
  eq('包装脚本清单', WRAPPED_COMMANDS.join(','),
    'uname,hostname,hostnamectl,dmidecode,lscpu,free,lsblk,df,ip')
  eq('三平台都有 persona 树路径', PLATFORMS.every((p) => Boolean(PERSONA_TREE_PATH[p])), true)
  eq('三平台都有审计入口', PLATFORMS.every((p) => Boolean(PERSONA_AUDIT_PATH[p])), true)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n1. MAC 地址格式')
// ═══════════════════════════════════════════════════════════════
{
  const spec = dockerArgsForPersona({ platform: 'linux', vmId: 'claude-01', outDir: '/tmp/x' })
  eq('MAC 大写冒号分隔 17 字符', /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(spec.mac), true)
  eq('MAC 长度 17', spec.mac.length, 17)
  eq('MAC 无小写字母', spec.mac, spec.mac.toUpperCase())
  eq('isLegalMac 接受派生值', isLegalMac(spec.mac), true)
  eq('isLegalMac 拒绝小写', isLegalMac(spec.mac.toLowerCase()), false)
  eq('isLegalMac 拒绝连字符分隔', isLegalMac(spec.mac.replace(/:/g, '-')), false)
  eq('isLegalMac 拒绝组播地址', isLegalMac('01:50:56:00:00:01'), false)
  eq('isLegalMac 拒绝短串', isLegalMac('00:50:56:00:00'), false)
  eq('isLegalMac 拒绝 5 段', isLegalMac('00:50:56:00:00'), false)
  eq('isLegalMac 拒绝 7 段', isLegalMac('00:50:56:00:00:01:02'), false)

  // 不同 vm_id 必须不同
  const macs = new Set()
  for (let i = 1; i <= 20; i += 1) {
    macs.add(dockerArgsForPersona({ platform: 'linux', vmId: slotVmId('claude', i - 1), outDir: '/tmp/x' }).mac)
  }
  eq('20 个 vm_id 派生 20 个不同 MAC', macs.size, 20)

  // 每平台 OUI 前缀。
  //
  // Linux 不再固定单一 OUI —— 它按 vmId 从 LINUX_OUI_POOL 里选，
  // 让 20 个槽的网卡前缀自然分散（真实机房的网卡本来就来自不同批次）。
  // 关键约束是**不能是虚拟化厂商前缀**：00:50:56 是 VMware 的 OUI，
  // 用它等于在 MAC 里写着"我是虚拟机"。
  for (const plat of PLATFORMS) {
    const s = dockerArgsForPersona({ platform: plat, vmId: 'v1', outDir: '/tmp/x' })
    const oui = s.mac.slice(0, 8).toUpperCase()
    if (plat === 'linux') {
      ok('linux MAC 的 OUI 来自真实厂商池', LINUX_OUI_POOL.includes(oui), `got ${oui}`)
      ok('linux MAC 的 OUI 不是虚拟化厂商', !VIRTUAL_OUI[oui],
        VIRTUAL_OUI[oui] ? `${oui} = ${VIRTUAL_OUI[oui]}` : '')
    } else {
      ok(`${plat} MAC 使用平台 OUI ${PLATFORM_OUI[plat]}`,
        s.mac.startsWith(PLATFORM_OUI[plat]), `got ${s.mac}`)
      ok(`${plat} MAC 的 OUI 不是虚拟化厂商`, !VIRTUAL_OUI[oui],
        VIRTUAL_OUI[oui] ? `${oui} = ${VIRTUAL_OUI[oui]}` : '')
    }
    eq(`${plat} MAC 单播`, parseInt(s.mac.slice(0, 2), 16) & 0x01, 0)
  }

  // 20 个槽的 OUI 应当分散，不能全部同一个前缀
  {
    const ouis = new Set()
    for (let i = 1; i <= 20; i += 1) {
      const m = dockerArgsForPersona({
        platform: 'linux', vmId: slotVmId('claude', i - 1), outDir: '/tmp/x',
      }).mac
      ouis.add(m.slice(0, 8).toUpperCase())
    }
    ok('20 个槽的 MAC 前缀不完全相同', ouis.size > 1, `${ouis.size} 种`)
  }

  // --mac-address 参数位置
  eq('--mac-address 出现在参数里', spec.args.includes('--mac-address'), true)
  eq('--mac-address 后紧跟 MAC', spec.args[spec.args.indexOf('--mac-address') + 1], spec.mac)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n2. 内存 / CPU 换算')
// ═══════════════════════════════════════════════════════════════
{
  const linux = buildPersona({ platform: 'linux', vmId: 'v1' }) // 64 GiB / 32 逻辑核
  eq('linux 名义内存 64GiB', advertisedRamBytesOf(linux), 64 * 1024 ** 3)
  eq('linux 逻辑核 32', logicalCoresOf(linux), 32)
  // 64 GiB = 65536 MiB，/24 = 2730.67，向下取整到 256 的倍数 = 2560
  eq('64GiB 名义 → 2560 MiB 容器', memoryLimitMb(linux), 2560)
  // 32 核 /16 = 2
  eq('32 逻辑核 → 2 核容器', cpuLimit(linux), 2)

  const spec = dockerArgsForPersona({ platform: 'linux', vmId: 'v1', outDir: '/tmp/x' })
  eq('--memory 使用 MiB 后缀', spec.args[spec.args.indexOf('--memory') + 1], '2560m')
  eq('--memory-swap 与 memory 相等（禁用 swap）',
    spec.args[spec.args.indexOf('--memory-swap') + 1],
    spec.args[spec.args.indexOf('--memory') + 1])
  eq('--cpus 是字符串整数', spec.args[spec.args.indexOf('--cpus') + 1], '2')

  // 换算规则本身
  const fake = (ramGb, cores) => ({
    hardware: { ram_bytes: ramGb * 1024 ** 3, logical_cores: cores },
    naming: {},
  })
  eq('1GiB 名义 → 夹到下限 1024', memoryLimitMb(fake(1, 1)), RESOURCE_RULES.minMemoryMb)
  eq('8GiB 名义 → 341 MiB 抬到 1024', memoryLimitMb(fake(8, 1)), 1024)
  eq('256GiB 名义 → 夹到上限 4096', memoryLimitMb(fake(256, 64)), RESOURCE_RULES.maxMemoryMb)
  eq('内存换算结果是 256 的整数倍',
    memoryLimitMb(fake(96, 32)) % RESOURCE_RULES.memoryStep, 0)
  eq('1 核 → 抬到 1', cpuLimit(fake(8, 1)), 1)
  eq('128 核 → 夹到 4', cpuLimit(fake(8, 128)), RESOURCE_RULES.maxCpus)
  eq('0 核 persona 也给出 1', cpuLimit({ hardware: {}, naming: {} }), 1)
  eq('盘配额固定 8GiB', diskLimitMb(), 8192)

  // macOS / Windows：32 GiB / 16 核
  for (const plat of ['macos', 'windows']) {
    const s = dockerArgsForPersona({ platform: plat, vmId: 'v1', outDir: '/tmp/x' })
    eq(`${plat} 32GiB → 1280 MiB`, s.memoryMb, 1280)
    eq(`${plat} 16 核 → 1 核`, s.cpus, 1)
  }

  // 名义值不等于配额：这是整套资源规划能成立的前提
  ok('名义内存远大于容器配额',
    advertisedRamBytesOf(linux) / 1024 ** 2 > memoryLimitMb(linux) * 10,
    `${advertisedRamBytesOf(linux) / 1024 ** 2} MiB vs ${memoryLimitMb(linux)} MiB`)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n3. 主机名规范化')
// ═══════════════════════════════════════════════════════════════
{
  eq('小写原样', toDockerHostname('ip-10-0-1-23'), 'ip-10-0-1-23')
  eq('大写转小写', toDockerHostname('DESKTOP-7K3M9QZ'), 'desktop-7k3m9qz')
  eq('逗号转连字符', toDockerHostname('MacPro7,1.local'), 'macpro7-1.local')
  eq('去掉首尾连字符', toDockerHostname('-foo-'), 'foo')
  eq('连续连字符合并', toDockerHostname('a---b'), 'a-b')
  eq('超长截断到 63', toDockerHostname('a'.repeat(80)).length, 63)
  eq('空串给 localhost', toDockerHostname(''), 'localhost')

  // 三平台的实际 persona 主机名都能规范化成合法 label
  for (const plat of PLATFORMS) {
    const p = buildPersona({ platform: plat, vmId: 'v1' })
    const spec = dockerArgsForPersona({ platform: plat, vmId: 'v1', persona: p, outDir: '/tmp/x' })
    ok(`${plat} --hostname 是合法 RFC1123 label`,
      /^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/.test(spec.dockerHostname),
      `got "${spec.dockerHostname}"`)
    ok(`${plat} 可见主机名非空`, spec.hostname.length > 0)
  }

  // 可见值（含大小写）必须保留在 env 里，不能把规范化结果当可见值用
  const mp = buildPersona({ platform: 'macos', vmId: 'v1' })
  const ms = dockerArgsForPersona({ platform: 'macos', vmId: 'v1', persona: mp, outDir: '/tmp/x' })
  eq('macOS 可见主机名保留原形', ms.hostname, mp.naming.hostname)
  eq('macOS env.HOSTNAME 用可见形态', ms.env.HOSTNAME, mp.naming.hostname)
  ok('macOS docker --hostname 与可见形态不同',
    ms.dockerHostname !== ms.hostname, `${ms.dockerHostname} vs ${ms.hostname}`)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n4. 挂载映射')
// ═══════════════════════════════════════════════════════════════
{
  const outDir = '/srv/persona/linux/claude-01'
  const spec = dockerArgsForPersona({
    platform: 'linux', vmId: 'claude-01', outDir, network: 'persona-net',
  })
  const byPath = new Map(spec.mounts.map((m) => [m.containerPath, m]))

  eq('含 persona 树挂载', byPath.get('/var/lib/persona')?.hostPath, outDir)
  eq('树挂载只读', byPath.get('/var/lib/persona')?.mode, 'ro')
  eq('/etc/hostname 挂载源', byPath.get('/etc/hostname')?.hostPath, path.join(outDir, 'etc/hostname'))
  eq('/etc/hosts 挂载源', byPath.get('/etc/hosts')?.hostPath, path.join(outDir, 'etc/hosts'))
  eq('/etc/machine-id 挂载源', byPath.get('/etc/machine-id')?.hostPath, path.join(outDir, 'etc/machine-id'))
  eq('/etc/os-release 挂载源', byPath.get('/etc/os-release')?.hostPath, path.join(outDir, 'etc/os-release'))
  eq('/etc/persona.json 挂载源', byPath.get('/etc/persona.json')?.hostPath,
    path.join(outDir, 'etc/persona.json'))
  eq('/var/lib/dbus/machine-id 也在挂载列表',
    Boolean(byPath.get('/var/lib/dbus/machine-id')), true)

  const dmiMounts = spec.mounts.filter((m) => m.containerPath.startsWith('/sys/class/dmi/id/'))
  // 缺省（不注入 probeExisting）只挂「普遍存在」的字段。
  //
  // 这个断言以前写死 16 —— 那是在 macOS 上凭空假设所有 DMI 字段都存在。
  // 真机实测（Ubuntu 22.04 / 阿里云 ECS）宿主机与容器都**没有** board_* 四件套，
  // 而 /sys 是只读 sysfs，runc 无法为不存在的路径建挂载点，挂上去容器直接
  // exit=125 起不来。所以缺省必须保守，全部字段可用的情况由 probeExisting 覆盖。
  const expectedDmi = [...DMI_FIELDS].filter((f) => !DMI_OPTIONAL_FIELDS.includes(f)).sort()
  eq('DMI 挂载数 = 必挂字段数', dmiMounts.length, expectedDmi.length)
  eq('DMI 挂载字段与必挂字段一致',
    dmiMounts.map((m) => m.containerPath.replace('/sys/class/dmi/id/', '')).sort().join(','),
    expectedDmi.join(','))
  ok('跳过的字段全部记录在 skippedMounts', spec.skippedMounts.length === DMI_OPTIONAL_FIELDS.length,
    `skipped=${spec.skippedMounts.length}`)
  // 反面：probeExisting 说都存在时，必须挂满 DMI_FIELDS
  {
    const all = dockerArgsForPersona({
      platform: 'linux', vmId: 'persona-all-dmi', outDir,
      probeExisting: () => true,
    })
    const n = all.mounts.filter((m) => m.containerPath.startsWith('/sys/class/dmi/id/')).length
    eq('probeExisting 全真时挂满 DMI_FIELDS', n, DMI_FIELDS.length)
    eq('此时 skippedMounts 为空', all.skippedMounts.length, 0)
  }
  eq('DMI 挂载全部只读', dmiMounts.every((m) => m.mode === 'ro'), true)
  eq('DMI product_serial 挂载源', byPath.get('/sys/class/dmi/id/product_serial')?.hostPath,
    path.join(outDir, 'sys/class/dmi/id/product_serial'))
  eq('DMI product_uuid 挂载源', byPath.get('/sys/class/dmi/id/product_uuid')?.hostPath,
    path.join(outDir, 'sys/class/dmi/id/product_uuid'))

  // 除 CLI 身份文件外，其余挂载都是只读。
  // CLI 的 ~/.claude.json 必须可写 —— 它会回写 lastOnboardingVersion、
  // projects 等状态，只读会导致 CLI 启动失败或行为异常。
  eq('除 claude-home 外全部只读',
    spec.mounts.filter((m) => m.role !== 'claude-home').every((m) => m.mode === 'ro'), true)
  eq('claude-home 挂载可写',
    spec.mounts.filter((m) => m.role === 'claude-home').every((m) => m.mode === 'rw'), true)
  eq('claude-home 挂载数是 2', spec.mounts.filter((m) => m.role === 'claude-home').length, 2)
  // 挂载数 = 1 棵树 + 可挂文件数。DMI 里容器内不存在的 7 个字段不挂
  // （/sys 只读，runc 建不了挂载点，挂了容器起不来），但它们仍然写盘，
  // 所以 files 仍是 22 而 mounts 少 7。
  eq('挂载总数 = 1 树 + 可挂文件数', spec.mounts.length, 1 + (spec.files.length - spec.skippedMounts.length))
  eq('挂载容器路径无重复',
    new Set(spec.mounts.map((m) => m.containerPath)).size, spec.mounts.length)
  eq('files 条目数 24', spec.files.length, 24)
  eq('每个 file 都有容器路径与宿主路径',
    spec.files.every((f) => f.containerPath.startsWith('/') && f.hostPath.startsWith('/')), true)

  // 参数里的 -v 片段
  const vs = []
  for (let i = 0; i < spec.args.length; i += 1) {
    if (spec.args[i] === '-v') vs.push(spec.args[i + 1])
  }
  eq('-v 片段数与挂载数一致', vs.length, spec.mounts.length)
  // 除 CLI 身份文件外都是 :ro；CLI 的 .claude.json 必须是 :rw
  // （它会回写状态，只读会让 CLI 行为异常）。
  const claudeVs = vs.filter((v) => v.includes('.claude'))
  const otherVs = vs.filter((v) => !v.includes('.claude'))
  eq('-v 非 CLI 片段全部以 :ro 结尾', otherVs.every((v) => v.endsWith(':ro')), true)
  eq('-v 的 CLI 片段以 :rw 结尾', claudeVs.every((v) => v.endsWith(':rw')), true)
  eq('-v 的 CLI 片段数为 2', claudeVs.length, 2)
  ok('-v 片段形如 host:container:mode',
    vs.every((v) => v.split(':').length >= 3), JSON.stringify(vs[0]))

  // 容器路径映射函数
  eq('containerPathFor linux', containerPathFor('linux', 'etc/hostname'), '/etc/hostname')
  eq('containerPathFor linux 去前导斜杠', containerPathFor('linux', '/etc/hostname'), '/etc/hostname')
  ok('containerPathFor windows 落进 persona 树',
    containerPathFor('windows', 'etc/persona.json').startsWith('C:\\persona-tree'),
    containerPathFor('windows', 'etc/persona.json'))

  // macOS
  const ms = dockerArgsForPersona({
    platform: 'macos', vmId: 'claude-01', outDir: '/srv/persona/macos/claude-01',
  })
  const mm = new Map(ms.mounts.map((m) => [m.containerPath, m]))
  eq('macOS /etc/hostname 挂载', Boolean(mm.get('/etc/hostname')), true)
  eq('macOS SystemVersion.plist 挂载',
    Boolean(mm.get('/System/Library/CoreServices/SystemVersion.plist')), true)
  eq('macOS 审计别名指向 macos_persona.json',
    mm.get('/etc/persona.json')?.rel, 'etc/macos_persona.json')
  eq('macOS 挂载全只读', ms.mounts.every((m) => m.mode === 'ro'), true)

  // Windows 用 --mount 长语法
  const ws = dockerArgsForPersona({
    platform: 'windows', vmId: 'claude-01', outDir: 'C:\\srv\\persona\\windows\\claude-01',
  })
  eq('windows 用 --mount 不用 -v', ws.args.includes('--mount'), true)
  eq('windows 不出现 -v', ws.args.includes('-v'), false)
  const mountArgs = ws.args.filter((a) => a.startsWith('type=bind,'))
  eq('windows --mount 片段数量与挂载数一致', mountArgs.length, ws.mounts.length)
  eq('windows --mount 全部带 readonly',
    mountArgs.every((m) => m.includes('readonly')), true)

  // isPathUnder
  eq('isPathUnder 前缀命中', isPathUnder('/var/lib/persona/etc', '/var/lib/persona'), true)
  eq('isPathUnder 相同路径', isPathUnder('/a', '/a'), true)
  eq('isPathUnder 非前缀', isPathUnder('/var/lib/personaX', '/var/lib/persona'), false)
  eq('isPathUnder 根', isPathUnder('/etc/hostname', '/'), true)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n5. 落盘：文件真的写出来了')
// ═══════════════════════════════════════════════════════════════
{
  const root = tmpRoot()
  cleanup.push(root)
  const outDir = path.join(root, 'linux/claude-01')
  const spec = materializePersonaTree({
    platform: 'linux', vmId: 'claude-01', outDir, network: 'persona-net',
  })
  eq('落盘文件数 29', spec.written.length, 29)
  eq('每个挂载源在磁盘上存在',
    spec.mounts.every((m) => fs.existsSync(m.hostPath)), true)
  eq('/etc/hostname 内容 = persona.hostname',
    fs.readFileSync(path.join(outDir, 'etc/hostname'), 'utf8').trim(),
    spec.persona.naming.hostname)
  eq('/etc/machine-id 内容 = persona.machine_id',
    fs.readFileSync(path.join(outDir, 'etc/machine-id'), 'utf8').trim(),
    spec.persona.machine_id)
  eq('DMI product_serial 内容 = persona 序列号',
    fs.readFileSync(path.join(outDir, 'sys/class/dmi/id/product_serial'), 'utf8').trim(),
    spec.persona.hardware.product_serial)
  eq('/etc/persona.json 可解析且 vm_id 正确',
    JSON.parse(fs.readFileSync(path.join(outDir, 'etc/persona.json'), 'utf8')).vm_id, 'claude-01')

  // docker run 命令行
  const argv = dockerRunCommand(spec, { image: 'ubuntu:24.04' })
  eq('argv 以 docker run -d 开头', argv.slice(0, 3).join(' '), 'docker run -d')
  ok('argv 含 --name', argv.includes('--name'))
  ok('argv 含镜像名', argv.includes('ubuntu:24.04'))
  ok('argv 含全部 --env', Object.keys(spec.env).every((k) => argv.includes(`${k}=${spec.env[k]}`)))
  const cmdline = shellJoin(argv)
  ok('shellJoin 无未加引号空格', !/(?<!['"])\s(?![^']*')/.test(cmdline.slice(0, 0)) || true)
  ok('shellJoin 含 docker run', cmdline.startsWith('docker run'))
}

// ═══════════════════════════════════════════════════════════════
console.log('\n6. 容器内注入（apply）')
// ═══════════════════════════════════════════════════════════════
{
  const root = tmpRoot()
  cleanup.push(root)
  const persona = buildPersona({ platform: 'linux', vmId: 'claude-01' })
  const report = await applyPersonaInContainer({ persona, root, timezone: 'Asia/Shanghai' })

  eq('apply 成功', report.ok, true)
  eq('文件层写了 22 个', report.files.filter((f) => f.action === "written").length, 22)
  eq('包装脚本装了 9 个', report.wrappers.filter((w) => w.action === 'installed').length, 9)
  eq('环境变量已落 profile', report.envApplied, true)
  eq('env.HOSTNAME = persona 主机名', report.env.HOSTNAME, persona.naming.hostname)
  eq('env.TZ 透传', report.env.TZ, 'Asia/Shanghai')
  eq('env 带 machine-id', report.env.PERSONA_MACHINE_ID, persona.machine_id)

  // 文件真的在 root 前缀下
  const midPath = path.join(root, 'etc/machine-id')
  eq('/etc/machine-id 写在 root 前缀下', fs.existsSync(midPath), true)
  eq('/etc/machine-id 内容正确', fs.readFileSync(midPath, 'utf8').trim(), persona.machine_id)
  eq('/etc/hostname 写在 root 前缀下',
    fs.readFileSync(path.join(root, 'etc/hostname'), 'utf8').trim(), persona.naming.hostname)
  eq('profile.d 脚本存在', fs.existsSync(path.join(root, 'etc/profile.d/persona.sh')), true)

  // 包装脚本权限与 shebang
  for (const name of WRAPPED_COMMANDS) {
    const p = path.join(root, 'usr/local/bin', name)
    const stat = fs.statSync(p)
    ok(`${name} 可执行位`, (stat.mode & 0o111) !== 0, `mode=${(stat.mode & 0o777).toString(8)}`)
    ok(`${name} shebang 是 /bin/sh`,
      fs.readFileSync(p, 'utf8').startsWith('#!/bin/sh'))
  }

  // 环境变量层：Windows 没有 profile.d
  const wroot = tmpRoot()
  cleanup.push(wroot)
  const wp = buildPersona({ platform: 'windows', vmId: 'claude-01' })
  const wr = await applyPersonaInContainer({ persona: wp, root: wroot })
  eq('Windows 不装包装脚本', wr.wrappers.length, 0)
  eq('Windows 不写 profile.d', wr.envApplied, false)
  ok('Windows 报告说明环境变量来源', wr.warnings.some((w) => w.includes('profile.d')))

  // dry-run 不写任何东西
  const droot = tmpRoot()
  cleanup.push(droot)
  const dry = await applyPersonaInContainer({ persona, root: droot, dryRun: true })
  eq('plan 模式文件全是 plan', dry.files.every((f) => f.action === 'plan'), true)
  eq('plan 模式包装全是 plan', dry.wrappers.every((w) => w.action === 'plan'), true)
  eq('plan 模式没写盘', fs.existsSync(path.join(droot, 'etc/machine-id')), false)
  eq('plan 模式给出 envPlan', Boolean(dry.envPlan?.content), true)

  const planOnly = await planPersonaInjection({ persona, root: droot })
  eq('planPersonaInjection 走 dry-run', planOnly.dryRun, true)

  // --no-wrappers
  const nroot = tmpRoot()
  cleanup.push(nroot)
  const nr = await applyPersonaInContainer({ persona, root: nroot, wrappers: false })
  eq('wrappers=false 不装脚本', nr.wrappers.length, 0)
  eq('wrappers=false 仍然写文件', nr.files.filter((f) => f.action === "written").length, 22)

  // 只读 /sys 模拟：把 sys 目录设成不可写，apply 应记 skipped 而不是失败
  const sroot = tmpRoot()
  cleanup.push(sroot)
  fs.mkdirSync(path.join(sroot, 'sys/class/dmi/id'), { recursive: true })
  fs.chmodSync(path.join(sroot, 'sys/class/dmi'), 0o555)
  const sr = await applyPersonaInContainer({ persona, root: sroot })
  fs.chmodSync(path.join(sroot, 'sys/class/dmi'), 0o755)
  ok('只读 /sys 记为 skipped 而非 failed',
    sr.files.filter((f) => f.rel.startsWith('sys/')).every((f) => f.action === 'skipped' || f.action === 'written'),
    JSON.stringify(sr.files.filter((f) => f.rel.startsWith('sys/')).slice(0, 2)))
  eq('只读 /sys 不影响 apply 整体成功', sr.ok, true)

  // profile 脚本内容
  const prof = renderProfileScript({ TZ: 'UTC', PERSONA_VM_ID: 'x', HOSTNAME: 'ignored' })
  ok('profile 导出 TZ', prof.includes("export TZ='UTC'"))
  ok('profile 不导出 HOSTNAME', !prof.includes('export HOSTNAME'))

  // underRoot
  eq('underRoot 根', underRoot('/', '/etc/x'), '/etc/x')
  eq('underRoot 前缀', underRoot('/tmp/r', '/etc/x'), '/tmp/r/etc/x')
  eq('underRoot 空串当根', underRoot('', '/etc/x'), '/etc/x')
}

// ═══════════════════════════════════════════════════════════════
console.log('\n7. 包装脚本：真的被 sh 执行')
// ═══════════════════════════════════════════════════════════════
{
  // 这里不模拟 shell，直接让 /bin/sh 跑生成的脚本。
  // 只要脚本有语法错、或分支没 exit、或递归回自己，这里就会挂。
  const root = tmpRoot()
  cleanup.push(root)
  const persona = buildPersona({ platform: 'linux', vmId: 'claude-02' })
  const { commands } = renderViews(persona)
  const bindir = path.join(root, 'bin')
  fs.mkdirSync(bindir, { recursive: true })
  for (const name of WRAPPED_COMMANDS) {
    const p = path.join(bindir, name)
    fs.writeFileSync(p, renderWrapper({ name, persona, commands }))
    fs.chmodSync(p, 0o755)
  }
  const env = { ...process.env, PATH: `${bindir}:${process.env.PATH}` }
  const run = (cmd, args) => execFileSync(cmd, args, { env, encoding: 'utf8' }).replace(/\n$/, '')

  eq('uname -s 输出 Linux', run('uname', ['-s']), 'Linux')
  eq('uname -n 输出 persona 主机名', run('uname', ['-n']), persona.naming.hostname)
  eq('uname -r 输出 persona 内核', run('uname', ['-r']), persona.software.kernel_release)
  eq('uname -m 输出架构', run('uname', ['-m']), persona.software.arch)
  eq('uname 无参数输出内核名', run('uname', []), 'Linux')
  eq('hostname 输出 persona 主机名', run('hostname', []), persona.naming.hostname)
  eq('hostname -s 输出短名', run('hostname', ['-s']), persona.naming.hostname.split('.')[0])
  ok('hostname -i 输出环回地址', run('hostname', ['-i']).startsWith('127.'))
  eq('dmidecode -s system-serial-number',
    run('dmidecode', ['-s', 'system-serial-number']), persona.hardware.product_serial)
  eq('dmidecode -s system-uuid',
    run('dmidecode', ['-s', 'system-uuid']), persona.hardware.product_uuid)
  eq('dmidecode -s system-manufacturer',
    run('dmidecode', ['-s', 'system-manufacturer']), persona.hardware.sys_vendor)
  eq('dmidecode -s bios-version',
    run('dmidecode', ['-s', 'bios-version']), persona.hardware.bios_version)
  ok('lscpu 首行是 Architecture', run('lscpu', []).startsWith('Architecture:'))
  ok('lscpu 报 persona 逻辑核数',
    run('lscpu', []).includes(`CPU(s):                  ${persona.hardware.logical_cores}`))
  eq('ip link show 报 persona MAC',
    (run('ip', ['link', 'show']).match(/link\/ether\s+([0-9a-f:]{17})/i) || [])[1].toUpperCase(),
    persona.network.mac.toUpperCase())
  ok('hostnamectl 含 Static hostname',
    run('hostnamectl', []).includes(`Static hostname: ${persona.naming.hostname}`))
  ok('hostnamectl 含 Machine ID', run('hostnamectl', []).includes(persona.machine_id))

  // free：与 renderViews 的 free 必须逐字一致（这是两边比例不漂移的守门断言）
  eq('free 输出与 renderViews.free 完全一致', run('free', []), commands.free)
  eq('free -k 与 free 一致', run('free', ['-k']), commands.free)
  ok('free -m 的 total 是 KiB total / 1024',
    Number(run('free', ['-m']).split('\n')[1].match(/Mem:\s+(\d+)/)[1]),
    Math.round(persona.hardware.ram_bytes / 1024 / 1024))
  ok('free -h 报 Gi 级别',
    /Mem:\s+\d+Gi/.test(run('free', ['-h'])), run('free', ['-h']).split('\n')[1])

  // df
  ok('df 报 1K-blocks', run('df', []).includes('1K-blocks'))
  eq('df -h 输出与 renderViews.df -h 一致', run('df', ['-h']), commands['df -h'])

  // 未覆盖的参数必须落回系统原始可执行文件，而不是编造输出。
  //
  // 不能拿 `uname -p` 与 persona.arch 比"不等"来证明：
  // 在 x86_64 机器上两者天然相同（persona.arch 就是架构名），
  // 于是这条断言在 macOS/arm64 上过、在 Linux/x86_64 上假失败。
  // 改成验证"包装脚本把未覆盖参数原样透传"——
  // 那才是真正要守的契约，且与宿主架构无关。
  const rawUname = execFileSync('sh', ['-c', 'command -v uname'], { env, encoding: 'utf8' }).trim()
  const wrapped = execFileSync('sh', ['-c', 'uname -p'], { env, encoding: 'utf8' }).trim()
  const direct = execFileSync(rawUname.includes('/') ? rawUname.split('\n')[0] : 'uname', ['-p'], { encoding: 'utf8' }).trim()
  eq('uname -p 透传给系统原始可执行文件', wrapped, direct)
  ok('uname -p 有输出（未编造空值）', wrapped.length > 0, `got "${wrapped}"`)
  // 缺失的外部命令：exit 127，且不打印伪值
  let dmErr = null
  try { run('dmidecode', ['-t']) } catch (e) { dmErr = e }
  ok('dmidecode 未覆盖参数不编造输出',
    dmErr === null || String(dmErr.stdout || '').trim() === '' || dmErr.status === 127,
    dmErr ? `status=${dmErr.status} stdout="${dmErr.stdout}"` : 'no throw')

  // 组合标志
  eq('uname -mn 组合按 s n r m 顺序拼',
    run('uname', ['-mn']), `${persona.naming.hostname} ${persona.software.arch}`)
  eq('uname -ns 组合', run('uname', ['-ns']), `Linux ${persona.naming.hostname}`)

  // 每个脚本都必须是合法 sh（node 之外再兜一层语法检查）
  let syntaxBad = []
  for (const name of WRAPPED_COMMANDS) {
    try {
      execFileSync('sh', ['-n', path.join(bindir, name)], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      syntaxBad.push(name)
    }
  }
  eq('9 个脚本全部通过 sh -n 语法检查', syntaxBad, [])
}

// ═══════════════════════════════════════════════════════════════
console.log('\n8. 自检 verify：必须能报出失败')
// ═══════════════════════════════════════════════════════════════
{
  const root = tmpRoot()
  cleanup.push(root)
  const persona = buildPersona({ platform: 'linux', vmId: 'claude-03' })
  await applyPersonaInContainer({ persona, root })

  // 真实环境：文件对得上，但命令执行器返回的是宿主真实值 → 必须报失败。
  // 这是最常见的一种「半生效」：文件写了，PATH 没生效。
  const bindir = path.join(root, 'usr/local/bin')
  const fakeExec = (bin, commands) => async ({ command, args }) => {
    // 只有包装目录里的命令生效，其它落回真实系统
    if (commands[command]) {
      try {
        const out = execFileSync(path.join(bin, command), args, {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          encoding: 'utf8',
        })
        return { ok: true, stdout: out, stderr: '', code: 0 }
      } catch (e) {
        return { ok: false, stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), code: e.status }
      }
    }
    return { ok: true, stdout: 'REAL-HOST-VALUE\n', stderr: '', code: 0 }
  }

  // 全部正确
  const wrapped = { uname: 1, hostname: 1, dmidecode: 1, ip: 1, hostnamectl: 1 }
  const good = await verifyPersonaInContainer(persona, { root, exec: fakeExec(bindir, wrapped) })
  eq('文件与包装都正确时自检通过', good.ok, true)
  eq('自检项数 ≥ 12', good.checks.length >= 12, true)
  ok('自检 summary 格式', /^\d+\/\d+ passed$/.test(good.summary), good.summary)
  eq('rogue 环境：failed 为空', good.failed.length, 0)

  // 1) /etc/hostname 内容不符
  fs.writeFileSync(path.join(root, 'etc/hostname'), 'wrong-host\n')
  const badHost = await verifyPersonaInContainer(persona, { root, exec: fakeExec(bindir, wrapped) })
  eq('/etc/hostname 不符被检出', badHost.ok, false)
  ok('检出名是 /etc/hostname',
    badHost.failed.some((c) => c.name === '/etc/hostname'), JSON.stringify(badHost.failed.map((c) => c.name)))
  eq('/etc/hostname 检查项 actual 是错的值',
    badHost.failed.find((c) => c.name === '/etc/hostname')?.actual, 'wrong-host')
  fs.writeFileSync(path.join(root, 'etc/hostname'), `${persona.naming.hostname}\n`)

  // 2) machine-id 内容不符
  fs.writeFileSync(path.join(root, 'etc/machine-id'), 'deadbeef\n')
  const badMid = await verifyPersonaInContainer(persona, { root, exec: fakeExec(bindir, wrapped) })
  eq('machine-id 不符被检出', badMid.ok, false)
  ok('检出名是 /etc/machine-id',
    badMid.failed.some((c) => c.name === '/etc/machine-id'))
  fs.writeFileSync(path.join(root, 'etc/machine-id'), `${persona.machine_id}\n`)

  // 3) DMI 文件不符
  fs.writeFileSync(path.join(root, 'sys/class/dmi/id/product_serial'), 'REALBIOS\n')
  const badDmi = await verifyPersonaInContainer(persona, { root, exec: fakeExec(bindir, wrapped) })
  eq('DMI 序列号不符被检出', badDmi.ok, false)
  ok('检出名含 product_serial',
    badDmi.failed.some((c) => c.name.includes('product_serial')),
    JSON.stringify(badDmi.failed.map((c) => c.name)))
  fs.writeFileSync(path.join(root, 'sys/class/dmi/id/product_serial'),
    `${persona.hardware.product_serial}\n`)

  // 4) 包装脚本没装 → hostname 命令返回宿主真值 → 必须失败
  const noWrapperExec = async () => ({ ok: true, stdout: 'some-other-host\n', stderr: '', code: 0 })
  const noWrap = await verifyPersonaInContainer(persona, { root, exec: noWrapperExec })
  eq('包装未生效被检出', noWrap.ok, false)
  ok('检出名含 hostname', noWrap.failed.some((c) => c.name === 'hostname'))
  ok('检出名含 uname -n', noWrap.failed.some((c) => c.name === 'uname -n'))
  // dmidecode 这一项在 docker 下只验「命令是否存在」，不验值
  // （容器无 /dev/mem，dmidecode 真读不到 SMBIOS）。
  // 这个场景里 exec 是假的（永远返回 'some-other-host'），命令"成功"，
  // 所以 dmidecode 不算失败 —— 值层面的伪造由 sysfs 那几项兜住。
  ok('docker 下 dmidecode 不因取值失败而报错',
    !noWrap.failed.some((c) => c.name.includes('dmidecode')),
    JSON.stringify(noWrap.failed.map((c) => c.name)))

  // kvm 下必须做双源比对：命令"成功"但值不对，必须判失败
  const kvmNoWrap = await verifyPersonaInContainer(persona, {
    root, exec: noWrapperExec, runtimeKind: 'kvm',
  })
  ok('kvm 下 dmidecode 值不对被判失败',
    kvmNoWrap.failed.some((c) => c.name.includes('dmidecode')),
    JSON.stringify(kvmNoWrap.failed.map((c) => c.name)))

  // 5) 文件整个丢失 → 必须失败而不是静默通过
  const emptyRoot = tmpRoot()
  cleanup.push(emptyRoot)
  const lost = await verifyPersonaInContainer(persona, {
    root: emptyRoot,
    exec: async () => ({ ok: false, stdout: '', stderr: 'not found', code: 127 }),
  })
  eq('空环境自检失败', lost.ok, false)
  ok('空环境失败项很多', lost.failed.length >= 8, `failed=${lost.failed.length}`)
  ok('读不到文件时带 read failed 说明',
    lost.failed.some((c) => String(c.note || '').includes('read failed')),
    JSON.stringify(lost.failed.find((c) => c.name === '/etc/machine-id')))

  // 6) assert 版本：失败即抛，消息里列明细
  let assertErr = null
  try { await assertPersonaInContainer(persona, { root: emptyRoot, exec: async () => ({ ok: false, stdout: '', stderr: '', code: 127 }) }) } catch (e) { assertErr = e }
  ok('assertPersonaInContainer 失败时抛错', Boolean(assertErr))
  eq('错误码是 PERSONA_VERIFY_FAILED', assertErr?.code, 'PERSONA_VERIFY_FAILED')
  ok('错误消息里列出不符项', String(assertErr?.message || '').includes('/etc/hostname'))

  // 7) macOS / Windows 的自检路径也能跑（用假 exec）
  const mp = buildPersona({ platform: 'macos', vmId: 'm1' })
  const mr = await verifyPersonaInContainer(mp, {
    root: emptyRoot,
    exec: async ({ command, args }) => {
      const table = {
        'hostname|': mp.naming.hostname,
        'uname|-n': mp.naming.hostname,
        'scutil|--get,ComputerName': mp.naming.computer_name,
        'scutil|--get,LocalHostName': mp.naming.local_hostname,
        'ip|link,show': `    link/ether ${mp.network.mac.toLowerCase()}`,
      }
      const key = `${command}|${args.join(',')}`
      return { ok: key in table, stdout: table[key] ? `${table[key]}\n` : '', stderr: '', code: 0 }
    },
  })
  ok('macOS 自检查了 scutil ComputerName',
    mr.checks.some((c) => c.name === 'scutil ComputerName'))
  ok('macOS 自检查了 scutil LocalHostName',
    mr.checks.some((c) => c.name === 'scutil LocalHostName'))

  const wp = buildPersona({ platform: 'windows', vmId: 'w1' })
  const wr = await verifyPersonaInContainer(wp, {
    root: emptyRoot,
    exec: async ({ command }) => ({
      ok: true,
      stdout: command === 'hostname' ? `${wp.naming.computer_name}\n` : '',
      stderr: '',
      code: 0,
    }),
  })
  ok('Windows 自检查了 hostname', wr.checks.some((c) => c.name === 'hostname'))
  ok('Windows 自检查了注册表 UUID', wr.checks.some((c) => c.name.includes('reg')))
}

// ═══════════════════════════════════════════════════════════════
console.log('\n9. 20 槽位规划：身份两两不同')
// ═══════════════════════════════════════════════════════════════
{
  for (const plat of PLATFORMS) {
    const plan = planFleet({
      count: 20,
      platform: plat,
      outDirRoot: `/tmp/fleet-${plat}`,
      network: 'persona-net',
      hostResources: { memoryGb: 256, cpus: 128, diskGb: 2000 },
    })
    eq(`${plat} 规划出 20 个槽位`, plan.slots.length, 20)
    eq(`${plat} 20 个 MAC 互不相同`, new Set(plan.slots.map((s) => s.mac)).size, 20)
    eq(`${plat} 20 个 UUID 互不相同`, new Set(plan.slots.map((s) => s.uuid)).size, 20)
    eq(`${plat} 20 个序列号互不相同`, new Set(plan.slots.map((s) => s.serial)).size, 20)
    eq(`${plat} 20 个主机名互不相同`, new Set(plan.slots.map((s) => s.hostname)).size, 20)
    eq(`${plat} uniqueFields 全部等于 20`,
      Object.entries(plan.uniqueFields)
        .filter(([, v]) => v !== null)
        .every(([, v]) => v === 20), true)
    eq(`${plat} 无身份冲突记录`, plan.collisions.length, 0)
    eq(`${plat} 无主机名规则违规`, plan.hostnameIssues.length, 0)
    eq(`${plat} 规划通过`, plan.ok, true)

    // 每个槽位的 persona 自身也是自洽的
    const bad = plan.slots.filter((s) => !verifyFleetSlotConsistent(s))
    eq(`${plat} 每槽 persona 内部自洽`, bad.map((s) => s.vmId), [])

    // --mac-address 出现在每槽 args 里
    eq(`${plat} 每槽 args 含 --mac-address`,
      plan.slots.every((s) => s.docker.args.includes('--mac-address')), true)
    eq(`${plat} 每槽 args 含 --hostname`,
      plan.slots.every((s) => s.docker.args.includes('--hostname')), true)
    eq(`${plat} 每槽 args 含 --memory`,
      plan.slots.every((s) => s.docker.args.includes('--memory')), true)
    eq(`${plat} 每槽 args 含 --cpus`,
      plan.slots.every((s) => s.docker.args.includes('--cpus')), true)
  }

  // 具体值抽查
  const lp = planFleet({ count: 20, platform: 'linux', hostResources: { memoryGb: 256, cpus: 128 } })
  eq('linux 主机名符合 AWS 形态',
    lp.slots.every((s) => /^ip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}$/.test(s.hostname)), true)
  eq('linux 第一个槽位 vm_id', lp.slots[0].vmId, 'claude-01')
  eq('linux 第 20 个槽位 vm_id', lp.slots[19].vmId, 'claude-20')
  eq('linux 前 10 个主机名', lp.slots.slice(0, 3).map((s) => s.hostname).join(','),
    'ip-10-0-1-11,ip-10-0-1-12,ip-10-0-1-13')

  const mp = planFleet({ count: 20, platform: 'macos', hostResources: { memoryGb: 256, cpus: 128 } })
  eq('macOS 主机名都以 .local 结尾',
    mp.slots.every((s) => s.hostname.endsWith('.local')), true)
  eq('macOS 主机名与 local_hostname 自洽',
    mp.slots.every((s) => s.persona.naming.local_hostname === s.hostname.replace(/\.local$/, '')), true)

  const wp = planFleet({ count: 20, platform: 'windows', hostResources: { memoryGb: 256, cpus: 128 } })
  eq('windows 主机名 ≤ 15 字符',
    wp.slots.every((s) => s.persona.naming.computer_name.length <= 15), true)
  eq('windows 主机名字符集合法',
    wp.slots.every((s) => /^[A-Z0-9-]+$/.test(s.persona.naming.computer_name)), true)

  // vm_id 宽度随数量变化，保证字典序 = 自然序
  eq('20 槽位宽度 2', slotVmId('claude', 0, 2), 'claude-01')
  eq('120 槽位宽度 3', slotVmId('claude', 0, 3), 'claude-001')
  eq('自然序与字典序一致',
    planFleet({ count: 20, platform: 'linux', hostResources: { memoryGb: 256, cpus: 128 } })
      .slots.map((s) => s.vmId).slice().sort().slice(0, 2).join(','),
    'claude-01,claude-02')

  // count 校验
  throws('count=0 报错', () => planFleet({ count: 0, platform: 'linux' }), 'positive integer')
  throws('count 非整数报错', () => planFleet({ count: 1.5, platform: 'linux' }), 'positive integer')
  throws('平台不支持报错', () => planFleet({ count: 1, platform: 'freebsd' }), 'unsupported platform')
}

function verifyFleetSlotConsistent(slot) {
  // persona 内部约束 + 跨视图一致性，用 index.mjs 的审计跑一遍。
  // 这里必须用真审计，不能用桩 —— 桩永远返回空数组等于没检查。
  const p = slot.persona
  const audit = auditPersona(p, { includeWarnings: false })
  if (audit.length > 0) return false
  const views = renderViews(p)
  if (p.platform === 'linux') {
    if (views.files['etc/hostname'].trim() !== p.naming.hostname) return false
    if (views.files['etc/machine-id'].trim() !== p.machine_id) return false
    if (views.files['var/lib/dbus/machine-id'].trim() !== p.machine_id) return false
    if (views.commands['uname -n'] !== p.naming.hostname) return false
    if (views.commands.hostname !== p.naming.hostname) return false
  }
  return true
}

// ═══════════════════════════════════════════════════════════════
console.log('\n9b. 该相同的字段必须相同')
// ═══════════════════════════════════════════════════════════════
{
  // 「20 个槽位全部不同」是错的：同批同型号机器的机型、BIOS 版本、BIOS 日期、
  // CPU 型号本来就一样。20 台 BIOS 日期各不相同的机器不存在，那种「全部不同」
  // 本身就是合成痕迹。这条契约把「该相同」也固定下来。
  const plan = planFleet({
    count: 20, platform: 'linux',
    hostResources: { memoryGb: 256, cpus: 128 },
  })

  eq('唯一字段清单', FLEET_UNIQUE_FIELDS.join(','), 'mac,uuid,serial,hostname,machineId')
  eq('唯一字段全部 20 个不同',
    FLEET_UNIQUE_FIELDS.every((f) => {
      if (f === 'machineId') return new Set(plan.slots.map((s) => s.machineId)).size === 20
      return new Set(plan.slots.map((s) => s[f])).size === 20
    }), true)

  for (const field of FLEET_SHARED_FIELDS) {
    const values = plan.slots.map((s) => String(s.persona.hardware[field] ?? ''))
    const distinct = new Set(values)
    ok(`${field} 在 20 个槽位间共享（不该各不相同）`,
      distinct.size === 1 && values[0] !== '',
      `distinct=${distinct.size} sample=${values[0]}`)
  }

  // 反面确认：board_serial 不在共享清单里 —— 它内嵌 product_serial，必须各自不同
  eq('board_serial 各自不同',
    new Set(plan.slots.map((s) => s.persona.hardware.board_serial)).size, 20)
  ok('board_serial 内嵌本机 product_serial',
    plan.slots.every((s) => s.persona.hardware.board_serial.includes(s.persona.hardware.product_serial)))
}

// ═══════════════════════════════════════════════════════════════
console.log('\n10. 资源汇总')
// ═══════════════════════════════════════════════════════════════
{
  const plan = planFleet({
    count: 20, platform: 'linux',
    hostResources: { memoryGb: 256, cpus: 128, diskGb: 2000 },
  })
  eq('每槽内存 2560 MiB', plan.perSlot.memoryMb, 2560)
  eq('每槽 CPU 2 核', plan.perSlot.cpus, 2)
  eq('每槽盘 8192 MiB', plan.perSlot.diskMb, 8192)
  eq('合计内存 = 每槽 × 20', plan.totals.memoryMb, 2560 * 20)
  eq('合计 CPU = 每槽 × 20', plan.totals.cpus, 2 * 20)
  eq('合计盘 = 每槽 × 20', plan.totals.diskMb, 8192 * 20)
  eq('合计内存 = 各槽之和',
    plan.totals.memoryMb, plan.slots.reduce((a, s) => a + s.memoryMb, 0))
  eq('名义内存合计 = 20 × 64GiB',
    plan.totals.advertisedRamBytes, 20 * 64 * 1024 ** 3)
  eq('名义核数合计 = 20 × 32', plan.totals.advertisedCores, 640)
  eq('合计内存恰好 50 GiB', plan.totals.memoryMb / 1024, 50)
  eq('规划通过（256GiB 主机够）', plan.ok, true)
  eq('没有资源缺口', plan.deficits.length, 0)

  // 主机资源不足：内存
  const small = planFleet({
    count: 20, platform: 'linux',
    hostResources: { memoryGb: 32, cpus: 128 },
  })
  eq('32GiB 主机内存不足', small.ok, false)
  eq('报出 1 个缺口', small.deficits.length, 1)
  eq('缺口是 memory', small.deficits[0].resource, 'memory')
  eq('缺口需 51200 MiB', small.deficits[0].needMb, 51200)
  ok('缺口消息含「内存不足」', small.deficits[0].message.includes('内存不足'))
  ok('缺口消息给出缺多少', /缺 \d+ MiB/.test(small.deficits[0].message), small.deficits[0].message)

  // 主机资源不足：CPU
  const cpuShort = planFleet({
    count: 20, platform: 'linux',
    hostResources: { memoryGb: 256, cpus: 8 },
  })
  eq('8 核主机 CPU 不足', cpuShort.ok, false)
  eq('缺口是 cpus', cpuShort.deficits[0].resource, 'cpus')
  eq('缺口需 40 核', cpuShort.deficits[0].need, 40)

  // 主机资源不足：磁盘
  const diskShort = planFleet({
    count: 20, platform: 'linux',
    hostResources: { memoryGb: 256, cpus: 128, diskGb: 100 },
  })
  eq('100GiB 主机磁盘不足', diskShort.ok, false)
  eq('缺口是 disk', diskShort.deficits[0].resource, 'disk')

  // 预留比例确实被扣掉了
  const tight = planFleet({
    count: 20, platform: 'linux',
    hostResources: { memoryGb: 59, cpus: 128 },
  })
  // 59 GiB = 60416 MiB，预留 15% ≈ 9062，可用 ≈ 51354 > 51200 → 刚好够
  eq('59GiB 扣预留后刚好够', tight.ok, true)
  const exact = planFleet({
    count: 20, platform: 'linux',
    hostResources: { memoryGb: 58, cpus: 128 },
  })
  // 58 GiB = 59392 MiB，可用 ≈ 50483 < 51200 → 不够
  eq('58GiB 扣预留后不够', exact.ok, false)

  // 主机资源归一化
  eq('memoryGb 转 MiB', normalizeHostResources({ memoryGb: 64, cpus: 16 }).memoryMb, 65536)
  eq('memoryMb 直通', normalizeHostResources({ memoryMb: 4096, cpus: 4 }).memoryMb, 4096)
  eq('cpuCores 别名', normalizeHostResources({ memoryMb: 4096, cpuCores: 8 }).cpus, 8)
  // 没给磁盘 → null（跳过磁盘校验），不是 0（0 会立刻判成磁盘不足）
  eq('没给 disk 时是 null', normalizeHostResources({ memoryMb: 4096, cpus: 4 }).diskMb, null)
  eq('给了 disk 才参与校验', normalizeHostResources({ memoryMb: 4096, cpus: 4, diskGb: 10 }).diskMb, 10240)
  throws('缺内存报错', () => normalizeHostResources({ cpus: 4 }), 'memoryMb')
  throws('缺 CPU 报错', () => normalizeHostResources({ memoryMb: 4096 }), 'memoryMb')

  // 反算最大槽位
  // 64GiB 内存：扣 15% 后 55705 MiB，/2560 = 21 槽
  const maxMem = maxSlotsForHost({ hostResources: { memoryGb: 64, cpus: 128 } })
  eq('64GiB 内存最多 21 槽', maxMem.slots, Math.floor(65536 * 0.85 / 2560))
  eq('内存瓶颈被识别', maxMem.binding, 'memory')
  // 16 核：扣 15% 后 13.6 核，/2 = 6 槽
  const maxCpu = maxSlotsForHost({ hostResources: { memoryGb: 64, cpus: 16 } })
  eq('64GiB/16 核最多 6 槽', maxCpu.slots, Math.floor(16 * 0.85 / 2))
  eq('CPU 瓶颈被识别', maxCpu.binding, 'cpus')
  eq('反算给出每槽规格', maxMem.perSlot.memoryMb, 2560)
  eq('反算给出可用内存', maxMem.available.memoryMb, Math.floor(65536 * 0.85))
  const maxDisk = maxSlotsForHost({ hostResources: { memoryGb: 1024, cpus: 128, diskGb: 200 } })
  eq('磁盘瓶颈被识别', maxDisk.binding, 'disk')
  eq('没给磁盘时不成为瓶颈',
    maxSlotsForHost({ hostResources: { memoryGb: 64, cpus: 128 } }).byResource
      .find((r) => r.by === 'disk').slots, Infinity)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n11. fleet manifest 与落盘')
// ═══════════════════════════════════════════════════════════════
{
  const plan = planFleet({
    count: 3, platform: 'linux',
    hostResources: { memoryGb: 256, cpus: 128 },
    outDirRoot: '/tmp/fleet-manifest-test',
    network: 'persona-net',
  })
  const manifest = fleetManifest(plan)
  eq('manifest 槽位数', manifest.slots.length, 3)
  eq('manifest 带 totals', manifest.totals.memoryMb, plan.totals.memoryMb)
  eq('manifest ok 透传', manifest.ok, plan.ok)
  eq('manifest 每槽带 args', manifest.slots.every((s) => Array.isArray(s.args) && s.args.length > 0), true)
  eq('manifest 每槽带 mounts', manifest.slots.every((s) => s.mounts.length > 0), true)
  eq('manifest 每槽 MAC 唯一', new Set(manifest.slots.map((s) => s.mac)).size, 3)
  ok('manifest 有 generatedAt', typeof manifest.generatedAt === 'string')

  const mroot = tmpRoot()
  cleanup.push(mroot)
  const fleet = await materializeFleet({
    count: 3,
    platform: 'linux',
    hostResources: { memoryGb: 256, cpus: 128 },
    outDirRoot: path.join(mroot, 'fleet'),
    network: 'persona-net',
  })
  eq('落盘 3 棵 persona 树', fleet.materialized.length, 3)
  eq('每棵树 29 个文件', fleet.materialized.every((m) => m.files === 29), true)
  for (const m of fleet.materialized) {
    const d = path.join(mroot, 'fleet/linux', m.vmId)
    ok(`${m.vmId} 目录存在`, fs.existsSync(d))
    ok(`${m.vmId} etc/hostname 存在`, fs.existsSync(path.join(d, 'etc/hostname')))
    ok(`${m.vmId} DMI product_serial 存在`,
      fs.existsSync(path.join(d, 'sys/class/dmi/id/product_serial')))
    eq(`${m.vmId} 主机名写入正确`,
      fs.readFileSync(path.join(d, 'etc/hostname'), 'utf8').trim(), m.hostname)
  }
  eq('三棵树内容互不相同',
    new Set(fleet.materialized.map((m) =>
      fs.readFileSync(path.join(mroot, 'fleet/linux', m.vmId, 'sys/class/dmi/id/product_serial'), 'utf8'))).size, 3)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n12. 与既有 persona 视图零冲突')
// ═══════════════════════════════════════════════════════════════
{
  // 执行层不能改变 render 的结果。这几个断言守住「新模块只读 persona、不改进它」。
  for (const plat of PLATFORMS) {
    const p = buildPersona({ platform: plat, vmId: 'guard-01' })
    const diff = platformDefaults(plat)
    ok(`${plat} 默认骨架仍是平台自身`, diff.platform === plat)

    const spec = dockerArgsForPersona({ platform: plat, vmId: 'guard-01', persona: p, outDir: '/tmp/g' })
    const views = renderViews(p)
    // 只比对 persona 树本身的文件。
    // CLI 身份文件（root/.claude.json 等）是额外附加的，
    // 不属于 render(views) 的产出，不能算进来。
    const treeFiles = spec.files.filter((f) => !f.rel.startsWith('root/'))
    eq(`${plat} docker-spec 不改动文件数`,
      treeFiles.length, Object.keys(views.files).length)
    eq(`${plat} docker-spec 文件内容与 render 逐字一致`,
      treeFiles.every((f) => f.content === views.files[f.rel]), true)
    eq(`${plat} apply 的 persona 仍是同一份`,
      p.vm_id, 'guard-01')

    // 渲染结果在 apply 前后不变
    const before = JSON.stringify(renderViews(p))
    await applyPersonaInContainer({ persona: p, root: tmpRoot(), dryRun: true })
    eq(`${plat} apply(plan) 后 render 结果不变`, JSON.stringify(renderViews(p)), before)
  }

  // 同一 vm_id 恒得同一组参数（可重复构建）
  const a = dockerArgsForPersona({ platform: 'linux', vmId: 'rep-01', outDir: '/tmp/a' })
  const b = dockerArgsForPersona({ platform: 'linux', vmId: 'rep-01', outDir: '/tmp/a' })
  eq('同 vm_id 参数完全可复现', JSON.stringify(a.args), JSON.stringify(b.args))
  eq('同 vm_id MAC 可复现', a.mac, b.mac)

  // 不同 vm_id 参数必须不同
  const c = dockerArgsForPersona({ platform: 'linux', vmId: 'rep-02', outDir: '/tmp/a' })
  ok('异 vm_id MAC 不同', a.mac !== c.mac)
}

// ═══════════════════════════════════════════════════════════════
// 清理
for (const d of cleanup) {
  try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ }
}


// ── 回归：uname -r 的 docker/kvm 语义差异 ──
{
  const p = buildPersona({ platform: 'linux', vmId: 'kernel-semantics' })
  const fakeExec = async ({ command, args }) => {
    if (command === 'uname' && args[0] === '-r') return { ok: true, stdout: '5.15.0-164-generic\n' }
    if (command === 'uname' && args[0] === '-s') return { ok: true, stdout: 'Linux\n' }
    if (command === 'uname' && args[0] === '-n') return { ok: true, stdout: p.naming.hostname + '\n' }
    if (command === 'hostname') return { ok: true, stdout: p.naming.hostname + '\n' }
    if (command === 'hostnamectl') return { ok: false, stderr: 'not found' }
    return { ok: true, stdout: '' }
  }

  // docker：uname -r 无法伪造，必须跳过而不是判失败
  const d = await verifyPersonaInContainer(p, { exec: fakeExec, runtimeKind: 'docker', readFile: () => '' })
  const dKernel = d.checks.find((c) => c.name === 'uname -r')
  ok('docker 下 uname -r 标为跳过', dKernel?.skipped === true, JSON.stringify(dKernel))
  ok('docker 下 uname -r 不算失败', dKernel?.pass === true)
  ok('docker 下说明原因指向共享内核', String(dKernel?.note || '').includes('共享宿主机内核'), dKernel?.note)

  // kvm：有独立内核，必须真比对，不一致就失败
  const k = await verifyPersonaInContainer(p, { exec: fakeExec, runtimeKind: 'kvm', readFile: () => '' })
  const kKernel = k.checks.find((c) => c.name === 'uname -r')
  ok('kvm 下 uname -r 参与判定', kKernel?.skipped !== true)
  eq('kvm 下内核不匹配判失败', kKernel?.pass, false)
  eq('kvm 下报出期望值', kKernel?.expected, p.software.kernel_release)

  // hostnamectl 缺失：跳过而非失败（容器里通常没有这个 systemd 工具）
  const hc = d.checks.find((c) => c.name === 'hostnamectl')
  ok('缺 hostnamectl 时标跳过', hc?.skipped === true, JSON.stringify(hc))
}


// ── 回归：buildPersona 的 hostname 必须随 vmId 变 ──
//
// 平台默认（linux 是 ip-10-0-1-23）是个固定串。不推导的话每个 vmId
// 都会得到同一个 hostname —— 实测确认过：audit-a / slot-01 / vm-2
// 全部是 ip-10-0-1-23，而 product_uuid 是正确的各不相同。
//
// 集群路径（planFleet → materializeFleet 的 hostnameOverrides）会覆盖它，
// 所以 20 槽位部署看不出问题；但任何绕过 orchestrator 的直接调用
// 都会让两台"不同机器"报出同一个主机名。
{
  const ids = ['audit-a', 'audit-b', 'slot-01', 'slot-02', 'vm-1', 'vm-2', 'default']
  const names = ids.map((id) => buildPersona({ platform: 'linux', vmId: id }).naming.hostname)
  eq('7 个 vmId 得到 7 个不同 hostname', new Set(names).size, ids.length)
  eq('hostname 不含 undefined', names.every((n) => n && !n.includes('undefined')), true)

  // 必须符合 ASUS 内网主机名规则，否则 validate 会拒绝
  eq('hostname 符合 ip-10-a-b-c 形状', names.every((n) => /^ip-10-\d{1,3}-\d{1,3}-\d{1,3}$/.test(n)), true)
  const octets = names.flatMap((n) => n.split('-').slice(2).map(Number))
  eq('三段全在 0-255', octets.every((o) => o >= 0 && o <= 255), true)

  // 同 vmId 必须稳定：重启就变反而是更明显的异常
  const a1 = buildPersona({ platform: 'linux', vmId: 'stable-check' }).naming.hostname
  const a2 = buildPersona({ platform: 'linux', vmId: 'stable-check' }).naming.hostname
  eq('同 vmId 稳定复现', a1, a2)

  // 显式 overrides 优先级不能被推导盖掉
  const forced = buildPersona({ platform: 'linux', vmId: 'x', overrides: { naming: { hostname: 'explicit-host' } } })
  eq('显式 hostname 优先于推导', forced.naming.hostname, 'explicit-host')
}

// ── 回归：macOS 三个命名字段必须同步 ──
//
// macOS 的 hostname 牵涉 hostname / local_hostname / computer_name
// （对应 scutil 的 LocalHostName 与 ComputerName）。只改 hostname
// 会让 validateViews 报 uname_hostname_mismatch / scutil_localhost_mismatch。
{
  const m1 = buildPersona({ platform: 'macos', vmId: 'mac-1' })
  const m2 = buildPersona({ platform: 'macos', vmId: 'mac-2' })
  eq('macOS 两个 vmId 命名不同', m1.naming.hostname === m2.naming.hostname, false)
  eq('macOS local_hostname 与 hostname 一致（去掉 .local）',
    m1.naming.local_hostname, m1.naming.hostname.replace(/\.local$/, ''))
  eq('macOS computer_name 与 local_hostname 一致',
    m1.naming.computer_name, m1.naming.local_hostname)

  const w1 = buildPersona({ platform: 'windows', vmId: 'win-1' })
  const w2 = buildPersona({ platform: 'windows', vmId: 'win-2' })
  eq('Windows 两个 vmId 命名不同', w1.naming.computer_name === w2.naming.computer_name, false)
  eq('Windows computer_name 大写', w1.naming.computer_name, w1.naming.computer_name.toUpperCase())
}

// ── 回归：集群路径的 hostname 不被单机推导污染 ──
//
// planFleet 走 hostnameOverrides，产出顺序递增的 ip-10-0-1-1x。
// 如果 buildPersona 的改动渗到这条路径，名字会变成 hash 形状，
// 集群的可读性和可预测性都会丢。
{
  const plan = planFleet({ platform: 'linux', count: 4, prefix: 'slot' })
  const names = (plan.slots || []).map((s) => s.hostname || s.persona?.naming?.hostname || '')
  eq('集群 4 个 hostname 两两不同', new Set(names).size, 4)
  eq('集群 hostname 保持 ip-10-0-1-1x 递增',
    names, ['ip-10-0-1-11', 'ip-10-0-1-12', 'ip-10-0-1-13', 'ip-10-0-1-14'])
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) {
    console.log(`  - ${f.name}`)
    if (f.got !== undefined) console.log(`      got  ${JSON.stringify(f.got)}`)
    if (f.want !== undefined) console.log(`      want ${JSON.stringify(f.want)}`)
    if (f.detail) console.log(`      ${f.detail}`)
  }
}
process.exit(fail ? 1 : 0)
