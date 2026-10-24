#!/usr/bin/env node
/**
 * 配额窗口模型与配额存储的单元测试。
 *
 * 覆盖范围：
 *   1. 两套响应头命名（Anthropic unified / Codex primary-secondary）解析
 *   2. 窗口到期自动清零
 *   3. 85% 预警、95% 熔断的边界（84.9 / 85 / 85.1 / 94.9 / 95 / 95.1）
 *   4. 全账号超限时选最接近重置的
 *   5. 缺字段、畸形值不崩
 *   6. 5h 与 7d 任一超限都熔断
 *   7. snapshot 可序列化
 *
 * 全部为纯函数 / 内存态断言，不建立网络连接、不读写文件。
 * 运行：node test/quota.mjs
 */

import {
  WINDOW_5H_MINUTES,
  WINDOW_7D_MINUTES,
  WINDOW_5H_MS,
  WINDOW_7D_MS,
  QUOTA_WINDOW_KEYS,
  DEFAULT_WARN_PCT,
  DEFAULT_STOP_PCT,
  lowerCaseHeaders,
  headerValue,
  toUsedPct,
  parseResetAt,
  normalizeStatus,
  isRejectedStatus,
  windowKeyFromMinutes,
  clampPct,
  thresholdsOf,
  parseQuotaHeaders,
  isWindowReset,
  effectiveWindow,
  resetInSecs,
  windowPressure,
  accountGate,
  pickSoonestReset,
} from '../src/quota-window.mjs'

import { QuotaStore, quotaStoreFromConfig } from '../src/quota-store.mjs'
import { SlotScheduler } from '../src/scheduler.mjs'

let pass = 0
let fail = 0

const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log('  ok   ', name)
  } else {
    fail++
    console.log('  FAIL ', name, '\n         got ', g, '\n         want', w)
  }
}

const ok = (name, cond) => eq(name, Boolean(cond), true)

/** 固定基准时刻：2026-01-01T00:00:00Z */
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0)
const HOUR = 3600_000
const MIN = 60_000

// ═══════════════════════════════════ 1. 常量与基础归一

console.log('\n── 常量 ──')
eq('5h 窗口分钟数', WINDOW_5H_MINUTES, 300)
eq('7d 窗口分钟数', WINDOW_7D_MINUTES, 10080)
eq('5h 窗口毫秒', WINDOW_5H_MS, 5 * HOUR)
eq('7d 窗口毫秒', WINDOW_7D_MS, 168 * HOUR)
eq('窗口键顺序', [...QUOTA_WINDOW_KEYS], ['5h', '7d'])
eq('缺省预警阈值', DEFAULT_WARN_PCT, 85)
eq('缺省熔断阈值', DEFAULT_STOP_PCT, 95)

console.log('\n── 响应头归一 ──')
const plainHeaders = { 'Anthropic-Ratelimit-Unified-5h-Utilization': '0.5', 'X-Codex-Primary-Used-Percent': '30' }
const lowered = lowerCaseHeaders(plainHeaders)
eq('普通对象键转小写', lowered['anthropic-ratelimit-unified-5h-utilization'], '0.5')
eq('普通对象保留原值', lowered['x-codex-primary-used-percent'], '30')

// WHATWG Headers 形态（fetch / undici 的 res.headers）
const whatwg = new Headers()
whatwg.set('x-codex-primary-used-percent', '42')
const fromWhatwg = lowerCaseHeaders(whatwg)
eq('Headers 实例可摊平', fromWhatwg['x-codex-primary-used-percent'], '42')

// 数组值（Node http 模块对重复头的行为）
eq('数组值取首个', lowerCaseHeaders({ 'x-a': ['1', '2'] })['x-a'], '1')
eq('null headers 不崩', lowerCaseHeaders(null), {})
eq('字符串 headers 不崩', lowerCaseHeaders('oops'), {})
eq('数字 headers 不崩', lowerCaseHeaders(42), {})

console.log('\n── 单头读取 ──')
eq('头存在', headerValue({ a: '1' }, 'a'), '1')
eq('头缺失', headerValue({ a: '1' }, 'b'), null)
eq('空串归 null', headerValue({ a: '  ' }, 'a'), null)
eq('null headers', headerValue(null, 'a'), null)

// ═══════════════════════════════════ 2. 百分比归一

console.log('\n── 百分比归一 ──')
eq('ratio 0.85 → 85', toUsedPct('0.85', 'ratio'), 85)
eq('ratio 0 → 0', toUsedPct('0', 'ratio'), 0)
eq('ratio 1 → 100', toUsedPct('1', 'ratio'), 100)
eq('ratio 超 1.5 视为已是百分比', toUsedPct('85', 'ratio'), 85)
eq('percent 85 → 85（不二次换算）', toUsedPct('85', 'percent'), 85)
eq('percent 0.85 → 0.85（不放大）', toUsedPct('0.85', 'percent'), 0.85)
eq('百分号后缀可剥离', toUsedPct('85%', 'percent'), 85)
eq('负数夹到 0', toUsedPct('-5', 'percent'), 0)
eq('超 100 夹到 100', toUsedPct('150', 'percent'), 100)
eq('非数字返回 null', toUsedPct('abc'), null)
eq('空值返回 null', toUsedPct(null), null)
eq('空串返回 null', toUsedPct('', 'percent'), null)
eq('两位小数保留', toUsedPct('0.8512', 'ratio'), 85.12)

// ═══════════════════════════════════ 3. 重置时间解析

