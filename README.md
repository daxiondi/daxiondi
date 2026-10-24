# 自研复刻实现（可运行）

一个可运行的兼容内核：把 Claude Code CLI 与 OpenAI Codex 包装成 Anthropic / OpenAI 兼容的 HTTP API。

零外部依赖，只用 Node 内置模块。字段名、错误文案、帧格式、请求头全部按上游实际约定实现。

## 目录

```
research/reimpl/
├── src/
│   ├── config.mjs         WorkerConfig 27 字段 + 校验 + Envelope 8 字段 + health 骨架
│   ├── frames.mjs         stdin/stdout 帧协议（协议版本 2）+ CliHost 子进程驱动
│   ├── scheduler.mjs      20 槽调度、model 匹配、粘性会话、job 生命周期
│   ├── sse.mjs            Anthropic SSE 整流 + 私有 kin.done 尾帧 + trailer 元数据
│   ├── system-layout.mjs  system prompt 三布局（zero/identity/stock）+ billing header
│   ├── identity.mjs       指纹头、betas 白名单、cache TTL、错误映射
│   ├── cch.mjs            xxHash64 + cch 计算 + 文本投影
│   └── server.mjs         双模式入口（公共 server / gateway-worker）
└── test/
    ├── selfcheck.mjs      45 条契约断言
    └── cch-check.mjs      10 条 cch/xxh64 断言（含固定向量）
```

5,363 行 src + 690 行测试，零依赖。261 条契约断言全通过。

## 已验证的对齐点

### 1. 公共 server 模式（`node src/server.mjs`）

| 行为 | 上游行为 | 本实现 |
|------|------------|--------|
| 启动日志 | `{"message":"kernel listening","address":"0.0.0.0:8080","workers":1,"slots_per_worker":20,"provider":"mock"}` | 同 |
| 缺 model | `422` + `Failed to deserialize the JSON body into the target type: missing field \`model\` at line 1 column 2` | 逐字同 |
| 响应头 | `x-request-id` `x-session-id` `x-slot` `x-generation` | 同 |
| SSE 序列 | `message_start` → `content_block_start` → `content_block_delta`×N → `content_block_stop` → `message_delta` → `message_stop` → **`kin.done`** | 同 |
| `kin.done` 体 | `{continuation,generation,pid,session_id,slot}` | 同 |
| `/internal/*` | `404` | 同 |

### 1b. 对外 8 条路由

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/healthz` | `{"status":"ok","workers":1,"capabilities":[...],"max_body":...}` |
| GET | `/status` | 同 healthz |
| GET | `/readyz` | `{"status":"ready"}` 或 `{"status":"booting","reason":...}`（503） |
| POST | `/v1/messages` | Anthropic Messages（流/非流） |
| POST | `/v1/chat/completions` | OpenAI 兼容 |
| GET | `/internal/v1/slots` | `{"workers":[{slot_id,busy,session_id,idle_secs}]}` |
| GET | `/internal/v1/envelope` | `{"mode","path","note","lock"}` |
| PUT | `/internal/v1/envelope` | 热改 `mode`/`timezone` 并落盘 |

> 注意：`/internal/v1/slots` 和 `/internal/v1/envelope` 挂在**对外 TCP 面**，不在 Unix socket 上。
> Unix socket 只有 3 条：`/internal/health`、`/internal/v1/messages`、`/internal/v1/cancel`。

### 2. gateway-worker 模式（`--gateway-worker --config X`）

| 行为 | 上游行为 | 本实现 |
|------|------------|--------|
| `--config` 单独用 | `"--config is only valid with --gateway-worker"` | 同 |
| `--gateway-worker` 无 config | `"--gateway-worker requires --config"` | 同 |
| 缺字段 | `decode worker config: missing field \`vm_id\` at line 1 column 2` | 同 |
| 缺 token | `internal_token is required` | 同 |
| 非 https | `anthropic_base_url: endpoint must use https` | 同 |
| 非官方 host | `anthropic_base_url: endpoint host must be api.anthropic.com` | 同 |
| 鉴权头 | **只认 `x-internal-token`**，`x-kin-internal-token` 401 | 同 |
| 鉴权失败体 | `{"ok":false,"error":{"type":"worker_error","code":"internal_auth_failed","message":"Internal worker authentication failed","status":401}}` | 逐字同 |
| 缺 body | `missing field \`body\` at line 1 column 2` | 同 |
| 无凭据 | 401 `{"code":"needs_refresh","message":"credential needs refresh"}` | 同 |
| `/internal/v1/cancel` | `{"cancelled":false,"ok":true}` | 同 |
| `/internal/health` | 22 个字段全含 | 同 |

