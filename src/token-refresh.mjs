/**
 * 正确的 OAuth token 刷新管理器。
 *
 * 四条不可妥协的规则（每条都对应一个已知会导致「账号掉登录」的缺陷）：
 *
 * 1. **refresh_token 严格轮换**：只认上游返回的新 token。上游没有返回新 token
 *    就标记 needs_reauth，绝不回退到旧的。原因：服务端在轮换模式下，一次成功
 *    刷新就会让旧 refresh_token 立即失效；把旧的留在凭据里，下一次刷新必然被
 *    判 invalid_grant，而那时能救回账号的只有人工重新授权。
 *
 * 2. **重试必须重新读存储**：网络错误重试前先 load()，如果 generation 变了，
 *    说明别的执行体已经刷过，直接采用它的结果。原因：刷新请求可能已被服务端
 *    处理，只是响应在网络上丢了；拿同一个 refresh_token 再发一次，等于用已作废
 *    的凭据去换 token，一次网络抖动就变成永久失效。
 *
 * 3. **过期时间保守**：严格用上游的 expires_in；缺失时估 1 小时。原因：给一个
 *    乐观的兜底值（例如 8 小时）会让 token 在使用时早已过期，而管理层以为它还
 *    新鲜——报错发生在推理路径、根因在刷新路径，排查成本极高。
 *
 * 4. **单飞（singleflight）**：同一账号同时只允许一个刷新在途，其他调用等待
 *    同一个 Promise。原因：刷新有副作用（消耗 refresh_token），并发两次刷新
 *    不是"更快"，而是"一次成功 + 一次伪造的 invalid_grant"。
 *
 * 时间单位约定：本模块内部时钟 injected `clock()` 返回**毫秒**；凭据对象上的
 * `expires_at` 沿用仓库既有契约（unix **秒**，与 codex.mjs 的 Account 一致），
 * 精确到毫秒的值写在 `expires_at_ms`。两者同时存在时以 `expires_at_ms` 为准。
 */

import { CredentialStore } from './credential-store.mjs'

/** 上游未给 expires_in 时的保守 TTL：1 小时（不是 8 小时） */
export const DEFAULT_TTL_MS = 3600_000

/** 提前多久认为需要刷新（默认 5 分钟，与调度器习惯一致） */
export const DEFAULT_SKEW_MS = 5 * 60_000

/** 单次 refresh() 内的最大尝试次数（含首次） */
export const DEFAULT_MAX_ATTEMPTS = 3

/** 两次尝试之间的退避下限，同时也是 needs_reauth 结果的抑制窗口 */
export const DEFAULT_MIN_RETRY_GAP_MS = 1000

/** 这些错误码属于传输层抖动，可以重试 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'FETCH_ERROR',
])

/** 上游明确表示「凭据已废」的错误码，绝对不能重试 */
const FATAL_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'invalid_token',
  'unauthorized_client',
  'access_denied',
  'refresh_token_reused',
  'refresh_token_expired',
])

/** 状态档位 */
export const STATE = Object.freeze({
  FRESH: 'fresh',
  EXPIRING: 'expiring',
  EXPIRED: 'expired',
  NEEDS_REAUTH: 'needs_reauth',
})

function normalizeAccountId(accountId) {
  const id = typeof accountId === 'string' ? accountId.trim() : ''
  if (!id) throw new Error('accountId is required')
  return id
}

/** 凭据上的到期时间 → 毫秒时间戳；没有则 null */
export function expiryMs(credential) {
  if (!credential || typeof credential !== 'object') return null
  const ms = credential.expires_at_ms
  if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) return ms
  const secs = credential.expires_at
  if (typeof secs === 'number' && Number.isFinite(secs) && secs > 0) return secs * 1000
  return null
}

/**
 * 把上游响应里的 expires_in 归一化成毫秒。
 * 只接受正数；字符串数字也认（部分上游会把它序列化成字符串）。
 */
export function normalizeExpiresIn(value) {
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 1000)
}

/**
 * 从 Retry-After / retry_after / retry_after_ms 里取等待毫秒；没有则 null。
 *
 * 支持三种常见承载方式：数字字段（秒）、毫秒字段、HTTP 头（秒或 `Headers` 对象）。
 * 上游有时把 Retry-After 写成 HTTP-date，这里不解析日期——退避策略会用默认值，
 * 不会因为解析失败就不等待。
 */
