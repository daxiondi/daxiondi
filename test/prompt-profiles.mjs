// 提示词档位契约：按模型选档、两种结构、断点与 billing。
// 运行：node test/prompt-profiles.mjs

import {
  BILLING_ENTRYPOINT,
  IDENTITY,
  buildBillingAttribution,
  layoutSystemBlocks,
  normalizeBillingVersion,
} from '../src/system-layout.mjs'
import { sealClaudeCodeCch } from '../src/cch.mjs'
import {
  CLI_HOP_MODELS,
  DEFAULT_PROMPT_PROFILE,
  OFFICIAL_303_ENV_INTRO,
  OFFICIAL_303_ENV_UNTRUSTED,
  OFFICIAL_303_MAIN_PROMPT,
  OFFICIAL_CLI_IDENTITY,
  OFFICIAL_TOTAL_TOKENS,
  PROFILES,
  PROMPT_PROFILES,
  PROFILE_OFFICIAL_303,
  PROFILE_OFFICIAL_FULL,
  STRUCTURE_CLI_HOP,
  STRUCTURE_SYSTEM_REMINDER,
  SYSTEM_REMINDER_MODELS,
  appendEnvironmentMessage,
  assembleRequest,
  assembleSystemBlocks,
  billingEntrypoint,
  billingHeader,
  callerSystemRemainder,
  canonicalModelId,
  cliVersionForProfile,
  environmentSectionSpan,
  expectedMarkerCount,
  foldCallerSystemIntoFirstUser,
  isBillingText,
  isOfficialIdentityText,
  looksLikeOfficialCaller,
  markUserCacheBreakpoints,
  modelLine,
  modelSupportsSystemTurns,
  normalizePromptProfile,
  outboundUserAgent,
  parseEnvironmentFacts,
  profileDefinition,
  profileForModel,
  projectSlug,
  renderEnvironmentSection,
  renderMainPrompt303,
  replaceEnvironmentSection,
  resolvePromptProfile,
  stabilizeTotalTokens,
  structureFor,
  summarizeMarkers,
  systemTexts,
  usesSystemReminderLayout,
} from '../src/prompt-profiles.mjs'

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
const ok = (name, cond) => eq(name, Boolean(cond), true)

// ─────────────────── 1. 档位注册表
console.log('\n档位注册表')

eq('档位枚举含两档', PROMPT_PROFILES, ['official_full', 'official_303'])
eq('缺省档是 official_full', DEFAULT_PROMPT_PROFILE, PROFILE_OFFICIAL_FULL)
eq('注册表键集合', Object.keys(PROFILES).sort(), ['official_303', 'official_full'])
eq('full 档版本 2.1.296', PROFILES.official_full.cliVersion, '2.1.296')
eq('303 档版本 2.1.303', PROFILES.official_303.cliVersion, '2.1.303')
eq('两档入口点都是 sdk-cli', [PROFILES.official_full.entrypoint, PROFILES.official_303.entrypoint], ['sdk-cli', 'sdk-cli'])
eq('两档断点上限都是 4', [PROFILES.official_full.maxMarkers, PROFILES.official_303.maxMarkers], [4, 4])
eq('full 档结构是 cli_hop', PROFILES.official_full.structure, STRUCTURE_CLI_HOP)
eq('303 档结构是 system_reminder', PROFILES.official_303.structure, STRUCTURE_SYSTEM_REMINDER)
eq('303 档 system 段顺序', PROFILES.official_303.systemSlots, ['billing', 'identity', 'main'])
eq('303 档调用方 system 落位', PROFILES.official_303.messagePolicy.caller, 'first_user_reminder')
eq('303 档 Environment 落位', PROFILES.official_303.messagePolicy.environment, 'tail_system_message')
eq('full 档调用方 system 留在 system', PROFILES.official_full.messagePolicy.caller, 'system')

eq('别名 303 归一', normalizePromptProfile('303'), PROFILE_OFFICIAL_303)
eq('别名 official-303 归一', normalizePromptProfile('official-303'), PROFILE_OFFICIAL_303)
eq('别名 full 归一', normalizePromptProfile('full'), PROFILE_OFFICIAL_FULL)
eq('未知档位返回 null', normalizePromptProfile('nope'), null)
eq('未知档位 definition 抛错', (() => {
  try {
    profileDefinition('nope')
    return 'no-throw'
  } catch (e) {
    return e.message
  }
})(), 'unknown prompt profile: nope')

// ─────────────────── 2. 模型分档
console.log('\n模型分档')

const LEAN = [
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-mythos-5',
  'claude-mythos-5-1',
]
const FULL = [
  'claude-sonnet-4-5',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5',
  'claude-haiku-5',
  'claude-haiku-5-5',
  'claude-3-7-sonnet',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
]