console.log('\n── 重置时间解析 ──')
const sec = T0 / 1000
eq('unix 秒转毫秒', parseResetAt(sec), T0)
eq('unix 毫秒原样', parseResetAt(T0), T0)
eq('字符串秒转毫秒', parseResetAt(String(sec)), T0)
eq('ISO 字符串可解析', parseResetAt('2026-01-01T00:00:00.000Z'), T0)
eq('RFC3339 带偏移可解析', parseResetAt('2025-12-31T16:00:00-08:00'), T0)
eq('非法字符串返回 null', parseResetAt('not-a-date'), null)
eq('空串返回 null', parseResetAt(''), null)
eq('null 返回 null', parseResetAt(null), null)
eq('负数返回 null', parseResetAt(-1), null)
eq('零返回 null', parseResetAt(0), null)

console.log('\n── 状态归一 ──')
eq('allowed 归一为 active', normalizeStatus('allowed'), 'active')
eq('rate_limited 归一为 rejected', normalizeStatus('rate_limited'), 'rejected')
eq('大小写不敏感', normalizeStatus('REJECTED'), 'rejected')
eq('未知值保留', normalizeStatus('weird'), 'weird')
eq('空串归 null', normalizeStatus('  '), null)
ok('rejected 判为已拒绝', isRejectedStatus('rejected'))
ok('exhausted 判为已拒绝', isRejectedStatus('exhausted'))
ok('active 不是已拒绝', !isRejectedStatus('active'))
ok('null 不是已拒绝', !isRejectedStatus(null))

console.log('\n── 窗口键推断 ──')
eq('300 分钟 → 5h', windowKeyFromMinutes(300), '5h')
eq('10080 分钟 → 7d', windowKeyFromMinutes(10080), '7d')
eq('1440 分钟 → 7d', windowKeyFromMinutes(1440), '7d')
eq('缺失用 fallback', windowKeyFromMinutes(null, '7d'), '7d')
eq('非法值用 fallback', windowKeyFromMinutes('abc', '5h'), '5h')

// ═══════════════════════════════════ 4. 阈值归一

console.log('\n── 阈值归一 ──')
eq('缺省阈值', thresholdsOf({}), { warn: 85, stop: 95 })
eq('自定义阈值', thresholdsOf({ warnPct: 70, stopPct: 90 }), { warn: 70, stop: 90 })
eq('warn >= stop 时整对回退', thresholdsOf({ warnPct: 95, stopPct: 90 }), { warn: 85, stop: 95 })
eq('warn == stop 时整对回退', thresholdsOf({ warnPct: 90, stopPct: 90 }), { warn: 85, stop: 95 })
eq('非法值回退', thresholdsOf({ warnPct: 'abc', stopPct: null }), { warn: 85, stop: 95 })
eq('超过 100 回退', thresholdsOf({ warnPct: 101, stopPct: 95 }), { warn: 85, stop: 95 })
eq('非正数回退', thresholdsOf({ warnPct: 0, stopPct: 95 }), { warn: 85, stop: 95 })

// ═══════════════════════════════════ 5. Anthropic 头解析

console.log('\n── Anthropic 响应头解析 ──')
const reset5h = T0 + 2 * HOUR
const reset7d = T0 + 5 * 24 * HOUR

const anthropicHeaders = {
  'anthropic-ratelimit-unified-5h-utilization': '0.42',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor(reset5h / 1000)),
  'anthropic-ratelimit-unified-7d-utilization': '0.68',
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor(reset7d / 1000)),
}
const aParsed = parseQuotaHeaders(anthropicHeaders, { now: T0 })
eq('Anthropic 5h 已用比例', aParsed['5h'].usedPct, 42)
eq('Anthropic 7d 已用比例', aParsed['7d'].usedPct, 68)
eq('Anthropic 5h 重置时间', aParsed['5h'].resetAt, T0 + 2 * HOUR)
eq('Anthropic 7d 重置时间', aParsed['7d'].resetAt, T0 + 5 * 24 * HOUR)
eq('Anthropic 来源标记', aParsed.source, 'anthropic')
eq('5h 窗口长度', aParsed['5h'].windowMinutes, 300)
eq('7d 窗口长度', aParsed['7d'].windowMinutes, 10080)

const aRejected = parseQuotaHeaders({
  'anthropic-ratelimit-unified-5h-utilization': '1',
  'anthropic-ratelimit-unified-5h-status': 'rejected',
}, { now: T0 })
eq('Anthropic 状态解析', aRejected['5h'].status, 'rejected')
eq('Anthropic 满额', aRejected['5h'].usedPct, 100)
eq('Anthropic 缺 7d → null', aRejected['7d'], null)

// ═══════════════════════════════════ 6. Codex 头解析

console.log('\n── Codex 响应头解析 ──')
const codexHeaders = {
  'x-codex-primary-used-percent': '55',
  'x-codex-primary-reset-at': String(Math.floor(reset5h / 1000)),
  'x-codex-primary-window-minutes': '300',
  'x-codex-secondary-used-percent': '12',
  'x-codex-secondary-reset-at': String(Math.floor(reset7d / 1000)),
  'x-codex-secondary-window-minutes': '10080',
}
const cParsed = parseQuotaHeaders(codexHeaders, { now: T0 })
eq('Codex primary → 5h', cParsed['5h'].usedPct, 55)
eq('Codex secondary → 7d', cParsed['7d'].usedPct, 12)
eq('Codex 百分比不二次换算', cParsed['5h'].usedPct, 55)
eq('Codex 5h 重置', cParsed['5h'].resetAt, T0 + 2 * HOUR)
eq('Codex 来源标记', cParsed.source, 'codex')

// primary 指向 7d 时按分钟数归位，不盲目套经验映射
const swapped = parseQuotaHeaders({
  'x-codex-primary-used-percent': '77',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-secondary-used-percent': '20',
  'x-codex-secondary-window-minutes': '300',
}, { now: T0 })
eq('primary 按分钟数归到 7d', swapped['7d'].usedPct, 77)
eq('secondary 按分钟数归到 5h', swapped['5h'].usedPct, 20)

// 缺 window-minutes 时用经验映射
const noMinutes = parseQuotaHeaders({ 'x-codex-primary-used-percent': '33' }, { now: T0 })
eq('缺 minutes 按 primary→5h 兜底', noMinutes['5h'].usedPct, 33)

