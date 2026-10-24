/**
 * Codex 模型映射 + 额度窗口接线的验证。
 *
 * 三块内容：
 *   1. 入站模型名的白名单重写（纯函数，含「重写必须在平台判定之前」的顺序断言）
 *   2. 调度器的额度门禁与 park 软解除（注入假时钟 + mock 窗口读数，不碰网络）
 *   3. 端到端：假 fetch 让上游回一个打满的 5h 头，验证第二个请求不再打上游、
 *      拿到 503 + quota_exhausted + Retry-After，并且窗口 reset 之后自动恢复
 *
 * 全部离线：时钟、窗口读数、上游响应都由测试注入，重复运行结果一致。
 *
 * 运行：node test/codex-model-mapping.mjs
 */

import http from 'node:http'
import zlib from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CODEX_MODEL_ALIASES,
  CODEX_MODEL_MAP,
  FALLBACK_MODEL,
  applyCodexModelMapping,
  detectCodexPlatform,
  normalizeCodexModelMap,
  resolveCodexInboundModel,
} from '../src/codex-model-mapping.mjs'
import {
  AccountScheduler,
  DEFAULT_COOLDOWN_SECS,
  QUOTA_PARK_FALLBACK_SECS,
  RPM_WINDOW_SECS,
} from '../src/codex.mjs'
import { createCodexHandler } from '../src/codex-server.mjs'
import { WINDOW_5H_MINUTES, WINDOW_7D_MINUTES } from '../src/quota-window.mjs'

// ─────────────── 断言器 ───────────────

let pass = 0
let fail = 0

function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass += 1
    console.log('  ok   ', name)
  } else {
    fail += 1
    console.log('  FAIL ', name, '\n         got ', g, '\n         want', w)
  }
}

function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log('  ok   ', name)
  } else {
    fail += 1
    console.log('  FAIL ', name, detail === undefined ? '' : `\n         ${detail}`)
  }
}

/** 可推进的假时钟 */
function makeClock(start = 1_700_000_000_000) {
  const c = { t: start }
  return {
    now: () => c.t,
    advance: (ms) => { c.t += ms },
    set: (ms) => { c.t = ms },
  }
}

/** 构造一个窗口读数（字段集合与 quota-window.mjs 的 makeWindow 一致） */
function win(usedPct, resetAt = null, key = '5h', extra = {}) {
  return {
    key,
    usedPct,
    resetAt,
    windowMinutes: key === '5h' ? WINDOW_5H_MINUTES : WINDOW_7D_MINUTES,
    status: 'active',
    source: 'codex',
    at: 0,
    stale: false,
    ...extra,
  }
}

/** 断言 select 抛错并返回错误对象 */
function selectError(sch, keys = {}) {
  try {
    sch.select(keys)
    return null
  } catch (e) {
    return e
  }
}

/** 收集日志的假 logger */
function makeLogger() {
  const lines = []
  const push = (level) => (fields, message) => lines.push({ level, fields, message })
  return { lines, warn: push('warn'), info: push('info') }
}

// ═══════════════ 1. 模型映射：白名单重写 ═══════════════

console.log('\n1. 模型映射（白名单重写）')

eq('映射表只有一条', CODEX_MODEL_ALIASES, ['codex-auto-review'])
eq('映射目标', CODEX_MODEL_MAP['codex-auto-review'], 'gpt-6-luna')
eq('映射表冻结', Object.isFrozen(CODEX_MODEL_MAP), true)
eq('兜底模型与官方一致', FALLBACK_MODEL, 'gpt-6.1-sol')

eq('codex-auto-review 被重写', applyCodexModelMapping('codex-auto-review'), 'gpt-6-luna')
eq('重写结果不是原始值', applyCodexModelMapping('codex-auto-review') === 'codex-auto-review', false)

// 其余真模型一律原名直发：加进映射表只会多一层无意义的间接
for (const id of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-reserve', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
  eq(`不映射 ${id}`, applyCodexModelMapping(id), id)
}
eq('未知模型原名返回', applyCodexModelMapping('some-unknown-model'), 'some-unknown-model')
eq('非 gpt 前缀原名返回', applyCodexModelMapping('claude-sonnet-4-20250514'), 'claude-sonnet-4-20250514')

