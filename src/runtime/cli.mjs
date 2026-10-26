#!/usr/bin/env node
/**
 * 运行时命令行：预检 / 规划 / 演练 / 启动 / 状态 / 停止 / 修复。
 *
 * 用法：
 *   node src/runtime/cli.mjs preflight                    # 环境预检
 *   node src/runtime/cli.mjs plan --count 20              # 规划（不执行）
 *   node src/runtime/cli.mjs up --count 20 --dry-run      # 演练
 *   node src/runtime/cli.mjs up --count 20                # 真启动
 *   node src/runtime/cli.mjs status
 *   node src/runtime/cli.mjs down --all
 *   node src/runtime/cli.mjs repair --slot slot-05
 *
 * 约束：
 *   - 除 preflight / up / status / down / repair 之外全部离线。
 *   - 代理配置读 config/proxies.json；缺文件时用「未绑定」模式跑通规划与演练，
 *     这样首次部署在配置还没填的情况下也能看到完整执行计划。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Executor, createLogger } from './executor.mjs'
import { preflight, renderPreflight } from './preflight.mjs'
import { FleetRuntime } from './fleet.mjs'
import { SlotOrchestrator, STEP_ORDER } from './orchestrator.mjs'
import { buildFleetBlueprint } from '../egress/plan.mjs'
import { planFleet } from '../persona/fleet-plan.mjs'
import { planSlotNetworks } from '../egress/network.mjs'
import { defaultConfigPath, loadProxyPool } from '../egress/pool.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')

function parseArgs(argv) {
  const out = { cmd: argv[0] || 'plan', flags: {}, rest: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out.flags[key] = next
        i += 1
      } else out.flags[key] = true
    } else out.rest.push(a)
  }
  return out
}

function displayWidth(s) {
  let w = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0)
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xff00 && cp <= 0xff60)
    w += wide ? 2 : 1
  }
  return w
}

function padRight(s, w) {
  return `${s}${' '.repeat(Math.max(0, w - displayWidth(s)))}`
}

function printTable(head, rows) {
  const widths = head.map((h, i) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))))
  console.log(head.map((h, i) => padRight(h, widths[i])).join('  '))
  console.log(widths.map((w) => '─'.repeat(w)).join('  '))
  for (const r of rows) console.log(r.map((c, i) => padRight(c ?? '', widths[i])).join('  '))
}

/** 载入代理配置。缺文件不算错误，返回空池。 */
function loadProxies(configPath) {
  if (!fs.existsSync(configPath)) return { ok: true, proxies: [], warnings: [`配置不存在（${configPath}），按未绑定模式运行`] }
  return loadProxyPool(configPath)
}

/**
 * 建执行器。CLI 层统一决定 dryRun 与日志级别。
 *
 * --json 时把日志改投 stderr：命令执行轨迹属于诊断信息，
 * 与结果混在同一个流里会让 stdout 不再是合法 JSON，
 * 调用方 `... --json | jq` 直接解析失败。
 */
function makeExecutor(flags) {
  const toStderr = flags.json === true
  const sink = toStderr
    ? { log: (...a) => console.error(...a), error: (...a) => console.error(...a), warn: (...a) => console.error(...a) }
    : console
  const logger = createLogger({
    level: flags.verbose ? 'debug' : flags.quiet ? 'error' : 'info',
    sink,
  })
  return new Executor({ dryRun: Boolean(flags['dry-run']), logger })
}

/**
 * strict 判定（纯函数，可单独测）。
 *
 * 抽出来是为了让"strict 到底挡不挡"这件事能被断言直接覆盖，而不是只能靠
 * 起子进程看退出码 —— 后者在测试里既慢又难定位。
 *
 * @param {object} blueprint buildFleetBlueprint 的产物
 * @param {boolean} strict
 * @returns {{ok:boolean, errors:string[]}}
 */
export function judgeStrict(blueprint, strict) {
  const errors = Array.isArray(blueprint?.errors) ? blueprint.errors : []
  if (strict === true && errors.length) return { ok: false, errors }
  return { ok: true, errors: [] }
}