// 两套头同时出现时 Anthropic 优先
const both = parseQuotaHeaders({
  ...codexHeaders,
  'anthropic-ratelimit-unified-5h-utilization': '0.9',
}, { now: T0 })
eq('Anthropic 覆盖同键 Codex', both['5h'].usedPct, 90)
eq('Anthropic 未覆盖的 7d 保留 Codex', both['7d'].usedPct, 12)
eq('混合来源标记', both.source, 'mixed')

// ═══════════════════════════════════ 7. 畸形输入

console.log('\n── 畸形输入不崩 ──')
eq('无配额头返回 null', parseQuotaHeaders({ 'content-type': 'text/html' }, { now: T0 }), null)
eq('空对象返回 null', parseQuotaHeaders({}, { now: T0 }), null)
eq('null 返回 null', parseQuotaHeaders(null, { now: T0 }), null)
eq('非对象返回 null', parseQuotaHeaders('x', { now: T0 }), null)

const malformed = parseQuotaHeaders({
  'anthropic-ratelimit-unified-5h-utilization': 'not-a-number',
  'anthropic-ratelimit-unified-5h-reset': 'garbage',
}, { now: T0 })
eq('畸形比例归 0', malformed['5h'].usedPct, 0)
eq('畸形重置归 null', malformed['5h'].resetAt, null)

// ratio > 1.5 视为上游已换算成百分比，3.5 就是 3.5%；真正的超范围值才夹取
const overshoot = parseQuotaHeaders({ 'anthropic-ratelimit-unified-7d-utilization': '3.5' }, { now: T0 })
eq('比例 3.5 视为已是百分比', overshoot['7d'].usedPct, 3.5)
const overflow = parseQuotaHeaders({ 'anthropic-ratelimit-unified-7d-utilization': '150' }, { now: T0 })
eq('百分比超 100 夹到 100', overflow['7d'].usedPct, 100)

const zeroMin = parseQuotaHeaders({ 'x-codex-primary-used-percent': '10', 'x-codex-primary-window-minutes': '0' }, { now: T0 })
eq('0 分钟回退缺省窗口长度', zeroMin['5h'].windowMinutes, 300)

// ═══════════════════════════════════ 8. 窗口重置

console.log('\n── 窗口重置清零 ──')
const liveWindow = { key: '5h', usedPct: 96, resetAt: T0 + HOUR, status: 'active', windowMinutes: 300, stale: false }
ok('未到期不算重置', !isWindowReset(liveWindow, T0))
ok('到期即重置', isWindowReset(liveWindow, T0 + HOUR))
ok('过期已重置', isWindowReset(liveWindow, T0 + 2 * HOUR))
ok('缺 resetAt 不算重置', !isWindowReset({ key: '5h', usedPct: 50 }, T0))
ok('null 窗口视为已重置', isWindowReset(null, T0))

const effLive = effectiveWindow(liveWindow, T0)
eq('未到期保留读数', effLive.usedPct, 96)
eq('未到期不打 stale', effLive.stale, false)

const effExpired = effectiveWindow(liveWindow, T0 + 2 * HOUR)
eq('到期后读数清零', effExpired.usedPct, 0)
eq('到期后 resetAt 清空', effExpired.resetAt, null)
eq('到期后标记 stale', effExpired.stale, true)
eq('到期后状态归 active', effExpired.status, 'active')
eq('原窗口未被改写', liveWindow.usedPct, 96)

eq('剩余秒数正常', resetInSecs(T0 + HOUR, T0), 3600)
eq('已过重置剩余 0', resetInSecs(T0 - HOUR, T0), 0)
eq('缺 resetAt 返回 null', resetInSecs(null, T0), null)

// 关键回归：96% 的窗口在重置后必须放行，不能被旧读数永久判死
const afterResetGate = accountGate(
  { '5h': { ...liveWindow, resetAt: T0 - MIN } },
  { now: T0 },
)
eq('过期窗口恢复放行', afterResetGate.allowed, true)
eq('过期窗口 level 归 ok', afterResetGate.level, 'ok')
eq('过期窗口 usedPct 归 0', afterResetGate.windows['5h'].usedPct, 0)

// ═══════════════════════════════════ 9. 阈值边界

console.log('\n── 阈值边界（84.9 / 85 / 85.1 / 94.9 / 95 / 95.1）──')
/** 构造一个未到期的窗口读数 */
const winAt = (pct, key = '5h') => ({ key, usedPct: pct, resetAt: T0 + HOUR, status: 'active', windowMinutes: 300, stale: false })

eq('84.9 → ok', windowPressure(winAt(84.9), { now: T0 }).level, 'ok')
eq('85   → warn', windowPressure(winAt(85), { now: T0 }).level, 'warn')
eq('85.1 → warn', windowPressure(winAt(85.1), { now: T0 }).level, 'warn')
eq('94.9 → warn', windowPressure(winAt(94.9), { now: T0 }).level, 'warn')
eq('95   → stop', windowPressure(winAt(95), { now: T0 }).level, 'stop')
eq('95.1 → stop', windowPressure(winAt(95.1), { now: T0 }).level, 'stop')

eq('84.9 不 near', windowPressure(winAt(84.9), { now: T0 }).near, false)
eq('85 near', windowPressure(winAt(85), { now: T0 }).near, true)
eq('85 剩余 15%', windowPressure(winAt(85), { now: T0 }).remainingPct, 15)
eq('95 剩余 5%', windowPressure(winAt(95), { now: T0 }).remainingPct, 5)

// 浮点容差：0.85 * 100 在部分算式下是 84.99999999999999，必须仍触发 warn
eq('浮点边界 84.999999999 仍 warn', windowPressure(winAt(84.9999999999), { now: T0 }).level, 'warn')