export function retryAfterMs(error) {
  if (!error || typeof error !== 'object') return null
  const asMs = Number(error.retry_after_ms)
  if (Number.isFinite(asMs) && asMs > 0) return Math.round(asMs)
  for (const candidate of [error.retry_after, error.retryAfter]) {
    const ms = normalizeExpiresIn(candidate)
    if (ms != null) return ms
  }
  const headers = error.headers || error.response?.headers || null
  if (headers && typeof headers === 'object') {
    const raw = typeof headers.get === 'function'
      ? headers.get('retry-after')
      : headers['retry-after'] ?? headers['Retry-After']
    const fromHeader = normalizeExpiresIn(raw)
    if (fromHeader != null) return fromHeader
  }
  return null
}

/**
 * 把上游给的绝对时间归一化成毫秒。
 *
 * 接受毫秒时间戳、秒时间戳、数字字符串、ISO/RFC3339 字符串。识别不出返回 null，
 * 由调用方回落到 expires_in 或默认 TTL——不要在解析失败时猜一个乐观值。
 */
export function normalizeAbsoluteMs(value) {
  if (value == null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return Math.round(value > 1e11 ? value : value * 1000)
  }
  const s = String(value).trim()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return normalizeAbsoluteMs(Number(s))
  const parsed = Date.parse(s)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

/**
 * 错误分类。
 *
 * 返回 `{retryable, fatal, status, code, waitMs, message}`：
 *   - fatal     → 立即 needs_reauth，不再尝试
 *   - retryable → 走退避重试（429 用 Retry-After）
 *   - 两者都假  → 未知的协议错误，按不可重试处理并记录
 *
 * 判定顺序有意为之：先看「明确的废凭据信号」，再看 HTTP 状态码，最后看传输层
 * 错误码。400 一律不重试——OAuth 的 400 基本只有参数/凭据错误两种可能，重试
 * 只会多消耗一次已经失效的 refresh_token。
 */
export function classifyRefreshError(error) {
  if (error && typeof error === 'object' && error.needs_reauth === true) {
    return {
      retryable: false,
      fatal: true,
      status: Number(error.status) || null,
      code: String(error.code || 'needs_reauth'),
      waitMs: null,
      message: String(error.message || 'refresh rejected'),
    }
  }
  const status = Number(
    error?.status ?? error?.statusCode ?? error?.response?.status ?? 0,
  ) || null
  const rawCode = error?.code ?? error?.error ?? error?.body?.error ?? null
  const code = rawCode == null ? '' : String(rawCode)
  const message = String(error?.message || error?.description || error?.body?.error_description || code || 'refresh failed')

  if (FATAL_CODES.has(code)) {
    return { retryable: false, fatal: true, status, code, waitMs: null, message }
  }
  if (status === 400) {
    return { retryable: false, fatal: true, status, code: code || 'bad_request', waitMs: null, message }
  }
  if (status === 401 || status === 403) {
    return { retryable: false, fatal: true, status, code: code || 'unauthorized', waitMs: null, message }
  }
  if (status === 429) {
    return {
      retryable: true,
      fatal: false,
      status,
      code: code || 'rate_limited',
      waitMs: retryAfterMs(error),
      message,
    }
  }
  if (status != null && status >= 500) {
    return { retryable: true, fatal: false, status, code: code || `http_${status}`, waitMs: null, message }
  }
  if (RETRYABLE_CODES.has(code)) {
    return { retryable: true, fatal: false, status, code, waitMs: null, message }
  }
  if (status != null) {
    return { retryable: false, fatal: true, status, code: code || `http_${status}`, waitMs: null, message }
  }
  // 没有状态码也不认识的错误：来自传输层的可能性更大，给重试机会；
  // 真正的授权失败一定带着 400/401 或 invalid_grant，不会落到这里。
  return { retryable: true, fatal: false, status: null, code: code || 'transport_error', waitMs: null, message }
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    // 定时器不应拖住宿主进程退出（服务里常见的长驻循环场景）
    if (typeof t.unref === 'function') t.unref()
  })
}

