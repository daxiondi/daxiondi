/**
 * 对齐 vm2api supervisor 的启动预期。
 *
 * 这个模块存在的唯一理由：把 supervisor 的隐含假设**显式化**，让内核服务
 * 满足这些假设，而不是靠试错。所有常量与判定都从 vm2api 代码里抄出来，
 * 每一条都标注了出处文件与函数。
 *
 * ══════════════════════════════════════════════════════════════
 * supervisor 怎么判断内核「起来了」
 * ══════════════════════════════════════════════════════════════
 *
 * 没有握手，没有版本协商。整个过程是纯轮询：
 *
 *   startRustKernel (rust-kernel-supervisor.mjs:546)
 *     ├─ 已有 health 且 reachable → return {reason:'already_up'}
 *     ├─ docker exec kin-kernel --gateway-worker --config /run/kin/kernel.json
 *     └─ waitForHealthOrExit
 *          while (Date.now() < deadline)          // 预算 30s（缺省），KVM 120s/TCG 480s
 *            rustKernelHealth(exec, {timeoutMs:400})
 *            if (rustKernelReachable(last)) return {reason:'started_in_vm'}
 *            await sleep(80)
 *          return {reason:'health_timeout'}
 *
 * rustKernelReachable(health) = rustKernelProcessUp(health)
 *                            && health.healthy !== false
 *                            && rustKernelCliReady(health)
 *
 *   rustKernelProcessUp  : health.ok === true || Number(health.status) === 200
 *                          || health.engine === 'rust' || health.worker_version
 *   rustKernelCliReady   : health.ready_slots == null ? true : Number(ready_slots) > 0
 *
 * 三条硬结论：
 *   1. **ready_slots 必须 > 0**。只回 `{ok:true}` 不写 ready_slots 会通过
 *      （缺省视为 ready），但一旦写了 0 就永远等不到 started —— supervisor
 *      会把它当「满载」，而满载不等于死亡，于是既不重启也不前进。
 *   2. **单次 health 必须在 400ms 内返回**（waitForHealth / waitForHealthOrExit
 *      的 timeoutMs 预算，超时即 req.destroy）。codex supervisor 是 500ms，
 *      watchdog 是 800ms。我们的目标是 100ms 以内，留足余量。
 *   3. **HTTP 200 + body.ok === true 才是 ok**。workerHealth 的判定是
 *      `response.statusCode === 200 && body?.ok === true`，它把整个 body
 *      展开进返回值（`...body`），所以 body 里任何字段都能被 toPublicKernelHealth 读到。
 *
 * ══════════════════════════════════════════════════════════════
 * 有没有版本校验：没有
 * ══════════════════════════════════════════════════════════════
 *
 * `version` / `worker_version` / `cli_version` / `engine` 这些字段：
 *   - `engine` 参与 rustKernelProcessUp 的判定（'rust' 直接算 up），
 *     并且被 toPublicKernelHealth 原样透出到面板。
 *   - `worker_version` / `version` 只在 rustKernelProcessUp 里当兜底真值用，
 *     **不参与任何相等比较**。
 *   - `cli_version` 只是从 kernel.json 抄出来展示。
 *
 * 也就是说：所谓「伪装成 Rust 内核」只有两件事 ——
 *   (a) engine 报 'rust'；
 *   (b) health 的字段集合与语义与真内核一致（尤其 ready_slots / cli_pid / healthy）。
 * 没有任何 proto 版本号、capability 协商或 config_hash 比较走 HTTP。
 *
 * （config_hash 只在 CLI 的 stdout 帧协议里有：frames.mjs 的 validateHostReady
 *   会拿 host_ready 的 config_hash 与内核自己的期望比。那是内核 ↔ CLI 之间的
 *   事，与 vm2api 控制面无关。）
 *
 * ══════════════════════════════════════════════════════════════
 * 会让我们被迫重启的几个暗坑（都在 supervisor 里）
 * ══════════════════════════════════════════════════════════════
 *
 * 1. `syncKernelSlotCount`：kernel.json 的 slots_per_worker 必须等于
 *    KERNEL_NATIVE_SLOT_COUNT(20)。不等就改文件并强制重启（slotMismatch）。
 *    我们的内核必须真的按 20 槽上报，否则每次 start 都被判 slotMismatch。
 *
 * 2. `wrapNewerThanKernel`：若 `<home>/.kin/{kin-kernel,kin-kernel.bin,cli-node}`
 *    里最大 mtime 比 socket 文件 mtime 新 500ms 以上，就判定 wrap 比内核新，
 *    触发重启。**替换内核时这条最容易咬人**：我们的 Node 内核入口文件如果
 *    落在 .kin/ 下且比 socket 新，会陷入「启动 → 被判定过期 → 再启动」。
 *    对策：入口不放 .kin/，或启动时 touch socket（listen 本身就会创建/更新）。
 *
 * 3. `containerKernelIsPid1`：`docker inspect --format {{.Path}} <container>`
 *    命中 /kin-kernel/ 才算 PID1 内核；否则 supervisor 先 killWrapDataplane
 *    （按 proc 的 exe 链接逐个匹配 .kin/cli-node|.kin/kin-kernel）再 exec 起新内核。
 *    我们的 Node 入口不属于这两个路径，因此不会被那条 kill 规则误杀 ——
 *    但反过来说，替换后容器 PID1 仍是旧 kin-kernel 的话，它会继续占着 socket。
 *
 * 4. `startNativeKernel`：macOS 本机（slotHost(vm).native）没有容器可 exec，
 *    内核是 launchd 作业，重启走 host.restartKernel。macOS 上自建要先有 plist。
 */

