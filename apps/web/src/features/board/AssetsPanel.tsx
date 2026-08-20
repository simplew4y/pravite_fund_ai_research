import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import {
  addAssetToSession,
  deleteAssets,
  fetchAsset,
  listAssets,
} from "../../api/assets";
import { Modal } from "../../components/Modal";
import { MonoLabel } from "../../components/MonoLabel";
import { useT } from "../../i18n/useT";
import { useUiStore } from "../../store/ui";

function AssetDetailBody({
  projectId,
  assetId,
}: {
  projectId: string;
  assetId: string;
}) {
  const { t } = useT();
  const detail = useQuery({
    queryKey: ["asset", projectId, assetId],
    queryFn: () => fetchAsset(projectId, assetId),
  });

  if (detail.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (detail.isError) return <p className="error-text">{t("common.error")}</p>;

  const version = detail.data.version;
  if (version === null) return <p className="text-muted">{t("common.empty")}</p>;

  return (
    <div>
      {version.summary ? <p className="text-muted">{version.summary}</p> : null}
      {version.tags.length > 0 ? (
        <div className="ctx-chips">
          {version.tags.map((tag) => (
            <span key={tag} className="ctx-chip">
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>
        {version.contentMarkdown}
      </pre>
    </div>
  );
}

export function AssetsPanel({ projectId }: { projectId: string }) {
  const { t } = useT();
  const client = useQueryClient();
  const expandedSessionId = useUiStore((state) => state.expandedSessionId);
  const assets = useQuery({
    queryKey: ["assets", projectId],
    queryFn: () => listAssets(projectId),
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openAsset, setOpenAsset] = useState<{ id: string; title: string } | null>(
    null,
  );

  // Selection is project-scoped: keeping it across a project switch would
  // delete or attach assets that belong to another project.
  useEffect(() => {
    setSelected(new Set());
    setOpenAsset(null);
  }, [projectId]);

  const remove = useMutation({
    mutationFn: () => deleteAssets(projectId, [...selected]),
    onSuccess: () => {
      setSelected(new Set());
      void client.invalidateQueries({ queryKey: ["assets", projectId] });
    },
  });

  const addToContext = useMutation({
    mutationFn: async () => {
      for (const assetId of selected) {
        await addAssetToSession(expandedSessionId!, assetId);
      }
      setSelected(new Set());
    },
    // Refresh the chat's context chips immediately.
    onSuccess: () =>
      void client.invalidateQueries({
        queryKey: ["session-resources", expandedSessionId],
      }),
  });

  function toggle(assetId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  return (
    <div>
      {assets.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
      {assets.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {remove.isError || addToContext.isError ? (
        <p className="error-text">{t("common.error")}</p>
      ) : null}
      {assets.data?.map((asset) => (
        <label
          key={asset.id}
          className={selected.has(asset.id) ? "doc-row selected" : "doc-row"}
        >
          <input
            type="checkbox"
            checked={selected.has(asset.id)}
            onChange={() => toggle(asset.id)}
          />
          <span className="tag tag-neutral">{asset.assetType}</span>
          <span className="title">{asset.title}</span>
          {asset.status === "archived" ? (
            <span className="tag tag-outline">{t("assets.archived")}</span>
          ) : null}
          <span className="date">{asset.updatedAt.slice(5, 10)}</span>
          <button
            className="btn btn-ghost"
            onClick={(event) => {
              // Keep the label from forwarding the click to the checkbox.
              event.preventDefault();
              setOpenAsset({ id: asset.id, title: asset.title });
            }}
          >
            {t("common.open")}
          </button>
        </label>
      ))}
      {assets.data?.length === 0 ? (
        <p className="text-muted">{t("common.empty")}</p>
      ) : null}
      {selected.size > 0 ? (
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <MonoLabel>
            {selected.size} {t("board.selected")}
          </MonoLabel>
          {expandedSessionId ? (
            <button
              className="btn btn-primary"
              onClick={() => addToContext.mutate()}
              disabled={addToContext.isPending}
            >
              {t("board.toContext")}
            </button>
          ) : null}
          <button
            className="btn btn-ghost"
            title={t("assets.delete")}
            aria-label={t("assets.delete")}
            onClick={() => {
              if (window.confirm(t("assets.delete.confirm"))) remove.mutate();
            }}
            disabled={remove.isPending}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ) : null}
      {openAsset ? (
        <Modal title={openAsset.title} onClose={() => setOpenAsset(null)} wide>
          <AssetDetailBody projectId={projectId} assetId={openAsset.id} />
        </Modal>
      ) : null}
    </div>
  );
}
