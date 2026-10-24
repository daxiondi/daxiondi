/**
 * TokenRefresher / CredentialStore 的单元测试。
 *
 * 每个小节对应一个已知会导致「账号掉登录」的失败场景：
 *
 *   1. 上游不返回 refresh_token     → needs_reauth，不回退旧 token
 *   2. 网络错误重试                 → 重试前重读存储，generation 变了用别人的结果
 *   3. invalid_grant                → 不重试，立即 needs_reauth
 *   4. expires_in 缺失              → 1 小时，不是 8 小时
 *   5. 并发 10 个刷新               → refreshFn 只被调用 1 次
 *   6. 单飞清理                     → 第一个完成后新请求能重新发起
 *   7. CAS 冲突                     → 后到的 save 抛冲突
 *   8. 429                          → 按 Retry-After 等待
 *   9. 时钟注入                     → 过期边界按 skewMs 提前
 *  10. accountState 四档状态转换
 *
 * 全部离线：refreshFn、clock、sleep 都是注入的假实现，不建立网络连接。
 *
 * 用法：node test/token-refresh.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  TokenRefresher, STATE, DEFAULT_TTL_MS, DEFAULT_SKEW_MS, DEFAULT_MIN_RETRY_GAP_MS,
  classifyRefreshError, expiryMs, normalizeExpiresIn, normalizeAbsoluteMs, retryAfterMs,
} from '../src/token-refresh.mjs'
import { CredentialStore, STORE_VERSION, CONFLICT } from '../src/credential-store.mjs'

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const a = JSON.stringify(got); const b = JSON.stringify(want)
  if (a === b) { pass += 1; console.log('  ok   ', name) }
  else { fail += 1; console.log('  FAIL ', name, '\n    got ', a, '\n    want', b) }
}
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ok   ', name) }
  else { fail += 1; console.log('  FAIL ', name, detail === undefined ? '' : `\n    ${detail}`) }
}

/** 假时钟：手动推进 */
function makeClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance(ms) { t += ms },
    set(ms) { t = ms },
    get value() { return t },
  }
}

/** 记录 sleep 调用而不真的等待 */
function makeSleep() {
  const calls = []
  const fn = async (ms) => { calls.push(ms) }
  fn.calls = calls
  return fn
}

const silentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
}

function tmpDir(prefix = 'token-refresh-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 初始凭据：已进入 skew 窗口（10 分钟后到期，skew 默认 5 分钟→ 不会触发）
 *  这里给 1 分钟，确保 needsRefresh 为真 */
function expiringCredential(clock, { id = 'a', extra = {} } = {}) {
  return {
    id,
    access_token: 'AT-OLD',
    refresh_token: 'RT-OLD',
    expires_at: Math.floor((clock.now() + 60_000) / 1000),
    expires_at_ms: clock.now() + 60_000,
    ...extra,
  }
}

async function seed(store, accountId, credential, generation = 0) {
  return store.save(accountId, credential, generation)
}

// ═══════════════ 0. 基础工具函数 ═══════════════

console.log('\n0. 工具函数：expires_in 归一化 / Retry-After 解析')

eq('expires_in 秒 → 毫秒', normalizeExpiresIn(3600), 3_600_000)
eq('expires_in 字符串数字', normalizeExpiresIn('1800'), 1_800_000)
eq('expires_in 0 → null（视为缺失）', normalizeExpiresIn(0), null)
eq('expires_in 负数 → null', normalizeExpiresIn(-5), null)
eq('expires_in undefined → null', normalizeExpiresIn(undefined), null)
eq('expires_in NaN → null', normalizeExpiresIn('abc'), null)

eq('Retry-After 秒字段', retryAfterMs({ retry_after: 12 }), 12_000)
eq('Retry-After 毫秒字段', retryAfterMs({ retry_after_ms: 750 }), 750)
eq('Retry-After header 对象', retryAfterMs({ headers: { 'retry-after': '3' } }), 3_000)
eq('Retry-After Headers-like', retryAfterMs({ headers: { get: (k) => (k === 'retry-after' ? '5' : null) } }), 5_000)
eq('无 Retry-After → null', retryAfterMs({ message: 'x' }), null)
eq('非对象 → null', retryAfterMs(null), null)

eq('expiryMs 用 expires_at_ms 优先', expiryMs({ expires_at: 1, expires_at_ms: 5000 }), 5000)
eq('expiryMs 回落到 expires_at 秒', expiryMs({ expires_at: 10 }), 10_000)
eq('expiryMs 缺失 → null', expiryMs({ access_token: 'T' }), null)
eq('expiryMs 非法对象 → null', expiryMs(null), null)

eq('normalizeAbsoluteMs 秒 → 毫秒', normalizeAbsoluteMs(1_700_000_000), 1_700_000_000_000)
eq('normalizeAbsoluteMs 毫秒原样', normalizeAbsoluteMs(1_700_000_000_000), 1_700_000_000_000)
eq('normalizeAbsoluteMs 数字字符串', normalizeAbsoluteMs('1700000000'), 1_700_000_000_000)
eq('normalizeAbsoluteMs ISO', normalizeAbsoluteMs('2023-11-14T22:13:20Z'), 1_700_000_000_000)
eq('normalizeAbsoluteMs 0 → null', normalizeAbsoluteMs(0), null)
eq('normalizeAbsoluteMs 乱码 → null', normalizeAbsoluteMs('not-a-date'), null)

// ═══════════════ 1. refresh_token 严格轮换 ═══════════════

console.log('\n1. 上游不返回 refresh_token → needs_reauth，不回退旧 token')

{
  const clock = makeClock()
  const store = new CredentialStore()
  const seeded = await seed(store, 'a', expiringCredential(clock))
  eq('种子 generation 为 1', seeded.generation, 1)

  let calls = 0
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => {
      calls += 1
      // 上游只给 access_token，没有轮换 refresh_token
      return { access_token: 'AT-NEW', expires_in: 3600 }
    },
  })

  const result = await refresher.refresh('a')
  eq('状态是 needs_reauth', result.status, 'needs_reauth')
  eq('needs_reauth 标记', result.needs_reauth, true)
  eq('原因写明未轮换', result.reason, 'refresh_token_not_rotated')
  eq('refreshFn 只调用一次', calls, 1)
  eq('新 access_token 被保留（还可用）', result.credential.access_token, 'AT-NEW')
  eq('旧 refresh_token 未被回退', result.credential.refresh_token, '')
  eq('持久化后也是空 refresh_token', (await store.load('a')).credential.refresh_token, '')
  eq('持久化标记 needs_reauth', (await store.load('a')).credential.needs_reauth, true)
  eq('持久化记录原因', (await store.load('a')).credential.needs_reauth_reason, 'refresh_token_not_rotated')

  const state = refresher.accountState((await store.load('a')).credential, clock.now())
  eq('accountState 立刻是 needs_reauth', state, STATE.NEEDS_REAUTH)
  eq('needsRefresh 为 false（刷不动了）', refresher.needsRefresh((await store.load('a')).credential, clock.now()), false)
}

