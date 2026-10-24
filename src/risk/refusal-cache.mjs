/**
 * 第 3 关：拒答缓存。
 *
 * 职责：把上游真正拒过的正文记下来，同一段正文再次到达时在本地直接拦掉，
 * 不再发往上游。重复投递已经被拒的内容是最容易被风控记上一笔的行为。
 *
 * 存储：JSON 文件 + 内存索引，零依赖。不引入任何数据库驱动。
 *   - 精确匹配用请求指纹（sha256），O(1)。
 *   - 近似匹配用 128 槽 MinHash 签名，估计 Jaccard 相似度，阈值默认 0.9。
 *
 * 关键约束（三条都必须保住）：
 * 1. 只有上游真的拒过的正文才写入。第 2 关硬正则和第 4 关决策模型自己的
 *    拦截不写入——那两层是本地判断，写进去会让一次误判变成永久封锁。
 *    recordRefusal 的 meta.source 必须显式给出，'hard_regex' 与 'classifier'
 *    会被直接丢弃。
 * 2. 近似匹配只在正文长度 ≥ 512 字符时启用。短文本的 shingle 重叠是噪声，
 *    很容易把两个无关请求算成相似；短文本仍走精确指纹。
 * 3. 相似度只比较用户正文，不含 system。共用同一段 Claude Code system 前缀
 *    不能把两个不同的请求推过阈值。
 *
 * MinHash 参数与参考实现一致：24 字符 shingle、步长 12、128 槽。
 * 这三个值决定了签名的稳定性，改动会让已有缓存全部失配。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { normalizeText } from './prepare.mjs'

/** 默认相似度阈值：估计 Jaccard 0.9。 */
export const REFUSAL_SIMILARITY = 0.9
/** 低于这个长度不做近似匹配。 */
export const SIMILARITY_MIN_CHARS = 512

const SHINGLE = 24
const STEP = 12
const MAX_SHINGLES = 4096
const SLOTS = 128

/** 允许写入缓存的来源。其余来源的记录一律拒绝。 */
export const WRITABLE_SOURCES = Object.freeze(['upstream', 'upstream_refusal'])

/** 明确不写入缓存的来源：本地判断层。 */
export const LOCAL_BLOCK_SOURCES = Object.freeze([
  'hard_regex',
  'hard-regex',
  'distill',
  'classifier',
  'jev',
  'refusal_cache',
])

const MAX_ENTRIES = 5000
const MAX_PREVIEW = 240
const MAX_RECORD_CHARS = 200000

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function shingles(text) {
  if (text.length <= SHINGLE) return [text]
  const raw = Math.floor((text.length - SHINGLE) / STEP) + 1
  const stride = raw > MAX_SHINGLES ? Math.ceil(raw / MAX_SHINGLES) : 1
  const step = STEP * stride
  const out = []
  for (let i = 0; i + SHINGLE <= text.length; i += step) out.push(text.slice(i, i + SHINGLE))
  return out
}

/**
 * 128 槽 MinHash 签名。文本太短时返回 null——不做近似比较。
 * @returns {number[]|null}
 */
export function refusalSignature(text) {
  const norm = normalizeText(text)
  if (norm.length < SIMILARITY_MIN_CHARS) return null
  const sig = new Uint32Array(SLOTS)
  sig.fill(0xffffffff)
  for (const gram of shingles(norm)) {
    const h1 = fnv1a(gram)
    const h2 = (fnv1a(`\u0001${gram}`) | 1) >>> 0
    for (let i = 0; i < SLOTS; i += 1) {
      const mixed = (h1 + Math.imul(i, h2)) >>> 0
      if (mixed < sig[i]) sig[i] = mixed
    }
  }
  return Array.from(sig)
}

/** 签名序列化成一行文本，便于存进 JSON。 */
export function encodeSignature(signature) {
  if (!Array.isArray(signature) || signature.length !== SLOTS) return null
  return signature.join(',')
}

/** 反序列化。格式不对返回 null，读到脏数据不能让整张缓存失效。 */
export function decodeSignature(raw) {
  if (!raw) return null
  const parts = String(raw).split(',')
  if (parts.length !== SLOTS) return null
  const out = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    out.push(Number(part) >>> 0)
  }
  return out
}

/** 估计 Jaccard：相同槽位占比。1 表示一致，0 表示无交集。 */
export function signatureSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return 0
  if (!left.length || left.length !== right.length) return 0
  let same = 0
  for (let i = 0; i < left.length; i += 1) if (left[i] === right[i]) same += 1
  return same / left.length
}

/** 请求指纹：模型 + 规范化正文 + 工具名。不含 stream / max_tokens。 */
export function refusalFingerprint(body, options = {}) {
  const model = String(body?.model ?? options.model ?? '')
    .trim()
    .toLowerCase()
  const text = normalizeText(options.text ?? '')
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    .map((tool) => String(tool?.name ?? tool?.function?.name ?? '').trim())
    .filter(Boolean)
    .sort()
  return createHash('sha256').update(JSON.stringify({ model, text, tools })).digest('hex')
}

