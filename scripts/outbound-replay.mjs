#!/usr/bin/env node
/**
 * 出站结构离线回放：对 test/fixtures/outbound/ 下的每个 fixture，用本仓库的实现
 * 构造一次出站 body，取脱敏骨架，与 fixture 里记录的 expected_shape 对比。
 *
 *   node scripts/outbound-replay.mjs                 # 跑全部 fixture
 *   node scripts/outbound-replay.mjs --filter zero   # 名字含 zero 的
 *   node scripts/outbound-replay.mjs --strict        # 文本长度也参与比较
 *   node scripts/outbound-replay.mjs --update        # 用当前实现的骨架重写 expected_shape
 *   node scripts/outbound-replay.mjs --json          # 机器可读报告
 *
 * 不联网、不起进程、不写 fixture（除 --update）。构造链与 src/server.mjs 的
 * prepareOutbound 同序：system 布局 → betas 合并 → cch 封盖。
 *
 * fixture 结构：
 *   {
 *     "name": "<唯一名>",
 *     "note": "<这条例覆盖什么>",
 *     "request": {
 *       "body": { ...调用方 Anthropic Messages body... },
 *       "build": {                       // 可选，缺省见 DEFAULT_BUILD
 *         "system_layout": "zero|identity|stock",
 *         "panel_ttl": "5m|1h",
 *         "seal": true,                  // 是否真的算 cch
 *         "betas_header": "a,b",         // 等价于入站 anthropic-beta 头
 *         "normalize_metadata": true     // 走 frames.formatMetadataUserId
 *       }
 *     },
 *     "expected_shape": { ... }
 *   }
 *
 * 退出码：全部通过 0，有失败 1，环境不可用 2。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diffShape, shapeOf, wrapShape, SHAPE_FORMAT } from '../src/outbound-shape.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')
export const FIXTURE_DIR = path.join(ROOT, 'test/fixtures/outbound')

/** 构造出站 body 的默认参数 */
export const DEFAULT_BUILD = Object.freeze({
  system_layout: 'zero',
  panel_ttl: '5m',
  seal: true,
  betas_header: '',
  normalize_metadata: false,
})

/**
 * 加载构造链依赖的模块。
 *
 * 用动态 import 而不是顶层静态 import：这些模块正被并行改动，
 * 顶层 import 失败会让整个脚本在解析阶段就崩，连"哪个模块不可用"都看不到。
 * 这里把失败收敛成一份缺失清单，由调用方决定降级还是报错。
 */
export async function loadPipeline() {
  const modules = {}
  const missing = []
  const want = [
    ['systemLayout', '../src/system-layout.mjs'],
    ['identity', '../src/identity.mjs'],
    ['cch', '../src/cch.mjs'],
    ['frames', '../src/frames.mjs'],
  ]
  for (const [name, spec] of want) {
    try {
      modules[name] = await import(spec)
    } catch (error) {
      missing.push({ module: spec, error: error.message })
    }
  }
  return { modules, missing }
}

/** 把调用方 system 摊平成一段文本（布局重建时用） */
function flattenSystem(system) {
  if (Array.isArray(system)) {
    return system.map((block) => (typeof block === 'string' ? block : block?.text || '')).join('\n\n')
  }
  return typeof system === 'string' ? system : ''
}

/**
 * 复刻 src/server.mjs 的 prepareOutbound。
 *
 * 顺序是硬约束：system 布局 → betas 合并 → cch 封盖。
 * cch 对最终字节计算，任何后置修改都会让值失效。
 *
 * @param {object} request fixture 里的 request 节点
 * @param {{modules: object, missing: Array}} pipeline loadPipeline 的产物
 * @returns {{body: object, steps: string[], degraded: string[]}}
 */
