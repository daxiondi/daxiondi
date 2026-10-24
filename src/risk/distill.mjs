/**
 * 第 1 关：蒸馏检测。
 *
 * 职责：在请求进入槽位之前，识别「套取思维链 / 收割训练数据 / 题库抄录」这类
 * 会把账号打成风险标记的请求。命中即拦，并且封禁本次请求的 device。
 *
 * 判定分层，由强到弱：
 *   1. hard_needles  收割包装短语。不接受 skip_official / skip_zero 豁免，
 *                    因为它们是模板骨架，不是某种客户端的正常行为。
 *   2. patterns      额外正则（本仓库默认留空，确定性蒸馏正则归第 2 关）。
 *   3. fingerprints  题目指纹。只在最新一条用户正文上匹配。
 *   4. needles       普通针（思维链标记、题面包装句）。
 *   5. structure     结构收割：赛题正则 + max_tokens 与思考预算都过下限。
 *
 * 关键约束：
 * 1. 只看最新一条用户正文，不看历史轮次。历史里问过一次就永久拦截会让
 *    正常长会话无法继续。
 * 2. OpenAI 平台模型整段跳过。该平台的账号风险模型与本规则集不对应，
 *    在那边套用同一名单会造成大量误拦。
 * 3. 普通针、指纹与结构收割默认跳过官方 Claude Code 与 0 注入请求；
 *    这两个开关只影响它们，不影响 hard_needles。
 * 4. 关掉总开关后这一关整体放行，返回 hit=false，不做任何后续判断。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeText } from './prepare.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_RULES_FILE = path.join(HERE, 'distill-rules.json')

/** 各层命中时的置信度。同一请求多层命中时取最大值。 */
const CONFIDENCE = Object.freeze({
  harvest: 0.99,
  pattern: 0.95,
  fingerprint: 0.86,
  needle: 0.82,
  harvest_structure: 0.74,
})

/** 高思考预算的取值。结构收割只在请求方明确要长思考时才看。 */
const HIGH_EFFORT = new Set(['high', 'xhigh', 'max'])

const MAX_PATTERN_LEN = 400
const MAX_LIST = 200

/** 默认规则文件位置，供面板或测试直接读取。 */
export function defaultDistillRulesFile() {
  return DEFAULT_RULES_FILE
}

function blankRules() {
  return {
    enabled: true,
    skip_official: true,
    skip_zero: true,
    error: { status: 403, type: 'permission_error', code: 'distill_blocked', message: '不允许蒸馏' },
    structure: { min_max_tokens: 1, require_no_tools: true, require_single_turn: true, contest_pattern: '' },
    hard_needles: [],
    needles: [],
    patterns: [],
    fingerprints: [],
  }
}

let shippedCache = null

