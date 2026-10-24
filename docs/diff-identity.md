# identity 层对比（我们 vs 官方 v1.3.220）

> 审计对象
> - 官方：`research/vm2api/src/lib/identity/`（19 个 `.mjs` + 1 个 `.json` fixture），v1.3.220。
> - 我们：`research/reimpl/src/`。
> - 下文 `[O]` 指官方、`[R]` 指我们；行号均为**当前工作区**行号，可用 `sed -n '<行>p' <文件>` 复核。
>
> **基线快照（重要）**：本次审计期间目标文件仍在被并行修改。
> `system-layout.mjs` / `prompt-profiles.mjs` / `anthropic.mjs` / `server.mjs` 的 mtime 为 `2026-10-24 08:16:45`，`cch.mjs` 为 `08:13:41`。
> 下文的结论与行号**均已按 08:16:45 之后的版本复核**（例如 `BILLING_ENTRYPOINT` 已从 `'cli'` 改为 `'sdk-cli'`，`[R]src/system-layout.mjs:52`）。
> 如果后续还在改，请以行号复核结果为准，不要只看结论。
> 同目录另有 `diff-anthropic.md` / `diff-risk.md` / `diff-telemetry.md`，遥测的细粒度差异以 `diff-telemetry.md` 为准，本文只保留与 identity 层交界的那部分。

---

## 结论摘要

- **封号风险项：9 个**
  1. `metadata.user_id` 不重写：调用方给的**字符串形态 user_id 原样透传**，官方是全量丢弃并重写（`[R]src/frames.mjs:692-711` vs `[O]identity-rewrite.mjs:425-470`）
  2. 出站**完全没有 `x-claude-code-session-id`**：官方每个 Messages 请求都带，且要求它与 `metadata.user_id.session_id` 一致（`[R]src/anthropic.mjs:178-205` vs `[O]crs-headers.mjs:269-278` + `[O]claude-code-only.mjs:50-58`）
  3. 缺 `accept-language` 与 `anthropic-dangerous-direct-browser-access: true` 两个官方默认头（`[R]src/anthropic.mjs:178-205` vs `[O]crs-headers.mjs:80-93`）
  4. billing header **多出 `prompt_version=` 字段**、**缺 `cc_turn_origin` / `cc_prompt_index` / `cc_turn_index`**（`[R]src/system-layout.mjs:115` vs `[O]crs-persona.mjs:366-380`）
  5. **UA 版本与 billing 的 `cc_version` 会打架**：出站头恒按 `identity.mjs` 取 2.1.296，而 billing 按所选档位可能取 2.1.303（`[R]src/server.mjs:624-631` + `[R]src/identity.mjs:45-52` + `[R]src/prompt-profiles.mjs:287-299`）；官方有专门的门校验这两者一致（`[O]claude-code-only.mjs:60-68`）
  6. 没有"泄漏客户端指纹"的剥离：调用方 system 里若含 `claude-desktop` / `agent-sdk` / `cc_entrypoint=` 会原样出站（`[O]crs-persona.mjs:442-465` 无对应物）
  7. 默认时区写死 `America/New_York`，官方 fallback 是 `UTC`（`[R]src/system-layout.mjs:35,144-146` vs `[O]official-cc-system-2.1.241.mjs:204`）
  8. 遥测 env 字段集合 3 多 1 少（多 `node_version`/`is_running_with_bun`/`github_actions_metadata`，少 `shell`），官方注释明确点名这些字段"不发送"（`[R]src/telemetry/env.mjs:43-83` vs `[O]telemetry-env.mjs:2-5,23-57`）
  9. **默认档（`official_full`）出站的 billing `cc_version` 缺指纹尾缀**：实测输出 `cc_version=2.1.296;`，官方格式是 `cc_version=<ver>.<3hex>;`（`[R]src/server.mjs:149-151` vs `[O]crs-persona.mjs:366-380`）

- **功能缺失项：14 个**（详见逐文件；含 `official-fingerprint` 的 reconcile、`kvm-fingerprint-uuid` 的修补、`identity-rewrite` 的 session 派生、`crs-persona-usage` 的 usage 遮罩、`persona-template` 的模板系统等；其中 **1 个是实测到的数据丢失 bug**，见 §0.5）

- **已对齐：6 项**（`xxh64`、`cch`、UA 字符串本身、stainless 六件套、`officialProjectSlug`/memory 目录、`UUID_RE` 的 8-4-4-4-12 `/i` 形态）

- **判为"无关"的：1 个**（`claude-code-only.mjs`；理由见该节）

### 一页速查

| # | 官方文件 | 我们的对应 | 风险 |
|---|---|---|---|
| 1 | `xxh64.mjs` | `[R]src/cch.mjs:46-101` | 已对齐 |
| 2 | `cch.mjs` | `[R]src/cch.mjs`（整文件） | 已对齐（差分 4/4 一致） |
| 3 | `official-claude-ua.mjs` | 生成：`[R]src/identity.mjs:49-52`；识别：**缺失** | 功能缺失 |
| 4 | `rfc4122-uuid.mjs` | `[R]src/persona/kvm-spec.mjs:346-350`（严格小写）、`[R]src/system-layout.mjs:64` | 功能缺失（无 coerce） |
| 5 | `kvm-fingerprint-uuid.mjs` | 部分：`[R]src/persona/kvm-spec.mjs:497-512`；修补路径**缺失** | 功能缺失 |
| 6 | `official-fingerprint.mjs` | **缺失**（`[R]src/persona/claude-home.mjs` 是单向生成） | 功能缺失 |
| 7 | `workstation-fingerprint.mjs` | 部分：`[R]src/persona/derive.mjs:20-40` + `[R]src/persona/linux.mjs:148-150` | 功能缺失 |
| 8 | `workstation-profile.mjs` | **缺失**（无 SKU / kernel 目录 / kin-seed） | 功能缺失 |
| 9 | `slot-computer.mjs` | **缺失**（契约不同，见节） | 功能缺失 |
| 10 | `vm-identity.mjs` | 部分：`[R]src/frames.mjs:652-711`；settings env 大量缺失 | 封号风险（中） |
| 11 | `identity-rewrite.mjs` | 部分：`[R]src/frames.mjs:672-711` | **封号风险（高）** |
| 12 | `crs-headers.mjs` | 部分：`[R]src/identity.mjs:20-70`、`[R]src/anthropic.mjs:178-205` | **封号风险（高）** |
| 13 | `claude-code-only.mjs` | 无 | 无关 |
| 14 | `official-cc-system-2.1.241.mjs`(+json) | 部分：`[R]src/prompt-profiles.mjs:57-74,304-324` | **封号风险（中）** + 功能缺失 |
| 15 | `crs-persona.mjs` | 部分：`[R]src/system-layout.mjs:24`、`[R]src/prompt-profiles.mjs:456-459` | **封号风险（中）** + 功能缺失 |
| 16 | `crs-persona-usage.mjs` | **缺失** | 功能缺失 |
| 17 | `persona-template.mjs` | **缺失** | 功能缺失 |
| 18 | `telemetry-env.mjs` | 部分：`[R]src/telemetry/env.mjs` | 封号风险（中，开启上报时） |
| 19 | `telemetry-rewrite.mjs` | 部分/反向：`[R]src/telemetry/*` 是"自己发"，不是"拦截改" | 功能缺失 |

> 注：上表按**文件**聚合风险；摘要里的 9 条按**缺陷**列举。其中第 5 条（UA 与 billing 版本打架）与第 9 条（默认档 billing 缺指纹）横跨 `identity.mjs` + `prompt-profiles.mjs` + `server.mjs`，不在单行里；§0.5 专讲第 9 条与"调用方 system 丢失"。

---

## §0.5 两个实测到的出站缺陷（优先级高于逐文件结论）

用 `prepareOutbound` 直接跑默认参数（`systemLayout:'identity'`、`panelTtl:'1h'`），两份档位各跑一次，实测输出：

