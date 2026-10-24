#!/usr/bin/env node
/**
 * 出站 body 结构工具：把一个请求体归约成脱敏骨架，或对比两份骨架。
 * 输出的骨架不含任何提示词 / id / 密钥文本，可以安全贴进 issue 或日志。
 *
 *   node scripts/outbound-shape.mjs < body.json
 *   cat body.json | node scripts/outbound-shape.mjs
 *   node scripts/outbound-shape.mjs --file body.json
 *   node scripts/outbound-shape.mjs --file a.json --diff b.json
 *   node scripts/outbound-shape.mjs --file body.json --tree
 *   node scripts/outbound-shape.mjs --file body.json --wrap > expected.shape.json
 *   node scripts/outbound-shape.mjs --file body.json --strict-diff other.json
 *
 * 输入可以是三种形态，自动识别：
 *   1. 裸 body：`{ model, messages, ... }`
 *   2. 抓包：`{ body: {...} }` 或 `{ request: { body: {...} } }`
 *   3. 本工具产出的骨架：`{ __format: 'outbound-shape/1', shape: {...} }`
 *
 * 退出码：
 *   0  成功且（--diff 时）无差异
 *   1  --diff 发现差异
 *   2  用法错误 / 输入不可读
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  diffShape,
  formatShape,
  looksLikeShape,
  shapeOf,
  unwrapShape,
  wrapShape,
} from '../src/outbound-shape.mjs'

const USAGE = `用法:
  node scripts/outbound-shape.mjs [< body.json]
  node scripts/outbound-shape.mjs --file <body.json> [--tree] [--wrap] [--strict]
  node scripts/outbound-shape.mjs --file <a.json> --diff <b.json> [--strict]

说明:
  无 --diff 时输出骨架 JSON（--tree 输出可读树，--wrap 包成可落盘的文档）。
  --diff 时对比两份输入的骨架，打印差异路径；有差异退出码 1。
  --strict 让文本长度参与比较（默认忽略，长度属于内容不属于结构）。
  --raw 关闭条数上限折叠，完整打印所有差异。
`

/** 差异条目最多打印多少条，避免两个大骨架的无关差异刷屏 */
const MAX_DIFF_LINES = 200

function parseArgs(argv) {
  const out = { file: null, diff: null, tree: false, wrap: false, strict: false, raw: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--file' || arg === '-f') out.file = argv[++i]
    else if (arg === '--diff' || arg === '-d') out.diff = argv[++i]
    else if (arg === '--tree' || arg === '-t') out.tree = true
    else if (arg === '--wrap' || arg === '-w') out.wrap = true
    else if (arg === '--strict') out.strict = true
    else if (arg === '--raw') out.raw = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`未知参数: ${arg}`)
  }
  if (out.file === undefined || out.file === '') throw new Error('--file 需要路径')
  if (out.diff === undefined && out.diff === '') throw new Error('--diff 需要路径')
  return out
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

/** 从任意输入文档里取出 body：裸 body / {body} / {request:{body}} */
export function pickBody(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return doc
  if (doc.body && typeof doc.body === 'object' && !Array.isArray(doc.body)) return doc.body
  const nested = doc.request
  if (nested && typeof nested === 'object' && nested.body && typeof nested.body === 'object') return nested.body
  return doc
}

/**
 * 把一份输入文档归约成 shape。
 * 已经是骨架（或包装过的骨架）就不再归约——重复归约会得到 <text:…> 的转录形态。
 */
export function shapeFromDoc(doc) {
  const { shape, wrapped } = unwrapShape(doc)
  if (wrapped) return shape
  if (looksLikeShape(shape)) return shape
  return shapeOf(pickBody(shape))
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON: ${error.message}`)
  }
}

async function main(argv) {
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

  try {
    let source
    if (args.file) {
      const resolved = path.resolve(args.file)
      source = fs.readFileSync(resolved, 'utf8')
    } else {
      source = await readStdin()
    }
    if (!source.trim()) {
      process.stderr.write('输入为空：请从 stdin 送一个请求体，或用 --file 指定文件\n')
      return 2
    }

    const primary = shapeFromDoc(parseJson(source, args.file ? path.basename(args.file) : 'stdin'))

    if (!args.diff) {
      if (args.tree) {
        process.stdout.write(`${formatShape(primary)}\n`)
      } else if (args.wrap) {
        process.stdout.write(`${JSON.stringify(wrapShape(primary), null, 2)}\n`)
      } else {
        process.stdout.write(`${JSON.stringify(primary, null, 2)}\n`)
      }
      return 0
    }

    const otherText = fs.readFileSync(path.resolve(args.diff), 'utf8')
    const other = shapeFromDoc(parseJson(otherText, path.basename(args.diff)))
    const diffs = diffShape(primary, other, '', { strict: args.strict })

    if (!diffs.length) {
      process.stdout.write(`无差异（${args.strict ? 'strict' : '结构'} 模式，${path.basename(args.file || 'stdin')} vs ${path.basename(args.diff)}）\n`)
      return 0
    }

    const limit = args.raw ? diffs.length : MAX_DIFF_LINES
    for (const diff of diffs.slice(0, limit)) {
      const detail =
        diff.kind === 'missing'
          ? '期望有、实际没有'
          : diff.kind === 'extra'
            ? '实际多出来'
            : diff.kind === 'length'
              ? `长度 ${JSON.stringify(diff.expected)} → ${JSON.stringify(diff.actual)}`
              : diff.kind === 'key_order'
                ? `键顺序 ${(diff.expected || []).join(',')} → ${(diff.actual || []).join(',')}`
                : `${JSON.stringify(diff.expected)} → ${JSON.stringify(diff.actual)}`
      process.stdout.write(`[${diff.kind}] ${diff.path}  ${detail}\n`)
    }
    if (diffs.length > limit) {
      process.stdout.write(`… 另有 ${diffs.length - limit} 条差异未打印（--raw 全量）\n`)
    }
    process.stdout.write(`\n共 ${diffs.length} 条差异\n`)
    return 1
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = (await main(process.argv.slice(2))) ?? 0
}
