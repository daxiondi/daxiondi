/**
 * 代理池：配置加载、结构校验、槽位分配、健康探测。
 *
 * 职责：把用户手填的 config/proxies.json 变成内存里可信的代理条目，
 * 并把它们一对一地钉到 20 个槽位上。
 *
 * 关键约束：
 * 1. 一个代理只能给一个槽位。住宅出口被两条账号共用，等于两个账号同 IP，
 *    隔离的意义直接归零。分配函数不做「容量 > 1」的妥协。
 * 2. 占位符不是错误。示例配置里 host 通常是 1.2.3.4 / example.com 这类值，
 *    加载阶段必须能过，只在探测阶段判为 unusable。这样测试和首次部署
 *    都能在没填真代理的情况下跑通。
 * 3. 校验只做结构，不做连通性。连通性属于 checkProxyHealth。
 * 4. 密码不参与任何日志与 JSON 输出，redactProxy 是唯一出口。
 *
 * 配置文件形态：
 *   { "proxies": [ { id, type, host, port, username?, password?, region?,
 *                    expected_exit_ip?, enabled? } ] }
 */

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'

import { normalizeHost, normalizePort, proxyUrl, openTunnel } from './socks5.mjs'

/** 方案固定 20 个槽位，与调度器 SLOT_CAP 一致。 */
export const SLOT_COUNT = 20
/** 每个代理的槽位容量，固定 1，不开放配置。 */
export const SLOT_PER_PROXY = 1
/** 支持的代理类型。当前只做 SOCKS5（含远端解析变体）。 */
export const PROXY_TYPES = Object.freeze(['socks5', 'socks5h'])
/** 出口 IP 探测端点。按顺序尝试，第一个拿到 IPv4/IPv6 字面量即返回。 */
export const DEFAULT_PROBE_URLS = Object.freeze([
  'https://api.ipify.org/?format=json',
  'https://api64.ipify.org/?format=json',
  'https://ifconfig.me/ip',
])

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?:\.(?!-)[A-Za-z0-9-]{1,63})*$/

/**
 * 已知占位符主机。命中只打标记，不报错。
 * 保留 example.com/net/org 与文档保留段（RFC 5737 / RFC 3849）。
 */
const PLACEHOLDER_HOSTS = new Set([
  'host',
  'proxy',
  'socks',
  'placeholder',
  'example',
  'example.com',
  'example.net',
  'example.org',
  'proxy.example.com',
  'socks.example.com',
  'x.x.x.x',
  'ip',
  'your-proxy-host',
  '1.2.3.4',
  '127.0.0.1',
  '0.0.0.0',
])

/** host 是否明显是占位符。用于跳过真实连接，避免把示例配置当生产配置跑。 */
export function isPlaceholderHost(host) {
  const h = String(host == null ? '' : host)
    .trim()
    .toLowerCase()
  if (!h) return true
  if (/[<>{}]/.test(h)) return true
  if (PLACEHOLDER_HOSTS.has(h)) return true
  if (/\.(example|test|invalid|localhost)$/.test(h)) return true
  // RFC 5737 文档保留段 + RFC 3849 文档前缀
  if (/^192\.0\.2\.\d{1,3}$/.test(h)) return true
  if (/^198\.51\.100\.\d{1,3}$/.test(h)) return true
  if (/^203\.0\.113\.\d{1,3}$/.test(h)) return true
  if (h === '2001:db8::1' || h.startsWith('2001:db8:')) return true
  return false
}

/** 条目是否可用于真实拨号：结构合法、未禁用、非占位符。 */
export function isProxyUsable(proxy) {
  if (!proxy || typeof proxy !== 'object') return false
  if (proxy.enabled === false) return false
  if (proxy.placeholder === true) return false
  if (isPlaceholderHost(proxy.host)) return false
  if (!normalizeHost(proxy.host)) return false
  if (!normalizePort(proxy.port)) return false
  return true
}

