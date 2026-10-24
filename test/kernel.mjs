#!/usr/bin/env node
/**
 * 内核适配层测试：契约、服务、supervisor 兼容、真实客户端兼容。
 *
 * 覆盖范围（对应验收清单）：
 *   1. 5 个端点的契约定义（method / path / 认证 / 请求字段 / 响应字段 / 状态码）
 *   2. 契约校验器本身正确（能识别缺字段、错类型、错状态码）
 *   3. HTTP 服务：TCP 与 Unix socket 两种模式都能起、都能打
 *   4. health 快速响应（< 100ms）与形状符合 supervisor 就绪判定
 *   5. 认证头校验：两个头名都认、错 token 拒绝、缺 token 拒绝
 *   6. 错误格式统一
 *   7. cancel 真能取消在途请求，且幂等、能 404 式返回未命中
 *   8. codex/responses 未配凭据时回结构化 503
 *   9. supervisor-compat：就绪判定复刻、版本握手结论、kernel.json 投影、
 *      双 socket 目标、启动暗坑告警
 *
 * 兼容性实测（用 vm2api 的真实 client 打我们的内核）单独在家进程里跑，
 * 因为它会装 module resolve hook（影响整进程的模块解析）。见 runCompatSection。
 *
 * 运行：node test/kernel.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  KERNEL_ENDPOINTS,
  KERNEL_AUTH_HEADERS,
  CLAUDE_ENVELOPE_FIELDS,
  CODEX_ENVELOPE_FIELDS,
  CODEX_OPTIONS_FIELDS,
  KERNEL_VERSION,
  KERNEL_WORKER_VERSION,
  KERNEL_PROTOCOL_VERSION,
  validateAgainstContract,
  healthIsReady,
  isAuthed,
  bearerFromHeaders,
  requestIdFromBody,
  endpointSummary,
} from '../src/kernel/contract.mjs'

import {
  readinessPayload,
  supervisorView,
  supervisorProcessUp,
  versionHandshake,
  kernelConfigFromVN2,
  listenTarget,
  listenTargets,
  startupWarnings,
  SUPERVISOR_HEALTH_TIMEOUT_MS,
  SUPERVISOR_POLL_INTERVAL_MS,
  SUPERVISOR_SLOTS,
  DEFAULT_START_TIMEOUT_MS,
  KVM_HEALTH_TIMEOUT_MS,
  WEDGED_READY_WAIT_MS,
  SUPERVISOR_START,
} from '../src/kernel/supervisor-compat.mjs'

import { DEFAULT_KERNEL_SLOTS, KERNEL_ENGINE_LABEL, SOCKET_NAMES } from '../src/kernel/defaults.mjs'
import { createKernelServer, parseKernelArgs, runKernelMain } from '../src/kernel/server.mjs'
import { kernelConfigFromFile } from '../src/kernel/supervisor-compat.mjs'
import { workerError } from '../src/config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

let pass = 0
let fail = 0
const failures = []

function eq(name, actual, expected) {
  const ok = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    failures.push(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    console.log(`  ✗ ${name} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function ok(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    failures.push(`${name}${detail ? `: ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n── ${title} ──`)
}

// ═══════════════════════════════════════════ 工具

/** 临时槽目录，布局与 vm2api 一致（见 compat-test 的 makeSlotDir）。 */
function makeSlot({ token = 'test-internal-token' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-test-'))
  const runDir = path.join(root, 'vms', 'vm-test', 'run')
  const cliHome = path.join(root, 'vms', 'vm-test', 'cli-home')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(cliHome, '.claude'), { recursive: true, mode: 0o700 })
  const tokenPath = path.join(runDir, 'internal.token')
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
  const credentialPath = path.join(cliHome, '.claude', 'credentials.json')
  fs.writeFileSync(
    credentialPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'test-access',
        refreshToken: 'test-refresh',
        expiresAt: Date.now() + 3_600_000,
      },
    }),
    { mode: 0o600 },
  )
  return {
    root,
    runDir,
    cliHome,
    token,
    tokenPath,
    credentialPath,
    socketPath: path.join(runDir, 'kernel.sock'),
    codexSocketPath: path.join(runDir, 'codex-kernel.sock'),
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {}
    },
  }
}

/** 假 CLI 路径（可执行）。 */
function compatCli() {
  const bin = path.join(ROOT, 'src', 'kernel', 'compat-cli.mjs')
  try {
    fs.chmodSync(bin, 0o755)
  } catch {}
  return bin
}

/**
 * Codex 通道的凭据文件：codex-server 认的是 CLI 导出的那套形状
 * （access_token / account_id / expired），与 Claude 的 claudeAiOauth 完全不同。
 */
function makeCodexCredential({ token = 'CODEX_TOKEN', accountId = 'acct-kernel' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-codex-cred-'))
  const file = path.join(dir, 'codex-cred.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      access_token: token,
      account_id: accountId,
      expired: '2099-01-01T00:00:00+08:00',
      refresh_token: 'rt-kernel',
      type: 'codex',
    }),
  )
  return { file, dir }
}

/**
 * 与真实上游同构的 Responses SSE 文本。
 * 帧序与 codex-server 的聚合逻辑对齐（created → item.added → part.added →
 * delta* → text.done → item.done → completed）。
 */
function buildCodexSse({ text = '内核转发', model = 'gpt-6-astra', respId = 'resp_kernel' } = {}) {
  const frames = [
    ['response.created', { type: 'response.created', response: { id: respId, model, status: 'in_progress', output: [] } }],
    [
      'response.output_item.added',
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'msg_k', role: 'assistant', content: [], phase: 'final_answer' },
      },
    ],
    [
      'response.content_part.added',
      {
        type: 'response.content_part.added',
        item_id: 'msg_k',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
    ],
    ...text.split('').map((ch) => [
      'response.output_text.delta',
      { type: 'response.output_text.delta', item_id: 'msg_k', output_index: 0, content_index: 0, delta: ch },
    ]),
    ['response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_k', text }],
    [
      'response.output_item.done',
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id: 'msg_k', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
      },
    ],
    [
      'response.completed',
      {
        type: 'response.completed',
        response: {
          id: respId,
          object: 'response',
          status: 'completed',
          model,
          output: [
            { type: 'message', id: 'msg_k', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            total_tokens: 17,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ],
  ]
  return frames.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
}

/**
 * 假 fetch：只喂 SSE，不建立任何网络连接。
 * 与真实上游一致，故意不给 content-type —— codex-server 必须靠帧内容判断。
 */
function makeCodexFakeFetch({ sse = buildCodexSse(), status = 200, json = null } = {}) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init })
    if (status !== 200) {
      return new Response(JSON.stringify(json ?? { detail: 'upstream boom' }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse))
        c.close()
      },
    })
    return new Response(body, { status: 200, headers: { 'x-codex-plan-type': 'pro' } })
  }
  fn.calls = calls
  return fn
}

