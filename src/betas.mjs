/**
 * Beta 令牌动态注入。
 *
 * 职责：在调用方给出的 beta 列表上，按请求体的实际内容追加对应的协议 beta。
 *
 * 关键约束：
 * 1. beta 不是固定白名单，而是按请求体内容动态追加。少加一个，上游会按旧行为
 *    处理这份请求；多加一个，上游可能因为不认识该 beta 而直接报错。
 * 2. 结果必须去重并保持首次出现顺序；序列化为 HTTP 头时按同一顺序逗号拼接。
 * 3. 模型匹配统一走 normalizeModelId，忽略 provider 前缀、[1m] 后缀与日期后缀。
 */

export const BETA = Object.freeze({
  OAUTH: 'oauth-2025-04-20',
  CLAUDE_CODE: 'claude-code-20250219',
  INTERLEAVED: 'interleaved-thinking-2025-05-14',
  THINKING_TOKEN_COUNT: 'thinking-token-count-2026-05-13',
  PROMPT_CACHING_SCOPE: 'prompt-caching-scope-2026-01-05',
  MID_CONVERSATION_SYSTEM: 'mid-conversation-system-2026-04-07',
  MID_CONVERSATION_SYSTEM_CLEAR_AT: 'mid-conversation-system-clear-at-2026-08-21',
  MID_CONVERSATION_TOOL_CHANGES: 'mid-conversation-tool-changes-2026-07-01',
  MID_CONVERSATION_OUTPUT_CONFIG: 'mid-conversation-output-config-2026-07-01',
  ADVANCED_TOOL_USE: 'advanced-tool-use-2025-11-20',
  THINKING_BINDING_CONTROLS: 'thinking-binding-controls-2026-08-01',
  EFFORT: 'effort-2025-11-24',
  EXTENDED_CACHE_TTL: 'extended-cache-ttl-2025-04-11',
  CACHE_DIAGNOSIS: 'cache-diagnosis-2026-04-07',
  CONTEXT_MANAGEMENT: 'context-management-2025-06-27',
  FALLBACK_CREDIT: 'fallback-credit-2026-06-01',
  THINKING_DISPLAY_UPDATES: 'thinking-display-updates-2026-08-18',
  DANGEROUS_TOOL_USE: 'dangerous-tool-use-2026-09-03',
  STRUCTURED_OUTPUTS: 'structured-outputs-2025-12-15',
  TASK_BUDGETS: 'task-budgets-2026-03-13',
  FAST_MODE: 'fast-mode-2026-02-01',
  MESSAGE_THREADS: 'message-threads-2026-08-12',
  SERVER_SIDE_FALLBACK_DEFAULT: 'server-side-fallback-2026-07-01',
  SERVER_SIDE_FALLBACK_LIST: 'server-side-fallback-2026-06-01',
  PROMPT_CACHING_EVICT: 'prompt-caching-evict-2026-05-12',
  PER_TURN_CONTROL: 'per-turn-control-2026-07-01',
})

const PER_TURN_MODELS = new Set([
  'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1',
])

const MID_TOOL_CHANGE_MODELS = new Set([
  'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-4-8', 'claude-opus-5',
  'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5-1',
])

const FAST_MODE_MODELS = new Set(['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5'])

const MID_OUTPUT_CONFIG_MODELS = new Set([
  'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-4-8', 'claude-opus-5',
  'claude-opus-5-5', 'claude-fable-5', 'claude-fable-5-1',
])

/**
 * 模拟 Claude Code 客户端时固定携带的 7 个 beta。
 * 顺序即上线顺序，不要重排。
 */
export function claudeCodeMimicryBetas() {
  return [
    BETA.CLAUDE_CODE,
    BETA.OAUTH,
    BETA.INTERLEAVED,
    BETA.THINKING_TOKEN_COUNT,
    BETA.CONTEXT_MANAGEMENT,
    BETA.PROMPT_CACHING_SCOPE,
    BETA.MID_CONVERSATION_SYSTEM,
  ]
}

/**
 * 模型名归一化：去掉 provider 前缀（`anthropic/xxx` → `xxx`）、`[1m]` 后缀与
 * `-YYYYMMDD` 日期后缀。下面所有模型集合都按归一化后的名字匹配。
 */
export function normalizeModelId(raw) {
  return String(raw || '')
    .split('/')
    .pop()
    .replace(/\[1m\]/gi, '')
    .replace(/-\d{8}$/, '')
}

function hasHourCache(node) {
  if (Array.isArray(node)) return node.some(hasHourCache)
  if (!node || typeof node !== 'object') return false
  if (node.cache_control?.ttl === '1h') return true
  return hasHourCache(node.content)
}