for (const model of LEAN) {
  eq(`${model} 用结构 A`, usesSystemReminderLayout(model), true)
  eq(`${model} 缺省档 303`, profileForModel(model), PROFILE_OFFICIAL_303)
}
for (const model of FULL) {
  eq(`${model} 用结构 B`, usesSystemReminderLayout(model), false)
  eq(`${model} 缺省档 full`, profileForModel(model), PROFILE_OFFICIAL_FULL)
}
eq('结构 A 名单覆盖 7 个模型', SYSTEM_REMINDER_MODELS.length, 7)
eq('结构 B 名单覆盖 13 个模型', CLI_HOP_MODELS.length, 13)
eq('模型名归一：去代理前缀', canonicalModelId('test-pro/claude-opus-5-5'), 'claude-opus-5-5')
eq('模型名归一：去 [1m]', canonicalModelId('claude-opus-5-5[1m]'), 'claude-opus-5-5')
eq('模型名归一：去日期后缀', canonicalModelId('claude-opus-5-5-20260601'), 'claude-opus-5-5')
eq('模型名归一：opus-4 补齐', canonicalModelId('claude-opus-4'), 'claude-opus-4-0')
eq('归一后仍判结构 A', usesSystemReminderLayout('test-pro/claude-opus-5-5[1m]'), true)
eq('空模型不判结构 A', usesSystemReminderLayout(''), false)

eq('303 档 + lean 模型 → 结构 A', structureFor({ profile: PROFILE_OFFICIAL_303, model: 'claude-opus-5-5' }), STRUCTURE_SYSTEM_REMINDER)
eq('303 档 + Sonnet → 结构 B', structureFor({ profile: PROFILE_OFFICIAL_303, model: 'claude-sonnet-5-5' }), STRUCTURE_CLI_HOP)
eq('303 档 + Opus 4.7 → 结构 B', structureFor({ profile: PROFILE_OFFICIAL_303, model: 'claude-opus-4-7' }), STRUCTURE_CLI_HOP)
eq('full 档 + lean 模型 → 结构 B', structureFor({ profile: PROFILE_OFFICIAL_FULL, model: 'claude-opus-5-5' }), STRUCTURE_CLI_HOP)

eq('显式配置优先于模型', resolvePromptProfile({ model: 'claude-sonnet-5-5', configured: 'official_303' }), PROFILE_OFFICIAL_303)
eq('未配置时按模型', resolvePromptProfile({ model: 'claude-opus-5-5' }), PROFILE_OFFICIAL_303)

eq('中途 role=system：Opus 5.5 支持', modelSupportsSystemTurns('claude-opus-5-5'), true)
eq('中途 role=system：Opus 4.8 支持', modelSupportsSystemTurns('claude-opus-4-8'), true)
eq('中途 role=system：Fable 5.1 支持', modelSupportsSystemTurns('claude-fable-5-1'), true)
eq('中途 role=system：Sonnet 5 不支持', modelSupportsSystemTurns('claude-sonnet-5'), false)
eq('中途 role=system：Haiku 4.5 不支持', modelSupportsSystemTurns('claude-haiku-4-5'), false)

// ─────────────────── 3. 版本与 UA / billing
console.log('\n版本、UA 与 billing')

eq('full 档 UA', outboundUserAgent(PROFILE_OFFICIAL_FULL), 'claude-cli/2.1.296 (external, sdk-cli)')
eq('303 档 UA', outboundUserAgent(PROFILE_OFFICIAL_303), 'claude-cli/2.1.303 (external, sdk-cli)')
// UA 后缀必须是 sdk-cli —— 与 billing 的 cc_entrypoint 一致。
  // 之前这里断言 false（要求不含 sdk-cli），是照 1.3.222 的错误方向写的。
  eq('UA 后缀是 sdk-cli', outboundUserAgent(PROFILE_OFFICIAL_303).includes('sdk-cli'), true)
eq('入口点常量', BILLING_ENTRYPOINT, 'sdk-cli')
eq('full 档入口点', billingEntrypoint(PROFILE_OFFICIAL_FULL), 'sdk-cli')
eq('303 档入口点', billingEntrypoint(PROFILE_OFFICIAL_303), 'sdk-cli')
eq('版本归一：三段号', normalizeBillingVersion('2.1.303'), '2.1.303')
eq('版本归一：带前缀', normalizeBillingVersion('cli/2.1.303'), '2.1.303')
eq('版本归一：非法值回落', normalizeBillingVersion('nope', '2.1.296'), '2.1.296')