/**
 * 规划：拿蓝图（不执行）。
 *
 * `--strict` 的语义必须在这里落地，不能只传给 buildFleetBlueprint 就完事：
 * buildFleetBlueprint 会把「代理不足，以下槽位未绑定」写进 blueprint.errors，
 * 但过去这里无条件返回 ok:true，于是 strict 产生的错误被静默丢弃 ——
 * 运维以为严格模式挡住了半配置部署，实际什么都没挡。
 *
 * 现在的口径：
 *   strict=false（缺省）  未绑定代理只算提示，照常返回 ok:true（首次部署友好；
 *                         这样"还没填代理"也能看完整规划与 dry-run）
 *   strict=true           蓝图有任何 errors 就判失败，由调用方 exit(1)
 *
 * 只在 strict 下收紧，不动缺省路径：buildFleetBlueprint 在非 strict 下也会因为
 * 「代理数超过槽位数」而把 ok 置 false，那是配置警告而非致命错误，缺省仍应放行。
 */
function buildPlan({ count, configPath, strict }) {
  const pool = loadProxies(configPath)
  const planned = planSlotNetworks({ count })
  if (!planned.ok) return { ok: false, errors: planned.errors }

  // 资源分配必须在这里算出来并一路传到 slot 上。
  // 之前 blueprint 只管网络，slot 里没有 memoryMb ——
  // orchestrator 只能退回默认 1024，导致 persona 报的 MemTotal
  // 与容器真实 cgroup 限额（2560MB）差一倍多，比值 0.39。
  //
  // 用 planFleet 而不是自己拍脑袋：它已经处理了 oversubscribe、
  // 每槽内存/CPU/磁盘上限等规则。
  let resources = null
  let fleetTimezones = null
  try {
    const fleet = planFleet({
      platform: 'linux',
      count: planned.count,
      prefix: 'claude-slot',
      runtime: 'docker',
    })
    resources = fleet.slots.map((x) => ({
      memoryMb: x.memoryMb,
      cpus: x.cpus,
      diskMb: x.diskMb,
    }))
  } catch {
    // planFleet 失败不阻塞：blueprint 仍可用，只是资源用默认值
    resources = null
  }

  const blueprint = buildFleetBlueprint({
    proxies: pool.proxies || [],
    count: planned.count,
    strict: strict === true,
    ...(resources ? { resources } : {}),
  })
  const judged = judgeStrict(blueprint, strict === true)
  if (!judged.ok) {
    return { ok: false, errors: judged.errors, blueprint, pool, slots: blueprint.slots }
  }
  return { ok: true, blueprint, pool, slots: blueprint.slots }
}

// ─────────────────────── 命令实现 ───────────────────────

async function cmdPreflight(flags) {
  const executor = makeExecutor(flags)
  const result = await preflight({ executor })
  // --json 只出 JSON：渲染文本是给人看的，混进来就不是合法 JSON 了。
  if (flags.json) console.log(JSON.stringify(result, null, 2))
  else console.log(renderPreflight(result))
  process.exit(result.ok ? 0 : 1)
}

async function cmdPlan(flags) {
  const count = Number(flags.count || 20)
  const configPath = flags.config ? path.resolve(String(flags.config)) : defaultConfigPath(ROOT)
  const { ok, errors, blueprint, pool } = buildPlan({ count, configPath, strict: flags.strict })

  if (!ok) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  console.log(`代理配置: ${pool.ok ? `${pool.proxies.length} 条` : '布局有错'}${pool.warnings?.length ? `（${pool.warnings.length} 条警告）` : ''}`)
  printTable(
    ['槽位', 'network', 'subnet', '网关', '容器IP', 'tcp', 'dns', '代理'],
    blueprint.table.map((r) => [r.slotId, r.network, r.subnet, r.gateway, r.containerIp, String(r.tcpPort), String(r.dnsPort), r.proxyId || '-']),
  )
  console.log(`\n共 ${blueprint.count} 个槽位；8 步启动顺序：${STEP_ORDER.join(' → ')}`)
  console.log(`预计命令数：${blueprint.count} 槽位 × 8 步（每步 1-N 条命令）`)
  if (blueprint.unbound.length) console.log(`未绑定代理：${blueprint.unbound.length} 个（${blueprint.unbound.slice(0, 5).join(', ')}${blueprint.unbound.length > 5 ? ' …' : ''}）`)
}

/** 打印若干槽位的完整 8 步执行计划。 */
function printExecutionPlan(preview, { limit }) {
  const shown = limit ? preview.slice(0, limit) : preview
  for (const slot of shown) {
    console.log(`\n── ${slot.slotId} ──`)
    for (const s of slot.steps) {
      console.log(`  ${String(s.step).padStart(2)}. ${s.name.padEnd(10)} ${s.action}`)
      console.log(`      $ ${s.command}`)
    }
  }
  const totalSteps = preview.reduce((n, s) => n + s.steps.length, 0)
  console.log(`\n合计 ${preview.length} 个槽位 × 8 步 = ${totalSteps} 步`)
  if (limit && preview.length > limit) console.log(`（以上只显示前 ${limit} 个槽位的完整计划）`)
}

