/**
 * persona → QEMU 启动参数
 *
 * 与 docker-spec.mjs 的根本区别：
 *
 *   Docker 版是「伪造层」：把 persona 渲染成文件挂进容器，再包住命令。
 *   程序只要绕过 shell、直接读 syscall，看到的就是宿主真实值。
 *
 *   KVM 版是「真实提供」：QEMU 把 persona 的硬件字段写进虚拟机的 SMBIOS 表，
 *   客户机内核自己去读这些表，填进 /sys/class/dmi/id/*。没有中间伪造层，
 *   所以也不存在「哪一层没盖住」这种半生效状态。
 *
 * 因此本模块不做文件渲染，只做一件事：把 persona 的硬件字段精确映射成
 * `-smbios` 参数。映射错了，客户机里就是错的 —— 没有第二处可以补救。
 *
 * 三条硬约束（都来自 QEMU 解析器的实际行为，不是风格问题）：
 *
 *   1. 逗号。`-smbios` 的每个参数都是 `key=value` 用逗号分隔，值里出现逗号
 *      会被当成下一个字段的分隔符。QEMU 的解析器（util/qemu-option.c 的
 *      get_opt_value）确实认「逗号写两遍」这种转义，但本模块默认**拒绝**
 *      而不是转义 —— 理由见 sanitizeSmbiosValue：厂商名是下游的身份键，
 *      静默改写会造出一个不存在的厂商名，比启动失败更难排查。
 *      需要双写转义的调用方显式传 commaPolicy: 'escape'。
 *
 *   2. `family=` 只在 type=1 且机器类型为 q35 族时才有容身之处。i440fx 上
 *      QEMU 不消费该字段，客户机读到空值 —— 属于静默失效，这里显式降级并告警。
 *
 *   3. type=3 不接受 product / family / 机箱类型。QEMU 把 type 3 的 chassis
 *      type 固定写成 0x01（Other），命令行无法覆盖。传入不存在的字段会被
 *      QEMU 判为非法参数并拒绝启动，所以这里只发 QEMU 认的字段。
 */

import { deriveMac, deriveSerial, pickFrom } from './derive.mjs'

/**
 * QEMU 实际支持的 SMBIOS 子字段（来源：qemu_smbios_type<N>_opts）。
 * 只列本模块会发的字段；多写一个不存在的 key，QEMU 会拒绝整条参数。
 */
export const SMBIOS_FIELDS = Object.freeze({
  0: Object.freeze(['vendor', 'version', 'date', 'uefi']),
  1: Object.freeze(['manufacturer', 'product', 'version', 'serial', 'uuid', 'sku', 'family']),
  2: Object.freeze(['manufacturer', 'product', 'version', 'serial', 'asset', 'location']),
  3: Object.freeze(['manufacturer', 'version', 'serial', 'asset', 'sku']),
})

/**
 * type=3 的 chassis type 在 QEMU 中不可配置，固定为 0x01。
 * 客户机 `dmidecode -t 3` 读到 `Type: Other`，这个值不由调用方决定。
 */
export const QEMU_FIXED_CHASSIS_TYPE = 1

/** 能承载 type=1 `family=` 的机器类型族。 */
export const FAMILY_CAPABLE_MACHINES = Object.freeze(['q35', 'virt'])

/**
 * SMBIOS type=0（BIOS）的版本与日期组合。
 *
 * 日期必须是 MM/DD/YYYY：dmidecode 按这个格式解析，ISO 日期会被原样显示，
 * 和真实 BIOS 的格式不一致 —— 这是一眼可辨的差异。
 */
export const BIOS_PROFILES = Object.freeze([
  Object.freeze({ version: '2.18.0', date: '11/14/2023' }),
  Object.freeze({ version: '2.15.1', date: '08/22/2022' }),
  Object.freeze({ version: '1.9.2', date: '09/12/2024' }),
  Object.freeze({ version: '2.20.0', date: '03/05/2024' }),
  Object.freeze({ version: '1.14.0', date: '06/18/2024' }),
])

/**
 * 主板厂商与型号的配对表。
 *
 * 只看系统厂商就编一个主板型号，是最容易被交叉验证筛出来的破绽：
 * Dell 的机器不会配 ASUS 的主板。这张表按系统厂商给出同一生态内的型号。
 */
export const BOARD_PROFILES = Object.freeze({
  'Dell Inc.': Object.freeze([
    Object.freeze({ vendor: 'Dell Inc.', name: '0P4XX8', version: 'A01' }),
    Object.freeze({ vendor: 'Dell Inc.', name: '0WX9C8', version: 'A02' }),
    Object.freeze({ vendor: 'Dell Inc.', name: '0K3V4M', version: 'A00' }),
  ]),
  LENOVO: Object.freeze([
    Object.freeze({ vendor: 'LENOVO', name: '21AHS0QK00', version: 'SDK0T76463' }),
    Object.freeze({ vendor: 'LENOVO', name: '20WMS0S300', version: 'SDK0T76461' }),
  ]),
  HP: Object.freeze([
    Object.freeze({ vendor: 'HP', name: '8846', version: 'KBC Version 12.01' }),
    Object.freeze({ vendor: 'HP', name: '8A1D', version: 'KBC Version 11.05' }),
  ]),
  'ASUSTeK COMPUTER INC.': Object.freeze([
    Object.freeze({ vendor: 'ASUSTeK COMPUTER INC.', name: 'A1502CBA', version: '1.0' }),
    Object.freeze({ vendor: 'ASUSTeK COMPUTER INC.', name: 'X1502ZA', version: '1.0' }),
  ]),
  Acer: Object.freeze([
    Object.freeze({ vendor: 'Acer', name: 'P215-54', version: 'V1.10' }),
    Object.freeze({ vendor: 'Acer', name: 'N4670G', version: 'V1.05' }),
  ]),
  Framework: Object.freeze([
    Object.freeze({ vendor: 'Framework', name: 'FRANBMCP06', version: 'V1.0' }),
  ]),
  'Micro-Star International Co. Ltd.': Object.freeze([
    Object.freeze({ vendor: 'Micro-Star International Co. Ltd.', name: 'MS-1581', version: 'REV:1.0' }),
  ]),
  GIGABYTE: Object.freeze([
    Object.freeze({ vendor: 'GIGABYTE', name: 'AERO16', version: 'V1.1' }),
  ]),
})

