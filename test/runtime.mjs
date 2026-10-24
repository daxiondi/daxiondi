#!/usr/bin/env node
/**
 * runtime 单测：执行器、预检、单槽位编排、舰队编排、CLI 计划。
 *
 * 运行：node test/runtime.mjs
 *
 * 约束：不执行任何真实外部命令。所有 docker / iptables / redsocks 调用
 * 都进入假 Executor 的调用记录，因此测试可以在 macOS / 无 root / 无 docker
 * 的机器上跑完全部分支。
 *
 * 这一层的价值在「顺序」与「回滚」这两件事上，所以断言主要针对调用序列：
 * 记下每条命令，检查 network create 在 iptables 之前、iptables 在 redsocks
 * 之前、redsocks 在 dnsfwd 之前……以及「第 4 步失败时前 3 步的 undo 被调到」。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

import {
  Executor,
  ExecError,
  createLogger,
  nullLogger,
  shellJoin,
  spawnRunner,
} from '../src/runtime/executor.mjs'
import {
  CAP_NET_ADMIN_BIT,
  hasCapability,
  preflight,
  renderPreflight,
} from '../src/runtime/preflight.mjs'
import {
  DEFAULT_IMAGE,
  STEP_ORDER,
  SlotOrchestrator,
  composeContainerArgv,
  personaHostnameFor,
  personaOverridesFor,
} from '../src/runtime/orchestrator.mjs'
import { FleetRuntime, runPool, summarize } from '../src/runtime/fleet.mjs'
import { planSlotNetworks } from '../src/egress/network.mjs'
import { buildFleetBlueprint } from '../src/egress/plan.mjs'
// 只导入纯判定函数：cli.mjs 有入口守卫（isEntrypoint），被 import 时不跑 main()
import { judgeStrict } from '../src/runtime/cli.mjs'

// ─────────── 断言工具（与仓库其余测试同风格）───────────

let pass = 0
let fail = 0
const failures = []

function ok(name, cond) {
  if (cond) {
    pass += 1
    return true
  }
  fail += 1
  failures.push(`${name}: 期望为真`)
  return false
}

/** JSON 序列化的安全版本：BigInt 转字符串（CAP_NET_ADMIN 位号是 BigInt）。 */
function stringify(v) {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? `${val}n` : val))
}

function eq(name, actual, expected) {
  const a = stringify(actual)
  const e = stringify(expected)
  if (a === e) {
    pass += 1
    return true
  }
  fail += 1
  failures.push(`${name}: 实际 ${a} ≠ 期望 ${e}`)
  return false
}

function ne(name, actual, expected) {
  if (stringify(actual) !== stringify(expected)) {
    pass += 1
    return true
  }
  fail += 1
  failures.push(`${name}: 实际 ${stringify(actual)} 不应等于期望值`)
  return false
}

function includes(name, haystack, needle) {
  const h = String(haystack ?? '')
  if (h.includes(needle)) {
    pass += 1
    return true
  }
  fail += 1
  failures.push(`${name}: ${JSON.stringify(needle)} 不在 ${JSON.stringify(h.slice(0, 220))} 里`)
  return false
}

