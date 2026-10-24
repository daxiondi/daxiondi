/**
 * 凭据持久化层：内存缓存 + 文件双写 + generation 版本号（CAS）。
 *
 * 设计约束（每一条都对应一种"刷新后反而掉登录"的真实故障）：
 *
 * 1. **CAS 必须有版本号**。刷新是"读 → 换 token → 写"的复合操作，中间隔着一次
 *    网络往返。两个执行体（Node 定时器 / 推理路径 / 另一个进程）同时读到同一份
 *    凭据时，后写的那份会把先写的覆盖掉，而先写的那份可能已经让上游作废了旧的
 *    refresh_token。结果：磁盘上留下一个已失效的 refresh_token。因此 save() 要求
 *    调用方带上读到的 generation，不匹配就抛冲突，由调用方决定"采用对方的"还是
 *    "基于最新版本重写"。
 *
 * 2. **原子写**。直接 `writeFile` 同一个路径，在崩溃/断电时会留下半截 JSON；
 *    下次启动读到坏文件，整池账号全部不可用。这里写临时文件 + fsync + rename，
 *    rename 在同一文件系统内是原子的，读方只会看到旧版本或新版本。
 *
 * 3. **串行化落盘**。多个账号并发保存时不能让两个 rename 交错（虽然 rename 原子，
 *    但"读内存 → 序列化 → 写盘"这段若不串行，后一次序列化可能基于过期快照，
 *    把前一次刚写入的账号丢掉）。所有写操作走同一条 Promise 链。
 *
 * 4. **进程内互斥**。withLock(accountId) 保证同一账号的"读-改-写"在本进程内不
 *    并发。注意这是进程内锁，不能跨进程；跨进程的正确性由 generation + CAS 保证，
 *    这也是为什么 CAS 不能省。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** 磁盘格式版本。字段变化时递增，读到未知版本直接报错而不是猜。 */
export const STORE_VERSION = 1

/** CAS 冲突错误的 code，调用方按它分支 */
export const CONFLICT = 'generation_conflict'

function conflictError(accountId, expected, actual) {
  return Object.assign(
    new Error(
      `credential generation conflict for ${accountId}: expected ${expected}, found ${actual}`,
    ),
    { code: CONFLICT, account_id: accountId, expected_generation: expected, actual_generation: actual },
  )
}

/** 深拷贝一份凭据，避免调用方拿到内部引用后原地改写缓存 */
function cloneCredential(credential) {
  if (credential == null) return null
  return JSON.parse(JSON.stringify(credential))
}

function normalizeAccountId(accountId) {
  const id = typeof accountId === 'string' ? accountId.trim() : ''
  if (!id) throw new Error('accountId is required')
  return id
}

/**
 * 凭据存储。
 *
 * 不传 path 时是纯内存模式（测试、单次运行场景）。传 path 时内存与文件双写：
 * 读优先内存（文件只在首次访问时加载一次），写先更新内存再落盘；落盘失败会
 * 把内存回滚，避免"内存说成功了、磁盘没有"的分裂状态。
 */
export class CredentialStore {
  /**
   * @param {object} [opts]
   * @param {string|null} [opts.path]  JSON 文件路径，null 表示纯内存
   * @param {() => number} [opts.clock] 毫秒时钟，用于 updated_at
   */
  constructor({ path: filePath = null, clock = Date.now } = {}) {
    this.path = filePath ? path.resolve(filePath) : null
    this.clock = typeof clock === 'function' ? clock : Date.now

    /** @type {Map<string, {credential:object, generation:number}>} */
    this.accounts = new Map()
    this.loaded = false
    this.loadPromise = null

    /** 单账号互斥锁尾指针：accountId -> Promise */
    this.locks = new Map()
    /** 落盘串行链 */
    this.writeChain = Promise.resolve()
    /** 临时文件计数，避免同毫秒内两次写撞名 */
    this.tmpSeq = 0
  }

