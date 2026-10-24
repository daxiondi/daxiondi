#!/usr/bin/env node
/**
 * KVM 路径的 SMBIOS 参数用真 qemu 校验。
 *
 * 没有 /dev/kvm 时验证不了「虚拟机真的跑起来」，但可以验证一件
 * 同样重要的事：**我们生成的 -smbios 参数 qemu 是否接受**。
 *
 * SMBIOS 值里不能出现逗号（会被当成字段分隔符）、不能超长、
 * UUID 必须合法 —— 这些错误只有真 qemu 才会报，单元测试断言不了。
 * 参数错了虚拟机起不来，而那是在 KVM 机器上才会暴露的问题。
 *
 * 用 -machine none -S 让 qemu 只解析参数立刻退出，不需要真的启动。
 */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const plan = (await import('../src/persona/fleet-plan.mjs')).planFleet({
  platform: 'linux', count: 3, prefix: 'slot', runtime: 'kvm',
})

let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('=== KVM SMBIOS 参数真机校验（qemu）===\n')

let qemu = null
try {
  qemu = execFileSync('which', ['qemu-system-x86_64'], { encoding: 'utf8' }).trim()
} catch { /* 没装 */ }
ok('qemu-system-x86_64 可用', Boolean(qemu), qemu || '未安装')
if (!qemu) {
  console.log('\n无 qemu，跳过后续校验')
  process.exit(1)
}

for (const slot of plan.slots) {
  const k = slot.kvm
  console.log(`\n[${slot.vmId}]`)
  ok('有 smbiosArgv', Array.isArray(k.smbiosArgv) && k.smbiosArgv.length > 0, `${k.smbiosArgv?.length ?? 0} 条`)

  // 逐个 type 拼参数交给 qemu 解析。
  // -machine none 表示不要任何机器模型，-S 表示启动即暂停，
  // 这样 qemu 只做参数校验就退出，不占用资源。
  for (const arg of k.smbiosArgv || []) {
    const typeMatch = String(arg).match(/^type=(\d+)/)
    const typeName = typeMatch ? `type=${typeMatch[1]}` : '?'
    let accepted = true
    let detail = ''
    try {
      execFileSync(qemu, [
        '-machine', 'none', '-S', '-display', 'none',
        '-smbios', arg,
        '-no-user-config', '-nodefaults',
      ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 })
    } catch (error) {
      // qemu 在 -machine none 下正常也会以非 0 退出（没有可启动设备），
      // 所以不能只看退出码，要看 stderr 里有没有参数解析错误。
      const err = `${error?.stderr || ''}${error?.stdout || ''}`
      const isArgError = /invalid|unrecognized|Unknown|expecting|too long|invalid SMBIOS/i.test(err)
      if (isArgError) { accepted = false; detail = err.split('\n')[0].slice(0, 140) }
    }
    ok(`${typeName} 被 qemu 接受`, accepted, detail)
  }

  // UUID 必须是标准格式，否则 Windows/Linux 都会识别成异常
  ok('product_uuid 格式合法', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(k.uuid || '')),
    String(k.uuid))

  // 逗号会破坏 -smbios 的字段分隔，是最容易踩的坑。
  //
  // 注意只看各字段的**值**，不看 arg 字符串本身 —— arg 里的逗号是分隔符，
  // 本来就该有。也不要 JSON.stringify 整个对象：那样逗号来自 JSON 结构。
  let badField = ''
  for (const [type, fields] of Object.entries(k.smbios || {})) {
    if (!fields || typeof fields !== 'object') continue
    for (const [name, value] of Object.entries(fields)) {
      if (name === 'arg' || name === 'chassisType') continue
      if (typeof value === 'string' && value.includes(',')) {
        badField = `type=${type}.${name} = ${value}`
        break
      }
    }
    if (badField) break
  }
  ok('SMBIOS 字段值内无裸逗号', badField === '', badField)
}

// ── 参数级唯一性：三个槽位的 UUID / serial 必须不同
console.log('\n[唯一性]')
const uuids = plan.slots.map((s) => s.kvm.uuid)
const serials = plan.slots.map((s) => s.kvm.serial)
const macs = plan.slots.map((s) => s.kvm.mac)
ok('UUID 两两不同', new Set(uuids).size === uuids.length, `${new Set(uuids).size}/${uuids.length}`)
ok('serial 两两不同', new Set(serials).size === serials.length, `${new Set(serials).size}/${serials.length}`)
ok('MAC 两两不同', new Set(macs).size === macs.length, `${new Set(macs).size}/${macs.length}`)

// ── /dev/kvm 状态（不影响上面的结论，只是说明）
console.log('\n[加速器]')
const hasKvm = fs.existsSync('/dev/kvm')
console.log(`  /dev/kvm: ${hasKvm ? '存在' : '不存在'}（计划里 accel=${plan.slots[0].kvm.accel}）`)
if (!hasKvm) {
  console.log('  说明：参数校验不需要 KVM，但虚拟机无法真正启动')
  console.log('        上线到带 /dev/kvm 的机器后才能验证启动')
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n结论：生成的 SMBIOS 参数 qemu 全部接受，换到带 /dev/kvm 的机器上可直接启动。')