// 空值 / 非字符串：原样返回，由上层决定缺省模型
eq('null 原样返回', applyCodexModelMapping(null), null)
eq('undefined 原样返回', applyCodexModelMapping(undefined), undefined)
eq('空串原样返回', applyCodexModelMapping(''), '')
eq('空白串原样返回', applyCodexModelMapping('   '), '   ')
eq('数字原样返回', applyCodexModelMapping(42), 42)
eq('对象原样返回', applyCodexModelMapping({ model: 'codex-auto-review' }), { model: 'codex-auto-review' })

// 前缀与大小写：客户端把这些形态发过来时要同样命中
eq('保留供应商前缀', applyCodexModelMapping('openai/codex-auto-review'), 'openai/gpt-6-luna')
eq('大小写不敏感', applyCodexModelMapping('Codex-Auto-Review'), 'gpt-6-luna')
eq('首尾空白被忽略', applyCodexModelMapping('  codex-auto-review  '), 'gpt-6-luna')
eq('其它前缀不改写目标', applyCodexModelMapping('gpt-6-sol'), 'gpt-6-sol')

// 运维覆盖表
eq('覆盖表缺省等于内置表', normalizeCodexModelMap(null), { 'codex-auto-review': 'gpt-6-luna' })
eq(
  '清空主目标回落 FALLBACK',
  normalizeCodexModelMap({ 'codex-auto-review': '' }),
  { 'codex-auto-review': FALLBACK_MODEL },
)
eq(
  '非 codex 键的空值不进入映射表',
  normalizeCodexModelMap({ 'codex-auto-review': null, extra: '' }),
  { 'codex-auto-review': FALLBACK_MODEL },
)
eq(
  '新增别名被合并进来',
  normalizeCodexModelMap({ 'my-alias': 'gpt-6-astra' }),
  { 'codex-auto-review': 'gpt-6-luna', 'my-alias': 'gpt-6-astra' },
)
eq(
  '覆盖表参与重写',
  applyCodexModelMapping('my-alias', { map: normalizeCodexModelMap({ 'my-alias': 'gpt-6-astra' }) }),
  'gpt-6-astra',
)
eq(
  '空目标不再重写',
  applyCodexModelMapping('codex-auto-review', { map: { 'codex-auto-review': '' } }),
  'codex-auto-review',
)

// ═══════════════ 2. 平台判定与「重写在前」的顺序 ═══════════════

console.log('\n2. 平台判定（必须发生在重写之后）')

eq('gpt-6-astra 判为 openai', detectCodexPlatform('gpt-6-astra'), {
  ok: true, platform: 'openai', model: 'gpt-6-astra',
})
eq('claude 判为 anthropic', detectCodexPlatform('claude-sonnet-4-20250514'), {
  ok: true, platform: 'anthropic', model: 'claude-sonnet-4-20250514',
})
eq('claude 别名判为 anthropic', detectCodexPlatform('anthropic.claude-3-7-sonnet').platform, 'anthropic')
eq('图像模型不算对话模型', detectCodexPlatform('gpt-image-2.5-flare').code, 'model_not_supported')
eq('空模型报 model_required', detectCodexPlatform('').code, 'model_required')
eq('未知模型不猜平台', detectCodexPlatform('whatever-1').code, 'model_not_supported')

// 这一组是这个模块存在的理由：直接判定别名会失败，先重写再判定就通过
eq('别名直接判定会失败（顺序错了的后果）', detectCodexPlatform('codex-auto-review').ok, false)
eq(
  '先重写再判定则通过',
  detectCodexPlatform(applyCodexModelMapping('codex-auto-review')),
  { ok: true, platform: 'openai', model: 'gpt-6-luna' },
)

const resolvedAlias = resolveCodexInboundModel('codex-auto-review')
eq('resolve 保留客户端原始模型名', resolvedAlias.requestedModel, 'codex-auto-review')
eq('resolve 给出上游模型', resolvedAlias.upstreamModel, 'gpt-6-luna')
eq('resolve 标记已重写', resolvedAlias.mapped, true)
eq('resolve 的平台来自重写后的 id', resolvedAlias.platform.platform, 'openai')

const resolvedPlain = resolveCodexInboundModel('gpt-6-astra')
eq('真模型不标记重写', resolvedPlain.mapped, false)
eq('真模型平台判定不变', resolvedPlain.platform.platform, 'openai')

// ═══════════════ 3. 额度门禁：窗口打满即不可选 ═══════════════

