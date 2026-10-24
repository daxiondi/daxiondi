# 遥测层对比（我们 vs 官方 v1.3.220）

> 审计对象
> - 官方：`research/vm2api/`，v1.3.220。下文简写 `[O]` 前缀。
> - 我们：`research/reimpl/`。下文简写 `[R]` 前缀。
> - 行号均为当前工作区文件的行号，可用 `sed -n '<行>p' <文件>` 复核。

## 先决事实：官方的遥测是「两层」而不是一层

审计前必须纠正一个容易读错的结构。官方 v1.3.220 的遥测由**两个进程**分担，只看 `telemetry-rewrite.mjs` 会得出完全反向的结论：

| 层 | 位置 | 职责 |
|---|---|---|
| Node 网关 | `[O]src/lib/identity/telemetry-rewrite.mjs` + `[O]src/server.mjs:1034` | 命中遥测路径就**直接返回假 200，不读 body、不转发**。改写函数（`rewriteEventBatch` 等）在该文件里存在，但 `src/` 全库没有调用点 |
| Go sidecar | `[O]worker/internal/telemetry/` | **真正发出遥测的一方**：自己构造 `tengu_init` / `tengu_api_success` / GrowthBook eval，用槽位的官方身份 POST 到 `/api/event_logging/v2/batch` |

验证：`grep -rn "rewriteTelemetryBody\|rewriteEventBatch" [O]src/` 只命中定义处，`[O]src/server.mjs:1034-1035` 只 import 了 `isTelemetryPath` 与 `telemetryInterceptResponse`。

所以「官方改哪些字段」有两份答案：
- 对**客户端上报的 body**（Node 层，实际未启用）：改写身份字段、整体替换 env、重算 process、删 `betas`/`model`/`additional_metadata`/`baseUrl`。
- 对**自己发出的 body**（Go 层，实际生效）：字段集合由 `event.go` 白名单决定，压根不构造 `model`/`betas`/`additional_metadata`。

我们的实现只有「自己构造并发出」这一条路径，**没有**「接收/改写客户端 body」的能力。对齐时应以官方 Go 层为主参照，Node 层的改写清单作为「哪些字段不该出现」的权威依据。

## 结论摘要

- 封号风险项：**6**
- 功能缺失项：**6**
- 已对齐：**4**

| # | 能力 | 风险等级 | 一句话 |
|---|---|---|---|
| 1 | 端点地址 | 封号风险（高） | 官方 `/api/event_logging/v2/batch`，我们 `/api/event_logging/batch` —— 缺 `v2`，全部上报打到不存在的路径 |
| 2 | `device_id` 来源 | 封号风险（高） | 官方无真实 64hex 身份就**整块禁用**；我们每条事件**新生成随机值** |
| 3 | env 值归一接线 | 封号风险（高） | 改写层产物是 snake_case，下游构造器读 camelCase，`deployment_environment` / `linux_kernel` 归一被静默丢弃 |
| 4 | `model` / `betas` 字段 | 封号风险（中） | 官方主动删除，我们在生产调用点把用户真实模型名发上去 |
| 5 | env 字段集合 | 封号风险（中） | 官方有 `shell`、无 `node_version`/`is_running_with_bun`；我们正好相反，且二者组合自相矛盾 |
| 6 | 请求头与凭据 | 封号风险（中） | 官方白名单含 `x-app`/`x-stainless-*`/`accept-language` 且无 token 不发；我们头更少、无 token 也发 |
| 7 | 发送调度 | 功能缺失（高） | 生产代码只有 `enqueue`，全库无 `flush()` 调用、无定时器、无退出钩子 —— 遥测实际一条都没发出去 |
| 8 | `tengu_init` | 功能缺失（中） | 官方首发必带 `tengu_init`，我们从不下发 |
| 9 | GrowthBook eval | 功能缺失（中） | 官方每 6h 打 `/api/eval/<clientKey>`，我们完全没有 |
| 10 | body 级改写能力 | 功能缺失（中） | 官方有 4 个 body 改写函数，我们无对应实现，无法处理任何外来遥测 body |
| 11 | 4xx 停止 / 重试 / 审计 | 功能缺失（低） | 官方 4xx 后停该类上报并写 redact 审计日志；我们失败即丢，8 次重试常量只是摆设 |
| 12 | 客户端路径拦截 | 功能缺失（低） | 官方 fake 200（含 `metrics_enabled`），我们 404 |
| 13 | Sentry | 已对齐 | 双方都不处理，`[O]` 全库 `sentry` 命中 0 次 |
| 14 | `1p_failed_events.*.json` | 已对齐（略优） | 双方都不做失败落盘；我们额外有换机清理清单 |
| 15 | 信封 / ID / 时间戳 / process 编码 | 已对齐 | 格式层一致 |
| 16 | 硬件字段剔除 | 已对齐 | 双方都无条件剔除 11 项硬件键 |

## 逐项对比

### 1. 端点地址

