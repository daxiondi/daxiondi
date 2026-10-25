/**
 * 提示词档位：按模型能力组装不同的 system 结构与消息排布。
 *
 * 职责：维护档位注册表（official_full / official_303），按模型名选出该模型
 * 使用的结构，并把 system、调用方 system、Environment 与缓存断点一次性组装到
 * 出站 body 上。
 *
 * 两种结构：
 *
 *   结构 A（system_reminder，适用于 Opus 4.8 / 5 / 5.5、Fable、Mythos 等 lean 模型）
 *     system[0] billing      —— 无断点
 *     system[1] 身份句        —— 断点
 *     system[2] 主提示词      —— 断点
 *     第一条 user 的头部      —— `<system-reminder>` 包裹的调用方 system 余量
 *     尾部 role=system        —— Environment，只替换 `# Environment` 段
 *     user 断点               —— 最后一条 user；消息数 ≥4 时再加它前面那条
 *
 *   结构 B（cli_hop，适用于 Sonnet、Haiku、Opus 4.0–4.7）
 *     沿用 system-layout.mjs 的三布局，调用方 system 留在 system 里，
 *     本档只把 billing 的版本号换成所选档位的版本。
 *
 * 关键约束：
 * 1. 结构 A 里调用方 system 不出现在 system 中；它只作为第一条 user 的
 *    `<system-reminder>` 出现。西文调用方若同时给出 billing 与身份句，这两类
 *    块不折进 user（它们由本档自己产出），捏进 user 会重复计费头并破坏指纹。
 * 2. `<total_tokens>` 的实时计数必须先抹平再出站。历史消息里每一轮的计数都不同，
 *    一旦原样带出，第二轮起缓存前缀全部失效。抹平值取固定值，见 OFFICIAL_TOTAL_TOKENS。
 * 3. billing 的 cc_prompt_id 在进程内固定；cch 一律写占位符，由 cch.mjs 封盖。
 *    本模块不计算 cch，也不在断点里写 ttl 之外的字段。
 * 4. 断点上限 4：结构 A 的 system 固定 2 个，因此 user 侧最多 2 个；
 *    billing 与 role=system 消息永远不带断点，thinking 块也不带。
 * 5. 组装是纯函数：入参 body / messages 不被就地修改。
 */

import { readFileSync } from 'node:fs'
import {
  CLI_IDENTITY,
  IDENTITY,
  buildBillingAttribution,
  layoutSystemBlocks, getSystemLayout } from './system-layout.mjs'
import { normalizePanelCacheTtl } from './identity.mjs'

// ─────────────────────────────── 档位标识

export const PROFILE_OFFICIAL_FULL = 'official_full'
export const PROFILE_OFFICIAL_303 = 'official_303'
export const PROMPT_PROFILES = Object.freeze([PROFILE_OFFICIAL_FULL, PROFILE_OFFICIAL_303])
export const DEFAULT_PROMPT_PROFILE = PROFILE_OFFICIAL_FULL

/** 结构标识。A = 调用方 system 折进首条 user；B = 现有 cli-hop 布局。 */
export const STRUCTURE_SYSTEM_REMINDER = 'system_reminder'
export const STRUCTURE_CLI_HOP = 'cli_hop'

// ─────────────────────────────── 2.1.303 样本

const SAMPLE_303 = JSON.parse(readFileSync(new URL('./prompt-profiles-303.json', import.meta.url), 'utf8'))

/** 交互 CLI 身份句（结构 A 的 system[1]）。 */
export const OFFICIAL_CLI_IDENTITY = SAMPLE_303.identity_cli
/** 2.1.303 主提示词。开头有换行，`{{memory_dir}}` 按槽位工作目录填充。 */
export const OFFICIAL_303_MAIN_PROMPT = SAMPLE_303.main_prompt
export const OFFICIAL_303_ENV_INTRO = SAMPLE_303.environment_intro
export const OFFICIAL_303_ENV_UNTRUSTED = SAMPLE_303.environment_untrusted
export const OFFICIAL_303_META = Object.freeze({ ...SAMPLE_303.meta })

/** 槽位工作目录缺省值。调用方给出的 cwd 优先。 */
export const DEFAULT_SLOT_CWD = '/home/kincli'

/**
 * `<total_tokens>` 的抹平值。所有出站计数统一成这一个字符串，保证历史字节稳定。
 * 数值与 2.1.303 样本一致；改这个值会让已有会话的缓存前缀重建一次。
 */
export const OFFICIAL_TOTAL_TOKENS = '<total_tokens>15000000 tokens left</total_tokens>'

const VOLATILE_TOTAL_TOKENS = /<total_tokens>\d+ tokens left<\/total_tokens>/g

