#!/usr/bin/env node
/**
 * 对着真实上游验一次出站请求：能被接受吗？被拒的是哪个字段？配额还剩多少？
 *
 * 默认 dry-run：只构造请求、打印脱敏骨架与将发送的头，不发包。
 * 必须显式加 --send 才真的发出去，并且每发一次都打印本次消耗的 token。
 *
 *   node scripts/outbound-verify.mjs                          # dry-run，Codex 通道
 *   node scripts/outbound-verify.mjs --target anthropic       # dry-run，Claude 通道
 *   node scripts/outbound-verify.mjs --send --max-tokens 16    # 真发一次
 *   node scripts/outbound-verify.mjs --send --target anthropic --max-tokens 8
 *   node scripts/outbound-verify.mjs --send --model gpt-6-astra --prompt "reply OK"
 *   node scripts/outbound-verify.mjs --send --raw-ok           # 连响应正文也打印（默认脱敏）
 *
 * 凭据来源：
 *   Codex    缺省读 research/live/javaserver.json（可用 --credential 覆盖）
 *   Claude   ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN 环境变量，
 *            或 --credential <file>（支持 {access_token} / {api_key} / {token} 三种键）
 *
 * 检查项：
 *   1. HTTP 状态（2xx 视为被接受）
 *   2. 错误信息里被上游点名的字段（解析错误文本里的点路径 / 字段名）
 *   3. 响应头里的配额信息（anthropic-ratelimit-* / x-ratelimit-* / retry-after）
 *   4. 本次实际消耗的 token（流式从 message_start / message_delta / response.completed 取）
 *
 * 退出码：
 *   0  被接受（dry-run 恒为 0）
 *   1  被上游拒绝
 *   2  用法 / 凭据 / 网络不可用
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { shapeOf, formatShape } from '../src/outbound-shape.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LIVE_CREDENTIAL = path.resolve(ROOT, '../live/javaserver.json')

const USAGE = `用法: node scripts/outbound-verify.mjs [选项]

  --target <codex|anthropic>   走哪条通道，缺省 codex
  --send                       真的发出去（缺省 dry-run，只构造不发送）
  --credential <file>          凭据文件（codex 缺省 research/live/javaserver.json）
  --model <id>                 模型；缺省按通道取默认值
  --max-tokens <n>             输出上限，缺省 16（dry-run 只打印，--send 才真花）
  --prompt <text>              用户消息文本，缺省 "reply with OK"
  --base-url <url>             上游 base，缺省按通道取默认值
  --proxy <url>                显式代理；缺省用凭据里的 proxy_url / 环境变量
  --timeout <ms>               请求超时，缺省 60000
  --json                       机器可读报告
  --raw-ok                     响应正文也打印（仅成功时；默认只打脱敏摘要）
  --help                       本帮助
`

const DEFAULTS = {
  codex: { model: 'gpt-6-astra', baseUrl: 'https://chatgpt.com/backend-api/codex' },
  anthropic: { model: 'claude-sonnet-4-5', baseUrl: 'https://api.anthropic.com' },
}

const CLI_VERSION_DEFAULT = '2.1.296'

function parseArgs(argv) {
  const out = {
    target: 'codex',
    send: false,
    credential: null,
    model: null,
    maxTokens: 16,
    prompt: 'reply with OK',
    baseUrl: null,
    proxy: null,
    timeout: 60000,
    json: false,
    rawOk: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value == null) throw new Error(`${arg} 需要值`)
      return value
    }
    if (arg === '--target') out.target = next()
    else if (arg === '--send') out.send = true
    else if (arg === '--credential') out.credential = next()
    else if (arg === '--model') out.model = next()
    else if (arg === '--max-tokens') out.maxTokens = Number(next())
    else if (arg === '--prompt') out.prompt = next()
    else if (arg === '--base-url') out.baseUrl = next()
    else if (arg === '--proxy') out.proxy = next()
    else if (arg === '--timeout') out.timeout = Number(next())
    else if (arg === '--json') out.json = true
    else if (arg === '--raw-ok') out.rawOk = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`未知参数: ${arg}`)
  }
  if (!['codex', 'anthropic'].includes(out.target)) throw new Error(`--target 只接受 codex / anthropic，收到 ${out.target}`)
  if (!Number.isFinite(out.maxTokens) || out.maxTokens <= 0) throw new Error('--max-tokens 必须是正数')
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error('--timeout 必须是正数')
  return out
}

// ─────────────────────────── 凭据 ───────────────────────────

/**
 * 读 Codex 凭据。
 * 兼容单账号形态与 {accounts:[...]}；取第一个可用账号，凭据内容绝不打印。
 */
