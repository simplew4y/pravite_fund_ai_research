import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { useT } from "../i18n/useT";

/**
 * Shared overlay dialog. `wide` switches to the viewer layout (evidence
 * sources, document previews, diffs) which needs most of the viewport.
 */
export function Modal({
  title,
  onClose,
  wide = false,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useT();
  // Close only when the interaction both starts and ends on the backdrop —
  // a text-selection drag that ends outside the dialog must not dismiss it.
  const mouseDownOnBackdrop = useRef(false);
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        mouseDownOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (mouseDownOnBackdrop.current && event.target === event.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        className={wide ? "dialog dialog-wide elev-lg" : "dialog elev-lg"}
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2 className="dialog-title">{title}</h2>
          <button
            className="btn btn-quiet"
            title={t("common.close")}
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div className="dialog-scroll">{children}</div>
      </div>
    </div>
  );
}