/** 把任意上下文计数抹平成固定值。不含计数时原样返回。 */
export function stabilizeTotalTokens(text) {
  const raw = String(text ?? '')
  if (!raw.includes('<total_tokens>')) return raw
  return raw.replace(VOLATILE_TOTAL_TOKENS, OFFICIAL_TOTAL_TOKENS)
}

// ─────────────────────────────── 档位注册表

/**
 * 档位表。字段含义：
 *   cliVersion    出站 UA、billing cc_version、cch 计算输入共用的版本号
 *   entrypoint    billing 的 cc_entrypoint；锁 sdk-cli（对齐 v1.3.220）
 *   structure     该档的缺省结构；lean 模型在 303 档下走 system_reminder
 *   systemSlots   结构 A 的 system 段顺序（结构 B 由 system-layout 决定）
 *   messagePolicy 调用方 system / Environment / 断点的落位规则
 *   maxMarkers    整份请求的缓存断点上限
 *   ttlSource     断点 TTL 的来源：panel = 面板缓存 TTL
 */
export const PROFILES = Object.freeze({
  [PROFILE_OFFICIAL_FULL]: Object.freeze({
    name: PROFILE_OFFICIAL_FULL,
    cliVersion: '2.1.296',
    // 必须是 sdk-cli。1.3.221+ 改成 cli 但槽内二进制没跟上，
    // 造成计费头与内核标识打架 —— 实测会导致 401 token revoked。
    entrypoint: 'sdk-cli',
    structure: STRUCTURE_CLI_HOP,
    systemSlots: Object.freeze(['billing', 'identity', 'caller']),
    messagePolicy: Object.freeze({
      caller: 'system',
      environment: 'system',
      marker: 'existing',
    }),
    maxMarkers: 4,
    ttlSource: 'panel',
    promptVersion: '2.1.296',
  }),
  [PROFILE_OFFICIAL_303]: Object.freeze({
    name: PROFILE_OFFICIAL_303,
    cliVersion: '2.1.303',
    // 必须是 sdk-cli。1.3.221+ 改成 cli 但槽内二进制没跟上，
    // 造成计费头与内核标识打架 —— 实测会导致 401 token revoked。
    entrypoint: 'sdk-cli',
    structure: STRUCTURE_SYSTEM_REMINDER,
    systemSlots: Object.freeze(['billing', 'identity', 'main']),
    messagePolicy: Object.freeze({
      caller: 'first_user_reminder',
      environment: 'tail_system_message',
      marker: 'identity_main_last_two_users',
    }),
    maxMarkers: 4,
    ttlSource: 'panel',
    promptVersion: '2.1.303',
  }),
})

/** 档位名归一化。接受 303 / official-303 / full 等别名，未知值落到缺省档。 */
export function normalizePromptProfile(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
  if (raw === PROFILE_OFFICIAL_303 || raw === '303' || raw === 'official-303' || raw === 'official303') {
    return PROFILE_OFFICIAL_303
  }
  if (raw === PROFILE_OFFICIAL_FULL || raw === 'full' || raw === 'official-full' || raw === 'default') {
    return PROFILE_OFFICIAL_FULL
  }
  return null
}

/** 取档位定义；未知名抛错，避免静默走错结构。 */
export function profileDefinition(profile = DEFAULT_PROMPT_PROFILE) {
  const key = normalizePromptProfile(profile)
  if (!key) throw new Error(`unknown prompt profile: ${profile}`)
  return PROFILES[key]
}

export function cliVersionForProfile(profile = DEFAULT_PROMPT_PROFILE) {
  return profileDefinition(profile).cliVersion
}

/** 出站 UA。303 档锁定 `(external, cli)`，版本随档位。 */
export function outboundUserAgent(profile = DEFAULT_PROMPT_PROFILE) {
  const def = profileDefinition(profile)
  return `claude-cli/${def.cliVersion} (external, ${def.entrypoint})`
}

/** billing 的入口点。所有档位固定 cli。 */
export function billingEntrypoint(profile = DEFAULT_PROMPT_PROFILE) {
  return profileDefinition(profile).entrypoint
}

// ─────────────────────────────── 模型分类

/**
 * 模型名归一化：去掉代理前缀、`[1m]` 后缀与 `-YYYYMMDD` 日期后缀，小写。
 * `claude-opus-4` 补齐成 `claude-opus-4-0`。
 */
export function canonicalModelId(model = '') {
  let id = String(model || '')
    .trim()
    .toLowerCase()
  const slash = id.lastIndexOf('/')
  if (slash >= 0) id = id.slice(slash + 1)
  id = id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
  if (id === 'claude-opus-4') return 'claude-opus-4-0'
  return id
}

