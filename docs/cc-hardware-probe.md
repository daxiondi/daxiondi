# Claude Code 设备标识 / 硬件信息采集逆向报告

- 目标：`@anthropic-ai/claude-code`（Anthropic 官方 CLI）
- 分析版本：`2.1.310`（当前 npm `latest`），对照版本 `1.0.88`（最后一个纯 JS 版本）
- 分析环境：
  - 静态：macOS 本地解包 + 远端 `/opt/skylink/research/inspect/cc/`
  - 动态：远端 Linux 服务器 `skylink-agent`（root），`strace`、本地 HTTP 监听、HTTP 代理
- 分析日期：2026-10-24
- 结论置信度标注：**[实测]** = strace/抓包直接观察到；**[静态]** = 仅二进制里读到代码，未观察到执行；**[未发现]** = 全量搜索无命中

> **一句话结论：Claude Code 2.1.310 不采集硬件指纹。它唯一的持久设备标识是一个 32 字节随机数，与硬件无关。真正与"设备"相关的只有 `machine-id`（仅进 OTel resource，默认不启用）与一组只读的环境/平台枚举。**

---

## 0. 目标定位与分析方法

### 0.1 包结构（重要，和题目预设不同）

`npm view @anthropic-ai/claude-code` 在 2.1.310 返回的不是一个单文件 JS：

```
$ npm view @anthropic-ai/claude-code version dist.tarball
version = '2.1.310'
dist.tarball = 'https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.310.tgz'
```

```
$ npm pack @anthropic-ai/claude-code@2.1.310 && tar tzf *.tgz
package/LICENSE.md
package/bin/claude.exe      ← 500 字节的 stub（echo 报错脚本）
package/cli-wrapper.cjs     ← postinstall 失败时的 fallback launcher
package/README.md
package/package.json
package/install.cjs         ← postinstall，按平台拷贝原生二进制
package/sdk-tools.d.ts
total files: 7
```

**从 1.x 之后，官方 main 包变成了"壳"**，真正的实现在按平台拆分的 optionalDependencies 里：

```json
// package/package.json（节选，实测）
"bin": { "claude": "bin/claude.exe" },
"dependencies": {},
"optionalDependencies": {
  "@anthropic-ai/claude-code-darwin-arm64": "2.1.310",
  "@anthropic-ai/claude-code-darwin-x64": "2.1.310",
  "@anthropic-ai/claude-code-linux-x64": "2.1.310",
  "@anthropic-ai/claude-code-linux-arm64": "2.1.310",
  "@anthropic-ai/claude-code-linux-x64-musl": "2.1.310",
  "@anthropic-ai/claude-code-linux-arm64-musl": "2.1.310",
  "@anthropic-ai/claude-code-win32-x64": "2.1.310",
  "@anthropic-ai/claude-code-win32-arm64": "2.1.310"
}
```

`install.cjs` 的文件头注释直接说明了这一设计：

```js
// Detects the platform, finds the matching native binary from optionalDependencies,
// and copies it over the bin/claude.exe placeholder. After this runs, `claude` execs
// the native binary directly — no Node.js process stays resident.
```

下载 Linux 原生包后：

```
$ npm pack @anthropic-ai/claude-code-linux-x64@2.1.310
-rw-r--r-- 1 root root 131844169  anthropic-ai-claude-code-linux-x64-2.1.310.tgz

$ tar xzf ... && file package/claude
package/claude: ELF 64-bit LSB executable, x86-64, dynamically linked,
  interpreter /lib64/ld-linux-x86-64.so.2, BuildID[sha1]=b47f28de6c0d...,
  not stripped
-rwxr-xr-x 1 root root 291638640  package/claude     ← 解包后 278 MB
```

**运行时不是 Node.js，是 Bun。** 二进制里 `Bun/1.4.4` 字符串 + `.bun` / `__BUN` / `.bun_builtins` 段可以直接确认。JS 源码以 Bun 的虚拟文件系统形式打包在 `/$bunfs/root/` 下，`strings`/grep 可以直接抓到明文 JS 片段（有 `// @bun @bytecode` 标记的模块是字节码，无标记的是明文）。

### 0.2 三个证据源

| 证据源 | 获取方式 | 用途 |
|---|---|---|
| **1.0.88 纯 JS** | `npm pack @anthropic-ai/claude-code@1.0.88`，得 `package/cli.js`（9.0 MB，3544 行，webpack 单文件） | 逻辑完整可读，用于理解算法与数据流 |
| **2.1.310 原生二进制** | `npm pack @anthropic-ai/claude-code-linux-x64@2.1.310` | 当前实际发行版，`/$bunfs` 内明文 JS 直接可读 |
| **运行时系统调用** | `strace -f -e trace=openat,open,execve,readlink,...` + 本地 HTTP 监听 + HTTP 代理 | **最硬证据**，区分"有代码"与"真的执行" |

### 0.3 关键方法说明：如何证明"真的读了"

静态看到 `/proc/cpuinfo` 这类字符串**不等于**它被读取——Bun 运行时和 JSC 引擎本体自带大量路径常量（libuv 的 `uv_cpu_info` 等），grep 会大量误报。

因此本报告对每个字段都做了 `strace` 交叉验证。示例判据：

```
# "/proc/cpuinfo" 在二进制里命中 1 次，但上下文是 libuv 的符号表：
... JSC_minEdenToOldGenerationRatio prio *.cpio ... /proc/cpuinfo uv_getaddrinfo
    uv_freeaddrinfo /proc/meminfo matchinfo ... uv_getnameinfo ... uv_cpu_info

# 而实际运行中 trace 里完全没有它：
$ grep -c cpuinfo /tmp/cc-full.strace   →   0
```

**结论：`/proc/cpuinfo`、`/proc/meminfo` 属于 Bun/libuv 引擎常量，Claude Code 的应用层从不读取。**

---

### 0.4 第四次独立复跑（对结论的稳定性验证）

为避免单次运行偶然性，用不同 `HOME` 独立复跑一次，只 trace `openat` + `execve`：

```
$ HOME=/tmp/cc-v4 strace -f -qq -e trace=openat,execve -o /tmp/cc-v4.strace \
        ./package/claude -p "hi"

cpuinfo   读取次数: 0
meminfo   读取次数: 0
dmi       读取次数: 0
sys/class/net 读取次数: 0        ← MAC 也确认不读
machine-id 读取次数: 1
os-release 读取次数: 2
```

明细（**与前一节完全一致，结论可稳定复现**）：

```
3302130 openat(AT_FDCWD, "/etc/os-release", O_RDONLY|O_NOCTTY|O_LARGEFILE|O_CLOEXEC <unfinished ...
3302137 openat(AT_FDCWD, "/etc/machine-id", O_RDONLY|O_NOCTTY|O_LARGEFILE|O_CLOEXEC) = 17
3302132 openat(AT_FDCWD, "/etc/os-release", O_RDONLY|O_NONBLOCK|O_LARGEFILE|O_CLOEXEC) = 17

3302143 execve("/usr/bin/sh",    ["sh","-c","uname -s\nuname -r\nuname -m\nfor c"...]) = 0
3302144 execve("/usr/bin/uname", ["uname","-s"], ...) = 0
3302145 execve("/usr/bin/uname", ["uname","-r"], ...) = 0
3302146 execve("/usr/bin/uname", ["uname","-m"], ...) = 0
```

`os-release` 读 2 次是因为 `-p` 模式下有两条独立代码路径（遥测 env 组装 + 部署环境判定）各读一次。

---

## 1. 数据源逐项清单

### 1.1 汇总表

