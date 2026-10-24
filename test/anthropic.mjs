/**
 * Anthropic HTTP 出站客户端测试。
 *
 * 全部用注入的 fetchImpl 驱动，不建立真实网络连接。真实上游验证在
 * scripts/anthropic-smoke.mjs 里，这里只保证「发出去的字节形态」和
 * 「读回来的字节解释」两件事正确。
 *
 * 覆盖：
 *   1. URL 归一（三种 baseUrl 写法）
 *   2. 请求头：身份 / 协议 / 内容 / stainless 逐个字段断言
 *   3. betas：头合并、body 内部字段不进 wire 体
 *   4. stream 标志：流式必须有、非流式必须没有该键（不是 false）
 *   5. content-length 不出现在出站头里
 *   6. 压缩：真压缩才带 content-encoding，阈值以下不压，压了反而更大也不压
 *   7. 错误分类：401/429/529/5xx/4xx/网络
 *   8. SSE 解析：单行 data、多行 data、event 字段、注释行、[DONE]、半包收尾
 *   9. 聚合：text / tool_use / thinking、usage 合并、错误事件
 *  10. 超时与 abort
 *  11. 凭据加载：单账号 / 多账号 / 官方 claudeAiOauth / 状态机
 *  12. 配置校验：base_url 必须 https + api.anthropic.com
 *
 * 运行：node test/anthropic.mjs
 */

import zlib from 'node:zlib'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {
  AnthropicUpstream,
  ANTHROPIC_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_COMPRESS_THRESHOLD,
  ERROR_KIND,
  MODE,
  SseParser,
  applyStreamFlag,
  buildOutboundHeaders,
  classifyStatus,
  collectMessage,
  encodeBody,
  headerOf,
  headersToObject,
  mergeUsage,
  messagesUrl,
  parseRetryAfter,
  parseSseText,
  readTextLimited,
  redactHeaders,
  buildBetaHeader,
  resolveBetaList,
  stripForbiddenHeaders,
  stripInternalFields,
  tokenFromHeaders,
} from '../src/anthropic.mjs'
import {
  EXPIRY_CRITICAL_MS,
  EXPIRY_WARN_MS,
  accountState,
  describeAccount,
  detectAuthScheme,
  isMultiAccountShape,
  isUsable,
  loadCredentialFile,
  loadCredentials,
  parseCredentialText,
  parseExpiryMs,
  resolveCredential,
  selectAccount,
  singleAccountToAccount,
  tokenFromEnv,
} from '../src/anthropic-credentials.mjs'
import { DEFAULT_WORKER_CONFIG, validateAnthropicBaseUrl, validateWorkerConfig } from '../src/config.mjs'
import { officialCliUserAgent, officialStainlessHeaders, claudeCodeAppHeader } from '../src/identity.mjs'
import { BETA, claudeCodeMimicryBetas, joinBetas } from '../src/betas.mjs'
import { prepareOutbound } from '../src/server.mjs'

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

function ok(name, value, detail) {
  if (value) {
    pass += 1
    console.log('  ok   ', name)
  } else {
    fail += 1
    console.log('  FAIL ', name, detail == null ? '' : `\n         ${detail}`)
  }
}

// ─────────────── 假上游 ───────────────

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 最小 Response 替身：只实现 createMessage 用到的成员 */
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

/** 字符串/字节块 → ReadableStream（模拟网络分块到达） */
function rawStream(chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk)
      }
      controller.close()
    },
  })
}

/** 记录调用的假 fetch */
function makeFetch(handler) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  fn.calls = calls
  return fn
}

/** 从出站 init 里取 body 文本（必要时解压） */
function decodeOutboundBody(init) {
  const buf = Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body)
  const encoding = headerOf(headersToObject(init.headers), 'content-encoding')
  if (encoding === 'zstd') return JSON.parse(zlib.zstdDecompressSync(buf).toString('utf8'))
  return JSON.parse(buf.toString('utf8'))
}

function isZstd(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return ZSTD_MAGIC.every((v, i) => b[i] === v)
}

/** 一条完整的 Messages SSE 流（text + 一个 tool_use 块） */
const SAMPLE_SSE = [
  'event: message_start\n',
  'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":11,"output_tokens":1}}}\n\n',
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: ping\n',
  'data: {"type":"ping"}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
  'event: content_block_stop\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}\n\n',
  'event: content_block_stop\n',
  'data: {"type":"content_block_stop","index":1}\n\n',
  'event: message_delta\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":42}}\n\n',
  'event: message_stop\n',
  'data: {"type":"message_stop"}\n\n',
].join('')

function baseUpstream(overrides = {}) {
  return new AnthropicUpstream({
    baseUrl: DEFAULT_BASE_URL,
    fetchImpl: makeFetch(() => fakeResponse({ status: 200, body: rawStream([SAMPLE_SSE]) })),
    timeoutMs: 5_000,
    ...overrides,
  })
}

// ─────────────── 1. URL 归一 ───────────────

console.log('\n1. URL 归一')
eq('缺省 baseUrl', messagesUrl(), 'https://api.anthropic.com/v1/messages')
eq('带尾斜杠', messagesUrl('https://api.anthropic.com/'), 'https://api.anthropic.com/v1/messages')
eq('已带 /v1', messagesUrl('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages')
eq('空串回落缺省', messagesUrl(''), 'https://api.anthropic.com/v1/messages')
eq('多重尾斜杠', messagesUrl('https://api.anthropic.com///'), 'https://api.anthropic.com/v1/messages')
eq('大小写 /V1', messagesUrl('https://api.anthropic.com/V1'), 'https://api.anthropic.com/V1/messages')

// ─────────────── 2. 请求头 ───────────────

console.log('\n2. 请求头')
{
  const headers = buildOutboundHeaders({ token: 'sk-ant-oat01-TEST', betas: [BETA.OAUTH] })
  eq('authorization 用 Bearer', headers.authorization, 'Bearer sk-ant-oat01-TEST')
  eq('anthropic-version', headers['anthropic-version'], ANTHROPIC_VERSION)
  eq('anthropic-version 字面值', headers['anthropic-version'], '2023-06-01')
  eq('anthropic-beta 单值', headers['anthropic-beta'], BETA.OAUTH)
  eq('user-agent 与官方一致', headers['user-agent'], officialCliUserAgent())
  eq('x-app', headers['x-app'], 'cli')
  eq('content-type', headers['content-type'], 'application/json')
  eq('accept 缺省 SSE', headers.accept, 'text/event-stream')
  const stainless = officialStainlessHeaders()
  let allStainless = true
  for (const [key, want] of Object.entries(stainless)) {
    if (headers[key] !== want) allStainless = false
  }
  ok('stainless 全字段一致', allStainless, JSON.stringify(Object.fromEntries(
    Object.keys(stainless).map((k) => [k, headers[k]]),
  )))
  eq('stainless 字段数', Object.keys(stainless).length, 8)
  eq('x-stainless-lang', headers['x-stainless-lang'], 'js')
  eq('x-stainless-os', headers['x-stainless-os'], 'Linux')
  eq('x-stainless-arch', headers['x-stainless-arch'], 'x64')
  eq('x-stainless-runtime', headers['x-stainless-runtime'], 'node')
  eq('x-stainless-package-version', headers['x-stainless-package-version'], '0.128.0')
  eq('x-stainless-timeout', headers['x-stainless-timeout'], '600')
  eq('无 content-length', 'content-length' in headers, false)
  eq('无 content-encoding', 'content-encoding' in headers, false)
}
{
  const headers = buildOutboundHeaders({ token: 'sk-ant-api03-KEY', authScheme: 'api_key' })
  eq('api_key 形态用 x-api-key', headers['x-api-key'], 'sk-ant-api03-KEY')
  eq('api_key 形态不发 authorization', 'authorization' in headers, false)
}
{
  const headers = buildOutboundHeaders({ env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } })
  eq('UA 跟随 entrypoint', headers['user-agent'], 'claude-cli/2.1.296 (external, cli)')
  ok('UA 形如 claude-cli/<ver> (external, ...)', /^claude-cli\/\d+\.\d+\.\d+ \(external, [^)]+\)$/.test(headers['user-agent']), headers['user-agent'])
  eq('无 token 时不发 authorization', 'authorization' in headers, false)
}
{
  const bg = buildOutboundHeaders({ env: { CLAUDE_CODE_SESSION_KIND: 'bg' } })
  eq('session_kind=bg 时 x-app 为 cli-bg', bg['x-app'], 'cli-bg')
  eq('claudeCodeAppHeader 与头一致', claudeCodeAppHeader({ CLAUDE_CODE_SESSION_KIND: 'bg' }), 'cli-bg')
}
{
  const headers = buildOutboundHeaders({ extra: { 'content-length': '999', 'transfer-encoding': 'chunked' } })
  eq('调用方给的 content-length 被剔除', 'content-length' in headers, false)
  eq('调用方给的 transfer-encoding 被剔除', 'transfer-encoding' in headers, false)
  const mixed = stripForbiddenHeaders({ 'Content-Length': 5, 'X-Custom': 'a' })
  eq('键名归一为小写', Object.keys(mixed), ['x-custom'])
  eq('数字值转字符串', stripForbiddenHeaders({ 'x-n': 5 })['x-n'], '5')
  eq('null 值被丢弃', Object.keys(stripForbiddenHeaders({ 'x-n': null })), [])
}

// ─────────────── 3. betas ───────────────

