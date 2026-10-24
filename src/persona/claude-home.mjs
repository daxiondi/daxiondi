/**
 * Claude Code CLI 的磁盘身份（~/.claude.json 等）。
 *
 * 为什么需要：Claude Code 不采集硬件指纹，但它**唯一的持久设备标识**
 * 是 ~/.claude.json 里的 userID / machineID —— 用 crypto.randomBytes(32)
 * 生成的随机 hex，跟硬件无关。
 *
 * 问题在于：
 *   · 20 个槽如果共用同一个 HOME，全部读到同一个 userID → 同设备 20 账号
 *   · 如果每个槽各自随机，虽然不同，但**不可复现**：
 *     槽重建一次就换一个身份，等于"同一账号频繁换设备"
 *   · 而且请求里的 metadata.user_id.device_id 与磁盘上的 userID
 *     对不上，是内部矛盾
 *
 * 做法：从 vmId 确定性派生，一次生成、永远一致，
 * 且与 src/identity.mjs 发出去的 device_id 同源。
 *
 * 实测依据（strace + 抓包，见 docs/cc-hardware-probe.md）：
 *   ~/.claude.json          userID / machineID      ← 真设备标识
 *   ~/.claude/telemetry/    1p_failed_events.*.json ← 失败批次，会重试
 *   ~/.claude/statsig/      缓存                     ← 已移除，残留时要清
 *   ~/.claude/shell-snapshots/  shell 快照
 */

import { createHash } from 'node:crypto'

/** 32 字节 hex（64 字符）—— Claude Code 的 userID 就是这个形态。 */
function hex64(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex')
}

/** OAuth 账户段的 UUID 形态（8-4-4-4-12）。 */
function uuidFrom(seed) {
  const h = hex64(seed)
  return [
    h.slice(0, 8), h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `${'89ab'[parseInt(h[16], 16) & 3]}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-')
}

/**
 * 派生一个槽的完整 CLI 磁盘身份。
 *
 * @param {object} p
 * @param {string} p.vmId     槽位 ID（如 claude-slot-01）
 * @param {string} [p.accountUuid] 该槽绑定的 OAuth 账号 UUID
 * @returns {{userId, machineId, deviceId, oauthAccount, version}}
 */
export function claudeHomeForSlot({ vmId, accountUuid = '', version = 1 } = {}) {
  const id = String(vmId || '')
  if (!id) throw new Error('claudeHomeForSlot: vmId 不能为空')

  // userID 与 machineID 用不同 salt，避免同一个值出现在两个字段
  // （真实客户端是两次独立的 randomBytes 调用，两个值必然不同）
  const userId = hex64('claude-user-id', id)
  const machineId = hex64('claude-machine-id', id)

  // deviceId 就是发给上游 metadata.user_id 里的那个，
  // 必须与磁盘上的 userID 一致 —— 否则线上看到的是 A，本地存的是 B
  const deviceId = userId

  const oauthAccount = accountUuid
    ? {
        accountUuid,
        organizationUuid: uuidFrom(`org#${id}#${accountUuid}`),
      }
    : null

  return { userId, machineId, deviceId, oauthAccount, version }
}

/**
 * 渲染 ~/.claude.json。
 *
 * 真实文件结构（2.1.x）比这复杂得多，含 projects / 会话历史等。
 * 这里只保留**身份相关**字段，其余留最小骨架 ——
 * 多余字段写错反而更容易被识别为伪造。
 *
 * 注意：未知字段宁可不写。Claude Code 自己会补全缺失字段。
 */
export function renderClaudeJson({ userId, machineId, oauthAccount = null, version = 2 } = {}) {
  const doc = {
    // 这两个是核心设备标识
    userID: userId,
    // 注意真实字段名是 machineID（不是 machineId）
    machineID: machineId,
    // 首次运行标记：必须是过去的时间，否则会被当成新装
    // 用固定值而不是 Date.now() —— 每次重建都变会显得反复重装
    numStartups: 1 + (parseInt(String(userId).slice(0, 2), 16) % 40),
    installMethod: 'unknown',
    autoUpdates: false,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: `2.1.${280 + (parseInt(String(userId).slice(2, 4), 16) % 30)}`,
    ...(oauthAccount ? { oauthAccount } : {}),
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}

/**
 * 渲染 ~/.claude/settings.json。
 *
 * 关掉自动更新与遥测上报 ——
 * 不是为了"隐藏"，是为了**不让它自己改变状态**：
 * 自动更新会让 20 个槽的版本慢慢漂移，遥测失败会写盘重试。
 */
export function renderClaudeSettings({ version = 2 } = {}) {
  return `${JSON.stringify({
    // 关自动更新：20 个槽同时更新会一起变版本，反而更显眼
    autoUpdates: false,
    // 关非必要的使用统计
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
  }, null, 2)}\n`
}

/**
 * 换设备时必须清掉的路径。
 *
 * 依据实测：遥测失败批次会落盘成 1p_failed_events.*.json 并重试。
 * 不清就会把旧设备的失败事件带到新身份下 —— 这是直接的关联证据。
 */
export const CLAUDE_HOME_PURGE = Object.freeze([
  '.claude/telemetry',
  '.claude/statsig',
  '.claude/shell-snapshots',
  '.claude/todos',
  '.claude/projects',
  '.claude/history.jsonl',
  '.claude/__store.db',
  '.claude/.credentials.json',
])

/**
 * 产出清理命令（在容器内执行）。
 */
export function claudeHomePurgeScript({ home = '/root' } = {}) {
  const lines = CLAUDE_HOME_PURGE.map((p) => `rm -rf "${home}/${p}"`)
  // .claude.json 保留（身份文件），只清其余缓存
  return lines.join('\n')
}

/**
 * 一次性产出该槽需要的所有 CLI 文件。
 *
 * @returns {{files: Array<{rel, content, mode}>, identity}}
 */
export function claudeHomeFiles({ vmId, accountUuid = '', home = '/root' } = {}) {
  const identity = claudeHomeForSlot({ vmId, accountUuid })
  const relHome = home.replace(/^\/+/, '')
  return {
    identity,
    files: [
      {
        rel: `${relHome}/.claude.json`,
        content: renderClaudeJson(identity),
        mode: 0o600,
      },
      {
        rel: `${relHome}/.claude/settings.json`,
        content: renderClaudeSettings(),
        mode: 0o600,
      },
    ],
    purge: claudeHomePurgeScript({ home }),
  }
}
