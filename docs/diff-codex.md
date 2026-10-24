# Codex 层对比（我们 vs 官方 v1.3.220）

对比基准：`research/vm2api` @ `2bb05cb7 release: cut v1.3.220`（含 `d6bf110f feat(openai): GPT 生图模型、Images 端点与模型页映射配置`）。
我们：`research/reimpl/src`。

本次 1.3.216→1.3.220 的协议层实际改动面（`git diff --stat`）：

```
src/lib/protocol/codex-model-mapping.mjs  |  15 ++
src/lib/protocol/codex-models.mjs         |  65 +++++++-
src/lib/protocol/gpt-model-policy.mjs     |  49 ++++++-
src/lib/protocol/handle-codex.mjs         | 233 +++++++++++++++++++++++++++++-
src/lib/protocol/handle-protocol.mjs      | 116 +++++++++++++++-
src/lib/protocol/image-edit-multipart.mjs |  87 +++++++++++
src/lib/protocol/image-tool-models.mjs    |  41 ++++++
src/lib/protocol/models.mjs               |  24 ++-
src/lib/protocol/outbound-attempt.mjs     |  35 +++--
```

关键结论先行：**生图我们已经做了，而且做得比预期完整**；真正没做的是 **模型别名映射**、**入站 WebSocket**、**额度窗口参与选号**、**usage 落库**、**OAuth 刷新本体**。

---

## 结论摘要

计数口径：以「独立能力」为单位，不按子条目重复计数。

- **封号风险项：5**
  1. 无入站模型别名重写，`codex-auto-review` 原名直发（官方重写为 `gpt-6-luna`）
  2. native Responses 路径不做 `role:system` → `developer` 改写
  3. native Responses 路径不做 `reasoning_effort` → `reasoning.effort` 归一化
  4. Codex 选号完全不看 5h/7d 额度窗口，超额号仍会被选中反复撞 429
  5. refresh_token 严格轮换策略（官方是宽容保留），可能误杀账号

- **功能缺失项：8**
  1. 模型目录同步（`/codex/models`）与新版 GPT id 探测
  2. Codex 搜索端点 `/alpha/search`（`web.run`）
  3. 额度探测端点 `/wham/usage`、`/wham/rate-limit-reset-credits`
  4. `analytics-events` 上报
  5. usage 落库 / 计费（`usage_logs`，含 042 的 image 列）
  6. `responses` 内 `image_generation` 工具的白名单校验
  7. 入站 WebSocket（`GET /v1/responses` Upgrade）
  8. OAuth 刷新本体（client_id / scope / PKCE / 网络调用）

- **已对齐：9**
  1. `stream:true` 强制
  2. `store:false` 强制
  3. 采样字段剔除（`max_output_tokens`/`max_tokens`/`temperature`/`prompt_cache_retention`）
  4. `service_tier` 的 `fast` → `priority` 改写
  5. UA / originator / version 三元组一致
  6. 生图端点、模型清单、snapshot 归一
  7. Free 计划排除 + 全 Free 池 403 `image_generation_unavailable`
  8. 生图 600s 超时 + `x-codex-image-turn-id` 粘性
  9. multipart → native Images JSON 逐字段转换

---

## 逐项对比

### 1. 上游地址与端点

- **官方**：
  - Responses 主路径经内核转发：`codex-kernel-client.mjs:49`、`:59`（`/internal/v1/codex/responses`）。上游基址在 `codex-models.mjs:16-17` 注释里写明：CLI 的 `{base_url}` 在 ChatGPT 登录下是 `https://chatgpt.com/backend-api/codex`。
  - `codex-models.mjs:15` — `https://chatgpt.com/backend-api/codex/models`
  - `codex-models.mjs:18` — `https://chatgpt.com/backend-api/codex/alpha/search`（`web.run` 搜索）
  - `codex-models.mjs:20` — `https://chatgpt.com/backend-api/codex/images/generations`
  - `codex-models.mjs:21` — `https://chatgpt.com/backend-api/codex/images/edits`
  - `codex-models.mjs:24` — `https://auth.openai.com/oauth/token`
  - `codex-models.mjs:25` — `https://auth.openai.com/oauth/authorize`
  - `codex-models.mjs:26` — `https://chatgpt.com/codex/desktop-auth`
  - `codex-models.mjs:27` — `http://localhost:1455/auth/callback`
  - `codex-models.mjs:39` — `https://registry.npmjs.org/@openai%2fcodex/latest`（catalog 客户端版本源）
  - `openai-quota.mjs:21` — `https://chatgpt.com/backend-api/wham/usage`
  - `openai-quota.mjs:22` — `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
  - `handle-codex.mjs:1072` — 搜索路径要额外剔除 `prompt_cache_key`/`prompt_cache_retention`/`store`

- **我们**：
  - `codex.mjs:25` — `DEFAULT_CHATGPT_BASE = 'https://chatgpt.com/backend-api/codex'`
  - `codex.mjs:857` — 注释写明 `https://chatgpt.com/backend-api/codex/responses`
  - `codex-images.mjs:482` — `imageUrls()` 由 base 拼 `/images/{generations,edits}`
  - `codex.mjs:26` — `DEFAULT_OAUTH_TOKEN_URL`，**但全仓零引用**（`grep` 仅命中定义处）
  - `codex.mjs:28` — `ANALYTICS_PATH = '/analytics-events/events'`，同样**零引用**，只作为配置字段出现（`codex.mjs:126`）
  - 缺失：`/codex/models`、`/codex/alpha/search`、`/wham/usage`、`/wham/rate-limit-reset-credits`

