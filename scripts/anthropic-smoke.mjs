#!/usr/bin/env node
/**
 * 对着真实 api.anthropic.com 验一次出站：请求格式对不对，上游怎么回。
 *
 * 默认发的是「假 token」：目的不是拿到回答，而是验证请求能**到达上游并被判定
 * 为认证失败**。这个区分很关键——
 *
 *   401 + `authentication_error`  → 格式正确，只是凭据无效（本脚本的预期结果）
 *   400 + `invalid_request_error` → 格式有问题（字段/头/压缩写错了）
 *   裸 `Bad Request`（纯文本）     → 压缩头与实际字节不一致
 *   404 / 其他                   → host 或路径错了
 *
 * 因此「假 token 拿到 401」本身就是一条通过判据，不需要真凭据也能跑。
 *
 * 用法：
 *   node scripts/anthropic-smoke.mjs                    # 假 token 打真实上游（缺省）
 *   node scripts/anthropic-smoke.mjs --dry-run          # 只构造，不发包
 *   CLAUDE_CODE_OAUTH_TOKEN=... node scripts/anthropic-smoke.mjs --real
 *   node scripts/anthropic-smoke.mjs --credential path/to/cred.json --real
 *   node scripts/anthropic-smoke.mjs --model claude-sonnet-4-5 --max-tokens 16
 *
 * 退出码：
 *   0  假 token 拿到预期分类（401/auth）或真凭据拿到 2xx
 *   1  格式被上游判为非法（4xx 但不是 auth 类），或真凭据请求失败
 *   2  用法 / 网络不可用
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AnthropicUpstream,
  DEFAULT_BASE_URL,
  ERROR_KIND,
  MODE,
  buildBetaHeader,
  buildOutboundHeaders,
  encodeBody,
  headersToObject,
  messagesUrl,
  redactHeaders,
} from '../src/anthropic.mjs'
import { resolveCredential } from '../src/anthropic-credentials.mjs'
import { prepareOutbound } from '../src/server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 明显无效的 token：格式上像 OAuth，但上游一定会拒 */
const FAKE_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-FOR-FORMAT-PROBE-000000000000000000000000'

const USAGE = `用法: node scripts/anthropic-smoke.mjs [选项]

  --real                使用真实凭据（环境变量 / --credential）
  --credential <file>   凭据文件（单账号 / {accounts:[]} / 官方 credentials.json）
  --dry-run             只构造请求并打印头与体骨架，不发包
  --stream              走流式（缺省非流式聚合）
  --model <id>          模型，缺省 claude-sonnet-4-5
  --max-tokens <n>      输出上限，缺省 8
  --prompt <text>       用户消息，缺省 "reply with OK"
  --base-url <url>      上游 base，缺省 https://api.anthropic.com
  --timeout <ms>        超时，缺省 30000
  --json                机器可读输出
  --help                本帮助

没有真凭据时缺省用假 token，预期拿到 401 + authentication_error：
那就是「请求格式正确」的证据。`

function parseArgs(argv) {
  const out = {
    real: false,
    credential: null,
    dryRun: false,
    stream: false,
    model: 'claude-sonnet-4-5',
    maxTokens: 8,
    prompt: 'reply with OK',
    baseUrl: DEFAULT_BASE_URL,
    timeout: 30_000,
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[++i]
      if (value == null) throw new Error(`${arg} 需要值`)
      return value
    }
    if (arg === '--real') out.real = true
    else if (arg === '--credential') out.credential = next()
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--stream') out.stream = true
    else if (arg === '--model') out.model = next()
    else if (arg === '--max-tokens') out.maxTokens = Number(next())
    else if (arg === '--prompt') out.prompt = next()
    else if (arg === '--base-url') out.baseUrl = next()
    else if (arg === '--timeout') out.timeout = Number(next())
    else if (arg === '--json') out.json = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`未知参数: ${arg}`)
  }
  if (!Number.isFinite(out.maxTokens) || out.maxTokens <= 0) throw new Error('--max-tokens 必须是正数')
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error('--timeout 必须是正数')
  return out
}