/** 系统厂商不在配对表里时的兜底：主板厂商跟随系统厂商。 */
function fallbackBoardProfile(vendor) {
  return { vendor: String(vendor || 'Generic'), name: 'Default string', version: '1.0' }
}

/** 资产标签字符集：真实标签只含大写字母与数字。 */
const TAG_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'

/** 磁盘序列号字符集：真实 ATA 序列号是大写字母数字。 */
const DISK_SERIAL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

// ─────────────── SMBIOS 值校验与转义 ───────────────

/**
 * SMBIOS 字符串长度上限。
 *
 * 来源是规范而不是 QEMU：DSP0134 的字符串集合里，每个字符串以长度字节
 * （TYPE 8-bit）起头，因此单串上限是 255 字节；但更靠前的实际约束是
 * SMBIOS 2.1 的「结构表总长 0xFFFF」与 QEMU 自己的 32 KiB 表缓冲。
 * 真正会被逐字段消费的地方（dmidecode / sysfs 的 dmi_id 属性）用的是
 * 内核的 DMI 字符串下限切片，超长部分不会报错而是被截断 —— 截断后
 * 客户机读到的是半截厂商名，又是一类静默失效。
 *
 * 这里取 64 作为工程上限而不是规范的 255：真实厂商名 / 型号 / 序列号
 * 没有超过 64 字符的（最长的是 "Micro-Star International Co. Ltd." 33 字符），
 * 超限意味着上游数据错了，应当立刻暴露。
 */
export const SMBIOS_VALUE_MAX_LEN = 64

/**
 * 必须拒绝逗号的字段：厂商系身份键。
 *
 * 真实出货机器的 DMI 里，厂商名从不带逗号 —— 规范上它是一个短标识符，
 * 不是自由文本。出现逗号只有两种可能：上游数据被拼错，或者有人把
 * 「HP Inc., Palo Alto」这种带地址的串当成了厂商名。
 *
 * 这两种都必须尽早暴露：QEMU 虽然能用双写无损转义，但送去客户机的
 * 会是一个现实中不存在的厂商名，交叉验证时立刻穿帮，而且日志里看不出来。
 *
 * 型号名（product）不在此列：Apple 的型号标识符形如 `MacPro7,1`，
 * 逗号是真实内容的一部分，双写转义后客户机读到的就是原值，没有任何改写。
 */
export const SMBIOS_COMMA_FORBIDDEN_FIELDS = Object.freeze([
  'manufacturer',
  'vendor',
])

/**
 * SMBIOS 字符串值的合法化。
 *
 * QEMU 的 -smbios 用逗号分隔键值对，值里出现逗号会让后续参数错位，
 * 表现为 "invalid -smbios option" 或字段被静默截断。
 *
 * 处理方式按严重程度：
 *   1. 逗号：QEMU 支持双写转义，但这里仍然拒绝（见下面的策略说明）
 *   2. 双引号 / 反斜杠：QEMU 的 QemuOpts 解析器不做引号或反斜杠处理，
 *      这些字符会被原样塞进 SMBIOS 表，客户机侧就是脏数据
 *   3. 非打印字符：剔除的替代方案是拒绝 —— 控制字符不可能来自真实
 *      DMI 表，出现即意味着上游数据被污染
 *
 * 这里的策略是「拒绝而非静默改写」：厂商名写错要立刻暴露，
 * 悄悄把 "HP Inc., Palo Alto" 改成 "HP Inc. Palo Alto"
 * 会让下游拿到一个不存在的厂商名，比报错更难查。
 *
 * 空值返回空串：QEMU 接受 `key=`（等价于不发该字段），调用方据此跳过。
 *
 * 逗号的处理由 opts.alreadyAllowsComma 决定：「拒绝」是默认，也是
 * buildSmbiosArg 在 reject 策略下的行为；escape 策略下调用方显式声明
 * 它会在出口处做双写转义，此处才对逗号放行。
 *
 * @param {unknown} value
 * @param {string} fieldName 出错时用于定位的字段名（如 'type=1.manufacturer'）
 * @param {{ alreadyAllowsComma?: boolean }} [opts]
 * @returns {string}
 */
