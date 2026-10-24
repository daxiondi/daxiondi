/**
 * Codex SSE 解析测试。
 *
 * 直接对 CodexUpstream.iterEvents 喂 ReadableStream，不涉及网络与真实上游。
 * 覆盖点为逐帧解析的边界条件：分块切分、行前缀变体、多行 data、空行分隔、
 * 结束标记过滤、畸形 JSON 保留原文。
 *
 * 运行：node test/codex-sse.mjs
 */

import { CodexUpstream } from '../src/codex.mjs'

// ─────────────── 断言器 ───────────────

let pass = 0
let fail = 0

function eq(name, got, want) {
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

// ─────────────── 工具 ───────────────

/** 上游实例只用来取 iterEvents，传输层构造不参与本文件 */
const upstream = new CodexUpstream({ fetchImpl: async () => { throw new Error('no network in this test') } })

/** 把任意块序列包成 ReadableStream；字符串按 UTF-8 编码 */
function streamOf(chunks) {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

/** 收集全部事件 */
async function collect(chunks) {
  const out = []
  for await (const ev of upstream.iterEvents(streamOf(chunks))) out.push(ev)
  return out
}

/** 规范 SSE 帧：event 行 + data 行 + 空行 */
function frame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// ─────────────── 1. 标准事件序列 ───────────────

console.log('\n[1] 标准事件序列')

/**
 * 按上游实际下发的事件种类构造一段完整流。
 * usage 结构与 FINDINGS.md 记录的形态一致（含 tokens details 与 attribution）。
 */
const USAGE = {
  input_tokens: 12,
  output_tokens: 5,
  total_tokens: 17,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
  attribution: {
    items: { msg_abc: { input_tokens: 10, output_tokens: 0, content: [] } },
  },
}

const EVENT_SEQUENCE = [
  ['response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }],
  ['response.in_progress', { type: 'response.in_progress', response: { id: 'resp_1' } }],
  ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_abc', type: 'message' } }],
  ['response.content_part.added', { type: 'response.content_part.added', content_index: 0, part: { type: 'output_text', text: '' } }],
  ['response.output_text.delta', { type: 'response.output_text.delta', content_index: 0, delta: '收' }],
  ['response.output_text.delta', { type: 'response.output_text.delta', content_index: 0, delta: '到' }],
  ['response.metadata', { type: 'response.metadata', metadata: { turn_state: 'TS_LONG_STRING' } }],
  ['response.output_text.done', { type: 'response.output_text.done', text: '收到' }],
  ['response.content_part.done', { type: 'response.content_part.done', content_index: 0 }],
  ['response.output_item.done', { type: 'response.output_item.done', output_index: 0 }],
  ['response.completed', { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: USAGE } }],
]

const FULL_STREAM_TEXT = EVENT_SEQUENCE.map(([name, data]) => frame(name, data)).join('') + 'data: [DONE]\n\n'

{
  const events = await collect([FULL_STREAM_TEXT])
  eq('事件数量与上游一致', events.length, 11)
  eq('事件名逐个匹配', events.map((e) => e.event),
    EVENT_SEQUENCE.map(([name]) => name))
  eq('首个事件是 created', events[0].event, 'response.created')
  eq('末个事件是 completed', events.at(-1).event, 'response.completed')
  eq('data 已解析成对象', typeof events[0].data, 'object')
  eq('data.type 与事件名一致', events[0].data.type, 'response.created')
  eq('response.id 可取', events[0].data.response.id, 'resp_1')

  // 文本增量累加
  const text = events
    .filter((e) => e.event === 'response.output_text.delta')
    .map((e) => e.data.delta)
    .join('')
  eq('delta 累加成完整文本', text, '收到')
  eq('delta 事件两条', events.filter((e) => e.event === 'response.output_text.delta').length, 2)

  // done 事件里的全文与累加结果一致
  const doneEv = events.find((e) => e.event === 'response.output_text.done')
  eq('output_text.done 全文一致', doneEv.data.text, text)

  // usage
  const completed = events.find((e) => e.event === 'response.completed')
  const usage = completed.data.response.usage
  eq('usage.input_tokens', usage.input_tokens, 12)
  eq('usage.output_tokens', usage.output_tokens, 5)
  eq('usage.total_tokens', usage.total_tokens, 17)
  eq('usage 缓存明细', usage.input_tokens_details, { cached_tokens: 0, cache_write_tokens: 0 })
  eq('usage 推理明细', usage.output_tokens_details, { reasoning_tokens: 0 })
  eq('usage attribution 可读', Object.keys(usage.attribution.items), ['msg_abc'])
  eq('usage attribution tokens', usage.attribution.items.msg_abc.input_tokens, 10)
}

{
  // 逐字节喂入：每个事件被切成很多 chunk，也必须拼回同一序列
  const bytes = new TextEncoder().encode(FULL_STREAM_TEXT)
  const chunks = Array.from(bytes, (b) => Uint8Array.of(b))
  const events = await collect(chunks)
  eq('逐字节喂入事件数不变', events.length, 11)
  eq('逐字节喂入事件名不变', events.map((e) => e.event), EVENT_SEQUENCE.map(([n]) => n))
  eq('逐字节喂入文本不变',
    events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta).join(''), '收到')
}

// ─────────────── 2. 分块边界 ───────────────

console.log('\n[2] 分块边界')

{
  // 一个事件被切成两个 chunk：切在 data 行中间
  const whole = frame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'hello' })
  const cut = whole.indexOf('"hello"') + 2
  const events = await collect([whole.slice(0, cut), whole.slice(cut)])
  eq('跨 chunk 的事件只有一个', events.length, 1)
  eq('跨 chunk 的 data 完整', events[0].data.delta, 'hello')
  eq('跨 chunk 事件名保留', events[0].event, 'response.output_text.delta')
}