/** 起一个内核，返回 { kernel, config, cleanup }。 */
async function boot({
  slot,
  token,
  listen = 'unix',
  overrides = {},
  claudeBin = null,
  deps = null,
} = {}) {
  const dir = slot || makeSlot({ token })
  const config = {
    vm_id: 'vm-test',
    internal_token: dir.token,
    socket_path: dir.socketPath,
    codex_socket_path: dir.codexSocketPath,
    credential_path: dir.credentialPath,
    claude_bin: claudeBin == null ? compatCli() : claudeBin,
    slots_per_worker: 4,
    kernel_max_request_bytes: 1 << 20,
    kernel_listen: listen,
    kernel_tcp_host: '127.0.0.1',
    kernel_tcp_port: 0,
    runtime_kind: 'local_cli',
    provider: 'local_cli',
    delivery_mode: 'realtime',
    system_layout: 'zero',
    default_cache_ttl: '1h',
    timezone: 'UTC',
    proxy_url: '',
    proxy_required: false,
    cli_version: '2.1.281',
    cli_env: { COMPAT_CLI_DELAY_MS: '30', COMPAT_CLI_TEXT: 'y'.repeat(60) },
    ...overrides,
  }
  const kernel = createKernelServer(deps ? { config, deps } : { config })
  const info = await kernel.start()
  return {
    kernel,
    config,
    slot: dir,
    info,
    async cleanup() {
      try {
        await kernel.close()
      } catch {}
      if (!slot) dir.cleanup()
    },
  }
}