- **官方**
  - Node 拦截判定：`[O]src/lib/identity/telemetry-rewrite.mjs:10-20`，匹配 `/event_logging/batch`、`/api/eval/`、`/api/claude_code/metrics`、`/api/claude_code/organizations/metrics_enabled`。
  - 真实上报端点：`[O]worker/internal/telemetry/client.go:19`，`batchPath = "/api/event_logging/v2/batch"`。
  - eval 端点：`[O]worker/internal/telemetry/client.go:21`，`"/api/eval/" + growthbookClientKey`，key 见 `[O]worker/internal/telemetry/client.go:20` 与 `[O]src/lib/identity/telemetry-env.mjs:9`。
- **我们**
  - `[R]src/telemetry/env.mjs:29-30`：`OFFICIAL_TELEMETRY_PATH = '/api/event_logging/batch'`、`OFFICIAL_TELEMETRY_ENDPOINT = https://api.anthropic.com + 该路径`。
  - `[R]src/telemetry/sender.mjs:23` 把它设为默认端点，`[R]src/telemetry/index.mjs:57` 固化进默认配置。
- **差异**：缺少 `v2` 段。这是 2.1.x 客户端的真实路径（`[R]docs/cc-hardware-probe.md:725`、`:828` 实测与反编译均确认 `event_logging/v2/batch`）。我们的路径对应的 V1 版本在 2.1.x 上已不存在。同时官方 Node 的 `includes('/event_logging/batch')` 也匹配不到 `v2`（子串不连续），说明官方并不指望靠 Node 拦 v2 —— 它靠 Go sidecar 直发。
- **风险**：封号风险（高）。一旦打开开关，每条遥测都会打到 404，上游侧留下「一个自称 `claude-code/2.1.296` 的客户端反复请求已废弃路径」的记录，这是极罕见的客户端行为。
- **建议**：改为 `/api/event_logging/v2/batch`；同时把 `isTelemetryPath` 补上 `v2` 变体，避免将来接客户端 body 时漏判。修正后需同步 `[R]test/telemetry.mjs:443` 的断言。

### 2. `device_id` 来源与兜底

- **官方**
  - 严格取值：`[O]worker/internal/telemetry/event.go:240-245`，`telemetryDevice()` 只接受 64 位 hex，否则返回空串；`[O]worker/internal/telemetry/event.go:309-314` 的 `put()` 对空串**不写入键**，即宁可缺字段也不编造。
  - 上游把关：`[O]src/lib/vm/worker-telemetry.mjs:136-139`，拿不到官方 `userID` 时直接 `return { enabled: false, reason: 'waiting_official_identity' }`，整块遥测关掉。
  - 身份来源：`[O]src/lib/vm/worker-telemetry.mjs:124`（`readOfficialCcIdentity`）+ `:143-149`，取 `~/.claude.json` 的 `userID`，与 `metadata.user_id.device_id` 同源。
- **我们**
  - `[R]src/telemetry/events.mjs:288`：`eventData.device_id = resolveDeviceId(ctx.deviceId, ctx.userId)`。
  - `[R]src/telemetry/events.mjs:124-130`：`resolveDeviceId` 在候选值都不合法时 `return newDeviceId()` —— **每次调用生成一个新随机值**。
  - 生产调用点：`[R]src/server.mjs:167-174` 构造 `createTelemetry` 时**没有传 `context`**；`[R]src/server.mjs:538` 只传 `request_id`/`model`/`session_id`。因此 `ctx.deviceId`、`ctx.userId` 恒为 `undefined`。
  - 已有的正确身份源并未接进来：`[R]src/persona/claude-home.mjs:57-62` 已经派生出 `userId`/`deviceId`（并有「必须与 metadata.user_id 一致」的注释），遥测层完全没用。
- **差异**：官方「没有身份就不发」；我们「没有身份就造一个，而且每条都造新的」。一个真实会话内 `device_id` 必须恒定（`[R]docs/cc-hardware-probe.md:816` 实测 8 条事件 `device_id` 完全一致），我们每条事件一个值，等于自报「这批事件不是同一个客户端产生的」。
- **风险**：封号风险（最高）。这是当前实现里唯一「一开就必被抓」的点，且它不依赖任何外部条件。
- **建议**：三选一，优先级递减 ——（a）`ctx.deviceId` 必须来自 `claude-home.mjs` 的槽位 `deviceId`，缺失时**整块禁用发送**（照 `[O]src/lib/vm/worker-telemetry.mjs:136-139` 的做法）；（b）`resolveDeviceId` 的兜底改为返回值 `''`，由 `buildEvent` 在空值时**省略** `device_id` 键；（c）至少把随机兜底提升到 `createTelemetry` 级别只生成一次。禁止保留「每条事件新随机」。

### 3. env 值归一（`deployment_environment` / `linux_kernel`）

