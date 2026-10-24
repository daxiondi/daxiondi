/**
 * 槽位调度：把并发请求分配到逻辑 slot 上，再由单个 CLI 宿主进程执行。
 *
 * 职责：选槽、占槽、释放槽，维护会话亲和（sticky pin），并把 CLI 上报的
 * 帧分派给对应 job。在此之上叠加一层配额门禁：上游的 5h / 7d 用量窗口
 * 接近上限时，先降速、再熔断，避免被连续 429 打到上游降权。
 *
 * 关键约束：
 * 1. slot 上限是 20（与官方子任务并发上限一致），超限直接拒绝构造。
 * 2. 选槽优先级固定：resume 命中同 session 的等待槽 → idle 且 model 匹配
 *    → idle 且未绑定 model → 任意 idle。顺序影响命中缓存与复用率。
 * 3. 会话亲和（pin）有效期为 24 小时；过期的 pin 在下次提交时清理。
 * 4. CLI 启动失败不抛错：降级成无 CLI 模式继续上报健康状态
 *    （healthy 仍为 true，ready_slots 会反映真实空闲数）。
 *    这是有意的——CLI 挂掉不该让整个 worker 被判死，控制面仍需要能读到
 *    凭据状态与最近错误。
 * 5. 本实现用「单宿主 + N 个逻辑 slot」，而官方内核是预开 20 个 CLI 实例。
 *    语义等价、进程数少，适合作为自研实现的起点。
 * 6. 配额门禁是旁路。它只影响「这次能不能派活」，不改 slot 相位：
 *    被配额挡下的请求不进任何槽，槽表与 frame 协议完全不受影响。
 *    配额数据缺失时一律放行——从没收到过配额头不该让服务停摆。
 */

import { randomUUID } from 'node:crypto'
import { CliHost, slotId } from './frames.mjs'
import { QuotaStore } from './quota-store.mjs'
import { QUOTA_WINDOW_KEYS, accountGate, parseQuotaHeaders, pickSoonestReset } from './quota-window.mjs'

export const SLOT_CAP = 20

/** WARN 日志里按这个顺序列窗口读数。 */
const QUOTA_KEYS_FOR_LOG = QUOTA_WINDOW_KEYS

/** 配额门禁的缺省结论：没有配额头时用它，语义等价于「放行」。 */
const OPEN_GATE = Object.freeze({
  allowed: true,
  level: 'ok',
  degraded: false,
  reason: 'no_data',
  resumeAt: null,
  windows: {},
  limited: [],
  warning: [],
})

/**
 * 按 model 挑槽。
 *
 *   1. resume → 同 session 且处于 waiting 的槽（续接上一轮）
 *   2. idle 且 model 精确匹配（命中已有缓存）
 *   3. idle 且未绑定 model（可接受任意模型）
 *   4. 任意 idle
 *
 * model 为空串时跳过第 2 条，避免把"未指定模型"当成一次精确匹配。
 * 返回下标，-1 表示无可用槽。
 */
export function pickSlotByModel(slots, { sessionId, model, resume } = {}) {
  if (resume) {
    const i = slots.findIndex((s) => s.sessionId === sessionId && s.phase === 'waiting')
    if (i >= 0) return i
  }
  let i = slots.findIndex((s) => s.phase === 'idle' && s.model === model && model !== '')
  if (i >= 0) return i
  i = slots.findIndex((s) => s.phase === 'idle' && !s.model)
  if (i >= 0) return i
  return slots.findIndex((s) => s.phase === 'idle')
}

/** 并发上限归一化：非法值/非正数落到 SLOT_CAP，合法值夹在 [1, SLOT_CAP] */
export function clampMaxProcs(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return SLOT_CAP
  return Math.min(SLOT_CAP, Math.max(1, Math.floor(n)))
}

/**
 * 内核侧调度器：一个 CLI 宿主进程承载 N 个逻辑 slot，通过帧协议驱动。
 *
 * slot 只有三个相位：idle / running / cancelling。
 * jobs 记录在途请求（jobId → 槽与回调），pins 记录会话亲和。
 */
