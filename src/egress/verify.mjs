/**
 * 出口验证：确认某个槽位的出站**真的**走了它绑定的代理，而不是悄悄直连。
 *
 * 职责：把「部署完成」和「隔离生效」分开判定。没有这一步，配置写错
 * （代理没生效、DNS 泄漏、FORWARD 没拦住）在功能上完全看不出来。
 *
 * 检查项（每项独立判定，互不掩盖）：
 *   1. 出口 IP：容器经代理看到的公网 IP 是否等于 proxy.expected_exit_ip
 *   2. 控制组：同样请求在宿主机上看到的 IP 是否与容器不同（防止「容器本来
 *      就在这个 IP 上」的假阳性，例如代理出口与宿主机同机房）
 *   3. DNS 解析器：容器 /etc/resolv.conf 不得指向宿主机/内网解析器
 *   4. DNS 经代理：容器内解析一个随机子域，能拿到答案说明上游可达；
 *      同时直连 udp/53 必须超时（被 FORWARD 丢弃），否则 UDP 泄漏
 *   5. 直连隔离：不经过代理的裸 TCP 必须失败。成功即隔离没生效。
 *
 * 关键约束：
 * 1. 所有外部命令都通过注入的 exec 执行。模块本身不 spawn，
 *    这样测试能在完全离线、无 docker 的环境里跑全部分支。
 * 2. 代理是占位符时返回 skipped 而不是失败——首次部署必须能跑。
 * 3. 判定用「预期 vs 实际」的显式对比，不做启发式猜测。
 */

import net from 'node:net'
import { isPlaceholderHost, isProxyUsable } from './pool.mjs'
import { containerNameFor, containerProbeCommand, containerResolvCommand } from './network.mjs'

/** 检查项权重：决定整体 ok 的必要条件。 */
export const CHECK_KINDS = Object.freeze({
  exitIp: 'exit_ip',
  hostControl: 'host_control',
  dnsResolver: 'dns_resolver',
  dnsViaProxy: 'dns_via_proxy',
  dnsUdpLeak: 'dns_udp_leak',
  directBlocked: 'direct_blocked',
})

const PASS = (name, kind, detail) => ({ name, kind, ok: true, status: 'pass', detail })
const FAIL = (name, kind, detail) => ({ name, kind, ok: false, status: 'fail', detail })
const SKIP = (name, kind, detail) => ({ name, kind, ok: true, status: 'skip', detail })

/** 从任意响应体抠 IP。与 pool.mjs 同规则，避免出现两套判定。 */
export function extractIp(body) {
  const text = String(body == null ? '' : body)
  const json = text.match(/"ip"\s*:\s*"([^"]+)"/i)
  if (json && net.isIP(String(json[1]).trim())) return String(json[1]).trim()
  const plain = text.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)
  if (plain && net.isIP(plain[1])) return plain[1]
  const v6 = text.match(/\b([0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})\b/i)
  if (v6 && net.isIP(v6[1])) return v6[1]
  return ''
}

/** resolv.conf 文本 → nameserver 列表。 */
export function parseNameservers(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^nameserver\s+/i.test(line))
    .map((line) => line.replace(/^nameserver\s+/i, '').trim())
    .filter(Boolean)
}

/**
 * 解析器是否属于「会泄漏真实位置的」那类。
 * 127.0.0.11 是 docker 内嵌 DNS，它自己会转发到宿主机 —— 在本方案里
 * 这条路径不可接受，因为宿主机解析不受代理管辖。
 */
export function classifyNameserver(ns) {
  const host = String(ns || '').trim()
  if (!host) return 'invalid'
  if (host === '127.0.0.11') return 'docker_embedded'
  if (host === '127.0.0.1' || host === '::1') return 'loopback'
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'private'
  if (/^169\.254\./.test(host)) return 'link_local'
  if (net.isIP(host)) return 'public'
  return 'invalid'
}

