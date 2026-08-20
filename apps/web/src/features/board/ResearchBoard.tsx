import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Eye,
  FileText,
  FolderMinus,
  FolderPlus,
  Trash2,
  WandSparkles,
} from "lucide-react";

import { deleteDocuments } from "../../api/client";
import {
  addDocumentToSession,
  compareMemoVersions,
  fetchMemoVersions,
  generateMemo,
  memoDownloadUrl,
} from "../../api/insights";
import {
  assignDocumentToFolder,
  createSourceFolder,
  deleteSourceFolder,
  fetchSourceFolders,
} from "../../api/assets";
import { documentDownloadUrl } from "../../api/research";
import { useProjectDocuments, useServerInfo } from "../../api/queries";
import { MonoLabel } from "../../components/MonoLabel";
import { useT } from "../../i18n/useT";
import { useUiStore } from "../../store/ui";
import { EvidenceSearch } from "../evidence/EvidenceSearch";
import { EvidenceViewer } from "../evidence/EvidenceViewer";
import { AssetsPanel } from "./AssetsPanel";
import { DocumentPreview } from "./DocumentPreview";
import { JobsBadge } from "./JobsBadge";
import { MemoDiff } from "./MemoDiff";

function text(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

function DocumentsPanel({ projectId }: { projectId: string }) {
  const { t } = useT();
  const client = useQueryClient();
  const documents = useProjectDocuments(projectId);
  const expandedSessionId = useUiStore((state) => state.expandedSessionId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [previewDocument, setPreviewDocument] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [viewerEvidenceId, setViewerEvidenceId] = useState<string | null>(null);

  // Selection is project-scoped: keeping it across a project switch would
  // delete or attach documents that belong to another project.
  useEffect(() => {
    setSelected(new Set());
    setFilter("");
    setFolderId(null);
  }, [projectId]);

  // Folders are optional (503 when the store is disabled) — hide on error.
  const folders = useQuery({
    queryKey: ["folders", projectId],
    queryFn: () => fetchSourceFolders(projectId),
    retry: false,
  });
  const invalidateFolders = () =>
    void client.invalidateQueries({ queryKey: ["folders", projectId] });

  const createFolder = useMutation({
    mutationFn: (name: string) => createSourceFolder(projectId, name),
    onSuccess: invalidateFolders,
  });
  const removeFolder = useMutation({
    mutationFn: (id: string) => deleteSourceFolder(projectId, id),
    onSuccess: () => {
      setFolderId(null);
      invalidateFolders();
    },
  });
  const assignSelected = useMutation({
    mutationFn: async (targetFolderId: string) => {
      for (const documentId of selected) {
        await assignDocumentToFolder(projectId, targetFolderId, documentId);
      }
      setSelected(new Set());
    },
    onSuccess: invalidateFolders,
  });

  const documentFolder = useMemo(() => {
    const map = new Map<string, string>();
    for (const assignment of folders.data?.assignments ?? []) {
      map.set(assignment.documentId, assignment.folderId);
    }
    return map;
  }, [folders.data]);

  const remove = useMutation({
    mutationFn: () => deleteDocuments(projectId, [...selected]),
    onSuccess: () => {
      setSelected(new Set());
      void client.invalidateQueries({ queryKey: ["documents", projectId] });
    },
  });

  const addToContext = useMutation({
    mutationFn: async () => {
      for (const documentId of selected) {
        await addDocumentToSession(expandedSessionId!, documentId);
      }
      setSelected(new Set());
    },
    // Refresh the chat's context chips immediately.
    onSuccess: () =>
      void client.invalidateQueries({
        queryKey: ["session-resources", expandedSessionId],
      }),
  });

  function toggle(documentId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  }

  const rows = documents.data?.items.filter(
    (document) =>
      (!filter || document.title.toLowerCase().includes(filter.toLowerCase())) &&
      (folderId === null || documentFolder.get(document.id) === folderId),
  );

  return (
    <div>
      <EvidenceSearch projectId={projectId} onOpen={setViewerEvidenceId} />
      <input
        className="input"
        placeholder={t("docs.search")}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {folders.data ? (
        <div className="ctx-chips" style={{ margin: "6px 0" }}>
          <button
            className={folderId === null ? "ctx-chip asset" : "ctx-chip"}
            onClick={() => setFolderId(null)}
          >
            {t("docs.folder.all")}
          </button>
          {folders.data.folders.map((folder) => (
            <button
              key={folder.id}
              className={folderId === folder.id ? "ctx-chip asset" : "ctx-chip"}
              onClick={() => setFolderId(folder.id)}
            >
              {folder.name} · {folder.documentCount}
            </button>
          ))}
          <button
            className="btn btn-quiet"
            style={{ width: 22, height: 22 }}
            title={t("docs.folder.new")}
            aria-label={t("docs.folder.new")}
            onClick={() => {
              const name = window.prompt(t("docs.folder.new"));
              if (name?.trim()) createFolder.mutate(name.trim());
            }}
          >
            <FolderPlus size={13} />
          </button>
          {folderId !== null ? (
            <button
              className="btn btn-quiet danger"
              style={{ width: 22, height: 22 }}
              title={t("docs.folder.delete")}
              aria-label={t("docs.folder.delete")}
              onClick={() => {
                if (window.confirm(t("docs.folder.delete.confirm"))) {
                  removeFolder.mutate(folderId);
                }
              }}
            >
              <FolderMinus size={13} />
            </button>
          ) : null}
        </div>
      ) : null}
      {documents.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
      {documents.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {remove.isError ||
      addToContext.isError ||
      assignSelected.isError ||
      createFolder.isError ||
      removeFolder.isError ? (
        <p className="error-text">{t("common.error")}</p>
      ) : null}
      {rows?.map((document) => (
        <label
          key={document.id}
          className={selected.has(document.id) ? "doc-row selected" : "doc-row"}
        >
          <input
            type="checkbox"
            checked={selected.has(document.id)}
            onChange={() => toggle(document.id)}
          />
          <FileText size={15} color="#71717a" style={{ flex: "none" }} />
          <span className="title">{document.title}</span>
          {document.currentVersionNo === 0 ? (
            <span className="tag tag-neutral">{t("docs.indexing")}</span>
          ) : null}
          <button
            className="btn btn-quiet"
            style={{ width: 22, height: 22, flex: "none" }}
            title={t("common.preview")}
            aria-label={`${t("common.preview")} ${document.title}`}
            onClick={(event) => {
              event.preventDefault();
              setPreviewDocument({ id: document.id, title: document.title });
            }}
          >
            <Eye size={13} />
          </button>
          <a
            className="btn btn-quiet"
            style={{ width: 22, height: 22, flex: "none" }}
            title={t("common.download")}
            aria-label={`${t("common.download")} ${document.title}`}
            href={documentDownloadUrl(projectId, document.id)}
            onClick={(event) => event.stopPropagation()}
          >
            <Download size={13} />
          </a>
          <span className="date">{document.updatedAt.slice(5, 10)}</span>
        </label>
      ))}
      {rows?.length === 0 ? <p className="text-muted">{t("common.empty")}</p> : null}
      {selected.size > 0 ? (
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
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
          {folderId !== null ? (
            <button
              className="btn btn-secondary"
              onClick={() => assignSelected.mutate(folderId)}
              disabled={assignSelected.isPending}
            >
              {t("docs.folder.assign")}
            </button>
          ) : null}
          <button
            className="btn btn-ghost"
            onClick={() => {
              if (window.confirm(t("docs.delete.confirm"))) remove.mutate();
            }}
            disabled={remove.isPending}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ) : null}
      {previewDocument ? (
        <DocumentPreview
          projectId={projectId}
          documentId={previewDocument.id}
          title={previewDocument.title}
          onClose={() => setPreviewDocument(null)}
        />
      ) : null}
      {viewerEvidenceId !== null ? (
        <EvidenceViewer
          projectId={projectId}
          evidenceId={viewerEvidenceId}
          onClose={() => setViewerEvidenceId(null)}
        />
      ) : null}
    </div>
  );
}

function MemoPanel({ projectId }: { projectId: string }) {
  const { t } = useT();
  const info = useServerInfo();
  const tracking = useQuery({
    queryKey: ["memo-versions", projectId],
    queryFn: () => fetchMemoVersions(projectId),
    enabled: info.data?.insights_store === true,
  });
  const [compareFrom, setCompareFrom] = useState<string | null>(null);
  const compare = useMutation({
    mutationFn: (input: { from: string; to: string }) =>
      compareMemoVersions(projectId, input.from, input.to),
  });
  const generate = useMutation({
    mutationFn: (instruction: string) => generateMemo(projectId, instruction),
  });
  const resetCompare = compare.reset;
  useEffect(() => {
    setCompareFrom(null);
    resetCompare();
  }, [projectId, resetCompare]);

  if (info.isError) return <p className="error-text">{t("common.error")}</p>;
  if (info.data && !info.data.insights_store) {
    return <p className="text-muted">{t("memo.unavailable")}</p>;
  }
  if (tracking.isPending) return <p className="text-muted">{t("common.loading")}</p>;
  if (tracking.isError) return <p className="error-text">{t("common.error")}</p>;

  const versions = tracking.data.versions;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <MonoLabel>{t("memo.versions")}</MonoLabel>
        <button
          className="btn btn-secondary"
          disabled={generate.isPending}
          onClick={() => {
            const instruction = window.prompt(t("memo.generate.prompt"));
            if (instruction?.trim()) generate.mutate(instruction.trim());
          }}
        >
          <WandSparkles size={13} /> {t("memo.generate")}
        </button>
      </div>
      {generate.isSuccess ? (
        <p className="text-muted" style={{ fontSize: 12 }}>
          {t("common.queued")}
        </p>
      ) : null}
      {generate.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {versions.length === 0 ? <p className="text-muted">{t("common.empty")}</p> : null}
      {versions.map((version) => {
        const id = text(version, "memoVersionId", "id", "versionId");
        return (
          <div key={id} className="doc-row">
            <span className="title">
              v{text(version, "versionNo", "version")} · {text(version, "seriesTitle", "topic")}
            </span>
            <button
              className="btn btn-ghost"
              disabled={id === ""}
              onClick={() => {
                if (compareFrom === null) setCompareFrom(id);
                else {
                  compare.mutate({ from: compareFrom, to: id });
                  setCompareFrom(null);
                }
              }}
            >
              {compareFrom === null ? t("memo.compare") : `→ ${t("memo.compare")}`}
            </button>
            {id === "" ? null : (
              <a
                className="btn btn-icon btn-ghost"
                href={memoDownloadUrl(projectId, id)}
                target="_blank"
                rel="noopener"
                title={t("common.download")}
              >
                <Download size={14} />
              </a>
            )}
          </div>
        );
      })}
      {compare.isError ? <p className="error-text">{t("common.error")}</p> : null}
      {compare.data ? (
        <MemoDiff comparison={compare.data} onClose={() => compare.reset()} />
      ) : null}
    </div>
  );
}

export function ResearchBoard({ projectId }: { projectId: string }) {
  const { t } = useT();

  return (
    <aside className="app-board">
      <div className="board-title">{t("board.title")}</div>
      <JobsBadge projectId={projectId} />
      <section className="board-section" aria-label={t("board.documents")}>
        <h4>{t("board.documents")}</h4>
        <DocumentsPanel projectId={projectId} />
      </section>
      <section className="board-section" aria-label={t("board.assets")}>
        <h4>{t("board.assets")}</h4>
        <AssetsPanel projectId={projectId} />
      </section>
      <section className="board-section" aria-label={t("board.memo")}>
        <h4>{t("board.memo")}</h4>
        <MemoPanel projectId={projectId} />
      </section>
    </aside>
  );
}