// 自定义阈值
eq('自定义 70/90：69 → ok', windowPressure(winAt(69), { warnPct: 70, stopPct: 90, now: T0 }).level, 'ok')
eq('自定义 70/90：70 → warn', windowPressure(winAt(70), { warnPct: 70, stopPct: 90, now: T0 }).level, 'warn')
eq('自定义 70/90：90 → stop', windowPressure(winAt(90), { warnPct: 70, stopPct: 90, now: T0 }).level, 'stop')

// 上游 rejected 状态优先于读数
const lowButRejected = { key: '5h', usedPct: 26, resetAt: T0 + HOUR, status: 'rejected', windowMinutes: 300, stale: false }
eq('读数低但 rejected → stop', windowPressure(lowButRejected, { now: T0 }).level, 'stop')

// ═══════════════════════════════════ 10. 账号门禁

console.log('\n── 账号门禁 ──')
const gateOk = accountGate({ '5h': winAt(40), '7d': winAt(50) }, { now: T0 })
eq('低读数放行', gateOk.allowed, true)
eq('低读数 level ok', gateOk.level, 'ok')
eq('低读数不 degraded', gateOk.degraded, false)

const gateWarn = accountGate({ '5h': winAt(88), '7d': winAt(50) }, { now: T0 })
eq('预警仍放行', gateWarn.allowed, true)
eq('预警 degraded', gateWarn.degraded, true)
eq('预警 level warn', gateWarn.level, 'warn')
eq('预警 reason', gateWarn.reason, '5h_warning')
eq('预警 windows 记录', [...gateWarn.warning], ['5h'])

const gateStop5h = accountGate({ '5h': winAt(96), '7d': winAt(50) }, { now: T0 })
eq('5h 熔断不放行', gateStop5h.allowed, false)
eq('5h 熔断 level stop', gateStop5h.level, 'stop')
eq('5h 熔断 reason', gateStop5h.reason, '5h_exhausted')
eq('5h 熔断 resumeAt', gateStop5h.resumeAt, T0 + HOUR)

const gateStop7d = accountGate({ '5h': winAt(10), '7d': winAt(97, '7d') }, { now: T0 })
eq('7d 熔断不放行', gateStop7d.allowed, false)
eq('7d 熔断 reason', gateStop7d.reason, '7d_exhausted')

// 5h 与 7d 同时超限时，resumeAt 取最早恢复的那个
const bothStop = accountGate({
  '5h': { key: '5h', usedPct: 99, resetAt: T0 + 4 * HOUR, status: 'active', windowMinutes: 300 },
  '7d': { key: '7d', usedPct: 99, resetAt: T0 + HOUR, status: 'active', windowMinutes: 10080 },
}, { now: T0 })
eq('双窗口超限取最早重置', bothStop.resumeAt, T0 + HOUR)
eq('双窗口超限 reason 指向最早的', bothStop.reason, '7d_exhausted')
eq('双窗口超限 limited 齐全', [...bothStop.limited], ['5h', '7d'])

// 无数据放行
const gateNoData = accountGate({}, { now: T0 })
eq('无窗口数据放行', gateNoData.allowed, true)
eq('无窗口数据 level ok', gateNoData.level, 'ok')
eq('null 窗口集放行', accountGate(null, { now: T0 }).allowed, true)

// 单窗口数据也参与判定
eq('只有 5h 数据时按 5h 判', accountGate({ '5h': winAt(96) }, { now: T0 }).allowed, false)

// ═══════════════════════════════════ 11. 最接近重置

console.log('\n── 全账号超限选最接近重置 ──')
const candidates = [
  { id: 'a', resumeAt: T0 + 5 * HOUR },
  { id: 'b', resumeAt: T0 + HOUR },
  { id: 'c', resumeAt: T0 + 3 * HOUR },
]
eq('选出 resumeAt 最小', pickSoonestReset(candidates).id, 'b')
eq('空列表返回 null', pickSoonestReset([]), null)
eq('null 返回 null', pickSoonestReset(null), null)
eq('缺 resumeAt 的候选排在后面',
  pickSoonestReset([{ id: 'x', resumeAt: null }, { id: 'y', resumeAt: T0 }]).id, 'y')
eq('全部缺 resumeAt 取首个',
  pickSoonestReset([{ id: 'x', resumeAt: null }, { id: 'y', resumeAt: null }]).id, 'x')
eq('单元素返回自身', pickSoonestReset([{ id: 'only', resumeAt: T0 }]).id, 'only')

// ═══════════════════════════════════ 12. QuotaStore

console.log('\n── QuotaStore：记录与门禁 ──')
const store = new QuotaStore({ now: () => T0 })

eq('未知账号 gate reason', store.gate('ghost').reason, 'no_data')
eq('未知账号放行', store.gate('ghost').allowed, true)
eq('未知账号不 degraded', store.gate('ghost').degraded, false)
eq('初始账号数为 0', store.size, 0)

const wrote = store.recordHeaders('acc-1', anthropicHeaders)
eq('记录成功返回 true', wrote, true)
eq('记录后账号数为 1', store.size, 1)
eq('5h 读数写入', store.gate('acc-1').windows['5h'].usedPct, 42)
eq('7d 读数写入', store.gate('acc-1').windows['7d'].usedPct, 68)
eq('42% 放行', store.gate('acc-1').allowed, true)

// 无配额头不覆盖已有状态
eq('无配额头返回 false', store.recordHeaders('acc-1', { 'content-type': 'text/plain' }), false)
eq('无配额头不清空 5h', store.gate('acc-1').windows['5h'].usedPct, 42)

// 单窗口更新保留另一窗口
store.recordHeaders('acc-1', { 'anthropic-ratelimit-unified-7d-utilization': '0.9' })
eq('单窗口更新后 5h 保留', store.gate('acc-1').windows['5h'].usedPct, 42)
eq('单窗口更新后 7d 更新', store.gate('acc-1').windows['7d'].usedPct, 90)

