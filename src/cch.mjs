/**
 * xxHash64 与 Claude Code cch 计算。
 *
 * cch 是 Claude Code 写在 system 的 billing header 里的 5 位十六进制值：
 * 对「规整后的请求体 JSON 字节」做 xxHash64（固定 seed）后取低 20 bit。
 * 线上请求体仍然携带真实字段，cch 只是握手指纹。
 *
 * 关键约束：
 * 1. 哈希输入是文本投影后的字节，不是对象。投影规则见 projectBillingFields，
 *    各步骤顺序不可调整，否则算出的 cch 与上游期望不符。
 * 2. 投影步骤：首个 cch 归 00000 → 清空所有 model 值 → 切掉 fallbacks 数组 /
 *    fallback_credit_token / 数字型 max_tokens。
 * 3. seed 固定为 CCH_XXH64_SEED，结果取低 20 bit，补零到 5 位小写 hex。
 * 4. 本实现对字节级细节敏感：任何"顺手优化"都会改变哈希输入。
 */

const MASK = 0xffffffffffffffffn
const PRIME64_1 = 0x9e3779b185ebca87n
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn
const PRIME64_3 = 0x165667b19e3779f9n
const PRIME64_4 = 0x85ebca77c2b2ae63n
const PRIME64_5 = 0x27d4eb2f165667c5n

export const CCH_PLACEHOLDER = '00000'
export const CCH_XXH64_SEED = 0x4d659218e32a3268n

const rotl64 = (x, r) => ((x << r) | (x >> (64n - r))) & MASK

function round(acc, input) {
  acc = (acc + ((input * PRIME64_2) & MASK)) & MASK
  acc = rotl64(acc, 31n)
  return (acc * PRIME64_1) & MASK
}

function mergeRound(acc, val) {
  acc ^= round(0n, val)
  return (acc * PRIME64_1 + PRIME64_4) & MASK
}

function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  return Buffer.from(input ?? '')
}

export function xxh64(input, seed = 0n) {
  const buf = asBuffer(input)
  const seed64 = BigInt(seed) & MASK
  const len = buf.length
  let p = 0
  let h64

  if (len >= 32) {
    let v1 = (seed64 + PRIME64_1 + PRIME64_2) & MASK
    let v2 = (seed64 + PRIME64_2) & MASK
    let v3 = seed64
    let v4 = (seed64 - PRIME64_1) & MASK
    const limit = len - 32
    while (p <= limit) {
      v1 = round(v1, buf.readBigUInt64LE(p))
      v2 = round(v2, buf.readBigUInt64LE(p + 8))
      v3 = round(v3, buf.readBigUInt64LE(p + 16))
      v4 = round(v4, buf.readBigUInt64LE(p + 24))
      p += 32
    }
    h64 = (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) & MASK
    h64 = mergeRound(h64, v1)
    h64 = mergeRound(h64, v2)
    h64 = mergeRound(h64, v3)
    h64 = mergeRound(h64, v4)
  } else {
    h64 = (seed64 + PRIME64_5) & MASK
  }

  h64 = (h64 + BigInt(len)) & MASK

  while (p + 8 <= len) {
    const k1 = round(0n, buf.readBigUInt64LE(p))
    h64 ^= k1
    h64 = (rotl64(h64, 27n) * PRIME64_1 + PRIME64_4) & MASK
    p += 8
  }
  if (p + 4 <= len) {
    h64 ^= (BigInt(buf.readUInt32LE(p)) * PRIME64_1) & MASK
    h64 = (rotl64(h64, 23n) * PRIME64_2 + PRIME64_3) & MASK
    p += 4
  }
  while (p < len) {
    h64 ^= (BigInt(buf[p]) * PRIME64_5) & MASK
    h64 = (rotl64(h64, 11n) * PRIME64_1) & MASK
    p += 1
  }

  h64 ^= h64 >> 33n
  h64 = (h64 * PRIME64_2) & MASK
  h64 ^= h64 >> 29n
  h64 = (h64 * PRIME64_3) & MASK
  h64 ^= h64 >> 32n
  return h64
}

