/**
 * SOCKS5 协议层：客户端握手、CONNECT、以及地址编码。
 *
 * 职责：把「一个代理条目 + 一个目标」变成一条已打通的 net.Socket。
 * 其余模块（relay / pool / verify）只调用这里，不重复实现字节协议。
 *
 * 关键约束：
 * 1. 地址一律按域名模式（ATYP=0x03）交给代理解析，除非目标是 IP 字面量。
 *    这是防 DNS 泄漏的前提：本地不做解析，解析只发生在代理侧。
 * 2. 握手阶段用 readable 手动读，不用 data 事件。data 事件会把 socket 切进
 *    flowing 模式，握手后残留的字节会被吞掉，表现为「连上了但首包丢失」。
 * 3. 握手完成后必须把多读到的字节 unshift 回 socket，再接隧道。
 * 4. 认证只支持 0x00（免认证）与 0x02（用户名密码，RFC 1929）。其他方法直接失败。
 * 5. 错误带 code，便于上层区分「代理不可达」与「代理拒绝目标」。
 */

import net from 'node:net'

export const SOCKS_VERSION = 0x05
export const AUTH_NONE = 0x00
export const AUTH_USERPASS = 0x02
export const AUTH_NO_ACCEPTABLE = 0xff
export const CMD_CONNECT = 0x01
export const ATYP_IPV4 = 0x01
export const ATYP_DOMAIN = 0x03
export const ATYP_IPV6 = 0x04

/** RFC 1928 reply code → 语义名。用于错误分类与提示。 */
export const SOCKS_REPLY_NAMES = Object.freeze({
  0x00: 'succeeded',
  0x01: 'general_failure',
  0x02: 'not_allowed_by_ruleset',
  0x03: 'network_unreachable',
  0x04: 'host_unreachable',
  0x05: 'connection_refused',
  0x06: 'ttl_expired',
  0x07: 'command_not_supported',
  0x08: 'address_type_not_supported',
})

function socksError(code, message, extra = {}) {
  return Object.assign(new Error(message || code), { code, ...extra })
}

/** 主机名归一：去掉 IPv6 方括号，拒绝含空白/分隔符的脏值。 */
export function normalizeHost(value) {
  let host = String(value == null ? '' : value).trim()
  if (!host) return ''
  if (host.startsWith('[') && host.endsWith(']') && net.isIPv6(host.slice(1, -1))) host = host.slice(1, -1)
  if (net.isIPv6(host)) return host
  if (/[\s[\]:/@?#\\]/.test(host)) return ''
  if (host.length > 253) return ''
  return host
}

/** 端口归一：1..65535 的整数，其余返回 0。 */
export function normalizePort(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 0
  return n
}

/** 代理地址序列化成 URL。remoteDns=false 时用 socks5，true 时用 socks5h。 */
export function proxyUrl(proxy, { remoteDns = true } = {}) {
  const host = normalizeHost(proxy?.host)
  const port = normalizePort(proxy?.port)
  if (!host || !port) return ''
  const auth =
    proxy?.username != null && proxy.username !== ''
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
      : ''
  const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`
  return `${remoteDns ? 'socks5h' : 'socks5'}://${auth}${authority}`
}

/**
 * 目标地址编码。
 * 返回 { atyp, body }，body 不含 ATYP 字节，只含地址 + 端口。
 */
export function encodeTarget(host, port) {
  const h = normalizeHost(host)
  const p = normalizePort(port)
  if (!h) throw socksError('socks5_bad_target_host', `invalid target host: ${host}`)
  if (!p) throw socksError('socks5_bad_target_port', `invalid target port: ${port}`)

  const portBuf = Buffer.alloc(2)
  portBuf.writeUInt16BE(p, 0)

  const family = net.isIP(h)
  if (family === 4) {
    const parts = h.split('.').map(Number)
    return { atyp: ATYP_IPV4, body: Buffer.concat([Buffer.from(parts), portBuf]) }
  }
  if (family === 6) {
    // net.isIP 只判定形状；这里按 8 组 16 位展开，支持 :: 压缩写法
    return { atyp: ATYP_IPV6, body: Buffer.concat([ipv6ToBuffer(h), portBuf]) }
  }
  const name = Buffer.from(h, 'utf8')
  if (name.length > 255) throw socksError('socks5_bad_target_host', 'target hostname too long')
  return { atyp: ATYP_DOMAIN, body: Buffer.concat([Buffer.from([name.length]), name, portBuf]) }
}

/** IPv6 字面量 → 16 字节。支持 :: 压缩。非法输入抛错。 */
export function ipv6ToBuffer(address) {
  const raw = String(address || '').toLowerCase()
  const halves = raw.split('::')
  if (halves.length > 2) throw socksError('socks5_bad_target_host', `invalid ipv6: ${address}`)
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : fill < 0) {
    throw socksError('socks5_bad_target_host', `invalid ipv6: ${address}`)
  }
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail]
  const buf = Buffer.alloc(16)
  groups.forEach((g, i) => {
    const n = Number.parseInt(g || '0', 16)
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
      throw socksError('socks5_bad_target_host', `invalid ipv6 group: ${g}`)
    }
    buf.writeUInt16BE(n, i * 2)
  })
  return buf
}

