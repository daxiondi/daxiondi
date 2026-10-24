// 契约自检：验证本实现与上游实现的行为逐条一致
// 运行：node test/selfcheck.mjs

import { finalizeZeroBilling, layoutSystemBlocks, IDENTITY } from '../src/system-layout.mjs'
import {
  mergeOfficialExtraBetas,
  resolveKinCacheTtl,
  keepSingleMessageCacheMarker,
  capCacheMarkers,
  classifyUpstreamError,
  assembleApiMetadata,
  officialCliUserAgent,
  officialStainlessHeaders,
} from '../src/identity.mjs'
import { parseStdinLine, slotId, jobStartFrame, cancelFrame, classifyStdoutFrame, PROTOCOL_VERSION, validateHostReady, mergeWireBody, formatMetadataUserId, outboundDeviceId, NATIVE_OWNED_FIELDS, CALLER_OPTIONAL_FIELDS } from '../src/frames.mjs'
import { mapStopReason, nativeStopReason, STOP_REASON_ENUM } from '../src/identity.mjs'
import { validateWorkerConfig, DEFAULT_WORKER_CONFIG, SYSTEM_LAYOUTS } from '../src/config.mjs'
import { withRequestProtocolBetas, claudeCodeMimicryBetas, normalizeModelId, joinBetas, BETA } from '../src/betas.mjs'
import { resolveUpstreamProtocol } from '../src/identity.mjs'
import { buildPersona, renderViews, auditPersona, PLATFORMS, platformDefaults } from '../src/persona/index.mjs'
import { deriveHex32, deriveUuid, deriveMac, deriveSerial, pickFrom } from '../src/persona/derive.mjs'
import { parseCredentialFile, normalizeEnvelope, buildOutboundHeaders, buildOutboundBody, responsesUrl, responsesWsUrl, parseUserAgent, chooseTransport, compressBody, decompressBody, AccountScheduler, STRIP_IDENTITY_KEYS, WS_BODY_LIMIT, HEADER_PASSTHROUGH_ALLOWLIST, normalizeServiceTier, mergePassthroughHeaders, parseRetryAfter, DEFAULT_COOLDOWN_SECS, RATE_LIMIT_COOLDOWN_SECS } from '../src/codex.mjs'

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log('  ok   ', name)
  } else {
    fail++
    console.log('  FAIL ', name, '\n         got ', g, '\n         want', w)
  }
}

// 1. billing header：cch 抹成 00000，cc_prompt_id 进程内固定
const b1 = finalizeZeroBilling('x-anthropic-billing-header: v=1; cch=abcdef;')
const b2 = finalizeZeroBilling('x-anthropic-billing-header: v=1; cch=zzzzzz;')
eq('billing cch 固定 00000', /cch=([^;]*);/.exec(b1)?.[1], '00000')
eq('billing 抹掉原 cch 值', b1.includes('abcdef'), false)
eq(
  'cc_prompt_id 跨调用不变',
  /cc_prompt_id=([0-9a-f-]+)/.exec(b1)?.[1],
  /cc_prompt_id=([0-9a-f-]+)/.exec(b2)?.[1],
)
eq('prompt_version 为上游身份', b1.includes(`prompt_version=<${IDENTITY}>`), true)
eq('billing 以分号收尾前有 cch', b1.includes('cch=00000;'), true)

// 2. zero 布局
const z = layoutSystemBlocks({ attribution: '', env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'zero', TZ: 'Asia/Shanghai' } })
eq('zero 布局块数', z.length, 2)
eq('zero 首块是 billing header', z[0].startsWith('x-anthropic-billing-header:'), true)
eq('zero 环境块格式', z[1], '# Environment\n - Timezone: Asia/Shanghai')

// 3. identity 布局
const idl = layoutSystemBlocks({ attribution: 'x-anthropic-billing-header: a;', env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'identity' } })
eq('identity 布局块数', idl.length, 3)
eq('identity 第二块为上游身份', idl[1], IDENTITY)

// 4. stock 布局不注入
const st = layoutSystemBlocks({ attribution: 'x-anthropic-billing-header: a;', env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'stock' } })
eq('stock 不写 billing', st.some((b) => b.startsWith('x-anthropic-billing-header')), false)
eq('stock 只写环境块', st.length, 1)