/**
 * 决定用哪个 token。
 *
 * 只有显式 --real 才会去读真实凭据：缺省行为必须是「发假 token」，
 * 否则一个手滑的 `node scripts/anthropic-smoke.mjs` 就会拿真账号去花配额。
 */
function pickCredential(args) {
  if (!args.real) {
    return { token: FAKE_TOKEN, auth_scheme: 'oauth', source: 'fake', real: false }
  }
  let resolved
  try {
    resolved = resolveCredential({
      path: args.credential,
      env: process.env,
      fallbackId: 'smoke',
    })
  } catch (error) {
    // 没有真凭据不是脚本的 bug，不该打一屏堆栈。
    // 给出「怎么配」并退 2，同时提示去掉 --real 就能用假 token 验格式。
    console.error(`\n没有可用的真实凭据: ${error.message}`)
    console.error('  配置方式（任选一种）：')
    console.error('    CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... node scripts/anthropic-smoke.mjs --real')
    console.error('    ANTHROPIC_API_KEY=sk-ant-api03-...   node scripts/anthropic-smoke.mjs --real')
    console.error('    node scripts/anthropic-smoke.mjs --real --credential path/to/cred.json')
    console.error('\n  想在不配凭据的情况下验证请求格式：去掉 --real（用假 token，预期 401）。')
    process.exit(2)
  }
  return {
    token: resolved.account.access_token,
    auth_scheme: resolved.account.auth_scheme || 'oauth',
    source: resolved.source,
    real: true,
  }
}

/** 打印请求头（token 已脱敏） */
function printHeaders(headers) {
  console.log('\n── 出站请求头（实际发出去的）')
  const entries = Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))
  for (const [key, value] of entries) console.log(`  ${key}: ${value}`)
  console.log(`  （共 ${entries.length} 个）`)
}

