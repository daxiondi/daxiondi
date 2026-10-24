/**
 * KVM 槽位生命周期
 *
 * 一次完整周期：create → start → (running) → stop → destroy。
 *
 * 与 Docker 槽位的关键差别：
 *
 *   Docker 的 create 是 `docker create` + 挂载，进程即容器，容器死即资源释放。
 *   KVM 的 create 要建一块 qcow2 盘（copy-on-write 基于基础镜像），启动要拉起
 *   qemu 进程、等它把客户机内核跑起来，关机要走 ACPI 电源键让客户机自己
 *   干净地卸载文件系统 —— 直接 kill 会让 qcow2 留下一堆未回收的元数据。
 *
 * 因此这里把三件事分开，且都不允许隐式发生：
 *
 *   1. 磁盘：qcow2 是稀疏文件，标称 40 GiB 刚建出来只有几百 KiB。
 *      基础镜像变更时旧 overlay 必须重建（base.id 对不上就重建），
 *      否则客户机会从一个已经被替换的父镜像启动，读到混叠数据。
 *
 *   2. 关机顺序：QMP `system_powerdown`（客户机收到 ACPI 电源键，走自己的
 *      关机流程）→ 超时后 QMP `quit`（QEMU 自行退出，客户机等同断电）→
 *      再超时 SIGKILL。三级降级，每一级都记日志。用 kill -TERM 直接打 qemu
 *      不是优雅关机，QEMU 收到 SIGTERM 会立即退出，等价于拔电源。
 *
 *   3. PID 文件：防止同一槽位被拉起两次。两次 start 会争用同一块 qcow2，
 *      后果是文件系统损坏 —— 不是启动失败，而是数据坏掉，所以必须前置拦截。
 *
 * 所有外部命令走注入点（opts.run / opts.fs），因此本模块在测试里可以完整
 * 跑一遍状态机而不需要装 QEMU。
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import {
  KVM_RESOURCE_RULES,
  detectDiskConflicts,
  kvmDiskSerialFor,
  kvmInstanceIdFor,
  kvmMacFor,
  kvmMemoryMb,
  kvmPathsFor,
  kvmVcpus,
  qemuArgsForPersona,
} from './kvm-spec.mjs'

// ─────────────── 状态机 ───────────────

/**
 * 槽位状态。刻意区分 `stopped` 与 `destroyed`：
 *   stopped   盘还在，可以再 start，客户机里的数据保留。
 *   destroyed 盘已删除，再 start 必须先 create，客户机数据从基础镜像重来。
 * 混成一个 "not running" 会让「重启」和「重装」变成同一个动作。
 */
export const SLOT_STATES = Object.freeze([
  'absent',     // 槽位目录不存在
  'created',    // 盘与 cloud-init seed 已就绪，未启动
  'starting',   // qemu 已拉起，尚未确认客户机就绪
  'running',    // qemu 进程存活
  'stopping',   // 已发出关机请求，等待进程退出
  'stopped',    // 干净关机完成，盘保留
  'destroyed',  // 产物已清理
  'error',      // 上次操作失败，需人工介入
])

/** 合法迁移表。任何不在此表里的迁移都是 bug，直接抛错而不是静默降级。 */
export const STATE_TRANSITIONS = Object.freeze({
  absent: Object.freeze(['created', 'error']),
  created: Object.freeze(['starting', 'destroyed', 'error']),
  starting: Object.freeze(['running', 'stopped', 'error']),
  running: Object.freeze(['stopping', 'error']),
  stopping: Object.freeze(['stopped', 'error']),
  stopped: Object.freeze(['starting', 'created', 'destroyed', 'error']),
  destroyed: Object.freeze(['created', 'error']),
  error: Object.freeze(['destroyed', 'created', 'stopped']),
})

/** 当前状态能否迁到目标状态。 */
export function canTransition(from, to) {
  const allowed = STATE_TRANSITIONS[from]
  if (!allowed) return false
  return allowed.includes(to)
}