| # | 数据源 | 路径 / API | 读取方式 | 运行时实测 | 进入设备 ID？ | 上报？ |
|---|---|---|---|---|---|---|
| 1 | 持久设备标识 `device_id` | `~/.claude.json` → `userID` | `fs` + `crypto.randomBytes(32)` | ✅ | **是（唯一来源）** | **✅ 每次 API 请求 + 遥测** |
| 2 | `machine-id` | `/etc/machine-id`<br>`/var/lib/dbus/machine-id` | `fs.promises.readFile` | ✅ 读到 | 否 | ⚠️ 仅 OTel resource（默认关） |
| 3 | `machine-id`（另一个用途） | `/etc/machine-id` + `/proc/self/ns/pid` | `fs.readFile` + `readlink` | ✅ | 否 | ❌ 本地用途（PID 域隔离） |
| 4 | 内核名/版本/架构 | `sh -c "uname -s; uname -r; uname -m"` | `child_process.exec` | ✅ execve 观察到 | 否 | **✅ 遥测 env** |
| 5 | 发行版 | `/etc/os-release` | `fs.readFile` + 正则 `^ID=`/`^ID_LIKE=` | ✅ 读到 | 否 | **✅ 遥测 env** |
| 6 | 虚拟化 UUID | `/sys/hypervisor/uuid` | `fs.readFile` | ✅ 尝试（ENOENT） | 否 | **✅（间接，只取 `ec2` 前缀）** |
| 7 | 容器检测 | `/.dockerenv` | `fs.access` | ✅ 尝试 | 否 | **✅ `deployment_environment`** |
| 8 | WSL 检测 | `/proc/sys/fs/binfmt_misc/WSLInterop` | `fs.access` | ✅ 尝试 | 否 | **✅** |
| 9 | 主机名 | `os.hostname()` | Bun `os` 模块 | [静态] OTel 内 | 否 | ❌ 仅 OTel（默认关） |
| 10 | 架构 / 平台 / 内核 release | `os.arch()` / `os.platform()` / `os.release()` | Bun `os` 模块 | [静态] OTel 内 | 否 | ❌ 仅 OTel（默认关） |
| 11 | Bun/google-cloud 检测 | `/sys/class/dmi/id/bios_date`<br>`/sys/class/dmi/id/bios_vendor` | `fs.statSync` + `readFileSync` | ❌ **未触发** | 否 | ❌ |
| 12 | 进程/内存指标 | `process.memoryUsage()`、`process.cpuUsage()`、`process.uptime()` | Node/Bun process | ✅ | 否 | **✅ 遥测 `process` 字段** |
| 13 | 环境变量白名单 | 见 §1.9 | `process.env` | ✅ | 否 | **✅ 遥测 `env` 字段** |
| 14 | 终端/IDE 指纹 | `TERM`、`TERM_PROGRAM`、`VSCODE_GIT_ASKPASS_MAIN` 等 | `process.env` | ✅ | 否 | **✅** |
| 15 | 包管理器/运行时 | `command -v npm yarn pnpm bun deno node` | `sh -c` | [静态] | 否 | **✅** |
| 16 | cgroup 限额 | `/sys/fs/cgroup/*/cpu.max`、`memory.max` | Bun 引擎 | ✅ | 否 | ❌ 引擎自用 |
| 17 | CPU 在线数 | `/sys/devices/system/cpu/online` | Bun 引擎 | ✅ | 否 | ❌ 引擎自用 |
| 18 | **磁盘序列号** | — | — | — | — | **[未发现]** |
| 19 | **MAC 地址** | — | — | — | — | **[未发现]**（见 §1.10） |
| 20 | **GPU / 显卡信息** | — | — | — | — | **[未发现]**（见 §1.11） |
| 21 | **TPM** | — | — | — | — | **[未发现]** |
| 22 | **`/sys/class/dmi/id/product_uuid` 等** | — | — | — | — | **[未发现]** |
| 23 | **`id-` 开头的持久化标识文件** | — | — | — | — | **[未发现]** |

---

### 1.2 持久设备标识：`device_id` —— 唯一的设备 ID，且是纯随机数

**这是全报告最重要的结论。**

`device_id` 的值来自函数 `_H()`（1.0.88 中叫 `dr()`）。2.1.310 反编译片段：

```js
// 2.1.310, /$bunfs 内明文 JS
var Ys=/^[0-9a-f]{64}$/;
function _H(e,n){
  let r=Se(), s=ue();
  if(typeof s.userID==="string" && Ys.test(s.userID)) return s.userID;   // ① 已是 64 位 hex，直接用
  if(r.generatedUserID) return r.generatedUserID;                        // ② 进程内缓存
  let h = n!==void 0 && Ys.test(n) ? n : dd(32).toString("hex");         // ③ 随机生成
  return r.setGeneratedUserID(h), Re((y)=>({...y,userID:h}), e), h;
}
function GEt(e){                                                          // machineID 同理
  let n=Se(), r=ue();
  if(typeof r.machineID==="string" && Ys.test(r.machineID)) return r.machineID;
  if(n.generatedMachineID) return n.generatedMachineID;
  let s=dd(32).toString("hex");                                          // 也是随机！
  return n.setGeneratedMachineID(s), Re((h)=>({...h,machineID:s}), e), s;
}
```

对照 1.0.88 的同名逻辑，完全一致：

```js
// 1.0.88, package/cli.js
function dr(){
  let A=z0();
  if(A.userID) return A.userID;
  let B=hi4(32).toString("hex");     // hi4 = require("crypto").randomBytes
  return _A({...A,userID:B}), B
}
```

`hi4` 就是 `import{randomBytes as hi4}from"crypto"`。

**判据：`device_id` = `crypto.randomBytes(32).toString("hex")`，64 个十六进制字符。任何硬件字段都不参与，没有任何哈希拼接。**

落盘位置：`~/.claude.json` 顶层 `userID` 字段（同目录还有 `machineID`，同样随机）。实测：

```json
// /tmp/cc-cap2/.claude.json（实测生成）
{
  "firstStartTime": "2026-10-24T01:15:01.061Z",
  "machineID": "d0c93b0331a9ce680187c99ad75989324e3e6f188d04150a7dba8c35be0d6ca8",
  "userID":    "dc3db1c3c533a501701ecba6af6326a222da0e89d4fa15197972d7ec829f3748"
}
```

**含义：删掉 `~/.claude.json` 就换了一个"设备"，硬件完全不变。反过来，换机器拷贝这个文件，服务端看到的还是同一个"设备"。**

注意 `machineID` 这个名字极具误导性——它**不是**系统 machine-id，也是随机数。

---

### 1.3 `machine-id`（两种独立用途）

一条 64 位 hex 的随机 `device_id` 之外，`/etc/machine-id` 确实被读取，但**有两个互不相关的读取点**，且都不参与 `device_id`。

#### 用途 A：OpenTelemetry `host.id`（默认不启用）

```js
// 2.1.310, OTel host detector（/$bunfs 内）
var d=x(function(i){
  i.getMachineId=void 0;
  var t=Fe("fs"), r=fl();
  async function s(){
    let c=["/etc/machine-id","/var/lib/dbus/machine-id"];
    for(let a of c) try{ return (await t.promises.readFile(a,{encoding:"utf8"})).trim() }
    catch(e){ r.diag.debug(`error reading machine id: ${e}`) }
    return
  }
  i.getMachineId=s
});
```

挂到 resource 上：

```js
// hostDetector
class wy{
  detect(e){
    return { attributes: {
      [ht.ATTR_HOST_NAME]: nn.hostname(),                        // os.hostname()
      [ht.ATTR_HOST_ARCH]: Ty.normalizeArch(nn.arch()),          // os.arch()
      [ht.ATTR_HOST_ID]:   Sy.getMachineId()                     // /etc/machine-id
    }}
  }
}
// osDetector
class ky{
  detect(e){
    return { attributes: {
      [rn.ATTR_OS_TYPE]:    vy.normalizeType(on.platform()),     // os.platform()
      [rn.ATTR_OS_VERSION]: on.release()                         // os.release()
    }}
  }
}
// processDetector：pid / title / execPath / argv / versions.node / userInfo().username
```

**但**：整个 `detectResources` 在 2.1.310 中**从未被调用**。

```
$ grep -c "detectResources(" package/claude
0
```

