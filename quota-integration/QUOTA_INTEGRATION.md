# 配额窗口接入说明（src/server.mjs）

## 结论

`server.mjs` 在本次任务期间持续被其他 agent 重写（24827 → 26553 → 28174 字节，
间隔数分钟），且全文件 **0 处** quota 相关代码。按任务约束「冲突就只给接入说明
不要硬改」，本文件给出可直接套用的三处改动，不修改 `server.mjs`。

**重要：调度器已经自己闭环了配额记录，`server.mjs` 不接也能工作。**
理由见下节。三处接入是「让 /status 可见、让调用方拿到明确错误码」的增强，不是必需项。

---

## 已经闭环的部分（无需 server.mjs 参与）

`SlotScheduler` 在 `_handleFrame()` 里从终态帧取配额信号：

| 帧 | 字段 | 处理 |
|---|---|---|
| `job_done` | `payload.headers` | 调 `recordUsage()`，解析 5h / 7d 读数 |
| `job_error` | `payload.status === 429` + `payload.retryAfter` | 无配额头时按 `retryAfter` 压到熔断，到点自动恢复 |
| `job_error` | 其他 status | 不动配额 |

数据来源是 `frames.mjs` 的 `classifyStdoutFrame()`：
`job_done` 已带 `headers: frame.headers || {}`，`job_error` 已带
`status` / `retryAfter`。CLI 宿主把这些透传上来，调度器就拿到了上游的真实配额读数。

因此**当前实现已经具备完整的「记录→熔断→恢复」链路**，`server.mjs` 保持原样
时门禁也已生效。

---

## 接入点 1：/status 输出窗口状态（推荐）

`server.mjs` 的 `/status` 路由（约第 275 行）追加一个字段：

```js
    if (req.method === 'GET' && url.pathname === '/status') {
      return sendJson(res, 200, {
        status: 'ok',
        workers: 1,
        capabilities: ['multi_slot', 'native_sse', 'stateless', 'ping'],
        max_body: 64 * 1024 * 1024,
        client_channel: 'sse',
        cli_started: scheduler.host.started === true,
        cli_error: cliErrorPayload(scheduler),
        ready_slots: scheduler.readySlots,
        // ↓ 新增：各账号的 5h / 7d 窗口读数与门禁结论
        quota: scheduler.quotaSnapshot(),
        // ↓ 可选：最近一次被配额挡下的原因与恢复时间
        quota_block: scheduler.lastQuotaBlock,
      }, { 'x-request-id': requestId })
    }
```

`quotaSnapshot()` 返回可 JSON 序列化的纯量对象，形如：

```json
{
  "enabled": true,
  "warn_pct": 85,
  "stop_pct": 95,
  "accounts": [
    {
      "account_id": "self",
      "allowed": true,
      "blocked": false,
      "level": "warn",
      "reason": "5h_warning",
      "resume_at": null,
      "updated_at": 1767225600000,
      "source": "anthropic",
      "windows": {
        "5h": {
          "used_pct": 88,
          "remaining_pct": 12,
          "level": "warn",
          "status": "active",
          "reset_at": 1767232800000,
          "reset_in_secs": 7200,
          "window_minutes": 300,
          "stale": false
        }
      }
    }
  ]
}
```

`/healthz` 不要加这个字段：它的载荷字段集合是控制面的比对契约，
任务文档也写明「字段集合不能变」。

---

## 接入点 2：把「被配额挡下」和「没槽位」区分开

当前 `submit()` 在无槽时返回 `null`，`server.mjs` 统一回
`503 kernel_unavailable`。加了门禁后 `submit()` 有两种新的返回形态：

```js
// 被配额挡下
{ jobId: null, slot: null, done: null, quota: {...}, blocked: true }

// 正常
{ jobId, slot, done, quota: {...}, blocked: false, degraded: true|false }

// 没有空闲槽（行为与旧版一致）
null
```

`server.mjs` 里处理 `submit()` 返回值的那段（约第 340 行，变量名 `submitted`）
建议改成：

```js
      let submitted = scheduler.cliError ? null : scheduler.submit({
        sessionId,
        model: payload.model,
        request: payload,
        onEvent: null,
      })

      // 配额熔断：回 429 而不是 503，并带上恢复时间。
      // 用 429 是因为语义就是「额度用尽」，客户端 SDK 对这个状态码的
      // 退避处理最成熟；503 会被当成服务端故障重试，反而加重压力。
      if (submitted?.blocked) {
        const resumeAt = submitted.quota?.resumeAt ?? null
        const retryAfterSecs = resumeAt
          ? Math.max(1, Math.ceil((resumeAt - Date.now()) / 1000))
          : 60
        return sendJson(
          res,
          429,
          workerError(
            429,
            'quota_exhausted',
            `quota window exhausted (${submitted.quota?.reason || 'unknown'}); retry after ${retryAfterSecs}s`,
            'rate_limit_error',
          ),
          { 'x-request-id': requestId, 'retry-after': String(retryAfterSecs) },
        )
      }
```

`workerError()` 已经在 `config.mjs` 里导出，`type` 用 `'rate_limit_error'`
与上游 429 的错误类型保持一致。

---

## 接入点 3（可选）：显式传入账号配置

`server.mjs` 构造调度器的地方（约第 169 行 `buildPublicServer`、
第 340 行 `buildGatewayWorkerServer`）传入配额配置：

```js
  const scheduler = new SlotScheduler({
    claudeBin,
    slots: 20,
    env,
    quota: {
      enabled: cfg.claude_quota_enabled,
      warnPct: cfg.claude_quota_warn_pct,
      stopPct: cfg.claude_quota_stop_pct,
    },
  })
```

注意 `buildPublicServer({ claudeBin, env, envelopePath, codexHandler })` 的签名里
**没有 `cfg`**。要用配置得先把它加进参数列表；不加也可行——`SlotScheduler`
的构造参数有缺省值，不传 `quota` 时按 85 / 95 / enabled=true 工作，
与 `DEFAULT_WORKER_CONFIG` 的缺省值一致。

`buildGatewayWorkerServer(cfg, ...)` 已经有 `cfg`，可以直接接。

---

## 完整改动清单（供实际修改时对照）

1. `/status` 加 `quota: scheduler.quotaSnapshot()` 和 `quota_block: scheduler.lastQuotaBlock`
2. `submit()` 返回值处理：`submitted?.blocked` → 429 + `retry-after`
3. 构造 `SlotScheduler` 时传 `quota: { enabled, warnPct, stopPct }`

三处互不依赖，可以分批合入。任何一处漏掉都不会让门禁失效，
只会少一层可观测性或错误语义更模糊。

---

## 验证方式

接完后跑：

```bash
node test/quota.mjs        # 274 条，含调度器集成与终态帧闭环
node test/selfcheck.mjs    # 236 条，确认原有契约未破
node test/run-all.mjs      # 全量
```

手工验证门禁是否生效：

```bash
# 1. 起服务后看配额段
curl -s localhost:8080/status | jq .quota

# 2. 制造一次 429（或等真实用量爬升），观察 /status 里
#    accounts[0].windows["5h"].used_pct 上升、
#    level 从 ok → warn → stop、blocked 变 true
```
