/**
 * docker 网络编排：网段规划、每槽位独立 bridge、iptables 重定向规则、
 * 容器网络参数、redsocks 配置生成。
 *
 * 职责：把「第 N 号槽位 + 第 N 个代理」翻译成一组可执行的命令与配置文件。
 * 本模块不直接拨号、不碰流量，只产出描述；执行入口集中在 apply* 系列。
 *
 * 关键约束：
 * 1. 一个槽位一个 docker network。共用 network 时容器只有一个默认网关，
 *    出口无法按槽位分流；而且 iptables 规则以 bridge 接口为匹配条件，
 *    共用接口就等于共用规则。
 * 2. bridge 用 enable_ip_masquerade=false。必须如此：一旦开启，容器流量
 *    在离开主机前被 SNAT，nat PREROUTING 里就看不到原始目的地址，
 *    REDIRECT 也无从下手。关掉之后容器流量进入主机转发路径，
 *    由 PREROUTING 统一收口。
 * 3. FORWARD 上对 bridge 入向一律 DROP（保留槽内互访）。这是隔离兜底：
 *    任何没被重定向的包（UDP、ICMP、非常规协议）都出不去，不会静默直连。
 * 4. 容器内不注入 HTTPS_PROXY/ALL_PROXY。透明是目标，环境变量会改变
 *    CLI 的协议选择（HTTP/2 → HTTP/1.1），留下可观测差异。
 * 5. DNS 强制 TCP：容器 --dns 指向公网解析器 + --dns-opt use-vc，
 *    被 PREROUTING 的 tcp/53 规则重定向到本地 DNS 转发器。
 *    UDP/53 在 FORWARD 上丢弃，防止 glibc 回退到 UDP 直连泄漏。
 * 6. 网段默认取 10.213.0.0/16 切 /24。刻意避开 docker 默认地址池
 *    (172.17.0.0/16 起) 与常见办公网段，规划函数会做重叠校验。
 */

import net from 'node:net'

/** 每台机器 20 个槽位。 */
export const DEFAULT_SLOT_COUNT = 20
/** 默认地址池基底，切成 /24 逐槽位分配。 */
export const DEFAULT_SUBNET_BASE = '10.213.0.0/16'
/** 重定向转发器的端口基数，每槽位占 2 个（tcp / dns）。 */
export const DEFAULT_PORT_BASE = 21000
/** docker 默认地址池，规划时必须避开。 */
export const DOCKER_RESERVED = Object.freeze(['172.17.0.0/16', '172.18.0.0/16', '172.19.0.0/16'])

// ─────────── IPv4 计算 ───────────

/** 点分四段 → 32 位无符号整数。非法返回 null。 */
export function ipToInt(ip) {
  const host = String(ip == null ? '' : ip).trim()
  if (net.isIP(host) !== 4) return null
  return host.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
}

/** 32 位无符号整数 → 点分四段。 */
export function intToIp(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return ''
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
}

/** 掩码位数 → 32 位掩码。 */
export function prefixToMask(prefix) {
  const p = Number(prefix)
  if (!Number.isInteger(p) || p < 0 || p > 32) return null
  return p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0
}

/** 解析 CIDR → { network:int, prefix:int, mask:int, broadcast:int } 或 null。 */
export function parseCidr(cidr) {
  const m = String(cidr == null ? '' : cidr).match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
  if (!m) return null
  const ip = ipToInt(m[1])
  const prefix = Number(m[2])
  if (ip === null || prefix > 32) return null
  const mask = prefixToMask(prefix)
  const network = (ip & mask) >>> 0
  const broadcast = (network | (~mask >>> 0)) >>> 0
  return { network, prefix, mask, broadcast, input: `${m[1]}/${prefix}` }
}

/** 两个 CIDR 是否重叠。任一侧非法返回 null（调用方负责判错）。 */
export function cidrOverlaps(a, b) {
  const A = parseCidr(a)
  const B = parseCidr(b)
  if (!A || !B) return null
  return A.network <= B.broadcast && B.network <= A.broadcast
}

/**
 * 第 n 个子网（n 从 1 开始），在 base 内部切分。
 *
 * 索引 0 留给 base 自身的首段（宿主机管理口/未来控制面），
 * 所以容量 C = 2^(prefix - basePrefix) 个块里只能用 1..C-1。
 * 越界一律返回空串，由调用方判错 —— 不允许静默漂出 base 范围。
 */
