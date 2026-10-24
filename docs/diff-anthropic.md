# anthropic 协议层对比（我们 vs 官方 v1.3.220）

对比基线：`vm2api` @ `2bb05cb7 release: cut v1.3.220`。
我方基线：`research/reimpl/src/`（工作区当前状态，未改任何源文件）。

> 口径说明：官方 Node 控制面**不再自己发 Anthropic HTTP 请求**——`anthropic-messages.mjs:47-53` 明确 "Direct host HTTP hop is disabled. All Anthropic I/O goes through the Go slot worker"，真正的 wire 组装、SSE 转发、chunked 收尾都在 Go worker / Rust kernel 侧。因此凡涉及"线上字节"的结论，官方侧能引用的只有**交给 worker 的 envelope**（`go-worker-client.mjs:436-470`）与 worker 回调侧的解析（`go-worker-client.mjs:812-905`）。这类由架构造成的不可见之处，下文标"无关"并说明。

---

## 结论摘要

- **封号风险项：4 个**
  1. 无 `DROP_TOP` 字段黑名单，内部/OpenAI 残留字段原样出站（`sanitize` 维度）
  2. `metadata.user_id` 不注入 + 入站 metadata 敏感键原样透传
  3. cli-hop 出站 system 默认（identity 布局）为 4 块且首块是 billing header，官方为 ≤2 块且无 billing
  4. tools 上的 `cache_control` / `eager_input_streaming` 不剥离
- **功能缺失项：9 个**
  1. `count_tokens` 端点整体缺失
  2. thinking / adaptive↔enabled 全部无归一化
  3. tools 名称不改写、不做 server-tool 字段清洗
  4. `max_tokens` 无兜底
  5. 模型名不做 catalog 校验 / fail-closed / family 别名解析
  6. `[1m]` 后缀不剥离出站
  7. cache TTL 解析链缺失（header / inbound / routing / 会话 pin）
  8. cache 标记 >4 只报不修 + 无 1h-before-5m 顺序修复
  9. 流内 `event: error` 不注入、流完整性不判定、200+error 不还原 status
- **性能成本项：2 个**（system 断点无 token 门槛；两条结构 TTL 不一致导致缓存层级抖动）
- **已对齐：9 项**（清单见下）
- **无关（架构差异）：3 项**（清单见下）

### 已对齐清单

| # | 项目 | 官方 | 我们 |
|---|---|---|---|
| 1 | messages 断点位置/数量：最后一条 user + 上一条 user，消息数 ≥4 才两个 | `outbound-attempt.mjs:200-231`、`cache-ttl.mjs:633-642` | `cache-breakpoints.mjs:66-81`（`MIN_MESSAGES_FOR_TWO_BREAKPOINTS=4`，`:32`） |
| 2 | system 断点数量 = 2 | `outbound-attempt.mjs:189-190` | `system-layout.mjs:250,262-266` |
| 3 | thinking / redacted_thinking 块上禁 cache_control，且断点跳过这类块 | `cache-ttl.mjs:97-99`、`outbound-attempt.mjs:245-250` | `cache-breakpoints.mjs:49-51,102-107` |
| 4 | 默认 TTL = 1h | `cache-ttl.mjs:9` | `cache-breakpoints.mjs:35` |
| 5 | 带 1h 时补 `extended-cache-ttl` beta | `claude-code-betas.mjs:107-108`（`hasHourCache`） | `server.mjs:345-348` |
| 6 | 非 document 模式恒发 `stream:true` | `anthropic-messages.mjs:20` | `anthropic.mjs:248-253` |
| 7 | 顶层 `cache_control` 一律删除 | `outbound-attempt.mjs:337` | `prompt-profiles.mjs:710` |
| 8 | cch 封盖在断点/布局定稿之后 | `go-worker-client.mjs:467` | `server.mjs:350-352` |
| 9 | SSE 字节级透传，不重组事件、不重切分块 | `go-worker-client.mjs:812-818,856-895` | `server.mjs:683-695` |

### 无关（架构差异）清单

1. **上游 HTTP hop 归属**：官方 Node 不发请求（`anthropic-messages.mjs:47-53`，注释 "Direct host HTTP hop is disabled"），由 Go worker / Rust kernel 发包；我们 Node 直连 `api.anthropic.com`（`anthropic.mjs:662-800`）。因此"官方出站字节"只能通过 envelope 观察，`finalizeWorkerPayload`（`go-worker-client.mjs:436-470`）之后的字节不可见。
2. **`outbound-shape.mjs` 的定位**：不是出站改写层，是脱敏结构骨架 + diff 工具（`outbound-shape.mjs:1-34,99-146,185-288`）。用户怀疑的"伪装出站形状"实际由 `server.mjs:254-353` + `prompt-profiles.mjs:745-830` 承担。
3. **chunked 终止**：`te: trailers` 只出现在发给 Go worker 的请求头（`go-worker-client.mjs:768`），trailers 用于读 `x-usage` 等元数据（`:896`），不下发客户端；对客户端两侧都是 `res.end()` → Node 自动封 `0\r\n\r\n`，无 trailer 段。

---

## 逐维度对比

### 1. 请求体构造（字段集合 / 顺序 / 必填 / null vs 缺省）

