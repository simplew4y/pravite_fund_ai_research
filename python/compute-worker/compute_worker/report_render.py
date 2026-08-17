"""Safe deterministic Markdown/HTML report rendering with optional PDF."""

import hashlib
import html
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .artifacts import (
    artifact_descriptor,
    commit_temporary_new_or_identical,
    sha256_file,
    write_bytes_new_or_identical,
    write_json_new_or_identical,
)
from .errors import ComputeOperationError, DependencyUnavailableError
from .paths import generated_output_path


MAX_MARKDOWN_BYTES = 16 * 1024 * 1024
REPORT_RENDERER_VERSION = "stdlib-markdown-v1"


def _bool_option(
    options: Mapping[str, Any], name: str, default: bool
) -> bool:
    value = options.get(name, default)
    if not isinstance(value, bool):
        raise ComputeOperationError(
            "options.{} must be boolean".format(name), "invalid_options"
        )
    return value


def _canonical_markdown(input_path: Path) -> str:
    if input_path.stat().st_size > MAX_MARKDOWN_BYTES:
        raise ComputeOperationError(
            "report Markdown exceeds {} bytes".format(MAX_MARKDOWN_BYTES),
            "document_limit_exceeded",
        )
    try:
        markdown = input_path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ComputeOperationError(
            "render_report input must be UTF-8 Markdown",
            "invalid_report",
        ) from exc
    if "\x00" in markdown:
        raise ComputeOperationError(
            "render_report input may not contain NUL bytes",
            "invalid_report",
        )
    normalized = markdown.replace("\r\n", "\n").replace("\r", "\n")
    return normalized.rstrip("\n") + "\n"


def _report_title(
    markdown: str, input_path: Path, options: Mapping[str, Any]
) -> str:
    requested = options.get("title")
    if requested is not None:
        if not isinstance(requested, str) or not requested.strip() or len(requested) > 300:
            raise ComputeOperationError(
                "options.title must contain between 1 and 300 characters",
                "invalid_options",
            )
        return requested.strip()
    for line in markdown.splitlines():
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            return match.group(1)[:300]
    return input_path.stem[:300] or "Research Report"


def _safe_output_stem(value: Any, fallback: str) -> str:
    if value is None:
        return fallback
    if (
        not isinstance(value, str)
        or not value
        or Path(value).name != value
        or "/" in value
        or "\\" in value
        or "\x00" in value
        or value in (".", "..")
    ):
        raise ComputeOperationError(
            "options.outputBasename must be a safe file stem",
            "invalid_options",
        )
    if Path(value).suffix:
        raise ComputeOperationError(
            "options.outputBasename must not include an extension",
            "invalid_options",
        )
    return value[:120]


def _close_paragraph(output: List[str], paragraph: List[str]) -> None:
    if paragraph:
        output.append(
            "<p>{}</p>".format(
                " ".join(html.escape(line.strip()) for line in paragraph)
            )
        )
        paragraph.clear()


def _markdown_body(markdown: str) -> str:
    """Render a deliberately small, raw-HTML-free Markdown subset."""

    output: List[str] = []
    paragraph: List[str] = []
    list_type: Optional[str] = None
    in_code = False
    code_language = ""
    code_lines: List[str] = []

    def close_list() -> None:
        nonlocal list_type
        if list_type is not None:
            output.append("</{}>".format(list_type))
            list_type = None

    for raw_line in markdown.splitlines():
        fence = re.match(r"^```\s*([A-Za-z0-9_+.-]*)\s*$", raw_line)
        if fence:
            _close_paragraph(output, paragraph)
            close_list()
            if in_code:
                language_attr = (
                    ' class="language-{}"'.format(html.escape(code_language))
                    if code_language
                    else ""
                )
                output.append(
                    "<pre><code{}>{}</code></pre>".format(
                        language_attr,
                        html.escape("\n".join(code_lines)),
                    )
                )
                code_lines.clear()
                code_language = ""
                in_code = False
            else:
                in_code = True
                code_language = fence.group(1)
            continue
        if in_code:
            code_lines.append(raw_line)
            continue

        if not raw_line.strip():
            _close_paragraph(output, paragraph)
            close_list()
            continue
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*$", raw_line)
        if heading:
            _close_paragraph(output, paragraph)
            close_list()
            level = len(heading.group(1))
            output.append(
                "<h{0}>{1}</h{0}>".format(
                    level, html.escape(heading.group(2))
                )
            )
            continue
        unordered = re.match(r"^\s*[-*+]\s+(.+)$", raw_line)
        ordered = re.match(r"^\s*\d+[.)]\s+(.+)$", raw_line)
        if unordered or ordered:
            _close_paragraph(output, paragraph)
            target = "ul" if unordered else "ol"
            if list_type != target:
                close_list()
                output.append("<{}>".format(target))
                list_type = target
            text = unordered.group(1) if unordered else ordered.group(1)
            output.append("<li>{}</li>".format(html.escape(text)))
            continue
        quote = re.match(r"^>\s?(.*)$", raw_line)
        if quote:
            _close_paragraph(output, paragraph)
            close_list()
            output.append(
                "<blockquote>{}</blockquote>".format(
                    html.escape(quote.group(1))
                )
            )
            continue
        if re.fullmatch(r"\s*(?:---+|\*\*\*+|___+)\s*", raw_line):
            _close_paragraph(output, paragraph)
            close_list()
            output.append("<hr>")
            continue
        close_list()
        paragraph.append(raw_line)

    if in_code:
        output.append(
            "<pre><code{}>{}</code></pre>".format(
                (
                    ' class="language-{}"'.format(html.escape(code_language))
                    if code_language
                    else ""
                ),
                html.escape("\n".join(code_lines)),
            )
        )
    _close_paragraph(output, paragraph)
    close_list()
    return "\n".join(output)


