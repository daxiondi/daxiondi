/**
 * Codex 账号调度器测试。
 *
 * 时钟通过构造参数注入，所有时间推进都是显式的，测试之间不共享状态，
 * 因此重复运行结果一致。
 *
 * 覆盖范围：RPM 滑窗、并发上限、冷却边界、亲和的三段选择顺序、
 * setAccounts 的清理副作用、snapshot 字段完整性与只读性。
 *
 * 运行：node test/codex-scheduler.mjs
 */

import {
  AccountScheduler,
  DEFAULT_COOLDOWN_SECS,
  OVERLOAD_COOLDOWN_SECS,
  RATE_LIMIT_COOLDOWN_SECS,
  RPM_WINDOW_SECS,
  normalizeAccount,
} from '../src/codex.mjs'

// ─────────────── 断言器 ───────────────

let pass = 0
let fail = 0

function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass += 1
    console.log('  ok   ', name)
  } else {
    fail += 1
    console.log('  FAIL ', name, '\n         got ', g, '\n         want', w)
  }
}

/** 可推进的假时钟 */
function makeClock(start = 1_700_000_000_000) {
  const c = { t: start }
  return {
    now: () => c.t,
    advance: (ms) => { c.t += ms },
    set: (ms) => { c.t = ms },
  }
}

/** 断言 select 抛错并返回错误码 */
function selectError(sch, keys = {}) {
  try {
    sch.select(keys)
    return null
  } catch (e) {
    return e
  }
}

// ─────────────── 1. 构造与基础校验 ───────────────

console.log('\n[1] 构造与基础校验')

eq('默认冷却 30 秒', DEFAULT_COOLDOWN_SECS, 30)
eq('429 冷却 60 秒', RATE_LIMIT_COOLDOWN_SECS, 60)
eq('RPM 滑窗 60 秒', RPM_WINDOW_SECS, 60)

{
  let threw = false
  try { new AccountScheduler([]) } catch { threw = true }
  eq('空账号列表构造报错', threw, true)

  threw = false
  try { new AccountScheduler(null) } catch { threw = true }
  eq('非数组构造报错', threw, true)
}

{
  const clock = makeClock()
  const accounts = [{ id: 'a1', access_token: 'T' }]
  const sch = new AccountScheduler(accounts, { now: clock.now })
  // 构造时深拷贝：外部改动原数组不影响调度器
  accounts[0].id = 'MUTATED'
  eq('账号被拷贝而非引用', sch.accounts[0].id, 'a1')
}

// ─────────────── 2. RPM 滑窗 ───────────────

console.log('\n[2] RPM 滑窗')

{
  // rpm=2：连续选择三次，第三次必须被拒
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1', rpm: 2 }], { now: clock.now })

  const first = sch.select({})
  eq('第一次选择成功', first.account.id, 'a1')
  sch.release('a1')

  const second = sch.select({})
  eq('第二次选择成功', second.account.id, 'a1')
  sch.release('a1')

  const err = selectError(sch, {})
  eq('第三次被 RPM 拒绝', err?.code, 'all_rejected')
  eq('RPM 用满后 canTake 为 false', sch.canTake({ id: 'a1', rpm: 2 }), false)
}

{
  // 滑窗过一分钟后配额恢复
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1', rpm: 2 }], { now: clock.now })
  sch.select({}); sch.release('a1')
  sch.select({}); sch.release('a1')

  clock.advance(59_000)
  eq('59 秒时仍被拒', selectError(sch, {})?.code, 'all_rejected')

  clock.advance(1_000)
  // 此时 t - 60000 正好等于最早样本时间，样本用 > cutoff 过滤，等于的会被剔除
  const after = sch.select({})
  eq('整 60 秒后样本过期', after.account.id, 'a1')
  sch.release('a1')
}

{
  // 滑窗只算最近一分钟：老样本不会一直压着
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1', rpm: 1 }], { now: clock.now })
  sch.select({}); sch.release('a1')
  eq('rpm=1 用满即拒', selectError(sch, {})?.code, 'all_rejected')

  clock.advance(RPM_WINDOW_SECS * 1000 + 1)
  const ok = sch.select({})
  eq('滑窗清空后恢复', ok.account.id, 'a1')
  sch.release('a1')
}