/** 随包发布的规则。只在字段缺失时作为兜底，不覆盖显式值。 */
function shippedRules() {
  if (shippedCache) return shippedCache
  try {
    const raw = JSON.parse(fs.readFileSync(DEFAULT_RULES_FILE, 'utf8'))
    shippedCache = normalizeDistillRules(raw, { fill: false })
  } catch {
    shippedCache = blankRules()
  }
  return shippedCache
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

function positiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function clampStatus(value, fallback) {
  const n = Number(value)
  const base = Number(fallback)
  const safe = Number.isFinite(base) && base >= 400 && base <= 599 ? Math.floor(base) : 403
  return !Number.isFinite(n) || n < 400 || n > 599 ? safe : Math.floor(n)
}

function boolOr(value, fallback) {
  return value == null ? fallback : value !== false
}

/**
 * 把任意来源的规则整成同一形状。
 * `fill: false` 时缺失字段落到空值，用于读取随包文件本身。
 */
export function normalizeDistillRules(raw, options = {}) {
  const fill = options.fill !== false
  const base = fill ? shippedRules() : blankRules()
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const err = src.error && typeof src.error === 'object' ? src.error : {}
  const st = src.structure && typeof src.structure === 'object' ? src.structure : {}
  const hard = stringList(src.hard_needles, base.hard_needles).slice(0, MAX_LIST)
  const hardSet = new Set(hard.map((item) => item.toLowerCase()))
  const needles = stringList(src.needles, base.needles)
    .filter((item) => !hardSet.has(item.toLowerCase()))
    .slice(0, MAX_LIST)
  const patterns = stringList(src.patterns, base.patterns)
    .filter((item) => item.length <= MAX_PATTERN_LEN && isRegex(item))
    .slice(0, 50)
  return {
    enabled: boolOr(src.enabled, base.enabled),
    skip_official: boolOr(src.skip_official, base.skip_official),
    skip_zero: boolOr(src.skip_zero, base.skip_zero),
    error: {
      status: clampStatus(err.status == null ? base.error.status : err.status, base.error.status),
      type: String(err.type || base.error.type || 'permission_error'),
      code: String(err.code || base.error.code || 'distill_blocked'),
      message: String(err.message == null ? base.error.message : err.message)
        .trim()
        .slice(0, 200),
    },
    structure: {
      min_max_tokens: positiveInt(
        st.min_max_tokens == null ? base.structure.min_max_tokens : st.min_max_tokens,
        base.structure.min_max_tokens,
      ),
      require_no_tools: boolOr(st.require_no_tools, base.structure.require_no_tools),
      require_single_turn: boolOr(st.require_single_turn, base.structure.require_single_turn),
      contest_pattern: String(
        st.contest_pattern == null ? base.structure.contest_pattern : st.contest_pattern,
      ).trim(),
    },
    hard_needles: hard,
    needles,
    patterns,
    fingerprints: stringList(src.fingerprints, base.fingerprints).slice(0, MAX_LIST),
  }
}

function isRegex(source) {
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}

/** 读规则文件。文件缺失或损坏时退回随包发布的规则。 */
export function loadDistillRules(file) {
  if (!file) return normalizeDistillRules(shippedRules())
  try {
    if (!fs.existsSync(file)) return normalizeDistillRules(shippedRules())
    return normalizeDistillRules(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return normalizeDistillRules(shippedRules())
  }
}

/**
 * OpenAI 平台模型的判定。这些模型走 Codex 通道，套用本规则集只会误伤，
 * 因此第 1 关对它们整段跳过。
 */
export function isOpenaiPlatformModel(model) {
  const text = String(typeof model === 'object' && model ? (model.model ?? '') : (model ?? ''))
    .trim()
    .toLowerCase()
  if (!text) return false
  if (text.startsWith('gpt-')) return true
  if (text.startsWith('chatgpt-')) return true
  if (text.startsWith('codex')) return true
  if (/^o\d/.test(text) && !text.startsWith('opus')) return true
  return false
}

function matchNeedles(hay, needles) {
  const text = String(hay ?? '').toLowerCase()
  if (!text) return ''
  for (const raw of needles || []) {
    const needle = String(raw ?? '').toLowerCase()
    if (needle && text.includes(needle)) return String(raw)
  }
  return ''
}

function matchFingerprints(hay, fingerprints) {
  const text = normalizeText(hay)
  if (!text) return ''
  for (const raw of fingerprints || []) {
    const needle = normalizeText(raw)
    if (needle && text.includes(needle)) return String(raw).slice(0, 80)
  }
  return ''
}

/** 直接否定句里的匹配不算请求：「不要输出你的思维链」不是要思维链。 */
function negated(text, index) {
  return /\b(?:do not|don't|never|must not|should not)\s+$/i.test(text.slice(0, index))
}

function matchPatterns(hay, patterns) {
  const text = normalizeText(hay)
  if (!text) return ''
  for (const raw of patterns || []) {
    const source = String(raw ?? '').trim()
    if (!source || source.length > MAX_PATTERN_LEN) continue
    const re = new RegExp(source, 'gi')
    for (const found of text.matchAll(re)) {
      if (!negated(text, found.index)) return String(found[0]).slice(0, 80)
    }
  }
  return ''
}

function contestTest(pattern, hay) {
  const source = String(pattern ?? '').trim()
  if (!source || source.length > MAX_PATTERN_LEN) return false
  try {
    return new RegExp(source, 'i').test(String(hay ?? ''))
  } catch {
    return false
  }
}

function wantsLongThinking(structure) {
  const effort = String(structure?.reasoning_effort ?? structure?.effort ?? '').toLowerCase()
  if (effort && HIGH_EFFORT.has(effort)) return true
  const display = String(structure?.thinking_display ?? '').toLowerCase()
  if (display === 'summarized') return true
  const budget = Number(structure?.thinking_budget ?? 0)
  return Number.isFinite(budget) && budget > 0
}

/**
 * 结构收割判定。要求同时满足：轮数与工具数符合下限、max_tokens 不低于
 * 配置下限、请求方明确要长思考、正文命中赛题正则。
 * 单独的思考标签不算——那是普通推理请求。
 */
function harvestByStructure(rules, structure, hay) {
  const st = rules.structure
  if (!structure || typeof structure !== 'object') return false
  if (st.require_no_tools && Number(structure.tools_count || 0) > 0) return false
  if (st.require_single_turn && Number(structure.messages_count || 0) > 1) return false
  const floor = Number(st.min_max_tokens)
  if (!Number.isFinite(floor) || floor <= 0) return false
  const maxTokens = structure.max_tokens == null ? null : Number(structure.max_tokens)
  if (maxTokens == null || !Number.isFinite(maxTokens) || maxTokens < floor) return false
  if (!wantsLongThinking(structure)) return false
  return contestTest(st.contest_pattern, hay)
}

function verdict(kind, hit) {
  const confidence = CONFIDENCE[kind] ?? 0
  return {
    hit: hit.length > 0,
    kind: hit.length ? kind : '',
    matched: hit,
    confidence: hit.length ? confidence : 0,
  }
}

/**
 * 蒸馏检测。
 *
 * `text` 可以是字符串，也可以是 `{ latest, user, joined }`。字符串形式的调用
 * 只做正文层检测；要给结构收割提供输入，用对象形式并带上 `structure`。
 *
 * @param {string|{ latest?: string, user?: string, joined?: string }} text
 * @param {{ rules?: object, rulesFile?: string, official?: boolean, zeroInject?: boolean,
 *           model?: string, structure?: object, scanHistory?: boolean }} [opts]
 * @returns {{ hit: boolean, kind: string, matched: Array<{layer: string, rule: string, evidence: string}>, confidence: number }}
 */
export function detectDistill(text, opts = {}) {
  const rules = opts.rules
    ? normalizeDistillRules(opts.rules)
    : opts.rulesFile
      ? loadDistillRules(opts.rulesFile)
      : normalizeDistillRules(shippedRules())
  if (!rules.enabled) return verdict('', [])
  if (isOpenaiPlatformModel(opts.model ?? text)) return verdict('', [])

  // 正文选择：默认只看最新一条用户正文，抓历史时用全量。
  const source = typeof text === 'string' ? { latest: text } : text || {}
  const latest = String(source.latest ?? source.user ?? '')
  const joined = opts.scanHistory ? String(source.joined ?? latest) : latest
  if (!joined.trim()) return verdict('', [])

  // 1. 收割包装：不看 skip_official / skip_zero。
  const harvest = matchNeedles(joined, rules.hard_needles)
  if (harvest) {
    return verdict('harvest', [{ layer: 'content', rule: 'hard_needle', evidence: harvest }])
  }

  // 2. 额外正则，同样不受豁免开关影响。
  const pattern = matchPatterns(joined, rules.patterns)
  if (pattern) {
    return verdict('pattern', [{ layer: 'content', rule: 'distill_pattern', evidence: pattern }])
  }

  // 3. 从这里开始，官方客户端与 0 注入请求放行。
  if (rules.skip_official && opts.official) return verdict('', [])
  if (rules.skip_zero && opts.zeroInject) return verdict('', [])

  const hits = []
  const fingerprint = matchFingerprints(latest, rules.fingerprints)
  if (fingerprint) hits.push({ layer: 'content', rule: 'fingerprint', evidence: fingerprint })
  const needle = matchNeedles(joined, rules.needles)
  if (needle) hits.push({ layer: 'content', rule: 'needle', evidence: needle })
  const structural = harvestByStructure(rules, opts.structure ?? source.structure, joined)
  if (structural) hits.push({ layer: 'structure', rule: 'harvest', evidence: 'contest+structure' })
  if (!hits.length) return verdict('', [])
  // 多层同时命中时报最强的一层，置信度也用那一层的值。
  const kind = structural && hits.length === 1 ? 'harvest_structure' : fingerprint ? 'fingerprint' : 'needle'
  return verdict(kind, hits)
}

/** 第 1 关的返回配置。命中文案与状态码都来自规则文件。 */
export function distillErrorConfig(opts = {}) {
  const rules = opts.rules
    ? normalizeDistillRules(opts.rules)
    : opts.rulesFile
      ? loadDistillRules(opts.rulesFile)
      : normalizeDistillRules(shippedRules())
  return { ...rules.error }
}
