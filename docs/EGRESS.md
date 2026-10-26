# EGRESS —— 一台机器、20 个账号、20 条独立 SOCKS5 出口

面向要在这台机器上跑 20 个 Claude 账号的运维/开发。读完应该能做到：

- 说清 20 个槽位的网络拓扑，以及为什么必须一个槽位一个 docker network
- 知道流量从容器走到 SOCKS5 代理的完整路径，每一跳由谁执行
- 知道 DNS 为什么必须单独处理，不处理会泄漏什么
- 照着一张 subnet 表把 20 个槽位配起来
- 知道 `config/proxies.json` 每个字段怎么填，填错会报什么
- 用 `verifyEgress` 证明「出站真的走了代理」，而不是「配了但没生效」

配套代码：`src/egress/`（5 个模块 + 1 个 CLI）、`test/egress.mjs`、`config/proxies.example.json`。

**范围**：代理服务器由使用者自行提供。本方案只负责「把容器钉到某条代理上」这件事，
不包括代理的采购、部署、轮换。`config/proxies.example.json` 里的地址全部是占位符。

---

## 1. 拓扑

### 1.1 全貌

```text
宿主机 (Linux, docker)
│
├── docker network: live-api-eg-01   10.213.1.0/24   网关 10.213.1.1   网桥 skeg01
│   │
│   │   ┌───────────────────────────────────────────────────────────────┐
│   │   │ 容器 claude-slot-01   10.213.1.2    账号 #01 的 Claude CLI    │
│   │   │ /etc/resolv.conf → nameserver 8.8.8.8 + use-vc（强制 TCP）     │
│   │   │ 无 HTTPS_PROXY / ALL_PROXY —— CLI 不知道自己有代理            │
│   │   └───────────────────────────────────────────────────────────────┘
│   │                    │ 默认路由 10.213.1.1
│   │                    ▼
│   │   ┌── 宿主机内核 ────────────────────────────────────────────────┐
│   │   │ nat PREROUTING  -i skeg01  -j SKEG01                          │
│   │   │   SKEG01: tcp/53     → REDIRECT 10.213.1.1:21001（DNS 转发器）│
│   │   │   SKEG01: 其余 tcp   → REDIRECT 10.213.1.1:21000（redsocks）  │
│   │   │ filter FORWARD -i skeg01 ! -o skeg01 → DROP（兜底，含 UDP）   │
│   │   └───────────────────────────────────────────────────────────────┘
│   │                    │
│   │        ┌───────────┴────────────┐
│   │        ▼                        ▼
│   │   redsocks :21000          dnsfwd :21001
│   │   SO_ORIGINAL_DST 取回      经 SOCKS5 连 8.8.8.8:53
│   │   原目的 → SOCKS5 CONNECT   （TCP，不过本地解析器）
│   │        └───────────┬────────────┘
│   │                    ▼
│   └──────────► SOCKS5 代理 A（住宅出口，预期出口 IP 47.88.12.34）
│
├── docker network: live-api-eg-02   10.213.2.0/24   ──► SOCKS5 代理 B
├── docker network: live-api-eg-03   10.213.3.0/24   ──► SOCKS5 代理 C
│   ...
└── docker network: live-api-eg-20   10.213.20.0/24  ──► SOCKS5 代理 T
```

每个槽位的东西是**三件套 + 两个进程**：

| 槽位 | docker network | 网桥 | subnet | 容器 | redsocks | dnsfwd | 代理 |
|---|---|---|---|---|---|---|---|
| slot-01 | live-api-eg-01 | skeg01 | 10.213.1.0/24 | claude-slot-01 | :21000 | :21001 | p01 |
| slot-02 | live-api-eg-02 | skeg02 | 10.213.2.0/24 | claude-slot-02 | :21002 | :21003 | p02 |
| … | … | … | … | … | … | … | … |
| slot-20 | live-api-eg-20 | skeg20 | 10.213.20.0/24 | claude-slot-20 | :21038 | :21039 | p20 |

完整 20 行由 `node src/egress/cli.mjs plan` 输出；落盘版本见 `/tmp/egress-demo/SUBNETS.md`。

### 1.2 为什么每个槽位要独立 docker network

三个理由，按重要性排：

**（1）iptables 规则以网桥接口为匹配条件，共用接口就等于共用规则。**
nat 表的 PREROUTING 只能靠 `-i <iface>`、源地址段、目的地址段来区分流量。
如果 20 个容器在同一个 bridge 上，它们共享一个 `-i` 值，
那么「这个包该走代理 A 还是 B」在 netfilter 里无从判断——
只能退到按源 IP 逐条匹配，而源 IP 是容器启动时动态分配的，
换一次容器顺序就要重写一遍规则。
一个槽位一个网桥，规则条件退化成常量 `-i skeg01`，规则集与槽位一一对应、互不干扰。

**（2）出口失败必须只影响一个槽位。**
共用网桥时，网桥上的 FORWARD 兜底 DROP 是全局开关：为了拦住槽位 7 的泄漏而
DROP 整个网桥，会连带打死另外 19 个正常运行中的账号。
独立网桥下，某个槽位代理挂了，它的规则和进程可以单独拆掉，其他 19 个不受影响。

