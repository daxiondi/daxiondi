/**
 * 用 vm2api 的真实客户端代码测我们的内核。
 *
 * 这是「替换内核是否成功」的唯一判据：不是我们的测试断言说了算，
 * 是它自己的 client 能不能跑通说了算。
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么需要 import hook
 * ══════════════════════════════════════════════════════════════
 *
 * vm2api 的仓库里没有 node_modules（我们只读它的源码，没 npm install）。
 * 它的 transport 层一路 import 到 `ssh2` / `node-fetch` / `socks-proxy-agent` /
 * `https-proxy-agent` / `ws` / `croner`，直接 dynamic import 会
 * ERR_MODULE_NOT_FOUND。
 *
 * 这些依赖在**这条测试路径上完全不执行**：我们要的是 go-worker-client 的
 * `workerRequest`（node:http 的 socketPath 请求）与 rust/codex-kernel-client
 * 的两层薄封装，它们的 import 链上那几个包只是被别的模块顺带引入。
 * 装它们既慢又改变 vm2api 仓库状态（约束 4：只读不修改）。
 *
 * 因此这里用 Node 的 module.resolve hook 把它们指向 data: URL 桩：
 *   - 不改 vm2api 一个字节；
 *   - 真代码真跑（unix socket、header 拼接、envelope 构造、SSE 解析全是它的）；
 *   - 桩只在 import 期被求值一次，不参与任何断言路径。
 *
 * 桩方案的一个必须注意的前提：register() 必须在**目标模块被 import 之前**生效。
 * 本模块把 register 放在顶层，compatTest 里才 dynamic import，顺序是对的。
 */

import { register } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createKernelServer } from './server.mjs'
import { validateAgainstContract, KERNEL_ENDPOINTS, healthIsReady } from './contract.mjs'
import { supervisorView, readinessPayload, versionHandshake } from './supervisor-compat.mjs'

/** vm2api 仓库路径。可用环境变量覆盖，便于在别的 checkout 上跑。 */
export const VM2API_ROOT =
  process.env.VM2API_ROOT || path.resolve(process.cwd(), '../vm2api')

const VM2API_TRANSPORT = path.join(VM2API_ROOT, 'src/lib/transport')
const VM2API_CLIENT = path.join(VM2API_TRANSPORT, 'go-worker-client.mjs')
const VM2API_RUST_CLIENT = path.join(VM2API_TRANSPORT, 'rust-kernel-client.mjs')
const VM2API_CODEX_CLIENT = path.join(VM2API_TRANSPORT, 'codex-kernel-client.mjs')

/**
 * 第三方依赖桩。每个都是 data: URL，导出目标模块 import 期需要的最小符号。
 *
 * 桩的行为：任何"真去联网/真去 spawn"的调用都抛错 —— 这样万一某条断言
 * 意外走到了桩上，会明确失败而不是静默返回 undefined。
 */
const STUBS = {
  ssh2: `
    const fail = () => { throw new Error('ssh2 stub: not available in compat-test') }
    export class Client { constructor(){ fail() } }
    export class Server { constructor(){ fail() } }
    export const utils = {}
    export default { Client, Server, utils }
  `,
  'node-fetch': `
    const fail = async () => { throw new Error('node-fetch stub: not available in compat-test') }
    export default fail
    export const Headers = class {}
    export const Request = class {}
    export const Response = class {}
  `,
  'https-proxy-agent': `export class HttpsProxyAgent {}; export default HttpsProxyAgent`,
  'socks-proxy-agent': `export class SocksProxyAgent {}; export default SocksProxyAgent`,
  ws: `export class WebSocket {}; export default { WebSocket }`,
  croner: `export class Cron {}; export default Cron`,
}

const STUB_URLS = Object.fromEntries(
  Object.entries(STUBS).map(([name, source]) => [name, `data:text/javascript,${encodeURIComponent(source)}`]),
)

let hookInstalled = false

/**
 * 安装解析钩子。幂等，重复调用只生效一次。
 *
 * 只在 compat-test 内部使用；它影响的是整个进程的模块解析，
 * 因此测试文件应当在**单独进程**里跑（test/kernel.mjs 就是这么做的）。
 */