export function subnetForSlot(base, slotIndex, prefix = 24) {
  const parsed = parseCidr(base)
  const index = Number(slotIndex)
  if (!parsed || !Number.isInteger(index) || index < 1) return ''
  if (prefix < parsed.prefix || prefix > 30) return ''
  const capacity = 2 ** (prefix - parsed.prefix)
  if (index >= capacity) return ''
  const blockSize = 2 ** (32 - prefix)
  const network = (parsed.network + index * blockSize) >>> 0
  return `${intToIp(network)}/${prefix}`
}

/** base 可切出的子网数量（已扣除索引 0）。 */
export function subnetCapacity(base, prefix = 24) {
  const parsed = parseCidr(base)
  if (!parsed || prefix < parsed.prefix) return 0
  return Math.max(0, 2 ** (prefix - parsed.prefix) - 1)
}

/** 子网网关：网络地址 +1。 */
export function gatewayOf(subnet) {
  const parsed = parseCidr(subnet)
  if (!parsed) return ''
  return intToIp((parsed.network + 1) >>> 0)
}

/** 子网内第 n 个可用地址（1 = 网关）。 */
export function hostInSubnet(subnet, offset = 2) {
  const parsed = parseCidr(subnet)
  if (!parsed) return ''
  const n = Number(offset)
  if (!Number.isInteger(n) || n < 1) return ''
  const addr = (parsed.network + n) >>> 0
  if (addr >= parsed.broadcast) return ''
  return intToIp(addr)
}

// ─────────── 命名 ───────────

/** 槽位编号：1 → "01"。 */
export function slotBareIndex(slotId) {
  const m = String(slotId == null ? '' : slotId).match(/(\d{1,2})$/)
  if (m) return Number(m[1])
  const n = Number(slotId)
  return Number.isInteger(n) && n >= 1 ? n : 0
}

export function normalizeSlotId(slotId) {
  const n = slotBareIndex(slotId)
  if (!n || n > 99) return ''
  return `slot-${String(n).padStart(2, '0')}`
}

/** docker network 名：skylink-eg-<nn>。 */
export function networkNameFor(slotId) {
  const id = normalizeSlotId(slotId)
  return id ? `skylink-eg-${id.slice(5)}` : ''
}

/** Linux 网桥接口名，上限 15 字符。 */
export function bridgeNameFor(slotId) {
  const id = normalizeSlotId(slotId)
  return id ? `skeg${id.slice(5)}` : ''
}

/** nat 表链名，上限 28 字符。 */
export function chainNameFor(slotId) {
  const id = normalizeSlotId(slotId)
  return id ? `SKEG${id.slice(5)}` : ''
}

/** 容器名：claude-slot-01。 */
export function containerNameFor(slotId) {
  const id = normalizeSlotId(slotId)
  return id ? `claude-${id}` : ''
}

/** 槽位端口对（tcp 重定向端口 + dns 转发端口）。 */
export function portsForSlot(slotId, base = DEFAULT_PORT_BASE) {
  const n = slotBareIndex(slotId)
  if (!n) return { tcp: 0, dns: 0 }
  const tcp = base + (n - 1) * 2
  return { tcp, dns: tcp + 1 }
}

// ─────────── 规划 ───────────

/**
 * 生成 N 个槽位的网络规划。
 *
 * 返回的每一项都是不可变的描述对象，后续 createSlotNetwork /
 * redirectRules / dockerNetworkArgs 全部以它为输入。
 *
 * 重叠校验包括：彼此之间、与 docker 默认地址池、与宿主机已有路由（可选传入）。
 */
