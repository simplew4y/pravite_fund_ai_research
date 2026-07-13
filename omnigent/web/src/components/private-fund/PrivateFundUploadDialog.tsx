import { Check, Database, FileUp, Loader2, UploadCloud } from "lucide-react";
import { type ChangeEvent, type DragEvent, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type PrivateFundUploadStage =
  | "idle"
  | "uploading"
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type PrivateFundUploadDialogProps = {
  open: boolean;
  stage: PrivateFundUploadStage;
  fileNames: string[];
  message?: string;
  onOpenChange: (open: boolean) => void;
  onSelectFiles: (files: File[]) => void;
};

const ACCEPTED_FILES = ".pdf,.xlsx,.xlsm,.docx,.pptx,.csv,.md,.markdown,.txt,application/pdf";

export function PrivateFundUploadDialog({
  open,
  stage,
  fileNames,
  message,
  onOpenChange,
  onSelectFiles,
}: PrivateFundUploadDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const locked = !["idle", "completed"].includes(stage);
  const processing = ["uploading", "queued", "running"].includes(stage);

  const submitFiles = (files: File[]) => {
    if (files.length > 0 && !processing) onSelectFiles(files);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    submitFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    submitFiles(Array.from(event.dataTransfer.files ?? []));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && locked) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        aria-label="上传资料并建立索引"
        className="sm:max-w-lg"
        showCloseButton={!locked}
        onEscapeKeyDown={(event) => {
          if (locked) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (locked) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>上传资料并建立索引</DialogTitle>
          <DialogDescription>
            文档必须完成 pipeline 解析和索引后才能用于 Agent 检索。处理期间此窗口不可关闭。
          </DialogDescription>
        </DialogHeader>

        {(stage === "idle" || stage === "failed") && (
          <div
            aria-label="弹窗文档拖入区"
            className={cn(
              "flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed px-6 py-7 text-center transition-colors",
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
            <span className="flex size-11 items-center justify-center rounded-xl bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]">
              <UploadCloud className="size-5" />
            </span>
            <p className="mt-3 text-sm font-semibold text-[var(--pf-ink)]">
              拖入一个或多个资料文档
            </p>
            <p className="mt-1 text-xs text-[var(--pf-ink-secondary)]">
              支持 PDF、Excel、Word、PPT、CSV、Markdown 和文本
            </p>
            <input
              ref={inputRef}
              accept={ACCEPTED_FILES}
              aria-label="在弹窗中选择资料文档"
              className="hidden"
              multiple
              onChange={onFileChange}
              type="file"
            />
            <Button className="mt-4" onClick={() => inputRef.current?.click()} size="sm">
              <FileUp className="size-4" />
              {stage === "failed" ? "重新选择并重试" : "选择文档"}
            </Button>
          </div>
        )}

        {stage === "idle" && message ? (
          <p className="rounded-lg border border-[var(--pf-line)] bg-[var(--pf-warning-soft)] px-3 py-2 text-xs text-[var(--pf-warning-ink)]">
            {message}
          </p>
        ) : null}

        {stage !== "idle" && (
          <div className="rounded-xl border border-[var(--pf-line)] bg-[var(--pf-panel-raised)] p-4">
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full",
                  stage === "completed"
                    ? "bg-[var(--pf-success-soft)] text-[var(--pf-success-ink)]"
                    : stage === "failed"
                      ? "bg-[var(--pf-danger-soft)] text-[var(--pf-danger-ink)]"
                      : "bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]",
                )}
              >
                {stage === "completed" ? (
                  <Check className="size-4" />
                ) : stage === "failed" ? (
                  <Database className="size-4" />
                ) : (
                  <Loader2 className="size-4 animate-spin" />
                )}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--pf-ink)]">
                  {stage === "uploading"
                    ? "正在上传文档"
                    : stage === "queued"
                      ? "索引任务已排队"
                      : stage === "running"
                        ? "正在解析并建立索引"
                        : stage === "completed"
                          ? "索引构建完成"
                          : "索引构建失败，请重试"}
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--pf-ink-secondary)]">
                  {message ||
                    (stage === "completed"
                      ? "这些资料现在可以用于 Agent 检索和溯源。"
                      : "请保持此窗口打开，系统完成后会自动解锁。")}
                </p>
                {fileNames.length > 0 && (
                  <div className="mt-3 max-h-24 space-y-1 overflow-y-auto rounded-lg bg-[var(--pf-panel-subtle)] p-2">
                    {fileNames.map((name) => (
                      <p className="truncate text-[10px] text-[var(--pf-ink-secondary)]" key={name}>
                        {name}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            disabled={locked}
            onClick={() => onOpenChange(false)}
            variant={stage === "completed" ? "default" : "secondary"}
          >
            {locked ? "索引完成后可关闭" : stage === "completed" ? "完成并关闭" : "取消"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