**（3）容器可观测面收敛。**
同网桥内所有容器二层可达。20 个账号会各自持有独立的登录态与会话，
把它们放进同一个广播域，等于给每个容器开了 19 个可探测邻居，
`ip neigh`、ARP 表、容器间直连都能暴露「这台机器上还有谁」。
独立 subnet 后，一个容器只能看到网关和自己，
跨槽位通信只能走宿主机转发——而那条路径被 FORWARD 规则 DROP 掉了。

> 与参考实现（vm2api `src/lib/vm/egress.mjs`）的差异：它按 **代理** 建网络
> （`kin-eg-<proxyId>`），允许多个 VM 共用一个代理出口（默认 bind_limit=5）。
> 本方案按 **槽位** 建网络，并且在 `pool.mjs` 里把槽位容量硬编码成 1。
> 理由很直接：需求是 20 个账号各自独立出口，一个代理出口被两条账号共用，
> 两个账号在上游看来就是同一个 IP，隔离的意义直接归零。

### 1.3 容器命名与标签

容器带 `live-api.slot` / `live-api.egress.network` / `live-api.egress.proxy` /
`live-api.egress.subnet` 四个标签，用来做反向排查：

```bash
# 这个容器绑的是哪个代理？
docker inspect -f '{{index .Config.Labels "live-api.egress.proxy"}}' claude-slot-07

# 代理 p07 挂错槽位了吗？
docker ps -q --filter label=live-api.egress.proxy=p07
```

---

## 2. 流量怎么从容器走到 SOCKS5

REDIRECT 只能把 TCP 包改投到本机的一个 **TCP 端口**，而 SOCKS5 是应用层协议：
它需要在连接建立后先做一次方法协商（`05 01 00` → `05 00`）、
再做一次 CONNECT 请求（`05 01 00 03 <len> <域名> <port>`）。
所以「iptables 直连 SOCKS5」不成立，中间必须有一个转换器。
三个候选：

### 方案对比

| 方案 | 原理 | 对 CLI 透明 | Node 能实现 | 复杂度 | 本方案 |
|---|---|---|---|---|---|
| **A. iptables REDIRECT + redsocks** | 内核改投端口，redsocks 取回原目的地址后用 SOCKS5 重建连接 | ✅ 完全透明 | ✅ 只需生成命令与配置 | 中 | **采用** |
| B. tun2socks | 容器内建 TUN，路由表默认指向 TUN，用户态转发到 SOCKS5 | ✅ 透明 | ⚠️ 要 root + TUN + 改容器路由 | 高 | 不采用，保留参数生成 |
| C. 环境变量 `HTTPS_PROXY` | 应用层自己读变量建隧道 | ⚠️ 取决于库，且留下可观测差异 | ✅ 最简单 | 低 | 不采用 |

### 方案 A：iptables REDIRECT（采用）

工作链路：

1. 容器发起 `connect(api.anthropic.com:443)`，包从 `skeg01` 进宿主机。
2. nat PREROUTING 命中 `-i skeg01 -j SKEG01`，跳到自定义链。
3. 链里先 `-d 10.213.1.0/24 -j RETURN`（容器访问自己网段不劫持，否则 DNS/容器间通信会死循环）。
4. tcp/53 改投 `:21001`；其余 tcp 一律改投 `:21000`。
改写的目标地址是**入接口的地址**（也就是网关 `10.213.1.1`），不是 `127.0.0.1`。
这是 PREROUTING 与 OUTPUT 的行为差异：OUTPUT 链里的 REDIRECT 落到 loopback，
PREROUTING 链里落到报文进来的那块网卡地址。所以转发器必须监听网关地址，
监听到 `127.0.0.1` 上会收不到任何包。

5. redsocks 在 `:21000` 收到连接，用 `getsockopt(SOL_IP, SO_ORIGINAL_DST)`
   取回被改写前的目的地址（这是 REDIRECT 唯一留下的线索），
   然后用 SOCKS5 连代理、发 CONNECT、双向 splice。
6. 上游看到的 TCP 四元组来自代理出口，与宿主机、与其它槽位都无关。

