import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getPrivateFundGlobalUploadBatch,
  listPrivateFundGlobalUploadBatches,
  routePrivateFundGlobalUploadItem,
  type PrivateFundGlobalUploadBatch,
  uploadPrivateFundFilesGlobally,
} from "@/lib/privateFundApi";

const SUPPORTED_UPLOAD_SUFFIXES = new Set([
  "pdf",
  "xlsx",
  "xlsm",
  "docx",
  "pptx",
  "csv",
  "md",
  "markdown",
  "txt",
]);

const ACTIVE_BATCH_STATUSES = new Set([
  "queued",
  "identifying",
  "routing",
  "routed",
  "index_queued",
  "indexing",
]);

const ACTIVE_ITEM_STATUSES = new Set([
  "uploaded",
  "identifying",
  "routing",
  "routed",
  "index_queued",
  "indexing",
]);

function isActiveBatch(batch: PrivateFundGlobalUploadBatch | null): boolean {
  return Boolean(batch && ACTIVE_BATCH_STATUSES.has(batch.status));
}

function completedMessage(batch: PrivateFundGlobalUploadBatch): string {
  if (batch.status === "needs_review") return "少量未能可靠识别的资料需要人工确认。";
  if (batch.status === "completed") return "全部资料已自动建项目、归类并完成索引。";
  return "后台处理已结束，请检查有提示的文件。";
}

function waitForNextPoll(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 1500));
}

