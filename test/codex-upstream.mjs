/**
 * Codex 传输层集成测试。
 *
 * 所有请求都由注入的 fetchImpl 处理，不建立任何真实网络连接。
 *
 * 覆盖范围：
 *   1. 出站请求构造：URL 拼接、身份头、zstd 体、body 里的 stream 标志、
 *      content-length 由运行时决定。
 *   2. 响应分类：SSE / JSON / 4xx 三条分支，流式判定不依赖 content-type。
 *   3. executeCodexRequest：换号、冷却时长、失败不解除亲和、成功提交亲和。
 *
 * 运行：node test/codex-upstream.mjs
 */

import zlib from 'node:zlib'
import {
  AccountScheduler,
  CodexUpstream,
  DEFAULT_CHATGPT_BASE,
  buildOutboundHeaders,
  executeCodexRequest,
  normalizeEnvelope,
  normalizeAccount,
  decompressBody,
} from '../src/codex.mjs'

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

// ─────────────── 假上游 ───────────────

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * 构造一个最小的 Response 替身。
 * 只实现 createResponse 实际用到的成员：ok / status / headers.forEach / body / json。
 *
 * body 为 null 时走非流式分支（等价于没有响应体）；
 * jsonBody 只在 .json() 被调用时返回，用于证明流式分支没有触达 .json()。
 */
function fakeResponse({ status = 200, headers = {}, body = null, jsonBody = undefined } = {}) {
  const store = new Map()
  for (const [k, v] of Object.entries(headers)) store.set(String(k).toLowerCase(), String(v))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      forEach(cb) {
        store.forEach((v, k) => cb(v, k))
      },
      get(k) {
        const key = String(k).toLowerCase()
        return store.has(key) ? store.get(key) : null
      },
      has(k) {
        return store.has(String(k).toLowerCase())
      },
    },
    body,
    async json() {
      if (jsonBody === undefined) throw new Error('fake response has no JSON body')
      return jsonBody
    },
  }
}

/** 把若干字符串/字节块包成 ReadableStream（模拟网络分块到达） */
function rawStream(chunks) {
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

/** 单事件 SSE 文本 */
function sseText(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 一段可用的 SSE 响应体：只要非空即可，内容由各用例自己检查 */
function minimalSse() {
  return [
    sseText('response.created', { type: 'response.created', response: { id: 'resp_abc' } }),
    sseText('response.completed', { type: 'response.completed', response: { id: 'resp_abc' } }),
    'data: [DONE]\n\n',
  ]
}

/**
 * 假 fetch：记录每次调用的 url/init，并按 handler 依次产出响应。
 * handler(url, init, callIndex) 返回 Response 替身。
 */
function makeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  impl.calls = calls
  return impl
}

/** 解开出站 body，用于校验压缩前后的内容 */
function decodeOutboundBody(init) {
  return JSON.parse(zlib.zstdDecompressSync(init.body).toString('utf8'))
}

// ─────────────── 1. 请求构造 ───────────────

console.log('\n[1] 出站请求构造')
{
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream(minimalSse()) }))
  const up = new CodexUpstream({
    baseUrl: 'https://upstream.test/backend-api/codex/',
    fetchImpl,
  })
  const account = { id: 'a1', access_token: 'TOKEN_1', chatgpt_account_id: 'ACCT_1' }
  const res = await up.createResponse({
    account,
    body: { model: 'gpt-6-astra', input: [{ role: 'user', content: 'hi' }], store: false, stream: true },
  })

  const { url, init } = fetchImpl.calls[0]

  eq('URL 拼 /responses 且吃掉尾斜杠', url, 'https://upstream.test/backend-api/codex/responses')
  eq('方法为 POST', init.method, 'POST')
  eq('authorization 来自 access_token', init.headers.authorization, 'Bearer TOKEN_1')
  eq('chatgpt-account-id 来自账号', init.headers['chatgpt-account-id'], 'ACCT_1')
  eq('content-encoding 为 zstd', init.headers['content-encoding'], 'zstd')
  eq('accept 要求 SSE', init.headers.accept, 'text/event-stream')
  eq('content-type 为 json', init.headers['content-type'], 'application/json')
  eq('未手动设置 content-length', Object.prototype.hasOwnProperty.call(init.headers, 'content-length'), false)
  eq('content-length 缺省交给运行时', init.headers['content-length'], undefined)

  // body 是压缩后的字节，而非字符串
  eq('body 不是字符串', typeof init.body === 'string', false)
  eq('body 是字节缓冲区', Buffer.isBuffer(init.body) || init.body instanceof Uint8Array, true)
  eq('body 带 zstd 帧头', [...init.body.slice(0, 4)], ZSTD_MAGIC)
  // 重复键值多的 body 压缩率明显，用来确认压缩确实发生而不是原样发送
  const repeated = { model: 'm', input: Array.from({ length: 40 }, () => ({ role: 'user', content: 'aaaa' })) }
  eq('压缩后字节数小于明文', init.body.length < Buffer.byteLength(JSON.stringify(repeated)), true)

  const decoded = decodeOutboundBody(init)
  eq('能解压回原始 JSON', decoded.model, 'gpt-6-astra')
  eq('解压后保留 input', decoded.input, [{ role: 'user', content: 'hi' }])
  eq('body 里带 stream=true', decoded.stream, true)
  eq('store 被强制为 false', decoded.store, false)

  // 流式响应识别
  eq('响应状态 200', res.status, 200)
  eq('content-type 缺失时仍返回流对象', res.stream !== null, true)
  eq('流式分支不返回 json', res.json, null)
  eq('上游未给 content-type', 'content-type' in res.headers, false)
}

