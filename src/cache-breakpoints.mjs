/**
 * messages 的 prompt cache 断点布局。
 *
 * 职责：给定 messages 数组，计算应该打 cache_control 的消息位置，并把标记
 * 落到具体的 content block 上；另提供一份出站前的一致性检查。
 *
 * 背景（上游行为，成本相关）：
 * 上游的 prompt cache 是前缀匹配。写入点只认请求里显式标记的位置，读取时在
 * 最后一个匹配位置附近做有限回溯（约 20 个位置）。只在最后一条 user 打一个
 * 断点时，上一轮写入的位置与本轮的前缀对不上，回溯一旦越界，命中就退化到
 * system + tools 前缀，messages 部分整段重新写入，每轮都按全量计费。
 * 因此在长度足够的对话里要保留两个 messages 断点：最后一条 user 与上一条
 * user。两者之间的跨度即本轮的增量区间。
 *
 * 关键约束：
 * 1. cache_control 挂在 content block 上，不挂在 message 上。字符串 content
 *    要先规整成单 text 块数组。
 * 2. thinking / redacted_thinking 块不接受缓存标记，断点必须落在其他块上。
 * 3. 两个断点不能重合；消息太少时只打一个（第二个点会与前一个重叠或纯属浪费）。
 * 4. 幂等：重复调用不增加标记数量，也不改块的结构。
 */

import { applySystemBreakpoints, MAX_SYSTEM_BREAKPOINTS } from './system-layout.mjs'

/** 单个请求允许的 cache_control 总数上限（上游硬限制） */
export const MAX_CACHE_MARKERS = 4

/** messages 侧最多两个断点 */
export const MAX_MESSAGE_BREAKPOINTS = 2

/** 少于这个消息数时只打一个断点：两个点会重叠或落在同一轮增量里 */
export const MIN_MESSAGES_FOR_TWO_BREAKPOINTS = 4

/** 缺省 TTL。与 system 断点保持一致，避免同一请求里出现两种 TTL */
export const DEFAULT_CACHE_TTL = '1h'

const CACHE_TTLS = Object.freeze(['5m', '1h'])

/**
 * TTL 归一：只认 5m / 1h，其余（含空值、脏值）回落到缺省 1h。
 * 不做抛错是有意的——TTL 是成本参数，不该让一个坏配置把请求打挂。
 */
export function normalizeCacheTtl(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  return CACHE_TTLS.includes(raw) ? raw : DEFAULT_CACHE_TTL
}

/** thinking / redacted_thinking 块不能带 cache_control（上游会拒绝该组合） */
function isUncacheableBlock(block) {
  return block?.type === 'thinking' || block?.type === 'redacted_thinking'
}

/**
 * 计算 messages 的缓存断点位置。
 *
 * 规则：
 * - 消息数 < 4：只在最后一条 user 打一个断点
 * - 消息数 >= 4：最后一条 user + 上一条 user，共两个
 * - 只考虑 role === 'user' 的消息（assistant 轮次不单独打断点）
 * - 最后一条不是 user 时，向前找最近的 user
 * - 两个断点必须落在不同消息上；没有足够的 user 消息时退化为一个
 *
 * @param {Array<{role?:string}>} messages
 * @returns {number[]} 要打断点的消息索引，升序
 */
export function messageBreakpointIndices(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return []

  const users = []
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user') users.push(i)
  }
  if (users.length === 0) return []

  const tail = users[users.length - 1]
  if (messages.length < MIN_MESSAGES_FOR_TWO_BREAKPOINTS) return [tail]

  const previous = users.length >= 2 ? users[users.length - 2] : null
  if (previous == null || previous === tail) return [tail]
  return [previous, tail]
}

/**
 * 取一条消息上承载标记的块。
 *
 * 规则：数组形态取最后一个可缓存块；字符串形态就地转成单 text 块数组后
 * 返回该块。返回 null 表示这条消息没有可落标记的位置（空 content、只有
 * thinking 块、结构非法），调用方应跳过它而不是造一个空块。
 */
