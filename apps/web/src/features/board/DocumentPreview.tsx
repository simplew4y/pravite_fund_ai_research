import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import {
  documentDownloadUrl,
  fetchDocumentTextPreview,
  listDocumentVersions,
} from "../../api/research";
import { Modal } from "../../components/Modal";
import { MonoLabel } from "../../components/MonoLabel";
import type { DictKey } from "../../i18n/dict";
import { useT } from "../../i18n/useT";

const VERSION_STATUS_LABEL: Record<string, DictKey> = {
  parsing: "docs.status.parsing",
  indexed: "docs.status.indexed",
  needs_ocr: "docs.status.needs_ocr",
  failed: "docs.status.failed",
  review_required: "docs.status.review_required",
};

/**
 * Wide modal over a project document: markdown text preview plus the
 * version history, with per-version download links.
 */
export function DocumentPreview({
  projectId,
  documentId,
  title,
  onClose,
}: {
  projectId: string;
  documentId: string;
  title: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<"preview" | "versions">("preview");

  const preview = useQuery({
    queryKey: ["document-text-preview", projectId, documentId],
    queryFn: () => fetchDocumentTextPreview(projectId, documentId),
  });
  const versions = useQuery({
    queryKey: ["document-versions", projectId, documentId],
    queryFn: () => listDocumentVersions(projectId, documentId),
    enabled: tab === "versions",
  });

  return (
    <Modal title={title} onClose={onClose} wide>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <button
          className={tab === "preview" ? "btn btn-secondary" : "btn btn-ghost"}
          onClick={() => setTab("preview")}
        >
          {t("common.preview")}
        </button>
        <button
          className={tab === "versions" ? "btn btn-secondary" : "btn btn-ghost"}
          onClick={() => setTab("versions")}
        >
          {t("docs.versions")}
        </button>
        <a className="btn btn-ghost" href={documentDownloadUrl(projectId, documentId)}>
          {t("common.download")}
        </a>
      </div>
      {tab === "preview" ? (
        <div>
          {preview.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
          {preview.isError ? (
            <div>
              <p className="error-text">{t("common.error")}</p>
              <a
                className="btn btn-secondary"
                href={documentDownloadUrl(projectId, documentId)}
              >
                {t("common.download")}
              </a>
            </div>
          ) : null}
          {preview.data ? (
            <>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
                {preview.data.contentMarkdown}
              </pre>
              {preview.data.truncated ? <p className="text-muted">…</p> : null}
            </>
          ) : null}
        </div>
      ) : (
        <div>
          {versions.isPending ? <p className="text-muted">{t("common.loading")}</p> : null}
          {versions.isError ? <p className="error-text">{t("common.error")}</p> : null}
          {versions.data?.length === 0 ? (
            <p className="text-muted">{t("common.empty")}</p>
          ) : null}
          {versions.data?.map((version) => (
            <div key={version.id} className="doc-row">
              <span className="title">
                v{version.versionNo} · {version.originalFilename}
              </span>
              <span
                className={
                  version.status === "failed" ? "tag tag-outline" : "tag tag-neutral"
                }
              >
                {(() => {
                  const key = VERSION_STATUS_LABEL[version.status];
                  return key === undefined ? version.status : t(key);
                })()}
              </span>
              <MonoLabel>
                {(version.fileSize / 1024).toFixed(0)}KB · {version.createdAt.slice(0, 10)}
              </MonoLabel>
              <a
                className="btn btn-icon btn-ghost"
                href={documentDownloadUrl(projectId, documentId, version.id)}
                title={t("common.download")}
              >
                <Download size={14} />
              </a>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