{
  // base 无尾斜杠时拼同一个 URL
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream(minimalSse()) }))
  const up = new CodexUpstream({ baseUrl: 'https://upstream.test/backend-api/codex', fetchImpl })
  await up.createResponse({ account: { id: 'a1', access_token: 'T' }, body: { model: 'm' } })
  eq('无尾斜杠 base 拼接一致', fetchImpl.calls[0].url, 'https://upstream.test/backend-api/codex/responses')

  // 多个尾斜杠也要归一
  const up2 = new CodexUpstream({ baseUrl: 'https://upstream.test/codex///', fetchImpl })
  await up2.createResponse({ account: { id: 'a1', access_token: 'T' }, body: { model: 'm' } })
  eq('多重尾斜杠被折叠', fetchImpl.calls[1].url, 'https://upstream.test/codex/responses')

  eq('默认 base 是 Codex 端点', DEFAULT_CHATGPT_BASE, 'https://chatgpt.com/backend-api/codex')
}

{
  // 每次请求的 turn-id 都必须新生成
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream(minimalSse()) }))
  const up = new CodexUpstream({ fetchImpl })
  await up.createResponse({ account: { id: 'a1', access_token: 'T' }, body: { model: 'm' } })
  await up.createResponse({ account: { id: 'a1', access_token: 'T' }, body: { model: 'm' } })
  const t1 = fetchImpl.calls[0].init.headers['x-codex-turn-id']
  const t2 = fetchImpl.calls[1].init.headers['x-codex-turn-id']
  eq('turn-id 是 UUID 形态', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t1), true)
  eq('每次请求重新生成 turn-id', t1 !== t2, true)
}

{
  // 客户端传入的身份头不得覆盖本模块决定的值
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream(minimalSse()) }))
  const up = new CodexUpstream({ fetchImpl })
  await up.createResponse({
    account: { id: 'a1', access_token: 'SECRET', chatgpt_account_id: 'ACCT' },
    body: { model: 'm' },
    incomingHeaders: {
      authorization: 'Bearer CLIENT_TOKEN',
      'chatgpt-account-id': 'CLIENT_ACCT',
      'x-codex-turn-state': 'TS_1',
      'x-not-allowlisted': 'DROP_ME',
    },
  })
  const h = fetchImpl.calls[0].init.headers
  eq('客户端 authorization 不生效', h.authorization, 'Bearer SECRET')
  eq('客户端 account-id 不生效', h['chatgpt-account-id'], 'ACCT')
  eq('白名单头原样透传', h['x-codex-turn-state'], 'TS_1')
  eq('非白名单头被丢弃', 'x-not-allowlisted' in h, false)
}

{
  // buildOutboundHeaders 自身也不能带 content-length / body 派生字段
  const h = buildOutboundHeaders({ account: { access_token: 'T' }, body: { model: 'm' } })
  eq('头构造不含 content-length', Object.prototype.hasOwnProperty.call(h, 'content-length'), false)
  eq('头构造声明 zstd', h['content-encoding'], 'zstd')
  eq('未指定 UA 时用默认 UA', h['user-agent'], 'codex_cli_rs/0.160.0 (linux x86_64)')
}

// ─────────────── 2. 响应分类 ───────────────

console.log('\n[2] 响应分类')
{
  // 200 + SSE，content-type 为 null：必须识别成流式，且绝不调用 json()
  let jsonCalled = false
  const body = rawStream(minimalSse())
  const fetchImpl = makeFetch(() => {
    const r = fakeResponse({ status: 200, body })
    r.json = async () => {
      jsonCalled = true
      throw new Error('stream response must not be read as JSON')
    }
    return r
  })
  const up = new CodexUpstream({ fetchImpl })
  const res = await up.createResponse({ account: { id: 'a1', access_token: 'T' }, body: { model: 'm' } })
  eq('SSE 判定为流式', res.stream !== null, true)
  eq('流式分支没有调用 json()', jsonCalled, false)
  const text = await new Response(res.stream).text()
  eq('流对象可读出原始事件', text.includes('event: response.completed'), true)
}

{
  // 200 + JSON：没有响应体，走非流式
  const payload = { id: 'resp_json', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: null, jsonBody: payload }))
  const up = new CodexUpstream({ fetchImpl })
  const res = await up.createResponse({ account: { id: 'a1', access_token: 'T' }, body: { model: 'm' } })
  eq('命中非流式分支', res.stream, null)
  eq('返回解析后的 json', res.json, payload)
  eq('状态码透传', res.status, 200)
}