// 升到熔断
store.recordHeaders('acc-1', { 'anthropic-ratelimit-unified-5h-utilization': '0.96' })
const blocked = store.gate('acc-1')
eq('96% 熔断', blocked.allowed, false)
eq('96% blocked 标记', blocked.blocked, true)
eq('96% reason', blocked.reason, '5h_exhausted')
eq('96% resumeAt', blocked.resumeAt, T0 + 2 * HOUR)

// 重置清理
eq('重置账号返回 true', store.reset('acc-1'), true)
eq('重置后账号记录移除', store.size, 0)
eq('重置后 5h 无数据', store.gate('acc-1').windows['5h'], undefined)
eq('重置后 reason 为 no_data', store.gate('acc-1').reason, 'no_data')
eq('重置后放行', store.gate('acc-1').allowed, true)
eq('重置不存在的账号返回 false', store.reset('nope'), false)

// 窗口到期惰性清零
console.log('\n── QuotaStore：窗口到期惰性清零 ──')
let clock = T0
const timedStore = new QuotaStore({ now: () => clock })
timedStore.recordHeaders('acc-2', {
  'anthropic-ratelimit-unified-5h-utilization': '0.96',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor((T0 + HOUR) / 1000)),
})
eq('到期前熔断', timedStore.gate('acc-2').allowed, false)
clock = T0 + HOUR + 1
eq('到期后自动放行', timedStore.gate('acc-2').allowed, true)
eq('到期后读数归 0', timedStore.gate('acc-2').windows['5h'].usedPct, 0)
eq('到期后标记 stale', timedStore.gate('acc-2').windows['5h'].stale, true)

// 到期后新头重新计入
timedStore.recordHeaders('acc-2', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' })
eq('新窗口读数 10%', timedStore.gate('acc-2').windows['5h'].usedPct, 10)
eq('新窗口放行', timedStore.gate('acc-2').allowed, true)

// pruneExpired 真的回收存储
console.log('\n── QuotaStore：pruneExpired ──')
clock = T0
const pruneStore = new QuotaStore({ now: () => clock })
pruneStore.recordHeaders('acc-3', {
  'anthropic-ratelimit-unified-5h-utilization': '0.5',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor((T0 + HOUR) / 1000)),
})
eq('未到期不清理', pruneStore.pruneExpired('acc-3'), [])
clock = T0 + 2 * HOUR
eq('到期后清理 5h', pruneStore.pruneExpired('acc-3'), ['5h'])
eq('清理后窗口为 null', pruneStore.gate('acc-3').windows['5h'], undefined)

// enabled=false 只观察不拦
console.log('\n── QuotaStore：观察模式 ──')
const observeStore = new QuotaStore({ enabled: false, now: () => T0 })
observeStore.recordHeaders('acc-4', { 'anthropic-ratelimit-unified-5h-utilization': '0.99' })
eq('观察模式放行', observeStore.gate('acc-4').allowed, true)
eq('观察模式仍标 blocked', observeStore.gate('acc-4').blocked, true)
eq('观察模式 enabled 为 false', observeStore.gate('acc-4').enabled, false)

// 构造参数容错
console.log('\n── QuotaStore：构造容错 ──')
eq('非法阈值回退缺省', new QuotaStore({ warnPct: 'x', stopPct: null }).warnPct, 85)
eq('非法阈值回退缺省 stop', new QuotaStore({ warnPct: 'x', stopPct: null }).stopPct, 95)
eq('自定义阈值生效', new QuotaStore({ warnPct: 60, stopPct: 80 }).stopPct, 80)
eq('非函数时钟不崩', typeof new QuotaStore({ now: 'bad' }).now, 'function')

const cfgStore = quotaStoreFromConfig({ claude_quota_warn_pct: 70, claude_quota_stop_pct: 90, claude_quota_enabled: false })
eq('从配置读 warn', cfgStore.warnPct, 70)
eq('从配置读 stop', cfgStore.stopPct, 90)
eq('从配置读 enabled', cfgStore.enabled, false)
const defaultCfgStore = quotaStoreFromConfig({})
eq('空配置用缺省 warn', defaultCfgStore.warnPct, 85)
eq('空配置 enabled 为 true', defaultCfgStore.enabled, true)

// ═══════════════════════════════════ 13. snapshot

console.log('\n── snapshot 可序列化 ──')
store.reset()
eq('全局重置后清空', store.size, 0)
store.recordHeaders('acc-a', anthropicHeaders)
store.recordHeaders('acc-b', { 'x-codex-primary-used-percent': '97', 'x-codex-primary-window-minutes': '300' })

const snap = store.snapshot()
ok('snapshot 是对象', snap && typeof snap === 'object')
eq('snapshot 账号按 id 排序', snap.accounts.map((a) => a.account_id), ['acc-a', 'acc-b'])
eq('snapshot 带 warn_pct', snap.warn_pct, 85)
eq('snapshot 带 stop_pct', snap.stop_pct, 95)
eq('snapshot 带 enabled', snap.enabled, true)

let serialized = null
try {
  serialized = JSON.stringify(snap)
} catch (error) {
  serialized = `__throw__:${error.message}`
}
ok('snapshot 可 JSON 序列化', typeof serialized === 'string' && !serialized.startsWith('__throw__'))
ok('序列化后可还原', JSON.parse(serialized).accounts.length === 2)
ok('snapshot 不含函数', serializeHasNoFunctions(snap))
ok('acc-a 未被拦', snap.accounts[0].allowed === true)
ok('acc-b 被拦（97%）', snap.accounts[1].allowed === false)
eq('快照里 5h 读数', snap.accounts[0].windows['5h'].used_pct, 42)
eq('快照里 7d 读数', snap.accounts[0].windows['7d'].used_pct, 68)
ok('快照里带 reset_in_secs', typeof snap.accounts[0].windows['5h'].reset_in_secs === 'number')
ok('快照里带 window_minutes', snap.accounts[0].windows['5h'].window_minutes === 300)

