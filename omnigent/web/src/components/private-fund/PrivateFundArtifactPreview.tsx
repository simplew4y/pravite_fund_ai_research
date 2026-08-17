import { Download, ExternalLink, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { MessageResponse } from "@/components/ai-elements/message";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { authenticatedFetch } from "@/lib/identity";
import { cn } from "@/lib/utils";

export interface PrivateFundArtifactReference {
  datasetId: string;
  path: string;
  displayPath: string;
  format: string;
  url?: string;
}

function artifactUrl(artifact: PrivateFundArtifactReference): string {
  if (artifact.url) return artifact.url;
  const params = new URLSearchParams({ dataset_id: artifact.datasetId, path: artifact.path });
  return `/v1/private-fund/dataset/memo/file?${params.toString()}`;
}

function artifactLabel(format: string): string {
  const normalized = format.toLowerCase();
  if (normalized === "md" || normalized === "markdown") return "Markdown";
  return normalized.toUpperCase();
}

function PrivateFundArtifactBody({
  artifact,
  markdownFallback,
  className,
}: {
  artifact: PrivateFundArtifactReference;
  markdownFallback?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const format = artifact.format.toLowerCase();
  const url = artifactUrl(artifact);
  const isMarkdown = format === "md" || format === "markdown";
  const isText = isMarkdown || ["txt", "csv", "json"].includes(format);
  const [text, setText] = useState(isMarkdown ? markdownFallback || "" : "");
  const [loading, setLoading] = useState(isText && !text);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    if (!isText) {
      setLoading(false);
      setText("");
      return;
    }
    if (isMarkdown && markdownFallback) {
      setText(markdownFallback);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void authenticatedFetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        setText(await response.text());
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : t("privateFund.artifactPreviewFailed", "Artifact preview failed"),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [isMarkdown, isText, markdownFallback, t, url]);

  if (loading) {
    return (
      <div className={cn("flex min-h-72 items-center justify-center", className)}>
        <Loader2 className="mr-2 size-4 animate-spin" />
        <span className="text-sm text-muted-foreground">{t("common.loading")}</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className={cn("flex min-h-72 items-center justify-center px-6", className)}>
        <p className="max-w-lg text-center text-sm text-destructive">
          {t("privateFund.artifactPreviewFailed", "Artifact preview failed")}: {error}
        </p>
      </div>
    );
  }
  if (format === "pdf") {
    return (
      <iframe
        className={cn("h-full min-h-[420px] w-full bg-white", className)}
        src={url}
        title={`${artifact.displayPath} PDF preview`}
      />
    );
  }
  if (format === "html") {
    return (
      <iframe
        className={cn("h-full min-h-[420px] w-full bg-white", className)}
        sandbox=""
        src={url}
        title={`${artifact.displayPath} HTML preview`}
      />
    );
  }
  if (isMarkdown) {
    return (
      <div className={cn("h-full overflow-auto bg-background p-5", className)}>
        <MessageResponse>{text}</MessageResponse>
      </div>
    );
  }
  return (
    <pre
      className={cn(
        "h-full overflow-auto whitespace-pre-wrap break-words bg-background p-5 font-mono text-xs leading-5",
        className,
      )}
    >
      {text}
    </pre>
  );
}

export function PrivateFundArtifactPreview({
  artifacts,
  markdownFallback,
  className,
}: {
  artifacts: PrivateFundArtifactReference[];
  markdownFallback?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const signature = artifacts.map((artifact) => `${artifact.format}:${artifact.path}`).join("|");
  const initialPath = artifacts.find((artifact) => artifact.format.toLowerCase() === "pdf")?.path;
  const [selectedPath, setSelectedPath] = useState(initialPath ?? artifacts[0]?.path ?? "");
  useEffect(() => {
    const next = artifacts.find((artifact) => artifact.format.toLowerCase() === "pdf")?.path;
    setSelectedPath(next ?? artifacts[0]?.path ?? "");
  }, [signature]);
  const selected = artifacts.find((artifact) => artifact.path === selectedPath) ?? artifacts[0];
  if (!selected) return null;
  const url = artifactUrl(selected);

  return (
    <section className={cn("flex min-h-0 flex-col overflow-hidden", className)}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--pf-line)] px-3 py-2">
        <div
          aria-label={t("privateFund.artifactFormats", "Artifact formats")}
          className="flex gap-1"
          role="tablist"
        >
          {artifacts.map((artifact) => (
            <button
              aria-selected={artifact.path === selected.path}
              className={cn(
                "h-7 rounded-md px-2.5 text-[11px] font-semibold transition-colors",
                artifact.path === selected.path
                  ? "bg-[var(--pf-accent-soft)] text-[var(--pf-accent-ink)]"
                  : "text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-subtle)]",
              )}
              key={artifact.path}
              onClick={() => setSelectedPath(artifact.path)}
              role="tab"
              type="button"
            >
              {artifactLabel(artifact.format)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <a
            aria-label={t("privateFund.openArtifact", "Open artifact")}
            className="flex size-8 items-center justify-center rounded-md text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-subtle)]"
            href={url}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink className="size-3.5" />
          </a>
          <a
            aria-label={t("privateFund.downloadArtifact", "Download artifact")}
            className="flex size-8 items-center justify-center rounded-md text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-subtle)]"
            download
            href={url}
          >
            <Download className="size-3.5" />
          </a>
        </div>
      </div>
      <PrivateFundArtifactBody
        artifact={selected}
        className="min-h-0 flex-1"
        markdownFallback={/^(?:md|markdown)$/i.test(selected.format) ? markdownFallback : undefined}
      />
    </section>
  );
}

export function PrivateFundArtifactPopoverLink({
  artifact,
  children,
  className,
}: {
  artifact: PrivateFundArtifactReference;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const fileName = artifact.path.split("/").at(-1) || artifact.path;
  const formatLabel = artifactLabel(artifact.format);
  const actionLabel = `${t("privateFund.artifactPreview", "Artifact preview")} · ${formatLabel} · ${fileName}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={actionLabel}
          className={cn(
            "mx-0.5 inline-flex cursor-pointer items-center whitespace-nowrap rounded-md bg-[#E7F1EC] px-1.5 py-0.5 font-medium text-[#2F6F57] no-underline ring-1 ring-inset ring-[#C7DED2] transition-colors hover:bg-[#DCECE4] hover:text-[#254F40]",
            className,
          )}
          data-artifact-preview="true"
          title={actionLabel}
          type="button"
        >
          {fileName || children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(620px,calc(100vw-24px))] gap-0 overflow-hidden p-0"
        collisionPadding={12}
        sideOffset={8}
      >
        <PopoverHeader className="border-b border-[var(--pf-line)] px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <PopoverTitle className="truncate text-xs">{fileName}</PopoverTitle>
              <PopoverDescription className="mt-0.5 text-[10px]">
                {t("privateFund.artifactPreview", "Artifact preview")} · {formatLabel}
              </PopoverDescription>
            </div>
            <a
              aria-label={t("privateFund.openArtifact", "Open artifact")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-subtle)]"
              href={artifactUrl(artifact)}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink className="size-3.5" />
            </a>
            <a
              aria-label={t("privateFund.downloadArtifact", "Download artifact")}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--pf-ink-muted)] hover:bg-[var(--pf-panel-subtle)]"
              download
              href={artifactUrl(artifact)}
            >
              <Download className="size-3.5" />
            </a>
          </div>
        </PopoverHeader>
        <PrivateFundArtifactBody
          artifact={artifact}
          className="h-[min(52vh,440px)] min-h-[280px]"
        />
      </PopoverContent>
    </Popover>
  );
}