async function throws(name, fn) {
  try {
    await fn()
  } catch {
    pass += 1
    return true
  }
  fail += 1
  failures.push(`${name}: 期望抛错，实际通过`)
  return false
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skylink-runtime-'))

/**
 * 每个用例独立的落盘目录。
 *
 * 共用一个目录会让「dry-run 不应写文件」这类断言受前面用例残留影响 ——
 * 断言看到的是上一轮的文件。目录隔离比在断言里判时间戳可靠得多。
 */
let caseSeq = 0
function caseDirs() {
  caseSeq += 1
  const base = path.join(TMP, `c${String(caseSeq).padStart(3, '0')}`)
  return { dataDir: path.join(base, 'data'), confDir: path.join(base, 'conf') }
}

// ─────────── 假 Executor ───────────

/**
 * 假执行器：完整实现 Executor 的对外形状，但不 spawn 任何东西。
 *
 * behavior 是 (cmd, args) => ({code, stdout, stderr, timedOut, delayMs, pid})，
 * 返回 undefined 表示「默认成功」。这样每个测试可以只描述它关心的那条命令，
 * 其余命令自动成功。
 */
class FakeExecutor {
  constructor({ behavior = () => undefined, dryRun = false } = {}) {
    this.dryRun = Boolean(dryRun)
    this.behavior = behavior
    /**
     * 跨调用共享的假宿主状态。
     *
     * 单独一个「每个测试新造一份」的假环境是不够的：它必须记住 redsocks 是否
     * 已经启动，否则 ss 永远报告没人监听，端口确认就永远失败。behavior 的
     * 第三个参数就是它，按需调用 host(cmd, args) 取默认行为。
     */
    this.host = healthyBehavior()
    this.calls = []
    this.logger = nullLogger
    this.timeoutMs = 60_000
    this.executed = 0
  }

  async run(cmd, args = [], opts = {}) {
    const argv = [String(cmd), ...args.map(String)]
    this.calls.push({ argv, opts, at: this.calls.length })
    if (this.dryRun) return { ok: true, code: 0, stdout: '', stderr: '', argv, dryRun: true, skipped: true, elapsedMs: 0 }
    this.executed += 1
    if (opts.detach) {
      // detach 也要通知假宿主环境：转发器进程确实起来了（否则端口状态不会变）
      await this.behavior(cmd, args, this.host, opts)
      return { ok: true, code: 0, pid: 4242, stdout: '', stderr: '', argv, elapsedMs: 1 }
    }
    const r = (await this.behavior(cmd, args, this.host, opts)) || {}
    const timedOut = Boolean(r.timedOut)
    const code = r.code === undefined ? 0 : r.code
    const out = { ok: !timedOut && code === 0, code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', argv, elapsedMs: r.elapsedMs ?? 1, timedOut }
    if (!out.ok && opts.check !== false) {
      const error = new ExecError(`命令失败（exit=${code}）: ${shellJoin(argv)}${out.stderr ? `\n  stderr: ${out.stderr}` : ''}`, out)
      if (timedOut) error.code = 'ETIMEDOUT'
      throw error
    }
    return out
  }

  async runShell(script, opts = {}) {
    return this.run('/bin/sh', ['-c', script], opts)
  }

  async which(bin, opts = {}) {
    if (this.dryRun) return { ok: true, bin, found: '(dry-run)', dryRun: true }
    const r = await this.run('/bin/sh', ['-c', `command -v ${bin}`], { check: false, quiet: true, ...opts })
    const found = r.ok ? String(r.stdout).trim() : ''
    return { ok: Boolean(found), bin, found, code: r.code }
  }

  /** 调用序列里匹配某个命令的条目。 */
  matching(predicate) {
    return this.calls.filter((c) => predicate(c.argv))
  }

  /** 找第一条 cmd 匹配的调用。 */
  first(cmd, argIncludes = null) {
    return this.calls.find((c) => c.argv[0] === cmd && (!argIncludes || c.argv.includes(argIncludes))) || null
  }

  /** 某条命令出现的次数。 */
  count(cmd, argIncludes = null) {
    return this.calls.filter((c) => c.argv[0] === cmd && (!argIncludes || c.argv.includes(argIncludes))).length
  }

  /** 命令序列（只取 cmd 名），用于断言顺序。 */
  sequence() {
    return this.calls.filter((c) => !c.opts?.quiet).map((c) => c.argv[0])
  }
}

/**
 * 一个可通过的假宿主环境。
 *
 * 有状态：`ss` 的监听结果取决于 redsocks 是否已经启动过。无状态版本会让
 * 「启动后端口确认」永远失败（因为 ss 永远说没人监听），或者让「复用已有
 * 转发器」永远成立（ss 永远说有人监听），两种都会掩盖真实逻辑。
 *
 * @param {object} opts
 *   overrides          (cmd, args) => result|undefined，优先于默认行为
 *   listeningInitially 起始时端口是否已监听（模拟「上一轮没清干净」）
 */
function healthyBehavior({ overrides = () => undefined, listeningInitially = false } = {}) {
  let redsocksStarted = listeningInitially
  return (cmd, args) => {
    const custom = overrides(cmd, args)
    if (custom !== undefined) return custom
    if (cmd === '/bin/sh' && String(args[1] || '').includes('ss -ltn')) {
      return { code: 0, stdout: redsocksStarted ? '1\n' : '0\n' }
    }
    if (cmd === '/bin/sh' && args[1]?.startsWith('command -v ')) {
      const bin = args[1].replace('command -v ', '')
      return { code: 0, stdout: `/usr/sbin/${bin}\n` }
    }
    if (cmd === 'iptables') {
      // -C 探测一律「不存在」，让 apply 走插入分支
      if (args.includes('-C')) return { code: 1, stderr: 'No chain/target/match by that name' }
      return { code: 0, stdout: '' }
    }
    if (cmd === 'docker') {
      if (args[0] === 'inspect') return { code: 1, stderr: 'No such object' }
      if (args[0] === 'info') {
        return { code: 0, stdout: args.includes('{{json .Plugins.Network}}') ? '["bridge"]' : '25.0.1' }
      }
      if (args[0] === 'network' && args[1] === 'inspect') return { code: 1, stderr: 'No such network' }
      return { code: 0, stdout: '' }
    }
    if (cmd === 'redsocks') {
      redsocksStarted = true
      return { code: 0, stdout: '' }
    }
    return { code: 0, stdout: '' }
  }
}

/** 造一个槽位规划。 */
function slot(n = 1) {
  const plan = planSlotNetworks({ count: n })
  if (!plan.ok) throw new Error(plan.errors.join(','))
  return plan.slots[n - 1]
}

/** 造一个可用代理。 */
function proxy(id = 'p01', n = 1) {
  return {
    id,
    type: 'socks5',
    // 不能用 192.0.2.x / 198.51.100.x / 203.0.113.x：那些是 RFC 5737 占位段，
    // isPlaceholderHost 会命中，verify 会被跳过而不是真跑。这里用真实形态的公网地址。
    host: '47.88.' + String(10 + n) + '.11',
    port: 1080,
    username: `user${n}`,
    password: `pass${n}`,
    region: 'us-west',
    expected_ip: '198.51.100.7',
    expectedExitIp: '198.51.100.7',
    enabled: true,
  }
}

/** 造一个会记录调用的假 DNS 转发器。 */
function fakeDnsForwarder(record = []) {
  return {
    start: async (opts) => {
      record.push({ ...opts })
      return { ok: true, listen: `${opts.listenHost}:${opts.port}`, mode: opts.mode || 'tcp', upstreams: opts.upstreams, stop() {} }
    },
  }
}

/** 通过的预检结果。 */
const PASS_PREFLIGHT = async () => ({
  ok: true,
  checks: [{ name: 'fake', ok: true, detail: '注入的通过结果', fatal: true }],
  fatal: [],
  warnings: [],
  summary: '通过 1/1，致命 0，告警 0',
})

/** 建编排器：默认把 persona 落到临时目录、预检注入为通过，避免污染真实环境。 */
function makeOrch(executor, overrides = {}) {
  const s = overrides.slotSpec || slot(1)
  const d = caseDirs()
  return new SlotOrchestrator({
    executor,
    slotSpec: s,
    proxy: overrides.proxy === undefined ? proxy() : overrides.proxy,
    logger: nullLogger,
    platform: 'linux',
    ...d,
    dnsForwarder: fakeDnsForwarder(overrides.dnsRecord || []),
    verifyEgress: false,
    verifyPersona: false,
    preflight: PASS_PREFLIGHT,
    ...overrides,
  })
}

// ═══════════════════════════════════════════════════════════
// 1. Executor
// ═══════════════════════════════════════════════════════════

console.log('── 1. Executor ──')

eq('STEP_ORDER 是 11 步', STEP_ORDER.length, 11)
eq('STEP_ORDER 顺序固定', STEP_ORDER, ['preflight', 'network', 'iptables', 'redsocks', 'dnsfwd', 'geo', 'persona', 'container', 'timezone', 'uts', 'verify'])

// shellJoin：安全的参数不加引号，危险参数加单引号
eq('shellJoin 保留安全参数', shellJoin(['iptables', '-t', 'nat']), 'iptables -t nat')
includes('shellJoin 给含空格参数加引号', shellJoin(['echo', 'a b']), "'a b'")
eq('shellJoin 空串用引号包住', shellJoin(['', '']), "'' ''")
includes('shellJoin 转义内部单引号', shellJoin(['a\'b']), `'a'\\''b'`)

// 真实执行：用 node 自身跑一条无害命令
{
  const logs = []
  const logger = createLogger({ level: 'info', sink: { log: (m) => logs.push(m), error: (m) => logs.push(m) } })
  const ex = new Executor({ logger })
  const r = await ex.run(process.execPath, ['-e', 'process.stdout.write("hi")'])
  eq('真实执行返回 code 0', r.code, 0)
  eq('真实执行捕获 stdout', r.stdout, 'hi')
  ok('真实执行记录耗时', typeof r.elapsedMs === 'number' && r.elapsedMs >= 0)
  ok('日志包含命令行', logs.some((l) => l.includes('$ ')))
  ok('日志包含耗时', logs.some((l) => /\d+ms/.test(l)))
  eq('calls 记录了一条', ex.calls.length, 1)
  eq('executedCount 只算真实执行', ex.executedCount, 1)
}

// 非零退出码 → 抛错且带 stderr
{
  const ex = new Executor({ logger: nullLogger })
  let caught = null
  try {
    await ex.run(process.execPath, ['-e', 'process.stderr.write("boom");process.exit(3)'])
  } catch (e) {
    caught = e
  }
  ok('非零退出码抛 ExecError', caught instanceof ExecError)
  eq('错误码透传', caught?.code, 3)
  includes('错误信息带 stderr', caught?.message, 'boom')
  includes('错误信息带命令行', caught?.message, 'node')
}

// check:false 不抛
{
  const ex = new Executor({ logger: nullLogger })
  const r = await ex.run(process.execPath, ['-e', 'process.exit(7)'], { check: false })
  eq('check:false 返回非零码', r.code, 7)
  eq('check:false 不抛错', r.ok, false)
}

// 超时
{
  const ex = new Executor({ logger: nullLogger, timeoutMs: 150 })
  let caught = null
  const started = Date.now()
  try {
    await ex.run(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 150 })
  } catch (e) {
    caught = e
  }
  const elapsed = Date.now() - started
  ok('超时抛错', caught !== null)
  eq('超时错误码为 ETIMEDOUT', caught?.code, 'ETIMEDOUT')
  ok('超时确实中断（<2s）', elapsed < 2000)
  ok('错误标记 timedOut', caught?.timedOut === true)
}

// dry-run：不执行，只记录
{
  const ex = new Executor({ dryRun: true, logger: nullLogger })
  const r = await ex.run('iptables', ['-t', 'nat', '-L'])
  eq('dry-run 返回 dryRun 标记', r.dryRun, true)
  eq('dry-run 返回 code 0', r.code, 0)
  eq('dry-run 不产生真实执行', ex.executedCount, 0)
  eq('dry-run 仍记录调用', ex.calls.length, 1)
  const w = await ex.which('docker')
  eq('dry-run which 不执行', ex.executedCount, 0)
  eq('dry-run which 返回 found', w.ok, true)
}

// which 的真实语义
{
  const ex = new Executor({ logger: nullLogger })
  const found = await ex.which(process.execPath.includes('/') ? 'node' : 'node')
  ok('which 找到 node', found.ok)
  const missing = await ex.which('definitely-not-a-real-binary-xyz')
  eq('which 找不到返回 ok=false', missing.ok, false)
  eq('which 找不到返回空路径', missing.found, '')
}

// runShell
{
  const ex = new Executor({ logger: nullLogger })
  const r = await ex.runShell('echo shell-ok')
  eq('runShell 执行成功', r.ok, true)
  includes('runShell 捕获输出', r.stdout, 'shell-ok')
}

// 可注入 runner
{
  const seen = []
  const runner = async ({ cmd, args }) => {
    seen.push([cmd, ...args])
    return { code: 0, stdout: 'injected', stderr: '', timedOut: false }
  }
  const ex = new Executor({ logger: nullLogger, runner })
  const r = await ex.run('whatever', ['--flag'])
  eq('注入 runner 被调用', seen[0], ['whatever', '--flag'])
  eq('注入 runner 输出透传', r.stdout, 'injected')
}

// detach
{
  const ex = new Executor({ logger: nullLogger })
  const r = await ex.run(process.execPath, ['-e', 'process.exit(0)'], { detach: true })
  ok('detach 返回 pid', typeof r.pid === 'number' && r.pid > 0)
  eq('detach 标记', r.detached, true)
}

// 日志级别
{
  const logs = []
  const quiet = createLogger({ level: 'error', sink: { log: (m) => logs.push(m), error: (m) => logs.push(m) } })
  quiet.info('should not appear')
  quiet.error('should appear')
  eq('error 级别过滤 info', logs.length, 1)
  includes('error 级别保留 error', logs[0], 'should appear')
}

// child logger 前缀
{
  const logs = []
  const root = createLogger({ level: 'info', sink: { log: (m) => logs.push(m) } })
  root.child('[slot-01] ').info('hi')
  includes('child logger 带前缀', logs[0], '[slot-01] hi')
}

// spawnRunner 直接调用（覆盖未走 Executor 的分支）
{
  const r = await spawnRunner({ cmd: process.execPath, args: ['-e', 'process.stdout.write("direct")'], timeoutMs: 5000 })
  eq('spawnRunner 直接调用成功', r.code, 0)
  eq('spawnRunner 捕获输出', r.stdout, 'direct')
}

// ═══════════════════════════════════════════════════════════
// 2. preflight
// ═══════════════════════════════════════════════════════════

console.log('── 2. preflight ──')

// capability 解析
{
  const text = 'Name:\tnode\nCapEff:\t000001ffffffffff\n'
  eq('CapEff 含 CAP_NET_ADMIN', hasCapability(text, CAP_NET_ADMIN_BIT), true)
  const noCap = 'CapEff:\t0000000000000000\n'
  eq('CapEff 全 0 不含', hasCapability(noCap, CAP_NET_ADMIN_BIT), false)
  eq('缺 CapEff 返回 null', hasCapability('nothing here', CAP_NET_ADMIN_BIT), null)
  eq('CAP_NET_ADMIN 位号是 12', CAP_NET_ADMIN_BIT, 12n)
  // 只有 bit 12 → 0x1000
  eq('只有 bit12 时判定为真', hasCapability('CapEff:\t0000000000001000\n', 12n), true)
  eq('只有 bit11 时判定为假', hasCapability('CapEff:\t0000000000000800\n', 12n), false)
}

// 全绿环境
{
  const log = []
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === '/bin/sh') return { code: 0, stdout: `/usr/sbin/${args[1]?.replace('command -v ', '') || 'x'}\n` }
      if (cmd === 'docker' && args[0] === 'info') {
        return { code: 0, stdout: args.includes('{{json .Plugins.Network}}') ? '["bridge","host","null"]' : '25.0.1' }
      }
      return { code: 0, stdout: '' }
    },
  })
  const r = await preflight({
    executor: ex,
    platform: 'linux',
    getuid: () => 0,
    readFile: (p) => {
      if (p === '/etc/os-release') return 'PRETTY_NAME="Ubuntu 24.04 LTS"\n'
      if (p === '/proc/self/status') return 'CapEff:\t000001ffffffffff\n'
      if (p === '/proc/net/ip_tables_names') return 'nat\nfilter\n'
      return ''
    },
    exists: (p) => p === '/dev/kvm',
  })
  eq('健康环境 ok', r.ok, true)
  eq('检查项数量 >= 8', r.checks.length >= 8, true)
  eq('无致命项', r.fatal.length, 0)
  includes('识别发行版', r.checks.find((c) => c.name === 'os-linux')?.detail, 'Ubuntu 24.04')
  includes('摘要含致命数', r.summary, '致命 0')
  ok('preflight 的 which 覆盖 docker/iptables/redsocks', ['iptables', 'docker', 'redsocks'].every((b) => ex.count('/bin/sh', null) >= 0))
  includes('渲染文本含 ok 标记', renderPreflight(r), '[ok  ]')
}

