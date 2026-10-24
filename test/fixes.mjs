#!/usr/bin/env node
/**
 * 回归测试：CLI 启动失败降级 + claude_bin 配置优先级。
 *
 * 运行：node test/fixes.mjs
 *
 * 覆盖两组：
 *   一、CliHost 启动失败（缺陷 1）
 *       - bin 不存在 → start() 的 promise reject，进程不崩，lastError.code = ENOENT
 *       - bin 无执行权限 → lastError.code = EACCES，reason 含权限说明
 *       - 从未启动 / 启动失败后调用 stop() 必须安全
 *       - 失败错误能被健康检查序列化出来
 *       - 真实把 server 拉起来，确认进程存活且 /status 报出错误
 *   二、claude_bin 优先级（缺陷 2）
 *       - 只设配置文件 → 生效
 *       - 只设环境变量 → 生效
 *       - 两者都设且不同 → 配置文件胜出，且带 warning
 *
 * 输出格式与其余测试一致：逐条 ok/FAIL，末行「通过 N / 失败 M」。
 * 约束：源码只读，临时文件全部落在 os.tmpdir() 下的独立目录，退出前清理。
 */

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { CliHost, spawnError, SPAWN_ERROR_REASONS } from '../src/frames.mjs'
import { resolveClaudeBin, DEFAULT_CLAUDE_BIN, healthPayload, DEFAULT_WORKER_CONFIG } from '../src/config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SERVER = path.join(ROOT, 'src', 'server.mjs')

const START_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 5_000

let pass = 0
let fail = 0

function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass += 1
    console.log(`  ok    ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}\n        得到 ${g}\n        期望 ${w}`)
  }
}

function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  ok    ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────────── 基础设施

function makeTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `reimpl-fixes-${tag}-`))
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function request({ port, route = '/', timeout = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: route, timeout }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('timeout', () => req.destroy(new Error(`request timeout after ${timeout}ms`)))
    req.on('error', reject)
    req.end()
  })
}