```
输入 body.system = [{ type:'text', text:'CALLER SYSTEM: answer in French.' }]

=== official_full（默认档）
system 块:
  "x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoin…"   ← ① 缺 .<3hex> 指纹
  "You are a Claude agent, built on Anthropic's Claude Agent SD…"
  "# Environment\n - Timezone: America/New_York"
has caller text: false                                              ← ② 调用方 system 被丢弃

=== official_303
system 块:
  "x-anthropic-billing-header: cc_version=2.1.303.cc0; cc_entry…"   ← 有指纹
  "You are Claude Code, Anthropic's official CLI for Claude…"
  "\nYou are an agent working with the user toward their goals…"
has caller text: true
```

### ① 默认档 billing 的 `cc_version` 缺指纹尾缀 —— 封号风险（高）

- 现象：`official_full` 出站是 `cc_version=2.1.296;`，**没有 `<ver>.<fp>` 里的 `.fp`**，也没有 `cc_prompt_id`。
- 根因：`official_full` 走 `STRUCTURE_CLI_HOP`，档位 `assembleSystemBlocks` 把 `billing` 算出来后交给 `layoutSystemBlocks`，而后者在 `process.env` 没有 `CLAUDE_CODE_SYSTEM_LAYOUT` 时返回 `stock` 布局 → **不产 billing**；于是 `assembled.billing` 为空字符串，`server.mjs` 回落到 `defaultBillingHeader()`（`[R]src/server.mjs:311`），而它只拼了版本号（`[R]src/server.mjs:149-151`）：
  ```js
  function defaultBillingHeader(cliVersion) {
    return `x-anthropic-billing-header: cc_version=${cliVersion}; cc_entrypoint=sdk-cli; cch=00000;`
  }
  ```
- 官方格式（`[O]crs-persona.mjs:366-380`）：`cc_version=<ver>.<fp>; cc_entrypoint=sdk-cli; cch=00000; cc_prompt_id=<uuid>;[ cc_turn_origin=…]`
- 为什么是封号级：`cc_version` 是上游按固定文法解析的字段，`2.1.296.f08` 与 `2.1.296` 的区别不是"差一点更好看"，而是"解析结果不同"；同时缺 `cc_prompt_id`。
- 建议（P0）：`defaultBillingHeader()` 改成复用 `buildBillingAttribution()`（`[R]src/system-layout.mjs:104-116`），把 `firstUserText` 与 `sessionId` 传进去；或者更彻底——让 `assembleRequest` 在 `cli_hop` 结构下也产 billing，去掉"两处独立生成"的分叉。

### ② 默认档会丢掉调用方的整个 system —— 功能缺陷（高）

- 现象：`official_full` 出站里 `has caller text: false`，调用方给的 `CALLER SYSTEM: answer in French.` 不见了；`official_303` 不丢（它把 caller 折进首条 user 的 `<system-reminder>`）。
- 根因：`server.mjs:294-305`
  ```js
  const assembledTexts = new Set((assembled.system || []).map((b) => String(b?.text ?? b ?? '')))
  const callerBlocks = (Array.isArray(next.system) ? next.system : [])
    .map((b) => String(b?.text ?? b ?? ''))
    .filter((t) => t && !assembledTexts.has(t))     // ← 调用方文本本来就在 assembled.system 里
  ```
  `next.system` 就是 `assembled.system`，所以 `callerBlocks` 恒为空；"去掉档位产出的块"这个意图把调用方内容一起过滤掉了。随后第 1 步布局重建（`layoutSystemBlocks`）只会写 billing + IDENTITY + Environment，调用方 system 再也不出现。
- 为什么严重：`official_full` 是默认档（`DEFAULT_PROMPT_PROFILE`，`[R]src/prompt-profiles.mjs:53`），意味着**默认配置下所有调用方的 system prompt 都不生效**。这不是指纹问题，是行为错误——但它同时也会让上游看到"system 只有官方三块、且与请求内容不匹配"的形态，属于可观察异常。
- 建议（P0）：`assembledTexts` 只应包含**档位自己生成**的块（billing / 身份句 / Environment / 主提示词），不应包含透传的调用方文本。最小改法：在 `assembleSystemBlocks` 的返回值里带出"哪些块是档位Owned"的标记，或让 server 层按 `assembled.systemSlots` 逐个判断。

> 这两条都可用文末"复现命令 5"直接重跑。

---

## 特别关注项的结论（先回答）

### ① `official-cc-system-2.1.241.mjs`：我们的 prompt 是不是自己编的？

**不是自己编的。** 证据（可复现）：

- `[R]src/prompt-profiles-303.json` 的 `meta` 明确记录了抓取条件：`cli_version: 2.1.303`、`stainless_package_version: 0.128.0`、`build_time: 2026-10-18T20:20:57Z`、`git_sha: 07df2aed`、`source: "Claude Code 2.1.303 capture, claude-opus-5-5, API key + custom base URL (degraded cache path). Personal paths replaced by {{memory_dir}}."`
- 与官方 2.1.241 fixture 做 12-gram 比对：**16.4%（147/895）命中**；最长逐字连续重合 **62 个词**（那一段代词/性别中立表述在两边完全一致）。
  命令：`node -e "…"`（见本文末"复现命令"）。
  一份"自己编的"提示词不可能在官方 2.1.241 文本里留下 62 词逐字连续重合。
- 结构也对不上"随手编"的形态：`[R]` 的 303 主提示词章节是 `# Harness` / `# Session-specific guidance` / `# Memory` / `# Environment` / `# Context management`，含 `<total_tokens>` 与 `{{memory_dir}}` 两个只有真客户端才会出现的模板位。

**但版本错配是真的，这才是风险所在**：官方 v1.3.220 的 fixture 是 **2.1.241**（`[O]official-cc-system-2.1.241.json`：`identity` 62 字符、`agent_prompt` 10573 字符、`continuation` 15300 字符），出站 CLI 版本 pin 在 **2.1.296**（`[O]vm-identity.mjs:22-24`）；我们的 `official_303` 档把 UA / billing 版本 / 提示词一起抬到 **2.1.303**（`[R]src/prompt-profiles.mjs:115-131`）。
所以"自编"这个怀疑可以排除，但"版本与本仓库 pin 不一致"必须记一笔（见逐文件第 14 节）。

### ② `official-claude-ua.mjs`：Claude 侧 UA 在哪？

**生成有，识别没有。**

- 生成：`[R]src/identity.mjs:49-52` → `claude-cli/${version} (external, ${entry})`，缺省 `sdk-cli`，与官方 `OFFICIAL_CLAUDE_CLI_UA = 'claude-cli/2.1.296 (external, sdk-cli)'`（`[O]vm-identity.mjs:23-24`）**逐字符一致**（已实测）。
- 另一条生成路径：`[R]src/prompt-profiles.mjs:160-163`（按档位版本，`official_303` 会给出 `claude-cli/2.1.303 (external, sdk-cli)`）。
- **识别能力缺失**：没有 `CLAUDE_CLI_UA_RE` / `isOfficialClaudeUa` / `isUnofficialClaudeEntrypointUa` 的等价物（全仓 grep `claude-cli/` 只有两处生成点）。
  后果：我们唯一"判断入站是不是官方客户端"的入口是 `[R]src/prompt-profiles.mjs:456-459` `looksLikeOfficialCaller()`，**只看 system 文本**（billing 头 / 身份句 / 提示词标志段），不看 UA、不看 header 集合。官方是六门联判（UA + `x-app` + `anthropic-version` + `claude-code-20250219` beta + stainless + session 头，见 `[O]claude-code-only.mjs:37-48`）。
- 附带风险：`[R]src/identity.mjs:45-52` 允许 `CLAUDE_CODE_VERSION` / `CLAUDE_CODE_ENTRYPOINT` 环境变量改写 UA；官方是**常量 pin**，不接受环境覆盖（`[O]vm-identity.mjs:23,90`）。

### ③ `kvm-fingerprint-uuid.mjs`：`persona/kvm-spec.mjs` 对齐了吗？

**方向对、缺修复路径。**

