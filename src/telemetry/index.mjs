/**
 * 遥测模块入口：环境快照、事件构造、改写、发送器的统一导出。
 *
 * 还提供一个 `createTelemetry` 门面，把四层串起来：
 *   原始快照 → rewriteTelemetryEnv → buildTelemetryEnv → build*Event → sender
 * 调用方通常只需要门面上的几个方法。
 *
 * 默认关闭：`enabled` 缺省为 false。遥测是代替用户向上游陈述的行为，
 * 默认替用户陈述不合适，必须显式开启。关闭时所有方法都是空操作。
 */

import { buildTelemetryEnv, OFFICIAL_TELEMETRY_ENDPOINT, OFFICIAL_CLI_VERSION } from './env.mjs'
import {
  buildStartEvent,
  buildRequestEvent,
  buildToolEvent,
  buildErrorEvent,
  buildEvent,
  buildEventBatch,
  validateEvent,
  newDeviceId,
  newEventId,
  formatTimestamp,
} from './events.mjs'
import { rewriteTelemetryEnv, rewriteEnvironmentVars, auditRewrittenEnv } from './rewrite.mjs'
import { TelemetrySender, DEFAULT_SENDER_CONFIG, buildTelemetryHeaders } from './sender.mjs'

export {
  // env
  buildTelemetryEnv,
  OFFICIAL_TELEMETRY_ENDPOINT,
  OFFICIAL_CLI_VERSION,
  // events
  buildStartEvent,
  buildRequestEvent,
  buildToolEvent,
  buildErrorEvent,
  buildEvent,
  buildEventBatch,
  validateEvent,
  newDeviceId,
  newEventId,
  formatTimestamp,
  // rewrite
  rewriteTelemetryEnv,
  rewriteEnvironmentVars,
  auditRewrittenEnv,
  // sender
  TelemetrySender,
  DEFAULT_SENDER_CONFIG,
  buildTelemetryHeaders,
}

/** 遥测配置默认值。三项都对齐官方口径。 */
export const DEFAULT_TELEMETRY_CONFIG = Object.freeze({
  telemetry_enabled: false,
  telemetry_endpoint: OFFICIAL_TELEMETRY_ENDPOINT,
  telemetry_interval_sec: 300,
})

/**
 * 归一配置：任何非法值都退回默认，绝不抛错。
 * 端点必须是 https，避免误配成明文传输。
 */
export function normalizeTelemetryConfig(input = {}) {
  const src = input && typeof input === 'object' ? input : {}
  const rawEndpoint = String(src.telemetry_endpoint || '').trim()
  const endpoint = /^https:\/\/[^\s]+$/.test(rawEndpoint)
    ? rawEndpoint
    : DEFAULT_TELEMETRY_CONFIG.telemetry_endpoint

  const rawInterval = Number(src.telemetry_interval_sec)
  const interval =
    Number.isFinite(rawInterval) && rawInterval >= 60 && rawInterval <= 86_400
      ? Math.round(rawInterval)
      : DEFAULT_TELEMETRY_CONFIG.telemetry_interval_sec

  return {
    telemetry_enabled: src.telemetry_enabled === true,
    telemetry_endpoint: endpoint,
    telemetry_interval_sec: interval,
  }
}

/**
 * 门面：把四层串起来。创建时不发起任何网络动作。
 */
export function createTelemetry(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const config = normalizeTelemetryConfig(opts.config || opts)
  const context = opts.context && typeof opts.context === 'object' ? opts.context : {}

  const sender = new TelemetrySender({
    endpoint: config.telemetry_endpoint,
    enabled: config.telemetry_enabled,
    timeoutMs: opts.timeoutMs,
    fetcher: opts.fetcher,
    logger: opts.logger,
    headersProvider: opts.headersProvider,
    now: opts.now,
  })

  /** 由原始快照构造一个已经过改写、可直接上报的 env */
  function envOf(snapshot = {}) {
    const raw = { ...context, ...(snapshot || {}) }
    const rewritten = rewriteTelemetryEnv(raw.env || raw, { ...context, ...raw })
    return buildTelemetryEnv({ ...raw, ...rewritten })
  }

  /** 统一的事件上下文 */
  function ctxOf(extra = {}) {
    const merged = { ...context, ...(extra || {}) }
    return { ...merged, env: merged.env || envOf(merged) }
  }

  return {
    config,
    sender,
    enabled: config.telemetry_enabled,
    envOf,
    start(extra = {}) {
      return buildStartEvent(ctxOf(extra))
    },
    request(extra = {}) {
      return buildRequestEvent(ctxOf(extra))
    },
    tool(extra = {}) {
      return buildToolEvent(ctxOf(extra))
    },
    error(extra = {}) {
      return buildErrorEvent(ctxOf(extra))
    },
    /** 入队一批事件（不同步发送） */
    enqueue(events) {
      return sender.send(events)
    },
    /** 冲刷队列 */
    flush(flushOptions) {
      return sender.flush(flushOptions)
    },
    snapshot() {
      return sender.snapshot()
    },
  }
}