`$bunfs` 里 `detectResources` 只作为 export 存在（`xe.detectResources=gK`），没有调用点。OTel 部分整体被编译进包是因为 Claude Code 用它做**用户自建的 OTel 导出**（`CLAUDE_CODE_ENABLE_TELEMETRY` 配合 `OTEL_EXPORTER_OTLP_*` 把数据发到**用户自己的** collector），而不是发往 Anthropic。

**运行时验证**：即使显式打开 `CLAUDE_CODE_ENABLE_TELEMETRY=1`，也不读 machine-id：

```
$ CLAUDE_CODE_ENABLE_TELEMETRY=1 strace -f -e trace=openat ./claude --version
$ grep -c machine-id /tmp/cc-tel.strace
0
$ grep -c dmi /tmp/cc-tel.strace
0
```

> **判定：`host.id` / `host.name` / `os.*` 这条链路属于「有代码，但当前版本未启用」。**

#### 用途 B：PID 命名空间隔离（本地用途，不上报）

```js
// 2.1.310
async function tii(n){
  if(n==="windows") return `linux:${i().toLowerCase()}`;
  if(n!=="linux" && n!=="wsl") return "linux";
  let[e,t]=await Promise.all([
    r("/etc/machine-id","utf8").then(o=>o.trim(),()=>""),
    s("/proc/self/ns/pid").catch(()=>"")
  ]);
  return `linux:${e}:${t}`
}
```

返回值写进会话状态文件的 `pidDomain` 字段：

```js
function eii(n){ ...
  return { cwd:..., startedAt:..., procStart:..., kind:..., sessionId:...,
           entrypoint:..., ...typeof e.pidDomain==="string" && {pidDomain:e.pidDomain} }
}
```

同文件里还有 `procStart`、`sessionId`、`cwd`、`status`、`kind`（`["interactive","bg","daemon","daemon-worker"]`）——这是**多会话/后台 agent 的 PID 复用防护**（机器重启后 PID 会复用，需要 machine-id + pid-ns 判断"这个 session 文件还是不是我的"）。

**用途 B 完全不进遥测。** 实测这是 `--version` 之外唯一真实的 machine-id 读取：

```
$ grep -a "machine-id" /tmp/cc-full.strace
3242066 openat(AT_FDCWD, "/etc/machine-id", O_RDONLY|O_NOCTTY|O_LARGEFILE|O_CLOEXEC) = 17
$ grep -a "ns/pid" /tmp/cc-full.strace
3242063 readlink("/proc/self/ns/pid", "pid:[4026531836]", 4096) = 16
```

macOS / Windows / FreeBSD 的对应实现（说明这是跨平台的标准库级抽象，不是针对性采集）：

```js
// darwin
let B=(await Ye6.execAsync('ioreg -rd1 -c "IOPlatformExpertDevice"')).stdout
        .split(`\n`).find(Z=>Z.includes("IOPlatformUUID"));
let Q=B.split('" = "'); if(Q.length===2) return Q[1].slice(0,-1)
// freebsd
(await r.promises.readFile("/etc/hostid",{encoding:"utf8"})).trim()
   || (await i.execAsync("kenv -q smbios.system.uuid")).stdout.trim()
// win32
execAsync(`${B} QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid`)
```

---

### 1.4 `uname`（真执行，进遥测）

这是**唯一通过外部进程采集的硬件相关数据**。

二进制内常量（`PROBE_SCRIPT` 与几条并行的探测脚本）：

```
uname -s
uname -r
uname -m
for c in npm yarn pnpm; do command -v "$c" >/dev/null 2>&1 && printf "%s," "$c"; done; echo
for c in bun deno node; do command -v "$c" >/dev/null 2>&1 && printf "%s," "$c"; done; echo
```

**运行时 execve 实测（最硬证据）**：

```
$ strace -f -e trace=execve ./package/claude -p "hi"
3277119 execve("/usr/bin/sh", ["sh","-c","uname -s\nuname -r\nuname -m\nfor c"...],
               0x29507cd6c80 /* 25 vars */) = 0
3277120 execve("/usr/bin/uname", ["uname","-s"], ...) = 0
3277121 execve("/usr/bin/uname", ["uname","-r"], ...) = 0
3277122 execve("/usr/bin/uname", ["uname","-m"], ...) = 0
```

结果落进遥测 `env` 字段（见 §1.12 实测 payload）。注意 `uname -n`（主机名）**没有**被执行。

同类但走 Node `os` 的架构/平台读取（`S.platform`、`S.arch`）在 2.1.310 中是编译期烘死的字符串：

```js
var S={ probeInternalNetworkAccess:V_, isCI:Ne(!1),
        platform:["win32","darwin"].includes("linux")?"linux":"linux",
        arch:"x64",
        nodeVersion:process.version, terminal:z_(), isSSH:q, ... }
```

`process.version` 在 Bun 下报的是 **`v26.3.0`**（Bun 为了兼容性伪装成 Node 26），而 `X-Stainless-Runtime-Version` 头同样报 `v26.3.0`。实际运行时是 Bun 1.4.4。

---

### 1.5 `/etc/os-release`（真读，进遥测）

```
$ grep -a "os-release" /tmp/cc-full.strace
3242062 openat(AT_FDCWD, "/etc/os-release", O_RDONLY|O_NOCTTY|O_LARGEFILE|O_CLOEXEC <unfinished ...
3242069 openat(AT_FDCWD, "/etc/os-release", O_RDONLY|O_NONBLOCK|O_LARGEFILE|O_CLOEXEC) = 19
```

解析正则（二进制内紧邻的字符串常量）：

```
/etc/os-release
^ID=["']?(\S+?)["']?\s*$
^ID_LIKE=["']?(.+?)["']?$
idLike
debian
```

产出 `linux_distro_id` / `linux_distro_version`，实测值 `"ubuntu"` / `"22.04"`，内核 `"5.15.0-164-generic"`。

---

### 1.6 `/sys/hypervisor/uuid`（真尝试，只取前缀）

```js
class Q{
  primedHypervisorUuid; fallbackHypervisorUuid;
  hypervisorUuid(){ return this.primedHypervisorUuid ?? (this.fallbackHypervisorUuid ??= this.sources.readHypervisorUuidSync()??"") }
  isDockerenvPresent(){ return this.primedDockerenvExists ?? (this.fallbackDockerenvExists ??= this.sources.dockerenvExistsSync()) }
  async prime(){
    if(this.primedWslInteropExists!==void 0||N())return;
    let[t,o,_]=await Promise.all([
      H("/proc/sys/fs/binfmt_misc/WSLInterop").then(()=>!0,()=>!1),
      W_("/sys/hypervisor/uuid",{encoding:"utf8"}).then(r=>r.trim().toLowerCase(),()=>{}),
      H("/.dockerenv").then(()=>!0,()=>!1)
    ]);
    this.primedWslInteropExists=t, this.primedHypervisorUuid=o??"", this.primedDockerenvExists=_
  }
}
```

```js
function q_(t){                                     // detectDeploymentEnvironment
  if(Ne(process.env.CODESPACES)) return "codespaces";
  ...
  if(t.hypervisorUuid().startsWith("ec2")) return "aws-ec2";   // ← 只判断前缀
  ...
  if(t.isDockerenvPresent()) return "docker";
  if(S.platform==="darwin") return "unknown-darwin";
  if(S.platform==="linux")  return "unknown-linux";
  return "unknown"
}
```

**关键点：`/sys/hypervisor/uuid` 的完整 UUID 不会离开进程。** 只有 `startsWith("ec2")` 这个布尔判断结果，最终变成枚举值 `"aws-ec2"`，和 `"docker"` / `"kubernetes"` / `"codespaces"` 等平级。

实测（该宿主机不是 EC2）：

```
3242062 access("/.dockerenv", F_OK) = -1 ENOENT
3242063 access("/proc/sys/fs/binfmt_misc/WSLInterop", F_OK) = -1 ENOENT
3242063 openat(AT_FDCWD, "/sys/hypervisor/uuid", O_RDONLY|O_NOCTTY|O_LARGEFILE|O_CLOEXEC) = -1 ENOENT
3242066 openat(AT_FDCWD, "/sys/hypervisor/uuid", O_RDONLY|O_NONBLOCK|O_LARGEFILE|O_CLOEXEC) = -1 ENOENT
```

