/**
 * 舰队编排：把 N 个槽位当成一批任务来跑，而不是 N 次串行执行。
 *
 * 职责：
 *   - 滚动启动 / 停止 / 状态汇总 / 单槽修复
 *   - 并发受控（默认同时 4 个）
 *   - 单槽失败不影响其他槽位
 *
 * 为什么必须并发：每个槽位的启动耗时主要花在等 docker network create
 * 与容器启动上（秒级），而不是 CPU。串行 20 个槽位会让总时长线性叠加到
 * 分钟级；并发 4 路能把墙钟时间压到 1/3 左右，同时不会把 docker daemon
 * 或 xtables lock 打到争用。
 *
 * 为什么必须隔离失败：一个槽位的代理挂了不该让另外 19 个不起。
 * 每个槽位有自己的执行器视图、自己的编排器、自己的错误对象，
 * 汇总层只负责把结果收集起来。
 *
 * 并发实现用 worker pool（固定 N 个 worker 从队列取任务），
 * 不用「分批 Promise.all」：分批会让一批里最慢的那个决定整批的节奏，
 * 20 个槽位里只要有一个卡到超时，后面所有批次都一起等它。
 */

import { nullLogger } from './executor.mjs'
import { SlotOrchestrator } from './orchestrator.mjs'

/**
 * 受控并发执行器。
 *
 * @param {Array} items      待处理项
 * @param {number} concurrency 最大并发（>=1）
 * @param {Function} worker  async (item, index) => result
 * @param {object} [hooks]   { onStart, onDone, onError }
 * @returns {Promise<{results:Array, stats:object}>}
 */
export async function runPool(items, concurrency, worker, hooks = {}) {
  const list = Array.isArray(items) ? items : []
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1))
  const results = new Array(list.length)
  let cursor = 0
  let active = 0
  let peak = 0

  const runOne = async (index) => {
    const item = list[index]
    active += 1
    peak = Math.max(peak, active)
    hooks.onStart?.(item, index, active)
    try {
      const result = await worker(item, index)
      results[index] = result
      hooks.onDone?.(item, index, result, active)
      return result
    } catch (error) {
      const wrapped = { ok: false, error: String(error?.message || error), thrown: true }
      results[index] = wrapped
      hooks.onError?.(item, index, error, active)
      return wrapped
    } finally {
      active -= 1
    }
  }

  const worker_ = async () => {
    while (cursor < list.length) {
      const index = cursor
      cursor += 1
      await runOne(index)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker_()))

  return {
    results,
    stats: {
      total: list.length,
      concurrency: limit,
      peak,
      completed: results.filter(Boolean).length,
    },
  }
}

/** 统计一组启动报告。 */
export function summarize(reports) {
  const list = (Array.isArray(reports) ? reports : []).filter(Boolean)
  const started = list.filter((r) => r.ok)
  const failed = list.filter((r) => !r.ok)
  return {
    total: list.length,
    started: started.length,
    failed: failed.length,
    ok: failed.length === 0 && list.length > 0,
    failures: failed.map((r) => ({
      slotId: r.slotId || '',
      error: r.error || '未知错误',
      failedStep: (r.steps || []).find((s) => !s.ok)?.name || '',
      rolledBack: (r.rolledBack || []).length,
    })),
    slots: list.map((r) => ({
      slotId: r.slotId || '',
      ok: Boolean(r.ok),
      steps: (r.steps || []).length,
      elapsedMs: (r.steps || []).reduce((n, s) => n + (s.elapsedMs || 0), 0),
    })),
  }
}

/**
 * 舰队运行时。
 */
export class FleetRuntime {
  /**
   * @param {object} opts
   * @param {object} opts.executor              共享 Executor（dryRun 与 logger 由它统一）
   * @param {object} opts.fleetPlan             buildFleetBlueprint() 的结果（含 slots）
   * @param {Array}  [opts.proxyPool]           代理数组；缺省按 blueprint 里的 proxy 视图
   * @param {number} [opts.concurrency=4]
   * @param {object} [opts.logger]
   * @param {object} [opts.orchestratorOptions] 透传给每个 SlotOrchestrator（image / dirs / verify 开关等）
   * @param {Function} [opts.orchestratorFactory] 替换编排器构造（测试用）
   */
  constructor({
    executor,
    fleetPlan,
    proxyPool = null,
    concurrency = 4,
    logger = nullLogger,
    orchestratorOptions = {},
    orchestratorFactory = null,
  } = {}) {
    if (!executor) throw new Error('FleetRuntime 需要注入 executor')
    if (!fleetPlan) throw new Error('FleetRuntime 需要 fleetPlan')
    this.executor = executor
    this.plan = fleetPlan
    this.logger = logger || nullLogger
    this.concurrency = Math.max(1, Number(concurrency) || 4)
    this.orchestratorOptions = orchestratorOptions
    this.orchestratorFactory = orchestratorFactory
    this.dryRun = Boolean(executor.dryRun)
    this.proxyBySlot = this.buildProxyMap(fleetPlan, proxyPool)
    /** 顺序分配用的池（保持调用方给的顺序，只取启用的）。 */
    this.proxyPoolList = (Array.isArray(proxyPool) ? proxyPool : []).filter((p) => p && p.enabled !== false)
    this.reports = new Map()
    this.orchestrators = new Map()
  }

