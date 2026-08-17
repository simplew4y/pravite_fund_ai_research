import type {
  ObsidianOutboxEvent,
  WorkflowStore,
} from "@private-fund/workflow-store";

export interface ObsidianReconcileResult {
  readonly datasetId: string;
  readonly discovered: number;
  readonly newlyEnqueued: number;
  readonly byEntityType: Readonly<Record<string, number>>;
}

export interface AuthoritativeReconcilerOptions {
  readonly projectorVersion?: string;
  readonly maxAttempts?: number;
}

function eventCount(store: WorkflowStore, datasetId: string): number {
  return store.obsidian.listEvents({ datasetId, limit: 1 }).total;
}

function record(
  counts: Record<string, number>,
  event: ObsidianOutboxEvent,
): void {
  counts[event.entityType] = (counts[event.entityType] ?? 0) + 1;
}

/**
 * Backfills the durable outbox from authoritative tables. Domain writes may
 * enqueue immediately, but this periodic pass is the recovery net that makes
 * missed producer notifications observable and replayable.
 */
export class AuthoritativeObsidianReconciler {
  readonly #projectorVersion: string | undefined;
  readonly #maxAttempts: number | undefined;

  public constructor(
    private readonly store: WorkflowStore,
    options: AuthoritativeReconcilerOptions = {},
  ) {
    this.#projectorVersion = options.projectorVersion;
    this.#maxAttempts = options.maxAttempts;
  }

  public reconcile(datasetId: string): ObsidianReconcileResult {
    const before = eventCount(this.store, datasetId);
    const counts: Record<string, number> = {};
    let discovered = 0;

    this.store.obsidian.reconcileDataset(datasetId);

    let offset = 0;
    for (;;) {
      const page = this.store.tracking.listItems(datasetId, {
        offset,
        limit: 500,
      });
      for (const item of page.items) {
        if (item.currentVersionNo <= 0) {
          continue;
        }
        const event = this.store.obsidian.enqueue({
          datasetId,
          entityType: "tracking-item",
          entityId: item.itemId,
          sourceVersion: String(item.currentVersionNo),
          payload: { itemType: item.itemType },
          ...(this.#projectorVersion === undefined
            ? {}
            : { projectorVersion: this.#projectorVersion }),
          ...(this.#maxAttempts === undefined
            ? {}
            : { maxAttempts: this.#maxAttempts }),
        });
        discovered += 1;
        record(counts, event);
      }
      if (!page.hasMore) {
        break;
      }
      offset = page.offset + page.items.length;
    }

    offset = 0;
    for (;;) {
      const workflows = this.store.workflow.listWorkflows({
        datasetId,
        offset,
        limit: 500,
      });
      for (const workflow of workflows.items) {
        let reportOffset = 0;
        for (;;) {
          const reports = this.store.workflow.listReports(
            workflow.workflowId,
            { offset: reportOffset, limit: 500 },
          );
          for (const report of reports.items) {
            if (report.currentVersionNo <= 0) {
              continue;
            }
            const event = this.store.obsidian.enqueue({
              datasetId,
              entityType: "workflow-report",
              entityId: report.reportId,
              sourceVersion: String(report.currentVersionNo),
              payload: { workflowId: workflow.workflowId },
              ...(this.#projectorVersion === undefined
                ? {}
                : { projectorVersion: this.#projectorVersion }),
              ...(this.#maxAttempts === undefined
                ? {}
                : { maxAttempts: this.#maxAttempts }),
            });
            discovered += 1;
            record(counts, event);
          }
          if (!reports.hasMore) {
            break;
          }
          reportOffset = reports.offset + reports.items.length;
        }
      }
      if (!workflows.hasMore) {
        break;
      }
      offset = workflows.offset + workflows.items.length;
    }

    const after = eventCount(this.store, datasetId);
    return {
      datasetId,
      discovered,
      newlyEnqueued: after - before,
      byEntityType: Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    };
  }
}