const billing303 = billingHeader({ profile: PROFILE_OFFICIAL_303, firstUserText: 'hello' })
const billingFull = billingHeader({ profile: PROFILE_OFFICIAL_FULL, firstUserText: 'hello' })
ok('303 billing 以标准前缀开头', billing303.startsWith('x-anthropic-billing-header: '))
ok('303 billing cc_version 是 2.1.303', /cc_version=2\.1\.303\.[0-9a-f]{3};/.test(billing303))
ok('303 billing cc_entrypoint=sdk-cli', billing303.includes('cc_entrypoint=sdk-cli;'))
ok('303 billing 含 sdk-cli（三处统一）', billing303.includes('sdk-cli') === true)
ok('303 billing cch 是占位符', billing303.includes('cch=00000;'))
// 官方 billing 头里**没有** prompt_version 字段。
  // 我们原来多写了它 —— 多出的字段本身就是识别特征。
  ok('303 billing 不含 prompt_version', billing303.includes('prompt_version') === false)
ok('full billing cc_version 是 2.1.296', /cc_version=2\.1\.296\.[0-9a-f]{3};/.test(billingFull))
ok('full billing 不含 prompt_version', billingFull.includes('prompt_version') === false)
eq('billing 跨调用稳定', billingHeader({ profile: PROFILE_OFFICIAL_303, firstUserText: 'hello' }), billing303)
eq(
  'billing 同会话复用 cc_prompt_id',
  /cc_prompt_id=([0-9a-f-]+)/.exec(
    buildBillingAttribution({ cliVersion: '2.1.303', firstUserText: 'a', sessionId: '11111111-2222-4333-8444-555555555555' }),
  )?.[1],
  '11111111-2222-4333-8444-555555555555',
)
eq(
  'billing 字段顺序固定',
  billing303.replace(/=([^;]+)/g, '=X').split(';').map((s) => s.trim()).filter(Boolean),
  [
    'x-anthropic-billing-header: cc_version=X',
    'cc_entrypoint=X',
    'cch=X',
    'cc_prompt_id=X',
  ],
)

// ─────────────────── 4. 身份句判别与调用方 system 拆分
console.log('\n调用方 system 拆分')

eq('身份句识别：CLI 句', isOfficialIdentityText(OFFICIAL_CLI_IDENTITY), true)
eq('身份句识别：Agent SDK 句', isOfficialIdentityText(IDENTITY), true)
eq('身份句识别：普通文本', isOfficialIdentityText('You are a helpful bot.'), false)
eq('billing 识别', isBillingText('x-anthropic-billing-header: a;'), true)
eq('billing 识别：普通文本', isBillingText('hello'), false)

eq(
  'system 文本展开：块数组',
  systemTexts([{ type: 'text', text: 'a' }, 'b', { type: 'text', text: '  ' }]),
  ['a', 'b'],
)
eq('system 文本展开：字符串', systemTexts('a'), ['a'])
eq('system 文本展开：null', systemTexts(null), [])
eq(
  '余量剔除 billing 与身份句',
  callerSystemRemainder([
    { type: 'text', text: 'x-anthropic-billing-header: old;' },
    { type: 'text', text: OFFICIAL_CLI_IDENTITY },
    { type: 'text', text: 'You are a helpful bot.' },
    { type: 'text', text: 'Rules: be brief.' },
  ]),
  'You are a helpful bot.\n\nRules: be brief.',
)

// ─────────────────── 5. `<total_tokens>` 抹平
console.log('\n<total_tokens> 抹平')

eq(
  '计数抹平为固定值',
  stabilizeTotalTokens('x <total_tokens>812345 tokens left</total_tokens> y'),
  `x ${OFFICIAL_TOTAL_TOKENS} y`,
)
eq('不含计数原样返回', stabilizeTotalTokens('plain'), 'plain')
eq(
  '多处计数都抹平',
  stabilizeTotalTokens('<total_tokens>1 tokens left</total_tokens> / <total_tokens>2 tokens left</total_tokens>'),
  `${OFFICIAL_TOTAL_TOKENS} / ${OFFICIAL_TOTAL_TOKENS}`,
)
ok('主提示词自带计数已抹平', renderMainPrompt303({}).includes(OFFICIAL_TOTAL_TOKENS))
ok('主提示词不含原始计数', /<total_tokens>8\d{5}/.test(renderMainPrompt303({})) === false)
eq(
  '余量里的计数也被抹平',
  callerSystemRemainder(`bot <total_tokens>799000 tokens left</total_tokens>`),
  `bot ${OFFICIAL_TOTAL_TOKENS}`,
)
eq(
  '两轮请求的余量字节一致',
  callerSystemRemainder(`bot <total_tokens>812345 tokens left</total_tokens>`) ===
    callerSystemRemainder(`bot <total_tokens>799000 tokens left</total_tokens>`),
  true,
)

eq(
  '官方调用方识别：自带 billing',
  looksLikeOfficialCaller([{ type: 'text', text: 'x-anthropic-billing-header: a;' }, { type: 'text', text: 'bot' }]),
  true,
)
eq(
  '官方调用方识别：自带身份句',
  looksLikeOfficialCaller([{ type: 'text', text: OFFICIAL_CLI_IDENTITY }]),
  true,
)
eq(
  '官方调用方识别：自带官方提示词段落',
  looksLikeOfficialCaller([{ type: 'text', text: 'You are an interactive agent that helps users with code.' }]),
  true,
)
eq(
  '官方调用方识别：第三方提示词',
  looksLikeOfficialCaller([{ type: 'text', text: 'You are a helpful support bot.' }]),
  false,
)
eq('官方调用方识别：空 system', looksLikeOfficialCaller(null), false)

