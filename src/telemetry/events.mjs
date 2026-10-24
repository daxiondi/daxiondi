/**
 * 事件构造：把一次交互翻译成官方事件信封。
 *
 * 官方一次上报的线上结构是 `{ events: [ { event_type, event_data } ] }`，
 * 其中 `event_type` 恒为 `ClaudeCodeInternalEvent`，`event_data` 是事件本身。
 *
 * 这里刻意分成两层，与官方一致：
 *   1. **核心字段**：每个事件都有的身份与会话信息（session_id、model、
 *      user_type、is_interactive、client_type …）
 *   2. **env / process / auth**：环境快照、进程指标（base64）、账号块
 *
 * 键序不是随手排的。官方线上 JSON 的键序由「组装顺序」决定，而组装顺序是
 * 固定的：身份字段 → 账号块 → 核心字段 → env → process → 工具命名槽位 →
 * additional_metadata。键序偏离就是可观测差异，因此这里按同一顺序落键。
 *
 * 时间格式与 ID 格式是最容易露馅的两处：
 *   - `client_timestamp` 是 ISO-8601 带毫秒的 UTC 字符串，形如
 *     `2026-09-28T02:26:10.123Z`（毫秒精度，不是秒，也不是纯秒级 ISO）
 *   - `event_id` 是标准 UUID v4（8-4-4-4-12），不是自增、不是 nano 时间戳
 *   - `device_id` 是 64 位十六进制串（32 字节随机值的 hex），不是 UUID
 */

import crypto from 'node:crypto'
import { buildTelemetryEnv, OFFICIAL_EVENT_TYPE } from './env.mjs'

/** 官方事件名。只登记本模块会构造的几类，其余走 buildEvent 兜底。 */
export const EVENT_NAMES = Object.freeze({
  START: 'tengu_init',
  STARTED: 'tengu_started',
  REQUEST: 'tengu_api_success',
  REQUEST_QUERY: 'tengu_api_query',
  REQUEST_ERROR: 'tengu_api_error',
  TOOL: 'tengu_tool_use_success',
  TOOL_ERROR: 'tengu_tool_use_error',
  ERROR: 'tengu_api_error',
})

/** 队列与批次上限，取自官方客户端的默认配置 */
export const TELEMETRY_LIMITS = Object.freeze({
  maxBatchSize: 200,
  maxQueueSize: 2048,
  batchDelayMs: 100,
  requestTimeoutMs: 10_000,
  maxAttempts: 8,
  baseBackoffDelayMs: 500,
  maxBackoffDelayMs: 30_000,
})

/**
 * event_data 的线上键序。
 *
 * 注意这是**序列化后**的顺序，不是组装顺序。官方先按语义把字段攒进一个
 * 对象，事件在离开进程前还要过一次结构序列化层，那一层按字段定义顺序重排。
 * 最终写进请求体的是重排后的结果，因此这里跟的是重排顺序。
 *
 * 两处容易看错：
 *   - `env` / `process` 在中段，不在末尾
 *   - `additional_metadata` 在 `auth` 之前
 */
export const EVENT_DATA_KEY_ORDER = Object.freeze([
  'event_name',
  'client_timestamp',
  'model',
  'session_id',
  'user_type',
  'betas',
  'env',
  'entrypoint',
  'agent_sdk_version',
  'is_interactive',
  'client_type',
  'process',
  'additional_metadata',
  'auth',
  'server_timestamp',
  'event_id',
  'device_id',
  'swe_bench_run_id',
  'swe_bench_instance_id',
  'swe_bench_task_id',
  'email',
  'agent_id',
  'parent_session_id',
  'agent_type',
  'slack',
  'team_name',
  'skill_name',
  'plugin_name',
  'marketplace_name',
])

const DEFAULT_CLIENT_TYPE = 'cli'
const DEFAULT_USER_TYPE = 'external'
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'

/** UUID v4 正则 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** 设备 ID：64 位 hex */
const HEX64 = /^[0-9a-f]{64}$/
/** 线上时间戳：ISO-8601 UTC，毫秒三位 */
const WIRE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** 生成 UUID v4（小写） */
export function newEventId() {
  return crypto.randomUUID()
}

/** 生成 64 位 hex 设备 ID */
export function newDeviceId() {
  return crypto.randomBytes(32).toString('hex')
}

