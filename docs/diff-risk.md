# 拦截与风险层对比（我们 vs 官方 v1.3.220）

> 审计方式：只读源码，静态比对，未执行任何测试。
> 官方侧根目录 `research/vm2api/src/lib/protocol/`，我们侧根目录 `research/reimpl/src/risk/`。
> 下文 `文件:行` 均为当前 checkout 的真实行号；跨文件引用会写全相对路径。
> 结论只覆盖「读到的代码」，不推测运行时配置。

---

## 结论摘要

- **封号风险项：2**（均中风险，无高危）
- **降智风险项：2**（1 高 + 1 中）
- **功能缺失项：6**（其中 4 项不属于 `risk/` 职责，属出站协议层）
- **已对齐：7**（5 项完全对齐 + 2 项基本对齐）

先给最重要的一条判断，避免后面被细节淹没：

**官方的 `protocol/` 六件套不是同一层东西，我们的 `risk/` 只对应其中两件。**

| 官方文件 | 职责 | 我们的对应物 |
|---|---|---|
| `jev-intercept.mjs` (1335 行) | 内容风控：硬正则 + 决策模型打分 | `risk/` 全部 8 文件 |
| `intercept-gate.mjs` (322 行) | 风控门控编排 + 副作用落地 | `risk/gate.mjs` + `risk/stats.mjs` |
| `model-policy.mjs` (1052 行) | 模型能力矩阵、thinking/max_tokens/beta 策略 | **无** |
| `request-rectifier.mjs` (289 行) | 非官方客户端 400 修补 | **无** |
| `web-search.mjs` (291 行) | 服务端搜索工具注入与清洗 | **无**（仅 Codex 侧有转换） |
| `anthropic-policy.mjs` (551 行) | 出站字段清洗、thinking 块与采样对齐 | **无**（部分散落在 `src/anthropic.mjs`） |

所以：**我们和官方在「拦截」这件事上基本是一回事，在「不被识别 / 不降智」这件事上不是一回事，而且缺的正是后者。**

三个重点怀疑对象的直接回答：

1. **`jev-intercept` 不是必做项，也不剥离任何请求字段。** 它默认关闭（`jev-intercept.mjs:342-344`，`enabled: false`），只做「内容打分后决定拦不拦」，拦下来的请求根本不 hop。它不是「不剥某字段就被识别」的那类逻辑。不做它 = 少一层内容风控，不等于封号。
2. **`model-policy` 会改写模型名，但只是规范化，不是换档位。** `resolvePolicyModelId` 把别名 / `provider/` 前缀 / `[1m]` 后缀归一成 catalog id（`model-policy.mjs:656-680`），`applyModelRequestRules` 只对 5.5 系列写 canonical id（`:859-882`）。真正防降智的是同一文件里的 thinking / max_tokens 策略和 `thinking.mjs`，这两块我们都没有。
3. **`request-rectifier` 没有等价物，但它修的是 400，不是「合规」。** 名字里的「rectifier」指 `ensureOutputConfigSchema` / `pairMissingToolResults` / `ensureConversationEndsWithUser`（`:50-133`），目标是让非官方客户端的请求能被 Anthropic 接受，与封号无直接因果。

---

## 逐项对比

### 1. JEV 是什么，拦截什么

- **官方**：`jev-intercept.mjs:1-9`（模块头）、`:19-34`（常量与 provider 表）
- **我们**：`gate.mjs:1-37`（模块头）、`classifier.mjs:25-34`（常量）
- **差异**：
  - 代码没有给出 JEV 的字母展开，它在这里是**一个专有名词**：第三方内容安全打分服务，默认 `base_url: https://api.typesafe.ai`、默认模型 `jev-latest`（`jev-intercept.mjs:30-34`）。头注释写明 Jev、本地 Laya、ModernBERT 三者共用 `/v1/systemone` 接口（`:3-4`）。
  - 它拦截的是**内容类别**，不是协议字段。类别固定四类：`nsfw` / `distill` / `crack` / `jailbreak`（`:20`），外加运营自定义正则（`:186`）。
  - 判定方式是「noul 提问」：每个类别是一道「这段话是否可以提交给模型」的问句，服务返回 0–1 分，**分数高 = 安全**，低于线才拦（`:1078-1081` `scoreBlocks`）。默认线 `POLICY_NOUL = 0.5`，容差带 `0.08`（`:22-24`）。
  - 分数语义完全一致：同样 0.5/0.08、同样「分数高=可发」，`classifier.mjs:25-27`。
  - **题库不一致（真实差异）**：官方 `POLICY_QUESTION_BANK` 是 **6 题**——`safety` / `nsfw` / `jailbreak` / `reverse`（逆向）/ `pentest`（渗透）/ `cyber`（网络攻击）（`jev-intercept.mjs:198-236`）；我们是 **4 题**——`safety` / `nsfw` / `jailbreak` / `distill`（`classifier.mjs:40-66`）。也就是说：官方用模型判定「逆向 / 渗透 / 网络攻击」，我们不做；官方没有 `distill` 题（蒸馏交给第 1 关的规则检测），我们把它加进了模型判定。
  - 差的还有 provider 抽象（官方支持 jev/laya/modernbert 三种，我们只有单一 endpoint，`classifier.mjs:162-166`）。
- **风险**：低-中。`reverse` / `pentest` / `cyber` 这三类在网络风控严格的上游属于高危类别，硬正则只能覆盖很窄的句式（`hard-policy.mjs:61-67` 只有 `keygen/warez`、`破解补丁`、`crack software` 等），覆盖不到「对某目标做渗透」这类自然语言请求。
- **建议**：把官方那三道题的文案补进 `QUESTION_BANK`（约 20 行，`jev-intercept.mjs:218-236` 可直译），`questionIds` 默认带上。这是低成本、直接对齐官方覆盖面的改动。provider 抽象可以不做。

### 2. 硬正则（第 2 关 / 官方 hard regex）

