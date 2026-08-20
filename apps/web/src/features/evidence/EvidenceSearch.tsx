import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { searchEvidence, type ResearchEvidenceTrace } from "../../api/research";
import type { DictKey } from "../../i18n/dict";
import { useT } from "../../i18n/useT";

const KIND_LABEL: Record<ResearchEvidenceTrace["kind"], DictKey> = {
  chunk: "evidence.kind.chunk",
  fact: "evidence.kind.fact",
  cell: "evidence.kind.cell",
  page: "evidence.kind.page",
};

/**
 * Full-text search over a project's evidence traces. Renders a debounced
 * query input plus a flat result list; opening a hit is delegated to the
 * caller via `onOpen` (the evidence viewer is wired up by the shell).
 */
export function EvidenceSearch({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (evidenceId: string) => void;
}) {
  const { t } = useT();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQ(q), 400);
    return () => clearTimeout(handle);
  }, [q]);

  const enabled = debouncedQ.trim().length >= 2;
  const search = useQuery({
    queryKey: ["evidence-search", projectId, debouncedQ],
    queryFn: () => searchEvidence(projectId, debouncedQ),
    enabled,
  });

  // Hide stale results immediately when the input is cleared instead of
  // waiting out the debounce window.
  const showResults = enabled && q.trim().length > 0;

  return (
    <div>
      <input
        className="input"
        placeholder={t("evidence.search")}
        value={q}
        onChange={(event) => setQ(event.target.value)}
      />
      {showResults ? (
        <div>
          {search.isLoading ? (
            <p className="text-muted">{t("common.loading")}</p>
          ) : null}
          {search.isError ? <p className="error-text">{t("common.error")}</p> : null}
          {search.data?.items.map(({ evidence }) => (
            <button
              key={evidence.evidenceId}
              type="button"
              className="doc-row"
              style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
              onClick={() => onOpen(evidence.evidenceId)}
            >
              <span className="tag tag-neutral">{t(KIND_LABEL[evidence.kind])}</span>
              <span className="title">
                {evidence.title ?? evidence.originalText.slice(0, 90)}
              </span>
              <span
                className="date"
                style={{
                  maxWidth: 140,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={evidence.document.title}
              >
                {evidence.document.title}
              </span>
            </button>
          ))}
          {search.data && search.data.items.length === 0 ? (
            <p className="text-muted">{t("common.empty")}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