**对 CLI 是否透明：是，完全透明。** 容器内没有任何代理相关配置，
`process.env` 里没有 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`，
CLI 走的是普通的直接连接语义。

这一点比「配了能用」更重要。本仓库 `src/identity.mjs` 的 `resolveUpstreamProtocol`
（[identity.mjs:450-456](../src/identity.mjs)）记录了一条实测事实：

> 官方 CLI 在**没有代理**时走 HTTP/2（undici `allowH2: true`），**有代理**时自动退回 HTTP/1.1。

也就是说，走环境变量方案会让每个账号的上游连接从 H2 变成 H1，
ALPN 协商结果、帧结构都变了。这不需要任何主动探测就能被区分，
而 20 个账号全部呈现同样的降级特征，反而比不降级更扎眼。
透明方案下 CLI 不知情，协议选择与「这台机器上什么都没配」完全一致。

**DNS 也顺带解决了。** 改投发生在 TCP 层，域名由代理侧解析
（redsocks 把 `ATYP=0x03` 的域名原样交给代理，不在本地解析）。
宿主机不做任何解析，也就没有 DNS 泄漏。

**代价**：需要 redsocks 这一个外部程序（约 200KB，无依赖，静态可编译），
以及宿主机需要 netfilter 权限。

### 方案 B：tun2socks（不采用）

链路是：容器内 `/dev/net/tun` 建 `tun0` → 改容器默认路由指向 `tun0` →
tun2socks 从 TUN 读原始 IP 包，按五元组查表转发到 SOCKS5。

能力上等价，但落地条件重：

- 容器需要 `NET_ADMIN` capability；
- 需要 `--device /dev/net/tun`；
- 需要容器内改路由表（`ip route replace default dev tun0`），
  与 `--read-only` 根文件系统、`--cap-drop ALL` 的加固模型直接冲突；
- 每个槽位要一份 tun2socks 进程，20 份进程 + 20 个 TUN 设备。

本方案里容器被配置成 `--cap-drop ALL --security-opt no-new-privileges`，
拿 `NET_ADMIN` 要整条链路放宽权限。而它的收益（相比方案 A）只是
「不用 redsocks」，代价是把 20 个容器的权限模型全部摊开。
`network.mjs` 里的 `tun2socksSpec()` 保留了这个方案的参数生成，
换实现时不用重新推导需要哪些 capability 与设备。

### 方案 C：环境变量 `HTTPS_PROXY`（不采用）

最省事，但三个硬伤：

1. **部分库不遵守。** Node 的 `undici` 默认不读环境变量（要显式构造 `EnvHttpProxyAgent`），
   `fetch` 与 `node-fetch` 的行为不一致，原生扩展、`curl` 子进程、WebSocket 各有各的规则。
   结果是「有的请求走了代理、有的走了直连」，而且从容器内部看不出来。
2. **DNS 仍然泄漏。** 应用层代理只接管了它自己发起的 TCP，
   `getaddrinfo` 依旧走宿主机解析器。除非额外配 `socks5h://`（远端解析），
   而 `socks5h` 又依赖具体库认不认这个 scheme。
3. **可被观测。** 见上：协议降级是最明显的痕迹。反过来，
   一个「配了代理却仍走 H2」的环境本身也不自然——真实用户装代理客户端时
   通常同时改了系统代理，两者不一致反而是异常。

**结论**：采用方案 A。转换器选 **redsocks**：

| 候选 | 判断 |
|---|---|
| **redsocks** | 采用。核心能力 `SO_ORIGINAL_DST` 恰好是 Node 拿不到的（`node:net` 没有暴露该套接字选项），交给它做这一跳最省。配置十来行 INI，单进程无状态，`apt install redsocks` 或静态编译均可 |
| 自写 TCP→SOCKS5 转发器 | 协议本身 100 行 Node 就能写完（`src/egress/socks5.mjs` 就是），但**取不回原目的地址**——这是纯 Node 的硬边界，不是工作量问题。绕法只有 TPROXY + `IP_TRANSPARENT`（要 native addon）或 tun2socks（回到方案 B） |
| gost / sing-box | 都能做，`sing-box` 甚至单文件同时接管 TCP 与 DNS。不选是因为它们各自带一整套路由、分流、TLS 指纹能力，本方案一行都用不到，却要接受一个更大的、会自己更新配置语义的依赖。`network.mjs` 的 `singboxConfig()` 保留了等价的 sing-box 配置生成，作为「不想装 redsocks」的备选 |

另外说明一下：本方案把 redsocks **放在宿主机**、监听网桥网关地址，
而不是放进容器里。这样容器不需要 `NET_ADMIN`、不需要 `iptables`、
也不需要知道自己有任何出口配置——容器只负责跑 CLI。
20 个 redsocks 进程在宿主机上是 20 个 `:210xx` 端口的监听，
互不干扰，挂掉一个只影响一个槽位。若确实要把转换器放进容器，
把 `up.sh` 里的 `-i skeg01` 换成容器内 `-i eth0` 即可，规则结构不变。

---

## 3. DNS 怎么处理

### 3.1 不处理的后果

容器默认的 `/etc/resolv.conf` 指向 docker 内嵌解析器 `127.0.0.11`，
它再转发到宿主机的解析器。这条路径**完全绕开代理**：
上游 DNS 服务器看到的是宿主机的 IP，而不是代理出口的 IP。

后果不是「请求失败」，而是**账号画像里出现了一个固定锚点**：
20 个账号的所有域名解析都来自同一个 IP，而这个 IP 与它们各自的出口 IP 毫无关系。
按解析来源做聚类，20 个账号会被直接归成一组。

### 3.2 本方案的做法

四层保证，缺一层都不算完成：

**（1）容器不用 docker 内嵌解析器。** `dockerNetworkArgs()` 里显式给
`--dns 8.8.8.8 --dns 1.1.1.1`，跳过 `127.0.0.11`。
`verifyEgress` 会检查 `/etc/resolv.conf`，命中的是 `docker_embedded` /
`loopback` / `private` / `link_local` 任一类就判失败。

**（2）强制 TCP。** `--dns-opt use-vc` 让 glibc 用 TCP 发查询。
这不是性能选择，是可行性选择：UDP 经 SOCKS5 需要 `UDP ASSOCIATE`，
住宅代理普遍不支持，开了就是长时间挂起等超时，而不是快速失败。
强制 TCP 后，查询变成一个普通的 TCP 连接，走 §2 的同一条重定向路径。

**（3）tcp/53 单独改投到 DNS 转发器。** nat 链里
`-p tcp --dport 53 -j REDIRECT --to-ports 21001` 排在「其余 tcp」之前，
DNS 查询不会进 redsocks。转发器（`src/egress/dnsfwd.mjs`）在 `:21001` 上
收 DNS 报文，用 SOCKS5 连 `8.8.8.8:53`，把报文从代理侧发出。
上游解析器看到的是代理出口 IP。