/** 完整提示词的 Opus 版本；4.8 起改用 lean 提示词。 */
const FULL_PROMPT_OPUS = Object.freeze([
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
])

/**
 * 结构 A 适用的模型（lean 提示词）。
 *
 * 判定与上游一致：Sonnet、Haiku、Claude 3 与 Opus 4.0–4.7 走完整提示词，
 * 其余一律走 lean。Mythos 5 单独点名（它不在完整提示词名单里，显式写出避免
 * 以后名单变动时被误判）。未知模型按 lean 处理——新模型先按能力较强假设排布，
 * 与上游 `he(model)` 的缺省分支一致。
 */
export const SYSTEM_REMINDER_MODELS = Object.freeze([
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-mythos-5',
  'claude-mythos-5-1',
])

/** 结构 B 适用的模型（完整提示词）。 */
export const CLI_HOP_MODELS = Object.freeze([
  'claude-sonnet-4-5',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5',
  'claude-haiku-5',
  'claude-haiku-5-5',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
])

/** 该模型是否使用结构 A（lean 提示词 + 首条 user 折入调用方 system）。 */
export function usesSystemReminderLayout(model = '') {
  const id = canonicalModelId(model)
  if (!id) return false
  if (id === 'claude-mythos-5') return true
  if (id.includes('claude-3-') || id.includes('haiku') || id.includes('sonnet')) return false
  if (FULL_PROMPT_OPUS.includes(id)) return false
  return true
}

/**
 * 该模型自身对应的档位。lean 模型默认 303 结构，完整提示词模型默认 full。
 * 这是"按模型选档"的缺省结果；调用方显式配置的档位可以用
 * resolvePromptProfile 覆盖版本号，但结构仍由模型能力决定。
 */
export function profileForModel(model = '') {
  return usesSystemReminderLayout(model) ? PROFILE_OFFICIAL_303 : PROFILE_OFFICIAL_FULL
}

/**
 * 生效档位：显式配置优先，缺省按模型。
 * 结构不在这里决定——见 structureFor。
 */
export function resolvePromptProfile({ model = '', configured = null } = {}) {
  return normalizePromptProfile(configured) ?? profileForModel(model)
}

/**
 * 生效结构。
 *   303 档 + lean 模型 → 结构 A
 *   303 档 + 完整提示词模型 → 结构 B，但版本号用 2.1.303
 *   full 档 → 结构 B
 */
export function structureFor({ profile = DEFAULT_PROMPT_PROFILE, model = '' } = {}) {
  const key = profileDefinition(profile).name
  if (key === PROFILE_OFFICIAL_303 && usesSystemReminderLayout(model)) return STRUCTURE_SYSTEM_REMINDER
  return STRUCTURE_CLI_HOP
}

/**
 * 模型是否接受会话中途的 role=system 消息。结构 A 的 Environment 依赖它；
 * 不接受时 Environment 并进主提示词块（上游 2.1.303 的降级路径）。
 */
export function modelSupportsSystemTurns(model = '') {
  const id = canonicalModelId(model)
  return /^claude-(?:(?:fable|mythos)-5(?:[-.]1)?|opus-(?:5(?:[-.]5)?|4[-.]8)|(?:sonnet|haiku)-5[-.]5)(?:-|$)/.test(
    id,
  )
}

// ─────────────────────────────── billing

/**
 * 结构 A / B 共用的 billing 头。cch 写占位符，cc_prompt_id 进程内稳定。
 * prompt_version 写纯版本号（303 档为 2.1.303），不再写身份句。
 */
export function billingHeader({
  profile = PROFILE_OFFICIAL_303,
  firstUserText = '',
  promptVersion = null,
} = {}) {
  const def = profileDefinition(profile)
  // 不再传 promptVersion —— 官方 billing 头里没有这个字段（见 system-layout 注释）。
  return buildBillingAttribution({
    cliVersion: def.cliVersion,
    firstUserText,
    entrypoint: def.entrypoint,
  })
}

// ─────────────────────────────── 2.1.303 文本渲染

