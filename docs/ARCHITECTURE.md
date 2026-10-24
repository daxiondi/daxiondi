# ARCHITECTURE —— 代码组织与扩展点

面向接手维护的工程师。读完这份文档应该能做到：

- 知道 23 个模块谁依赖谁、层次在哪
- 知道要加一个 beta / 一个机型 / 一个新平台 / 一个上游 URL 时，具体改哪个文件的哪一段
- 知道哪些约束不能破，破了会出现什么症状
- 知道新功能该往哪套测试里加断言

配套文档：接入、配置、路由、凭据格式看 `INTEGRATION.md`。

**本文对应的代码快照**：`src/` 下 23 个 `.mjs`、合计 10829 行时的状态（含 `persona/`）。`config.mjs` / `server.mjs` / `codex*` / `prompt-profiles.mjs` 仍在并行改动，若与本文不符，以代码为准。

---

## 1. 模块依赖图

### 1.1 层次

```text
                        ┌──────────────┐          ┌───────────────────┐
                        │  server.mjs  │          │ persona/cli.mjs   │
                        │  （HTTP 入口）│          │ （命令行入口）     │
                        └──────┬───────┘          └─────────┬─────────┘
              ┌────────────────┼────────────────┬───────────┘
              ▼                ▼                ▼
      ┌──────────────┐ ┌──────────────┐ ┌────────────┐  ┌──────────────────┐
      │ scheduler.mjs│ │system-layout │ │  cch.mjs   │  │ persona/index.mjs│
      └──────┬───────┘ │   .mjs       │ └────────────┘  └────────┬─────────┘
             │         └──────────────┘        ▲                │
             ▼                                 │        ┌───────┼───────┐
      ┌──────────────┐                  ┌──────┴───────┐│       ▼       ▼
      │  frames.mjs  │                  │ identity.mjs ││ ┌──────────┐ ┌──────────┐
      └──────┬───────┘                  └──────────────┘│ │macos.mjs │ │windows.mjs│
             ▼                                 ▲       │ └────┬─────┘ └────┬─────┘
      ┌──────────────┐                         │       │      │            │
      │ node:child_  │                  ┌──────┴───────┐│ ┌────▼────────────▼─────┐
      │ process      │                  │  betas.mjs   ││ │      linux.mjs        │
      └──────────────┘                  └──────────────┘│ └────────┬──────────────┘
                                                         │          ▼
                                                         │  ┌──────────────┐
                                                         │  │  derive.mjs  │
                                                         │  └──────────────┘
                                                         │
      ┌──────────────┐  ┌──────────────┐  ┌─────────────┴────┐
      │  config.mjs  │  │   sse.mjs    │  │    codex.mjs     │
      │   （叶子）    │  │   （叶子）    │  │  （独立分支）     │
      └──────────────┘  └──────────────┘  └──────────────────┘
```

图里每个模块的具体 import 关系见 §1.2。`server.mjs` 与 `persona/cli.mjs` 是两个互不相干的入口：前者导出 HTTP 服务，后者只生成身份文件，`server.mjs` 不 import `persona/` 下任何文件。

### 1.2 精确的 import 关系

| 模块 | import 的 src 模块 | import 的 node 内置 |
|---|---|---|
| `betas.mjs` | 无（叶子） | 无 |
| `cch.mjs` | 无（叶子） | 无 |
| `identity.mjs` | 无（叶子） | 无 |
| `sse.mjs` | 无（叶子；用了全局 `crypto.randomUUID` 但没显式 import，见 §5.7） | 无 |
| `system-layout.mjs` | 无（叶子） | `node:crypto` |
| `codex-convert.mjs` | 无（叶子） | `node:crypto` |
| `outbound-shape.mjs` | 无（叶子） | 无 |
| `frames.mjs` | 无（叶子） | `node:readline`、`node:module`（间接 `node:child_process`、`node:crypto`） |
| `persona/derive.mjs` | 无（叶子） | `node:crypto` |
| `codex.mjs` | `codex-convert.mjs` | `node:crypto`、`node:zlib` |
| `config.mjs` | `codex.mjs`（复用 `DEFAULT_CHATGPT_BASE` 作 `codex_base_url` 缺省值） | 无 |
| `codex-credentials.mjs` | `codex.mjs` | `node:fs`、`node:crypto` |
| `codex-images.mjs` | `codex.mjs` | `node:crypto`（`node:fs` 仅测试路径） |
| `cache-breakpoints.mjs` | `system-layout.mjs` | 无 |
| `prompt-profiles.mjs` | `system-layout.mjs`、`identity.mjs` | 无 |
| `scheduler.mjs` | `frames.mjs` | `node:crypto` |
| `codex-server.mjs` | `codex.mjs`、`codex-credentials.mjs`、`codex-convert.mjs`、`codex-images.mjs`、`config.mjs` | `node:crypto` |
| `server.mjs` | `config.mjs`、`sse.mjs`、`scheduler.mjs`、`cch.mjs`、`system-layout.mjs`、`cache-breakpoints.mjs`、`betas.mjs`、`identity.mjs`、`codex-server.mjs` | `node:http`、`node:fs`、`node:crypto` |
| `persona/macos.mjs` | `derive.mjs`（`deriveSerial`、`deriveUuidUpper`、`deriveMac`） | 无 |
| `persona/windows.mjs` | `derive.mjs`（`deriveSerial`、`deriveUuidUpper`、`deriveMac`、`deriveHex32`） | 无 |
| `persona/linux.mjs` | `derive.mjs`（`deriveSerial`、`deriveUuid`、`deriveMac`、`deriveHex32`） | 无 |
| `persona/index.mjs` | `macos.mjs`、`windows.mjs`、`linux.mjs` | 无 |
| `persona/cli.mjs` | `persona/index.mjs` | `node:fs`、`node:path` |

> `macos.mjs` 里出现的 `import json` / `import pathlib` 是嵌在模板字符串里的 Python 脚本片段（渲染 `persona_volume.py` 用），不是 JS import，统计依赖时不要算进去。

关键事实：

- **15 个模块有内部依赖**：`codex` → 1；`config` → 1；`codex-credentials` → 1；`codex-images` → 1；`cache-breakpoints` → 1；`prompt-profiles` → 2；`scheduler` → 1；`codex-server` → 5；`server` → 9；`persona/{macos,windows,linux}` → 各 1；`persona/index` → 3；`persona/cli` → 1
- `server.mjs` 是最大的多依赖汇聚点（9 个），`codex-server.mjs` 次之（5 个）
- 叶子模块共 9 个（零内部依赖）：`betas` / `cch` / `identity` / `sse` / `system-layout` / `codex-convert` / `outbound-shape` / `frames` / `persona/derive`
- `config.mjs` **不是**叶子：它从 `codex.mjs` 取 `DEFAULT_CHATGPT_BASE`。这条依赖是单向的（`codex.mjs` 不回头引 `config.mjs`）
- `codex.mjs` 也不是叶子：它从 `codex-convert.mjs` 取 Chat ⇄ Responses 的转换函数
- 没有任何环路

### 1.3 各模块的接线状态

| 模块 | 被 HTTP 层用到 | 谁在用 |
|---|---|---|
| `config.mjs` / `sse.mjs` / `scheduler.mjs` / `cch.mjs` / `system-layout.mjs` / `cache-breakpoints.mjs` / `identity.mjs` | ✅ `server.mjs` 直接 import | 两种模式的主链路 |
| `betas.mjs` | ✅ 仅 `BETA.EXTENDED_CACHE_TTL` 一个常量 | `server.mjs` 在断点带 `ttl:'1h'` 时补这个 beta；`withRequestProtocolBetas` 仍只有测试在用 |
| `codex.mjs` / `codex-credentials.mjs` / `codex-convert.mjs` / `codex-images.mjs` / `codex-server.mjs` | ✅ `server.mjs` 挂载 `createCodexHandler` | 仅在 `--codex` / `--codex-credential` / `CODEX_CREDENTIAL_PATH` 命中时实例化 |
| `prompt-profiles.mjs` | ❌ 尚未接到 `server.mjs` | 提示词档位（`official_full` / `official_303`）的组装逻辑，目前由测试与后续接线使用 |
| `outbound-shape.mjs` | ❌ 没人 | 出站结构的脱敏骨架 + 差异比对，供排查与回归使用 |
| `persona/*` | ❌ 没人 | `persona/cli.mjs` 与 `test/selfcheck.mjs` |
| `identity.mjs` 的大部分 | `server.mjs` 只 import 了 `mergeOfficialExtraBetas` | 其余导出（指纹头、TTL、错误映射、stop_reason）由 `prompt-profiles.mjs` 与测试使用 |
| `sse.mjs` 的 `streamMetaFromHeaders` / `mergeUsage` | ❌ 没人 | 只有测试在用 |

含义：`persona/*` 与 `outbound-shape.mjs` 是**契约层 + 可验证的纯函数库**，没有接到任何 HTTP 路由。`prompt-profiles.mjs` 已经把 `system-layout` 与 `identity` 串起来，但还没接到出站链路。`codex/*` 已完整接到 HTTP 面（`/v1/responses`、`/v1/chat/completions`、`/v1/models`、`/v1/images/*`、`/codex/healthz`），只在显式启用 Codex 通道时挂载。

---

## 2. 每个模块的职责边界

