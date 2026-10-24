# INTEGRATION —— 接入指南

面向接手维护的工程师。读完这份文档应该能做到：

- 把 `research/reimpl` 跑起来，两种模式都通
- 知道每个配置字段的类型、缺省值、必填性，以及配错时报什么
- 准备好两条通道各自的凭据文件
- 知道对外暴露了哪些 HTTP 路由、哪些其实没挂
- 跑通三套测试，并用 `persona` 命令行工具生成身份文件
- 知道当前哪些部分是契约层、哪些部分还没接真实传输

代码零依赖，只用 Node.js 内置模块。开发验证环境是 Node **v22.22.0**（`zstdCompressSync` 需要 Node 22+，见 §8）。

---

## 1. 运行模式与入口

可执行的入口有两个：`src/server.mjs`（HTTP 服务，模式由参数决定）与 `src/persona/cli.mjs`（离线身份生成工具，见 §1.6）。`src/codex-server.mjs` 不是入口，它被 `server.mjs` 在启用 Codex 时实例化。

### 1.1 模式 A：独立 HTTP 服务（TCP）

```bash
# 缺省监听 0.0.0.0:8080
node src/server.mjs

# 指定地址
node src/server.mjs --addr 127.0.0.1:8080

# 等价的环境变量写法（优先级低于 --addr）
KERNEL_ADDR=127.0.0.1:8080 node src/server.mjs
```

| 项 | 值 |
|---|---|
| 监听对象 | TCP（`http.createServer().listen(port, host)`） |
| 缺省地址 | `0.0.0.0:8080` |
| 地址来源优先级 | `--addr` > 环境变量 `KERNEL_ADDR` > 字面量 `0.0.0.0:8080` |
| 槽位数 | 固定 20（`new SlotScheduler({ slots: 20 })`） |
| 鉴权 | 无。`/v1/messages` 不校验任何 token |
| Codex 面 | 可选；`--codex` / `--codex-credential` / `CODEX_CREDENTIAL_PATH` 命中时挂载 4 条路由（见 §5.2） |
| 主用途 | 给外部客户端直接当 Anthropic Messages 端点用 |

启动成功的日志（`console.log`，单行 JSON）：

```json
{"level":"INFO","fields":{"message":"kernel listening","address":"0.0.0.0:8080","workers":1,"slots_per_worker":20,"provider":"mock","claude_bin":"claude","claude_bin_source":"default"},"target":"kernel"}
```

### 1.2 模式 B：gateway-worker（Unix socket）

```bash
node src/server.mjs --gateway-worker --config cfg.json
```

| 项 | 值 |
|---|---|
| 监听对象 | Unix domain socket（`server.listen(cfg.socket_path)`） |
| 缺省路径 | 由 config 的 `socket_path` 决定，缺省 `/run/guest/worker.sock` |
| 槽位数 | 固定 4（`new SlotScheduler({ slots: 4 })`） |
| 鉴权 | 必填 `x-internal-token` 请求头，值等于 `cfg.internal_token` |
| socket 权限 | 进程启动后自己 `chmod 0600` |
| 主用途 | 挂在 gateway 后面，由控制面按 worker 调度 |

启动时做的三件事（顺序固定，见 `src/server.mjs` 的 `main()`）：

1. `fs.mkdirSync(socket 目录, { recursive: true })` —— 目录不存在会先建
2. `fs.unlinkSync(socket_path)` —— 已存在的 socket 文件先删掉（`ENOENT` 静默忽略）
3. `listen()` 成功后 `chmod 0600` —— 文件要等 listen 之后才存在，所以权限放在回调里改

启动日志：

```json
{"level":"INFO","fields":{"message":"kernel gateway-worker listening","vm_id":"vm-1","provider":"local_cli","claude_bin":"claude","claude_bin_source":"config","socket":"/run/guest/worker.sock"},"target":"kernel::gateway_worker::server"}
```

### 1.3 参数校验（都会直接抛错退出）

| 命令行 | 报错原文 |
|---|---|
| `--config x.json`（没带 `--gateway-worker`） | `--config is only valid with --gateway-worker` |
| `--gateway-worker`（没带 `--config`） | `--gateway-worker requires --config` |
| `--gateway-worker --codex` | `--codex is only valid in public server mode` |
| `--codex-credential`（没给值） | `--codex-credential requires a path` |
| `--codex`（既没给 `--codex-credential` 也没设 `CODEX_CREDENTIAL_PATH`） | `--codex requires --codex-credential or CODEX_CREDENTIAL_PATH` |
| 任何未知参数 | `unknown argument: --bogus` |

未知参数不做静默忽略 —— 拼错的参数被忽略会导致按错误的模式启动。

### 1.4 最小可用配置

```json
{
  "vm_id": "vm-1",
  "internal_token": "change-me",
  "socket_path": "/tmp/reimpl/worker.sock",
  "credential_path": "/tmp/reimpl/credentials.json",
  "anthropic_base_url": "https://api.anthropic.com"
}
```

跑起来并自测：

```bash
node src/server.mjs --gateway-worker --config cfg.json &

curl --unix-socket /tmp/reimpl/worker.sock \
     -H 'x-internal-token: change-me' \
     http://localhost/internal/health
```

### 1.5 启用 Codex 通道

Codex 通道挂在**模式 A** 上，与 `--gateway-worker` 互斥。三种启用写法等价：

```bash
# 显式给凭据路径
node src/server.mjs --codex-credential /path/to/credential.json

# 环境变量
CODEX_CREDENTIAL_PATH=/path/to/credential.json node src/server.mjs

# 显式 --codex，路径走环境变量
CODEX_CREDENTIAL_PATH=/path/to/credential.json node src/server.mjs --codex
```

可选覆盖：

```bash
node src/server.mjs --codex-credential /p/c.json \
  --codex-model gpt-6-sol \
  --addr 127.0.0.1:8080
```

| 参数 / 环境变量 | 作用 |
|---|---|
| `--codex-credential <path>` | 凭据文件路径（等价于设 `--codex`） |
| `CODEX_CREDENTIAL_PATH` | 同上，环境变量形式 |
| `--codex-model <name>` | 覆盖缺省模型 |
| `CODEX_DEFAULT_MODEL` | 同上，环境变量形式 |
| `CODEX_BASE_URL` | 覆盖上游 base（host 仍须过 `chatgpt.com` 白名单） |

启用成功的启动日志：

```json
{"level":"INFO","fields":{"message":"codex channel enabled","credential":"/p/c.json","shape":"multi","accounts":2,"default_model":"gpt-6-astra"},"target":"kernel::codex"}
```

`shape` 是 `single` 或 `multi`，取决于凭据文件的形态（见 §3.2）。**凭据加载失败会让进程启动失败**，不会起一个所有请求都 503 的空壳。

自测：

```bash
curl -s http://127.0.0.1:8080/codex/healthz
curl -s http://127.0.0.1:8080/v1/models
```

### 1.6 第三种用法：persona 身份生成工具

`src/persona/cli.mjs` 是独立命令行工具，不走 HTTP，只生成机器身份文件与伪命令输出。

```bash
# 最常用：写盘
node src/persona/cli.mjs --platform macos --vm-id vm-01 --out ./out

# 只列出会写哪些文件（不落盘）
node src/persona/cli.mjs --platform macos --vm-id vm-01 --dry-run

# 只打印伪命令输出
node src/persona/cli.mjs --platform linux --vm-id vm-01 --commands-only

# 只做自洽性检查（不写盘）
node src/persona/cli.mjs --audit --platform macos --vm-id vm-01

# 全量 JSON 输出（persona + files + commands）
node src/persona/cli.mjs --platform macos --vm-id vm-01 --json

# 覆盖个别字段（成对覆盖机型与主板，否则会撞 board_model_mismatch）
node src/persona/cli.mjs --platform macos --vm-id vm-01 --out ./out \
  --overrides '{"hardware":{"model_identifier":"MacBookPro18,3","board_id":"Mac-7DF21CB3ED6977E5"}}'
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--platform` | ✅ | `macos` / `windows` / `linux` |
| `--vm-id` | ✅ | 决定全部派生标识；同一 vm_id 恒得同一组值 |
| `--out` | ❌ | 写入目录；不给则只列出 |
| `--overrides` | ❌ | JSON 串，**递归深合并**到默认骨架（数组整体替换，不逐元素合并） |
| `--dry-run` | ❌ | 只列文件，不写盘 |
| `--commands-only` | ❌ | 只打印伪命令输出 |
| `--audit` | ❌ | 只做一致性检查 |
| `--json` | ❌ | 输出 `{persona, files, commands}` |
| `-h` / `--help` | ❌ | 打印用法 |

退出码：`0` 成功，`1` 参数错误（含平台不支持），`2` 一致性检查失败 / 构造失败。

分支优先级（同时给多个开关时按这个顺序生效）：`--audit` > `--json` > `--commands-only` > `--dry-run` / 无 `--out` > 写盘。所以 `--json --audit` 一起给时走 `--audit`。

