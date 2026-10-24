/**
 * codex-server 的本地集成验证：注入假 fetch，不建立真实网络连接。
 *
 * 覆盖：单账号/多账号两种凭据形态、Chat 双向转换、非流式聚合、
 * 上游 400/429 的错误映射、并发计数平衡、客户端断开时 abort 上游。
 *
 * 用法：node test/codex-server.mjs
 */

import http from 'node:http'
import zlib from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCodexHandler } from '../src/codex-server.mjs'

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const a = JSON.stringify(got); const b = JSON.stringify(want)
  if (a === b) { pass += 1; console.log('  ok   ', name) }
  else { fail += 1; console.log('  FAIL ', name, '\n    got ', a, '\n    want', b) }
}
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ok   ', name) }
  else { fail += 1; console.log('  FAIL ', name, detail === undefined ? '' : `\n    ${detail}`) }
}

/** 造一段与真实上游同构的 SSE 文本 */
function buildUpstreamSse({ text = '收到', model = 'gpt-6-astra', respId = 'resp_test' } = {}) {
  const frames = [
    ['response.created', { type: 'response.created', response: { id: respId, model, status: 'in_progress', output: [] } }],
    ['response.output_item.added', {
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', content: [], phase: 'final_answer' },
    }],
    ['response.content_part.added', {
      type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    }],
    ...text.split('').map((ch) => ['response.output_text.delta', {
      type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: ch,
    }]),
    ['response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_1', text }],
    ['response.output_item.done', {
      type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
    }],
    ['response.completed', {
      type: 'response.completed',
      response: {
        id: respId, object: 'response', status: 'completed', model,
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
      },
    }],
  ]
  return frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
}

/**
 * 假 fetch：返回 SSE 响应（content-type 故意不给，复刻上游的坑）。
 *
 * headers 可以是对象，也可以是 (callIndex) => 对象，
 * 后者用于"两个账号拿到不同 retry-after"这类按次变化的场景。
 */
function makeFakeFetch({
  sse = buildUpstreamSse(), status = 200, json = null, onCall = () => {}, headers = null,
} = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    onCall(url, init, calls.length)
    if (status !== 200) {
      const extra = typeof headers === 'function' ? (headers(calls.length) || {}) : (headers || {})
      return new Response(JSON.stringify(json ?? { detail: 'boom' }), {
        status, headers: { 'content-type': 'application/json', ...extra },
      })
    }
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse))
        c.close()
      },
    })
    // 关键：不给 content-type，与真实上游一致
    const okExtra = typeof headers === 'function' ? (headers(calls.length) || {}) : (headers || {})
    return new Response(body, { status: 200, headers: { 'x-codex-plan-type': 'pro', ...okExtra } })
  }
  fn.calls = calls
  return fn
}

function makeTempCredential(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cred-'))
  const file = path.join(dir, 'cred.json')
  fs.writeFileSync(file, JSON.stringify(content))
  return { file, dir }
}

/** 起一个只挂 codex handler 的 http server，返回 { port, close } */
async function startServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      if (await handler.handle(req, res)) return
      res.writeHead(404); res.end()
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500); res.end() }
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { port, close: () => new Promise((r) => server.close(r)) }
}

async function request({ port, route, method = 'POST', body, headers = {} }) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch {}
  return { status: res.status, headers: Object.fromEntries(res.headers), text, parsed }
}

// ═══════════════ 1. 单账号形态 ═══════════════

