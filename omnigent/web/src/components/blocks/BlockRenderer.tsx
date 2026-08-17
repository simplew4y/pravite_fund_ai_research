// Dispatch from a `RenderItem` to the right component. Pure switch on
// `item.kind`. Compaction renders as a standalone `Bubble` in
// `ChatPage`, not as an inline render item — no case for it here.
//
// Tool-call collapsing: within a contiguous run of tool / native_tool
// items, older tools fold into a single "See N steps" line (rendered
// by `ToolGroupSummary`). The trailing `STREAMING_TAIL` tools (any
// state) stay outside the group ONLY when (a) the session is still
// running and (b) the very last item in the transcript is a tool —
// meaning the agent hasn't produced any text/reasoning after this
// run yet, so these tools are the live activity. Once the agent
// emits anything else after a tool run (or once the session is
// idle), the run collapses entirely except for still-in-progress
// spinners.

import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import type React from "react";
import { defaultRemarkPlugins } from "streamdown";
import remarkBreaks from "remark-breaks";
import { MessageResponse } from "@/components/ai-elements/message";
import { ZoomableImage } from "@/components/ImageLightbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useThrottledValue } from "@/hooks/useThrottledValue";
import type { RenderItem } from "@/lib/renderItems";
import type { SessionStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  useFileViewer,
  useFileViewerConversationId,
  useIsChangedPath,
  useWorkspacePaths,
} from "@/shell/FileViewerContext";
import { InlineSourcePopover } from "@/components/private-fund/InlineSourcePopover";
import {
  PrivateFundArtifactPopoverLink,
  type PrivateFundArtifactReference,
} from "@/components/private-fund/PrivateFundArtifactPreview";
import { toWorkspaceRelativePath, useWorkspaceFileExists } from "@/hooks/useWorkspaceChangedFiles";
import { ElicitationCard } from "./ApprovalCard";
import { AssistantHtmlPreview, splitAssistantHtml } from "./AssistantHtmlPreview";
import { ReasoningView } from "./ReasoningView";
import { SlashCommandCard } from "./SlashCommandCard";
import { TerminalCommandCard } from "./TerminalCommandCard";
import { ErrorBanner, PolicyDeniedBanner, RetryIndicator } from "./StatusBlocks";
import { ToolCard, ToolGroupSummary } from "./ToolCard";

/**
 * Inline-`code` renderer that turns workspace file paths (e.g.
 * `` `src/components/App.tsx` ``) into clickable links opening the FileViewer.
 *
 * The span's text is first collapsed to a workspace-relative path: an
 * absolute (`/home/u/ws/foo.md`) or home-relative (`~/ws/foo.md`) path under
 * the workspace root is stripped down to its relative form so it matches the
 * changed-files list and the filesystem API (both speak relative paths);
 * absolute/`~` paths outside the root resolve to null and never linkify.
 *
 * That relative path is then linkified when it is either (a) a known
 * agent-changed file — resolved synchronously, the fast path, and the only
 * path that may be an uncommitted/deleted file — or (b) a path-shaped string
 * that the filesystem API confirms points at a real file in the workspace.
 * Everything else (prose-y inline code, non-existent paths) falls back to a
 * styled `<code>` matching Streamdown's default inline appearance. The span
 * always *displays* the original text the agent wrote; only the link target
 * uses the resolved relative path.
 *
 * Rendered by Streamdown as a real component (via the `inlineCode` slot), so
 * it may call hooks: the existence query re-renders this span when it settles,
 * independent of whether `MessageResponse` re-renders its parent.
 */
function WorkspacePathInlineCode({
  children: codeChildren,
  className,
  ...codeProps
}: React.ComponentPropsWithoutRef<"code">) {
  const openFile = useFileViewer();
  const isChangedPath = useIsChangedPath();
  const conversationId = useFileViewerConversationId();
  const { root, home } = useWorkspacePaths();
  const text = typeof codeChildren === "string" ? codeChildren : "";

  // Collapse absolute / "~"-relative forms onto a workspace-relative path so
  // they match the changed-files list and the filesystem API. null = absolute
  // or "~" path outside the workspace (or the root itself) → never a link.
  const linkPath = text ? toWorkspaceRelativePath(text, root, home) : null;
  // "Trusted" means we resolved an absolute/"~" form against the root, so the
  // result is known workspace-relative even if it's a bare basename (no
  // interior slash) that the existence check's path-shape heuristic rejects.
  const trusted = linkPath !== null && linkPath !== text;

  const isChanged = !!linkPath && isChangedPath(linkPath);
  // Only hit the filesystem for path-shaped spans that aren't already known
  // changes; passing null disables the query (keeps hook order stable).
  const existsOnDisk = useWorkspaceFileExists(
    conversationId,
    openFile && linkPath && !isChanged ? linkPath : null,
    trusted,
  );

  if (openFile && linkPath && (isChanged || existsOnDisk)) {
    // Rendered as an inline <code> (not a <button>): a button is laid out as
    // an atomic inline-block, so a long path can't break across lines and
    // drops below the list marker as a whole unit. An inline <code> flows and
    // wraps like the surrounding text; role/tabIndex/keydown restore the
    // button semantics.
    return (
      <code
        role="button"
        tabIndex={0}
        data-streamdown="inline-code"
        // Keep the base inline-code class/props (merge, don't replace) so the
        // link only adds the underline affordance on top of Streamdown's
        // styling and any caller-provided attributes survive.
        className={cn(
          "font-mono text-sm underline decoration-dotted underline-offset-2 hover:text-foreground transition-colors cursor-pointer",
          className,
        )}
        onClick={() => openFile(linkPath)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openFile(linkPath);
          }
        }}
        {...codeProps}
      >
        {codeChildren}
      </code>
    );
  }
  // Match Streamdown's default inline-code styling so non-path inline code
  // looks unchanged.
  return (
    <code
      className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)}
      data-streamdown="inline-code"
      {...codeProps}
    >
      {codeChildren}
    </code>
  );
}