- **差异**：Responses 与 Images 两条端点是对齐的（同宿主同前缀）。我们缺 5 个端点，其中 4 个是纯能力缺口，1 个（`ANALYTICS_PATH`）是写了常量没接线。另外官方的 Responses 出站由内核完成，我们是 Node 层直连，这带来一个结构性差别：官方 `computedUpstreamTransport()`（`codex-route.mjs:116-118`）的 transport 决策会被内核执行，我们的决策没有执行者（详见第 5 项）。

- **风险**：**低**（端点缺失不导致封号）。但缺 `/codex/models` 意味着模型清单永久停留在硬编码状态，见第 3 项。

- **建议**：优先补 `/codex/models` 同步（它同时解决第 3 项的清单陈旧问题）；`/wham/usage` 补上后可支撑第 8 项的额度 park；`alpha/search` 按需；`ANALYTICS_PATH` 要么接线要么删掉，避免留下"看起来支持"的假象。

### 2. 请求体

- **官方**：
  - `handle-codex.mjs:785` — 出站前强制 `{ ...converted.body, stream: true }`
  - `handle-codex.mjs:191-198` — `applyCodexRebuildBody()`：rebuild 模式下 `out.prompt_cache_key = sessionId`（`:194`），并删除 `conversation_id`、`session_id`
  - `codex-convert.mjs:201-202` — Chat→Responses 时 `stream: body.stream !== false`、`store: false`
  - `codex-convert.mjs:222-223` — Completions→Responses 同样是 `stream`/`store: false`
  - `codex-convert.mjs:252-286` — `stripUnsupportedCodexFields()`，native 直传也会过：
    - `:255-257` `service_tier` 的 `fast` → `priority`
    - `:258-261` 删除 `max_output_tokens`、`max_tokens`、`temperature`、`prompt_cache_retention`
    - `:262-271` `reasoning_effort` 归一化并折叠进 `reasoning.effort`，无 effort 时删 `reasoning`
    - `:272-276` `tool_choice` 归一化，非法值删除
    - `:277-284` `input[]` 里 `role: 'system'` → `role: 'developer'`
  - `codex-convert.mjs:288-295` — `normalizeCodexResponsesInput()` 是 `openai.responses` 唯一入口，结尾必走 `stripUnsupportedCodexFields`
  - `codex-convert.mjs:313-315` — `toCodexResponses()` 的 native 分支确认走上面这条链

- **我们**：
  - `codex.mjs:414` — `out.store = false`
  - `codex.mjs:420` — `out.stream = true`
  - `codex.mjs:422-425` — `service_tier` 归一化 `fast`→`priority`
  - `codex.mjs:229-233` — `STRIP_IDENTITY_KEYS`，含 `max_output_tokens`、`max_tokens`、`temperature`、`prompt_cache_retention`
  - `codex.mjs:427` — 按该清单删除
  - `codex.mjs:432-440` — `client_metadata`（含 `x-codex-installation-id`）按开关注入
  - `codex-server.mjs:311-320` — `stripUnsupportedSampling()` 只删 `SAMPLING_FIELDS`
  - `codex-convert.mjs:227-232` — `SAMPLING_FIELDS` = temperature/top_p/top_k/frequency_penalty/presence_penalty/stop/stop_sequences/seed/logprobs/top_logprobs/n
  - `codex-server.mjs:329-344` — 顶层 `response_format`/`verbosity` 提升进 `text`
  - **缺失**：`prompt_cache_key`、`role:system`→`developer`、`reasoning` 归一化、`tool_choice` 归一化

- **差异**：
  1. **`prompt_cache_key` 我们没有**。官方在 rebuild 模式下把它设为会话 id，让同一会话的多轮命中同一份前缀缓存。我们不写该字段，同时 `codex.mjs:232` 又把客户端传来的 `prompt_cache_retention` 删了——结果是既不指定缓存键，也不指定保留策略，每轮请求都是一段独立的、无法复用的上下文。
  2. **`role:system` 不改写**。官方 native 路径明确把 `system` 换成 `developer`（`codex-convert.mjs:279-281`），我们只在 **Chat 转换**路径处理（`codex-convert.mjs:282`），native 直传路径原样保留 `system`。
  3. **`reasoning_effort` 不归一化**。官方折叠成 `reasoning.effort` 并校验取值域（`none/low/medium/high/xhigh/max`，`codex-convert.mjs:240`）；我们把 `reasoning_effort` 当普通透传字段（`codex-convert.mjs:237` 的 passthrough 清单里）。
  4. **`tool_choice` 不归一化**。官方会把 Chat 的嵌套形状抬成 Responses 顶层形状，非法值删除；我们不处理。
  5. 一处内部张力（不构成与官方的差异，但值得知道）：`codex-convert.mjs:337-339` 的 Chat 路径把 `max_tokens` 算成 `body.max_output_tokens`，随后 `executeCodexRequest`（`codex.mjs:1140`）调 `buildOutboundBody`，`:427` 又把它按 `STRIP_IDENTITY_KEYS` 删掉。**最终行为与官方一致**（官方 `codex-convert.mjs:258` 也删），但我们的实现是"先算出来再删"，且把 `max_output_tokens` 归类为「身份键」（`codex.mjs:203-206` 的注释说的是 base_url/hostname/api_key 这类），归类理由与事实不符。

- **风险**：**高**。
  - 第 2 点：Codex 上游对角色名敏感，`system` 进去很可能被当作未知角色忽略或报错——系统提示被静默丢弃时，模型行为退化成"没有指令"，这是最容易被判为异常流量的一类偏差。
  - 第 3 点：`reasoning_effort` 作为裸字段发过去不保证被识别，effort 静默失效会让同一个账号的推理档位与官方客户端不一致。
  - 第 1 点：缺 `prompt_cache_key` 不是"少省一点钱"，而是每轮重复上传完整上下文，token 消耗曲线与官方客户端明显不同。