console.log('\n3. betas')
{
  // 出站头（buildBetaHeader）在无输入时给出拟真基础集
  const auto = buildBetaHeader({})
  const mimicry = claudeCodeMimicryBetas()
  let allPresent = true
  for (const beta of mimicry) if (!auto.includes(beta)) allPresent = false
  ok('无输入时出站头含拟真基础集', allPresent, JSON.stringify(auto))
  eq('基础集包含 claude-code beta', auto.includes(BETA.CLAUDE_CODE), true)
  eq('基础集包含 oauth beta', auto.includes(BETA.OAUTH), true)
  eq('纯合并对空输入给空数组', resolveBetaList({}), [])

  const explicit = buildBetaHeader({ headerBetas: ['custom-beta-2025-01-01'], includeMimicry: false })
  eq('includeMimicry=false 不含基础集', explicit.includes(BETA.CLAUDE_CODE), false)
  eq('给的自定义 beta 被保留', explicit.includes('custom-beta-2025-01-01'), true)
  ok('有额外项时基础集仍在', buildBetaHeader({ headerBetas: ['custom-beta-2025-01-01'] }).includes(BETA.CLAUDE_CODE), true)

  const fromString = resolveBetaList({ headerBetas: 'a-1-1, b-2-2 ,,c-3-3' })
  eq('逗号串被拆开并去空', fromString, ['a-1-1', 'b-2-2', 'c-3-3'])

  // resolveBetaList 是纯合并：只去重保序，不注入任何额外项
  const merged = resolveBetaList({ headerBetas: [BETA.OAUTH], bodyBetas: [BETA.CLAUDE_CODE] })
  eq('header + body 纯合并', merged, [BETA.OAUTH, BETA.CLAUDE_CODE])
  const dedup = resolveBetaList({ headerBetas: [BETA.OAUTH, BETA.OAUTH, ' x-1-1 ', 'x-1-1'] })
  eq('纯合并去重保序', dedup, [BETA.OAUTH, 'x-1-1'])
  // 默认集走官方顺序：CLAUDE_CODE 在 OFFICIAL_MESSAGE_BETAS 里排在 OAUTH 之前
  ok('默认集按官方顺序', auto.indexOf(BETA.CLAUDE_CODE) < auto.indexOf(BETA.OAUTH), JSON.stringify(auto))

  // buildBetaHeader 才是出站用的：拟真基础集 ∪ 调用方额外项。
  // 这是硬要求——基础集里的 claude-code / oauth 声明客户端身份与鉴权方式，
  // 丢了它们上游会按另一版协议解释请求（真机上表现为 OAuth token 直接 401）。
  const withBody = buildBetaHeader({ bodyBetas: [BETA.EXTENDED_CACHE_TTL] })
  ok('出站头保留拟真基础集', withBody.includes(BETA.CLAUDE_CODE) && withBody.includes(BETA.OAUTH), JSON.stringify(withBody))
  eq('出站头并入 body 的额外 beta', withBody.includes(BETA.EXTENDED_CACHE_TTL), true)
  ok('基础集排在额外项之前', withBody.indexOf(BETA.CLAUDE_CODE) < withBody.indexOf(BETA.EXTENDED_CACHE_TTL), JSON.stringify(withBody))
  eq('includeMimicry=false 时只留额外项', buildBetaHeader({ bodyBetas: [BETA.EXTENDED_CACHE_TTL], includeMimicry: false }), [BETA.EXTENDED_CACHE_TTL])
  const fromHeader = buildBetaHeader({ headerBetas: 'custom-1-1', includeMimicry: false })
  eq('header beta 也进结果', fromHeader, ['custom-1-1'])
}
{
  const body = stripInternalFields({
    model: 'm',
    messages: [],
    betas: ['x-1-1'],
    __betas__: 'y-2-2',
  })
  eq('body.betas 被摘掉', 'betas' in body, false)
  eq('body.__betas__ 被摘掉', '__betas__' in body, false)
  eq('其余字段保留', body.model, 'm')
  const original = { model: 'm', betas: ['x'] }
  stripInternalFields(original)
  eq('摘字段不改入参', original.betas, ['x'])
}

// ─────────────── 4. stream 标志 ───────────────

console.log('\n4. stream 标志')
eq('STREAM 模式带 stream:true', applyStreamFlag({ model: 'm' }, MODE.STREAM).stream, true)
eq('AGGREGATE 模式带 stream:true', applyStreamFlag({ model: 'm' }, MODE.AGGREGATE).stream, true)
eq('DOCUMENT 模式没有 stream 键', 'stream' in applyStreamFlag({ model: 'm' }, MODE.DOCUMENT), false)
eq('DOCUMENT 模式删掉调用方写的 false', 'stream' in applyStreamFlag({ model: 'm', stream: false }, MODE.DOCUMENT), false)
eq('DOCUMENT 模式删掉调用方写的 true', 'stream' in applyStreamFlag({ model: 'm', stream: true }, MODE.DOCUMENT), false)
eq('applyStreamFlag 不改入参', (() => { const b = { model: 'm' }; applyStreamFlag(b, MODE.STREAM); return b.stream })(), undefined)

// ─────────────── 5. 出站请求整体形态 ───────────────

console.log('\n5. 出站请求整体形态')
{
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream([SAMPLE_SSE]) }))
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  const body = prepareOutbound(
    { model: 'claude-sonnet-4-5', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] },
    { systemLayout: 'zero' },
  )
  const out = await upstream.createMessage({
    body,
    headers: { authorization: 'Bearer sk-ant-oat01-REAL' },
    mode: MODE.STREAM,
  })
  eq('状态码', out.status, 200)
  eq('打到了 /v1/messages', fetchImpl.calls[0].url, 'https://api.anthropic.com/v1/messages')
  eq('method 是 POST', fetchImpl.calls[0].init.method, 'POST')

  const sent = headersToObject(fetchImpl.calls[0].init.headers)
  eq('出站 authorization 原样传递', sent.authorization, 'Bearer sk-ant-oat01-REAL')
  eq('出站 anthropic-version', sent['anthropic-version'], '2023-06-01')
  eq('出站 x-app', sent['x-app'], 'cli')
  eq('出站 accept 是 SSE', sent.accept, 'text/event-stream')
  ok('出站 anthropic-beta 非空', Boolean(sent['anthropic-beta']), sent['anthropic-beta'])
  ok('出站 UA 是官方形态', /^claude-cli\//.test(sent['user-agent']), sent['user-agent'])
  eq('出站无 content-length', 'content-length' in sent, false)

  const wire = decodeOutboundBody(fetchImpl.calls[0].init)
  eq('wire body 带 stream:true', wire.stream, true)
  eq('wire body 没有 betas 字段', 'betas' in wire, false)
  ok('wire body 有 system', Array.isArray(wire.system) && wire.system.length > 0, JSON.stringify(Object.keys(wire)))
  ok('wire body 里的 cch 是 5 位 hex', /cch=[0-9a-f]{5};/.test(wire.system[0].text), wire.system[0].text.slice(0, 120))
  ok(
    'body.betas 折进了头',
    String(sent['anthropic-beta']).includes(BETA.EXTENDED_CACHE_TTL),
    sent['anthropic-beta'],
  )
  eq('出站 body 字节数一致', Buffer.byteLength(JSON.stringify(wire)), out.wireBytes)
}
{
  // 非流式客户端：AGGREGATE 模式下 wire body 仍然带 stream:true
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream([SAMPLE_SSE]) }))
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  const out = await upstream.createMessage({
    body: { model: 'm', max_tokens: 8, messages: [] },
    headers: { authorization: 'Bearer T' },
    mode: MODE.AGGREGATE,
  })
  eq('AGGREGATE 出站带 stream:true', decodeOutboundBody(fetchImpl.calls[0].init).stream, true)
  eq('AGGREGATE 返回聚合结果', out.json?.id, 'msg_01')
}
{
  // DOCUMENT 模式：wire body 不带 stream 键
  const fetchImpl = makeFetch(() => fakeResponse({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: rawStream([JSON.stringify({ id: 'msg_doc', type: 'message', content: [] })]),
  }))
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  const out = await upstream.createMessage({
    body: { model: 'm', max_tokens: 8, messages: [] },
    headers: { authorization: 'Bearer T' },
    mode: MODE.DOCUMENT,
  })
  eq('DOCUMENT 出站没有 stream 键', 'stream' in decodeOutboundBody(fetchImpl.calls[0].init), false)
  eq('DOCUMENT accept 是 JSON', headersToObject(fetchImpl.calls[0].init.headers).accept, 'application/json')
  eq('DOCUMENT 返回解析后的 JSON', out.json?.id, 'msg_doc')
}

// ─────────────── 6. 压缩 ───────────────

console.log('\n6. 压缩')
{
  const big = { model: 'm', messages: [{ role: 'user', content: 'x'.repeat(4000) }] }
  const encoded = encodeBody(big, { threshold: 1024, zstd: zlib.zstdCompressSync })
  eq('大 body 走 zstd', encoded.encoding, 'zstd')
  ok('payload 是 zstd 帧', isZstd(encoded.payload), [...encoded.payload.subarray(0, 4)])
  ok('压缩后更小', encoded.wireBytes < Buffer.byteLength(encoded.jsonText, 'utf8'), `${encoded.wireBytes} vs ${encoded.jsonText.length}`)
  eq('解压回原文', JSON.parse(zlib.zstdDecompressSync(encoded.payload).toString('utf8')).model, 'm')
}
{
  const small = { model: 'm' }
  const encoded = encodeBody(small, { threshold: 1024, zstd: zlib.zstdCompressSync })
  eq('小于阈值不压', encoded.encoding, null)
  eq('不压时 payload 是明文', encoded.payload.toString('utf8'), '{"model":"m"}')
}
{
  const encoded = encodeBody({ model: 'm', messages: [] }, { threshold: 1, zstd: null })
  eq('没有 zstd 时不压', encoded.encoding, null)
  ok('没有 zstd 时不设 content-encoding 的前提成立', !isZstd(encoded.payload), [...encoded.payload.subarray(0, 4)])
}
{
  // 压缩反而变大：不设头。用胶囊化的 zstd 实现模拟（返回更长的 buffer）
  const padded = (buf) => Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('Z'.repeat(buf.length + 64))])
  const encoded = encodeBody({ model: 'm', messages: [] }, { threshold: 1, zstd: padded })
  eq('压缩后更大时不设 content-encoding', encoded.encoding, null)
}
{
  // 端到端：压缩时头里必须有 content-encoding
  const bigBody = { model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'y'.repeat(8000) }] }
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream([SAMPLE_SSE]) }))
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000, compressThreshold: 1024 })
  const out = await upstream.createMessage({ body: bigBody, headers: { authorization: 'Bearer T' }, mode: MODE.STREAM })
  const sent = headersToObject(fetchImpl.calls[0].init.headers)
  eq('压缩时设 content-encoding', sent['content-encoding'], 'zstd')
  eq('压缩时仍无 content-length', 'content-length' in sent, false)
  eq('记录里的 encoding', out.encoding, 'zstd')
  eq('wire 体可解压', decodeOutboundBody(fetchImpl.calls[0].init).model, 'm')
}
{
  // 小 body：绝不能带 content-encoding（否则上游把明文当压缩体 → 裸 Bad Request）
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream([SAMPLE_SSE]) }))
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000, compressThreshold: 1024 })
  const out = await upstream.createMessage({
    body: { model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    headers: { authorization: 'Bearer T' },
    mode: MODE.STREAM,
  })
  eq('小 body 不带 content-encoding', 'content-encoding' in headersToObject(fetchImpl.calls[0].init.headers), false)
  eq('小 body 的 encoding 记录为 null', out.encoding, null)
}