import fs from 'node:fs'
import { KERNEL_VERSION, KERNEL_WORKER_VERSION, KERNEL_PROTOCOL_VERSION } from './contract.mjs'
import { DEFAULT_KERNEL_SLOTS, KERNEL_ENGINE_LABEL } from './defaults.mjs'

// ── 从 supervisor 抄出来的时间与数量常量 ──────────────────────────

/** 一次 health 请求的超时预算（rust-kernel-supervisor.mjs waitForHealth / waitForHealthOrExit）。 */
export const SUPERVISOR_HEALTH_TIMEOUT_MS = 400

/** supervisor 的轮询间隔（同上，两处都是 80ms）。 */
export const SUPERVISOR_POLL_INTERVAL_MS = 80

/** Codex supervisor 的 health 预算与轮询间隔（codex-kernel-supervisor.mjs）。 */
export const CODEX_HEALTH_TIMEOUT_MS = 500
export const CODEX_POLL_INTERVAL_MS = 100

/** watchdog 的 health 预算（kernel-watchdog.mjs tryKernelReload 用 800ms）。 */
export const WATCHDOG_HEALTH_TIMEOUT_MS = 800

/** 容器启动预算缺省值。KVM 客机另给 120s / 480s（KVM_HEALTH_MS）。 */
export const DEFAULT_START_TIMEOUT_MS = 30_000
export const KVM_HEALTH_TIMEOUT_MS = Object.freeze({ kvm: 120_000, tcg: 480_000 })

/** 已有 PID1 内核或 wedged 内核时，先原地等这么久再动容器（WEDGED_READY_WAIT_MS）。 */
export const WEDGED_READY_WAIT_MS = 3_000

/** 硬性槽数。kernel.json 的 slots_per_worker 必须等于它，否则被判 slotMismatch。 */
export const SUPERVISOR_SLOTS = DEFAULT_KERNEL_SLOTS

/** supervisor 起内核用的命令行（docker exec 形式）与配置路径。 */
export const SUPERVISOR_START = Object.freeze({
  bin: '/home/kincli/.kin/kin-kernel',
  argv: Object.freeze(['--gateway-worker', '--config', '/run/kin/kernel.json']),
  configPath: '/run/kin/kernel.json',
  env: Object.freeze({ KIN_SUBMIT_WAIT_MS: '30000', KIN_SLOT_MAX_LIFETIME_SECS: '604800' }),
})

/** kernel.json 里决定槽数与 socket 位置的键（dot-path，便于测试断言）。 */
export const KERNEL_CONFIG_KEYS = Object.freeze([
  'vm_id',
  'socket_path',
  'internal_token',
  'credential_path',
  'provider',
  'runtime_kind',
  'delivery_mode',
  'slots_per_worker',
  'cli_version',
  'claude_bin',
  'max_request_bytes',
  'idle_timeout_seconds',
  'first_byte_timeout_seconds',
  'request_timeout_seconds',
  'proxy_url',
  'proxy_required',
  'persona_preset',
  'system_layout',
  'default_cache_ttl',
  'timezone',
])

