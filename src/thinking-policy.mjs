/**
 * 出站请求的「补齐层」：让请求按高能力路径被上游处理。
 *
 * 背景：官方客户端（Claude Code）在每一份请求里都会显式带上 thinking /
 * output_config.effort / max_tokens。这些字段不是可选项——它们决定上游按
 * 「高能力推理」还是「降级路径」处理这次请求。我们的出站层原本只做清洗
 * （删字段），从不补字段，于是同一条对话经过网关后能力被静默降级。
 *
 * 这一层做五件事。除了第 5 项是上游硬性对齐（没有可选空间）之外，其余四项
 * 都只补不改：
 *
 *   1. 缺 max_tokens → 按模型补缺省；超过模型输出上限 → 夹到上限
 *   2. thinking.enabled 的 budget_tokens 低于下限 / 非法 → 夹到合法值
 *   3. 缺 thinking → 补 adaptive + display:omitted（仅模型支持 adaptive 时）
 *   4. 缺 output_config.effort → 补模型缺省 effort（模型不支持时删掉该字段）
 *   5. thinking 开启时强制 temperature=1（上游硬要求，同时删 top_p / top_k）
 *
 * 最重要的约束：**补齐 ≠ 覆盖**。
 * 调用方显式给的值一律保留——thinking.display、output_config.effort、
 * max_tokens、budget_tokens 都是如此。唯一例外是 temperature：上游对
 * 「thinking 开启 + temperature≠1」直接 400，没有可协商的余地，因此这一项
 * 是强制对齐而不是补齐。
 *
 * 对齐依据：官方 vm2api v1.3.220
 *   · protocol/thinking.mjs      ensureUnofficialAdaptiveThinking /
 *                               ensureUnofficialEffortHigh / stripUnsupportedEffort
 *   · protocol/anthropic-policy.mjs alignSamplingWithThinking
 *   · protocol/model-policy.mjs  MIN_THINKING_BUDGET / clampEnabledThinkingBudget /
 *                               defaultMaxTokensForModel / applyMaxTokensCap
 *
 * 模型清单取自本仓库 prompt-profiles.mjs 的档位表（我们实际会收到的模型），
 * 能力值按官方 seed 矩阵逐项抄录；官方 seed 未收录的 id 走官方启发式缺省。
 * 不认识的模型一律**不补**：给未知模型编能力比缺字段更危险（会补错）。
 */

// ─────────────────────────────── 常量

/** 官方在缺 thinking 时补的 display 值（官方 thinking.mjs:137）。 */
export const OFFICIAL_THINKING_DISPLAY = 'omitted'

/** budget_tokens 的硬下限。官方 model-policy.mjs:753，低于它上游直接 400。 */
export const MIN_THINKING_BUDGET = 1024

/** effort 的兜底值：模型没声明 default_effort 时用 high（官方 thinking.mjs:294-299）。 */
export const DEFAULT_EFFORT = 'high'

/** budget_tokens 非法（缺失 / ≤0 / 非数字）时的兜底值（官方缺省 4096）。 */
export const FALLBACK_THINKING_BUDGET = 4096

/** 能力条目没写 default_max_tokens 时的兜底值（官方 FALLBACK_MAX_TOKENS）。 */
export const FALLBACK_MAX_TOKENS = 4096

// ─────────────────────────────── 模型能力矩阵

/** 矩阵条目构造器：统一字段顺序与冻结，避免各处写法不一致。 */
function entry(
  supportsAdaptiveThinking,
  supportsEffort,
  defaultEffort,
  defaultMaxTokens,
  maxOutputTokens,
) {
  return Object.freeze({
    supports_adaptive_thinking: supportsAdaptiveThinking,
    supports_effort: supportsEffort,
    default_effort: defaultEffort,
    default_max_tokens: defaultMaxTokens,
    max_output_tokens: maxOutputTokens,
    thinking_fallback_budget: FALLBACK_THINKING_BUDGET,
  })
}

/**
 * 最小能力矩阵。每个模型只保留本层需要的五个判定项：
 *
 *   supports_adaptive_thinking  能否接受 thinking.type = 'adaptive'
 *   supports_effort             能否接受 output_config.effort
 *   default_effort              补 effort 时用的缺省值（null → 'high'）
 *   default_max_tokens          调用方没给 max_tokens 时补的值
 *   max_output_tokens           模型输出上限，超过就夹到这个值
 *   thinking_fallback_budget    budget_tokens 非法时补的值
 *
 * 键是归一化后的模型 id（见 capabilityModelId）。
 *
 * 数值来源：
 *   · 官方 seed 矩阵（model-policy.mjs:140-390）里有的 id，逐字抄 param；
 *   · 官方 seed 未收录、但官方启发式能识别的 id（haiku-5 / mythos 系列），
 *     能力位取启发式 CAP_*，数值取启发式缺省（16384 / 64000）；
 *   · 上一代模型（4.5 及更早、Claude 3.x）官方矩阵未收录且启发式会误判，
 *     这里按「确定不支持 adaptive / effort」保守处理，输出上限取模型真实上限。
 */
