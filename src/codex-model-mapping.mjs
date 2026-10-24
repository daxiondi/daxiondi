/**
 * 入站 Codex 模型名的白名单重写。
 *
 * 上游有一类「不是真模型」的模型名：`codex-auto-review` 是客户端的自动审查
 * 占位符，上游并不认识它。把它当真实 id 直发的结果是 400
 * `model is not supported when using Codex with a ChatGPT account`，
 * 而且错误发生在调度之后 —— 账号已经占坑、RPM 已经计数，全都白花。
 *
 * 官方的做法是**白名单式重写**：映射表里有的改写成目标模型，其余一律原名直发。
 * 这里保持一致，只多做两件事：
 *   1. 保留 `vendor/model` 前缀形态（`openai/codex-auto-review` 重写成
 *      `openai/gpt-6-luna`），因为有些客户端会给模型名带供应商前缀；
 *   2. 把「重写」与「平台判定」拆成两个函数，并在文档里写死调用顺序。
 *
 * 关键约束：
 *
 * 1. **重写必须发生在平台判定之前**。平台判定按模型名前缀分流（gpt-* → OpenAI，
 *    claude-* → Anthropic），先判定再重写会让 `codex-auto-review` 走进
 *    「未知模型」分支，得到一个与事实无关的 400；反过来先重写，判定看到的就是
 *    真实上游 id。官方在 handle-protocol 里也是这个顺序（重写 → 判定）。
 *
 * 2. 重写只认白名单。不做 `codex-*` → `gpt-*` 的通配改写：上游随时可能新增
 *    `codex-` 前缀的真实 id，通配会把它们全部改错，而且错得没有痕迹。
 *
 * 3. 映射目标必须是上游认识的 GPT 对话模型 id。别把 Anthropic 模型名写进表里，
 *    重写在判定之前，一个 `claude-*` 目标会把 Claude 请求劫持到 Codex 通道。
 *
 * 4. 未命中、空值、非字符串一律原样返回，不抛错。模型名缺失是上层的事
 *    （本仓库由 codex-server 回落到 codex_default_model），这一层不该替它决定。
 */

/**
 * 兜底模型。
 *
 * 官方语义：运维把 `codex-auto-review` 的映射目标清空时，用它作为推荐的
 * 次级缺省。它必须是上游 /models 列表里真实存在的 GPT 对话模型，否则重写
 * 只是把「未知模型 400」换成「不支持模型 400」。
 */
export const FALLBACK_MODEL = 'gpt-6.1-sol'

/**
 * 入站模型名 → 上游模型 id 的白名单。
 *
 * 为什么只有一条：上游的「非真实模型名」目前只有 `codex-auto-review` 这一个。
 * 其余 id（`gpt-6-astra`、`gpt-6-sol`、`gpt-6.1-sol`、`gpt-reserve`、
 * `gpt-6-luna`、`gpt-5.6-*`）都是上游真认的名字，加进表里只会多一层无意义
 * 间接、并在上游改名时多一处要同步的地方。官方表同样只有这一条。
 */
export const CODEX_MODEL_MAP = Object.freeze({
  'codex-auto-review': 'gpt-6-luna',
})

/** 映射表的键，供配置校验与测试列举。 */
export const CODEX_MODEL_ALIASES = Object.freeze(Object.keys(CODEX_MODEL_MAP))

/**
 * 取模型名的「裸 id」：最后一个路径段。
 *
 * 客户端可能发 `openai/codex-auto-review`、`azure/gpt-6-sol` 这类带前缀的形态，
 * 判定与查表都该按最后一段做。空串与全斜杠返回空串。
 */
function bareModelId(model) {
  const raw = String(model ?? '').trim()
  if (!raw) return ''
  return raw.split('/').filter(Boolean).pop() || ''
}

/**
 * 把重写结果写回原模型名，保留前缀。
 *
 * `openai/codex-auto-review` → `openai/gpt-6-luna`；
 * 没有前缀时直接返回上游 id。
 */
function rewriteModelField(model, upstreamId) {
  const raw = String(model ?? '').trim()
  const parts = raw.split('/').filter(Boolean)
  if (parts.length <= 1) return upstreamId
  parts[parts.length - 1] = upstreamId
  return parts.join('/')
}

/**
 * 查表。大小写不敏感：客户端把 `Codex-Auto-Review` 原样发过来时也该命中，
 * 否则同一个别名在大小写上有两种行为，排查时极易误判成「映射没生效」。
 *
 * @returns {string|null} 命中返回目标 id，未命中返回 null
 */
function mappingLookup(map, model) {
  const bare = bareModelId(model)
  if (!bare) return null
  const lower = bare.toLowerCase()
  if (Object.prototype.hasOwnProperty.call(map, bare)) return map[bare]
  if (Object.prototype.hasOwnProperty.call(map, lower)) return map[lower]
  for (const [key, target] of Object.entries(map)) {
    if (String(key).toLowerCase() === lower) return target
  }
  return null
}