// ─────────────── 7. 错误分类 ───────────────

console.log('\n7. 错误分类')
eq('200 → ok', classifyStatus(200).kind, ERROR_KIND.OK)
eq('2xx 不重试', classifyStatus(201).retryable, false)
eq('401 → needs_refresh', classifyStatus(401).kind, ERROR_KIND.NEEDS_REFRESH)
eq('401 触发刷新标志', classifyStatus(401).needs_refresh, true)
eq('401 不重试', classifyStatus(401).retryable, false)
eq('429 → rate_limited', classifyStatus(429).kind, ERROR_KIND.RATE_LIMITED)
eq('429 可重试', classifyStatus(429).retryable, true)
eq('429 带 retry_after', classifyStatus(429, { retryAfter: 30 }).retry_after, 30)
eq('529 → overloaded', classifyStatus(529).kind, ERROR_KIND.OVERLOADED)
eq('529 可重试', classifyStatus(529).retryable, true)
eq('500 → server_error', classifyStatus(500).kind, ERROR_KIND.SERVER_ERROR)
eq('503 可重试', classifyStatus(503).retryable, true)
eq('400 → invalid_request', classifyStatus(400).kind, ERROR_KIND.INVALID_REQUEST)
eq('400 不重试', classifyStatus(400).retryable, false)
eq('403 → invalid_request', classifyStatus(403).kind, ERROR_KIND.INVALID_REQUEST)
eq('404 → invalid_request', classifyStatus(404).kind, ERROR_KIND.INVALID_REQUEST)
eq('413 不重试', classifyStatus(413).retryable, false)
{
  // 端到端：错误体原样透出，不包装
  const errorBody = JSON.stringify({
    type: 'error',
    error: { type: 'authentication_error', message: 'invalid x-api-key' },
  })
  const fetchImpl = makeFetch(() => fakeResponse({
    status: 401,
    headers: { 'content-type': 'application/json', 'request-id': 'req_abc' },
    body: rawStream([errorBody]),
  }))
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  const out = await upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer bad' } })
  eq('401 状态透出', out.status, 401)
  eq('401 分类为 needs_refresh', out.classification.kind, ERROR_KIND.NEEDS_REFRESH)
  eq('401 原始错误体原样保留', out.text, errorBody)
  eq('401 错误体已解析成 json', out.json?.error?.type, 'authentication_error')
  eq('401 不返回流', out.stream, null)
  eq('401 request-id 头保留', out.headers['request-id'], 'req_abc')
}
{
  // 429 + retry-after 数字
  const fetchImpl = makeFetch(() => fakeResponse({
    status: 429,
    headers: { 'retry-after': '45' },
    body: rawStream([JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })]),
  }))
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  const out = await upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer T' } })
  eq('429 解析出 retry-after', out.retryAfter, 45)
  eq('429 分类', out.classification.kind, ERROR_KIND.RATE_LIMITED)
}
{
  // 529 过载
  const fetchImpl = makeFetch(() => fakeResponse({
    status: 529,
    body: rawStream([JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } })]),
  }))
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  const out = await upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer T' } })
  eq('529 分类为 overloaded', out.classification.kind, ERROR_KIND.OVERLOADED)
  eq('529 可重试', out.classification.retryable, true)
}
{
  // 400 + 纯文本错误体（上游裸 Bad Request 的情形）
  const fetchImpl = makeFetch(() => fakeResponse({ status: 400, body: rawStream(['Bad Request']) }))
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  const out = await upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer T' } })
  eq('纯文本错误体原样保留', out.text, 'Bad Request')
  eq('纯文本错误体没有 json', out.json, null)
  ok('400 分类不重试', out.classification.kind === ERROR_KIND.INVALID_REQUEST && out.classification.retryable === false)
}
eq('retry-after 纯数字', parseRetryAfter({ 'retry-after': '120' }), 120)
eq('retry-after 大小写不敏感', parseRetryAfter({ 'Retry-After': '7' }), 7)
eq('retry-after 带单位不认', parseRetryAfter({ 'retry-after': '30s' }), null)
eq('retry-after 小数不认', parseRetryAfter({ 'retry-after': '1.5' }), null)
eq('retry-after 缺失为 null', parseRetryAfter({}), null)
eq('retry-after 空串为 null', parseRetryAfter({ 'retry-after': '' }), null)
ok('retry-after http-date 转秒', (() => {
  const at = new Date(Date.now() + 60_000).toUTCString()
  const secs = parseRetryAfter({ 'retry-after': at })
  return secs >= 55 && secs <= 61
})(), String(parseRetryAfter({ 'retry-after': new Date(Date.now() + 60_000).toUTCString() })))

// ─────────────── 8. SSE 解析 ───────────────

console.log('\n8. SSE 解析')
{
  const events = parseSseText('event: a\ndata: {"x":1}\n\n')
  eq('单行 data 事件数', events.length, 1)
  eq('event 名', events[0].event, 'a')
  eq('data 已解析', events[0].data, { x: 1 })
}
{
  const events = parseSseText('event: a\ndata: line1\ndata: line2\n\n')
  eq('多行 data 合成一个事件', events.length, 1)
  eq('多行 data 用 \\n 拼接', events[0].data, 'line1\nline2')
}
{
  const events = parseSseText('event: a\ndata: {"a":1,"b":\ndata: 2}\n\n')
  eq('跨行 JSON 正确重组', events[0].data, { a: 1, b: 2 })
}
{
  const events = parseSseText('data: {"x":1}\n\n')
  eq('没有 event 行时 event 为 null', events[0].event, null)
  eq('没有 event 行的 data 仍解析', events[0].data, { x: 1 })
}
{
  const events = parseSseText(': this is a comment\n\n: ping\ndata: {"x":2}\n\n')
  eq('注释行不产生事件', events.length, 1)
  eq('注释行之后的数据正常解析', events[0].data, { x: 2 })
}
{
  const events = parseSseText('event: done\ndata: [DONE]\n\n')
  eq('[DONE] 产生一帧', events.length, 1)
  eq('[DONE] 标记 done', events[0].done, true)
  eq('[DONE] data 保留原文', events[0].data, '[DONE]')
}
{
  const events = parseSseText('data: {"a":1}\n\n: tail-without-blank-line\ndata: {"b":2}')
  eq('末尾半包不会丢', events.length, 2)
  eq('末尾半包的数据完整', events[1].data, { b: 2 })
}
{
  const events = parseSseText('data: not-json-at-all\n\n')
  eq('非 JSON data 原样保留', events[0].data, 'not-json-at-all')
}
{
  const events = parseSseText('data:{"a":1}\n\n')
  eq('data: 后无空格也能解析', events[0].data, { a: 1 })
}
{
  const events = parseSseText('data:  two-spaces\n\n')
  eq('data: 后只去掉一个空格', events[0].data, ' two-spaces')
}
{
  const events = parseSseText('event: a\r\ndata: {"x":1}\r\n\r\n')
  eq('CRLF 行尾能解析', events[0].data, { x: 1 })
  eq('CRLF 下 event 名正确', events[0].event, 'a')
}
{
  const parser = new SseParser()
  const first = parser.push('event: a\ndata: {"x"')
  eq('半个帧不产生事件', first.length, 0)
  const second = parser.push(':1}\n\n')
  eq('拼上后续字节后产生事件', second.length, 1)
  eq('拼接结果正确', second[0].data, { x: 1 })
}
{
  const parser = new SseParser()
  const out = [...parser.push('data: {"a":1}\n\ndata: {"b":2}\n\n'), ...parser.flush()]
  eq('一帧内多个事件', out.length, 2)
}
{
  const events = parseSseText('id: 42\ndata: {"x":1}\n\n')
  eq('id 字段被记录', events[0].id, '42')
}
{
  const events = parseSseText('retry: 5000\ndata: {"x":1}\n\n')
  eq('retry 字段被忽略、数据正常', events[0].data, { x: 1 })
}

// ─────────────── 9. 聚合 ───────────────