遥测里最终输出 `"deployment_environment":"unknown-linux"`。

---

### 1.7 `os.hostname()` / `os.arch()` / `os.platform()` / `os.release()`

**只出现在两处，都是「有代码但不上报给 Anthropic」：**

1. OTel detectors（§1.3 用途 A，`detectResources` 无调用点）。
2. Sentry 错误上报的 tag / extra：

```js
// 2.1.310 error reporter
service:I, hostname:"claude-code",                 // ← 写死的，不是 os.hostname()
status:"error", message:`${o}: ${a}`.slice(0,4000),
timestamp:new Date().toISOString(),
error:{kind:o, message:a.slice(0,4000), stack:A.slice(0,16000), fingerprint:T, handling:...},
version:l, sourcemap_group:C, env:"external", user_bucket:E, origin:r,
host_platform:O(),                                  // 枚举
host_os_release:h,                                  // os.release()
host_name_redacted: GEt().slice(0,12),              // ← 注意！不是主机名
entrypoint:f,
node_version:process.versions.node,
bun_version:"1.4.4",
```

**`host_name_redacted` 是个陷阱**：名字暗示主机名，实际是 `GEt()`——那个**随机 `machineID`** 的前 12 个字符。真实的 `os.hostname()` 在 Sentry 路径里没有出现，`hostname` 字段被硬编码成 `"claude-code"`。

---

### 1.8 `/proc/*`、`/sys/*` 全量清单与归属

对二进制做 `/sys` 与 `/proc` 路径正则全量提取，再逐个用 strace 判定归属：

| 路径 | 二进制中出现 | 运行时读到 | 归属 |
|---|---|---|---|
| `/proc/cpuinfo` | ✅ 1 处 | ❌ | **Bun/libuv 引擎常量**（紧邻 `uv_cpu_info`/`uv_free_cpu_info`） |
| `/proc/meminfo` | ✅ 8 处 | ❌ | **Bun/libuv 引擎常量**（紧邻 `uv_getaddrinfo`/`uv_getnameinfo`） |
| `/proc/version` | ✅ 10 处 | — | libuv / 各库版本探测 |
| `/proc/self/stat` | ✅ | ✅（高频） | Bun 运行时自用 |
| `/proc/self/statm` | ✅ | ✅ | Bun 内存统计 |
| `/proc/self/maps` | ✅ | ✅ | Bun JIT/内存管理 |
| `/proc/self/cgroup` | ✅ | ✅ | Bun 容器感知 |
| `/proc/self/uid_map`、`gid_map`、`setgroups` | ✅ | ✅ | Bun 沙箱/用户命名空间 |
| `/proc/sys/vm/overcommit_memory` | ✅ | ✅ | Bun 分配器初始化 |
| `/proc/sys/vm/mmap_min_addr` | ✅ | ✅ | Bun JIT 地址选择 |
| `/proc/sys/fs/file-max`、`inotify/max_user_watches` | ✅ | — | Bun 文件监听 |
| `/proc/sys/user/max_user_namespaces` | ✅ | — | Bun 沙箱探测 |
| `/proc/sys/kernel/apparmor_restrict_unprivileged_userns` | ✅ | — | Bun 沙箱探测 |
| `/proc/sys/kernel/overflowuid` | ✅ | — | libc |
| `/proc/sys/fs/binfmt_misc/WSLInterop` | ✅ | ✅ access | **Claude 应用层**（WSL 检测） |
| `/proc/self/ns/pid` | ✅ | ✅ readlink | **Claude 应用层**（PID 域） |
| `/proc/net/tcp`、`tcp6`、`sockstat` | ✅ | — | 网络工具/诊断函数，非遥测 |
| `/proc/pressure/memory` | ✅ | — | Bun |
| `/proc/driver/nvidia/version` | ✅ | — | **build-tools 探测**（见 §1.11） |
| `/proc/1/cgroup` | ✅ | — | 容器检测辅助 |
| `/sys/devices/system/cpu/online` | ✅ | ✅ | Bun 并行度 |
| `/sys/devices/system/node/nodeN` | ✅ | ✅ access | Bun NUMA |
| `/sys/fs/cgroup/*/cpu.max`、`memory.max`、`memory.high` | ✅ | ✅ | Bun 资源限额 |
| `/sys/kernel/mm/transparent_hugepage/enabled` | ✅ | ✅ | Bun 分配器 |
| `/sys/class/dmi/id/bios_date` | ✅ | ❌ | **`@google-cloud/gcp-residency` 库常量**（见下） |
| `/sys/class/dmi/id/bios_vendor` | ✅ | ❌ | 同上 |
| `/sys/hypervisor/uuid` | ✅ | ✅（ENOENT） | **Claude 应用层** |

#### `/sys/class/dmi/id` 的真相

`grep /sys/class/dmi/id` 确实命中，但上下文是 Google Cloud 的 GCP-residency 检测库，被 `@anthropic-ai` 的 Vertex AI 支持路径间接引入：

```js
gn.GCE_LINUX_BIOS_PATHS = {
  BIOS_DATE:   "/sys/class/dmi/id/bios_date",
  BIOS_VENDOR: "/sys/class/dmi/id/bios_vendor"
};
var $c=/^42:01/;
function hn(){                                   // isGoogleComputeEngineLinux
  if(Gt.platform()!=="linux") return !1;
  try{
    Mt.statSync(gn.GCE_LINUX_BIOS_PATHS.BIOS_DATE);
    let e=Mt.readFileSync(gn.GCE_LINUX_BIOS_PATHS.BIOS_VENDOR,"utf8");
    return /Google/.test(e)                      // ← 只判 /Google/，不取内容
  }catch{ return !1 }
}
function fn(){                                   // isGoogleComputeEngineMACAddress
  let e=Gt.networkInterfaces();
  for(let B of Object.values(e)){ if(!B) continue;
    for(let{mac:Q}of B) if($c.test(Q)) return !0 }   // ← 只判 42:01 前缀
  return !1
}
```

- `product_uuid` / `board_serial` / `chassis_serial` / `product_serial`：**0 命中**。
- 只读 `bios_date` 做 stat、`bios_vendor` 做 `/Google/` 正则，**内容不外泄**。
- 默认 `--version` 和 `-p` 两种模式下 strace 均**未触发**：

```
$ grep -c dmi /tmp/cc-full.strace   → 0
$ grep -c dmi /tmp/cc-exec.strace   → 0
```

> **判定：`/sys/class/dmi/id/*` 属于「有代码，未启用」。仅在用户配置 Vertex AI 后端时才可能走到。**

---

### 1.9 环境变量白名单（真读，进遥测）

2.1.310 的遥测插件里有一份**精确的白名单**，这是判断"它关心什么环境"的权威依据：

```
CLAUDE_CODE_*, ANTHROPIC_*, AWS_*, AZURE_*, GOOGLE_*, GCP_*, ...
CODESPACES, CODEBUILD*, C9_PID, C9_USER, DEVPOD, DEVPOD_WORKSPACE_UID,
DAYTONA_WS_ID, FLY_APP_NAME, FLY_MACHINE_ID, RAILWAY_*, RENDER, NETLIFY,
DYNO, VERCEL, CF_PAGES, DENO_DEPLOYMENT_ID, K_SERVICE, SPACE_CREATOR_USER_ID,
REPL_ID, REPL_SLUG, PROJECT_DOMAIN, KUBERNETES_SERVICE_HOST,
GITHUB_ACTIONS, GITHUB_ACTOR, GITHUB_ACTOR_ID, GITHUB_EVENT_NAME,
GITHUB_REPOSITORY_ID, GITHUB_REPOSITORY_OWNER_ID, GITLAB_CI, GITPOD_WORKSPACE_ID,
CIRCLECI, BUILDKITE, RUNNER_ENVIRONMENT, RUNNER_OS,
GNOME_TERMINAL_SERVICE, GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_WORKSTATIONS,
HOME, USERPROFILE, KITTY_WINDOW_ID, KONSOLE_VERSION, MSYSTEM,
NODE_ENV, OS, P4PORT, PROCESSOR_ARCHITECTURE,
SESSIONNAME, SHELL, SSH_CLIENT, SSH_CONNECTION, SSH_TTY,
STY, SWE_BENCH_INSTANCE_ID, SWE_BENCH_RUN_ID, SWE_BENCH_TASK_ID,
TERM, TERMINAL_EMULATOR, TERMINATOR_UUID, TERM_PROGRAM, TILIX_ID, TMUX,
USER_TYPE, VSCODE_GIT_ASKPASS_MAIN, VTE_VERSION, VisualStudioVersion,
WEBSITE_SITE_NAME, WEBSITE_SKU, WSL_DISTRO_NAME, WT_SESSION,
XTERM_VERSION, __CFBundleIdentifier
```