/**
 * 动态追加 beta。返回去重后的数组，保持首次出现顺序。
 *
 * 判定分四类输入：model / output_config / thinking / safeguards，
 * 以及 context、thread、fallbacks、缓存标记、tools、messages 逐条扫描。
 * 每个 if 都对应一类上游协议能力开关，删掉任一分支都会让上游按旧行为处理。
 *
 * @param {string[]} tokens 已有的 beta
 * @param {object} body    请求体
 */
export function withRequestProtocolBetas(tokens = [], body = {}) {
  const betas = [...new Set(tokens.filter(Boolean))]
  const add = (t) => {
    if (!betas.includes(t)) betas.push(t)
  }
  const model = normalizeModelId(body.model)

  // ── 模型相关 ──
  if (PER_TURN_MODELS.has(model)) add(BETA.PER_TURN_CONTROL)
  if (MID_TOOL_CHANGE_MODELS.has(model)) add(BETA.MID_CONVERSATION_TOOL_CHANGES)
  if (body.thread != null && MID_OUTPUT_CONFIG_MODELS.has(model)) {
    add(BETA.MID_CONVERSATION_OUTPUT_CONFIG)
  }
  if (body.speed === 'fast' && FAST_MODE_MODELS.has(model)) add(BETA.FAST_MODE)

  // ── output_config 相关 ──
  if (body.output_config?.effort != null) add(BETA.EFFORT)
  if (body.output_config?.format) add(BETA.STRUCTURED_OUTPUTS)
  if (body.output_config?.task_budget) add(BETA.TASK_BUDGETS)

  // ── thinking 相关 ──
  if (body.thinking?.display === 'updates') add(BETA.THINKING_DISPLAY_UPDATES)
  if (body.thinking?.block_binding) add(BETA.THINKING_BINDING_CONTROLS)

  // ── safeguards ──
  if (Array.isArray(body.safeguards) &&
      body.safeguards.some((s) => s?.type === 'dangerous_tool_use')) {
    add(BETA.DANGEROUS_TOOL_USE)
  }

  // ── context / 线程 ──
  if (body.context_management) add(BETA.CONTEXT_MANAGEMENT)
  if (body.thread != null) add(BETA.MESSAGE_THREADS)
  if (body.diagnostics != null) add(BETA.CACHE_DIAGNOSIS)

  // ── fallback ──
  if (body.fallbacks === 'default') {
    add(BETA.SERVER_SIDE_FALLBACK_DEFAULT)
  } else if (Array.isArray(body.fallbacks) && body.fallbacks.length > 0) {
    add(BETA.SERVER_SIDE_FALLBACK_LIST)
  }
  if (typeof body.fallback_credit_token === 'string' &&
      body.fallback_credit_token.length > 0 &&
      body.fallback_credit_token.length <= 2048) {
    add(BETA.FALLBACK_CREDIT)
  }

  // ── 缓存 ──
  if (body.cache_control?.evict_on_complete) add(BETA.PROMPT_CACHING_EVICT)
  if (hasHourCache(body) || hasHourCache(body.system) ||
      hasHourCache(body.tools) || hasHourCache(body.messages)) {
    add(BETA.EXTENDED_CACHE_TTL)
  }

  // ── tools 逐个检查 ──
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool?.strict === true) add(BETA.STRUCTURED_OUTPUTS)
      if (tool?.defer_loading || String(tool?.type || '').startsWith('tool_search_tool_')) {
        add(BETA.ADVANCED_TOOL_USE)
      }
    }
  }

  // ── messages 逐条检查（中途改 system / output_config）──
  if (Array.isArray(body.messages)) {
    let hasSystem = false
    let hasClearAt = false
    let hasMessageOutputConfig = false
    let hasMessageEffort = false
    let hasMessageFormat = false
    let hasMessageTaskBudget = false
    for (const m of body.messages) {
      if (!m || typeof m !== 'object') continue
      if (m.role === 'system') hasSystem = true
      if (m.clear_at != null) hasClearAt = true
      const cfg = m.output_config
      if (!cfg || typeof cfg !== 'object') continue
      hasMessageOutputConfig = true
      if (cfg.effort != null) hasMessageEffort = true
      if (cfg.format) hasMessageFormat = true
      if (cfg.task_budget) hasMessageTaskBudget = true
    }
    if (hasSystem) add(BETA.MID_CONVERSATION_SYSTEM)
    if (hasClearAt) add(BETA.MID_CONVERSATION_SYSTEM_CLEAR_AT)
    if (hasMessageOutputConfig) add(BETA.MID_CONVERSATION_OUTPUT_CONFIG)
    if (hasMessageEffort) add(BETA.EFFORT)
    if (hasMessageFormat) add(BETA.STRUCTURED_OUTPUTS)
    if (hasMessageTaskBudget) add(BETA.TASK_BUDGETS)
  }

  return betas
}

/** beta 数组 → HTTP 头值（逗号分隔，保序，过滤空值） */
export function joinBetas(tokens = []) {
  return [...tokens].filter(Boolean).join(',')
}