- **官方**
  - 字段集合走**黑名单**：`sanitize.mjs:9-66` 的 `DROP_TOP` 列了 60+ 个键（`settings`/`claude_settings`/`env`/`user`/`user_id`/`extra_body`/`n`/`reasoning`/`input`/`max_output_tokens`/`stream_options`/`workspace`/`session`/`machine_id`/`device_id`/`account_uuid`/`web_search`…），`copyOfficialAnthropicFields`（`sanitize.mjs:69-77`）只保留不在表内的键。
  - 第二道关口显式删 5 个键：`identity-rewrite.mjs:427-431` 的 `delete out.settings / claude_settings / env / user / user_id`。
  - 必填兜底：`anthropic-messages.mjs:21` `if (!out.max_tokens) out.max_tokens = 128000`；`anthropic-messages.mjs:22-23` 空 tools 删键、`tool_choice` 无 tools 时删键；`anthropic-messages.mjs:24-28` `stop` → `stop_sequences` 归一。
  - 采样兜底：`anthropic-policy.mjs:409-415` `ensureClaudeOAuthBodyDefaults` 补 `temperature=1`、`tools=[]`。
  - cli-hop 额外删除：`outbound-attempt.mjs:309` 删 `metadata`；`:333-336` 删 `temperature` / `top_p` / `top_k` / `context_management`；`:337` 删顶层 `cache_control`。
  - 顶层**字段顺序**：不重排，按入站顺序复制（`sanitize.mjs:70-76` 的 `Object.entries`）。
- **我们**
  - 字段集合走**无黑名单**：`anthropic.mjs:232-238` `stripInternalFields` 只 `delete out.betas` 与 `out.__betas__`，其余键全部出站。
  - 第二道关口不存在：`server.mjs:254-353` `prepareOutbound` 全程不删任何业务字段。
  - 顶层顺序被固定重排：`prompt-profiles.mjs:707-717` `orderTopLevel` 按 `TOP_LEVEL_ORDER_303`（`prompt-profiles.mjs:716-726`：model/messages/system/tools/metadata/max_tokens/thinking/output_config/stream）排序，剩余键追加在后；同时 `prompt-profiles.mjs:710` 删顶层 `cache_control`（这一条与官方对齐，见维度 2）。
  - 无 `max_tokens` 兜底、无 `stop`→`stop_sequences` 归一、无 `temperature`/`tools` 兜底（全 `src/` 内 grep `max_tokens` 只有 `reimpl/src/cch.mjs:198` 的序列化定位与 `frames.mjs:718` 的字段名单，无补值逻辑）。
  - `frames.mjs:716-760` 的 `NATIVE_OWNED_FIELDS` / `CALLER_OPTIONAL_FIELDS` / `mergeWireBody` 是唯一成形的一层校验，但 `server.mjs` 不 import `frames.mjs`，`/v1/messages` 主路径**不经过它**（死代码）。
- **差异**：出站键集合完全取决于调用方。任何 `settings` / `user` / `machine_id` / `device_id` / `account_uuid` / `session` / `stream_options` / `reasoning` / `max_output_tokens` 都会被原样送到 `api.anthropic.com`。这既是 400（unexpected field）来源，也是把中转方内部标记直接交给上游的证据链。
- **风险**：**封号风险**（内部字段泄漏，最高优先级）；同时是功能缺失（缺 `max_tokens` 必 400）。
- **建议**：把 `DROP_TOP` 等价表搬进 `prepareOutbound`，在 `prompt-profiles.mjs:707` 之前执行；补 `max_tokens` 兜底与 `stop` 归一；`mergeWireBody` 要么接入主路径要么删除，避免"看起来有校验"。

---

### 2. cache_control 断点（位置 / 数量 / ttl / 上限 4 的判定）

- **官方**
  - **位置（cli-hop 主线）**：`outbound-attempt.mjs:200-231` `officialMessageMarker` —— 先**清掉所有消息上的 marker**（含字符串 content 消息的 `message.cache_control`，`:204-208`），再从后往前收集最多 2 条**非空** `role==='user'`（`:221-226`），最后一条必定打点（`:228`），仅当 `next.length >= 4` 且存在第二条时才打第二个点（`:229`）。落点是"该消息最后一个非 thinking 块"（`:244-250`）。
  - **位置（通用 Messages 主线）**：`cache-ttl.mjs:654-671` —— `tail` 模式取 `lastStampableMessageIndex`（`:645-652`，最后一条**任意角色**的非空消息），`rewrite` 模式再加 `penultimateUserIndex`（`:633-642`，同样是 `messages.length < 4` 早退）。
  - **数量**：system 2 个（`outbound-attempt.mjs:189-190` 两块各带一个 marker），messages ≤2，tools 在 cli-hop 被清空（`:253-274`），合计恒 ≤4。
  - **TTL**：`cache-ttl.mjs:9` 默认 `1h`；`outbound-attempt.mjs:188` 两处 marker 都是 `{ type:'ephemeral', ttl: normalizeCacheTtl(ttl) }`（**显式带 ttl**）；只认 `5m`/`1h` 两种取值（`cache-ttl.mjs:100-102` 的校验）。
  - **上限 4 的实际执行**：`anthropic-policy.mjs:86-109` `enforceCacheLimit` —— 先无条件删 thinking 块上的 marker（`:91-93`），再按 `tools 倒序 → system 倒序 → messages 正序` 删到 ≤4（`:96-108`）；`anthropic-policy.mjs:95` 注释明确"keep the message anchors"。cli-hop 还有第二重：`validateCacheBreakpoints`（`cache-ttl.mjs:85-114`）在超 4 时直接抛 400（`:105`）。
  - **顺序约束**：`cache-ttl.mjs:103` 要求 1h 必须出现在 5m 之前，`enforceCacheTtlOrder`（`:308-324`，手段是把 1h 降级成 5m）负责修复。