/** 判断是否为合法 UUID v4 */
export function isEventId(value) {
  return UUID_V4.test(String(value || '').toLowerCase())
}

/** 判断是否为合法 64 位 hex 设备 ID */
export function isDeviceId(value) {
  return HEX64.test(String(value || '').toLowerCase())
}

/** 取一个合法设备 ID，否则生成一个新的 */
export function resolveDeviceId(...candidates) {
  for (const value of candidates) {
    const id = String(value || '').trim().toLowerCase()
    if (HEX64.test(id)) return id
  }
  return newDeviceId()
}

/**
 * 时间戳格式化：ISO-8601、UTC、毫秒三位。
 * 官方在序列化时对时间对象调用 toISOString()，因此一定是这个形状。
 */
export function formatTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  const ms = Number.isNaN(date.getTime()) ? Date.now() : date.getTime()
  return new Date(ms).toISOString()
}

/** 判断是否线上时间戳格式 */
export function isWireTimestamp(value) {
  return WIRE_TIMESTAMP.test(String(value || ''))
}

/**
 * 进程指标：官方上报的是 process.memoryUsage() 与 process.cpuUsage() 的
 * 真实读数，序列化成 JSON 再做 base64。字段名是 camelCase（不是 snake_case）。
 *
 * 未提供真实读数时按官方运行时的典型区间取随机值：目的是让数值量级可信，
 * 而不是伪造某台具体机器 —— 遥测里本来也没有可与之对照的硬件档案。
 */
export function buildProcessMetrics(overrides = {}, uptimeSecs = 0) {
  const src = overrides && typeof overrides === 'object' ? overrides : {}
  const pick = (key, min, max) => {
    const provided = src[key]
    if (typeof provided === 'number' && Number.isFinite(provided)) return provided
    return min + Math.floor(Math.random() * (max - min))
  }
  const cpuUsage =
    src.cpuUsage && typeof src.cpuUsage === 'object'
      ? {
          user: Number(src.cpuUsage.user) || 0,
          system: Number(src.cpuUsage.system) || 0,
        }
      : { user: pick('cpuUser', 50_000, 500_000), system: pick('cpuSystem', 15_000, 150_000) }

  const cpuPercent =
    typeof src.cpuPercent === 'number' && Number.isFinite(src.cpuPercent)
      ? src.cpuPercent
      : 0.5 + Math.random() * 4.5

  return {
    uptime: Number(src.uptime ?? uptimeSecs) || 0,
    rss: pick('rss', 300_000_000, 500_000_000),
    heapTotal: pick('heapTotal', 40_000_000, 80_000_000),
    heapUsed: pick('heapUsed', 100_000_000, 200_000_000),
    external: pick('external', 1_000_000, 3_000_000),
    arrayBuffers: pick('arrayBuffers', 10_000, 50_000),
    constrainedMemory: Number(src.constrainedMemory) || 0,
    cpuUsage,
    cpuPercent: Number(cpuPercent.toFixed(4)),
  }
}

/** 进程块编码：JSON → base64（与官方一致） */
export function encodeProcess(metrics, uptimeSecs = 0) {
  const body = metrics && typeof metrics === 'object' ? metrics : buildProcessMetrics({}, uptimeSecs)
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64')
}