{
  // 400：请求本身有问题，json 交给调用方
  const errBody = { error: { message: 'Stream must be set to true', type: 'invalid_request_error' } }
  const fetchImpl = makeFetch(() => fakeResponse({ status: 400, jsonBody: errBody }))
  const up = new CodexUpstream({ fetchImpl })
  const res = await up.createResponse({ account: { id: 'a1', access_token: 'T' }, body: { model: 'm' } })
  eq('400 不带流', res.stream, null)
  eq('400 错误体透传', res.json, errBody)
  eq('400 没有 retry-after', res.retryAfter, null)
}

{
  // 429 + retry-after: 42
  const fetchImpl = makeFetch(() => fakeResponse({
    status: 429,
    headers: { 'retry-after': '42' },
    jsonBody: { error: { message: 'rate limited' } },
  }))
  const up = new CodexUpstream({ fetchImpl })
  const res = await up.createResponse({ account: { id: 'a1', access_token: 'T' }, body: { model: 'm' } })
  eq('429 被标记为失败', res.status, 429)
  eq('解析出 retry-after', res.retryAfter, 42)
}

{
  // 上游给的 x-codex-primary-reset-after-seconds 优先于 retry-after
  const fetchImpl = makeFetch(() => fakeResponse({
    status: 429,
    headers: { 'x-codex-primary-reset-after-seconds': '533366', 'retry-after': '5' },
    jsonBody: { error: {} },
  }))
  const up = new CodexUpstream({ fetchImpl })
  const res = await up.createResponse({ account: { id: 'a1', access_token: 'T' }, body: { model: 'm' } })
  eq('配额窗口头优先', res.retryAfter, 533366)
}

// ─────────────── 3. 换号逻辑 ───────────────

console.log('\n[3] executeCodexRequest 换号')

/** 构造一次 executeCodexRequest 所需的上下文 */
function makeCtx({ accounts, handler, startAt = 1_000_000, maxAttempts = 3 }) {
  let now = startAt
  const clock = { get: () => now, advance: (ms) => { now += ms } }
  const scheduler = new AccountScheduler(accounts, { now: () => clock.get() })
  const fetchImpl = makeFetch(handler)
  const upstream = new CodexUpstream({ fetchImpl })
  const envelope = normalizeEnvelope({
    body: { model: 'gpt-6-astra', input: [{ role: 'user', content: 'hi' }] },
    session_id: 'sess_1',
    stream: true,
  })
  return { clock, scheduler, upstream, fetchImpl, envelope, accounts, maxAttempts }
}

{
  // 第一个账号 429，第二个 200
  const accounts = [
    { id: 'a1', access_token: 'T1', chatgpt_account_id: 'A1' },
    { id: 'a2', access_token: 'T2', chatgpt_account_id: 'A2' },
  ]
  const ctx = makeCtx({
    accounts,
    handler: (url, init, n) => (n === 1
      ? fakeResponse({ status: 429, headers: { 'retry-after': '42' }, jsonBody: { error: { message: 'limited' } } })
      : fakeResponse({ status: 200, body: rawStream(minimalSse()) })),
  })

  const out = await executeCodexRequest({
    upstream: ctx.upstream,
    scheduler: ctx.scheduler,
    accounts,
    envelope: ctx.envelope,
    maxAttempts: ctx.maxAttempts,
  })

  eq('换号后拿到 200', out.status, 200)
  eq('attempts 计为 2', out.attempts, 2)
  eq('最终使用第二个账号', out.accountId, 'a2')
  eq('返回流对象', out.stream !== null, true)
  eq('第二次请求带第二个账号的令牌', ctx.fetchImpl.calls[1].init.headers.authorization, 'Bearer T2')
  eq('第二个账号的 account-id 生效', ctx.fetchImpl.calls[1].init.headers['chatgpt-account-id'], 'A2')

  // 冷却
  eq('失败账号进入冷却', ctx.scheduler.cooldownUntil.get('a1') - ctx.clock.get(), 42_000)
  const snap = ctx.scheduler.snapshot()
  eq('冷却秒数就是 retry-after', snap.accounts[0].cooldown_secs_left, 42)
  eq('成功账号没有冷却', snap.accounts[1].cooldown_secs_left, 0)

  // 亲和
  eq('成功后提交会话亲和', ctx.scheduler.sessionAffinity.get('sess_1'), 'a2')
  eq('失败账号的在途计数已释放', ctx.scheduler.inflight.get('a1'), undefined)
  // 成功返回时流还没被消费，占坑保留给调用方，由 release 收尾
  eq('成功账号占坑保留给调用方', snap.accounts[1].inflight, 1)
  ctx.scheduler.release('a2')
  eq('调用方 release 后归零', ctx.scheduler.inflight.get('a2'), undefined)
}

{
  // 首个账号直接成功：不浪费重试
  const accounts = [{ id: 'a1', access_token: 'T1' }]
  const ctx = makeCtx({ accounts, handler: () => fakeResponse({ status: 200, body: rawStream(minimalSse()) }) })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  eq('一次成功 attempts=1', out.attempts, 1)
  eq('只发一次请求', ctx.fetchImpl.calls.length, 1)
  eq('亲和指向首个账号', ctx.scheduler.sessionAffinity.get('sess_1'), 'a1')
  eq('成功不设冷却', ctx.scheduler.cooldownUntil.has('a1'), false)
}