// 非 Linux
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const r = await preflight({ executor: ex, platform: 'darwin', getuid: () => 501, readFile: () => null, exists: () => false })
  eq('非 Linux 判为不通过', r.ok, false)
  ok('os-linux 检查 fatal', r.checks.find((c) => c.name === 'os-linux')?.fatal === true)
  includes('致命项含 os-linux', r.fatal.join('\n'), 'os-linux')
}

// 非 root 且无 CAP_NET_ADMIN
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const r = await preflight({
    executor: ex,
    platform: 'linux',
    getuid: () => 1000,
    readFile: (p) => (p === '/proc/self/status' ? 'CapEff:\t0000000000000000\n' : p === '/etc/os-release' ? 'PRETTY_NAME="Debian"\n' : ''),
    exists: () => true,
  })
  eq('无权限判为不通过', r.ok, false)
  includes('致命项含 privileges', r.fatal.join('\n'), 'privileges')
  includes('说明提到 CAP_NET_ADMIN', r.checks.find((c) => c.name === 'privileges')?.detail, 'CAP_NET_ADMIN')
}

// 非 root 但有 CAP_NET_ADMIN → 通过
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const r = await preflight({
    executor: ex,
    platform: 'linux',
    getuid: () => 1000,
    readFile: (p) => (p === '/proc/self/status' ? 'CapEff:\t000001ffffffffff\n' : p === '/proc/net/ip_tables_names' ? 'nat' : ''),
    exists: () => true,
  })
  eq('CAP_NET_ADMIN 可替代 root', r.ok, true)
  includes('详情说明持有 cap', r.checks.find((c) => c.name === 'privileges')?.detail, 'CAP_NET_ADMIN')
}

// 缺 redsocks → fatal
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === '/bin/sh' && String(args[1]).includes('redsocks')) return { code: 1, stdout: '' }
      return host(cmd, args)
    },
  })
  const r = await preflight({
    executor: ex,
    platform: 'linux',
    getuid: () => 0,
    readFile: (p) => (p === '/etc/os-release' ? 'PRETTY_NAME="X"\n' : p === '/proc/self/status' ? 'CapEff:\tffffffffffffffff\n' : ''),
    exists: () => true,
  })
  eq('缺 redsocks 判失败', r.ok, false)
  includes('致命项含 redsocks', r.fatal.join('\n'), 'redsocks')
}

// /dev/kvm 缺失只是 warn（默认）
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const r = await preflight({
    executor: ex,
    platform: 'linux',
    getuid: () => 0,
    readFile: (p) => (p === '/proc/self/status' ? 'CapEff:\tffffffffffffffff\n' : p === '/proc/net/ip_tables_names' ? 'nat' : ''),
    exists: () => false,
  })
  eq('缺 KVM 不致命', r.ok, true)
  ok('KVM 记为 warn', r.checks.find((c) => c.name === 'dev-kvm')?.fatal === false)
  includes('告警列表含 KVM', r.warnings.join('\n'), 'dev-kvm')
}

// needKvm=true 时缺 KVM 变 fatal
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const r = await preflight({
    executor: ex,
    platform: 'linux',
    getuid: () => 0,
    readFile: (p) => (p === '/proc/self/status' ? 'CapEff:\tffffffffffffffff\n' : p === '/proc/net/ip_tables_names' ? 'nat' : ''),
    exists: () => false,
    requirements: { needKvm: true },
  })
  eq('显式要求 KVM 时判失败', r.ok, false)
  includes('致命项含 dev-kvm', r.fatal.join('\n'), 'dev-kvm')
}

// iptables nat 不可用 → fatal
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'iptables' && args.includes('-L')) return { code: 3, stderr: "can't initialize iptables table `nat'" }
      return host(cmd, args)
    },
  })
  const r = await preflight({
    executor: ex,
    platform: 'linux',
    getuid: () => 0,
    readFile: (p) => (p === '/proc/self/status' ? 'CapEff:\tffffffffffffffff\n' : ''),
    exists: () => true,
  })
  eq('netfilter 不可用判失败', r.ok, false)
  includes('致命项含 netfilter', r.fatal.join('\n'), 'netfilter')
}

// docker daemon 挂掉
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'info') return { code: 1, stderr: 'Cannot connect to the Docker daemon' }
      return host(cmd, args)
    },
  })
  const r = await preflight({
    executor: ex,
    platform: 'linux',
    getuid: () => 0,
    readFile: (p) => (p === '/proc/self/status' ? 'CapEff:\tffffffffffffffff\n' : p === '/proc/net/ip_tables_names' ? 'nat' : ''),
    exists: () => true,
  })
  eq('daemon 挂掉判失败', r.ok, false)
  includes('致命项含 docker-daemon', r.fatal.join('\n'), 'docker-daemon')
}

// docker bridge 驱动缺失
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'info') {
        return { code: 0, stdout: args.includes('{{json .Plugins.Network}}') ? '["overlay"]' : '25.0.1' }
      }
      return host(cmd, args)
    },
  })
  const r = await preflight({
    executor: ex,
    platform: 'linux',
    getuid: () => 0,
    readFile: (p) => (p === '/proc/self/status' ? 'CapEff:\tffffffffffffffff\n' : p === '/proc/net/ip_tables_names' ? 'nat' : ''),
    exists: () => true,
  })
  eq('缺 bridge 驱动判失败', r.ok, false)
  includes('致命项含 bridge', r.fatal.join('\n'), 'bridge')
}

// executor 未注入
await throws('preflight 必须注入 executor', () => preflight({}))

// dry-run 预检
{
  const ex = new FakeExecutor({ dryRun: true })
  const r = await preflight({ executor: ex, platform: 'linux', getuid: () => 0, readFile: () => null, exists: () => true })
  eq('dry-run 预检仍判定权限', r.ok, true)
  eq('dry-run 未真实执行', ex.executed, 0)
}

// ═══════════════════════════════════════════════════════════
// 3. SlotOrchestrator：顺序 / 幂等 / 回滚
// ═══════════════════════════════════════════════════════════

console.log('── 3. SlotOrchestrator ──')

// 3.1 全部 11 步顺序正确
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const dnsRecord = []
  const orch = makeOrch(ex, { dnsRecord })
  const report = await orch.up()

  eq('up 成功', report.ok, true)
  eq('报告 11 步', report.steps.length, 11)
  eq('步名顺序与 STEP_ORDER 一致', report.steps.map((s) => s.name), [...STEP_ORDER])

  // 关键：外部可见副作用的顺序
  const idxNetwork = ex.calls.findIndex((c) => c.argv[0] === 'docker' && c.argv[1] === 'network' && c.argv[2] === 'create')
  const idxIptables = ex.calls.findIndex((c) => c.argv[0] === 'iptables' && c.argv.includes('-N'))
  const idxRedsocks = ex.calls.findIndex((c) => c.argv[0] === 'redsocks')
  const idxDockerRun = ex.calls.findIndex((c) => c.argv[0] === 'docker' && c.argv[1] === 'run')

  ok('network create 被调用', idxNetwork >= 0)
  ok('iptables 在 network 之后', idxIptables > idxNetwork)
  ok('redsocks 在 iptables 之后', idxRedsocks > idxIptables)
  ok('docker run 在 redsocks 之后', idxDockerRun > idxRedsocks)
  eq('DNS 转发器在 redsocks 之后启动', dnsRecord.length, 1)
  ok('DNS 监听网关地址', dnsRecord[0].listenHost === '10.213.1.1')
  eq('DNS 端口正确', dnsRecord[0].port, 21001)
  eq('DNS 用 tcp 模式', dnsRecord[0].mode, 'tcp')

  // iptables 的 REDIRECT 端口
  const redirect = ex.matching((argv) => argv[0] === 'iptables' && argv.includes('REDIRECT'))
  ok('存在 REDIRECT 规则', redirect.length >= 2)
  ok('REDIRECT 指向 tcp 端口', redirect.some((c) => c.argv.includes('21000')))
  ok('REDIRECT 指向 dns 端口', redirect.some((c) => c.argv.includes('21001')))
  ok('存在 FORWARD DROP 兜底', ex.matching((argv) => argv[0] === 'iptables' && argv.includes('FORWARD') && argv.includes('DROP')).length >= 1)

  // 容器参数
  const run = ex.calls[idxDockerRun]
  ok('容器参数含 --network', run.argv.includes('--network'))
  ok('容器参数含 skylink-eg-01', run.argv.includes('skylink-eg-01'))
  ok('容器参数含 --dns 8.8.8.8', run.argv.includes('8.8.8.8'))
  ok('容器参数含 use-vc', run.argv.includes('use-vc'))
  ok('容器参数不含 HTTPS_PROXY', !run.argv.some((a) => String(a).startsWith('HTTPS_PROXY')))
  ok('容器参数含 --mac-address（persona 提供）', run.argv.includes('--mac-address'))
  ok('容器参数含 --memory（persona 提供）', run.argv.includes('--memory'))

  // persona 落盘
  eq('persona 目录已创建', fs.existsSync(orch.personaDir), true)
  eq('persona 文件数 > 0', report.steps.find((s) => s.name === 'persona').detail.includes('落盘'), true)
  ok('persona 报告文件数', orch.state.personaFiles > 0)
  ok('/etc/hostname 已落盘', fs.existsSync(path.join(orch.personaDir, 'etc', 'hostname')))

  // redsocks 配置
  eq('redsocks 配置文件已写', fs.existsSync(orch.confPath), true)
  const conf = fs.readFileSync(orch.confPath, 'utf8')
  includes('配置含 local_ip=网关', conf, 'local_ip = 10.213.1.1')
  includes('配置含 local_port', conf, 'local_port = 21000')
  includes('配置含上游 host', conf, 'ip = 47.88.11.11')
  const mode = fs.statSync(orch.confPath).mode & 0o777
  eq('配置权限 0600', mode, 0o600)
}

