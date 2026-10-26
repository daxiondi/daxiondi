/**
 * 单槽位启动编排：把 egress / persona 两套「只产配置」的模块接成一条能跑的装配线。
 *
 * 顺序不可调，每一步都依赖前一步的产物：
 *
 *   1. preflight   环境具备最低条件（Linux / root 或 CAP_NET_ADMIN / 程序齐全）
 *   2. network     docker network create —— 先有网桥，网关地址才存在
 *   3. iptables    nat REDIRECT + filter 兜底 —— 依赖网桥接口名
 *   4. redsocks    监听网桥网关 —— 依赖网关地址已存在（否则 EADDRNOTAVAIL）
 *   5. dnsfwd      监听网关的 dns 端口 —— 依赖同一条重定向链
 *   6. persona     落盘身份文件 —— 容器挂载前必须存在
 *   7. container   启动容器 —— 依赖 network / persona
 *   8. verify      验证出口与身份 —— 依赖以上全部
 *
 * 三条硬性行为：
 *
 *   A. 中途失败自动回滚。up() 维护「已成功步骤」栈，任一步抛错就逆序执行这些
 *      步骤的 undo。第 4 步挂了，前 3 步（network / iptables / preflight 的
 *      副作用）都会被收拾掉，不留半成品网桥和半套规则。
 *
 *   B. 每步幂等。network 先 inspect 再 create；iptables 靠 -C 探测；
 *      container 先 inspect 再 run/start；转发器先看端口是否已在监听。
 *      连续两次 up() 不报错，也不会产生第二份资源。
 *
 *   C. verify 失败等同启动失败。出口没走代理或身份没生效，都说明这个槽位
 *      不可用 —— 此时不保留「看起来起来了」的容器，直接回滚。
 *
 * 所有外部命令都走注入的 Executor（src/runtime/executor.mjs），
 * 因此测试可以在没有 docker / iptables / root 的环境里跑完所有分支。
 */

import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { Executor, nullLogger, shellJoin } from './executor.mjs'
import { preflight as runPreflight } from './preflight.mjs'
import {
  applyIptables,
  containerNameFor,
  createNetworkArgs,
  dockerNetworkArgs,
  inspectNetworkArgs,
  redirectRules,
  redsocksConfig,
} from '../egress/network.mjs'
import { verifyEgress, preflightEgress } from '../egress/verify.mjs'
import { startDnsForwarder } from '../egress/dnsfwd.mjs'
import { dockerArgsForPersona, materializePersonaTree } from '../persona/docker-spec.mjs'
import { utsForSlot, utsWritePayload } from '../persona/uts-fake.mjs'
import { timezoneForProxy, timezoneForExit } from '../persona/geo-timezone.mjs'
import { verifyPersonaInContainer } from '../persona/verify.mjs'
import { HOSTNAME_STRATEGY, hostnameOverrides } from '../persona/fleet-plan.mjs'

/**
 * 槽位序号（从 0 开始）。
 *
 * 复用 personaHostnameFor 的推导逻辑：优先用显式 index，否则从 slotId
 * 尾部数字取。返回 0 基，因为 procfs 的画像选择用它做扰动源，
 * 1 基还是 0 基只影响取模结果，但必须稳定。
 */
export function slotIndex(slotSpec = {}) {
  const raw = Number(slotSpec?.index)
  const oneBased = Number.isInteger(raw) && raw > 0
    ? raw
    : Number(String(slotSpec?.slotId || '').match(/(\d+)$/)?.[1] || 0)
  return oneBased > 0 ? oneBased - 1 : 0
}

/** 槽位 CPU 限额。缺失时给 2 —— 与 fleet-plan 的默认值一致。 */
export function slotCpuLimit(slotSpec = {}) {
  const raw = Number(
    slotSpec?.cpuLimit ?? slotSpec?.cpus ?? slotSpec?.resources?.cpuLimit ?? slotSpec?.resources?.cpus,
  )
  return Number.isFinite(raw) && raw > 0 ? raw : 2
}

/** 槽位内存限额（MB）。默认 1024，与 vm2api 面板的容器默认值一致。 */
export function slotMemoryLimit(slotSpec = {}) {
  const raw = Number(
    slotSpec?.memoryMb ?? slotSpec?.memoryLimitMb
    ?? slotSpec?.resources?.memoryMb ?? slotSpec?.resources?.memoryLimitMb
    // fleet-plan 的 planFleet 把限额放在 slot.memoryMb，
    // 但也可能整包放在 slot.plan / slot.resourcePlan 里
    ?? slotSpec?.plan?.memoryMb ?? slotSpec?.resourcePlan?.memoryMb,
  )
  return Number.isFinite(raw) && raw > 0 ? raw : 1024
}

/** 启动步骤名，顺序即依赖顺序。 */
export const STEP_ORDER = Object.freeze([
  'preflight',
  'network',
  'iptables',
  'redsocks',
  'dnsfwd',
  'geo',
  'persona',
  'container',
  'timezone',
  'uts',
  'verify',
])

/** 默认数据目录：persona 树与转发器配置都落在这里。 */
export const DEFAULT_DATA_DIR = '/var/lib/live-api-egress'
/** 默认转发器配置目录（0600，含明文凭据）。 */
export const DEFAULT_CONF_DIR = '/etc/live-api-egress'
/** 默认镜像。 */
// 默认用带 Claude Code CLI 的镜像。
//
// 为什么默认值就换成 cli 版：vm2api 的内核契约是 spawn 一个 CLI 子进程，
// 没有 claude 二进制的镜像跑不了 Claude 链路。之前默认是不含 CLI 的
// 裸 Ubuntu，导致槽起来了但 Claude 完全不可用 —— 而且不报错，
// 只是 health 里 engine 一直不 ready。
//
// 保留旧镜像名是为了让显式传 --image 的场景仍能回到最小镜像。
export const DEFAULT_IMAGE = 'live-api/claude-slot-cli:latest'

/**
 * 清理类命令的「目标已经不存在」判定。
 *
 * 清理的期望终态是「资源不存在」。如果资源本来就不存在，命令返回非零，
 * 但状态已经符合期望 —— 把这种情况记成失败，会让 `down` 在干净的机器上
 * 报一堆假失败，进而让运维忽略真正的失败。
 */
const ALREADY_GONE = new RegExp(
  [
    'no such (object|network|chain|container)',
    '.*not found',              // docker: "network X not found" / "container X not found"
    'does not exist',
    'cannot find',
    'Bad rule',                 // iptables: 要删的规则不在
    'No chain/target/match',    // iptables: 要删的链不在
    'no such process',          // kill: 进程已退出
    'Chain already exists',     // iptables -N: 链已存在（幂等语义）
  ].join('|'),
  'i',
)

function goneOk(result) {
  if (Boolean(result?.ok)) return true
  const err = String(result?.stderr || '')
  // ENOENT：清理工具本身不存在。意味着这个槽位从未在本机部署过
  // （正是因为缺工具才部署不了），期望终态「无规则 / 无网络」已经成立。
  if (/ENOENT/.test(err)) return true
  return ALREADY_GONE.test(err)
}

/** 从 argv 里成对删除某个选项（保留其余顺序）。 */
function stripOption(argv, flag) {
  const out = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      i += 1
      continue
    }
    out.push(argv[i])
  }
  return out
}

/**
 * 合并容器参数：网络参数为主干，persona 参数覆盖主机名并追加挂载与 env。
 *
 * 冲突点只有 `--hostname`：网络参数里写的是容器名（claude-slot-01），
 * persona 里写的是 persona 的可见主机名。两者都要保留其语义 ——
 * 这里取 persona 的（规范化后的 RFC 1123 label），因为 `--hostname` 决定
 * 容器内 /etc/hostname，而容器名已经在 `--name` 里表达了。
 *
 * @param {object} p
 * @param {string[]} p.netArgs      dockerNetworkArgs().args（末尾是镜像名）
 * @param {object}  [p.personaSpec] dockerArgsForPersona() 的返回值
 * @param {string}  [p.image]       覆盖镜像
 * @param {Array}   [p.extraArgs]   额外参数
 * @returns {string[]} 完整 argv，形如 ['docker','run','-d', ...]
 */
export function composeContainerArgv({ netArgs, personaSpec = null, image, extraArgs = [] } = {}) {
  const argv = Array.isArray(netArgs) ? [...netArgs] : []
  const declaredImage = argv.length ? argv[argv.length - 1] : DEFAULT_IMAGE
  const tailImage = image || declaredImage || DEFAULT_IMAGE
  if (argv.length) argv.pop()
  const netPart = stripOption(argv, '--hostname')

  const personaPart = personaSpec ? stripOption([...personaSpec.args], '--network') : []
  const envPart = []
  for (const [k, v] of Object.entries(personaSpec?.env || {})) envPart.push('--env', `${k}=${v}`)

  return ['docker', 'run', '-d', ...netPart, ...personaPart, ...extraArgs, ...envPart, tailImage]
}