{
  // 400 不换号：请求本身有问题，重试无意义
  const accounts = [{ id: 'a1', access_token: 'T1' }, { id: 'a2', access_token: 'T2' }]
  const errBody = { error: { message: 'model is not supported when using Codex with a ChatGPT account' } }
  const ctx = makeCtx({ accounts, handler: () => fakeResponse({ status: 400, jsonBody: errBody }) })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  eq('400 直接返回', out.status, 400)
  eq('400 不重试', out.attempts, 1)
  eq('400 只发一次请求', ctx.fetchImpl.calls.length, 1)
  eq('400 错误体原样交给调用方', out.json, errBody)
  eq('400 不进冷却', ctx.scheduler.cooldownUntil.size, 0)
  // 选号时就建立初始亲和；失败路径不解除它（下次仍优先回到同一账号）
  eq('400 不迁移亲和', ctx.scheduler.sessionAffinity.get('sess_1'), 'a1')
}

{
  // 401 视为凭据问题：换号，冷却用默认值
  const accounts = [{ id: 'a1', access_token: 'EXPIRED' }, { id: 'a2', access_token: 'T2' }]
  const ctx = makeCtx({
    accounts,
    handler: (url, init, n) => (n === 1
      ? fakeResponse({ status: 401, jsonBody: { error: { message: 'token expired' } } })
      : fakeResponse({ status: 200, body: rawStream(minimalSse()) })),
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  eq('401 后换号成功', out.status, 200)
  eq('401 换了账号', out.accountId, 'a2')
  eq('401 冷却走默认 30 秒', ctx.scheduler.cooldownUntil.get('a1') - ctx.clock.get(), 30_000)
}

{
  // 全部账号失败：返回最后一个上游错误，attempts 等于已试账号数
  const accounts = [{ id: 'a1', access_token: 'T1' }, { id: 'a2', access_token: 'T2' }]
  const ctx = makeCtx({
    accounts,
    handler: () => fakeResponse({
      status: 429, headers: { 'retry-after': '5' }, jsonBody: { error: { message: 'slow down' } },
    }),
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  // 两个账号都被 429 打进冷却：对外是 429（限流语义要传出去，不能归一成 503）
  eq('全部 429 时对外状态是 429', out.status, 429)
  eq('全部 429 时没有账号', out.accountId, null)
  eq('attempts 等于尝试过的账号数', out.attempts, 2)
  eq('没有返回流', out.stream, null)
  eq('429 错误码是 rate_limited', out.json.error.code, 'rate_limited')
  eq('429 错误类型是 rate_limit_error', out.json.error.type, 'rate_limit_error')
  eq('两次请求都真的发出去', ctx.fetchImpl.calls.length, 2)
  eq('两个账号都进入冷却', ctx.scheduler.cooldownUntil.size, 2)
  // 两个账号的 retry-after 都是 5，最短也是 5
  eq('全部 429 时带 retryAfter', out.retryAfter, 5)
  eq('错误体里也有 retry_after', out.json.error.retry_after, 5)
}

{
  // 三个账号全 500：maxAttempts 内逐个用完
  const accounts = [
    { id: 'a1', access_token: 'T1' },
    { id: 'a2', access_token: 'T2' },
    { id: 'a3', access_token: 'T3' },
  ]
  const ctx = makeCtx({
    accounts,
    handler: () => fakeResponse({ status: 500, jsonBody: { error: { message: 'upstream boom' } } }),
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope, maxAttempts: 3,
  })
  // 5xx 全部失败但没有 429：对外是 503（上游故障不等于限流）
  eq('5xx 全部失败返回 503', out.status, 503)
  eq('5xx 全部失败没有 retryAfter', out.retryAfter, null)
  eq('5xx 全部失败非法 rate_limited', out.json.error.code, 'all_rejected')
  eq('5xx 依次尝试三个账号', out.attempts, 3)
  eq('5xx 请求三次', ctx.fetchImpl.calls.length, 3)
  eq('三个账号都冷却', ctx.scheduler.cooldownUntil.size, 3)
}

{
  // 单账号 429 + maxAttempts 3：第二次 select 抛 all_rejected 即收尾，不会死循环
  const accounts = [{ id: 'a1', access_token: 'T1' }]
  const ctx = makeCtx({
    accounts,
    handler: () => fakeResponse({ status: 429, jsonBody: { error: { message: 'limited' } } }),
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope, maxAttempts: 3,
  })
  eq('单账号 429 对外是 429', out.status, 429)
  eq('单账号 429 错误码是 rate_limited', out.json.error.code, 'rate_limited')
  eq('attempts 为实际发出次数', out.attempts, 1)
  eq('只发一次请求', ctx.fetchImpl.calls.length, 1)
  // 没给 retry-after 头时，冷却用 429 默认的 60 秒
  eq('单账号 429 的 retryAfter 是默认冷却', out.retryAfter, 60)
}

{
  // 两个账号都被 429，但冷却时长不同（42s 与 7s）：
  // retryAfter 必须是较短的那个 —— 最早恢复的账号一可用，客户端就值得重试
  const accounts = [{ id: 'slow', access_token: 'T1' }, { id: 'fast', access_token: 'T2' }]
  const ctx = makeCtx({
    accounts,
    handler: (url, init, n) => fakeResponse({
      status: 429,
      headers: { 'retry-after': n === 1 ? '42' : '7' },
      jsonBody: { error: { message: 'limited' } },
    }),
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  eq('冷却时长不同时对外仍是 429', out.status, 429)
  eq('retryAfter 取最短的那个', out.retryAfter, 7)
  eq('错误体同步最短值', out.json.error.retry_after, 7)
  eq('两个账号各自按自己的 retry-after 冷却',
    [ctx.scheduler.cooldownUntil.get('slow') - ctx.clock.get(),
      ctx.scheduler.cooldownUntil.get('fast') - ctx.clock.get()],
    [42_000, 7_000])
}

{
  // 全部 401：凭据问题不是限流，对外仍为 503
  const accounts = [{ id: 'a1', access_token: 'T1' }, { id: 'a2', access_token: 'T2' }]
  const ctx = makeCtx({
    accounts,
    handler: () => fakeResponse({ status: 401, jsonBody: { error: { message: 'bad token' } } }),
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  eq('全部 401 对外是 503', out.status, 503)
  eq('全部 401 不带 retryAfter', out.retryAfter, null)
  eq('全部 401 不是 rate_limited', out.json.error.code, 'all_rejected')
  eq('全部 401 试过两个账号', out.attempts, 2)
}

{
  // 429 与 5xx 混合：有 429 就按限流上报，retryAfter 只算 429 那个账号
  const accounts = [{ id: 'a1', access_token: 'T1' }, { id: 'a2', access_token: 'T2' }]
  const ctx = makeCtx({
    accounts,
    handler: (url, init, n) => (n === 1
      ? fakeResponse({ status: 500, jsonBody: { error: { message: 'boom' } } })
      : fakeResponse({
        status: 429, headers: { 'retry-after': '11' }, jsonBody: { error: { message: 'limited' } },
      })),
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  eq('混合失败里有 429 时对外是 429', out.status, 429)
  eq('retryAfter 只取 429 账号的冷却', out.retryAfter, 11)
}

{
  // 池子为空：没有任何账号可试，503 且不是限流
  const accounts = [{ id: 'a1', access_token: 'T1' }]
  const ctx = makeCtx({
    accounts,
    handler: () => fakeResponse({ status: 200, body: rawStream(minimalSse()) }),
  })
  // AccountScheduler 不接受空数组，这里用替身覆盖 no_candidates 分支
  const emptyScheduler = {
    now: () => ctx.clock.get(),
    cooldownUntil: new Map(),
    select() { throw Object.assign(new Error('no account can take this request'), { code: 'no_candidates' }) },
    release() {},
    commitSuccess() {},
    markCooldown() {},
  }
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: emptyScheduler, accounts, envelope: ctx.envelope,
  })
  eq('无账号时返回 503', out.status, 503)
  eq('无账号时错误码是 no_candidates', out.json.error.code, 'no_candidates')
  eq('无账号时没有 retryAfter', out.retryAfter, null)
  eq('无账号时一次请求都不发', ctx.fetchImpl.calls.length, 0)
}

{
  // 账号在进入前就全部冷却：一次请求都不发
  const accounts = [{ id: 'a1', access_token: 'T1' }]
  const ctx = makeCtx({ accounts, handler: () => fakeResponse({ status: 200, body: rawStream(minimalSse()) }) })
  ctx.scheduler.markCooldown('a1', { retryAfter: 60 })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  eq('预先冷却时不发请求', ctx.fetchImpl.calls.length, 0)
  // 本次请求一次都没打上游，没有任何 429 证据：保持 503，不凭空报限流
  eq('预先冷却时仍返回 503', out.status, 503)
  eq('预先冷却时没有 retryAfter', out.retryAfter, null)
  eq('预先冷却时 attempts 为 0', out.attempts, 0)
}

{
  // 冷却期内亲和账号不可用：回落到另一个账号，且失败不解除旧亲和
  const accounts = [{ id: 'a1', access_token: 'T1' }, { id: 'a2', access_token: 'T2' }]
  const ctx = makeCtx({
    accounts,
    handler: (url, init, n) => (n === 1
      ? fakeResponse({ status: 500, jsonBody: { error: { message: 'boom' } } })
      : fakeResponse({ status: 200, body: rawStream(minimalSse()) })),
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  eq('回落账号接管请求', out.accountId, 'a2')
  eq('成功后亲和迁到新账号', ctx.scheduler.sessionAffinity.get('sess_1'), 'a2')
  eq('旧账号仍在冷却中', ctx.scheduler.cooldownUntil.get('a1') - ctx.clock.get(), 30_000)
}


// ─────────────── 4. 头归属与流式判定 ───────────────

/**
 * 本节守住三条约定，都是曾经出过错的地方：
 *   1. content-length 由运行时按实际字节数填写，客户端传什么都不能影响出站请求；
 *   2. 身份/会话/编码头由本模块决定，客户端传入的值一律不采用；
 *   3. 流式与否由请求决定，不看响应 content-type，也不看恒定的 accept。
 */

console.log('\n[4] 头归属与流式判定')

{
  // content-length 必须被丢弃：客户端带的 999999 与实际压缩体长无关，
  // 出站请求里不能出现该头，交给运行时按实际字节数填写。
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream(minimalSse()) }))
  const up = new CodexUpstream({ fetchImpl })
  await up.createResponse({
    account: { id: 'a1', access_token: 'T' },
    body: { model: 'm' },
    incomingHeaders: { 'content-length': '999999' },
  })
  const { init } = fetchImpl.calls[0]
  eq('客户端 content-length 不进出站头',
    Object.prototype.hasOwnProperty.call(init.headers, 'content-length'), false)
  eq('出站头没有可被误读的 content-length', init.headers['content-length'], undefined)
  eq('实际发出的体仍按压缩后字节数计', init.body.length > 0, true)
}

{
  // x-codex-turn-id / session-id / content-encoding 都是本模块决定的头。
  // 客户端传入的值不得覆盖，尤其是 turn-id：复用旧值会让多轮被归并成同一轮。
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream(minimalSse()) }))
  const up = new CodexUpstream({ fetchImpl })
  await up.createResponse({
    account: { id: 'a1', access_token: 'T' },
    body: { model: 'm' },
    session: { session_id: 'SESS_OWN' },
    incomingHeaders: {
      'x-codex-turn-id': 'CLIENT_TURN_ID',
      'session-id': 'CLIENT_SESSION',
      'content-encoding': 'gzip',
      'chatgpt-account-id': 'CLIENT_ACCT',
      authorization: 'Bearer CLIENT_TOKEN',
      // 这一条不属于本模块决定的头，应当照常透传
      'x-codex-turn-state': 'TS_UPSTREAM',
    },
  })
  const h = fetchImpl.calls[0].init.headers
  eq('客户端 turn-id 被忽略', h['x-codex-turn-id'] !== 'CLIENT_TURN_ID', true)
  eq('turn-id 仍为 UUID 形态',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(h['x-codex-turn-id']), true)
  eq('客户端 session-id 被忽略', h['session-id'], 'SESS_OWN')
  eq('客户端 content-encoding 被忽略', h['content-encoding'], 'zstd')
  eq('客户端 authorization 被忽略', h.authorization, 'Bearer T')
  eq('未提供 account-id 时不写该头', 'chatgpt-account-id' in h, false)
  eq('x-codex-turn-state 照常透传', h['x-codex-turn-state'], 'TS_UPSTREAM')

  // 账号带 account-id 时，客户端值同样不生效
  const fetchImpl2 = makeFetch(() => fakeResponse({ status: 200, body: rawStream(minimalSse()) }))
  const up2 = new CodexUpstream({ fetchImpl: fetchImpl2 })
  await up2.createResponse({
    account: { id: 'a1', access_token: 'T', chatgpt_account_id: 'ACCT_OWN' },
    body: { model: 'm' },
    incomingHeaders: { 'chatgpt-account-id': 'CLIENT_ACCT' },
  })
  eq('客户端 account-id 被忽略', fetchImpl2.calls[0].init.headers['chatgpt-account-id'], 'ACCT_OWN')
}

{
  // stream:false 时上游不会回 JSON（它会 400），因此非流式结果由事件流聚合而来。
  // 这里给一段不含 response.completed 的残流，确认兜底聚合仍返回对象而不是抛错。
  const fetchImpl = makeFetch(() => fakeResponse({
    status: 200,
    body: rawStream([
      sseText('response.created', { type: 'response.created', response: { id: 'resp_partial', model: 'm' } }),
      sseText('response.output_text.delta', { type: 'response.output_text.delta', delta: 'part' }),
    ]),
  }))
  const up = new CodexUpstream({ fetchImpl })
  const res = await up.createResponse({
    account: { id: 'a1', access_token: 'T' },
    body: { model: 'm', stream: false },
  })
  eq('残流也返回 json 对象', typeof res.json, 'object')
  eq('残流不返回流对象', res.stream, null)
  eq('残流兜底标为 incomplete', res.json?.status, 'incomplete')
  eq('残流保留已收到的文本', res.json?.output?.[0]?.content?.[0]?.text, 'part')
}

{
  // stream:false 时上游仍只走流式线协议（stream:false 会被 400 拒绝），
  // 因此客户端要的非流式结果由上游事件流聚合而成，而不是对一条空的 json() 取结果。
  // 这里给上游一段完整 SSE，确认返回的是聚合好的 response 对象。
  const payload = { id: 'resp_json', output: [] }
  const fetchImpl = makeFetch(() => fakeResponse({
    status: 200,
    body: rawStream([
      sseText('response.created', { type: 'response.created', response: { id: 'resp_json', model: 'm' } }),
      sseText('response.output_text.delta', { type: 'response.output_text.delta', delta: 'ok' }),
      sseText('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_json',
          object: 'response',
          status: 'completed',
          model: 'm',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
      'data: [DONE]\n\n',
    ]),
    jsonBody: payload,
  }))
  const up = new CodexUpstream({ fetchImpl })
  const res = await up.createResponse({
    account: { id: 'a1', access_token: 'T' },
    body: { model: 'm', stream: false },
  })
  eq('非流式请求不返回流对象', res.stream, null)
  eq('非流式请求返回聚合后的 response id', res.json?.id, 'resp_json')
  eq('非流式请求聚合出 status', res.json?.status, 'completed')
  eq('非流式请求聚合出 output_text',
    res.json?.output?.[0]?.content?.[0]?.text, 'ok')
  eq('非流式请求聚合出 usage', res.json?.usage?.total_tokens, 2)
  // 上游线协议永远是 stream:true
  eq('出站 body 恒为 stream=true', decodeOutboundBody(fetchImpl.calls[0].init).stream, true)
}

{
  // stream:false 且响应完全没有 body：不能崩，返回空 json
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: null }))
  const up = new CodexUpstream({ fetchImpl })
  const res = await up.createResponse({
    account: { id: 'a1', access_token: 'T' },
    body: { model: 'm', stream: false },
  })
  eq('无 body 的非流式请求不返回流', res.stream, null)
  eq('无 body 的非流式请求 json 为空', res.json, null)
}

{
  // 显式 stream 入参优先于 body.stream
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream(minimalSse()) }))
  const up = new CodexUpstream({ fetchImpl })
  const res = await up.createResponse({
    account: { id: 'a1', access_token: 'T' },
    body: { model: 'm' },
    stream: false,
  })
  eq('显式 stream=false 覆盖缺省', res.stream, null)

  const fetchImpl2 = makeFetch(() => fakeResponse({ status: 200, body: rawStream(minimalSse()) }))
  const up2 = new CodexUpstream({ fetchImpl: fetchImpl2 })
  const res2 = await up2.createResponse({
    account: { id: 'a1', access_token: 'T' },
    body: { model: 'm' },
    stream: true,
  })
  eq('显式 stream=true 生效', res2.stream !== null, true)
  eq('显式 stream=true 时不返回 json', res2.json, null)
}

