/**
 * 官方配额窗口模型。
 *
 * Anthropic 的用量有两层窗口：
 *   - 5 小时滚动窗口：window_minutes = 300
 *   - 7 天硬限：window_minutes = 10080
 *
 * 每个窗口由两个量描述：已用比例（0-100）与重置时间（epoch ms）。
 * 模块内只做纯计算，不持有状态、不读时钟以外的东西，便于单测与复用。
 *
 * 关键约束：
 * 1. 窗口重置后必须清零已用量。上游会在 reset 之后继续下发旧读数（尤其是
 *    utilization=1 + rejected 的残留），如果沿用旧值，账号会被永久判死。
 *    清零是惰性的：每次读取时按 now 与 resetAt 比较，不用定时器。
 * 2. 两套响应头命名都要认：Anthropic unified 与 Codex primary/secondary。
 *    两者同时出现时 Anthropic 优先，因为本通道的主体是 Claude。
 * 3. 阈值判定带浮点容差。0.8 + 0.05 这类算式会得到 0.8500000000000001，
 *    读数恰好等于 85 时必须触发预警，不能被浮点误差吞掉。
 * 4. 畸形值不抛错：缺字段、空串、非数字、超范围一律收敛成 null / 夹取，
 *    由调用方按「无数据」处理。配额是旁路信号，不该让请求路径崩掉。
 */

/** 5 小时窗口的分钟数。 */
export const WINDOW_5H_MINUTES = 300
/** 7 天窗口的分钟数。 */
export const WINDOW_7D_MINUTES = 7 * 24 * 60

export const WINDOW_5H_MS = WINDOW_5H_MINUTES * 60_000
export const WINDOW_7D_MS = WINDOW_7D_MINUTES * 60_000

/** 窗口键的固定顺序。表格输出与断言都依赖这个顺序，不要按对象键序取。 */
export const QUOTA_WINDOW_KEYS = /** @type {const} */ (['5h', '7d'])

export const DEFAULT_WARN_PCT = 85
export const DEFAULT_STOP_PCT = 95

/** 默认窗口长度，按窗口键反查。 */
export const WINDOW_MINUTES_BY_KEY = Object.freeze({
  '5h': WINDOW_5H_MINUTES,
  '7d': WINDOW_7D_MINUTES,
})

/** 浮点容差：85 与 84.99999999 在本模型里是同一档。 */
const EPSILON = 1e-9

/** 已经被上游明确限流的状态字面值。 */
const REJECTED_STATUSES = new Set(['rejected', 'rate_limited', 'exhausted', 'blocked'])

/** 上游用来表示「正常可用」的状态字面值。 */
const ACTIVE_STATUSES = new Set(['allowed', 'active', 'ok', 'normal'])

// ─────────────────────────────────────── 基础归一

/**
 * 把任意形态的 headers 摊平成「全小写键 → 字符串值」。
 *
 * 支持三种输入：
 *   - WHATWG Headers（有 forEach）—— fetch / undici 的 res.headers
 *   - Node 普通对象（res.headers 在 http 模块里就是这个形态）
 *   - Map 风格的 entries()
 *
 * 同名头出现多次时 Node 会给数组，这里取第一项：配额头都是单值头，
 * 数组只可能来自重复下发，取首个与上游语义一致。
 */
export function lowerCaseHeaders(headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  const put = (key, value) => {
    if (key == null) return
    const k = String(key).toLowerCase()
    out[k] = Array.isArray(value) ? value[0] : value
  }
  if (typeof headers.forEach === 'function') {
    // Headers 与 Map 都提供 forEach(value, key)
    headers.forEach((value, key) => put(key, value))
    return out
  }
  for (const [key, value] of Object.entries(headers)) put(key, value)
  return out
}

/** 读取单个头，空串与缺失都归成 null，避免把 '' 当成合法的 0。 */
export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null
  const raw = headers[name]
  if (raw == null) return null
  const text = String(raw).trim()
  return text === '' ? null : text
}

