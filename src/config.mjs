/**
 * 内核配置与协议类型定义。
 *
 * 职责：集中定义 worker 配置的形状、默认值、启动校验，以及 envelope、
 * 错误体、健康检查响应的字段约定。其余模块只 import 这里，不另起第二份定义。
 *
 * 关键约束：
 * 1. anthropic_base_url 必须是 https，且 host 必须是 api.anthropic.com；
 *    其他值在启动校验阶段就被拒绝（上游不接受别的 host）。
 * 2. provider 与 runtime_kind 是两个独立字段：provider 是上游通道选择，
 *    runtime_kind 是本地执行方式。缺省 provider 是 anthropic_api，
 *    不要用 local_cli 作缺省。
 * 3. 校验顺序与错误消息是控制面契约的一部分：控制面按这些字符串做匹配，
 *    改顺序或改文案会破坏对端判断。
 * 4. claude_bin 的取值优先级是：配置文件 claude_bin > 环境变量 CLAUDE_BIN
 *    > 缺省值 'claude'。两者同时存在且值不同时按配置文件执行，并产出一条
 *    warning。解析入口是 resolveClaudeBin，不要在别处重复实现这套优先级。
 */

import { DEFAULT_CHATGPT_BASE as DEFAULT_CODEX_BASE } from './codex.mjs'

export const DELIVERY_MODES = /** @type {const} */ (['realtime', 'verified'])
export const RUNTIME_KINDS = /** @type {const} */ (['local_cli', 'anthropic_api'])
export const DEFAULT_CLAUDE_BIN = 'claude'
// 提示词档位枚举。manual 之外的值由 prompt-profiles.mjs 归一（303 / full 等别名）。
export const CLAUDE_PROMPT_PROFILES = /** @type {const} */ (['official_full', 'official_303'])
// SystemMode 只有 zero / identity 两个枚举值；stock 表示"不写入自定义布局"，
// 它是缺省语义而不是枚举成员，因此不出现在这个列表里。
export const SYSTEM_LAYOUTS = /** @type {const} */ (['zero', 'identity'])
export const CREDENTIAL_STATES = /** @type {const} */ ([
  'missing',
  'fresh',
  'refreshable',
  'refresh_window',
  'expired',
  'expired_refreshable',
])

/**
 * WorkerConfig 默认值。
 * 必填：vm_id、internal_token、socket_path、credential_path、
 *      anthropic_base_url、runtime_kind、claude_bin（local_cli 时）
 */
