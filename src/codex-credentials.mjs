/**
 * Codex 凭据加载、过期检测与刷新注入点。
 *
 * 职责：把磁盘上的凭据文件读成统一的 Account 列表（形状与 codex.mjs 的
 * Account 一致），并在加载/使用时检查有效期。
 *
 * 支持两种文件形态：
 *   1. 单账号（Codex CLI / 登录脚本导出的那种）：
 *      {
 *        "access_token": "...",
 *        "account_id": "969554ee-...",     ← 注意是 account_id，不是 chatgpt_account_id
 *        "expired": "2026-11-02T07:51:47+08:00",
 *        "refresh_token": "rt.1....",
 *        "email": "...", "type": "codex", "disabled": false
 *      }
 *   2. 多账号：`{"accounts":[...]}`（交给 codex.mjs 的 parseCredentialFile 校验）
 *
 * 关键约束：
 *
 * 1. **本模块不做刷新**。不是偷懒，是范围问题：ChatGPT 侧的 token 刷新需要走
 *    OAuth PKCE 流程（/oauth/authorize → 回调拿 code → /oauth/token 换 code，
 *    还要带 codex CLI 的 client_id 与 PKCE code_verifier），刷新失败往往意味着
 *    需要重新人工授权。把半截刷新逻辑塞在加载模块里，结果是"偶尔能刷成功、
 *    刷失败时把凭据文件写坏"，比明确报 needs_refresh 更难排查。
 *    因此只留 `refreshFn` 注入点：调用方注入自己的刷新实现（可以是 PKCE 流程、
 *    也可以是外部凭据服务），本模块负责"调用它 + 回写 + 重新校验"这一层。
 *
 * 2. 过期时间统一用 **unix 秒**，字段名 `expires_at`（与 codex.mjs 的 i64 一致）。
 *    输入侧的多种写法（ISO 字符串 / 毫秒时间戳 / 秒时间戳）都归一化到秒。
 *
 * 3. 凭据文件缺失或格式错误必须显式报错，不能返回空列表——空列表会让所有
 *    请求变成"没有可用账号"，而这种失败看起来像上游故障。
 */

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { parseCredentialFile, normalizeAccount } from './codex.mjs'
import { TokenRefresher, DEFAULT_SKEW_MS as DEFAULT_REFRESH_SKEW_MS } from './token-refresh.mjs'

/** 剩余有效期低于这个秒数时打 warning */
export const EXPIRY_WARN_SECS = 3600
/** 剩余有效期低于这个秒数时视为"即将不可用"，加载阶段就告警 */
export const EXPIRY_CRITICAL_SECS = 300
/**
 * 上游没给 expires_in / expires_at 时的保守 TTL（秒）。
 *
 * 取 1 小时而不是更长：过长的假设会把"实际已经过期"的 token 当成新鲜，
 * 报错点被推到真正使用 token 的推理路径上，根因却藏在刷新路径里。
 * 宁可多刷一次，也不要拿一个可能已失效的 token 去请求上游。
 */
export const DEFAULT_REFRESH_TTL_SECS = 3600

/**
 * 解析时间值 → unix 秒。
 * 接受：ISO/RFC3339 字符串、秒级数字、毫秒级数字（>1e11 视为毫秒）。
 * 空值/无法解析返回 null。
 */
export function parseExpiry(value) {
  if (value == null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    // 1e11 秒 ≈ 5138 年，超过它只能是毫秒
    return Math.floor(value > 1e11 ? value / 1000 : value)
  }
  const s = String(value).trim()
  if (!s) return null
  if (/^\d+(\.\d+)?$/.test(s)) return parseExpiry(Number(s))
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 1000)
}

/**
 * 单账号形态 → 内部 Account。
 *
 * 字段改名两处，都是踩过的：
 *   - `account_id` → `chatgpt_account_id`（出站头叫 chatgpt-account-id）
 *   - `expired`    → `expires_at`（unix 秒）
 * `disabled:true` 的账号直接抛错，而不是过滤掉：静默少一个账号会让
 * "为什么只有一个号可用"这种问题查很久。
 */
export function singleAccountToAccount(raw, { fallbackId } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const accessToken = typeof src.access_token === 'string' ? src.access_token : ''
  if (!accessToken) throw new Error('credential missing `access_token`')
  if (src.disabled === true) {
    throw new Error(`account is disabled: ${src.email || src.account_id || '(no email)'}`)
  }

  const accountId = src.account_id || src.chatgpt_account_id || ''
  // id 是调度器的主键，必须稳定。优先用 account_id，其次 email，最后随机。
  // 不要用 access_token 片段：token 刷新后会变，亲和会全部失效。
  const id = String(src.id || accountId || src.email || fallbackId || randomUUID())

  return normalizeAccount({
    id,
    access_token: accessToken,
    refresh_token: typeof src.refresh_token === 'string' ? src.refresh_token : '',
    id_token: typeof src.id_token === 'string' ? src.id_token : '',
    expires_at: parseExpiry(src.expires_at ?? src.expired),
    chatgpt_account_id: accountId,
    rpm: Number.isInteger(src.rpm) ? src.rpm : null,
    max_concurrency: Number.isInteger(src.max_concurrency) ? src.max_concurrency : null,
  })
}

