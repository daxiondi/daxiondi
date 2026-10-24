#!/usr/bin/env node
/**
 * cache 断点布局的单元测试。
 *
 * 运行：node test/cache-breakpoints.mjs
 *
 * 覆盖：
 *   一、断点索引规则（0/1/2/3/4/5/10 条消息、末尾不是 user、多 user 间隔）
 *   二、applyMessageBreakpoints 的落地形态（字符串 content / 数组 content / thinking）
 *   三、幂等性、TTL 传递、prune 开关
 *   四、system 侧固定两点（applySystemBreakpoints）
 *   五、auditCacheBreakpoints 的四类检出（数量不符 / 超限 / 重复 / thinking 冲突）
 *
 * 输出格式与其余测试一致：逐条 ok/FAIL，末行「通过 N / 失败 M」。
 */

import {
  applyCacheBreakpoints,
  messageBreakpointIndices,
  applyMessageBreakpoints,
  auditCacheBreakpoints,
  normalizeCacheTtl,
  MAX_CACHE_MARKERS,
  MAX_MESSAGE_BREAKPOINTS,
  MIN_MESSAGES_FOR_TWO_BREAKPOINTS,
  DEFAULT_CACHE_TTL,
} from '../src/cache-breakpoints.mjs'
import { applySystemBreakpoints, systemBreakpointIndices } from '../src/system-layout.mjs'

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass += 1
    console.log('  ok   ', name)
  } else {
    fail += 1
    console.log('  FAIL ', name, '\n         got ', g, '\n         want', w)
  }
}

/** 数一组消息上的 cache_control 总数 */
const scanCount = (messages) =>
  Array.isArray(messages)
    ? messages.reduce(
        (n, m) => n + (Array.isArray(m?.content) ? m.content.filter((b) => b?.cache_control).length : 0),
        0,
      )
    : 0

/** 构造 n 条消息：偶数下标 user，奇数下标 assistant */
const alternating = (n) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }))

/** 构造 n 条全是 user 的消息 */
const allUser = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `u${i}` }))

// ─────────────────── 一、断点索引规则 ───────────────────

eq('常量：总数上限 4', MAX_CACHE_MARKERS, 4)
eq('常量：messages 上限 2', MAX_MESSAGE_BREAKPOINTS, 2)
eq('常量：两条断点的最小消息数', MIN_MESSAGES_FOR_TWO_BREAKPOINTS, 4)
eq('常量：缺省 TTL', DEFAULT_CACHE_TTL, '1h')

eq('0 条消息无断点', messageBreakpointIndices([]), [])
eq('非数组入参返回空', messageBreakpointIndices(null), [])
eq('1 条 user 只打尾点', messageBreakpointIndices([{ role: 'user', content: 'a' }]), [0])
eq('1 条 assistant 无断点', messageBreakpointIndices([{ role: 'assistant', content: 'a' }]), [])
eq('2 条消息只打尾点', messageBreakpointIndices(alternating(2)), [0])
eq('3 条消息只打尾点', messageBreakpointIndices(alternating(3)), [2])
eq('4 条消息打两点', messageBreakpointIndices(alternating(4)), [0, 2])
eq('5 条消息打两点', messageBreakpointIndices(alternating(5)), [2, 4])
eq('10 条消息打两点', messageBreakpointIndices(alternating(10)), [6, 8])

// 末尾不是 user：向前找最近的 user
const tailAssistant = [
  { role: 'user', content: 'a' },
  { role: 'assistant', content: 'b' },
  { role: 'user', content: 'c' },
  { role: 'assistant', content: 'd' },
]
eq('末尾是 assistant 时回退到最近 user', messageBreakpointIndices(tailAssistant), [0, 2])

// 连续多条 assistant：向前跨过它们
const gap = [
  { role: 'user', content: 'a' },
  { role: 'assistant', content: 'b' },
  { role: 'user', content: 'c' },
  { role: 'assistant', content: 'd' },
  { role: 'assistant', content: 'e' },
  { role: 'assistant', content: 'f' },
]
eq('跨过多条 assistant 找上一个 user', messageBreakpointIndices(gap), [0, 2])