function loadCodexCredential(file) {
  if (!fs.existsSync(file)) throw new Error(`凭据文件不存在: ${path.relative(process.cwd(), file)}`)
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`凭据文件不是合法 JSON: ${error.message}`)
  }
  const raw = Array.isArray(doc?.accounts) ? doc.accounts[0] : doc
  if (!raw || typeof raw !== 'object') throw new Error('凭据文件里没有账号对象')
  const accessToken = raw.access_token || raw.accessToken || ''
  if (!accessToken) throw new Error('凭据缺少 access_token')
  const expiredAt = raw.expired || raw.expires_at || null
  const expiredSecs = expiredAt ? Math.floor(Date.parse(expiredAt) / 1000) : null
  const nowSecs = Math.floor(Date.now() / 1000)
  return {
    kind: 'codex',
    accessToken,
    accountId: raw.account_id || raw.chatgpt_account_id || '',
    email: raw.email || '',
    expiredAt,
    expiresInSecs: expiredSecs ? expiredSecs - nowSecs : null,
    proxy: raw.proxy_url || '',
    refreshToken: raw.refresh_token || '',
    disabled: raw.disabled === true,
  }
}

/** 读 Claude 凭据：环境变量优先，其次文件 */
function loadAnthropicCredential(file) {
  const env = process.env
  const fromEnv =
    env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || ''
  if (fromEnv) {
    const isOauth = /^sk-ant-oat/.test(fromEnv) || Boolean(env.CLAUDE_CODE_OAUTH_TOKEN)
    return { kind: 'anthropic', token: fromEnv, authScheme: isOauth ? 'oauth' : 'api_key', source: 'env' }
  }
  if (!file) throw new Error('没有 Claude 凭据：设置 ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN，或用 --credential 指定文件')
  if (!fs.existsSync(file)) throw new Error(`凭据文件不存在: ${path.relative(process.cwd(), file)}`)
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`凭据文件不是合法 JSON: ${error.message}`)
  }
  const token = doc?.access_token || doc?.api_key || doc?.token || doc?.key || ''
  if (!token) throw new Error('凭据文件里没有 access_token / api_key / token')
  const isOauth = /^sk-ant-oat/.test(token) || Boolean(doc?.access_token)
  return {
    kind: 'anthropic',
    token,
    authScheme: isOauth ? 'oauth' : 'api_key',
    source: path.relative(process.cwd(), path.resolve(file)),
  }
}

// ─────────────────────────── 请求构造 ───────────────────────────

async function loadModule(spec) {
  try {
    return await import(spec)
  } catch {
    return null
  }
}

/**
 * 构造 Codex 出站请求。
 *
 * 用 codex.mjs 的 buildOutboundHeaders / buildOutboundBody —— 与线上同一份构造逻辑，
 * 否则这工具验的就不是真实出站形态。模块不可用时退化为本地最小实现并标注。
 */
async function planCodex(args, credential) {
  const codex = await loadModule('../src/codex.mjs')
  const model = args.model || DEFAULTS.codex.model
  const baseUrl = args.baseUrl || DEFAULTS.codex.baseUrl
  const body = {
    model,
    instructions: 'You are a verification probe. Reply briefly.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: args.prompt }],
      },
    ],
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { effort: 'low', summary: 'auto' },
    store: false,
    stream: true,
  }
  const built = codex
    ? {
        body: codex.buildOutboundBody({ body, session: { session_id: 'verify-probe' }, installationId: null }),
        headers: codex.buildOutboundHeaders({
          account: { access_token: credential.accessToken, chatgpt_account_id: credential.accountId },
          body,
          sessionId: 'verify-probe',
          userAgent: codex.DEFAULT_CODEX_UA,
        }),
      }
    : { body: { ...body, store: false }, headers: { 'content-type': 'application/json', 'user-agent': 'codex_cli_rs/0.160.0 (linux x86_64)' }, degraded: 'src/codex.mjs 不可用，用最小头' }

  built.headers['content-encoding'] = 'zstd'
  const payload = JSON.stringify(built.body)
  const url = `${String(baseUrl).replace(/\/+$/, '')}/responses`
  return {
    target: 'codex',
    model,
    url,
    headers: built.headers,
    body: built.body,
    payload,
    degraded: built.degraded || null,
    transport: 'http-sse',
  }
}