async function waitFor(fn, { timeout = START_TIMEOUT_MS, interval = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(interval)
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`)
}

function startChild(args, env) {
  const child = spawn(process.execPath, [SERVER, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const state = { child, stdout: '', stderr: '', exited: false, code: null }
  child.stdout.on('data', (c) => {
    state.stdout += c
  })
  child.stderr.on('data', (c) => {
    state.stderr += c
  })
  child.on('exit', (code, signal) => {
    state.exited = true
    state.code = code ?? signal
  })
  state.kill = async () => {
    if (state.exited) return
    child.kill('SIGTERM')
    const deadline = Date.now() + 3000
    while (!state.exited && Date.now() < deadline) await sleep(25)
    if (!state.exited) {
      child.kill('SIGKILL')
      const hard = Date.now() + 2000
      while (!state.exited && Date.now() < hard) await sleep(25)
    }
  }
  return state
}

/**
 * 观察一个 spawn 失败期间的顶层异常。
 *
 * 本进程的 process 被 Node 直接终止时抓不到钩子，所以判断"进程没崩"的方式是：
 * 安装 uncaughtException/unhandledRejection 记录器，跑完断言后仍能继续执行。
 * 未捕获错误会先把记录器置位，再让断言断在具体条目上。
 */
function watchCrash() {
  const seen = { uncaught: null, unhandled: null }
  const onUncaught = (error) => {
    seen.uncaught = error
  }
  const onUnhandled = (error) => {
    seen.unhandled = error
  }
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onUnhandled)
  seen.stop = () => {
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onUnhandled)
  }
  return seen
}

// ─────────────────────────────── 一、CLI 启动失败

async function testSpawnFailure() {
  console.log('\nCLI 启动失败降级')
  const dir = makeTempDir('spawn')
  const watch = watchCrash()
  try {
    // 1. bin 不存在 → ENOENT
    const missing = path.join(dir, 'no-such-cli')
    const h1 = new CliHost({ bin: missing })
    let err1 = null
    try {
      await h1.start()
    } catch (error) {
      err1 = error
    }
    ok('bin 不存在时 start() 被 reject（不是进程崩溃）', err1 !== null, String(err1))
    eq('ENOENT 错误码', err1?.code, 'ENOENT')
    eq('lastError.code 为 ENOENT', h1.lastError?.code, 'ENOENT')
    eq('lastError 记录 bin 路径', h1.lastError?.bin, missing)
    ok('错误消息含 bin 路径', String(err1?.message).includes(missing), err1?.message)
    ok('错误消息含错误码', String(err1?.message).includes('ENOENT'), err1?.message)
    ok('错误消息含可读原因', /file not found/i.test(String(err1?.message)), err1?.message)
    eq('启动失败后 started 为 false', h1.started, false)
    eq('启动失败不产生未捕获异常', watch.uncaught, null)
    eq('启动失败不产生未处理拒绝', watch.unhandled, null)

    // 2. 文件存在但没有执行权限 → EACCES
    const noExec = path.join(dir, 'no-exec-cli.sh')
    fs.writeFileSync(noExec, '#!/bin/sh\necho hi\n')
    fs.chmodSync(noExec, 0o644)
    const h2 = new CliHost({ bin: noExec })
    let err2 = null
    try {
      await h2.start()
    } catch (error) {
      err2 = error
    }
    ok('bin 无执行权限时 start() 被 reject', err2 !== null, String(err2))
    const code2 = err2?.code
    const reason2 = String(err2?.reason || '')
    ok(
      'EACCES 错误码或权限说明',
      code2 === 'EACCES' || /permission|EACCES/i.test(reason2),
      `code=${code2} reason=${reason2}`,
    )
    eq('lastError.code 记录权限错误', h2.lastError?.code, 'EACCES')
    ok('权限错误原因是可读文案', /permission/i.test(String(h2.lastError?.reason)), h2.lastError?.reason)
    eq('权限失败也不产生未捕获异常', watch.uncaught, null)

    // 3. stop() 安全性：从未 start、重复 stop、启动失败后 stop
    const h3 = new CliHost({ bin: path.join(dir, 'never-started') })
    let stopThrew = false
    try {
      h3.stop()
    } catch {
      stopThrew = true
    }
    eq('从未启动时 stop() 不抛错', stopThrew, false)
    let stop2Threw = false
    try {
      h1.stop()
      h1.stop()
    } catch {
      stop2Threw = true
    }
    eq('启动失败后重复 stop() 不抛错', stop2Threw, false)
    eq('stop() 后 lastError 仍保留诊断信息', h1.lastError?.code, 'ENOENT')

    // 4. 失败的写帧调用必须安全返回 false，而不是抛 EPIPE
    let writeThrew = false
    let wrote = null
    try {
      wrote = h1.write({ type: 'ping', nonce: 'x' })
    } catch {
      writeThrew = true
    }
    eq('启动失败后写帧不抛错', writeThrew, false)
    eq('启动失败后写帧返回 false', wrote, false)

    // 5. 错误序列化：健康检查能读到 code / bin / reason
    const payload = healthPayload({ ...DEFAULT_WORKER_CONFIG, vm_id: 'vm-fix' }, {
      readySlots: 0,
      cliStarted: false,
      cliError: h1.lastError,
      startedAt: Date.now(),
    })
    eq('health.cli_error.code', payload.cli_error?.code, 'ENOENT')
    eq('health.cli_error.bin', payload.cli_error?.bin, missing)
    ok('health.cli_error.reason 非空', Boolean(payload.cli_error?.reason), JSON.stringify(payload.cli_error))
    eq('health.cli_started 为 false', payload.cli_started, false)
    eq('CLI 失败时 healthy 仍为 true', payload.healthy, true)
    const healthyNoCli = healthPayload({ ...DEFAULT_WORKER_CONFIG }, { readySlots: 0, startedAt: Date.now() })
    eq('无 CLI 错误时 cli_error 为 null', healthyNoCli.cli_error, null)

    // 6. 错误码映射表与整理函数的契约
    eq('spawnError 无错误码时兜底', spawnError(null, '/x').code, 'UNKNOWN')
    ok('ENOENT 原因文案存在', typeof SPAWN_ERROR_REASONS.ENOENT === 'string' && SPAWN_ERROR_REASONS.ENOENT.length > 0)
  } finally {
    watch.stop()
    rmrf(dir)
  }
}

/** 真实起 server：CLI 路径不存在时进程必须存活，且 /status 报出错误。 */
async function testServerSurvivesBadBin() {
  console.log('\nserver 在 CLI 缺失时不崩')
  const dir = makeTempDir('server')
  let server = null
  const badBin = path.join(dir, 'missing-claude-binary')
  try {
    const port = await freePort()
    server = startChild(['--addr', `127.0.0.1:${port}`], { CLAUDE_BIN: badBin })

    const status = await waitFor(
      async () => {
        const res = await request({ port, route: '/status' })
        return res.status === 200 ? JSON.parse(res.body) : null
      },
      { label: '/status' },
    )
    eq('CLI 缺失时 server 进程仍存活', server.exited, false)
    eq('/status 状态码 200', (await request({ port, route: '/status' })).status, 200)
    eq('cli_started 为 false', status.cli_started, false)
    eq('/status 报出 ENOENT', status.cli_error?.code, 'ENOENT')
    eq('/status 回显 bin 路径', status.cli_error?.bin, badBin)

    // 探针端点字段集合保持不变，诊断信息只挂在 /status
    const healthz = await request({ port, route: '/healthz' })
    eq('/healthz 状态码 200', healthz.status, 200)
    eq('/healthz 载荷不含 cli_error', Object.hasOwn(JSON.parse(healthz.body), 'cli_error'), false)

    // 给 spawn 的 error 事件留出投递时间，再确认进程没被未捕获异常带走
    await sleep(200)
    eq('CLI 缺失不影响 server 存活（二次确认）', server.exited, false)
    eq('server 未因 CLI 缺失退出', server.code, null)
  } finally {
    if (server) await server.kill()
    rmrf(dir)
  }
}

// ─────────────────────────────── 二、claude_bin 优先级

function testClaudeBinPriority() {
  console.log('\nclaude_bin 优先级')
  {
    // 只设配置文件
    const r = resolveClaudeBin({ configValue: '/opt/cfg/claude', env: {} })
    eq('只设配置文件时生效', r.bin, '/opt/cfg/claude')
    eq('来源标记为 config', r.source, 'config')
    eq('无冲突时不产生 warning', r.warning, null)
  }
  {
    // 只设环境变量
    const r = resolveClaudeBin({ configValue: undefined, env: { CLAUDE_BIN: '/opt/env/claude' } })
    eq('只设环境变量时生效', r.bin, '/opt/env/claude')
    eq('来源标记为 env', r.source, 'env')
    eq('环境变量单独使用无 warning', r.warning, null)
  }
  {
    // 都设且不同 → 配置文件胜出
    const r = resolveClaudeBin({ configValue: '/opt/cfg/claude', env: { CLAUDE_BIN: '/opt/env/claude' } })
    eq('冲突时配置文件胜出', r.bin, '/opt/cfg/claude')
    eq('冲突时来源为 config', r.source, 'config')
    ok('冲突时返回 warning', typeof r.warning === 'string' && r.warning.length > 0, String(r.warning))
    ok('warning 说明被忽略的是环境变量', String(r.warning).includes('CLAUDE_BIN'), r.warning)
  }
  {
    // 都设但相同 → 不报 warning
    const r = resolveClaudeBin({ configValue: '/opt/same', env: { CLAUDE_BIN: '/opt/same' } })
    eq('值相同时用配置值', r.bin, '/opt/same')
    eq('值相同时不产生 warning', r.warning, null)
  }
  {
    // 都没有 → 缺省值
    const r = resolveClaudeBin({})
    eq('都没设时用缺省值', r.bin, DEFAULT_CLAUDE_BIN)
    eq('缺省值来源标记', r.source, 'default')
    eq('缺省值为 claude', DEFAULT_CLAUDE_BIN, 'claude')
  }
  {
    // 空串视为未设置，不把空路径当成合法值
    const r = resolveClaudeBin({ configValue: '', env: { CLAUDE_BIN: '/opt/env/claude' } })
    eq('配置空串回落到环境变量', r.bin, '/opt/env/claude')
    const r2 = resolveClaudeBin({ configValue: '   ', env: { CLAUDE_BIN: '' } })
    eq('空白值回落到缺省值', r2.bin, DEFAULT_CLAUDE_BIN)
    eq('空串不报冲突 warning', r2.warning, null)
  }
  {
    // 缺省配置里的 claude_bin 不应盖掉环境变量：调用方传 undefined 表示"未配置"
    eq('DEFAULT_WORKER_CONFIG.claude_bin 为 claude', DEFAULT_WORKER_CONFIG.claude_bin, 'claude')
    const r = resolveClaudeBin({ configValue: undefined, env: { CLAUDE_BIN: '/opt/env/claude' } })
    eq('未配置字段时环境变量优先级高于缺省值', r.bin, '/opt/env/claude')
  }
}

// ─────────────────────────────── 入口

async function main() {
  console.log('缺陷修复回归\n')
  console.log(`src  : ${path.relative(ROOT, path.join(ROOT, 'src'))}`)

  for (const [label, fn] of [
    ['spawn failure', testSpawnFailure],
    ['server survives', testServerSurvivesBadBin],
    ['claude_bin priority', async () => testClaudeBinPriority()],
  ]) {
    try {
      await fn()
    } catch (error) {
      fail += 1
      console.log(`  FAIL  ${label} 组异常中止: ${error.message}`)
    }
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`)
  process.exit(fail ? 1 : 0)
}

main()
