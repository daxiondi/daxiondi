/**
 * 第 2 关：硬正则。
 *
 * 职责：用确定性正则拦掉明显不该发往上游的请求——色情、破解、破限，
 * 以及蒸馏类短语。这一关不依赖任何外部服务，因此排在第 1 关之后、
 * 拒答缓存之前：比它便宜的只有蒸馏名单匹配，比它可靠的都不如它。
 *
 * 类别与开关联动（这层最容易写错的地方）：
 *   - nsfw / crack / jailbreak / custom：跟 hard_regex_enabled。
 *   - distill：跟蒸馏总开关（distillEnabled）。关掉硬正则总开关仍然拦这些
 *     短语，只有关掉蒸馏总开关才放行。
 *   - 蒸馏类同时不看 skip_official / skip_zero，官方客户端与 0 注入请求照样扫。
 *   - OpenAI 平台模型不扫蒸馏类，其余类别照扫。
 *
 * 关键约束：
 * 1. 扫的是用户自己写下的正文，不含 tool_result / function_call_output。
 *    工具回传里引用的文件内容、命令输出和上游规则原文不是请求意图，
 *    扫它会把正常的编码会话全部拦掉。
 * 2. rules 传空数组或 null 时回落内置规则；要关这一层用 hard_regex_enabled，
 *    不要用空数组——否则面板显示「硬正则开着」但实际没有规则。
 * 3. 规则顺序即优先级，先命中先返回。自定义规则追加在内置规则之后。
 * 4. 命中结果不写入拒答缓存。否则一次误判会让同一段正文永久无法再发。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_POLICY_FILE = path.join(HERE, 'hard-policy.json')

/** 允许的类别。未知类别一律归到 custom。 */
export const HARD_CATEGORIES = Object.freeze(['nsfw', 'distill', 'crack', 'jailbreak', 'custom'])

/** 这些类别受蒸馏总开关控制，而不是硬正则总开关。 */
export const DISTILL_CATEGORIES = Object.freeze(['distill'])

const MAX_RULES = 60
const MAX_PATTERN_LEN = 400
const MAX_EXTRA = 50