/** 脱敏副本：密码替换成固定占位，供日志与快照输出。 */
export function redactProxy(proxy) {
  if (!proxy || typeof proxy !== 'object') return null
  const copy = { ...proxy }
  if (copy.password != null && copy.password !== '') copy.password = '***'
  if (copy.username != null && copy.username !== '') copy.username = String(copy.username)
  return copy
}

/**
 * 校验单条代理。返回 { proxy, errors, warnings }。
 * 不在校验里抛错：批量加载时要把所有坏条目一次报全。
 */
export function validateProxy(raw, { index = -1 } = {}) {
  const errors = []
  const warnings = []
  const at = index >= 0 ? `proxies[${index}]` : 'proxy'
  const src = raw && typeof raw === 'object' ? raw : {}

  const id = typeof src.id === 'string' ? src.id.trim() : ''
  if (!id) errors.push(`${at}.id 缺失`)
  else if (!ID_RE.test(id)) errors.push(`${at}.id 非法（仅允许字母数字下划线横线，1-32 字符）: ${id}`)

  const type = typeof src.type === 'string' ? src.type.trim().toLowerCase() : ''
  if (!type) errors.push(`${at}.type 缺失`)
  else if (!PROXY_TYPES.includes(type)) errors.push(`${at}.type 不支持（只接受 socks5 / socks5h）: ${type}`)

  const host = normalizeHost(src.host)
  if (!String(src.host == null ? '' : src.host).trim()) errors.push(`${at}.host 缺失`)
  else if (!host) errors.push(`${at}.host 非法: ${src.host}`)
  else if (!net.isIP(host) && !HOSTNAME_RE.test(host)) warnings.push(`${at}.host 不是合法 IP 也不是合法域名: ${host}`)

  const port = normalizePort(src.port)
  if (src.port == null || src.port === '') errors.push(`${at}.port 缺失`)
  else if (!port) errors.push(`${at}.port 非法（1-65535）: ${src.port}`)

  const username = src.username == null ? '' : String(src.username)
  if (username !== '' && Buffer.byteLength(username, 'utf8') > 255) {
    errors.push(`${at}.username 超过 255 字节`)
  }
  const password = src.password == null ? '' : String(src.password)
  if (password !== '' && username === '') errors.push(`${at}.password 给了但 username 为空`)
  if (Buffer.byteLength(password, 'utf8') > 255) errors.push(`${at}.password 超过 255 字节`)

  const region = src.region == null ? '' : String(src.region).trim()
  if (region && !/^[A-Za-z0-9 _.-]{1,32}$/.test(region)) errors.push(`${at}.region 非法: ${region}`)

  let expectedExitIp = ''
  if (src.expected_exit_ip != null && String(src.expected_exit_ip).trim() !== '') {
    expectedExitIp = String(src.expected_exit_ip).trim()
    if (!net.isIP(normalizeHost(expectedExitIp))) {
      errors.push(`${at}.expected_exit_ip 不是合法 IP: ${expectedExitIp}`)
    } else {
      expectedExitIp = normalizeHost(expectedExitIp)
    }
  }

  if (src.enabled != null && typeof src.enabled !== 'boolean') errors.push(`${at}.enabled 必须是布尔值`)

  const placeholder = isPlaceholderHost(host)
  if (placeholder && errors.length === 0) {
    warnings.push(`${at} 是占位符（host=${host || '空'}），不会参与真实拨号`)
  }

  const proxy = {
    id,
    type: PROXY_TYPES.includes(type) ? type : 'socks5',
    host,
    port,
    username,
    password,
    region,
    expectedExitIp,
    enabled: src.enabled !== false,
    placeholder,
    url: errors.length ? '' : proxyUrl({ id, host, port, username, password }),
  }

  return { proxy, errors, warnings }
}