export function usePrivateFundGlobalUpload() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [batch, setBatch] = useState<PrivateFundGlobalUploadBatch | null>(null);
  const [message, setMessage] = useState("");
  const monitorRequestId = useRef(0);
  const historyRequestId = useRef(0);
  const mounted = useRef(true);
  const batchRef = useRef<PrivateFundGlobalUploadBatch | null>(null);

  useEffect(() => {
    batchRef.current = batch;
  }, [batch]);

  const refreshProjects = useCallback(
    (completedBatch: PrivateFundGlobalUploadBatch) => {
      void queryClient.invalidateQueries({ queryKey: ["private-fund-projects"] });
      for (const datasetId of new Set(
        completedBatch.items
          .map((item) => item.matchedDatasetId)
          .filter((value): value is string => Boolean(value)),
      )) {
        void queryClient.invalidateQueries({ queryKey: ["private-fund-project", datasetId] });
        void queryClient.invalidateQueries({ queryKey: ["private-fund-assets", datasetId] });
        void queryClient.invalidateQueries({
          queryKey: ["private-fund-source-folders", datasetId],
        });
      }
    },
    [queryClient],
  );

  const monitorBatch = useCallback(
    (initial: PrivateFundGlobalUploadBatch) => {
      const requestId = ++monitorRequestId.current;
      setBatch(initial);

      const run = async () => {
        let current = initial;
        while (ACTIVE_BATCH_STATUSES.has(current.status)) {
          // eslint-disable-next-line no-await-in-loop -- progress polls are intentionally sequential.
          await waitForNextPoll();
          if (!mounted.current || requestId !== monitorRequestId.current) return;
          try {
            // eslint-disable-next-line no-await-in-loop -- the next poll depends on this response.
            current = await getPrivateFundGlobalUploadBatch(current.batchId);
          } catch {
            if (!mounted.current || requestId !== monitorRequestId.current) return;
            setMessage("后台处理仍在继续，正在重新连接进度…");
            continue;
          }
          if (!mounted.current || requestId !== monitorRequestId.current) return;
          setBatch(current);
          if (ACTIVE_BATCH_STATUSES.has(current.status)) {
            setMessage("资料已交给后台处理，可以关闭窗口或继续使用其他功能。");
          }
        }
        if (!mounted.current || requestId !== monitorRequestId.current) return;
        setBatch(current);
        setMessage(completedMessage(current));
        refreshProjects(current);
      };

      void run();
    },
    [refreshProjects],
  );

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => uploadPrivateFundFilesGlobally(files),
    onSuccess: (initial) => {
      setMessage("上传已完成，资料已转入后台自动识别和建项目。");
      monitorBatch(initial);
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "全局资料上传失败");
    },
  });

  const routeMutation = useMutation({
    mutationFn: ({ itemId, datasetId }: { itemId: string; datasetId: string }) =>
      routePrivateFundGlobalUploadItem(itemId, datasetId),
    onSuccess: (initial) => {
      setMessage("已确认归类，后续索引在后台继续。");
      monitorBatch(initial);
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "手动归类失败");
    },
  });

  useEffect(() => {
    const requestId = ++historyRequestId.current;
    void listPrivateFundGlobalUploadBatches(20)
      .then((recent) => {
        if (!mounted.current || requestId !== historyRequestId.current || batchRef.current) return;
        const restored =
          recent.find((candidate) => ACTIVE_BATCH_STATUSES.has(candidate.status)) ??
          recent.find((candidate) => candidate.status === "needs_review") ??
          recent[0];
        if (!restored) return;
        if (ACTIVE_BATCH_STATUSES.has(restored.status)) {
          setMessage("已恢复正在后台处理的上传批次。");
          monitorBatch(restored);
        } else {
          setBatch(restored);
          refreshProjects(restored);
        }
      })
      .catch(() => {
        // Upload remains available even if historical progress cannot be restored.
      });
  }, [monitorBatch, refreshProjects]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      monitorRequestId.current += 1;
      historyRequestId.current += 1;
    };
  }, []);

  const selectFiles = useCallback(
    (files: File[]) => {
      if (isActiveBatch(batch)) {
        setMessage("当前批次仍在后台处理中，请等待完成后再上传下一批。");
        return;
      }
      historyRequestId.current += 1;
      const supported = files.filter((file) => {
        const suffix = file.name.split(".").pop()?.toLocaleLowerCase() ?? "";
        return SUPPORTED_UPLOAD_SUFFIXES.has(suffix);
      });
      const skipped = files.length - supported.length;
      if (supported.length === 0) {
        setMessage("未发现支持的文档；可上传 PDF、Excel、Word、PPT、CSV、Markdown 或文本文件");
        return;
      }
      setBatch(null);
      setMessage(
        skipped > 0 ? `已忽略 ${skipped} 个不支持的文件，正在上传其余资料。` : "正在上传资料。",
      );
      uploadMutation.mutate(supported);
    },
    [batch, uploadMutation],
  );

  const openDialog = useCallback(() => {
    setOpen(true);
  }, []);

  const startAnotherBatch = useCallback(() => {
    if (isActiveBatch(batch)) return;
    monitorRequestId.current += 1;
    historyRequestId.current += 1;
    setBatch(null);
    setMessage("");
    uploadMutation.reset();
    routeMutation.reset();
  }, [batch, routeMutation, uploadMutation]);

  const progress = useMemo(() => {
    const total = batch?.fileCount ?? 0;
    const processed = batch
      ? batch.items.filter((item) => !ACTIVE_ITEM_STATUSES.has(item.status)).length
      : 0;
    const attention = batch
      ? batch.items.filter((item) => item.status === "needs_review" || item.status === "failed")
          .length
      : 0;
    return {
      total,
      processed,
      attention,
      percent: total > 0 ? Math.round((processed / total) * 100) : 0,
    };
  }, [batch]);
  const processing = isActiveBatch(batch);
  const progressLabel = uploadMutation.isPending
    ? "正在上传文件…"
    : processing
      ? `后台处理中 · ${progress.processed}/${progress.total}`
      : batch?.status === "needs_review"
        ? `${progress.attention} 份资料需要确认`
        : batch
          ? `处理完成 · ${progress.processed}/${progress.total}`
          : "上传后自动识别公司并创建项目";

  return {
    open,
    setOpen,
    batch,
    message,
    openDialog,
    selectFiles,
    startAnotherBatch,
    routeItem: (itemId: string, datasetId: string) => routeMutation.mutate({ itemId, datasetId }),
    isUploading: uploadMutation.isPending,
    isProcessing: processing,
    isRouting: routeMutation.isPending,
    progressPercent: progress.percent,
    processedCount: progress.processed,
    attentionCount: progress.attention,
    progressLabel,
    error: uploadMutation.error ?? routeMutation.error,
  };
}
