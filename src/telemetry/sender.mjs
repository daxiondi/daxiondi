/**
 * 遥测发送器。
 *
 * 定位：把事件批量送到上游，**失败不影响主流程**。这不是一句自我安慰 ——
 * 官方客户端本身就是 best-effort：发送失败就退避重试，重试到上限就丢弃，
 * 丢弃只写日志，从不阻断对话。我们要复现的正是这个行为。
 *
 * 因此这里有三条不可动摇的约定：
 *   1. 任何失败都吞掉，绝不向调用方抛错（除参数编程错误外）。
 *   2. 任何网络动作都有短超时，且不阻塞调用方的关键路径。
 *   3. 队列有上限，满了丢最旧的 —— 与官方「队列满则丢弃新记录」相反，
 *      这里选丢最旧，因为最新的状态更能代表当前会话；两者都不会无限增长。
 *
 * 默认关闭。理由见 config：遥测是「我们在替用户说话」的行为，默认替用户
 * 说话是不对的，必须显式开启。
 */

import { OFFICIAL_TELEMETRY_ENDPOINT, OFFICIAL_CLI_VERSION } from './env.mjs'
import { TELEMETRY_LIMITS, buildEventBatch } from './events.mjs'

/** 发送器默认配置：端点、超时、批量、队列上限 */
export const DEFAULT_SENDER_CONFIG = Object.freeze({
  endpoint: OFFICIAL_TELEMETRY_ENDPOINT,
  enabled: false,
  timeoutMs: 5_000,
  maxBatchSize: TELEMETRY_LIMITS.maxBatchSize,
  maxQueueSize: TELEMETRY_LIMITS.maxQueueSize,
  intervalSec: 300,
})

