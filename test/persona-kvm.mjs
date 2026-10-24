// KVM 形态自检：QEMU 参数、SMBIOS 四张表、逗号转义、生命周期状态机、混合编排
// 运行：node test/persona-kvm.mjs
//
// 覆盖重点（按「写错了会在客户机里直接穿帮」的程度排）：
//   1. SMBIOS 四张表 0/1/2/3 —— 客户机 dmidecode 与 sysfs 都读它，错一个字段就露
//   2. 逗号转义 —— 值里有逗号不转义，QEMU 会把参数切碎并拒绝启动
//   3. UUID / MAC 格式 —— QEMU 严格校验，非法值直接起不来
//   4. 20 槽位的「该不同」与「该相同」—— 全不同是合成痕迹，全相同也是
//   5. 生命周期状态机 —— 非法迁移必须抛错，不能静默降级
//   6. 混合编排 —— 跨分组身份唯一性、全局主机名偏移
//
// 不依赖 QEMU / KVM：全部是纯函数断言 + 注入执行器的状态机演练。
// 但不做假成功 —— 每个「能报错」的断言都真的触发一次错误路径。

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { buildPersona, PLATFORMS } from '../src/persona/index.mjs'
import {
  qemuArgsForPersona,
  qemuCommandLine,
  readSmbiosFromArgv,
  splitSmbiosArgs,
  buildSmbiosArg,
  smbiosTablesForPersona,
  escapeSmbiosValue,
  unescapeSmbiosValue,
  isSmbiosSafeValue,
  isSmbiosUuid,
  isUnicastMac,
  isVirtualOui,
  machineSupportsFamily,
  detectDiskConflicts,
  kvmPathsFor,
  kvmMacFor,
  kvmDiskSerialFor,
  kvmInstanceIdFor,
  kvmMemoryMb,
  kvmVcpus,
  kvmDiskFootprintMb,
  kvmMemoryFootprintMb,
  SMBIOS_FIELDS,
  QEMU_DEFAULT_OUI,
  NIC_OUI_POOL,
  KVM_RESOURCE_RULES,
  QEMU_FIXED_CHASSIS_TYPE,
  SMBIOS_COMMA_FORBIDDEN_FIELDS,
  sanitizeSmbiosValue,
  normalizeBiosDate,
} from '../src/persona/kvm-spec.mjs'
import {
  KvmSlot,
  planKvmSlots,
  renderCloudInitUserData,
  renderCloudInitMetaData,
  buildKernelBootstrap,
  canTransition,
  assertTransition,
  qmpCommand,
  SLOT_STATES,
  STATE_TRANSITIONS,
} from '../src/persona/kvm-lifecycle.mjs'
import {
  verifyKvmPersona,
  detectDefaultSmbiosLeak,
  parseDmidecodeFields,
  parseSystemInformation,
  KVM_DMI_TO_DMIDECODE,
  KVM_VERIFY_FIELDS,
  KVM_VERIFY_KEYWORDS,
  QEMU_DEFAULT_SMBIOS,
} from '../src/persona/kvm-verify.mjs'
import {
  planFleet,
  planMixedFleet,
  fleetManifest,
  maxSlotsForHost,
  normalizeRuntime,
  resourceRulesFor,
  slotQemuCommand,
  RUNTIMES,
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

/** 异步版本的 throws：verify 是 async，同步 try/catch 抓不到 rejection。 */
const throwsAsync = async (name, fn, match) => {
  let err = null
  try { await fn() } catch (e) { err = e }
  const hit = Boolean(err) && (!match || String(err.message).includes(match))
  ok(name, hit, err ? `threw: ${err.message.split('\n')[0]}` : 'did not reject')
}

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kvm-'))
const cleanup = []

/** 取 persona，带缓存：同一 vmId 反复构造会重复跑一致性检查，慢且无意义。 */
const personaCache = new Map()
const P = (vmId = 'claude-01', platform = 'linux') => {
  const key = `${platform}/${vmId}`
  if (!personaCache.has(key)) personaCache.set(key, buildPersona({ platform, vmId }))
  return personaCache.get(key)
}

/** 生成一整个槽位的 QEMU spec。 */
const spec = (vmId = 'claude-01', extra = {}) =>
  qemuArgsForPersona({ persona: P(vmId), vmId, bridge: 'br0', ...extra })

// ═══════════════════════════════════════════════════════════════
console.log('\n0. 模块导出面与常量')
// ═══════════════════════════════════════════════════════════════
{
  eq('SMBIOS 支持的 type 是 0/1/2/3', Object.keys(SMBIOS_FIELDS).join(','), '0,1,2,3')
  eq('type=0 字段', SMBIOS_FIELDS[0].join(','), 'vendor,version,date,uefi')
  eq('type=1 字段', SMBIOS_FIELDS[1].join(','), 'manufacturer,product,version,serial,uuid,sku,family')
  eq('type=2 字段', SMBIOS_FIELDS[2].join(','), 'manufacturer,product,version,serial,asset,location')
  eq('type=3 字段不含 product/family',
    SMBIOS_FIELDS[3].includes('product') || SMBIOS_FIELDS[3].includes('family'), false)
  eq('type=3 字段', SMBIOS_FIELDS[3].join(','), 'manufacturer,version,serial,asset,sku')

  ok('QEMU 固定 chassis type 是 1', QEMU_FIXED_CHASSIS_TYPE === 1)
  ok('QEMU 默认 OUI 被列入黑名单', QEMU_DEFAULT_OUI.includes('52:54:00'))
  ok('OUI 池不含 52:54:00', NIC_OUI_POOL.every((o) => o !== '52:54:00'))
  ok('OUI 池全部不是虚拟前缀', NIC_OUI_POOL.every((o) => !isVirtualOui(o)),
    JSON.stringify(NIC_OUI_POOL.filter((o) => isVirtualOui(o))))

  eq('KVM 预留比例高于 Docker', KVM_RESOURCE_RULES.hostReserveRatio > 0.15, true)
  ok('KVM 每槽有 hypervisor 开销项', KVM_RESOURCE_RULES.hypervisorOverheadMb > 0)
  eq('RUNTIMES 只有两种', RUNTIMES.join(','), 'docker,kvm')
  eq('KVM 的 dmidecode 映射数', Object.keys(KVM_DMI_TO_DMIDECODE).length, 15)
  ok('所有 dmidecode keyword 都在 sysfs 字段清单里',
    Object.keys(KVM_DMI_TO_DMIDECODE).every((k) => KVM_VERIFY_FIELDS.includes(k)))
  ok('KVM_VERIFY_KEYWORDS 都是已映射的 keyword',
    KVM_VERIFY_KEYWORDS.every((k) => Object.values(KVM_DMI_TO_DMIDECODE).includes(k)))
  ok('自检字段集合与 dmidecode 映射表一致',
    KVM_VERIFY_FIELDS.length === Object.keys(KVM_DMI_TO_DMIDECODE).length,
    `${KVM_VERIFY_FIELDS.length} vs ${Object.keys(KVM_DMI_TO_DMIDECODE).length}`)
  eq('厂商系禁止逗号的字段', SMBIOS_COMMA_FORBIDDEN_FIELDS.join(','), 'manufacturer,vendor')
}

// ═══════════════════════════════════════════════════════════════
console.log('\n1. QEMU 参数完整性')
// ═══════════════════════════════════════════════════════════════
{
  const s = spec()
  const argv = s.argv
  eq('argv[0] 是 qemu-system-x86_64', argv[0], 'qemu-system-x86_64')
  ok('含 -enable-kvm 语义（-accel kvm）',
    argv[argv.indexOf('-accel') + 1] === 'kvm', argv[argv.indexOf('-accel') + 1])
  eq('-machine 是 q35', argv[argv.indexOf('-machine') + 1], 'q35')
  eq('-smp 取到 vcpu 数', argv[argv.indexOf('-smp') + 1], String(s.vcpus))
  eq('-m 取到内存', argv[argv.indexOf('-m') + 1], String(s.memoryMb))
  ok('-smp 与 -m 都是正整数',
    Number(argv[argv.indexOf('-smp') + 1]) > 0 && Number(argv[argv.indexOf('-m') + 1]) > 0)

  eq('四条 -smbios 参数', s.smbiosArgvCount ?? argv.filter((a) => a === '-smbios').length, 4)
  ok('type 顺序固定 0→1→2→3',
    argv.filter((a) => a.startsWith('type=')).map((a) => Number(/type=(\d)/.exec(a)[1])).join(''),
    '0123')

  ok('含 -drive 且指向 qcow2',
    argv[argv.indexOf('-drive') + 1].includes('format=qcow2'),
    argv[argv.indexOf('-drive') + 1])
  ok('-drive 的 cache 是 writeback',
    argv[argv.indexOf('-drive') + 1].includes('cache=writeback'))
  ok('-drive 开了 discard（否则 qcow2 只涨不缩）',
    argv[argv.indexOf('-drive') + 1].includes('discard=unmap'))
  ok('磁盘走 virtio-blk',
    argv.includes('-device') && argv.some((a) => a.startsWith('virtio-blk-pci,drive=disk0')))
  ok('磁盘序列号进了 device 参数',
    argv.find((a) => a.startsWith('virtio-blk-pci')).includes(`serial=${s.diskSerial}`))

  ok('网络用指定 bridge', argv[argv.indexOf('-netdev') + 1] === 'bridge,id=net0,br=br0',
    argv[argv.indexOf('-netdev') + 1])
  ok('网卡走 virtio-net-pci 并带 MAC',
    argv.find((a) => a.startsWith('virtio-net-pci')).includes(`mac=${s.mac}`))
  eq('MAC 大写且等于 spec.mac',
    argv.find((a) => a.startsWith('virtio-net-pci')).match(/mac=([0-9A-F:]+)/)[1], s.mac)

  ok('有 QMP socket', argv.includes('-chardev') && argv.some((a) => a.includes('qmp.sock')))
  ok('QMP 走 control 模式', argv[argv.indexOf('-mon') + 1] === 'chardev=qmp,mode=control')
  ok('串口日志落到文件', argv[argv.indexOf('-serial') + 1].startsWith('file:'))
  eq('-display none（无图形界面）', argv[argv.indexOf('-display') + 1], 'none')
  ok('-daemonize 存在（后台运行）', argv.includes('-daemonize'))
  ok('-pidfile 存在', argv.includes('-pidfile'))
  eq('pidfile 指向槽位目录', argv[argv.indexOf('-pidfile') + 1], s.paths.pidFile)

  // 不指定 bridge 时回落 user 网络，且必须告警
  const noBridge = qemuArgsForPersona({ persona: P('claude-01'), vmId: 'claude-01' })
  eq('无 bridge 时回落 user 网络', noBridge.argv[noBridge.argv.indexOf('-netdev') + 1], 'user,id=net0')
  ok('无 bridge 时给出告警', noBridge.warnings.some((w) => w.includes('bridge')))

  // tcg 分支
  const tcg = spec('claude-01', { accel: 'tcg' })
  ok('accel=tcg 时 -accel 带 thread=multi',
    tcg.argv[tcg.argv.indexOf('-accel') + 1] === 'tcg,thread=multi',
    tcg.argv[tcg.argv.indexOf('-accel') + 1])
  eq('tcg 时 cpu host 映射成 max', tcg.argv[tcg.argv.indexOf('-cpu') + 1], 'max')
  throws('非法 accel 被拒绝', () => spec('claude-01', { accel: 'xen' }), 'accel must be')

  // argv → 字符串
  const cmd = qemuCommandLine(s)
  ok('命令行串以 qemu-system-x86_64 开头', cmd.startsWith('qemu-system-x86_64 '))
  ok('命令行串含四条 type=', (cmd.match(/type=\d/g) || []).length >= 4)

  // 同 vmId 完全可复现
  const a = spec('rep-01')
  const b = spec('rep-01')
  eq('同 vmId 的 argv 完全一致', JSON.stringify(a.argv), JSON.stringify(b.argv))
  eq('同 vmId 的 SMBIOS 一致', JSON.stringify(a.smbios), JSON.stringify(b.smbios))
}

// ═══════════════════════════════════════════════════════════════
console.log('\n2. SMBIOS 四张表逐字段')
// ═══════════════════════════════════════════════════════════════
{
  const p = P('claude-01')
  const s = spec('claude-01')
  const t = s.smbios

  // type 0：BIOS
  ok('type=0 vendor 非空', String(t[0].vendor).length > 0)
  ok('type=0 version 非空', String(t[0].version).length > 0)
  ok('type=0 date 是 MM/DD/YYYY', /^\d{2}\/\d{2}\/\d{4}$/.test(t[0].date), t[0].date)
  eq('type=0 无 uuid 字段（QEMU type=0 不支持）', 'uuid' in t[0], false)

  // type 1：系统
  eq('type=1 manufacturer = persona sys_vendor', t[1].manufacturer, p.hardware.sys_vendor)
  eq('type=1 product = persona product_name', t[1].product, p.hardware.product_name)
  eq('type=1 serial = persona product_serial', t[1].serial, p.hardware.product_serial)
  eq('type=1 uuid = persona product_uuid', t[1].uuid, p.hardware.product_uuid)
  eq('type=1 family = persona product_family', t[1].family, p.hardware.product_family)
  ok('type=1 uuid 是合法 SMBIOS 形态', isSmbiosUuid(t[1].uuid), t[1].uuid)

  // type 2：主板
  ok('type=2 manufacturer 非空', String(t[2].manufacturer).length > 0)
  ok('type=2 product 非空', String(t[2].product).length > 0)
  ok('type=2 serial 非空', String(t[2].serial).length > 0)
  ok('type=2 asset 非空', String(t[2].asset).length > 0)
  eq('type=2 主板厂商与系统厂商同一生态',
    t[2].manufacturer === t[1].manufacturer || t[2].manufacturer === 'Dell Inc.', true)

  // type 3：机箱
  ok('type=3 manufacturer 非空', String(t[3].manufacturer).length > 0)
  ok('type=3 serial 非空', String(t[3].serial).length > 0)
  ok('type=3 asset 非空', String(t[3].asset).length > 0)
  eq('type=3 不含 product 字段', 'product' in t[3], false)
  eq('type=3 不含 family 字段', 'family' in t[3], false)
  eq('type=3 chassisType 记录为 QEMU 固定值', t[3].chassisType, QEMU_FIXED_CHASSIS_TYPE)

  // 每条 arg 都能被回读，且回读值等于原值
  const read = readSmbiosFromArgv(s.argv)
  eq('回读到 0/1/2/3 四张表', Object.keys(read).join(','), '0,1,2,3')
  eq('回读 type=1 serial 一致', read[1].serial, t[1].serial)
  eq('回读 type=1 uuid 一致', read[1].uuid, t[1].uuid)
  eq('回读 type=2 product 一致', read[2].product, t[2].product)
  eq('回读 type=3 version 一致', read[3].version, t[3].version)

  // BIOS 日期归一化：Windows persona 给 ISO，SMBIOS 只认 MM/DD/YYYY
  eq('MM/DD/YYYY 原样返回', normalizeBiosDate('09/12/2024'), '09/12/2024')
  eq('ISO 带时间被归一化', normalizeBiosDate('2023-11-14T00:00:00Z'), '11/14/2023')
  eq('ISO 无时间被归一化', normalizeBiosDate('2023-11-14'), '11/14/2023')
  eq('无法识别时返回空串', normalizeBiosDate('n/a'), '')
  eq('空值返回空串', normalizeBiosDate(''), '')
  throws('无可用日期时报错',
    () => smbiosTablesForPersona(
      { ...P('claude-01'), hardware: { ...P('claude-01').hardware, bios_date: 'n/a', bios_release_date: 'n/a' } },
      { machine: 'q35' },
    ), 'bios date')

  // 三条平台都能生成（字段名不同，读的是同一套）
  for (const plat of PLATFORMS) {
    const ps = qemuArgsForPersona({ persona: P(`${plat}-probe`, plat), vmId: `${plat}-probe`, bridge: 'br0' })
    eq(`${plat} platform 能生成四张表`, Object.keys(ps.smbios).length, 4)
    ok(`${plat} 的 type=1 serial 非空`, String(ps.smbios[1].serial).length > 0)
    ok(`${plat} 的 type=1 uuid 合法`, isSmbiosUuid(ps.smbios[1].uuid), ps.smbios[1].uuid)
  }
}

// ═══════════════════════════════════════════════════════════════
console.log('\n3. 逗号转义（最容易让 QEMU 直接拒绝启动的一项）')
// ═══════════════════════════════════════════════════════════════
{
  eq('逗号双写', escapeSmbiosValue('ThinkPad X1, Gen 11'), 'ThinkPad X1,, Gen 11')
  eq('无反斜杠', escapeSmbiosValue('a,b,c'), 'a,,b,,c')
  eq('无逗号时原样', escapeSmbiosValue('OptiPlex 7090'), 'OptiPlex 7090')
  eq('回读还原', unescapeSmbiosValue('a,,b'), 'a,b')

  // 切分：双写逗号不能当分隔符
  eq('切分跳过双写逗号',
    splitSmbiosArgs('type=1,product=ThinkPad X1,, Gen 11,serial=ABC').join('|'),
    'type=1|product=ThinkPad X1, Gen 11|serial=ABC')

  // 逗号策略按字段分层（这是本模块最容易搞错的一处）：
  //   厂商系字段 manufacturer / vendor → 永远拒绝，不接受转义。
  //     真实机器的 DMI 厂商名从不带逗号，出现即数据错误；转义后送去客户机的
  //     会是一个现实中不存在的厂商名，交叉验证立刻穿帮且日志里看不出来。
  //   型号名等自由字段 → 双写转义。
  //     Apple 的 `MacPro7,1` 逗号是真实内容，转义后客户机读到的仍是原值。
  throws('厂商字段含逗号被拒绝（不转义）',
    () => buildSmbiosArg(1, { manufacturer: 'HP Inc., Palo Alto' }),
    'contains a comma')
  throws('type=0 vendor 含逗号同样被拒绝',
    () => buildSmbiosArg(0, { vendor: 'Dell Inc., Round Rock' }),
    'contains a comma')
  throws('type=2 主板厂商含逗号被拒绝',
    () => buildSmbiosArg(2, { manufacturer: 'ASUS, Taipei' }),
    'contains a comma')
  throws('显式 escape 也不能让厂商字段带逗号',
    () => buildSmbiosArg(1, { manufacturer: 'A, B' }, { commaPolicy: 'escape' }),
    'contains a comma')
  throws('显式 reject 让型号字段也拒绝',
    () => buildSmbiosArg(1, { product: 'A, B' }, { commaPolicy: 'reject' }),
    'contains a comma')

  const built = buildSmbiosArg(1, { product: 'Laptop 13, AMD', serial: 'S1' })
  eq('型号字段默认双写转义', built.value, 'type=1,product=Laptop 13,, AMD,serial=S1')
  ok('转义时给出说明', built.notes.some((n) => n.includes('逗号')), JSON.stringify(built.notes))
  eq('转义可无损回读', unescapeSmbiosValue(built.value.split('product=')[1].split(',serial')[0]),
    'Laptop 13, AMD')
  throws('非法 commaPolicy 被拒绝',
    () => buildSmbiosArg(1, { product: 'X' }, { commaPolicy: 'auto' }), 'commaPolicy must be')

  // 引号与反斜杠即便在 escape 模式下也是硬错误：
  // QemuOpts 对它们不做任何处理，双写转义只对逗号有意义。
  throws('escape 模式下引号仍被拒绝',
    () => buildSmbiosArg(1, { product: 'A"B' }, { commaPolicy: 'escape' }), 'double quote')
  throws('escape 模式下反斜杠仍被拒绝',
    () => buildSmbiosArg(1, { product: 'A\\B' }, { commaPolicy: 'escape' }), 'backslash')

  // 非法字段名被拒绝（发出去 QEMU 会整条拒收）
  throws('type=3 发 product 被拒绝',
    () => buildSmbiosArg(3, { product: 'X' }), 'has no field "product"')
  throws('type=1 发 asset 被拒绝（那是 type=2 的字段）',
    () => buildSmbiosArg(1, { asset: 'X' }), 'has no field "asset"')
  throws('未知 type 被拒绝', () => buildSmbiosArg(7, {}), 'unsupported smbios type')

  // 非 ASCII 被拒绝
  throws('含中文的值被拒绝',
    () => buildSmbiosArg(1, { product: '联想 ThinkPad' }), 'non-ASCII character')
  throws('非 ASCII 在 escape 模式下也被拒绝',
    () => buildSmbiosArg(1, { product: '联想' }, { commaPolicy: 'escape' }), 'non-ASCII character')
  ok('可打印 ASCII 通过', isSmbiosSafeValue('OptiPlex 7090'))
  eq('超过 64 字符被拒绝', isSmbiosSafeValue('x'.repeat(65)), false)
  eq('恰好 64 字符通过', isSmbiosSafeValue('x'.repeat(64)), true)
  eq('控制字符被拒绝', isSmbiosSafeValue('a\tb'), false)

  // 端到端：persona 里带逗号的型号，整条链路仍然能生成并回读
  const commaPersona = buildPersona({
    platform: 'linux',
    vmId: 'comma-01',
    overrides: { hardware: { product_name: 'PowerEdge R750, Gen 2' } },
  })
  const cs = qemuArgsForPersona({ persona: commaPersona, vmId: 'comma-01', bridge: 'br0' })
  ok('带逗号的型号在 argv 里被双写',
    cs.argv.some((a) => a.includes('PowerEdge R750,, Gen 2')),
    JSON.stringify(cs.argv.filter((a) => a.includes('PowerEdge'))))
  const read = readSmbiosFromArgv(cs.argv)
  eq('回读还原出原始逗号', read[1].product, 'PowerEdge R750, Gen 2')

  // reject 策略下同一个人直接失败，而不是静默切碎
  throws('commaPolicy=reject 时同一 persona 报错',
    () => qemuArgsForPersona({ persona: commaPersona, vmId: 'comma-01', commaPolicy: 'reject' }),
    'contains a comma')
}

// ═══════════════════════════════════════════════════════════════
console.log('\n4. UUID / MAC 格式校验')
// ═══════════════════════════════════════════════════════════════
{
  ok('标准 UUID 通过', isSmbiosUuid('daa321b0-8988-4d22-8a76-95ac58ce23c3'))
  eq('大写 UUID 被拒（QEMU 要求小写）', isSmbiosUuid('DAA321B0-8988-4D22-8A76-95AC58CE23C3'), false)
  eq('缺段 UUID 被拒', isSmbiosUuid('daa321b0-8988-4d22'), false)
  eq('空 UUID 被拒', isSmbiosUuid(''), false)
  eq('非十六进制被拒', isSmbiosUuid('gggggggg-8988-4d22-8a76-95ac58ce23c3'), false)

  ok('合法单播 MAC 通过', isUnicastMac('00:50:56:F1:7A:89'))
  eq('组播 MAC 被拒（首字节最低位为 1）', isUnicastMac('01:50:56:F1:7A:89'), false)
  eq('全零 MAC 被拒', isUnicastMac('00:00:00:00:00:00'), false)
  eq('缺段 MAC 被拒', isUnicastMac('00:50:56:F1:7A'), false)
  eq('小写 MAC 通过（校验大小写不敏感）', isUnicastMac('00:50:56:f1:7a:89'), true)

  // OUI 判定
  eq('52:54:00 被判定为虚拟', isVirtualOui('52:54:00'), true)
  eq('本地管理位 OUI 被判定为虚拟', isVirtualOui('02:11:22'), true)
  eq('真实厂商 OUI 不算虚拟', isVirtualOui('F0:18:98'), false)
  eq('格式错误的 OUI 判定为虚拟', isVirtualOui('nope'), true)

  // 生成的 MAC 一定合法且不能用 QEMU 默认段
  const m1 = kvmMacFor('claude-01')
  ok('派生 MAC 是合法单播', isUnicastMac(m1), m1)
  ok('派生 MAC 不用 52:54:00', !m1.startsWith('52:54:00'), m1)
  ok('派生 MAC 的 OUI 不属于虚拟前缀', !isVirtualOui(m1.slice(0, 8)), m1.slice(0, 8))
  eq('同 vmId 的 MAC 可复现', kvmMacFor('claude-01'), m1)
  ok('异 vmId 的 MAC 不同', kvmMacFor('claude-02') !== m1)
  eq('20 个槽位 MAC 两两不同',
    new Set(Array.from({ length: 20 }, (_, i) => kvmMacFor(`claude-${String(i + 1).padStart(2, '0')}`))).size, 20)
  eq('同批槽位共享同一 OUI（同批采购同一款网卡）',
    new Set(Array.from({ length: 20 }, (_, i) => kvmMacFor(`claude-${String(i + 1).padStart(2, '0')}`).slice(0, 8))).size, 1)

  // 显式传虚拟 OUI 必须被拒
  throws('显式传 52:54:00 被拒绝', () => kvmMacFor('x-01', '52:54:00'), 'virtual/administrative')
  throws('spec 里传虚拟 MAC 被拒绝',
    () => spec('claude-01', { macAddress: '52:54:00:11:22:33' }), 'virtual OUI')
  throws('spec 里传组播 MAC 被拒绝',
    () => spec('claude-01', { macAddress: '01:50:56:11:22:33' }), 'legal unicast')
}

// ═══════════════════════════════════════════════════════════════
console.log('\n5. 机器类型与 family 约束')
// ═══════════════════════════════════════════════════════════════
{
  eq('q35 支持 family', machineSupportsFamily('q35'), true)
  eq('q35,smm=on 支持 family', machineSupportsFamily('q35,smm=on'), true)
  eq('pc-q35-8.0 支持 family', machineSupportsFamily('pc-q35-8.0'), true)
  eq('virt 支持 family', machineSupportsFamily('virt'), true)
  eq('i440fx 不支持 family', machineSupportsFamily('pc-i440fx-8.0'), false)
  eq('空值不支持 family', machineSupportsFamily(''), false)

  // i440fx 上 family 被降级并告警，而不是静默丢弃
  const ib = spec('claude-01', { machine: 'pc-i440fx-8.0' })
  ok('i440fx 下 family 被移除', !('family' in ib.smbios[1]), JSON.stringify(ib.smbios[1]))
  ok('i440fx 下给出 family 告警',
    ib.warnings.some((w) => w.includes('family')), JSON.stringify(ib.warnings))
  ok('i440fx 下仍生成 type=1', Boolean(ib.smbios[1].serial))

  // q35 下 family 保留
  const qb = spec('claude-01')
  ok('q35 下 family 保留', Boolean(qb.smbios[1].family), JSON.stringify(qb.smbios[1].family))
}

// ═══════════════════════════════════════════════════════════════
console.log('\n6. 20 槽位：该不同的不同，该相同的相同')
// ═══════════════════════════════════════════════════════════════
{
  const plan = planFleet({ count: 20, runtime: 'kvm', platform: 'linux', bridge: 'br0', kvmRootDir: '/tmp/kvm-20' })
  eq('规划出 20 个槽位', plan.slots.length, 20)
  eq('runtime 记录为 kvm', plan.runtime, 'kvm')
  eq('20 个槽位全部 runtime=kvm', plan.slots.every((s) => s.runtime === 'kvm'), true)

  const uniqOf = (get) => new Set(plan.slots.map((s) => String(get(s)).toUpperCase())).size
  eq('MAC 两两不同', uniqOf((s) => s.mac), 20)
  eq('UUID 两两不同', uniqOf((s) => s.uuid), 20)
  eq('系统序列号两两不同', uniqOf((s) => s.serial), 20)
  eq('主机名两两不同', uniqOf((s) => s.hostname), 20)
  eq('磁盘序列号两两不同', uniqOf((s) => s.diskSerial), 20)
  eq('cloud-init instance-id 两两不同', uniqOf((s) => s.instanceId), 20)
  eq('磁盘路径两两不同', uniqOf((s) => s.kvm.paths.diskPath), 20)
  eq('QEMU pidfile 两两不同', uniqOf((s) => s.kvm.paths.pidFile), 20)
  eq('QMP socket 两两不同', uniqOf((s) => s.kvm.paths.qmpSocket), 20)

  // ── 该相同的必须相同：这是防合成痕迹的核心断言
  const sharedOf = (get) => new Set(plan.slots.map(get)).size
  eq('BIOS 版本 20 台共享一种', sharedOf((s) => s.kvm.smbios[0].version), 1)
  eq('BIOS 日期 20 台共享一种', sharedOf((s) => s.kvm.smbios[0].date), 1)
  eq('BIOS 厂商 20 台共享一种', sharedOf((s) => s.kvm.smbios[0].vendor), 1)
  eq('系统厂商 20 台共享一种', sharedOf((s) => s.kvm.smbios[1].manufacturer), 1)
  eq('机型 20 台共享一种', sharedOf((s) => s.kvm.smbios[1].product), 1)
  eq('主板型号 20 台共享一种', sharedOf((s) => s.kvm.smbios[2].product), 1)
  eq('主板版本 20 台共享一种', sharedOf((s) => s.kvm.smbios[2].version), 1)
  eq('网卡 OUI 20 台共享一种', sharedOf((s) => s.mac.slice(0, 8)), 1)
  eq('机器类型 20 台都是 q35', sharedOf((s) => s.kvm.machine), 1)
  eq('内存规格共享一种', sharedOf((s) => s.memoryMb), 1)
  eq('vCPU 规格共享一种', sharedOf((s) => s.cpus), 1)

  // 逐槽位不同的字段里，也不能出现「全是同一台机器的分身」
  ok('20 条 argv 互不相同',
    new Set(plan.slots.map((s) => s.kvm.argv.join(' '))).size === 20)
  ok('每条 argv 的 type=1 serial 都对应本槽位',
    plan.slots.every((s) => s.kvm.argv.some((a) => a.startsWith('type=1,') && a.includes(`serial=${s.serial}`))))

  // 资产标签也逐槽位不同
  eq('主板资产标签两两不同', uniqOf((s) => s.kvm.smbios[2].asset), 20)
  eq('机箱资产标签两两不同', uniqOf((s) => s.kvm.smbios[3].asset), 20)

  // 全部 SMBIOS 参数两两不同（整体不重复）
  eq('20 组 SMBIOS 参数两两不同',
    new Set(plan.slots.map((s) => s.kvm.smbiosArgv.join('|'))).size, 20)

  // 每个槽位的四张表都齐全且合法
  ok('每槽 4 条 smbios 参数',
    plan.slots.every((s) => s.kvm.smbiosArgv.length === 4))
  ok('每槽 type=1 uuid 合法',
    plan.slots.every((s) => isSmbiosUuid(s.uuid)))
  ok('每槽 MAC 合法',
    plan.slots.every((s) => isUnicastMac(s.mac)))
  ok('每槽 MAC 不用 QEMU 默认段',
    plan.slots.every((s) => !s.mac.startsWith('52:54:00')))

  // 磁盘路径冲突检测为零
  eq('20 槽位无磁盘路径冲突', plan.diskConflicts.length, 0)
  eq('规划通过', plan.ok, true)
  eq('唯一字段全部 20', plan.uniqueFields.mac, 20)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n7. 磁盘路径冲突检测')
// ═══════════════════════════════════════════════════════════════
{
  const good = detectDiskConflicts([
    { vmId: 'a-01', diskPath: '/d/a-01/disk.qcow2', slotDir: '/d/a-01' },
    { vmId: 'a-02', diskPath: '/d/a-02/disk.qcow2', slotDir: '/d/a-02' },
  ])
  eq('不同路径无冲突', good.ok, true)
  eq('冲突列表为空', good.conflicts.length, 0)

  const shared = detectDiskConflicts([
    { vmId: 'a-01', diskPath: '/d/same.qcow2', slotDir: '/d/a-01' },
    { vmId: 'a-02', diskPath: '/d/same.qcow2', slotDir: '/d/a-02' },
  ])
  eq('同一磁盘路径被检出', shared.ok, false)
  eq('冲突类型是 disk-path-shared', shared.conflicts[0].kind, 'disk-path-shared')
  eq('冲突记录两个槽位', shared.conflicts[0].slots.join(','), 'a-01,a-02')

  const nested = detectDiskConflicts([
    { vmId: 'a-01', diskPath: '/d/a-01/disk.qcow2', slotDir: '/d/a-01' },
    { vmId: 'a-02', diskPath: '/d/a-01/nested/disk.qcow2', slotDir: '/d/a-01/nested' },
  ])
  eq('嵌套目录被检出', nested.conflicts[0].kind, 'slot-dir-nested')
  eq('嵌套记录父子关系', `${nested.conflicts[0].parent}>${nested.conflicts[0].child}`, 'a-01>a-02')

  const sameDir = detectDiskConflicts([
    { vmId: 'a-01', diskPath: '/d/a-01/disk.qcow2', slotDir: '/d/a-01' },
    { vmId: 'a-02', diskPath: '/d/a-01/disk2.qcow2', slotDir: '/d/a-01' },
  ])
  eq('同一目录被检出', sameDir.conflicts[0].kind, 'slot-dir-shared')

  eq('空列表无冲突', detectDiskConflicts([]).ok, true)
  eq('非数组按空处理', detectDiskConflicts(null).ok, true)

  // planKvmSlots 也做同样的冲突检测
  const slots = Array.from({ length: 5 }, (_, i) => ({ vmId: `claude-0${i + 1}`, persona: P(`claude-0${i + 1}`) }))
  const pk = planKvmSlots({ slots, rootDir: '/tmp/kvm-plan' })
  eq('planKvmSlots 5 个槽位', pk.slots.length, 5)
  eq('planKvmSlots 无冲突', pk.ok, true)
  eq('每个槽位有 instanceId', pk.slots.every((s) => typeof s.instanceId === 'string'), true)
  // 故意把 rootDir 和 vmId 都固定成同一个 → 必须检出冲突
  const dup = planKvmSlots({ slots: [{ vmId: 'same', persona: P('claude-01') }, { vmId: 'same', persona: P('claude-02') }], rootDir: '/tmp/kvm-plan' })
  eq('同 vmId 冲突被检出', dup.ok, false)
  ok('冲突明细里含 disk-path-shared', dup.conflicts.some((c) => c.kind === 'disk-path-shared'))
}

// ═══════════════════════════════════════════════════════════════
console.log('\n8. 资源规则与 KVM 开销')
// ═══════════════════════════════════════════════════════════════
{
  const p = P('claude-01')
  const mem = kvmMemoryMb(p)
  const vc = kvmVcpus(p)
  ok('内存落在 [下限, 上限] 内',
    mem >= KVM_RESOURCE_RULES.minMemoryMb && mem <= KVM_RESOURCE_RULES.maxMemoryMb, String(mem))
  ok('vCPU 落在 [下限, 上限] 内',
    vc >= KVM_RESOURCE_RULES.minVcpus && vc <= KVM_RESOURCE_RULES.maxVcpus, String(vc))
  eq('vCPU 是整数', Number.isInteger(vc), true)
  eq('内存是 256 的倍数', mem % KVM_RESOURCE_RULES.memoryStep, 0)

  // hypervisor 开销必须如实加上
  eq('内存实际占用 = 客户机 + hypervisor 开销',
    kvmMemoryFootprintMb(p), mem + KVM_RESOURCE_RULES.hypervisorOverheadMb)
  ok('实际占用大于客户机内存',
    kvmMemoryFootprintMb(p) > mem, `${kvmMemoryFootprintMb(p)} vs ${mem}`)

  // 磁盘：标称 vs 实际，两者必须分开算
  const diskFp = kvmDiskFootprintMb()
  const diskNominal = KVM_RESOURCE_RULES.diskGb * 1024
  ok('磁盘实际占用远小于标称（qcow2 稀疏）', diskFp < diskNominal, `${diskFp} < ${diskNominal}`)
  ok('磁盘实际占用仍有下限（不会因稀疏就按 0 算）',
    diskFp > KVM_RESOURCE_RULES.baseFootprintGb * 1024, String(diskFp))

  // 规则可以用覆盖值改写
  const tight = { ...KVM_RESOURCE_RULES, minVcpus: 1, maxVcpus: 1 }
  eq('覆盖 maxVcpus 后 vCPU 变 1', kvmVcpus(p, tight), 1)

  // maxSlotsForHost 走 KVM 规则时按实际占用算
  const maxKvm = maxSlotsForHost({
    runtime: 'kvm',
    hostResources: { memoryGb: 128, cpus: 64, diskGb: 2000 },
  })
  eq('maxSlotsForHost 记录 runtime', maxKvm.runtime, 'kvm')
  eq('KVM 反算的每槽内存是客户机内存', maxKvm.perSlot.memoryMb, mem)
  eq('KVM 反算的每槽实际占用含开销', maxKvm.perSlot.footprintMb, mem + KVM_RESOURCE_RULES.hypervisorOverheadMb)
  ok('KVM 反算的槽位数是有限值', Number.isFinite(maxKvm.slots), String(maxKvm.slots))

  // 同一台机器，KVM 能放的槽位必须少于 Docker（独立内核的开销）
  const maxDocker = maxSlotsForHost({ runtime: 'docker', hostResources: { memoryGb: 128, cpus: 64, diskGb: 2000 } })
  ok('同样资源下 KVM 槽位数不多于 Docker',
    maxKvm.slots <= maxDocker.slots, `kvm=${maxKvm.slots} docker=${maxDocker.slots}`)

  // runtime 规范化
  eq('runtime 默认 docker', normalizeRuntime(undefined), 'docker')
  eq('runtime 接受 kvm', normalizeRuntime('kvm'), 'kvm')
  eq('runtime 大小写不敏感', normalizeRuntime('KVM'), 'kvm')
  throws('非法 runtime 报错', () => normalizeRuntime('vmware'), 'unsupported runtime')
  eq('docker 用 Docker 规则', resourceRulesFor('docker').hostReserveRatio, 0.15)
  eq('kvm 用 KVM 规则', resourceRulesFor('kvm').hostReserveRatio, KVM_RESOURCE_RULES.hostReserveRatio)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n9. 生命周期状态机')
// ═══════════════════════════════════════════════════════════════
{
  eq('状态清单', SLOT_STATES.join(','), 'absent,created,starting,running,stopping,stopped,destroyed,error')

  // 合法迁移
  ok('absent → created', canTransition('absent', 'created'))
  ok('created → starting', canTransition('created', 'starting'))
  ok('starting → running', canTransition('starting', 'running'))
  ok('running → stopping', canTransition('running', 'stopping'))
  ok('stopping → stopped', canTransition('stopping', 'stopped'))
  ok('stopped → starting（重启）', canTransition('stopped', 'starting'))
  ok('stopped → destroyed', canTransition('stopped', 'destroyed'))

  // 非法迁移
  eq('absent → running 非法', canTransition('absent', 'running'), false)
  eq('running → stopped 非法（必须经过 stopping）', canTransition('running', 'stopped'), false)
  eq('running → created 非法', canTransition('running', 'created'), false)
  eq('destroyed → running 非法', canTransition('destroyed', 'running'), false)
  eq('未知状态一律非法', canTransition('bogus', 'running'), false)
  throws('assertTransition 对非法迁移抛错',
    () => assertTransition('running', 'stopped'), 'illegal slot state transition')
  ok('assertTransition 对合法迁移返回 true', assertTransition('created', 'starting'))
  eq('每个状态在迁移表里都有条目',
    SLOT_STATES.every((s) => Array.isArray(STATE_TRANSITIONS[s])), true)
  ok('迁移表里的目标状态都是已定义状态',
    SLOT_STATES.every((s) => STATE_TRANSITIONS[s].every((t) => SLOT_STATES.includes(t))),
    JSON.stringify(Object.values(STATE_TRANSITIONS).flat().filter((t) => !SLOT_STATES.includes(t))))
}

// ═══════════════════════════════════════════════════════════════
console.log('\n10. 生命周期演练（注入执行器，不碰真实 QEMU）')
// ═══════════════════════════════════════════════════════════════
{
  const root = tmpRoot()
  cleanup.push(root)

  /**
   * 模拟执行器 + 可控的进程存活集合。
   *
   * isAlive 必须能被「杀掉」：否则 stop 的 SIGKILL 分支永远看到进程还活着，
   * 于是 stop 报 ok:false —— 那是模拟器的缺陷，不是被测代码的问题。
   * 同时拦截 process.kill 的副作用：不能让测试真的去杀宿主上的某个 pid。
   */
  const makeSlotBase = ({ failOn = null, pidToWrite = 4242, aliveFilter = null } = {}) => {
    const calls = []
    const alive = new Set([pidToWrite])
    const run = async ({ command, args }) => {
      calls.push({ command, args })
      if (failOn && command.startsWith(failOn)) {
        return { ok: false, code: 1, stdout: '', stderr: 'simulated failure' }
      }
      if (command.startsWith('qemu-system')) {
        const i = args.indexOf('-pidfile')
        if (i >= 0) fs.writeFileSync(args[i + 1], `${pidToWrite}\n`)
      }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    const slot = new KvmSlot({
      persona: P('life-01'),
      rootDir: root,
      imagePath: path.join(root, 'base.qcow2'),
      bridge: 'br0',
      sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITEST test@local',
      run,
      isAlive: (pid) => (aliveFilter ? aliveFilter(pid) : alive.has(Number(pid))),
    })
    return { slot, calls, alive }
  }

  /**
   * 让 makeSlot 返回的 slot 拥有真实的「杀得掉」语义。
   * kill 注入点由 KvmSlot 提供（p.kill），不 monkey-patch process.kill ——
   * 否则测试会污染同进程里的其它模块。
   */
  const makeSlotWithKill = (opts = {}) => {
    const made = makeSlotBase(opts)
    made.slot.kill = (pid) => {
      if (!made.alive.has(Number(pid))) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      }
      made.alive.delete(Number(pid))
    }
    return made
  }

  // ── 初始状态
  const { slot: s1, calls } = makeSlotWithKill()
  eq('初始状态 absent', s1.state, 'absent')
  eq('初始状态没有日志', s1.log.length, 0)

  // ── create
  const created = await s1.create()
  eq('create 后状态 created', s1.state, 'created')
  eq('create 返回 ok', created.ok, true)
  ok('create 建了盘', created.steps.includes('disk'))
  ok('create 写了 seed', created.steps.includes('seed'))
  ok('base.id 被记录', fs.existsSync(path.join(root, 'life-01/base.id')))
  eq('create 的 diskPath 指向槽位目录', created.diskPath, path.join(root, 'life-01/disk.qcow2'))
  ok('create 用了 qemu-img', calls.length >= 1 && calls.some((c) => c.command === 'qemu-img'))
  ok('qemu-img 用 -b 指向基础镜像',
    calls.find((c) => c.command === 'qemu-img').args.includes('-b'))
  ok('qemu-img 指定 qcow2 格式',
    calls.find((c) => c.command === 'qemu-img').args.includes('qcow2'))
  ok('qemu-img 带容量参数（40G）',
    calls.find((c) => c.command === 'qemu-img').args.includes('40G'),
    JSON.stringify(calls.find((c) => c.command === 'qemu-img').args))
  ok('genisoimage 造 seed ISO',
    calls.some((c) => c.command === 'genisoimage'))
  ok('seed ISO 的 volume id 是 cidata',
    calls.find((c) => c.command === 'genisoimage').args.includes('cidata'))

  // ── start
  const started = await s1.start()
  eq('start 后状态 running', s1.state, 'running')
  eq('start 返回 ok', started.ok, true)
  eq('start 返回 pid', started.pid, 4242)
  ok('start 用的是 qemu-system-x86_64',
    calls.some((c) => c.command === 'qemu-system-x86_64'))

  // ── 重复 start 必须被拦（否则两块 qemu 抢同一块盘）
  let dupErr = null
  try { await s1.start() } catch (e) { dupErr = e }
  ok('重复 start 被拒绝', Boolean(dupErr), dupErr ? '' : 'did not throw')
  ok('拒绝理由是 already running',
    Boolean(dupErr) && dupErr.message.includes('already running'), dupErr?.message)

  // ── status
  const st = await s1.status()
  eq('status 报 running', st.state, 'running')
  eq('status 带 pid', st.pid, 4242)
  eq('status 的 alive 为 true', st.alive, true)
  eq('status 带 MAC', st.mac.length, 17)

  // ── stop（QMP socket 不存在 → 直接走 SIGKILL 分支前的降级）
  const stopped = await s1.stop({ powerdownTimeoutMs: 50, sleep: async () => {} })
  eq('stop 后状态 stopped', s1.state, 'stopped')
  eq('stop 返回 ok', stopped.ok, true)
  ok('stop 记录了降级步骤', Array.isArray(stopped.steps))

  // ── 重复 stop 是幂等的
  const stopped2 = await s1.stop()
  eq('重复 stop 幂等', stopped2.state, 'stopped')
  eq('重复 stop 不产生步骤', stopped2.steps.length, 0)

  // ── 强杀失败：进程杀不掉时绝不能标成 stopped
  //
  // 这一条防的是真实的数据损坏路径：若 killer 失败却把状态写成 stopped 并
  // 删掉 PID 文件，下一次 start() 就检测不到冲突，两个 qemu 会同时写
  // 同一块 qcow2。所以这里必须留下 error + 保留 PID 文件。
  {
    const made = makeSlotWithKill()
    made.slot.kill = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    }
    await made.slot.create()
    await made.slot.start()
    const immort = await made.slot.stop({ powerdownTimeoutMs: 1, quitTimeoutMs: 1, sleep: async () => {} })
    eq('杀不掉的进程 stop 返回 ok=false', immort.ok, false)
    eq('杀不掉的进程状态是 error 而不是 stopped', made.slot.state, 'error')
    eq('杀不掉时要求人工介入', immort.needsManualIntervention, true)
    ok('杀不掉时 PID 文件被保留（守住下次 start 的冲突检测）',
      fs.existsSync(made.slot.paths.pidFile))
    // 关键回归：紧接一次 start 必须仍然被拦住
    let reErr = null
    try { await made.slot.start() } catch (e) { reErr = e }
    ok('杀不掉之后再 start 仍被拒绝（不会起第二个 qemu）', Boolean(reErr), reErr?.message)
    // 两条独立的护栏任一生效都算拦住了：状态机不允许 error → starting，
    // 且 PID 文件仍在所以 live-pid 检查也能兜住。断言其一即可，但必须真的抛。
    ok('拒绝理由来自状态机或 pid 检查',
      Boolean(reErr) && /illegal slot state transition|live pid|already running/.test(reErr.message),
      reErr?.message)
  }

  // ── destroy 在进程杀不掉时必须拒删盘
  //
  // 修复前 destroy 只看 state 字段：强杀失败留在 error 时跳过 stop，
  // 直接删盘 —— qemu 往已删除的 inode 写，客户机刷 I/O 错误而宿主机
  // 显示「清理成功」。这里锁住「先问进程，再删文件」的语义。
  {
    const imm = makeSlotWithKill()
    await imm.slot.create()
    // mock 的 qemu-img 不会真造文件，这里显式放一块盘，让断言有意义
    fs.writeFileSync(imm.slot.paths.diskPath, 'FAKE-QCOW2')
    fs.writeFileSync(imm.slot.paths.pidFile, `${[...imm.alive][0]}\n`)
    imm.slot.state = 'error'
    imm.slot.kill = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
    const d = await imm.slot.destroy()
    eq('杀不掉时 destroy 返回 ok=false', d.ok, false)
    eq('杀不掉时 destroy 要求人工介入', d.needsManualIntervention, true)
    ok('杀不掉时不删磁盘（保数据）', fs.existsSync(imm.slot.paths.diskPath))
    ok('杀不掉时不删 PID 文件', fs.existsSync(imm.slot.paths.pidFile))
  }

  // ── destroy 在能杀掉时正常清理
  {
    const mort = makeSlotWithKill()
    await mort.slot.create()
    fs.writeFileSync(mort.slot.paths.diskPath, 'FAKE-QCOW2')
    fs.writeFileSync(mort.slot.paths.pidFile, `${[...mort.alive][0]}\n`)
    mort.slot.state = 'error'
    const d = await mort.slot.destroy()
    eq('能杀掉时 destroy 成功', d.ok, true)
    ok('能杀掉时磁盘被清理', !fs.existsSync(mort.slot.paths.diskPath))
    eq('能杀掉时最终状态 destroyed', mort.slot.state, 'destroyed')
  }

  // ── destroy
  const destroyed = await s1.destroy()
  eq('destroy 后状态 destroyed', s1.state, 'destroyed')
  eq('destroy 返回 ok', destroyed.ok, true)
  ok('destroy 删掉了 base.id', !fs.existsSync(path.join(root, 'life-01/base.id')))
  eq('slotDir 已被清理', fs.existsSync(path.join(root, 'life-01')), false)

  // ── 失败路径：qemu-img 失败 → error 状态
  const { slot: s2 } = makeSlotWithKill({ failOn: 'qemu-img' })
  let imgErr = null
  try { await s2.create() } catch (e) { imgErr = e }
  ok('qemu-img 失败时 create 抛错', Boolean(imgErr))
  ok('抛错信息含 disk create failed',
    Boolean(imgErr) && imgErr.message.includes('disk create failed'), imgErr?.message)
  eq('失败后状态是 error', s2.state, 'error')

  // ── 失败路径：qemu 启动失败
  const { slot: s3 } = makeSlotWithKill({ failOn: 'qemu-system' })
  await s3.create()
  let startErr = null
  try { await s3.start() } catch (e) { startErr = e }
  ok('qemu 启动失败时 start 抛错', Boolean(startErr))
  ok('抛错信息含 qemu start failed',
    Boolean(startErr) && startErr.message.includes('qemu start failed'), startErr?.message)
  eq('启动失败后状态是 error', s3.state, 'error')

  // ── 未 create 就 start 必须被拦
  const { slot: s4 } = makeSlotWithKill()
  let earlyErr = null
  try { await s4.start() } catch (e) { earlyErr = e }
  ok('absent 状态 start 被拒绝', Boolean(earlyErr))
  ok('拒绝理由提示先 create',
    Boolean(earlyErr) && earlyErr.message.includes('call create() first'), earlyErr?.message)

  // ── 没有 imagePath 时 create 报错（不能凭空造盘）
  const bareRun = makeSlotBase().slot.run
  const noImage = new KvmSlot({ persona: P('life-02'), rootDir: root, run: bareRun })
  let noImgErr = null
  try { await noImage.create() } catch (e) { noImgErr = e }
  ok('缺 imagePath 时 create 报错', Boolean(noImgErr))
  ok('报错信息提到 imagePath',
    Boolean(noImgErr) && noImgErr.message.includes('imagePath'), noImgErr?.message)

  // ── 构造期校验
  throws('没有 persona 不能构造 KvmSlot', () => new KvmSlot({}), 'requires a persona')

  // ── 无 SSH key 时不写 seed，但 metadata 仍可生成
  const noKey = new KvmSlot({
    persona: P('life-03'), rootDir: root, imagePath: path.join(root, 'base.qcow2'),
    run: bareRun, isAlive: () => false,
  })
  const noKeyCreated = await noKey.create()
  eq('无 key 时 steps 只有 disk', noKeyCreated.steps.join(','), 'disk')

  // ── 状态日志完整记录了整条路径
  ok('日志记录了 absent → created', s1.log.some((l) => l.msg.includes('absent → created')))
  ok('日志记录了 created → starting', s1.log.some((l) => l.msg.includes('created → starting')))
  ok('日志记录了 starting → running', s1.log.some((l) => l.msg.includes('starting → running')))
  ok('日志记录了 running → stopping', s1.log.some((l) => l.msg.includes('running → stopping')))
  ok('日志记录了 stopping → stopped', s1.log.some((l) => l.msg.includes('stopping → stopped')))

  // ── 进程已死但 PID 文件还在 → status 应该报 stopped 而不是 running
  const { slot: s5 } = makeSlotWithKill()
  await s5.create()
  await s5.start()
  const deadSlot = new KvmSlot({
    persona: P('life-01'), rootDir: root, imagePath: path.join(root, 'base.qcow2'),
    run: bareRun, isAlive: () => false,
  })
  const deadStatus = await deadSlot.status()
  ok('进程已死时报非 running', deadStatus.state !== 'running', deadStatus.state)
  eq('进程已死时 alive 为 false', deadStatus.alive, false)

  // ── 残留的 pid 文件不能让新 start 误判为已在运行
  const { slot: s6 } = makeSlotWithKill({ pidToWrite: 9999 })
  await s6.create()
  // 手动写一个已死进程的 pid 文件
  fs.writeFileSync(s6.paths.pidFile, '8888\n')
  const restarted = await s6.start()
  eq('残留 pid 文件不阻止重启', restarted.ok, true)
  eq('重启后状态 running', s6.state, 'running')
}

// ═══════════════════════════════════════════════════════════════
console.log('\n10b. QMP 客户端：回复判定（真实 socket，不 mock）')
// ═══════════════════════════════════════════════════════════════
{
  // QMP 的回复是 JSON 行。命令失败时 QEMU 回 {"error":{...}}，这必须判成
  // 失败 —— 否则 stop() 会以为电源键已按，白等整个 powerdownTimeoutMs 才降级。
  const qmpDir = tmpRoot()
  cleanup.push(qmpDir)
  const scenario = async (name, handler) => {
    const sockPath = path.join(qmpDir, `qmp-${name}.sock`)
    const server = net.createServer(handler)
    await new Promise((r) => server.listen(sockPath, r))
    const res = await qmpCommand(sockPath, 'system_powerdown', { timeoutMs: 1500 })
    await new Promise((r) => server.close(r))
    return res
  }

  const okRes = await scenario('ok', (sock) => {
    sock.write(JSON.stringify({ QMP: { version: {}, capabilities: [] } }) + '\n')
    sock.on('data', () => {
      sock.write(JSON.stringify({ return: {} }) + '\n')
      sock.write(JSON.stringify({ return: {} }) + '\n')
    })
  })
  eq('QMP 正常回复判成功', okRes.ok, true)

  const errRes = await scenario('err', (sock) => {
    sock.write(JSON.stringify({ QMP: { version: {} } }) + '\n')
    sock.on('data', () => {
      sock.write(JSON.stringify({ return: {} }) + '\n')
      sock.write(JSON.stringify({ error: { class: 'GenericError', desc: 'no such device' } }) + '\n')
    })
  })
  eq('QMP error 回复判失败', errRes.ok, false)
  ok('QMP 失败带上服务端的 desc', String(errRes.error).includes('no such device'), errRes.error)

  // 多条消息塞进同一个 chunk：不按行切会把 greeting 回执混成一条
  const batchRes = await scenario('batch', (sock) => {
    sock.write([JSON.stringify({ QMP: { version: {} } }), ''].join('\n'))
    sock.once('data', () => {
      sock.write([JSON.stringify({ return: {} }), JSON.stringify({ return: {} })].join('\n') + '\n')
    })
  })
  eq('QMP 批量回复（同一 chunk）仍判成功', batchRes.ok, true)

  // socket 不存在 → 超时/连接错误，必须是失败
  const deadRes = await qmpCommand(path.join(qmpDir, 'no-such.sock'), 'quit', { timeoutMs: 400 })
  eq('QMP 连不上判失败', deadRes.ok, false)
}

// ═══════════════════════════════════════════════════════════════
console.log('\n11. cloud-init 内容与实例唯一性')
// ═══════════════════════════════════════════════════════════════
{
  const ud = renderCloudInitUserData({
    hostname: 'ip-10-0-1-11',
    sshPublicKey: 'ssh-ed25519 AAAA test@local',
    username: 'ubuntu',
  })
  ok('user-data 以 #cloud-config 开头', ud.startsWith('#cloud-config'))
  ok('user-data 含 hostname', ud.includes('hostname: ip-10-0-1-11'))
  ok('user-data 含 fqdn', ud.includes('fqdn: ip-10-0-1-11'))
  ok('user-data 含 ssh 公钥', ud.includes('ssh-ed25519 AAAA test@local'))
  ok('user-data 关了密码登录', ud.includes('ssh_pwauth: false'))
  ok('user-data 关了 root 登录', ud.includes('disable_root: true'))
  ok('user-data 里没有明文密码', !/password:\s*\S/.test(ud))
  throws('缺公钥时 user-data 报错',
    () => renderCloudInitUserData({ hostname: 'x' }), 'ssh public key')

  const md = renderCloudInitMetaData({ vmId: 'claude-01', hostname: 'h1' })
  ok('meta-data 含 instance-id', md.includes('instance-id:'))
  ok('meta-data 含 local-hostname', md.includes('local-hostname: h1'))
  eq('instance-id 是合法 UUID 形态',
    isSmbiosUuid(md.match(/instance-id:\s*(\S+)/)[1]), true)

  // instance-id 必须逐槽位不同：共用会导致第二台跳过初始化
  eq('20 槽位 instance-id 两两不同',
    new Set(Array.from({ length: 20 }, (_, i) => kvmInstanceIdFor(`claude-${i + 1}`))).size, 20)
  eq('同 vmId 的 instance-id 可复现',
    kvmInstanceIdFor('claude-01'), kvmInstanceIdFor('claude-01'))
}

// ═══════════════════════════════════════════════════════════════
console.log('\n12. 客户机自检：判定逻辑（注入 SSH 执行器）')
// ═══════════════════════════════════════════════════════════════
{
  const s = spec('verify-01')

  /** 构造一个「客户机行为正确」的模拟 SSH 执行器。 */
  const goodExec = (overrides = {}) => async ({ command, args }) => {
    const key = `${command} ${args.join(' ')}`.trim()
    const table = {
      'hostname': s.persona.naming.hostname,
      'uname -n': s.persona.naming.hostname,
      'uname -r': '6.8.0-45-generic',
      'uname -s': 'Linux',
      'systemd-detect-virt': 'kvm',
      [`cat /sys/class/net/${s.persona.network.interface}/address`]: s.mac.toLowerCase(),
      [`cat /sys/class/net/eth0/address`]: s.mac.toLowerCase(),
    }
    // sysfs 字段
    for (const field of KVM_VERIFY_FIELDS) {
      const v = {
        sys_vendor: s.smbios[1].manufacturer,
        product_name: s.smbios[1].product,
        product_version: s.smbios[1].version,
        product_serial: s.smbios[1].serial,
        product_uuid: s.smbios[1].uuid,
        product_family: s.smbios[1].family,
        board_vendor: s.smbios[2].manufacturer,
        board_name: s.smbios[2].product,
        board_version: s.smbios[2].version,
        board_serial: s.smbios[2].serial,
        bios_vendor: s.smbios[0].vendor,
        bios_version: s.smbios[0].version,
        bios_date: s.smbios[0].date,
        chassis_vendor: s.smbios[3].manufacturer,
        chassis_serial: s.smbios[3].serial,
      }[field]
      table[`cat /sys/class/dmi/id/${field}`] = String(v ?? '')
    }
    // dmidecode -s
    for (const kw of KVM_VERIFY_KEYWORDS) {
      const field = Object.keys(KVM_DMI_TO_DMIDECODE).find((k) => KVM_DMI_TO_DMIDECODE[k] === kw)
      table[`dmidecode -s ${kw}`] = String({
        sys_vendor: s.smbios[1].manufacturer,
        product_name: s.smbios[1].product,
        product_serial: s.smbios[1].serial,
        product_uuid: s.smbios[1].uuid,
        board_vendor: s.smbios[2].manufacturer,
        board_name: s.smbios[2].product,
      }[field] ?? '')
    }
    table['dmidecode -t 1'] = [
      'System Information',
      `\tManufacturer: ${s.smbios[1].manufacturer}`,
      `\tProduct Name: ${s.smbios[1].product}`,
      `\tSerial Number: ${s.smbios[1].serial}`,
      `\tUUID: ${s.smbios[1].uuid}`,
      `\tFamily: ${s.smbios[1].family}`,
      '',
      'Handle 0x0100, DMI type 2, 15 bytes',
    ].join('\n')
    table['dmidecode -t 3'] = 'Chassis Information\n\tManufacturer: X\n\tType: Other\n'
    table['ip link show'] = `2: ens192: <BROADCAST> mtu 1500\n    link/ether ${s.mac.toLowerCase()} brd ff:ff:ff:ff:ff:ff`
    table['ls /dev/disk/by-id'] = `virtio-${s.diskSerial}`

    const merged = { ...table, ...overrides }
    if (key in merged) return { ok: true, code: 0, stdout: merged[key], stderr: '' }
    return { ok: false, code: 127, stdout: '', stderr: `command not found: ${key}` }
  }

  const good = await verifyKvmPersona({ sshTarget: 'ubuntu@10.0.0.5:22', expected: s, exec: goodExec() })
  eq('客户机行为正确时自检通过', good.ok, true)
  ok('自检项数 > 20', good.checks.length > 20, String(good.checks.length))
  eq('没有失败项', good.failed.length, 0)
  ok('summary 里分母等于检查数', good.summary.endsWith(`/${good.checks.length} passed`), good.summary)
  eq('自检报出客户机内核', good.guestKernel, '6.8.0-45-generic')
  ok('自检覆盖 /sys/class/dmi/id/product_serial',
    good.checks.some((c) => c.name === '/sys/class/dmi/id/product_serial'))
  ok('自检覆盖 dmidecode -s system-uuid',
    good.checks.some((c) => c.name === 'dmidecode -s system-uuid'))
  ok('自检覆盖 dmidecode -t 1 整段',
    good.checks.some((c) => c.name === 'dmidecode -t 1 Manufacturer'))
  ok('自检覆盖 MAC', good.checks.some((c) => c.name.includes('/address')))
  ok('自检覆盖磁盘序列号', good.checks.some((c) => c.name.includes('virtio serial')))

  // ── 关键：必须能报错。一个永远 pass 的自检等于没有自检。
  const wrongSerial = await verifyKvmPersona({
    sshTarget: 'ubuntu@10.0.0.5:22',
    expected: s,
    exec: goodExec({ 'cat /sys/class/dmi/id/product_serial': 'WRONGSERIAL' }),
  })
  eq('序列号不符时自检失败', wrongSerial.ok, false)
  ok('失败项里点名 product_serial',
    wrongSerial.failed.some((c) => c.name === '/sys/class/dmi/id/product_serial'),
    JSON.stringify(wrongSerial.failed.map((c) => c.name)))

  const wrongVendor = await verifyKvmPersona({
    sshTarget: 'ubuntu@10.0.0.5:22',
    expected: s,
    exec: goodExec({ 'cat /sys/class/dmi/id/sys_vendor': 'QEMU' }),
  })
  eq('厂商不符时自检失败', wrongVendor.ok, false)
  ok('失败项里点名 sys_vendor',
    wrongVendor.failed.some((c) => c.name === '/sys/class/dmi/id/sys_vendor'))

  const wrongMac = await verifyKvmPersona({
    sshTarget: 'ubuntu@10.0.0.5:22',
    expected: s,
    exec: goodExec({ 'ip link show': 'link/ether 52:54:00:aa:bb:cc brd ff' }),
  })
  eq('MAC 不符时自检失败', wrongMac.ok, false)
  ok('失败项里点名 ip link MAC',
    wrongMac.failed.some((c) => c.name === 'ip link show MAC'))

  // ── dmidecode 与 sysfs 分裂：两条路径读同一张表，不一致就是表本身有问题
  const split = await verifyKvmPersona({
    sshTarget: 'ubuntu@10.0.0.5:22',
    expected: s,
    exec: goodExec({ 'dmidecode -s system-serial-number': 'OTHER' }),
  })
  eq('sysfs 与 dmidecode 分裂时自检失败', split.ok, false)
  ok('分裂报在 dmidecode 侧',
    split.failed.some((c) => c.name === 'dmidecode -s system-serial-number'))

  // ── requireDmidecode=false：dmidecode 缺失不该让自检失败
  //
  // 修复前只对 `dmidecode -t 1` 生效，`-s <keyword>` 循环照样产出失败项 ——
  // 结果是在没装 dmidecode 的精简镜像上自检永远红，而 sysfs 那条路径其实
  // 已经把同样的值核对过了，结论并不受影响。
  // goodExec 按「command + args」拼 key，所以这里套一层：整条 dmidecode
  // 命令一律模拟成「未安装」，其余交给 goodExec 正常返回。
  const noDmiExec = (tables) => {
    const base = goodExec(tables)
    return ({ command, args = [] }) => (command === 'dmidecode'
      ? { ok: false, code: 127, stdout: '', stderr: '-sh: dmidecode: not found' }
      : base({ command, args }))
  }
  const noDmi = await verifyKvmPersona({
    sshTarget: 'ubuntu@10.0.0.5:22',
    expected: s,
    exec: noDmiExec(),
    requireDmidecode: false,
  })
  eq('dmidecode 缺失 + requireDmidecode=false 时自检通过', noDmi.ok, true,
    noDmi.failed.map((c) => c.name).join(' | '))
  eq('dmidecode 被记录为不可用', noDmi.dmidecodeAvailable, false)
  ok('跳过的 dmidecode 项明确标注 skipped',
    noDmi.checks.some((c) => c.skipped), JSON.stringify(noDmi.checks.filter((c) => c.skipped).length))
  ok('sysfs 路径仍然逐个核对过',
    noDmi.checks.filter((c) => c.name.startsWith('/sys/class/dmi/id/') && !c.skipped).length >= 12)

  // 默认（requireDmidecode=true）时，dmidecode 缺失必须判失败 ——
  // 否则「两条独立路径交叉验证」这个设计目标就落空了。
  const noDmiStrict = await verifyKvmPersona({
    sshTarget: 'ubuntu@10.0.0.5:22',
    expected: s,
    exec: noDmiExec(),
  })
  eq('默认要求 dmidecode 时缺失判失败', noDmiStrict.ok, false)
  ok('失败项指向 dmidecode',
    noDmiStrict.failed.some((c) => c.name.startsWith('dmidecode')), noDmiStrict.failed.map((c) => c.name).join(' | '))

  // ── 严格模式抛错
  let assertErr = null
  try {
    const { assertKvmPersona } = await import('../src/persona/kvm-verify.mjs')
    await assertKvmPersona({
      sshTarget: 'ubuntu@10.0.0.5:22',
      expected: s,
      exec: goodExec({ 'cat /sys/class/dmi/id/product_serial': 'BAD' }),
    })
  } catch (e) { assertErr = e }
  ok('严格模式抛错', Boolean(assertErr))
  eq('错误码是 KVM_PERSONA_VERIFY_FAILED', assertErr?.code, 'KVM_PERSONA_VERIFY_FAILED')
  ok('抛错信息列出不符项',
    String(assertErr?.message).includes('product_serial'), assertErr?.message?.split('\n')[0])

  // ── 缺参数校验
  await throwsAsync('缺 sshTarget 报错', () => verifyKvmPersona({ expected: s }), 'sshTarget')
  await throwsAsync('缺 expected 报错', () => verifyKvmPersona({ sshTarget: 'h' }), 'expected')

  // ── dmidecode 输出解析
  const parsed = parseDmidecodeFields('\tManufacturer: Dell Inc.\n\tSerial Number: A.B:C.D\n')
  eq('解析 Manufacturer', parsed.Manufacturer, 'Dell Inc.')
  eq('解析只取第一个冒号后的值', parsed['Serial Number'], 'A.B:C.D')

  const sysInfo = parseSystemInformation(
    'Handle 0x0001\nBIOS Information\n\tVendor: SeaBIOS\n\nHandle 0x0100\nSystem Information\n\tManufacturer: Dell Inc.\n\nHandle 0x0200\nBase Board\n',
  )
  eq('只取 System Information 段', sysInfo.Manufacturer, 'Dell Inc.')
  eq('不混入 BIOS 段', 'Vendor' in sysInfo, false)

  // ── QEMU 默认值泄漏检测
  const leaked = detectDefaultSmbiosLeak({
    sys_vendor: 'QEMU',
    product_name: 'Standard PC (Q35 + ICH9, 2009)',
    bios_vendor: 'SeaBIOS',
    chassis_vendor: 'Dell Inc.',
  })
  eq('检出 3 个默认值字段', leaked.join(','), 'sys_vendor,product_name,bios_vendor')
  eq('无泄漏时返回空', detectDefaultSmbiosLeak({ sys_vendor: 'Dell Inc.' }).length, 0)
  ok('默认值表覆盖了最典型的 QEMU 字样',
    QEMU_DEFAULT_SMBIOS.sys_vendor === 'QEMU' && QEMU_DEFAULT_SMBIOS.bios_vendor === 'SeaBIOS')
}

// ═══════════════════════════════════════════════════════════════
console.log('\n13. 混合编排：Claude 走 KVM、Codex 走 Docker')
// ═══════════════════════════════════════════════════════════════
{
  const mixed = planMixedFleet(
    {
      claude: { runtime: 'kvm', count: 20, bridge: 'br0', kvmRootDir: '/tmp/mixed-kvm' },
      codex: { runtime: 'docker', count: 2, network: 'persona-net' },
    },
    { hostResources: { memoryGb: 512, cpus: 128, diskGb: 4000 } },
  )

  eq('两个分组', mixed.groupNames.join(','), 'claude,codex')
  eq('槽位总数 22', mixed.totals.count, 22)
  eq('KVM 分组 20 个', mixed.totals.byRuntime.kvm, 20)
  eq('Docker 分组 2 个', mixed.totals.byRuntime.docker, 2)
  eq('claude 分组 runtime 是 kvm', mixed.groups.claude.runtime, 'kvm')
  eq('codex 分组 runtime 是 docker', mixed.groups.codex.runtime, 'docker')
  eq('claude 分组 20 槽', mixed.groups.claude.slots.length, 20)
  eq('codex 分组 2 槽', mixed.groups.codex.slots.length, 2)

  // 跨分组身份唯一性
  eq('跨分组无身份冲突', mixed.crossCollisions.length, 0)
  eq('22 个 MAC 全不同', new Set(mixed.slots.map((s) => s.mac)).size, 22)
  eq('22 个 UUID 全不同', new Set(mixed.slots.map((s) => s.uuid)).size, 22)
  eq('22 个序列号全不同', new Set(mixed.slots.map((s) => s.serial)).size, 22)
  eq('22 个主机名全不同', new Set(mixed.slots.map((s) => s.hostname)).size, 22)
  eq('跨分组无磁盘路径冲突', mixed.diskConflicts.length, 0)

  // 主机名必须按全局偏移，不能两组都从 0 开始
  eq('claude 第一个主机名', mixed.groups.claude.slots[0].hostname, 'ip-10-0-1-11')
  ok('codex 主机名不与 claude 重叠',
    mixed.groups.codex.slots.every((s) => !mixed.groups.claude.slots.some((c) => c.hostname === s.hostname)),
    mixed.groups.codex.slots.map((s) => s.hostname).join(','))

  // 两组各自的产物形态不同
  ok('KVM 槽位带 qemu argv',
    mixed.groups.claude.slots.every((s) => Array.isArray(s.kvm.argv) && s.kvm.argv.length > 0))
  ok('Docker 槽位带 docker args',
    mixed.groups.codex.slots.every((s) => Array.isArray(s.docker.args) && s.docker.args.length > 0))
  ok('KVM 槽位没有 docker 字段', mixed.groups.claude.slots.every((s) => s.docker === null))
  ok('Docker 槽位没有 kvm 字段', mixed.groups.codex.slots.every((s) => s.kvm === null))

  // 资源账按实际占用算，且 KVM 单槽开销高于 Docker
  const kvmSlot = mixed.groups.claude.slots[0]
  const dockerSlot = mixed.groups.codex.slots[0]
  ok('KVM 单槽实际内存 > 客户机内存',
    kvmSlot.footprintMb > kvmSlot.memoryMb, `${kvmSlot.footprintMb} vs ${kvmSlot.memoryMb}`)
  eq('Docker 单槽实际内存 = 配额',
    dockerSlot.footprintMb, dockerSlot.memoryMb)
  eq('混合编排预留比例取最保守值', mixed.reserveRatio, KVM_RESOURCE_RULES.hostReserveRatio)
  ok('合计实际内存 >= 合计额度', mixed.totals.footprintMb >= mixed.totals.memoryMb)
  ok('合计实际磁盘 < 合计标称磁盘（qcow2 稀疏）',
    mixed.totals.diskFootprintMb < mixed.totals.diskMb,
    `${mixed.totals.diskFootprintMb} vs ${mixed.totals.diskMb}`)

  // 主机不够时真的报错
  const tight = planMixedFleet(
    { claude: { runtime: 'kvm', count: 20 }, codex: { runtime: 'docker', count: 2 } },
    { hostResources: { memoryGb: 8, cpus: 4 } },
  )
  eq('小主机规划不通过', tight.ok, false)
  ok('报出内存缺口', tight.deficits.some((d) => d.resource === 'memory'))
  ok('报出 CPU 缺口', tight.deficits.some((d) => d.resource === 'cpus'))
  ok('缺口消息含具体数值', /缺 \d+ MiB/.test(tight.deficits.find((d) => d.resource === 'memory').message))

  // 参数校验
  throws('空分组报错', () => planMixedFleet({}), 'at least one group')
  throws('分组 count 非法报错',
    () => planMixedFleet({ a: { runtime: 'kvm', count: 0 } }), 'positive integer')
  throws('非法 runtime 报错',
    () => planMixedFleet({ a: { runtime: 'xen', count: 1 } }), 'unsupported runtime')
}

// ═══════════════════════════════════════════════════════════════
console.log('\n14. manifest 与展示')
// ═══════════════════════════════════════════════════════════════
{
  const plan = planFleet({ count: 3, runtime: 'kvm', platform: 'linux', bridge: 'br0', kvmRootDir: '/tmp/kvm-manifest' })
  const manifest = fleetManifest(plan)
  eq('manifest runtime', manifest.runtime, 'kvm')
  eq('manifest 槽位数', manifest.slots.length, 3)
  eq('manifest 带 qemu argv', manifest.slots.every((s) => Array.isArray(s.qemu.argv)), true)
  eq('manifest 带 smbios', manifest.slots.every((s) => Object.keys(s.smbios).length === 4), true)
  eq('manifest 带盘路径', manifest.slots.every((s) => typeof s.qemu.diskPath === 'string'), true)
  eq('manifest 带 diskSerial', manifest.slots.every((s) => typeof s.diskSerial === 'string'), true)
  eq('manifest 带 instanceId', manifest.slots.every((s) => typeof s.instanceId === 'string'), true)
  eq('manifest 不带 docker args', manifest.slots.every((s) => s.args === undefined), true)
  ok('manifest 有 generatedAt', typeof manifest.generatedAt === 'string')
  ok('manifest 的 argv 串成形', manifest.slots[0].qemu.commandLine.startsWith('qemu-system-x86_64'))

  // slotQemuCommand 直接拿单槽位的命令行
  eq('slotQemuCommand 与 manifest 一致',
    slotQemuCommand(plan.slots[0]), manifest.slots[0].qemu.commandLine)
  throws('对 docker 槽位调 slotQemuCommand 报错',
    () => slotQemuCommand({ vmId: 'd-01', kvm: null }), 'not a kvm slot')

  // Docker 形态的 manifest 不受影响
  const dplan = planFleet({ count: 2, platform: 'linux', hostResources: { memoryGb: 64, cpus: 32 } })
  const dman = fleetManifest(dplan)
  eq('docker manifest runtime 是 docker', dman.runtime, 'docker')
  eq('docker manifest 仍有 args', dman.slots.every((s) => Array.isArray(s.args)), true)
  eq('docker manifest 没有 qemu 字段', dman.slots.every((s) => s.qemu === undefined), true)

  // 落盘：KVM 槽位不写 persona 树
  const { materializeFleet } = await import('../src/persona/fleet-plan.mjs')
  const root = tmpRoot()
  cleanup.push(root)
  const mat = await materializeFleet({
    count: 2, runtime: 'kvm', platform: 'linux',
    kvmRootDir: path.join(root, 'kvm'), bridge: 'br0',
  })
  eq('KVM 落盘 2 个条目', mat.materialized.length, 2)
  eq('KVM 条目不写文件', mat.materialized.every((m) => m.files === 0), true)
  ok('KVM 条目带说明', mat.materialized.every((m) => String(m.skipped || '').includes('QEMU')))
  ok('KVM 条目带 argv', mat.materialized.every((m) => Array.isArray(m.argv)))
}

// ═══════════════════════════════════════════════════════════════
// 清理
for (const d of cleanup) {
  try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ }
}


// ── 回归：cloud-init 的 bootstrap 必须合法 ──
//
// KVM 槽位用的是发行版 cloud image，里面没有我们的内核。
// 内核要靠 cloud-init 的 write_files 送进去 —— 一旦这份 YAML 不合法，
// cloud-init 会静默跳过初始化：SSH 能进，但内核永远不在，
// 而且没有任何报错。这是最难查的一类故障，所以格式必须断言死。
{
  const bs = buildKernelBootstrap({
    kernelSource: '/x/server.mjs',
    credentialJson: { accounts: [{ id: 'k1', access_token: 'sk-k1' }] },
    token: 'a'.repeat(48),
    slots: 4,
  })
  eq('bootstrap 产出 3 个文件', bs.files.length, 3)
  eq('含内核配置', bs.files.some((f) => f.path.endsWith('kernel.json')), true)
  eq('含凭据', bs.files.some((f) => f.path.endsWith('codex-credentials.json')), true)
  eq('含 systemd 单元', bs.files.some((f) => f.path.endsWith('.service')), true)
  eq('凭据权限 0600', bs.files.find((f) => f.path.endsWith('codex-credentials.json')).mode, '0600')
  eq('内核配置权限 0600', bs.files.find((f) => f.path.endsWith('kernel.json')).mode, '0600')

  const y = renderCloudInitUserData({
    hostname: 'ip-10-0-1-11',
    sshPublicKey: 'ssh-ed25519 AAAA k',
    bootstrap: bs,
  })
  eq('以 #cloud-config 开头', y.startsWith('#cloud-config\n'), true)
  eq('含 write_files', y.includes('write_files:'), true)
  eq('含 runcmd', y.includes('runcmd:'), true)
  // 缩进错一格就解析失败，所以断言 content 块用的是 6 空格
  eq('content 块缩进 6 空格', /    content: \|\n      \{/.test(y), true)
  // token 只能在内核配置里，不能出现在 systemd 的 ExecStart 上
  eq('token 不泄漏到 ExecStart', /ExecStart=[^\n]*aaaaaaaa/.test(y), false)

  // 无 bootstrap 时必须保持旧行为，不能凭空生成 write_files
  const plain = renderCloudInitUserData({ hostname: 'h', sshPublicKey: 'ssh-ed25519 AAAA x' })
  eq('无 bootstrap 时无 write_files', plain.includes('write_files:'), false)
  eq('无 bootstrap 时仍有 hostnamectl', plain.includes('hostnamectl'), true)

  // 离线模式不该联网装 node
  const off = buildKernelBootstrap({ kernelSource: '/x', token: 't', slots: 2, offline: true })
  eq('离线模式不联网', JSON.stringify(off.commands).includes('nodesource'), false)
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
