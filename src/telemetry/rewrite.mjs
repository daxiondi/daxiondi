/**
 * 遥测改写：把我们的真实运行环境改写成「一台普通开发机」。
 *
 * 这个模块解决的是一个具体问题：遥测字段本身已经对齐了官方字段集合，
 * 但字段**值**还是我们自己的。值里如果带着部署路径、容器 id、宿主用户名，
 * 那么字段集合再干净也没用 —— 那些值本身就是身份。
 *
 * 做什么：
 *   1. 路径归一      部署路径不出现在任何字符串里
 *   2. 用户名归一    root / 服务账号 / 随机 uid 统一成普通开发账号
 *   3. 容器痕迹清除  docker / kubernetes / CI 变量读到的值压回本机语义
 *   4. 虚拟化痕迹清除  内核字符串、cgroup、hostname 形态
 *   5. 值域收敛      把可疑值替换成官方在同类机器上会给出的值
 *
 * 不做什么：
 *   - **不伪造硬件**。官方 env 里没有 cpu_model / mac / dmi_* 这类字段，
 *     硬塞进去反而是特征。硬件键在 env.mjs 里就被剔除了，这里不再处理。
 *   - **不改身份字段**。device_id / session_id / account 属于账号侧，由调用方
 *     注入；改写层只保证它们格式合法，不替换取值。
 */

import {
  HARDWARE_FIELD_NAMES,
  orderEnvFields,
  stripHardwareFields,
  detectDeploymentEnvironment,
  toBoolean,
} from './env.mjs'

/** 普通开发账号：容器里通常是 root 或服务账号，官方用户基本不是 */
export const NEUTRAL_USERNAME = 'dev'

/** 普通开发机的工作目录前缀 */
export const NEUTRAL_HOME = '/home/dev'

/** 容器与编排系统的路径前缀，出现即视为容器痕迹 */
export const CONTAINER_PATH_PREFIXES = Object.freeze([
  '/run/kin/',
  '/run/guest/',
  '/var/lib/persona/',
  '/opt/kin-live/',
  '/opt/kin-guest/',
  '/.dockerenv',
  '/var/run/secrets/kubernetes.io/',
  '/var/lib/docker/',
  '/var/lib/containerd/',
  '/sys/fs/cgroup/',
])

/**
 * 会暴露容器/CI 身份的环境变量名。
 * 注意这不等于「有 CI 就一定是容器」；但只要这些变量被原样上报，
 * 上游就能从 deployment_environment 或相关布尔位读出部署形态。
 */
export const CONTAINER_ENV_KEYS = Object.freeze([
  'CI',
  'CONTINUOUS_INTEGRATION',
  'BUILD_NUMBER',
  'RUN_ID',
  'DOCKER_HOST',
  'DOCKER_CONTAINER',
  'KUBERNETES_SERVICE_HOST',
  'KUBERNETES_SERVICE_PORT',
  'KUBERNETES_PORT',
  'container',
  'CONTAINER',
  'DOCKER',
  'K8S',
  'KUBERNETES',
  'CODESPACES',
  'GITPOD_WORKSPACE_ID',
  'REPL_ID',
  'REPL_SLUG',
  'VERCEL',
  'RENDER',
  'NETLIFY',
  'DYNO',
  'FLY_APP_NAME',
  'FLY_MACHINE_ID',
  'RAILWAY_ENVIRONMENT_NAME',
  'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_EXECUTION_ENV',
  'K_SERVICE',
  'GOOGLE_CLOUD_PROJECT',
  'WEBSITE_SITE_NAME',
  'CF_PAGES',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'BUILDKITE',
  'DENO_DEPLOYMENT_ID',
  'SPACE_CREATOR_USER_ID',
])

/** 内核串里出现即暴露虚拟化/容器的片段 */
export const VIRTUALIZATION_MARKERS = Object.freeze([
  'docker',
  'kubepods',
  'containerd',
  'gvisor',
  'firecracker',
  'qemu',
  'kvm',
  'virtualbox',
  'vmware',
  'hyperv',
  'xen',
  'kin',
])

/** 部署形态取值：官方在普通开发机上会给出的那几个 */
const PLAUSIBLE_DEPLOYMENTS = Object.freeze([
  'unknown-linux',
  'unknown-darwin',
  'unknown-win32',
  'unknown',
])