export const MODEL_CAPABILITIES = Object.freeze({
  // ── Claude 3.x：无 adaptive、无 effort ──
  'claude-3-5-sonnet': entry(false, false, null, 8192, 8192),
  'claude-3-7-sonnet': entry(false, false, null, 16384, 64000),

  // ── Haiku ──
  // 4.5：官方 CAP_HAIKU，8192 / 64000
  'claude-haiku-4-5': entry(false, false, null, 8192, 64000),
  // 5 / 5.5：官方启发式与 seed 都认 adaptive + effort
  'claude-haiku-5': entry(true, true, null, 16384, 64000),
  'claude-haiku-5-5': entry(true, true, 'medium', 100000, 100000),

  // ── Sonnet ──
  // 4.5：官方 CAP_SONNET45（无 adaptive、无 effort），16384 / 64000
  'claude-sonnet-4-5': entry(false, false, null, 16384, 64000),
  'claude-sonnet-4-6': entry(true, true, null, 16384, 64000),
  'claude-sonnet-5': entry(true, true, null, 64000, 128000),
  'claude-sonnet-5-5': entry(true, true, 'medium', 128000, 128000),

  // ── Opus 4.x ──
  // 4.0 / 4.1 / 4.5 早于 adaptive 与 effort 两项能力，确定不支持；
  // 输出上限取模型真实值（4.0/4.1 是 32000，4.5 是 64000），
  // 不跟官方启发式的 64000 —— 那会把 4.0/4.1 的请求放过上限。
  'claude-opus-4-0': entry(false, false, null, 16384, 32000),
  'claude-opus-4-1': entry(false, false, null, 16384, 32000),
  'claude-opus-4-5': entry(false, false, null, 16384, 64000),
  'claude-opus-4-6': entry(true, true, null, 32000, 128000),
  'claude-opus-4-7': entry(true, true, null, 32000, 128000),
  'claude-opus-4-8': entry(true, true, null, 32000, 128000),

  // ── Opus 5 系列 ──
  // 5：默认 effort 是 high（不是 medium），32000 / 128000
  'claude-opus-5': entry(true, true, null, 32000, 128000),
  // 5.5：默认 effort 是 medium，输出缺省就是上限
  'claude-opus-5-5': entry(true, true, 'medium', 128000, 128000),

  // ── Fable / Mythos ──
  'claude-fable-5': entry(true, true, null, 32000, 128000),
  'claude-fable-5-1': entry(true, true, null, 32000, 128000),
  // mythos 在官方 seed 里没有条目，只能走启发式缺省（16384 / 64000）
  'claude-mythos-5': entry(true, true, null, 16384, 64000),
  'claude-mythos-5-1': entry(true, true, null, 16384, 64000),
})


/**
 * 模型 id 归一：去 provider 前缀、`[1m]` 后缀、日期后缀，并把版本号里的点
 * 换成连字符（`claude-opus-5.5` → `claude-opus-5-5`）。
 *
 * 与 betas.mjs 的 normalizeModelId 的区别只在「点号归一」这一条：上游的
 * 点号写法是同一个模型的另一种 id，能力判定必须能认出来。
 */
export function capabilityModelId(model) {
  let id = String(model ?? '').trim().toLowerCase()
  if (!id) return ''
  id = id.split('/').pop()
  id = id.replace(/\[[^\]]*\]$/, '')
  id = id.replace(/-\d{8}$/, '')
  id = id.replace(/\./g, '-')
  // 上游把裸 claude-opus-4 当作 4.0
  if (id === 'claude-opus-4') return 'claude-opus-4-0'
  return id
}

/** 取能力条目；不认识的模型返回 null（调用方据此走「不补」分支）。 */
export function capabilitiesFor(model) {
  return MODEL_CAPABILITIES[capabilityModelId(model)] || null
}

/** 模型能否接受 thinking.type = 'adaptive'。不认识的模型返回 false。 */
export function modelSupportsAdaptiveThinking(model) {
  return capabilitiesFor(model)?.supports_adaptive_thinking === true
}

/** 模型能否接受 output_config.effort。不认识的模型返回 false。 */
export function modelSupportsEffort(model) {
  return capabilitiesFor(model)?.supports_effort === true
}