/**
 * 读取器：按字节数从 socket 取数据，不足则等 readable。
 * 握手成功后调用 drain() 取走多余字节。
 */
function byteReader(socket, { timeoutMs = 15_000 } = {}) {
  const chunks = []
  let buffered = 0
  let failure = null
  let finished = false

  const onError = (error) => {
    failure = error
  }
  const onClose = () => {
    finished = true
  }
  socket.on('error', onError)
  socket.on('close', onClose)

  const waitReadable = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(socksError('socks5_timeout', `socks5 handshake timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const onReadable = () => {
        cleanup()
        resolve()
      }
      const onErr = (error) => {
        cleanup()
        reject(error)
      }
      const onEnd = () => {
        cleanup()
        finished = true
        resolve()
      }
      const cleanup = () => {
        clearTimeout(timer)
        socket.off('readable', onReadable)
        socket.off('error', onErr)
        socket.off('end', onEnd)
      }
      socket.once('readable', onReadable)
      socket.once('error', onErr)
      socket.once('end', onEnd)
      if (failure) onErr(failure)
    })

  return {
    async read(n) {
      while (buffered < n) {
        const chunk = socket.read()
        if (chunk === null || chunk === undefined) {
          if (failure) throw failure
          if (finished) throw socksError('socks5_handshake_eof', 'proxy closed during handshake')
          await waitReadable()
          if (failure) throw failure
          if (finished && buffered < n) throw socksError('socks5_handshake_eof', 'proxy closed during handshake')
          continue
        }
        chunks.push(chunk)
        buffered += chunk.length
      }
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
      const out = all.subarray(0, n)
      const rest = all.subarray(n)
      chunks.length = 0
      if (rest.length) chunks.push(rest)
      buffered = rest.length
      return out
    },
    /** 把未消费的字节塞回 socket，供隧道阶段读取。 */
    drain() {
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
      chunks.length = 0
      buffered = 0
      return all
    },
    detach() {
      socket.off('error', onError)
      socket.off('close', onClose)
    },
  }
}

/**
 * 在已连接的 socket 上完成 SOCKS5 协商与 CONNECT。
 * 成功返回 socket（已重置为无监听状态，可直接 pipe）。
 */
export async function negotiate(socket, proxy, target, { timeoutMs = 15_000 } = {}) {
  const hasAuth = proxy?.username != null && proxy.username !== ''
  const methods = hasAuth ? [AUTH_NONE, AUTH_USERPASS] : [AUTH_NONE]
  const reader = byteReader(socket, { timeoutMs })

  try {
    socket.write(Buffer.concat([Buffer.from([SOCKS_VERSION, methods.length]), Buffer.from(methods)]))
    const greeting = await reader.read(2)
    if (greeting[0] !== SOCKS_VERSION) throw socksError('socks5_bad_version', `unexpected version ${greeting[0]}`)
    const method = greeting[1]
    if (method === AUTH_NO_ACCEPTABLE) {
      throw socksError('socks5_no_acceptable_auth', 'proxy rejected all offered auth methods')
    }
    if (method === AUTH_USERPASS) {
      if (!hasAuth) throw socksError('socks5_auth_required', 'proxy requires username/password but none configured')
      const user = Buffer.from(String(proxy.username), 'utf8')
      const pass = Buffer.from(String(proxy.password || ''), 'utf8')
      if (user.length > 255 || pass.length > 255) {
        throw socksError('socks5_credential_too_long', 'username/password exceeds 255 bytes')
      }
      socket.write(
        Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]),
      )
      const authReply = await reader.read(2)
      if (authReply[0] !== 0x01) throw socksError('socks5_auth_version', `unexpected auth version ${authReply[0]}`)
      if (authReply[1] !== 0x00) throw socksError('socks5_auth_failed', 'proxy rejected credentials')
    } else if (method !== AUTH_NONE) {
      throw socksError('socks5_unsupported_auth', `proxy selected unsupported auth method ${method}`)
    }

    const { atyp, body } = encodeTarget(target.host, target.port)
    socket.write(Buffer.concat([Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00, atyp]), body]))

    const head = await reader.read(4)
    if (head[0] !== SOCKS_VERSION) throw socksError('socks5_bad_version', `unexpected version ${head[0]}`)
    if (head[1] !== 0x00) {
      const name = SOCKS_REPLY_NAMES[head[1]] || `reply_${head[1]}`
      throw socksError(`socks5_${name}`, `proxy refused CONNECT to ${target.host}:${target.port}: ${name}`, {
        reply: head[1],
      })
    }
    const boundAtyp = head[3]
    if (boundAtyp === ATYP_IPV4) await reader.read(4 + 2)
    else if (boundAtyp === ATYP_IPV6) await reader.read(16 + 2)
    else if (boundAtyp === ATYP_DOMAIN) {
      const len = await reader.read(1)
      await reader.read(len[0] + 2)
    } else {
      throw socksError('socks5_bad_atyp', `unexpected bound address type ${boundAtyp}`)
    }

    const leftover = reader.drain()
    reader.detach()
    if (leftover.length) socket.unshift(leftover)
    return socket
  } catch (error) {
    reader.detach()
    try {
      socket.destroy()
    } catch {}
    throw error
  }
}

/** 建 TCP 到代理 → 协商 → 返回可用隧道。 */
export async function openTunnel(proxy, target, { timeoutMs = 15_000, connect } = {}) {
  const host = normalizeHost(proxy?.host)
  const port = normalizePort(proxy?.port)
  if (!host || !port) throw socksError('socks5_bad_proxy', 'proxy host/port invalid')
  const connectFn =
    connect ||
    ((h, p) =>
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: h, port: p })
        const timer = setTimeout(() => {
          socket.destroy()
          reject(socksError('socks5_connect_timeout', `connect ${h}:${p} timed out`))
        }, timeoutMs)
        socket.once('connect', () => {
          clearTimeout(timer)
          socket.off('error', onError)
          resolve(socket)
        })
        const onError = (error) => {
          clearTimeout(timer)
          reject(socksError('socks5_connect_failed', `connect ${h}:${p} failed: ${error.message}`, { cause: error }))
        }
        socket.once('error', onError)
      }))
  const socket = await connectFn(host, port)
  try {
    return await negotiate(socket, proxy, target, { timeoutMs })
  } catch (error) {
    try {
      socket.destroy()
    } catch {}
    throw error
  }
}