console.log('\n1. 单账号凭据（Codex CLI 导出形状）')
{
  const cred = makeTempCredential({
    access_token: 'TOKEN_SINGLE',
    account_id: 'acct-single',
    expired: '2099-01-01T00:00:00+08:00',
    refresh_token: 'rt',
    email: 'a@b.c',
    type: 'codex',
  })
  const fake = makeFakeFetch()
  const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
  eq('单账号被识别', handler.credentialShape, 'single')
  eq('账号 id 用 account_id', handler.accounts[0].id, 'acct-single')
  eq('account_id 映射到 chatgpt_account_id', handler.accounts[0].chatgpt_account_id, 'acct-single')
  ok('expired 被解析成 unix 秒', handler.accounts[0].expires_at > 4e9, String(handler.accounts[0].expires_at))

  const srv = await startServer(handler)
  try {
    const r = await request({
      port: srv.port, route: '/v1/chat/completions',
      body: { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hi' }] },
    })
    eq('非流式状态码', r.status, 200)
    eq('非流式 object', r.parsed.object, 'chat.completion')
    eq('非流式内容', r.parsed.choices[0].message.content, '收到')
    eq('非流式 finish_reason', r.parsed.choices[0].finish_reason, 'stop')
    eq('非流式 usage 字段名是 prompt_tokens', r.parsed.usage.prompt_tokens, 12)

    // 上游请求体检查
    const call = fake.calls[0]
    const bodyBuf = call.init.body
    const zlib = await import('node:zlib')
    const sent = JSON.parse(zlib.zstdDecompressSync(Buffer.from(bodyBuf)).toString())
    eq('发出 upstream 时 stream 显式为 true', sent.stream, true)
    eq('store 被强制 false', sent.store, false)
    eq('input 用 input_text', sent.input[0].content[0].type, 'input_text')
    eq('上游请求头带 Bearer', call.init.headers.authorization, 'Bearer TOKEN_SINGLE')
    eq('上游请求头带 account-id', call.init.headers['chatgpt-account-id'], 'acct-single')
    ok('未手动设 content-length', !('content-length' in call.init.headers), JSON.stringify(Object.keys(call.init.headers)))

    // 并发计数必须回到 0
    eq('请求结束后 inflight 归零', handler.scheduler.snapshot().accounts[0].inflight, 0)
  } finally { await srv.close() }
}

// ═══════════════ 2. 多账号形态 ═══════════════

console.log('\n2. 多账号凭据 {"accounts":[...]}')
{
  const cred = makeTempCredential({
    accounts: [
      { id: 'a1', access_token: 'T1', chatgpt_account_id: 'c1', expires_at: 4102444800 },
      { id: 'a2', access_token: 'T2', chatgpt_account_id: 'c2', expires_at: 4102444800 },
    ],
  })
  const fake = makeFakeFetch()
  const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
  eq('多账号被识别', handler.credentialShape, 'multi')
  eq('两个账号', handler.accounts.length, 2)
  eq('账号顺序保持', handler.accounts.map((a) => a.id), ['a1', 'a2'])

  const srv = await startServer(handler)
  try {
    // 第一个请求走扫描 → a1
    await request({
      port: srv.port, route: '/v1/chat/completions',
      body: { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'x' }] },
    })
    eq('首个请求用 a1', fake.calls[0].init.headers.authorization, 'Bearer T1')

    // 带同一 session-id 的第二个请求应该亲和到 a1
    await request({
      port: srv.port, route: '/v1/chat/completions',
      headers: { 'session-id': 'sess-1' },
      body: { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'y' }] },
    })
    eq('新 session 走 a1（首个可用）', fake.calls[1].init.headers.authorization, 'Bearer T1')
    const r3 = await request({
      port: srv.port, route: '/v1/chat/completions',
      headers: { 'session-id': 'sess-1' },
      body: { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'z' }] },
    })
    eq('同 session 第三请求仍走 a1', fake.calls[2].init.headers.authorization, 'Bearer T1')
    ok('会话亲和已建立', handler.scheduler.snapshot().session_affinity > 0)
    eq('多账号下仍正确返回', r3.parsed.choices[0].message.content, '收到')
  } finally { await srv.close() }
}

// ═══════════════ 3. 错误映射 ═══════════════

