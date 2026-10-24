#!/usr/bin/env node
/**
 * 假 CLI：按 src/frames.mjs 的协议版本 2 回帧，供 smoke 测试驱动内核。
 *
 * 协议依据（全部照 src/frames.mjs 抄，不猜）：
 *   - stdout 一行一帧 NDJSON
 *   - 启动先发 host_ready（字段：type / protocol_version / slots / system_layout /
 *     timezone / capabilities / config_hash），再发每个槽的 slot_ready（type / slot_id）
 *   - stdin 只接受 job_start / cancel / ping 三种帧
 *   - job_start 回 stream_event（type / job_id / slot_id / event）+ job_done
 *     （type / job_id / slot_id / stop_reason / usage / headers）
 *   - ping 回 pong（type / nonce）；cancel 回 cancel_ack（type / job_id / slot_id）
 *
 * 环境变量：
 *   FAKE_CLI_SLOTS    上报的槽数，缺省 4（与 B 模式的 slots=4 对齐）
 *   FAKE_CLI_PIDFILE  把自身 pid 写到此文件，供测试断言清理干净
 *   FAKE_CLI_LOG      把收到的每一帧追加到该文件（JSON Lines），供测试断言协议往返
 *
 * 自杀策略：stdin 关闭（父进程死亡或主动 end）就退出；另有 30s 硬超时兜底，
 * 保证任何情况下都不会留下孤儿进程。
 */

import fs from 'node:fs'
import { createInterface } from 'node:readline'

const SLOTS = Number(process.env.FAKE_CLI_SLOTS || 4) || 4
const PIDFILE = process.env.FAKE_CLI_PIDFILE || ''
const LOGFILE = process.env.FAKE_CLI_LOG || ''

const slotId = (i) => `s${String(i).padStart(2, '0')}`

function mark(text) {
  if (!PIDFILE) return
  try {
    fs.writeFileSync(PIDFILE, `${process.pid} ${text}\n`)
  } catch {}
}

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

mark('start')

// ── 握手：host_ready + 每个槽一条 slot_ready ──────────────────────────
out({
  type: 'host_ready',
  protocol_version: 2,
  slots: SLOTS,
  system_layout: process.env.CLAUDE_CODE_SYSTEM_LAYOUT || 'zero',
  timezone: process.env.CLAUDE_CODE_TIMEZONE || 'UTC',
  capabilities: ['multi_slot', 'native_sse', 'stateless', 'ping'],
  config_hash: null,
})

for (let i = 0; i < SLOTS; i += 1) out({ type: 'slot_ready', slot_id: slotId(i) })

// ── 帧循环 ────────────────────────────────────────────────────────────
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
    // 一条流式事件 + 终态帧。event 内容内核不解析，给一个合法的 delta 形态。
    out({
      type: 'stream_event',
      job_id: jobId,
      slot_id: slot,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pong from fake cli' } },
    })
    out({
      type: 'job_done',
      job_id: jobId,
      slot_id: slot,
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 11 },
      headers: {},
    })
    return
  }

  if (frame.type === 'ping') {
    out({ type: 'pong', nonce: frame.nonce })
    return
  }

  if (frame.type === 'cancel') {
    out({ type: 'cancel_ack', job_id: jobId, slot_id: slot })
  }
  // 其余类型静默丢弃（协议规定）
})

function shutdown() {
  mark('exit')
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

// 兜底：无论 stdin 状态如何，都不允许活过 30s
setTimeout(shutdown, 30_000).unref()