/** 打印 body 骨架：只看结构，不打印提示词全文 */
function printBodyShape(body) {
  console.log('\n── 出站 body 骨架')
  const keys = Object.keys(body)
  console.log(`  顶层字段: ${keys.join(', ')}`)
  console.log(`  stream: ${'stream' in body ? body.stream : '(无此键)'}`)
  console.log(`  model: ${body.model}`)
  console.log(`  max_tokens: ${body.max_tokens}`)
  console.log(`  messages: ${Array.isArray(body.messages) ? body.messages.length : 0} 条`)
  const system = Array.isArray(body.system) ? body.system : []
  console.log(`  system: ${system.length} 块`)
  for (let i = 0; i < system.length; i += 1) {
    const text = String(system[i]?.text ?? '')
    const billing = /x-anthropic-billing-header:([^\n]*)/.exec(text)
    const cch = /cch=([0-9a-f]{5})/.exec(text)
    const marker = system[i]?.cache_control?.ttl ? ` cache_control.ttl=${system[i].cache_control.ttl}` : ''
    if (billing) {
      console.log(`    system[${i}] billing: ${billing[1].trim().slice(0, 100)}${marker}`)
      console.log(`    system[${i}] cch: ${cch ? cch[1] : '(无)'}`)
    } else {
      console.log(`    system[${i}] text: ${text.length} 字符${marker}`)
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  console.log(`  body 字节数: ${bytes}`)
}

/** 把上游错误体压成一行可读摘要 */
function errorSummary(out) {
  if (out.classification?.kind === ERROR_KIND.NETWORK) {
    return `network: ${out.classification.error}`
  }
  const type = out.json?.error?.type || out.json?.type || '(无 error.type)'
  const message = out.json?.error?.message || out.text || '(空响应体)'
  return `${type}: ${String(message).slice(0, 200)}`
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`参数错误: ${error.message}\n`)
    console.error(USAGE)
    process.exit(2)
  }
  if (args.help) {
    console.log(USAGE)
    process.exit(0)
  }

  const credential = pickCredential(args)

  // 组装与线上同一条链路：prompt-profiles → system 布局 → betas → 断点 → cch。
  // 用 prepareOutbound 而不是手搓，否则这份 smoke 验的不是真实出站形态。
  const outbound = prepareOutbound(
    {
      model: args.model,
      max_tokens: args.maxTokens,
      messages: [{ role: 'user', content: args.prompt }],
    },
    { systemLayout: 'zero' },
  )

  const mode = args.stream ? MODE.STREAM : MODE.AGGREGATE
  const upstream = new AnthropicUpstream({
    baseUrl: args.baseUrl,
    timeoutMs: args.timeout,
  })

  if (!args.json) {
    console.log('=== Anthropic 出站冒烟 ===')
    console.log(`  目标: ${messagesUrl(args.baseUrl)}`)
    console.log(`  模式: ${mode}${args.dryRun ? '（dry-run，不发包）' : ''}`)
    console.log(`  凭据: ${credential.source}${credential.real ? '（真实）' : '（假 token，预期 401）'}`)
    console.log(`  认证形态: ${credential.auth_scheme}`)
  }

  if (args.dryRun) {
    // dry-run 复用与 createMessage 完全相同的两步构造（beta 合并 → 头组装），
    // 因此打印出来的头与真发时逐字段一致；唯一不打印的是 content-encoding，
    // 它取决于压缩是否真的发生（encodeBody 的结果），不发包就拿不到 ground truth。
    const betaList = buildBetaHeader({ bodyBetas: outbound?.betas ?? [] })
    const previewHeaders = redactHeaders(
      buildOutboundHeaders({
        token: credential.token,
        authScheme: credential.auth_scheme,
        betas: betaList,
        accept: args.stream ? 'text/event-stream' : 'application/json',
        env: process.env,
      }),
    )
    const encoded = encodeBody(outbound, { threshold: 1024 })
    if (args.json) {
      console.log(JSON.stringify({
        url: messagesUrl(args.baseUrl),
        mode,
        dry_run: true,
        credential_source: credential.real ? credential.source : 'fake',
        request_headers: previewHeaders,
        anthropic_beta: betaList,
        wire_body_keys: Object.keys(outbound),
        stream_flag: 'stream' in outbound ? outbound.stream : null,
        body_bytes: Buffer.byteLength(JSON.stringify(outbound), 'utf8'),
        would_compress: encoded.encoding,
      }, null, 2))
      process.exit(0)
    }
    printHeaders(previewHeaders)
    printBodyShape(outbound)
    console.log(`  将压缩: ${encoded.encoding ?? '否（体 ' + encoded.wireBytes + ' 字节）'}`)
    console.log('\n（dry-run 未发包，所以没有 content-encoding 与上游状态码。）')
    process.exit(0)
  }

  const startedAt = Date.now()
  let out
  try {
    out = await upstream.createMessage({
      body: outbound,
      headers: credential.auth_scheme === 'api_key'
        ? { 'x-api-key': credential.token }
        : { authorization: `Bearer ${credential.token}` },
      mode,
      env: process.env,
    })
  } catch (error) {
    console.error(`\n请求抛错: ${error?.message || error}`)
    process.exit(2)
  }
  const elapsed = Date.now() - startedAt

  if (args.json) {
    console.log(JSON.stringify({
      url: upstream.lastRequest?.url ?? messagesUrl(args.baseUrl),
      mode,
      credential_source: credential.real ? credential.source : 'fake',
      status: out.status,
      ok: out.ok,
      kind: out.classification?.kind ?? null,
      request_id: out.headers?.['request-id'] ?? out.headers?.['anthropic-request-id'] ?? null,
      beta_header: out.requestHeaders?.['anthropic-beta'] ?? null,
      retry_after: out.retryAfter,
      elapsed_ms: elapsed,
      request_headers: out.requestHeaders,
      wire_bytes: out.wireBytes,
      encoding: out.encoding,
      error: out.ok ? null : errorSummary(out),
      text_preview: out.ok && out.json ? JSON.stringify(out.json).slice(0, 400) : null,
    }, null, 2))
  } else {
    // 头从 createMessage 的返回值里取（它记录的是实际发出去的那份，已脱敏）
    printHeaders(out.requestHeaders ?? {})
    printBodyShape(outbound)
    if (out.encoding) console.log(`  content-encoding: ${out.encoding}（体 ${out.wireBytes} 字节，已压缩）`)
    else console.log(`  content-encoding: 无（体 ${out.wireBytes} 字节，未压缩）`)

    console.log('\n── 上游响应')
    console.log(`  HTTP ${out.status}   耗时 ${elapsed}ms`)
    const interesting = ['request-id', 'anthropic-request-id', 'retry-after', 'content-type', 'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-input-tokens-remaining']
    for (const key of interesting) {
      if (out.headers?.[key] != null) console.log(`  ${key}: ${out.headers[key]}`)
    }
    console.log(`  分类: ${out.classification?.kind ?? '(无)'}`)
    if (!out.ok) {
      console.log(`  错误摘要: ${errorSummary(out)}`)
      console.log('\n── 上游原始错误体')
      console.log(out.text ? out.text.slice(0, 2000) : '(空)')
    } else if (out.json) {
      const message = out.json
      const text = Array.isArray(message.content)
        ? message.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
        : ''
      console.log(`  message.id: ${message.id}`)
      console.log(`  model: ${message.model}`)
      console.log(`  stop_reason: ${message.stop_reason}`)
      console.log(`  usage: ${JSON.stringify(message.usage)}`)
      console.log(`  文本（前 400 字符）: ${text.slice(0, 400)}`)
    }
  }

  // ── 判定
  const kind = out.classification?.kind
  const expectedAuthFailure = !credential.real && out.status === 401
  const success = credential.real && out.ok
  const formatRejected = out.status >= 400 && out.status < 500 && kind === ERROR_KIND.INVALID_REQUEST

  if (!args.json) {
    console.log('\n── 判定')
    if (expectedAuthFailure) {
      console.log('  ✓ 假 token 拿到 401 + 认证类错误：请求格式被上游接受，只是凭据无效。')
      console.log('    这就是「头/体/压缩都正确」的证据。')
    } else if (success) {
      console.log('  ✓ 真实凭据请求成功，上游返回 2xx。')
    } else if (formatRejected) {
      console.log('  ✗ 上游把请求判为非法（invalid_request）：字段/头/压缩有错，需要修。')
    } else if (kind === ERROR_KIND.NEEDS_REFRESH) {
      console.log('  ✗ 真实凭据已失效（401）：换一份有效凭据再跑。')
    } else if (kind === ERROR_KIND.RATE_LIMITED) {
      console.log(`  ✗ 被限流（429），retry-after=${out.retryAfter ?? '未给'}。请求格式本身没问题。`)
    } else if (kind === ERROR_KIND.NETWORK) {
      console.log(`  ✗ 网络层失败: ${out.classification.error}`)
    } else if (out.status === 0) {
      console.log('  ✗ 没拿到响应。')
    } else {
      console.log(`  ? 未预期的结果：HTTP ${out.status} / ${kind}`)
    }
  }

  if (kind === ERROR_KIND.NETWORK) process.exit(2)
  if (expectedAuthFailure || success) process.exit(0)
  // 429/529 属于上游侧状态，请求格式是对的；按「格式通过」处理但用非 0 提示
  if (kind === ERROR_KIND.RATE_LIMITED || kind === ERROR_KIND.OVERLOADED) process.exit(1)
  process.exit(1)
}

main().catch((error) => {
  console.error(error?.stack || error)
  process.exit(2)
})
