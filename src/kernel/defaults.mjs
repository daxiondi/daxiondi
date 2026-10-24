/**
 * 内核适配层的本地缺省值。
 *
 * 单独一个文件是为了打破循环依赖：contract.mjs 与 supervisor-compat.mjs
 * 都要用这几个常量，而 supervisor-compat 又 import contract。
 * 常量放这里，两边都只 import 它，不互相 import。
 */

/**
 * 控制面认定的槽数。
 *
 * 出处：vm2api src/lib/vm/slot-engine.mjs 的 `KERNEL_NATIVE_SLOT_COUNT = 20`。
 * supervisor 的 syncKernelSlotCount 会把 kernel.json 的 slots_per_worker
 * 硬改成这个值，因此内核上报的槽数必须与它一致，否则每次启动都被判
 * slotMismatch 而强制重启。
 */
export const DEFAULT_KERNEL_SLOTS = 20

/**
 * health 里的 engine 字面值。
 *
 * 出处：vm2api rust-kernel-client.mjs 的 rustKernelProcessUp —— `health.engine === 'rust'`
 * 直接算 process up。这是「替换闭源内核」这件事上唯一的身份伪装点。
 */
export const KERNEL_ENGINE_LABEL = 'rust'

/**
 * vm2api 侧的双 socket 布局（rust-kernel-client / codex-kernel-client 的 paths 函数）：
 *   <runDir>/kernel.sock        ← Claude 内核
 *   <runDir>/codex-kernel.sock  ← Codex 内核
 *   <runDir>/internal.token     ← 两者共用同一个 token 文件
 *
 * runDir 缺省是 workerPaths(exec).runDir，即 `<slotRoot>/run`。
 */
export const SOCKET_NAMES = Object.freeze({
  claude: 'kernel.sock',
  codex: 'codex-kernel.sock',
  token: 'internal.token',
  claudeConfig: 'kernel.json',
  codexConfig: 'codex-kernel.json',
})

/**
 * engine 字面值的唯一来源。
 *
 * 从 defaults 导出而不是从 supervisor-compat 导出，是因为 server.mjs 要它，
 * 而 supervisor-compat 已经 import 了 contract — 再让 server 从 supervisor-compat
 * 取这个常量会把依赖绕成一个环。
 */
export { KERNEL_ENGINE_LABEL as ENGINE_LABEL }