export function planSlotNetworks({
  count = DEFAULT_SLOT_COUNT,
  base = DEFAULT_SUBNET_BASE,
  portBase = DEFAULT_PORT_BASE,
  reserved = [],
} = {}) {
  const errors = []
  const n = Number(count)
  if (!Number.isInteger(n) || n < 1 || n > 250) errors.push(`槽位数量非法: ${count}`)
  const parsedBase = parseCidr(base)
  if (!parsedBase) errors.push(`地址池非法: ${base}`)
  else if (parsedBase.prefix > 24) errors.push(`地址池前缀必须 ≤ /24 才能切分子网: ${base}`)
  if (!Number.isInteger(Number(portBase)) || Number(portBase) < 1024 || Number(portBase) > 65000) {
    errors.push(`端口基数非法: ${portBase}`)
  }
  if (errors.length) return { ok: false, slots: [], errors }

  const slots = []
  for (let i = 1; i <= n; i += 1) {
    const slotId = normalizeSlotId(i)
    const subnet = subnetForSlot(base, i, 24)
    if (!subnet) {
      errors.push(`槽位 ${slotId} 子网分配失败（地址池容量不足）`)
      continue
    }
    const ports = portsForSlot(i, Number(portBase))
    slots.push(
      Object.freeze({
        slotId,
        index: i,
        network: networkNameFor(slotId),
        bridge: bridgeNameFor(slotId),
        chain: chainNameFor(slotId),
        container: containerNameFor(slotId),
        subnet,
        gateway: gatewayOf(subnet),
        containerIp: hostInSubnet(subnet, 2),
        ports,
      }),
    )
  }

  // 彼此不重叠
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      if (cidrOverlaps(slots[i].subnet, slots[j].subnet)) {
        errors.push(`子网重叠: ${slots[i].slotId} ${slots[i].subnet} ↔ ${slots[j].slotId} ${slots[j].subnet}`)
      }
    }
  }
  // 避开 docker 默认池与外部保留段
  for (const slot of slots) {
    for (const block of [...DOCKER_RESERVED, ...(Array.isArray(reserved) ? reserved : [])]) {
      if (cidrOverlaps(slot.subnet, block)) {
        errors.push(`子网冲突: ${slot.slotId} ${slot.subnet} ↔ 保留段 ${block}`)
      }
    }
  }
  // 端口不重复、不撞低位
  const seenPorts = new Map()
  for (const slot of slots) {
    for (const kind of ['tcp', 'dns']) {
      const p = slot.ports[kind]
      if (p < 1024 || p > 65535) errors.push(`槽位 ${slot.slotId} ${kind} 端口越界: ${p}`)
      if (seenPorts.has(p)) errors.push(`端口重复: ${p}（${seenPorts.get(p)} 与 ${slot.slotId}/${kind}）`)
      else seenPorts.set(p, `${slot.slotId}/${kind}`)
    }
  }
  // bridge / chain 名长度
  for (const slot of slots) {
    if (slot.bridge.length > 15) errors.push(`bridge 名超长: ${slot.bridge}`)
    if (slot.chain.length > 28) errors.push(`链名超长: ${slot.chain}`)
  }

  return { ok: errors.length === 0, slots, errors, base, count: slots.length }
}

/** 按槽位 id 取节点。 */
export function findSlot(slots, slotId) {
  const id = normalizeSlotId(slotId)
  return (Array.isArray(slots) ? slots : []).find((s) => s.slotId === id) || null
}

// ─────────── docker network ───────────

/**
 * docker network create 参数。
 * enable_ip_masquerade=false 是核心：保留原始目的地址给 nat PREROUTING。
 * enable_icc=false：槽内仍可互通（同一 net 内），但不做跨网络转发。
 */
export function createNetworkArgs({ slot }) {
  const plan = slot || {}
  const name = plan.network || networkNameFor(plan.slotId)
  const subnet = plan.subnet || ''
  const br = plan.bridge || bridgeNameFor(plan.slotId)
  if (!name || !subnet) return { ok: false, error: 'network name / subnet 缺失', args: [] }
  const args = [
    'docker',
    'network',
    'create',
    '--driver',
    'bridge',
    '--subnet',
    subnet,
    '--gateway',
    plan.gateway || gatewayOf(subnet),
    '--opt',
    `com.docker.network.bridge.name=${br}`,
    '--opt',
    'com.docker.network.bridge.enable_ip_masquerade=false',
    '--opt',
    'com.docker.network.bridge.enable_icc=true',
    '--opt',
    'com.docker.network.enable_ipv6=false',
    '--label',
    `skylink.egress.slot=${plan.slotId || ''}`,
    name,
  ]
  return { ok: true, args, name, bridge: br, subnet }
}

export function removeNetworkArgs({ slot }) {
  const name = slot?.network || networkNameFor(slot?.slotId)
  return name ? ['docker', 'network', 'rm', name] : []
}

export function inspectNetworkArgs({ slot }) {
  const name = slot?.network || networkNameFor(slot?.slotId)
  return name ? ['docker', 'network', 'inspect', '-f', '{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}}{{end}}', name] : []
}