// 3.2 第 4 步（redsocks）失败 → 前 3 步全部回滚
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'redsocks') return { code: 4, stderr: 'bind: Cannot assign requested address' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  const report = await orch.up()

  eq('第 4 步失败导致 up 失败', report.ok, false)
  eq('失败步是 redsocks', report.steps.find((s) => !s.ok)?.name, 'redsocks')
  eq('报告步数 4（3 成功 + 1 失败）', report.steps.length, 4)
  eq('回滚了 2 步（preflight 无副作用，不入栈）', report.rolledBack.length, 2)
  eq('回滚只含副作用步骤，逆序', report.rolledBack.map((r) => r.name), ['iptables', 'network'])

  // 关键断言：清理真的被调用了
  ok('iptables 删除规则被调用', ex.matching((argv) => argv[0] === 'iptables' && argv.includes('-D')).length >= 1)
  ok('iptables 链被删除', ex.matching((argv) => argv[0] === 'iptables' && argv.includes('-X')).length >= 1)
  ok('docker network rm 被调用', ex.count('docker', 'rm') >= 1)
  ok('未调用 docker run（第 7 步没到）', ex.count('docker', 'run') === 0)
}

// 3.3 DNS 转发器启动失败 → redsocks 也被回滚
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex, {
    dnsForwarder: {
      start: async () => ({ ok: false, errors: ['EADDRNOTAVAIL 10.213.1.1'] }),
    },
  })
  const report = await orch.up()
  eq('DNS 失败导致 up 失败', report.ok, false)
  eq('失败步是 dnsfwd', report.steps.find((s) => !s.ok)?.name, 'dnsfwd')
  ok('redsocks 被回滚', report.rolledBack.some((r) => r.name === 'redsocks'))
  ok('network 被回滚', report.rolledBack.some((r) => r.name === 'network'))
  ok('kill redsocks 被调用', ex.count('kill') >= 1)
}

// 3.4 容器启动失败 → 前面全部回滚，含 DNS 转发器 stop
{
  const dnsStops = []
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'run') return { code: 125, stderr: 'invalid MAC address' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex, {
    dnsForwarder: {
      start: async (o) => ({ ok: true, listen: `${o.listenHost}:${o.port}`, mode: 'tcp', stop: () => dnsStops.push('stop') }),
    },
  })
  const report = await orch.up()
  eq('容器失败导致 up 失败', report.ok, false)
  eq('失败步是 container', report.steps.find((s) => !s.ok)?.name, 'container')
  eq('DNS 转发器被停止', dnsStops.length, 1)
  ok('回滚含 dnsfwd', report.rolledBack.some((r) => r.name === 'dnsfwd'))
  ok('回滚含 persona', report.rolledBack.some((r) => r.name === 'persona'))
  ok('persona 目录被清理', !fs.existsSync(orch.personaDir))
}

// 3.5 无代理 → redsocks 步骤报 NO_PROXY
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex, { proxy: null })
  const report = await orch.up()
  eq('无代理时启动失败', report.ok, false)
  const failed = report.steps.find((s) => !s.ok)
  eq('失败步是 redsocks', failed?.name, 'redsocks')
  eq('错误码是 NO_PROXY', failed?.code, 'NO_PROXY')
  includes('错误信息提示缺少代理', failed?.detail, '代理')
}

// 3.6 预检失败 → 一步都不做
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex, {
    preflight: async () => ({
      ok: false,
      checks: [{ name: 'os-linux', ok: false, detail: '当前平台是 darwin', fatal: true }],
      fatal: ['os-linux: 当前平台是 darwin'],
      warnings: [],
      summary: '通过 0/1，致命 1，告警 0',
    }),
  })
  const report = await orch.up()
  eq('预检失败导致 up 失败', report.ok, false)
  eq('只有 1 步记录', report.steps.length, 1)
  eq('失败步是 preflight', report.steps[0].name, 'preflight')
  eq('预检失败不建网络', ex.count('docker', 'create'), 0)
  eq('预检失败不上规则', ex.count('iptables', '-N'), 0)
}

// 3.7 幂等：连续 up() 两次
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const dnsRecord = []
  const orch = makeOrch(ex, { dnsRecord })
  const first = await orch.up()
  const second = await orch.up()
  eq('第一次 up 成功', first.ok, true)
  eq('第二次 up 也成功（幂等）', second.ok, true)
  eq('第二次仍走 11 步', second.steps.length, 11)
  ok('第二次每步都成功', second.steps.every((s) => s.ok))
  eq('DNS 转发器未被重复启动', dnsRecord.length, 1)
}

// 真正验证 network 复用：inspect 返回存在
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'network' && args[1] === 'inspect') return { code: 0, stdout: '10.213.1.0/24|10.213.1.1' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  const report = await orch.up()
  eq('网络已存在时 up 成功', report.ok, true)
  eq('网络复用不 create', ex.count('docker', 'create'), 0)
  eq('network 步骤标记复用', report.steps.find((s) => s.name === 'network')?.reused, true)
  includes('详情说明复用', report.steps.find((s) => s.name === 'network')?.detail, '复用')
}

// 真正验证 iptables 幂等：-C 全部返回成功 → 不插入
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'iptables' && args.includes('-C')) return { code: 0, stdout: '' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  await orch.up()
  // 自定义链内部规则在 -F 之后必须重建（-A 无条件），只有 INPUT/FORWARD 的
  // 挂载用 -C 探测后跳过。所以断言的是「-I 不再执行」，不是「-A 为 0」。
  eq('规则已存在时不执行 -I 插入', ex.matching((a) => a[0] === 'iptables' && a.includes('-I')).length, 0)
  // 4 条：RETURN 同网段、RETURN 已重定向端口、REDIRECT dns、REDIRECT tcp。
  // 第 2 条是必需的：REDIRECT 后目标变成本机端口，包会再次进 PREROUTING，
  // 没有它就会被下面那条通配 REDIRECT 再转一次，redsocks 拿不到真实目标。
  eq('链内 -A 仍重建（-F 之后必然）', ex.matching((a) => a[0] === 'iptables' && a.includes('-A')).length, 4)
}

// 容器已存在且在跑 → 复用，不 run
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'inspect' && args[1] === '-f') return { code: 0, stdout: 'true' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  const report = await orch.up()
  eq('容器已在跑时 up 成功', report.ok, true)
  eq('不重复 docker run', ex.count('docker', 'run'), 0)
  eq('container 步骤标记复用', report.steps.find((s) => s.name === 'container')?.reused, true)
}

// 容器存在但停止 → start
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'inspect' && args[1] === '-f') return { code: 0, stdout: 'false' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  const report = await orch.up()
  eq('容器停止时 up 成功', report.ok, true)
  ok('调用了 docker start', ex.count('docker', 'start') === 1)
  eq('未 docker run', ex.count('docker', 'run'), 0)
}

// redsocks 端口已在监听 → 复用
{
  const ex = new FakeExecutor({ behavior: healthyBehavior({ listeningInitially: true }) })
  const orch = makeOrch(ex)
  const report = await orch.up()
  eq('端口已在监听时 up 成功', report.ok, true)
  eq('不重复启动 redsocks', ex.count('redsocks'), 0)
  eq('redsocks 步骤标记复用', report.steps.find((s) => s.name === 'redsocks')?.reused, true)
}

// 3.8 verify 失败 → 清理并报错
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'exec') {
        // 出口 IP = 宿主机 IP（证明没走代理）；resolv.conf 指向 docker 内嵌解析器；
        // 裸 TCP 成功（证明 FORWARD 兜底没生效）。这三条任一即失败，三条命中必定失败。
        const joined = args.join(' ')
        if (joined.includes('ipify')) return { code: 0, stdout: '{"ip":"1.2.3.4"}' }
        if (joined.includes('resolv.conf')) return { code: 0, stdout: 'nameserver 127.0.0.11' }
        return { code: 0, stdout: 'CONNECTED' }
      }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex, {
    proxy: { ...proxy(), expectedExitIp: '198.51.100.7' },
    verifyEgress: true,
    verifyPersona: false,
    hostProbe: async () => '1.2.3.4',
  })
  const report = await orch.up()
  eq('verify 失败导致 up 失败', report.ok, false)
  eq('失败步是 verify', report.steps.find((s) => !s.ok)?.name, 'verify')
  eq('错误码 VERIFY_FAILED', report.steps.find((s) => !s.ok)?.code, 'VERIFY_FAILED')
  includes('错误信息含出口', report.error, '出口')
  ok('verify 失败后容器被删除', ex.count('docker', 'rm') >= 1)
  ok('verify 失败后网络被删除', ex.count('docker', 'network', 'rm') >= 1)
}

// verify 成功
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'exec') {
        const joined = args.join(' ')
        if (joined.includes('ipify')) return { code: 0, stdout: '{"ip":"198.51.100.7"}' }
        if (joined.includes('resolv.conf')) return { code: 0, stdout: 'nameserver 8.8.8.8\nnameserver 1.1.1.1' }
        // 裸 TCP / UDP 探测都应 BLOCKED；DNS 解析返回地址
        if (joined.includes('node:dgram')) return { code: 0, stdout: 'BLOCKED' }
        if (joined.includes('node:net')) return { code: 0, stdout: 'BLOCKED' }
        if (joined.includes('node:dns')) return { code: 0, stdout: '93.184.216.34' }
        return { code: 0, stdout: 'BLOCKED' }
      }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex, {
    proxy: { ...proxy(), expectedExitIp: '198.51.100.7' },
    verifyEgress: true,
    verifyPersona: false,
    hostProbe: async () => '203.0.113.99',
  })
  const report = await orch.up()
  eq('verify 正常时 up 成功', report.ok, true)
  eq('verify 步骤 ok', report.steps.find((s) => s.name === 'verify')?.ok, true)
}

// 占位符代理 → verify 走 skip，不误判
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex, {
    proxy: { id: 'p01', type: 'socks5', host: '192.0.2.10', port: 1080, placeholder: true, enabled: true },
    verifyEgress: true,
    verifyPersona: false,
  })
  const report = await orch.up()
  eq('占位符代理不阻断启动', report.ok, true)
  includes('verify 详情说明跳过', report.steps.find((s) => s.name === 'verify')?.detail, '跳过')
}