console.log('\n3. 上游错误映射')
{
  const cred = makeTempCredential({ access_token: 'T', account_id: 'a', expired: '2099-01-01T00:00:00Z' })

  // 400：不重试，原样透传 detail
  {
    const fake = makeFakeFetch({ status: 400, json: { detail: 'Unsupported parameter: temperature' } })
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
    const srv = await startServer(handler)
    try {
      const r = await request({ port: srv.port, route: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } })
      eq('400 状态透传', r.status, 400)
      ok('400 文案带上游 detail', r.parsed.error.message.includes('temperature'), r.parsed.error.message)
      eq('400 不重试（只调一次）', fake.calls.length, 1)
      eq('400 后 inflight 归零', handler.scheduler.snapshot().accounts[0].inflight, 0)
    } finally { await srv.close() }
  }

  // 429 单账号：上游限流要原样传给客户端（429 + Retry-After），不能归一成 503
  {
    // 上游没给 retry-after 头时用 429 的默认冷却 60 秒
    const fake = makeFakeFetch({ status: 429, json: { detail: 'rate limited' } })
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
    const srv = await startServer(handler)
    try {
      const r = await request({ port: srv.port, route: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } })
      eq('单账号 429 对外是 429', r.status, 429)
      eq('429 带 Retry-After 头', r.headers['retry-after'], '60')
      eq('429 错误类型', r.parsed.error.type, 'rate_limit_error')
      eq('429 错误码', r.parsed.error.code, 'rate_limited')
      eq('错误体里的 retry_after 与头一致', r.parsed.error.retry_after, 60)
      eq('429 后 inflight 归零', handler.scheduler.snapshot().accounts[0].inflight, 0)
      ok('429 后账号进入冷却', handler.scheduler.snapshot().accounts[0].cooldown_secs_left > 0,
        JSON.stringify(handler.scheduler.snapshot().accounts[0]))

      // 冷却期内再请求：不应再打上游。本次没观测到 429，按 503（不是限流）
      const before = fake.calls.length
      const r2 = await request({ port: srv.port, route: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } })
      eq('冷却期内不再打上游', fake.calls.length, before)
      eq('冷却期内返回 503', r2.status, 503)
      eq('冷却期内不带 Retry-After', r2.headers['retry-after'], undefined)
    } finally { await srv.close() }
  }

  // 上游给 retry-after 时，响应头必须是上游那个值
  {
    const fake = makeFakeFetch({
      status: 429,
      json: { detail: 'rate limited' },
      headers: { 'retry-after': '17' },
    })
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
    const srv = await startServer(handler)
    try {
      const r = await request({ port: srv.port, route: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } })
      eq('Retry-After 取上游的值', r.headers['retry-after'], '17')
      eq('响应体 retry_after 同步', r.parsed.error.retry_after, 17)
    } finally { await srv.close() }
  }

  // 双账号 429（冷却时长不同）：对外 429，Retry-After 取较短的那个
  {
    const multi = makeTempCredential({
      accounts: [
        { id: 'a1', access_token: 'T1', chatgpt_account_id: 'c1', expires_at: 4102444800 },
        { id: 'a2', access_token: 'T2', chatgpt_account_id: 'c2', expires_at: 4102444800 },
      ],
    })
    const fake = makeFakeFetch({
      status: 429,
      json: { detail: 'rate limited' },
      headers: (n) => ({ 'retry-after': n === 1 ? '30' : '9' }),
    })
    const handler = createCodexHandler({ credentialPath: multi.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
    const srv = await startServer(handler)
    try {
      const r = await request({ port: srv.port, route: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } })
      eq('双账号全 429 返回 429', r.status, 429)
      eq('双账号 429 的 Retry-After 取较短值', r.headers['retry-after'], '9')
      eq('两个账号都真的试过', fake.calls.length, 2)
      eq('两次用了不同 token',
        [fake.calls[0].init.headers.authorization, fake.calls[1].init.headers.authorization].sort(),
        ['Bearer T1', 'Bearer T2'])
      eq('全部 inflight 归零',
        handler.scheduler.snapshot().accounts.map((a) => a.inflight), [0, 0])
    } finally { await srv.close() }
  }

  // 401：凭据问题不是限流，对外仍是 503（不是 429）
  {
    const fake = makeFakeFetch({ status: 401, json: { detail: 'invalid token' } })
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
    const srv = await startServer(handler)
    try {
      const r = await request({ port: srv.port, route: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } })
      eq('上游 401 对外是 503', r.status, 503)
      eq('401 不带 Retry-After', r.headers['retry-after'], undefined)
      eq('401 的失败码来自调度层', r.parsed.error.code, 'all_rejected')
    } finally { await srv.close() }
  }

  // 5xx：上游故障不是限流，对外 503
  {
    const fake = makeFakeFetch({ status: 503, json: { detail: 'upstream boom' } })
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
    const srv = await startServer(handler)
    try {
      const r = await request({ port: srv.port, route: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } })
      eq('上游 5xx 对外是 503', r.status, 503)
      eq('5xx 不带 Retry-After', r.headers['retry-after'], undefined)
    } finally { await srv.close() }
  }
}