/**
 * supervisor 的判据，逐条复刻。
 *
 * 返回一个结构而不是布尔，是为了让内核自检能说清「为什么不 ready」，
 * 而不是只回一个 false 让运维去猜。
 *
 * @param {object} health /internal/health 的响应体
 * @returns {{ready:boolean, processUp:boolean, busy:boolean, needsRestart:boolean, reasons:string[]}}
 */
export function supervisorView(health) {
  const reasons = []
  const processUp = supervisorProcessUp(health)
  if (!processUp) reasons.push('process_down')

  const healthy = health?.healthy !== false
  if (!healthy) reasons.push('healthy_false')

  const slots = health?.ready_slots
  let cliReady = true
  if (slots != null) {
    const n = Number(slots)
    cliReady = Number.isFinite(n) && n > 0
    if (!cliReady) reasons.push(`ready_slots=${slots}`)
  }

  const ready = processUp && healthy && cliReady

  // rustKernelBusy：进程活着、没放弃、在恢复或在跑 job
  const recovering = health?.recovering === true
  const cliPid = numberOrNull(health?.cli_pid)
  const busy = processUp && healthy && !cliReady ? recovering || (cliPid != null && cliPid > 0) : false

  // rustKernelNeedsRestart：只有容器重启能救
  const needsRestart = !processUp || !healthy

  return { ready, processUp, busy, needsRestart, reasons }
}

/** rustKernelProcessUp 的等价实现。 */
export function supervisorProcessUp(health) {
  if (!health) return false
  if (health.ok === true) return true
  if (Number(health.status) === 200) return true
  if (health.engine === KERNEL_ENGINE_LABEL || health.worker_version) return true
  return false
}

/**
 * 就绪 payload。
 *
 * 在 config.mjs 的 healthPayload 之上做三件事，都是为了满足控制面：
 *   1. version / worker_version 换成我们自己的标识（控制面不比较，但要能认出来）；
 *   2. engine 强制 'rust'（控制面据此走 rust 分支，这是与 supervisor 兼容的核心）；
 *   3. ok 严格按 `healthy && ready_slots > 0` 计算 —— 与 supervisor 的判定同构，
 *      避免出现「内核说自己 ok，supervisor 说没起来」的双方差。
 *
 * @param {object} config 内核配置
 * @param {object} state  运行状态（readySlots / cliPid / ...）
 */
export function readinessPayload(config = {}, state = {}) {
  const readySlots = numberOr0(state.readySlots)
  const healthy = state.healthy !== false
  const recovering = state.recovering === true
  const startedAt = Number(state.startedAt) || Date.now()

  // Codex 通道没有 CLI 槽位，readySlots 恒为 0 —— 但通道本身是就绪的。
  //
  // 只看 readySlots 会让 Codex-only 内核永远 ok:false：
  // 控制面据此认定"内核没起来"，而实际请求全都能跑通。
  // 实测 vm2api 的 workerHealth 就是 `statusCode===200 && body.ok===true`，
  // 于是 codexKernelHealth 返回 ok:false，尽管 callCodexKernel 已经成功出结果。
  //
  // 所以再加上 codexReady：Codex 凭据可用时，用它的槽位容量顶上 ready_slots。
  // 两个通道都不就绪时仍为 false —— 那种情况确实该报未就绪。
  const codexReady = state.codexReady === true && numberOr0(state.codexReadySlots) > 0
  const effectiveReady = codexReady ? Math.max(readySlots, numberOr0(state.codexReadySlots)) : readySlots

  return {
    // ── 控制面判就绪用到的五个字段（少一个都可能判错）
    ok: healthy && effectiveReady > 0,
    status: 200,
    engine: KERNEL_ENGINE_LABEL,
    healthy,
    ready_slots: effectiveReady,
    // ── 监督与调度用到的
    closed_slots: numberOr0(state.closedSlots),
    cli_pid: numberOrNull(state.cliPid),
    cli_restarts: numberOr0(state.cliRestarts),
    cli_started: state.cliStarted === true,
    cli_error: state.cliError ? serializeCliError(state.cliError) : null,
    cli_version: config.cli_version || null,
    recovering,
    unhealthy_reason: state.unhealthyReason || null,
    // ── 面板展示用
    provider: config.runtime_kind || config.provider || null,
    runtime_kind: config.runtime_kind || config.provider || null,
    delivery_mode: config.delivery_mode || 'realtime',
    credential_state: state.credentialState || 'missing',
    proxy_configured: Boolean(config.proxy_url),
    proxy_required: Boolean(config.proxy_required),
    uptime_seconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    version: KERNEL_VERSION,
    worker_version: KERNEL_WORKER_VERSION,
    vm_id: config.vm_id || '',
    // 我们自己加的两个诊断字段。控制面不认识它们，多余字段不影响解析。
    slots_per_worker: numberOr0(state.slotsPerWorker),
    classifier_request_context: Boolean(state.classifierRequestContext),
  }
}