/**
 * 百分比读数归一。两种量纲：
 *   - ratio：上游下发的 0-1 比例（Anthropic unified 头）。> 1.5 时视为
 *     上游已经换算过百分比，直接采用，避免 ×100 两次。
 *   - percent：上游下发的 0-100 百分比（Codex 头）。不做换算。
 *
 * 结果夹在 [0, 100]，保留两位小数。非数字返回 null，由调用方当「无数据」。
 */
export function toUsedPct(raw, scale = 'ratio') {
  if (raw == null) return null
  const text = String(raw).trim().replace(/%$/, '')
  if (text === '') return null
  const n = Number(text)
  if (!Number.isFinite(n)) return null
  let pct
  if (scale === 'percent') pct = n
  else pct = n <= 1.5 ? n * 100 : n
  return clampPct(pct)
}

/**
 * 重置时间解析，统一成 epoch ms。
 *
 * 上游给三种形态：
 *   - unix 秒（10 位数字）
 *   - unix 毫秒（13 位数字）
 *   - RFC3339 / ISO 字符串
 *
 * 长度判定用 1e10 做分界：秒级时间戳在 2286 年才会越过这个量级，
 * 足够覆盖所有现实取值。解析失败返回 null。
 */
export function parseResetAt(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return value < 1e10 ? Math.round(value * 1000) : Math.round(value)
  }
  const text = String(value).trim()
  if (text === '') return null
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text)
    if (!Number.isFinite(n) || n <= 0) return null
    return n < 1e10 ? Math.round(n * 1000) : Math.round(n)
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

/** 状态字面值归一。未知值原样保留小写，便于排查上游新枚举。 */
export function normalizeStatus(raw) {
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  if (s === '') return null
  if (ACTIVE_STATUSES.has(s)) return 'active'
  if (REJECTED_STATUSES.has(s)) return 'rejected'
  return s
}

/** 状态是否表示「上游已明确拒绝」。 */
export function isRejectedStatus(status) {
  const s = String(status == null ? '' : status).trim().toLowerCase()
  if (s === '') return false
  return REJECTED_STATUSES.has(s) || s === 'rejected'
}

/**
 * 由 window_minutes 反推窗口键。
 *
 * Codex 用 primary/secondary 命名，不保证 primary 一定是 5h。窗口长度是
 * 更可靠的信号：>= 1 天归到 7d，其余归到 5h；缺失时用调用方给的缺省键。
 */
export function windowKeyFromMinutes(minutes, fallback = '5h') {
  const n = Number(minutes)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n >= 24 * 60 ? '7d' : '5h'
}

/**
 * 数值夹取到 [0, 100]，保留两位小数。
 *
 * 非数字（NaN、null、空串）落下限 0：调用方已把这类值当「无数据」处理，
 * 这里只需保证不把 NaN 传进门禁比较。
 *
 * ±Infinity 按方向夹取，不能一律落 0。+Infinity 是「超过上限」的极端取值，
 * 落在 100 才与「超范围夹到上限」的语义一致；落 0 会让一个明确超额的窗口
 * 变成零压力，直接放行超额账号。
 */
export function clampPct(value) {
  const n = Number(value)
  if (Number.isNaN(n)) return 0
  if (n <= 0) return 0
  if (n >= 100) return 100
  return Math.round(n * 100) / 100
}

/**
 * 阈值归一：非法值、非正数、超过 100 一律回退缺省。
 *
 * warnPct 必须严格小于 stopPct，否则「预警」与「熔断」会重叠，
 * 门禁语义变得不可预测 —— 这种情况下整对回退到缺省值。
 */
export function thresholdsOf({ warnPct, stopPct } = {}) {
  const pick = (value, fallback) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0 || n > 100) return fallback
    return n
  }
  const warn = pick(warnPct, DEFAULT_WARN_PCT)
  const stop = pick(stopPct, DEFAULT_STOP_PCT)
  if (!(warn < stop)) return { warn: DEFAULT_WARN_PCT, stop: DEFAULT_STOP_PCT }
  return { warn, stop }
}