- **我们**
  - **位置**：`cache-breakpoints.mjs:66-81` `messageBreakpointIndices` —— 只按 `role==='user'` 收集索引（`:70-72`），`messages.length < 4` 时只取尾点（`:76`），否则取最后两条 user（`:78-80`）。落点 `anchorBlock`（`:90-109`）取最后一个非 thinking 块，字符串 content 就地转块（`:94-99`）。
  - **数量**：`MAX_MESSAGE_BREAKPOINTS = 2`（`:29`），`MIN_MESSAGES_FOR_TWO_BREAKPOINTS = 4`（`:32`）；system 恒定 2（`system-layout.mjs:250` `MAX_SYSTEM_BREAKPOINTS = 2`，`:262-266` 取首末两块）。
  - **TTL**：`cache-breakpoints.mjs:35` `DEFAULT_CACHE_TTL='1h'`；`stampBlock`（`:117-126`）**无条件写 `ttl`**。另有 `prompt-profiles.mjs:465-467` `cacheMarker` —— `ttl` 非 1h 时写**不带 ttl** 的 `{type:'ephemeral'}`。
  - **上限 4 的执行**：`cache-breakpoints.mjs:380` `remaining = max(0, 4 - toolMarkers - systemMarkers)`，用它收缩 messages 名额；`auditCacheBreakpoints`（`:299-306`）在 `total > 4` 时**只 push 一条 problem，不修**。`identity.mjs:255-264` 有一个正确的 `capCacheMarkers`（thinking 优先删、tools 倒序、system 倒序），但全仓 grep 只在 `test/selfcheck.mjs:9,92` 被调用，**生产路径未接线**。
  - **顺序约束**：无。`stampBlock` 统一写同一 ttl，不检查调用方遗留 marker 的 ttl 顺序。
- **差异**
  1. **tools 上的 marker 官方删、我们留**：官方 `outbound-attempt.mjs:265-266` 在 cli-hop 删 `tool.cache_control`；我们把 `countToolMarkers`（`:218-225`）算进预算并保留它们出站。当调用方（Claude Code 本身就会）在最后一个 tool 上带 marker 时，我们出站 `tools[last].cache_control` 是官方 cli-hop 样本里不存在的东西。
  2. **超 4 不兜底**：tools 有 ≥3 个 marker 时 `remaining` 归 0、messages 清空，但 `total = toolMarkers + 2` 已经 >4（`:380,404`），`auditCacheBreakpoints` 只记录 `total_markers_exceeded`（`:299-306`），请求照发 → 上游 400。
  3. **TTL 取值链**：官方 `cache-ttl.mjs:75-82` `resolveCacheTtl` = `x-kin-cache-ttl` 头 → 入站 body 里最高 TTL（`:44-64`，**1h 优先于 5m**）→ routing 配置 → 默认 1h；`cache-ttl.mjs:136-148` 还会按会话 key pin 住首个 TTL。我们只有 `normalizeCacheTtl('5m'|'1h')`（`cache-breakpoints.mjs:43-46`），不读 header、不读入站、不 pin。`identity.mjs:176-178` 有一个更接近官方的 `resolveKinCacheTtl`（`explicit → panel → 1h`，且 **5m 优先**），同样只在 `test/selfcheck.mjs:77-79` 被调用，未接线。
  4. **内部 TTL 自相矛盾**：`STRUCTURE_SYSTEM_REMINDER`（`prompt-profiles.mjs:682-693`）用 `cacheMarker(ttl)` 产出**无 ttl**（=上游默认 5m）的 marker，并且 `server.mjs:338-340` 对这条结构**跳过** `applyCacheBreakpoints`；`STRUCTURE_CLI_HOP` 则会被 `stampBlock` 统一改写成 `ttl:'1h'`。同一个 TTL 配置，两个结构出站 TTL 不同。
  5. **1h-before-5m 违规**：调用方在 tools 上带 `5m`、我们给 system 补 `1h`（tool 在前）→ 命中官方 `cache-ttl.mjs:103` 描述的那条 400，我们不修。
  6. 空 content 的 user 消息：官方 `outbound-attempt.mjs:225` 要求 content 非空才计入锚点；我们 `messageBreakpointIndices` 不看内容，`anchorBlock` 返回 null 时该名额被静默丢弃，且不再向前找下一个 user。
- **风险**：**功能缺失（直接 400）** + **封号风险（形状）**。第 2、5 条会硬 400；第 1 条是出站形状与官方 CLI 不符；第 3、4 条是**性能成本**（缓存层级抖动，每轮按全量计费）。
- **建议**：cli-hop 路径在打点前删掉 tools 上的 marker（对齐 `outbound-attempt.mjs:265-266`）；把 `capCacheMarkers` 接到 `applyCacheBreakpoints` 末尾做硬兜底；接 `resolveKinCacheTtl` 但把优先级改成与官方一致的 1h 优先；统一两条结构的 TTL 生成（择一：要么都写显式 ttl，要么都不写）；补 `enforceCacheTtlOrder` 等价物。

---

### 3. system prompt 处理（是否替换 / 怎么替换 / 多块怎么拼）

- **官方**
  - cli-hop 模板 `officialSystemTemplate`（`outbound-attempt.mjs:183-192`）：先按 `\n\n` 把调用方所有块拼成一段（`:184-187`）；如果其中某块**恰好等于** `CRS_OFFICIAL_CLI_SYSTEM`（= `"You are Claude Code, Anthropic's official CLI for Claude."`，`crs-persona.mjs:82`），就以它为界把后面的内容当正文，否则全部当正文；输出固定 **≤2 块**：`[{身份句, cache_control}, {调用方正文, cache_control}]`（`:189-190`）。
  - 官方自身产生的 system 块先被剥离：`outbound-attempt.mjs:73-92` `isCliOwnedSystemText` + `stripCliOwnedSystem` 删除 billing header、`# Environment`、三种身份句、`You are Claude Code*` 前缀；剥空则 `delete body.system`（`:315`）。
  - 环境块走**独立的 `role=system` 会话消息**而非 system 数组（`outbound-attempt.mjs:280-284` 注释：把 reminder 留在 messages 里，避免 system 前缀随计数变化）。
  - 易变计数器抹平：`outbound-attempt.mjs:94-128` `stabilizeSystemBudget` 把 `<total_tokens>\d+ tokens left</total_tokens>` 统一成固定 `15000000`；`:146-169` 对历史消息做同样处理。
