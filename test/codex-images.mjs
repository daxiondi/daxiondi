/**
 * codex-images 的验证：纯函数 + 走真实 HTTP 层级（注入假 fetch，不建真实连接）。
 *
 * 覆盖：
 *   - 模型清单与启停、快照名归一化
 *   - Free 计划 403 / 停用模型 400 / 缺 model 的行为
 *   - 单号、多号选号，`x-codex-image-turn-id` 的粘性
 *   - multipart 解析（中文文件名、多文件、缺 boundary、非法上传）
 *   - 上游 body 原样透传、URL 路径、失败换号与不可换号
 *   - /v1/models 列出图像模型、方法不匹配 405
 *
 * 用法：node test/codex-images.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createCodexHandler } from '../src/codex-server.mjs'
import {
  IMAGE_MODELS, canonicalImageModel, enabledImageModels,
  imageGenerationAvailable, planTypeFromCredential, planTypeFromIdToken, loadPlanTypes,
  isMultipartFormData, boundaryFromContentType, parseMultipart,
  normalizeImageEditBody, imageReference, imageUrls, buildImageHeaders,
  selectImageAccount, runImages, handleImageGenerations, handleImageEdits,
} from '../src/codex-images.mjs'
import { AccountScheduler } from '../src/codex.mjs'
import { DEFAULT_WORKER_CONFIG, validateCodexConfig } from '../src/config.mjs'

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const a = JSON.stringify(got); const b = JSON.stringify(want)
  if (a === b) { pass += 1; console.log('  ok   ', name) }
  else { fail += 1; console.log('  FAIL ', name, '\n    got ', a, '\n    want', b) }
}
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ok   ', name) }
  else { fail += 1; console.log('  FAIL ', name, detail === undefined ? '' : `\n    ${detail}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────── 测试素材 ───────────────

/** 1x1 PNG（真实魔数，供 multipart 用） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
/** 极简 JPEG 头（魔数够用） */
const JPEG_HEAD = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0x00)])
/** 极简 WebP 头 */
const WEBP_HEAD = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0x20, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'), Buffer.alloc(8, 0x00),
])

/**
 * 手工拼 multipart。文件名按原始 UTF-8 字节写入 —— 中文文件名在真实客户端里
 * 就是这样出现的（Content-Disposition 里直接放 UTF-8 字节）。
 */