// ─────────────────────────────────────── 响应头解析

/** 构造一个窗口对象。字段集合固定，方便序列化与断言。 */
function makeWindow({ key, usedPct, resetAt, windowMinutes, status, source, at }) {
  // 注意 Number(null) === 0 且有限，必须先判空再转型，否则缺字段会得到 0 分钟窗口
  const minutes = windowMinutes == null ? NaN : Number(windowMinutes)
  return {
    key,
    usedPct: usedPct == null ? 0 : clampPct(usedPct),
    resetAt: resetAt == null ? null : resetAt,
    windowMinutes:
      Number.isFinite(minutes) && minutes > 0
        ? Math.round(minutes)
        : WINDOW_MINUTES_BY_KEY[key] ?? WINDOW_5H_MINUTES,
    status: status == null ? null : status,
    source,
    at,
    stale: false,
  }
}

/**
 * 从一组 Anthropic unified 头里解析某个窗口。
 * 三个字段（utilization / reset / status）全缺时返回 null。
 */
function anthropicWindow(headers, key, at) {
  const util = headerValue(headers, `anthropic-ratelimit-unified-${key}-utilization`)
  const reset = headerValue(headers, `anthropic-ratelimit-unified-${key}-reset`)
  const status = headerValue(headers, `anthropic-ratelimit-unified-${key}-status`)
  if (util == null && reset == null && status == null) return null
  return makeWindow({
    key,
    usedPct: toUsedPct(util, 'ratio'),
    resetAt: parseResetAt(reset),
    windowMinutes: WINDOW_MINUTES_BY_KEY[key],
    status: normalizeStatus(status),
    source: 'anthropic',
    at,
  })
}

/**
 * 从一组 Codex 头里解析某个窗口。
 *
 * primary/secondary 与 5h/7d 的映射由 window_minutes 决定，缺失时按
 * primary→5h、secondary→7d 的经验映射兜底。
 */
function codexWindow(headers, slot, at) {
  const util = headerValue(headers, `x-codex-${slot}-used-percent`)
  const reset = headerValue(headers, `x-codex-${slot}-reset-at`)
  const minutes = headerValue(headers, `x-codex-${slot}-window-minutes`)
  const status = headerValue(headers, `x-codex-${slot}-status`)
  if (util == null && reset == null && minutes == null && status == null) return null
  const fallbackKey = slot === 'secondary' ? '7d' : '5h'
  const key = windowKeyFromMinutes(minutes, fallbackKey)
  return makeWindow({
    key,
    usedPct: toUsedPct(util, 'percent'),
    resetAt: parseResetAt(reset),
    windowMinutes: minutes == null ? WINDOW_MINUTES_BY_KEY[key] : Number(minutes),
    status: normalizeStatus(status),
    source: 'codex',
    at,
  })
}

/**
 * 从响应头解析窗口状态。
 *
 * 返回 `{ '5h': Window|null, '7d': Window|null, source, at }`。
 * 两套头都没有有效数据时返回 null —— 调用方据此跳过本次更新，
 * 不要拿「全空」覆盖已有的有效读数。
 *
 * 同一窗口两套头都有值时 Anthropic 优先（本通道主体是 Claude）；
 * source 反映最终采用的来源，mixed 表示 5h 与 7d 来自不同协议族。
 */
