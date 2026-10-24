/**
 * 平台 persona：一份身份数据，多种视图渲染
 *
 * 设计原则 — 单一真值源（single source of truth）
 *
 *   一份 persona 对象 → render 出所有平台视图（uname / sw_vers / system_profiler /
 *   WMI / DMI / /etc/* 等）。任何视图都不许自己保存副本，必须从 persona 派生。
 *
 *   这样做的原因：真实机器上，同一事实在不同接口暴露时必须一致。
 *   如果 `uname -n`、`scutil --get ComputerName`、`/etc/hostname` 各存一份字符串，
 *   迟早会漂移，而漂移就是最容易被识破的特征。
 *
 * 加新平台：在本目录加一个 <platform>.mjs，导出 { KEY, DEFAULTS, render, validateViews }，
 * 然后在 index.mjs 的 REGISTRY 里注册。其余代码不需要改动。
 */

import * as macos from './macos.mjs'
import { osReleaseForSlot } from './os-release-fake.mjs'
import { utsForSlot } from './uts-fake.mjs'
import * as windows from './windows.mjs'
import * as linux from './linux.mjs'

/** 已注册的平台实现 */
export const REGISTRY = Object.freeze({
  macos,
  windows,
  linux,
})

/** 支持的平台标识 */
export const PLATFORMS = Object.freeze(Object.keys(REGISTRY))

export function isSupportedPlatform(platform) {
  return Object.hasOwn(REGISTRY, String(platform))
}

/**
 * 取某平台的默认 persona 骨架。
 * @param {'macos'|'windows'|'linux'} platform
 */
export function platformDefaults(platform) {
  const impl = REGISTRY[platform]
  if (!impl) throw new Error(`unsupported platform: ${platform}`)
  return structuredClone(impl.DEFAULTS)
}

/**
 * 构造一份完整 persona。
 *
 * @param {object} spec
 * @param {'macos'|'windows'|'linux'} spec.platform
 * @param {string} spec.vmId
 * @param {object} [spec.overrides] 覆盖到默认骨架上的字段（浅合并，嵌套对象深合并一层）
 * @returns {object} 冻结的 persona
 */
/**
 * 由 vmId 推导一个稳定且唯一的默认主机名。
 *
 * 风格对齐真实云主机（ip-10-0-1-11 这一类），因为这是最常见的真实形态；
 * 关键是同一 vmId 永远得到同一个名字（重启不能变），不同 vmId 撞不上。
 *
 * 用 FNV-1a 而不是 crypto hash：这里不需要抗碰撞强度，只要短、稳、无依赖。
 */
function deriveHostnameFor(platform, vmId) {
  const raw = String(vmId || 'default')
  let hash = 0x811c9dc5
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  // 严格对齐 AWS 内网主机名的形状：ip-10-<a>-<b>-<c>，三段各自 0-255。
  // 校验器（persona 的 hostname_cloud_pattern）会拒绝越界值，
  // 所以这里必须真正落在这个范围内，不能只是"看起来像"。
  const a = hash % 256
  const b = (hash >>> 8) % 256
  const c = (hash >>> 16) % 256
  if (platform === 'windows') return `WIN-${String(hash % 0xffff).toString(16).toUpperCase().padStart(4, '0')}`
  if (platform === 'macos') return `Mac-${String(hash % 0xffff).toString(16).padStart(4, '0')}.local`
  return `ip-10-${a}-${b}-${c}`
}

