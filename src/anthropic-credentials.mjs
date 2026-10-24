/**
 * Anthropic 凭据加载。
 *
 * 支持两种文件形态（与 codex 通道保持一致的心智模型，但字段来源不同）：
 *
 *   1. 单账号（Claude Code 登录导出的那种）：
 *      {
 *        "access_token": "sk-ant-oat01-...",
 *        "refresh_token": "sk-ant-ort01-...",
 *        "expires_at": 1767225600000,
 *        "subscription_type": "max"
 *      }
 *
 *   2. 多账号：
 *      { "accounts": [ {...单账号...}, {...} ] }
 *
 * 另外兼容 `~/.claude/credentials.json` 的官方形态（`{claudeAiOauth:{accessToken,
 * refreshToken, expiresAt}}`）：服务器现有的 credential_path 用的就是这一份，
 * 让两种文件能被同一条路径读进来，省掉「换个模块就得换份文件」的麻烦。
 *
 * 关键约束：
 *
 * 1. **过期时间统一成 unix 毫秒**。输入侧可能是 ISO 串、秒、毫秒，三种都归一。
 *    选毫秒是因为官方 credentials.json 的 expiresAt 本来就是毫秒，
 *    在换算成秒再换回来会引入一次取整误差。
 *
 * 2. **文件缺失/格式错误必须显式报错**，不能返回空列表。空列表会让所有请求
 *    变成「没有可用账号」，这种失败表面上像上游故障，排查成本极高。
 *
 * 3. **不做刷新**。与 codex-credentials 同样的边界：刷新需要 OAuth 换 token 的
 *    完整流程（`TokenRefresher` + 注入的 refreshFn），塞进加载模块只会写出
 *    「偶尔能刷成功、刷失败时把文件写坏」的半截实现。这里只给出状态判定，
 *    由调用方决定何时交给 TokenRefresher。
 *
 * 4. **token 不进日志**。accountState / describeAccount 只吐长度与状态。
 */

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

/** 剩余有效期低于这个毫秒数时视为「即将过期」，应立即刷新 */
export const EXPIRY_WARN_MS = 3_600_000
/** 剩余有效期低于这个毫秒数时视为「刷新窗口」 */
export const EXPIRY_CRITICAL_MS = 300_000

/**
 * 时间值 → unix 毫秒。
 *
 * 判定顺序：
 *   - 数字：> 1e11 视作毫秒（1e11 ms ≈ 1973 年，任何合理的秒级时间戳都远小于它）
 *   - 纯数字字符串：按数字处理
 *   - 其他字符串：交给 Date.parse（ISO / RFC3339 / 常见日期格式）
 * 解析不出来返回 null，而不是当前时间——「不知道」和「现在过期」是两个结论。
 */
export function parseExpiryMs(value) {
  if (value == null) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    return Math.floor(value > 1e11 ? value : value * 1000)
  }
  const text = String(value).trim()
  if (!text) return null
  if (/^\d+(\.\d+)?$/.test(text)) return parseExpiryMs(Number(text))
  const at = Date.parse(text)
  return Number.isFinite(at) ? at : null
}

/**
 * 单账号对象 → 内部 Account。
 *
 * 字段来源有两条：snake_case（access_token / refresh_token / expires_at）与
 * 官方 camelCase（accessToken / refreshToken / expiresAt）。两条都认，
 * 但内部统一用 snake_case。
 */
export function singleAccountToAccount(raw, { fallbackId } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const accessToken = firstString(src.access_token, src.accessToken, src.token, src.api_key)
  if (!accessToken) throw new Error('anthropic credential missing `access_token`')
  if (src.disabled === true) {
    throw new Error(`anthropic account is disabled: ${src.email || src.account_id || '(no email)'}`)
  }
  const accountId = firstString(src.account_id, src.accountId, src.organization_id, src.email, '')
  // id 是调度主键，必须稳定：token 刷新后会变，用 token 片段做 id 会让亲和全失效
  const id = firstString(src.id, accountId, fallbackId, randomUUID())
  const expiresAt = parseExpiryMs(firstDefined(src.expires_at, src.expiresAt, src.expired))
  const authScheme = detectAuthScheme(accessToken, src)
  return {
    id,
    access_token: accessToken,
    refresh_token: firstString(src.refresh_token, src.refreshToken, ''),
    expires_at: expiresAt,
    auth_scheme: authScheme,
    subscription_type: firstString(src.subscription_type, src.subscriptionType, src.plan_type, ''),
    email: firstString(src.email, ''),
    account_id: accountId,
    needs_reauth: src.needs_reauth === true,
    disabled: false,
  }
}