- **建议**：把 `stripUnsupportedCodexFields` 的语义整体移植到 `buildOutboundBody`，尤其是 `system`→`developer` 和 `reasoning` 折叠，这两项属于"发错形状"而非"少个优化"。`prompt_cache_key` 用我们已有的 `session_id`（`codex.mjs:436`）填即可，与官方 `handle-codex.mjs:194` 同源。

### 3. 模型映射

- **官方**：
  - `codex-model-mapping.mjs:13-15` — 默认映射只有一条：`{ 'codex-auto-review': 'gpt-6-luna' }`
  - `codex-model-mapping.mjs:11` — `codex-auto-review` 被清空时的兜底目标 `gpt-6.1-sol`
  - `codex-model-mapping.mjs:126-144` — `applyCodexInboundModelRewrite()`：查映射表，命中则重写并回 `{ mapped, requestedModel, upstreamModel }`；未命中**原样透传**（`:133`）
  - `codex-model-mapping.mjs:115-121` — `rewriteModelField()` 只替换最后一节，保留 `provider/` 前缀
  - `codex-model-mapping.mjs:60-77` — 目标必须是启用的 GPT chat id（`isGptSeriesId` + `isGptModelEnabled`）
  - `codex-model-mapping.mjs:88-99` — 别名不得含空白/控制字符、不得是 Anthropic 名、不得是图像模型（因为重写发生在平台判定之前，会劫持）
  - `handle-protocol.mjs:652` — 在 `detectInboundPlatform`（`:670`）**之前**执行重写
  - `handle-protocol.mjs:666-669` — 命中时替换 `ctx.body` 并把 `upstream_model` 记进日志
  - `gpt-model-policy.mjs:52-59` — seed 清单：`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex`
  - `gpt-model-policy.mjs:56` — `gpt-5.4` 自带别名 `codex`
  - `gpt-model-policy.mjs:193-239` — `syncGptIdsIntoPolicy()` 用上游目录替换清单，**新出现的 id 默认 `enabled: false`**（`:218`），等管理员放行
  - `gpt-ids.mjs:14-19` — `isSyncableGptCatalogId()` 排除 `luna-wm` / `-wm` 变体（`gpt-6-luna` 是正式模型，`luna-wm` 会 400）
  - `codex-models.mjs:186` / `:205` — `parseCodexModelCatalog()` / `parseChatgptModelIds()`

- **我们**：
  - **没有任何模型重写层**。`grep` `rewriteModel|applyModelMapping|resolveModel|mapModel` 在 `codex.mjs`/`codex-server.mjs`/`codex-convert.mjs` 全部零命中。
  - `codex-server.mjs:50` — `DEFAULT_CODEX_MODEL = 'gpt-6-astra'`
  - `codex-server.mjs:53-56` / `config.mjs:107-109` — 硬编码允许清单 `['gpt-6.1-sol','gpt-6-astra','gpt-6-sol','gpt-reserve','gpt-6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','codex-auto-review']`
  - `codex-server.mjs:675` — `/v1/models` 直接把该清单列出去
  - `config.mjs:300-301` — 只在启动时校验 `default_model` 属于清单；**请求期不校验 model 是否存在**
  - 无目录同步

- **差异**：
  - 官方的映射是**白名单式**，不是"把 gpt-6 改写成内部名"。默认只改写 `codex-auto-review` 一条，其它 model（含 `gpt-6-astra`、`gpt-6-sol`、`gpt-reserve`）**原名直发**。所以"官方把 gpt-6 映射到内部名而我们直发 gpt-6 会被降级"这个怀疑，**对普通 gpt-6 不成立**。
  - 但 `codex-auto-review` **确实成立**：官方把它当别名，重写成 `gpt-6-luna`；我们把它当真实模型 id，在 `codex-server.mjs:55` 允许它、并在请求时原名发出去。
  - 清单来源：官方是「seed 兜底 + 上游 `/codex/models` 同步 + 新 id 默认停用」；我们是「一次写死的静态数组」。我们的清单里有 `gpt-6-astra`、`gpt-reserve`、`gpt-5.6-terra` 这些官方 seed 里没有的名字，说明当初是按实测或传闻写的，之后不会自动跟随上游。
  - 官方还额外拦了 `luna-wm` 这类会 400 的变体（`gpt-ids.mjs:17`），我们没有对应过滤。

- **风险**：**高**（`codex-auto-review` 一项）。
  - 上游若把 `codex-auto-review` 当未知模型，可能直接 400/404，也可能落到某个默认模型上——后者更糟，客户端以为在用 review 专用模型，实际跑的是别的东西，且这种"静默降级"在日志里看不出来。
  - 静态清单 + 无请求期校验的组合，会让任何上游改名都表现为线上故障，而不是一条降级警告。

- **建议**：
  1. 立刻加一层最小的别名表，把 `codex-auto-review` → `gpt-6-luna`（对齐 `codex-model-mapping.mjs:14`），并在日志里同时记 requested/upstream 两个 id（对齐 `handle-protocol.mjs:668`）。
  2. 把别名重写放在**平台判定之前**，否则别名一旦长得像 Claude 名就会劫持 Claude 流量——官方在 `codex-model-mapping.mjs:88-99` 用三条校验专门防这个。
  3. 中期把静态清单换成 `/codex/models` 同步，并采用官方的"新 id 默认停用"策略，避免上游新增一个 id 就自动对我们生效。

### 4. 图片 / Images 端点