- **官方**：`jev-intercept.mjs:108-158`（规则集）、`:962-990`（`matchHardPolicy`）、`intercept-gate.mjs:48-57`（`hardRulesFor`）、`:207-232`（拦截分支）
- **我们**：`hard-policy.mjs:43-108`（规则集）、`:222-240`（`selectRules`）、`:266-301`（`matchHardPolicy`）、`gate.mjs:319-380`
- **差异**：
  - 规则内容基本逐条相同（越狱句式、`keygen/warez`、中文「越狱/破限/注册机」、蒸馏句式、`phishing kit`）。我们把规则同时落到了 `hard-policy.json`，官方只有内置数组。
  - 扫描范围一致且都刻意收窄：官方注释明确「只扫用户自己写的轮次，不扫工具回传和官方系统提示，否则 omp 自己会被自己的安全说明拦掉」（`:102-107`、`:992-996`）；我们 `matchHardPolicy(prepared.user, ...)`，`prepared.user` 也只取 `role === 'user'` 段（`prepare.mjs:430-450`）。
  - 蒸馏类规则的处理一致：官方在 `hardRulesFor` 里把 `category === 'distill'` 交给蒸馏开关并排除 OpenAI 平台（`intercept-gate.mjs:52-56`）；我们 `selectRules` 同样处理（`hard-policy.mjs:228-237`），并在 `gate.mjs:334-355` 把 distill 类命中改按第 1 关的文案 + 封 device 语义返回。
  - 差异一：官方规则支持面板热改（`jev.rules` / `jev.patterns`，`intercept-gate.mjs:50,186`），我们支持 `rules` / `extras`（`gate.mjs:326-338`），等价。
  - 差异二：官方 `matchHardPolicy` 只返回第一个命中且**不区分命中位置**（`:979-987`），我们多返回 `pattern` 与 `label`（`hard-policy.mjs:293-299`），是增强，不影响行为。
- **风险**：低。已对齐。
- **建议**：无。这是复刻得最完整的一块。

### 3. 蒸馏检测（第 1 关）

- **官方**：`intercept-gate.mjs:154-173`（调用与拦截）、`distill-detect.mjs`（核心，不在本次六文件内，被 `:8` 引入）
- **我们**：`distill.mjs:284-327`（`detectDistill`）、`:329-336`（错误配置）、`gate.mjs:279-317`
- **差异**：
  - 位置一致：都在硬正则**之前**，都是最便宜的一关。
  - 语义一致：蒸馏命中 → 403 + 封 device + 不写拒答缓存（官方 `:169-171`；我们 `gate.mjs:307-311`）。
  - 我们都区分「收割包装 / 正则 / 指纹 / 结构」四层，且都在 `official` / `zeroInject` 时放行后两层（我们 `distill.mjs:304-310`）。
  - 差异：官方把蒸馏规则完全放在 `core/distill-detect.mjs`，`jev-intercept` 只 import（`:8`）；我们把规则放在 `risk/distill.mjs` + `distill-rules.json`，自包含。职责边界不同，行为不可比的部分（规则内容）需要单独审计 `distill-rules.json`，不在本次范围。
- **风险**：低。
- **建议**：若要逐条对比规则，需要把官方的 `core/distill-detect.mjs` 也纳入范围；本次六文件里看不到规则本体。

### 4. 拒答缓存与设备封禁（第 3 关）

- **官方**：`intercept-gate.mjs:235-266`（匹配与拦截）、`:65-108`（`commitProtocolBlock` 写 hit / remember / device ban）、`refusal-guard.mjs`（核心，被 `:9-16` 引入）
- **我们**：`refusal-cache.mjs:31-42`（常量）、`:80-124`（签名与相似度）、`:373-400`（`matchStoredRefusal`）、`:400-404`（`recordRefusal`）、`gate.mjs:382-424`
- **差异**：
  - **匹配逻辑等价**：精确指纹 → 近似签名，默认相似度 0.9，短于 512 字符不参与近似（我们 `refusal-cache.mjs:31-38`，与官方 `intercept-gate.mjs:59-63` 的 `similarityRatio` 默认 0.9 对应）。
  - **状态码有意的差异**：官方 `refusalGuardError` 走 sub2api 语义（被 `:249` 调用），我们用 **400 且不可重试**，理由写在 `gate.mjs:24` 与 `:139-141`：「Claude Code 把 403 当登录失效」。这是一个正确的取舍，不是漏洞。
  - **关键差异 1（封号相关）**：官方命中 exact/similar 时 `banDevice: match.kind !== 'device'`（`intercept-gate.mjs:260`），也就是**除了已经是 device 封禁之外，拒答命中也要封设备**；我们 `gate.mjs:415-416` 是 `ban_device: false`。我们只拦当前请求，不升级到设备级。
  - **关键差异 2（封号相关）**：官方把「写回记忆」放在 `commitProtocolBlock`（`:82-96` 的 `repo.remember`），并且在这里写 device ban（`:97-107`）。我们的 `runInboundGate` 只是**返回**一个 `commit` 描述（`gate.mjs:505-518`），`recordRefusal` 是独立导出、由调用方自己调（`refusal-cache.mjs:400-404`）。而真实入口 `server.mjs:512-536` 只处理 `gate.action === 'block'`，**完全没有读 `gate.commit`**。也就是说：蒸馏/拒答命中后「封 device」和「记忆」在当前请求路径上不会发生。
  - 差异 3：我们完全没有 device 维度的数据模型。官方用 `inboundRefusalDeviceId({ inbound, body, headers })` 从请求里提设备 id（`intercept-gate.mjs:167,200,223,292`），并落到 `RefusalDeviceBlocksRepo`（`:17,33-40`）。我们传进 gate 的 `headers` / `sessionId`（`server.mjs:513-516`）在 `evaluateInbound` 里根本没被使用。
- **风险**：**中（封号）**。拦截本身有效（请求不 hop、不消耗额度），但「同一设备反复投递蒸馏/越狱」不会升级成设备封禁，每次都要重新打分、重新触达风控服务；对比官方少了一道「重复试探」的抑制。不是高危，因为请求确实没打到上游。
- **建议**：优先把 `commit` 接上——至少在 `server.mjs` 的 block 分支里消费 `ban_device` / `remember`，并给 `RefusalCache` 加一个 device 维度的索引（或单独的 device 表）。这是「防封号」在入口处最实在的一步。

### 5. 决策模型打分（第 4 关）

