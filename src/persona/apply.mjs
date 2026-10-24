/**
 * 在容器内把 persona 应用到运行环境
 *
 * 三层，按可靠性从高到低：
 *
 *   1. 文件层 —— 把 persona 渲染出的文件写到对应位置（/etc/hostname、
 *      /etc/machine-id、/etc/os-release、/sys/class/dmi/id/*）。
 *      /etc 可写，直接写；/sys 通常只读（挂载层已提供同样的值），
 *      写失败记成 `skipped`，不算错误。
 *
 *   2. 命令层 —— 在 /usr/local/bin 放一组包装脚本。PATH 里 /usr/local/bin
 *      排在 /usr/bin 之前，同名命令会先命中包装脚本。纯文件操作，不需要特权，
 *      也不需要 hook 系统调用。
 *
 *   3. 环境变量层 —— HOSTNAME / TZ / PERSONA_*，外加 /etc/profile.d 里的
 *      导出片段，让非登录 shell 也拿到同一组值。
 *
 * 明确不做：
 *   - LKM / UTS namespace 伪装：内核态，进程内无法改写
 *   - LD_PRELOAD 拦截 syscall：能做但要编译 C，对静态链接的可执行文件无效，
 *     收益与维护成本不成比例
 *   文件和命令两层覆盖了所有经过 shell / PATH / 文件读取的路径。
 *   剩下的 syscall 直连既不经过 shell 也不查 PATH，不在本模块范围内。
 *
 * 设计约束：所有容器内绝对路径都相对 `root` 前缀解析。这样自检可以在临时
 * 目录里跑完整流程，不需要真的进容器。
 */

import fs from 'node:fs'
import path from 'node:path'
import { buildPersona, renderViews } from './index.mjs'
import { DMI_FIELDS, DMI_TO_DMIDECODE, RESOURCE_RULES } from './docker-spec.mjs'

/**
 * 包装脚本清单 —— 恰好 9 个。
 *
 * 选的都是「看一眼就知道机器是谁」的命令。每个脚本只覆盖明确列出的参数形态，
 * 未覆盖的形态转回系统原始可执行文件（默认行为不变，避免包装脚本自己成为新的
 * 行为分叉点）。
 */
export const WRAPPED_COMMANDS = Object.freeze([
  'uname',
  'hostname',
  'hostnamectl',
  'dmidecode',
  'lscpu',
  'free',
  'lsblk',
  'df',
  'ip',
])

/** 包装脚本落盘目录。POSIX 下必须排在 /usr/bin、/bin 之前。 */
export const WRAPPER_DIR = Object.freeze({
  linux: '/usr/local/bin',
  macos: '/usr/local/bin',
  windows: null,
})

/**
 * free 视图的内存分布比例。
 *
 * 与 linux.mjs render 里的字面量必须一致 —— 那边把三个比例写死了，
 * 这里同样写死，靠 test/persona-deploy.mjs 的断言守住：包装脚本 free 的
 * total 必须与 renderViews 的 free total 完全一致。任一边漂移，测试立刻失败。
 */
export const FREE_RATIOS = Object.freeze({
  used: 0.18,
  free: 0.62,
  available: 0.74,
  shared: 0.004,
  swap: 0.25,
})

/** 单引号安全包裹。多行内容在 POSIX sh 里也是合法的单引号字符串。 */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/**
 * 在脚本里定位系统原始可执行文件。
 *
 * 不能写死 /bin/<name>：不同发行版把核心工具放在 /bin 或 /usr/bin，
 * 有些镜像干脆没装（dmidecode 常常没有）。统一走 PATH 搜索，并跳过
 * persona 包装目录本身，避免自我递归。
 */