- **官方**
  - 不探测，直接给定值：`[O]src/lib/vm/worker-telemetry.mjs:150-151` 写死 `platform: 'linux'`、`platform_raw: 'linux'`；`[O]src/lib/identity/telemetry-env.mjs:151` 的 `deployment_environment` 由 `platform === 'linux'` 直接推出 `unknown-linux`。
  - 从不存在「探测出 docker 再往回压」的路径，因为源头就不采集（`[O]worker/internal/telemetry/event.go:223-238` 的 `dropEnvKey` 把 `hostname`/`machine_id`/`kernel_release`/`runtime_kind` 全部丢弃）。
- **我们**
  - 改写层：`[R]src/telemetry/rewrite.mjs:266-282` 做部署形态归一，`:225-234` 做内核串归一，`:336-402` 汇总为 `rewriteTelemetryEnv`。
  - 接线处：`[R]src/telemetry/index.mjs:106-108`
    ```js
    const rewritten = rewriteTelemetryEnv(raw.env || raw, { ...context, ...raw })
    return buildTelemetryEnv({ ...raw, ...rewritten })
    ```
  - 下游构造器：`[R]src/telemetry/env.mjs:292-293` 读的是 **camelCase** `src.deploymentEnvironment`，`:313` 读的是 `src.linuxKernel`。
- **差异**：`rewriteTelemetryEnv` 的产物全是 **snake_case**（`deployment_environment`、`linux_kernel`），`buildTelemetryEnv` 只认 camelCase，于是归一结果被整块丢弃，`{...raw, ...rewritten}` 里 `raw` 的原始 camelCase 值反而胜出。具体后果三条：
  1. `raw.deploymentEnvironment === 'docker'` 时，上报值就是 `docker` —— 归一没生效；
  2. `raw.env = process.env` 且含 `CI`/`KUBERNETES_SERVICE_HOST` 时，`env.mjs:293` 的 `detectDeploymentEnvironment` 会从**原始** `process.env` 重新探测出 `ci`/`kubernetes`，绕过 `rewrite.mjs:310-327` 的字段清洗；
  3. `raw.linuxKernel = '5.15.0-1053-azure'` 时原样上报，`normalizeKernel` 从未参与。
  另外 `buildTelemetryEnv` 不识别的 `shell` 键（`[O]` 有、我们 `ENV_FIELD_ORDER` 无，见第 5 项）也被丢弃。
- **风险**：封号风险（高）。`deployment_environment` 是官方明确上报且值域很窄的字段，出现 `docker`/`kubernetes` 属于直接自报部署形态；`-azure`/`-gvisor` 内核串同理。改写层「看起来写了」但实际无效，比没写更危险。
- **建议**：二选一，别混用命名空间 ——（a）`rewriteTelemetryEnv` 增加 camelCase 输出模式，或在 `index.mjs` 里做一次显式映射（`deployment_environment` → `deploymentEnvironment`、`linux_kernel` → `linuxKernel`）；或（b）让 `buildTelemetryEnv` 接受已改写对象时不再二次探测（加 `already_normalized: true` 短路）。修完后必须补一条端到端断言：喂 `{deploymentEnvironment:'docker', linuxKernel:'5.15.0-1053-azure'}`，断言输出的 `deployment_environment` 不为 `docker`、`linux_kernel` 不含 `azure`。当前 `test/telemetry.mjs` 只测了改写层单函数，没有测这条接线。

### 4. `model` / `betas` 字段

- **官方**
  - 改写层主动删除：`[O]src/lib/identity/telemetry-rewrite.mjs:85-86`（`delete obj.betas` / `delete obj.model`）与 `:108-109`（`delete data.betas` / `delete data.model`）。
  - 自发层压根不构造：`[O]worker/internal/telemetry/event.go:53-61` 的事件字段里没有 `model`；`:45` 的 `namedEvent(id, name, now, uptimeSecs, model)` 甚至把 `model` 参数标成 `_ string` 直接忽略。
- **我们**
  - `[R]src/telemetry/events.mjs:243`：`model: str(ctx.model).trim() || DEFAULT_MODEL`，落在核心字段里。
  - `[R]src/telemetry/events.mjs:248`：`if (ctx.betas) core.betas = ...`。
  - 生产调用点：`[R]src/server.mjs:538` 显式传 `model: payload.model` —— 用户请求的真实模型名，**每次必发**。
- **差异**：`model` 是实际在发的（不是潜在风险）；`betas` 当前调用点不传，属能力存在但未触发。官方两层都拿掉了这两个字段。
- **风险**：封号风险（中）。`model` 让上游能把遥测事件与具体请求、乃至账号的模型使用结构对上号；同时我们的 `DEFAULT_MODEL`（`[R]src/telemetry/events.mjs:94`，`claude-sonnet-4-5-20250929`）与真实请求模型不一致时，还会出现「遥测说 A、业务 say B」的自相矛盾。
- **建议**：`buildCoreFields` 去掉 `model`，或至少由 `createTelemetry` 默认不注入；`betas` 同理。若为了「键序契约完整」想保留占位，应改为「调用方显式 opt-in」而不是默认带值。

