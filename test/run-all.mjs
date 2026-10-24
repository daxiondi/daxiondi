#!/usr/bin/env node
/**
 * 统一测试入口：依次 spawn 各测试文件，汇总「通过 N / 失败 M」。
 *
 * 用法：
 *   node test/run-all.mjs                  # 全量（含 smoke）
 *   node test/run-all.mjs --fast           # 跳过 smoke
 *   node test/run-all.mjs --filter cch     # 只跑名字含 "cch" 的
 *   node test/run-all.mjs --filter smoke   # 只跑 smoke
 *
 * 退出码：全部通过为 0，任一失败为 1。
 *
 * 结果判定规则（关键）：
 *   1. 每个文件最后一行必须是「通过 N / 失败 M」。能解析出来 → 用 N/M 计数。
 *   2. 进程退出码非 0 → 该文件判定为失败，即使 N/M 显示 0 失败。
 *   3. 退出码为 0，但没有输出「通过」行 → 判定为「无结果」，标成异常，不当作成功。
 *      本仓库每个测试都在末尾打印该行，缺行意味着测试主体没跑到（import 阶段
 *      就崩了、或者被 process.exit 提前带走），静默成功会把真实故障掩盖掉。
 *   4. 进程被信号杀死 / 超时 → 判定为失败，并单独标注。
 */

import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 单个测试文件的最长运行时间。smoke 要起进程，给得宽一些。 */
const TIMEOUT_MS = 120_000

/** 测试清单。name 用于 --filter 与总表显示。 */
const TESTS = [
  { name: 'selfcheck', file: 'selfcheck.mjs', smoke: false },
  { name: 'cch-check', file: 'cch-check.mjs', smoke: false },
  { name: 'cch-crosscheck', file: 'cch-crosscheck.mjs', smoke: false },
  // Chat Completions ↔ Responses 双向转换：纯函数，不碰网络
  { name: 'codex-convert', file: 'codex-convert.mjs', smoke: false },
  // Codex 传输层：假 fetch / 假 stream，不建立真实网络连接
  { name: 'codex-upstream', file: 'codex-upstream.mjs', smoke: false },
  { name: 'codex-sse', file: 'codex-sse.mjs', smoke: false },
  { name: 'codex-scheduler', file: 'codex-scheduler.mjs', smoke: false },
  // 入站模型名重写 + 额度窗口接线：纯函数 + 假 fetch，不碰网络
  { name: 'codex-model-mapping', file: 'codex-model-mapping.mjs', smoke: false },
  { name: 'smoke-server', file: 'smoke-server.mjs', smoke: true },
  // messages / system 的缓存断点布局：纯函数，不碰网络
  { name: 'cache-breakpoints', file: 'cache-breakpoints.mjs', smoke: false },
  // 缓存断点的端到端验证（10 条消息的实际 body 结构 + 封盖后的 cch）
  { name: 'breakpoints-demo', file: 'breakpoints-demo.mjs', smoke: false },
  // Codex 凭据加载与过期判定
  { name: 'codex-credentials', file: 'codex-credentials.mjs', smoke: false },
  // OAuth token 刷新：单飞、refresh_token 轮换、重试重读、保守 TTL、CAS
  { name: 'token-refresh', file: 'token-refresh.mjs', smoke: false },
  // Codex HTTP 路由层：假 fetch 驱动，不碰真实上游
  { name: 'codex-server', file: 'codex-server.mjs', smoke: false },
  // 生图路由：模型启停、Free 拒绝、multipart、sticky 选号
  { name: 'codex-images', file: 'codex-images.mjs', smoke: false },
  // CLI 启动失败降级、claude_bin 优先级、健康检查出口
  { name: 'fixes', file: 'fixes.mjs', smoke: false },
  // 出站结构归约与差异比对
  { name: 'outbound-shape', file: 'outbound-shape.mjs', smoke: false },
  // 按模型分档的提示词组装
  { name: 'prompt-profiles', file: 'prompt-profiles.mjs', smoke: false },
  // 出口隔离：代理池、20 槽位网段、iptables 规则、出口验证（全部离线，不拨号）
  { name: 'egress', file: 'egress.mjs', smoke: false },
  // 配额窗口模型与存储：头解析、阈值边界、惰性清零、调度器门禁
  { name: 'quota', file: 'quota.mjs', smoke: false },
  // persona 执行层：docker 参数、容器内注入与自检、多槽位资源规划。
  // 会真的写临时目录，并真的让 /bin/sh 执行生成的包装脚本，
  // 所以比纯函数测试慢（约 2s），但正是这一层能把「文件写了但命令没生效」抓出来。
  { name: 'persona-deploy', file: 'persona-deploy.mjs', smoke: false },
  // persona 的 KVM 形态：QEMU 参数、SMBIOS 四张表、逗号策略、生命周期状态机、
  // 混合编排（Claude 走 KVM + Codex 走 Docker）。纯函数 + 注入执行器，
  // 不需要装 QEMU / KVM，也不起真实虚拟机。
  { name: 'persona-kvm', file: 'persona-kvm.mjs', smoke: false },
  { name: 'hardware-spoof', file: 'hardware-spoof.mjs', smoke: false },
  { name: 'cch-vs-official', file: 'cch-vs-official.mjs', smoke: false },
  { name: 'sanitize', file: 'sanitize.mjs', smoke: false },
  // 出站 metadata.user_id 注入（敏感键过滤、字符串形态、槽位 device_id）
  // 与泄露型客户端 UA 剥离。纯函数 + 假 fetch，不碰网络
  { name: 'metadata-user-id', file: 'metadata-user-id.mjs', smoke: false },
  // 出站补齐层：thinking / effort / temperature / budget / max_tokens 五项
  // 缺省填充与模型能力矩阵，纯函数 + 假 fetch，不碰网络
  { name: 'thinking-policy', file: 'thinking-policy.mjs', smoke: false },
  { name: 'billing-vs-official', file: 'billing-vs-official.mjs', smoke: false },
  // 入站风险审计五关：顺序、开关联动、拒答缓存相似度、决策模型失败放行
  { name: 'risk', file: 'risk.mjs', smoke: false },
  // 内核适配层：5 端点契约、HTTP 服务（unix + tcp + 双 socket）、认证、
  // 取消在途 job、超时降级，以及用 vm2api 的真实 client 打我们的内核。
  // 会在子进程里装 module resolve hook，因此它自己也是独立进程跑的。
  { name: 'kernel', file: 'kernel.mjs', smoke: false },
  // 遥测：env 字段集合、事件结构、改写、发送器。全部离线，发送器用假 fetch
  { name: 'telemetry', file: 'telemetry.mjs', smoke: false },
  // 运行时装配线：执行器、预检、单槽位 8 步编排（顺序/幂等/回滚）、
  // 舰队并发编排。所有外部命令走假 Executor，不需要 root / docker / iptables。
  { name: 'runtime', file: 'runtime.mjs', smoke: false },
  // Anthropic HTTP 出站客户端：请求头、stream 标志、压缩条件、错误分类、
  // SSE 解析、非流式聚合、超时/abort、凭据三形态加载、base_url 校验。
  // 全部走注入的假 fetch，不建立真实网络连接。
  { name: 'anthropic', file: 'anthropic.mjs', smoke: false },
]

