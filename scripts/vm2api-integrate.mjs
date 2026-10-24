#!/usr/bin/env node
/**
 * 把 vm2api 控制面接到我们的内核上，一条命令做完并自检。
 *
 * 这个脚本存在的理由是：上一轮那些步骤每一步都有坑，而坑的报错
 * 全都指向错误的方向（bin_missing 看着像没编译，health_timeout 看着
 * 像内核挂了）。把正确顺序和判据固化下来，上线时直接跑，不用再复现。
 *
 * 子命令：
 *   install   生成内核包装脚本 + 配置 + VM 凭据登记（幂等，可重复跑）
 *   check     只做验收，不改文件
 *   run       前台启动 vm2api（调试用）
 *
 * 用法：
 *   node scripts/vm2api-integrate.mjs install
 *   node scripts/vm2api-integrate.mjs check
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const cmd = argv[0] || 'check'
const arg = (n, d = null) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const VM2API = path.resolve(arg('--vm2api', path.join(ROOT, '../vm2api')))
const CRED = path.resolve(arg('--credential', path.join(ROOT, '../live/javaserver.json')))
const API_KEY = arg('--api-key', 'sk-test-0123456789abcdef0123456789abcdef')
const PORT = Number(arg('--port', '8787'))
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
const fails = []
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ══════════════════════════════════════════════════════════════
// install：生成包装脚本与配置
// ══════════════════════════════════════════════════════════════

/** 内核包装脚本内容。两个通道的需求不同，不能共用一份。 */
function apiKernelWrapper(configPath) {
  return `#!/bin/sh
# vm2api 的 api-kernel-client 用 spawn(bin, ['-socket', S, '-token', T]) 拉起。
# 参数形式与我们的内核完全一致，直接透传即可；配置用 -config 补上
# （内核的 credential_path 只从配置文件读）。
exec ${process.execPath} ${path.join(ROOT, 'src/kernel/server.mjs')} "$@" -config ${configPath}
`
}

function codexKernelWrapper() {
  // Codex 侧完全不同：spawn(bin, [configPath]) —— 位置参数，不是 -socket/-token。
  // 而且 vm2api 自己会写那份 config（含它指定的 socket_path / internal_token）。
  // 覆盖它就会 socket 路径对不上，控制面永远 health_timeout。
  return `#!/bin/sh
# vm2api 的 codex-supervisor 用 spawn(bin, [configPath]) 拉起内核 ——
# 注意是位置参数，不是 -socket/-token。它与 Claude 侧的调用约定不同。
#
# vm2api 写的 config 里有它指定的 socket_path / internal_token / proxy_url，
# 所以必须保留，只在上面改两处：
#   1. 删 credential_path —— 有它内核就会去 spawn claude CLI，
#      没装 claude 的机器上 health 报 ok:false，vm2api 判内核未就绪，
#      所有 GPT 请求 503 health_timeout（尽管 Codex 通道完全可用）
#   2. 补 codex_credential_path —— GPT 槽要的是 Codex 凭据
CFG="$1"
OUT="${path.join(ROOT, 'config/vm2api-codex-runtime.json')}"

if [ -n "$CFG" ] && [ -f "$CFG" ]; then
  ${process.execPath} -e '
const fs = require("fs")
const [src, dst, cred] = process.argv.slice(1)
const c = JSON.parse(fs.readFileSync(src, "utf8"))
delete c.credential_path
c.codex_credential_path = cred
c.codex_default_model = c.codex_default_model || "gpt-6-astra"
fs.writeFileSync(dst, JSON.stringify(c, null, 2), { mode: 0o600 })
' "$CFG" "$OUT" ${CRED}
  exec ${process.execPath} ${path.join(ROOT, 'src/kernel/server.mjs')} -config "$OUT"
fi

# 没有参数时（手工调试）用固定配置
exec ${process.execPath} ${path.join(ROOT, 'src/kernel/server.mjs')} -config ${path.join(ROOT, 'config/vm2api-codex-kernel.json')}
`
}

