import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

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
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<PrivateFundUploadStage>("idle");
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  const mutation = useMutation({
    mutationFn: async ({ files, skipped }: { files: File[]; skipped: number }) => {
      if (!datasetId) throw new Error("请先选择研究项目");
      await uploadPrivateFundFiles(datasetId, files);
      setStage("queued");
      setMessage("文档已上传，正在等待索引任务启动。请保持窗口打开。");
      let job = await runPrivateFundPipeline(datasetId);
      while (["queued", "running", "indexing"].includes(job.status)) {
        setStage(job.status === "queued" ? "queued" : "running");
        setMessage(job.message || "pipeline 正在解析文档、提取内容并建立检索索引。");
        job = await getPrivateFundPipelineJob(job.jobId);
        if (["queued", "running", "indexing"].includes(job.status)) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
        }
      }
      if (job.status !== "completed") {
        throw new Error(job.message || `pipeline 未完成：${job.status}`);
      }
      return { count: files.length, skipped };
    },
    onSuccess: ({ count, skipped }) => {
      setStage("completed");
      setMessage(
        `${count} 份资料已完成解析和索引${skipped > 0 ? `；忽略了 ${skipped} 个不支持的文件` : ""}。`,
      );
      void queryClient.invalidateQueries({ queryKey: ["private-fund-project", datasetId] });
      void queryClient.invalidateQueries({ queryKey: ["private-fund-projects"] });
      void queryClient.invalidateQueries({ queryKey: ["private-fund-assets", datasetId] });
      void queryClient.invalidateQueries({ queryKey: ["private-fund-workflow", datasetId] });
    },
    onError: (error) => {
      setStage("failed");
      setMessage(error instanceof Error ? error.message : "资料上传或索引构建失败");
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
        setMessage("未发现支持的文档；可上传 PDF、Excel、Word、PPT、CSV、Markdown 或文本文件");
        return;
      }
      setFileNames(supported.map((file) => file.name));
      setMessage("正在将文档上传到当前研究项目。请保持窗口打开。");
      setStage("uploading");
      mutation.mutate({ files: supported, skipped });
    },
    [mutation],
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