- **我们**
  - `layoutSystemBlocks`（`system-layout.mjs:197-210`）产出**4 块**：`[billing header, 身份句, "# Environment\n - Timezone: …", 调用方 leftover]`（zero 布局去掉身份句；stock 布局只剩 env + leftover）。`server.mjs:319-324` 把它落成 `{type:'text', text}` 数组。
  - billing header 由 `buildBillingAttribution`（`system-layout.mjs:104-116`）现造，字段固定 5 个：`cc_version=$ver.$fp; cc_entrypoint=cli; cch=00000; cc_prompt_id=$uuid; prompt_version=$pv`。
  - 身份句是 `CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."`（`system-layout.mjs:25`），与官方 `CRS_OFFICIAL_CLI_SYSTEM` 字面一致。
  - 调用方 system 的清洗只有 `leftoverFromSystemPrompt`（`system-layout.mjs:226-238`）：按**整块**等值匹配删 billing / `IDENTITY` / `# Environment` 前缀 / `isDefaultAgentField`（`:227-231` 两个硬编码标记），其余全部保留并 `join('\n\n')`。
  - `STRUCTURE_SYSTEM_REMINDER` 走另一套：`prompt-profiles.mjs:682-693` 产出 3 块（billing + 身份句 + 303 主提示词），调用方 system 被折进**首条 user 的 `<system-reminder>`**（`prompt-profiles.mjs:610-631`）。
  - `stabilizeTotalTokens`（`prompt-profiles.mjs:79` 附近，`VOLATILE_TOTAL_TOKENS` 在 `:76`）已实现相同抹平。
- **差异**
  - 块数与形状：官方 cli-hop 出站 `system` 至多 2 块、**不含 billing header**（前提是 `preserveSystem` 为假，走 `stripCliOwnedSystem` + `officialSystemTemplate`，`outbound-attempt.mjs:313-319`）；我们在默认配置下（`server.mjs:565` 硬编码 `SKYLINK_SYSTEM_LAYOUT || 'identity'`）走 identity 布局，出站 4 块：`[billing, 身份句, #Environment, leftover]`（`system-layout.mjs:197-210`）。若把 `SKYLINK_SYSTEM_LAYOUT` 设为 `stock`，则退化为 2 块 `[#Environment, leftover]` 但仍然**不含 billing**，cch 失去封盖目标——`server.mjs:561-564` 的注释其实已经指出这个坑，只是 `:565` 用 `|| 'identity'` 把它绕过了，注释与行为不一致（doc drift）。
  - 剥离力度：官方按"前缀 + 等值 + `You are Claude Code` 前缀"四类匹配，`system-layout.mjs:226-238` 只做等值/前缀三类，`You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.` 之外的变体（例如带不同后缀的官方身份句）会作为"调用方内容"残留。
  - 环境块位置：官方把 Environment 留在 messages 尾部（有 `appendEnvironmentMessage` 等价语义），我们放进 system 第四块之前（`system-layout.mjs:207`），即**在 system 缓存前缀内**。
  - billing 字段：官方 `crs-persona.mjs:376` 还带 `cc_turn_origin=sdk; cc_prompt_index=N; cc_turn_index=M` 尾缀（`crs-persona.mjs:311-316`），我们没有这几个字段。
- **风险**：**封号风险（中）** —— system 块数、首块内容、billing 字段集都是上游判定客户端版本的强指纹；`cc_turn_origin` 缺失会让 header 短一截。**性能成本** —— Environment 落在 system 前缀内，时区/模型行一变整段前缀失效。
- **建议**：cli-hop 路径对齐 `officialSystemTemplate` 的 2 块形状（billing 保留则只在 stock/identity 布局下）；补齐 `cc_turn_origin/cc_prompt_index/cc_turn_index` 或明确记录"官方该字段在 2.1.x 之后可能已废弃"；Environment 移出 system 前缀。

---

### 4. tools 定义（顺序 / 字段 / 是否改写）

- **官方**
  - 顺序保留调用方顺序：`web-search.mjs:260-284` `sanitizeAnthropicTools` 是 `map`，不改序。
  - 字段清洗：server tool（`isAnthropicServerTool`）按 `SERVER_TOOL_DROP` 逐键删除（`web-search.mjs:275-283`）；`web_search_*` 只保留白名单键（`:264-274`）；普通 `function` 形态走 `toAnthropicCustomTool` 归一（`:275`）。
  - **名称改写**：`anthropic-policy.mjs:465-479` `safeToolName` —— 不匹配 `TOOL_NAME` 或重名的工具改写成 `kin_tool_<sha256 前 16 位>`；`:481-516` `rewriteToolNames` 同步改 `tool_choice.name` 与历史消息里所有 `tool_use.name`，并把 `reverse` 映射交给响应侧 `restoreToolNames`（`:517-529`）/ `restoreToolNamesInSSELine`（`:531+`）。
  - cli-hop 额外剥离：`outbound-attempt.mjs:253-274` 删除 `eager_input_streaming`（含嵌套 `function.eager_input_streaming`）**和 `cache_control`**。
  - 空 tools 数组删键：`anthropic-messages.mjs:22`。