export function parseQuotaHeaders(headers, { now = Date.now() } = {}) {
  const h = lowerCaseHeaders(headers)
  const at = now

  const a5 = anthropicWindow(h, '5h', at)
  const a7 = anthropicWindow(h, '7d', at)
  const c5 = codexWindow(h, 'primary', at)
  const c7 = codexWindow(h, 'secondary', at)

  const windows = { '5h': null, '7d': null }
  const sources = new Set()

  // Codex 的窗口键由分钟数决定，可能两个都落到同一个键上。
  // 同键冲突时保留读数更高的那个：宁可提前熔断，也不要放过超额。
  const absorb = (win) => {
    if (!win) return
    const key = win.key
    const prev = windows[key]
    if (!prev || win.usedPct > prev.usedPct) windows[key] = win
    sources.add(win.source)
  }

  // Anthropic 优先：先落 Codex，再用 Anthropic 覆盖同键
  absorb(c5)
  absorb(c7)
  for (const win of [a5, a7]) {
    if (!win) continue
    windows[win.key] = win
    sources.add(win.source)
  }

  const hasAny = QUOTA_WINDOW_KEYS.some((key) => windows[key] != null)
  if (!hasAny) return null

  let source = null
  if (sources.size === 1) source = [...sources][0]
  else if (sources.size > 1) source = 'mixed'

  return { '5h': windows['5h'], '7d': windows['7d'], source, at }
}

// ─────────────────────────────────────── 窗口状态

/**
 * 窗口是否已重置（当前时间越过 resetAt）。
 *
 * 语义约定：
 *   - 窗口对象缺失 → true（没有窗口等于没有压力）
 *   - resetAt 缺失 → false（无法判断，保守地认为窗口仍在进行中）
 *   - resetAt 恰等于 now → true（上游的 reset 是闭区间左端）
 */
export function isWindowReset(window, now = Date.now()) {
  if (!window || typeof window !== 'object') return true
  if (window.resetAt == null) return false
  const resetAt = Number(window.resetAt)
  if (!Number.isFinite(resetAt)) return false
  return now >= resetAt
}

/**
 * 返回「当前有效」的窗口视图，已重置的清零。
 *
 * 清零时同时把 resetAt 置空并打上 stale 标记：旧的重置时间已经过期，
 * 继续用它算 resetInSecs 会得到 0，前端会误显示「马上恢复」。
 * 新的 resetAt 等下一次上游响应填入。
 *
 * 幂等：已清零的窗口（resetAt 为 null 且 stale）再次经过本函数时保持
 * stale 标记。accountGate 与 QuotaStore 会各调一次，非幂等会把 stale
 * 抹成 false，调用方就分不清「真的 0%」和「窗口刚滚过」。
 */
export function effectiveWindow(window, now = Date.now()) {
  if (!window || typeof window !== 'object') return null
  if (isWindowReset(window, now)) {
    return {
      ...window,
      usedPct: 0,
      resetAt: null,
      status: 'active',
      stale: true,
      staleReason: window.staleReason || 'reset_elapsed',
    }
  }
  return { ...window, stale: window.stale === true }
}

/** 距离重置还剩多少秒，已过重置或无重置时间返回 0 / null。 */
export function resetInSecs(resetAt, now = Date.now()) {
  if (resetAt == null) return null
  const n = Number(resetAt)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.ceil((n - now) / 1000))
}

/**
 * 判断某个窗口是否接近上限。
 *
 * level 三档：
 *   ok    —— 低于预警线，正常调度
 *   warn  —— 达到预警线但未到熔断线，可用但打 WARN
 *   stop  —— 达到熔断线，或者上游明确 rejected，必须停止调度
 *
 * 上游状态优先于读数：utilization 仍是 0.26 但 status=rejected 时，
 * 说明这个窗口已经被拒，读数只是滞后。此时按 stop 处理。
 *
 * @returns {{near:boolean, level:'ok'|'warn'|'stop', usedPct:number,
 *            remainingPct:number, resetAt:number|null, resetInSecs:number|null,
 *            stale:boolean, status:string|null, key:string|null}}
 */