`--overrides` 走的是 `deepMerge`，**嵌套对象逐层合并，数组整体替换**：

```bash
# dimms 给一个新数组 → 整体替换（不是逐元素合并）
--overrides '{"hardware":{"dimms":[{"slot":"DIMM1","size_bytes":34359738368,"type":"DDR4 ECC"}]}}'
```

注意 `normalize` 会用 DIMM 之和覆盖 `ram_bytes`，所以只改 `dimms` 不改 `ram_bytes` 是安全的；反过来只改 `ram_bytes` 会被 DIMM 之和盖掉。

三平台视图规模（`--dry-run` 会打印 files 数，`--commands-only` 可以数命令）：

| 平台 | files | commands | 关键约束 |
|---|---|---|---|
| `macos` | 5 | 28 | 机型↔主板必须成对；`smc_version` 不能为空；主机名三处一致 |
| `windows` | 2 | 17 | NetBIOS 名 ≤ 15 字符；序列号符合 OEM 规则 |
| `linux` | 22 | 28 | `machine-id` 双文件必须相同；hostname 符合云厂商形态（若前缀命中） |

三平台各跑一次 `--audit` 都应输出「一致性检查通过」：

```bash
for p in macos windows linux; do
  node src/persona/cli.mjs --audit --platform $p --vm-id vm-01
done
```

---

## 2. 配置项完整表格

全部字段定义在 `src/config.mjs` 的 `DEFAULT_WORKER_CONFIG`（**30 个顶层键**），校验逻辑在 `validateWorkerConfig()`；Codex 通道与提示词档位另有 `validateCodexConfig()`。

列说明：

- **必填**：「✅ 代码拦」指 `validateWorkerConfig` 会拒绝；「文档必填」指注释里声明必填但代码不校验，只在使用处才会出问题。
- **实际消费者**：这个字段在当前代码里到底被谁读。写着 `—` 表示只出现在结构体里，没有运行时影响。

### 2.1 Claude / worker 面（25 个键）

| 字段 | 类型 | 缺省值 | 必填 | 校验规则 | 实际消费者 |
|---|---|---|---|---|---|
| `vm_id` | string | `""` | ✅ 代码拦 | 空串报 ``decode worker config: missing field `vm_id` at line 1 column 2`` | 启动日志、`/internal/health` 的 `vm_id`、身份生成入参 |
| `internal_token` | string | `""` | ✅ 代码拦 | 空串报 `internal_token is required` | 模式 B 的 `x-internal-token` 比对 |
| `socket_path` | string | `/run/guest/worker.sock` | ✅ 代码拦 | 空串报 `build hop client: builder error` | 模式 B 监听路径；父目录推导 `replace(/\/[^/]+$/, '')` |
| `credential_path` | string | `/home/guest/.claude/credentials.json` | 文档必填，代码不拦 | — | `credentialState()` 读文件判定凭据状态 |
| `anthropic_base_url` | string | `https://api.anthropic.com` | ✅ 代码拦（有白名单） | 必须能被 `new URL()` 解析、必须是 `https:`、host 必须逐字等于 `api.anthropic.com` | 仅校验，不参与任何请求 |
| `oauth_token_url` | string | `https://platform.claude.com/v1/oauth/token` | ❌ | — | — |
| `proxy_url` | string | `""` | ❌ | — | `/internal/health` 的 `proxy_configured` |
| `proxy_required` | bool | `false` | ❌ | — | `/internal/health` 的 `proxy_required` |
| `https_proxy` | string | `""` | ❌ | — | —（真正生效的代理是环境变量，见 §2.5） |
| `refresh_skew_seconds` | number | `300` | ❌ | — | — |
| `request_timeout_seconds` | number | `600` | ❌ | 必须 `Number(x) > 0`，否则 `request_timeout_seconds must be positive` | — |
| `first_byte_timeout_seconds` | number | `120` | ❌ | 同上规则 | — |
| `idle_timeout_seconds` | number | `180` | ❌ | 同上规则 | — |
| `max_request_bytes` | number | `67108864`（64 MiB） | ❌ | — | **模式 B** 读请求体上限；超限后 `readBody` reject，回 400 |
| `max_response_bytes` | number | `67108864` | ❌ | — | — |
| `max_event_bytes` | number | `1048576`（1 MiB） | ❌ | — | — |
| `delivery_mode` | `realtime` / `verified` | `realtime` | ❌ | 其他值报 `delivery_mode must be realtime or verified, got "x"` | `/internal/health` 的 `delivery_mode` |
| `test_endpoints` | bool | `false` | ❌ | — | — |
| `runtime_kind` | `local_cli` / `anthropic_api` | `local_cli` | ❌ | 不做枚举校验 | `/internal/health` 的 `provider` 与 `runtime_kind` |
| `provider` | `anthropic_api` / `local_cli` | **`anthropic_api`** | ❌ | 只接受这两个值，否则 `provider must be anthropic_api or local_cli, got "x"` | 仅校验 |
| `claude_bin` | string | `claude` | ❌ | — | 由 `resolveClaudeBin()` 解析，优先级见 §2.3 |
| `system_layout` | `zero` / `identity` | `zero` | ❌ | 不做校验 | —（布局实际读 `CLAUDE_CODE_SYSTEM_LAYOUT` 环境变量） |
| `cli_version` | string | `2.1.281` | ❌ | — | `/internal/health` 的 `cli_version` |
| `default_cache_ttl` | `5m` / `1h` | `1h` | ❌ | 不做校验 | — |
| `claude_prompt_profile` | `official_full` / `official_303` | `official_full` | ✅ 代码拦 | 由 `validateWorkerConfig` 校验，其他值报 `claude_prompt_profile must be one of official_full,official_303, got "x"`；不做别名归一 | `prompt-profiles.mjs` 的档位选择 |

### 2.2 Codex 面（5 个键）

这 4 个键只在 `--codex` / `--codex-credential` / `CODEX_CREDENTIAL_PATH` 命中时才被 `validateCodexConfig()` 使用。

| 字段 | 类型 | 缺省值 | 校验规则 | 实际消费者 |
|---|---|---|---|---|
| `codex_credential_path` | string | `""` | 非空时只做类型检查（`must be a string`）；文件是否存在由加载时报错 | `createCodexHandler` 的 `loadCredentials()` |
| `codex_base_url` | string | `https://chatgpt.com/backend-api/codex` | 必须能被 `new URL()` 解析、必须 `https:`、**host 必须逐字等于 `chatgpt.com`**；通过后规范化掉尾斜杠 | `CodexUpstream` 的 `baseUrl` |
| `codex_default_model` | string | `gpt-6-astra` | 非空，且必须是 `codex_models` 里的名字，否则 `codex_default_model must be one of ..., got "x"` | 客户端未指定 `model` 时的兜底 |
| `codex_models` | string[] | 9 个模型名（见下） | — | `GET /v1/models` 的返回清单、`codex_default_model` 白名单 |
| `codex_image_models` | string[] | `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` | 只做「必须是数组」的形态校验；不做白名单校验（写错模型名不在启动时报错） | `/v1/images/*` 的可用模型清单 |

`codex_models` 的 9 个取值：`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、`gpt-reserve`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`codex-auto-review`。

⚠️ 上游对模型名是强校验：`gpt-5.1-codex` 这类名字会 400 `model is not supported when using Codex with a ChatGPT account`。换模型名字前先确认它在可用清单里。

### 2.3 `claude_bin` 的三级优先级

`resolveClaudeBin({configValue, env})` 统一实现，不要在别处重复：

| 优先级 | 来源 | 说明 |
|---|---|---|
| ① | 配置文件 `claude_bin` | 部署时写死的快照，比进程环境更难被意外覆写 |
| ② | 环境变量 `CLAUDE_BIN` | 只在配置文件没给时生效 |
| ③ | 字面量 `claude`（走 PATH） | 兜底 |

两者同时存在且**值不同**时按配置文件执行，并产出一条 warning：

```json
{"level":"WARN","fields":{"message":"claude_bin: config value /x overrides CLAUDE_BIN=/y; using config value","claude_bin":"/x","source":"config"},"target":"kernel::gateway_worker::server"}
```

返回值是 `{bin, source, warning}`，`source` 取 `config` / `env` / `default`，会打进出站日志的 `claude_bin_source` 字段。注意空串等同未设置——`configValue` 传 `undefined` 才表示"配置文件没有这个字段"。

### 2.4 四个有坑的配置项

#### 坑 1：`provider` 缺省是 `anthropic_api`，不是 `local_cli`

```js
// src/config.mjs
provider: 'anthropic_api',   // 注意：跟 runtime_kind 的缺省值不一样
runtime_kind: 'local_cli',
```

只给 `runtime_kind: 'local_cli'` 而漏了 `provider`，`provider` 会补成 `anthropic_api`。两个字段语义不同、缺省值也不同：`provider` 是上游通道选择，`runtime_kind` 是本地执行方式。校验只判这两个字面量是否合法，**不校验两者一致性**。

#### 坑 2：`anthropic_base_url` 有 host 硬白名单

```js
if (url.protocol !== 'https:') throw new Error('anthropic_base_url: endpoint must use https')
if (url.hostname !== 'api.anthropic.com') {
  throw new Error('anthropic_base_url: endpoint host must be api.anthropic.com')
}
```

三种被拦的情况：

```bash
# http → 拦
{"anthropic_base_url": "http://api.anthropic.com"}
# Error: anthropic_base_url: endpoint must use https

