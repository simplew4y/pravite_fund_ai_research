# `@private-fund/workflow-store`

`workflow-store` 是 `/goal` 迁移后的项目级业务存储层。它只使用调用方传入的
`node:sqlite` `DatabaseSync`，不会自行打开数据库，也不会在项目之间创建连接。

```ts
import { createWorkflowStore } from "@private-fund/workflow-store";

const store = createWorkflowStore(projectDatabase);

const workflow = store.workflow.getOrCreateWorkflow({
  datasetId: "dataset-1",
  workflowType: "agentic_research_graph_v2",
});

const alerts = store.tracking.listAlerts("dataset-1", {
  status: "new",
  limit: 50,
  offset: 0,
});
```

创建 store 时会在同一连接上执行可重入 migration。若调用方需要把迁移和其他
启动逻辑分开，也可以直接调用 `runWorkflowStoreMigrations(database)`。

## 数据边界

本包迁移并维护四组业务真值：

| Repository | Durable data |
| --- | --- |
| `TrackingRepository` | Memo series/version/section，research item/version/evidence/relation，observation/change，watch rule/alert |
| `ValuationRepository` | Model series/version/node/value/change、不可变 analysis version，五指标模型值、行情快照、实际值、比较、人工 override，Agent analysis、derived model、watch rule/alert |
| `WorkflowRepository` | Workflow、node/dependency/version/evidence、context、assumption、report/version |
| `ObsidianRepository` | Transactional outbox、lease/retry、projection registry |

所有列表 API 返回 `{ items, total, limit, offset, hasMore }`。所有复合写入都使用
`BEGIN IMMEDIATE`；若调用方已经开启事务，则使用 savepoint，因此 outbox 可以和
上游实体提交保持原子性。

## Legacy 兼容策略

迁移刻意沿用 Python 实现的真实表名，不复制到另一套 `wf_*` 表：

- Tracking：`research_memo_*`、`research_items`、
  `research_item_versions`、`research_item_evidence`、
  `research_item_relations`、`research_tracking_observations`、
  `research_change_events`、`research_watch_rules`、`research_alerts`
- Valuation：`valuation_model_*`、`valuation_analysis_versions`、
  `valuation_metric_model_values`、`valuation_metric_manual_overrides`、
  `valuation_market_snapshots`、`valuation_metric_actual_values`、
  `valuation_metric_comparisons`、`valuation_agent_analyses`、
  `valuation_derived_models`、`valuation_watch_rules`、`valuation_alerts`
- Workflow：`research_workflows`、`research_nodes`、
  `research_node_dependencies`、`research_node_versions`、
  `research_node_evidence`、`research_assumptions`、
  `research_workflow_context`、`research_reports`、
  `research_report_versions`
- Obsidian：`obsidian_sync_outbox`、`obsidian_note_registry`

因此旧库属于“原地接管”，不发生跨库导入，也不会改变已有主键。migration 会：

1. 记录五个有 checksum 的版本；
2. 补齐旧版缺失的 idempotency/resource-import 列；
3. 将旧库中不合法或类型错误的 JSON 原文写入
   `workflow_store_legacy_json_quarantine`，再替换为声明的 `{}` 或 `[]`；
4. 把所有结构化和 JSON Evidence ID 导入
   `workflow_store_evidence_references` 统一引用账本，原业务列仍然保留；
5. 为新建表启用 `STRICT`、`json_valid`、实体外键和唯一索引。

Evidence ID 支持 `chunk:`、`fact:`、`cell:`、`page:`、`document:`。新写入会同时
保存到 legacy 业务列和统一引用账本；迁移旧行时不改写 Evidence ID。

人工估值指标 override 继续保留 legacy 的审计门槛：只允许五个产品指标，校验
指标单位与数值合理区间，并按指标要求至少 1、2 或 4 条来源；每个 Evidence ID
必须能在统一引用账本、标准 `evidence` 表或旧 `chunks` / `metric_facts` /
`excel_cells` / `documents` / `pdf_pages` 中解析。

## 状态机

- Tracking/Valuation alert：
  `new | acknowledged | dismissed | snoozed`。进入 `snoozed` 必须带合法时间；
  到期后显式调用 `reopenDueAlerts` / `releaseExpiredSnoozes`。
- Market snapshot：
  `pending -> running -> completed | failed | unavailable`；失败可重新排队，
  completed 不可回退。
- Agent analysis：
  `pending -> running -> completed | failed`；失败可重新排队，completed 不可覆盖。
- Derived resource：
  `not_added -> queued -> running -> completed | failed`；失败可重试。
- Workflow：
  `active | paused | completed | archived`。archived 只读。
- Node：
  `pending | ready | running | completed | stale | failed`。完成上游节点后刷新
  ready 状态；重跑上游会递归把所有已生成后代标记为 stale。
- Assumption：
  `active -> resolved | dismissed`；终态不可回退。
