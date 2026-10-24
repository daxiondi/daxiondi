/**
 * 出站请求的脱敏结构骨架（outbound shape）。
 *
 * 目的：把一份出站 body 归约成「只描述结构、不携带任何实际文本」的骨架，
 * 于是两次实现（或改动前后）的出站差异可以被机械比对，而日志/报告里
 * 不会带出提示词、账号、密钥等内容。
 *
 * 只做结构，不做语义：
 *   - 字段名、字段顺序、嵌套层级
 *   - 值的类型（文本 / 数字 / 布尔 / null）
 *   - 数组长度与元素结构
 *   - cache_control 的位置（存在即 true）
 *   - betas 列表的枚举值（协议协商靠它，脱敏就没意义了）
 *   - billing header 的字段名（不含字段值）
 *
 * 归约规则（shape 的表示法）：
 *   字符串      → '<text:12>'（12 = UTF-8 字节数）
 *   数字        → '<number>'
 *   布尔        → '<bool>'
 *   null        → '<null>'
 *   undefined   → '<undefined>'（JS 对象里可能出现，JSON 里不会）
 *   数组        → { __array: <长度>, __item: <首元素 shape> }
 *                 元素结构不一致时追加 __variants: [<去重后的 shape>]
 *                 空数组 → { __array: 0 }
 *   对象        → 键名逐个保留，值递归归约；空对象 → {}
 *
 * 不脱敏的例外（都是枚举 / 协议常量，值本身就是结构信息）：
 *   - 键名命中 ENUM_KEYS（type / role / model）的字符串值原样保留
 *   - betas 数组里的 beta 名原样保留
 *   - billing header 文本 → '<billing:字段名,...>'（只列字段名，值一律丢弃）
 *   - cache_control 的值一律归约为 true（位置是结构，内容不是）
 *
 * 本模块不 import src/ 下任何其他模块，避免被并行改动牵连。
 */

/** shape 输出格式标识；脚本落盘时带上，读回时可确定「这是 shape 还是 body」 */
export const SHAPE_FORMAT = 'outbound-shape/1'

/** 值本身是枚举、必须原样保留的键 */
export const ENUM_KEYS = Object.freeze(['type', 'role', 'model'])

/** 值是一个 beta 名列表的键（数组元素原样保留） */
export const BETA_KEYS = Object.freeze(['betas', 'beta', 'anthropic_beta', 'anthropic-beta'])

/** 数组标记键；只在这几个键同时出现时才把对象认成数组标记 */
const ARRAY_MARKERS = Object.freeze(['__array', '__item', '__variants'])

const MARKER_KEYS = new Set(ARRAY_MARKERS)

const BILLING_PREFIX = /^\s*x-anthropic-billing-header:\s*/i

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 归一化键名：beta 列表在 header / body 里大小写写法不一，按小写匹配 */
const lowerKey = (key) => String(key).toLowerCase().replace(/-/g, '_')

/** 文本是否为 billing header（只看前缀，不看内容） */
export function isBillingText(text) {
  return typeof text === 'string' && BILLING_PREFIX.test(text)
}

/**
 * 从 billing header 文本里拆出字段名。
 * 只返回键名，值全部丢弃——cc_prompt_id / cch 之类会随请求变化的量不能进报告。
 */
export function billingFieldNames(text) {
  if (!isBillingText(text)) return []
  const body = String(text).replace(BILLING_PREFIX, '')
  return body
    .split(';')
    .map((part) => part.trim().split('=')[0].trim())
    .filter(Boolean)
}

/** 字符串的归约形式：billing / 普通文本 */
function shapeString(text) {
  if (isBillingText(text)) {
    const fields = billingFieldNames(text)
    return `<billing:${fields.join(',')}>`
  }
  return `<text:${Buffer.byteLength(text, 'utf8')}>`
}

