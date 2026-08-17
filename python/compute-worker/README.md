# Private Fund Compute Worker

This process is the Python compute sidecar for the TypeScript platform. It has
no authentication, tenant resolution, queue ownership, or business-database
responsibilities. The caller must resolve authorization before invoking it.

The worker reads one `ComputeRequest` JSON object per line from stdin and writes
exactly one `ComputeResponse` JSON object per line to stdout. Logs and tracebacks
are written to stderr only.

Implemented operations:

- `extract_pdf` using PyMuPDF
- `extract_document` for bounded DOCX, PPTX, CSV, Markdown, and UTF-8 text
- `render_pdf_page` using PyMuPDF, producing PNG plus a JSON manifest
- `extract_workbook` using openpyxl
- `derive_workbook` using openpyxl with XLSM/VBA preservation checks
- `fetch_market_data` using an offline fixture or AKShare A/H-share adapter
- `render_report` producing deterministic Markdown/HTML and optional PDF

Every successful extraction writes an atomic NDJSON records artifact. Artifact
paths in the response are relative to the requested output directory, and each
artifact includes a SHA-256 checksum and byte size.

## Run

```bash
python3 python/compute-worker/worker.py --health
python3 python/compute-worker/worker.py --once
python3 python/compute-worker/worker.py
```

The first command is a process-level health probe. `--once` consumes one request
and exits, which is the mode used by `@private-fund/compute-client`. With no
flag, the process continues until stdin closes.

Inputs and output directories must be absolute paths. Input files and output
directories may not themselves be symbolic links. Generated artifact names are
owned by the worker and cannot escape the output directory.

## Development

```bash
python3 -m unittest discover -s python/compute-worker/tests -v
```

The base install contains only the PDF/workbook dependencies and never resolves
or imports AKShare:

```bash
pip install './python/compute-worker'
```

Missing optional dependencies produce explicit failed responses instead of
partial artifacts.

Additional providers/renderers can be installed with:

```bash
pip install './python/compute-worker[market,pdf]'
```

The `market` extra pins AKShare to `1.18.81`, whose package metadata explicitly
supports Python 3.9 and newer. On Python 3.9 it also pins urllib3 to `1.26.20`
so the macOS system Python's LibreSSL runtime is not paired with an unsupported
urllib3 2.x build. Installing the base package or only the `pdf` extra is
therefore independent of AKShare and its larger dependency graph. The offline
`fixture` market provider is always available without the `market` extra.

`fetch_market_data` reads an auditable JSON request descriptor from
`inputPath`. The descriptor contains `provider`, `ticker`, `startDate`, and
`endDate`; the offline `fixture` provider additionally contains `bars`.
AKShare requests use raw/unadjusted daily prices.

`derive_workbook` accepts `options.changes`, each with `sheet`, `cell`, and
exactly one of `value` or `formula`. Populated targets require
`expectedCurrentValue` unless the caller explicitly enables
`allowOverwriteWithoutExpected`. The output is a new deterministic version;
the source workbook is never saved or overwritten.