{
  // rpm 未设置或为 0 视为不限
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a0', rpm: 0 }, { id: 'an' }], { now: clock.now })
  for (let i = 0; i < 50; i += 1) {
    const p = sch.select({ threadId: `th_${i}` })
    sch.release(p.account.id)
  }
  eq('rpm=0 不限制选择', sch.canTake({ id: 'a0', rpm: 0 }), true)
  eq('rpm 缺省不限制选择', sch.canTake({ id: 'an' }), true)
}

{
  // RPM 用满一个账号后自动落到下一个
  const clock = makeClock()
  const sch = new AccountScheduler(
    [{ id: 'a1', rpm: 1 }, { id: 'a2', rpm: 1 }],
    { now: clock.now },
  )
  const p1 = sch.select({})
  eq('RPM 满前一账号先被选', p1.account.id, 'a1')
  sch.release('a1')

  const p2 = sch.select({})
  eq('a1 满后落到 a2', p2.account.id, 'a2')
  sch.release('a2')

  eq('两个都满后无可选', selectError(sch, {})?.code, 'all_rejected')
}

// ─────────────── 3. 并发上限 ───────────────

console.log('\n[3] 并发上限')

{
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1', max_concurrency: 1 }], { now: clock.now })
  const p = sch.select({})
  eq('首个请求占坑', sch.inflight.get('a1'), 1)
  eq('满并发时拒绝', selectError(sch, {})?.code, 'all_rejected')
  sch.release(p.account.id)
  eq('释放后可再选', sch.select({}).account.id, 'a1')
}

{
  // 亲和命中也要占坑，不能绕过并发上限
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1', max_concurrency: 1 }], { now: clock.now })
  const p1 = sch.select({ sessionId: 's1' })
  sch.commitSuccess({ sessionId: 's1', accountId: p1.account.id })
  eq('亲和已建立', sch.sessionAffinity.get('s1'), 'a1')

  const err = selectError(sch, { sessionId: 's1' })
  eq('亲和命中仍受并发限制', err?.code, 'all_rejected')
}

{
  // 未设置并发上限时视为不限
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.select({})
  sch.select({})
  eq('无上限时可重复占坑', sch.inflight.get('a1'), 2)
  eq('无上限时仍可选', sch.select({}).account.id, 'a1')
}

// ─────────────── 4. 冷却边界 ───────────────

console.log('\n[4] 冷却边界')

{
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  eq('普通状态冷却 30 秒', sch.markCooldown('a1', { status: 500 }), 30)
  eq('429 冷却 60 秒', sch.markCooldown('a1', { status: 429 }), 60)
  eq('显式 retryAfter 优先', sch.markCooldown('a1', { status: 429, retryAfter: 42 }), 42)
  eq('retryAfter 小数向下取整', sch.markCooldown('a1', { retryAfter: 42.9 }), 42)
  eq('retryAfter 为 0 时回落默认', sch.markCooldown('a1', { status: 500, retryAfter: 0 }), 30)
  eq('retryAfter 为负时回落默认', sch.markCooldown('a1', { status: 429, retryAfter: -5 }), 60)
  eq('retryAfter 为 NaN 时回落默认', sch.markCooldown('a1', { status: 429, retryAfter: NaN }), 60)
}

{
  // 冷却截止时间按秒换算成毫秒
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  const start = clock.now()
  sch.markCooldown('a1', { retryAfter: 42 })
  eq('冷却截止时间正确', sch.cooldownUntil.get('a1') - start, 42_000)
}

{
  // 刚过 1 秒还在冷却
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.markCooldown('a1', { retryAfter: 10 })

  clock.advance(9_000)
  eq('差 1 秒仍在冷却', selectError(sch, {})?.code, 'all_rejected')
  eq('差 1 秒剩余冷却为 1', sch.snapshot().accounts[0].cooldown_secs_left, 1)

  clock.advance(1_000)
  eq('刚好到点即可选', sch.select({}).account.id, 'a1')
  eq('到点后剩余冷却归零', sch.snapshot().accounts[0].cooldown_secs_left, 0)
}