/** 项目目录桶名：/home/kincli → -home-kincli。 */
export function projectSlug(cwd = '') {
  const normalized = String(cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  const slug = normalized
    .replace(/[^A-Za-z0-9._]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!slug) return ''
  return slug.startsWith('-') ? slug : `-${slug}`
}

/** 主提示词：填充 memory 目录，并把上下文计数抹平。 */
export function renderMainPrompt303({ cwd = DEFAULT_SLOT_CWD } = {}) {
  const dir = String(cwd || DEFAULT_SLOT_CWD).replace(/\/+$/, '') || DEFAULT_SLOT_CWD
  const slug = projectSlug(dir) || projectSlug(DEFAULT_SLOT_CWD)
  const memoryDir = `${dir}/.claude/projects/${slug}/memory/`
  return stabilizeTotalTokens(OFFICIAL_303_MAIN_PROMPT.replace('{{memory_dir}}', memoryDir))
}

const LEAN_MODEL_CATALOG = Object.freeze({
  'claude-opus-4-8': ['Opus 4.8', 'January 2026'],
  'claude-opus-5': ['Opus 5', 'May 2026'],
  'claude-opus-5-5': ['Opus 5.5', 'June 2026'],
  'claude-fable-5': ['Fable 5', 'January 2026'],
  'claude-fable-5-1': ['Fable 5.1', 'June 2026'],
  'claude-mythos-5': ['Mythos 5', 'January 2026'],
  'claude-mythos-5-1': ['Mythos 5.1', 'June 2026'],
})

/** 模型行。未知模型只写 id、省掉知识截止日期。 */
export function modelLine(model = '', { oneM = false } = {}) {
  const id = canonicalModelId(model)
  const exact = `${id}${oneM ? '[1m]' : ''}`
  const entry = LEAN_MODEL_CATALOG[id]
  if (!entry) return `You are powered by the model ${exact}.`
  const [name, cutoff] = entry
  return `You are powered by the model named ${name}${oneM ? ' (1M context)' : ''}. The exact model ID is ${exact}. Assistant knowledge cutoff is ${cutoff}.`
}

/**
 * `# Environment` 段。只写这六项加模型行；303 样本没有时区行，不要补。
 */
export function renderEnvironmentSection({
  cwd = '',
  git = null,
  platform = '',
  shell = '',
  osVersion = '',
  model = '',
  oneM = false,
} = {}) {
  const lines = [
    '# Environment',
    OFFICIAL_303_ENV_INTRO,
    ` - Primary working directory: ${String(cwd || '').trim() || DEFAULT_SLOT_CWD}`,
    ` - Is a git repository: ${git === true ? 'true' : 'false'}`,
    ` - Platform: ${String(platform || '').trim() || 'linux'}`,
    ` - Shell: ${String(shell || '').trim() || 'bash'}`,
  ]
  const os = String(osVersion || '').trim()
  if (os) lines.push(` - OS Version: ${os}`)
  lines.push(OFFICIAL_303_ENV_UNTRUSTED)
  return `${lines.join('\n')}\n\n${modelLine(model, { oneM })}`
}

/** 从若干文本里收集 Environment 事实。先给出的非空值优先。 */
export function parseEnvironmentFacts(texts = []) {
  const facts = { cwd: '', git: null, platform: '', shell: '', osVersion: '', model: '' }
  for (const raw of texts) {
    const text = String(raw || '')
    if (!facts.cwd) {
      const m = text.match(/(?:Primary working directory|working directory|cwd)\s*[:=]\s*([^\n]+)/i)
      const cwd = m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
      if (cwd && /^([A-Za-z]:[\\/]|\\\\|~[\\/]|\/|\.\/|\.\.\/)/.test(cwd) && cwd.length <= 512) facts.cwd = cwd
    }
    if (facts.git == null) {
      const m = text.match(/Is a git repository:\s*(true|false)/i)
      if (m) facts.git = m[1].toLowerCase() === 'true'
    }
    if (!facts.platform) {
      const m = text.match(/(?:^|\n)\s*-?\s*Platform:\s*([^\n]+)/i)
      if (m) facts.platform = m[1].trim().split(/\s+/)[0]
    }
    if (!facts.shell) {
      const m = text.match(/(?:^|\n)\s*-?\s*Shell:\s*([^\n]+)/i)
      if (m) facts.shell = m[1].trim().split(/\s+/)[0]
    }
    if (!facts.osVersion) {
      const m = text.match(/(?:^|\n)\s*-?\s*OS Version:\s*([^\n]+)/i)
      if (m) facts.osVersion = m[1].trim()
    }
  }
  return facts
}

// ─────────────────────────────── 调用方 system 拆分

const BILLING_LINE_RE = /^\s*x-anthropic-billing-header:/i
const IDENTITY_TEXTS = Object.freeze([
  CLI_IDENTITY,
  IDENTITY,
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
])

export function isBillingText(text) {
  return BILLING_LINE_RE.test(String(text ?? ''))
}

export function isOfficialIdentityText(text) {
  return IDENTITY_TEXTS.includes(String(text ?? '').trim())
}

/** system 入参（字符串 / 块数组 / 单个块）→ 文本数组，丢掉空块。 */
export function systemTexts(system) {
  if (system == null || system === '') return []
  if (typeof system === 'string') return system.trim() ? [system] : []
  if (Array.isArray(system)) {
    return system
      .map((block) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
      .filter((text) => String(text).trim())
  }
  return typeof system?.text === 'string' && system.text.trim() ? [system.text] : []
}

/**
 * 调用方 system 的余量：按调用方顺序拼接，去掉 billing 头与身份句，
 * 并把上下文计数抹平。结构 A 只用它构造首条 user 的 reminder。
 */
export function callerSystemRemainder(callerSystem) {
  return stabilizeTotalTokens(
    systemTexts(callerSystem)
      .filter((text) => !isBillingText(text) && !isOfficialIdentityText(text))
      .join('\n\n'),
  )
}

/** 官方族提示词的段落标记。命中任意一条即视为官方调用方。 */
const OFFICIAL_CALLER_MARKERS = Object.freeze([
  '# Reporting outcomes',
  'You are an interactive agent that helps users',
  'You are an agent working with the user toward their goals',
  '# Harness',
])

/**
 * 调用方本身是否就是官方 CLI 族。
 *
 * 判定依据：自带 billing 头、自带官方身份句，或带官方提示词的标志段落。
 * 官方族的整份 system 都由本档自己产出，余量不能折进 user——折进去等于把
 * 上一版的完整提示词再贴一遍，既重复计费又让前缀与样本对不上。
 */
export function looksLikeOfficialCaller(callerSystem) {
  const texts = systemTexts(callerSystem)
  if (texts.some((text) => isBillingText(text) || isOfficialIdentityText(text))) return true
  return texts.some((text) => OFFICIAL_CALLER_MARKERS.some((marker) => text.includes(marker)))
}

// ─────────────────────────────── 断点

/** TTL → cache_control。只有 1h 需要显式写 ttl，其余走默认。 */
export function cacheMarker(ttl) {
  return normalizePanelCacheTtl(ttl) === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
}

function withoutCacheControl(node) {
  if (!node || typeof node !== 'object' || !Object.hasOwn(node, 'cache_control')) return node
  const copy = { ...node }
  delete copy.cache_control
  return copy
}

function isMarkableBlock(block) {
  if (!block || typeof block !== 'object') return false
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return false
  if (block.type === 'text' && !String(block.text || '').trim()) return false
  return true
}

function lastMarkableIndex(content) {
  if (!Array.isArray(content)) return -1
  for (let i = content.length - 1; i >= 0; i--) if (isMarkableBlock(content[i])) return i
  return -1
}

function isMarkableUser(message) {
  if (message?.role !== 'user') return false
  if (typeof message.content === 'string') return Boolean(message.content.trim())
  return Array.isArray(message.content) && lastMarkableIndex(message.content) >= 0
}

/** 抹掉 messages 上所有断点。结构 A 重新布点前必须清掉调用方的标记。 */
export function stripMessageMarkers(messages = []) {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message
    const next = withoutCacheControl(message)
    if (!Array.isArray(next.content)) return next
    return { ...next, content: next.content.map(withoutCacheControl) }
  })
}

