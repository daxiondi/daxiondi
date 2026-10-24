/**
 * 蓝图：把「代理池 + 槽位规划」编成一份完整可执行的部署描述。
 *
 * 职责：这是唯一把 pool / network / dnsfwd / verify 串起来的地方。
 * 输出是纯数据（JSON），不含闭包、不含句柄，可直接落盘或过 IPC。
 *
 * 关键约束：
 * 1. 蓝图必须能在「代理是占位符」的情况下完整生成。缺代理不等于缺槽位：
 *    20 个网段、20 套规则、20 个容器参数照样产出，代理字段留占位。
 * 2. 每个槽位的 id 只由序号决定，不由代理决定。换了代理只改一条记录，
 *    网段和规则不动 —— 否则换代理会连带重建网段，已有容器全部失联。
 * 3. 蓝图里不含任何明文密码。密码只进 redsocks 配置文件（600 权限），
 *    JSON 快照里用 has_auth 布尔位代替。
 */

import {
  DEFAULT_PORT_BASE,
  DEFAULT_SLOT_COUNT,
  DEFAULT_SUBNET_BASE,
  chainNameFor,
  containerNameFor,
  containerProbeCommand,
  containerResolvCommand,
  createNetworkArgs,
  dockerNetworkArgs,
  gatewayOf,
  networkNameFor,
  bridgeNameFor,
  planSlotNetworks,
  redsocksConfig,
  redirectRules,
  renderIptablesRollback,
  renderIptablesScript,
  singboxConfig,
  tun2socksSpec,
  portsForSlot,
} from './network.mjs'
import { assignProxies } from './pool.mjs'

/**
 * 单槽位蓝图（可直接照抄部署的那一份）。
 *
 * @param {{slot:object, proxy?:object, mode?:string, image?:string}} input
 */
export function buildSlotBlueprint({ slot, proxy = null, mode = 'iptables-redirect', image } = {}) {
  const s = slot || {}
  const errors = []
  if (!s.slotId) errors.push('slot.slotId 缺失')
  if (!s.subnet) errors.push('slot.subnet 缺失')
  if (errors.length) return { ok: false, errors }
  if (!['iptables-redirect', 'tun2socks', 'env-proxy'].includes(mode)) {
    return { ok: false, errors: [`未知转发模式: ${mode}`] }
  }

  const network = createNetworkArgs({ slot: s })
  const rules = redirectRules({ slot: s, proxy })
  const dockerNet = dockerNetworkArgs({ slot: s, proxy, ...(image ? { image } : {}) })
  const redsocks = mode === 'iptables-redirect' ? redsocksConfig({ slot: s, proxy: proxy || {} }) : null
  const singbox = mode === 'iptables-redirect' && proxy ? singboxConfig({ slot: s, proxy }) : null
  const tun = mode === 'tun2socks' ? tun2socksSpec({ slot: s, proxy: proxy || {} }) : null

  const proxyView = proxy
    ? {
        id: proxy.id,
        type: proxy.type,
        host: proxy.host,
        port: proxy.port,
        region: proxy.region || '',
        expected_exit_ip: proxy.expectedExitIp || '',
        has_auth: Boolean(proxy.username),
        placeholder: proxy.placeholder === true,
      }
    : null

  // 凭据只出现在 forwarder 配置文件里（落盘 0600），不进 JSON 快照
  const containsSecrets = Boolean(
    proxy?.password && (redsocks?.ok || singbox?.ok),
  )

  return {
    ok: true,
    mode,
    containsSecrets,
    slot: {
      slotId: s.slotId,
      index: s.index,
      network: s.network,
      bridge: s.bridge,
      chain: s.chain,
      container: s.container,
      subnet: s.subnet,
      gateway: s.gateway,
      containerIp: s.containerIp,
      ports: s.ports,
    },
    proxy: proxyView,
    forwarder: {
      kind: mode === 'iptables-redirect' ? 'redsocks' : mode === 'tun2socks' ? 'tun2socks' : 'none',
      listen: `${s.gateway}:${s.ports?.tcp || 0}`,
      dnsListen: `${s.gateway}:${s.ports?.dns || 0}`,
      dnsUpstreams: ['8.8.8.8', '1.1.1.1'],
      dnsMode: 'tcp',
    },
    docker: {
      networkCreate: network.args,
      containerArgs: ['docker', 'run', '-d', ...dockerNet.args],
      cleanup: ['docker', 'network', 'rm', s.network],
    },
    iptables: { add: rules.add || [], del: rules.del || [] },
    files: {
      [`redsocks/${s.network}.conf`]: redsocks?.ok ? redsocks.content : null,
      [`singbox/${s.network}.json`]: singbox?.ok ? singbox.content : null,
      [`iptables/${s.network}.up.sh`]: renderIptablesScript(rules),
      [`iptables/${s.network}.down.sh`]: renderIptablesRollback(rules),
    },
    probes: {
      exitIp: ['docker', 'exec', s.container, ...containerProbeCommand()],
      resolvConf: ['docker', 'exec', s.container, ...containerResolvCommand()],
    },
    tun2socks: tun,
    warnings: [
      ...(proxy?.placeholder ? [`${s.slotId} 绑定的代理 ${proxy.id} 是占位符，需替换 host/port/凭据`] : []),
      ...(proxy ? [] : [`${s.slotId} 尚未绑定代理，容器不会产生可用出站`]),
      ...(redsocks && redsocks.unsafeCred ? ['凭据含引号或反斜杠，redsocks 配置无法安全表达，改用 singbox 变体'] : []),
    ],
  }
}