/**
 * Token 刷新管理器。
 *
 * 与存储层的关系：本类只依赖 `store` 的三个方法（load / save / withLock），
 * 只要形状一致就能替换实现（内存、文件、远端的都行）。
 */
export class TokenRefresher {
  /**
   * @param {object} opts
   * @param {CredentialStore|object} opts.store 凭据存储
   * @param {(credential:object)=>Promise<object>} [opts.refreshFn] 上游刷新实现
   * @param {() => number} [opts.clock] 毫秒时钟
   * @param {number} [opts.skewMs] 提前刷新窗口
   * @param {number} [opts.minRetryGapMs] 退避下限 + needs_reauth 抑制窗口
   * @param {number} [opts.maxAttempts] 单次 refresh 的最大尝试次数
   * @param {(ms:number)=>Promise<void>} [opts.sleep] 注入等待（测试用）
   * @param {object} [opts.logger]
   */
  constructor({
    store,
    refreshFn = null,
    clock = () => Date.now(),
    skewMs = DEFAULT_SKEW_MS,
    minRetryGapMs = DEFAULT_MIN_RETRY_GAP_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sleep = defaultSleep,
    logger = null,
  } = {}) {
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function' || typeof store.withLock !== 'function') {
      throw new Error('TokenRefresher requires a store with load/save/withLock')
    }
    this.store = store
    this.refreshFn = typeof refreshFn === 'function' ? refreshFn : null
    this.clock = typeof clock === 'function' ? clock : () => Date.now()
    this.skewMs = Number.isFinite(skewMs) && skewMs >= 0 ? skewMs : DEFAULT_SKEW_MS
    this.minRetryGapMs = Number.isFinite(minRetryGapMs) && minRetryGapMs >= 0
      ? minRetryGapMs
      : DEFAULT_MIN_RETRY_GAP_MS
    this.maxAttempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_MAX_ATTEMPTS
    this.sleep = typeof sleep === 'function' ? sleep : defaultSleep
    this.logger = logger