| 模块 | 管什么 | 不管什么 |
|---|---|---|
| `config.mjs` | `WorkerConfig` 缺省值（28 个顶层键）、启动期校验顺序与文案、`resolveClaudeBin` 的三级优先级、`validateCodexConfig`、`Envelope` 8 字段解析、统一错误体 `workerError()`、`/internal/health` 响应骨架 | 不做 IO、不读文件、不读环境变量、不知道 HTTP 存在 |
| `frames.mjs` | stdin 帧构造（`job_start` / `cancel` / `ping`）、stdout 帧分类（7 种）、snake_case→camelCase 唯一转换点、`host_ready` 五项校验、`CliHost` 子进程生命周期、`spawnError` 错误归一、`metadata.user_id` 构造、`mergeWireBody` 字段所有权 | 不决定用哪个 slot（那是 scheduler）、不决定 system 布局、不管 HTTP 编码 |
| `scheduler.mjs` | 槽位池、挑槽四级顺序、粘性会话 pin（24h TTL）、job 生命周期、帧分派、并发上限 20 | 不写帧（委托 `CliHost`）、不解析帧语义（`frames.mjs` 已做）、不重试、不做超时回收 |
| `sse.mjs` | 把「一段文本 + 元数据」序列化成 Anthropic SSE 字节序列或非流式 JSON 体、响应头、trailer 元数据合并、`usage` 深合并 | 不知道内容从哪来、不判断业务语义、不处理背压、不决定要不要 `kin.done`（由 `emitKinDone` 控制） |
| `system-layout.mjs` | 三种布局（`zero` / `identity` / `stock`）的 system 块组装、billing header 规整、时区块、`wireSystemBlocks` 规范化、从已有 system 里分离 billing / leftover | 不管 cch 数值（只写占位符 `00000`）、不管 betas、不调 hash |
| `betas.mjs` | beta 常量表（26 个）、`withRequestProtocolBetas` 的动态追加规则、模型名归一化、`joinBetas` | 不管顺序（顺序是 `identity.mjs` 的 `mergeOfficialExtraBetas`）、不发请求、不知道 HTTP 头 |
| `identity.mjs` | stainless 头、UA、`assembleApiMetadata` 三级降级、官方 betas 排序、cache TTL 解析、cache marker 增删、上游错误映射、`stop_reason` 映射、h1/h2 选择 | 不实际发请求、不写 system、不碰 cch、不碰 persona |
| `cch.mjs` | xxHash64 实现、cch 计算（低 20 bit → 5 位 hex）、`projectBillingFields` 文本投影、`sealClaudeCodeCch` 封盖 | 不决定要不要封（`enabled` / `seal` 由调用方传）、不生成 billing header、不做 IO |
| `codex.mjs` | Codex 凭据解析与字段类型校验、Envelope 规范化、上游 URL 拼装、出站头、body 改写、zstd 压缩、传输选择、账号调度（亲和/冷却/RPM）、`CodexUpstream` 收发、`executeCodexRequest` 编排 | 不管 token 刷新（在 `codex-credentials.mjs`）、不决定 HTTP 路由、不写响应格式 |
| `codex-credentials.mjs` | 单账号/多账号两种凭据形态归一、到期时间解析（秒/毫秒/ISO）、账号状态机、`CredentialManager`（刷新 + 回写）、启动期告警 | 不发请求、不做调度、不碰 HTTP |
| `codex-convert.mjs` | Chat Completions ⇄ Responses 双向转换：消息、工具、工具调用、`response_format`、usage、finish_reason、SSE 帧翻译 | 不选账号、不发请求、不判断路由 |
| `codex-server.mjs` | Codex 通道的 HTTP 面：6 条路由、请求体读取、上游错误翻译、SSE 下发、`/codex/healthz` 健康判定 | 不做协议转换（委托 `codex-convert`）、不做调度（委托 `AccountScheduler`）、不做生图协议（委托 `codex-images`） |
| `codex-images.mjs` | 生图通道：`/v1/images/generations`、`/v1/images/edits` 的请求归一（JSON 与 multipart 双形态）、模型白名单、plan 判定、上游 images 端点与头 | 不选账号（复用 `AccountScheduler`）、不做 Responses 协议转换 |
| `cache-breakpoints.mjs` | `messages` 的 prompt cache 断点布局：算位置、落到 content block、出站前一致性检查（`auditCacheBreakpoints`） | 不决定 system 断点、不碰 cch、不写 betas（由调用方补） |
| `prompt-profiles.mjs` | 提示词档位注册表（`official_full` / `official_303`）、按模型选结构、system 与 messages 的一次性组装、Environment 段与标记计数 | 不封 cch、不发请求、不管 HTTP |
| `outbound-shape.mjs` | 把出站 body 归约成脱敏结构骨架、两份骨架的差异比对 | 不带任何实际文本、不做语义判断 |
| `persona/derive.mjs` | 从 `vm_id` 确定性派生 hex32 / UUID / 大写 UUID / 序列号 / MAC / 候选挑选 | 不知道任何平台语义、不定义机型、不做校验 |
| `persona/macos.mjs` | macOS persona 骨架（MacPro7,1）、APFS 容量预算、`uname`/`sw_vers`/`scutil`/`system_profiler`/`ioreg`/`df` 视图、机型↔主板对照 | 不管其它平台、不写真实文件系统、不做命令行解析 |
| `persona/windows.mjs` | Windows persona 骨架（OptiPlex 7090）、`systeminfo`/`wmic`/PowerShell/`reg query` 视图、OEM 序列号规则、NetBIOS 约束 | 同上 |
| `persona/linux.mjs` | Linux persona 骨架（PowerEdge R750）、DMI/`hostnamectl`/`lscpu`/`lsblk`/`df` 视图、云厂商 hostname 规则、machine-id 双文件一致性 | 同上 |
| `persona/index.mjs` | 平台注册表 `REGISTRY`、`buildPersona` 编排（defaults → merge → normalize → 两道校验）、`renderViews`、`crossCheckViews`、`auditPersona`、`assertPersonaConsistent` | 不定义任何平台字段、不做 IO |
| `persona/cli.mjs` | 参数解析、写盘、退出码 | 不构造身份逻辑（全委托 `index.mjs`） |
| `server.mjs` | 两个 `http.createServer` 工厂、路由分发、请求体读取与大小限制、参数解析、配置加载、进程启动、`prepareOutbound` 三步串联、Codex 通道挂载 | 不放业务逻辑（都委托出去了）、不做鉴权中间件抽象、不做日志框架 |

一句话记忆法：

```text
config        = 谁必填、缺省多少
frames        = 跟 CLI 说什么话
scheduler     = 谁先说话
sse           = 怎么把话说得像 Anthropic
system-layout = system 块长什么样
betas         = 这次要带哪些 beta
cch           = 指纹算多少
identity      = 头、TTL、错误码、stop_reason
codex         = 第二条通道的协议、认证与调度核心
codex-server  = 把 codex 挂到 HTTP 面上
persona/*     = 机器身份怎么派生、怎么渲染成各平台视图
server        = 把上面全部串起来（不含 persona）
```

---

## 3. 数据流

以模式 A 的 `POST /v1/messages` 为例，逐段标出「谁做了什么变换」。

```text
① 网络字节
   │  POST /v1/messages  body = {"model":"...","messages":[...],"stream":true}
   ▼
② server.mjs  readBody(req, 64 MiB)
   │  变换：chunk[] → Buffer.concat → utf8 string
   │  超限：reject({code:'too_large'}) → req.destroy() → 回 400
   ▼
③ server.mjs  JSON.parse
   │  变换：string → object
   │  失败：回 400，空体
   ▼
④ server.mjs  字段检查
   │  payload.model 缺失 → 422 + 固定文案
   │  sessionId = req.headers['x-session-id'] || randomUUID()
   ▼
⑤ scheduler.mjs  submit({sessionId, model, request: payload, onEvent: null})
   │  变换：sessionId → slot
   │    先查 pins（同 session 且 idle）→ 再走 pickSlotByModel 四级
   │  slot.phase: 'idle' → 'running'
   │  产出：{jobId, slot, done: Promise}
   │  失败：返回 null → 503 kernel_unavailable
   ▼
⑥ frames.mjs  jobStartFrame({slot, jobId, request, requestContext})
   │  变换：{slot:'s00', jobId:'...', request: payload}
   │      → {type:'job_start', job_id, slot_id, request}
   ▼
⑦ frames.mjs  CliHost.write(frame)
   │  变换：object → `${JSON.stringify(frame)}\n` → child.stdin
   ▼
   [ CLI 子进程 ]

   同时（不阻塞 ⑤⑥⑦）：

⑧ server.mjs  prepareOutbound(payload)
   │  ⑧a  system 布局
   │      Array.length >= 4 → wireSystemBlocks()
   │          变换：每个 block → {type:'text', text, cache_control?}
   │                billing 行 cch 值 → '00000'
   │      否则 systemLayout 为真且 != 'stock' → layoutSystemBlocks()
   │          （注意：模式 A 实际传的是 undefined，此分支不触发，见 `INTEGRATION.md` §8.5）
   │  ⑧b  betas 合并
   │      变换：[...(body.betas), ...headerBetas] → mergeOfficialExtraBetas()
   │           两段输出：先按官方清单定义序出命中项，再按输入序追加剩余
   │  ⑧c  缓存断点（cache-breakpoints.mjs）
   │      变换：applyCacheBreakpoints(body, {ttl})
   │           system 固定 2 点（身份块 + 主提示词）
   │           messages 在消息数足够时 2 点（最后一条 user + 上一条 user）
   │           总数不超过 MAX_CACHE_MARKERS(4)
   │      联动：若断点用了 ttl:'1h'（usesExtendedTtl）
   │           且 betas 里没有 BETA.EXTENDED_CACHE_TTL → 补上（已有则不动）
   │  ⑧d  cch 封盖
   │      变换：normalizeBillingCch 把 cch 归 00000
   │           → projectBillingFields 文本投影
   │              （清 model 值 / 切 fallbacks / 切 fallback_credit_token /
   │                切数字型 max_tokens）
   │           → xxh64(seed = CCH_XXH64_SEED) 取低 20 位（掩码 1048575）
   │              （种子常量见 cch.mjs，十进制 5577024349156291176）
   │           → 5 位小写 hex 写回 billing 行
   ▼
⑨ sse.mjs  messageStream(ctx) / messageBody(ctx)
   │  变换：{id, model, text, inputTokens, outputTokens, slot, sessionId, generation}
   │      → SSE 事件序列 或 JSON 体
   ▼
⑩ http res
   │  头：x-request-id / x-session-id / x-slot / x-generation
   ▼
   客户端
```

### 3.1 回程（CLI → 客户端）

```text
CLI stdout 每行一帧
  ▼ readline（crlfDelay: Infinity），非法行直接跳过
JSON.parse → classifyStdoutFrame（唯一 snake_case → camelCase 转换点）
  ▼
  ├─ host_ready   → resolve CliHost.ready；同时交给全局 onFrame
  │                 （五项校验在 validateHostReady，可调但当前未接）
  ├─ stream_event → scheduler.jobs.get(jobId)?.onEvent?.(event)
  │                 ⚠️ 模式 A 传的 onEvent 是 null，事件在此处丢弃
  ├─ job_done     → _release(slotId) → phase='idle'；resolve(job.done)
  ├─ job_error    → 同上
  ├─ cancel_ack   → 同上
  └─ pong / unknown / slot_ready → 走全局 onEvent
```

**这是当前最重要的一个缺口**：第 ⑨ 步的 `ctx.text` 是本地拼的 mock 串，不是 `stream_event` 累积出来的。接的时候要改的是 `submit()` 的 `onEvent` 回调 + `sse.mjs` 的消费方式，`frames.mjs` 不用动。

### 3.2 模式 B 的差异点

| 环节 | 模式 A | 模式 B |
|---|---|---|
| 鉴权 | 无 | `x-internal-token` 必须匹配 |
| 入站结构 | 裸 Anthropic body | `Envelope` 包一层（`body` 内才是 Anthropic body） |
| 凭据检查 | 无 | `credentialState()` 必须非 `missing` / `expired*` |
| sessionId 来源 | `x-session-id` 头 | `metadata.user_id` 里的 `session_id` |
| 槽位数 | 20 | 4 |
| 出站预处理 | `prepareOutbound` | **不调用**（原样转发） |
| 请求体上限 | 硬编码 64 MiB | `cfg.max_request_bytes` |

### 3.3 Codex 通道的数据流

Codex 通道已经接到 HTTP 面，入口是 `src/codex-server.mjs` 的 `createCodexHandler(opts)`；`server.mjs` 在 `--codex` / `--codex-credential` / `CODEX_CREDENTIAL_PATH` 任一命中时实例化它，并在公共 server 的最前面给这组路由优先匹配。

```text
客户端
  │  POST /v1/responses            （Responses 原生格式，直接透传）
  │  POST /v1/chat/completions     （Chat 格式，双向转换）
  ▼
① codex-server.mjs  readRequestBody(req, maxBodyBytes)     超限 → 400
② 分支：
     /v1/responses        → body 原样用（不做字段改写）
     /v1/chat/completions → chatToResponses(chat) → {body, dropped}
                            dropped 里的字段名记进日志，不静默吞
③ 组 envelope：stream 恒为 true（上游硬性要求），session 由 pickSessionId 决定
④ executeCodexRequest({upstream, scheduler, envelope, ...})
     ④a AccountScheduler.select({sessionId}) → session 亲和 → thread 亲和 → 首个可用
     ④b buildOutboundBody  → store=false、stream=true、删 12 个身份键、按需注 client_metadata
     ④c buildOutboundHeaders → authorization / content-encoding: zstd / accept: text/event-stream
                                / session-id / x-codex-turn-id（每次新 UUID）/ routing-hint
     ④d compressBody(zstd) → fetch → 失败按状态码分派（401 换号、429/5xx 冷却换号、其他 4xx 直接返回）
⑤ 上游 200：
     codex.mjs  CodexUpstream.iterEvents(stream) 逐帧解析 event:/data:，[DONE] 结束
⑥ 回写：
     /v1/responses         → wantsStream ? 原样转 SSE : collectResponsesStream 聚合后回 JSON
     /v1/chat/completions  → responsesEventsToChatSse / responsesToChatCompletion
```

