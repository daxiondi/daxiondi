/**
 * 出站 metadata.user_id 注入 + 泄露型客户端 UA 剥离。
 *
 * 为什么这层必须有测试：两个失败都不会报错。
 *   · metadata 没注入 → 请求照常成功，但每一条都缺官方恒写的那份身份；
 *   · 字符串形态的 metadata 原样透传 → 本层写的 user_id 根本没进去；
 *   · 第三方 UA 原样出站 → 请求成功，但上游一眼看出不是官方客户端。
 * 三种都要靠断言守住，不能靠"看起来对"。
 *
 * 对齐依据：官方 vm2api v1.3.220
 *   · `src/lib/identity/identity-rewrite.mjs:457-469`（metadata 重写）
 *   · `src/lib/identity/official-claude-ua.mjs`（UA 识别）
 */

import {
  prepareOutbound,
  applyOutboundMetadata,
  rewriteOutboundMetadata,
  parseMetadataObject,
  parseMetadataUserId,
  resolveMetadataDeviceId,
  resolveMetadataSessionId,
  outboundVmId,
  METADATA_DROP_KEY_RE,
  DEFAULT_METADATA_VM_ID,
} from '../src/server.mjs'
import { claudeHomeForSlot } from '../src/persona/claude-home.mjs'
import { outboundDeviceId } from '../src/frames.mjs'
import {
  CLAUDE_CLI_UA_RE,
  OFFICIAL_CLAUDE_CLI_UA,
  isOfficialClaudeUa,
  isUnofficialClaudeEntrypointUa,
  normalizeCallerUa,
} from '../src/official-ua.mjs'
import { AnthropicUpstream, MODE, buildOutboundHeaders } from '../src/anthropic.mjs'
import { sanitizeAnthropicBody } from '../src/sanitize.mjs'
import http from 'node:http'

let pass = 0
const fails = []

function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass += 1
    return
  }
  fails.push(label)
  console.log(`  FAIL  ${label}\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`)
}

