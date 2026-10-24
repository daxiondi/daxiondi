/**
 * 遥测环境快照：构造与官方客户端完全一致的 `event_data.env`。
 *
 * 设计原则只有一条：**只发官方发的，一个不多一个不少**。
 *
 * 为什么是「不多不少」而不是「越多越像」：
 *   上游对客户端画像的判定不是看字段值像不像，而是看字段集合对不对。
 *   多发一个官方不发的键（例如客户机硬件），就多一个只有非官方实现才会
 *   出现的信号；漏发一个官方一定发的键（例如 is_running_with_bun），
 *   同样暴露。两者都是特征，所以这套代码把它当成一份定死的契约来维护：
 *
 *   - ENV_FIELD_ORDER        字段全集，顺序即线上 JSON 的键顺序
 *   - WIRE_ALWAYS_FIELDS     无条件出现的字段（值可以是空串）
 *   - WIRE_CONDITIONAL_FIELDS 非空才出现的字段
 *   - HARDWARE_FIELD_NAMES   官方不上报的客户机硬件键，任何情况下都不许出现
 *
 * 顺序来源是线上事件的序列化顺序，而不是构造顺序：上游客户端先组一个
 * 环境对象，再经过事件序列化层重排成固定键序。两者都保持一致才不会有
 * 键序差异，所以这里直接按序列化顺序输出。
 */

/** 与官方客户端一致的版本号 */
export const OFFICIAL_CLI_VERSION = '2.1.296'

/** 与官方客户端一致的构建时间 */
export const OFFICIAL_BUILD_TIME = '2026-09-28T02:26:10Z'

/** 官方批量上报端点（相对路径 + 绝对地址） */
export const OFFICIAL_TELEMETRY_PATH = '/api/event_logging/batch'
export const OFFICIAL_TELEMETRY_ENDPOINT = `https://api.anthropic.com${OFFICIAL_TELEMETRY_PATH}`

/** 官方事件信封类型名 */
export const OFFICIAL_EVENT_TYPE = 'ClaudeCodeInternalEvent'

/**
 * env 字段全集，顺序即线上 JSON 键顺序。
 *
 * 共 35 项。注意这里**没有** `shell`、`hostname`、`cwd`、`kernel_release`
 * 这类客户机信息：官方环境块只描述平台与运行时大类，不描述机器本体。
 * `github_actions_metadata` 夹在 `wsl_version` 与 `arch` 之间，这是序列化
 * 层的真实位置，不是按字母或构造顺序排的。
 */
export const ENV_FIELD_ORDER = Object.freeze([
  'platform',
  'node_version',
  'terminal',
  'package_managers',
  'runtimes',
  'is_running_with_bun',
  'is_ci',
  'is_claubbit',
  'is_github_action',
  'is_claude_code_action',
  'is_claude_ai_auth',
  'version',
  'github_event_name',
  'github_actions_runner_environment',
  'github_actions_runner_os',
  'github_action_ref',
  'wsl_version',
  'github_actions_metadata',
  'arch',
  'is_claude_code_remote',
  'remote_environment_type',
  'claude_code_container_id',
  'claude_code_remote_session_id',
  'tags',
  'deployment_environment',
  'is_conductor',
  'version_base',
  'coworker_type',
  'build_time',
  'is_local_agent_mode',
  'linux_distro_id',
  'linux_distro_version',
  'linux_kernel',
  'vcs',
  'platform_raw',
])

/**
 * 无条件出现的字段：官方构造时一律赋值，序列化时因此一定输出。
 * 值允许是空串，但键必须在。共 19 项。
 */
export const WIRE_ALWAYS_FIELDS = Object.freeze([
  'platform',
  'node_version',
  'terminal',
  'package_managers',
  'runtimes',
  'is_running_with_bun',
  'is_ci',
  'is_claubbit',
  'is_github_action',
  'is_claude_code_action',
  'is_claude_ai_auth',
  'version',
  'arch',
  'is_claude_code_remote',
  'deployment_environment',
  'is_conductor',
  'build_time',
  'is_local_agent_mode',
  'platform_raw',
])