/**
 * 版本握手：**如实说明没有握手**。
 *
 * 返回的这个对象不是要发给谁，而是把「控制面对版本的期望」写成可断言的形状，
 * 供测试与运维检查。任何试图真的做握手（例如等一个 /internal/handshake）
 * 的实现都是在给自己加控制面没有的约束。
 */
export function versionHandshake() {
  return {
    // 控制面是否比较版本号：否。见本文件头部说明。
    hasVersionGate: false,
    // 控制面唯一会读的"身份"字段：engine。必须是 'rust'。
    engine: KERNEL_ENGINE_LABEL,
    // 我们自报的版本。控制面只展示，不比较。
    version: KERNEL_VERSION,
    worker_version: KERNEL_WORKER_VERSION,
    // 内核 ↔ CLI 之间的帧协议版本（与 HTTP 契约无关，但自检时需要一致）。
    frameProtocolVersion: KERNEL_PROTOCOL_VERSION,
    // 控制面会等待的首包预算，用来判断我们的 health 是否够快。
    healthBudgetMs: SUPERVISOR_HEALTH_TIMEOUT_MS,
    // 控制面判定就绪所读的字段名，顺序即读取顺序。
    readinessFields: ['ok', 'status', 'engine', 'healthy', 'ready_slots'],
  };
}

/**
 * 把 vm2api 写出来的 kernel.json 投影成我们内核要的配置。
 *
 * 刻意做成单向投影：**只读不写**。vm2api 的 writeKernelConfig 会在每次启动、
 * 每次面板保存时重写这个文件；我们去改它等于和对方抢同一个文件，
 * 而且会被 "字节没变不重写" 的逻辑无声覆盖。
 *
 * 缺失或非法的字段一律回落到我们的缺省值，不回落到「启动失败」——
 * 内核起不来的表现比配置不全糟糕得多，且 supervisor 只能看到 health_timeout，
 * 完全不知道是哪个字段的问题。
 *
 * @param {string} configPath kernel.json 路径
 * @param {{env?:object, fallback?:object}} [opts]
 */
export function kernelConfigFromFile(configPath, { env = process.env, fallback = {} } = {}) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    // 读不到就用 fallback 起来。health 会如实报 credential_state=missing 之类的状态，
    // 比让 supervisor 干等到 30s 超时好。
    raw = {}
    fallback = { ...fallback, configReadError: error?.code || String(error?.message || error) }
  }
  return kernelConfigFromVN2(raw, { env, fallback })
}

/**
 * 同上的纯函数版本，便于不碰磁盘的测试。
 *
 * vm2api 的 kernel.json 与我们的 WorkerConfig 之间只差字段名与几处默认值，
 * 这里做显式映射，不做 ...spread 透传 —— 透传会让对端新增一个同名字段
 * 悄悄改掉我们的行为（例如他们将来加个 `slots_per_worker: 0`）。
 */