export class SlotScheduler {
  constructor({ claudeBin, slots = SLOT_CAP, env = process.env, onEvent, quotaStore = null, quota = {}, disableCli = false }) {
    if (slots > SLOT_CAP) {
      // 错误文案是配置契约，控制面按原文识别配置错误
      throw new Error('Claude official subagent cap is 20; SLOTS_PER_WORKER must be <= 20')
    }
    if (!(slots > 0)) throw new Error('slots_per_worker must be positive')
    this.slotCount = slots
    this.slots = Array.from({ length: slots }, (_, i) => ({
      id: slotId(i),
      index: i,
      phase: 'idle', // idle | running | cancelling
      model: '',
      sessionId: '',
      jobId: null,
      startedAt: null,
    }))
    this.jobs = new Map() // jobId -> { slotId, startedAt, onEvent }
    this.pins = new Map() // sessionId -> { slotId, at }
    this.pinTtlMs = 24 * 3600 * 1000
    this.onEvent = onEvent
    // disableCli：纯 Codex 部署不该 spawn claude。
    // 没有 CLI 时槽位逻辑仍在（用于统计），但 start() 不拉进程，
    // cliError 保持 null，health 便不会因为 "claude 不存在" 而报未就绪。
    this.disableCli = disableCli === true
    this.host = new CliHost({
      bin: claudeBin,
      env,
      slots,
      disableCli: this.disableCli,
      onFrame: (frame) => this._handleFrame(frame),
    })
    this.readyInfo = null

    // ── 配额门禁 ──
    // 外部可注入共享 store（多 worker 共用一个账号池时），缺省按本实例自建。
    // 传入 null 且 quota.enabled === false 时完全关闭门禁，行为回到旧版。
    this.quotaEnabled = quota?.enabled !== false
    this.quotaStore =
      quotaStore ||
      new QuotaStore({
        warnPct: quota?.warnPct,
        stopPct: quota?.stopPct,
        enabled: this.quotaEnabled,
        now: quota?.now,
      })
    // 最近一次被配额拦下的信息，供 /status 与上层日志读取
    this.lastQuotaBlock = null
    this.quotaWarnedAt = new Map() // accountId -> 上次打 WARN 的时间，避免刷屏
  }

  /**
   * 账号标识。
   *
   * 本调度器的粒度是「本实例 = 一个上游账号」，因此缺省用固定的 self 键。
   * 多账号部署时调用方通过 setAccountId 覆盖；配额门禁只认这一个键，
   * 不会跨账号混算。
   */
  get accountId() {
    return this._accountId || 'self'
  }

  setAccountId(accountId) {
    this._accountId = String(accountId == null ? '' : accountId) || 'self'
    return this.accountId
  }

  /**
   * 启动 CLI 宿主。
   *
   * CLI 缺失或提前退出不抛错——错误记在 this.cliError 上，宿主置空，
   * 服务继续对外提供健康检查与错误上报。调用方通过 cliError 判断
   * 当前是否处于无 CLI 的降级状态。
   */
  async start() {
    try {
      this.readyInfo = await this.host.start()
      this.cliError = null
    } catch (error) {
      this.cliError = error
      this.readyInfo = null
      console.error(`[kernel] cli host unavailable: ${error.message}`)
    }
    return this.readyInfo
  }

  /**
   * 帧分派：
   *   stream_event → 交给对应 job 的 onEvent，不走全局 onEvent；
   *   终态帧（job_done / job_error / cancel_ack）→ 释放槽、清 job、resolve；
   *   其余（host_ready / slot_ready / pong / unknown）→ 走全局 onEvent。
   */
  /**
   * 帧分派：
   *   stream_event → 交给对应 job 的 onEvent，不走全局 onEvent；
   *   终态帧（job_done / job_error / cancel_ack）→ 释放槽、清 job、resolve，
   *     并顺路记录配额（见下方 _observeQuota）；
   *   其余（host_ready / slot_ready / pong / unknown）→ 走全局 onEvent。
   */
  _handleFrame({ kind, payload }) {
    if (kind === 'stream_event') {
      this.jobs.get(payload.jobId)?.onEvent?.(payload.event)
      return
    }
    if (kind === 'job_done' || kind === 'job_error' || kind === 'cancel_ack') {
      const job = this.jobs.get(payload.jobId)
      this._observeQuota(kind, payload)
      this._release(payload.slotId)
      this.jobs.delete(payload.jobId)
      job?.resolve?.({ kind, payload })
      return
    }
    this.onEvent?.({ kind, payload })
  }