console.log('\n3. 额度门禁（canTake 追加条件）')

const ACCOUNTS = [{ id: 'a1' }, { id: 'a2' }]

/** 用可变的窗口表构造调度器：改 windows 对象即可模拟上游读数变化 */
function makeQuotaScheduler({ clock, windows, logger = null, accounts = ACCOUNTS, quota } = {}) {
  const state = { windows }
  const sch = new AccountScheduler(accounts, {
    now: clock.now,
    logger,
    quota: quota === undefined ? { windows: (id) => state.windows[id] ?? null } : quota,
  })
  return { sch, state }
}

{
  const clock = makeClock()
  const reset5h = clock.now() + 3_600_000
  // 5h 打满：读数 100%、reset 在未来
  const { sch, state } = makeQuotaScheduler({
    clock,
    windows: { a1: { '5h': win(100, reset5h), '7d': win(10, reset5h, '7d') }, a2: { '5h': win(12, reset5h) } },
  })
  eq('打满窗口的号不可选', sch.canTake(sch.accounts[0]), false)
  eq('未满的号可选', sch.canTake(sch.accounts[1]), true)
  eq('打满后进入 park', sch.isQuotaParked('a1'), true)
  eq('park 到期时间等于窗口 reset', sch.parkedUntil.get('a1').until, reset5h)
  eq('park 成因', sch.parkedUntil.get('a1').reason, '5h_exhausted')
  // 还有一个健康的号：select 应当跳过打满的 a1 直接选 a2
  eq('select 跳过打满的号', sch.select().account.id, 'a2')

  // 熔断线是 95（accountGate 缺省），不是 100：96% 就已经不该再撞
  state.windows.a1 = { '5h': win(96, reset5h) }
  sch.unparkAccount('a1')
  eq('96% 已过熔断线', sch.canTake(sch.accounts[0]), false)

  state.windows.a1 = { '5h': win(94, reset5h) }
  sch.unparkAccount('a1')
  eq('94% 未到熔断线', sch.canTake(sch.accounts[0]), true)
  eq('未熔断时不 park', sch.isQuotaParked('a1'), false)

  // 上游明确 rejected 优先于读数：utilization 还低也要停
  state.windows.a1 = { '5h': win(20, reset5h, '5h', { status: 'rejected' }) }
  sch.unparkAccount('a1')
  eq('rejected 状态即使读数低也拦', sch.canTake(sch.accounts[0]), false)
}

{
  // 7d 窗口单独打满同样要拦
  const clock = makeClock()
  const reset7d = clock.now() + 2 * 86_400_000
  const { sch } = makeQuotaScheduler({
    clock,
    windows: { a1: { '5h': win(5, clock.now() + 600_000), '7d': win(98, reset7d, '7d') } },
  })
  eq('7d 打满也拦', sch.canTake(sch.accounts[0]), false)
  eq('park 到 7d 的 reset', sch.parkedUntil.get('a1').until, reset7d)
  eq('park 成因是 7d', sch.parkedUntil.get('a1').reason, '7d_exhausted')
}

// ═══════════════ 4. 额度数据缺失不得阻止选中 ═══════════════

console.log('\n4. 额度数据缺失 → 放行')

{
  const clock = makeClock()
  // a1 从没请求过（null），a2 有窗口但两个都是 null（配额头里没字段）
  const { sch } = makeQuotaScheduler({
    clock,
    windows: { a1: null, a2: { '5h': null, '7d': null } },
  })
  eq('无读数放行（账号刚加）', sch.canTake(sch.accounts[0]), true)
  eq('窗口全 null 放行', sch.canTake(sch.accounts[1]), true)
  eq('无读数不产生 park', sch.parkedUntil.size, 0)
  eq('无读数时可正常 select', selectError(sch), null)
}

{
  // 读数来源整个缺失（返回 undefined）也不该拦
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now, quota: { windows: () => undefined } })
  eq('读数来源返回 undefined 放行', sch.canTake(sch.accounts[0]), true)
}