function buildMultipart(boundary, parts) {
  const chunks = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'latin1'))
    const disposition = [
      `form-data; name="${part.name}"`,
      part.filename == null ? null : `; filename="${part.filename}"`,
    ].filter(Boolean).join('')
    chunks.push(Buffer.from(`Content-Disposition: ${disposition}\r\n`, 'utf8'))
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, 'utf8'))
    chunks.push(Buffer.from('\r\n', 'latin1'))
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data), 'utf8'))
    chunks.push(Buffer.from('\r\n', 'latin1'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'))
  return Buffer.concat(chunks)
}

function makeTempCredential(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-img-'))
  const file = path.join(dir, 'cred.json')
  fs.writeFileSync(file, JSON.stringify(content))
  return { file, dir }
}

/**
 * 假 fetch。记录 url/headers/解析后的 body；默认回 200 + 一张图的 JSON。
 * images 端点的上游 body 是明文 JSON（不是 zstd），所以这里能直接 JSON.parse。
 */
function makeFakeFetch({ status = 200, json = null, handler = null } = {}) {
  const calls = []
  const fn = async (url, init) => {
    const entry = {
      url: String(url),
      headers: init?.headers || {},
      text: typeof init?.body === 'string' ? init.body : Buffer.isBuffer(init?.body) ? init.body.toString('utf8') : '',
      signal: init?.signal,
    }
    try { entry.body = JSON.parse(entry.text || '{}') } catch { entry.body = null }
    calls.push(entry)
    if (handler) {
      const custom = await handler(entry, calls.length)
      if (custom) return custom
    }
    if (status !== 200) {
      return new Response(JSON.stringify(json ?? { error: { message: 'boom', code: 'upstream_error' } }), {
        status, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(json ?? {
      created: 1793295439,
      data: [{ b64_json: null, url: 'https://example.invalid/img/x.png', revised_prompt: 'a cat' }],
      usage: { input_tokens: 11, output_tokens: 1, total_tokens: 12 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-codex-plan-type': 'pro' } })
  }
  fn.calls = calls
  return fn
}

async function startServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      if (await handler.handle(req, res)) return
      res.writeHead(404); res.end()
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500); res.end() }
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

async function request({ port, route, method = 'POST', body, raw = null, headers = {} }) {
  const init = { method, headers: { ...headers } }
  if (raw) {
    init.body = raw
  } else if (body !== undefined) {
    init.headers['content-type'] = init.headers['content-type'] || 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`http://127.0.0.1:${port}${route}`, init)
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, headers: Object.fromEntries(res.headers), text, parsed }
}

const quiet = { warn() {}, info() {} }

// ═══════════════ 1. 模型清单与启停 ═══════════════

console.log('\n1. 模型清单与启停')
{
  eq('IMAGE_MODELS 两个模型', [...IMAGE_MODELS], ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
  eq('快照名归一到 flare', canonicalImageModel('gpt-image-2.5-flare-2026-09-08'), 'gpt-image-2.5-flare')
  eq('provider/id 形态归一', canonicalImageModel('openai/gpt-image-2.5-sunburst'), 'gpt-image-2.5-sunburst')
  eq('未知模型返回 null', canonicalImageModel('dall-e-9'), null)
  eq('空串返回 null', canonicalImageModel('   '), null)

  eq('缺省清单全启用', enabledImageModels(null), ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
  eq('数组形态只留列出的', enabledImageModels(['gpt-image-2.5-sunburst']), ['gpt-image-2.5-sunburst'])
  eq('映射形态停用一个', enabledImageModels({ 'gpt-image-2.5-flare': { enabled: false } }), ['gpt-image-2.5-sunburst'])
  eq('映射形态布尔 false 停用', enabledImageModels({ 'gpt-image-2.5-sunburst': false }), ['gpt-image-2.5-flare'])
  eq('空数组表示全停用', enabledImageModels([]), [])

  // 配置默认值：两个图像模型都启用，且与 IMAGE_MODELS 是同一份
  eq('config 的 codex_image_models 缺省两个', DEFAULT_WORKER_CONFIG.codex_image_models, [...IMAGE_MODELS])
  eq('config 缺省清单被识别为全启用',
    enabledImageModels(DEFAULT_WORKER_CONFIG.codex_image_models), [...IMAGE_MODELS])
  eq('validateCodexConfig 保留 codex_image_models',
    validateCodexConfig({ codex_image_models: ['gpt-image-2.5-flare'] }).codex_image_models,
    ['gpt-image-2.5-flare'])
  let badImageModels = null
  try { validateCodexConfig({ codex_image_models: 'gpt-image-2.5-flare' }) } catch (e) { badImageModels = e }
  ok('codex_image_models 非数组时报错', badImageModels && /array/.test(badImageModels.message),
    badImageModels && badImageModels.message)
}

// ═══════════════ 2. 计划判定（Free 不接生图） ═══════════════

console.log('\n2. 计划判定')
{
  eq('free → 不可用', imageGenerationAvailable('free'), false)
  eq('Free 大小写无关 → 不可用', imageGenerationAvailable(' FREE '), false)
  eq('pro → 可用', imageGenerationAvailable('pro'), true)
  eq('plus → 可用', imageGenerationAvailable('plus'), true)
  eq('计划未知 → 放行（交给上游裁决）', imageGenerationAvailable(null), true)

  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_plan_type: 'free' },
  })).toString('base64url')
  eq('id_token 里读到 free', planTypeFromIdToken(`h.${payload}.s`), 'free')
  eq('坏 id_token 不抛错', planTypeFromIdToken('not-a-jwt'), null)
  eq('凭据显式 plan_type 优先', planTypeFromCredential({ plan_type: 'pro', id_token: `h.${payload}.s` }), 'pro')

  // 单账号形态：plan 只存在于 id_token
  const single = makeTempCredential({
    access_token: 'T', account_id: 'acct-1', expired: '2099-01-01T00:00:00Z',
    id_token: `h.${PayloadFor('free')}.s`,
  })
  eq('单账号从 id_token 推断 free', loadPlanTypes(single.file), { 'acct-1': 'free' })
  // 多账号形态：显式字段
  const multi = makeTempCredential({
    accounts: [
      { id: 'a1', access_token: 'T1', chatgpt_account_id: 'c1', expires_at: 4102444800, plan_type: 'free' },
      { id: 'a2', access_token: 'T2', chatgpt_account_id: 'c2', expires_at: 4102444800, chatgpt_plan_type: 'pro' },
    ],
  })
  eq('多账号计划表', loadPlanTypes(multi.file), { a1: 'free', a2: 'pro' })
}

/** 造一个只带 plan 声明的 id_token payload */
function PayloadFor(plan) {
  return Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: plan } })).toString('base64url')
}

// ═══════════════ 3. multipart 解析 ═══════════════