function installStubs() {
  if (hookInstalled) return
  hookInstalled = true
  const source = `
    const MAP = ${JSON.stringify(STUB_URLS)}
    export async function resolve(specifier, context, next) {
      if (MAP[specifier]) return { url: MAP[specifier], shortCircuit: true, format: 'module' }
      return next(specifier, context)
    }
  `
  register(`data:text/javascript,${encodeURIComponent(source)}`)
}

// 顶层安装：必须先于下方 compatTest 里的 dynamic import
installStubs()

/**
 * 判断 vm2api 源码是否可 import（存在性检查，不做安装）。
 * 缺失时 compatTest 会回落到「手工构造请求格式」的路径并明确标注。
 */
export function vm2apiAvailable() {
  return fs.existsSync(VM2API_CLIENT) && fs.existsSync(VM2API_RUST_CLIENT)
}

/**
 * 构造 vm2api 视角的 exec 上下文。
 *
 * exec 的形状来自 vm2api 自己的测试 fixture（test/unit/go-worker-client.test.mjs
 * 的 fixture 函数）：它把 socket 与 token 挂在 exec.vm.runtime 上，
 * homeDir 决定 runDir。
 *
 * 关键点：rustKernelPaths / codexKernelPaths 会从 exec.vm.runtime.kernel_socket
 * 与 codex_kernel_socket 取 socket 路径（取不到才回落到 runDir/kernel.sock）。
 * 我们直接给这两个字段，等于告诉客户端「内核就在这个 socket 上」——
 * 这正是 supervisor 在生产里会做的事。
 */
export function makeExec({ socketPath, tokenPath, homeDir, codexSocketPath = '' }) {
  return {
    vmId: 'vm-compat',
    homeDir,
    vm: {
      id: 'vm-compat',
      runtime: {
        worker_socket: socketPath,
        worker_token_file: tokenPath,
        worker_run_dir: path.dirname(socketPath),
        kernel_socket: socketPath,
        ...(codexSocketPath ? { codex_kernel_socket: codexSocketPath } : {}),
      },
      claude: {},
    },
  }
}

/**
 * 准备一个临时槽目录：socket + token + 凭据。
 *
 * 目录布局刻意与 vm2api 一致：
 *   <root>/vms/vm-compat/run/kernel.sock
 *   <root>/vms/vm-compat/run/internal.token
 *   <root>/vms/vm-compat/cli-home/.claude/credentials.json
 *
 * 因为我们内核的 credential_state 判定读的就是这个文件；形状不对会回
 * missing → 401 needs_refresh，测试就变成在验错误路径了。
 */
export function makeSlotDir({ token = 'compat-internal-token' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-compat-'))
  const vmDir = path.join(root, 'vms', 'vm-compat')
  const runDir = path.join(vmDir, 'run')
  const homeDir = path.join(vmDir, 'cli-home')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true, mode: 0o700 })
  const tokenPath = path.join(runDir, 'internal.token')
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
  const credentialPath = path.join(homeDir, '.claude', 'credentials.json')
  fs.writeFileSync(
    credentialPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'compat-access-token', refreshToken: 'compat-refresh', expiresAt: Date.now() + 3_600_000 },
    }),
    { mode: 0o600 },
  )
  return {
    root,
    runDir,
    homeDir,
    tokenPath,
    credentialPath,
    token,
    socketPath: path.join(runDir, 'kernel.sock'),
    codexSocketPath: path.join(runDir, 'codex-kernel.sock'),
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {}
    },
  }
}

/**
 * 一个「会推理」的假 CLI：按 frames.mjs 的协议回帧。
 *
 * 为什么不用 test/fixtures/fake-cli.mjs：那个 fixture 只发一条 delta 且不区分
 * stream/非流式。兼容性测试需要的事件序列更完整（message_start → delta →
 * stop → message_stop），才能验证 vm2api 的 SSE 解析器与
 * isCompleteAssistantMessage 判定真的通过。
 *
 * 用法：把 claude_bin 指向 src/kernel/compat-cli.mjs。
 */
export function compatCliPath() {
  const here = path.dirname(new URL(import.meta.url).pathname)
  return path.join(here, 'compat-cli.mjs')
}

/**
 * 把内核配置指向假 CLI，并保证它可执行。
 */