export function buildOutbound(request, pipeline) {
  const { modules, missing } = pipeline
  const body = structuredClone(request?.body ?? {})
  const build = { ...DEFAULT_BUILD, ...(request?.build || {}) }
  const steps = []
  const degraded = []

  // 1. system 布局
  const { systemLayout, identity, cch, frames } = modules
  if (!systemLayout || !identity || !cch) {
    degraded.push(...missing.map((m) => m.module))
    return { body, steps, degraded }
  }

  if (Array.isArray(body.system) && body.system.length >= 4) {
    // 调用方已给完整官方布局：只做 wire 规范化（billing 换成占位）
    if (typeof systemLayout.wireSystemBlocks === 'function') {
      const wire = systemLayout.wireSystemBlocks(body.system)
      if (wire) {
        body.system = wire
        steps.push('system:wire-normalize')
      } else {
        degraded.push('wireSystemBlocks 返回 null，保持调用方 system 原样')
      }
    } else {
      degraded.push('systemLayout.wireSystemBlocks 缺失')
    }
  } else if (build.system_layout && build.system_layout !== 'stock') {
    if (typeof systemLayout.layoutSystemBlocks === 'function') {
      const callerSystem = flattenSystem(body.system)
      const blocks = systemLayout.layoutSystemBlocks({
        attribution: '',
        leftover: callerSystem || undefined,
        env: {
          CLAUDE_CODE_SYSTEM_LAYOUT: build.system_layout,
          TZ: build.timezone || 'Asia/Shanghai',
        },
      })
      body.system = blocks.map((text) => ({ type: 'text', text }))
      steps.push(`system:layout:${build.system_layout}`)
    } else {
      degraded.push('systemLayout.layoutSystemBlocks 缺失')
    }
  } else {
    steps.push('system:caller-passthrough')
  }

  // 2. betas 合并（官方顺序优先）
  const headerBetas = String(build.betas_header || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const incoming = [...(Array.isArray(body.betas) ? body.betas : []), ...headerBetas]
  if (incoming.length) {
    if (typeof identity.mergeOfficialExtraBetas === 'function') {
      body.betas = identity.mergeOfficialExtraBetas(incoming)
      steps.push('betas:merge')
    } else {
      degraded.push('identity.mergeOfficialExtraBetas 缺失，betas 保持原样')
    }
  }

  // 2.5 metadata.user_id 规范化（可选；走 frames 的校验，含 @ 直接抛错）
  if (build.normalize_metadata && body.metadata && typeof body.metadata === 'object') {
    if (frames && typeof frames.formatMetadataUserId === 'function') {
      const existing = body.metadata.user_id
      if (existing && typeof existing === 'object') {
        body.metadata = {
          ...body.metadata,
          user_id: frames.formatMetadataUserId({
            deviceId: frames.outboundDeviceId?.(existing.device_id) || existing.device_id || '',
            accountUuid: existing.account_uuid || '',
            sessionId: existing.session_id || '',
          }),
        }
        steps.push('metadata:normalize')
      }
    } else {
      degraded.push('frames.formatMetadataUserId 缺失')
    }
  }

  // 3. cch 封盖
  if (typeof cch.sealClaudeCodeCch === 'function') {
    const sealed = cch.sealClaudeCodeCch(body, { enabled: true, seal: build.seal !== false })
    // sealClaudeCodeCch 可能返回新的 body（封盖时）或同一个引用（无 billing header 时）。
    // 不能用「清空原对象再 assign」的写法：两者是同一引用时会把 body 清成 {}。
    return {
      body: sealed && typeof sealed === 'object' ? sealed : body,
      steps: [...steps, build.seal === false ? 'cch:placeholder' : 'cch:seal'],
      degraded,
    }
  }
  degraded.push('cch.sealClaudeCodeCch 缺失')
  return { body, steps, degraded }
}

function parseArgs(argv) {
  const out = { dir: FIXTURE_DIR, filter: null, strict: false, update: false, json: false, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') out.dir = path.resolve(argv[++i])
    else if (arg === '--filter') out.filter = argv[++i]
    else if (arg === '--strict') out.strict = true
    else if (arg === '--update') out.update = true
    else if (arg === '--json') out.json = true
    else if (arg === '--verbose' || arg === '-v') out.verbose = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`未知参数: ${arg}`)
  }
  return out
}

const USAGE = `用法: node scripts/outbound-replay.mjs [--dir <目录>] [--filter <子串>] [--strict] [--update] [--json] [-v]

  --dir      fixture 目录，缺省 test/fixtures/outbound
  --filter   只跑 name/文件名含该子串的 fixture
  --strict   文本长度也参与比较（缺省忽略长度）
  --update   用当前实现重算并写回 fixture 的 expected_shape
  --json     输出机器可读报告
`

function listFixtures(dir, filter) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .filter((name) => !filter || name.includes(filter))
    .map((name) => path.join(dir, name))
}

function loadFixture(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!doc || typeof doc !== 'object') throw new Error('fixture 不是对象')
  if (!doc.request || typeof doc.request !== 'object') throw new Error('fixture 缺少 request')
  if (!doc.request.body || typeof doc.request.body !== 'object') throw new Error('fixture.request.body 缺失或不是对象')
  return doc
}