- **官方**：
  - `codex-models.mjs:20-21` — generations / edits 两个端点
  - `image-tool-models.mjs:6-21` — `IMAGE_TOOL_MODELS`：`gpt-image-2.5-flare`（`upstream_default: true`）、`gpt-image-2.5-sunburst`，snapshot 均为 `*-2026-09-08`
  - `image-tool-models.mjs:30-35` — `canonicalImageToolModel()`，snapshot 归一
  - `image-tool-models.mjs:38-41` — `imageGenerationTools()` 找 `tools[]` 里 `type === 'image_generation'`
  - `handle-codex.mjs:1309-1448` — `handleCodexImages()` 全流程
  - `handle-codex.mjs:1292` — `CODEX_IMAGES_TIMEOUT_MS = 600000`，注释说明官方对这两个 JSON 端点不设 total deadline，只设 connect timeout
  - `handle-codex.mjs:1299-1302` — `isFreePlanSlot()`，Free 计划排除
  - `handle-codex.mjs:1339-1346` — 模型被策略停用时 400 `model_disabled`
  - `handle-codex.mjs:1350-1362` — 全池只有 Free → 403 `image_generation_unavailable`
  - `handle-codex.mjs:1363-1365` — `x-codex-image-turn-id` 透传上游
  - `handle-codex.mjs:1368` — 该 turn id 同时用作粘性会话键
  - `handle-codex.mjs:1444-1446` — 成功响应里的 `payload.usage` 收进 `logBag.image_usage`
  - `handle-codex.mjs:378-382` — Responses 路径也校验 `image_generation` 工具指定的模型是否启用
  - `handle-codex.mjs:609` — 被拒文案
  - `image-edit-multipart.mjs:6` — 数字字段 `n`/`output_compression`/`partial_images`
  - `image-edit-multipart.mjs:17-26` — 按 magic bytes 判 PNG/JPEG/WebP，转 `data:` URL
  - `image-edit-multipart.mjs:28-47` — 数字/布尔字段严格解析，其余按文本保留
  - `image-edit-multipart.mjs:52-87` — `normalizeImageEditBody()`，`images[]` 保序、`mask` 单独
  - `042_usage_logs_image_generation.sql:6-10` — `image_model`/`image_usage`/`image_input_tokens`/`image_output_tokens`/`image_cost`

- **我们**：
  - `codex-images.mjs:40` — `IMAGE_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']`
  - `codex-images.mjs:43` — `DEFAULT_IMAGE_MODEL = 'gpt-image-2.5-flare'`
  - `codex-images.mjs:46-48` — snapshot 映射，两个 `-2026-09-08` 都在
  - `codex-images.mjs:72-73` — canonical 归一
  - `codex-images.mjs:52` — `IMAGE_TIMEOUT_MS = 600_000`
  - `codex-images.mjs:121-124` — `imageGenerationAvailable()`，Free 计划判定，空/未知计划放行
  - `codex-images.mjs:128-145` — `planTypeFromIdToken()`，从 id_token 的 JWT payload 读 `chatgpt_plan_type`（不验签）
  - `codex-images.mjs:620`、`:676` — 全 Free 池 → 403 `image_generation_unavailable`
  - `codex-server.mjs:591` — `handleImages()` 入口
  - `codex-images.mjs:447-478` — `normalizeImageEditBody()`，注释明确说对齐 `image-edit-multipart.mjs`
  - `codex-images.mjs:482` — `imageUrls()`
  - `config.mjs:118` — 生图模型启停清单

- **差异**：
  - **端点是有的，模型清单是对的，snapshot 也对**。这一项比预期好：父级担心的"1.3.220 新增能力我们完全没有"**不成立**。
  - multipart 转换逐字段对齐（数字字段集合、`stream` 布尔、magic-byte 判型、`images[]` 保序、`mask` 独立、未知名保留）。差别只在实现手段：官方用 `new Request().formData()`（`image-edit-multipart.mjs:55-59`），我们自己写了解析器（`codex-images.mjs:447+`）。自研解析器少了标准库的边界覆盖，属于实现风险而非对齐风险。
  - **真正的缺口一**：Responses 路径不校验 `image_generation` 工具指定的模型。官方在 `handle-codex.mjs:378-382` + `:609` 做了"工具里点名的图像模型若被停用则整个请求拒绝"；我们只在 `/v1/images/*` 这条路上判（`codex-images.mjs:650`），`/v1/responses` 里带 `tools:[{type:'image_generation', model:'gpt-image-2.5-sunburst'}]` 时不会拦。
  - **真正的缺口二**：生图 usage 不落库。官方 `handle-codex.mjs:1444-1446` 收 `image_usage`，配 042 五个列做计费；我们目前没有 usage_logs 表（见第 6 项）。
  - 官方 `isFreePlanSlot`（`:1299-1302`）读 `vm.codex.plan_type`，读不到再退回凭据里的 `chatgpt_plan_type`；我们走的是 `planTypeFromIdToken()`（`codex-images.mjs:128-145`）从 id_token 的 JWT payload 解 `chatgpt_plan_type`，再经 `loadPlanTypes()`/`withPlanTypes()`（`:166`、`:190`）贴到账号上。**这一项我们更完整**。判定口径也一致：官方 `plan === 'free'` 才排除，我们 `imageGenerationAvailable()` 对空/未知计划返回 `true`（`:121-124`），两边都是"判不出来就放行"。

- **风险**：**中**。端点可用，风险集中在两处：Responses 内图像工具不校验（付费能力被越过策略使用，账面上看是"策略无效"），以及生图用量不计费（成本黑洞，且缺少与上游对账的依据）。Free 计划排除本身**已对齐且实现更细**，不是风险点。

- **建议**：把 `imageGenerationTools()` 的校验补进 `/v1/responses` 入口，文案沿用 `image_generation model '<x>' is disabled by gateway GPT model policy`；`image_usage` 先落原始 JSON（对齐 042 的设计意图：保留原始结构以便日后重新定价）。