    /** 单飞表：accountId -> Promise<result> */
    this.inflight = new Map()
    /** 上次致命失败：accountId -> {at, result}，用于抑制短时间内的重复冲击 */
    this.lastFatal = new Map()
    /** 统计 */
    this.stats = { calls: 0, joined: 0, refreshed: 0, skipped: 0, shared: 0, failed: 0, needs_reauth: 0 }
  }

  get canRefresh() {
    return typeof this.refreshFn === 'function'
  }

  // ─────────────── 状态判定 ───────────────

  /**
   * 是否需要刷新（提前 skewMs）。
   *
   * 'needs_reauth' 返回 false：那种状态刷不动，需要的是重新授权。这个区分很重要，
   * 否则调度器会对一个已废的 refresh_token 无限重试。
   *
   * @param {object} credential
   * @param {number} [now] 毫秒
   */
  needsRefresh(credential, now = this.clock()) {
    const state = this.accountState(credential, now)
    return state === STATE.EXPIRING || state === STATE.EXPIRED
  }

  /**
   * 四档状态：fresh / expiring / expired / needs_reauth。
   *
   * - needs_reauth：被显式标记，或已过期且没有 refresh_token（救不回来）
   * - fresh：距到期时间超过 skewMs
   * - expiring：已进入 skewMs 窗口，还可以用但应该刷
   * - expired：已过期但还有 refresh_token，可以尝试刷新
   *
   * 没有到期时间视为 fresh（判断不了就不打扰），与 codex-credentials.mjs 一致。
   */
  accountState(credential, now = this.clock()) {
    if (!credential || typeof credential !== 'object') return STATE.NEEDS_REAUTH
    if (credential.needs_reauth === true) return STATE.NEEDS_REAUTH
    if (!credential.access_token) {
      // 没有 access_token：有 refresh_token 就还能救，否则就是需要重新授权
      return credential.refresh_token ? STATE.EXPIRED : STATE.NEEDS_REAUTH
    }
    const exp = expiryMs(credential)
    if (exp == null) return STATE.FRESH
    if (now >= exp) {
      return credential.refresh_token ? STATE.EXPIRED : STATE.NEEDS_REAUTH
    }
    if (now >= exp - this.skewMs) return STATE.EXPIRING
    return STATE.FRESH
  }

  // ─────────────── 单飞刷新 ───────────────

  /**
   * 单飞刷新。同一账号并发调用共享同一个 Promise。
   *
   * @param {string} accountId
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<{
   *   status:'refreshed'|'skipped'|'shared'|'needs_reauth'|'failed',
   *   needs_reauth:boolean, reason:string|null, credential:object|null,
   *   generation:number, attempts:number, error?:object
   * }>}
   */
  async refresh(accountId, { force = false } = {}) {
    const id = normalizeAccountId(accountId)
    this.stats.calls += 1

    const existing = this.inflight.get(id)
    if (existing) {
      this.stats.joined += 1
      return existing
    }

    // 这里的赋值与 #run 的首个 await 之间没有其他 JS 能插入（同步段），
    // 因此不会出现"两个调用都以为自己该发起刷新"的窗口。
    const promise = this.#run(id, { force })
    this.inflight.set(id, promise)
    try {
      return await promise
    } finally {
      // 只清理自己那一份：后来者可能已经把自己的 Promise 放进来，
      // 无条件 delete 会让单飞失效（第二个请求看不到在途的那个）。
      if (this.inflight.get(id) === promise) this.inflight.delete(id)
    }
  }

  async #run(accountId, { force }) {
    const { credential: first, generation: firstGeneration } = await this.store.load(accountId)
    if (!first) {
      throw Object.assign(new Error(`unknown account: ${accountId}`), { code: 'unknown_account' })
    }

    // 快路径：锁外先看一眼，避免不必要地排队
    if (!force) {
      const suppressed = this.#suppressedResult(accountId, first, firstGeneration)
      if (suppressed) return suppressed
      if (!this.needsRefresh(first, this.clock())) {
        this.stats.skipped += 1
        return {
          status: 'skipped',
          needs_reauth: first.needs_reauth === true,
          reason: first.needs_reauth === true ? first.needs_reauth_reason || 'needs_reauth' : 'not_due',
          credential: first,
          generation: firstGeneration,
          attempts: 0,
        }
      }
    }

    return this.store.withLock(accountId, () => this.#refreshLocked(accountId, { force }))
  }

  async #refreshLocked(accountId, { force }) {
    let { credential: current, generation } = await this.store.load(accountId)
    if (!current) {
      throw Object.assign(new Error(`unknown account: ${accountId}`), { code: 'unknown_account' })
    }

    if (!force) {
      const suppressed = this.#suppressedResult(accountId, current, generation)
      if (suppressed) return suppressed
      if (!this.needsRefresh(current, this.clock())) {
        this.stats.skipped += 1
        return {
          status: 'skipped',
          needs_reauth: current.needs_reauth === true,
          reason: current.needs_reauth === true ? current.needs_reauth_reason || 'needs_reauth' : 'not_due',
          credential: current,
          generation,
          attempts: 0,
        }
      }
    }

    if (!this.canRefresh) {
      this.stats.failed += 1
      return {
        status: 'failed',
        needs_reauth: false,
        reason: 'no_refresh_fn',
        credential: current,
        generation,
        attempts: 0,
        error: { code: 'no_refresh_fn', message: 'no refreshFn injected' },
      }
    }

    if (!current.refresh_token) {
      // 没有 refresh_token：直接进入需要重新授权，不去打上游
      return this.#markNeedsReauth(accountId, current, generation, {
        reason: 'refresh_token_missing',
        error: { code: 'refresh_token_missing', message: 'credential has no refresh token' },
      })
    }

    let lastError = null
    let waitMs = 0

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (attempt > 1) {
        // ── 重试前必须重新读存储 ──
        // 刷新请求可能已经被服务端处理、只是响应丢了。别的执行体若在此期间
        // 完成了刷新，这里必须采用它的结果，不能拿旧 refresh_token 再打一次。
        const latest = await this.store.load(accountId)
        if (latest.generation !== generation) {
          this.stats.shared += 1
          this.#log('info', accountId, 'refresh superseded by another writer', {
            from_generation: generation,
            to_generation: latest.generation,
          })
          return {
            status: 'shared',
            needs_reauth: latest.credential?.needs_reauth === true,
            reason: 'generation_advanced',
            credential: latest.credential,
            generation: latest.generation,
            attempts: attempt - 1,
          }
        }
        // 等待放在重读之后：先确认还要不要打，再决定等多久
        await this.sleep(Math.max(0, waitMs))
        // 等待期间（真实环境里可能是几十秒）存储同样可能被改写
        const afterWait = await this.store.load(accountId)
        if (afterWait.generation !== generation) {
          this.stats.shared += 1
          return {
            status: 'shared',
            needs_reauth: afterWait.credential?.needs_reauth === true,
            reason: 'generation_advanced_after_wait',
            credential: afterWait.credential,
            generation: afterWait.generation,
            attempts: attempt - 1,
          }
        }
        current = afterWait.credential
        generation = afterWait.generation
      }

      try {
        const raw = await this.refreshFn(current)
        return await this.#applyUpstream(accountId, current, generation, raw, attempt)
      } catch (error) {
        const verdict = classifyRefreshError(error)
        lastError = { ...verdict }

        if (verdict.fatal) {
          // 不可重试：立即标记，不浪费剩余的尝试次数
          const result = await this.#markNeedsReauth(accountId, current, generation, {
            reason: verdict.code || 'refresh_rejected',
            error: {
              code: verdict.code,
              status: verdict.status,
              message: verdict.message,
            },
          })
          return { ...result, attempts: attempt }
        }

        if (attempt >= this.maxAttempts || !verdict.retryable) {
          this.stats.failed += 1
          this.#log('warn', accountId, 'refresh failed', {
            attempts: attempt,
            code: verdict.code,
            status: verdict.status,
            message: verdict.message,
          })
          return {
            status: 'failed',
            needs_reauth: false,
            reason: verdict.code || 'refresh_failed',
            credential: current,
            generation,
            attempts: attempt,
            error: { code: verdict.code, status: verdict.status, message: verdict.message },
          }
        }

        // 429 用上游给的 Retry-After；其余用指数退避，下限是 minRetryGapMs
        const backoff = Math.max(this.minRetryGapMs, this.minRetryGapMs * 2 ** (attempt - 1))
        waitMs = verdict.waitMs != null ? verdict.waitMs : backoff
        this.#log('warn', accountId, 'refresh transient failure, retrying', {
          attempt,
          code: verdict.code,
          status: verdict.status,
          wait_ms: waitMs,
        })
      }
    }

    // 理论不可达（循环内已覆盖所有分支），保留兜底
    this.stats.failed += 1
    return {
      status: 'failed',
      needs_reauth: false,
      reason: lastError?.code || 'refresh_failed',
      credential: current,
      generation,
      attempts: this.maxAttempts,
      error: lastError,
    }
  }

  // ─────────────── 结果落地 ───────────────

  /**
   * 把上游响应落成凭据。
   *
   * 两条硬约束：
   *   a. 没有 access_token → 不可恢复（HTTP 成功但响应残缺，refresh_token 大概
   *      已被消费），标记 needs_reauth，绝不重试。
   *   b. 没有 refresh_token → 同样标记 needs_reauth，且**保留上游给的新
   *      access_token**：它现在是有效的，能用就先用，但我们清楚下一次刷新会
   *      失败，因此必须让状态显式变成"需要重新授权"，而不是假装还能刷。
   */
  async #applyUpstream(accountId, current, generation, raw, attempt) {
    if (!raw || typeof raw !== 'object') {
      const result = await this.#markNeedsReauth(accountId, current, generation, {
        reason: 'invalid_refresh_response',
        error: { code: 'invalid_refresh_response', message: 'refreshFn must return an object' },
      })
      return { ...result, attempts: attempt }
    }

    const accessToken = typeof raw.access_token === 'string' ? raw.access_token.trim() : ''
    if (!accessToken) {
      const result = await this.#markNeedsReauth(accountId, current, generation, {
        reason: 'access_token_missing',
        error: { code: 'access_token_missing', message: 'refresh response has no access_token' },
      })
      return { ...result, attempts: attempt }
    }

    const rotatedRefreshToken = typeof raw.refresh_token === 'string' ? raw.refresh_token.trim() : ''
    const upstreamTtlMs = normalizeExpiresIn(raw.expires_in)

    const nowMs = this.clock()
    // 优先用上游显式给的绝对时间；其次 expires_in；最后保守估 1 小时。
    // 绝不使用更长的兜底值：过长的假设会让"实际已过期"的 token 被当成新鲜，
    // 报错点被推到推理路径上，根因藏在刷新路径里。
    let expiresAtMs = null
    let ttlSource = 'expires_in'
    const explicitMs = normalizeAbsoluteMs(raw.expires_at_ms)
    if (explicitMs != null) {
      expiresAtMs = explicitMs
      ttlSource = 'expires_at_ms'
    } else {
      const fromAbsolute = normalizeAbsoluteMs(raw.expires_at)
      if (fromAbsolute != null) {
        expiresAtMs = fromAbsolute
        ttlSource = 'expires_at'
      }
    }
    if (expiresAtMs == null) {
      if (upstreamTtlMs != null) {
        expiresAtMs = nowMs + upstreamTtlMs
        ttlSource = 'expires_in'
      } else {
        expiresAtMs = nowMs + DEFAULT_TTL_MS
        ttlSource = 'assumed_default'
      }
    }
    // 上游给了个已经过去的时间：按 0 秒处理（等价于立刻到期），但仍然写下去，
    // 让下一次 needsRefresh 立刻为真、把问题暴露在本轮，而不是悄悄放大 TTL。
    if (expiresAtMs <= nowMs) expiresAtMs = nowMs

    const next = {
      ...current,
      access_token: accessToken,
      // 严格轮换：只认上游返回的 refresh_token。没有返回值就写空串，
      // 绝不把旧的留下——轮换模式下旧值在上游已经作废，留着它只会让
      // 下一次刷新拿一个确定失败的凭据去打上游，把"需要重新授权"这个
      // 明确事实伪装成"偶发的 invalid_grant"。
      refresh_token: rotatedRefreshToken,
      expires_at: Math.floor(expiresAtMs / 1000),
      expires_at_ms: expiresAtMs,
      expires_in_source: ttlSource,
      refreshed_at: nowMs,
      refresh_generation: (current.refresh_generation || 0) + 1,
    }
    if (typeof raw.id_token === 'string' && raw.id_token) next.id_token = raw.id_token
    if (typeof raw.scope === 'string' && raw.scope.trim()) {
      next.scopes = raw.scope.trim().split(/\s+/)
    }
    if (raw.chatgpt_account_id && typeof raw.chatgpt_account_id === 'string') {
      next.chatgpt_account_id = raw.chatgpt_account_id
    }

    // TTL 缺失：记一条日志，这是"上游行为变化"的早期信号
    if (ttlSource === 'assumed_default') {
      this.#log('warn', accountId, 'upstream omitted expires_in, assuming conservative ttl', {
        assumed_ttl_ms: DEFAULT_TTL_MS,
      })
    }

    if (!rotatedRefreshToken) {
      // 规则 1：不回退旧 token。把新 access_token 存下来（还能用），
      // 但状态必须是 needs_reauth，避免下一次拿已作废的 refresh_token 去撞。
      next.needs_reauth = true
      next.needs_reauth_reason = 'refresh_token_not_rotated'
      const saved = await this.#saveCautious(accountId, next, generation)
      this.stats.needs_reauth += 1
      this.#log('warn', accountId, 'refresh_token was not rotated; marking needs_reauth', {
        reason: 'refresh_token_not_rotated',
      })
      const result = {
        status: 'needs_reauth',
        needs_reauth: true,
        reason: 'refresh_token_not_rotated',
        credential: saved.credential ?? null,
        generation: saved.generation,
        attempts: attempt,
        error: { code: 'refresh_token_not_rotated', message: 'upstream did not return a new refresh_token' },
      }
      this.#rememberFatal(accountId, result)
      return result
    }

    next.needs_reauth = false
    next.needs_reauth_reason = null
    const saved = await this.#saveCautious(accountId, next, generation)
    this.stats.refreshed += 1
    this.lastFatal.delete(accountId)
    this.#log('info', accountId, 'credential refreshed', {
      generation: saved.generation,
      expires_at_ms: next.expires_at_ms,
      rotated: true,
    })
    return {
      status: 'refreshed',
      needs_reauth: false,
      reason: null,
      credential: saved.credential ?? null,
      generation: saved.generation,
      attempts: attempt,
    }
  }

  /** 标记 needs_reauth 并持久化（CAS 冲突时以磁盘上的结果为准） */
  async #markNeedsReauth(accountId, current, generation, { reason, error }) {
    const next = {
      ...current,
      needs_reauth: true,
      needs_reauth_reason: reason,
      needs_reauth_at: this.clock(),
    }
    const saved = await this.#saveCautious(accountId, next, generation)
    this.stats.needs_reauth += 1
    this.#log('error', accountId, 'credential requires reauthorization', {
      reason,
      code: error?.code ?? null,
      status: error?.status ?? null,
    })
    const result = {
      status: 'needs_reauth',
      needs_reauth: true,
      reason,
      credential: saved.credential ?? null,
      generation: saved.generation,
      attempts: 0,
      error: error ?? null,
    }
    this.#rememberFatal(accountId, result)
    return result
  }

  /**
   * 保存并容忍 CAS 冲突。
   *
   * 冲突意味着一件事：这条路径读到的是旧快照，而另一个执行体刚刚写过。
   * 此时正确的做法是采用磁盘上的结果（刷新有副作用、结果是等价的），
   * 而不是把我们基于旧快照算出的值硬盖上去。
   */
  async #saveCautious(accountId, credential, expectedGeneration) {
    try {
      const saved = await this.store.save(accountId, credential, expectedGeneration)
      return { credential: saved.credential, generation: saved.generation, conflict: false }
    } catch (error) {
      if (error?.code === 'generation_conflict') {
        const latest = await this.store.load(accountId)
        this.stats.shared += 1
        this.#log('warn', accountId, 'generation conflict on save, adopting stored credential', {
          expected_generation: expectedGeneration,
          actual_generation: latest.generation,
        })
        return { credential: latest.credential, generation: latest.generation, conflict: true }
      }
      throw error
    }
  }

  // ─────────────── 抑制窗口 ───────────────

  /** 短时间内对已知 needs_reauth 的账号重复调用，直接复用上次结论 */
  #suppressedResult(accountId, credential, generation) {
    if (credential?.needs_reauth !== true) return null
    const prev = this.lastFatal.get(accountId)
    if (!prev) return null
    const now = this.clock()
    if (now - prev.at >= this.minRetryGapMs) return null
    return {
      ...prev.result,
      status: 'needs_reauth',
      credential,
      generation,
      attempts: 0,
      suppressed: true,
    }
  }

  #rememberFatal(accountId, result) {
    this.lastFatal.set(accountId, { at: this.clock(), result: { ...result, credential: null } })
  }

  // ─────────────── 诊断 ───────────────

  /** 供健康检查：不含 token 明文 */
  snapshot() {
    const now = this.clock()
    const accounts = []
    const ids = typeof this.store.accountIds === 'function' ? this.store.accountIds() : []
    for (const id of ids) {
      const { credential, generation } = typeof this.store.peek === 'function'
        ? this.store.peek(id)
        : { credential: null, generation: 0 }
      const exp = expiryMs(credential)
      accounts.push({
        account: id,
        state: this.accountState(credential, now),
        generation,
        expires_at_ms: exp,
        seconds_left: exp == null ? null : Math.max(0, Math.floor((exp - now) / 1000)),
        has_access_token: Boolean(credential?.access_token),
        has_refresh_token: Boolean(credential?.refresh_token),
        needs_reauth: credential?.needs_reauth === true,
        needs_reauth_reason: credential?.needs_reauth_reason ?? null,
      })
    }
    return {
      clock_ms: now,
      skew_ms: this.skewMs,
      min_retry_gap_ms: this.minRetryGapMs,
      max_attempts: this.maxAttempts,
      inflight: this.inflight.size,
      stats: { ...this.stats },
      accounts,
    }
  }

  #log(level, accountId, message, fields = {}) {
    if (!this.logger) return
    const fn = this.logger[level] || this.logger.info
    if (typeof fn !== 'function') return
    try {
      fn.call(this.logger, { account: accountId, ...fields }, message)
    } catch {
      // 日志实现不许影响刷新主流程
    }
  }
}