/**
 * 全量蓝图：20 槽位 + 分配结果。
 *
 * 代理不足时仍产出全部槽位（unbound 的槽位带 warnings），
 * 但 ok=false 并列出缺口 —— 让用户一眼看到「还差几个代理」。
 */
export function buildFleetBlueprint({
  proxies = [],
  count = DEFAULT_SLOT_COUNT,
  base = DEFAULT_SUBNET_BASE,
  portBase = DEFAULT_PORT_BASE,
  reserved = [],
  mode = 'iptables-redirect',
  image,
  strict = true,
  // 资源分配（来自 planFleet）。必须一路带进 slot，否则 orchestrator
  // 拿不到真实的内存/CPU 限额，persona 只能退回默认 1024MB ——
  // 结果 MemTotal 报 1GB 而容器 cgroup 是 2.5GB，比值 0.39 一眼看穿。
  resources = null,
  timezone = null,
} = {}) {
  const plan = planSlotNetworks({ count, base, portBase, reserved })
  if (!plan.ok) return { ok: false, errors: plan.errors, slots: [], fleet: null }

  const slotsForAssign = plan.slots.map((s) => ({ slotId: s.slotId }))
  const assigned = assignProxies({ slots: slotsForAssign, proxies, strict: false })
  const bySlot = new Map(assigned.assignments.map((a) => [a.slotId, a.proxy]))

  // 资源按 slotId 尾号映射到 planFleet 的分配结果
  const resFor = (slotId) => {
    if (!resources) return {}
    if (Array.isArray(resources)) {
      const idx = (Number(String(slotId).match(/(\d+)$/)?.[1] || 1) - 1)
      return resources[idx] || {}
    }
    return resources[slotId] || {}
  }

  const entries = plan.slots.map((slot) => {
    const proxy = bySlot.get(slot.slotId) || null
    const res = resFor(slot.slotId)
    const bp = buildSlotBlueprint({ slot, proxy, mode, ...(image ? { image } : {}) })
    if (!bp.ok) return bp
    // 把资源与代理 region 一并挂到 slot 上，
    // orchestrator 的 slotMemoryLimit / timezoneForProxy 直接用
    return {
      ...bp,
      slot: {
        ...bp.slot,
        ...(res.memoryMb ? { memoryMb: res.memoryMb } : {}),
        ...(res.cpus ? { cpus: res.cpus } : {}),
        ...(res.diskMb ? { diskMb: res.diskMb } : {}),
        ...(timezone ? { timezone } : {}),
      },
    }
  })

  const unbound = entries.filter((e) => e.ok && !e.proxy).map((e) => e.slot.slotId)
  const errors = []
  if (assigned.errors.length) errors.push(...assigned.errors)
  if (unbound.length && strict) errors.push(`代理不足，以下槽位未绑定: ${unbound.join(', ')}`)
  const declared = proxies.filter((p) => p && p.enabled !== false).length
  if (declared > plan.slots.length) {
    errors.push(`代理数 ${declared} 超过槽位数 ${plan.slots.length}，多余代理未使用`)
  }

  return {
    ok: errors.length === 0,
    errors,
    mode,
    subnetBase: base,
    count: plan.slots.length,
    slots: entries,
    unbound,
    table: plan.slots.map((s) => {
      const proxy = bySlot.get(s.slotId)
      return {
        slotId: s.slotId,
        container: s.container,
        network: s.network,
        bridge: s.bridge,
        subnet: s.subnet,
        gateway: s.gateway,
        containerIp: s.containerIp,
        tcpPort: s.ports.tcp,
        dnsPort: s.ports.dns,
        proxyId: proxy?.id || '',
        proxyHost: proxy ? `${proxy.host}:${proxy.port}` : '',
        placeholder: proxy?.placeholder === true,
      }
    }),
  }
}