function formatDiff(diff) {
  if (diff.kind === 'missing') return `  [missing]   ${diff.path}  期望有、实际没有`
  if (diff.kind === 'extra') return `  [extra]     ${diff.path}  实际多出来`
  if (diff.kind === 'length') return `  [length]    ${diff.path}  ${diff.expected} → ${diff.actual}`
  if (diff.kind === 'key_order') {
    return `  [key_order] ${diff.path}  ${(diff.expected || []).join(',')} → ${(diff.actual || []).join(',')}`
  }
  return `  [value]     ${diff.path}  ${JSON.stringify(diff.expected)} → ${JSON.stringify(diff.actual)}`
}

/** 单条 fixture 的结果；不含任何请求文本 */
function runFixture(file, doc, pipeline, options) {
  const name = doc.name || path.basename(file, '.json')
  const started = Date.now()
  let built
  try {
    built = buildOutbound(doc.request, pipeline)
  } catch (error) {
    return { name, file: path.basename(file), pass: false, error: error.message, diffs: [], steps: [], degraded: [], ms: 0 }
  }
  const actual = shapeOf(built.body)

  if (options.update) {
    const next = { ...doc, expected_shape: actual }
    next.__format = SHAPE_FORMAT
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
    return {
      name,
      file: path.basename(file),
      pass: true,
      updated: true,
      diffs: [],
      steps: built.steps,
      degraded: built.degraded,
      ms: Date.now() - started,
    }
  }

  const expected = doc.expected_shape
  if (!expected || typeof expected !== 'object') {
    return {
      name,
      file: path.basename(file),
      pass: false,
      error: 'fixture 缺少 expected_shape（可用 --update 生成）',
      diffs: [],
      steps: built.steps,
      degraded: built.degraded,
      ms: Date.now() - started,
    }
  }

  const diffs = diffShape(expected, actual, '', { strict: options.strict })
  return {
    name,
    file: path.basename(file),
    pass: diffs.length === 0,
    note: doc.note || null,
    diffs,
    steps: built.steps,
    degraded: built.degraded,
    ms: Date.now() - started,
  }
}

export async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }

  const files = listFixtures(args.dir, args.filter)
  if (!files.length) {
    process.stderr.write(`没有找到 fixture：${args.dir}${args.filter ? `（filter=${args.filter}）` : ''}\n`)
    return 2
  }

  const pipeline = await loadPipeline()
  if (pipeline.missing.length) {
    process.stderr.write('构造链依赖不可用，无法回放：\n')
    for (const item of pipeline.missing) process.stderr.write(`  ${item.module}: ${item.error}\n`)
    return 2
  }

  const results = []
  for (const file of files) {
    let doc
    try {
      doc = loadFixture(file)
    } catch (error) {
      results.push({ name: path.basename(file, '.json'), file: path.basename(file), pass: false, error: error.message, diffs: [], steps: [], degraded: [], ms: 0 })
      continue
    }
    results.push(runFixture(file, doc, pipeline, args))
  }

  const failed = results.filter((r) => !r.pass)

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          fixtures: results.length,
          pass: results.length - failed.length,
          fail: failed.length,
          strict: args.strict,
          updated: args.update,
          results,
        },
        null,
        2,
      )}\n`,
    )
  } else {
    for (const result of results) {
      const mark = result.pass ? '✓' : '✗'
      const suffix = result.updated ? '（已更新 expected_shape）' : ''
      process.stdout.write(`${mark} ${result.name}${suffix}\n`)
      if (args.verbose && result.note) process.stdout.write(`    ${result.note}\n`)
      if (args.verbose && result.steps?.length) process.stdout.write(`    构造: ${result.steps.join(' → ')}\n`)
      if (result.degraded?.length) {
        for (const note of result.degraded) process.stdout.write(`    [degraded] ${note}\n`)
      }
      if (result.error) process.stdout.write(`    ${result.error}\n`)
      for (const diff of result.diffs || []) process.stdout.write(`${formatDiff(diff)}\n`)
      if (!result.pass && result.diffs?.length) {
        process.stdout.write(`    共 ${result.diffs.length} 条结构差异${args.strict ? '（strict）' : ''}\n`)
      }
    }
    process.stdout.write('\n')
  }

  process.stdout.write(`通过 ${results.length - failed.length} / 失败 ${failed.length}\n`)
  return failed.length ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await main(process.argv.slice(2))) ?? 0
}