export function buildPersona({ platform, vmId, overrides = {} }) {
  const impl = REGISTRY[platform]
  if (!impl) throw new Error(`unsupported platform: ${platform}`)

  const base = platformDefaults(platform)

  // 主机名必须随 vmId 变，不能只吃平台默认值。
  //
  // 平台默认（linux 是 ip-10-0-1-23）是个固定串，不填的话每个 vmId 都得到
  // 同一个 hostname —— 实测确认过：audit-a / slot-01 / vm-2 全部是
  // ip-10-0-1-23，而 product_uuid 是正确的各不相同。
  //
  // 集群路径（materializeFleet → hostnameOverrides）会覆盖它，所以 20 槽位
  // 部署看起来没问题；但任何绕过 orchestrator 的直接调用都会产出相同
  // hostname，两台"不同机器"报出同一个主机名，这本身就是最明显的合成痕迹。
  //
  // 只在调用方没显式给 hostname 时才推导，保持 overrides 优先级不变。
  const explicitName = overrides?.naming?.hostname
    || overrides?.naming?.computer_name
    || overrides?.naming?.local_hostname
  // macOS 的 hostname 牵涉三个必须互相同步的字段
  // （hostname / local_hostname / computer_name，分别对应 scutil 的
  //  LocalHostName 与 ComputerName）。只改 hostname 会让 persona 内部
  // 不一致，validateViews 直接拒绝 —— 这一点校验器做得对。
  // 所以按平台用不同的覆盖形状，与 fleet-plan 的 hostnameOverrides 对齐。
  // software（发行版 / 内核）同样必须随槽位变。
  //
  // 改之前是写死的 Ubuntu 24.04 + 6.8 内核，两个问题：
  //   1. 20 个槽完全一样
  //   2. 与容器内真实 uname -r（5.15）矛盾
  //
  // 现在按 vmId 从池里选，并让内核后缀跟随发行版 ——
  // Ubuntu 配 -generic、Debian 配 -amd64、Rocky 配 .el9.x86_64。
  // 发行版与内核后缀不匹配是明显的伪造痕迹（-generic 是 Ubuntu 专有）。
  const autoSoftware = (() => {
    if (platform !== 'linux') return null
    // 用 vmId 尾部数字做轮转，与 procfs/uts 的选择口径一致
    const m = String(vmId).match(/(\d+)$/)
    const idx = m ? Math.max(0, Number(m[1]) - 1) : 0
    const r = osReleaseForSlot({ vmId, index: idx })
    const distro = r.id
    // kernel 值与 stepUts 写进 uts_ns 的必须是同一份 ——
    // 否则 persona.json 里报一个内核版本，uname -r 报另一个，
    // 两处对不上比不伪造更容易被识别。统一从 utsForSlot 取。
    const uts = utsForSlot({ vmId, index: idx, distro })
    return {
      distro_id: r.id,
      distro_name: r.name,
      // 不能从 pretty 里正则剥前缀 —— "Debian GNU/Linux 11 (bullseye)"
      // 里的斜杠会被误当分隔符，剥出 "/Linux 11"。直接用 r.version。
      distro_version: r.displayVersion || r.version,
      distro_codename: r.codename.toLowerCase().replace(/\s+/g, '-'),
      kernel_release: uts.release,
      kernel_version: uts.version,
      libc: r.id === 'ubuntu' ? 'glibc 2.35' : r.id === 'debian' ? 'glibc 2.31' : 'glibc 2.34',
    }
  })()

  const autoName = deriveHostnameFor(platform, vmId)
  const autoNaming = explicitName
    ? {}
    : platform === 'macos'
      ? { naming: { hostname: autoName, local_hostname: autoName.replace(/\.local$/, ''), computer_name: autoName.replace(/\.local$/, '') } }
      : platform === 'windows'
        ? { naming: { computer_name: String(autoName).toUpperCase() } }
        : { naming: { hostname: autoName } }

  // 顺序：base → software → naming → overrides
  // software 在 naming 之前，但都在 overrides 之前 —— 调用方显式给的
  // 发行版/内核仍然优先，这是保持向后兼容的关键。
  const autoSoftwarePatch = autoSoftware ? { software: autoSoftware } : {}
  const merged = deepMerge(deepMerge(deepMerge(base, autoSoftwarePatch), autoNaming), overrides)
  merged.platform = platform
  merged.vm_id = String(vmId)

  const persona = impl.normalize(merged)

  // 两道检查都要跑：
  //   1. validate      —— persona 内部字段之间的约束
  //   2. validateViews —— 渲染出的各视图之间是否字面一致
  // 只做第 1 道会漏掉「字段各自合法、但渲染出来互相矛盾」的情况，
  // 而后者恰恰是最容易被交叉验证发现的问题。
  const issues = [
    ...impl.validate(persona),
    ...impl.validateViews({ persona, ...impl.render(persona) }),
  ]
  if (issues.length > 0) {
    const detail = issues.map((i) => `  - [${i.code}] ${i.text}`).join('\n')
    throw new Error(`persona is not self-consistent for ${platform}:\n${detail}`)
  }
  return Object.freeze(persona)
}