// ═══════════════ 3b. 被丢弃参数的对外可见性 ═══════════════

console.log('\n3b. 丢弃参数的回显（响应头 + WARN 日志）')
{
  const cred = makeTempCredential({ access_token: 'T', account_id: 'a', expired: '2099-01-01T00:00:00Z' })

  /** 收集 logger 调用，用来断言 WARN 日志真的打了 */
  function makeLogger() {
    const warns = []
    const infos = []
    return {
      warns,
      infos,
      logger: { warn: (f, m) => warns.push({ fields: f, message: m }), info: (f, m) => infos.push({ fields: f, message: m }) },
    }
  }

  // 非流式：最直观的一条路径
  {
    const fake = makeFakeFetch()
    const log = makeLogger()
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: log.logger })
    const srv = await startServer(handler)
    try {
      const r = await request({
        port: srv.port,
        route: '/v1/chat/completions',
        body: {
          model: 'm',
          messages: [{ role: 'user', content: 'x' }],
          temperature: 0.5,
          top_p: 0.9,
        },
      })
      eq('带采样参数仍 200', r.status, 200)
      eq('X-Dropped-Params 回显两个字段', r.headers['x-dropped-params'], 'temperature,top_p')
      const warn = log.warns.find((w) => String(w.fields?.dropped || '').length)
      ok('打了 WARN 日志', Boolean(warn), JSON.stringify(log.warns))
      eq('WARN 日志级别可由 logger 体现', Boolean(warn), true)
      ok('WARN 日志带 discarded 字段名',
        Array.isArray(warn.fields.dropped) && warn.fields.dropped.includes('temperature'),
        JSON.stringify(warn?.fields))
      // 出站 body 必须真的没有这两个字段
      const outbound = JSON.parse(zlib.zstdDecompressSync(fake.calls[0].init.body).toString('utf8'))
      eq('出站 body 无 temperature', 'temperature' in outbound, false)
      eq('出站 body 无 top_p', 'top_p' in outbound, false)
    } finally { await srv.close() }
  }

  // 流式：响应头同样要带
  {
    const fake = makeFakeFetch()
    const log = makeLogger()
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: log.logger })
    const srv = await startServer(handler)
    try {
      const r = await request({
        port: srv.port,
        route: '/v1/chat/completions',
        body: { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true, seed: 42 },
      })
      eq('流式请求仍 200', r.status, 200)
      eq('流式响应带 X-Dropped-Params', r.headers['x-dropped-params'], 'seed')
      ok('流事件正常流出', r.text.includes('data:'), r.text.slice(0, 120))
    } finally { await srv.close() }
  }

  // 没丢参数就不该出现这个头
  {
    const fake = makeFakeFetch()
    const log = makeLogger()
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: log.logger })
    const srv = await startServer(handler)
    try {
      const r = await request({
        port: srv.port,
        route: '/v1/chat/completions',
        body: { model: 'm', messages: [{ role: 'user', content: 'x' }] },
      })
      eq('没丢参数时没有该头', r.headers['x-dropped-params'], undefined)
      eq('没丢参数时不打 WARN', log.warns.filter((w) => w.fields?.dropped).length, 0)
    } finally { await srv.close() }
  }

  // /v1/responses 路由同样处理
  {
    const fake = makeFakeFetch()
    const log = makeLogger()
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: log.logger })
    const srv = await startServer(handler)
    try {
      const r = await request({
        port: srv.port,
        route: '/v1/responses',
        body: {
          model: 'm',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          stream: false,
          temperature: 0.3,
        },
      })
      eq('responses 路由丢参数仍 200', r.status, 200)
      eq('responses 路由回显 X-Dropped-Params', r.headers['x-dropped-params'], 'temperature')
      const outbound = JSON.parse(zlib.zstdDecompressSync(fake.calls[0].init.body).toString('utf8'))
      eq('responses 出站 body 无 temperature', 'temperature' in outbound, false)
    } finally { await srv.close() }
  }

  // 顶层 response_format / verbosity 要搬到 text 对象里：
  // 上游只在 text 内认这两个字段，顶层会给 400 Unsupported parameter
  {
    const fake = makeFakeFetch()
    const log = makeLogger()
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: log.logger })
    const srv = await startServer(handler)
    try {
      const r = await request({
        port: srv.port,
        route: '/v1/responses',
        body: {
          model: 'm',
          input: [],
          stream: false,
          response_format: { type: 'json_schema', json_schema: { name: 'O', schema: { type: 'object' } } },
          verbosity: 'low',
        },
      })
      eq('顶层 text 字段仍 200', r.status, 200)
      const outbound = JSON.parse(zlib.zstdDecompressSync(fake.calls[0].init.body).toString('utf8'))
      eq('response_format 被搬进 text.format', outbound.text?.format?.name, 'O')
      eq('verbosity 被搬进 text.verbosity', outbound.text?.verbosity, 'low')
      eq('顶层 response_format 已删除', 'response_format' in outbound, false)
      eq('顶层 verbosity 已删除', 'verbosity' in outbound, false)
      // 这是"改写"不是"丢弃"，所以不该进丢弃清单
      eq('改写不算丢弃', r.headers['x-dropped-params'], undefined)
    } finally { await srv.close() }
  }

  // 客户端已经显式给了 text.format 时不能被顶层字段覆盖
  {
    const fake = makeFakeFetch()
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
    const srv = await startServer(handler)
    try {
      await request({
        port: srv.port,
        route: '/v1/responses',
        body: {
          model: 'm',
          input: [],
          stream: false,
          response_format: { type: 'json_object' },
          text: { format: { type: 'text' } },
        },
      })
      const outbound = JSON.parse(zlib.zstdDecompressSync(fake.calls[0].init.body).toString('utf8'))
      eq('客户端给的 text.format 优先', outbound.text?.format?.type, 'text')
    } finally { await srv.close() }
  }

  // n=1 等价于缺省，不该被当成"丢了一个参数"报警
  {
    const fake = makeFakeFetch()
    const log = makeLogger()
    const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: log.logger })
    const srv = await startServer(handler)
    try {
      const r = await request({
        port: srv.port,
        route: '/v1/chat/completions',
        body: { model: 'm', messages: [{ role: 'user', content: 'x' }], n: 1 },
      })
      eq('n=1 不触发回显', r.headers['x-dropped-params'], undefined)
    } finally { await srv.close() }
  }
}