/** 官方上报请求头。只发这些，多一个都是差异。 */
export function buildTelemetryHeaders(options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': `claude-code/${OFFICIAL_CLI_VERSION}`,
    'x-service-name': 'claude-code',
    'anthropic-version': '2023-06-01',
  }
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`
  if (options.sessionId) headers['x-claude-code-session-id'] = String(options.sessionId)
  return headers
}

/**
 * 发送器。
 *
 * 队列语义：入队即返回（同步），真正的网络动作在 flush 里。
 * 这样可以保证调用方的主流程完全不等待网络。
 */
export class TelemetrySender {
  #endpoint
  #enabled
  #timeoutMs
  #maxBatchSize
  #maxQueueSize
  #fetcher
  #headersProvider
  #logger
  #clock
  #queue = []
  #inFlight = null
  #stats

  constructor(config = {}) {
    const merged = { ...DEFAULT_SENDER_CONFIG, ...(config || {}) }
    this.#endpoint = String(merged.endpoint || DEFAULT_SENDER_CONFIG.endpoint)
    this.#enabled = merged.enabled === true
    this.#timeoutMs = Math.max(1, Number(merged.timeoutMs) || DEFAULT_SENDER_CONFIG.timeoutMs)
    this.#maxBatchSize = Math.max(1, Number(merged.maxBatchSize) || DEFAULT_SENDER_CONFIG.maxBatchSize)
    this.#maxQueueSize = Math.max(1, Number(merged.maxQueueSize) || DEFAULT_SENDER_CONFIG.maxQueueSize)
    // 显式传了 fetcher 就只用它（哪怕是 null）：测试与沙箱必须能彻底断网，
    // 静默回退到全局 fetch 会让「离线测试」真的打出去请求。
    this.#fetcher = Object.hasOwn(merged, 'fetcher') ? merged.fetcher : globalThis.fetch
    this.#headersProvider = typeof merged.headersProvider === 'function' ? merged.headersProvider : null
    this.#logger = merged.logger && typeof merged.logger === 'object' ? merged.logger : null
    this.#clock = typeof merged.now === 'function' ? merged.now : () => Date.now()
    this.#stats = {
      enqueued: 0,
      sent: 0,
      failed: 0,
      dropped: 0,
      batches: 0,
      lastErrorAt: 0,
      lastSuccessAt: 0,
      lastError: '',
    }
  }

  /** 是否启用。默认 false。 */
  get enabled() {
    return this.#enabled
  }

  /** 运行期开关（供配置热更新） */
  setEnabled(value) {
    this.#enabled = value === true
    return this.#enabled
  }

  /** 当前队列长度 */
  get size() {
    return this.#queue.length
  }

  /** 端点地址 */
  get endpoint() {
    return this.#endpoint
  }

  /**
   * 入队。不发起网络请求，不抛错。
   * 队列满时丢最旧的，保证内存有界。
   *
   * @returns {number} 入队后队列长度
   */
  send(events) {
    const list = Array.isArray(events) ? events : events ? [events] : []
    if (list.length === 0) return this.#queue.length
    if (!this.#enabled) return this.#queue.length

    for (const event of list) {
      if (!event || typeof event !== 'object') continue
      this.#queue.push(event)
      this.#stats.enqueued += 1
      while (this.#queue.length > this.#maxQueueSize) {
        this.#queue.shift()
        this.#stats.dropped += 1
      }
    }
    return this.#queue.length
  }

  /**
   * 强制冲刷：把队列里的全部事件按批送出。
   *
   * 返回统计结果，永不抛错。多个 flush 并发时共享同一个 in-flight 承诺，
   * 避免重复发送同一批事件。
   */
  async flush(options = {}) {
    if (!this.#enabled) {
      return { ok: true, skipped: true, sent: 0, failed: 0, batches: 0 }
    }
    if (this.#inFlight) return this.#inFlight

    this.#inFlight = this.#doFlush(options).finally(() => {
      this.#inFlight = null
    })
    return this.#inFlight
  }

  async #doFlush(options) {
    const result = { ok: true, skipped: false, sent: 0, failed: 0, batches: 0 }
    const batches = []
    while (this.#queue.length > 0) {
      batches.push(this.#queue.splice(0, this.#maxBatchSize))
    }
    if (batches.length === 0) return result

    for (const batch of batches) {
      const payload = buildEventBatch(batch, { maxBatchSize: this.#maxBatchSize })
      const outcome = await this.#post(payload, options)
      result.batches += 1
      this.#stats.batches += 1
      if (outcome.ok) {
        result.sent += payload.events.length
        this.#stats.sent += payload.events.length
        this.#stats.lastSuccessAt = this.#clock()
      } else {
        result.failed += payload.events.length
        result.ok = false
        this.#stats.failed += payload.events.length
        this.#stats.lastErrorAt = this.#clock()
        this.#stats.lastError = outcome.error || 'unknown'
      }
    }
    return result
  }

  /** 单次 POST。超时、非 2xx、网络错误一律转成 { ok: false }，不抛错。 */
  async #post(payload, options = {}) {
    const fetcher = this.#fetcher
    if (typeof fetcher !== 'function') {
      return { ok: false, error: 'fetch-unavailable' }
    }

    let headers
    try {
      headers =
        typeof this.#headersProvider === 'function'
          ? buildTelemetryHeaders(this.#headersProvider() || {})
          : buildTelemetryHeaders(options)
    } catch {
      headers = buildTelemetryHeaders({})
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller
      ? setTimeout(() => {
          try {
            controller.abort()
          } catch {
            /* 忽略 */
          }
        }, this.#timeoutMs)
      : null
    // 计时器不应阻止进程退出
    if (timer && typeof timer.unref === 'function') timer.unref()

    try {
      const response = await fetcher(this.#endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined,
      })
      if (response && typeof response === 'object' && 'ok' in response) {
        return response.ok ? { ok: true } : { ok: false, error: `status-${response.status ?? 'unknown'}` }
      }
      return { ok: true }
    } catch (error) {
      const name = error && error.name ? String(error.name) : ''
      const kind = name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network'
      this.#log('warn', `telemetry post failed: ${kind}`)
      return { ok: false, error: kind }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  #log(level, message) {
    if (!this.#logger) return
    const fn = this.#logger[level]
    if (typeof fn === 'function') {
      try {
        fn.call(this.#logger, message)
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
  }

  /** 健康检查快照。纯读，无副作用。 */
  snapshot() {
    return {
      enabled: this.#enabled,
      endpoint: this.#endpoint,
      queue: this.#queue.length,
      maxQueueSize: this.#maxQueueSize,
      maxBatchSize: this.#maxBatchSize,
      timeoutMs: this.#timeoutMs,
      inFlight: this.#inFlight !== null,
      ...this.#stats,
    }
  }

  /** 清空队列（不发送）。用于关闭或测试。 */
  clear() {
    const dropped = this.#queue.length
    this.#queue = []
    this.#stats.dropped += dropped
    return dropped
  }
}