export function sanitizeSmbiosValue(value, fieldName = 'value', opts = {}) {
  const field = String(fieldName || 'value')
  const allowsComma = Boolean(opts?.alreadyAllowsComma)
  if (value == null) return ''
  const s = String(value)
  if (s === '') return ''

  if (s.length > SMBIOS_VALUE_MAX_LEN) {
    throw new Error(
      `smbios ${field} is ${s.length} chars, exceeds the ${SMBIOS_VALUE_MAX_LEN}-char limit: ${JSON.stringify(s.slice(0, 32))}…`,
    )
  }

  // 逐个字符定位，报错里带上字符与位置 —— 只说「含非法字符」在
  // 一长串型号名里等于没说。
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        `smbios ${field} contains a control character at offset ${i} (0x${code.toString(16).padStart(2, '0')}): ${JSON.stringify(s)}`,
      )
    }
    if (code > 0x7f) {
      throw new Error(
        `smbios ${field} contains a non-ASCII character at offset ${i} (U+${code.toString(16).toUpperCase().padStart(4, '0')}): ${JSON.stringify(s)}`,
      )
    }
    if (ch === ',' && !allowsComma) {
      // QEMU 的 get_opt_value 认 "a,,b" → "a,b"，双写是无损的。此处仍然
      // 拒绝，是因为调用方没有声明它会在出口处双写 —— 未转义的逗号会被
      // 当成下一个键值对的分隔符，把整条 -smbios 切碎。
      throw new Error(
        `smbios ${field} contains a comma at offset ${i}; -smbios splits key=value on commas and an OEM identity must not carry one: ${JSON.stringify(s)}`,
      )
    }
    if (ch === '"') {
      throw new Error(
        `smbios ${field} contains a double quote at offset ${i}; QemuOpts does not unquote values: ${JSON.stringify(s)}`,
      )
    }
    if (ch === '\\') {
      throw new Error(
        `smbios ${field} contains a backslash at offset ${i}; QemuOpts does not unescape values: ${JSON.stringify(s)}`,
      )
    }
  }

  return s
}

/**
 * SMBIOS 字符串主值校验：可打印 ASCII、长度上限内。
 *
 * 这是 sanitizeSmbiosValue 的布尔版，供表单预检一类「只想知道行不行」
 * 的场景使用；逗号 / 引号 / 反斜杠在此都算不合格，与 sanitize 保持一致。
 */
export function isSmbiosSafeValue(value) {
  try {
    sanitizeSmbiosValue(value, 'value')
    return true
  } catch {
    return false
  }
}

/**
 * QEMU `-smbios` 值转义：逗号双写。
 *
 * 不做这件事，`product=ThinkPad X1, Gen 11` 会被切成
 * `product=ThinkPad X1` + ` Gen 11`，后者变成一个不存在的字段，
 * QEMU 直接拒绝整条参数 —— 启动失败，日志里还看不出是哪个值的问题。
 */
export function escapeSmbiosValue(value) {
  return String(value ?? '').replace(/,/g, ',,')
}

/** 反向：把双写逗号还原，用于从命令行回读断言。 */
export function unescapeSmbiosValue(value) {
  return String(value ?? '').replace(/,,/g, ',')
}

/**
 * 按 QEMU 规则切分 `-smbios` 参数：逗号分隔，双写逗号视为字面逗号。
 */
export function splitSmbiosArgs(raw) {
  const s = String(raw ?? '')
  const parts = []
  let cur = ''
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (ch === ',') {
      if (s[i + 1] === ',') {
        cur += ','
        i += 1
      } else {
        parts.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur) parts.push(cur)
  return parts
}

/**
 * 构造单条 `type=N,key=value,...` 参数。
 *
 * 每个字段值都过 sanitizeSmbiosValue —— 不存在「只校验一部分字段」的路径。
 * 默认策略是 reject：OEM 身份字段里出现逗号 / 引号 / 反斜杠 / 控制字符
 * 一律抛错。传 commaPolicy: 'escape' 才退回双写转义（仅供已知需要
 * 携带自由文本的调用方，例如 human-readable 的 asset tag）。
 *
 * @param {number} type
 * @param {object} fields
 * @param {{ commaPolicy?: 'escape'|'reject' }} [opts]
 * @returns {{ value: string, notes: string[] }}
 */
export function buildSmbiosArg(type, fields, opts = {}) {
  const allowed = SMBIOS_FIELDS[type]
  if (!allowed) throw new Error(`unsupported smbios type: ${type}`)
  const policy = opts.commaPolicy || 'escape'
  if (!['escape', 'reject'].includes(policy)) {
    throw new Error(`commaPolicy must be "escape" or "reject", got "${policy}"`)
  }
  const notes = []
  const parts = [`type=${type}`]

  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) {
      // 发一个 QEMU 不认的字段会让整条 -smbios 启动失败，日志里只报
      // "invalid parameter" 而不指出是哪个 key。在构造期直接拒绝更省事。
      throw new Error(`smbios type=${type} has no field "${key}" (allowed: ${allowed.join(', ')})`)
    }
    const raw = fields[key]
    if (raw == null || raw === '') continue

    // 逗号策略按字段名分层，而不是整条参数一刀切：
    //
    //   厂商系字段（manufacturer / vendor）→ 一律拒绝。
    //     真实机器的 DMI 厂商名从不带逗号，出现即数据错误。
    //
    //   其余字段（product / version / serial / …）→ 双写转义。
    //     Apple 的型号标识符 `MacPro7,1` 逗号是真实内容，转义后客户机
    //     读到的仍是 `MacPro7,1`，没有改写，也没有被切碎。
    //
    // 字符集 / 长度 / 引号 / 反斜杠 / 控制字符对所有字段都是硬错误：
    // QemuOpts 对它们不做任何处理，放行等于往 SMBIOS 表里塞脏数据。
    const commaForbidden = SMBIOS_COMMA_FORBIDDEN_FIELDS.includes(key)
    const allowComma = policy === 'escape' && !commaForbidden
    const text = sanitizeSmbiosValue(raw, `type=${type}.${key}`, { alreadyAllowsComma: allowComma })

    if (text.includes(',')) {
      notes.push(`type=${type}.${key} 含逗号，已按 QEMU 规则双写转义`)
    }
    parts.push(`${key}=${escapeSmbiosValue(text)}`)
  }
  return { value: parts.join(','), notes }
}