  /**
   * 建代理索引：id → 完整代理（含凭据）。
   *
   * 蓝图里的 proxy 是**剥离了密码的视图**（只有 has_auth 布尔位），而 redsocks
   * 配置需要明文密码才能认证。所以真正部署时凭据只能来自调用方传入的
   * proxyPool。两者按 id 对齐；蓝图负责「哪个槽位用哪条」，池负责「那条代理的凭据」。
   */
  buildProxyMap(fleetPlan, proxyPool) {
    const map = new Map()
    if (Array.isArray(proxyPool) && proxyPool.length) {
      for (const p of proxyPool) if (p?.id) map.set(`proxy:${p.id}`, p)
    }
    return map
  }

  /**
   * 该槽位应绑定的代理。
   *
   * 三种情形：
   *   1. 蓝图已把代理绑到槽位，池里有同 id 的凭据 → 用池里的（完整）
   *   2. 蓝图已绑定但池里没有 → 用蓝图视图（无密码），打告警
   *   3. 蓝图未绑定（首次部署、或构建蓝图时还没配代理）但池里有代理
   *      → 按槽位顺序一对一取。这条分支是必须的：蓝图是可以先于凭据
   *      存在的（规划时用空池跑），启动时才拿到真池。
   */
  proxyForSlot(entry, index = -1) {
    const proxyId = entry?.proxy?.id || entry?.blueprint?.proxy?.id
    if (proxyId) {
      if (this.proxyBySlot.has(`proxy:${proxyId}`)) return this.proxyBySlot.get(`proxy:${proxyId}`)
      this.logger.warn(`槽位 ${entry?.slot?.slotId || '?'} 的代理 ${proxyId} 只有蓝图视图，缺少凭据`)
      return { ...entry.proxy, password: '', incomplete: true }
    }
    const seq = this.proxyPoolList
    const at = index >= 0 ? index : this.entries.indexOf(entry)
    if (seq.length && seq[at]) {
      this.logger.info(`槽位 ${entry?.slot?.slotId || '?'} 未在蓝图绑定代理，按顺序分配 ${seq[at].id}`)
      return seq[at]
    }

    // 演练模式：没有代理时补一个占位代理，让 8 步能走完整。
    // 这不是掩盖问题 —— 真实启动（dryRun=false）时仍然在这一步失败，
    // 而演练的目的本来就是「把编排逻辑在无凭据的规划数据上跑一遍」。
    if (this.dryRun) {
      const sid = entry?.slot?.slotId || 'slot-??'
      return {
        id: `dryrun-${sid}`,
        type: 'socks5',
        host: '0.0.0.0',
        port: 1080,
        username: '',
        password: '',
        placeholder: true,
        dryRunPlaceholder: true,
      }
    }
    return null
  }

  /** 规划里的槽位条目列表。 */
  get entries() {
    return Array.isArray(this.plan?.slots) ? this.plan.slots.filter((e) => e && e.ok !== false) : []
  }

  /** 为单个槽位建编排器（可注入替换）。 */
  createOrchestrator(entry, index = -1) {
    const slotSpec = entry.slot || entry
    const proxy = this.proxyForSlot(entry, index)
    if (this.orchestratorFactory) {
      return this.orchestratorFactory({ executor: this.executor, slotSpec, proxy, logger: this.logger.child?.(`[${slotSpec.slotId}] `) || this.logger, ...this.orchestratorOptions })
    }
    return new SlotOrchestrator({
      executor: this.executor,
      slotSpec,
      proxy,
      logger: this.logger.child ? this.logger.child(`[${slotSpec.slotId}] `) : this.logger,
      ...this.orchestratorOptions,
    })
  }