/**
 * 构造 Claude Messages 出站请求。
 *
 * 用 system-layout 组 system、cch 封盖、identity 出官方头——与内核 prepareOutbound 同序。
 * 这里的 minimal 是有意的：不带 tools、不带 thinking，只用最少字段探测上游是否接受。
 */
async function planAnthropic(args, credential) {
  const [systemLayout, cch, identity] = await Promise.all([
    loadModule('../src/system-layout.mjs'),
    loadModule('../src/cch.mjs'),
    loadModule('../src/identity.mjs'),
  ])
  const model = args.model || DEFAULTS.anthropic.model
  const baseUrl = args.baseUrl || DEFAULTS.anthropic.baseUrl
  const degraded = []

  const body = {
    model,
    max_tokens: args.maxTokens,
    messages: [{ role: 'user', content: args.prompt }],
  }

  if (systemLayout && typeof systemLayout.layoutSystemBlocks === 'function') {
    const blocks = systemLayout.layoutSystemBlocks({
      attribution: '',
      leftover: undefined,
      env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'zero', TZ: 'UTC' },
    })
    body.system = blocks.map((text) => ({ type: 'text', text }))
  } else {
    degraded.push('src/system-layout.mjs 不可用，未注入 system 布局')
  }

  let sealed = body
  if (cch && typeof cch.sealClaudeCodeCch === 'function') {
    sealed = cch.sealClaudeCodeCch(body, { enabled: true, seal: true })
  } else {
    degraded.push('src/cch.mjs 不可用，未封盖 cch')
  }

  const betaList = identity && Array.isArray(identity.OFFICIAL_MESSAGE_BETAS) ? [...identity.OFFICIAL_MESSAGE_BETAS] : []
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    accept: 'text/event-stream',
  }
  if (betaList.length) headers['anthropic-beta'] = betaList.join(',')
  if (identity && typeof identity.officialCliUserAgent === 'function') {
    headers['user-agent'] = identity.officialCliUserAgent()
  } else {
    headers['user-agent'] = `claude-cli/${CLI_VERSION_DEFAULT} (external, sdk-cli)`
  }
  if (identity && typeof identity.claudeCodeAppHeader === 'function') headers['x-app'] = identity.claudeCodeAppHeader()
  if (identity && typeof identity.officialStainlessHeaders === 'function') {
    Object.assign(headers, identity.officialStainlessHeaders())
  }
  if (credential.authScheme === 'oauth') headers.authorization = `Bearer ${credential.token}`
  else headers['x-api-key'] = credential.token

  return {
    target: 'anthropic',
    model,
    url: `${String(baseUrl).replace(/\/+$/, '')}/v1/messages`,
    headers,
    body: sealed,
    payload: JSON.stringify(sealed),
    degraded: degraded.length ? degraded.join('; ') : null,
    transport: 'http-sse',
  }
}

// ─────────────────────────── 发送 ───────────────────────────

/**
 * 从 HTTP 头里挑出配额相关项，值原样保留（配额不是机密）。
 *
 * 只认「配额 / 限流 / 请求追踪」三类。x-codex-turn-state 这类大块会话状态
 * 也带 x-codex- 前缀，但它有几十 KB 且与配额无关，必须排除——
 * 打印出来只会淹没真正的配额字段。
 */
export function quotaHeaders(headers) {
  const out = {}
  const skip = new Set(['x-codex-turn-state', 'x-codex-turn-metadata', 'set-cookie'])
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase()
    if (skip.has(lower)) continue
    const keep =
      lower.startsWith('anthropic-ratelimit-') ||
      lower.startsWith('x-ratelimit-') ||
      lower.startsWith('ratelimit-') ||
      lower.startsWith('x-codex-primary-') ||
      lower.startsWith('x-codex-secondary-') ||
      lower.startsWith('x-codex-safety-buffering') ||
      lower === 'retry-after' ||
      lower === 'request-id' ||
      lower === 'x-request-id' ||
      lower === 'openai-processing-ms'
    if (keep && String(value).length <= 200) out[lower] = String(value)
  }
  return out
}

/**
 * 解析错误信息里被上游点名的字段。
 *
 * 覆盖面：Anthropic 的 "messages.0.content.0.text: unexpected field"、
 * "Extra inputs are not permitted"，Codex 的 "Unrecognized request argument supplied: x"、
 * "unknown parameter: x"，以及结构化错误里的 `param` 字段。
 */