组织要点：`codex.mjs` 里每一步都是**独立纯函数**，`normalizeEnvelope` / `parseCredentialFile` / `buildOutboundBody` / `buildOutboundHeaders` / `chooseTransport` / `compressBody` 之间没有状态共享；有状态的只有 `AccountScheduler`（调度）与 `CodexUpstream`（收发，无每请求状态）。协议转换全部收在 `codex-convert.mjs`，HTTP 语义全部收在 `codex-server.mjs`。要改传输细节就去 `codex.mjs`，要改对外格式就去 `codex-convert.mjs`，不要在 `codex-server.mjs` 里直接拼上游请求。

客户端断开时会 `res.on('close', () => ctrl.abort())` 中止上游请求，避免上游继续计费。

### 3.4 persona 的数据流

```text
buildPersona({platform, vmId, overrides})
  │
  ├─① platformDefaults(platform)        取该平台 DEFAULTS 的 structuredClone
  ├─② deepMerge(base, overrides)        递归深合并；数组整体替换，不逐元素合并
  ├─③ 写入 platform / vm_id             这两个字段由调用方决定，优先于 overrides
  ├─④ impl.normalize(persona)           派生：序列号、UUID、MAC、machine_id、
  │                                      并对齐内部一致性（如 ram_bytes ← DIMM 之和）
  ├─⑤ impl.validate(persona)            内部约束：字段之间是否自相矛盾
  ├─⑥ impl.render(persona)              → {files, commands} 全部视图
  ├─⑦ impl.validateViews({persona, ...}) 跨视图：同一事实在各视图里是否字面一致
  └─⑧ ⑤+⑦ 的 issues 合并；任一非空 → throw（带 code 与说明）  否则 Object.freeze

renderViews(persona)   → {files: 相对路径→内容, commands: 命令名→stdout}
crossCheckViews(persona) → 只跑第 ⑦ 步，返回 Issue[]
auditPersona(persona)  → Array<{code, text, severity:'error'|'warn'}>
                          error = validate + validateViews
                          warn  = impl.warnings（如 MAC 是本地管理地址）
```

三个平台的视图规模（`vmId = 'vm-1'`，用 `renderViews` 数出来）：

| 平台 | files | commands | audit |
|---|---|---|---|
| `macos` | 5 | 28 | 0 |
| `windows` | 2 | 17 | 0 |
| `linux` | 22 | 28 | 0 |

`macos` 的 5 个文件：`etc/hostname`、`etc/macos_persona.json`、`System/Library/CoreServices/SystemVersion.plist`、`System/Volumes/Data/.persona-volume`、`usr/local/lib/persona_volume.py`。

`macos` 的 28 条命令覆盖 6 类接口：`uname`（6 条：`uname` 与 `-a/-n/-m/-s/-r`）、`sw_vers`（4 条）、`scutil`（3 条：`ComputerName` / `LocalHostName` / `HostName`）、`sysctl`（7 条）、`system_profiler`（2 条）、`ioreg`（2 条），其余为 `nvram -p`、`df -h`、`diskutil list`、`mount`。

`windows` 的 2 个文件：`etc/persona.json`、`Windows/System32/config/persona_report.txt`；17 条命令覆盖 `hostname` / `echo %COMPUTERNAME%` / `systeminfo` / `wmic`（7 条）/ `powershell Get-CimInstance`（3 条）/ `reg query`（3 条）/ `getmac`。

`linux` 的 22 个文件：`sys/class/dmi/id/*`（16 个 DMI 字段）+ `etc/machine-id`、`var/lib/dbus/machine-id`、`etc/hostname`、`etc/hosts`、`etc/os-release`、`etc/persona.json`；28 条命令覆盖 `uname`（5 条）、`hostnamectl`、`hostname`、`lscpu`、`free`、`lsblk`、`df -h`、`ip link show`，以及 16 条 `cat /sys/class/dmi/id/*`。

关键设计：**一份 persona 对象 → 渲染出所有视图，视图不存副本**。真机上同一事实在不同接口暴露时必须一致；如果 `uname -n`、`scutil --get ComputerName`、`/etc/hostname` 各存一份字符串，迟早漂移，而漂移就是最容易被交叉验证发现的破绽。`validateViews` 就是这条设计的强制检查，详见 §5.8。

---

## 4. 扩展点

### 4.1 加一个新的 Anthropic beta

两个改动点，都在 `src/betas.mjs`。

**第一步：加常量**

```js
// src/betas.mjs  BETA 常量表
export const BETA = Object.freeze({
  // ...
  PER_TURN_CONTROL: 'per-turn-control-2026-07-01',
  MY_NEW_BETA: 'my-new-capability-2026-09-01',   // ← 新增
})
```

**第二步：在 `withRequestProtocolBetas` 里加触发条件**

```js
// src/betas.mjs  withRequestProtocolBetas(tokens, body)
export function withRequestProtocolBetas(tokens = [], body = {}) {
  const betas = [...new Set(tokens.filter(Boolean))]
  const add = (t) => { if (!betas.includes(t)) betas.push(t) }
  const model = normalizeModelId(body.model)

  // ... 现有规则 ...

  // ── 新增：按你需要的条件追加 ──
  if (body.my_new_field != null) add(BETA.MY_NEW_BETA)          // 顶层字段触发
  if (body.output_config?.my_flag) add(BETA.MY_NEW_BETA)        // 嵌套字段触发
  if (MY_MODELS.has(model)) add(BETA.MY_NEW_BETA)               // 模型白名单触发
  if (Array.isArray(body.tools) && body.tools.some((t) => t?.my_flag)) {
    add(BETA.MY_NEW_BETA)                                       // 逐 tool 触发
  }

  return betas
}
```

触发条件的四种现有范式，按需要挑一个套用：

| 范式 | 现有例子 | 代码位置 |
|---|---|---|
| 模型名白名单 | `PER_TURN_CONTROL` | `PER_TURN_MODELS` Set + `if (PER_TURN_MODELS.has(model))` |
| 顶层字段存在 | `CONTEXT_MANAGEMENT` | `if (body.context_management) add(...)` |
| 嵌套字段存在 | `EFFORT` | `if (body.output_config?.effort != null) add(...)` |
| 逐数组元素扫描 | `STRUCTURED_OUTPUTS` / `ADVANCED_TOOL_USE` | `for (const tool of body.tools) { ... }` |

**还要考虑的两处**

1. **要不要进官方清单**：如果这个 beta 属于「官方每次都带」，加到 `src/identity.mjs` 的 `OFFICIAL_MESSAGE_BETAS` 数组里，它会被 `mergeOfficialExtraBetas` 排到前面。如果只是「条件触发」，**不要**加进那个数组。
2. **要不要进模仿基线**：如果是 `claudeCodeMimicryBetas()` 的 7 个之一（改变基线行为），改 `src/betas.mjs` 的那个函数。

**改完加断言到哪**：`test/selfcheck.mjs` 第 21 节（`// 21. Beta 动态注入`，16 条）。断言写法：

```js
eq('我的新 beta 触发', withRequestProtocolBetas([], { model: 'x', my_new_field: 1 }).includes(BETA.MY_NEW_BETA), true)
eq('我的新 beta 不误触发', withRequestProtocolBetas([], { model: 'x' }).includes(BETA.MY_NEW_BETA), false)
eq('我的新 beta 不重复', withRequestProtocolBetas([BETA.MY_NEW_BETA], { model: 'x', my_new_field: 1 })
   .filter((b) => b === BETA.MY_NEW_BETA).length, 1)
```

### 4.2 支持新的硬件机型

机型信息分两层，先分清要改哪层。

#### 层 A：换一个 `model_identifier`（最简单）

如果新机型与现有机型的平台其他字段都兼容，只换型号字符串即可，**不改代码**：

```js
buildPersona({
  platform: 'macos',
  vmId: 'vm-7',
  overrides: { hardware: { model_identifier: 'MacBookPro18,3', marketing_name: 'MacBook Pro (14-inch, 2021)' } },
})
```

但会踩到 `KNOWN_BOARDS` 校验：`macos.mjs` 的 `KNOWN_BOARDS` 是「机型 → 主板 ID」对照表，改机型不改 `board_id` 会抛 `board_model_mismatch`。

```js
export const KNOWN_BOARDS = Object.freeze({
  'MacPro7,1': 'Mac-27AD2F918AE68F61',
  'MacPro6,1': 'Mac-F60DEB81FF30ACF6',
  'iMac20,1': 'Mac-CFF7D910A743CAAF',
  'iMacPro1,1': 'Mac-7BA5B2D9E42DDD94',
  'MacBookPro16,1': 'Mac-E1008331FDC96864',
  'MacBookPro18,3': 'Mac-7DF21CB3ED6977E5',
  'Macmini9,1': 'Mac-8ED6AF5B48C039E1',
  'MacBookAir10,1': 'Mac-4B682C642B45593E',
})
```

正确做法是两者一起覆盖：

```js
overrides: {
  hardware: { model_identifier: 'MacBookPro18,3', board_id: 'Mac-7DF21CB3ED6977E5' },
}
```

#### 层 B：加一份全新的默认骨架（换机型家族）

如果要支持的机型与现有骨架差异大（比如从 x86 Mac Pro 换成 Apple Silicon），建议在 `persona/macos.mjs` 里加一份 DEFAULTS 变体，或复制出 `persona/macos-arm64.mjs` 再注册。要点：

1. `hardware.dimms` 之和必须等于 `hardware.ram_bytes`（`normalize` 会自动按 DIMM 之和覆盖 `ram_bytes`）
2. `hardware.smc_version` 不能留空，否则 `smc_version_empty`
3. `hardware.serial_number` 11–12 位大写字母数字、`mlb_serial` 17 位、`hardware_uuid` 标准 UUID 形态
4. `naming.hostname`、`naming.local_hostname`、`naming.computer_name` 三者要自洽（`validateViews` 会三处对比）
5. 不要手写序列号/UUID/MAC —— `normalize` 会从 `vm_id` 重新派生并覆盖掉

Windows / Linux 的机型更换同理，但约束不同：

| 平台 | 机型相关约束 | 校验码 |
|---|---|---|
| macOS | 机型↔主板必须匹配 | `board_model_mismatch` |
| Windows | 序列号必须符合 OEM 规则 | `serial_oem_mismatch` |
| Windows | NetBIOS 名 ≤ 15 字符且字符集受限 | `netbios_name_too_long` / `netbios_name_charset` |
| Linux | hostname 要符合云厂商形态（若前缀命中） | `hostname_cloud_pattern` |

Windows 的 OEM 规则表 `OEM_SERIAL_RULES`：

```js
'Dell Inc.': { pattern: /^[A-Z0-9]{7}$/, sample: 'G7Q3RM3' }
'HP':        { pattern: /^[A-Z0-9]{10}$/, sample: 'CZC1234ABC' }
'LENOVO':    { pattern: /^[A-Z0-9]{8,10}$/, sample: 'PF2ABCDE' }
'ASUSTeK COMPUTER INC.': { pattern: /^[A-Z0-9]{10,15}$/ }
```

换新 OEM 就在这张表里加一条。

**改完加断言到哪**：`test/selfcheck.mjs` 第 31 节（三平台自洽）与第 32/33 节（破绽拦截）。核心回归保护是：