  /** 滚动启动全部槽位，并发受控。 */
  async upAll() {
    const entries = this.entries
    const startedAt = Date.now()
    this.logger.info(`舰队启动：${entries.length} 个槽位，并发 ${this.concurrency}${this.dryRun ? '（dry-run）' : ''}`)

    const { results, stats } = await runPool(
      entries,
      this.concurrency,
      async (entry, index) => {
        const slotId = entry.slot?.slotId || ''
        const orch = this.createOrchestrator(entry, index)
        this.orchestrators.set(slotId, orch)
        const report = await orch.up()
        this.reports.set(slotId, report)
        return report
      },
      {
        onStart: (entry) => this.logger.info(`▸ 启动 ${entry.slot?.slotId || '?'}`),
        onDone: (entry, _i, report) => {
          const slotId = entry.slot?.slotId || '?'
          this.logger.info(`${report?.ok ? '✓' : '✗'} ${slotId}${report?.ok ? '' : `: ${report?.error || ''}`}`)
        },
        onError: (entry, _i, error) => {
          const slotId = entry.slot?.slotId || '?'
          this.reports.set(slotId, { ok: false, slotId, error: String(error?.message || error), steps: [], rolledBack: [] })
          this.logger.error(`✗ ${slotId} 编排器异常: ${error?.message || error}`)
        },
      },
    )

    const summary = summarize(results)
    summary.elapsedMs = Date.now() - startedAt
    summary.peakConcurrency = stats.peak
    summary.dryRun = this.dryRun
    return summary
  }

  /** 全部停止。并发受控，单槽失败不阻断其他。 */
  async downAll() {
    const entries = this.entries
    this.logger.info(`舰队停止：${entries.length} 个槽位，并发 ${this.concurrency}`)
    const { results, stats } = await runPool(entries, this.concurrency, async (entry, index) => {
      const slotId = entry.slot?.slotId || ''
      const orch = this.orchestrators.get(slotId) || this.createOrchestrator(entry, index)
      const report = await orch.down()
      return { slotId, ...report }
    })
    const list = results.filter(Boolean)
    const failed = list.filter((r) => !r.ok)
    return {
      total: list.length,
      stopped: list.length - failed.length,
      failed: failed.length,
      ok: failed.length === 0,
      failures: failed.map((r) => ({ slotId: r.slotId, steps: (r.steps || []).filter((s) => !s.ok) })),
      peakConcurrency: stats.peak,
    }
  }

  /** 健康总览。 */
  async status() {
    const entries = this.entries
    const { results } = await runPool(entries, this.concurrency, async (entry, index) => {
      const slotId = entry.slot?.slotId || ''
      const orch = this.orchestrators.get(slotId) || this.createOrchestrator(entry, index)
      const st = await orch.status()
      return { ...st, slotId: st.slotId || slotId }
    })
    const list = results.filter(Boolean)
    const healthy = list.filter((r) => r.healthy)
    const degraded = list.filter((r) => !r.healthy)
    return {
      total: list.length,
      healthy: healthy.length,
      degraded: degraded.length,
      ok: degraded.length === 0 && list.length > 0,
      slots: list,
      unhealthy: degraded.map((r) => ({
        slotId: r.slotId,
        network: r.network?.exists === true,
        iptables: r.iptables?.present === true,
        container: r.containerState?.running === true,
        redsocks: r.redsocks?.listening,
        dnsfwd: r.dnsfwd?.listening,
      })),
    }
  }

  /**
   * 单槽修复：先 down 再 up。
   *
   * 之所以不尝试「只补缺失的那一步」：一个槽位的状态机只有七个资源，
   * 逐个判别再补齐的逻辑比整体重建更难验证，而且中间态（比如规则在、
   * 网桥不在）本身就是异常。整体重建的代价是几秒，换来的是确定性。
   */
  async repair(slotId) {
    const index = this.entries.findIndex((e) => (e.slot?.slotId || e.slotId) === slotId)
    const entry = index >= 0 ? this.entries[index] : null
    if (!entry) {
      return { ok: false, slotId, error: `未知槽位: ${slotId}（规划内共 ${this.entries.length} 个）` }
    }
    const orch = this.orchestrators.get(slotId) || this.createOrchestrator(entry, index)
    this.orchestrators.set(slotId, orch)
    this.logger.info(`修复 ${slotId}：先清理再启动`)
    const down = await orch.down()
    const up = await orch.up()
    this.reports.set(slotId, up)
    return {
      ok: up.ok,
      slotId,
      down: { ok: down.ok, steps: down.steps.length },
      up,
      error: up.ok ? null : up.error,
    }
  }

  /** 内部已收集的启动报告（不重新探测）。 */
  report() {
    return summarize([...this.reports.values()])
  }

  /** 计划视图：dry-run 时不执行，只打印将要做的事。 */
  preview() {
    return this.entries.map((entry, index) => {
      const orch = this.orchestratorFactory
        ? this.createOrchestrator(entry, index)
        : new SlotOrchestrator({
            executor: this.executor,
            slotSpec: entry.slot || entry,
            proxy: this.proxyForSlot(entry, index),
            logger: nullLogger,
            ...this.orchestratorOptions,
          })
      return { slotId: entry.slot?.slotId || entry.slotId || '', steps: orch.plan() }
    })
  }
}

export default FleetRuntime