/**
 * 渲染某平台的全部视图。
 *
 * @returns {{ files: Record<string,string>, commands: Record<string,string> }}
 *   files    — 要落盘的文件（相对路径 → 内容）
 *   commands — 伪命令的输出（命令名 → stdout）
 */
export function renderViews(persona) {
  const impl = REGISTRY[persona.platform]
  if (!impl) throw new Error(`unsupported platform: ${persona.platform}`)
  return impl.render(persona)
}

/**
 * 交叉校验：确认同一事实在所有视图里取值一致。
 *
 * 这是唯一能系统性防住「各视图各存一份、时间久了漂移」的手段。
 * 返回空数组表示所有视图互相自洽。
 *
 * @param {object} persona
 * @returns {Array<{code:string, text:string, views?:string[]}>}
 */
export function crossCheckViews(persona) {
  const impl = REGISTRY[persona.platform]
  if (!impl) throw new Error(`unsupported platform: ${persona.platform}`)
  const { files, commands } = renderViews(persona)
  return impl.validateViews({ persona, files, commands })
}

/**
 * 完整审计：persona 内部约束 + 跨视图一致性 + 平台特定规则。
 *
 * @returns {Array<{code:string, text:string, severity:'error'|'warn'}>}
 */
export function auditPersona(persona, { includeWarnings = true } = {}) {
  const impl = REGISTRY[persona.platform]
  if (!impl) throw new Error(`unsupported platform: ${persona.platform}`)

  const out = []
  for (const i of impl.validate(persona)) out.push({ severity: 'error', ...i })
  for (const i of crossCheckViews(persona)) out.push({ severity: 'error', ...i })
  if (typeof impl.warnings === 'function') {
    for (const i of impl.warnings(persona)) out.push({ severity: 'warn', ...i })
  }
  return includeWarnings ? out : out.filter((i) => i.severity === 'error')
}

/**
 * 只返回错误级别的审计项。用于构建期断言。
 */
export function assertPersonaConsistent(persona) {
  const errors = auditPersona(persona, { includeWarnings: false })
  if (errors.length > 0) {
    const detail = errors.map((i) => `  - [${i.code}] ${i.text}`).join('\n')
    throw new Error(`persona failed consistency check:\n${detail}`)
  }
  return true
}

// ─────────────── 执行层 ───────────────
//
// 上面这些函数只生成「这份身份应该长什么样」。下面的模块把它接进运行环境，
// 缺了这一层，生成出来的文件就只是躺在磁盘上的文本。
//
// 两种运行形态，接入方式根本不同：
//
//    docker-spec    persona → docker run 参数（只读挂载 + MAC/主机名/资源）
//    apply          容器内注入（文件层 / 命令层 / 环境变量层）
//    verify         容器内自检（确认伪造层真的盖住了）
//    fleet-plan     N 个槽位的身份分配与资源账单
//
//    kvm-spec       persona → QEMU 参数（SMBIOS 直接提供硬件，无伪造层）
//    kvm-lifecycle  虚拟机的建盘 / 启动 / 关机 / 清理
//    kvm-verify     客户机内自检（确认 QEMU 真的把硬件交出去了）
//
// 选择依据不是偏好：容器里的硬件信息来自文件与命令包装，绕过 shell 就能看到
// 宿主真实值；虚拟机里的硬件信息来自 QEMU 生成的 SMBIOS 表，客户机内核自己
// 去读 —— 没有伪造层，也就没有「哪一层没盖住」的问题。代价是资源开销更大。