// 5. betas：上游顺序优先，自定义追加
const mb = mergeOfficialExtraBetas(['effort-2025-11-24', 'custom-beta'])
// 上游顺序优先：输入未含 claude-code-20250219，首个命中项应是列表里最先出现的
eq('betas 按上游清单顺序', mb[0], 'thinking-token-count-2026-05-13')
eq('betas 保留调用方自定义', mb.includes('custom-beta'), true)
eq('betas 无重复', new Set(mb).size, mb.length)
// 全量上游 betas 时首项必须是清单第一个
eq('betas 全量时首项', mergeOfficialExtraBetas(['claude-code-20250219'])[0], 'claude-code-20250219')

// 6. TTL 优先级
eq('TTL explicit 5m 胜出', resolveKinCacheTtl({ system: [{ cache_control: { ttl: '5m' } }], panelTtl: '1h' }), '5m')
eq('TTL panel 兜底', resolveKinCacheTtl({ panelTtl: '1h' }), '1h')
eq('TTL 最终默认 1h', resolveKinCacheTtl({}), '1h')

// 7. cache marker：只留最后一个 message 块
const msgs = [
  { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'b' }] },
  { role: 'user', content: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral' } }] },
]
keepSingleMessageCacheMarker(msgs)
eq('首个 message marker 被删', msgs[0].content[0].cache_control, undefined)
eq('末个 message marker 保留', msgs[1].content[0].cache_control.type, 'ephemeral')

// 8. thinking 块不挂 cache
const msgs2 = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', cache_control: { type: 'ephemeral' } }] }]
capCacheMarkers({ messages: msgs2 })
eq('thinking marker 被剥掉', msgs2[0].content[0].cache_control, undefined)

// 9. 错误映射
eq('rate_limit → 429', classifyUpstreamError({ body: { type: 'error', error: { type: 'rate_limit_error', message: 'x' } } }).status, 429)
eq('authentication → 401', classifyUpstreamError({ body: { error: { type: 'authentication_error' } } }).status, 401)
eq('permission → 403', classifyUpstreamError({ body: { error: { type: 'permission_error' } } }).status, 403)
eq('overloaded → 529 code', classifyUpstreamError({ body: { error: { type: 'overloaded_error' } } }).code, 'upstream_overloaded')
eq('未知类型 → 502', classifyUpstreamError({ body: { error: { type: 'weird' } } }).status, 502)
eq('retry-after 透传', classifyUpstreamError({ body: { error: { type: 'rate_limit_error' } }, headers: { 'retry-after': '7' } }).retry_after, '7')

// 10. metadata 降级
const big = assembleApiMetadata({ identity: { a: 'x'.repeat(600) } })
eq('user_id 是 JSON 串', typeof JSON.parse(big.user_id), 'object')
eq('超长时降级到 identity', JSON.parse(big.user_id).a.length, 600)

// 11. UA / stainless
eq(
  'UA 格式',
  officialCliUserAgent({ CLAUDE_CODE_VERSION: '2.1.296', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }),
  'claude-cli/2.1.296 (external, sdk-cli)',
)
eq('stainless runtime-version', officialStainlessHeaders()['x-stainless-runtime-version'], 'v26.3.0')
eq('stainless retry-count 固定 0', officialStainlessHeaders()['x-stainless-retry-count'], '0')
eq('stainless timeout 固定 600', officialStainlessHeaders()['x-stainless-timeout'], '600')

// 12. 帧协议
eq('协议版本 2', PROTOCOL_VERSION, 2)
eq('slotId 补零', slotId(3), 's03')
eq('接受 job_start', parseStdinLine('{"type":"job_start"}')?.type, 'job_start')
eq('接受 cancel', parseStdinLine('{"type":"cancel"}')?.type, 'cancel')
eq('接受 ping', parseStdinLine('{"type":"ping"}')?.type, 'ping')
eq('拒绝未知帧', parseStdinLine('{"type":"hello"}'), null)
eq('拒绝非法 JSON', parseStdinLine('not json'), null)
eq('拒空白行', parseStdinLine('   '), null)
eq('host_ready 解析', classifyStdoutFrame({ type: 'host_ready', slots: 20, protocol_version: 2 }).payload.slots, 20)
eq('job_start 帧结构', jobStartFrame({ slot: 's00', jobId: 'j1', request: { model: 'm' } }).slot_id, 's00')
eq('job_error 解析', classifyStdoutFrame({ type: 'job_error', status: 429, retry_after: '5' }).payload.retryAfter, '5')

