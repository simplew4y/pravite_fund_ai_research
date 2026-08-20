import { useQuery } from "@tanstack/react-query";

import { listJobs, type Job } from "../../api/account";
import type { DictKey } from "../../i18n/dict";
import { useT } from "../../i18n/useT";

type JobStatus = Job["status"];
type JobType = Job["type"];

const STATUS_LABEL: Record<JobStatus, DictKey> = {
  queued: "jobs.status.queued",
  running: "jobs.status.running",
  completed: "jobs.status.completed",
  failed: "jobs.status.failed",
  cancelled: "jobs.status.cancelled",
};

const TYPE_LABEL: Record<JobType, DictKey> = {
  "document.ingest": "jobs.type.document.ingest",
  "memo.generate": "jobs.type.memo.generate",
  "report.generate": "jobs.type.report.generate",
  "tracking.scan": "jobs.type.tracking.scan",
  "valuation.extract": "jobs.type.valuation.extract",
  "valuation.compare": "jobs.type.valuation.compare",
  "valuation.derive": "jobs.type.valuation.derive",
  "market.refresh": "jobs.type.market.refresh",
  "obsidian.project": "jobs.type.obsidian.project",
};

const STATUS_TAG: Record<JobStatus, string> = {
  running: "tag tag-accent",
  failed: "tag tag-outline",
  queued: "tag tag-neutral",
  completed: "tag tag-neutral",
  cancelled: "tag tag-neutral",
};

/** queued/running/failed rows surface first in the expanded list. */
const STATUS_RANK: Record<JobStatus, number> = {
  running: 0,
  queued: 1,
  failed: 2,
  completed: 3,
  cancelled: 3,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 8;
const ERROR_MAX_CHARS = 80;

function isRecentFailure(job: Job): boolean {
  if (job.status !== "failed") return false;
  const failedAt = Date.parse(job.completedAt ?? job.updatedAt);
  return Number.isFinite(failedAt) && Date.now() - failedAt < DAY_MS;
}

export function JobsBadge({ projectId }: { projectId: string }) {
  const { t } = useT();
  const jobs = useQuery({
    queryKey: ["jobs", projectId],
    queryFn: () => listJobs({ projectId, limit: 30 }),
    refetchInterval: 10_000,
    // The endpoint 503s when durable jobs are disabled — stay silent.
    retry: false,
  });

  if (jobs.isError || jobs.data === undefined) return null;

  const active = jobs.data.filter(
    (job) => job.status === "queued" || job.status === "running",
  ).length;
  if (active === 0 && !jobs.data.some(isRecentFailure)) return null;

  const rows = [...jobs.data]
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
    .slice(0, MAX_ROWS);

  return (
    <details className="reasoning">
      <summary>
        {t("jobs.title")} · {active}
      </summary>
      {rows.map((job) => (
        <div key={job.id} className="doc-row">
          <span className="title">{t(TYPE_LABEL[job.type])}</span>
          <span className={STATUS_TAG[job.status]}>{t(STATUS_LABEL[job.status])}</span>
          {job.error !== null && job.error !== "" ? (
            <span className="text-muted" style={{ fontSize: 12 }}>
              {job.error.length > ERROR_MAX_CHARS
                ? `${job.error.slice(0, ERROR_MAX_CHARS)}…`
                : job.error}
            </span>
          ) : null}
        </div>
      ))}
    </details>
  );
}
