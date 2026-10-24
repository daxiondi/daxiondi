/**
 * 环境预检：在动任何网络/容器之前，先确认这台机器具备跑起来的最低条件。
 *
 * 为什么单独一步：本方案对宿主的要求不是「装了 docker」这么宽 —— 它要求
 * 内核 netfilter 必须能用（iptables REDIRECT 是整条链路的收口点）、
 * 必须有 CAP_NET_ADMIN、redsocks 必须在 PATH 里、docker daemon 必须活着。
 * 缺任何一条，后续步骤会在不同深度以各种面目失败：docker network create
 * 报 IPAM 冲突、iptables 报 Permission denied、容器起来了但出口是直连。
 * 一次预检把这些提前成一条清晰结论。
 *
 * 判定分两档：
 *   fatal  该检查不通过就整体 ok=false，编排器拒绝启动
 *   warn   只告警，继续（例如 /dev/kvm 缺失只影响需要 KVM 的槽位）
 *
 * 所有外部命令通过注入的 executor。文件读取通过注入的 readFile，
 * 这样测试可以在任何平台上验证全部分支（包括「这里是 macOS」这种情形）。
 */

import fs from 'node:fs'
import os from 'node:os'

/** CAP_NET_ADMIN 在 capability 位图里的位号。 */
export const CAP_NET_ADMIN_BIT = 12n

const makeCheck = (name, ok, detail, fatal = true) => ({ name, ok: Boolean(ok), detail, fatal: Boolean(fatal) })