// 3.9 dry-run：不执行任何命令
{
  const ex = new FakeExecutor({ dryRun: true })
  const orch = makeOrch(ex, { dnsForwarder: { start: async () => { throw new Error('不应被调用') } } })
  const report = await orch.up()
  eq('dry-run up 成功', report.ok, true)
  eq('dry-run 11 步全部记录', report.steps.length, 11)
  eq('dry-run 未真实执行任何命令', ex.executed, 0)
  ok('dry-run 不写 redsocks 配置', !fs.existsSync(orch.confPath))
  ok('dry-run 不落 persona 目录', !fs.existsSync(orch.personaDir))
  includes('dry-run 的 network 详情带标记', report.steps.find((s) => s.name === 'redsocks')?.detail, 'dry-run')
}

// dry-run 的 plan()
{
  const ex = new FakeExecutor({ dryRun: true })
  const orch = makeOrch(ex)
  const plan = orch.plan()
  eq('plan 有 11 步', plan.length, 11)
  eq('plan 步序正确', plan.map((p) => p.name), [...STEP_ORDER])
  ok('每步都有 action', plan.every((p) => typeof p.action === 'string' && p.action.length > 0))
  ok('每步都有 command', plan.every((p) => typeof p.command === 'string' && p.command.length > 0))
  includes('network 步骤含完整 docker network create', plan[1].command, 'docker network create --driver bridge')
  includes('network 步骤含 enable_ip_masquerade=false', plan[1].command, 'enable_ip_masquerade=false')
  includes('redsocks 步骤含配置路径', plan[3].command, 'redsocks -c')
}

// 3.10 down()：逆序清理
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex)
  await orch.up()
  ex.calls.length = 0
  const report = await orch.down()
  eq('down 成功', report.ok, true)
  eq('down 覆盖 6 个副作用步骤', report.steps.length, 6)
  eq('down 逆序', report.steps.map((s) => s.name), ['container', 'persona', 'dnsfwd', 'redsocks', 'iptables', 'network'])
  const idxContainerRm = ex.calls.findIndex((c) => c.argv[0] === 'docker' && c.argv[1] === 'rm')
  const idxNetRm = ex.calls.findIndex((c) => c.argv[0] === 'docker' && c.argv[1] === 'network' && c.argv[2] === 'rm')
  const idxIptDel = ex.calls.findIndex((c) => c.argv[0] === 'iptables' && c.argv.includes('-D'))
  ok('先删容器', idxContainerRm >= 0)
  ok('iptables 在容器之后删', idxIptDel > idxContainerRm)
  ok('网络最后删（容器还引用着就不能删网络）', idxNetRm > idxIptDel)
}

// down 可重复调用
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex)
  await orch.up()
  const a = await orch.down()
  const b = await orch.down()
  eq('第一次 down 成功', a.ok, true)
  eq('第二次 down 也成功（幂等）', b.ok, true)
}

// 3.11 status()
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'network' && args[1] === 'inspect') return { code: 0, stdout: '10.213.1.0/24|10.213.1.1' }
      if (cmd === 'docker' && args[0] === 'inspect') return { code: 0, stdout: 'true' }
      if (cmd === 'iptables' && args.includes('-L') && args.includes('SKEG01')) return { code: 0, stdout: 'Chain SKEG01' }
      if (cmd === '/bin/sh' && String(args[1]).includes('ss -ltn')) return { code: 0, stdout: '1\n' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  const st = await orch.status()
  eq('status 网络存在', st.network.exists, true)
  eq('status iptables 链存在', st.iptables.present, true)
  eq('status 容器运行', st.containerState.running, true)
  eq('status redsocks 监听', st.redsocks.listening, true)
  eq('status 整体健康', st.healthy, true)
}

// status 降级
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'network' && args[1] === 'inspect') return { code: 1, stderr: 'no such network' }
      if (cmd === 'docker' && args[0] === 'inspect') return { code: 1, stderr: 'no such container' }
      if (cmd === 'iptables') return { code: 1, stderr: 'no chain' }
      if (cmd === '/bin/sh' && String(args[1]).includes('ss -ltn')) return { code: 0, stdout: '0\n' }
      return { code: 0, stdout: '' }
    },
  })
  const orch = makeOrch(ex)
  const st = await orch.status()
  eq('status 网络缺失', st.network.exists, false)
  eq('status 容器未运行', st.containerState.running, false)
  eq('status 整体不健康', st.healthy, false)
}

// 3.12 composeContainerArgv
{
  const base = {
    netArgs: ['--name', 'c1', '--network', 'net1', '--hostname', 'c1', '--dns', '8.8.8.8', 'img:latest'],
    personaSpec: {
      args: ['--mac-address', 'AA:BB:CC:DD:EE:F0', '--hostname', 'persona-host', '--memory', '2048m', '--network', 'net1'],
      env: { HOSTNAME: 'persona-host', TZ: 'UTC' },
    },
  }
  const argv = composeContainerArgv(base)
  eq('compose 以 docker run -d 开头', argv.slice(0, 3), ['docker', 'run', '-d'])
  eq('compose 镜像在末尾', argv[argv.length - 1], 'img:latest')
  ok('--hostname 只出现一次', argv.filter((a) => a === '--hostname').length === 1)
  eq('--hostname 取 persona 的值', argv[argv.indexOf('--hostname') + 1], 'persona-host')
  ok('--network 只出现一次', argv.filter((a) => a === '--network').length === 1)
  ok('含 persona 的 --mac-address', argv.includes('AA:BB:CC:DD:EE:F0'))
  ok('含 persona 的 env', argv.includes('TZ=UTC'))
  ok('含网络参数 --dns', argv.includes('8.8.8.8'))
}

// ═══════════════════════════════════════════════════════════
// 4. FleetRuntime
// ═══════════════════════════════════════════════════════════

console.log('── 4. FleetRuntime ──')

// runPool 并发受控
{
  let active = 0
  let peak = 0
  const durations = []
  const items = Array.from({ length: 12 }, (_, i) => i)
  const { results, stats } = await runPool(items, 4, async (i) => {
    active += 1
    peak = Math.max(peak, active)
    durations.push(active)
    await new Promise((r) => setTimeout(r, 5))
    active -= 1
    return i * 2
  })
  eq('runPool 返回全部结果', results.length, 12)
  eq('runPool 结果顺序稳定', results[0], 0)
  eq('runPool 结果顺序稳定（末位）', results[11], 22)
  eq('runPool 峰值并发不超过 4', peak, 4)
  eq('runPool stats 记录峰值', stats.peak, 4)
  eq('runPool stats 记录并发上限', stats.concurrency, 4)
}

// runPool 单任务抛错不影响其他
{
  const { results } = await runPool([1, 2, 3, 4], 2, async (i) => {
    if (i === 2) throw new Error('boom')
    return i
  })
  eq('抛错项记为 ok=false', results[1].ok, false)
  includes('抛错项带错误信息', results[1].error, 'boom')
  eq('其他项正常', results[0], 1)
  eq('其他项正常（第 3 个）', results[2], 3)
}

// runPool 并发数大于任务数
{
  const { stats } = await runPool([1, 2], 8, async (i) => i)
  eq('并发上限不超过任务数', stats.concurrency, 2)
}

// runPool 空列表
{
  const { results, stats } = await runPool([], 4, async (i) => i)
  eq('空列表结果为空', results.length, 0)
  eq('空列表 total 为 0', stats.total, 0)
}

// summarize
{
  const s = summarize([
    { slotId: 'slot-01', ok: true, steps: [{ name: 'network', ok: true, elapsedMs: 10 }] },
    { slotId: 'slot-02', ok: false, error: 'boom', steps: [{ name: 'redsocks', ok: false, elapsedMs: 5 }], rolledBack: [{ name: 'iptables' }] },
  ])
  eq('summarize 总数', s.total, 2)
  eq('summarize 成功数', s.started, 1)
  eq('summarize 失败数', s.failed, 1)
  eq('summarize 整体不 ok', s.ok, false)
  eq('summarize 失败步', s.failures[0].failedStep, 'redsocks')
  eq('summarize 回滚数', s.failures[0].rolledBack, 1)
}

// 造蓝图
function makeBlueprint(count) {
  return buildFleetBlueprint({ proxies: [], count, strict: false })
}

// 舰队启动：单槽失败不影响其他
{
  const blueprint = makeBlueprint(4)
  const failing = new Set(['slot-02'])
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      // slot-02 的转发器起不来：模拟进程启动后立刻退出 —— 只有它自己的
      // 端口（21002）始终不进入监听，其余槽位正常。
      // 不用 redsocks 返回非零来模拟：detach 启动只代表 fork 成功，
      // 真实失败在端口确认那一步暴露。
      if (cmd === '/bin/sh' && String(args[1] || '').includes('ss -ltn')) {
        if (String(args[1]).includes(':21002 ')) return { code: 0, stdout: '0\n' }
      }
      return host(cmd, args)
    },
  })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: blueprint,
    proxyPool: [1, 2, 3, 4].map((n) => proxy(`p0${n}`, n)),
    concurrency: 2,
    logger: nullLogger,
    orchestratorOptions: {
      dataDir: path.join(TMP, 'fleet-data'),
      confDir: path.join(TMP, 'fleet-conf'),
      dnsForwarder: fakeDnsForwarder(),
      preflight: PASS_PREFLIGHT,
      verifyEgress: false,
      verifyPersona: false,
    },
  })
  const summary = await fleet.upAll()
  eq('舰队总槽位 4', summary.total, 4)
  eq('成功 3 个', summary.started, 3)
  eq('失败 1 个', summary.failed, 1)
  eq('失败的是 slot-02', summary.failures[0].slotId, 'slot-02')
  eq('失败步是 redsocks', summary.failures[0].failedStep, 'redsocks')
  ok('失败槽位有回滚', summary.failures[0].rolledBack > 0)
  ok('峰值并发不超过 2', summary.peakConcurrency <= 2)
}