# 自建网关 → 拦
{"anthropic_base_url": "https://my-proxy.example.com"}
# Error: anthropic_base_url: endpoint host must be api.anthropic.com

# 端口不拦，但 hostname 必须逐字相等
{"anthropic_base_url": "https://api.anthropic.com:8443"}   # 通过
```

`url.hostname` **不含端口**。要接自建上游，改动点在 `src/config.mjs` 的 `validateWorkerConfig`（当前第 148 行那个 `if`）；放行带端口或 IP 的上游要改判 `url.host`。Codex 通道另有同形态的 `codex_base_url` host 白名单，见 §2.2。

#### 坑 3：`system_layout` 只有 `zero` / `identity` 两个值

```js
export const SYSTEM_LAYOUTS = ['zero', 'identity']
```

`stock` 是「不写自定义布局」的缺省语义，不是枚举成员。而且这个配置字段**当前不被读取** —— 布局走环境变量：

| 环境变量 | 解析结果 |
|---|---|
| `CLAUDE_CODE_SYSTEM_LAYOUT=zero` | `zero` |
| `CLAUDE_CODE_SYSTEM_LAYOUT=identity` / `id` / `block` | `identity` |
| 未设置或其它任何值 | `stock` |

三种布局的实际输出（`leftover` 是调用方自带的 system 文本）：

```text
stock    → ["# Environment\n - Timezone: America/New_York", "USER SYS"]
zero     → ["x-anthropic-billing-header:; cc_prompt_id=<uuid>; cch=00000; prompt_version=<...>",
            "# Environment\n - Timezone: America/New_York", "USER SYS"]
identity → ["You are a Claude agent, built on Anthropic's Claude Agent SDK.",
            "# Environment\n - Timezone: America/New_York", "USER SYS"]
```

时区读 `CLAUDE_CODE_TIMEZONE` > `SLOT_TZ` > `TZ` > `America/New_York`。

#### 坑 4：`socket_path` 写 `tcp://` 前缀不会走 TCP

`socket_path` 原样传给 `server.listen(path)`，没有协议前缀解析逻辑。写 `tcp://127.0.0.1:19090` 的结果是：在当前工作目录下创建 `tcp:` 目录，并在其中创建名为 `127.0.0.1:19090` 的 **Unix socket 文件**。日志里照样打印 `"socket":"tcp://127.0.0.1:19090"`，看起来一切正常。

```bash
{"socket_path": "tcp://127.0.0.1:19090"}
# 实际产物：
drwxr-xr-x  tcp:/
srw-------  tcp:/127.0.0.1:19090
```

要监听 TCP 就用模式 A + `--addr`。要 Unix socket 就给绝对路径，别加前缀。

### 2.5 环境变量速查

配置文件之外，这些环境变量才真正影响行为：

| 变量 | 作用 | 缺省 |
|---|---|---|
| `CLAUDE_BIN` | CLI 可执行文件路径 | `claude` |
| `CLAUDE_CODE_SYSTEM_LAYOUT` / `SYSTEM_MODE` | system 布局：`zero` / `identity`（`id`、`block` 是别名）/ 其它=stock | 未设置 |
| `CLAUDE_CODE_TIMEZONE` / `SLOT_TZ` / `TZ` | 环境块时区 | `America/New_York` |
| `CLAUDE_CODE_VERSION` | UA 里的版本号 | `2.1.296` |
| `CLAUDE_CODE_ENTRYPOINT` | UA 里的 entrypoint | `sdk-cli`（`CliHost` 自动补） |
| `CLAUDE_CODE_SESSION_KIND` | 为 `bg` 时 app 头是 `cli-bg` | 未设置 → `cli` |
| `USER_TYPE` | `CliHost` 传给 CLI | `external`（自动补） |
| `EXPOSE_KERNEL_DEBUG_ROUTES=1` | 模式 A 打开 `/readyz` 与 `/internal/*` 调试路由 | 关闭（一律 404） |
| `KERNEL_ADDR` | 模式 A 监听地址 | `0.0.0.0:8080` |
| `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` / `ANTHROPIC_UNIX_SOCKET` | 决定出站走 h1 还是 h2（`resolveUpstreamProtocol`） | 无代理 → h2 |
| `CODEX_CREDENTIAL_PATH` | Codex 凭据文件路径；给了就等于启用 Codex 通道 | 未设置（通道不挂载） |
| `CODEX_BASE_URL` | Codex 上游 base，覆盖配置缺省值；host 仍须过 `chatgpt.com` 白名单 | `https://chatgpt.com/backend-api/codex` |
| `CODEX_DEFAULT_MODEL` | Codex 缺省模型，覆盖配置缺省值 | `gpt-6-astra` |

`CliHost` 会无条件覆盖三个环境变量（`src/frames.mjs`）：

```js
CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
CLAUDE_CODE_ENTRYPOINT: env.CLAUDE_CODE_ENTRYPOINT || 'sdk-cli',
USER_TYPE: env.USER_TYPE || 'external',
```

这三个是 CLI 进入帧驱动模式的前提。`CLAUDE_CODE_ENTRYPOINT` 与 `USER_TYPE` 只在调用方没设时才填，`DISABLE_NONSTREAMING_FALLBACK` 是强制覆盖。

---

## 3. 凭据文件格式

两条通道各用一套，格式完全不同，不要混。

### 3.1 Claude 通道

路径由 `credential_path` 指定（缺省 `/home/guest/.claude/credentials.json`）。

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": 1793000000000,
    "authScheme": "Bearer",
    "scopes": ["user:inference", "user:profile"]
  }
}
```

`credentialState()` 只读 `claudeAiOauth.accessToken`、`.expiresAt`、`.refreshToken` 三个键，其余忽略。

状态机（阈值硬编码在 `src/server.mjs`）：

| 条件 | 状态 | 模式 B `/internal/v1/messages` 的后果 |
|---|---|---|
| 文件读不到 / 不是 JSON / 无 `accessToken` | `missing` | 401 `needs_refresh` |
| `expiresAt` 缺失或为 0 | `fresh` | 放行 |
| `now >= expiresAt` 且有 `refreshToken` | `expired_refreshable` | 401 `needs_refresh` |
| `now >= expiresAt` 且无 `refreshToken` | `expired` | 401 `needs_refresh` |
| 剩余 < 60 000 ms | `refresh_window` | 放行 |
| 剩余 < 300 000 ms | `refreshable` | 放行 |
| 其它 | `fresh` | 放行 |

⚠️ 只有 `missing` 和 `expired*` 会拒；`refresh_window` / `refreshable` 依然放行，代码里没有真的去刷新 token。

最小可跑样例（`expiresAt` 用**毫秒**时间戳，不是秒）：

```bash
python3 - <<'PY' > credentials.json
import json, time
print(json.dumps({"claudeAiOauth": {
  "accessToken": "a", "refreshToken": "r",
  "expiresAt": int(time.time()*1000) + 3600_000,
  "authScheme": "Bearer", "scopes": ["user:inference"]}}))