{
  // 轮换正常时：旧 refresh_token 必须被新值替换，且不能残留
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'b', expiringCredential(clock, { id: 'b' }))
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => ({ access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 7200 }),
  })
  const result = await refresher.refresh('b')
  eq('正常轮换 → refreshed', result.status, 'refreshed')
  eq('access_token 更新', result.credential.access_token, 'AT-2')
  eq('refresh_token 轮换', result.credential.refresh_token, 'RT-2')
  eq('needs_reauth 为 false', result.credential.needs_reauth, false)
  eq('TTL 用上游 expires_in', result.credential.expires_at_ms, clock.now() + 7_200_000)
}

{
  // 上游返回空白字符串的 refresh_token：等同于没有返回
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'c', expiringCredential(clock, { id: 'c' }))
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => ({ access_token: 'AT-3', refresh_token: '   ', expires_in: 3600 }),
  })
  const result = await refresher.refresh('c')
  eq('空白 refresh_token → needs_reauth', result.status, 'needs_reauth')
  eq('空白 refresh_token 不算轮换', result.credential.refresh_token, '')
}

// ═══════════════ 2. 重试前重新读存储 ═══════════════

console.log('\n2. 网络错误重试 → 重试前重读存储，generation 变了用别人的结果')

{
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock)) // generation 1
  const sleep = makeSleep()

  let calls = 0
  let injected = null
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    // 第一次退避等待期间，模拟"另一个执行体已经刷成功"
    sleep: async (ms) => {
      sleep.calls.push(ms)
      if (!injected) {
        injected = await store.save(
          'a',
          {
            ...expiringCredential(clock),
            access_token: 'AT-FROM-OTHER',
            refresh_token: 'RT-OTHER',
            expires_at_ms: clock.now() + 3600_000,
          },
          1,
        )
      }
    },
    minRetryGapMs: 100,
    refreshFn: async () => {
      calls += 1
      const err = new Error('socket hang up')
      err.code = 'ECONNRESET'
      throw err
    },
  })

  const result = await refresher.refresh('a')
  eq('重试期间发现别人刷过 → shared', result.status, 'shared')
  eq('原因说明 generation 前进', result.reason, 'generation_advanced_after_wait')
  eq('采用别人的 access_token', result.credential.access_token, 'AT-FROM-OTHER')
  eq('refreshFn 只打了一次（没重复消耗）', calls, 1)
  eq('别人的写入生成 generation 2', injected.generation, 2)
  eq('最终 generation 是 2', result.generation, 2)
}

{
  // 纯网络错误 + 无人抢占：应该重试到成功
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const sleep = makeSleep()
  let calls = 0
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    sleep,
    minRetryGapMs: 50,
    maxAttempts: 3,
    refreshFn: async () => {
      calls += 1
      if (calls < 3) {
        const err = new Error('timeout')
        err.code = 'ETIMEDOUT'
        throw err
      }
      return { access_token: 'AT-OK', refresh_token: 'RT-OK', expires_in: 3600 }
    },
  })
  const result = await refresher.refresh('a')
  eq('第三次成功 → refreshed', result.status, 'refreshed')
  eq('一共尝试 3 次', result.attempts, 3)
  eq('sleep 被调用 2 次', sleep.calls.length, 2)
  ok('退避递增', sleep.calls[1] >= sleep.calls[0], JSON.stringify(sleep.calls))
  ok('退避不小于下限', sleep.calls[0] >= 50, JSON.stringify(sleep.calls))
}

{
  // 重试耗尽 → failed，但账号不被标记 needs_reauth（只是暂时刷不上）
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    sleep: async () => {},
    maxAttempts: 2,
    minRetryGapMs: 10,
    refreshFn: async () => {
      const err = new Error('connect timeout')
      err.code = 'UND_ERR_CONNECT_TIMEOUT'
      throw err
    },
  })
  const result = await refresher.refresh('a')
  eq('重试耗尽 → failed', result.status, 'failed')
  eq('failed 不误标 needs_reauth', result.needs_reauth, false)
  eq('attempts 达到上限', result.attempts, 2)
  eq('凭据未被改写', (await store.load('a')).generation, 1)
}

// ═══════════════ 3. invalid_grant 不可重试 ═══════════════

console.log('\n3. invalid_grant / 400 → 不重试，立即 needs_reauth')

{
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const sleep = makeSleep()
  let calls = 0
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    sleep,
    maxAttempts: 5,
    refreshFn: async () => {
      calls += 1
      const err = new Error('invalid_grant')
      err.code = 'invalid_grant'
      err.status = 400
      throw err
    },
  })
  const result = await refresher.refresh('a')
  eq('invalid_grant → needs_reauth', result.status, 'needs_reauth')
  eq('reason 是 invalid_grant', result.reason, 'invalid_grant')
  eq('refreshFn 只调 1 次（不重试）', calls, 1)
  eq('完全没有等待', sleep.calls.length, 0)
  eq('持久化 needs_reauth', (await store.load('a')).credential.needs_reauth, true)
  eq('attempts 记 1', result.attempts, 1)
}

{
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  let calls = 0
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    sleep: async () => {},
    maxAttempts: 5,
    refreshFn: async () => {
      calls += 1
      const err = new Error('bad request')
      err.status = 400
      throw err
    },
  })
  const result = await refresher.refresh('a')
  eq('裸 400 → 也是 needs_reauth', result.status, 'needs_reauth')
  eq('裸 400 不重试', calls, 1)
}