**（4）UDP/53 在 FORWARD 上丢弃。** 兜底规则
`-i skeg01 ! -o skeg01 -j DROP` 覆盖所有非重定向流量，包括 UDP、ICMP。
glibc 万一回退到 UDP（`use-vc` 没生效、或程序自己直接构造 UDP 查询），
包在宿主机被丢掉，表现为解析超时——能立刻发现，而不是静默泄漏。
`verifyEgress` 的 `dns_udp_leak` 检查项专门探这个：容器内直连 udp/53 若可达即判失败。

### 3.3 上游解析器为什么写死 IP

`dnsfwd.mjs` 的上游必须是 IP 字面量（`DEFAULT_UPSTREAMS = ['8.8.8.8', '1.1.1.1']`）。
用域名做上游会陷入循环：要解析「解析器的域名」，得先有一个解析器。
`relayOverProxy` 对非 IP 上游直接拒绝，不给这个循环留口子。

固定上游也带来一个副作用，需要说清楚：容器如果手动指定了别的解析器
（比如 `1.1.1.1`），实际仍然走 `8.8.8.8`。这是有意的——上游由部署方统一决定，
不允许槽位内的程序改。要换上游改 `dnsfwd.mjs` 的 `DEFAULT_UPSTREAMS`。

---

## 4. 20 个槽位的 IP 段规划

### 4.1 规则

- 默认池：`10.213.0.0/16`，切成 20 个 `/24`，槽位 n 拿第 n 段。
- 索引 0（`10.213.0.0/24`）保留给宿主机管理面。所以容量是 `255` 而不是 `256`
  （`subnetCapacity('10.213.0.0/16') === 255`），越界直接判错，不静默漂出池外。
- 每段：网关 `x.1`（宿主机网桥地址，redsocks / dnsfwd 监听在这里），
  容器固定 `x.2`。固定 IP 而不是 DHCP，是为了规则和排查时地址可预测。
- 端口：`21000 + (n-1)*2` 给 redsocks，`+1` 给 dnsfwd。全部落在 21000-21039。
- 刻意避开 `172.17.0.0/16`、`172.18.0.0/16`、`172.19.0.0/16`
  （docker 默认地址池，`DOCKER_RESERVED`），也避开 `192.168.x`/`10.0.x`
  这类常见办公网段。`10.213.x` 是少见且集中管理的选择。

### 4.2 subnet 表

`node src/egress/cli.mjs plan` 的输出（与 `/tmp/egress-demo/SUBNETS.md` 一致）：

| 槽位 | 容器 | docker network | bridge | subnet | 网关 | 容器 IP | tcp | dns | 代理 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| slot-01 | claude-slot-01 | live-api-eg-01 | skeg01 | 10.213.1.0/24 | 10.213.1.1 | 10.213.1.2 | 21000 | 21001 | p01 |
| slot-02 | claude-slot-02 | live-api-eg-02 | skeg02 | 10.213.2.0/24 | 10.213.2.1 | 10.213.2.2 | 21002 | 21003 | p02 |
| slot-03 | claude-slot-03 | live-api-eg-03 | skeg03 | 10.213.3.0/24 | 10.213.3.1 | 10.213.3.2 | 21004 | 21005 | p03 |
| slot-04 | claude-slot-04 | live-api-eg-04 | skeg04 | 10.213.4.0/24 | 10.213.4.1 | 10.213.4.2 | 21006 | 21007 | p04 |
| slot-05 | claude-slot-05 | live-api-eg-05 | skeg05 | 10.213.5.0/24 | 10.213.5.1 | 10.213.5.2 | 21008 | 21009 | p05 |
| slot-06 | claude-slot-06 | live-api-eg-06 | skeg06 | 10.213.6.0/24 | 10.213.6.1 | 10.213.6.2 | 21010 | 21011 | p06 |
| slot-07 | claude-slot-07 | live-api-eg-07 | skeg07 | 10.213.7.0/24 | 10.213.7.1 | 10.213.7.2 | 21012 | 21013 | p07 |
| slot-08 | claude-slot-08 | live-api-eg-08 | skeg08 | 10.213.8.0/24 | 10.213.8.1 | 10.213.8.2 | 21014 | 21015 | p08 |
| slot-09 | claude-slot-09 | live-api-eg-09 | skeg09 | 10.213.9.0/24 | 10.213.9.1 | 10.213.9.2 | 21016 | 21017 | p09 |
| slot-10 | claude-slot-10 | live-api-eg-10 | skeg10 | 10.213.10.0/24 | 10.213.10.1 | 10.213.10.2 | 21018 | 21019 | p10 |
| slot-11 | claude-slot-11 | live-api-eg-11 | skeg11 | 10.213.11.0/24 | 10.213.11.1 | 10.213.11.2 | 21020 | 21021 | p11 |
| slot-12 | claude-slot-12 | live-api-eg-12 | skeg12 | 10.213.12.0/24 | 10.213.12.1 | 10.213.12.2 | 21022 | 21023 | p12 |
| slot-13 | claude-slot-13 | live-api-eg-13 | skeg13 | 10.213.13.0/24 | 10.213.13.1 | 10.213.13.2 | 21024 | 21025 | p13 |
| slot-14 | claude-slot-14 | live-api-eg-14 | skeg14 | 10.213.14.0/24 | 10.213.14.1 | 10.213.14.2 | 21026 | 21027 | p14 |
| slot-15 | claude-slot-15 | live-api-eg-15 | skeg15 | 10.213.15.0/24 | 10.213.15.1 | 10.213.15.2 | 21028 | 21029 | p15 |
| slot-16 | claude-slot-16 | live-api-eg-16 | skeg16 | 10.213.16.0/24 | 10.213.16.1 | 10.213.16.2 | 21030 | 21031 | p16 |
| slot-17 | claude-slot-17 | live-api-eg-17 | skeg17 | 10.213.17.0/24 | 10.213.17.1 | 10.213.17.2 | 21032 | 21033 | p17 |
| slot-18 | claude-slot-18 | live-api-eg-18 | skeg18 | 10.213.18.0/24 | 10.213.18.1 | 10.213.18.2 | 21034 | 21035 | p18 |
| slot-19 | claude-slot-19 | live-api-eg-19 | skeg19 | 10.213.19.0/24 | 10.213.19.1 | 10.213.19.2 | 21036 | 21037 | p19 |
| slot-20 | claude-slot-20 | live-api-eg-20 | skeg20 | 10.213.20.0/24 | 10.213.20.1 | 10.213.20.2 | 21038 | 21039 | p20 |