console.log('\n3. multipart 解析')
{
  eq('isMultipartFormData 命中', isMultipartFormData('multipart/form-data; boundary=x'), true)
  eq('isMultipartFormData 只认主类型', isMultipartFormData('application/json'), false)
  eq('boundary 取值', boundaryFromContentType('multipart/form-data; boundary=----abc'), '----abc')
  eq('boundary 带引号', boundaryFromContentType('multipart/form-data; boundary="----abc"'), '----abc')
  eq('boundary 参数在前也能取', boundaryFromContentType('multipart/form-data; charset=utf-8; boundary=zz'), 'zz')
  eq('非 multipart 取不到 boundary', boundaryFromContentType('application/json'), null)

  // 中文文件名 + 多文件 + 顺序
  const boundary = '----codexTestBoundary'
  const body = buildMultipart(boundary, [
    { name: 'model', data: 'gpt-image-2.5-flare' },
    { name: 'prompt', data: '把这只猫画成油画' },
    { name: 'n', data: '2' },
    { name: 'image[]', filename: '第一张.png', contentType: 'image/png', data: PNG_1PX },
    { name: 'image[]', filename: '第二张.jpg', contentType: 'image/jpeg', data: JPEG_HEAD },
    { name: 'mask', filename: '遮罩.png', contentType: 'image/png', data: PNG_1PX },
  ])
  const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`)
  eq('解析成功', parsed.ok, true)
  eq('六个 part', parsed.parts.length, 6)
  eq('中文文件名保留', parsed.parts[3].filename, '第一张.png')
  eq('第二张文件名', parsed.parts[4].filename, '第二张.jpg')
  eq('文件字节未被损坏', parsed.parts[3].data.equals(PNG_1PX), true)
  eq('字段名 image[]', parsed.parts[4].name, 'image[]')

  // 缺 boundary
  const noBoundary = parseMultipart(body, 'multipart/form-data')
  eq('缺 boundary 报错', noBoundary.ok, false)
  ok('缺 boundary 的错误文案可读', /boundary/.test(noBoundary.message), noBoundary.message)

  // boundary 与 body 不匹配
  const mismatch = parseMultipart(body, 'multipart/form-data; boundary=other')
  eq('boundary 不匹配报错', mismatch.ok, false)

  // 截断
  const truncated = parseMultipart(body.subarray(0, body.length - 30), `multipart/form-data; boundary=${boundary}`)
  eq('截断的 body 报错', truncated.ok, false)

  // 归一化：多图顺序、mask、数字字段
  const normalized = normalizeImageEditBody(body, `multipart/form-data; boundary=${boundary}`)
  eq('归一化成功', normalized.ok, true)
  eq('model 透传', normalized.body.model, 'gpt-image-2.5-flare')
  eq('prompt 中文保留', normalized.body.prompt, '把这只猫画成油画')
  eq('n 变成数字', normalized.body.n, 2)
  eq('images 两张且保序', normalized.body.images.length, 2)
  ok('第一张是 png data url', normalized.body.images[0].image_url.startsWith('data:image/png;base64,'),
    normalized.body.images[0].image_url.slice(0, 40))
  ok('第二张是 jpeg data url', normalized.body.images[1].image_url.startsWith('data:image/jpeg;base64,'),
    normalized.body.images[1].image_url.slice(0, 40))
  ok('mask 转成 data url', normalized.body.mask.image_url.startsWith('data:image/png;base64,'))
  ok('images 只保留 image_url 形态', 'images' in normalized.body && !('image' in normalized.body))

  // 缺图片 / 非图片文件 / 数字字段非法
  const noImage = buildMultipart(boundary, [{ name: 'prompt', data: 'x' }])
  eq('缺 image 报错', normalizeImageEditBody(noImage, `multipart/form-data; boundary=${boundary}`).ok, false)
  const badFile = buildMultipart(boundary, [
    { name: 'image', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('not an image') },
  ])
  const badFileOut = normalizeImageEditBody(badFile, `multipart/form-data; boundary=${boundary}`)
  eq('非图片上传报错', badFileOut.ok, false)
  ok('错误文案点名格式', /PNG, JPEG or WebP/.test(badFileOut.message), badFileOut.message)
  const badNumber = buildMultipart(boundary, [
    { name: 'image', filename: 'a.png', data: PNG_1PX },
    { name: 'n', data: 'two' },
  ])
  eq('n 非数字报错', normalizeImageEditBody(badNumber, `multipart/form-data; boundary=${boundary}`).ok, false)
  const putMaskAsFile = buildMultipart(boundary, [
    { name: 'mask', filename: 'a.png', data: PNG_1PX },
  ])
  const maskOnly = normalizeImageEditBody(putMaskAsFile, `multipart/form-data; boundary=${boundary}`)
  eq('只有 mask 没有 image 报错', maskOnly.ok, false)

  // webp 魔数
  ok('webp 被识别', imageReference(WEBP_HEAD).image_url.startsWith('data:image/webp;base64,'))
}

// ═══════════════ 4. 上游请求构造 ═══════════════

console.log('\n4. 上游请求构造')
{
  eq('images 端点路径', imageUrls('https://chatgpt.com/backend-api/codex'), {
    generations: 'https://chatgpt.com/backend-api/codex/images/generations',
    edits: 'https://chatgpt.com/backend-api/codex/images/edits',
  })
  eq('尾斜杠被吃掉', imageUrls('https://chatgpt.com/backend-api/codex///').generations,
    'https://chatgpt.com/backend-api/codex/images/generations')

  const h = buildImageHeaders(
    { access_token: 'TOK', chatgpt_account_id: 'acct' },
    { turnId: 'turn-1', turnMetadata: '{"a":1}' },
  )
  eq('带 Bearer', h.authorization, 'Bearer TOK')
  eq('带 account id', h['chatgpt-account-id'], 'acct')
  eq('accept 是 json 不是 SSE', h.accept, 'application/json')
  eq('回传 image turn id', h['x-codex-image-turn-id'], 'turn-1')
  eq('回传 turn metadata', h['x-codex-turn-metadata'], '{"a":1}')
  eq('不压缩 body', 'content-encoding' in h, false)
  eq('不带 session-id（生图不是推理轮次）', 'session-id' in h, false)
  eq('不现造 x-codex-turn-id', 'x-codex-turn-id' in h, false)
  eq('originator 来自 UA', h.originator, 'codex_cli_rs')
  eq('version 来自 UA', h.version, '0.160.0')
}

// ═══════════════ 5. 选号与 Free 排除 ═══════════════

console.log('\n5. 选号与 Free 排除')
{
  const accounts = [
    { id: 'free-1', plan_type: 'free' },
    { id: 'pro-1', plan_type: 'pro' },
    { id: 'plus-1', plan_type: null },
  ]
  const scheduler = new AccountScheduler(accounts)
  // selectImageAccount 自己不看 plan，由调用方先过滤；这里验证排除集生效
  const picked = selectImageAccount(scheduler, [accounts[1], accounts[2]], { excluded: new Set(['free-1']) })
  eq('排除 Free 后选到 pro', picked.account.id, 'pro-1')
  eq('选了就占坑', scheduler.inflight.get('pro-1'), 1)
  scheduler.release('pro-1')
  eq('释放后归零', scheduler.inflight.get('pro-1'), undefined)

  // 粘性：把 session 绑到 plus-1，再选应命中它而不是扫描到的 pro-1
  scheduler.sessionAffinity.set('codex-image-turn:t1', 'plus-1')
  const sticky = selectImageAccount(scheduler, [accounts[1], accounts[2]], { sessionId: 'codex-image-turn:t1' })
  eq('粘性命中已绑定的槽位', sticky.account.id, 'plus-1')
  eq('粘性命中的来源标记', sticky.via, 'session')
  scheduler.release('plus-1')

  // 全被排除时抛错
  let threw = null
  try {
    selectImageAccount(scheduler, [accounts[1]], { excluded: new Set(['pro-1']) })
  } catch (e) { threw = e }
  ok('无可选槽位时抛 all_rejected', threw && threw.code === 'all_rejected', threw && threw.message)
}

// ═══════════════ 6. runImages：Free / 停用模型 / 缺 model ═══════════════

console.log('\n6. runImages 的准入判定')
{
  const sent = []
  const send = async (p) => { sent.push(p); return { status: 200, headers: {}, text: '{"data":[]}' } }
  const scheduler = new AccountScheduler([{ id: 'free-1', plan_type: 'free' }])

  const freeOnly = await runImages({
    kind: 'generations', body: { model: 'gpt-image-2.5-flare', prompt: 'x' },
    scheduler, accounts: [{ id: 'free-1', plan_type: 'free' }], send,
  })
  eq('全 Free 池 → 403', freeOnly.status, 403)
  eq('错误码 image_generation_unavailable', freeOnly.body.error.code, 'image_generation_unavailable')
  eq('错误类型 permission_error', freeOnly.body.error.type, 'permission_error')
  eq('Free 请求没有打到上游', sent.length, 0)

  // 混合池：Free 被跳过
  const mixed = new AccountScheduler([{ id: 'free-1' }, { id: 'pro-1' }])
  const mixedOut = await runImages({
    kind: 'generations', body: { model: 'gpt-image-2.5-flare', prompt: 'x' },
    scheduler: mixed, accounts: [{ id: 'free-1', plan_type: 'free' }, { id: 'pro-1', plan_type: 'pro' }], send,
  })
  eq('混合池走成功', mixedOut.status, 200)
  eq('只发给 pro 号', sent.map((c) => c.account.id), ['pro-1'])
  eq('混合池 inflight 归零', mixed.inflight.get('pro-1'), undefined)

  // 停用模型
  const disabled = await runImages({
    kind: 'generations', body: { model: 'gpt-image-2.5-sunburst', prompt: 'x' },
    scheduler: new AccountScheduler([{ id: 'pro-1' }]),
    accounts: [{ id: 'pro-1', plan_type: 'pro' }],
    imageModels: ['gpt-image-2.5-flare'],
    send,
  })
  eq('停用模型 → 400', disabled.status, 400)
  eq('错误码 model_disabled', disabled.body.error.code, 'model_disabled')

  // 快照名同样受启停约束
  const disabledSnapshot = await runImages({
    kind: 'generations', body: { model: 'gpt-image-2.5-sunburst-2026-09-08', prompt: 'x' },
    scheduler: new AccountScheduler([{ id: 'pro-1' }]),
    accounts: [{ id: 'pro-1', plan_type: 'pro' }],
    imageModels: ['gpt-image-2.5-flare'],
    send,
  })
  eq('停用模型的快照名也 400', disabledSnapshot.status, 400)

  // 缺 model：放行给上游，body 不改写
  const before = sent.length
  const noModel = await runImages({
    kind: 'generations', body: { prompt: 'x' },
    scheduler: new AccountScheduler([{ id: 'pro-1' }]),
    accounts: [{ id: 'pro-1', plan_type: 'pro' }], send,
  })
  eq('缺 model 不本地拒绝', noModel.status, 200)
  eq('缺 model 时 body 保持原样', sent[sent.length - 1].body, { prompt: 'x' })
  ok('缺 model 确实发了请求', sent.length === before + 1)

  // body 不是对象
  const badBody = await runImages({
    kind: 'generations', body: [1, 2, 3],
    scheduler: new AccountScheduler([{ id: 'pro-1' }]),
    accounts: [{ id: 'pro-1', plan_type: 'pro' }], send,
  })
  eq('数组 body → 400', badBody.status, 400)
  eq('数组 body 错误码', badBody.body.error.code, 'invalid_request')
}

// ═══════════════ 7. HTTP 层：generations ═══════════════

console.log('\n7. HTTP /v1/images/generations')
{
  const cred = makeTempCredential({
    access_token: 'TOKEN_GEN',
    account_id: 'acct-gen',
    expired: '2099-01-01T00:00:00Z',
    plan_type: 'pro',
  })
  const fake = makeFakeFetch()
  const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: quiet })
  eq('plan_type 贴到账号上', handler.imageAccounts[0].plan_type, 'pro')
  const srv = await startServer(handler)
  try {
    const r = await request({
      port: srv.port, route: '/v1/images/generations',
      body: { model: 'gpt-image-2.5-flare', prompt: '一只橘猫', size: '1024x1024', n: 1 },
    })
    eq('生成 200', r.status, 200)
    eq('返回体原样回流', r.parsed.data[0].revised_prompt, 'a cat')
    eq('买单一次上游调用', fake.calls.length, 1)
    eq('上游 URL 是 images/generations',
      fake.calls[0].url, 'https://chatgpt.com/backend-api/codex/images/generations')
    eq('上游 body 原样透传（无 store 注入）', fake.calls[0].body, {
      model: 'gpt-image-2.5-flare', prompt: '一只橘猫', size: '1024x1024', n: 1,
    })
    eq('上游 body 不带 stream', 'stream' in fake.calls[0].body, false)
    eq('上游头用账号 token', fake.calls[0].headers.authorization, 'Bearer TOKEN_GEN')
    eq('上游头带 account id', fake.calls[0].headers['chatgpt-account-id'], 'acct-gen')
    eq('上游头 accept json', fake.calls[0].headers.accept, 'application/json')
    eq('上游不带 content-encoding', 'content-encoding' in fake.calls[0].headers, false)
    eq('上游不设 content-length', 'content-length' in fake.calls[0].headers, false)
    eq('请求结束后 inflight 归零', handler.scheduler.snapshot().accounts[0].inflight, 0)

    // 方法不匹配 / 坏 JSON
    const w = await request({ port: srv.port, route: '/v1/images/generations', method: 'GET' })
    eq('GET generations → 405', w.status, 405)
    const bad = await request({ port: srv.port, route: '/v1/images/generations', raw: 'not json', headers: { 'content-type': 'application/json' } })
    eq('坏 JSON → 400', bad.status, 400)
    eq('坏 JSON 错误码', bad.parsed.error.code, 'invalid_json')
  } finally { await srv.close() }
}

// ═══════════════ 8. HTTP 层：计划与模型判定 ═══════════════

console.log('\n8. HTTP 层：Free 403 与停用模型 400')
{
  const freeCred = makeTempCredential({
    access_token: 'T_FREE', account_id: 'acct-free', expired: '2099-01-01T00:00:00Z', plan_type: 'free',
  })
  const fake = makeFakeFetch()
  const freeHandler = createCodexHandler({ credentialPath: freeCred.file, fetchImpl: fake, logger: quiet })
  const srv = await startServer(freeHandler)
  try {
    const r = await request({
      port: srv.port, route: '/v1/images/generations',
      body: { model: 'gpt-image-2.5-flare', prompt: 'x' },
    })
    eq('Free 号 → 403', r.status, 403)
    eq('Free 号错误码', r.parsed.error.code, 'image_generation_unavailable')
    eq('Free 号错误状态字段', r.parsed.error.status, 403)
    eq('Free 号没有打上游', fake.calls.length, 0)

    const e = await request({
      port: srv.port, route: '/v1/images/edits',
      body: { model: 'gpt-image-2.5-flare', prompt: 'x' },
    })
    eq('edits 也走同一套 Free 判定', e.status, 403)
  } finally { await srv.close() }

  // 停用模型（pro 号）
  const proCred = makeTempCredential({
    access_token: 'T_PRO', account_id: 'acct-pro', expired: '2099-01-01T00:00:00Z', plan_type: 'pro',
  })
  const fake2 = makeFakeFetch()
  const handler2 = createCodexHandler({
    credentialPath: proCred.file, fetchImpl: fake2, logger: quiet,
    imageModels: ['gpt-image-2.5-flare'],
  })
  const srv2 = await startServer(handler2)
  try {
    const r = await request({
      port: srv2.port, route: '/v1/images/generations',
      body: { model: 'gpt-image-2.5-sunburst', prompt: 'x' },
    })
    eq('停用模型 → 400', r.status, 400)
    eq('停用模型错误码', r.parsed.error.code, 'model_disabled')
    eq('停用模型不打上游', fake2.calls.length, 0)

    const good = await request({
      port: srv2.port, route: '/v1/images/generations',
      body: { model: 'gpt-image-2.5-flare', prompt: 'x' },
    })
    eq('启用模型放行', good.status, 200)
  } finally { await srv2.close() }
}

// ═══════════════ 9. 多号 + x-codex-image-turn-id 粘性 ═══════════════

console.log('\n9. 多号与 x-codex-image-turn-id 粘性')
{
  const cred = makeTempCredential({
    accounts: [
      { id: 'a1', access_token: 'T1', chatgpt_account_id: 'c1', expires_at: 4102444800, plan_type: 'pro' },
      { id: 'a2', access_token: 'T2', chatgpt_account_id: 'c2', expires_at: 4102444800, plan_type: 'pro' },
    ],
  })
  const fake = makeFakeFetch()
  const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: quiet })
  const srv = await startServer(handler)
  try {
    // 先把 a1 打进冷却，让首轮扫描只能选 a2，这样"粘性命中"才可与"扫描"区分开
    handler.scheduler.markCooldown('a1', { status: 429 })
    const first = await request({
      port: srv.port, route: '/v1/images/generations',
      headers: { 'x-codex-image-turn-id': 'turn-X' },
      body: { model: 'gpt-image-2.5-flare', prompt: '第一轮' },
    })
    eq('首轮 200', first.status, 200)
    eq('a1 冷却期间落到 a2', fake.calls[0].headers.authorization, 'Bearer T2')
    eq('image turn id 回传上游', fake.calls[0].headers['x-codex-image-turn-id'], 'turn-X')
    eq('粘性绑到 codex-image-turn:turn-X', handler.scheduler.sessionAffinity.get('codex-image-turn:turn-X'), 'a2')

    // 解掉冷却：扫描会优先 a1，但同一 turn id 必须仍回 a2
    handler.scheduler.cooldownUntil.delete('a1')
    const second = await request({
      port: srv.port, route: '/v1/images/generations',
      headers: { 'x-codex-image-turn-id': 'turn-X' },
      body: { model: 'gpt-image-2.5-flare', prompt: '第二轮' },
    })
    eq('同一 turn id 第二轮 200', second.status, 200)
    eq('同一 turn id 固定回 a2', fake.calls[1].headers.authorization, 'Bearer T2')

    // 另一个 turn id：走扫描 → a1，不受上一个 turn 影响
    const other = await request({
      port: srv.port, route: '/v1/images/generations',
      headers: { 'x-codex-image-turn-id': 'turn-Y' },
      body: { model: 'gpt-image-2.5-flare', prompt: '另一轮' },
    })
    eq('新 turn id 200', other.status, 200)
    eq('新 turn id 走扫描选 a1', fake.calls[2].headers.authorization, 'Bearer T1')

    // 不带 turn id：不建会话键，也不带 image turn 头
    await request({
      port: srv.port, route: '/v1/images/generations',
      body: { model: 'gpt-image-2.5-flare', prompt: '无 turn' },
    })
    eq('无 turn id 不带上游头', 'x-codex-image-turn-id' in fake.calls[3].headers, false)
    eq('无 turn id 不建粘性键', handler.scheduler.sessionAffinity.has('codex-image-turn:null'), false)
    eq('四个请求后 inflight 全归零',
      handler.scheduler.snapshot().accounts.map((a) => a.inflight), [0, 0])
  } finally { await srv.close() }
}

// ═══════════════ 10. 失败换号与不可换号 ═══════════════

console.log('\n10. 失败换号')
{
  const cred = makeTempCredential({
    accounts: [
      { id: 'a1', access_token: 'T1', chatgpt_account_id: 'c1', expires_at: 4102444800, plan_type: 'pro' },
      { id: 'a2', access_token: 'T2', chatgpt_account_id: 'c2', expires_at: 4102444800, plan_type: 'pro' },
    ],
  })
  // a1 回 500，a2 回 200
  const fake = makeFakeFetch({
    handler: (entry) => {
      if (entry.headers.authorization === 'Bearer T1') {
        return new Response(JSON.stringify({ error: { message: 'upstream broke' } }), { status: 500 })
      }
      return null
    },
  })
  const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: quiet })
  const srv = await startServer(handler)
  try {
    const r = await request({
      port: srv.port, route: '/v1/images/generations',
      body: { model: 'gpt-image-2.5-flare', prompt: 'x' },
    })
    eq('5xx 后换号成功', r.status, 200)
    eq('试了两个号', fake.calls.length, 2)
    eq('第二个号才是 a2', fake.calls[1].headers.authorization, 'Bearer T2')
    eq('a1 被冷却', handler.scheduler.cooldownUntil.has('a1'), true)
    eq('换号后 inflight 归零',
      handler.scheduler.snapshot().accounts.map((a) => a.inflight), [0, 0])
  } finally { await srv.close() }

  // 400 不换号：请求本身有问题，换号没意义
  const fake400 = makeFakeFetch({ status: 400, json: { error: { message: 'bad prompt', code: 'invalid_prompt' } } })
  const h400 = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake400, logger: quiet })
  const srv400 = await startServer(h400)
  try {
    const r = await request({
      port: srv400.port, route: '/v1/images/generations',
      body: { model: 'gpt-image-2.5-flare', prompt: 'x' },
    })
    eq('上游 400 原样回给客户端', r.status, 400)
    eq('400 只打一次上游', fake400.calls.length, 1)
    eq('400 的 payload 原样回流', r.parsed.error.message, 'bad prompt')
  } finally { await srv400.close() }
}

// ═══════════════ 11. HTTP 层：edits multipart ═══════════════

console.log('\n11. HTTP /v1/images/edits（multipart）')
{
  const cred = makeTempCredential({
    access_token: 'T_EDIT', account_id: 'acct-edit', expired: '2099-01-01T00:00:00Z', plan_type: 'pro',
  })
  const fake = makeFakeFetch()
  const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: quiet })
  const srv = await startServer(handler)
  try {
    const boundary = '----editBoundary42'
    const raw = buildMultipart(boundary, [
      { name: 'model', data: 'gpt-image-2.5-flare' },
      { name: 'prompt', data: '给这只猫加一顶帽子' },
      { name: 'n', data: '1' },
      { name: 'image', filename: '猫.png', contentType: 'image/png', data: PNG_1PX },
    ])
    const r = await request({
      port: srv.port, route: '/v1/images/edits', raw,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
    eq('edits 200', r.status, 200)
    eq('上游 URL 是 images/edits', fake.calls[0].url, 'https://chatgpt.com/backend-api/codex/images/edits')
    eq('multipart 被转成 JSON', fake.calls[0].body.model, 'gpt-image-2.5-flare')
    eq('中文 prompt 完整送达', fake.calls[0].body.prompt, '给这只猫加一顶帽子')
    eq('n 是数字', fake.calls[0].body.n, 1)
    eq('images 一项', fake.calls[0].body.images.length, 1)
    ok('图片转成 data url', fake.calls[0].body.images[0].image_url.startsWith('data:image/png;base64,'))
    eq('上游 content-type 是 json', fake.calls[0].headers['content-type'], 'application/json')

    // 缺 boundary → 400 invalid_image_edit
    const broken = await request({
      port: srv.port, route: '/v1/images/edits', raw,
      headers: { 'content-type': 'multipart/form-data' },
    })
    eq('缺 boundary → 400', broken.status, 400)
    eq('缺 boundary 错误码', broken.parsed.error.code, 'invalid_image_edit')
    ok('缺 boundary 错误文案含 boundary', /boundary/.test(broken.parsed.error.message),
      broken.parsed.error.message)

    // JSON 直传 images[] 也收
    const jsonEdit = await request({
      port: srv.port, route: '/v1/images/edits',
      body: { model: 'gpt-image-2.5-flare', prompt: 'json 直传', images: [{ image_url: 'data:image/png;base64,AAA' }] },
    })
    eq('JSON 直传 edits 200', jsonEdit.status, 200)
    eq('JSON 直传的 images 原样透传', fake.calls[fake.calls.length - 1].body.images, [{ image_url: 'data:image/png;base64,AAA' }])

    // 非图片上传 → 400
    const badUpload = buildMultipart(boundary, [
      { name: 'image', filename: 'a.txt', data: Buffer.from('hello') },
    ])
    const badRes = await request({
      port: srv.port, route: '/v1/images/edits', raw: badUpload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    })
    eq('非图片上传 → 400', badRes.status, 400)
    eq('非图片上传错误码', badRes.parsed.error.code, 'invalid_image_edit')

    // 方法不匹配
    const w = await request({ port: srv.port, route: '/v1/images/edits', method: 'GET' })
    eq('GET edits → 405', w.status, 405)
  } finally { await srv.close() }
}

// ═══════════════ 12. /v1/models 列出图像模型 ═══════════════

console.log('\n12. /v1/models')
{
  const cred = makeTempCredential({
    access_token: 'T', account_id: 'a', expired: '2099-01-01T00:00:00Z', plan_type: 'pro',
  })
  const handler = createCodexHandler({
    credentialPath: cred.file, fetchImpl: makeFakeFetch(), logger: quiet,
    imageModels: ['gpt-image-2.5-flare'],
  })
  const srv = await startServer(handler)
  try {
    const r = await request({ port: srv.port, route: '/v1/models', method: 'GET' })
    eq('models 200', r.status, 200)
    eq('models 仍是 list', r.parsed.object, 'list')
    ok('对话模型仍在', r.parsed.data.some((m) => m.id === 'gpt-6-astra'))
    ok('图像模型被列出', r.parsed.data.some((m) => m.id === 'gpt-image-2.5-flare'))
    ok('停用的图像模型不列出', !r.parsed.data.some((m) => m.id === 'gpt-image-2.5-sunburst'))
    eq('图像模型用 openai-image 归属',
      r.parsed.data.find((m) => m.id === 'gpt-image-2.5-flare').owned_by, 'openai-image')
    eq('总条数是对话 9 + 图像 1', r.parsed.data.length, 10)
  } finally { await srv.close() }
}

// ═══════════════ 13. 客户端断开 ═══════════════

console.log('\n13. 客户端断开时 abort 上游')
{
  const cred = makeTempCredential({
    access_token: 'T', account_id: 'a', expired: '2099-01-01T00:00:00Z', plan_type: 'pro',
  })
  let upstreamAborted = false
  const fake = async (url, init) => {
    init.signal?.addEventListener('abort', () => { upstreamAborted = true })
    await sleep(400)
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }
  const handler = createCodexHandler({ credentialPath: cred.file, fetchImpl: fake, logger: quiet })
  const srv = await startServer(handler)
  try {
    const ctrl = new AbortController()
    const p = fetch(`http://127.0.0.1:${srv.port}/v1/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2.5-flare', prompt: 'x' }),
      signal: ctrl.signal,
    }).catch(() => null)
    await sleep(120)
    ctrl.abort()
    await p
    await sleep(400)
    ok('客户端断开后上游被 abort', upstreamAborted)
    eq('断开后 inflight 归零', handler.scheduler.snapshot().accounts[0].inflight, 0)
  } finally { await srv.close() }
}