function markUserAt(messages, index, marker) {
  const message = messages[index]
  if (!message) return
  if (typeof message.content === 'string') {
    messages[index] = { ...message, content: [{ type: 'text', text: message.content, cache_control: { ...marker } }] }
    return
  }
  if (!Array.isArray(message.content)) return
  const at = lastMarkableIndex(message.content)
  if (at < 0) return
  const content = message.content.slice()
  content[at] = { ...content[at], cache_control: { ...marker } }
  messages[index] = { ...message, content }
}

/**
 * user 侧断点：最后一条 user 一定打；消息数 ≥4 时，它前面那条 user 也打。
 * 后一个断点落的是上一轮的写入位置，让超过 20 块回看窗口的长轮次仍能读到缓存。
 *
 * @returns {{messages: Array, count: number, at: number[]}}
 */
export function markUserCacheBreakpoints(messages = [], { ttl = null } = {}) {
  const marker = cacheMarker(ttl)
  const next = messages.slice()
  const users = []
  for (let i = next.length - 1; i >= 0 && users.length < 2; i--) {
    if (isMarkableUser(next[i])) users.push(i)
  }
  if (users.length > 1 && next.length < 4) users.pop()
  users.sort((a, b) => a - b)
  for (const index of users) markUserAt(next, index, marker)
  return { messages: next, count: users.length, at: users }
}

/**
 * system 侧断点：billing 永不标记；其余按预算保留（从尾部保留）。
 * 预算不足时优先丢掉靠前的标记——靠后的断点覆盖的前缀更长。
 */