function anchorBlock(message) {
  if (!message || typeof message !== 'object') return null

  const content = message.content
  if (typeof content === 'string') {
    if (!content) return null
    const block = { type: 'text', text: content }
    message.content = [block]
    return block
  }

  if (!Array.isArray(content) || content.length === 0) return null
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i]
    if (!block || typeof block !== 'object') continue
    if (isUncacheableBlock(block)) continue
    return block
  }
  return null
}

/**
 * 在块上写 cache_control。
 *
 * 已经是 ephemeral + 同 TTL 时原样返回（幂等的关键：不复制对象，不重排字段）。
 * scope（global / org）是调用方语义，保留；其他未知字段按上游形态重建丢弃。
 */
function stampBlock(block, ttl) {
  if (!block || typeof block !== 'object') return
  const control = block.cache_control
  if (control && typeof control === 'object') {
    if (control.type === 'ephemeral' && control.ttl === ttl) return
  }
  const next = { type: 'ephemeral', ttl }
  if (control?.scope === 'global' || control?.scope === 'org') next.scope = control.scope
  block.cache_control = next
}

/** 清掉一条消息上所有块的标记（只处理数组形态；字符串 content 本身无标记） */
function clearMessageMarkers(message) {
  if (!message || !Array.isArray(message.content)) return
  for (const block of message.content) {
    if (block && typeof block === 'object' && 'cache_control' in block) delete block.cache_control
  }
}

/**
 * 给 messages 就地打上 cache_control 断点。
 *
 * 默认行为是"接管"：先清掉 messages 里原有的所有标记，再按断点规则重新打。
 * 这样标记数量恒等于断点数，出站请求不会因为调用方残留的标记超限。
 * 需要保留调用方标记时传 prune: false。
 *
 * 幂等：同一条消息重复调用、同一组参数，结果字节不变（第二次既不清除也不重建）。
 *
 * @param {Array<object>} messages
 * @param {object} [opts]
 * @param {string} [opts.ttl]           '5m' | '1h'，缺省 '1h'
 * @param {boolean} [opts.prune]        是否清掉非断点位置的旧标记，缺省 true
 * @param {number} [opts.maxBreakpoints] 断点名额，缺省 2；名额为 1 时只取尾点
 * @returns {{messages: Array<object>, applied: number[]}}
 */
export function applyMessageBreakpoints(messages, opts = {}) {
  const ttl = normalizeCacheTtl(opts.ttl)
  const prune = opts.prune !== false
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: Array.isArray(messages) ? messages : [], applied: [] }
  }

  const budget = Number.isInteger(opts.maxBreakpoints)
    ? Math.max(0, opts.maxBreakpoints)
    : MAX_MESSAGE_BREAKPOINTS

  // 名额不足时保留靠后的断点（尾点最重要），budget 为 0 时不打任何断点
  const allTargets = messageBreakpointIndices(messages)
  const targets = budget >= allTargets.length ? allTargets : allTargets.slice(allTargets.length - budget)
  const targetSet = new Set(targets)

  if (prune) {
    for (let i = 0; i < messages.length; i += 1) {
      if (!targetSet.has(i)) clearMessageMarkers(messages[i])
    }
  }

  const applied = []
  for (const index of targets) {
    const block = anchorBlock(messages[index])
    if (!block) continue
    stampBlock(block, ttl)
    applied.push(index)
  }

  return { messages, applied }
}

// ─────────────────── 一致性检查 ───────────────────

function systemBlocks(system) {
  if (Array.isArray(system)) return system
  if (system && typeof system === 'object') return [system]
  return []
}

/** system 的可打断点块数：字符串算一块，单对象算一块，数组按元素数 */
function countSystemBlocks(system) {
  if (typeof system === 'string') return system ? 1 : 0
  return systemBlocks(system).length
}

/**
 * system 统一规整成块数组（字符串 → 单 text 块，单对象 → 单元素数组）。
 * 空值返回空数组，调用方据此判断"没有 system"。
 */