### 5. env 字段集合

- **官方**
  - 构造：`[O]src/lib/identity/telemetry-env.mjs:130-170`（`buildFullEnvJson`）。要点：**有 `shell`**（`:138`，走 `telemetryShell()` 归一，`:85-94`），**无 `node_version`、无 `is_running_with_bun`**。
  - 键列表：`[O]src/lib/identity/telemetry-env.mjs:23-57`（`FULL_ENV_KEYS`，36 项，含 `shell`，不含 `node_version`/`is_running_with_bun`）。
  - 空串条件键**照样输出**：`:153-162`（`github_event_name`、`wsl_version`、`remote_environment_type`、`claude_code_container_id`、`claude_code_remote_session_id`、`coworker_type`、`tags` 均为空值也进对象）；Go 侧同构：`[O]worker/internal/telemetry/event.go:179-188`。
  - `build_time` 条件输出：`[O]src/lib/identity/telemetry-env.mjs:167-168`（仅非空才写）。
- **我们**
  - 键序：`[R]src/telemetry/env.mjs:43-79`（`ENV_FIELD_ORDER`，35 项）。含 `node_version`（`:46`）、`is_running_with_bun`（`:49`）、`github_actions_metadata`（`:61`）；**不含 `shell`**（`:38-39` 的注释还明确写了「没有 `shell`」）。
  - 必发字段表：`[R]src/telemetry/env.mjs:85-105`；条件字段表：`:111-128`。
  - 值：`node_version` 硬编码 `'v22.14.0'`（`:276`）；`is_running_with_bun` 恒 `true`（`:154`）；`build_time` 恒输出硬编码值（`:295`）。
- **差异**（三处，方向相反）：
  1. 我们多发 `node_version` + `is_running_with_bun`，且**两者互斥**：真实 Claude Code 是 bun 产物，`process.versions.node` 在有 bun 时不会是这个形状；一条事件同时声明「跑在 node v22.14.0」和「`is_running_with_bun: true`」是逻辑不可能的组合。官方 `dropEnvKey` 正是为了避开这个矛盾（`[O]worker/internal/telemetry/event.go:225`）。
  2. 我们少发 `shell`。官方明确构造它（`telemetry-env.mjs:138`），Go 也发（`event.go:164`），`[R]docs/cc-hardware-probe.md:781` 的实测 payload 里同样有 `"shell":"bash"`。
  3. 空串条件键：我们非空才发（`env.mjs:318-321`），官方恒发空串。注意这一处**实测客户端与官方代码不一致** —— 实测 2.1.310 payload（`[R]docs/cc-hardware-probe.md:748-782`）里没有 `github_event_name` 等空串键。也就是说官方 `buildFullEnvJson` 是「保守全量」，真实客户端是「省略空值」。我们与实测一致、与官方代码不一致。
- **风险**：封号风险（中）。第 1 条是硬矛盾，一旦被抓到就是「非官方实现」的铁证；第 2、3 条单独看只是指纹差异。
- **建议**：`ENV_FIELD_ORDER` 增补 `shell`（走 `telemetryShell` 归一，默认 `bash`），删掉 `node_version` 与 `is_running_with_bun`（或按官方做法由 `dropEnvKey` 剔除）；空串条件键这一条建议**保持现状**（与实测一致），但在文档里注明「与官方 `buildFullEnvJson` 有意分歧」，不要一半按代码一半按实测混搭。`build_time` 改为非空才输出，对齐 `telemetry-env.mjs:167-168`。

### 6. 请求头与凭据

- **官方**
  - 白名单：`[O]worker/internal/telemetry/client.go:24-37`（`user-agent`、`x-app`、`anthropic-version`、`x-stainless-lang/os/arch/runtime/runtime-version/package-version`、`x-claude-code-session-id`、`x-service-name`、`accept-language`）。
  - 实际构造：`[O]src/lib/vm/worker-telemetry.mjs:95-116`，UA 为 `claude-code/<cliVersion>`（`[O]src/lib/identity/telemetry-env.mjs:262-264`），其余 8 个 stainless 头齐全，并按 locale 补 `accept-language`。
  - 无 token 不发：`[O]worker/internal/telemetry/client.go:60-62` 直接返回 error。
- **我们**
  - `[R]src/telemetry/sender.mjs:32-42`：只有 `Content-Type`、`User-Agent`（`claude-code/2.1.296`）、`x-service-name`、`anthropic-version`；`Authorization` 与 `x-claude-code-session-id` 是条件项。
  - `[R]src/telemetry/sender.mjs:39` 无 token 时照发；`[R]src/telemetry/index.mjs:93-101` 把 `headersProvider` 原样透传给 sender，而生产调用点 `[R]src/server.mjs:167-174` 没传它，于是 `[R]src/telemetry/sender.mjs:74` 的 `#headersProvider` 为 `null`，最终走 `buildTelemetryHeaders({})` —— 生产上等于**无 Authorization**。
