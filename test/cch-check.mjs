import { xxh64, computeClaudeCodeCch, sealClaudeCodeCch, projectBillingFields, CCH_XXH64_SEED } from '../src/cch.mjs'
import { xxh64 as refXxh } from '../../vm2api/src/lib/identity/xxh64.mjs'
import { computeClaudeCodeCch as refCch, sealClaudeCodeCch as refSeal } from '../../vm2api/src/lib/identity/cch.mjs'

let pass=0, fail=0
const eq=(n,a,b)=>{ if(JSON.stringify(a)===JSON.stringify(b)){pass++;console.log('  ok   ',n)} else {fail++;console.log('  FAIL ',n,'\n    got',a,'\n    want',b)} }

// 1. xxh64 与国际测试向量对齐（xxHash 规范：空串 seed 0 的哈希为 ef46db3751d8e999）
eq('xxh64 空串 seed0', xxh64('', 0n).toString(16), 'ef46db3751d8e999')
eq('xxh64 "abc" seed0', xxh64('abc', 0n).toString(16), '44bc2cf5ad770999')

// 2. 与参考实现完全一致（随机长度覆盖所有分支）
const samples = ['', 'a', 'ab', 'abc', 'x'.repeat(31), 'y'.repeat(32), 'z'.repeat(33), 'q'.repeat(1000), Buffer.from('0123456789'.repeat(50))]
let same = true
for (const s of samples) {
  for (const seed of [0n, CCH_XXH64_SEED]) {
    if (xxh64(s, seed) !== refXxh(s, seed)) { same = false; console.log('    mismatch len=', s.length) }
  }
}
eq('xxh64 与开源实现全分支一致', same, true)

// 3. cch 值一致
const body = Buffer.from(JSON.stringify({ model:'claude-sonnet-5-5', max_tokens: 64, messages:[{role:'user',content:'hi'}] }))
eq('cch 与开源实现一致', computeClaudeCodeCch(body), refCch(body))
eq('cch 是 5 位 hex', /^[0-9a-f]{5}$/.test(computeClaudeCodeCch(body)), true)

// 4. 投影规则：max_tokens 被切掉、model 值被清空
const proj = projectBillingFields('{"model":"abc","max_tokens":64,"messages":[]}')
eq('投影清空 model 值', proj.includes('"model":""'), true)
eq('投影切掉 max_tokens', proj.includes('max_tokens'), false)

// 5. seal 端到端：与开源实现输出完全一致
const reqBody = {
  model:'claude-sonnet-5-5', max_tokens:64,
  system:[{type:'text',text:'x-anthropic-billing-header: cc_version=2.1.296; cch=00000;'}],
  messages:[{role:'user',content:'hi'}]
}
const mine = sealClaudeCodeCch(JSON.parse(JSON.stringify(reqBody)))
const ref  = refSeal(JSON.parse(JSON.stringify(reqBody)))
eq('seal 输出与开源一致', JSON.stringify(mine), JSON.stringify(ref))
eq('seal 后 cch 非占位', /cch=(?!00000)[0-9a-f]{5};/.test(mine.system[0].text), true)
eq('seal 幂等（再 seal 一次不变）', JSON.stringify(sealClaudeCodeCch(JSON.parse(JSON.stringify(mine)))), JSON.stringify(mine))

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail?1:0)
