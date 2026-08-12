import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  getPrivateFundPipelineJob,
  runPrivateFundPipeline,
  uploadPrivateFundFiles,
} from "@/lib/privateFundApi";
import type {
  PrivateFundUploadDialogProps,
  PrivateFundUploadStage,
} from "./PrivateFundUploadDialog";

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

export function usePrivateFundDocumentUpload(datasetId: string | null | undefined) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<PrivateFundUploadStage>("idle");
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  const mutation = useMutation({
    mutationFn: async ({ files, skipped }: { files: File[]; skipped: number }) => {
      if (!datasetId) throw new Error(t("sourceLibrary.selectProjectFirst"));
      const uploaded = await uploadPrivateFundFiles(datasetId, files);
      setStage("queued");
      setMessage(t("sourceLibrary.uploadQueued"));
      // New servers enqueue automatically with the upload.  The fallback keeps
      // compatibility with older deployments during rolling upgrades.
      let job = uploaded.job ?? (await runPrivateFundPipeline(datasetId));
      while (["queued", "running", "indexing"].includes(job.status)) {
        setStage(job.status === "queued" ? "queued" : "running");
        setMessage(job.message || t("sourceLibrary.pipelineRunning"));
        job = await getPrivateFundPipelineJob(job.jobId);
        if (["queued", "running", "indexing"].includes(job.status)) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
        }
      }
      if (job.status !== "completed") {
        throw new Error(
          job.message || t("sourceLibrary.pipelineIncomplete", { status: job.status }),
        );
      }
      return { count: files.length, skipped };
    },
    onSuccess: ({ count, skipped }) => {
      setStage("completed");
      setMessage(
        skipped > 0
          ? t("sourceLibrary.uploadCompleteSkipped", { count, skipped })
          : t("sourceLibrary.uploadComplete", { count }),
      );
      void queryClient.invalidateQueries({ queryKey: ["private-fund-project", datasetId] });
      void queryClient.invalidateQueries({ queryKey: ["private-fund-projects"] });
      void queryClient.invalidateQueries({ queryKey: ["private-fund-assets", datasetId] });
      void queryClient.invalidateQueries({ queryKey: ["private-fund-workflow", datasetId] });
      void queryClient.invalidateQueries({
        queryKey: ["private-fund-source-folders", datasetId],
      });
    },
    onError: (error) => {
      setStage("failed");
      setMessage(error instanceof Error ? error.message : t("sourceLibrary.uploadFailed"));
    },
  });

  const selectFiles = useCallback(
    (files: File[]) => {
      setOpen(true);
      const supported = files.filter((file) => {
        const suffix = file.name.split(".").pop()?.toLocaleLowerCase() ?? "";
        return SUPPORTED_UPLOAD_SUFFIXES.has(suffix);
      });
      const skipped = files.length - supported.length;
      if (supported.length === 0) {
        setStage("idle");
        setMessage(t("sourceLibrary.unsupportedFiles"));
        return;
      }
      setFileNames(supported.map((file) => file.name));
      setMessage(t("sourceLibrary.uploadingProject"));
      setStage("uploading");
      mutation.mutate({ files: supported, skipped });
    },
    [mutation, t],
  );

  const openDialog = useCallback(() => {
    if (!datasetId || mutation.isPending) return;
    setStage("idle");
    setFileNames([]);
    setMessage("");
    setOpen(true);
  }, [datasetId, mutation.isPending]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next && ["idle", "completed"].includes(stage)) {
        setOpen(false);
        setStage("idle");
        setFileNames([]);
        setMessage("");
      } else if (next) {
        setOpen(true);
      }
    },
    [stage],
  );

  const dialogProps: PrivateFundUploadDialogProps = {
    open,
    stage,
    fileNames,
    message,
    onOpenChange,
    onSelectFiles: selectFiles,
  };

  return {
    dialogProps,
    openDialog,
    selectFiles,
    isPending: mutation.isPending,
  };
}