/** 模型输出上限；不认识返回 null。 */
export function maxOutputTokensForModel(model) {
  const cap = capabilitiesFor(model)?.max_output_tokens
  return Number.isFinite(cap) && cap > 0 ? cap : null
}

/**
 * 调用方没给 max_tokens 时该补的值：模型缺省值，且不超过输出上限。
 * 不认识的模型返回 null —— 这一项不猜。
 */
export function defaultMaxTokensForModel(model) {
  const caps = capabilitiesFor(model)
  if (!caps) return null
  const value = Number(caps.default_max_tokens)
  const cap = Number(caps.max_output_tokens)
  let out = Number.isFinite(value) && value > 0 ? value : FALLBACK_MAX_TOKENS
  if (Number.isFinite(cap) && cap > 0 && out > cap) out = cap
  return out
}

// ─────────────────────────────── 1. max_tokens

/**
 * 补 max_tokens 缺省值，并把超过模型上限的值夹到上限。
 *
 * 语义与官方 defaultMaxTokensForModel / applyMaxTokensCap 一致：
 *   · 调用方给了合法值 → 只在超过上限时夹，绝不改成缺省值
 *   · 调用方没给 → 补模型缺省（该缺省已按上限夹过，所以不会超）
 *   · 不认识的模型 → 不动（宁可让上游报错，也不悄悄截断到我们编的值）
 */
export function applyDefaultMaxTokens(body) {
  if (!body || typeof body !== 'object') return body
  const caps = capabilitiesFor(body.model)
  if (!caps) return body

  const raw = body.max_tokens
  const value = Number(raw)
  const missing = raw == null || !Number.isFinite(value) || value <= 0
  if (missing) {
    const filled = defaultMaxTokensForModel(body.model)
    if (filled == null) return body
    return { ...body, max_tokens: filled }
  }

  const cap = Number(caps.max_output_tokens)
  if (Number.isFinite(cap) && cap > 0 && value > cap) {
    return { ...body, max_tokens: cap }
  }
  return body
}

// ─────────────────────────────── 2. thinking budget

function thinkingEnabled(thinking) {
  if (!thinking || typeof thinking !== 'object') return false
  const type = String(thinking.type || '').trim().toLowerCase()
  return type === 'enabled' || type === 'adaptive'
}

/**
 * 把 thinking.enabled.budget_tokens 夹到合法区间。
 *
 * 官方 clampEnabledThinkingBudget 只修「非法 / ≤0」的值；上游对
 * 「0 < budget < 1024」同样 400，所以这里一并抬到 MIN_THINKING_BUDGET。
 * adaptive 没有 budget 概念，原样放过。
 *
 * 不根据 budget 反向改 max_tokens：官方明确「max_tokens 是调用方的总额度，
 * 绝不静默替换」，budget 超过 max_tokens 的组合交给上游判定。
 */
export function clampThinkingBudget(body) {
  if (!body || typeof body !== 'object') return body
  const thinking = body.thinking
  if (!thinkingEnabled(thinking)) return body
  if (String(thinking.type).trim().toLowerCase() !== 'enabled') return body

  const fallback = Number(capabilitiesFor(body.model)?.thinking_fallback_budget)
  const fallbackBudget = Number.isFinite(fallback) && fallback > 0 ? fallback : FALLBACK_THINKING_BUDGET
  const raw = Number(thinking.budget_tokens)

  let budget
  if (!Number.isFinite(raw) || raw <= 0) budget = fallbackBudget
  else if (raw < MIN_THINKING_BUDGET) budget = MIN_THINKING_BUDGET
  else budget = raw

  if (thinking.budget_tokens === budget) return body
  return { ...body, thinking: { ...thinking, type: 'enabled', budget_tokens: budget } }
}

// ─────────────────────────────── 3. adaptive thinking

function thinkingNeedsOfficialDisplay(thinking) {
  if (!thinking || typeof thinking !== 'object') return false
  if (!thinkingEnabled(thinking)) return false
  const display = thinking.display
  return display == null || String(display).trim() === ''
}

/**
 * 补 thinking：完全缺失时补 `{type:'adaptive', display:'omitted'}`；
 * 已有 thinking 但缺 display 时只补 display。
 *
 * 两条硬约束：
 *   · 只在模型支持 adaptive 时补 —— 打到 Haiku / 4.5 会 400
 *   · 绝不覆盖调用方的 display（summarized / updates 都原样保留）
 */
export function ensureAdaptiveThinking(body) {
  if (!body || typeof body !== 'object') return body
  if (body.thinking == null) {
    if (!modelSupportsAdaptiveThinking(body.model)) return body
    return { ...body, thinking: { type: 'adaptive', display: OFFICIAL_THINKING_DISPLAY } }
  }
  if (!thinkingNeedsOfficialDisplay(body.thinking)) return body
  return { ...body, thinking: { ...body.thinking, display: OFFICIAL_THINKING_DISPLAY } }
}