- **差异**：少 7 个 `x-stainless-*` + `x-app` + `accept-language`；且官方是「无凭据不发」，我们是「无凭据照发」。UA 口径一致（都是 `claude-code/<semver>`），这部分已对齐。
- **风险**：封号风险（中）。无 Bearer 的遥测请求会拿到 401/403；一群 stainless 头缺失的「claude-code 客户端」也是极强指纹 —— 真实客户端的所有出站请求都由 stainless SDK 发出，头必然成套。
- **建议**：`buildTelemetryHeaders` 补齐 `x-app: cli` 与 6 个 `x-stainless-*`（值取自身份指纹，参照 `[O]src/lib/identity/crs-headers.mjs:80-92`）；`flush` 前检查 token，缺失则整体跳过而不是发一个裸请求。

### 7. 发送调度（是否真的有东西发出去）

- **官方**
  - 定时循环：`[O]worker/internal/telemetry/run.go:140-215`，`tickInterval = time.Second`（`:22`），按 `batchInterval` 触发（`:190-200`）。
  - 会话门控：`[O]worker/internal/telemetry/run.go:158-164`，距 `telemetry.touch` 超过 `sessionTTL`（10 分钟，`:17`）就不发。
  - 间隔默认 10 分钟、范围 60s–24h：`[O]worker/internal/telemetry/run.go:18-20`、`[O]src/lib/vm/worker-telemetry.mjs:29-31`。
- **我们**
  - 只有入队：`[R]src/server.mjs:538` `telemetry.enqueue([...])`，`[R]src/telemetry/sender.mjs:116-131` 入队即返回。
  - `flush` 的唯一定义处 `[R]src/telemetry/index.mjs:139`，全库**没有任何调用点**（`grep -rn "\.flush(" [R]src/` 只命中 SSE 解析器与这一行导出）。
  - 也没有 `setInterval`、没有 `process.on('exit')`、没有 `beforeExit` 钩子。
- **差异**：即使 `SKYLINK_TELEMETRY=1`，事件也只会堆在内存队列里，到 `maxQueueSize`（2048，`[R]src/telemetry/events.mjs:41`）后丢最旧，**一条都不会发出去**。这解释了为什么第 1、2 项的严重问题目前没有实际后果 —— 但也意味着「遥测层」在生产上是纯死代码。
- **风险**：功能缺失（高）。同时带来一点性能成本：每个请求入队一个事件对象，最长驻留 2048 条。
- **建议**：需要先决定产品口径 —— 要么「明确不发」并把 `telemetry.enqueue` 从热路径摘掉（改为 no-op 或删调用），要么补一个与官方同构的调度器（10 分钟 tick + touch 会话窗口）。在 `device_id`（第 2 项）修好之前，**不要**开启发送。

### 8. `tengu_init` 首发事件

- **官方**：`[O]worker/internal/telemetry/run.go:179-188`，`sentInit` 为 false 时先发一条 `InitEvent`；`[O]worker/internal/telemetry/event.go:69-71` 规定 init 事件**不带** `process`；`:58` 规定 `is_interactive: false`。
- **我们**：`[R]src/telemetry/events.mjs:28` 定义了 `START: 'tengu_init'`，`:325-333` 有 `buildStartEvent`（正确做到 `isInteractive: false` + `attachProcess: false`），但 `[R]src/server.mjs` 从未调用，`[R]src/telemetry/index.mjs:121-123` 的 `start()` 也没人用。
- **差异**：事件序列缺首项。真实客户端每次新会话必有一条 init。
- **风险**：功能缺失（中）。序列特征：只有 `tengu_api_success` 没有 `tengu_init`，与真机不符。
- **建议**：接上 `start()`，在进程启动/首个请求前发一次，并加 `sentInit` 去重（对齐 `run.go:179-188`）。

### 9. GrowthBook `/api/eval`

- **官方**
  - 端点：`[O]worker/internal/telemetry/client.go:21`；client key 常量：`[O]worker/internal/telemetry/client.go:20`、`[O]src/lib/identity/telemetry-env.mjs:9`。
  - 节奏：`[O]worker/internal/telemetry/run.go:21`（6h）、`:202-210`（首次立即）。
  - payload：`[O]worker/internal/telemetry/event.go:75-118`；`attributes` 里 `id`/`deviceID` 取 `telemetryDevice`，`sessionId`、`platform`、`appVersion`、`userType`、`entrypoint`，再条件附加 `email`/`accountUUID`/`organizationUUID`/`subscriptionType`。
  - 改写兜底：`[O]src/lib/identity/telemetry-rewrite.mjs:120-135`。
- **我们**：`[R]src/telemetry/` 下无任何 eval 相关代码（`grep -rn "api/eval\|growthbook" [R]src/` 命中 0）。
- **差异**：整条通道缺失。
- **风险**：功能缺失（中）。官方认为它重要到要单列 6h 定时器。
- **建议**：按 `event.go:75-118` 构造 payload，与 batch 共用 headers/凭据；注意 `attributes.id` 必须与 `device_id` 同源，第 2 项修好后再接。

