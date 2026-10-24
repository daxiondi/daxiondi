#!/usr/bin/env node
/**
 * KVM 槽位的内核 bootstrap 校验。
 *
 * KVM 侧用的是发行版 cloud image，里面没有我们的内核 —— 不像 Codex 走
 * Docker 时镜像是我们自己构建的。不补这一步，虚拟机起来只是个空壳。
 *
 * 这个脚本校验的是「生成的 cloud-init 是否真的合法」：
 * 格式看着对但 cloud-init 解析失败，是最难查的一类问题 ——
 * 客户机静默跳过初始化，SSH 能进，但内核永远不在。
 *
 * 校验手段按严格程度递进：
 *   1. 结构断言（我们自己写的，不依赖外部工具）
 *   2. YAML 解析（python3 + yaml，证明不是靠缩进碰巧对）
 *   3. cloud-init schema（官方校验器，最权威）
 *
 * 用法：node scripts/kvm-bootstrap-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const { buildKernelBootstrap, renderCloudInitUserData } = await import('../src/persona/kvm-lifecycle.mjs')

console.log('=== KVM 内核 bootstrap 校验 ===\n')

const TOKEN = 'a'.repeat(48)
const bootstrap = buildKernelBootstrap({
  kernelSource: path.join(ROOT, 'src/kernel/server.mjs'),
  credentialJson: { accounts: [{ id: 'check-account', access_token: 'sk-check', refresh_token: 'rt-check' }] },
  token: TOKEN,
  slots: 4,
})
const yaml = renderCloudInitUserData({
  hostname: 'ip-10-0-1-11',
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITEST check@host',
  bootstrap,
})

// ── 1. 结构断言
console.log('[1] 结构')
ok('以 #cloud-config 开头', yaml.startsWith('#cloud-config\n'))
ok('含 write_files', yaml.includes('write_files:'))
ok('含 runcmd', yaml.includes('runcmd:'))
ok('内核配置写进 /etc/skylink/', yaml.includes('/etc/skylink/kernel.json'))
ok('凭据文件权限 0600', /path: \/etc\/skylink\/codex-credentials\.json[\s\S]{0,80}permissions: '0600'/.test(yaml))
ok('systemd 单元存在', yaml.includes('/etc/systemd/system/skylink-kernel.service'))
ok('systemd 有 Restart=always', yaml.includes('Restart=always'))
ok('runcmd 启用了服务', yaml.includes('enable') && yaml.includes('--now'))
ok('hostname 正确写入', yaml.includes('hostname: ip-10-0-1-11'))

// token 必须出现在配置里，且不能出现在不该出现的地方
ok('token 写进了内核配置', yaml.includes(TOKEN))
ok('token 没有写进 systemd 单元命令行',
  !/ExecStart=[^\n]*aaaaaaaa/.test(yaml))

// ── 2. YAML 解析
console.log('\n[2] YAML 解析（python3 + yaml）')
const tmp = '/tmp/kvm-bootstrap-check.yaml'
fs.writeFileSync(tmp, yaml)
let parsed = null
try {
  const out = execFileSync('python3', ['-c', `
import yaml, json, sys
d = yaml.safe_load(open(${JSON.stringify(tmp)}))
print(json.dumps({
  "keys": list(d.keys()),
  "files": [{"path": f.get("path"), "permissions": str(f.get("permissions")), "size": len(f.get("content",""))} for f in d.get("write_files", [])],
  "runcmd": d.get("runcmd"),
}))
`], { encoding: 'utf8', timeout: 30_000 })
  parsed = JSON.parse(out)
} catch (error) {
  ok('YAML 可解析', false, String(error?.message || error).slice(0, 120))
}
if (parsed) {
  ok('YAML 可解析', true)
  ok('write_files 有 3 个条目', parsed.files.length === 3, `${parsed.files.length} 个`)
  ok('三个文件路径都正确',
    parsed.files.map((f) => f.path).sort().join(',') ===
    ['/etc/skylink/codex-credentials.json', '/etc/skylink/kernel.json', '/etc/systemd/system/skylink-kernel.service'].sort().join(','),
    parsed.files.map((f) => f.path).join(','))
  ok('凭据文件权限是 0600',
    parsed.files.find((f) => f.path.endsWith('codex-credentials.json'))?.permissions === '0600')
  ok('文件内容非空', parsed.files.every((f) => f.size > 0))
  ok('runcmd 是列表', Array.isArray(parsed.runcmd), typeof parsed.runcmd)
}

// ── 3. cloud-init 官方 schema
console.log('\n[3] cloud-init schema')
let hasCloudInit = false
try { execFileSync('which', ['cloud-init'], { encoding: 'utf8' }); hasCloudInit = true } catch { /* 未装 */ }
if (hasCloudInit) {
  try {
    const out = execFileSync('cloud-init', ['schema', '--config-file', tmp], {
      encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    ok('cloud-init schema 通过', /Valid cloud-config/i.test(out), out.trim().slice(0, 120))
  } catch (error) {
    const out = `${error?.stdout || ''}${error?.stderr || ''}`
    ok('cloud-init schema 通过', /Valid cloud-config/i.test(out), out.trim().slice(0, 200))
  }
} else {
  console.log('  ⊘ 宿主无 cloud-init，跳过（用 YAML 解析结果代替）')
}

// ── 4. 边界：没有 bootstrap 时不应生成 write_files
console.log('\n[4] 兼容性')
const plain = renderCloudInitUserData({ hostname: 'h', sshPublicKey: 'ssh-ed25519 AAAA x' })
ok('无 bootstrap 时不生成 write_files', !plain.includes('write_files:'))
ok('无 bootstrap 时仍有 runcmd', plain.includes('runcmd:'))
ok('无 bootstrap 时仍设置 hostname', plain.includes('hostnamectl'))

// ── 5. 离线模式
console.log('\n[5] 离线模式')
const offlineBs = buildKernelBootstrap({
  kernelSource: '/x/server.mjs', token: TOKEN, slots: 2, offline: true,
})
const offlineCmds = JSON.stringify(offlineBs.commands)
ok('离线模式不联网装 node', !offlineCmds.includes('nodesource'))
ok('离线模式仍有 daemon-reload', offlineCmds.includes('daemon-reload'))

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\n结论：KVM 槽位的 cloud-init 合法，内核能随 seed 盘送进客户机。')