/** UUID 必须是 8-4-4-4-12 小写十六进制。QEMU 的 qemu_uuid_parse 对此严格。 */
export function isSmbiosUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(value ?? ''))
}

/** MAC：6 段、冒号分隔、单播（首字节最低位为 0）、非全零。 */
export function isUnicastMac(value) {
  const s = String(value ?? '').toUpperCase()
  if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(s)) return false
  const first = parseInt(s.slice(0, 2), 16)
  if ((first & 0x01) !== 0) return false
  return s !== '00:00:00:00:00:00'
}

/**
 * QEMU 自带网卡的默认 OUI。
 *
 * `52:54:00` 是 QEMU 的固定前缀，首字节 0x52 的第二个 bit 置位即本地管理地址。
 * 这个组合在所有虚拟化环境里都是「这是 QEMU 虚拟机」的直接证据 ——
 * 任何检测都会先看这一段，所以必须排除。
 */
export const QEMU_DEFAULT_OUI = Object.freeze(['52:54:00', '54:52:00'])

/** 真实网卡厂商 OUI 池。每台机器按 vm_id 确定性取一个，同批机器可共享同一厂商。 */
export const NIC_OUI_POOL = Object.freeze([
  'F0:18:98', // Apple
  'A4:BB:6D', // Intel
  '00:50:56', // VMware
  '3C:52:82', // Intel
  'B8:27:EB', // Raspberry Pi Foundation
  '00:1B:21', // Intel
  'D8:9E:F3', // Dell
])

/**
 * 判定一个 OUI 是否属于「一眼虚拟机」。
 *
 * 除 QEMU 自己的 52:54:00 之外，还要排除本地管理位（首字节 0x02 置位）：
 * 那是管理员随手分配地址的特征，真实出货网卡不用。
 */