// ═══════════════ 4. /v1/responses 与 /v1/models ═══════════════

console.log('\n4. /v1/responses 透传与 /v1/models')
{
  const cred = makeTempCredential({ access_token: 'T', account_id: 'a', expired: '2099-01-01T00:00:00Z' })
  const fake = makeFakeFetch()
  const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
  const srv = await startServer(handler)
  try {
    // 流式：应原样流出上游事件名
    const s = await request({
      port: srv.port, route: '/v1/responses',
      body: { model: 'gpt-6-astra', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: true },
    })
    eq('responses 流式 200', s.status, 200)
    ok('流式 content-type 是 SSE', String(s.headers['content-type']).includes('text/event-stream'), s.headers['content-type'])
    ok('事件名原样回流', s.text.includes('event: response.output_text.delta'), s.text.slice(0, 200))
    ok('含 response.completed', s.text.includes('event: response.completed'))
    ok('未设 content-length', !('content-length' in s.headers), JSON.stringify(s.headers))
    ok('带 x-codex 诊断头', 'x-codex-plan-type' in s.headers, JSON.stringify(s.headers))

    // 非流式：聚合成完整 response
    const j = await request({
      port: srv.port, route: '/v1/responses',
      body: { model: 'gpt-6-astra', input: [], stream: false },
    })
    eq('responses 非流式 object', j.parsed.object, 'response')
    eq('responses 非流式 status', j.parsed.status, 'completed')
    eq('responses 非流式文本', j.parsed.output[0].content[0].text, '收到')
    ok('responses 非流式保留上游 usage 结构', j.parsed.usage.input_tokens === 12)

    // models
    const m = await request({ port: srv.port, route: '/v1/models', method: 'GET' })
    eq('models 200', m.status, 200)
    eq('models object', m.parsed.object, 'list')
    ok('models 含默认模型', m.parsed.data.some((x) => x.id === 'gpt-6-astra'))
    eq('models 含九个文本模型', m.parsed.data.filter((x) => x.owned_by === 'openai').length, 9)

    // 方法不匹配
    const w = await request({ port: srv.port, route: '/v1/responses', method: 'GET' })
    eq('GET /v1/responses 405', w.status, 405)
    const w2 = await request({ port: srv.port, route: '/v1/chat/completions', method: 'GET' })
    eq('GET /v1/chat/completions 405', w2.status, 405)

    // 坏请求
    const bad = await request({ port: srv.port, route: '/v1/chat/completions', body: { model: 'm' } })
    eq('缺 messages 400', bad.status, 400)
    ok('缺 messages 有错误文案', String(bad.parsed?.error?.message).includes('messages'), bad.text)
  } finally { await srv.close() }
}