export const DEFAULT_WORKER_CONFIG = Object.freeze({
  vm_id: '',
  socket_path: '/run/guest/worker.sock',
  credential_path: '/home/guest/.claude/credentials.json',
  proxy_url: '',
  proxy_required: false,
  // 必须是 https，且 host 必须是 api.anthropic.com，否则启动校验失败
  anthropic_base_url: 'https://api.anthropic.com',
  oauth_token_url: 'https://platform.claude.com/v1/oauth/token',
  internal_token: '',
  refresh_skew_seconds: 300,
  request_timeout_seconds: 600,
  first_byte_timeout_seconds: 120,
  idle_timeout_seconds: 180,
  max_request_bytes: 64 * 1024 * 1024,
  max_response_bytes: 64 * 1024 * 1024,
  max_event_bytes: 1024 * 1024,
  delivery_mode: 'realtime',
  test_endpoints: false,
  runtime_kind: 'local_cli',
  provider: 'anthropic_api', // 缺省 provider 是 anthropic_api，不要改成 local_cli
  claude_bin: DEFAULT_CLAUDE_BIN,
  https_proxy: '',
  system_layout: 'zero',
  cli_version: '2.1.281',
  default_cache_ttl: '1h',
  // ── 真实 Anthropic 出站（src/anthropic.mjs）──────────────
  // mock_mode 缺省 false：缺省走真实上游。显式设 true 才回落 mock 响应，
  // 这条降级路径是给「没有上游凭据 / 上游不可达」的联调场景用的，
  // 不是缺省行为——缺省 mock 会让部署以为通了、实际一次都没出网。
  mock_mode: false,
  // Anthropic 凭据文件。两个形态都支持（单账号 / {accounts:[...]}），
  // 也认官方 credentials.json 的 claudeAiOauth 形态，见 src/anthropic-credentials.mjs。
  // 空串表示走环境变量（CLAUDE_CODE_OAUTH_TOKEN 等），两者都没有时出站直接 401 透出。
  anthropic_credential_path: '',
  // 出站整体超时。与 request_timeout_seconds 分开：后者是「控制面等一次请求」的上限，
  // 这里是「一次 HTTP 往返」的上限，长流场景两者可以不同。
  anthropic_timeout_ms: 600_000,
  // body 超过这个字节数才做 zstd 压缩。小于它压了反而更大。
  anthropic_compress_threshold: 1024,
  // 提示词档位。缺省 official_full 保持现有出站结构；official_303 按模型
  // 组装 2.1.303 结构（lean 模型把调用方 system 折进首条 user，
  // Environment 作为尾部 role=system）。取值见 prompt-profiles.mjs 的 PROFILES。
  // 空串等同未配置，由 prompt-profiles.mjs 按模型能力选档。
  claude_prompt_profile: 'official_full',
  // ── Claude 配额窗口门禁 ────────────────────────────────
  // 上游的 5h / 7d 用量窗口达到阈值时收紧调度，避免连续 429 被降权。
  // warn 只是打日志并标记 degraded，stop 直接拒绝派活。
  // 两个阈值必须满足 0 < warn < stop <= 100，否则回落缺省（见 quota-window.mjs）。
  claude_quota_enabled: true,
  claude_quota_warn_pct: 85,
  claude_quota_stop_pct: 95,
  // ── Codex 通道（--codex 模式）──────────────────────────
  // 凭据文件路径。支持单账号与 {"accounts":[...]} 两种形态，
  // 见 src/codex-credentials.mjs。缺省空串表示未启用 Codex 通道。
  codex_credential_path: '',
  // 上游 base。必须是 https 且 host 为 chatgpt.com —— 与 anthropic_base_url
  // 同样的白名单策略：上游不接受别的 host。
  codex_base_url: DEFAULT_CODEX_BASE,
  // 缺省模型。必须是上游 /models 列表里的名字，否则 400
  // `model is not supported when using Codex with a ChatGPT account`。
  codex_default_model: 'gpt-6-astra',
  // 上游可用模型（实测，见 research/live/FINDINGS.md）
  codex_models: [
    'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-reserve', 'gpt-6-luna',
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'codex-auto-review',
  ],
  // ── Codex 生图（/v1/images/*）──────────────────────────
  // 可启停的图像模型清单。数组里出现的 id 才是启用的：
  // 空数组表示全部停用（此时 /v1/models 不列任何图像模型，
  // 任何图像模型请求返回 400 model_disabled）。
  // 启停语义与 codex_models 相反是刻意的：生图是"白名单启用"的付费能力，
  // 加新模型必须显式打开，不能被一次上游同步悄悄放出来。
  codex_image_models: [
    'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
  ],
  // ── 内核适配层（src/kernel/*）──────────────────────────
  // 这一组字段不在 vm2api 的 kernel.json 里，是我们自己的扩展。
  // 读取方是 src/kernel/supervisor-compat.mjs 的 kernelConfigFromFile：
  // 它把 vm2api 写出的 kernel.json（snake_case、字段更多）投影成这里这几项，
  // 因此外部永远只需要维护 vm2api 那份配置，我们不去改对端的格式。
  //
  // kernel_listen: 'unix' 走 socket_path，'tcp' 走 kernel_tcp_host:kernel_tcp_port。
  // 缺省 unix —— vm2api 的 supervisor 只会 dial socket。
  kernel_listen: 'unix',
  kernel_tcp_host: '127.0.0.1',
  kernel_tcp_port: 0,
  // 单次请求的处理上限。与 vm2api kernel.json 的 max_request_bytes 同义，
  // 缺省 64MiB（上游 inboundBodyLimit 的同一档）。
  kernel_max_request_bytes: 64 * 1024 * 1024,
  // 就绪轮询预算。vm2api 侧单次 health 超时 400ms（waitForHealth）、
  // 500~800ms（codex supervisor / watchdog），因此我们的 health 必须远快于 400ms。
  kernel_health_budget_ms: 100,
})