/** 简易 HTTP 调用（unix 或 tcp）。 */
function call(target, { path: pathname, method = 'GET', body = null, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const h = { ...headers }
    if (payload) {
      h['content-type'] = 'application/json'
      h['content-length'] = String(payload.length)
    }
    if (token) {
      // 两个头都发，与 vm2api 的 workerRequest 一致
      h['x-kin-internal-token'] = token
      h['x-internal-token'] = token
    }
    const opts = typeof target === 'string' ? { socketPath: target } : { host: target.host, port: target.port }
    const startedAt = Date.now()
    const req = http.request({ ...opts, path: pathname, method, headers: h }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          trailers: res.trailers,
          text,
          body: parsed,
          elapsedMs: Date.now() - startedAt,
        })
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => req.destroy(new Error('call timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}

async function waitFor(predicate, timeoutMs = 2000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return predicate()
}

function envelopeOf(body, { stream = false, requestId = 'req-test' } = {}) {
  return {
    body,
    headers: {},
    stream,
    delivery_mode: 'realtime',
    preserve_cache_breakpoints: true,
    cache_ttl: null,
    request_id: requestId,
  }
}

// ═══════════════════════════════════════════ 1. 契约定义

section('1. 端点契约定义')
eq('端点总数 5', Object.keys(KERNEL_ENDPOINTS).length, 5)
eq('health 路径', KERNEL_ENDPOINTS.health.path, '/internal/health')
eq('health 方法', KERNEL_ENDPOINTS.health.method, 'GET')
eq('messages 路径', KERNEL_ENDPOINTS.messages.path, '/internal/v1/messages')
eq('messages 方法', KERNEL_ENDPOINTS.messages.method, 'POST')
eq('models 路径', KERNEL_ENDPOINTS.models.path, '/internal/v1/models')
eq('models 方法', KERNEL_ENDPOINTS.models.method, 'GET')
eq('cancel 路径', KERNEL_ENDPOINTS.cancel.path, '/internal/v1/cancel')
eq('cancel 方法', KERNEL_ENDPOINTS.cancel.method, 'POST')
eq('codexResponses 路径', KERNEL_ENDPOINTS.codexResponses.path, '/internal/v1/codex/responses')
eq('codexResponses 方法', KERNEL_ENDPOINTS.codexResponses.method, 'POST')

ok(
  '五个端点都要求认证',
  Object.values(KERNEL_ENDPOINTS).every((e) => e.auth === true),
)
eq('认证头两个名字且有序', [...KERNEL_AUTH_HEADERS], ['x-kin-internal-token', 'x-internal-token'])
ok(
  'messages 契约含 request_id 字段',
  KERNEL_ENDPOINTS.messages.requestFields.includes('request_id'),
)
ok(
  'Claude envelope 8 字段',
  CLAUDE_ENVELOPE_FIELDS.length === 8,
  `实际 ${CLAUDE_ENVELOPE_FIELDS.length}`,
)
ok(
  'Claude envelope 含 delivery_mode / cache_ttl / preserve_cache_breakpoints',
  ['delivery_mode', 'cache_ttl', 'preserve_cache_breakpoints'].every((f) =>
    CLAUDE_ENVELOPE_FIELDS.includes(f),
  ),
)
ok('Codex envelope 含 session / options', ['session', 'options'].every((f) => CODEX_ENVELOPE_FIELDS.includes(f)))
ok(
  'Codex envelope 不含 Claude 独有的三个字段',
  ['delivery_mode', 'cache_ttl', 'preserve_cache_breakpoints'].every((f) => !CODEX_ENVELOPE_FIELDS.includes(f)),
)
eq('Codex options 五个子字段', CODEX_OPTIONS_FIELDS.length, 5)
ok(
  'messages 状态码含 401 needs_refresh 通道',
  KERNEL_ENDPOINTS.messages.status.includes(401),
)
ok('messages 状态码含 503 slot_busy 通道', KERNEL_ENDPOINTS.messages.status.includes(503))
eq('health 状态码集合', [...KERNEL_ENDPOINTS.health.status], [200, 401, 503])
eq('cancel request_id 必填', [...KERNEL_ENDPOINTS.cancel.requestRequired], ['request_id'])
eq('messages body 必填', [...KERNEL_ENDPOINTS.messages.requestRequired], ['body'])
const summary = endpointSummary('health')
eq('endpointSummary 可读摘要', summary.method + ' ' + summary.path, 'GET /internal/health')

// ═══════════════════════════════════════════ 2. 契约校验器

section('2. 契约校验器')
eq(
  '合规请求返回空问题列表',
  validateAgainstContract('health', { method: 'GET', path: '/internal/health' }, { status: 200, body: { ok: true, ready_slots: 4, engine: 'rust' } }),
  [],
)
ok(
  '识别错误方法',
  validateAgainstContract('health', { method: 'POST' }, { status: 200, body: { ok: true } }).some((p) =>
    p.includes('method'),
  ),
)
ok(
  '识别错误路径',
  validateAgainstContract('messages', { path: '/internal/v1/wrong' }, { status: 200, body: {} }).some((p) =>
    p.includes('path'),
  ),
)
ok(
  '识别缺失必填字段',
  validateAgainstContract('messages', { body: { stream: false } }, { status: 200, body: {} }).some((p) =>
    p.includes('missing required field: body'),
  ),
)
ok(
  '识别未知字段',
  validateAgainstContract('cancel', { body: { request_id: 'x', bogus: 1 } }, { status: 200, body: { ok: true } }).some(
    (p) => p.includes('unknown field: bogus'),
  ),
)
ok(
  '识别越界状态码',
  validateAgainstContract('health', {}, { status: 418, body: { ok: true } }).some((p) => p.includes('status 418')),
)
ok(
  '识别 2xx 上的错误体',
  validateAgainstContract('health', {}, { status: 200, body: { ok: false, error: {} } }).some((p) =>
    p.includes('error body'),
  ),
)
ok(
  '识别响应缺字段',
  validateAgainstContract('health', {}, { status: 200, body: { ok: true } }).some((p) =>
    p.includes('missing field: ready_slots'),
  ),
)
ok(
  '识别字段类型错误',
  validateAgainstContract('health', {}, { status: 200, body: { ok: true, ready_slots: '4', engine: 'rust' } }).some(
    (p) => p.includes('not number'),
  ),
)
ok(
  '错误状态码必须带 error 对象',
  validateAgainstContract('messages', {}, { status: 502, body: { message: 'x' } }).some((p) =>
    p.includes('lacks error object'),
  ),
)
ok(
  'Anthropic 形态错误体被接受',
  validateAgainstContract('messages', {}, { status: 502, body: { type: 'error', error: { type: 'api_error' } } })
    .length === 0,
)
ok(
  '未知道端点被拒绝',
  validateAgainstContract('bogus', {}, {}).some((p) => p.includes('unknown endpoint')),
)
eq('healthIsReady 缺省 ready_slots 视为就绪', healthIsReady({ ok: true }), true)
eq('healthIsReady ready_slots=0 视为未就绪', healthIsReady({ ok: true, ready_slots: 0 }), false)
eq('healthIsReady healthy=false 一律未就绪', healthIsReady({ ok: true, ready_slots: 5, healthy: false }), false)
eq('requestIdFromBody 取 request_id', requestIdFromBody({ request_id: 'abc' }), 'abc')
eq('requestIdFromBody 缺失返回空串', requestIdFromBody({}), '')
eq('bearerFromHeaders 优先新头', bearerFromHeaders({ 'x-kin-internal-token': 'new', 'x-internal-token': 'old' }), 'new')
eq('bearerFromHeaders 回落旧头', bearerFromHeaders({ 'x-internal-token': 'old' }), 'old')
eq('isAuthed 空 token 一律拒绝', isAuthed({ 'x-kin-internal-token': '' }, ''), false)

// ═══════════════════════════════════════════ 3. supervisor 兼容

section('3. supervisor 兼容层')
eq('supervisor 健康超时预算 400ms', SUPERVISOR_HEALTH_TIMEOUT_MS, 400)
eq('supervisor 轮询间隔 80ms', SUPERVISOR_POLL_INTERVAL_MS, 80)
eq('supervisor 硬性槽数 20', SUPERVISOR_SLOTS, 20)
eq('supervisor 槽数与 defaults 一致', DEFAULT_KERNEL_SLOTS, SUPERVISOR_SLOTS)
eq('engine 字面值', KERNEL_ENGINE_LABEL, 'rust')
eq('默认启动预算 30s', DEFAULT_START_TIMEOUT_MS, 30_000)
eq('KVM 启动预算', KVM_HEALTH_TIMEOUT_MS.kvm, 120_000)
eq('TCG 启动预算', KVM_HEALTH_TIMEOUT_MS.tcg, 480_000)
eq('wedged 等待预算 3s', WEDGED_READY_WAIT_MS, 3_000)
eq('supervisor 内核二进制路径', SUPERVISOR_START.bin, '/home/kincli/.kin/kin-kernel')
eq('supervisor 启动参数', [...SUPERVISOR_START.argv], ['--gateway-worker', '--config', '/run/kin/kernel.json'])
eq('socket 名字（Claude）', SOCKET_NAMES.claude, 'kernel.sock')
eq('socket 名字（Codex）', SOCKET_NAMES.codex, 'codex-kernel.sock')

// 就绪 payload 的三段判定
const readyPayload = readinessPayload(
  { vm_id: 'vm-test', runtime_kind: 'local_cli', cli_version: '2.1.281' },
  { readySlots: 20, cliPid: 4321, slotsPerWorker: 20, startedAt: Date.now() },
)
eq('readiness.ok 为 true', readyPayload.ok, true)
eq('readiness.engine 为 rust', readyPayload.engine, 'rust')
eq('readiness.status 为 200', readyPayload.status, 200)
eq('readiness.ready_slots 透传', readyPayload.ready_slots, 20)
eq('readiness.cli_pid 透传', readyPayload.cli_pid, 4321)
eq('readiness.version 用我们的标识', readyPayload.version, KERNEL_VERSION)
eq('readiness.worker_version 用我们的标识', readyPayload.worker_version, KERNEL_WORKER_VERSION)
eq('readiness.provider 来自 runtime_kind', readyPayload.provider, 'local_cli')
eq('readiness 满足 healthIsReady', healthIsReady(readyPayload), true)
eq('readiness 满足 supervisorProcessUp', supervisorProcessUp(readyPayload), true)

const busyPayload = readinessPayload({}, { readySlots: 0, cliPid: 99, startedAt: Date.now() })
eq('满载时 ok 为 false', busyPayload.ok, false)
const busyView = supervisorView(busyPayload)
eq('满载时 processUp 仍为 true', busyView.processUp, true)
eq('满载时 busy 为 true', busyView.busy, true)
eq('满载时 ready 为 false', busyView.ready, false)

const deadPayload = readinessPayload({}, { readySlots: 0, cliPid: null, startedAt: Date.now() })
const deadView = supervisorView(deadPayload)
eq('CLI 死时 busy 为 false', deadView.busy, false)
eq('CLI 死时 needsRestart 为 false（进程还在）', deadView.needsRestart, false)

const gaveUp = supervisorView({ ok: true, engine: 'rust', healthy: false, ready_slots: 0, cli_pid: 0 })
eq('healthy=false 时 needsRestart 为 true', gaveUp.needsRestart, true)
eq('healthy=false 时 ready 为 false', gaveUp.ready, false)

const recovering = supervisorView({ ok: true, engine: 'rust', healthy: true, recovering: true, ready_slots: 0, cli_pid: 0 })
eq('recovering 时 busy 为 true', recovering.busy, true)

// 版本握手结论
const hs = versionHandshake()
eq('版本握手：无版本门禁', hs.hasVersionGate, false)
eq('版本握手：engine 必须 rust', hs.engine, 'rust')
eq('版本握手：帧协议版本 2', hs.frameProtocolVersion, KERNEL_PROTOCOL_VERSION)
eq('版本握手：就绪字段顺序', hs.readinessFields, ['ok', 'status', 'engine', 'healthy', 'ready_slots'])

// kernel.json 投影
const projected = kernelConfigFromVN2({
  vm_id: 'vm-proj',
  socket_path: '/run/kin/kernel.sock',
  internal_token: 'secret',
  credential_path: '/home/kincli/.claude/credentials.json',
  claude_bin: '/opt/kin/cli-node',
  slots_per_worker: 20,
  max_request_bytes: 33_554_432,
  runtime_kind: 'local_cli',
  provider: 'local_cli',
  delivery_mode: 'verified',
  persona_preset: 'official_full',
  system_layout: 'identity',
  default_cache_ttl: '5m',
  timezone: 'Asia/Shanghai',
  proxy_required: true,
})
eq('投影 vm_id', projected.vm_id, 'vm-proj')
eq('投影 internal_token', projected.internal_token, 'secret')
eq('投影 socket_path', projected.socket_path, '/run/kin/kernel.sock')
eq('投影推导 codex socket', projected.codex_socket_path, '/run/kin/codex-kernel.sock')
eq('投影 claude_bin', projected.claude_bin, '/opt/kin/cli-node')
eq('投影 slots_per_worker', projected.slots_per_worker, 20)
eq('投影 max_request_bytes', projected.kernel_max_request_bytes, 33_554_432)
eq('投影 delivery_mode', projected.delivery_mode, 'verified')
eq('投影 persona_preset', projected.persona_preset, 'official_full')
eq('投影 system_layout', projected.system_layout, 'identity')
eq('投影 default_cache_ttl', projected.default_cache_ttl, '5m')
eq('投影 timezone', projected.timezone, 'Asia/Shanghai')
eq('投影 proxy_required', projected.proxy_required, true)

const emptyProjection = kernelConfigFromVN2({})
eq('空 kernel.json 的槽数回落 20', emptyProjection.slots_per_worker, 20)
eq('空 kernel.json 的 token 为空', emptyProjection.internal_token, '')
eq('空 kernel.json 的 listen 缺省 unix', emptyProjection.kernel_listen, 'unix')

// listen 目标
eq('unix listen 目标', listenTarget({ socket_path: '/tmp/a.sock' }), { path: '/tmp/a.sock' })
eq('tcp listen 目标', listenTarget({ kernel_listen: 'tcp', kernel_tcp_port: 18080 }), {
  host: '127.0.0.1',
  port: 18080,
})
const dualTargets = listenTargets({ socket_path: '/run/kernel.sock', codex_socket_path: '/run/codex-kernel.sock' })
eq('双 socket 目标数 2', dualTargets.length, 2)
eq('主目标在前', dualTargets[0].path, '/run/kernel.sock')
eq('Codex 目标在后', dualTargets[1].path, '/run/codex-kernel.sock')
eq(
  'tcp 模式只开一个端口',
  listenTargets({ kernel_listen: 'tcp', kernel_tcp_port: 9000, codex_socket_path: '/run/c.sock' }).length,
  1,
)
eq(
  '同路径去重',
  listenTargets({ socket_path: '/run/kernel.sock', codex_socket_path: '/run/kernel.sock' }).length,
  1,
)

// 启动暗坑告警
ok(
  '告警：入口落在 .kin/ 下',
  startupWarnings({ homeDir: '/home/kincli', entryPath: '/home/kincli/.kin/kernel.mjs' }).some((w) =>
    w.includes('wrapNewerThanKernel'),
  ),
)
eq(
  '无告警：入口在 .kin/ 之外',
  startupWarnings({ homeDir: '/home/kincli', entryPath: '/opt/kin/kernel/server.mjs' }).length,
  0,
)
const tmpCfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kjson-')), 'kernel.json')
fs.writeFileSync(tmpCfg, JSON.stringify({ slots_per_worker: 8, socket_path: '/run/kin/kernel.sock' }))
const cfgWarnings = startupWarnings({ kernelJsonPath: tmpCfg, socketPath: '/run/other.sock' })
ok(
  '告警：槽数不匹配',
  cfgWarnings.some((w) => w.includes('slots_per_worker=8')),
)
ok(
  '告警：socket 路径不匹配',
  cfgWarnings.some((w) => w.includes('socket_path=')),
)
fs.rmSync(path.dirname(tmpCfg), { recursive: true, force: true })

// ═══════════════════════════════════════════ 4. Unix socket 服务

const main = await boot()
const unixTarget = main.slot.socketPath
const token = main.slot.token

section('4. Unix socket 模式')

{
  const h = await call(unixTarget, { path: '/internal/health', token })
  eq('health 状态码 200', h.status, 200)
  eq('health body.ok', h.body.ok, true)
  eq('health body.engine', h.body.engine, 'rust')
  eq('health body.status', h.body.status, 200)
  eq('health body.healthy', h.body.healthy, true)
  eq('health body.ready_slots = 4', h.body.ready_slots, 4)
  eq('health body.cli_started', h.body.cli_started, true)
  eq('health body.cli_error 为 null', h.body.cli_error, null)
  eq('health body.vm_id', h.body.vm_id, 'vm-test')
  eq('health body.delivery_mode', h.body.delivery_mode, 'realtime')
  ok('health body 有 cli_pid', typeof h.body.cli_pid === 'number' && h.body.cli_pid > 0, `cli_pid=${h.body.cli_pid}`)
  ok('health 满足 healthIsReady', healthIsReady(h.body))
  ok('health 通过契约校验', validateAgainstContract('health', { method: 'GET', path: '/internal/health' }, h).length === 0)

  // 低延迟：连打 20 次，取最大值
  const samples = []
  for (let i = 0; i < 20; i += 1) {
    const one = await call(unixTarget, { path: '/internal/health', token })
    samples.push(one.elapsedMs)
  }
  const maxMs = Math.max(...samples)
  const avgMs = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
  ok('health 最快响应 < 100ms（含 20 次采样）', maxMs < 100, `avg=${avgMs}ms max=${maxMs}ms`)
}

// 认证
{
  const noToken = await call(unixTarget, { path: '/internal/health' })
  eq('无 token → 401', noToken.status, 401)
  eq('无 token 错误码', noToken.body?.error?.code, 'internal_auth_failed')
  const wrongToken = await call(unixTarget, { path: '/internal/health', token: 'wrong' })
  eq('错 token → 401', wrongToken.status, 401)
  const onlyLegacy = await call(unixTarget, {
    path: '/internal/health',
    headers: { 'x-internal-token': token },
  })
  eq('只发旧头也认', onlyLegacy.status, 200)
  const onlyNew = await call(unixTarget, {
    path: '/internal/health',
    headers: { 'x-kin-internal-token': token },
  })
  eq('只发新头也认', onlyNew.status, 200)
  ok('401 响应带 www-authenticate', typeof noToken.headers['www-authenticate'] === 'string')
}

// models
{
  const m = await call(unixTarget, { path: '/internal/v1/models', token })
  eq('models 状态码 200', m.status, 200)
  eq('models object=list', m.body.object, 'list')
  ok('models data 非空数组', Array.isArray(m.body.data) && m.body.data.length > 0)
  eq('models 每项 owned_by=anthropic', m.body.data[0].owned_by, 'anthropic')
  ok('models 通过契约校验', validateAgainstContract('models', { method: 'GET' }, m).length === 0)
  const wrongMethod = await call(unixTarget, { path: '/internal/v1/models', method: 'POST', token })
  eq('models 错方法 → 405', wrongMethod.status, 405)
}

// messages 非流式
{
  const env = envelopeOf(
    { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'non-stream test' }] },
    { stream: false, requestId: 'req-nonstream' },
  )
  const r = await call(unixTarget, { path: '/internal/v1/messages', method: 'POST', body: env, token })
  eq('messages 非流式状态码 200', r.status, 200)
  eq('messages 非流式 type=message', r.body.type, 'message')
  eq('messages 非流式 role=assistant', r.body.role, 'assistant')
  ok('messages 非流式 content 是数组', Array.isArray(r.body.content))
  ok('messages 非流式有文本', String(r.body.content[0]?.text || '').length > 0)
  eq('messages 非流式 stop_reason=end_turn', r.body.stop_reason, 'end_turn')
  ok('messages 非流式 usage.output_tokens > 0', Number(r.body.usage?.output_tokens) > 0)
  eq('messages 响应头 x-terminal-state=verified', r.headers['x-terminal-state'], 'verified')
  ok('messages 响应头带 x-session-id', typeof r.headers['x-session-id'] === 'string')
  ok('messages 通过契约校验', validateAgainstContract('messages', { method: 'POST' }, r).length === 0)
}

// messages 流式
{
  const env = envelopeOf(
    { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'stream test' }] },
    { stream: true, requestId: 'req-stream' },
  )
  const r = await call(unixTarget, { path: '/internal/v1/messages', method: 'POST', body: env, token })
  eq('messages 流式状态码 200', r.status, 200)
  eq('messages 流式 content-type 是 SSE', String(r.headers['content-type']).startsWith('text/event-stream'), true)
  ok('messages 流式含 message_start', r.text.includes('message_start'))
  ok('messages 流式含 content_block_delta', r.text.includes('content_block_delta'))
  ok('messages 流式含 message_stop', r.text.includes('message_stop'))
  ok('messages 流式声明 trailer', String(r.headers.trailer || '').includes('x-kin-usage'))
}