```js
eq('新机型审计无问题', auditPersona(buildPersona({ platform: 'macos', vmId: 'v', overrides: {...} })).length, 0)
```

`auditPersona` 返回空数组说明内部约束与跨视图一致性都通过。

### 4.3 加一个新平台（以 FreeBSD 为例）

`persona/index.mjs` 的注释已经写明了标准做法：

```js
// 加新平台：在本目录加一个 <platform>.mjs，导出 { KEY, DEFAULTS, render, validateViews }，
// 然后在 index.mjs 的 REGISTRY 里注册。其余代码不需要改动。
```

具体五步，按依赖顺序：

#### 第 1 步：新建 `src/persona/freebsd.mjs`

必须导出这个完整契约（三个现有平台都实现了同一套）：

| 导出 | 类型 | 作用 | 是否必须 |
|---|---|---|---|
| `KEY` | string | 平台标识，必须等于注册名 | ✅ |
| `DEFAULTS` | object | 默认骨架（会被 `structuredClone`） | ✅ |
| `normalize(input)` | `(obj) => obj` | 补全派生字段、对齐内部一致性 | ✅ |
| `validate(p)` | `(obj) => Issue[]` | 内部约束检查 | ✅ |
| `render(p)` | `(obj) => {files, commands}` | 渲染全部视图 | ✅ |
| `validateViews({persona, files, commands})` | `=> Issue[]` | 跨视图一致性检查 | ✅ |
| `warnings(p)` | `(obj) => Issue[]` | 非致命提示（可选） | ❌ 可选 |

`Issue` 的形状固定为 `{code: string, text: string, views?: string[]}`。

```js
// src/persona/freebsd.mjs 骨架
import { deriveHex32, deriveUuid, deriveMac, deriveSerial } from './derive.mjs'

export const KEY = 'freebsd'

export const DEFAULTS = Object.freeze({
  platform: 'freebsd',
  software: {
    os_name: 'FreeBSD',
    os_version: '14.1-RELEASE',
    kernel_version: 'FreeBSD 14.1-RELEASE-p5 GENERIC',
    __FreeBSD_version: 1401000,
    arch: 'amd64',
  },
  hardware: {
    sys_vendor: 'Supermicro',
    product_name: 'SYS-510P-WTR',
    product_serial: '',        // normalize 会派生
    product_uuid: '',          // normalize 会派生
    cpu_model: 'Intel(R) Xeon(R) Silver 4314 CPU @ 2.40GHz',
    physical_cores: 16,
    logical_cores: 32,
    ram_bytes: 64 * 1024 ** 3,
    dimms: [
      { locator: 'P1-DIMMA1', size_bytes: 32 * 1024 ** 3, speed_mts: 3200, type: 'DDR4' },
      { locator: 'P1-DIMMB1', size_bytes: 32 * 1024 ** 3, speed_mts: 3200, type: 'DDR4' },
    ],
  },
  network: { interface: 'em0', mac: '', mac_source: 'vm-assigned' },
  naming: { hostname: 'freebsd-01', domain: '' },
  storage: { root_fs: 'zfs', root_size_bytes: 480 * 1024 ** 3 },
})

export function normalize(input) {
  const p = structuredClone(input)
  const vmId = String(p.vm_id || 'default')
  p.hardware.product_serial = deriveSerial(vmId, 10, 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789', 'bsd-serial')
  p.hardware.product_uuid = deriveUuid(vmId, 'bsd-uuid')
  p.network.mac = deriveMac(vmId, '00:25:90')   // Supermicro OUI
  p.machine_id = deriveHex32(vmId, 'bsd-hostid')
  if (Array.isArray(p.hardware.dimms) && p.hardware.dimms.length > 0) {
    const sum = p.hardware.dimms.reduce((a, d) => a + Number(d.size_bytes || 0), 0)
    if (sum > 0) p.hardware.ram_bytes = sum
  }
  return p
}

export function validate(p) {
  const issues = []
  if (!/^[0-9a-f]{32}$/.test(p.machine_id || '')) {
    issues.push({ code: 'machine_id_format', text: 'hostid 必须是 32 位小写 hex' })
  }
  // 首字节最低位为 1 表示组播地址
  if ((parseInt(String(p.network?.mac).slice(0, 2), 16) & 1) !== 0) {
    issues.push({ code: 'mac_multicast', text: `MAC ${p.network.mac} 是组播地址` })
  }
  return issues
}

export function render(p) {
  const files = {
    'etc/rc.conf': `hostname="${p.naming.hostname}"\n`,
    'var/db/hostid': `${p.machine_id.slice(0, 8)}\n`,
    'etc/hosts': `127.0.0.1\tlocalhost\n127.0.1.1\t${p.naming.hostname}\n`,
  }
  const commands = {
    'uname -a': `FreeBSD ${p.naming.hostname} ${p.software.os_version} ${p.software.kernel_version} ${p.software.arch}`,
    'uname -n': p.naming.hostname,
    'uname -s': 'FreeBSD',
    'uname -r': p.software.os_version,
    'sysctl -n kern.hostuuid': p.hardware.product_uuid,
    'sysctl -n hw.model': p.hardware.product_name,
  }
  return { files, commands }
}

export function validateViews({ persona: p, files, commands }) {
  const issues = []
  const fromUname = commands['uname -n']
  const fromFile = (files['etc/rc.conf'] || '').match(/hostname="([^"]*)"/)?.[1]
  if (fromUname && fromFile && fromUname !== fromFile) {
    issues.push({
      code: 'hostname_view_mismatch',
      text: `uname -n "${fromUname}" 与 rc.conf hostname "${fromFile}" 不一致`,
      views: ['uname -n', 'etc/rc.conf'],
    })
  }
  return issues
}
```

#### 第 2 步：在 `src/persona/index.mjs` 注册

```js
import * as freebsd from './freebsd.mjs'

export const REGISTRY = Object.freeze({
  macos,
  windows,
  linux,
  freebsd,        // ← 新增
})
```

`PLATFORMS` 是 `Object.keys(REGISTRY)`，所以注册后自动生效。`persona/cli.mjs` 的 `--platform` 可用值、错误提示也会自动跟上。

#### 第 3 步：确认 `derive.mjs` 够用

如果需要新平台特有的派生（比如 FreeBSD 的 32-bit hostid 需要十进制而不是 hex），在 `derive.mjs` 里加一个新函数，**不要**改现有函数 —— 现有六个派生（`deriveHex32` / `deriveUuid` / `deriveUuidUpper` / `deriveSerial` / `deriveMac` / `pickFrom`）的输出形态被三平台共用，改了会连带影响其它平台。

#### 第 4 步：加测试

`test/selfcheck.mjs` 第 31 节的循环会自动覆盖新平台（`for (const plat of PLATFORMS)`），断言数会跟着涨。额外要补第 33 节那种「平台硬约束」断言：

```js
let err = null
try {
  buildPersona({ platform: 'freebsd', vmId: 'v', overrides: { machine_id: 'SHORT' } })
} catch (e) { err = e }
eq('拦住 hostid 格式错', err?.message.includes('machine_id_format'), true)
```

#### 第 5 步：跑 audit

```bash
node src/persona/cli.mjs --audit --platform freebsd --vm-id vm-01
# 期望输出：一致性检查通过
```

#### 汇总表

| 改动 | 文件 | 是否必须 |
|---|---|---|
| 新建平台模块（7 个导出） | `src/persona/freebsd.mjs` | ✅ |
| 注册到 REGISTRY | `src/persona/index.mjs` | ✅ |
| 新派生函数（若需要） | `src/persona/derive.mjs` | 按需 |
| 新平台的硬约束断言 | `test/selfcheck.mjs` 第 33 节式 | ✅ |
| `cli.mjs` 里的平台清单 | 不用改（自动） | — |
| `config.mjs` / `frames.mjs` / `server.mjs` | **不用改** | — |

平台身份跟 HTTP 层、帧协议层完全解耦，这是 `persona/` 独立成目录的设计收益。

### 4.4 换成别的上游 base URL

有三个独立的 base URL，改法各不相同。

#### 4.4.1 Claude 通道：`anthropic_base_url`

改动点 `src/config.mjs` 的 `validateWorkerConfig`（当前第 148 行那个 `if`）：

```js
// 现在（硬白名单）
if (url.hostname !== 'api.anthropic.com') {
  throw new Error('anthropic_base_url: endpoint host must be api.anthropic.com')
}

// 改成可配置白名单
const ALLOWED_HOSTS = new Set(
  String(process.env.ANTHROPIC_ALLOWED_HOSTS || 'api.anthropic.com')
    .split(',').map((s) => s.trim()).filter(Boolean),
)
if (!ALLOWED_HOSTS.has(url.hostname)) {
  throw new Error(`anthropic_base_url: endpoint host must be one of ${[...ALLOWED_HOSTS].join(', ')}`)
}
```

会被拦的三道关，按代码顺序：

| 关卡 | 触发条件 | 报错 |
|---|---|---|
| ① URL 解析 | 不是合法 URL | `anthropic_base_url: endpoint must use https` |
| ② 协议 | 不是 `https:` | `anthropic_base_url: endpoint must use https` |
| ③ host 白名单 | `url.hostname` 不等于 `api.anthropic.com` | `anthropic_base_url: endpoint host must be api.anthropic.com` |

注意 `url.hostname` **不含端口**。`https://api.anthropic.com:8443` 能过；`https://localhost:8080` 过不了（hostname 是 `localhost`）。要放行带端口或 IP 的自建上游，改判 `url.host` 或跳过第 ③ 关。

⚠️ 放宽白名单时还要同步改 `DEFAULT_WORKER_CONFIG.anthropic_base_url`，否则默认配置在改判后仍指向官方地址，行为不变但容易误解。

另一点：`anthropic_base_url` 当前**只是被校验，不参与任何请求**（`grep` 除 `config.mjs` 外无消费点）。所以放宽白名单目前不会改变出站行为，只是让配置能过启动校验；真正用上它要等出站传输实现。

#### 4.4.2 Codex 通道：`codex_base_url`

Codex 通道的上游地址走**配置字段**，不是直接改常量。两处配合：

| 位置 | 内容 | 作用 |
|---|---|---|
| `config.mjs` 的 `DEFAULT_WORKER_CONFIG.codex_base_url` | 取自 `codex.mjs` 的 `DEFAULT_CHATGPT_BASE` | 缺省值 |
| `config.mjs` 的 `validateCodexConfig` | **host 必须是 `chatgpt.com`** | 白名单，与 `anthropic_base_url` 同策略 |

```js
// config.mjs validateCodexConfig
if (url.hostname !== 'chatgpt.com') {
  throw new Error('codex_base_url: endpoint host must be chatgpt.com')
}
// 存配置时先规范化尾斜杠，避免与 responsesUrl 的处理两处不一致
cfg.codex_base_url = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
```

所以想换 Codex 上游，要改的是 `validateCodexConfig` 里那条 host 判断，**只改 `DEFAULT_CHATGPT_BASE` 会被启动校验拦下**。运行时也可以用 `CODEX_BASE_URL` 环境变量覆盖（`server.mjs` 挂载 Codex 通道时读取）。

`codex.mjs` 的 `DEFAULT_CHATGPT_BASE`（第 25 行）本身是 `responsesUrl()` / `responsesWsUrl()` 的默认参数，这两个纯函数**没有白名单**，任何 host 都能传：

```js
responsesUrl('http://127.0.0.1:8899/backend-api/codex')
// → 'http://127.0.0.1:8899/backend-api/codex/responses'

responsesWsUrl('http://127.0.0.1:8899/backend-api/codex')
// → 'ws://127.0.0.1:8899/backend-api/codex/responses'   ← http 自动降成 ws
```