/**
 * 解析 CLI 可执行文件路径。
 *
 * 优先级（高到低）：
 *   1. 配置文件 claude_bin
 *   2. 环境变量 CLAUDE_BIN
 *   3. 缺省值 'claude'（走 PATH 查找）
 *
 * 配置文件优先是刻意的：配置是部署时写死的快照，比进程环境更难被意外覆写，
 * 出问题时也能从同一个文件里看到实际生效的值。两者同时给出且值不同时
 * 按配置文件执行，并返回一条 warning 说明被忽略的是环境变量。
 *
 * configValue 传 undefined（而不是空串）表示"配置文件没有这个字段"；
 * 空串等同未设置，避免把空值当成合法路径。
 *
 * @param {{configValue?: string, env?: object}} input
 * @returns {{bin: string, source: 'config'|'env'|'default', warning: string|null}}
 */
export function resolveClaudeBin({ configValue, env = {} } = {}) {
  const fromConfig = typeof configValue === 'string' ? configValue.trim() : ''
  const fromEnv = typeof env?.CLAUDE_BIN === 'string' ? env.CLAUDE_BIN.trim() : ''
  if (fromConfig) {
    if (fromEnv && fromEnv !== fromConfig) {
      return {
        bin: fromConfig,
        source: 'config',
        warning: `claude_bin: config value ${fromConfig} overrides CLAUDE_BIN=${fromEnv}; using config value`,
      }
    }
    return { bin: fromConfig, source: 'config', warning: null }
  }
  if (fromEnv) return { bin: fromEnv, source: 'env', warning: null }
  return { bin: DEFAULT_CLAUDE_BIN, source: 'default', warning: null }
}

/**
 * 校验 anthropic_base_url。
 *
 * 三条规则，错误文案是对外契约：
 *   1. 必须能被 URL 解析 → `endpoint must use https`
 *   2. 必须 https        → `endpoint must use https`
 *   3. host 必须是 api.anthropic.com → `endpoint host must be api.anthropic.com`
 *
 * 为什么第 3 条硬编码：上游只在这个域名后面；别的 host 发过去只会拿到
 * 404 或第三方网关的错误，排查时会误判成"请求格式错了"。
 * 自建代理的场景应由 proxy_url 承载，而不是改 base_url。
 *
 * @returns {string} 规范化后的 origin + path（去掉尾斜杠）
 * @throws {Error} 文案见上
 */