/**
 * 鉴权形态判定。
 *
 * OAuth token 有固定前缀（`sk-ant-oat`），其余按 API key 处理。
 * 这个区分不是美化：两种形态的头不一样（Bearer vs x-api-key），
 * 发错了上游按另一条鉴权路径处理，返回的错误信息还会误导排查方向。
 */
export function detectAuthScheme(token, raw = {}) {
  const text = String(token || '')
  if (raw.auth_scheme === 'api_key' || raw.auth_scheme === 'oauth') return raw.auth_scheme
  if (text.startsWith('sk-ant-oat')) return 'oauth'
  if (text.startsWith('sk-ant-api')) return 'api_key'
  // 无前缀时按 OAuth 处理：本模块的主要用途是驱动 Claude Code 的登录态，
  // API key 有显式前缀，不会走到这里。
  return 'oauth'
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function firstDefined(...values) {
  for (const v of values) {
    if (v != null && v !== '') return v
  }
  return null
}

/** 一个文件里是不是多账号形态 */
export function isMultiAccountShape(parsed) {
  return Boolean(parsed) && typeof parsed === 'object' && Array.isArray(parsed.accounts)
}

/**
 * 解析凭据文本 → { accounts, shape }。
 *
 * shape 取值：'single' | 'multi' | 'claude_oauth'（官方 credentials.json）。
 */
export function parseCredentialText(text, { fallbackId } = {}) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? ''))
  } catch (error) {
    throw new Error(`anthropic credential file is not valid JSON: ${error.message}`)
  }
  if (Array.isArray(parsed)) {
    throw new Error('anthropic credential file must be an object, not a bare array')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('anthropic credential file must be an object')
  }

  // 官方 Claude Code credentials.json：令牌嵌在 claudeAiOauth 下
  const oauth = parsed.claudeAiOauth ?? parsed.claude_ai_oauth
  if (oauth && typeof oauth === 'object' && !isMultiAccountShape(parsed)) {
    const account = singleAccountToAccount(
      {
        access_token: oauth.accessToken ?? oauth.access_token,
        refresh_token: oauth.refreshToken ?? oauth.refresh_token,
        expires_at: oauth.expiresAt ?? oauth.expires_at,
        subscription_type: oauth.subscriptionType,
        email: oauth.email,
        account_id: oauth.accountId,
        needs_reauth: oauth.needs_reauth,
      },
      { fallbackId },
    )
    return { accounts: [account], shape: 'claude_oauth' }
  }

  if (isMultiAccountShape(parsed)) {
    const accounts = parsed.accounts.map((item, index) =>
      singleAccountToAccount(item, { fallbackId: fallbackId ? `${fallbackId}-${index}` : undefined }),
    )
    if (accounts.length === 0) {
      throw new Error('anthropic credential file contains an empty `accounts` array')
    }
    return { accounts, shape: 'multi' }
  }

  return { accounts: [singleAccountToAccount(parsed, { fallbackId })], shape: 'single' }
}

/** 从文件加载。读不到文件直接抛错并带路径——启动阶段就该失败。 */
export function loadCredentialFile(path, { fallbackId } = {}) {
  if (!path) throw new Error('anthropic credential path is required')
  let text
  try {
    text = fs.readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`read anthropic credential file ${path}: ${error.message}`)
  }
  const { accounts, shape } = parseCredentialText(text, { fallbackId })
  if (accounts.length === 0) throw new Error(`anthropic credential file ${path} contains no accounts`)
  return { accounts, shape, path }
}

/**
 * 状态机。档位命名与 config.mjs 的 CREDENTIAL_STATES 保持同一套，
 * 也刻意与 codex-credentials.mjs 对齐，便于控制面复用同一套判断。
 *
 *   missing               既没有 access_token 也没有 refresh_token
 *   needs_reauth          被显式标记（refresh_token 已废）
 *   expired               已过期且没有 refresh_token
 *   expired_refreshable   已过期但有 refresh_token（可以自愈）
 *   refresh_window        进入刷新窗口（< 5 分钟）
 *   refreshable           可刷新（< 1 小时）
 *   fresh                 其余
 */
export function accountState(account, { now = Date.now() } = {}) {
  if (account?.needs_reauth === true) return 'needs_reauth'
  if (!account?.access_token) return account?.refresh_token ? 'expired_refreshable' : 'missing'
  const exp = account.expires_at
  if (exp == null) return 'fresh' // 判断不了就不打扰，与 codex 侧一致
  if (now >= exp) return account.refresh_token ? 'expired_refreshable' : 'expired'
  const left = exp - now
  if (left < EXPIRY_CRITICAL_MS) return 'refresh_window'
  if (left < EXPIRY_WARN_MS) return 'refreshable'
  return 'fresh'
}