function markSystemBlocks(blocks, marker, budget) {
  const next = blocks.map((block) => {
    if (isBillingText(block.text)) return withoutCacheControl(block)
    if (!block.cache_control) return block
    return { ...block, cache_control: { ...marker } }
  })
  let remaining = budget
  for (let i = next.length - 1; i >= 0; i--) {
    if (!next[i].cache_control) continue
    if (remaining > 0) remaining -= 1
    else next[i] = withoutCacheControl(next[i])
  }
  return next
}

// ─────────────────────────────── 消息组装

const ENV_HEADING_RE = /^# Environment\b/m
const NEXT_HEADING_RE = /\n# (?!Environment\b)/

/**
 * 找出文本里 `# Environment` 段的跨度。返回的 length 已去掉尾部空白，
 * 因此用 `start + length` 切尾时会保留原有的空行，段外字节不受影响。
 */
export function environmentSectionSpan(text) {
  const src = String(text ?? '')
  const start = src.search(ENV_HEADING_RE)
  if (start < 0) return null
  const rest = src.slice(start)
  const next = rest.search(NEXT_HEADING_RE)
  const raw = next >= 0 ? rest.slice(0, next) : rest
  const section = raw.replace(/\s+$/, '')
  if (!section) return null
  return { start, length: section.length, section }
}

/** 只替换 `# Environment` 段；没有该段时返回 null。 */
export function replaceEnvironmentSection(text, environment) {
  const span = environmentSectionSpan(text)
  if (!span) return null
  const src = String(text)
  return `${src.slice(0, span.start)}${environment}${src.slice(span.start + span.length)}`
}

function replaceEnvironmentInMessage(message, environment) {
  if (typeof message.content === 'string') {
    const text = replaceEnvironmentSection(message.content, environment)
    return text == null ? null : { ...message, content: text }
  }
  if (!Array.isArray(message.content)) return null
  for (let i = 0; i < message.content.length; i++) {
    const block = message.content[i]
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const text = replaceEnvironmentSection(block.text, environment)
    if (text == null) continue
    const content = message.content.slice()
    content[i] = { ...block, text }
    return { ...message, content }
  }
  return null
}

/**
 * 调用方 system 折进第一条 user。
 * reminder 必须放在首条 user 的头部：它是这一轮的上下文前提，排在用户内容之后就
 * 变成"用户先说话、系统后补充"，与官方样本的顺序相反。
 */
export function foldCallerSystemIntoFirstUser(messages = [], callerSystem, { reminderText = null } = {}) {
  const body = reminderText == null ? callerSystemRemainder(callerSystem) : stabilizeTotalTokens(reminderText)
  if (!String(body || '').trim()) return messages.slice()
  const index = messages.findIndex((message) => message?.role === 'user')
  if (index < 0) return messages.slice()
  const message = messages[index]
  const reminder = { type: 'text', text: `<system-reminder>\n${String(body).trim()}\n</system-reminder>\n` }
  const content =
    typeof message.content === 'string'
      ? [reminder, { type: 'text', text: message.content }]
      : Array.isArray(message.content)
        ? [reminder, ...message.content]
        : [reminder]
  const next = messages.slice()
  next[index] = { ...message, content }
  return next
}

/**
 * Environment 落位。
 *   1. 已有 role=system 消息带 `# Environment` 段 → 只替换那一段，其余字节不动；
 *   2. 否则插到最后一条 user 之后，作为尾部 role=system；
 *   3. 模型不接受会话中途 role=system 时不动 messages，由调用方并进主提示词。
 */
export function appendEnvironmentMessage(messages = [], environment) {
  const text = String(environment ?? '').trim()
  if (!text) return messages.slice()
  const next = messages.slice()
  for (let i = 0; i < next.length; i++) {
    if (next[i]?.role !== 'system') continue
    const replaced = replaceEnvironmentInMessage(next[i], text)
    if (replaced) {
      next[i] = replaced
      return next
    }
  }
  let lastUser = -1
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]?.role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser < 0) return [...next, { role: 'system', content: text }]
  next.splice(lastUser + 1, 0, { role: 'system', content: text })
  return next
}

// ─────────────────────────────── system 组装

/**
 * 组装 system 块。
 *
 * 结构 A：三块，billing 无断点，身份句与主提示词按面板 TTL 打点。
 *         调用方 system 不进 system——用 callerSystemRemainder 取余量。
 * 结构 B：交给 system-layout.mjs 的三布局；只把 billing 换成所选档位的版本。
 *
 * @returns {Array<{type: string, text: string, cache_control?: object}>}
 */