// 只有一条 user 但消息数 >= 4：退化为一个点
eq(
  '仅一条 user 退化为一个点',
  messageBreakpointIndices([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'assistant', content: 'c' },
    { role: 'assistant', content: 'd' },
  ]),
  [0],
)
// 首条就是 user、其后全是 assistant：尾点向前跨过它们仍落在 0，且只有一个点
eq(
  '仅一条 user 时不会重复打点',
  messageBreakpointIndices([{ role: 'user', content: 'a' }, ...Array.from({ length: 6 }, (_, i) => ({ role: 'assistant', content: `x${i}` }))]),
  [0],
)

// 全是 user：两点相邻不重合
eq('全 user 四点', messageBreakpointIndices(allUser(4)), [2, 3])
eq('全 user 十点', messageBreakpointIndices(allUser(10)), [8, 9])

// 非 user 角色（system）不参与
eq(
  'system 角色不算断点位',
  messageBreakpointIndices([{ role: 'system', content: 's' }, ...alternating(4)]),
  [1, 3],
)

// 升序保证
const idx = messageBreakpointIndices(alternating(10))
eq('索引升序', idx[0] < idx[1], true)
eq('索引不重复', new Set(idx).size, idx.length)

// ─────────────────── 二、落地形态 ───────────────────

// 字符串 content → 单 text 块数组
const strMsgs = alternating(4)
const strResult = applyMessageBreakpoints(strMsgs)
eq('字符串 content 转块数组', Array.isArray(strMsgs[0].content), true)
eq('转块后 type 为 text', strMsgs[0].content[0].type, 'text')
eq('转块后保留原文', strMsgs[0].content[0].text, 'm0')
eq('返回的 applied 与索引一致', strResult.applied, [0, 2])
eq('返回的 messages 就是入参数组', strResult.messages === strMsgs, true)

// 数组 content → 在最后一个 block 上加
const arrMsgs = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
  { role: 'user', content: [{ type: 'text', text: 'd' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'e' }] },
]
applyMessageBreakpoints(arrMsgs)
eq('数组 content 只标最后一个块', arrMsgs[0].content[1].cache_control.type, 'ephemeral')
eq('数组 content 首块不带标记', arrMsgs[0].content[0].cache_control, undefined)
eq('尾点标在最后一个块', arrMsgs[2].content[0].cache_control.type, 'ephemeral')
eq('非断点消息不被打标', arrMsgs[1].content[0].cache_control, undefined)

// thinking 块不接受标记：向前找可缓存块
const thinkMsgs = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'a' },
      { type: 'redacted_thinking', data: 'x' },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
  { role: 'user', content: [{ type: 'text', text: 'c' }, { type: 'thinking', thinking: 'y' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'd' }] },
]
applyMessageBreakpoints(thinkMsgs)
eq('thinking 块不带标记', thinkMsgs[0].content[1].cache_control, undefined)
eq('redacted_thinking 前一个块承接标记', thinkMsgs[0].content[0].cache_control.type, 'ephemeral')
eq('尾点跳过 thinking 落回 text 块', thinkMsgs[2].content[0].cache_control.type, 'ephemeral')

// 空 content 不产生空块
const emptyMsgs = [{ role: 'user', content: '' }, ...alternating(3)]
const emptyResult = applyMessageBreakpoints(emptyMsgs)
eq('空字符串 content 不落标记', emptyMsgs[0].content, '')
eq('空字符串消息不计入 applied', emptyResult.applied.includes(0), false)

// ─────────────────── 三、幂等 / TTL / prune ───────────────────

const idem = alternating(10)
const first = applyMessageBreakpoints(idem)
const snapshot = JSON.stringify(idem)
const second = applyMessageBreakpoints(idem)
eq('二次调用 applied 相同', second.applied, first.applied)
eq('二次调用字节不变', JSON.stringify(idem), snapshot)
eq('二次调用未增加标记', idem.flatMap((m) => m.content).filter((b) => b.cache_control).length, 2)

const ttlMsgs = alternating(4)
applyMessageBreakpoints(ttlMsgs, { ttl: '5m' })
eq('显式 5m 透传', ttlMsgs[0].content[0].cache_control.ttl, '5m')
applyMessageBreakpoints(ttlMsgs, { ttl: '1h' })
eq('改 TTL 时覆盖旧值', ttlMsgs[0].content[0].cache_control.ttl, '1h')
eq('改 TTL 后仍只有两个标记', ttlMsgs.flatMap((m) => m.content).filter((b) => b.cache_control).length, 2)