/** 一个文件里是不是多账号形态 */
export function isMultiAccountShape(parsed) {
  return Boolean(parsed) && typeof parsed === 'object' && Array.isArray(parsed.accounts)
}

/**
 * 解析凭据文本 → Account 列表。
 *
 * @param {string} text 文件内容
 * @param {{fallbackId?:string}} [opts]
 * @returns {{accounts:Array<object>, shape:'single'|'multi'}}
 */
export function parseCredentialText(text, { fallbackId } = {}) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch (e) {
    throw new Error(`credential file is not valid JSON: ${e.message}`)
  }
  if (Array.isArray(parsed)) {
    throw new Error('credential file must be an object, not a bare array')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('credential file must be an object')
  }

  if (isMultiAccountShape(parsed)) {
    // 多账号走 codex.mjs 的严格校验：字段类型错会立刻抛，而不是静默变空
    const { accounts } = parseCredentialFile(JSON.stringify(parsed))
    return { accounts, shape: 'multi' }
  }

  return { accounts: [singleAccountToAccount(parsed, { fallbackId })], shape: 'single' }
}

/**
 * 从文件加载凭据。
 *
 * 读不到文件直接抛错并带路径——启动阶段就应该失败，而不是等到第一个请求。
 * @returns {{accounts:Array<object>, shape:'single'|'multi', path:string}}
 */
export function loadCredentialFile(path, { fallbackId } = {}) {
  if (!path) throw new Error('credential path is required')
  let text
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`read credential file ${path}: ${e.message}`)
  }
  const { accounts, shape } = parseCredentialText(text, { fallbackId })
  if (accounts.length === 0) throw new Error(`credential file ${path} contains no accounts`)
  return { accounts, shape, path }
}

// ─────────────── 过期判定 ───────────────

/**
 * 凭据状态机。与 server.mjs 的 credentialState 保持同一套档位命名，
 * 便于控制面复用同一套判断。
 *
 * missing / fresh / refreshable / refresh_window / expired / expired_refreshable
 *
 * @param {object} account
 * @param {{now?:number}} [opts] now 用 unix 秒
 */
export function accountState(account, { now = Math.floor(Date.now() / 1000) } = {}) {
  const token = account?.access_token
  // 显式标记优先于一切推断：一旦被判定为需要重新授权，就不再假装"还能刷"，
  // 否则调度器会拿着已作废的 refresh_token 无限重试。
  if (account?.needs_reauth === true) return 'needs_reauth'
  if (!token) return account?.refresh_token ? 'expired_refreshable' : 'missing'
  const exp = account?.expires_at
  if (exp == null) return 'fresh' // 没有到期时间视为新鲜（无法判断就不打扰）
  if (now >= exp) return account.refresh_token ? 'expired_refreshable' : 'expired'
  const left = exp - now
  if (left < EXPIRY_CRITICAL_SECS) return 'refresh_window'
  if (left < EXPIRY_WARN_SECS) return 'refreshable'
  return 'fresh'
}

/** 账号是否还在有效期（refresh_token 存在时过期也算"可救"） */
export function isUsable(account, opts) {
  const state = accountState(account, opts)
  // needs_reauth 明确排除：这个状态的账号要人工重新授权，把它算作可用只会让
  // 请求拿一个已废的凭据去打上游。
  return state !== 'expired' && state !== 'missing' && state !== 'needs_reauth'
}

/**
 * 检查一整个账号列表，返回需要告警的项。
 *
 * 只告警不抛错：本地时钟偏差、上游临时延长有效期都会让"看起来过期"的账号
 * 仍能用，提前拒绝反而会把可用账号踢掉。真要拒绝由调用方按 state 决定。
 *
 * @returns {{warnings:Array<{id:string,state:string,seconds_left:number|null}>, usable:Array<object>}}
 */
export function checkAccounts(accounts, { now = Math.floor(Date.now() / 1000) } = {}) {
  const warnings = []
  const usable = []
  for (const acc of Array.isArray(accounts) ? accounts : []) {
    const state = accountState(acc, { now })
    const secondsLeft = acc?.expires_at == null ? null : acc.expires_at - now
    if (state === 'fresh') {
      usable.push(acc)
      continue
    }
    warnings.push({ id: acc.id, state, seconds_left: secondsLeft })
    if (state !== 'expired' && state !== 'missing') usable.push(acc)
  }
  return { warnings, usable }
}