export function assembleSystemBlocks({
  profile = DEFAULT_PROMPT_PROFILE,
  model = '',
  callerSystem = null,
  environment = null,
  ttl = null,
  env = process.env,
  firstUserText = '',
} = {}) {
  const def = profileDefinition(profile)
  const structure = structureFor({ profile: def.name, model })
  const billing = billingHeader({ profile: def.name, firstUserText })

  if (structure === STRUCTURE_SYSTEM_REMINDER) {
    const marker = cacheMarker(ttl)
    const cwd = parseEnvironmentFacts([
      ...systemTexts(callerSystem),
      ...(environment ? [String(environment)] : []),
    ]).cwd
    return [
      { type: 'text', text: billing },
      { type: 'text', text: OFFICIAL_CLI_IDENTITY, cache_control: { ...marker } },
      { type: 'text', text: renderMainPrompt303({ cwd: cwd || DEFAULT_SLOT_CWD }), cache_control: { ...marker } },
    ]
  }

  // 结构 B：现有布局，调用方 system 仍在 system 内，只换 billing 版本。
  //
  // 只有**本档确实生成了 billing** 时才删调用方那条。
  // 原注释的假设是"本档已经在头块写了一条"，但默认档下 billing 是空的
  // （cli_hop 结构不产 billing），结果把调用方的 billing 删掉之后
  // 出站一条计费头都没有 —— 实测复现：调用方带 billing 进，
  // 出站 system 里 billing 数为 0。
  //
  // 这与具体做法相反：上游 v1.3.220 的 ensureBillingAttribution 是
  // 「body.system 里已有 billing 就原样返回」，即调用方自带的不改写。
  // 删掉它比不改写更糟 —— 丢了内容，还让计费头彻底消失。
  // 判定条件必须是「布局层真的会写 billing」，而不是「本档生成了 billing 字符串」。
  //
  // 这两者不等价：layoutSystemBlocks 在 stock 布局下**完全不写 billing**
  // （system-layout.mjs:283-290：只有 zero / identity 分支才 push）。
  // 而 billing 字符串在 stock 下仍然非空，于是按"字符串非空就删"会把
  // 调用方那条删掉，自己的又不输出 —— 出站零计费头。
  //
  // 实测复现：调用方带 cc_prompt_id=caller-owned 的 billing 进，
  // 出站 system 里 billing 数为 0。
  const layout = getSystemLayout(env)
  const layoutWritesBilling = layout !== 'stock'
  const ownBilling = layoutWritesBilling && billing && isBillingText(billing)
  const leftover = systemTexts(callerSystem)
    .filter((text) => !(ownBilling && isBillingText(text)))
    .join('\n\n')
  const blocks = layoutSystemBlocks({ attribution: billing, leftover: leftover || undefined, env })
  return blocks.map((text) => ({ type: 'text', text }))
}

// ─────────────────────────────── 整份请求

function orderTopLevel(body, order) {
  const out = {}
  // 顶层 cache_control 不属于 2.1.303 的请求形状，断点一律写在块上。
  delete body.cache_control
  for (const key of order) if (Object.hasOwn(body, key)) out[key] = body[key]
  for (const key of Object.keys(body)) if (!Object.hasOwn(out, key)) out[key] = body[key]
  return out
}

const TOP_LEVEL_ORDER_303 = Object.freeze([
  'model',
  'messages',
  'system',
  'tools',
  'metadata',
  'max_tokens',
  'thinking',
  'output_config',
  'stream',
])

/**
 * 按档位组装整份请求的 system 与 messages。纯函数，不改入参。
 *
 * 结构 B 下本模块不布消息断点：断点仍由 cache-breakpoints 那套逻辑负责，
 * 这里只换 billing 版本与 UA，保持该档"只换版本号"的约束。
 *
 * @param body          入站 body
 * @param opts.profile  所选档位（缺省 official_full）
 * @param opts.model    未给时取 body.model
 * @param opts.environment 结构 A 的 Environment 段文本，或事实对象
 * @param opts.ttl      面板缓存 TTL
 * @param opts.officialCaller true 表示调用方是官方族：其 system 整体不出站
 * @param opts.oneM     模型选了 1M 上下文：模型行与 Environment 标注上下文
 * @returns {{body: object, system: Array, messages: Array, profile: string,
 *            structure: string, cliVersion: string, userAgent: string,
 *            billing: string, markers: {total: number, at: Array<{where: string, ttl: string}>}}}
 */