### 4.3 部署前先查这台机器上已有什么

规划函数只能避开已知的 docker 默认池。宿主机若已有其他 docker network
或 VPN 路由占用 `10.213.x`，`docker network create` 会在创建时报
`Pool overlaps with other one on this address space`。先扫一遍：

```bash
# 已有 docker 网段
docker network ls -q | xargs -r docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'

# 宿主机路由表里已占用的网段
ip -4 route show | grep -E '^10\.'

# 如果 10.213.x 已被占用，换池子（改了不用动其他配置，蓝图会重算）
node -e "import('./src/egress/plan.mjs').then(m=>{
  console.log(m.planSlotNetworks({ base: '10.240.0.0/16' }).slots.length)
})"
```

把冲突网段通过 `reserved` 传进 `planSlotNetworks({ reserved: ['10.213.1.0/24'] })`，
规划函数会主动判错而不是产出一份注定冲突的配置。

---

## 5. 单槽位完整配置（可直接照抄）

下面是 slot-01 绑定一条代理后的全部产物，结构上与
`/tmp/egress-demo/slots/slot-01/` 完全一致。这里用 `47.88.12.34` / `user01` / `PASS_01`
作为示意值，你实际拿到的 `blueprint.json` 里会是 `192.0.2.10` 这类占位地址，
换成真实值即可。

### 5.1 创建网络

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

`enable_ip_masquerade=false` 是整条链路的前提，不是可选优化：
开启后容器流量离开宿主机前会被 SNAT 成宿主机地址，
nat PREROUTING 里就看不到原始目的地址，REDIRECT 失去依据。
关掉它，容器流量进入宿主机的转发路径，PREROUTING 才有机会收口。

### 5.2 转发器配置

`/etc/live-api-egress/live-api-eg-01.redsocks.conf`（0600，含明文凭据）：

```ini
// 由 src/egress/network.mjs 生成；改 config/proxies.json 后重新生成，勿手改
base {
  log_debug = off;
  log_info = on;
  log = "stderr";
  daemon = on;
  redirector = iptables;
}

redsocks {
  local_ip = 10.213.1.1;
  local_port = 21000;
  ip = 47.88.12.34;
  port = 1080;
  type = socks5;
  login = "user01";
  password = "PASS_01";
}
```

启动：

```bash
redsocks -c /etc/live-api-egress/live-api-eg-01.redsocks.conf
```

监听地址是网桥网关，既不是 `0.0.0.0` 也不是 `127.0.0.1`：

- **必须是网关地址**——PREROUTING 的 REDIRECT 把目的地址改写入接口地址，即网关。
  监听 `127.0.0.1` 收不到任何包。
- **不能是 `0.0.0.0`**——会把宿主机所有接口都暴露出去，
  且容器访问其他槽位网关时可能误入本槽位转发器。

DNS 转发器单独起（同一个网关地址，另一个端口）：

```bash
node -e "
import('./src/egress/dnsfwd.mjs').then(async (m) => {
  const f = await m.startDnsForwarder({
    proxy: { id: 'p01', host: '47.88.12.34', port: 1080, username: 'user01', password: 'PASS_01' },
    listenHost: '10.213.1.1',
    port: 21001,
    mode: 'tcp',
    upstreams: ['8.8.8.8', '1.1.1.1'],
  })
  console.log('dns forwarder:', f.listen)
})"
```

### 5.3 iptables 规则

`/tmp/egress-demo/slots/slot-01/iptables/live-api-eg-01.up.sh`：

```sh
#!/bin/sh
# 生成的网段重定向规则：apply 幂等，del 用于回滚
set -e
iptables -t nat -N SKEG01 2>/dev/null || true
if ! iptables -t nat -C PREROUTING -i skeg01 -j SKEG01 2>/dev/null; then iptables -t nat -A PREROUTING -i skeg01 -j SKEG01; fi
iptables -t nat -F SKEG01
iptables -t nat -A SKEG01 -d 10.213.1.0/24 -j RETURN
iptables -t nat -A SKEG01 -p tcp --dport 53 -j REDIRECT --to-ports 21001
iptables -t nat -A SKEG01 -p tcp -j REDIRECT --to-ports 21000
if ! iptables -t filter -C INPUT -i skeg01 -s 10.213.1.0/24 -d 10.213.1.1 -p tcp -m multiport --dports 21000,21001 -j ACCEPT 2>/dev/null; then iptables -t filter -I INPUT 1 -i skeg01 -s 10.213.1.0/24 -d 10.213.1.1 -p tcp -m multiport --dports 21000,21001 -j ACCEPT; fi
if ! iptables -t filter -C FORWARD -i skeg01 ! -o skeg01 -j DROP 2>/dev/null; then iptables -t filter -I FORWARD 1 -i skeg01 ! -o skeg01 -j DROP; fi
```