{
  // 冷却期非常短时也要至少 1 秒，否则等于空操作
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  eq('小数秒向下取整后抬到 1 秒', sch.markCooldown('a1', { retryAfter: 0.4 }), 1)
  eq('1 秒冷却保持 1', sch.markCooldown('a1', { retryAfter: 1 }), 1)
  eq('1 秒冷却立即生效', selectError(sch, {})?.code, 'all_rejected')
  clock.advance(1_000)
  eq('1 秒后解除', sch.select({}).account.id, 'a1')
}

{
  // 已冷却的账号再标记：以最后一次为准，可延长也可缩短
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.markCooldown('a1', { retryAfter: 60 })
  clock.advance(10_000)
  sch.markCooldown('a1', { retryAfter: 5 })
  eq('再次标记覆盖截止时间', sch.cooldownUntil.get('a1') - clock.now(), 5_000)
  clock.advance(5_000)
  eq('覆盖后按新时间解除', sch.select({}).account.id, 'a1')
}

// ─────────────── 5. 选择顺序与负载分散 ───────────────

console.log('\n[5] 选择顺序与负载分散')

{
  // 不涉及并发上限时，扫描总是选第一个可用账号
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], { now: clock.now })
  const picks = []
  for (let i = 0; i < 5; i += 1) {
    const p = sch.select({})
    picks.push(p.account.id)
    sch.release(p.account.id)
  }
  eq('无并发上限时始终选首个', picks.join(','), 'a1,a1,a1,a1,a1')
  eq('扫描路径标记为 scan', sch.select({}).via, 'scan')
}

{
  // 首个账号满并发后按声明顺序落到下一个
  const clock = makeClock()
  const sch = new AccountScheduler(
    [{ id: 'a1', max_concurrency: 1 }, { id: 'a2', max_concurrency: 1 }, { id: 'a3', max_concurrency: 1 }],
    { now: clock.now },
  )
  const p1 = sch.select({})
  eq('第一个占坑', p1.account.id, 'a1')
  const p2 = sch.select({})
  eq('第二个按顺序接管', p2.account.id, 'a2')
  const p3 = sch.select({})
  eq('第三个按顺序接管', p3.account.id, 'a3')
  eq('三个都满后拒绝', selectError(sch, {})?.code, 'all_rejected')

  sch.release('a2')
  eq('中间账号释放后重新可选', sch.select({}).account.id, 'a2')
}

{
  // 亲和优先于扫描
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }, { id: 'a2' }], { now: clock.now })
  const p = sch.select({ sessionId: 's1' }) // 落 a1
  eq('首次走扫描', p.via, 'scan')
  sch.release('a1')
  sch.commitSuccess({ sessionId: 's1', accountId: 'a2' })
  const q = sch.select({ sessionId: 's1' })
  eq('亲和命中优先', q.via, 'session')
  eq('亲和指向已提交的账号', q.account.id, 'a2')
  sch.release('a2')
}

{
  // 线程亲和：会话亲和缺失时生效
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }, { id: 'a2' }], { now: clock.now })
  const p = sch.select({ threadId: 'th1' })
  sch.release(p.account.id)
  sch.commitSuccess({ threadId: 'th1', accountId: 'a2' })
  const q = sch.select({ threadId: 'th1' })
  eq('线程亲和命中', q.via, 'thread')
  eq('线程亲和账号正确', q.account.id, 'a2')
  sch.release('a2')
}

{
  // 会话亲和优先于线程亲和
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], { now: clock.now })
  sch.sessionAffinity.set('s1', 'a2')
  sch.threadAffinity.set('th1', 'a3')
  const p = sch.select({ sessionId: 's1', threadId: 'th1' })
  eq('会话亲和优先于线程亲和', p.via, 'session')
  eq('会话亲和账号胜出', p.account.id, 'a2')
  sch.release('a2')
}