PY
```

### 3.2 Codex 通道

Codex 通道接受**两种凭据形态**，由 `src/codex-credentials.mjs` 的 `parseCredentialText()` 统一归一。归一之后两种情况都变成 `Account[]`，上层不需要分支——调度器对 1 个账号和 N 个账号的行为一致。

#### 形态 A：多账号 `{"accounts":[...]}`

顶层是对象且带 `accounts` 数组。这条路径交给 `codex.mjs` 的 `parseCredentialFile()` 做严格字段校验：

```json
{
  "accounts": [
    {
      "id": "acc-1",
      "access_token": "eyJhbGciOi...",
      "refresh_token": "v1.Mr...",
      "id_token": "eyJhbGciOi...",
      "expires_at": 1793000000,
      "chatgpt_account_id": "00000000-0000-0000-0000-000000000000",
      "rpm": 60,
      "max_concurrency": 4
    }
  ]
}
```

字段约束（`ACCOUNT_FIELDS`，数组顺序即字段声明顺序）：

| 字段 | 类型 | 必填 | 缺失时补 | 类型写错的后果 |
|---|---|---|---|---|
| `id` | string | ✅ | — | ``account missing required field `id` `` |
| `access_token` | string | ❌ | `""` | `account.access_token must be string, got number` |
| `refresh_token` | string | ❌ | `""` | 同上 |
| `id_token` | string | ❌ | `""` | 同上 |
| `expires_at` | **i64** | ❌ | `null` | `account.expires_at must be i64, got "999"` |
| `chatgpt_account_id` | string | ❌ | `""` | 同上 string 规则 |
| `rpm` | **u32** | ❌ | `null` | `account.rpm must be u32, got "60"` |
| `max_concurrency` | **u32** | ❌ | `null` | 同上 |

`u32` = 整数且落在 `[0, 4294967295]`；`i64` = 整数且落在 64 位有符号范围内。**字符串一律不接受**。

#### 形态 B：单账号（Codex CLI 导出的形状）

顶层是对象但没有 `accounts` 数组时，按单账号处理。这条路径做两处**字段改名**，都是必须的：

| 源字段 | 归一后 | 原因 |
|---|---|---|
| `account_id` | `chatgpt_account_id` | 出站头叫 `chatgpt-account-id` |
| `expired` | `expires_at`（unix 秒） | 内部统一用 `expires_at` |

```json
{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "v1.Mr...",
  "account_id": "00000000-0000-0000-0000-000000000000",
  "expired": "2026-11-02T00:00:00Z",
  "email": "user@example.com"
}
```

`id` 的取值顺序是 `id` → `account_id` → `email` → 随机 UUID。**不要用 access_token 片段做 id**：token 刷新后会变，账号亲和会全部失效。

两条硬约束：

- 没有 `access_token` 直接抛 `credential missing `access_token``
- `"disabled": true` 的账号**直接抛错**，而不是静默过滤掉——少一个账号会让"为什么只有一个号可用"查很久

`expires_at` 支持三种写法，由 `parseExpiry()` 解析：ISO/RFC3339 字符串、秒级数字、毫秒级数字（大于 1e11 视为毫秒）。

#### 三条必须显式报错的写法

| 写法 | 想象中的后果 | 本实现 |
|---|---|---|
| `[{...}]`（裸数组） | 静默解析成 0 个账号 | `credential file must be an object, not a bare array` |
| `{"items":[...]}` / `{"credentials":[...]}` / `{"account":{}}` | 静默解析成 0 个账号 | 走单账号分支 → `credential missing access_token` |
| `{"accounts":[{"id":"x","rpm":"60"}]}` | **整批**账号变空（不是跳过这一条） | `account.rpm must be u32, got "60"` |

第三条是最贵的坑：一条账号的 `rpm` 写成字符串，整个凭据列表就空了，而且表面上没有任何错误提示。本实现选择 fail-fast，把问题暴露在加载阶段。凭据在**启动时**就加载（`createCodexHandler` 里 `loadCredentials`），加载失败直接启动失败——宁可起不来，也不要起来后每个请求都 503。

#### 账号到期与刷新

`accountState(account)` 与 Claude 侧的 `credentialState()` 使用同一套档位命名，便于控制面复用判断：

| 条件 | 状态 |
|---|---|
| 无 `access_token` | `missing` |
| 无 `expires_at`（无法判断） | `fresh` |
| 已过期且有 `refresh_token` | `expired_refreshable` |
| 已过期且无 `refresh_token` | `expired` |
| 剩余 < 300 秒（`EXPIRY_CRITICAL_SECS`） | `refresh_window` |
| 剩余 < 3600 秒（`EXPIRY_WARN_SECS`） | `refreshable` |
| 其它 | `fresh` |

`CredentialManager` 负责刷新：`ensureFresh(accountId)` 在账号不 fresh 时调注入的 `refreshFn`，成功则就地更新并回写文件。**没有注入 `refreshFn` 时抛 `needs_refresh`** —— OAuth PKCE 流程需要外部实现，本模块只留注入点。

### 3.3 凭据状态在健康检查里的呈现

`/internal/health` 的 `credential_state` 直接来自 `credentialState(cfg.credential_path)`，取值就是 §3.1 表里那六个。控制面靠它决定走刷新流程还是重试：

```json
{"credential_state": "fresh", "healthy": true, "ok": true}
```

Codex 侧有独立的 `GET /codex/healthz`（见 §5.2）：

```json
{
  "ok": true,
  "accounts": [{"id": "acc-1", "state": "fresh", "expires_at": 1793000000,
                "seconds_left": 864000, "has_refresh_token": true}],
  "scheduler": {"accounts": [{"id": "acc-1", "inflight": 0, "cooldown_secs_left": 0, "rpm_used": 0}],
                "session_affinity": 0, "thread_affinity": 0}
}
```

判定规则有个细节：`expired_refreshable` 只是「有 refresh_token、理论上可救」，**如果没有注入 `refreshFn`，这个账号实际发不出请求**。所以 `healthy` 的判定是 `fresh` / `refreshable` / `refresh_window`，或 `expired_refreshable` 且 `manager.canRefresh` ——只按状态名判断会给出 200 的假健康，把问题推到第一个真实请求上。它绝不返回 token 内容。

---

## 4. 两条通道的请求流程

### 4.1 Claude 通道（模式 A）

```text
客户端
  │  POST /v1/messages
  ▼
┌─────────────────────────────────────────────────────────┐
│ server.mjs  buildPublicServer                            │
│  ① readBody(req, 64 MiB)      超限 → 400                 │
│  ② JSON.parse                  失败 → 400                 │
│  ③ 检查 payload.model          缺失 → 422 + 固定文案      │
│  ④ sessionId = x-session-id 头 || randomUUID()            │
└─────────────────────────────────────────────────────────┘
  │
  ├──► scheduler.mjs  SlotScheduler.submit({sessionId, model, request})
  │      ⑤ pins 里同 session 且 idle → 直接用
  │      ⑥ pickSlotByModel：idle 且 model 匹配 → idle 未绑 model → 任意 idle
  │      ⑦ 没有空闲槽 → 返回 null → HTTP 503 kernel_unavailable
  │      ⑧ 占槽：phase='running'，绑定 model/sessionId/jobId，写 pins
  │      ⑨ host.startJob(...)
  │            ▼
  │      frames.mjs  CliHost.write(jobStartFrame)
  │            frame = {type:"job_start", job_id, slot_id, request}
  │            → CLI 子进程 stdin（一行 JSON + \n）
  │            ▼
  │      CLI 子进程（claude -p）
  │            ▼ stdout 每行一帧（NDJSON）
  │      classifyStdoutFrame()：snake_case → camelCase 的唯一转换点
  │        host_ready    → resolve CliHost.ready
  │        stream_event  → jobs.get(jobId).onEvent(event)
  │        job_done      → _release(slot)，resolve(job.done)
  │        job_error     → 同上
  │        cancel_ack    → 同上
  │        pong / unknown → 交给全局 onFrame
  │
  ├──► prepareOutbound(payload)      （与调度并行）
  │      ⑩ system 块 ≥ 4 个 → wireSystemBlocks（规范化 + cch 归零）
  │         否则 systemLayout 为真且 != 'stock' → layoutSystemBlocks
  │      ⑪ betas 合并 → mergeOfficialExtraBetas（官方顺序优先）
  │      ⑫ sealClaudeCodeCch → xxHash64 取低 20 bit 封 5 位 hex
  │
  └──► sse.mjs  messageStream / messageBody
         ⑬ stream=true  → SSE：message_start → content_block_start →
                          content_block_delta×N → content_block_stop →
                          message_delta → message_stop
         ⑭ stream=false → JSON 体 + x-request-id / x-session-id /
                          x-slot / x-generation
  ▼
客户端收到响应
```

**当前实现的边界**：⑬ 的响应内容是本地合成的（`mock response: <prompt> [...]`），不是 CLI 的 `stream_event`。原因：`buildPublicServer` 里 `submit()` 的 `onEvent` 传的是 `null`，CLI 回的流事件没有落地消费。帧确实写出去了（可用假 CLI 验证，见 §6.4），但回程还没接。

### 4.2 Claude 通道（模式 B，Unix socket）

```text
控制面
  │  POST /internal/v1/messages   (头：x-internal-token)
  ▼
① authed()：只认 x-internal-token，不匹配 → 401 internal_auth_failed
② readBody(req, cfg.max_request_bytes)
③ new Envelope(json)
     body 缺失 → 400 invalid_request，文案 `missing field `body` at line 1 column 2`
     Envelope 8 字段：body / headers / stream / delivery_mode /
                      cache_ttl / preserve_cache_breakpoints /
                      request_context / request_id
④ credentialState(cfg.credential_path)
     missing 或 expired* → 401 needs_refresh
⑤ extractSessionId(envelope.body)
     metadata.user_id（JSON 串）里的 session_id；解析不出来就 randomUUID()