要拦的话在调用侧加校验，别改这两个纯函数。

#### 4.4.3 OAuth token URL（两处）

| 位置 | 常量 / 字段 | 缺省值 |
|---|---|---|
| `codex.mjs` | `DEFAULT_OAUTH_TOKEN_URL` | `https://auth.openai.com/oauth/token` |
| `config.mjs` | `oauth_token_url` | `https://platform.claude.com/v1/oauth/token` |

两个目前都没有消费者，只是声明。换 provider 时记得一起改，否则以后接刷新逻辑会指错地方。Codex 侧的刷新实现通过 `CredentialManager` 的 `refreshFn` 注入，注入点见 `codex-credentials.mjs`。

---

## 5. 不变量与关键子系统

下面每一条都对应至少一个测试断言，破了会红。§5.1–§5.7 是逐条约束，§5.8–§5.10 是三个需要整段理解其设计理由的子系统。

### 5.1 `NATIVE_OWNED_FIELDS` 的 19 个字段不能被客户端覆盖

`src/frames.mjs`：

```js
export const NATIVE_OWNED_FIELDS = Object.freeze([
  'model', 'messages', 'system', 'tools', 'tool_choice', 'thinking', 'metadata',
  'max_tokens', 'stream', 'temperature', 'top_p', 'top_k', 'stop_sequences',
  'betas', 'wireMessages', 'request_context', 'output_config',
  'context_management', 'safeguards',
])
```

`mergeWireBody(official, wire)` 只允许 wire 里的**非**这 19 个键透传。

- 破了会怎样：客户端能改 `model` 顶掉官方模型、能改 `stream` 造成响应格式错乱、能塞自定义 `system` 绕开布局
- 断言：第 19 节 `wire 不能覆盖 model` / `wire 不能覆盖 stream` / `官方字段 19 个`

### 5.2 可选字段没给必须删除，不能留默认值

`CALLER_OPTIONAL_FIELDS` 10 个字段走的是**删除**语义：

```js
for (const key of CALLER_OPTIONAL_FIELDS) {
  if (!Object.hasOwn(wire, key)) delete body[key]        // ← 缺就删
  else if (key !== 'tools' || Array.isArray(wire.tools)) body[key] = wire[key]
}
```

- 破了会怎样：调用方没传 `temperature`，但官方 body 有默认 1，转发上去就变成「显式温度 1」——上游能区分「没给」和「给了默认值」
- 特例：`tools` 传 `null` 时**不**覆盖（只有真数组才覆盖），因为 `null` 在 wire 里表示「这次没有工具」
- 断言：`temperature 没给就删` / `top_p 没给就删` / `tools=null 不覆盖` / `可选字段 10 个`

### 5.3 `metadata.user_id` 里不能出现 `@`

`src/frames.mjs`：

```js
if (sid.includes('@')) {
  throw new Error('metadata.user_id must not contain "@": upstream rejects with has_at')
}
```

- 破了会怎样：客户端拿邮箱当 session id → 上游回 400，错误体带 `has_at`，整条请求失败
- 配套约束：`device_id` 必须是 64 位 hex，否则先 sha256 再发（`outboundDeviceId`）
- 断言：`邮箱被拒（上游 400 has_at）` / `64hex device_id 原样` / `非 hex 走 sha256`

### 5.4 Codex 的 `body` 必须是对象，Responses 字段不能放顶层

`src/codex.mjs` 的 `normalizeEnvelope`：

```js
if (raw.body === undefined) {
  const leaked = Object.keys(raw).filter((k) => !ENVELOPE_FIELDS.includes(k))
  if (leaked.length > 0) throw new Error(`... found Responses fields at top level: ...`)
  throw new Error('envelope missing field `body`')
}
if (typeof raw.body !== 'object' || raw.body === null || Array.isArray(raw.body)) {
  throw new Error('envelope.body must be an object')
}
```

- 破了会怎样：不报错，但上游收到 `{}`，客户端拿到 200 + 完整 SSE 流，模型什么都没收到。这是最隐蔽的失败模式
- 断言：`顶层泄漏被拒` / `顶层字段名带进报错` / `Envelope 的 body 必需`

### 5.5 Codex 的 `store` 必须强制 `false`

```js
export function buildOutboundBody({ body, ... }) {
  const out = { ...(body || {}) }
  out.store = false          // ← 无条件覆盖，不看客户端传了什么
  ...
}
```

- 破了会怎样：客户端传 `store: true` 就会在上游落库，行为与 Codex 官方不一致
- 顺序注意：先 `store = false`，再执行 `STRIP_IDENTITY_KEYS` 删除。`store` 不在这 12 个键里所以顺序不影响，但**新增删除逻辑时不要顺手把 `store` 加进 `STRIP_IDENTITY_KEYS`** —— 那会变成「删掉」而不是「强制 false」，语义不同
- 断言：`store 强制 false`

### 5.6 persona 的不变量

| 不变量 | 位置 | 破了会怎样 | 对应断言 |
|---|---|---|---|
| 一份 persona 对象是唯一真值源，视图不许存副本 | `persona/*.mjs` 的 `render` | 各视图漂移，交叉验证即可识破 | `validateViews` 全部断言 |
| `uname -n` / `scutil --get HostName` / `etc/hostname` 三处主机名必须字面一致 | `macos.mjs` `validateViews` | 主机名漂移是最好抓的破绽 | `拦住 uname/scutil 主机名漂移` |
| `smc_version` 不能为空 | `macos.mjs` `validate` | 真机一定有 SMC 版本号 | `拦住 smc_version 为空` |
| 机型 ↔ 主板 ID 必须匹配 | `macos.mjs` `KNOWN_BOARDS` | `MacPro7,1` 配错 board 一查即露 | `mac` 平台 audit 无问题 |
| 序列号 / UUID / MAC 必须从 `vm_id` 派生，不能手写 | `normalize` | 一批 VM 共用同一硬件指纹 | `同 vm 可复现` / `异 vm 身份不同` |
| 不同 `vm_id` 必须得到不同标识 | `derive.mjs` 全部 | 批量关联特征 | 第 35 节 3 × 3 条 |
| `ram_bytes` 必须等于 DIMM 之和 | `normalize` + `validate` | `ram_bytes` 与 DIMM 列表自相矛盾 | `ram_dimms_mismatch` |
| MAC 必须是单播（首字节最低位 0） | `derive.mjs` `deriveMac` + `validate` | 组播 MAC 是明显异常 | `MAC 是单播` |
| MAC 不能是本地管理地址（首字节次低位 0） | `derive.mjs` `deriveMac` | 虚拟机常用本地管理地址，容易被筛 | `MAC 非本地管理` |
| NetBIOS 名 ≤ 15 字符 | `windows.mjs` `validate` | Windows 主机名上限 | `拦住 NetBIOS 名超 15 字符` |
| Linux `etc/machine-id` 与 `var/lib/dbus/machine-id` 必须相同 | `linux.mjs` `validateViews` | 真机两处固定同值 | `/etc/machine-id 与 dbus 一致` |
| `structuredClone` 骨架，不许原地改 `DEFAULTS` | `platformDefaults` | 跨调用污染 | `默认骨架有 platform` |

### 5.7 其它必须守住的不变量

| 不变量 | 位置 | 破了会怎样 | 对应断言 |
|---|---|---|---|
| SSE 事件之间必须空行，`data:` 后必须有空格 | `sse.mjs` `sseEvent` | 客户端解析器整段丢弃 | 隐含在事件序列断言里 |
| 客户端可见流到 `message_stop` 结束，**不发** `kin.done` | `sse.mjs` `messageStream` | 有客户端会因未知事件 break | `客户端可见流不含 kin.done` / `末帧是 message_stop` |
| 非流式响应必须带 `x-session-id` / `x-slot` / `x-generation` 三头 | `sse.mjs` `messageHeaders` | 控制面拿不到会话定位 | — |
| `cc_prompt_id` 进程内固定，不随请求变 | `system-layout.mjs` `billingPromptId()` | cch 失去稳定性，每请求都不同 | `cc_prompt_id 跨调用不变` |
| billing header 里的 cch 必须先归 `00000` 再算 | `cch.mjs` `projectBillingFields` | 哈希掺入旧值，算出的 cch 永远不对 | `cch 已是 00000` 用例 |
| cch 投影顺序：归零 → 清 model 值 → 切 fallbacks → 切 credit_token → 切 max_tokens | `cch.mjs` `projectBillingFields` | 逐字节不一致，20 条交叉验证全红 | `cch-crosscheck.mjs` 全部 20 条 |
| `max_tokens` 只在值是数字时被切 | `cch.mjs` `stripMaxTokens` | 字符串值被误切，投影错位 | `max_tokens 是字符串（不该被切）` |
| thinking / redacted_thinking 块不能挂 `cache_control` | `identity.mjs` `dropThinkingMarkers` | 上游拒绝带 marker 的 thinking 块 | `thinking marker 被剥掉` |
| cache marker 上限 4 个 | `identity.mjs` `MAX_CACHE_MARKERS` | 上游报错 | — |
| marker 删除顺序：tools(倒序) → system(倒序) → messages | `identity.mjs` `capCacheMarkers` | 该保留的被删、该删的留着 | — |
| `stop_reason` 长度窗口：api 路径 `[7,29]`，native 路径超 13 一律 `end_turn` | `identity.mjs` `mapStopReason` / `nativeStopReason` | 长枚举值被误判成 unknown | 第 13 节全部 10 条 |
| 凭据顶层必须是 `{"accounts":[...]}` | `codex.mjs` `parseCredentialFile` | 静默 0 账号 | `裸数组被拒` |
| Account 的 `expires_at` 是 i64、`rpm`/`max_concurrency` 是 u32，不接受字符串 | `codex.mjs` `normalizeAccount` | 整批账号变空 | `rpm 字符串被拒` / `expires_at 字符串被拒` |
| `x-codex-turn-id` 每次新生成，忽略客户端传入 | `codex.mjs` `buildOutboundHeaders` | 客户端能干预上游的单轮追踪 | `turn-id 是 UUID` |
| `client_metadata` 的键名带 `x-codex-` 前缀 | `codex.mjs` `buildOutboundBody` | 上游读不到 installation id | `client_metadata 注入` |
| 账号亲和**无 TTL**，失败不解绑 | `codex.mjs` `AccountScheduler` | 长时间会话中途换账号，上游当成两个用户 | 第 29 节 12 条 |
| 亲和命中也要 `hold()` 占坑 | `codex.mjs` `select` | `max_concurrency` 对亲和路径失效 | 第 29 节相关断言 |
| 冷却时长优先用 Retry-After，不足 1 秒抬到 1 秒 | `codex.mjs` `markCooldown` | 冷却变空操作，账号立即被再选 | 第 30 节 16 条 |
| `parseRetryAfter` 只接受纯十进制数字 | `codex.mjs` `parseSeconds` | 带符号/小数/单位被误解析 | 第 30 节相关断言 |
| 槽位上限 20 | `scheduler.mjs` `SLOT_CAP` | 超了构造直接抛错 | （构造期抛出） |
| `host_ready` 五项校验全过才注册 slot | `frames.mjs` `validateHostReady` | 配置不一致的 CLI 被当成可用 | 第 15 节 4 条 |
| `cancel` 帧第一字段是 `job_id`，`slot_id` 可选 | `frames.mjs` `cancelFrame` | CLI 忽略取消请求 | `cancel 用 job_id 字段` / `cancel 无 request 字段` / `cancel slot_id 可选` |
| CLI stdin 只接受 3 种帧类型，其余静默丢弃 | `frames.mjs` `parseStdinLine` | 非协议噪声被当成错误处理 | 第 12 节 7 条 |
| 期望 `engine: 'rust'` 字面值 | `config.mjs` `healthPayload` | 控制面按 engine 分支判断会走错 | — |
| `system-layout.mjs` 显式 `import { randomUUID } from 'node:crypto'`，`sse.mjs` 直接用全局 `crypto.randomUUID` | 两处风格不一致 | 当前在 Node 22 可用（Web Crypto 全局），但不该依赖隐式全局：一旦运行环境关掉全局或换运行时，`requestId \|\| crypto.randomUUID()` 的兜底分支会抛 `ReferenceError` | — |
| cache_control 挂在 content block 上，不能挂在 message 上 | `cache-breakpoints.mjs` `applyMessageBreakpoints` | 字符串 content 未规整成块数组时标记会被上游忽略 | `cache-breakpoints.mjs` 套件 |
| thinking / redacted_thinking 块不接受缓存标记 | `cache-breakpoints.mjs` `isUncacheableBlock` | 上游拒绝该组合 | 同上 |
| 两个 messages 断点不能重合 | `cache-breakpoints.mjs` `messageBreakpointIndices` | 少的那个纯属浪费，总数还可能超上限 | 同上 |
| 消息数 < 4 时只打一个 messages 断点 | `MIN_MESSAGES_FOR_TWO_BREAKPOINTS` | 两个点落在同一轮增量里，无收益 | 同上 |
| 缓存标记总数 ≤ 4（上游硬限制） | `MAX_CACHE_MARKERS` | 上游报错 | 同上 |
| 断点带 `ttl:'1h'` 时必须同时声明 `extended-cache-ttl` beta | `server.mjs` `prepareOutbound` | 上游不接受 1h TTL | `cache-breakpoints.mjs` / `breakpoints-demo.mjs` |
| 缓存标记操作幂等（重复调用不增加标记） | `cache-breakpoints.mjs` `applyCacheBreakpoints` | 重试时标记越积越多，撞 4 个上限 | 同上 |