function realBinSnippet(name) {
  return [
    // 自身所在目录必须排除。只排除 /usr/local/bin 是不够的：只要包装脚本被
    // 装在别的目录、那个目录又在 PATH 里，搜索就会命中自己，形成无限递归
    // （exec 自己 → exec 自己）。从 $0 推目录是唯一可靠的做法。
    'persona_self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)',
    '[ -z "$persona_self_dir" ] && persona_self_dir=$(dirname -- "$0")',
    '',
    'persona_real_bin() {',
    '  _persona_found=',
    '  _persona_saved_ifs=$IFS',
    '  IFS=:',
    '  for _persona_dir in $PATH; do',
    '    [ -z "$_persona_dir" ] && continue',
    '    if [ "$_persona_dir" = "$persona_self_dir" ]; then',
    '      continue',
    '    fi',
    `    if [ "$_persona_dir" = "${WRAPPER_DIR.linux}" ]; then`,
    '      continue',
    '    fi',
    `    if [ -x "$_persona_dir/${name}" ]; then`,
    `      _persona_found="$_persona_dir/${name}"`,
    '      break',
    '    fi',
    '  done',
    '  IFS=$_persona_saved_ifs',
    '  printf %s "$_persona_found"',
    '}',
    '',
    'persona_fallback() {',
    `  _persona_bin=$(persona_real_bin ${name})`,
    '  if [ -n "$_persona_bin" ]; then',
    '    "$_persona_bin" "$@"',
    '    exit $?',
    '  fi',
    '  printf "persona: %s: command unavailable in PATH\\n" "$0" >&2',
    '  exit 127',
    '}',
  ].join('\n')
}

/** 一个 case 分支：参数形态 → 固定输出。
 *
 * `exit 0` 必须写在分支里。少了它，脚本会继续执行到末尾的 persona_fallback，
 * 于是同一个命令先打印 persona 的值、再打印宿主真实的值 —— 这是最糟的一种
 * 失败模式：输出里有正确值，也有错误值，人眼很容易只看第一行就放过。
 */
function branch(pattern, payload) {
  return [
    `  ${shQuote(pattern)})`,
    `    printf '%s\\n' ${shQuote(payload)}`,
    '    exit 0',
    '    ;;',
  ].join('\n')
}

/**
 * free 的列格式。
 *
 * 表头与 linux.mjs render 的字面量逐字符对齐：前缀 8 列，其后 6 个字段各占
 * 12 列右对齐。这样 `free` 与 `free -m` 的列位置一致 —— 换单位只换数字，
 * 不换版式，与真实 free 行为相同。
 */
const FREE_COLUMNS = Object.freeze([
  ['total', 12],
  ['used', 12],
  ['free', 12],
  ['shared', 12],
  ['buff/cache', 12],
  ['available', 12],
])

function freeHeader() {
  return `        ${FREE_COLUMNS.map(([label, w]) => label.padStart(w)).join('')}`
}

function freeRow(label, values) {
  return `${label.padEnd(8)}${values.map((v, i) => String(v).padStart(FREE_COLUMNS[i][1])).join('')}`
}

/** KiB 数值 → 人类可读（Gi 优先，不足 1Gi 用 Mi，再不足用 Ki） */
function humanKb(kb) {
  if (kb >= 1024 * 1024) return `${Math.round(kb / 1024 ** 2)}Gi`
  if (kb >= 1024) return `${Math.round(kb / 1024)}Mi`
  return `${kb}Ki`
}

/** free 在指定单位下的输出 */
function freeForUnit(persona, divisor, human = false) {
  const totalKb = Math.round(persona.hardware.ram_bytes / 1024)
  const base = Math.round(totalKb / divisor)
  const used = Math.round(base * FREE_RATIOS.used)
  const freeKb = Math.round(base * FREE_RATIOS.free)
  const shared = Math.round(base * FREE_RATIOS.shared)
  const avail = Math.round(base * FREE_RATIOS.available)
  const buff = base - used - freeKb
  const swap = Math.round(base * FREE_RATIOS.swap)
  // 人类可读模式下 0 显示为 0B（与真实 free -h 一致），否则 0Ki 会显得像有值
  const fmt = human ? (n) => (Number(n) === 0 ? '0B' : humanKb(n)) : (n) => String(n)
  return [
    freeHeader(),
    freeRow('Mem:', [fmt(base), fmt(used), fmt(freeKb), fmt(shared), fmt(buff), fmt(avail)]),
    freeRow('Swap:', [fmt(swap), fmt(0), fmt(swap), '', '', '']),
  ]
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
}