// ─────────────────── 6. 主提示词与 Environment 渲染
console.log('\n主提示词与 Environment')

eq('主提示词开头是 you are an agent', OFFICIAL_303_MAIN_PROMPT.trimStart().startsWith('You are an agent working with the user'), true)
eq('目录桶：绝对路径', projectSlug('/home/kincli'), '-home-kincli')
eq('目录桶：带空格', projectSlug('/srv/my app'), '-srv-my-app')
eq('主提示词填充 memory 目录', renderMainPrompt303({ cwd: '/srv/app' }).includes('/srv/app/.claude/projects/-srv-app/memory/'), true)
eq('主提示词不含模板占位', renderMainPrompt303({ cwd: '/srv/app' }).includes('{{memory_dir}}'), false)

const env = renderEnvironmentSection({ cwd: '/srv/app', git: true, platform: 'linux', shell: 'bash', osVersion: 'Linux 6.6.1', model: 'claude-opus-5-5' })
ok('Environment 以 # Environment 开头', env.startsWith('# Environment\n'))
ok('Environment 含 intro 句', env.includes(OFFICIAL_303_ENV_INTRO))
ok('Environment 含工作目录', env.includes(' - Primary working directory: /srv/app'))
ok('Environment 含 git 状态', env.includes(' - Is a git repository: true'))
ok('Environment 含 untrusted 段', env.includes(OFFICIAL_303_ENV_UNTRUSTED))
ok('Environment 含模型行', env.includes('The exact model ID is claude-opus-5-5.'))
eq('Environment 不写时区行', env.includes('Timezone'), false)
eq(
  '未知模型的模型行只写 id',
  modelLine('claude-fable-6'),
  'You are powered by the model claude-fable-6.',
)
eq(
  '已知模型的模型行带知识截止',
  modelLine('claude-opus-5-5'),
  'You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5. Assistant knowledge cutoff is June 2026.',
)
eq(
  '1M 变体标注上下文',
  modelLine('claude-opus-5-5', { oneM: true }),
  'You are powered by the model named Opus 5.5 (1M context). The exact model ID is claude-opus-5-5[1m]. Assistant knowledge cutoff is June 2026.',
)
eq(
  'Environment 事实解析',
  parseEnvironmentFacts(['# Environment\n - Primary working directory: /srv/app\n - Is a git repository: true\n - Platform: linux\n - Shell: bash\n - OS Version: Linux 6.6.1']),
  { cwd: '/srv/app', git: true, platform: 'linux', shell: 'bash', osVersion: 'Linux 6.6.1', model: '' },
)
eq(
  'Environment 段跨度',
  environmentSectionSpan('# Environment\n - Shell: bash\n\n# Language\nAlways Chinese.'),
  { start: 0, length: 28, section: '# Environment\n - Shell: bash' },
)
eq(
  'Environment 段替换不动段外字节',
  replaceEnvironmentSection('# Environment\n - Shell: zsh\n\n# Language\nAlways Chinese.', '# Environment\n - Shell: bash'),
  '# Environment\n - Shell: bash\n\n# Language\nAlways Chinese.',
)
eq('无 Environment 段时替换返回 null', replaceEnvironmentSection('# Language\nChinese.', '# Environment'), null)

// ─────────────────── 7. 结构 A：system 三段
console.log('\n结构 A：system 三段')