---

### 5.8 persona 子系统：单一真值源

#### 5.8.1 结构

```text
src/persona/
  index.mjs      统一入口 + REGISTRY 注册表
  macos.mjs      KEY / DEFAULTS / normalize / validate / render / validateViews (+ warnings)
  windows.mjs    同上
  linux.mjs      同上
  derive.mjs     deriveHex32 / deriveUuid / deriveUuidUpper / deriveSerial / deriveMac / pickFrom
  cli.mjs        命令行工具
```

`index.mjs` 的 `REGISTRY` 是一个 `Object.freeze({macos, windows, linux})`，值是整个模块命名空间的引用（`import * as macos`）。`PLATFORMS = Object.keys(REGISTRY)` 因此注册即生效，不需要在别处维护第二份平台清单。`isSupportedPlatform` / `platformDefaults` / `buildPersona` / `renderViews` / `crossCheckViews` / `auditPersona` / `assertPersonaConsistent` 全部通过 `REGISTRY[platform]` 取实现。

三个平台模块导出同一套契约：

| 导出 | 签名 | 作用 | 是否必须 |
|---|---|---|---|
| `KEY` | `string` | 平台标识，等于注册名 | ✅ |
| `DEFAULTS` | `object` | 默认骨架（被 `structuredClone`） | ✅ |
| `normalize(input)` | `(obj) => obj` | 补全派生字段、对齐内部一致性 | ✅ |
| `validate(p)` | `(obj) => Issue[]` | 字段之间的自洽检查 | ✅ |
| `render(p)` | `(obj) => {files, commands}` | 渲染全部视图 | ✅ |
| `validateViews({persona, files, commands})` | `() => Issue[]` | 视图之间的字面一致性检查 | ✅ |
| `warnings(p)` | `(obj) => Issue[]` | 非致命提示 | ❌ 可选 |

`Issue` 形状固定为 `{code, text, views?}`。各平台还额外导出自己的常量与辅助函数（`macos`：`APFS_SLICES` / `KNOWN_BOARDS` / `apfsLayout`；`windows`：`OEM_SERIAL_RULES` / `machineGuidFromUuid`；`linux`：`HOSTNAME_RULES` / `machineIdFromUuid` / `bootIdFromMachineId`），这些是模块私有知识的出口，不进 `REGISTRY` 契约。

#### 5.8.2 核心设计：一份数据，渲染出全部视图

**唯一真值源。** 一份 persona 对象渲染出该平台的所有视图——`uname` / `sw_vers` / `scutil` / `system_profiler` / `ioreg` / `sysctl` / `df` / `diskutil`、WMI / `systeminfo` / `reg query`、DMI / `hostnamectl` / `lscpu` / `lsblk` / `/etc/*` 等等。**任何视图都不许存字符串副本**，必须现场从 persona 取。

```js
// macos.mjs render()：三条命令都从同一个 nm.hostname 取，谁都没有自己的副本
'uname -n': nm.hostname,
'scutil --get HostName': nm.hostname,
'etc/hostname': `${nm.hostname}\n`,
```

原因很直接：**同一事实在多处暴露时必须一致**。真机上 `uname -n`、`scutil --get ComputerName`、`/etc/hostname` 报的是同一个值；一旦各自存一份字符串，改一处忘另一处，就漂了。而漂移恰恰是最容易被交叉验证发现的破绽——查一遍 `uname -n` 再 `cat /etc/hostname` 就能对出来。

同理，`normalize` 里 `ram_bytes` 一律按 DIMM 之和覆盖，而不是让两处各写一个数；`macos` 的 `apfsLayout()` 先算一份容量预算，`df` / `diskutil` / `mount` 全部从预算取值。**先算一份，再分发**，是这套设计在每个细节上的统一做法。

#### 5.8.3 两道检查，缺一不可

`buildPersona` 同时跑两道检查，把结果合并后判断：

```js
const issues = [
  ...impl.validate(persona),                              // 第 1 道：字段之间
  ...impl.validateViews({ persona, ...impl.render(persona) }), // 第 2 道：视图之间
]
if (issues.length > 0) throw new Error(...)
```

**第 1 道 `validate` —— 字段自洽。** 检查 persona 对象内部有没有自相矛盾的组合，不涉及渲染：

| 平台 | 检查项 | 校验码 |
|---|---|---|
| macOS | 机型 ↔ 主板 ID 必须匹配 `KNOWN_BOARDS` | `board_model_mismatch` |
| macOS | `smc_version` 不能为空 | `smc_version_empty` |
| macOS | 序列号 11–12 位大写字母数字 | `serial_format` |
| macOS | MLB 17 位 | `mlb_format` |
| macOS | `hardware_uuid` 标准 UUID 形态 | `hardware_uuid_format` |
| macOS | 逻辑核不少于物理核 | `core_count_order` |
| macOS | `ram_bytes` 等于 DIMM 之和 | `ram_dimms_mismatch` |
| macOS | MAC 是单播地址 | `mac_multicast` |
| Windows | 序列号符合 OEM 规则 | `serial_oem_mismatch` |
| Windows | `product_version` 末段等于 `build_number` | `build_version_mismatch` |
| Windows | NetBIOS 名 ≤ 15 字符 / 字符集受限 | `netbios_name_too_long` / `netbios_name_charset` |
| Windows | SMBIOS UUID 形态 | `uuid_format` |
| Windows | 卷序列号形态 | `volume_serial_format` |
| Windows | 卷已用不超过总容量 | `volume_used_exceeds_size` |
| Windows | `ram_bytes` 等于 DIMM 之和 | `ram_dimms_mismatch` |
| Windows | MAC 是单播地址 | `mac_multicast` |
| Linux | `machine_id` 是 32 位小写 hex | `machine_id_format` |
| Linux | `product_uuid` 形态 | `product_uuid_format` |
| Linux | hostname 非空且字符集合法 | `hostname_invalid` |
| Linux | hostname 符合云厂商形态（前缀命中时） | `hostname_cloud_pattern` |
| Linux | 逻辑核不少于物理核 | `core_count_order` |
| Linux | `ram_bytes` 等于 DIMM 之和 | `ram_dimms_mismatch` |
| Linux | 根卷已用不超过总容量 | `root_used_exceeds_size` |
| Linux | MAC 是单播地址 | `mac_multicast` |

**第 2 道 `validateViews` —— 视图字面一致。** 渲染完之后，把同一条事实在不同视图里的取值拿出来逐字比对：

| 平台 | 跨视图比对 | 校验码 |
|---|---|---|
| macOS | `uname -n` ↔ persona.hostname | `uname_hostname_mismatch` |
| macOS | `scutil --get HostName` ↔ `etc/hostname` | `scutil_hostname_mismatch` |
| macOS | `scutil --get LocalHostName` ↔ hostname 去掉 `.local` | `scutil_localhost_mismatch` |
| macOS | `uname -r` ↔ `sysctl -n kern.osrelease` | `kernel_release_mismatch` |
| macOS | `sysctl -n hw.memsize` ↔ `ram_bytes` | `memsize_mismatch` |
| macOS | `sysctl -n hw.ncpu` ↔ `logical_cores` | `ncpu_mismatch` |
| macOS | `system_profiler` 里出现机型标识 | `system_profiler_model_missing` |
| macOS | `system_profiler` / `ioreg` 里出现 `smc_version` | `smc_version_view_mismatch` |
| macOS | `df -h` 总容量 ↔ 卷大小（容差 0.15 GiB） | `disk_capacity_mismatch` |
| macOS | `ioreg` 里出现序列号 | `serial_ioreg_missing` |
| Windows | `hostname` ↔ `echo %COMPUTERNAME%` | `computer_name_mismatch` |
| Windows | `systeminfo` / `wmic` / PowerShell 三处的机型 | `model_view_mismatch` |
| Windows | 三处内存总量（`systeminfo` vs `wmic` vs CIM） | `memory_mismatch` / `memory_cim_mismatch` |
| Windows | CPU 核心数 | `cpu_cores_mismatch` |
| Windows | 序列号在多视图一致 | `serial_view_mismatch` |
| Windows | MAC 在多视图一致 | `mac_view_mismatch` |
| Windows | 卷序列号 / 卷大小 | `volume_serial_mismatch` / `volume_size_mismatch` |
| Linux | `etc/machine-id` ↔ `var/lib/dbus/machine-id` | `machine_id_files_mismatch` |
| Linux | `etc/hostname` ↔ persona.hostname | `hostname_view_mismatch` |
| Linux | `machine-id` 与 persona 派生值 | `machine_id_persona_mismatch` |
| Linux | `hostnamectl` 的 hostname / kernel / machine-id | `hostnamectl_hostname_mismatch` / `hostnamectl_kernel_mismatch` / `hostnamectl_machine_id_mismatch` |
| Linux | `uname -a` 里的内核串 | `uname_a_kernel_mismatch` |
| Linux | `lscpu` 核心数 | `lscpu_cores_mismatch` |
| Linux | `free` 内存总量 | `free_memory_mismatch` |
| Linux | `df -h` 容量 | `df_capacity_mismatch` |
| Linux | `ip link show` 里的 MAC | `mac_view_mismatch` |

**第 3 类：`warnings` —— 非致命提示。** 不算错，`buildPersona` 不会因此抛错，但 `auditPersona` 会把它们标成 `severity: 'warn'`：