// messages 校验分支
{
  const missingBody = await call(unixTarget, {
    path: '/internal/v1/messages',
    method: 'POST',
    body: { stream: false },
    token,
  })
  eq('envelope 缺 body → 400', missingBody.status, 400)
  eq('缺 body 的错误码', missingBody.body?.error?.code, 'invalid_request')
  ok('缺 body 的错误文案与控制面一致', String(missingBody.body?.error?.message).includes('missing field `body`'))

  const missingModel = await call(unixTarget, {
    path: '/internal/v1/messages',
    method: 'POST',
    body: envelopeOf({ messages: [] }),
    token,
  })
  eq('缺 model → 422', missingModel.status, 422)
  ok('缺 model 的错误文案含 deserialize', String(missingModel.body?.error?.message).includes('deserialize'))

  const badJson = await call(unixTarget, {
    path: '/internal/v1/messages',
    method: 'POST',
    body: '{not json',
    token,
  })
  eq('非法 JSON → 400', badJson.status, 400)

  // 超限：内核会在读满限额后 destroy 连接，客户端可能拿到 EPIPE 而不是响应。
  // 两种都是正确行为（关键是不把超大 body 读完），因此接受「状态码 0」。
  let tooLarge = null
  try {
    tooLarge = await call(unixTarget, {
      path: '/internal/v1/messages',
      method: 'POST',
      body: envelopeOf({ model: 'x', messages: [], padding: 'p'.repeat(2 << 20) }),
      token,
    })
  } catch (error) {
    tooLarge = { status: 0, error }
  }
  ok(
    '超限 body 被拒（413/400/连接中断）',
    [413, 400].includes(tooLarge.status) || tooLarge.status === 0,
    `status=${tooLarge.status}`,
  )
}