- 官方这个文件不是"派生"UUID，而是**修补**：`kin-computer` 二进制在 redacted DMI 画像上可能留下空 UUID，于是从 `identity.json` / `qemu-smbios.args` 读出，非法就用 `crypto.randomUUID()` 兜底，再回写 `identity.json.uuid`、`hardware.hardware_uuid`、以及 `-uuid` 参数和 `-smbios type=1,uuid=`（`[O]kvm-fingerprint-uuid.mjs:65-146`）。
- 我们是**派生**：`deriveUuid(vmId, salt)` 固定生成 v4 形态（`[R]src/persona/derive.mjs:29-35`），校验用严格小写正则（`[R]src/persona/kvm-spec.mjs:346-350`），非法值直接 **throw**（`[R]src/persona/kvm-spec.mjs:505-512`）。
- 差异三条：
  1. 没有 `coerceRfc4122Uuid` 等价物（随机兜底 + `toLowerCase()`），见 `[O]rfc4122-uuid.mjs:12-17`。
  2. 没有"读回已存在的 `qemu-smbios.args` 并就地修补"的能力 —— 一旦某个 persona 的 `product_uuid` 为空，我们的路径是**失败**（fleet 建不出来），官方路径是**修好继续**。
  3. 官方校验正则带 `/i` 且显式拒绝 `'-'`（`[O]rfc4122-uuid.mjs:4-10`），我们 `isSmbiosUuid` **不带 `/i`**（`[R]src/persona/kvm-spec.mjs:348`），大写 UUID 会被判非法。这与"QEMU 严格"的注释一致，但比官方紧。
- 结论：能力等价度约 60%，缺的是"修补"这半条。

### ④ `workstation-fingerprint.mjs`：我们完全没做吗？

**不是"完全没做"，但字段集只覆盖了一半。**

- 我们有的：`hostname` / `machine_id`(32hex) / `mac` / `uuid` 全部按 `vmId` 确定性派生（`[R]src/persona/derive.mjs:20-40`），并在 persona 里落成 `/etc/hostname`、`/etc/machine-id`、`/var/lib/dbus/machine-id`（`[R]src/persona/linux.mjs:368-373`），还有跨槽唯一性检查（`[R]src/persona/fleet-plan.mjs:205` `FLEET_UNIQUE_FIELDS`）。
- 我们缺的（官方 `[O]workstation-fingerprint.mjs:70-82` 的返回对象逐字段比）：
  | 字段 | 官方 | 我们 |
  |---|---|---|
  | `hostname` | `${family}-${hex(2)}`（`[O]:62`） | 云厂商模板（`ip-10-0-1-23` 等，`[R]src/persona/linux.mjs:86`）→ 形态不同但各自合理 |
  | `guest_machine_id` | 32hex（`[O]:64`） | ✅ 有（`[R]src/persona/linux.mjs:148-150`） |
  | `device_id` | **64hex**（`[O]:63`） | ❌ 不在 fingerprint 里；`device_id` 只存在于 `[R]src/persona/claude-home.mjs:62`（= userID，64hex） |
  | `session_id` | `crypto.randomUUID()` 并持久化（`[O]:74`） | ❌ 无持久化 session_id（全仓 grep，`persona/*` 里没有 `session_id`） |
  | `sku` | `2c4g`/`4c8g`（`[O]:75`） | ❌ |
  | `linux_kernel` | 目录取样（`[O]:76`） | ❌ 只有静态 `kernel_release`（`[R]src/persona/linux.mjs:37`） |
  | `timezone` / `locale` | 有（`[O]:77-78`） | ⚠️ timezone 由 `[R]src/persona/geo-timezone.mjs` 推导；locale 无 |
  | `source` / `generated_at` / `reset_at` | 有（`[O]:79-81`） | ❌ |
  | 冲突重试 | 16 次（`[O]:61-69`） | ⚠️ 只有事后统计，无重抽 |
- 还有一个语义差异：官方文件头明确 **"Official ~/.claude.json machineID still overwrites device_id after init"**（`[O]workstation-fingerprint.mjs:3`），我们没有任何东西能覆盖生成值（见第 6 节）。

### ⑤ `crs-headers.mjs`：这些是什么头？我们有吗？

官方这组头是"官方 CLI 在每个 Messages / count_tokens 请求上都会带的头"，分成三类（`[O]crs-headers.mjs:23-93`）：

| 类别 | 头 | 我们有吗 |
|---|---|---|
| 协议 | `anthropic-version`、`anthropic-beta`、`anthropic-dangerous-direct-browser-access` | 前两个有（`[R]src/anthropic.mjs:192-197`），**第三个缺失** |
| 设备/Stainless | `user-agent`、`x-app`、`x-stainless-{lang,os,arch,runtime,runtime-version,package-version,retry-count,timeout}`、`x-stainless-helper-method` | 全部有（`[R]src/identity.mjs:58-70`，值逐字符一致），`helper-method` 无（条件头，可缺） |
| CLI 会话 | `x-claude-code-session-id`、`x-claude-code-request-class`、`x-claude-code-agent-type`、`x-claude-code-prev-tool-durations`、`x-claude-code-compaction`、`x-claude-code-context-compacted`、`accept-language`、`sec-fetch-mode` | **全部缺失**（`x-claude-code-session-id` 只出现在遥测发送器 `[R]src/telemetry/sender.mjs:40`，不在 Messages 出站路径） |

另外官方还有一层能力我们完全没有：**协议头的落盘与回放**（`kin-cc-headers.json`，`[O]crs-headers.mjs:164-233`）。官方只持久化 `anthropic-version` / `anthropic-beta` / `anthropic-dangerous-direct-browser-access` 三个协议头，设备头永不落盘、永不来自入站。我们没有这个存储层。

---

## 逐文件对比

### 1. `xxh64.mjs`

- **官方职责**：XXH64 实现（大端常量、小端读取、无符号 64 位），给 cch 用。
- **我们的对应**：`src/cch.mjs:46-101`（同一实现，内联并 `export`，未单独成文件）。
- **差异**：逐行同构（MASK / 五个 PRIME / rotl / round / mergeRound / 32 字节主循环 / 尾部 8-4-1 处理 / 最终混淆）。唯一差别是官方把 `asBuffer` 放在文件级而我们把同样的三分支写在 `[R]src/cch.mjs:39-44`。
- **风险**：无关（已对齐）。
- **建议**：无需动作。

### 2. `cch.mjs`

- **官方职责**：算/封 Claude Code 的 `cch`（对投影后 body 字节做 XXH64，取低 20 bit，5 位小写 hex）；关键是 1.3.220 的修复——**只归一第一个 billing block**，历史回显里的 billing 文本一律不动。
- **我们的对应**：`src/cch.mjs`（整文件，415 行）。
- **差异**：
  - 常量一致：`CCH_PLACEHOLDER='00000'`、`CCH_XXH64_SEED=0x4d659218e32a3268n`（`[R]:24-25` = `[O]:12-13`）。
  - 1.3.220 修复已落地：`mapSystemText` 的 `firstBilling` 只在**第一个** billing block 上生效（`[R]:345-380` = `[O]:135-162`），`normalizeBillingCch` 的正则**不带 `g`/`m`**（`[R]:324-341`，注释直接写明"带 g 会把每一行都归一，历史回显会被改坏"）。
  - `SYSTEM_BILLING_CCH` 只匹配一次、`.test()` 前重建带 `m` 不带 `g` 的正则（`[R]:315-319,401-409` = `[O]:164-167,177-180`）——同一个 `lastIndex` 陷阱，两边都用同样办法绕开。
  - **唯一差异**：官方多导出一个 `projectClaudeCodeCchText(raw)`（`[O]:98-107`，给"必须存在 billing"的调用方用，找不到就抛 `billing cch not found`），我们没有对应导出。
- **实测差分**（本次跑的，4 个用例全部 SAME）：单 billing、多块 system + 历史回显、字符串 system + `fallbacks`/`fallback_credit_token`、非首块 billing。
- **风险**：性能/成本（缺一个便捷导出不影响出站）。
- **建议**：若要 100% 对齐 API 面，补一个 `projectClaudeCodeCchText`；行为层面不用动。

### 3. `official-claude-ua.mjs`

- **官方职责**：官方 UA 的**识别**——`^claude-cli/\d+\.\d+\.\d+`（任意 semver，不 pin 版本），外加"家族形似但 semver 前缀不合法"的残留判定。
- **我们的对应**：生成有（`src/identity.mjs:49-52`、`src/prompt-profiles.mjs:160-163`）；**识别缺失**。
- **差异**：
  - UA 串本身逐字符一致（实测 `claude-cli/2.1.296 (external, sdk-cli)`）。
  - 官方把 UA 当门禁的第一关（`[O]claude-code-only.mjs:38`、`[O]crs-headers.mjs:283`），我们没有这层门禁；替代物 `looksLikeOfficialCaller()` 只看 system（`[R]src/prompt-profiles.mjs:456-459`）。
  - 官方 `isUnofficialClaudeEntrypointUa` 用 `claude-desktop|agent-sdk|claude-vscode|local-agent` 做"形似但非官方"的标记（`[O]:23-27`），我们没有任何等价判定。