{
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  let calls = 0
  const refresher = new TokenRefresher({
    store, clock: clock.now, sleep: async () => {}, maxAttempts: 5,
    refreshFn: async () => {
      calls += 1
      const err = new Error('invalid_refresh_token')
      err.code = 'invalid_refresh_token'
      err.status = 401
      throw err
    },
  })
  const result = await refresher.refresh('a')
  eq('invalid_refresh_token → needs_reauth', result.status, 'needs_reauth')
  eq('不重试', calls, 1)
}

{
  // 分类器本身
  eq('classify invalid_grant', classifyRefreshError({ code: 'invalid_grant', status: 400 }).fatal, true)
  eq('classify 400 retryable', classifyRefreshError({ status: 400 }).retryable, false)
  eq('classify 500 retryable', classifyRefreshError({ status: 500 }).retryable, true)
  eq('classify 503 retryable', classifyRefreshError({ status: 503 }).retryable, true)
  eq('classify 429 retryable', classifyRefreshError({ status: 429 }).retryable, true)
  eq('classify ECONNRESET retryable', classifyRefreshError({ code: 'ECONNRESET' }).retryable, true)
  eq('classify 401 fatal', classifyRefreshError({ status: 401 }).fatal, true)
  eq('classify needs_reauth 标记优先', classifyRefreshError({ needs_reauth: true }).fatal, true)
  eq('classify 未知传输错误可重试', classifyRefreshError({ code: 'UNKNOWN_X' }).retryable, true)
  eq('classify 未知 HTTP 状态不可重试', classifyRefreshError({ status: 418 }).retryable, false)
}

// ═══════════════ 4. expires_in 缺失 → 1 小时 ═══════════════

console.log('\n4. expires_in 缺失 → 1 小时（不是 8 小时）')

eq('常量是 1 小时', DEFAULT_TTL_MS, 3_600_000)
eq('常量不是 8 小时', DEFAULT_TTL_MS === 8 * 3_600_000, false)

{
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => ({ access_token: 'AT-N', refresh_token: 'RT-N' }), // 无 expires_in
  })
  const result = await refresher.refresh('a')
  eq('缺失 expires_in → 1 小时', result.credential.expires_at_ms, clock.now() + 3_600_000)
  eq('expires_at 秒级同步', result.credential.expires_at, Math.floor((clock.now() + 3_600_000) / 1000))
  eq('记录了 TTL 来源', result.credential.expires_in_source, 'assumed_default')
  ok('远小于 8 小时', result.credential.expires_at_ms - clock.now() < 8 * 3_600_000,
    String(result.credential.expires_at_ms - clock.now()))
}

{
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => ({ access_token: 'AT-N', refresh_token: 'RT-N', expires_in: 600 }),
  })
  const result = await refresher.refresh('a')
  eq('严格用 expires_in=600', result.credential.expires_at_ms, clock.now() + 600_000)
  eq('TTL 来源是 expires_in', result.credential.expires_in_source, 'expires_in')
}

{
  // 上游给绝对时间：优先于默认值
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => ({ access_token: 'AT-N', refresh_token: 'RT-N', expires_at: Math.floor(clock.now() / 1000) + 120 }),
  })
  const result = await refresher.refresh('a')
  eq('用上游的 expires_at（秒）', result.credential.expires_at_ms, Math.floor(clock.now() / 1000) * 1000 + 120_000)
  eq('TTL 来源是 expires_at', result.credential.expires_in_source, 'expires_at')
}

{
  // 上游给 ISO 字符串的绝对时间：必须被解析，不能静默退回 1 小时
  const clock = makeClock(1_700_000_000_000)
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const iso = new Date(clock.now() + 1800_000).toISOString()
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => ({ access_token: 'AT-ISO', refresh_token: 'RT-ISO', expires_at: iso }),
  })
  const result = await refresher.refresh('a')
  eq('ISO 绝对时间被解析', result.credential.expires_at_ms, clock.now() + 1800_000)
  ok('没有退回 1 小时默认值', result.credential.expires_at_ms !== clock.now() + DEFAULT_TTL_MS,
    String(result.credential.expires_at_ms - clock.now()))
}

// ═══════════════ 5. 并发 10 个 → refreshFn 调用 1 次 ═══════════════

console.log('\n5. 并发 10 个刷新请求 → refreshFn 只调用 1 次')

{
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  let calls = 0
  let resolveGate
  const gate = new Promise((resolve) => { resolveGate = resolve })

  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => {
      calls += 1
      await gate
      return { access_token: 'AT-CONC', refresh_token: 'RT-CONC', expires_in: 3600 }
    },
  })

  const promises = Array.from({ length: 10 }, () => refresher.refresh('a'))
  // 让所有调用都进入单飞表
  await new Promise((resolve) => setImmediate(resolve))
  eq('并发期间 refreshFn 只调用 1 次', calls, 1)
  resolveGate()
  const results = await Promise.all(promises)

  eq('10 个调用都完成', results.length, 10)
  eq('refreshFn 总共只调用 1 次', calls, 1)
  eq('10 个结果都是 refreshed', results.filter((r) => r.status === 'refreshed').length, 10)
  eq('10 个拿到同一 generation', new Set(results.map((r) => r.generation)).size, 1)
  eq('10 个拿到同一 token', new Set(results.map((r) => r.credential.access_token)).size, 1)
  eq('token 是刷新后的值', results[0].credential.access_token, 'AT-CONC')
  eq('joined 统计 9', refresher.snapshot().stats.joined, 9)
  eq('在途表已清空', refresher.snapshot().inflight, 0)
}

{
  // 不同账号互不阻塞
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock, { id: 'a' }))
  await seed(store, 'b', expiringCredential(clock, { id: 'b' }))
  const seen = []
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async (credential) => {
      seen.push(credential.id)
      return { access_token: `AT-${credential.id}`, refresh_token: `RT-${credential.id}`, expires_in: 3600 }
    },
  })
  const [ra, rb] = await Promise.all([refresher.refresh('a'), refresher.refresh('b')])
  eq('两个账号各刷一次', seen.sort(), ['a', 'b'])
  eq('a 状态 refreshed', ra.status, 'refreshed')
  eq('b 状态 refreshed', rb.status, 'refreshed')
  eq('a token 独立', ra.credential.access_token, 'AT-a')
  eq('b token 独立', rb.credential.access_token, 'AT-b')
}

// ═══════════════ 6. 单飞清理正确 ═══════════════

console.log('\n6. 单飞清理：第一个完成后，新请求能正常发起')