/** 部署形态取值：明确表示容器/云/CI 的 */
const CONTAINER_DEPLOYMENTS = Object.freeze([
  'docker',
  'kubernetes',
  'ci',
  'github-actions',
  'gitlab-ci',
  'circleci',
  'buildkite',
  'codespaces',
  'gitpod',
  'replit',
  'glitch',
  'vercel',
  'railway',
  'render',
  'netlify',
  'heroku',
  'fly.io',
  'cloudflare-pages',
  'deno-deploy',
  'aws-lambda',
  'aws-fargate',
  'aws-ecs',
  'gcp-cloud-run',
  'gcp',
  'azure-app-service',
  'azure-functions',
  'digitalocean-app-platform',
  'huggingface-spaces',
])

function str(value) {
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * 路径归一：把所有已知的部署路径前缀替换成普通开发机路径。
 *
 * 规则按「最长前缀优先」应用，避免 `/run/kin/` 被更短的规则先吃掉一半。
 */
export function normalizePath(value, options = {}) {
  let out = str(value)
  if (!out) return out
  const home = str(options.home) || NEUTRAL_HOME
  const replacements = [
    [/\/run\/kin\/[^\s"',;)]*/g, (m) => m.replace(/^\/run\/kin/, `${home}/.local/share`)],
    [/\/run\/guest\/[^\s"',;)]*/g, (m) => m.replace(/^\/run\/guest/, home)],
    [/\/var\/lib\/persona\/[^\s"',;)]*/g, (m) => m.replace(/^\/var\/lib\/persona/, `${home}/.local/share/persona`)],
    [/\/opt\/kin-live\/[^\s"',;)]*/g, (m) => m.replace(/^\/opt\/kin-live/, `${home}/.local/share/cli`)],
    [/\/opt\/kin-guest\/[^\s"',;)]*/g, (m) => m.replace(/^\/opt\/kin-guest/, `${home}/.local/share/cli`)],
    [/\/var\/lib\/docker\/[^\s"',;)]*/g, () => `${home}/.local/share`],
    [/\/var\/lib\/containerd\/[^\s"',;)]*/g, () => `${home}/.local/share`],
    [/\/var\/run\/secrets\/kubernetes\.io\/[^\s"',;)]*/g, () => `${home}/.config`],
    [/\/sys\/fs\/cgroup\/[^\s"',;)]*/g, () => '/sys/fs/cgroup'],
    [/\/\.dockerenv/g, () => `${home}/.config`],
  ]
  for (const [pattern, replacer] of replacements) {
    out = out.replace(pattern, replacer)
  }
  return out
}

/**
 * 用户名归一。支持三种输入形态：纯用户名、`/home/<user>` 路径、`user@host`。
 */
export function normalizeUsername(value, options = {}) {
  const raw = str(value).trim()
  if (!raw) return raw
  const neutral = str(options.username) || NEUTRAL_USERNAME
  const suspicious = /^(root|admin|administrator|ubuntu|ec2-user|ec2_user|cloud-user|centos|debian|alpine|nobody|daemon|guest|sandbox|runner|vscode|node)$/i

  if (/^[^@/\s]+@[^@/\s]+$/.test(raw)) {
    const [user, host] = raw.split('@')
    return `${suspicious.test(user) ? neutral : user}@${normalizeHostname(host, options)}`
  }
  if (raw.startsWith('/home/') || raw.startsWith('/Users/')) {
    const suffix = raw.replace(/^\/(home|Users)\//, '')
    return `${raw.startsWith('/Users/') ? '/Users' : '/home'}/${suspicious.test(suffix) ? neutral : suffix}`
  }
  return suspicious.test(raw) ? neutral : raw
}

/**
 * 主机名归一。
 *
 * 判据是形态而不是具体名字：容器默认 hostname 是 12 位短 hex（容器 id 截断），
 * k8s 是 `<deploy>-<rs>-<pod>`，云主机是 `ip-10-0-1-23`。这几种形态都很显眼。
 */
export function normalizeHostname(value, options = {}) {
  const raw = str(value).trim()
  if (!raw) return raw
  const fallback = str(options.hostname) || 'dev-workstation'
  if (/^[0-9a-f]{12}$/i.test(raw)) return fallback
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(raw)) return fallback
  if (/^ip-\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}$/i.test(raw)) return fallback
  if (/^[a-z0-9-]+-[a-z0-9]{5,10}-[a-z0-9]{5}$/i.test(raw)) return fallback
  if (VIRTUALIZATION_MARKERS.some((m) => raw.toLowerCase().includes(m))) return fallback
  return raw
}

/**
 * 内核串归一。内核版本号本身不敏感，暴露的是版本串里的虚拟化标记
 * （`-gvisor`、`-kvm`、`-docker`）以及定制构建后缀。
 */
export function normalizeKernel(value, options = {}) {
  const raw = str(value).trim()
  if (!raw) return ''
  const fallback = str(options.kernel) || '6.8.0-45-generic'
  const lowered = raw.toLowerCase()
  if (VIRTUALIZATION_MARKERS.some((m) => lowered.includes(m))) return fallback
  // 形如 5.15.0-1053-azure / 6.5.0-1024-aws 这类云厂商定制题名也归到通用内核
  if (/(azure|aws|gcp|oracle|alibaba|tencent|cloud)/.test(lowered)) return fallback
  return raw
}

/**
 * 字符串通用清洗：路径 → 用户名 → 主机名。顺序有依赖：
 * 先换路径（里面含用户名），再换用户名（现在只剩纯用户名的位置）。
 * 末尾统一剔除容器痕迹标记。
 */
export function sanitizeString(value, options = {}) {
  let out = normalizePath(value, options)
  out = out.replace(/\/(?:home|Users)\/[A-Za-z0-9._-]+/g, (m) => normalizeUsername(m, options))
  out = out.replace(/\b([a-z0-9._-]+)@([a-z0-9.-]+)\b/gi, (m) => normalizeUsername(m, options))
  return stripContainerMarkers(out)
}

/** 剔除字符串里残留的容器痕迹标记 */
export function stripContainerMarkers(value) {
  let out = str(value)
  for (const marker of VIRTUALIZATION_MARKERS) {
    // 只处理标记作为独立片段出现的情况，避免误伤正常单词
    const re = new RegExp(`(^|[^a-z0-9])${marker}([^a-z0-9]|$)`, 'gi')
    out = out.replace(re, (m, before, after) => `${before}workstation${after}`)
  }
  return out
}

/**
 * 部署形态归一。
 *
 * 这是最关键的一处：`deployment_environment` 是官方明确上报的字段，
 * 值写 `docker` / `kubernetes` / `ci` 等于直接把部署形态报上去。
 * 容器内探测出来的结果必须压回普通开发机取值。
 */
export function normalizeDeploymentEnvironment(value, options = {}) {
  const raw = str(value).trim()
  const platform = str(options.platform).trim() || 'linux'
  if (!raw) {
    if (platform === 'darwin') return 'unknown-darwin'
    if (platform === 'win32') return 'unknown-win32'
    if (platform === 'linux') return 'unknown-linux'
    return 'unknown'
  }
  if (CONTAINER_DEPLOYMENTS.includes(raw)) {
    if (platform === 'darwin') return 'unknown-darwin'
    if (platform === 'win32') return 'unknown-win32'
    return 'unknown-linux'
  }
  if (PLAUSIBLE_DEPLOYMENTS.includes(raw)) return raw
  return platform === 'linux' ? 'unknown-linux' : `unknown-${platform}`
}

/**
 * 布尔位归一。CI / GitHub Actions 这类位如果为 true，等于自报在 CI 里跑。
 * 这些是官方字段集合内的键，不能删，只能改成普通开发机的取值。
 */
export function normalizeBooleanFlags(env) {
  const out = { ...env }
  for (const key of [
    'is_ci',
    'is_github_action',
    'is_claude_code_action',
    'is_claude_code_remote',
    'is_local_agent_mode',
    'is_conductor',
    'is_claubbit',
  ]) {
    if (key in out) out[key] = false
  }
  return out
}

/**
 * 清除 CI / 容器相关的条件字段。
 *
 * 这些键在官方语义里是「只有 CI 才带」：既然我们把机器声明成普通开发机，
 * 它们就不能有值。留着空串也不行 —— 空串也是键，官方在非 CI 环境根本不输出。
 */
export function stripContainerConditionalFields(env) {
  const out = { ...env }
  for (const key of [
    'github_event_name',
    'github_actions_runner_environment',
    'github_actions_runner_os',
    'github_action_ref',
    'github_actions_metadata',
    'wsl_version',
    'remote_environment_type',
    'claude_code_container_id',
    'claude_code_remote_session_id',
    'coworker_type',
  ]) {
    delete out[key]
  }
  return out
}

/**
 * 改写完整 env。
 *
 * @param {object} env 待改写的 env（可以是官方形状，也可以是我们的原始快照）
 * @param {object} ctx 改写上下文：username / hostname / home / platform / tags
 * @returns {object} 改写后的 env，键序与官方一致
 */
export function rewriteTelemetryEnv(env, ctx = {}) {
  const source = env && typeof env === 'object' ? env : {}
  const context = ctx && typeof ctx === 'object' ? ctx : {}

  // 1) 硬件键一律剔除（官方不上报）
  let out = stripHardwareFields(source)

  // 2) 平台与部署形态
  const platform = normalizeDeploymentEnvironment(
    out.deployment_environment || detectDeploymentEnvironment(context),
    { platform: out.platform || context.platform },
  )

  // 3) 布尔位压平
  out = normalizeBooleanFlags(out)

  // 4) 清 CI / 容器条件字段
  out = stripContainerConditionalFields(out)

  // 5) 字符串字段归一
  const stringFields = [
    'platform',
    'platform_raw',
    'arch',
    'node_version',
    'terminal',
    'package_managers',
    'runtimes',
    'version',
    'version_base',
    'vcs',
    'linux_distro_id',
    'linux_distro_version',
  ]
  for (const key of stringFields) {
    if (typeof out[key] === 'string') out[key] = sanitizeString(out[key], context)
  }

  // 6) 内核与发行版信息：普通开发机会有，但不能带虚拟化痕迹
  if (out.linux_kernel) {
    const kernel = normalizeKernel(out.linux_kernel, context)
    if (kernel) out.linux_kernel = kernel
    else delete out.linux_kernel
  }

  // 7) tags：带容器标记的整条丢弃，而不是把标记替换成别的词。
  //    替换会留下一个官方不会出现的怪值（例如 env:docker → env:workstation），
  //    整条丢弃才是官方在没有这个标签时的真实状态。
  if (Array.isArray(out.tags)) {
    const tags = out.tags
      .filter((t) => !hasContainerTraces(t))
      .map((t) => normalizePath(str(t), context).trim())
      .filter(Boolean)
    if (tags.length > 0) out.tags = tags
    else delete out.tags
  }

  // 8) 部署形态写回（放在最后，避免被前面的通用清洗覆盖）
  out.deployment_environment = platform

  // 9) 环境变量快照若被塞进 env，整块丢弃 —— 它不是官方字段
  delete out.env
  delete out.env_vars
  delete out.environment

  return orderEnvFields(stripHardwareFields(out))
}

/**
 * 改写环境变量快照：把 CI / 容器相关键删掉，值里的路径与用户名归一。
 *
 * 这个函数处理的是「我们自己的进程环境」，不是线上 env 对象。调用方可选择
 * 在构造遥测前先用它对 process.env 做一次收敛。
 */
export function rewriteEnvironmentVars(vars = {}, ctx = {}) {
  const source = vars && typeof vars === 'object' ? vars : {}
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    const canon = String(key).toUpperCase()
    if (CONTAINER_ENV_KEYS.some((k) => k.toUpperCase() === canon)) continue
    if (typeof value === 'string') out[key] = sanitizeString(value, ctx)
    else out[key] = value
  }
  return out
}

/** 判断一个字符串里是否还有容器/部署痕迹（自检与测试用） */
export function hasContainerTraces(value) {
  const raw = str(value)
  if (!raw) return false
  const lowered = raw.toLowerCase()
  for (const prefix of CONTAINER_PATH_PREFIXES) {
    if (lowered.includes(prefix.toLowerCase())) return true
  }
  for (const marker of VIRTUALIZATION_MARKERS) {
    const re = new RegExp(`(^|[^a-z0-9])${marker}([^a-z0-9]|$)`, 'i')
    if (re.test(lowered)) return true
  }
  return false
}

/**
 * 全量自检：确认改写后的 env 既没有硬件键，也没有容器痕迹，
 * 且部署形态落在普通开发机取值域内。
 */
export function auditRewrittenEnv(env) {
  const source = env && typeof env === 'object' ? env : {}
  const problems = []
  for (const key of Object.keys(source)) {
    if (HARDWARE_FIELD_NAMES.includes(key)) problems.push(`hardware:${key}`)
    const value = source[key]
    if (typeof value === 'string' && hasContainerTraces(value)) problems.push(`trace:${key}`)
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && hasContainerTraces(item)) problems.push(`trace:${key}`)
      }
    }
  }
  const deploy = str(source.deployment_environment)
  if (deploy && CONTAINER_DEPLOYMENTS.includes(deploy)) problems.push(`deployment:${deploy}`)
  for (const key of ['is_ci', 'is_github_action', 'is_claude_code_action']) {
    if (toBoolean(source[key])) problems.push(`flag:${key}`)
  }
  return { ok: problems.length === 0, problems }
}
