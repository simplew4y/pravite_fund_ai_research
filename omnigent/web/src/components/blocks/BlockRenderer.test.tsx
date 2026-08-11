// BlockRenderer dispatch wiring. The kind→component switch is easy
// to break by removing a case — neither the walker nor the
// individual card tests catch that. Drive it directly here.

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderItem } from "@/lib/renderItems";
import { FileViewerContext } from "@/shell/FileViewerContext";
import { prepareAssistantHtmlPreviewDoc, splitAssistantHtml } from "./AssistantHtmlPreview";
import { BlockRenderer } from "./BlockRenderer";

afterEach(cleanup);

const FILE_VIEWER_NOOP = {
  openFile: () => {},
  isChangedPath: () => false,
  conversationId: undefined,
  workspaceRoot: null,
  workspaceHome: null,
};

describe("BlockRenderer dispatch", () => {
  it("collapses the post-compaction plan while keeping the final answer visible", () => {
    const items: RenderItem[] = [
      {
        kind: "text",
        itemId: "plan",
        text: "I will repeat the previous operation.",
        final: true,
      },
      {
        kind: "text",
        itemId: "final",
        text: "最终回答",
        final: true,
      },
    ];

    render(
      <BlockRenderer items={items} sessionStatus="idle" collapsePostCompactionActivity={true} />,
    );

    const trigger = screen.getByText("压缩后的计划");
    expect(screen.queryByText("I will repeat the previous operation.")).toBeNull();
    expect(screen.getByText("最终回答")).toBeDefined();

    fireEvent.click(trigger);
    expect(screen.getByText("I will repeat the previous operation.")).toBeDefined();
  });

  it("renders a slash_command RenderItem via SlashCommandCard", () => {
    const items: RenderItem[] = [
      {
        kind: "slash_command",
        itemId: "sc_1",
        slashKind: "skill",
        name: "dev-productivity:simplify",
        arguments: "",
        output: null,
      },
    ];
    render(<BlockRenderer items={items} sessionStatus="idle" />);
    expect(screen.getByText("Skill")).toBeDefined();
    expect(screen.getByText("dev-productivity:simplify")).toBeDefined();
  });

  it("passes slashKind='command' through to the card prefix", () => {
    // Guards against the dispatch dropping the slashKind→kind prop;
    // removing the kind={item.slashKind} prop on the card would make
    // SlashCommandCard's destructure throw at render time.
    const items: RenderItem[] = [
      {
        kind: "slash_command",
        itemId: "sc_2",
        slashKind: "command",
        name: "effort",
        arguments: "high",
        output: null,
      },
    ];
    render(<BlockRenderer items={items} sessionStatus="idle" />);
    expect(screen.getByText("Command")).toBeDefined();
    expect(screen.getByText("effort")).toBeDefined();
  });

  it("renders a terminal_command input RenderItem via TerminalCommandCard", () => {
    const items: RenderItem[] = [
      {
        kind: "terminal_command",
        itemId: "tc_1",
        terminalKind: "input",
        input: "pwd",
        stdout: null,
        stderr: null,
      },
    ];
    render(<BlockRenderer items={items} sessionStatus="idle" />);
    const card = screen.getByTestId("terminal-command-card");
    expect(card.getAttribute("data-terminal-kind")).toBe("input");
    expect(screen.getByText("pwd")).toBeDefined();
  });

  it("renders a terminal_command output RenderItem via TerminalCommandCard", () => {
    const items: RenderItem[] = [
      {
        kind: "terminal_command",
        itemId: "tc_2",
        terminalKind: "output",
        input: null,
        stdout: "/home/user",
        stderr: "",
      },
    ];
    render(<BlockRenderer items={items} sessionStatus="idle" />);
    const card = screen.getByTestId("terminal-command-card");
    expect(card.getAttribute("data-terminal-kind")).toBe("output");
  });

  it("renders error diagnostics with local wrapping and preserved line breaks", () => {
    const message = [
      "Required terminal exited unexpectedly; the session runtime is no longer available.",
      "Lifecycle diagnostics:",
      "terminal: required-runtime:main",
      "command: runtime-worker (10 args; argv omitted because terminal args may contain secrets)",
      "cwd: /workspace/project",
      "last captured output:",
      "  - first diagnostic line",
      "  - second diagnostic line",
    ].join("\n");
    const items: RenderItem[] = [
      {
        kind: "error",
        itemId: null,
        source: "",
        code: "required_terminal_exited",
        message,
      },
    ];

    const { container } = render(<BlockRenderer items={items} sessionStatus="idle" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("min-w-0");
    expect(alert).toHaveClass("overflow-hidden");

    const description = container.querySelector('[data-slot="alert-description"]');
    expect(description).not.toBeNull();
    expect(description).toHaveClass("min-w-0");
    expect(description).toHaveClass("overflow-hidden");

    const messageNode = screen.getByText(/Required terminal exited unexpectedly/);
    expect(messageNode).toHaveClass("whitespace-pre-wrap");
    expect(messageNode).toHaveClass("break-words");
    expect(messageNode.textContent).toContain(
      "Lifecycle diagnostics:\nterminal: required-runtime:main",
    );
    expect(messageNode.textContent).toContain(
      "  - first diagnostic line\n  - second diagnostic line",
    );
  });

  it("treats a trailing reasoning item as streaming when sessionStatus is running", () => {
    const items: RenderItem[] = [
      { kind: "reasoning", itemId: null, text: "thinking", duration: undefined },
    ];
    render(<BlockRenderer items={items} sessionStatus="running" />);
    expect(screen.getByText("Thinking...")).toBeDefined();
  });

  it("does NOT treat a reasoning item as streaming when sessionStatus is idle", () => {
    const items: RenderItem[] = [
      { kind: "reasoning", itemId: null, text: "thinking", duration: undefined },
    ];
    render(<BlockRenderer items={items} sessionStatus="idle" />);
    expect(screen.queryByText("Thinking...")).toBeNull();
  });

  it("does NOT treat reasoning as streaming once a text item follows it", () => {
    const items: RenderItem[] = [
      { kind: "reasoning", itemId: null, text: "thinking", duration: undefined },
      { kind: "text", itemId: "t1", text: "hello", final: false },
    ];
    render(<BlockRenderer items={items} sessionStatus="running" />);
    expect(screen.queryByText("Thinking...")).toBeNull();
  });

  it("adds subtle separation between adjacent assistant text items", async () => {
    const items: RenderItem[] = [
      { kind: "text", itemId: "t1", text: "First message.", final: true },
      { kind: "text", itemId: "t2", text: "Second **markdown** message.", final: true },
    ];

    const { container } = render(
      <FileViewerContext.Provider value={FILE_VIEWER_NOOP}>
        <BlockRenderer items={items} sessionStatus="idle" />
      </FileViewerContext.Provider>,
    );

    const sections = container.querySelectorAll<HTMLElement>(
      '[data-testid="assistant-text-section"]',
    );
    expect(sections).toHaveLength(2);
    expect(sections[0]!).not.toHaveClass("mt-2");
    expect(sections[1]!).toHaveClass("mt-2");
    expect(screen.getByText("First message.")).toBeDefined();
    expect(screen.getByText(/Second/)).toBeDefined();

    const strong = await screen.findByText("markdown", {
      selector: '[data-streamdown="strong"]',
    });
    expect(sections[1]!.contains(strong)).toBe(true);
  });

  it("does not add adjacent-text spacing across tool items", () => {
    const items: RenderItem[] = [
      { kind: "text", itemId: "t1", text: "Before tool.", final: true },
      {
        kind: "tool",
        itemId: "fc_1",
        execution: {
          name: "read_file",
          arguments: {},
          argsSummary: "",
          callId: "call_1",
          agentName: "test",
          executedBy: "server",
          output: "ok",
        },
        output: "ok",
        state: "output-available",
        startedAt: null,
        duration: undefined,
      },
      { kind: "text", itemId: "t2", text: "After tool.", final: true },
    ];

    const { container } = render(
      <FileViewerContext.Provider value={FILE_VIEWER_NOOP}>
        <BlockRenderer items={items} sessionStatus="idle" />
      </FileViewerContext.Provider>,
    );

    const sections = container.querySelectorAll<HTMLElement>(
      '[data-testid="assistant-text-section"]',
    );
    expect(sections).toHaveLength(2);
    expect(sections[0]!).not.toHaveClass("mt-2");
    expect(sections[1]!).not.toHaveClass("mt-2");
  });

  it("'See N steps' counts the whole tool run, including the streaming tail", () => {
    // While streaming, the most-recent tools render as a visible tail
    // OUTSIDE the fold. The "See N steps" label must count the whole run
    // (5), not just the folded part — else it reads "See 2 steps" with 3
    // more tool cards visible below (the reported miscount).
    const tool = (n: number): RenderItem => ({
      kind: "tool",
      itemId: `fc_${n}`,
      execution: {
        name: `tool_${n}`,
        arguments: {},
        argsSummary: "",
        callId: `c_${n}`,
        agentName: "nessie",
        executedBy: "server",
        output: "ok",
      },
      output: "ok",
      state: "output-available",
      startedAt: null,
      duration: undefined,
    });
    const items: RenderItem[] = [
      { kind: "text", itemId: "m0", text: "Dispatching.", final: true },
      tool(1),
      tool(2),
      tool(3),
      tool(4),
      tool(5),
    ];
    render(<BlockRenderer items={items} sessionStatus="running" />);
    expect(screen.getByText("See 5 steps")).toBeDefined();
    expect(screen.queryByText("See 2 steps")).toBeNull();
    // The label counts the WHOLE run, but the recent tools must still be
    // visible as a tail OUTSIDE the collapsed group — the most-recent tool
    // renders (the collapsed group's content is unmounted), while an older
    // one stays folded. Guards against a regression that folds everything
    // (the count would still read 5, but the live tail would vanish).
    expect(screen.getByText(/tool_5/)).toBeDefined();
    expect(screen.queryByText(/tool_1/)).toBeNull();
  });

  // Proves the markdown throttle is actually wired into the render path (not
  // just unit-tested in isolation): a regression that drops `useThrottledValue`
  // from `FilePathAwareMessageResponse` would let the live bubble re-parse on
  // every commit, turning the "not yet CHARLIE" assertion red.
  describe("streaming markdown throttle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // A streaming text item (itemId null → stable `text:<index>` key, so the
    // same throttle instance persists across re-renders as the text grows).
    const streamingText = (text: string): RenderItem[] => [
      { kind: "text", itemId: null, text, final: false },
    ];
    const renderStreaming = (text: string) => (
      <FileViewerContext.Provider value={FILE_VIEWER_NOOP}>
        <BlockRenderer items={streamingText(text)} sessionStatus="running" />
      </FileViewerContext.Provider>
    );

    it("defers re-parse of a within-window change, then converges to the latest", () => {
      const { rerender, container } = render(renderStreaming("ALPHA"));
      expect(container.textContent).toContain("ALPHA");

      // First change after mount emits immediately (snappy first-token paint).
      act(() => {
        rerender(renderStreaming("ALPHA BRAVO"));
      });
      expect(container.textContent).toContain("BRAVO");

      // A further change within the throttle window must NOT re-parse yet —
      // this is the assertion that fails if the throttle is removed (the bubble
      // would re-parse on the commit and show CHARLIE immediately).
      act(() => {
        rerender(renderStreaming("ALPHA BRAVO CHARLIE"));
        vi.advanceTimersByTime(20);
      });
      expect(container.textContent).toContain("BRAVO");
      expect(container.textContent).not.toContain("CHARLIE");

      // Past the window → the trailing flush re-parses with the latest text.
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(container.textContent).toContain("CHARLIE");
    });
  });

  // A text block carrying a ~50KB unbroken base64 data URL (an
  // image block accidentally serialized into the text stream) froze the tab —
  // the full markdown pipeline parsed it and the browser tried to lay out one
  // unbreakable ~50K-char line. The renderer now routes a pathological block to
  // a plain, break-anywhere fallback that bypasses markdown.
  describe("pathological text guard", () => {
    const renderText = (text: string) =>
      render(
        <FileViewerContext.Provider value={FILE_VIEWER_NOOP}>
          <BlockRenderer
            items={[{ kind: "text", itemId: "t1", text, final: true }]}
            sessionStatus="idle"
          />
        </FileViewerContext.Provider>,
      );

    it("renders a giant unbroken token via the break-anywhere fallback", () => {
      // A long base64-ish token with no whitespace — exactly the freezing
      // blob shape. It must land in the plain fallback (a `break-all` element), not
      // the markdown pipeline, so the layout engine has break opportunities.
      const blob = `data:image/png;base64,${"A".repeat(10_000)}`;
      const { container } = renderText(blob);

      const el = container.querySelector(".break-all");
      expect(el).not.toBeNull();
      // The text is shown in full (under the 200K display cap) — no elision.
      expect(el!.textContent).toContain(blob);
      expect(el!.textContent).not.toContain("more characters not shown");
    });

    it("elides a payload past the plaintext display cap", () => {
      // 250K is chosen to sit above the 200K MAX_PLAINTEXT_DISPLAY_LENGTH cap so
      // it exercises the elision path: the DOM node must not grow without bound,
      // so the tail past 200K is dropped and an elision marker appended.
      const blob = "x".repeat(250_000);
      const { container } = renderText(blob);

      const el = container.querySelector(".break-all");
      expect(el).not.toBeNull();
      expect(el!.textContent).toContain("more characters not shown");
      // Painted text is 200K shown + a short marker — strictly less than the
      // full 250K input. A regression that dropped the cap would render all 250K.
      expect(el!.textContent!.length).toBeLessThan(250_000);
    });

    it("leaves normal prose on the markdown path (no fallback)", async () => {
      // A short, whitespace-broken string is NOT pathological — it must still
      // flow through markdown. The `**bold**` proves it: Streamdown renders the
      // emphasis as a `data-streamdown="strong"` span, which the plain break-all
      // fallback never would. So this fails both if the fallback wrongly fires
      // AND if the guard somehow routed normal prose to plaintext.
      const { container } = renderText("This is a **perfectly** normal message.");

      expect(container.querySelector(".break-all")).toBeNull();
      // Wait for Streamdown to parse the markdown, then confirm the emphasis
      // became its strong span (proving the markdown path actually ran).
      const strong = await screen.findByText("perfectly", {
        selector: '[data-streamdown="strong"]',
      });
      expect(strong).not.toBeNull();
    });
  });

  it("renders fenced code blocks inside a <pre> wrapper", async () => {
    // Regression: the file-path-aware override used to live in Streamdown's
    // `code` slot, which fires for both inline AND fenced blocks. The block
    // fallback returned a bare <code>, stripping the <pre> wrapper and
    // collapsing whitespace. The override now lives in the `inlineCode`
    // slot so fenced blocks keep Streamdown's default rendering.
    const items: RenderItem[] = [
      {
        kind: "text",
        itemId: "t1",
        text: "Here is some code:\n\n```python\ndef foo():\n    return 1\n```\n",
        final: true,
      },
    ];
    render(
      <FileViewerContext.Provider value={FILE_VIEWER_NOOP}>
        <BlockRenderer items={items} sessionStatus="idle" />
      </FileViewerContext.Provider>,
    );
    // Wait for Streamdown to finish parsing the (streamed) markdown.
    const pre = await screen.findByText(/def foo/, { selector: "pre, pre *" });
    expect(pre.closest("pre")).not.toBeNull();
  });

  describe("assistant HTML previews", () => {
    const renderAssistantText = (text: string) =>
      render(
        <FileViewerContext.Provider value={FILE_VIEWER_NOOP}>
          <BlockRenderer
            items={[{ kind: "text", itemId: "html_1", text, final: true }]}
            sessionStatus="idle"
          />
        </FileViewerContext.Provider>,
      );

    it("renders an unfenced complete HTML document after explanatory prose", () => {
      renderAssistantText(
        [
          "I created a financial comparison.",
          "",
          "html",
          "",
          "<!DOCTYPE html>",
          '<html lang="en"><head><style>h1{color:red}</style></head>',
          "<body><h1>Financial Metrics Comparison</h1></body></html>",
        ].join("\n"),
      );

      expect(screen.getByText("I created a financial comparison.")).toBeInTheDocument();
      const frame = screen.getByTitle("Agent-generated HTML preview");
      expect(frame).toHaveAttribute("sandbox", "allow-scripts");
      expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
      expect(frame.getAttribute("srcdoc")).toContain("Financial Metrics Comparison");
      expect(frame.getAttribute("srcdoc")).toContain("connect-src 'none'");
      expect(frame.getAttribute("srcdoc")).toContain("h1{color:red}");
      expect(screen.queryByText(/^html$/i)).toBeNull();
    });

    it("renders an explicit html fence but leaves non-html fences as code", async () => {
      const htmlParts = splitAssistantHtml(
        "Before\n\n```html\n<section><strong>Rendered card</strong></section>\n```\n\nAfter",
      );
      expect(htmlParts).toEqual([
        { kind: "markdown", content: "Before" },
        { kind: "html", content: "<section><strong>Rendered card</strong></section>" },
        { kind: "markdown", content: "After" },
      ]);

      renderAssistantText("```text\n<!DOCTYPE html><html><body>Source example</body></html>\n```");
      expect(screen.queryByTitle("Agent-generated HTML preview")).toBeNull();
      const pre = await screen.findByText(/Source example/, { selector: "pre, pre *" });
      expect(pre.closest("pre")).not.toBeNull();
    });

    it("waits for a complete closing html tag before promoting streamed output", () => {
      renderAssistantText("html\n<!DOCTYPE html><html><body><h1>Still streaming</h1>");
      expect(screen.queryByTitle("Agent-generated HTML preview")).toBeNull();
    });

    it("removes refresh navigation while retaining inline scripts and styles", () => {
      const doc = prepareAssistantHtmlPreviewDoc(
        '<html><head><meta http-equiv="refresh" content="0; url=https://example.com">' +
          "<style>.chart{height:10px}</style></head><body>" +
          "<script>document.body.dataset.ready='yes'</script></body></html>",
      );

      expect(doc).not.toContain('http-equiv="refresh"');
      expect(doc).toContain(".chart{height:10px}");
      expect(doc).toContain("document.body.dataset.ready='yes'");
      expect(doc).toContain("default-src 'none'");
    });
  });
});