eq('TTL 非法值回落缺省', normalizeCacheTtl('7d'), '1h')
eq('TTL 空值回落缺省', normalizeCacheTtl(''), '1h')
eq('TTL 大写归一', normalizeCacheTtl('1H'), '1h')
eq('TTL 未传回落缺省', applyMessageBreakpoints(alternating(4)).messages[0].content[0].cache_control.ttl, '1h')

// prune：默认清掉残留标记
const stale = alternating(4)
stale[1].content = [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }]
applyMessageBreakpoints(stale)
eq('默认清掉非断点位置的旧标记', stale[1].content[0].cache_control, undefined)

// prune: false 保留调用方标记
const keep = alternating(4)
keep[1].content = [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }]
applyMessageBreakpoints(keep, { prune: false })
eq('prune:false 保留旧标记', keep[1].content[0].cache_control.type, 'ephemeral')

// scope 保留
const scoped = alternating(4)
scoped[0].content = [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral', scope: 'org' } }]
applyMessageBreakpoints(scoped)
eq('scope 保留', scoped[0].content[0].cache_control.scope, 'org')
eq('scope 保留时仍写 TTL', scoped[0].content[0].cache_control.ttl, '1h')

// ─────────────────── 四、system 侧固定两点 ───────────────────

eq('system 空数组无断点', systemBreakpointIndices([]), [])
eq('system 单块只打一个', systemBreakpointIndices(['only']), [0])
eq('system 两块首末', systemBreakpointIndices(['a', 'b']), [0, 1])
eq('system 四块首末', systemBreakpointIndices([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text', text: 'c' }, { type: 'text', text: 'd' }]), [0, 3])

const sys = applySystemBreakpoints(['x-anthropic-billing-header: a; cch=00000;', 'identity', '# Environment\n - Timezone: UTC', 'main prompt'])
eq('system 落下两个标记', sys.applied, [0, 3])
eq('system 首块带标记', sys.blocks[0].cache_control.type, 'ephemeral')
eq('system 末块带标记', sys.blocks[3].cache_control.type, 'ephemeral')
eq('system 中间块不带标记', sys.blocks[1].cache_control, undefined)
eq('system 字符串块转对象', sys.blocks[1].type, 'text')
eq('system 标记 TTL 缺省 1h', sys.blocks[0].cache_control.ttl, '1h')
eq('system 幂等', JSON.stringify(applySystemBreakpoints(sys.blocks).blocks), JSON.stringify(sys.blocks))
eq('system 显式 5m', applySystemBreakpoints(['a', 'b'], { ttl: '5m' }).blocks[1].cache_control.ttl, '5m')

// 清掉第三个位置的残留标记
const dirtySys = applySystemBreakpoints(['a', 'b', 'c', 'd'])
eq('system 标记数为 2', dirtySys.blocks.filter((b) => b.cache_control).length, 2)

// ─────────────────── 五、audit 检出 ───────────────────

/** 构造消息：content 一律是数组形态，便于直接改块 */
const blocked = (n) =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `m${i}` }],
  }))

/** 构造一个合规的 body：system 2 点 + messages 2 点 */
function goodBody() {
  const body = {
    system: [{ type: 'text', text: 'billing' }, { type: 'text', text: 'env' }, { type: 'text', text: 'prompt' }],
    messages: blocked(10),
  }
  body.system = applySystemBreakpoints(body.system).blocks
  applyMessageBreakpoints(body.messages)
  return body
}

eq('合规 body 无问题', auditCacheBreakpoints(goodBody()), [])

// 1. system 数量不符
const sysShort = goodBody()
delete sysShort.system[2].cache_control
const sysProblems = auditCacheBreakpoints(sysShort)
eq('system 只有 1 点被检出', sysProblems.some((p) => p.code === 'system_markers_mismatch'), true)
eq('system 检出带实际值', sysProblems.find((p) => p.code === 'system_markers_mismatch')?.actual, 1)

