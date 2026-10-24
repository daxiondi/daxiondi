/**
 * 入站风险审计五关（进槽之前的拦截层）。
 *
 * 顺序固定，不能调换：
 *   1. 蒸馏检测      规则匹配，无外部依赖      403，并封 device
 *   2. 硬正则        规则匹配，无外部依赖      403
 *   3. 拒答缓存      本地 JSON + MinHash      400，不可重试
 *   4. 决策模型      外部打分服务              失败默认放行
 *   5. 放行出站      进入槽位
 *
 * 为什么是这个顺序：便宜的在前，贵的在后。前两关是纯内存正则，命中就结束；
 * 第 3 关要算签名，但仍在本地；第 4 关要发一次网络请求，放最后，前面的关
 * 已经拦掉的请求不会产生任何外部调用。调换任何两关都会让请求多付一次没必要的
 * 代价，或者让本该本地拦掉的内容打到上游。
 *
 * 拦住的请求不 hop，不消耗上游额度，也不留下风险标记。这就是「把所有环节信息
 * 都排除，避免封号」这一要求在入口处的落点。
 *
 * 关键约束：
 * 1. 每关可独立启用/停用。停用的关卡仍然占一个 stage 号，只是不参与判断，
 *    保证返回值里的 stage 含义稳定。
 * 2. 第 2 关的蒸馏类命中（category=distill）按第 1 关处理：返回 403 蒸馏文案
 *    并封 device。这是「关掉硬正则仍拦这些短语」那条语义的落点。
 * 3. 第 3 关的命中是 400 且不可重试。用 403 会让客户端误判成登录失效。
 * 4. 硬正则与决策模型的拦截不写入拒答缓存。写入只发生在上游真的拒过之后。
 * 5. 第 4 关打分失败默认放行，并在第 5 关的结果里标出来（pass_reason='fail-open'），
 *    方便看漏拦。
 */

import { detectDistill, distillErrorConfig, isOpenaiPlatformModel } from './distill.mjs'
import { matchHardPolicy, isDistillCategory } from './hard-policy.mjs'
import { RefusalCache, matchStoredRefusal } from './refusal-cache.mjs'
import { classifyJev, normalizeClassifierConfig } from './classifier.mjs'
import { prepareInbound } from './prepare.mjs'
import { RiskStats, STAGES } from './stats.mjs'

// ─────────────────────────────── 错误体

/** 错误类型。与 OpenAI / Anthropic 的 error.type 词汇一致。 */
export const ERROR_TYPES = Object.freeze({
  PERMISSION: 'permission_error',
  INVALID_REQUEST: 'invalid_request_error',
  POLICY_BLOCKED: 'policy_blocked',
})

/** 客户端可见的错误码。 */
export const ERROR_CODES = Object.freeze({
  DISTILL_BLOCKED: 'distill_blocked',
  POLICY_BLOCKED: 'policy_blocked',
  REFUSAL_GUARD: 'refusal_guard',
  CLASSIFIER_UNAVAILABLE: 'classifier_unavailable',
})

const DEFAULT_MESSAGES = Object.freeze({
  distill: '不允许蒸馏',
  hard_regex: '请求被协议拦截',
  refusal_cache:
    "Request blocked by the refusal guard. Anthropic's API previously refused this pattern.",
  classifier: '请求被协议拦截',
})

/**
 * 构造与 OpenAI / Anthropic 兼容的错误体。
 * 两边都是 `{ error: { type, code, message, details? } }`，只在个别字段上不同；
 * 这里给全公共字段，客户端按需取。
 */
export function makeRiskError({ status, type, code, message, details, requestId } = {}) {
  const error = {
    type: String(type || ERROR_TYPES.PERMISSION),
    code: String(code || ERROR_CODES.POLICY_BLOCKED),
    message: String(message || DEFAULT_MESSAGES.hard_regex),
  }
  if (details && Object.keys(details).length) error.details = details
  if (requestId) error.request_id = requestId
  return { status: Number(status) || 403, body: { error } }
}

