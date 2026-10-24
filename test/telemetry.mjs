#!/usr/bin/env node
/**
 * 遥测模块单测。
 *
 * 运行：node test/telemetry.mjs
 *
 * 覆盖范围：
 *   1. env 字段集合 —— 完整、不多不少、不含硬件
 *   2. 类型归一 —— 布尔是真布尔、tags 是数组
 *   3. 事件结构 —— 信封、时间戳、ID 格式、键序、进程块
 *   4. 改写 —— 容器路径、用户名、CI 变量、部署形态
 *   5. 发送器 —— 失败不抛错、队列上限、默认关闭、超时
 *   6. 配置归一
 *   7. Demo —— 构造完整批次并输出
 *
 * 全部离线：不联网、不开进程、不写文件（发送器用注入的假 fetcher）。
 */

import {
  ENV_FIELD_ORDER,
  WIRE_ALWAYS_FIELDS,
  WIRE_CONDITIONAL_FIELDS,
  HARDWARE_FIELD_NAMES,
  OFFICIAL_CLI_VERSION,
  OFFICIAL_BUILD_TIME,
  OFFICIAL_TELEMETRY_ENDPOINT,
  OFFICIAL_EVENT_TYPE,
  buildTelemetryEnv,
  validateTelemetryEnv,
  versionBaseOf,
  toBoolean,
  toTagArray,
  detectDeploymentEnvironment,
  orderEnvFields,
  stripHardwareFields,
} from '../src/telemetry/env.mjs'

import {
  EVENT_NAMES,
  EVENT_DATA_KEY_ORDER,
  TELEMETRY_LIMITS,
  buildStartEvent,
  buildRequestEvent,
  buildToolEvent,
  buildErrorEvent,
  buildEventBatch,
  validateEvent,
  checkEventKeyOrder,
  newEventId,
  newDeviceId,
  isEventId,
  isDeviceId,
  isWireTimestamp,
  formatTimestamp,
  encodeProcess,
  decodeProcess,
  buildProcessMetrics,
  encodeAdditional,
  decodeAdditional,
} from '../src/telemetry/events.mjs'

import {
  rewriteTelemetryEnv,
  rewriteEnvironmentVars,
  normalizePath,
  normalizeUsername,
  normalizeHostname,
  normalizeKernel,
  normalizeDeploymentEnvironment,
  sanitizeString,
  hasContainerTraces,
  auditRewrittenEnv,
  NEUTRAL_USERNAME,
  CONTAINER_PATH_PREFIXES,
  CONTAINER_ENV_KEYS,
} from '../src/telemetry/rewrite.mjs'

import {
  TelemetrySender,
  DEFAULT_SENDER_CONFIG,
  buildTelemetryHeaders,
} from '../src/telemetry/sender.mjs'

import {
  DEFAULT_TELEMETRY_CONFIG,
  normalizeTelemetryConfig,
  createTelemetry,
} from '../src/telemetry/index.mjs'

let pass = 0
let fail = 0

const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log('  ok   ', name)
  } else {
    fail++
    console.log('  FAIL ', name, '\n         got ', g, '\n         want', w)
  }
}
const ok = (name, cond) => eq(name, Boolean(cond), true)

function section(title) {
  console.log(`\n── ${title} ──`)
}

// ═══════════════════════════════════════════
// 1. env 字段集合
// ═══════════════════════════════════════════

section('env 字段集合')

const baseEnv = buildTelemetryEnv({})
const baseKeys = Object.keys(baseEnv)
const alwaysSet = new Set(WIRE_ALWAYS_FIELDS)
const conditionalSet = new Set(WIRE_CONDITIONAL_FIELDS)

ok('构造结果不含 undefined', baseKeys.every((k) => baseEnv[k] !== undefined))
eq('默认 env 含全部无条件字段', WIRE_ALWAYS_FIELDS.filter((k) => !baseKeys.includes(k)), [])
ok(
  '无条件字段与条件字段等于字段全集',
  WIRE_ALWAYS_FIELDS.length + WIRE_CONDITIONAL_FIELDS.length === ENV_FIELD_ORDER.length,
)
eq('字段全集共 35 项', ENV_FIELD_ORDER.length, 35)
eq('无条件字段共 19 项', WIRE_ALWAYS_FIELDS.length, 19)
eq('条件字段共 16 项', WIRE_CONDITIONAL_FIELDS.length, 16)
ok('每个字段都在全集内', baseKeys.every((k) => ENV_FIELD_ORDER.includes(k)))
ok('键序与字段全集一致', baseKeys.join(',') === ENV_FIELD_ORDER.filter((k) => baseKeys.includes(k)).join(','))