function prepareBin() {
  const bin = compatCliPath()
  try {
    fs.chmodSync(bin, 0o755)
  } catch {}
  return bin
}

/**
 * 起一个内核实例（unix socket）。
 */
export async function startKernel({ slot, overrides = {} } = {}) {
  const config = {
    vm_id: 'vm-compat',
    internal_token: slot.token,
    socket_path: slot.socketPath,
    credential_path: slot.credentialPath,
    claude_bin: prepareBin(),
    // 双 socket：vm2api 的 Claude/Codex 是两套 supervisor，各 dial 一个路径
    codex_socket_path: slot.codexSocketPath,
    // 假 CLI 每个 delta 之间延迟 40ms，正文 80 字符 → 20 片 ≈ 800ms，
    // 保证 abort 一定落在 job 还在跑的时候（否则取消测不到任何东西）。
    cli_env: { COMPAT_CLI_DELAY_MS: '40', COMPAT_CLI_TEXT: 'x'.repeat(80) },
    slots_per_worker: 4,
    kernel_max_request_bytes: 8 * 1024 * 1024,
    kernel_listen: 'unix',
    runtime_kind: 'local_cli',
    provider: 'local_cli',
    delivery_mode: 'realtime',
    system_layout: 'zero',
    default_cache_ttl: '1h',
    timezone: 'UTC',
    proxy_url: '',
    proxy_required: false,
    cli_version: '2.1.281',
    ...overrides,
  }
  const kernel = createKernelServer({ config, ...(overrides.__deps ? { deps: overrides.__deps } : {}) })
  await kernel.start()
  return { kernel, config }
}