/** 拒答缓存命中的文案：原文后面追加命中原因，不改原句。 */
export function refusalSuffix(match) {
  const kind = String(match?.kind || 'exact')
  if (kind === 'similar') {
    const score = Number(match?.similarity)
    const pct = Number.isFinite(score) ? Math.round(score * 100) : null
    return {
      message: pct == null ? ' 当前提示词与曾被拒答的内容相似。' : ` 当前提示词与曾被拒答的内容相似（相似度 ${pct}%）。`,
      details: Number.isFinite(score) ? { reason: 'similar', score } : { reason: 'similar' },
    }
  }
  if (kind === 'device') {
    const ban = String(match?.entry?.reason ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    return {
      message: ban ? ` 该设备此前已被封禁（${ban}）。` : ' 该设备此前已被封禁。',
      details: ban ? { reason: 'device', ban_reason: ban } : { reason: 'device' },
    }
  }
  return { message: ' 当前提示词与曾被拒答的内容完全一致。', details: { reason: 'exact' } }
}

/**
 * 各关命中的错误对象。这一类函数是错误格式的唯一来源，不要在别处拼字符串。
 */
export function stageError(stage, info = {}, requestId) {
  if (stage === 1) {
    const cfg = distillErrorConfig({ rules: info.rules })
    return makeRiskError({
      status: cfg.status,
      type: cfg.type,
      code: cfg.code,
      message: cfg.message,
      details: info.evidence ? { reason: 'distill', evidence: info.evidence } : { reason: 'distill' },
      requestId,
    })
  }
  if (stage === 2) {
    const label = info.label || info.category || ''
    const base = info.message || DEFAULT_MESSAGES.hard_regex
    return makeRiskError({
      status: 403,
      type: ERROR_TYPES.PERMISSION,
      code: ERROR_CODES.POLICY_BLOCKED,
      message: label ? `${base}: ${label}` : base,
      details: { reason: 'hard_regex', category: info.category || 'custom' },
      requestId,
    })
  }
  if (stage === 3) {
    const extra = refusalSuffix(info)
    return makeRiskError({
      // Claude Code 把 403 当登录失效；用不可重试的 400 表达策略拒绝。
      status: 400,
      type: ERROR_TYPES.POLICY_BLOCKED,
      code: ERROR_CODES.REFUSAL_GUARD,
      message: `${DEFAULT_MESSAGES.refusal_cache}${extra.message}`,
      details: { ...extra.details, retryable: false },
      requestId,
    })
  }
  const unavailable = info.reason === 'unavailable'
  const detail = String(info.detail ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  const tail = unavailable
    ? detail
      ? `: 决策模型不可用（${detail}）。本次请求已拦截，未封禁设备`
      : ': 决策模型不可用。本次请求已拦截，未封禁设备'
    : info.category
      ? `: ${info.category}`
      : ''
  return makeRiskError({
    status: 403,
    type: ERROR_TYPES.PERMISSION,
    code: unavailable ? ERROR_CODES.CLASSIFIER_UNAVAILABLE : ERROR_CODES.POLICY_BLOCKED,
    message: `${DEFAULT_MESSAGES.classifier}${tail}`,
    details: unavailable
      ? { reason: 'unavailable', ...(detail ? { detail } : {}) }
      : { reason: 'classifier', category: info.category || 'safety' },
    requestId,
  })
}

// ─────────────────────────────── 配置

/**
 * 五关总配置。
 *
 * stages：
 *   - enabled     本关总开关
 *   - 其余字段透传给对应模块
 */
export function defaultGateConfig() {
  return {
    // 每关的开关。默认全开，但第 4 关自身的 enabled 是 false，需显式接。
    stages: {
      1: { enabled: true },
      2: { enabled: true },
      3: { enabled: true },
      4: { enabled: true },
    },
    distill: { rules: null, rulesFile: '' },
    hardPolicy: { rules: null, file: '', hardRegexEnabled: true, extras: [] },
    refusal: { cache: null, file: '', similarity: 0.9, similarityEnabled: true },
    classifier: null,
    // 预处理开关属于全部五关共用，不挂在某一关下面。
    stripReminders: true,
    expandEncoded: true,
    stats: null,
    // 请求侧输入
    official: false,
    zeroInject: false,
    requestId: '',
  }
}

/**
 * 取本次请求使用的拒答缓存。
 * 传了实例就用实例；只配了文件路径时按路径构造，避免「配了却没生效」。
 * 都没配时返回 null，第 3 关按未接入处理。
 */
function resolveCache(given, refusalConfig) {
  if (given instanceof RefusalCache) return given
  if (refusalConfig?.cache instanceof RefusalCache) return refusalConfig.cache
  const file = String(refusalConfig?.file || '').trim()
  if (!file) return null
  return new RefusalCache({
    file,
    similarity: refusalConfig.similarity,
    similarityEnabled: refusalConfig.similarityEnabled,
  })
}

function stageEnabled(config, stage) {
  const row = config?.stages?.[stage]
  if (row == null) return true
  if (typeof row === 'boolean') return row
  return row.enabled !== false
}

// ─────────────────────────────── 主流程

function passResult(stage, code, message) {
  return {
    action: 'pass',
    stage,
    status: 200,
    code,
    message,
    retryable: false,
    stats: {},
  }
}

/**
 * 五关判定。不写拒答缓存、不改 device 状态——那些是 commit 阶段的事。
 *
 * @param {{
 *   body?: object, inbound?: object|null, headers?: object, request_id?: string,
 *   official?: boolean, zero_inject?: boolean,
 *   config?: object, stats?: RiskStats, cache?: RefusalCache,
 *   fetchImpl?: Function, now?: number,
 * }} ctx
 * @returns {Promise<{
 *   action: 'pass'|'block',
 *   stage: 1|2|3|4|5,
 *   status: number,
 *   code: string,
 *   message: string,
 *   retryable: boolean,
 *   stats: object,
 * }>}
 */
export async function evaluateInbound(ctx = {}) {
  const config = { ...defaultGateConfig(), ...(ctx.config || {}) }
  const stats = ctx.stats instanceof RiskStats ? ctx.stats : config.stats instanceof RiskStats ? config.stats : new RiskStats()
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {}
  const inbound = ctx.inbound && typeof ctx.inbound === 'object' ? ctx.inbound : null
  const requestId = String(ctx.request_id ?? config.requestId ?? '')

  const prepared = prepareInbound(body, {
    inbound,
    stripReminders: config.stripReminders !== false,
    expandEncoded: config.expandEncoded !== false,
  })
  const model = String(body.model ?? inbound?.model ?? '')
  const openaiPlatform = isOpenaiPlatformModel(model)

  // 没有任何可检测正文：直接出站，标记为无正文。
  if (!prepared.labeled.trim()) {
    stats.pass({ stage: 5, reason: 'empty' })
    return finish(
      { ...passResult(5, 'empty', passReasonLabelText('empty')), pass_reason: 'empty', suspicious: false },
      stats,
    )
  }

  // ── 第 1 关：蒸馏检测
  if (stageEnabled(config, 1)) {
    stats.enter(1)
    const distillRules = config.distill?.rules ?? null
    const hit = detectDistill(
      { latest: prepared.latest, joined: prepared.labeled, structure: prepared.structure },
      {
        rules: distillRules,
        rulesFile: config.distill?.rulesFile || '',
        official: ctx.official ?? config.official,
        zeroInject: ctx.zero_inject ?? config.zeroInject,
        model,
      },
    )
    if (hit.hit) {
      const evidence = hit.matched.map((item) => item.evidence).filter(Boolean).join(';')
      const error = stageError(1, { rules: distillRules, evidence }, requestId)
      const keyword = String(evidence || hit.kind).slice(0, 40)
      stats.block({ stage: 1, code: ERROR_CODES.DISTILL_BLOCKED, category: 'distill', keyword })
      return finish(
        {
          action: 'block',
          stage: 1,
          status: error.status,
          code: error.body.error.code,
          message: evidence ? `${error.body.error.message}: ${evidence}` : error.body.error.message,
          retryable: false,
          details: error.body.error.details,
          // 第 1 关命中要封 device：重复投递蒸馏请求本身就是风险信号。
          kind: 'distill',
          ban_device: true,
          remember: false,
          keyword,
          error,
        },
        stats,
      )
    }
  }

  // ── 第 2 关：硬正则
  if (stageEnabled(config, 2)) {
    stats.enter(2)
    const hp = config.hardPolicy || {}
    const distillOn = (config.distill?.rules?.enabled ?? true) !== false
    const matched = matchHardPolicy(prepared.user, {
      rules: hp.rules ?? null,
      extras: hp.extras ?? hp.patterns ?? null,
      hardRegexEnabled: hp.hardRegexEnabled !== false,
      distillEnabled: distillOn,
      openaiPlatform,
      official: ctx.official ?? config.official,
      zeroInject: ctx.zero_inject ?? config.zeroInject,
    })
    if (matched.hit) {
      // 蒸馏类短语在硬正则里也拦。文案与封禁语义按第 1 关走。
      if (isDistillCategory(matched.category)) {
        const error = stageError(1, { rules: config.distill?.rules ?? null, evidence: matched.keyword }, requestId)
        const keyword = String(matched.keyword || matched.category).slice(0, 40)
        stats.block({ stage: 2, code: ERROR_CODES.DISTILL_BLOCKED, category: 'distill', keyword })
        return finish(
          {
            action: 'block',
            stage: 2,
            status: error.status,
            code: error.body.error.code,
            message: `${error.body.error.message}: ${matched.keyword || matched.category}`,
            retryable: false,
            details: error.body.error.details,
            kind: 'distill',
            ban_device: true,
            remember: false,
            keyword,
            error,
          },
          stats,
        )
      }
      const error = stageError(2, { category: matched.category, label: matched.label }, requestId)
      const keyword = String(matched.keyword || matched.category).slice(0, 40)
      stats.block({ stage: 2, code: ERROR_CODES.POLICY_BLOCKED, category: matched.category, keyword })
      return finish(
        {
          action: 'block',
          stage: 2,
          status: error.status,
          code: error.body.error.code,
          message: error.body.error.message,
          retryable: false,
          details: error.body.error.details,
          kind: 'hard_regex',
          category: matched.category,
          // 硬正则命中不写入拒答缓存。
          remember: false,
          ban_device: true,
          keyword,
          error,
        },
        stats,
      )
    }
  }

  // ── 第 3 关：拒答缓存
  if (stageEnabled(config, 3)) {
    stats.enter(3)
    const cache = resolveCache(ctx.cache, config.refusal)
    if (cache) {
      const match = matchStoredRefusal(prepared.user, {
        cache,
        model,
        similarity: config.refusal?.similarity,
        similarityEnabled: config.refusal?.similarityEnabled,
      })
      if (match.hit) {
        const error = stageError(3, match, requestId)
        const keyword = match.kind === 'similar' ? `similar:${Math.round(match.similarity * 100)}%` : match.kind
        stats.block({
          stage: 3,
          code: ERROR_CODES.REFUSAL_GUARD,
          category: match.kind,
          keyword,
        })
        return finish(
          {
            action: 'block',
            stage: 3,
            status: error.status,
            code: error.body.error.code,
            message: error.body.error.message,
            // 不可自动重试：同一段正文重发仍是同一个结论。
            retryable: false,
            details: error.body.error.details,
            kind: match.kind === 'similar' ? 'similar' : 'exact',
            similarity: match.similarity,
            entry: match.entry,
            remember: false,
            ban_device: false,
            keyword,
            error,
          },
          stats,
        )
      }
    }
  }

  // ── 第 4 关：决策模型
  let classifierVerdict = null
  if (stageEnabled(config, 4)) {
    stats.enter(4)
    const classifierConfig = normalizeClassifierConfig(config.classifier || {})
    if (classifierConfig.enabled) {
      classifierVerdict = await classifyJev(prepared.labeled, classifierConfig, {
        fetchImpl: ctx.fetchImpl,
        now: ctx.now,
      })
      if (classifierVerdict.blocked) {
        const unavailable = classifierVerdict.reason === 'unavailable'
        const error = stageError(
          4,
          { reason: classifierVerdict.reason, detail: classifierVerdict.detail, category: classifierVerdict.category },
          requestId,
        )
        const keyword = unavailable ? 'unavailable' : classifierVerdict.category || 'safety'
        stats.block({
          stage: 4,
          code: error.body.error.code,
          category: unavailable ? 'unavailable' : classifierVerdict.category || 'safety',
          keyword,
        })
        return finish(
          {
            action: 'block',
            stage: 4,
            status: error.status,
            code: error.body.error.code,
            message: error.body.error.message,
            retryable: false,
            details: error.body.error.details,
            kind: 'classifier',
            category: keyword,
            score: classifierVerdict.score,
            // 决策模型自己的拦截同样不写入拒答缓存。
            remember: false,
            ban_device: !unavailable,
            keyword,
            error,
          },
          stats,
        )
      }
    }
  }

  // ── 第 5 关：放行出站
  // 第 4 关只有在「打分失败仍放行」时才是可疑放行；replay 与 safe 都是正常出口。
  const passReason = classifierVerdict?.reason === 'fail-open' ? 'fail-open' : openaiPlatform ? 'openai_platform' : 'clean'
  stats.pass({ stage: 5, reason: passReason })
  return finish(
    {
      ...passResult(5, passReason, passReasonLabelText(passReason)),
      classifier: classifierVerdict,
      // 第 5 关把「没被闸拦住但结果异常」的放行标出来，用于看漏拦。
      suspicious: passReason === 'fail-open',
      pass_reason: passReason,
    },
    stats,
  )
}

function passReasonLabelText(reason) {
  if (reason === 'fail-open') return '决策模型打分失败，已放行'
  if (reason === 'openai_platform') return 'OpenAI 平台模型不接入本闸'
  if (reason === 'empty') return '无待检测正文'
  return '各关均未命中，放行出站'
}

function finish(result, stats) {
  return { ...result, stats: stats.snapshot() }
}

/**
 * 判定 + 落地副作用。命中即写计数；蒸馏命中标记设备封禁（由调用方执行）。
 * 拦截结果里的 `commit` 说明调用方该做什么。
 */
export async function runInboundGate(ctx = {}) {
  const decision = await evaluateInbound(ctx)
  if (decision.action !== 'block') return decision
  return {
    ...decision,
    commit: {
      ban_device: decision.ban_device === true,
      remember: decision.remember === true,
      kind: decision.kind || '',
      keyword: decision.keyword || '',
    },
  }
}

/** 关卡清单，供面板与文档使用。 */
export function listStages() {
  return STAGES.map((item) => ({ ...item }))
}
