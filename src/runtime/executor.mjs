/**
 * 命令执行器：运行时唯一的外部命令出口。
 *
 * 职责：把「要执行的 argv」收敛到这里，其余模块只描述命令、不 spawn。
 * 这样三件事才有保证：
 *   1. dry-run 能覆盖全部路径 —— 不执行任何命令，只记录；
 *   2. 测试不依赖 root / docker / iptables，注入假执行器即可跑全部分支；
 *   3. 每条命令都有统一日志（含耗时）与非零退出码的错误形状。
 *
 * 关键约束：
 * 1. 不使用 shell 拼接。run() 走 argv 数组，参数里的空格、引号、中文都不需要转义。
 *    runShell() 是显式 opt-in，只在确实需要 shell 语义时用（which 的实现就是这种）。
 * 2. 超时一律 SIGKILL，并抛 ETIMEDOUT。挂起比失败更难排查：iptables 卡在 xtables
 *    lock 上时，进程会静静等几十分钟，而调用方只看到「没进展」。
 * 3. 非零退出码默认抛错，错误里带 stderr 尾部。调用方明确知道「这条命令允许失败」
 *    时传 check:false，例如探测类命令（inspect / pgrep / kill -0）。
 */

import { spawn } from 'node:child_process'

/** 默认超时：60s。够 docker network create / iptables 一批规则跑完。 */
export const DEFAULT_TIMEOUT_MS = 60_000
/** stdout/stderr 单流捕获上限，防止 `docker logs` 之类把内存打满。 */
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 })

/** 单行渲染 argv（只用于日志与错误信息，不作为执行路径）。 */
export function shellJoin(argv) {
  return (Array.isArray(argv) ? argv : [])
    .map((a) => {
      const s = String(a)
      if (s === '') return "''"
      return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
    })
    .join(' ')
}

function formatMeta(meta) {
  if (meta == null) return ''
  if (typeof meta === 'string') return meta
  try {
    return JSON.stringify(meta)
  } catch {
    return String(meta)
  }
}

/**
 * 轻量日志器。接口固定为 {debug, info, warn, error, child}，
 * 测试里注入收集器即可断言「日志里带耗时」。
 */
export function createLogger({ level = 'info', sink = console, prefix = '' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info
  const write = (lvl, msg, meta) => {
    if ((LEVELS[lvl] ?? LEVELS.info) < threshold) return
    const text = meta === undefined ? `${prefix}${msg}` : `${prefix}${msg} ${formatMeta(meta)}`
    if (lvl === 'error' || lvl === 'warn') {
      const fn = sink.error || sink.log
      if (typeof fn === 'function') fn.call(sink, text)
      return
    }
    if (typeof sink.log === 'function') sink.log.call(sink, text)
  }
  return {
    level,
    prefix,
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    child: (p) => createLogger({ level, sink, prefix: `${prefix}${p}` }),
  }
}

/** 什么都不输出的日志器，用于测试与静默模式。 */
export const nullLogger = createLogger({ level: 'silent' })

/** 命令失败。message 里带 stderr 尾部，便于一眼看到 iptables/docker 的实际抱怨。 */
export class ExecError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = 'ExecError'
    this.argv = info.argv || []
    this.code = info.code ?? null
    this.signal = info.signal ?? null
    this.stdout = info.stdout || ''
    this.stderr = info.stderr || ''
    this.elapsedMs = info.elapsedMs ?? 0
    this.timedOut = Boolean(info.timedOut)
  }
}

function tail(text, limit = 800) {
  const s = String(text || '').trim()
  return s.length > limit ? `…${s.slice(-limit)}` : s
}

/**
 * 默认 runner：真实 spawn。抽成独立函数是为了让 Executor 能被完整替换，
 * 而不是在类里留一条「测试就走另一条分支」的暗道。
 */
export function spawnRunner({ cmd, args, timeoutMs, env, cwd, input }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: 127, signal: null, stdout: '', stderr: String(error?.message || error), timedOut: false, spawnError: error })
      return
    }

    let stdout = ''
    let stderr = ''
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    let settled = false
    let timer = null

    const finish = (code, signal) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGKILL')
        } catch {}
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }

    child.stdout?.on('data', (chunk) => {
      if (outBytes >= MAX_CAPTURE_BYTES) return
      outBytes += chunk.length
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (errBytes >= MAX_CAPTURE_BYTES) return
      errBytes += chunk.length
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      stderr += String(error?.message || error)
      finish(127, null)
    })
    child.on('close', (code, signal) => finish(code, signal))

    if (input !== undefined) {
      try {
        child.stdin?.end(input)
      } catch {}
    }
  })
}

/**
 * 命令执行器。
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun=false]  只记录不执行
 * @param {object}  [opts.logger]        createLogger 产物
 * @param {Function}[opts.runner]        替换底层 spawn（测试用）
 * @param {number}  [opts.timeoutMs]     默认超时
 * @param {object}  [opts.env]           子进程环境变量，默认继承
 * @param {string}  [opts.cwd]           子进程工作目录
 */