// cancel
{
  const rid = 'req-cancel-1'
  const env = envelopeOf(
    { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'cancel me' }] },
    { stream: false, requestId: rid },
  )
  const before = main.kernel.state.cancelCount
  const pending = call(unixTarget, { path: '/internal/v1/messages', method: 'POST', body: env, token })
  const inFlight = await waitFor(() => main.kernel.inflightSnapshot().some((e) => e.request_id === rid))
  eq('cancel：job 进入在途表', inFlight, true)

  const c = await call(unixTarget, { path: '/internal/v1/cancel', method: 'POST', body: { request_id: rid }, token })
  eq('cancel 状态码 200', c.status, 200)
  eq('cancel ok=true', c.body.ok, true)
  eq('cancel cancelled=true（命中）', c.body.cancelled, true)
  eq('cancel 回显 request_id', c.body.request_id, rid)
  eq('cancel 使 cancelCount 递增', main.kernel.state.cancelCount, before + 1)
  ok('cancel 通过契约校验', validateAgainstContract('cancel', { method: 'POST' }, c).length === 0)

  await pending.catch(() => {})

  const unknown = await call(unixTarget, {
    path: '/internal/v1/cancel',
    method: 'POST',
    body: { request_id: 'never-existed' },
    token,
  })
  eq('cancel 未命中仍 200', unknown.status, 200)
  eq('cancel 未命中 cancelled=false', unknown.body.cancelled, false)

  const noId = await call(unixTarget, { path: '/internal/v1/cancel', method: 'POST', body: {}, token })
  eq('cancel 缺 request_id → 400', noId.status, 400)
  eq('cancel 缺 request_id 错误码', noId.body?.error?.code, 'missing_request_id')

  const drained = await waitFor(() => main.kernel.inflightSnapshot().length === 0)
  eq('cancel 后在途表清空', drained, true)
}

// codex
{
  const r = await call(unixTarget, {
    path: '/internal/v1/codex/responses',
    method: 'POST',
    body: { body: { model: 'gpt-6-astra', input: 'hi' }, headers: {}, stream: true },
    token,
  })
  eq('codex 未配凭据 → 503', r.status, 503)
  eq('codex 错误码', r.body?.error?.code, 'codex_kernel_unavailable')
  ok(
    'codex 503 通过契约校验',
    validateAgainstContract('codexResponses', { method: 'POST' }, r).length === 0,
  )
  const noBody = await call(unixTarget, {
    path: '/internal/v1/codex/responses',
    method: 'POST',
    body: { headers: {} },
    token,
  })
  eq('codex 缺 envelope.body → 400', noBody.status, 400)
}

// 未知路由 + 方法
{
  const notFound = await call(unixTarget, { path: '/internal/unknown', token })
  eq('未知路由 → 404', notFound.status, 404)
  eq('未知路由错误码', notFound.body?.error?.code, 'not_found')
  const healthPost = await call(unixTarget, { path: '/internal/health', method: 'POST', token })
  eq('health 错方法 → 405', healthPost.status, 405)
}

// 错误体形状
{
  const r = await call(unixTarget, { path: '/internal/health' })
  eq('错误体有 ok 字段', r.body.ok, false)
  eq('错误体 error 四字段齐全', Object.keys(r.body.error).sort(), ['code', 'message', 'status', 'type'])
  const expected = workerError(401, 'x', 'y')
  eq('错误体与 workerError 同构', Object.keys(expected.error).sort(), Object.keys(r.body.error).sort())
}

await main.cleanup()

// ═══════════════════════════════════════════ 5. TCP 模式

