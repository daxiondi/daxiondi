#!/usr/bin/env node
/**
 * 并发刷新 demo：验证单飞（singleflight）确实把 N 个并发调用收敛成 1 次上游请求。
 *
 * 三个场景：
 *   A. 10 个并发刷新同一账号 → refreshFn 期望只被调用 1 次
 *   B. 移除单飞（每调用一个新 refresher）→ refreshFn 被调用 10 次，说明刷新
 *      有副作用时并发会重复消耗 refresh_token
 *   C. 10 个并发 + 上游故意慢 200ms → 仍然只调 1 次，且 10 个都拿到同一 token
 *
 * 用法：node scripts/token-refresh-demo.mjs
 */

import { TokenRefresher } from '../src/token-refresh.mjs'
import { CredentialStore } from '../src/credential-store.mjs'

const ACCOUNT = 'demo-account'
const CONCURRENCY = 10

function makeClock(start = Date.now()) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

/** 一份即将到期（进入 skew 窗口）的凭据 */
function expiring(id, clock) {
  return {
    id,
    access_token: 'AT-OLD',
    refresh_token: 'RT-OLD',
    expires_at_ms: clock.now() + 60_000,
    expires_at: Math.floor((clock.now() + 60_000) / 1000),
  }
}

async function freshStore(clock) {
  const store = new CredentialStore()
  await store.save(ACCOUNT, expiring(ACCOUNT, clock), 0)
  return store
}

async function scenarioA() {
  const clock = makeClock()
  const store = await freshStore(clock)
  let calls = 0

  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => {
      calls += 1
      // 模拟一次真实的上游往返
      await new Promise((r) => setTimeout(r, 50))
      return { access_token: 'AT-NEW', refresh_token: 'RT-NEW', expires_in: 3600 }
    },
  })

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => refresher.refresh(ACCOUNT)),
  )

  const tokens = new Set(results.map((r) => r.credential?.access_token))
  const generations = new Set(results.map((r) => r.generation))
  const stats = refresher.snapshot().stats

  console.log('A. 单飞生效（10 个并发刷新同一账号）')
  console.log(`   refreshFn 实际调用次数: ${calls}   ← 期望 1`)
  console.log(`   并发请求数:             ${CONCURRENCY}`)
  console.log(`   收敛比例:                ${CONCURRENCY} 次调用 → ${calls} 次上游请求`)
  console.log(`   加入在途请求数:         ${stats.joined}   ← 期望 ${CONCURRENCY - 1}`)
  console.log(`   全部拿到同一 token:     ${tokens.size === 1}  (${[...tokens].join(', ')})`)
  console.log(`   全部拿到同一 generation: ${generations.size === 1}  (${[...generations].join(', ')})`)
  console.log(`   在途表已清空:           ${refresher.snapshot().inflight === 0}`)
  return { calls, joined: stats.joined, tokens: tokens.size, generations: generations.size }
}

async function scenarioB() {
  const clock = makeClock()
  const store = await freshStore(clock)
  let calls = 0
  let rejected = 0
  let consumed = false

  // 对照组：模拟「无单飞、无锁、不重读」的朴素实现——每个并发调用各自
  // 读一份凭据（都是同一个未轮换的 refresh_token）然后直接打上游。
  // 上游在第一次成功后立刻让旧 refresh_token 失效，后续调用就会被拒。
  const refreshFn = async (credential) => {
    calls += 1
    await new Promise((r) => setTimeout(r, 20))
    // 上游只认第一次使用的 RT-OLD；之后该 refresh_token 已作废
    if (consumed) {
      const err = new Error('invalid_grant')
      err.code = 'invalid_grant'
      err.status = 400
      throw err
    }
    consumed = true
    return { access_token: 'AT-1', refresh_token: 'RT-ROTATED', expires_in: 3600 }
  }

  const snapshot = (await store.load(ACCOUNT)).credential
  const outcomes = await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    try {
      return await refreshFn(snapshot)
    } catch {
      rejected += 1
      return null
    }
  }))

  // 上游视角：第 1 次成功后旧 token 作废，剩下 9 次都用同一个旧 token
  console.log('\nB. 无单飞/无重读对照（朴素实现，模拟上游轮换）')
  console.log(`   refreshFn 实际调用次数: ${calls}   ← 期望 ${CONCURRENCY}`)
  console.log(`   被上游拒绝的次数:       ${rejected}   ← 期望 ${CONCURRENCY - 1}`)
  console.log('   说明：轮换制下第 2 次起就在用已作废的 refresh_token，全部 invalid_grant')
  return { calls, rejected }
}

async function scenarioC() {
  const clock = makeClock()
  const store = await freshStore(clock)
  let calls = 0
  let resolveGate
  const gate = new Promise((r) => { resolveGate = r })

  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => {
      calls += 1
      await gate // 故意挂住，让 10 个调用全部挤进单飞表
      return { access_token: 'AT-SLOW', refresh_token: 'RT-SLOW', expires_in: 1800 }
    },
  })

  const pending = Array.from({ length: CONCURRENCY }, () => refresher.refresh(ACCOUNT))
  await new Promise((r) => setImmediate(r))
  const callsWhileBlocked = calls
  resolveGate()
  const results = await Promise.all(pending)

  console.log('\nC. 上游阻塞期间（refreshFn 挂住不放）')
  console.log(`   阻塞期间 refreshFn 调用次数: ${callsWhileBlocked}   ← 期望 1`)
  console.log(`   解阻塞后总调用次数:         ${calls}   ← 期望 1`)
  console.log(`   10 个调用全部返回同值:      ${new Set(results.map((r) => r.credential.access_token)).size === 1}`)
  console.log(`   单飞表已清空:               ${refresher.snapshot().inflight === 0}`)

  // 补充：清理正确 → 下一个新请求可以真正发起
  clock.advance(1_800_000)
  const next = await refresher.refresh(ACCOUNT)
  console.log(`   清理正确（新请求能重新发起）: ${next.status === 'refreshed' && calls === 2}`)
  return { callsWhileBlocked, calls, status: next.status }
}

const a = await scenarioA()
const b = await scenarioB()
const c = await scenarioC()

console.log('\n───── 结论 ─────')
console.log(`单飞把 ${CONCURRENCY} 个并发调用收敛为 ${a.calls} 次上游刷新（无单飞时为 ${b.calls} 次）。`)

const pass = a.calls === 1 && a.joined === CONCURRENCY - 1 && a.tokens === 1
  && a.generations === 1 && b.calls === CONCURRENCY && b.rejected === CONCURRENCY - 1
  && c.callsWhileBlocked === 1 && c.calls === 2 && c.status === 'refreshed'

console.log(pass ? 'demo 通过：单飞行为符合预期' : 'demo 失败：单飞行为不符合预期')
process.exit(pass ? 0 : 1)