export function kernelConfigFromVN2(raw = {}, { env = process.env, fallback = {} } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const socketPath = String(src.socket_path || fallback.socket_path || '')

  return {
    // ── 身份与鉴权
    vm_id: String(src.vm_id || fallback.vm_id || ''),
    internal_token: String(src.internal_token || fallback.internal_token || ''),
    // ── 监听位置：vm2api 只支持 unix；tcp 是我们为本地调试加的
    socket_path: socketPath,
    // Codex 通道的 socket。vm2api 的 codex-kernel-supervisor 会 spawn 独立进程
    // dial 这个路径；我们同进程双 socket，因此从同一 run 目录推导。
    codex_socket_path: String(
      src.codex_socket_path ||
        fallback.codex_socket_path ||
        (socketPath ? socketPath.replace(/kernel\.sock$/, 'codex-kernel.sock') : ''),
    ),
    // 监听形态：kernel.json 里的值优先，其次环境变量。
    // 只读 fallback 会让配置文件里写 kernel_listen 完全无效 ——
    // 面板上改了不生效、也没有任何报错，排查时看不出问题在哪。
    kernel_listen: String(src.kernel_listen || fallback.kernel_listen || 'unix'),
    kernel_tcp_host: String(src.kernel_tcp_host || fallback.kernel_tcp_host || '127.0.0.1'),
    kernel_tcp_port: numberOr0(src.kernel_tcp_port) || numberOr0(fallback.kernel_tcp_port),
    // ── CLI 侧
    credential_path: String(src.credential_path || fallback.credential_path || ''),
    claude_bin: String(src.claude_bin || env.CLAUDE_BIN || fallback.claude_bin || 'claude'),
    cli_version: String(src.cli_version || fallback.cli_version || ''),
    // ── 行为开关
    provider: String(src.provider || fallback.provider || 'anthropic_api'),
    runtime_kind: String(src.runtime_kind || fallback.runtime_kind || 'local_cli'),
    delivery_mode: String(src.delivery_mode || fallback.delivery_mode || 'realtime'),
    // supervisor 用 slots_per_worker 判 slotMismatch，我们照抄，不用自己的缺省
    slots_per_worker: numberOr0(src.slots_per_worker) || numberOr0(fallback.slots_per_worker) || SUPERVISOR_SLOTS,
    // ── 限额与超时
    kernel_max_request_bytes:
      numberOr0(src.max_request_bytes) || numberOr0(fallback.kernel_max_request_bytes) || 64 * 1024 * 1024,
    kernel_health_budget_ms: numberOr0(fallback.kernel_health_budget_ms) || 100,
    idle_timeout_seconds: numberOr0(src.idle_timeout_seconds) || 180,
    first_byte_timeout_seconds: numberOr0(src.first_byte_timeout_seconds) || 120,
    request_timeout_seconds: numberOr0(src.request_timeout_seconds) || 600,
    // ── 出口
    proxy_url: String(src.proxy_url || ''),
    proxy_required: src.proxy_required === true,
    // ── Codex 通道
    // 必须投影：内核形态下 Codex 请求要自己转发上游，缺了凭据路径
    // 每个请求都会退化成 503，而控制面看到的是"内核就绪"。
    codex_credential_path: String(
      src.codex_credential_path || fallback.codex_credential_path || env.KERNEL_CODEX_CREDENTIAL_PATH || '',
    ),
    codex_default_model: String(
      src.codex_default_model || fallback.codex_default_model || env.KERNEL_CODEX_MODEL || '',
    ),
    codex_base_url: String(src.codex_base_url || fallback.codex_base_url || ''),
    // ── 提示词侧（内核透传给 outbound 组装）
    persona_preset: src.persona_preset || null,
    // 提示词档位同样要投影：写了不读等于配置项是假的，
    // 面板上改档位不生效且没有任何报错。
    claude_prompt_profile: String(
      src.claude_prompt_profile || fallback.claude_prompt_profile || env.KERNEL_PROMPT_PROFILE || '',
    ),
    system_layout: String(src.system_layout || fallback.system_layout || 'zero'),
    default_cache_ttl: String(src.default_cache_ttl || fallback.default_cache_ttl || '1h'),
    timezone: String(src.timezone || fallback.timezone || ''),
    // ── 诊断
    config_read_error: fallback.configReadError || null,
  }
}

/**
 * 解析监听目标，供 server.listen 用。
 *
 * unix：`{ path }`；tcp：`{ host, port }`。两者互斥，
 * server.mjs 只按返回的第一个键分支，不做二次判断。
 */