### 2b. 配置缺省值

| 字段 | 缺省 | 反直觉点 |
|---|---|---|
| `provider` | **`anthropic_api`** | 不是 `local_cli` |
| `socket_path` | `/run/guest/worker.sock` | |
| `credential_path` | `/home/guest/.claude/credentials.json` | |
| `oauth_token_url` | `https://platform.claude.com/v1/oauth/token` | 不是 console.anthropic.com |
| `delivery_mode` | `realtime` | |
| `default_cache_ttl` | `1h` | |
| `SystemMode` | 只有 `zero` / `identity` | 没有 official/custom 枚举值 |

### 3. 槽位

| 行为 | 依据 | 实现 |
|------|------|------|
| 上限 20 | 超限报 `Claude official subagent cap is 20` | 同上 |
| slot id | `x-slot: runtime-00`；CLI 侧 `s00` | 两种格式都提供 |
| 挑槽 | `cli-slotPool.ts` 四级顺序 | 逐级实现 |
| 粘性 | `CHANGELOG:1539` 24h | `pinTtlMs = 24h` |

### 4. 出站规范化（顺序固定）

```
system 布局（zero/identity/stock）
  → betas 官方顺序合并
  → cch 封盖（xxHash64 + seed 0x4D659218E32A3268 → 低 20 bit）
```

zero 布局输出：

```
x-anthropic-billing-header:; cc_prompt_id=<进程内固定 UUID>; cch=f4463; prompt_version=<You are a Claude agent, built on Anthropic's Claude Agent SDK.>
# Environment
 - Timezone: Asia/Shanghai
<调用方 system>
```

### 5. cch 正确性

三条独立验证同时通过：
1. xxHash 官方向量：空串 seed 0 = `ef46db3751d8e999`，`"abc"` = `44bc2cf5ad770999`
2. 与 vm2api 开源实现逐字节一致（含 32 字节分块边界、bigint 全分支）
3. `sealClaudeCodeCch` 幂等（二次封盖结果不变）

## 运行

```bash
cd research/reimpl

# 契约自检
node test/selfcheck.mjs        # 231/231
node test/cch-check.mjs        # 10/10
node test/cch-crosscheck.mjs   # 20/20（与上游实现逐字节对比）

# 模式 A：公共 server
node src/server.mjs
curl -X POST http://127.0.0.1:8080/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5-5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'

# 模式 B：gateway-worker（Unix socket）
cat > /tmp/cfg.json <<'EOF'
{"vm_id":"vm-1","internal_token":"tk","socket_path":"/tmp/run/kernel.sock",
 "credential_path":"/tmp/cred.json","runtime_kind":"local_cli","claude_bin":"claude"}
EOF
node src/server.mjs --gateway-worker --config /tmp/cfg.json
curl -s --unix-socket /tmp/run/kernel.sock http://localhost/internal/health \
  -H 'x-internal-token: tk'
```

## 与真实 kernel 的差距（自研还需要补的）

| 缺口 | 现状 | 补法 |
|------|------|------|
| CLI 帧循环未接真 CLI | `CliHost` 只用 `-p` 起进程、未发 `job_start` 帧 | 需要 patch 过的 cli-node；或用 `claude -p` 走 stdin 文本 |
| 20 个 CLI 实例预开 | 目前 1 个宿主承载 N 个逻辑 slot | 改成 slot → 独立进程池 |
| SOCKS5 桥 | 未实现 | 参考 `http_to_socks.py`，在 kernel 侧起 HTTP CONNECT 桥 |
| 重启预算 L1..L5 | 只做了降级不崩 | 按 `CHANGELOG:1056` 补 3次/10min 与 3次/1h |
| 内存水位 | 未实现 | 读 `/sys/fs/cgroup/memory.current`，按 `MEM_SOFT_BYTES` 摘流 |
| thinking 签名策略 | 未实现 | 按 `PROTOCOL.md` 的保留路径规则 |
| usage 遮罩 | 未实现 | 藏自产 system 块与 server tools 的 token |
| codex 通道 | 见 `src/codex.mjs` | 已实现凭据/Envelope/头/body/调度 |

## 关键结论

**实现上不存在技术障碍。** 各模块契约已完整覆盖，cch 算法与上游逐字节一致。