### 5. WebSocket

- **官方**：分两层，别混为一谈。
  - **入站 WS（JS 实现，完整）**：`responses-ws.mjs:1-7` 文件头写明 `Inbound OpenAI Responses WebSocket (GET /v1/responses Upgrade)`，每个 `response.create` 都走 `handleProtocol`（鉴权、限流、调度、计费、日志），下游只看到 JSON 帧、永远看不到 SSE。
    - `responses-ws.mjs:19-21` — `isResponsesWsPath()` 认 `/v1/responses` 与 `/responses`
    - `responses-ws.mjs:15-17` — 队列上限 32、replay 上限 32 条 / 8MB
    - `responses-ws.mjs:189` — `createConnectionReplay()`
    - `responses-ws.mjs:450-457` — `createResponsesWsHandler()`，`new WebSocketServer({ noServer: true, maxPayload })`
  - **出站 WS（JS 层没有实现）**：只有配置与决策，执行在内核二进制里。
    - `codex-route.mjs:11` — `CODEX_UPSTREAM_TRANSPORTS = ['prefer_websocket', 'http']`
    - `codex-route.mjs:21` — 默认 `upstream_transport: 'prefer_websocket'`
    - `codex-route.mjs:13`、`:22` — `websocket.enabled` 默认 `true`
    - `codex-route.mjs:111-118` — `inferenceWebsocketEnabled()` / `computedUpstreamTransport()`
    - `grep` 在官方 `src/` 下找不到任何出站 `new WebSocket(...)` 去连 `chatgpt.com`，也没有 `worker/` 里的 Go 实现——决策生成后交给内核执行。

- **我们**：
  - `codex.mjs:186-196` — `responsesWsUrl()`：https→wss、http→ws，拼 `/responses`
  - `codex.mjs:476-479` — `chooseTransport()`：body 超 `WS_BODY_LIMIT` 走 http，`requested === 'prefer_websocket'` 才试 WS
  - `codex.mjs:31` — `WS_BODY_LIMIT = 0xf00000`
  - **两个函数全仓零调用点**（`grep -rn "chooseTransport\|responsesWsUrl"` 只命中定义处两行）
  - **没有 `ws` 依赖**（`grep "from 'ws'"` 零命中）
  - 无入站 WS 端点

- **差异**：
  - 官方**支持 WS**，而且是双向的：入站给客户端用 WS 连（JS 完整实现），出站由内核按 `prefer_websocket` 决策。
  - 我们**实际是 100% HTTP**。WS 相关代码是写了但没接线，`chooseTransport` 从未被调用，`responsesWsUrl` 从未被调用，连 `ws` 包都没装。
  - 所以"官方用 WS 而我们用 HTTP，出站形状差异明显"的怀疑，**结论成立但机制不同**：不是我们选了 HTTP，而是出站 WS 这条路径根本没接通；同时我们也完全不接受入站 WS 客户端（客户端发 Upgrade 会落到普通 HTTP 处理）。

- **风险**：**中**。
  - 出站：官方默认 `prefer_websocket`，说明这是上游期望的主流形态。纯 HTTP SSE 长期是否被区别对待，代码里无法判定，但形状差异客观存在。
  - 入站：任何用 WS 连 Responses 的客户端在我们这里直接不可用，属硬功能缺失。
  - 死代码本身是维护风险：`chooseTransport` 的注释（`codex.mjs:468-479`）描述了一套并不存在的路由行为，会误导后续维护者以为 WS 已支持。

- **建议**：先决定取舍，别留半成品。
  - 若短期不做 WS：删掉 `responsesWsUrl`/`chooseTransport`，或至少在注释里标注 `未接线`，否则读代码的人会以为运输层已经能走 WS。
  - 若要做：入站 WS 的成本远低于出站 WS（官方 `responses-ws.mjs` 的做法是把 WS 帧桥接回 `handleProtocol`，复用整条 HTTP 链路），建议先做入站。出站 WS 涉及长连接池、帧级心跳、断线重放，官方把这块丢给内核是有道理的。

### 6. usage 统计

- **官方**：两层，别混。
  - **token usage**（推理结果里的用量）：
    - `handle-codex.mjs:885-886` — `preferUsage(hopUsage, streamedUsage)`，非流式与流式两个来源择优
    - `handle-codex.mjs:896` — `disjointOpenaiUsage()` 拆分
    - `handle-codex.mjs:901-902` — `input_tokens` / `output_tokens`
    - `handle-codex.mjs:903-908` — `cache_read_tokens`，回退链 `input_tokens_details.cached_tokens` → `cache_read_tokens`
    - `handle-codex.mjs:909-914` — `cache_creation_tokens`，回退链 `input_tokens_details.cache_write_tokens` → `cache_creation_tokens`
    - `handle-codex.mjs:915-918` — 记 `upstream_model` 与 `codex_failed_over`
    - `handle-codex.mjs:352-361` — `usageFromSseLine()` 从 SSE 数据行取 usage
    - `handle-codex.mjs:363-373` — `imageGenUsageFromSseLine()` 取 `response.tool_usage.image_gen`
    - `openai-usage.mjs:147-160` — `disjointOpenaiUsage()`：转成 Anthropic 口径后**删掉** `input_tokens_details`/`prompt_tokens_details`/`prompt_tokens`/`completion_tokens`/`cached_tokens`/`cache_write_tokens`，即落库的是拆分后的干净字段，不是上游原始嵌套
    - `037_usage_logs_billing_normalize.sql:3`、`:17` — 新写入的 `input_tokens` 是**不含 cache 的**（cache 读写各自独立列）
    - `042_usage_logs_image_generation.sql:6-10` — 生图五个列
  - **额度 usage**（账号额度窗口，用于调度）：
    - `codex-usage.mjs:30-61` — `extraFromCodexHeaders()` 读 `x-codex-{primary,secondary}-used-percent`、`-window-minutes`、`-reset-at`、`-reset-after-seconds`，加上 `x-codex-primary-over-secondary-limit-percent`、`x-codex-rate-limit-reached-type`
    - `codex-usage.mjs:42-47` — `-reset-at`（绝对秒）优先，`-reset-after-seconds`（相对）兜底
    - `codex-usage.mjs:72-89` — `codexQuotaPark()`：某窗口 used ≥ 100 且有未来 reset → 停到最早 reset；无 reset 时钟 → 默认停 60s（`:64`）
    - `codex-usage.mjs:95` — credits 读数可豁免窗口上限，TTL 10 分钟
    - `codex-usage.mjs:117-128` — credits 归一（`has_credits` 与 `unlimited` 两个 flag 都要在）