/** df 在 1KiB 块下的输出。默认 df 不带 -h 时就是这个形态。 */
function dfForBlocks(persona) {
  const st = persona.storage || {}
  const size = Math.round(Number(st.root_size_bytes || 0) / 1024)
  const used = Math.round(Number(st.root_used_bytes || 0) / 1024)
  const avail = Math.max(0, size - used)
  const pct = size > 0 ? Math.round((used / size) * 100) : 0
  const tmpfs = Math.round(Number(persona.hardware.ram_bytes || 0) / 1024 / 2)
  return [
    'Filesystem     1K-blocks  Used Available Use% Mounted on',
    `/dev/sda1     ${size}  ${used}  ${avail}  ${pct}% /`,
    `tmpfs          ${tmpfs}     0  ${tmpfs}   0% /dev/shm`,
  ].join('\n')
}

/** dmidecode -s <keyword> 的完整分支集合 */
function dmidecodeBranches(persona) {
  const out = []
  for (const [keyword, field] of Object.entries(DMI_TO_DMIDECODE)) {
    const value = persona.hardware[field]
    if (value === undefined) continue
    out.push(branch(`-s ${keyword}`, String(value)))
  }
  return out
}

/**
 * 生成一个包装脚本。
 *
 * @param {object} args
 * @param {string} args.name       命令名
 * @param {object} args.persona
 * @param {object} args.commands   renderViews 的 commands
 * @returns {string} 脚本全文
 */
export function renderWrapper({ name, persona, commands }) {
  const branches = []

  switch (name) {
    case 'uname': {
      branches.push(branch('', commands['uname -s'] || 'Linux'))
      for (const flag of ['-s', '-r', '-n', '-m', '-v', '-a']) {
        if (commands[`uname ${flag}`] !== undefined) {
          branches.push(branch(flag, commands[`uname ${flag}`]))
        }
      }
      // 组合标志（-sn / -sr / -mn ...）：uname(1) 的字段顺序固定为 s n r v m，
      // 这里按同样的顺序拼。穷举写进脚本，运行期不做字符串处理。
      const order = ['-s', '-n', '-r', '-m']
      const known = order.every((f) => commands[`uname ${f}`] !== undefined)
      if (known) {
        for (let mask = 1; mask < 1 << order.length; mask += 1) {
          const flags = order.filter((_, i) => mask & (1 << i))
          const key = `-${flags.map((f) => f[1]).sort().join('')}`
          if (['-s', '-n', '-r', '-m'].includes(key)) continue
          branches.push(branch(key, flags.map((f) => commands[`uname ${f}`]).join(' ')))
        }
      }
      break
    }

    case 'hostname': {
      const visible = String(persona.naming.hostname)
      const short = visible.split('.')[0]
      branches.push(branch('', visible))
      for (const f of ['-s', '--short']) branches.push(branch(f, short))
      for (const f of ['-f', '--fqdn', '--long']) branches.push(branch(f, visible))
      for (const f of ['-i', '--ip-address', '-I', '--all-ip-addresses', '-A']) {
        branches.push(branch(f, '127.0.1.1'))
      }
      break
    }

    case 'hostnamectl': {
      const text = commands.hostnamectl || ''
      branches.push(branch('', text))
      branches.push(branch('status', text))
      branches.push(branch('hostname', persona.naming.hostname))
      break
    }

    case 'dmidecode': {
      branches.push(...dmidecodeBranches(persona))
      // 无参数：只在 render 给了整体视图时才编，否则落回系统原始可执行文件。
      if (commands.dmidecode) branches.push(branch('', commands.dmidecode))
      break
    }

    case 'lscpu': {
      branches.push(branch('', commands.lscpu || ''))
      break
    }

    case 'free': {
      branches.push(branch('', commands.free || ''))
      branches.push(branch('-k', commands.free || ''))
      branches.push(branch('--kilo', commands.free || ''))
      branches.push(branch('-m', freeForUnit(persona, 1024)))
      branches.push(branch('--mega', freeForUnit(persona, 1024)))
      branches.push(branch('-g', freeForUnit(persona, 1024 ** 2)))
      branches.push(branch('--giga', freeForUnit(persona, 1024 ** 2)))
      // -h 的单位是逐列自适应的，所以先取 KiB 原始值再逐个人类化。
      branches.push(branch('-h', freeForUnit(persona, 1, true)))
      branches.push(branch('--human', freeForUnit(persona, 1, true)))
      break
    }

    case 'lsblk': {
      branches.push(branch('', commands.lsblk || ''))
      break
    }

    case 'df': {
      branches.push(branch('', dfForBlocks(persona)))
      branches.push(branch('-k', dfForBlocks(persona)))
      branches.push(branch('--block-size=1K', dfForBlocks(persona)))
      for (const f of ['-h', '--human-readable', '-H', '-P', '-P -h']) {
        branches.push(branch(f, commands['df -h'] || ''))
      }
      break
    }

    case 'ip': {
      const link = commands['ip link show'] || ''
      for (const form of ['link show', 'link', 'link list', 'l', 'l show', 'a', 'addr', 'address', 'addr show', 'address show']) {
        branches.push(branch(form, link))
      }
      break
    }

    default:
      break
  }

  const lines = [
    '#!/bin/sh',
    `# persona command wrapper: ${name}`,
    '# 真值来自 persona。未列出的参数形态转回系统原始可执行文件，避免行为分叉。',
    '# 生成物，不要手改；改动请回 src/persona/apply.mjs。',
    '',
    realBinSnippet(name),
    '',
  ]
  if (branches.length > 0) {
    lines.push('case "$*" in')
    lines.push(branches.join('\n'))
    lines.push('esac')
  }
  lines.push('')
  lines.push('persona_fallback "$@"')
  lines.push('')
  return lines.join('\n')
}

