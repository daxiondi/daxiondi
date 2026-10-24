/**
 * system prompt 布局与 billing header 组装。
 *
 * 职责：按布局模式（zero / identity / stock）把 billing header、身份句、
 * 环境块拼成 wire 上的 system 块数组，并负责从中把已有的 billing header
 * 与调用方内容分离出来。
 *
 * 关键约束：
 * 1. billing header 是 system 的第一块，格式为
 *    `x-anthropic-billing-header: ...; cch=00000; prompt_version=<...>`。
 *    cch 在本模块一律写占位符，真实值由 cch.mjs 统一封盖。
 * 2. cc_prompt_id 在进程内只生成一次并复用。这让 cch 不随请求变化——
 *    同进程内重复请求会命中同一指纹，这是有意设计，不要改成每请求随机。
 * 3. zero 模式的 system 里不写身份块（身份句只出现在 billing 的
 *    prompt_version 里）；identity 模式才追加显式身份块。
 * 4. stock 模式表示完全沿用调用方的 system，本模块不介入。
 * 5. system 侧固定两个缓存断点（首块 + 末块），总数与 messages 侧的两个断点
 *    合计 4，正好等于上游的 cache_control 上限。断点数量不要随手调整：
 *    system 少一个不会出错，但会把名额让给 messages，缓存行为随之改变。
 */

import { createHash, randomUUID } from 'node:crypto'

export const IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
export const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
export const CLI_SDK_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."

export const OFFICIAL_IDENTITIES = Object.freeze({
  [IDENTITY]: true,
  [CLI_IDENTITY]: true,
  [CLI_SDK_IDENTITY]: true,
})

export const DEFAULT_TIMEZONE = 'America/New_York'

/** 出站 billing 的入口点。2026 年起的版本统一写 cli，不再写 sdk-cli。 */
// billing 的 cc_entrypoint 必须是 sdk-cli，不是 cli。
//
// 依据官方 vm2api v1.3.220 的 crs-persona.mjs:376：
//   `cc_entrypoint=sdk-cli`
// 以及 vm-identity.mjs:24：
//   `claude-cli/${ver} (external, sdk-cli)`
//
// 为什么不能用 cli：1.3.221+ 把计费头和 UA 都改成了 `cli`，但
// 槽内的 cli-node 二进制没跟着更新（仍是旧标识）。结果计费头说 cli、
// 内核说 sdk-cli —— 同一份请求里两个身份打架，比不改更容易被识别。
// 实测反馈：新版上线后 29 次成功，随后 401 token revoked。
//
// 1.3.220 是「计费头 / UA / 二进制」三者统一的最后一个版本，
// 所以锁 sdk-cli。
export const BILLING_ENTRYPOINT = 'sdk-cli'

/**
 * billing 版本指纹的固定盐。算法：取首条 user 文本第 4/7/20 个字节拼上版本号，
 * 与盐一起做 sha256，取前 3 位十六进制。盐值不可改，改了所有会话的
 * cc_version 都会变，缓存前缀整体失效一次。
 */
export const BILLING_FINGERPRINT_SALT = '59cf53e54c78'

/** 只保留 x.y.z，其余形态回落到缺省版本。 */
export function normalizeBillingVersion(input, fallback = '2.1.296') {
  const m = String(input ?? '').match(/(\d+\.\d+\.\d+)/)
  return m ? m[1] : fallback
}

