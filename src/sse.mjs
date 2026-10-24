/**
 * SSE 整流：把上游结果包装成 Anthropic Messages 形态的流。
 *
 * 职责：生成标准 SSE 事件序列、非流式响应体、响应头，以及把 trailer
 * 元数据（x-usage / x-model / x-stop-reason）合并回控制面状态。
 *
 * 关键约束：
 * 1. SSE 事件之间必须用空行分隔，`data:` 后面必须有一个空格。少任意一个，
 *    客户端解析器会漏事件或读不到数据。
 * 2. 客户端可见的流到 message_stop 就结束，不发送 kin.done。kin.done 是
 *    内核与控制面之间的帧，转发客户端前会被剥掉；只有需要模拟
 *    "内核 → 控制面"这一段时才用 emitKinDone 显式打开。
 * 3. 非流式响应必须带 x-session-id / x-slot / x-generation 三个头，
 *    客户端靠它们做会话续接与并发判定。
 * 4. trailer 头优先于 SSE 内联值：usage / model / stop_reason 以
 *    x-* 头为准，SSE 里的同名字段是兜底。
 */

/** 一行 SSE 事件。`data` 后固定一个空格，事件间固定两个换行。 */
export function sseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * 生成完整 Anthropic Messages 流。
 *
 * 事件顺序固定为：message_start → content_block_start → N×content_block_delta
 * → content_block_stop → message_delta → message_stop。
 * 文本按 chunkSize 切片发 delta，缺省 24 字符一片。
 *
 * @param {{id:string, model:string, text:string, inputTokens:number, outputTokens:number,
 *          slot:string, sessionId:string, generation:number, continuation?:string|null,
 *          chunkSize?:number, emitKinDone?:boolean}} p
 */
export function* messageStream(p) {
  const chunkSize = p.chunkSize || 24
  yield sseEvent('message_start', {
    message: {
      content: [],
      id: p.id,
      model: p.model,
      role: 'assistant',
      stop_reason: null,
      type: 'message',
      usage: { input_tokens: p.inputTokens, output_tokens: 0 },
    },
    type: 'message_start',
  })

  yield sseEvent('content_block_start', {
    content_block: { text: '', type: 'text' },
    index: 0,
    type: 'content_block_start',
  })

  const text = String(p.text || '')
  for (let i = 0; i < text.length; i += chunkSize) {
    yield sseEvent('content_block_delta', {
      delta: { text: text.slice(i, i + chunkSize), type: 'text_delta' },
      index: 0,
      type: 'content_block_delta',
    })
  }

  yield sseEvent('content_block_stop', { index: 0, type: 'content_block_stop' })

  yield sseEvent('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    type: 'message_delta',
    usage: { output_tokens: p.outputTokens },
  })

  yield sseEvent('message_stop', { type: 'message_stop' })

  // kin.done 缺省不发：客户端可见的流里不存在该帧，发出去会被当成未知事件。
  // 仅在显式要求（模拟内核→控制面这一段）时才补，供离线回放与联调用。
  if (p.emitKinDone) {
    yield sseEvent('kin.done', {
      continuation: p.continuation ?? null,
      generation: p.generation,
      pid: null,
      session_id: p.sessionId,
      slot: p.slot,
    })
  }
}

/** 非流式响应体：字段与流式版本保持一致，content 用单 text 块承载全文 */
export function messageBody(p) {
  return {
    id: p.id,
    type: 'message',
    role: 'assistant',
    model: p.model,
    content: [{ type: 'text', text: p.text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: p.inputTokens, output_tokens: p.outputTokens },
  }
}

/** 非流式响应头。三个 x-* 是必需项，客户端依赖它们续接会话与判定并发。 */
export function messageHeaders(p, requestId) {
  return {
    'content-type': 'application/json',
    'x-request-id': requestId || crypto.randomUUID(),
    'x-session-id': p.sessionId,
    'x-slot': p.slot,
    'x-generation': String(p.generation),
  }
}

/**
 * 流式响应头。
 *
 * x-accel-buffering: no 用于关掉中间代理的缓冲，否则事件会被攒成一批才下发；
 * cache-control 带 no-transform 防止代理改写事件流。
 */
export function sseHeaders(p, requestId) {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': requestId || crypto.randomUUID(),
    'x-session-id': p.sessionId,
    'x-slot': p.slot,
    'x-generation': String(p.generation),
  }
}

/**
 * Trailer 元数据 → 控制面合并规则。
 * 返回 { usage, model, stopReason }，null 表示该字段缺省。
 *
 * x-usage 是 JSON 字符串；解析失败时 usage 记为 null 而不是抛错——
 * trailer 只用于补全统计，不该让一次响应因此失败。
 */
export function streamMetaFromHeaders(headers = {}) {
  let usage = null
  if (headers['x-usage']) {
    try {
      usage = JSON.parse(headers['x-usage'])
    } catch {}
  }
  return {
    usage,
    model: headers['x-model'] || null,
    stopReason: headers['x-stop-reason'] || null,
  }
}

/**
 * usage 深合并：对象递归合并一层，标量直接覆盖，数组按标量处理（整体替换）。
 * 只做一层递归是有意的：usage 的嵌套结构固定为两层，更深层整体覆盖即可。
 */
export function mergeUsage(current, next) {
  if (!next || typeof next !== 'object') return current
  const out = { ...(current || {}) }
  for (const [key, value] of Object.entries(next)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = { ...(typeof out[key] === 'object' && out[key] ? out[key] : {}), ...value }
    } else {
      out[key] = value
    }
  }
  return out
}