- **官方**：`jev-intercept.mjs:1269-1335`（`classifyJev`）、`:1089-1110`（`parsePolicyDecision`）、`:1120-1131`（`questionsFor`）、`:1133-1139`（`dedupKey`）、`intercept-gate.mjs:268-311`
- **我们**：`classifier.mjs:255-358`（`classifyJev`）、`:205-231`（`parseDecision`）、`:172-187`（`questionsFor`）、`:233-240`（`dedupKey`）、`:360-385`（`failed`）、`gate.mjs:426-471`
- **差异**：
  - **构造等价**：同样的 `{ state, questions }` payload、同样的 `type: 'noul'` 问句结构、同样的 `criteria {true:'safe to process', false:'harmful or disallowed'}`（官方 `:1112-1119`；我们 `classifier.mjs:172-181`）。
  - **容差逻辑等价**：只有一道题命中且分数与阈值差在 band 内 → 视为噪声放行（官方 `:1083-1087`；我们 `classifier.mjs:198-204`）。
  - **缓存窗口等价**：默认 60s，key 含 url/model/阈值/问句集合/正文（官方 `:1133-1139`；我们 `classifier.mjs:233-240`）。过期删除两边都有。
  - **fail-open 语义一致**：官方默认 `fail_open: true`（`:364`），服务不可用时放行并由调用方标记；我们 `defaultClassifierConfig.failOpen: true`（`classifier.mjs:78`），放行时 `reason: 'fail-open'`，第 5 关标 `suspicious`（`gate.mjs:476-487`）。
  - **默认关闭一致**：官方 `enabled: false`（`:343`），我们 `enabled: false`（`classifier.mjs:70`）。官方注释「第 4 关自身的 enabled 是 false，需显式接」对应我们 `gate.mjs:176`。
  - 差异 1：**响应结构不认识时的处理不同**。官方 `parsePolicyDecision` 返回 null 时直接 `{ action:'pass', reason:'invalid' }`（`:1318`），即一律放行；我们走 `failed()`（`:360-385`），`failOpen=false` 时会**拦截**（`blocked: true`）。默认配置下无行为差异（都是放行），但严格模式语义相反。
  - 差异 2：**密钥/主机轮换策略不同**。官方有 `retiredJevKeys` 全局退休表 + `keyCursor` 轮询 + `skipUrl` 跳过整个 host（`:1231-1250`、`:1288-1330`），网络错误只跳过该 host 不淘汰密钥；我们是顺序遍历 `apiKeys`，网络错误直接 `return failed(...)`，不试下一把（`classifier.mjs:295-354`）。多密钥场景下我们的可用性更差。
  - 差异 3：官方支持 `https://host <key>` 形式的行内 host 绑定（`:1238-1258` `splitKeyLine` / `jevTargets`），我们只支持裸 key。
  - 差异 4：默认路径不同——官方 `decisionUrl` 补 `/v1/systemone`（`:1052-1060`），我们补 `/v1/decide`（`classifier.mjs:162-170`）。对自建打分服务无影响，对直连 Jev 有影响。
  - 差异 5：超时默认 2000ms（官方 `:96`）vs 3000ms（我们 `classifier.mjs:31`）；`max_state_chars` 都是 16000。
- **风险**：低-中。核心判定一致；差异集中在故障路径。
- **建议**：若要接多密钥，抄官方的 `retiredJevKeys` + `skipUrl` 两个集合；`failOpen=false` 时把「解析失败」与「网络失败」分开，前者应放行（跟官方一致）。

### 6. 门控顺序与「不 hop」语义

- **官方**：`intercept-gate.mjs:1-7`（头注释：顺序 = 便宜→缓存→模型，block never hops）、`:121-314`（`evaluateProtocolIntercept`）、`:317-322`（`runProtocolIntercept`）
- **我们**：`gate.mjs:1-37`（头注释，含同样的顺序理由）、`:255-489`（`evaluateInbound`）、`:505-518`（`runInboundGate`）
- **差异**：
  - **顺序完全一致**：蒸馏 → 硬正则 → 拒答缓存 → 决策模型 → 放行。两边注释连理由都一样（「便宜的在前，贵的在后」「拦住的请求不 hop，不消耗上游额度」）。
  - **「判定」与「落地」分离的设计一致**：官方 `evaluateProtocolIntercept` 明确「Does not write」（`:118-120`），写入靠 `commitProtocolBlock`；我们 `evaluateInbound` 注释「不写拒答缓存、不改 device 状态」（`gate.mjs:237`），`runInboundGate` 返回 commit。
  - **差异**：官方的 `runProtocolIntercept` 会**自己调用** `commitProtocolBlock` 完成副作用（`:317-322`）；我们的 `runInboundGate` 只把 commit 交给调用方，调用方没接（见第 4 项）。
  - **差异**：我们的第 5 关是一个显式的「放行出口」，带 `pass_reason`（`stats.mjs:26-36`）；官方没有这一关，放行直接 `return pass(...)`（`:313`）。这是我们的增强，用于看漏拦，不改变行为。
- **风险**：低。设计同构，落地断链。
- **建议**：保留第 5 关的观测能力；把 commit 接上即可。

### 7. 账号范围门控（哪些槽位走风控）

- **官方**：`intercept-gate.mjs:136-153`（平台/scope 判定）、`jev-intercept.mjs:610-646`（`jevScopeConfigured` / `jevScopeWaits` / `jevAccountInScope`）、`:43-93`（账号类型与套餐桶）、`:667-728`（`normalizeJevConfig` 里的 scope 字段）
- **我们**：`gate.mjs:268`（只有 `isOpenaiPlatformModel` 一个判断）、`:476-478`（OpenAI 平台直接放行）
- **差异**：
  - 官方支持按 `platform:plan` 选择哪些槽位接入风控（`claude:max`、`gpt:plus`…），默认「空 = 全部账号」（`:36-42`）。GPT 平台默认不接入，除非面板打开 `openai_platform_enabled`（`:141-142`）；一旦设了 scope，就按 scope 决定 GPT 走不走（`:143-149`）。
  - 我们只有「OpenAI 平台模型不接入本闸」这一条（`gate.mjs:476-478`、`stats.mjs:30`），没有 scope、没有账号维度、没有套餐桶。