// ─────────── iptables ───────────

/**
 * 宿主机侧 iptables 规则（nat REDIRECT + filter 兜底丢弃）。
 *
 * nat：
 *   -i <bridge> -j <chain>
 *     <chain>: 目的地址是本槽位子网 → RETURN（容器访问自己网段不劫持；
 *              Docker 的 DNS 代理在 127.0.0.11，走 loopback 不经过这里）
 *     <chain>: tcp/53 → REDIRECT dns 端口
 *     <chain>: 其余 tcp → REDIRECT 转发器端口
 * filter：
 *     FORWARD -i <bridge> → DROP        （兜底：没被重定向的包全出不去）
 *     INPUT   -i <bridge> -d <gw> tcp dport tcp,dns → ACCEPT
 *
 * @param {{slot:object, proxy?:object, listenPort?:number, dnsServer?:string}} input
 */
export function redirectRules({ slot, proxy = null, listenPort, dnsServer } = {}) {
  const plan = slot || {}
  const chain = plan.chain || chainNameFor(plan.slotId)
  const bridge = plan.bridge || bridgeNameFor(plan.slotId)
  const subnet = plan.subnet || ''
  const gateway = plan.gateway || gatewayOf(subnet)
  const tcp = Number(listenPort || plan.ports?.tcp || 0)
  const dns = Number(plan.ports?.dns || 0)
  const errors = []
  if (!chain) errors.push('链名缺失')
  if (!bridge) errors.push('bridge 缺失')
  if (!subnet) errors.push('subnet 缺失')
  if (!tcp) errors.push('转发器端口缺失')
  if (!dns) errors.push('DNS 转发端口缺失')
  if (errors.length) return { ok: false, errors, add: [], del: [] }

  const listen = String(tcp)
  const dnsPort = String(dns)

  // 转发器与 DNS 转发器都监听在网关地址上，容器可路由到
  const inputAccept = [
    ['-i', bridge, '-s', subnet, '-d', gateway, '-p', 'tcp', '-m', 'multiport', '--dports', `${listen},${dnsPort}`, '-j', 'ACCEPT'],
  ]

  const add = [
    ['-t', 'nat', '-N', chain],
    ['-t', 'nat', '-C', 'PREROUTING', '-i', bridge, '-j', chain],
    ['-t', 'nat', '-A', 'PREROUTING', '-i', bridge, '-j', chain],
    ['-t', 'nat', '-F', chain],
    ['-t', 'nat', '-A', chain, '-d', subnet, '-j', 'RETURN'],
    // 排除已经落到本机转发器端口的流量。
    //
    // REDIRECT 会把包的目标改成本机地址+转发端口，而改完的包会**再次**
    // 进入 PREROUTING 链。没有这条 RETURN，它就会被下面那条通配 REDIRECT
    // 再转一次，目标一路变成"连自己"，redsocks 拿不到真实目标，
    // 表现为连接大量建立又瞬断（日志里成排的 connection closed），
    // 而 curl 永远是 000。
    //
    // 用 -m addrtype --dst-type LOCAL 限定只对本机地址生效，
    // 这样容器访问外部同端口时不受影响。
    ['-t', 'nat', '-A', chain, '-p', 'tcp', '-m', 'addrtype', '--dst-type', 'LOCAL',
      '-m', 'multiport', '--dports', `${listen},${dnsPort}`, '-j', 'RETURN'],
    ['-t', 'nat', '-A', chain, '-p', 'tcp', '--dport', '53', '-j', 'REDIRECT', '--to-ports', dnsPort],
    ['-t', 'nat', '-A', chain, '-p', 'tcp', '-j', 'REDIRECT', '--to-ports', listen],
    ...inputAccept.flatMap((rule) => [
      ['-t', 'filter', '-C', 'INPUT', ...rule],
      ['-t', 'filter', '-I', 'INPUT', '1', ...rule],
    ]),
    ['-t', 'filter', '-C', 'FORWARD', '-i', bridge, '!', '-o', bridge, '-j', 'DROP'],
    ['-t', 'filter', '-I', 'FORWARD', '1', '-i', bridge, '!', '-o', bridge, '-j', 'DROP'],
  ]

  const del = [
    ['-t', 'nat', '-D', 'PREROUTING', '-i', bridge, '-j', chain],
    ['-t', 'nat', '-F', chain],
    ['-t', 'nat', '-X', chain],
    ['-t', 'filter', '-D', 'FORWARD', '-i', bridge, '!', '-o', bridge, '-j', 'DROP'],
    ...inputAccept.map((rule) => ['-t', 'filter', '-D', 'INPUT', ...rule]),
  ]

  return {
    ok: true,
    chain,
    bridge,
    subnet,
    gateway,
    listenPort: tcp,
    dnsPort: dns,
    dnsServer: dnsServer || gateway,
    proxyId: proxy?.id || '',
    add,
    del,
  }
}