/** 底层 HTTP 调用（unix socket 或 tcp），供手工构造路径使用。 */
export function rawCall(target, { path: pathname, method = 'GET', body = null, headers = {}, token = '' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    const reqHeaders = { ...headers }
    if (payload) {
      reqHeaders['content-type'] = 'application/json'
      reqHeaders['content-length'] = String(payload.length)
    }
    if (token) {
      reqHeaders['x-kin-internal-token'] = token
      reqHeaders['x-internal-token'] = token
    }
    const startedAt = Date.now()
    const options = typeof target === 'string' ? { socketPath: target } : { host: target.host, port: target.port }
    const req = http.request({ ...options, path: pathname, method, headers: reqHeaders }, (res) => {
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
    req.setTimeout(15_000, () => req.destroy(new Error('rawCall timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * 兼容性测试主流程。
 *
 * 每一步都记录实测结果，最后返回结构化报告 —— 不抛错。
 * 这样「实际跑通了什么、卡在哪」都能原样贴给用户，而不是一句 assert failed。
 *
 * @param {{verbose?:boolean}} [opts]
 */
export async function runCompatTest({ verbose = false } = {}) {
  const report = {
    vm2apiRoot: VM2API_ROOT,
    vm2apiAvailable: vm2apiAvailable(),
    mode: 'real-client',
    steps: [],
    failures: [],
    handshake: versionHandshake(),
  }

  const slot = makeSlotDir()
  let kernel = null
  let vm2api = null

  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail })
    if (!ok) report.failures.push(`${name}: ${detail}`)
    if (verbose) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
    return ok
  }

  try {
    const started = await startKernel({ slot })
    kernel = started.kernel
    const exec = makeExec({
      socketPath: slot.socketPath,
      tokenPath: slot.tokenPath,
      homeDir: slot.homeDir,
      codexSocketPath: slot.codexSocketPath,
    })

    // ── 1. 用它的 workerHealth 打我们的 /internal/health
    if (!report.vm2apiAvailable) {
      report.mode = 'manual'
      step('vm2api 源码可 import', false, `${VM2API_CLIENT} 不存在，回落手工构造`)
    }

    let client = null
    if (report.vm2apiAvailable) {
      try {
        client = await import(VM2API_CLIENT)
        step('import vm2api go-worker-client.mjs', true, `${Object.keys(client).length} 个导出`)
      } catch (error) {
        report.mode = 'manual'
        step('import vm2api go-worker-client.mjs', false, String(error?.message || error).split('\n')[0])
      }
    }

    if (client) {
      // ── health
      const health = await client.workerHealth(exec, { timeoutMs: 400 })
      const healthOk = step(
        'workerHealth 打 /internal/health',
        health?.ok === true && Number(health?.status) === 200,
        `ok=${health?.ok} status=${health?.status} ready_slots=${health?.ready_slots} engine=${health?.engine}`,
      )
      step(
        'health 字段满足 supervisor 就绪判定',
        healthIsReady(health) === true,
        `ready_slots=${health?.ready_slots} healthy=${health?.healthy}`,
      )
      const view = supervisorView(health)
      step('supervisorView 判 ready', view.ready === true, JSON.stringify(view.reasons))

      // ── messages（非流式）
      let result = null
      if (healthOk) {
        result = await client.callGoWorker({
          exec,
          body: { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'compat ping' }] },
        })
        step(
          'callGoWorker 非流式推理',
          result?.ok === true,
          `ok=${result?.ok} status=${result?.status} type=${result?.body?.type} via=${result?.via}`,
        )
        step(
          '非流式响应形状符合 Anthropic Message',
          result?.body?.type === 'message' && Array.isArray(result?.body?.content),
          `content blocks=${result?.body?.content?.length}`,
        )
        // callGoWorker 原样报 'go-worker'；callRustKernel 才把它 remap 成
        // 'rust-kernel'（见 rust-kernel-client.mjs 的 remapVia）。这里两步分别验。
        step('callGoWorker 的 via=go-worker', result?.via === 'go-worker', `via=${result?.via}`)
        step(
          'usage 被解析',
          Number(result?.body?.usage?.input_tokens) >= 0 && Number(result?.body?.usage?.output_tokens) > 0,
          JSON.stringify(result?.body?.usage || null),
        )
        const problems = validateAgainstContract(
          'messages',
          { method: 'POST', path: '/internal/v1/messages', body: { body: {}, request_id: 'x' } },
          { status: result?.status, body: result?.body },
        )
        step('响应通过契约校验', problems.length === 0, problems.join('; ') || 'clean')
      }

      // ── messages（流式）
      if (healthOk) {
        const lines = []
        let sawStop = false
        const streamed = await client.streamGoWorker({
          exec,
          body: { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'compat stream' }] },
          timeoutMs: 5000,
          idleTimeoutMs: 5000,
          onEvent: async (line) => {
            lines.push(line)
            if (line.includes('message_stop')) sawStop = true
          },
        })
        step('streamGoWorker 流式推理', streamed?.ok === true, `ok=${streamed?.ok} status=${streamed?.status}`)
        step('SSE 里出现 message_stop', sawStop, `${lines.length} 行`)
        step(
          '流式判定 verified',
          streamed?.terminalState === 'verified',
          `terminalState=${streamed?.terminalState} sawMessageStop=${streamed?.sawMessageStop}`,
        )
        step(
          '流式 usage 汇总非空',
          Number(streamed?.usage?.output_tokens) > 0,
          JSON.stringify(streamed?.usage || null),
        )
      }

      // ── cancel：用它的 cancelOnAbort 真实路径
      //    callGoWorker 在 signal abort 时会 POST /internal/v1/cancel。
      //    这里显式驱动一次，验证我们的 inflight 表能命中。
      const ctrl = new AbortController()
      const cancelBefore = kernel.state.cancelCount
      const pending = client.callGoWorker({
        exec,
        body: { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'compat cancel' }] },
        signal: ctrl.signal,
      })
      // 等 job 真的进到内核（inflight 表出现对端 request_id 之外的一条）
      const sawInflight = await waitFor(() => kernel.inflightSnapshot().length > 0, 1500)
      step('job 进入在途表', sawInflight, `inflight=${kernel.inflightSnapshot().length}`)
      ctrl.abort()
      const aborted = await pending
      // cancelOnAbort 是 abort 事件里**另发**的一个 HTTP 请求，与主请求的
      // 失败返回没有先后保证，必须等它自己到达内核。
      const sawCancel = await waitFor(() => kernel.state.cancelCount > cancelBefore, 2000)
      const cancelAfter = kernel.state.cancelCount
      step(
        'cancelOnAbort 路径不崩',
        aborted != null,
        `ok=${aborted?.ok} status=${aborted?.status} terminalState=${aborted?.terminalState}`,
      )
      // 这是 cancel 端点是否真的实现了的唯一判据：cancelCount 必须涨
      step(
        'cancel 端点命中在途 job（cancelCount 递增）',
        sawCancel && cancelAfter > cancelBefore,
        `before=${cancelBefore} after=${cancelAfter}`,
      )
      const drained = await waitFor(() => kernel.inflightSnapshot().length === 0, 2000)
      step('abort 后在途表被清理', drained, `inflight=${kernel.inflightSnapshot().length}`)

      // ── rust-kernel-client 的薄封装
      try {
        const rustClient = await import(VM2API_RUST_CLIENT)
        const rustHealth = await rustClient.rustKernelHealth(exec, { timeoutMs: 400 })
        step(
          'rustKernelHealth 打同一 socket',
          rustHealth?.ok === true,
          `ok=${rustHealth?.ok} ready_slots=${rustHealth?.ready_slots}`,
        )
        const reachable = rustClient.rustKernelReachable(rustHealth)
        step('rustKernelReachable 为 true', reachable === true, `reachable=${reachable}`)
        const publicHealth = rustClient.toPublicKernelHealth(rustHealth, 'rust')
        step(
          'toPublicKernelHealth 面板字段齐全',
          publicHealth?.reachable === true && publicHealth?.error_code === null,
          `reachable=${publicHealth?.reachable} error_code=${publicHealth?.error_code} provider=${publicHealth?.provider}`,
        )
        const rustResult = await rustClient.callRustKernel({
          exec,
          body: { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'via rust client' }] },
        })
        step(
          'callRustKernel 推理',
          rustResult?.ok === true,
          `ok=${rustResult?.ok} via=${rustResult?.via} type=${rustResult?.body?.type}`,
        )
        report.rustClient = { ok: rustResult?.ok === true, via: rustResult?.via, publicHealth }
      } catch (error) {
        step('rust-kernel-client 薄封装', false, String(error?.message || error).split('\n')[0])
      }

      // ── codex-kernel-client：它 import 同一个 go-worker-client，
      //    只换 socket 与 requestPath。我们没配 Codex 凭据，因此这里
      //    验证的是「路径与头正确、内核回结构化 503 而不是崩」。
      try {
        const codexClient = await import(VM2API_CODEX_CLIENT)
        const codexHealth = await codexClient.codexKernelHealth(exec, { timeoutMs: 400 })
        step(
          'codexKernelHealth 可达（同 token 不同 socket 路径也认）',
          codexHealth?.ok === true || Number(codexHealth?.status) === 200,
          `ok=${codexHealth?.ok} status=${codexHealth?.status}`,
        )
        const codexResult = await codexClient.callCodexKernel({
          exec,
          body: { model: 'gpt-6-astra', input: 'compat codex' },
        })
        step(
          'callCodexKernel 回结构化结果（未配凭据时应为 503）',
          codexResult != null && (codexResult.ok === true || codexResult.status === 503),
          `ok=${codexResult?.ok} status=${codexResult?.status} code=${codexResult?.body?.error?.code}`,
        )
        report.codexClient = { status: codexResult?.status, ok: codexResult?.ok }
      } catch (error) {
        step('codex-kernel-client 薄封装', false, String(error?.message || error).split('\n')[0])
      }
    } else {
      // ── 手工构造后备：client 不可 import 时，用它的**请求格式**直连
      const health = await rawCall(slot.socketPath, {
        path: '/internal/health',
        token: slot.token,
        headers: { 'x-kin-internal-token': slot.token, 'x-internal-token': slot.token },
      })
      step(
        '手工 health（按 client 的头与路径）',
        health.status === 200 && health.body?.ok === true,
        `status=${health.status} ok=${health.body?.ok}`,
      )
      const envelope = {
        body: { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'manual ping' }] },
        headers: { 'anthropic-version': '2023-06-01' },
        stream: false,
        delivery_mode: 'realtime',
        preserve_cache_breakpoints: true,
        cache_ttl: null,
        request_id: randomUUID(),
      }
      const messages = await rawCall(slot.socketPath, {
        path: '/internal/v1/messages',
        method: 'POST',
        body: envelope,
        token: slot.token,
      })
      step(
        '手工 messages（按 envelope 字段）',
        messages.status === 200 && messages.body?.type === 'message',
        `status=${messages.status} type=${messages.body?.type}`,
      )
    }

    // ── health 延迟实测：supervisor 的预算是 400ms
    const samples = []
    for (let i = 0; i < 10; i += 1) {
      const one = await rawCall(slot.socketPath, { path: '/internal/health', token: slot.token })
      samples.push(one.elapsedMs)
    }
    const max = Math.max(...samples)
    const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
    step('health 延迟远低于 supervisor 400ms 预算', max < 100, `avg=${avg}ms max=${max}ms`)
    report.healthLatency = { samples, avg, max }

    // ── 契约逐端点核对：用我们自己的校验器过一遍真实响应
    const contractChecks = []
    for (const endpoint of Object.keys(KERNEL_ENDPOINTS)) {
      const one = await probeEndpoint(slot, endpoint)
      const problems = validateAgainstContract(endpoint, one.req, one.res)
      contractChecks.push({ endpoint, status: one.res.status, problems })
    }
    report.contractChecks = contractChecks
    step(
      '5 个端点响应均通过契约校验',
      contractChecks.every((c) => c.problems.length === 0),
      contractChecks
        .filter((c) => c.problems.length)
        .map((c) => `${c.endpoint}: ${c.problems.join('; ')}`)
        .join(' | ') || 'clean',
    )
  } finally {
    try {
      await kernel?.close()
    } catch {}
    slot.cleanup()
  }

  report.ok = report.failures.length === 0
  return report
}

