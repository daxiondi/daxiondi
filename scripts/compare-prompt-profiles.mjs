#!/usr/bin/env node
/**
 * 档位对比：同一个请求分别按 official_full 与 official_303 组装，打印结构差异。
 *
 * 用法：
 *   node scripts/compare-prompt-profiles.mjs                      # 缺省样本：Opus 5.5 单轮
 *   node scripts/compare-prompt-profiles.mjs --model claude-sonnet-5-5
 *   node scripts/compare-prompt-profiles.mjs --turns 3 --ttl 1h
 *   node scripts/compare-prompt-profiles.mjs --json               # 机器可读
 *
 * 只调用 src/prompt-profiles.mjs 的公开组装入口，不建立任何网络连接。
 */

import {
  OFFICIAL_CLI_IDENTITY,
  PROFILE_OFFICIAL_303,
  PROFILE_OFFICIAL_FULL,
  assembleRequest,
  isBillingText,
} from '../src/prompt-profiles.mjs'

function parseArgs(argv) {
  const out = { model: 'claude-opus-5-5', turns: 1, ttl: '1h', json: false, officialCaller: true }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--model') out.model = argv[++i]
    else if (a === '--turns') out.turns = Number(argv[++i])
    else if (a === '--ttl') out.ttl = argv[++i]
    else if (a === '--json') out.json = true
    else if (a === '--unofficial-caller') out.officialCaller = false
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!Number.isInteger(out.turns) || out.turns < 1) throw new Error('--turns must be a positive integer')
  return out
}

const opts = parseArgs(process.argv.slice(2))

/** 构造一份多轮请求。每轮追加 user / assistant 对，模拟真实会话增长。 */
function buildBody({ model, turns, officialCaller }) {
  const messages = []
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: 'user',
      content: i === 0 ? [{ type: 'text', text: 'list the files in this directory' }] : [{ type: 'text', text: `turn ${i + 1}` }],
    })
    if (i < turns - 1) {
      messages.push({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'checking', signature: 'sig' },
          { type: 'text', text: 'done' },
        ],
      })
    }
  }
  const callerSystem = officialCaller
    ? [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296.abc; cc_entrypoint=cli; cch=00000;' },
        { type: 'text', text: OFFICIAL_CLI_IDENTITY },
        { type: 'text', text: 'You are an interactive agent that helps users with software engineering tasks.' },
        { type: 'text', text: 'Always answer in Chinese.' },
        { type: 'text', text: 'Keep replies under 200 words.' },
      ]
    : [
        { type: 'text', text: 'You are a helpful assistant for a support desk.' },
        { type: 'text', text: 'Always answer in Chinese.' },
      ]
  return {
    model,
    max_tokens: 8192,
    stream: true,
    system: callerSystem,
    messages,
    tools: [
      { name: 'Bash', description: 'run a shell command', input_schema: { type: 'object' } },
      { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
    ],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
  }
}

const environment = {
  cwd: '/srv/app',
  git: true,
  platform: 'linux',
  shell: 'bash',
  osVersion: 'Linux 6.6.1',
  model: opts.model,
}

const body = buildBody(opts)
const env = { CLAUDE_CODE_SYSTEM_LAYOUT: 'zero' }

// officialCaller 由调用方判定后传入：官方族的整份 system 不由本档转发。
const callerFlag = opts.officialCaller
const runs = [
  [
    'official_full',
    assembleRequest(body, { profile: PROFILE_OFFICIAL_FULL, ttl: opts.ttl, environment, env, officialCaller: callerFlag }),
  ],
  [
    'official_303',
    assembleRequest(body, { profile: PROFILE_OFFICIAL_303, ttl: opts.ttl, environment, env, officialCaller: callerFlag }),
  ],
]

const kindOf = (block) => {
  if (isBillingText(block.text)) return 'billing'
  if (block.text.trim() === OFFICIAL_CLI_IDENTITY) return 'identity'
  if (block.text.trimStart().startsWith('You are an agent working with the user')) return 'main-303'
  if (block.text.trimStart().startsWith('# Environment')) return 'env'
  return 'caller'
}

const shapeOf = (result) => ({
  profile: result.profile,
  structure: result.structure,
  cliVersion: result.cliVersion,
  userAgent: result.userAgent,
  billing: result.billing,
  system: result.system.map((block, i) => ({
    index: i,
    kind: kindOf(block),
    length: block.text.length,
    marker: block.cache_control ? (block.cache_control.ttl ?? '5m') : null,
  })),
  messages: result.messages.map((message, i) => ({
    index: i,
    role: message.role,
    form: typeof message.content === 'string' ? 'string' : 'blocks',
    blocks: Array.isArray(message.content)
      ? message.content.map((block) => ({
          type: block.type,
          prefix: typeof block.text === 'string' ? block.text.slice(0, 18) : '',
          marker: block.cache_control ? (block.cache_control.ttl ?? '5m') : null,
        }))
      : undefined,
    marker: message.cache_control ? (message.cache_control.ttl ?? '5m') : null,
    environmentSection: typeof message.content === 'string' && message.content.startsWith('# Environment'),
  })),
  markers: result.markers,
})