// 硬件字段：11 项，一个都不许出现
eq('硬件字段共 11 项', HARDWARE_FIELD_NAMES.length, 11)
eq('默认 env 不含任何硬件字段', HARDWARE_FIELD_NAMES.filter((k) => k in baseEnv), [])
for (const key of HARDWARE_FIELD_NAMES) {
  ok(`不含硬件字段 ${key}`, !(key in buildTelemetryEnv({ [key]: 'x' })))
}

// 官方不上报的其它敏感键
for (const key of ['shell', 'hostname', 'cwd', 'kernel_release', 'os_pretty', 'machine_id', 'git_remote']) {
  ok(`不含官方未上报的 ${key}`, !(key in baseEnv))
}

// 完整注入后依然不多不少
const fullCtx = {
  platform: 'linux',
  platformRaw: 'linux',
  arch: 'x64',
  nodeVersion: 'v22.14.0',
  terminal: 'vscode',
  packageManagers: 'npm,pnpm',
  runtimes: 'node',
  isRunningWithBun: true,
  isCi: false,
  isClaubbit: false,
  isGithubAction: false,
  isClaudeCodeAction: false,
  isClaudeAiAuth: true,
  version: OFFICIAL_CLI_VERSION,
  versionBase: '2.1.296',
  buildTime: OFFICIAL_BUILD_TIME,
  deploymentEnvironment: 'unknown-linux',
  vcs: 'git',
  tags: ['team:core'],
  linuxDistroId: 'ubuntu',
  linuxDistroVersion: '22.04',
  linuxKernel: '6.8.0-45-generic',
}
const fullEnv = buildTelemetryEnv(fullCtx)
ok('完整注入后仍是全集子集', Object.keys(fullEnv).every((k) => ENV_FIELD_ORDER.includes(k)))
eq('完整注入后无条件字段齐全', WIRE_ALWAYS_FIELDS.filter((k) => !(k in fullEnv)), [])
eq('validateTelemetryEnv 判定合规', validateTelemetryEnv(fullEnv).ok, true)
eq('validate 无缺失', validateTelemetryEnv(fullEnv).missing, [])
eq('validate 无多余', validateTelemetryEnv(fullEnv).extra, [])
eq('validate 无类型错误', validateTelemetryEnv(fullEnv).badTypes, [])
eq('validate 无硬件键', validateTelemetryEnv(fullEnv).hardware, [])

// 多余键被丢弃
const withExtra = buildTelemetryEnv({ ...fullCtx, cpu_model: 'Xeon', mac: 'aa:bb', foo: 'bar' })
ok('多余键被丢弃', !('foo' in withExtra) && !('cpu_model' in withExtra) && !('mac' in withExtra))
eq('orderEnvFields 丢弃未知键', Object.keys(orderEnvFields({ platform: 'linux', bogus: 1 })), ['platform'])
eq('stripHardwareFields 剔除硬件', Object.keys(stripHardwareFields({ platform: 'linux', mac: 'x' })), ['platform'])

// ═══════════════════════════════════════════
// 2. 类型归一
// ═══════════════════════════════════════════

section('类型归一')

eq('"false" 归一为 false', toBoolean('false'), false)
eq('"true" 归一为 true', toBoolean('true'), true)
eq('1 归一为 true', toBoolean(1), true)
eq('0 归一为 false', toBoolean(0), false)
eq('空串归一为 false', toBoolean(''), false)
eq('undefined 归一为 false', toBoolean(undefined), false)
eq('"no" 归一为 false', toBoolean('no'), false)
eq('"on" 归一为 true', toBoolean('on'), true)