/** 轮询等待条件成立，返回是否在预算内成立。 */
async function waitFor(predicate, timeoutMs = 1000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return predicate()
}

/**
 * 逐个探端点，产出 (req, res) 供契约校验。
 *
 * 刻意走真实 HTTP 而不是直接调内部函数：契约是关于线上的字节的，
 * 绕过 HTTP 层就测不到「头是否正确、状态码是否正确」。
 */
async function probeEndpoint(slot, endpoint) {
  const spec = KERNEL_ENDPOINTS[endpoint]
  const token = slot.token
  const base = { path: spec.path, method: spec.method, token }

  switch (endpoint) {
    case 'health':
    case 'models': {
      const res = await rawCall(slot.socketPath, base)
      return { req: { method: spec.method, path: spec.path }, res }
    }
    case 'cancel': {
      const body = { request_id: 'contract-probe' }
      const res = await rawCall(slot.socketPath, { ...base, body })
      return { req: { method: spec.method, path: spec.path, body }, res }
    }
    case 'messages': {
      const body = {
        body: { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'contract probe' }] },
        headers: {},
        stream: false,
        delivery_mode: 'realtime',
        preserve_cache_breakpoints: true,
        cache_ttl: null,
        request_id: 'contract-probe-messages',
      }
      const res = await rawCall(slot.socketPath, { ...base, body })
      return { req: { method: spec.method, path: spec.path, body }, res }
    }
    case 'codexResponses': {
      const body = { body: { model: 'gpt-6-astra', input: 'contract probe' }, headers: {}, stream: true }
      const res = await rawCall(slot.socketPath, { ...base, body })
      // 未配 Codex 凭据时是 503；契约表允许 503，校验器只看状态码是否在表内
      return { req: { method: spec.method, path: spec.path, body }, res }
    }
    default:
      return { req: {}, res: { status: 0 } }
  }
}

/**
 * CLI 入口：`node src/kernel/compat-test.mjs`
 *
 * 打印结构化报告。退出码 0 表示全部通过。
 */
async function main() {
  const jsonMode = process.argv.includes('--json')
  if (!jsonMode) {
    console.log('vm2api 客户端 → 我们的内核（兼容性实测）\n')
    console.log(`  vm2api: ${VM2API_ROOT}`)
  }
  const report = await runCompatTest({ verbose: !jsonMode })
  // steps 是数组，报告里另给 stepsCount 与 stepList 两种投影：
  //   - stepsCount 供测试断言
  //   - stepList 供测试在失败时打印明细
  const payload = {
    ...report,
    steps: report.steps.length,
    stepsCount: report.steps.length,
    stepList: report.steps,
  }
  if (!jsonMode) console.log('\n── 报告 ──')
  // JSON 模式下一律输出（stdout 最后一段 JSON 即报告），verbose 模式也输出便于人读
  console.log(JSON.stringify(payload, null, 2))
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