/** 默认日志器：stderr 上的一行 JSON，字段与 server.mjs 的日志风格一致 */
export const defaultLogger = {
  warn(fields, message) {
    console.warn(JSON.stringify({ level: 'WARN', fields: { message, ...fields }, target: 'codex::credentials' }))
  },
  info(fields, message) {
    console.log(JSON.stringify({ level: 'INFO', fields: { message, ...fields }, target: 'codex::credentials' }))
  },
}

/**
 * 加载 + 检查 + 打告警。
 *
 * @param {string} path
 * @param {{fallbackId?:string, now?:number, logger?:object}} [opts]
 */
export function loadCredentials(path, { fallbackId, now, logger = defaultLogger } = {}) {
  const loaded = loadCredentialFile(path, { fallbackId })
  const { warnings, usable } = checkAccounts(loaded.accounts, { now })

  for (const w of warnings) {
    const tail = w.seconds_left == null ? '' : ` seconds_left=${w.seconds_left}`
    logger.warn(
      { path: loaded.path, account: w.id, credential_state: w.state, shape: loaded.shape },
      `codex credential needs attention:${tail}`,
    )
  }
  return { ...loaded, warnings, usable }
}

// ─────────────── 刷新注入点 ───────────────

/**
 * 带刷新注入的凭据管理器。
 *
 * `refreshFn` 的约定（签名是契约，实现由调用方提供）：
 *
 *   async refreshFn(account) => {
 *     access_token: string        // 新 token
 *     refresh_token?: string      // 轮换后的 refresh token（上游常轮换）
 *     id_token?: string
 *     expires_at?: number|string  // unix 秒 / 毫秒 / ISO 均可
 *     chatgpt_account_id?: string
 *   }
 *
 * 抛错即视为刷新失败，本类会把账号标记为 needs_refresh 并向上抛。
 *
 * **为什么不内置刷新**：见文件头第 1 条。这里的职责边界是
 * "决定该不该刷 / 调用注入的刷 / 回写内存状态"，不实现 PKCE 换 token。
 *
 * **两种刷新路径**：
 *   - 传入 `refresher`（或传 `store` 让本类自建）→ 走 `TokenRefresher`，具备
 *     单飞、轮换校验、重读存储、保守 TTL、CAS 全套约束。**生产路径应该用这个。**
 *   - 只传 `refreshFn` → 兼容旧调用的直通路径。它不做单飞、也不做 generation
 *     校验，多执行体共享同一凭据时仍可能重复消耗 refresh_token。
 */
export class CredentialManager {
  /**
   * @param {Array<object>} accounts
   * @param {object} [opts]
   * @param {Function|null} [opts.refreshFn] 刷新实现，缺省表示不支持刷新
   * @param {() => number} [opts.now] 返回 unix 秒的时钟，便于测试
   * @param {object} [opts.logger]
   * @param {string|null} [opts.path] 凭据文件路径（有它才回写文件）
   * @param {object|null} [opts.store] CredentialStore 实例，与 refreshFn 同时给出时自建 TokenRefresher
   * @param {object|null} [opts.refresher] 已构造的 TokenRefresher 实例（优先于 store）
   * @param {number} [opts.skewMs] 提前刷新窗口（毫秒），透传给 TokenRefresher
   */
  constructor(accounts, {
    refreshFn = null,
    now = () => Math.floor(Date.now() / 1000),
    logger = defaultLogger,
    path = null,
    store = null,
    refresher = null,
    skewMs = DEFAULT_REFRESH_SKEW_MS,
  } = {}) {
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error('CredentialManager requires at least one account')
    }
    this.accounts = accounts.map((a) => ({ ...a }))
    this.refreshFn = typeof refreshFn === 'function' ? refreshFn : null
    this.now = now
    this.logger = logger
    this.path = path
    this.refresher = refresher || null

    if (!this.refresher && store && this.refreshFn) {
      this.refresher = new TokenRefresher({
        store,
        refreshFn: (credential) => this.refreshFn(this.#findById(credential?.id) || credential),
        clock: () => this.now() * 1000,
        skewMs,
        logger: null,
      })
    }
    // 有 refresher 时用它的一致性存储做回写；没有则退回内存列表
    this.store = this.refresher?.store || store || null
  }

  get canRefresh() {
    return typeof this.refreshFn === 'function' || Boolean(this.refresher?.canRefresh)
  }