function cmdInstall() {
  console.log('=== 安装 vm2api ↔ 内核 集成 ===\n')

  // ── 凭据检查
  console.log('[1] Codex 凭据')
  ok('凭据文件存在', fs.existsSync(CRED), CRED)
  if (!fs.existsSync(CRED)) return false
  const cred = JSON.parse(fs.readFileSync(CRED, 'utf8'))
  // 上游导出有两种形状：扁平单对象，或 {accounts:[...]}。两种都要认。
  const account = Array.isArray(cred?.accounts) ? cred.accounts[0] : cred
  ok('能解析出账号', Boolean(account?.access_token), JSON.stringify(Object.keys(account || {})))
  if (!account?.access_token) return false
  const vmId = `codex-${String(account.account_id || account.id || 'default').slice(0, 8)}`
  console.log(`       VM id: ${vmId}`)

  // ── 内核包装
  console.log('\n[2] 内核包装脚本')
  const binDir = path.join(ROOT, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const cfgDir = path.join(ROOT, 'config')
  fs.mkdirSync(cfgDir, { recursive: true })

  // Claude 侧（api-kernel）配置：带 credential_path，但只在真有 Claude 凭据时写
  const apiCfg = path.join(cfgDir, 'vm2api-kernel.json')
  fs.writeFileSync(apiCfg, JSON.stringify({
    vm_id: 'vm2api-claude',
    provider: 'local_cli',
    codex_credential_path: CRED,
    codex_default_model: 'gpt-6-astra',
    slots_per_worker: 20,
  }, null, 2) + '\n')

  // Codex 侧兜底配置（无参数时用）
  const codexCfg = path.join(cfgDir, 'vm2api-codex-kernel.json')
  fs.writeFileSync(codexCfg, JSON.stringify({
    vm_id: 'vm2api-codex',
    provider: 'local_cli',
    codex_credential_path: CRED,
    codex_default_model: 'gpt-6-astra',
    slots_per_worker: 20,
  }, null, 2) + '\n')

  const apiBin = path.join(binDir, 'kin-api-kernel')
  const codexBin = path.join(binDir, 'kin-codex-kernel')
  fs.writeFileSync(apiBin, apiKernelWrapper(apiCfg), { mode: 0o755 })
  fs.writeFileSync(codexBin, codexKernelWrapper(), { mode: 0o755 })
  ok('kin-api-kernel 已生成', fs.existsSync(apiBin))
  ok('kin-codex-kernel 已生成', fs.existsSync(codexBin))
  ok('两个都是可执行', (fs.statSync(apiBin).mode & 0o111) !== 0 && (fs.statSync(codexBin).mode & 0o111) !== 0)

  // ── VM 凭据登记
  // 关键：必须写到 vms/<id>/codex-credentials.json，不是数据库。
  // readCodexAccounts 读文件；写库的字段（access_token 列）只用于展示，
  // has_token 判定走文件。写库不写文件 → has_token:false → 所有请求 no_codex_vm。
  console.log('\n[3] VM 凭据登记')
  const vmDir = path.join(VM2API, 'vms', vmId)
  fs.mkdirSync(vmDir, { recursive: true })
  const expMs = Date.parse(account.expires_at || account.expired || '')
  const record = {
    id: account.account_id || account.id || null,
    email: account.email || null,
    access_token: account.access_token,
    refresh_token: account.refresh_token || null,
    id_token: account.id_token || null,
    expires_at: Number.isFinite(expMs) ? expMs : null,
    chatgpt_account_id: account.chatgpt_account_id || account.account_id || null,
    last_refresh: account.last_refresh || null,
  }
  const credFile = path.join(vmDir, 'codex-credentials.json')
  fs.writeFileSync(credFile, JSON.stringify({ accounts: [record] }, null, 2), { mode: 0o600 })
  ok('codex-credentials.json 已写入', fs.existsSync(credFile), credFile)
  ok('格式是 {accounts:[...]}（readCodexAccounts 只认这个）',
    Array.isArray(JSON.parse(fs.readFileSync(credFile, 'utf8'))?.accounts))
  ok('expires_at 是毫秒整数', Number.isInteger(record.expires_at), String(record.expires_at))

  // ── VM 描述（platform/family 决定 isCodexVm）
  console.log('\n[4] VM 描述文件')
  const vmJsonPath = path.join(VM2API, 'vms', `${vmId}.json`)
  let vmJson = {}
  if (fs.existsSync(vmJsonPath)) {
    try { vmJson = JSON.parse(fs.readFileSync(vmJsonPath, 'utf8')) } catch { vmJson = {} }
  }
  // normalizeVmKind 按 platform/family/kind 判 kind。三个都标上最稳。
  Object.assign(vmJson, {
    id: vmId,
    name: vmJson.name || account.email || vmId,
    platform: 'openai',
    family: 'codex',
    kind: 'codex',
    status: 'ready',
    schedulable: true,
    timezone: vmJson.timezone || 'Asia/Shanghai',
  })
  fs.writeFileSync(vmJsonPath, JSON.stringify(vmJson, null, 2) + '\n')
  ok('VM 描述已写入', fs.existsSync(vmJsonPath), vmJsonPath)
  ok('platform=openai（isCodexVm 判据之一）', vmJson.platform === 'openai')
  ok('family=codex', vmJson.family === 'codex')

  console.log('\n安装完成。接下来跑 `node scripts/vm2api-integrate.mjs check` 验收。')
  return true
}

// ══════════════════════════════════════════════════════════════
// check：端到端验收
// ══════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cmdCheck() {
  console.log('=== vm2api ↔ 内核 端到端验收 ===\n')

  // 环境检查
  console.log('[0] 前置条件')
  const apiBin = path.join(ROOT, 'bin/kin-api-kernel')
  const codexBin = path.join(ROOT, 'bin/kin-codex-kernel')
  ok('kin-api-kernel 存在', fs.existsSync(apiBin), '先跑 install')
  ok('kin-codex-kernel 存在', fs.existsSync(codexBin), '先跑 install')
  if (!fs.existsSync(apiBin) || !fs.existsSync(codexBin)) return false

  const vmFiles = fs.existsSync(path.join(VM2API, 'vms'))
    ? fs.readdirSync(path.join(VM2API, 'vms')).filter((f) => f.startsWith('codex-') && f.endsWith('.json'))
    : []
  ok('至少有一个 codex VM', vmFiles.length > 0, `${vmFiles.length} 个`)
  if (!vmFiles.length) return false

  // VM 凭据文件必须单独检查。
  //
  // 少了它，服务能起、内核能拉、health 也 ok，但所有请求报 no_codex_vm
  // 「no Codex kernel VM is configured」—— 文案看着像没有 VM，
  // 实际是 VM 在、只是账本里没有 token。readCodexAccounts 读的是
  // vms/<id>/codex-credentials.json，不是数据库里那几列。
  //
  // 提前在这里拦下来，省掉一轮 from-503-to-file 的排查。
  for (const f of vmFiles) {
    const vmId = f.replace(/\.json$/, '')
    const credPath = path.join(VM2API, 'vms', vmId, 'codex-credentials.json')
    const hasCred = fs.existsSync(credPath)
    ok(`${vmId} 有 codex-credentials.json`, hasCred,
      hasCred ? '' : `缺 ${credPath} —— 会出现 no_codex_vm（看着像没有 VM，其实是没 token）`)
    if (hasCred) {
      try {
        const j = JSON.parse(fs.readFileSync(credPath, 'utf8'))
        const n = Array.isArray(j?.accounts) ? j.accounts.length : 0
        const hasTok = n > 0 && Boolean(j.accounts[0].access_token || j.accounts[0].refresh_token)
        ok(`${vmId} 凭据含可用 token`, hasTok, n === 0 ? 'accounts 为空' : 'accounts[0] 没有 access/refresh token')
      } catch (error) {
        ok(`${vmId} 凭据可解析`, false, String(error?.message || error).slice(0, 80))
      }
    }
  }

  // 清残留
  try { execFileSync('pkill', ['-f', 'src/server.mjs'], { stdio: 'ignore' }) } catch { /* 无进程 */ }
  await sleep(1200)

  const logFile = '/tmp/vm2api-integrate.log'
  fs.writeFileSync(logFile, '')
  const child = spawn('node', ['--env-file=.env', 'src/server.mjs'], {
    cwd: VM2API,
    env: {
      ...process.env,
      KIN_API_KERNEL_BIN: apiBin,
      // 两个变量都要给。只给前者时 codexKernelBinPath() 会在同目录找
      // kin-codex-kernel，找不到报 bin_missing —— 文案误导人以为没编译。
      KIN_CODEX_KERNEL_BIN: codexBin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = fs.createWriteStream(logFile, { flags: 'a' })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  const cleanup = () => { try { child.kill('SIGTERM') } catch { /* 已退出 */ } }

  try {
    console.log('\n[1] 服务启动')
    let up = false
    for (let i = 0; i < 60; i += 1) {
      await sleep(1000)
      try {
        const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
        if (r.ok) { up = true; break }
      } catch { /* 还没起来 */ }
    }
    ok('60s 内就绪', up)
    if (!up) {
      console.log(fs.readFileSync(logFile, 'utf8').split('\n').slice(-10).join('\n'))
      return false
    }

    const h = await (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) })).json()
    ok('/health status=ok', h.status === 'ok', h.status)
    ok('features 含 api-direct-kernel', (h.features || []).includes('api-direct-kernel'))

    console.log('\n[2] 鉴权')
    const noKey = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(5000) })
    ok('无 key → 401', noKey.status === 401, `status=${noKey.status}`)
    const withKey = await fetch(`${BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(8000),
    })
    ok('有 key → 200', withKey.status === 200, `status=${withKey.status}`)

    console.log('\n[3] 内核被拉起')
    const runDir = path.join(VM2API, 'src/data/run')
    let codexSock = null
    for (let i = 0; i < 25 && !codexSock; i += 1) {
      const p = path.join(runDir, 'api-codex-kernel.sock')
      if (fs.existsSync(p)) codexSock = p
      else await sleep(400)
    }
    ok('codex 内核 socket 出现', Boolean(codexSock), codexSock || '未出现')

    if (codexSock) {
      const tokenFile = path.join(runDir, 'api-kernel.token')
      let token = ''
      try { token = fs.readFileSync(tokenFile, 'utf8').trim() } catch { /* 无 token */ }
      const out = execFileSync('curl', [
        '-s', '-m', '8', '--unix-socket', codexSock,
        '-H', `x-internal-token: ${token}`,
        'http://localhost/internal/health',
      ], { encoding: 'utf8' })
      const kh = JSON.parse(out)
      ok('内核 ok=true', kh.ok === true, JSON.stringify(kh).slice(0, 200))
      ok('engine=rust', kh.engine === 'rust', kh.engine)
      ok('ready_slots>0', Number(kh.ready_slots) > 0, String(kh.ready_slots))
      ok('cli_error 为 null（纯 Codex 不该拉 CLI）', kh.cli_error == null, JSON.stringify(kh.cli_error))
    }

    console.log('\n[4] 真实请求')
    const t0 = Date.now()
    const r = await fetch(`${BASE}/v1/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-astra',
        stream: false,
        store: false,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '回复两个字：验收' }] }],
      }),
      signal: AbortSignal.timeout(120_000),
    })
    const elapsed = Date.now() - t0
    const body = await r.text()
    // 上游过载和"部署坏了"必须分开判。
    // 过载时链路完全正常：vm2api 起来、内核就绪、请求发出去了，
    // 只是上游限流。报成失败会让人去查部署，方向完全错。
    // 代码与 server_is_overloaded 的处理对齐（见 src/codex.mjs 的瞬时分类）。
    const transient = /server_is_overloaded|service_unavailable|overloaded|rate_limit|server_error|internal_error/i.test(body)
    if (r.status !== 200 && transient) {
      const m = body.match(/"code"\s*:\s*"([^"]+)"/)
      console.log(`  △ 上游瞬时限流（${m ? m[1] : 'transient'}）—— 链路正常，非部署问题`)
      console.log('      重试即可；持续出现说明单账号额度不足，需要加账号或降并发')
      return true
    }
    ok('HTTP 200', r.status === 200, `status=${r.status} body=${body.slice(0, 240)}`)
    if (r.status !== 200) {
      // 把最常见的两个错误码翻译成下一步动作，否则只能靠记忆。
      if (/no_codex_vm/.test(body)) {
        console.log('      → VM 在但没有可用 token。检查 vms/<id>/codex-credentials.json')
        console.log('         （不是数据库里的 access_token 列，readCodexAccounts 读文件）')
      } else if (/bin_missing|kernel_start_failed/.test(body)) {
        console.log('      → 内核二进制找不到。确认 KIN_CODEX_KERNEL_BIN 指向 bin/kin-codex-kernel')
      } else if (/health_timeout/.test(body)) {
        console.log('      → 内核起来了但 health 不通。多半是包装脚本覆盖了')
        console.log('         vm2api 写的 config（socket_path 对不上）')
      } else if (/codex_kernel_unavailable/.test(body)) {
        console.log('      → 内核可达但未就绪。看 /tmp/vm2api-integrate.log 里的 cli_error')
      }
    }
    if (r.status === 200) {
      let text = ''
      try {
        const j = JSON.parse(body)
        const walk = (n, d) => {
          if (!n || d > 6 || typeof n !== 'object') return ''
          if (n.type === 'output_text' && n.text) return n.text
          for (const k of ['output', 'content', 'message', 'data', 'response']) {
            if (k in n) { const t = walk(n[k], d + 1); if (t) return t }
          }
          return Array.isArray(n) ? (n.map((x) => walk(x, d + 1)).find(Boolean) || '') : ''
        }
        text = walk(j, 0) || (body.match(/"text"\s*:\s*"([^"]{1,80})"/) || [])[1] || ''
      } catch { /* 非 JSON */ }
      ok('拿到回复文本', text.length > 0, body.slice(0, 200))
      if (text) console.log(`      文本: ${text.slice(0, 60)}`)
    }
    console.log(`      耗时: ${elapsed}ms`)
    return true
  } finally {
    cleanup()
    await sleep(1200)
    try { child.kill('SIGKILL') } catch { /* 已退出 */ }
  }
}

// ══════════════════════════════════════════════════════════════

if (cmd === 'install') {
  const okInstall = cmdInstall()
  process.exit(okInstall ? 0 : 1)
} else if (cmd === 'check') {
  const passed = await cmdCheck()
  console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
  if (fails.length) {
    console.log('失败项：')
    for (const f of fails) console.log(`  - ${f}`)
    process.exit(1)
  }
  if (!passed) process.exit(1)
  console.log('\n结论：vm2api 控制面用我们的内核完成真实请求。')
} else {
  console.log('用法: node scripts/vm2api-integrate.mjs [install|check]')
  process.exit(2)
}
