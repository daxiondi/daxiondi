/**
 * persona → docker run 参数
 *
 * 定位：
 *   `render()` 只回答「这份身份应该长什么样」，产出是一堆字符串。字符串躺在
 *   磁盘上不会改变运行环境。本模块把这些文件接进容器：只读挂载 + 启动参数。
 *
 * 三层注入（可靠性从高到低，见 apply.mjs）：
 *   1. 挂载层（本模块）—— 只读 bind mount。宿主上写坏了什么，容器里立刻能读到；
 *      容器自己改不动这些文件，重建容器也不漂移。
 *   2. 命令层（apply.mjs）—— /usr/local/bin 里的包装脚本。
 *   3. 环境变量层（apply.mjs）—— HOSTNAME / TZ / PERSONA_*。
 *
 * 两个平台差异必须显式处理，否则参数在目标平台上直接不合法：
 *   - `--mac-address` 只在 user-defined 网络上生效，默认 bridge 上 docker 会忽略它。
 *   - Windows 容器的 `-v` 短语法遇到盘符有歧义（`C:\a:C:\b`），必须用 `--mount` 长语法。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPersona, renderViews } from './index.mjs'
import { renderProcfsForSlot, renderBootFiles } from './procfs-fake.mjs'
import { renderOsRelease } from './os-release-fake.mjs'
import { claudeHomeFiles } from './claude-home.mjs'

/** Linux DMI 字段清单：与 linux.mjs 渲染出的 sys/class/dmi/id/* 一一对应。 */
export const DMI_FIELDS = Object.freeze([
  'sys_vendor',
  'product_name',
  'product_family',
  'product_serial',
  'product_uuid',
  'product_version',
  'board_vendor',
  'board_name',
  'board_serial',
  'board_version',
  'bios_vendor',
  'bios_version',
  'bios_date',
  'chassis_vendor',
  'chassis_type',
  'chassis_serial',
])

/**
 * `dmidecode -s <keyword>` → sysfs 字段名。
 *
 * dmidecode 的 keyword 与 sysfs 文件名不是同一套命名，必须显式对照。
 * 猜错一个，就会让 dmidecode 与 sysfs 读出两个值 —— 那正是要被消除的漂移。
 */
/**
 * 容器内 `/sys/class/dmi/id/` 下**不一定存在**的字段。
 *
 * `/sys` 在内核里是只读 sysfs，runc 无法为不存在的路径创建挂载点：
 * 直接挂就会得到
 *   make mountpoint "/sys/class/dmi/id/board_version": read-only file system
 * 容器起不来（exit=125），而回滚会把网络、iptables 全拆掉。
 *
 * 实测（Ubuntu 22.04 / 5.15 / 阿里云 ECS）宿主机与容器都**没有** board_* 四件套：
 * 该平台 SMBIOS type 2 不存在，内核就不导出这几个文件。
 * 这是环境差异而不是代码错误 —— 换台带 type 2 的机器它们又会出现，
 * 所以不能把这四个字段从清单里删掉，只能挂之前先确认目标存在。
 */
export const DMI_OPTIONAL_FIELDS = Object.freeze([
  'board_vendor',
  'board_name',
  'board_serial',
  'board_version',
  'product_family',
  'chassis_serial',
  'chassis_type',
])

/**
 * 该字段是否属于"容器内可能不存在"的类别。
 *
 * 这里只做静态判定，不读磁盘：`docker-spec` 是纯函数模块，
 * 让它去探测宿主机会把纯函数变成有环境依赖的函数，测试也就不可靠了。
 * 真正决定挂不挂的是调用方传进来的 probeExisting。
 */
export function isOptionalDmiField(field) {
  return DMI_OPTIONAL_FIELDS.includes(String(field))
}

export const DMI_TO_DMIDECODE = Object.freeze({
  'system-manufacturer': 'sys_vendor',
  'system-product-name': 'product_name',
  'system-version': 'product_version',
  'system-serial-number': 'product_serial',
  'system-uuid': 'product_uuid',
  'system-family': 'product_family',
  'baseboard-manufacturer': 'board_vendor',
  'baseboard-product-name': 'board_name',
  'baseboard-serial-number': 'board_serial',
  'baseboard-version': 'board_version',
  'bios-vendor': 'bios_vendor',
  'bios-version': 'bios_version',
  'bios-release-date': 'bios_date',
  'chassis-manufacturer': 'chassis_vendor',
  'chassis-serial-number': 'chassis_serial',
  'chassis-type': 'chassis_type',
})