// 13. stop_reason 映射（上游枚举到内部取值的固定对照）
eq('end_turn → 0', mapStopReason('end_turn'), 0)
eq('tool_use → 1', mapStopReason('tool_use'), 1)
eq('max_tokens → 2', mapStopReason('max_tokens'), 2)
eq('stop_sequence → 3', mapStopReason('stop_sequence'), 3)
eq('pause_turn → 4', mapStopReason('pause_turn'), 4)
eq('refusal → 5', mapStopReason('refusal'), 5)
eq('context_window → 6', mapStopReason('model_context_window_exceeded'), 6)
eq('未知 → 7', mapStopReason('whatever'), 7)
eq('native 超长一律 end_turn', nativeStopReason('model_context_window_exceeded'), 0)
eq('native stop_sequence → 3', nativeStopReason('stop_sequence'), 3)

// 14. cancel 帧第一字段是 job_id（上游协议约定，双重来源确认）
const cf = cancelFrame({ slot: 's00', jobId: 'j1' })
eq('cancel 用 job_id 字段', cf.job_id, 'j1')
eq('cancel 无 request 字段', 'request' in cf, false)
eq('cancel slot_id 可选', cancelFrame({ jobId: 'j1' }).slot_id, undefined)

// 15. host_ready 五校验
const goodHost = { protocolVersion: 'kernel/0.1.0', slots: 20, systemLayout: 'identity', timezone: 'UTC', capabilities: ['multi_slot'], configHash: 'h' }
const expect = { protocolVersion: 'kernel/0.1.0', slots: 20, systemLayout: 'identity', timezone: 'UTC', configHash: 'h', requiredCapabilities: ['multi_slot'] }
eq('五校验全过', validateHostReady(goodHost, expect).ok, true)
eq('缺 capability 被拒', validateHostReady(goodHost, { ...expect, requiredCapabilities: ['native_sse'] }).ok, false)
eq('slot 数不符被拒', validateHostReady(goodHost, { ...expect, slots: 4 }).ok, false)
eq('config_hash 不符被拒', validateHostReady(goodHost, { ...expect, configHash: 'other' }).ok, false)

// 16. 身份生成的确定性（同一 vm_id 必须逐字节可复现）
{
  const a = buildPersona({ platform: 'linux', vmId: 'vm-13' })
  const b = buildPersona({ platform: 'linux', vmId: 'vm-13' })
  eq('同 vm_id 逐字节确定', JSON.stringify(a), JSON.stringify(b))

  const other = buildPersona({ platform: 'linux', vmId: 'vm-14' })
  eq('不同 vm_id 得不同身份', a.machine_id !== other.machine_id, true)
  eq('machine_id 是 32 位 hex', /^[0-9a-f]{32}$/.test(a.machine_id), true)
}

// 17. 配置缺省值（上游 WorkerConfig 加载逻辑的缺省值）
eq('provider 缺省 anthropic_api', DEFAULT_WORKER_CONFIG.provider, 'anthropic_api')
eq('socket 缺省路径', DEFAULT_WORKER_CONFIG.socket_path, '/run/guest/worker.sock')
eq('credential 缺省路径', DEFAULT_WORKER_CONFIG.credential_path, '/home/guest/.claude/credentials.json')
eq('oauth url 缺省', DEFAULT_WORKER_CONFIG.oauth_token_url, 'https://platform.claude.com/v1/oauth/token')
eq('anthropic_base_url 缺省', DEFAULT_WORKER_CONFIG.anthropic_base_url, 'https://api.anthropic.com')
eq('delivery_mode 缺省', DEFAULT_WORKER_CONFIG.delivery_mode, 'realtime')
eq('default_cache_ttl 缺省', DEFAULT_WORKER_CONFIG.default_cache_ttl, '1h')
eq('SystemMode 只有两个值', [...SYSTEM_LAYOUTS], ['zero', 'identity'])

const baseCfg = { vm_id: 'v', internal_token: 't', socket_path: '/s' }
eq('缺省 provider 通过校验', validateWorkerConfig(baseCfg).provider, 'anthropic_api')
let threw = ''
try { validateWorkerConfig({ ...baseCfg, provider: 'bogus' }) } catch (e) { threw = e.message }
eq('非法 provider 报错', threw, 'provider must be anthropic_api or local_cli, got "bogus"')

// 18. 线上实例样本校正（2026-10-23）
{
  const { messageStream } = await import('../src/sse.mjs')
  const frames = [...messageStream({ id: 'r', model: 'm', text: 'hi', inputTokens: 1, outputTokens: 2, slot: 's00', sessionId: 'x', generation: 1 })]
  const names = frames.map((f) => f.split('\n')[0].replace('event: ', ''))
  eq('客户端可见流不含 kin.done', names.includes('kin.done'), false)
  eq('末帧是 message_stop', names[names.length - 1], 'message_stop')
  const withDone = [...messageStream({ id: 'r', model: 'm', text: 'hi', inputTokens: 1, outputTokens: 2, slot: 's00', sessionId: 'x', generation: 1, emitKinDone: true })]
  eq('显式要求时才有 kin.done', withDone.some((f) => f.includes('kin.done')), true)
  // 事件序列固定
  eq('事件顺序与上游一致', names.join(','), 'message_start,content_block_start,content_block_delta,content_block_stop,message_delta,message_stop')
}