{
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  let calls = 0
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    refreshFn: async () => {
      calls += 1
      // 每次都返回一个立刻进入 skew 窗口的 TTL，保证第二次请求仍然"需要刷新"
      return { access_token: `AT-${calls}`, refresh_token: `RT-${calls}`, expires_in: 601 }
    },
  })

  const first = await refresher.refresh('a')
  eq('第一次 refreshed', first.status, 'refreshed')
  eq('第一次后 in-flight 清空', refresher.snapshot().inflight, 0)

  // 让它再次进入需要刷新的窗口
  clock.advance(600_000)
  const second = await refresher.refresh('a')
  eq('第二次也能真正发起刷新', second.status, 'refreshed')
  eq('refreshFn 被调用 2 次', calls, 2)
  eq('第二次拿到新 token', second.credential.access_token, 'AT-2')
  eq('第二次 generation 前进', second.generation, 3)
}

{
  // 失败也要清理：一次错误不能让账号永远卡在"刷新中"
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  let calls = 0
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    sleep: async () => {},
    maxAttempts: 1,
    refreshFn: async () => {
      calls += 1
      const err = new Error('boom')
      err.code = 'ECONNRESET'
      throw err
    },
  })
  const r1 = await refresher.refresh('a')
  eq('第一次 failed', r1.status, 'failed')
  eq('失败后 in-flight 清空', refresher.snapshot().inflight, 0)
  const r2 = await refresher.refresh('a')
  eq('失败后还能再试', r2.status, 'failed')
  eq('refreshFn 被调用 2 次', calls, 2)
}

{
  // 抛出未知账号：单飞表不能残留
  const store = new CredentialStore()
  const refresher = new TokenRefresher({
    store,
    clock: makeClock().now,
    refreshFn: async () => ({ access_token: 'X', refresh_token: 'Y' }),
  })
  let err = null
  try { await refresher.refresh('ghost') } catch (e) { err = e }
  eq('未知账号抛 unknown_account', err?.code, 'unknown_account')
  eq('抛错后 in-flight 清空', refresher.snapshot().inflight, 0)
}

// ═══════════════ 7. CAS 冲突 ═══════════════

console.log('\n7. CAS：两个并发 save，后一个 generation 不符时抛冲突')

{
  const store = new CredentialStore()
  await store.save('a', { access_token: 'V1' }, 0)
  eq('第一次写入 generation 1', (await store.load('a')).generation, 1)

  // 两个"执行体"读到同一个 generation
  const [readA, readB] = await Promise.all([store.load('a'), store.load('a')])
  eq('两个读者读到同一 generation', readA.generation, readB.generation)

  const saveA = await store.save('a', { access_token: 'V2-from-A' }, readA.generation)
  eq('A 保存成功', saveA.generation, 2)

  let err = null
  try { await store.save('a', { access_token: 'V2-from-B' }, readB.generation) } catch (e) { err = e }
  eq('B 保存抛冲突', err?.code, CONFLICT)
  eq('冲突错误带期望 generation', err?.expected_generation, 1)
  eq('冲突错误带实际 generation', err?.actual_generation, 2)
  eq('冲突后磁盘保留 A 的值', (await store.load('a')).credential.access_token, 'V2-from-A')
  eq('冲突后 generation 仍是 2', (await store.load('a')).generation, 2)
}

{
  // 冲突时 refresher 采用磁盘上的结果，不覆盖
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    minRetryGapMs: 10,
    sleep: async () => {},
    refreshFn: async () => {
      // 模拟"刷新期间另一个进程先写了"
      await store.save('a', {
        ...expiringCredential(clock),
        access_token: 'AT-WINNER',
        refresh_token: 'RT-WINNER',
        expires_at_ms: clock.now() + 3600_000,
      }, 1)
      return { access_token: 'AT-LOSER', refresh_token: 'RT-LOSER', expires_in: 3600 }
    },
  })
  const result = await refresher.refresh('a')
  eq('CAS 冲突时结果为 winner', result.credential.access_token, 'AT-WINNER')
  eq('generation 是 winner 写后的值', result.generation, 2)
  eq('没有把 loser 的值写下去', (await store.load('a')).credential.access_token, 'AT-WINNER')
  eq('磁盘上只有 winner 的 refresh_token', (await store.load('a')).credential.refresh_token, 'RT-WINNER')
}

{
  // 无条件写入（不传 generation）用于初始化
  const store = new CredentialStore()
  const r = await store.save('a', { access_token: 'SEED' })
  eq('无条件写入 generation 1', r.generation, 1)
  const r2 = await store.save('a', { access_token: 'SEED2' })
  eq('无条件再次写入 generation 2', r2.generation, 2)
}

// ═══════════════ 8. 429 → Retry-After ═══════════════

console.log('\n8. 429 → 按 Retry-After 等待')

{
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const sleep = makeSleep()
  let calls = 0
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    sleep,
    minRetryGapMs: 100,
    maxAttempts: 3,
    refreshFn: async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error('too many requests')
        err.status = 429
        err.retry_after = 7
        throw err
      }
      return { access_token: 'AT-429', refresh_token: 'RT-429', expires_in: 3600 }
    },
  })
  const result = await refresher.refresh('a')
  eq('429 后重试成功', result.status, 'refreshed')
  eq('按 Retry-After=7s 等待', sleep.calls, [7000])
  eq('refreshFn 调用 2 次', calls, 2)
  eq('attempts 记 2', result.attempts, 2)
}

{
  // Retry-After 缺失时退回指数退避（且不低于下限）
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const sleep = makeSleep()
  let calls = 0
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    sleep,
    minRetryGapMs: 200,
    maxAttempts: 3,
    refreshFn: async () => {
      calls += 1
      if (calls < 3) {
        const err = new Error('too many requests')
        err.status = 429
        throw err
      }
      return { access_token: 'AT-X', refresh_token: 'RT-X', expires_in: 60 }
    },
  })
  const result = await refresher.refresh('a')
  eq('无 Retry-After 也能成功', result.status, 'refreshed')
  eq('两次等待都记录', sleep.calls.length, 2)
  ok('第一次等待 ≥ 下限', sleep.calls[0] >= 200, JSON.stringify(sleep.calls))
  ok('第二次等待 ≥ 第一次', sleep.calls[1] >= sleep.calls[0], JSON.stringify(sleep.calls))
}