/** 匹配「通过 N / 失败 M」。容忍前后空白与任意前缀。 */
const RESULT_RE = /通过\s*(\d+)\s*\/\s*失败\s*(\d+)/

/**
 * 取最后一个匹配：有些测试中途也会打印小结，末尾那一行才是最终结果。
 */
function parseResult(text) {
  let last = null
  for (const m of text.matchAll(new RegExp(RESULT_RE, 'g'))) {
    last = { pass: Number(m[1]), fail: Number(m[2]) }
  }
  return last
}

/**
 * 跑一个测试文件。
 * 返回 { name, pass, fail, status, code, signal, elapsed, raw }，
 * status 取值：ok | failed | no-result | signal | timeout
 */
function runOne(test) {
  const filePath = path.join(HERE, test.file)
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(process.execPath, [filePath], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({
        name: test.name,
        pass: 0,
        fail: 1,
        status: 'timeout',
        code: null,
        signal: 'SIGKILL',
        elapsed: Date.now() - startedAt,
        raw: `${stdout}${stderr}`,
      })
    }, TIMEOUT_MS)

    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.stderr.on('data', (c) => {
      stderr += c
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        name: test.name,
        pass: 0,
        fail: 1,
        status: 'failed',
        code: null,
        signal: null,
        elapsed: Date.now() - startedAt,
        raw: `${stdout}${stderr}\n启动失败: ${error.message}`,
      })
    })

    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      const raw = `${stdout}${stderr}`
      const parsed = parseResult(stdout) || parseResult(raw)
      const elapsed = Date.now() - startedAt

      let status
      if (signal) status = 'signal'
      else if (!parsed) status = 'no-result'
      else if (code !== 0 || parsed.fail > 0) status = 'failed'
      else status = 'ok'

      resolve({
        name: test.name,
        // 没解析出结果时，按 0/1 计入汇总，细项见 status
        pass: parsed ? parsed.pass : 0,
        fail: parsed ? parsed.fail : 1,
        status,
        code,
        signal,
        elapsed,
        raw,
      })
    })
  })
}

/**
 * 显示宽度：中日韩字符与全角标点占 2 列，其余占 1 列。
 * 总表里有「合计」这类中文标签，用 .length 补空格会错位。
 */
function displayWidth(s) {
  let width = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0)
    // 常见宽字符区间：CJK 统一表意文字、全角形式、假名、韩文
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

/** 按显示宽度右侧补空格 */
function padEnd(s, width) {
  const gap = width - displayWidth(s)
  return gap > 0 ? String(s) + ' '.repeat(gap) : String(s)
}

/** 按显示宽度左侧补空格 */
function padStart(s, width) {
  const gap = width - displayWidth(s)
  return gap > 0 ? ' '.repeat(gap) + String(s) : String(s)
}