⑥ scheduler.submit(...) → 无槽 → 503 slot_busy
⑦ 响应：envelope.stream === true 走 SSE，否则 JSON
```

模式 B **不调用** `prepareOutbound`：system 布局、betas 合并、cch 封盖三步都不做，body 原样转发给 CLI。

### 4.3 Codex 通道

Codex 通道已接真实上游。挂载条件：`--codex` / `--codex-credential <path>` / `CODEX_CREDENTIAL_PATH` 任一命中。挂在**公共 server 模式**（TCP）上，与 `--gateway-worker` 互斥（`--codex is only valid in public server mode`）。

```text
客户端
  │  POST /v1/responses           （Responses 原生格式）
  │  POST /v1/chat/completions    （Chat 格式，内部转换）
  ▼
① codex-server.mjs  readRequestBody(req, maxBodyBytes)
     超限 → 400；非法 JSON → 400 `invalid JSON body: ...`
     非对象/数组 → 400 `body must be a JSON object`
     /v1/chat/completions 额外要求 messages 是数组
② 格式分支
     /v1/responses        → body 原样（不做字段改写）
     /v1/chat/completions → chatToResponses({...chat, model})
                            dropped 字段写进日志，不静默吞
③ 组 envelope
     stream 恒为 true                   ← 上游硬性要求
     session = pickSessionId(req, payload)  → {session_id} 或 null
     （头 session-id > 头 x-session-id > body session_id > body user；都没有就 null，
       交给调度器走"首个可用"，硬造 session 会让亲和永远建立不起来）
④ executeCodexRequest({upstream, scheduler, envelope, ...})
     ④a AccountScheduler.select({sessionId})
            ① session 亲和命中且 canTake → 用
            ② thread 亲和命中且 canTake → 用
            ③ 全表扫描取首个 canTake 的
            canTake = 未冷却 && inflight < max_concurrency && rpm 滑窗未满
            命中即 hold()：inflight+1、记 RPM 样本、**只在无绑定时**建立初始亲和
     ④b buildOutboundBody({body, session, installationId, clientFeatures})
            store = false                            ← 强制覆盖
            stream = true                            ← 无条件写入
            service_tier: fast → priority
            delete 12 个身份键（STRIP_IDENTITY_KEYS）
            clientFeatures 开 → 注入 client_metadata（键名带 x-codex- 前缀）
     ④c buildOutboundHeaders({account, body, ...})
            authorization: Bearer <access_token>
            content-encoding: zstd
            accept: text/event-stream
            session-id / x-codex-turn-id（每次新 UUID，忽略客户端传入）
            chatgpt-account-id / x-codex-installation-id
            x-codex-routing-hint: model=..;tier=..（与 body 用同一份 service_tier）
            originator / version（从 UA 切出来）
            preferWebsocket → openai-beta: responses_websockets=2026-02-06
     ④d mergePassthroughHeaders(白名单 30 个) → 再覆盖一次 authorization
     ④e compressBody(zstd) → CodexUpstream.createResponse → fetch
            不手动设 content-length
⑤ 失败分派（最多 maxAttempts = 3 次，同一账号不重复试）
     401        → markCooldown + 换号
     429 / 5xx  → markCooldown（优先 Retry-After） + 换号
     其他 4xx   → 直接返回客户端，不重试
⑥ 上游 200
     CodexUpstream.iterEvents(stream) 逐帧解析 event:/data:，[DONE] 结束
     流式判定依据是**请求时的 accept**，不是响应的 content-type（上游给 null）
⑦ 回写
     /v1/responses        → client 要流：原样转 SSE
                            client 要非流：collectResponsesStream 聚合后回 JSON
     /v1/chat/completions → client 要流：responsesEventsToChatSse 逐帧翻译
                            client 要非流：responsesToChatCompletion 一次性返回
⑧ 收尾
     成功路径补一次 scheduler.release(accountId)（失败路径 executeCodexRequest 已释放）
     客户端断开 → res.on('close') → ctrl.abort() 中止上游
```

Codex 侧的常量（不是配置项，写在 `src/codex.mjs` 顶部）：

| 常量 | 值 | 含义 |
|---|---|---|
| `DEFAULT_CHATGPT_BASE` | `https://chatgpt.com/backend-api/codex` | 上游 base URL（不要加尾斜杠） |
| `DEFAULT_OAUTH_TOKEN_URL` | `https://auth.openai.com/oauth/token` | OAuth 换 token |
| `DEFAULT_CODEX_UA` | `codex_cli_rs/0.160.0 (linux x86_64)` | 出站 UA，也被切成 `originator` / `version` |
| `WS_BODY_LIMIT` | `15728640`（15 MiB） | 超过就不试 WS |
| `ANALYTICS_PATH` | `/analytics-events/events` | 埋点路径 |
| `DEFAULT_COOLDOWN_SECS` | `30` | 冷却缺省秒数 |
| `RATE_LIMIT_COOLDOWN_SECS` | `60` | 429 时冷却秒数 |
| `RPM_WINDOW_SECS` | `60` | 本地 RPM 统计滑窗 |

`codex-server.mjs` 的常量：

| 常量 | 值 | 含义 |
|---|---|---|
| `DEFAULT_CODEX_MODEL` | `gpt-6-astra` | 客户端未指定 model 时的兜底 |
| `CODEX_MODELS` | 9 个模型名 | `GET /v1/models` 的返回清单（与 `config.mjs` 的 `codex_models` 同一份来源） |
| `DEFAULT_MAX_BODY_BYTES` | `67108864`（64 MiB） | 请求体上限 |

### 4.4 真实上游接入要点

- **上游地址**：`https://chatgpt.com/backend-api/codex/responses`（POST）
- **可用模型**：`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、`gpt-reserve`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`codex-auto-review`。`gpt-5.1-codex` 这类名字会 400 `model is not supported when using Codex with a ChatGPT account`，换名字前先确认在清单里。
- **必需请求头**：

```text
authorization: Bearer <access_token>
chatgpt-account-id: <account_id>
content-type: application/json
accept: text/event-stream
user-agent: codex_cli_rs/0.160.0 (linux x86_64)
originator: codex_cli_rs
version: 0.160.0
session-id: <uuid4>
x-codex-turn-id: <uuid4>
content-encoding: zstd     （body 用 zstd 压缩；不压缩也能过）
```

- **三条必须做对的传输细节**：body 必须显式 `stream: true`；不要依赖响应 `content-type` 判断流式（上游是 `null`）；不要手动设 `content-length`。理由见 `ARCHITECTURE.md` §5.10。
- **响应头里的配额信息**（诊断用，`codex-server.mjs` 会把 `x-codex-*` 透出到客户端响应头，但排除 `x-codex-turn-state`，那个是下一轮要回传的内部状态）：

```text
x-codex-plan-type: pro
x-codex-primary-used-percent: 0
x-codex-primary-window-minutes: 10080      ← 7 天窗口
x-codex-primary-reset-after-seconds: 533366
x-codex-primary-reset-at: 1793295439
x-codex-secondary-window-minutes: 0        ← Pro 号没有 5 小时窗口
x-codex-credits-balance: 59127.7752080000
x-codex-active-limit: premium
x-codex-turn-state: <长串，下轮要回传>
```

- **SSE 事件序列**（10 个事件，`response.output_text.delta` 是文本增量，`response.completed` 里带 usage）：

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta        ← 文本增量在这里
response.metadata
response.output_text.done
response.content_part.done
response.output_item.done
response.completed                ← usage 在这里
```

---

## 5. 对外暴露的 HTTP 路由

两条监听面（TCP / Unix socket）路由集合**不同**，且 TCP 面还有一组 Codex 路由只在启用时才挂载。下面分三张表。

### 5.1 模式 A（TCP）— Claude 面

| 方法 | 路径 | 需要 `EXPOSE_KERNEL_DEBUG_ROUTES=1` | 响应 |
|---|---|---|---|
| GET | `/healthz` | 否 | `{status:'ok', workers:1, capabilities:["multi_slot","native_sse","stateless","ping"], max_body:67108864, client_channel:'sse'}` |
| GET | `/status` | 否 | 在 `/healthz` 的字段基础上**追加** `cli_started` / `cli_error` / `ready_slots` 三个诊断字段 |
| POST | `/v1/messages` | 否 | Anthropic Messages：流式走 SSE，非流式走 JSON |
| GET | `/readyz` | **是** | 有空槽或 CLI 不可用 → 200 `{status:'ready', cli_started}`；否则 503 `{status:'booting', reason:'no idle slot'}`；CLI 出错时追加 `cli_error` |
| GET | `/internal/v1/slots` | **是** | `{workers:[{slot_id, busy, session_id, idle_secs}]}` |
| GET | `/internal/v1/envelope` | **是** | `{mode, path, note, lock}` |
| PUT | `/internal/v1/envelope` | **是** | 热改 `mode`（写 `CLAUDE_CODE_SYSTEM_LAYOUT`）与 `timezone`（写 `CLAUDE_CODE_TIMEZONE`），回 `{ok:true, mode}` |
| * | 其它 | — | 404 |