{
  // Retry-After 用 HTTP 头承载
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const sleep = makeSleep()
  let calls = 0
  const refresher = new TokenRefresher({
    store, clock: clock.now, sleep, minRetryGapMs: 10, maxAttempts: 2,
    refreshFn: async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error('rate limited')
        err.status = 429
        err.headers = { 'retry-after': '2' }
        throw err
      }
      return { access_token: 'AT-H', refresh_token: 'RT-H', expires_in: 60 }
    },
  })
  const result = await refresher.refresh('a')
  eq('header 里的 Retry-After 生效', sleep.calls, [2000])
  eq('随后成功', result.status, 'refreshed')
}

// ═══════════════ 9. 时钟注入与过期边界 ═══════════════

console.log('\n9. 时钟注入：按 skewMs 提前进入刷新窗口')

{
  const clock = makeClock(1_000_000)
  const store = new CredentialStore()
  const refresher = new TokenRefresher({
    store,
    clock: clock.now,
    skewMs: 60_000,
    refreshFn: async () => ({ access_token: 'X', refresh_token: 'Y', expires_in: 3600 }),
  })

  const cred = (deltaMs) => ({ access_token: 'T', refresh_token: 'R', expires_at_ms: clock.now() + deltaMs })

  eq('距到期 61s（窗口外）→ fresh', refresher.accountState(cred(61_000), clock.now()), STATE.FRESH)
  eq('距到期 60s（恰在窗口边）→ expiring', refresher.accountState(cred(60_000), clock.now()), STATE.EXPIRING)
  eq('距到期 59s → expiring', refresher.accountState(cred(59_000), clock.now()), STATE.EXPIRING)
  eq('距到期 1ms → expiring', refresher.accountState(cred(1), clock.now()), STATE.EXPIRING)
  eq('恰好到期 → expired', refresher.accountState(cred(0), clock.now()), STATE.EXPIRED)
  eq('已过期 10s → expired', refresher.accountState(cred(-10_000), clock.now()), STATE.EXPIRED)

  eq('窗口外不需要刷新', refresher.needsRefresh(cred(61_000), clock.now()), false)
  eq('窗口内需要刷新', refresher.needsRefresh(cred(59_000), clock.now()), true)
  eq('已过期需要刷新', refresher.needsRefresh(cred(-1), clock.now()), true)

  // 时钟推进到边界
  clock.advance(60_000)
  eq('时钟推进后变为 expired', refresher.accountState(cred(0), clock.now()), STATE.EXPIRED)
  eq('默认 skew 是 5 分钟', DEFAULT_SKEW_MS, 300_000)
  eq('默认退避下限 1s', DEFAULT_MIN_RETRY_GAP_MS, 1000)
}

{
  // 用假时钟验证 skew 触发刷新：不推进时钟不应刷新，推进后才刷
  const clock = makeClock()
  const store = new CredentialStore()
  await store.save('a', {
    id: 'a', access_token: 'AT', refresh_token: 'RT',
    expires_at_ms: clock.now() + 600_000,
    expires_at: Math.floor((clock.now() + 600_000) / 1000),
  }, 0)
  let calls = 0
  const refresher = new TokenRefresher({
    store, clock: clock.now, skewMs: 300_000,
    refreshFn: async () => {
      calls += 1
      return { access_token: 'NEW', refresh_token: 'RT2', expires_in: 3600 }
    },
  })

  const skipped = await refresher.refresh('a')
  eq('距到期 10 分钟 → 跳过', skipped.status, 'skipped')
  eq('原因 not_due', skipped.reason, 'not_due')
  eq('没调用 refreshFn', calls, 0)

  clock.advance(300_001) // 进入 skew 窗口
  const refreshed = await refresher.refresh('a')
  eq('进入窗口后刷新', refreshed.status, 'refreshed')
  eq('refreshFn 调用 1 次', calls, 1)

  const again = await refresher.refresh('a')
  eq('刚刷完再调 → skipped', again.status, 'skipped')
  eq('没有重复刷新', calls, 1)
}

{
  // force 绕过窗口判断
  const clock = makeClock()
  const store = new CredentialStore()
  await store.save('a', {
    id: 'a', access_token: 'AT', refresh_token: 'RT',
    expires_at_ms: clock.now() + 86_400_000,
    expires_at: Math.floor((clock.now() + 86_400_000) / 1000),
  }, 0)
  let calls = 0
  const refresher = new TokenRefresher({
    store, clock: clock.now,
    refreshFn: async () => {
      calls += 1
      return { access_token: 'FORCED', refresh_token: 'RT2', expires_in: 3600 }
    },
  })
  const r = await refresher.refresh('a', { force: true })
  eq('force 无视有效期', r.status, 'refreshed')
  eq('force 真的调用了 refreshFn', calls, 1)
  eq('force 结果生效', r.credential.access_token, 'FORCED')
}

// ═══════════════ 10. accountState 四档状态转换 ═══════════════

console.log('\n10. accountState 四档状态转换')

{
  const clock = makeClock()
  const store = new CredentialStore()
  const refresher = new TokenRefresher({
    store, clock: clock.now, skewMs: 300_000,
    refreshFn: async () => ({ access_token: 'X', refresh_token: 'Y', expires_in: 3600 }),
  })
  const now = clock.now()

  eq('无凭据 → needs_reauth', refresher.accountState(null, now), STATE.NEEDS_REAUTH)
  eq('非对象 → needs_reauth', refresher.accountState('nope', now), STATE.NEEDS_REAUTH)
  eq('无 access_token 无 refresh_token → needs_reauth',
    refresher.accountState({}, now), STATE.NEEDS_REAUTH)
  eq('无 access_token 有 refresh_token → expired（可救）',
    refresher.accountState({ refresh_token: 'R' }, now), STATE.EXPIRED)
  eq('显式 needs_reauth 优先', refresher.accountState({ access_token: 'T', refresh_token: 'R', needs_reauth: true }, now), STATE.NEEDS_REAUTH)
  eq('无到期时间 → fresh', refresher.accountState({ access_token: 'T', refresh_token: 'R' }, now), STATE.FRESH)
  eq('过期且无 refresh_token → needs_reauth',
    refresher.accountState({ access_token: 'T', expires_at_ms: now - 1 }, now), STATE.NEEDS_REAUTH)

  // 四档完整走一遍：fresh → expiring → expired → needs_reauth
  const cred = { access_token: 'T', refresh_token: 'R', expires_at_ms: now + 3_600_000 }
  eq('阶段 1：fresh', refresher.accountState(cred, now), STATE.FRESH)
  eq('阶段 2：expiring', refresher.accountState(cred, now + 3_300_001), STATE.EXPIRING)
  eq('阶段 3：expired', refresher.accountState(cred, now + 3_600_000), STATE.EXPIRED)
  eq('阶段 4：needs_reauth', refresher.accountState({ ...cred, needs_reauth: true }, now), STATE.NEEDS_REAUTH)

  // STATE 常量本身
  eq('STATE.FRESH', STATE.FRESH, 'fresh')
  eq('STATE.EXPIRING', STATE.EXPIRING, 'expiring')
  eq('STATE.EXPIRED', STATE.EXPIRED, 'expired')
  eq('STATE.NEEDS_REAUTH', STATE.NEEDS_REAUTH, 'needs_reauth')
}