/** 低 20 bit → 5 位小写 hex */
export function computeClaudeCodeCch(bodyBytes) {
  return (xxh64(bodyBytes, CCH_XXH64_SEED) & 0xfffffn).toString(16).padStart(5, '0')
}

// ── 文本投影：把请求体规整成"参与哈希的形态" ──────────────

function cut(text, start, end) {
  if (end < text.length && text[end] === ',') end += 1
  else if (start > 0 && text[start - 1] === ',') start -= 1
  return text.slice(0, start) + text.slice(end)
}

/**
 * 清空所有 `"model":"<value>"` 的值，保留键名与引号。
 *
 * 扫描方式（上游历史实现 Claude Code 2.1.x 的同款行为）：
 *   - 找到 `"model":"` 后向后扫到闭合引号 k（中间跳过转义对）
 *   - 输出「游标之前的内容 + needle」
 *   - 游标停在**闭合引号本身**，下一轮从该引号开始切片
 *
 * 净效果是值被整段吃掉、键和两侧引号都保留：
 *   {"model":"abc","x":1} → {"model":"","x":1}
 *
 * cch 是对这段字节算哈希，必须逐字节一致。不要"修正"这里的游标位置，
 * 一旦把闭合引号也一起跳过，就会产出 `{"model":",` 这类非法 JSON，
 * 算出的 cch 与上游期望不符。
 */
function clearModelValues(text) {
  const needle = '"model":"'
  const out = []
  let i = 0
  while (true) {
    const j = text.indexOf(needle, i)
    if (j < 0) {
      out.push(text.slice(i))
      break
    }
    let k = j + needle.length
    while (k < text.length) {
      if (text[k] === '\\' && k + 1 < text.length) {
        k += 2
        continue
      }
      if (text[k] === '"') break
      k += 1
    }
    out.push(text.slice(i, j + needle.length))
    i = k // 停在闭合引号上，下一轮 slice 会保留它
  }
  return out.join('')
}

function stripFallbacks(text) {
  const key = '"fallbacks":['
  const j = text.indexOf(key)
  if (j < 0) return text
  let i = j + key.length - 1
  let depth = 0
  let inStr = false
  let esc = false
  while (i < text.length) {
    const c = text[i]
    if (inStr) {
      esc = !esc || c !== '\\' ? !esc && c === '\\' : false
      if (c === '"' && !esc) inStr = false
      else if (c === '\\') esc = !esc
      else esc = false
    } else if (c === '"') inStr = true
    else if (c === '[') depth += 1
    else if (c === ']') {
      depth -= 1
      if (depth === 0) return cut(text, j, i + 1)
    }
    i += 1
  }
  return text
}

function stripFallbackCreditToken(text) {
  const key = '"fallback_credit_token":"'
  const j = text.indexOf(key)
  if (j < 0) return text
  let k = j + key.length
  while (k < text.length) {
    if (text[k] === '\\' && k + 1 < text.length) {
      k += 2
      continue
    }
    if (text[k] === '"') return cut(text, j, k + 1)
    k += 1
  }
  return text
}

function stripMaxTokens(text) {
  const key = '"max_tokens":'
  const j = text.indexOf(key)
  if (j < 0) return text
  let k = j + key.length
  if (k >= text.length || !/\d/.test(text[k])) return text
  while (k < text.length && /\d/.test(text[k])) k += 1
  return cut(text, j, k)
}

/**
 * 投影顺序，必须与上游一致，不可调整：
 *   1. JSON 压缩（JSON.parse → JSON.stringify，幂等）
 *   2. billing header 里的 cch 值先归 `00000`
 *   3. 清空 model 值
 *   4. 切 fallbacks
 *   5. 切 fallback_credit_token
 *   6. 切数字型 max_tokens
 *
 * 注意第 6 步只切数字字面量；`"max_tokens":"100"` 这种字符串形态会原样保留，
 * 这是上游约定的投影口径。
 */