def _report_html(markdown: str, title: str) -> str:
    body = _markdown_body(markdown)
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>{title}</title>
  <style>
    :root {{ color-scheme: light dark; --bg:#f5f6f3; --paper:#fffefb; --ink:#202421; --muted:#66706a; --line:#dce2dc; --accent:#176b5b; }}
    * {{ box-sizing:border-box }}
    html,body {{ margin:0; min-height:100%; background:var(--bg); color:var(--ink); font:15px/1.7 Inter,"Noto Sans SC",system-ui,sans-serif }}
    body {{ padding:32px 18px }} article {{ width:min(900px,100%); margin:auto; padding:clamp(24px,6vw,68px); border:1px solid var(--line); border-radius:18px; background:var(--paper) }}
    h1,h2,h3,h4,h5,h6 {{ margin:1.7em 0 .55em; line-height:1.25; letter-spacing:-.02em }} h1:first-child {{ margin-top:0 }} p {{ margin:.7em 0 }}
    ul,ol {{ padding-left:1.5rem }} li {{ margin:.25rem 0 }} blockquote {{ margin:1.25rem 0; padding:.7rem 1rem; border-left:3px solid var(--accent); color:var(--muted) }}
    pre {{ overflow:auto; padding:16px; border:1px solid var(--line); border-radius:10px; background:var(--bg) }} code {{ font:13px/1.55 ui-monospace,SFMono-Regular,monospace }}
    hr {{ margin:2rem 0; border:0; border-top:1px solid var(--line) }}
    footer {{ margin-top:3rem; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); font-size:12px }}
    @media(prefers-color-scheme:dark) {{ :root {{ --bg:#191c19; --paper:#222622; --ink:#f1f3ef; --muted:#abb4ad; --line:#394039; --accent:#88c5aa }} }}
  </style>
</head>
<body>
  <article>
{body}
    <footer>Rendered by private-fund-compute-worker · {renderer}</footer>
  </article>
</body>
</html>
""".format(
        title=html.escape(title),
        body=body,
        renderer=REPORT_RENDERER_VERSION,
    )


def _render_pdf_with_reportlab(
    markdown: str, title: str, destination: Path
) -> None:
    try:
        from reportlab import rl_config  # type: ignore
        from reportlab.lib.pagesizes import A4  # type: ignore
        from reportlab.lib.styles import getSampleStyleSheet  # type: ignore
        from reportlab.platypus import (  # type: ignore
            Paragraph,
            SimpleDocTemplate,
            Spacer,
        )
        from xml.sax.saxutils import escape
    except ImportError as exc:
        raise DependencyUnavailableError(
            "render_report PDF requires reportlab"
        ) from exc

    previous_invariant = getattr(rl_config, "invariant", 0)
    rl_config.invariant = 1
    try:
        document = SimpleDocTemplate(
            str(destination),
            pagesize=A4,
            title=title,
            author="private-fund-compute-worker",
        )
        styles = getSampleStyleSheet()
        story: List[Any] = [Paragraph(escape(title), styles["Title"])]
        for line in markdown.splitlines():
            if not line.strip():
                story.append(Spacer(1, 6))
                continue
            heading = re.match(r"^(#{1,6})\s+(.+)$", line)
            if heading:
                level = min(3, len(heading.group(1)))
                story.append(
                    Paragraph(
                        escape(heading.group(2)),
                        styles["Heading{}".format(level)],
                    )
                )
            else:
                story.append(
                    Paragraph(
                        escape(re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", line)),
                        styles["BodyText"],
                    )
                )
        document.build(story)
    finally:
        rl_config.invariant = previous_invariant


def _temporary_pdf(output_directory: Path) -> Path:
    handle, name = tempfile.mkstemp(
        prefix=".compute-report-", suffix=".pdf", dir=str(output_directory)
    )
    os.close(handle)
    path = Path(name)
    path.unlink()
    return path


def render_report(
    input_path: Path,
    output_directory: Path,
    options: Mapping[str, Any],
) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    markdown = _canonical_markdown(input_path)
    title = _report_title(markdown, input_path, options)
    render_pdf = _bool_option(options, "renderPdf", True)
    require_pdf = _bool_option(options, "requirePdf", False)
    if require_pdf and not render_pdf:
        raise ComputeOperationError(
            "options.requirePdf requires renderPdf=true", "invalid_options"
        )
    html_text = _report_html(markdown, title)
    source_checksum = sha256_file(input_path)

    pdf_temporary: Optional[Path] = None
    pdf_status = "disabled"
    pdf_error: Optional[str] = None
    if render_pdf:
        pdf_temporary = _temporary_pdf(output_directory)
        try:
            _render_pdf_with_reportlab(markdown, title, pdf_temporary)
            pdf_status = "generated"
        except Exception as exc:
            try:
                pdf_temporary.unlink()
            except FileNotFoundError:
                pass
            pdf_temporary = None
            pdf_status = "unavailable"
            pdf_error = "{}: {}".format(type(exc).__name__, exc)
            if require_pdf:
                if isinstance(exc, ComputeOperationError):
                    raise
                raise ComputeOperationError(
                    "Required PDF rendering failed: {}".format(exc),
                    "render_failed",
                ) from exc

    digest_input = "{}\n{}\n{}\n{}".format(
        source_checksum, title, REPORT_RENDERER_VERSION, pdf_status
    )
    digest = hashlib.sha256(digest_input.encode("utf-8")).hexdigest()
    stem = _safe_output_stem(
        options.get("outputBasename"),
        "report-{}".format(digest[:12]),
    )
    markdown_path = generated_output_path(
        output_directory, "{}.md".format(stem)
    )
    html_path = generated_output_path(
        output_directory, "{}.html".format(stem)
    )
    if markdown_path.resolve() == input_path.resolve():
        if pdf_temporary is not None:
            try:
                pdf_temporary.unlink()
            except FileNotFoundError:
                pass
        raise ComputeOperationError(
            "Rendered report may not overwrite its Markdown source",
            "source_overwrite_forbidden",
        )
    write_bytes_new_or_identical(markdown.encode("utf-8"), markdown_path)
    write_bytes_new_or_identical(html_text.encode("utf-8"), html_path)
    artifacts = [
        artifact_descriptor(
            markdown_path, output_directory, "text/markdown; charset=utf-8"
        ),
        artifact_descriptor(
            html_path, output_directory, "text/html; charset=utf-8"
        ),
    ]

    if pdf_temporary is not None:
        pdf_path = generated_output_path(
            output_directory, "{}.pdf".format(stem)
        )
        try:
            commit_temporary_new_or_identical(pdf_temporary, pdf_path)
            pdf_temporary = None
        finally:
            if pdf_temporary is not None:
                try:
                    pdf_temporary.unlink()
                except FileNotFoundError:
                    pass
        artifacts.append(
            artifact_descriptor(
                pdf_path, output_directory, "application/pdf"
            )
        )

    manifest = {
        "manifestVersion": 1,
        "operation": "render_report",
        "rendererVersion": REPORT_RENDERER_VERSION,
        "sourceName": input_path.name,
        "sourceChecksum": source_checksum,
        "title": title,
        "pdf": {
            "requested": render_pdf,
            "required": require_pdf,
            "status": pdf_status,
            "error": pdf_error,
        },
        "outputs": artifacts,
    }
    manifest_path = generated_output_path(
        output_directory, "{}.manifest.json".format(stem)
    )
    write_json_new_or_identical(manifest, manifest_path)
    manifest_artifact = artifact_descriptor(
        manifest_path, output_directory, "application/json"
    )
    artifacts.append(manifest_artifact)
    metrics = {
        "inputChecksum": source_checksum,
        "rendererVersion": REPORT_RENDERER_VERSION,
        "markdownBytes": markdown_path.stat().st_size,
        "htmlBytes": html_path.stat().st_size,
        "pdfStatus": pdf_status,
        "artifactCount": len(artifacts),
    }
    return manifest_path.name, artifacts, metrics
