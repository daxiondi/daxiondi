/**
 * 交叉验证：官方 vm2api v1.3.220 的 cch 实现 vs 我们的实现。
 *
 * 为什么这个测试最重要：
 *   cch 是上游校验请求体完整性的字段。如果我们算出来的值与官方
 *   客户端不一致，上游能直接判定"这不是官方客户端发的"。
 *
 *   而 1.3.220 修复了一个致命 bug：1.3.219 及之前会把**所有**
 *   x-anthropic-billing-header 块都改写，包括多轮对话历史里回显的
 *   调用方内容。结果请求体被篡改，上游对比历史就能发现 —— 会封号。
 *
 *   我们最初直接继承了有 bug 的写法（/gim 全局 + 无位置限制）。
 *   这个测试锁定修复：同一份请求体，两边输出必须**逐字节相同**。
 *
 * 前置：research/vm2api 必须在 v1.3.220（或更高）上。
 * 缺这个仓库时自动跳过，不让它阻塞其他测试。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OFFICIAL = path.resolve(HERE, '../../vm2api/src/lib/identity/cch.mjs')
const OURS = path.resolve(HERE, '../src/cch.mjs')

if (!fs.existsSync(OFFICIAL)) {
  console.log('跳过：找不到官方 cch 实现（research/vm2api 不在 v1.3.220+）')
  console.log('通过 0 / 失败 0')
  process.exit(0)
}

const official = await import(`file://${OFFICIAL}`)
const ours = await import(`file://${OURS}`)

const CASES = [
  {
    name: '单 billing 头（最简单）',
    body: {
      model: 'claude-sonnet-4-5', max_tokens: 8192,
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.310; cch=00000;' }],
      messages: [{ role: 'user', content: 'hi' }],
    },
  },
  {
    name: '多轮历史含回显（关键用例）',
    body: {
      model: 'claude-sonnet-4-5', max_tokens: 8192,
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.310; cch=00000;' },
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.310; cch=aaaaa;' },
      ],
      messages: [
        { role: 'user', content: 'what is x-anthropic-billing-header?' },
        { role: 'assistant', content: 'x-anthropic-billing-header: cch=bbbbb;' },
      ],
    },
  },
  {
    name: 'system 是字符串',
    body: {
      model: 'claude-sonnet-4-5', max_tokens: 4096,
      system: 'x-anthropic-billing-header: cc_version=2.1.310; cch=00000;\nYou are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
    },
  },
  {
    name: '无 billing 头',
    body: {
      model: 'claude-sonnet-4-5', max_tokens: 1024,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
    },
  },
  {
    name: '带 fallbacks / max_tokens 需抹平',
    body: {
      model: 'claude-sonnet-4-5', max_tokens: 64000,
      system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.310; cch=00000;' }],
      messages: [{ role: 'user', content: 'test' }],
      fallbacks: [{ model: 'claude-opus-4-5' }],
    },
  },
]

let pass = 0, fail = 0
for (const c of CASES) {
  const raw = JSON.stringify(c.body)
  let o = null, m = null, oErr = null, mErr = null
  try { o = official.sealClaudeCodeCch(raw, { enabled: true, seal: true }) } catch (e) { oErr = e.message }
  try { m = ours.sealClaudeCodeCch(raw, { enabled: true, seal: true }) } catch (e) { mErr = e.message }

  const extract = (t) => {
    if (!t) return null
    const m2 = /cch=([0-9a-z]{5})/.exec(t)
    return m2 ? m2[1] : null
  }
  const oc = extract(o), mc = extract(m)
  const same = oErr === mErr && oc === mc && o === m
  if (same) { pass += 1; console.log(`  ✓ ${c.name}  cch=${oc ?? '(无)'}`) }
  else {
    fail += 1
    console.log(`  ✗ ${c.name}`)
    console.log(`      官方: cch=${oc} err=${oErr}`)
    console.log(`      我们: cch=${mc} err=${mErr}`)
    if (oc === mc && o !== m) {
      // 字节不同但 cch 相同 → 内容有差异
      for (let i = 0; i < Math.max(o.length, m.length); i++) {
        if (o[i] !== m[i]) {
          console.log(`      首个差异 @${i}:`)
          console.log(`        官方 ...${o.slice(Math.max(0,i-40), i+60)}...`)
          console.log(`        我们 ...${m.slice(Math.max(0,i-40), i+60)}...`)
          break
        }
      }
    }
  }
}
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
