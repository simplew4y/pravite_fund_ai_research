import {
  AlertTriangle,
  Check,
  FileSearch,
  FileUp,
  Loader2,
  RefreshCw,
  UploadCloud,
  X,
} from "lucide-react";
import { type ChangeEvent, type DragEvent, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import type {
  PrivateFundGlobalUploadBatch,
  PrivateFundGlobalUploadItem,
  PrivateFundProject,
} from "@/lib/privateFundApi";
import { cn } from "@/lib/utils";

const ACCEPTED_FILES = ".pdf,.xlsx,.xlsm,.docx,.pptx,.csv,.md,.markdown,.txt,application/pdf";
const ACTIVE_ITEM_STATUSES = new Set([
  "uploaded",
  "identifying",
  "routing",
  "routed",
  "index_queued",
  "indexing",
]);

function statusPresentation(item: PrivateFundGlobalUploadItem) {
  if (item.status === "completed" || item.status === "duplicate") {
    return {
      label: item.status === "duplicate" ? "项目中已有相同文件" : "已完成索引",
      className: "text-[var(--pf-success-ink)]",
      icon: Check,
    };
  }
  if (item.status === "completed_with_warnings") {
    return {
      label: "已归类，索引有提示",
      className: "text-[var(--pf-warning-ink)]",
      icon: AlertTriangle,
    };
  }
  if (item.status === "needs_review") {
    return {
      label: "需要确认项目",
      className: "text-[var(--pf-warning-ink)]",
      icon: AlertTriangle,
    };
  }
  if (item.status === "failed") {
    return { label: "处理失败", className: "text-destructive", icon: X };
  }
  return {
    label: item.status === "identifying" ? "正在识别公司" : "正在归类并建立索引",
    className: "text-primary",
    icon: Loader2,
  };
}

function GlobalUploadItemRow({
  item,
  projects,
  routing,
  onRoute,
}: {
  item: PrivateFundGlobalUploadItem;
  projects: PrivateFundProject[];
  routing: boolean;
  onRoute: (itemId: string, datasetId: string) => void;
}) {
  const projectOptions = useMemo(() => {
    const candidateIds = new Set(item.candidateProjects.map((candidate) => candidate.datasetId));
    const candidates = item.candidateProjects
      .map((candidate) => projects.find((project) => project.datasetId === candidate.datasetId))
      .filter((project): project is PrivateFundProject => Boolean(project));
    return [...candidates, ...projects.filter((project) => !candidateIds.has(project.datasetId))];
  }, [item.candidateProjects, projects]);
  const [datasetId, setDatasetId] = useState(
    item.candidateProjects[0]?.datasetId ?? projectOptions[0]?.datasetId ?? "",
  );
  const presentation = statusPresentation(item);
  const StatusIcon = presentation.icon;
  const active = ACTIVE_ITEM_STATUSES.has(item.status);

  return (
    <div className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-3">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--pf-panel-subtle)]",
            presentation.className,
          )}
        >
          <StatusIcon className={cn("size-4", active && "animate-spin")} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-[var(--pf-ink)]">{item.fileName}</p>
              <p className={cn("mt-0.5 text-[10px] font-medium", presentation.className)}>
                {presentation.label}
              </p>
            </div>
            <span className="shrink-0 rounded bg-[var(--pf-panel-subtle)] px-1.5 py-0.5 text-[9px] text-[var(--pf-ink-secondary)]">
              {item.fileType.toUpperCase()}
            </span>
          </div>

          {item.companyName || item.companyTicker ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--pf-ink-secondary)]">
              <span>识别公司</span>
              <strong className="text-[var(--pf-ink)]">
                {item.companyName || "公司名称待确认"}
                {item.companyTicker ? ` · ${item.companyTicker}` : ""}
              </strong>
              {item.companyConfidence > 0 ? (
                <span>{Math.round(item.companyConfidence * 100)}%</span>
              ) : null}
            </div>
          ) : null}

          {item.matchedProjectName ? (
            <p className="mt-1.5 text-[10px] text-[var(--pf-ink-secondary)]">
              归入项目：
              <strong className="text-[var(--pf-ink)]">{item.matchedProjectName}</strong>
              {item.projectMatchConfidence > 0
                ? ` · 匹配度 ${Math.round(item.projectMatchConfidence * 100)}%`
                : ""}
            </p>
          ) : null}

          {item.status === "needs_review" || item.status === "failed" ? (
            <div className="mt-3 flex items-center gap-2">
              <select
                aria-label={`为 ${item.fileName} 选择研究项目`}
                className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
                value={datasetId}
                onChange={(event) => setDatasetId(event.target.value)}
              >
                <option value="">选择研究项目</option>
                {projectOptions.map((project) => (
                  <option key={project.datasetId} value={project.datasetId}>
                    {project.name}
                    {project.companyTicker ? ` · ${project.companyTicker}` : ""}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                className="h-8 shrink-0"
                disabled={!datasetId || routing}
                onClick={() => onRoute(item.itemId, datasetId)}
              >
                {routing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {item.status === "failed" ? "重新归类" : "确认归类"}
              </Button>
            </div>
          ) : null}

          {item.errorMessage && !active ? (
            <p className="mt-2 text-[10px] leading-4 text-[var(--pf-ink-secondary)]">
              {item.errorMessage}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function PrivateFundGlobalUploadDialog({
  open,
  batch,
  message,
  projects,
  uploading,
  processing,
  routing,
  progressPercent,
  progressLabel,
  onOpenChange,
  onSelectFiles,
  onRoute,
  onStartAnotherBatch,
}: {
  open: boolean;
  batch: PrivateFundGlobalUploadBatch | null;
  message: string;
  projects: PrivateFundProject[];
  uploading: boolean;
  processing: boolean;
  routing: boolean;
  progressPercent: number;
  progressLabel: string;
  onOpenChange: (open: boolean) => void;
  onSelectFiles: (files: File[]) => void;
  onRoute: (itemId: string, datasetId: string) => void;
  onStartAnotherBatch: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const submitFiles = (files: File[]) => {
    if (files.length > 0 && !uploading) onSelectFiles(files);
  };
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    submitFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    submitFiles(Array.from(event.dataTransfer.files ?? []));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="统一上传并自动归类资料" className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>统一上传资料</DialogTitle>
          <DialogDescription>
            系统会自动识别公司、合并同公司资料并创建缺少的研究项目；只有无法可靠识别时才需要你确认。
          </DialogDescription>
        </DialogHeader>

        {!batch ? (
          <div
            aria-label="统一资料拖入区"
            className={cn(
              "flex min-h-44 flex-col items-center justify-center rounded-xl border border-dashed px-6 py-7 text-center transition-colors",
              dragActive
                ? "border-[var(--pf-accent)] bg-[var(--pf-accent-soft)]"
                : "border-[var(--pf-line-strong)] bg-[var(--pf-panel-subtle)]",
            )}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragActive(false);
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={onDrop}
          >
            <span className="flex size-12 items-center justify-center rounded-xl bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]">
              {uploading ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <UploadCloud className="size-5" />
              )}
            </span>
            <p className="mt-3 text-sm font-semibold text-[var(--pf-ink)]">
              拖入来自不同公司的资料
            </p>
            <p className="mt-1 text-xs text-[var(--pf-ink-secondary)]">
              支持 PDF、Excel、Word、PPT、CSV、Markdown 和文本
            </p>
            <input
              ref={inputRef}
              accept={ACCEPTED_FILES}
              aria-label="在统一入口选择资料文档"
              className="hidden"
              multiple
              onChange={onFileChange}
              type="file"
            />
            <Button
              className="mt-4"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              size="sm"
            >
              <FileUp className="size-4" />
              {uploading ? "正在上传" : "选择文档"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-subtle)] px-3 py-2.5">
              <FileSearch className="size-4 shrink-0 text-[var(--pf-accent-ink)]" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-[var(--pf-ink)]">
                  {batch.status === "queued"
                    ? "已进入后台队列"
                    : batch.status === "identifying"
                      ? "正在识别公司"
                      : ["routing", "routed", "index_queued", "indexing"].includes(batch.status)
                        ? "正在归类并建立索引"
                        : batch.status === "needs_review"
                          ? "部分资料需要确认"
                          : batch.status === "completed"
                            ? "全部处理完成"
                            : "批次处理已结束"}
                </p>
                <p className="mt-0.5 text-[10px] text-[var(--pf-ink-secondary)]">
                  {progressLabel} · 可关闭窗口，后台处理不会中断
                </p>
              </div>
              {processing ? <Loader2 className="size-4 animate-spin text-primary" /> : null}
            </div>
            <div className="space-y-1.5 px-0.5">
              <Progress aria-label="后台处理进度" value={progressPercent} />
              <div className="flex items-center justify-between text-[10px] text-[var(--pf-ink-secondary)]">
                <span>{processing ? "可继续使用其他功能" : "本批次处理结果"}</span>
                <span>{progressPercent}%</span>
              </div>
            </div>
            <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
              {batch.items.map((item) => (
                <GlobalUploadItemRow
                  item={item}
                  key={item.itemId}
                  projects={projects}
                  routing={routing}
                  onRoute={onRoute}
                />
              ))}
            </div>
          </div>
        )}

        {message ? (
          <p className="text-xs leading-5 text-[var(--pf-ink-secondary)]">{message}</p>
        ) : null}

        <DialogFooter>
          {batch && !processing ? (
            <Button
              variant="secondary"
              onClick={onStartAnotherBatch}
              disabled={uploading || routing}
            >
              <RefreshCw className="size-3.5" />
              上传另一批
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)} variant={batch ? "default" : "secondary"}>
            {processing ? "转到后台" : "关闭"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