// Markdown images open in the shared lightbox on click, matching uploaded and
// generated images. (Remote `src`s are still gated by Streamdown's image
// security; this only adds the zoom affordance to whatever does render.)
function ZoomableMarkdownImage({ src, alt, ...props }: React.ComponentProps<"img">) {
  const resolvedSrc = typeof src === "string" ? src : undefined;
  return <ZoomableImage {...props} src={resolvedSrc} alt={alt ?? ""} />;
}

const PDF_SOURCE_HASH = "#private-fund-pdf-source";
const EXCEL_SOURCE_HASH = "#private-fund-excel-source";
const ARTIFACT_SOURCE_HASH = "#private-fund-artifact";
const PRIVATE_FUND_ARTIFACT_INLINE_CODE_RE =
  /`([^`\n\r]{1,4096}\.(?:md|markdown|html|pdf|txt|csv|json))`/giu;
const BRACKETED_PDF_FILE_PAGE_CITATION_RE =
  /\[([^\n\r\[\]{}()（）【】*，,；;。:：]{1,180}?\.pdf)\s+(?:p\.\s*(\d{1,4}))(?:\s*[-–—]\s*(?:p\.\s*)?(\d{1,4}))?\]/giu;
const PDF_FILE_PAGE_CITATION_RE =
  /([\s(（\[【])([^\n\r\[\]{}()（）【】*，,；;。:：]{1,180}?\.pdf)\s+(?:\[?p\.\s*(\d{1,4})\]?)(?:\s*[-–—]\s*(?:p\.\s*)?(\d{1,4}))?/giu;
const ATTACHED_PDF_PAGE_CITATION_RE =
  /([^\s，,；;。:：()（）\[\]{}]{1,240}?\.pdf)\s+p\.\s*(\d{1,4})(?:\s*[-–—]\s*(?:p\.\s*)?(\d{1,4}))?/giu;
const CODED_PDF_FILE_PAGE_CITATION_RE =
  /([\s(（\[【])`([^`\n\r\[\]{}()（）【】*，,；;。:：]{1,180}?\.pdf\s+(?:\[?p\.\s*(?:\d{1,4})\]?)(?:\s*[-–—]\s*(?:p\.\s*)?\d{1,4})?)`/giu;
const BRACKETED_EXCEL_RANGE_CITATION_RE =
  /\[([^\n\r\[\]{}()（）【】*，,；;。:：`]{1,180}?\.(?:xlsx|xlsm|xls|csv))\s+(?:'([^'\n\r]{1,120})'|([^\n\r!，,；;。:：()（）\[\]{}]{1,120}?))\s*!\s*(\$?[A-Z]{1,3}\$?\d{1,7}(?::\$?[A-Z]{1,3}\$?\d{1,7})?)\]/giu;
const EXCEL_RANGE_CITATION_RE =
  /(^|[\s(（\[【])([^\n\r\[\]{}()（）【】*，,；;。:：`]{1,180}?\.(?:xlsx|xlsm|xls|csv))\s+(?:'([^'\n\r]{1,120})'|([^\n\r!，,；;。:：()（）\[\]{}]{1,120}?))\s*!\s*(\$?[A-Z]{1,3}\$?\d{1,7}(?::\$?[A-Z]{1,3}\$?\d{1,7})?)/giu;
const CODED_EXCEL_RANGE_CITATION_RE =
  /([\s(（\[【])`([^`\n\r\[\]{}()（）【】*，,；;。:：]{1,180}?\.(?:xlsx|xlsm|xls|csv)\s+(?:'[^'\n\r]{1,120}'|[^\n\r!，,；;。:：()（）\[\]{}]{1,120}?)\s*!\s*\$?[A-Z]{1,3}\$?\d{1,7}(?::\$?[A-Z]{1,3}\$?\d{1,7})?)`/giu;
const DATASET_DOCUMENT_FILENAME_RE =
  /(^|[\s(（\[【:：])([^\n\r\[\]{}()（）【】*，,；;。:：`]{1,180}?\.(?:pdf|xlsx|xlsm|xls|csv))/giu;
const CODED_DOCUMENT_FILENAME_RE =
  /([\s(（\[【])`([^`\n\r\[\]{}()（）【】*，,；;。:：]{1,180}?\.(?:pdf|xlsx|xlsm|xls|csv))`/giu;
const PDF_FILENAME_CONTEXT_RE =
  /(^|[\s(（\[【])([^\n\r\[\]{}()（）【】#?=&%*，,；;。:：]{1,180}?\.pdf)/giu;
const PAGE_CITATION_RE =
  /(?:\[p\.\s*(\d{1,4})\])|(?:(?:\b(?:10-K|10K|Form\s+10-K)\s+)?p\.\s*(\d{1,4})(?:\s*,?\s*para\.?\s*\d+)?)\b/gi;
const PAGE_CITATION_CLEAN_RE =
  /(?:\[p\.\s*\d{1,4}\])|(?:(?:\b(?:10-K|10K|Form\s+10-K)\s+)?p\.\s*\d{1,4}(?:\s*,?\s*para\.?\s*\d+)?)\b/gi;

function decodeMarkdownLinkParam(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeMarkdownLinkText(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function citationQuote(text: string, citationIndex: number, citationLength: number): string {
  const before = text.slice(0, citationIndex);
  const afterStart = citationIndex + citationLength;
  const after = text.slice(afterStart);
  const startBoundary = Math.max(
    before.lastIndexOf("\n\n"),
    before.lastIndexOf("\n"),
    before.lastIndexOf("。"),
    before.lastIndexOf("."),
    before.lastIndexOf("；"),
    before.lastIndexOf(";"),
    before.lastIndexOf("！"),
    before.lastIndexOf("!"),
    before.lastIndexOf("？"),
    before.lastIndexOf("?"),
  );
  const endOffsets = ["\n\n", "\n", "。", ".", "；", ";", "！", "!", "？", "?"]
    .map((boundary) => after.indexOf(boundary))
    .filter((offset) => offset >= 0);
  const endBoundary = endOffsets.length > 0 ? afterStart + Math.min(...endOffsets) : text.length;
  const start = startBoundary >= 0 ? startBoundary + 1 : Math.max(0, citationIndex - 360);
  const end = Math.min(text.length, endBoundary + 1, citationIndex + 520);
  return text
    .slice(start, end)
    .replace(PAGE_CITATION_CLEAN_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function pdfSourceHref({
  pageNo,
  pageEnd,
  label,
  quote,
  pdfName,
}: {
  pageNo: number;
  pageEnd?: number;
  label: string;
  quote?: string;
  pdfName?: string;
}): string {
  const params = new URLSearchParams({ page: String(pageNo), label });
  if (pageEnd && pageEnd !== pageNo) params.set("page_end", String(pageEnd));
  if (quote) params.set("quote", quote.slice(0, 280));
  if (pdfName) params.set("pdf_name", pdfName);
  return `${PDF_SOURCE_HASH}?${params.toString()}`;
}

function excelSourceHref({
  workbookName,
  sheetName,
  rangeRef,
  label,
}: {
  workbookName: string;
  sheetName?: string;
  rangeRef?: string;
  label: string;
}): string {
  const params = new URLSearchParams({ workbook_name: workbookName, label });
  if (sheetName) params.set("sheet_name", sheetName);
  if (rangeRef) params.set("range_ref", rangeRef);
  return `${EXCEL_SOURCE_HASH}?${params.toString()}`;
}

function isInsideMarkdownLink(markdown: string, offset: number): boolean {
  const lastOpenBracket = markdown.lastIndexOf("[", offset);
  const lastCloseBracket = markdown.lastIndexOf("]", offset);
  if (lastOpenBracket > lastCloseBracket) return true;

  const lastLinkTargetOpen = markdown.lastIndexOf("](", offset);
  const lastLinkTargetClose = markdown.lastIndexOf(")", offset);
  return lastLinkTargetOpen > lastLinkTargetClose;
}

function privateFundArtifactHref(rawPath: string): string | null {
  const normalized = rawPath.trim().replace(/\\/g, "/");
  const match = normalized.match(
    /(?:^|\/)private_fund_datasets\/([^/]+)\/((?:memos|reports)\/[^?#]+\.(?:md|markdown|html|pdf|txt|csv|json))$/iu,
  );
  if (!match) return null;
  const datasetId = match[1];
  const path = match[2];
  if (
    !datasetId ||
    !path ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    return null;
  }
  const format = path.split(".").at(-1)?.toLowerCase();
  if (!format) return null;
  const displayPath = `private_fund_datasets/${datasetId}/${path}`;
  const params = new URLSearchParams({
    dataset_id: datasetId,
    path,
    display_path: displayPath,
    format,
  });
  return `${ARTIFACT_SOURCE_HASH}?${params.toString()}`;
}

export function linkifyPrivateFundArtifactPaths(markdown: string): string {
  return markdown.replace(
    PRIVATE_FUND_ARTIFACT_INLINE_CODE_RE,
    (match: string, rawPath: string, offset: number) => {
      if (isInsideMarkdownLink(markdown, offset)) return match;
      const href = privateFundArtifactHref(rawPath);
      if (!href) return match;
      const displayPath = new URLSearchParams(href.slice(href.indexOf("?") + 1)).get(
        "display_path",
      );
      const fileName = displayPath?.split("/").at(-1);
      if (!fileName) return match;
      return `[${escapeMarkdownLinkText(fileName)}](${href})`;
    },
  );
}

function normalizePrivateFundSourceMarkdown(markdown: string): string {
  return markdown
    .replace(
      CODED_EXCEL_RANGE_CITATION_RE,
      (_match: string, prefix: string, citation: string) => `${prefix}${citation}`,
    )
    .replace(
      CODED_PDF_FILE_PAGE_CITATION_RE,
      (_match: string, prefix: string, citation: string) => `${prefix}${citation}`,
    )
    .replace(
      CODED_DOCUMENT_FILENAME_RE,
      (_match: string, prefix: string, citation: string) => `${prefix}${citation}`,
    );
}

function linkifyBracketedExcelRangeCitations(markdown: string): string {
  return markdown.replace(
    BRACKETED_EXCEL_RANGE_CITATION_RE,
    (
      match: string,
      workbookName: string,
      quotedSheetName: string | undefined,
      bareSheetName: string | undefined,
      rangeRef: string | undefined,
      offset: number,
    ) => {
      if (markdown[offset + match.length] === "(") return match;
      const cleanWorkbookName = workbookName.trim().replace(/^`+|`+$/g, "");
      const cleanSheetName = (quotedSheetName ?? bareSheetName ?? "").trim();
      const cleanRangeRef = (rangeRef ?? "").replace(/\$/g, "").trim();
      if (!cleanWorkbookName || !cleanSheetName || !cleanRangeRef) return match;
      const label = `${cleanWorkbookName} ${cleanSheetName}!${cleanRangeRef}`;
      return `[${escapeMarkdownLinkText(label)}](${excelSourceHref({
        workbookName: cleanWorkbookName,
        sheetName: cleanSheetName,
        rangeRef: cleanRangeRef,
        label,
      })})`;
    },
  );
}

function linkifyBracketedPdfFilePageCitations(markdown: string): string {
  return markdown.replace(
    BRACKETED_PDF_FILE_PAGE_CITATION_RE,
    (
      match: string,
      pdfName: string,
      pageNoText: string | undefined,
      pageEndText: string | undefined,
      offset: number,
    ) => {
      if (markdown[offset + match.length] === "(") return match;
      const cleanPdfName = pdfName.trim().replace(/^`+|`+$/g, "");
      const pageNo = Number.parseInt(pageNoText ?? "", 10);
      const pageEnd = pageEndText ? Number.parseInt(pageEndText, 10) : undefined;
      if (!cleanPdfName || !Number.isFinite(pageNo) || pageNo < 1) return match;
      const normalizedPageEnd =
        pageEnd && Number.isFinite(pageEnd) && pageEnd >= pageNo ? pageEnd : undefined;
      const label = normalizedPageEnd ? `p.${pageNo}-${normalizedPageEnd}` : `p.${pageNo}`;
      const quote = citationQuote(markdown, offset, match.length);
      const displayText = `${cleanPdfName} ${label}`;
      return `[${escapeMarkdownLinkText(displayText)}](${pdfSourceHref({
        pageNo,
        pageEnd: normalizedPageEnd,
        label,
        quote,
        pdfName: cleanPdfName,
      })})`;
    },
  );
}

function linkifyExcelRangeCitations(markdown: string): string {
  return markdown.replace(
    EXCEL_RANGE_CITATION_RE,
    (
      match: string,
      prefix: string,
      workbookName: string,
      quotedSheetName: string | undefined,
      bareSheetName: string | undefined,
      rangeRef: string | undefined,
      offset: number,
    ) => {
      if (isInsideMarkdownLink(markdown, offset + prefix.length)) return match;
      const cleanWorkbookName = workbookName.trim().replace(/^`+|`+$/g, "");
      const cleanSheetName = (quotedSheetName ?? bareSheetName ?? "").trim();
      const cleanRangeRef = (rangeRef ?? "").replace(/\$/g, "").trim();
      if (!cleanWorkbookName || !cleanSheetName || !cleanRangeRef) return match;
      const label = `${cleanWorkbookName} ${cleanSheetName}!${cleanRangeRef}`;
      return `${prefix}[${escapeMarkdownLinkText(label)}](${excelSourceHref({
        workbookName: cleanWorkbookName,
        sheetName: cleanSheetName,
        rangeRef: cleanRangeRef,
        label,
      })})`;
    },
  );
}

function linkifyPdfFilePageCitations(markdown: string): string {
  return markdown.replace(
    PDF_FILE_PAGE_CITATION_RE,
    (
      match: string,
      prefix: string,
      pdfName: string,
      pageNoText: string | undefined,
      pageEndText: string | undefined,
      offset: number,
    ) => {
      if (isInsideMarkdownLink(markdown, offset + prefix.length)) return match;
      const normalizedMatch = normalizePdfFileMatchPrefix(prefix, pdfName);
      const pageNo = Number.parseInt(pageNoText ?? "", 10);
      const pageEnd = pageEndText ? Number.parseInt(pageEndText, 10) : undefined;
      if (!Number.isFinite(pageNo) || pageNo < 1) return match;
      const normalizedPageEnd =
        pageEnd && Number.isFinite(pageEnd) && pageEnd >= pageNo ? pageEnd : undefined;
      const label = normalizedPageEnd ? `p.${pageNo}-${normalizedPageEnd}` : `p.${pageNo}`;
      const quote = citationQuote(markdown, offset + prefix.length, match.length - prefix.length);
      const displayText = `${normalizedMatch.pdfName} ${label}`;
      return `${normalizedMatch.prefix}[${escapeMarkdownLinkText(displayText)}](${pdfSourceHref({
        pageNo,
        pageEnd: normalizedPageEnd,
        label,
        quote,
        pdfName: normalizedMatch.pdfName,
      })})`;
    },
  );
}

function linkifyAttachedPdfPageCitations(markdown: string): string {
  return markdown.replace(
    ATTACHED_PDF_PAGE_CITATION_RE,
    (
      match: string,
      pdfToken: string,
      pageNoText: string | undefined,
      pageEndText: string | undefined,
      offset: number,
    ) => {
      if (isInsideMarkdownLink(markdown, offset)) return match;
      const pageNo = Number.parseInt(pageNoText ?? "", 10);
      const pageEnd = pageEndText ? Number.parseInt(pageEndText, 10) : undefined;
      if (!Number.isFinite(pageNo) || pageNo < 1) return match;
      const normalizedPageEnd =
        pageEnd && Number.isFinite(pageEnd) && pageEnd >= pageNo ? pageEnd : undefined;
      const label = normalizedPageEnd ? `p.${pageNo}-${normalizedPageEnd}` : `p.${pageNo}`;
      const quote = citationQuote(markdown, offset, match.length);
      // Keep the original token as visible text: when the model omitted a
      // separator it may contain the tail of the preceding Chinese sentence.
      // The server resolves that safely by matching the registered filename
      // as a suffix, while the page label becomes the explicit source action.
      return `${pdfToken} [来源 ${label}](${pdfSourceHref({
        pageNo,
        pageEnd: normalizedPageEnd,
        label,
        quote,
        pdfName: pdfToken,
      })})`;
    },
  );
}

function normalizePdfFileMatchPrefix(
  prefix: string,
  pdfName: string,
): { prefix: string; pdfName: string } {
  const trimmed = pdfName.trim().replace(/^`+|`+$/g, "");
  const bracketIndex = Math.max(trimmed.lastIndexOf("（"), trimmed.lastIndexOf("【"));
  if (bracketIndex < 0) return { prefix, pdfName: trimmed };
  const before = trimmed.slice(0, bracketIndex);
  const opener = trimmed[bracketIndex]!;
  const after = trimmed.slice(bracketIndex + 1).trim();
  if (!after.toLowerCase().endsWith(".pdf")) return { prefix, pdfName: trimmed };
  return { prefix: `${prefix}${before}${opener}`, pdfName: after };
}

function documentSourceHref(fileName: string, quote?: string): string | null {
  const cleanName = fileName.trim().replace(/^`+|`+$/g, "");
  const lowerName = cleanName.toLowerCase();
  if (lowerName.endsWith(".pdf")) {
    return pdfSourceHref({
      pageNo: 1,
      label: cleanName,
      quote,
      pdfName: cleanName,
    });
  }
  if (/\.(xlsx|xlsm|xls|csv)$/i.test(cleanName)) {
    return excelSourceHref({
      workbookName: cleanName,
      label: cleanName,
    });
  }
  return null;
}

function findNearestPdfName(markdown: string, offset: number): string | undefined {
  const before = markdown.slice(0, offset).replace(/\]\([^)]*\)/g, "]");
  const beforeMatches = Array.from(before.matchAll(PDF_FILENAME_CONTEXT_RE));
  const previousPdfName = beforeMatches.at(-1)?.[2]?.trim();
  if (previousPdfName) return previousPdfName;

  const after = markdown.slice(offset).replace(/\]\([^)]*\)/g, "]");
  const afterMatch = PDF_FILENAME_CONTEXT_RE.exec(after);
  PDF_FILENAME_CONTEXT_RE.lastIndex = 0;
  return afterMatch?.[2]?.trim();
}

function linkifyStandaloneDocumentMentions(markdown: string): string {
  return markdown.replace(
    DATASET_DOCUMENT_FILENAME_RE,
    (match: string, prefix: string, fileName: string, offset: number) => {
      if (isInsideMarkdownLink(markdown, offset + prefix.length)) return match;
      const quote = citationQuote(markdown, offset + prefix.length, match.length - prefix.length);
      const href = documentSourceHref(fileName, quote);
      if (!href) return match;
      return `${prefix}[${escapeMarkdownLinkText(fileName.trim())}](${href})`;
    },
  );
}

export function linkifyPdfPageCitations(markdown: string): string {
  const normalizedMarkdown = normalizePrivateFundSourceMarkdown(
    linkifyPrivateFundArtifactPaths(markdown),
  );
  const withBracketedExcelLinks = linkifyBracketedExcelRangeCitations(normalizedMarkdown);
  const withBracketedPdfLinks = linkifyBracketedPdfFilePageCitations(withBracketedExcelLinks);
  const withExcelLinks = linkifyExcelRangeCitations(withBracketedPdfLinks);
  const withPdfFileLinks = linkifyPdfFilePageCitations(withExcelLinks);
  const withAttachedPdfLinks = linkifyAttachedPdfPageCitations(withPdfFileLinks);
  const withDocumentLinks = linkifyStandaloneDocumentMentions(withAttachedPdfLinks);
  return withDocumentLinks.replace(
    PAGE_CITATION_RE,
    (
      match: string,
      bracketPageNoText: string | undefined,
      sourcePageNoText: string | undefined,
      offset: number,
    ) => {
      const pageNoText = bracketPageNoText ?? sourcePageNoText;
      const isBracketed = bracketPageNoText !== undefined;
      const nextChar = withDocumentLinks[offset + match.length];
      const previousChar = offset > 0 ? withDocumentLinks[offset - 1] : "";
      if (!isBracketed && isInsideMarkdownLink(withDocumentLinks, offset)) return match;
      if (isBracketed && (nextChar === "(" || previousChar === "!")) return match;
      if (!isBracketed && /[A-Za-z0-9_/#?=&%-]/.test(previousChar)) return match;
      if (!pageNoText) return match;

      const pageNo = Number.parseInt(pageNoText, 10);
      if (!Number.isFinite(pageNo) || pageNo < 1) return match;

      const label = `p.${pageNo}`;
      const quote = citationQuote(withDocumentLinks, offset, match.length);
      const pdfName = findNearestPdfName(withDocumentLinks, offset);
      const displayText = isBracketed ? `\\[${label}\\]` : escapeMarkdownLinkText(match);
      return `[${displayText}](${pdfSourceHref({ pageNo, label, quote, pdfName })})`;
    },
  );
}

function sourceHashQuery(href: string | undefined, hash: string): string | null {
  if (!href) return null;
  const hashIndex = href.indexOf(hash);
  if (hashIndex < 0) return null;
  const afterHash = href.slice(hashIndex + hash.length);
  if (!afterHash || afterHash[0] !== "?") return "";
  return afterHash.slice(1);
}

function parsePdfSourceHref(href: string | undefined) {
  const query = sourceHashQuery(href, PDF_SOURCE_HASH);
  if (query === null) return null;
  const params = new URLSearchParams(query);
  const pageNo = Number.parseInt(params.get("page") ?? "", 10);
  if (!Number.isFinite(pageNo) || pageNo < 1) return null;
  return {
    kind: "pdf" as const,
    pageNo,
    pageEnd: Number.parseInt(params.get("page_end") ?? "", 10) || undefined,
    label: params.get("label") ?? `p.${pageNo}`,
    quote: decodeMarkdownLinkParam(params.get("quote")),
    pdfPath: params.get("pdf_path") || undefined,
    pdfName: params.get("pdf_name") || undefined,
    evidenceId: params.get("evidence_id") || undefined,
    datasetId: params.get("dataset_id") || undefined,
  };
}

function parseExcelSourceHref(href: string | undefined) {
  const query = sourceHashQuery(href, EXCEL_SOURCE_HASH);
  if (query === null) return null;
  const params = new URLSearchParams(query);
  const workbookName = params.get("workbook_name");
  if (!workbookName) return null;
  return {
    kind: "excel" as const,
    label: params.get("label") ?? workbookName,
    workbookName,
    sheetName: params.get("sheet_name") || undefined,
    rangeRef: params.get("range_ref") || undefined,
    datasetId: params.get("dataset_id") || undefined,
  };
}

function parsePrivateFundArtifactHref(
  href: string | undefined,
): PrivateFundArtifactReference | null {
  const query = sourceHashQuery(href, ARTIFACT_SOURCE_HASH);
  if (query === null) return null;
  const params = new URLSearchParams(query);
  const datasetId = params.get("dataset_id")?.trim();
  const path = params.get("path")?.trim();
  const displayPath = params.get("display_path")?.trim();
  const format = params.get("format")?.trim();
  if (!datasetId || !path || !displayPath || !format) return null;
  if (!/^(?:memos|reports)\//u.test(path)) return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return { datasetId, path, displayPath, format };
}

function parsePrivateFundSourceHref(href: string | undefined) {
  return parsePdfSourceHref(href) ?? parseExcelSourceHref(href);
}

function PdfCitationLink({
  children,
  className,
  href,
  onClick,
  ...props
}: React.ComponentPropsWithoutRef<"a">) {
  // remark/rehype append one back-reference link (↩, ↩2, …) for every
  // footnote occurrence. In research answers those links create visual noise
  // after each source entry and look like emoji. The source entry and its
  // actual document link remain; only the generated jump-back controls go.
  if ("data-footnote-backref" in props) return null;

  // Research answers already render a consolidated source list. Repeating
  // superscript footnote numbers in the prose adds noise without adding a
  // useful action, so omit the generated references as well as backrefs.
  if ("data-footnote-ref" in props) return null;

  const artifact = parsePrivateFundArtifactHref(href);
  if (artifact) {
    void onClick;
    void props;
    return (
      <PrivateFundArtifactPopoverLink artifact={artifact} className={className}>
        {children}
      </PrivateFundArtifactPopoverLink>
    );
  }

  const source = parsePrivateFundSourceHref(href);

  if (!source) {
    return (
      <a className={className} href={href} onClick={onClick} {...props}>
        {children}
      </a>
    );
  }

  void onClick;
  void props;
  return (
    <InlineSourcePopover
      className={cn(
        "inline-flex cursor-pointer items-center whitespace-nowrap rounded-md bg-[#E7F1EC] px-1.5 py-0.5 font-medium text-[#2F6F57] no-underline ring-1 ring-inset ring-[#C7DED2] transition-colors hover:bg-[#DCECE4] hover:text-[#254F40]",
        className,
      )}
      href={href}
      source={source}
    >
      {children}
    </InlineSourcePopover>
  );
}

// Stable module-level override map so MessageResponse's memo (which ignores
// `components` changes) never sees a new identity.
const FILE_PATH_AWARE_COMPONENTS = {
  a: PdfCitationLink,
  inlineCode: WorkspacePathInlineCode,
  img: ZoomableMarkdownImage,
};

// How often the live (growing) assistant bubble re-parses its markdown. The
// store pump commits a new, longer text up to once per animation frame (~60/s);
// without this the whole accumulated message is re-parsed on every commit. ~10/s
// is smooth to read and cuts the per-frame parse cost. Trailing-edge, so the
// final text still appears within this window of the last token.
const STREAM_MARKDOWN_THROTTLE_MS = 100;

// Defense-in-depth against a pathological text block locking the tab.
// A user message whose text is a ~50KB unbroken base64 data URL
// — e.g. an image block accidentally serialized into the text stream — both
// jams the full markdown pipeline (Shiki/KaTeX/mermaid + rehype) on the main
// thread AND forces the browser to lay out one ~50K-char line with no break
// opportunities. Either heuristic below routes such a block to plain,
// break-anywhere rendering that bypasses markdown entirely.
//
// `MAX_MARKDOWN_TEXT_LENGTH`: total size above which we never run markdown.
// `MAX_UNBROKEN_TOKEN_LENGTH`: longest run of non-whitespace chars above which
//   layout becomes pathological regardless of total size (base64, long URLs).
// `MAX_PLAINTEXT_DISPLAY_LENGTH`: hard cap on what we paint even as plain text,
//   so a multi-MB payload can't blow up the DOM; the rest is elided.
const MAX_MARKDOWN_TEXT_LENGTH = 50_000;
const MAX_UNBROKEN_TOKEN_LENGTH = 5_000;
const MAX_PLAINTEXT_DISPLAY_LENGTH = 200_000;

/**
 * Longest run of consecutive non-whitespace characters in `text`. ASCII
 * whitespace (space, tab, CR, LF, FF, VT) resets the run — those are the
 * break opportunities the layout engine can use. O(n), single pass.
 */
function longestUnbrokenRun(text: string): number {
  let max = 0;
  let current = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // 32 = space; 9..13 = tab, LF, VT, FF, CR.
    if (code === 32 || (code >= 9 && code <= 13)) {
      current = 0;
    } else {
      current += 1;
      if (current > max) max = current;
    }
  }
  return max;
}

/**
 * Whether `text` should bypass the markdown pipeline because rendering it
 * there would risk locking the tab. See the constants above for the why.
 */
function isPathologicalText(text: string): boolean {
  return (
    text.length > MAX_MARKDOWN_TEXT_LENGTH || longestUnbrokenRun(text) > MAX_UNBROKEN_TOKEN_LENGTH
  );
}

/**
 * Plain, break-anywhere fallback for a pathological text block — no markdown.
 * `whitespace-pre-wrap` keeps newlines; `break-all` gives the layout engine a
 * break opportunity inside an otherwise unbreakable token. Over-long payloads
 * are elided so the DOM node itself can't grow without bound.
 */
function PlainTextFallback({ text }: { text: string }) {
  const truncated = text.length > MAX_PLAINTEXT_DISPLAY_LENGTH;
  const shown = truncated ? text.slice(0, MAX_PLAINTEXT_DISPLAY_LENGTH) : text;
  return (
    <div className="whitespace-pre-wrap break-all font-mono text-xs">
      {shown}
      {truncated && (
        <span className="text-muted-foreground">
          {`\n… [${text.length - MAX_PLAINTEXT_DISPLAY_LENGTH} more characters not shown]`}
        </span>
      )}
    </div>
  );
}

function AssistantTextContent({ text }: { text: string }) {
  const parts = splitAssistantHtml(text);
  if (parts.length === 1 && parts[0]?.kind === "markdown") {
    return <FilePathAwareMessageResponse>{parts[0].content}</FilePathAwareMessageResponse>;
  }
  let sourceOffset = 0;
  const rendered = parts.map((part) => {
    const key = `${part.kind}:${sourceOffset}`;
    sourceOffset += part.content.length + 1;
    return part.kind === "html" ? (
      <AssistantHtmlPreview html={part.content} key={key} />
    ) : (
      <FilePathAwareMessageResponse key={key}>{part.content}</FilePathAwareMessageResponse>
    );
  });
  return <div className="space-y-3">{rendered}</div>;
}

/**
 * Wraps `MessageResponse` with {@link WorkspacePathInlineCode} via Streamdown's
 * `inlineCode` slot — NOT `code` — so fenced code blocks keep their default
 * `<pre>` wrapper and Shiki highlighting. Overriding `code` here would replace
 * block rendering too, stripping `<pre>` and collapsing whitespace.
 *
 * When `breaks` is set, single newlines render as `<br>` (remark-breaks)
 * instead of collapsing to spaces per CommonMark. Used for user bubbles,
 * where people type multi-line messages without blank-line paragraph
 * separators and expect their line breaks preserved. NOTE: Streamdown's
 * `remarkPlugins` prop *replaces* its defaults rather than merging, so we
 * extend `defaultRemarkPlugins` (which carries remark-gfm) — passing
 * `[remarkBreaks]` alone would silently drop GFM tables / strikethrough.
 */
export function FilePathAwareMessageResponse({
  children,
  breaks = false,
  ...props
}: React.ComponentProps<typeof MessageResponse> & { breaks?: boolean }) {
  const components = FILE_PATH_AWARE_COMPONENTS;

  // Extend (don't replace) Streamdown's defaults so remark-gfm survives;
  // append remark-breaks only when `breaks` is requested. When `breaks` is
  // false we pass `undefined` so Streamdown uses its own defaults unchanged.
  const remarkPlugins = useMemo(
    () => (breaks ? [...Object.values(defaultRemarkPlugins), remarkBreaks] : undefined),
    [breaks],
  );

  // Throttle the markdown so the live (still-growing) bubble re-parses a few
  // times per second instead of on every store commit. `children` is a string
  // at both call sites (a text RenderItem and the user bubble); finalized/static
  // text changes once, which emits immediately, so this is a no-op off the
  // streaming path. The hook must be called unconditionally (rules of hooks), so
  // non-string children (none today) pass an inert "" and bypass the result.
  const isString = typeof children === "string";
  const throttledText = useThrottledValue(
    isString ? (children as string) : "",
    STREAM_MARKDOWN_THROTTLE_MS,
  );

  // Defense-in-depth: a string child that is huge or carries a
  // giant unbroken token (e.g. a base64 data URL serialized into the text
  // stream) would lock the tab in the markdown pipeline + layout. Render it as
  // plain break-anywhere text instead. Both call sites (assistant text blocks
  // and the user bubble) flow through here, so this one guard covers both.
  const pathological = useMemo(
    () => isString && isPathologicalText(children as string),
    [isString, children],
  );
  if (pathological) {
    return <PlainTextFallback text={children as string} />;
  }

  return (
    <MessageResponse {...props} components={components} remarkPlugins={remarkPlugins}>
      {isString ? linkifyPdfPageCitations(throttledText) : children}
    </MessageResponse>
  );
}

const STREAMING_TAIL = 3;

interface BlockRendererProps {
  items: RenderItem[];
  sessionStatus: SessionStatus;
  collapsePostCompactionActivity?: boolean;
}

export function BlockRenderer({
  items,
  sessionStatus,
  collapsePostCompactionActivity = false,
}: BlockRendererProps) {
  if (collapsePostCompactionActivity) {
    const finalTextIndex = items.findLastIndex((item) => item.kind === "text");
    if (finalTextIndex > 0) {
      return (
        <>
          <Collapsible
            defaultOpen={false}
            className="group/post-compaction not-prose w-full"
            data-testid="post-compaction-plan"
          >
            <CollapsibleTrigger className="flex cursor-pointer items-center gap-1.5 py-1 text-left text-muted-foreground text-xs transition-colors hover:text-foreground">
              <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/post-compaction:rotate-90" />
              <span>压缩后的计划</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-1 ml-2 space-y-2 border-l pl-3 py-1 data-[state=closed]:animate-out data-[state=open]:animate-in">
              <BlockRenderer items={items.slice(0, finalTextIndex)} sessionStatus="idle" />
            </CollapsibleContent>
          </Collapsible>
          <BlockRenderer items={items.slice(finalTextIndex)} sessionStatus={sessionStatus} />
        </>
      );
    }
  }
  const rendered: ReactNode[] = [];
  let previousRenderedItemWasText = false;
  const isAgentActive = sessionStatus === "running" || sessionStatus === "waiting";
  const streamingRunStart = isAgentActive ? findStreamingRunStart(items) : -1;
  // Reasoning is "currently streaming" iff the agent is live AND this
  // reasoning is the very last item in the bubble. Mirrors the
  // `streamingRunStart` rule for tool runs: the trailing live edge stays
  // expanded; once anything else lands after it, it collapses.
  const lastIdx = items.length - 1;
  const reasoningStreamingIdx =
    isAgentActive && lastIdx >= 0 && items[lastIdx]!.kind === "reasoning" ? lastIdx : -1;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;

    if (isToolItem(item)) {
      // Consume contiguous run of tool / native_tool items.
      const runStart = i;
      while (i < items.length && isToolItem(items[i]!)) i += 1;
      const run = items.slice(runStart, i);
      i -= 1; // outer loop will i += 1

      // Only the run at `streamingRunStart` (when set) is treated as
      // "currently streaming". Earlier runs, and any run followed by
      // assistant text/reasoning, collapse the same way they would
      // when idle.
      const { grouped, standalone } = partitionToolRun(run, runStart === streamingRunStart);

      if (grouped.length > 0) {
        // Wrap (group + trailing tail) in a single MessageContent child
        // so the message column's `gap-2` only applies AROUND this
        // pair, not BETWEEN them — the tail's `peer-data-[state=open]:mt-0`
        // can then truly bring the two bordered blocks flush when the
        // group is expanded.
        rendered.push(
          <div key={`tool-group-with-tail:${runStart}`}>
            <ToolGroupSummary tools={grouped} count={run.length} />
            {standalone.length > 0 && (
              <div className="mt-1 ml-2 space-y-1 border-l pl-3 py-1 peer-data-[state=open]:mt-0">
                {standalone.map((tool, idx) => renderItem(tool, runStart + idx, false))}
              </div>
            )}
          </div>,
        );
      } else {
        for (const tool of standalone) {
          rendered.push(renderItem(tool, runStart, false));
        }
      }
      previousRenderedItemWasText = false;
      continue;
    }

    const followsText = item.kind === "text" && previousRenderedItemWasText;
    rendered.push(renderItem(item, i, i === reasoningStreamingIdx, followsText));
    previousRenderedItemWasText = item.kind === "text";
  }

  return <>{rendered}</>;
}

/**
 * Split a contiguous tool run into the part that folds into the
 * "See N steps" group versus the part rendered individually.
 *
 * For the live-streaming run, the trailing `STREAMING_TAIL` tools
 * (regardless of state) stay outside the group so the user can watch
 * the most recent activity. For any other run — older runs in the
 * transcript, or any run once the loop is idle — only still-in-progress
 * tools stay outside; everything else folds.
 */
function partitionToolRun(
  run: RenderItem[],
  isStreamingRun: boolean,
): { grouped: RenderItem[]; standalone: RenderItem[] } {
  if (isStreamingRun) {
    const tailStart = Math.max(0, run.length - STREAMING_TAIL);
    return { grouped: run.slice(0, tailStart), standalone: run.slice(tailStart) };
  }
  return {
    grouped: run.filter((t) => !isInProgressTool(t)),
    standalone: run.filter(isInProgressTool),
  };
}

function isToolItem(item: RenderItem): boolean {
  return item.kind === "tool" || item.kind === "native_tool";
}

/**
 * If the transcript ends in a contiguous tool run, return its start
 * index — that run is the live activity and should keep its
 * streaming tail. Otherwise return -1: the agent has spoken (or
 * reasoned) after the most recent tools, so they're no longer
 * "current".
 */
function findStreamingRunStart(items: RenderItem[]): number {
  if (items.length === 0) return -1;
  if (!isToolItem(items[items.length - 1]!)) return -1;
  let i = items.length - 1;
  while (i > 0 && isToolItem(items[i - 1]!)) i -= 1;
  return i;
}

/**
 * A tool item is in-progress only when it's a `tool` (not a
 * `native_tool` — those are provider-managed and always arrive
 * completed) and its derived UI state is `input-available`.
 */
function isInProgressTool(item: RenderItem): boolean {
  return item.kind === "tool" && item.state === "input-available";
}

function renderItem(
  item: RenderItem,
  index: number,
  isReasoningStreaming: boolean,
  followsText = false,
): ReactNode {
  const key = keyFor(item, index);
  switch (item.kind) {
    case "text":
      return (
        <div
          key={key}
          data-testid="assistant-text-section"
          className={cn("min-w-0", followsText && "mt-2")}
        >
          <AssistantTextContent text={item.text} />
        </div>
      );
    case "reasoning":
      return (
        <ReasoningView
          key={key}
          text={item.text}
          isStreaming={isReasoningStreaming}
          duration={item.duration}
        />
      );
    case "tool":
      return (
        <ToolCard
          key={key}
          name={item.execution.name}
          argsSummary={item.execution.argsSummary}
          arguments={item.execution.arguments}
          output={item.output}
          state={item.state}
          startedAt={item.startedAt}
          duration={item.duration}
        />
      );
    case "native_tool":
      // Reuse the same tool card. Native tools are server-side
      // (provider-managed) so they're always "completed" by the
      // time we see them; render the raw provider data as input.
      return (
        <ToolCard
          key={key}
          name={item.label}
          nativeToolType={item.toolType}
          arguments={item.data}
          output={null}
          state="output-available"
        />
      );
    case "slash_command":
      return (
        <SlashCommandCard
          key={key}
          kind={item.slashKind}
          name={item.name}
          arguments={item.displayText ? "" : item.arguments}
          output={item.output}
        />
      );
    case "terminal_command":
      return (
        <TerminalCommandCard
          key={key}
          kind={item.terminalKind}
          input={item.input}
          stdout={item.stdout}
          stderr={item.stderr}
        />
      );
    case "error":
      return <ErrorBanner key={key} message={item.message} source={item.source} code={item.code} />;
    case "policy_denied":
      return <PolicyDeniedBanner key={key} reason={item.reason} phase={item.phase} />;
    case "retry":
      return (
        <RetryIndicator
          key={key}
          source={item.source}
          attempt={item.attempt}
          maxAttempts={item.maxAttempts}
          delaySeconds={item.delaySeconds}
        />
      );
    case "elicitation":
      return <ElicitationCard key={key} item={item} />;
  }
}

/**
 * Stable key for each render item. Prefer the server-assigned item id;
 * fall back to call_id for tools (unique within a response) or to
 * position for pre-finalization fragments that don't carry an item id
 * yet (text/reasoning chunks emitted before their `output_item.done`).
 */
function keyFor(item: RenderItem, index: number): string {
  if (item.itemId) return `${item.kind}:${item.itemId}`;
  if (item.kind === "tool") return `tool:${item.execution.callId}`;
  if (item.kind === "elicitation") return `elicitation:${item.elicitationId}`;
  return `${item.kind}:${index}`;
}