- **风险**：功能缺失（缺识别的后果见第 15 节：官方调用方可能被判成非官方，或反之）。
- **建议**：补 `isOfficialClaudeUa()` 与一个"入口点是否官方"的判定，接到 `looksLikeOfficialCaller` 之外作为第二门。这条本身不改出站字节，属于低风险高收益。

### 4. `rfc4122-uuid.mjs`

- **官方职责**：UUID 形态校验（任意 version/variant、大小写不敏感、拒绝空与 `'-'`）+ 非法值兜底成随机 UUID（`coerceRfc4122Uuid`）。注释点明用途：「Never pass empty, `-`, or malformed values to QEMU `-uuid`」。
- **我们的对应**：`src/persona/kvm-spec.mjs:346-350`（`isSmbiosUuid`，严格小写无 `/i`）、`src/system-layout.mjs:64`（`UUID_RE`，带 `/i`）。
- **差异**：
  1. **无 `coerceRfc4122Uuid`**：我们只有"校验失败就 throw"（`[R]src/persona/kvm-spec.mjs:509-511`），没有"兜底一个随机合法值"。
  2. `isSmbiosUuid` 不带 `/i`，比官方 `isRfc4122Uuid` 紧；且不特判 `'-'`。
  3. 官方 `coerce` 会 `toLowerCase()` 后返回；我们没有归一化函数。
- **风险**：功能缺失（低）。
- **建议**：把 `isRfc4122Uuid` + `coerceRfc4122Uuid` 抽到独立模块，`kvm-spec` 的强校验保留、但在"读回已有文件"的场景用 coerce（配合第 5 节）。

### 5. `kvm-fingerprint-uuid.mjs`

- **官方职责**：KVM 槽位的 DMI UUID 修补器——从 `vms/<id>/kvm/fingerprint/{identity.json,qemu-smbios.args}` 读回已有值，非法/空则兜底，并**把 `-uuid` 参数与 `-smbios type=1,uuid=` 两处同时写回**。
- **我们的对应**：`src/persona/kvm-spec.mjs`（生成 + 校验，`497-512`），无修补器。
- **差异**：
  - 官方有 `splitSmbios` / `joinSmbios`（逗号转义，`[O]:6-28`）、`uuidFromQemuSmbiosArgs`（`[O]:30-47`）、`setType1Uuid`（`[O]:49-63`）、`patchQemuSmbiosArgsUuid`（`[O]:65-108`）、`repairKvmFingerprintUuid`（`[O]:114-146`）五段。我们一段都没有。
  - 我们的 `escapeSmbiosValue` 处理逗号（`[R]src/persona/kvm-spec.mjs:336-345`），等价于官方的 `splitSmbios` 转义规则，但只在"生成"方向。
  - 官方修补同时改 `identity.json.uuid` 与 `identity.json.hardware.hardware_uuid`，并要求两者一致（`[O]:127-138`）；我们没有"两处同一值"的约束检查。
- **风险**：功能缺失（中：会导致"空 UUID 的槽直接建不出来"，而不是"修好后继续"）。
- **建议**：在 persona 落盘之后加一个 `repairKvmFingerprintUuid(dir)` 等价步骤；这是纯增量，不动现有生成逻辑。

### 6. `official-fingerprint.mjs`

- **官方职责**：把**官方 CLI 自己写出来的身份**收敛进槽记录——读 `~/.claude.json` / `~/.claude/.claude.json` 的 `userID` / `machineID` / `oauthAccount`，把 `machineID` 写成 `fingerprint.device_id` 与 `official_machine_id`，旧值降级成 `guest_machine_id`，清掉 `machineID`/`userID`/`machineId`/`userId` 四个 stale 键，并回写 `kin-identity.json`。
- **我们的对应**：`缺失`。`src/persona/claude-home.mjs` 是**单向生成**：`claudeHomeForSlot()` 从 `vmId` 派生 userID/machineID 并写 `~/.claude.json`（`[R]:51-72,150-169`），从不读回。
- **差异**：
  - 无 `readOfficialCcIdentity`（`[O]:24-38`）、无 `reconcileFingerprint`（`[O]:40-58`）、无 `applyOfficialFingerprintToVm`（`[O]:80-134`）。
  - 官方有 `STALE_FP_KEYS` 清理（`[O]:8`），我们没有；`~/.claude.json` 里的旧 `machineID` 会一直留在磁盘上。
  - 官方 `discardLeftoverClaudeJson` 检测 canonical 与嵌套两份文件的冲突（`[O]:60-78`），我们没有。
- **风险**：功能缺失（中）。语义上官方是"**官方身份优先**，槽位生成值让位"；我们是"生成值唯一"。一旦槽内 CLI 重新初始化（升级、用户手动登录），磁盘身份会与我们发出去的不一致 —— 这正是官方注释里"replaced_device"要处理的情形。
- **建议**：补一个 reconcile 步骤（读回 + 覆盖 `fingerprint.device_id` + 清 stale 键），并在 `claude-home` 落盘前调用。

### 7. `workstation-fingerprint.mjs`

- **官方职责**：给一个槽生成工作站指纹（hostname / guest_machine_id / device_id / session_id / sku / linux_kernel / timezone / locale + source/timestamps），带跨槽冲突重试；另外提供 guest `machine-id` 文件的写盘与校验。
- **我们的对应**：部分 —— `src/persona/derive.mjs:20-82`（确定性派生）、`src/persona/linux.mjs:148-150,166-197`（machine-id 与 hostname 校验）、`src/persona/fleet-plan.mjs:205,329,347-365`（跨槽唯一性统计）。逐字段差异见上文 ④ 的表。
- **差异**（要点）：
  1. **无 `device_id`**（64hex）这个 fingerprint 字段；`device_id` 只存在于 `claude-home.mjs:62` 的返回值里，没进 fingerprint。
  2. **无持久化 `session_id`**：官方把它写进指纹并在 `vm-identity.mjs:80` 用作 metadata session 的缺省值；我们每次只能新造。
  3. **无 SKU / locale / source / generated_at / reset_at**。
  4. 冲突处理：官方 16 次重抽后抛错（`[O]:61-69`），我们只统计不重抽（`[R]src/persona/fleet-plan.mjs:347-390`）。
  5. `machine-id` 写盘：官方强制 `^[0-9a-f]{32}$`、先删目录再写、`mode 0o644`（`[O]:106-120`）；我们写进 persona 树（`[R]src/persona/linux.mjs:368-369`），路径不同但字节形态一致。
- **风险**：功能缺失（中）。`session_id` 缺失与第 11 节联动：没有持久 session，就无法让 `x-claude-code-session-id` 与 `metadata.user_id.session_id` 稳定一致。
- **建议**：给 fingerprint 增加 `device_id` / `session_id` / `locale` 三个字段（其余 SKU 类是 workstation-profile 的事）。

### 8. `workstation-profile.mjs`

- **官方职责**：Linux 准系统画像——2c4g/4c8g 两档 SKU（含 rss/heap/arrayBuffers 区间）、按发行版分组的 kernel 候选目录、package manager、terminal/shell、`isHostKernel()` 过滤，以及 `kin-seed.json`（`kin-seed/2` schema）。
- **我们的对应**：`缺失`。我们的 Linux 画像按机型写死（`src/persona/linux.mjs:26-80` 的 DEFAULTS），kernel 是单一常量（`[R]:37`），没有 SKU 概念、没有 kernel 目录、没有 seed 文件。
- **差异**：
  - 官方的核心约束是"**宿主 kernel / docker hostname / cgroup 限制永不出站**"（`[O]:1-5`）并靠 `HOST_KERNEL_RE = /^(7\.0\.0-\d+-generic|.*\bhost\b)/i` 拦（`[O]:60,94-96`）。我们没有这个过滤器；我们靠"persona 里写的值就是客户机看到的"（`[R]src/persona/kvm-spec.mjs:9-14`）来保证一致性 —— 架构不同，但**没有显式的宿主泄漏拦截**这一点是能力缺口。
  - 官方 SKU 的 `process` 区间（`[O]:10-37`）我们完全没有；`rss_range` 之类只在遥测里有近似值（`[R]src/telemetry/events.mjs:154-188`）。
  - `kin-seed.json` 无对应物。