function toSystemBlocks(system) {
  if (typeof system === 'string') return system ? [{ type: 'text', text: system }] : []
  if (Array.isArray(system)) return system
  if (system && typeof system === 'object') return [system]
  return []
}

function countSystemMarkers(system) {
  let count = 0
  for (const block of systemBlocks(system)) {
    if (block && typeof block === 'object' && block.cache_control) count += 1
  }
  return count
}

function countToolMarkers(tools) {
  if (!Array.isArray(tools)) return 0
  let count = 0
  for (const tool of tools) {
    if (tool && typeof tool === 'object' && tool.cache_control) count += 1
  }
  return count
}

/**
 * 扫描 messages 的标记分布。
 * 返回逐条消息的标记数（用于发现重复落点）以及与 thinking 块冲突的标记。
 */
function scanMessageMarkers(messages) {
  const perMessage = new Map()
  const thinking = []
  let count = 0
  if (!Array.isArray(messages)) return { count, perMessage, thinking }

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    if (!message || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || typeof block !== 'object' || !block.cache_control) continue
      count += 1
      perMessage.set(i, (perMessage.get(i) || 0) + 1)
      if (isUncacheableBlock(block)) thinking.push(i)
    }
  }
  return { count, perMessage, thinking }
}

/**
 * 出站前的一致性检查。只返回问题列表，不做任何修改。
 *
 * 检查项：
 *   1. system 标记数应为 2（身份句 + 主提示词）
 *   2. messages 标记数不应超过 2
 *   3. 三个区的标记总数不超过 4（上游硬限制，含 tools）
 *   4. 同一条消息上不应出现多个标记
 *   5. thinking / redacted_thinking 块上不应出现标记
 *
 * @param {object} body 请求体（system / tools / messages）
 * @param {object} [opts]
 * @param {number} [opts.expectedSystemMarkers] 期望的 system 标记数，缺省 2
 * @param {number} [opts.maxMessageMarkers]     messages 标记上限，缺省 2
 * @returns {Array<{code:string, message:string, [key:string]:any}>} 问题列表，空数组表示通过
 */
export function auditCacheBreakpoints(body, opts = {}) {
  const problems = []
  const expectedSystem = Number.isInteger(opts.expectedSystemMarkers)
    ? opts.expectedSystemMarkers
    : 2
  const maxMessages = Number.isInteger(opts.maxMessageMarkers)
    ? opts.maxMessageMarkers
    : MAX_MESSAGE_BREAKPOINTS

  const system = countSystemMarkers(body?.system)
  const tools = countToolMarkers(body?.tools)
  const scanned = scanMessageMarkers(body?.messages)
  const messages = scanned.count
  const total = system + tools + messages

  if (system !== expectedSystem) {
    problems.push({
      code: 'system_markers_mismatch',
      message: `system cache_control 数量为 ${system}，期望 ${expectedSystem}`,
      actual: system,
      expected: expectedSystem,
    })
  }

  if (messages > maxMessages) {
    problems.push({
      code: 'message_markers_exceeded',
      message: `messages cache_control 数量为 ${messages}，上限 ${maxMessages}`,
      actual: messages,
      max: maxMessages,
    })
  }

  if (total > MAX_CACHE_MARKERS) {
    problems.push({
      code: 'total_markers_exceeded',
      message: `cache_control 总数为 ${total}，超过上限 ${MAX_CACHE_MARKERS}`,
      actual: total,
      max: MAX_CACHE_MARKERS,
    })
  }

  for (const [index, count] of scanned.perMessage) {
    if (count > 1) {
      problems.push({
        code: 'duplicate_message_marker',
        message: `第 ${index} 条消息上有 ${count} 个 cache_control`,
        index,
        count,
      })
    }
  }

  for (const index of scanned.thinking) {
    problems.push({
      code: 'thinking_marker',
      message: `第 ${index} 条消息的 thinking 块上带有 cache_control`,
      index,
    })
  }

  return problems
}

