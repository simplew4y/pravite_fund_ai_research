from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List

import yaml

PROJECT_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class DatasetSpec:
    dataset_id: str
    collection_name: str
    gt_path: str
    persist_directory: str


DATASET_SPECS: Dict[str, DatasetSpec] = {
    "financebench": DatasetSpec(
        dataset_id="financebench",
        collection_name="financebench",
        gt_path=str(PROJECT_ROOT / "test" / "gt" / "financebench_145_gt.json"),
        persist_directory="/root/autodl-tmp/RAG_Agent_data/finance_bench/database_financebench",
    ),
    "finder": DatasetSpec(
        dataset_id="finder",
        collection_name="finder",
        gt_path=str(PROJECT_ROOT / "test" / "gt" / "finder_sampled_71_gt.json"),
        persist_directory="/root/autodl-tmp/RAG_Agent_data/finder/database_finder",
    ),
    "lotus": DatasetSpec(
        dataset_id="lotus",
        collection_name="lotus",
        gt_path=str(PROJECT_ROOT / "test" / "gt" / "lotus_108_dedup_gt.json"),
        persist_directory="/root/autodl-tmp/RAG_Agent_data/lotus/20250701/database_lotus",
    ),
    "secque": DatasetSpec(
        dataset_id="secque",
        collection_name="secque",
        gt_path=str(PROJECT_ROOT / "test" / "gt" / "secque_sample_100_retrieval_gt.json"),
        persist_directory="/root/autodl-tmp/RAG_Agent_data/secque/database_secque",
    ),
    "zeekr": DatasetSpec(
        dataset_id="zeekr",
        collection_name="zeekr",
        gt_path=str(PROJECT_ROOT / "test" / "gt" / "zeekr_134_dedup_gt.json"),
        persist_directory="/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/database_zeekr",
    ),
}

TOKEN_PATTERN = re.compile(r"[\u4e00-\u9fff]|[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?")
NUMBER_PATTERN = re.compile(r"\d+(?:\.\d+)?")
YEAR_PATTERN = re.compile(r"(?:19|20)\d{2}")


def load_project_config(config_path: str | None = None) -> Dict[str, Any]:
    path = Path(config_path) if config_path else (PROJECT_ROOT / "config" / "production.yaml")
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def iter_dataset_specs(dataset_ids: Iterable[str] | None = None) -> List[DatasetSpec]:
    if dataset_ids is None:
        return [DATASET_SPECS[key] for key in DATASET_SPECS]
    return [DATASET_SPECS[key] for key in dataset_ids]


def get_question(item: Dict[str, Any]) -> str:
    return item.get("question") or item.get("original_question") or item.get("text") or ""


def load_ground_truth(gt_path: str) -> List[Dict[str, Any]]:
    with open(gt_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    def has_positive_entries(item: Dict[str, Any]) -> bool:
        return bool(item.get("content") or item.get("positives"))

    return [item for item in data if has_positive_entries(item)]


def normalise_text(text: Any) -> str:
    if text is None:
        return ""
    return " ".join(str(text).split()).strip().lower()


def texts_match(a: Any, b: Any) -> bool:
    na = normalise_text(a)
    nb = normalise_text(b)
    if not na or not nb:
        return False
    return na in nb or nb in na


def simple_tokens(text: Any) -> List[str]:
    if text is None:
        return []
    return [token.lower() for token in TOKEN_PATTERN.findall(str(text))]


def extract_numbers(text: Any) -> set[str]:
    if text is None:
        return set()
    return set(NUMBER_PATTERN.findall(str(text)))


def extract_years(text: Any) -> set[int]:
    if text is None:
        return set()
    return {int(value) for value in YEAR_PATTERN.findall(str(text))}


def detect_query_language(text: Any) -> str:
    text = str(text or "")
    has_zh = any("\u4e00" <= ch <= "\u9fff" for ch in text)
    has_ascii_alpha = any(("a" <= ch.lower() <= "z") for ch in text)
    if has_zh and has_ascii_alpha:
        return "mixed"
    if has_zh:
        return "zh"
    if has_ascii_alpha:
        return "en"
    return "other"


def parse_doc_year(value: Any) -> float:
    text = str(value or "").strip()
    if len(text) >= 4 and text[:4].isdigit():
        return float(int(text[:4]))
    return float("nan")


def extract_page_number(metadata: Dict[str, Any]) -> float:
    for key in ("page_idx", "page_number", "page", "pageIndex"):
        value = metadata.get(key)
        if value is None or value == "":
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return float("nan")