### 10. body 级改写能力

- **官方**（`[O]src/lib/identity/telemetry-rewrite.mjs`）
  - 分发：`:145-151` `rewriteTelemetryBody`。
  - 事件批改写：`:93-118` `rewriteEventBatch` —— 对每条 event 与 `event_data` 各跑一次 `rewriteIdentityFields`；`env` **整体替换**为 `buildFullEnvJson`（`:95`、`:101-104`）；`process` 重算（`:105-106`）；删 `additional_metadata`/`betas`/`model`（`:107-109`）。
  - 身份字段改写：`:75-91` —— `device_id` 用 `officialDeviceID` 覆盖（`:77-78`）；`email`/`account_uuid` 覆盖；`organization_uuid` 有则覆盖、无则**删除**（`:81-84`）；删 `betas`/`model`/`additional_metadata`/`baseUrl`/`base_url`/`gateway`（`:85-90`）。
  - `user_attributes`（GrowthBook 字符串形态）：`:55-73` —— 覆盖 `device_id`/`deviceID`/`id`/`email`/`accountUUID`/`organizationUUID`/`subscriptionType`，删 `apiBaseUrlHost`。
  - 过程块重算：`:34-53` —— 支持字符串（base64 或 JSON）与对象两种输入，保留 `uptime`，其余全部按 `DEFAULT_PROCESS_RANGES` 重生成（`[O]src/lib/identity/telemetry-env.mjs:14-21`、`:172-188`）。
- **我们**：`[R]src/telemetry/rewrite.mjs` 只有 env 级函数（`rewriteTelemetryEnv:336`、`rewriteEnvironmentVars:410`、`auditRewrittenEnv:441`）。**没有** event/body 级改写入口，也没有 `user_attributes`、`process` 重算、`organization_uuid` 删除这些逻辑。
- **差异**：能力边界不同 —— 官方是「改写别人的 body」，我们是「构造自己的 env」。若将来接入客户端 body 转发，我们缺整套防线。
- **风险**：功能缺失（中）。当前架构不接收客户端 body，所以暂无实害。
- **建议**：若保持「不转发」架构，可以不补；但应在 `rewrite.mjs` 头部注明这一点，避免后续有人误以为已有 body 改写能力而开放转发。

### 11. 4xx 停止 / 重试 / 审计日志

- **官方**
  - 4xx 停止该类上报：`[O]worker/internal/telemetry/run.go:357-360`（`stopOn4xx`），消费点 `:182-184`、`:194-196`、`:204-206`。5xx/网络错误不停止，下轮继续。
  - 审计日志：`[O]worker/internal/telemetry/run.go:280-298`，写 `<config 目录>/telemetry-upload.log`，环形 40 行（`:271`），且 `:273-278` 的 `redactedUploadKeys` 把 `email`/`account_uuid`/`organization_uuid`/`device_id`/`session_id`/`user_id`/`id` 全部抹掉。
  - 错误分类：`[O]worker/internal/telemetry/client.go:147-170`（`ok`/`timeout`/`status`/`socks`/`net`）。
- **我们**
  - `[R]src/telemetry/events.mjs:39-47` 声明了 `maxAttempts: 8`、`baseBackoffDelayMs: 500`、`maxBackoffDelayMs: 30_000`、`batchDelayMs: 100`、`requestTimeoutMs: 10_000` —— 全库无使用点（`grep` 仅命中声明处）。
  - `[R]src/telemetry/sender.mjs:164-175`：失败只累加 `failed` 统计，事件**直接丢弃**，无重试、无停止判断。
  - `[R]src/telemetry/sender.mjs:26` 的 `maxBatchSize` 来自 `events.mjs:40`（200），与官方一致；但 `intervalSec: 300`（`[R]src/telemetry/sender.mjs:28`）与官方 sidecar 的 600s（`[O]worker/internal/telemetry/run.go:18`）不同 —— 客户端侧是 100ms 批窗 + 事件驱动（`[R]docs/cc-hardware-probe.md:831`），不是定时器，三者语义不同不可直接相加。该值同样未被使用。
- **差异**：无重试、无 4xx 停止、无审计日志；声明的常量与实际行为不符（读代码的人会以为有 8 次退避）。
- **风险**：功能缺失（低）。丢掉的是可观测性与投递率，不影响身份一致性。附带一点「代码自述与行为不一致」的维护成本。
- **建议**：要么实现（照 `run.go:357-360` 的停止语义 + 客户端 8 次退避），要么删掉 `events.mjs:42-46` 的常量并在注释里写明「best-effort，不重试」，避免误导。

### 12. 客户端遥测路径拦截

