#!/usr/bin/env node
/**
 * egress 模块单测：代理池、网段规划、iptables 规则、docker 参数、
 * SOCKS5 字节协议、DNS 转发、出口验证判定。
 *
 * 运行：node test/egress.mjs
 * 约束：不联网。所有拨号路径都注入假实现；占位符代理必须走 skip 分支。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

import {
  SLOT_COUNT,
  assignProxies,
  checkPoolHealth,
  checkProxyHealth,
  defaultConfigPath,
  extractIpFromBody,
  isPlaceholderHost,
  isProxyUsable,
  loadProxyPool,
  normalizePool,
  redactProxy,
  validateProxy,
} from '../src/egress/pool.mjs'
import {
  DEFAULT_SUBNET_BASE,
  bridgeNameFor,
  chainNameFor,
  cidrOverlaps,
  containerNameFor,
  containerProbeCommand,
  createNetworkArgs,
  dockerNetworkArgs,
  gatewayOf,
  hostInSubnet,
  intToIp,
  ipToInt,
  networkNameFor,
  parseCidr,
  planSlotNetworks,
  portsForSlot,
  redsocksConfig,
  redirectRules,
  renderIptablesRollback,
  renderIptablesScript,
  singboxConfig,
  subnetCapacity,
  subnetForSlot,
  tun2socksSpec,
} from '../src/egress/network.mjs'
import {
  ATYP_DOMAIN,
  ATYP_IPV4,
  ATYP_IPV6,
  encodeTarget,
  ipv6ToBuffer,
  negotiate,
  normalizeHost,
  normalizePort,
  openTunnel,
  proxyUrl,
} from '../src/egress/socks5.mjs'
import {
  buildQuery,
  createTcpFramer,
  createTcpHandler,
  errorResponse,
  frameTcp,
  parseAnswerIps,
  relayOverProxy,
  startDnsForwarder,
} from '../src/egress/dnsfwd.mjs'
import {
  CHECK_KINDS,
  classifyNameserver,
  evaluateEgress,
  extractIp,
  extractResolution,
  parseNameservers,
  preflightEgress,
  tcpProbeScript,
  verifyEgress,
} from '../src/egress/verify.mjs'
import { buildFleetBlueprint, buildSlotBlueprint, renderFleetFiles, slotFor } from '../src/egress/plan.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-test-'))

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass += 1
    console.log('  ok   ', name)
  } else {
    fail += 1
    console.log('  FAIL ', name, '\n         got ', g, '\n         want', w)
  }
}
const ok = (name, cond) => eq(name, Boolean(cond), true)
const has = (name, arr, needle) =>
  ok(name, Array.isArray(arr) && arr.some((item) => JSON.stringify(item) === JSON.stringify(needle)))

// ─────────── 1. 占位符与基础归一 ───────────

console.log('\n[1] 占位符识别与地址归一')
ok('example.com 判为占位符', isPlaceholderHost('example.com'))
ok('192.0.2.10（文档保留段）判为占位符', isPlaceholderHost('192.0.2.10'))
ok('203.0.113.5 判为占位符', isPlaceholderHost('203.0.113.5'))
ok('1.2.3.4 判为占位符', isPlaceholderHost('1.2.3.4'))
ok('<YOUR_HOST> 判为占位符', isPlaceholderHost('<YOUR_HOST>'))
ok('真实住宅 IP 不是占位符', !isPlaceholderHost('47.88.12.34'))
eq('IPv4 归一', normalizeHost(' 10.0.0.1 '), '10.0.0.1')
eq('IPv6 方括号剥除', normalizeHost('[2001:db8::1]'), '2001:db8::1')
eq('含空格的主机名被拒', normalizeHost('bad host'), '')
eq('端口合法', normalizePort('1080'), 1080)
eq('端口 0 被拒', normalizePort(0), 0)
eq('端口 70000 被拒', normalizePort(70000), 0)
eq('代理 URL 免认证', proxyUrl({ host: '1.2.3.4', port: 1080 }), 'socks5h://1.2.3.4:1080')
eq(
  '代理 URL 带认证并转义',
  proxyUrl({ host: 'p.example.com', port: 1080, username: 'u@x', password: 'p:w' }),
  'socks5h://u%40x:p%3Aw@p.example.com:1080',
)
eq('proxyUrl 支持 IPv6 字面量', proxyUrl({ host: '2001:db8::2', port: 1080 }), 'socks5h://[2001:db8::2]:1080')

// ─────────── 2. 代理池加载与校验 ───────────

console.log('\n[2] 代理池加载与校验')

const goodJson = {
  proxies: [
    { id: 'p01', type: 'socks5', host: '47.88.12.34', port: 1080, region: 'us-west', expected_exit_ip: '47.88.12.34' },
    { id: 'p02', type: 'socks5h', host: 'proxy.example.com', port: 1080, username: 'u', password: 'x', region: 'us-east' },
  ],
}
const goodPath = path.join(TMP, 'good.json')
fs.writeFileSync(goodPath, JSON.stringify(goodJson))

const loaded = loadProxyPool(goodPath)
ok('合法配置加载成功', loaded.ok)
eq('载入 2 条', loaded.proxies.length, 2)
eq('byId 索引可用', loaded.byId.get('p02').region, 'us-east')
ok('占位符条目给出警告', loaded.warnings.some((w) => w.includes('占位符')))
ok('占位符条目标记 placeholder', loaded.byId.get('p02').placeholder === true)
ok('真实 IP 条目未标记 placeholder', loaded.byId.get('p01').placeholder === false)

const missing = path.join(TMP, 'missing.json')
const missingRes = loadProxyPool(missing)
ok('文件不存在时 ok=false 且不抛', missingRes.ok === false && missingRes.errors.length === 1)
ok('缺文件的错误文案含读取失败', /读取失败/.test(missingRes.errors[0]))

const broken = path.join(TMP, 'broken.json')
fs.writeFileSync(broken, '{ not json')
ok('坏 JSON 被判失败', loadProxyPool(broken).ok === false)
ok('坏 JSON 错误文案含解析失败', /JSON 解析失败/.test(loadProxyPool(broken).errors[0]))

const badShape = path.join(TMP, 'bad-shape.json')
fs.writeFileSync(badShape, JSON.stringify({ items: [] }))
ok('顶层结构不对被判失败', loadProxyPool(badShape).ok === false)
ok('空列表被判失败', normalizePool([]).ok === false)

const missingField = validateProxy({ id: 'p1', type: 'socks5', host: '47.88.12.34' })
ok('缺 port 报错', missingField.errors.some((e) => e.includes('port')))
eq('缺 port 时不产出可用 url', missingField.proxy.url, '')

const badType = validateProxy({ id: 'p1', type: 'http', host: '47.88.12.34', port: 8080 })
ok('http 类型被拒（只支持 socks5）', badType.errors.some((e) => e.includes('type')))

const badId = validateProxy({ id: 'p 1!', type: 'socks5', host: '47.88.12.34', port: 1080 })
ok('非法 id 报错', badId.errors.some((e) => e.includes('.id')))

const badExit = validateProxy({
  id: 'p1',
  type: 'socks5',
  host: '47.88.12.34',
  port: 1080,
  expected_exit_ip: 'not-an-ip',
})
ok('expected_exit_ip 非 IP 报错', badExit.errors.some((e) => e.includes('expected_exit_ip')))

const pwNoUser = validateProxy({ id: 'p1', type: 'socks5', host: '47.88.12.34', port: 1080, password: 'x' })
ok('有 password 无 username 报错', pwNoUser.errors.some((e) => e.includes('username 为空')))
ok('单条合法条目无错误', validateProxy(goodJson.proxies[0]).errors.length === 0)

const dup = normalizePool([
  { id: 'p1', type: 'socks5', host: '47.88.12.34', port: 1080 },
  { id: 'p1', type: 'socks5', host: '47.88.12.35', port: 1080 },
])
ok('重复 id 被判失败', dup.ok === false)
ok('重复 id 错误文案指明重复', dup.errors.some((e) => e.includes('重复')))

eq('redactProxy 抹掉密码', redactProxy({ id: 'p1', username: 'u', password: 'secret' }).password, '***')
eq('redactProxy 保留用户名', redactProxy({ id: 'p1', username: 'u', password: 's' }).username, 'u')
ok('isProxyUsable 拒绝占位符', isProxyUsable({ id: 'p', host: 'example.com', port: 1080 }) === false)
ok('isProxyUsable 接受真实代理', isProxyUsable({ id: 'p', host: '47.88.12.34', port: 1080 }) === true)
ok('isProxyUsable 拒绝 disabled', isProxyUsable({ id: 'p', host: '47.88.12.34', port: 1080, enabled: false }) === false)
eq('默认配置路径在 config/ 下', path.basename(defaultConfigPath('/x')), 'proxies.json')

// ─────────── 3. 网段规划 ───────────

console.log('\n[3] 20 槽位网段规划')
eq('ipToInt', ipToInt('10.213.1.1'), 0x0ad50101)
eq('intToIp 往返', intToIp(ipToInt('10.213.1.1')), '10.213.1.1')
eq('ipToInt 拒绝非法', ipToInt('10.213.1'), null)
eq('parseCidr 解析 /24', parseCidr('10.213.1.0/24').prefix, 24)
eq('parseCidr 拒绝非法', parseCidr('10.213.1.0/33'), null)
eq('subnetForSlot 第 1 个', subnetForSlot('10.213.0.0/16', 1), '10.213.1.0/24')
eq('subnetForSlot 第 20 个', subnetForSlot('10.213.0.0/16', 20), '10.213.20.0/24')
eq('subnetForSlot 越界返回空', subnetForSlot('10.213.0.0/24', 300), '')
eq('subnetForSlot 末位可用', subnetForSlot('10.213.0.0/16', 255), '10.213.255.0/24')
eq('subnetForSlot 超出容量返回空', subnetForSlot('10.213.0.0/16', 256), '')
eq('/24 基底切不出任何 /24（索引 0 保留）', subnetForSlot('10.9.0.0/24', 1), '')
eq('/20 基底容量 15', subnetCapacity('10.40.0.0/20'), 15)
eq('/16 基底容量 255', subnetCapacity('10.213.0.0/16'), 255)
eq('/24 基底容量 0', subnetCapacity('10.9.0.0/24'), 0)
eq('20 个槽位远未触及容量上限', subnetCapacity('10.213.0.0/16') > 20, true)
eq('gatewayOf 取 +1', gatewayOf('10.213.7.0/24'), '10.213.7.1')
eq('hostInSubnet 取 +2', hostInSubnet('10.213.7.0/24', 2), '10.213.7.2')
eq('cidrOverlaps 同段为真', cidrOverlaps('10.213.1.0/24', '10.213.1.0/24'), true)
eq('cidrOverlaps 异段为假', cidrOverlaps('10.213.1.0/24', '10.213.2.0/24'), false)

const plan = planSlotNetworks()
ok('默认规划成功', plan.ok)
eq('默认 20 个槽位', plan.slots.length, SLOT_COUNT)
eq('槽位名从 01 起', plan.slots[0].slotId, 'slot-01')
eq('地址池记录正确', plan.base, DEFAULT_SUBNET_BASE)

const subnets = plan.slots.map((s) => s.subnet)
eq('20 个 subnet 互不相同', new Set(subnets).size, 20)
let pairConflicts = 0
for (let i = 0; i < plan.slots.length; i += 1) {
  for (let j = i + 1; j < plan.slots.length; j += 1) {
    if (cidrOverlaps(plan.slots[i].subnet, plan.slots[j].subnet)) pairConflicts += 1
  }
}
eq('两两不重叠（190 对全查）', pairConflicts, 0)
eq('不与 docker 默认池冲突（172.17/16）', cidrOverlaps(plan.slots[0].subnet, '172.17.0.0/16'), false)

const tcpPorts = plan.slots.map((s) => s.ports.tcp)
eq('20 个重定向端口互不相同', new Set(tcpPorts).size, 20)
eq('第 1 槽 tcp 端口', plan.slots[0].ports.tcp, 21000)
eq('第 1 槽 dns 端口', plan.slots[0].ports.dns, 21001)
eq('第 20 槽 tcp 端口', plan.slots[19].ports.tcp, 21038)
eq('端口对不重叠', portsForSlot('slot-01').dns, portsForSlot('slot-02').tcp - 1)
ok('bridge 名都在 15 字符内', plan.slots.every((s) => s.bridge.length <= 15))
ok('链名都在 28 字符内', plan.slots.every((s) => s.chain.length <= 28))
eq('网络命名', networkNameFor('slot-07'), 'skylink-eg-07')
eq('bridge 命名', bridgeNameFor('slot-07'), 'skeg07')
eq('链命名', chainNameFor('slot-07'), 'SKEG07')
eq('容器命名', containerNameFor('slot-07'), 'claude-slot-07')
eq('非数字槽位名归一', networkNameFor('slot-7'), 'skylink-eg-07')
eq('空槽位名返回空', networkNameFor(''), '')

const conflict = planSlotNetworks({ base: '172.17.0.0/16' })
ok('地址池撞 docker 默认池被判失败', conflict.ok === false)
ok('冲突错误文案指明保留段', conflict.errors.some((e) => e.includes('保留段')))

const tooSmall = planSlotNetworks({ base: '10.9.0.0/24', count: 20 })
ok('/24 切不出 20 段时判失败', tooSmall.ok === false)

const wide = planSlotNetworks({ count: 40 })
ok('可扩展到 40 槽位', wide.ok && wide.slots.length === 40)

// ─────────── 4. 槽位分配 ───────────

console.log('\n[4] 代理 → 槽位一对一分配')

const mk = (id) => ({ id, host: '47.88.12.34', port: 1080, enabled: true })
const twenty = Array.from({ length: 20 }, (_, i) => mk(`p${String(i + 1).padStart(2, '0')}`))
const slotList = plan.slots.map((s) => ({ slotId: s.slotId }))
const assigned = assignProxies({ slots: slotList, proxies: twenty })
ok('20 代理 → 20 槽位成功', assigned.ok)
eq('全部槽位都有分配', assigned.assignments.length, 20)
eq('无未分配槽位', assigned.unassigned.length, 0)
eq('每个代理只用一次', new Set(assigned.assignments.map((a) => a.proxyId)).size, 20)

const oneProxy = assignProxies({ slots: slotList, proxies: [mk('only')], strict: false })
eq('单代理只覆盖一个槽位', oneProxy.assignments.length, 1)
eq('剩余 19 个槽位未分配', oneProxy.unassigned.length, 19)
ok('未分配里没有重复槽位', new Set(oneProxy.unassigned).size === 19)
ok(
  '同一代理没有出现在两条分配里',
  new Set(oneProxy.assignments.map((a) => a.proxyId)).size === oneProxy.assignments.length,
)

const strictFail = assignProxies({ slots: slotList, proxies: [mk('only')] })
ok('严格模式下代理不足判失败', strictFail.ok === false)

const pinnedDup = assignProxies({
  slots: [
    { slotId: 'slot-01', pinnedProxyId: 'p01' },
    { slotId: 'slot-02', pinnedProxyId: 'p01' },
  ],
  proxies: [mk('p01'), mk('p02')],
})
ok('两个槽位抢同一代理被判失败', pinnedDup.ok === false)
ok('重复绑定错误被报出', pinnedDup.errors.some((e) => e.includes('重复绑定')))

const pinnedOk = assignProxies({
  slots: [{ slotId: 'slot-01', pinnedProxyId: 'p02' }],
  proxies: [mk('p01'), mk('p02')],
})
eq('显式绑定优先生效', pinnedOk.assignments[0].proxyId, 'p02')
ok('显式绑定被标记', pinnedOk.assignments[0].pinned === true)

const regionAssign = assignProxies({
  slots: [{ slotId: 'slot-01', region: 'us-east' }],
  proxies: [{ ...mk('p01'), region: 'us-west' }, { ...mk('p02'), region: 'us-east' }],
})
eq('region 匹配生效', regionAssign.assignments[0].proxyId, 'p02')
ok('region 匹配被标记', regionAssign.assignments[0].matched === 'region')

const disabledSkip = assignProxies({
  slots: [{ slotId: 'slot-01' }],
  proxies: [{ ...mk('p01'), enabled: false }, mk('p02')],
  strict: false,
})
eq('禁用代理不参与分配', disabledSkip.assignments[0]?.proxyId, 'p02')

// ─────────── 5. docker 网络参数 ───────────

console.log('\n[5] docker 网络参数')
const slot1 = plan.slots[0]
const netArgs = createNetworkArgs({ slot: slot1 })
ok('网络参数生成成功', netArgs.ok)
has('使用 bridge 驱动', netArgs.args, '--driver')
ok('带 --subnet', netArgs.args.includes('--subnet') && netArgs.args.includes('10.213.1.0/24'))
ok('带 --gateway', netArgs.args.includes('10.213.1.1'))
ok(
  '关闭 masquerade（保留原始目的地址）',
  netArgs.args.some((a) => a === 'com.docker.network.bridge.enable_ip_masquerade=false'),
)
ok('固定网桥名', netArgs.args.some((a) => a === 'com.docker.network.bridge.name=skeg01'))
ok('关闭 IPv6', netArgs.args.includes('com.docker.network.enable_ipv6=false'))
eq('网络名出现在末尾', netArgs.args.at(-1), 'skylink-eg-01')

const dockerArgs = dockerNetworkArgs({ slot: slot1, proxy: twenty[0] })
ok('容器网络参数生成成功', dockerArgs.ok)
ok('挂在槽位专属网络上', dockerArgs.args[dockerArgs.args.indexOf('--network') + 1] === 'skylink-eg-01')
ok('指定容器固定 IP', dockerArgs.args.includes('--ip') && dockerArgs.args.includes('10.213.1.2'))
ok('DNS 指向公网解析器', dockerArgs.args.includes('8.8.8.8') && dockerArgs.args.includes('1.1.1.1'))
ok('强制 DNS over TCP', dockerArgs.args.includes('use-vc'))
ok('不注入 HTTPS_PROXY', !dockerArgs.args.some((a) => /^(HTTPS_PROXY|HTTP_PROXY|ALL_PROXY)=/i.test(String(a))))
ok('标签带上代理 id', dockerArgs.args.includes('skylink.egress.proxy=p01'))
ok('未绑定时标签写 unbound', dockerNetworkArgs({ slot: slot1 }).args.includes('skylink.egress.proxy=unbound'))
// 探针不能写死单一工具：槽位镜像基于 ubuntu:22.04，里面没有 node。
// 写死 node 会让每次探测都 "executable file not found"，
// 而 verify 把探测失败当成"出口不通"，槽位永远过不了验证。
{
  const probe = containerProbeCommand()
  ok('探针走 sh，便于多级回退', probe[0] === 'sh' && probe[1] === '-c')
  const body = String(probe[2] || '')
  ok('优先 curl（镜像自带）', /command -v curl/.test(body))
  ok('回退 wget', /command -v wget/.test(body))
  ok('再回退 node', /command -v node/.test(body))
  ok('全缺失时以 127 明确失败', /no-http-client/.test(body) && /exit 127/.test(body))
  // URL 必须被引号包裹，否则 & 会被 shell 解释（?format=json&foo=1 这类）
  const withQuery = containerProbeCommand({ url: 'https://x.test/a?b=1&c=2' })
  ok('URL 带引号，防止 shell 拆分', String(withQuery[2]).includes('"https://x.test/a?b=1&c=2"'))
}

// ─────────── 6. iptables 规则 ───────────

console.log('\n[6] iptables 重定向规则')
const rules = redirectRules({ slot: slot1, proxy: twenty[0] })
ok('规则生成成功', rules.ok)
eq('链名', rules.chain, 'SKEG01')
eq('监听端口', rules.listenPort, 21000)
eq('DNS 端口', rules.dnsPort, 21001)
has('建链', rules.add, ['-t', 'nat', '-N', 'SKEG01'])
has('PREROUTING 跳转', rules.add, ['-t', 'nat', '-A', 'PREROUTING', '-i', 'skeg01', '-j', 'SKEG01'])
has('槽内同网段 RETURN', rules.add, ['-t', 'nat', '-A', 'SKEG01', '-d', '10.213.1.0/24', '-j', 'RETURN'])
has('tcp/53 重定向', rules.add, ['-t', 'nat', '-A', 'SKEG01', '-p', 'tcp', '--dport', '53', '-j', 'REDIRECT', '--to-ports', '21001'])
has('其余 tcp 全重定向', rules.add, ['-t', 'nat', '-A', 'SKEG01', '-p', 'tcp', '-j', 'REDIRECT', '--to-ports', '21000'])
has('FORWARD 兜底丢弃', rules.add, ['-t', 'filter', '-I', 'FORWARD', '1', '-i', 'skeg01', '!', '-o', 'skeg01', '-j', 'DROP'])
has('回滚删链', rules.del, ['-t', 'nat', '-X', 'SKEG01'])
ok('规则里有 -C 幂等检查', rules.add.some((r) => r.includes('-C')))
ok('回滚规则数量少于正向', rules.del.length < rules.add.length)
ok('缺 subnet 时报错', redirectRules({ slot: { slotId: 'slot-01', chain: 'X', bridge: 'b', ports: { tcp: 1, dns: 2 } } }).ok === false)

const upScript = renderIptablesScript(rules)
ok('上规则脚本带 shebang', upScript.startsWith('#!/bin/sh'))
ok('上规则脚本含幂等判断', upScript.includes('if ! iptables'))
ok('上规则脚本含 REDIRECT', upScript.includes('REDIRECT --to-ports 21000'))
const downScript = renderIptablesRollback(rules)
ok('回滚脚本含 -X', downScript.includes('iptables -t nat -X SKEG01'))

// ─────────── 7. 转发器配置 ───────────

console.log('\n[7] 转发器配置生成')
const rc = redsocksConfig({ slot: slot1, proxy: { id: 'p01', host: '47.88.12.34', port: 1080, username: 'u', password: 'p' } })
ok('redsocks 配置生成成功', rc.ok)
ok('redsocks 监听网关', rc.content.includes('local_ip = 10.213.1.1'))
ok('redsocks 监听转发端口', rc.content.includes('local_port = 21000'))
ok('redsocks 上游 host 正确', rc.content.includes('ip = 47.88.12.34'))
ok('redsocks 类型是 socks5', rc.content.includes('type = socks5'))
ok('redsocks 带凭据', rc.content.includes('login = "u"') && rc.content.includes('password = "p"'))
ok('redsocks 声明 redirector', rc.content.includes('redirector = iptables'))
ok('无代理时 redsocks 报错', redsocksConfig({ slot: slot1, proxy: {} }).ok === false)
ok('引号凭据被标记不安全', redsocksConfig({ slot: slot1, proxy: { host: 'h', port: 1, username: 'a"b' } }).unsafeCred === true)

const sb = singboxConfig({ slot: slot1, proxy: { host: '47.88.12.34', port: 1080 } })
ok('sing-box 配置可解析', sb.ok && JSON.parse(sb.content).outbounds[0].type === 'socks')
eq('sing-box 默认出站指向代理', JSON.parse(sb.content).route.final, 'proxy')

const tun = tun2socksSpec({ slot: slot1, proxy: { host: '47.88.12.34', port: 1080 } })
ok('tun2socks 需要 NET_ADMIN', tun.requires.includes('NET_ADMIN'))
assertOk: {
  ok('tun2socks 需要 TUN 设备', tun.requires.includes('/dev/net/tun'))
  ok('tun2socks 需要额外 capability', tun.containerArgs.includes('--cap-add'))
  ok('tun2socks 给出 caveat', typeof tun.caveat === 'string' && tun.caveat.length > 0)
}

// ─────────── 8. SOCKS5 编码与协商 ───────────

console.log('\n[8] SOCKS5 字节协议')
const dom = encodeTarget('api.anthropic.com', 443)
eq('域名走 ATYP=0x03', dom.atyp, ATYP_DOMAIN)
eq('域名长度前缀', dom.body[0], 'api.anthropic.com'.length)
eq('端口大端', dom.body.readUInt16BE(dom.body.length - 2), 443)
const v4 = encodeTarget('1.2.3.4', 80)
eq('IPv4 走 ATYP=0x01', v4.atyp, ATYP_IPV4)
eq('IPv4 编码 4 字节', v4.body.length, 6)
const v6 = encodeTarget('2001:db8::1', 53)
eq('IPv6 走 ATYP=0x04', v6.atyp, ATYP_IPV6)
eq('IPv6 编码 16+2 字节', v6.body.length, 18)
eq('IPv6 展开首组', ipv6ToBuffer('2001:db8::1').readUInt16BE(0), 0x2001)
eq('IPv6 展开末组', ipv6ToBuffer('2001:db8::1').readUInt16BE(14), 1)
let threw = false
try {
  encodeTarget('', 80)
} catch {
  threw = true
}
ok('空目标主机抛错', threw)

/** 假 SOCKS5 服务端：按脚本回包，用于验证协商分支。 */
function fakeSocksServer({ method = 0x00, authStatus = 0x00, reply = 0x00, echo = null } = {}) {
  const socket = new EventEmitter()
  const written = []
  socket.writable = true
  socket.write = (buf) => {
    const b = Buffer.from(buf)
    written.push(b)
    // 分阶段回包
    if (b[0] === 0x05 && b.length >= 3 && b[1] <= 2 && b[2] === undefined) {
      // 不会走到这里（greeting 是 3 字节：VER NMETHODS METHOD...）
    }
    if (b.length >= 2 && b[0] === 0x05 && b[1] <= 0x02 && written.length === 1) {
      socket.emit('readable')
      setImmediate(() => socket.push ? socket.push(Buffer.from([0x05, method])) : null)
      pushRead(Buffer.from([0x05, method]))
      return true
    }
    if (b[0] === 0x01 && written.length === 2) {
      pushRead(Buffer.from([0x01, authStatus]))
      return true
    }
    if (b[0] === 0x05 && b[1] === 0x01) {
      pushRead(Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      if (echo) pushRead(echo)
      return true
    }
    return true
  }
  const reads = []
  let waiter = null
  const pushRead = (buf) => {
    reads.push(buf)
    if (waiter) {
      const w = waiter
      waiter = null
      w()
    }
  }
  socket.read = () => (reads.length ? reads.shift() : null)
  const origOnce = socket.once.bind(socket)
  socket.once = (ev, fn) => {
    if (ev === 'readable') {
      if (reads.length) {
        setImmediate(fn)
        return socket
      }
      waiter = fn
      return socket
    }
    return origOnce(ev, fn)
  }
  socket.unshift = (buf) => pushRead(Buffer.from(buf))
  socket.destroy = () => {}
  return { socket, written }
}

const okServer = fakeSocksServer()
const negotiated = await negotiate(okServer.socket, { host: 'h', port: 1080 }, { host: 'example.org', port: 443 })
ok('免认证协商成功返回 socket', negotiated === okServer.socket)
eq('greeting 声称 1 种方法', okServer.written[0].toString('hex'), '050100')
eq('CONNECT 请求用域名模式', okServer.written[1][3], ATYP_DOMAIN)
eq('CONNECT 目标域名写入', okServer.written[1].subarray(5, 5 + 11).toString(), 'example.org')

const authServer = fakeSocksServer({ method: 0x02 })
const authOk = await negotiate(
  authServer.socket,
  { host: 'h', port: 1080, username: 'user', password: 'pass' },
  { host: '1.2.3.4', port: 80 },
)
ok('用户名密码认证成功', authOk === authServer.socket)
eq('认证报文首字节是 0x01', authServer.written[1][0], 0x01)
eq('认证报文带用户名长度', authServer.written[1][1], 4)

let authFail = null
try {
  await negotiate(
    fakeSocksServer({ method: 0x02 }).socket,
    { host: 'h', port: 1080 },
    { host: '1.2.3.4', port: 80 },
  )
} catch (error) {
  authFail = error
}
ok('无凭据但服务端要认证 → 抛 socks5_auth_required', authFail && authFail.code === 'socks5_auth_required')

let refused = null
try {
  await negotiate(
    fakeSocksServer({ reply: 0x05 }).socket,
    { host: 'h', port: 1080 },
    { host: '1.2.3.4', port: 80 },
  )
} catch (error) {
  refused = error
}
ok('CONNECT 被拒 → 抛 connection_refused', refused && refused.code === 'socks5_connection_refused')
eq('拒绝码被带出', refused?.reply, 0x05)

let noAccept = null
try {
  await negotiate(fakeSocksServer({ method: 0xff }).socket, { host: 'h', port: 1080 }, { host: '1.2.3.4', port: 80 })
} catch (error) {
  noAccept = error
}
ok('无可用认证方法 → 抛 socks5_no_acceptable_auth', noAccept && noAccept.code === 'socks5_no_acceptable_auth')

let badProxy = null
try {
  await openTunnel({ host: '', port: 0 }, { host: 'a', port: 1 })
} catch (error) {
  badProxy = error
}
ok('非法代理直接抛 socks5_bad_proxy', badProxy && badProxy.code === 'socks5_bad_proxy')

let connectFail = null
try {
  await openTunnel(
    { host: '47.88.12.34', port: 1080 },
    { host: 'a', port: 1 },
    {
      connect: () => Promise.reject(Object.assign(new Error('x'), { code: 'socks5_connect_failed' })),
    },
  )
} catch (error) {
  connectFail = error
}
ok('注入的连接失败被透出', connectFail && connectFail.code === 'socks5_connect_failed')

// ─────────── 9. DNS 转发 ───────────

console.log('\n[9] DNS 转发')
const q = buildQuery('www.anthropic.com', 0x4242)
eq('查询报文 ID', q.readUInt16BE(0), 0x4242)
eq('RD 位置位', (q[2] & 0x01), 0x01)
eq('QDCOUNT = 1', q.readUInt16BE(4), 1)
ok('查询报文以 0 结尾的 QNAME', q.includes(0x00))

const framed = frameTcp(q)
eq('TCP 帧长度前缀', framed.readUInt16BE(0), q.length)
const framer = createTcpFramer()
eq('分片重组：第一片不足', framer.push(framed.subarray(0, 5)).length, 0)
eq('分片重组：第二片完成', framer.push(framed.subarray(5)).length, 1)
eq('重组后长度正确', framer.push(Buffer.alloc(0)).length, 0)

const resp = errorResponse(q, 2)
eq('错误响应 QR=1', (resp[2] & 0x80) !== 0, true)
eq('错误响应 rcode=2', resp[3] & 0x0f, 2)
eq('错误响应 ANCOUNT=0', resp.readUInt16BE(6), 0)

// 用真实响应字节验证解析（手工构造一条 A 记录应答）
const answer = Buffer.from(
  '1234818000010001000000000377777709616e7468726f70696303636f6d0000010001c00c000100010000003c0004aabbccdd',
  'hex',
)
const parsed = parseAnswerIps(answer)
eq('解析出 1 条 A 记录', parsed.ips.length, 1)
eq('A 记录地址正确', parsed.ips[0], '170.187.204.221')
eq('rcode 为 0', parsed.rcode, 0)

const handlerSocket = new EventEmitter()
handlerSocket.writable = true
const handlerOut = []
handlerSocket.write = (buf) => handlerOut.push(Buffer.from(buf))
handlerSocket.destroy = () => {}
const handler = createTcpHandler({
  proxy: { id: 'p01', host: '47.88.12.34', port: 1080 },
  relay: async ({ query }) => errorResponse(query, 3),
})
handler(handlerSocket)
handlerSocket.emit('data', frameTcp(q))
await new Promise((r) => setTimeout(r, 20))
eq('TCP handler 回写一帧', handlerOut.length, 1)
eq('handler 回写帧带长度前缀', handlerOut[0].readUInt16BE(0), handlerOut[0].length - 2)
eq('handler 回写 rcode=3', handlerOut[0][2 + 3] & 0x0f, 3)

const handlerErr = new EventEmitter()
handlerErr.writable = true
const errOut = []
handlerErr.write = (buf) => errOut.push(Buffer.from(buf))
handlerErr.destroy = () => {}
createTcpHandler({ proxy: {}, relay: async () => Promise.reject(new Error('boom')) })(handlerErr)
handlerErr.emit('data', frameTcp(q))
await new Promise((r) => setTimeout(r, 20))
eq('relay 抛错时回 SERVFAIL', errOut.length === 1 && errOut[0][2 + 3] & 0x0f, 2)

let relayErr = null
try {
  await relayOverProxy({ query: q, proxy: {}, upstreams: ['not-an-ip'], timeoutMs: 50 })
} catch (error) {
  relayErr = error
}
ok('非 IP 上游被拒', relayErr && /IP 字面量/.test(relayErr.message))

// 真实 loopback 转发器：只在本机回环，不产生外部连接
const loopbackPort = 15300 + (process.pid % 200)
const listener = await startDnsForwarder({
  proxy: { id: 'p01', host: '47.88.12.34', port: 1080 },
  listenHost: '127.0.0.1',
  port: loopbackPort,
  relay: async ({ query }) => errorResponse(query, 5),
})
ok('DNS 转发器可在回环端口启动', listener.ok)
const reply = await new Promise((resolve, reject) => {
  const c = net.connect({ host: '127.0.0.1', port: loopbackPort })
  const f = createTcpFramer()
  const timer = setTimeout(() => {
    c.destroy()
    reject(new Error('timeout'))
  }, 3000)
  c.on('connect', () => c.write(frameTcp(q)))
  c.on('data', (chunk) => {
    const frames = f.push(chunk)
    if (frames.length) {
      clearTimeout(timer)
      c.destroy()
      resolve(frames[0])
    }
  })
  c.on('error', (e) => {
    clearTimeout(timer)
    reject(e)
  })
})
eq('转发器回包 rcode 透传', reply[3] & 0x0f, 5)
listener.stop()
ok('转发器 stop 不抛', true)
ok('非法 listenHost 被拒', (await startDnsForwarder({ proxy: {}, listenHost: 'nope', port: 53 })).ok === false)

// ─────────── 10. 出口验证 ───────────

console.log('\n[10] 出口验证判定')
eq('extractIp 解析 JSON', extractIp('{"ip":"47.88.12.34"}'), '47.88.12.34')
eq('extractIp 解析纯文本', extractIp('47.88.12.34\n'), '47.88.12.34')
eq('extractIp 空输入', extractIp(''), '')
eq('parseNameservers 提取多条', parseNameservers('nameserver 8.8.8.8\nnameserver 1.1.1.1\n'), ['8.8.8.8', '1.1.1.1'])
eq('classifyNameserver 识别 docker 内嵌', classifyNameserver('127.0.0.11'), 'docker_embedded')
eq('classifyNameserver 识别内网', classifyNameserver('192.168.1.1'), 'private')
eq('classifyNameserver 识别 172.17', classifyNameserver('172.17.0.1'), 'private')
eq('classifyNameserver 识别公网', classifyNameserver('8.8.8.8'), 'public')
eq('extractResolution 保留 IPv4 与 IPv6', extractResolution('1.2.3.4\nnot-ip\n2001:db8::1'), ['1.2.3.4', '2001:db8::1'])
eq('extractResolution 只留地址', extractResolution('Resolver: 8.8.8.8 timeout'), ['8.8.8.8'])

const verifySlot = { slotId: 'slot-01', container: 'claude-slot-01' }
const proxyWithExit = { id: 'p01', host: '47.88.12.34', port: 1080, expectedExitIp: '47.88.12.34' }

const happy = evaluateEgress({
  proxy: proxyWithExit,
  slot: verifySlot,
  observed: {
    containerExitIp: '47.88.12.34',
    hostExitIp: '203.0.113.9',
    resolvConf: 'nameserver 8.8.8.8\n',
    dnsAnswerIps: ['160.79.104.10'],
    udpDnsReachable: false,
    directTcpOk: false,
  },
})
ok('理想观测全部通过', happy.ok)
eq('六项检查全出现', happy.checks.length, 6)
ok('没有失败项', happy.failed.length === 0)

const mismatch = evaluateEgress({
  proxy: proxyWithExit,
  slot: verifySlot,
  observed: {
    containerExitIp: '5.6.7.8',
    hostExitIp: '203.0.113.9',
    resolvConf: 'nameserver 8.8.8.8\n',
    dnsAnswerIps: ['160.79.104.10'],
    udpDnsReachable: false,
    directTcpOk: false,
  },
})
ok('出口 IP 不符 → 整体失败', mismatch.ok === false)
ok('出口 IP 不符被点名', mismatch.failed.some((f) => f.includes('出口 IP 比对') && f.includes('5.6.7.8')))
ok('不符时错误里同时给出预期值', mismatch.failed.some((f) => f.includes('47.88.12.34')))

const sameAsHost = evaluateEgress({
  proxy: proxyWithExit,
  slot: verifySlot,
  observed: {
    containerExitIp: '47.88.12.34',
    hostExitIp: '47.88.12.34',
    resolvConf: 'nameserver 8.8.8.8\n',
    dnsAnswerIps: ['160.79.104.10'],
    udpDnsReachable: false,
    directTcpOk: false,
  },
})
ok('容器出口与宿主机相同 → 判未走代理', sameAsHost.ok === false)
ok('控制组检查点名', sameAsHost.failed.some((f) => f.includes('宿主机控制组')))

const dnsLeak = evaluateEgress({
  proxy: proxyWithExit,
  slot: verifySlot,
  observed: {
    containerExitIp: '47.88.12.34',
    hostExitIp: '203.0.113.9',
    resolvConf: 'nameserver 127.0.0.11\n',
    dnsAnswerIps: [],
    udpDnsReachable: true,
    directTcpOk: true,
  },
})
ok('DNS 指向 docker 内嵌 + UDP 可达 + 裸连可达 → 失败', dnsLeak.ok === false)
ok('检出 docker 内嵌解析器', dnsLeak.failed.some((f) => f.includes('127.0.0.11')))
ok('检出 UDP/53 泄漏', dnsLeak.failed.some((f) => f.includes('UDP/53')))
ok('检出裸 TCP 未被阻断', dnsLeak.failed.some((f) => f.includes('直连隔离')))
ok('DNS 无结果被检出', dnsLeak.failed.some((f) => f.includes('DNS 经代理解析')))

const noExpected = evaluateEgress({
  proxy: { id: 'p02', host: '47.88.12.34', port: 1080 },
  slot: verifySlot,
  observed: { containerExitIp: '47.88.12.34', hostExitIp: '203.0.113.9', resolvConf: 'nameserver 8.8.8.8\n' },
})
ok('未配 expected_exit_ip 时该项跳过而非失败', noExpected.ok === true)
ok('跳过项标记为 skip', noExpected.checks.some((c) => c.kind === CHECK_KINDS.exitIp && c.status === 'skip'))

const noProbe = evaluateEgress({ proxy: proxyWithExit, slot: verifySlot, observed: {} })
ok('完全无观测数据时失败（而非默认通过）', noProbe.ok === false)
ok('缺 resolv.conf 归为跳过', noProbe.checks.some((c) => c.kind === CHECK_KINDS.dnsResolver && c.status === 'skip'))

const preSkip = preflightEgress({ proxy: { id: 'p01', host: 'example.com', port: 1080, placeholder: true }, slot: verifySlot })
ok('占位符预检直接跳过', preSkip.skipped === true)
ok('占位符预检说明原因', /占位符/.test(preSkip.summary))
const preReady = preflightEgress({ proxy: proxyWithExit, slot: verifySlot })
ok('真实代理预检 ready', preReady.ok === true && preReady.skipped === false)

const execCalls = []
const exec = async ({ container, argv }) => {
  execCalls.push({ container, argv })
  const joined = argv.join(' ')
  if (joined.includes('http')) return { ok: true, stdout: '{"ip":"9.9.9.9"}' }
  if (joined.includes('/etc/resolv.conf')) return { ok: true, stdout: 'nameserver 1.1.1.1\n' }
  if (joined.includes('node:net')) return { ok: true, stdout: 'BLOCKED' }
  if (joined.includes('dgram')) return { ok: true, stdout: 'BLOCKED' }
  return { ok: true, stdout: '160.79.104.10' }
}
const execResult = await verifyEgress({ slotId: 'slot-01', proxy: proxyWithExit, slot: verifySlot, exec })
eq('verify 走了 5 条容器内命令', execCalls.length, 5)
ok('verify 在容器内执行', execCalls.every((c) => c.container === 'claude-slot-01'))
ok('verify 检出出口 IP 不符（9.9.9.9 ≠ 47.88.12.34）', execResult.ok === false)
ok('verify 结果含检查明细', execResult.checks.length === 6)
ok('verify 无 exec 注入时报错', (await verifyEgress({ slotId: 'slot-01', proxy: proxyWithExit })).ok === false)
ok('tcpProbeScript 可执行', tcpProbeScript().includes('net.connect'))

// 宿主机控制组：注入了 hostProbe 才做对照
const controlSlots = []
const execAll = async ({ argv }) => {
  const joined = argv.join(' ')
  controlSlots.push(joined)
  if (joined.includes('http')) return { ok: true, stdout: '{"ip":"47.88.12.34"}' }
  if (joined.includes('/etc/resolv.conf')) return { ok: true, stdout: 'nameserver 8.8.8.8\n' }
  if (joined.includes('CONNECTED')) return { ok: true, stdout: 'BLOCKED' }
  if (joined.includes('REACHABLE')) return { ok: true, stdout: 'BLOCKED' }
  return { ok: true, stdout: '160.79.104.10' }
}
const withHost = await verifyEgress({
  slotId: 'slot-01',
  proxy: proxyWithExit,
  slot: verifySlot,
  exec: execAll,
  hostProbe: async () => '203.0.113.9',
})
ok('注入 hostProbe 后全项通过', withHost.ok === true)
ok('宿主机控制组参与判定', withHost.checks.some((c) => c.kind === CHECK_KINDS.hostControl && c.status === 'pass'))

const hostSame = await verifyEgress({
  slotId: 'slot-01',
  proxy: proxyWithExit,
  slot: verifySlot,
  exec: async (a) => execAll(a),
  hostProbe: async () => '47.88.12.34',
})
ok('宿主机与容器出口相同 → verify 判失败', hostSame.ok === false)
ok('失败项点名控制组', hostSame.failed.some((f) => f.includes('宿主机控制组')))

const noHost = await verifyEgress({ slotId: 'slot-01', proxy: proxyWithExit, slot: verifySlot, exec: execAll })
ok('不注入 hostProbe 时控制组跳过而非失败', noHost.ok === true)
ok('未注入时控制组标 skip', noHost.checks.some((c) => c.kind === CHECK_KINDS.hostControl && c.status === 'skip'))

// exec 整体失败（容器不存在）：不能把「没探测到」当成「隔离生效」
const execDead = await verifyEgress({
  slotId: 'slot-01',
  proxy: proxyWithExit,
  slot: verifySlot,
  exec: async () => ({ ok: false, stdout: '', stderr: 'No such container' }),
})
ok('exec 全失败时不判通过', execDead.ok === false)
ok('exec 全失败时裸连项标 skip 而非 pass', execDead.checks.some((c) => c.kind === CHECK_KINDS.directBlocked && c.status === 'skip'))
ok('exec 全失败时 UDP 项标 skip 而非 pass', execDead.checks.some((c) => c.kind === CHECK_KINDS.dnsUdpLeak && c.status === 'skip'))
ok('exec 全失败时出口 IP 项判失败', execDead.failed.some((f) => f.includes('出口 IP 探测')))

// ─────────── 11. 健康检查（全部注入，不联网） ───────────

console.log('\n[11] 健康检查（注入，不联网）')
const skippedHealth = await checkProxyHealth({ id: 'p01', host: 'example.com', port: 1080, placeholder: true })
ok('占位符健康检查跳过', skippedHealth.skipped === true && skippedHealth.ok === false)
eq('跳过原因码', skippedHealth.code, 'placeholder_proxy')
ok('占位符不发起任何连接', skippedHealth.exitIp === undefined)

const disabledHealth = await checkProxyHealth({ id: 'p02', host: '47.88.12.34', port: 1080, enabled: false })
eq('禁用代理跳过原因码', disabledHealth.code, 'proxy_unusable')

let dialCount = 0
const healthOk = await checkProxyHealth(
  { id: 'p03', host: '47.88.12.34', port: 1080, expectedExitIp: '47.88.12.34' },
  {
    fetchBody: async () => {
      dialCount += 1
      return '{"ip":"47.88.12.34"}'
    },
  },
)
eq('注入拨号被调用一次', dialCount, 1)
ok('健康检查通过', healthOk.ok === true)
eq('拿到出口 IP', healthOk.exitIp, '47.88.12.34')
eq('与预期一致时 match=true', healthOk.match, true)

const healthMismatch = await checkProxyHealth(
  { id: 'p04', host: '47.88.12.34', port: 1080, expectedExitIp: '1.1.1.1' },
  { fetchBody: async () => '{"ip":"47.88.12.34"}' },
)
ok('出口与预期不符时 ok=false', healthMismatch.ok === false)
eq('不符时 match=false', healthMismatch.match, false)

const healthDead = await checkProxyHealth(
  { id: 'p05', host: '47.88.12.34', port: 1080 },
  { fetchBody: async () => Promise.reject(new Error('refused')), probeUrls: ['https://x.example/'] },
)
eq('全部端点失败返回 probe_failed', healthDead.code, 'probe_failed')
ok('失败时带错误信息', /refused/.test(healthDead.error))

const batch = await checkPoolHealth(
  [
    { id: 'a', host: 'example.com', port: 1080, placeholder: true },
    { id: 'b', host: 'example.com', port: 1080, placeholder: true },
  ],
  { concurrency: 2 },
)
eq('批量探测返回同长度结果', batch.length, 2)
ok('批量探测全部跳过', batch.every((r) => r.skipped))
eq('extractIpFromBody 复用同一规则', extractIpFromBody('{"ip":"8.8.4.4"}'), '8.8.4.4')

// ─────────── 12. 蓝图与 demo ───────────

console.log('\n[12] 蓝图与落盘产物')
const bp = buildSlotBlueprint({ slot: slot1, proxy: twenty[0] })
ok('单槽位蓝图生成成功', bp.ok)
eq('蓝图槽位号', bp.slot.slotId, 'slot-01')
eq('蓝图转发器是 redsocks', bp.forwarder.kind, 'redsocks')
eq('蓝图监听地址', bp.forwarder.listen, '10.213.1.1:21000')
ok('蓝图代理视图不含密码字段', !JSON.stringify(bp.proxy).toLowerCase().includes('password'))
ok('蓝图带 has_auth 布尔位', typeof bp.proxy.has_auth === 'boolean')
ok('无凭据代理不标记 containsSecrets', bp.containsSecrets === false)

// 带凭据的代理：密码只出现在 forwarder 配置文件，代理视图里没有
const bpAuth = buildSlotBlueprint({
  slot: slot1,
  proxy: { id: 'p01', host: '47.88.12.34', port: 1080, username: 'user', password: 'x' },
})
ok('含凭据的蓝图被标记 containsSecrets', bpAuth.containsSecrets === true)
ok('凭据落在 redsocks 配置文件里', bpAuth.files['redsocks/skylink-eg-01.conf'].includes('password = "x"'))
ok('凭据不进代理视图', !JSON.stringify(bpAuth.proxy).toLowerCase().includes('password'))
ok('蓝图含网络创建参数', Array.isArray(bp.docker.networkCreate) && bp.docker.networkCreate.length > 5)
ok('蓝图含容器启动参数', bp.docker.containerArgs[0] === 'docker' && bp.docker.containerArgs[1] === 'run')
ok('蓝图含 iptables 正反规则', bp.iptables.add.length > 0 && bp.iptables.del.length > 0)
ok('蓝图含 redsocks 文件', typeof bp.files['redsocks/skylink-eg-01.conf'] === 'string')
ok('蓝图含 singbox 备选', typeof bp.files['singbox/skylink-eg-01.json'] === 'string')
ok('蓝图含上下规则脚本', bp.files['iptables/skylink-eg-01.up.sh'].includes('REDIRECT'))

const bpNoProxy = buildSlotBlueprint({ slot: slot1, proxy: null })
ok('无代理也能生成蓝图', bpNoProxy.ok)
ok('无代理时 redsocks 文件为空', bpNoProxy.files['redsocks/skylink-eg-01.conf'] === null)
ok('无代理时给出告警', bpNoProxy.warnings.some((w) => w.includes('尚未绑定')))

const bpPlaceholder = buildSlotBlueprint({ slot: slot1, proxy: { id: 'p09', host: '1.2.3.4', port: 1080, placeholder: true } })
ok('占位符代理也能生成蓝图', bpPlaceholder.ok)
ok('占位符告警被写出', bpPlaceholder.warnings.some((w) => w.includes('占位符')))

ok('未知转发模式被拒', buildSlotBlueprint({ slot: slot1, mode: 'magic' }).ok === false)
const envBp = buildSlotBlueprint({ slot: slot1, proxy: twenty[0], mode: 'env-proxy' })
ok('env-proxy 模式下不做 redsocks', envBp.forwarder.kind === 'none')

const fleet = buildFleetBlueprint({ proxies: twenty, strict: false })
ok('20 槽位舰队蓝图成功', fleet.ok)
eq('舰队 20 条', fleet.slots.length, 20)
eq('舰队表 20 行', fleet.table.length, 20)
eq('无未绑定槽位', fleet.unbound.length, 0)
ok('每条蓝图都带代理', fleet.slots.every((s) => s.proxy && s.proxy.id))
eq('第 20 行 subnet', fleet.table[19].subnet, '10.213.20.0/24')
ok('20 个 subnet 在表里唯一', new Set(fleet.table.map((r) => r.subnet)).size === 20)

const fleetEmpty = buildFleetBlueprint({ proxies: [], strict: true })
ok('零代理 + 严格模式判失败', fleetEmpty.ok === false)
eq('零代理仍产出 20 条蓝图', fleetEmpty.slots.length, 20)
eq('20 个槽位全未绑定', fleetEmpty.unbound.length, 20)
ok('未绑定槽位仍有 iptables 规则', fleetEmpty.slots.every((s) => s.iptables.add.length > 0))

const fleetShort = buildFleetBlueprint({ proxies: twenty.slice(0, 5), strict: true })
ok('代理不足时严格模式失败', fleetShort.ok === false)
eq('未绑定 15 个', fleetShort.unbound.length, 15)

const files = renderFleetFiles(fleet)
ok('渲染出 fleet.json', typeof files['fleet.json'] === 'string')
ok('fleet.json 可解析', (() => { try { JSON.parse(files['fleet.json']); return true } catch { return false } })())
ok('渲染出 SUBNETS.md', files['SUBNETS.md'].includes('| slot-01 |'))
eq('渲染产物含 20 份蓝图 + 摘要', Object.keys(files).filter((k) => k.endsWith('/blueprint.json')).length, 20)
ok('fleet.json 不含明文密码', !files['fleet.json'].includes('password'))
eq('无凭据时 slots_with_secrets 为空', JSON.parse(files['fleet.json']).slots_with_secrets, [])

// 落盘到临时目录，验证真实可写
const demoDir = path.join(TMP, 'demo')
fs.mkdirSync(demoDir, { recursive: true })
for (const [rel, content] of Object.entries(files)) {
  const full = path.join(demoDir, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}
ok('demo 目录落盘成功', fs.existsSync(path.join(demoDir, 'fleet.json')))
ok('单槽位目录落盘', fs.existsSync(path.join(demoDir, 'slots', 'slot-20', 'blueprint.json')))
const reRead = JSON.parse(fs.readFileSync(path.join(demoDir, 'slots', 'slot-20', 'blueprint.json'), 'utf8'))
eq('落盘蓝图可回读', reRead.slot.subnet, '10.213.20.0/24')

eq('slotFor 接受纯数字', slotFor('7')?.slotId, 'slot-07')
eq('slotFor 接受完整 id', slotFor('slot-13')?.slotId, 'slot-13')
eq('slotFor 接受单位数补零', slotFor('slot-7')?.slotId, 'slot-07')
eq('slotFor 越界返回 null', slotFor('99'), null)

// ─────────── 汇总 ───────────

try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