{
  // 台账实现抛错：额度是旁路信号，不能让请求路径崩掉
  const clock = makeClock()
  const logger = makeLogger()
  const sch = new AccountScheduler([{ id: 'a1' }], {
    now: clock.now,
    logger,
    quota: { windows: () => { throw new Error('quota backend down') } },
  })
  eq('读数抛错时放行', sch.canTake(sch.accounts[0]), true)
  ok(
    '读数抛错时留下 WARN',
    logger.lines.some((l) => l.level === 'warn' && /quota reading failed/.test(l.message)),
    JSON.stringify(logger.lines.map((l) => l.message)),
  )
}

{
  // 没接线（旧行为）：读数完全不参与
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now, logger: null })
  eq('未接线时额度不影响', sch.canTake(sch.accounts[0]), true)
  eq('未接线时 quotaEnabled 为 false', sch.quotaEnabled, false)
  eq('未接线时 quotaSnapshot.enabled 为 false', sch.quotaSnapshot().enabled, false)
  eq('quota: false 等同未接线', new AccountScheduler([{ id: 'a1' }], { quota: false, logger: null }).quotaEnabled, false)
}

// ═══════════════ 5. park 是软的：到 reset 自动解除 ═══════════════

console.log('\n5. park 软解除')

{
  const clock = makeClock()
  const reset5h = clock.now() + 1_800_000
  // 上游读数一直停在打满状态，reset 时间过去后由 effectiveWindow 惰性清零
  const { sch, state } = makeQuotaScheduler({
    clock,
    windows: { a1: { '5h': win(100, reset5h) } },
  })
  eq('打满时不可选', sch.canTake(sch.accounts[0]), false)
  clock.set(reset5h - 1000)
  eq('reset 前 1 秒仍不可选', sch.canTake(sch.accounts[0]), false)
  clock.set(reset5h)
  eq('reset 时刻自动解除', sch.canTake(sch.accounts[0]), true)
  eq('解除后 park 记录被清掉', sch.parkedUntil.size, 0)
  eq('旧读数不再触发 park', sch.isQuotaParked('a1'), false)
  // 读数没变，只因为跨过了 reset 就该重新可用：这正是「不持有过期快照」的意义
  eq('窗口读数仍是旧值', state.windows.a1['5h'].usedPct, 100)
}

{
  // 上游说用满了但没给 reset 时钟 → 兜底 park，到期同样自动解除
  const clock = makeClock()
  const logger = makeLogger()
  let verdict = { allowed: false, reason: '5h_exhausted', resumeAt: null, level: 'stop' }
  const sch = new AccountScheduler([{ id: 'a1' }], {
    now: clock.now,
    logger,
    quota: { gate: () => verdict },
  })
  eq('无 reset 时钟时不可选', sch.canTake(sch.accounts[0]), false)
  eq('兜底 park 时长', sch.parkedUntil.get('a1').until - clock.now(), QUOTA_PARK_FALLBACK_SECS * 1000)
  eq('兜底标记', sch.parkedUntil.get('a1').fallback, true)
  const parkedLine = logger.lines.find((l) => /account paused for quota/.test(l.message))
  ok('park 日志带暂停秒数', parkedLine?.fields?.park_secs === QUOTA_PARK_FALLBACK_SECS, JSON.stringify(parkedLine))
  ok('park 日志能看出账号与成因',
    parkedLine?.fields?.account === 'a1' && parkedLine?.fields?.reason === '5h_exhausted',
    JSON.stringify(parkedLine))

  clock.advance(QUOTA_PARK_FALLBACK_SECS * 1000 - 1)
  eq('兜底 park 到期前仍拦', sch.canTake(sch.accounts[0]), false)
  // 兜底 park 到期后仍需重判：读数依旧说满了，就再 park 一轮
  clock.advance(2)
  verdict = { allowed: true, reason: 'ok', resumeAt: null, level: 'ok' }
  eq('兜底 park 到期后自动解除', sch.canTake(sch.accounts[0]), true)
  ok(
    '解除时留下 info 日志',
    logger.lines.some((l) => l.level === 'info' && /quota pause lifted/.test(l.message)),
    JSON.stringify(logger.lines.map((l) => l.message)),
  )
}

{
  // 手动解除（运维入口）
  const clock = makeClock()
  const { sch } = makeQuotaScheduler({ clock, windows: { a1: { '5h': win(100, clock.now() + 600_000) } } })
  eq('先被 park', sch.canTake(sch.accounts[0]), false)
  eq('手动解除返回 true', sch.unparkAccount('a1'), true)
  eq('手动解除后再回去仍会被读数重新 park', sch.canTake(sch.accounts[0]), false)
  eq('不存在时解除返回 false', sch.unparkAccount('nope'), false)
}