`/status` 与 `/healthz` **不再完全相同**：`/healthz` 是给探针用的固定小载荷（字段集合不能变），`/status` 承载诊断信息。`cli_error` 是 `{code, bin, reason, message}` 四字段或 `null`。

不加 `EXPOSE_KERNEL_DEBUG_ROUTES=1` 时，带「是」标记的四条路由返回 **404**。这个缺省是有意为之：`/internal/*` 在 TCP 面上默认不挂。

⚠️ `PUT /internal/v1/envelope` 只改 `process.env`，**不落盘**。进程重启后回到环境变量原本的布局。

`/v1/messages` 的错误码：

| 情况 | 状态 | 响应体 |
|---|---|---|
| 非 POST | 405 | 空体 + `allow: POST` |
| body 不是 JSON | 400 | 空体 |
| 缺 `model` | 422 | ``Failed to deserialize the JSON body into the target type: missing field `model` at line 1 column 2``（`text/plain; charset=utf-8`） |
| 无空闲槽 | 503 | `{ok:false, error:{type:'worker_error', code:'kernel_unavailable', message:'no free slot', status:503}}` |

### 5.2 模式 A（TCP）— Codex 面（启用时才挂）

挂载条件：`--codex` / `--codex-credential <path>` / `CODEX_CREDENTIAL_PATH` 任一命中。这组路由在 `buildPublicServer` 的最前面匹配（路径与 Claude 面不重叠，无歧义），`handle()` 返回 `false` 才继续走 Claude 面。

| 方法 | 路径 | 响应 |
|---|---|---|
| POST | `/v1/responses` | OpenAI Responses 格式。同一份 body 透传给上游；上游返回的事件流按客户端 `stream` 决定原样转 SSE 还是聚合后回 JSON |
| POST | `/v1/chat/completions` | Chat Completions 格式。内部转成 Responses 请求，再把事件流翻回 Chat SSE（或聚合后回 JSON） |
| GET | `/v1/models` | `{object:'list', data:[{id, object:'model', created, owned_by:'openai'}]}`，清单来自 `CODEX_MODELS` |
| POST | `/v1/images/generations` | 生图。直连上游 `backend-api/codex/images/generations`，不经内核 |
| POST | `/v1/images/edits` | 图片编辑。body 收 JSON 或 `multipart/form-data` 两种形态，内部归一到上游格式 |
| GET | `/codex/healthz` | 凭据与调度状态；健康返回 200，无可用账号返回 503。**绝不返回 token 内容** |
| * | 其它 | 落到 Claude 面（再 404） |

生图通道的额外约束：

- 模型白名单来自 `codex_image_models`（缺省 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`）。写错模型名不会在启动时报错，但请求会被上游拒绝
- 可用性按账号的 plan 判定（`imageGenerationAvailable` / `planTypeFromCredential`），plan 不支持时提前拒绝而不是打到上游
- `multipart/form-data` 走 `parseMultipart` 手工解析，边界从 `content-type` 的 `boundary=` 取
- 超时独立于文本通道：`IMAGE_TIMEOUT_MS` 是 600 秒，另有 `IMAGE_ADMISSION_WAIT_MS`（30 秒）的排队上限

单个路由的方法不符时回 405 + `allow` 头。上游错误会被翻译成 OpenAI 错误体：

| 上游状态 | 回给客户端 | `type` / `code` |
|---|---|---|
| 401 / 403 | 同状态码 | `authentication_error` / `upstream_unauthorized` |
| 429 | 429 | `rate_limit_error` / `rate_limited`（响应头带 `Retry-After`，响应体带 `retry_after`） |
| 400 / 422 | 同状态码 | `invalid_request_error` / `upstream_invalid_request` |
| 5xx | 502 | `api_error` / `upstream_error` |

调度层自己产生的失败**不走上面的翻译**，原样透出 503，避免与 HTTP 状态矛盾（`SCHEDULER_ERROR_CODES`）：

| 本地 `code` | 含义 |
|---|---|
| `all_rejected` | 账号池非空，但全部不可用（冷却 / 并发满 / RPM 满） |
| `no_candidates` | 账号池为空 |
| `exhausted` | 重试次数用尽，全部账号都失败过 |
| `no_account` | 选号阶段直接抛错 |

这四种一律 → 503 + `service_unavailable_error`。不先拦住的话会落进 5xx 分支被改写成 502 `upstream_error`，与实际的 HTTP 503 互相矛盾。

请求体本身的错误（本地判定）：非法 JSON → 400 `invalid JSON body: ...`；非对象 → 400 `body must be a JSON object`；超限 → 400 `too_large`；`/v1/chat/completions` 的 `messages` 不是数组 → 400 `` `messages` is required and must be an array ``。

### 5.3 模式 B（Unix socket）— 只有 Claude 面

| 方法 | 路径 | 鉴权 | 响应 |
|---|---|---|---|
| GET | `/internal/health` | `x-internal-token` | 见 §5.4 |
| POST | `/internal/v1/cancel` | `x-internal-token` | `{cancelled:false, ok:true}`（当前恒为 false） |
| POST | `/internal/v1/messages` | `x-internal-token` | Anthropic Messages（流/非流） |
| * | 其它 | — | 404 |

**Unix socket 面上没有任何 Codex 路由**：`--codex` 与 `--gateway-worker` 互斥，启动时直接拒绝。

鉴权失败一律 401 + `{ok:false,error:{type:'worker_error',code:'internal_auth_failed',message:'Internal worker authentication failed',status:401}}`。只认 `x-internal-token` 一个头名；别名头（如 `x-kin-internal-token`）会 401。

`/internal/v1/messages` 的错误码：

| 情况 | 状态 | `code` |
|---|---|---|
| 请求体超 `max_request_bytes` | 400 | `too_large` 或 `invalid_request` |
| Envelope 缺 `body` | 400 | `invalid_request` |
| 凭据 `missing` / `expired*` | 401 | `needs_refresh` |
| 无空闲槽 | 503 | `slot_busy` |

### 5.4 `/internal/health` 响应字段

```json
{
  "classifier_request_context": false,
  "cli_error": null,
  "cli_pid": 93218,
  "cli_restarts": 0,
  "cli_started": true,
  "cli_version": "2.1.281",
  "closed_slots": 0,
  "credential_state": "fresh",
  "delivery_mode": "realtime",
  "engine": "rust",
  "healthy": true,
  "ok": true,
  "provider": "local_cli",
  "proxy_configured": false,
  "proxy_required": false,
  "ready_slots": 4,
  "recovering": false,
  "runtime_kind": "local_cli",
  "unhealthy_reason": null,
  "uptime_seconds": 1,
  "version": "0.1.0",
  "vm_id": "vm-a",
  "worker_version": "0.1.0"
}
```

四个字段容易误读：

- `engine` 恒为字面量 `"rust"`（对齐控制面的实现来源识别），跟本实现无关；自研部署可改成自有标识
- `healthy` 只表达进程自身是否存活，CLI 不可用也仍报 `true`
- `ok` 额外要求 `readySlots > 0`，槽耗尽时会变 `false`，此时 `healthy` 仍可能是 `true`
- `cli_started` 表示是否已收到过 `host_ready`；`cli_error` 正常为 `null`，CLI 启动/退出失败时带 `{code, bin, reason, message}`（不含堆栈）。这两个字段让「进程活着但 CLI 挂了」这种状态可被诊断

---

## 6. 如何跑测试

所有测试都是零依赖脚本，直接 `node` 跑，靠退出码判断（失败退 1）。

三套核心测试（本文件 §6.3 详细展开）：

| 测试 | 命令 | 断言数 | 覆盖 |
|---|---|---|---|
| 契约自检 | `node test/selfcheck.mjs` | **236** | 19 个模块的行为逐条对照，35 个分节 |
| cch 一致性 | `node test/cch-check.mjs` | **10** | xxHash64 标准测试向量 + 与参考实现比对 |
| cch 交叉验证 | `node test/cch-crosscheck.mjs` | **25** | 5 条 billing 块定位 + 投影与 cch 值对照独立实现（10 组 × 2） |

另外十三套（`node test/run-all.mjs` 会一并跑）：

| 测试 | 命令 | 断言数 | 覆盖 |
|---|---|---|---|
| Codex 格式转换 | `node test/codex-convert.mjs` | **145** | Chat Completions ⇄ Responses 双向转换，纯函数不碰网络 |
| Codex 传输层 | `node test/codex-upstream.mjs` | **156** | 假 fetch / 假 stream，不建真实网络连接 |
| Codex SSE 事件 | `node test/codex-sse.mjs` | **64** | 事件解析与帧翻译 |
| Codex 调度 | `node test/codex-scheduler.mjs` | **111** | 亲和、冷却、RPM、换号 |
| 真实启动验证 | `node test/smoke-server.mjs` | **60** | 真起进程打真实 HTTP：两种模式、鉴权、SSE、参数校验、进程收尾 |
| 缓存断点布局 | `node test/cache-breakpoints.mjs` | **115** | `messages` / `system` 的缓存断点分配，纯函数 |
| 缓存断点端到端 | `node test/breakpoints-demo.mjs` | **22** | 10 条消息的实际 body 结构 + 封盖后的 cch |
| Codex 凭据 | `node test/codex-credentials.mjs` | **96** | 单账号/多账号形态、到期解析、状态机、刷新注入 |
| Codex HTTP 面 | `node test/codex-server.mjs` | **109** | 路由分发、错误翻译、请求体边界 |
| Codex 生图 | `node test/codex-images.mjs` | **166** | 模型白名单、plan 判定、multipart 解析、上游请求 |
| 回归修正 | `node test/fixes.mjs` | **57** | 已修问题的回归保护 |
| 出站结构骨架 | `node test/outbound-shape.mjs` | **127** | 脱敏骨架归约与差异比对 |
| 提示词档位 | `node test/prompt-profiles.mjs` | **233** | 两套档位的 system 组装、Environment 段、标记计数 |

全量合计 **1732** 条断言。

一次性全跑（推荐，会汇总各套结果）：

```bash
cd research/reimpl
node test/run-all.mjs              # 全量（含 smoke）
node test/run-all.mjs --fast       # 跳过 smoke
node test/run-all.mjs --filter cch # 只跑名字含 cch 的
```

`run-all.mjs` 的判定规则值得知道：每个文件末行必须是「通过 N / 失败 M」；能解析就用 N/M 计数；**退出码非 0 一律判失败**（即使 N/M 显示 0 失败）；退出码 0 但没有「通过」行判为「无结果」并标异常，不当成功。缺行意味着测试主体没跑到（import 阶段就崩了、或被 `process.exit` 提前带走），静默成功会把真实故障掩盖掉。

只跑三套核心测试并逐个确认退出码：

```bash
node test/selfcheck.mjs      && \
node test/cch-check.mjs      && \
node test/cch-crosscheck.mjs
```

通过时的尾部输出：

```text
通过 236 / 失败 0