export function isVirtualOui(oui) {
  const s = String(oui ?? '').toUpperCase()
  if (!/^[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/.test(s)) return true
  if (QEMU_DEFAULT_OUI.includes(s)) return true
  const first = parseInt(s.slice(0, 2), 16)
  // 0x02 = 本地管理位，0x01 = 组播位，两者都是虚拟/临时地址的痕迹。
  return (first & 0x03) !== 0
}

// ─────────────── persona 字段读取（三平台字段名不同） ───────────────

/**
 * 平台级厂商兜底。
 *
 * macOS 的 persona 骨架（macos.mjs）压根没有 sys_vendor 这类字段 ——
 * Apple 不通过 DMI 暴露厂商名，那些机器报的是 model_identifier / board_id。
 * 但 QEMU 的 SMBIOS 表必须有 manufacturer，回退成 'Generic' 会在客户机
 * `dmidecode -s system-manufacturer` 里显示 Generic —— 一台不存在的
 * 机器厂商，比参数写错更容易被交叉验证筛出来。
 *
 * 所以按平台给正确兜底值。这只在 persona 缺失该字段时生效，不覆盖
 * 调用方显式给的值。
 */
const PLATFORM_VENDOR_FALLBACK = Object.freeze({
  macos: 'Apple Inc.',
  windows: 'Dell Inc.',
  linux: 'Dell Inc.',
})

/** persona → 系统厂商。 */
export function sysVendorOf(persona) {
  const hw = persona?.hardware || {}
  const explicit = hw.sys_vendor || hw.system_vendor || hw.manufacturer
  if (explicit) return String(explicit)
  return PLATFORM_VENDOR_FALLBACK[String(persona?.platform || '')] || 'Generic'
}

/** persona → 产品名。 */
export function productNameOf(persona) {
  const hw = persona?.hardware || {}
  return String(hw.product_name || hw.model || hw.model_identifier || persona?.vm_id || 'Generic')
}

/** persona → 产品版本 / SKU。 */
export function productVersionOf(persona) {
  const hw = persona?.hardware || {}
  return String(hw.product_version || hw.system_sku || hw.version || '1.0')
}

/** persona → 产品 family。 */
export function productFamilyOf(persona) {
  const hw = persona?.hardware || {}
  return String(hw.product_family || hw.system_family || hw.family || '')
}

/** persona → 序列号。 */
export function productSerialOf(persona) {
  const hw = persona?.hardware || {}
  return String(hw.product_serial || hw.serial_number || '')
}

/** persona → UUID（统一成小写 SMBIOS 形态）。 */
export function productUuidOf(persona) {
  const hw = persona?.hardware || {}
  return String(hw.product_uuid || hw.uuid || hw.hardware_uuid || '').toLowerCase()
}

/** persona → MAC。 */
export function personaMacOf(persona) {
  return String(persona?.network?.mac || persona?.network?.en0_mac || '').toUpperCase()
}

/**
 * 机器类型是否支持 type=1 的 `family=`。
 * i440fx 族没有这个字符串槽位，传了也是白传。
 */
export function machineSupportsFamily(machine) {
  const m = String(machine || '').toLowerCase()
  // `pc-q35-8.0` / `pc-q35` / `q35` / `q35,smm=on` / `virt` 都算。
  const bare = m.startsWith('pc-') ? m.slice(3) : m
  return FAMILY_CAPABLE_MACHINES.some((k) => bare === k || bare.startsWith(`${k}-`) || bare.startsWith(`${k},`))
}

// ─────────────── 四张 SMBIOS 表 ───────────────

/**
 * BIOS 日期归一化成 SMBIOS 要求的 MM/DD/YYYY。
 *
 * 三平台的日期习惯不同：Linux/macOS persona 给 `09/12/2024`，
 * Windows persona 给 ISO 的 `2023-11-14T00:00:00Z`。SMBIOS type=0 的 date
 * 字段只接受 MM/DD/YYYY —— dmidecode 按这个格式解析，别的格式会被原样显示，
 * 与真实 BIOS 不一致。所以这里必须归一化，而不是要求调用方改 persona。
 */
export function normalizeBiosDate(value) {
  const raw = String(value ?? '').trim()
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) return raw
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`
  return ''
}

/**
 * 把 persona 的硬件字段摊平成四张 SMBIOS 表。
 *
 * 刻意不依赖 persona.hardware 里 board_* / chassis_* 是否齐全：缺的从配对表
 * 补齐，而不是留空。留空会在 dmidecode 里显示成 `Not Specified`，
 * 那本身就是一批机器的共同特征。
 *
 * @param {object} persona
 * @param {object} [opts]
 * @param {string} [opts.machine='q35']
 * @returns {{ tables: object, notes: string[] }}
 */
export function smbiosTablesForPersona(persona, opts = {}) {
  const machine = String(opts.machine || 'q35')
  const notes = []
  const vmId = String(persona?.vm_id || persona?.vmId || 'default')
  const hw = persona?.hardware || {}

  const uuid = productUuidOf(persona)
  if (!uuid) {
    throw new Error(`persona ${vmId} has no product uuid; SMBIOS type=1 requires one`)
  }
  if (!isSmbiosUuid(uuid)) {
    throw new Error(`persona ${vmId} product uuid "${uuid}" is not 8-4-4-4-12 lowercase hex`)
  }

  const serial = productSerialOf(persona)
  if (!serial) {
    throw new Error(`persona ${vmId} has no serial number; SMBIOS type=1 requires one`)
  }

  const vendor = sysVendorOf(persona)
  // BIOS 版本与主板型号按「机型」挑选，不按 vm_id。
  //
  // 这一点是身份自洽的核心：同一批采购的同型号机器，BIOS 版本和主板型号必然相同。
  // 若按 vm_id 取，20 台同型号机器会凑出 5 种 BIOS 版本 —— 那是合成痕迹，
  // 比「全都一样」更容易被筛出来。逐槽位变化的只有序列号 / UUID / MAC / 资产标签。
  const modelKey = `${vendor}|${productNameOf(persona)}`
  const profile = pickFrom(modelKey, BOARD_PROFILES[vendor] || [fallbackBoardProfile(vendor)], 'kvm-board')
  const bios = pickFrom(modelKey, BIOS_PROFILES, 'kvm-bios')

  const biosDate = normalizeBiosDate(hw.bios_date || hw.bios_release_date || bios.date)
  const biosVersion = String(hw.bios_version || bios.version)
  if (!biosDate) {
    throw new Error(`persona ${vmId} has no usable bios date; SMBIOS type=0 requires MM/DD/YYYY`)
  }

  const tables = {
    0: {
      vendor: String(hw.bios_vendor || vendor),
      version: biosVersion,
      date: biosDate,
    },
    1: {
      manufacturer: vendor,
      product: productNameOf(persona),
      version: productVersionOf(persona),
      serial,
      uuid,
      sku: String(hw.system_sku || hw.sku || ''),
      family: productFamilyOf(persona),
    },
    2: {
      manufacturer: String(hw.board_vendor || hw.baseboard_manufacturer || profile.vendor),
      product: String(hw.board_name || hw.baseboard_product || profile.name),
      version: String(hw.board_version || hw.baseboard_version || profile.version),
      serial: String(hw.board_serial || serial),
      asset: String(hw.board_asset_tag || `ATAG${deriveSerial(vmId, 8, TAG_ALPHABET, 'kvm-board-asset')}`),
      location: String(hw.board_location || ''),
    },
    3: {
      manufacturer: String(hw.chassis_vendor || vendor),
      version: String(hw.chassis_version || '1.0'),
      serial: String(hw.chassis_serial || serial),
      asset: String(hw.chassis_asset_tag || `ATAG${deriveSerial(vmId, 8, TAG_ALPHABET, 'kvm-chassis-asset')}`),
      sku: String(hw.chassis_sku || ''),
    },
  }

  // family 只在 q35 / virt 上有容身之处。降级而不是抛错：i440fx 仍然可用，
  // 只是客户机的 family 读出来是空的 —— 这件事必须在 warnings 里说清楚。
  if (tables[1].family && !machineSupportsFamily(machine)) {
    notes.push(`machine=${machine} 不支持 SMBIOS type=1 的 family 字段，该值不会出现在客户机里`)
    delete tables[1].family
  }

  // 必填字段为空会被 dmidecode 显示成默认占位值，那本身是批量特征。
  for (const [type, fields] of Object.entries(tables)) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === '' && key !== 'sku' && key !== 'family' && key !== 'location') {
        notes.push(`smbios type=${type}.${key} 为空，客户机将显示默认占位值`)
      }
    }
  }

  return { tables, notes }
}

// ─────────────── 逐槽位派生的硬件值 ───────────────

/**
 * 逐槽位派生的 MAC。
 *
 * OUI 按「批次」取，不按槽位取：同批采购的机器装的是同一款网卡，
 * OUI 必然相同。若按 vm_id 逐台取，20 台机器会凑出 7 个不同厂商的网卡 ——
 * 那比「全都相同」更像批量生产的痕迹。
 *
 * 批次键的取法是「去掉 vm_id 尾部的序号」：claude-01…claude-20 都归到
 * claude，于是它们共享一个 OUI；不同批次（claude / codex）各自独立。
 *
 * @param {string} vmId
 * @param {string|null} [oui] 显式指定 OUI；给了就不再按批次挑
 */
export function kvmMacFor(vmId, oui = null) {
  const id = String(vmId)
  const batchKey = id.replace(/[-_]?\d+$/, '') || id
  const chosen = oui || pickFrom(batchKey, NIC_OUI_POOL, 'kvm-oui')
  if (isVirtualOui(chosen)) {
    throw new Error(`OUI "${chosen}" is a virtual/administrative prefix and cannot be used for a NIC`)
  }
  return deriveMac(id, chosen)
}

/** 逐槽位派生的 virtio-blk 磁盘序列号，客户机 lsblk / udev 会读到。 */
export function kvmDiskSerialFor(vmId) {
  return deriveSerial(String(vmId), 16, DISK_SERIAL_ALPHABET, 'kvm-disk-serial')
}

/**
 * cloud-init 的 instance-id。
 *
 * 必须逐槽位不同：cloud-init 用它判断「这是不是新实例」。20 个槽位共用
 * 一个 instance-id 时，第二个槽位启动会认为已经配置过，跳过 seed 里的初始化。
 */
export function kvmInstanceIdFor(vmId) {
  const h = deriveSerial(String(vmId), 32, '0123456789abcdef', 'kvm-instance-id')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// ─────────────── 路径布局与冲突检测 ───────────────

/**
 * 默认路径布局。所有槽位的产物集中在一个根目录下，按 vm_id 分目录。
 * 路径冲突检测依赖这个固定结构（见 detectDiskConflicts）。
 */
export function kvmPathsFor({ rootDir, vmId }) {
  const root = String(rootDir || '/var/lib/persona-kvm').replace(/\/+$/, '')
  const slotDir = `${root}/${vmId}`
  return {
    rootDir: root,
    slotDir,
    diskPath: `${slotDir}/disk.qcow2`,
    seedIsoPath: `${slotDir}/seed.iso`,
    pidFile: `${slotDir}/qemu.pid`,
    logPath: `${slotDir}/console.log`,
    qmpSocket: `${slotDir}/qmp.sock`,
    varsFile: `${slotDir}/OVMF_VARS.fd`,
    sshKeyPath: `${slotDir}/id_ed25519`,
  }
}

/**
 * 磁盘路径冲突检测。
 *
 * 两类冲突都必须拦：
 *   1. 两个槽位映射到同一个 diskPath —— 后启动的那个会写坏前一个的文件系统。
 *      这是数据损坏，不是启动失败，所以最危险。
 *   2. 槽位目录互相嵌套 —— A 的 slotDir 是 B 的父目录，清理 A 会连 B 一起删。
 *
 * @param {Array<{vmId:string, diskPath:string, slotDir?:string}>} slots
 * @returns {{ ok: boolean, conflicts: Array<object> }}
 */
export function detectDiskConflicts(slots) {
  const list = Array.isArray(slots) ? slots : []
  const conflicts = []

  const byDisk = new Map()
  for (const s of list) {
    const key = String(s?.diskPath || '')
    if (!key) continue
    if (byDisk.has(key)) {
      conflicts.push({
        kind: 'disk-path-shared',
        diskPath: key,
        slots: [byDisk.get(key), String(s?.vmId)],
      })
    } else {
      byDisk.set(key, String(s?.vmId))
    }
  }

  const dirs = list
    .map((s) => ({ vmId: String(s?.vmId), dir: String(s?.slotDir || '').replace(/\/+$/, '') }))
    .filter((d) => d.dir)
  for (let i = 0; i < dirs.length; i += 1) {
    for (let j = i + 1; j < dirs.length; j += 1) {
      const { vmId: idA, dir: a } = dirs[i]
      const { vmId: idB, dir: b } = dirs[j]
      if (a === b) {
        conflicts.push({ kind: 'slot-dir-shared', slots: [idA, idB], dir: a })
      } else if (a.startsWith(`${b}/`)) {
        conflicts.push({ kind: 'slot-dir-nested', parent: idB, child: idA, dir: b })
      } else if (b.startsWith(`${a}/`)) {
        conflicts.push({ kind: 'slot-dir-nested', parent: idA, child: idB, dir: a })
      }
    }
  }

  return { ok: conflicts.length === 0, conflicts }
}

// ─────────────── 资源规则 ───────────────

/**
 * KVM 槽位的资源规则。
 *
 * 与 Docker 版的差异必须明确：容器的 `--cpus` 是 CFS 配额（上限），
 * 超订没有成本；虚拟机的 vCPU 是真实宿主线程 + 各自独立的客户机内核，
 * 空闲时也占着内存和内核态结构。所以这里的上限更低、下限更高。
 */
export const KVM_RESOURCE_RULES = Object.freeze({
  /** 系统盘标称容量（GiB）。qcow2 稀疏，实际占用取决于写入量。 */
  diskGb: 40,
  /** 首次启动后的实际占用估算（GiB）：cloud image 展开 + 基础软件。 */
  baseFootprintGb: 4,
  /** 标称容量的实际占用上界系数（无 discard 时 qcow2 会持续涨）。 */
  growthFactor: 0.5,
  /** 内存下限 / 上限（MiB）。低于 2 GiB 起不来常规发行版桌面栈。 */
  minMemoryMb: 2048,
  maxMemoryMb: 8192,
  memoryDivisor: 24,
  memoryStep: 256,
  /** vCPU 下限 / 上限。 */
  minVcpus: 2,
  maxVcpus: 4,
  vcpuDivisor: 8,
  /** 每台 VM 的内核态固定开销（MiB）：QEMU 进程 + KVM 结构 + 页表。 */
  hypervisorOverheadMb: 320,
  /** 宿主机预留比例：无 KSM、无 balloon 时的余量需求高于 Docker。 */
  hostReserveRatio: 0.2,
  /**
   * vCPU 超订倍数。默认为 1.0 = 不超订。
   * 虚拟机争抢 vCPU 的代价是客户机内核调度抖动，比容器配额耗尽更明显，
   * 所以不默认放开；要超订必须显式抬这个值，让它是被记录的决定。
   */
  cpuOversubscribe: 1.0,
})

/** persona 名义内存 → 分配给虚拟机的内存（MiB）。 */
export function kvmMemoryMb(persona, rules = KVM_RESOURCE_RULES) {
  const bytes = Number(persona?.hardware?.ram_bytes || 0)
  const advertisedMb = bytes > 0 ? bytes / 1024 ** 2 : 0
  if (advertisedMb <= 0) return rules.minMemoryMb
  const raw = Math.floor(advertisedMb / rules.memoryDivisor / rules.memoryStep) * rules.memoryStep
  return Math.min(rules.maxMemoryMb, Math.max(rules.minMemoryMb, raw))
}

/** persona 逻辑核数 → vCPU 数。 */
export function kvmVcpus(persona, rules = KVM_RESOURCE_RULES) {
  const hw = persona?.hardware || {}
  const cores = Number(hw.logical_cores ?? hw.processor?.logical_processors ?? 1)
  const n = Number.isFinite(cores) && cores > 0 ? cores : 1
  const raw = Math.ceil(n / rules.vcpuDivisor)
  return Math.min(rules.maxVcpus, Math.max(rules.minVcpus, raw))
}

/**
 * 单槽位的实际磁盘占用估算（MiB）。
 *
 * 关键区别：Docker 槽位给的是固定目录，KVM 槽位是 qcow2 稀疏文件 ——
 * 40 GiB 标称的盘刚建出来只有几百 KiB，但会随写入增长。
 * 规划时要按「上界」算，否则 20 个槽位同时跑起来才发现在线扩容。
 */
export function kvmDiskFootprintMb(rules = KVM_RESOURCE_RULES) {
  const base = rules.baseFootprintGb * 1024
  const growth = rules.diskGb * 1024 * rules.growthFactor
  return Math.round(base + growth)
}

/** 单槽位的实际内存占用（MiB）：客户机内存 + hypervisor 固定开销。 */
export function kvmMemoryFootprintMb(persona, rules = KVM_RESOURCE_RULES) {
  return kvmMemoryMb(persona, rules) + rules.hypervisorOverheadMb
}

// ─────────────── 主函数 ───────────────

/**
 * 把 persona 转成 QEMU 命令行参数。
 *
 * @param {object} p
 * @param {string} [p.platform='linux']
 * @param {string} p.vmId
 * @param {string} [p.diskPath]           系统盘路径（qcow2）
 * @param {string} [p.imagePath]          cloud image 基础镜像路径（记录用）
 * @param {number} [p.memoryMb]
 * @param {number} [p.vcpus]
 * @param {string} [p.macAddress]
 * @param {string} [p.bridge]             网络桥
 * @param {string} [p.machine='q35']
 * @param {object} p.persona              已构造好的 persona
 * @param {object} [p.paths]              覆盖默认路径布局
 * @param {string} [p.accel='kvm']        'kvm' | 'tcg'
 * @param {string} [p.cpuModel='host']
 * @param {string} [p.commaPolicy='escape'] 'escape' | 'reject'
 * @param {boolean} [p.allowVirtualOui]   允许使用虚拟 OUI（仅调试）
 * @returns {{argv: string[], smbios: object, warnings: string[]}}
 */
export function qemuArgsForPersona(p = {}) {
  const platform = String(p.platform || p.persona?.platform || 'linux')
  const vmId = String(p.vmId ?? p.vm_id ?? p.persona?.vm_id ?? 'default')
  const machine = String(p.machine || 'q35')
  const accel = String(p.accel || 'kvm')
  const cpuModel = String(p.cpuModel || 'host')
  // 默认 reject：OEM 身份字段（厂商 / 型号 / 序列号）里出现逗号时宁可
  // 拒绝也不静默改写。双写转义技术上可行，但它会把一份下游查不到的
  // 厂商名送进客户机 —— 启动时不容易发现，事后极难追。
  // 默认 escape：型号名里的逗号（`MacPro7,1`）是真实内容，双写转义后
  // 客户机读到的仍是原值。厂商系字段无论如何都走拒绝，见 SMBIOS_COMMA_FORBIDDEN_FIELDS。
  const commaPolicy = String(p.commaPolicy || 'escape')
  if (!['escape', 'reject'].includes(commaPolicy)) {
    throw new Error(`commaPolicy must be "escape" or "reject", got "${commaPolicy}"`)
  }

  if (!['kvm', 'tcg'].includes(accel)) {
    throw new Error(`accel must be "kvm" or "tcg", got "${accel}"`)
  }
  if (!p.persona) {
    throw new Error('qemuArgsForPersona requires p.persona (build it with buildPersona)')
  }
  const persona = p.persona

  const paths = { ...kvmPathsFor({ rootDir: p.rootDir, vmId }), ...(p.paths || {}) }
  const diskPath = String(p.diskPath || paths.diskPath)
  if (!diskPath) throw new Error('qemuArgsForPersona requires a diskPath')
  if (paths.diskPath === paths.pidFile || paths.diskPath === paths.logPath) {
    throw new Error(`path layout for ${vmId} maps the disk onto another artifact`)
  }

  const memoryMb = Number.isInteger(p.memoryMb) ? p.memoryMb : kvmMemoryMb(persona)
  const vcpus = Number.isInteger(p.vcpus) ? p.vcpus : kvmVcpus(persona)
  if (memoryMb < 512) throw new Error(`memoryMb too small for a guest kernel: ${memoryMb}`)
  if (vcpus < 1) throw new Error(`vcpus must be >= 1, got ${vcpus}`)

  const macAddress = String(p.macAddress || personaMacOf(persona) || kvmMacFor(vmId)).toUpperCase()
  if (!isUnicastMac(macAddress)) {
    throw new Error(`MAC "${macAddress}" is not a legal unicast address for vm ${vmId}`)
  }
  if (isVirtualOui(macAddress.slice(0, 8)) && !p.allowVirtualOui) {
    throw new Error(`MAC "${macAddress}" uses a virtual OUI prefix; pass an OEM prefix instead`)
  }

  const { tables, notes } = smbiosTablesForPersona(persona, { machine })
  const warnings = [...notes]

  // 四张表逐一构造。type 顺序固定 0→1→2→3：QEMU 按命令行顺序建表，
  // 固定顺序让两个槽位的参数可以逐行 diff。
  const smbiosArgs = []
  const smbios = {}
  for (const type of [0, 1, 2, 3]) {
    const built = buildSmbiosArg(type, tables[type], { commaPolicy })
    smbiosArgs.push('-smbios', built.value)
    smbios[type] = { ...tables[type], arg: built.value }
    for (const n of built.notes) warnings.push(n)
  }
  smbios[3].chassisType = QEMU_FIXED_CHASSIS_TYPE

  const bridge = String(p.bridge || '')
  if (!bridge) {
    warnings.push('未指定 bridge，回落到 QEMU user 网络（NAT，无入向连通性）')
  }

  const diskSerial = String(p.diskSerial || kvmDiskSerialFor(vmId))
  const accelArg = accel === 'kvm' ? 'kvm' : 'tcg,thread=multi'
  const resolvedCpu = accel === 'kvm' ? cpuModel : (cpuModel === 'host' ? 'max' : cpuModel)

  const argv = [
    'qemu-system-x86_64',
    '-name', `persona-${vmId}`,
    '-machine', machine,
    '-accel', accelArg,
    '-cpu', resolvedCpu,
    '-smp', String(vcpus),
    '-m', String(memoryMb),
    ...smbiosArgs,
    '-drive', `file=${diskPath},if=none,id=disk0,format=qcow2,cache=writeback,discard=unmap`,
    '-device', `virtio-blk-pci,drive=disk0,bootindex=1,serial=${diskSerial}`,
    '-netdev', bridge ? `bridge,id=net0,br=${bridge}` : 'user,id=net0',
    '-device', `virtio-net-pci,netdev=net0,mac=${macAddress}`,
    '-object', 'rng-random,id=rng0,filename=/dev/urandom',
    '-device', 'virtio-rng-pci,rng=rng0',
    '-chardev', `socket,id=qmp,path=${paths.qmpSocket},server=on,wait=off`,
    '-mon', 'chardev=qmp,mode=control',
    '-serial', `file:${paths.logPath}`,
    '-display', 'none',
    '-daemonize',
    '-pidfile', paths.pidFile,
  ]

  return {
    platform,
    vmId,
    persona,
    machine,
    accel,
    cpuModel: resolvedCpu,
    memoryMb,
    vcpus,
    mac: macAddress,
    diskSerial,
    diskPath,
    imagePath: p.imagePath ? String(p.imagePath) : null,
    bridge: bridge || null,
    paths,
    smbios,
    argv,
    warnings,
    serial: productSerialOf(persona),
    uuid: productUuidOf(persona),
  }
}

/** 生成完整的 QEMU 命令行字符串（展示 / 审计用）。 */
export function qemuCommandLine(spec) {
  return shellJoin(spec.argv)
}

/** 把 argv 渲染成可复制的 shell 片段。 */
export function shellJoin(argv) {
  return argv
    .map((a) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`))
    .join(' ')
}

/**
 * 从 argv 回读 SMBIOS 参数。
 *
 * 用途是把「生成结果」与「真正传给 QEMU 的字符串」对齐：
 * 两者一旦分叉，测试里的 smbios 对象再正确也没意义。
 */
export function readSmbiosFromArgv(argv) {
  const out = {}
  const list = Array.isArray(argv) ? argv : []
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] !== '-smbios') continue
    const raw = String(list[i + 1] || '')
    const m = /^type=(\d+)/.exec(raw)
    if (!m) continue
    const type = Number(m[1])
    const fields = {}
    // 按逗号切分时必须跳过双写逗号，否则含逗号的值会被切碎。
    for (const part of splitSmbiosArgs(raw)) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      fields[part.slice(0, eq)] = unescapeSmbiosValue(part.slice(eq + 1))
    }
    out[type] = fields
  }
  return out
}