六条规则各自的作用：

| 规则 | 作用 | 删掉会怎样 |
|---|---|---|
| `-N SKEG01` + `PREROUTING -j SKEG01` | 把本网桥的包引入专属链 | 容器流量直连出去，完全无隔离 |
| `-d <subnet> -j RETURN` | 槽内同网段不劫持 | 网关自身流量被自己重定向，DNS 与转发器互相打环 |
| `tcp/53 → :21001` | DNS 走代理侧的解析器 | 查询落到 redsocks，被当成普通 TCP 转发到 8.8.8.8:53——碰巧也能通，但上游解析器不可控 |
| `tcp → :21000` | 其余 TCP 全部交给 redsocks | 直连泄漏 |
| `INPUT -d <gw> --dports ... ACCEPT` | 放行重定向后的本地投递 | REDIRECT 目标端口被 INPUT 拦掉，表现为连接被拒 |
| `FORWARD -i skeg01 ! -o skeg01 -j DROP` | 兜底：UDP / ICMP / 未重定向的包一律丢弃 | UDP DNS 泄漏、ICMP 探测泄漏 |

`-C` + `-I` 的配对是为了幂等：`up.sh` 可以反复执行，
已在位的规则不会被插重复（重复插入会让 `down.sh` 删不干净）。

回滚用 `live-api-eg-01.down.sh`，顺序是先删 PREROUTING 跳转再 `-F`/`-X` 链，
否则链仍被引用时 `-X` 会失败。

### 5.4 启动容器

```bash
docker run -d \
  --name claude-slot-01 \
  --hostname claude-slot-01 \
  --network live-api-eg-01 \
  --dns 8.8.8.8 \
  --dns 1.1.1.1 \
  --dns-opt use-vc \
  --dns-opt attempts:2 \
  --pids-limit 256 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --label live-api.slot=slot-01 \
  --label live-api.egress.network=live-api-eg-01 \
  --label live-api.egress.proxy=p01 \
  --label live-api.egress.subnet=10.213.1.0/24 \
  --ip 10.213.1.2 \
  live-api/claude-slot:latest
```

注意这里**没有** `-e HTTPS_PROXY`。这是刻意的，理由见 §2。
容器仍保留 `--cap-drop ALL`，因为它确实不需要任何特权：
网关、转发器、规则全在宿主机侧。

### 5.5 验证

```bash
# 1. 出口 IP 应该是代理的出口，不是宿主机 IP
docker exec claude-slot-01 node -e "
require('node:https').get('https://api.ipify.org/?format=json',r=>{
  let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log('exit:',b))
})"
# 期望：{"ip":"47.88.12.34"}

# 2. 解析器不能是 docker 内嵌
docker exec claude-slot-01 cat /etc/resolv.conf
# 期望：nameserver 8.8.8.8 / nameserver 1.1.1.1，不能出现 127.0.0.11

# 3. 裸 TCP 必须不可达（隔离生效）
docker exec claude-slot-01 node -e "
const s=require('node:net').connect({host:'1.1.1.1',port:53});
s.on('connect',()=>{console.log('LEAK: 直连成功');process.exit(1)});
s.on('error',()=>{console.log('ok: 直连被阻断');process.exit(0)})"
```

三条都要过。只过第 1 条不算部署完成——出口 IP 对，但 DNS 或裸连没堵住，
一样是泄漏。

程序化版本（`src/egress/verify.mjs` 的 `verifyEgress`）会把这三条加上
宿主机控制组、DNS 经代理可达，共 6 项判定，见 §6。

---

## 6. 出口验证：怎么证明「真的走了代理」

配置写错、规则没生效、代理挂了但仍能上网——这三种情况在功能上完全看不出来。
`verifyEgress()` 把「部署完成」和「隔离生效」拆成两件事判定。

六项检查，任一失败即整体失败：

| 检查项 | kind | 判定 | 不通过的含义 |
|---|---|---|---|
| 出口 IP 比对 | `exit_ip` | 容器内看到的公网 IP == `expected_exit_ip` | 走错了代理，或代理没生效 |
| 宿主机控制组 | `host_control` | 容器出口 IP != 宿主机裸连出口 IP | 容器实际未走代理（两者相同即证明） |
| DNS 配置检查 | `dns_resolver` | `/etc/resolv.conf` 里没有 docker 内嵌 / 回环 / 内网解析器 | DNS 走宿主机路径 |
| DNS 经代理解析 | `dns_via_proxy` | 容器内能解析出地址 | DNS 转发链路不通 |
| UDP/53 泄漏 | `dns_udp_leak` | 容器内直连 udp/53 **不可达** | glibc 回退到 UDP 直连 |
| 直连隔离 | `direct_blocked` | 不经代理的裸 TCP **失败** | FORWARD 兜底规则没生效 |