// ═══════════════ 14. 直接调用 handler 出口 ═══════════════

console.log('\n14. handleImageGenerations / handleImageEdits 直接调用')
{
  const send = async () => ({ status: 200, headers: { 'x-codex-plan-type': 'pro' }, text: '{"data":[{"url":"u"}]}' })
  const gen = await handleImageGenerations({
    body: { model: 'gpt-image-2.5-flare', prompt: 'x' },
    scheduler: new AccountScheduler([{ id: 'p', plan_type: 'pro' }]),
    accounts: [{ id: 'p', plan_type: 'pro' }],
    send,
  })
  eq('generations 出口 200', gen.status, 200)
  eq('generations 出口带账号 id', gen.accountId, 'p')
  eq('generations 出口 attempts=1', gen.attempts, 1)

  // edits 缺 body 且缺 raw
  const emptyEdits = await handleImageEdits({
    scheduler: new AccountScheduler([{ id: 'p', plan_type: 'pro' }]),
    accounts: [{ id: 'p', plan_type: 'pro' }],
    send,
  })
  eq('edits 无 body 无 raw → 400', emptyEdits.status, 400)

  // edits 走 raw JSON
  const jsonEdits = await handleImageEdits({
    raw: Buffer.from(JSON.stringify({ model: 'gpt-image-2.5-flare', images: [{ image_url: 'data:image/png;base64,AA' }] })),
    contentType: 'application/json',
    scheduler: new AccountScheduler([{ id: 'p', plan_type: 'pro' }]),
    accounts: [{ id: 'p', plan_type: 'pro' }],
    send,
  })
  eq('edits 直接收 JSON raw', jsonEdits.status, 200)

  // 传输失败 → 502
  const failSend = async () => ({ status: 0, headers: {}, error: 'upstream_timeout' })
  const timeout = await runImages({
    kind: 'generations', body: { model: 'gpt-image-2.5-flare', prompt: 'x' },
    scheduler: new AccountScheduler([{ id: 'p', plan_type: 'pro' }]),
    accounts: [{ id: 'p', plan_type: 'pro' }],
    send: failSend, deadlineMs: 0,
  })
  eq('传输失败 → 502', timeout.status, 502)
  eq('传输失败错误码', timeout.body.error.code, 'upstream_timeout')

  // 上游回非 JSON → 502 upstream_invalid_body
  const htmlSend = async () => ({ status: 502, headers: {}, text: '<html>bad gateway</html>' })
  const html = await runImages({
    kind: 'generations', body: { model: 'gpt-image-2.5-flare', prompt: 'x' },
    scheduler: new AccountScheduler([{ id: 'p', plan_type: 'pro' }]),
    accounts: [{ id: 'p', plan_type: 'pro' }],
    send: htmlSend, deadlineMs: 0,
  })
  eq('非 JSON 上游体 → 502', html.status, 502)
  eq('非 JSON 错误码', html.body.error.code, 'upstream_invalid_body')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