export function listenTarget(config = {}) {
  const mode = String(config.kernel_listen || 'unix').toLowerCase()
  if (mode === 'tcp') {
    return { host: String(config.kernel_tcp_host || '127.0.0.1'), port: numberOr0(config.kernel_tcp_port) }
  }
  if (!config.socket_path) {
    // 没给 socket 就只能落 tcp 缺省端口，由调用方决定是否接受
    return { host: String(config.kernel_tcp_host || '127.0.0.1'), port: numberOr0(config.kernel_tcp_port) }
  }
  return { path: String(config.socket_path) }
}

/**
 * 全部监听目标（一个内核可能同时接两个 socket）。
 *
 * 为什么需要两个：vm2api 的 Claude 与 Codex 是**两套独立 supervisor + 两个
 * 独立进程**，分别 dial `run/kernel.sock` 与 `run/codex-kernel.sock`
 * （rust-kernel-client / codex-kernel-client 的 paths 函数）。
 * 我们的内核是同一个进程同时提供两条通道，因此必须两个 socket 都听 ——
 * 只听 kernel.sock 会让 codexKernelHealth 永远 ECONNREFUSED，
 * 控制面判 Codex 槽不可用（这一步在 compat-test 里实测踩到了）。
 *
 * 顺序固定：主 socket（Claude）在前，Codex socket 在后。
 * 调用方按 addresses[0] 报主地址。
 *
 * 同一路径只保留一次：单进程部署时用户可能把两者配成同一个值。
 */
export function listenTargets(config = {}) {
  const primary = listenTarget(config)
  const targets = [primary]

  const codexSocket = String(config.codex_socket_path || '')
  if (codexSocket && codexSocket !== primary.path) {
    if (String(config.kernel_listen || 'unix').toLowerCase() === 'tcp') {
      // tcp 模式下 Codex 通道复用同一个端口：路由已经按 path 分流，
      // 再开一个端口只会让部署多一个要维护的配置项。
      return targets
    }
    targets.push({ path: codexSocket })
  }
  return targets
}

/**
 * 启动前的环境自检：把上面那四个「暗坑」变成可读的告警。
 *
 * 不返回失败 —— 这些条件大多在 vm2api 侧，我们只能提示运维去改。
 * 返回 [] 表示没发现问题。
 *
 * @param {{homeDir?:string, socketPath?:string, kernelJsonPath?:string, entryPath?:string}} input
 */
export function startupWarnings({ homeDir = '', socketPath = '', kernelJsonPath = '', entryPath = '' } = {}) {
  const warnings = []

  // 暗坑 2：入口落在 .kin/ 下，会触发 wrapNewerThanKernel 的反复重启
  if (homeDir && entryPath) {
    const kinDir = `${homeDir.replace(/\/+$/, '')}/.kin`
    if (entryPath.startsWith(`${kinDir}/`)) {
      warnings.push(
        `kernel entry ${entryPath} lives under ${kinDir}; supervisor's wrapNewerThanKernel() ` +
          'will treat it as a newer wrap binary than the socket and restart the kernel repeatedly. ' +
          'Move the entry outside .kin/.',
      )
    }
  }

  // 暗坑 1：kernel.json 的槽数不等于 20 会被改写并强制重启
  if (kernelJsonPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(kernelJsonPath, 'utf8'))
      const slots = Number(raw?.slots_per_worker)
      if (Number.isFinite(slots) && slots !== SUPERVISOR_SLOTS) {
        warnings.push(
          `kernel.json slots_per_worker=${slots} != ${SUPERVISOR_SLOTS}; ` +
            'syncKernelSlotCount() rewrites it and forces a restart (reason: slotMismatch).',
        )
      }
      const jsonSocket = String(raw?.socket_path || '')
      if (jsonSocket && socketPath && jsonSocket !== socketPath) {
        warnings.push(
          `kernel.json socket_path=${jsonSocket} != kernel listening on ${socketPath}; ` +
            'supervisor dials the path from kernel.json (or run/kernel.sock), so it will never reach us.',
        )
      }
    } catch (error) {
      warnings.push(`cannot read kernel.json at ${kernelJsonPath}: ${error?.code || error?.message || error}`)
    }
  }

  return warnings
}

function numberOr0(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function numberOrNull(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function serializeCliError(error) {
  return {
    code: error?.code || 'UNKNOWN',
    bin: error?.bin ?? null,
    reason: error?.reason || error?.message || null,
    message: error?.message || null,
  }
}
