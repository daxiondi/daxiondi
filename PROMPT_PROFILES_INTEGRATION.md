# 提示词档位接入说明（official_303）

本文说明 `src/prompt-profiles.mjs` 如何接入现有通道，以及接入时必须遵守的顺序约束。
所有结论都可以用 `node test/prompt-profiles.mjs`（233 条）与
`node scripts/compare-prompt-profiles.mjs` 复现。

## 1. 一句话差异

| | `official_full`（缺省） | `official_303` |
|---|---|---|
| 结构 | `cli_hop` | `system_reminder` |
| system 段 | billing → 环境块 → 调用方 system | billing → 身份句 → 2.1.303 主提示词 |
| 调用方 system | 留在 `system` 里 | 折进**第一条 user** 的 `<system-reminder>` |
| Environment | 留在 `system` 里 | **尾部 role=system**，只替换 `# Environment` 段 |
| 缓存断点 | 由 `cache-breakpoints.mjs` 决定 | 身份句 + 主提示词 + 最后 1–2 条 user |
| CLI 版本 | 2.1.296 | 2.1.303 |
| 出站 UA | `claude-cli/2.1.296 (external, cli)` | `claude-cli/2.1.303 (external, cli)` |

`cc_entrypoint` 两档都是 `cli`。`cc_turn_origin` 不变。

## 2. 接入点与调用顺序

现有 `src/server.mjs` 的 `prepareOutbound` 固定四步，档位组装插在**第 1 步之前**：

```
0. assembleRequest(body, { profile, ttl, environment, officialCaller })   ← 新增
1. betas 合并
2. 缓存断点补丁（仅 official_full 需要；303 档自己布点）
3. cch 封盖（必须最后）
```

`assembleRequest` 返回 `{ body, system, messages, profile, structure, cliVersion, userAgent, billing, markers }`：

- `body` 是已经按 2.1.303 样本排好顶层键序、可直接交给后续步骤的请求体；
- 其余字段供调用方写响应头、写日志、做对比，不参与封盖。

```js
import { assembleRequest, resolvePromptProfile, PROFILE_OFFICIAL_303 } from './prompt-profiles.mjs'

const profile = resolvePromptProfile({ model: body.model, configured: cfg.claude_prompt_profile })
const assembled = assembleRequest(body, {
  profile,
  ttl: envelope.cache_ttl ?? cfg.default_cache_ttl,
  environment: {
    cwd: request_context?.cwd,
    git: request_context?.git,
    platform: request_context?.platform,
    shell: request_context?.shell,
    osVersion: request_context?.os_version,
    model: body.model,
  },
  officialCaller: /* 见第 3 节 */,
})
let out = assembled.body
// 后续：betas 合并 → cch 封盖
```

### 2.1 断点不要重复布

`official_303` 档自己给 system 与 messages 布点，`prepareOutbound` 第 2 步
（`applyCacheBreakpoints`）必须跳过，否则会出现「system 2 点 + messages 2 点」的
第三方形状：

```js
if (assembled.structure === 'cli_hop') {
  // 现有逻辑，不动
  const breakpoints = applyCacheBreakpoints(next, { ttl: panelTtl })
  ...
}
```

### 2.2 顶层 `cache_control`

`assembleRequest` 会删掉顶层 `cache_control`——2.1.303 的请求形状里没有这个字段，
断点一律写在块上。

## 3. `officialCaller` 的判定

结构 A 只有在调用方**不是**官方族时才把 system 折进 user。官方族的整份 system
已经由本档产出，再折一份等于把上一版完整提示词贴进 reminder。

判定入口有两个，二选一：

- `looksLikeOfficialCaller(callerSystem)`：只看 system（自带 billing 头 / 自带官方
  身份句 / 带 `# Reporting outcomes` 等官方段落标记）。
- 调用方已有的 `isOfficialClaudeCodeTraffic(headers, body)` 等价判定。

两者结论不一致时以调用方传入的 `officialCaller` 为准：组装层不猜，保证同一个
body 在两种判定下的出站结果都能复现。

## 4. 版本号的三个出口

选 303 档时，三处必须同时是 2.1.303：

| 出口 | 取值来源 |
|---|---|
| 出站 UA | `outboundUserAgent(profile)` → `claude-cli/<ver> (external, cli)` |
| billing `cc_version` | `billingHeader({ profile })` → `cc_version=<ver>.<fp>` |
| cch 计算输入 | 上面两个步骤产出的最终字节（`sealClaudeCodeCch` 自动覆盖） |

`src/identity.mjs` 的 `officialCliUserAgent(env)` 仍按环境变量取版本，接入时用
`assembled.userAgent` 覆盖，不要让它和 billing 里的版本各说各话。

## 5. 配置项

`src/config.mjs` 已加：

```js
claude_prompt_profile: 'official_full',   // 可选 'official_303'
```

- 枚举常量 `CLAUDE_PROMPT_PROFILES`，`validateWorkerConfig` 只做枚举校验；
- 别名（`303` / `official-303` / `full`）由 `normalizePromptProfile` 归一，
  配置层不归一——否则控制面写进来的原始值会被静默改写，两端看到的取值就不一致。

缺省 `official_full` 完全保持现有行为，升级不影响已部署机。

## 6. `<total_tokens>` 抹平

结构 A 的两处文本都过 `stabilizeTotalTokens`：

1. 主提示词末尾的 `15000000` 固定不变；
2. 折进 user 的调用方 system 余量，把 `800000` 之类实时计数统一成同一个值。

不抹平的后果：第二轮请求的 reminder 字节与第一轮不同，首条 user 上的断点前缀
失效，整个消息段每轮重写。`test/prompt-profiles.mjs` 里「两轮请求的余量字节一致」
就是这条的回归断言。

## 7. 模型不支持中途 `role=system` 时

`modelSupportsSystemTurns(model)` 为假时（Sonnet 5 / Haiku 4.5 及更早的 4.x），
Environment 不追加 role=system 消息，而是并进主提示词块尾部：

```
system[2].text = <2.1.303 主提示词> + "\n\n" + <Environment 段>
```

这与官方在 `role=system` 不可用时的降级路径一致。注意 303 档的结构选择本身已经
按模型分过（lean 模型才走结构 A），这条降级是给「显式选 303 档但模型能力不足」
的边界情况兜底。

## 8. 回归清单

```bash
node test/prompt-profiles.mjs            # 233 条，档位 / 结构 / 断点 / billing
node test/selfcheck.mjs                   # 236 条，原有契约不变
node test/run-all.mjs                     # 全量
node scripts/compare-prompt-profiles.mjs  # 两档差异对比
```

改 `prompt-profiles.mjs` 后至少要跑前三条全绿，再跑第四条确认差异仍符合预期。

## 9. 不要做的事

1. 不要在 303 档之后再调 `applyCacheBreakpoints`——断点会变成 system 2 + messages 2。
2. 不要把调用方 system 同时留在 `system` 和 reminder 里——前缀翻倍，缓存全失效。
3. 不要改 `OFFICIAL_TOTAL_TOKENS` 的数值——已有会话的缓存前缀会整体重建一次。
4. 不要让 cch 在 `assembleRequest` 之前封盖——它算的是最终字节。
5. 不要给 billing 块打缓存断点——2.1.303 样本里 billing 无标记。