export function rejectedFields(payload) {
  const found = new Set()
  const texts = []
  const collect = (value) => {
    if (typeof value === 'string') texts.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key, inner]) => {
      if (key === 'param' && typeof inner === 'string') found.add(inner)
      else collect(inner)
    })
  }
  collect(payload)

  const patterns = [
    /([A-Za-z_][\w.]*(?:\[\d+\])?(?:\.[\w]+(?:\[\d+\])?)*):\s*(?:unexpected|unknown|unrecognized|not permitted|extra)/i,
    /(?:unexpected|unknown|unrecognized|unsupported|extra|invalid)\s+(?:field|parameter|argument|input)s?\s*[:=]\s*["'`]?([\w.\[\]]+)/i,
    /(?:not|isn't|is\s+not)\s+(?:permitted|allowed|supported)\s*[:,]\s*["'`]?([\w.\[\]]+)/i,
    /(?:field|parameter|argument)\s+["'`]([\w.\[\]]+)["'`]\s+(?:is|was)\s+(?:not|unexpected|unknown|unrecognized)/i,
    /(?:unrecognized|unknown)\s+request\s+argument\s+supplied\s*:?\s*["'`]?([\w.\[\]]+)/i,
  ]
  // 这些词是句子成分，不是字段名：宽泛的正则会把 "Extra inputs are not permitted"
  // 里的 are 抓成字段。宁可漏报也不能误报——误报会把排查方向带到不存在的字段上。
  const stopwords = new Set([
    'are', 'is', 'was', 'were', 'be', 'been', 'not', 'the', 'a', 'an', 'in', 'on',
    'for', 'to', 'of', 'and', 'or', 'it', 'this', 'that', 'field', 'fields',
    'parameter', 'parameters', 'argument', 'arguments', 'input', 'inputs',
  ])
  for (const text of texts) {
    for (const pattern of patterns) {
      const hit = pattern.exec(text)
      if (!hit) continue
      const field = String(hit[1]).replace(/[.,;:'"`]$/, '').trim()
      if (!field || field.length >= 120) continue
      if (stopwords.has(field.toLowerCase())) continue
      found.add(field)
    }
  }
  return [...found]
}

/** 从 SSE 文本里累加 token 用量；同时收集一条事件摘要（不含正文） */
export function consumeSse(text) {
  const usage = { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 }
  const events = new Set()
  const stopReasons = new Set()
  let sawDone = false

  const mergeUsage = (node) => {
    if (!node || typeof node !== 'object') return
    const read = (a, b) => (typeof node[a] === 'number' ? node[a] : typeof node[b] === 'number' ? node[b] : null)
    const input = read('input_tokens', 'prompt_tokens')
    const output = read('output_tokens', 'completion_tokens')
    const total = read('total_tokens', 'total_tokens')
    // message_start 与 message_delta 会各报一次，取最大值而不是相加：
    // 前者是累计输入，后者是累计输出，相加会把同一段重复计入。
    if (input != null) usage.input = Math.max(usage.input, input)
    if (output != null) usage.output = Math.max(usage.output, output)
    if (total != null) usage.total = Math.max(usage.total, total)
    const cacheRead = read('cache_read_input_tokens', 'cache_read_tokens')
    const cacheWrite = read('cache_creation_input_tokens', 'cache_creation_tokens')
    if (cacheRead != null) usage.cache_read = Math.max(usage.cache_read, cacheRead)
    if (cacheWrite != null) usage.cache_write = Math.max(usage.cache_write, cacheWrite)
  }

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('event:')) {
      events.add(line.slice(6).trim())
      continue
    }
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data) continue
    if (data === '[DONE]') {
      sawDone = true
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(data)
    } catch {
      continue
    }
    if (parsed?.type === 'message_start') mergeUsage(parsed.message?.usage)
    if (parsed?.type === 'message_delta') {
      mergeUsage(parsed.usage)
      if (parsed.delta?.stop_reason) stopReasons.add(parsed.delta.stop_reason)
    }
    if (parsed?.type === 'response.completed' || parsed?.type === 'response.done') mergeUsage(parsed.response?.usage)
    if (parsed?.usage) mergeUsage(parsed.usage)
    if (parsed?.response?.usage) mergeUsage(parsed.response.usage)
  }
  if (!usage.total) usage.total = usage.input + usage.output
  return { usage, events: [...events], stopReasons: [...stopReasons], sawDone }
}

/** 非流式（或错误）响应体里的用量 */
export function consumeJson(payload) {
  const usage = { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 }
  const node = payload?.usage || payload?.response?.usage || null
  if (!node) return usage
  usage.input = node.input_tokens ?? node.prompt_tokens ?? 0
  usage.output = node.output_tokens ?? node.completion_tokens ?? 0
  usage.cache_read = node.cache_read_input_tokens ?? 0
  usage.cache_write = node.cache_creation_input_tokens ?? 0
  usage.total = node.total_tokens ?? usage.input + usage.output
  return usage
}

async function sendRequest(plan, { timeoutMs, proxy }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  // body 必须按 content-encoding 真的编码：头声明 zstd 却发明文，上游只会回
  // 一个无信息量的 "Bad Request"，排查方向会被完全带偏。
  const encoding = String(plan.headers['content-encoding'] || '').toLowerCase()
  let body = Buffer.from(plan.payload, 'utf8')
  if (encoding === 'zstd') {
    if (typeof zlib.zstdCompressSync !== 'function') throw new Error('运行时无 zstd 支持，无法按 content-encoding: zstd 发送')
    body = zlib.zstdCompressSync(body)
  } else if (encoding === 'identity' || encoding === '') {
    // 明文，保持原样
  } else {
    throw new Error(`不支持的 content-encoding: ${encoding}`)
  }
  try {
    const res = await fetch(plan.url, {
      method: 'POST',
      headers: { ...plan.headers, 'content-length': String(body.length) },
      body,
      signal: controller.signal,
      // Node 22 的 fetch 会读 NODE_USE_ENV_PROXY / 显式 dispatcher；这里不额外引 undici，
      // 代理交给环境变量（NODE_USE_ENV_PROXY=1 + HTTPS_PROXY）。
      ...(proxy ? {} : {}),
    })
    const headers = {}
    res.headers.forEach((value, key) => {
      headers[String(key).toLowerCase()] = value
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, headers, text, elapsedMs: Date.now() - started, sentBytes: body.length }
  } finally {
    clearTimeout(timer)
  }
}

// ─────────────────────────── 报告 ───────────────────────────

function headerPreview(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = String(key).toLowerCase()
    // 凭据类头一律不打印，只报"存在 + 长度"
    if (['authorization', 'x-api-key', 'cookie', 'proxy-authorization'].includes(lower)) {
      out[lower] = `<redacted:${String(value).length}>`
      continue
    }
    out[lower] = value
  }
  return out
}

function printPlan(plan, credential) {
  process.stdout.write(`目标通道      ${plan.target}\n`)
  process.stdout.write(`上游 URL      ${plan.url}\n`)
  process.stdout.write(`模型          ${plan.model}\n`)
  process.stdout.write(`通道          ${plan.transport}\n`)
  if (credential.kind === 'codex') {
    process.stdout.write(`凭据          codex ${credential.email || credential.accountId || '(匿名)'}`)
    process.stdout.write(credential.expiresInSecs != null ? `，剩余 ${credential.expiresInSecs} 秒\n` : '\n')
  } else {
    process.stdout.write(`凭据          claude ${credential.authScheme}（来源 ${credential.source}）\n`)
  }
  if (plan.degraded) process.stdout.write(`降级          ${plan.degraded}\n`)
  process.stdout.write(`请求字节      ${Buffer.byteLength(plan.payload)}\n`)
  process.stdout.write(`出站头        ${JSON.stringify(headerPreview(plan.headers), null, 2)}\n`)
  process.stdout.write(`\n出站骨架（脱敏）:\n${formatShape(shapeOf(plan.body))}\n`)
}

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }

  let credential
  let plan
  try {
    if (args.target === 'codex') {
      credential = loadCodexCredential(path.resolve(args.credential || LIVE_CREDENTIAL))
      if (credential.disabled) throw new Error('凭据被标记为 disabled')
      if (credential.expiresInSecs != null && credential.expiresInSecs <= 0) throw new Error('凭据已过期')
      plan = await planCodex(args, credential)
    } else {
      credential = loadAnthropicCredential(args.credential)
      plan = await planAnthropic(args, credential)
    }
  } catch (error) {
    process.stderr.write(`凭据/构造失败: ${error.message}\n`)
    return 2
  }

  if (!args.json) printPlan(plan, credential)

  if (!args.send) {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            dry_run: true,
            target: plan.target,
            url: plan.url,
            model: plan.model,
            bytes: Buffer.byteLength(plan.payload),
            degraded: plan.degraded,
            shape: shapeOf(plan.body),
          },
          null,
          2,
        )}\n`,
      )
    } else {
      process.stdout.write('\nDRY-RUN：未发送。加 --send 才会真的发出（会消耗 token）。\n')
    }
    return 0
  }

  let response
  try {
    response = await sendRequest(plan, { timeoutMs: args.timeout, proxy: args.proxy || credential.proxy })
  } catch (error) {
    const reason = error.name === 'AbortError' ? `超时 ${args.timeout}ms` : error.message
    process.stderr.write(`发送失败: ${reason}\n`)
    return 2
  }

  const contentType = response.headers['content-type'] || ''
  const isSse = contentType.includes('text/event-stream') || contentType === ''
  let parsed = null
  try {
    parsed = JSON.parse(response.text)
  } catch {
    /* 不是 JSON（流式或错误文本） */
  }
  const sse = isSse && !parsed ? consumeSse(response.text) : null
  const usage = sse ? sse.usage : consumeJson(parsed)
  const quota = quotaHeaders(response.headers)
  const rejected = response.ok ? [] : rejectedFields(parsed ?? response.text.slice(0, 4000))

  const report = {
    dry_run: false,
    target: plan.target,
    url: plan.url,
    model: plan.model,
    status: response.status,
    accepted: response.ok,
    elapsed_ms: response.elapsedMs,
    // payload_bytes 是明文 JSON 的大小，sent_bytes 是实际发出的字节数（zstd 后会更小）
    payload_bytes: Buffer.byteLength(plan.payload),
    sent_bytes: response.sentBytes,
    content_encoding: plan.headers['content-encoding'] || 'identity',
    tokens: usage,
    quota,
    rejected_fields: rejected,
    events: sse?.events || [],
    stop_reasons: sse?.stopReasons || [],
    saw_done: sse?.sawDone ?? null,
    error: response.ok ? null : summariseError(parsed, response.text),
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`\nHTTP          ${response.status}${response.ok ? '（已接受）' : '（被拒绝）'}\n`)
    process.stdout.write(`耗时          ${response.elapsedMs} ms\n`)
    process.stdout.write(
      `发送字节      ${report.sent_bytes}（明文 ${report.payload_bytes}，编码 ${report.content_encoding}）\n`,
    )
    process.stdout.write(`本次 token    输入 ${usage.input} / 输出 ${usage.output} / 合计 ${usage.total}`)
    if (usage.cache_read || usage.cache_write) {
      process.stdout.write(`（缓存读 ${usage.cache_read} / 写 ${usage.cache_write}）`)
    }
    process.stdout.write('\n')
    if (Object.keys(quota).length) process.stdout.write(`配额头        ${JSON.stringify(quota, null, 2)}\n`)
    else process.stdout.write('配额头        上游未返回\n')
    if (rejected.length) process.stdout.write(`被拒字段      ${rejected.join(', ')}\n`)
    else if (!response.ok) process.stdout.write('被拒字段      未能从错误信息里解析出字段名\n')
    if (report.error) process.stdout.write(`错误摘要      ${report.error}\n`)
    if (sse) process.stdout.write(`SSE 事件      ${sse.events.join(', ') || '(空)'}\n`)
    if (args.rawOk && response.ok) process.stdout.write(`\n响应正文:\n${response.text.slice(0, 4000)}\n`)
  }

  return response.ok ? 0 : 1
}

/** 错误摘要：只留类型与文案，超长截断，避免把整段回显打进终端 */
function summariseError(parsed, text) {
  const node = parsed?.error || parsed?.response?.error || parsed?.detail || parsed
  if (typeof node === 'string') return node.slice(0, 500)
  if (node && typeof node === 'object') {
    const type = node.type || node.code || node.error?.type || ''
    const message = node.message || node.error?.message || node.detail || ''
    const short = `${type}${type && message ? ': ' : ''}${message}`.trim()
    if (short) return short.slice(0, 800)
  }
  return String(text || '').slice(0, 500)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await main(process.argv.slice(2))) ?? 0
}

// 供测试直接调用（避免测试重复实现一遍解析逻辑）
export { planCodex, planAnthropic, loadCodexCredential, loadAnthropicCredential }