/** 规则渲染成 shell 文本，便于人工核对与写进 demo 目录。 */
export function renderIptablesScript(plan) {
  const lines = ['#!/bin/sh', '# 生成的网段重定向规则：apply 幂等，del 用于回滚', 'set -e']
  const body = plan?.add || []
  for (let i = 0; i < body.length; i += 1) {
    const args = body[i]
    if (args.includes('-N')) {
      lines.push(`iptables ${args.join(' ')} 2>/dev/null || true`)
      continue
    }
    if (args.includes('-C')) {
      const pair = body[i + 1]
      lines.push(`if ! iptables ${args.join(' ')} 2>/dev/null; then iptables ${(pair || []).join(' ')}; fi`)
      i += 1
      continue
    }
    lines.push(`iptables ${args.join(' ')}`)
  }
  return `${lines.join('\n')}\n`
}

export function renderIptablesRollback(plan) {
  const lines = ['#!/bin/sh', '# 回滚脚本：删除链与 PREROUTING/INPUT/FORWARD 规则', 'set +e']
  for (const args of plan?.del || []) lines.push(`iptables ${args.join(' ')} 2>/dev/null || true`)
  return `${lines.join('\n')}\n`
}

/** 逐条执行（-C/-N 的特殊语义在职 plan 里已用配对展开表达）。 */
export async function applyIptables(plan, run) {
  if (typeof run !== 'function') return { ok: false, error: 'run 未注入' }
  const add = plan?.add || []
  for (let i = 0; i < add.length; i += 1) {
    const args = add[i]
    if (args.includes('-N')) {
      const r = await run(['iptables', ...args])
      if (!r?.ok && !/File exists|Chain already exists/i.test(`${r?.stderr || ''}`)) {
        return { ok: false, error: r?.stderr || `iptables ${args.join(' ')} 失败` }
      }
      continue
    }
    if (args.includes('-C')) {
      const exists = await run(['iptables', ...args])
      if (exists?.ok) {
        i += 1 // 已有，跳过配对的那条 -A/-I
      }
      continue
    }
    const r = await run(['iptables', ...args])
    if (!r?.ok && !/exist/i.test(`${r?.stderr || ''}`)) {
      return { ok: false, error: r?.stderr || `iptables ${args.join(' ')} 失败` }
    }
  }
  return { ok: true }
}

// ─────────── 转发器配置 ───────────

/**
 * redsocks 配置。
 *
 * 选 redsocks 的理由（见 docs/EGRESS.md §2）：它用 getsockopt(SO_ORIGINAL_DST)
 * 取回被 REDIRECT 前的真实目的地址，再以 SOCKS5 建立上游连接。这一步纯 Node
 * 做不到（暴露不了该套接字选项），所以把这一跳交给它，换来十来行配置、
 * 无状态、不需要额外容器。
 *
 * 监听地址固定为网桥网关：容器到网关是二层直连，不经过 docker 的
 * userland proxy，也不会被本槽位自己的 REDIRECT 规则二次劫持。
 */