- **我们**：
  - **token usage**：只有出向转换，没有落库。
    - `codex-convert.mjs:420-436` — `responsesUsageToChatUsage()`：`input_tokens`→`prompt_tokens`、`output_tokens`→`completion_tokens`、补 `prompt_tokens_details.cached_tokens` 与 `completion_tokens_details.reasoning_tokens`
    - `codex-server.mjs:555-558` — 流式默认带 usage，尊重 `stream_options.include_usage=false`
    - 无 `usage_logs`、无计费、无 `image_usage`、无 `disjoint` 拆分
  - **额度 usage**：部分解析，未参与选号。
    - `quota-window.mjs:251-268` — `codexWindow()` 读 `x-codex-{slot}-used-percent`/`-reset-at`/`-window-minutes`/`-status`
    - `quota-window.mjs:280-304` — `parseQuotaHeaders()` 组装 5h/7d
    - **缺** `-reset-after-seconds`、`primary-over-secondary-limit-percent`、`rate-limit-reached-type`

- **差异**：
  - 我们的 usage 结构**只用于对外应答**，不落库。所以"上报的 usage 结构对不对"这个问题，答案是：**对客户端是对的**（Chat 口径的四组字段齐全，`cached_tokens`/`reasoning_tokens` 都补了），但**内部没有任何 usage 账本**，无法做计费、无法对账、无法回答"这个账号这个窗口用了多少"。
  - 字段口径差异：官方的 `input_tokens` 落库时**已剔除 cache**（037 的规范），我们的 `responsesUsageToChatUsage` 里 `prompt_tokens` 直接取 `usage.input_tokens` 原值，`cached_tokens` 是并列的 detail——这是 OpenAI Chat 的标准口径，没错，但**不能直接当官方 usage_logs 的 `input_tokens` 用**，将来接计费必须减掉 cache 部分，否则会重复计价。
  - 额度头解析不完整：缺 `-reset-after-seconds` 意味着老版本上游只发相对时间时我们拿不到 reset 时刻（官方 `codex-usage.mjs:42-47` 专门为这个兜底）；缺 `rate-limit-reached-type` 意味着我们分辨不出"哪个窗口超了"。
  - `quota-window.mjs` 的解析结果目前只服务 Claude 侧 `scheduler.mjs`，Codex 选号不读它。

- **风险**：**中**（当前）/ **高**（接计费时）。
  - 眼下没有账本，出问题时无法回答"这条 429 是哪个窗口打满的"，排障只能靠上游日志。
  - 一旦把现有 `prompt_tokens` 直接写进计费列，会与官方口径差一个 cache 量级，属于会直接算错钱的坑。

- **建议**：
  1. 落库前先定口径：`input_tokens` 用 `prompt_tokens - cached_tokens`，`cache_read_tokens` 与 `cache_creation_tokens` 独立列，对齐 037/官方的拆分方式。
  2. 补 `-reset-after-seconds` 与 `rate-limit-reached-type` 两个头，这是第 8 项能落地的前提。
  3. `image_usage` 存原始 JSON（官方 042 的注释就是这个意图：保留原始结构以便日后重新定价）。

### 7. OAuth 刷新

- **官方**：
  - `codex-models.mjs:24` — token 端点 `https://auth.openai.com/oauth/token`
  - `codex-models.mjs:28` — `CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'`
  - `codex-models.mjs:29` — `CODEX_OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'`
  - `codex-models.mjs:30` — `CODEX_OAUTH_ORIGINATOR = 'Codex Desktop'`
  - `codex-models.mjs:33` — `CODEX_APP_VERSION = '0.160.0'`
  - `codex-models.mjs:37-38` — `CODEX_CATALOG_ORIGINATOR = 'codex_cli_rs'`，`CODEX_USER_AGENT = 'codex_cli_rs/0.160.0 (linux x86_64)'`
  - `codex-models.mjs:34-36` — 注释点明约束：模型端点会校验 originator 与 UA 前缀一致；OAuth 用 desktop originator，catalog 用 cli originator
  - `codex-models.mjs:257-297` — `refreshCodexAccessToken()`：`grant_type=refresh_token` + `refresh_token` + `client_id` + `scope`，`user-agent` 用 `CODEX_USER_AGENT`（`:273`），无 `client_secret`
  - `codex-models.mjs:289` — **轮换宽容**：`refresh_token: String(payload?.refresh_token || refreshToken).trim() || refreshToken`，上游没回新 token 就继续用旧的
  - `codex-models.mjs:279-282` — 401/403 归 `refresh_rejected`，其余 ≥400 归 `refresh_failed`
  - `codex-models.mjs:303-340` — `exchangeCodexAuthorizationCode()`：`grant_type=authorization_code` + `client_id` + PKCE，`:330-336` 取新 refresh_token