{
  // gate 读数路径：调度器只读 allowed / resumeAt
  const clock = makeClock()
  const resetAt = clock.now() + 900_000
  const sch = new AccountScheduler([{ id: 'a1' }], {
    now: clock.now,
    logger: null,
    quota: { gate: () => ({ allowed: false, reason: '5h_exhausted', resumeAt: resetAt, level: 'stop' }) },
  })
  eq('gate 读数被采纳', sch.canTake(sch.accounts[0]), false)
  eq('gate 的 resumeAt 变成 park 到期时间', sch.parkedUntil.get('a1').until, resetAt)
}

// ═══════════════ 6. 全 park 时的对外错误码 ═══════════════

console.log('\n6. 全 park 的错误码与 retryAt')

{
  const clock = makeClock()
  const soon = clock.now() + 120_000
  const later = clock.now() + 900_000
  const { sch } = makeQuotaScheduler({
    clock,
    accounts: [{ id: 'a1' }, { id: 'a2' }],
    windows: {
      a1: { '5h': win(100, later) },
      a2: { '5h': win(100, soon) },
    },
  })
  eq('a1 打满', sch.canTake(sch.accounts[0]), false)
  eq('a2 打满', sch.canTake(sch.accounts[1]), false)
  const err = selectError(sch)
  eq('全部因额度被挡时错误码', err?.code, 'quota_exhausted')
  eq('retryAt 取最早 reset', err?.retryAt, soon)
  ok('错误消息带剩余秒数', /retry in 120s/.test(err?.message || ''), err?.message)
  eq('quotaSnapshot 列出两个 park', sch.quotaSnapshot().parked.length, 2)
  eq('quotaSnapshot 按剩余时间升序', sch.quotaSnapshot().parked[0].account_id, 'a2')
  eq('quotaSnapshot 的 soonest 就是最早 reset', sch.quotaSnapshot().soonest_unpark_at, soon)
}

{
  // 混合原因（一个额度、一个冷却）仍报 all_rejected：不把非额度问题说成额度问题
  const clock = makeClock()
  const { sch } = makeQuotaScheduler({
    clock,
    accounts: [{ id: 'a1' }, { id: 'a2' }],
    windows: { a1: { '5h': win(100, clock.now() + 600_000) }, a2: null },
  })
  sch.markCooldown('a2', { status: 500 })
  eq('a1 因额度被挡', sch.canTake(sch.accounts[0]), false)
  eq('a2 因冷却被挡', sch.canTake(sch.accounts[1]), false)
  eq('混合原因报 all_rejected', selectError(sch)?.code, 'all_rejected')
}

// ═══════════════ 7. 原有冷却 / 并发 / RPM 行为不变 ═══════════════

console.log('\n7. 冷却 / 并发 / RPM 不受影响')

{
  const clock = makeClock()
  // 故意接线额度但读数健康：证明额度是追加条件，不是替换
  const { sch } = makeQuotaScheduler({
    clock,
    accounts: [{ id: 'a1' }, { id: 'a2' }],
    windows: { a1: { '5h': win(10, clock.now() + 3_600_000) }, a2: { '5h': win(10, clock.now() + 3_600_000) } },
  })
  eq('初始可选', sch.canTake(sch.accounts[0]), true)
  const secs = sch.markCooldown('a1', { status: 500 })
  eq('冷却时长未被额度影响', secs, DEFAULT_COOLDOWN_SECS)
  eq('冷却中不可选', sch.canTake(sch.accounts[0]), false)
  eq('另一账号不受牵连', sch.canTake(sch.accounts[1]), true)
  clock.advance(DEFAULT_COOLDOWN_SECS * 1000)
  eq('冷却到期恢复', sch.canTake(sch.accounts[0]), true)
}

{
  const clock = makeClock()
  const { sch } = makeQuotaScheduler({
    clock,
    accounts: [{ id: 'a1', max_concurrency: 1 }],
    windows: { a1: { '5h': win(10, clock.now() + 3_600_000) } },
  })
  eq('并发未满可选', sch.canTake(sch.accounts[0]), true)
  sch.hold({ account: sch.accounts[0] }, {})
  eq('并发满时不可选', sch.canTake(sch.accounts[0]), false)
  sch.release('a1')
  eq('释放后恢复', sch.canTake(sch.accounts[0]), true)
}