// 19. wireBody 合并算法（对齐上游 assembleMessageRequest 行为）
{
  const r = mergeWireBody({ model: 'claude-sonnet-5-5', messages: [], stream: true },
                           { model: 'EVIL', stream: false, custom_key: 'x' })
  eq('wire 不能覆盖 model', r.model, 'claude-sonnet-5-5')
  eq('wire 不能覆盖 stream', r.stream, true)
  eq('非原生键透传', r.custom_key, 'x')

  const r2 = mergeWireBody({ temperature: 1, top_p: 0.9 }, {})
  eq('temperature 没给就删', 'temperature' in r2, false)
  eq('top_p 没给就删', 'top_p' in r2, false)

  const r3 = mergeWireBody({ tools: [{ name: 'x' }] }, { tools: null })
  eq('tools=null 不覆盖', r3.tools[0].name, 'x')

  eq('原生字段 19 个', NATIVE_OWNED_FIELDS.length, 19)
  eq('可选字段 10 个', CALLER_OPTIONAL_FIELDS.length, 10)
}

// 20. metadata.user_id 硬约束（原样透传，不过滤）
eq('64hex device_id 原样', outboundDeviceId('a'.repeat(64)), 'a'.repeat(64))
eq('非 hex 走 sha256', outboundDeviceId('abc').length, 64)
{
  let threw = false
  try { formatMetadataUserId({ sessionId: 'a@b.com' }) } catch { threw = true }
  eq('邮箱被拒（上游 400 has_at）', threw, true)
}
{
  const uid = JSON.parse(formatMetadataUserId({ deviceId: 'a'.repeat(64), accountUuid: 'u1', sessionId: 's1' }))
  eq('user_id 含 device_id', uid.device_id, 'a'.repeat(64))
  eq('user_id 含 account_uuid', uid.account_uuid, 'u1')
  eq('user_id 含 session_id', uid.session_id, 's1')
}

// 21. Beta 动态注入（上游 withRequestProtocolBetas 全 25 条规则）
{
  const base = claudeCodeMimicryBetas()
  eq('模仿基线 7 个', base.length, 7)
  eq('基线首位是 claude-code', base[0], BETA.CLAUDE_CODE)

  const sonnet = withRequestProtocolBetas(base, { model: 'claude-sonnet-5-5', messages: [] })
  eq('sonnet 加 per-turn', sonnet.includes(BETA.PER_TURN_CONTROL), true)
  eq('sonnet 加 mid-tool-changes', sonnet.includes(BETA.MID_CONVERSATION_TOOL_CHANGES), true)

  eq('opus fast 模式', withRequestProtocolBetas(base, { model: 'claude-opus-4-8', speed: 'fast', messages: [] }).includes(BETA.FAST_MODE), true)
  eq('thinking updates', withRequestProtocolBetas(base, { model: 'x', thinking: { display: 'updates' }, messages: [] }).includes(BETA.THINKING_DISPLAY_UPDATES), true)
  eq('1h 缓存', withRequestProtocolBetas(base, { model: 'x', messages: [{ content: [{ cache_control: { ttl: '1h' } }] }] }).includes(BETA.EXTENDED_CACHE_TTL), true)
  eq('tool strict', withRequestProtocolBetas(base, { model: 'x', tools: [{ strict: true }], messages: [] }).includes(BETA.STRUCTURED_OUTPUTS), true)
  eq('中途 system', withRequestProtocolBetas([], { model: 'x', messages: [{ role: 'system', content: 's' }] }).includes(BETA.MID_CONVERSATION_SYSTEM), true)
  eq('fallbacks=default', withRequestProtocolBetas([], { model: 'x', fallbacks: 'default' }).includes(BETA.SERVER_SIDE_FALLBACK_DEFAULT), true)
  eq('fallbacks 数组', withRequestProtocolBetas([], { model: 'x', fallbacks: ['a'] }).includes(BETA.SERVER_SIDE_FALLBACK_LIST), true)
  eq('context_management', withRequestProtocolBetas([], { model: 'x', context_management: {} }).includes(BETA.CONTEXT_MANAGEMENT), true)
  eq('safeguards dangerous', withRequestProtocolBetas([], { model: 'x', safeguards: [{ type: 'dangerous_tool_use' }] }).includes(BETA.DANGEROUS_TOOL_USE), true)

  eq('模型名归一化', normalizeModelId('anthropic/claude-opus-5-5[1m]-20260101'), 'claude-opus-5-5')
  const dup = withRequestProtocolBetas([BETA.EFFORT], { model: 'x', output_config: { effort: 'high' } })
  eq('beta 不重复', dup.filter((x) => x === BETA.EFFORT).length, 1)
  eq('joinBetas 逗号分隔', joinBetas(['a', 'b']), 'a,b')
}

