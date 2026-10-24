/**
 * 按槽位生成 /etc/os-release。
 *
 * 依据：对 Claude Code 2.1.310 的 strace 实测，它读 /etc/os-release 并把
 * linux_distro_id / linux_distro_version 放进遥测的 env 字段。
 * 20 个槽如果都报 ubuntu 22.04（宿主实际值）就跟没做一样。
 *
 * 注意这不是"硬件指纹"，是发行版标识 —— 但它和 uname -r 必须自洽：
 * 报 Debian 却 uname 出 -generic 内核，或报 Ubuntu 24.04 却配 5.15 内核，
 * 都是明显的矛盾。所以这里限定在"能用 5.15 内核的发行版"范围内。
 */

/** 与 5.15 内核兼容的发行版组合。Ubuntu 22.04 出厂即 5.15，
 *  Debian 11 可装 5.15 backports，Rocky 9 是 5.14 但常升级到 5.15。 */
export const OS_RELEASES = Object.freeze([
  // 与 5.15 内核兼容的真实发行版版本组合，共 20 项 ——
  // 数量必须 >= 槽位数，否则池子里必然有重复（之前 6 个对 20 个槽，
  // os-release 只有 6/20 唯一）。
  //
  // 每一项都必须真实存在过：Ubuntu 22.04 的四个 point release、
  // Debian 11/12 的多个 point release、Rocky 9 的多个 minor。
  // 编造的版本号（比如 Ubuntu 22.04.9）本身就是破绽。
  { id: 'ubuntu', version: '22.04', displayVersion: '22.04.4 LTS', pretty: 'Ubuntu 22.04.4 LTS', name: 'Ubuntu', codename: 'jammy' },
  { id: 'ubuntu', version: '22.04', displayVersion: '22.04.3 LTS', pretty: 'Ubuntu 22.04.3 LTS', name: 'Ubuntu', codename: 'jammy' },
  { id: 'ubuntu', version: '22.04', displayVersion: '22.04.2 LTS', pretty: 'Ubuntu 22.04.2 LTS', name: 'Ubuntu', codename: 'jammy' },
  { id: 'ubuntu', version: '22.04', displayVersion: '22.04.1 LTS', pretty: 'Ubuntu 22.04.1 LTS', name: 'Ubuntu', codename: 'jammy' },
  { id: 'debian', version: '11', displayVersion: '11 (bullseye)', pretty: 'Debian GNU/Linux 11 (bullseye)', name: 'Debian GNU/Linux', codename: 'bullseye' },
  { id: 'debian', version: '12', displayVersion: '12 (bookworm)', pretty: 'Debian GNU/Linux 12 (bookworm)', name: 'Debian GNU/Linux', codename: 'bookworm' },
  { id: 'ubuntu', version: '20.04', displayVersion: '20.04.6 LTS', pretty: 'Ubuntu 20.04.6 LTS', name: 'Ubuntu', codename: 'focal' },
  { id: 'ubuntu', version: '20.04', displayVersion: '20.04.5 LTS', pretty: 'Ubuntu 20.04.5 LTS', name: 'Ubuntu', codename: 'focal' },
  { id: 'debian', version: '11', displayVersion: '11.9 (bullseye)', pretty: 'Debian GNU/Linux 11.9 (bullseye)', name: 'Debian GNU/Linux', codename: 'bullseye' },
  { id: 'debian', version: '12', displayVersion: '12.5 (bookworm)', pretty: 'Debian GNU/Linux 12.5 (bookworm)', name: 'Debian GNU/Linux', codename: 'bookworm' },
  { id: 'rocky', version: '9.3', displayVersion: '9.3 (Blue Onyx)', pretty: 'Rocky Linux 9.3 (Blue Onyx)', name: 'Rocky Linux', codename: 'Blue Onyx' },
  { id: 'rocky', version: '9.2', displayVersion: '9.2 (Blue Onyx)', pretty: 'Rocky Linux 9.2 (Blue Onyx)', name: 'Rocky Linux', codename: 'Blue Onyx' },
  { id: 'debian', version: '11', displayVersion: '11.7 (bullseye)', pretty: 'Debian GNU/Linux 11.7 (bullseye)', name: 'Debian GNU/Linux', codename: 'bullseye' },
  { id: 'debian', version: '12', displayVersion: '12.4 (bookworm)', pretty: 'Debian GNU/Linux 12.4 (bookworm)', name: 'Debian GNU/Linux', codename: 'bookworm' },
  { id: 'ubuntu', version: '20.04', displayVersion: '20.04.3 LTS', pretty: 'Ubuntu 20.04.3 LTS', name: 'Ubuntu', codename: 'focal' },
  { id: 'rocky', version: '9.1', displayVersion: '9.1 (Blue Onyx)', pretty: 'Rocky Linux 9.1 (Blue Onyx)', name: 'Rocky Linux', codename: 'Blue Onyx' },
  { id: 'debian', version: '11', displayVersion: '11.6 (bullseye)', pretty: 'Debian GNU/Linux 11.6 (bullseye)', name: 'Debian GNU/Linux', codename: 'bullseye' },
  { id: 'ubuntu', version: '20.04', displayVersion: '20.04.4 LTS', pretty: 'Ubuntu 20.04.4 LTS', name: 'Ubuntu', codename: 'focal' },
  { id: 'debian', version: '12', displayVersion: '12.2 (bookworm)', pretty: 'Debian GNU/Linux 12.2 (bookworm)', name: 'Debian GNU/Linux', codename: 'bookworm' },
  { id: 'rocky', version: '9.4', displayVersion: '9.4 (Blue Onyx)', pretty: 'Rocky Linux 9.4 (Blue Onyx)', name: 'Rocky Linux', codename: 'Blue Onyx' },
])