// ─────────────────────────────── 4. effort

/**
 * 模型确定不接受 effort 时，把 output_config.effort 删掉（顶层 + 每条消息）。
 *
 * 官方 stripUnsupportedEffort 连「删完就空了的 output_config」一起删；消息级
 * 只删 effort，不做空轮次清理（那是 sanitize 层的职责，不在这里重复实现）。
 * 不认识的模型不动：我们不知道它支不支持，删掉可能是错的。
 */
export function stripUnsupportedEffort(body) {
  if (!body || typeof body !== 'object') return body
  if (!capabilitiesFor(body.model)) return body
  if (modelSupportsEffort(body.model)) return body

  let out = body
  const config = body.output_config
  if (config && typeof config === 'object' && Object.prototype.hasOwnProperty.call(config, 'effort')) {
    const next = { ...config }
    delete next.effort
    if (Object.keys(next).length === 0) {
      out = { ...out }
      delete out.output_config
    } else {
      out = { ...out, output_config: next }
    }
  }

  if (!Array.isArray(out.messages)) return out
  let changed = false
  const messages = out.messages.map((message) => {
    if (!message || typeof message !== 'object') return message
    const messageConfig = message.output_config
    if (!messageConfig || typeof messageConfig !== 'object') return message
    if (!Object.prototype.hasOwnProperty.call(messageConfig, 'effort')) return message
    changed = true
    const next = { ...messageConfig }
    delete next.effort
    const nextMessage = { ...message }
    if (Object.keys(next).length === 0) delete nextMessage.output_config
    else nextMessage.output_config = next
    return nextMessage
  })
  return changed ? { ...out, messages } : out
}

/**
 * 补 output_config.effort：缺（或空串）时补模型缺省值。
 *
 *   · 支持的模型 → 补 default_effort || 'high'
 *   · 确定不支持的模型 → 删掉调用方带来的 effort（否则上游 400）
 *   · 不认识的模型 → 不动
 *   · 调用方给了非空 effort → 原样保留（补齐 ≠ 覆盖）
 */
export function ensureEffort(body) {
  if (!body || typeof body !== 'object') return body
  const caps = capabilitiesFor(body.model)
  if (!caps) return body
  if (!caps.supports_effort) return stripUnsupportedEffort(body)

  const effort = caps.default_effort || DEFAULT_EFFORT
  const config = body.output_config
  if (config && typeof config === 'object') {
    if (config.effort != null && config.effort !== '') return body
    return { ...body, output_config: { ...config, effort } }
  }
  return { ...body, output_config: { effort } }
}

// ─────────────────────────────── 5. temperature

/**
 * thinking 开启时把采样参数对齐成上游唯一接受的值。
 *
 * 官方 alignSamplingWithThinking：thinking=adaptive|enabled 时
 * temperature 必须是 1，且 top_p / top_k 会被上游拒绝，一并删掉。
 * 这一项在官方实现里也是覆盖（不是补齐）——上游没有可选空间。
 */
export function enforceThinkingTemperature(body) {
  if (!body || typeof body !== 'object') return body
  if (!thinkingEnabled(body.thinking)) return body

  let changed = false
  const out = { ...body }
  if (out.temperature !== 1) {
    out.temperature = 1
    changed = true
  }
  for (const key of ['top_p', 'top_k']) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      delete out[key]
      changed = true
    }
  }
  return changed ? out : body
}

// ─────────────────────────────── 串联

/**
 * 五项按依赖顺序串起来。顺序不能换：
 *
 *   1. max_tokens   —— 先让必填字段存在（补齐值已按上限夹过）
 *   2. budget       —— 再夹 thinking 预算（不依赖 max_tokens，但要在补 thinking
 *                       之前处理调用方已给的 enabled 形态）
 *   3. thinking     —— 补 adaptive（第 4 步的模型判定与第 5 步的温度都看它）
 *   4. effort       —— 补 output_config.effort
 *   5. temperature  —— 最后对齐，因为它取决于 thinking 最终是否开启
 *
 * 不需要改动的 body 原样返回（同一个对象引用），避免无意义的复制。
 */
export function applyDegradationGuards(body) {
  if (!body || typeof body !== 'object') return body
  let out = applyDefaultMaxTokens(body)
  out = clampThinkingBudget(out)
  out = ensureAdaptiveThinking(out)
  out = ensureEffort(out)
  out = enforceThinkingTemperature(out)
  return out
}
