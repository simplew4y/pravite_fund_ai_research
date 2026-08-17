# `@private-fund/obsidian-worker`

独立 TypeScript Obsidian outbox worker。它从 control DB 枚举
`tenant/project`，在逐段 symlink fencing 后打开每个项目的
`data/research.sqlite3`，周期执行：

1. `recoverStale()` 恢复崩溃租约；
2. authoritative reconciliation 补齐遗漏 outbox；
3. `drain()` 将 SQLite 真值原子投影到项目内 managed Vault；
4. 记录每项目和全局健康状态。

`SIGINT/SIGTERM` 会等待当前 cycle 完成，关闭所有项目连接、health server 和
control DB。默认 health endpoints：

- `GET http://127.0.0.1:6791/health/live`
- `GET http://127.0.0.1:6791/health/ready`

常用环境变量：

- `PRIVATE_FUND_DATA_ROOT`
- `PRIVATE_FUND_CONTROL_DB`
- `PRIVATE_FUND_OBSIDIAN_MANAGED_ROOT`
- `PRIVATE_FUND_OBSIDIAN_POLL_INTERVAL_MS`
- `PRIVATE_FUND_OBSIDIAN_RECONCILE_INTERVAL_MS`
- `PRIVATE_FUND_OBSIDIAN_STALE_LEASE_MS`
- `PRIVATE_FUND_OBSIDIAN_MAX_DRAIN_EVENTS`
- `PRIVATE_FUND_OBSIDIAN_HEALTH_HOST`
- `PRIVATE_FUND_OBSIDIAN_HEALTH_PORT`