/** 数组标记判定：只含标记键，且 __array 是数字 */
export function isArrayMarker(node) {
  if (!isPlainObject(node)) return false
  if (typeof node.__array !== 'number') return false
  return Object.keys(node).every((key) => MARKER_KEYS.has(key))
}

/**
 * 把任意值归约成 shape。
 *
 * @param {unknown} value 待归约的值（body 里的任意节点）
 * @param {{key?: string, enumKeys?: readonly string[], betaKeys?: readonly string[]}} [ctx]
 *   key 是当前值在父对象里的键名，用于枚举 / beta 例外判定。
 * @returns {unknown} shape
 */
export function shapeOf(value, ctx = {}) {
  const key = ctx.key == null ? null : String(ctx.key)
  const enumKeys = ctx.enumKeys || ENUM_KEYS
  const betaKeys = ctx.betaKeys || BETA_KEYS
  const lower = key == null ? null : lowerKey(key)

  if (lower === 'cache_control') return true
  if (Array.isArray(value)) return shapeArray(value, ctx)
  if (typeof value === 'string') {
    if (key != null && enumKeys.includes(key)) return value
    return shapeString(value)
  }
  if (typeof value === 'number') return '<number>'
  if (typeof value === 'boolean') return '<bool>'
  if (value === null) return '<null>'
  if (value === undefined) return '<undefined>'
  if (typeof value !== 'object') return `<${typeof value}>`

  const out = {}
  for (const [innerKey, inner] of Object.entries(value)) {
    out[innerKey] = shapeOf(inner, { ...ctx, key: innerKey })
  }
  return out
}

/** 数组归约：长度 + 首元素结构；结构不一致时附上去重后的变体列表 */
function shapeArray(items, ctx) {
  if (!items.length) return { __array: 0 }
  // beta 列表里的字符串是协议常量，不是用户内容，逐个保留
  const isBetaList = ctx.key != null && (ctx.betaKeys || BETA_KEYS).includes(lowerKey(ctx.key))
  const shapes = items.map((item, index) =>
    isBetaList
      ? typeof item === 'string'
        ? item
        : shapeOf(item, { ...ctx, key: null })
      : shapeOf(item, { ...ctx, key: null, index }),
  )
  const out = { __array: items.length, __item: shapes[0] }
  // 结构判等要比「脱敏后」的形态：两段长度不同的文本仍是同一种结构。
  // 用原始 shape 判等会把 <text:1> / <text:4> 当成两种元素，variants 就失去意义。
  const distinct = []
  for (const shape of shapes) {
    const json = JSON.stringify(loosen(shape))
    if (!distinct.some((seen) => JSON.stringify(loosen(seen)) === json)) distinct.push(shape)
  }
  if (distinct.length > 1) out.__variants = distinct
  return out
}

/** 比较用的归一化：非 strict 模式下忽略文本长度（长度属于内容，不属于结构） */
function loosen(shape) {
  if (typeof shape === 'string') {
    if (shape.startsWith('<text:')) return '<text>'
    return shape
  }
  if (Array.isArray(shape)) return shape.map(loosen)
  if (!isPlainObject(shape)) return shape
  const out = {}
  for (const [key, inner] of Object.entries(shape)) out[key] = loosen(inner)
  return out
}

function describe(value) {
  if (Array.isArray(value)) return `array[${value.length}]`
  if (isPlainObject(value)) return isArrayMarker(value) ? `array[${value.__array}]` : `object{${Object.keys(value).length}}`
  return value
}

/**
 * 对比两个 shape，返回差异列表。
 *
 * 差异条目：{ path, kind, expected, actual }
 *   kind=value      叶子值不同（类型、枚举值、billing 字段、beta 名）
 *   kind=length     数组长度不同
 *   kind=key_order  同一层键的顺序不同（wire 字节顺序，cch 依赖它）
 *   kind=missing    期望侧有、实际侧没有
 *   kind=extra      实际侧多出来
 *
 * 默认非 strict：'<text:12>' 与 '<text:7>' 视为同一结构（长度归内容）。
 *
 * @param {unknown} a 期望 shape
 * @param {unknown} b 实际 shape
 * @param {string} [path] 起始路径（递归用）
 * @param {{strict?: boolean}} [options]
 * @returns {Array<{path:string, kind:string, expected?:unknown, actual?:unknown}>}
 */