{
  // 切在事件之间的空行上
  const a = frame('response.created', { type: 'response.created' })
  const b = frame('response.completed', { type: 'response.completed', response: {} })
  const merged = a + b
  const splitAt = a.length + 1 // 落在第二个事件的空行之后
  const events = await collect([merged.slice(0, splitAt), merged.slice(splitAt)])
  eq('空行处切分仍是两个事件', events.length, 2)
  eq('切分后事件名正确', events.map((e) => e.event), ['response.created', 'response.completed'])
}

{
  // 切在 event: 行前缀中间（"eve" | "nt: ..."）
  const whole = frame('response.in_progress', { type: 'response.in_progress' })
  const events = await collect([whole.slice(0, 3), whole.slice(3)])
  eq('前缀被切断仍能识别事件名', events[0]?.event, 'response.in_progress')
  eq('前缀被切断时事件数为 1', events.length, 1)
}

{
  // 三个事件一条条到，每条一个 chunk
  const chunks = EVENT_SEQUENCE.slice(0, 3).map(([n, d]) => frame(n, d))
  const events = await collect(chunks)
  eq('chunk 与事件一一对应', events.length, 3)
  eq('事件顺序保持', events.map((e) => e.event), EVENT_SEQUENCE.slice(0, 3).map(([n]) => n))
}

// ─────────────── 3. data 行变体 ───────────────

console.log('\n[3] data 行变体')

{
  // `data:` 后没有空格
  const text = 'event: response.created\ndata:{"type":"response.created"}\n\n'
  const events = await collect([text])
  eq('data 后无空格也能解析', events.length, 1)
  eq('data 后无空格字段正确', events[0].data.type, 'response.created')
}

{
  // 多个空格
  const text = 'event: response.created\ndata:   {"a":1}\n\n'
  const events = await collect([text])
  eq('data 后多个空格被吃掉', events[0].data.a, 1)
}

{
  // 多行 data 拼接，JSON 被拆到两行
  const text = 'event: response.completed\ndata: {"type":"response.completed",\ndata: "response":{"id":"resp_x"}}\n\n'
  const events = await collect([text])
  eq('多行 data 拼成一个事件', events.length, 1)
  eq('多行 data 以换行连接', events[0].data.response.id, 'resp_x')
}

{
  // 没有 event: 行，只有 data:
  const text = 'data: {"type":"response.created"}\n\n'
  const events = await collect([text])
  eq('缺 event 行仍产出事件', events.length, 1)
  eq('缺 event 行时事件名为 null', events[0].event, null)
  eq('缺 event 行时 data 仍解析', events[0].data.type, 'response.created')
}

{
  // 只有空行：不产出任何事件
  const events = await collect(['\n\n\n\n'])
  eq('纯空行不产出事件', events.length, 0)
}

{
  // 空行把两个 data 分组隔开
  const text = 'data: {"n":1}\n\ndata: {"n":2}\n\n'
  const events = await collect([text])
  eq('空行分隔出两个事件', events.length, 2)
  eq('第一个事件 n=1', events[0].data.n, 1)
  eq('第二个事件 n=2', events[1].data.n, 2)
}