- **风险**：低-中（不是封号，是覆盖面与额度策略）。所有 Claude 流量无条件过闸，所有 OpenAI 流量无条件不过闸，运营上不可调。
- **建议**：若短期不做 scope，至少在配置里留一个 `platform` 白名单，避免以后加槽位时要改 gate 主流程。

### 8. 入站预处理（system-reminder 剥离 / base64 展开 / 动态值稳定化）

- **官方**：`jev-prepare.mjs:37-55`（`stripReminders`）、`:56-141`（base64 展开）、`:142-147`（`prepareInterceptText`）、`intercept-gate.mjs:175-182`（两套文档分别预处理）
- **我们**：`prepare.mjs:62-114`（`stripReminders`）、`:119-206`（base64）、`:207-214`（`prepareText`）、`:22-60`（`normalizeText` + `stabilizeDynamic`）、`:430-455`（`prepareInbound`）
- **差异**：
  - **高度对齐**：`MIN_RUN=32`、`MAX_RUN=64*1024`、`MAX_DECODED=64*1024`、`MAX_SEGMENTS=8`、`MAX_PASSES=3` 这些常量两边一致（官方 `jev-prepare.mjs:10-14`；我们 `prepare.mjs:64-68`，前缀多一个 `B64_`）。
  - **我们多一层 `stabilizeDynamic`**（`prepare.mjs:30-60`）：把随机 id、时间戳之类的动态值替换成占位符，让「同一段正文」在去重/相似度上稳定。官方没有这一层（`jev-prepare` 里没有对应函数）。这是增强，但会改变送进打分服务的文本——如果替换过度，可能让打分模型看不到关键上下文。属于需要单独验证的点，本次只读代码无法判定。
  - **我们多一层 `normalizeText` 在文档拼接前**（`prepare.mjs:368-397`），官方只在 `jevModelDocument` 里对每段做 `normalizeText`（`jev-intercept.mjs:1019`）。等价。
  - 差异：官方对「硬正则文档」和「模型文档」分别调用 `prepareInterceptText`（`intercept-gate.mjs:175-182`），我们对全量 `labeled` 预处理一次后共享（`gate.mjs:262-266`）。行为上我们会对 system 段也做 base64 展开（官方模型文档也展开，等价），但硬正则文档也共享了展开结果——官方硬正则文档是独立的 `jevDocument` 再展开，结果相同。无实质差异。
- **风险**：低。
- **建议**：给 `stabilizeDynamic` 加一个「替换前后 diff 日志」开关，便于确认没有把语义替换掉。这是本次唯一无法静态判定的点。

### 9. 错误体与状态码

- **官方**：`jev-intercept.mjs:946-954`（`policyBlockError`，403 + `permission_error` + `policy_blocked`）、`:26-29`（`isPolicyBlockMemory` 用于区分自家拦截文案）、`intercept-gate.mjs:207-231`（硬正则错误体）
- **我们**：`gate.mjs:67-103`（`makeRiskError`）、`:105-172`（`stageError`）、`refusal-cache.mjs:400-404`
- **差异**：
  - 文案对齐：`POLICY_BLOCK_MESSAGE = '请求被协议拦截'`（官方 `:21`）与我们 `DEFAULT_MESSAGES.hard_regex`（`gate.mjs:56`）一致；蒸馏文案也一致。
  - 结构对齐：都是 `{ error: { type, code, message, details?, request_id? } }`（我们 `gate.mjs:67-77`）。
  - **差异 1**：官方有 `isPolicyBlockMemory`（`:26-29`）用来在拒答缓存里排除「自家拦截文案」，防止自己的 block 记录把后续重试全部拦死（`intercept-gate.mjs:246-247` 有明确注释）。我们 `refusal-cache.mjs` 没有这个概念；但我们的 gate **从不 write**（`remember: false` 贯穿 `gate.mjs:310,350,372,415,463`），所以暂时不会踩这个坑。一旦接上 `recordRefusal`，必须同时补这个过滤。
  - **差异 2**：对外响应形状不同。我们 `server.mjs:519-527` 在 block 时发 `{ type:'error', error:{ type, message } }`，比官方多一层 `type:'error'`，且 `error` 里没有 `code`/`details`。客户端按 Anthropic 规范解析时可能取不到错误码。
  - 差异 3：我们第 3 关用 400（`gate.mjs:139-141`），官方用 sub2api 的拒答错误（被 `:249` 调用，具体 status 在 `refusal-guard.mjs`，不在本次范围）。这是有意的取舍。
- **风险**：低。差异 2 是协议兼容问题，不是风控问题。
- **建议**：把 `server.mjs` 的 block 响应体改成直接用 `gate.error?.body`（`stageError` 已经产出规范结构，`gate.mjs:105-172`），不要在外层重新拼。

### 10. 模型矩阵与模型名解析（`model-policy` 第一半）

- **官方**：`model-policy.mjs:1-8`（三种 catalog 模式）、`:142-410`（种子矩阵）、`:430-515`（归一）、`:656-680`（`resolvePolicyModelId`）、`:680-708`（`getModelEntry`，含默认 betas 与 params）、`:714-751`（能力/beta/context-1m 查询）、`:1031-1052`（`defaultMaxTokensForModel` / `applyMaxTokensCap`）
- **我们**：**无对应文件**。`grep -rn "model.policy\|modelPolicy\|applyModelRequestRules\|resolvePolicyModelId" src/` 只命中 `risk/distill.mjs` 里无关的 `thinking budget` 字符串。
- **差异**：
  - 官方维护一张按模型的**能力矩阵**：context window、是否支持 1M、thinking 模式（`enabled_only` / `adaptive`）、是否支持 effort、是否支持 context management、默认 `max_tokens`、`max_tokens_cap`、`thinking_fallback_budget`、`default_effort`（`:49-141` 的 `CAP_*` 与 `entry()`）。
  - **模型名会被改写，但只做规范化**：`resolvePolicyModelId` 处理别名表、`provider/` 前缀、`[1m]` 后缀、大小写（`:656-680`）；`applyModelRequestRules` 对 Opus 5.5 / Sonnet 5.5 写 canonical id（`:859-882`）。**没有任何「把强模型换成弱模型」或反向的逻辑**。
  - 官方还有 `filterPublicModelIds` / `syncWorkerModelsIntoPolicy`（`:955-1029`）做对外模型列表与 worker 的交集，属于目录管理，与风控无关。
  - 我们完全没有这一层。模型名从 `body.model` 原样进、原样出。