async function cmdUp(flags) {
  const count = Number(flags.count || 20)
  const concurrency = Number(flags.concurrency || 4)
  const configPath = flags.config ? path.resolve(String(flags.config)) : defaultConfigPath(ROOT)
  const { ok, errors, blueprint, pool } = buildPlan({ count, configPath, strict: flags.strict })
  if (!ok) {
    console.error(errors.join('\n'))
    process.exit(1)
  }

  const executor = makeExecutor(flags)
  const runtime = new FleetRuntime({
    executor,
    fleetPlan: blueprint,
    proxyPool: pool.proxies || [],
    concurrency,
    logger: executor.logger,
    orchestratorOptions: {
      ...(flags.image ? { image: String(flags.image) } : {}),
      ...(flags['no-verify'] ? { verifyEgress: false, verifyPersona: false } : {}),
      ...(flags['data-dir'] ? { dataDir: String(flags['data-dir']) } : {}),
      ...(flags['conf-dir'] ? { confDir: String(flags['conf-dir']) } : {}),
    },
  })

  if (flags['dry-run'] || flags.plan) {
    const preview = runtime.preview()
    console.log(`dry-run：${count} 个槽位，并发 ${concurrency}\n`)
    printExecutionPlan(preview, { limit: flags.limit ? Number(flags.limit) : (flags.all ? 0 : 2) })

    // 演练的第二段：真的走一遍 8 步编排，但 Executor 处于 dryRun 模式，
    // 因此只记录不执行。这一段的价值是验证编排逻辑本身（顺序、幂等标记、
    // 每步的参数拼装）在目标机器的规划数据上是自洽的 —— 只看计划文本
    // 看不出「第 7 步会不会因为缺 persona 参数而崩」。
    console.log('\n── 演练编排（dryRun executor，不执行任何命令）──')
    const drill = await runtime.upAll()
    console.log(`演练完成：${drill.started} 个槽位走完 ${preview[0]?.steps.length || 8} 步，失败 ${drill.failed}`)
    console.log(`Executor 实际执行命令数：${executor.executedCount}（应为 0）`)
    if (drill.failures.length) {
      for (const f of drill.failures.slice(0, 5)) console.log(`  ${f.slotId} [${f.failedStep}] ${f.error}`)
    }
    console.log('\n（dry-run 未执行任何命令）')
    return
  }

  const summary = await runtime.upAll()
  console.log('')
  printTable(
    ['槽位', '结果', '步数', '耗时'],
    summary.slots.map((s) => [s.slotId, s.ok ? 'ok' : 'FAILED', String(s.steps), `${s.elapsedMs}ms`]),
  )
  console.log(`\n成功 ${summary.started} / 失败 ${summary.failed} / 共 ${summary.total}；峰值并发 ${summary.peakConcurrency}；总耗时 ${summary.elapsedMs}ms`)
  if (summary.failures.length) {
    console.log('\n失败明细:')
    for (const f of summary.failures) {
      console.log(`  ${f.slotId}  [${f.failedStep}] ${f.error}`)
      console.log(`    回滚 ${f.rolledBack} 步`)
    }
  }
  process.exit(summary.ok ? 0 : 1)
}

/**
 * 常驻服务：拉起全部槽位后不退出。
 *
 * `up` 是"启动并报告结果"的命令，它的 DNS 转发器是**进程内监听器**，
 * 命令一退出监听器就消失 —— 容器还在跑、iptables 规则还在，但那 20 个
 * 端口上没有任何人在听，容器内的 DNS 查询全部超时。
 * 表现为"部署成功但所有请求失败"，最难定位。
 *
 * serve 在 upAll 之后挂住进程，并保持 SIGTERM/SIGINT 走完整 down()。
 */