// 快照不能暴露内部对象引用：改快照不影响存储
snap.accounts[0].windows['5h'].used_pct = 999
eq('快照是副本', store.gate('acc-a').windows['5h'].usedPct, 42)

/** 递归检查对象里没有函数 / Map / undefined 键值 */
function serializeHasNoFunctions(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return typeof value !== 'function'
  if (seen.has(value)) return true
  seen.add(value)
  if (value instanceof Map || value instanceof Set) return false
  if (Array.isArray(value)) return value.every((v) => serializeHasNoFunctions(v, seen))
  return Object.values(value).every((v) => serializeHasNoFunctions(v, seen))
}

// ═══════════════════════════════════ 14. 0% → 96% 全过程

console.log('\n── 0% → 96% 全流程 ──')
let climbClock = T0
const climbStore = new QuotaStore({ now: () => climbClock })
const climbReset = T0 + 3 * HOUR
const rungs = [0, 20, 40, 60, 80, 84.9, 85, 90, 94.9, 95, 96]

const levels = []
const allowedFlags = []
for (const pct of rungs) {
  climbStore.recordHeaders('climb', {
    'anthropic-ratelimit-unified-5h-utilization': String(pct / 100),
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(climbReset / 1000)),
  })
  const g = climbStore.gate('climb')
  levels.push(g.level)
  allowedFlags.push(g.allowed)
}

eq('0% 放行', allowedFlags[0], true)
eq('0% level ok', levels[0], 'ok')
eq('80% 仍 ok', levels[4], 'ok')
eq('84.9% 仍 ok', levels[5], 'ok')
eq('85% 进 warn', levels[6], 'warn')
eq('90% 仍 warn', levels[7], 'warn')
eq('94.9% 仍 warn', levels[8], 'warn')
eq('95% 熔断', levels[9], 'stop')
eq('96% 熔断', levels[10], 'stop')
eq('熔断前全部放行', allowedFlags.slice(0, 9).every(Boolean), true)
eq('熔断后不放行', allowedFlags.slice(9).every((v) => v === false), true)

// 熔断状态必须给出恢复时间
const finalGate = climbStore.gate('climb')
eq('熔断 resumeAt 指向窗口重置', finalGate.resumeAt, climbReset)
ok('熔断带 resumeAt', finalGate.resumeAt != null)

// ═══════════════════════════════════ 15. 调度器接入

console.log('\n── SlotScheduler 配额门禁 ──')
let schedClock = T0
const scheduler = new SlotScheduler({
  claudeBin: 'claude-not-installed',
  slots: 4,
  env: {},
  quota: { now: () => schedClock, warnPct: 85, stopPct: 95 },
})

eq('调度器缺省账号 id', scheduler.accountId, 'self')
eq('未收到头时放行', scheduler.quotaGate().allowed, true)
eq('未收到头时 reason', scheduler.quotaGate().reason, 'no_data')
eq('可改账号 id', scheduler.setAccountId('acc-x'), 'acc-x')
scheduler.setAccountId('self')

const schedReset = T0 + 2 * HOUR
scheduler.recordUsage('self', {
  'anthropic-ratelimit-unified-5h-utilization': '0.90',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor(schedReset / 1000)),
})
const schedWarn = scheduler.quotaGate()
eq('调度器 90% 放行', schedWarn.allowed, true)
eq('调度器 90% degraded', schedWarn.degraded, true)

scheduler.recordUsage('self', { 'anthropic-ratelimit-unified-5h-utilization': '0.96' })
const schedStop = scheduler.quotaGate()
eq('调度器 96% 熔断', schedStop.allowed, false)
eq('调度器 96% resumeAt 保留', schedStop.resumeAt, schedReset)

const blockedSubmit = scheduler.submit({ sessionId: 's-x', model: 'm', request: {} })
eq('配额挡下时 submit 返回 blocked', blockedSubmit.blocked, true)
eq('配额挡下时 jobId 为 null', blockedSubmit.jobId, null)
eq('配额挡下时带 quota 原因', blockedSubmit.quota.reason, '5h_exhausted')
ok('配额挡下时记录 lastQuotaBlock', scheduler.lastQuotaBlock?.reason === '5h_exhausted')
eq('配额挡下未占用任何槽', scheduler.readySlots, 4)

// 窗口到期后放行，submit 能拿到槽
schedClock = schedReset + 1
eq('到期后调度器放行', scheduler.quotaGate().allowed, true)
const afterSubmit = scheduler.submit({ sessionId: 's-y', model: 'm', request: {} })
ok('到期后 submit 拿到槽', afterSubmit && afterSubmit.blocked === false && afterSubmit.slot != null)
eq('到期后占用一个槽', scheduler.readySlots, 3)

// 快照可序列化
const schedSnap = scheduler.quotaSnapshot()
eq('调度器快照 enabled', schedSnap.enabled, true)
ok('调度器快照可序列化', typeof JSON.stringify(schedSnap) === 'string')
eq('调度器快照含账号', schedSnap.accounts.length, 1)
scheduler.stopAll()

// enabled=false 完全关闭门禁
console.log('\n── 门禁开关 ──')
const offScheduler = new SlotScheduler({
  claudeBin: 'claude-not-installed',
  slots: 2,
  env: {},
  quota: { enabled: false, now: () => T0 },
})
eq('关闭门禁 gate 仍放行', offScheduler.quotaGate().allowed, true)
eq('关闭门禁 enabled=false', offScheduler.quotaGate().enabled, false)
eq('关闭门禁 recordUsage 不记', offScheduler.recordUsage('self', { 'anthropic-ratelimit-unified-5h-utilization': '0.99' }), false)
const offSubmit = offScheduler.submit({ sessionId: 's-z', model: 'm', request: {} })
ok('关闭门禁后 99% 也可提交', offSubmit && offSubmit.blocked === false)
eq('关闭门禁快照 enabled=false', offScheduler.quotaSnapshot().enabled, false)
offScheduler.stopAll()

