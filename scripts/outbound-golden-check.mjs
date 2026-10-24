#!/usr/bin/env node
/**
 * 出站形状黄金基准检查。
 *
 * 「黄金基准」= 真实 Claude Code 2.1.310 实测抓到的请求头。
 * 我们的出站必须在这些字段上与它逐值一致，否则上游能判定
 * "这不是官方客户端发的"。
 *
 * 为什么需要这个脚本：这些字段分散在 identity / anthropic /
 * system-layout / prompt-profiles 四个模块里，改任何一处都可能
 * 让某个值漂掉，而**不会报错**。只有逐项比对才能发现。
 *
 * 基准来源：用假 API 端点拦下 claude 2.1.310 的真实请求，
 * 完整记录见 docs/DEPLOY.md §5.9.7。
 */
import { officialCliUserAgent, officialStainlessHeaders } from '../src/identity.mjs'
import { buildBillingAttribution } from '../src/system-layout.mjs'
import { sanitizeAnthropicBody, DROP_TOP } from '../src/sanitize.mjs'
// UA 判定不依赖 official-ua.mjs —— 那个模块由并行任务在写，
// 本脚本要能独立运行。这里内联同一份正则（与官方 v1.3.220
// official-claude-ua.mjs 一致）。
const CLAUDE_CLI_UA_RE = /^claude-cli\/\d+\.\d+\.\d+/i
const isOfficialClaudeUa = (ua) => CLAUDE_CLI_UA_RE.test(String(ua || '').trim())

let pass = 0
const fails = []
const warns = []
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass += 1; return }
  fails.push(`${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
}
const ok = (label, cond, detail = '') => {
  if (cond) { pass += 1; return }
  fails.push(`${label}${detail ? `: ${detail}` : ''}`)
}
const warn = (label, detail) => { warns.push(`${label}: ${detail}`) }

console.log('=== 出站形状黄金基准 ===\n')

// ── 1. UA（实测值）
console.log('[1] User-Agent')
{
  const ua = officialCliUserAgent({})
  eq('UA 版本是 2.1.296', ua, 'claude-cli/2.1.296 (external, sdk-cli)')
  ok('UA 后缀是 sdk-cli（不是 cli）', ua.endsWith('(external, sdk-cli)'), ua)
  ok('UA 通过官方前缀校验', isOfficialClaudeUa(ua), ua)
  // 2.1.303 档只换版本号，后缀不变
  const ua303 = officialCliUserAgent({ CLAUDE_CODE_VERSION: '2.1.303' })
  eq('303 档 UA', ua303, 'claude-cli/2.1.303 (external, sdk-cli)')
}

// ── 2. stainless 六件套（实测值）
console.log('[2] stainless 头')
{
  const h = officialStainlessHeaders()
  eq('stainless_lang', h['x-stainless-lang'], 'js')
  eq('stainless_os', h['x-stainless-os'], 'Linux')
  eq('stainless_arch', h['x-stainless-arch'], 'x64')
  eq('stainless_runtime', h['x-stainless-runtime'], 'node')
  eq('stainless_runtime_version', h['x-stainless-runtime-version'], 'v26.3.0')
  eq('stainless_package_version', h['x-stainless-package-version'], '0.128.0')
  eq('stainless_retry_count', h['x-stainless-retry-count'], '0')
  eq('stainless_timeout', h['x-stainless-timeout'], '600')
}

// ── 3. billing 头格式
console.log('[3] billing 头')
{
  const b = buildBillingAttribution({ firstUserText: 'hello world test', cliVersion: '2.1.296' })
  ok('前缀正确', b.startsWith('x-anthropic-billing-header: '), b)
  ok('cc_version 含 3 位 hex 指纹', /cc_version=2\.1\.296\.[0-9a-f]{3};/.test(b), b)
  ok('cc_entrypoint=sdk-cli', b.includes('cc_entrypoint=sdk-cli;'), b)
  ok('cch 占位符 00000', b.includes('cch=00000;'), b)
  ok('含 cc_prompt_id（UUID）', /cc_prompt_id=[0-9a-f-]{36};/.test(b), b)
  ok('不含官方没有的 prompt_version', !b.includes('prompt_version'), b)
  // 无索引时不应有 turn tail
  ok('无索引不写 turn tail', !b.includes('cc_turn_origin'), b)
  // 有索引时格式
  const b2 = buildBillingAttribution({ firstUserText: 'h', cliVersion: '2.1.296', promptIndex: 2, turnIndex: 4 })
  ok('有索引时 tail 格式正确',
    b2.includes('cc_turn_origin=sdk; cc_prompt_index=2; cc_turn_index=4;'), b2)
  // 二次调用必须稳定（同一输入同输出）
  const b3 = buildBillingAttribution({ firstUserText: 'hello world test', cliVersion: '2.1.296' })
  eq('同输入输出稳定', b3, b)
}

// ── 4. 内部字段绝不出站
console.log('[4] 内部字段剥离')
{
  const LEAKY = ['machine_id', 'device_id', 'account_uuid', 'session',
    'betas', '__betas__', 'kin_outbound_shape', 'persona', 'slot',
    'settings', 'env', 'extra_body', 'extra_headers']
  for (const k of LEAKY) {
    const out = sanitizeAnthropicBody({ model: 'm', max_tokens: 1, [k]: 'leak' })
    ok(`${k} 不出站`, !(k in out), JSON.stringify(out))
  }
  ok('DROP_TOP 覆盖全部泄漏键', LEAKY.every((k) => DROP_TOP.has(k)),
    LEAKY.filter((k) => !DROP_TOP.has(k)).join(','))
}

// ── 5. 官方字段不被误删
console.log('[5] 官方字段保留')
{
  const KEEP = ['model', 'max_tokens', 'messages', 'system', 'tools', 'thinking',
    'temperature', 'top_p', 'top_k', 'stop_sequences', 'output_config', 'metadata']
  for (const k of KEEP) {
    const out = sanitizeAnthropicBody({ model: 'm', max_tokens: 1, [k]: k === 'messages' ? [] : {} })
    ok(`${k} 保留`, k in out)
  }
}

// ── 6. 已知边界（记录但不失败）
console.log('[6] 已知边界')
{
  warn('默认 layout 不产 billing', 'stock 布局保留调用方 system 但不写 billing，官方 cli-hop 会写')
  warn('zero 布局含 prompt_version', '我们自己的设计，官方 billing 无此字段')
}

console.log(`\n通过 ${pass} / 失败 ${fails.length} / 已知边界 ${warns.length}`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log(`  ✗ ${f}`)
}
if (warns.length) {
  console.log('\n已知边界：')
  for (const w of warns) console.log(`  △ ${w}`)
}
process.exit(fails.length ? 1 : 0)
