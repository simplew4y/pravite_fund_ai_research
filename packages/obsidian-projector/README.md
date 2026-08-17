# `@private-fund/obsidian-projector`

将 `@private-fund/workflow-store` 的 transactional outbox 安全投影为项目内受控
Obsidian Markdown。数据库仍是业务真值，Markdown 是可重建的只读投影；研究员只能
编辑明确标记的 `USER` 区。

## 边界

每个 projector 实例必须绑定一个 `tenantId + projectId + datasetId + projectRoot`。
renderer 只返回 `managedRootRelative` 下的相对 Markdown 路径，不能直接指定项目
根路径或绝对路径。默认受控根为：

```text
<projectRoot>/obsidian/managed/
```

registry 保存的是 `projectRoot` 相对路径，例如
`obsidian/managed/memos/company-a.md`。projector 会拒绝：

- `..`、绝对路径、反斜杠、控制字符和非 `.md` 目标；
- 项目根、目录链或最终目标中的 symlink；
- 位于当前 managed root 外的既有 registry；
- 无 registry 且不具备本次精确 fingerprint 的既有文件；
- registry 信任的 managed region 被外部修改；
- 路径已属于其他 dataset/entity 的写入。

## Durable delivery

`processNext()` 完成以下协议：

1. 按 dataset/projector version claim outbox 事件并取得 lease token；
2. 调用注入的 domain renderer 生成一个或多个 note plan；
3. 生成稳定排序的 frontmatter、provenance、Evidence refs 和 projection
   fingerprint；
4. 使用同目录临时文件，依次执行 file `fsync`、lease fence、原文件
   compare-and-swap 检查、atomic `rename`、directory `fsync`；
5. 在同一个 `BEGIN IMMEDIATE` 事务内写全部 registry，并以相同 lease 完成
   outbox 事件。

同一 dataset/entity 同时最多 claim 一个事件，不同 entity 可并行。lease 在
rename 前和最终 SQLite 提交时都会校验。若进程在 rename 后、数据库提交前崩溃，
重试会凭稳定 fingerprint 接管完全一致的文件；不会把它误判为外部文件，也不会
重复覆盖。

瞬时 renderer/I/O 错误使用 outbox 的有界 backoff。路径、symlink、外部改写和
所有权冲突为 terminal failure。`recoverStale()` 负责恢复崩溃 worker 的租约。

## Markdown ownership

每个 note 固定由三部分组成：

```markdown
---
... deterministic provenance ...
---

<!-- PRIVATE-FUND:MANAGED:BEGIN -->
... renderer body and sorted Evidence refs ...
<!-- PRIVATE-FUND:MANAGED:END -->

<!-- PRIVATE-FUND:USER:BEGIN -->
... analyst-owned text, preserved across source versions ...
<!-- PRIVATE-FUND:USER:END -->
```

`managedHash` 覆盖 frontmatter 和 managed region，`contentHash` 覆盖全文件。
renderer metadata 不得覆盖 provenance 保留字段。

删除事件必须渲染为 `disposition: "tombstone"`。projector 先把原文件原子复制到
managed root 下确定性的 `_archive/.../<eventId>.md`，再用 tombstone 替换原路径；
不会不可恢复地删除用户内容。

## 使用

```ts
const worker = new ObsidianProjector({
  repository: workflowStore.obsidian,
  binding: {
    tenantId,
    projectId,
    datasetId,
    projectRoot,
  },
  managedRootRelative: "obsidian/managed",
  renderer: async ({ event }) => ({
    notes: [
      {
        relativePath: `memos/${event.entityId}.md`,
        title: "Current memo",
        body: await renderMemoBody(event),
        evidence: [
          { evidenceId: "fact:revenue", relation: "supports" },
        ],
      },
    ],
  }),
});

await worker.drain(100);
```

renderer 是唯一的业务适配面：它从 authoritative workflow/research repositories
读取 memo、valuation、analysis 等对象。projector 不从 Vault 反向构造业务状态。

`AuthoritativeObsidianRenderer` 会按 outbox identity 回查
`WorkflowStore`，并校验 dataset/source version；event payload 不会作为受信正文。
它覆盖 Memo、tracking item、valuation model/analysis/derived model 和 workflow
report。`AuthoritativeObsidianReconciler` 则周期扫描 authoritative tables，为遗漏
的 tracking/report 通知补写 durable outbox，并复用仓储自带的 Memo/valuation
reconcile。

## 集成要求

- API/业务事务继续通过 `ObsidianRepository.enqueue()` 写 outbox；
- 独立 runner 周期调用 `recoverStale()` 和 `drain()`；
- renderer 输出的 note identity 若覆盖 event identity，必须保持稳定，并确保会写
  同一路径的事件使用同一 outbox entity key；
- worker 健康状态、告警和启动方式由应用层接入，本包不修改 API/job-worker；
- 根 monorepo 的 TypeScript reference 与 lockfile 由集成方统一更新。

定向验证：

```bash
npm run build --workspace @private-fund/workflow-store
npm run test --workspace @private-fund/workflow-store -- --run test/obsidian-repository.test.ts
npm run build --workspace @private-fund/obsidian-projector
npm run test --workspace @private-fund/obsidian-projector
```