// markRateLimited：429 不给配额头时按本地状态压到熔断
console.log('\n── markRateLimited ──')
let rateClock = T0
const rateScheduler = new SlotScheduler({
  claudeBin: 'claude-not-installed',
  slots: 2,
  env: {},
  quota: { now: () => rateClock },
})
eq('无重置时间时不记录', rateScheduler.markRateLimited({ resetAt: null }), false)
eq('有重置时间时记录', rateScheduler.markRateLimited({ resetAt: T0 + HOUR }), true)
eq('标记后熔断', rateScheduler.quotaGate().allowed, false)
eq('标记后 resumeAt', rateScheduler.quotaGate().resumeAt, T0 + HOUR)
rateClock = T0 + HOUR + 1
eq('到点后自动恢复', rateScheduler.quotaGate().allowed, true)
rateScheduler.stopAll()

// ── 终态帧闭环：job_done.headers 与 job_error.status 都能喂进配额
console.log('\n── 终态帧闭环 ──')
let frameClock = T0
const frameScheduler = new SlotScheduler({
  claudeBin: 'claude-not-installed',
  slots: 2,
  env: {},
  quota: { now: () => frameClock },
})
const frameReset = T0 + 3 * HOUR

// job_done 带配额头 → 应写入 store
frameScheduler._handleFrame({
  kind: 'job_done',
  payload: {
    jobId: 'j-done',
    slotId: 's00',
    stopReason: 'end_turn',
    usage: {},
    headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.9',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(frameReset / 1000)),
    },
  },
})
eq('job_done 头被记为 90%', frameScheduler.quotaGate().windows['5h'].usedPct, 90)
eq('job_done 后进入预警', frameScheduler.quotaGate().degraded, true)
eq('job_done 后仍放行', frameScheduler.quotaGate().allowed, true)

// job_done 无配额头 → 不改变已有读数
frameScheduler._handleFrame({
  kind: 'job_done',
  payload: { jobId: 'j-done2', slotId: 's00', headers: { 'content-type': 'text/plain' } },
})
eq('无配额头的 job_done 不清空读数', frameScheduler.quotaGate().windows['5h'].usedPct, 90)

// job_error 429 + retry_after → 压到熔断
frameScheduler._handleFrame({
  kind: 'job_error',
  payload: { jobId: 'j-err', slotId: 's00', status: 429, retryAfter: 120 },
})
eq('429 后熔断', frameScheduler.quotaGate().allowed, false)
eq('429 后 resumeAt 按 retryAfter', frameScheduler.quotaGate().resumeAt, T0 + 120_000)

// 到点恢复
frameClock = T0 + 120_001
eq('retryAfter 到点后恢复', frameScheduler.quotaGate().allowed, true)

// 非 429 的 job_error 不改配额
// 注意：此时 5h 窗口的 resetAt 已随 retryAfter 过期，读数会归 0；
// 这里断言的是「500 没有把窗口重新压到 100% 熔断」，而不是具体读数。
frameScheduler._handleFrame({
  kind: 'job_error',
  payload: { jobId: 'j-err2', slotId: 's00', status: 500 },
})
eq('500 不触发熔断', frameScheduler.quotaGate().allowed, true)
eq('500 不写入 rejected 状态', frameScheduler.quotaGate().windows['5h'].status, 'active')
frameScheduler.stopAll()

// ═══════════════════════════════════ 16. 0% → 96% 演示

console.log('\n── 演示：账号 0% → 96% 的 gate 变化 ──')
const demoClock = { t: T0 }
const demo = new QuotaStore({ now: () => demoClock.t })
const demoReset = T0 + 4 * HOUR
const demoRows = []