{
  // 亲和账号冷却时回落到扫描，且不污染亲和
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }, { id: 'a2' }], { now: clock.now })
  sch.sessionAffinity.set('s1', 'a1')
  sch.markCooldown('a1', { retryAfter: 30 })
  const p = sch.select({ sessionId: 's1' })
  eq('亲和冷却时回落扫描', p.via, 'scan')
  eq('回落到另一个账号', p.account.id, 'a2')
  eq('回落不改写亲和', sch.sessionAffinity.get('s1'), 'a1')
  sch.release('a2')
}

{
  // 空字符串 / 纯空白 key 不建立亲和
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.select({ sessionId: '', threadId: '   ' })
  eq('空 sessionId 不建亲和', sch.sessionAffinity.size, 0)
  eq('空 threadId 不建亲和', sch.threadAffinity.size, 0)
}

{
  // 键做 trim 规范化：'s1' 与 ' s1 ' 是同一条亲和
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }, { id: 'a2' }], { now: clock.now })
  sch.sessionAffinity.set('s1', 'a2')
  const p = sch.select({ sessionId: '  s1  ' })
  eq('键两侧空白被归一', p.via, 'session')
  eq('归一到同一账号', p.account.id, 'a2')
  sch.release('a2')
}

// ─────────────── 6. commitSuccess / dropSticky ───────────────

console.log('\n[6] commitSuccess 与 dropSticky')

{
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }, { id: 'a2' }], { now: clock.now })
  sch.commitSuccess({ sessionId: 's1', accountId: 'a1' })
  eq('提交后绑定 a1', sch.sessionAffinity.get('s1'), 'a1')
  sch.commitSuccess({ sessionId: 's1', accountId: 'a2' })
  eq('再次提交迁移到 a2', sch.sessionAffinity.get('s1'), 'a2')
  eq('迁移后仅一条会话绑定', sch.sessionAffinity.size, 1)
}

{
  // 提交同一账号时不触发迁移（旧绑定保留）
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.sessionAffinity.set('s1', 'a1')
  sch.sessionCount.set('s1', 3)
  sch.commitSuccess({ sessionId: 's1', accountId: 'a1' })
  eq('同账号提交保留计数', sch.sessionCount.get('s1'), 3)
  eq('同账号提交不变', sch.sessionAffinity.get('s1'), 'a1')
}

{
  // dropSticky 同时清亲和与计数
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.select({ sessionId: 's1' })
  eq('选择后建立初始亲和', sch.sessionAffinity.get('s1'), 'a1')
  eq('选择后计数为 1', sch.sessionCount.get('s1'), 1)
  sch.dropSticky({ sessionId: 's1' })
  eq('dropSticky 清亲和', sch.sessionAffinity.has('s1'), false)
  eq('dropSticky 清计数', sch.sessionCount.has('s1'), false)
}

{
  // 未提供的 key 不会被 dropSticky 误删
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.sessionAffinity.set('s1', 'a1')
  sch.threadAffinity.set('th1', 'a1')
  sch.dropSticky({})
  eq('空参数不删会话亲和', sch.sessionAffinity.get('s1'), 'a1')
  eq('空参数不删线程亲和', sch.threadAffinity.get('th1'), 'a1')
  sch.dropSticky({ threadId: 'th1' })
  eq('按线程删除生效', sch.threadAffinity.has('th1'), false)
  eq('线程删除不影响会话', sch.sessionAffinity.get('s1'), 'a1')
}

// ─────────────── 7. setAccounts 的清理 ───────────────

console.log('\n[7] setAccounts 清理')

