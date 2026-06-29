"""Make the repo-root `src/` importable so tests can `import evidence_schema`."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

FIXTURES = Path(__file__).resolve().parent / "fixtures"
OUTPUTS = Path(__file__).resolve().parent / "outputs"


def _load(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.fixture
def pdf_blocks():
    return _load("pdf_parsed.json")


@pytest.fixture
def excel_blocks():
    return _load("excel_parsed.json")


@pytest.fixture
def ppt_blocks():
    return _load("ppt_parsed.json")


@pytest.fixture
def word_blocks():
    return _load("word_parsed.json")


@pytest.fixture
def markdown_blocks():
    return _load("markdown_parsed.json")


@pytest.fixture
def qa_blocks():
    return _load("qa_parsed.json")


@pytest.fixture
def memo_blocks():
    return _load("memo_parsed.json")


@pytest.fixture
def outputs_dir():
    OUTPUTS.mkdir(parents=True, exist_ok=True)
    return OUTPUTS