| 平台 | 提示项 | 校验码 |
|---|---|---|
| 三平台 | MAC 是本地管理地址（首字节次低位为 1） | `mac_local_administered` |
| macOS | Mac Pro 配小于 16 GB 内存 | `ram_low_for_macpro` |
| Windows | 显示版本与构建号不匹配 | `display_version_mismatch` |
| Linux | 核心数组合可疑 | `cpu_cores_suspect` |

`assertPersonaConsistent(persona)` 只对 error 级别断言（`includeWarnings: false`），所以 warnings 不会挡住构建。

**为什么只用第 1 道会漏。** `validate` 检查的是「字段各自是否合法、两两是否冲突」。它能抓住 `ram_bytes: 32GiB` 配 `dimms: [16, 16, 16]` 这种直接矛盾，但抓不住这一类：**字段全都合法、渲染逻辑却把其中一处写死了**。

举个具体的：假设 `render()` 里 `'uname -n'` 改成返回常量 `'MacPro7,1'`（而不是 `nm.hostname`）。此时 persona 对象完全没变——`naming.hostname` 仍是 `'MacPro7,1.local'`，`validate` 的所有检查全部通过，`auditPersona` 也不会报 error。但真机上 `uname -n` 报 `MacPro7,1`、`cat /etc/hostname` 报 `MacPro7,1.local`，一对比就露。

`validateViews` 就是专门堵这个缺口的：它不看 persona 字段，只看**渲染出来的字节**，把 `uname -n` 的输出和 `etc/hostname` 的内容直接做字符串比较。第 1 道管「数据对不对」，第 2 道管「渲染忠实不忠实」。两道都要有，因为它们是两类不同的错误。

#### 5.8.4 派生：同一 `vm_id` 恒得同一组值

`derive.mjs` 六个函数全部以 `vm_id` 加盐做 sha256 派生：

| 函数 | 输出 | 用途 |
|---|---|---|
| `deriveHex32(vmId, salt)` | 32 位小写 hex | Linux `machine-id` |
| `deriveUuid(vmId, salt)` | 标准 UUID v4 形态（版本位 4、变体位 8） | Linux `product_uuid` |
| `deriveUuidUpper(vmId, salt)` | 大写 UUID | macOS `hardware_uuid`、Windows SMBIOS UUID |
| `deriveSerial(vmId, length, alphabet, salt)` | 指定长度与字符集的序列号 | Apple 序列号 / MLB、Dell 服务标签 |
| `deriveMac(vmId, oui)` | 单播、非本地管理 MAC | 网卡地址 |
| `pickFrom(vmId, list, salt)` | 从候选列表确定性取一项 | 机型池挑选 |

两条性质：**同一 `vm_id` 逐字节可复现**（重建容器不漂移），**不同 `vm_id` 互不关联**（不会让一批 VM 共用同一硬件指纹）。`deriveMac` 额外把首字节的两个低位清零，保证输出是单播且非本地管理地址——虚拟机默认 MAC 常是本地管理地址，那本身就是个筛子。

`normalize` 会用派生值覆盖骨架里的值，**不要手写序列号 / UUID / MAC**，写了也会被覆盖。

### 5.9 账号调度器：五条语义

`src/codex.mjs` 的 `AccountScheduler`（对外历史导出名 `CodexScheduler`）。下面五条是**上游的真实行为约定，不是可优化点**。改其中任何一条都会改变账号使用分布，进而影响额度消耗。

#### ① 会话亲和永久有效，没有 TTL

`(sessionId → accountId)` 一旦绑定，除非该账号从池中被移除（`setAccounts`）或被新绑定顶替（`commitSuccess`），否则一直生效。**不要引入 TTL。** 长时间交互的会话不会中途换账号；换账号会让上游把同一段对话当成两个不同用户。

注意与 `scheduler.mjs` 的区别：槽位调度器的会话 pin 有 24 小时 TTL（`pinTtlMs`），那是**槽位复用**的亲和；`AccountScheduler` 的亲和是**账号归属**，没有过期时间。两者不是一回事，不要混。

#### ② 选择顺序固定三段，命中即返回

```text
① session 键亲和   sessionAffinity.get(sessionId) → canTake? → hold → 返回 via:'session'
② thread 键亲和    threadAffinity.get(threadId)   → canTake? → hold → 返回 via:'thread'
③ 全表扫描         for (const acc of accounts) if (canTake(acc)) → hold → 返回 via:'scan'
```

亲和命中后**仍要过 `canTake`**；不通过就继续往下回落，不阻塞。

`canTake` 判定三项：未在冷却期、`inflight < max_concurrency`、本地 RPM 滑窗未满。`max_concurrency` 与 `rpm` 为 0 或未设置时视为不限。

#### ③ 首个可用即选，不要改成最小负载

第 ③ 段是**顺序扫描取第一个 `canTake` 的账号**——不排序、不算负载加权、不按 RPM 余量挑。

这条最容易被当成「可优化点」改掉，但要明确：改成「最小负载」会改变账号使用分布。上游各账号之间的额度并不对等（plan 不同、窗口不同），按负载均衡会把请求摊到额度小的账号上，反而更容易把它们打满并触发限流。保持首个可用，行为与上游一致，账号使用也更集中、更可预测。

#### ④ 请求失败不解除亲和

`executeCodexRequest` 的失败路径只做两件事：`release(accountId)` 释放并发计数、`markCooldown(accountId, ...)` 设冷却。**绝不触碰亲和表。**

只有成功路径（2xx）才调 `commitSuccess({sessionId, accountId})`，而且**只在绑定需要变更时**才清旧绑定：

```js
const prev = this.sessionAffinity.get(sid)
if (prev != null && prev !== accountId) this.dropSticky({ sessionId: sid })
this.sessionAffinity.set(sid, accountId)
```

这条分工让「失败不回退亲和」与「成功才迁移账号」两个约束互不干扰。

#### ⑤ 冷却优先用上游 `Retry-After`

`markCooldown(accountId, {status, retryAfter})` 的时长优先级：

```text
retryAfter 有限且 > 0  → 用 floor(retryAfter)
否则 status === 429    → RATE_LIMIT_COOLDOWN_SECS = 60 秒
否则                    → DEFAULT_COOLDOWN_SECS = 30 秒
最后：不足 1 秒一律抬到 1 秒
```

抬到 1 秒那一句不能省：解析出来是 0 的话冷却等于空操作，账号会被立刻再次选中。

`retryAfter` 由 `parseRetryAfter(headers)` 从响应头解析，三个来源按优先级：`x-codex-secondary-reset-after-seconds` → `x-codex-primary-reset-after-seconds` → `retry-after`。先取 secondary 是因为它是更保守的窗口（次级限流恢复更晚），用 primary 会在次级限流仍生效时过早重试。值只接受纯十进制数字串，带正负号、小数、单位后缀一律视为无效。

#### `hold()` 的约束：只在无绑定时建立初始亲和

```js
hold({ account }, { sessionId, threadId }) {
  this.inflight.set(...)          // 占坑：inflight + 1
  this.rpmSamples...push(now)     // 记 RPM 样本

  // 只在尚无绑定时建立初始亲和
  if (sessionId && !this.sessionAffinity.has(sessionId)) {
    this.sessionAffinity.set(sessionId, account.id)
  }
  if (threadId && !this.threadAffinity.has(threadId)) {
    this.threadAffinity.set(threadId, account.id)
  }
}
```

**已有绑定不在这里改。** 原因是「目标账号繁忙时回落」这条路径：当亲和的账号 `canTake` 失败、请求回落到第 ③ 段扫描并被别的账号接走时，如果 `hold()` 顺手把绑定改到新账号，那么下次这个 session 就绑到新账号了；新账号再繁忙时又漂到第三个。**亲和会一路漂移，永久有效的保证就没了。** 改绑定只发生在 `commitSuccess`。

同时注意：亲和命中路径**也必须调 `hold()`**。不然 `max_concurrency` 对这条路径完全失效——一个被反复命中的亲和账号会无限并发。

#### 配套：`setAccounts` 要连带清理

账号列表变更时必须清掉指向已移除账号的 `sessionAffinity` / `threadAffinity` / `cooldownUntil` / `inflight`。不清的话亲和表会指向一个不存在的 id：`select` 里 `accounts.find(...)` 返回 `undefined`，那个 session 就永远命中不了亲和，每次都回落扫描，亲和彻底失效。

### 5.10 Codex 通道的传输层

`CodexUpstream`（收发）与 `executeCodexRequest`（选号 → 构造 → 发送 → 失败换号）。与 Claude 通道的关键区别：Claude 通道由官方 CLI 子进程自己发请求，Codex 通道没有中间进程，必须由本模块直接连上游。

上游地址：`https://chatgpt.com/backend-api/codex/responses`（POST）。

#### 三条必须做对的传输细节

**① body 必须显式带 `stream: true`。**

上游对这个字段是强校验：缺失直接 400 `Stream must be set to true`，不会默认成流式。

```js
// buildOutboundBody
out.stream = stream !== false   // 无条件写入，缺省 true
```

`codex-server.mjs` 里对上游**永远**以 `stream: true` 请求；客户端要非流式时，本地用 `collectResponsesStream` 把事件流聚合完再一次性返回，而不是向上游要非流式。

**② 不要依赖响应 content-type 判断流式。**

上游 SSE 响应的 `content-type` 是 `null`。靠它判断会误判成非流式，然后对一条永不结束的事件流调 `json()`——表现为请求一直挂着直到超时，没有任何报错。

正确做法是**按请求时声明的 `accept` 判定**，而不是看响应：

```js
// 判断依据是发出去的头，不是收回来的头
const wantsStream = String(headers.accept || '').includes('text/event-stream')
if (wantsStream && res.body) {
  return { status, headers: respHeaders, stream: res.body, json: null, retryAfter }
}
```

**③ 不要手动设 content-length。**

`content-encoding: zstd` 的压缩体、以及分块下发的 SSE，都不该手写长度。`CodexUpstream.createResponse` 里明确留了注释：

```js
headers['content-encoding'] = 'zstd'
// 不手动设 content-length：让运行时按实际字节数填写，避免与服务端预期不一致
```

`codex-server.mjs` 写 SSE 响应头时同样不设 `content-length`，交给 Node 用 chunked encoding；手写会截断响应。

#### 其余传输约定

| 项 | 做法 |
|---|---|
| `content-encoding` | 恒为 `zstd`，与 `compressBody()` 成对；Node 无 zstd 时退化为不压缩但头仍写 `zstd`，属已知不一致 |
| `x-codex-turn-id` | 每次调用现生成 UUID，**忽略客户端传入**（上游用它做单轮追踪，复用旧值会把多轮归并成一轮） |
| `service_tier` | `fast` → `priority`，请求体与 `x-codex-routing-hint` 必须用**同一份**归一化结果 |
| `client_metadata` 的键 | `x-codex-installation-id` 带前缀，不是 `installation_id` |
| `store` | 恒为 `false`，无条件覆盖 |
| 失败分派 | 401 换号并冷却；429 / 5xx 冷却后换号；**其他 4xx 直接返回不重试**（请求本身有问题） |
| 并发释放 | 无论成败都要 `release(accountId)`；`executeCodexRequest` 只在失败路径释放，成功路径由 `codex-server.mjs` 的 `run()` 补一次 |
| 客户端断开 | `res.on('close')` → `ctrl.abort()`，避免上游继续计费 |
| `Result` 形状 | `{status, headers, stream, json, retryAfter, accountId, attempts}` |

---

## 6. 测试策略

### 6.1 为什么是三套

三套核心测试切的是三个不同的「跟什么对齐」问题：