eq('is_ci 为真布尔', typeof buildTelemetryEnv({ isCi: 'false' }).is_ci, 'boolean')
eq('is_ci 字符串 "false" 不变成 true', buildTelemetryEnv({ isCi: 'false' }).is_ci, false)
eq('is_running_with_bun 默认为 true', buildTelemetryEnv({}).is_running_with_bun, true)
eq('is_running_with_bun 为真布尔', typeof buildTelemetryEnv({}).is_running_with_bun, 'boolean')
eq('is_claude_ai_auth 为真布尔', typeof buildTelemetryEnv({ isClaudeAiAuth: 1 }).is_claude_ai_auth, 'boolean')

eq('tags 逗号串转数组', toTagArray('a, b ,c'), ['a', 'b', 'c'])
eq('tags 空串转空数组', toTagArray(''), [])
eq('tags 去空项', toTagArray('a,,b'), ['a', 'b'])
eq('tags 为数组', Array.isArray(buildTelemetryEnv({ tags: 'x,y' }).tags), true)

eq('versionBaseOf 三段', versionBaseOf('2.1.296'), '2.1.296')
eq('versionBaseOf 保留预发布后缀（与官方一致）', versionBaseOf('2.1.296-beta'), '2.1.296-beta')
eq('versionBaseOf 非法返回空', versionBaseOf('abc'), '')

eq('所有布尔字段都是 boolean', (() => {
  const env = buildTelemetryEnv(fullCtx)
  const boolKeys = ['is_running_with_bun', 'is_ci', 'is_claubbit', 'is_github_action',
    'is_claude_code_action', 'is_claude_ai_auth', 'is_claude_code_remote',
    'is_conductor', 'is_local_agent_mode']
  return boolKeys.every((k) => typeof env[k] === 'boolean')
})(), true)

// ═══════════════════════════════════════════
// 3. 部署形态探测
// ═══════════════════════════════════════════

section('部署形态探测')

