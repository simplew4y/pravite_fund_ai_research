import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  activatePrivateFundProject,
  createPrivateFundProject,
  type PrivateFundProject,
} from "@/lib/privateFundApi";

export type PrivateFundCreateProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: PrivateFundProject) => void;
};

export function PrivateFundCreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: PrivateFundCreateProjectDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyTicker, setCompanyTicker] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    setDatasetId("");
    setCompanyName("");
    setCompanyTicker("");
  }, [open]);

  const mutation = useMutation({
    mutationFn: async () => {
      const project = await createPrivateFundProject({
        name: name.trim(),
        datasetId: datasetId.trim() || undefined,
        companyName: companyName.trim(),
        companyTicker: companyTicker.trim(),
      });
      await activatePrivateFundProject(project.datasetId);
      return project;
    },
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["private-fund-projects"] });
      void queryClient.invalidateQueries({ queryKey: ["private-fund-project", project.datasetId] });
      onCreated(project);
      onOpenChange(false);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !mutation.isPending) mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!mutation.isPending) onOpenChange(next);
      }}
    >
      <DialogContent
        aria-label="新建研究项目"
        className="sm:max-w-md"
        showCloseButton={!mutation.isPending}
        onEscapeKeyDown={(event) => {
          if (mutation.isPending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (mutation.isPending) event.preventDefault();
        }}
      >
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>新建研究项目</DialogTitle>
            <DialogDescription>
              创建后直接进入统一研究工作台，再从左侧资料来源上传并索引文档。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium">项目名称</span>
              <Input
                autoFocus
                aria-label="研究项目名称"
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：阳光电源"
                value={name}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium">Dataset ID（可选）</span>
              <Input
                aria-label="研究项目 Dataset ID"
                onChange={(event) => setDatasetId(event.target.value)}
                placeholder="留空则使用项目名称"
                value={datasetId}
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium">公司名称（可选）</span>
                <Input
                  aria-label="研究项目公司名称"
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder="公司全称"
                  value={companyName}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium">股票代码（可选）</span>
                <Input
                  aria-label="研究项目股票代码"
                  onChange={(event) => setCompanyTicker(event.target.value)}
                  placeholder="例如：300274"
                  value={companyTicker}
                />
              </label>
            </div>
            {mutation.error ? (
              <p className="rounded-lg border border-[var(--pf-line)] bg-[var(--pf-danger-soft)] px-3 py-2 text-xs text-[var(--pf-danger-ink)]">
                {mutation.error instanceof Error ? mutation.error.message : "创建研究项目失败"}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              disabled={mutation.isPending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="secondary"
            >
              取消
            </Button>
            <Button disabled={!name.trim() || mutation.isPending} type="submit">
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              创建并进入工作台
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