- **风险**：中（功能缺失）。影响：别名请求（`haiku`、`claude-haiku-4-5`、带 `[1m]`）不会被归一，可能打到不存在的 id 而 400；模型能力未知时无法做任何 per-model 决策（thinking 转换、max_tokens 上限、beta 剥离都依赖它）。
- **建议**：不一定要复刻 1052 行。最小可用版只需要三列：`supports_adaptive`、`supports_effort`、`max_tokens_cap` + 一张别名表。这是下面第 11 项的前置。

### 11. 降智相关：thinking / effort / max_tokens / beta

这是本次审计最重要的一项。官方的「防降智」不是靠改写模型名，而是靠**把调用方没写、但官方客户端一定会写的字段补齐**。

- **官方**：
  - `thinking.mjs:224-234` `ensureUnofficialAdaptiveThinking`：**请求没带 thinking 时，给支持的模型补 `{ type:'adaptive', display:'omitted' }`**；带了但缺 display 时补 `omitted`，且从不覆盖调用方的 display。
  - `thinking.mjs:291-305` `ensureUnofficialEffortHigh`：**没带 `output_config.effort` 时补 `high`**（Opus 5.5 / Haiku 5.5 用矩阵里的 `default_effort: 'medium'`，见 `model-policy.mjs:205,312,345`）；模型不支持 effort 时走 `stripUnsupportedEffort`（`thinking.mjs:247-289`）剥掉，避免 400。
  - `thinking.mjs:115-148` `normalizeThinkingForModel`：adaptive 在不支持的模型上转 `enabled + budget`，保留思考意图；`model-policy.mjs:777-823` `normalizeThinkingByPolicy` 按矩阵做 `adaptive ↔ enabled ↔ strip`。
  - `model-policy.mjs:756-771` `clampEnabledThinkingBudget`：`budget_tokens < 1024` 或缺失时抬到 `thinking_fallback_budget`（默认 4096），注释写明「Anthropic rejects thinking.enabled.budget_tokens < 1024」。
  - `model-policy.mjs:1031-1052` `defaultMaxTokensForModel` / `applyMaxTokensCap`：调用方没给 `max_tokens` 时补 per-model 默认（如 Haiku 4.5 是 8192、Haiku 5.5 是 100000），超过 `max_tokens_cap` 时**截到 cap**。注释强调「Never overwrites inbound」——只补缺省，不改调用方明确给的值（除了超 cap 的截断）。
  - `model-policy.mjs:901-946` `applyBetaPolicyToHeader` / `unofficialMimicryBetaHeader`：官方流量用 `defaultOfficialBetaHeader`；非官方流量**忽略客户端自带的 betas**，改用 Claude Code 的完整 mimicry 集合（`:936-946`），并按矩阵决定是否给 `context-1m`。矩阵里明确给 Haiku 4.5 配了 `drop: [CONTEXT_1M, 'effort-2025-11-24', 'context-management-2025-06-27']`（`:156`、`:176`）——即「哪些 beta 不能发」和「哪些必须发」一样重要。
  - `anthropic-policy.mjs:164-171` `alignSamplingWithThinking`：thinking 开启时**强制 `temperature = 1` 并删掉 `top_p` / `top_k`**，注释「Anthropic: thinking enabled/adaptive only accepts temperature=1」。
  - `anthropic-policy.mjs:422-463` `prepareAnthropicRequest` 把这些编排成固定顺序：`normalizeThinkingForModel` → `applyModelRequestRules` → `applyMaxTokensCap` → （非官方）`ensureUnofficialAdaptiveThinking` + `ensureUnofficialEffortHigh` + `rectifyUnofficialRequest` → 清洗 content → `stripInvalidThinkingBlocks` → `alignSamplingWithThinking` → `ensureClaudeOAuthBodyDefaults` → 缓存标记。
  - `anthropic-policy.mjs:184-247` `stripInvalidThinkingBlocks`：丢弃上游会拒的 thinking 块（无签名/短签名/dummy 签名），5.5 上一个坏块会连坐整条签名链。这是「不被 400」而不是「不降智」，但同属 thinking 质量链路。
- **我们**：
  - `src/betas.mjs:103-196` `withRequestProtocolBetas`：**只做「body 里已有某特性 → 补对应 beta」**，不主动开启任何特性。
  - `src/identity.mjs:104-121` `OFFICIAL_MESSAGE_BETAS`：维护了一份官方 beta 集合，用于身份伪装。
  - `src/anthropic.mjs:113-194` `buildBetaHeader`：合并调用方 beta + 身份 beta，不注入 thinking / effort。
  - `src/risk/` 不碰 thinking、不碰 effort、不碰 max_tokens、不碰 temperature。`grep -rn "adaptive\|effort" src/` 在我们的 Claude 路径上只有 beta 常量，没有补齐逻辑。
- **差异**：
  1. **完全没有「缺 thinking 就补 adaptive」**。第三方客户端（尤其 OpenAI 兼容客户端转过来的请求）通常不带 `thinking`，上游就按「不思考」跑——这正是「降智」最直接的来源。官方在 `thinking.mjs:224-234` 明确补了。
  2. **完全没有「缺 effort 就补 high」**（`thinking.mjs:291-305`）。Opus 5.5 / Sonnet 5.5 这类支持 effort 的模型，不传就按服务端默认（往往更低）跑。
  3. **没有 `temperature=1` 对齐**（`anthropic-policy.mjs:164-171`）。thinking 开启 + temperature≠1 的请求会被 Anthropic 拒绝或忽略 thinking；第三方客户端默认 temperature 常是 0.7。
  4. **没有 thinking budget 下限**（`model-policy.mjs:756-771`）。调用方写 `budget_tokens: 100` 会直接 400，或者被上游静默截断。
  5. **没有 max_tokens 缺省补齐**（`model-policy.mjs:1031-1052`）。缺 `max_tokens` 时上游按很小的默认值跑，长回答被截断——体感就是「变笨了」。
  6. **没有 per-model beta 剥离**。我们 `identity.mjs` 的 beta 集合是「发什么」，没有「哪些模型不能发什么」。给 Haiku 发 `context-1m` / `effort` 会 400（官方矩阵 `model-policy.mjs:156,176` 就是在防这个）。
