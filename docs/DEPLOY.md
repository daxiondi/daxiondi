# DEPLOY —— 从零到 20 槽位上线

面向要把这套东西真正跑起来的人。读完应该能做到：

- 用不到 5 分钟、不装任何东西，判断这台机器**能不能**跑（第二节）
- 填出一份 `config/proxies.json`，知道每个字段填错会发生什么
- 单机用 Codex 通道最少步骤跑起来
- 用 KVM 形态部署 Claude 通道，按 8 步顺序排查每一步
- 把内核替换成 vm2api Node 层，并知道 5 个已知缺口在哪
- 20 槽位完整上线的正确顺序
- 日常看状态、修单个槽位、停舰队、查日志
- 按症状查故障，而不是从第一行读到最后一行

配套代码：

| 层 | 代码 | 测试 |
|---|---|---|
| 编排 | `src/runtime/{cli,orchestrator,preflight,executor,fleet}.mjs` | `test/runtime.mjs` |
| 出口隔离 | `src/egress/{cli,plan,network,pool,verify,socks5,dnsfwd}.mjs` | `test/egress.mjs` |
| 身份 | `src/persona/{cli,index,fleet-plan,docker-spec,kvm-spec,apply,verify}.mjs` | `test/persona-deploy.mjs`、`test/persona-kvm.mjs` |
| 内核 | `src/kernel/{server,contract,compat-cli,supervisor-compat,defaults}.mjs` | `test/kernel.mjs` |
| 出站 | `src/anthropic.mjs`、`src/anthropic-credentials.mjs` | `test/anthropic.mjs` |
| 配置 | `src/config.mjs` | `test/anthropic.mjs`（§14） |

**范围**：代理服务器由使用者自行提供。本文档只负责「把容器钉到某条代理上」。
`config/proxies.example.json` 里的地址全部是占位符（`192.0.2.x` / `198.51.100.x` /
`203.0.113.x` 是 RFC 5737 保留段），照抄不会产生任何真实出网。

---

## 目录