{
  // CRLF 行尾
  const text = 'event: response.created\r\ndata: {"a":true}\r\n\r\n'
  const events = await collect([text])
  eq('CRLF 行尾可解析', events.length, 1)
  eq('CRLF 下事件名正确', events[0].event, 'response.created')
  eq('CRLF 下 data 正确', events[0].data.a, true)
}

// ─────────────── 4. 结束标记与畸形输入 ───────────────

console.log('\n[4] 结束标记与畸形输入')

{
  // [DONE] 不作为事件产出
  const text = frame('response.created', { type: 'response.created' }) + 'data: [DONE]\n\n'
  const events = await collect([text])
  eq('[DONE] 被过滤', events.length, 1)
  eq('[DONE] 之前的事件保留', events[0].event, 'response.created')
}

{
  // 只有 [DONE]
  const events = await collect(['data: [DONE]\n\n'])
  eq('仅 [DONE] 时零事件', events.length, 0)
}

{
  // 多个 [DONE] 也全部过滤
  const events = await collect(['data: [DONE]\n\ndata: [DONE]\n\n'])
  eq('重复 [DONE] 全部过滤', events.length, 0)
}

{
  // 畸形 JSON：不抛异常，data 保留原文
  const text = 'event: response.output_text.delta\ndata: {not json\n\n'
  const events = await collect([text])
  eq('畸形 JSON 不中断解析', events.length, 1)
  eq('畸形 JSON 保留原文', events[0].data, '{not json')
  eq('畸形 JSON 仍带事件名', events[0].event, 'response.output_text.delta')
}

{
  // 畸形 JSON 后面跟着正常事件：后续事件不受影响
  const text = 'event: bad\ndata: <<<garbage>>>\n\n'
    + frame('response.completed', { type: 'response.completed', response: { usage: USAGE } })
  const events = await collect([text])
  eq('畸形事件后仍继续解析', events.length, 2)
  eq('后续事件正常解析', events[1].event, 'response.completed')
  eq('后续事件 usage 可读', events[1].data.response.usage.total_tokens, 17)
}

{
  // 未知事件名：原样透出，不丢弃
  const text = frame('response.some_future_event', { type: 'response.some_future_event', extra: 1 })
  const events = await collect([text])
  eq('未知事件名被透出', events[0].event, 'response.some_future_event')
  eq('未知事件 payload 完整', events[0].data.extra, 1)
}

{
  // 注释行（以 : 开头）不产出事件
  const text = ': keep-alive\n\n' + frame('response.created', { type: 'response.created' })
  const events = await collect([text])
  eq('注释行不产出事件', events.length, 1)
  eq('注释行后的正常事件保留', events[0].event, 'response.created')
}

{
  // 空流
  const events = await collect([])
  eq('空流零事件', events.length, 0)
}

{
  // 流没有以空行收尾时，最后一个事件留在缓冲里不产出
  const events = await collect([frame('response.created', { type: 'response.created' }).trimEnd()])
  eq('缺尾部空行时末事件不产出', events.length, 0)
}

{
  // 非 ASCII 文本跨 chunk 拆在 UTF-8 字节中间
  const whole = frame('response.output_text.delta', { delta: '收到回复' })
  const bytes = new TextEncoder().encode(whole)
  const cut = whole.indexOf('收') // 「收」的字节起点
  const encCut = new TextEncoder().encode(whole.slice(0, cut)).length + 1 // 落在一个多字节字符内部
  const events = await collect([bytes.slice(0, encCut), bytes.slice(encCut)])
  eq('UTF-8 字符跨 chunk 不乱码', events[0]?.data?.delta, '收到回复')
}

// ─────────────── 5. 与传输层的接合 ───────────────

console.log('\n[5] 与传输层接合')

{
  // createResponse 交给 iterEvents 的流必须能被完整消费
  const bodyStream = streamOf([FULL_STREAM_TEXT])
  const up = new CodexUpstream({
    baseUrl: 'https://upstream.test/backend-api/codex',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { forEach() {} },
      body: bodyStream,
      async json() { throw new Error('must not read json from stream') },
    }),
  })
  const res = await up.createResponse({ account: { id: 'a1', access_token: 'T' }, body: { model: 'm' } })
  const events = []
  for await (const ev of up.iterEvents(res.stream)) events.push(ev)
  eq('传输层流可直接迭代', events.length, 11)
  eq('迭代到 completed', events.at(-1).event, 'response.completed')
  eq('最终 usage 可取', events.at(-1).data.response.usage.total_tokens, 17)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