/** 蓝图 → 适合落盘的文本文件集合（密码已剥离）。 */
export function renderFleetFiles(blueprint) {
  const files = {}
  // fleet.json / SUBNETS.md 是可自由分发的快照：只含规划与代理标识，不含凭据
  const snapshot = {
    generated_by: 'src/egress/plan.mjs',
    mode: blueprint.mode,
    subnet_base: blueprint.subnetBase,
    count: blueprint.count,
    unbound: blueprint.unbound,
    slots_with_secrets: blueprint.slots.filter((s) => s.ok && s.containsSecrets).map((s) => s.slot.slotId),
    table: blueprint.table,
  }
  files['fleet.json'] = `${JSON.stringify(snapshot, null, 2)}\n`

  const mdLines = [
    '# 20 槽位网络规划',
    '',
    '| 槽位 | 容器 | docker network | bridge | subnet | 网关 | 容器 IP | tcp | dns | 代理 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const row of blueprint.table) {
    mdLines.push(
      `| ${row.slotId} | ${row.container} | ${row.network} | ${row.bridge} | ${row.subnet} | ${row.gateway} | ${row.containerIp} | ${row.tcpPort} | ${row.dnsPort} | ${row.proxyId || '（未绑定）'}${row.placeholder ? ' *占位*' : ''} |`,
    )
  }
  files['SUBNETS.md'] = `${mdLines.join('\n')}\n`

  for (const entry of blueprint.slots) {
    if (!entry.ok) continue
    const dir = `slots/${entry.slot.slotId}`
    files[`${dir}/blueprint.json`] = `${JSON.stringify(entry, null, 2)}\n`
    for (const [rel, content] of Object.entries(entry.files || {})) {
      if (typeof content === 'string') files[`${dir}/${rel}`] = content
    }
  }
  return files
}

/**
 * 便捷：直接从规划表取一个槽位（不建池）。
 * slotId 接受 'slot-07' / '7' 两种写法。
 */
export function slotFor(slotId, opts = {}) {
  const plan = planSlotNetworks(opts)
  if (!plan.ok) return null
  const raw = String(slotId == null ? '' : slotId).trim()
  const wanted = /^slot-\d+$/.test(raw) ? raw.replace(/^slot-(\d)$/, 'slot-0$1') : `slot-${raw.padStart(2, '0')}`
  return plan.slots.find((s) => s.slotId === wanted) || null
}

export {
  DEFAULT_SLOT_COUNT,
  DEFAULT_SUBNET_BASE,
  DEFAULT_PORT_BASE,
  networkNameFor,
  bridgeNameFor,
  chainNameFor,
  containerNameFor,
  gatewayOf,
  portsForSlot,
}