- **风险**：**高（降智）**。这是本次审计里唯一的高风险项，且与用户目标「防降智」正面对撞。两点补充：(a) 如果入站全是真 Claude Code CLI、且 CLI 宿主原样转发 `body`，客户端自己会带 thinking/effort，风险会降低——但 CLI 宿主是否透传 `body.thinking` 需要单独确认；(b) `server.mjs:77` 打开了 Codex 通道（`/v1/responses`、`/v1/chat/completions`），这条路径的请求不带 Claude 的 thinking/effort 字段，一定受影响，`codex-convert.mjs` 只做 reasoning.effort 的格式转换（`src/codex-convert.mjs:365-367`），不补 thinking。
- **建议**（按收益排序）：
  1. 在出站组装处（`src/anthropic.mjs` 的 `prepareOutbound` 一带）加一个 `ensureUnofficialThinking(body, model)`：没 thinking → `{type:'adaptive', display:'omitted'}`；有 thinking 且 temperature≠1 → 改 1 并删 top_p/top_k。
  2. 加 `ensureEffort(body, model)`：支持 effort 的模型且没 `output_config.effort` → 补 `high`（5.5 系列用 `medium`）；不支持的模型剥掉。
  3. 加 `max_tokens` 缺省表 + cap。这三件事加起来不到 150 行，收益最大。
  4. 如果要完整对齐，再引入 `model-policy` 的能力矩阵；否则用一张 10 行的常量表也能覆盖主流模型。

### 12. `request-rectifier`：修正什么，为什么需要

- **官方**：`request-rectifier.mjs:1-6`（头注释：sub2api `FilterThinking` / retry-filter 的 analog）、`:50-91`（`pairMissingToolResults`）、`:94-102`（`ensureConversationEndsWithUser`）、`:104-133`（`ensureOutputConfigSchema`）、`:163-222`（搜索块扁平化）、`:277-279`（首次只修 schema）、`:282-289`（重试才补 tool 配对 + user turn）
- **我们**：**无对应文件**。
- **差异**：
  - 它修的是四类**会让 Anthropic 返回 400 的形态**，不是「合规」：
    1. assistant `tool_use` 之后缺对应 `tool_result` → 补占位结果（`:50-91`）；
    2. 对话以 assistant 结尾（prefill）→ 追加一个 `continue` 的 user turn（`:94-102`）；
    3. `output_config` 的 JSON schema 缺 `additionalProperties` → 递归补 `false`（`:104-133`）；
    4. 回放的 `server_tool_use` / `web_search_tool_result` 的加密载荷当前账号解不开 → 扁平化成纯文本，`server_tool_use` 和它的结果一起扁平，避免留下孤儿调用（`:163-265`）。
  - **关键设计**：官方明确区分「首次」和「重试」。首次只修 schema 和非法 cache_control 字段（`:277-279`），因为**官方 Claude Code 会故意发 prefill 和不完整 tool turn**（`:3-5`），首次就改写会改变官方客户端的合法行为；只有重试时才补 tool_result / user turn（`:282-289`）。
  - 我们没有任何等价物。`src/anthropic.mjs` 只做出站组装与 SSE 解析，不改消息序列。
- **风险**：中（可用性，不是封号）。如果我们的入站包含第三方客户端，缺 tool_result 或 assistant prefill 会直接 400；如果全部是官方 CLI，则不需要。
- **建议**：先确认入站客户端类型。若只有官方 CLI，可以不做；若接了第三方（尤其 OpenAI 兼容转换），至少要做 `ensureOutputConfigSchema` 和 `pairMissingToolResults`，并保持「首次不修 prefill」的克制——否则会把官方客户端的合法 prefill 改写掉，反而暴露。

### 13. `web-search`：官方怎么处理，v1.3.220 的基础实现

- **官方**：`web-search.mjs:1-17`（头注释）、`:19-30`（`CLAUDE_WEB_SEARCH_TOOL`）、`:176-183`（`shouldInjectClaudeWebSearch`）、`:196-203`（`ensureClaudeWebSearch`）、`:206-212`（`dropWebSearchFlag`）、`:215-225`（`SERVER_TOOL_DROP` / `WEB_SEARCH_KEEP`）、`:231-253`（`toAnthropicCustomTool`）、`:260-291`（`sanitizeAnthropicTools` / `sanitizeBodyServerTools`）
- **我们**：**无 Anthropic 侧实现**。`grep -rln "web_search\|server_tool_use" src/` 只命中 `src/codex-convert.mjs`（Codex 的 hosted search 转换）。
- **差异**：
  - **注入条件**：官方在「末轮 user 明确要求搜索」或「回放了搜索历史」时补原生 server tool；官方入站永不注入；`body.web_search=false` / `x-kin-web-search: false` / `tool_choice=none` 时不补（`:176-199`）。搜索历史必须保持工具在位，否则上游拒绝回放块（`:6-8`）。
  - **形状极窄**：只允许 `{ type:'web_search_20250305', name:'web_search', max_uses:8 }`（`:25-30`）；注释明确「Do not add description / input_schema — the native type is the whole prompt」（`:15-16`）。这是被上游 400 教育出来的。
  - **清洗**：客户端自带的 `web_search` 保留其 options 但只留白名单字段（`:216-225`），其余 server tool 剥掉 `input_schema` / `description` / `parameters` / `function` / `strict`（`:215`），自定义 tool 补齐 `{name, description, input_schema}`（`:231-253`）。
  - **v1.3.220 与 222 的关系**：220 已有完整基础实现（注入 + 清洗 + 扁平化 + fingerprint）。222 的相关修复在本 checkout 的 `CHANGELOG.md:823` 能看到对应描述：「非官方请求不再因为正文里出现或消失『搜索 / search』而增删 `web_search`。显式开关和已回放的搜索结果不变。」这说明 220 的早期行为是「按关键词增删工具」，会**改写 tool 前缀、破坏 prompt cache**；修复后 `shouldInjectClaudeWebSearch` 只看显式 flag 与历史（`web-search.mjs:170-183` 的注释正是这条：`A bare "search" / "搜索" in the latest user text must not add or remove the tool: this rewrites the tool prefix and breaks the prompt cache`）。也就是说，**220 的基础实现在，但注释已带 222 的结论**——本 checkout 的 `web-search.mjs` 不是纯 220 快照，判断逻辑已按「显式 flag + 历史」实现。审计时按「当前代码」为准，不要按 220 的旧行为推断。
