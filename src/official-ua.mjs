/**
 * 官方 Claude Code User-Agent 的识别与剥离。
 *
 * 为什么需要这层：调用方可能带着 `claude-desktop` / `agent-sdk` /
 * `claude-vscode` / `local-agent` 这类第三方入口标识进来。这些字符串
 * 一旦原样出站，等于向上游声明「这条请求不是官方 CLI 发的」——这是
 * 客户端指纹泄漏，比多带一个字段更直接。
 *
 * 判定口径只有一条：`claude-cli/<x.y.z>` 前缀。版本号不参与判定，
 * 所以升级 CLI 不需要改这里；前缀之后的内容（`(external, sdk-cli)`
 * 之类的入口标注）也不做白名单，新入口应当自动通过。
 *
 * 对齐依据：官方 vm2api v1.3.220：
 *   · `src/lib/identity/official-claude-ua.mjs` —— CLAUDE_CLI_UA_RE /
 *     isOfficialClaudeUa / isUnofficialClaudeEntrypointUa 三个实现与
 *     本文件逐字符一致；
 *   · `src/lib/identity/vm-identity.mjs:23-24` —— 官方 UA 常量
 *     `claude-cli/2.1.296 (external, sdk-cli)`，本文件的回落目标同源。
 *
 * 注意：识别只是第一步。真正出站前要把非官方 UA 换掉（normalizeCallerUa），
 * 只识别不替换等于看到了风险却不处理。
 */

import { officialCliUserAgent } from './identity.mjs'

/** 官方 CLI 的 UA 前缀。与官方 CLAUDE_CLI_UA_RE 逐字符一致。 */
export const CLAUDE_CLI_UA_RE = /^claude-cli\/\d+\.\d+\.\d+/i

/**
 * 第三方入口标识。官方把它单独列出来，用于区分「长得像 Claude 客户端、
 * 但不是 Claude Code」的调用方。
 *
 * 这里刻意不做成「命中即拒绝」的黑名单：这些入口本身可能是合法调用方，
 * 只是不允许把它们的标识原样带给上游。
 */
export const UNOFFICIAL_ENTRYPOINT_UA_RE = /claude-desktop|agent-sdk|claude-vscode|local-agent/i

/**
 * 回落目标：官方 2.1.296 的 CLI UA。
 *
 * 由 identity.mjs 的生成器算出来而不是手写字符串——版本号只存一份，
 * 升级 `OFFICIAL_CLI_VERSION` 时这里自动跟上，不会出现「UA 说 2.1.296、
 * billing 说 2.1.303」的内部矛盾。
 */
export const OFFICIAL_CLAUDE_CLI_UA = officialCliUserAgent({})

/**
 * 是否官方 Claude Code 族的 UA。
 * 只看前缀，版本与入口标注都不参与；空值返回 false。
 */
export function isOfficialClaudeUa(ua = '') {
  return CLAUDE_CLI_UA_RE.test(String(ua || '').trim())
}

/**
 * 是否「长得像 Claude 系、但不是官方 CLI」的入口 UA。
 * 官方实现里这就是个补充判定：官方族优先返回 false，避免同一个 UA 两边都算。
 */
export function isUnofficialClaudeEntrypointUa(ua = '') {
  const s = String(ua || '')
  if (isOfficialClaudeUa(s)) return false
  return UNOFFICIAL_ENTRYPOINT_UA_RE.test(s)
}

/**
 * 出站前的 UA 归一化：官方族原样保留，其余一律回落到官方 UA。
 *
 * 为什么官方族要保留而不是统一替换：官方对「官方客户端直连」的处理就是保留
 * 调用方的 UA，它和调用方自己的 billing、beta 是成组的。把它换掉反而会造出
 * 一份不存在的组合。
 *
 * `officialUa` 允许调用方传入自己当前的官方 UA（例如 env 覆盖了版本号），
 * 保证回落值与 billing 用的是同一个版本。
 */
export function normalizeCallerUa(ua = '', { officialUa = OFFICIAL_CLAUDE_CLI_UA } = {}) {
  const s = String(ua || '').trim()
  const fallback = String(officialUa || '').trim() || OFFICIAL_CLAUDE_CLI_UA
  if (!s) return fallback
  return isOfficialClaudeUa(s) ? s : fallback
}