{
  // stream:true 且 content-type 为 null：仍必须识别为流式，且绝不调用 json()
  let jsonCalled = false
  const fetchImpl = makeFetch(() => {
    const r = fakeResponse({ status: 200, body: rawStream(minimalSse()) })
    r.json = async () => {
      jsonCalled = true
      throw new Error('stream response must not be read as JSON')
    }
    return r
  })
  const up = new CodexUpstream({ fetchImpl })
  const res = await up.createResponse({
    account: { id: 'a1', access_token: 'T' },
    body: { model: 'm', stream: true },
  })
  eq('stream:true 判定为流式', res.stream !== null, true)
  eq('stream:true 未调用 json()', jsonCalled, false)
  eq('响应没有 content-type 也能判定流式', 'content-type' in res.headers, false)
}

// ─────────────── 5. executeCodexRequest 的占坑与流式透传 ───────────────

console.log('\n[5] executeCodexRequest 占坑与流式透传')

{
  // 成功时占坑保留给调用方，返回值里必须带 accountId 供其 release
  const accounts = [{ id: 'a1', access_token: 'T1' }]
  const ctx = makeCtx({ accounts, handler: () => fakeResponse({ status: 200, body: rawStream(minimalSse()) }) })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  eq('成功返回 accountId', out.accountId, 'a1')
  eq('成功时占坑保留', ctx.scheduler.inflight.get('a1'), 1)
  eq('成功标记 streamed', out.streamed, true)
  ctx.scheduler.release(out.accountId)
  eq('按返回的 accountId 可释放', ctx.scheduler.inflight.get('a1'), undefined)
}

