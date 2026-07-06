"""FastAPI web surface for the PDF research demo."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

from .demo import ChatClient, MemoDraft, PdfResearchDemo, QaResult
from .llm import OpenAICompatibleChatClient, load_llm_config
from .memo_pdf import render_memo_pdf
from .models import Citation


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PDF_PATH = PROJECT_ROOT / "tesla_extracted/20260129_10-K_0001628280-26-003952.pdf"
DEFAULT_TEXT_PATH = PROJECT_ROOT / "tmp/pdfs/tesla_text/20260129_10-K_0001628280-26-003952.txt"


class AskRequest(BaseModel):
    question: str


class MemoRequest(BaseModel):
    company_name: str | None = None
    ticker: str | None = None


def _jsonable(value: Any) -> Any:
    if hasattr(value, "to_dict"):
        return _jsonable(value.to_dict())
    if is_dataclass(value):
        return _jsonable(asdict(value))
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    return value


def _trace_payload(demo: PdfResearchDemo, citations: list[Citation]) -> list[dict[str, Any]]:
    return [_jsonable(demo.trace_citation(citation.citation_id)) for citation in citations]


def _qa_payload(demo: PdfResearchDemo, result: QaResult) -> dict[str, Any]:
    citations = result.citations
    return {
        "question": result.question,
        "answer": result.answer,
        "needs_review": result.needs_review,
        "llm_used": result.llm_used,
        "llm_error": result.llm_error,
        "citations": _jsonable(citations),
        "traces": _trace_payload(demo, citations),
    }


def _memo_payload(demo: PdfResearchDemo, memo: MemoDraft) -> dict[str, Any]:
    citations = memo.citations
    return {
        "memo_id": memo.memo_id,
        "title": memo.title,
        "markdown": memo.to_markdown(),
        "sections": _jsonable(memo.sections),
        "llm_used": memo.llm_used,
        "llm_error": memo.llm_error,
        "citations": _jsonable(citations),
        "traces": _trace_payload(demo, citations),
    }


def _memo_pdf_payload(payload: dict[str, Any], memo_id: str, pdf_path: Path) -> dict[str, Any]:
    payload["pdf_path"] = str(pdf_path)
    payload["pdf_url"] = f"/api/memo/{memo_id}/pdf"
    return payload


def create_app(
    pdf_path: str | Path = DEFAULT_PDF_PATH,
    text_path: str | Path | None = None,
    *,
    company_name: str = "Tesla, Inc.",
    ticker: str = "TSLA",
    use_llm: bool = False,
    llm_config_path: str | Path | None = None,
    llm_client: ChatClient | None = None,
) -> FastAPI:
    """Create the local web app and ingest the selected PDF once at startup."""

    llm_config = None
    active_llm_client = llm_client
    if active_llm_client is None and use_llm:
        llm_config = load_llm_config(llm_config_path)
        if llm_config:
            active_llm_client = OpenAICompatibleChatClient(llm_config)

    demo = PdfResearchDemo(llm_client=active_llm_client)
    document = demo.ingest_pdf(pdf_path, text_path)

    app = FastAPI(title="PDF Research Demo", version="0.1.0")
    app.state.demo = demo
    app.state.document = document
    app.state.company_name = company_name
    app.state.ticker = ticker
    app.state.llm_config = llm_config
    app.state.llm_enabled = active_llm_client is not None
    app.state.memo_pdfs = {}

    @app.get("/", response_class=HTMLResponse)
    def index() -> HTMLResponse:
        return HTMLResponse(INDEX_HTML)

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "company_name": app.state.company_name,
            "ticker": app.state.ticker,
            "document": app.state.document.to_dict(),
            "evidence_count": len(app.state.demo.store.evidence),
            "citation_count": len(app.state.demo.store.citations),
            "memo_pdf_count": len(app.state.memo_pdfs),
            "llm": (
                app.state.llm_config.safe_summary()
                if app.state.llm_config
                else {"enabled": app.state.llm_enabled, "model_name": "custom" if app.state.llm_enabled else ""}
            ),
        }

    @app.post("/api/ask")
    def ask(request: AskRequest) -> dict[str, Any]:
        question = request.question.strip()
        if not question:
            raise HTTPException(status_code=400, detail="Question is required.")
        return _qa_payload(app.state.demo, app.state.demo.answer_question(question))

    @app.post("/api/memo")
    def memo(request: MemoRequest | None = None) -> dict[str, Any]:
        active_company = (request.company_name if request and request.company_name else app.state.company_name).strip()
        active_ticker = (request.ticker if request and request.ticker else app.state.ticker).strip()
        if not active_company or not active_ticker:
            raise HTTPException(status_code=400, detail="Company name and ticker are required.")
        memo_draft = app.state.demo.generate_memo(active_company, active_ticker)
        pdf_path = render_memo_pdf(memo_draft)
        app.state.memo_pdfs[memo_draft.memo_id] = pdf_path
        return _memo_pdf_payload(_memo_payload(app.state.demo, memo_draft), memo_draft.memo_id, pdf_path)

    @app.get("/api/memo/{memo_id}/pdf")
    def memo_pdf(memo_id: str) -> FileResponse:
        pdf_path = app.state.memo_pdfs.get(memo_id)
        if pdf_path is None or not Path(pdf_path).is_file():
            raise HTTPException(status_code=404, detail="Memo PDF not found.")
        return FileResponse(
            pdf_path,
            media_type="application/pdf",
            filename=Path(pdf_path).name,
        )

    @app.get("/api/trace/{citation_id}")
    def trace(citation_id: str) -> dict[str, Any]:
        trace_result = app.state.demo.trace_citation(citation_id)
        if not trace_result:
            raise HTTPException(status_code=404, detail="Citation not found.")
        return _jsonable(trace_result)

    return app


INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PDF Evidence Workbench</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
      --panel: #ffffff;
      --ink: #17202a;
      --muted: #66707a;
      --line: #d9e0e5;
      --accent: #146b5f;
      --accent-strong: #0f5148;
      --warn: #936216;
      --trace: #244b7a;
      --soft: #eef4f2;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }

    button,
    input,
    textarea {
      font: inherit;
    }

    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      border-radius: 6px;
      cursor: pointer;
      min-height: 38px;
      padding: 0 14px;
      white-space: nowrap;
    }

    button:hover { background: var(--accent-strong); }
    button:disabled { cursor: wait; opacity: 0.6; }

    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }

    header {
      border-bottom: 1px solid var(--line);
      background: #fff;
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }

    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
      font-weight: 700;
    }

    .meta {
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      font-size: 13px;
    }

    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--warn);
      flex: none;
    }

    .status-dot.ok { background: var(--accent); }

    main {
      display: grid;
      grid-template-columns: minmax(250px, 0.8fr) minmax(360px, 1.4fr) minmax(300px, 1fr);
      gap: 1px;
      background: var(--line);
      min-height: 0;
    }

    .panel {
      background: var(--panel);
      min-width: 0;
      min-height: 0;
      padding: 18px;
      overflow: auto;
    }

    .panel h2 {
      margin: 0 0 12px;
      font-size: 15px;
      line-height: 1.2;
    }

    .label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 6px;
      text-transform: uppercase;
    }

    .field {
      margin-bottom: 16px;
    }

    .path,
    .small {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    textarea {
      width: 100%;
      min-height: 104px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 11px 12px;
      color: var(--ink);
      background: #fff;
      line-height: 1.45;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .answer,
    .trace-box,
    .memo {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fbfcfc;
      padding: 14px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }

    .answer {
      min-height: 132px;
      margin-top: 16px;
    }

    .memo {
      white-space: pre-wrap;
      min-height: 300px;
      max-height: 54vh;
      overflow: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
    }

    .citation-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .citation {
      min-height: 30px;
      padding: 0 10px;
      border: 1px solid #b9c9dc;
      background: #f2f6fb;
      color: var(--trace);
      border-radius: 999px;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .citation:hover {
      background: #e5edf8;
      color: #173b63;
    }

    .trace-list {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }

    .trace-item {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 6px;
      padding: 10px;
      text-align: left;
      color: var(--ink);
      min-height: 0;
      white-space: normal;
    }

    .trace-item:hover {
      background: var(--soft);
    }

    .trace-id {
      display: block;
      color: var(--trace);
      font-size: 12px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .trace-display {
      display: block;
      color: var(--muted);
      margin-top: 4px;
      font-size: 12px;
      line-height: 1.4;
    }

    .trace-box {
      margin-top: 16px;
      min-height: 180px;
    }

    .quote {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--line);
      color: var(--ink);
    }

    .warning {
      color: var(--warn);
      font-weight: 700;
    }

    @media (max-width: 1100px) {
      main {
        grid-template-columns: 1fr;
      }
      .memo {
        max-height: none;
      }
    }

    @media (max-width: 640px) {
      header {
        align-items: flex-start;
        flex-direction: column;
      }
      .panel {
        padding: 14px;
      }
      button {
        width: 100%;
      }
      .citation {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <h1>PDF Evidence Workbench</h1>
      <div class="meta">
        <span id="statusDot" class="status-dot"></span>
        <span id="statusText">Starting</span>
      </div>
    </header>
    <main>
      <section class="panel" aria-label="Document">
        <h2>Document</h2>
        <div class="field">
          <span class="label">Company</span>
          <div id="company" class="small">-</div>
        </div>
        <div class="field">
          <span class="label">PDF</span>
          <div id="documentName" class="small">-</div>
          <div id="documentPath" class="path"></div>
        </div>
        <div class="field">
          <span class="label">Evidence</span>
          <div id="evidenceCount" class="small">-</div>
        </div>
        <div class="field">
          <span class="label">LLM</span>
          <div id="llmStatus" class="small">-</div>
        </div>
        <div class="field">
          <button id="memoButton" type="button">Generate Memo</button>
        </div>
        <pre id="memoOutput" class="memo"></pre>
      </section>

      <section class="panel" aria-label="Question Answering">
        <h2>Question</h2>
        <form id="askForm">
          <textarea id="question" name="question">What does Tesla say about Robotaxi and FSD?</textarea>
          <div class="row">
            <button id="askButton" type="submit">Ask</button>
            <span id="qaState" class="small"></span>
          </div>
        </form>
        <div id="answer" class="answer"></div>
        <div id="answerCitations" class="citation-list"></div>
      </section>

      <section class="panel" aria-label="Provenance">
        <h2>Provenance</h2>
        <div id="traceList" class="trace-list"></div>
        <div id="traceBox" class="trace-box">
          <div class="small">Select a citation.</div>
        </div>
      </section>
    </main>
  </div>
  <script>
    const state = {
      traces: new Map(),
      activeCitationId: null
    };

    const $ = (id) => document.getElementById(id);

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function setBusy(button, busy) {
      button.disabled = busy;
    }

    async function api(path, options = {}) {
      const response = await fetch(path, options);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || response.statusText);
      }
      return data;
    }

    function addTraces(traces) {
      for (const trace of traces || []) {
        if (trace && trace.citation && trace.citation.citation_id) {
          state.traces.set(trace.citation.citation_id, trace);
        }
      }
      renderTraceList();
    }

    function renderTraceList() {
      const traces = Array.from(state.traces.values());
      $("traceList").innerHTML = traces.map((trace) => {
        const citation = trace.citation || {};
        const location = trace.location || {};
        return `
          <button class="trace-item" type="button" data-citation-id="${escapeHtml(citation.citation_id)}">
            <span class="trace-id">${escapeHtml(citation.citation_id)}</span>
            <span class="trace-display">${escapeHtml(location.file_name || citation.display || "")}</span>
          </button>
        `;
      }).join("");
    }

    function renderCitationButtons(targetId, citations) {
      $(targetId).innerHTML = (citations || []).map((citation) => `
        <button class="citation" type="button" data-citation-id="${escapeHtml(citation.citation_id)}">
          ${escapeHtml(citation.citation_id)}
        </button>
      `).join("");
    }

    function renderTrace(trace) {
      const citation = trace.citation || {};
      const evidence = trace.evidence || {};
      const documentInfo = trace.document || {};
      const version = trace.version || {};
      const location = trace.location || {};
      $("traceBox").innerHTML = `
        <div><span class="label">Citation</span><div class="path">${escapeHtml(citation.citation_id || "")}</div></div>
        <div class="field"><span class="label">Location</span><div>${escapeHtml(location.file_name || documentInfo.file_name || "")}, p.${escapeHtml(location.page_no || "")}, paragraph ${escapeHtml(location.paragraph_no || "")}</div></div>
        <div class="field"><span class="label">Original File</span><div class="path">${escapeHtml(trace.original_file || documentInfo.file_path || "")}</div></div>
        <div class="field"><span class="label">Version</span><div class="path">${escapeHtml(version.version_id || "")}</div><div class="path">${escapeHtml(version.checksum || "")}</div></div>
        <div class="field"><span class="label">Claim</span><div>${escapeHtml(citation.claim || "")}</div></div>
        <div class="quote">${escapeHtml(evidence.content_text || citation.quote || "")}</div>
      `;
    }

    async function showTrace(citationId) {
      if (!citationId) return;
      state.activeCitationId = citationId;
      let trace = state.traces.get(citationId);
      if (!trace) {
        trace = await api(`/api/trace/${encodeURIComponent(citationId)}`);
        addTraces([trace]);
      }
      renderTrace(trace);
    }

    async function loadHealth() {
      const health = await api("/api/health");
      $("statusDot").classList.add("ok");
      $("statusText").textContent = "Ready";
      $("company").textContent = `${health.company_name} (${health.ticker})`;
      $("documentName").textContent = health.document.file_name;
      $("documentPath").textContent = health.document.file_path;
      $("evidenceCount").textContent = `${health.evidence_count} evidence units`;
      const llm = health.llm || {};
      $("llmStatus").textContent = llm.enabled ? `${llm.model_name || "custom"} via ${llm.base_url || "injected client"}` : "Disabled";
    }

    $("askForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const question = $("question").value.trim();
      if (!question) return;
      setBusy($("askButton"), true);
      $("qaState").textContent = "Retrieving";
      try {
        const result = await api("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question })
        });
        $("answer").innerHTML = `
          <div>${escapeHtml(result.answer)}</div>
          <div class="small">LLM: ${result.llm_used ? "used" : "not used"}</div>
          ${result.llm_error ? `<div class="warning">${escapeHtml(result.llm_error)}</div>` : ""}
          ${result.needs_review ? '<div class="warning">Needs review</div>' : ''}
        `;
        renderCitationButtons("answerCitations", result.citations);
        addTraces(result.traces);
        if (result.citations && result.citations[0]) {
          await showTrace(result.citations[0].citation_id);
        }
        $("qaState").textContent = "Done";
      } catch (error) {
        $("answer").innerHTML = `<span class="warning">${escapeHtml(error.message)}</span>`;
        $("qaState").textContent = "Failed";
      } finally {
        setBusy($("askButton"), false);
      }
    });

    $("memoButton").addEventListener("click", async () => {
      setBusy($("memoButton"), true);
      $("memoOutput").textContent = "Generating...";
      try {
        const result = await api("/api/memo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        const pdfLine = result.pdf_url ? `\nPDF: ${result.pdf_url}` : "";
        $("memoOutput").textContent = `${result.markdown}\nLLM: ${result.llm_used ? "used" : "not used"}${result.llm_error ? `\nLLM error: ${result.llm_error}` : ""}${pdfLine}`;
        addTraces(result.traces);
        if (result.citations && result.citations[0]) {
          await showTrace(result.citations[0].citation_id);
        }
      } catch (error) {
        $("memoOutput").textContent = error.message;
      } finally {
        setBusy($("memoButton"), false);
      }
    });

    document.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-citation-id]");
      if (!target) return;
      await showTrace(target.dataset.citationId);
    });

    loadHealth().catch((error) => {
      $("statusText").textContent = error.message;
    });
  </script>
</body>
</html>
"""