- **风险**：功能缺失（低-中）。我们不走"cgroup 内伪造"那条路（KVM 里客户机是真内核），所以 SKU 语义本就不适用；但 `isHostKernel` 这类"宿主泄漏"防线值得借鉴。
- **建议**：明确记录"架构不同 → SKU 不需要"；只补 `isHostKernel` 等价过滤（对 `fingerprint.kernel_release` 出站前做一次校验）。

### 9. `slot-computer.mjs`

- **官方职责**：`kin-computer` 二进制的 JS 侧契约——读 `vms/<id>/kvm/fingerprint/`（KVM）或 `system/{etc/hostname,etc/machine-id,hardware/mac,dmi}`（容器）里的计算机身份，做完整性校验（hostname 正则 / machine-id 32hex / RFC4122 UUID / MAC 格式 / smbios 非空），不完整就先修 UUID、再没有就调二进制创建，失败则清目录。
- **我们的对应**：`缺失`这条契约。我们有 `src/persona/kvm-lifecycle.mjs`（VM 生命周期 / QMP / 磁盘，`421-430,635-708`）与 `src/persona/kvm-verify.mjs`，但**没有**"读 `identity.json` + `qemu-smbios.args` 并做完整性判定"这一层。
- **差异**：
  - 官方 `linuxComputer()` 要求 `identity.json` 与 `qemu-smbios.args` 同时存在且后者的 `size > 0`（`[O]:34-56`）；我们没有这个"文件对"契约。
  - 官方 `containerComputer()` 要求 4 个路径 + `dmi` 是目录（`[O]:58-80`）；我们是"生成整棵 persona 树"，没有读回校验。
  - MAC 正则（`^([0-9a-f]{2}:){5}[0-9a-f]{2}$`，`[O]:17`）我们有更强的单播判定（`[R]src/persona/kvm-spec.mjs:352-360`），这一点我们更严。
- **风险**：功能缺失（低）。我们是"生成方"，官方是"生成方 + 校验方"；在 KVM 场景下缺的是"槽已存在时不要重抽"的保证。
- **建议**：补一个 `identity.json` + `qemu-smbios.args` 的读回校验（只读、幂等），配合第 5 节的修补器一起做。

### 10. `vm-identity.mjs`

- **官方职责**：槽位身份的唯一装配点——CLI 版本常量、UA 模板、stainless 常量、`metadata.user_id` 三键格式、deviceId 归一（64hex 直出、否则 sha256）、settings.json 的 env 组装、指纹持久化。
- **我们的对应**：拆在三处 —— `src/identity.mjs:20-70`（stainless + UA）、`src/frames.mjs:652-711`（deviceId 归一 + metadata 三键）、`src/persona/claude-home.mjs:108-119`（settings.json）。
- **差异**：
  - **已对齐**：`outboundDeviceId`（`[R]src/frames.mjs:652-657` = `[O]:57-62`，64hex 直出否则 sha256，fallback `'kin-vm'`）；`formatMetadataUserId`（`[R]src/frames.mjs:672-682` = `[O]:39-48`，恰好三键，且我们**额外**做了 `@` 拒绝，`[R]:673-676`，官方把这条约束写在注释里）。
  - **settings.json 的 env 缺一大截**：官方 `buildSlotSettingsEnv` 写 `TZ` / `LANG`+`LC_ALL` / `DO_NOT_TRACK` / **`CLAUDE_CODE_GATEWAY_HINT_HEADERS='1'`** / `CLAUDE_CODE_ATTRIBUTION_HEADER='0'`（`[O]src/lib/protocol/seed-policy.mjs:101-119`）；我们只有 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'`（`[R]src/persona/claude-home.mjs:113-116`）。
    其中 `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` 是 2.1.283+ 发 `x-claude-code-prompt-id` 头的开关（官方源码注释原文）——**少了它，槽内 CLI 不会发那个头**。
  - 官方 `OFFICIAL_CLI_VERSION` 是常量（`[O]:23`）；我们可由环境变量覆盖（`[R]src/identity.mjs:45-47`）。
  - 官方把 `cliVersion` 写回 `vm.claude_code_version`（`[O]:204-212`），我们没有这个字段。
- **风险**：封号风险（中）。settings env 缺项是"能直接观察到"的差异（`x-claude-code-prompt-id` 缺失、TZ/LANG 缺失）。
- **建议**：补齐 settings env 的 6 个键；把 `CLAUDE_CODE_VERSION` 的覆盖收窄成"仅调试构建"。

### 11. `identity-rewrite.mjs`

- **官方职责**：出站身份重写 —— `device_id`→槽位、`account_uuid`→真实 OAuth 账号、`session_id` 按 rebuild/passthrough 两模式重建（sticky 复用、UA 归一、首条 user 文本做稳定种子、子 agent 单独 session）、`metadata` 里所有含 user/machine/device/host/tz/timezone/locale/setting/session_source/email 的键**全部清掉**，顶层 `settings`/`claude_settings`/`env`/`user`/`user_id` 直接删。
- **我们的对应**：部分 —— `src/frames.mjs:652-711`（deviceId + 三键格式）。
- **差异**（这是本次最重的一条）：
  1. **字符串形态的 `user_id` 原样透传**（`[R]src/frames.mjs:694-697`）：
     ```js
     const existing = request?.metadata?.user_id
     if (typeof existing === 'string') {
       // 调用方已给字符串，原样透传
       return { user_id: existing }
     }
     ```
     官方是**无条件重写**：`md.user_id = formatMetadataUserId({ deviceId, accountUuid, sessionId })`（`[O]:464-468`），并且在此之前把所有敏感键过滤掉（`[O]:457-463`）。官方文件头写得很直白：「Client settings/env/identity fields are always dropped」（`[O]:18`）。
     后果：调用方（第三方客户端、或多账号共用同一 device_id 的转发方）的 `device_id` / `account_uuid` 会直接成为出站身份 —— 这正是"一批账号报同一台设备"的最短路径。若调用方字符串里带 `@`，我们连第 10 节那个 `@` 拒绝都绕过了（校验只作用于我们**自己构造**的字符串）。
  2. **顶层身份字段不删**：官方删 `settings` / `claude_settings` / `env` / `user` / `user_id`（`[O]:427-431`），我们只删 `betas` / `__betas__`（`[R]src/anthropic.mjs:232-240`）。
  3. **session 派生整层缺失**：`normalizeSessionUserAgent` / `sessionContextDiscriminator` / `buildStableSessionSeed` / `uuidFromSeed` / `agentSessionId` / `rebuildOutboundSession` / `resolveOutboundSessionId` / `outboundSessionMode` 全部无对应物。我们只有 `extractSessionId`（`[R]src/server.mjs:816-829`，**读**调用方 session 用于调度），没有**改写**。
  4. 官方 `CALLER_SESSION_HEADER_KEYS`（`x-session-id`/`x-conversation-id`/`x-claude-code-session-id`/`session-id`/`thread-id`）与 `CALLER_SESSION_BODY_KEYS` 我们都没有。
- **风险**：**封号风险（高）**。
- **建议**：P0。至少做到"字符串形态也要 parse → 重建 → 重新序列化"，并把 `metadata` 的敏感键过滤、顶层 `settings`/`env` 清理补上。session 派生可以分期：先做"官方 UA 透传 caller session、非官方 uuidFromSeed(caller)"这一支。

### 12. `crs-headers.mjs`