// ═══════════════ 5. 凭据与健康检查 ═══════════════

console.log('\n5. 凭据加载与健康检查')
{
  // 缺失文件必须启动即失败
  let err = null
  try {
    createCodexHandler({ credentialPath: '/nonexistent/nope.json', fetchImpl: makeFakeFetch(), logger: { warn() {}, info() {} } })
  } catch (e) { err = e }
  ok('凭据文件缺失时构造即抛错', err?.message.includes('read credential file'), err?.message)

  // disabled 账号必须报错，不能静默跳过
  const cred = makeTempCredential({ access_token: 'T', account_id: 'a', disabled: true })
  err = null
  try {
    createCodexHandler({ credentialPath: cred.file, fetchImpl: makeFakeFetch(), logger: { warn() {}, info() {} } })
  } catch (e) { err = e }
  ok('disabled 账号被拒', err?.message.includes('disabled'), err?.message)

  // 过期账号：healthz 应该报 needs_refresh
  const expired = makeTempCredential({ access_token: 'T', account_id: 'a', expired: '2020-01-01T00:00:00Z', refresh_token: 'rt' })
  const expiredFetch = makeFakeFetch()
  const handler = createCodexHandler({ credentialPath: expired.file, fetchImpl: expiredFetch, logger: { warn() {}, info() {} } })
  const srv = await startServer(handler)
  try {
    const h = await request({ port: srv.port, route: '/codex/healthz', method: 'GET' })
    eq('过期账号 healthz 503', h.status, 503)
    eq('状态是 expired_refreshable', h.parsed.accounts[0].state, 'expired_refreshable')
    eq('healthz 报 needs_refresh', h.parsed.status, 'needs_refresh')
    ok('healthz 不泄露 token', !h.text.includes('"T"') && !h.text.includes('access_token'), h.text)

    // 过期凭据不该拿死 token 去打上游
    const r = await request({ port: srv.port, route: '/v1/chat/completions', body: { model: 'm', messages: [{ role: 'user', content: 'x' }] } })
    eq('过期凭据请求被 401 拦住', r.status, 401)
    eq('错误码是 needs_refresh', r.parsed.error.code, 'needs_refresh')
    eq('完全没打上游', expiredFetch.calls.length, 0)

    const r2 = await request({ port: srv.port, route: '/v1/responses', body: { model: 'm', input: [] } })
    eq('/v1/responses 同样被拦住', r2.status, 401)
  } finally { await srv.close() }

  // 注入了 refreshFn 时，expired_refreshable 应被视为可用（由 manager 负责刷）
  {
    const h2 = createCodexHandler({
      credentialPath: expired.file,
      fetchImpl: makeFakeFetch(),
      refreshFn: async () => ({ access_token: 'NEW' }),
      logger: { warn() {}, info() {} },
    })
    const s2 = await startServer(h2)
    try {
      const hh = await request({ port: s2.port, route: '/codex/healthz', method: 'GET' })
      eq('有 refreshFn 时 healthz 200', hh.status, 200)
      eq('can_refresh 为 true', hh.parsed.can_refresh, true)
    } finally { await s2.close() }
  }
}