注意其中 **`HOME` 和 `USERPROFILE`** 在列表里（配置文件路径需要），但实测遥测 `env` 字段里**没有**输出它们——白名单是"允许读取"的集合，实际输出由 `environmentFieldsOf` 过滤。

另外有一份**出站域名白名单**（沙箱/网络策略用，非采集）：

```
*.anthropic.com      *.claude.com        releases.claude.com
www.google.com       *.gstatic.com       redirector.gvt1.com   *.gvt1.com
www.claudeusercontent.com  *.claudemcpcontent.com  sandbox.claudemcpcontent.com
assets.claude.ai     *.sentry.io         o1158394.ingest.us.sentry.io
oauth2.googleapis.com  sts.googleapis.com  iamcredentials.googleapis.com
browser-intake-datadoghq.com  browser-intake-us3-datadoghq.com  ...
```

---

### 1.10 MAC 地址：确认不采集

二进制里 `networkInterfaces` 命中 11 次，**全部是 Bun 的 `node:os` 垫片实现和 GCP 检测**，Claude 应用层没有：

```js
// Bun 的 node:os 垫片（自动生成代码）
networkInterfaces: function() { return binding.networkInterfaces(); },
```

```js
// GCP 检测（唯一业务用途，只判前缀）
function fn(){ let e=Gt.networkInterfaces();
  for(let B of Object.values(e)){ if(!B) continue;
    for(let{mac:Q}of B) if(/^42:01/.test(Q)) return !0 }
  return !1 }
```

`macAddress` 字符串只出现在 Bun 的**嵌入式 Arduino 兼容 API 列表**里（`analogRead`/`digitalWrite`/`motorsWrite`/`macAddress`… 同一批），与遥测无关。

**strace 无任何 `/sys/class/net` 或 `/proc/net/dev` 读取。判定：不采集 MAC。**

---

### 1.11 磁盘 / GPU / TPM：确认不采集

全量字符串搜索（`package/claude`，278 MB）：

```
diskutil          0      system_profiler   0      lsblk        0
hdparm            0      blkid             0      dmidecode    0
DMIDecode         0      nvml              0      /dev/tpm     0
IOPlatformSerialNumber  0
wmic diskdrive    0      Win32_DiskDrive   0      Win32_BaseBoard  0
SMBios            0
```

- **磁盘序列号**：无任何实现。`serialNumber` 的 31 次命中全在无关上下文（SSL 证书、JSON schema）。
- **TPM**：`tpm` 的 8 次命中全部是误报——3 次是 `/$bunfs/root/chunk-kzctpmqf.js` 这类 chunk 文件名里的 `ctpm`，其余是 MIME 类型表、x87 浮点指令表（`fptan`/`fprem`…）。
- **GPU**：`nvidia-smi` 命中 2 次，上下文是 **build-tools 探测列表**，和 `carthage, adb, sdkmanager, flutter, dart, xcodes, kubectl, helm, terraform, bazel, nix, conda, mamba, pipx, podman, nerdctl, psql, mysql, redis-cli` 并列：

```js
var G=["swift","xcodebuild","xcrun","pod","fastlane","carthage","adb","emulator",
       "sdkmanager","flutter","dart","xcodes","kubectl","helm","terraform","bazel",
       "bazelisk","nix","conda","mamba","pipx","podman","nerdctl","nvidia-smi",
       "psql","mysql","redis-cli",...];
var q="/System/Library/CoreServices/SystemVersion.plist",
    y="/Applications",
    W="/Library/Developer/CommandLineTools/usr/bin",
    Z="/usr/local/cuda/version.json",
    K="/proc/driver/nvidia/version";
```

用途是 `getDetectedBuildTools()`（判断用户装了什么构建工具，用于工具调用优化和统计），**只上报工具名集合，不读显卡型号、不在显存/GPU UUID 上做任何事**。strace 中 `/proc/driver/nvidia/version` 未被打开。

---

### 1.12 `id-` 开头的持久化标识文件：确认不存在

Claude Code 的全部持久状态都在 `~/.claude.json`（全局）与 `~/.claude/`（目录）下，实测：

```
~/.claude.json                        ← userID / machineID / numStartups / firstStartTime
~/.claude/.credentials.json           ← OAuth 凭据
~/.claude/policy-limits.json
~/.claude/remote-settings.json
~/.claude/settings.json
~/.claude/skills/
~/.claude/sessions/
~/.claude/projects/
~/.claude/telemetry/                  ← 未发出的遥测批次
~/.claude/.last-cleanup
```

**没有任何 `id-*` 形式的标识文件**，也没有 `.device-id`、`installation-id` 之类。持久标识只有 `~/.claude.json` 里那两个随机 hex。

---

## 2. 设备 ID 的组合方式

**没有组合，也没有哈希。**

```
device_id  =  crypto.randomBytes(32).toString("hex")     ← 64 位 hex
              首次运行时生成，写进 ~/.claude.json 的 userID，之后一直复用
```

对照：所有"看起来像组合"的地方都是别的东西：

| 看到的表达式 | 实际是什么 | 是否含硬件 |
|---|---|---|
| `_H()` → `deviceId` | 随机 bytes(32) | ❌ |
| `GEt()` → `machineID` | 随机 bytes(32) | ❌ |
| `h5o()` → `summonSidKey` | 随机 bytes(32) | ❌ |
| `oV(e,n)` = `sha256(n).base64url().slice(0,22)` | 遥测队列文件名去重（`flat-migration.*`） | ❌ |
| `Ce()` = `sha256(gitRemote).slice(0,16)` | 去敏后的 git remote 哈希，用作仓库标识 | ❌ |
| `customUserCacheKeyFunc` = `sha1(key+userID).slice(0,10)` | Statsig（1.0.88）本地缓存键 | ❌ |
| `tii()` = `linux:${machine-id}:${pid-ns}` | 本地 PID 域隔离 | ✅ 但不上报 |

**`device_id` 与 `account_uuid`、`session_id` 一起组成 `metadata.user_id`，但这是 JSON 拼装，不是哈希：**

```js
let y={ ...f&&{ti:f},
        device_id:_H(),
        account_uuid: Ne(i.CLAUDE_CODE_REMOTE)&&i.CLAUDE_CODE_ACCOUNT_UUID
                      || rA()?.accountUuid || gn()?.accountUuid || "",
        session_id:q(),
        ...m&&{parent_session_id:m},
        ...h&&{tk:h} };
let S={...d,...r,...y};
return { user_id:_(S) }        // _() = JSON.stringify
```

实测请求体（本地 HTTP 监听）：

```json
{"model":"claude-opus-5-5",
 "metadata":{"user_id":"{\"device_id\":\"dc3db1c3c533a501701ecba6af6326a222da0e89d4fa15197972d7ec829f3748\",\"account_uuid\":\"\",\"session_id\":\"37a44464-0a4b-4161-8b8b-101a9309a1f6\"}"}}
```

`programmatic` 场景还有匿名化保护（`_1`/`h1`）：发送前用 protobuf schema 白名单过滤 `additional_metadata` 的 base64 内容。

---

## 3. 上报端点与时机

### 3.1 三条通道