{
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }, { id: 'a2' }], { now: clock.now })
  sch.sessionAffinity.set('s1', 'a1')
  sch.sessionAffinity.set('s2', 'a2')
  sch.threadAffinity.set('th1', 'a1')
  sch.threadAffinity.set('th2', 'a2')
  sch.markCooldown('a1', { retryAfter: 60 })
  sch.markCooldown('a2', { retryAfter: 60 })
  sch.inflight.set('a1', 2)
  sch.inflight.set('a2', 1)

  sch.setAccounts([{ id: 'a2' }])

  eq('移除账号的会话亲和被清', sch.sessionAffinity.has('s1'), false)
  eq('保留账号的会话亲和留存', sch.sessionAffinity.get('s2'), 'a2')
  eq('移除账号的线程亲和被清', sch.threadAffinity.has('th1'), false)
  eq('保留账号的线程亲和留存', sch.threadAffinity.get('th2'), 'a2')
  eq('移除账号的冷却被清', sch.cooldownUntil.has('a1'), false)
  eq('保留账号的冷却留存', sch.cooldownUntil.has('a2'), true)
  eq('移除账号的在途计数被清', sch.inflight.has('a1'), false)
  eq('保留账号的在途计数留存', sch.inflight.get('a2'), 1)
  eq('账号列表已更新', sch.accounts.map((a) => a.id), ['a2'])
}

{
  // 移除后该 session 回落扫描到剩余账号，不会卡在失效绑定上
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }, { id: 'a2' }], { now: clock.now })
  sch.sessionAffinity.set('s1', 'a1')
  sch.setAccounts([{ id: 'a2' }])
  const p = sch.select({ sessionId: 's1' })
  eq('失效绑定不再命中亲和', p.via, 'scan')
  eq('回落到剩余账号', p.account.id, 'a2')
  sch.release('a2')
}

{
  // 全部移除后 select 抛 no_candidates
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.setAccounts([])
  eq('清空账号后 select 抛错', selectError(sch, {})?.code, 'no_candidates')
  eq('清空后账号列表为空', sch.accounts.length, 0)
}

{
  // setAccounts 重新加入账号后可正常选择
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.setAccounts([])
  sch.setAccounts([{ id: 'b1', rpm: 5 }])
  eq('重新加入后可选择', sch.select({}).account.id, 'b1')
  eq('新账号参数生效', sch.accounts[0].rpm, 5)
}

// ─────────────── 8. snapshot ───────────────

console.log('\n[8] snapshot')

{
  const clock = makeClock()
  const sch = new AccountScheduler(
    [{ id: 'a1', rpm: 10 }, { id: 'a2' }],
    { now: clock.now },
  )
  sch.select({ sessionId: 's1' })
  sch.markCooldown('a2', { retryAfter: 45 })

  const snap = sch.snapshot()
  eq('snapshot 顶层字段完整', Object.keys(snap).sort().join(','),
    'accounts,session_affinity,thread_affinity')
  eq('每个账号项字段完整', Object.keys(snap.accounts[0]).sort().join(','),
    'cooldown_secs_left,id,inflight,rpm_used')
  eq('账号顺序与列表一致', snap.accounts.map((a) => a.id), ['a1', 'a2'])
  eq('inflight 反映占坑', snap.accounts[0].inflight, 1)
  eq('rpm_used 反映已用配额', snap.accounts[0].rpm_used, 1)
  eq('冷却账号的剩余秒数', snap.accounts[1].cooldown_secs_left, 45)
  eq('未冷却账号剩余为 0', snap.accounts[0].cooldown_secs_left, 0)
  eq('会话亲和计数', snap.session_affinity, 1)
  eq('线程亲和计数', snap.thread_affinity, 0)
}

{
  // snapshot 只读：调用两次结果相同，且不消耗 RPM 配额
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1', rpm: 2 }], { now: clock.now })
  sch.select({})
  sch.release('a1')
  const a = sch.snapshot()
  const b = sch.snapshot()
  eq('snapshot 幂等', JSON.stringify(a), JSON.stringify(b))
  // 已用 1 次 / 上限 2：snapshot 不额外记账，剩下的一次配额仍然可用
  eq('snapshot 不占用配额', sch.canTake({ id: 'a1', rpm: 2 }), true)
  const c = sch.select({})
  eq('snapshot 后仍能选到最后一个配额', c.account.id, 'a1')
  sch.release('a1')
  eq('配额用尽后拒绝', selectError(sch, {})?.code, 'all_rejected')
}