  /**
   * 从终态帧里提取配额信号。
   *
   * 这是门禁的闭环点：CLI 宿主把上游响应头放在 job_done.headers 里，
   * 429 则放在 job_error 的 status / retry_after 上。两处都读，
   * 因此不需要 server.mjs 参与就能持续更新窗口读数。
   *
   * 顺序讲究：先按 headers 记录（信息最全），headers 里没有配额信息时
   * 才用 429 + retryAfter 兜底。反过来会让兜底的 100% 覆盖真实读数。
   */
  _observeQuota(kind, payload) {
    if (!this.quotaEnabled || !this.quotaStore) return
    try {
      if (kind === 'job_done') {
        this.recordUsage(this.accountId, payload?.headers)
        return
      }
      if (kind !== 'job_error') return
      if (this.recordUsage(this.accountId, payload?.headers)) return
      // 上游 429 只给 Retry-After：按本地状态压到熔断，等 retryAfter 到点恢复
      if (Number(payload?.status) === 429) {
        const secs = Number(payload?.retryAfter)
        if (Number.isFinite(secs) && secs > 0) {
          this.markRateLimited({ resetAt: this._now() + secs * 1000 })
        }
      }
    } catch (error) {
      // 旁路：记录失败不影响 job 的终态投递
      console.error(`[kernel] quota observe failed: ${error.message}`)
    }
  }

  /** 释放槽：回到 idle，清掉 job 绑定。保留 model 与 sessionId 供下次复用。 */
  _release(slotIdValue) {
    const slot = this.slots.find((s) => s.id === slotIdValue)
    if (!slot) return
    slot.phase = 'idle'
    slot.jobId = null
    slot.startedAt = null
  }

  pruneExpired(now = Date.now()) {
    for (const [key, pin] of this.pins) if (now - pin.at > this.pinTtlMs) this.pins.delete(key)
  }

  /**
   * 提交一个 job，返回 Promise，流式事件走 onEvent。
   *
   * 选槽时优先用会话已 pin 的槽（前提是它当前 idle），否则退到
   * pickSlotByModel。没有可用槽返回 null，由上层回 503 / kernel_unavailable。
   *
   * 配额门禁在选槽之前：被挡下时同样返回带 quota 字段的对象而不是 null，
   * 上层能据此区分「没槽」和「没额度」，回不同的错误给调用方。
   *
   * 占槽与登记 job 同步完成：先把 slot 置 running 再写帧，避免
   * 帧回来得快于状态更新造成重复分配。
   */
  submit({ sessionId, model, request, requestContext, onEvent }) {
    this.pruneExpired()

    const gate = this.quotaGate()
    if (!gate.allowed) {
      this.lastQuotaBlock = {
        at: Date.now(),
        reason: gate.reason,
        resumeAt: gate.resumeAt,
      }
      return { jobId: null, slot: null, done: null, quota: gate, blocked: true }
    }
    if (gate.degraded) this._warnQuota(gate)

    const pinned = this.pins.get(sessionId)
    let slot = pinned ? this.slots.find((s) => s.id === pinned.slotId && s.phase === 'idle') : null
    if (!slot) {
      const idx = pickSlotByModel(this.slots, { sessionId, model })
      slot = idx >= 0 ? this.slots[idx] : null
    }
    if (!slot) return null // 上层回 503 / kernel_unavailable

    const jobId = randomUUID()
    slot.phase = 'running'
    slot.jobId = jobId
    slot.model = model || slot.model
    slot.sessionId = sessionId
    slot.startedAt = Date.now()
    this.pins.set(sessionId, { slotId: slot.id, at: Date.now() })

    const done = new Promise((resolve) => {
      this.jobs.set(jobId, { slotId: slot.id, startedAt: Date.now(), onEvent, resolve })
    })
    this.host.startJob({ slot: slot.id, jobId, request, requestContext })
    return { jobId, slot: slot.id, done, quota: gate, blocked: false, degraded: gate.degraded }
  }

  /**
   * 配额门禁查询。关闭门禁或 store 不可用时一律放行。
   *
   * 返回结构与 accountGate 一致，额外带 accountId / enabled。
   */
  quotaGate(accountId) {
    const id = accountId || this.accountId
    if (!this.quotaEnabled || !this.quotaStore) {
      return { ...OPEN_GATE, accountId: id, enabled: false }
    }
    try {
      return this.quotaStore.gate(id)
    } catch (error) {
      // 配额是旁路信号：存储异常不该让请求路径失败，退化成放行并记一条日志
      console.error(`[kernel] quota gate unavailable: ${error.message}`)
      return { ...OPEN_GATE, accountId: id, enabled: this.quotaEnabled, error: error.message }
    }
  }

  /**
   * 记录一次上游响应的配额头。
   *
   * 调用时机：每次拿到上游响应（含 200 / 429 / 流式首包）之后立即调用。
   * 429 是配额信息最准的来源之一，不要只在成功路径上记。
   *
   * 返回本次是否真的写入，false 表示该响应没有配额信息。
   */
  recordUsage(accountId, headers) {
    if (!this.quotaEnabled || !this.quotaStore) return false
    const id = accountId || this.accountId
    try {
      return this.quotaStore.recordHeaders(id, headers)
    } catch (error) {
      console.error(`[kernel] quota record failed: ${error.message}`)
      return false
    }
  }