/** 断言迁移合法。 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const err = new Error(`illegal slot state transition: ${from} → ${to}`)
    err.code = 'ILLEGAL_TRANSITION'
    err.from = from
    err.to = to
    throw err
  }
  return true
}

// ─────────────── 默认执行器 ───────────────

/** 默认命令执行器：返回 {ok, code, stdout, stderr}，不抛。 */
function defaultRun({ command, args, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

/** 默认进程存活判定：kill(pid, 0) 不发信号，只探测。 */
function defaultIsAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    // EPERM 表示进程存在但不属于当前用户 —— 仍然算活着。
    return e.code === 'EPERM'
  }
}

/** 默认信号发送器。 */
function defaultKill(pid, signal) {
  process.kill(Number(pid), signal)
}

// ─────────────── QMP 客户端 ───────────────

/**
 * 极简 QMP 客户端。
 *
 * 只用到两个命令：`system_powerdown`（ACPI 电源键）与 `quit`（QEMU 立即退出）。
 * 握手是 QMP 规定的：连上后服务端先发 greeting，客户端必须发
 * `qmp_capabilities` 才能执行其它命令。
 */
export function qmpCommand(socketPath, command, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ path: String(socketPath) })
    let buf = ''
    let sent = false
    let pendingReplies = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* 忽略 */ }
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'qmp timeout' }), timeoutMs)
    timer.unref?.()

    sock.on('connect', () => { /* greeting 随后到 */ })
    sock.on('data', (chunk) => {
      buf += String(chunk)
      // 按行消费：QMP 每条消息以 \n 结尾，一个 TCP 段里可能塞着好几条。
      // 不按行切就会把 greeting 和回执当成一条，回复的判定也就无从谈起。
      const lines = buf.split('\n')
      buf = lines.pop() // 最后一段可能不完整，留到下次
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue
        let msg = null
        try { msg = JSON.parse(text) } catch { continue }

        // greeting 是 `{"QMP": {...}}`，收到了才说明可以发 capabilities。
        if (!sent && msg.QMP) {
          sent = true
          sock.write(`${JSON.stringify({ execute: 'qmp_capabilities' })}\n`)
          sock.write(`${JSON.stringify({ execute: command })}\n`)
          continue
        }
        if (!sent) continue

        // capabilities 的回执是 {"return":{}}，忽略；命令本身的回执才是我们要的。
        // 命令失败时 QEMU 回 {"error":{...}} —— 必须判成失败。把 error 当成
        // 成功的后果很具体：system_powerdown 被拒绝时 stop() 会以为电源键
        // 已按，白等一整个 powerdownTimeoutMs 才降级到 quit。
        if (msg.error) {
          clearTimeout(timer)
          const desc = msg.error.desc || msg.error.class || 'qmp command failed'
          finish({ ok: false, error: String(desc), raw: text })
          return
        }
        if (Object.hasOwn(msg, 'return')) {
          // 先到的那条是 capabilities 回执，命令回执紧随其后。用 pending 计数
          // 免得把 capabilities 的成功当成了命令的成功。
          pendingReplies += 1
          if (pendingReplies >= 2) {
            clearTimeout(timer)
            finish({ ok: true, raw: text, return: msg.return })
            return
          }
        }
      }
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: err.message })
    })
    sock.on('close', () => {
      clearTimeout(timer)
      finish({ ok: false, error: 'qmp closed before reply' })
    })
  })
}

// ─────────────── cloud-init seed ───────────────

/**
 * cloud-init 的 user-data。
 *
 * 只做首启配置：用户名、SSH key、hostname。主机名与身份相关的其余字段由
 * SMBIOS 与 QEMU 提供，不在这里重复 —— 两处都写就会有两处可能不一致。
 */