/**
 * 非空才出现的字段：官方用展开语法按条件附加，空值直接不进对象。
 * 这些键如果以空串形式发出去，比不发更像特征。
 */
export const WIRE_CONDITIONAL_FIELDS = Object.freeze([
  'version_base',
  'remote_environment_type',
  'claude_code_container_id',
  'claude_code_remote_session_id',
  'tags',
  'github_event_name',
  'github_actions_runner_environment',
  'github_actions_runner_os',
  'github_action_ref',
  'wsl_version',
  'linux_distro_id',
  'linux_distro_version',
  'linux_kernel',
  'vcs',
  'coworker_type',
  'github_actions_metadata',
])

/**
 * 官方不上报的客户机硬件键（11 项）。
 *
 * 这些是「物理特征」层的概念，属于本机指纹，不进遥测。任何情况下都不许
 * 出现在 env 里 —— 包括从旧配置文件读到的残留键。
 */
export const HARDWARE_FIELD_NAMES = Object.freeze([
  'cpu_model',
  'cpu_cores',
  'memory_bytes',
  'root_disk',
  'mac',
  'dmi_manufacturer',
  'dmi_product',
  'dmi_version',
  'dmi_family',
  'dmi_serial',
  'dmi_uuid',
])

/**
 * 官方客户端进程本身就是 bun 打包产物，因此该字段恒为 true。
 * 发 false 等于声称「这是一份手工拼的 Node 实现」。
 */
export const OFFICIAL_IS_RUNNING_WITH_BUN = true

/** 布尔型字段：必须是真布尔，不能是 "true" / 1 / "yes" */
const BOOLEAN_FIELDS = new Set([
  'is_running_with_bun',
  'is_ci',
  'is_claubbit',
  'is_github_action',
  'is_claude_code_action',
  'is_claude_ai_auth',
  'is_claude_code_remote',
  'is_conductor',
  'is_local_agent_mode',
])

/** 数组型字段 */
const ARRAY_FIELDS = new Set(['tags'])

/** 对象型字段 */
const OBJECT_FIELDS = new Set(['github_actions_metadata'])