const callerSystem = [
  { type: 'text', text: 'x-anthropic-billing-header: cc_version=9.9.9; cc_entrypoint=x;' },
  { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
  { type: 'text', text: 'You are a helpful bot.' },
  { type: 'text', text: 'Rules: be brief.' },
]
const leanBody = {
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  system: callerSystem,
  messages: [{ role: 'user', content: 'hi there' }],
}
const leanOut = assembleRequest(leanBody, {
  profile: PROFILE_OFFICIAL_303,
  ttl: '1h',
  environment: { cwd: '/srv/app', git: false, platform: 'linux', shell: 'bash', model: 'claude-opus-5-5' },
})

eq('结构 A：system 是三段', leanOut.system.length, 3)
eq('结构 A：billing 在 system[0]', isBillingText(leanOut.system[0].text), true)
eq('结构 A：身份句在 system[1]', leanOut.system[1].text, OFFICIAL_CLI_IDENTITY)
eq('结构 A：主提示词在 system[2]', leanOut.system[2].text.startsWith(OFFICIAL_303_MAIN_PROMPT.slice(0, 40)), true)
eq('结构 A：billing 无断点', leanOut.system[0].cache_control, undefined)
eq('结构 A：身份句有断点', leanOut.system[1].cache_control, { type: 'ephemeral', ttl: '1h' })
eq('结构 A：主提示词有断点', leanOut.system[2].cache_control, { type: 'ephemeral', ttl: '1h' })
eq('结构 A：billing 版本是 2.1.303', /cc_version=2\.1\.303\./.test(leanOut.system[0].text), true)
eq('结构 A：调用方 billing 不出站', JSON.stringify(leanOut.system).includes('9.9.9'), false)
eq('结构 A：调用方身份句不出站', leanOut.system[1].text === OFFICIAL_CLI_IDENTITY, true)
eq('结构 A：调用方正文不进 system', JSON.stringify(leanOut.system).includes('helpful bot'), false)
eq('结构 A：结构标识', leanOut.structure, STRUCTURE_SYSTEM_REMINDER)
eq('结构 A：档位标识', leanOut.profile, PROFILE_OFFICIAL_303)
eq('结构 A：版本号', leanOut.cliVersion, '2.1.303')
eq('结构 A：UA', leanOut.userAgent, 'claude-cli/2.1.303 (external, sdk-cli)')

// 结构 A 的调用方 system 折进第一条 user
eq('结构 A：messages 是两条', leanOut.messages.length, 2)
eq('结构 A：首条是 user', leanOut.messages[0].role, 'user')
eq(
  '结构 A：首块是 reminder',
  leanOut.messages[0].content[0],
  { type: 'text', text: '<system-reminder>\nYou are a helpful bot.\n\nRules: be brief.\n</system-reminder>\n' },
)
eq('结构 A：reminder 后接原内容', leanOut.messages[0].content[1].text, 'hi there')
eq('结构 A：原内容带断点', leanOut.messages[0].content[1].cache_control, { type: 'ephemeral', ttl: '1h' })
eq('结构 A：Environment 是尾部 role=system', leanOut.messages[1].role, 'system')
ok('结构 A：Environment 以 # Environment 开头', String(leanOut.messages[1].content).startsWith('# Environment\n'))
eq('结构 A：Environment 是字符串', typeof leanOut.messages[1].content, 'string')

// 空调用方 system → 不产生 reminder
const noSystemOut = assembleRequest(
  { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
  { profile: PROFILE_OFFICIAL_303, ttl: '5m' },
)
eq('结构 A：无调用方 system 时无 reminder', noSystemOut.messages[0].content.length, 1)
eq('结构 A：无 reminder 仍有三个断点', noSystemOut.markers.total, 3)

// ─────────────────── 8. 结构 A：Environment 替换
console.log('\n结构 A：Environment 落位')

const withEnvMessage = assembleRequest(
  {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: '# Environment\n - Shell: zsh\n\n# Language\nAlways Chinese.' },
    ],
  },
  {
    profile: PROFILE_OFFICIAL_303,
    ttl: '5m',
    environment: { cwd: '/srv/app', shell: 'bash', model: 'claude-opus-5-5' },
  },
)
eq('结构 A：不新增 role=system 消息', withEnvMessage.messages.length, 2)
ok('结构 A：Environment 段被替换', String(withEnvMessage.messages[1].content).includes(' - Shell: bash'))
eq('结构 A：段外字节保留', String(withEnvMessage.messages[1].content).endsWith('\n\n# Language\nAlways Chinese.'), true)
eq('结构 A：role=system 不带断点', withEnvMessage.messages[1].cache_control, undefined)

const noTailOut = assembleRequest(
  {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'again' },
    ],
  },
  { profile: PROFILE_OFFICIAL_303, ttl: '5m', environment: { cwd: '/srv/app', model: 'claude-opus-5-5' } },
)
eq('结构 A：Environment 插在最后一条 user 之后', noTailOut.messages.at(-1).role, 'system')
eq('结构 A：Environment 位置在最后一条 user + 1', noTailOut.messages.length, 4)

// 模型不支持中途 role=system → 并进主提示词块
const mergedOut = assembleRequest(
  {
    model: 'claude-fable-6',
    system: [{ type: 'text', text: 'You are a helpful bot.' }],
    messages: [{ role: 'user', content: 'hi' }],
  },
  { profile: PROFILE_OFFICIAL_303, ttl: '5m', environment: { cwd: '/srv/app' } },
)
eq('降级：不产生 role=system 消息', mergedOut.messages.some((m) => m.role === 'system'), false)
eq('降级：system 仍是三段', mergedOut.system.length, 3)