/** 从 docker inspect 的输出判断容器是否在跑。 */
function parseRunning(stdout) {
  const text = String(stdout || '').trim()
  if (!text) return null
  return text === 'true'
}

/**
 * 按槽位序号派生 persona 主机名。
 *
 * 为什么要派生：`buildPersona()` 在没有 overrides 时给的是**平台常量**主机名
 * （linux 恒为 `ip-10-0-1-23`），与 vmId 无关。编排器过去不给 overrides，
 * 于是 20 个槽位的 /etc/hostname、`hostname`、`uname -n` 全是同一个值，
 * 只有 MAC / UUID / serial 不同 —— 这是可观测的合成痕迹，而"该不同的不同"
 * 本来就是 persona 规划的核心目标（见 fleet-plan.mjs 的 FLEET_UNIQUE_FIELDS）。
 *
 * 复用 fleet-plan 的 HOSTNAME_STRATEGY 而不是另写一套模板：两份模板迟早漂移，
 * 而漂移的表现正是这里要修的 bug。索引口径也统一 —— 模板是 0 起，槽位 index 是 1 起。
 *
 * 平台没有策略表（或模板抛错）时返回空串，由调用方回落到平台缺省值；
 * 宁可这台机器主机名不理想，也不要因为取名字把整个槽位启动搞挂。
 */
export function personaHostnameFor(platform, slotSpec = {}) {
  const strategy = HOSTNAME_STRATEGY?.[platform]
  if (!strategy || typeof strategy.template !== 'function') return ''
  const raw = Number(slotSpec?.index)
  const index = Number.isInteger(raw) && raw > 0 ? raw : Number(String(slotSpec?.slotId || '').match(/(\d+)$/)?.[1] || 0)
  if (!index) return ''
  try {
    return String(strategy.template(index - 1) || '')
  } catch {
    return ''
  }
}

/**
 * 该槽位的 persona overrides。
 *
 * 只要主机名有值就带上：字段名分平台（linux 是 naming.hostname，
 * macos 还要 local_hostname / computer_name，windows 是 computer_name），
 * 这层分派由 hostnameOverrides 负责，调用方不要自己拼。
 */
export function personaOverridesFor(platform, hostname) {
  const name = String(hostname || '').trim()
  if (!name) return {}
  try {
    return hostnameOverrides(platform, name)
  } catch {
    // 不支持的平台：退回 linux 的最小形态，至少不改坏 normalize
    return { naming: { hostname: name } }
  }
}

/**
 * 单槽位编排器。
 */
export class SlotOrchestrator {
  /**
   * @param {object} opts
   * @param {Executor} opts.executor
   * @param {object}   opts.slotSpec   规划出的槽位（planSlotNetworks 的一项）
   * @param {object}   [opts.proxy]    绑定的代理；缺失即无出口
   * @param {object}   [opts.logger]
   * @param {string}   [opts.platform='linux']
   * @param {string}   [opts.image=DEFAULT_IMAGE]
   * @param {string}   [opts.confDir=DEFAULT_CONF_DIR]
   * @param {string}   [opts.dataDir=DEFAULT_DATA_DIR]
   * @param {string}   [opts.timezone='UTC']
   * @param {boolean}  [opts.verifyPersona=true]
   * @param {boolean}  [opts.verifyEgress=true]
   * @param {object}   [opts.dnsForwarder]  {start(opts)=>Promise<handle>}，默认 startDnsForwarder
   * @param {Function} [opts.hostProbe]     宿主机出口 IP 探测（对照组）
   * @param {Function} [opts.readFile]      fs.readFileSync
   * @param {Function} [opts.writeFile]     (path, content, opts) => void
   * @param {Function} [opts.mkdirp]        (dir) => void
   * @param {Function} [opts.exists]        (p) => boolean
   * @param {string}   [opts.personaHostname] 该槽位的 persona 主机名；
   *   缺省按槽位序号从 HOSTNAME_STRATEGY 派生，保证 20 个槽位两两不同
   * @param {number}   [opts.stepTimeoutMs] 单步超时
   */
  constructor({
    executor,
    slotSpec,
    proxy = null,
    logger = nullLogger,
    platform = 'linux',
    image = DEFAULT_IMAGE,
    confDir = DEFAULT_CONF_DIR,
    dataDir = DEFAULT_DATA_DIR,
    // 时区不能写死 UTC —— 必须跟出口 IP 的地理位置一致。
    // 实测矛盾：出口在洛杉矶（America/Los_Angeles），容器却报 UTC。
    // 容器内 curl ipinfo.io 一眼就能发现。
    //
    // 传 'auto' 或 null 时按代理 region 推导；显式给值则尊重调用方。
    timezone = 'auto',
    verifyPersona = true,
    verifyEgress: verifyEgressEnabled = true,
    dnsForwarder = null,
    hostProbe = null,
    preflight: preflightFn = null,
    readFile = fs.readFileSync,
    writeFile = (p, c, o) => fs.writeFileSync(p, c, o),
    mkdirp = (d) => fs.mkdirSync(d, { recursive: true }),
    exists = fs.existsSync,
    getuid = undefined,
    personaHostname = null,
    runtimeKind = 'docker',
    stepTimeoutMs = 90_000,
  } = {}) {
    if (!executor) throw new Error('SlotOrchestrator 需要注入 executor')
    if (!slotSpec || !slotSpec.slotId) throw new Error('SlotOrchestrator 需要 slotSpec.slotId')

    this.executor = executor
    this.slot = slotSpec
    this.proxy = proxy || null
    this.logger = logger || nullLogger
    this.platform = platform
    this.image = image
    // 虚拟化方式：docker 共享宿主机内核，kvm 有独立内核（SMBIOS 由 QEMU 写入）。
    // 它决定了「哪些指纹能真正伪造」，verify 需要据此区分「不适用」与「失败」。
    this.runtimeKind = String(runtimeKind || 'docker').toLowerCase()
    this.confDir = confDir
    this.dataDir = dataDir
    // 推导优先级：
    //   1. 调用方显式给了具体时区 → 用它
    //   2. 给了代理 → 按代理 region 推
    //   3. 都没有 → null，留给 stepVerify 时按实际出口 IP 补
    let tz = null
    if (typeof timezone === 'string' && timezone !== 'auto' && /^[A-Za-z]+\/[A-Za-z_]+/.test(timezone)) {
      tz = timezone
    } else if (this.proxy) {
      const derived = timezoneForProxy(this.proxy)
      tz = derived.timezone
      this.timezoneSource = derived.source
    }
    // 推不出来时保持 null：宁可后面按真实出口补，也不在这里猜一个错的
    this.timezone = tz
    this.verifyPersonaEnabled = verifyPersona !== false
    this.verifyEgressEnabled = verifyEgressEnabled !== false
    this.dnsForwarder = dnsForwarder || { start: startDnsForwarder }
    this.hostProbe = hostProbe
    this.preflightFn = preflightFn || runPreflight
    this.readFile = readFile
    this.writeFile = writeFile
    this.mkdirp = mkdirp
    this.exists = exists
    this.getuid = getuid
    this.stepTimeoutMs = stepTimeoutMs
    this.dryRun = Boolean(executor.dryRun)

    this.slotId = slotSpec.slotId
    this.container = slotSpec.container || containerNameFor(slotSpec.slotId)
    // persona 主机名：显式传入优先，否则按槽位序号从平台的 hostname 模板派生。
    // 必须派生 —— 平台缺省主机名是常量（linux 恒为 ip-10-0-1-23），不派生会让
    // 20 个槽位的 /etc/hostname、`hostname`、`uname -n` 全相同，只有 MAC 不同，
    // 这是可观测的合成痕迹。序号用 slotSpec.index（1 起），模板是 0 起。
    this.personaHostname = String(
      personaHostname || personaHostnameFor(this.platform, slotSpec),
    )

    /** 已成功步骤（回滚栈）。 */
    this.completed = []
    /** 跨步骤共享的运行时句柄（dns 转发器、pid、路径等）。 */
    this.state = {
      preflight: null,
      networkCreated: false,
      networkExisted: false,
      iptablesApplied: false,
      redsocksPid: null,
      redsocksConfPath: '',
      redsocksListening: false,
      dnsHandle: null,
      dnsListening: '',
      personaSpec: null,
      personaDir: '',
      uts: null,
      timezone: null,
      geo: null,
      personaFiles: 0,
      containerRunning: false,
      containerReused: false,
      verify: null,
      personaVerify: null,
    }
    this.lastError = null
    /** down() 置 true：undo 系列忽略本地状态标记，按名字清残留。 */
    this.fullCleanup = false
  }