async function cmdServe(flags) {
  const count = Number(flags.count || 20)
  const concurrency = Number(flags.concurrency || 4)
  const configPath = flags.config ? path.resolve(String(flags.config)) : defaultConfigPath(ROOT)
  const { ok, errors, blueprint, pool } = buildPlan({ count, configPath, strict: flags.strict })
  if (!ok) {
    console.error(errors.join('\n'))
    process.exit(1)
  }

  const executor = makeExecutor(flags)
  const runtime = new FleetRuntime({
    executor,
    fleetPlan: blueprint,
    proxyPool: pool.proxies || [],
    concurrency,
    logger: executor.logger,
    orchestratorOptions: {
      ...(flags.image ? { image: String(flags.image) } : {}),
      ...(flags['no-verify'] ? { verifyEgress: false, verifyPersona: false } : {}),
      ...(flags['data-dir'] ? { dataDir: String(flags['data-dir']) } : {}),
      ...(flags['conf-dir'] ? { confDir: String(flags['conf-dir']) } : {}),
    },
  })

  const summary = await runtime.upAll()
  console.log('')
  printTable(
    ['槽位', '结果', '步数', '耗时'],
    summary.slots.map((s) => [s.slotId, s.ok ? 'ok' : 'FAILED', String(s.steps), `${s.elapsedMs}ms`]),
  )
  console.log(`\n成功 ${summary.started} / 失败 ${summary.failed} / 共 ${summary.total}`)
  if (summary.failures.length) {
    for (const f of summary.failures) console.log(`  ${f.slotId}  [${f.failedStep}] ${f.error}`)
  }

  // 统计实际持有的监听器：这是 serve 与 up 的唯一行为差异，
  // 打出来才能让人确认"真的挂住了 20 个转发器"。
  const held = [...runtime.orchestrators.values()].filter((o) => o?.state?.dnsHandle).length
  console.log(`\n常驻中：持有 ${held} 个 DNS 转发器（pid ${process.pid}）`)
  console.log('按 Ctrl-C 或发 SIGTERM 结束（会按逆序完整回滚）')

  let stopping = false
  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    console.log(`\n收到 ${signal}，开始回滚…`)
    try {
      await runtime.downAll()
      console.log('回滚完成')
    } catch (error) {
      console.error(`回滚出错: ${error?.message || error}`)
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => { void stop('SIGTERM') })
  process.on('SIGINT', () => { void stop('SIGINT') })
  // SIGHUP：SSH 会话断开时终端会把 SIGHUP 发给前台进程组。
  // 不处理的话，用 `ssh host 'node ... serve'` 或 nohup 不彻底的方式启动，
  // 一断线 serve 就被带走 —— 而它 detach 出去的 redsocks 子进程还活着，
  // 于是留下「redsocks 在听、dnsfwd 全死」的半死状态：
  // 容器 DNS 全超时，但排查时看 redsocks 进程又在，极难定位。
  //
  // 这里选择忽略而不是回滚：SIGHUP 的语义是"终端没了"，不是"要停服务"。
  // 真要停请用 SIGTERM（systemd 默认发的就是它）。
  process.on('SIGHUP', () => {
    console.log('收到 SIGHUP（终端断开），忽略并继续常驻；要停请发 SIGTERM')
  })

  if (held === 0) {
    // 一个转发器都没挂住，说明这台机器上 serve 没有意义
    // （缺 iptables/redsocks，或全是 dry-run）。直接报错退出，
    // 让部署脚本立刻发现问题，而不是"看起来常驻了但什么都没听"。
    console.error('\n没有任何 DNS 转发器在运行，serve 无法提供转发能力，退出。')
    process.exit(1)
  }

  // 保持进程存活。
  //
  // 注意不能用 `return new Promise(() => {})`：永不 resolve 的 Promise
  // 不产生 libuv 句柄，事件循环该空还是会空，进程照样退出。
  // 必须留一个真实的、未 unref 的定时器。
  // 顺带每轮做一次存活巡检：转发器全没了就等于出口链路已断，
  // 此时静默常驻比退出更危险。
  setInterval(() => {
    const alive = [...runtime.orchestrators.values()].filter((o) => o?.state?.dnsHandle).length
    if (alive === 0) {
      console.error('所有 DNS 转发器都已消失，退出（容器将无法解析域名）')
      process.exit(1)
    }
  }, 30_000)

  // 永不 resolve，把控制权交给上面的定时器与信号处理。
  await new Promise(() => {})
}

