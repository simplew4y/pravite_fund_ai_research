import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyTicker, setCompanyTicker] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    setCompanyName("");
    setCompanyTicker("");
  }, [open]);

  const mutation = useMutation({
    mutationFn: async () => {
      const project = await createPrivateFundProject({
        name: name.trim(),
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
        aria-label={t("privateFund.createProject")}
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
            <DialogTitle>{t("privateFund.createProject")}</DialogTitle>
            <DialogDescription>
              {t(
                "privateFund.createProjectDescription",
                "Create the project, then upload and index sources from the left sidebar.",
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium">{t("privateFund.projectName")}</span>
              <Input
                autoFocus
                aria-label={t("privateFund.projectName")}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("privateFund.projectNamePlaceholder", "For example: Sungrow Power")}
                value={name}
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium">
                  {t("privateFund.companyName")} ({t("auth.optional", "Optional")})
                </span>
                <Input
                  aria-label={t("privateFund.companyName")}
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder={t("privateFund.companyNamePlaceholder", "Full company name")}
                  value={companyName}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium">
                  {t("privateFund.stockCode")} ({t("auth.optional", "Optional")})
                </span>
                <Input
                  aria-label={t("privateFund.stockCode")}
                  onChange={(event) => setCompanyTicker(event.target.value)}
                  placeholder={t("privateFund.stockCodePlaceholder")}
                  value={companyTicker}
                />
              </label>
            </div>
            {mutation.error ? (
              <p className="rounded-lg border border-[var(--pf-line)] bg-[var(--pf-danger-soft)] px-3 py-2 text-xs text-[var(--pf-danger-ink)]">
                {mutation.error instanceof Error
                  ? mutation.error.message
                  : t("privateFund.createProjectFailed", "Could not create the project")}
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
              {t("common.cancel")}
            </Button>
            <Button disabled={!name.trim() || mutation.isPending} type="submit">
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("privateFund.createAndOpen", "Create and open")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
