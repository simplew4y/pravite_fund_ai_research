import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  props: null as {
    original?: string;
    modified?: string;
    language?: string;
    options?: {
      readOnly?: boolean;
      renderSideBySide?: boolean;
      ignoreTrimWhitespace?: boolean;
      hideUnchangedRegions?: { enabled?: boolean };
    };
  } | null,
}));

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: typeof captured.props) => {
    captured.props = props;
    return <div data-testid="memo-monaco-diff" />;
  },
}));
vi.mock("@/shell/monacoSetup", () => ({
  ensureMonacoReady: vi.fn(() => Promise.resolve()),
  ensureLanguage: vi.fn(() => Promise.resolve()),
  monacoLanguageId: vi.fn((language: string) => language),
  resolvedThemeToMonaco: vi.fn(() => "github-light"),
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

import { PrivateFundMemoDiffViewer } from "./PrivateFundMemoDiffViewer";

beforeEach(() => {
  captured.props = null;
});
afterEach(() => {
  cleanup();
});

describe("PrivateFundMemoDiffViewer", () => {
  it("renders an exact read-only Markdown split diff", async () => {
    render(
      <PrivateFundMemoDiffViewer
        after="## 结论\n\n利润 180 亿元。\n"
        before="## 结论\n\n利润 150 亿元。\n"
        hideWhitespace
        layout="split"
      />,
    );

    await waitFor(() => expect(captured.props).not.toBeNull());
    expect(captured.props?.original).toContain("150 亿元");
    expect(captured.props?.modified).toContain("180 亿元");
    expect(captured.props?.language).toBe("markdown");
    expect(captured.props?.options?.readOnly).toBe(true);
    expect(captured.props?.options?.renderSideBySide).toBe(true);
    expect(captured.props?.options?.ignoreTrimWhitespace).toBe(true);
    expect(captured.props?.options?.hideUnchangedRegions?.enabled).toBe(true);
  });

  it("supports a unified diff without ignoring whitespace", async () => {
    render(
      <PrivateFundMemoDiffViewer
        after="new"
        before="old"
        hideWhitespace={false}
        layout="unified"
      />,
    );

    await waitFor(() => expect(captured.props).not.toBeNull());
    expect(captured.props?.options?.renderSideBySide).toBe(false);
    expect(captured.props?.options?.ignoreTrimWhitespace).toBe(false);
  });
});