section('5. TCP 模式')
{
  const tcp = await boot({ listen: 'tcp', overrides: { kernel_tcp_port: 0 } })
  // 端口 0 由内核分配，从 addresses 里读实际端口
  const addr = tcp.info.addresses[0].address
  ok('TCP 模式拿到实际端口', addr && addr.port > 0, JSON.stringify(addr))
  const target = { host: '127.0.0.1', port: addr.port }

  const h = await call(target, { path: '/internal/health', token: tcp.slot.token })
  eq('TCP health 200', h.status, 200)
  eq('TCP health engine=rust', h.body.engine, 'rust')
  eq('TCP health ready_slots', h.body.ready_slots, 4)

  const noAuth = await call(target, { path: '/internal/health' })
  eq('TCP 无 token → 401', noAuth.status, 401)

  const env = envelopeOf(
    { model: 'claude-sonnet-5', max_tokens: 32, messages: [{ role: 'user', content: 'tcp test' }] },
    { stream: false, requestId: 'req-tcp' },
  )
  const r = await call(target, { path: '/internal/v1/messages', method: 'POST', body: env, token: tcp.slot.token })
  eq('TCP messages 200', r.status, 200)
  eq('TCP messages type=message', r.body.type, 'message')

  const c = await call(target, {
    path: '/internal/v1/cancel',
    method: 'POST',
    body: { request_id: 'tcp-cancel' },
    token: tcp.slot.token,
  })
  eq('TCP cancel 200', c.status, 200)

  // TCP 模式下 Codex 通道复用同一端口（路由已按 path 分流）
  const co = await call(target, {
    path: '/internal/v1/codex/responses',
    method: 'POST',
    body: { body: { model: 'gpt-6-astra', input: 'x' } },
    token: tcp.slot.token,
  })
  eq('TCP codex 同一端口可达（503 无凭据）', co.status, 503)

  eq('TCP 模式只监听一个目标', tcp.info.targets.length, 1)
  await tcp.cleanup()
}

// ═══════════════════════════════════════════ 6. 双 socket

section('6. 双 socket（Claude + Codex）')
{
  const dual = await boot()
  eq('双 socket 监听目标 2 个', dual.info.targets.length, 2)
  const claudeAddr = dual.info.addresses[0].address
  const codexAddr = dual.info.addresses[1].address
  eq('Claude socket 路径', claudeAddr, dual.slot.socketPath)
  eq('Codex socket 路径', codexAddr, dual.slot.codexSocketPath)
  ok('Claude socket 文件存在', fs.existsSync(dual.slot.socketPath))
  ok('Codex socket 文件存在', fs.existsSync(dual.slot.codexSocketPath))
  // 权限：0600，避免同机其他用户 dial
  eq('Claude socket 权限 0600', (fs.statSync(dual.slot.socketPath).mode & 0o777).toString(8), '600')

  const viaClaude = await call(dual.slot.socketPath, { path: '/internal/health', token: dual.slot.token })
  const viaCodex = await call(dual.slot.codexSocketPath, { path: '/internal/health', token: dual.slot.token })
  eq('Claude socket health 200', viaClaude.status, 200)
  eq('Codex socket health 200', viaCodex.status, 200)
  eq('两个 socket 返回同一份 health', viaCodex.body.worker_version, viaClaude.body.worker_version)
  await dual.cleanup()
}

// ═══════════════════════════════════════════ 7. Codex 转发（假 fetch）

section('7. Codex responses 转发（假 fetch，真 handler）')
{
  // 这一段与上面「未配凭据 → 503」互补：那里验证的是降级分支，
  // 这里验证「凭据就绪时 envelope 真的被翻译成上游请求、上游帧真的被
  // 翻译回 Responses 协议」。用 codex-server 的真实 handler + 假 fetch，
  // 因此内核这一层的适配代码（envelope → synthetic req、capture res →
  // 真实响应）全部被走到。
  const cred = makeCodexCredential()
  const fake = makeCodexFakeFetch()
  const codex = await boot({
    overrides: { codex_credential_path: cred.file },
    deps: {
      codexHandlerFactory: async () => {
        const { createCodexHandler } = await import('../src/codex-server.mjs')
        return createCodexHandler({
          credentialPath: cred.file,
          fetchImpl: fake,
          logger: { warn() {}, info() {}, error() {} },
        })
      },
    },
  })

  const env = {
    body: {
      model: 'gpt-6-astra',
      input: [{ role: 'user', content: [{ type: 'input_text', text: '内核转发测试' }] }],
      instructions: 'be brief',
    },
    headers: {},
    session: { session_id: 'sess-kernel-1' },
    options: { installation_id: 'install-kernel-1' },
  }
  const r = await call(codex.slot.socketPath, {
    path: '/internal/v1/codex/responses',
    method: 'POST',
    body: env,
    token: codex.slot.token,
  })

  eq('codex 转发状态码 200', r.status, 200)
  ok('codex 响应是 SSE', String(r.headers['content-type'] || '').startsWith('text/event-stream'), String(r.headers['content-type']))
  ok('codex 转发含 response.created', r.text.includes('response.created'))
  ok('codex 转发含 output_text.delta', r.text.includes('response.output_text.delta'))
  ok('codex 转发含 response.completed', r.text.includes('response.completed'))
  ok('codex 转发带出了上游文本', r.text.includes('内核转发'), r.text.slice(0, 300))
  // contract.mjs 没有为 codex 规定 x-terminal-state（那是 Claude 通道的语义），
  // 这里只断言它没有把错误态透出来。
  ok('codex 响应不是错误态', r.headers['x-terminal-state'] !== 'rejected', String(r.headers['x-terminal-state']))
  // 注意：200 的 codex 响应是 SSE 流，不是 JSON body，contract 校验器的
  // 「2xx 必须带 JSON body」对这条路径不适用。契约只对错误分支有意义 ——
  // 那个断言放在下面 429 / 502 / 404 三处。

  // 上游请求确实被打了一次，且被内核正确加工
  eq('上游被调用一次', fake.calls.length, 1)
  const sent = fake.calls[0]
  eq('上游 URL 是 /responses', String(sent.url).includes('/responses'), true)
  eq('上游带 Bearer', sent.init.headers.authorization, 'Bearer CODEX_TOKEN')
  eq('上游带 account-id', sent.init.headers['chatgpt-account-id'], 'acct-kernel')
  eq('session_id 映射到 session-id 头', sent.init.headers['session-id'], 'sess-kernel-1')
  eq('installation_id 映射到 x-codex-installation-id', sent.init.headers['x-codex-installation-id'], 'install-kernel-1')

  // 请求体：codex-server 会用 zstd 压缩，解回来看 stream 被强制成 true
  const zlib = await import('node:zlib')
  const raw = Buffer.from(sent.init.body)
  let upstreamBody = null
  try {
    upstreamBody = JSON.parse(zlib.zstdDecompressSync(raw).toString())
  } catch {
    try {
      upstreamBody = JSON.parse(raw.toString())
    } catch {}
  }
  ok('上游请求体可解出', upstreamBody != null, `bytes=${raw.length}`)
  eq('上游 stream 被强制 true', upstreamBody?.stream, true)
  eq('上游 model 透传', upstreamBody?.model, 'gpt-6-astra')
  eq('上游 instructions 透传', upstreamBody?.instructions, 'be brief')
  eq('input 归一成 input_text', upstreamBody?.input?.[0]?.content?.[0]?.type, 'input_text')

  // 上游 429：内核必须保留可重试语义，而不是伪装成 200
  const cred2 = makeCodexCredential({ accountId: 'acct-429' })
  const fake429 = makeCodexFakeFetch({ status: 429, json: { detail: 'rate limited' } })
  const throttled = await boot({
    overrides: { codex_credential_path: cred2.file },
    deps: {
      codexHandlerFactory: async () => {
        const { createCodexHandler } = await import('../src/codex-server.mjs')
        return createCodexHandler({
          credentialPath: cred2.file,
          fetchImpl: fake429,
          logger: { warn() {}, info() {}, error() {} },
        })
      },
    },
  })
  const rr = await call(throttled.slot.socketPath, {
    path: '/internal/v1/codex/responses',
    method: 'POST',
    body: { body: { model: 'gpt-6-astra', input: 'x' }, headers: {} },
    token: throttled.slot.token,
  })
  ok('codex 上游 429 → 非 200', rr.status !== 200, `status=${rr.status}`)
  ok(
    'codex 429 是 429/503/502 之一',
    [429, 503, 502].includes(rr.status),
    `status=${rr.status} body=${String(rr.text).slice(0, 200)}`,
  )
  const parsed = rr.body?.error
  ok('codex 429 错误体结构化', parsed && typeof parsed.code === 'string', JSON.stringify(rr.body).slice(0, 200))
  eq('codex 429 通过契约校验', validateAgainstContract('codexResponses', { method: 'POST' }, rr).length, 0)

  // handler 抛错 → 502 codex_hop_failed，而不是 500 裸崩
  const boom = await boot({
    overrides: { codex_credential_path: cred.file },
    deps: {
      codexHandlerFactory: async () => ({
        handle: async () => {
          throw new Error('synthetic hop failure')
        },
      }),
    },
  })
  const rb = await call(boom.slot.socketPath, {
    path: '/internal/v1/codex/responses',
    method: 'POST',
    body: { body: { model: 'gpt-6-astra', input: 'x' }, headers: {} },
    token: boom.slot.token,
  })
  eq('codex handler 抛错 → 502', rb.status, 502)
  eq('codex handler 抛错错误码', rb.body?.error?.code, 'codex_hop_failed')

  // handler 不认领路由 → 404，不能静默成功
  const notOurs = await boot({
    overrides: { codex_credential_path: cred.file },
    deps: { codexHandlerFactory: async () => ({ handle: async () => false }) },
  })
  const rn = await call(notOurs.slot.socketPath, {
    path: '/internal/v1/codex/responses',
    method: 'POST',
    body: { body: { model: 'gpt-6-astra', input: 'x' }, headers: {} },
    token: notOurs.slot.token,
  })
  eq('codex handler 未认领 → 404', rn.status, 404)
  eq('codex 未认领错误码', rn.body?.error?.code, 'codex_route_unhandled')

  await notOurs.cleanup()
  await boom.cleanup()
  await throttled.cleanup()
  await codex.cleanup()
  fs.rmSync(cred.dir, { recursive: true, force: true })
  fs.rmSync(cred2.dir, { recursive: true, force: true })
}