- Obsidian outbox：
  `queued -> running -> completed`，失败按有界 backoff 回到 queued，耗尽
  `maxAttempts` 后进入 failed；过期 lease 可恢复。`claimNext` 返回的
  `leaseToken` 必须原样传给 `completeEvent` / `failEvent`，旧 worker 不能提交
  已被重新领取的任务。同一 dataset/entity 同时只会领取一个 delivery；
  `completeProjection` 在同一 fenced 事务中提交 registry 与 event completion。

## 主要 API

Tracking：

- `saveMemoVersion`、`getMemoVersion`、`listMemoSeries`、
  `listMemoVersions`、`compareMemoVersions`、`deleteMemoVersion`
- `appendItemVersion`、`getItem`、`listItems`、`getItemTimeline`
- `recordObservation`、`recordChangeEvent`、`addRelation`
- `ensureDefaultWatchRules`、`upsertWatchRule`、`listWatchRules`
- `createAlert`、`transitionAlert`、`reopenDueAlerts`、`listAlerts`、`overview`

Valuation：

- `upsertSeries`、`saveModelVersion`、`upsertNode`、`saveNodeValue`
- `saveAnalysisVersion`、`getAnalysisVersion`、
  `getAnalysisForModelVersion`、`listAnalysisVersions`
- `recordChange`、`listChanges`、`compareModelVersions`
- `upsertMetricModelValue`、`createMarketSnapshot`、
  `transitionMarketSnapshot`、`upsertMetricActualValue`、
  `upsertMetricComparison`、`upsertManualMetricOverride`
- `saveContextCard`、`getContextCard`、`listContextCards`
- `saveImpactCard`、`getImpactCard`、`listImpactCards`
- `saveMarketPriceBar`、`getMarketPriceBar`、`listMarketPriceBars`
- `savePriceComparison`、`getPriceComparison`、`listPriceComparisons`
- `createAgentAnalysis`、`transitionAgentAnalysis`、`saveDerivedModel`、
  `transitionDerivedResource`
- `upsertWatchRule`、`updateWatchRule`、`createAlert`、
  `updateAlertStatus`、`ensureDefaultWatchRule`、`getLatestMetricBundle`

Workflow：

- `getOrCreateWorkflow`、`transitionWorkflow`、`getSnapshot`
- `createNode`、`addDependency`、`removeDependency`、`setContext`
- `startNode`、`completeNode`、`failNode`、`listNodeVersions`
- `createAssumption`、`transitionAssumption`
- `createReportVersion`、`listReports`、`listReportVersions`

Obsidian：

- `enqueue`、`reconcileDataset`、`claimNext`、`assertEventLease`、
  `completeEvent`、`completeProjection`、`failEvent`、`recoverStaleEvents`、
  `listEvents`
- `upsertRegistry`、`getRegistryEntry`、`findRegistryByPath`、
  `listRegistry`、`deleteRegistryEntry`、`projectionStatus`

具体输入、输出与联合类型从包入口完整导出。

## 明确不迁移的旧内部表

下列表不是 `/goal` 的业务真值，本包不会创建、消费或删除；旧库中已有表会原样
保留：

- `research_tracking_jobs`、`valuation_tracking_jobs`：执行队列已由统一
  job queue 负责。
- `valuation_model_overviews`：可从 model version 重建的 HTML/展示缓存。
- `valuation_metric_agent_extractions`、`valuation_impact_agent_runs`：
  旧 Python Agent 的运行中间态不会冒充新 control-plane job。legacy migrator
  原样保留旧行，并在 `legacy_agent_run_reconciliation_manifest` 中分别映射到
  `valuation.extract` / `valuation.compare`，以 `quarantined` 状态等待显式重算。
- `research_saved_assets`、`research_asset_context`：由
  `@private-fund/research-store` 的 versioned ResearchAsset 接管。
- `research_equity_report_runs`：报告渲染执行态；canonical report/version 已迁移。
- 文件系统 memo 扫描、HTML/PDF 渲染和 Obsidian Markdown 写盘：属于 compute /
  projection worker，不在 repository 内执行。

这里的“不迁移”只表示新 TypeScript 业务存储不再依赖这些内部表，不代表 migration
会删除旧数据。

## 估值来源审计与旧表迁移

`valuation_context_cards`、`valuation_impact_cards`、
`valuation_market_price_bars`、`valuation_price_comparisons` 现在是严格的
TypeScript 业务表。仓储写入为幂等且不可变，所有读取均要求 `dataset_id`，列表具有
硬分页上限；行情序列还要求显式日期范围且最长十年。四类记录保存
`source_fingerprint`、结构化 `provenance_json` 和 Evidence 引用账本。

legacy migrator 会先把同名 Python 表原样改名为 `legacy_<table>_v0`，再把可证明
满足租户、模型版本、快照、JSON、Evidence 与 OHLC 约束的行写入规范表。无法证明的
行写入 `workflow_store_legacy_row_quarantine`；迁移 reconcile 要求每个旧 ID
恰好出现在规范表或隔离表之一。旧 impact card 因依赖无法验证的 Python Agent run，
一律保留 raw row 并隔离，必须由真实 `valuation.compare` control job 重算。