- **风险**：低（功能缺失，但架构上可能不需要）。我们的 Claude 路径若跑真 CLI，客户端自己声明 `WebSearch`，网关不需要注入；这与 vm2api 的「任意客户端转 API」定位不同。
- **建议**：先确认是否需要「客户端不带搜索也能搜」。需要就抄 `ensureClaudeWebSearch` + `sanitizeAnthropicTools`（约 100 行）；不需要就明确写成「不在范围」，避免被当成遗漏。

### 14. `anthropic-policy`：出站字段清洗

- **官方**：`anthropic-policy.mjs:28`（`TOOL_NAME` 正则）、`:86-102`（`enforceCacheLimit`，最多 4 个断点）、`:164-171`（采样对齐）、`:184-247`（thinking 块清洗）、`:312-329`（clear_thinking 的 context management）、`:330-351`（fast mode beta）、`:368-405`（按 beta 清洗 body）、`:409-415`（OAuth 默认值）、`:422-463`（总编排）、`:481-515`（`rewriteToolNames`）、`:517-551`（响应侧还原）
- **我们**：`src/anthropic.mjs` 只有 beta 头合并与 SSE 解析；`src/cache-breakpoints.mjs` 有「thinking 块不能带 cache_control」的检查（`:48-50`、`:319-322`）；没有 tool 名重写、没有 thinking 块签名清洗、没有采样对齐、没有按 beta 清洗 body。
- **差异**：
  - **tool 名重写**：Anthropic 要求 `^[A-Za-z0-9_-]{1,64}$`（`:28`）。MCP 工具名常带 `.` / `:`，直接发会 400。官方做双向映射并在响应里还原（`:481-551`）。我们不做。
  - **cache 断点上限 4**（`:86-102`）：我们 `cache-breakpoints.mjs` 有自己的注入预算 `MAX_CACHE_MARKERS = 4`（`:26`、`:353-383`）和校验（`:299-304`），但**没有**官方那种「对调用方已经塞进来的超限标记做删除」的 `enforceCacheLimit`。第三方客户端自带 5 个以上标记时会 400。
  - **按 beta 清洗 body**（`:368-405`）：没有 `context-management` beta 就删 `context_management`；没有 `prompt-caching-scope` beta 就删 `cache_control.scope`；没有 `fast-mode` beta 就删 `speed`；不支持中途 system 就抬升 `role:'system'`。这些全是「不发就 400」的字段。我们 `betas.mjs` 是「有字段才补 beta」，方向相反——**如果客户端硬塞了字段但我们的 beta 集合没覆盖，就会 400**。
  - **thinking 签名清洗**（`:184-247`）：我们没有。第三方客户端回放的 thinking 块签名几乎一定无效，会 400。
- **风险**：中（可用性 + 可能的「被识别为非官方」）。特别是 tool 名与 thinking 签名，是第三方客户端最常见的 400 来源。
- **建议**：优先级低于第 11 项（降智），但高于 web-search。最小集：tool 名重写 + thinking 块清洗 + cache 断点截断。

### 15. 客户端指纹分类（与封号的真实关系）

- **官方**：`client-fingerprint.mjs:1-5`（注释：只用于日志/审计与非官方人设策略，**从不冒充客户端或改 HTTP 头**）、`:29-40`（`classifyClient`，识别 `claude_code_official` / `oh_my_pi` / `third_party_sdk` / `hermes` / `openclaw` / `third_party` / `unknown`）
- **我们**：`src/persona/`（CLI 伪装、KVM、procfs/uts 伪造）、`src/identity.mjs`（beta 集合与身份字段）、`src/frames.mjs:649-707`（`metadata.user_id` 与 `device_id` 规范化）
- **差异**：
  - 官方这一层**只做分类，不做伪装**；真正的伪装在 `identity/crs-headers.mjs` / `crs-persona.mjs`（被 `:6-7` 引入）和出站组装里。我们的 `src/persona/` 是更重的一层（真 VM 保真），方向不同但目标一致。
  - **与封号的真实关系**：封号风险主要来自「上游认为这是非官方客户端」——由 UA、beta 集合、`metadata.user_id` 形态、请求节奏共同决定。这部分**不在 `risk/` 层**，我们仓在 `identity.mjs` / `persona/` / `frames.mjs` 里做了一部分（beta 集合已对齐 `identity.mjs:104-121`，device id 规范化在 `frames.mjs:649-707`）。
  - 官方 `classifyClient` 的 `claude_code_official` 判定被 `shouldInjectClaudeWebSearch` 用来决定「不注入」（`web-search.mjs:177`）——分类结果会反向影响出站形状。我们若要做 web-search，也需要一个等价的「是否官方入站」判断。
- **风险**：低（risk 层视角）；整体仓的封号风险需要在 `identity/` 与 `persona/` 另做审计。
- **建议**：本次审计不要把封号风险全记在 `risk/` 头上。`risk/` 的封号贡献是「拦住高危请求，不让它打到上游」，这部分已对齐；「不让上游看出是网关」是另一条线。

---

## 差异汇总表