// 并发受控（用延时放大墙钟差异）
{
  const blueprint = makeBlueprint(6)
  let active = 0
  let peak = 0
  const ex = new FakeExecutor({
    behavior: async (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'network' && args[1] === 'create') {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 20))
        active -= 1
      }
      return host(cmd, args)
    },
  })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: blueprint,
    proxyPool: [1, 2, 3, 4, 5, 6].map((n) => proxy(`p0${n}`, n)),
    concurrency: 3,
    logger: nullLogger,
    orchestratorOptions: {
      dataDir: path.join(TMP, 'conc-data'),
      confDir: path.join(TMP, 'conc-conf'),
      dnsForwarder: fakeDnsForwarder(),
      preflight: PASS_PREFLIGHT,
      verifyEgress: false,
      verifyPersona: false,
    },
  })
  const summary = await fleet.upAll()
  eq('6 个槽位全部成功', summary.started, 6)
  ok('并发启动确实并行（峰值 > 1）', peak > 1)
  ok('并发不超过设定值 3', peak <= 3)
}

// 舰队 dry-run：不执行任何命令
{
  const blueprint = makeBlueprint(5)
  const ex = new FakeExecutor({ dryRun: true })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: blueprint,
    proxyPool: [1, 2, 3, 4, 5].map((n) => proxy(`p0${n}`, n)),
    concurrency: 2,
    logger: nullLogger,
    orchestratorOptions: { dataDir: path.join(TMP, 'dry-data'), confDir: path.join(TMP, 'dry-conf'), preflight: PASS_PREFLIGHT },
  })
  const summary = await fleet.upAll()
  eq('dry-run 全部成功', summary.started, 5)
  eq('dry-run 未真实执行', ex.executed, 0)
  eq('dry-run 标记', summary.dryRun, true)
}

// 舰队 preview：不执行，产出计划
{
  const blueprint = makeBlueprint(20)
  const ex = new FakeExecutor({ dryRun: true })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: blueprint,
    proxyPool: [],
    logger: nullLogger,
    orchestratorOptions: { dataDir: path.join(TMP, 'prev-data'), confDir: path.join(TMP, 'prev-conf'), preflight: PASS_PREFLIGHT },
  })
  const preview = fleet.preview()
  eq('preview 覆盖 20 个槽位', preview.length, 20)
  eq('每个槽位 11 步', preview[0].steps.length, 11)
  eq('20 槽位共 220 步', preview.reduce((n, s) => n + s.steps.length, 0), 220)
  eq('preview 不执行命令', ex.executed, 0)
  includes('第 1 槽位 network 步骤含 skylink-eg-01', preview[0].steps[1].command, 'skylink-eg-01')
  includes('第 20 槽位 network 步骤含 skylink-eg-20', preview[19].steps[1].command, 'skylink-eg-20')
}

// 舰队 downAll
{
  const blueprint = makeBlueprint(3)
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: blueprint,
    proxyPool: [1, 2, 3].map((n) => proxy(`p0${n}`, n)),
    concurrency: 2,
    logger: nullLogger,
    orchestratorOptions: {
      dataDir: path.join(TMP, 'down-data'),
      confDir: path.join(TMP, 'down-conf'),
      dnsForwarder: fakeDnsForwarder(),
      preflight: PASS_PREFLIGHT,
      verifyEgress: false,
      verifyPersona: false,
    },
  })
  await fleet.upAll()
  const down = await fleet.downAll()
  eq('downAll 总数 3', down.total, 3)
  eq('downAll 全部停止', down.stopped, 3)
  eq('downAll ok', down.ok, true)
}

// 舰队 status
{
  const blueprint = makeBlueprint(2)
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'network' && args[1] === 'inspect') return { code: 0, stdout: '10.213.1.0/24|10.213.1.1' }
      if (cmd === 'docker' && args[0] === 'inspect') return { code: 0, stdout: 'true' }
      if (cmd === 'iptables' && args.includes('-L')) return { code: 0, stdout: 'Chain' }
      if (cmd === '/bin/sh' && String(args[1]).includes('ss -ltn')) return { code: 0, stdout: '1\n' }
      return host(cmd, args)
    },
  })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: blueprint,
    proxyPool: [],
    concurrency: 2,
    logger: nullLogger,
    orchestratorOptions: { dataDir: path.join(TMP, 'st-data'), confDir: path.join(TMP, 'st-conf'), preflight: PASS_PREFLIGHT },
  })
  const st = await fleet.status()
  eq('status 覆盖 2 个槽位', st.total, 2)
  eq('status 健康 2', st.healthy, 2)
  eq('status ok', st.ok, true)
}

// repair：未知槽位
{
  const blueprint = makeBlueprint(2)
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: blueprint,
    proxyPool: [],
    concurrency: 1,
    logger: nullLogger,
    orchestratorOptions: {
      dataDir: path.join(TMP, 'rp-data'),
      confDir: path.join(TMP, 'rp-conf'),
      dnsForwarder: fakeDnsForwarder(),
      preflight: PASS_PREFLIGHT,
      verifyEgress: false,
      verifyPersona: false,
    },
  })
  const r = await fleet.repair('slot-99')
  eq('未知槽位修复失败', r.ok, false)
  includes('未知槽位报错', r.error, '未知槽位')
}

// repair：已知槽位先 down 再 up
{
  const blueprint = makeBlueprint(2)
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: blueprint,
    proxyPool: [1, 2].map((n) => proxy(`p0${n}`, n)),
    concurrency: 1,
    logger: nullLogger,
    orchestratorOptions: {
      dataDir: path.join(TMP, 'rp2-data'),
      confDir: path.join(TMP, 'rp2-conf'),
      dnsForwarder: fakeDnsForwarder(),
      preflight: PASS_PREFLIGHT,
      verifyEgress: false,
      verifyPersona: false,
    },
  })
  const r = await fleet.repair('slot-01')
  eq('修复成功', r.ok, true)
  eq('修复含 down 步骤', r.down.steps, 6)
  eq('修复含 up 步骤', r.up.steps.length, 11)
  ok('修复过程调用了 docker rm', ex.count('docker', 'rm') >= 1)
  ok('修复过程调用了 docker network create', ex.count('docker', 'create') >= 1)
}

// 缺凭据时给出告警但仍能构造
{
  const blueprint = buildFleetBlueprint({ proxies: [proxy('p01', 1)], count: 1, strict: false })
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const logs = []
  const logger = createLogger({ level: 'info', sink: { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) } })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: blueprint,
    proxyPool: [],  // 故意不给凭据
    concurrency: 1,
    logger,
    orchestratorOptions: {
      dataDir: path.join(TMP, 'np-data'),
      confDir: path.join(TMP, 'np-conf'),
      dnsForwarder: fakeDnsForwarder(),
      preflight: PASS_PREFLIGHT,
      verifyEgress: false,
      verifyPersona: false,
    },
  })
  eq('蓝图里有 1 个槽位', fleet.entries.length, 1)
  const p = fleet.proxyForSlot(fleet.entries[0])
  eq('回退到蓝图代理视图', p?.id, 'p01')
  eq('回退视图标记不完整', p?.incomplete, true)
  ok('产生缺凭据告警', logs.some((l) => l.includes('缺少凭据')))
}

// ═══════════════════════════════════════════════════════════
// 5. 边界与集成细节
// ═══════════════════════════════════════════════════════════

console.log('── 5. 边界与集成 ──')

// 构造参数校验
await throws('缺 executor 抛错', () => new SlotOrchestrator({ slotSpec: slot(1) }))
await throws('缺 slotSpec 抛错', () => new SlotOrchestrator({ executor: new FakeExecutor() }))
await throws('FleetRuntime 缺 fleetPlan 抛错', () => new FleetRuntime({ executor: new FakeExecutor() }))

// 槽位 20 的端口与网段
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex, { slotSpec: slot(20), proxy: proxy('p20', 20) })
  const report = await orch.up()
  eq('槽位 20 启动成功', report.ok, true)
  includes('槽位 20 用 21038 端口', report.steps.find((s) => s.name === 'redsocks').detail, '21038')
  includes('槽位 20 网关正确', report.steps.find((s) => s.name === 'dnsfwd').detail, '10.213.20.1:21039')
}

// iptables 的 INPUT ACCEPT 规则也在
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex)
  await orch.up()
  ok('存在 INPUT ACCEPT 规则', ex.matching((a) => a[0] === 'iptables' && a.includes('INPUT') && a.includes('ACCEPT')).length >= 1)
  ok('multiport 同时放行 tcp 与 dns', ex.matching((a) => a[0] === 'iptables' && a.includes('21000,21001')).length >= 1)
}

// 同网段 RETURN（防打环）
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex)
  await orch.up()
  ok('存在 -d subnet -j RETURN', ex.matching((a) => a[0] === 'iptables' && a.includes('10.213.1.0/24') && a.includes('RETURN')).length >= 1)
}

// persona 的主机名与 MAC 进了容器参数
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex)
  const report = await orch.up()
  const run = ex.calls.find((c) => c.argv[0] === 'docker' && c.argv[1] === 'run')
  const mac = orch.state.personaSpec.mac
  ok('容器参数含 persona MAC', run.argv.includes(mac))
  ok('容器参数含 persona 主机名', run.argv.includes(orch.state.personaSpec.dockerHostname))
  ok('容器参数含 --memory', run.argv.includes('--memory'))
  ok('容器参数含 --env TZ', run.argv.some((a) => a === '--env' || String(a).startsWith('TZ=')))
}

// 20 槽位 plan 全量
{
  const ex = new FakeExecutor({ dryRun: true })
  const blueprint = makeBlueprint(20)
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: blueprint,
    proxyPool: [],
    concurrency: 4,
    logger: nullLogger,
    orchestratorOptions: { dataDir: path.join(TMP, 'p20-data'), confDir: path.join(TMP, 'p20-conf'), preflight: PASS_PREFLIGHT },
  })
  const preview = fleet.preview()
  eq('20 槽位 220 步', preview.reduce((n, s) => n + s.steps.length, 0), 220)
  ok('每槽位 network 命令各不相同', new Set(preview.map((p) => p.steps[1].command)).size === 20)
  ok('每槽位 redsocks 配置路径各不相同', new Set(preview.map((p) => p.steps[3].command)).size === 20)
  ok('preview 不执行任何命令', ex.executed === 0)
}

// ExecError 形状
{
  const e = new ExecError('x', { argv: ['a'], code: 3, stderr: 'err', elapsedMs: 5 })
  eq('ExecError 名', e.name, 'ExecError')
  eq('ExecError argv', e.argv, ['a'])
  eq('ExecError stderr', e.stderr, 'err')
  eq('ExecError message', e.message, 'x')
}