console.log('\n9. 非流式聚合')
{
  const message = collectMessage(parseSseText(SAMPLE_SSE))
  eq('聚合 id', message.id, 'msg_01')
  eq('聚合 model', message.model, 'claude-sonnet-4-5')
  eq('聚合 role', message.role, 'assistant')
  eq('聚合 type', message.type, 'message')
  eq('聚合出两个块', message.content.length, 2)
  eq('文本块拼接完成', message.content[0].text, 'Hello')
  eq('工具块 type', message.content[1].type, 'tool_use')
  eq('工具块 id', message.content[1].id, 'toolu_1')
  eq('工具块 name', message.content[1].name, 'get_weather')
  eq('工具块 input 由 partial_json 还原', message.content[1].input, { city: 'SF' })
  eq('stop_reason', message.stop_reason, 'tool_use')
  eq('usage input_tokens 来自 message_start', message.usage.input_tokens, 11)
  eq('usage output_tokens 来自 message_delta', message.usage.output_tokens, 42)
  ok('聚合结果无内部字段泄漏', !JSON.stringify(message).includes('__json'))
  ok('聚合结果无 partial_json 残留', !JSON.stringify(message).includes('partial_json'))
}
{
  const sse = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"m2","model":"x","role":"assistant","usage":{"input_tokens":5,"cache_read_input_tokens":3}}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
  const message = collectMessage(parseSseText(sse))
  eq('thinking 块保留', message.content[0].type, 'thinking')
  eq('thinking_delta 拼接', message.content[0].thinking, 'hmm')
  eq('signature_delta 拼接', message.content[0].signature, 'sig')
  eq('usage 嵌套字段保留', message.usage.cache_read_input_tokens, 3)
  eq('usage 两段合并且不丢', message.usage.output_tokens, 9)
}
{
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m3","model":"x","usage":{}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}\n\n',
  ].join('')
  const message = collectMessage(parseSseText(sse))
  eq('截断流仍能聚合出已收到的文本', message.content[0].text, 'a')
  eq('截断流不编造 stop_reason', message.stop_reason, null)
}
{
  const sse = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"heavy"}}\n\n'
  let caught = null
  try {
    collectMessage(parseSseText(sse))
  } catch (error) {
    caught = error
  }
  ok('error 事件抛错', caught !== null)
  eq('抛错的 code', caught?.code, 'upstream_stream_error')
  eq('抛错里带上游 message', caught?.detail?.error?.message, 'heavy')
}
{
  let caught = null
  try {
    collectMessage([])
  } catch (error) {
    caught = error
  }
  eq('空流抛 empty_stream', caught?.code, 'empty_stream')
}
eq('mergeUsage 标量覆盖', mergeUsage({ a: 1 }, { a: 2 }), { a: 2 })
eq('mergeUsage 对象深合并一层', mergeUsage({ d: { x: 1 } }, { d: { y: 2 } }), { d: { x: 1, y: 2 } })
eq('mergeUsage 数组整体替换', mergeUsage({ a: [1, 2] }, { a: [3] }), { a: [3] })
eq('mergeUsage null 保持原值', mergeUsage({ a: 1 }, null), { a: 1 })

// ─────────────── 10. 流式迭代 ───────────────

console.log('\n10. 流式迭代')
{
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200, body: null })), timeoutMs: 5_000 })
  const events = []
  for await (const frame of upstream.iterEvents(rawStream([SAMPLE_SSE]))) events.push(frame)
  eq('整段流的事件数', events.length, 12)
  eq('首帧是 message_start', events[0].data.type, 'message_start')
  eq('末帧之后没有越界', events[events.length - 1].data.type, 'message_stop')
}
{
  // 逐字节投喂：解析器必须能处理任意切分
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200, body: null })), timeoutMs: 5_000 })
  const chunks = SAMPLE_SSE.split('').map((c) => new TextEncoder().encode(c))
  const events = []
  for await (const frame of upstream.iterEvents(rawStream(chunks))) events.push(frame)
  eq('逐字节投喂后事件数不变', events.length, 12)
  const message = collectMessage(events)
  eq('逐字节投喂后聚合结果相同', message.content[0].text, 'Hello')
}
{
  const upstream = baseUpstream()
  const events = []
  for await (const frame of upstream.iterEvents('data: {"a":1}\n\n')) events.push(frame)
  eq('字符串输入也能迭代', events[0].data, { a: 1 })
}
{
  const upstream = baseUpstream()
  const events = []
  for await (const frame of upstream.iterEvents(null)) events.push(frame)
  eq('null 流返回空迭代', events.length, 0)
}

// ─────────────── 11. 超时与 abort ───────────────