// ─────────────────── 出站接入点 ───────────────────

/**
 * 给整个请求体打缓存断点：system 两点 + messages 两点，总数 4。
 *
 * 这个函数就是出站流程需要的那一个调用点。**必须在 cch 封盖之前调用**：
 * cch 是对最终字节算的哈希，断点会改变 content 的结构，改完再封盖才对得上。
 *
 * 名额预算：tools 上的 cache_control 由调用方语义决定（工具集本身可能就是
 * 缓存点），因此先数 tools，剩下的名额给 messages；system 固定 2 点。
 * tools 已占满时 messages 会自动收缩，而不是让总数越过 4 被上游拒绝。
 *
 * @param {object} body 请求体（就地修改 system / messages）
 * @param {object} [opts]
 * @param {string}  [opts.ttl]           '5m' | '1h'，缺省 '1h'
 * @param {number}  [opts.maxTotal]      总数上限，缺省 4
 * @param {boolean} [opts.system]        是否处理 system，缺省 true
 * @param {boolean} [opts.messages]      是否处理 messages，缺省 true
 * @param {boolean} [opts.prune]         是否清掉非断点位置的旧标记，缺省 true
 * @returns {{system: number[], messages: number[], total: number, usesExtendedTtl: boolean, problems: Array}}
 */
export function applyCacheBreakpoints(body, opts = {}) {
  const ttl = normalizeCacheTtl(opts.ttl)
  const maxTotal = Number.isInteger(opts.maxTotal) ? opts.maxTotal : MAX_CACHE_MARKERS
  const out = { system: [], messages: [], total: 0, usesExtendedTtl: false, problems: [] }
  if (!body || typeof body !== 'object') return out

  const wantSystem = opts.system !== false
  const wantMessages = opts.messages !== false

  // tools 的标记不由本模块管理，但占名额，先算进来
  const toolMarkers = countToolMarkers(body.tools)

  // 期望的 system 断点数按"块数能给几个"算，而不是按实际落下几个：
  // 拿实际值当期望会让 system 检查永远通过，失去巡检意义。
  const systemCandidates = countSystemBlocks(body.system)
  const expectedSystem = Math.min(MAX_SYSTEM_BREAKPOINTS, systemCandidates)

  let systemMarkers = 0
  if (wantSystem) {
    // system 允许是字符串或单个块对象：统一规整成块数组，否则断点无处落脚
    const systemBlocks = toSystemBlocks(body.system)
    const { blocks, applied } = applySystemBreakpoints(systemBlocks, { ttl, prune: opts.prune })
    if (systemBlocks.length > 0) body.system = blocks
    out.system = applied
    systemMarkers = applied.length
  } else {
    systemMarkers = countSystemMarkers(body.system)
  }

  const remaining = Math.max(0, maxTotal - toolMarkers - systemMarkers)

  if (wantMessages) {
    const budget = Math.min(MAX_MESSAGE_BREAKPOINTS, remaining)
    if (budget <= 0) {
      // 名额已被 tools + system 吃掉：清掉 messages 的标记，避免超限
      if (Array.isArray(body.messages) && opts.prune !== false) {
        for (const message of body.messages) clearMessageMarkers(message)
      }
      out.messages = []
    } else {
      const { applied } = applyMessageBreakpoints(body.messages, {
        ttl,
        prune: opts.prune,
        maxBreakpoints: budget,
      })
      out.messages = applied
    }
  }

  const messageMarkers = wantMessages
    ? out.messages.length
    : scanMessageMarkers(body.messages).count

  out.total = toolMarkers + systemMarkers + messageMarkers
  // 1h TTL 需要请求声明 extended-cache-ttl 能力，调用方据此补 beta
  out.usesExtendedTtl = ttl === '1h' && out.total > 0
  out.problems = auditCacheBreakpoints(body, { expectedSystemMarkers: expectedSystem })
  return out
}
