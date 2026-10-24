/**
 * 内存态配额存储：按 accountId 保存 5h / 7d 两套窗口。
 *
 * 职责：接收上游响应头、维护每账号的窗口读数、对外给出门禁结果与快照。
 * 窗口的重置判定与阈值判断都在 quota-window.mjs 里，本模块只负责状态。
 *
 * 关键约束：
 * 1. 窗口到期自动清零靠惰性判断：每次读（gate / snapshot）时按 now 与
 *    resetAt 比较，不挂定时器。定时器会在进程空闲时也跑，且时钟漂移
 *    时与请求路径看到的时间不一致。
 * 2. 单线程不等于无竞态。recordHeaders 与 gate 之间没有 await，读改写
 *    是原子的；但调用方若在异步回调里连续调用，仍以「最后一次写入」为准。
 *    因此写入走「合并」而不是「替换」：本次响应只带了 7d 头时，
 *    保留已有的 5h 读数，不能因为缺字段把 5h 清掉。
 * 3. 空解析结果不覆盖已有状态。上游的健康检查、404、流式首包都可能没有
 *    配额头，那类响应不该把账号的窗口清零 —— 否则配额门禁形同虚设。
 * 4. snapshot() 只返回可 JSON 序列化的纯量对象，不含函数、Map、循环引用。
 *    它要给 /status 与健康检查直接用，塞进 Error 或闭包会序列化失败。
 * 5. 账号首次出现时窗口为空。空窗口不代表熔断，accountGate 会放行，
 *    这与「从没收到配额头就正常调度」的预期一致。
 */

import {
  QUOTA_WINDOW_KEYS,
  accountGate,
  effectiveWindow,
  isWindowReset,
  parseQuotaHeaders,
  thresholdsOf,
  windowPressure,
} from './quota-window.mjs'

/** 单个账号在两个窗口里的原始读数（已解析，未做重置判定）。 */
function emptyWindows() {
  return { '5h': null, '7d': null }
}

/**
 * 同窗口字段级合并：新读数优先，缺字段沿用旧值。
 *
 * utilization / status 是每次响应都可能变动的量，按新值走；resetAt 与
 * windowMinutes 变化很慢，新值缺失时保留旧的。旧窗口已过期时不做合并，
 * 直接采用新值 —— 跨过窗口边界后旧 resetAt 已经没有意义。
 */
function mergeWindow(prev, next) {
  if (!prev) return next
  const prevReset = prev.resetAt == null ? null : Number(prev.resetAt)
  const prevExpired = prevReset != null && Number.isFinite(prevReset) && prevReset <= next.at
  if (prevExpired) return next

  // usedPct 为 0 且没有 reset 时无法区分「真的是 0」与「头里没这个字段」，
  // 解析层已经保证「三字段全缺返回 null」，所以能走到这里的 usedPct 都是真读数。
  return {
    ...next,
    resetAt: next.resetAt ?? prev.resetAt ?? null,
    windowMinutes: next.windowMinutes ?? prev.windowMinutes ?? null,
    status: next.status ?? prev.status ?? null,
  }
}