{
  // 刷新成功后状态从 expired 回到 fresh
  const clock = makeClock()
  const store = new CredentialStore()
  await store.save('a', {
    id: 'a', access_token: 'OLD', refresh_token: 'RT',
    expires_at_ms: clock.now() - 10_000,
    expires_at: Math.floor((clock.now() - 10_000) / 1000),
  }, 0)
  const refresher = new TokenRefresher({
    store, clock: clock.now,
    refreshFn: async () => ({ access_token: 'NEW', refresh_token: 'RT2', expires_in: 3600 }),
  })
  eq('刷新前 expired', refresher.accountState((await store.load('a')).credential, clock.now()), STATE.EXPIRED)
  await refresher.refresh('a')
  eq('刷新后 fresh', refresher.accountState((await store.load('a')).credential, clock.now()), STATE.FRESH)
}

{
  // needs_reauth 抑制窗口：短时间内重复调用不再打上游
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  let calls = 0
  const refresher = new TokenRefresher({
    store, clock: clock.now, minRetryGapMs: 60_000,
    refreshFn: async () => {
      calls += 1
      const err = new Error('invalid_grant')
      err.code = 'invalid_grant'
      err.status = 400
      throw err
    },
  })
  const r1 = await refresher.refresh('a')
  eq('第一次 needs_reauth', r1.status, 'needs_reauth')
  const r2 = await refresher.refresh('a')
  eq('抑制窗口内直接返回 needs_reauth', r2.status, 'needs_reauth')
  eq('抑制标记', r2.suppressed, true)
  eq('抑制期间没有再打上游', calls, 1)

  clock.advance(60_001)
  const r3 = await refresher.refresh('a')
  eq('抑制窗口过后：needs_reauth 账号不再自动打上游', r3.status, 'skipped')
  eq('needs_reauth 账号继续被标记', r3.needs_reauth, true)
  eq('依旧没有重复打上游', calls, 1)

  const forced = await refresher.refresh('a', { force: true })
  eq('force 绕过抑制', forced.status, 'needs_reauth')
  ok('force 确实重新打了上游', calls >= 2, String(calls))
}

// ═══════════════ 11. CredentialStore 持久化 ═══════════════

console.log('\n11. CredentialStore：原子写 / 重载 / 版本')

{
  const dir = tmpDir()
  const file = path.join(dir, 'creds.json')
  const store = new CredentialStore({ path: file })
  await store.save('a', { access_token: 'T1', refresh_token: 'R1', expires_at: 100 }, 0)
  await store.save('b', { access_token: 'T2', refresh_token: 'R2', expires_at: 200 }, 0)
  ok('文件已生成', fs.existsSync(file), file)

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  eq('文件带版本号', raw.version, STORE_VERSION)
  eq('文件含两个账号', Object.keys(raw.accounts).sort(), ['a', 'b'])
  eq('账号 a generation 1', raw.accounts.a.generation, 1)

  // 新实例从文件加载
  const store2 = new CredentialStore({ path: file })
  const loaded = await store2.load('a')
  eq('重载 access_token', loaded.credential.access_token, 'T1')
  eq('重载 generation', loaded.generation, 1)
  eq('重载账号数', store2.accountIds(), ['a', 'b'])

  // 原子写：目录里不应残留临时文件
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
  eq('没有残留临时文件', leftovers, [])

  // CAS 跨实例：旧 generation 必须冲突
  let err = null
  try { await store2.save('a', { access_token: 'T1b' }, 0) } catch (e) { err = e }
  eq('跨实例 CAS 生效', err?.code, CONFLICT)

  fs.rmSync(dir, { recursive: true, force: true })
}

{
  // 文件缺失 → 空存储，不报错
  const dir = tmpDir()
  const store = new CredentialStore({ path: path.join(dir, 'nope.json') })
  const rec = await store.load('x')
  eq('缺失文件返回空凭据', rec.credential, null)
  eq('缺失文件 generation 0', rec.generation, 0)
  fs.rmSync(dir, { recursive: true, force: true })
}

{
  // 坏文件 → 显式报错，不当成空池
  const dir = tmpDir()
  const file = path.join(dir, 'bad.json')
  fs.writeFileSync(file, '{ not json')
  const store = new CredentialStore({ path: file })
  let err = null
  try { await store.load('x') } catch (e) { err = e }
  ok('坏文件报错', /not valid JSON/.test(err?.message || ''), err?.message)
  fs.rmSync(dir, { recursive: true, force: true })
}

{
  // 未知版本 → 显式报错，不猜
  const dir = tmpDir()
  const file = path.join(dir, 'v99.json')
  fs.writeFileSync(file, JSON.stringify({ version: 99, accounts: {} }))
  const store = new CredentialStore({ path: file })
  let err = null
  try { await store.load('x') } catch (e) { err = e }
  ok('未知版本报错', /unsupported credential store version/.test(err?.message || ''), err?.message)
  fs.rmSync(dir, { recursive: true, force: true })
}

{
  // withLock：同一账号严格串行
  const store = new CredentialStore()
  const order = []
  const slow = store.withLock('a', async () => {
    order.push('slow-start')
    await new Promise((r) => setTimeout(r, 20))
    order.push('slow-end')
  })
  const fast = store.withLock('a', async () => {
    order.push('fast')
  })
  await Promise.all([slow, fast])
  eq('互斥锁保证串行', order, ['slow-start', 'slow-end', 'fast'])

  // 不同账号可并行（不需要严格断言时间，只验证都能完成且锁表清空）
  await Promise.all([
    store.withLock('b', async () => {}),
    store.withLock('c', async () => {}),
  ])
  eq('锁表已清空', store.lockedAccounts(), [])
}