/**
 * 白名单重写：命中就换成目标 id，未命中原样返回。
 *
 * 这是本模块的主入口，也是唯一的调用点契约：**在任何按模型名分流之前调用**。
 *
 * @param {unknown} model 客户端发来的模型名
 * @param {object}  [opts]
 * @param {Record<string,string>} [opts.map] 覆盖映射表（缺省 CODEX_MODEL_MAP）
 * @returns {unknown} 命中时为上游 id（保留前缀），否则为入参本身
 */
export function applyCodexModelMapping(model, { map = CODEX_MODEL_MAP } = {}) {
  // 空值 / 非字符串原样返回：让上层继续走自己的缺省模型逻辑，
  // 这一层不替调用方决定「没给模型时用什么」。
  if (typeof model !== 'string') return model
  const raw = model.trim()
  if (!raw) return model
  const source = map && typeof map === 'object' ? map : CODEX_MODEL_MAP
  const target = mappingLookup(source, raw)
  if (target == null || target === '') return model
  const upstream = String(target).trim()
  if (!upstream) return model
  // 目标与源相同：不必重写，保持原字符串（含前缀形态）不动
  if (upstream === bareModelId(raw)) return model
  return rewriteModelField(raw, upstream)
}

/**
 * 运维覆盖表归一：把用户给的映射合并到缺省白名单上。
 *
 * 语义与官方一致：
 *   - 值为 `null` / 空串时，若键是 `codex-auto-review` 则回落到
 *     {@link FALLBACK_MODEL}（清空主目标等于「换个推荐目标」，不是「关掉重写」）；
 *   - 其它键的空值表示删掉这条覆盖；
 *   - 空键、非字符串值一律忽略。
 *
 * @param {unknown} raw
 * @returns {Record<string,string>}
 */
export function normalizeCodexModelMap(raw) {
  const merged = { ...CODEX_MODEL_MAP }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (!src) return merged
  for (const [key, value] of Object.entries(src)) {
    const alias = String(key ?? '').trim()
    if (!alias) continue
    if (value === null || value === '') {
      if (alias.toLowerCase() === 'codex-auto-review') merged[alias] = FALLBACK_MODEL
      else delete merged[alias]
      continue
    }
    const target = String(value).trim()
    if (target) merged[alias] = target
  }
  return merged
}

// ─────────────── 平台判定（重写之后才允许调用）───────────────

/** 明确不算 GPT 对话模型的 id 段：图像模型、嵌入模型等。 */
const SKIP_GPT = /^(gpt-image|gpt-4o-image|dall-e|text-embedding|whisper|tts-)/

/**
 * 按模型名判定入站平台。
 *
 * 本仓库的公网入口按**路径**分派通道（`/v1/responses` 等直接进 codex-server），
 * 所以这个函数不是必需的分流开关，它的价值有两个：
 *   1. 让「重写在前、判定在后」这条顺序在代码里有可断言的位置；
 *   2. 上层要做跨通道的前置拒绝时，有唯一一份判定逻辑可用。
 *
 * 未知模型返回 `{ok:false, code:'model_not_supported'}`，不做「猜一个平台」
 * 的兜底：猜错的代价是把请求送进完全不兼容的协议层。
 *
 * @param {unknown} model
 * @returns {{ok:true, platform:'openai'|'anthropic', model:string}
 *          |{ok:false, code:string, message:string}}
 */
export function detectCodexPlatform(model) {
  const raw = String(model ?? '').trim()
  if (!raw) {
    return { ok: false, code: 'model_required', message: 'model is required' }
  }
  const id = bareModelId(raw)
  const lower = id.toLowerCase()
  if (SKIP_GPT.test(lower)) {
    return { ok: false, code: 'model_not_supported', message: `model '${raw}' is not a GPT chat model` }
  }
  if (lower.startsWith('gpt')) return { ok: true, platform: 'openai', model: id }
  if (
    lower.startsWith('claude-') ||
    lower.startsWith('anthropic.claude-') ||
    /^(sonnet|opus|haiku)(-|$)/i.test(lower)
  ) {
    return { ok: true, platform: 'anthropic', model: id }
  }
  return { ok: false, code: 'model_not_supported', message: `model '${raw}' is not recognized` }
}

/**
 * 一步拿到「客户端请求的模型 + 实际发上游的模型 + 平台」。
 *
 * 顺序在这一层写死：**先重写，再判定**。调用方不要自己拆开重排，
 * 拆开的版本正是历史上 `codex-auto-review` 被判成未知模型的原因。
 *
 * @param {unknown} model
 * @param {object} [opts] 透传给 {@link applyCodexModelMapping} 的 `map`
 * @returns {{requestedModel:string, upstreamModel:string, mapped:boolean,
 *            platform:{ok:boolean, platform?:string, code?:string, model?:string}}}
 */
export function resolveCodexInboundModel(model, opts = {}) {
  const requestedModel = typeof model === 'string' ? model.trim() : ''
  const rewritten = applyCodexModelMapping(model, opts)
  const upstreamModel = typeof rewritten === 'string' ? rewritten.trim() : ''
  return {
    requestedModel,
    upstreamModel,
    mapped: Boolean(upstreamModel) && upstreamModel !== requestedModel,
    // 判定看的是重写后的 id —— 这是整个模块最要紧的一行
    platform: detectCodexPlatform(upstreamModel),
  }
}