export class QuotaStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.warnPct] 预警阈值，默认 85
   * @param {number} [opts.stopPct] 熔断阈值，默认 95
   * @param {boolean} [opts.enabled] 关闭时 gate 恒放行，头仍然记录（便于观察）
   * @param {() => number} [opts.now] 注入时钟，便于测试
   */
  constructor({ warnPct, stopPct, enabled = true, now = () => Date.now() } = {}) {
    const { warn, stop } = thresholdsOf({ warnPct, stopPct })
    this.warnPct = warn
    this.stopPct = stop
    this.enabled = enabled !== false
    this.now = typeof now === 'function' ? now : () => Date.now()
    // accountId -> { '5h': Window|null, '7d': Window|null, updatedAt:number, source:string|null }
    this.accounts = new Map()
  }

  /** 取账号记录，不存在则创建。 */
  _entry(accountId) {
    const key = String(accountId == null ? '' : accountId)
    let entry = this.accounts.get(key)
    if (!entry) {
      entry = { windows: emptyWindows(), updatedAt: null, source: null }
      this.accounts.set(key, entry)
    }
    return entry
  }

  /**
   * 解析响应头并更新账号窗口。
   *
   * 合并语义分两层，缺一不可：
   *   - 跨窗口：本次只带 7d 头时，5h 读数原样保留
   *   - 同窗口：本次只带 utilization 时，已有的 resetAt / status 保留
   *
   * 第二层是必须的。上游的稳态响应常常只回 utilization，reset 只在窗口
   * 边界附近下发；若按整对象替换，resetAt 会被抹成 null，熔断时就算不出
   * resumeAt，调用方拿不到恢复时间，只能盲目重试。
   *
   * 返回本次是否真的写入了数据（false 表示头里没有配额信息，已忽略）。
   */
  recordHeaders(accountId, headers) {
    const parsed = parseQuotaHeaders(headers, { now: this.now() })
    if (!parsed) return false
    const entry = this._entry(accountId)
    for (const key of QUOTA_WINDOW_KEYS) {
      const next = parsed[key]
      if (!next) continue
      entry.windows[key] = mergeWindow(entry.windows[key], next)
    }
    entry.updatedAt = parsed.at
    entry.source = parsed.source
    return true
  }

  /**
   * 直接写入一个窗口读数（供调用方在只有单一来源时使用）。
   *
   * 与 recordHeaders 走同一套合并语义：window 传 null 表示只更新其他字段。
   */
  recordWindow(accountId, key, window) {
    if (!QUOTA_WINDOW_KEYS.includes(key)) return false
    if (!window || typeof window !== 'object') return false
    const entry = this._entry(accountId)
    entry.windows[key] = { ...window, key }
    entry.updatedAt = this.now()
    return true
  }

  /**
   * 清空某账号的窗口读数。
   *
   * 语义是「把这个账号的配额状态恢复成从未收到过配额头」：直接删掉记录，
   * 后续 gate 返回 reason='no_data'。窗口重置时也可以调用（虽然门禁已经
   * 惰性清零，显式清一次能让 snapshot 更干净）。accountId 省略时清空全部。
   */
  reset(accountId) {
    if (accountId == null) {
      const had = this.accounts.size > 0
      this.accounts.clear()
      return had
    }
    return this.accounts.delete(String(accountId))
  }

  /**
   * 惰性清理某个账号里已过期的窗口。
   *
   * 与 effectiveWindow 的区别：这里把读数真的写回 null，用于长期运行的进程
   * 回收内存；gate / snapshot 走 effectiveWindow 的只读视图，不改状态。
   * 返回被清掉的窗口键列表。
   */
  pruneExpired(accountId) {
    const entry = accountId == null ? null : this.accounts.get(String(accountId))
    if (!entry) return []
    const now = this.now()
    const cleared = []
    for (const key of QUOTA_WINDOW_KEYS) {
      const window = entry.windows[key]
      if (!window) continue
      if (isWindowReset(window, now) && window.resetAt != null) {
        entry.windows[key] = null
        cleared.push(key)
      }
    }
    return cleared
  }

  /**
   * 门禁结果。
   *
   * 返回结构与 accountGate 一致，额外带 accountId 与 enabled：
   *   - enabled=false → allowed 恒 true，但 degraded / windows 仍然如实反映，
   *     便于「只看不拦」的观察模式
   *   - 账号从未出现过 → 放行，reason='no_data'
   */
  gate(accountId) {
    const key = String(accountId == null ? '' : accountId)
    const entry = this.accounts.get(key)
    const now = this.now()

    if (!entry) {
      return {
        accountId: key,
        allowed: true,
        level: 'ok',
        degraded: false,
        reason: 'no_data',
        resumeAt: null,
        windows: {},
        limited: [],
        warning: [],
        enabled: this.enabled,
      }
    }

    // 惰性视图：已过重置的窗口按 0 计算，不改写存储
    const view = {}
    for (const k of QUOTA_WINDOW_KEYS) view[k] = effectiveWindow(entry.windows[k], now)

    const result = accountGate(view, { warnPct: this.warnPct, stopPct: this.stopPct, now })
    return {
      accountId: key,
      ...result,
      reason: result.reason === 'ok' ? 'ok' : result.reason,
      allowed: this.enabled ? result.allowed : true,
      enabled: this.enabled,
      blocked: result.allowed === false,
      updatedAt: entry.updatedAt,
      source: entry.source,
    }
  }

  /**
   * 单窗口压力视图（只读，已做重置清零）。
   * 用于 /status 里按窗口列读数，不参与门禁。
   */
  pressure(accountId, key) {
    const entry = this.accounts.get(String(accountId == null ? '' : accountId))
    if (!entry) return null
    const window = entry.windows[key]
    if (!window) return null
    return windowPressure(window, { warnPct: this.warnPct, stopPct: this.stopPct, now: this.now() })
  }

  /**
   * 可序列化快照，供 /status 与健康检查使用。
   *
   * 结构：
   *   { enabled, warnPct, stopPct, accounts: [ {
   *       account_id, allowed, level, reason, resume_at,
   *       updated_at, source,
   *       windows: { '5h': {used_pct,status,reset_at,reset_in_secs,level,stale}, ... }
   *   } ] }
   *
   * accounts 按 accountId 排序，保证输出稳定可 diff。
   */
  snapshot() {
    const accounts = []
    const now = this.now()
    for (const accountId of [...this.accounts.keys()].sort()) {
      const entry = this.accounts.get(accountId)
      const gate = this.gate(accountId)
      const windows = {}
      for (const key of QUOTA_WINDOW_KEYS) {
        const window = effectiveWindow(entry.windows[key], now)
        if (!window) continue
        const pressure = windowPressure(window, { warnPct: this.warnPct, stopPct: this.stopPct, now })
        windows[key] = {
          used_pct: pressure.usedPct,
          remaining_pct: pressure.remainingPct,
          level: pressure.level,
          status: pressure.status,
          reset_at: pressure.resetAt,
          reset_in_secs: pressure.resetInSecs,
          window_minutes: window.windowMinutes,
          stale: pressure.stale === true,
        }
      }
      accounts.push({
        account_id: accountId,
        allowed: gate.allowed,
        blocked: gate.blocked === true,
        level: gate.level,
        reason: gate.reason,
        resume_at: gate.resumeAt,
        updated_at: entry.updatedAt,
        source: entry.source,
        windows,
      })
    }
    return {
      enabled: this.enabled,
      warn_pct: this.warnPct,
      stop_pct: this.stopPct,
      accounts,
    }
  }

  /** 账号 id 列表，供调度器遍历。 */
  get accountIds() {
    return [...this.accounts.keys()]
  }

  /** 已记录账号数。 */
  get size() {
    return this.accounts.size
  }
}

/** 便捷构造：从 worker 配置直接建 store，避免每个调用点重复挑字段。 */
export function quotaStoreFromConfig(cfg = {}, { now } = {}) {
  return new QuotaStore({
    warnPct: cfg.claude_quota_warn_pct,
    stopPct: cfg.claude_quota_stop_pct,
    enabled: cfg.claude_quota_enabled,
    now,
  })
}