/** 容器内的审计根目录：整棵 persona 树挂在这里，便于事后核对。 */
export const PERSONA_TREE_PATH = Object.freeze({
  linux: '/var/lib/persona',
  macos: '/var/lib/persona',
  windows: 'C:\\persona-tree',
})

/** 容器内统一的审计入口。三平台原文件名不同，审计脚本不该因此分叉。 */
export const PERSONA_AUDIT_PATH = Object.freeze({
  linux: '/etc/persona.json',
  macos: '/etc/persona.json',
  windows: 'C:\\persona\\persona.json',
})

/**
 * persona 名义内存 → 容器内存上限。
 *
 * 名义值和分配值必须分开：
 *   persona 报 64 GiB 是「这台机器看起来有多少内存」，
 *   容器拿到多少是「这个槽位实际能用多少」。两者混同，20 个槽位会一次性
 *   要 1.2 TiB，宿主机根本起不来。
 *
 * 规则：名义 / divisor，向下取整到 step，再夹到 [min, max]。
 */
export const RESOURCE_RULES = Object.freeze({
  memoryDivisor: 24,
  memoryStep: 256,
  minMemoryMb: 1024,
  maxMemoryMb: 4096,
  cpuDivisor: 16,
  minCpus: 1,
  maxCpus: 4,
  diskMbPerSlot: 8192,
  /** 宿主机预留比例：宿主机自身 + page cache + docker daemon 的余量 */
  hostReserveRatio: 0.15,
  /**
   * CPU 超订倍数。
   *
   * `--cpus` 是 CFS 配额（上限），不是预留（保证）。20 个槽位各 1 核配在
   * 16 核机器上完全可行 —— 前提是这些槽位不会同时跑满。默认 1.0 表示
   * 「按不超订估算」，计划阶段保守；真要超订必须显式抬这个值，
   * 让「我打算超订」成为一个被记录的决定，而不是算错的结果。
   */
  cpuOversubscribe: 1.0,
})

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