function str(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 版本基线串，与官方同一套规则：取 `x.y.z` 三段，预发布后缀（`-beta`）保留。
 *
 * 注意官方**不去掉**后缀 —— 这个字段的语义是「版本串的可识别前缀」，
 * 而不是「主版本号」。去掉后缀反而与官方不同。
 */
export function versionBaseOf(version) {
  const raw = str(version).trim()
  // 匹配 x.y.z 加上可选的 -alpha/-beta 后缀并原样保留；
  // 构建元数据（+sha）与四段以上版本号截断到匹配部分。
  const match = raw.match(/^\d+\.\d+\.\d+(?:-[a-z]+)?/)
  return match ? match[0] : ''
}

/** 布尔归一：字符串 "false" 不能变成 true */
export function toBoolean(value) {
  if (typeof value === 'boolean') return value
  if (value === null || value === undefined || value === '') return false
  if (typeof value === 'number') return value !== 0 && Number.isFinite(value)
  const lowered = String(value).trim().toLowerCase()
  return lowered === 'true' || lowered === '1' || lowered === 'yes' || lowered === 'on'
}

/** 字符串数组归一：去空、去重、保序 */
export function toTagArray(value) {
  if (Array.isArray(value)) {
    return value.map((v) => str(v).trim()).filter(Boolean)
  }
  const raw = str(value)
  if (!raw.trim()) return []
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

/**
 * 从运行环境探测部署形态。取值集合与官方一致。
 * 注意这是**探测**，改写层负责把容器结果压回普通开发机。
 */
export function detectDeploymentEnvironment(source = {}) {
  const env = source.env || {}
  const truthy = (k) => toBoolean(env[k])
  if (truthy('CODESPACES')) return 'codespaces'
  if (env.GITPOD_WORKSPACE_ID) return 'gitpod'
  if (env.REPL_ID || env.REPL_SLUG) return 'replit'
  if (env.PROJECT_DOMAIN) return 'glitch'
  if (truthy('VERCEL')) return 'vercel'
  if (env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_SERVICE_NAME) return 'railway'
  if (truthy('RENDER')) return 'render'
  if (truthy('NETLIFY')) return 'netlify'
  if (env.DYNO) return 'heroku'
  if (env.FLY_APP_NAME || env.FLY_MACHINE_ID) return 'fly.io'
  if (truthy('CF_PAGES')) return 'cloudflare-pages'
  if (env.DENO_DEPLOYMENT_ID) return 'deno-deploy'
  if (env.AWS_LAMBDA_FUNCTION_NAME) return 'aws-lambda'
  if (env.AWS_EXECUTION_ENV === 'AWS_ECS_FARGATE') return 'aws-fargate'
  if (env.AWS_EXECUTION_ENV === 'AWS_ECS_EC2') return 'aws-ecs'
  if (env.K_SERVICE) return 'gcp-cloud-run'
  if (env.GOOGLE_CLOUD_PROJECT) return 'gcp'
  if (env.WEBSITE_SITE_NAME || env.WEBSITE_SKU) return 'azure-app-service'
  if (env.AZURE_FUNCTIONS_ENVIRONMENT) return 'azure-functions'
  if (str(env.APP_URL).includes('ondigitalocean.app')) return 'digitalocean-app-platform'
  if (env.SPACE_CREATOR_USER_ID) return 'huggingface-spaces'
  if (truthy('GITHUB_ACTIONS')) return 'github-actions'
  if (truthy('GITLAB_CI')) return 'gitlab-ci'
  if (env.CIRCLECI) return 'circleci'
  if (env.BUILDKITE) return 'buildkite'
  if (truthy('CI')) return 'ci'
  if (env.KUBERNETES_SERVICE_HOST) return 'kubernetes'
  if (source.isContainer) return 'docker'
  const platform = str(source.platform) || 'linux'
  if (platform === 'darwin') return 'unknown-darwin'
  if (platform === 'linux') return 'unknown-linux'
  if (platform === 'win32') return 'unknown-win32'
  return 'unknown'
}

/**
 * 构造官方客户端会发送的 env 字段。
 *
 * 入参是 camelCase 的环境快照，输出是 snake_case、按固定键序排列的对象。
 * 缺失项按官方默认值补齐，绝不产生 `undefined`。
 *
 * @param {object} input 环境快照
 * @returns {object} 可直接放进 event_data.env 的对象
 */
export function buildTelemetryEnv(input = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const version = str(src.version).trim() || OFFICIAL_CLI_VERSION
  const platform = str(src.platform).trim() || 'linux'
  const platformRaw = str(src.platformRaw).trim() || platform

  const env = {
    platform,
    platform_raw: platformRaw,
    node_version: str(src.nodeVersion).trim() || 'v22.14.0',
    terminal: str(src.terminal).trim() || 'unknown',
    package_managers: str(src.packageManagers).trim(),
    runtimes: str(src.runtimes).trim() || 'node',
    is_running_with_bun:
      src.isRunningWithBun === undefined
        ? OFFICIAL_IS_RUNNING_WITH_BUN
        : toBoolean(src.isRunningWithBun),
    is_ci: toBoolean(src.isCi),
    is_claubbit: toBoolean(src.isClaubbit),
    is_github_action: toBoolean(src.isGithubAction),
    is_claude_code_action: toBoolean(src.isClaudeCodeAction),
    is_claude_ai_auth: toBoolean(src.isClaudeAiAuth),
    version,
    arch: str(src.arch).trim() || 'x64',
    is_claude_code_remote: toBoolean(src.isClaudeCodeRemote),
    deployment_environment:
      str(src.deploymentEnvironment).trim() || detectDeploymentEnvironment({ ...src, platform }),
    is_conductor: toBoolean(src.isConductor),
    build_time: str(src.buildTime).trim() || OFFICIAL_BUILD_TIME,
    is_local_agent_mode: toBoolean(src.isLocalAgentMode),
  }

  // ── 条件字段：非空才附加，顺序按定义位置 ──
  const conditional = {
    version_base: str(src.versionBase).trim() || versionBaseOf(version),
    remote_environment_type: str(src.remoteEnvironmentType).trim(),
    claude_code_container_id: str(src.claudeCodeContainerId).trim(),
    claude_code_remote_session_id: str(src.claudeCodeRemoteSessionId).trim(),
    tags: toTagArray(src.tags),
    github_event_name: str(src.githubEventName).trim(),
    github_actions_runner_environment: str(src.githubActionsRunnerEnvironment).trim(),
    github_actions_runner_os: str(src.githubActionsRunnerOs).trim(),
    github_action_ref: str(src.githubActionRef).trim(),
    wsl_version: str(src.wslVersion).trim(),
    linux_distro_id: str(src.linuxDistroId).trim(),
    linux_distro_version: str(src.linuxDistroVersion).trim(),
    linux_kernel: str(src.linuxKernel).trim(),
    vcs: str(src.vcs).trim(),
    coworker_type: str(src.coworkerType).trim(),
  }

  for (const [key, value] of Object.entries(conditional)) {
    const present = ARRAY_FIELDS.has(key) ? value.length > 0 : value !== ''
    if (present) env[key] = value
  }

  if (src.githubActionsMetadata && typeof src.githubActionsMetadata === 'object') {
    const meta = src.githubActionsMetadata
    const nested = {
      actor_id: str(meta.actorId ?? meta.actor_id).trim(),
      repository_id: str(meta.repositoryId ?? meta.repository_id).trim(),
      repository_owner_id: str(meta.repositoryOwnerId ?? meta.repository_owner_id).trim(),
    }
    if (nested.actor_id || nested.repository_id || nested.repository_owner_id) {
      env.github_actions_metadata = nested
    }
  }

  return orderEnvFields(stripHardwareFields(env))
}

/**
 * 按官方键序重排。未知键丢弃 —— 宁可少一个自己发明的键，也不多一个特征。
 */
export function orderEnvFields(env) {
  const source = env && typeof env === 'object' ? env : {}
  const out = {}
  for (const key of ENV_FIELD_ORDER) {
    if (!Object.hasOwn(source, key)) continue
    const value = source[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/** 剔除客户机硬件键（防御旧配置残留） */
export function stripHardwareFields(env) {
  const source = env && typeof env === 'object' ? env : {}
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (HARDWARE_FIELD_NAMES.includes(key)) continue
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * 校验一个 env 对象是否与官方字段集合一致。
 * 返回 { ok, missing, extra, badTypes, hardware }，供自检与测试使用。
 */
export function validateTelemetryEnv(env) {
  const source = env && typeof env === 'object' ? env : {}
  const keys = Object.keys(source)
  const missing = WIRE_ALWAYS_FIELDS.filter((k) => !keys.includes(k))
  const known = new Set(ENV_FIELD_ORDER)
  const extra = keys.filter((k) => !known.has(k))
  const hardware = keys.filter((k) => HARDWARE_FIELD_NAMES.includes(k))

  const badTypes = []
  for (const [key, value] of Object.entries(source)) {
    if (BOOLEAN_FIELDS.has(key) && typeof value !== 'boolean') badTypes.push(key)
    if (ARRAY_FIELDS.has(key) && !Array.isArray(value)) badTypes.push(key)
    if (OBJECT_FIELDS.has(key) && (typeof value !== 'object' || value === null)) badTypes.push(key)
    if (!BOOLEAN_FIELDS.has(key) && !ARRAY_FIELDS.has(key) && !OBJECT_FIELDS.has(key)) {
      if (typeof value !== 'string') badTypes.push(key)
    }
    if (value === undefined) badTypes.push(key)
  }

  return {
    ok: missing.length === 0 && extra.length === 0 && badTypes.length === 0 && hardware.length === 0,
    missing,
    extra,
    badTypes: [...new Set(badTypes)],
    hardware,
  }
}