{
  const clock = makeClock()
  const { sch } = makeQuotaScheduler({
    clock,
    accounts: [{ id: 'a1', rpm: 2 }],
    windows: { a1: { '5h': win(10, clock.now() + 3_600_000) } },
  })
  eq('第 1 次可选', sch.canTake(sch.accounts[0]), true)
  sch.hold({ account: sch.accounts[0] }, {})
  eq('第 2 次可选', sch.canTake(sch.accounts[0]), true)
  sch.hold({ account: sch.accounts[0] }, {})
  eq('RPM 用满后不可选', sch.canTake(sch.accounts[0]), false)
  clock.advance(RPM_WINDOW_SECS * 1000 + 1)
  eq('滑窗过期后恢复', sch.canTake(sch.accounts[0]), true)
}

{
  // setAccounts 清理 park 残留：否则 retryAt 会指向一个已不存在的账号
  const clock = makeClock()
  const { sch } = makeQuotaScheduler({
    clock,
    accounts: [{ id: 'a1' }, { id: 'a2' }],
    windows: { a1: { '5h': win(100, clock.now() + 600_000) }, a2: null },
  })
  eq('a1 被 park', sch.canTake(sch.accounts[0]), false)
  sch.setAccounts([{ id: 'a2' }])
  eq('被移除账号的 park 被清掉', sch.parkedUntil.size, 0)
  eq('剩余账号不受影响', sch.canTake(sch.accounts[0]), true)
}

// ═══════════════ 8. 端到端：上游配额头 → 调度 → 恢复 ═══════════════

console.log('\n8. 端到端（假 fetch，真串一遍路由）')

function buildUpstreamSse({ text = '收到', model = 'gpt-6-astra', respId = 'resp_q' } = {}) {
  const frames = [
    ['response.created', { type: 'response.created', response: { id: respId, model, status: 'in_progress', output: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text }],
    ['response.output_item.done', {
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
    }],
    ['response.completed', {
      type: 'response.completed',
      response: {
        id: respId, object: 'response', status: 'completed', model,
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      },
    }],
  ]
  return frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
}

/** 假 fetch：恒回 SSE，配额头由调用方按次给 */
function makeFakeFetch({ headers = null } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    const extra = typeof headers === 'function' ? (headers(calls.length) || {}) : (headers || {})
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(buildUpstreamSse()))
        c.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'x-codex-plan-type': 'pro', ...extra } })
  }
  fn.calls = calls
  return fn
}

function makeTempCredential(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-'))
  const file = path.join(dir, 'cred.json')
  fs.writeFileSync(file, JSON.stringify(content))
  return { file, dir }
}

async function startServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      if (await handler.handle(req, res)) return
      res.writeHead(404)
      res.end()
    } catch {
      if (!res.headersSent) { res.writeHead(500) }
      res.end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { port, close: () => new Promise((r) => server.close(r)) }
}

async function request({ port, route, body }) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* SSE 或空体 */ }
  return { status: res.status, headers: Object.fromEntries(res.headers), text, parsed }
}