// ═══════════════ 6. 上游中断 / 空流兜底 ═══════════════

console.log('\n6. 异常流兜底')
{
  const cred = makeTempCredential({ access_token: 'T', account_id: 'a', expired: '2099-01-01T00:00:00Z' })
  // 只给两个 delta，没有 completed
  const truncated = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"r","model":"m"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ab"}\n\n',
  ].join('')
  const fake = makeFakeFetch({ sse: truncated })
  const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
  const srv = await startServer(handler)
  try {
    const s = await request({
      port: srv.port, route: '/v1/chat/completions',
      body: { model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true },
    })
    ok('截断流仍以 [DONE] 收尾', s.text.trimEnd().endsWith('data: [DONE]'), s.text.slice(-200))
    ok('截断流有 finish_reason', s.text.includes('"finish_reason":"stop"'), s.text.slice(-400))

    const j = await request({
      port: srv.port, route: '/v1/chat/completions',
      body: { model: 'm', messages: [{ role: 'user', content: 'x' }] },
    })
    eq('截断流非流式仍有内容', j.parsed.choices[0].message.content, 'ab')
    eq('截断流非流式 finish_reason', j.parsed.choices[0].finish_reason, 'length')
    eq('截断后 inflight 归零', handler.scheduler.snapshot().accounts[0].inflight, 0)
  } finally { await srv.close() }
}

// ═══════════════ 7. 客户端断开时 abort 上游 ═══════════════

console.log('\n7. 客户端断开')
{
  const cred = makeTempCredential({ access_token: 'T', account_id: 'a', expired: '2099-01-01T00:00:00Z' })
  let upstreamAborted = false
  // 一个永不结束、但监听 abort 的流
  const fake = async (url, init) => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"r","model":"m"}}\n\n'))
        init.signal?.addEventListener('abort', () => { upstreamAborted = true; try { c.error(new Error('aborted')) } catch {} })
      },
    })
    return new Response(body, { status: 200 })
  }
  const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: { warn() {}, info() {} } })
  const srv = await startServer(handler)
  try {
    const ctrl = new AbortController()
    const p = fetch(`http://127.0.0.1:${srv.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], stream: true }),
      signal: ctrl.signal,
    }).then((r) => r.body.getReader().read()).catch(() => null)
    await new Promise((r) => setTimeout(r, 300))
    ctrl.abort()
    await p
    await new Promise((r) => setTimeout(r, 400))
    ok('客户端断开后上游被 abort', upstreamAborted)
  } finally { await srv.close() }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
