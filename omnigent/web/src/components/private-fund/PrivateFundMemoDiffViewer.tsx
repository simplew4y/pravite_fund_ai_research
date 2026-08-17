import { DiffEditor, type DiffEditorProps } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";

import { normalizeResolvedTheme } from "@/components/theme/themeMode";
import {
  ensureLanguage,
  ensureMonacoReady,
  monacoLanguageId,
  resolvedThemeToMonaco,
} from "@/shell/monacoSetup";

export interface PrivateFundMemoDiffViewerProps {
  before: string;
  after: string;
  layout: "unified" | "split";
  hideWhitespace: boolean;
}

/** Read-only Markdown diff without the file-review comment layer. */
export function PrivateFundMemoDiffViewer({
  before,
  after,
  layout,
  hideWhitespace,
}: PrivateFundMemoDiffViewerProps) {
  const { resolvedTheme } = useTheme();
  const monacoTheme = resolvedThemeToMonaco(normalizeResolvedTheme(resolvedTheme));
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setLoadError(false);
    void Promise.all([ensureMonacoReady(), ensureLanguage("markdown")]).then(
      () => {
        if (!cancelled) setReady(true);
      },
      () => {
        if (!cancelled) setLoadError(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo<DiffEditorProps["options"]>(
    () => ({
      readOnly: true,
      originalEditable: false,
      renderSideBySide: layout === "split",
      automaticLayout: true,
      diffAlgorithm: "advanced",
      fontSize: 12,
      lineHeight: 20,
      wordWrap: "on",
      wrappingIndent: "same",
      minimap: { enabled: false },
      glyphMargin: false,
      folding: false,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      renderIndicators: true,
      ignoreTrimWhitespace: hideWhitespace,
      hideUnchangedRegions: {
        enabled: true,
        contextLineCount: 3,
        minimumLineCount: 4,
        revealLineCount: 12,
      },
      originalAriaLabel: "基准 Memo 版本",
      modifiedAriaLabel: "对比 Memo 版本",
    }),
    [hideWhitespace, layout],
  );

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-red-700">
        无法加载版本差异视图。
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--pf-ink-muted)]">
        正在加载版本差异…
      </div>
    );
  }

  return (
    <DiffEditor
      height="100%"
      language={monacoLanguageId("markdown")}
      modified={after}
      options={options}
      original={before}
      theme={monacoTheme}
    />
  );
}