/** 存档用摘要：压空白、截断到 240 字符。 */
export function refusalPreview(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PREVIEW)
}

function clampRatio(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return REFUSAL_SIMILARITY
  return n > 1 ? n / 100 : n
}

function blankStore() {
  return { version: 1, entries: [] }
}

/**
 * 拒答缓存。默认纯内存；给 file 时读写 JSON 文件。
 *
 * 写入策略：内存索引立即更新；配了 file 就同步落盘。落盘失败不抛给请求路径，
 * 只在 lastError 里留痕——缓存放不下不能变成请求失败。
 */
export class RefusalCache {
  /**
   * @param {{ file?: string, similarity?: number, similarityEnabled?: boolean,
   *           persist?: boolean, maxEntries?: number }} [options]
   */
  constructor(options = {}) {
    this.file = options.file ? String(options.file) : ''
    this.persist = options.persist !== false && Boolean(this.file)
    this.similarity = clampRatio(options.similarity)
    this.similarityEnabled = options.similarityEnabled !== false
    this.maxEntries = Number.isFinite(Number(options.maxEntries)) && Number(options.maxEntries) > 0
      ? Number(options.maxEntries)
      : MAX_ENTRIES
    /** @type {Map<string, object>} 指纹 → 记录 */
    this.byFingerprint = new Map()
    /** @type {Map<string, { fingerprint: string, signature: number[] }>} */
    this.bySignature = new Map()
    this.lastError = null
    this.writes = 0
    this.rejected = 0
    if (this.persist) this.load()
  }

  get size() {
    return this.byFingerprint.size
  }

  /** 从磁盘载入。文件不存在视为空缓存；文件损坏时留痕并继续用空缓存。 */
  load() {
    if (!this.file) return this
    try {
      if (!fs.existsSync(this.file)) return this
      const raw = fs.readFileSync(this.file, 'utf8')
      if (!raw.trim()) return this
      const data = JSON.parse(raw)
      const entries = Array.isArray(data?.entries) ? data.entries : []
      for (const entry of entries) this.#insert(entry)
      this.lastError = null
    } catch (error) {
      this.lastError = `load: ${error?.message || error}`
    }
    return this
  }

  /** 落盘。先写临时文件再改名，避免半截文件。 */
  save() {
    if (!this.persist) return this
    try {
      const dir = path.dirname(this.file)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const payload = JSON.stringify({ version: 1, entries: [...this.byFingerprint.values()] }, null, 0)
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, this.file)
      this.lastError = null
    } catch (error) {
      this.lastError = `save: ${error?.message || error}`
    }
    return this
  }

  #insert(entry) {
    if (!entry || typeof entry !== 'object') return false
    const fingerprint = String(entry.fingerprint ?? '').trim()
    if (!fingerprint) return false
    // signature 允许是数组（内存写入）或编码后的字符串（磁盘读回）。
    const signature = Array.isArray(entry.signature)
      ? entry.signature.length === SLOTS
        ? entry.signature
        : null
      : decodeSignature(entry.signature)
    const row = {
      fingerprint,
      // 签名随记录一起存。落盘格式与内存形状一致，重载后近似匹配仍然可用。
      signature: signature ? encodeSignature(signature) : null,
      model: String(entry.model ?? '').slice(0, 120),
      text: String(entry.text ?? '').slice(0, MAX_RECORD_CHARS),
      preview: String(entry.preview ?? '').slice(0, MAX_PREVIEW),
      source: String(entry.source ?? 'upstream').slice(0, 40),
      category: String(entry.category ?? '').slice(0, 40),
      error_message: String(entry.error_message ?? '').slice(0, 500),
      request_id: entry.request_id ? String(entry.request_id).slice(0, 120) : null,
      created_at: Number(entry.created_at) || Date.now(),
      hits: Number(entry.hits) || 0,
    }
    this.byFingerprint.set(fingerprint, row)
    if (signature) this.bySignature.set(fingerprint, { fingerprint, signature })
    return true
  }

  #evict() {
    while (this.byFingerprint.size > this.maxEntries) {
      // Map 保持插入顺序，最早写入的先淘汰。
      const oldest = this.byFingerprint.keys().next().value
      if (oldest == null) break
      this.byFingerprint.delete(oldest)
      this.bySignature.delete(oldest)
    }
  }

  /**
   * 写入一条拒答记录。
   *
   * `meta.source` 必须落在 WRITABLE_SOURCES 里。硬正则与决策模型的拦截
   * 传进来会被丢弃并计入 rejected，不会落进缓存——这是硬约束。
   *
   * @param {string} text 被拒的正文
   * @param {{ source?: string, fingerprint?: string, model?: string, category?: string,
   *           errorMessage?: string, requestId?: string }} [meta]
   * @returns {{ ok: boolean, reason?: string, fingerprint?: string }}
   */
  record(text, meta = {}) {
    const source = String(meta.source ?? 'upstream')
      .trim()
      .toLowerCase()
    if (!WRITABLE_SOURCES.includes(source)) {
      this.rejected += 1
      return { ok: false, reason: 'source_not_writable' }
    }
    const body = String(text ?? '').slice(0, MAX_RECORD_CHARS)
    if (!body.trim()) return { ok: false, reason: 'empty' }
    const fingerprint = String(meta.fingerprint ?? '').trim() || refusalFingerprint({ model: meta.model }, { text: body })
    const signature = refusalSignature(body)
    const ok = this.#insert({
      fingerprint,
      model: meta.model,
      text: body,
      preview: refusalPreview(body),
      source,
      category: meta.category,
      error_message: meta.errorMessage,
      request_id: meta.requestId,
      created_at: Date.now(),
      // 存编码后的一行，和磁盘格式一致，读回路径只有一条。
      signature: signature ? encodeSignature(signature) : null,
    })
    if (!ok) return { ok: false, reason: 'invalid' }
    this.writes += 1
    this.#evict()
    this.save()
    return { ok: true, fingerprint }
  }

  /** 精确匹配。 */
  get(fingerprint) {
    if (!fingerprint) return null
    return this.byFingerprint.get(String(fingerprint)) || null
  }

  /**
   * 近似匹配：逐个比签名，返回相似度最高且达到阈值的那条。
   * @returns {{ fingerprint: string, score: number, row: object }|null}
   */
  nearest(signature, threshold) {
    if (!this.similarityEnabled || !Array.isArray(signature)) return null
    const line = clampRatio(threshold == null ? this.similarity : threshold)
    let best = null
    for (const candidate of this.bySignature.values()) {
      const score = signatureSimilarity(signature, candidate.signature)
      if (score < line) continue
      if (best && score <= best.score) continue
      const row = this.byFingerprint.get(candidate.fingerprint)
      if (!row) continue
      best = { fingerprint: candidate.fingerprint, score, row }
    }
    return best
  }

  /** 命中计数：只动内存里的 hits，不立刻落盘。 */
  hit(fingerprint) {
    const row = this.get(fingerprint)
    if (!row) return false
    row.hits += 1
    return true
  }

  /** 清空。带 file 时同时把文件写成空缓存。 */
  clear() {
    this.byFingerprint.clear()
    this.bySignature.clear()
    this.save()
    return this
  }

  /** 只读快照，供统计与测试使用。 */
  snapshot() {
    return [...this.byFingerprint.values()].map((row) => ({ ...row }))
  }
}

