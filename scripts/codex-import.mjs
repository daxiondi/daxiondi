#!/usr/bin/env node
/**
 * 把上游导出的 Codex 凭据转换成内核要求的形状。
 *
 * 两类输入都吃：
 *   1. 单账号对象（vm2api 导出的 javaserver.json 那种平铺格式）
 *   2. 数组或已有 accounts 数组
 *
 * 内核侧 normalizeAccount 是严格校验的 —— 缺 id 直接抛，
 * 类型不对会清空**整个** accounts 列表（不是跳过那一条）。
 * 所以这个转换必须显式、可审计，不能指望内核宽容。
 *
 * 用法：
 *   node scripts/codex-import.mjs --in ../live/javaserver.json --out config/codex-credential.json
 *   node scripts/codex-import.mjs --in a.json b.json --out out.json     # 合并多账号
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const list = (flag) => {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j += 1) out.push(argv[j])
    }
  }
  return out
}
const one = (flag, dflt = null) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const inputs = list('--in')
const outPath = one('--out', 'config/codex-credential.json')
if (!inputs.length) {
  console.error('用法: node scripts/codex-import.mjs --in <file...> --out <file>')
  process.exit(2)
}

/** 时间字符串 → 毫秒时间戳。支持 ISO、带时区偏移、以及已是数字的情况。 */
function toEpochMs(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    // 已有数字：判断是秒还是毫秒。10 位是秒，13 位是毫秒。
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  const s = String(value).trim()
  if (/^\d+$/.test(s)) return toEpochMs(Number(s))
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

/** 从 id_token 的 JWT payload 里挖 chatgpt_account_id（上游常常不带字段）。 */
function accountIdFromIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return undefined
  const parts = idToken.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const auth = payload['https://api.openai.com/auth'] || {}
    return auth.chatgpt_account_id || auth.organization_id || payload.chatgpt_account_id || undefined
  } catch {
    return undefined
  }
}

/** 从 access_token 的 JWT payload 里挖，逻辑同上但字段位置不同。 */
function accountIdFromAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') return undefined
  const parts = accessToken.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const auth = payload['https://api.openai.com/auth'] || {}
    return auth.chatgpt_account_id || auth.organization_id || undefined
  } catch {
    return undefined
  }
}

function normalizeOne(raw, fileHint) {
  if (!raw || typeof raw !== 'object') throw new Error(`${fileHint}: 不是对象`)

  const accessToken = raw.access_token || raw.accessToken || ''
  const refreshToken = raw.refresh_token || raw.refreshToken
  const idToken = raw.id_token || raw.idToken

  // id 是唯一必填项。上游有时把它叫 account_id / chatgpt_account_id。
  const id = raw.id
    || raw.chatgpt_account_id
    || raw.account_id
    || accountIdFromAccessToken(accessToken)
    || accountIdFromIdToken(idToken)
  if (!id) {
    throw new Error(`${fileHint}: 找不到账号 id（试过 id / chatgpt_account_id / account_id / JWT payload）`)
  }

  const expiresAt = toEpochMs(raw.expires_at ?? raw.expired ?? raw.expiresAt)
  if (expiresAt === undefined) {
    throw new Error(`${fileHint}: 找不到过期时间（试过 expires_at / expired / expiresAt）`)
  }
  if (expiresAt < Date.now()) {
    // 不报错：过期账号照样能写进凭据文件，内核会走刷新。
    // 但要明确提示，否则上线时会莫名其妙 401。
    console.error(`  注意：${fileHint} 的 token 已过期（${new Date(expiresAt).toISOString()}），将依赖 refresh_token 续期`)
  }

  const account = {
    id: String(id),
    access_token: String(accessToken),
    expires_at: Math.round(expiresAt),
  }
  if (refreshToken) account.refresh_token = String(refreshToken)
  if (idToken) account.id_token = String(idToken)

  const chatgptAccountId = raw.chatgpt_account_id
    || raw.account_id
    || accountIdFromAccessToken(accessToken)
    || accountIdFromIdToken(idToken)
  if (chatgptAccountId) account.chatgpt_account_id = String(chatgptAccountId)

  if (raw.rpm !== undefined) account.rpm = Number(raw.rpm)
  if (raw.max_concurrency !== undefined) account.max_concurrency = Number(raw.max_concurrency)

  // 邮箱只用于日志辨认，不是内核字段，但也一起带上方便排查
  if (raw.email) account.email = String(raw.email)

  return account
}

const accounts = []
for (const file of inputs) {
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) {
    console.error(`跳过不存在的文件: ${file}`)
    continue
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'))
  } catch (error) {
    console.error(`跳过解析失败的文件: ${file} (${error.message})`)
    continue
  }
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.accounts)
      ? parsed.accounts
      : [parsed]
  for (const item of items) {
    accounts.push(normalizeOne(item, path.basename(file)))
  }
}

if (!accounts.length) {
  console.error('没有可导入的账号')
  process.exit(1)
}

// 同一账号导入两次会互相覆盖额度，去重比留着更难查
const seen = new Map()
for (const a of accounts) {
  const prev = seen.get(a.id)
  if (prev) {
    console.error(`  去重：账号 ${a.id} 出现多次，保留最后一条`)
  }
  seen.set(a.id, a)
}
const finalAccounts = [...seen.values()]

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
fs.writeFileSync(path.resolve(outPath), `${JSON.stringify({ accounts: finalAccounts }, null, 2)}\n`, { mode: 0o600 })

console.log(`已写入 ${outPath}（${finalAccounts.length} 个账号）`)
for (const a of finalAccounts) {
  const left = Math.round((a.expires_at - Date.now()) / 3600_000)
  console.log(`  ${a.email || a.id}  expires_at=${new Date(a.expires_at).toISOString()}  (${left}h 后过期)  refresh=${a.refresh_token ? 'yes' : 'no'}`)
}
fs.chmodSync(path.resolve(outPath), 0o600)