function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 第 index 个槽的发行版 id。
 *
 * 单独导出而不是让调用方自己按 OS_RELEASES 取模 ——
 * uts-fake 需要它来决定内核后缀，如果两边各写一份轮转规则，
 * 改池子时必然漏改一边，结果是「os-release 说 debian 但 uname 报 -generic」。
 */
export function distroIdAt(index = 0) {
  return OS_RELEASES[Number(index || 0) % OS_RELEASES.length].id
}

/** 按槽位确定性选一个发行版组合。 */
export function osReleaseForSlot({ vmId = '', index = 0 } = {}) {
  // 与 CPU 画像同样的教训：不要用 vmId hash 做偏移再叠加 index
  // （两者会互相抵消）。直接按 index 轮转，20 个槽对 6 种发行版
  // 仍有重复，但发行版种类本来就少，重复比矛盾可接受。
  return OS_RELEASES[Number(index || 0) % OS_RELEASES.length]
}

/** 生成 os-release 文件内容。字段顺序与真实 Ubuntu 一致。 */
export function renderOsRelease({ vmId = '', index = 0 } = {}) {
  const r = osReleaseForSlot({ vmId, index })
  const h = fnv1a(`${vmId}#os`)
  const build = 60 + (h % 12)

  if (r.id === 'ubuntu') {
    return [
      `PRETTY_NAME="${r.pretty}"`,
      'NAME="Ubuntu"',
      `VERSION_ID="${r.version}"`,
      `VERSION="${r.pretty.slice(7)}"`,
      'VERSION_CODENAME=jammy',
      'ID=ubuntu',
      'ID_LIKE=debian',
      `HOME_URL="https://www.ubuntu.com/"`,
      `SUPPORT_URL="https://help.ubuntu.com/"`,
      `BUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"`,
      'PRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"',
      'UBUNTU_CODENAME=jammy',
      '',
    ].join('\n')
  }
  if (r.id === 'debian') {
    return [
      `PRETTY_NAME="${r.pretty}"`,
      'NAME="Debian GNU/Linux"',
      `VERSION_ID="${r.version}"`,
      `VERSION="${r.version} (${r.codename})"`,
      `VERSION_CODENAME=${r.codename}`,
      'ID=debian',
      'HOME_URL="https://www.debian.org/"',
      'SUPPORT_URL="https://www.debian.org/support"',
      'BUG_REPORT_URL="https://bugs.debian.org/"',
      '',
    ].join('\n')
  }
  // rocky / rhel 系
  return [
    `NAME="${r.name}"`,
    `VERSION="${r.pretty}"`,
    `ID="${r.id}"`,
    'ID_LIKE="rhel centos fedora"',
    `VERSION_ID="${r.version}"`,
    `PLATFORM_ID="platform:el9"`,
    `PRETTY_NAME="${r.pretty}"`,
    'ANSI_COLOR="0;32"',
    'LOGO="fedora-logo-icon"',
    'CPE_NAME="cpe:/o:rocky:rocky:9::baseos"',
    'HOME_URL="https://rockylinux.org/"',
    'BUG_REPORT_URL="https://bugs.rockylinux.org/"',
    'ROCKY_SUPPORT_PRODUCT="Rocky-Linux-9"',
    `ROCKY_SUPPORT_PRODUCT_VERSION="${r.version}"`,
    'REDHAT_SUPPORT_PRODUCT="Rocky Linux"',
    `REDHAT_SUPPORT_PRODUCT_VERSION="${r.version}"`,
    '',
  ].join('\n')
}