/** 读文件的安全包装：读不到返回 null，不抛。 */
function readSafe(readFile, path) {
  try {
    return String(readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 从 /proc/self/status 的 CapEff 判断是否持有某个 capability。
 * 返回 null 表示「拿不到这份信息」，交给调用方降级判定。
 */
export function hasCapability(text, bit = CAP_NET_ADMIN_BIT) {
  if (!text) return null
  const m = String(text).match(/^CapEff:\s*([0-9a-fA-F]+)$/m)
  if (!m) return null
  try {
    return (BigInt(`0x${m[1]}`) & (1n << bit)) !== 0n
  } catch {
    return null
  }
}

/**
 * 环境预检。
 *
 * @param {object} opts
 *   executor        {Executor} 必填
 *   platform        {string} 默认 process.platform
 *   getuid          {Function} 默认 process.getuid
 *   readFile        {Function} 默认 fs.readFileSync
 *   exists          {Function} 默认 fs.existsSync
 *   requirements    需要哪些能力：
 *     needRedsocks  {boolean} 默认 true（iptables-redirect 模式必须）
 *     needKvm       {boolean} 默认 false
 *     needQemu      {boolean} 默认 false
 *     needDocker    {boolean} 默认 true
 *     needIptables  {boolean} 默认 true
 * @returns {Promise<{ok:boolean, checks:Array, fatal:Array, warnings:Array, summary:string}>}
 */
export async function preflight({
  executor,
  platform = process.platform,
  getuid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
  readFile = fs.readFileSync,
  exists = fs.existsSync,
  requirements = {},
} = {}) {
  if (!executor || typeof executor.run !== 'function') {
    throw new Error('preflight 需要注入 executor')
  }
  const need = {
    needRedsocks: requirements.needRedsocks !== false,
    needKvm: requirements.needKvm === true,
    needQemu: requirements.needQemu === true,
    needDocker: requirements.needDocker !== false,
    needIptables: requirements.needIptables !== false,
  }

  const checks = []
  const add = (name, ok, detail, fatal = true) => {
    checks.push(makeCheck(name, ok, detail, fatal))
    return ok
  }

  // ── 1. 操作系统 ──
  // iptables / docker bridge / netfilter 这一整套是 Linux 专属。
  // macOS、Windows 上不是「配置不同」，是根本没有这条路径，必须 fatal。
  const osRelease = readSafe(readFile, '/etc/os-release')
  const distro = osRelease?.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] || ''
  add(
    'os-linux',
    platform === 'linux',
    platform === 'linux'
      ? `linux${distro ? ` (${distro})` : ''} ${os.release()}`
      : `当前平台是 ${platform}，iptables REDIRECT 只在 Linux 上存在`,
    true,
  )

  // ── 2. 权限 ──
  const uid = typeof getuid === 'function' ? getuid() : null
  const capText = readSafe(readFile, '/proc/self/status')
  const capNetAdmin = hasCapability(capText, CAP_NET_ADMIN_BIT)
  const isRoot = uid === 0
  const hasCap = isRoot || capNetAdmin === true
  add(
    'privileges',
    hasCap,
    isRoot
      ? '以 root 运行'
      : capNetAdmin === true
        ? '非 root，但持有 CAP_NET_ADMIN'
        : capNetAdmin === false
          ? `非 root 且 CapEff 未包含 CAP_NET_ADMIN（bit ${CAP_NET_ADMIN_BIT}）：无法建网桥/写 iptables`
          : '非 root 且无法读取 /proc/self/status：无法确认 CAP_NET_ADMIN',
    true,
  )

  // ── 3. 外部程序 ──
  const probeBin = async (bin, fatal, required) => {
    if (!required) {
      add(bin, true, `${bin} 不在必需项里，跳过`, false)
      return
    }
    const r = await executor.which(bin)
    add(bin, r.ok, r.ok ? `已找到 ${r.found}` : `PATH 中找不到 ${bin}`, fatal)
  }
  await probeBin('iptables', true, need.needIptables)
  await probeBin('docker', true, need.needDocker)
  await probeBin('redsocks', true, need.needRedsocks)
  await probeBin('qemu-system-x86_64', false, need.needQemu)

  // ── 4. netfilter 可用性 ──
  // 只有 `iptables -t nat -L` 真能跑通，才说明这个内核加载了 nat 表。
  // 容器里常见的情形是 iptables 存在但模块没加载 / 没权限，此时预检必须拦住。
  if (need.needIptables) {
    const r = await executor.run('iptables', ['-t', 'nat', '-L', '-n'], { check: false, quiet: true, timeoutMs: 10_000 })
    if (executor.dryRun) {
      add('netfilter', true, 'dry-run：跳过 nat 表探测', true)
    } else {
      add(
        'netfilter',
        r.ok,
        r.ok ? 'nat 表可列出，netfilter 可用' : `iptables -t nat -L 失败: ${(r.stderr || '').trim().split('\n')[0] || `exit=${r.code}`}`,
        true,
      )
    }
    const names = readSafe(readFile, '/proc/net/ip_tables_names')
    add(
      'netfilter-modules',
      names != null,
      names != null ? '/proc/net/ip_tables_names 可读' : '读不到 /proc/net/ip_tables_names（内核无 iptables 模块或非 Linux）',
      false,
    )
  } else {
    add('netfilter', true, '未要求 iptables，跳过', false)
    add('netfilter-modules', true, '未要求 iptables，跳过', false)
  }

  // ── 5. docker daemon ──
  if (need.needDocker) {
    const r = await executor.run('docker', ['info', '--format', '{{.ServerVersion}}'], {
      check: false,
      quiet: true,
      timeoutMs: 15_000,
    })
    if (executor.dryRun) {
      add('docker-daemon', true, 'dry-run：跳过 daemon 探测', true)
    } else {
      const version = String(r.stdout || '').trim()
      add(
        'docker-daemon',
        r.ok && Boolean(version),
        r.ok && version
          ? `daemon 在线 (server ${version})`
          : `docker daemon 不可用: ${(r.stderr || '').trim().split('\n')[0] || `exit=${r.code}`}`,
        true,
      )
    }
    // bridge 驱动：槽位网络全部依赖它，swarm/overlay 环境里可能不可用
    const drv = await executor.run('docker', ['info', '--format', '{{json .Plugins.Network}}'], {
      check: false,
      quiet: true,
      timeoutMs: 15_000,
    })
    const plugins = String(drv.stdout || '')
    const hasBridge = !drv.ok || executor.dryRun ? true : /bridge/.test(plugins)
    add('docker-bridge-driver', hasBridge, hasBridge ? 'bridge 驱动可用' : `bridge 驱动缺失: ${plugins.trim() || '未知'}`, true)
  } else {
    add('docker-daemon', true, '未要求 docker，跳过', false)
    add('docker-bridge-driver', true, '未要求 docker，跳过', false)
  }

  // ── 6. /dev/kvm ──
  // 只有真要跑 VM 的槽位才需要。缺它不影响容器化槽位，因此不 fatal
  // —— 除非调用方显式声明 needKvm。
  const kvmExists = (() => {
    try {
      return Boolean(exists('/dev/kvm'))
    } catch {
      return false
    }
  })()
  add(
    'dev-kvm',
    kvmExists,
    kvmExists ? '/dev/kvm 存在' : '/dev/kvm 不存在：KVM 加速不可用（仅影响需要虚拟化的槽位）',
    need.needKvm,
  )

  // ── 7. 端口与地址段（静态规划自检，不需要外部命令） ──
  // 只做「宿主机是否能绑 1024 以下端口」这一条：dnsfwd 默认用 21000+ 不涉及，
  // 但把 dnsfwd 改到 :53 就需要。记 warn，避免误伤默认部署。
  add(
    'unprivileged-ports-ok',
    true,
    hasCap ? 'root/CAP_NET_ADMIN 可绑定低端口' : '非特权用户无法绑定 1024 以下端口（默认端口段 21000+ 不受影响）',
    false,
  )

  const fatal = checks.filter((c) => !c.ok && c.fatal)
  const warnings = checks.filter((c) => !c.ok && !c.fatal)
  const passed = checks.filter((c) => c.ok)
  return {
    ok: fatal.length === 0,
    checks,
    fatal: fatal.map((c) => `${c.name}: ${c.detail}`),
    warnings: warnings.map((c) => `${c.name}: ${c.detail}`),
    summary: `通过 ${passed.length}/${checks.length}，致命 ${fatal.length}，告警 ${warnings.length}`,
  }
}

/** 检查结果 → 便于人读的多行文本（CLI 用）。 */
export function renderPreflight(result) {
  const mark = (c) => (c.ok ? 'ok  ' : c.fatal ? 'FATAL' : 'warn')
  const lines = result.checks.map((c) => `  [${mark(c)}] ${c.name.padEnd(24)} ${c.detail}`)
  lines.push('', `  ${result.summary}`)
  return lines.join('\n')
}

export default preflight