export function diffShape(a, b, path = '', options = {}) {
  const strict = Boolean(options.strict)
  const out = []
  walkShape(a, b, path, out, strict)
  return out
}

/** 判等：strict 比原始 shape，非 strict 先抹掉文本长度 */
function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function sameShape(a, b, strict) {
  if (strict) return JSON.stringify(a) === JSON.stringify(b)
  return JSON.stringify(loosen(a)) === JSON.stringify(loosen(b))
}

function walkShape(a, b, path, out, strict) {
  const here = path || '.'
  if (sameShape(a, b, strict)) return

  const aObj = isPlainObject(a)
  const bObj = isPlainObject(b)
  const aArrMark = isArrayMarker(a)
  const bArrMark = isArrayMarker(b)

  if (aArrMark || bArrMark) {
    if (!aArrMark || !bArrMark) {
      out.push({ path: here, kind: 'value', expected: describe(a), actual: describe(b) })
      return
    }
    if (a.__array !== b.__array) {
      out.push({ path: `${path}.__array`.replace(/^\./, ''), kind: 'length', expected: a.__array, actual: b.__array })
    }
    // 空数组没有 __item；一侧空一侧非空时，元素结构本身就是差异
    const aHasItem = Object.hasOwn(a, '__item')
    const bHasItem = Object.hasOwn(b, '__item')
    if (aHasItem && bHasItem) walkShape(a.__item, b.__item, joinPath(path, '__item'), out, strict)
    else if (aHasItem !== bHasItem) {
      out.push({
        path: joinPath(path, '__item'),
        kind: 'value',
        expected: aHasItem ? describe(a.__item) : '<absent>',
        actual: bHasItem ? describe(b.__item) : '<absent>',
      })
    }
    const aVars = a.__variants
    const bVars = b.__variants
    if (Boolean(aVars) !== Boolean(bVars)) {
      out.push({
        path: joinPath(path, '__variants'),
        kind: 'value',
        expected: aVars ? `variants[${aVars.length}]` : 'single',
        actual: bVars ? `variants[${bVars.length}]` : 'single',
      })
      return
    }
    if (aVars && bVars) walkShape(aVars, bVars, joinPath(path, '__variants'), out, strict)
    return
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push({ path: here, kind: 'value', expected: describe(a), actual: describe(b) })
      return
    }
    if (a.length !== b.length) {
      out.push({ path: here, kind: 'length', expected: a.length, actual: b.length })
    }
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      walkShape(a[i], b[i], `${path}[${i}]`, out, strict)
    }
    return
  }

  if (aObj || bObj) {
    if (!aObj || !bObj) {
      out.push({ path: here, kind: 'value', expected: describe(a), actual: describe(b) })
      return
    }
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    for (const key of aKeys) {
      if (!Object.hasOwn(b, key)) out.push({ path: joinPath(path, key), kind: 'missing' })
    }
    for (const key of bKeys) {
      if (!Object.hasOwn(a, key)) out.push({ path: joinPath(path, key), kind: 'extra' })
    }
    const sharedA = aKeys.filter((key) => Object.hasOwn(b, key))
    const sharedB = bKeys.filter((key) => Object.hasOwn(a, key))
    if (sharedA.join('\u0000') !== sharedB.join('\u0000')) {
      out.push({
        path: here,
        kind: 'key_order',
        expected: sharedA,
        actual: sharedB,
      })
    }
    for (const key of sharedA) walkShape(a[key], b[key], joinPath(path, key), out, strict)
    return
  }

  out.push({ path: here, kind: 'value', expected: a, actual: b })
}