「宿主机控制组」是防假阳性的关键。只比对出口 IP 有一个漏洞：
如果代理出口和宿主机恰好在同一机房同一出口 IP，那么「容器没走代理」
也会显示 IP 匹配。加一条「容器 IP 必须与宿主机 IP 不同」，
就把「IP 匹配」从充分条件降成了必要条件。

用法：

```js
import { verifyEgress } from './src/egress/verify.mjs'
import { execFile } from 'node:child_process'

const exec = ({ container, argv, timeoutMs }) =>
  new Promise((resolve) => {
    execFile('docker', ['exec', container, ...argv], { timeout: timeoutMs }, (error, stdout, stderr) =>
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), code: error?.code }),
    )
  })

// 宿主机控制组：同一端点从宿主机裸连。缺这段就只能比对出口 IP，
// 「容器没走代理但 IP 恰好相同」这种情形查不出来。
const hostProbe = async () => {
  const res = await fetch('https://api.ipify.org/?format=json')
  return (await res.json()).ip
}

const report = await verifyEgress({
  slotId: 'slot-01',
  proxy: { id: 'p01', host: '47.88.12.34', port: 1080, expectedExitIp: '47.88.12.34' },
  slot: { slotId: 'slot-01', container: 'claude-slot-01' },
  exec,
  hostProbe,
})
// report.ok / report.checks / report.failed / report.summary
```

不传 `hostProbe` 时控制组一项记为 `skip` 而不是 `pass`：
没做对照就不算验证过。同理，`exec` 返回失败（容器不存在、docker 不可用）
时，裸连与 UDP 两项也记 `skip`——把「探测没跑」当成「隔离生效」是假阳性。

`exec` 是注入点，模块本身不 spawn 任何进程。这是有意的：
所有分支都能在无 docker、无网络的机器上跑测试，
`test/egress.mjs` 里 6 项判定的正反例就是这么覆盖的。

代理是占位符时 `preflightEgress()` 直接返回 `skipped`，不发起任何连接。
首次部署（配置文件还没填）也能完整跑通，不会因为「没配代理」而失败退出。

---

## 7. 用户需要提供什么、怎么填

### 7.1 需要提供的东西

| 项目 | 必需 | 说明 |
|---|---|---|
| 20 条 SOCKS5 代理 | 是 | host / port /（可选）username+password。数量不足时缺的槽位无出口，其余照常工作 |
| 每条代理的出口 IP | 强烈建议 | `expected_exit_ip`。不填只能看到实测值，无法自动判定「对不上」 |
| 区域标注 | 否 | `region`，只用于按槽位就近分配 |
| TUN / NET_ADMIN | 否 | 方案 A 不需要。容器保持 `--cap-drop ALL` |
| root on 宿主机 | 是 | 建 docker network、写 iptables、监听 1024 以下端口（如果 dnsfwd 换到 :53） |

### 7.2 字段

`config/proxies.example.json` 里的 20 条全部填的是 RFC 5737 文档保留段
（`192.0.2.x` / `198.51.100.x` / `203.0.113.x`），是为了让你 `cp` 之后直接
`probe`、`emit` 都不会真的发起连接。**换成真实地址前不要指望它们能用**，
但规划、规则生成、蓝图落盘在这份骨架配置上都能跑通。

```json
{
  "proxies": [
    {
      "id": "p01",
      "type": "socks5",
      "host": "192.0.2.10",
      "port": 1080,
      "username": "user01",
      "password": "PASS_01",
      "region": "us-west",
      "expected_exit_ip": "47.88.12.34",
      "enabled": true
    }
  ]
}
```

| 字段 | 类型 | 必填 | 校验规则 | 填错报什么 |
|---|---|---|---|---|
| `id` | string | 是 | `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`，全局唯一 | `proxies[i].id 非法` / `proxies[i].id 重复: p01` |
| `type` | string | 是 | `socks5` \| `socks5h` | `proxies[i].type 不支持（只接受 socks5 / socks5h）` |
| `host` | string | 是 | IPv4 / IPv6 / 域名字面量 | `proxies[i].host 缺失` / `proxies[i].host 非法` |
| `port` | number | 是 | 1-65535 整数 | `proxies[i].port 非法（1-65535）` |
| `username` | string | 否 | ≤255 字节 | `proxies[i].username 超过 255 字节` |
| `password` | string | 否 | 有 password 必须同时有 username；≤255 字节 | `proxies[i].password 给了但 username 为空` |
| `region` | string | 否 | `[A-Za-z0-9 _.-]{1,32}` | `proxies[i].region 非法` |
| `expected_exit_ip` | string | 否 | 合法 IP | `proxies[i].expected_exit_ip 不是合法 IP` |
| `enabled` | bool | 否 | 缺省 true | `proxies[i].enabled 必须是布尔值` |

`socks5` 与 `socks5h` 在本方案里行为一致：域名一律由代理侧解析（`ATYP=0x03`），
不在本地解析。保留两个值是为了与上游代理软件的配置习惯对齐。

### 7.3 什么算占位符

以下值被识别为占位符，会打警告、跳过真实拨号、`expected_exit_ip` 比对跳过，
但**不会**让加载失败：