// 官方调用方的 system 整体不出站（officialCaller: true 时不折进 user）
const officialCallerOut = assembleRequest(leanBody, {
  profile: PROFILE_OFFICIAL_303,
  ttl: '1h',
  officialCaller: true,
})
eq('官方调用方：不产生 reminder', officialCallerOut.messages[0].content.length, 1)
eq('官方调用方：首块就是原内容', officialCallerOut.messages[0].content[0].text, 'hi there')
eq('官方调用方：system 仍是三段', officialCallerOut.system.length, 3)
eq('官方调用方：调用方正文仍不进 system', JSON.stringify(officialCallerOut.system).includes('helpful bot'), false)

// ─────────────────── 9. 断点数量与位置
console.log('\n断点数量与位置')

const oneTurn = assembleRequest(
  { model: 'claude-opus-5-5', system: [{ type: 'text', text: 'bot' }], messages: [{ role: 'user', content: 'q1' }] },
  { profile: PROFILE_OFFICIAL_303, ttl: '5m' },
)
eq(
  '单轮：断点位置',
  oneTurn.markers.at.map((m) => m.where),
  ['system[1]', 'system[2]', 'messages[0].content[1]'],
)
eq('单轮：断点总数 3', oneTurn.markers.total, 3)

const fourMessages = assembleRequest(
  {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'bot' }],
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: 'q2' },
    ],
  },
  { profile: PROFILE_OFFICIAL_303, ttl: '5m' },
)
eq('三条消息：只有最后一条 user 带断点', fourMessages.markers.at.filter((m) => m.where.startsWith('messages[')).map((m) => m.where), ['messages[2].content[0]'])

const fourPlus = assembleRequest(
  {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'bot' }],
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'done' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'user', content: 'q3' },
    ],
  },
  { profile: PROFILE_OFFICIAL_303, ttl: '5m' },
)
eq(
  '四条以上消息：最后两条 user 各一个断点',
  fourPlus.markers.at.filter((m) => m.where.startsWith('messages[')).map((m) => m.where),
  ['messages[2].content[0]', 'messages[4].content[0]'],
)
eq('四条以上消息：首条 user 不带断点', Boolean(fourPlus.messages[0].content.some((b) => b.cache_control)), false)
eq('四条以上消息：断点总数 4', fourPlus.markers.total, 4)

// 尾部 Environment 参与消息数判定：3 条消息 + 1 条尾部 system = 4 条，
// 因此上一条 user 也拿到断点。这与官方样本的第二轮一致。
const threeTurnsWithEnv = assembleRequest(
  {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'bot' }],
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: 'q2' },
    ],
  },
  { profile: PROFILE_OFFICIAL_303, ttl: '5m', environment: { cwd: '/srv/app', model: 'claude-opus-5-5' } },
)
eq('尾部 Environment 计入消息数', threeTurnsWithEnv.messages.length, 4)
eq(
  '尾部 Environment 使上一条 user 也拿到断点',
  threeTurnsWithEnv.markers.at.filter((m) => m.where.startsWith('messages[')).map((m) => m.where),
  ['messages[0].content[1]', 'messages[2].content[0]'],
)
eq('尾部 Environment 不参与断点计数', threeTurnsWithEnv.markers.total, 4)
ok('四条以上消息：总数不超上限', fourPlus.markers.total <= PROFILES.official_303.maxMarkers)
eq('TTL 全程一致', [...new Set([oneTurn, fourPlus].flatMap((o) => o.markers.at.map((m) => m.ttl)))], ['5m'])
eq('1h TTL 写进断点', leanOut.markers.at.every((m) => m.ttl === '1h'), true)
eq('期望断点：单轮', expectedMarkerCount({ messageCount: 1, userCount: 1 }), 3)
eq('期望断点：四条以上', expectedMarkerCount({ messageCount: 5, userCount: 3 }), 4)

// 调用方已有的断点被清掉重打
const dirtyMarked = assembleRequest(
  {
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'bot' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a1', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'q2' },
    ],
  },
  { profile: PROFILE_OFFICIAL_303, ttl: '5m' },
)
eq('调用方旧断点被清掉', dirtyMarked.markers.total, 3)
eq('旧断点 TTL 不残留', dirtyMarked.markers.at.at(-1).ttl, '5m')

// 直接测两个消息级函数
eq(
  'markUserCacheBreakpoints：两条以内只打一个',
  markUserCacheBreakpoints([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], { ttl: '5m' }).count,
  1,
)
eq(
  'markUserCacheBreakpoints：thinking 块不取断点',
  markUserCacheBreakpoints(
    [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: [{ type: 'text', text: 'c' }, { type: 'thinking', thinking: 't' }] },
      { role: 'assistant', content: 'd' },
    ],
    { ttl: '5m' },
  ).messages[2].content[0].cache_control,
  { type: 'ephemeral' },
)
eq(
  'foldCallerSystemIntoFirstUser：纯函数',
  (() => {
    const input = [{ role: 'user', content: 'hi' }]
    foldCallerSystemIntoFirstUser(input, 'bot')
    return input[0].content
  })(),
  'hi',
)
eq(
  'foldCallerSystemIntoFirstUser：空余量不动消息',
  foldCallerSystemIntoFirstUser([{ role: 'user', content: 'hi' }], null),
  [{ role: 'user', content: 'hi' }],
)
eq(
  'appendEnvironmentMessage：无 user 时追加到尾部',
  appendEnvironmentMessage([{ role: 'assistant', content: 'a' }], '# Environment'),
  [{ role: 'assistant', content: 'a' }, { role: 'system', content: '# Environment' }],
)
eq(
  'summarizeMarkers：空入参',
  summarizeMarkers({}),
  { total: 0, at: [] },
)