async function cmdStatus(flags) {
  const count = Number(flags.count || 20)
  const configPath = flags.config ? path.resolve(String(flags.config)) : defaultConfigPath(ROOT)
  const { ok, errors, blueprint, pool } = buildPlan({ count, configPath })
  if (!ok) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  const executor = makeExecutor({ ...flags, 'dry-run': false })
  const runtime = new FleetRuntime({
    executor,
    fleetPlan: blueprint,
    proxyPool: pool.proxies || [],
    concurrency: Number(flags.concurrency || 4),
    logger: createLogger({ level: 'error' }),
  })
  const status = await runtime.status()
  printTable(
    ['槽位', 'network', 'iptables', '容器', 'redsocks', 'dnsfwd', '健康'],
    status.slots.map((s) => [
      s.slotId,
      s.network?.exists ? 'ok' : 'missing',
      s.iptables?.present ? 'ok' : 'missing',
      s.containerState?.running ? 'running' : 'stopped',
      s.redsocks?.listening === null ? '?' : s.redsocks?.listening ? 'listen' : 'down',
      s.dnsfwd?.listening === null ? '?' : s.dnsfwd?.listening ? 'listen' : 'down',
      s.healthy ? 'ok' : 'degraded',
    ]),
  )
  console.log(`\n健康 ${status.healthy} / 降级 ${status.degraded} / 共 ${status.total}`)
  process.exit(status.ok ? 0 : 1)
}