// ── Inline file-path linkification ───────────────────────────────────────────
//
// Inline-code spans that name a real workspace file become clickable links
// that open the FileViewer. Coverage was previously gated on the agent
// *changed-files* list, so a file the agent only *referenced* (present on
// disk but not modified this session) rendered as inert code. These tests
// pin the broader rule: any path-shaped span pointing at a file that exists
// in the workspace is linkified, verified against the runner filesystem API.

const EXISTING_PATH = "projects/dais-2026-outlines/foo.md";
const EXISTING_PARENT = "projects/dais-2026-outlines";

function dirListingResponse(parent: string, names: string[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      object: "list",
      data: names.map((name) => ({
        id: `${parent}/${name}`,
        name,
        path: `${parent}/${name}`,
        type: "file",
        bytes: 10,
        modified_at: 1,
      })),
      has_more: false,
    }),
  } as unknown as Response;
}

/** Root-directory listing: entries carry bare-basename paths (no parent). */
function rootListingResponse(names: string[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      object: "list",
      data: names.map((name) => ({
        id: name,
        name,
        path: name,
        type: "file",
        bytes: 10,
        modified_at: 1,
      })),
      has_more: false,
    }),
  } as unknown as Response;
}

const NOT_FOUND_RESPONSE = {
  ok: false,
  status: 404,
  statusText: "Not Found",
  json: async () => ({ error: { code: "not_found" } }),
} as unknown as Response;