- **官方**：`[O]src/server.mjs:1034-1035` 是所有请求的第一个分支，命中即 `return json(res, 200, telemetryInterceptResponse(p))`；响应体由 `[O]src/lib/identity/telemetry-rewrite.mjs:153-157` 决定 —— `metrics_enabled` 路径返回 `{ metrics_logging_enabled: true }`（`:22-24`），其余返回 `{}`（`:26-28`）。
- **我们**：`[R]src/server.mjs` 无遥测路径分支；未知路径统一 404（`[R]src/server.mjs:717-718`），`grep -rn "event_logging" [R]src/` 仅命中 `env.mjs:29` 的常量定义。
- **差异**：官方「吞掉并回 200」，我们「404」。注意影响面有限：`[R]docs/cc-hardware-probe.md:826-828` 反编译显示客户端的遥测基址来自构造参数、只对 staging 做特判，默认仍是 `https://api.anthropic.com`，因此正常用户的客户端遥测**不经过**我们的网关。这个分支只是「客户端把 BASE_URL 指到网关」时的兜底。
- **风险**：功能缺失（低）。兜底缺失会让这类客户端把事件落盘重试并可能触发 Sentry 错误上报（扩大暴露面）。
- **建议**：照 `[O]src/server.mjs:1034` 加一个最先执行的分支，覆盖 `event_logging/v2/batch`、`api/eval/`、`api/claude_code/metrics`、`metrics_enabled`；`metrics_enabled` 必须返回 `{ metrics_logging_enabled: true }`（返回 `{}` 会让客户端判定 metrics 关闭）。

### 13. Sentry

- **官方**：**不处理**。全库 grep `sentry`（`.mjs`/`.go`/`.rs`/`.ts`）命中 0 次；`[O]src/lib/identity/` 与 `[O]worker/internal/telemetry/` 都没有相关代码。间接影响只有一处：`[O]src/lib/protocol/seed-policy.mjs:43-52`、`:84-95` 在遥测关闭时写 `DISABLE_TELEMETRY=1`，按 `[R]docs/cc-hardware-probe.md:860` 这同时会关掉 Sentry 初始化。
- **我们**：同样**不处理**。注意 `grep -rni "sentry" [R]src/` 会给出 6 条命中，但全部是 `isEntrypoint` 的**子串误匹配**（`i`+`sentry`+`point`），逐条核对后无一条是真实 Sentry 逻辑。间接影响：`[R]src/persona/claude-home.mjs:108-117` 的 `renderClaudeSettings` 只写了 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，没写 `DISABLE_TELEMETRY`。
- **差异**：通道层面无差异（都不碰）。差异在「关断开关的覆盖面」：官方用 `DISABLE_TELEMETRY=1`，我们只用了 `NONESSENTIAL=1`。按逆向报告两者都能关 B/C 通道（`[R]docs/cc-hardware-probe.md:860`），效果等价，但 `DISABLE_TELEMETRY` 是更直接的开关。
- **风险**：无关（结构调整项）。Sentry 是客户端直连 `o1158394.ingest.us.sentry.io`（`[R]docs/cc-hardware-probe.md:725`），不经过网关，我们无拦截点也无改写点。**真正的风险是 `host_name_redacted` = `machineID` 前 12 位**（`[R]docs/cc-hardware-probe.md:479`），这只能靠 `~/.claude.json` 的 `machineID` 与遥测失败批次一起换掉来防，属 persona 层职责，不在遥测层。
- **建议**：无需在遥测层加 Sentry 逻辑。若要加固，把 `DISABLE_TELEMETRY=1` 一并写进 `renderClaudeSettings` 的 `env`，与官方 `seed-policy.mjs:43-52` 对齐；并在 `CLAUDE_HOME_PURGE` 里确认已含 `.claude/telemetry`（已含，见第 14 项）。

### 14. `1p_failed_events.*.json` 失败批次落盘重试

- **官方**
  - **Go sidecar 不做落盘重试**：`[O]worker/internal/telemetry/run.go` 全文无失败队列持久化，失败只写 `telemetry-upload.log`（`:280-298`）。
  - **Node 层不处理**：`grep -rn "1p_failed_events\|failed_events" [O]` 命中 0 次，官方网关既不读也不清这个目录。
  - 落盘重试是**客户端自己**的行为（`[R]docs/cc-hardware-probe.md:842-851`：`1p_failed_events.<session>.<run>.json` NDJSON、退出 flush、下次启动 `retryPreviousBatches()`），官方选择「让它自然发生」。
- **我们**
  - 遥测层不做：`[R]src/telemetry/sender.mjs:164-175` 失败即丢，无落盘。
  - persona 层有清理：`[R]src/persona/claude-home.mjs:119-134` 的 `CLAUDE_HOME_PURGE` 含 `.claude/telemetry`，注释（`:119-123`）明确写了「不清就会把旧设备的失败事件带到新身份下 —— 这是直接的关联证据」；`:139-143` 生成 `rm -rf` 脚本。