通过 10 / 失败 0

通过 25 / 失败 0
```

### 6.1 依赖关系

| 测试 | import 了什么 | 换机器要注意 |
|---|---|---|
| `test/selfcheck.mjs` | 只 import `../src/*` | 完全自包含，任何机器可跑 |
| `test/cch-check.mjs` | 额外 import `research/vm2api/src/lib/identity/{xxh64,cch}.mjs` | 路径是**硬编码绝对路径**，换机器要改前 3 行 |
| `test/cch-crosscheck.mjs` | 额外 import `./fixtures/official-cch.mjs` | 相对路径，自包含 |

所以 `cch-check.mjs` 在缺少 `research/vm2api` 时会直接 `ERR_MODULE_NOT_FOUND`。另两套不受影响。

### 6.2 断言怎么组织

`selfcheck.mjs` 用 35 个编号分节，每节一个主题，`eq(name, got, want)` 内部 `JSON.stringify` 比对：

```js
// 17. 配置缺省值
eq('provider 缺省 anthropic_api', DEFAULT_WORKER_CONFIG.provider, 'anthropic_api')
```

失败时打印 `got` / `want` 两行，同时 `fail++`，结尾 `process.exit(fail ? 1 : 0)`。

### 6.3 分节清单（35 节 / 236 条）

| 节 | 主题 | 条数 |
|---|---|---|
| 1 | billing header：cch 归零、`cc_prompt_id` 固定 | 5 |
| 2 | `zero` 布局 | 3 |
| 3 | `identity` 布局 | 2 |
| 4 | `stock` 布局不注入 | 2 |
| 5 | betas：上游顺序优先，自定义追加 | 4 |
| 6 | cache TTL 优先级 | 3 |
| 7 | cache marker 只留最后一个 message 块 | 2 |
| 8 | thinking 块不挂 marker | 1 |
| 9 | 错误映射 | 6 |
| 10 | metadata 三级降级 | 2 |
| 11 | UA / stainless 头 | 4 |
| 12 | 帧协议（stdin 3 种 + stdout 7 种 + slotId） | 11 |
| 13 | `stop_reason` 映射（上游枚举到内部取值的固定对照） | 10 |
| 14 | `cancel` 帧第一字段是 `job_id` | 3 |
| 15 | `host_ready` 五项校验 | 4 |
| 16 | 身份生成的确定性 | 3 |
| 17 | 配置缺省值（上游 WorkerConfig 加载逻辑） | 10 |
| 18 | 线上实例样本校正（2026-10-23） | 4 |
| 19 | `mergeWireBody` 字段所有权 | 8 |
| 20 | `metadata.user_id` 硬约束（原样透传，不过滤） | 6 |
| 21 | Beta 动态注入（上游 25 条规则） | 16 |
| 22 | HTTP/2 指纹 | 5 |
| 23 | Codex 凭据 | 7 |
| 24 | Envelope 规范化 | 5 |
| 25 | Codex URL 与 UA 切割 | 6 |
| 26 | Codex 出站头（14 个逐条校验） | 12 |
| 27 | Codex body 改写 | 11 |
| 28 | 传输选择与 zstd 往返 | 5 |
| 29 | 账号调度：会话亲和无 TTL、首可用、失败不解绑 | 12 |
| 30 | 冷却：优先用上游 Retry-After | 16 |
| 31 | 三平台 persona 全部自洽 | 17 |
| 32 | macOS：两类历史异常特征必须被拦住 | 6 |
| 33 | Windows / Linux 各自的硬约束 | 3 |
| 34 | 硬件标识派生：同 vm 稳定、异 vm 互不关联 | 13 |
| 35 | 全平台：不同 vm_id 必须得到不同硬件标识 | 9 |

### 6.4 手工验证（补充手段）

`test/smoke-server.mjs` 已经把下面几项做成了自动断言（假 CLI 真被拉起、`job_start` 真的写进 stdin、SSE 帧序、进程收尾无孤儿）。这里保留手工命令，用于排查线上问题时快速定位。

**假 CLI 验证帧真的写进了 stdin** —— 排查「调度跑了但没发请求」的最快手段：

```bash
cat > /tmp/fakecli.sh <<'EOF'
#!/bin/sh
read line
echo "$line" > /tmp/cli-frame.txt
EOF
chmod +x /tmp/fakecli.sh

CLAUDE_BIN=/tmp/fakecli.sh node src/server.mjs --addr 127.0.0.1:18083 &
curl -X POST http://127.0.0.1:18083/v1/messages \
     -d '{"model":"m","messages":[{"role":"user","content":"hi"}]}'
cat /tmp/cli-frame.txt
```

**假 CLI 验证槽位耗尽** —— 这个假 CLI 会回 `host_ready` 但永不回 `job_done`：

```bash
cat > /tmp/fakecli2.sh <<'EOF'
#!/bin/sh
echo '{"type":"host_ready","protocol_version":2,"slots":20,"system_layout":"zero","timezone":"America/New_York","capabilities":["multi_slot","native_sse","stateless","ping"]}'
while read line; do :; done
EOF
chmod +x /tmp/fakecli2.sh

CLAUDE_BIN=/tmp/fakecli2.sh node src/server.mjs --addr 127.0.0.1:18085 &
# 21 个并发请求：前 20 个 200，第 21 个 503
for i in $(seq 1 21); do
  curl -s -o /dev/null -w "%{http_code} " -X POST http://127.0.0.1:18085/v1/messages \
       -d '{"model":"m","messages":[]}' &
done; wait
```

预期：`200 ×20` 然后一个 `503`。这同时验证了 §8.3 的「槽位不会自动回收」。

**persona 一致性检查**：

```bash
for p in macos windows linux; do
  node src/persona/cli.mjs --audit --platform $p --vm-id vm-01
done
# 三个都应输出「一致性检查通过」
```

---

## 7. 部署形态对比

| 维度 | 模式 A（TCP） | 模式 B（Unix socket） |
|---|---|---|
| 启动命令 | `node src/server.mjs [--addr H:P]` | `node src/server.mjs --gateway-worker --config cfg.json` |
| 入口鉴权 | 无 | `x-internal-token` 必填 |
| 槽位数 | 20 | 4 |
| 入站结构 | 裸 Anthropic Messages body | `Envelope`（`body` 字段内才是 Anthropic body） |
| 凭据检查 | 不做 | 每次请求都查 `credential_state` |
| 出站预处理 | 做（布局 → betas → cch） | 不做，原样转发 |
| 请求体上限 | 硬编码 64 MiB | `cfg.max_request_bytes` |
| 请求 id 来源 | 生成 UUID | 生成 UUID |
| session id 来源 | `x-session-id` 头 | `metadata.user_id` 里的 `session_id` |
| 调试路由 | 需 `EXPOSE_KERNEL_DEBUG_ROUTES=1` | 无 |
| Codex 路由 | 可选挂载（`--codex`） | **不可用**（与 `--gateway-worker` 互斥） |
| 适合场景 | 对外提供 API | 挂在 gateway 后面被调度 |

两种模式可以同时跑（不同端口 / 不同 socket），互不影响；但 Codex 通道只能挂在模式 A 上。

---

## 8. 已知限制

### 8.1 Codex 通道的 WS 传输未接

HTTP 路径已完整可用：凭据加载与校验、Envelope 规范化、出站头构造、body 改写、zstd 压缩、URL 拼装、真实 `fetch` 收发、SSE 事件解析、Chat ⇄ Responses 双向转换、账号调度（含亲和、冷却、RPM 滑窗）、失败换号。

**未接的部分**是 WebSocket 传输：

- `chooseTransport()` 会返回 `'prefer_websocket'`，但 `CodexUpstream` 只有 HTTP 路径，**回退到 HTTP 的逻辑不在 `chooseTransport` 里**——调用方拿到 `prefer_websocket` 也不会真的走 WS
- `responsesWsUrl()` 只负责算字符串，当前没有 WS 客户端消费它
- `WS_BODY_LIMIT`（15 MiB）这条门限因此暂时是"预留"语义

接 WS 时要注意：

1. `compressBody()` 的结果要配 `content-encoding: zstd` 发，两个必须成对
2. `zstdCompressSync` 只有 Node 22+ 有；低版本会退回「不压缩」，但头里仍写着 `zstd` —— 必须同时处理这个不一致
3. `buildOutboundBody()` 会原地改传入 `body` 的浅拷贝，调用方别指望原对象不变
4. 请求结束无论成败都要调 `AccountScheduler.release(accountId)`，否则 `max_concurrency` 会被永久占满。注意 `executeCodexRequest` **只在失败路径释放**，成功路径由调用方补（`codex-server.mjs` 的 `run()` 就是补这一刀）
5. 加载新账号列表后用 `setAccounts()`，它会把指向已移除账号的亲和、冷却、在途计数一起清掉

### 8.2 需要本地有官方 Claude Code CLI 可执行文件

`SlotScheduler` 构造时会立刻 `spawn(claudeBin, ['-p'])`，`claudeBin` 由 `resolveClaudeBin()` 按「配置文件 > `CLAUDE_BIN` > `claude`」解析（见 §2.3）。

| 场景 | 实际行为 |
|---|---|
| CLI 存在，正常输出 `host_ready` | 槽位可用，`ready_slots` 反映真实空闲数，`cli_started: true` |
| CLI 存在，但不输出 `host_ready` | `ready_slots` 仍按 phase 统计（全 idle = 满值），但 job 永远等不到 `job_done`，`cli_started: false` |
| CLI 不存在 / 无执行权限 / spawn 报 ENOENT、EACCES 等 | **进程不崩**：`CliHost` 绑定了 `child.on('error')`，把错误包成 `spawnError` 后 reject `ready`，`scheduler` 降级成无 CLI 模式。健康检查仍回 200，`cli_error` 带 `{code, bin, reason, message}` |
| CLI 存在但立刻退出 | `exit` 事件 reject `ready`，`cli_started: false`，`cli_error.code = 'ECLIEXIT'` |

`spawn` 的错误码会被映射成可读原因（`SPAWN_ERROR_REASONS`）：

| errno | reason |
|---|---|
| `ENOENT` | `file not found: bin path does not exist` |
| `EACCES` | `not runnable: file exists but has no execute permission` |
| `EPERM` | `not runnable: operation not permitted for this user` |
| `ENOEXEC` | `not runnable: file format is not an executable` |
| `ENOTDIR` | `bin path component is not a directory` |
| `ELOOP` | `bin path resolves through too many symbolic links` |
| `ENAMETOOLONG` | `bin path is too long` |

所以 CLI 装错时能直接从 `/status` 或 `/internal/health` 的 `cli_error.reason` 看出是路径问题还是权限问题，不用翻 stderr。降级模式的具体表现：

- `/healthz`、`/status`、`/internal/health` 照常 200，`healthy: true`
- `/v1/messages` 仍回 200，但响应体是 mock 串（见 §8.4）
- 模式 B 的凭据检查、鉴权照常生效

部署前检查：

```bash
which claude                                   # 或
CLAUDE_BIN=/path/to/claude node src/server.mjs
node src/server.mjs --addr 127.0.0.1:8080 &    # 起来后
curl -s http://127.0.0.1:8080/status           # 看 cli_started / cli_error
```

### 8.3 槽位不会自动回收

槽位只在收到 `job_done` / `job_error` / `cancel_ack` 帧时释放（`SlotScheduler._handleFrame` → `_release`）。如果 CLI 不回帧，槽位永久占着，20 个（模式 A）或 4 个（模式 B）用完后新请求一律 `503`。没有超时回收。

`request_timeout_seconds` / `idle_timeout_seconds` / `first_byte_timeout_seconds` 三个字段当前只做「必须为正数」的校验，没有任何计时器读它们。

### 8.4 响应内容是本地合成的

两条通道的 `/messages` 响应文本都是服务端拼出来的 mock 串（`sse.mjs` 只负责把它序列化成 SSE 或 JSON）：

- 模式 A：`mock response: <messages 里的文本> [tenant=demo, session=..., worker=sXX, generation=1]`
- 模式 B：`gateway-worker response: <messages JSON 前 80 字符>`

`usage` 固定 `input_tokens: 8` / `output_tokens: 38`。上游真实结果没有回填。这是当前最明显的待接点，不是 bug。

### 8.5 `prepareOutbound` 的 system 布局分支在模式 A 里不会触发

`prepareOutbound(body)` 调用时没传第二个参数，所以 `systemLayout` 是 `undefined`，`else if (systemLayout && ...)` 恒假。结果：

- 调用方 system 块 **≥ 4 个** → `wireSystemBlocks()` 会执行（cch 归零 + 规范化）
- 调用方 system 块 **< 4 个或不传** → 不做任何布局注入，原样透传

想让环境变量里的布局生效，得把那一行改成传 `{ systemLayout: getSystemLayout() }`。

### 8.6 `/internal/v1/cancel` 是空壳

恒返回 `{cancelled:false, ok:true}`。`SlotScheduler.cancel(jobId)` 本身是完整的（会改 phase 为 `cancelling` 并写 `cancel` 帧），但没有从 HTTP 到 `scheduler.cancel` 的接线。

### 8.7 其它小结

| 项 | 现状 |
|---|---|
| `/v1/chat/completions` | Claude 面没有这条路由；**Codex 面有**（`--codex` 启用后可用，见 §5.2） |
| `tokenFile` 变量（`buildGatewayWorkerServer`） | 计算了但从没用过，是死代码 |
| `Envelope.delivery_mode` / `cache_ttl` / `preserve_cache_breakpoints` / `request_context` | 解析出来了，没有消费者 |
| 多 worker | 只有单进程；`workers:1` 是硬编码字面量 |
| 日志 | 只有启动/警告那几行（启动、`claude_bin` 冲突、Codex 通道启用、凭据告警）；没有请求级日志 |
| `persona/` 与 HTTP 层 | persona 工具独立运行，`server.mjs` 不 import `persona/` |
| `AccountScheduler` 的 RPM 统计 | 用本地滑窗，只反映本实例发送量；多实例共享同一账号时数字偏小 |

---

## 附：接入检查清单

```text
[ ] Node 版本 >= 22（zstd 需要）
[ ] which claude 有输出，或显式设 CLAUDE_BIN / 配置 claude_bin
[ ] 模式 A：确认 --addr / KERNEL_ADDR，确认是否需要 EXPOSE_KERNEL_DEBUG_ROUTES=1
[ ] 模式 A：起来后看 /status 的 cli_started 与 cli_error
[ ] 模式 B：vm_id / internal_token / socket_path 三项齐全且非空
[ ] 模式 B：socket 父目录可写（内核会自己 mkdir，但 /run/guest 需要权限）
[ ] 模式 B：socket_path 不要带 tcp:// 之类前缀
[ ] anthropic_base_url 是 https 且 host 为 api.anthropic.com（否则改白名单）
[ ] provider 与 runtime_kind 分开确认，别指望一个带另一个
[ ] credential_path 指向的凭据文件存在，expiresAt 用毫秒且未过期
[ ] Codex：--codex-credential 或 CODEX_CREDENTIAL_PATH 指向凭据文件
[ ] Codex：凭据形态是 {"accounts":[...]} 或单账号；expires_at / rpm / max_concurrency 是数字不是字符串
[ ] Codex：codex_default_model 在 codex_models 清单里（否则启动失败）
[ ] Codex：codex_base_url 的 host 是 chatgpt.com（否则启动失败）
[ ] Codex：起来后打一次 /codex/healthz 确认有可用账号
[ ] 跑 test/run-all.mjs 全绿
[ ] persona 三平台 audit 全过
[ ] 起来后打一次 /healthz 或 /internal/health 确认进程存活
```