// 22. HTTP/2 指纹（对齐上游 officialH2Fetch 行为）
eq('无代理走 h2', resolveUpstreamProtocol({}), 'h2')
eq('HTTPS_PROXY 走 h1', resolveUpstreamProtocol({ HTTPS_PROXY: 'x' }), 'h1')
eq('https_proxy 小写也认', resolveUpstreamProtocol({ https_proxy: 'x' }), 'h1')
eq('HTTP_PROXY 走 h1', resolveUpstreamProtocol({ HTTP_PROXY: 'x' }), 'h1')
eq('unix socket 走 h1', resolveUpstreamProtocol({ ANTHROPIC_UNIX_SOCKET: 'x' }), 'h1')

// 23. Codex 通道凭据（8 字段只有 id 必填，但类型严格）
{
  const c = parseCredentialFile('{"accounts":[{"id":"x"}]}')
  eq('最小凭据只需 id', c.accounts.length, 1)
  let e = ''
  try { parseCredentialFile('[{"id":"x"}]') } catch (err) { e = err.message }
  eq('裸数组被拒（会被静默解析成 0）', e.includes('bare array'), true)
  e = ''
  try { parseCredentialFile('{"accounts":[{}]}') } catch (err) { e = err.message }
  eq('缺 id 被拒', e.includes('id'), true)
  e = ''
  try { parseCredentialFile('{"accounts":[{"id":"x","rpm":"60"}]}') } catch (err) { e = err.message }
  eq('rpm 字符串被拒', e.includes('u32'), true)
  e = ''
  try { parseCredentialFile('{"accounts":[{"id":"x","rpm":-1}]}') } catch (err) { e = err.message }
  eq('rpm 负数被拒', e.includes('u32'), true)
  e = ''
  try { parseCredentialFile('{"accounts":[{"id":"x","expires_at":"999"}]}') } catch (err) { e = err.message }
  eq('expires_at 字符串被拒', e.includes('i64'), true)
  eq('8 个字段全都可缺（除 id）',
     parseCredentialFile('{"accounts":[{"id":"x","access_token":"t"}]}').accounts[0].access_token, 't')
}

// 24. Envelope：body 键必需，顶层泄漏必须拒绝（否则会静默转发 {}）
{
  const env = normalizeEnvelope({ body: { model: 'gpt-6-astra' } })
  eq('stream 缺省 true', env.stream, true)
  eq('stream=false 生效', normalizeEnvelope({ body: {}, stream: false }).stream, false)
  let e = ''
  try { normalizeEnvelope({ stream: true, model: 'gpt-6-astra', input: [] }) } catch (err) { e = err.message }
  eq('顶层泄漏被拒', e.includes('silently dropped'), true)
  eq('顶层字段名带进报错', e.includes('model'), true)
  e = ''
  try { normalizeEnvelope({ body: {}, options: { installation_id: 'not-uuid' } }) } catch (err) { e = err.message }
  eq('installation_id 非 UUID 被拒', e.includes('UUID'), true)
}

// 25. Codex 上游 URL 与 UA
eq('responsesUrl 去尾斜杠', responsesUrl('https://chatgpt.com/backend-api/codex/'),
   'https://chatgpt.com/backend-api/codex/responses')
eq('wsUrl https→wss', responsesWsUrl('https://chatgpt.com/backend-api/codex'),
   'wss://chatgpt.com/backend-api/codex/responses')
eq('wsUrl http→ws', responsesWsUrl('http://127.0.0.1:8899/backend-api/codex'),
   'ws://127.0.0.1:8899/backend-api/codex/responses')
{
  const ua = parseUserAgent('codex_cli_rs/0.160.0 (linux x86_64)')
  eq('UA 切出 originator', ua.originator, 'codex_cli_rs')
  eq('UA 切出 version', ua.version, '0.160.0')
  eq('无空格 UA 也能切', parseUserAgent('UA_OVERRIDE/9').version, '9')
}