export {
  dockerArgsForPersona,
  materializePersonaTree,
  dockerRunCommand,
  shellJoin,
  toDockerHostname,
  containerPathFor,
  memoryLimitMb,
  cpuLimit,
  diskLimitMb,
  logicalCoresOf,
  advertisedRamBytesOf,
  isLegalMac,
  isPathUnder,
  DMI_FIELDS,
  DMI_TO_DMIDECODE,
  PERSONA_TREE_PATH,
  PERSONA_AUDIT_PATH,
  RESOURCE_RULES,
} from './docker-spec.mjs'

export {
  applyPersonaInContainer,
  planPersonaInjection,
  renderWrapper,
  renderWrappers,
  renderProfileScript,
  underRoot,
  WRAPPED_COMMANDS,
  WRAPPER_DIR,
  FREE_RATIOS,
} from './apply.mjs'

export {
  verifyPersonaInContainer,
  assertPersonaInContainer,
  baselineWithoutPersona,
  VERIFY_PATHS,
} from './verify.mjs'

export {
  planFleet,
  materializeFleet,
  fleetManifest,
  maxSlotsForHost,
  normalizeHostResources,
  slotVmId,
  hostnameOverrides,
  canonicalHostname,
  canonicalUuid,
  canonicalSerial,
  planMixedFleet,
  resourceRulesFor,
  normalizeRuntime,
  slotSpecFor,
  slotQemuCommand,
  RUNTIMES,
  PLATFORM_OUI,
  HOSTNAME_STRATEGY,
} from './fleet-plan.mjs'

// ── KVM 形态 ──
// 注意：shellJoin 已由 docker-spec 导出（两者行为一致），这里不重复导出。
export {
  qemuArgsForPersona,
  qemuCommandLine,
  readSmbiosFromArgv,
  splitSmbiosArgs,
  buildSmbiosArg,
  smbiosTablesForPersona,
  escapeSmbiosValue,
  unescapeSmbiosValue,
  isSmbiosSafeValue,
  isSmbiosUuid,
  isUnicastMac,
  isVirtualOui,
  machineSupportsFamily,
  detectDiskConflicts,
  kvmPathsFor,
  kvmMacFor,
  kvmDiskSerialFor,
  kvmInstanceIdFor,
  kvmMemoryMb,
  kvmVcpus,
  kvmDiskFootprintMb,
  kvmMemoryFootprintMb,
  sysVendorOf,
  productNameOf,
  productUuidOf,
  productSerialOf,
  SMBIOS_FIELDS,
  QEMU_DEFAULT_OUI,
  NIC_OUI_POOL,
  KVM_RESOURCE_RULES,
  QEMU_FIXED_CHASSIS_TYPE,
} from './kvm-spec.mjs'

export {
  KvmSlot,
  planKvmSlots,
  renderCloudInitUserData,
  renderCloudInitMetaData,
  qmpCommand,
  canTransition,
  assertTransition,
  SLOT_STATES,
  STATE_TRANSITIONS,
} from './kvm-lifecycle.mjs'

export {
  verifyKvmPersona,
  assertKvmPersona,
  detectDefaultSmbiosLeak,
  parseDmidecodeFields,
  parseSystemInformation,
  splitTarget as splitSshTarget,
  KVM_DMI_TO_DMIDECODE,
  KVM_VERIFY_FIELDS,
  KVM_VERIFY_KEYWORDS,
  QEMU_DEFAULT_SMBIOS,
} from './kvm-verify.mjs'

// ─────────────── 内部工具 ───────────────

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}
