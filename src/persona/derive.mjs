/**
 * 从 vm_id 派生硬件标识
 *
 * 为什么需要这一步：
 *   如果一批 VM 共用同一份 persona 骨架，它们的序列号、UUID、machine-id
 *   会完全一样。这些值在上游是强关联键 —— 一批账号报上同一个硬件 ID，
 *   就是最明显的批量特征。
 *
 * 做法：
 *   以 vm_id 为输入做确定性派生。同一个 vm_id 恒得同一组值（重建容器不漂移），
 *   不同 vm_id 得不同值（互不关联），且输出格式必然合法。
 */

import crypto from 'node:crypto'

function digest(parts) {
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex')
}

/** 32 位小写 hex。Linux machine-id 用这个形态。 */
export function deriveHex32(vmId, salt = 'machine-id') {
  return digest([salt, String(vmId)]).slice(0, 32)
}

/**
 * 标准 UUID 形态（小写）。
 * 版本位固定为 4，变体位固定为 8，符合 UUID v4 格式。
 */
export function deriveUuid(vmId, salt = 'uuid') {
  const h = digest([salt, String(vmId)]).slice(0, 32).split('')
  h[12] = '4'
  h[16] = '8'
  const s = h.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

/** 大写 UUID，Windows 的 SMBIOS UUID 习惯用大写。 */
export function deriveUuidUpper(vmId, salt = 'uuid') {
  return deriveUuid(vmId, salt).toUpperCase()
}

/**
 * 按给定字符集与长度派生一个序列号。
 * @param {string} vmId
 * @param {number} length
 * @param {string} alphabet
 */
export function deriveSerial(vmId, length, alphabet, salt = 'serial') {
  const hex = digest([salt, String(vmId)])
  let out = ''
  for (let i = 0; i < length; i += 1) {
    const byte = parseInt(hex.slice((i * 2) % 64, (i * 2) % 64 + 2), 16)
    out += alphabet[byte % alphabet.length]
  }
  return out
}

/**
 * 派生单播 MAC。
 *
 * 用厂商 OUI 前缀（这里取常见网卡厂商），后三段从 vm_id 派生。
 * 不用本地管理地址：真实网卡极少用，容易被筛出来。
 *
 * @param {string} vmId
 * @param {string} [oui] 形如 'F0:18:98'，缺省用 Apple
 */
export function deriveMac(vmId, oui = 'F0:18:98') {
  const hex = digest(['mac', String(vmId)])
  const tail = [
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4, 6),
  ].join(':')
  const mac = `${oui}:${tail}`.toUpperCase()
  // 首字节必须是单播、非本地管理：清掉两个低位。
  // 注意 padStart + toUpperCase，否则清位后会变成小写导致整个串大小写混杂。
  const first = (parseInt(mac.slice(0, 2), 16) & 0xfc)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
  return `${first}${mac.slice(2)}`
}

/** 从一组候选里确定性挑一个（用于机型池） */
export function pickFrom(vmId, list, salt = 'pick') {
  if (!Array.isArray(list) || list.length === 0) throw new Error('pickFrom requires a non-empty list')
  const hex = digest([salt, String(vmId)]).slice(0, 8)
  return list[parseInt(hex, 16) % list.length]
}