function statusMark(status) {
  switch (status) {
    case 'ok':
      return '✓'
    case 'failed':
      return '✗'
    case 'no-result':
      return '? 无结果'
    case 'signal':
      return '✗ 被信号终止'
    case 'timeout':
      return '✗ 超时'
    default:
      return '?'
  }
}

function parseCliArgs(argv) {
  const out = { fast: false, filter: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--fast') out.fast = true
    else if (a === '--filter') {
      const value = argv[++i]
      if (!value) throw new Error('--filter requires a value')
      out.filter = value
    } else if (a.startsWith('--filter=')) {
      out.filter = a.slice('--filter='.length)
    } else if (a === '--help' || a === '-h') {
      out.help = true
    } else {
      throw new Error(`unknown argument: ${a}`)
    }
  }
  return out
}

const HELP = `用法: node test/run-all.mjs [--fast] [--filter <name>]

  --fast            跳过 smoke-server（不起子进程，只跑纯单元测试）
  --filter <name>   只跑名字包含 <name> 的测试（子串匹配，忽略大小写）
  -h, --help        显示本帮助

可用测试: ${TESTS.map((t) => t.name).join(', ')}`

async function main() {
  let opts
  try {
    opts = parseCliArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`参数错误: ${error.message}\n`)
    console.error(HELP)
    process.exit(2)
  }

  if (opts.help) {
    console.log(HELP)
    process.exit(0)
  }

  let selected = TESTS
  if (opts.filter) {
    const needle = opts.filter.toLowerCase()
    selected = TESTS.filter((t) => t.name.toLowerCase().includes(needle))
    if (selected.length === 0) {
      console.error(`没有名字匹配 "${opts.filter}" 的测试。`)
      console.error(`可用: ${TESTS.map((t) => t.name).join(', ')}`)
      process.exit(2)
    }
  }
  if (opts.fast) {
    const dropped = selected.filter((t) => t.smoke)
    selected = selected.filter((t) => !t.smoke)
    if (selected.length === 0) {
      console.error('--fast 把全部测试都跳过了（当前选择里只有 smoke）。')
      process.exit(2)
    }
    if (dropped.length) console.log(`--fast: 跳过 ${dropped.map((t) => t.name).join(', ')}\n`)
  }

  console.log(`运行 ${selected.length} 个测试文件\n`)

  const results = []
  for (const test of selected) {
    // 进度提示只在 TTY 下用 \r 覆盖；重定向到文件/管道时打干净的一行
    const spinning = process.stdout.isTTY
    if (spinning) process.stdout.write(`\r  ▸ ${test.name} …正在运行${' '.repeat(20)}`)
    else console.log(`  ▸ ${test.name} …`)

    const result = await runOne(test)
    results.push(result)
    if (spinning) process.stdout.write('\r' + ' '.repeat(60) + '\r')

    if (result.status === 'ok' || result.status === 'failed') {
      // 失败时把该文件的输出整段打出来，方便定位
      if (result.status === 'failed') {
        console.log(`\n───── ${test.name} 输出 ─────`)
        console.log(result.raw.trimEnd())
        console.log(`───── ${test.name} 结束 ─────\n`)
      }
    } else {
      // 崩溃 / 无结果 / 超时：必须单独标出来，不能静默当成功
      console.log(`\n───── ${test.name} 异常（${statusMark(result.status)}）─────`)
      console.log(`退出码: ${result.code}  信号: ${result.signal}  耗时: ${result.elapsed}ms`)
      const raw = result.raw.trimEnd()
      if (raw) {
        console.log(raw.length > 4000 ? `${raw.slice(-4000)}\n…（已截断前部）` : raw)
      } else {
        console.log('（无任何输出）')
      }
      console.log(`───── ${test.name} 结束 ─────\n`)
    }
  }

  // ── 汇总表
  const allLabels = [...results.map((r) => r.name), '合计']
  const nameWidth = Math.max(...allLabels.map(displayWidth), 12) + 4
  const passWidth = String(Math.max(...results.map((r) => r.pass), 0)).length + 1
  const failWidth = String(Math.max(...results.map((r) => r.fail), 0)).length
  const line = '─'.repeat(37)

  console.log(line)
  for (const r of results) {
    const mark = statusMark(r.status)
    console.log(
      `  ${padEnd(r.name, nameWidth)}通过 ${padStart(r.pass, passWidth)} / 失败 ${padStart(r.fail, failWidth)}    ${mark}`,
    )
  }
  console.log(line)

  const totalPass = results.reduce((n, r) => n + r.pass, 0)
  const totalFail = results.reduce((n, r) => n + r.fail, 0)
  const abnormal = results.filter((r) => r.status !== 'ok')
  console.log(`  ${padEnd('合计', nameWidth)}通过 ${padStart(totalPass, passWidth)} / 失败 ${padStart(totalFail, failWidth)}`)

  if (abnormal.length) {
    console.log(`\n异常测试: ${abnormal.map((r) => `${r.name}(${statusMark(r.status)})`).join(', ')}`)
  }

  const bad = totalFail > 0 || abnormal.length > 0
  process.exit(bad ? 1 : 0)
}

main()