export function renderCloudInitUserData({
  hostname,
  sshPublicKey,
  username = 'ubuntu',
  bootstrap = null,
}) {
  const host = String(hostname || 'localhost')
  const key = String(sshPublicKey || '').trim()
  if (!key) throw new Error('cloud-init seed requires an ssh public key')
  const lines = [
    '#cloud-config',
    `hostname: ${host}`,
    `fqdn: ${host}`,
    'manage_etc_hosts: true',
    'preserve_hostname: false',
    'ssh_pwauth: false',
    'disable_root: true',
    'users:',
    `  - name: ${username}`,
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    shell: /bin/bash',
    '    lock_passwd: true',
    '    ssh_authorized_keys:',
    `      - ${key}`,
    'package_update: false',
  ]

  // ── 内核 bootstrap ────────────────────────────────────
  //
  // KVM 槽位起来是个干净的 Ubuntu，里面什么都没有。而 Codex 侧走 Docker 时
  // 镜像是我们自己构建的、内核就在里面；KVM 侧没有等价物，不补这一步的话
  // 虚拟机跑起来只是个空壳，"claude 走 kvm" 就无从谈起。
  //
  // 走 cloud-init 的 write_files 而不是别的方式，理由：
  //   - 不需要客户机在启动时能访问外网（内容随 seed 盘送达）
  //   - 幂等：instance-id 变了才会重跑，不会每次重启都覆盖
  //   - 与 hostname / ssh key 同一份 seed，不会出现"用户配好了但内核没到"
  if (bootstrap && Array.isArray(bootstrap.files) && bootstrap.files.length) {
    lines.push('write_files:')
    for (const f of bootstrap.files) {
      const p = String(f.path || '')
      if (!p.startsWith('/')) continue
      lines.push(`  - path: ${p}`)
      // 内核脚本要可执行；配置文件不必
      lines.push(`    permissions: '${f.mode || '0644'}'`)
      lines.push('    content: |')
      for (const line of String(f.content ?? '').split('\n')) {
        lines.push(`      ${line}`)
      }
    }
  }

  lines.push('runcmd:')
  lines.push(`  - [hostnamectl, set-hostname, ${host}]`)
  if (bootstrap && Array.isArray(bootstrap.commands)) {
    for (const c of bootstrap.commands) {
      const parts = Array.isArray(c) ? c : [c]
      // cloud-init 的 runcmd 接受 列表 或 字符串；统一成列表避免引号地狱
      if (parts.length === 1) lines.push(`  - ${parts[0]}`)
      else lines.push(`  - [${parts.join(', ')}]`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** cloud-init 的 meta-data。instance-id 必须逐槽位不同，否则第二台会跳过初始化。 */
export function renderCloudInitMetaData({ vmId, hostname }) {
  return [
    `instance-id: ${kvmInstanceIdFor(vmId)}`,
    `local-hostname: ${hostname}`,
    'dsmode: local',
    '',
  ].join('\n')
}

// ─────────────── KvmSlot ───────────────

/**
 * 一个 KVM 槽位。
 *
 * 构造时不做任何 I/O —— 一切副作用都发生在 create/start/stop/destroy 里，
 * 这样调用方可以先 plan 一遍再决定要不要真的建。
 */
export class KvmSlot {
  /**
   * @param {object} p
   * @param {object} p.persona             已构造好的 persona
   * @param {string} [p.rootDir]           槽位产物根目录
   * @param {string} p.imagePath           基础 cloud image（qcow2）
   * @param {string} [p.bridge]            网络桥
   * @param {number} [p.memoryMb]
   * @param {number} [p.vcpus]
   * @param {string} [p.accel='kvm']
   * @param {string} [p.sshPublicKey]
   * @param {string} [p.username='ubuntu']
   * @param {string} [p.sshPort]           hostfwd 端口（bridge 模式下由 guest IP 直连）
   * @param {object} [p.rules]             资源规则覆盖
   * @param {Function} [p.run]             命令执行器注入点
   * @param {Function} [p.isAlive]         进程存活探测注入点
   * @param {object} [p.fs]                fs 注入点（测试用）
   */
  constructor(p = {}) {
    if (!p.persona) throw new Error('KvmSlot requires a persona')
    this.persona = p.persona
    this.vmId = String(p.persona.vm_id || p.vmId || 'default')
    this.rootDir = String(p.rootDir || '/var/lib/persona-kvm')
    this.imagePath = String(p.imagePath || '')
    this.bridge = p.bridge ? String(p.bridge) : null
    this.accel = String(p.accel || 'kvm')
    this.sshPublicKey = String(p.sshPublicKey || '')
    this.username = String(p.username || 'ubuntu')
    this.rules = { ...KVM_RESOURCE_RULES, ...(p.rules || {}) }
    this.memoryMb = Number.isInteger(p.memoryMb) ? p.memoryMb : kvmMemoryMb(p.persona, this.rules)
    this.vcpus = Number.isInteger(p.vcpus) ? p.vcpus : kvmVcpus(this.persona, this.rules)
    this.mac = String(p.macAddress || kvmMacFor(this.vmId)).toUpperCase()
    this.diskSerial = kvmDiskSerialFor(this.vmId)
    this.diskGb = Number.isInteger(p.diskGb) ? p.diskGb : this.rules.diskGb

    this.paths = kvmPathsFor({ rootDir: this.rootDir, vmId: this.vmId })
    this.fs = p.fs || fs
    this.run = p.run || defaultRun
    this.isAlive = p.isAlive || defaultIsAlive
    this.kill = p.kill || defaultKill

    this.state = 'absent'
    this.log = []
    this.lastError = null
  }

  // ── 内部工具 ──

  #note(msg) {
    this.log.push({ at: new Date().toISOString(), state: this.state, msg })
  }

  #fsm(to) {
    assertTransition(this.state, to)
    const from = this.state
    this.state = to
    this.#note(`state ${from} → ${to}`)
    return to
  }

  #pid() {
    try {
      const raw = this.fs.readFileSync(this.paths.pidFile, 'utf8').trim()
      const n = Number(raw)
      return Number.isInteger(n) && n > 0 ? n : 0
    } catch {
      return 0
    }
  }

  /** 生成 QEMU 参数。每次现算，保证磁盘路径与当前配置一致。 */
  spec() {
    return qemuArgsForPersona({
      persona: this.persona,
      vmId: this.vmId,
      diskPath: this.paths.diskPath,
      imagePath: this.imagePath,
      memoryMb: this.memoryMb,
      vcpus: this.vcpus,
      macAddress: this.mac,
      bridge: this.bridge,
      accel: this.accel,
      rootDir: this.rootDir,
    })
  }

  async #exec(command, args, opts = {}) {
    const r = await this.run({ command, args, ...opts })
    return {
      ok: Boolean(r?.ok),
      code: r?.code ?? (r?.ok ? 0 : 1),
      stdout: String(r?.stdout ?? ''),
      stderr: String(r?.stderr ?? ''),
      command,
      args,
    }
  }

  // ── create ──

  /**
   * 建盘 + 写 cloud-init seed。
   *
   * qcow2 用 `-b base -F qcow2` 指到基础镜像：盘是写时复制的，40 GiB 标称
   * 刚建出来只有几百 KiB。基础镜像 id 变了必须重建 overlay，否则客户机会
   * 从一个已被替换的父镜像启动。
   */
  async create() {
    if (!this.imagePath) throw new Error(`slot ${this.vmId} needs an imagePath to create a disk`)
    if (this.state === 'running' || this.state === 'starting') {
      throw new Error(`slot ${this.vmId} is ${this.state}; stop it before re-creating the disk`)
    }
    assertTransition(this.state, 'created')

    this.fs.mkdirSync(this.paths.slotDir, { recursive: true })

    const baseId = await this.#baseImageId()
    const recorded = this.#readText(`${this.paths.slotDir}/base.id`)
    const needsRecreate = !this.fs.existsSync(this.paths.diskPath) || recorded !== baseId

    const steps = []
    if (needsRecreate) {
      if (this.fs.existsSync(this.paths.diskPath)) {
        this.fs.rmSync(this.paths.diskPath, { force: true })
        this.#note('base image changed; previous overlay removed')
      }
      const create = await this.#exec('qemu-img', [
        'create', '-f', 'qcow2', '-F', 'qcow2',
        '-b', this.imagePath,
        this.paths.diskPath,
        `${this.diskGb}G`,
      ])
      if (!create.ok) {
        this.state = 'error'
        this.lastError = create.stderr || 'qemu-img create failed'
        throw new Error(`slot ${this.vmId} disk create failed: ${this.lastError}`)
      }
      steps.push('disk')
      this.fs.writeFileSync(`${this.paths.slotDir}/base.id`, `${baseId}\n`)
    }

    const seed = await this.#writeSeed()
    if (seed) steps.push('seed')

    this.#fsm('created')
    return { ok: true, vmId: this.vmId, state: this.state, steps, diskPath: this.paths.diskPath }
  }

  /** 基础镜像的身份：路径 + 大小 + mtime。任一变化都意味着 overlay 要重建。 */
  async #baseImageId() {
    try {
      const st = this.fs.statSync(this.imagePath)
      return `${path.basename(this.imagePath)}:${st.size}:${Math.trunc(st.mtimeMs || 0)}`
    } catch {
      // 读不到镜像时用路径兜底：至少能让“镜像换了”被下一轮 create 发现。
      return `${path.basename(this.imagePath)}:missing`
    }
  }

  #readText(file) {
    try {
      return this.fs.readFileSync(file, 'utf8').trim()
    } catch {
      return ''
    }
  }

  /**
   * 写 cloud-init seed ISO。
   *
   * 三个文件必须直接位于 ISO 根目录：把一个目录塞进 ISO，客户机挂载后
   * 文件会多一层前缀，cloud-init 找不到 user-data 就整份配置被跳过。
   */
  async #writeSeed() {
    if (!this.sshPublicKey) {
      this.#note('no ssh public key; seed iso not written')
      return false
    }
    const hostname = String(this.persona.naming?.hostname || this.persona.naming?.computer_name || this.vmId)
    const stage = this.fs.mkdtempSync(path.join(os.tmpdir(), 'persona-kvm-seed-'))
    try {
      this.fs.writeFileSync(path.join(stage, 'user-data'),
        renderCloudInitUserData({ hostname, sshPublicKey: this.sshPublicKey, username: this.username }))
      this.fs.writeFileSync(path.join(stage, 'meta-data'),
        renderCloudInitMetaData({ vmId: this.vmId, hostname }))
      const iso = await this.#exec('genisoimage', [
        '-quiet', '-output', this.paths.seedIsoPath,
        '-volid', 'cidata', '-joliet', '-rock', '.',
      ], { cwd: stage })
      if (!iso.ok) {
        throw new Error(`slot ${this.vmId} seed iso failed: ${iso.stderr || 'genisoimage error'}`)
      }
      return true
    } finally {
      try { this.fs.rmSync(stage, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }

  // ── start ──

  /**
   * 启动。PID 文件已存在且进程存活时直接拒绝 —— 两次启动会争用同一块 qcow2。
   */
  async start({ waitMs = 1500 } = {}) {
    if (this.state === 'running') {
      throw new Error(`slot ${this.vmId} is already running (pid ${this.#pid()})`)
    }
    if (this.state === 'absent' || this.state === 'destroyed') {
      throw new Error(`slot ${this.vmId} is ${this.state}; call create() first`)
    }
    assertTransition(this.state, 'starting')

    const livePid = this.#pid()
    if (livePid && this.isAlive(livePid)) {
      throw new Error(`slot ${this.vmId} has a live pid ${livePid}; refusing to start a second qemu`)
    }

    const spec = this.spec()
    this.#fsm('starting')

    const started = await this.#exec(spec.argv[0], spec.argv.slice(1))
    if (!started.ok) {
      this.state = 'error'
      this.lastError = started.stderr || 'qemu failed to start'
      throw new Error(`slot ${this.vmId} qemu start failed: ${this.lastError}`)
    }

    // -pidfile 由 QEMU 自己写；这里只等它落盘并确认进程存活。
    const deadline = Date.now() + waitMs
    let pid = 0
    while (Date.now() < deadline) {
      pid = this.#pid()
      if (pid && this.isAlive(pid)) break
      await new Promise((r) => setTimeout(r, 50))
    }
    if (!pid || !this.isAlive(pid)) {
      this.state = 'error'
      this.lastError = 'qemu exited right after start'
      throw new Error(`slot ${this.vmId} qemu exited immediately; see ${this.paths.logPath}`)
    }

    this.#fsm('running')
    return { ok: true, vmId: this.vmId, state: this.state, pid, argv: spec.argv }
  }

  // ── stop ──

  /**
   * 优雅关机三级降级：QMP system_powerdown → QMP quit → SIGKILL。
   *
   * 不用 kill -TERM 打 qemu：QEMU 收到 SIGTERM 立即退出，客户机等同断电，
   * qcow2 里会留下未回收的元数据。ACPI 电源键是让客户机自己走关机流程。
   */
  async stop({ powerdownTimeoutMs = 25_000, quitTimeoutMs = 3000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    if (this.state === 'stopped' || this.state === 'destroyed' || this.state === 'absent') {
      return { ok: true, vmId: this.vmId, state: this.state, steps: [] }
    }
    if (this.state !== 'running') {
      throw new Error(`slot ${this.vmId} is ${this.state}; nothing to stop`)
    }
    assertTransition(this.state, 'stopping')

    const pid = this.#pid()
    const steps = []
    this.#fsm('stopping')

    let exited = !pid || !this.isAlive(pid)

    if (!exited && this.fs.existsSync(this.paths.qmpSocket)) {
      const pd = await qmpCommand(this.paths.qmpSocket, 'system_powerdown')
      steps.push({ step: 'system_powerdown', ok: pd.ok, error: pd.error || null })
      const deadline = now() + powerdownTimeoutMs
      while (now() < deadline) {
        if (!this.isAlive(pid)) { exited = true; break }
        await sleep(200)
      }
    }

    if (!exited && this.fs.existsSync(this.paths.qmpSocket)) {
      const q = await qmpCommand(this.paths.qmpSocket, 'quit')
      steps.push({ step: 'qmp-quit', ok: q.ok, error: q.error || null })
      const deadline = now() + quitTimeoutMs
      while (now() < deadline) {
        if (!this.isAlive(pid)) { exited = true; break }
        await sleep(100)
      }
    }

    if (!exited) {
      // 最后一段：客户机已经不再响应 ACPI，只能在 QEMU 层终止。
      try {
        this.kill(pid, 'SIGKILL')
        steps.push({ step: 'sigkill', ok: true, pid })
      } catch (e) {
        steps.push({ step: 'sigkill', ok: false, error: e.message })
      }
      exited = !this.isAlive(pid)
    }

    if (!exited) {
      // 三级降级都没能让进程退出。这时绝不能进入 stopped，更不能删 PID 文件：
      //   1. 进程还活着，qvow2 仍被它打开着。标成 stopped 会让调用方以为盘可用。
      //   2. PID 文件一旦删掉，start() 的「同一槽位不能被拉起两次」检查就失效，
      //      下一次 start 会再起一个 qemu 写同一块盘 —— 数据损坏，不是启动失败。
      // 状态落在 error，并保留 PID 文件，让后续操作必须显式处理。
      this.state = 'error'
      this.lastError = `qemu pid ${pid} survived SIGKILL`
      return {
        ok: false,
        vmId: this.vmId,
        state: this.state,
        pid,
        steps,
        error: this.lastError,
        needsManualIntervention: true,
      }
    }

    this.#fsm('stopped')
    try { this.fs.rmSync(this.paths.pidFile, { force: true }) } catch { /* 忽略 */ }
    return { ok: true, vmId: this.vmId, state: this.state, pid, steps }
  }

  // ── status ──

  /**
   * 运行状态。以 PID 文件 + 进程存活为准，不看目录是否存在 ——
   * 目录存在但 qemu 已死是常态（崩溃、宿主重启），那属于 stopped 而不是 running。
   */
  async status() {
    const pid = this.#pid()
    const alive = Boolean(pid && this.isAlive(pid))
    const hasDisk = this.fs.existsSync(this.paths.diskPath)
    const derived = alive ? 'running' : (hasDisk ? 'stopped' : (this.state === 'destroyed' ? 'destroyed' : 'absent'))
    return {
      vmId: this.vmId,
      state: derived,
      reportedState: this.state,
      pid,
      alive,
      hasDisk,
      diskPath: this.paths.diskPath,
      pidFile: this.paths.pidFile,
      qmpSocket: this.paths.qmpSocket,
      logPath: this.paths.logPath,
      mac: this.mac,
      memoryMb: this.memoryMb,
      vcpus: this.vcpus,
    }
  }

  // ── destroy ──

  /**
   * 清理。运行中先停 —— 直接删盘会让 qemu 写一个已经不存在的文件，
   * 客户机内核在崩溃日志里留下大量 I/O 错误，而宿主机看到的是删干净了。
   */
  async destroy() {
    const steps = []

    // 判断「有没有进程在跑」必须问 PID 文件，而不是只看 state 字段。
    //
    // 自检抓到的一条真实路径：强杀失败后 state 落在 error，但 qemu 进程
    // 还活着并打开着 qcow2。此时若按 state 判断跳过 stop，就会直接删盘 ——
    // qemu 接着往一个已删除的 inode 写，客户机刷出大量 I/O 错误，而宿主机
    // 这边「清理成功」了。所以先问进程，再决定要不要停；停不掉就不动盘。
    const livePid = this.#pid()
    const processAlive = Boolean(livePid && this.isAlive(livePid))
    const needsStop = processAlive || this.state === 'running' || this.state === 'starting'

    if (needsStop) {
      // stop() 只接受 running。进程还活着但 state 是 error（强杀失败留下的），
      // 先对齐成 running，才能走正常的三级降级流程。
      if (processAlive && this.state !== 'running') this.state = 'running'
      const stopped = await this.stop()
      steps.push({ step: 'stop', ok: stopped.ok })
      if (!stopped.ok) {
        // 进程杀不掉。绝不能删盘，PID 文件也留着，把决定权交回人工。
        return {
          ok: false,
          vmId: this.vmId,
          state: this.state,
          steps,
          error: 'qemu is still alive; refusing to delete the disk',
          needsManualIntervention: true,
        }
      }
    }

    const result = {
      ok: true,
      vmId: this.vmId,
      state: this.state,
      steps,
      removed: [],
    }
    if (!this.fs.existsSync(this.paths.slotDir)) {
      this.state = 'destroyed'
      return result
    }
    // 只删自己这一层目录。rootDir 共享，绝不动父目录。
    for (const file of [this.paths.diskPath, this.paths.seedIsoPath, this.paths.pidFile,
      this.paths.logPath, this.paths.qmpSocket, this.paths.varsFile, this.paths.sshKeyPath,
      `${this.paths.slotDir}/base.id`]) {
      try {
        if (this.fs.existsSync(file)) {
          this.fs.rmSync(file, { force: true })
          result.removed.push(file)
        }
      } catch { /* 单文件删除失败不阻断整体清理 */ }
    }
    try {
      this.fs.rmSync(this.paths.slotDir, { recursive: true, force: true })
      result.removed.push(this.paths.slotDir)
    } catch (e) {
      result.ok = false
      result.error = e.message
      this.state = 'error'
      return result
    }
    this.state = 'destroyed'
    return result
  }
}

/**
 * 批量创建槽位（只算不执行）。给 fleet 规划与 CLI 用。
 *
 * 返回每个槽位的路径与规格，同时跑一次磁盘路径冲突检测 ——
 * 20 个槽位的 rootDir 相同、vmId 不同，天然不冲突；但调用方若自己传了
 * 相同的 rootDir + 相同 vmId，这里必须报出来而不是让它写坏同一块盘。
 */
export function planKvmSlots({ slots, rootDir = '/var/lib/persona-kvm', rules = KVM_RESOURCE_RULES }) {
  const out = []
  for (const s of Array.isArray(slots) ? slots : []) {
    const paths = kvmPathsFor({ rootDir, vmId: s.vmId })
    out.push({
      vmId: s.vmId,
      ...paths,
      diskGb: rules.diskGb,
      memoryMb: s.memoryMb ?? kvmMemoryMb(s.persona, rules),
      vcpus: s.vcpus ?? kvmVcpus(s.persona, rules),
      mac: s.mac || kvmMacFor(s.vmId),
      diskSerial: kvmDiskSerialFor(s.vmId),
      instanceId: kvmInstanceIdFor(s.vmId),
    })
  }
  const conflict = detectDiskConflicts(out)
  return { slots: out, ok: conflict.ok, conflicts: conflict.conflicts }
}

// ─────────────── 内核 bootstrap ───────────────

/**
 * 生成把内核装进 KVM 客户机所需的 cloud-init 内容。
 *
 * KVM 侧的镜像不是我们构建的（用的是发行版 cloud image），所以内核代码
 * 必须随 seed 盘送进去。这里只做「内容生成」，不碰网络 —— 客户机不需要
 * 在启动时能访问外网。
 *
 * 为什么不在这里塞 node 二进制：Node 官方 linux-x64 tarball 有 ~25MB，
 * 直接写进 cloud-config 会让 seed 膨胀到几十 MB，且 base64 后更大。
 * 更实际的做法是让客户机自带（Ubuntu cloud image 无 node），
 * 或用 apt 装 —— 那就需要外网。这里提供两条路，由调用方选：
 *   - bootstrap.files 里带 node 和内核代码（适合离线环境，seed 大）
 *   - bootstrap.commands 里 apt/npm 装（需要外网，seed 小）
 *
 * 默认生成后者，因为绝大多数部署客户机是能出网的。
 *
 * @param {object} p
 * @param {string} p.kernelSource   内核 server.mjs 在本机的绝对路径
 * @param {string} [p.credentialJson] Codex 凭据（写进客户机）
 * @param {string} [p.socketPath]   内核 unix socket 路径（客户机内）
 * @param {string} [p.token]        内部 token
 * @param {number} [p.slots]        槽位数
 * @param {boolean} [p.offline]     为 true 时把内核源码写进 files 而非联网装
 */
export function buildKernelBootstrap({
  kernelSource,
  credentialJson = null,
  socketPath = '/run/skylink/api-kernel.sock',
  token = '',
  slots = 20,
  offline = false,
} = {}) {
  const files = []
  const commands = []

  const config = {
    vm_id: 'kvm-managed',
    socket_path: socketPath,
    internal_token: token,
    provider: 'local_cli',
    slots_per_worker: slots,
  }
  if (credentialJson) config.codex_credential_path = '/etc/skylink/codex-credentials.json'

  files.push({
    path: '/etc/skylink/kernel.json',
    mode: '0600',
    content: JSON.stringify(config, null, 2) + '\n',
  })

  if (credentialJson) {
    files.push({
      path: '/etc/skylink/codex-credentials.json',
      mode: '0600',
      content: typeof credentialJson === 'string' ? credentialJson : JSON.stringify(credentialJson, null, 2) + '\n',
    })
  }

  // systemd 单元：Restart=always 是必须的 —— 内核崩了没人拉起来，
  // 整个槽位就静默失效了，而面板上看着还是"运行中"。
  files.push({
    path: '/etc/systemd/system/skylink-kernel.service',
    mode: '0644',
    content: [
      '[Unit]',
      'Description=Skylink API kernel',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'ExecStart=/usr/bin/node /opt/skylink/src/kernel/server.mjs -config /etc/skylink/kernel.json',
      'Restart=always',
      'RestartSec=3',
      'LimitNOFILE=65535',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'),
  })

  if (offline && kernelSource) {
    // 离线：把源码写进 files。调用方负责保证 src/ 整棵树都在
    // （内核 import 了同目录的其他模块，单文件不够）。
    commands.push(['mkdir', '-p', '/opt/skylink'])
    commands.push(['tar', '-xzf', '/etc/skylink/src.tar.gz', '-C', '/opt/skylink'])
  } else {
    // 联网：装 node，代码由调用方另行分发（git clone / scp / 对象存储）
    commands.push(['bash', '-lc', 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'])
    commands.push(['bash', '-lc', 'apt-get install -y nodejs'])
  }

  commands.push(['systemctl', 'daemon-reload'])
  commands.push(['systemctl', 'enable', '--now', 'skylink-kernel'])

  return { files, commands }
}