const shapes = runs.map(([name, result]) => [name, shapeOf(result)])

if (opts.json) {
  console.log(JSON.stringify(Object.fromEntries(shapes), null, 2))
  process.exit(0)
}

// 中日韩字符占两列，按 .length 补空格会让表格错位
const displayWidth = (s) => {
  let width = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0)
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60)
    width += wide ? 2 : 1
  }
  return width
}
const pad = (s, n) => {
  const gap = n - displayWidth(s)
  return gap > 0 ? `${s}${' '.repeat(gap)}` : String(s)
}
const line = (c = '─') => c.repeat(78)

console.log('')
console.log(`请求样本：model=${opts.model} turns=${opts.turns} ttl=${opts.ttl} caller=${opts.officialCaller ? 'official' : 'unofficial'}`)
console.log(line('='))

for (const [name, shape] of shapes) {
  console.log('')
  console.log(`▌${name}`)
  console.log(`  structure      ${shape.structure}`)
  console.log(`  cliVersion     ${shape.cliVersion}`)
  console.log(`  userAgent      ${shape.userAgent}`)
  console.log(`  billing        ${shape.billing}`)
  console.log('')
  console.log(`  system  ${shape.system.length} 块`)
  console.log(`    ${pad('#', 4)}${pad('kind', 12)}${pad('len', 8)}marker`)
  for (const block of shape.system) {
    console.log(`    ${pad(block.index, 4)}${pad(block.kind, 12)}${pad(block.length, 8)}${block.marker ?? '-'}`)
  }
  console.log('')
  console.log(`  messages  ${shape.messages.length} 条`)
  for (const message of shape.messages) {
    const head = `    [${message.index}] ${pad(message.role, 10)}${message.form === 'string' ? 'string' : `${message.blocks.length} blocks`}`
    console.log(`${head}${message.marker ? `  marker=${message.marker}` : ''}${message.environmentSection ? '  env-section' : ''}`)
    if (message.blocks) {
      for (const block of message.blocks) {
        const prefix = block.prefix ? `${JSON.stringify(block.prefix)}…` : ''
        console.log(`         - ${pad(block.type, 12)}${pad(prefix, 26)}${block.marker ? `marker=${block.marker}` : ''}`)
      }
    }
  }
  console.log('')
  console.log(`  断点 ${shape.markers.total} 个`)
  for (const marker of shape.markers.at) console.log(`    ${pad(marker.where, 30)}${marker.ttl}`)
}

// ── 差异汇总
const [[nameA, a], [nameB, b]] = shapes
console.log('')
console.log(line('='))
console.log('差异汇总')
console.log(line())
const rows = [
  ['结构', a.structure, b.structure],
  ['system 块数', a.system.length, b.system.length],
  ['messages 条数', a.messages.length, b.messages.length],
  ['断点数', a.markers.total, b.markers.total],
  ['CLI 版本', a.cliVersion, b.cliVersion],
  ['UA', a.userAgent, b.userAgent],
  ['调用方 system 落位', a.system.some((x) => x.kind === 'caller') ? 'system 内' : '不在 system', b.system.some((x) => x.kind === 'caller') ? 'system 内' : 'inbound user reminder'],
  ['Environment 落位', a.system.some((x) => x.kind === 'env') ? 'system 内' : 'inbound 段替换', b.messages.some((x) => x.role === 'system') ? 'tail role=system' : 'main 块尾部'],
]
for (const [label, left, right] of rows) {
  const same = JSON.stringify(left) === JSON.stringify(right)
  console.log(`  ${pad(label, 24)}${pad(left, 34)}${pad(right, 34)}${same ? '相同' : '不同'}`)
}
console.log('')
console.log(`  ${nameA} 断点：${a.markers.at.map((m) => m.where).join(', ') || '无'}`)
console.log(`  ${nameB} 断点：${b.markers.at.map((m) => m.where).join(', ') || '无'}`)
console.log('')
console.log(line())
console.log(`结论：${nameB} 把调用方 system 移出 system、Environment 移成尾部 role=system，`)
console.log(`      并在身份句 / 主提示词 / 最后 1–2 条 user 上共放置 ${b.markers.total} 个断点；`)
console.log(`      system 段数 ${a.system.length} → ${b.system.length}，billing 版本 ${a.cliVersion} → ${b.cliVersion}。`)
console.log('')
