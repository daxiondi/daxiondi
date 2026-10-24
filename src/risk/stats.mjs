/**
 * 风险审计统计。
 *
 * 职责：记下每个请求过了哪一关、命中什么、为什么放行。拦截流水与「放行出站」
 * 两类记录都从这里出，面板按它聚合。
 *
 * 关键约束：
 * 1. 计数只在内存里累计，进程重启即清零。这里不做持久化——统计写失败绝不能
 *    影响拦截判断，而落盘一定会带来写失败的可能。
 * 2. 记录是定长结构，不塞整段正文。命中的证据只留前 40 字符，避免把用户正文
 *    抄进日志。
 * 3. 第 5 关不是闸，是放行出口。它要额外记两类「没被闸拦住但结果异常」的
 *    请求：决策模型打分失败后的放行，以及疑似上游拒答的放行，用来看漏拦。
 */

/** 关卡名。顺序即闸的编号，不要重排。 */
export const STAGES = Object.freeze([
  { stage: 1, key: 'distill', label: '蒸馏' },
  { stage: 2, key: 'hard_regex', label: '硬正则' },
  { stage: 3, key: 'refusal_cache', label: '拒答缓存' },
  { stage: 4, key: 'classifier', label: '决策模型' },
  { stage: 5, key: 'egress', label: '放行出站' },
])

/** 放行的原因。第 5 关按这些值区分「正常放行」与「放行但可疑」。 */
export const PASS_REASONS = Object.freeze({
  clean: '各关均未命中',
  empty: '无待检测正文',
  disabled: '关卡已停用',
  openai_platform: 'OpenAI 平台未接入',
  unchecked: '未检查',
  fail_open: '模型故障放行',
  upstream_refusal: '疑似上游拒答放行',
  dedup: '正文未变化',
})

/** 拦截槽位名 → 面板标签。 */
const BLOCK_LABELS = Object.freeze({
  distill: '蒸馏',
  hard_regex: '硬正则',
  refusal_cache: '拒答缓存',
  classifier: '决策模型',
  hard_regex_distill: '蒸馏（硬正则）',
})

function blankCounter() {
  return { checked: 0, blocked: 0, passed: 0 }
}

/** 放行出口的计数器要按原因分组，因此比通用计数器多一个 by_reason。 */
function blankPassCounter() {
  return { checked: 0, blocked: 0, passed: 0, by_reason: {} }
}

function blankStage() {
  return { ...blankCounter(), by_reason: {}, by_category: {}, by_keyword: {} }
}

/**
 * 计数器。每个 gate 实例可以带自己的，测试之间不串味。
 */
export class RiskStats {
  constructor() {
    this.startedAt = Date.now()
    this.total = blankCounter()
    /** @type {Record<number, ReturnType<typeof blankStage>>} */
    this.stages = {}
    for (const item of STAGES) this.stages[item.stage] = blankStage()
    this.passes = blankPassCounter()
    this.suspicious = { fail_open: 0, upstream_refusal: 0 }
    /** @type {Array<{ at: number, stage: number, action: string, code: string, keyword: string }>} */
    this.recent = []
  }

  #bump(bucket, key) {
    if (!key) return
    bucket[key] = (bucket[key] || 0) + 1
  }

  /** 某关被检查了一次（无论结果）。 */
  enter(stage) {
    const row = this.stages[stage]
    if (!row) return
    row.checked += 1
    this.total.checked += 1
  }

  /**
   * 记一次拦截。
   * @param {{ stage: number, code: string, category?: string, keyword?: string }} event
   */
  block(event = {}) {
    const row = this.stages[event.stage]
    if (!row) return
    row.blocked += 1
    this.total.blocked += 1
    this.#bump(row.by_category, event.category)
    this.#bump(row.by_keyword, String(event.keyword || '').slice(0, 40))
    this.push({ stage: event.stage, action: 'block', code: event.code, keyword: event.keyword })
  }

  /**
   * 记一次放行。
   * @param {{ stage: number, reason: string, keyword?: string }} event
   */
  pass(event = {}) {
    const row = this.stages[event.stage]
    if (!row) return
    row.passed += 1
    this.total.passed += 1
    this.passes.passed += 1
    this.#bump(row.by_reason, event.reason)
    this.#bump(this.passes.by_reason, event.reason)
    if (event.reason === 'fail-open') this.suspicious.fail_open += 1
    if (event.reason === 'upstream_refusal') this.suspicious.upstream_refusal += 1
    this.push({ stage: event.stage, action: 'pass', code: event.reason, keyword: event.keyword })
  }

  /** 最近事件环形缓冲。给 demo 与排障看判定顺序。 */
  push(event) {
    this.recent.push({ at: Date.now(), ...event })
    if (this.recent.length > 200) this.recent.splice(0, this.recent.length - 200)
  }

  /** 面板用的汇总。数值型字段在前，聚合字段在后。 */
  snapshot() {
    const stages = {}
    for (const item of STAGES) {
      const row = this.stages[item.stage]
      stages[item.key] = {
        stage: item.stage,
        label: item.label,
        checked: row.checked,
        blocked: row.blocked,
        passed: row.passed,
        by_reason: { ...row.by_reason },
        by_category: { ...row.by_category },
        by_keyword: { ...row.by_keyword },
      }
    }
    return {
      total: { ...this.total },
      passes: { ...this.passes, by_reason: { ...this.passes.by_reason } },
      suspicious: { ...this.suspicious },
      stages,
      blocks: this.blockSummary(),
      uptime_ms: Date.now() - this.startedAt,
    }
  }

  /** 拦截按「关 + 类别 + 命中词」聚合，计数高的在前。 */
  blockSummary() {
    const rows = []
    for (const item of STAGES) {
      if (item.stage === 5) continue
      const row = this.stages[item.stage]
      if (!row.blocked) continue
      rows.push({
        stage: item.stage,
        by: item.key,
        label: BLOCK_LABELS[item.key] || item.label,
        count: row.blocked,
        keywords: Object.entries(row.by_keyword)
          .map(([keyword, count]) => ({ keyword, count }))
          .sort((a, b) => b.count - a.count || a.keyword.localeCompare(b.keyword))
          .slice(0, 10),
      })
    }
    return rows.sort((a, b) => b.count - a.count || a.stage - b.stage)
  }

  /** 清空。测试与热重载用。 */
  reset() {
    this.startedAt = Date.now()
    this.total = blankCounter()
    for (const item of STAGES) this.stages[item.stage] = blankStage()
    this.passes = blankPassCounter()
    this.suspicious = { fail_open: 0, upstream_refusal: 0 }
    this.recent = []
    return this
  }
}

/** 标签查询。未知键原样返回，面板不至于显示空白。 */
export function stageLabel(stage) {
  const item = STAGES.find((row) => row.stage === Number(stage))
  return item ? item.label : String(stage)
}

/**
 * 放行原因的中文说明。内部用下划线、面板与日志里两种写法都出现过，
 * 这里统一折叠成下划线再查表。
 */
export function passReasonLabel(reason) {
  const key = String(reason ?? '')
    .trim()
    .replace(/-/g, '_')
  return PASS_REASONS[key] || String(reason ?? '未记录')
}

/** 拦截来源的标签。 */
export function blockLabel(key) {
  return BLOCK_LABELS[String(key ?? '')] || String(key ?? '其他')
}