- **差异**：双方都**不**在服务端做失败落盘（一致，且这是对的：服务端落盘会把真实 `device_id` 写进我们自己的磁盘）。我们额外有换机清理清单，官方没有 —— 这一项我们做得比官方完整。
- **风险**：已对齐（略优）。唯一残留风险来自客户端侧：`[R]src/persona/claude-home.mjs:125-134` 的清理只在「换设备」时跑，若同一槽位长期复用，旧批次仍带旧 `device_id`；这是设计意图，不是缺陷。
- **建议**：保持。可在 `CLAUDE_HOME_PURGE` 注释里补一条「服务端**不得**引入失败落盘」，防止后续有人为了「提升投递率」把真实身份写到网关磁盘上。

### 15. 信封 / ID / 时间戳 / process 编码

- **官方**
  - 信封：`[O]worker/internal/telemetry/event.go:17-24`，`{ event_type, event_data }`，`event_type` 恒 `ClaudeCodeInternalEvent`（`:29`）。
  - event_id：`:333-341`，16 字节随机 + v4 位标记，格式化 8-4-4-4-12。
  - 时间戳：`:56`，`2006-01-02T15:04:05.000Z`（毫秒三位 UTC）。
  - process：`:279-282` base64(JSON)，字段 `uptime`/`rss`/`heapTotal`/`heapUsed`/`external`/`arrayBuffers`/`constrainedMemory`/`cpuUsage`/`cpuPercent`（`:284-296`）。
- **我们**
  - 信封与类型：`[R]src/telemetry/env.mjs:33`、`[R]src/telemetry/events.mjs:317`。
  - event_id：`[R]src/telemetry/events.mjs:104-106`（`crypto.randomUUID()`）+ `:114-116` 校验。
  - 时间戳：`[R]src/telemetry/events.mjs:136-140`（`toISOString()`）+ `:101` 正则。
  - process：`[R]src/telemetry/events.mjs:154-191`，字段集合与官方逐项一致，含 `cpuUsage`/`cpuPercent`。
- **差异**：无实质差异。两处细微出入：官方 `cpuPercent` 不做 `toFixed(4)`（`event.go:294`），我们做了（`events.mjs:183`）；官方 `process` 块不含 `cpuWindowMs`，我们也不含 —— 但实测 2.1.310 客户端**有** `cpuWindowMs`（`[R]docs/cc-hardware-probe.md:800`），属版本差异，不建议现在补。
- **风险**：已对齐。
- **建议**：保持。`toFixed(4)` 可去掉以严格对齐。

### 16. 硬件字段剔除

- **官方**
  - Node 侧无硬件字段（`[O]src/lib/identity/telemetry-env.mjs:23-57` 的键表里没有）。
  - Go 侧显式丢弃 11 项：`[O]worker/internal/telemetry/event.go:229-233`（`cpu_model`、`cpu_cores`、`memory_bytes`、`root_disk`、`mac`、`dmi_manufacturer`、`dmi_product`、`dmi_version`、`dmi_family`、`dmi_serial`、`dmi_uuid`），注释写明「older worker.json files that still carry it must not upload it」。
  - 额外还有一份「禁用串」自检：`:348-374`（`ContainsForbidden`，含 `hostname`/`machine-id`/`kernel_release`/`/.dockerenv`/`kubernetes`/`k8s`/`cwd`/`codespaces` 等 17 个）。
- **我们**
  - `[R]src/telemetry/env.mjs:136-148` `HARDWARE_FIELD_NAMES`（同样 11 项，逐字一致）；`:354-363` `stripHardwareFields`；`:335` 在构造出口无条件调用。
  - 自检：`[R]src/telemetry/rewrite.mjs:441-460` `auditRewrittenEnv`（查硬件键、容器痕迹、部署取值、CI 布尔位）。
- **差异**：无。键表逐字一致，且我们多一层 `auditRewrittenEnv` 自检。
- **风险**：已对齐。
- **建议**：保持。可选：把官方的 `forbiddenNeedles`（`event.go:358-374`）搬到 `auditRewrittenEnv`，覆盖 `cwd`/`codespaces`/`git_remote` 这几个我们目前没查的串。

## 附：修复优先级

**P0（不开就不安全，开了必被抓）**
1. 第 2 项 `device_id`：无真实身份 → 整块禁用；禁止每条随机。
2. 第 3 项 env 归一接线：`deployment_environment` / `linux_kernel` 必须真正生效。
3. 第 1 项端点：补 `v2`。

**P1（字段级指纹）**
4. 第 5 项 env 集合：加 `shell`，去 `node_version` + `is_running_with_bun`。
5. 第 4 项 `model`：停止上报。
6. 第 6 项请求头：补 `x-app` + `x-stainless-*`，无 token 不发。

**P2（行为完整性）**
7. 第 7 项调度：先决定「发不发」；不发就把热路径调用摘掉。
8. 第 8 项 `tengu_init`。
9. 第 12 项路径拦截（fake 200 + `metrics_logging_enabled`）。

**P3（可选）**
10. 第 9 项 GrowthBook eval。
11. 第 11 项 4xx 停止与审计日志。
12. 第 10 项 body 改写能力（仅当架构改为转发时）。