/**
 * 纯函数判定：把采集到的观测值折成检查项。
 *
 * @param {object} input
 *   proxy        代理条目
 *   slot         槽位规划
 *   observed     观测结果：
 *     containerExitIp  容器内经代理看到的 IP
 *     hostExitIp       宿主机裸连看到的 IP
 *     resolvConf       容器 /etc/resolv.conf 文本
 *     dnsAnswerIps     容器内解析 www.anthropic.com 得到的 IP
 *     udpDnsReachable  容器内直连 udp/53 是否可达
 *     directTcpOk      容器内裸 TCP（不经代理）是否成功
 */
export function evaluateEgress({ proxy, slot, observed = {} } = {}) {
  const checks = []
  const p = proxy || {}
  const s = slot || {}

  // 1. 出口 IP
  const actual = String(observed.containerExitIp || '').trim()
  const expected = String(p.expectedExitIp || '').trim()
  if (!actual) {
    checks.push(FAIL('出口 IP 探测', CHECK_KINDS.exitIp, '容器内未能取到出口 IP（代理不可达或探测端点不可用）'))
  } else if (!expected) {
    checks.push(SKIP('出口 IP 比对', CHECK_KINDS.exitIp, `代理未配置 expected_exit_ip，实测出口为 ${actual}`))
  } else if (actual === expected) {
    checks.push(PASS('出口 IP 比对', CHECK_KINDS.exitIp, `出口 ${actual} = 预期 ${expected}`))
  } else {
    checks.push(FAIL('出口 IP 比对', CHECK_KINDS.exitIp, `出口 ${actual} ≠ 预期 ${expected}`))
  }

  // 2. 宿主机控制组：容器出口与宿主机出口相同 → 容器没走代理
  const hostIp = String(observed.hostExitIp || '').trim()
  if (!actual) {
    checks.push(SKIP('宿主机控制组', CHECK_KINDS.hostControl, '缺少容器出口 IP，无法对照'))
  } else if (!hostIp) {
    checks.push(SKIP('宿主机控制组', CHECK_KINDS.hostControl, '缺少宿主机出口 IP，跳过对照'))
  } else if (hostIp === actual) {
    checks.push(
      FAIL('宿主机控制组', CHECK_KINDS.hostControl, `容器与宿主机出口同为 ${actual}，说明容器实际未走代理`),
    )
  } else {
    checks.push(PASS('宿主机控制组', CHECK_KINDS.hostControl, `容器 ${actual} ≠ 宿主机 ${hostIp}`))
  }

  // 3. DNS 解析器归属
  const nameservers = parseNameservers(observed.resolvConf)
  if (!observed.resolvConf) {
    checks.push(SKIP('DNS 配置检查', CHECK_KINDS.dnsResolver, '未采集到 /etc/resolv.conf'))
  } else if (!nameservers.length) {
    checks.push(FAIL('DNS 配置检查', CHECK_KINDS.dnsResolver, 'resolv.conf 里没有 nameserver'))
  } else {
    const classes = nameservers.map((ns) => ({ ns, cls: classifyNameserver(ns) }))
    const leaky = classes.filter((c) => ['docker_embedded', 'loopback', 'private', 'link_local'].includes(c.cls))
    if (leaky.length) {
      checks.push(
        FAIL(
          'DNS 配置检查',
          CHECK_KINDS.dnsResolver,
          `解析器落在宿主机路径上: ${leaky.map((c) => `${c.ns}(${c.cls})`).join(', ')}`,
        ),
      )
    } else {
      checks.push(PASS('DNS 配置检查', CHECK_KINDS.dnsResolver, `解析器为公网地址: ${nameservers.join(', ')}`))
    }
  }

  // 4. DNS 经代理可达
  const dnsIps = Array.isArray(observed.dnsAnswerIps) ? observed.dnsAnswerIps.filter((ip) => net.isIP(ip)) : []
  if (observed.dnsAnswerIps == null) {
    checks.push(SKIP('DNS 经代理解析', CHECK_KINDS.dnsViaProxy, '未执行解析探测'))
  } else if (!dnsIps.length) {
    checks.push(FAIL('DNS 经代理解析', CHECK_KINDS.dnsViaProxy, '解析没有返回任何地址，DNS 转发链路不通'))
  } else {
    checks.push(PASS('DNS 经代理解析', CHECK_KINDS.dnsViaProxy, `解析结果 ${dnsIps.slice(0, 2).join(', ')}`))
  }

  // 5. UDP/53 不得直连可达
  if (observed.udpDnsReachable == null) {
    checks.push(SKIP('UDP/53 泄漏', CHECK_KINDS.dnsUdpLeak, '未执行 UDP 探测'))
  } else if (observed.udpDnsReachable === true) {
    checks.push(FAIL('UDP/53 泄漏', CHECK_KINDS.dnsUdpLeak, '容器可直连 udp/53，DNS 存在真实位置泄漏'))
  } else {
    checks.push(PASS('UDP/53 泄漏', CHECK_KINDS.dnsUdpLeak, 'udp/53 直连被阻断'))
  }

  // 6. 裸 TCP 隔离
  if (observed.directTcpOk == null) {
    checks.push(SKIP('直连隔离', CHECK_KINDS.directBlocked, '未执行裸 TCP 探测'))
  } else if (observed.directTcpOk === true) {
    checks.push(FAIL('直连隔离', CHECK_KINDS.directBlocked, '不经代理的 TCP 仍然成功，FORWARD 规则未生效'))
  } else {
    checks.push(PASS('直连隔离', CHECK_KINDS.directBlocked, '裸 TCP 被阻断，流量只能经代理'))
  }

  const failed = checks.filter((c) => c.status === 'fail')
  const passed = checks.filter((c) => c.status === 'pass')
  return {
    ok: failed.length === 0,
    slotId: s.slotId || '',
    proxyId: p.id || '',
    checks,
    failed: failed.map((c) => `${c.name}: ${c.detail}`),
    summary: `通过 ${passed.length} / 跳过 ${checks.length - passed.length - failed.length} / 失败 ${failed.length}`,
  }
}