// 2. messages 超过两个
const tooMany = goodBody()
tooMany.messages[0].content[0].cache_control = { type: 'ephemeral', ttl: '1h' }
tooMany.messages[2].content[0].cache_control = { type: 'ephemeral', ttl: '1h' }
tooMany.messages[4].content[0].cache_control = { type: 'ephemeral', ttl: '1h' }
const manyProblems = auditCacheBreakpoints(tooMany)
eq('messages 超 2 个被检出', manyProblems.some((p) => p.code === 'message_markers_exceeded'), true)
eq('messages 检出带实际值', manyProblems.find((p) => p.code === 'message_markers_exceeded')?.actual, 5)

// 3. 总数超 4（含 tools）
const withTools = goodBody()
withTools.tools = [{ name: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } }]
const toolProblems = auditCacheBreakpoints(withTools)
eq('tools 计入总数并检出超限', toolProblems.some((p) => p.code === 'total_markers_exceeded'), true)
eq('总数检出带实际值', toolProblems.find((p) => p.code === 'total_markers_exceeded')?.actual, 5)

// 4. 同一条消息重复打点
const dupBody = goodBody()
dupBody.messages[6].content.push({ type: 'text', text: 'extra', cache_control: { type: 'ephemeral', ttl: '1h' } })
const dupProblems = auditCacheBreakpoints(dupBody)
eq('同一消息重复标记被检出', dupProblems.some((p) => p.code === 'duplicate_message_marker'), true)
eq('重复检出的索引正确', dupProblems.find((p) => p.code === 'duplicate_message_marker')?.index, 6)

// 5. thinking 块带标记
const thinkBody = goodBody()
thinkBody.messages[6].content = [{ type: 'thinking', thinking: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }]
const thinkProblems = auditCacheBreakpoints(thinkBody)
eq('thinking 标记被检出', thinkProblems.some((p) => p.code === 'thinking_marker'), true)

// 6. 空 body 不抛错，只报数量不符
const emptyProblems = auditCacheBreakpoints({})
eq('空 body 只报 system 数量', emptyProblems.filter((p) => p.code !== 'system_markers_mismatch').length, 0)
eq('空 body 报 system 为 0', emptyProblems[0]?.actual, 0)
eq('undefined body 不抛错', auditCacheBreakpoints(undefined).length, 1)

// 7. 自定义阈值
eq('自定义 system 期望值', auditCacheBreakpoints(goodBody(), { expectedSystemMarkers: 1 }).some((p) => p.code === 'system_markers_mismatch'), true)
eq('自定义 messages 上限', auditCacheBreakpoints(goodBody(), { maxMessageMarkers: 1 }).some((p) => p.code === 'message_markers_exceeded'), true)

// 8. system 是单对象（非数组）时也能统计
const singleSystem = { system: { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }, messages: [] }
eq('单对象 system 计为 1', auditCacheBreakpoints(singleSystem, { expectedSystemMarkers: 1 }), [])

// ─────────────────── 六、body 级接入点 ───────────────────

/** 构造一份完整 body：4 块 system + n 条消息 */
function fullBody(n = 10) {
  return {
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: a; cch=00000;' },
      { type: 'text', text: 'identity' },
      { type: 'text', text: '# Environment\n - Timezone: UTC' },
      { type: 'text', text: 'main prompt' },
    ],
    messages: alternating(n),
  }
}

const bodyResult = applyCacheBreakpoints(fullBody(10))
eq('body 级 system 两点', bodyResult.system, [0, 3])
eq('body 级 messages 两点', bodyResult.messages, [6, 8])
eq('body 级总数为 4', bodyResult.total, 4)
eq('body 级 audit 通过', bodyResult.problems, [])

const bodyIdem = fullBody(10)
applyCacheBreakpoints(bodyIdem)
const bodySnapshot = JSON.stringify(bodyIdem)
applyCacheBreakpoints(bodyIdem)
eq('body 级幂等', JSON.stringify(bodyIdem), bodySnapshot)

// 3 条消息：messages 只一点，总数 3
const shortBody = applyCacheBreakpoints(fullBody(3))
eq('3 条消息 messages 一点', shortBody.messages, [2])
eq('3 条消息总数为 3', shortBody.total, 3)

