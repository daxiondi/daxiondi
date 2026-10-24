/**
 * DNS 转发器：监听本槽位网关的 udp+tcp/53，把查询通过该槽位的 SOCKS5
 * 代理送到远端解析器（DNS over TCP，经 SOCKS5 CONNECT）。
 *
 * 职责：解决「容器里配的是 8.8.8.8，但包不能真的直连出去」。
 * 容器 udp/53 被 FORWARD 丢弃，tcp/53 被 nat REDIRECT 到本端口；
 * 本进程再用 SOCKS5 把查询从代理侧发出，解析结果与出口 IP 一致。
 *
 * 关键约束：
 * 1. 必须支持 TCP/53。glibc 会用 use-vc 走 TCP；只做 UDP 会导致解析超时。
 * 2. 必须支持 UDP/53 的显式绑定模式（hostDns=true 时把 udp/53 也 REDIRECT
 *    过来）。默认不开：UDP 经代理只能走 SOCKS5 UDP ASSOCIATE，
 *    住宅代理普遍不支持，开了就是长时间挂起而不是快速失败。
 * 3. 上游地址是 IP 字面量（8.8.8.8 / 1.1.1.1）。用域名做上游会陷入
 *    「解析解析器自身」的循环。
 * 4. 不做本地缓存。缓存会让「DNS 是否真的走了代理」无法验证。
 *
 * 这个模块只在真实部署时启动进程；测试里用 buildLoop 纯函数验证报文处理。
 */

import dgram from 'node:dgram'
import net from 'node:net'

import { openTunnel } from './socks5.mjs'

export const DEFAULT_UPSTREAMS = Object.freeze(['8.8.8.8', '1.1.1.1'])
export const DNS_TCP_TIMEOUT_MS = 10_000

/** 组 DNS 查询报文（单个 A 查询）。仅用于健康探测。 */
export function buildQuery(name, id = 0x1234, type = 1) {
  const labels = String(name || '')
    .split('.')
    .filter(Boolean)
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x0100, 2) // RD=1
  header.writeUInt16BE(1, 4) // QDCOUNT
  const parts = []
  for (const label of labels) {
    const buf = Buffer.from(label, 'utf8')
    parts.push(Buffer.from([buf.length]), buf)
  }
  parts.push(Buffer.from([0x00]))
  const qtype = Buffer.alloc(4)
  qtype.writeUInt16BE(type, 0)
  qtype.writeUInt16BE(1, 2)
  return Buffer.concat([header, ...parts, qtype])
}

/**
 * 极简 DNS 报文尾部解析：拿 ANCOUNT 与第一条 A/AAAA 记录。
 * 只用于探测与日志，不做完整解析器。
 */
export function parseAnswerIps(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  if (buf.length < 12) return { rcode: -1, ips: [] }
  const rcode = buf[3] & 0x0f
  const qd = buf.readUInt16BE(4)
  const an = buf.readUInt16BE(6)
  let off = 12
  for (let i = 0; i < qd; i += 1) {
    while (off < buf.length && buf[off] !== 0) {
      if ((buf[off] & 0xc0) === 0xc0) {
        off += 2
        break
      }
      off += buf[off] + 1
    }
    if (off < buf.length && buf[off] === 0) off += 1
    off += 4
  }
  const ips = []
  for (let i = 0; i < an && off + 12 <= buf.length; i += 1) {
    // name：可能是指针
    if ((buf[off] & 0xc0) === 0xc0) off += 2
    else {
      while (off < buf.length && buf[off] !== 0) off += buf[off] + 1
      off += 1
    }
    if (off + 10 > buf.length) break
    const type = buf.readUInt16BE(off)
    const rdlen = buf.readUInt16BE(off + 8)
    const rdStart = off + 10
    if (type === 1 && rdlen === 4) ips.push([...buf.subarray(rdStart, rdStart + 4)].join('.'))
    else if (type === 28 && rdlen === 16) {
      const groups = []
      for (let g = 0; g < 16; g += 2) groups.push(buf.readUInt16BE(rdStart + g).toString(16))
      ips.push(groups.join(':'))
    }
    off = rdStart + rdlen
  }
  return { rcode, ips, answers: an }
}

/** TCP 帧：2 字节长度前缀。 */
export function frameTcp(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || [])
  const head = Buffer.alloc(2)
  head.writeUInt16BE(body.length, 0)
  return Buffer.concat([head, body])
}

/** 从一个持续到达的字节流里切出完整 DNS 报文。 */
export function createTcpFramer() {
  let buf = Buffer.alloc(0)
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk])
      const out = []
      while (buf.length >= 2) {
        const len = buf.readUInt16BE(0)
        if (buf.length < 2 + len) break
        out.push(buf.subarray(2, 2 + len))
        buf = buf.subarray(2 + len)
      }
      return out
    },
    get pending() {
      return buf.length
    },
  }
}

/**
 * 处理一条 TCP 连接：读帧 → 逐个查询经代理转发 → 写回帧。
 * relay 是注入点，测试里换成假实现就能验证所有分支。
 */