{
  const clock = makeClock()
  const reset5h = clock.now() + 3_600_000
  const cred = makeTempCredential({
    accounts: [
      { id: 'q1', access_token: 'T1', chatgpt_account_id: 'c1', expires_at: 4102444800 },
    ],
  })
  // 第一个响应就把 5h 打到 100%，reset 在 1 小时后
  const fake = makeFakeFetch({
    headers: {
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-reset-at': String(Math.floor(reset5h / 1000)),
      'x-codex-primary-window-minutes': '300',
      'x-codex-secondary-used-percent': '12',
      'x-codex-secondary-window-minutes': '10080',
    },
  })
  const silent = { warn() {}, info() {} }
  const handler = createCodexHandler({
    credentialPath: cred.file,
    fetchImpl: fake,
    logger: silent,
    quota: { now: clock.now },
  })
  const srv = await startServer(handler)
  try {
    const first = await request({
      port: srv.port,
      route: '/v1/chat/completions',
      // 顺便验证别名在真实链路上被重写：客户端发 codex-auto-review
      body: { model: 'codex-auto-review', messages: [{ role: 'user', content: 'hi' }], stream: false },
    })
    eq('首个请求成功', first.status, 200)
    eq('响应体回的是真正跑的上游模型', first.parsed.model, 'gpt-6-luna')

    // 上游收到的 body 里模型已被重写（zstd 解压后看真实线上字节）
    const sent = JSON.parse(zlib.zstdDecompressSync(Buffer.from(fake.calls[0].init.body)).toString())
    eq('上游收到的是映射后的模型', sent.model, 'gpt-6-luna')

    // 配额头已经进 store
    eq('窗口读数被记录', handler.quotaStore.gate('q1').limited, ['5h'])

    // 第二个请求：额度已打满，调度器应当直接挡住，不再打上游
    const before = fake.calls.length
    const second = await request({
      port: srv.port,
      route: '/v1/chat/completions',
      body: { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }], stream: false },
    })
    eq('打满后不再请求上游', fake.calls.length, before)
    eq('对外状态码', second.status, 503)
    eq('对外错误码', second.parsed.error.code, 'quota_exhausted')

    const expectSecs = Math.ceil((reset5h - clock.now()) / 1000)
    eq('响应体 retry_after 指向窗口 reset', second.parsed.error.retry_after, expectSecs)
    eq('Retry-After 头同源', second.headers['retry-after'], String(expectSecs))
    eq('healthz 能看到 park', handler.scheduler.quotaSnapshot().parked[0].account_id, 'q1')
    eq('healthz 的 park 剩余秒数', handler.scheduler.quotaSnapshot().parked[0].secs_left, expectSecs)

    // 越过 reset：park 自动解除，请求重新打到上游
    clock.set(reset5h + 1000)
    const callsBefore = fake.calls.length
    const third = await request({
      port: srv.port,
      route: '/v1/chat/completions',
      body: { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }], stream: false },
    })
    eq('reset 后重新打到上游', fake.calls.length, callsBefore + 1)
    eq('reset 后请求成功', third.status, 200)
    eq('reset 后 park 已清空', handler.scheduler.quotaSnapshot().parked.length, 0)
  } finally {
    await srv.close()
  }
}

{
  // 观测模式：quota.enabled=false 只记录不拦
  const cred = makeTempCredential({
    accounts: [{ id: 'q2', access_token: 'T2', chatgpt_account_id: 'c2', expires_at: 4102444800 }],
  })
  const fake = makeFakeFetch({
    headers: {
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-reset-at': String(Math.floor((Date.now() + 3_600_000) / 1000)),
      'x-codex-primary-window-minutes': '300',
    },
  })
  const handler = createCodexHandler({
    credentialPath: cred.file,
    fetchImpl: fake,
    logger: { warn() {}, info() {} },
    quota: { enabled: false },
  })
  const srv = await startServer(handler)
  try {
    for (let i = 0; i < 2; i += 1) {
      const r = await request({
        port: srv.port,
        route: '/v1/responses',
        body: { model: 'gpt-6-astra', input: 'hi', stream: false },
      })
      eq(`观测模式第 ${i + 1} 次仍放行`, r.status, 200)
    }
    eq('观测模式仍记录读数', handler.quotaStore.gate('q2').windows['5h'].usedPct, 100)
    eq('观测模式不 park', handler.scheduler.quotaSnapshot().parked.length, 0)
  } finally {
    await srv.close()
  }
}

{
  // quota: false 完全关闭额度链路，行为回到旧版
  const cred = makeTempCredential({
    accounts: [{ id: 'q3', access_token: 'T3', chatgpt_account_id: 'c3', expires_at: 4102444800 }],
  })
  const fake = makeFakeFetch({ headers: { 'x-codex-primary-used-percent': '100' } })
  const handler = createCodexHandler({
    credentialPath: cred.file,
    fetchImpl: fake,
    logger: { warn() {}, info() {} },
    quota: false,
  })
  eq('quota:false 不建 store', handler.quotaStore, null)
  eq('quota:false 不接线调度器', handler.scheduler.quotaEnabled, false)
  const srv = await startServer(handler)
  try {
    for (let i = 0; i < 2; i += 1) {
      const r = await request({
        port: srv.port,
        route: '/v1/responses',
        body: { model: 'gpt-6-astra', input: 'hi', stream: false },
      })
      eq(`关闭额度后第 ${i + 1} 次放行`, r.status, 200)
    }
  } finally {
    await srv.close()
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