/**
 * 从配置文件加载代理池。
 * 文件不存在 / JSON 坏 / 结构不对都走 ok:false，不抛异常——首次部署时
 * 这份文件通常是「还没填」的状态，进程不该因此起不来。
 *
 * @returns {{ok:boolean, path:string, proxies:Array, errors:string[],
 *            warnings:string[], byId:Map<string,object>}}
 */
export function loadProxyPool(configPath, { fsImpl = fs } = {}) {
  const result = { ok: false, path: String(configPath || ''), proxies: [], errors: [], warnings: [], byId: new Map() }
  if (!result.path) {
    result.errors.push('配置路径为空')
    return result
  }
  let text
  try {
    text = fsImpl.readFileSync(result.path, 'utf8')
  } catch (error) {
    result.errors.push(`读取失败: ${error.code || error.message}`)
    return result
  }

  let doc
  try {
    doc = JSON.parse(text)
  } catch (error) {
    result.errors.push(`JSON 解析失败: ${error.message}`)
    return result
  }

  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.proxies) ? doc.proxies : null
  if (!list) {
    result.errors.push('期望顶层为数组或 { "proxies": [...] }')
    return result
  }
  if (list.length === 0) {
    result.errors.push('代理列表为空')
    return result
  }

  const seen = new Map()
  list.forEach((raw, i) => {
    const { proxy, errors, warnings } = validateProxy(raw, { index: i })
    result.warnings.push(...warnings)
    if (errors.length) {
      result.errors.push(...errors)
      return
    }
    if (seen.has(proxy.id)) {
      result.errors.push(`proxies[${i}].id 重复: ${proxy.id}（首次出现在 proxies[${seen.get(proxy.id)}]）`)
      return
    }
    seen.set(proxy.id, i)
    result.proxies.push(proxy)
    result.byId.set(proxy.id, proxy)
  })

  result.ok = result.errors.length === 0
  return result
}

/** 从对象直接建池（跳过文件），供测试与嵌入调用。 */
export function normalizePool(entries) {
  const result = { ok: false, proxies: [], errors: [], warnings: [], byId: new Map() }
  if (!Array.isArray(entries) || entries.length === 0) {
    result.errors.push('代理列表为空')
    return result
  }
  const seen = new Map()
  entries.forEach((raw, i) => {
    const { proxy, errors, warnings } = validateProxy(raw, { index: i })
    result.warnings.push(...warnings)
    if (errors.length) {
      result.errors.push(...errors)
      return
    }
    if (seen.has(proxy.id)) {
      result.errors.push(`proxies[${i}].id 重复: ${proxy.id}`)
      return
    }
    seen.set(proxy.id, i)
    result.proxies.push(proxy)
    result.byId.set(proxy.id, proxy)
  })
  result.ok = result.errors.length === 0
  return result
}

const REGION_MATCH = (want, have) => {
  const a = String(want || '').trim().toLowerCase()
  const b = String(have || '').trim().toLowerCase()
  if (!a || !b) return false
  return a === b || b.startsWith(`${a}-`) || a.startsWith(`${b}-`)
}

/**
 * 槽位 → 代理的一对一分配。
 *
 * 顺序：显式 pinned → region 匹配 → 剩余顺序填充。
 * 同一代理出现在两次指定里直接判错，不做「就近替换」。
 *
 * @param {{slots:Array, proxies:Array, strict?:boolean}} input
 * @returns {{ok:boolean, assignments:Array, unassigned:Array, errors:string[]}}
 */
