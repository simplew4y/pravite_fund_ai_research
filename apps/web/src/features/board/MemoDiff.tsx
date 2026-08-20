import type { MemoComparison, MemoSectionChange } from "../../api/insights";
import { Modal } from "../../components/Modal";
import { MonoLabel } from "../../components/MonoLabel";
import type { DictKey } from "../../i18n/dict";
import { useT } from "../../i18n/useT";

type VisibleChangeType = Exclude<MemoSectionChange["changeType"], "unchanged">;

const CHANGE_TAG: Record<VisibleChangeType, { key: DictKey; className: string }> = {
  added: { key: "memo.added", className: "tag tag-accent" },
  changed: { key: "memo.changed", className: "tag tag-outline" },
  not_mentioned: { key: "memo.removed", className: "tag tag-neutral" },
};

const PRE_STYLE = { whiteSpace: "pre-wrap", fontSize: 12, margin: 0 } as const;

/** Version records come from the loose insights envelope; only render scalars. */
function versionLabel(record: Record<string, unknown>): string {
  const value = record["versionNo"];
  if (typeof value === "number") return `v${String(value)}`;
  if (typeof value === "string" && value) return `v${value}`;
  return "";
}

function text(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

export function MemoDiff({
  comparison,
  onClose,
}: {
  comparison: MemoComparison;
  onClose: () => void;
}) {
  const { t } = useT();

  const fromLabel = versionLabel(comparison.fromVersion);
  const toLabel = versionLabel(comparison.toVersion);
  const visible = comparison.sectionChanges.filter(
    (section): section is MemoSectionChange & { changeType: VisibleChangeType } =>
      section.changeType !== "unchanged",
  );
  const hiddenCount = comparison.sectionChanges.length - visible.length;

  return (
    <Modal title={t("memo.compare")} onClose={onClose} wide>
      <MonoLabel>
        {fromLabel} → {toLabel}
      </MonoLabel>
      {visible.length === 0 ? <p className="text-muted">{t("common.empty")}</p> : null}
      {visible.map((section) => {
        const tag = CHANGE_TAG[section.changeType];
        return (
          <div key={section.sectionKey} className="panel" style={{ marginTop: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <span className={tag.className}>{t(tag.key)}</span>
              <span>{section.title}</span>
            </div>
            {section.changeType === "changed" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <MonoLabel>{fromLabel}</MonoLabel>
                <pre style={PRE_STYLE}>{section.oldContent}</pre>
                <MonoLabel>{toLabel}</MonoLabel>
                <pre style={PRE_STYLE}>{section.newContent}</pre>
              </div>
            ) : (
              <pre style={PRE_STYLE}>
                {section.changeType === "added" ? section.newContent : section.oldContent}
              </pre>
            )}
          </div>
        );
      })}
      {hiddenCount > 0 ? (
        <p className="text-muted" style={{ fontSize: 12 }}>
          {t("memo.unchangedHidden")} · {hiddenCount}
        </p>
      ) : null}
      {comparison.itemChanges.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <MonoLabel>{t("risks.item")}</MonoLabel>
          {comparison.itemChanges.map((item, index) => {
            const materiality = text(item, "materiality");
            return (
              <div
                key={text(item, "itemId", "id") || String(index)}
                className="doc-row"
              >
                <span className="title">{text(item, "summary", "title")}</span>
                {materiality ? (
                  <span className="tag tag-neutral">{materiality}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </Modal>
  );
}
