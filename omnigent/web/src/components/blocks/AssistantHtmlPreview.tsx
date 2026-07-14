import { CodeXmlIcon, ShieldCheckIcon } from "lucide-react";

const MAX_HTML_PREVIEW_LENGTH = 500_000;

const CHAT_HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "media-src data: blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export type AssistantHtmlPart =
  | { kind: "markdown"; content: string }
  | { kind: "html"; content: string };

type HtmlCandidate = {
  start: number;
  end: number;
  content: string;
};

function isRenderableHtml(value: string): boolean {
  return value.length <= MAX_HTML_PREVIEW_LENGTH && /<[a-z][\s\S]*?>/i.test(value);
}

function isInsideMarkdownFence(value: string, offset: number): boolean {
  const lines = value.slice(0, offset).split(/\r?\n/);
  let openFence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    const marker = match[1][0] as "`" | "~";
    if (!openFence) {
      openFence = { marker, length: match[1].length };
    } else if (openFence.marker === marker && match[1].length >= openFence.length) {
      openFence = null;
    }
  }

  return openFence !== null;
}

function findFencedHtml(value: string, from: number): HtmlCandidate | null {
  const fencePattern =
    /(^|\n)([ \t]{0,3})(`{3,}|~{3,})[ \t]*html[ \t]*\r?\n([\s\S]*?)\r?\n\2\3[ \t]*(?=\r?\n|$)/gi;
  fencePattern.lastIndex = from;

  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(value)) !== null) {
    const content = match[4].trim();
    if (!isRenderableHtml(content)) continue;
    const leadingNewlineLength = match[1].length;
    return {
      start: match.index + leadingNewlineLength,
      end: fencePattern.lastIndex,
      content,
    };
  }
  return null;
}

function findBareHtmlDocument(value: string, from: number): HtmlCandidate | null {
  const documentStartPattern = /<!doctype\s+html\b[^>]*>|<html\b[^>]*>/gi;
  documentStartPattern.lastIndex = from;

  let match: RegExpExecArray | null;
  while ((match = documentStartPattern.exec(value)) !== null) {
    const documentStart = match.index;
    if (isInsideMarkdownFence(value, documentStart)) continue;

    const closePattern = /<\/html\s*>/gi;
    closePattern.lastIndex = documentStartPattern.lastIndex;
    const close = closePattern.exec(value);
    if (!close) return null;

    const content = value.slice(documentStart, closePattern.lastIndex).trim();
    if (!isRenderableHtml(content)) continue;

    // Some models emit a standalone language label without a Markdown fence:
    // `html\n<!DOCTYPE html>...`. Consume that label, but preserve the newline
    // separating it from any explanatory prose before it.
    const prefix = value.slice(0, documentStart);
    const label = /(^|\r?\n)[ \t]*html[ \t]*\r?\n[ \t\r\n]*$/i.exec(prefix);
    const start = label ? label.index + (label[1].length > 0 ? label[1].length : 0) : documentStart;

    return { start, end: closePattern.lastIndex, content };
  }
  return null;
}

/**
 * Split an assistant text item into ordinary Markdown and renderable HTML.
 *
 * Explicit `html` fences may contain fragments. Unfenced content is promoted
 * only when it is a complete `<html>…</html>` document, which avoids turning
 * incidental inline tags or incomplete streaming output into previews.
 */
export function splitAssistantHtml(value: string): AssistantHtmlPart[] {
  const parts: AssistantHtmlPart[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const fenced = findFencedHtml(value, cursor);
    const bare = findBareHtmlDocument(value, cursor);
    const next = fenced && bare ? (fenced.start <= bare.start ? fenced : bare) : (fenced ?? bare);

    if (!next) break;
    if (next.start > cursor) {
      const markdown = value.slice(cursor, next.start).trimEnd();
      if (markdown.trim()) parts.push({ kind: "markdown", content: markdown });
    }
    parts.push({ kind: "html", content: next.content });
    cursor = next.end;
  }

  if (cursor < value.length) {
    const markdown = value.slice(cursor).trimStart();
    if (markdown.trim()) parts.push({ kind: "markdown", content: markdown });
  }

  return parts.length > 0 ? parts : [{ kind: "markdown", content: value }];
}

export function prepareAssistantHtmlPreviewDoc(source: string): string {
  const parsed = new DOMParser().parseFromString(source, "text/html");
  parsed.querySelectorAll('base, meta[http-equiv="refresh" i]').forEach((element) => {
    element.remove();
  });

  const language = parsed.documentElement.lang
    ? ` lang="${parsed.documentElement.lang.replace(/["<>]/g, "")}"`
    : "";
  return [
    `<!doctype html><html${language}><head>`,
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CHAT_HTML_CSP}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<style>html,body{max-width:100%;min-height:100%;box-sizing:border-box}*,*::before,*::after{box-sizing:inherit}img,svg,canvas,video{max-width:100%}</style>",
    parsed.head.innerHTML,
    "</head><body>",
    parsed.body.innerHTML,
    "</body></html>",
  ].join("");
}

export function AssistantHtmlPreview({ html }: { html: string }) {
  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-background"
      data-testid="assistant-html-preview"
    >
      <div className="flex h-9 items-center justify-between border-b border-border bg-muted/40 px-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 font-medium text-foreground/80">
          <CodeXmlIcon className="size-3.5" aria-hidden="true" />
          HTML preview
        </span>
        <span className="flex items-center gap-1">
          <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
          Sandboxed
        </span>
      </div>
      <iframe
        className="block h-[520px] w-full border-0 bg-white"
        loading="lazy"
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        srcDoc={prepareAssistantHtmlPreviewDoc(html)}
        title="Agent-generated HTML preview"
      />
    </section>
  );
}