- **我们**
  - 顺序：`prompt-profiles.mjs:707-717` 不动 `tools`，原样透传。
  - 字段清洗：无。`src/` 内没有 server-tool / web_search 处理。
  - 名称改写：无。工具名、`tool_choice.name`、历史 `tool_use.name` 全部原样。
  - `eager_input_streaming` / tools 上的 `cache_control`：不剥离（见维度 2 差异 1）。
  - 空 tools 数组：不删键（`orderTopLevel` 只跳过不存在的键，`:713` 的 `Object.hasOwn` 判定），空数组会照发出站。
- **差异**：工具名不改写（中文/带空格/带 `:` 的工具名上游会 400 `invalid tool name`）；`eager_input_streaming` 与 tool marker 不剥离；空 `tools: []` 不删；server tool 的非法字段不删。
- **风险**：**功能缺失**（非法工具名/非法字段 → 400）；**封号风险（低-中）**（tool 形状与官方 CLI 不符）。
- **建议**：先搬 `sanitizeAnthropicTools` 的 server-tool 字段删除与空数组删键（低风险、高收益）；工具名改写需要配套的响应还原（SSE 逐行 + 非流式），工程量大，可后置。

---

### 5. thinking / reasoning（budget_tokens / 类型 / 块处理）

- **官方**
  - 模型能力矩阵：`thinking.mjs:74-97` `modelSupportsAdaptiveThinking`、`:99-113` `modelRequiresAdaptiveThinking`；`model-policy.mjs:777` `normalizeThinkingByPolicy`、`:756` `clampEnabledThinkingBudget`。
  - 归一化：`thinking.mjs:115-137` `normalizeThinkingForModel` —— `adaptive` 落到不支持的模型（Haiku / 4.5 及更早）时转成 `{type:'enabled', budget_tokens}` 并 clamp；`enabled` 在 Claude 5 / Fable / Opus 4.7+ 上保留不动。
  - OpenAI 映射：`thinking.mjs:44-62` `openaiReasoningToClaudeThinking`，`EFFORT_TO_BUDGET` 在 `:38-45`（minimal 1024 … max 32768），缺省 4096（`:47`）。
  - 采样对齐：`anthropic-policy.mjs:164-183` `alignSamplingWithThinking` —— thinking 开启时强制 `temperature=1` 并删 `top_p`/`top_k`（官方注释：Anthropic 只接受 temperature=1）。
  - 历史块清理：`anthropic-policy.mjs:184-253` `stripInvalidThinkingBlocks` —— 无可用签名（空、`<24` 字符、`skip_thought_signature_validator`）的 thinking 块直接删；5.5 系列一个坏块就丢掉整条签名链（`:133-152` `dropSignedThinkingChain`）；`redacted_thinking` 按 `data` 是否非空决定保留。
  - display 控制：`thinking.mjs:17-23` 路由级 `summarized|passthrough`；`:197-213` `applyThinkingDisplay`（缺省改写成 `omitted`）。
  - effort：`thinking.mjs:247-290` `stripUnsupportedEffort` / `ensureUnofficialEffortHigh`；`outbound-attempt.mjs:326-327` 对非 repaired 请求必调。
  - cli-hop 专属：`outbound-attempt.mjs:346-351` `pinHaikuCliThinking` 对非 `haiku-5` 的 Haiku 强制 `{type:'disabled'}`。
- **我们**
  - 全仓 grep `thinking|budget_tokens|reasoning`（排除 codex）只命中：`identity.mjs:203-213` 删 thinking 块上的 cache_control、`cache-breakpoints.mjs:49-51` 断点跳过 thinking 块、`prompt-profiles.mjs:476-480` 同上、`frames.mjs:717-728` 字段名单。**没有任何 thinking 归一化、能力判定、预算 clamp、签名校验、块清理**。
  - `thinking` 字段靠 `TOP_LEVEL_ORDER_303`（`prompt-profiles.mjs:719`）原样保留出站。
  - `temperature`/`top_p`/`top_k` 原样保留出站（官方在 cli-hop 会删，`outbound-attempt.mjs:333-335`）。
- **差异**：`adaptive` 打到 Haiku/4.5 会 400；`budget_tokens` 越界会 400；`temperature != 1` 且 thinking 开启会 400；历史 `thinking` 块签名无效时上游 400 `invalid signature`；`redacted_thinking` 的 `data` 为空会 400。以上我们都直接透传。
- **风险**：**功能缺失**（四类 400 全部存在）。
- **建议**：优先做三件低风险事：① `stripInvalidThinkingBlocks` 的签名校验（无签名/短签名删块）；② `alignSamplingWithThinking`（thinking 开启时 `temperature=1` + 删 `top_p/top_k`）；③ `adaptive` → `enabled` 的模型降级。effort 与 display 可后置。

---

### 6. sanitize（必须删 / 必须保留）