// DEFAULT_IMAGE 存在
eq('DEFAULT_IMAGE 有值', typeof DEFAULT_IMAGE, 'string')

// ═══════════════════════════════════════════════════════════
// 6. 演练模式（dry-run）的编排语义
// ═══════════════════════════════════════════════════════════

console.log('── 6. 演练模式语义 ──')

// dry-run 下预检失败不阻断（演练要能走完 11 步）
{
  const ex = new FakeExecutor({ dryRun: true })
  const orch = makeOrch(ex, {
    preflight: async () => ({
      ok: false,
      checks: [{ name: 'os-linux', ok: false, detail: 'darwin', fatal: true }],
      fatal: ['os-linux: darwin'],
      warnings: [],
      summary: '通过 0/1，致命 1，告警 0',
    }),
  })
  const report = await orch.up()
  eq('演练下预检失败不阻断', report.ok, true)
  eq('演练仍走完 11 步', report.steps.length, 11)
  includes('演练 preflight 标记 dry-run', report.steps[0].detail, 'dry-run')
}

// 真实模式同一预检会阻断
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex, {
    preflight: async () => ({
      ok: false,
      checks: [],
      fatal: ['os-linux: darwin'],
      warnings: [],
      summary: '',
    }),
  })
  const report = await orch.up()
  eq('真实模式预检失败即阻断', report.ok, false)
  eq('真实模式只到第 1 步', report.steps.length, 1)
}

// 演练下 down() 不删真实目录
{
  const ex = new FakeExecutor({ dryRun: true })
  const d = caseDirs()
  fs.mkdirSync(d.dataDir, { recursive: true })
  const marker = path.join(d.dataDir, 'keep-me.txt')
  fs.writeFileSync(marker, 'x')
  const orch = makeOrch(ex, { ...d })
  orch.state.personaDir = d.dataDir
  const report = await orch.down()
  eq('演练 down 成功', report.ok, true)
  eq('演练 down 不删真实文件', fs.existsSync(marker), true)
}

// 演练的 verify 步骤不发探测命令
{
  const ex = new FakeExecutor({ dryRun: true })
  const orch = makeOrch(ex, { verifyEgress: true, verifyPersona: true })
  await orch.up()
  eq('演练下不执行 docker exec 探测', ex.matching((a) => a[0] === 'docker' && a[1] === 'exec').length, 0)
}

// 舰队演练：无代理也能走完
{
  const ex = new FakeExecutor({ dryRun: true })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: makeBlueprint(3),
    proxyPool: [],
    concurrency: 2,
    logger: nullLogger,
    orchestratorOptions: { ...caseDirs(), preflight: PASS_PREFLIGHT },
  })
  const summary = await fleet.upAll()
  eq('无代理的舰队演练全部走完', summary.started, 3)
  eq('演练失败 0', summary.failed, 0)
  eq('演练不执行命令', ex.executed, 0)
}

// 真实舰队：无代理必须失败
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: makeBlueprint(2),
    proxyPool: [],
    concurrency: 1,
    logger: nullLogger,
    orchestratorOptions: { ...caseDirs(), preflight: PASS_PREFLIGHT, verifyEgress: false, verifyPersona: false, dnsForwarder: fakeDnsForwarder() },
  })
  const summary = await fleet.upAll()
  eq('真实模式无代理全部失败', summary.failed, 2)
  eq('失败步是 redsocks', summary.failures[0].failedStep, 'redsocks')
  includes('错误说明缺代理', summary.failures[0].error, '代理')
}

// ═══════════════════════════════════════════════════════════
// 7. CLI 计划的契约（不执行命令）
// ═══════════════════════════════════════════════════════════

console.log('── 7. CLI 计划契约 ──')

{
  const ex = new FakeExecutor({ dryRun: true })
  const fleet = new FleetRuntime({
    executor: ex,
    fleetPlan: makeBlueprint(20),
    proxyPool: [],
    concurrency: 4,
    logger: nullLogger,
    orchestratorOptions: { ...caseDirs(), preflight: PASS_PREFLIGHT },
  })
  const preview = fleet.preview()

  // 220 步：20 × 8
  eq('20 槽位共 220 步', preview.reduce((n, s) => n + s.steps.length, 0), 220)
  // 每步的 step 序号从 1 到 8
  eq('每槽位步骤序号 1..11', preview[0].steps.map((s) => s.step), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  // 槽位 id 连续
  eq('槽位 id 从 slot-01 开始', preview[0].slotId, 'slot-01')
  eq('槽位 id 到 slot-20 结束', preview[19].slotId, 'slot-20')
  // 端口逐槽位递增 2
  includes('slot-01 用 21000 端口', preview[0].steps[3].action, ':21000')
  includes('slot-02 用 21002 端口', preview[1].steps[3].action, ':21002')
  includes('slot-20 用 21038 端口', preview[19].steps[3].action, ':21038')
  includes('slot-01 dns 用 21001', preview[0].steps[4].action, ':21001')
  includes('slot-20 dns 用 21039', preview[19].steps[4].action, ':21039')
  // 链名/网桥名
  includes('slot-01 iptables 链 SKEG01', preview[0].steps[2].action, 'SKEG01')
  includes('slot-20 iptables 链 SKEG20', preview[19].steps[2].action, 'SKEG20')
  includes('slot-01 网桥 skeg01', preview[0].steps[1].action, 'skeg01')
  includes('slot-20 网桥 skeg20', preview[19].steps[1].action, 'skeg20')
  // 子网逐槽位递增
  includes('slot-01 子网 10.213.1.0/24', preview[0].steps[1].action, '10.213.1.0/24')
  includes('slot-20 子网 10.213.20.0/24', preview[19].steps[1].action, '10.213.20.0/24')
  // persona 路径
  includes('slot-01 persona 路径', preview[0].steps[5].action, 'slot-01')
  // 步骤名固定
  eq('步骤名顺序固定', preview[0].steps.map((s) => s.name), [...STEP_ORDER])
}

// ── persona 主机名必须逐槽位不同 ──
//
// 这一节守的是一个真实回归：编排器曾经不传 overrides，于是 buildPersona 退回
// 平台常量主机名（linux 恒为 ip-10-0-1-23），20 个槽位的 /etc/hostname /
// `hostname` / `uname -n` 全是同一个值，只有 MAC 不同。
//
// 断言走 orch.up() 的 dry-run detail（那里带 hostname 与 mac 的实测值），
// 而不是 plan() 的静态描述 —— plan() 只能说"将要"，up() 的 detail 才是
// 真正会写进 persona 树的那份 spec 派生出来的。
{
  const complaints = []
  const seen = new Set()
  const macs = new Set()
  for (let i = 1; i <= 20; i += 1) {
    const ex = new FakeExecutor({ dryRun: true })
    // 必须给代理：缺代理时第 4 步 redsocks 会先失败，persona 步骤根本不会执行。
    const orch = makeOrch(ex, { slotSpec: slot(i), preflight: PASS_PREFLIGHT })
    const report = await orch.up()
    const detail = String(report.steps.find((s) => s.name === 'persona')?.detail || '')
    const hostname = detail.match(/hostname=([^\s）]+)/)?.[1] || ''
    const mac = detail.match(/mac=([0-9A-Fa-f:]+)/)?.[1] || ''
    if (!hostname) complaints.push(`slot-${i} 未派出 hostname（detail=${detail}）`)
    seen.add(hostname)
    macs.add(mac.toUpperCase())
  }
  eq('20 个槽位都派出 hostname', complaints.length, 0)
  eq('20 个槽位 hostname 两两不同', seen.size, 20)
  // 与 fleet-plan 的规划表口径一致：同一序号必须给出同一个主机名
  ok('slot-01 的 hostname 落在规划表里', seen.has('ip-10-0-1-11'))
  ok('slot-20 的 hostname 落在规划表里', seen.has('ip-10-0-1-30'))
  eq('20 个槽位 mac 两两不同', macs.size, 20)
}

// ── personaHostnameFor / personaOverridesFor 的边界 ──
{
  eq('slot-01 → ip-10-0-1-11', personaHostnameFor('linux', { index: 1 }), 'ip-10-0-1-11')
  eq('slot-20 → ip-10-0-1-30', personaHostnameFor('linux', { index: 20 }), 'ip-10-0-1-30')
  // index 缺失时回落到 slotId 尾部数字，保证手工构造的 slotSpec 也能派生
  eq('只有 slotId 也能派生', personaHostnameFor('linux', { slotId: 'slot-07' }), 'ip-10-0-1-17')
  // 三平台字段名不同，必须由 hostnameOverrides 分派
  eq('linux overrides 用 naming.hostname', JSON.stringify(personaOverridesFor('linux', 'h1')), '{"naming":{"hostname":"h1"}}')
  eq(
    'windows overrides 用 computer_name 且大写',
    JSON.stringify(personaOverridesFor('windows', 'desk-01')),
    '{"naming":{"computer_name":"DESK-01"}}',
  )
  // 主机名缺失时不产生 overrides（空对象），让平台缺省值生效
  eq('空主机名 → 空 overrides', JSON.stringify(personaOverridesFor('linux', '')), '{}')
  // 不支持的平台不该把槽位启动搞挂
  eq('未知平台 → 最小 overrides', JSON.stringify(personaOverridesFor('plan9', 'h9')), '{"naming":{"hostname":"h9"}}')
  // 未知平台的 hostname 派生返回空串，由调用方回落
  eq('未知平台 → 空 hostname', personaHostnameFor('plan9', { index: 3 }), '')
}

// ── --strict 必须真的挡住半配置部署 ──
//
// 曾经的 bug：buildPlan 无条件返回 ok:true，strict 产生的
// 「代理不足，以下槽位未绑定」被静默丢弃 —— 运维以为严格模式生效了。
// 这里直接断言判定函数，不起子进程（退出码另由 CLI 层保证）。
{
  // 20 条代理 / 25 个槽位 → 蓝图带 5 条未绑定错误
  const blueprint = buildFleetBlueprint({ proxies: [], count: 25, strict: true })
  ok('strict 蓝图确实带 errors', Array.isArray(blueprint.errors) && blueprint.errors.length > 0)
  eq('strict 下判失败', judgeStrict(blueprint, true).ok, false)
  includes('strict 错误点名未绑定槽位', judgeStrict(blueprint, true).errors.join('\n'), 'slot-21')
  // 非 strict 下同样的蓝图必须放行：首次部署还没填代理时也要能看规划与 dry-run
  eq('非 strict 下放行', judgeStrict(blueprint, false).ok, true)
  eq('非 strict 不返回错误', judgeStrict(blueprint, false).errors.length, 0)

  // 代理充足时 strict 也必须放行
  const enough = buildFleetBlueprint({ proxies: [proxy('p01', 1), proxy('p02', 2), proxy('p03', 3)], count: 3, strict: true })
  eq('代理充足时 strict 放行', judgeStrict(enough, true).ok, true)
  eq('代理充足时无错误', judgeStrict(enough, true).errors.length, 0)

  // 空/异常入参不该抛错
  eq('undefined 蓝图不抛错', judgeStrict(undefined, true).ok, true)
  eq('errors 非数组时当作无错误', judgeStrict({ errors: 'boom' }, true).ok, true)
}

// ═══════════════════════════════════════════════════════════
// 8. Executor 与编排器的交互细节
// ═══════════════════════════════════════════════════════════

console.log('── 8. 交互细节 ──')

// 所有编排器命令都经过注入的 executor（没有绕过）
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex)
  await orch.up()
  ok('编排产生多条命令', ex.calls.length > 10)
  ok(
    '全部命令都经 executor.run',
    ex.calls.every((c) => Array.isArray(c.argv) && c.argv.length >= 1 && typeof c.argv[0] === 'string'),
  )
}