export function assembleRequest(
  body = {},
  {
    profile = DEFAULT_PROMPT_PROFILE,
    model = null,
    environment = null,
    ttl = null,
    env = process.env,
    officialCaller = null,
    oneM = false,
  } = {},
) {
  const modelId = String(model || body.model || '')
  const def = profileDefinition(profile)
  const structure = structureFor({ profile: def.name, model: modelId })
  const messages = Array.isArray(body.messages) ? body.messages : []
  const callerSystem = body.system ?? null
  const firstUserText = messages.find((message) => message?.role === 'user')?.content
  const firstUserPlain =
    typeof firstUserText === 'string'
      ? firstUserText
      : Array.isArray(firstUserText)
        ? firstUserText.map((block) => (block?.type === 'text' ? String(block.text || '') : '')).join('')
        : ''

  const environmentText =
    environment == null
      ? null
      : typeof environment === 'string'
        ? environment
        : renderEnvironmentSection({ ...environment, model: environment.model || modelId, oneM })

  if (structure === STRUCTURE_CLI_HOP) {
    const system = assembleSystemBlocks({ profile: def.name, model: modelId, callerSystem, ttl, env, firstUserText: firstUserPlain })
    const summary = summarizeMarkers({ system, messages })
    const ordered = orderTopLevel({ ...body, system, messages }, TOP_LEVEL_ORDER_303)
    return {
      body: ordered,
      system: ordered.system,
      messages: ordered.messages,
      profile: def.name,
      structure,
      cliVersion: def.cliVersion,
      userAgent: outboundUserAgent(def.name),
      billing: system.find((block) => isBillingText(block.text))?.text ?? '',
      markers: summary,
    }
  }

  const system = assembleSystemBlocks({ profile: def.name, model: modelId, callerSystem, ttl, env, firstUserText: firstUserPlain })
  let nextMessages = stripMessageMarkers(messages)
  // 官方调用方的 system 整体不出站：本档的 system 已经覆盖了同样的内容，
  // 再折一份进 user 只会让 reminder 里出现上一版全文。
  // 判定由调用方传入（UA + user_id + system 三者共同判定，见 looksLikeOfficialCaller），
  // 组装层不猜：同一个 body 在两种判定下的出站结果必须可复现。
  if (officialCaller !== true) nextMessages = foldCallerSystemIntoFirstUser(nextMessages, callerSystem)
  if (environmentText && modelSupportsSystemTurns(modelId)) {
    nextMessages = appendEnvironmentMessage(nextMessages, environmentText)
  } else if (environmentText) {
    // 不支持中途 role=system：并进主提示词块尾部
    const main = system.length - 1
    system[main] = { ...system[main], text: `${system[main].text}\n\n${environmentText}` }
  }
  const marked = markUserCacheBreakpoints(nextMessages, { ttl })
  const systemBudget = Math.max(0, def.maxMarkers - marked.count)
  const markedSystem = markSystemBlocks(system, cacheMarker(ttl), systemBudget)
  const summary = summarizeMarkers({ system: markedSystem, messages: marked.messages })
  const ordered = orderTopLevel({ ...body, system: markedSystem, messages: marked.messages }, TOP_LEVEL_ORDER_303)
  return {
    body: ordered,
    system: ordered.system,
    messages: ordered.messages,
    profile: def.name,
    structure,
    cliVersion: def.cliVersion,
    userAgent: outboundUserAgent(def.name),
    billing: markedSystem.find((block) => isBillingText(block.text))?.text ?? '',
    markers: summary,
  }
}

/** 列出断点位置与 TTL，供测试与对比脚本判断数量与位置。 */
export function summarizeMarkers({ system = [], tools = [], messages = [] } = {}) {
  const at = []
  const note = (where, control) => {
    if (!control || typeof control !== 'object') return
    at.push({ where, ttl: normalizePanelCacheTtl(control.ttl) ?? '5m' })
  }
  if (Array.isArray(tools)) tools.forEach((tool, i) => note(`tools[${i}]`, tool?.cache_control))
  if (Array.isArray(system)) system.forEach((block, i) => note(`system[${i}]`, block?.cache_control))
  if (Array.isArray(messages)) {
    messages.forEach((message, i) => {
      note(`messages[${i}]`, message?.cache_control)
      if (Array.isArray(message?.content)) {
        message.content.forEach((block, j) => note(`messages[${i}].content[${j}]`, block?.cache_control))
      }
    })
  }
  return { total: at.length, at }
}

/** 期望断点位置：结构 A 为身份句、主提示词，加最后 1–2 条 user。 */
export function expectedMarkerCount({ messageCount = 0, userCount = 0 } = {}) {
  const userMarkers = messageCount >= 4 && userCount >= 2 ? 2 : userCount >= 1 ? 1 : 0
  return 2 + userMarkers
}