export class Executor {
  constructor({ dryRun = false, logger = nullLogger, runner = spawnRunner, timeoutMs = DEFAULT_TIMEOUT_MS, env, cwd } = {}) {
    this.dryRun = Boolean(dryRun)
    this.logger = logger || nullLogger
    this.runner = runner
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS
    this.env = env || process.env
    this.cwd = cwd
    /** 全部调用记录（含 dry-run 的「计划」）。审计与测试都读它。 */
    this.calls = []
  }

  /**
   * 执行一条命令。
   *
   * @param {string} cmd
   * @param {string[]} args
   * @param {object} opts
   *   check     {boolean} 非零退出码是否抛错，默认 true
   *   timeoutMs {number}  覆盖默认超时
   *   detach    {boolean} 后台启动并立即返回 pid（转发器进程用）
   *   quiet     {boolean} 不打印命令行（探测类命令用）
   * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, argv:string[], elapsedMs:number, pid?:number, dryRun?:boolean, timedOut?:boolean}>}
   */
  async run(cmd, args = [], opts = {}) {
    const argv = [String(cmd), ...(Array.isArray(args) ? args.map(String) : [])]
    const check = opts.check !== false
    const quiet = opts.quiet === true
    const detach = opts.detach === true
    const timeoutMs = opts.timeoutMs == null ? this.timeoutMs : Number(opts.timeoutMs)
    const startedAt = Date.now()

    if (!quiet) this.logger.info(`$ ${shellJoin(argv)}`)
    const record = { argv, at: startedAt, dryRun: this.dryRun, detach, quiet }
    this.calls.push(record)

    if (this.dryRun) {
      if (!quiet) this.logger.info(`  · dry-run：未执行`)
      Object.assign(record, { ok: true, code: 0, elapsedMs: 0, skipped: true })
      return { ok: true, code: 0, stdout: '', stderr: '', argv, elapsedMs: 0, dryRun: true, skipped: true }
    }

    if (detach) {
      let child
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: opts.cwd || this.cwd,
          env: opts.env || this.env,
          detached: true,
          stdio: 'ignore',
        })
        child.unref()
      } catch (error) {
        const elapsedMs = Date.now() - startedAt
        record.ok = false
        record.code = 127
        record.elapsedMs = elapsedMs
        throw new ExecError(`启动失败: ${shellJoin(argv)}: ${error?.message || error}`, {
          argv,
          code: 127,
          elapsedMs,
          stderr: String(error?.message || error),
        })
      }
      const elapsedMs = Date.now() - startedAt
      this.logger.info(`  ↳ detached pid=${child.pid} (${elapsedMs}ms)`)
      Object.assign(record, { ok: true, code: 0, elapsedMs, pid: child.pid })
      return { ok: true, code: 0, pid: child.pid, stdout: '', stderr: '', argv, elapsedMs, detached: true }
    }

    const raw = await this.runner({
      cmd: argv[0],
      args: argv.slice(1),
      timeoutMs,
      env: opts.env || this.env,
      cwd: opts.cwd || this.cwd,
      dryRun: false,
    })

    const elapsedMs = Date.now() - startedAt
    const timedOut = Boolean(raw?.timedOut)
    const code = raw?.code === undefined ? null : raw.code
    const stdout = String(raw?.stdout || '')
    const stderr = String(raw?.stderr || '')
    const ok = !timedOut && code === 0

    this.logger.info(`  ↳ ${timedOut ? 'timeout' : `exit=${code}`} (${elapsedMs}ms)`, ok ? undefined : tail(stderr, 200))
    Object.assign(record, { ok, code, elapsedMs, timedOut })

    if (!ok && check) {
      const reason = timedOut
        ? `命令超时（${timeoutMs}ms）: ${shellJoin(argv)}`
        : `命令失败（exit=${code}）: ${shellJoin(argv)}${stderr ? `\n  stderr: ${tail(stderr)}` : ''}`
      const error = new ExecError(reason, { argv, code, signal: raw?.signal, stdout, stderr, elapsedMs, timedOut })
      if (timedOut) error.code = 'ETIMEDOUT'
      throw error
    }

    return { ok, code, stdout, stderr, argv, elapsedMs, timedOut }
  }

  /** 执行一段 shell 脚本。*仅在确实需要 shell 语义时*使用。 */
  async runShell(script, opts = {}) {
    return this.run('/bin/sh', ['-c', String(script)], opts)
  }

  /**
   * 检查命令是否存在。
   * dry-run 下不探测，直接返回 found（否则演练会被宿主机环境卡住）。
   */
  async which(bin, opts = {}) {
    const name = String(bin || '').trim()
    if (!name) return { ok: false, bin: name, found: '' }
    if (this.dryRun) {
      this.calls.push({ argv: ['command', '-v', name], dryRun: true, skipped: true })
      return { ok: true, bin: name, found: '(dry-run)', dryRun: true }
    }
    const r = await this.run('/bin/sh', ['-c', `command -v ${shellJoin([name])}`], {
      check: false,
      timeoutMs: opts.timeoutMs || 5_000,
      quiet: opts.quiet === true,
    })
    const found = r.ok ? String(r.stdout || '').trim() : ''
    return { ok: Boolean(found), bin: name, found, code: r.code, stderr: r.stderr }
  }

  /** 已执行（非 dry-run 记录）的命令数。 */
  get executedCount() {
    return this.calls.filter((c) => !c.dryRun).length
  }
}

export default Executor