console.log('\n11. 超时与 abort')
{
  const slowFetch = async (url, init) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 200)
      init.signal?.addEventListener?.('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }, { once: true })
    })
    return fakeResponse({ status: 200, body: rawStream([SAMPLE_SSE]) })
  }
  const upstream = new AnthropicUpstream({ fetchImpl: slowFetch, timeoutMs: 30 })
  const out = await upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer T' } })
  eq('超时返回 status 0', out.status, 0)
  eq('超时分类为 network', out.classification.kind, ERROR_KIND.NETWORK)
  ok('超时不计入 aborted', out.classification.aborted === false, JSON.stringify(out.classification))
  ok('超时可重试', out.classification.retryable === true)
}
{
  const slowFetch = async (url, init) => {
    await new Promise((resolve, reject) => {
      init.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      setTimeout(resolve, 5_000)
    })
    return fakeResponse({ status: 200, body: null })
  }
  const controller = new AbortController()
  const upstream = new AnthropicUpstream({ fetchImpl: slowFetch, timeoutMs: 60_000 })
  const pending = upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer T' }, signal: controller.signal })
  setTimeout(() => controller.abort(new Error('client gone')), 20)
  const out = await pending
  eq('外部 abort 返回 status 0', out.status, 0)
  eq('外部 abort 标记 aborted', out.classification.aborted, true)
  eq('外部 abort 不可重试', out.classification.retryable, false)
}
{
  const slowFetch = async (url, init) => {
    await new Promise((resolve, reject) => {
      init.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
    return fakeResponse({ status: 200, body: null })
  }
  const controller = new AbortController()
  controller.abort(new Error('already aborted'))
  const upstream = new AnthropicUpstream({ fetchImpl: slowFetch, timeoutMs: 60_000 })
  const out = await upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer T' }, signal: controller.signal })
  eq('已 abort 的 signal 立即生效', out.status, 0)
  eq('已 abort 的 signal 标记 aborted', out.classification.aborted, true)
}
{
  // fetch 直接抛网络错误
  const upstream = new AnthropicUpstream({
    fetchImpl: async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    },
    timeoutMs: 1_000,
  })
  const out = await upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer T' } })
  eq('网络错误 status 0', out.status, 0)
  eq('网络错误分类', out.classification.kind, ERROR_KIND.NETWORK)
  ok('网络错误信息保留原文', String(out.classification.error).includes('ENOTFOUND'), out.classification.error)
}

// ─────────────── 12. 凭据：时间与状态 ───────────────

console.log('\n12. 凭据：时间与状态')
eq('毫秒时间戳原样', parseExpiryMs(1767225600000), 1767225600000)
eq('秒时间戳转毫秒', parseExpiryMs(1767225600), 1767225600000)
eq('数字字符串按数字处理', parseExpiryMs('1767225600000'), 1767225600000)
eq('ISO 串', parseExpiryMs('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z'))
eq('空串为 null', parseExpiryMs(''), null)
eq('null 为 null', parseExpiryMs(null), null)
eq('非法串为 null', parseExpiryMs('not-a-date'), null)
eq('负数为 null', parseExpiryMs(-1), null)
{
  const now = 1_700_000_000_000
  eq('无到期时间算 fresh', accountState({ access_token: 't' }, { now }), 'fresh')
  eq('无 token 无 refresh 算 missing', accountState({}, { now }), 'missing')
  eq('无 token 有 refresh 算 expired_refreshable', accountState({ refresh_token: 'r' }, { now }), 'expired_refreshable')
  eq('已过期无 refresh 算 expired', accountState({ access_token: 't', expires_at: now - 1 }, { now }), 'expired')
  eq('已过期有 refresh 算 expired_refreshable', accountState({ access_token: 't', refresh_token: 'r', expires_at: now - 1 }, { now }), 'expired_refreshable')
  eq('刷新窗口内算 refresh_window', accountState({ access_token: 't', expires_at: now + EXPIRY_CRITICAL_MS - 1 }, { now }), 'refresh_window')
  eq('可刷新区间算 refreshable', accountState({ access_token: 't', expires_at: now + EXPIRY_WARN_MS - 1 }, { now }), 'refreshable')
  eq('远未到期算 fresh', accountState({ access_token: 't', expires_at: now + EXPIRY_WARN_MS + 1 }, { now }), 'fresh')
  eq('needs_reauth 标记优先', accountState({ access_token: 't', needs_reauth: true }, { now }), 'needs_reauth')
  eq('fresh 可用', isUsable({ access_token: 't' }, { now }), true)
  eq('expired 不可用', isUsable({ access_token: 't', expires_at: now - 1 }, { now }), false)
  eq('needs_reauth 不可用', isUsable({ access_token: 't', needs_reauth: true }, { now }), false)
  eq('expired_refreshable 可用', isUsable({ access_token: 't', refresh_token: 'r', expires_at: now - 1 }, { now }), true)
  eq('selectAccount 跳过不可用', selectAccount([
    { id: 'a', access_token: 't', expires_at: now - 1 },
    { id: 'b', access_token: 'u', expires_at: now + 10_000_000 },
  ], { now })?.id, 'b')
  eq('selectAccount 全不可用时退回可刷新账号', selectAccount([
    { id: 'a', access_token: 't', refresh_token: 'r', expires_at: now - 1 },
  ], { now })?.id, 'a')
  eq('selectAccount allowExpired=false 时返回 null', selectAccount([
    { id: 'a', access_token: 't', refresh_token: 'r', expires_at: now - 1 },
  ], { now, allowExpired: false }), null)
  const described = describeAccount({ id: 'a', access_token: 'x'.repeat(40), refresh_token: 'r' }, { now })
  eq('describeAccount 不吐 token', 'access_token' in described, false)
  eq('describeAccount 给长度', described.token_bytes, 40)
  eq('describeAccount 给状态', described.state, 'fresh')
}

// ─────────────── 13. 凭据：形态解析 ───────────────

console.log('\n13. 凭据：形态解析')
{
  const account = singleAccountToAccount({
    access_token: 'sk-ant-oat01-AAA',
    refresh_token: 'sk-ant-ort01-BBB',
    expires_at: 1767225600,
    subscription_type: 'max',
    email: 'a@b.c',
  })
  eq('单账号 access_token', account.access_token, 'sk-ant-oat01-AAA')
  eq('单账号 refresh_token', account.refresh_token, 'sk-ant-ort01-BBB')
  eq('单账号 expires_at 归一为毫秒', account.expires_at, 1767225600000)
  eq('单账号 subscription_type', account.subscription_type, 'max')
  eq('单账号 email 作为 id', account.id, 'a@b.c')
  eq('OAuth 前缀判定', account.auth_scheme, 'oauth')
}
{
  const apiKey = singleAccountToAccount({ access_token: 'sk-ant-api03-KEY', account_id: 'org_1' })
  eq('api key 前缀判定', apiKey.auth_scheme, 'api_key')
  eq('account_id 作为 id', apiKey.id, 'org_1')
  eq('无到期时间为 null', apiKey.expires_at, null)
}
eq('detectAuthScheme oauth', detectAuthScheme('sk-ant-oat01-x'), 'oauth')
eq('detectAuthScheme api_key', detectAuthScheme('sk-ant-api03-x'), 'api_key')
eq('detectAuthScheme 无前缀按 oauth', detectAuthScheme('opaque'), 'oauth')
eq('detectAuthScheme 尊重显式字段', detectAuthScheme('opaque', { auth_scheme: 'api_key' }), 'api_key')
{
  const camel = singleAccountToAccount({ accessToken: 'sk-ant-oat01-C', refreshToken: 'r', expiresAt: 1767225600000 })
  eq('camelCase accessToken', camel.access_token, 'sk-ant-oat01-C')
  eq('camelCase refreshToken', camel.refresh_token, 'r')
  eq('camelCase expiresAt', camel.expires_at, 1767225600000)
}
{
  let caught = null
  try {
    singleAccountToAccount({})
  } catch (error) {
    caught = error
  }
  ok('缺 access_token 抛错', caught !== null)
  ok('抛错提到 access_token', String(caught?.message).includes('access_token'), caught?.message)
  eq('缺 access_token 的错误文案', caught?.message, 'anthropic credential missing `access_token`')
}
{
  let caught = null
  try {
    singleAccountToAccount({ access_token: 't', disabled: true, email: 'x@y.z' })
  } catch (error) {
    caught = error
  }
  ok('disabled 账号抛错', caught !== null)
  ok('disabled 抛错带 email', String(caught?.message).includes('x@y.z'), caught?.message)
}
// 三种文件形态
{
  const single = parseCredentialText(JSON.stringify({ access_token: 'sk-ant-oat01-S', refresh_token: 'r' }))
  eq('单账号形态 shape', single.shape, 'single')
  eq('单账号形态一个账号', single.accounts.length, 1)

  const multi = parseCredentialText(JSON.stringify({
    accounts: [
      { access_token: 'sk-ant-oat01-A', email: 'a@x' },
      { access_token: 'sk-ant-oat01-B', email: 'b@x' },
    ],
  }))
  eq('多账号形态 shape', multi.shape, 'multi')
  eq('多账号数量', multi.accounts.length, 2)
  eq('多账号 id 各自独立', multi.accounts.map((a) => a.id), ['a@x', 'b@x'])
  eq('isMultiAccountShape 识别 accounts', isMultiAccountShape({ accounts: [] }), true)
  eq('isMultiAccountShape 不误判单账号', isMultiAccountShape({ access_token: 't' }), false)

  const official = parseCredentialText(JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-O', refreshToken: 'rr', expiresAt: 1767225600000, subscriptionType: 'pro' },
  }))
  eq('官方 credentials.json shape', official.shape, 'claude_oauth')
  eq('官方形态 access_token', official.accounts[0].access_token, 'sk-ant-oat01-O')
  eq('官方形态 refresh_token', official.accounts[0].refresh_token, 'rr')
  eq('官方形态 expires_at', official.accounts[0].expires_at, 1767225600000)
  eq('官方形态 subscription', official.accounts[0].subscription_type, 'pro')
}
{
  let caught = null
  try {
    parseCredentialText('not json')
  } catch (error) {
    caught = error
  }
  ok('非法 JSON 抛错', caught !== null)
  ok('抛错提到 JSON', String(caught?.message).includes('JSON'), caught?.message)
}
{
  let caught = null
  try {
    parseCredentialText('[]')
  } catch (error) {
    caught = error
  }
  ok('裸数组被拒', caught !== null)
  ok('裸数组错误文案', String(caught?.message).includes('bare array'), caught?.message)
}
{
  let caught = null
  try {
    parseCredentialText(JSON.stringify({ accounts: [] }))
  } catch (error) {
    caught = error
  }
  ok('空 accounts 数组被拒', caught !== null)
}
// 文件加载
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-cred-'))
  try {
    const file = path.join(dir, 'cred.json')
    fs.writeFileSync(file, JSON.stringify({ access_token: 'sk-ant-oat01-F', expires_at: Date.now() + 86_400_000 }))
    const loaded = loadCredentialFile(file)
    eq('文件加载 shape', loaded.shape, 'single')
    eq('文件加载 token', loaded.accounts[0].access_token, 'sk-ant-oat01-F')
    eq('文件加载带回路径', loaded.path, file)

    const withLogger = loadCredentials(file, { logger: { warn() {} } })
    eq('loadCredentials 返回 states', withLogger.states.length, 1)
    eq('loadCredentials 选中账号', withLogger.account.access_token, 'sk-ant-oat01-F')

    let readError = null
    try {
      loadCredentialFile(path.join(dir, 'nope.json'))
    } catch (error) {
      readError = error
    }
    ok('文件不存在抛错', readError !== null)
    ok('抛错带路径', String(readError?.message).includes('nope.json'), readError?.message)

    let emptyError = null
    try {
      loadCredentialFile('')
    } catch (error) {
      emptyError = error
    }
    ok('空路径抛错', emptyError !== null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
// 环境变量
{
  eq('CLAUDE_CODE_OAUTH_TOKEN 优先', tokenFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-E', ANTHROPIC_API_KEY: 'sk-ant-api03-E' })?.token, 'sk-ant-oat01-E')
  eq('ANTHROPIC_AUTH_TOKEN 次之', tokenFromEnv({ ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-A', ANTHROPIC_API_KEY: 'k' })?.token, 'sk-ant-oat01-A')
  eq('ANTHROPIC_API_KEY 兜底', tokenFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-api03-K' })?.token, 'sk-ant-api03-K')
  eq('API key 的 auth_scheme', tokenFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-api03-K' })?.auth_scheme, 'api_key')
  eq('都没有返回 null', tokenFromEnv({}), null)

  const resolved = resolveCredential({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-Z' } })
  eq('resolveCredential 走 env', resolved.source, 'env')
  eq('resolveCredential 的 token', resolved.account.access_token, 'sk-ant-oat01-Z')

  let caught = null
  try {
    resolveCredential({ env: {}, path: null })
  } catch (error) {
    caught = error
  }
  ok('无凭据时抛错', caught !== null)
  ok('抛错提示可用变量', String(caught?.message).includes('CLAUDE_CODE_OAUTH_TOKEN'), caught?.message)
}

// ─────────────── 14. 配置校验 ───────────────

console.log('\n14. 配置校验')
eq('缺省 base_url', DEFAULT_WORKER_CONFIG.anthropic_base_url, 'https://api.anthropic.com')
eq('缺省 mock_mode 为 false', DEFAULT_WORKER_CONFIG.mock_mode, false)
eq('缺省 anthropic_credential_path 为空', DEFAULT_WORKER_CONFIG.anthropic_credential_path, '')
eq('缺省 anthropic_timeout_ms', DEFAULT_WORKER_CONFIG.anthropic_timeout_ms, 600_000)
eq('缺省 anthropic_compress_threshold', DEFAULT_WORKER_CONFIG.anthropic_compress_threshold, 1024)
eq('合法 base_url 归一', validateAnthropicBaseUrl('https://api.anthropic.com/'), 'https://api.anthropic.com')
eq('合法 base_url 带路径', validateAnthropicBaseUrl('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1')
{
  const cases = [
    ['http 被拒', 'http://api.anthropic.com', 'anthropic_base_url: endpoint must use https'],
    ['别的 host 被拒', 'https://api.example.com', 'anthropic_base_url: endpoint host must be api.anthropic.com'],
    ['子域名被拒', 'https://evil.api.anthropic.com', 'anthropic_base_url: endpoint host must be api.anthropic.com'],
    ['非 URL 被拒', 'not-a-url', 'anthropic_base_url: endpoint must use https'],
    ['空串被拒', '', 'anthropic_base_url: endpoint must use https'],
  ]
  for (const [name, value, wantMessage] of cases) {
    let message = null
    try {
      validateAnthropicBaseUrl(value)
    } catch (error) {
      message = error.message
    }
    eq(name, message, wantMessage)
  }
}
{
  const cfg = validateWorkerConfig({ vm_id: 'v', internal_token: 't', socket_path: '/s' })
  eq('validateWorkerConfig 归一 base_url', cfg.anthropic_base_url, 'https://api.anthropic.com')
  eq('validateWorkerConfig 带出 mock_mode', cfg.mock_mode, false)
  let caught = null
  try {
    validateWorkerConfig({ vm_id: 'v', internal_token: 't', socket_path: '/s', anthropic_base_url: 'https://api.example.com' })
  } catch (error) {
    caught = error
  }
  eq('validateWorkerConfig 拒绝别的 host', caught?.message, 'anthropic_base_url: endpoint host must be api.anthropic.com')
  const withMock = validateWorkerConfig({ vm_id: 'v', internal_token: 't', socket_path: '/s', mock_mode: true })
  eq('配置里能打开 mock_mode', withMock.mock_mode, true)
}

// ─────────────── 15. 辅助函数 ───────────────

console.log('\n15. 辅助函数')
eq('tokenFromHeaders Bearer', tokenFromHeaders({ authorization: 'Bearer sk-ant-oat01-X' }), 'sk-ant-oat01-X')
eq('tokenFromHeaders 小写 bearer', tokenFromHeaders({ authorization: 'bearer tok' }), 'tok')
eq('tokenFromHeaders x-api-key', tokenFromHeaders({ 'x-api-key': 'k' }), 'k')
eq('tokenFromHeaders 无头返回空串', tokenFromHeaders({}), '')
eq('tokenFromHeaders 无 Bearer 前缀仍取', tokenFromHeaders({ authorization: 'raw-token' }), '')
{
  const redacted = redactHeaders({ authorization: 'Bearer sk-ant-oat01-VERY-SECRET', 'x-api-key': 'sk-k', 'user-agent': 'ua' })
  eq('redactHeaders 不吐 token', redacted.authorization.includes('VERY-SECRET'), false)
  ok('redactHeaders 保留长度信息', /redacted:\d+/.test(redacted.authorization), redacted.authorization)
  eq('redactHeaders 保留普通头', redacted['user-agent'], 'ua')
  eq('redactHeaders 的 x-api-key 也脱敏', redacted['x-api-key'].includes('sk-k'), false)
}
{
  const headers = headersToObject({ 'X-A': '1', 'x-b': 2 })
  eq('headersToObject 归一小写', Object.keys(headers).sort(), ['x-a', 'x-b'])
  eq('headersToObject 值转字符串', headers['x-b'], '2')
  eq('headerOf 大小写不敏感', headerOf({ 'X-Y': 'v' }, 'x-y'), 'v')
  eq('headerOf 缺失返回 undefined', headerOf({}, 'x-y'), undefined)
}
{
  const stream = rawStream(['abc', 'def'])
  const text = await readTextLimited(stream, 1024)
  eq('readTextLimited 拼接全部', text, 'abcdef')
  const limited = await readTextLimited(rawStream(['x'.repeat(100), 'y'.repeat(100)]), 50)
  eq('readTextLimited 按上限截断', limited.length, 50)
  eq('readTextLimited 空流', await readTextLimited(null), '')
}
eq('DEFAULT_COMPRESS_THRESHOLD 是 1024', DEFAULT_COMPRESS_THRESHOLD, 1024)
eq('MODE 三个值', Object.values(MODE).sort(), ['aggregate', 'document', 'stream'])
eq('ERROR_KIND 覆盖六类错误', Object.keys(ERROR_KIND).length, 7)

// ─────────────── 16. 聚合的迭代器契约（回归） ───────────────
//
// 这一段是防回归用的。历史 bug：aggregate() 曾经写成
//     collectMessage(this.iterEvents(stream))
// iterEvents 返回的是 AsyncGenerator，collectMessage 用的是同步 for-of，
// 两者相接在运行期抛 `TypeError: events is not iterable`。单测里如果只用
// 「直接把事件数组喂给 collectMessage」就永远碰不到这条路径——出问题的是
// 两个函数的**接缝**，不是任何一边各自的实现。
//
// 因此这里既断言接缝正确，也断言「错误接法确实会抛」，避免将来有人把
// aggregate 改回同步拼接时测试仍然静默通过。

console.log('\n16. 聚合的迭代器契约（回归）')
{
  // 正向：aggregate() 能吃 ReadableStream 并返回完整 message
  const upstream = new AnthropicUpstream({
    fetchImpl: makeFetch(() => fakeResponse({ status: 200, body: rawStream([SAMPLE_SSE]) })),
    timeoutMs: 5_000,
  })
  const message = await upstream.aggregate(rawStream([SAMPLE_SSE]))
  eq('aggregate 接受 ReadableStream', message.id, 'msg_01')
  eq('aggregate 的文本块完整', message.content[0].text, 'Hello')
  eq('aggregate 的 tool_use 参数还原', message.content[1].input, { city: 'SF' })
  eq('aggregate 的 usage 两段合并', message.usage, { input_tokens: 11, output_tokens: 42 })
}
{
  // aggregate() 也接受字符串（回放路径），且结果与分块投喂一致
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  const fromString = await upstream.aggregate(SAMPLE_SSE)
  const fromChunks = await upstream.aggregate(rawStream([SAMPLE_SSE.slice(0, 40), SAMPLE_SSE.slice(40)]))
  eq('aggregate 吃字符串', fromString.id, 'msg_01')
  eq('字符串与分块结果一致', fromString.content, fromChunks.content)
  eq('字符串与分块的 stop_reason 一致', fromString.stop_reason, fromChunks.stop_reason)
}
{
  // 反向：把 AsyncGenerator 直接交给同步的 collectMessage 必须抛 TypeError。
  // 这条断言锁住的正是历史 bug 的形态——如果哪天 collectMessage 悄悄改成
  // 能接受异步可迭代对象，这条会红，提示「接缝契约变了，需同步复核 aggregate」。
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  let caught = null
  try {
    collectMessage(upstream.iterEvents(SAMPLE_SSE))
  } catch (error) {
    caught = error
  }
  ok('异步迭代器不能直接喂给 collectMessage', caught !== null)
  eq('错误类型是 TypeError', caught?.constructor?.name, 'TypeError')
  ok('错误信息形如 events is not iterable', /not iterable/i.test(String(caught?.message)), caught?.message)
}
{
  // 显式走一遍 aggregate 的两步等价实现，证明接缝本身是「先收集再聚合」
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  const frames = []
  for await (const frame of upstream.iterEvents(SAMPLE_SSE)) frames.push(frame)
  const manual = collectMessage(frames)
  const viaAggregate = await upstream.aggregate(SAMPLE_SSE)
  eq('手动收集再聚合 == aggregate', manual, viaAggregate)
  ok('收集到的是数组而非迭代器', Array.isArray(frames) && frames.length > 0, String(frames.length))
}
{
  // AGGREGATE 模式的端到端：createMessage 内部就是走 aggregate()
  const fetchImpl = makeFetch(() => fakeResponse({ status: 200, body: rawStream([SAMPLE_SSE]) }))
  const upstream = new AnthropicUpstream({ fetchImpl, timeoutMs: 5_000 })
  const out = await upstream.createMessage({
    body: { model: 'm', max_tokens: 8, messages: [] },
    headers: { authorization: 'Bearer T' },
    mode: MODE.AGGREGATE,
  })
  ok('AGGREGATE 模式不抛 not iterable', out.ok === true && out.json?.id === 'msg_01', JSON.stringify(out.classification))
  eq('AGGREGATE 模式的 streamed 标记', out.streamed, true)
  eq('AGGREGATE 模式不回传原始流', out.stream, null)
}

// ─────────────── 17. SSE 分片边界（多字节 UTF-8） ───────────────
//
// 真实网络里 chunk 边界是任意的，一条 SSE 事件可能被切开：
//   - 切在 ASCII 中间：编码无关，必然正确
//   - 切在多字节 UTF-8 字符中间：需要 decoder 跨 chunk 保有状态
//
// 第 17.2 节记录了一个当前实现的缺陷（见那里的注释）。断言按**实际行为**写，
// 目的是把它钉成已知缺陷而不是让它随机漂移；修复后应把该节翻成正向断言。

console.log('\n17. SSE 分片边界（多字节 UTF-8）')
{
  // ASCII 内容：任意切分都必须正确（这是「分片边界」要求的基础项）
  const sse = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n'
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  const bytes = Buffer.from(sse, 'utf8')
  const chunks = [...bytes].map((b) => new Uint8Array([b]))
  const events = []
  for await (const frame of upstream.iterEvents(rawStream(chunks))) events.push(frame)
  eq('ASCII 逐字节切分事件数不变', events.length, 1)
  eq('ASCII 逐字节切分文本完整', events[0].data.delta.text, 'Hello')
}
{
  // 切在 ASCII JSON 结构中间（断开一个 key），解析器必须攒够再解析
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  const head = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"AB'
  const events = []
  for await (const frame of upstream.iterEvents(rawStream([head, 'C"}}\n\n']))) events.push(frame)
  eq('断在字中间仍拼回一个事件', events.length, 1)
  eq('断在字中间文本完整', events[0].data.delta.text, 'ABC')
}
{
  // 切在「帧边界」上：上一个事件恰好结束、下一个尚未开始
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  const events = []
  for await (const frame of upstream.iterEvents(rawStream(['data: {"a":1}\n\ndata: {"b":2}\n\n']))) events.push(frame)
  eq('同块内的两个事件被切开', events.length, 2)
  eq('第一个事件数据', events[0].data, { a: 1 })
  eq('第二个事件数据', events[1].data, { b: 2 })
}
{
  // 多字节 UTF-8 跨 chunk 切分：必须在两种切点上都不损坏。
  //
  // 这一条曾经是缺陷：SseParser.push() 每次调用都新建 TextDecoder，
  // 而 `{stream:true}` 的尾字节是暂存在**解码器实例**里的，实例一换，
  // 被截断的字符就变成 U+FFFD。修法是把 decoder 提到解析器实例上复用，
  // flush() 时再 decode() 收尾（见 src/anthropic.mjs 的 SseParser）。
  //
  // 网络 chunk 边界是任意的，所以这里对「断在首字节后」和「断在第二字节后」
  // 两种切法都要断言，只测一种会漏掉尾部字节的处理。
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  const zh = 'data: {"t":"你好"}\n\n'
  const zb = Buffer.from(zh, 'utf8')
  const whole = []
  const wholeStream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(zb)); c.close() } })
  for await (const frame of upstream.iterEvents(wholeStream)) whole.push(frame)
  eq('多字节不被切分时文本完整（对照组）', whole[0].data.t, '你好')

  for (const [label, offset] of [['断在第 1 字节后', 1], ['断在第 2 字节后', 2]]) {
    const cut = zb.indexOf(Buffer.from('你', 'utf8')) + offset
    const events = []
    for await (const frame of upstream.iterEvents(rawStream([zb.subarray(0, cut), zb.subarray(cut)]))) events.push(frame)
    eq(`多字节跨 chunk（${label}）事件数`, events.length, 1)
    eq(`多字节跨 chunk（${label}）文本完整`, events[0].data.t, '你好')
    ok(`多字节跨 chunk（${label}）无替换符`, !String(events[0].data.t).includes('\uFFFD'), JSON.stringify(events[0].data.t))
  }
}
{
  // SseParser 直接分片（不经 iterEvents）也要覆盖：这是 iterEvents 的底层
  const zh = 'data: {"t":"世界"}\n\n'
  const zb = Buffer.from(zh, 'utf8')
  const parser = new SseParser()
  const cut = zb.indexOf(Buffer.from('世', 'utf8')) + 2 // 断在 3 字节字符的第 2 字节后
  const a = parser.push(zb.subarray(0, cut))
  const b = parser.push(zb.subarray(cut))
  const frames = [...a, ...b]
  eq('SseParser 分片后仍产出一帧', frames.length, 1)
  eq('SseParser 分片的多字节完整', frames[0].data.t, '世界')
}
{
  // 逐字节投喂一个含 4 字节 emoji 的帧：最严苛的切分，每个字节都单独到达
  const zh = 'data: {"t":"中文😀测试"}\n\n'
  const zb = Buffer.from(zh, 'utf8')
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  const events = []
  const chunks = [...zb].map((b) => new Uint8Array([b]))
  for await (const frame of upstream.iterEvents(rawStream(chunks))) events.push(frame)
  eq('逐字节投喂 4 字节 emoji 完整', events[0].data.t, '中文😀测试')
}
{
  // 流末尾落在多字节字符中间：截断序列无法还原，但已收到的部分不能丢。
  // 这里断言的是「残帧仍然交出来、且形态可辨认」——把半个 JSON 静默吞掉，
  // 调用方看到的是「上游什么都没发」，比拿到一个解析不了的残帧更难排查。
  const zh = 'data: {"t":"你好"}\n\n'
  const zb = Buffer.from(zh, 'utf8')
  const cut = zb.indexOf(Buffer.from('你', 'utf8')) + 1
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  const events = []
  for await (const frame of upstream.iterEvents(rawStream([zb.subarray(0, cut)]))) events.push(frame)
  eq('截断流交出残帧', events.length, 1)
  eq('残帧 data 是解析不了的字符串（保留原文）', typeof events[0].data, 'string')
  ok('残帧里能看到已收到的键名', String(events[0].data).includes('"t"'), events[0].data)
}
{
  // 完整帧 + 尾部残帧：完整的那一帧必须正常解析出来
  const full = 'data: {"a":1}\n\n'
  const partial = 'data: {"b":2'
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  const events = []
  for await (const frame of upstream.iterEvents(rawStream([full, partial]))) events.push(frame)
  eq('完整帧 + 残帧 → 两帧', events.length, 2)
  eq('完整帧正常解析', events[0].data, { a: 1 })
  eq('残帧保留原文', events[1].data, '{"b":2')
}
{
  // 反向保障：不跨 chunk 时多字节必须完全正确（防止将来为了修缺陷改坏主路径）
  const zh = 'data: {"t":"中文测试😀"}\n\n'
  const events = parseSseText(zh)
  eq('单块多字节含 emoji 完整', events[0].data.t, '中文测试😀')
  const upstream = new AnthropicUpstream({ fetchImpl: makeFetch(() => fakeResponse({ status: 200 })), timeoutMs: 5_000 })
  const got = []
  const st = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(zh)); c.close() } })
  for await (const frame of upstream.iterEvents(st)) got.push(frame)
  eq('iterEvents 单块多字节完整', got[0].data.t, '中文测试😀')
}

// ─────────────── 18. 真实 HTTP 假上游（node:http） ───────────────
//
// 前面各节用注入的假 fetch 验证「我们发出的 init 对象长什么样」。
// 这一节换成真的 HTTP 服务器：请求真正经过 Node 的 http 栈与 undici，
// 于是能看到只有真实传输才会补齐/改写的东西——content-length 由运行时按
// 最终字节数填、transfer-encoding 不出现、header 名被规范化。
//
// 仍然不打真实网络：服务器 bind 在 127.0.0.1 的临时端口上。

console.log('\n18. 真实 HTTP 假上游（node:http）')

/** 起一个本地 HTTP 服务器，把收到的请求记进 captured，用 handler 决定响应 */
async function withHttpUpstream(handler, fn) {
  const captured = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers, // Node 已把 header 名规范成小写
        raw: Buffer.concat(chunks),
      }
      captured.push(record)
      handler(record, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await fn({ port, baseUrl: `http://127.0.0.1:${port}`, captured })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** 用最小合法 SSE 回一条 200 */
function respondSse(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(text)
}

const GOLDEN_SSE = [
  'event: message_start\n',
  'data: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5}}}\n\n',
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
  'event: content_block_stop\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
  'event: message_stop\n',
  'data: {"type":"message_stop"}\n\n',
].join('')

{
  // 黄金基准：任务里给出的那段调用，用真实 HTTP 上游捕获实际出站字节。
  await withHttpUpstream(
    (record, res) => respondSse(res, GOLDEN_SSE),
    async ({ baseUrl, captured }) => {
      const body = prepareOutbound(
        {
          model: 'claude-opus-5-5',
          max_tokens: 100,
          messages: [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '在' },
            { role: 'user', content: '再说一次' },
          ],
        },
        { systemLayout: 'identity', panelTtl: '1h' },
      )

      const upstream = new AnthropicUpstream({ baseUrl })
      const result = await upstream.createMessage({
        body,
        headers: { authorization: 'Bearer test-123' },
        mode: MODE.AGGREGATE,
      })

      const sent = captured[0]
      eq('黄金基准：只发了一次请求', captured.length, 1)
      eq('黄金基准：打到 /v1/messages', sent.url, '/v1/messages')
      eq('黄金基准：method 是 POST', sent.method, 'POST')

      // ── 8 个字段逐个断言（任务给的真实 wire 形态）──
      eq('黄金基准① authorization', sent.headers.authorization, 'Bearer test-123')
      eq('黄金基准③ user-agent', sent.headers['user-agent'], 'claude-cli/2.1.296 (external, sdk-cli)')
      eq('黄金基准④ x-app', sent.headers['x-app'], 'cli')
      ok('黄金基准⑤ content-length 存在（明文时由运行时算出）', sent.headers['content-length'] != null, sent.headers['content-length'])
      eq('黄金基准⑤ content-length 等于实际字节数', Number(sent.headers['content-length']), sent.raw.length)
      ok('黄金基准⑤ 没有 transfer-encoding', sent.headers['transfer-encoding'] == null, sent.headers['transfer-encoding'])
      eq('黄金基准：未压缩时不带 content-encoding', sent.headers['content-encoding'], undefined)
      eq('黄金基准⑥ accept', sent.headers.accept, 'text/event-stream')
      eq('黄金基准：anthropic-version', sent.headers['anthropic-version'], '2023-06-01')

      const wire = JSON.parse(sent.raw.toString('utf8'))
      eq('黄金基准⑥ body.stream 为 true', wire.stream, true)
      eq('黄金基准⑥ system 块数 3', wire.system.length, 3)
      ok('黄金基准⑥ billing 头在第 1 块', /x-anthropic-billing-header:/.test(wire.system[0].text), wire.system[0].text)
      ok('黄金基准⑥ billing 含 cc_version', /cc_version=2\.1\.296/.test(wire.system[0].text), wire.system[0].text)
      // 必须是 sdk-cli，不是 cli。
      //
      // 依据官方 vm2api v1.3.220（crs-persona.mjs:376 + vm-identity.mjs:24）：
      // 计费头 cc_entrypoint=sdk-cli、UA 后缀 (external, sdk-cli)。
      // 1.3.221+ 把两者都改成 cli，但槽内二进制没跟上，
      // 造成"计费头说 cli、内核说 sdk-cli"的内部矛盾 —— 会被封。
      // 实测反馈：新版上线 29 次成功后收到 401 token revoked。
      ok('黄金基准⑥ billing 含 cc_entrypoint=sdk-cli',
        /cc_entrypoint=sdk-cli/.test(wire.system[0].text), wire.system[0].text)
      ok('黄金基准⑥ billing 含 5 位 hex 的 cch', /cch=[0-9a-f]{5};/.test(wire.system[0].text), wire.system[0].text)
      ok('黄金基准⑥ 第 2 块是身份句', wire.system[1].text.includes('Claude'), wire.system[1].text.slice(0, 80))

      // cache_control 计数：递归数整份 body 里出现的次数
      let cacheCount = 0
      const walk = (node) => {
        if (Array.isArray(node)) return node.forEach(walk)
        if (node && typeof node === 'object') {
          if ('cache_control' in node) cacheCount += 1
          Object.values(node).forEach(walk)
        }
      }
      walk(wire)
      eq('黄金基准⑦ cache_control 数 3', cacheCount, 3)

      // anthropic-beta：按当前代码的真实推导链算期望值，不硬编码字面量。
      // 记录：任务给的基准是 3 个 beta
      //   thinking-token-count-2026-05-13,mid-conversation-system-2026-04-07,extended-cache-ttl-2025-04-11
      // 当前 src 只发 1 个（extended-cache-ttl-2025-04-11）。差异见报告。
      // 期望值必须与出站实现同一条推导链：buildBetaHeader 在 body.betas 之上
      // 并入官方拟真基础集。光用 resolveBetaList 只拿到 extended-cache-ttl，
      // 会漏掉 claude-code / oauth 这两个声明客户端身份与鉴权方式的 beta，
      // 而上游正是按它们的组合解释这份请求。
      // 硬编码完整序列，不从被测代码现算。
      // 用 buildBetaHeader(...) 当期望值等于让实现自己给自己打分：
      // 顺序被打乱、或混进一个上游不认识的 beta，两边会一起变而恒绿。
      // 这份字面量对着真实上游抓包核对过（2026-10-23，2.1.296 客户端），
      // 上游顺序变了必须人工改这里，那正是这条断言的意义。
      const EXPECTED_BETA =
        'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,' +
        'thinking-token-count-2026-05-13,context-management-2025-06-27,' +
        'prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,' +
        'extended-cache-ttl-2025-04-11'
      eq('黄金基准② anthropic-beta 完整序列', sent.headers['anthropic-beta'], EXPECTED_BETA)
      ok('黄金基准② anthropic-beta 非空', String(sent.headers['anthropic-beta'] || '').length > 0, sent.headers['anthropic-beta'])
      ok('黄金基准② anthropic-beta 含 extended-cache-ttl', String(sent.headers['anthropic-beta']).includes('extended-cache-ttl-2025-04-11'), sent.headers['anthropic-beta'])

      // ── 聚合结果 ──
      eq('黄金基准：聚合状态 200', result.status, 200)
      eq('黄金基准：聚合 id', result.json.id, 'msg_x')
      eq('黄金基准：聚合 type', result.json.type, 'message')
      eq('黄金基准：聚合 role', result.json.role, 'assistant')
      eq('黄金基准：聚合 model', result.json.model, 'claude-opus-5-5')
      eq('黄金基准：聚合 content 只有文本块', result.json.content.length, 1)
      eq('黄金基准：聚合文本内容', result.json.content[0].text, '你好')
      eq('黄金基准：聚合 stop_reason', result.json.stop_reason, 'end_turn')
      eq('黄金基准：聚合 stop_sequence', result.json.stop_sequence, null)
      eq('黄金基准：聚合 usage 合并', result.json.usage, { input_tokens: 5, output_tokens: 2 })
      eq('黄金基准：wireBytes 等于真实字节数', result.wireBytes, sent.raw.length)
      eq('黄金基准：encoding 为 null', result.encoding, null)
      eq('黄金基准：lastRequest 记录了 url', upstream.lastRequest.url, `${baseUrl}/v1/messages`)
      eq('黄金基准：lastRequest 记录了 mode', upstream.lastRequest.mode, MODE.AGGREGATE)

      // 出站头里绝不能出现 token 明文（lastRequest 是给 /status 读的）
      ok(
        'lastRequest 里的 token 已脱敏',
        !JSON.stringify(upstream.lastRequest).includes('test-123'),
        JSON.stringify(upstream.lastRequest.headers),
      )
    },
  )
}
{
  // 真实 HTTP 下的压缩路径：大 body 带 content-encoding: zstd，且服务端能解回
  await withHttpUpstream(
    (record, res) => respondSse(res, GOLDEN_SSE),
    async ({ baseUrl, captured }) => {
      const bigMessages = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `第${i}条消息 ${'填充'.repeat(20)}` }))
      const upstream = new AnthropicUpstream({ baseUrl, compressThreshold: 1024 })
      const out = await upstream.createMessage({
        body: { model: 'm', max_tokens: 8, messages: bigMessages },
        headers: { authorization: 'Bearer T' },
        mode: MODE.STREAM,
      })
      const sent = captured[0]
      eq('真实 HTTP 压缩：带 content-encoding', sent.headers['content-encoding'], 'zstd')
      eq('真实 HTTP 压缩：encoding 记录', out.encoding, 'zstd')
      ok('真实 HTTP 压缩：content-length 是压缩后长度', Number(sent.headers['content-length']) === sent.raw.length, `${sent.headers['content-length']} vs ${sent.raw.length}`)
      const inflated = JSON.parse(zlib.zstdDecompressSync(sent.raw).toString('utf8'))
      eq('真实 HTTP 压缩：服务端能解回 body', inflated.max_tokens, 8)
      eq('真实 HTTP 压缩：解回的消息条数', inflated.messages.length, 40)
      ok('真实 HTTP 压缩：压缩确实更小', sent.raw.length < Buffer.byteLength(JSON.stringify(inflated)), `${sent.raw.length}`)
    },
  )
}
{
  // 真实 HTTP 下错误体透出：状态码、retry-after、原始 body 都要能读回
  await withHttpUpstream(
    (record, res) => {
      const payload = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '45', 'request-id': 'req_http' })
      res.end(payload)
    },
    async ({ baseUrl }) => {
      const upstream = new AnthropicUpstream({ baseUrl })
      const out = await upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer T' } })
      eq('真实 HTTP 错误：透出 429', out.status, 429)
      eq('真实 HTTP 错误：分类 rate_limited', out.classification.kind, ERROR_KIND.RATE_LIMITED)
      eq('真实 HTTP 错误：解析 retry-after', out.retryAfter, 45)
      eq('真实 HTTP 错误：原始 body 保留', out.json.error.message, 'slow down')
      eq('真实 HTTP 错误：request-id 头保留', out.headers['request-id'], 'req_http')
    },
  )
}
{
  // 真实 HTTP 下 DOCUMENT 模式：wire 不带 stream 键，服务端回纯 JSON
  await withHttpUpstream(
    (record, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_doc', type: 'message', role: 'assistant', content: [] }))
    },
    async ({ baseUrl, captured }) => {
      const upstream = new AnthropicUpstream({ baseUrl })
      const out = await upstream.createMessage({
        body: { model: 'm', max_tokens: 8, messages: [] },
        headers: { authorization: 'Bearer T' },
        mode: MODE.DOCUMENT,
      })
      const wire = JSON.parse(captured[0].raw.toString('utf8'))
      eq('真实 HTTP DOCUMENT：wire 无 stream 键', 'stream' in wire, false)
      eq('真实 HTTP DOCUMENT：accept 是 JSON', captured[0].headers.accept, 'application/json')
      eq('真实 HTTP DOCUMENT：返回解析后的 JSON', out.json.id, 'msg_doc')
    },
  )
}
{
  // 真实 HTTP 下流式：STREAM 模式把上游字节原样交出
  await withHttpUpstream(
    (record, res) => respondSse(res, GOLDEN_SSE),
    async ({ baseUrl }) => {
      const upstream = new AnthropicUpstream({ baseUrl })
      const out = await upstream.createMessage({
        body: { model: 'm', max_tokens: 8, messages: [] },
        headers: { authorization: 'Bearer T' },
        mode: MODE.STREAM,
      })
      eq('真实 HTTP STREAM：状态 200', out.status, 200)
      ok('真实 HTTP STREAM：拿到流对象', out.stream != null)
      const events = []
      for await (const frame of upstream.iterEvents(out.stream)) events.push(frame)
      ok('真实 HTTP STREAM：能迭代出事件', events.length >= 5, String(events.length))
      eq('真实 HTTP STREAM：首帧 message_start', events[0].data.type, 'message_start')
      const message = collectMessage(events)
      eq('真实 HTTP STREAM：聚合文本', message.content[0].text, '你好')
      eq('真实 HTTP STREAM：聚合 stop_reason', message.stop_reason, 'end_turn')
    },
  )
}
{
  // 真实 HTTP 下的超时：服务器故意不响应，客户端到点必须放弃
  const slowServer = http.createServer((req, res) => {
    // 什么都不回，等客户端超时
    req.on('end', () => {})
  })
  await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve))
  const { port } = slowServer.address()
  try {
    const upstream = new AnthropicUpstream({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 60 })
    const out = await upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer T' } })
    eq('真实 HTTP 超时：返回 status 0', out.status, 0)
    eq('真实 HTTP 超时：分类 network', out.classification.kind, ERROR_KIND.NETWORK)
    eq('真实 HTTP 超时：可重试', out.classification.retryable, true)
  } finally {
    await new Promise((resolve) => slowServer.close(resolve))
  }
}
{
  // 真实 HTTP 下的 aborted：已经 abort 的 signal 必须立即生效，不发出请求
  let hit = 0
  await withHttpUpstream(
    (record, res) => { hit += 1; respondSse(res, GOLDEN_SSE) },
    async ({ baseUrl }) => {
      const upstream = new AnthropicUpstream({ baseUrl })
      const controller = new AbortController()
      controller.abort(new Error('client gone'))
      const out = await upstream.createMessage({
        body: { model: 'm' },
        headers: { authorization: 'Bearer T' },
        signal: controller.signal,
      })
      eq('真实 HTTP aborted：返回 status 0', out.status, 0)
      eq('真实 HTTP aborted：标记 aborted', out.classification.aborted, true)
      eq('真实 HTTP aborted：不可重试', out.classification.retryable, false)
    },
  )
}
{
  // 真实 HTTP 下连接被拒（端口无人监听）：必须归类为 network 而不是崩溃
  const upstream = new AnthropicUpstream({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 })
  const out = await upstream.createMessage({ body: { model: 'm' }, headers: { authorization: 'Bearer T' } })
  eq('连接被拒：返回 status 0', out.status, 0)
  eq('连接被拒：分类 network', out.classification.kind, ERROR_KIND.NETWORK)
  ok('连接被拒：带错误原文', String(out.classification.error || '').length > 0, out.classification.error)
}

// ─────────────── 结果 ───────────────

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