  // ─────────────── 加载 ───────────────

  /** 首次访问时把文件读进内存。并发调用共享同一次读取。 */
  async ensureLoaded() {
    if (this.loaded) return
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = (async () => {
      if (this.path) {
        let text = null
        try {
          text = await fsp.readFile(this.path, 'utf8')
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
        if (text != null && text.trim()) {
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch (err) {
            // 坏文件不能静默当成空池：那会让所有账号"凭空消失"，看起来像上游故障
            throw new Error(`credential store is not valid JSON (${this.path}): ${err.message}`)
          }
          if (parsed?.version != null && parsed.version !== STORE_VERSION) {
            throw new Error(
              `unsupported credential store version ${parsed.version} (${this.path}), expected ${STORE_VERSION}`,
            )
          }
          const entries = parsed?.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {}
          for (const [id, rec] of Object.entries(entries)) {
            if (!rec || typeof rec !== 'object') continue
            const generation = Number.isInteger(rec.generation) && rec.generation >= 0 ? rec.generation : 0
            this.accounts.set(id, {
              credential: rec.credential && typeof rec.credential === 'object' ? cloneCredential(rec.credential) : null,
              generation,
            })
          }
        }
      }
      this.loaded = true
      return this
    })()
    try {
      return await this.loadPromise
    } finally {
      this.loadPromise = null
    }
  }

  // ─────────────── 读 ───────────────

  /**
   * 读取账号当前凭据与版本号。
   *
   * 未登记的账号返回 `{credential: null, generation: 0}`，而不是抛错：初次写入
   * 就是"以 generation 0 为期望值"的正常路径。
   *
   * @returns {Promise<{credential: object|null, generation: number}>}
   */
  async load(accountId) {
    const id = normalizeAccountId(accountId)
    await this.ensureLoaded()
    const rec = this.accounts.get(id)
    if (!rec) return { credential: null, generation: 0 }
    return { credential: cloneCredential(rec.credential), generation: rec.generation }
  }

  /** 同步读取（不触发文件加载），供健康检查等不便 await 的路径使用 */
  peek(accountId) {
    const rec = this.accounts.get(String(accountId))
    if (!rec) return { credential: null, generation: 0 }
    return { credential: cloneCredential(rec.credential), generation: rec.generation }
  }

  /** 已登记的账号 id 列表 */
  accountIds() {
    return [...this.accounts.keys()].sort()
  }

  // ─────────────── 写 ───────────────

  /**
   * 保存凭据，带 CAS 校验。
   *
   * @param {string} accountId
   * @param {object} credential
   * @param {number|null} [expectedGeneration]
   *   期望的版本号。传 number 时严格校验，不符抛 `generation_conflict`；
   *   传 undefined/null 表示无条件写（只能用于初始化种子数据，刷新路径不要这么用）。
   * @returns {Promise<{credential:object, generation:number}>} 写入后的记录与新版本号
   */
  async save(accountId, credential, expectedGeneration) {
    const id = normalizeAccountId(accountId)
    if (!credential || typeof credential !== 'object') {
      throw new Error('credential must be an object')
    }
    return this.#withWrite(async () => {
      await this.ensureLoaded()
      const current = this.accounts.get(id)
      const currentGeneration = current ? current.generation : 0

      if (expectedGeneration != null) {
        if (!Number.isInteger(expectedGeneration)) {
          throw new Error('expectedGeneration must be an integer when provided')
        }
        if (expectedGeneration !== currentGeneration) {
          throw conflictError(id, expectedGeneration, currentGeneration)
        }
      }

      const nextGeneration = currentGeneration + 1
      const nextRecord = { credential: cloneCredential(credential), generation: nextGeneration }
      // 先改内存再落盘；落盘失败回滚，避免内存与磁盘不一致
      const previous = this.accounts.get(id)
      this.accounts.set(id, nextRecord)
      try {
        await this.#flush()
      } catch (err) {
        if (previous) this.accounts.set(id, previous)
        else this.accounts.delete(id)
        throw err
      }
      return { credential: cloneCredential(nextRecord.credential), generation: nextGeneration }
    })
  }

  /** 删除账号（撤销授权后清理用） */
  async remove(accountId) {
    const id = normalizeAccountId(accountId)
    return this.#withWrite(async () => {
      await this.ensureLoaded()
      const existed = this.accounts.delete(id)
      if (existed) await this.#flush()
      return existed
    })
  }

  // ─────────────── 互斥 ───────────────

  /**
   * 单账号进程内互斥。同一 accountId 的回调严格串行执行。
   *
   * 释放时只清理"自己那一节"的尾指针：如果已经有后来者把尾巴接在更后面，
   * 直接 delete 会把它们的排队信息一起丢掉，导致互斥失效。
   */
  async withLock(accountId, fn) {
    const id = normalizeAccountId(accountId)
    if (typeof fn !== 'function') throw new Error('withLock requires a function')

    const previous = this.locks.get(id) || Promise.resolve()
    let release
    const held = new Promise((resolve) => { release = resolve })
    const tail = previous.then(() => held)
    this.locks.set(id, tail)

    await previous.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(id) === tail) this.locks.delete(id)
    }
  }

  /** 当前排队/持锁的账号（诊断用） */
  lockedAccounts() {
    return [...this.locks.keys()].sort()
  }

  // ─────────────── 落盘 ───────────────

  /** 串行化所有写操作 */
  #withWrite(fn) {
    const run = this.writeChain.then(fn, fn)
    // 链条本身不能因为某次失败断掉；错误由本次调用的 run 抛给调用方
    this.writeChain = run.then(() => {}, () => {})
    return run
  }

  /** 序列化整个内存表 → 临时文件 → rename */
  async #flush() {
    if (!this.path) return
    const accounts = {}
    for (const id of this.accountIds()) {
      const rec = this.accounts.get(id)
      accounts[id] = {
        generation: rec.generation,
        credential: rec.credential,
      }
    }
    const payload = {
      version: STORE_VERSION,
      updated_at: new Date(this.clock()).toISOString(),
      accounts,
    }
    await fsp.mkdir(path.dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${this.tmpSeq += 1}.${randomBytes(4).toString('hex')}.tmp`
    let handle = null
    try {
      handle = await fsp.open(tmp, 'w')
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      if (handle) await handle.close()
    }
    try {
      await fsp.rename(tmp, this.path)
    } catch (err) {
      await fsp.rm(tmp, { force: true })
      throw err
    }
  }

  /** 同步写一次（进程退出前的兜底） */
  flushSync() {
    if (!this.path || !this.loaded) return
    const accounts = {}
    for (const id of this.accountIds()) {
      const rec = this.accounts.get(id)
      accounts[id] = { generation: rec.generation, credential: rec.credential }
    }
    const payload = {
      version: STORE_VERSION,
      updated_at: new Date(this.clock()).toISOString(),
      accounts,
    }
    const tmp = `${this.path}.${process.pid}.${this.tmpSeq += 1}.tmp`
    fs.mkdirSync(path.dirname(this.path), { recursive: true })
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
    fs.renameSync(tmp, this.path)
  }

  /** 快照（不含 token 明文），供健康检查 */
  snapshot() {
    const accounts = []
    for (const id of this.accountIds()) {
      const rec = this.accounts.get(id)
      accounts.push({
        account: id,
        generation: rec.generation,
        has_access_token: Boolean(rec.credential?.access_token),
        has_refresh_token: Boolean(rec.credential?.refresh_token),
        expires_at: rec.credential?.expires_at ?? null,
        needs_reauth: rec.credential?.needs_reauth === true,
      })
    }
    return { path: this.path, loaded: this.loaded, accounts }
  }
}