| 通道 | 端点 | 时机 | 内容 | 实测 |
|---|---|---|---|---|
| **A. 业务 API** | `https://api.anthropic.com/v1/messages?beta=true` | **每一次模型请求** | `metadata.user_id`（device_id + account_uuid + session_id）<br>HTTP 头：`User-Agent: claude-cli/2.1.310 (external, sdk-cli)`、`X-Claude-Code-Session-Id`、`X-Stainless-Arch: x64`、`X-Stainless-OS: Linux`、`X-Stainless-Runtime-Version: v26.3.0`、`x-app: cli` | ✅ 抓包确认 |
| **B. 第一方遥测** | `https://api.anthropic.com/api/event_logging/v2/batch` | 启动 + 事件驱动，100 ms 批窗，200 条/批，失败重试 8 次（500 ms→30 s 退避），退出时 flush | `tengu_*` 事件，含完整 `env` / `process` / `device_id` | ✅ 队列文件确认 |
| **C. 错误上报** | `o1158394.ingest.us.sentry.io` | 异常/崩溃时 | `host_platform`、`host_os_release`、`host_name_redacted`（=machineID 前 12 位）、`node_version`、`bun_version`、stack | [静态] 未主动触发 |

**代理实测只看到业务 API（因为 API key 无效，遥测批次进了失败队列而不是发出）：**

```
$ HTTPS_PROXY=http://127.0.0.1:8897 claude -p "hi"
CONNECT api.anthropic.com:443          ← 唯一出站
```

`Statsig`（1.0.88 里的 `https://statsig.anthropic.com/v1/`）与 `https://api.anthropic.com/api/hello` 在 **2.1.310 中已移除**：

```
$ grep -a -c -F "statsig.anthropic.com" package/claude      → 0
$ grep -a -c -F "api.anthropic.com/api/hello" package/claude → 0
$ grep -a -c -F "api.anthropic.com/api/hello" cli.js (1.0.88) → 3   ← 旧版存在
```

> **搜索陷阱提醒**：`grep -c "api/hello" package/claude` 会返回 **12**，但这些全部是 Bun 的 `bun init` 项目模板文本（`"/api/hello": { GET() { return Response.json({message:"Hello, world!"}) } }`）和随附的文档示例，与实际端点无关。必须用完整域名串 `api.anthropic.com/api/hello` 才准确。

### 3.2 遥测 payload 结构（真实抓取）

`~/.claude/telemetry/1p_failed_events.*.json` 里是**逐行 JSON**，可直接读到完整字段。实测一条：

```json
{"event_type":"ClaudeCodeInternalEvent","event_data":{
  "event_name":"tengu_shutdown_signal",
  "client_timestamp":"2026-10-24T01:19:05.577Z",
  "model":"claude-opus-5-5",
  "session_id":"3d66a9d9-0d8d-41f7-8821-33724d8f250c",
  "user_type":"external",
  "betas":"claude-code-20250219,interleaved-thinking-2025-05-14,...",
  "env":{
    "platform":"linux",
    "node_version":"v26.3.0",
    "terminal":"ssh-session",
    "package_managers":"npm",
    "runtimes":"node",
    "is_running_with_bun":true,
    "is_ci":false,
    "is_claubbit":false,
    "is_github_action":false,
    "is_claude_code_action":false,
    "is_claude_ai_auth":false,
    "version":"2.1.310",
    "arch":"x64",
    "is_claude_code_remote":false,
    "deployment_environment":"unknown-linux",
    "is_conductor":false,
    "version_base":"2.1.310",
    "build_time":"2026-10-23T17:43:32Z",
    "is_local_agent_mode":false,
    "linux_distro_id":"ubuntu",
    "linux_distro_version":"22.04",
    "linux_kernel":"5.15.0-164-generic",
    "platform_raw":"linux",
    "shell":"bash"
  },
  "entrypoint":"sdk-cli",
  "is_interactive":false,
  "client_type":"sdk-cli",
  "process":"eyJ1cHRpbWUiOjY5Ljk5NzM5OTAwMjAwMDAxLCJyc3MiOjIwNzAyMDAzMiwiaGVhcFRvdGFsIjo0MTc3MTAwOCwiaGVhcFVzZWQiOjU2MTAxOTA1LCJleHRlcm5hbCI6MjQ2NDI4MzYsImFycmF5QnVmZmVycyI6MzMwNTk5LCJjb25zdHJhaW5lZE1lbW9yeSI6MzI2ODM3NDUyODAsImNwdVVzYWdlIjp7InVzZXIiOjE4MjEzMDUsInN5c3RlbSI6Mjc2OTcyfSwiY3B1UGVyY2VudCI6MC4xMTQzODY5ODM1MjY4NzAxLCJjcHVXaW5kb3dNcyI6MTQ4MTJ9",
  "additional_metadata":"eyJjY19wcm9tcHRfaWQiOiJhY2ZmYmRkNS0zNWM4LTQwNGItODVkZC1kZTYzODhjMWNiMWMiLCJzaWduYWwiOiJTSUdURVJNIiwidXB0aW1lX3MiOjcwLCJwcGlkX2NoYW5nZWQiOmZhbHNlLCJzdGRpbl9hdF9lb2YiOnRydWUsInN0ZGluX2Rlc3Ryb3llZCI6dHJ1ZSwiaXNfdHR5IjpmYWxzZX0=",
  "event_id":"8ad218c3-8c4e-4fbf-bd2a-6fa885938f48",
  "device_id":"29cca9c2e26416aa4cadf53fff63b7d2923c6c3f1b249dd0652d927008b76d84"
}}
```

两个 base64 字段解码后：

```json
// process
{"uptime":69.997,"rss":207020032,"heapTotal":41771008,"heapUsed":56101905,
 "external":24642836,"arrayBuffers":330599,"constrainedMemory":32683745280,
 "cpuUsage":{"user":1821305,"system":276972},
 "cpuPercent":0.1143869835,"cpuWindowMs":14812}

// additional_metadata
{"cc_prompt_id":"acffbdd5-35c8-404b-85dd-de6388c1cb1c","signal":"SIGTERM",
 "uptime_s":70,"ppid_changed":false,"stdin_at_eof":true,
 "stdin_destroyed":true,"is_tty":false}
```

该次会话共 8 条事件：

```
tengu_feature_ok ×2, tengu_shutdown_signal ×1, tengu_config_cache_stats ×1,
tengu_sdk_result ×1, tengu_shutdown_pending_state ×1,
tengu_sdk_memory_summary ×1, tengu_feature_bad ×1
```

`device_id` 在全部 8 条中完全一致 —— **这就是服务端把多台"实例"归并到同一个"设备"的唯一依据。**

**注意 `constrainedMemory: 32683745280`（≈30.4 GiB）**：这是 cgroup 内存限额，属于"机器规格"级别的信息，虽不是序列号，但在同构云环境里有一定区分度。

### 3.3 发送时机（代码级）

```js
// 遥测批量导出器
class Wm{
  constructor(e={}){
    let n=e.baseUrl||(process.env.ANTHROPIC_BASE_URL==="https://api-staging.anthropic.com"
                      ?"https://api-staging.anthropic.com":"https://api.anthropic.com");
    this.endpoint = `${n}${e.path||"/api/event_logging/v2/batch"}`;
    this.timeout       = e.timeout||1e4;
    this.maxBatchSize  = e.maxBatchSize||200;
    this.batchDelayMs  = e.batchDelayMs||100;
    this.baseBackoffDelayMs = e.baseBackoffDelayMs||500;
    this.maxBackoffDelayMs  = e.maxBackoffDelayMs||30000;
    this.maxAttempts   = e.maxAttempts??8;
    ...
    this.retryPreviousBatches();
  }
  getCurrentBatchFilePath(){
    return ss.join(Lr(), `${$m}${q()}.${os}.json`)   // Lr() = ~/.claude/telemetry
  }
}
var $m="1p_failed_events.";
var iV=2000, sV=3000, aV=300000;
```