/** 解码进程块（测试与自检用） */
export function decodeProcess(encoded) {
  try {
    return JSON.parse(Buffer.from(String(encoded || ''), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/** additional_metadata 编码：JSON → base64（与官方一致） */
export function encodeAdditional(additional) {
  const obj = additional && typeof additional === 'object' ? additional : {}
  if (Object.keys(obj).length === 0) return null
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
}

/** 解码 additional_metadata */
export function decodeAdditional(encoded) {
  try {
    return JSON.parse(Buffer.from(String(encoded || ''), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function str(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 账号块：只有存在 account / organization 时才出现。
 * 官方在两者都为空时完全不输出 auth 键。
 */
export function buildAuthBlock(ctx = {}) {
  const account = str(ctx.accountUuid).trim()
  const org = str(ctx.orgUuid || ctx.organizationUuid).trim()
  const auth = {}
  if (account) auth.account_uuid = account
  if (org) auth.organization_uuid = org
  return Object.keys(auth).length > 0 ? auth : null
}

/**
 * 核心字段：所有事件共享的身份与会话信息。
 * 只附加非空项 —— 官方用条件展开，空值不进对象。
 */
function buildCoreFields(ctx = {}, isInteractive) {
  const core = {
    session_id: str(ctx.sessionId).trim(),
    model: str(ctx.model).trim() || DEFAULT_MODEL,
    user_type: str(ctx.userType).trim() || DEFAULT_USER_TYPE,
    is_interactive: Boolean(isInteractive),
    client_type: str(ctx.clientType).trim() || DEFAULT_CLIENT_TYPE,
  }
  if (ctx.betas) core.betas = Array.isArray(ctx.betas) ? ctx.betas.join(',') : str(ctx.betas)
  if (ctx.entrypoint) core.entrypoint = str(ctx.entrypoint)
  if (ctx.agentSdkVersion) core.agent_sdk_version = str(ctx.agentSdkVersion)
  if (ctx.agentId) core.agent_id = str(ctx.agentId)
  if (ctx.parentSessionId) core.parent_session_id = str(ctx.parentSessionId)
  if (ctx.agentType) core.agent_type = str(ctx.agentType)
  if (ctx.teamName) core.team_name = str(ctx.teamName)
  return core
}

/**
 * 组装单个事件信封。
 *
 * `attachProcess` 由调用方决定：启动事件不带进程块（官方在 init 阶段还没有
 * 可比对的基线），其余事件都带。
 */
export function buildEvent(ctx = {}, options = {}) {
  const {
    eventName,
    isInteractive = true,
    attachProcess = true,
    additional = null,
    now,
    skillName,
    pluginName,
    marketplaceName,
  } = options

  const name = str(eventName).trim()
  if (!name) throw new Error('eventName is required')

  const env =
    ctx.env && typeof ctx.env === 'object' ? ctx.env : buildTelemetryEnv(ctx.envInput || ctx)

  const eventData = {}

  // ── 身份字段 ──
  eventData.event_id = isEventId(ctx.eventId) ? String(ctx.eventId).toLowerCase() : newEventId()
  eventData.event_name = name
  eventData.client_timestamp = formatTimestamp(now ?? ctx.now)
  eventData.device_id = resolveDeviceId(ctx.deviceId, ctx.userId)
  if (ctx.email) eventData.email = str(ctx.email)
  const auth = buildAuthBlock(ctx)
  if (auth) eventData.auth = auth

  // ── 核心字段 ──
  Object.assign(eventData, buildCoreFields(ctx, isInteractive))

  // ── 环境与进程 ──
  eventData.env = env
  if (attachProcess) {
    eventData.process =
      typeof ctx.process === 'string'
        ? ctx.process
        : encodeProcess(ctx.processMetrics || ctx.process, ctx.uptimeSecs || 0)
  }

  // ── 工具命名槽位 ──
  if (skillName) eventData.skill_name = str(skillName)
  if (pluginName) eventData.plugin_name = str(pluginName)
  if (marketplaceName) eventData.marketplace_name = str(marketplaceName)

  // ── 附加元数据 ──
  const encodedAdditional = encodeAdditional(additional)
  if (encodedAdditional) eventData.additional_metadata = encodedAdditional

  // ── 重排到线上键序 ──
  // 组装顺序按语义写最清楚，但线上发出的是重排后的顺序。
  // 这里统一过一次重排，保证两者一致。
  return { event_type: OFFICIAL_EVENT_TYPE, event_data: orderEventData(eventData) }
}

/**
 * 启动事件。
 * 官方初始化阶段上报一次，不带进程块（此时尚无稳定基线），
 * 且 `is_interactive` 为 false —— 这是它与后续事件最容易区分的地方。
 */
export function buildStartEvent(ctx = {}) {
  return buildEvent(ctx, {
    eventName: ctx.eventName || EVENT_NAMES.START,
    isInteractive: false,
    attachProcess: false,
    now: ctx.now,
    additional: ctx.additional,
  })
}

/**
 * 请求事件。
 * 官方每次请求成功上报一次，带进程块与模型名，`is_interactive` 为 true。
 */
export function buildRequestEvent(ctx = {}) {
  return buildEvent(ctx, {
    eventName: ctx.eventName || EVENT_NAMES.REQUEST,
    isInteractive: true,
    attachProcess: true,
    now: ctx.now,
    additional: ctx.additional,
  })
}

/**
 * 工具使用事件。
 * 工具名走 additional_metadata（官方工具事件的上下文都在这里）。
 */
export function buildToolEvent(ctx = {}) {
  const additional = { ...(ctx.additional || {}) }
  const toolName = str(ctx.toolName).trim()
  if (toolName) additional.tool_name = toolName
  if (ctx.durationMs !== undefined) additional.duration_ms = Number(ctx.durationMs) || 0
  if (ctx.toolInputSize !== undefined) additional.tool_input_size = Number(ctx.toolInputSize) || 0

  return buildEvent(ctx, {
    eventName: ctx.eventName || (ctx.isError ? EVENT_NAMES.TOOL_ERROR : EVENT_NAMES.TOOL),
    isInteractive: true,
    attachProcess: true,
    now: ctx.now,
    additional,
  })
}

/**
 * 错误事件。
 * 错误类型与状态码进 additional_metadata；不写错误原文（原文可能带路径）。
 */
export function buildErrorEvent(ctx = {}) {
  const additional = { ...(ctx.additional || {}) }
  if (ctx.errorType) additional.error_type = str(ctx.errorType)
  if (ctx.httpStatus !== undefined) {
    const status = Number(ctx.httpStatus)
    additional.http_status = String(status)
    if (status >= 100 && status <= 599) {
      additional.http_status_range = `${String(status).charAt(0)}xx`
    }
  }
  if (ctx.retryAttempt !== undefined) additional.retry_attempt = Number(ctx.retryAttempt) || 0

  return buildEvent(ctx, {
    eventName: ctx.eventName || EVENT_NAMES.ERROR,
    isInteractive: true,
    attachProcess: true,
    now: ctx.now,
    additional,
  })
}

/**
 * 批量信封：`{ events: [...] }`。
 * 单批上限 200（官方默认），超出截断；切分由发送器按批循环。
 */
export function buildEventBatch(events, options = {}) {
  const list = Array.isArray(events) ? events.filter(Boolean) : []
  const maxSize = Number(options.maxBatchSize) || TELEMETRY_LIMITS.maxBatchSize
  return { events: list.slice(0, maxSize) }
}

/**
 * 事件结构校验：确认字段集合、类型、时间与 ID 格式都合规。
 */
export function validateEvent(event) {
  const problems = []
  const envelope = event && typeof event === 'object' ? event : {}
  if (envelope.event_type !== OFFICIAL_EVENT_TYPE) problems.push('event_type')
  const data = envelope.event_data
  if (!data || typeof data !== 'object') {
    return { ok: false, problems: [...problems, 'event_data'] }
  }
  if (!isEventId(data.event_id)) problems.push('event_id')
  if (!str(data.event_name).trim()) problems.push('event_name')
  if (!isWireTimestamp(data.client_timestamp)) problems.push('client_timestamp')
  if (!isDeviceId(data.device_id)) problems.push('device_id')
  if (typeof data.is_interactive !== 'boolean') problems.push('is_interactive')
  if (!data.env || typeof data.env !== 'object') problems.push('env')
  if (!str(data.session_id).trim()) problems.push('session_id')
  if (data.process !== undefined) {
    if (typeof data.process !== 'string') problems.push('process')
    else if (!decodeProcess(data.process)) problems.push('process-base64')
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 按线上键序重排 event_data。未登记的键丢弃 —— 自行发明的键是特征。
 */
export function orderEventData(data) {
  const source = data && typeof data === 'object' ? data : {}
  const out = {}
  for (const key of EVENT_DATA_KEY_ORDER) {
    if (!Object.hasOwn(source, key)) continue
    if (source[key] === undefined) continue
    out[key] = source[key]
  }
  return out
}

/**
 * 键序检查：返回与官方顺序不一致的键，供自检使用。
 */
export function checkEventKeyOrder(data) {
  const keys = Object.keys(data && typeof data === 'object' ? data : {})
  const known = new Set(EVENT_DATA_KEY_ORDER)
  const unknown = keys.filter((k) => !known.has(k))
  const ordered = keys.filter((k) => known.has(k))
  const expected = EVENT_DATA_KEY_ORDER.filter((k) => ordered.includes(k))
  return {
    ok: unknown.length === 0 && ordered.join(',') === expected.join(','),
    unknown,
    actual: ordered,
    expected,
  }
}