- **官方职责**：官方 CLI 头集合的解析/存储/回放/剥离，外加 `context-1m` beta 的策略。核心思想（`[O]:8-13`）：**设备头永不落盘、永不来自入站**，只由 VM 指纹 + 默认值产生；协议头才落盘。
- **我们的对应**：部分 —— `src/identity.mjs:20-27,58-70`（stainless 常量）、`src/anthropic.mjs:178-205`（头组装）。
- **差异**：
  1. **缺 3 个官方默认头**：`anthropic-dangerous-direct-browser-access: 'true'`（`[O]:92`）、`x-claude-code-session-id`（`[O]:275`）、`accept-language`（`[O]:276`，由 locale 派生 `en-US` 形态，`[O]:158-162`）。`sec-fetch-mode` 也在 KEEP 列表里（`[O]:45`），但只在入站有值时才透传。
  2. **缺条件头**：`x-claude-code-request-class` / `agent-type` / `prev-tool-durations` / `compaction` / `context-compacted`（`[O]:72-78`）。
  3. **缺协议头存储**：`kin-cc-headers.json` 的 `PROTOCOL_STORE` 三键读写与"设备头残留自动清洗"（`[O]:198-233`）。
  4. **缺 `context-1m` 策略**：`stripBetaTokens` / `shouldStripContext1m` / `REPLAY_DROP_BETAS`（`[O]:95-123`）。我们的 `betas.mjs` 根本没有 `context-1m-2025-08-07` 常量（grep 无），所以既不会注入也不会剥离 —— 从"不会误注入"角度看是安全的，但少了"官方客户端明确要求 1M 时透传"的能力。
  5. **已对齐**：六个 stainless 值 + `retry-count=0` + `timeout=600`（`[R]src/identity.mjs:20-27,58-70` 与 `[O]:25-32,80-93` 逐值一致）；`x-app: 'cli'`（`[R]src/identity.mjs:54-56` 默认分支）。
  6. **一处我们多出来的分支**：`claudeCodeAppHeader()` 在 `CLAUDE_CODE_SESSION_KIND === 'bg'` 时返回 `'cli-bg'`（`[R]src/identity.mjs:55`）。官方只有 `cli`。如果后台会话真的跑起来，`x-app` 会变成官方不认识的 `cli-bg` —— 而官方 `hasClaudeCodeClientHeaders` 严格要求 `x-app === 'cli'`（`[O]claude-code-only.mjs:39`）。
- **风险**：**封号风险（高）**（缺 session 头 + 缺 3 个默认头 + `cli-bg` 分支）。
- **建议**：P0 补三个默认头与 session 头；P1 把 `cli-bg` 分支删掉或限制在非出站路径；P2 补协议头存储与 1M 策略。

### 13. `claude-code-only.mjs`

- **官方职责**：`routing.compatibility.claude_code_only` 的准入判定——只有官方 Claude Code 族（六门联判）才能打 Anthropic 平台模型；含 CLI 配额探针（`max_tokens:1` + 单条 `quota`）的特别放行。
- **我们的对应**：无（`缺失`）。
- **差异**：我们不做"按调用方客户端类型拒绝请求"这件事；`server.mjs` 的请求路径里没有这类 403。
- **风险**：**无关**。
  理由：这个文件解决的是「**网关作为服务提供方**，如何只让官方客户端用自己的池」——它是**入站准入**策略，服务于配额/滥用控制。我们的架构是"内核伪装成官方客户端向上游发"，入站是谁由控制面（Go 层 / 面板）决定，我们这一层没有"分组"概念，也没有可依据的 `routing.compatibility`。把这条判成"缺失"会误导：它不会让上游识别出我们。
  但它有两处**可复用的知识**值得单独拿走，已分别记在别处：
  - 第 31-48 行的"官方请求头集合" → 见第 12 节；
  - 第 60-68 行「billing 的 `cc_version` 必须与 UA 的 semver 一致」 → 这正是第 5 条封号风险（我们 UA 与 billing 版本会打架）的权威依据。
- **建议**：不实现该策略；把 60-68 行的"版本一致性"作为出站前的自检断言。

### 14. `official-cc-system-2.1.241.mjs`（+ `official-cc-system-2.1.241.json`）

- **官方职责**：官方 2.1.241 的 system 文本资产与改写助手——`identity`（62 字符身份句）、`agent_prompt`（10573 字符，`# System`/`# Doing tasks`/`# Executing actions with care`/`# Using your tools`/`# Tone and style`）、`continuation`（15300 字符，`# Text output`/`# Session-specific guidance`/`# auto memory`…）、2.1.296 的 `# Reporting outcomes`（独立块）、KIN 自写短 agent 段 `CRS_AGENT_EXPANSION`、Environment 清洗与生成（`sanitizeInboundCwd` / `parseInboundEnvFacts` / `applySlotTimezone` / `buildOfficialEnvironmentSection` / `buildOfficialContinuationText` / `officialProjectSlug`）、模型显示名表。
- **我们的对应**：`src/prompt-profiles.mjs`（303 抓包 + 渲染）、`src/prompt-profiles-303.json`、`src/system-layout.mjs`（身份句）。
- **差异**（逐项）：
  1. **提示词版本不同（非自编，见前文 ①）**：我们 2.1.303（5856 字符，章节 `# Harness`/`# Session-specific guidance`/`# Memory`/`# Environment`/`# Context management`），官方 2.1.241（agent_prompt 10573 + continuation 15300）。**结构不可比**，但也就无法证明"逐字节等于官方 2.1.303"。
  2. **缺 `# Reporting outcomes` 段**：官方 `CRS_REPORTING_OUTCOMES`（`[O]:20-22`）是 2.1.296 的 `DXt`，注释明确"必须是自己的 system block，cli-node 的 `mpo` 才会把它提出来"。我们 303 主提示词里不含这段（实测 `includes('# Reporting outcomes') === false`），也没有独立块。
  3. **缺 `CRS_AGENT_EXPANSION`**：官方 rewrite 模式的第 3 块就是它（`[O]:25-35`，注释写"结构对齐 2.1.241 第 3 块，措辞原创"）。我们没有这一块（见第 15 节）。
  4. **Environment 生成策略不同**：官方优先**保留调用方 Environment 段**只改 `Timezone`（`buildOfficialEnvironmentSection`，`[O]:291-304`），否则按 facts 重建，最差才写 `# Environment\n - Timezone: X`；我们是六项重建（`[R]src/prompt-profiles.mjs:347-367`：cwd/git/platform/shell/osVersion + `OFFICIAL_303_ENV_UNTRUSTED` + modelLine）。官方 fallback 时区是 `UTC`（`[O]:204`），我们是 `America/New_York`（`[R]src/system-layout.mjs:35`）。
  5. **memory 目录替换：已对齐**。官方 `buildOfficialContinuationText` 把 `/home/kincli/.claude/projects/-home-kincli/memory/` 按 cwd+slug 替换（`[O]:306-320`）；我们用 `{{memory_dir}}` 占位 + `renderMainPrompt303`（`[R]src/prompt-profiles.mjs:313-320`），效果等价。
  6. **`officialProjectSlug`：逐字符一致**（`[R]src/prompt-profiles.mjs:304-313` = `[O]:79-89`）。已对齐。
  7. 官方 `sanitizeInboundCwd` 有 512 字符上限、控制字符拒绝、`'…'` 去引号、路径前缀白名单（`[O]:56-65`）；我们的 cwd 清洗在 `parseEnvironmentFacts`（`[R]src/prompt-profiles.mjs:371-386`），**没有长度上限与控制字符拒绝**。
  8. `<total_tokens>` 抹平：我们有显式实现（`[R]src/prompt-profiles.mjs:79-84` `stabilizeTotalTokens`），官方 fixture 里是常量 `15000000`（`[O]:47`）。等价（甚至更强）。
- **风险**：**封号风险（中）** + 功能缺失。
  理由：缺 `# Reporting outcomes` 与 agent 段属于"形态缺块"；Environment 策略与时区默认值属于"可观察差异"；但都不像 billing/UA 那样是强指纹。
- **建议**：P1 补 `# Reporting outcomes` 独立块（2.1.296+ 才有，版本要对齐）；P2 cwd 清洗补长度/控制字符限制；默认时区改 `UTC` 或要求必填。

### 15. `crs-persona.mjs`