  /** 转发器配置路径。 */
  get confPath() {
    return path.join(this.confDir, `${this.slot.network || `live-api-eg-${this.slotId.slice(5)}`}.redsocks.conf`)
  }

  /** persona 落盘目录。 */
  get personaDir() {
    return path.join(this.dataDir, 'persona', this.slotId)
  }

  /** 适配 applyIptables 需要的 run(argv)=>Promise<{ok,stderr}>。 */
  get iptablesRunner() {
    return async (argv) => {
      const [cmd, ...rest] = argv
      const r = await this.executor.run(cmd, rest, {
        check: false,
        quiet: true,
        timeoutMs: this.stepTimeoutMs,
      })
      return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, code: r.code }
    }
  }

  // ─────────────────────── 各步骤实现 ───────────────────────

  /** 1. 环境预检。只读，没有副作用，因此 undo 是空操作。 */
  async stepPreflight() {
    const result = await this.preflightFn({
      executor: this.executor,
      platform: this.platform,
      readFile: this.readFile,
      exists: this.exists,
      getuid: this.getuid,
      requirements: { needRedsocks: true, needDocker: true, needIptables: true },
    })
    this.state.preflight = result
    for (const w of result.warnings) this.logger.warn(`preflight 告警: ${w}`)
    if (!result.ok) {
      // 演练模式下预检失败不阻断：dry-run 不改变任何东西，把 8 步全走一遍
      // 才能暴露「第 7 步参数拼装会不会崩」这类问题。真实启动时才拦截。
      if (this.dryRun) {
        return { ok: true, detail: `[dry-run] 预检未通过但演练继续：${result.fatal.join('; ')}` }
      }
      const error = new Error(`预检未通过:\n  ${result.fatal.join('\n  ')}`)
      error.code = 'PREFLIGHT_FAILED'
      error.detail = result
      throw error
    }
    return { ok: true, detail: result.summary }
  }

  async undoPreflight() {
    // 只读检查，无副作用
  }

  /** 2. 建 docker network。先 inspect，已存在则复用（幂等）。 */
  async stepNetwork() {
    const name = this.slot.network
    const inspect = inspectNetworkArgs({ slot: this.slot })
    const probe = await this.executor.run(inspect[0], inspect.slice(1), {
      check: false,
      quiet: true,
      timeoutMs: 20_000,
    })

    if (!this.dryRun && probe.ok) {
      this.state.networkCreated = true
      this.state.networkExisted = true
      this.logger.info(`network ${name} 已存在，复用（现有: ${String(probe.stdout).trim()}）`)
      return { ok: true, detail: `复用现有网络 ${name}`, reused: true }
    }

    const spec = createNetworkArgs({ slot: this.slot })
    if (!spec.ok) throw new Error(`网络参数生成失败: ${spec.error}`)
    await this.executor.run(spec.args[0], spec.args.slice(1), { timeoutMs: this.stepTimeoutMs })
    this.state.networkCreated = true
    this.state.networkExisted = false
    return { ok: true, detail: `创建网络 ${name} (${this.slot.subnet} gw=${this.slot.gateway} br=${this.slot.bridge})` }
  }

  async undoNetwork() {
    // fullCleanup 模式：本进程可能从未 up 过（上一个进程崩在中途），
    // 本地状态标记全为 false，但磁盘/内核里可能确实有残留。此时按名字清，
    // 失败也只记详情不抛 —— docker network rm 对不存在的网络本来就返回非零。
    if (!this.state.networkCreated && !this.fullCleanup) return { ok: true, detail: '未创建，跳过' }
    const name = this.slot.network
    const r = await this.executor.run('docker', ['network', 'rm', name], {
      check: false,
      quiet: true,
      timeoutMs: 30_000,
    })
    this.state.networkCreated = false
    const ok = goneOk(r)
    return {
      ok,
      detail: r.ok ? `已删除网络 ${name}` : ok ? `网络 ${name} 本就不存在` : `删除网络失败: ${(r.stderr || '').trim()}`,
    }
  }

  /** 3. iptables 规则。applyIptables 内部用 -C 探测，天然幂等。 */
  async stepIptables() {
    const rules = redirectRules({ slot: this.slot, proxy: this.proxy })
    if (!rules.ok) throw new Error(`iptables 规则生成失败: ${(rules.errors || []).join(', ')}`)
    const applied = await applyIptables(rules, this.iptablesRunner)
    if (!applied.ok) throw new Error(`应用 iptables 失败: ${applied.error}`)
    this.state.iptablesApplied = true
    this.state.iptablesRules = rules
    return { ok: true, detail: `${rules.chain} 链就绪（REDIRECT tcp→${rules.listenPort}, dns→${rules.dnsPort}）` }
  }

  async undoIptables() {
    if (!this.state.iptablesApplied && !this.fullCleanup) return { ok: true, detail: '未应用，跳过' }
    const rules = this.state.iptablesRules || redirectRules({ slot: this.slot, proxy: this.proxy })
    const del = rules?.del || []
    const errors = []
    let missingTool = 0
    let attempted = 0
    for (const argv of del) {
      const r = await this.executor.run('iptables', argv, {
        check: false,
        quiet: true,
        timeoutMs: 20_000,
      })
      attempted += 1
      const err = String(r?.stderr || '')
      if (/ENOENT/.test(err)) {
        missingTool += 1
        continue
      }
      if (!goneOk(r) && !this.dryRun) errors.push(err.trim().split('\n')[0] || `exit=${r.code}`)
    }
    this.state.iptablesApplied = false
    if (!this.dryRun && attempted > 0 && missingTool === attempted) {
      return { ok: true, detail: 'iptables 不可用，本机不可能存在本槽位规则（无需清理）' }
    }
    if (errors.length === 0) return { ok: true, detail: `已回滚 ${rules?.chain || ''} 链` }
    return { ok: false, detail: `部分规则未删除: ${errors[0]}` }
  }

  /**
   * 端口是否在监听。
   *
   * 三态返回：true 在监听 / false 明确不在 / null 无法判定（没有 ss、
   * 输出不可解析）。区分 null 与 false 很重要：把「探不了」当成「没监听」
   * 会让没有 ss 的精简镜像永远起不来；反过来把「没监听」当成「不知道」
   * 会让转发器绑定失败被静默忽略。只有明确 false 才阻断。
   */
  async isListening(port) {
    if (this.dryRun) return null
    if (!port) return null
    const r = await this.executor.run('/bin/sh', ['-c', `ss -ltn 2>/dev/null | grep -c ':${port} '`], {
      check: false,
      quiet: true,
      timeoutMs: 10_000,
    })
    const text = String(r.stdout || '').trim()
    if (!r.ok || !/^\d+$/.test(text)) return null
    return Number(text) > 0
  }

  /**
   * 等待端口进入监听。转发器是 daemon，bind 与进程返回之间有一个短窗口，
   * 立即探测会把「还没绑上」误判成「绑定失败」。
   */
  async waitForListening(port, { attempts = 5, intervalMs = 120 } = {}) {
    let last = null
    for (let i = 0; i < attempts; i += 1) {
      last = await this.isListening(port)
      if (last === true || last === null) return last
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    return last
  }

  /** 4. redsocks。配置落盘 0600，进程 detach 启动。 */
  async stepRedsocks() {
    const conf = redsocksConfig({ slot: this.slot, proxy: this.proxy || {} })
    if (!conf.ok) {
      const error = new Error(`redsocks 配置生成失败: ${conf.error}（槽位是否缺少可用代理？）`)
      error.code = 'NO_PROXY'
      throw error
    }
    if (conf.unsafeCred) {
      this.logger.warn('凭据含引号或反斜杠，redsocks 配置无法安全表达，建议改用 sing-box 变体')
    }

    const already = await this.isListening(this.slot.ports?.tcp)
    if (already === true) {
      this.state.redsocksListening = true
      this.state.redsocksReused = true
      return { ok: true, detail: `端口 ${this.slot.ports.tcp} 已在监听，复用现有转发器`, reused: true }
    }

    const confPath = this.confPath
    if (!this.dryRun) {
      this.mkdirp(path.dirname(confPath))
      this.writeFile(confPath, conf.content, { mode: 0o600 })
    }
    this.state.redsocksConfPath = confPath

    const r = await this.executor.run('redsocks', ['-c', confPath], {
      detach: true,
      quiet: false,
      timeoutMs: 20_000,
    })
    this.state.redsocksPid = r.pid ?? null

    // 启动后做一次端口确认。探不到（无 ss）时不阻断；明确未监听才是失败。
    const listening = await this.waitForListening(this.slot.ports?.tcp)
    if (listening === false) {
      throw new Error(`redsocks 已启动但端口 ${this.slot.ports.tcp} 未监听（检查 ${confPath} 与代理连通性）`)
    }
    if (listening === null) this.logger.warn('无法探测端口监听状态（缺少 ss），跳过 redsocks 端口确认')
    this.state.redsocksListening = listening === true
    return {
      ok: true,
      detail: `redsocks 监听 ${this.slot.gateway}:${this.slot.ports.tcp} pid=${r.pid ?? 'n/a'}${this.dryRun ? '（dry-run，未启动进程）' : ''}`,
    }
  }

  async undoRedsocks() {
    const pid = this.state.redsocksPid
    const confPath = this.state.redsocksConfPath || (this.fullCleanup ? this.confPath : '')
    if (!pid && !confPath) return { ok: true, detail: '未启动，跳过' }
    if (pid) {
      const r = await this.executor.run('kill', [String(pid)], { check: false, quiet: true, timeoutMs: 10_000 })
      // kill 失败通常意味着进程早就退出了 —— 那正是期望终态
      if (goneOk(r) || this.dryRun) {
        this.state.redsocksPid = null
        return { ok: true, detail: r.ok ? `已终止 redsocks pid=${pid}` : `redsocks pid=${pid} 已不在运行` }
      }
    }
    if (confPath) {
      const r = await this.executor.run('pkill', ['-f', confPath], { check: false, quiet: true, timeoutMs: 10_000 })
      this.state.redsocksPid = null
      return { ok: true, detail: r.ok ? `已按配置路径终止 redsocks` : `redsocks 可能已退出（pkill exit=${r.code}）` }
    }
    return { ok: true, detail: '无需清理' }
  }

  /** 5. DNS 转发器。监听网关地址 —— 网桥不存在时这里会 EADDRNOTAVAIL。 */
  async stepDnsfwd() {
    const listenHost = this.slot.gateway
    const port = this.slot.ports?.dns
    if (!listenHost) throw new Error('槽位缺少网关地址，无法启动 DNS 转发器')

    if (this.dryRun) {
      this.state.dnsListening = `${listenHost}:${port}`
      return { ok: true, detail: `[dry-run] 将启动 dnsfwd ${listenHost}:${port}（mode=tcp, upstream 8.8.8.8）` }
    }
    if (this.state.dnsHandle) {
      return { ok: true, detail: `DNS 转发器已在运行 ${this.state.dnsListening}`, reused: true }
    }

    const handle = await this.dnsForwarder.start({
      proxy: this.proxy || {},
      listenHost,
      port,
      mode: 'tcp',
      upstreams: ['8.8.8.8', '1.1.1.1'],
    })
    if (!handle?.ok) {
      const error = new Error(`DNS 转发器启动失败: ${(handle?.errors || ['未知错误']).join(', ')}`)
      error.code = 'DNSFWD_FAILED'
      throw error
    }
    this.state.dnsHandle = handle
    this.state.dnsListening = handle.listen
    return { ok: true, detail: `dnsfwd 监听 ${handle.listen}（mode=${handle.mode}）` }
  }

  async undoDnsfwd() {
    const handle = this.state.dnsHandle
    if (!handle) return { ok: true, detail: '未启动，跳过' }
    try {
      handle.stop()
      this.state.dnsHandle = null
      return { ok: true, detail: `已停止 DNS 转发器 ${this.state.dnsListening}` }
    } catch (error) {
      return { ok: false, detail: `停止 DNS 转发器失败: ${error?.message || error}` }
    }
  }

  /** 6. persona 落盘。dry-run 只算不写。 */
  async stepPersona() {
    const vmId = this.container
    // overrides 必须带上：不给的话 buildPersona 会退回平台常量主机名，
    // 20 个槽位的 /etc/hostname 全是同一个值（只有 MAC 不同）。
    // 同一份 overrides 在 dry-run 与真落盘两条路径上都用，避免"演练说的"和
    // "实际写的"不一致 —— 那种不一致会让 dry-run 失去意义。
    const overrides = personaOverridesFor(this.platform, this.personaHostname)

    if (this.dryRun) {
      const spec = dockerArgsForPersona({
        platform: this.platform,
        vmId,
        outDir: this.personaDir,
        overrides,
        network: this.slot.network,
        timezone: this.timezone,
      })
      this.state.personaSpec = spec
      this.state.personaDir = spec.outDir
      this.state.personaFiles = spec.files.length
      return { ok: true, detail: `[dry-run] 将落盘 ${spec.files.length} 个 persona 文件到 ${spec.outDir}（hostname=${spec.dockerHostname} mac=${spec.mac}）` }
    }

    // persona 树由 materializePersonaTree 以 0444 写出（只读，防止运行时被改）。
    // 这带来一个真实后果：同一个目录第二次落盘会 EACCES。所以先清空目标目录 ——
    // 这棵树是纯派生物，重建成本几毫秒，删掉再写比逐个 chmod 更可靠。
    this.removeTree(this.personaDir)

    // slotIndex 决定 cpuinfo/meminfo 的确定性变化（CPU 型号、频率、微码）。
    // 不传的话 20 个槽会拿到同一套硬件指纹 —— 那正是要消除的问题。
    const spec = materializePersonaTree({
      platform: this.platform,
      vmId,
      outDir: this.personaDir,
      overrides,
      network: this.slot.network,
      timezone: this.timezone,
      slotIndex: slotIndex(this.slot),
      cores: slotCpuLimit(this.slot),
      // 内存限额必须与容器真实的 memory.max 一致 ——
      // 否则 MemTotal 报 1GB 而 cgroup 是 2.5GB，比值 0.39 一眼看穿。
      //
      // slot 对象里可能没有精确值（fleet-plan 的默认是 1024 而实际给了 2560），
      // 所以优先用 this.state.memoryLimitMb（如果前面读过容器配置）。
      memoryMb: this.state.memoryLimitMb || slotMemoryLimit(this.slot),
    })
    this.state.personaSpec = spec
    this.state.personaDir = spec.outDir
    this.state.personaFiles = spec.written.length
    return {
      ok: true,
      detail: `落盘 ${spec.written.length} 个 persona 文件 → ${spec.outDir}（hostname=${spec.dockerHostname} mac=${spec.mac}）`,
    }
  }

  /**
   * 删除一棵 persona 树。
   *
   * 目录里是 0444 只读文件 —— `fs.rmSync` 在 POSIX 上照样能删（删除权限由父目录
   * 决定，不由文件自身决定），所以不需要先 chmod。这里不做递归 chmod：
   * 那会在只读媒体或 NFS 上引入额外失败面，而收益为零。
   */
  removeTree(dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return { ok: true, detail: `已清理 ${dir}` }
    } catch (error) {
      return { ok: false, detail: `清理失败: ${error?.message || error}` }
    }
  }

  async undoPersona() {
    const dir = this.state.personaDir || (this.fullCleanup ? this.personaDir : '')
    if (!dir) return { ok: true, detail: '未落盘，跳过' }
    // dry-run 下目录从未被创建，绝不能按路径删 —— 那会误删同名真实目录
    if (this.dryRun) return { ok: true, detail: `[dry-run] 将清理 ${dir}` }
    // 只删自己建的目录。persona 树是运行时可重建的派生物，
    // 保留它反而会让下次启动读到上一轮的残留。
    const r = this.removeTree(dir)
    return r.ok
      ? { ok: true, detail: `已清理 persona 目录 ${dir}` }
      : { ok: false, detail: `清理 persona 目录失败: ${r.detail}` }
  }

  /** 7. 启动容器。先 inspect：在跑→复用，存在未跑→start，不存在→run。 */
  async stepContainer() {
    const name = this.container
    const inspect = await this.executor.run('docker', ['inspect', '-f', '{{.State.Running}}', name], {
      check: false,
      quiet: true,
      timeoutMs: 20_000,
    })
    const running = this.dryRun ? null : parseRunning(inspect.stdout)

    if (running === true) {
      this.state.containerRunning = true
      this.state.containerReused = true
      return { ok: true, detail: `容器 ${name} 已在运行，复用`, reused: true }
    }
    if (running === false && inspect.ok) {
      await this.executor.run('docker', ['start', name], { timeoutMs: this.stepTimeoutMs })
      this.state.containerRunning = true
      this.state.containerReused = true
      return { ok: true, detail: `容器 ${name} 已存在但未运行，已 start`, reused: true }
    }

    const net = dockerNetworkArgs({ slot: this.slot, proxy: this.proxy, image: this.image })
    if (!net.ok) throw new Error(`容器网络参数生成失败: ${net.error}`)

    // resolv.conf 必须挂载覆盖。
    //
    // 接自定义 bridge 网络时 docker 会把内嵌解析器 127.0.0.11 写进
    // /etc/resolv.conf，`--dns 8.8.8.8` 只是变成它的转发上游，并不出现在文件里。
    // 也就是说容器实际用的解析器是 docker 的，最终转发到宿主机 resolver ——
    // 这正是 DNS 隔离要消除的那条路径。不覆盖的话，
    // verify 会如实报「解析器落在宿主机路径上: 127.0.0.11」。
    const resolvPath = path.join(this.confDir, `${this.slotId}.resolv.conf`)
    if (!this.dryRun) {
      fs.mkdirSync(this.confDir, { recursive: true })
      fs.writeFileSync(
        resolvPath,
        ['nameserver 8.8.8.8', 'nameserver 1.1.1.1', 'options use-vc', 'options attempts:2', 'search .', ''].join('\n'),
        { mode: 0o644 },
      )
    }
    // 插到镜像名之前。net.args 末尾就是镜像名（dockerNetworkArgs 会 push image），
    // 直接 append 会让 `-v` 落到镜像名之后，被当成容器要执行的命令 —— 表现为 exit=127。
    const imageAt = net.args.lastIndexOf(this.image)
    const insertAt = imageAt >= 0 ? imageAt : net.args.length
    net.args.splice(insertAt, 0, '-v', `${resolvPath}:/etc/resolv.conf:ro`)

    const argv = composeContainerArgv({
      netArgs: net.args,
      personaSpec: this.state.personaSpec,
      image: this.image,
    })
    await this.executor.run(argv[0], argv.slice(1), { timeoutMs: this.stepTimeoutMs })
    this.state.containerRunning = true
    this.state.containerReused = false

    // ── 清掉容器身份标记 ──
    //
    // /.dockerenv 是 runc 建的空文件，任何 `test -e /.dockerenv` 都能判定
    // 自己在容器里 —— 这是最廉价也最普遍的容器检测手段，必须去掉。
    // 它只是个标记文件，删掉不影响容器运行（不像 /proc/1/cgroup 那样是内核视图）。
    //
    // 失败不致命：某些镜像以只读根文件系统启动时删不掉，记录但不阻断启动。
    // dry-run 下不执行任何 docker exec —— 演练看的是命令序列，
    // 真去跑一遍既没意义（容器是假想的）又会污染"执行了什么"的统计。
    let scrubbed = 0
    for (const marker of (this.dryRun ? [] : ['/.dockerenv', '/run/.containerenv'])) {
      const r = await this.executor.run(
        'docker',
        ['exec', '-u', '0', this.container, 'rm', '-f', marker],
        { check: false, quiet: true, timeoutMs: 15_000 },
      )
      if (r.ok) scrubbed += 1
    }
    this.state.containerMarkersScrubbed = scrubbed

    return {
      ok: true,
      detail: `启动容器 ${name}（镜像 ${this.image}，已清 ${scrubbed} 个容器标记）`,
    }
  }

  /**
   * 按代理探测出口地理，在**建容器之前**确定时区。
   *
   * 为什么要在容器之前：容器的 TZ 环境变量只能在 docker run 时设定，
   * 运行中改不了。如果等容器起来再改 /etc/localtime，环境变量 TZ
   * 仍然覆盖它 —— 实测 localtime 已指向洛杉矶但 date 仍报 UTC。
   *
   * 探测走宿主机 + 该槽的 SOCKS5 代理，拿到的就是容器将来会用的出口。
   * 探测失败不阻塞：时区留 null，docker run 不给 TZ，后续 stepTimezone 补救。
   */
  /**
   * 多端点探测出口地理位置。
   *
   * 为什么不能只用一个：ipinfo.io 免费额度很小，20 个槽 × 每次启动
   * 都会算一次，很容易 429。实测就是这样 —— 20 个槽全部探测失败，
   * 时区退回空值，容器报 UTC，与出口 IP 矛盾。
   *
   * 策略：按顺序试，第一个成功的就用。每个端点字段名不同，
   * 统一归一化成 {ip, country, city, timezone}。
   */
  async probeExitGeo() {
    const proxy = this.proxy
    if (!proxy?.host) return { ok: false, reason: 'no_proxy' }
    const hostPort = `${proxy.host}:${proxy.port}`

    // 同进程内按 host:port 缓存。
    //
    // 为什么需要：20 个槽如果都走同一个出口（测试代理就是这种情况），
    // 会把同一个端点查 20 次 —— 直接触发 429。
    // 缓存后只查一次，其余槽复用结果。
    //
    // 用实例上的静态字段而不是模块级变量：FleetRuntime 里 20 个
    // orchestrator 共享同一个进程，实例静态刚好达到"进程内共享"的效果，
    // 又不会污染模块全局状态（单测里每次新建进程自然清空）。
    const cacheKey = hostPort
    const cache = SlotOrchestrator._geoCache || (SlotOrchestrator._geoCache = new Map())
    const cached = cache.get(cacheKey)
    if (cached) return { ...cached, cached: true }

    // 端点按"免费额度宽松度"排序。
    // ip-api.com 免费 45 次/分钟，最宽松，放第一。
    const ENDPOINTS = [
      {
        url: 'http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,timezone,query',
        parse: (j) => (j.status === 'success'
          ? { ip: j.query, country: j.countryCode, city: j.city, timezone: j.timezone }
          : null),
      },
      {
        url: 'https://ifconfig.co/json',
        parse: (j) => (j.ip
          ? { ip: j.ip, country: j.country_iso || '', city: j.city || '', timezone: j.time_zone || '' }
          : null),
      },
      {
        url: 'https://ipinfo.io/json',
        parse: (j) => (j.ip && !j.error
          ? { ip: j.ip, country: j.country || '', city: j.city || '', timezone: j.timezone || '' }
          : null),
      },
      {
        url: 'https://ipapi.co/json/',
        parse: (j) => (j.ip && !j.error
          ? { ip: j.ip, country: j.country_code || '', city: j.city || '', timezone: j.timezone || '' }
          : null),
      },
    ]

    const failures = []
    for (const ep of ENDPOINTS) {
      // HTTP 端点必须用 --socks5（本地解析后连 IP），
      // HTTPS 才能用 --socks5-hostname（让代理解析域名）。
      // 统一用 --socks5-hostname 对 http:// 会失败。
      const socksFlag = ep.url.startsWith('https:') ? '--socks5-hostname' : '--socks5'
      const r = await this.executor.run(
        'curl', ['-s', '-m', '10', socksFlag, hostPort, ep.url],
        { check: false, quiet: true, timeoutMs: 25_000 },
      )
      let geo = null
      try { geo = ep.parse(JSON.parse(String(r.stdout || '').trim())) } catch { /* 跳过 */ }
      if (geo && (geo.country || geo.timezone)) {
        const hit = { ok: true, ...geo, endpoint: ep.url }
        cache.set(cacheKey, hit)
        return hit
      }
      failures.push(`${ep.url.split('/')[2]}:失败`)
    }
    return { ok: false, reason: 'all_endpoints_failed', failures }
  }

  async stepGeoProbe() {
    if (this.dryRun) {
      return { ok: true, detail: `[dry-run] 将经代理探测出口地理以确定时区（当前 ${this.timezone || '未知'}）` }
    }
    // 已经有可信时区（调用方显式给 / 代理 region 能推出来）就不必探测
    if (this.timezone && this.timezoneSource !== 'unknown') {
      this.state.geo = { skipped: true, timezone: this.timezone, source: this.timezoneSource }
      return { ok: true, detail: `时区已由 ${this.timezoneSource} 确定为 ${this.timezone}，跳过探测` }
    }
    const proxy = this.proxy
    if (!proxy?.host) {
      this.state.geo = { ok: false, reason: 'no_proxy' }
      return { ok: true, detail: '未绑定代理，跳过出口地理探测' }
    }

    const probed = await this.probeExitGeo()
    if (!probed.ok) {
      this.state.geo = { ok: false, reason: probed.reason, failures: probed.failures }
      return {
        ok: true,
        detail: `出口地理探测失败（${(probed.failures || []).join(', ')}），时区留待容器内回填`,
      }
    }
    const geo = probed

    const derived = timezoneForExit({
      country: geo.country || '',
      city: geo.city || '',
      timezone: geo.timezone || '',
    })
    this.timezone = derived.timezone
    this.timezoneSource = derived.source
    this.state.geo = {
      ok: true, ip: geo.ip, country: geo.country, city: geo.city,
      timezone: derived.timezone, source: derived.source, confidence: derived.confidence,
    }
    return {
      ok: true,
      detail: `出口 ${geo.ip} ${geo.country}/${geo.city} → 时区 ${derived.timezone || '未知'}（${derived.source}）`,
    }
  }

  /**
   * 9. UTS 伪装（内核 release / version）。
   *
   * 必须在容器启动之后做：uts_ns 是跟着容器 namespace 走的，
   * 容器一重建就回到宿主内核的值，所以每次 up 都要重新施加。
   *
   * 依赖宿主机加载了 liveapi_uts.ko。没加载时这一步跳过而不是报错 ——
   * 内核模块属于宿主环境准备，不该让单个槽位的启动失败。
   */
  async stepUts() {
    if (this.dryRun) {
      const planned = utsForSlot({ vmId: this.slotId, index: slotIndex(this.slot) })
      return {
        ok: true,
        detail: `[dry-run] 将设 uname -r = ${planned.release}（需宿主加载 liveapi_uts.ko）`,
      }
    }

    // 先确认模块在
    const mod = await this.executor.run('grep', ['-q', 'liveapi_uts', '/proc/modules'], {
      check: false, quiet: true, timeoutMs: 10_000,
    })
    if (!mod.ok) {
      this.state.uts = { applied: false, reason: 'module_not_loaded' }
      return { ok: true, detail: '跳过：宿主未加载 liveapi_uts.ko（uname 保持宿主值）' }
    }

    // 容器主进程 pid
    const pidOut = await this.executor.run(
      'docker', ['inspect', '-f', '{{.State.Pid}}', this.container],
      { check: false, quiet: true, timeoutMs: 15_000 },
    )
    const pid = Number(String(pidOut.stdout || '').trim())
    if (!Number.isInteger(pid) || pid <= 0) {
      this.state.uts = { applied: false, reason: 'no_pid' }
      return { ok: false, detail: `取容器 pid 失败: ${(pidOut.stderr || '').trim()}` }
    }

    // distro 必须与 persona 里的 software.distro_id 一致 ——
    // 否则 uname -r 报 -generic，而 /etc/os-release 说自己是 Debian，
    // 两处对不上比不伪造更显眼。
    // personaSpec 里已按同一口径算过，直接取用，不重复计算。
    const distro = this.state.personaSpec?.distro || null
    const uts = utsForSlot({
      vmId: this.slotId,
      index: slotIndex(this.slot),
      distro,
      release: this.state.personaSpec?.kernelRelease || null,
    })
    const payload = utsWritePayload({ pid, ...uts })

    // 写 /proc/liveapi_uts。用 sh -c 是因为要重定向 ——
    // 模块只提供 write 接口，没有 ioctl。
    const w = await this.executor.run(
      'sh', ['-c', `printf '%s\n' ${JSON.stringify(payload)} > /proc/liveapi_uts`],
      { check: false, quiet: true, timeoutMs: 15_000 },
    )
    if (!w.ok) {
      this.state.uts = { applied: false, reason: 'write_failed', uts }
      return {
        ok: false,
        detail: `写 /proc/liveapi_uts 失败: ${(w.stderr || '').trim().slice(0, 120)}`,
      }
    }

    this.state.uts = { applied: true, ...uts }

    // 回读确认真的生效了（写接口成功不代表读到的是新值）
    const check = await this.executor.run(
      'docker', ['exec', this.container, 'uname', '-r'],
      { check: false, quiet: true, timeoutMs: 15_000 },
    )
    const actual = String(check.stdout || '').trim()
    if (actual && actual !== uts.release) {
      this.state.uts.verified = false
      return {
        ok: false,
        detail: `写入成功但 uname -r 仍是 ${actual}（期望 ${uts.release}）`,
      }
    }
    this.state.uts.verified = true
    return { ok: true, detail: `uname -r = ${uts.release}（已回读确认）` }
  }

  /**
   * 按真实出口 IP 回填时区。
   *
   * 为什么必须做：容器内 `curl ipinfo.io` 直接能拿到出口 IP 的国家/城市/时区。
   * 出口在洛杉矶而系统报 UTC —— 是**一眼可见**的矛盾，比不伪装更糟。
   *
   * 顺序：container 之后、verify 之前。因为必须先有容器才能从里面探测
   * （探测要经该槽的代理，才能拿到真实出口而不是宿主机出口）。
   *
   * 探测失败不阻塞启动：时区不一致是"可疑"，起不来的槽是"不可用"，
   * 后者更严重。失败时保留已推导的值并记录原因。
   */
  async stepTimezone() {
    if (this.dryRun) {
      return { ok: true, detail: `[dry-run] 将按出口 IP 校正时区（当前推导值 ${this.timezone || '未知'}）` }
    }

    // 容器内探测出口地理。用 ipinfo.io 因为它直接返回 timezone 字段，
    // 不需要自己按经纬度推算。
    const probe = await this.executor.run(
      'docker',
      ['exec', this.container, 'sh', '-c',
        'curl -s -m 12 https://ipinfo.io/json 2>/dev/null || wget -qO- -T 12 https://ipinfo.io/json 2>/dev/null'],
      { check: false, quiet: true, timeoutMs: 30_000 },
    )

    let geo = null
    const raw = String(probe.stdout || '').trim()
    if (raw) {
      try { geo = JSON.parse(raw) } catch { /* 非 JSON，下面按失败处理 */ }
    }

    if (!geo || (!geo.timezone && !geo.country)) {
      this.state.timezone = {
        applied: false,
        reason: 'probe_failed',
        kept: this.timezone,
      }
      return {
        ok: true,
        detail: `出口地理探测失败，保留推导值 ${this.timezone || '(未设)'}`,
      }
    }

    const derived = timezoneForExit({
      country: geo.country || '',
      city: geo.city || '',
      timezone: geo.timezone || '',
    })

    if (!derived.timezone) {
      this.state.timezone = { applied: false, reason: 'unknown_geo', geo, kept: this.timezone }
      return {
        ok: true,
        detail: `出口在 ${geo.country || '?'}/${geo.city || '?'}，无法确定时区，保留 ${this.timezone || '(未设)'}`,
      }
    }

    // 写进容器：/etc/localtime 与 /etc/timezone 都要改。
    // 只改 $TZ 不改 /etc/localtime，`ls -l /etc/localtime` 会显示 UTC，
    // 而 `date` 显示当地时间 —— 两处对不上。
    const tzFile = `/usr/share/zoneinfo/${derived.timezone}`
    // 关键：只改 /etc/localtime 不够 —— 环境变量 TZ 优先级更高。
    // 实测：localtime 已指向 America/Los_Angeles，但容器里 TZ=UTC，
    // `date` 仍报 UTC。而运行中容器的 env 改不了（docker 不支持）。
    //
    // 三个地方一起改：
    //   1. /etc/localtime   → 给不看 TZ 的程序
    //   2. /etc/timezone    → Debian 系的惯例文件
    //   3. /etc/profile.d/  → 给登录 shell，让 $TZ 正确
    // 第 3 条对已经起来的进程无效，但 Claude Code 是新起的子进程，
    // 走 /bin/sh -c 时会读到 profile（如果用 login shell）。
    // 更彻底的做法是 docker run 时就给对 TZ，那需要先探测出口 ——
    // 见 docs 里的说明。
    const cmd = [
      `if [ -f ${tzFile} ]; then`,
      `  ln -sf ${tzFile} /etc/localtime`,
      `  echo '${derived.timezone}' > /etc/timezone 2>/dev/null || true`,
      `  mkdir -p /etc/profile.d`,
      `  printf 'export TZ=%s\\n' '${derived.timezone}' > /etc/profile.d/00-timezone.sh 2>/dev/null || true`,
      // 同时写 /etc/environment（PAM 读它）
      `  printf 'TZ=${derived.timezone}\\n' >> /etc/environment 2>/dev/null || true`,
      '  echo ok',
      'else',
      '  echo no-zoneinfo',
      'fi',
    ].join('\n')

    const applied = await this.executor.run(
      'docker', ['exec', '-u', '0', this.container, 'sh', '-c', cmd],
      { check: false, quiet: true, timeoutMs: 20_000 },
    )

    this.timezone = derived.timezone
    this.state.timezone = {
      applied: String(applied.stdout || '').trim() === 'ok',
      timezone: derived.timezone,
      source: derived.source,
      confidence: derived.confidence,
      exitIp: geo.ip || null,
      exitCountry: geo.country || null,
      exitCity: geo.city || null,
    }

    if (this.state.timezone.applied) {
      return {
        ok: true,
        detail: `时区 ${derived.timezone}（出口 ${geo.country}/${geo.city}，${derived.source}）`,
      }
    }
    // zoneinfo 缺失：Ubuntu 镜像装了 tzdata 才有，
    // 精简镜像可能需要 apt install tzdata。不阻塞启动。
    return {
      ok: true,
      detail: `时区推导为 ${derived.timezone} 但容器无 zoneinfo 文件，仅设 TZ`,
    }
  }

  async undoContainer() {
    if (!this.state.containerRunning && !this.fullCleanup) return { ok: true, detail: '未启动，跳过' }
    const r = await this.executor.run('docker', ['rm', '-f', this.container], {
      check: false,
      quiet: true,
      timeoutMs: 60_000,
    })
    this.state.containerRunning = false
    const ok = this.dryRun || goneOk(r)
    return {
      ok,
      detail: r.ok || this.dryRun ? `已删除容器 ${this.container}` : ok ? `容器 ${this.container} 本就不存在` : `删除容器失败: ${(r.stderr || '').trim()}`,
    }
  }

  /** 8. 验证。出口 + 身份，任一失败即启动失败。 */
  async stepVerify() {
    // dry-run 下 exec 全部被跳过，探测结果必然为空 —— 此时跑判定只会产出
    // 一堆假失败。演练的意义是「看命令序列」，不是「验证一个不存在的容器」。
    if (this.dryRun) {
      this.state.verify = { ok: true, skipped: true, reason: 'dry-run', checks: [] }
      const planned = preflightEgress({ proxy: this.proxy, slot: this.slot })
      return {
        ok: true,
        detail: `[dry-run] 将验证出口（${planned.skipped ? `跳过：${planned.reason}` : '出口 IP / DNS / 直连隔离'}）与 persona 自检`,
      }
    }

    const results = {}
    const problems = []

    if (this.verifyEgressEnabled) {
      const pre = preflightEgress({ proxy: this.proxy, slot: this.slot })
      if (pre.skipped) {
        results.egress = { ok: true, skipped: true, reason: pre.reason, checks: [] }
        this.logger.warn(`出口验证跳过: ${pre.reason}`)
      } else {
        const exec = async ({ container, argv, timeoutMs }) => {
          const r = await this.executor.run('docker', ['exec', container, ...argv], {
            check: false,
            quiet: true,
            timeoutMs: timeoutMs || 20_000,
          })
          return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, code: r.code }
        }
        const report = await verifyEgress({
          slotId: this.slotId,
          proxy: this.proxy,
          slot: { ...this.slot, container: this.container },
          exec,
          hostProbe: this.hostProbe || undefined,
        })
        results.egress = report
        if (!report.ok) problems.push(`出口验证失败: ${(report.failed || []).join('; ') || report.error || '未知'}`)
      }
    } else {
      results.egress = { ok: true, skipped: true, reason: 'verifyEgress 已关闭', checks: [] }
    }

    if (this.verifyPersonaEnabled) {
      const exec = async ({ command, args }) => {
        const r = await this.executor.run('docker', ['exec', this.container, command, ...(args || [])], {
          check: false,
          quiet: true,
          timeoutMs: 15_000,
        })
        return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, code: r.code }
      }
      // readFile 必须也走容器。
      // 用默认的 fs.readFileSync 会读**宿主机**的文件系统 —— 于是
      // /etc/machine-id 拿到宿主机的值，跟 persona 期望值不等，报"自检失败"，
      // 而容器里的值其实是对的。这个错误极其隐蔽：失败信息看起来
      // 就像是 persona 没落盘。
      // readFile 是同步签名，而 docker exec 是异步的 —— 用 execFileSync 单独走一条。
      // 这是 verify 唯一需要同步 IO 的地方（它只在报告里读几个小文件）。
      const readFileInContainer = (absPath) => {
        try {
          return execFileSync('docker', ['exec', this.container, 'cat', absPath], {
            encoding: 'utf8',
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        } catch (error) {
          // 抛错 = 容器内读不到，verify 会记为该项失败而不是崩溃
          throw new Error(`read ${absPath} in container failed: ${error?.message || error}`)
        }
      }
      const report = await verifyPersonaInContainer(this.state.personaSpec?.persona, {
        root: '/',
        exec,
        readFile: readFileInContainer,
        // 虚拟化方式决定 uname -r 能不能被伪造：kvm 有独立内核，docker 共享宿主机内核。
        // 不传的话 verify 会按 docker 处理，kvm 槽位就永远查不出内核不匹配。
        runtimeKind: this.runtimeKind || 'docker',
      })
      results.persona = report
      if (!report.ok) {
        const detail = (report.failed || []).slice(0, 3).map((c) => `${c.name}: ${c.expected} ≠ ${c.actual}`).join('; ')
        problems.push(`persona 自检失败 (${report.summary}): ${detail}`)
      }
    } else {
      results.persona = { ok: true, skipped: true, reason: 'verifyPersona 已关闭', checks: [] }
    }

    this.state.verify = results.egress
    this.state.personaVerify = results.persona

    if (problems.length) {
      const error = new Error(`槽位 ${this.slotId} 验证未通过:\n  ${problems.join('\n  ')}`)
      error.code = 'VERIFY_FAILED'
      error.detail = results
      throw error
    }
    const egressSummary = results.egress?.skipped ? '出口验证跳过' : results.egress?.summary || '出口 ok'
    const personaSummary = results.persona?.skipped ? '身份自检跳过' : results.persona?.summary || '身份 ok'
    return { ok: true, detail: `${egressSummary} / ${personaSummary}` }
  }

  async undoVerify() {
    // 验证失败不产生资源，清理交给前面的 undo
  }

  // ─────────────────────── 编排 ───────────────────────

  /**
   * 步骤表。name 与 STEP_ORDER 一一对应。
   *
   * sideEffects 决定该步是否需要回滚：preflight 与 verify 只读不写，
   * 把它们放进回滚栈只会让回滚日志里出现两条「无操作」，掩盖真正被清理的
   * 资源。有副作用的六步才是回滚对象。
   */
  get steps() {
    return [
      { name: 'preflight', sideEffects: false, run: () => this.stepPreflight(), undo: () => this.undoPreflight() },
      { name: 'network', sideEffects: true, run: () => this.stepNetwork(), undo: () => this.undoNetwork() },
      { name: 'iptables', sideEffects: true, run: () => this.stepIptables(), undo: () => this.undoIptables() },
      { name: 'redsocks', sideEffects: true, run: () => this.stepRedsocks(), undo: () => this.undoRedsocks() },
      { name: 'dnsfwd', sideEffects: true, run: () => this.stepDnsfwd(), undo: () => this.undoDnsfwd() },
      // geo 必须在 persona 之前 —— persona 要把时区写进 docker run 参数，
      // 而容器的 TZ 环境变量只有建容器那一刻能设。
      { name: 'geo', sideEffects: false, run: () => this.stepGeoProbe(), undo: async () => ({ ok: true, detail: '无需回滚' }) },
      { name: 'persona', sideEffects: true, run: () => this.stepPersona(), undo: () => this.undoPersona() },
      { name: 'container', sideEffects: true, run: () => this.stepContainer(), undo: () => this.undoContainer() },
      // uts 没有 undo：容器删了 namespace 就没了，不需要清理
      // timezone 要在 uts 之前：uts 改的是内核标识，timezone 改的是
      // 用户可见的时间。两者都与"这台机器在哪"有关，先定地理位置。
      { name: 'timezone', sideEffects: false, run: () => this.stepTimezone(), undo: async () => ({ ok: true, detail: '无需回滚' }) },
      { name: 'uts', sideEffects: false, run: () => this.stepUts(), undo: async () => ({ ok: true, detail: '无需回滚' }) },
      { name: 'verify', sideEffects: false, run: () => this.stepVerify(), undo: () => this.undoVerify() },
    ]
  }

  /** 只产出计划（不执行）：每一步将要做什么。CLI 的 plan / dry-run 用。 */
  plan() {
    const s = this.slot
    const proxyLabel = this.proxy ? `${this.proxy.id || '?'} ${this.proxy.host || '?'}:${this.proxy.port || '?'}` : '（未绑定）'
    return [
      { step: 1, name: 'preflight', action: '检查 OS/root/iptables/redsocks/docker/netfilter/KVM', command: 'iptables -t nat -L -n; docker info' },
      { step: 2, name: 'network', action: `建 docker network ${s.network}（${s.subnet}，网关 ${s.gateway}，网桥 ${s.bridge}）`, command: shellJoin(createNetworkArgs({ slot: s }).args) },
      { step: 3, name: 'iptables', action: `应用 ${s.chain} 链：tcp→:${s.ports?.tcp}、tcp/53→:${s.ports?.dns}、FORWARD DROP`, command: `iptables -t nat -N ${s.chain} …` },
      { step: 4, name: 'redsocks', action: `启动 redsocks，监听 ${s.gateway}:${s.ports?.tcp}，上游 ${proxyLabel}`, command: `redsocks -c ${this.confPath}` },
      { step: 5, name: 'dnsfwd', action: `启动 DNS 转发器，监听 ${s.gateway}:${s.ports?.dns}（TCP over SOCKS5 → 8.8.8.8:53）`, command: `dnsfwd listenHost=${s.gateway} port=${s.ports?.dns}` },
      { step: 6, name: 'geo', action: `经 ${proxyLabel} 探测出口地理，确定时区（不阻塞）`, command: `curl -s --socks5-hostname ${this.proxy?.host || 'HOST'}:${this.proxy?.port || 'PORT'} https://ipinfo.io/json` },
      { step: 7, name: 'persona', action: `落盘 persona 文件到 ${this.personaDir}（hostname=${this.personaHostname || '(平台缺省)'}，TZ=${this.timezone || '待探测'}）`, command: `dockerArgsForPersona(vmId=${this.container})` },
      { step: 8, name: 'container', action: `启动容器 ${this.container}（镜像 ${this.image}，挂载 persona 只读）`, command: 'docker run -d --network … --mac-address … --cpuset-cpus … -e TZ=… -v …' },
      { step: 9, name: 'timezone', action: `容器内二次校正时区（已推导 ${this.timezone || '待探测'}）`, command: 'docker exec … ln -sf /usr/share/zoneinfo/<tz> /etc/localtime' },
      { step: 10, name: 'uts', action: `设 uname -r = ${utsForSlot({ vmId: this.container, index: slotIndex(this.slot) }).release}（需宿主 liveapi_uts.ko）`, command: `echo "<pid> ${utsForSlot({ vmId: this.container, index: slotIndex(this.slot) }).release} <version>" > /proc/liveapi_uts` },
      { step: 11, name: 'verify', action: '验证出口 IP / DNS / 直连隔离 + persona 自检', command: 'docker exec … node -e …' },
    ]
  }

  /**
   * 按顺序启动。失败自动回滚已完成的步骤。
   * @returns {Promise<{ok:boolean, slotId:string, steps:Array, error:string|null, rolledBack:Array}>}
   */
  async up() {
    const report = { ok: false, slotId: this.slotId, dryRun: this.dryRun, steps: [], error: null, rolledBack: [] }
    this.completed = []
    this.lastError = null

    this.logger.info(`── 槽位 ${this.slotId} 启动${this.dryRun ? '（dry-run）' : ''} ──`)

    for (const step of this.steps) {
      const startedAt = Date.now()
      this.logger.info(`[${this.slotId}] ▶ ${step.name}`)
      try {
        const result = (await step.run()) || { ok: true }
        const elapsedMs = Date.now() - startedAt
        report.steps.push({
          name: step.name,
          ok: true,
          detail: result.detail || 'ok',
          reused: Boolean(result.reused),
          elapsedMs,
        })
        this.logger.info(`[${this.slotId}] ✓ ${step.name} (${elapsedMs}ms) ${result.detail || ''}`)
        if (step.sideEffects !== false) this.completed.push(step)
      } catch (error) {
        const elapsedMs = Date.now() - startedAt
        const message = String(error?.message || error)
        report.steps.push({
          name: step.name,
          ok: false,
          detail: message,
          code: error?.code || 'STEP_FAILED',
          elapsedMs,
        })
        this.logger.error(`[${this.slotId}] ✗ ${step.name} (${elapsedMs}ms): ${message}`)
        this.lastError = error
        report.error = `${step.name}: ${message}`

        // 逆序回滚已完成的步骤
        report.rolledBack = await this.rollback()
        report.ok = false
        return report
      }
    }

    report.ok = true
    this.logger.info(`── 槽位 ${this.slotId} 就绪（${report.steps.length} 步）──`)
    return report
  }

  /** 逆序回滚已完成步骤。单个 undo 失败不阻断其余清理。 */
  async rollback() {
    const results = []
    const stack = [...this.completed].reverse()
    this.completed = []
    for (const step of stack) {
      try {
        const r = (await step.undo()) || { ok: true }
        results.push({ name: step.name, ok: r.ok !== false, detail: r.detail || '' })
        this.logger.info(`[${this.slotId}] ↩ 回滚 ${step.name}: ${r.detail || ''}`)
      } catch (error) {
        results.push({ name: step.name, ok: false, detail: String(error?.message || error) })
        this.logger.error(`[${this.slotId}] ↩ 回滚 ${step.name} 失败: ${error?.message || error}`)
      }
    }
    return results
  }

  /** 逆序停止全部资源（等同完整回滚）。可重复调用。 */
  async down() {
    const report = { ok: true, slotId: this.slotId, dryRun: this.dryRun, steps: [] }
    // 完整清理：按 STEP_ORDER 逆序执行所有有副作用步骤的 undo，
    // 无论当前是否记录为「已完成」。这样即使上一个进程崩在中途、
    // 本进程只看到残留资源，也能清干净。
    const stack = [...this.steps].reverse().filter((s) => s.sideEffects !== false)
    // 全量清理：不看本地状态标记，按资源名字逐个尝试。这样「先崩后清」
    // 和「清理一个从未在本进程启动过的槽位」都能走到实际命令。
    this.fullCleanup = true
    for (const step of stack) {
      try {
        const r = (await step.undo()) || { ok: true }
        report.steps.push({ name: step.name, ok: r.ok !== false, detail: r.detail || '' })
        if (r.ok === false) report.ok = false
      } catch (error) {
        report.ok = false
        report.steps.push({ name: step.name, ok: false, detail: String(error?.message || error) })
      }
    }
    this.completed = []
    this.fullCleanup = false
    return report
  }

  /** 运行状态总览（只读探测，不改变任何资源）。 */
  async status() {
    const s = this.slot
    const out = {
      slotId: this.slotId,
      container: this.container,
      proxyId: this.proxy?.id || null,
      network: { name: s.network, exists: false, detail: '' },
      iptables: { chain: s.chain, present: false, detail: '' },
      redsocks: { port: s.ports?.tcp, listening: null, detail: '' },
      dnsfwd: { port: s.ports?.dns, listening: null, detail: '' },
      containerState: { running: false, detail: '' },
      healthy: false,
    }

    if (this.dryRun) {
      out.detail = 'dry-run：状态探测被跳过'
      return out
    }

    const inspect = inspectNetworkArgs({ slot: s })
    const net = await this.executor.run(inspect[0], inspect.slice(1), { check: false, quiet: true, timeoutMs: 15_000 })
    out.network.exists = net.ok
    out.network.detail = net.ok ? String(net.stdout).trim() : '不存在'

    const chain = await this.executor.run('iptables', ['-t', 'nat', '-L', s.chain, '-n'], {
      check: false,
      quiet: true,
      timeoutMs: 10_000,
    })
    out.iptables.present = chain.ok
    out.iptables.detail = chain.ok ? '链存在' : '链不存在'

    out.redsocks.listening = await this.isListening(s.ports?.tcp)
    out.dnsfwd.listening = await this.isListening(s.ports?.dns)

    const c = await this.executor.run('docker', ['inspect', '-f', '{{.State.Running}}', this.container], {
      check: false,
      quiet: true,
      timeoutMs: 15_000,
    })
    out.containerState.running = parseRunning(c.stdout) === true
    out.containerState.detail = c.ok ? String(c.stdout).trim() : '容器不存在'

    // 转发层必须参与健康判定。
    // redsocks 是整条出口链路的唯一跳板：它挂了容器还活着、网桥还在、
    // 链也在，但每个出站请求都会超时。只看前四项会把这种情况报成健康，
    // 而故障现场表现为"服务在跑但所有请求失败"，最难定位。
    //
    // listening 为 null 表示"无法判定"（目标机没有 ss/netstat），
    // 那种情况不能判不健康，否则精简镜像永远报红。
    const forwardUp = out.redsocks.listening !== false && out.dnsfwd.listening !== false
    out.healthy = out.network.exists && out.iptables.present && out.containerState.running && forwardUp
    out.forward = {
      ok: forwardUp,
      redsocks: out.redsocks.listening,
      dnsfwd: out.dnsfwd.listening,
      detail: forwardUp
        ? '转发层在听'
        : `转发层未就绪：redsocks=${String(out.redsocks.listening)} dnsfwd=${String(out.dnsfwd.listening)}`,
    }
    return out
  }
}

export default SlotOrchestrator