- 事件先落盘到 `~/.claude/telemetry/1p_failed_events.<session>.<run>.json`（NDJSON），再批量 POST。
- 进程退出时 `process.on("beforeExit")` / `on("exit")` 主动 flush。
- 失败批次保留在磁盘，下次启动 `retryPreviousBatches()` 重试。

**这就是为什么我们能拿到这份 payload —— 网络被封时它写盘了，文件里就是将要发出的完整内容。**

### 3.4 关闭开关

```js
if(process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX
   || process.env.DISABLE_TELEMETRY
   || process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) return null;
```

`DISABLE_TELEMETRY=1` 或 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 可关掉 B/C 通道。
**但 A 通道（`metadata.user_id` 里的 `device_id`）关不掉** —— 它是每次 `/v1/messages` 请求的必要 metadata。

---

## 4. Node.js 层面的信息

| API | 是否使用 | 出处 |
|---|---|---|
| `process.versions.node` | ✅ | `env.node_version`、Sentry `node_version`、OTel processDetector |
| `process.versions.bun` | ✅ | `is_running_with_bun`（`process.versions.bun!==void 0` 判据） |
| `process.version` | ✅ | `S.nodeVersion` |
| `process.pid` | ✅ | `env`、`pidDomain` |
| `process.execPath` / `argv` | [静态] OTel processDetector（默认关） | — |
| `process.memoryUsage()` | ✅ | 遥测 `process.rss/heapTotal/heapUsed/external/arrayBuffers` |
| `process.cpuUsage()` | ✅ | 遥测 `process.cpuUsage` |
| `process.uptime()` | ✅ | 遥测 `process.uptime` |
| `process.constrainedMemory()` | ✅ | 遥测 `process.constrainedMemory` |
| `process.env` | ✅ | 白名单，见 §1.9 |
| `os.cpus()` | ⚠️ | **命中 1 次，是 Bun 的 `os` 垫片 `lazyCpus(binding)`**，无业务调用 |
| `os.totalmem()` | ⚠️ | 同上，Bun 垫片 `totalmem: binding.totalmem`，无业务调用 |
| `os.networkInterfaces()` | ⚠️ | Bun 垫片 + GCP MAC 前缀检测（§1.10） |
| `os.hostname()` | ⚠️ | 仅 OTel hostDetector（默认关）；Sentry 里被硬编码成 `"claude-code"` |
| `os.arch()` / `os.platform()` / `os.release()` | ⚠️ | 仅 OTel（默认关）；应用层用编译期烘死的 `S.platform="linux"` / `S.arch="x64"` |
| `os.userInfo().username` | ⚠️ | 仅 OTel processDetector（默认关）；`~/.claude.json` 路径通过 `os.homedir()` |
| `os.homedir()` | ✅ | 配置文件定位 |

**代码里的架构/平台是编译期常量，不是运行时探测：**

```js
var S={ ... platform:["win32","darwin"].includes("linux")?"linux":"linux", arch:"x64", ... }
```

`["win32","darwin"].includes("linux")` 是个恒假表达式，说明这个三元式是打包时被替换过的痕迹——最终值永远是 `"linux"`。

---

## 5. 「有代码但未启用」vs「确认发送」

严格区分，避免含糊：

### ✅ 确认发送（运行时观察到）

| 字段 | 证据 |
|---|---|
| `device_id`（随机 64-hex） | 抓包 `metadata.user_id` + 队列文件 `event_data.device_id` |
| `session_id` | 同上 + `X-Claude-Code-Session-Id` 头 |
| `env.platform` / `env.arch` / `env.node_version` / `env.version` | 队列文件实测 |
| `env.linux_kernel` | `uname -r` 的 execve + 队列实测 `5.15.0-164-generic` |
| `env.linux_distro_id` / `_version` | `/etc/os-release` openat + 队列实测 `ubuntu` / `22.04` |
| `env.deployment_environment` | `/.dockerenv` access + `/sys/hypervisor/uuid` openat + 队列实测 `unknown-linux` |
| `env.terminal` / `env.shell` / `env.is_ci` | 队列实测 `ssh-session` / `bash` / `false` |
| `env.package_managers` / `env.runtimes` / `env.is_running_with_bun` | 队列实测 `npm` / `node` / `true` |
| `process.*`（内存/CPU/uptime/constrainedMemory） | 队列 base64 解码 |
| `User-Agent: claude-cli/2.1.310 (external, sdk-cli)` | 抓包 |
| `X-Stainless-Arch: x64` / `X-Stainless-OS: Linux` | 抓包 |

### ⚠️ 有代码，但运行时未观察到执行

| 字段 | 未启用原因 |
|---|---|
| `host.id`（`/etc/machine-id`）| OTel `detectResources` **无调用点**（`grep -c → 0`）；开 telemetry 后 strace 仍不读 |
| `host.name`（`os.hostname()`） | 同上 |
| `host.arch`（`os.arch()`） | 同上 |
| `os.type` / `os.version`（`os.platform()` / `os.release()`） | 同上 |
| OTel `processDetector`（`execPath`/`argv`/`username`） | 同上 |
| `/sys/class/dmi/id/bios_date` / `bios_vendor` | GCP-residency 库；仅在 Vertex 后端路径下 |
| `system_profiler` / `ioreg` / `kenv` / `reg QUERY MachineGuid` | 跨平台 machine-id 实现；Linux 上不适用 |
| `nvidia-smi` / `/proc/driver/nvidia/version` | build-tools 探测；strace 未触发 |
| Sentry 通道 | 仅异常时触发；本次未主动制造崩溃 |

### ❌ 确认不存在（全量搜索 0 命中或明确误报）

| 数据源 | 判定依据 |
|---|---|
| 磁盘序列号 | `diskutil`/`lsblk`/`hdparm`/`blkid`/`dmidecode`/`Win32_DiskDrive`/`IOPlatformSerialNumber` 全部 0 命中 |
| MAC 地址 | 仅 Bun 垫片 + GCP `42:01` 前缀判断；strace 无 `/sys/class/net`、`/proc/net/dev` |
| GPU 型号 / UUID | 仅工具名探测；无型号/UUID 读取 |
| TPM | `tpm` 命中全为 chunk 文件名与指令表误报；无 `/dev/tpm*` |
| `product_uuid` / `board_serial` / `chassis_serial` / `product_serial` | 各 0 命中 |
| `/proc/cpuinfo` / `/proc/meminfo` | 二进制命中但属 libuv 常量；strace 0 次 |
| `/proc/sys/kernel/*`（业务用） | 仅 Bun 沙箱/分配器自用 |
| `id-*` 标识文件 | `~/.claude*` 目录全量枚举无此类文件 |

---

## 6. 对 LKM / LD_PRELOAD 伪装层的建议

**核心判断：想让 Claude Code 认为是"另一台机器"，改硬件是无效的。真正要控制的是 5 个点，其中 3 个在用户态文件层。**

### 6.1 一级优先（决定识别结果，必须处理）

| # | 目标 | 拦截层 | 伪装方式 |
|---|---|---|---|
| 1 | **`~/.claude.json` 的 `userID` / `machineID`** | 纯文件层，**不需要 LKM** | 每次启动前删除或改写成目标 64-hex。这是 `device_id` 的唯一来源，改它 = 换设备 |
| 2 | **`/etc/machine-id`（用途 B）** | LKM `openat` 或 mount bind | 仅影响本地 PID 域，**不影响服务端识别**。优先级低，但改它零风险 |
| 3 | **`/etc/os-release`** | LKM `openat` / bind mount | 遥测 `linux_distro_id` / `_version` 直接来自这里，改文件即改上报值 |
| 4 | **`uname(2)` 系统调用** | **LKM 必须**（`sys_uname` 挂钩）| `uname -s/-r/-m` 走真实 syscall，LD_PRELOAD 无效（Bun 是静态链接的 ELF，直接 `syscall()`） |

### 6.2 二级优先（影响粒度，按需）