  #findById(id) {
    return this.accounts.find((a) => a.id === id) || null
  }

  findByAccessToken(token) {
    return this.accounts.find((a) => a.access_token === token) || null
  }

  /** 账号是否可用（按当前时钟判定） */
  isUsable(account) {
    return isUsable(account, { now: this.now() })
  }

  /**
   * 确保账号可用：快到期的先尝试刷新，过期且无刷新能力时抛 needs_refresh。
   *
   * @param {string} accountId
   * @returns {Promise<object>} 可用账号（可能是刷新后的新对象）
   */
  async ensureFresh(accountId) {
    const idx = this.accounts.findIndex((a) => a.id === accountId)
    if (idx < 0) throw Object.assign(new Error(`unknown account: ${accountId}`), { code: 'unknown_account' })

    const acc = this.accounts[idx]
    const state = accountState(acc, { now: this.now() })

    if (state === 'fresh') return acc

    if (!this.canRefresh) {
      this.logger.warn(
        { account: acc.id, credential_state: state },
        'codex credential needs refresh but no refreshFn injected',
      )
      throw Object.assign(
        new Error(`credential ${state} and no refreshFn injected (OAuth PKCE flow is required)`),
        { code: 'needs_refresh', state },
      )
    }

    // ── 有 TokenRefresher：走带单飞/轮换校验/CAS 的路径 ──
    if (this.refresher) {
      const result = await this.refresher.refresh(accountId, { force: false })
      const fresh = this.store ? (await this.store.load(accountId)).credential : result.credential
      if (fresh) {
        this.accounts[idx] = { ...acc, ...fresh }
      }
      if (result.needs_reauth) {
        this.logger.warn(
          { account: accountId, credential_state: 'needs_reauth', reason: result.reason },
          'codex credential requires reauthorization',
        )
        throw Object.assign(
          new Error(`credential needs reauthorization: ${result.reason}`),
          { code: 'needs_reauth', reason: result.reason, state: 'needs_reauth' },
        )
      }
      if (result.status === 'failed') {
        throw Object.assign(
          new Error(`credential refresh failed: ${result.reason}`),
          { code: 'refresh_failed', reason: result.reason, error: result.error },
        )
      }
      return this.accounts[idx]
    }

    // ── 兼容路径：直接调用注入的 refreshFn ──
    const patch = await this.refreshFn(acc)
    if (!patch || typeof patch !== 'object' || typeof patch.access_token !== 'string' || !patch.access_token) {
      throw Object.assign(
        new Error('refreshFn must return {access_token}'),
        { code: 'refresh_failed' },
      )
    }

    const rotated = typeof patch.refresh_token === 'string' && patch.refresh_token.trim()
      ? patch.refresh_token.trim()
      : ''
    // 轮换模式下上游刷新成功即作废旧 refresh_token。这里若回退到旧值，
    // 下一次刷新必然被判定为无效凭据，账号就再也刷不回来——所以宁可
    // 显式标记需要重新授权，也不把已作废的 token 留在账号上。
    const nextState = rotated ? null : 'refresh_token_not_rotated'

    const expiresAt = patch.expires_at != null
      ? parseExpiry(patch.expires_at)
      : (patch.expires_in > 0
        ? Math.floor(this.now() + Number(patch.expires_in))
        : Math.floor(this.now() + DEFAULT_REFRESH_TTL_SECS))

    const next = {
      ...acc,
      access_token: patch.access_token,
      // 严格轮换：只用上游返回的新 refresh_token。没有就不写回旧值（见下方
      // nextState 分支），因为旧值在上游侧已经作废。
      refresh_token: rotated,
      id_token: typeof patch.id_token === 'string' ? patch.id_token : acc.id_token,
      chatgpt_account_id: patch.chatgpt_account_id || acc.chatgpt_account_id,
      expires_at: expiresAt ?? acc.expires_at,
    }
    if (nextState) {
      next.needs_reauth = true
      next.needs_reauth_reason = nextState
      next.needs_reauth_at = this.now()
    }
    this.accounts[idx] = next

    if (nextState) {
      this.logger.warn(
        { account: next.id, reason: nextState },
        'codex credential refresh did not rotate refresh_token; marking needs_reauth',
      )
      throw Object.assign(
        new Error(`credential needs reauthorization: ${nextState}`),
        { code: 'needs_reauth', reason: nextState, state: 'needs_reauth' },
      )
    }
    this.logger.info({ account: next.id, credential_state: accountState(next, { now: this.now() }) }, 'codex credential refreshed')
    return next
  }

  /** 只读快照，供健康检查 */
  snapshot() {
    const now = this.now()
    return this.accounts.map((a) => ({
      id: a.id,
      state: a.needs_reauth === true ? 'needs_reauth' : accountState(a, { now }),
      expires_at: a.expires_at ?? null,
      seconds_left: a.expires_at == null ? null : a.expires_at - now,
      has_refresh_token: Boolean(a.refresh_token),
      needs_reauth: a.needs_reauth === true,
    }))
  }
}