- **官方职责**：unofficial OAuth 出站 persona 的总装 —— 5 种模式（rewrite / official_prompt / overwrite / zero / append / none）、billing 文本构造、4 块组装、official 流量四门识别、泄漏指纹剥离（`claude-desktop|agent-sdk|cc_entrypoint=`）、oh-my-pi / OpenAI 工具形状拒绝、预算提醒折叠、standing constraint 停放、模板变量。
- **我们的对应**：部分 —— `src/system-layout.mjs:24`（身份句常量）、`src/prompt-profiles.mjs:456-459`（`looksLikeOfficialCaller`）、`src/prompt-profiles.mjs:669-713`（`assembleSystemBlocks`）。
- **差异**：
  0. **实测缺陷两条**（见 §0.5）：默认档 billing 缺指纹尾缀、默认档丢弃调用方 system。这两条都在 `server.mjs` 的布局二次生成里，属于本文件（4 块组装）与 `system-layout` 的交界。
  1. **billing 字段集不同**（已在摘要第 4 条）：官方 `cc_version=<ver>.<fp>; cc_entrypoint=sdk-cli; cch=00000; cc_prompt_id=<uuid>;<tail>`（`[O]:366-380`），其中 `<tail>` = ` cc_turn_origin=sdk; cc_prompt_index=0; cc_turn_index=1;`（`[O]:311-316`）；我们 `…; cch=00000; cc_prompt_id=<uuid>; prompt_version=<ver>`（`[R]src/system-layout.mjs:115`）。
     - `prompt_version=` 官方**只在 zero 模式**写，且值是身份句（`prompt_version=<You are Anthropic Claude Agent SDK.>`，`[O]:733-738`）；我们无条件写，值是版本号。
     - `cc_turn_origin` / `cc_prompt_index` / `cc_turn_index` 三个字段我们完全没有。
  2. **4 块结构**：官方 rewrite = billing + identity + **agent 块** + timezone env（`[O]:880-905`）；我们 `identity` 布局 = billing + IDENTITY + **`# Environment`** + leftover（`[R]src/system-layout.mjs:197-208`）——**缺 agent 块**，env 位置也不同（我们第 3 块、官方第 4 块）。
  3. **模式集**：官方 6 种（`[O]:87`）；我们只有布局 `zero/identity/stock`（`[R]src/system-layout.mjs:130-138`）与档位 `official_full/official_303`（`[R]src/prompt-profiles.mjs:97-133`）。无 `official_prompt` / `overwrite` / `append` / `park`。
  4. **official 流量识别**：官方是四门（`isOfficialClaudeCodeTraffic`：UA + system + user_id + `claude-code-20250219` beta，`[O]:1517-1542`）；我们只有 system 一门（`[R]src/prompt-profiles.mjs:456-459`）。
  5. **泄漏剥离缺失**：官方 `LEAKY_CLIENT_FINGERPRINT_RE = /claude-desktop|agent-sdk|claude agent sdk|claude-vscode|cc_entrypoint\s*=/i`（`[O]:442`）+ `stripLeakyClientText`（`[O]:451-465`）会把这些串从**调用方** system/messages 里剥掉；我们没有任何等价物（全仓 grep `claude-desktop`/`agent-sdk` 无命中）。
  6. **拒绝器缺失**：`looksLikeOhMyPiSystem`、`inboundHasOpenAIToolShape`（`[O]:101` 引用）我们没有。
  7. **预算提醒折叠缺失**：`BUDGET_REMINDER_RE` + `collapseRepeatedBudgetReminders`（`[O]:525-590`）我们没有。
  8. **standing constraint 停放缺失**：`parkableSystemTexts` / `PERSONA_PARK_STYLES`（`[O]:591-607`）我们没有（全仓 grep `park` 无命中）。
  9. **`mergeIdentityIntoBilling` 缺失**（`[O]:646-659`）：官方能把独立身份块折进 billing 行尾；我们不能。
  10. **`refreshOfficialSystemEnvironment` 缺失**（`[O]:931-946`）：选到 VM 后只改 Environment 的 Timezone。我们没有这个"二次修订"步骤。
  11. **已对齐**：身份句 `You are a Claude agent, built on Anthropic's Claude Agent SDK.`（`[R]src/system-layout.mjs:24` = `[O]` fixture `identity`，逐字符一致）；`BILLING_FINGERPRINT_SALT = '59cf53e54c78'` 与 `[4,7,20]` 字节取法（`[R]src/system-layout.mjs:41-49,53-63` = `[O]:95,278-288`）。
  12. 官方 `billingPromptId` 的兜底种子是 `uuidFromSeed(raw || 'prompt:'+ver+':'+fp)`（`[O]:294-300`）；我们用自己的 `'billing-prompt-id:'` 前缀 + sha256（`[R]src/system-layout.mjs:86-96`）。两者都产出合法 v4；**只要同一会话稳定**就等价（我们已满足）。
- **风险**：**封号风险（中）**（billing 字段集、缺 agent 块）+ 功能缺失（多数）。
- **建议**：P0 修 billing 字段集（删 `prompt_version`、按需补 `cc_turn_*`）；P1 补 agent 块与 leaky 剥离；P2 补 park / 预算折叠 / 二次 Environment 修订。

### 16. `crs-persona-usage.mjs`

- **官方职责**：给非官方客户端**遮掉** persona 注入带来的 token 增量，让客户端看到的 `input_tokens` / `cache_creation_input_tokens` 与"没注入 system"时一致；同时保留调用方自己的 prompt 与工具；zero 模式遮 billing + timezone 两块。
- **我们的对应**：`缺失`。全仓没有任何 usage 遮罩（grep `hidePersonaUsage` / `estimateClaudeInputTokens` 无命中）。我们对 usage 的处理只有透传与聚合（`src/sse.mjs` 的 `mergeUsage`）。
- **差异**：
  - 无 `estimateClaudeInputTokens`（`[O]:28-32`，`chars/3` 的估算）、无 `personaHideForUnofficial`（`[O]:344-365`）、无 `zeroCliLayoutHideTokens`（`[O]:377-384`）、无 `hidePersonaUsage(InEvent|InSseLine|OnMessage)`（`[O]:441-501`）。
  - 官方会按"上游 server tool schema 的真实成本"而不是我们贴上去的 `{type,name}` stub 计费（`[O]:8-9,216-265`）；我们连这一层概念都没有。
- **风险**：功能缺失（中）。我们 `identity` 布局固定注入 billing(~100 token) + 身份句 + Environment，增量小；但 `official_303` 档注入 5856 字符主提示词（≈1500+ token），调用方会在 usage 里直接看到这个差值 —— 对"内部一致性"是一种可观察信号（客户端问 1000 token 的事，账单说 2500）。
- **建议**：如果对外只暴露 `official_full` 档，可以先不做；一旦启用 303 档，补一个"按注入字节数扣减 input_tokens"的遮罩。

### 17. `persona-template.mjs`

- **官方职责**：JSONL persona / overlay 模板系统——模板存成结构化对象数组（控制台按 JSONL 编辑，无损往返），渲染时剥掉 meta 键（`id`/`note`/`drop_if_empty`/`hide`），只让 `type`/`text`/`cache_control` 出站；内置 `official`/`official_full`/`zero`/`custom` 四套预设；24 个占位符（`billing`/`identity`/`agent_official`/`env`/`cwd`/`session_id`…）+ overlay 模板。
- **我们的对应**：`缺失`。我们的 persona 是**硬编码档位**（`[R]src/prompt-profiles.mjs:97-133`），没有模板/占位符/自定义能力。
- **差异**：无模板解析（`parsePersonaTemplateLines`）、无渲染（`renderPersonaTemplate`/`renderOverlayTemplate`）、无预设表（`PERSONA_PRESETS`/`DEFAULT_PERSONA_TEMPLATES`）、无变量目录（`PERSONA_TEMPLATE_VARS`）、无长度上限常量（`BLOCK_MAX 40000`/`TOTAL_MAX 200000`/`BLOCKS_MAX 24`）。
- **风险**：功能缺失（低）。这是**运营可配置性**能力，不是出站指纹能力；我们没有"控制台按 JSONL 编辑 persona"的需求。
- **建议**：判为"架构不同，可不要"。若将来要支持自定义 persona，再按官方这套键名对齐（否则控制面配置与我们不兼容）。

### 18. `telemetry-env.mjs`