| # | 目标 | 拦截层 | 说明 |
|---|---|---|---|
| 5 | `/sys/hypervisor/uuid` | LKM / bind | 决定 `deployment_environment` 是否报 `aws-ec2`。非 EC2 环境返回 ENOENT 即可 |
| 6 | `/.dockerenv` | 文件层 | `access()` 判存在。决定是否报 `docker` |
| 7 | `/proc/sys/fs/binfmt_misc/WSLInterop` | 文件层 | 决定 WSL 判定 |
| 8 | `/proc/self/ns/pid`（`readlink`） | LKM | 仅用于 `pidDomain`，不进遥测 |
| 9 | `/sys/class/dmi/id/bios_vendor` | 文件层 | 含 `Google` 会被判为 GCE。**普通 Linux 上不读，但保险起见可伪装** |
| 10 | `process.constrainedMemory()` | **LD_PRELOAD 无效**（Bun 内建） | 遥测里的 `constrainedMemory` ≈ 机器内存规格。要改需 LKM 拦 cgroup `memory.max` 读取 |

### 6.3 明确不需要处理（别浪费精力）

- ❌ **磁盘序列号 / 磁盘型号** —— 不采集
- ❌ **MAC 地址** —— 不采集（除 GCP 的 `42:01` 前缀判断，非 GCP 网段天然安全）
- ❌ **GPU / 显卡 / `nvidia-smi`** —— 不采集
- ❌ **TPM / `/dev/tpm*`** —— 不采集
- ❌ **`product_uuid` / `board_serial` / `chassis_serial`** —— 不采集
- ❌ **`/proc/cpuinfo` / `/proc/meminfo`** —— 应用层不读（libuv 常量而已）
- ❌ **`ioreg IOPlatformUUID` / `kenv smbios` / `reg MachineGuid`** —— Linux 上不会执行
- ❌ **`id-*` 标识文件** —— 不存在

### 6.4 实现要点（技术提醒）

1. **LD_PRELOAD 对 Bun 静态二进制基本无效。** `package/claude` 是 278 MB 的静态链接 ELF，JS 运行时内建，不走 glibc 的动态 symbol 解析链。`uname`、`openat`、`readlink` 都得靠 **LKM（kprobe/ftrace hook 或 sys_call_table）** 或者 **mount namespace + bind mount 假文件**。

2. **最省事的组合拳：**
   - `uname` / `os-release` / `hypervisor/uuid` / `dockerenv` → **mount namespace bind mount 假文件**（不需要写内核模块）
   - `~/.claude.json` → **启动包装脚本**（删/写 userID）
   - 只有 `uname(2)` 需要 LKM

3. **容易踩的坑：**
   - `device_id` 有进程内缓存（config 缓存 + 磁盘），**必须重启进程**才生效。
   - 遥测失败批次会落盘重试（`~/.claude/telemetry/*.json`），**旧文件里带着旧 `device_id`**，换设备时要一起清掉，否则下次启动会上报旧 ID。
   - `machineID` 和 `userID` 是两个独立随机值，**都要处理**（`machineID` 前 12 位会出现在 Sentry 的 `host_name_redacted`）。
   - `firstStartTime` 也在 `~/.claude.json` 里，同机新建配置会暴露"这是新装的"。

4. **`uname` 的 hook 细节**：Claude 通过 `sh -c "uname -s\nuname -r\nuname -m\n..."` 执行，所以 hook `/bin/uname` 二进制内容或 hook `sys_uname` 都可。后者更稳（不受 PATH 影响）。

---

## 7. 复现命令附录

```bash
# 1. 拿包
npm view @anthropic-ai/claude-code version dist.tarball
npm pack @anthropic-ai/claude-code@2.1.310                                  # 壳（7 文件）
npm pack @anthropic-ai/claude-code-linux-x64@2.1.310                        # 真身（131 MB tgz）
tar xzf anthropic-ai-claude-code-linux-x64-2.1.310.tgz && file package/claude

# 2. 判定运行时（不是 Node）
grep -a -o -E "Bun/[0-9.]+" package/claude | sort -u          # → Bun/1.4.4
readelf -S package/claude | grep -E "\.bun|bun_builtins"

# 3. 找设备标识生成逻辑（/$bunfs 内明文 JS）
grep -a -o -E ".{500}randomBytes.{200}" package/claude | head
grep -a -o -E "function _H\(.{0,600}" package/claude

# 4. 找上报端点
grep -a -o -E "https://api\.anthropic\.com/[a-z0-9_/]+" package/claude | sort -u

# 5. 运行期文件读取（最硬证据）
strace -f -qq -e trace=openat,open,readlink,access \
       -o /tmp/cc.strace ./package/claude -p "hi"
grep -a -E "machine-id|os-release|hypervisor|dockerenv|dmi|cpuinfo" /tmp/cc.strace

# 6. 运行期进程执行
strace -f -qq -e trace=execve -o /tmp/cc-exec.strace ./package/claude -p "hi"
grep -a execve /tmp/cc-exec.strace | grep -v ENOENT
#   → /usr/bin/uname -s / -r / -m 三次

# 7. 抓真实请求体（本地 HTTP 监听冒充 API）
#    ANTHROPIC_BASE_URL=http://127.0.0.1:8898 ANTHROPIC_API_KEY=sk-ant-x
#    看 POST body 的 metadata.user_id

# 8. 拿完整遥测 payload（断网逼它落盘）
#    HTTPS_PROXY=http://127.0.0.1:<黑洞端口> claude -p "hi"
cat ~/.claude/telemetry/1p_failed_events.*.json | head -1 | python3 -m json.tool
```

---

## 8. 与 1.0.88 的差异对照

| 项目 | 1.0.88（纯 JS） | 2.1.310（Bun 原生） |
|---|---|---|
| 运行时 | Node.js | **Bun 1.4.4** |
| 分发 | 单文件 `cli.js`（9 MB） | 壳 + 平台原生包（278 MB ELF） |
| `device_id` | `randomBytes(32)` | **相同**（`_H()`） |
| `machineID` | 不存在 | 新增，同样 `randomBytes(32)` |
| Statsig | `statsig.anthropic.com/v1/` | **已移除**（`grep -F "statsig.anthropic.com"` → 0） |
| `api/hello` 健康检查 | `api.anthropic.com/api/hello`（3 处） | **已移除**（完整串 0 命中；`api/hello` 的 12 次命中是 Bun 模板文本） |
| 遥测端点 | `event_logging` | `event_logging/v2/batch` |
| `uname` 探测 | 有（`Z2("uname",...)`） | 有（`PROBE_SCRIPT`，`sh -c` 三连） |
| `os-release` | — | **新增**（`linux_distro_id`） |
| `hypervisor/uuid` | — | **新增**（`aws-ec2` 判定） |
| `/.dockerenv` | `test -f /.dockerenv` | `fs.access` + prime 缓存 |
| OTel hostDetector | 内联，无调用点 | 内联，**仍无调用点** |
| Sentry | `l$2()` 初始化 | `o1158394.ingest.us.sentry.io` |

**趋势：环境信息采集确实在变多（发行版、虚拟化、容器），但"设备标识"这一层始终是随机 UUID，从未引入硬件指纹。**

---

## 9. 开放问题 / 未覆盖

1. **Sentry 通道未主动触发。** 只做了静态分析。要完整验证需构造崩溃并在 DNS 层观察 `o1158394.ingest.us.sentry.io`。
2. **`/api/event_logging/v2/batch` 未在真实网络下成功 POST。** 分析用的是落盘的失败批次，字段与真实发送一致（同一份序列化代码），但无法确认服务端是否再加工。
3. **`ANTHROPIC_BASE_URL` 指向 staging 时**（`api-staging.anthropic.com`）遥测 payload 是否不同，未测。
4. **Bun 的 `os.cpus()` 若被某条路径调用**，会读 `/proc/cpuinfo`（libuv 实现）。本次两种模式（`--version`、`-p`）的 strace 均未观察到，但不排除长会话/特定工具路径触发。
5. **模型目录轮询**（`"Claude Code model catalog (signed picker metadata), polled every 5–15 minutes"`）的具体端点与 payload 未展开，与本报告主题（设备标识）无关。