- `example.com` / `example.net` / `example.org` 及其子域
- `*.example` / `*.test` / `*.invalid` / `*.localhost`
- `1.2.3.4` / `0.0.0.0` / `127.0.0.1`
- `192.0.2.x`、`198.51.100.x`、`203.0.113.x`（RFC 5737 文档保留段）
- `2001:db8::/32`（RFC 3849 文档前缀）
- 含 `<` `>` `{` `}` 的模板串，如 `<YOUR_PROXY_HOST>`

这样设计的原因：首次部署时配置文件通常是空壳，
加载即失败会让整个进程起不来。占位符只影响「要不要花时间去探测」，
不影响规划、规则生成、蓝图落盘。

### 7.4 操作流程

```bash
cd research/reimpl

# 1. 准备配置：复制示例，替换成真实代理
cp config/proxies.example.json config/proxies.json
$EDITOR config/proxies.json

# 2. 校验结构（离线，不联网）
node src/egress/cli.mjs verify-config
# 输出：载入 20 条代理 / 可覆盖槽位 20/20，或逐条列出错误

# 3. 看 20 个槽位的规划表
node src/egress/cli.mjs plan

# 4. 生成全部产物（网络参数 / iptables 脚本 / 转发器配置）
node src/egress/cli.mjs emit --out /etc/live-api-egress
# 102 个文件：fleet.json + SUBNETS.md + 20 × (blueprint.json + 2 脚本 + 2 配置文件)

# 5. 真实探测代理健康（这一步会联网，需先替换占位符）
node src/egress/cli.mjs probe

# 6. 逐个槽位执行：建网络 → 起转发器 → 上规则 → 起容器 → verifyEgress
```

`emit` 落盘的权限：`blueprint.json` 与转发器配置是 `0600`
（内含明文凭据），`*.sh` 是 `0755`。
`fleet.json` / `SUBNETS.md` 是可自由分发的快照，只含规划与代理 id，不含凭据。

### 7.5 换代理时不动网段

槽位 id 只由序号决定（`slot-01` … `slot-20`），不由代理 id 决定。
换掉 p07 的 host，重新 `emit` 后只有 `slots/slot-07/` 下的
转发器配置变化，网段、网桥名、端口、iptables 规则全部不变。
容器不需要重建，只要重启对应 redsocks 进程。

反过来，如果网段跟着代理走，换一次代理就要重建 docker network，
已运行的容器会全部失联——这是必须避免的。

---

## 8. 模块地图

| 文件 | 职责 | 是否碰网络 |
|---|---|---|
| `src/egress/socks5.mjs` | SOCKS5 字节协议：握手、RFC 1929 认证、CONNECT、地址编码 | 只提供函数，由调用方决定是否拨号 |
| `src/egress/pool.mjs` | 配置加载、逐字段校验、占位符识别、槽位分配、健康探测 | `checkProxyHealth` 会真实拨号（可注入替换） |
| `src/egress/network.mjs` | 网段规划、网络参数、iptables 规则、redsocks / sing-box / tun2socks 配置 | 否，纯描述 |
| `src/egress/dnsfwd.mjs` | DNS over TCP over SOCKS5 转发器（udp 为可选模式） | `startDnsForwarder` 会监听端口 |
| `src/egress/verify.mjs` | 六项出口验证、占位符预检 | 通过注入的 `exec` 间接执行 |
| `src/egress/plan.mjs` | 蓝图编排：把上面五个编成可落盘的 JSON | 否 |
| `src/egress/cli.mjs` | 命令行：`plan` / `verify-config` / `emit` / `slot` / `probe` / `preflight` | 只有 `probe` 联网 |

依赖方向是单向的：`plan.mjs` → `network.mjs` + `pool.mjs`；
`verify.mjs` → `pool.mjs` + `network.mjs`；`socks5.mjs` 与 `dnsfwd.mjs` 互不依赖。
没有循环依赖，每个模块都能单独 import 测试。

测试：`node test/egress.mjs`（293 条断言，全离线）；
`node test/run-all.mjs`（全量 2025 条）。

---

## 9. 已知边界

1. **只有 TCP 走代理。** UDP 与 ICMP 被 FORWARD 兜底 DROP。
   这是隔离优先的选择：住宅 SOCKS5 基本不支持 `UDP ASSOCIATE`，
   与其挂起等超时，不如明确阻断。若代理确实支持 UDP，把 `dnsfwd` 的
   `mode` 设成 `'both'` 并放开对应 FORWARD 规则即可，改动集中在一处。
2. **redsocks 的凭据不支持特殊字符。** `login` / `password` 是带引号的 INI 值，
   含 `"` 或 `\` 无法安全表达。`redsocksConfig()` 会置 `unsafeCred: true`，
   蓝图里给出告警并提示改用 sing-box 变体（JSON 编码，无此限制）。
3. **IPv6 全链路关闭。** docker network 用 `enable_ipv6=false`，
   容器不分配 v6 地址。开了 v6 而不做 v6 的 REDIRECT，等于开了一条绕过代理的旁路。
   要支持 v6 需要把规则里的 `iptables` 全部换成 `ip6tables` 并重做地址规划。
4. **出口 IP 相同即视为失败。** 若代理出口与宿主机同 IP（极端情况），
   宿主机控制组会判失败。这是保守选择：宁可误报，也不放过「实际没走代理」。
5. **`expected_exit_ip` 是静态值。** 住宅代理的出口 IP 会轮换。
   若代理是轮换型，这一项要么留空（只记录实测值），
   要么填池内常见值并接受偶发误报。