export function projectBillingFields(text) {
  const raw = String(text ?? '')
  let material = raw
  try {
    const compact = JSON.stringify(JSON.parse(raw))
    if (typeof compact === 'string') material = compact
  } catch {
    /* 非 JSON 就原样 */
  }
  const reset = resetFirstCanonicalBillingCch(material)
  return stripMaxTokens(
    stripFallbackCreditToken(stripFallbacks(clearModelValues(reset))),
  )
}

/**
 * 只把「第一个 canonical system billing block」里的 cch 归零，其余一律不动。
 *
 * 为什么要限定位置：messages 里完全可能包含 billing header 的文本示例
 * （用户贴日志、示例请求体等）。之前用全局正则会连这些示例一起改成 00000，
 * 投影字节就与上游期望不一致，算出的 cch 自然也不对。
 *
 * 判定顺序：
 *   1. 能找到 system 字段 → 只在 system 的值里找第一个 cch
 *   2. 找不到 system（或 system 里没有 cch）→ 退回到整段里第一个 cch
 *
 * 这样无论 messages 排在 system 前面还是后面，都只改真正的计费头。
 */
function resetFirstCanonicalBillingCch(material) {
  const cchRe = /(x-anthropic-billing-header:[^"]*?\bcch=)[0-9a-f]{5}(?=;)/i
  const replaceOnce = (segment) =>
    segment.replace(cchRe, (_m, prefix) => `${prefix}${CCH_PLACEHOLDER}`)

  // 定位 system 字段值的字符区间
  const sysKey = '"system":'
  const keyAt = material.indexOf(sysKey)
  if (keyAt >= 0) {
    let i = keyAt + sysKey.length
    // 跳过空白
    while (i < material.length && /\s/.test(material[i])) i += 1
    const open = material[i]
    if (open === '[' || open === '{') {
      const close = open === '[' ? ']' : '}'
      let depth = 0
      let inStr = false
      let esc = false
      const start = i
      for (; i < material.length; i += 1) {
        const c = material[i]
        if (inStr) {
          if (esc) esc = false
          else if (c === '\\') esc = true
          else if (c === '"') inStr = false
          continue
        }
        if (c === '"') inStr = true
        else if (c === open) depth += 1
        else if (c === close) {
          depth -= 1
          if (depth === 0) {
            const segment = material.slice(start, i + 1)
            if (cchRe.test(segment)) {
              // system 里有真计费头：只改这一段
              return material.slice(0, start) + replaceOnce(segment) + material.slice(i + 1)
            }
            break
          }
        }
      }
    } else if (open === '"') {
      // system 是字符串形态
      let j = i + 1
      let esc = false
      for (; j < material.length; j += 1) {
        const c = material[j]
        if (esc) { esc = false; continue }
        if (c === '\\') { esc = true; continue }
        if (c === '"') break
      }
      const segment = material.slice(i, j + 1)
      if (cchRe.test(segment)) {
        return material.slice(0, i) + replaceOnce(segment) + material.slice(j + 1)
      }
    }
  }

  // 没有 system 或 system 里没有 billing 头：退回整段第一个
  return replaceOnce(material)
}

// 只匹配一次，不能带 g。
//
// 带 g 的正则用 .test() 会累积 lastIndex —— 同一个正则连续调用时
// 结果会在 true/false 之间交替，导致 billing 探测时有时无。
// 这是上游 1.3.220 修复里明确的写法（'i' + 需要多行时重建）。
const SYSTEM_BILLING_CCH = new RegExp(
  `(^\\s*x-anthropic-billing-header:[^\\r\\n]*?\\bcch=)${CCH_PLACEHOLDER}(?=;)`,
  'i',
)

/**
 * 把 system 文本里每一行 billing header 的 cch 归一成占位符：
 * 只保留第一个 cch 槽位并写 00000，其余重复的 cch 段删除；
 * 整行没有 cch 时在行尾补一个。
 */
function normalizeBillingCch(text) {
  // 不能带 g/m。带 g 会把同一段文本里**每一行** billing header 都归一，
  // 而只有第一行是真正的计费头；后续行是调用方内容（历史回显、文档示例）。
  // 改它们会破坏请求体内容，上游能直接看出被中间层篡改过。
  return text.replace(/(^\s*x-anthropic-billing-header:)([^\r\n]*)/i, (line) => {
    let found = false
    const normalized = line.replace(/\s*cch=[^;\s]*;?/gi, () => {
      if (found) return ''
      found = true
      return ` cch=${CCH_PLACEHOLDER};`
    })
    if (found) return normalized
    return `${normalized.trimEnd()}${normalized.trimEnd().endsWith(';') ? '' : ';'} cch=${CCH_PLACEHOLDER};`
  })
}

/**
 * 对 system 里的每段文本应用 fn，返回新对象（不可变更新）。
 * system 既可能是纯字符串，也可能是字符串/blocks 混合数组；
 * 只有真正发生变化时才复制，避免无意义的引用变化影响上层缓存判断。
 */
function mapSystemText(body, fn) {
  // 只处理**第一个** billing block。
  //
  // 这是封号风险的核心：多轮对话的历史里会回显之前的 system 内容，
  // 里面同样含 x-anthropic-billing-header 文本 —— 那属于调用方内容，
  // 不是真正的计费头。如果对所有 block 都做归一/盖章，
  // 历史文本就被改坏了，上游对比能看到内容被中间层动过。
  //
  // 上游 1.3.220 修复的正是这一处（1.3.219 及之前全量改写，会被封）。
  let found = false
  const firstBilling = (text) => {
    // History and later documentation blocks are caller content, not billing.
    if (found || !/^\s*x-anthropic-billing-header:/i.test(text)) return text
    found = true
    return fn(text)
  }
  if (typeof body.system === 'string') {
    const system = firstBilling(body.system)
    return system === body.system ? body : { ...body, system }
  }
  if (!Array.isArray(body.system)) return body
  let changed = false
  const system = body.system.map((block) => {
    if (typeof block === 'string') {
      const text = firstBilling(block)
      changed ||= text !== block
      return text
    }
    if (!block || typeof block.text !== 'string') return block
    const text = firstBilling(block.text)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })
  return changed ? { ...body, system } : body
}

/**
 * 给请求体盖上 cch。
 *
 * 行为：
 *   1. 先把所有 billing header 的 cch 归一成 00000（无论是否启用）；
 *   2. 启用且 seal=true 时，对规整后的字节算 cch 并写回；
 *   3. 请求里没有 billing header 时不盖，原样返回。
 *
 * @param {object|string} body 请求体
 * @param {{enabled?:boolean, seal?:boolean}} opts
 *   enabled=false → 不盖（但仍把已有 cch 归零）
 *   seal=false    → 留占位符 00000（native CLI 自己算）
 */
export function sealClaudeCodeCch(body, { enabled = true, seal = true } = {}) {
  if (body == null || (typeof body !== 'string' && typeof body !== 'object')) return body
  const stringBody = typeof body === 'string'
  const normalized = mapSystemText(stringBody ? JSON.parse(body) : body, normalizeBillingCch)
  if (!enabled || !seal) return stringBody ? JSON.stringify(normalized) : normalized

  const raw = JSON.stringify(normalized)
  let billing = false
  // test 时重建一个带 m（行首匹配）但不带 g 的正则。
  // 直接对 SYSTEM_BILLING_CCH.test() 连续调用会因 lastIndex 累积而交替。
  const billingTest = new RegExp(SYSTEM_BILLING_CCH.source, 'im')
  mapSystemText(normalized, (text) => {
    billing ||= billingTest.test(text)
    return text
  })
  if (!billing) return stringBody ? raw : normalized

  const cch = computeClaudeCodeCch(Buffer.from(projectBillingFields(raw), 'utf8'))
  const sealed = mapSystemText(normalized, (text) => text.replace(SYSTEM_BILLING_CCH, `$1${cch}`))
  return stringBody ? JSON.stringify(sealed) : sealed
}