真正的维护成本在另一处：上游每次发版，tools schema、caching 策略、beta 顺序都可能变。跟进这些变化是本项目长期的维护负担，也是设计上把 beta / 身份 / 视图全部做成数据驱动的理由。

## 三平台硬件身份（2026-10-23 重构）

`src/persona/` 取代了原先单一的 `computer-identity.mjs`。

核心原则：**一份 persona 数据 → 渲染出该平台的全部视图**。任何视图都不许自己存字符串副本。

为什么这样设计：真实机器上，同一事实（主机名、内核版本、内存、核心数、磁盘容量）在 `uname`、`sw_vers`、`system_profiler`、`/etc/hostname` 等接口暴露时必须一致。如果各视图各存一份，迟早会漂移，而漂移就是最明显的特征。

| 平台 | 视图数（命令/文件） | 关键约束 |
|---|---|---|
| `macos` | 28 / 5 | 序列号 12 位、MLB 17 位、`smc_version` 不能空 |
| `windows` | 17 / 2 | 计算机名 ≤15 字符（NetBIOS）、序列号须匹配 OEM 规则 |
| `linux` | 28 / 22 | `machine-id` 32 位 hex、`/etc/machine-id` 与 dbus 那份必须相同 |

**系统性防漂移**：每次构造都跑两道检查
1. `validate` —— 字段之间是否自洽（机型↔主板、内存↔DIMM、容量↔用量）
2. `validateViews` —— 渲染出来的各视图是否字面一致（`uname -n` ↔ `scutil` ↔ `/etc/hostname`）

只用第 1 道会漏掉「字段各自合法、但渲染出来互相矛盾」的情况，而后者恰恰最容易在交叉对比时暴露。

**硬件标识从 vm_id 派生**：序列号、UUID、machine-id、MAC 全部由 `src/persona/derive.mjs` 从 vm_id 确定性派生。
同一 vm_id 恒得同一组值（重建容器不漂移），不同 vm_id 互不关联（避免一批 VM 共用同一指纹）。

```bash
# 生成某平台的身份
node src/persona/cli.mjs --platform linux --vm-id vm-01 --out ./out

# 只看会写哪些文件
node src/persona/cli.mjs --platform windows --vm-id vm-01 --dry-run

# 只看伪命令输出
node src/persona/cli.mjs --platform macos --vm-id vm-01 --commands-only

# 一致性检查（失败返回码 2）
node src/persona/cli.mjs --platform macos --vm-id vm-01 --audit
```

**加新平台**：在 `src/persona/` 下加 `<platform>.mjs`，导出 `{ KEY, DEFAULTS, normalize, validate, render, validateViews }`，然后在 `index.mjs` 的 `REGISTRY` 注册。其余代码不用改。

## 双通道支持（2026-10-23 补齐）

| 模块 | 通道 | 内容 |
|---|---|---|
| `src/frames.mjs` | Claude | 帧协议 + wireBody 合并 + metadata.user_id |
| `src/sse.mjs` | Claude | SSE 整流 |
| `src/scheduler.mjs` | Claude | 20 槽调度 |
| `src/betas.mjs` | Claude | **25 条 beta 动态注入**（cli.js 原文复刻） |
| `src/cch.mjs` | Claude | cch 计算与请求体投影 |
| `src/codex.mjs` | **Codex** | 凭据/Envelope/头/body改写/zstd/调度 |

Codex 通道的三个关键防护：

1. **拒绝顶层字段泄漏** —— Responses 字段放顶层会被静默丢弃、转发空对象给上游。这里直接报错
2. **凭据类型严格校验** —— `rpm:"60"`（字符串）会让整个凭据列表解析失败，不是只跳过那一条
3. **拒绝裸数组** —— 顶层必须是 `{"accounts":[...]}`，裸数组解析成 0 个账号

## 线上行为校正（2026-10-23）

对着真实实例（v1.3.206）跑过之后改了三处：

| 改动 | 原因 |
|---|---|
| `messageStream` 默认**不发** `kin.done` | 客户端可见流里没有该帧；仅 `emitKinDone: true` 时补，供离线对比 |
| `/readyz` `/status` `/internal/v1/slots` `/internal/v1/envelope` 默认**不挂载** | 真实部署下这些路由全部 404；`EXPOSE_KERNEL_DEBUG_ROUTES=1` 才开 |
| 事件序列断言 | 锁定为 6 帧顺序 |