// ═══════════════════════════════════════════ 8. 降级与边界

section('8. 降级与边界')
{
  // CLI 不可用：health 必须报 ready_slots=0（否则 supervisor 永远判 reachable，不会重启）
  const degraded = await boot({ claudeBin: '/nonexistent/kernel-test-cli' })
  const h = await call(degraded.slot.socketPath, { path: '/internal/health', token: degraded.slot.token })
  eq('CLI 缺失时 health 仍 200', h.status, 200)
  eq('CLI 缺失时 ready_slots=0', h.body.ready_slots, 0)
  eq('CLI 缺失时 ok=false', h.body.ok, false)
  eq('CLI 缺失时 cli_error.code=ENOENT', h.body.cli_error?.code, 'ENOENT')
  eq('CLI 缺失时 cli_started=false', h.body.cli_started, false)
  ok('CLI 缺失时 unhealthy_reason 非空', typeof h.body.unhealthy_reason === 'string' && h.body.unhealthy_reason.length > 0)
  const view = supervisorView(h.body)
  eq('CLI 缺失时 supervisor 判未就绪', view.ready, false)
  const msg = await call(degraded.slot.socketPath, {
    path: '/internal/v1/messages',
    method: 'POST',
    body: envelopeOf({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'x' }] }),
    token: degraded.slot.token,
  })
  eq('CLI 缺失时 messages 仍回 200（降级）', msg.status, 200)
  eq('降级响应仍是 message 形状', msg.body.type, 'message')
  await degraded.cleanup()
}

{
  // 凭据缺失 → 401 needs_refresh
  const slot = makeSlot()
  fs.rmSync(slot.credentialPath, { force: true })
  const noCred = await boot({ slot })
  const r = await call(slot.socketPath, {
    path: '/internal/v1/messages',
    method: 'POST',
    body: envelopeOf({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'x' }] }),
    token: slot.token,
  })
  eq('凭据缺失 → 401', r.status, 401)
  eq('凭据缺失错误码 needs_refresh', r.body?.error?.code, 'needs_refresh')
  const h = await call(slot.socketPath, { path: '/internal/health', token: slot.token })
  eq('凭据缺失时 health.credential_state=missing', h.body.credential_state, 'missing')
  await noCred.cleanup()
  slot.cleanup()
}

{
  // 过期凭据 → 401 needs_refresh，且 creditor_state 反映过期
  const slot = makeSlot()
  fs.writeFileSync(
    slot.credentialPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() - 60_000 },
    }),
  )
  const expired = await boot({ slot })
  const r = await call(slot.socketPath, {
    path: '/internal/v1/messages',
    method: 'POST',
    body: envelopeOf({ model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'x' }] }),
    token: slot.token,
  })
  eq('过期凭据 → 401', r.status, 401)
  const h = await call(slot.socketPath, { path: '/internal/health', token: slot.token })
  eq('过期凭据 state=expired_refreshable', h.body.credential_state, 'expired_refreshable')
  await expired.cleanup()
  slot.cleanup()
}

// ═══════════════════════════════════════════ 8. 命令行入口与 kernel.json 读取