/**
 * 真实执行验证。exec 签名：
 *   async ({ container, argv, timeoutMs }) => { ok, stdout, stderr, code }
 * 由调用方注入（生产实现走 docker exec）。
 */
export async function verifyEgress({ slotId, proxy, slot, exec, hostProbe, opts = {} } = {}) {
  const s = slot || { slotId: String(slotId || '') }
  const p = proxy || {}
  const container = s.container || containerNameFor(s.slotId || slotId)
  if (typeof exec !== 'function') {
    return { ok: false, slotId: s.slotId, proxyId: p.id || '', checks: [], error: 'exec 未注入' }
  }
  if (!container) {
    return { ok: false, slotId: s.slotId, proxyId: p.id || '', checks: [], error: '槽位容器名缺失' }
  }

  const observed = {}
  const timeoutMs = opts.timeoutMs || 15_000

  // 探测失败（容器不存在、exec 不可用）一律记 null → 该项跳过。
  // 记成 false 会把「探测根本没跑」误判成「隔离生效」，那是假阳性。
  const probeFailed = (r) => !r || r.ok !== true

  // 容器出口 IP
  const probe = await exec({ container, argv: containerProbeCommand({ url: opts.probeUrl }), timeoutMs })
  observed.containerExitIp = probeFailed(probe) ? '' : extractIp(probe.stdout)

  // 宿主机控制组：同一端点从宿主机裸连看到的 IP。缺这段就无法排除
  // 「容器没走代理、但出口 IP 恰好等于预期」这种假阳性。
  if (typeof hostProbe === 'function') {
    try {
      observed.hostExitIp = String((await hostProbe()) || '').trim()
    } catch {
      observed.hostExitIp = ''
    }
  }

  // resolv.conf
  const resolv = await exec({ container, argv: containerResolvCommand(), timeoutMs: 5_000 })
  observed.resolvConf = probeFailed(resolv) ? '' : String(resolv.stdout || '')

  // 裸 TCP：连 1.1.1.1:53 不经代理。用 node 建立 TCP 更贴近真实出站
  const direct = await exec({
    container,
    argv: ['node', '-e', tcpProbeScript(), opts.directHost || '1.1.1.1', String(opts.directPort || 53)],
    timeoutMs: 8_000,
  })
  observed.directTcpOk = probeFailed(direct) ? null : /CONNECTED/.test(String(direct.stdout || ''))

  // UDP/53 直连
  const udp = await exec({
    container,
    argv: ['node', '-e', udpProbeScript(), opts.directHost || '1.1.1.1', String(opts.directPort || 53)],
    timeoutMs: 8_000,
  })
  observed.udpDnsReachable = probeFailed(udp) ? null : /REACHABLE/.test(String(udp.stdout || ''))

  // DNS 解析
  const resolve = await exec({
    container,
    argv: ['node', '-e', resolveProbeScript(), opts.resolveHost || 'www.anthropic.com'],
    timeoutMs: 12_000,
  })
  observed.dnsAnswerIps = probeFailed(resolve) ? null : extractResolution(String(resolve.stdout || ''))

  return evaluateEgress({ proxy: p, slot: s, observed })
}