function ok(label, condition, detail) {
  if (condition) {
    pass += 1
    return
  }
  fails.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? '' : `\n         ${JSON.stringify(detail)}`}`)
}

/** 出站 metadata.user_id 是「JSON 字符串再套一层」，这里统一解到对象 */
function outboundUserId(body) {
  return JSON.parse(body.metadata.user_id)
}

const BASE = Object.freeze({
  model: 'claude-sonnet-4-5',
  max_tokens: 64,
  stream: true,
  messages: [{ role: 'user', content: '你好' }],
})

const clone = (value) => JSON.parse(JSON.stringify(value))

// ── 1. metadata 缺失 → 补上，且形如官方
console.log('\n1. metadata 缺失时补上 user_id')
{
  const inbound = clone(BASE)
  const out = prepareOutbound(inbound, { systemLayout: 'identity', vmId: 'claude-slot-07' })

  eq('metadata 被创建', Object.prototype.hasOwnProperty.call(out, 'metadata'), true)
  eq('user_id 是字符串（JSON 再套一层）', typeof out.metadata.user_id, 'string')
  const uid = outboundUserId(out)
  eq('user_id 三个字段齐全', Object.keys(uid), ['device_id', 'account_uuid', 'session_id'])
  ok('device_id 是 64 位 hex', /^[0-9a-f]{64}$/.test(uid.device_id), uid.device_id)
  ok('session_id 非空', uid.session_id.length > 0, uid.session_id)
  eq('account_uuid 缺省为空串', uid.account_uuid, '')
  eq('入站 body 未被修改', Object.prototype.hasOwnProperty.call(inbound, 'metadata'), false)
}

// ── 2. 敏感键必须被剔除（正则与官方逐字符一致）
console.log('\n2. metadata 里的敏感键必须被剔除')
{
  eq(
    '过滤正则与官方一致',
    [METADATA_DROP_KEY_RE.source, METADATA_DROP_KEY_RE.flags],
    ['user|machine|device|host|tz|timezone|locale|setting|session_source|email', 'i'],
  )

  const SENSITIVE = [
    'user_id', 'machine_id', 'device_id', 'host', 'tz', 'timezone',
    'locale', 'settings', 'session_source', 'email',
    // 大小写变体也要命中
    'Machine_Id', 'TimeZone', 'EMAIL', 'Locale',
  ]
  const raw = { custom_field: 'keep-me', trace_id: 'abc' }
  for (const key of SENSITIVE) raw[key] = 'leak'
  const out = prepareOutbound({ ...clone(BASE), metadata: clone(raw) }, { systemLayout: 'identity', vmId: 'claude-slot-03' })

  eq('敏感键一个不剩', SENSITIVE.filter((k) => k !== 'user_id' && k in out.metadata), [])
  eq('无关字段保留', [out.metadata.custom_field, out.metadata.trace_id], ['keep-me', 'abc'])
  eq('user_id 仍在（恒写）', typeof out.metadata.user_id, 'string')
  ok('入站的 user_id 值没有被保留', out.metadata.user_id !== 'leak', out.metadata.user_id)
  eq(
    '输出 metadata 的键集合',
    Object.keys(out.metadata).sort(),
    ['custom_field', 'trace_id', 'user_id'],
  )
}

// ── 3. 字符串形态的 metadata 必须被解析后重写（已知缺口）
console.log('\n3. 字符串形态的 metadata')
{
  const oldUid = JSON.stringify({ device_id: 'f'.repeat(64), account_uuid: '', session_id: 'old-session' })
  const raw = JSON.stringify({ user_id: oldUid, keep: 'value', timezone: 'Asia/Shanghai' })
  const body = { ...clone(BASE), metadata: raw }
  const out = prepareOutbound(body, { systemLayout: 'identity', vmId: 'claude-slot-04' })

  eq('metadata 已从字符串变成对象', typeof out.metadata, 'object')
  eq('字符串里也必须过滤敏感键', 'timezone' in out.metadata, false)
  eq('无关字段保留', out.metadata.keep, 'value')
  const uid = outboundUserId(out)
  eq('device_id 被换成槽位值', uid.device_id, claudeHomeForSlot({ vmId: 'claude-slot-04' }).deviceId)
  ok('session_id 不再是旧值', uid.session_id !== 'old-session', uid.session_id)
  eq('入站 metadata 字符串未被改写', body.metadata, raw)
}
{
  // 非法字符串：不能让整条请求失败，按空 metadata 重建
  for (const bad of ['not json', '', 'null', '[1,2,3]', '42']) {
    const out = prepareOutbound({ ...clone(BASE), metadata: bad }, { systemLayout: 'identity', vmId: 'claude-slot-05' })
    ok(`非法 metadata ${JSON.stringify(bad)} 仍写出 user_id`, typeof out.metadata?.user_id === 'string', out.metadata)
  }
  const out = prepareOutbound({ ...clone(BASE), metadata: ['a'] }, { systemLayout: 'identity' })
  ok('数组形态的 metadata 被重建', typeof out.metadata?.user_id === 'string', out.metadata)
}
{
  // parseMetadataObject / parseMetadataUserId 的边界
  eq('对象原样读出', parseMetadataObject({ a: 1 }), { a: 1 })
  eq('字符串解析成对象', parseMetadataObject('{"a":1}'), { a: 1 })
  eq('空值返回空对象', parseMetadataObject(null), {})
  eq('数组当成空对象', parseMetadataObject([]), {})
  eq('user_id 字符串可解析', parseMetadataUserId('{"session_id":"s"}'), { session_id: 's' })
  eq('user_id 对象可解析', parseMetadataUserId({ session_id: 's' }), { session_id: 's' })
  eq('user_id 非法返回 null', parseMetadataUserId('nope'), null)
  eq('user_id 空值返回 null', parseMetadataUserId(undefined), null)
}

// ── 4. 已有 user_id 必须被覆盖，不是保留
console.log('\n4. 已有 user_id 被覆盖')
{
  const oldUid = JSON.stringify({
    device_id: 'a'.repeat(64),
    account_uuid: 'account-xyz',
    session_id: 'caller-session',
  })
  const out = prepareOutbound(
    { ...clone(BASE), metadata: { user_id: oldUid, label: 'x' } },
    { systemLayout: 'identity', vmId: 'claude-slot-09' },
  )
  const uid = outboundUserId(out)
  eq('device_id 被覆盖成槽位值', uid.device_id, claudeHomeForSlot({ vmId: 'claude-slot-09' }).deviceId)
  ok('session_id 被重建', uid.session_id !== 'caller-session', uid.session_id)
  // account_uuid 的取值顺序与官方一致：槽位身份优先，其次才是调用方给的
  eq('调用方 account_uuid 作为兜底保留（官方同序）', uid.account_uuid, 'account-xyz')
  eq('顶层其它字段不受影响', out.metadata.label, 'x')

  // 槽位显式给了 accountUuid 时，它优先于调用方的值
  const withAccount = applyOutboundMetadata(
    { ...clone(BASE), metadata: { user_id: oldUid } },
    { accountUuid: 'slot-account', vmId: 'claude-slot-09' },
  )
  eq('槽位 account_uuid 优先于调用方', JSON.parse(withAccount.metadata.user_id).account_uuid, 'slot-account')
}

// ── 5. device_id 与 persona 的磁盘身份同源
console.log('\n5. device_id 与 claudeHomeForSlot 一致')
{
  const identity = claudeHomeForSlot({ vmId: 'claude-slot-11' })
  const out = prepareOutbound(clone(BASE), { vmId: 'claude-slot-11' })
  eq('默认来源就是 claudeHomeForSlot', outboundUserId(out).device_id, identity.deviceId)
  eq('resolveMetadataDeviceId 同值', resolveMetadataDeviceId({ vmId: 'claude-slot-11' }), identity.deviceId)

  // 显式 deviceId 优先
  const explicit = prepareOutbound(clone(BASE), { deviceId: 'b'.repeat(64), vmId: 'claude-slot-11' })
  eq('显式 deviceId 优先', outboundUserId(explicit).device_id, 'b'.repeat(64))

  // 非 hex 的 deviceId 必须先哈希成 64-hex，否则上游直接拒绝
  const hashed = resolveMetadataDeviceId({ deviceId: 'legacy-uuid-shape' })
  eq('非 hex 走 sha256', hashed, outboundDeviceId('legacy-uuid-shape'))
  ok('哈希结果是 64-hex', /^[0-9a-f]{64}$/.test(hashed), hashed)

  // 缺 vmId 时落到缺省槽位，而不是抛错
  eq('缺 vmId 用缺省槽位', resolveMetadataDeviceId({}), outboundDeviceId(claudeHomeForSlot({ vmId: DEFAULT_METADATA_VM_ID }).deviceId))

  // 与磁盘 userID 的一致性：claudeHomeForSlot 的 deviceId 就是 userID
  eq('deviceId 与 userID 同值', identity.deviceId, identity.userId)
}

// ── 6. 20 个槽位 20 个设备
console.log('\n6. 20 个 vmId → 20 个不同 device_id')
{
  const devices = new Set()
  const sessions = new Set()
  for (let i = 1; i <= 20; i += 1) {
    const vmId = `claude-slot-${String(i).padStart(2, '0')}`
    const out = prepareOutbound(clone(BASE), { systemLayout: 'identity', vmId })
    const uid = outboundUserId(out)
    devices.add(uid.device_id)
    sessions.add(uid.session_id)
    eq(`${vmId} device_id 与磁盘身份一致`, uid.device_id, claudeHomeForSlot({ vmId }).deviceId)
  }
  eq('20 个 device_id 互不相同', devices.size, 20)
  eq('20 个 session_id 互不相同', sessions.size, 20)
}

// ── 7. session_id 的取值与重建
console.log('\n7. session_id 规则')
{
  const fromHeader = resolveMetadataSessionId({ headers: { 'x-session-id': 'header-session' }, vmId: 'claude-slot-01' })
  const again = resolveMetadataSessionId({ headers: { 'x-session-id': 'header-session' }, vmId: 'claude-slot-01' })
  eq('同一输入确定性派生', fromHeader, again)
  ok('派生结果不是入站原值（重建）', fromHeader !== 'header-session', fromHeader)
  ok('派生结果是 UUID 形态', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fromHeader), fromHeader)

  const otherSlot = resolveMetadataSessionId({ headers: { 'x-session-id': 'header-session' }, vmId: 'claude-slot-02' })
  ok('不同槽位派生不同 session', otherSlot !== fromHeader, otherSlot)

  // 显式 sessionId 直接用
  eq('显式 sessionId 优先', resolveMetadataSessionId({ sessionId: 'explicit', headers: { 'x-session-id': 'h' } }), 'explicit')

  // 邮箱形态：上游 has_at 直接 400，必须换成 UUID 形态
  const emailSession = resolveMetadataSessionId({ headers: { 'x-session-id': 'someone@example.com' } })
  ok('邮箱 session 不含 @', !emailSession.includes('@'), emailSession)
  ok('邮箱 session 是 UUID 形态', /^[0-9a-f-]{36}$/.test(emailSession), emailSession)
  ok('邮箱 session 确定性', emailSession === resolveMetadataSessionId({ headers: { 'x-session-id': 'someone@example.com' } }), emailSession)

  // 入站 metadata.user_id.session_id 作为锚点
  const fromMetadata = resolveMetadataSessionId({
    userId: { session_id: 'caller-session' },
    headers: {},
    vmId: 'claude-slot-01',
  })
  eq(
    'metadata 锚点与 header 锚点同源',
    fromMetadata,
    resolveMetadataSessionId({ headers: { 'x-session-id': 'caller-session' }, vmId: 'claude-slot-01' }),
  )

  // 无任何锚点时也不能为空
  const bare = resolveMetadataSessionId({})
  ok('无锚点仍产出 session', bare.length > 0, bare)
}

// ── 8. metadata 的顶层位置与幂等
console.log('\n8. 顶层位置、幂等、与封盖共存')
{
  const out = prepareOutbound(
    { model: 'm', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    { systemLayout: 'identity' },
  )
  const keys = Object.keys(out)
  ok('metadata 在 system 之后、max_tokens 之前（官方键序）', keys.indexOf('metadata') > keys.indexOf('system') && keys.indexOf('metadata') < keys.indexOf('max_tokens'), keys)

  // 有 tools 时应紧跟 tools
  const withTools = prepareOutbound(
    {
      model: 'm',
      max_tokens: 8,
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    { systemLayout: 'identity' },
  )
  const toolKeys = Object.keys(withTools)
  eq('metadata 紧跟 tools', toolKeys.indexOf('metadata'), toolKeys.indexOf('tools') + 1)

  // 重建不是幂等映射：第二次会拿上一次的派生值当锚点再派生一次。
  // 官方 rebuild 模式同理，出站链路只会走一次，这里只确认「同一入站输入
  // 重复请求结果一致」（见第 12 节）。
  const first = applyOutboundMetadata(clone(BASE), { vmId: 'claude-slot-12' })
  const again = applyOutboundMetadata(clone(BASE), { vmId: 'claude-slot-12' })
  eq('同一入站输入结果一致', again.metadata, first.metadata)

  // cch 仍然封盖成功（metadata 注入发生在封盖之前，不能破坏计费头）
  ok('system 里仍有 5 位 hex 的 cch', /cch=[0-9a-f]{5};/.test(out.system[0].text), out.system[0].text.slice(0, 120))

  // 走过最后一层清洗后 metadata 仍在（sanitize 的保留字段）
  const sanitized = sanitizeAnthropicBody(out)
  ok('清洗后 metadata 仍在', Boolean(sanitized.metadata?.user_id), Object.keys(sanitized))
}

// ── 9. UA 识别：与官方逐字符一致
console.log('\n9. UA 识别')
{
  eq('CLAUDE_CLI_UA_RE 与官方一致', [CLAUDE_CLI_UA_RE.source, CLAUDE_CLI_UA_RE.flags], ['^claude-cli\\/\\d+\\.\\d+\\.\\d+', 'i'])
  eq('官方回落 UA 常量', OFFICIAL_CLAUDE_CLI_UA, 'claude-cli/2.1.296 (external, sdk-cli)')

  for (const ua of [
    'claude-cli/2.1.296 (external, sdk-cli)',
    'claude-cli/2.1.296 (external, cli)',
    'claude-cli/1.0.0',
    'CLAUDE-CLI/2.1.296',
    '  claude-cli/2.1.280 (external, cli)  ',
  ]) {
    eq(`官方 UA 通过：${ua.trim()}`, isOfficialClaudeUa(ua), true)
  }
  for (const ua of [
    '',
    'claude-desktop/1.0',
    'agent-sdk/0.1.0',
    'claude-vscode/0.2.3',
    'local-agent/1.0',
    'Mozilla/5.0 claude-cli/2.1.296',
    'curl/8.7.1',
  ]) {
    eq(`非官方 UA 拒绝：${ua || '(空)'}`, isOfficialClaudeUa(ua), false)
  }

  // 泄漏入口标识
  eq('claude-desktop 判为第三方入口', isUnofficialClaudeEntrypointUa('claude-desktop/1.0'), true)
  eq('agent-sdk 判为第三方入口', isUnofficialClaudeEntrypointUa('agent-sdk/1.0'), true)
  eq('claude-vscode 判为第三方入口', isUnofficialClaudeEntrypointUa('claude-vscode/0.2'), true)
  eq('local-agent 判为第三方入口', isUnofficialClaudeEntrypointUa('local-agent/1.0'), true)
  eq('官方 UA 不算第三方入口', isUnofficialClaudeEntrypointUa('claude-cli/2.1.296 (external, sdk-cli)'), false)
  eq('无关 UA 不算第三方入口', isUnofficialClaudeEntrypointUa('curl/8.7.1'), false)
}

// ── 10. UA 归一化：非官方回落
console.log('\n10. UA 归一化与出站头')
{
  eq('官方 UA 原样保留', normalizeCallerUa('claude-cli/2.1.296 (external, cli)'), 'claude-cli/2.1.296 (external, cli)')
  eq('claude-desktop 回落官方 UA', normalizeCallerUa('claude-desktop/1.0'), 'claude-cli/2.1.296 (external, sdk-cli)')
  eq('agent-sdk 回落官方 UA', normalizeCallerUa('agent-sdk/1.0'), 'claude-cli/2.1.296 (external, sdk-cli)')
  eq('空 UA 回落官方 UA', normalizeCallerUa(''), 'claude-cli/2.1.296 (external, sdk-cli)')
  eq('可指定回落目标', normalizeCallerUa('claude-desktop/1.0', { officialUa: 'claude-cli/9.9.9 (external, cli)' }), 'claude-cli/9.9.9 (external, cli)')

  // 出站头构造：这是真正决定线上字节的那一步
  const leaky = buildOutboundHeaders({ token: 'sk-ant-oat01-x', callerUserAgent: 'claude-desktop/1.0' })
  eq('泄露 UA 不出现在出站头', leaky['user-agent'], 'claude-cli/2.1.296 (external, sdk-cli)')
  ok('出站 UA 是官方形态', isOfficialClaudeUa(leaky['user-agent']), leaky['user-agent'])
  eq('x-app 仍是 cli（成组）', leaky['x-app'], 'cli')

  const official = buildOutboundHeaders({ token: 'sk-ant-oat01-x', callerUserAgent: 'claude-cli/2.1.280 (external, cli)' })
  eq('官方 UA 原样出站', official['user-agent'], 'claude-cli/2.1.280 (external, cli)')

  const dflt = buildOutboundHeaders({ token: 'sk-ant-oat01-x' })
  eq('未给 UA 时用官方 UA', dflt['user-agent'], 'claude-cli/2.1.296 (external, sdk-cli)')

  // agent-sdk / vscode / local-agent 三种入口都不能带出去
  for (const ua of ['agent-sdk/1.0', 'claude-vscode/0.2.3', 'local-agent/1.0', 'curl/8.7.1']) {
    const headers = buildOutboundHeaders({ callerUserAgent: ua })
    eq(`出站剥掉 ${ua}`, headers['user-agent'], 'claude-cli/2.1.296 (external, sdk-cli)')
  }
}

// ── 11. 槽位 ID 映射
console.log('\n11. 槽位 ID 映射')
{
  eq('配置优先', outboundVmId({ config: { vm_id: 'vm-configured' }, slot: 's07' }), 'vm-configured')
  eq('容器内 PERSONA_VM_ID 优先于槽位号', outboundVmId({ env: { PERSONA_VM_ID: 'claude-slot-19' }, slot: 's07' }), 'claude-slot-19')
  eq('环境变量次之', outboundVmId({ env: { SKYLINK_VM_ID: 'vm-env' }, slot: 's07' }), 'vm-env')
  eq('槽位号补成 claude-slot-NN', outboundVmId({ slot: 's07' }), 'claude-slot-08')
  eq('s00 是 01', outboundVmId({ slot: 's00' }), 'claude-slot-01')
  eq('无槽位时缺省', outboundVmId({}), 'claude-slot-01')
}

// ── 12. 服务端链路：同一份请求走 prepareOutbound 两次结果稳定
console.log('\n12. 稳定性（重试不换身份）')
{
  const one = prepareOutbound(clone(BASE), { systemLayout: 'identity', vmId: 'claude-slot-14' })
  const two = prepareOutbound(clone(BASE), { systemLayout: 'identity', vmId: 'claude-slot-14' })
  eq('重试得到同一个 metadata', one.metadata, two.metadata)
  eq('重试得到同一个 cch', one.system[0].text.match(/cch=[0-9a-f]{5};/)?.[0], two.system[0].text.match(/cch=[0-9a-f]{5};/)?.[0])

  // rewriteOutboundMetadata 直接调用时也不改入参
  const raw = { user_id: 'x', email: 'a@b.c', keep: 1 }
  const rewritten = rewriteOutboundMetadata(raw, { deviceId: 'c'.repeat(64), sessionId: 's' })
  eq('直接调用只返回新对象', Object.keys(raw).sort(), ['email', 'keep', 'user_id'])
  eq('返回对象不含敏感键', Object.keys(rewritten).sort(), ['keep', 'user_id'])
  eq('user_id 由入参拼出', JSON.parse(rewritten.user_id), {
    device_id: 'c'.repeat(64),
    account_uuid: '',
    session_id: 's',
  })
}

// ── 13. 真实 HTTP：抓最终出站字节
//
// 前面的断言都停在函数返回值上。这一节起一个真实 HTTP 服务，用真实的
// 传输层把请求发出去，抓回线上字节再验一遍——编码/清洗是最后一公里，
// 任何一层把它改掉，只有这条断言会发现。
console.log('\n13. 真实 HTTP 出站字节')
{
  const captured = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      captured.push({ headers: req.headers, raw: Buffer.concat(chunks) })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    const vmId = 'claude-slot-15'
    const upstream = new AnthropicUpstream({ baseUrl: `http://127.0.0.1:${port}` })
    const body = prepareOutbound(clone(BASE), { systemLayout: 'identity', vmId })
    const headers = buildOutboundHeaders({ token: 'sk-ant-oat01-test', callerUserAgent: 'claude-desktop/1.0' })
    // 模拟直连调用：调用方绕过 buildOutboundHeaders，自己往 headers 里塞 UA
    headers['user-agent'] = 'claude-desktop/1.0'
    await upstream.createMessage({ body, headers, mode: MODE.STREAM })

    const sent = captured[0]
    const text = sent.raw.toString('utf8')
    const wire = JSON.parse(text)
    ok('真实 HTTP：wire 体带 metadata.user_id', typeof wire.metadata?.user_id === 'string', wire.metadata)
    eq('真实 HTTP：device_id 是槽位值', JSON.parse(wire.metadata.user_id).device_id, claudeHomeForSlot({ vmId }).deviceId)
    eq('真实 HTTP：user-agent 已归一化', sent.headers['user-agent'], OFFICIAL_CLAUDE_CLI_UA)
    ok('真实 HTTP：出站字节里没有 claude-desktop 痕迹', !text.includes('claude-desktop'), text.slice(0, 200))
    ok('真实 HTTP：billing 里的 cch 仍在', /cch=[0-9a-f]{5};/.test(wire.system[0].text), wire.system[0].text.slice(0, 120))
    eq(
      '真实 HTTP：metadata 里只剩非敏感键',
      Object.keys(wire.metadata).filter((key) => key !== 'user_id' && METADATA_DROP_KEY_RE.test(key)),
      [],
    )
    ok('真实 HTTP：x-app 仍是 cli', sent.headers['x-app'] === 'cli', sent.headers['x-app'])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

console.log(`\n通过 ${pass} / 失败 ${fails.length}`)
if (fails.length) process.exit(1)