{
  // withLock 异常不破坏后续加锁
  const store = new CredentialStore()
  let err = null
  try { await store.withLock('a', async () => { throw new Error('inner') }) } catch (e) { err = e }
  eq('内层异常冒泡', err?.message, 'inner')
  const value = await store.withLock('a', async () => 'after')
  eq('异常后仍可加锁', value, 'after')
  eq('锁表清空', store.lockedAccounts(), [])
}

// ═══════════════ 12. 快照与健康检查 ═══════════════

console.log('\n12. snapshot 不泄露 token')

{
  const clock = makeClock()
  const store = new CredentialStore()
  await seed(store, 'a', expiringCredential(clock))
  const refresher = new TokenRefresher({
    store, clock: clock.now,
    refreshFn: async () => ({ access_token: 'SECRET-AT', refresh_token: 'SECRET-RT', expires_in: 3600 }),
  })
  await refresher.refresh('a')
  const snap = refresher.snapshot()
  const text = JSON.stringify(snap)
  ok('快照不含 access_token 明文', !text.includes('SECRET-AT'), text)
  ok('快照不含 refresh_token 明文', !text.includes('SECRET-RT'), text)
  eq('快照含 skew', snap.skew_ms, DEFAULT_SKEW_MS)
  eq('快照含统计', typeof snap.stats.refreshed, 'number')
  eq('快照账号状态 fresh', snap.accounts[0].state, STATE.FRESH)
  eq('快照标记有 refresh_token', snap.accounts[0].has_refresh_token, true)
  eq('inflight 为 0', snap.inflight, 0)
}

// ═══════════════ 13. 集成：CredentialManager 接上 TokenRefresher ═══════════════

console.log('\n13. CredentialManager 接入 TokenRefresher')

{
  const { CredentialManager } = await import('../src/codex-credentials.mjs')
  const clock = makeClock()
  const nowSecs = () => Math.floor(clock.now() / 1000)
  const store = new CredentialStore()
  await store.save('a', {
    id: 'a', access_token: 'AT-OLD', refresh_token: 'RT-OLD',
    expires_at_ms: clock.now() - 1000,
    expires_at: Math.floor((clock.now() - 1000) / 1000),
  }, 0)

  let calls = 0
  const refresher = new TokenRefresher({
    store, clock: clock.now,
    refreshFn: async () => {
      calls += 1
      return { access_token: 'AT-MGR', refresh_token: 'RT-MGR', expires_in: 3600 }
    },
  })
  const mgr = new CredentialManager(
    [{ id: 'a', access_token: 'AT-OLD', refresh_token: 'RT-OLD', expires_at: Math.floor((clock.now() - 1000) / 1000) }],
    { now: nowSecs, logger: silentLogger, refresher },
  )
  eq('canRefresh 为 true', mgr.canRefresh, true)
  const acc = await mgr.ensureFresh('a')
  eq('ensureFresh 拿到新 token', acc.access_token, 'AT-MGR')
  eq('refresh_token 被轮换', acc.refresh_token, 'RT-MGR')
  eq('refreshFn 调用 1 次', calls, 1)
  eq('快照状态 fresh', mgr.snapshot()[0].state, 'fresh')

  // 并发 ensureFresh 也只刷一次
  clock.advance(7_200_000)
  const before = calls
  await Promise.all(Array.from({ length: 5 }, () => mgr.ensureFresh('a')))
  eq('并发 ensureFresh 也只刷一次', calls - before, 1)
}

{
  // 未轮换 → ensureFresh 抛 needs_reauth，且账号被标记
  const { CredentialManager } = await import('../src/codex-credentials.mjs')
  const clock = makeClock()
  const store = new CredentialStore()
  const nowSecs = () => Math.floor(clock.now() / 1000)
  await store.save('a', {
    id: 'a', access_token: 'AT-OLD', refresh_token: 'RT-OLD',
    expires_at_ms: clock.now() + 1000,
    expires_at: Math.floor((clock.now() + 1000) / 1000),
  }, 0)
  let calls = 0
  const refresher = new TokenRefresher({
    store, clock: clock.now, skewMs: 60_000,
    refreshFn: async () => {
      calls += 1
      return { access_token: 'AT-NOROT', expires_in: 3600 }
    },
  })
  const mgr = new CredentialManager(
    [{ id: 'a', access_token: 'AT-OLD', refresh_token: 'RT-OLD', expires_at: Math.floor((clock.now() + 1000) / 1000) }],
    { now: nowSecs, logger: silentLogger, refresher },
  )
  let err = null
  try { await mgr.ensureFresh('a') } catch (e) { err = e }
  eq('ensureFresh 抛 needs_reauth', err?.code, 'needs_reauth')
  eq('错误带原因', err?.reason, 'refresh_token_not_rotated')
  eq('refreshFn 只调 1 次', calls, 1)
  eq('账号状态变 needs_reauth', mgr.snapshot()[0].state, 'needs_reauth')
  eq('账号不再被视为可用', mgr.isUsable({ id: 'a', access_token: 'AT-NOROT', needs_reauth: true }), false)
}

{
  // 只传 store + refreshFn：CredentialManager 自建 TokenRefresher
  const { CredentialManager } = await import('../src/codex-credentials.mjs')
  const clock = makeClock()
  const nowSecs = () => Math.floor(clock.now() / 1000)
  const store = new CredentialStore()
  await store.save('a', {
    id: 'a', access_token: 'AT-OLD', refresh_token: 'RT-OLD',
    expires_at_ms: clock.now() - 1000,
    expires_at: Math.floor((clock.now() - 1000) / 1000),
  }, 0)

  let calls = 0
  const mgr = new CredentialManager(
    [{ id: 'a', access_token: 'AT-OLD', refresh_token: 'RT-OLD', expires_at: Math.floor((clock.now() - 1000) / 1000) }],
    {
      now: nowSecs,
      logger: silentLogger,
      store,
      refreshFn: async () => {
        calls += 1
        return { access_token: 'AT-AUTO', refresh_token: 'RT-AUTO', expires_in: 3600 }
      },
    },
  )
  ok('自建 refresher 成功', mgr.refresher != null)
  eq('自建 refresher 用同一 store', mgr.refresher.store, store)
  eq('canRefresh 为 true', mgr.canRefresh, true)
  const acc = await mgr.ensureFresh('a')
  eq('自建路径拿到新 token', acc.access_token, 'AT-AUTO')
  eq('自建路径轮换 refresh_token', acc.refresh_token, 'RT-AUTO')
  eq('自建路径调用 1 次', calls, 1)
  eq('自建路径状态 fresh', mgr.snapshot()[0].state, 'fresh')

  // 并发 ensureFresh 走单飞
  clock.advance(7_200_000)
  const before = calls
  await Promise.all(Array.from({ length: 6 }, () => mgr.ensureFresh('a')))
  eq('自建路径并发只刷一次', calls - before, 1)
}