- **官方职责**：构造 2.1.296 的 1P env / event / GrowthBook 载荷。文件头明确：「**Betas, node_version, is_running_with_bun, model, and additional_metadata are not sent.**」（`[O]:2-5`）。`FULL_ENV_KEYS` 33 项，含 `shell`（`[O]:23-57,138`）。
- **我们的对应**：`src/telemetry/env.mjs`（395 行），`ENV_FIELD_ORDER` 35 项（`[R]:43-83`）。
- **差异**（实测，见"复现命令"）：
  - 我们**多出** 3 个：`node_version`（`[R]:45,276`）、`is_running_with_bun`（`[R]:49,280`，恒 `true`）、`github_actions_metadata`（`[R]:61,173,331`）。
  - 我们**缺少** 1 个：`shell`（官方 `telemetryShell()`，`[O]:84-94`，空值兜底 `'bash'`；我们在注释里明确写"没有 shell"，`[R]:38`）。
  - 值层面：官方 `is_claude_ai_auth = !!(id.account_uuid || id.is_claude_ai_auth)`（`[O]:148`）；我们同义（`[R]` 内同名字段）。
  - 官方 `buildProcessJson` 的 `cpuUsage`/`cpuPercent` 随机区间（`[O]:182-187`）我们也有（`[R]src/telemetry/events.mjs:154-188`）。
  - 官方 `GROWTHBOOK_CLIENT_KEY = 'sdk-zAZezfDKGoZuXXKe'`（`[O]:9`）我们没有；`telemetryCodeUa` 我们有等价（`[R]src/telemetry/sender.mjs:35` `claude-code/${ver}`）。
- **风险**：封号风险（中，**仅在开启上报时生效**；默认 `telemetry_enabled:false`，`[R]src/telemetry/index.mjs:55-59,79`）。官方这几句注释就是"哪些字段是识别特征"的权威清单，我们的实现正好踩在"多发 3 个官方不发的"+"少发 1 个官方必发的"。
- **建议**：与 `diff-telemetry.md` 合并处理；identity 层只需记住：**官方 env 有 `shell`、没有 `node_version`/`is_running_with_bun`**。

### 19. `telemetry-rewrite.mjs`

- **官方职责**：**拦截**客户端打到遥测路径的请求 → 命中就返回假 200（`metrics_enabled` 返回 `{metrics_logging_enabled:true}`，其余返回 `{}`）→ 不读 body、不转发；若真要转发则先改写身份字段（整体替换 env、重算 process、删 `betas`/`model`/`additional_metadata`/`baseUrl`）。
- **我们的对应**：方向相反 —— `src/telemetry/*` 是"**自己构造并发出**官方形态的遥测"（`createTelemetry`，`[R]src/telemetry/index.mjs:88-145`），**没有**"拦截客户端遥测并伪造 200"的能力；`server.mjs` 里没有 `event_logging` / `metrics_enabled` 路由（grep 无命中）。
- **差异**：
  - 无 `isTelemetryPath`（`[O]:10-20`）、无 `telemetryInterceptResponse`（`[O]:153-157`）、无 `rewriteEventBatch`/`rewriteGrowthbookEval`/`rewriteGenericIdentity`（`[O]:93-151`）。
  - 官方两层的分工（Node 假 200、Go sidecar 真发）见 `diff-telemetry.md` 的"先决事实"一节；我们的能力只覆盖了"自己发"这一半，而且这一半与官方 Go 层的字段口径也还没完全对齐。
- **风险**：功能缺失（中-高）。若槽内 CLI 的遥测没有被网络层挡住，宿主/容器真实环境会直接上报 —— 这正是 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（我们有，`[R]src/persona/claude-home.mjs:115`）想压住的那部分。需要与 `egress/` 层确认是否已有兜底。
- **建议**：确认 egress 是否拦截 `/api/event_logging/*`、`/api/eval/*`、`/api/claude_code/metrics*`；没有就必须补（否则这比 env 字段集合严重得多）。

---

## 附：复现命令（只读，不改任何源文件）

```bash
# 1) cch 差分（4 个用例应全部打印 SAME）
cd research
node --input-type=module -e "
import * as O from './vm2api/src/lib/identity/cch.mjs'
import * as R from './reimpl/src/cch.mjs'
const cases=[
 {model:'claude-sonnet-5',max_tokens:1024,system:[{type:'text',text:'x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoint=cli; cch=abcde; cc_prompt_id=x'}],messages:[{role:'user',content:'hi'}]},
 {model:'claude-opus-5',max_tokens:100,system:[{type:'text',text:'x-anthropic-billing-header: cc_version=2.1.296; cch=11111;'},{type:'text',text:'You are a Claude agent.'}],messages:[{role:'user',content:[{type:'text',text:'x-anthropic-billing-header: cch=22222; history echo'}]}]},
 {model:'claude-sonnet-5',max_tokens:512,system:'x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoint=cli; cc_prompt_id=abc',messages:[{role:'user',content:'q'}],fallbacks:['a'],fallback_credit_token:'t'},
 {model:'m',system:[{type:'text',text:'You are a Claude agent.'},{type:'text',text:'x-anthropic-billing-header: cch=33333; example'}],messages:[]}
]
for(const [i,b] of cases.entries()){
  const o=JSON.stringify(O.sealClaudeCodeCch(structuredClone(b)))
  const r=JSON.stringify(R.sealClaudeCodeCch(structuredClone(b)))
  console.log('case'+i, o===r?'SAME':'DIFF')
}"

# 2) billing 文本对照
cd research
node --input-type=module -e "
import * as O from './vm2api/src/lib/identity/crs-persona.mjs'
import * as R from './reimpl/src/system-layout.mjs'
const sid='3f2504e0-4f89-41d3-9a0c-0305e82c3301'
console.log('O:',O.buildBillingAttributionText('hello world','2.1.296',sid,{promptIndex:0,turnIndex:1}))
console.log('R:',R.buildBillingAttribution({cliVersion:'2.1.296',firstUserText:'hello world',sessionId:sid}))"

# 3) 遥测 env 字段集合差异（应打印：多 node_version,is_running_with_bun,github_actions_metadata / 少 shell）
cd research
node --input-type=module -e "
const e=await import('./vm2api/src/lib/identity/telemetry-env.mjs')
const r=await import('./reimpl/src/telemetry/env.mjs')
console.log('官方',e.FULL_ENV_KEYS.length,'我们',r.ENV_FIELD_ORDER.length)
console.log('多:',r.ENV_FIELD_ORDER.filter(k=>!e.FULL_ENV_KEYS.includes(k)).join(','))
console.log('少:',e.FULL_ENV_KEYS.filter(k=>!r.ENV_FIELD_ORDER.includes(k)).join(','))"

# 4) 303 提示词与官方 2.1.241 的重合度（应打印约 16.4%、最长 62 词逐字重合）
cd research
node -e "
const off=require('./vm2api/src/lib/identity/official-cc-system-2.1.241.json')
const ours=require('./reimpl/src/prompt-profiles-303.json')
const n=s=>s.replace(/\s+/g,' ').trim()
const O=n(off.agent_prompt+'\n'+off.continuation), U=n(ours.main_prompt)
const sh=(s,k=12)=>{const w=s.split(' '),set=new Set();for(let i=0;i+k<=w.length;i++)set.add(w.slice(i,i+k).join(' '));return set}
const so=sh(O), su=sh(U); let hit=0; for(const s of su) if(so.has(s)) hit++
console.log('12-gram 命中率',(hit/su.size*100).toFixed(1)+'%',hit+'/'+su.size)"

# 5) 默认档出站实测（应看到：cc_version 无 .fp、has caller text: false）
cd research
node --input-type=module -e "
const { prepareOutbound } = await import('./reimpl/src/server.mjs')
const body={model:'claude-opus-5-5',max_tokens:100,system:[{type:'text',text:'CALLER SYSTEM: answer in French.'}],messages:[{role:'user',content:'hi there friend'}]}
for (const prof of ['official_full','official_303']) {
  const out = prepareOutbound(structuredClone(body), {systemLayout:'identity', promptProfile:prof, panelTtl:'1h'})
  console.log('=== '+prof)
  console.log('system 块:', out.system?.map(b=>JSON.stringify(String(b.text??b).slice(0,60))))
  console.log('has caller text:', JSON.stringify(out).includes('answer in French'))
}"
```