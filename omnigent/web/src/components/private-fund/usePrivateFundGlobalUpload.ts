import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

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

function completedMessage(batch: PrivateFundGlobalUploadBatch, t: TFunction): string {
  if (batch.status === "needs_review") return t("globalUpload.reviewComplete");
  if (batch.status === "completed") return t("globalUpload.allComplete");
  return t("globalUpload.processFinished");
}

function waitForNextPoll(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 1500));
}

export function usePrivateFundGlobalUpload() {
  const { t } = useTranslation();
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
            setMessage(t("globalUpload.reconnecting"));
            continue;
          }
          if (!mounted.current || requestId !== monitorRequestId.current) return;
          setBatch(current);
          if (ACTIVE_BATCH_STATUSES.has(current.status)) {
            setMessage(t("globalUpload.processingInBackground"));
          }
        }
        if (!mounted.current || requestId !== monitorRequestId.current) return;
        setBatch(current);
        setMessage(completedMessage(current, t));
        refreshProjects(current);
      };

      void run();
    },
    [refreshProjects, t],
  );

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => uploadPrivateFundFilesGlobally(files),
    onSuccess: (initial) => {
      setMessage(t("globalUpload.uploadComplete"));
      monitorBatch(initial);
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : t("globalUpload.uploadFailed"));
    },
  });

  const routeMutation = useMutation({
    mutationFn: ({ itemId, datasetId }: { itemId: string; datasetId: string }) =>
      routePrivateFundGlobalUploadItem(itemId, datasetId),
    onSuccess: (initial) => {
      setMessage(t("globalUpload.routeConfirmed"));
      monitorBatch(initial);
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : t("globalUpload.routeFailed"));
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
          setMessage(t("globalUpload.restored"));
          monitorBatch(restored);
        } else {
          setBatch(restored);
          refreshProjects(restored);
        }
      })
      .catch(() => {
        // Upload remains available even if historical progress cannot be restored.
      });
  }, [monitorBatch, refreshProjects, t]);

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
        setMessage(t("globalUpload.activeBatch"));
        return;
      }
      historyRequestId.current += 1;
      const supported = files.filter((file) => {
        const suffix = file.name.split(".").pop()?.toLocaleLowerCase() ?? "";
        return SUPPORTED_UPLOAD_SUFFIXES.has(suffix);
      });
      const skipped = files.length - supported.length;
      if (supported.length === 0) {
        setMessage(t("globalUpload.unsupported"));
        return;
      }
      setBatch(null);
      setMessage(
        skipped > 0 ? t("globalUpload.skipped", { count: skipped }) : t("globalUpload.uploadStarted"),
      );
      uploadMutation.mutate(supported);
    },
    [batch, t, uploadMutation],
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
    ? t("globalUpload.uploadingFiles")
    : processing
      ? t("globalUpload.processingCount", {
          processed: progress.processed,
          total: progress.total,
        })
      : batch?.status === "needs_review"
        ? t("globalUpload.reviewCount", { count: progress.attention })
        : batch
          ? t("globalUpload.completedCount", {
              processed: progress.processed,
              total: progress.total,
            })
          : t("globalUpload.automaticRouting");

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