// ─────────────────── 10. 结构 B：保持原样只换版本
console.log('\n结构 B：保持原样只换版本')

const fullBody = {
  model: 'claude-sonnet-5-5',
  system: [{ type: 'text', text: 'You are a helpful bot.' }],
  messages: [{ role: 'user', content: 'hi' }],
}
const fullOut = assembleRequest(fullBody, {
  profile: PROFILE_OFFICIAL_FULL,
  ttl: '1h',
  env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'identity', CLAUDE_CODE_TIMEZONE: 'Asia/Shanghai' },
})
const full303Out = assembleRequest(fullBody, {
  profile: PROFILE_OFFICIAL_303,
  ttl: '1h',
  env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'identity', CLAUDE_CODE_TIMEZONE: 'Asia/Shanghai' },
})

eq('结构 B：full 档结构标识', fullOut.structure, STRUCTURE_CLI_HOP)
eq('结构 B：303 档 + Sonnet 仍是结构 B', full303Out.structure, STRUCTURE_CLI_HOP)
eq('结构 B：messages 未被改动', fullOut.messages, fullBody.messages)
eq('结构 B：303 档 messages 也未改动', full303Out.messages, fullBody.messages)
eq('结构 B：调用方 system 仍在 system 里', JSON.stringify(fullOut.system).includes('helpful bot'), true)
eq('结构 B：303 档调用方 system 也留在 system 里', JSON.stringify(full303Out.system).includes('helpful bot'), true)
ok('结构 B：full 档 billing 仍是 2.1.296', /cc_version=2\.1\.296\./.test(fullOut.system[0].text))
ok('结构 B：303 档 billing 换成 2.1.303', /cc_version=2\.1\.303\./.test(full303Out.system[0].text))
// cc_version 尾缀与 cc_prompt_id 都由版本号参与派生，因此一并归一化后再比较结构。
const neutralVersion = (blocks, ver) =>
  JSON.stringify(blocks)
    .replace(new RegExp(`cc_version=${ver.replace(/\./g, '\\.')}\\.[0-9a-f]{3}`, 'g'), 'cc_version=V')
    .replace(/cc_prompt_id=[0-9a-f-]+/g, 'cc_prompt_id=ID')
eq('结构 B：两档除版本相关字段外完全一致', neutralVersion(full303Out.system, '2.1.303'), neutralVersion(fullOut.system, '2.1.296'))
eq('结构 B：块数与系统布局一致', fullOut.system.length, layoutSystemBlocks({ attribution: 'x-anthropic-billing-header: a;', leftover: 'b', env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'identity' } }).length)
eq('结构 B：入口点 sdk-cli', fullOut.system[0].text.includes('cc_entrypoint=sdk-cli;'), true)
ok('结构 B：UA 仍是 2.1.296', fullOut.userAgent === 'claude-cli/2.1.296 (external, sdk-cli)')
ok('结构 B：303 档 UA 是 2.1.303', full303Out.userAgent === 'claude-cli/2.1.303 (external, sdk-cli)')

const zeroOut = assembleRequest(fullBody, { profile: PROFILE_OFFICIAL_303, ttl: '5m', env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'zero' } })
eq('结构 B：zero 布局写 billing + 环境块 + 调用方', zeroOut.system.length, 3)
eq('结构 B：zero 布局第二块是环境块', zeroOut.system[1].text.startsWith('# Environment'), true)
ok('结构 B：zero 布局 billing 版本也换了', /cc_version=2\.1\.303\./.test(zeroOut.system[0].text))
// zero 布局是我们自己的设计：把身份句塞进 billing 头的 prompt_version 里。
  // 但官方 billing 头**没有**这个字段 —— 这是已知的非官方特征，
  // 只在显式选 zero 布局时出现，默认档不走这条路。
  ok('结构 B：zero 布局 billing 有 prompt_version（已知非官方特征）',
    zeroOut.system[0].text.includes('prompt_version=<'))

eq('结构 B：system 组装纯函数', (() => {
  const before = JSON.stringify(fullBody)
  assembleRequest(fullBody, { profile: PROFILE_OFFICIAL_303, ttl: '5m', env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'identity' } })
  return JSON.stringify(fullBody) === before
})(), true)