// 26. Codex 出站头（14 个逐条校验）
{
  const h = buildOutboundHeaders({
    account: { access_token: 'T', chatgpt_account_id: 'A' },
    body: { model: 'gpt-6-astra' }, sessionId: 's1',
  })
  eq('authorization Bearer', h.authorization, 'Bearer T')
  eq('chatgpt-account-id', h['chatgpt-account-id'], 'A')
  eq('content-encoding zstd', h['content-encoding'], 'zstd')
  eq('accept SSE', h.accept, 'text/event-stream')
  eq('originator', h.originator, 'codex_cli_rs')
  eq('version', h.version, '0.160.0')
  eq('routing-hint 无 tier', h['x-codex-routing-hint'], 'model=gpt-6-astra')
  // service_tier=fast 会被归一化成 priority，body 与 header 必须用同一份结果
  eq('routing-hint 带 tier（fast→priority）',
     buildOutboundHeaders({ account: {}, body: { model: 'm', service_tier: 'fast' } })['x-codex-routing-hint'],
     'model=m;tier=priority')
  eq('routing-hint 未知档位原样透传',
     buildOutboundHeaders({ account: {}, body: { model: 'm', service_tier: 'flex' } })['x-codex-routing-hint'],
     'model=m;tier=flex')
  eq('turn-id 是 UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(h['x-codex-turn-id']), true)
  eq('prefer_websocket 才有 openai-beta', 'openai-beta' in h, false)
  eq('prefer_websocket 加 beta',
     buildOutboundHeaders({ account: {}, body: {}, preferWebsocket: true })['openai-beta'],
     'responses_websockets=2026-02-06')
}

// 27. Codex body 改写
{
  const b = buildOutboundBody({
    body: { model: 'm', store: true, temperature: 0.5, api_key: 'X', max_tokens: 9 },
    session: { session_id: 's1' }, installationId: 'I',
  })
  eq('store 强制 false', b.store, false)
  eq('删 temperature', 'temperature' in b, false)
  eq('删 max_tokens', 'max_tokens' in b, false)
  eq('删 api_key', 'api_key' in b, false)
  // client_metadata 由独立开关控制，与 session_id 是否存在无关
  eq('未开 client_features 不注入', 'client_metadata' in b, false)
  const bc = buildOutboundBody({
    body: { model: 'm' }, session: { session_id: 's1' },
    installationId: 'I', clientFeatures: true,
  })
  eq('开启后注入 client_metadata', Object.keys(bc.client_metadata).sort().join(','),
     'session_id,turn_id,x-codex-installation-id')
  eq('strip 键数量', STRIP_IDENTITY_KEYS.length, 12)
  eq('透传白名单 30 个', HEADER_PASSTHROUGH_ALLOWLIST.length, 30)
  eq('service_tier 归一化 fast', normalizeServiceTier('fast'), 'priority')
  eq('service_tier 归一化 flex', normalizeServiceTier('flex'), 'flex')
  eq('service_tier 归一化未传', normalizeServiceTier(undefined), null)
}

// 28. 传输选择与 zstd
eq('15MB 上限常量', WS_BODY_LIMIT, 0xf00000)
eq('超上限强制 http', chooseTransport({ requested: 'prefer_websocket', bodyBytes: WS_BODY_LIMIT + 1 }), 'http')
eq('未超可 WS', chooseTransport({ requested: 'prefer_websocket', bodyBytes: 1000 }), 'prefer_websocket')
eq('未请求则 http', chooseTransport({ requested: 'http', bodyBytes: 100 }), 'http')
eq('zstd 往返', decompressBody(compressBody({ a: 1 })).toString(), '{"a":1}')

// 29. 账号调度：会话亲和无 TTL、首可用、失败不解绑
{
  let t = 1_000_000
  const sch = new AccountScheduler(
    [{ id: 'a1', max_concurrency: 1 }, { id: 'a2', max_concurrency: 1 }],
    { now: () => t },
  )

  const r1 = sch.select({ sessionId: 's1' })
  eq('首次走扫描', r1.via, 'scan')
  eq('选到第一个可用', r1.account.id, 'a1')
  sch.release(r1.account.id)
  sch.commitSuccess({ sessionId: 's1', accountId: r1.account.id })

  // 关键：亲和没有过期时间
  t += 30 * 24 * 3600 * 1000
  const r2 = sch.select({ sessionId: 's1' })
  eq('30 天后仍亲和（无 TTL）', r2.via, 'session')
  eq('仍是同一账号', r2.account.id, 'a1')

  // 亲和账号满并发时回落扫描
  const r3 = sch.select({ sessionId: 's1' })
  eq('a1 满时回落扫描', r3.via, 'scan')
  eq('回落到 a2', r3.account.id, 'a2')
  eq('回落不污染亲和', sch.sessionAffinity.get('s1'), 'a1')

  sch.release(r3.account.id)
  sch.release(r2.account.id)
  t += 1000
  const r4 = sch.select({ sessionId: 's1' })
  eq('释放后回到亲和', r4.via, 'session')
  eq('回到 a1', r4.account.id, 'a1')
  sch.release(r4.account.id)

  // 线程亲和
  const sch2 = new AccountScheduler([{ id: 'b1' }, { id: 'b2' }], { now: () => t })
  const t1 = sch2.select({ threadId: 'th1' })
  sch2.release(t1.account.id)
  const t2 = sch2.select({ threadId: 'th1' })
  eq('线程亲和生效', t2.via, 'thread')
  eq('线程亲和同账号', t2.account.id, t1.account.id)
  sch2.release(t2.account.id)

  // 全部不可用时报错
  const sch3 = new AccountScheduler([{ id: 'c1', max_concurrency: 1 }], { now: () => t })
  sch3.select({})
  let err = null
  try { sch3.select({}) } catch (e) { err = e }
  eq('无可用账号抛错', err?.code, 'all_rejected')
}

// 30. 冷却：优先用上游 Retry-After
{
  eq('默认冷却 30 秒', DEFAULT_COOLDOWN_SECS, 30)
  eq('429 默认 60 秒', RATE_LIMIT_COOLDOWN_SECS, 60)

  eq('解析 retry-after', parseRetryAfter({ 'retry-after': '45' }), 45)
  eq('前缀优先于 retry-after',
     parseRetryAfter({ 'retry-after': '45', 'x-codex-secondary-reset-after-seconds': '120' }), 120)
  eq('primary 次之',
     parseRetryAfter({ 'retry-after': '45', 'x-codex-primary-reset-after-seconds': '90' }), 90)
  eq('头名大小写无关', parseRetryAfter({ 'Retry-After': '30' }), 30)
  eq('带正号拒绝', parseRetryAfter({ 'retry-after': '+30' }), null)
  eq('负数拒绝', parseRetryAfter({ 'retry-after': '-5' }), null)
  eq('非数字拒绝', parseRetryAfter({ 'retry-after': 'abc' }), null)
  eq('空值拒绝', parseRetryAfter({ 'retry-after': '' }), null)

  let t = 1_000_000
  const sch = new AccountScheduler([{ id: 'x' }], { now: () => t })
  eq('普通错误冷却 30s', sch.markCooldown('x', { status: 500 }), 30)
  eq('429 冷却 60s', sch.markCooldown('x', { status: 429 }), 60)
  eq('有上游值时用上游值', sch.markCooldown('x', { status: 429, retryAfter: 120 }), 120)
  eq('上游给 0 也抬到 1', sch.markCooldown('x', { status: 200, retryAfter: 0 }), 30)

  // 冷却期内不可选
  const sch2 = new AccountScheduler([{ id: 'y' }], { now: () => t })
  sch2.markCooldown('y', { retryAfter: 60 })
  let err = null
  try { sch2.select({}) } catch (e) { err = e }
  eq('冷却期内不可选', err?.code, 'all_rejected')
  t += 61_000
  eq('冷却结束可选', sch2.select({}).account.id, 'y')
}

// 31. 三平台 persona 全部自洽
{
  eq('支持三个平台', PLATFORMS.length, 3)
  eq('平台清单', PLATFORMS.join(','), 'macos,windows,linux')

  const shapes = {}
  for (const plat of PLATFORMS) {
    const p = buildPersona({ platform: plat, vmId: `vm-${plat}` })
    const v = renderViews(p)
    const audit = auditPersona(p)
    shapes[plat] = { cmds: Object.keys(v.commands).length, files: Object.keys(v.files).length }
    eq(`${plat} 审计无问题`, audit.length, 0)
    eq(`${plat} 有命令视图`, Object.keys(v.commands).length > 0, true)
    eq(`${plat} 有文件视图`, Object.keys(v.files).length > 0, true)
    eq(`${plat} vm_id 写入`, p.vm_id, `vm-${plat}`)
  }

  // 每个平台的默认骨架都能过校验
  for (const plat of PLATFORMS) {
    const d = platformDefaults(plat)
    eq(`${plat} 默认骨架有 platform`, d.platform, plat)
  }
}

// 32. macOS：两类历史异常特征必须被拦住
{
  // 异常特征 1：主机名在三处视图漂移
  let err = null
  try {
    buildPersona({ platform: 'macos', vmId: 'v', overrides: { naming: { local_hostname: 'WRONG' } } })
  } catch (e) { err = e }
  eq('拦住 uname/scutil 主机名漂移', err?.message.includes('uname_hostname_mismatch'), true)

  // 异常特征 2：smc_version 留空
  err = null
  try {
    buildPersona({ platform: 'macos', vmId: 'v', overrides: { hardware: { smc_version: '' } } })
  } catch (e) { err = e }
  eq('拦住 smc_version 为空', err?.message.includes('smc_version_empty'), true)

  // 正常构造下三处主机名必须一致
  const p = buildPersona({ platform: 'macos', vmId: 'v' })
  const v = renderViews(p)
  eq('uname -n 与 persona 一致', v.commands['uname -n'], p.naming.hostname)
  eq('scutil 与 persona 一致', v.commands['scutil --get HostName'], p.naming.hostname)
  eq('/etc/hostname 与 persona 一致', v.files['etc/hostname'].trim(), p.naming.hostname)
  eq('smc_version 非空', Boolean(p.hardware.smc_version), true)
}

// 33. Windows / Linux 各自的硬约束
{
  let err = null
  try {
    buildPersona({ platform: 'windows', vmId: 'v', overrides: { naming: { computer_name: 'A'.repeat(16) } } })
  } catch (e) { err = e }
  eq('拦住 NetBIOS 名超 15 字符', err?.message.includes('netbios_name_too_long'), true)

  err = null
  try {
    buildPersona({ platform: 'linux', vmId: 'v', overrides: { machine_id: 'SHORT' } })
  } catch (e) { err = e }
  eq('拦住 machine-id 格式错', err?.message.includes('machine_id_format'), true)

  // Linux 两个 machine-id 文件必须相同
  const lp = buildPersona({ platform: 'linux', vmId: 'v' })
  const lv = renderViews(lp)
  eq('/etc/machine-id 与 dbus 一致',
     lv.files['etc/machine-id'].trim(), lv.files['var/lib/dbus/machine-id'].trim())
}

// 34. 硬件标识派生：同 vm 稳定、异 vm 互不关联
{
  eq('hex32 确定性', deriveHex32('vm-1'), deriveHex32('vm-1'))
  eq('hex32 32 位', deriveHex32('vm-1').length, 32)
  eq('不同 vm 不同 hex32', deriveHex32('vm-1') !== deriveHex32('vm-2'), true)

  const u = deriveUuid('vm-1')
  eq('uuid 形态', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(u), true)
  eq('不同 vm 不同 uuid', deriveUuid('vm-1') !== deriveUuid('vm-2'), true)

  const m = deriveMac('vm-1', 'F0:18:98')
  eq('MAC 用指定 OUI', m.startsWith('F0:18:98'), true)
  eq('MAC 是单播', (parseInt(m.slice(0, 2), 16) & 0x01), 0)
  eq('MAC 非本地管理', (parseInt(m.slice(0, 2), 16) & 0x02), 0)
  eq('不同 vm 不同 MAC', deriveMac('vm-1') !== deriveMac('vm-2'), true)

  eq('序列号长度可控', deriveSerial('vm-1', 12, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789').length, 12)
  eq('序列号只含给定字符', /^[ABCDEFGHJKLMNPQRSTUVWXYZ0123456789]+$/.test(
     deriveSerial('vm-1', 20, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789')), true)

  eq('pickFrom 确定性', pickFrom('vm-1', ['a', 'b', 'c']), pickFrom('vm-1', ['a', 'b', 'c']))
  let threw = false
  try { pickFrom('vm-1', []) } catch { threw = true }
  eq('pickFrom 空列表报错', threw, true)
}

// 35. 全平台：不同 vm_id 必须得到不同硬件标识
{
  for (const plat of PLATFORMS) {
    const a = buildPersona({ platform: plat, vmId: 'vm-a' })
    const b = buildPersona({ platform: plat, vmId: 'vm-b' })
    const c = buildPersona({ platform: plat, vmId: 'vm-a' })
    eq(`${plat} 同 vm 可复现`, JSON.stringify(a), JSON.stringify(c))
    eq(`${plat} 异 vm 身份不同`, JSON.stringify(a) !== JSON.stringify(b), true)
    eq(`${plat} MAC 不同`, a.network.mac !== b.network.mac, true)
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail ? 1 : 0)
