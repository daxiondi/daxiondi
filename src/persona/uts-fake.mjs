/**
 * 按槽位生成 UTS（kernel release / version）。
 *
 * 为什么要内核模块：uname(2) 返回 current->nsproxy->uts_ns->name，
 * 用户态没有任何系统调用能改其中的 release/version（sethostname 只能改
 * nodename/domainname）。/proc/version 与 /proc/sys/kernel/osrelease 也读
 * 同一个 uts_ns，所以改一处三处同步生效。
 *
 * 为什么不用 bind mount：runc 明确拒绝在 /proc 内建挂载点
 * （"cannot be mounted because it is inside /proc"），/proc/version 和
 * /proc/sys/kernel/* 都挂不上。这条路走不通，只能内核层。
 *
 * 实测：一个模块 + 每槽写一次 /proc/skylink_uts，20 个槽 uname -r 全不同，
 * 互不影响，宿主机也不受影响。
 */

/** Ubuntu 5.15 系列的真实 release 列表（2023-2026 陆续发布）。
 *  挑真实存在过的版本号，比随机数字更难被识别为伪造。 */
export const RELEASE_POOL = Object.freeze([
  '5.15.0-91-generic', '5.15.0-92-generic', '5.15.0-94-generic',
  '5.15.0-97-generic', '5.15.0-101-generic', '5.15.0-102-generic',
  '5.15.0-105-generic', '5.15.0-107-generic', '5.15.0-113-generic',
  '5.15.0-117-generic', '5.15.0-119-generic', '5.15.0-122-generic',
  '5.15.0-125-generic', '5.15.0-130-generic', '5.15.0-134-generic',
  '5.15.0-136-generic', '5.15.0-138-generic', '5.15.0-139-generic',
  '5.15.0-140-generic', '5.15.0-141-generic',
])

/** Debian 5.15 内核包的真实版本号后缀是 -amd64，不是 -generic。 */
export const DEBIAN_RELEASE_POOL = Object.freeze([
  '5.15.0-0.deb11.13-amd64', '5.15.0-0.deb11.7-amd64',
  '5.15.0-0.deb11.11-amd64', '5.15.0-0.deb11.17-amd64',
  '5.15.0-0.deb11.21-amd64', '5.15.0-0.deb11.4-amd64',
  '5.15.0-0.deb11.9-amd64', '5.15.0-0.deb11.15-amd64',
  '5.15.0-0.deb11.19-amd64', '5.15.0-0.deb11.23-amd64',
  '5.15.0-0.deb11.25-amd64', '5.15.0-0.deb11.27-amd64',
])

/** RHEL/Rocky 9 系列：5.14 为主，后缀 .el9.x86_64。 */
export const RHEL_RELEASE_POOL = Object.freeze([
  '5.14.0-362.8.1.el9_3.x86_64', '5.14.0-284.30.1.el9_2.x86_64',
  '5.14.0-427.13.1.el9_4.x86_64', '5.14.0-362.18.1.el9_3.x86_64',
  '5.14.0-427.16.1.el9_4.x86_64', '5.14.0-284.11.1.el9_2.x86_64',
  '5.14.0-362.24.1.el9_3.x86_64', '5.14.0-427.18.1.el9_4.x86_64',
])

/** Ubuntu 内核 version 字段的真实形态：
 *  "#<build>-Ubuntu SMP <weekday> <Mon> <d> <HH:MM:SS> UTC <year>" */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 为槽位生成 release + version。
 *
 * 确定性：同一 vmId 永远得到同一组值。不能随机 —— 每次重启换内核版本
 * 比不换更可疑（真实机器不会隔几分钟升级一次内核）。
 *
 * @param {object} p
 * @param {string} p.vmId
 * @param {number} [p.index]  槽位序号，用于错开 release
 * @param {string} [p.release] 显式指定 release（覆盖自动选择）
 */
// distro 规则从 os-release-fake 取，不在这里复制一份 ——
// 之前复制了个 6 项硬编码表，扩池子到 20 项时它不会跟着变，
// 结果就是 uname 报 -generic 而 os-release 说 debian。
import { distroIdAt } from './os-release-fake.mjs'

const distroAt = distroIdAt

export function utsForSlot({ vmId = '', index = 0, release = null, distro = null } = {}) {
  // 内核后缀必须与发行版自洽：报 Debian 却 uname 出 "-generic" 是硬矛盾
  // （-generic 是 Ubuntu 专有后缀）。所以发行版由调用方传入，
  // 由它决定后缀。
  //
  //   ubuntu → 5.15.0-N-generic   （Ubuntu 官方内核）
  //   debian → 5.15.0-N-amd64     （Debian 官方内核包后缀）
  //   rocky  → 5.14.0-N.el9.x86_64（RHEL 系，版本号也不同）
  let rel
  if (release) {
    rel = release
  } else {
    // 关键：不能直接 index % pool.length ——
    // 20 个槽里 Debian 只占 5-6 个，那些槽的 index 是 3,4,11,16...（不连续），
    // 对池长取模会撞。改用「该发行版内部的第几个槽」做序号：
    // 先算出这个 distro 在 0..index 里出现过几次，用它当池内偏移。
    //
    // 这样同一 distro 的每个槽都拿到池里不同的项，只要该 distro
    // 的槽数 <= 池长就保证不撞。
    const pool = distro === 'debian' ? DEBIAN_RELEASE_POOL
      : distro === 'rocky' ? RHEL_RELEASE_POOL
        : RELEASE_POOL
    let nth = 0
    for (let i = 0; i < Number(index || 0); i += 1) {
      if (distroAt(i) === (distro || 'ubuntu')) nth += 1
    }
    rel = pool[nth % pool.length]
  }
  const h = fnv1a(`${vmId}#uts`)

  // build 号：Ubuntu 的 #N 与 release 的补丁号大致同量级（#91 后缀对应 #100 左右）
  const patch = Number((rel.match(/-(\d+)-/) || [])[1] || 100)
  const build = patch + 9 + (h % 7)

  const weekday = WEEKDAYS[h % WEEKDAYS.length]
  const month = MONTHS[(h >> 3) % MONTHS.length]
  const day = 1 + ((h >> 6) % 28)
  const hour = (h >> 9) % 24
  const minute = (h >> 14) % 60
  const second = (h >> 19) % 60
  const year = 2023 + ((h >> 24) % 4)

  const pad = (n) => String(n).padStart(2, '0')
  // version 字段各发行版写法不同，不能一律套 Ubuntu 的
  let version
  if (distro === 'debian') {
    version = `#1 SMP Debian 5.15.${(h % 80) + 60}-1 (2024-0${(h % 9) + 1}-${pad(day)})`
  } else if (distro === 'rocky') {
    version = `#1 SMP PREEMPT_DYNAMIC ${weekday} ${month} ${day} ${pad(hour)}:${pad(minute)}:${pad(second)} UTC ${year}`
  } else {
    version = `#${build}-Ubuntu SMP ${weekday} ${month} ${day} ${pad(hour)}:${pad(minute)}:${pad(second)} UTC ${year}`
  }

  return { release: rel, version }
}

/** 拼成传给 /proc/skylink_uts 的一行：<pid> <release> <version> */
export function utsWritePayload({ pid, release, version }) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    throw new Error(`utsWritePayload: invalid pid ${pid}`)
  }
  // version 含空格，内核侧按前两个空格切分，余下整段算 version
  return `${Number(pid)} ${release} ${version}`
}