function joinPath(path, key) {
  if (!path) return key
  return `${path}.${key}`
}

/** 把 shape 包成可落盘的文档，读回时不会与 body 混淆 */
export function wrapShape(shape) {
  return { __format: SHAPE_FORMAT, shape }
}

/**
 * 拆开 wrapShape 的文档。
 * 不是 shape 文档时原样返回，由调用方决定是否 shapeOf。
 * @returns {{shape: unknown, wrapped: boolean}}
 */
export function unwrapShape(doc) {
  if (isPlainObject(doc) && doc.__format === SHAPE_FORMAT && Object.hasOwn(doc, 'shape')) {
    return { shape: doc.shape, wrapped: true }
  }
  return { shape: doc, wrapped: false }
}

/**
 * 是否看起来已经是一个 shape（用于脚本判断输入是 body 还是骨架）。
 *
 * 判定：顶层是对象，且所有叶子都是归约标记 / 裸枚举字符串 / 布尔（cache_control
 * 归约成 true）/ 数组长度计数。
 */
export function looksLikeShape(value) {
  if (!isPlainObject(value)) return false
  let sawMarker = false
  const scan = (node) => {
    if (typeof node === 'string') {
      if (/^<[a-z]+[:>]/.test(node)) sawMarker = true
      return true
    }
    if (typeof node === 'boolean' || typeof node === 'number') return true
    if (typeof node === 'undefined') return false
    if (Array.isArray(node)) return node.every(scan)
    if (isPlainObject(node)) return Object.values(node).every(scan)
    return false
  }
  if (!scan(value)) return false
  return sawMarker
}

/**
 * 可读树形渲染。返回字符串，不直接打印（脚本决定输出到 stdout 还是文件）。
 *
 * @param {unknown} shape
 * @param {number} [indent] 顶层缩进空格数；每层固定再加 2
 * @returns {string}
 */
export function formatShape(shape, indent = 0) {
  const lines = []
  const base = Number.isFinite(indent) && indent > 0 ? indent : 0

  const leaf = (value) => {
    if (typeof value === 'string') {
      // 归约标记直接原样打（<text:12> / <billing:…>），枚举值是字符串字面量，加引号区分
      return value.startsWith('<') ? value : JSON.stringify(value)
    }
    return String(value)
  }

  const walk = (node, depth, label) => {
    const pad = ' '.repeat(base + depth * 2)
    const head = label == null ? '' : `${label}: `
    if (isArrayMarker(node)) {
      lines.push(`${pad}${head}array[${node.__array}]`)
      // 空数组没有元素结构可打，跳过 __item 避免打印出 undefined
      if (Object.hasOwn(node, '__item')) walk(node.__item, depth + 1, '[0]')
      if (node.__variants) {
        // __variants 的首项就是 __item，再打一遍纯属噪声；只列真正不同的变体，
        // 并把原数组下标带出来，方便对着 body 定位是哪个元素。
        const rest = node.__variants.filter((variant, i) => !(i === 0 && sameJson(variant, node.__item)))
        const omitted = node.__variants.length - rest.length
        if (rest.length) {
          lines.push(
            `${pad}${' '.repeat(2)}variants[${node.__variants.length}]${omitted ? `（另有 ${omitted} 项与 [0] 相同）` : ''}`,
          )
          rest.forEach((variant, i) => walk(variant, depth + 2, `[${i + omitted}]`))
        }
      }
      return
    }
    if (Array.isArray(node)) {
      lines.push(`${pad}${head}list[${node.length}]`)
      node.forEach((item, i) => walk(item, depth + 1, `[${i}]`))
      return
    }
    if (isPlainObject(node)) {
      const keys = Object.keys(node)
      lines.push(`${pad}${head}object{${keys.length}}`)
      for (const key of keys) walk(node[key], depth + 1, key)
      return
    }
    lines.push(`${pad}${head}${leaf(node)}`)
  }

  walk(shape, 0, null)
  return lines.join('\n')
}
