import { Check, Database, FileUp, Loader2, UploadCloud } from "lucide-react";
import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
  const { t } = useTranslation();
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
        aria-label={t("privateFund.uploadAndIndex", "Upload and index sources")}
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
          <DialogTitle>{t("privateFund.uploadAndIndex", "Upload and index sources")}</DialogTitle>
          <DialogDescription>
            {t(
              "privateFund.uploadDescription",
              "Sources must finish parsing and indexing before the Agent can use them. Keep this dialog open while processing.",
            )}
          </DialogDescription>
        </DialogHeader>

        {(stage === "idle" || stage === "failed") && (
          <div
            aria-label={t("sourceLibrary.uploadDropzone")}
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
              {t("privateFund.dropFiles", "Drop one or more source documents")}
            </p>
            <p className="mt-1 text-xs text-[var(--pf-ink-secondary)]">
              {t(
                "privateFund.supportedFiles",
                "Supports PDF, Excel, Word, PowerPoint, CSV, Markdown, and text",
              )}
            </p>
            <input
              ref={inputRef}
              accept={ACCEPTED_FILES}
              aria-label={t("sourceLibrary.uploadFileInput")}
              className="hidden"
              multiple
              onChange={onFileChange}
              type="file"
            />
            <Button className="mt-4" onClick={() => inputRef.current?.click()} size="sm">
              <FileUp className="size-4" />
              {stage === "failed"
                ? t("privateFund.selectAndRetry", "Select files and retry")
                : t("privateFund.selectFiles", "Select files")}
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
                    ? t("privateFund.uploading", "Uploading documents")
                    : stage === "queued"
                      ? t("privateFund.indexQueued", "Indexing queued")
                      : stage === "running"
                        ? t("privateFund.indexing", "Parsing and indexing")
                        : stage === "completed"
                          ? t("privateFund.indexComplete", "Indexing complete")
                          : t("privateFund.indexFailed", "Indexing failed. Try again.")}
                </p>
                <p className="mt-1 text-xs leading-5 text-[var(--pf-ink-secondary)]">
                  {message ||
                    (stage === "completed"
                      ? t(
                          "privateFund.sourcesReady",
                          "These sources are ready for Agent retrieval and citations.",
                        )
                      : t(
                          "privateFund.keepDialogOpen",
                          "Keep this dialog open. It will unlock when processing finishes.",
                        ))}
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
            {locked
              ? t("privateFund.closeAfterIndex", "Available after indexing")
              : stage === "completed"
                ? t("privateFund.doneAndClose", "Done")
                : t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