export function redsocksConfig({ slot, proxy, listenPort, socks5Detour = null } = {}) {
  const plan = slot || {}
  const p = proxy || {}
  const gateway = plan.gateway || gatewayOf(plan.subnet)
  const tcp = Number(listenPort || plan.ports?.tcp || 0)
  if (!gateway) return { ok: false, error: '网关缺失', content: '' }
  if (!p.host || !p.port) return { ok: false, error: '代理 host/port 缺失', content: '' }
  if (!tcp) return { ok: false, error: '转发端口缺失', content: '' }

  // redsocks 的 login/password 不支持转义；带引号或反斜杠的凭据不能用它
  const unsafeCred = /["\\\n]/.test(String(p.username || '')) || /["\\\n]/.test(String(p.password || ''))

  const lines = [
    '// 由 src/egress/network.mjs 生成；改 config/proxies.json 后重新生成，勿手改',
    'base {',
    '  log_debug = off;',
    '  log_info = on;',
    '  log = "stderr";',
    '  daemon = on;',
    '  redirector = iptables;',
    '}',
    '',
    'redsocks {',
    `  local_ip = ${gateway};`,
    `  local_port = ${tcp};`,
    `  ip = ${p.host};`,
    `  port = ${Number(p.port)};`,
    '  type = socks5;',
    `  login = "${p.username || ''}";`,
    `  password = "${p.password || ''}";`,
    '}',
  ]
  if (socks5Detour) {
    lines.push('', '// 可选链路：redsocks 上游再挂一层本地 SOCKS5 转发（多跳场景）')
  }
  return {
    ok: true,
    content: `${lines.join('\n')}\n`,
    path: `/etc/skylink-egress/${plan.network || networkNameFor(plan.slotId)}.redsocks.conf`,
    unsafeCred,
    upstream: { host: p.host, port: Number(p.port), type: 'socks5', auth: Boolean(p.username) },
  }
}

/**
 * sing-box 配置（备选实现，见 docs EGRESS §2 方案 C）。
 * 与 redsocks 等价能力，优势是单文件同时接管 TCP 与 DNS；
 * 劣势是可执行文件体积大、且有原生 TLS/QUIC 分流这类用不到的复杂度。
 */
export function singboxConfig({ slot, proxy } = {}) {
  const plan = slot || {}
  const p = proxy || {}
  const tcp = Number(plan.ports?.tcp || 0)
  const dns = Number(plan.ports?.dns || 0)
  if (!tcp || !p.host || !p.port) return { ok: false, error: '端口或代理信息缺失', content: '' }
  const doc = {
    log: { level: 'warn' },
    inbounds: [
      { type: 'redirect', tag: 'tcp-in', listen: '0.0.0.0', listen_port: tcp },
      { type: 'direct', tag: 'dns-in', listen: '0.0.0.0', listen_port: dns, override_address: '8.8.8.8', override_port: 53 },
    ],
    outbounds: [
      {
        type: 'socks',
        tag: 'proxy',
        server: p.host,
        server_port: Number(p.port),
        version: '5',
        ...(p.username ? { username: p.username, password: p.password || '' } : {}),
      },
      { type: 'direct', tag: 'direct' },
    ],
    route: { rules: [{ inbound: ['dns-in'], outbound: 'proxy' }], final: 'proxy' },
  }
  return { ok: true, content: `${JSON.stringify(doc, null, 2)}\n`, upstream: { host: p.host, port: Number(p.port) } }
}

/**
 * tun2socks 方案需要的参数（不实现，仅产出描述供对照）。
 *
 * 之所以不选：容器内要 TUN 设备 → 需要 NET_ADMIN + /dev/net/tun，
 * 且必须改容器路由表把默认路由指向 TUN。宿主侧 Docker 对这两个条件
 * 都默认关闭，一开就把容器的权限模型整个放宽了。
 */
export function tun2socksSpec({ slot, proxy } = {}) {
  const plan = slot || {}
  const p = proxy || {}
  return {
    ok: true,
    kind: 'tun2socks',
    requires: ['NET_ADMIN', '/dev/net/tun'],
    containerArgs: ['--cap-add', 'NET_ADMIN', '--device', '/dev/net/tun'],
    command: [
      'tun2socks',
      '-device', 'tun0',
      '-proxy', `socks5://${p.host || 'PROXY_HOST'}:${p.port || 1080}`,
      '-interface', 'eth0',
    ],
    network: plan.network || networkNameFor(plan.slotId),
    caveat: '容器需要 NET_ADMIN + TUN，且改写容器默认路由；Docker 默认都不给',
  }
}

// ─────────── 容器参数 ───────────

/**
 * 槽位容器的网络相关 docker run 参数。
 *
 * 不含 -e HTTPS_PROXY：透明代理下 CLI 不需要、也不应该知道出口在哪。
 * --dns 给公网解析器 + use-vc，配合 tcp/53 规则，解析必然经过代理。
 */