{
  // 失败路径就地释放，accountId 为 null 时不残留占坑
  const accounts = [{ id: 'a1', access_token: 'T1' }, { id: 'a2', access_token: 'T2' }]
  const ctx = makeCtx({
    accounts,
    handler: () => fakeResponse({ status: 429, headers: { 'retry-after': '5' }, jsonBody: { error: {} } }),
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope,
  })
  eq('全失败时 accountId 为 null', out.accountId, null)
  eq('全失败时无残留占坑', ctx.scheduler.inflight.size, 0)
  eq('全失败时 streamed 为 false', out.streamed, false)
}

{
  // envelope.stream=false：调用方要完整结果，上游仍走流式线协议，
  // 因此这里拿到的是聚合后的 json，而不是流对象。
  const accounts = [{ id: 'a1', access_token: 'T1' }]
  const ctx = makeCtx({
    accounts,
    handler: () => fakeResponse({
      status: 200,
      body: rawStream([
        sseText('response.created', { type: 'response.created', response: { id: 'resp_json', model: 'm' } }),
        sseText('response.output_text.delta', { type: 'response.output_text.delta', delta: 'ok' }),
        sseText('response.completed', {
          type: 'response.completed',
          response: {
            id: 'resp_json', object: 'response', status: 'completed', model: 'm',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
        'data: [DONE]\n\n',
      ]),
    }),
  })
  const envelope = normalizeEnvelope({
    body: { model: 'gpt-6-astra', input: [{ role: 'user', content: 'hi' }] },
    session_id: 'sess_json',
    stream: false,
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope,
  })
  eq('非流式 envelope 返回聚合 response', out.json?.id, 'resp_json')
  eq('非流式 envelope 不返回流', out.stream, null)
  eq('非流式 envelope 标记 streamed=false', out.streamed, false)
  eq('非流式 envelope 聚合出文本', out.json?.output?.[0]?.content?.[0]?.text, 'ok')
  // 上游线协议恒为流式：客户端要非流式也不能把 false 发过去
  eq('出站 body 的 stream 恒为 true', decodeOutboundBody(ctx.fetchImpl.calls[0].init).stream, true)
  ctx.scheduler.release(out.accountId)
}

{
  // 单账号连续 5xx：冷却后无法再选，占坑不能泄漏在 inflight 里
  const accounts = [{ id: 'a1', access_token: 'T1' }]
  const ctx = makeCtx({
    accounts,
    handler: () => fakeResponse({ status: 500, jsonBody: { error: {} } }),
  })
  const out = await executeCodexRequest({
    upstream: ctx.upstream, scheduler: ctx.scheduler, accounts, envelope: ctx.envelope, maxAttempts: 3,
  })
  eq('单账号 5xx 后归一为 503', out.status, 503)
  eq('单账号 5xx 后不泄漏占坑', ctx.scheduler.inflight.size, 0)
}


// ── 回归：createResponse 必须自己兜住 store/stream ──
//
// 这两条规则原先只在 buildOutboundBody 里实现，而 createResponse 是
// 另一条独立入口（脚本、测试、其它模块都会直接调）。
// createResponse 只兜了 stream:true，没兜 store:false —— 于是所有
// 不走完整链路的调用一律被上游 400 "Store must be set to false"。
// 真实 token 实测才发现：容器内手写 curl 通（带了 store:false），
// 走内核代码却 400。
{
  const sent = []
  const fakeFetch = async (url, init) => {
    // body 可能被 zstd 压缩过（运行时支持时内核会压），必须解压再解析
    const raw = decompressBody(init.body)
    sent.push({ url: String(url), init, body: JSON.parse(raw.toString('utf8')) })
    const sse = 'data: {"type":"response.completed"}\n\n'
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const upstream = new CodexUpstream({ fetchImpl: fakeFetch })
  const account = normalizeAccount({
    id: 'acct-store-guard',
    access_token: 'tok',
    expires_at: Date.now() + 3_600_000,
  })

  // 故意传一个"干净"的 body：既没有 store 也没有 stream
  await upstream.createResponse({
    account,
    body: { model: 'gpt-6-astra', input: [{ type: 'message', role: 'user', content: [] }] },
    stream: true,
  })
  const wire = sent.at(-1)?.body ?? {}
  eq('createResponse 兜住 store=false', wire.store, false)
  eq('createResponse 兜住 stream=true', wire.stream, true)

  // 客户端硬传 store:true，也必须被改写
  sent.length = 0
  await upstream.createResponse({
    account,
    body: { model: 'gpt-6-astra', store: true, input: [] },
    stream: true,
  })
  eq('客户端传 store:true 也被改写', sent.at(-1)?.body?.store, false)
}


// ── 回归：createResponse 抛错时不能泄漏并发占坑 ──
//
// 上游过载走的是"HTTP 200 + 流内 response.failed"，聚合阶段抛错。
// 主循环原先没有 try/catch，异常穿透整个函数：
//   - 换号逻辑被跳过；
//   - scheduler.release 也被跳过 → 该账号并发额度永久泄漏。
// 表现是"跑几十次之后突然所有账号都没有可用名额"，极难定位。
{
  const account = normalizeAccount({
    id: 'acct-leak', access_token: 'tok',
    expires_at: Date.now() + 3_600_000, max_concurrency: 2,
  })
  let calls = 0
  const throwingFetch = async () => {
    calls += 1
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-6-astra"}}',
      '',
      'event: error',
      'data: {"type":"error","error":{"code":"server_is_overloaded","message":"overloaded"}}',
      '',
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_is_overloaded","message":"overloaded"}}}',
      '',
      '',
    ].join('\n')
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const scheduler = new AccountScheduler([account])
  const upstream = new CodexUpstream({ fetchImpl: throwingFetch })

  const out = await executeCodexRequest({
    upstream, scheduler,
    envelope: { body: { model: 'gpt-6-astra', input: [] } },
    stream: false,
  })
  eq('流内失败上报为失败状态', out.status >= 400, true)
  eq('inflight 没有泄漏', scheduler.inflight.size === 0, true)
  eq('确实打到了上游', calls > 0, true)

  const before = calls
  const out2 = await executeCodexRequest({
    upstream, scheduler,
    envelope: { body: { model: 'gpt-6-astra', input: [] } },
    stream: false,
  })
  eq('第二次仍能真正发出请求', calls > before || out2.status >= 400, true)
  eq('第二次后 inflight 仍为空', scheduler.inflight.size === 0, true)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
