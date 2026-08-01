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
import { showToast } from "@/components/ui/toast";
import {
  type PrivateFundProject,
  updatePrivateFundProject,
} from "@/lib/privateFundApi";

export type PrivateFundEditProjectDialogProps = {
  open: boolean;
  project: PrivateFundProject | null | undefined;
  onOpenChange: (open: boolean) => void;
};

export function PrivateFundEditProjectDialog({
  open,
  project,
  onOpenChange,
}: PrivateFundEditProjectDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyTicker, setCompanyTicker] = useState("");

  useEffect(() => {
    if (!open || !project) return;
    setName(project.name);
    setCompanyName(project.companyName ?? "");
    setCompanyTicker(project.companyTicker ?? "");
  }, [open, project]);

  const mutation = useMutation({
    mutationFn: () => {
      const tickerChanged =
        companyTicker.trim().toUpperCase() !== (project!.companyTicker ?? "").trim().toUpperCase();
      return updatePrivateFundProject(project!.datasetId, {
        name: name.trim(),
        companyName: companyName.trim(),
        companyTicker: companyTicker.trim(),
      }).then((updated) => ({ updated, tickerChanged }));
    },
    onSuccess: async ({ updated, tickerChanged }) => {
      queryClient.setQueryData<{ project: PrivateFundProject; files: unknown[] }>(
        ["private-fund-project", updated.datasetId],
        (current: { project: PrivateFundProject; files: unknown[] } | undefined) =>
          current ? { ...current, project: updated } : current,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["private-fund-projects"] }),
        queryClient.invalidateQueries({
          queryKey: ["private-fund-valuation-tracking", updated.datasetId],
        }),
      ]);
      onOpenChange(false);
      showToast(tickerChanged ? "项目信息已更新，正在刷新真实数据" : "研究项目信息已更新");
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (project && name.trim() && !mutation.isPending) mutation.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!mutation.isPending) onOpenChange(next);
      }}
    >
      <DialogContent
        aria-label="编辑研究项目"
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
            <DialogTitle>编辑研究项目</DialogTitle>
            <DialogDescription>
              修改项目与公司信息。股票代码用于查询行情和真实财务数据。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium">项目名称</span>
              <Input
                autoFocus
                aria-label="编辑研究项目名称"
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：阳光电源"
                value={name}
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium">公司名称（可选）</span>
                <Input
                  aria-label="编辑研究项目公司名称"
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder="公司全称"
                  value={companyName}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium">股票代码（可选）</span>
                <Input
                  aria-label="编辑研究项目股票代码"
                  onChange={(event) => setCompanyTicker(event.target.value)}
                  placeholder="例如：300274"
                  value={companyTicker}
                />
              </label>
            </div>
            {mutation.error ? (
              <p
                className="rounded-lg border border-[var(--pf-line)] bg-[var(--pf-danger-soft)] px-3 py-2 text-xs text-[var(--pf-danger-ink)]"
                role="alert"
              >
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : "更新研究项目失败"}
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
            <Button disabled={!project || !name.trim() || mutation.isPending} type="submit">
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