/** persona 上报的逻辑核数（三平台字段名不同，取到哪个算哪个）。 */
export function logicalCoresOf(persona) {
  const hw = persona?.hardware || {}
  const raw = hw.logical_cores ?? hw.processor?.logical_processors ?? hw.processor?.cores ?? 1
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/** persona 上报的名义内存（字节）。 */
export function advertisedRamBytesOf(persona) {
  const n = Number(persona?.hardware?.ram_bytes || 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 容器内存上限（MB） */
export function memoryLimitMb(persona, rules = RESOURCE_RULES) {
  const advertisedMb = advertisedRamBytesOf(persona) / 1024 ** 2
  if (advertisedMb <= 0) return rules.minMemoryMb
  const raw = advertisedMb / rules.memoryDivisor
  const stepped = Math.floor(raw / rules.memoryStep) * rules.memoryStep
  return clamp(stepped, rules.minMemoryMb, rules.maxMemoryMb)
}

/** 容器 CPU 上限（整数核） */
export function cpuLimit(persona, rules = RESOURCE_RULES) {
  const raw = Math.ceil(logicalCoresOf(persona) / rules.cpuDivisor)
  return clamp(raw, rules.minCpus, rules.maxCpus)
}

/** 单槽磁盘配额（MB）。名义容量不参与，容器给固定盘。 */
export function diskLimitMb(rules = RESOURCE_RULES) {
  return rules.diskMbPerSlot
}

/**
 * persona 的可见主机名 → docker `--hostname` 可接受的形态。
 *
 * docker 要求 RFC 1123 label（小写字母数字与连字符）。而 persona 的可见主机名
 * 是有大小写、甚至带点或逗号的（macOS 的 `MacPro7,1.local`）。两者不能混用：
 * 可见值走文件 + 包装脚本，`--hostname` 用这里的规范化值，否则容器起不来。
 */
export function toDockerHostname(visible) {
  const slug = String(visible || '')
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const trimmed = slug.slice(0, 63).replace(/[-.]+$/g, '')
  return trimmed || 'localhost'
}

/**
 * persona 的相对路径 → 容器内绝对路径。
 *
 * 只做机械映射，不猜平台语义：posix 前缀 `/`，Windows 走盘符。
 * Windows 下所有文件都落在 persona 树里，避免和系统目录撞名。
 */
export function containerPathFor(platform, rel) {
  const clean = String(rel).replace(/^\/+/, '')
  if (platform === 'windows') {
    return `${PERSONA_TREE_PATH.windows}\\${clean.split('/').join('\\')}`
  }
  return `/${clean}`
}

/** `dmidecode -s <keyword>` 对应的容器内 sysfs 路径 */
export function dmiContainerPath(field) {
  return `/sys/class/dmi/id/${field}`
}

/** 宿主机侧落盘目录的默认值 */
export function defaultOutDir(platform, vmId) {
  return path.join(os.tmpdir(), 'persona', String(platform), String(vmId))
}

/**
 * MAC 地址合法性：6 段、大写、冒号分隔、单播。
 * `--mac-address` 对格式敏感，组播地址会被 docker 直接拒绝。
 */
export function isLegalMac(mac) {
  const s = String(mac)
  if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(s)) return false
  return (parseInt(s.slice(0, 2), 16) & 0x01) === 0
}

/** 容器内路径是否已被某个挂载覆盖（用于去重与嵌套检测） */
export function isPathUnder(child, parent) {
  if (!child || !parent) return false
  if (child === parent) return true
  if (parent.endsWith('\\')) return child.startsWith(parent)
  if (parent === '/') return child.startsWith('/')
  return child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`)
}

function mountArg(platform, mount) {
  // mode 必须被尊重 —— 之前这里硬编码 :ro，忽略 mount.mode，
  // 导致 Claude CLI 的 ~/.claude.json 也被挂成只读。
  // CLI 需要回写 lastOnboardingVersion / projects 等状态，
  // 只读会让它启动失败或行为异常。
  const ro = mount.mode !== 'rw'
  if (platform === 'windows') {
    return ['--mount', `type=bind,source=${mount.hostPath},target=${mount.containerPath}${ro ? ',readonly' : ''}`]
  }
  return ['-v', `${mount.hostPath}:${mount.containerPath}:${ro ? 'ro' : 'rw'}`]
}

/**
 * 把 persona 转成 docker run 的参数片段。
 *
 * @param {object} p
 * @param {string} p.platform                    'linux' | 'macos' | 'windows'
 * @param {string} p.vmId                        槽位标识，决定所有派生值的种子
 * @param {string} [p.outDir]                    persona 文件的落盘目录（宿主机侧）
 * @param {object} [p.overrides]                 覆盖 persona 默认字段
 * @param {object} [p.persona]                   已构造好的 persona（给了就不再构造）
 * @param {string} [p.network]                   user-defined 网络名（--mac-address 生效的前提）
 * @param {string} [p.timezone='UTC']            容器 TZ
 * @returns {{args: string[], mounts: Array, env: object, files: Array}}
 */
export function dockerArgsForPersona(p = {}) {
  const rules = { ...RESOURCE_RULES, ...(p.resourceRules || {}) }
  const platform = String(p.platform || p.persona?.platform || 'linux')
  const vmId = String(p.vmId ?? p.vm_id ?? p.persona?.vm_id ?? 'default')
  const persona = p.persona || buildPersona({
    platform,
    vmId,
    overrides: p.overrides || {},
  })
  const outDir = path.resolve(String(p.outDir || defaultOutDir(platform, vmId)))

  const { files: rendered } = renderViews(persona)

  const files = Object.keys(rendered)
    .sort()
    .map((rel) => ({
      rel,
      containerPath: containerPathFor(platform, rel),
      hostPath: path.join(outDir, rel),
      content: rendered[rel],
      bytes: Buffer.byteLength(rendered[rel], 'utf8'),
    }))

  // 容器内不存在就不挂：/sys 是只读 sysfs，runc 建不了挂载点，容器直接起不来。
  //
  // probeExisting 由调用方注入（真机上是 `docker run --rm <img> test -e <path>`）。
  // 没注入时保守处理：DMI 可选字段一律不挂 —— 少伪造几个次要字段，
  // 好过整个槽位起不来。核心四项（product_name/product_uuid/sys_vendor/bios_*）
  // 在实测的所有发行版里都存在，不在此列。
  // files 是「要写盘的文件清单」，不受挂载过滤影响 —— 全都照写。
  // 只有 mounts 需要跳过容器内不存在的路径：文件写出来没坏处
  // （persona 树留着也方便审计/dmidecode 对照），挂载点不存在才会让容器起不来。
  const probeExisting = typeof p.probeExisting === 'function' ? p.probeExisting : null
  const mountableFiles = []
  const skippedMounts = []
  for (const f of files) {
    if (f.containerPath.startsWith('/sys/')) {
      const field = f.containerPath.split('/').pop()
      let exists
      if (probeExisting) {
        try { exists = probeExisting(f.containerPath) === true } catch { exists = false }
      } else {
        exists = !isOptionalDmiField(field)
      }
      if (!exists) {
        skippedMounts.push({ containerPath: f.containerPath, reason: 'container-path-missing' })
        continue
      }
    }
    mountableFiles.push(f)
  }

  // ── DMI 整目录挂载 ───────────────────────────────────────
  //
  // 逐文件挂载有个硬限制：/sys 是只读 sysfs，runc 无法为**不存在的路径**
  // 创建挂载点。宿主机的 /sys/class/dmi/id 恰好没有 board_* 四个字段时
  // （实测 Ubuntu 22.04 就是如此），它们就被跳过了。
  //
  // 后果比"少几个次要字段"严重得多：真实机器的 /sys/class/dmi/id 一定有
  // board_vendor / board_name / board_serial / board_version。整个 board
  // 系列缺失，本身就是很明显的容器特征 —— 比不伪造更容易被识别。
  //
  // 解法：不再逐文件挂，改为在宿主机搭一棵完整的 dmi 目录，整目录挂到
  // /sys/class/dmi/id。目录本身存在，runc 不需要创建挂载点，只读的
  // sysfs 也不影响它挂子目录。（实测可行，见 docs/DEPLOY.md 5.10.1）
  //
  // 好处：不再受宿主机有没有该字段影响，board_* 与 product_* 一视同仁。
  const dmiFiles = files.filter((f) => f.containerPath.startsWith('/sys/class/dmi/id/'))
  // 只有调用方给了 dmiTreePath 才走整目录挂载；没给就退回逐文件
  // （保持向后兼容，单测里直接调 dockerArgsForPersona 时不必准备目录）。
  const dmiMount = dmiFiles.length && p.dmiTreePath
    ? {
        hostPath: p.dmiTreePath,
        containerPath: '/sys/class/dmi/id',
      }
    : null

  // ── /proc 下的伪造文件（cpuinfo / meminfo）──
  //
  // 这两个文件在 Docker 里是 20 个容器共享的同一份 —— 直接暴露
  // "所有槽都在同一台机器上"。vm2api 的容器形态不处理这个（它的硬件
  // 指纹只写进 KVM 客户机），所以由我们补。
  //
  // 能做的原因：/proc/cpuinfo 和 /proc/meminfo 是普通 procfs 文件，
  // runc 允许在它们上面建挂载点（实测）。而 /proc/sys/kernel/* 和
  // /proc/version 不行 —— runc 明确拒绝 "inside /proc" 的挂载，
  // 那部分必须走 LKM（见 native/lkm/liveapi_uts.c）。
  // /etc/os-release 不需要在这里另建文件 —— persona 树里本来就有
  // etc/os-release，buildPersona 已按槽位生成了内容（发行版 + 内核自洽）。
  // 之前我在这里又 push 了一份同路径的文件，结果 materialize 时
  // 树里的 0444 只读文件挡住第二次写入，EACCES。
  //
  // 只需要把它从树里"提"出来，额外挂到容器的 /etc/os-release 上
  // （树的挂载点是 PERSONA_TREE_PATH，不会覆盖容器的 /etc）。
  const osReleaseFile = files.find((f) => f.rel === 'etc/os-release')

  // ── Claude Code CLI 的磁盘身份 ──
  //
  // CLI 不采集硬件，但它唯一的持久设备标识是 ~/.claude.json 的
  // userID / machineID（crypto.randomBytes(32)，纯随机）。
  //
  // 不处理会有两个问题：
  //   1. 20 个槽共用 HOME → 全是同一个 userID → 同设备 20 账号
  //   2. 各自随机 → 不可复现，槽重建就换身份（"频繁换设备"）
  //
  // 所以从 vmId 确定性派生，并让请求里的 metadata.user_id.device_id
  // 与磁盘上的 userID 同源（见 claude-home.mjs）。
  let claudeHome = null
  if (platform === 'linux') {
    const ch = claudeHomeFiles({
      vmId,
      accountUuid: p.overrides?.accountUuid || p.accountUuid || '',
      home: '/root',
    })
    claudeHome = ch
    for (const f of ch.files) {
      // hostPath 必须算出来 —— materializePersonaTree 靠它落盘，
      // 缺了会在 fs.mkdirSync(dirname(undefined)) 处崩
      files.push({
        rel: f.rel,
        containerPath: `/${f.rel}`,
        hostPath: path.join(p.outDir || outDir, f.rel),
        mode: f.mode,
        content: f.content,
      })
    }
  }

  const procFiles = []
  if (platform === 'linux' && p.procfs) {
    for (const [name, content] of Object.entries(p.procfs)) {
      if (!content) continue
      const rel = `proc/${name}`
      const hostPath = path.join(outDir, rel)
      const f = {
        rel,
        containerPath: `/${rel}`,
        hostPath,
        content: `${content.replace(/\n+$/, '')}\n`,
        role: 'procfs',
      }
      files.push(f)
      procFiles.push(f)
    }
  }

  const treePath = PERSONA_TREE_PATH[platform] || PERSONA_TREE_PATH.linux
  const auditPath = PERSONA_AUDIT_PATH[platform] || PERSONA_AUDIT_PATH.linux

  // 挂载顺序固定：先树，再逐文件。逐文件挂载只加在树之外的路径上，
  // 否则会形成「挂载点套挂载点」，docker 允许但会让容器内路径语义变得难推理。
  const mounts = [{
    containerPath: treePath,
    hostPath: outDir,
    rel: '.',
    mode: 'ro',
    role: 'tree',
  }]
  const covered = [treePath]

  // procfs 文件要排在 persona 树之后单独挂 ——
  // 它们在 outDir/proc/ 下，虽然理论上会被树覆盖，但树是挂在
  // PERSONA_TREE_PATH（不是 /）上的，所以不冲突。显式列出是为了
  // 后面 covered 判断能跳过重复项。
  // os-release 必须在 /etc/os-release 上单独挂 ——
  // persona 树挂在 PERSONA_TREE_PATH（如 /opt/persona），
  // 树的 etc/ 目录不会覆盖容器的 /etc。
  if (osReleaseFile && !covered.includes('/etc/os-release')) {
    mounts.push({
      containerPath: '/etc/os-release',
      hostPath: osReleaseFile.hostPath,
      rel: osReleaseFile.rel,
      mode: 'ro',
      role: 'os-release',
    })
    covered.push('/etc/os-release')
  }

  for (const f of procFiles) {
    mounts.push({
      containerPath: f.containerPath,
      hostPath: f.hostPath,
      rel: f.rel,
      mode: 'ro',
      role: 'procfs',
    })
    covered.push(f.containerPath)
  }

  // DMI 走整目录挂载（见上面 dmiMount 的说明）。
  // 加进 covered 后，逐文件循环会自动跳过 /sys/class/dmi/id/* 下的所有条目 ——
  // 不能既挂整目录又挂其中的单个文件，那会形成嵌套挂载。
  // ── Claude CLI 身份文件单独挂到真实路径 ──
  //
  // persona 树挂在 PERSONA_TREE_PATH（如 /opt/persona），
  // 树里的 root/.claude.json 不会自动出现在容器的 /root 下。
  // 必须单独 bind 到容器里的绝对路径，CLI 才读得到。
  const claudeHomeMounts = []
  if (claudeHome) {
    for (const f of claudeHome.files) {
      if (!f.rel.startsWith('root/')) continue
      const cp = `/${f.rel}`
      if (covered.includes(cp)) continue
      claudeHomeMounts.push({
        containerPath: cp,
        hostPath: path.join(p.outDir || outDir, f.rel),
        rel: f.rel,
        mode: 'rw',   // CLI 会回写（更新 lastOnboardingVersion 等），必须可写
        role: 'claude-home',
      })
      covered.push(cp)
    }
    mounts.push(...claudeHomeMounts)
  }

  if (dmiMount && dmiMount.hostPath) {
    mounts.push({
      containerPath: dmiMount.containerPath,
      hostPath: dmiMount.hostPath,
      rel: '.',
      mode: 'ro',
      role: 'dmi-tree',
    })
    covered.push(dmiMount.containerPath)
  }

  for (const f of mountableFiles) {
    if (covered.some((c) => isPathUnder(f.containerPath, c))) continue
    mounts.push({
      containerPath: f.containerPath,
      hostPath: f.hostPath,
      rel: f.rel,
      mode: 'ro',
      role: 'file',
    })
    covered.push(f.containerPath)
  }

  // 审计入口别名。macOS 的原文件名是 etc/macos_persona.json，
  // 别名让三平台的审计命令统一成读 auditPath。
  if (!covered.some((c) => isPathUnder(auditPath, c))) {
    const sourceRel = platform === 'windows'
      ? 'etc/persona.json'
      : (platform === 'macos' ? 'etc/macos_persona.json' : 'etc/persona.json')
    const source = files.find((f) => f.rel === sourceRel)
    if (source) {
      mounts.push({
        containerPath: auditPath,
        hostPath: source.hostPath,
        rel: source.rel,
        mode: 'ro',
        role: 'audit-alias',
      })
      covered.push(auditPath)
    }
  }

  const mac = String(persona.network?.mac || persona.network?.en0_mac || '').toUpperCase()
  if (!isLegalMac(mac)) {
    throw new Error(`derived MAC "${mac}" is not a legal unicast address for vm ${vmId}`)
  }

  const visibleHostname = String(
    persona.naming?.hostname || persona.naming?.computer_name || vmId,
  )
  const dockerHostname = toDockerHostname(visibleHostname)
  const memoryMb = memoryLimitMb(persona, rules)
  const cpus = cpuLimit(persona, rules)

  // ── CPU 亲和性必须与 cpuinfo / cgroup 三者一致 ──
  //
  // 实测矛盾：nproc 报 8（读 /proc/self/status 的 Cpus_allowed_list，
  // 来自宿主 affinity），而 /proc/cpuinfo 只报 2 个 processor，
  // cgroup cpu.max 是 2 核。三个数字打架，一眼看穿。
  //
  // 根因：--cpus 只设 cgroup 配额，不动 affinity mask。
  // 解法：同时给 --cpuset-cpus，让 Cpus_allowed_list 也变成 N 个核，
  // nproc 就和 cpuinfo 对上了（实测 --cpuset-cpus=0,1 → nproc 报 2）。
  //
  // 每个槽分配不同的 CPU 集合，避免 20 个槽的 Cpus_allowed_list 完全相同
  // —— 真实机器各自的 CPU 集合本来就不同。
  const cpuSet = (() => {
    const n = Math.max(1, Math.round(Number(cpus) || 1))
    // 宿主有多少 CPU；拿不到就按 8 算（--cpuset-cpus 超出范围会被 docker 拒绝）
    let total = 8
    try {
      total = Math.max(n, os.cpus().length || 8)
    } catch { /* 保持默认 */ }
    // 起点按 vmId 打散：不同槽拿到不同的核心集合
    const key = String(vmId)
    let h = 0x811c9dc5
    for (let i = 0; i < key.length; i += 1) {
      h ^= key.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    const start = total > n ? (h % (total - n + 1)) : 0
    const list = []
    for (let i = 0; i < n; i += 1) list.push((start + i) % total)
    return list.join(',')
  })()

  const args = [
    '--mac-address', mac,
    // 让 nproc（读 affinity）与 cpuinfo 报同一个数
    '--cpuset-cpus', cpuSet,
    '--hostname', dockerHostname,
    '--memory', `${memoryMb}m`,
    // 与 memory 相等 = 禁用 swap。否则容器内 free 会报出一块来自宿主的 swap，
    // 和 persona 的 free 视图对不上。
    '--memory-swap', `${memoryMb}m`,
    '--cpus', String(cpus),
  ]
  if (p.network) args.push('--network', String(p.network))
  for (const m of mounts) args.push(...mountArg(platform, m))

  // 不给默认 UTC：调用方没传时不设 TZ，让容器用镜像自带值，
  // 再由 stepVerify 按出口 IP 修正。
  // 之前写死 'UTC' 导致 20 个槽全报 UTC，而出口在洛杉矶。
  const rawTz = p.timezone || p.overrides?.timezone || null
  const tz = rawTz && rawTz !== 'auto' ? String(rawTz) : null
  const env = {
    // --hostname 被规范成小写 label；这里保留 persona 的可见形态，
    // 让容器内 $HOSTNAME 与 uname -n / /etc/hostname 完全一致。
    HOSTNAME: visibleHostname,
    // tz 为 null 时不写 TZ —— 写了 "TZ=null" 反而更可疑。
    // 这种情况留给 stepVerify 按实际出口 IP 回填。
    ...(tz && tz !== 'auto' ? { TZ: tz } : {}),
    LANG: 'C.UTF-8',
    PERSONA_PLATFORM: platform,
    PERSONA_VM_ID: vmId,
    PERSONA_ROOT: treePath,
    PERSONA_HOSTNAME: visibleHostname,
  }
  if (persona.machine_id) env.PERSONA_MACHINE_ID = String(persona.machine_id)

  const warnings = []
  if (!p.network) {
    warnings.push('--mac-address 只在 user-defined 网络上生效；未指定 --network 时 docker 会忽略')
  }
  if (platform === 'windows') {
    warnings.push('Windows 容器不接受 POSIX 路径挂载语义；此处仅生成参数，实际部署在 Windows 宿主执行')
  }

  return {
    platform,
    vmId,
    persona,
    outDir,
    mac,
    hostname: visibleHostname,
    dockerHostname,
    memoryMb,
    cpus,
    diskMb: diskLimitMb(rules),
    advertised: {
      ramBytes: advertisedRamBytesOf(persona),
      logicalCores: logicalCoresOf(persona),
    },
    auditPath,
    treePath,
    args,
    mounts,
    env,
    files,
    // 容器内不存在、因而没有挂载的 sysfs 字段。
    // 调用方应当把它写进日志：persona 配了却没生效，最容易被当成"没配"。
    skippedMounts,
    warnings,
  }
}

/**
 * 把 persona 树写到宿主机 outDir。
 *
 * 与「生成参数」分开：planFleet 只算参数，真正要起容器时才落盘。
 * 返回的 spec 与 dockerArgsForPersona 一致，额外带 written 列表。
 */
export function materializePersonaTree({
  platform, vmId, outDir, overrides = {}, network, timezone, resourceRules,
  slotIndex = 0, cores = null, memoryMb = null, enableProcfs = true,
}) {
  // dmiTreePath 要在调用 dockerArgsForPersona **之前**算好 —— 它决定
  // 挂载列表里是否加那条整目录 bind。放在 outDir 下的独立子目录，
  // 不跟 persona 树混在一起（那棵树是 0444 只读的，DMI 目录要能重建）。
  const dmiTreePath = path.join(outDir, '.dmi')

  // 自动为 Linux 槽位生成 cpuinfo / meminfo。
  // 报出去的核数和内存必须与容器实际限额同量级 —— 否则自相矛盾
  // （4 核 Xeon 却只有 1GB 内存是很可疑的组合）。
  let procfs = null
  let osRelease = null
  if (enableProcfs && platform === 'linux') {
    const r = typeof resourceRules === 'object' && resourceRules ? resourceRules : {}
    const c = Number(cores ?? r.cpuLimit ?? r.cpus ?? 2) || 2
    const m = Number(memoryMb ?? r.memoryLimitMb ?? r.memoryMb ?? 1024) || 1024
    const rendered = renderProcfsForSlot({ vmId, index: slotIndex, cores: c, memoryMb: m })
    // 启动时间三件套也必须换掉。
    //
    // 实测矛盾：20 个槽的 /proc/uptime 都等于宿主 uptime（4328.85s），
    // btime 全同 —— 一条 `cat /proc/uptime` 就能判定是同一台机器。
    //
    // /proc/loadavg 同理：容器读到的是宿主全局负载，
    // 宿主跑 20 个槽 + 其他业务，负载与"2 核小机器"矛盾。
    const boot = renderBootFiles({ vmId, index: slotIndex, cores: c })
    procfs = {
      cpuinfo: rendered.cpuinfo,
      meminfo: rendered.meminfo,
      uptime: boot.uptime,
      stat: boot.stat,
      loadavg: boot.loadavg,
    }
    osRelease = renderOsRelease({ vmId, index: slotIndex })
  }

  const spec = dockerArgsForPersona({
    platform, vmId, outDir, overrides, network, timezone, resourceRules, dmiTreePath, procfs, osRelease,
  })
  const written = []
  for (const f of spec.files) {
    fs.mkdirSync(path.dirname(f.hostPath), { recursive: true })
    fs.writeFileSync(f.hostPath, f.content, { encoding: 'utf8', mode: 0o444 })
    written.push(f.hostPath)
  }

  // ── 把 DMI 字段复制成「整目录挂载」用的扁平目录 ──
  //
  // 为什么需要这一步：/sys 是只读 sysfs，runc 不能为不存在的路径创建挂载点。
  // 宿主机的 /sys/class/dmi/id 没有 board_* 时，逐文件挂载会把它们全跳过，
  // 于是容器里整个 board 系列缺失 —— 真实机器不可能这样，反而更可疑。
  //
  // 整目录挂载绕开了这个限制：挂 /sys/class/dmi/id 这个**目录**，
  // 目录存在就不需要创建挂载点。代价是要在宿主机准备一棵同构的目录树。
  if (dmiTreePath) {
    fs.rmSync(dmiTreePath, { recursive: true, force: true })
    fs.mkdirSync(dmiTreePath, { recursive: true })
    for (const f of spec.files) {
      if (!f.containerPath.startsWith('/sys/class/dmi/id/')) continue
      const name = f.containerPath.split('/').pop()
      if (!name) continue
      fs.writeFileSync(path.join(dmiTreePath, name), f.content, { encoding: 'utf8', mode: 0o444 })
    }
    // 目录和文件都要可读，否则容器内非 root 用户读不到
    try { fs.chmodSync(dmiTreePath, 0o755) } catch { /* 忽略 */ }
  }

  // 把 distro 与 kernelRelease 一起带出去 —— stepUts 要用它保证
  // uname -r 与 /etc/os-release 说的是同一台机器。
  const osRel = spec.files.find((f) => f.rel === 'etc/os-release')
  let distro = null
  if (osRel && typeof osRel.content === 'string') {
    const m = osRel.content.match(/^ID=(\w+)$/m)
    if (m) distro = m[1]
  }
  const km = osRel && typeof osRel.content === 'string'
    ? osRel.content.match(/^VERSION="([^"]+)"/m)
    : null
  return {
    ...spec,
    written,
    dmiTreePath: dmiTreePath || null,
    distro,
    kernelRelease: spec.persona?.software?.kernel_release || null,
    _km: km ? km[1] : null,
  }
}

/**
 * 生成完整 `docker run` 命令行（含 docker 自身与镜像名）。
 * 只用于展示 / 审计，不作为模块间契约。
 */
export function dockerRunCommand(spec, {
  image = 'ubuntu:24.04',
  name = null,
  entrypoint = null,
  command = null,
  detach = true,
} = {}) {
  const argv = ['docker', 'run']
  if (detach) argv.push('-d')
  argv.push('--name', String(name || `persona-${spec.platform}-${spec.vmId}`))
  argv.push(...spec.args)
  for (const [k, v] of Object.entries(spec.env || {})) argv.push('--env', `${k}=${v}`)
  if (entrypoint) argv.push('--entrypoint', String(entrypoint))
  argv.push(String(image))
  if (command) argv.push(...(Array.isArray(command) ? command : [String(command)]))
  return argv
}

/** 把 argv 渲染成可复制的 shell 片段（仅展示用）。 */
export function shellJoin(argv) {
  return argv
    .map((a) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`))
    .join(' ')
}