export function windowPressure(window, { warnPct, stopPct, now = Date.now() } = {}) {
  const { warn, stop } = thresholdsOf({ warnPct, stopPct })
  const effective = effectiveWindow(window, now)
  const usedPct = effective ? clampPct(effective.usedPct) : 0
  const rejected = isRejectedStatus(effective?.status)

  let level = 'ok'
  if (rejected || usedPct + EPSILON >= stop) level = 'stop'
  else if (usedPct + EPSILON >= warn) level = 'warn'

  return {
    key: effective?.key ?? null,
    near: level !== 'ok',
    level,
    usedPct,
    remainingPct: Math.round((100 - usedPct) * 100) / 100,
    resetAt: effective?.resetAt ?? null,
    resetInSecs: resetInSecs(effective?.resetAt, now),
    // stale 表示「这个读数来自一个已经滚过的窗口，已按 0 处理」
    stale: effective ? effective.stale === true : true,
    status: effective?.status ?? null,
  }
}

/**
 * 在「全部熔断」的候选里挑恢复最快的那个。
 *
 * 依据是恢复时间最小的候选。候选可以是 accountGate 的 pressure（字段名
 * resetAt）或调度器构造的候选（字段名 resumeAt），两者都认；都没有时
 * 排在最后（无法预期恢复时间，不能算作「最接近重置」）。
 * 列表为空返回 null。
 */
export function pickSoonestReset(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  const resumeOf = (item) => {
    const raw = item?.resumeAt ?? item?.resetAt ?? null
    if (raw == null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }
  let best = null
  let bestAt = null
  for (const item of candidates) {
    const at = resumeOf(item)
    if (at == null) {
      if (!best) best = item
      continue
    }
    if (bestAt == null || at < bestAt) {
      best = item
      bestAt = at
    }
  }
  return best
}

/**
 * 综合判断账号是否该暂停调度。
 *
 * 规则：
 *   - 任一窗口 stop → 不允许，reason 指明是哪个窗口，resumeAt 取该窗口的
 *     重置时间（多个窗口同时 stop 时取最早的那个，恢复最快）
 *   - 任一窗口 warn → 允许，但 degraded=true，由调用方决定是否打 WARN 日志
 *   - 全部 ok 或没有窗口数据 → 允许，degraded=false
 *
 * 窗口缺失不等于熔断：从没收到过配额头时不该把账号挡在外面。
 *
 * @returns {{allowed:boolean, level:'ok'|'warn'|'stop', degraded:boolean,
 *            reason:string, resumeAt:number|null,
 *            windows:Record<string,object>, limited:string[], warning:string[]}}
 */
export function accountGate(windows, { warnPct, stopPct, now = Date.now() } = {}) {
  const { warn, stop } = thresholdsOf({ warnPct, stopPct })
  const pressures = {}
  const limited = []
  const warning = []

  for (const key of QUOTA_WINDOW_KEYS) {
    const raw = windows?.[key] ?? null
    if (!raw) continue
    const pressure = windowPressure(raw, { warnPct: warn, stopPct: stop, now })
    pressures[key] = pressure
    if (pressure.level === 'stop') limited.push({ key, ...pressure })
    else if (pressure.level === 'warn') warning.push({ key, ...pressure })
  }

  if (limited.length > 0) {
    const soonest = pickSoonestReset(limited) || limited[0]
    return {
      allowed: false,
      level: 'stop',
      degraded: true,
      reason: `${soonest.key}_exhausted`,
      resumeAt: soonest.resetAt ?? null,
      windows: pressures,
      limited: QUOTA_WINDOW_KEYS.filter((key) => pressures[key]?.level === 'stop'),
      warning: QUOTA_WINDOW_KEYS.filter((key) => pressures[key]?.level === 'warn'),
    }
  }

  if (warning.length > 0) {
    return {
      allowed: true,
      level: 'warn',
      degraded: true,
      reason: `${warning[0].key}_warning`,
      resumeAt: null,
      windows: pressures,
      limited: [],
      warning: QUOTA_WINDOW_KEYS.filter((key) => pressures[key]?.level === 'warn'),
    }
  }

  return {
    allowed: true,
    level: 'ok',
    degraded: false,
    reason: 'ok',
    resumeAt: null,
    windows: pressures,
    limited: [],
    warning: [],
  }
}