{
  // 冷却随时间推进递减，向上取整到秒
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.markCooldown('a1', { retryAfter: 10 })
  eq('冷却初始 10 秒', sch.snapshot().accounts[0].cooldown_secs_left, 10)
  clock.advance(4_500)
  eq('过了 4.5 秒剩 6 秒（向上取整）', sch.snapshot().accounts[0].cooldown_secs_left, 6)
  clock.advance(6_000)
  eq('超过截止时间不为负', sch.snapshot().accounts[0].cooldown_secs_left, 0)
}

{
  // 空账号池的 snapshot 结构仍然完整
  const clock = makeClock()
  const sch = new AccountScheduler([{ id: 'a1' }], { now: clock.now })
  sch.setAccounts([])
  const snap = sch.snapshot()
  eq('空池 accounts 为空数组', snap.accounts, [])
  eq('空池亲和计数为 0', snap.session_affinity, 0)
}


// ── 回归：过载用短冷却，不与普通故障共用 30 秒 ──
//
// 过载（server_is_overloaded）是瞬时的，429 是额度用完。
// 用同一个冷却时长会白白浪费可用额度：实测单账号连跑 6 次，
// 第 4 次碰到过载后 30 秒内全部 503，而上游早就恢复了。
{
  let now = 1_000_000
  const clock = () => now
  const sched = new AccountScheduler(
    [normalizeAccount({ id: 'a1', access_token: 't', expires_at: now + 3_600_000 })],
    { now: clock },
  )

  const overloadSecs = sched.markCooldown('a1', { status: 503, code: 'server_is_overloaded' })
  eq('过载冷却取短值', overloadSecs, OVERLOAD_COOLDOWN_SECS)
  eq('过载冷却 5 秒', overloadSecs < DEFAULT_COOLDOWN_SECS, true)

  // 5 秒后必须已经恢复
  now += OVERLOAD_COOLDOWN_SECS * 1000 + 1
  eq('过载 5 秒后账号可用', sched.canTake({ id: 'a1' }), true)

  // 普通 5xx 仍走默认 30 秒
  now += 1000
  const plainSecs = sched.markCooldown('a1', { status: 503 })
  eq('普通 5xx 仍用默认冷却', plainSecs, DEFAULT_COOLDOWN_SECS)
  now += OVERLOAD_COOLDOWN_SECS * 1000 + 1
  eq('普通 5xx 在 5 秒后仍不可用', sched.canTake({ id: 'a1' }), false)

  // 429 仍走 60 秒
  now += 60_000
  const rlSecs = sched.markCooldown('a1', { status: 429 })
  eq('429 仍用 60 秒', rlSecs, RATE_LIMIT_COOLDOWN_SECS)

  // 上游显式给 Retry-After 时优先它，压过过载短冷却
  now += 120_000
  const raSecs = sched.markCooldown('a1', { status: 503, retryAfter: 42, code: 'server_is_overloaded' })
  eq('Retry-After 优先于过载短冷却', raSecs, 42)
}


// ── 回归：server_error 也算瞬时故障，要短冷却 + 可换号 ──
//
// 实测抓到的真实形态：status=200 stream=server_error。
// 它原先既不算过载（吃 30 秒默认冷却），也不触发换号，
// 于是被报成"上游拒绝：检查请求体" —— 排查方向完全错了。
// 上游内部错误是可恢复的，应该和过载同样处理。
{
  let now = 2_000_000
  const clock = () => now
  const sched = new AccountScheduler(
    [normalizeAccount({ id: 'a1', access_token: 't', expires_at: now + 3_600_000 })],
    { now: clock },
  )
  for (const code of ['server_error', 'internal_error', 'service_unavailable', 'overloaded_error']) {
    const secs = sched.markCooldown('a1', { status: 500, code })
    eq(`${code} 走短冷却`, secs, OVERLOAD_COOLDOWN_SECS)
    now += 60_000
  }
  // 普通 5xx 仍然走默认
  const plain = sched.markCooldown('a1', { status: 500, code: 'something_else' })
  eq('未知 5xx 仍用默认冷却', plain, DEFAULT_COOLDOWN_SECS)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
