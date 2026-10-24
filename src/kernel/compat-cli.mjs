#!/usr/bin/env node
/**
 * 兼容性测试专用假 CLI。
 *
 * 与 test/fixtures/fake-cli.mjs 的区别：那个只发一条 delta、且不区分流式语义，
 * 用途是验证「内核 ↔ CLI」的帧往返。这个要喂饱 vm2api 的 SSE 解析器与
 * isCompleteAssistantMessage 判定，所以事件序列必须完整：
 *
 *   stream_event(message_start)      ← 带 message.usage，客户端从这里取 input_tokens
 *   stream_event(content_block_start)
 *   stream_event(content_block_delta) × N
 *   stream_event(content_block_stop)
 *   stream_event(message_delta)      ← 带 delta.stop_reason 与 usage.output_tokens
 *   stream_event(message_stop)       ← 客户端 sawMessageStop 的唯一来源
 *   job_done                         ← usage / stop_reason 走终态帧
 *
 * 协议全部照 src/frames.mjs（协议版本 2）：
 *   - stdout 一行一帧 NDJSON
 *   - 启动发 host_ready + 每个槽一条 slot_ready
 *   - stdin 只接受 job_start / cancel / ping
 *
 * 环境变量：
 *   COMPAT_CLI_SLOTS     上报槽数，缺省 4（与 test 里的 slots_per_worker 对齐）
 *   COMPAT_CLI_DELAY_MS  每个 delta 之间的延迟，缺省 5ms。
 *                        取消测试需要它：没有延迟，job 会在 abort 之前就跑完，
 *                        inflight 表自然命中不到。
 *   COMPAT_CLI_TEXT      回复正文，缺省 'compat pong'
 *   COMPAT_CLI_LOG       帧日志（JSON Lines），供断言协议往返
 *
 * 生命周期：stdin 关闭即退出；另有 60s 硬超时兜底，不留孤儿进程。
 */

import fs from 'node:fs'
import { createInterface } from 'node:readline'

const SLOTS = Number(process.env.COMPAT_CLI_SLOTS || 4) || 4
const DELAY_MS = Number(process.env.COMPAT_CLI_DELAY_MS || 5) || 0
const TEXT = process.env.COMPAT_CLI_TEXT || 'compat pong'
const LOGFILE = process.env.COMPAT_CLI_LOG || ''

const slotId = (i) => `s${String(i).padStart(2, '0')}`

function log(direction, frame) {
  if (!LOGFILE) return
  try {
    fs.appendFileSync(LOGFILE, `${JSON.stringify({ direction, frame })}\n`)
  } catch {}
}

function out(frame) {
  log('out', frame)
  if (!process.stdout.writable) return
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 握手
out({
  type: 'host_ready',
  protocol_version: 2,
  slots: SLOTS,
  system_layout: process.env.CLAUDE_CODE_SYSTEM_LAYOUT || 'zero',
  timezone: process.env.CLAUDE_CODE_TIMEZONE || 'UTC',
  capabilities: ['multi_slot', 'native_sse', 'stateless', 'ping', 'classifier_request_context'],
  config_hash: null,
})
for (let i = 0; i < SLOTS; i += 1) out({ type: 'slot_ready', slot_id: slotId(i) })

/** 正在跑的 job：jobId → { slot, cancelled } */
const jobs = new Map()

async function runJob({ jobId, slot, text }) {
  const inputTokens = 8
  const outputTokens = Math.max(1, Math.ceil(text.length / 4))
  const messageId = `msg_${jobId.replace(/-/g, '').slice(0, 24)}`

  out({
    type: 'stream_event',
    job_id: jobId,
    slot_id: slot,
    event: {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    },
  })
  out({
    type: 'stream_event',
    job_id: jobId,
    slot_id: slot,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  })

  // 按 4 字符切片，保证至少两片（客户端会按 delta 累计）
  for (let i = 0; i < text.length; i += 4) {
    if (jobs.get(jobId)?.cancelled) return cancelled(jobId, slot)
    if (DELAY_MS > 0) await sleep(DELAY_MS)
    out({
      type: 'stream_event',
      job_id: jobId,
      slot_id: slot,
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: text.slice(i, i + 4) },
      },
    })
  }

  out({
    type: 'stream_event',
    job_id: jobId,
    slot_id: slot,
    event: { type: 'content_block_stop', index: 0 },
  })
  out({
    type: 'stream_event',
    job_id: jobId,
    slot_id: slot,
    event: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
  })
  out({
    type: 'stream_event',
    job_id: jobId,
    slot_id: slot,
    event: { type: 'message_stop' },
  })
  out({
    type: 'job_done',
    job_id: jobId,
    slot_id: slot,
    stop_reason: 'end_turn',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    headers: {},
  })
  jobs.delete(jobId)
}

function cancelled(jobId, slot) {
  out({ type: 'cancel_ack', job_id: jobId, slot_id: slot })
  jobs.delete(jobId)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let frame
  try {
    frame = JSON.parse(trimmed)
  } catch {
    return // 非 JSON 静默丢弃，与官方 CLI 一致
  }
  if (!frame || typeof frame.type !== 'string') return
  log('in', frame)

  const slot = frame.slot_id || slotId(0)
  const jobId = frame.job_id || 'job-unknown'

  if (frame.type === 'job_start') {
    jobs.set(jobId, { slot, cancelled: false })
    const text = frame.request?.metadata?.compat_text || TEXT
    // 不 await：保持 stdin 循环可响应 cancel
    runJob({ jobId, slot, text }).catch(() => {
      out({
        type: 'job_error',
        job_id: jobId,
        slot_id: slot,
        error: 'fake cli job failed',
        code: 'cli_job_failed',
        status: 502,
      })
      jobs.delete(jobId)
    })
    return
  }

  if (frame.type === 'ping') {
    out({ type: 'pong', nonce: frame.nonce })
    return
  }

  if (frame.type === 'cancel') {
    const entry = jobs.get(jobId)
    if (entry) {
      entry.cancelled = true
      cancelled(jobId, entry.slot)
    } else {
      // 已经跑完或未知：仍回 ack，客户端据此把槽释放
      out({ type: 'cancel_ack', job_id: jobId, slot_id: slot })
    }
  }
  // 其余类型静默丢弃（协议规定）
})

function shutdown() {
  try {
    rl.close()
  } catch {}
  process.exit(0)
}

rl.on('close', shutdown)
process.stdin.on('end', shutdown)
process.stdin.on('error', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

setTimeout(shutdown, 60_000).unref()