| 测试 | 对齐对象 | 断言数 | 为什么单独一套 |
|---|---|---|---|
| `selfcheck.mjs` | 契约行为本身 | 236 | 覆盖 19 个模块、35 个分节，是主回归套件；只依赖 `src/` |
| `cch-check.mjs` | 一个独立的参考实现 | 10 | cch / xxHash64 是纯数学，需要外部基准（官方测试向量 + 另一个实现的全部边界）来证明「不是自己跟自己一致」 |
| `cch-crosscheck.mjs` | 另一份独立抽取的实现 | 25 | 投影规则有大量字符串边界（转义、嵌套、含方括号的值），需要 10 组极端 case × 2（投影文本 + cch 值）逐字节比对，外加 5 条 billing 块定位断言 |

除这三套之外还有十三套，`node test/run-all.mjs` 会依次跑全部十六套并汇总：

| 测试 | 断言数 | 覆盖 |
|---|---|---|
| `codex-convert.mjs` | 145 | Chat Completions ⇄ Responses 双向转换（纯函数） |
| `codex-upstream.mjs` | 156 | Codex 传输层，假 fetch / 假 stream |
| `codex-sse.mjs` | 64 | 事件解析与帧翻译 |
| `codex-scheduler.mjs` | 111 | 亲和、冷却、RPM、换号 |
| `smoke-server.mjs` | 60 | 真实启动验证：起进程、打真实 HTTP、进程收尾 |
| `cache-breakpoints.mjs` | 115 | `messages` / `system` 的缓存断点分配（纯函数） |
| `breakpoints-demo.mjs` | 22 | 缓存断点端到端：10 条消息的实际 body 结构 + 封盖后的 cch |
| `codex-credentials.mjs` | 96 | 单账号/多账号形态、到期解析、状态机、刷新注入 |
| `codex-server.mjs` | 109 | 路由分发、错误翻译、请求体边界 |
| `codex-images.mjs` | 166 | 模型白名单、plan 判定、multipart 解析、上游请求 |
| `fixes.mjs` | 57 | 已修问题的回归保护 |
| `outbound-shape.mjs` | 127 | 脱敏骨架归约与差异比对 |
| `prompt-profiles.mjs` | 233 | 两套档位的 system 组装、Environment 段、标记计数 |

全量合计 1732 条断言。

核心动机：`selfcheck.mjs` 断言的是「我这版行为符合我理解的契约」；另外两套断言的是「我的算法和另一个独立来源逐字节相同」。后者才能挡住「理解错了但内部自洽」这种失败。

### 6.2 各自覆盖什么

#### `selfcheck.mjs`（35 节 / 236 条）

分节清单见 `INTEGRATION.md` §6.3。整体分布：

| 分节范围 | 主题 | 条数 |
|---|---|---|
| 1–8 | system 布局、billing、betas 顺序、cache TTL 与 marker | 22 |
| 9–11 | 错误映射、metadata 降级、UA / stainless | 12 |
| 12–15 | 帧协议、stop_reason、cancel 帧、host_ready 校验 | 28 |
| 16–18 | 身份确定性、配置缺省值、SSE 序列 | 17 |
| 19–22 | wireBody 合并、metadata 硬约束、beta 动态注入、h2 指纹 | 35 |
| 23–28 | Codex 凭据、Envelope、URL/UA、出站头、body 改写、传输选择 | 46 |
| 29–30 | 账号调度与冷却 | 28 |
| 31–33 | 三平台 persona 自洽与破绽拦截 | 26 |
| 34–35 | 硬件标识派生与跨 vm 隔离 | 22 |

#### `cch-check.mjs`（10 条）

| # | 内容 |
|---|---|
| 1–2 | xxHash64 标准测试向量（空串 seed 0 = `ef46db3751d8e999`，`"abc"` = `44bc2cf5ad770999`） |
| 3 | 与参考实现在 9 种长度 × 2 个 seed 上全分支一致（覆盖 `len < 32`、`len == 32`、`len > 32`） |
| 4 | cch 值一致 + 格式是 5 位 hex |
| 5 | 投影规则：`model` 值被清空、`max_tokens` 被切 |
| 6–8 | seal 端到端：输出与参考一致、cch 非占位、seal 幂等 |

幂等那条（`seal 幂等（再 seal 一次不变）`）特别重要：它保证「已经盖好 cch 的 body 再走一遍流程不会变」。这是重试场景的安全前提。

#### `cch-crosscheck.mjs`（25 条）

结构是 5 + 10 + 10：

| 组 | 内容 |
|---|---|
| 前置 5 条 | billing 块定位：`messages` 排在 `system` 前后两种顺序下，真计费头都要归零、`messages` 里的同形示例都不能被改写；没有 `system` 时退回整段首个 |
| 中间 10 条 | 投影文本比对（下表 10 组边界） |
| 后 10 条 | cch 值比对（同 10 组输入） |

10 组覆盖的边界：

| 组 | 边界 |
|---|---|
| 最简单 | 基线 |
| 带 billing header | 已有 cch 值 |
| 带 fallbacks + credit_token | 两个都要切 |
| model 出现在字符串值里 | 不能误切内容里的 `"model":"` |
| max_tokens 是字符串 | 不该被切 |
| model 带反斜杠和引号 | 转义扫描 |
| 1h 缓存 + fallbacks=default | `fallbacks` 是字符串不是数组，不能切 |
| 嵌套 fallbacks 带方括号字符串 | `]` 在字符串里不结束数组 |
| cch 已是 00000 | 幂等 |
| 多个 model 键（嵌套） | 全部清空，不只第一个 |

### 6.3 加新功能该往哪套里加

```text
改的是 src/betas.mjs / config.mjs / frames.mjs / scheduler.mjs /
      sse.mjs / system-layout.mjs / identity.mjs
        → test/selfcheck.mjs     对应编号那一节

改的是 src/codex.mjs / codex-credentials.mjs / codex-convert.mjs
        → selfcheck.mjs 第 23–30 节，或对应的 codex-* 专项套件

改动 persona/ 下任何平台模块
        → test/selfcheck.mjs     第 31 节（自洽循环，自动覆盖）
                                 第 32/33 节（破绽拦截，需手写断言）
                                 第 34/35 节（派生与隔离）

改的是 messages / system 的缓存断点分配
        → cache-breakpoints.mjs（纯函数）+ breakpoints-demo.mjs（端到端）

改的是 src/prompt-profiles.mjs 的档位或 system 组装
        → prompt-profiles.mjs 套件

改的是 src/outbound-shape.mjs 的归约规则
        → outbound-shape.mjs 套件

改的是 src/codex-images.mjs 的生图协议
        → codex-images.mjs 套件

改的是 cch.mjs 的哈希或投影
        → 三套核心测试都要动：
          1. cch-check.mjs       加标准测试向量 / 参考实现比对
          2. cch-crosscheck.mjs  加新边界 case 到 CASES 数组
          3. selfcheck.mjs       如果影响 billing header 行为，补第 1 节

新增一个模块
        → selfcheck.mjs 末尾加一节（编号 36、37…）
```

`cch-crosscheck.mjs` 加 case 只需一行，两个循环会自动覆盖（投影 + cch 值），断言数 +2：

```js
const CASES = [
  // ...
  ['我的新边界', { model: 'x', my_weird_field: '带"引号的]值', messages: [] }],
]
```

### 6.4 已知的测试盲区

| 盲区 | 说明 | 建议 |
|---|---|---|
| `scheduler.mjs` 的并发与槽释放只在 HTTP 面间接覆盖 | `test/smoke-server.mjs` 覆盖了健康检查里的 `ready_slots`、帧驱动与进程收尾，但没有 20 并发打满后第 21 个请求回 503 的断言 | 用假 CLI 做 20 并发 → 第 21 个 503 的用例（见 `INTEGRATION.md` §6.4） |
| `CliHost` 的 spawn 失败分支只测到退出码层面 | `smoke-server.mjs` 覆盖了「CLI 不存在时进程仍存活并上报 `cli_error`」，但 `spawnError` 的 7 种 errno 映射没有逐条断言 | 补一个纯函数测试：构造带各 `code` 的 Error → 断言 `reason` 文案 |
| `prepareOutbound` 的组合行为没测 | 三步串联的交互（布局 + betas + cch） | 在 `selfcheck.mjs` 加一节 |
| `frames.mjs` 的 `validateHostReady` 只测了 camelCase 入参 | 真实帧是 snake_case，靠 `classifyStdoutFrame` 转换 | 补一条「原始帧 → 校验」的端到端断言 |
| `persona/cli.mjs` 没测 | 参数解析、写盘、退出码 | 用临时目录做端到端断言 |
| 平台 `warnings` 分支覆盖不足 | 只靠第 31 节的 `audit.length === 0` 间接保证默认骨架无 warn，`warnings(p)` 的每个 code 分支都没有单独断言 | 三平台的 warnings 各补一条「构造出该 warn → 断言 code 出现」 |
| `codex-convert.mjs` 的转换边界 | Chat ⇄ Responses 的字段映射有大量边界（工具调用、`response_format`、usage 缺字段），目前靠 `codex-upstream` / `codex-sse` 套件的间接覆盖 | 按转换函数逐个补纯函数断言 |

---

## 附：改动速查表

| 想做什么 | 改哪个文件 | 哪一段 | 测试加在哪 |
|---|---|---|---|
| 加 beta | `betas.mjs` | `BETA` 常量 + `withRequestProtocolBetas` | selfcheck 第 21 节 |
| 加机型（同家族换型号） | 不改代码 | 传 `overrides`（型号 + board_id 要成对） | selfcheck 第 31 节 |
| 加机型（新家族） | `persona/<platform>.mjs` | `DEFAULTS` 变体 + `KNOWN_BOARDS` / `OEM_SERIAL_RULES` | selfcheck 第 31/32/33 节 |
| 加平台 | `persona/<new>.mjs` + `persona/index.mjs` | 7 个导出 + `REGISTRY` 注册 | selfcheck 第 33 节式 + 31 节自动覆盖 |
| 换 Claude 上游 | `config.mjs` | `anthropic_base_url` 白名单那三行 | selfcheck 第 17 节 |
| 换 Codex 上游 | `config.mjs`（配置）+ `codex.mjs`（常量） | `codex_base_url` 校验 + `DEFAULT_CHATGPT_BASE` | selfcheck 第 25 节 |
| 改 system 布局 | `system-layout.mjs` | `layoutSystemBlocks` | selfcheck 第 2/3/4 节 |
| 改 cch 算法 | `cch.mjs` | `projectBillingFields` / `computeClaudeCodeCch` | 三套全动 |
| 加 HTTP 路由（Claude 面） | `server.mjs` | `buildPublicServer` / `buildGatewayWorkerServer` 的路由块 | `smoke-server.mjs` |
| 加 HTTP 路由（Codex 面） | `codex-server.mjs` | `handle()` 的分发链 | `codex-server.mjs` 套件 |
| 接 CLI 回程数据 | `server.mjs` | `submit()` 的 `onEvent` + `sse.mjs` 消费 | 需新建集成测试 |
| 改 Codex 传输细节 | `codex.mjs` | `CodexUpstream.createResponse` / `buildOutbound*` | `codex-upstream.mjs` |
| 改 Chat ⇄ Responses 转换 | `codex-convert.mjs` | 对应转换函数 | 补纯函数断言 |
| 换 token 刷新实现 | `codex-credentials.mjs` | `CredentialManager` 的 `refreshFn` 注入点 | 注入假 `refreshFn` 做断言 |
| 加配置字段 | `config.mjs` | `DEFAULT_WORKER_CONFIG` + `validateWorkerConfig` | selfcheck 第 17 节 |
| 加派生标识 | `persona/derive.mjs` | 新函数（不改现有 6 个） | selfcheck 第 34 节 |