/**
 * 按平台渲染整套包装脚本。
 * 只有 POSIX 形态有这一层；Windows 没有 /usr/local/bin 优先级机制。
 */
export function renderWrappers(persona, commands) {
  const dir = WRAPPER_DIR[persona.platform]
  if (!dir) return []
  return WRAPPED_COMMANDS.map((name) => ({
    name,
    path: `${dir}/${name}`,
    content: renderWrapper({ name, persona, commands }),
  }))
}

/** profile.d 片段：让非登录 shell 也拿到同一组环境变量 */
export function renderProfileScript(env) {
  const lines = ['# persona environment (generated)', '# 不要手改。']
  for (const [k, v] of Object.entries(env)) {
    // HOSTNAME 由 shell / 内核自己给，重复导出容易和 uname -n 打架
    if (k === 'HOSTNAME') continue
    lines.push(`export ${k}=${shQuote(v)}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** 容器内路径 → 加 root 前缀的宿主路径 */
export function underRoot(root, containerPath) {
  const base = root && root !== '/' ? root : ''
  const clean = String(containerPath).replace(/^\/+/, '')
  return base ? path.join(base, clean) : `/${clean}`
}

/** 只读文件系统 / 权限错误：预期内，记 skipped 而不是失败 */
function isReadOnlyError(e) {
  return Boolean(e) && ['EROFS', 'EACCES', 'EPERM', 'ENOENT'].includes(e.code)
}

/**
 * 在容器内把 persona 应用到运行环境。
 *
 * @param {object} opts
 * @param {object} [opts.persona]        已构造好的 persona
 * @param {string} [opts.platform]       未给 persona 时用
 * @param {string} [opts.vmId]           未给 persona 时用
 * @param {object} [opts.overrides]
 * @param {string} [opts.root='/']       容器内根前缀（自检时指向临时目录）
 * @param {boolean} [opts.dryRun=false]  只算不写
 * @param {boolean} [opts.wrappers=true] 是否安装命令包装脚本
 * @param {boolean} [opts.files=true]    是否执行文件层
 * @param {string} [opts.timezone]
 * @param {object} [opts.env]            额外环境变量
 * @returns {Promise<object>} 注入报告
 */
export async function applyPersonaInContainer(opts = {}) {
  const persona = opts.persona || buildPersona({
    platform: opts.platform || 'linux',
    vmId: opts.vmId || 'default',
    overrides: opts.overrides || {},
  })
  const platform = persona.platform
  const root = opts.root || '/'
  const dryRun = Boolean(opts.dryRun)
  const doFiles = opts.files !== false
  const doWrappers = opts.wrappers !== false && Boolean(WRAPPER_DIR[platform])

  const { files, commands } = renderViews(persona)
  const visible = String(persona.naming?.hostname || persona.naming?.computer_name || '')

  const env = {
    HOSTNAME: visible,
    TZ: String(opts.timezone || opts.env?.TZ || 'UTC'),
    LANG: 'C.UTF-8',
    PERSONA_PLATFORM: platform,
    PERSONA_VM_ID: String(persona.vm_id),
    PERSONA_HOSTNAME: visible,
    ...(persona.machine_id ? { PERSONA_MACHINE_ID: String(persona.machine_id) } : {}),
    ...(opts.env || {}),
  }

  const report = {
    platform,
    vmId: String(persona.vm_id),
    root,
    dryRun,
    files: [],
    wrappers: [],
    env,
    envApplied: false,
    warnings: [],
    ok: true,
  }

  // ───── 1. 文件层 ─────
  if (doFiles) {
    for (const [rel, content] of Object.entries(files)) {
      const containerPath = `/${rel}`
      const target = underRoot(root, containerPath)
      const isSys = rel.startsWith('sys/')
      if (dryRun) {
        report.files.push({ rel, containerPath, target, action: 'plan', bytes: Buffer.byteLength(content) })
        continue
      }
      try {
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        await fs.promises.writeFile(target, content, 'utf8')
        report.files.push({ rel, containerPath, target, action: 'written', bytes: Buffer.byteLength(content) })
      } catch (e) {
        if (isSys && isReadOnlyError(e)) {
          report.files.push({
            rel, containerPath, target,
            action: 'skipped',
            reason: e.code,
            note: '只读路径，由挂载层提供同一值',
          })
        } else {
          report.ok = false
          report.files.push({ rel, containerPath, target, action: 'failed', reason: e.code || e.message })
        }
      }
    }
  }

  // ───── 2. 命令层 ─────
  if (doWrappers) {
    for (const w of renderWrappers(persona, commands)) {
      const target = underRoot(root, w.path)
      if (dryRun) {
        report.wrappers.push({ name: w.name, path: w.path, target, action: 'plan' })
        continue
      }
      try {
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        await fs.promises.writeFile(target, w.content, { encoding: 'utf8', mode: 0o755 })
        await fs.promises.chmod(target, 0o755)
        report.wrappers.push({ name: w.name, path: w.path, target, action: 'installed' })
      } catch (e) {
        if (isReadOnlyError(e)) {
          report.wrappers.push({ name: w.name, path: w.path, target, action: 'skipped', reason: e.code })
        } else {
          report.ok = false
          report.wrappers.push({ name: w.name, path: w.path, target, action: 'failed', reason: e.code || e.message })
        }
      }
    }
    if (report.wrappers.some((w) => w.action === 'skipped')) {
      report.warnings.push('部分包装脚本未安装（目录只读），对应命令会落回系统原始可执行文件')
    }
  }

  // ───── 3. 环境变量层 ─────
  if (platform === 'windows') {
    report.warnings.push('Windows 没有 profile.d 钩子，环境变量需由进程环境直接带入')
  } else if (doFiles) {
    const profilePath = underRoot(root, '/etc/profile.d/persona.sh')
    if (dryRun) {
      report.envPlan = { profilePath, content: renderProfileScript(env) }
    } else {
      try {
        await fs.promises.mkdir(path.dirname(profilePath), { recursive: true })
        await fs.promises.writeFile(profilePath, renderProfileScript(env), 'utf8')
        report.envApplied = true
        report.envProfilePath = profilePath
      } catch (e) {
        report.warnings.push(`/etc/profile.d 写入失败（${e.code}），环境变量需由启动脚本带入`)
      }
    }
  }

  if (visible.includes(',')) {
    report.warnings.push('可见主机名含逗号（macOS 机型名）：docker --hostname 已规范化，$HOSTNAME 保留可见形态')
  }

  return report
}

/** 只规划不落盘。CLI 的 --plan 走这里。 */
export async function planPersonaInjection(opts = {}) {
  return applyPersonaInContainer({ ...opts, dryRun: true })
}

/** 常量再导出，调用方不必为了一个数去 import docker-spec。 */
export { RESOURCE_RULES, DMI_FIELDS, DMI_TO_DMIDECODE }