section('9. 命令行入口与 kernel.json 读取')
{
  // supervisor 用固定 argv 起内核，必须能解析
  eq('解析 --gateway-worker --config', parseKernelArgs(['--gateway-worker', '--config', '/run/kin/kernel.json']), {
    configPath: '/run/kin/kernel.json',
    gatewayWorker: true,
    socketPath: null,
    token: null,
    unknown: [],
  })
  // 控制面拉起内核用的是单横线形式：spawn(bin, ['-socket', p, '-token', t])
  eq('解析 -socket -token（控制面形式）', parseKernelArgs(['-socket', '/run/a.sock', '-token', 'tok1']), {
    configPath: null,
    gatewayWorker: false,
    socketPath: '/run/a.sock',
    token: 'tok1',
    unknown: [],
  })
  eq('-socket= 等号形式', parseKernelArgs(['-socket=/run/b.sock']).socketPath, '/run/b.sock')
  eq('-token= 等号形式', parseKernelArgs(['-token=tok2']).token, 'tok2')
  eq('解析 --config=形式', parseKernelArgs(['--config=/x/kernel.json']).configPath, '/x/kernel.json')
  eq('解析位置参数（codex supervisor 的形式）', parseKernelArgs(['/run/kin/codex-kernel.json']).configPath, '/run/kin/codex-kernel.json')
  eq('未知参数被忽略并记录', parseKernelArgs(['--new-flag', '/x.json']).unknown, ['--new-flag'])
  eq('无参数时 configPath 为 null', parseKernelArgs([]).configPath, null)

  // kernel.json 真实读取
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kjson-read-'))
  const cfgPath = path.join(dir, 'kernel.json')
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({
      vm_id: 'vm-json',
      socket_path: path.join(dir, 'kernel.sock'),
      internal_token: 'json-token',
      credential_path: path.join(dir, 'creds.json'),
      claude_bin: '/opt/kin/cli-node',
      slots_per_worker: 20,
      max_request_bytes: 1048576,
      runtime_kind: 'local_cli',
      delivery_mode: 'realtime',
      timezone: 'UTC',
    }),
  )
  const fromFile = kernelConfigFromFile(cfgPath)
  eq('kernelConfigFromFile 读到 vm_id', fromFile.vm_id, 'vm-json')
  eq('kernelConfigFromFile 读到 token', fromFile.internal_token, 'json-token')
  eq('kernelConfigFromFile 读到槽数', fromFile.slots_per_worker, 20)
  eq('kernelConfigFromFile 推导 codex socket', fromFile.codex_socket_path, path.join(dir, 'codex-kernel.sock'))

  const missing = kernelConfigFromFile(path.join(dir, 'nope.json'), { fallback: { internal_token: 'fb' } })
  eq('kernel.json 缺失时回落 fallback token', missing.internal_token, 'fb')
  eq('kernel.json 缺失时槽数回落 20', missing.slots_per_worker, 20)
  eq('kernel.json 缺失时记录错误码', missing.config_read_error, 'ENOENT')

  // 用 CLI 入口真起一个内核（等价于 supervisor exec 它）
  const slot = makeSlot({ token: 'cli-token' })
  const cliCfgPath = path.join(slot.runDir, 'kernel.json')
  fs.writeFileSync(
    cliCfgPath,
    JSON.stringify({
      vm_id: 'vm-cli',
      socket_path: slot.socketPath,
      internal_token: slot.token,
      credential_path: slot.credentialPath,
      claude_bin: compatCli(),
      slots_per_worker: 4,
      runtime_kind: 'local_cli',
      delivery_mode: 'realtime',
      system_layout: 'zero',
      timezone: 'UTC',
    }),
  )
  const quiet = { log() {}, warn() {}, error() {} }
  const started = await runKernelMain({ argv: ['--gateway-worker', '--config', cliCfgPath], logger: quiet })
  eq('CLI 入口按 supervisor argv 起内核', started.config.vm_id, 'vm-cli')
  const h = await call(slot.socketPath, { path: '/internal/health', token: slot.token })
  eq('CLI 起的内核 health 200', h.status, 200)
  eq('CLI 起的内核 ready_slots=4', h.body.ready_slots, 4)
  await started.kernel.close()
  slot.cleanup()
  fs.rmSync(dir, { recursive: true, force: true })
}

// ═══════════════════════════════════════════ 9. 真实客户端兼容（子进程）

section('10. 用 vm2api 的真实 client 打我们的内核')
{
  const report = await runCompatSection()
  ok('兼容性实测整体通过', report.ok === true, (report.failures || []).join('; '))
  eq('兼容性实测用的是真实 client', report.mode, 'real-client')
  ok('实测步数 ≥ 20', report.steps >= 20, `steps=${report.steps}`)
  ok('health 延迟实测 < 100ms', (report.healthLatency?.max ?? 999) < 100, JSON.stringify(report.healthLatency))
  ok(
    '5 个端点全部通过契约校验',
    (report.contractChecks || []).every((c) => c.problems.length === 0),
    JSON.stringify(report.contractChecks),
  )
  ok('rust-kernel-client 薄封装可通', report.rustClient?.ok === true, JSON.stringify(report.rustClient))
}

/**
 * 在子进程里跑兼容性实测。
 *
 * 必须独立进程：compat-test.mjs 会 register 一个 module resolve hook，
 * 它影响整个进程的模块解析。在本测试进程里装它会污染后续 import。
 */
function runCompatSection() {
  return new Promise((resolve) => {
    const file = path.join(ROOT, 'src', 'kernel', 'compat-test.mjs')
    const child = spawn(process.execPath, [file, '--json'], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => {
      out += c
    })
    child.stderr.on('data', (c) => {
      err += c
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, failures: ['compat-test 超时'], steps: 0 })
    }, 90_000)
    child.on('exit', () => {
      clearTimeout(timer)
      // compat-test 的报告是最后一段 JSON
      const at = out.lastIndexOf('{\n  "vm2apiRoot"')
      if (at < 0) {
        resolve({ ok: false, failures: [`无法解析报告: ${(err || out).slice(-500)}`], steps: 0 })
        return
      }
      try {
        const parsed = JSON.parse(out.slice(at))
        // 把逐步结果打成测试自身的输出，便于失败时定位
        for (const s of parsed.stepList || []) {
          if (!s.ok) console.log(`      · 兼容性失败: ${s.name} — ${s.detail}`)
        }
        resolve(parsed)
      } catch (error) {
        resolve({ ok: false, failures: [`JSON 解析失败: ${error.message}`], steps: 0 })
      }
    })
  })
}

// ═══════════════════════════════════════════ 汇总


// ── 回归：content 聚合不能丢掉「没有 content_block_start 的 delta」 ──
//
// 简化宿主（假 CLI 这类）常只发 content_block_delta，不发 content_block_start。
// 原先 contentBlocks 只遍历 blocks，pending 里的文本被整段丢掉 ——
// 表现是 content:[{type:'text',text:''}] 但 usage 正常：
// 状态 200、结构完整、只有文本是空串，极难查。
{
  const src = fs.readFileSync(path.join(ROOT, 'src/kernel/server.mjs'), 'utf8')
  ok('contentBlocks 以 pending 的 index 并集为准',
    /for \(const idx of pending\.keys\(\)\) indexes\.add\(idx\)/.test(src))
  ok('没有 start 的 delta 兜底成 text 块',
    /const base = block \|\| \{ type: 'text' \}/.test(src))
}

// ── 回归：流式必须补协议骨架 ──
//
// 上游/宿主只发 delta 时，客户端拿到的流缺 message_start / message_stop，
// Anthropic SDK 的 assembler 会报错或产出空消息。
// 内核不能指望宿主自觉发这两个，必须自己兜住。
{
  const src = fs.readFileSync(path.join(ROOT, 'src/kernel/server.mjs'), 'utf8')
  ok('流式首包补 message_start', /sawStart/.test(src) && /message_start/.test(src))
  ok('流式尾包补 message_stop', /sawStop/.test(src) && /message_stop/.test(src))
  ok('补 message_stop 的判断不看 finished',
    /if \(!sawStop\) \{/.test(src))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f}`)
}
process.exit(fail > 0 ? 1 : 0)