eq('结构 A：输入 body 未被就地修改', (() => {
  const before = JSON.stringify(leanBody)
  assembleRequest(leanBody, { profile: PROFILE_OFFICIAL_303, ttl: '1h' })
  return JSON.stringify(leanBody) === before
})(), true)

// 1M 变体：Environment 的模型行标注上下文
const oneMOut = assembleRequest(
  { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] },
  { profile: PROFILE_OFFICIAL_303, ttl: '5m', oneM: true, environment: { cwd: '/srv/app' } },
)
ok('1M 变体：Environment 标注 1M context', String(oneMOut.messages.at(-1).content).includes('(1M context)'))
ok('1M 变体：模型行用 [1m]', String(oneMOut.messages.at(-1).content).includes('claude-opus-5-5[1m]'))

// ─────────────────── 11. cch 封盖兼容
console.log('\ncch 封盖兼容')

const sealed = sealClaudeCodeCch(leanOut.body, { enabled: true, seal: true })
ok('封盖后 cch 变成真实值', /cch=[0-9a-f]{5};/.test(sealed.system[0].text))
eq('封盖后 cch 不再是占位符', sealed.system[0].text.includes('cch=00000'), false)
ok('封盖后 billing 版本不变', sealed.system[0].text.includes('cc_version=2.1.303.'))
eq('封盖不动身份句', sealed.system[1].text, OFFICIAL_CLI_IDENTITY)
eq('封盖不动断点', sealed.system[1].cache_control, { type: 'ephemeral', ttl: '1h' })
eq('封盖不动 messages 条数', sealed.messages.length, leanOut.messages.length)
eq('封盖幂等', sealClaudeCodeCch(sealed, { enabled: true, seal: true }).system[0].text, sealed.system[0].text)
eq(
  '封盖后断点位置不变',
  summarizeMarkers({ system: sealClaudeCodeCch(leanOut.body, { enabled: true, seal: true }).system, messages: sealed.messages }).at.map((m) => m.where),
  leanOut.markers.at.map((m) => m.where),
)

// ─────────────────── 12. 组装入口的边界
console.log('\n组装入口边界')

eq('assembleSystemBlocks：303 + lean 三段', assembleSystemBlocks({ profile: PROFILE_OFFICIAL_303, model: 'claude-opus-5-5' }).length, 3)
eq('assembleSystemBlocks：303 + Sonnet 交给布局', assembleSystemBlocks({ profile: PROFILE_OFFICIAL_303, model: 'claude-sonnet-5-5', env: { CLAUDE_CODE_SYSTEM_LAYOUT: 'identity' } }).length, 3)
eq('assembleSystemBlocks：全部是 text 块', assembleSystemBlocks({ profile: PROFILE_OFFICIAL_303, model: 'claude-opus-5-5' }).every((b) => b.type === 'text'), true)
eq('空 messages 不抛错', assembleRequest({ model: 'claude-opus-5-5' }, { profile: PROFILE_OFFICIAL_303 }).messages, [])
eq('缺 model 走结构 B', assembleRequest({ messages: [] }, { profile: PROFILE_OFFICIAL_303 }).structure, STRUCTURE_CLI_HOP)
eq(
  '缺省档是 full，lean 模型也走结构 B',
  assembleRequest({ model: 'claude-opus-5-5', system: [{ type: 'text', text: 'bot' }], messages: [{ role: 'user', content: 'hi' }] }).structure,
  STRUCTURE_CLI_HOP,
)
eq(
  '显式 303 档才走结构 A',
  assembleRequest(
    { model: 'claude-opus-5-5', system: [{ type: 'text', text: 'bot' }], messages: [{ role: 'user', content: 'hi' }] },
    { profile: PROFILE_OFFICIAL_303 },
  ).structure,
  STRUCTURE_SYSTEM_REMINDER,
)
const fullShapeOut = assembleRequest(
  {
    model: 'claude-opus-5-5',
    max_tokens: 128000,
    stream: true,
    metadata: { user_id: 'x' },
    system: [{ type: 'text', text: 'bot' }],
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
  },
  { profile: PROFILE_OFFICIAL_303, ttl: '5m' },
)
eq(
  '顶层键按 303 样本顺序',
  Object.keys(fullShapeOut.body),
  ['model', 'messages', 'system', 'tools', 'metadata', 'max_tokens', 'thinking', 'output_config', 'stream'],
)
eq(
  '顶层 cache_control 被丢弃',
  'cache_control' in assembleRequest(
    { model: 'claude-opus-5-5', cache_control: { type: 'ephemeral' }, messages: [{ role: 'user', content: 'hi' }] },
    { profile: PROFILE_OFFICIAL_303, ttl: '5m' },
  ).body,
  false,
)
eq('未知顶层字段保留', assembleRequest({ model: 'claude-opus-5-5', custom_field: 1, messages: [] }, { profile: PROFILE_OFFICIAL_303 }).body.custom_field, 1)

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