- **我们**：
  - `codex.mjs:27` — `DEFAULT_CODEX_UA = 'codex_cli_rs/0.160.0 (linux x86_64)'`，与官方 `codex-models.mjs:38` 完全一致
  - `codex.mjs:26` — `DEFAULT_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'`，**零引用**
  - `codex-credentials.mjs:20-25` — 注释明确写着「**本模块不做刷新**……只留 `refreshFn` 注入点」
  - `codex-credentials.mjs:288-320` — `refreshFn` 与 `store` 二选一，`store` + `refreshFn` 时自建 `TokenRefresher`（`:306-309`）
  - `codex-credentials.mjs:354-358` — 需要刷新但没注入实现时抛「codex credential needs refresh but no refreshFn injected」
  - `codex-server.mjs:163` — `refreshFn: opts.refreshFn || null`，**默认 null**
  - `token-refresh.mjs:593-597` — 严格轮换：`refresh_token: rotatedRefreshToken`，没返回就写空串
  - `token-refresh.mjs:623-636` — 未轮换则标 `needs_reauth`，reason `refresh_token_not_rotated`
  - `token-refresh.mjs:60-65` — 可识别的致命错误码清单（`invalid_refresh_token`/`refresh_token_reused`/`refresh_token_expired`）
  - 全仓**无 `client_id`、无 `scope`、无 PKCE、无对 `oauth/token` 的 POST**

- **差异**：
  - **我们没有刷新实现**，只有"刷新调度框架"（单飞、generation 乐观锁、退避、错误分类都写了，`token-refresh.mjs` 共 783 行）+ 一个空插槽。`refreshFn` 从未被赋予实现。
  - 缺的全部是"能真正发出请求"的东西：`client_id`、`scope`、`grant_type` 请求体、`user-agent`、PKCE（`code_verifier`）。
  - 策略相反：官方轮换宽容（`:289` 旧 token 兜底），我们轮换严格（`token-refresh.mjs:593-597` 没返回就置空并判 `needs_reauth`）。
  - 我们的严格策略有个真实风险：上游在「已轮换但响应丢失」时不会再回新 token，此时按我们的逻辑账号直接进 `needs_reauth`，需要人工重新授权。官方用旧 token 兜底正是为了扛这个场景（`token-refresh.mjs:13` 的注释其实也提到了这个场景，但实现选了相反方向）。
  - UA 这一项**已对齐**，且我们的 `parseUserAgent`（`codex.mjs:353-358`）从 UA 切出 originator/version 再分别发（`:379`、`:392`），与官方 `codex-models.mjs:34-36` 的"三者必须一致"要求同向。

- **风险**：**高**。
  - 功能上：token 过期后无法自愈，只能靠人工重新导出凭据。`codex-server.mjs:689` 的注释自己也承认"理论上可救，但没有注入 refreshFn 实际发不出请求"。
  - 策略上：严格轮换会把「响应丢失」误判成「凭据已废」，这是**误杀账号**类的风险——不是封号，但效果一样（号还在，用不了，且要人工介入）。

- **建议**：
  1. 补齐 `refreshCodexAccessToken` 的等价实现，参数照 `codex-models.mjs:261-276` 逐字对齐（client_id、scope、UA、form-urlencoded）。
  2. 轮换策略改成官方的宽容版：上游没回新 token 就保留旧的，不要置空。要区分「上游明确拒绝」和「上游没说话」——前者才该 `needs_reauth`。
  3. `DEFAULT_OAUTH_TOKEN_URL` 现在是死常量，接线后自然消解。

### 8. 账号调度

- **官方**：
  - `codex-slot-pool.mjs:174-185` — `codexAccountStatus()` 五态：`disabled` / `error` / `cooldown` / `quota_exhausted` / `normal`。`:183` 的 `quota_exhausted` 由 `isCodexSlotParked()` + `codexQuotaWindowReason()` 判定，即**读 5h/7d 窗口**
  - `codex-slot-pool.mjs:188-191` — `codexSlotAllowsModel()`，按槽位允许清单过滤模型
  - `codex-slot-pool.mjs:227-327` — `orderCodexSessionSlots()`：pin → 排除 → home/sticky → session window 上限 → 策略排序（`smart` / round-robin 游标）→ 返回 `ids`/`ready`/`parked`/`candidates`
  - `codex-slot-pool.mjs:264-276` — `home` / `boundState`（`live`/`excluded`/`resting`/`gone`）
  - `codex-slot-pool.mjs:277-287` — `claimsWindow` / `accepts`，配合 `sessionLimit.canAccept`，满了回 `session_window_full`
  - `codex-slot-pool.mjs:298-313` — 全不可用时区分 `quota_exhausted` 与 `capacity_unavailable`，并算 `retryAt`（`:301`）
  - `codex-slot-pool.mjs:329-333` — `codexMaxSessions()`，单槽最大会话窗口数
  - `handle-codex.mjs:152-163` — `codexFailoverBudget()`：`maxAttempts` 默认 12（上限 64）、`maxSwitches` 默认 3、`maxSameAccountRetries` 默认 3
  - `handle-codex.mjs:166-189` — `isRetryableSameCodexAccount()`：`content_policy`/`refusal`/`usage_policy`/`guard`/`tool_arguments_mismatch` **不重试**；transport 错、408、500/502/503/504（且 code 属 server/overloaded 类）才重试
  - `handle-codex.mjs:212-236` — `pickCodexCandidates()`，pin 优先，pin 不合法时按 `model_not_allowed` / `platform_mismatch` 精确报错
  - `handle-codex.mjs:239-241` — 每次选号前 `syncCodexQuotaSchedule()`
  - `codex-usage.mjs:72-89` — park 逻辑（见第 6 项）

