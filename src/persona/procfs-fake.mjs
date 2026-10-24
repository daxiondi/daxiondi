/**
 * 按槽位生成 /proc/cpuinfo 与 /proc/meminfo。
 *
 * Docker 里 20 个容器共享同一份 /proc/cpuinfo 和 /proc/meminfo ——
 * 这是「20 个槽看到同一台机器」最直接的证据。vm2api 自己的容器形态
 * 也不处理这件事（它的硬件指纹只写进 KVM 客户机，见其面板文案
 * 「只对虚拟机生效」），所以这一层要我们自己补。
 *
 * 手段是 bind-mount 覆盖这两个文件（实测可行；/proc/sys/kernel/* 和
 * /proc/version 不行，那是 runc 明令禁止的，走 LKM，见 native/lkm）。
 *
 * 设计约束：
 *   1. 生成的内容必须**自洽** —— cpu MHz 与 model name 要匹配，
 *      MemTotal 要与槽位内存上限同一量级。自洽比"每个都不一样"更难，
 *      也更重要：一份 4 核 Xeon 报 32GB 内存而容器上限 1GB，很可疑。
 *   2. 不伪造 flags —— 那些是真实能力位，删掉会导致软件误判
 *      （比如没有 avx512 就换慢路径）。只改标识类字段。
 *   3. hypervisor 标志要去掉 —— 真实物理机的 cpuinfo 没有它。
 */

/** 常见真实机型的 CPU 画像。挑这些而不是随机字符串，
 *  因为 model name 和 family/model/stepping 必须互相成立。 */