let defaultCache = null

/**
 * 进程内默认缓存。测试与 demo 可以传自己的实例，避免互相污染。
 * @param {{ file?: string }} [options]
 */
export function defaultRefusalCache(options = {}) {
  if (!defaultCache) defaultCache = new RefusalCache(options)
  return defaultCache
}

/**
 * 匹配已存拒答。
 *
 * 顺序：精确指纹 → 近似签名。设备封禁不在这层——device 状态由调用方传进来，
 * 这个模块只负责正文。
 *
 * @param {string} text 用户正文
 * @param {{ cache?: RefusalCache, fingerprint?: string, model?: string,
 *           similarity?: number, similarityEnabled?: boolean }} [opts]
 * @returns {{ hit: boolean, exact: boolean, similarity: number, entry: object|null, kind: string }}
 */
export function matchStoredRefusal(text, opts = {}) {
  const miss = { hit: false, exact: false, similarity: 0, entry: null, kind: '' }
  const cache = opts.cache || defaultRefusalCache()
  const body = String(text ?? '')
  if (!body.trim()) return miss
  const fingerprint =
    String(opts.fingerprint ?? '').trim() || refusalFingerprint({ model: opts.model }, { text: body })
  const exact = cache.get(fingerprint)
  if (exact) {
    return { hit: true, exact: true, similarity: 1, entry: exact, kind: 'exact' }
  }
  if (opts.similarityEnabled === false || cache.similarityEnabled === false) return miss
  const signature = refusalSignature(body)
  if (!signature) return miss
  const near = cache.nearest(signature, opts.similarity == null ? cache.similarity : opts.similarity)
  if (!near) return miss
  return { hit: true, exact: false, similarity: near.score, entry: near.row, kind: 'similar' }
}

/**
 * 记录一条上游拒答。语义上等价于 `cache.record`，这里单独导出是为了让调用点
 * 的意图清楚：只有上游拒过的正文才走这个函数。
 *
 * @param {string} text
 * @param {{ cache?: RefusalCache, source?: string, fingerprint?: string, model?: string,
 *           category?: string, errorMessage?: string, requestId?: string }} [meta]
 */
export function recordRefusal(text, meta = {}) {
  const cache = meta.cache || defaultRefusalCache()
  const { cache: _ignored, ...rest } = meta
  return cache.record(text, rest)
}