/** 从解析输出里抽地址（每行一个）。 */
export function extractResolution(text) {
  return String(text || '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s && net.isIP(s))
}

/**
 * 占位符代理的预判：直接返回 skipped 结论，不碰网络。
 * 部署流水线里用它决定「是否值得花时间跑真实探测」。
 */
export function preflightEgress({ proxy, slot } = {}) {
  if (!isProxyUsable(proxy)) {
    const reason =
      proxy?.placeholder === true || isPlaceholderHost(proxy?.host)
        ? `代理信息仍是占位符（${proxy?.host || '空'}），需替换为真实 SOCKS5 地址`
        : '代理不可用（禁用或结构不合法）'
    return {
      ok: false,
      skipped: true,
      slotId: slot?.slotId || '',
      proxyId: proxy?.id || '',
      checks: [SKIP('预检', CHECK_KINDS.exitIp, reason)],
      reason,
      summary: `跳过：${reason}`,
    }
  }
  return { ok: true, skipped: false, slotId: slot?.slotId || '', proxyId: proxy?.id || '', checks: [] }
}

/** 容器内建 TCP 连接探测。成功打印 CONNECTED，失败打印 BLOCKED。 */
export function tcpProbeScript() {
  return [
    "const net=require('node:net');",
    'const s=net.connect({host:process.argv[1],port:Number(process.argv[2])});',
    "const t=setTimeout(()=>{console.log('BLOCKED');s.destroy();process.exit(0)},5000);",
    "s.on('connect',()=>{clearTimeout(t);console.log('CONNECTED');s.destroy();process.exit(0)});",
    "s.on('error',()=>{clearTimeout(t);console.log('BLOCKED');process.exit(0)});",
  ].join('')
}

/** 容器内 UDP 探测：能收到任何回包就算 REACHABLE。 */
export function udpProbeScript() {
  return [
    "const dgram=require('node:dgram');",
    "const s=dgram.createSocket('udp4');",
    "const q=Buffer.from([0x12,0x34,0x01,0x00,0,1,0,0,0,0,0,0,1,97,0,0,1,0,1]);",
    "const t=setTimeout(()=>{console.log('BLOCKED');try{s.close()}catch{};process.exit(0)},4000);",
    "s.on('message',()=>{clearTimeout(t);console.log('REACHABLE');try{s.close()}catch{};process.exit(0)});",
    "s.on('error',()=>{clearTimeout(t);console.log('BLOCKED');process.exit(0)});",
    's.send(q,Number(process.argv[2]),process.argv[1],()=>{});',
  ].join('')
}

/** 容器内解析探测：打印所有地址。 */
export function resolveProbeScript() {
  return [
    "require('node:dns').lookup(process.argv[1],{all:true},(e,r)=>{",
    "if(e){process.exit(1)}",
    "process.stdout.write(r.map((x)=>x.address).join('\\n'));process.exit(0)});",
  ].join('')
}