/** billing 版本尾缀：首条 user 内容与版本号共同决定，同会话内稳定。 */
export function billingFingerprint(firstUserText = '', cliVersion = '2.1.296') {
  const buf = Buffer.from(String(firstUserText ?? ''), 'utf8')
  let chars = ''
  for (const i of [4, 7, 20]) chars += i < buf.length ? String.fromCharCode(buf[i]) : '0'
  return createHash('sha256')
    .update(BILLING_FINGERPRINT_SALT + chars + normalizeBillingVersion(cliVersion), 'utf8')
    .digest('hex')
    .slice(0, 3)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 由种子派生一个稳定的 UUIDv4 形态标识。
 *
 * 与 billingPromptId() 的区别：那个是进程内随机、重启即变；这个由入参决定，
 * 跨进程稳定，因此重启后仍能命中同一缓存前缀。billing 用后者。
 */
export function billingPromptIdFromSeed(seed = '') {
  const raw = String(seed || '')
  if (UUID_RE.test(raw)) return raw.toLowerCase()
  // 与官方 v1.3.220 identity-rewrite.mjs:151 的 uuidFromSeed 逐字符一致：
  //   · 直接 sha256(seed)，**不加任何前缀**
  //   · 变体位取 hex[16..18] 两个字符：((v & 0x3f) | 0x80)
  //
  // 我们原来在两处都写错了：加了 `billing-prompt-id:` 前缀（哈希输入不同，
  // 结果完全不同），变体位也只取了一个字符。cc_prompt_id 整体对不上 ——
  // 它是 billing 头里唯一一个 UUID，对不上就是明显特征。
  const hex = createHash('sha256').update(raw, 'utf8').digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    (((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')) + hex.slice(18, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * 生成 billing 头。
 *
 * 格式（字段顺序固定，cch 永远是占位符）：
 *   x-anthropic-billing-header: cc_version=<ver>.<fp>; cc_entrypoint=sdk-cli;
 *                               cch=00000; cc_prompt_id=<uuid>; prompt_version=<ver>
 *
 * cc_prompt_id 优先用 sessionId（合法 UUID 时），否则由版本号与指纹派生，
 * 这样同一会话多轮请求共用一个 id。
 */
export function buildBillingAttribution({
  cliVersion = '2.1.296',
  firstUserText = '',
  entrypoint = BILLING_ENTRYPOINT,
  sessionId = '',
  promptIndex = null,
  turnIndex = null,
} = {}) {
  const ver = normalizeBillingVersion(cliVersion)
  const fp = billingFingerprint(firstUserText, ver)
  const promptId = billingPromptIdFromSeed(String(sessionId || '').trim() || `prompt:${ver}:${fp}`)
  // 字段顺序与官方 v1.3.220 完全一致：
  //   cc_version=<ver>.<fp>; cc_entrypoint=sdk-cli; cch=<5hex>; cc_prompt_id=<uuid>;<turn tail>
  //
  // 这里**不能**加 prompt_version —— 官方 billing 头里没有这个字段。
  // 我们之前多写了 `prompt_version=<ver>`，多出来的字段本身就是识别特征：
  // 上游只要校验 billing 头的字段集合，就能判定"这不是官方客户端发的"。
  const tail = billingTurnSuffix(promptIndex, turnIndex)
  return `x-anthropic-billing-header: cc_version=${ver}.${fp}; cc_entrypoint=${entrypoint}; cch=00000; cc_prompt_id=${promptId};${tail}`
}

/** 索引上限，超出视为非法（官方同样是 1e7）。 */
const BILLING_INDEX_MAX = 1e7

function boundedBillingIndex(value, min) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < min || n > BILLING_INDEX_MAX) return null
  return n
}

/**
 * 轮次尾缀。只有两个索引都合法时才追加 —— 缺一个就不写，
 * 不要补 0 或空串：官方在没有索引时是整段不出现。
 */
export function billingTurnSuffix(promptIndex, turnIndex) {
  const prompt = boundedBillingIndex(promptIndex, 0)
  const turn = boundedBillingIndex(turnIndex, 1)
  if (prompt == null || turn == null) return ''
  return ` cc_turn_origin=sdk; cc_prompt_index=${prompt}; cc_turn_index=${turn};`
}

/**
 * 进程内固定的 billing prompt id。
 * 只在首次调用时生成，之后复用——这是"同一进程内 cch 稳定"的实现基础。
 */
let stablePromptId = null
function billingPromptId() {
  if (!stablePromptId) stablePromptId = randomUUID()
  return stablePromptId
}

/**
 * 从环境变量解析布局模式。
 * 接受 zero / identity（含 id、block 别名）；其余任何值都归到 stock，
 * 即"不写自定义布局"。stock 不是枚举成员，只在内部表示缺省语义。
 */
export function getSystemLayout(env = process.env) {
  const raw = String(env.CLAUDE_CODE_SYSTEM_LAYOUT || env.SYSTEM_MODE || '')
    .trim()
    .toLowerCase()
  if (raw === 'zero') return 'zero'
  if (raw === 'identity' || raw === 'id' || raw === 'block') return 'identity'
  return 'stock'
}

/** 时区按 CLAUDE_CODE_TIMEZONE → SLOT_TZ → TZ → 缺省的顺序取第一个非空值 */
export function getKinTimezone(env = process.env) {
  const tz = String(env.CLAUDE_CODE_TIMEZONE || env.SLOT_TZ || env.TZ || DEFAULT_TIMEZONE).trim()
  return tz || DEFAULT_TIMEZONE
}

export function environmentBlock(timezone = getKinTimezone()) {
  return `# Environment\n - Timezone: ${timezone}`
}

/**
 * zero 布局的 billing header 收尾：
 * 补齐前缀 → 删掉 prompt_version 与已有 cch → 补分号 → 缺 cc_prompt_id 时补上
 * → 末尾写 cch=00000 与 prompt_version=<身份句>。
 */
export function finalizeZeroBilling(attribution) {
  let header = String(attribution || '').trim()
  if (!header) header = 'x-anthropic-billing-header:'
  if (!/^x-anthropic-billing-header:/i.test(header)) {
    header = `x-anthropic-billing-header: ${header}`
  }
  header = header
    .replace(/\s*prompt_version=<[^>]*>;?/g, '')
    .replace(/\s*prompt_version=[^;]*;?/g, '')
    .replace(/\s*\bcch=[^;]*;?/gi, '')
    .replace(/\s+$/g, '')
  if (!header.endsWith(';')) header += ';'
  if (!/\bcc_prompt_id=/.test(header)) header += ` cc_prompt_id=${billingPromptId()};`
  return `${header} cch=00000; prompt_version=<${IDENTITY}>`
}

/**
 * 把已有 billing header 的 cch 重置为占位符 00000。
 *
 * 只替换值，不重排字段：cch 在 header 里的位置是客户端版本的指纹之一，
 * 把它挪到末尾会让整行与样本的字段顺序不一致。仅当原 header 完全没有
 * cch 字段时，才在分号前补一个。
 */
export function withCchPlaceholder(header) {
  const src = String(header || '')
  if (/\bcch=[^;]*;?/i.test(src)) return src.replace(/\bcch=[^;]*/gi, 'cch=00000')
  const base = src.endsWith(';') ? src : `${src};`
  return `${base} cch=00000;`
}

/**
 * 按布局组装 system 块数组。
 *
 * zero：只有 billing header，不写身份块；
 * identity（含 id / block 别名）：billing header（有则加）+ 身份块；
 * stock：两块都不写，只保留环境块与调用方内容。
 * 环境块固定追加在末尾之前，调用方内容放最后。
 *
 * @returns {string[]}
 */
export function layoutSystemBlocks({ attribution, leftover, env = process.env } = {}) {
  const layout = getSystemLayout(env)
  const attr = String(attribution || '').trim()
  const blocks = []
  if (layout === 'zero') {
    blocks.push(finalizeZeroBilling(attr))
  } else if (layout !== 'stock') {
    if (attr) blocks.push(withCchPlaceholder(attr))
    blocks.push(IDENTITY)
  }
  blocks.push(environmentBlock(getKinTimezone(env)))
  if (leftover) blocks.push(leftover)
  return blocks
}

/** 从 system 块里找 billing header 原文（返回第一个命中的整块文本） */
export function billingFromSystemPrompt(systemPrompt = []) {
  for (const block of systemPrompt) {
    const text = String(block || '').trim()
    if (text.startsWith('x-anthropic-billing-header')) return text
  }
  return undefined
}

/**
 * 剥掉本模块自己产出的块，只留调用方内容：
 * 去掉 billing header、身份句、环境块，以及默认 agent 字段块。
 * 全部被剥掉时返回 undefined，避免上层往 system 里塞空字符串。
 */
export function leftoverFromSystemPrompt(systemPrompt = []) {
  const parts = []
  for (const block of systemPrompt) {
    const text = String(block || '').trim()
    if (!text) continue
    if (text.startsWith('x-anthropic-billing-header')) continue
    if (text === IDENTITY) continue
    if (text.startsWith('# Environment')) continue
    if (isDefaultAgentField(text)) continue
    parts.push(block)
  }
  return parts.length ? parts.join('\n\n') : undefined
}

/** 识别网关自带的 agent 字段，避免当成调用方内容回传 */
export function isDefaultAgentField(text) {
  if (text.includes('persistent Crag') || text.includes('persistent Kin')) return true
  if (text.includes('mcp__runtime__')) return true
  return false
}

// ─────────────────── system 侧的缓存断点 ───────────────────

/** system 侧固定两个断点：身份块（billing header 或身份句）与主提示词块 */
export const MAX_SYSTEM_BREAKPOINTS = 2

/**
 * 计算 system 的缓存断点位置。
 *
 * 规则：首块（billing header / 身份句）与末块（主提示词）各一个，去重后返回。
 * 只有一块时只打一个——这是布局退化（例如 stock 模式只剩环境块）时的正常结果，
 * 不是错误。空数组返回空。
 *
 * @param {Array<string|object>} blocks
 * @returns {number[]} 升序索引
 */
export function systemBreakpointIndices(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return []
  if (blocks.length === 1) return [0]
  return [0, blocks.length - 1]
}

/** 字符串块 → 单 text 块对象；已经是对象就原样返回 */
function normalizeSystemBlock(block) {
  if (typeof block === 'string') return { type: 'text', text: block }
  return block && typeof block === 'object' ? block : null
}

/**
 * 给 system 打上两个缓存断点（身份块 + 主提示词），就地修改并返回块数组。
 *
 * 幂等：已有 ephemeral + 同 TTL 的标记保持不变，不重建对象。
 * 非断点位置的旧标记会被清掉，保证 system 的标记数恒等于 2——
 * 数量固定才能让 messages 侧稳定拿到剩余的两个名额。
 *
 * @param {Array<string|object>} blocks system 块数组
 * @param {object} [opts]
 * @param {string} [opts.ttl]    '5m' | '1h'，缺省 '1h'
 * @param {boolean} [opts.prune] 是否清掉非断点位置的旧标记，缺省 true
 * @returns {{blocks: Array<object>, applied: number[]}}
 */
export function applySystemBreakpoints(blocks, opts = {}) {
  const ttl = opts.ttl === '5m' || opts.ttl === '1h' ? opts.ttl : '1h'
  const prune = opts.prune !== false
  if (!Array.isArray(blocks) || blocks.length === 0) return { blocks: [], applied: [] }

  const normalized = blocks.map(normalizeSystemBlock)
  const targets = systemBreakpointIndices(normalized)
  const targetSet = new Set(targets)

  if (prune) {
    for (let i = 0; i < normalized.length; i += 1) {
      const block = normalized[i]
      if (!block || targetSet.has(i)) continue
      if ('cache_control' in block) delete block.cache_control
    }
  }

  const applied = []
  for (const index of targets) {
    const block = normalized[index]
    if (!block) continue
    const control = block.cache_control
    if (!(control && typeof control === 'object' && control.type === 'ephemeral' && control.ttl === ttl)) {
      const next = { type: 'ephemeral', ttl }
      if (control?.scope === 'global' || control?.scope === 'org') next.scope = control.scope
      block.cache_control = next
    }
    applied.push(index)
  }

  return { blocks: normalized, applied }
}

/**
 * 把字符串/带 text 的对象数组规范成 wire system 块（保留 cache_control）。
 *
 * billing header 块会被就地换成 cch 占位符形态——wire 上永远只发占位符，
 * 真实 cch 由封盖阶段写入。任一元素不是对象或既无 text 字段就整体返回 null，
 * 由调用方决定回退策略（不静默丢弃部分块）。
 */
export function wireSystemBlocks(system) {
  if (!Array.isArray(system) || !system.length) return null
  const blocks = []
  for (const block of system) {
    if (!block || typeof block !== 'object') return null
    const text = typeof block.text === 'string' ? block.text : ''
    if (!text && !('text' in block)) return null
    const next = {
      type: 'text',
      text: /^\s*x-anthropic-billing-header:/i.test(text) ? withCchPlaceholder(text) : text,
    }
    if (block.cache_control && typeof block.cache_control === 'object') {
      next.cache_control = block.cache_control
    }
    blocks.push(next)
  }
  return blocks.length ? blocks : null
}