/** 内置规则。类别 + 正则 + 可选标签；标签只用于文案。 */
export const HARD_POLICY_RULES = Object.freeze([
  { category: 'jailbreak', source: String.raw`\b(?:jailbreak|dan)\s+mode\b`, label: 'jailbreak mode' },
  {
    category: 'jailbreak',
    source: String.raw`\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules|prompts)\b`,
    label: 'ignore previous instructions',
  },
  {
    category: 'jailbreak',
    source: String.raw`\b(?:bypass|disable|remove)\s+(?:your\s+|the\s+|all\s+)?(?:safety|content)\s+(?:filters?|policies|restrictions|limits)\b`,
    label: 'bypass safety filters',
  },
  {
    category: 'jailbreak',
    source: String.raw`(?:解除|关闭|绕过|无视)(?:你的|所有|全部)?(?:安全|内容)?(?:限制|审查|过滤|策略)`,
    label: '解除安全限制',
  },
  { category: 'jailbreak', source: String.raw`(?:越狱|破限)(?:模式|提示词|提示|指令)`, label: '越狱模式' },
  { category: 'crack', source: String.raw`(?<![\w-])(?:keygen|warez)(?![\w-])`, label: 'keygen / warez' },
  { category: 'crack', source: String.raw`(?:破解补丁|注册机|激活码生成器)`, label: '破解工具' },
  {
    category: 'crack',
    source: String.raw`\bcrack(?:ing)?\s+(?:this\s+|the\s+)?(?:software|license|drm|activation)\b`,
    label: 'crack software',
  },
  {
    category: 'nsfw',
    source: String.raw`\b(?:write|generate|describe)\s+(?:an?\s+)?(?:explicit|pornographic)\s+(?:sex|sexual)\b`,
    label: 'explicit sexual writing',
  },
  { category: 'nsfw', source: String.raw`(?:生成|写一段|描述)(?:露骨|色情)(?:内容|小说|场景)`, label: '露骨内容' },
  {
    category: 'distill',
    source: String.raw`\bdistill(?:ation|ing)?\s+(?:of\s+)?(?:(?:the|your|a|an|reusable|durable|rollout|hidden|internal|full|complete)\s+)?(?:reasoning(?:\s+traces?)?|chain[- ]of[- ]thoughts?|teacher(?:\s+model)?)\b`,
    label: 'distill reasoning',
  },
  {
    category: 'distill',
    source: String.raw`\b(?:extract|export|dump|reveal|harvest|exfiltrate)(?:ing|ed|ion|s)?\s+(?:(?:the|your|a|an|full|hidden|internal|complete|raw|durable|entire)\s+){0,4}(?:chain[- ]of[- ]thoughts?|reasoning\s+traces?|hidden\s+reasoning|internal\s+reasoning|internal\s+monologues?)\b`,
    label: 'extract reasoning trace',
  },
  {
    category: 'distill',
    source: String.raw`\b(?:chain[- ]of[- ]thought|reasoning\s+trace)\s+extraction\b`,
    label: 'reasoning trace extraction',
  },
  { category: 'distill', source: String.raw`(?:思维链蒸馏|推理蒸馏|思考链蒸馏)`, label: '思维链蒸馏' },
  {
    category: 'distill',
    source: String.raw`(?:提取|导出|抽取|蒸馏|收割|扒取)\s*(?:出|取)?\s*(?:你的|本人的|完整|全部|隐藏|内部)?\s*(?:的)?\s*(?:思维链|思考链|推理链)`,
    label: '提取思维链',
  },
  {
    category: 'distill',
    source: String.raw`(?:思维链|思考链|推理链)\s*(?:的)?\s*(?:提取|导出|抽取|蒸馏|收割)`,
    label: '思维链导出',
  },
  {
    category: 'distill',
    source: String.raw`(?:提取|导出|抽取)\s*(?:出)?\s*(?:隐藏|内部)\s*(?:的)?\s*(?:推理|思维|思考)`,
    label: '提取内部推理',
  },
  { category: 'custom', source: String.raw`\bphishing\s+kit\b`, label: 'phishing kit' },
])

/** 默认规则文件位置。 */
export function defaultPolicyFile() {
  return DEFAULT_POLICY_FILE
}

function isRegex(source) {
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}

/** 正则字符串清洗：去空白、限长、验证可编译。无效返回空串。 */
export function cleanPattern(source) {
  const text = String(source ?? '').trim()
  if (!text || text.length > MAX_PATTERN_LEN) return ''
  return isRegex(text) ? text : ''
}

function normalizeCategory(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
  return HARD_CATEGORIES.includes(text) ? text : 'custom'
}

/** 随包发布的规则文件内容；读取失败时用内置常量。 */
export function shippedPolicy() {
  try {
    if (fs.existsSync(DEFAULT_POLICY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DEFAULT_POLICY_FILE, 'utf8'))
      const rules = normalizeRules(raw?.rules)
      if (rules.length) {
        return { enabled: raw?.enabled !== false, rules, patterns: normalizeExtras(raw?.patterns) }
      }
    }
  } catch {
    /* 落到内置常量 */
  }
  return { enabled: true, rules: builtinRules(), patterns: [] }
}

/** 内置规则整成可配置形状。 */
export function builtinRules() {
  return HARD_POLICY_RULES.map((rule) => ({
    category: rule.category,
    source: rule.source,
    label: rule.label || '',
    enabled: true,
  }))
}

function normalizeRules(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const source = cleanPattern(item.source)
    if (!source || seen.has(source) || out.length >= MAX_RULES) continue
    seen.add(source)
    out.push({
      category: normalizeCategory(item.category),
      source,
      label: String(item.label ?? '')
        .trim()
        .slice(0, 40),
      enabled: item.enabled !== false,
    })
  }
  return out
}

function normalizeExtras(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const source = cleanPattern(item)
    if (!source || seen.has(source) || out.length >= MAX_EXTRA) continue
    seen.add(source)
    out.push(source)
  }
  return out
}