export const CPU_PROFILES = Object.freeze([
  // 云上/托管最常见的几种。20 个槽要尽量不撞型号，所以数量要够 ——
  // 只有 5-6 种时 20 个槽必然大量重复（实测 11 个槽都是同一颗 i7）。
  { name: 'Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz', vendor: 'GenuineIntel', family: 6, model: 106, stepping: 6, mhz: 2900, cache: 55296, cores: 8, vmx: true, tier: 'server' },
  { name: 'Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz', vendor: 'GenuineIntel', family: 6, model: 85, stepping: 7, mhz: 2500, cache: 36608, cores: 8, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'Intel(R) Xeon(R) Platinum 8275CL CPU @ 3.00GHz', vendor: 'GenuineIntel', family: 6, model: 85, stepping: 7, mhz: 3000, cache: 36608, cores: 12, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz', vendor: 'GenuineIntel', family: 6, model: 85, stepping: 7, mhz: 3000, cache: 36608, cores: 12, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz', vendor: 'GenuineIntel', family: 6, model: 106, stepping: 6, mhz: 2000, cache: 49152, cores: 16, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'Intel(R) Xeon(R) Silver 4314 CPU @ 2.40GHz', vendor: 'GenuineIntel', family: 6, model: 106, stepping: 6, mhz: 2400, cache: 24576, cores: 8, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'Intel(R) Xeon(R) E5-2680 v4 @ 2.40GHz', vendor: 'GenuineIntel', family: 6, model: 79, stepping: 1, mhz: 2400, cache: 35840, cores: 14, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'Intel(R) Xeon(R) E5-2673 v4 @ 2.30GHz', vendor: 'GenuineIntel', family: 6, model: 79, stepping: 1, mhz: 2300, cache: 51200, cores: 10, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'Intel(R) Core(TM) i7-10700 CPU @ 2.90GHz', vendor: 'GenuineIntel', family: 6, model: 165, stepping: 5, mhz: 2900, cache: 16384, cores: 8, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'Intel(R) Core(TM) i9-10900K CPU @ 3.70GHz', vendor: 'GenuineIntel', family: 6, model: 165, stepping: 5, mhz: 3700, cache: 20480, cores: 10, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz', vendor: 'GenuineIntel', family: 6, model: 158, stepping: 13, mhz: 3000, cache: 12288, cores: 8, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'Intel(R) Core(TM) i5-10500 CPU @ 3.10GHz', vendor: 'GenuineIntel', family: 6, model: 165, stepping: 3, mhz: 3100, cache: 12288, cores: 6, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'AMD EPYC 7R32 48-Core Processor', vendor: 'AuthenticAMD', family: 23, model: 49, stepping: 0, mhz: 2800, cache: 512, cores: 16, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'AMD EPYC 7763 64-Core Processor', vendor: 'AuthenticAMD', family: 25, model: 1, stepping: 1, mhz: 2450, cache: 512, cores: 16, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'AMD EPYC 7502 32-Core Processor', vendor: 'AuthenticAMD', family: 23, model: 49, stepping: 0, mhz: 2500, cache: 512, cores: 16, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'AMD EPYC 7543 32-Core Processor', vendor: 'AuthenticAMD', family: 25, model: 1, stepping: 1, mhz: 2800, cache: 512, cores: 16, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'AMD Ryzen 9 5950X 16-Core Processor', vendor: 'AuthenticAMD', family: 25, model: 33, stepping: 0, mhz: 3400, cache: 512, cores: 16, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'AMD Ryzen 7 5800X 8-Core Processor', vendor: 'AuthenticAMD', family: 25, model: 33, stepping: 2, mhz: 3800, cache: 512, cores: 8, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'AMD Ryzen 5 5600X 6-Core Processor', vendor: 'AuthenticAMD', family: 25, model: 33, stepping: 0, mhz: 3700, cache: 512, cores: 6, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'AMD EPYC 7302 16-Core Processor', vendor: 'AuthenticAMD', family: 23, model: 49, stepping: 0, mhz: 3000, cache: 512, cores: 8, vmx: true, tier: 'server', minMemGb: 16 },
  { name: 'Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz', vendor: 'GenuineIntel', family: 6, model: 165, stepping: 3, mhz: 2900, cache: 12288, cores: 6, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'Intel(R) Core(TM) i3-10100 CPU @ 3.60GHz', vendor: 'GenuineIntel', family: 6, model: 165, stepping: 3, mhz: 3600, cache: 6144, cores: 4, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz', vendor: 'GenuineIntel', family: 6, model: 158, stepping: 10, mhz: 3200, cache: 12288, cores: 6, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'Intel(R) Core(TM) i5-8500 CPU @ 3.00GHz', vendor: 'GenuineIntel', family: 6, model: 158, stepping: 10, mhz: 3000, cache: 9216, cores: 6, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'Intel(R) Core(TM) i7-7700 CPU @ 3.60GHz', vendor: 'GenuineIntel', family: 6, model: 158, stepping: 9, mhz: 3600, cache: 8192, cores: 4, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'Intel(R) Core(TM) i5-7500 CPU @ 3.40GHz', vendor: 'GenuineIntel', family: 6, model: 158, stepping: 9, mhz: 3400, cache: 6144, cores: 4, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'Intel(R) Xeon(R) E3-1270 v6 @ 3.80GHz', vendor: 'GenuineIntel', family: 6, model: 158, stepping: 9, mhz: 3800, cache: 8192, cores: 4, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'Intel(R) Xeon(R) E3-1230 v5 @ 3.40GHz', vendor: 'GenuineIntel', family: 6, model: 94, stepping: 3, mhz: 3400, cache: 8192, cores: 4, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'AMD Ryzen 5 3600 6-Core Processor', vendor: 'AuthenticAMD', family: 23, model: 113, stepping: 0, mhz: 3600, cache: 512, cores: 6, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'AMD Ryzen 5 2600 Six-Core Processor', vendor: 'AuthenticAMD', family: 23, model: 8, stepping: 2, mhz: 3400, cache: 512, cores: 6, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'AMD Ryzen 7 3700X 8-Core Processor', vendor: 'AuthenticAMD', family: 23, model: 113, stepping: 0, mhz: 3600, cache: 512, cores: 8, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'AMD Ryzen 3 3200G with Radeon Vega Graphics', vendor: 'AuthenticAMD', family: 23, model: 24, stepping: 1, mhz: 3600, cache: 512, cores: 4, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'AMD Ryzen 9 3900X 12-Core Processor', vendor: 'AuthenticAMD', family: 23, model: 113, stepping: 0, mhz: 3800, cache: 512, cores: 12, vmx: true, tier: 'desktop', minMemGb: 4 },
  { name: 'AMD EPYC 7232P 8-Core Processor', vendor: 'AuthenticAMD', family: 23, model: 49, stepping: 0, mhz: 3100, cache: 512, cores: 8, vmx: true, tier: 'desktop', minMemGb: 4 },
])

/** 稳定哈希：同一个 vmId 每次跑都得到同一份内容。
 *  不能随机 —— 每次重启换一套 CPU 反而更可疑。 */
export function stableHash(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 为槽位挑 CPU 画像。
 *
 * 用 (hash + index) 而不是纯 hash：纯 hash 在小样本下容易撞，
 * 20 个槽如果只有 6 个画像，必然多个槽相同。加 index 让相邻槽
 * 尽量错开，但仍是确定性的。
 */
export function cpuProfileFor(vmId, index = 0, memoryMb = null) {
  // 把 index 也喂进 hash（不是加在结果上，那样模运算会出周期），
  // 这样相邻槽的哈希输入不同，分布不受取模周期影响。
  // 选型：用 index 轮转做**主**分配，保证 N 个槽在 N<=画像数 时两两不撞。
  // 纯 hash 会撞 —— 实测 20 个槽对 20 个画像只落到 10 种（生日问题）。
  //
  // 但完全按 index 轮转又有规律性（槽 1..20 对应画像 1..20 顺序固定），
  // 所以用 vmId 的 hash 决定起点偏移。这样：
  //   - 同一批部署里，20 个槽覆盖 20 种（前提是画像数 >= 槽数）
  //   - 换个部署顺序，起点不同，外部看不出序号与型号的对应关系
  //
  // 但**不能**用 vmId 的 hash 做起点偏移：实测 slot-01/02/03 的 hash 分别是
  // 3/2/1，加上 index 0/1/2 之后全部落到 3 —— offset 和 index 互相抵消了。
  // 结果 20 个槽只有 12 种型号。
  //
  // 直接用 index 轮转，N 个槽在 N<=画像数 时严格两两不撞。
  // 「序号与型号有固定对应」这件事不构成风险：外部观测不到部署序号。
  // 按内存档位过滤画像 —— 这是修「Xeon Platinum 配 1GB 内存」的矛盾。
  // 真实机器不会给服务器级 CPU 配 1GB 内存：那是明显的云主机配额伪装成物理机。
  //
  // 有 memoryMb 时只在"该档位说得通"的画像里轮转；
  // 没给时（老调用方）退回全池，保持向后兼容。
  let pool = CPU_PROFILES
  if (Number.isFinite(Number(memoryMb)) && Number(memoryMb) > 0) {
    const gb = Number(memoryMb) / 1024
    const fit = CPU_PROFILES.filter((p) => (p.minMemGb || 4) <= gb)
    // 过滤后为空说明内存极小（<4GB），此时用桌面级低配画像，
    // 不能退回服务器级 —— 那正是要消除的矛盾。
    pool = fit.length ? fit : CPU_PROFILES.filter((p) => p.tier === 'desktop')
    if (!pool.length) pool = CPU_PROFILES
  }
  const base = pool[Number(index || 0) % pool.length]

  // 6 个基础画像对 20 个槽必然重复，而「20 个槽 CPU 型号只有 5 种」
  // 本身就是可聚类的特征。所以再叠一层确定性变化：
  //   - 频率在基础值上下浮动 ±100MHz（真实同型号不同批次会差）
  //   - 微码版本随之变化
  // 组合空间 6 × 21 = 126，足够 20 个槽两两不同。
  // 频率抖动扩到 ±200MHz、10MHz 粒度 —— 真实同型号不同批次确实有这种差异。
  // 之前 ±100/50 粒度只能给 5 档，20 个槽撞得厉害。
  const jitter = (stableHash(`${vmId}#mhz#${index}`) % 41 - 20) * 10
  const mhz = Math.max(800, base.mhz + jitter)
  const microcode = 0x100 + (stableHash(`${vmId}#uc#${index}`) % 0xe0)
  // cache size 也随之微调（真实同型号因禁用核心数不同会有差异）
  const cache = base.cache + ((stableHash(`${vmId}#cache#${index}`) % 7) - 3) * 1024

  return { ...base, mhz, microcode, cache, jitter }
}

/**
 * 生成 cpuinfo 文本。
 *
 * @param {object} p
 * @param {object} p.profile     CPU 画像
 * @param {number} p.cores       暴露给容器的核数（与 --cpus 一致）
 * @param {number} [p.baseMhz]   覆盖频率
 * @param {boolean} [p.hideHypervisor] 是否去掉 hypervisor 标志
 */
export function renderCpuinfo({ profile, cores = 2, baseMhz = null, hideHypervisor = true }) {
  const n = Math.max(1, Math.min(256, Number(cores) || 2))
  const mhz = (baseMhz || profile.mhz).toFixed(3)
  const vendor = profile.vendor

  // flags 基线：真实 x86_64 常见能力的子集。不虚构能力位，
  // 避免程序探测到实际不支持的指令集而崩。
  const baseFlags = [
    'fpu', 'vme', 'de', 'pse', 'tsc', 'msr', 'pae', 'mce', 'cx8', 'apic', 'sep', 'mtrr',
    'pge', 'mca', 'cmov', 'pat', 'pse36', 'clflush', 'mmx', 'fxsr', 'sse', 'sse2', 'ss',
    'ht', 'syscall', 'nx', 'lm', 'constant_tsc', 'rep_good', 'nopl', 'xtopology',
    'cpuid', 'tsc_known_freq', 'pni', 'pclmulqdq', 'ssse3', 'fma', 'cx16', 'pcid',
    'sse4_1', 'sse4_2', 'x2apic', 'movbe', 'popcnt', 'tsc_deadline_timer', 'aes',
    'xsave', 'avx', 'f16c', 'rdrand', 'lahf_lm', 'abm', '3dnowprefetch', 'invpcid_single',
    'pti', 'fsgsbase', 'tsc_adjust', 'bmi1', 'avx2', 'smep', 'bmi2', 'erms', 'invpcid',
    'rdseed', 'adx', 'smap', 'clflushopt', 'clwb', 'xsaveopt', 'xsavec', 'xgetbv1', 'xsaves',
    'arat', 'md_clear', 'flush_l1d',
  ]
  if (profile.vmx) baseFlags.push('vmx')
  const flags = baseFlags.filter((f) => !(hideHypervisor && f === 'hypervisor'))

  const lines = []
  for (let i = 0; i < n; i += 1) {
    lines.push(
      `processor\t: ${i}`,
      `vendor_id\t: ${vendor}`,
      `cpu family\t: ${profile.family}`,
      `model\t\t: ${profile.model}`,
      `model name\t: ${profile.name}`,
      `stepping\t: ${profile.stepping}`,
      `microcode\t: 0x${(profile.microcode || (0x100 + profile.stepping * 17)).toString(16)}`,
      `cpu MHz\t\t: ${mhz}`,
      `cache size\t: ${profile.cache} KB`,
      `physical id\t: 0`,
      `siblings\t: ${profile.cores}`,
      `core id\t\t: ${i}`,
      `cpu cores\t: ${profile.cores}`,
      `apicid\t\t: ${i}`,
      `initial apicid\t: ${i}`,
      'fpu\t\t: yes',
      'fpu_exception\t: yes',
      'cpuid level\t: 22',
      'wp\t\t: yes',
      `flags\t\t: ${flags.join(' ')}`,
      'bugs\t\t: spectre_v1 spectre_v2 spec_store_bypass swapgs itlb_multihit srbds mmio_stale_data',
      `bogomips\t: ${(mhz * 2 / 1000).toFixed(2)}`,
      'clflush size\t: 64',
      'cache_alignment\t: 64',
      'address sizes\t: 46 bits physical, 48 bits virtual',
      'power management:',
      '',
    )
  }
  return lines.join('\n')
}

/**
 * 生成 meminfo 文本。
 *
 * 关键点：MemTotal 必须与容器内存上限一致且**留出固件占用**差异，
 * 但不要离谱。真实机器 1GB 配置下 MemTotal 通常是 1000000kB 左右
 * （内核和固件吃掉几十 MB）。
 *
 * @param {object} p
 * @param {number} p.limitMb     容器内存上限（--memory）
 * @param {number} [p.usedRatio] 已用比例，只影响 Free/Available
 */
export function renderMeminfo({ limitMb = 1024, usedRatio = 0.35, vmId = '', index = 0 }) {
  // limitMb 应当**等于容器真实的 memory.max**，不是写死的 1024。
  // 实测矛盾：MemTotal 报 1022360kB 而 memory.max 是 2621440kB（2.5GB），
  // 比值 0.39 —— 一眼看出报的内存是假的。
  // 现在由调用方传真实限额，MemTotal 就贴在上限附近（扣掉内核占用）。
  const limitKb = Math.max(64, Math.round(Number(limitMb) || 1024)) * 1024
  // MemTotal 要比 cgroup 上限略小，因为内核和固件会占掉一点。
  // 但不能太小：真实 1GB 机器 MemTotal 约 990000-1002000 kB，
  // 不是 1027604 —— 那个值已经超过 1GB 了（1024*1024=1048576，
  // 减 2% 只有 1027604，看着"合理"其实偏大，因为 MemTotal 是
  // 可用内存，不该接近上限）。
  //
  // 取 3%-6% 的占用，随 vmId 确定性浮动，避免所有槽同一个数。
  // 不能只用 limitMb 做种子 —— 所有槽的 limitMb 都是 1024，
  // 那样 20 个槽算出同一个 MemTotal（实测踩过，20 个槽只有 1 个值）。
  // 必须把 vmId/index 一起喂进去。
  // 档位要够多才不会撞。实测 %9 只能给 8 个不同值（20 个槽必然重复），
  // 扩到 40 档 × 4 字节对齐 —— 1GB 上下浮动约 ±60MB，仍在真实范围。
  // 用 index 做主要错开源、hash 做细微扰动：
  //   index*2 保证相邻槽至少差 2 档（20 档覆盖 20 个槽不撞）
  //   hash%2 打破"差值恒定"的规律性，避免所有槽差值一模一样
  // 真实机器 MemTotal 是 cgroup/物理内存的 96%~99%（内核 + 固件占用几%）。
  // 之前用 2.5%~7.5% 的扣减、再按 index 错开，导致 MemTotal 偏离上限太远，
  // 与 memory.max 比值掉到 0.39 —— 硬矛盾。
  //
  // 现在：主扣减固定 1.5%~3.5%（合理的固件占用区间），
  // 逐槽差异靠"字节级"微调实现（对齐到 4KB，几十 KB 的差别），
  // 这样既保证 20 个槽数值不同，又保证比值落在 0.965~0.985。
  const slot = (Number(index) || 0) % 20
  // 基础占用：1.5% + 每槽 0.1% 的浮动（最大 3.4%）
  const basePct = 0.015 + slot * 0.001
  // 字节级微调：每个槽再扣 0~48KB，制造唯一性但不影响量级
  const byteJitterKb = (stableHash(`${vmId}#mem#${limitMb}`) % 12) * 4
  const total = Math.round(limitKb * (1 - basePct) / 4) * 4 - byteJitterKb * 1
  // 已用比例也逐槽变化，否则 Free/Available 又是一模一样的一组数
  const ratioJitter = (stableHash(`${vmId}#used#${index}`) % 50) / 100
  const effRatio = Math.max(0.02, Math.min(0.9, usedRatio - 0.15 + ratioJitter))
  const used = Math.round(total * effRatio)
  const free = total - used
  const buffers = Math.round(total * 0.03)
  const cached = Math.round(total * 0.18)
  const available = Math.min(total, free + cached + buffers)
  const swapTotal = 0   // 容器默认无 swap；有 swap 反而暴露配置

  return [
    `MemTotal:       ${total} kB`,
    `MemFree:        ${free} kB`,
    `MemAvailable:   ${available} kB`,
    `Buffers:        ${buffers} kB`,
    `Cached:         ${cached} kB`,
    `SwapCached:            0 kB`,
    'Active:               0 kB',
    'Inactive:             0 kB',
    'Active(anon):         0 kB',
    'Inactive(anon):       0 kB',
    'Active(file):         0 kB',
    'Inactive(file):       0 kB',
    'Unevictable:          0 kB',
    'Mlocked:              0 kB',
    `SwapTotal:      ${swapTotal} kB`,
    `SwapFree:       ${swapTotal} kB`,
    'Dirty:                0 kB',
    'Writeback:            0 kB',
    'AnonPages:            0 kB',
    'Mapped:               0 kB',
    'Shmem:                0 kB',
    'KReclaimable:         0 kB',
    'Slab:                 0 kB',
    'SReclaimable:         0 kB',
    'SUnreclaim:           0 kB',
    'KernelStack:          0 kB',
    'PageTables:           0 kB',
    'NFS_Unstable:         0 kB',
    'Bounce:               0 kB',
    'WritebackTmp:         0 kB',
    'CommitLimit:         0 kB',
    'Committed_AS:         0 kB',
    'VmallocTotal:   34359738367 kB',
    'VmallocUsed:          0 kB',
    'VmallocChunk:          0 kB',
    'Percpu:               0 kB',
    'HardwareCorrupted:    0 kB',
    'AnonHugePages:        0 kB',
    'ShmemHugePages:       0 kB',
    'ShmemPmdMapped:       0 kB',
    'FileHugePages:        0 kB',
    'FilePmdMapped:        0 kB',
    'HugePages_Total:      0',
    'HugePages_Free:       0',
    'HugePages_Rsvd:       0',
    'HugePages_Surp:       0',
    'Hugepagesize:       2048 kB',
    'Hugetlb:              0 kB',
    'DirectMap4k:          0 kB',
    'DirectMap2M:          0 kB',
    'DirectMap1G:          0 kB',
    '',
  ].join('\n')
}

/**
 * 为一个槽位生成两个文件的完整内容。
 * 确定性：同一 (vmId, index, limits) 永远得到同一份内容。
 */
export function renderProcfsForSlot({ vmId, index = 0, cores = 2, memoryMb = 1024, usedRatio = 0.35 }) {
  const profile = cpuProfileFor(vmId, index, memoryMb)
  return {
    profile,
    cpuinfo: renderCpuinfo({ profile, cores }),
    meminfo: renderMeminfo({ limitMb: memoryMb, usedRatio, vmId, index }),
  }
}

// ═══════════════════════════════════════════════════════════════
// 启动时间与负载：容器里这些文件暴露的是**宿主**的值
// ═══════════════════════════════════════════════════════════════
//
// 实测矛盾：20 个槽的 /proc/uptime 都是 4328.85s（等于宿主 uptime），
// /proc/stat 的 btime 全是同一个数，boot_id 也全同。
//
// 后果：一个 `cat /proc/uptime` 就能判定"这 20 台机器是同一台"。
// 真实机群各自开机时间不同，uptime 不可能精确到小数位相同。
//
// 这三个文件（uptime / stat / loadavg）可以 bind-mount，不需要 LKM。
// boot_id 在 /proc/sys/ 下，runc 拒绝挂载，只能走内核模块。

/**
 * 生成一个槽的假启动时间。
 *
 * 语义：这个"机器"已经开机多久。
 *   · 不能是刚开机（0 秒）—— 20 个槽同时开机本身可疑
 *   · 不能是整数天 —— 太整齐
 *   · 要落在"常驻服务器"的合理区间：几天到几个月
 *
 * 用 vmId 派生，保证确定性（同一槽不同次启动看到同一个值，
 * 否则每次重启 uptime 变小会自相矛盾）。
 */
export function fakeBootForSlot({ vmId, index = 0, slots = 20 } = {}) {
  const h = stableHash(`${vmId}#boot#${index}`)
  // 以"现在"为锚点往前推。注意：这会让 uptime 随时间增长，
  // 所以必须用固定的 epoch 起点，不能每次调用都取 Date.now()
  // —— 否则同一槽两次读取 uptime 会跳变。
  //
  // 做法：把启动时刻定成一个固定的绝对时间戳（按槽位分散），
  // 之后 uptime = now - bootTime，自然增长。
  //
  // 起点选在 2026-08-01 到 2026-10-20 之间（约 4~85 天前，
  // 相对当前 2026-10-24）。这段区间都是"已经跑了一段时间的服务器"。
  const DAY = 86_400
  const baseEpoch = Date.UTC(2026, 7, 1, 0, 0, 0) / 1000  // 2026-08-01
  const spanDays = 80
  const offsetDays = (h % (spanDays * 24 * 60)) / (24 * 60)
  const bootEpoch = Math.round(baseEpoch + offsetDays * DAY)
  return {
    bootEpoch,
    bootId: deriveBootId(vmId, index),
  }
}

/**
 * 派生一个 boot_id。
 *
 * 真实 boot_id 是内核启动时生成的 UUIDv4（版本位 4，变体位 10xx）。
 * 格式必须对，否则一看就是假的。
 */
export function deriveBootId(vmId, index = 0) {
  const h1 = stableHash(`bootid-a#${vmId}#${index}`)
  const h2 = stableHash(`bootid-b#${vmId}#${index}`)
  const hex = (n, len) => (n >>> 0).toString(16).padStart(8, '0').slice(0, len)
  const a = hex(h1, 8)
  const b = hex(h2, 4)
  // 版本位：第 13 个 hex 位必须是 4
  const c = '4' + hex(h1 ^ h2, 3)
  // 变体位：第 17 个 hex 位必须是 8/9/a/b
  const variant = '89ab'[(h1 >>> 28) & 0x3]
  const d = variant + hex(h2 ^ 0x5a5a5a5a, 3)
  const e = hex(h1 * 31 + h2, 8) + hex(h1 ^ 0x12345678, 4)
  return `${a}-${b}-${c}-${d}-${e}`
}

/**
 * 渲染 /proc/uptime。
 *
 * 真实格式：`<总秒数> <空闲秒数>`，两位小数。
 * 空闲秒数永远小于总秒数，比例取决于负载（多核机器可能大于总秒数，
 * 因为它是所有 CPU 累加的 —— 这里按 1~N 核累加）。
 */
export function renderUptime({ bootEpoch, now = null, cores = 2, idleRatio = 0.85 } = {}) {
  const t = now ? now / 1000 : Date.now() / 1000
  const up = Math.max(1, t - Number(bootEpoch))
  // 空闲时间是各核累加，可能超过 wall time
  const idle = up * Math.max(0.5, Math.min(cores, 2)) * idleRatio
  return `${up.toFixed(2)} ${idle.toFixed(2)}\n`
}

/**
 * 渲染 /proc/stat 的 btime 行。
 *
 * 这个文件很长，我们只替换 btime 那一行；其余行（cpu/user/nice…）
 * 由调用方从宿主读来再改。这样 cpu 统计仍是真的（负载本来就是本容器的），
 * 只有"开机时刻"被改。
 */
export function renderStatBtime({ bootEpoch, cores = 2, vmId = '', index = 0 }) {
  // 不能只写 btime 一行 —— /proc/stat 是个多行文件，
  // 只给 btime 会让所有读 cpu 统计的程序（top/htop/sar）拿到空数据而报错。
  //
  // 真实文件开头是这样：
  //   cpu  1234 0 5678 90123 456 0 789 0 0 0
  //   cpu0 ...
  //   intr ...
  //   ctxt ...
  //   btime 1787114160
  //   processes ...
  //   procs_running 1
  //   procs_blocked 0
  //
  // 这里按"该槽已运行 N 秒、N 核"造一份自洽的统计。
  // 数值不必精确（没人会核对），但**格式和量级必须对**：
  // user+system+idle 的总和应该 ≈ 核数 × 运行秒数 × HZ。
  const upSec = Math.max(60, (Date.now() / 1000) - Number(bootEpoch))
  const HZ = 100
  const n = Math.max(1, Number(cores) || 2)
  const total = Math.round(upSec * HZ * n)

  const lines = []
  let agg = { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 }
  for (let c = 0; c < n; c += 1) {
    const h = stableHash(`${vmId}#stat#${index}#${c}`)
    // 各核负载分布不同，但不能离谱：idle 占大头（服务器常驻）
    const idlePct = 0.72 + ((h % 25) / 100)      // 72%~97%
    const userPct = (1 - idlePct) * 0.62
    const sysPct = (1 - idlePct) * 0.24
    const iowPct = (1 - idlePct) * 0.08
    const irqPct = (1 - idlePct) * 0.03
    const softPct = (1 - idlePct) * 0.03
    const per = Math.round(total / n)
    const row = {
      user: Math.round(per * userPct),
      nice: Math.round(per * 0.002),
      system: Math.round(per * sysPct),
      idle: Math.round(per * idlePct),
      iowait: Math.round(per * iowPct),
      irq: Math.round(per * irqPct),
      softirq: Math.round(per * softPct),
      steal: 0,
    }
    for (const k of Object.keys(agg)) agg[k] += row[k]
    lines.push(`cpu${c} ${row.user} ${row.nice} ${row.system} ${row.idle} ${row.iowait} ${row.irq} ${row.softirq} ${row.steal} 0 0`)
  }
  lines.unshift(`cpu  ${agg.user} ${agg.nice} ${agg.system} ${agg.idle} ${agg.iowait} ${agg.irq} ${agg.softirq} ${agg.steal} 0 0`)

  const h2 = stableHash(`${vmId}#stat2#${index}`)
  const intrTotal = Math.round(upSec * (120 + (h2 % 300)))
  const ctxt = Math.round(upSec * (400 + (h2 % 2000)))
  const processes = 3000 + (h2 % 20000)
  lines.push(`intr ${intrTotal} ${Math.round(intrTotal * 0.3)} ${Math.round(intrTotal * 0.2)}`)
  lines.push(`ctxt ${ctxt}`)
  lines.push(`btime ${Math.round(Number(bootEpoch))}`)
  lines.push(`processes ${processes}`)
  lines.push('procs_running 1')
  lines.push('procs_blocked 0')
  lines.push(`softirq ${Math.round(upSec * 40)} ${Math.round(upSec * 12)} ${Math.round(upSec * 8)}`)
  return `${lines.join('\n')}\n`
}

/**
 * 渲染 /proc/loadavg。
 *
 * 格式：`0.00 0.01 0.05 1/234 5678`
 *   前三个是 1/5/15 分钟平均负载
 *   1/234 = 运行中进程数/总进程数
 *   5678  = 最近创建的 PID
 *
 * 容器里的真实 loadavg 是**宿主**的（因为它是全局的），
 * 宿主跑 20 个槽 + 其他业务，负载会很高，与"1 核小机器"矛盾。
 */
export function renderLoadavg({ vmId, index = 0, cores = 2 }) {
  const h = stableHash(`${vmId}#load#${index}`)
  const base = (h % 60) / 100          // 0.00 ~ 0.59
  const l1 = base
  const l5 = base * (0.9 + ((h >>> 8) % 20) / 100)
  const l15 = base * (0.8 + ((h >>> 16) % 40) / 100)
  const running = 1 + (h % 2)
  const total = 120 + (h % 200)
  const lastPid = 2000 + (h % 60000)
  return `${l1.toFixed(2)} ${l5.toFixed(2)} ${l15.toFixed(2)} ${running}/${total} ${lastPid}\n`
}

/**
 * 一次性产出该槽需要的所有启动时间相关文件。
 */
export function renderBootFiles({ vmId, index = 0, cores = 2, now = null } = {}) {
  const { bootEpoch, bootId } = fakeBootForSlot({ vmId, index })
  return {
    bootEpoch,
    bootId,
    uptime: renderUptime({ bootEpoch, now, cores }),
    stat: renderStatBtime({ bootEpoch, cores, vmId, index }),
    loadavg: renderLoadavg({ vmId, index, cores }),
  }
}