export function assignProxies({ slots, proxies, strict = true } = {}) {
  const list = Array.isArray(slots) ? slots : []
  const pool = (Array.isArray(proxies) ? proxies : []).filter((p) => p && p.enabled !== false)
  const errors = []
  const assignments = []
  const unassigned = []
  const used = new Set()

  const taken = new Map()
  const normalized = list.map((slot, i) => {
    if (typeof slot === 'string' || typeof slot === 'number') return { slotId: String(slot), index: i }
    return { ...(slot || {}), slotId: String(slot?.slotId ?? slot?.id ?? i), index: i }
  })

  // 第一轮：显式绑定
  for (const slot of normalized) {
    const pin = slot.pinnedProxyId || slot.proxyId || ''
    if (!pin) continue
    if (taken.has(pin)) {
      errors.push(`代理 ${pin} 被重复绑定：槽位 ${taken.get(pin)} 与 ${slot.slotId}`)
      continue
    }
    const proxy = pool.find((p) => p.id === pin)
    if (!proxy) {
      errors.push(`槽位 ${slot.slotId} 指定的代理不存在或已禁用: ${pin}`)
      continue
    }
    taken.set(pin, slot.slotId)
    used.add(pin)
    assignments.push({ slotId: slot.slotId, proxyId: proxy.id, proxy, pinned: true })
  }

  // 第二轮：按 region 就近
  for (const slot of normalized) {
    if (assignments.some((a) => a.slotId === slot.slotId)) continue
    if (!slot.region) continue
    const proxy = pool.find((p) => !used.has(p.id) && REGION_MATCH(slot.region, p.region))
    if (!proxy) continue
    used.add(proxy.id)
    assignments.push({ slotId: slot.slotId, proxyId: proxy.id, proxy, pinned: false, matched: 'region' })
  }

  // 第三轮：顺序填充
  for (const slot of normalized) {
    if (assignments.some((a) => a.slotId === slot.slotId)) continue
    const proxy = pool.find((p) => !used.has(p.id))
    if (!proxy) {
      unassigned.push(slot.slotId)
      continue
    }
    used.add(proxy.id)
    assignments.push({ slotId: slot.slotId, proxyId: proxy.id, proxy, pinned: false })
  }

  const duplicated = assignments.map((a) => a.proxyId).filter((id, i, all) => all.indexOf(id) !== i)
  if (duplicated.length) errors.push(`同一代理分配到多个槽位: ${[...new Set(duplicated)].join(', ')}`)

  if (unassigned.length && strict) errors.push(`代理不足，未分配槽位: ${unassigned.join(', ')}`)

  assignments.sort((a, b) => String(a.slotId).localeCompare(String(b.slotId)))
  return { ok: errors.length === 0, assignments, unassigned, errors }
}

// ─────────── 健康探测 ───────────

/** 极简 HTTP/1.1 GET over 已建立流，返回 { status, body }。 */
async function httpGetOverStream(stream, host, requestPath) {
  const req = `GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: skylink-egress-check/1\r\nAccept: */*\r\nConnection: close\r\n\r\n`
  stream.write(req)
  const chunks = []
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8_000)
    stream.on('data', (c) => chunks.push(c))
    stream.once('end', () => {
      clearTimeout(timer)
      resolve()
    })
    stream.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    stream.once('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  const raw = Buffer.concat(chunks).toString('utf8')
  const split = raw.indexOf('\r\n\r\n')
  const head = split >= 0 ? raw.slice(0, split) : raw
  const body = split >= 0 ? raw.slice(split + 4) : ''
  const status = Number((head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/) || [])[1] || 0)
  return { status, body: body.trim(), head }
}

/** 从端点响应里抠出 IP 字面量。 */
export function extractIpFromBody(body) {
  const text = String(body || '')
  const json = text.match(/"ip"\s*:\s*"([^"]+)"/i)
  if (json && net.isIP(normalizeHost(json[1]))) return normalizeHost(json[1])
  const plain = text.match(/\b(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{2,39})\b/i)
  if (plain && net.isIP(normalizeHost(plain[1]))) return normalizeHost(plain[1])
  return ''
}

/**
 * 经代理取一个 URL 的响应体。
 * HTTPS 走 TLS over SOCKS 隧道，证书校验用系统 CA。
 * 这是默认实现；测试通过 opts.fetchBody 注入，避免真实拨号。
 */