async function cmdDown(flags) {
  const count = Number(flags.count || 20)
  const configPath = flags.config ? path.resolve(String(flags.config)) : defaultConfigPath(ROOT)
  const { ok, errors, blueprint, pool } = buildPlan({ count, configPath })
  if (!ok) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  const executor = makeExecutor({ ...flags, 'dry-run': Boolean(flags['dry-run']) })
  const runtime = new FleetRuntime({
    executor,
    fleetPlan: blueprint,
    proxyPool: pool.proxies || [],
    concurrency: Number(flags.concurrency || 4),
    logger: executor.logger,
    orchestratorOptions: {
      ...(flags['data-dir'] ? { dataDir: String(flags['data-dir']) } : {}),
      ...(flags['conf-dir'] ? { confDir: String(flags['conf-dir']) } : {}),
    },
  })
  const only = flags.slot ? String(flags.slot) : null
  if (only && !flags.all) {
    const orch = runtime.createOrchestrator(
      blueprint.slots.find((e) => e.slot?.slotId === only) || { slot: { slotId: only } },
    )
    const report = await orch.down()
    for (const s of report.steps) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name.padEnd(12)} ${s.detail}`)
    process.exit(report.ok ? 0 : 1)
  }
  const summary = await runtime.downAll()
  console.log(`\n停止 ${summary.stopped} / 失败 ${summary.failed} / 共 ${summary.total}`)
  if (summary.failures.length) {
    console.log('\n失败明细（只列失败的步骤）:')
    for (const f of summary.failures) {
      const bad = (f.steps || []).map((s) => `${s.name}: ${s.detail}`)
      console.log(`  ${f.slotId}`)
      for (const line of bad) console.log(`    ✗ ${line}`)
    }
  }
  process.exit(summary.ok ? 0 : 1)
}

async function cmdRepair(flags) {
  const slotId = String(flags.slot || flags.rest?.[0] || '')
  if (!slotId) {
    console.error('用法: node src/runtime/cli.mjs repair --slot slot-05')
    process.exit(2)
  }
  const count = Number(flags.count || 20)
  const configPath = flags.config ? path.resolve(String(flags.config)) : defaultConfigPath(ROOT)
  const { ok, errors, blueprint, pool } = buildPlan({ count, configPath })
  if (!ok) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  const executor = makeExecutor(flags)
  const runtime = new FleetRuntime({
    executor,
    fleetPlan: blueprint,
    proxyPool: pool.proxies || [],
    concurrency: 1,
    logger: executor.logger,
    orchestratorOptions: {
      ...(flags.image ? { image: String(flags.image) } : {}),
      ...(flags['data-dir'] ? { dataDir: String(flags['data-dir']) } : {}),
      ...(flags['conf-dir'] ? { confDir: String(flags['conf-dir']) } : {}),
    },
  })
  const result = await runtime.repair(slotId)
  console.log(`\n${result.ok ? '修复成功' : '修复失败'}: ${result.slotId}${result.error ? ` — ${result.error}` : ''}`)
  process.exit(result.ok ? 0 : 1)
}

/** 单槽位详情：同时打印规划和该槽位的 8 步计划。 */
async function cmdSlot(flags) {
  const slotId = String(flags.slot || flags.rest?.[0] || '')
  const count = Number(flags.count || 20)
  const configPath = flags.config ? path.resolve(String(flags.config)) : defaultConfigPath(ROOT)
  const { ok, errors, blueprint, pool } = buildPlan({ count, configPath })
  if (!ok) {
    console.error(errors.join('\n'))
    process.exit(1)
  }
  const entry = blueprint.slots.find((e) => e.slot?.slotId === (slotId.startsWith('slot-') ? slotId : `slot-${String(Number(slotId)).padStart(2, '0')}`))
  if (!entry) {
    console.error(`未知槽位: ${slotId}`)
    process.exit(2)
  }
  const executor = makeExecutor({ ...flags, 'dry-run': true })
  const orch = new SlotOrchestrator({
    executor,
    slotSpec: entry.slot,
    proxy: pool.proxies?.find((p) => p.id === entry.proxy?.id) || entry.proxy,
    logger: createLogger({ level: 'error' }),
  })
  console.log(`槽位 ${entry.slot.slotId}  网络 ${entry.slot.network}  子网 ${entry.slot.subnet}`)
  console.log(`代理 ${entry.proxy?.id || '（未绑定）'}  容器 ${entry.slot.container}`)
  printExecutionPlan([{ slotId: entry.slot.slotId, steps: orch.plan() }], { limit: 1 })
}

const HELP = `用法: node src/runtime/cli.mjs <命令> [选项]

命令:
  preflight              环境预检（OS / 权限 / 程序 / netfilter / docker / KVM）
  plan                   打印槽位规划与启动顺序（不执行）
  slot <slotId>          打印单槽位的完整 8 步执行计划
  up                     启动舰队（默认 20 槽位，并发 4），完成后退出
  serve                  启动舰队并常驻。DNS 转发器是进程内监听器，
                         用 up 部署会让它们随命令退出而消失，
                         容器内 DNS 全部超时 —— 生产用 serve。
  status                 健康总览
  down                   停止舰队（--all 或 --slot <id>）
  repair --slot <id>     单槽位修复（先清理再启动）

选项:
  --count <n>            槽位数（默认 20）
  --concurrency <n>      并发数（默认 4）
  --config <path>        代理配置（默认 config/proxies.json）
  --dry-run              只打印将执行的命令，不执行
  --plan                 up 的 --dry-run 别名（打印完整执行计划）
  --limit <n>            dry-run 时显示前 n 个槽位（默认 2，--all 显示全部）
  --all                  down 全部 / dry-run 显示全部槽位
  --slot <slotId>        down / repair / slot 的目标
  --image <ref>          容器镜像（默认 live-api/claude-slot-cli:latest，含 Claude Code CLI）
  --data-dir <path>      persona 落盘根目录（默认 /var/lib/live-api-egress）
  --conf-dir <path>      转发器配置目录（默认 /etc/live-api-egress）
  --no-verify            跳过出口与身份验证
  --strict              规划时把未绑定代理判为错误
  --json                 预检输出 JSON
  --verbose              打印每条命令
  --quiet                只打印错误
  -h, --help             显示本帮助`

async function main() {
  const { cmd, flags, rest } = parseArgs(process.argv.slice(2))
  // 位置参数（slot-05 / repair slot-05 这种写法）也放进 flags.rest，
  // 让各子命令统一从 flags.rest 取，避免两条取值路径。
  flags.rest = rest
  if (flags.help || cmd === 'help') {
    console.log(HELP)
    return
  }
  switch (cmd) {
    case 'preflight':
      return cmdPreflight(flags)
    case 'plan':
      return cmdPlan(flags)
    case 'up':
      return cmdUp(flags)
    case 'serve':
      return cmdServe(flags)
    case 'status':
      return cmdStatus(flags)
    case 'down':
      return cmdDown(flags)
    case 'repair':
      return cmdRepair(flags)
    case 'slot':
      return cmdSlot(flags)
    default:
      console.error(`未知命令: ${cmd}\n`)
      console.error(HELP)
      process.exit(2)
  }
}

/**
 * 只有作为入口脚本执行时才真的跑 main()；被 import 时（测试要断言
 * judgeStrict / buildPlan 这类纯逻辑）不解析 argv、不 process.exit。
 *
 * 与 src/server.mjs、src/kernel/server.mjs 同一个判据：两边都解析成真实路径
 * 再比，因为 argv[1] 在包装器（npm/pnpm 脚本）下可能是符号链接或相对路径。
 */
function isEntrypoint() {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(invoked)
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(`\n运行失败: ${error?.stack || error?.message || error}`)
    process.exit(1)
  })
}