export function validateAnthropicBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('anthropic_base_url: endpoint must use https')
  }
  if (url.protocol !== 'https:') throw new Error('anthropic_base_url: endpoint must use https')
  if (url.hostname !== 'api.anthropic.com') {
    throw new Error('anthropic_base_url: endpoint host must be api.anthropic.com')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * 校验并补全 worker 配置。
 *
 * 校验顺序与错误消息属于对外契约：控制面依赖这些字符串做分类与重试决策，
 * 因此顺序和文案都需要保持稳定。对应的错误消息集合是：
 *   decode worker config: missing field `vm_id`
 *   internal_token is required
 *   build hop client: builder error
 *   anthropic_base_url: endpoint must use https
 *   anthropic_base_url: endpoint host must be api.anthropic.com
 */
export function validateWorkerConfig(raw) {
  const cfg = { ...DEFAULT_WORKER_CONFIG, ...(raw || {}) }
  if (!raw || typeof raw !== 'object') throw new Error('decode worker config: expected a map')
  if (!cfg.vm_id) throw new Error('decode worker config: missing field `vm_id` at line 1 column 2')
  if (!cfg.internal_token) throw new Error('internal_token is required')
  if (!cfg.socket_path) throw new Error('build hop client: builder error')

  // 枚举校验：这两个字段决定执行方式与提示词形态，写错时应当立刻拒绝。
  // 不校验的话，'BOGUS' 会被一路带到分支判断里，落到 else 分支使用某个
  // 隐式默认值 —— 配置看起来"生效了"，实际行为与写的值无关。
  if (!RUNTIME_KINDS.includes(cfg.runtime_kind)) {
    throw new Error(`runtime_kind must be one of ${RUNTIME_KINDS.join('|')}, got ${JSON.stringify(cfg.runtime_kind)}`)
  }
  // stock 表示"不写入自定义布局"，是缺省语义而非枚举成员，
  // 因此在 SYSTEM_LAYOUTS 之外单独放行。
  if (cfg.system_layout !== 'stock' && !SYSTEM_LAYOUTS.includes(cfg.system_layout)) {
    throw new Error(`system_layout must be one of ${SYSTEM_LAYOUTS.join('|')}, got ${JSON.stringify(cfg.system_layout)}`)
  }

  // host 白名单是硬编码的。若要对接自建上游，需要把这里放宽成配置项，
  // 并且同步修改 DEFAULT_WORKER_CONFIG 的默认值，否则默认配置启动即失败。
  cfg.anthropic_base_url = validateAnthropicBaseUrl(cfg.anthropic_base_url)
  // provider 是真实的持久化字段，缺省 anthropic_api，只接受两个值。
  const provider = cfg.provider ?? 'anthropic_api'
  if (provider !== 'anthropic_api' && provider !== 'local_cli') {
    throw new Error(`provider must be anthropic_api or local_cli, got "${provider}"`)
  }
  cfg.provider = provider
  if (!DELIVERY_MODES.includes(cfg.delivery_mode)) {
    throw new Error(`delivery_mode must be realtime or verified, got "${cfg.delivery_mode}"`)
  }
  for (const key of ['request_timeout_seconds', 'first_byte_timeout_seconds', 'idle_timeout_seconds']) {
    if (!(Number(cfg[key]) > 0)) throw new Error(`${key} must be positive`)
  }
  // 档位只做枚举校验，别名归一留给 prompt-profiles.mjs：配置层不做归一，
  // 否则控制面写进来的 303 会被静默改成 official_303，两端看到的取值就不一致了。
  if (!CLAUDE_PROMPT_PROFILES.includes(cfg.claude_prompt_profile)) {
    throw new Error(
      `claude_prompt_profile must be one of ${CLAUDE_PROMPT_PROFILES.join(',')}, got "${cfg.claude_prompt_profile}"`,
    )
  }
  // 配额阈值只做范围校验，非法值由 quota-window.mjs 的 thresholdsOf 收敛成缺省。
  // 这里不抛错是刻意的：门禁是旁路保护，配置写错应该退化成缺省阈值继续工作，
  // 而不是让整个 worker 起不来。
  for (const key of ['claude_quota_warn_pct', 'claude_quota_stop_pct']) {
    const n = Number(cfg[key])
    if (!Number.isFinite(n) || n <= 0 || n > 100) cfg[key] = DEFAULT_WORKER_CONFIG[key]
  }
  if (!(Number(cfg.claude_quota_warn_pct) < Number(cfg.claude_quota_stop_pct))) {
    cfg.claude_quota_warn_pct = DEFAULT_WORKER_CONFIG.claude_quota_warn_pct
    cfg.claude_quota_stop_pct = DEFAULT_WORKER_CONFIG.claude_quota_stop_pct
  }
  cfg.claude_quota_enabled = cfg.claude_quota_enabled !== false
  return cfg
}

/**
 * 校验 Codex 通道配置。
 *
 * 与 validateWorkerConfig 分开：Codex 通道可以独立启用（--codex），
 * 不要求 vm_id / socket_path 这些 worker 字段。两者共用同一份默认值表。
 *
 * 校验点：
 *   - codex_base_url 必须能被 URL 解析、必须 https、host 必须是 chatgpt.com
 *     （上游只在这个域名后面，别的 host 发过去只会拿到 404/模拟失败）
 *   - codex_default_model 必须是列表里的名字
 *   - codex_credential_path 非空时只做形态检查，文件是否存在由调用方加载时报错
 */
export function validateCodexConfig(raw = {}) {
  const cfg = { ...DEFAULT_WORKER_CONFIG, ...(raw || {}) }

  let url
  try {
    url = new URL(cfg.codex_base_url)
  } catch {
    throw new Error('codex_base_url: endpoint must use https')
  }
  if (url.protocol !== 'https:') throw new Error('codex_base_url: endpoint must use https')
  if (url.hostname !== 'chatgpt.com') {
    throw new Error('codex_base_url: endpoint host must be chatgpt.com')
  }
  // 尾斜杠在 responsesUrl 里会再处理，但存配置时先规范化，避免两处不一致
  cfg.codex_base_url = `${url.origin}${url.pathname.replace(/\/+$/, '')}`

  const model = String(cfg.codex_default_model || '')
  if (!model) throw new Error('codex_default_model is required')
  if (!cfg.codex_models.includes(model)) {
    throw new Error(`codex_default_model must be one of ${cfg.codex_models.join(',')}, got "${model}"`)
  }

  if (cfg.codex_credential_path != null && typeof cfg.codex_credential_path !== 'string') {
    throw new Error('codex_credential_path must be a string')
  }

  // codex_image_models 只做形态与白名单校验：写错模型名不该在启动时报错，
  // 但写错的项会被 codex-images.mjs 的 canonicalImageModel 过滤掉（等于停用）。
  // 这里只拒绝明显非法的形态，避免配置写错后静默变成"一个都没启用"。
  if (cfg.codex_image_models != null && !Array.isArray(cfg.codex_image_models)) {
    throw new Error('codex_image_models must be an array of model ids')
  }
  return cfg
}

/** Envelope —— POST /internal/v1/messages 的请求体，8 字段 */export class Envelope {
  constructor(raw = {}) {
    if (!raw || typeof raw !== 'object' || !raw.body) {
      // 错误文案固定，控制面按原文匹配
      throw Object.assign(new Error('missing field `body` at line 1 column 2'), { code: 'invalid_request' })
    }
    this.body = raw.body
    this.headers = raw.headers && typeof raw.headers === 'object' ? raw.headers : {}
    this.stream = raw.stream === true
    this.delivery_mode = raw.delivery_mode || 'realtime'
    this.cache_ttl = raw.cache_ttl ?? null
    this.preserve_cache_breakpoints = raw.preserve_cache_breakpoints === true
    this.request_context = raw.request_context || null
    this.request_id = raw.request_id || null
  }
}

/** 统一错误体：{ok:false,error:{type,code,message,status}}，四个子字段都不可省 */
export function workerError(status, code, message, type = 'worker_error') {
  return { ok: false, error: { type, code, message, status } }
}

/**
 * /internal/health 响应骨架。
 *
 * 字段集合与顺序是控制面的读取契约：
 * - healthy 只表达进程自身是否存活，cli 不可用也仍然报 true；
 * - ok 额外要求至少有一个空闲 slot，控制面据此决定是否继续派发；
 * - engine 固定字面值 'rust'，控制面按它区分实现来源，自研部署可改成自有标识。
 *
 * cli_error 是 CLI 启动/退出失败的诊断出口：正常时为 null，失败时带
 * code / bin / reason / message 四项，健康检查据此能在进程存活的前提下
 * 报出 CLI 不可用的具体原因。cli_started 表示是否已经收到过 host_ready。
 */
export function healthPayload(cfg, state) {
  return {
    classifier_request_context: Boolean(state.classifierRequestContext),
    cli_error: state.cliError ? serializeCliError(state.cliError) : null,
    cli_pid: state.cliPid ?? null,
    cli_restarts: state.cliRestarts ?? 0,
    cli_started: state.cliStarted === true,
    cli_version: cfg.cli_version || null,
    closed_slots: state.closedSlots ?? 0,
    credential_state: state.credentialState || 'missing',
    delivery_mode: cfg.delivery_mode,
    engine: 'rust', // 固定字面值，供控制面识别实现来源
    healthy: state.healthy !== false,
    ok: state.healthy !== false && state.readySlots > 0,
    provider: cfg.runtime_kind,
    proxy_configured: Boolean(cfg.proxy_url),
    proxy_required: Boolean(cfg.proxy_required),
    ready_slots: state.readySlots ?? 0,
    recovering: Boolean(state.recovering),
    runtime_kind: cfg.runtime_kind,
    unhealthy_reason: state.unhealthyReason || null,
    uptime_seconds: Math.floor((Date.now() - state.startedAt) / 1000),
    version: '0.1.0',
    vm_id: cfg.vm_id,
    worker_version: '0.1.0',
  }
}

/** 把 Error 收敛成健康检查用的四个纯量字段，避免把堆栈透出去 */
function serializeCliError(error) {
  return {
    code: error?.code || 'UNKNOWN',
    bin: error?.bin ?? null,
    reason: error?.reason || error?.message || null,
    message: error?.message || null,
  }
}