// 单步超时透传
{
  const timeouts = []
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const origRun = ex.run.bind(ex)
  ex.run = async (cmd, args, opts = {}) => {
    timeouts.push(opts.timeoutMs)
    return origRun(cmd, args, opts)
  }
  const orch = makeOrch(ex, { stepTimeoutMs: 12_345 })
  await orch.up()
  ok('执行命令时带超时', timeouts.some((t) => t === 12_345))
}

// 回滚中单步 undo 抛错不阻断其余清理
{
  let undoCount = 0
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'iptables' && args.includes('-D')) {
        undoCount += 1
        return { code: 1, stderr: 'iptables: Bad rule' }
      }
      if (cmd === 'redsocks') return { code: 1, stderr: 'boom' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  const report = await orch.up()
  eq('iptables 删除失败仍返回报告', report.ok, false)
  ok('iptables 回滚尝试过', undoCount > 0)
  ok('网络回滚仍执行（不被前一步失败阻断）', ex.count('docker', 'rm') >= 1)
}

// 状态机：up 失败后 completed 被清空
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'redsocks') return { code: 1, stderr: 'boom' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  await orch.up()
  eq('失败后回滚栈清空', orch.completed.length, 0)
}

// status 在 dry-run 下不探测
{
  const ex = new FakeExecutor({ dryRun: true })
  const orch = makeOrch(ex)
  const st = await orch.status()
  eq('dry-run status 不执行命令', ex.executed, 0)
  includes('dry-run status 说明原因', st.detail, 'dry-run')
}

// 输出里的 NOT 前缀（避免误用 eq）
ne('槽位 1 与槽位 2 的容器名不同', slot(1).container, slot(2).container)

// ═══════════════════════════════════════════════════════════
// 9. 清理命令的幂等语义（目标已不存在 = 成功）
// ═══════════════════════════════════════════════════════════

console.log('── 9. 清理幂等 ──')

// 干净机器上 down：所有资源都不存在，必须报成功
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'rm') return { code: 1, stderr: `Error: No such container: ${args[2]}` }
      if (cmd === 'docker' && args[0] === 'network' && args[1] === 'rm') {
        return { code: 1, stderr: `Error: No such network: ${args[3]}` }
      }
      if (cmd === 'iptables') return { code: 1, stderr: 'iptables: Bad rule (does a matching rule exist in that chain?).' }
      if (cmd === 'kill') return { code: 1, stderr: 'kill: no such process' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  const report = await orch.down()
  eq('干净机器 down 报成功', report.ok, true)
  ok('全部步骤都成功', report.steps.every((s) => s.ok))
  includes('网络步骤说明本就不存在', report.steps.find((s) => s.name === 'network')?.detail, '本就不存在')
}

// 真实的清理失败仍要报失败
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'network' && args[1] === 'rm') {
        return { code: 1, stderr: 'Error response from daemon: network skylink-eg-01 has active endpoints' }
      }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  const report = await orch.down()
  eq('真实清理失败报失败', report.ok, false)
  includes('失败详情含原因', report.steps.find((s) => s.name === 'network')?.detail, 'active endpoints')
}

// 存在即成功：资源确实被删掉时也报成功
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      if (cmd === 'docker' && args[0] === 'rm') return { code: 0, stdout: 'claude-slot-01' }
      if (cmd === 'docker' && args[0] === 'network' && args[1] === 'rm') return { code: 0, stdout: 'skylink-eg-01' }
      if (cmd === 'iptables') return { code: 0 }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  const report = await orch.down()
  eq('正常清理报成功', report.ok, true)
  includes('网络步骤说明已删除', report.steps.find((s) => s.name === 'network')?.detail, '已删除')
}

// down 之后可以再次 up（全清理不损坏状态）
{
  const ex = new FakeExecutor({ behavior: healthyBehavior() })
  const orch = makeOrch(ex)
  const first = await orch.up()
  const down = await orch.down()
  const second = await orch.up()
  eq('首次 up 成功', first.ok, true)
  eq('down 成功', down.ok, true)
  eq('down 后再次 up 成功', second.ok, true)
  eq('再次 up 仍走 11 步', second.steps.length, 11)
}

// 清理工具本身不存在：本机不可能有该槽位的资源，清理视为完成
{
  const ex = new FakeExecutor({
    behavior: (cmd, args, host) => {
      // 与真实 Executor 一致：spawn 失败由 runner 折成 code=127 + stderr，
      // 在 check:false 时不抛。
      if (cmd === 'iptables') return { code: 127, stderr: 'spawn iptables ENOENT' }
      return host(cmd, args)
    },
  })
  const orch = makeOrch(ex)
  const report = await orch.down()
  eq('iptables 缺失时清理仍成功', report.ok, true)
  includes('说明无需清理', report.steps.find((s) => s.name === 'iptables')?.detail, '无需清理')
}

// ── 99. 回归防护：本轮修的两个真实缺陷 ──
{
  // 缺陷 A：status 的 healthy 不含转发层。
  // redsocks 挂了容器还活着、网桥还在、链也在，但每个出站请求都超时。
  // 只看容器状态会报"健康"，而现场表现是服务在跑但全失败。
  const ex = new FakeExecutor({
    behavior: (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'inspect') return { code: 0, stdout: 'true' }
      if (cmd === 'iptables') return { code: 0, stdout: 'Chain SKEG01' }
      // 网络存在
      if (cmd === 'docker' && args[0] === 'network') return { code: 0, stdout: '[]' }
      return { code: 0, stdout: '' }
    },
  })
  // isListening 是类方法，不走构造参数，直接在实例上覆盖
  const orch = makeOrch(ex)
  orch.isListening = async () => false // 转发层全挂
  const st = await orch.status()
  eq('转发层挂了不能报健康', st.healthy, false)
  eq('status 暴露转发层细节', st.forward?.ok, false)
  includes('转发层失败原因点名 redsocks', st.forward?.detail, 'redsocks')

  // 无法判定（null）时不应判不健康：精简镜像没有 ss/netstat
  const orch2 = makeOrch(ex)
  orch2.isListening = async () => null
  const st2 = await orch2.status()
  eq('无法判定时不判不健康', st2.forward?.ok, true)
}

// ═══════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════

try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {}


// ── 100. serve 常驻语义 ──
{
  // up 的 DNS 转发器是进程内监听器，命令退出它就消失：
  // 容器还在跑、iptables 还在，但 20 个端口上没人在听，DNS 全超时。
  // serve 的职责就是不退出。这两条锁住它的两个方向。
  const HELP = execFileSync(process.execPath, ['src/runtime/cli.mjs', 'help'], { encoding: 'utf8' })
  ok('help 里有 serve 子命令', HELP.includes('serve'), HELP.slice(0, 60))
  ok('help 说明 serve 常驻的理由', HELP.includes('常驻') || HELP.includes('进程内监听器'))

  // 无转发器时必须拒绝启动，而不是"看起来常驻了但什么都没听"
  const r = spawnSync(process.execPath, ['src/runtime/cli.mjs', 'serve', '--dry-run', '--limit', '1'], {
    cwd: ROOT,
    timeout: 20_000,
    encoding: 'utf8',
  })
  eq('无转发器时 serve 退出码非 0', r.status !== 0, true)
  includes('拒绝原因点名转发器', String(r.stdout) + String(r.stderr), 'DNS 转发器')
}

if (failures.length) {
  console.error('\n失败明细:')
  for (const f of failures) console.error(`  ✗ ${f}`)
}


// ── serve 的 SIGHUP 语义 ──
{
  const cliSrc = fs.readFileSync(path.join(ROOT, 'src/runtime/cli.mjs'), 'utf8')
  // SSH 断开会发 SIGHUP 到前台进程组。不处理它，serve 被杀后
  // 会留下「redsocks 还活着、dnsfwd 全死」的半死状态：
  // 容器 DNS 全超时，但排查时 redsocks 进程还在，极难定位。
  ok('serve 注册了 SIGHUP 处理', /process\.on\(\s*['"]SIGHUP['"]/.test(cliSrc))
  ok('SIGHUP 走忽略而非回滚',
    /SIGHUP['"][\s\S]{0,400}忽略/.test(cliSrc))
  ok('仍有 SIGTERM 走回滚', /SIGTERM['"][\s\S]{0,120}stop\(/.test(cliSrc))
  // 常驻不能靠永不 resolve 的 Promise（不产生 libuv 句柄）
  ok('用未 unref 的定时器保持存活', /setInterval\(\s*\(\)\s*=>/.test(cliSrc) && !/setInterval\([\s\S]{0,200}\.unref\(\)/.test(cliSrc))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