export function createTcpHandler({ proxy, upstreams = DEFAULT_UPSTREAMS, relay, timeoutMs = DNS_TCP_TIMEOUT_MS }) {
  return (socket) => {
    const framer = createTcpFramer()
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      try {
        socket.destroy()
      } catch {}
    }
    socket.on('error', close)
    socket.on('close', close)
    socket.on('data', async (chunk) => {
      const frames = framer.push(chunk)
      for (const query of frames) {
        try {
          const answer = await relay({ query, proxy, upstreams, timeoutMs })
          if (!closed && socket.writable) socket.write(frameTcp(answer))
        } catch (error) {
          if (!closed) socket.write(frameTcp(errorResponse(query, 2)))
        }
      }
    })
  }
}

/** 构造 SERVFAIL 响应：把请求头改成响应，保留 question。 */
export function errorResponse(query, rcode = 2) {
  const q = Buffer.isBuffer(query) ? Buffer.from(query) : Buffer.from(query || [])
  if (q.length < 12) return Buffer.from([0x00, 0x00, 0x81, 0x80 | (rcode & 0x0f)])
  q[2] = (q[2] | 0x80) & 0xff // QR=1
  q[3] = (q[3] & 0xf0) | (rcode & 0x0f)
  q.writeUInt16BE(0, 6) // ANCOUNT
  q.writeUInt16BE(0, 8) // NSCOUNT
  q.writeUInt16BE(0, 10) // ARCOUNT
  return q
}

/**
 * 经 SOCKS5 代理向某个上游解析器发一条 TCP DNS 查询。
 * 这是真实实现，也是 verify 里「DNS 走代理」的证据来源。
 */
export async function relayOverProxy({ query, proxy, upstreams = DEFAULT_UPSTREAMS, timeoutMs = DNS_TCP_TIMEOUT_MS }) {
  let lastError = null
  for (const upstream of upstreams) {
    if (!net.isIP(upstream)) {
      lastError = new Error(`upstream 必须是 IP 字面量: ${upstream}`)
      continue
    }
    let socket
    try {
      socket = await openTunnel(proxy, { host: upstream, port: 53 }, { timeoutMs })
      const answer = await new Promise((resolve, reject) => {
        const framer = createTcpFramer()
        const timer = setTimeout(() => reject(new Error('dns_upstream_timeout')), timeoutMs)
        const onData = (chunk) => {
          const frames = framer.push(chunk)
          if (frames.length) {
            clearTimeout(timer)
            resolve(frames[0])
          }
        }
        socket.on('data', onData)
        socket.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        socket.write(frameTcp(query))
      })
      return answer
    } catch (error) {
      lastError = error
    } finally {
      try {
        socket?.destroy()
      } catch {}
    }
  }
  throw lastError || new Error('dns_upstream_failed')
}

/**
 * 启动转发器。
 *
 * mode:
 *   'tcp'（默认）→ 只监听 tcp/53；容器侧 use-vc 强制走 TCP
 *   'both'       → 同时监听 udp/53（需要代理支持 UDP ASSOCIATE）
 *
 * listenHost 必须是网桥网关：容器能路由到，且不会被自身 REDIRECT 再劫持。
 */
export async function startDnsForwarder({
  proxy,
  listenHost,
  port = 53,
  mode = 'tcp',
  upstreams = DEFAULT_UPSTREAMS,
  relay = relayOverProxy,
  timeoutMs = DNS_TCP_TIMEOUT_MS,
} = {}) {
  const errors = []
  if (!listenHost || !net.isIP(listenHost)) errors.push(`listenHost 必须是 IP: ${listenHost}`)
  if (!Number.isInteger(Number(port)) || Number(port) < 1) errors.push(`端口非法: ${port}`)
  if (errors.length) return { ok: false, errors }

  const servers = []
  const handler = createTcpHandler({ proxy, upstreams, relay, timeoutMs })

  const tcpServer = net.createServer(handler)
  await new Promise((resolve, reject) => {
    tcpServer.once('error', reject)
    tcpServer.listen({ host: listenHost, port: Number(port) }, resolve)
  })
  servers.push(() => tcpServer.close())

  let udpSocket = null
  if (mode === 'both') {
    udpSocket = dgram.createSocket('udp4')
    udpSocket.on('message', async (msg, rinfo) => {
      try {
        const answer = await relay({ query: msg, proxy, upstreams, timeoutMs })
        udpSocket.send(answer, rinfo.port, rinfo.address)
      } catch {
        udpSocket.send(errorResponse(msg, 2), rinfo.port, rinfo.address)
      }
    })
    await new Promise((resolve, reject) => {
      udpSocket.once('error', reject)
      udpSocket.bind({ address: listenHost, port: Number(port) }, resolve)
    })
    servers.push(() => udpSocket.close())
  }

  return {
    ok: true,
    listen: `${listenHost}:${port}`,
    mode,
    upstreams,
    stop() {
      for (const fn of servers) {
        try {
          fn()
        } catch {}
      }
    },
  }
}