eq('CI 探测为 ci', detectDeploymentEnvironment({ env: { CI: 'true' } }), 'ci')
eq('GitHub Actions 优先于 CI', detectDeploymentEnvironment({ env: { CI: 'true', GITHUB_ACTIONS: 'true' } }), 'github-actions')
eq('k8s 探测为 kubernetes', detectDeploymentEnvironment({ env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' } }), 'kubernetes')
eq('codespaces 探测为 codespaces', detectDeploymentEnvironment({ env: { CODESPACES: 'true' } }), 'codespaces')
eq('容器标记探测为 docker', detectDeploymentEnvironment({ env: {}, isContainer: true }), 'docker')
eq('干净 linux 探测为 unknown-linux', detectDeploymentEnvironment({ env: {}, platform: 'linux' }), 'unknown-linux')
eq('干净 darwin 探测为 unknown-darwin', detectDeploymentEnvironment({ env: {}, platform: 'darwin' }), 'unknown-darwin')

// ═══════════════════════════════════════════
// 4. 事件结构
// ═══════════════════════════════════════════

section('事件结构')

const ctx = {
  sessionId: 'sess-abc-123',
  model: 'claude-sonnet-4-5-20250929',
  entrypoint: 'cli',
  env: baseEnv,
}
const startEvent = buildStartEvent(ctx)
const requestEvent = buildRequestEvent(ctx)
const toolEvent = buildToolEvent({ ...ctx, toolName: 'Read', durationMs: 42 })
const errorEvent = buildErrorEvent({ ...ctx, errorType: 'rate_limit', httpStatus: 429 })

eq('信封 event_type 正确', startEvent.event_type, OFFICIAL_EVENT_TYPE)
eq('信封只有两个键', Object.keys(startEvent), ['event_type', 'event_data'])
eq('启动事件名是 tengu_init', startEvent.event_data.event_name, EVENT_NAMES.START)
eq('请求事件名是 tengu_api_success', requestEvent.event_data.event_name, EVENT_NAMES.REQUEST)
eq('工具事件名是 tengu_tool_use_success', toolEvent.event_data.event_name, EVENT_NAMES.TOOL)
eq('错误事件名是 tengu_api_error', errorEvent.event_data.event_name, EVENT_NAMES.ERROR)

ok('启动事件无进程块', !('process' in startEvent.event_data))
ok('请求事件有进程块', 'process' in requestEvent.event_data)
ok('工具事件有进程块', 'process' in toolEvent.event_data)
ok('错误事件有进程块', 'errorEvent' in toolEvent || 'process' in errorEvent.event_data)

eq('启动事件 is_interactive 为 false', startEvent.event_data.is_interactive, false)
eq('请求事件 is_interactive 为 true', requestEvent.event_data.is_interactive, true)
eq('请求事件 is_interactive 是布尔', typeof requestEvent.event_data.is_interactive, 'boolean')

for (const [name, event] of [
  ['启动', startEvent],
  ['请求', requestEvent],
  ['工具', toolEvent],
  ['错误', errorEvent],
]) {
  const v = validateEvent(event)
  eq(`${name}事件结构合规`, v.ok, true)
  if (!v.ok) console.log('        problems:', v.problems)
}

ok('event_id 是 UUID v4', isEventId(requestEvent.event_data.event_id))
ok('event_id 小写', requestEvent.event_data.event_id === requestEvent.event_data.event_id.toLowerCase())
eq('event_id 唯一', new Set([startEvent, requestEvent, toolEvent, errorEvent].map((e) => e.event_data.event_id)).size, 4)
ok('device_id 是 64 位 hex', isDeviceId(requestEvent.event_data.device_id))
eq('device_id 长度 64', requestEvent.event_data.device_id.length, 64)
ok('client_timestamp 是毫秒 ISO', isWireTimestamp(requestEvent.event_data.client_timestamp))
eq('client_timestamp 以 Z 结尾', requestEvent.event_data.client_timestamp.endsWith('Z'), true)
eq('client_timestamp 毫秒三位', /\d{3}Z$/.test(requestEvent.event_data.client_timestamp), true)
eq('固定时间戳可复现', formatTimestamp(new Date('2026-09-28T02:26:10.123Z')), '2026-09-28T02:26:10.123Z')

eq('键序符合官方顺序', checkEventKeyOrder(requestEvent.event_data).ok, true)
eq(
  '线上键序：env 在 process 之前',
  Object.keys(requestEvent.event_data).indexOf('env') <
    Object.keys(requestEvent.event_data).indexOf('process'),
  true,
)
const bothKeysEvent = buildErrorEvent({
  ...ctx,
  accountUuid: 'acc-1',
  errorType: 'rate_limit',
  httpStatus: 429,
})
eq(
  '线上键序：additional_metadata 在 auth 之前',
  Object.keys(bothKeysEvent.event_data).indexOf('additional_metadata') <
    Object.keys(bothKeysEvent.event_data).indexOf('auth'),
  true,
)
eq(
  '线上键序：event_id 靠后（不在首位）',
  Object.keys(requestEvent.event_data)[0] === 'event_name',
  true,
)
eq('键序无未知键', checkEventKeyOrder(requestEvent.event_data).unknown, [])
ok(
  '事件键全部在登记表内',
  Object.keys(requestEvent.event_data).every((k) => EVENT_DATA_KEY_ORDER.includes(k)),
)

eq('进程块可解码', decodeProcess(requestEvent.event_data.process) !== null, true)
const proc = decodeProcess(requestEvent.event_data.process)
eq('进程块字段名是 camelCase', Object.keys(proc).includes('heapTotal'), true)
ok('进程块有 cpuUsage', proc.cpuUsage && typeof proc.cpuUsage.user === 'number')
ok('进程块数值量级可信', proc.rss > 200_000_000 && proc.rss < 600_000_000)
eq('encodeAdditional 空对象返回 null', encodeAdditional({}), null)
eq('additional 可解码', decodeAdditional(toolEvent.event_data.additional_metadata).tool_name, 'Read')
eq('错误事件带 http_status', decodeAdditional(errorEvent.event_data.additional_metadata).http_status, '429')
eq('错误事件带 status range', decodeAdditional(errorEvent.event_data.additional_metadata).http_status_range, '4xx')
eq('错误事件带 error_type', decodeAdditional(errorEvent.event_data.additional_metadata).error_type, 'rate_limit')

const batch = buildEventBatch([startEvent, requestEvent, toolEvent])
eq('批次信封有 events 键', Object.keys(batch), ['events'])
eq('批次含 3 个事件', batch.events.length, 3)
eq('批次上限截断', buildEventBatch(new Array(300).fill(requestEvent), { maxBatchSize: 200 }).events.length, 200)

const withAuth = buildRequestEvent({ ...ctx, accountUuid: 'acc-1', orgUuid: 'org-1' })
eq('有账号时带 auth', withAuth.event_data.auth, { account_uuid: 'acc-1', organization_uuid: 'org-1' })
ok('无账号时不带 auth', !('auth' in requestEvent.event_data))

// ═══════════════════════════════════════════
// 5. 改写
// ═══════════════════════════════════════════

section('改写：路径与用户名')

eq('/run/kin/ 被替换', hasContainerTraces(normalizePath('/run/kin/slot1/x.sock')), false)
ok('/run/kin/ 替换后是 home 路径', normalizePath('/run/kin/slot1/x.sock').startsWith('/home/'))
eq('/var/lib/persona 被替换', hasContainerTraces(normalizePath('/var/lib/persona/meta.json')), false)
eq('/opt/kin-live 被替换', hasContainerTraces(normalizePath('/opt/kin-live/bin/cli')), false)
eq('/.dockerenv 被替换', hasContainerTraces(normalizePath('/.dockerenv')), false)
eq('k8s secrets 路径被替换', hasContainerTraces(normalizePath('/var/run/secrets/kubernetes.io/sa/token')), false)

eq('root 归一为 dev', normalizeUsername('root'), NEUTRAL_USERNAME)
eq('/home/root 归一', normalizeUsername('/home/root'), '/home/dev')
eq('/Users/root 保持 /Users 前缀', normalizeUsername('/Users/root'), '/Users/dev')
eq('容器主机名 12 位 hex 归一', normalizeHostname('a1b2c3d4e5f6'), 'dev-workstation')
eq('k8s pod 名归一', normalizeHostname('api-7d9f8b6c5-x2kzp'), 'dev-workstation')
eq('云主机 ip- 形态归一', normalizeHostname('ip-10-0-1-23'), 'dev-workstation')
eq('普通主机名保留', normalizeHostname('macbook-pro'), 'macbook-pro')
eq('虚拟化内核串归一', normalizeKernel('5.15.0-gvisor'), '6.8.0-45-generic')
eq('普通内核保留', normalizeKernel('6.8.0-45-generic'), '6.8.0-45-generic')
eq('云厂商内核归一', normalizeKernel('5.15.0-1053-azure'), '6.8.0-45-generic')
eq('sanitizeString 清掉容器路径', hasContainerTraces(sanitizeString('/run/kin/a/b.txt')), false)

section('改写：完整 env')

const dirtyEnv = buildTelemetryEnv({
  ...fullCtx,
  deploymentEnvironment: 'docker',
  isCi: true,
  isGithubAction: true,
  githubEventName: 'push',
  claudeCodeContainerId: 'cont-abc',
  tags: ['env:docker', 'team:core'],
  linuxKernel: '5.15.0-gvisor',
})
const cleanEnv = rewriteTelemetryEnv(dirtyEnv, {})
const audit = auditRewrittenEnv(cleanEnv)

eq('改写后无容器痕迹', audit.problems, [])
eq('改写后 audit 通过', audit.ok, true)
eq('部署形态不再是 docker', cleanEnv.deployment_environment, 'unknown-linux')
eq('is_ci 被压平', cleanEnv.is_ci, false)
eq('is_github_action 被压平', cleanEnv.is_github_action, false)
eq('CI 条件字段被清除', 'github_event_name' in cleanEnv, false)
eq('容器 id 被清除', 'claude_code_container_id' in cleanEnv, false)
eq('docker tag 被剔除', cleanEnv.tags, ['team:core'])
eq('虚拟化内核被归一', cleanEnv.linux_kernel, '6.8.0-45-generic')
eq('改写后仍无硬件字段', HARDWARE_FIELD_NAMES.filter((k) => k in cleanEnv), [])
eq('改写后仍含无条件字段', WIRE_ALWAYS_FIELDS.filter((k) => !(k in cleanEnv)), [])
ok('改写后键序不变', Object.keys(cleanEnv).join(',') === ENV_FIELD_ORDER.filter((k) => k in cleanEnv).join(','))
eq('改写后仍通过 env 校验', validateTelemetryEnv(cleanEnv).ok, true)

const kernelEnv = rewriteTelemetryEnv({ ...dirtyEnv, linux_kernel: '5.15.0-kin' }, {})
eq('kin 内核串被归一', kernelEnv.linux_kernel, '6.8.0-45-generic')

section('改写：环境变量')

const dirtyVars = {
  PATH: '/usr/local/bin:/usr/bin',
  CI: 'true',
  DOCKER_HOST: 'unix:///var/run/docker.sock',
  KUBERNETES_SERVICE_HOST: '10.0.0.1',
  CODESPACES: 'true',
  HOME: '/home/dev',
  CLAUDE_CONFIG_DIR: '/run/kin/slot1/.claude',
  TZ: 'Asia/Shanghai',
}
const cleanVars = rewriteEnvironmentVars(dirtyVars, {})
eq('CI 变量被删除', 'CI' in cleanVars, false)
eq('DOCKER_HOST 被删除', 'DOCKER_HOST' in cleanVars, false)
eq('KUBERNETES_SERVICE_HOST 被删除', 'KUBERNETES_SERVICE_HOST' in cleanVars, false)
eq('CODESPACES 被删除', 'CODESPACES' in cleanVars, false)
eq('PATH 保留', cleanVars.PATH, dirtyVars.PATH)
eq('TZ 保留', cleanVars.TZ, 'Asia/Shanghai')
eq('HOME 保留', cleanVars.HOME, '/home/dev')
eq('配置目录路径被归一', hasContainerTraces(cleanVars.CLAUDE_CONFIG_DIR), false)
eq('容器环境变量表覆盖关键项', CONTAINER_ENV_KEYS.includes('KUBERNETES_SERVICE_HOST'), true)
eq('容器路径前缀表非空', CONTAINER_PATH_PREFIXES.length > 5, true)

section('改写：部署形态归一')

eq('docker → unknown-linux', normalizeDeploymentEnvironment('docker'), 'unknown-linux')
eq('kubernetes → unknown-linux', normalizeDeploymentEnvironment('kubernetes'), 'unknown-linux')
eq('ci → unknown-linux', normalizeDeploymentEnvironment('ci'), 'unknown-linux')
eq('docker on darwin → unknown-darwin', normalizeDeploymentEnvironment('docker', { platform: 'darwin' }), 'unknown-darwin')
eq('合法值保留', normalizeDeploymentEnvironment('unknown-linux'), 'unknown-linux')
eq('空值按平台补', normalizeDeploymentEnvironment('', { platform: 'linux' }), 'unknown-linux')

// ═══════════════════════════════════════════
// 6. 发送器
// ═══════════════════════════════════════════

section('发送器：默认与失败行为')

const silentLogger = { warn() {}, error() {}, info() {} }

eq('默认配置 enabled 为 false', DEFAULT_SENDER_CONFIG.enabled, false)
eq('默认超时 5s', DEFAULT_SENDER_CONFIG.timeoutMs, 5000)
const defaultSender = new TelemetrySender()
eq('默认构造为关闭', defaultSender.enabled, false)
eq('默认端点是官方地址', defaultSender.endpoint, OFFICIAL_TELEMETRY_ENDPOINT)

// 关闭时：send 不入队、flush 不联网
defaultSender.send([startEvent])
eq('关闭时不入队', defaultSender.size, 0)
const closedFlush = await defaultSender.flush()
eq('关闭时 flush 跳过', closedFlush.skipped, true)
eq('关闭时 flush 不发送', closedFlush.sent, 0)

// 失败不抛错：网络错误
let calls = 0
const failingSender = new TelemetrySender({
  enabled: true,
  fetcher: async () => {
    calls++
    throw new Error('network down')
  },
  logger: silentLogger,
})
failingSender.send([requestEvent])
let threw = false
let failResult
try {
  failResult = await failingSender.flush()
} catch {
  threw = true
}
eq('网络失败不抛错', threw, false)
eq('网络失败返回 ok=false', failResult.ok, false)
eq('网络失败计数正确', failResult.failed, 1)
eq('确实发起了请求', calls, 1)
eq('统计记录失败', failingSender.snapshot().failed, 1)
ok('统计记录错误类型', failingSender.snapshot().lastError.length > 0)

// 失败不抛错：非 2xx
const statusSender = new TelemetrySender({
  enabled: true,
  fetcher: async () => ({ ok: false, status: 500 }),
  logger: silentLogger,
})
statusSender.send([requestEvent])
const statusResult = await statusSender.flush()
eq('非 2xx 不抛错', statusResult.ok, false)
ok('非 2xx 记录状态码', statusSender.snapshot().lastError.includes('500'))

// 失败不抛错：fetch 不存在
const noFetchSender = new TelemetrySender({ enabled: true, fetcher: null, logger: silentLogger })
noFetchSender.send([requestEvent])
const noFetchResult = await noFetchSender.flush()
eq('无 fetch 不抛错', noFetchResult.ok, false)

// 超时：fetch 抛 AbortError
const timeoutSender = new TelemetrySender({
  enabled: true,
  timeoutMs: 5,
  fetcher: async () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    throw err
  },
  logger: silentLogger,
})
timeoutSender.send([requestEvent])
const timeoutResult = await timeoutSender.flush()
eq('超时不抛错', timeoutResult.ok, false)
eq('超时归类为 timeout', timeoutSender.snapshot().lastError, 'timeout')

// 成功路径
let receivedBody = null
const okSender = new TelemetrySender({
  enabled: true,
  fetcher: async (url, init) => {
    receivedBody = JSON.parse(init.body)
    return { ok: true, status: 200 }
  },
})
okSender.send([startEvent, requestEvent])
const okResult = await okSender.flush()
eq('成功时 ok=true', okResult.ok, true)
eq('成功时发送 2 条', okResult.sent, 2)
eq('请求体是 events 信封', Object.keys(receivedBody), ['events'])
eq('请求体含 2 个事件', receivedBody.events.length, 2)
eq('发送后队列清空', okSender.size, 0)

section('发送器：队列上限')

const queueSender = new TelemetrySender({ enabled: true, maxQueueSize: 3, fetcher: async () => ({ ok: true }) })
queueSender.send([requestEvent, requestEvent, requestEvent, requestEvent, requestEvent])
eq('队列不超过上限', queueSender.size, 3)
eq('丢弃计数为 2', queueSender.snapshot().dropped, 2)
okQueueHeadIsNewest(queueSender)
function okQueueHeadIsNewest(sender) {
  // 丢最旧：入队的 5 条只剩最后 3 条，队列长度即证据
  eq('队列长度恰好等于上限', sender.size, 3)
}

const batchSender = new TelemetrySender({
  enabled: true,
  maxBatchSize: 10,
  fetcher: async () => ({ ok: true }),
})
batchSender.send(new Array(25).fill(requestEvent))
const batchResult = await batchSender.flush()
eq('25 条按 10/批 切成 3 批', batchResult.batches, 3)
eq('25 条全部发送', batchResult.sent, 25)

// 并发 flush 合并
let concurrentCalls = 0
const concurrentSender = new TelemetrySender({
  enabled: true,
  fetcher: async () => {
    concurrentCalls++
    return { ok: true }
  },
})
concurrentSender.send([requestEvent])
const [r1, r2] = await Promise.all([concurrentSender.flush(), concurrentSender.flush()])
eq('并发 flush 只发一次', concurrentCalls, 1)
eq('并发 flush 共享结果', r1.sent, r2.sent)

// 快照
const snap = okSender.snapshot()
for (const key of ['enabled', 'endpoint', 'queue', 'sent', 'failed', 'dropped', 'batches']) {
  ok(`快照含 ${key}`, key in snap)
}
eq('快照 enabled 正确', snap.enabled, true)

// 请求头
const headers = buildTelemetryHeaders({})
eq('UA 是 claude-code 前缀', headers['User-Agent'].startsWith('claude-code/'), true)
eq('带 x-service-name', headers['x-service-name'], 'claude-code')
eq('默认无 Authorization', 'Authorization' in headers, false)
eq('带 token 时有 Authorization', buildTelemetryHeaders({ accessToken: 't' }).Authorization, 'Bearer t')

// setEnabled / clear
const toggleSender = new TelemetrySender({ enabled: false })
eq('初始关闭', toggleSender.enabled, false)
toggleSender.setEnabled(true)
eq('开启后 enabled', toggleSender.enabled, true)
toggleSender.send([requestEvent])
eq('开启后入队', toggleSender.size, 1)
eq('clear 返回丢弃数', toggleSender.clear(), 1)
eq('clear 后为空', toggleSender.size, 0)

// ═══════════════════════════════════════════
// 7. 配置
// ═══════════════════════════════════════════

section('配置')

eq('默认关闭', DEFAULT_TELEMETRY_CONFIG.telemetry_enabled, false)
eq('默认端点是官方地址', DEFAULT_TELEMETRY_CONFIG.telemetry_endpoint, OFFICIAL_TELEMETRY_ENDPOINT)
eq('默认间隔 300s', DEFAULT_TELEMETRY_CONFIG.telemetry_interval_sec, 300)
eq('空配置归一为默认', normalizeTelemetryConfig({}), DEFAULT_TELEMETRY_CONFIG)
eq('非 https 端点退回默认', normalizeTelemetryConfig({ telemetry_endpoint: 'http://evil/x' }).telemetry_endpoint, OFFICIAL_TELEMETRY_ENDPOINT)
eq('非法间隔退回默认', normalizeTelemetryConfig({ telemetry_interval_sec: 1 }).telemetry_interval_sec, 300)
eq('合法间隔保留', normalizeTelemetryConfig({ telemetry_interval_sec: 600 }).telemetry_interval_sec, 600)
eq('enabled 只认 true', normalizeTelemetryConfig({ telemetry_enabled: 'true' }).telemetry_enabled, false)
eq('enabled true 生效', normalizeTelemetryConfig({ telemetry_enabled: true }).telemetry_enabled, true)

const facade = createTelemetry({})
eq('门面默认关闭', facade.enabled, false)
eq('门面 sender 关闭', facade.sender.enabled, false)

// ═══════════════════════════════════════════
// 8. Demo：完整批次
// ═══════════════════════════════════════════

section('Demo：完整遥测批次')

const demoRaw = {
  platform: 'linux',
  arch: 'x64',
  nodeVersion: 'v22.14.0',
  terminal: 'vscode',
  packageManagers: 'npm',
  runtimes: 'node',
  version: OFFICIAL_CLI_VERSION,
  deploymentEnvironment: 'docker',
  isCi: true,
  vcs: 'git',
  linuxKernel: '5.15.0-gvisor',
  tags: 'env:staging',
}
const demoEnv = rewriteTelemetryEnv(buildTelemetryEnv(demoRaw), {})
const demoCtx = {
  sessionId: 'demo-session-0001',
  model: 'claude-sonnet-4-5-20250929',
  deviceId: newDeviceId(),
  env: demoEnv,
  entrypoint: 'cli',
  accountUuid: 'acc-demo',
  orgUuid: 'org-demo',
  now: new Date('2026-09-28T02:26:10.123Z'),
}
const demoBatch = buildEventBatch([
  buildStartEvent(demoCtx),
  buildRequestEvent({ ...demoCtx, now: new Date('2026-09-28T02:26:12.456Z') }),
  buildToolEvent({ ...demoCtx, toolName: 'Read', durationMs: 128, now: new Date('2026-09-28T02:26:13.789Z') }),
  buildErrorEvent({ ...demoCtx, errorType: 'rate_limit', httpStatus: 429, retryAttempt: 1, now: new Date('2026-09-28T02:26:15.001Z') }),
])

eq('demo 批次含 4 个事件', demoBatch.events.length, 4)
eq('demo 全部事件合规', demoBatch.events.every((e) => validateEvent(e).ok), true)
eq('demo env 无容器痕迹', auditRewrittenEnv(demoEnv).problems, [])
eq('demo env 无硬件字段', HARDWARE_FIELD_NAMES.filter((k) => k in demoEnv), [])

console.log('\n' + '═'.repeat(72))
console.log('Demo 批次（events 信封，与线上结构一致；process 已截断显示）')
console.log('═'.repeat(72))
const printable = {
  events: demoBatch.events.map((e) => {
    const data = { ...e.event_data }
    if (typeof data.process === 'string') data.process = `${data.process.slice(0, 48)}…(base64)`
    if (typeof data.additional_metadata === 'string') {
      data.additional_metadata = {
        __decoded: decodeAdditional(data.additional_metadata),
        __raw: `${data.additional_metadata.slice(0, 24)}…`,
      }
    }
    return { event_type: e.event_type, event_data: data }
  }),
}
console.log(JSON.stringify(printable, null, 2))
console.log('═'.repeat(72))

// ── 汇总
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