// tools 占用名额：只剩 2 个给 messages 时仍打两点
const toolBody = fullBody(10)
toolBody.tools = [
  { name: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } },
  { name: 'b', cache_control: { type: 'ephemeral', ttl: '1h' } },
]
const toolBudget = applyCacheBreakpoints(toolBody)
eq('tools 占满后 messages 断点收缩为 0', toolBudget.messages, [])
eq('tools 占满后总数仍不超限', toolBudget.total <= MAX_CACHE_MARKERS, true)
eq('tools 占满后 messages 无残留标记', scanCount(toolBody.messages), 0)
eq('tools 占满时 audit 通过', auditCacheBreakpoints(toolBody), [])

// tools 占 1 个名额：messages 仍可打两点（1 + 2 system + 2 messages = 5 超限）
// 实际按预算：4 - 1 - 2 = 1，只留尾点
const oneToolBody = fullBody(10)
oneToolBody.tools = [{ name: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } }]
const oneToolBudget = applyCacheBreakpoints(oneToolBody)
eq('tools 占 1 个名额时 messages 收缩为尾点', oneToolBudget.messages, [8])
eq('tools 占 1 个名额时总数为 4', oneToolBudget.total, 4)
eq('收缩后仍保留尾点', oneToolBody.messages[8].content[0].cache_control.type, 'ephemeral')

// system 关闭：名额全部给 messages（上限仍是 2）
const noSystemBody = fullBody(10)
const noSystem = applyCacheBreakpoints(noSystemBody, { system: false })
eq('关闭 system 时不动 system', noSystem.system, [])
eq('关闭 system 时 messages 仍两点', noSystem.messages, [6, 8])
eq('关闭 system 不计 system 标记', auditCacheBreakpoints(noSystemBody, { expectedSystemMarkers: 0 }), [])

// messages 关闭
const noMessagesBody = fullBody(10)
const noMessages = applyCacheBreakpoints(noMessagesBody, { messages: false })
eq('关闭 messages 时不动 messages', noMessages.messages, [])
eq('关闭 messages 时 system 仍两点', noMessages.system, [0, 3])
eq('关闭 messages 时 messages 无标记', scanCount(noMessagesBody.messages), 0)

// system 为字符串
const strSystemBody = { system: 'plain system', messages: alternating(10) }
const strSystemResult = applyCacheBreakpoints(strSystemBody)
eq('字符串 system 转块并打断点', strSystemResult.system, [0])
eq('字符串 system 原地转数组', Array.isArray(strSystemBody.system), true)
eq('字符串 system 内容保留', strSystemBody.system[0].text, 'plain system')

// TTL 透传
const ttlBody = fullBody(10)
applyCacheBreakpoints(ttlBody, { ttl: '5m' })
eq('body 级 TTL 透传到 system', ttlBody.system[0].cache_control.ttl, '5m')
eq('body 级 TTL 透传到 messages', ttlBody.messages[6].content[0].cache_control.ttl, '5m')

// 扩展 TTL 标志：1h 且确实打了点时为 true
eq('1h 时 usesExtendedTtl 为 true', applyCacheBreakpoints(fullBody(10), { ttl: '1h' }).usesExtendedTtl, true)
eq('5m 时 usesExtendedTtl 为 false', applyCacheBreakpoints(fullBody(10), { ttl: '5m' }).usesExtendedTtl, false)
eq('没有可打点时 usesExtendedTtl 为 false', applyCacheBreakpoints({}).usesExtendedTtl, false)

// 单对象 system：原地转数组并打点
const objSystemBody = { system: { type: 'text', text: 'single block' }, messages: alternating(10) }
const objSystemResult = applyCacheBreakpoints(objSystemBody)
eq('单对象 system 被转成数组', Array.isArray(objSystemBody.system), true)
eq('单对象 system 打一个点', objSystemResult.system, [0])
eq('单对象 system 内容保留', objSystemBody.system[0].text, 'single block')

// 空字符串 system 不产生块
const blankSystemBody = { system: '', messages: alternating(10) }
eq('空字符串 system 不产生块', applyCacheBreakpoints(blankSystemBody).system, [])
eq('空字符串 system 保持为空', blankSystemBody.system, '')

// 非法 body
eq('null body 不抛错', applyCacheBreakpoints(null).total, 0)
eq('空对象不抛错', applyCacheBreakpoints({}).total, 0)
// 没有 system 块就没有可打的断点，期望值为 0，不算问题
eq('空对象 audit 无问题', applyCacheBreakpoints({}).problems, [])


console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