- **官方**
  - 必须删（顶层，`sanitize.mjs:9-66`）：`settings`、`claude_settings`、`env`、`user`、`user_id`、`extra_body`、`extra_headers`、`extra`、`n`、`presence_penalty`、`frequency_penalty`、`logit_bias`、`logprobs`、`top_logprobs`、`functions`、`function_call`、`response_format`、`seed`、`parallel_tool_calls`、`reasoning_effort`、`max_completion_tokens`、`max_output_tokens`、`store`、`modalities`、`audio`、`prediction`、`stream_options`、`tool_resources`、`instructions`、`input`、`truncation`、`include`、`previous_response_id`、`reasoning`、`prompt`、`suffix`、`best_of`、`echo`、`workspace`、`rewrite`、`web_search`、`session`、`machine_id`、`device_id`、`account_uuid`，加上 12 个 camelCase 变体。
  - 必须删（第二道，`identity-rewrite.mjs:427-431`）：`settings`/`claude_settings`/`env`/`user`/`user_id`。
  - 必须删（内容块，`sanitize.mjs:117-150`）：`annotations`，并对 `tool_result.content` 递归（`:133-136`）。
  - 必须删（cache_control 上的非法字段，`cache-ttl.mjs:190-201` `stripIllegalCacheControlFields`）：`scope`（`dropCacheControlScope`，`:167-172`）；`sanitizePublicCacheControl`（`:159-165`）把 marker 重建为只剩 `{type, ttl}`。
  - 必须删（cli-hop）：`metadata`（`outbound-attempt.mjs:309`）、顶层 `cache_control`（`:337`）。
  - 必须**保留**：未知但合法的官方字段，注释明确"pass through unknown official fields such as output_config"（`sanitize.mjs:3-8`）；`output_config` 由 `applyStructuredOutput`（`:102-114`）从 `response_format`/`text.format` 提升后保留。
  - 必须**重建**：`metadata` 只保留白名单外键（`identity-rewrite.mjs:457-463` 剔除键名含 `user|machine|device|host|tz|timezone|locale|setting|session_source|email` 的项），然后写入 `metadata.user_id = formatMetadataUserId({deviceId, accountUuid, sessionId})`（`:464-469`）。
- **我们**
  - 必须删：只有 `betas` / `__betas__`（`anthropic.mjs:232-238`）。
  - 内容块：无 `annotations` 清理。
  - cache_control：`stampBlock`（`cache-breakpoints.mjs:117-126`）会重建 marker，但**主动保留** `scope`（`:124`）；`system-layout.mjs:311` 同样保留。官方在公开 Messages hop 上是要删 `scope` 的（`cache-ttl.mjs:159-172`）。
  - `metadata`：`/v1/messages` 路径不重建、不过滤、不注入（`server.mjs:254-353` 无相关逻辑）；`frames.mjs:692-720` 有 `buildCliMetadata`（`formatMetadataUserId` 在 `frames.mjs:672-707`），但主路径不经过。
  - `output_config`：原样透传，不做 `response_format` 提升。
- **差异**：60+ 个黑名单字段全部可出站；`scope` 被主动保留（官方删）；`metadata.user_id` 不注入、敏感键不过滤。
- **风险**：**封号风险（高）** —— `machine_id`/`device_id`/`account_uuid`/`session`/`web_search` 这几项在中转语境下就是内部标记，泄漏到上游是最直接的关联证据。`scope` 泄漏是低一级的形状问题（官方注释：Haiku 与无 `prompt-caching-scope` beta 的 hop 会 400 `Extra inputs`）。
- **建议**：把 `DROP_TOP` 作为独立模块搬进来（纯数据表，零风险），在 `orderTopLevel` 之前跑；`stampBlock` 的 `scope` 保留改成"仅当 `anthropic-beta` 含 `prompt-caching-scope` 时保留"；`metadata` 注入补齐。

---

### 7. 模型名映射（别名 → 真实名 / policy）

- **官方**
  - `models.mjs:185-217` `resolveCatalogModel`：去 provider 前缀（`split('/').pop()`，`:188`）→ 剥 `[1m]` 并记 `want1m`（`:189-190`）→ family 别名（`sonnet`/`opus`/`haiku`/`fable`）解析到 catalog 里**最新** id（`:192-202`）→ catalog 精确匹配（`:203-205`）→ 无日期别名补日期（`:206-207`）→ policy 别名（`:208-209`）→ **否则 fail closed**（`:210-211`，注释 "Never passthrough unverified claude-*"）。
  - `models.mjs:290-349` `validateOfficialModel`：空模型 400；`gemini|deepseek|mistral|grok|text-|davinci` 与 `gpt-|o1|o3|o4`（非 Codex）400；catalog 未命中 400 `model_not_supported`（`:336-345`）；catalog 为空时只允许 `isCatalogModelId` 命中的 id（`:329-332`）。
  - 模型相关请求规则：`model-policy.mjs:859` `applyModelRequestRules`、`:1034` `defaultMaxTokensForModel`、`:1044` `applyMaxTokensCap`。
- **我们**
  - `prompt-profiles.mjs:176-186` `canonicalModelId`：去前缀、去 `[1m]` 后缀、去 `-YYYYMMDD`、`claude-opus-4` → `claude-opus-4-0`、小写。**只用于本地分类**（`usesSystemReminderLayout` `:232-240`、`profileForModel` `:246-252`、`structureFor` `:264-272`）。
  - 出站 `model` 字段：`orderTopLevel`（`prompt-profiles.mjs:707-717`）原样保留，`stripInternalFields`（`anthropic.mjs:232-238`）不动 `model`。**没有任何校验、别名解析或 catalog 查询**。
  - `betas.mjs:78-81` 有一个 `normalizeModelId`，仅用于 beta 匹配。
- **差异**：`opus` / `sonnet` 这类裸别名原样出站（上游 404）；未知 `claude-*` 原样出站（官方的设计是 400 拒掉）；`claude-sonnet-4-5[1m]` 带后缀出站（官方剥离后缀并用 `want1m` 走 header/beta）；`gpt-*` / `gemini-*` 原样出站。
- **风险**：**功能缺失**（404/400 由上游给出，错误信息透出给调用方）；`[1m]` 后缀还可能被上游当作未知模型。
- **建议**：至少实现 `stripClaudeCode1mSuffix` + `want1m`，以及 `FAMILY_ALIASES` → 最新 id 的解析（可以硬编码一张小表，不依赖 worker catalog）；catalog 校验可以放宽（有 catalog 才校验），但 fail-closed 是官方明确策略，建议照搬。

