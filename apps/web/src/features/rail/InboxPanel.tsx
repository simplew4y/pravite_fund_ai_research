import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, UploadCloud, X } from "lucide-react";
import { globalUploadItemSchema, type GlobalUploadItem } from "@private-fund/contracts";
import { z } from "zod";

import { query, request, requestJson } from "../../api/http";
import { useProjects } from "../../api/queries";
import { MonoLabel } from "../../components/MonoLabel";
import { useT } from "../../i18n/useT";

const itemsPageSchema = z
  .object({ items: z.array(globalUploadItemSchema) })
  .loose();

function listUploadItems(status?: string): Promise<GlobalUploadItem[]> {
  return requestJson(`/v1/uploads/items${query({ status, limit: 100 })}`, itemsPageSchema).then(
    (page) => page.items,
  );
}

async function uploadGlobal(files: File[]): Promise<void> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  await request("/v1/uploads", { method: "POST", form });
}

async function routeItem(itemId: string, projectId: string): Promise<void> {
  await request(`/v1/uploads/items/${itemId}/route`, {
    method: "POST",
    body: { projectId, idempotencyKey: `route-${crypto.randomUUID()}` },
  });
}

export function useInboxCount(): number {
  const pending = useQuery({
    queryKey: ["uploads", "needs_review"],
    queryFn: () => listUploadItems("needs_review"),
    refetchInterval: 30_000,
  });
  return pending.data?.length ?? 0;
}

export function InboxPanel({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const client = useQueryClient();
  const projects = useProjects();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const items = useQuery({
    queryKey: ["uploads", "all"],
    queryFn: () => listUploadItems(),
    refetchInterval: 5_000,
  });

  const route = useMutation({
    mutationFn: (input: { itemId: string; projectId: string }) =>
      routeItem(input.itemId, input.projectId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["uploads"] }),
  });

  async function upload(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    try {
      await uploadGlobal(files);
      await client.invalidateQueries({ queryKey: ["uploads"] });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog elev-lg"
        role="dialog"
        aria-label={t("inbox.title")}
        style={{ width: 560, maxHeight: "80vh", overflowY: "auto" }}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dialog-title" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>
            <Inbox size={16} strokeWidth={1.5} /> {t("inbox.title")}
          </span>
          <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label={t("common.close")}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </h2>

        <button
          className="btn btn-secondary btn-block"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          <UploadCloud size={14} strokeWidth={1.5} />{" "}
          {uploading ? t("workbench.upload.uploading") : t("workbench.upload.choose")}
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          onChange={(event) => {
            void upload([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />

        {items.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
        {items.data?.length === 0 ? <p className="text-muted">{t("common.empty")}</p> : null}
        {items.data?.map((item) => (
          <div key={item.itemId} className="doc-row">
            <span className="title" title={item.originalFilename}>
              {item.originalFilename}
            </span>
            <span
              className={
                item.status === "needs_review" || item.status === "failed"
                  ? "tag tag-outline"
                  : "tag tag-accent"
              }
            >
              {item.status === "needs_review" ? t("inbox.review") : item.status}
            </span>
            {item.status === "needs_review" ? (
              <select
                className="input"
                style={{ width: 140 }}
                aria-label={t("inbox.route")}
                defaultValue=""
                onChange={(event) => {
                  if (event.target.value) {
                    route.mutate({ itemId: item.itemId, projectId: event.target.value });
                  }
                }}
              >
                <option value="" disabled>
                  {t("inbox.route")}
                </option>
                {projects.data?.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            ) : null}
            {item.targetProjectId ? <MonoLabel>{t("inbox.matched")}</MonoLabel> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
