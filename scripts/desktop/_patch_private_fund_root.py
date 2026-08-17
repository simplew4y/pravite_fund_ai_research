#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

path = Path("/home/code/pravite_fund_ai_research/omnigent/omnigent/server/routes/private_fund_pdf.py")
text = path.read_text(encoding="utf-8")
if "_desktop_private_fund_root" in text:
    print("already patched")
    raise SystemExit(0)

old = """_PRIVATE_FUND_ROOT = Path(__file__).resolve().parents[4]
_PRIVATE_FUND_SRC = _PRIVATE_FUND_ROOT / "src"
if str(_PRIVATE_FUND_SRC) not in sys.path:
    sys.path.insert(0, str(_PRIVATE_FUND_SRC))
"""

new = '''def _desktop_private_fund_root() -> Path:
    """Resolve monorepo root for desktop/site-packages installs."""
    env_root = os.environ.get("PRIVATE_FUND_PROJECT_ROOT")
    if env_root:
        return Path(env_root).expanduser().resolve()
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "src" / "pdf_research_demo").exists() or (
            parent / "FinSagent" / "data_pipeline" / "private_fund_directory_ingest.py"
        ).exists():
            return parent
    return here.parents[4]


_PRIVATE_FUND_ROOT = _desktop_private_fund_root()
_PRIVATE_FUND_SRC = _PRIVATE_FUND_ROOT / "src"
if str(_PRIVATE_FUND_SRC) not in sys.path:
    sys.path.insert(0, str(_PRIVATE_FUND_SRC))
'''

if old not in text:
    raise SystemExit("pattern not found")

if "import os" not in text[:800]:
    text = text.replace(
        "from __future__ import annotations\n",
        "from __future__ import annotations\n\nimport os\n",
        1,
    )

path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("patched", path)