---

### 8. count_tokens（独立端点 or 复用）

- **官方**
  - **独立端点**，且**按凭据模式分流**：`user-count-tokens.mjs:250-345` `handleUserCountTokens`。
  - 前置拦截：`:219-248` `blockCountTokensBeforeHop`（走 `runProtocolIntercept`，可返回 block 或 `scope-wait` 等待）。
  - 凭据分流：`:299-310` —— `canCountTokens(mode)` 为假（OAuth）时**不 hop**，改为 `resolveUsageWindows` + `buildUsageView` 返回 `GET /v1/usage` 形态；只有 Setup Token / Console API Key 才走 `countTokensViaWorker`（`:311-320`，UA 固定 `kin-inference/1.0`）。
  - 错误语义：`:39-46` `countTokensUnsupportedError`（"count_tokens 只支持 Setup Token / Console API Key，OAuth 请用 GET /v1/usage"）；`:322-340` 429/529 走 `mapUpstreamError` 并透 `retry-after`。
- **我们**
  - `src/` 全目录 grep `count_tokens` **零命中**。路由只有 `/v1/messages`（`server.mjs:487`）、`/v1/responses` 系列（`:401`）、调试面（`:421-465`）。
  - `GET /v1/usage` 也没有对应实现（`grep usage` 只命中 `quota-window.mjs` 的内部额度，不是对外端点）。
- **差异**：端点完全缺失，客户端（Claude Code 会周期性调用 `count_tokens` 做 context 预算）会拿到 404。
- **风险**：**功能缺失**。
- **建议**：先做最小可用版：`POST /v1/messages/count_tokens` → 直接转发上游同名端点（我们已有 OAuth token 与 `messagesUrl` 基础设施，加 `messagesUrl().replace('/messages','/messages/count_tokens')` 即可），OAuth 下也可直接转发（官方因合规策略拒绝，但技术上可行）。`/v1/usage` 依赖 quota 模块，可后置。

---

### 9. 错误处理（重试条件 / 退避 / 错误码映射 / 可重试判定）

- **官方**
  - 状态分类：`stream-error-status.mjs:13-24` `semanticStatusForStreamError` —— 先看 `isPlanLimitMessage` → 429，再看显式 `error.status`，再按 `type` 映射（`rate_limit_error`→429、`overloaded_error`→529、`authentication_error`→401、`permission_error`→403、`invalid_request_error`→400），兜底 502。
  - 流内 error 还原：`stream-truncation.mjs:34-77` `createAnthropicSseErrorRemapper` 把 `event: error` 的 data 行按 `mapUpstreamError` 重写，保证流式与非流式的错误分类一致。
  - 流内 error 注入：`stream-truncation.mjs:21-33` `buildAnthropicSseError` —— 流中断时主动补一个 `event: error` 帧而不是直接断连。
  - 完整性判定：`stream-truncation.mjs:78-143` `createAnthropicStreamTracker`（跟踪 `message_start`/`message_stop`/`error`），`:144+` `isRecoverableTruncation`。
  - 重试与退避：`telemetry`/`pool` 侧按 `x-terminal-state`、`rate_headers` 决策（`go-worker-client.mjs:896-903` 合并 `anthropic-ratelimit-*`）；`retry-after` 透传。
- **我们**
  - 状态分类：`anthropic.mjs:290-306` `classifyStatus` —— 401 `NEEDS_REFRESH`、429 `RATE_LIMITED(retryable)`、529 `OVERLOADED`、5xx `SERVER_ERROR`、其他 4xx `INVALID_REQUEST`。分类本身**与官方一致**。
  - `parseRetryAfter`（`anthropic.mjs:312-330`）只接受纯十进制秒与三种 HTTP-date，比官方更严格（好事）。
  - 但 `classifyUpstreamError`（`identity.mjs:326-350`，带 `TYPE_TO_STATUS` 表与 `upstream_overloaded` 码）**只在 `test/selfcheck.mjs:96-101` 被调用**，生产路径用的是 `classifyStatus`，没有 type → status 的反向映射、没有 `upstream_overloaded` 分类码。
  - 错误透出：`server.mjs:665-676` 非 2xx 原样透出上游 body，附 `x-upstream-kind` / `x-upstream-status` / `retry-after`。
  - 流内 error：无注入、无重写。`server.mjs:691-695` 上游流抛错时 `res.destroy(error)` 直接断连（注释自陈"只能靠中断连接让客户端知道流不完整"）。
  - 无完整性判定：不跟踪 `message_stop`，没有 `incomplete` 概念。
  - 无退避重试：`scheduler.mjs:216-222` 只把 429 压到本地熔断状态，不发起重试。
- **差异**：① 200 + `event: error` 的上游响应会被我们当成成功转发（官方 `semanticStatusForStreamError` 会还原成 4xx/5xx）；② 流中断不补 error 帧；③ `stream-error-status` 那套 plan-limit → 429 的识别缺失；④ 无 `retry-after` 驱动的重试。
- **风险**：**功能缺失**（客户端把错误当成功，配额与重试策略全错）。
- **建议**：把 `semanticStatusForStreamError` + `buildAnthropicSseError` 搬过来（都是纯函数，改动面小）；对"未见到 `message_stop` 就结束"的流补一个 error 帧再 end。

---

### 10. SSE / 流式（事件顺序 / 分块边界 / flush 时机 / 终止方式）