// ═══════════════ 轮换后必须写回（实测根因）═══════════════
//
// 实测确认：Codex 的 OAuth 端点每次刷新都会下发**新的 refresh_token**，
// 旧的立即作废。所以"刷新成功"不等于"下次还能刷" —— 必须把新值落盘。
//
// 这条路径之前没有端到端断言（只有"上游没给新值时怎么办"），
// 而漏写回正是「老掉登录状态」的直接原因：第一次刷新成功，
// 第二次拿废 token 去换，401，登录态丢失。
console.log('\nX. 刷新成功后新 refresh_token 必须落盘')
{
  // store 契约：load(accountId) → { credential, generation }，
  // 不是直接返回 credential。generation 用于乐观并发控制 —— 落盘时
  // 发现别人改过了（generation 变了）就不能盲覆盖。
  let stored = null
  let gen = 0
  const store = {
    async load() { return { credential: stored, generation: gen } },
    // save(accountId, credential, expectedGeneration) → { credential, generation }
    // expectedGeneration 是乐观并发控制：落盘时发现别人改过了要报 conflict，
    // 不能盲覆盖（否则两个并发刷新互相盖掉，其中一次的新 refresh_token 就丢了）
    async save(_id, c, expectedGen) {
      if (expectedGen !== undefined && expectedGen !== gen) {
        throw Object.assign(new Error('generation conflict'), { code: 'generation_conflict' })
      }
      stored = c; gen += 1
      return { credential: stored, generation: gen }
    },
    async withLock(_id, fn) { return fn() },
  }
  await store.save('acct', {
    access_token: 'AT-OLD',
    refresh_token: 'RT-OLD',
    expires_at: 1000 + 3600_000,
  })

  let now = 10_000_000
  let refreshed = 0
  let seen = 0
  const refresher = new TokenRefresher({
    store,
    clock: () => now,
    skewMs: 120_000,
    refreshFn: async (cred) => {
      // 用 seen 记录"这是第几次调用"，与 refreshed 计数分开 ——
      // 之前用 refreshed 当索引，但它是在调用前自增的，导致差一位。
      seen += 1
      const n = seen
      // 不能写死 'RT-OLD'：第二次刷新时正确的值已经变成 'RT-NEW-1'。
      // 要验证的是"传的是当时最新的那个"，而不是某个固定字符串。
      // 期望值：第 1 次应是 RT-OLD，第 2 次应是 RT-NEW-1……
      eq(`第 ${n} 次传给上游的 refresh_token 是最新值`,
        cred.refresh_token, n === 1 ? 'RT-OLD' : `RT-NEW-${n - 1}`)
      // 模拟上游轮换：每次都下发新值
      return {
        access_token: `AT-NEW-${n}`,
        refresh_token: `RT-NEW-${n}`,
        id_token: 'ID-NEW',
        expires_at: now + 864_000_000,
      }
    },
  })

  const r1 = await refresher.refresh('acct', { force: true })
  eq('第一次刷新成功', r1?.status, 'refreshed')
  eq('未标记 needs_reauth', r1?.needs_reauth, false)
  const afterFirst = (await store.load()).credential
  eq('新 access_token 已存', afterFirst.access_token, 'AT-NEW-1')
  eq('新 refresh_token 已存（关键）', afterFirst.refresh_token, 'RT-NEW-1')

  // 第二次刷新必须用轮换后的新值，而不是旧的
  now += 1000
  const r2 = await refresher.refresh('acct', { force: true })
  eq('第二次刷新成功', r2?.status, 'refreshed')
  const afterSecond = (await store.load()).credential
  eq('第二次用上了新 refresh_token', afterSecond.refresh_token, 'RT-NEW-2')
  // 如果第一次没写回，这里会仍传 RT-OLD 且 refreshFn 里的断言会挂
  eq('上游被调用了两次', seen, 2)
}

// 上游不轮换（某些 OAuth 实现如此）时，应保留旧的而不是写成空
console.log('\nX2. 上游不返回 refresh_token 时清空（严格轮换语义）')
{
  let stored = null
  let gen2 = 0
  const store = {
    async load() { return { credential: stored, generation: gen2 } },
    async save(_id, c, expectedGen) {
      if (expectedGen !== undefined && expectedGen !== gen2) {
        throw Object.assign(new Error('generation conflict'), { code: 'generation_conflict' })
      }
      stored = c; gen2 += 1
      return { credential: stored, generation: gen2 }
    },
    async withLock(_id, fn) { return fn() },
  }
  await store.save('acct2', { access_token: 'AT-A', refresh_token: 'RT-STABLE', expires_at: 1000 + 3600_000 })
  const refresher = new TokenRefresher({
    store,
    clock: () => 10_000_000,
    skewMs: 120_000,
    refreshFn: async () => ({ access_token: 'AT-B', expires_at: 10_000_000 + 864_000_000 }),
  })
  await refresher.refresh('acct2', { force: true })
  const after = (await store.load()).credential
  eq('access_token 更新了', after.access_token, 'AT-B')
  // 严格轮换语义：上游没给新值就写成空串，**不保留旧的**。
  //
  // 我第一版断言写的是"保留旧值"，那是错的。理由见实现处的注释：
  // 轮换模式下旧 refresh_token 在上游已作废，留着它只会让下一次刷新
  // 拿一个确定失败的凭据去打上游，把"需要重新授权"这个明确事实
  // 伪装成"偶发的 invalid_grant" —— 排查方向会被彻底带偏。
  eq('上游未给新值时 refresh_token 被清空（严格轮换）', after.refresh_token, '')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