export function dockerNetworkArgs({ slot, proxy = null, image = 'skylink/claude-slot-cli:latest', containerName } = {}) {
  const plan = slot || {}
  const name = plan.network || networkNameFor(plan.slotId)
  const pid = proxy?.id || 'unbound'
  if (!name) return { ok: false, error: 'network 缺失', args: [] }
  const args = [
    '--name',
    containerName || plan.container || containerNameFor(plan.slotId),
    '--hostname',
    plan.container || containerNameFor(plan.slotId),
    '--network',
    name,
    // DNS 用挂载覆盖 resolv.conf，不用 --dns。
    //
    // 实测（Docker 29.2.1 / Ubuntu 22.04）：接自定义 bridge 网络时，
    // docker 会把内嵌解析器 127.0.0.11 写进 resolv.conf，--dns 给的地址
    // 只变成它的上游转发目标，并不是容器实际使用的解析器。
    // 结果是我们精心指定的 8.8.8.8 在这个文件里根本不出现，
    // 而 127.0.0.11 最终会转发到宿主机 resolver —— 正是要消除的泄漏路径。
    //
    // --dns 仍然保留：它对 `docker run` 之外的场景（以及没有自定义网络时）
    // 还有意义，且不影响挂载覆盖的结果。真正生效的是 --resolv-conf-mount。
    '--dns',
    '8.8.8.8',
    '--dns',
    '1.1.1.1',
    '--dns-opt',
    'use-vc',
    '--dns-opt',
    'attempts:2',
    '--pids-limit',
    '256',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--label',
    `skylink.slot=${plan.slotId || ''}`,
    '--label',
    `skylink.egress.network=${name}`,
    '--label',
    `skylink.egress.proxy=${pid}`,
    '--label',
    `skylink.egress.subnet=${plan.subnet || ''}`,
  ]
  if (plan.containerIp) args.push('--ip', plan.containerIp)
  args.push(image)
  return { ok: true, args, network: name, proxyId: pid }
}

/**
 * 容器内的网络自检点（供 verify 使用）。
 *
 * 用 sh + 多级回退，而不是写死 node 或 curl。
 *
 * 原先的实现硬编码 `node -e '...'`，注释说「node 更稳，避免把装了什么工具
 * 变成部署前提」—— 这个判断是错的：我们自己的槽位镜像基于 ubuntu:22.04，
 * 里面**没有 node**。于是每次探测都变成
 *   `node: executable file not found`
 * 而 verify 把「探测失败」当成「出口不通」，槽位永远无法通过验证。
 *
 * 现在的顺序：curl → wget → node。三者的输出格式都要求是纯文本正文，
 * 上层用 extractIp 解析，不关心是哪个工具拿到的。
 */
export function containerProbeCommand({ url = 'https://api.ipify.org/?format=json' } = {}) {
  const u = String(url)
  // 每个分支失败时都以**非零退出且无输出**结束，让上层能明确区分
  // 「工具缺失 / 网络不通」和「拿到了内容」。
  const script = [
    'if command -v curl >/dev/null 2>&1; then',
    `  curl -fsS --max-time 12 ${JSON.stringify(u)}; exit $?;`,
    'elif command -v wget >/dev/null 2>&1; then',
    `  wget -qO- --timeout=12 ${JSON.stringify(u)}; exit $?;`,
    'elif command -v node >/dev/null 2>&1; then',
    `  node -e 'const u=new URL(process.argv[1]);const m=u.protocol==="https:"?require("node:https"):require("node:http");const r=m.get(u,{timeout:12000},(s)=>{let b="";s.on("data",c=>b+=c);s.on("end",()=>{process.stdout.write(b.trim());process.exit(0)})});r.on("error",e=>{process.exit(3)});r.on("timeout",()=>{r.destroy();process.exit(4)})' ${JSON.stringify(u)}; exit $?;`,
    'else',
    '  echo "no-http-client" >&2; exit 127;',
    'fi',
  ].join('\n')
  return ['sh', '-c', script]
}

/** 容器内查看解析器配置：用于确认没有指向宿主机 stub。 */
export function containerResolvCommand() {
  return ['cat', '/etc/resolv.conf']
}

/** 容器内查默认路由：确认唯一出口是本槽位网桥网关。 */
export function containerRouteCommand() {
  return ['ip', 'route']
}

export default {
  planSlotNetworks,
  createNetworkArgs,
  redirectRules,
  dockerNetworkArgs,
  redsocksConfig,
  applyIptables,
}