export async function fetchBodyOverProxy({ proxy, url, parsed, timeoutMs = 15_000, openTunnelImpl = openTunnel }) {
  const u = parsed || new URL(url)
  const tls = u.protocol === 'https:'
  const target = { host: u.hostname, port: Number(u.port || (tls ? 443 : 80)) }
  const socket = await openTunnelImpl(proxy, target, { timeoutMs })
  let stream = socket
  try {
    if (tls) {
      const { default: tlsMod } = await import('node:tls')
      stream = await new Promise((resolve, reject) => {
        const t = tlsMod.connect({ socket, servername: u.hostname }, () => resolve(t))
        t.once('error', (error) => reject(error))
      })
    }
    const { body } = await httpGetOverStream(stream, u.hostname, `${u.pathname || '/'}${u.search || ''}`)
    return body
  } finally {
    try {
      stream.destroy()
    } catch {}
  }
}

/**
 * 代理健康检查：真实 TCP 连接 + 经代理的出口 IP 探测。
 *
 * 占位符 / 已禁用 / 结构不合法一律返回 { ok:false, skipped:true }，
 * 不发起任何网络连接。这是「代理信息是占位符也能跑测试」的落点。
 *
 * @returns {Promise<{ok:boolean, proxyId:string, exitIp?:string,
 *   match?:boolean|null, latencyMs?:number, skipped?:boolean,
 *   code?:string, error?:string}>}
 */
export async function checkProxyHealth(proxy, opts = {}) {
  const {
    timeoutMs = 15_000,
    probeUrls = DEFAULT_PROBE_URLS,
    openTunnelImpl = openTunnel,
    fetchBody = null,
    now = () => Date.now(),
  } = opts
  const id = String(proxy?.id || '')
  if (!isProxyUsable(proxy)) {
    return {
      ok: false,
      skipped: true,
      proxyId: id,
      code: proxy?.placeholder ? 'placeholder_proxy' : 'proxy_unusable',
      error: proxy?.placeholder ? '代理是占位符，跳过真实拨号' : '代理不可用（禁用或结构不合法）',
      match: null,
    }
  }

  const started = now()
  let exitIp = ''
  let lastError = null
  for (const url of probeUrls) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      continue
    }
    try {
      const body = fetchBody
        ? await fetchBody({ proxy, url, parsed, timeoutMs })
        : await fetchBodyOverProxy({ proxy, url, parsed, timeoutMs, openTunnelImpl })
      const ip = extractIpFromBody(body)
      if (ip) {
        exitIp = ip
        break
      }
      lastError = '未在响应中解析到出口 IP'
    } catch (error) {
      lastError = error.message || String(error)
    }
  }

  if (!exitIp) {
    return {
      ok: false,
      proxyId: id,
      code: 'probe_failed',
      error: lastError || '所有探测端点均失败',
      match: null,
      latencyMs: now() - started,
    }
  }

  const match = proxy.expectedExitIp ? exitIp === proxy.expectedExitIp : null
  return {
    ok: match !== false,
    proxyId: id,
    exitIp,
    expectedExitIp: proxy.expectedExitIp || '',
    match,
    latencyMs: now() - started,
  }
}

/** 批量探测。并发上限故意压到 5，住宅代理串并发容易触发风控。 */
export async function checkPoolHealth(proxies, { concurrency = 5, ...opts } = {}) {
  const list = Array.isArray(proxies) ? proxies : []
  const results = []
  let cursor = 0
  const worker = async () => {
    while (cursor < list.length) {
      const i = cursor++
      results[i] = await checkProxyHealth(list[i], opts)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, worker))
  return results
}

/** 默认配置路径：<root>/config/proxies.json。 */
export function defaultConfigPath(rootDir) {
  return path.join(rootDir || process.cwd(), 'config', 'proxies.json')
}