/** 是否可以直接拿去打上游 */
export function isUsable(account, opts) {
  const state = accountState(account, opts)
  return state !== 'missing' && state !== 'expired' && state !== 'needs_reauth'
}

/**
 * 选一个账号。缺省跳过不可用账号；全部不可用时退回到「可刷新的过期账号」，
 * 因为拿一个过期 token 打上游会得到明确的 401，比本地直接失败更容易诊断。
 */
export function selectAccount(accounts, { now = Date.now(), allowExpired = true } = {}) {
  const list = Array.isArray(accounts) ? accounts : []
  // 已过期的账号能不能用，由 allowExpired 一个开关决定，不能靠 isUsable 的
  // 返回值暗示：isUsable 把 expired_refreshable 算作可用（能自愈），
  // 但调用方说"不要过期账号"时，那个账号确实已经过期了。
  const acceptable = (account) => {
    const state = accountState(account, { now })
    if (state === 'missing' || state === 'needs_reauth' || state === 'expired') return false
    if (state === 'expired_refreshable') return allowExpired
    return true
  }
  return list.find(acceptable) ?? null
}

/** 供日志用：只吐长度与状态，不吐 token 本身 */
export function describeAccount(account, { now = Date.now() } = {}) {
  return {
    id: account?.id ?? null,
    state: accountState(account, { now }),
    auth_scheme: account?.auth_scheme ?? null,
    token_bytes: String(account?.access_token || '').length,
    has_refresh_token: Boolean(account?.refresh_token),
    expires_at: account?.expires_at ?? null,
  }
}

/**
 * 加载 + 逐账号打状态告警。
 *
 * 与 codex-credentials 的 loadCredentials 同形状，便于两条通道共用调用约定。
 * 只告警不抛错：本地时钟偏差会让「看起来过期」的账号仍能用，
 * 提前拒绝反而把可用账号踢掉。真要拒绝由调用方的 state 判断决定。
 */
export function loadCredentials(path, { fallbackId, now = Date.now(), logger = null } = {}) {
  const loaded = loadCredentialFile(path, { fallbackId })
  const states = loaded.accounts.map((account) => ({
    id: account.id,
    state: accountState(account, { now }),
    seconds_left: account.expires_at == null ? null : Math.floor((account.expires_at - now) / 1000),
  }))
  if (logger && typeof logger.warn === 'function') {
    for (const item of states) {
      if (item.state === 'fresh') continue
      logger.warn(
        {
          path: loaded.path,
          account: item.id,
          credential_state: item.state,
          seconds_left: item.seconds_left,
          shape: loaded.shape,
        },
        'anthropic credential needs attention',
      )
    }
  }
  return { ...loaded, states, account: selectAccount(loaded.accounts, { now }) }
}

/**
 * 从环境变量取 token。
 *
 * 三个来源，优先级：CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY。
 * 前两个是 Claude Code 的登录态，最后一个才是控制台 key；把 key 排前面会让
 * 同时存在两份凭据的机器静默改用 key，计费口径就变了。
 */
export function tokenFromEnv(env = process.env) {
  const oauth = firstString(env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_AUTH_TOKEN)
  if (oauth) return { token: oauth, source: 'env', auth_scheme: detectAuthScheme(oauth) }
  const key = firstString(env.ANTHROPIC_API_KEY)
  if (key) return { token: key, source: 'env', auth_scheme: 'api_key' }
  return null
}

/**
 * 统一入口：先环境变量，再文件。两者都没有时抛错并说明缺什么。
 *
 * @returns {{account:object|null, accounts:Array<object>, shape:string|null, source:'env'|'file'|'none', path:string|null}}
 */
export function resolveCredential({ path = null, env = process.env, fallbackId } = {}) {
  const fromEnv = tokenFromEnv(env)
  if (fromEnv) {
    const account = {
      id: 'env',
      access_token: fromEnv.token,
      refresh_token: '',
      expires_at: null,
      auth_scheme: fromEnv.auth_scheme,
      subscription_type: '',
      email: '',
      account_id: '',
      needs_reauth: false,
      disabled: false,
    }
    return { account, accounts: [account], shape: 'single', source: 'env', path: null }
  }
  if (path) {
    const loaded = loadCredentials(path, { fallbackId })
    return {
      account: loaded.account,
      accounts: loaded.accounts,
      shape: loaded.shape,
      source: 'file',
      path: loaded.path,
    }
  }
  throw new Error(
    'no anthropic credential: set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY, or pass a credential path',
  )
}