- **我们**：
  - `codex.mjs:529-554` — `AccountScheduler`：两张亲和表（session / thread）、`inflight`、`rpmSamples`、`cooldownUntil`
  - `codex.mjs:563-584` — `canTake()`：**只判三样** — 未冷却、未超 `max_concurrency`、未超本地 RPM
  - `codex.mjs:597-640` — `select()`：① session 亲和 → ② thread 亲和 → ③ 全表首个可用
  - `codex.mjs:506-525` — 冷却常量：默认 30s、429 用 60s、过载用 5s
  - `codex.mjs:725-735` — 冷却时长优先级：`Retry-After` → 429 用 `RATE_LIMIT_COOLDOWN_SECS` → 否则默认
  - `codex.mjs:1119-1145` — `executeCodexRequest()`，`maxAttempts` 默认 3（`codex-server.mjs:155`）
  - `codex.mjs:1155-1195` — 换号主循环，`:1165` 已被试过的账号直接 break
  - `codex.mjs:1200-1207` — 可重试判定：`/overloaded|unavailable|timeout|rate|internal|server_error|server_is_overloaded/`
  - `codex-server.mjs:167` — `new AccountScheduler(loaded.accounts)`，**没有传入任何额度/计划信息**
  - `codex.mjs` 内 `grep quota|quotaStore|parseQuotaHeaders|usedPct` **零命中**

- **差异**：
  - **核心差异：选号不看额度**。官方 `codexAccountStatus` 的第 4 个状态 `quota_exhausted` 在我们的 `canTake` 里不存在。`AccountScheduler` 只拿到账号列表（`codex-server.mjs:167`），拿不到窗口读数，`quota-window.mjs` 的解析结果也就不可能参与决策。
  - 后果是：一个 5h 窗口已打满的号，只要不在本地冷却期内，仍会被选中发请求。上游回 429 → 冷却 60s → 冷却到期再被选中 → 再 429。官方在 `codex-usage.mjs:72-89` 的 park 正是为了避免这个循环（停到窗口 reset，而不是每次只停 60s）。
  - **失败转移预算差距**：官方 `maxAttempts` 默认 12、可换号 3 次、同号重试 3 次（`handle-codex.mjs:158-162`）；我们 `maxAttempts` 默认 3（`codex-server.mjs:155`），且 `tried` 集合保证同一账号只试一次。账号多时我们的转移能力明显更弱。
  - **不可重试清单差距**：官方显式排除 `content_policy`/`refusal`/`usage_policy`/`guard`/`tool_arguments_mismatch`（`handle-codex.mjs:175-180`）。我们的正则（`codex.mjs:1205`）只有"可重试"白名单，没有"绝不重试"黑名单——`content_policy` 这类错误若不巧带了 `rate` 之类的子串，会被误判成可重试。
  - **单槽会话窗口上限**：官方 `codexMaxSessions` + `sessionLimit.canAccept`（`codex-slot-pool.mjs:277-287`、`:329-333`）限制一个槽位同时挂几个会话窗口，超了回 `session_window_full`。我们没有这个概念。
  - **排序策略**：官方有 `strategy: 'smart'` / round-robin 游标（`codex-slot-pool.mjs:288-297`）。我们是"首个可用即选"，不算负载、不轮转（`codex.mjs:500-503` 的注释明确说这是刻意的）。
  - 已对齐的部分：会话亲和永久有效不设 TTL、`Retry-After` 优先、过载与 429 用不同冷却时长（官方 5s 过载也是同一思路）、失败转移时优先保亲和。这几条我们做得不比官方差。

- **风险**：**高**。
  - 超额号被反复选中不只是"多几次 429"：同一凭据在额度耗尽后持续撞墙，是最容易被上游打上异常标记的行为模式。官方为此专门写了 park 机制（`codex-usage.mjs:63-89`），说明这是上游侧的已知约束而非纯优化。
  - 我们的 60s 冷却 + 无 park 组合，在 5h 窗口打满后会产生「每 60 秒一次 429」的规律性流量，持续数小时。
  - `content_policy` 误判重试属于次生风险：同一内容换个号再试，等于在多账号上重复触发同一条策略拒绝。

- **建议**（按性价比排序）：
  1. 把 `quota-window.mjs` 的解析结果接进 `AccountScheduler`：`canTake` 增加第 4 个判据——某窗口 used ≥ 100 且 reset 在未来 → 不可用，并 park 到 reset（对齐 `codex-usage.mjs:76-83`）。这一条能消掉绝大部分规律性 429。
  2. `canTake` 增加不可重试黑名单（`content_policy`/`refusal`/`usage_policy`/`guard`），且黑名单优先级高于可重试白名单。
  3. `maxAttempts` 从 3 提到与账号规模相称的值（官方 12），否则多号池的转移能力被浪费。
  4. 单槽会话窗口上限（`codexMaxSessions`）可延后，它影响的是"一个号被多少会话同时占着"，属精细化调度。

---

## 附：本次对比中最值得先做的三件事

1. **`codex-auto-review` → `gpt-6-luna` 的别名重写**（第 3 项）。改动最小、风险最高，一行映射表即可补上，且必须放在平台判定之前。
2. **`role:system` → `developer` 与 `reasoning` 归一化**（第 2 项）。这是"把请求发成上游认识的形状"，与优化无关。
3. **额度窗口参与选号**（第 8 项）。现有 `quota-window.mjs` 已经把数据解析出来了，缺的只是把它接进 `canTake` 并 park 到 reset。

相对地，**生图这条线不需要抢救**：端点、模型、snapshot、Free 排除、600s 超时、turn-id 粘性、multipart 转换都已对齐，剩余缺口（Responses 内工具校验、image usage 计费）属补强而非补课。