  /** 时钟入口：配额相关的判定统一走 store 的时钟，便于测试注入。 */
  _now() {
    const now = this.quotaStore?.now
    return typeof now === 'function' ? now() : Date.now()
  }

  /**
   * 被限流时直接按响应头/错误文案标记该账号。
   *
   * 上游 429 有时只给 Retry-After 不给配额头；这种情况下把账号临时压到
   * 熔断档，等 resumeAt 到点再自动恢复。用 status=rejected 表达，
   * 避免伪造 utilization 读数（那会让面板显示假的百分比）。
   */
  markRateLimited({ accountId, resetAt = null, headers = null } = {}) {
    if (!this.quotaEnabled || !this.quotaStore) return false
    const id = accountId || this.accountId
    if (headers && this.recordUsage(id, headers)) return true
    const at = resetAt == null ? null : Number(resetAt)
    if (!Number.isFinite(at) || at <= 0) return false
    const window = {
      key: '5h',
      usedPct: 100,
      resetAt: at,
      windowMinutes: 300,
      status: 'rejected',
      source: 'local',
      at: this._now(),
      stale: false,
    }
    return this.quotaStore.recordWindow(id, '5h', window)
  }

  /** 预警日志限流：同一账号 60 秒内只打一条，避免高并发时刷屏。 */
  _warnQuota(gate) {
    const id = gate.accountId || this.accountId
    const now = Date.now()
    const last = this.quotaWarnedAt.get(id) || 0
    if (now - last < 60_000) return
    this.quotaWarnedAt.set(id, now)
    const detail = QUOTA_KEYS_FOR_LOG
      .map((key) => {
        const w = gate.windows?.[key]
        if (!w) return null
        return `${key}=${w.usedPct}%${w.resetInSecs != null ? `(reset in ${w.resetInSecs}s)` : ''}`
      })
      .filter(Boolean)
      .join(' ')
    console.warn(`[kernel] quota warning account=${id} ${detail} reason=${gate.reason}`)
  }

  /** 配额快照，供 /status 使用。关闭门禁时返回 enabled=false 的空结构。 */
  quotaSnapshot() {
    if (!this.quotaStore) return { enabled: false, warn_pct: null, stop_pct: null, accounts: [] }
    return this.quotaStore.snapshot()
  }

  /**
   * 取消一个 job。
   * 只有 running 的槽会切到 cancelling；取消本身是异步的，
   * 真正的终态由之后的 cancel_ack 帧推动。
   */
  cancel(jobId) {
    const job = this.jobs.get(jobId)
    if (!job) return false
    const slot = this.slots.find((s) => s.id === job.slotId)
    if (slot?.phase === 'running') slot.phase = 'cancelling'
    this.host.cancel({ slot: job.slotId, jobId })
    return true
  }

  forgetSession(sessionId) {
    this.pins.delete(sessionId)
  }

  /**
   * 在一组账号里挑一个可用的。
   *
   * 语义：
   *   - 任一账号放行 → 取第一个放行的，degraded 反映它是否处于预警区
   *   - 全部熔断 → 不返回账号，返回最接近重置的那个的 resumeAt，
   *     调用方据此告诉客户端「什么时候再来」
   *
   * 返回 `{ accountId, allowed, degraded, resumeAt, gate }`，
   * 全部熔断时 accountId 为 null。
   */
  selectAccount(accountIds = this.quotaStore?.accountIds || []) {
    const candidates = []
    for (const id of accountIds) {
      const gate = this.quotaGate(id)
      if (gate.allowed) return { accountId: id, allowed: true, degraded: gate.degraded === true, resumeAt: null, gate }
      candidates.push({ accountId: id, resumeAt: gate.resumeAt ?? null, gate })
    }
    const soonest = pickSoonestReset(candidates)
    return {
      accountId: null,
      allowed: false,
      degraded: true,
      resumeAt: soonest?.resumeAt ?? null,
      gate: soonest?.gate ?? { ...OPEN_GATE, allowed: false, reason: 'all_limited' },
      candidate: soonest?.accountId ?? null,
    }
  }

  get readySlots() {
    return this.slots.filter((s) => s.phase === 'idle').length
  }

  get closedSlots() {
    return this.slots.filter((s) => s.phase !== 'idle').length
  }

  get cliPid() {
    return this.host.child?.pid ?? null
  }

  stopAll() {
    this.host.stop()
  }
}