for (const pct of [0, 10, 25, 40, 55, 70, 84.9, 85, 88, 91, 94.9, 95, 96]) {
  demo.recordHeaders('demo-account', {
    'anthropic-ratelimit-unified-5h-utilization': String(pct / 100),
    'anthropic-ratelimit-unified-5h-reset': String(Math.floor(demoReset / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': String(pct / 200),
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor(demoReset / 1000)),
  })
  const g = demo.gate('demo-account')
  demoRows.push({
    pct,
    allowed: g.allowed,
    level: g.level,
    reason: g.reason,
    resumeAt: g.resumeAt,
    used5h: g.windows['5h']?.usedPct,
    used7d: g.windows['7d']?.usedPct,
  })
  console.log(
    `  5h=${String(pct).padStart(5)}%  7d=${String((pct / 2).toFixed(1)).padStart(5)}%  ` +
      `gate=${g.allowed ? 'ALLOW' : 'BLOCK'}  level=${g.level.padEnd(4)}  reason=${g.reason}`,
  )
}

eq('演示：0% 允许', demoRows[0].allowed, true)
eq('演示：84.9% 仍允许', demoRows[6].allowed, true)
eq('演示：85% 允许但预警', demoRows[7].allowed, true)
eq('演示：85% level warn', demoRows[7].level, 'warn')
eq('演示：94.9% 仍允许', demoRows[10].allowed, true)
eq('演示：95% 熔断', demoRows[11].allowed, false)
eq('演示：96% 熔断', demoRows[12].allowed, false)
eq('演示：96% 给出恢复时间', demoRows[12].resumeAt, demoReset)
eq('演示：96% reason', demoRows[12].reason, '5h_exhausted')
eq('演示：允许的档位数为 11', demoRows.filter((r) => r.allowed).length, 11)
eq('演示：熔断的档位数为 2', demoRows.filter((r) => !r.allowed).length, 2)

// ═══════════════════════════════════ 17. 回归防护

// 17.1 clamp 的三个边界：负数 / 超 100 / 非数字。
// 这一组针对「比例超范围夹到 100」的历史缺陷：夹取逻辑一旦漏掉某一侧，
// 超额的账号会被算成零压力直接放行，属于安全方向的错误，必须锁死。
console.log('\n── 回归：clamp 上下边界 ──')
eq('clamp 负数 → 0', clampPct(-1), 0)
eq('clamp 负无穷 → 0', clampPct(-Infinity), 0)
eq('clamp 0 边界', clampPct(0), 0)
eq('clamp 恰 100', clampPct(100), 100)
eq('clamp 101 → 100', clampPct(101), 100)
eq('clamp 正无穷 → 100（不能落 0）', clampPct(Infinity), 100)
eq('clamp NaN → 0', clampPct(NaN), 0)
eq('clamp null → 0', clampPct(null), 0)
eq('clamp undefined → 0', clampPct(undefined), 0)
eq('clamp 两位小数', clampPct(85.126), 85.13)

// ratio 量纲的夹取同样不能把超范围值当成小数比例再放大
eq('ratio 负值夹 0', toUsedPct('-0.4', 'ratio'), 0)
eq('ratio 1.5 走比例换算', toUsedPct('1.5', 'ratio'), 100)
eq('ratio 1.51 视为已是百分比', toUsedPct('1.51', 'ratio'), 1.51)
eq('percent 超上限夹 100', toUsedPct('1000', 'percent'), 100)
eq('percent NaN 字面量归 null', toUsedPct('NaN', 'percent'), null)

// clamp 后的读数参与门禁时，超额仍必须熔断
const clampedOverflow = windowPressure(
  { key: '5h', usedPct: clampPct(Infinity), resetAt: T0 + HOUR, status: 'active', windowMinutes: 300, stale: false },
  { now: T0 },
)
eq('夹取到 100 后熔断', clampedOverflow.level, 'stop')
eq('夹取到 100 后读数', clampedOverflow.usedPct, 100)

// 17.2 snapshot 幂等：连续两次调用结果必须逐字节一致。
// 快照里任何时间相关字段（reset_in_secs / stale）若在读取时被改写，
// 两次调用就会漂移，/status 的 diff 与缓存都不再可靠。
console.log('\n── 回归：snapshot 幂等 ──')
const idemStore = new QuotaStore({ now: () => T0 })
idemStore.recordHeaders('idem-a', {
  'anthropic-ratelimit-unified-5h-utilization': '0.42',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor((T0 + 2 * HOUR) / 1000)),
  'anthropic-ratelimit-unified-7d-utilization': '0.68',
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor((T0 + 5 * 24 * HOUR) / 1000)),
})
const idemFirst = JSON.stringify(idemStore.snapshot())
const idemSecond = JSON.stringify(idemStore.snapshot())
eq('snapshot 连续两次一致', idemSecond, idemFirst)
eq('snapshot 不因读取而改变存储', idemStore.gate('idem-a').windows['5h'].usedPct, 42)

// 过期窗口的 stale 标记也必须幂等：effectiveWindow 被 accountGate 与
// snapshot 各调一次，非幂等会把 stale 抹掉
const staleClock = { t: T0 + 2 * HOUR }
const staleStore = new QuotaStore({ now: () => staleClock.t })
staleStore.recordHeaders('stale-a', {
  'anthropic-ratelimit-unified-5h-utilization': '0.96',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor((T0 + HOUR) / 1000)),
})
eq('过期窗口首次 stale', staleStore.gate('stale-a').windows['5h'].stale, true)
eq('过期窗口二次 stale 保持', staleStore.gate('stale-a').windows['5h'].stale, true)
eq('过期窗口快照 stale 保持', staleStore.snapshot().accounts[0].windows['5h'].stale, true)

// 17.3 测试隔离：一个 store 的写入不得泄漏到另一个 store，
// 同一 store 内 reset 后不得残留旧账号。
console.log('\n── 回归：测试隔离 ──')
const isoA = new QuotaStore({ now: () => T0 })
const isoB = new QuotaStore({ now: () => T0 })
isoA.recordHeaders('leak', { 'anthropic-ratelimit-unified-5h-utilization': '0.97' })
eq('store A 记到自己名下', isoA.size, 1)
eq('store B 不受 A 影响', isoB.size, 0)
eq('store B 查 A 的账号为 no_data', isoB.gate('leak').reason, 'no_data')

isoA.reset()
eq('全量 reset 后账号清空', isoA.size, 0)
eq('全量 reset 后快照为空', isoA.snapshot().accounts.length, 0)
isoA.recordHeaders('after-reset', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' })
eq('reset 后重新写入只有新账号', isoA.snapshot().accounts.map((a) => a.account_id), ['after-reset'])

// 前一个测试留下的账号不得出现在后一个测试的快照里
const isoBefore = isoA.snapshot().accounts.map((a) => a.account_id)
const isoFresh = new QuotaStore({ now: () => T0 })
isoFresh.recordHeaders('fresh', { 'anthropic-ratelimit-unified-5h-utilization': '0.2' })
eq('新 store 快照不含旧账号', isoFresh.snapshot().accounts.map((a) => a.account_id), ['fresh'])
eq('旧 store 快照不受新 store 影响', isoA.snapshot().accounts.map((a) => a.account_id), isoBefore)

// reset(accountId) 只删指定账号，其余保留
const isoPartial = new QuotaStore({ now: () => T0 })
isoPartial.recordHeaders('keep', { 'anthropic-ratelimit-unified-5h-utilization': '0.3' })
isoPartial.recordHeaders('drop', { 'anthropic-ratelimit-unified-5h-utilization': '0.4' })
isoPartial.reset('drop')
eq('单账号 reset 只删目标', isoPartial.snapshot().accounts.map((a) => a.account_id), ['keep'])

// ═══════════════════════════════════ 汇总

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