function renderMessage(
  text: string,
  ctx: {
    openFile: (path: string) => void;
    openPdfSource?: (source: {
      kind?: "pdf" | "excel";
      pageNo?: number;
      pageEnd?: number;
      quote?: string;
      label?: string;
      pdfName?: string;
      workbookName?: string;
      sheetName?: string;
      rangeRef?: string;
    }) => void;
    isChangedPath: (path: string) => boolean;
    conversationId: string | undefined;
    workspaceRoot?: string | null;
    workspaceHome?: string | null;
  },
) {
  const fullCtx = {
    workspaceRoot: null,
    workspaceHome: null,
    ...ctx,
  };
  const items: RenderItem[] = [{ kind: "text", itemId: "t1", text, final: true }];
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  function Wrap({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <FileViewerContext.Provider value={fullCtx}>{children}</FileViewerContext.Provider>
      </QueryClientProvider>
    );
  }
  return render(
    <Wrap>
      <BlockRenderer items={items} sessionStatus="idle" />
    </Wrap>,
  );
}

describe("BlockRenderer PDF source citations", () => {
  const sourceFetch = vi.fn();

  beforeEach(() => {
    sourceFetch.mockReset();
    sourceFetch.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes("/excel/")
        ? {
            kind: "excel",
            mode: "range",
            file_name: "300274 v44.xlsx",
            stored_path: "/raw/300274 v44.xlsx",
            range_ref: "A1:K33",
            sheet: { sheet_name: "Table", used_range: "A1:K33", summary: null },
            cells: [
              {
                cell_ref: "A1",
                row_index: 1,
                col_index: 1,
                display_value: "营业收入",
                raw_value: "营业收入",
                formula: null,
              },
            ],
          }
        : {
            page_no: 3,
            file_name: "阳光电源300274近况交流会260701_原文.pdf",
            image_url: "/v1/private-fund/pdf/source/page-image?page_no=3",
            highlights: [],
            matched: false,
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", sourceFetch);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("opens an anchored original-document popover for an attached Chinese PDF citation", async () => {
    renderMessage(
      '反对过度强调网络安全问题，造成"喧宾夺主"的情况阳光电源300274近况交流会260701_原文.pdf p.3。',
      {
        openFile: vi.fn(),
        isChangedPath: () => false,
        conversationId: "conv_1",
      },
    );

    const citation = await screen.findByRole("link", { name: "来源 p.3" });
    expect(citation).toHaveAttribute("title", "点击查看原始文档");
    fireEvent.click(citation);

    expect(await screen.findByText("原始文档")).toBeInTheDocument();
    await waitFor(() =>
      expect(sourceFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/private-fund/pdf/source/page?page_no=3"),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.queryByText("Sources")).toBeNull();
  });

  it("keeps an in-flight source request alive while switching to the loading state", async () => {
    let finishRequest!: (response: Response) => void;
    const delayedResponse = new Promise<Response>((resolve) => {
      finishRequest = resolve;
    });
    sourceFetch.mockReturnValueOnce(delayedResponse);

    renderMessage("结论来自（阳光电源-20260615.pdf p.3）。", {
      openFile: vi.fn(),
      isChangedPath: () => false,
      conversationId: "conv_1",
    });

    fireEvent.click(await screen.findByRole("link", { name: "阳光电源-20260615.pdf p.3" }));
    expect(await screen.findByText("正在读取原始文档…")).toBeInTheDocument();
    const signal = sourceFetch.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    finishRequest(
      new Response(
        JSON.stringify({
          page_no: 3,
          file_name: "阳光电源-20260615.pdf",
          image_url: "/v1/private-fund/pdf/source/page-image?page_no=3",
          highlights: [],
          matched: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    expect(
      await screen.findByRole("img", { name: "阳光电源-20260615.pdf 第 3 页" }),
    ).toBeInTheDocument();
  });

  it("closes when the workflow canvas captures and stops an outside pointer event", async () => {
    renderMessage("结论来自（阳光电源-20260615.pdf p.3）。", {
      openFile: vi.fn(),
      isChangedPath: () => false,
      conversationId: "conv_1",
    });
    const canvas = document.createElement("div");
    canvas.dataset.testid = "workflow-canvas";
    canvas.addEventListener("pointerdown", (event) => event.stopPropagation());
    document.body.appendChild(canvas);

    fireEvent.click(await screen.findByRole("link", { name: "阳光电源-20260615.pdf p.3" }));
    expect(await screen.findByText("原始文档")).toBeInTheDocument();
    fireEvent.pointerDown(canvas);

    await waitFor(() => expect(screen.queryByText("原始文档")).toBeNull());
    canvas.remove();
  });

  it("preserves PDF page ranges and filename in the popover request", async () => {
    renderMessage("核心逻辑来自（阳光电源-20260615.pdf p.1-2）。", {
      openFile: vi.fn(),
      isChangedPath: () => false,
      conversationId: "conv_1",
    });

    fireEvent.click(await screen.findByRole("link", { name: "阳光电源-20260615.pdf p.1-2" }));
    await waitFor(() => {
      const url = String(sourceFetch.mock.calls[0]?.[0] ?? "");
      expect(url).toContain("page_no=1");
      expect(url).toContain("pdf_name=%E9%98%B3%E5%85%89%E7%94%B5%E6%BA%90-20260615.pdf");
    });
    expect(screen.getByText(/第 1–2 页/)).toBeInTheDocument();
  });

  it("shows Excel source cells inside the same anchored popover", async () => {
    renderMessage("分业务收入拆解来自（300274 v44.xlsx Table!A1:K33）。", {
      openFile: vi.fn(),
      isChangedPath: () => false,
      conversationId: "conv_1",
    });

    fireEvent.click(await screen.findByRole("link", { name: "300274 v44.xlsx Table!A1:K33" }));
    expect(await screen.findByText("营业收入")).toBeInTheDocument();
    const url = String(sourceFetch.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("/v1/private-fund/excel/source/range?");
    expect(url).toContain("sheet_name=Table");
    expect(url).toContain("range_ref=A1%3AK33");
  });

  it("linkifies every Horizon Robotics range from the reported answer", async () => {
    const workbook = "1783838864110_Horizon+Robotics_9660.HK_2025_Aug_06.xlsx";
    renderMessage(
      [
        `${workbook} Operation!A88:L141`,
        `${workbook} Supply relation!J92:Q130`,
        `${workbook} Supply relation!C72:G84`,
        `${workbook} BS!A1:N146`,
      ].join("\n"),
      {
        openFile: vi.fn(),
        isChangedPath: () => false,
        conversationId: "conv_1",
      },
    );

    expect(
      screen.getByRole("link", { name: `${workbook} Operation!A88:L141` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: `${workbook} Supply relation!J92:Q130` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: `${workbook} Supply relation!C72:G84` }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: `${workbook} BS!A1:N146` }));
    await waitFor(() => {
      const url = String(sourceFetch.mock.calls[0]?.[0] ?? "");
      expect(url).toContain(`workbook_name=${encodeURIComponent(workbook)}`);
      expect(url).toContain("sheet_name=BS");
      expect(url).toContain("range_ref=A1%3AN146");
    });
  });

  it("renders workbook-level Excel citations as a sheet summary", async () => {
    sourceFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          kind: "excel",
          mode: "workbook",
          file_name: "large-model.xlsx",
          stored_path: "/raw/large-model.xlsx",
          sheets: [
            {
              sheet_name: "Operation",
              used_range: "A1:X169",
              non_empty_cell_count: 1386,
              summary: "Operating model",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    renderMessage("工作簿概览：large-model.xlsx", {
      openFile: vi.fn(),
      isChangedPath: () => false,
      conversationId: "conv_1",
    });

    fireEvent.click(await screen.findByRole("link", { name: "large-model.xlsx" }));
    expect(await screen.findByText("Operation")).toBeInTheDocument();
    expect(screen.getByText("A1:X169")).toBeInTheDocument();
    expect(screen.queryByText("引用范围内没有非空单元格。")).toBeNull();
  });

  it("handles absolute source hrefs without navigating away", async () => {
    renderMessage(
      "[p.9](http://127.0.0.1:6767/c/conv_1?view=changed#private-fund-pdf-source?page=9&label=p.9&pdf_name=%E9%98%B3%E5%85%89%E7%94%B5%E6%BA%90300274%E8%BF%91%E5%86%B5%E4%BA%A4%E6%B5%81%E4%BC%9A260701_%E5%8E%9F%E6%96%87.pdf)",
      {
        openFile: vi.fn(),
        isChangedPath: () => false,
        conversationId: "conv_1",
      },
    );

    fireEvent.click(await screen.findByRole("link", { name: "p.9" }));
    await waitFor(() =>
      expect(String(sourceFetch.mock.calls[0]?.[0] ?? "")).toContain("page_no=9"),
    );
    expect(screen.getByText(/第 9 页/)).toBeInTheDocument();
  });
});

describe("BlockRenderer footnote presentation", () => {
  it("keeps footnote content but removes generated back-reference arrows", async () => {
    renderMessage("第一条结论[^1]，第二条结论也使用同一来源[^1]。\n\n[^1]: 来源原文说明", {
      openFile: vi.fn(),
      isChangedPath: () => false,
      conversationId: "conv_1",
    });

    expect(await screen.findByText("来源原文说明")).toBeInTheDocument();
    expect(document.querySelector("[data-footnote-backref]")).toBeNull();
    expect(screen.queryByText(/^↩/)).toBeNull();
  });

  it("removes superscript footnote numbers while keeping the source entry", async () => {
    renderMessage("管理层观点[^7]\n\n[^7]: 第七条来源说明", {
      openFile: vi.fn(),
      isChangedPath: () => false,
      conversationId: "conv_1",
    });

    expect(await screen.findByText("第七条来源说明")).toBeInTheDocument();
    expect(document.querySelector("[data-footnote-ref]")).toBeNull();
    expect(screen.queryByText("7")).toBeNull();
  });
});

describe("BlockRenderer inline file-path linkification", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("linkifies a file that exists in the workspace but was not agent-changed", async () => {
    // Repro for the reported bug: the file is real (present on disk) but not
    // in the changed-files list, so the old changed-files-only gate left it as
    // plain code. It must now resolve via the filesystem existence check.
    fetchMock.mockResolvedValue(dirListingResponse(EXISTING_PARENT, ["foo.md"]));
    const openFile = vi.fn();
    renderMessage(`I added this to \`${EXISTING_PATH}\` already.`, {
      openFile,
      isChangedPath: () => false,
      conversationId: "conv_1",
    });

    // The span becomes a clickable button once the parent-dir listing
    // confirms the file exists. A failure here means the existence check
    // didn't run or didn't linkify a real, unchanged workspace file.
    const link = await screen.findByRole("button", { name: EXISTING_PATH });
    link.click();
    expect(openFile).toHaveBeenCalledWith(EXISTING_PATH);

    // Existence is checked by listing the PARENT directory, not by reading
    // the file content or walking the whole tree.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain(`/filesystem/${EXISTING_PARENT}`);
  });

  it("leaves a path-shaped span as plain code when no such file exists", async () => {
    // Parent dir listing comes back 404 (or without the file) → not a real
    // file → must stay inert code, never a link. Guards against linkifying
    // every path-shaped string.
    fetchMock.mockResolvedValue(NOT_FOUND_RESPONSE);
    const openFile = vi.fn();
    renderMessage("See `projects/ghost/missing.md` for details.", {
      openFile,
      isChangedPath: () => false,
      conversationId: "conv_1",
    });

    // The existence check must have fired (path-shaped) and resolved negative.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const span = await screen.findByText("projects/ghost/missing.md");
    expect(span.tagName).toBe("CODE");
    expect(screen.queryByRole("button", { name: "projects/ghost/missing.md" })).toBeNull();
  });

  it("links an agent-changed file without any filesystem round-trip", async () => {
    // Changed files are known synchronously (and may be uncommitted or
    // deleted), so they must linkify with zero network calls — the fast path.
    const openFile = vi.fn();
    renderMessage("Edited `src/app/main.ts` just now.", {
      openFile,
      isChangedPath: (p) => p === "src/app/main.ts",
      conversationId: "conv_1",
    });

    const link = await screen.findByRole("button", { name: "src/app/main.ts" });
    link.click();
    expect(openFile).toHaveBeenCalledWith("src/app/main.ts");
    // No existence check needed when the path is already a known change.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not treat non-path inline code as a file (no spurious fetch)", async () => {
    // `git status` has whitespace and no directory segment → fails the
    // path-shape heuristic, so no existence request is made and it stays code.
    const openFile = vi.fn();
    renderMessage("Run `git status` to check.", {
      openFile,
      isChangedPath: () => false,
      conversationId: "conv_1",
    });

    const span = await screen.findByText("git status");
    expect(span.tagName).toBe("CODE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("linkifies a '~'-relative path under the workspace root, opening the relative path", async () => {
    // The reported bug: the agent writes `~/ws/foo.md` while the working dir
    // is `~/ws`. With home + root known, this resolves to the root-level file
    // `foo.md` — a bare basename the path-shape heuristic alone would reject.
    // Existence is checked by listing the workspace ROOT (bare /filesystem).
    // Root-level entries carry bare-basename paths (no parent prefix).
    fetchMock.mockResolvedValue(rootListingResponse(["foo.md"]));
    const openFile = vi.fn();
    renderMessage("I wrote `~/ws/foo.md` for you.", {
      openFile,
      isChangedPath: () => false,
      conversationId: "conv_1",
      workspaceRoot: "/home/u/ws",
      workspaceHome: "/home/u",
    });

    // The span shows the original `~/ws/foo.md` text but links to the resolved
    // workspace-relative `foo.md` — failure means tilde-expand/strip-root or
    // the root-level existence check broke.
    const link = await screen.findByRole("button", { name: "~/ws/foo.md" });
    link.click();
    expect(openFile).toHaveBeenCalledWith("foo.md");
    // Parent of a root-level file is the workspace root → bare /filesystem,
    // not /filesystem/<dir>.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/environments/default/filesystem?");
  });

  it("linkifies an absolute path under the workspace root", async () => {
    // Absolute paths were rejected outright before; now an absolute path under
    // the root strips to its relative form and links.
    fetchMock.mockResolvedValue(dirListingResponse("src", ["app.ts"]));
    const openFile = vi.fn();
    renderMessage("See `/home/u/ws/src/app.ts`.", {
      openFile,
      isChangedPath: () => false,
      conversationId: "conv_1",
      workspaceRoot: "/home/u/ws",
      workspaceHome: "/home/u",
    });

    const link = await screen.findByRole("button", { name: "/home/u/ws/src/app.ts" });
    link.click();
    expect(openFile).toHaveBeenCalledWith("src/app.ts");
    expect(fetchMock.mock.calls[0][0]).toContain("/filesystem/src?");
  });

  it("leaves an absolute path OUTSIDE the workspace root as plain code (no fetch)", async () => {
    // `/etc/hosts` is absolute but not under the root → unresolvable → must
    // never linkify, and must not trigger an existence listing.
    const openFile = vi.fn();
    renderMessage("Check `/etc/hosts` on the box.", {
      openFile,
      isChangedPath: () => false,
      conversationId: "conv_1",
      workspaceRoot: "/home/u/ws",
      workspaceHome: "/home/u",
    });

    const span = await screen.findByText("/etc/hosts");
    expect(span.tagName).toBe("CODE");
    expect(screen.queryByRole("button", { name: "/etc/hosts" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