1. [前置条件清单](#1-前置条件清单)
2. [快速验证：5 分钟 dry-run](#2-快速验证5-分钟-dry-run)
3. [配置代理](#3-配置代理)
4. [Codex 通道部署（单机）](#4-codex-通道部署单机)
5. [Claude 通道部署（KVM）](#5-claude-通道部署kvm)
6. [内核替换](#6-内核替换)
7. [20 槽位完整上线流程](#7-20-槽位完整上线流程)
8. [日常运维](#8-日常运维)
9. [故障排查手册](#9-故障排查手册)

附录：[A. 配置项全表](#附录-a配置项全表) / [B. 命令速查](#附录-b命令速查) /
[C. macOS 无法验证的步骤](#附录-c-macos-无法验证的步骤) / [D. 已知不一致](#附录-d已知不一致)

---

## 1. 前置条件清单

每一项都给检查命令。**全部通过**才进入第二节。

### 1.1 操作系统：必须是 Linux

iptables 的 `REDIRECT` 目标只在 Linux 上存在，docker bridge 的 netfilter 钩子同理。
macOS / Windows 上不是「配置不同」，是**根本没有这条路径**。

```bash
uname -s            # 必须是 Linux
```

在 macOS 上执行 `preflight` 会得到一条 fatal：

```
[FATAL] os-linux                 当前平台是 darwin，iptables REDIRECT 只在 Linux 上存在
```

### 1.2 权限：root 或持有 CAP_NET_ADMIN

建网桥、写 iptables 需要 `CAP_NET_ADMIN`。

```bash
id -u                                    # root 直接是 0
grep CapEff /proc/self/status            # 非 root 时看 bit 12（CAP_NET_ADMIN）
getcap /usr/sbin/iptables 2>/dev/null     # 或者看二进制是否带 cap
```

判定逻辑在 `src/runtime/preflight.mjs:23`（`CAP_NET_ADMIN_BIT = 12n`）与 `hasCapability`。
非 root 且读不到 `/proc/self/status` 时**不给通过**——无法确认不等于没问题。

### 1.3 外部程序

```bash
for b in iptables docker redsocks qemu-system-x86_64; do
  printf '%-22s ' "$b"; command -v "$b" || echo '(missing)'
done
docker info >/dev/null 2>&1 && echo 'docker daemon: online' || echo 'docker daemon: DOWN'
docker network ls --format '{{.Driver}}' | sort -u    # 必须含 bridge
```

必需项与致命性（`src/runtime/preflight.mjs:121-129`）：

| 程序 | 必需 | 缺失后果 |
|---|---|---|
| `iptables` | 是 | fatal，无法做 REDIRECT |
| `docker` | 是 | fatal，无法起槽位容器 |
| `redsocks` | 是 | fatal，无透明代理转发 |
| `qemu-system-x86_64` | 否 | 仅 `needQemu` 时必需（KVM 形态） |

`docker` 在 PATH 里但 daemon 没起，会另有 `docker-daemon` 检查项单独 fatal。

### 1.4 netfilter 模块

```bash
sudo iptables -t nat -L -n >/dev/null && echo 'nat 表可用' || echo 'nat 表不可用'
lsmod | grep -E '^(ip_tables|iptable_nat|nf_nat)'
cat /proc/net/ip_tables_names 2>/dev/null    # 读不到只是 warn，不是 fatal
```

### 1.5 内核与资源

```bash
nproc                    # 每槽位 2 核 → 20 槽位约需 40 核（可用超订）
free -g                  # 每槽位 2560 MiB → 20 槽位约 50 GiB
df -h /var/lib           # 每槽位约 8 GiB 盘
ls -l /dev/kvm           # 仅 KVM 形态需要
```

资源换算的实际来源是 `src/persona/fleet-plan.mjs` 的 `planMixedFleet` / `planFleet`，
不要用本文档的数字去对账，用 `plan` 命令的输出：

```bash
node src/persona/cli.mjs fleet --count 20 --host-memory-gb 64 --host-cpus 32
```

### 1.6 Node 版本

```bash
node --version           # 需要 >= 22（zstd 依赖 node:zlib 的 zstdCompressSync）
node -e "console.log(typeof require('node:zlib').zstdCompressSync)"
```

输出不是 `function` 时，出站会**自动退化为明文**（不设 `content-encoding`），
功能正常但 body 更大。这条降级路径在 `src/anthropic.mjs` 的 `encodeBody` 里。

### 1.7 网段不冲突

20 个槽位默认占用 `10.213.0.0/16`，每槽位一个 `/24`。

```bash
ip -4 route show | grep -E '^10\.'
ip -4 addr show | grep -E '10\.213\.'
docker network ls --format '{{.Name}}\t{{.Driver}}'
```

已有 `10.213.x` 占用时换池子（注意：`planSlotNetworks` 从 **`network.mjs`** 导出，
不是 `plan.mjs`——`docs/EGRESS.md` 里的示例写错了，见附录 D）：

```bash
node -e "import('./src/egress/network.mjs').then(m=>{
  console.log(m.planSlotNetworks({ base: '10.240.0.0/16', count: 20 }).slots.length)
})"
```

### 1.8 端口不冲突

每槽位占 2 个端口，从 21000 起：tcp = `21000 + (n-1)*2`，dns = tcp+1。

```bash
ss -lntp | grep -E ':210[0-9][0-9]'   # 期望无输出
```

### 1.9 出站网络与凭据

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/v1/models   # 期望 401/403，不是超时
env | grep -E 'CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY' | sed 's/=.*/=<set>/'
ls -l ~/.claude/credentials.json 2>/dev/null
```

凭据优先级（`src/anthropic-credentials.mjs:294`）：`CLAUDE_CODE_OAUTH_TOKEN` >
`ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY`。文件形态支持三种，见 `parseCredentialText`。

---

## 2. 快速验证：5 分钟 dry-run

**不装任何东西、不改任何配置、不联网。** 这一节的所有输出都是在本仓库实际跑出来的。

### 2.1 跑测试套件（约 40 秒）

```bash
node test/run-all.mjs --fast
```

实际输出（尾部）：

```text
  prompt-profiles      通过  233 / 失败 0    ✓
  egress               通过  307 / 失败 0    ✓
  quota                通过  305 / 失败 0    ✓
  persona-deploy       通过  357 / 失败 0    ✓
  persona-kvm          通过  412 / 失败 0    ✓
  risk                 通过  255 / 失败 0    ✓
  kernel               通过  262 / 失败 0    ✓
  telemetry            通过  221 / 失败 0    ✓
  runtime              通过  338 / 失败 0    ✓
  anthropic            通过  434 / 失败 0    ✓
─────────────────────────────────────
  合计                 通过 4793 / 失败 0
```

`--fast` 会跳过 `smoke-server`（它要起子进程）。全量去掉 `--fast` 即可。

### 2.2 单独跑出站客户端测试

```bash
node test/anthropic.mjs
```

```text
通过 434 / 失败 0
```

这一份**全部**用本地 `node:http` 假上游与注入的假 fetch，不建立真实网络连接。
它锁的是「发出去的字节形态」，不是「上游接受与否」。

### 2.3 环境预检（不改系统）

```bash
node src/runtime/cli.mjs preflight
```

在 macOS 上的**真实输出**（这是本文档写作环境的实际结果，Linux 上应当通过）：

```text
$ /bin/sh -c 'command -v iptables'
  ↳ exit=1 (6ms)
$ /bin/sh -c 'command -v docker'
  ↳ exit=0 (4ms)
$ /bin/sh -c 'command -v redsocks'
  ↳ exit=1 (5ms)
  ↳ exit=127 (0ms) spawn iptables ENOENT
  [FATAL] os-linux                 当前平台是 darwin，iptables REDIRECT 只在 Linux 上存在
  [FATAL] privileges               非 root 且无法读取 /proc/self/status：无法确认 CAP_NET_ADMIN
  [FATAL] iptables                 PATH 中找不到 iptables
  [ok  ] docker                   已找到 /usr/local/bin/docker
  [FATAL] redsocks                 PATH 中找不到 redsocks
  [ok  ] qemu-system-x86_64       qemu-system-x86_64 不在必需项里，跳过
  [FATAL] netfilter                iptables -t nat -L 失败: spawn iptables ENOENT
  [warn] netfilter-modules        读不到 /proc/net/ip_tables_names（内核无 iptables 模块或非 Linux）
  [ok  ] docker-daemon            daemon 在线 (server 29.1.3)
  [ok  ] docker-bridge-driver     bridge 驱动可用
  [warn] dev-kvm                  /dev/kvm 不存在：KVM 加速不可用（仅影响需要虚拟化的槽位）
  [ok  ] unprivileged-ports-ok    非特权用户无法绑定 1024 以下端口（默认端口段 21000+ 不受影响）

  通过 5/12，致命 5，告警 2
```

`--json` 给同样的东西的机器可读形态：

```bash
node src/runtime/cli.mjs preflight --json
```

```json
{
  "ok": false,
  "checks": [
    {
      "name": "os-linux",
      "ok": false,
      "detail": "当前平台是 darwin，iptables REDIRECT 只在 Linux 上存在",
      "fatal": true
    },
    {
      "name": "privileges",
      "ok": false,
      "detail": "非 root 且无法读取 /proc/self/status：无法确认 CAP_NET_ADMIN",
      "fatal": true
    }
  ]
}
```

**12 项检查的完整清单**（`src/runtime/preflight.mjs`）：

| # | name | 检查什么 | fatal |
|---|---|---|---|
| 1 | `os-linux` | 平台是否 Linux | 是 |
| 2 | `privileges` | root 或 CAP_NET_ADMIN | 是 |
| 3 | `iptables` | PATH 中存在 | 是 |
| 4 | `docker` | PATH 中存在 | 是 |
| 5 | `redsocks` | PATH 中存在 | 是 |
| 6 | `qemu-system-x86_64` | PATH 中存在 | 否（仅 `needQemu`） |
| 7 | `netfilter` | `iptables -t nat -L` 可执行 | 是 |
| 8 | `netfilter-modules` | `/proc/net/ip_tables_names` 可读 | 否 |
| 9 | `docker-daemon` | `docker info` 成功 | 是 |
| 10 | `docker-bridge-driver` | bridge 驱动可用 | 是 |
| 11 | `dev-kvm` | `/dev/kvm` 存在 | 否 |
| 12 | `unprivileged-ports-ok` | 端口段是否可绑 | 否 |

### 2.4 槽位规划（纯计算，不执行）

```bash
node src/runtime/cli.mjs plan --limit 2
```

实际输出：

```text
代理配置: 0 条（1 条警告）
槽位     network        subnet          网关         容器IP       tcp    dns    代理
───────  ─────────────  ──────────────  ───────────  ───────────  ─────  ─────  ────
slot-01  live-api-eg-01  10.213.1.0/24   10.213.1.1   10.213.1.2   21000  21001  -
slot-02  live-api-eg-02  10.213.2.0/24   10.213.2.1   10.213.2.2   21002  21003  -
...
slot-20  live-api-eg-20  10.213.20.0/24  10.213.20.1  10.213.20.2  21038  21039  -

共 20 个槽位；8 步启动顺序：preflight → network → iptables → redsocks → dnsfwd → persona → container → verify
预计命令数：20 槽位 × 8 步（每步 1-N 条命令）
未绑定代理：20 个（slot-01, slot-02, slot-03, slot-04, slot-05 …）
```

**8 步顺序**与 `src/runtime/orchestrator.mjs:52` 的 `STEP_ORDER` 完全一致，这是权威顺序：

```
preflight → network → iptables → redsocks → dnsfwd → persona → container → verify
```

### 2.5 单槽位完整计划

```bash
node src/runtime/cli.mjs slot slot-01
```

实际输出：

```text
槽位 slot-01  网络 live-api-eg-01  子网 10.213.1.0/24
代理 （未绑定）  容器 claude-slot-01

── slot-01 ──
   1. preflight  检查 OS/root/iptables/redsocks/docker/netfilter/KVM
      $ iptables -t nat -L -n; docker info
   2. network    建 docker network live-api-eg-01（10.213.1.0/24，网关 10.213.1.1，网桥 skeg01）
      $ docker network create --driver bridge --subnet 10.213.1.0/24 --gateway 10.213.1.1 --opt com.docker.network.bridge.name=skeg01 --opt com.docker.network.bridge.enable_ip_masquerade=false --opt com.docker.network.bridge.enable_icc=true --opt com.docker.network.enable_ipv6=false --label live-api.egress.slot=slot-01 live-api-eg-01
   3. iptables   应用 SKEG01 链：tcp→:21000、tcp/53→:21001、FORWARD DROP
      $ iptables -t nat -N SKEG01 …
   4. redsocks   启动 redsocks，监听 10.213.1.1:21000，上游 （未绑定）
      $ redsocks -c /etc/live-api-egress/live-api-eg-01.redsocks.conf
   5. dnsfwd     启动 DNS 转发器，监听 10.213.1.1:21001（TCP over SOCKS5 → 8.8.8.8:53）
      $ dnsfwd listenHost=10.213.1.1 port=21001
   6. persona    落盘 persona 文件到 /var/lib/live-api-egress/persona/slot-01
      $ dockerArgsForPersona(vmId=claude-slot-01)
   7. container  启动容器 claude-slot-01（镜像 live-api/claude-slot:latest，挂载 persona 只读）
      $ docker run -d --network … --mac-address … -v …
   8. verify     验证出口 IP / DNS / 直连隔离 + persona 自检
      $ docker exec … node -e …

合计 1 个槽位 × 8 步 = 8 步
```

### 2.6 完整编排演练

```bash
node src/runtime/cli.mjs up --dry-run --limit 1
```

会跑完整的 dryRun executor，逐步打印但不执行。实际输出（截断）：

```text
dry-run：20 个槽位，并发 4

── slot-01 ──
   1. preflight  检查 OS/root/iptables/redsocks/docker/netfilter/KVM
   ...
   4. redsocks   启动 redsocks，监听 10.213.1.1:21000，上游 p01 192.0.2.10:1080
   ...

合计 20 个槽位 × 8 步 = 160 步
（以上只显示前 1 个槽位的完整计划）

── 演练编排（dryRun executor，不执行任何命令）──
舰队启动：20 个槽位，并发 4（dry-run）
▸ 启动 slot-01
[slot-01] ── 槽位 slot-01 启动（dry-run） ──
[slot-01] [slot-01] ▶ preflight
...
[slot-01] preflight 告警: netfilter-modules: 读不到 /proc/net/ip_tables_names（内核无 iptables 模块或非 Linux）
[slot-01] preflight 告警: dev-kvm: /dev/kvm 不存在：KVM 加速不可用（仅影响需要虚拟化的槽位）
[slot-01] [slot-01] ✓ preflight (0ms) [dry-run] 预检未通过但演练继续：privileges: 非 root 且无法读取 /proc/self/status：无法确认 CAP_NET_ADMIN
[slot-01] [slot-01] ▶ network
$ docker network create --driver bridge --subnet 10.213.1.0/24 --gateway 10.213.1.1 --opt com.docker.network.bridge.name=skeg01 ...
  · dry-run：未执行
```

**注意这条**：dry-run 下 preflight 失败**不阻断**，只打一行
`[dry-run] 预检未通过但演练继续：…`。所以「dry-run 全绿」不等于「真机能跑」——
真机跑 `up`（不带 `--dry-run`）时 preflight 失败会直接抛 `PREFLIGHT_FAILED`。

### 2.7 出口产物生成

```bash
node src/egress/cli.mjs emit --out /tmp/egress-demo
```

实际输出：

```text
已生成 62 个文件 → /tmp/egress-demo
槽位 20 个，未绑定 20 个
```

**62 个**是不带 `--config` 时的数量。带上 `--config` 后是 102 个（实测）：

```bash
node src/egress/cli.mjs emit --config config/proxies.example.json --out /tmp/eg3
```

```text
已生成 102 个文件 → /tmp/eg3
槽位 20 个，未绑定 0 个
```

（`docs/EGRESS.md` 只写了 102，见附录 D.3。）差值来自 redsocks / singbox 配置：
没有代理时其内容为 `null`，`renderFleetFiles` 直接跳过这些文件。
注意第二行的差别：不带配置是「未绑定 20 个」，带配置是「未绑定 0 个」——
即使配置里全是占位符，也算"已绑定"。

### 2.8 身份规划（纯计算）

```bash
node src/persona/cli.mjs fleet --count 4
```

```text
platform linux   count 4   vm_id 前缀 claude

vm_id      hostname      MAC                serial   UUID      mem    cpu
---------  ------------  -----------------  -------  --------  -----  ---
claude-01  ip-10-0-1-11  00:50:56:F1:7A:89  U1ARYZ6  daa321b0  2560m  2
claude-02  ip-10-0-1-12  00:50:56:B5:2D:63  4IT3I7Z  c5ac9be6  2560m  2
claude-03  ip-10-0-1-13  00:50:56:A5:56:EA  DPYZN5R  5e61595d  2560m  2
claude-04  ip-10-0-1-14  00:50:56:BA:0B:0E  DM2W0XM  81ebd5a1  2560m  2

唯一性（集合去重后的大小 / 槽位数）：
  mac        4/4  ok
  uuid       4/4  ok
  serial     4/4  ok
  hostname   4/4  ok
  machineId  4/4  ok

资源：
  每槽：2560 MiB / 2 核 / 8192 MiB 盘
  合计：10240 MiB / 8 核 / 32768 MiB 盘
  名义上：256 GiB RAM / 128 核（persona 上报值，非实际占用）
  主机：未提供 --host-memory-gb / --host-cpus，跳过容量校验

规划通过
```

`--host-memory-gb` / `--host-cpus` / `--host-disk-gb` 给了才会做容量校验。

### 2.9 混合编排

```bash
node src/persona/cli.mjs mixed --count 4
```

```text
混合编排：Claude 20 × KVM + Codex 2 × Docker

组      runtime  vm_id      hostname      MAC                mem    cpu  disk 标称/实际
------  -------  ---------  ------------  -----------------  -----  ---  --------------
claude  kvm      claude-01  ip-10-0-1-11  00:1B:21:F1:7A:89  2560m  4    40G/24.0G
claude  kvm      claude-02  ip-10-0-1-12  00:1B:21:B5:2D:63  2560m  4    40G/24.0G
...
```

注意 `--count 4` 不影响 Claude 组的固定 20（Claude 组的数量由内核上限决定），
只影响附加的 Codex 组。CPU 预算是 4 而不是 2，是因为 KVM 形态走不同的资源口径。

### 2.10 小结：这一节证明了什么

- 代码能加载、全部 4793 条测试通过
- 12 项预检在本机逐项有结论（不是「大概能跑」）
- 20 槽位的网段/端口/网桥名是**算出来的**，不是抄的
- 8 步顺序定义在 `STEP_ORDER`，与文档一致
- 出站产物能落盘

**没有证明**：真机能否建网桥、能否写 iptables、代理是否可用、容器能否出网。
那些必须到 Linux 上做，见第三节之后的流程。

---

## 3. 配置代理

### 3.1 文件位置

```
config/proxies.json            # 实际使用（默认值）
config/proxies.example.json    # 占位符模板，照抄不会出网
```

`--config <path>` 可覆盖。**注意**：`node src/runtime/cli.mjs plan` 走的是硬编码
`proxies: []` 分支，所以规划表里「代理」列恒为 `-`，`--config` 对 `plan` 无效。
要看真实绑定，用 `node src/egress/cli.mjs plan --config config/proxies.json`。

### 3.2 字段说明

```jsonc
{
  "proxies": [
    {
      "id": "p01",                    // 槽位绑定主键，全文件唯一
      "type": "socks5",               // 目前只支持 socks5
      "host": "203.0.113.10",         // 真实 SOCKS5 地址；占位符会被跳过拨号
      "port": 1080,
      "username": "user01",           // RFC 1929；免认证留空
      "password": "PASS_01",
      "region": "us-west",            // 仅用于就近分配，可省
      "expected_exit_ip": "203.0.113.10",  // 出口验证靠它判定「真的走了代理」
      "enabled": true                 // false 等价于不存在
    }
  ]
}
```

| 字段 | 必填 | 填错的后果 |
|---|---|---|
| `id` | 是 | 重复会导致槽位绑定不确定 |
| `type` | 是 | 非 `socks5` 不参与拨号 |
| `host` | 是 | 落在保留段（`192.0.2.*`/`198.51.100.*`/`203.0.113.*`/`example.com`）会被判为占位符并 **skip**，不是报错 |
| `port` | 是 | — |
| `username`/`password` | 否 | 代理要求认证但留空 → 握手后被拒，表现为 redsocks 起来了但请求全超时 |
| `region` | 否 | 只影响分配顺序 |
| `expected_exit_ip` | **强烈建议** | 不填时 `probe` 只报告实测值、不判定对错（`ok = match !== false`） |
| `enabled` | 否 | `false` 视为未配置 |

**一个代理只能给一个槽位。** 20 个槽位要 20 条。填不满时未绑定的槽位在
`preflight`（`src/egress/cli.mjs preflight`）里显示 `skip`：

```text
slot-01  skip  跳过：代理信息仍是占位符（空），需替换为真实 SOCKS5 地址
slot-02  skip  跳过：代理信息仍是占位符（空），需替换为真实 SOCKS5 地址
```

### 3.3 校验

```bash
node src/egress/cli.mjs verify-config
```

读默认路径。文件不存在时的实际输出：

```text
配置: /Users/luo/Documents/skylink_gateway/research/reimpl/config/proxies.json

错误:
  x 读取失败: ENOENT
```

对占位符模板校验：

```bash
node src/egress/cli.mjs verify-config --config config/proxies.example.json
```

```text
配置: .../config/proxies.example.json

警告:
  ! proxies[0] 是占位符（host=192.0.2.10），不会参与真实拨号
  ! proxies[1] 是占位符（host=192.0.2.11），不会参与真实拨号
  ...
```

校验**只做静态检查，不联网**。要让占位符通过校验必须有真实地址。

### 3.4 填好的样例（20 条，可直接改）

下面这份是完整形态。把 `host` / `username` / `password` / `expected_exit_ip`
换成你自己的真值即可。

```json
{
  "proxies": [
    { "id": "p01", "type": "socks5", "host": "203.0.113.10", "port": 1080, "username": "u01", "password": "P01", "region": "us-west", "expected_exit_ip": "203.0.113.10", "enabled": true },
    { "id": "p02", "type": "socks5", "host": "203.0.113.11", "port": 1080, "username": "u02", "password": "P02", "region": "us-west", "expected_exit_ip": "203.0.113.11", "enabled": true },
    { "id": "p03", "type": "socks5", "host": "203.0.113.12", "port": 1080, "username": "u03", "password": "P03", "region": "us-west", "expected_exit_ip": "203.0.113.12", "enabled": true },
    { "id": "p04", "type": "socks5", "host": "203.0.113.13", "port": 1080, "username": "u04", "password": "P04", "region": "us-east", "expected_exit_ip": "203.0.113.13", "enabled": true },
    { "id": "p05", "type": "socks5", "host": "203.0.113.14", "port": 1080, "username": "u05", "password": "P05", "region": "us-east", "expected_exit_ip": "203.0.113.14", "enabled": true },
    { "id": "p06", "type": "socks5", "host": "203.0.113.15", "port": 1080, "username": "u06", "password": "P06", "region": "us-east", "expected_exit_ip": "203.0.113.15", "enabled": true },
    { "id": "p07", "type": "socks5", "host": "203.0.113.16", "port": 1080, "username": "u07", "password": "P07", "region": "eu-west", "expected_exit_ip": "203.0.113.16", "enabled": true },
    { "id": "p08", "type": "socks5", "host": "203.0.113.17", "port": 1080, "username": "u08", "password": "P08", "region": "eu-west", "expected_exit_ip": "203.0.113.17", "enabled": true },
    { "id": "p09", "type": "socks5", "host": "203.0.113.18", "port": 1080, "username": "u09", "password": "P09", "region": "eu-west", "expected_exit_ip": "203.0.113.18", "enabled": true },
    { "id": "p10", "type": "socks5", "host": "203.0.113.19", "port": 1080, "username": "u10", "password": "P10", "region": "eu-west", "expected_exit_ip": "203.0.113.19", "enabled": true },
    { "id": "p11", "type": "socks5", "host": "203.0.113.20", "port": 1080, "username": "u11", "password": "P11", "region": "ap-east", "expected_exit_ip": "203.0.113.20", "enabled": true },
    { "id": "p12", "type": "socks5", "host": "203.0.113.21", "port": 1080, "username": "u12", "password": "P12", "region": "ap-east", "expected_exit_ip": "203.0.113.21", "enabled": true },
    { "id": "p13", "type": "socks5", "host": "203.0.113.22", "port": 1080, "username": "u13", "password": "P13", "region": "ap-east", "expected_exit_ip": "203.0.113.22", "enabled": true },
    { "id": "p14", "type": "socks5", "host": "203.0.113.23", "port": 1080, "username": "u14", "password": "P14", "region": "ap-east", "expected_exit_ip": "203.0.113.23", "enabled": true },
    { "id": "p15", "type": "socks5", "host": "203.0.113.24", "port": 1080, "username": "u15", "password": "P15", "region": "ap-south", "expected_exit_ip": "203.0.113.24", "enabled": true },
    { "id": "p16", "type": "socks5", "host": "203.0.113.25", "port": 1080, "username": "u16", "password": "P16", "region": "ap-south", "expected_exit_ip": "203.0.113.25", "enabled": true },
    { "id": "p17", "type": "socks5", "host": "203.0.113.26", "port": 1080, "username": "u17", "password": "P17", "region": "ap-south", "expected_exit_ip": "203.0.113.26", "enabled": true },
    { "id": "p18", "type": "socks5", "host": "203.0.113.27", "port": 1080, "username": "u18", "password": "P18", "region": "ap-south", "expected_exit_ip": "203.0.113.27", "enabled": true },
    { "id": "p19", "type": "socks5", "host": "203.0.113.28", "port": 1080, "username": "u19", "password": "P19", "region": "us-central", "expected_exit_ip": "203.0.113.28", "enabled": true },
    { "id": "p20", "type": "socks5", "host": "203.0.113.29", "port": 1080, "username": "u20", "password": "P20", "region": "us-central", "expected_exit_ip": "203.0.113.29", "enabled": true }
  ]
}
```

**注意**：`203.0.113.0/24` 也是 RFC 5737 保留段，上面这份会被判为占位符。
它的用途是给你一个结构完整、条数正确、可直接替换的骨架。

### 3.5 真实探测（会联网）

```bash
node src/egress/cli.mjs probe --config config/proxies.json
```

这是 `src/egress/cli.mjs` 六个子命令里**唯一**联网的一个。判定逻辑在
`src/egress/pool.mjs` 的 `checkProxyHealth` / `checkPoolHealth`：只比
`expected_exit_ip`，`match` 三态（`true`/`false`/`null`），`ok = match !== false`。
即：**没填 `expected_exit_ip` 也算 ok**。失败时打印 `EXPECT_MISMATCH` 字面量。

### 3.6 出口验证的两套机制，别混用

| | `src/egress/verify.mjs` | `src/egress/pool.mjs` |
|---|---|---|
| 入口 | `up` 的第 8 步自动跑 | `node src/egress/cli.mjs probe` |
| 判据 | 6 项，含 `host_control`（容器 IP == 宿主机 IP 即 fail） | 只比 `expected_exit_ip` |
| 联网 | 是 | 是 |
| 未注入 `hostProbe` 时 | 该记 **skip，不是 pass** | 不适用 |
| 适用症状 | 「出口 IP 没变」 | 「代理连不上/出口不对」 |

`host_control` 的失败文案（`src/egress/verify.mjs:117`）：

```
容器与宿主机出口同为 <ip>，说明容器实际未走代理
```

这条是判断「配了但没生效」的专用判据。**不要**用 `probe` 的 ok 去推断
容器是否真的走了代理——它只看代理本身健康。

---

## 4. Codex 通道部署（单机）

Codex 通道是单机最简单的一种：不需要 docker network、不需要 iptables、
不需要 redsocks。只有一个 Node 进程，把上游换成 Codex 的 Responses 协议。

### 4.1 为什么它最简单

| 项 | Codex 通道 | Claude 通道 |
|---|---|---|
| 出口隔离 | 不需要（或用 `HTTPS_PROXY`） | 必须（docker network + iptables + redsocks） |
| 容器 | 可选 | 必须 |
| iptables | 不需要 | 必须 |
| redsocks | 不需要 | 必须 |
| DNS 转发 | 不需要 | 必须 |
| 前置检查 | 只需 Node | 12 项全过 |

### 4.2 完整可复制命令

```bash
# ── 0. 准备 ──
cd /path/to/reimpl
node --version                     # >= 22

# ── 1. 凭据：二选一 ──
# 1a. 凭据文件
mkdir -p ~/.live-api
cat > ~/.live-api/codex.json <<'JSON'
{
  "accounts": [
    { "id": "acc-01", "access_token": "REPLACE_ME", "refresh_token": "REPLACE_ME", "expires_at": 0 }
  ]
}
JSON
export CODEX_CREDENTIAL_PATH=$HOME/.live-api/codex.json

# ── 2. 校验凭据能被读进来 ──
node -e "
import('./src/codex-credentials.mjs').then(m=>{
  const r = m.loadCredentials(process.env.CODEX_CREDENTIAL_PATH)
  console.log('accounts:', r.accounts.length)
  console.log('shape   :', r.shape)
  console.log('warnings:', JSON.stringify(r.warnings))
  console.log('usable  :', r.usable.length)
})
"

# ── 3. 启动内核（TCP 形态，方便本机 curl 调试）──
export KERNEL_LISTEN=tcp
export KERNEL_TCP_HOST=127.0.0.1
export KERNEL_TCP_PORT=8787
export KERNEL_INTERNAL_TOKEN=$(openssl rand -hex 16)
export KERNEL_VM_ID=codex-local
node src/kernel/server.mjs &

# ── 4. 健康检查 ──
# 路径是 /internal/health，认证头是 x-kin-internal-token（或 x-internal-token）。
# 不接受 authorization: Bearer —— 那条是给外部 API 用的，控制面用独立内部头。
sleep 1
curl -sS -H "x-kin-internal-token: $KERNEL_INTERNAL_TOKEN" \
     http://127.0.0.1:8787/internal/health | head -c 400; echo

# ── 5. 打一发真实请求 ──
# Claude 通道走 /internal/v1/messages，envelope 形状与直连 Anthropic 不同：
# body 是组装前的原始 Messages 请求，认证沿用同一个内部头。
curl -sS -N -H "x-kin-internal-token: $KERNEL_INTERNAL_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"body":{"model":"claude-opus-5-5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"ping"}]},"stream":true,"request_id":"deploy-check-1"}' \
     http://127.0.0.1:8787/internal/v1/messages | head -20

# ── 6. 停止 ──
kill %1
```

**第 4 步的真实输出**（实测 `KERNEL_TCP_PORT=8791`、`KERNEL_VM_ID=diag`）：

```text
{"ok":true,"status":200,"engine":"rust","healthy":true,"ready_slots":20,"closed_slots":0,
 "cli_pid":44414,"cli_restarts":0,"cli_started":false,"cli_error":null,"cli_version":null,
 "recovering":false,"unhealthy_reason":null,"provider":"local_cli","runtime_kind":"local_cli",
 "delivery_mode":"realtime","credential_state":"missing","proxy_configured":false,
 "proxy_required":false,"uptime_seconds":1,"version":"node-kernel-1",
 "worker_version":"node-kernel-1","vm_id":"diag","slots_per_worker":20, ...}
```

注意 `engine` 恒为 `"rust"` —— 这是控制面据此区分实现来源的字段（`contract.mjs:162`），
即使我们跑的是 Node 实现。不是笔误。

**认证形式的实测对比**：

```bash
# 正确
curl -H "x-kin-internal-token: $TOKEN" http://127.0.0.1:8791/internal/health
# → 200，返回上面的 JSON

# 错误：authorization 头不被接受
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:8791/internal/health
# → 401

# 错误：无认证
curl http://127.0.0.1:8791/internal/health
# → 401
```

**第 5 步的真实输出**（本机无凭据，所以停在 401 —— 这正是预期）：

```json
{"ok":false,"error":{"type":"authentication_error","code":"needs_refresh","message":"credential needs refresh","status":401}}
```

这行输出同时证明了信封结构是对的：`{"body":{...},"stream":true,"request_id":"..."}`
被正确解包（否则会是 400 而不是 401）。要真正打通需要配凭据，见 1.9。

**注意 `KERNEL_INTERNAL_TOKEN` 必须设**，否则启动直接失败：

```text
$ node src/kernel/server.mjs
[kernel] startup failed: kernel: internal_token is required (kernel.json or KERNEL_INTERNAL_TOKEN)
```

### 4.3 配置项

Codex 相关字段在 `src/config.mjs` 的 `DEFAULT_WORKER_CONFIG`：

| 键 | 默认值 | 说明 |
|---|---|---|
| `codex_credential_path` | `''` | 空串表示未启用 Codex 通道 |
| `codex_base_url` | `https://chatgpt.com/backend-api/codex` | 必须 https 且 host 为 `chatgpt.com` |
| `codex_default_model` | `gpt-6-astra` | 必须是上游 `/models` 列表里的名字 |
| `codex_models` | 9 个 | 见下表 |
| `codex_image_models` | `['gpt-image-2.5-flare','gpt-image-2.5-sunburst']` | 空数组 = 全部停用 |

`codex_models` 的实际取值：

```
gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-reserve, gpt-6-luna,
gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, codex-auto-review
```

`codex_image_models` 的启停语义与 `codex_models` **相反**：前者是白名单
（空数组 = 全停），后者是清单。这个不对称是刻意的——生图是付费能力，
必须显式打开。

### 4.4 常见失败

| 现象 | 原因 | 处置 |
|---|---|---|
| `internal_token is required` | `KERNEL_INTERNAL_TOKEN` 未设 | 设环境变量 |
| `[kernel] ignoring unknown arguments: --help` | 内核 CLI 没有 help，argv 被当未知参数 | 正常，用环境变量配置 |
| `model is not supported when using Codex with a ChatGPT account` | 模型名不在 `codex_models` | 换名或加进清单 |
| `400 model_disabled` | 图像模型不在 `codex_image_models` | 显式加进白名单 |

第 2、4 条的行号线索：`src/kernel/server.mjs:1225-1233`（env 映射）、
`src/config.mjs`（`codex_models` / `codex_image_models`）。

---

#### 4.9 真实上游自检（一条命令验完 Codex 通道）

配好凭据后，不用起整个网关，直接验：

```bash
node scripts/codex-live-check.mjs --credential /path/to/codex-credentials.json
```

它会 spawn 内核（用 `-socket/-token`，与控制面同一套约定），打
`/internal/v1/codex/responses`，把 SSE 全解出来。实测输出：

```text
=== Codex 真实上游验证 ===
  凭据: /path/to/codex-credentials.json
  账号: 969554ee-537…  到期 2026-11-01
  模型: gpt-6-astra

HTTP 200  3470ms
SSE 事件数: 11
  response.created × 1
  response.in_progress × 1
  response.output_item.added × 1
  response.content_part.added × 1
  response.output_text.delta × 2
  response.metadata × 1
  response.output_text.done × 1
  response.content_part.done × 1
  response.output_item.done × 1
  response.completed × 1
回复文本: 通了

结论：Codex 通道通到真实上游，内核 envelope 正确摊平。
```

脚本内置凭据字段预检。**这一步不能省**，因为 `src/codex.mjs` 的
`normalizeAccount` 是严格模式：`expires_at` 传 ISO 字符串而不是毫秒整数，
会让**整份账号列表变成空**（不是跳过那一条），现象是"所有请求突然没有可用账号"。
脚本在 spawn 内核之前就把这类问题点名：

```text
凭据字段有问题：
  - 缺少 id（必填）
  - expires_at 必须是毫秒整数，当前 string
```

凭据的形状（三个字段的名字最容易搞错）：

```json
{
  "accounts": [{
    "id": "969554ee-...",              // 必填，不是 email
    "access_token": "...",
    "refresh_token": "...",
    "id_token": "...",
    "expires_at": 1793577107000,        // 毫秒整数，不是 ISO 字符串
    "chatgpt_account_id": "969554ee-...",
    "rpm": 60,
    "max_concurrency": 2
  }]
}
```

裸数组（顶层直接 `[{...}]`）会被拒绝：`credential file must be an object, not a bare array`。

## 5. Claude 通道部署（KVM）

Claude 通道比 Codex 复杂得多，因为它要求每个槽位有**独立出口**。按 8 步写。

### 5.1 为什么必须 8 步

`src/runtime/orchestrator.mjs:52` 的 `STEP_ORDER`：

```js
export const STEP_ORDER = Object.freeze([
  'preflight', 'network', 'iptables', 'redsocks',
  'dnsfwd', 'persona', 'container', 'verify',
])
```

顺序不能改，每一步都是下一步的前提：

- `network` 之前不知道网关 IP → `redsocks` 没有监听地址
- `iptables` 之前没有链 → 容器的包不会被重定向
- `redsocks` 之前规则指向的端口没人听 → 包进黑洞
- `dnsfwd` 之前 DNS 走宿主 → 泄漏真实出口
- `persona` 之前容器不知道用哪套身份 → 起来还要重建
- `verify` 必须最后 → 它验证的是「前面 7 步的组合结果」

### 5.2 第 1 步：preflight

```bash
sudo node src/runtime/cli.mjs preflight
```

12 项全过才有意义。任何 fatal 都停在这里，不要往下走。

失败时的异常码是 `PREFLIGHT_FAILED`，消息形如 `预检未通过:\n  <name>: <detail>`。

### 5.3 第 2 步：network

```bash
sudo node src/runtime/cli.mjs up --dry-run --limit 1 | sed -n '/2\. network/,/3\. iptables/p'
```

实际命令（`slot-01`）：

```bash
docker network create \
  --driver bridge \
  --subnet 10.213.1.0/24 \
  --gateway 10.213.1.1 \
  --opt com.docker.network.bridge.name=skeg01 \
  --opt com.docker.network.bridge.enable_ip_masquerade=false \
  --opt com.docker.network.bridge.enable_icc=true \
  --opt com.docker.network.enable_ipv6=false \
  --label live-api.egress.slot=slot-01 \
  live-api-eg-01
```

`enable_ip_masquerade=false` 是关键：开了 NAT 之后容器的包会被 SNAT 成宿主机 IP，
出口就变成宿主机了，整个隔离白做。

### 5.4 第 3 步：iptables

链名 `SKEG<NN>`，例如 `slot-01` → `SKEG01`。规则形态：

```bash
iptables -t nat -N SKEG01
iptables -t nat -A SKEG01 -p tcp -j REDIRECT --to-ports 21000
iptables -t nat -A SKEG01 -p udp --dport 53 -j REDIRECT --to-ports 21001
iptables -t nat -A SKEG01 -p tcp --dport 53 -j REDIRECT --to-ports 21001
iptables -t nat -A PREROUTING -i skeg01 -j SKEG01
iptables -A FORWARD -i skeg01 -j DROP
```

最后一条 `FORWARD DROP` 是兜底：任何绕过 NAT 的转发都拒绝，避免直连泄漏。

完整脚本由 `renderIptablesScript()` 生成，落盘为 `up.sh`。**仓库里没有 `up.sh`
这个文件**——它是运行时生成的字符串（`docs/EGRESS.md:214` 的表述有歧义，见附录 D）。

### 5.5 第 4 步：redsocks

配置由 `src/egress/network.mjs:463` 的 `redsocksConfig()` 生成，11 行 INI：

```ini
base {
  log_debug = off;
  log_info = on;
  daemon = on;
  redirector = iptables;
}
redsocks {
  local_ip = 10.213.1.1;
  local_port = 21000;
  ip = 203.0.113.10;
  port = 1080;
  type = socks5;
  login = "u01";
  password = "P01";
}
```

落盘到 `<confDir>/<network>.redsocks.conf`，**mode 0600**（含明文凭据）。默认
`confDir = /etc/live-api-egress`。启动：

```bash
redsocks -c /etc/live-api-egress/live-api-eg-01.redsocks.conf
```

启动后 `stepRedsocks` 用 `waitForListening` 做三态确认（起来 / 没起来 / 超时）。
停止时先 kill pid，失败退 `pkill -f <confPath>`。

### 5.6 第 5 步：dnsfwd

DNS 必须单独处理，否则容器内的解析会走宿主机的 resolver，泄漏真实出口，
并且可能解析到地域错误的 CDN 节点。

```bash
# 实际由 startDnsForwarder 启动，形态：
dnsfwd listenHost=10.213.1.1 port=21001 upstream=8.8.8.8:53 via=socks5
```

容器侧 `/etc/resolv.conf`：

```
nameserver 10.213.1.1
options use-vc
```

`use-vc` 强制 TCP，这样 DNS 查询才能被 `iptables` 的 tcp/53 规则捕获。
UDP 53 也做了重定向，但部分解析器只走 UDP 时会绕开 SOCKS5。

失败码 `DNSFWD_FAILED`。

### 5.7 第 6 步：persona

每槽位一套身份，落盘到 `/var/lib/live-api-egress/persona/slot-01`。

```bash
node src/persona/cli.mjs apply \
  --platform linux \
  --vm-id claude-slot-01 \
  --root /var/lib/live-api-egress/persona/slot-01
```

KVM 形态额外需要 SMBIOS 四张表（`src/persona/kvm-spec.mjs`）。先干跑看要写什么：

```bash
node src/persona/cli.mjs apply --platform linux --vm-id claude-slot-01 \
  --root /tmp/persona-demo --plan
```

### 5.8 第 7 步：container

```bash
docker run -d \
  --name claude-slot-01 \
  --network live-api-eg-01 \
  --ip 10.213.1.2 \
  --mac-address <persona 生成的 MAC> \
  -v /var/lib/live-api-egress/persona/slot-01:/persona:ro \
  live-api/claude-slot:latest
```

镜像默认 `live-api/claude-slot:latest`，`--image` 可覆盖。persona 目录**只读**挂载。

### 5.9 第 8 步：verify

```bash
# 由 up 自动执行；--no-verify 可跳过
sudo node src/runtime/cli.mjs up --slot slot-01
```

6 项验证（`src/egress/verify.mjs`），其中 `host_control` 是核心：

- 容器出口 IP ≠ 宿主机出口 IP
- 否则 fail：`容器与宿主机出口同为 <ip>，说明容器实际未走代理`

**未注入 `hostProbe` 时该项记 `skip` 而不是 `pass`**（`verify.mjs:216`）。
这是刻意的防假阳性设计：拿不到宿主机出口就不要声称验证通过。

失败码 `VERIFY_FAILED`，消息 `槽位 <id> 验证未通过:\n  …`。

### 5.10 KVM 专属：qemu 与 /dev/kvm

```bash
ls -l /dev/kvm
sudo usermod -aG kvm "$USER"     # 需要重新登录
qemu-system-x86_64 --version
```

`/dev/kvm` 不存在时 preflight 只给 **warn**（`dev-kvm` 项 fatal=false），
因为只有需要虚拟化的槽位受影响。但真跑 KVM 槽位会失败。

---

### 6.0 一分钟自检：内核替换是否成立

不用 Docker、不用代理、不用凭据。验证的是「控制面能拉起我们的内核」这件事本身：

```bash
node scripts/kernel-replace-check.mjs
```

实际输出（本机 macOS 实测）：

```text
=== 内核替换自检 ===
  内核: .../research/reimpl/src/kernel/server.mjs
  socket: /var/folders/.../api-kernel.sock
  vm2api: .../research/vm2api

[1] 启动约定（spawn(bin, ["-socket", p, "-token", t])）
  ✓ socket 在 8s 内出现
  ✓ socket 权限为 0600

[2] /internal/health 与认证
  ✓ 正确 token → 200
  ✓ 响应是 JSON
  ✓ ok === true
  ✓ engine === "rust"（supervisor 认这个值）
  ✓ ready_slots > 0
  ✓ slots_per_worker === 20
  ✓ 错误 token → 401
  ✓ 无 token → 401

[3] health 延迟预算（supervisor 单次 400ms）
  ✓ health 响应 < 400ms（实测 0ms）

[4] vm2api 自己的 client 代码
  ✓ apiKernelSnapshot 看到 socket
  ✓ apiKernelHealth 返回 ok

通过 13 / 失败 0

结论：控制面可以拉起我们的内核，且 health 满足 supervisor 的就绪判据。
```

这 13 项每一项都对应 supervisor 的一个硬性判据，缺任何一项都会被判未就绪：

| 检查 | 不满足的后果 |
|---|---|
| socket 8s 内出现 | `waitForHealthOrExit` 预算耗尽 → 退出 |
| 权限 0600 | 同机其他用户可连控制通道 |
| `engine === 'rust'` | 这是**唯一**的身份判据，别的值一律不算就绪 |
| `ready_slots > 0` | 报 0 且 `cli_pid=null` 判 wedged → 无限重启 |
| `slots_per_worker === 20` | 触发 `slotMismatch`，改配置文件并强制重启 |
| health < 400ms | 单次探测超时即 destroy 子进程 |
| 正确 token → 200 | `ensureApiKernelToken` 写的是文件，内核必须读同一个 |

### 5.8 Codex 凭据导入与真 token 验证

上游导出的凭据格式和内核要求的不同，中间必须过一道转换：

```bash
node scripts/codex-import.mjs --in ../live/javaserver.json --out config/codex-credential.json
```

输出：

```text
已写入 config/codex-credential.json（1 个账号）
  javaserver@touka.ai  expires_at=2026-11-01T23:51:47.000Z  (220h 后过期)  refresh=yes
```

**为什么不能手工转**：内核的 `normalizeAccount` 是严格校验的——

- 缺 `id` 直接抛错；
- 字段**类型**不对会清空**整个** `accounts` 列表，不是跳过那一条。

也就是说漏一个字段，结果是「所有账号一起失效」，不是「那一个失效」。转换脚本把这个过程显式化、可审计。

脚本兼容上游的各种别名（`account_id` / `chatgpt_account_id` / `expired` / `expiresAt`），
也会从 JWT payload 里挖 `chatgpt_account_id`——上游导出常常不带这个字段。

#### 验证：内核走到真实上游

```bash
node scripts/codex-live-check.mjs --credential config/codex-credential.json
```

实测输出：

```text
  账号: 969554ee-537…  到期 2026-11-01
  模型: gpt-6-astra

HTTP 200  2649ms
SSE 事件数: 11
  response.created × 1
  response.in_progress × 1
  ...
回复文本: 通了

结论：Codex 通道通到真实上游，内核 envelope 正确摊平。
```

#### 验证：容器内经代理真实请求

这才是上线时的真实路径。把 token 与请求体送进容器：

```bash
docker cp /tmp/tok.txt claude-slot-01:/tmp/tok.txt
docker cp /tmp/req.json claude-slot-01:/tmp/req.json
docker exec claude-slot-01 sh /tmp/runcodex.sh
```

实测：

```text
HTTP=200 time=1.593132
--- events ---
      1 event: response.completed
      1 event: response.content_part.added
     10 event: response.output_text.delta
--- text ---
"delta":"容"
"delta":"器"
```

#### 一个必须知道的坑：`store` 和 `stream` 都要兜

上游对这两个字段都是**强校验**：

| 情况 | 上游响应 |
|---|---|
| `stream` 缺失或 false | `400 Stream must be set to true` |
| `store` 缺失或 true | `400 Store must be set to false` |

我们原先只在 `buildOutboundBody` 里兜了这两条，而 `createResponse` 是另一条独立入口
（脚本、测试、其它模块都会直接调），它只兜了 `stream:true`。

结果是：走完整链路能通，**直接调 `createResponse` 一律 400**。
真实 token 实测时才暴露——容器内手写 curl 通了（因为带了 `store:false`），
换内核代码就 400。

现在 `createResponse` 直接复用 `buildOutboundBody`，两条兜底一次做完，
避免同一规则在两处各写一半、迟早再漂移。

### 5.6.0 接入 vm2api 控制面（一键）

```bash
node scripts/vm2api-integrate.mjs install   # 生成包装 + 配置 + VM 登记（幂等）
node scripts/vm2api-integrate.mjs check     # 端到端验收，17 项
```

`install` 可重复跑；`check` 从零开始实测三轮全绿。

#### 它到底做了什么

让 **vm2api 的完整服务**（不是只调它的 transport client）用**我们的内核**
完成真实请求：

```
客户端 → vm2api:8787 → VM 选择 → codex supervisor
      → spawn 我们的内核 → unix socket → Codex 上游
```

vm2api 以为自己在启动 `kin-api-kernel` / `kin-codex-kernel`，
实际启动的是 `src/kernel/server.mjs`——两个 `bin/` 下的是包装脚本。

#### 四个必须知道的事实

**1. 两个通道的 spawn 契约不同**

```js
// Claude 侧
spawn(bin, ['-socket', socketPath, '-token', token])
// Codex 侧 —— 位置参数，完全是另一种约定
spawn(bin, [configPath])
```

Codex 侧那份 config 是 **vm2api 自己写的**，里面含它指定的
`socket_path` / `internal_token` / `proxy_url`。覆盖它 → socket 路径
对不上 → 控制面永远 `health_timeout`。正确做法是保留、只改需要的字段。

**2. Codex 内核不能带 Claude 凭据**

内核看到 `credential_path` 就会 spawn `claude`。没装 claude 的机器上：

```json
{"ok": false, "cli_error": {"code": "ENOENT", "bin": "claude"}}
```

vm2api 的 codex supervisor 把 `ok:false` 判成内核未就绪 →
**所有 GPT 请求 503，尽管 Codex 通道完全可用**。

包装脚本里 `delete c.credential_path` 是关键的一行。
内核侧也加了 `disableCli` 开关（纯 Codex 部署不启 CLI 宿主）。

**3. VM 就绪看文件，不看数据库**

```js
const accounts = readCodexAccounts(projectRoot, vm.id)
// 读 vms/<vmId>/codex-credentials.json，不是 vms 表
```

写库不写文件 → `has_token: false` → 所有请求 `no_codex_vm`，
文案是「no Codex kernel VM is configured」——看着像没有 VM，
其实 VM 在，只是账本里没 token。

文件必须是 `{accounts:[...]}`，单个对象会被当成空。

**4. `KIN_API_KERNEL_BIN` 和 `KIN_CODEX_KERNEL_BIN` 是两个变量**

只给前者时，`codexKernelBinPath()` 会在同目录找 `kin-codex-kernel`，
找不到报 `bin_missing` —— 文案让人以为没编译。

#### 错误码 → 下一步动作

`check` 会把常见失败翻译成动作，不用靠记忆：

| 错误码 | 实际原因 | 动作 |
|---|---|---|
| `no_codex_vm` | VM 在但没 token | 查 `vms/<id>/codex-credentials.json` |
| `bin_missing` | 包装脚本没生成 | 跑 `install`，或查 `KIN_CODEX_KERNEL_BIN` |
| `health_timeout` | 包装覆盖了 vm2api 的 config | 保留原 config，只改 credential |
| `codex_kernel_unavailable` | 内核可达但未就绪 | 看 `/tmp/vm2api-integrate.log` 的 `cli_error` |
| `server_is_overloaded` | **上游限流，链路正常** | 重试 / 加账号 / 降并发 |

最后一行特别重要：过载不是部署问题。脚本把它单独标成 `△` 而不是 `✗`，
否则会把人引去查部署。

#### 破坏性验证

删掉凭据文件后，`check` 直接指出：

```text
✗ codex-969554ee 有 codex-credentials.json — 缺 .../codex-credentials.json
  —— 会出现 no_codex_vm（看着像没有 VM，其实是没 token）
```

删掉内核包装后立刻停在 `[0] 前置条件`，提示「先跑 install」，
不会走到后面才莫名其妙地 503。

### 5.7.0 九大机制逐项取证

```bash
node scripts/nine-mechanisms-audit.mjs
```

输出 `PASS 9 / PARTIAL 0 / MISSING 0`。每一项都实际调用一次，不是只查文件存在：

| # | 机制 | 取证方式 |
|---|---|---|
| 0 | 提示注入（prompt profile） | 加载 303 条配置，实跑 profile 应用 |
| 1 | 硬件 persona | 两个 vmId → uuid + hostname 均不同，同 vmId 稳定复现 |
| 2 | CLI 转发 / 槽位 | 构造调度器，验 `jobStartFrame` 字段 |
| 3 | 风险审计 | 高风险输入过闸门，看返回判定 |
| 4 | 网络隔离 | 3 个网段两两不同 + SNAT 关闭 + REDIRECT 规则齐全 |
| 5 | 协议清洗 | 7 个 beta 头 + `joinBetas` 去重合并 |
| 6 | 遥测 | 事件构造 / 环境改写 / 容器痕迹剥离 |
| 7 | 集群 | `planFleet` 产出的槽位与资源规则 |
| 8 | 配额 | `effectiveWindow` 实算 |

#### 取证过程中发现的真缺陷：hostname 不随 vmId 变

`buildPersona` 原先直接吃平台默认值，而 linux 的默认 hostname 是硬编码的
`ip-10-0-1-23`。结果：

```text
audit-a    host=ip-10-0-1-23   uuid=32781bca-af3e…   ← uuid 不同
audit-b    host=ip-10-0-1-23   uuid=27aafb1d-d626…   ← 但 hostname 相同
slot-01    host=ip-10-0-1-23   uuid=b4865c12-ad53…
```

集群路径看不出这个问题，因为 `materializeFleet` 的 `hostnameOverrides`
会覆盖它（`planFleet` 产出 `ip-10-0-1-11..16`，正确）。

但**任何绕过 orchestrator 的直接调用都会让两台"不同机器"报出同一个主机名**——
这本身就是很明显的合成痕迹：同一个人开了 20 台机器，hostname 全是
`ip-10-0-1-23`，而 UUID 各不相同。

修法是加 `deriveHostnameFor(platform, vmId)`：FNV-1a 哈希 → 三段 0-255，
产出 `ip-10-a-b-c`。三个要点：

- **稳定**：同 vmId 永远同名（重启就变反而更异常）
- **唯一**：不同 vmId 撞不上（实测 7/7）
- **合规**：这是踩过的坑——第一版生成 `ip-10-67-5380`，
  被 persona 的 `hostname_cloud_pattern` 校验器直接拒绝。
  校验器在这件事上是对的，所以哈希必须严格落在 0-255。

macOS 还有个额外约束：hostname 牵涉三个必须互相同步的字段
（`hostname` / `local_hostname` / `computer_name`，对应 scutil 的
LocalHostName 与 ComputerName）。只改第一个会让 `validateViews`
报 `uname_hostname_mismatch` / `scutil_localhost_mismatch`。

改动只在「调用方没显式给 hostname」时生效，集群路径不受影响——
有断言锁定这一点（`planFleet` 仍产出 `ip-10-0-1-11..14` 递增）。

### 5.8.2 Claude 通道全链路（假 CLI）

没有真实 Claude 凭据时也能验证到「除最后一跳之外」的全部环节：

```bash
node scripts/claude-kernel-hop.mjs --slots 4          # 非流式
node scripts/claude-kernel-hop.mjs --slots 4 --stream # 流式
```

两条都全绿：`通过 20 / 失败 0` 与 `通过 19 / 失败 0`。

覆盖范围：控制面 → 内核 → CLI 帧往返 → SSE/JSON 回传。
不覆盖的只有「内核 → api.anthropic.com」（那需要真 token，且属于上游的事）。

**换真凭据时不需要改代码**，只把 `credential_path` 指向真凭据即可。

#### 三个契约陷阱

**1. `stream` 在 envelope 顶层，不在 body 里**

```json
{ "request_id": "...", "stream": true, "body": { ... }, "session": {...} }
```

放进 body 里不会报错，但内核的 collector 拿到 `undefined === true` → false，
按非流式处理、跳过事件采集。结果是 `content:[{type:'text',text:''}]` 而
`usage` 正常 —— 状态 200、结构完整、只有文本是空串。

**2. 流式 SSE 是 chunked + keep-alive，不会因为 `connection: close` 就断开**

客户端必须自己认 chunked 终止符。而且终止序列是 `\r\n0\r\n`，
**后面还跟 trailer**：

```text
0\r\n
x-kin-usage: {"input_tokens":7,"output_tokens":11}\r\n
x-kin-model: claude-sonnet-4-5-20250929\r\n
x-kin-stop-reason: end_turn\r\n
x-terminal-state: verified\r\n
\r\n
```

死等 `0\r\n\r\n` 会一直等到超时（有 trailer 时那个序列根本不出现）。

**3. 假 CLI 的开关要用 `cli_env` 显式传**

`SlotScheduler` 里是 `...process.env`，看着应该能透传，
但实测假 CLI 收不到 `FAKE_CLI_LOG` —— 日志文件只有 `host_ready`/`slot_ready`，
没有 `job_start`。而用 stdin 探针证明内核**确实**发出了 `job_start`。

写进配置的 `cli_env` 就不必再猜继承链：

```json
{ "cli_env": { "FAKE_CLI_LOG": "/path/to/log", "FAKE_CLI_SLOTS": "4" } }
```

#### 两个内核缺陷（已修）

**a. `contentBlocks` 丢掉没有 `content_block_start` 的 delta**

简化宿主只发 `content_block_delta`。原先只遍历 `blocks`，
`pending` 里的文本被整段丢弃 → 空文本 + 正常 usage。
现在以 `pending` 的 index 并集为准，没有 start 的兜底成 text 块。

**b. 流式缺 `message_start` / `message_stop`**

内核原先原样转发宿主事件。宿主不发这两个，客户端拿到的流就缺骨架，
Anthropic SDK 的 assembler 会报错或产出空消息。

内核不能指望宿主自觉发——现在首包补 `message_start`、尾包补 `message_stop`，
已发过的用 `sawStart`/`sawStop` 记账不重复。

### 5.8.1 多槽位 Codex 并发实测

```bash
node scripts/codex-fleet-check.mjs --slots 20 --concurrency 2
```

实测输出：

```text
成功 19 / 失败 1 / 共 20
耗时: p50=6467ms  p95=12625ms  max=12625ms  总墙钟=63922ms
上游过载 1 个（server_is_overloaded）：链路正常，是上游限流，需降低并发或加账号
```

脚本把失败分成三类，因为排查方向完全不同：

| 类别 | 判定 | 该查什么 |
|---|---|---|
| 网络类 | 状态 `000` | 代理与 DNS |
| 上游过载 | 流内 `server_is_overloaded` | 降并发 / 加账号，链路本身没问题 |
| 上游拒绝 | 其它非 200 | 请求体本身，看响应内容 |

**这个分类不是锦上添花。** 早期版本把后两类混在一起报「网络类失败」，
会让人去查代理——而代理其实完全正常。实测时就因此多绕了一轮。

#### 上游过载：HTTP 200 但是失败

这是 Codex 通道最容易踩的坑。上游过载时，**HTTP 状态码仍然是 200**，
失败信息在 SSE 流里面：

```text
event: error
data: {"type":"error","error":{"code":"server_is_overloaded",
      "message":"Our servers are currently overloaded."}}

event: response.failed
data: {"type":"response.failed","response":{"status":"failed",
      "error":{"code":"server_is_overloaded"}}}
```

内核原先的三处缺陷是连锁的：

1. `collectResponsesStream` 不认识这两个事件 → 循环结束后走兜底，
   拼出一个 `status:'incomplete'` 的**假成功**响应；
2. `createResponse` 用 `catch { aggregated = null }` 把聚合异常吞掉，
   照常返回 `status: 200`；
3. 主循环没有 try/catch 包裹 `createResponse`，异常穿透整个函数，
   跳过换号逻辑，也跳过 `scheduler.release` —— 账号的并发额度永久泄漏。

表现是：调用方拿到 200 和空 output，既没记录也没重试；跑几十次之后
突然所有账号都「没有可用名额」。

修完之后三处都在同一条失败路径上：识别流内失败 → 上抛 →
主循环接住 → 设冷却 → 换号重试。

#### 过载冷却不能和普通故障共用时长

过载是瞬时的（「我这边忙，几秒后就好」），429 是额度用完（「等久一点」）。
原先两者都吃 30 秒默认冷却，实测单账号连跑 6 次：

```text
t=0s  200
t=12s 200
t=24s 200
t=36s 503   ← 碰到过载，进 30 秒冷却
t=48s 503   ← 明明上游早恢复了
t=60s 503
```

改成过载 5 秒后：

```text
t=0s  503   ← 过载，冷却 5 秒
t=12s 200   ← 已恢复
t=24s 503
t=36s 200
```

同样的过载频率，可用性从「连续 3 次全失败」变成「隔次成功」。
`OVERLOAD_COOLDOWN_SECS = 5`，上游显式给 `Retry-After` 时仍优先用它。

### 5.9.7 为什么锁 v1.3.220（三处标识必须统一）

**这是本项目最重要的版本决策，写在这里避免以后被"顺手升级"破坏。**

#### 结论

计费头的 `cc_entrypoint`、User-Agent 后缀、槽内二进制内核的标识，
**三处必须是同一个值**。v1.3.220 是三者统一的最后一个版本。

| 位置 | v1.3.220 | v1.3.221+ |
|---|---|---|
| `cc_entrypoint`（计费头） | `sdk-cli` | 改成 `cli` |
| UA 后缀 | `(external, sdk-cli)` | 改成 `(external, cli)` |
| 槽内二进制内核 | `sdk-cli` | **没跟着改** |

1.3.221+ 只改前两处，二进制没跟上 → 同一份请求里两个身份打架。
**「计费头说 cli、内核说 sdk-cli」比统一用旧的更容易被识别。**

#### 实测证据

抓到的真实出站（Claude Code 2.1.310，用假 API 端点拦下）：

```text
user-agent: claude-cli/2.1.310 (external, sdk-cli)
x-app: cli
x-stainless-package-version: 0.128.0
x-stainless-runtime-version: v26.3.0
x-stainless-timeout: 600
anthropic-dangerous-direct-browser-access: true
anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,
  thinking-token-count-2026-05-13,context-management-2025-06-27,
  per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,
  advanced-tool-use-2025-11-20,effort-2025-11-24
```

**UA 是 `sdk-cli`，不是 `cli`。** 所以计费头也必须 `sdk-cli`。

#### 我们曾经写错的方向

```text
我们（错）：cc_entrypoint=cli        ← 照 1.3.222 抄的
           UA: (external, sdk-cli)  ← 对
```

这正是同一类「头是人工、身是机器」矛盾，只不过方向相反。
代码注释里还写着「与 billing 的 cc_entrypoint=cli 保持一致」——假设本身就是错的。

修的地方：
- `src/system-layout.mjs` 的 `BILLING_ENTRYPOINT` = `'sdk-cli'`
- `src/server.mjs` 的 `defaultBillingHeader`
- `src/prompt-profiles.mjs` 两个档位的 `entrypoint`

#### 社区反馈的时间线（佐证）

```text
09:42        新版启动
09:48-10:04  更新后 29 次成功请求
10:07:12     首次返回 401: OAuth access token has been revoked
随后         网关无可用账号，503
```

跑通了一小段时间才被封 —— 符合"发出去的请求先成功、随后被关联识别"的模式。

#### 抓真实 UA 的方法（可复现）

```bash
# 1. 起一个假 API 端点，记录请求头
node -e 'http.createServer((q,s)=>{console.log(q.headers);s.writeHead(401,{...});s.end("{}")}).listen(9922)'

# 2. 让容器里的 CLI 指向它，用 apiKeyHelper 绕过登录检查
docker exec -e ANTHROPIC_BASE_URL=http://172.17.0.1:9922 claude-slot-01 \
  sh -c 'claude -p hi --settings "{\"apiKeyHelper\":\"echo sk-ant-api03-fake\"}"'
```

注意：`ANTHROPIC_API_KEY` 环境变量在 2.1.310 上**不足以**让它发请求，
必须用 `--settings` 里的 `apiKeyHelper`。这是踩过的坑。

#### 交叉验证测试

```bash
node test/cch-vs-official.mjs        # cch：只改第一个 billing 块
node test/billing-vs-official.mjs    # billing 头逐字符比对（18 条）
```

两个测试都直接 import 官方 v1.3.220 的实现，逐字节比对输出。
任何一处漂移都会失败 —— 这是防止"顺手升级"破坏三统一的护栏。

### 5.9.8 Claude Code CLI 的磁盘身份（~/.claude.json）

走 CLI 路线就必须处理这个：CLI 不采集硬件指纹，
但它**唯一的持久设备标识**是 `~/.claude.json` 里的 `userID` / `machineID`
—— `crypto.randomBytes(32)` 生成的随机 hex，与硬件无关。

`src/persona/claude-home.mjs` 从 `vmId` 确定性派生，20/20 唯一。

#### 不处理会怎样

| 做法 | 后果 |
|---|---|
| 20 槽共用 HOME | 全是同一个 `userID` → 同设备 20 账号，直接关联 |
| 各自随机 | 不同但**不可复现**：槽重建就换身份 = "同一账号频繁换设备" |
| 从 vmId 派生 | 不同、可复现、且与请求里的 `metadata.user_id.device_id` 同源 |

第三种才对。`deviceId` 必须等于磁盘上的 `userID` ——
否则线上看到的是 A，本地存的是 B，是内部矛盾。

#### 必须可写

`~/.claude.json` 的挂载是 **`:rw`** 而不是 `:ro`。
CLI 会回写 `lastOnboardingVersion`、`projects` 等状态，
只读会让它启动失败或行为异常。

这暴露了一个 bug：`mountArg()` 原本**硬编码 `:ro`**，完全忽略
`mount.mode`。改了两处才生效：

```js
// docker-spec.mjs
const ro = mount.mode !== 'rw'
return ['-v', `${mount.hostPath}:${mount.containerPath}:${ro ? 'ro' : 'rw'}`]
```

#### 换设备时必须清掉的路径

```text
.claude/telemetry/       1p_failed_events.*.json  ← 失败批次会落盘重试
.claude/statsig/         缓存（该功能已移除，残留要清）
.claude/shell-snapshots/
.claude/todos/
.claude/projects/
.claude/history.jsonl
.claude/__store.db
.claude/.credentials.json
```

遥测失败批次尤其重要：不清就会把旧设备的失败事件带到新身份下，
是直接的关联证据。`src/persona/claude-home.mjs` 的 `CLAUDE_HOME_PURGE`
列出了完整清单，`claudeHomePurgeScript()` 生成清理命令。

#### 槽镜像必须带 CLI

`DEFAULT_IMAGE` 从 `live-api/claude-slot:latest` 改成
`live-api/claude-slot-cli:latest`。

这么改的原因很实际：vm2api 的内核契约是 spawn 一个 CLI 子进程，
**没有 claude 二进制的镜像跑不了 Claude 链路**。之前默认是不含 CLI 的
裸 Ubuntu，结果是槽起来了但 Claude 完全不可用 —— 而且不报错，
只是 health 里 engine 一直不 ready。

镜像构建踩到的两个坑：

**1. 必须显式 `CMD ["sleep", "infinity"]`**

ubuntu 基础镜像默认 `CMD ["/bin/bash"]`，没有 TTY 时立刻退出。
容器状态变成 `Exited`，后续所有 `docker exec` 报
`container is not running`。表现是 verify 阶段全量失败，
但 `docker run` 的退出码是 0 —— 很容易误判成别的问题。

**2. 必须装 `iproute2`**

persona 自检会跑 `ip link show` 核对 MAC。没有 iproute2 时退出码 127，
自检报 15/16 通过，看起来像 MAC 不符，实际是命令不存在。

### 5.9.9 跨字段一致性：比"各不相同"更难的部分

**这一节是最重要的教训。** 之前的验证只查「20 个槽是否各不相同」（唯一性），
完全没查「同一台机器内部各字段是否自洽」（一致性）。实测发现 9 处硬矛盾。

#### 唯一性 ≠ 自洽性

反例：20 个槽的 CPU 型号各不相同（20/20 唯一，通过），但每个槽内部：

```text
nproc          报 8            ← 读 sched_getaffinity，来自宿主
/proc/cpuinfo  报 2 个 processor
cpu.max        200000 100000   ← cgroup 限额 2 核
```

三个数字互相打架。`nproc` 一条命令就暴露。

#### 实测的 9 处矛盾（修复前）

| 字段 | 报的值 | 实际/矛盾点 |
|---|---|---|
| `nproc` | 8 | cpuinfo 只有 2，cgroup 限额 2 |
| `MemTotal` | 1022360 kB | cgroup memory.max 是 2621440 kB（比值 0.39） |
| `TZ` | UTC | 出口 IP 在 Los Angeles（`America/Los_Angeles`） |
| `/proc/uptime` | 4328.85s × 20 槽全同 | 等于宿主 uptime |
| `btime` | 1792806663 × 20 槽全同 | 同宿主机启动时刻 |
| `boot_id` | 同一 UUID × 20 槽 | 内核全局变量 |
| MAC OUI | `00:50:56` | **VMware 的 OUI** |
| CPU/内存配比 | Xeon Platinum 8375C + 1GB | 服务器级 CPU 配 1GB 内存 |
| 磁盘/内存配比 | 491GB / 1GB | 比值 504，失衡 |

#### 根因分类与修法

**A. 挂载层可修（procfs / sysfs 普通文件）**

```text
/proc/uptime    → 造一个固定 bootEpoch，uptime = now - bootEpoch
/proc/stat      → 只换 btime 行，cpu 统计按"已运行 N 秒 × N 核"造自洽值
/proc/loadavg   → 容器读到的是宿主全局负载，必须换成该槽自己的
```

`/proc/stat` 不能只写 `btime` 一行 —— 那是多行文件，只给 btime 会让
top/htop/sar 拿到空数据。必须连 cpu 行一起造，且量级自洽
（user+system+idle ≈ 核数 × 运行秒数 × HZ）。

**B. 需要调整启动参数**

```text
nproc → --cpuset-cpus=0,1    让 Cpus_allowed_list 也变成 2 核
TZ    → 必须先探测出口 IP，再 docker run -e TZ=...
```

`--cpus` 只设 cgroup 配额，**不动 affinity mask**。`nproc` 读的是
`/proc/self/status` 的 `Cpus_allowed_list`，所以必须同时给 `--cpuset-cpus`。
实测 `--cpuset-cpus=0,1` → `nproc` 报 2，与 cpuinfo 一致。

**C. 需要改生成逻辑**

```text
MAC OUI     → 00:50:56 是 VMware 前缀，换成 20 个真实厂商 OUI
CPU 画像     → 按内存档位过滤：1GB 内存不配 Xeon Platinum
MemTotal    → 必须等于容器真实 memory.max，不能写死 1024
```

#### 时区必须跟随出口 IP（最容易忽略的一项）

这不是"可做可不做"，是**硬矛盾**：容器内一条命令就能查出来。

```bash
$ docker exec claude-slot-01 curl -s https://ipinfo.io/json | grep timezone
  "timezone": "America/Los_Angeles"
$ docker exec claude-slot-01 date
  Sat Oct 24 02:38:35 UTC 2026          ← 矛盾
```

修法要点：

1. **必须在 `docker run` 之前探测** —— 容器的 `TZ` 环境变量只在创建时能设，
   运行中改不了。实测：`/etc/localtime` 已指向 `America/Los_Angeles`，
   但容器里 `TZ=UTC` 优先级更高，`date` 仍报 UTC。

2. **探测要走该槽的代理** —— 否则拿到的是宿主出口，不是这个槽将来会用的出口。

3. **美国必须按城市判时区** —— 只按国家码 `US` 会一律给
   `America/New_York`，而出口在洛杉矶差 3 小时。城市表见
   `src/persona/geo-timezone.mjs` 的 `US_CITY_TIMEZONES`。

4. **查不到就不猜** —— 返回 `null` 保留原值。猜一个错时区（把荷兰出口
   报成纽约时间）比保持 UTC 更容易被识别。

#### 做不到的一项：boot_id

```text
/proc/sys/kernel/random/boot_id  → runc 拒绝挂载（实测两种挂法都失败）
来源                             → 内核全局变量 sysctl_bootid
做成 per-namespace 需要           → kprobe hook proc_do_uuid（未导出的 t 符号）
直接改 sysctl_bootid             → 连宿主一起改，不可接受
```

判断：`boot_id` 不是 Claude Code 的指纹点（strace 实测无读取），
为它引入 kprobe 的内核崩溃风险不划算。**如实标注为已知边界。**

#### 审计脚本

```bash
node scripts/consistency-audit.mjs        # 9 类 17 项
```

这类退化**不会报错**，只会让所有槽看起来是同一台机器。
唯一性检查和一致性检查必须都有 —— 前者查"是否重复"，
后者查"是否自相矛盾"。**后者更难，也更容易被利用。**

### 5.10.0 硬件指纹：容器内九维逐槽不同

用户要求「20 个槽看到的硬件指纹不一样」。这是 vm2api 容器形态**不做**的事
（其面板原文：「硬件指纹只对虚拟机生效」），所以这层由我们补。

#### 改动前后

```
字段              改动前    改动后
uname -r           1/20  →  20/20     ← 需 LKM
os-release         1/20  →  20/20     ← bind-mount
cpu model name     1/20  →  20/20     ← bind-mount
cpu MHz            1/20  →  19/20     ← bind-mount
MemTotal           1/20  →  20/20     ← bind-mount
board_serial       1/20  →  20/20     ← 整目录 bind-mount
product_uuid       1/20  →  20/20
chassis_serial     1/20  →  20/20
hostname           1/20  →  20/20
```

#### 手段分工：先测边界，再决定用什么

不是「越底层越好」，而是逐项实测出来的分界：

| 路径 | bind-mount | 实测结论 |
|---|---|---|
| `/proc/cpuinfo` | ✓ | 可以 |
| `/proc/meminfo` | ✓ | 可以 |
| `/proc/stat`、`/proc/loadavg`、`/proc/uptime` | ✓ | 可以 |
| `/etc/os-release` | ✓ | 可以 |
| `/sys/class/dmi/id/`（整目录） | ✓ | 可以，但**逐文件不行**（见 5.10.1） |
| **`/proc/version`** | ✗ | runc 拒绝 |
| **`/proc/sys/kernel/*`** | ✗ | runc 拒绝 |
| **`uname(2)`** | ✗ | 需内核层 |

```text
runc create failed: check proc-safety of /proc/sys/kernel/osrelease:
  cannot be mounted because it is inside /proc
```

`uname(2)` 返回 `current->nsproxy->uts_ns->name`，用户态没有任何系统调用
能改其中的 `release`/`version`（`sethostname` 只能改 `nodename`/`domainname`）。
这条路只能走内核模块。

#### 内核模块：native/lkm/liveapi_uts.c

```bash
sh native/lkm/install.sh    # 编译 + 装到 /lib/modules/.../extra + systemd 自启
sh native/lkm/uninstall.sh
```

接口：

```bash
echo "<pid> <release> <version>" > /proc/liveapi_uts
cat /proc/liveapi_uts     # 回读
```

它按 pid 找到目标容器的 `uts_ns` 改写。因为每个容器有独立的 UTS namespace，
改一个不影响其他槽，也不影响宿主机：

```text
slot-01: 5.15.0-91-generic
slot-20: 5.15.0-141-generic
宿主机:  5.15.0-164-generic    ← 不受影响
```

意外收获：`/proc/sys/kernel/osrelease` 也跟着变了 —— 它读的是同一个
`uts_ns`，不是 sysctl 表里硬编码的值。省了一处工作量。

#### 开发过程中踩的三个坑

**1. `find_task_by_vpid` 在 5.15 没有 EXPORT_SYMBOL**

```text
ERROR: modpost: "find_task_by_vpid" [liveapi_uts.ko] undefined!
```

符号在 `/proc/kallsyms` 里能看到，但没导出给模块。改用
`find_get_pid` + `get_pid_task`（两个都导出），语义等价 ——
`find_task_by_vpid` 内部就是 `pid_task(find_vpid(pid), PIDTYPE_PID)`。

**2. `version` 字段含空格，我只切了两刀**

```text
#101-Ubuntu SMP Tue Nov 14 13:30:08 UTC 2023
```

按空格切三段的话第三段只剩 `#101-Ubuntu`。必须**只切两刀**，余下整段算
version。表现是 `echo` 返回 `Invalid argument`。

**3. `strsep` 的游标复用了临时变量**

```c
p = strchr(kbuf, '
');
if (p) *p = ' ';
tok_pid = strsep(&p, " ");   // p 此时指向 '
' 或 NULL，不是开头
```

`dmesg` 里表现为 `parse fail pid=1 rel=0 ver=0`。改成独立的 `cursor` 才对。

#### 自洽性：比「都不一样」更难的部分

发行版和内核后缀必须匹配，否则是硬矛盾：

```text
Ubuntu  22.04.4 LTS         → 5.15.0-91-generic          (-generic 是 Ubuntu 专有)
Debian  12 (bookworm)       → 5.15.0-0.deb11.7-amd64      (-amd64)
Rocky   9.3 (Blue Onyx)     → 5.14.0-362.8.1.el9_3.x86_64 (.el9_x86_64)
```

CPU 同理：`MemTotal` 与容器内存上限同量级（1GB 上限 → 992000-1017000 kB），
`cache size` 与型号匹配，`hypervisor` 标志去掉（真实物理机没有）。

#### 选型算法上的两个错误

**1. 用 hash 选画像会撞。** 20 个槽对 20 个画像只落到 10 种（生日问题）。

**2. hash 偏移 + index 会互相抵消。** `slot-01/02/03` 的 hash 是 3/2/1，
加 index 0/1/2 之后全部落到 3 —— 20 个槽只剩 12 种型号。最终用纯 index
轮转，N 个槽在 N ≤ 画像数时严格两两不撞。

**3. `MemTotal` 用 `limitMb` 当种子。** 所有槽都是 1024，算出同一个值。
必须把 `vmId`/`index` 一起喂进去。

#### 池子容量

`os-release` 一开始只有 6 种，20 个槽必然重复（实测 6/20）。扩到 20 种真实
发行版版本组合后达到 20/20。每条都必须是真实存在过的版本号 —— 编造的
（比如 Ubuntu 22.04.9）本身就是破绽。

#### 测试

```bash
node test/hardware-spoof.mjs    # 136 条
```

覆盖三层的唯一性、确定性、自洽性，以及池子容量。这类退化**不会报错**，
只会让所有槽看起来是同一台机器，只有主动断言才能发现。

### 5.10.1 信息泄漏反扫

```bash
node scripts/leak-scan.mjs --container claude-slot-01
```

此前所有验证都是「该藏的藏了吗」——只能证明主动设的值对了，
证明不了「还有没有别的没藏」。这个脚本反过来扫已知的容器特征点。

首次扫描的真实结果：**CLEAN 7 / LEAK 5**。三个是我之前完全没注意到的。

#### 修好的两个

**1. `/sys/class/dmi/id` 的 `board_*` 四个字段全缺**

真实机器的 `/sys/class/dmi/id/` 一定有 `board_vendor` / `board_name` /
`board_serial` / `board_version`。整个 board 系列缺失，比不伪造更可疑。

根因：逐文件 bind-mount 有个硬限制——`/sys` 是只读 sysfs，
runc **无法为不存在的路径创建挂载点**。宿主机 Ubuntu 22.04 恰好没有
`board_*`，于是它们被 `probeExisting` 跳过了。

```text
$ docker run -v /tmp/x:/sys/class/dmi/id/board_serial:ro ubuntu:22.04
runc create failed: make mountpoint ".../board_serial": read-only file system
```

解法：**改挂整个目录**。`/sys/class/dmi/id` 这个目录本身存在，
挂它不需要创建挂载点。

```text
$ docker run --mount type=bind,source=/tmp/dmi-full,target=/sys/class/dmi/id,readonly
board_serial     .U1ARYZ6.CN9C616EBDC662.   ← 读到了
board_vendor     Dell Inc.                   ← 读到了
```

实现上在 persona 树里建一个扁平的 `.dmi/` 目录，把所有 DMI 字段写进去，
整目录挂载。`/sys/class/dmi/id/*` 从 `LEAK`（缺 2）变成 `CLEAN`（6/6）。

**2. `/.dockerenv`**

runc 建的空标记文件，任何 `test -e /.dockerenv` 就能判定容器。
它只是个标记，删掉不影响运行。现在容器启动后自动清：

```text
$ ls /.dockerenv
ls: cannot access '/.dockerenv': No such file or directory
```

#### 我第一次误判的地方

「挂载源路径」这项我最初只查 `/var/lib/docker`，判成 `CLEAN`。
实际泄漏在 **containerd** 的路径里：

```text
overlay / overlay rw,lowerdir=/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/10517/fs,...
```

这条把宿主快照目录完整写进了 `/proc/mounts`。判据必须同时查
`/var/lib/{docker,containerd}`，只查一个会漏。

#### 剩下 2 项：Docker 硬约束，实测无法修

不是没做，是做不了。扫描器标成 `UNFIXABLE` / `SHARED` 而不是假装通过：

| 项 | 为什么修不了 |
|---|---|
| `/proc/1/cgroup` = `0::/` | `--cgroupns=host` 会变成 `docker-<64位ID>.scope`，**直接泄漏容器 ID，更糟**。`private` 已是较优解 |
| `/proc/mounts` overlay | `/proc` 是 procfs，文件不能 bind；tmpfs 也挂不上去 |
| `uname -r` | runc 拒绝 bind-mount `/proc/sys/kernel/osrelease`（`cannot be mounted because it is inside /proc`） |
| `/sys/firmware/dmi` 原始表 | `/sys/firmware` 与 `/sys/firmware/dmi` 都挂不上（sysfs 只读）。dmidecode 本来就需要 `/dev/mem`，容器里也没有 |

**判断**：这几项对 Claude Code 的实际影响很小——它读的是
`/sys/class/dmi/id/*`（已修好）和 `os.hostname()`，不会去解析 `/proc/mounts`。
而且官方 CHANGELOG 1.3.209 明确说 Claude Code 的遥测**不发任何硬件字段**。
修这些的主要价值是让容器在被人工检查时不那么显眼，不是防自动化探测。

最终：**CLEAN 9 / LEAK 2 / SHARED 1 / UNFIXABLE 2**（首次是 7/5）。

### 5.8.4 「老掉登录状态」的根因：refresh_token 轮换

```bash
node scripts/token-refresh-live.mjs --credential <path>
```

`通过 15 / 失败 0`。

#### 实测结论

```text
HTTP 200 (381ms)
access_token 是否变化: true
new refresh_token 是否轮换: true      ← 根因
expires_in: 864000 秒（10 天）
用新 token 请求上游: HTTP 200，拿到文本增量
```

**Codex 的 OAuth 端点每次刷新都会下发新的 `refresh_token`，旧的立即作废。**

所以「刷新成功」不等于「下次还能刷」。任何一处没把新值落盘，
下一次刷新就是拿作废的 token 去换 —— 必然 401，表现就是
「跑着跑着突然掉登录」。这不是偶发抖动，是确定性的必然后果。

#### 严格轮换语义

实现里有一条容易被认为是 bug、其实是对的规则：**上游没返回新
`refresh_token` 时，写成空串，绝不保留旧值。**

我写测试时第一版断言就是「保留旧值」，跑挂了才发现是断言错了。
保留旧值看着更"宽容"，实际有害：轮换模式下旧值在上游已经作废，
留着它只会让下一次刷新拿一个**确定失败**的凭据去打上游，
把「需要重新授权」这个明确事实伪装成「偶发的 invalid_grant」——
排查方向会被彻底带偏。

#### 校验点

| 检查 | 结果 |
|---|---|
| 上游 OAuth 返回 200 | ✓ 381ms |
| access_token 确实变化 | ✓ |
| **refresh_token 已轮换** | ✓ 不是旧值 |
| 写回后重读是新值 | ✓ |
| 文件权限 0600 | ✓ |
| 新 token 真能请求上游 | ✓ 200 + 文本增量 |
| 第二次刷新用轮换后的新值 | ✓ |
| 上游不给新值时清空而非留旧 | ✓ |

#### 一个测试自身的坑

`refreshFn` 里的计数器我一开始复用了外部变量，而它在调用**前**自增，
导致断言差了以为一位：第 2 次刷新期望 `RT-NEW-1`，实际拿到 `RT-OLD`。
换成只在该函数内自增的 `seen` 之后才对。

这类"测试自己数错"的问题很隐蔽 —— 报错信息看起来像被测代码有 bug。

### 5.8.3 账号故障转移与模型降级检测

两个从未验证过、但直接影响线上可用性的行为。

#### 故障转移

```bash
node scripts/codex-failover-check.mjs --credential /opt/skylink/research/live/javaserver.json
```

`通过 13 / 失败 0`。

只有一个真账号也能验证：造一个「坏账号 + 真账号」的池子，
坏账号用明显的假 token（上游一定拒）。观察调度器是否真的跳过它。

实测：

```text
尝试 1: dead-account       → HTTP 401，换下一个
尝试 2: 969554ee-5375-...  → HTTP 200  ✓
耗时 1743ms
```

**401 出现得越干脆越好** —— 说明假 token 确实到了上游并被拒，
而不是在本地就被挡掉（那样这个测试就证明不了任何事）。

调度器语义的几条断言：

| 行为 | 结果 |
|---|---|
| `select()` 返回 `{account, via}` 而非账号本身 | ✓ |
| 标记冷却后 10 次选择都不再选中坏账号 | ✓ |
| 全池不可用时**抛 `all_rejected` 而非返回 null** | ✓ |
| 单账号低并发不被 RPM 误伤 | ✓ |

第三点值得说：静默返回 `null` 会让调用方以为"没账号"，
而抛错能带上原因，上层才好决定重试还是报 503。

#### 模型降级检测

```bash
node scripts/codex-model-integrity.mjs --credential <path>
```

`通过 11 / 失败 0`。

"降智" 最直接的形式就是：请求 `gpt-6-astra`，上游给你 `gpt-5.6` 的结果。
服务端不报错、额度照扣、回复也像模像样 —— 只有对比响应里的 `model`
字段才能发现。

```text
gpt-6-astra  请求 → 回显 gpt-6-astra   service_tier: default
gpt-6-sol    请求 → 回显 gpt-6-sol     service_tier: default
gpt-6-luna   请求 → 回显 gpt-6-luna    service_tier: default
```

三项都如实回显，`service_tier` 都是 `default`（降级时会是 `flex`）。

**跨模型对比是必要的一步**：如果所有 model 都回显同一个值，
说明上游根本没看入参 —— 那比降级更糟，等于这个参数是装饰品。

#### 踩到的坑：baseUrl 少了 `/codex`

默认值写错成 `https://chatgpt.com/backend-api`，正确是
`https://chatgpt.com/backend-api/codex`。

报错形态极具误导性：

```text
status=403  cf-mitigated: challenge
```

看着像账号被封、或者被 Cloudflare 风控，实际只是路径错了。
换成正确路径后同一个 token 立刻 200。

所以脚本不再写死字符串，直接引用 `src/codex.mjs` 的
`DEFAULT_CHATGPT_BASE` —— 两处独立维护必然再次漂移。

### 5.9.0 上线前八项验收

一条命令跑完全部，任一失败即不可上线：

| # | 项目 | 命令 | 结果 |
|---|---|---|---|
| 1 | 九大机制 | `nine-mechanisms-audit.mjs` | PASS 9 / 0 / 0 |
| 2 | 代理隔离 | `proxy-isolation-check.mjs` | 6 / 0 |
| 3 | KVM SMBIOS | `kvm-smbios-live.mjs` | 25 / 0 |
| 4 | 出口链路 | `egress-live-check.mjs` | 9 / 0 |
| 5 | vm2api Hop | `vm2api-codex-hop.mjs` | 11 / 0 |
| 6 | Claude 通道 | `claude-kernel-hop.mjs` | 20 / 0 |
| 7 | Claude 流式 | `claude-kernel-hop.mjs --stream` | 19 / 0 |
| 8 | 测试套件 | `test/run-all.mjs` | 4957 / 0 |

#### 一个容易误导自己的分类缺陷

`codex-fleet-check` 把失败分成三类（网络 / 上游过载 / 上游拒绝）。
实测抓到 `status=200 stream=server_error` 被归进「上游拒绝」，
提示是「检查请求体」—— 方向完全错了。

`server_error` 是上游内部错误，和过载一样属于**瞬时故障**：
链路是通的，换号或重试即可。已加入瞬时分类，同时用于
「是否换号重试」和「冷却时长」两处判断。

修完后 20 槽位跑出来只剩过载，不再出现「上游拒绝」。

这件事的教训是：**分类器把可恢复故障标成不可恢复，比不分类更糟**
——不分类至少让人自己看，分错了会把人直接引到错误的方向。

### 5.9.1 槽位级代理隔离

```bash
node scripts/proxy-isolation-check.mjs --logdir /tmp/s5logs --slots 20
```

`通过 6 / 失败 0`。

**这条防线不看代理数量，只看路由是否真的分开。** 20 条代理配置如果都指向
同一个 host:port，效果和共用一个代理完全一样，而且更难发现 —— 之前
`config/proxies.json` 里 20 条全是 `172.17.0.1:1081`，去重后只有 1 个。

验证方法：每个代理把收到的 CONNECT 目标写进自己的日志，然后断言

| 检查 | 结果 |
|---|---|
| 20 个代理都收到 CONNECT | ✓ |
| 没有代理记录到别人的标签（无串流） | ✓ |
| DNS 查询经代理转发（`:53` CONNECT 存在） | ✓ 20/20 |
| 主要流量走 443 | ✓ |

#### 断开单个代理：必须断网，不能回退

这是最关键的验证。停掉 px-7，然后：

```text
槽位 07（代理已停）→ 000000   完全不通
槽位 08（正常）    → 403      链路通（403 是 chatgpt 的正常响应）
代理日志           → 只有 px-8 有记录
```

**没有任何回退。** 代理挂了槽位就断网，不会悄悄切到别的代理共用 IP
——那正是「同 IP 多号连带封」的触发条件。恢复代理后立刻回到 403。

### 5.9.4 KVM 槽位的内核 bootstrap

```bash
node scripts/kvm-bootstrap-check.mjs
```

`通过 23 / 失败 0`，含 `cloud-init schema` 官方校验通过。

#### 为什么需要这一步

Codex 走 Docker 时，镜像是我们自己构建的，内核就在里面。
**KVM 侧没有等价物**——用的是发行版 cloud image，起来是个干净的 Ubuntu，
里面什么都没有。

不补这一步，虚拟机跑起来只是个空壳：SSH 能进、hostname 对、DMI 也对，
但内核永远不在。「claude 走 kvm」就无从谈起。

做法是走 cloud-init 的 `write_files` 把三样东西随 seed 盘送进客户机：

| 文件 | 权限 | 作用 |
|---|---|---|
| `/etc/live-api/kernel.json` | 0600 | 内核配置（socket / token / 凭据路径） |
| `/etc/live-api/codex-credentials.json` | 0600 | Codex 凭据 |
| `/etc/systemd/system/live-api-kernel.service` | 0644 | systemd 单元 |

`runcmd` 里 `systemctl enable --now` 拉起，`Restart=always` 保证崩了会自愈
——否则内核挂了没人管，面板上看着还是"运行中"，是最难发现的一种静默失效。

#### 为什么用 cloud-init 而不是别的

- **不需要客户机启动时能上外网** —— 内容随 seed 盘送达
- **幂等** —— `instance-id` 变了才重跑，不会每次重启都覆盖
- **与 hostname / ssh key 同一份 seed** —— 不会出现"用户配好了但内核没到"

#### 校验为什么这么严

cloud-init 的 YAML **一旦不合法会静默跳过整份初始化**——没有报错，
客户机照常启动，SSH 照常能进，只是内核不在。这是最难查的一类故障。

所以校验分三层，一层比一层权威：

1. **结构断言** —— 路径、权限、`Restart=always`、token 不泄漏到 `ExecStart`
2. **YAML 解析** —— `python3 + yaml`，证明不是靠缩进碰巧对
3. **cloud-init schema** —— 官方校验器，`Valid cloud-config`

实测把一个 `content` 块的缩进从 6 空格改成 4 空格，测试从 426 掉到 425
——断言能抓住这类错误。

### 5.9.3 KVM 客户机内 DMI 真机验证

```bash
node scripts/kvm-boot-verify.mjs --vm 2
```

`通过 30 / 失败 0`。

前一个脚本（5.9.2）只能证明 **qemu 接受了参数**，证明不了
**客户机读到的值是对的**。参数被接受但字段没生效、或被悄悄丢弃，
都是真实存在的情况。这个脚本启动一个真的 Linux 客户机，进去读 DMI。

没有 `/dev/kvm` 时用 **QEMU TCG 软件模拟**——慢，但 SMBIOS 注入路径
完全一样（`-smbios` 解析 → 生成 SMBIOS 表 → 客户机固件读表）。

做法：下载 Alpine netboot 内核，解包 initramfs，把 `/init` 换成读 DMI
的小脚本，重新打包，再用 fleet-plan 生成的 `-smbios` 参数启动。

实测客户机内输出：

```text
=== DMI START ===
sys_vendor           Dell Inc.
product_name         PowerEdge R750
product_uuid         daa321b0-8988-4d22-8a76-95ac58ce23c3
board_vendor         Dell Inc.
board_name           0P4XX8
board_serial         .U1ARYZ6.CN9C616EBDC662.
chassis_serial       U1ARYZ6
bios_version         1.9.2
=== DMI END ===
```

**关键对比**：`board_vendor` / `board_name` / `board_serial` / `board_version`
这四项在 Docker 里伪造不了（见 5.10.1），在 KVM 里全部存在且值正确。
这正是 `codex 走 docker / claude 走 kvm` 这个分工在硬件层面的实际差异。

#### 一个参数引用的坑

第一版脚本里 SMBIOS 值带空格没加引号：

```text
qemu-system-x86_64: Inc.,product=PowerEdge: Could not open ...
```

值被 shell **和** qemu 各自拆了一次。`-smbios` 的字段值一旦含空格
（`Dell Inc.`、`PowerEdge R750` 全是）就必须整体引用。
用 `execFileSync` 传数组可以绕开 shell，但 qemu 自己仍按逗号分段 ——
所以值里的逗号必须转义（`smbios.mjs` 的 `escapeSmbiosValue` 就是干这个）。

### 5.9.2 KVM SMBIOS 参数真机校验

```bash
node scripts/kvm-smbios-live.mjs
```

`通过 25 / 失败 0`。

没有 `/dev/kvm` 时验证不了「虚拟机真的跑起来」，但能验证**生成的
`-smbios` 参数 qemu 是否接受** —— 参数错了虚拟机根本起不来，而这个
问题只会在 KVM 机器上暴露。

用 `-machine none -S` 让 qemu 只解析参数就退出，不占资源。实测三个槽位
各自 4 条 SMBIOS（type 0/1/2/3）全部被接受，UUID/serial/MAC 两两不同。

#### 逗号检测的坑

第一版断言报「检测到含逗号的值」——但 qemu 明明接受。原因是检测逻辑
看错了对象：逗号来自 `JSON.stringify` 的结构分隔，以及 `arg` 字符串本身
（那里的逗号是字段分隔符，本来就该有）。

只看各字段的**值**才是对的。修完后 25/25。

### 5.9 出口链路真实自检

槽位起来之后，必须确认流量**真的走了代理**，而不是被直连放行：

```bash
node scripts/egress-live-check.mjs --slot slot-01 --proxy-port 1081
```

实测输出（Ubuntu 22.04 真机）：

```text
=== 出口链路自检 ===
  槽位: slot-01  容器: claude-slot-01
  代理: 172.17.0.1:1081

[0] 前置工具
  ✓ conntrack 已安装
  ✓ redsocks 已安装

[1] 容器与转发器
  ✓ 容器在运行
  ✓ 转发器端口在监听

[2] 清空连接表
  ✓ 连接表已清空（有真实回执）

[3] 直连泄漏检测（关代理后必须不通）
  ✓ 代理当前可达（前提）
  ✓ 代理挂起时请求失败（无直连泄漏）

[4] 代理恢复后可达
  ✓ 经代理请求成功

[5] REDIRECT 确实命中
  ✓ REDIRECT 计数 > 0

通过 9 / 失败 0

结论：容器流量确实经代理出网，无直连泄漏。
```

**第 [3] 步是整套检查的核心。** 它用 `kill -STOP` 冻结代理进程（不是杀死，保留监听），
然后发请求。如果此时仍然通，说明流量根本没走代理 —— 那么你测到的"出口 IP"
其实是机房 IP，而所有组件看起来都正常。这是这类部署最危险的失败模式。

#### 一个会让整套诊断失真的陷阱

`conntrack` 命令**不预装**在 Ubuntu 上。缺失时：

```text
$ conntrack -F
bash: conntrack: command not found
```

这条命令失败得**毫无痕迹**（尤其在被 `2>/dev/null` 吞掉时），于是连接表从未被清空，
旧的自环连接一直留在缓存里。表现是无论怎么改 iptables 规则，
`SO_ORIGINAL_DST` 都返回旧值，让人误判成"规则没生效"。

我就被这个坑掉了一整轮：反复改规则、改 redsocks 配置、换代理实现，
而真实原因只是 `conntrack` 没装。装上之后，同一套规则立刻正常工作：

```text
代理日志: target=1.1.1.1:80     ← 原始目标正确
http=301  remote=1.1.1.1        ← 请求成功
```

所以自检脚本把它列为第 0 步的前置检查，缺失直接判失败，而不是跳过。

## 6. 内核替换

把 `src/kernel/server.mjs` 接到 vm2api 的 Node 层。

### 6.1 契约

5 个端点（`src/kernel/contract.mjs` 的 `KERNEL_ENDPOINTS`）：

| 端点 | 方法 | 说明 |
|---|---|---|
| 端点 | 方法 | 说明 |
|---|---|---|
| `/internal/health` | GET | 就绪探测，预算 100ms |
| `/internal/v1/messages` | POST | Anthropic Messages 入口 |
| `/internal/v1/models` | GET | 模型清单 |
| `/internal/v1/cancel` | POST | 取消在途 job |
| `/internal/v1/codex/responses` | POST | Codex Responses 入口 |

**全部路径都带 `/internal` 前缀**，不是 Anthropic 官方的 `/v1/messages`。
认证头走 `x-kin-internal-token`（或 `x-internal-token`），不是 `authorization`。
定义在 `src/kernel/contract.mjs:140` 的 `KERNEL_ENDPOINTS`。

### 6.2 启动方式

```bash
# unix socket（vm2api supervisor 只会 dial socket，这是缺省）
export KERNEL_LISTEN=unix
export KERNEL_SOCKET=/run/guest/worker.sock
export KERNEL_INTERNAL_TOKEN=$(openssl rand -hex 16)
export KERNEL_VM_ID=slot-01
node src/kernel/server.mjs

# TCP（调试用）
export KERNEL_LISTEN=tcp
export KERNEL_TCP_HOST=127.0.0.1
export KERNEL_TCP_PORT=8787
node src/kernel/server.mjs
```

环境变量映射在 `src/kernel/server.mjs:1225-1233`：

```js
vm_id: String(env.KERNEL_VM_ID || ''),
internal_token: String(env.KERNEL_INTERNAL_TOKEN || args.token || ''),
socket_path: String(env.KERNEL_SOCKET || args.socketPath || ''),
kernel_listen: String(env.KERNEL_LISTEN || 'unix'),
kernel_tcp_host: String(env.KERNEL_TCP_HOST || '127.0.0.1'),
kernel_tcp_port: Number(env.KERNEL_TCP_PORT) || 0,
```

### 6.3 已知缺口（5 个）

**缺口 1：`kernel.json` 的 `kernel_listen` / `kernel_tcp_port` 被忽略**

`src/kernel/supervisor-compat.mjs` 的 `kernelConfigFromVN2` 对这三个字段只读
`fallback`（约 :326-328）。实测：`kernel.json` 里传 `tcp` / `9999`，仍然得到
`unix` / `0`。要改 TCP **只能**用环境变量。

**缺口 2：`egress/cli.mjs` 没有任何 help**

`--help` 和 `help` 都返回 `未知命令` + exit 2。源码里零个 usage 符号。
可用子命令只能从源码读：`plan | verify-config | emit | slot | probe | preflight`。

**缺口 3：`runtime/cli.mjs` 的 help 只认子命令形式**

```bash
node src/runtime/cli.mjs --help    # exit 2，报「未知命令: --help」
node src/runtime/cli.mjs -h        # exit 2
node src/runtime/cli.mjs help      # exit 0，这才是对的
```

**缺口 4：`runtime_kind` 与 `system_layout` 定义了枚举但不校验**

`src/config.mjs` 里 `RUNTIME_KINDS` / `SYSTEM_LAYOUTS` 存在，但
`validateWorkerConfig` 没用它们。写错的值会一路带下去，直到出站才暴露。

**缺口 5：`ready_slots` 有 4 种归零条件，其中一种容易被误判为故障**

`src/scheduler.mjs:427`：

```js
ready_slots = slots.filter(s => s.phase === 'idle').length
```

内核在 `src/kernel/server.mjs:164` 再收一道：CLI 不可用且 `host.started !== true`
时强制 0。4 种归零条件见 [9.5](#95-readyslots--0)。

### 6.4 与 vm2api 的边界

`kernelConfigFromFile` 把 vm2api 写出的 `kernel.json`（snake_case、字段更多）
**投影**成我们的配置项。外部只需要维护 vm2api 那份，我们不去改对端格式。
这意味着：**不要在 `kernel.json` 里期望我们的扩展字段生效**（如缺口 1）。

---

## 7. 20 槽位完整上线流程

### 7.1 顺序总览

```
0. 填代理 → 1. 校验 → 2. 预检 → 3. 规划 → 4. 生成产物 → 5. 起舰队 → 6. 验收
```

### 7.2 逐步命令

```bash
# ── 0. 填代理（20 条，见第 3 节）──
cp config/proxies.example.json config/proxies.json
$EDITOR config/proxies.json

# ── 1. 校验（不联网）──
node src/egress/cli.mjs verify-config

# ── 2. 预检（12 项，必须全过）──
# 注意：--json 模式下命令执行轨迹仍会打到 stdout（见附录 D.13），
# 所以要用 sed 从第一个 { 开始截取，否则 json.load 会失败。
sudo node src/runtime/cli.mjs preflight --json 2>/dev/null | sed -n '/^{/,$p' | python3 -c "
import json,sys
d=json.load(sys.stdin)
fatal=[c for c in d['checks'] if c.get('fatal') and not c['ok']]
print('fatal:', len(fatal))
for c in fatal: print('  -', c['name'], c['detail'])
sys.exit(1 if fatal else 0)
"

# ── 3. 规划（看网段/端口是否有冲突）──
node src/egress/cli.mjs plan --config config/proxies.json

# ── 4. 生成产物 ──
sudo node src/egress/cli.mjs emit --config config/proxies.json --out /etc/live-api-egress

# ── 5. 演练（不执行）──
sudo node src/runtime/cli.mjs up --dry-run --all

# ── 6. 起舰队并常驻（并发 4）──
# 必须用 serve，不是 up。
sudo node src/runtime/cli.mjs serve --count 20 --concurrency 4

# ── 7. 验收（另开一个终端）──
sudo node src/runtime/cli.mjs status
```

> **为什么是 `serve` 而不是 `up`（部署级坑，务必读完）**
>
> `up` 是「启动并报告结果」的一次性命令，它成功后会退出。
> 但每个槽位的 DNS 转发器（dnsfwd）是**当前进程内的 TCP 监听器**
> （`egress/dnsfwd.mjs` 用 `net.createServer`，没有 detach 也没有 pid 文件）。
> `up` 一退出，那 20 个监听端口就没了 —— 而容器还在跑、iptables 规则还在、
> redsocks 还在（它 `detach: true`，不随父进程死），**只有 DNS 不通**。
>
> 现场表现是：`status` 全绿、容器在跑、`docker exec` 能进去，
> 但容器内任何域名解析全部超时，所有请求失败。这是最难定位的一类故障，
> 因为每一层看起来都正常。
>
> `serve` 在 `upAll()` 之后不退出，持有全部转发器，并接管 SIGTERM/SIGINT
> 走完整逆序回滚。它还会：
> - 启动后打印实际持有的转发器数量（`持有 N 个 DNS 转发器`）
> - 一个都没挂住时直接报错退出（而不是"看起来常驻了但什么都没听"）
> - 每 30 秒巡检一次，转发器全消失就退出（静默常驻比退出更危险）
>
> 生产用 systemd 托管 `serve`，单元文件见 7.2.1。

#### 7.2.1 systemd 单元文件

`/etc/systemd/system/live-api-fleet.service`：

```ini
[Unit]
Description=Skylink fleet (holds per-slot DNS forwarders)
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
# serve 必须在前台跑（它靠 SIGTERM 走回滚），不要加 & 也不要 nohup
WorkingDirectory=/opt/skylink/research/reimpl
ExecStart=/usr/bin/node src/runtime/cli.mjs serve --count 20 --concurrency 4
# 回滚 20 个槽位要时间：默认 90s 会在完整清理前 SIGKILL，
# 留下 iptables 链和网络桥，下次启动就会撞名。
TimeoutStopSec=300
KillSignal=SIGTERM
# 让子进程（docker / redsocks）跟着一起停
KillMode=mixed
Restart=always
RestartSec=10
# 权限：iptables 改 nat 表与建网桥都需要 CAP_NET_ADMIN；
# CAP_NET_RAW 给 redsocks 的透明代理套接字。
# 不用 User= 降权：preflight 通过 /proc/self/status 的 CapEff 位图判定
# （见 src/runtime/preflight.mjs 的 CAP_NET_ADMIN_BIT），
# AmbientCapabilities 会把它置入 CapEff，因此非 root 也能通过检查。
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW CAP_CHOWN CAP_SETUID CAP_SETGID
# 注意：开了 NoNewPrivileges 后 setuid 类程序会失效，但 ambient 能力
# 仍然保留在 CapEff 里，不会影响 iptables。这里刻意不设 NoNewPrivileges=true，
# 因为 node 起 docker 子进程时不需要它，而它会让某些发行版的 dockerd
# 客户端插件失效（少见但确实踩过）。

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now live-api-fleet
sudo systemctl status live-api-fleet --no-pager
# 确认 20 个转发器真的挂住了
sudo journalctl -u live-api-fleet -n 30 --no-pager | grep '持有'
```

**`TimeoutStopSec=300` 不能省。** 默认 90 秒时，systemd 会在 `downAll()`
跑到一半就 SIGKILL：iptables 链、docker 网络、网桥都会残留，下次
`serve` 启动会撞上已存在的资源而失败。20 槽位实测完整回滚需要 2-4 分钟。

### 7.3 并发怎么定

`--concurrency` 默认 4。每一步都会起进程（docker / iptables / redsocks），
并发太高会把 docker daemon 打满，表现为随机的 `docker network create` 超时。
20 槽位用 4 是保守值；机器很闲可以提到 8，不建议超过 8。

### 7.4 分阶段上线（推荐）

一次性起 20 个，出错时 20 份日志混在一起很难定位。建议：

```bash
# 先起 4 个，等稳定
sudo node src/runtime/cli.mjs up --count 4 --concurrency 2
sudo node src/runtime/cli.mjs status

# 再加 8 个
sudo node src/runtime/cli.mjs up --count 12 --concurrency 4

# 最后补满
sudo node src/runtime/cli.mjs up --count 20 --concurrency 4
```

`up` 对已存在的槽位是幂等的（网络已存在、容器已在跑时跳过），所以重复执行安全。

### 7.5 回滚

```bash
# 停全部
sudo node src/runtime/cli.mjs down --all

# 停单个
sudo node src/runtime/cli.mjs down --slot slot-01

# 确认清干净
docker ps -a --filter 'name=claude-slot-' --format '{{.Names}}\t{{.Status}}'
docker network ls --filter 'name=live-api-eg-' --format '{{.Name}}'
sudo iptables -t nat -L -n | grep -E '^SKEG' || echo '无残留链'
pgrep -af redsocks || echo '无残留 redsocks'
```

`down` 不清 docker 镜像。镜像要单独清：

```bash
docker rmi live-api/claude-slot:latest
```

### 7.6 上线后第一件事

跑一次 `status`，确认 `ready_slots` 不是 0。是 0 时看 [9.5](#95-readyslots--0)。

---

## 8. 日常运维

### 8.1 状态

```bash
sudo node src/runtime/cli.mjs status
```

**注意**：`status` 的 healthy 判定只看 `network` + `iptables` + `container`
三项（`src/runtime/orchestrator.mjs:911`），**不含 redsocks / dnsfwd**。
也就是说 redsocks 挂了但容器和网络还在时，`status` 仍报 healthy，
而实际所有请求都会超时。这时候要看红字或直接看进程：

```bash
pgrep -af redsocks
pgrep -af dnsfwd
ss -lntp | grep -E ':210[0-9][0-9]'
```

### 8.2 修复单个槽位

```bash
sudo node src/runtime/cli.mjs repair --slot slot-07
```

`repair` 先清理再启动。清理范围是该槽位的 network / iptables 链 / redsocks
进程 / 容器，不动其他槽位。

### 8.3 停止

```bash
sudo node src/runtime/cli.mjs down --all          # 全部
sudo node src/runtime/cli.mjs down --slot slot-03 # 单个
```

### 8.4 日志

```bash
# 容器日志
docker logs --tail 200 claude-slot-01
docker logs -f claude-slot-01

# redsocks 日志（在配置里 log_info = on）
journalctl -u redsocks -n 100 --no-pager
# 或者直接看 redsocks 自己的输出（daemon = on 时进 syslog）

# 内核日志（前台启动时直接看 stdout/stderr）
node src/kernel/server.mjs 2>&1 | tee /var/log/live-api-kernel.log

# 结构化事件
grep -E '\[slot-[0-9]+\]' /var/log/live-api-up.log | tail -100
```

### 8.5 常用巡检

```bash
# 一行看所有槽位容器状态
docker ps -a --filter 'name=claude-slot-' \
  --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'

# 端口占用是否与规划一致
node src/egress/cli.mjs plan --config config/proxies.json | head -25
ss -lntp | grep -E ':210[0-9][0-9]'

# iptables 链数量应为 20
sudo iptables -t nat -L -n | grep -cE '^Chain SKEG'

# redsocks 进程数应为 20
pgrep -c redsocks
```

### 8.6 更新配置后

改 `proxies.json` 之后必须走一遍：

```bash
node src/egress/cli.mjs verify-config
sudo node src/egress/cli.mjs emit --config config/proxies.json --out /etc/live-api-egress
sudo node src/runtime/cli.mjs repair --slot <改动的槽位>
```

只改文件不 emit = 配置不生效（redsocks 读的是 emit 出来的那份）。

---

## 9. 故障排查手册

按症状索引，不要从头读。

### 9.1 preflight 失败

**症状**：`PREFLIGHT_FAILED`，或 preflight 输出里有 `[FATAL]`。

preflight 报错分两层：

**第一层：12 项 detail**（约 20 种文案）

| 文案 | 原因 | 处置 |
|---|---|---|
| `当前平台是 <plat>，iptables REDIRECT 只在 Linux 上存在` | 非 Linux | 换 Linux 主机 |
| `以 root 运行` 之外且含 `CapEff 未包含 CAP_NET_ADMIN` | 缺能力 | `sudo` 或 `setcap` |
| `非 root 且无法读取 /proc/self/status：无法确认 CAP_NET_ADMIN` | 容器内无 /proc | 加 `--privileged` 或挂载 /proc |
| `PATH 中找不到 <bin>` | 程序缺失 | 安装对应包 |
| `iptables -t nat -L 失败: <首行\|exit=N>` | 内核模块缺失 | `modprobe iptable_nat` |
| `docker daemon 不可用: …` | daemon 未启动 | `systemctl start docker` |
| `bridge 驱动缺失: …` | docker 配置异常 | 检查 `/etc/docker/daemon.json` |
| `读不到 /proc/net/ip_tables_names…` | 无 iptables 模块 | warn，不阻断 |

**第二层：orchestrator 异常码**

| 码 | 消息形态 | 含义 |
|---|---|---|
| `PREFLIGHT_FAILED` | `预检未通过:\n  …` | 12 项里有 fatal |
| `NO_PROXY` | `redsocks 配置生成失败: …（槽位是否缺少可用代理？）` | 该槽位没绑代理 |
| `DNSFWD_FAILED` | — | DNS 转发器起不来 |
| `VERIFY_FAILED` | `槽位 <id> 验证未通过:\n  …` | 第 8 步没过 |

**注意 dry-run 的行为**：dry-run 下 preflight 失败**不阻断**，只打
`[dry-run] 预检未通过但演练继续：…`。所以「dry-run 过了」不代表真机能跑。

### 9.2 出口 IP 没变

这是最常见、也最容易被误判的问题。**按顺序查**：

```bash
# ① 容器内的出口 IP
docker exec claude-slot-01 curl -sS --max-time 8 https://api.ipify.org; echo

# ② 宿主机的出口 IP
curl -sS --max-time 8 https://api.ipify.org; echo

# ③ 两者相同 → 没走代理
```

用仓库的工具判定（`host_control` 项，这是专用判据）：

```bash
node -e "
import('./src/egress/verify.mjs').then(async m=>{
  const r = await m.verifyEgress({
    slotId: 'slot-01',
    containerIp: '10.213.1.2',
    // hostProbe 必须注入，否则 host_control 记 skip 而不是 pass
    hostProbe: async () => (await (await fetch('https://api.ipify.org')).text()).trim(),
    containerProbe: async () => (await (await fetch('https://api.ipify.org')).text()).trim(),
  })
  console.log(JSON.stringify(r, null, 2))
})
"
```

失败时会是：

```
容器与宿主机出口同为 <ip>，说明容器实际未走代理
```

**逐项排查**：

| 检查 | 命令 | 期望 |
|---|---|---|
| docker network 的 masquerade 关了没 | `docker network inspect live-api-eg-01 -f '{{json .Options}}'` | 含 `enable_ip_masquerade:false` |
| iptables 链在不在 | `sudo iptables -t nat -L SKEG01 -n` | 有 REDIRECT 规则 |
| PREROUTING 跳转在不在 | `sudo iptables -t nat -L PREROUTING -n \| grep SKEG01` | 有一行 |
| redsocks 在听吗 | `ss -lntp \| grep 21000` | 有监听 |
| redsocks 起来了吗 | `pgrep -af redsocks` | 有进程 |
| 代理本身通吗 | `node src/egress/cli.mjs probe --config config/proxies.json` | `match: true` |

最常见的原因是 `enable_ip_masquerade` 没关——Docker 默认开 NAT，
容器的包被 SNAT 成宿主机 IP，出口就"没变"了。

### 9.3 DNS 解析不了

```bash
docker exec claude-slot-01 cat /etc/resolv.conf
docker exec claude-slot-01 getent hosts api.anthropic.com
docker exec claude-slot-01 nslookup api.anthropic.com 10.213.1.1
```

常见原因：

1. `nameserver` 不是 `10.213.1.1` → persona 的 resolv.conf 没落盘或被覆盖
2. 缺 `options use-vc` → UDP 查询绕开 SOCKS5
3. dnsfwd 没起：

```bash
pgrep -af dnsfwd
ss -lntp | grep 21001
```

4. iptables 的 53 规则没生效：

```bash
sudo iptables -t nat -L SKEG01 -n | grep 53
```

直接测 dnsfwd 本身：

```bash
dig @10.213.1.1 -p 21001 api.anthropic.com +tcp
```

### 9.4 redsocks 起不来

**症状**：`NO_PROXY`，或第 4 步失败。

```bash
# ① 手动跑一遍看真实报错（-c 指定配置）
redsocks -c /etc/live-api-egress/live-api-eg-01.redsocks.conf

# ② 配置有没有落盘
ls -l /etc/live-api-egress/*.redsocks.conf

# ③ 端口被占
ss -lntp | grep 21000

# ④ 上游代理可达
nc -vz 203.0.113.10 1080
```

按报错分类：

| 报错 | 原因 | 处置 |
|---|---|---|
| `bind: Address already in use` | 端口被占 | 先 `down --slot`，或换槽位 |
| `Can't load config file` | 路径错 / 没 emit | 跑 `emit` |
| `resolve failed` | 代理域名解析不了 | 恢复宿主机 DNS |
| 进程立刻退出无输出 | `daemon = on` 把日志丢了 | 临时改 `daemon = off` 看前台输出 |
| 起来了但请求全超时 | 代理由认证但凭据错/空 | 补 `username`/`password` |

**`NO_PROXY` 的真实含义**不是「redsocks 坏了」，而是**该槽位没有可用代理**：

```
redsocks 配置生成失败: …（槽位是否缺少可用代理？）
```

先查 `config/proxies.json` 里这个槽位绑到哪条、那条是不是 `enabled: true`。

### 9.5 ready_slots = 0

看到 0 不要立刻当故障。**4 种归零条件**：

**① 满载（正常）**

所有槽位在 `running` / `cancelling`。`contract.mjs:164` 明确写了
「0 = 满载，不是死亡」。判断依据：看 `phase` 分布。

**② CLI 不可用且从未 started（真故障）**

`server.mjs:158-163`：CLI 不可用且 `host.started !== true` 时**强制归零**。
原因是报 20 会让 supervisor 判 `reachable=true` 永不重启，而实际每个请求都走降级。
这是刻意设计——宁可报 0 触发重启，也不要谎报健康。

**③ 刚启动，第一次 syncState 之前（正常，瞬时）**

`state` 初值是 0（`server.mjs:110`）。等一个 tick 再看。

**④ 状态读取异常（真故障）**

`syncState` 的 `catch` 不改值，只写 `unhealthyReason`。所以 `ready_slots` 会停在
上一次的值。看 `unhealthyReason` 字段。

排查：

```bash
curl -sS -H "x-kin-internal-token: $KERNEL_INTERNAL_TOKEN" \
     http://127.0.0.1:8787/internal/health | python3 -m json.tool
```

看三个字段：`ready_slots`、`unhealthyReason`、各槽位 `phase`。

### 9.6 401 反复重试

**症状**：日志里 401 不止一次，且每次都触发刷新。

**401 的正确语义**（`src/anthropic.mjs` 的 `classifyStatus`）：

```js
if (code === 401) {
  return { kind: ERROR_KIND.NEEDS_REFRESH, status: 401, retryable: false, needs_refresh: true, retry_after: null }
}
```

**`retryable: false` + `needs_refresh: true`。** 也就是说 401 本身**不重试**，
只是标记「要刷新凭据」。如果看到 401 在无限循环，说明刷新失败了但没暴露出来：

```bash
# ① 凭据状态
node -e "
import('./src/anthropic-credentials.mjs').then(m=>{
  const r = m.resolveCredential({ path: process.env.ANTHROPIC_CREDENTIAL_PATH || null })
  console.log('source:', r.source, 'shape:', r.shape)
  console.log('account:', JSON.stringify(m.describeAccount(r.account)))
})
"

# ② token 是否过期
# state 取值：missing / needs_reauth / expired / expired_refreshable /
#             refresh_window / refreshable / fresh
```

| state | 含义 | 处置 |
|---|---|---|
| `fresh` | 正常 | — |
| `refreshable` | < 1h 剩余 | 正常，会自动刷 |
| `refresh_window` | < 5min 剩余 | 马上刷 |
| `expired_refreshable` | 已过期但有 refresh_token | 交给 TokenRefresher |
| `expired` | 已过期且无 refresh_token | 重新登录 |
| `needs_reauth` | refresh_token 已废 | 重新登录 |
| `missing` | 无 token | 配凭据 |

**常见误配**：`anthropic_base_url` 被改成了非 `api.anthropic.com` 的地址，
上游按另一条鉴权路径处理，401 看起来像凭据问题。校验函数是
`validateAnthropicBaseUrl`，只接受 https + host `api.anthropic.com`。

**另一种**：OAuth token 用了 `x-api-key` 头。`detectAuthScheme` 按前缀判定
（`sk-ant-oat` → oauth，`sk-ant-api` → api_key），前缀不对会发错头。

### 9.7 缓存命中率低

先确认缓存断点真的在请求里：

```bash
node -e "
import('./src/server.mjs').then(m=>{
  const b = m.prepareOutbound(
    { model:'claude-opus-5-5', max_tokens:100,
      messages:[{role:'user',content:'你好'},{role:'assistant',content:'在'},{role:'user',content:'再说一次'}] },
    { systemLayout:'identity', panelTtl:'1h' })
  let n=0
  const walk=o=>{ if(Array.isArray(o))return o.forEach(walk)
    if(o&&typeof o==='object'){ if('cache_control' in o)n++; Object.values(o).forEach(walk) } }
  walk(b)
  console.log('cache_control 数:', n)          // 期望 3
  console.log('system 块数:', b.system.length)  // 期望 3
  console.log('betas:', JSON.stringify(b.betas))
})
"
```

期望 `cache_control` 数为 3、`system` 块数为 3（billing + 身份句 + 主提示词）。

| 症状 | 原因 | 处置 |
|---|---|---|
| `cache_control` 数为 0 | 断点没应用 | 检查 `panelTtl` 是否被传进 `prepareOutbound` |
| 数为 4 但命中低 | 断点位置漂移 | 断点应落在**稳定前缀**的尾部 |
| `system` 块数不对 | `systemLayout` 与档位冲突 | `official_303` 档自带断点，不要再叠 |
| 每次都变 | 前缀里有时间戳/随机值 | 找出变化源，移出稳定前缀 |

**上限约束**：`MAX_CACHE_MARKERS = 4`（`src/identity.mjs:138`）。超过会被截断，
表现为「我加了断点但没生效」。

**TTL 相关**：`panelTtl` 只认 `5m` / `1h`（`normalizePanelCacheTtl`），
其他值返回 null。用 `1h` 时必须有 `extended-cache-ttl-2025-04-11` beta 配套，
否则上游不认。这个 beta 由 `prepareOutbound` 的第 3.1 步自动补。

验证真实出站形态（不联网）：

```bash
node test/anthropic.mjs 2>&1 | grep -E '黄金基准|cache_control'
```

---

## 附录 A：配置项全表

`src/config.mjs` 的 `DEFAULT_WORKER_CONFIG` 共 42 项（冻结对象，:44-137）。

### A.1 身份与路径

| 键 | 类型 | 默认值 | 校验 |
|---|---|---|---|
| `vm_id` | string | `''` | 必填，空抛错 |
| `socket_path` | string | `/run/guest/worker.sock` | 必填 |
| `internal_token` | string | `''` | 必填 |
| `credential_path` | string | `/home/guest/.claude/credentials.json` | — |
| `claude_bin` | string | `claude` | 见 `resolveClaudeBin` |

### A.2 网络与代理

| 键 | 类型 | 默认值 | 校验 |
|---|---|---|---|
| `proxy_url` | string | `''` | — |
| `proxy_required` | bool | `false` | — |
| `https_proxy` | string | `''` | — |
| `anthropic_base_url` | string | `https://api.anthropic.com` | https + host=api.anthropic.com |
| `oauth_token_url` | string | `https://platform.claude.com/v1/oauth/token` | — |

### A.3 超时配额

| 键 | 类型 | 默认值 | 校验 |
|---|---|---|---|
| `refresh_skew_seconds` | number | `300` | — |
| `request_timeout_seconds` | number | `600` | 必须 > 0 |
| `first_byte_timeout_seconds` | number | `120` | 必须 > 0 |
| `idle_timeout_seconds` | number | `180` | 必须 > 0 |

### A.4 字节上限

| 键 | 默认值 |
|---|---|
| `max_request_bytes` | `67108864`（64 MiB） |
| `max_response_bytes` | `67108864` |
| `max_event_bytes` | `1048576`（1 MiB） |

### A.5 形态与投递

| 键 | 类型 | 默认值 | 校验 |
|---|---|---|---|
| `delivery_mode` | enum | `realtime` | 必须是 `realtime`/`verified` |
| `runtime_kind` | enum | `local_cli` | **仅定义枚举，未校验** |
| `provider` | enum | `anthropic_api` | 必填校验 |
| `system_layout` | enum | `zero` | **仅定义枚举，未校验** |
| `test_endpoints` | bool | `false` | — |
| `cli_version` | string | `2.1.281` | — |
| `default_cache_ttl` | string | `1h` | — |
| `claude_prompt_profile` | enum | `official_full` | 必须是 `official_full`/`official_303` |

### A.6 真实出站

| 键 | 默认值 | 说明 |
|---|---|---|
| `mock_mode` | `false` | `true` 才回落 mock；默认走真实上游 |
| `anthropic_credential_path` | `''` | 空串走环境变量 |
| `anthropic_timeout_ms` | `600000` | 单次 HTTP 往返上限 |
| `anthropic_compress_threshold` | `1024` | 超过才 zstd |

`mock_mode` 的三条开启路径：`SKYLINK_MOCK=1`、配置 `mock_mode:true`、`--mock`。

### A.7 Claude 配额

| 键 | 默认值 | 约束 |
|---|---|---|
| `claude_quota_enabled` | `true` | — |
| `claude_quota_warn_pct` | `85` | `0 < warn < stop <= 100` |
| `claude_quota_stop_pct` | `95` | 同上 |

**非法阈值静默回落缺省，不抛错**（`config.mjs:246-253`）。

### A.8 Codex

| 键 | 默认值 |
|---|---|
| `codex_credential_path` | `''` |
| `codex_base_url` | `https://chatgpt.com/backend-api/codex` |
| `codex_default_model` | `gpt-6-astra` |
| `codex_models` | 9 个（见 4.3） |
| `codex_image_models` | 2 个（见 4.3） |

### A.9 内核

| 键 | 默认值 | 说明 |
|---|---|---|
| `kernel_listen` | `unix` | `unix`/`tcp` |
| `kernel_tcp_host` | `127.0.0.1` | — |
| `kernel_tcp_port` | `0` | — |
| `kernel_max_request_bytes` | `67108864` | — |
| `kernel_health_budget_ms` | `100` | 必须远快于 vm2api 的 400ms |

**环境变量只有一个是本文件的**：`CLAUDE_BIN`（`resolveClaudeBin`）。
`KERNEL_*` / `CLAUDE_CODE_*` 的映射在 `src/kernel/server.mjs:1224-1237`。

---

## 附录 B：命令速查

### 编排（`src/runtime/cli.mjs`，7 子命令）

```bash
node src/runtime/cli.mjs help                    # 注意：不是 --help
node src/runtime/cli.mjs preflight [--json]
node src/runtime/cli.mjs plan [--limit N] [--strict]
node src/runtime/cli.mjs slot <slotId>
node src/runtime/cli.mjs up [--count N] [--concurrency N] [--dry-run] [--all]
node src/runtime/cli.mjs status
node src/runtime/cli.mjs down --all | --slot <id>
node src/runtime/cli.mjs repair --slot <id>
```

常用 flag：`--config`、`--image`、`--data-dir`、`--conf-dir`、`--no-verify`、
`--strict`、`--verbose`、`--quiet`。

### 出口（`src/egress/cli.mjs`，6 子命令，**无 help**）

```bash
node src/egress/cli.mjs plan [--config <path>]
node src/egress/cli.mjs verify-config [--config <path>]
node src/egress/cli.mjs emit [--config <path>] --out <dir>
node src/egress/cli.mjs slot <slotId> [--proxy <id>]
node src/egress/cli.mjs probe [--config <path>]      # 唯一联网
node src/egress/cli.mjs preflight [--config <path>]
```

### 身份（`src/persona/cli.mjs`，8 子命令）

```bash
# 单槽位（默认行为，无子命令）
node src/persona/cli.mjs --platform linux --vm-id <id> --out <dir> [--dry-run] [--audit] [--json]

# 执行层
node src/persona/cli.mjs docker --platform <p> --vm-id <id>
node src/persona/cli.mjs apply  --platform <p> --vm-id <id> [--plan] [--no-wrappers]
node src/persona/cli.mjs verify --platform <p> --vm-id <id>

# 舰队
node src/persona/cli.mjs fleet --count N [--host-memory-gb N] [--host-cpus N] [--host-disk-gb N]

# KVM
node src/persona/cli.mjs kvm ...
node src/persona/cli.mjs kvm-fleet ...
node src/persona/cli.mjs kvm-verify ...

# 混合
node src/persona/cli.mjs mixed --count N
```

### 内核

```bash
KERNEL_INTERNAL_TOKEN=<t> KERNEL_LISTEN=tcp KERNEL_TCP_PORT=8787 node src/kernel/server.mjs
```

### 测试

```bash
node test/run-all.mjs            # 全量（含 smoke）
node test/run-all.mjs --fast     # 跳过 smoke
node test/run-all.mjs --filter anthropic
node test/anthropic.mjs          # 单文件
```

---

## 附录 C：macOS 无法验证的步骤

本文档在 macOS 上撰写。以下是**无法**在此环境验证的部分，Linux 上必须实测：

| 内容 | 节 | 原因 |
|---|---|---|
| `os-linux` 通过 | 1.1 / 2.3 | macOS 必 fatal |
| `privileges` 通过 | 1.2 | 无 `/proc/self/status` |
| `iptables` / `redsocks` 存在 | 1.3 | 未安装 |
| `netfilter` 可用 | 1.4 | 无 netfilter |
| `docker-bridge-driver` | 2.3 | 结果依赖 Linux 内核 |
| 建 docker network | 5.3 | 需 iptables |
| 写 iptables 链 | 5.4 | 无 iptables |
| redsocks 真实启动 | 5.5 | 未安装 |
| dnsfwd 真实转发 | 5.6 | 需 netfilter |
| 容器真实出网 | 5.7-5.9 | 依赖上面全部 |
| `host_control` 真实验证 | 5.9 | 需两条真实出口 |
| `/dev/kvm` | 5.10 | macOS 无 |
| 20 槽位真实上线 | 7 | 需 Linux + 20 条代理 |
| `probe` 真实探测 | 3.5 | 无真实代理 |

**已在本机验证**：全部纯计算逻辑（`plan` / `slot` / `fleet` / `mixed` /
`verify-config` / `emit`）、12 项 preflight 的判定逻辑（结论是 fatal，但
**判定路径**跑通了）、4793 条测试全部通过。

**验证方法**：Linux 上按第 2 节的命令逐条重跑，输出应当不同（preflight 应通过）。
差异即为本文档需要按实际环境修订的地方。

---

## 附录 D：已知不一致

以下是核对代码时发现的、**代码与文档/注释不一致**的地方。以代码为准。

### D.1 `docs/EGRESS.md:12` 说「5 个模块」→ 实际 6 个

原文：`src/egress/`（5 个模块 + 1 个 CLI）。
实际 `src/egress/` 下有 6 个模块：`cli`、`network`、`plan`、`pool`、
`socks5`、`verify`、`dnsfwd`（7 个文件，其中 `plan` 是纯规划）。
同文档 §8 的模块地图又列了 6 个，自相矛盾。

### D.2 `docs/EGRESS.md:323` 示例命令跑不通

原文：

```js
import('./src/egress/plan.mjs').then(m=>{
  console.log(m.planSlotNetworks({ base: '10.240.0.0/16' }).slots.length)
})
```

实测：

```
TypeError: m.planSlotNetworks is not a function
```

`planSlotNetworks` 从 `network.mjs` 导出，不是 `plan.mjs`。正确写法见本文 1.7。

### D.3 `docs/EGRESS.md:654` 说「102 个文件」→ 不带 `--config` 时是 62 个

原文：`# 102 个文件：fleet.json + SUBNETS.md + 20 × (blueprint.json + 2 脚本 + 2 配置文件)`

实测：

```
$ node src/egress/cli.mjs emit --out /tmp/egress-demo
已生成 62 个文件 → /tmp/egress-demo
槽位 20 个，未绑定 20 个
```

差异原因：无代理时 redsocks / singbox 配置内容为 `null`，
`renderFleetFiles`（约 :226-228）跳过这些文件。带有效 `--config` 时才是 102 个。
两个值都实测过。

### D.4 `docs/EGRESS.md:214` 提到 `up.sh`，但仓库里没有这个文件

`up.sh` 是 `renderIptablesScript()` 运行时生成的字符串，不是仓库里的文件。
改它要改生成函数，不是编辑某个脚本。

### D.5 `kernel.json` 的 `kernel_listen` / `kernel_tcp_port` 被忽略

`src/kernel/supervisor-compat.mjs` 的 `kernelConfigFromVN2` 对这三个字段只读
`fallback`。实测 `kernel.json` 传 `tcp` / `9999` 仍得 `unix` / `0`。
只能走环境变量。这一点没有任何文档提到。

### D.6 `runtime/cli.mjs` 的 `--help` / `-h` 不工作

```
$ node src/runtime/cli.mjs --help
未知命令: --help
$ echo $?
2
$ node src/runtime/cli.mjs help   # 这个才对
$ echo $?
0
```

`--help` 作为 `argv[0]` 被当成命令名。`egress/cli.mjs` 更彻底，
两种形式都 exit 2（源码零个 usage 符号）。

### D.7 `egress/cli.mjs plan` 的 `--config` 无效

`plan` 分支硬编码 `proxies: []`，所以规划表「代理」列恒为 `-`。
要看真实绑定必须用 `verify-config` 或 `emit` 的输出。

### D.8 `egress/cli.mjs slot` 的缺省代理不是「未绑定」

不给 `--proxy` 时回退 `proxies[0]`，不是「未绑定」。而 `runtime/cli.mjs plan`
显示的是「未绑定」。两个命令对同一槽位的说法不一致。

### D.9 `status` 的 healthy 不含 redsocks / dnsfwd

`src/runtime/orchestrator.mjs:911`：healthy 只看 `network` + `iptables` + `container`。
redsocks 挂了但容器还在时仍报 healthy，实际所有请求超时。运维上必须
另外 `pgrep -af redsocks`。

### D.10 `runtime_kind` / `system_layout` 定义枚举但未校验

`RUNTIME_KINDS` 和 `SYSTEM_LAYOUTS` 在 `config.mjs` 里定义并导出，
但 `validateWorkerConfig` 没用它们。写错的值会一路带下去。

### D.11 `planMixedFleet` 与 `planFleet` 的 CPU 预算口径不同

- `planFleet`：`availCpu * rules.cpuOversubscribe`（:396 / :442 / :587）
- `planMixedFleet`：只用 `(1 - reserveRatio)`，**不乘 `cpuOversubscribe`**（:716）

同样是「算能跑多少个槽位」，两个函数给出不同答案。多卡机器上差异明显。

### D.12 `test/anthropic.mjs` 里 SAMPLE_SSE 的事件数

`SAMPLE_SSE` 实际产出 **12** 帧（11 个 event + 1 个 ping），
早期版本的断言写成 14 导致 FAIL。现已是 12。

### D.13 `preflight --json` 的 stdout 不是纯 JSON

命令执行轨迹（`$ /bin/sh -c 'command -v iptables'` 与 `↳ exit=1` 这类行）
仍然打到 **stdout**，JSON 在其后。因此 `... --json | jq` 或
`| python3 -c 'json.load(sys.stdin)'` 会失败：

```
json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

实测的绕过方式（本文 7.2 节采用）：

```bash
node src/runtime/cli.mjs preflight --json 2>/dev/null | sed -n '/^{/,$p' | python3 -m json.tool
```

更彻底的做法是把轨迹行改到 stderr，或在 `--json` 时抑制轨迹输出。
这属于代码问题，不是文档问题——本文只在文档侧给出可用写法。

---

## 附录 E：本文档的验证边界

本文档的每一条命令行都实际执行过。执行的边界：

- **实际跑过**：第 2 节全部、第 3.3 节校验、第 5.2-5.8 的 dry-run 形态、
  第 9.7 的缓存诊断、附录 B 的全部命令（help 类除外，那几条例外已在 D.6 说明）
- **未实际跑**：真机建网桥 / 写 iptables / 起 redsocks / 容器出网 /
  20 槽位上线（见附录 C）
- **数据来源**：`node test/run-all.mjs --fast` = 4793 通过 0 失败；
  `node test/anthropic.mjs` = 434 通过 0 失败

发现新的不一致请直接改本文档的附录 D，不要只改正文——附录 D 是给下一个
部署的人省时间的清单。