/** 读规则文件。文件缺失或损坏时退回内置规则。 */
export function loadHardPolicy(file) {
  if (!file) return shippedPolicy()
  try {
    if (!fs.existsSync(file)) return shippedPolicy()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const rules = normalizeRules(raw?.rules)
    return {
      enabled: raw?.enabled !== false,
      rules: rules.length ? rules : builtinRules(),
      patterns: normalizeExtras(raw?.patterns),
    }
  } catch {
    return shippedPolicy()
  }
}

/**
 * 选出本次请求该跑哪些规则。
 *
 * 这份过滤是所有开关联动的唯一实现，网关与测试都从这里走，不要在各处重写。
 *
 * @param {{ rules?: Array, extras?: Array, hardRegexEnabled?: boolean,
 *           distillEnabled?: boolean, openaiPlatform?: boolean, official?: boolean }} opts
 * @returns {{ rules: Array, extras: Array }}
 */
export function selectRules(opts = {}) {
  const hardOn = opts.hardRegexEnabled !== false
  const distillOn = opts.distillEnabled !== false
  const openai = opts.openaiPlatform === true
  // 空数组与 null 都回落内置规则：面板显示「硬正则开着」时不能没有规则可跑。
  const base = Array.isArray(opts.rules) && opts.rules.length ? opts.rules : builtinRules()
  const rules = base.filter((rule) => {
    if (!rule || rule.enabled === false) return false
    const category = normalizeCategory(rule.category)
    if (DISTILL_CATEGORIES.includes(category)) {
      // 蒸馏类跟蒸馏总开关；关掉硬正则不放开它们，OpenAI 平台仍跳过。
      return distillOn && !openai
    }
    return hardOn
  })
  // 自定义附加正则跟硬正则总开关；受蒸馏开关影响的是内置 distill 类别。
  const extras = hardOn ? normalizeExtras(opts.extras) : []
  return { rules, extras }
}

function compile(rule) {
  const source = cleanPattern(rule.source)
  if (!source) return null
  try {
    return {
      category: normalizeCategory(rule.category),
      source,
      label: String(rule.label ?? '').trim(),
      re: new RegExp(source, 'i'),
    }
  } catch {
    return null
  }
}

/**
 * 硬正则匹配。
 *
 * @param {string} text 用户正文（不含工具回传）
 * @param {{ rules?: Array, extras?: Array, hardRegexEnabled?: boolean, distillEnabled?: boolean,
 *           openaiPlatform?: boolean, official?: boolean, zeroInject?: boolean,
 *           patterns?: Array, max?: number }} [opts]
 * @returns {{ hit: boolean, category: string, pattern: string, keyword: string, label: string }}
 */
export function matchHardPolicy(text, opts = {}) {
  const empty = { hit: false, category: '', pattern: '', keyword: '', label: '' }
  const hay = String(text ?? '')
  if (!hay.trim()) return empty
  // patterns 是 extras 的历史别名，面板两种字段名都发过。
  const extras = Array.isArray(opts.extras) ? opts.extras : Array.isArray(opts.patterns) ? opts.patterns : []
  const picked = selectRules({ ...opts, extras })
  const compiled = []
  for (const rule of picked.rules) {
    const item = compile(rule)
    if (item) compiled.push(item)
  }
  for (const source of picked.extras) {
    const item = compile({ category: 'custom', source, label: '' })
    if (item) compiled.push(item)
  }
  const max = Number.isFinite(Number(opts.max)) && Number(opts.max) > 0 ? Number(opts.max) : compiled.length
  for (const rule of compiled.slice(0, max)) {
    const found = rule.re.exec(hay)
    if (!found) continue
    const keyword = String(found[0] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40)
    return {
      hit: true,
      category: rule.category,
      pattern: rule.source.slice(0, 200),
      keyword: keyword || rule.label || rule.category,
      label: rule.label,
    }
  }
  return empty
}

/** 命中的类别是否属于蒸馏族。第 1 关的返回文案与封禁语义要看这个。 */
export function isDistillCategory(category) {
  return DISTILL_CATEGORIES.includes(normalizeCategory(category))
}