- **官方**
  - Node 侧**不做事件重组**：`go-worker-client.mjs:856-895` 按 `\n` 切行、原样 `emitLine`，只在 `isDownstreamCommitEvent(event)` 之前把行 buffer 住（`:812-818`），commit 之后逐行 `await onEvent(line)`。分块边界 = worker 给的行边界，不重切。
  - 终止：**不是** 对客户端写 `\r\n0\r\n` + trailers。`te: trailers` 是**发给 worker 的请求头**（`go-worker-client.mjs:768`），trailers 从 `response.trailers` 读（`:896`），用于取 `x-usage`/`x-model`/`x-stop-reason` 等元数据，**不下发**给客户端。`0\r\n\r\n` 由 Node HTTP server 在 `res.end()` 时自动封 chunked 终止块。
  - 终止后继续读：`go-worker-client.mjs:854-856` 注释 "message_stop is the protocol terminal event, but the kernel still sends job_done and its trailers afterward. Keep reading until the worker closes the response" —— 即 `message_stop` **不**是读取终点。
  - flush：由 `onEvent` 的实现决定（上层写 `res.write`），Node 默认不缓冲。
- **我们**
  - 字节透传：`server.mjs:683-695` —— `res.writeHead(200, sseHeaders(...))` 之后 `for await (const chunk of upstream.stream) res.write(chunk)`，异常时 `res.destroy(error)`，正常 `res.end()`。不重组、不重切分块。
  - 终止：`res.end()` → Node 自动写 `0\r\n\r\n`；不发 trailer（`sseHeaders` `sse.mjs:119-133` 未设 `Trailer` 头）。
  - 响应头：`content-type: text/event-stream`、`cache-control: no-cache, no-transform`、`connection: keep-alive`、`x-accel-buffering: no`（`sse.mjs:119-133`）。
  - `sse.mjs:37-96` `messageStream` 是**合成流**（`message_start → content_block_start → N×delta(24 字符) → content_block_stop → message_delta → message_stop`），只用于 mock / 非流式聚合路径（`server.mjs:588-592`），**不用于真实上游转发**。
- **差异**：① 我们 `message_stop` 之后不会继续读（官方会读 worker 后续帧拿 trailers，但我们上游是 Anthropic，没有后续帧，实际等价）；② 流中断时官方补 error 帧、我们断连（见维度 9）；③ 官方有 `response_headers` 这类 worker 内部事件用于采率限头（`go-worker-client.mjs:822-824`），我们完全没有对应机制。
- **风险**：**无关**（①② 的传输语义等价；③ 是架构差异）。唯一实质缺失已归入维度 9。
- **建议**：无需改动。若要提升可观测性，可在 `res.end()` 前记录上游 `anthropic-ratelimit-*`（我们已 `headerOf` 可读）。

---

## 附：用户重点怀疑对象的直接回答

| 怀疑点 | 结论 | 依据 |
|---|---|---|
| 缓存断点 ttl 是不是写死？ | **是**，两级写死且互相矛盾：`cache-breakpoints.mjs:35,117-126` 恒写 `ttl:'1h'`；`prompt-profiles.mjs:465-467` 在非 1h 时写**不带 ttl**。官方走 `cache-ttl.mjs:75-82` 的四级解析 + `:136-148` 会话 pin | 见维度 2 差异 3、4 |
| 上限 4 的判定对吗？ | **概念对、执行不完整**。`cache-breakpoints.mjs:380` 用 `max(0, 4 - tools - system)` 收缩 messages，逻辑正确；但 tools ≥3 个 marker 时 `total` 必然 >4，`:299-306` 只报不修。官方 `anthropic-policy.mjs:86-109` 会倒序删到 ≤4 | 见维度 2 差异 2 |
| `sanitize.mjs` 我们漏删了吗？ | **漏删 60+ 个顶层字段**，包括 `machine_id`/`device_id`/`account_uuid`/`session`/`web_search` 这类内部标记。我们只有 `anthropic.mjs:232-238` 删 `betas`/`__betas__` | 见维度 6 |
| `outbound-shape.mjs` 与官方 `outbound-attempt.mjs` 对齐吗？ | **不是同类模块，无法对齐**。`outbound-shape.mjs:1-34` 自述是"脱敏结构骨架 + diff 工具"（把 body 归约成 `<text:12>`/`<billing:…>` 用于机械比对，`:99-146` `shapeOf`/`shapeArray`，`:185-288` `diffShape`），不参与出站改写。我们真正的出站改写层是 `server.mjs:254-353` + `prompt-profiles.mjs:745-830` + `cache-breakpoints.mjs` + `system-layout.mjs` | 见维度 1、3 |
| 流式终止是 `\r\n0\r\n` + trailers 吗？ | **不是**。`te: trailers` 只出现在发给 Go worker 的请求上（`go-worker-client.mjs:768`），trailers 用来读 `x-usage` 等元数据（`:896`），不下发客户端。对客户端，官方与我们都由 Node HTTP server 在 `res.end()` 时自动封 `0\r\n\r\n`，无 trailer | 见维度 10 |

## 附：本报告未覆盖但值得下一轮看的部分

- `cch.mjs`（415 行）与官方 `identity/cch.mjs` 的封盖算法逐字节对比（用户已声明 87003dca 已修，但封盖输入串的构造顺序仍可能不同）。
- `betas.mjs` 的 `withRequestProtocolBetas` 与官方 `claude-code-betas.mjs` 的 beta 枚举差集（`body.speed`/`body.safeguards`/`body.fallbacks` 我们都没接）。
- `scheduler.mjs` 的槽位选择与官方 `pool` 侧的 failover 策略。