| # | 能力 | 官方 | 我们 | 差异性质 | 风险 |
|---|---|---|---|---|---|
| 1 | JEV 定位/类别 | `jev-intercept.mjs:19-34` | `classifier.mjs:25-66` | 基本对齐；题库少 reverse/pentest/cyber | 低-中 |
| 2 | 硬正则 | `jev-intercept.mjs:108-158,962-990` | `hard-policy.mjs:43-108,266-301` | 对齐 | 低 |
| 3 | 蒸馏检测 | `intercept-gate.mjs:154-173` | `distill.mjs:284-327` | 对齐（规则本体不在本次范围） | 低 |
| 4 | 拒答缓存 | `intercept-gate.mjs:235-266` | `refusal-cache.mjs:373-400` | 匹配对齐；device 封禁缺失 | 中（封号） |
| 5 | 决策模型 | `jev-intercept.mjs:1269-1335` | `classifier.mjs:255-385` | 核心对齐；故障路径不同 | 低-中 |
| 6 | 顺序/不 hop | `intercept-gate.mjs:1-7,121-322` | `gate.mjs:1-37,255-518` | 对齐 | 低 |
| 7 | 副作用落地 | `intercept-gate.mjs:65-108` | `gate.mjs:505-518`（无人消费） | **断链** | 中（封号） |
| 8 | 账号 scope | `jev-intercept.mjs:610-646` | 无 | 缺失 | 低-中 |
| 9 | 预处理 | `jev-prepare.mjs:37-147` | `prepare.mjs:62-214` | 对齐 + 我们多 stabilize | 低 |
| 10 | 错误体 | `jev-intercept.mjs:946-954` | `gate.mjs:105-172` | 基本对齐；外层形状不同 | 低 |
| 11 | 模型矩阵 | `model-policy.mjs:142-708` | 无 | 缺失 | 中 |
| 12 | **降智补齐** | `thinking.mjs:224-305` + `model-policy.mjs:756-1052` | 无 | **缺失** | **高（降智）** |
| 13 | request-rectifier | `request-rectifier.mjs:50-289` | 无 | 缺失 | 中（可用性） |
| 14 | web-search | `web-search.mjs:176-291` | 仅 Codex 侧 | 缺失（可能不需要） | 低 |
| 15 | 出站清洗 | `anthropic-policy.mjs:28-551` | 部分（`cache-breakpoints.mjs`） | 缺失 | 中（可用性） |
| 16 | 指纹分类 | `client-fingerprint.mjs:29-40` | `identity.mjs` / `persona/` | 分层不同 | 低 |

---

## 结论：是不是同一件事？

**一半是，一半不是。必须分开说，否则会误判。**

- **是同一件事的部分**：我们的 `risk/` 五关 ≈ 官方的 `jev-intercept` + `intercept-gate` + `jev-prepare`。类别、阈值、问句、顺序、容差、dedup、fail-open、「拦了就不 hop」这些语义都对得上，甚至注释里的理由都一样。这不是巧合，是有意的复刻。差异只在边角：device 封禁没落地、scope 没做、故障路径的容错策略不同。
- **不是同一件事的部分**：官方的 `model-policy` / `request-rectifier` / `web-search` / `anthropic-policy` 解决的是**另外三个问题**——(a) 让请求被上游接受（400 修补、字段剥离）；(b) 让模型保持官方客户端同等质量（thinking/effort/max_tokens）；(c) 让出站形状像官方客户端（beta、工具、指纹）。我们的 `risk/` 完全不碰这三个。它们不在 `risk/` 里，不代表仓库里没有；`src/identity.mjs`、`src/betas.mjs`、`src/anthropic.mjs`、`src/persona/` 覆盖了一部分，但**第 11 项的 thinking/effort 补齐在整仓范围内确实没有**。

**所以对用户的三个怀疑，最终判断是：**

1. 「官方 `jev-intercept` 是必做的，不剥字段就被识别」——**不成立**。它默认关闭，也不剥任何字段。它是「内容风控」，不是「指纹清洗」。不做它不会因为字段被识别；不做它会少拦蒸馏/越狱请求。
2. 「官方 `model-policy` 改写模型名防降智」——**部分成立，但机制不是改名**。改名只是规范化；防降智靠的是补 thinking / effort / max_tokens。我们这块**确实缺**，这是本次审计的最高优先级。
3. 「`request-rectifier` 有等价物吗」——**没有**。但它修的是 400，不是合规。要不要补，取决于我们是否接第三方客户端。

## 建议的处置顺序

| 优先级 | 动作 | 依据 | 预估 |
|---|---|---|---|
| P0 | 出站补 `thinking`（缺省 adaptive+omitted）、`effort`（缺省 high / 5.5 用 medium）、`temperature=1` 对齐 | `thinking.mjs:224-305`、`anthropic-policy.mjs:164-171` | ~80 行 |
| P0 | 补 `max_tokens` 缺省表 + cap | `model-policy.mjs:1031-1052` | ~40 行 |
| P1 | 把 `gate.commit` 接到 `server.mjs` 的 block 分支，落地 `ban_device` / `remember` | `intercept-gate.mjs:65-108`、`gate.mjs:505-518` | ~50 行 |
| P2 | 补 thinking budget 下限 1024 → 4096 | `model-policy.mjs:756-771` | ~15 行 |
| P2 | 修 `server.mjs` 的 block 响应体，直接用 `gate.error.body` | `gate.mjs:105-172` | ~10 行 |
| P3 | 补 request-rectifier 的最小集（schema + tool_result 配对，首次不修 prefill） | `request-rectifier.mjs:277-289` | ~80 行 |
| P3 | 补 tool 名重写 + thinking 块签名清洗 | `anthropic-policy.mjs:28,184-247,481-515` | ~120 行 |
| P4 | 补 scope 门控（至少 platform 白名单） | `jev-intercept.mjs:610-646` | ~60 行 |
| P5 | web-search 注入（仅在确认客户端不带搜索时） | `web-search.mjs:196-291` | ~100 行 |

## 审计限制

- 只读静态代码，未运行 `node src/risk/demo.mjs`，也未做端到端请求验证。第 8 项的 `stabilizeDynamic` 是否影响打分、第 12 项的实际降智幅度，都需要跑起来才能确认。
- 官方侧只覆盖了指定的 6 个文件；`distill-detect.mjs`、`refusal-guard.mjs`、`refusal-similarity.mjs`、`sanitize.mjs`、`cache-ttl.mjs`、`thinking.mjs` 是作为被引用方顺带读的，未做逐行审计。其中 `thinking.mjs` 因为是降智核心，读了关键函数并引用了行号。
- 我们侧只覆盖 `src/risk/`，另加 `server.mjs` / `anthropic.mjs` / `betas.mjs` / `identity.mjs` / `cache-breakpoints.mjs` / `frames.mjs` 的调用点确认，未审计 `src/persona/` 与 `src/egress/`。
- 版本说明：`research/vm2api` 的 `web-search.mjs` 注释已包含 222 的修复结论（“bare search 不能增删工具”），不是纯 220 快照；本文按当前代码描述，并在第 13 项标注了这一点。
