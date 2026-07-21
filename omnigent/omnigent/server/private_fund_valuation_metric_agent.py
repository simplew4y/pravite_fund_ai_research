"""Skill-driven, evidence-validated valuation metric extraction."""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import unicodedata
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Protocol

SKILL_NAME = "private-fund-valuation-metrics"
EXTRACTOR_VERSION = "valuation-metric-skill-v4"
MIN_CONFIDENCE = 0.65
MAX_FACT_CANDIDATES = 600
MAX_DATE_CANDIDATES = 80

_SKILL_ROOT = (
    Path(__file__).resolve().parents[1]
    / "resources"
    / "private_fund_skills"
    / SKILL_NAME
)
_SKILL_PATH = _SKILL_ROOT / "SKILL.md"
_SCHEMA_PATH = _SKILL_ROOT / "references" / "output-schema.json"

_METRIC_UNITS = {
    "quarter_net_profit_yoy": "percent",
    "quarter_gross_margin_qoq_delta": "percentage_point",
    "forward_pe": "multiple",
    "avg_turnover_amount_20d": "currency",
    "quarter_revenue_growth_qoq": "percentage_point",
}
_METRIC_KEYS = tuple(_METRIC_UNITS)
_DIRECT_METRICS = {"forward_pe", "avg_turnover_amount_20d"}
_FINANCIAL_TERMS = (
    "revenue",
    "revenues",
    "sales",
    "turnover",
    "net profit",
    "net income",
    "pat ni",
    "gross profit",
    "gross margin",
    "cogs",
    "cost of sales",
    "operating cost",
    "forward pe",
    "forward p/e",
    "fwd pe",
    "ntm pe",
    "fy1 pe",
    "average turnover",
    "trading value",
    "营业收入",
    "收入",
    "销售额",
    "归母净利润",
    "净利润",
    "归属于母公司",
    "毛利",
    "毛利率",
    "营业成本",
    "销售成本",
    "预测市盈率",
    "动态市盈率",
    "成交额",
)
_DATE_TERMS = (
    "valuation date",
    "valuation as of",
    "as of date",
    "as at",
    "base date",
    "pricing date",
    "model date",
    "估值日",
    "估值日期",
    "估值基准日",
    "基准日",
    "数据日期",
    "截止日期",
)
_MONTH_NUMBERS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


class ValuationMetricChatClient(Protocol):
    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str: ...


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _decode(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _digest(*parts: Any, length: int = 28) -> str:
    payload = "\0".join(str(part or "") for part in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().casefold()
    text = text.replace("_", " ").replace("/", " ")
    text = re.sub(r"[^a-z0-9%\u3400-\u9fff.-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _safe_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _confidence(value: Any) -> float:
    number = _safe_float(value)
    return min(1.0, max(0.0, number if number is not None else 0.0))


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {
        str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def ensure_agent_extraction_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS valuation_metric_agent_extractions (
            extraction_id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL,
            series_id TEXT NOT NULL,
            model_version_id TEXT NOT NULL,
            doc_id TEXT NOT NULL,
            extractor_version TEXT NOT NULL,
            skill_name TEXT NOT NULL,
            target_period TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            valuation_date TEXT,
            output_json TEXT NOT NULL DEFAULT '{}',
            raw_response TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(model_version_id, extractor_version, target_period)
        );
        CREATE INDEX IF NOT EXISTS ix_metric_agent_extraction_latest
            ON valuation_metric_agent_extractions(model_version_id, updated_at DESC);
        """
    )


def _parse_json_object(text: str) -> dict[str, Any]:
    candidate = str(text or "").strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", candidate, flags=re.IGNORECASE)
    if fenced:
        candidate = fenced.group(1).strip()
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("Agent response did not contain a JSON object") from None
        payload = json.loads(candidate[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("Agent response must be a JSON object")
    return payload


def _chat_json(
    llm_client: ValuationMetricChatClient,
    messages: list[dict[str, str]],
) -> tuple[dict[str, Any], str]:
    raw = llm_client.chat(messages, max_tokens=5000, temperature=0.0)
    try:
        return _parse_json_object(raw), raw
    except (ValueError, json.JSONDecodeError):
        repaired = llm_client.chat(
            [
                {
                    "role": "system",
                    "content": (
                        "Repair the supplied response into one valid JSON object matching the "
                        "requested schema. Return JSON only and do not invent new evidence."
                    ),
                },
                {"role": "user", "content": raw[:80_000]},
            ],
            max_tokens=5000,
            temperature=0.0,
        )
        return _parse_json_object(repaired), repaired


def _period_sort_key(value: Any) -> tuple[int, int, str]:
    text = str(value or "")
    canonical = _canonical_quarter(text)
    match = re.fullmatch(r"(?P<year>20\d{2})Q(?P<quarter>[1-4])", canonical)
    if match:
        return int(match.group("year")), int(match.group("quarter")), text
    return 0, 0, text


def _canonical_quarter(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    patterns = (
        r"(?P<year>20\d{2}).*?[Qq](?P<quarter>[1-4])",
        r"[Qq](?P<quarter>[1-4]).*?(?P<year>20\d{2})",
        r"(?P<quarter>[1-4])[Qq][ -]?(?P<year>\d{2})",
        r"[Qq](?P<quarter>[1-4])[ -]?(?P<year>\d{2})",
    )
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            year = int(match.group("year"))
            if year < 100:
                year += 1900 if year >= 70 else 2000
            if 1990 <= year <= 2050:
                return f"{year}Q{int(match.group('quarter'))}"
    return ""


def _fact_candidates(
    conn: sqlite3.Connection,
    doc_id: str,
    *,
    target_period: str = "",
) -> list[dict[str, Any]]:
    if "metric_facts" not in _tables(conn):
        return []
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(metric_facts)")}
    alias = "metric_alias" if "metric_alias" in columns else "NULL AS metric_alias"
    value_text = "value_text" if "value_text" in columns else "NULL AS value_text"
    formula = "formula" if "formula" in columns else "NULL AS formula"
    confidence = "confidence" if "confidence" in columns else "0.5 AS confidence"
    quality = (
        "quality_status" if "quality_status" in columns else "'review_required' AS quality_status"
    )
    quality_filter = (
        "AND COALESCE(quality_status, 'review_required') <> 'rejected'"
        if "quality_status" in columns
        else ""
    )
    rows = conn.execute(
        f"""
        SELECT fact_id, metric_name, {alias}, period, {value_text}, value_numeric,
               unit, sheet_name, cell_ref, {formula}, {confidence}, {quality}
        FROM metric_facts
        WHERE doc_id=? {quality_filter}
        """,
        (doc_id,),
    ).fetchall()
    groups: dict[str, list[dict[str, Any]]] = {}
    scores: dict[str, int] = {}
    canonical_target = _canonical_quarter(target_period)
    for row in rows:
        fact = dict(row)
        group_key = _normalize(f"{fact.get('metric_name', '')} {fact.get('metric_alias', '')}")
        if not group_key:
            continue
        period = str(fact.get("period") or "")
        score = 30 if any(term in group_key for term in _FINANCIAL_TERMS) else 0
        if _period_sort_key(period)[:2] != (0, 0):
            score += 12
        if canonical_target and _canonical_quarter(period) == canonical_target:
            score += 100
        if any(term in group_key for term in ("forward", "fwd", "ntm", "20d", "20 day")):
            score += 20
        groups.setdefault(group_key, []).append(fact)
        scores[group_key] = max(scores.get(group_key, 0), score)

    ranked_groups = sorted(
        groups,
        key=lambda key: (scores.get(key, 0), len(groups[key]), key),
        reverse=True,
    )
    selected: list[dict[str, Any]] = []
    for group_key in ranked_groups[:100]:
        group = sorted(
            groups[group_key],
            key=lambda fact: _period_sort_key(fact.get("period")),
            reverse=True,
        )
        for fact in group[:8]:
            selected.append(
                {
                    "evidence_id": f"fact:{fact['fact_id']}",
                    "metric_name": str(fact.get("metric_name") or ""),
                    "metric_alias": str(fact.get("metric_alias") or ""),
                    "period": str(fact.get("period") or ""),
                    "value_numeric": _safe_float(fact.get("value_numeric")),
                    "value_text": str(fact.get("value_text") or ""),
                    "unit": str(fact.get("unit") or ""),
                    "source": f"{fact.get('sheet_name', '')}!{fact.get('cell_ref', '')}",
                    "formula": str(fact.get("formula") or ""),
                    "confidence": _confidence(fact.get("confidence")),
                    "quality_status": str(fact.get("quality_status") or ""),
                }
            )
            if len(selected) >= MAX_FACT_CANDIDATES:
                return selected
    return selected


def _date_candidates(conn: sqlite3.Connection, doc_id: str) -> list[dict[str, Any]]:
    if "excel_cells" not in _tables(conn):
        return []
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(excel_cells)")}
    required = {"cell_id", "doc_id", "sheet_name", "cell_ref"}
    if not required.issubset(columns):
        return []

    def select(column: str, fallback: str = "NULL") -> str:
        return column if column in columns else f"{fallback} AS {column}"

    rows = conn.execute(
        f"""
        SELECT cell_id, sheet_name, cell_ref, {select('display_value')},
               {select('raw_value')}, {select('numeric_value')},
               {select('row_label')}, {select('col_label')}, {select('number_format')}
        FROM excel_cells WHERE doc_id=?
        """,
        (doc_id,),
    ).fetchall()
    candidates: list[dict[str, Any]] = []
    for row in rows:
        cell = dict(row)
        context = _normalize(
            " ".join(
                str(cell.get(key) or "")
                for key in ("row_label", "col_label", "display_value", "number_format")
            )
        )
        if not any(term in context for term in _DATE_TERMS):
            continue
        candidates.append(
            {
                "evidence_id": f"cell:{cell['cell_id']}",
                "source": f"{cell['sheet_name']}!{cell['cell_ref']}",
                "display_value": str(cell.get("display_value") or ""),
                "raw_value": str(cell.get("raw_value") or ""),
                "numeric_value": _safe_float(cell.get("numeric_value")),
                "row_label": str(cell.get("row_label") or ""),
                "col_label": str(cell.get("col_label") or ""),
                "number_format": str(cell.get("number_format") or ""),
            }
        )
        if len(candidates) >= MAX_DATE_CANDIDATES:
            break
    return candidates


def build_evidence_packet(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    doc_id: str,
    version: dict[str, Any],
    target_period: str,
) -> dict[str, Any]:
    return {
        "dataset_id": dataset_id,
        "document": {
            "evidence_id": f"document:{doc_id}",
            "doc_id": doc_id,
            "original_filename": str(version.get("original_filename") or ""),
            "document_date": str(version.get("document_date") or ""),
            "model_type": str(version.get("model_type") or ""),
        },
        "target_period_hint": target_period,
        "fact_candidates": _fact_candidates(conn, doc_id, target_period=target_period),
        "date_candidates": _date_candidates(conn, doc_id),
    }


def _previous_quarter(period: str) -> str:
    match = re.fullmatch(r"(?P<year>20\d{2})Q(?P<quarter>[1-4])", period)
    if not match:
        return ""
    year = int(match.group("year"))
    quarter = int(match.group("quarter"))
    return f"{year - 1}Q4" if quarter == 1 else f"{year}Q{quarter - 1}"


def _prior_year_quarter(period: str) -> str:
    match = re.fullmatch(r"(?P<year>20\d{2})Q(?P<quarter>[1-4])", period)
    if not match:
        return ""
    return f"{int(match.group('year')) - 1}Q{int(match.group('quarter'))}"


def _same_metric_label(facts: list[dict[str, Any]]) -> bool:
    labels = {
        _normalize(f"{fact.get('metric_name', '')} {fact.get('metric_alias', '')}")
        for fact in facts
    }
    labels.discard("")
    return len(labels) == 1


def _fact_for_period(facts: list[dict[str, Any]], period: str) -> dict[str, Any] | None:
    return next(
        (fact for fact in facts if _canonical_quarter(fact.get("period")) == period),
        None,
    )


def _ratio_growth(current: float | None, prior: float | None) -> float | None:
    if current is None or prior is None or abs(prior) <= 1e-12:
        return None
    return current / prior - 1.0


def _server_calculation(
    metric_key: str,
    facts: list[dict[str, Any]],
    target_period: str,
) -> tuple[float | None, str]:
    if metric_key in _DIRECT_METRICS:
        if len(facts) != 1:
            return None, ""
        fact = facts[0]
        label = _normalize(f"{fact.get('metric_name', '')} {fact.get('metric_alias', '')}")
        if metric_key == "forward_pe" and not any(
            term in label
            for term in (
                "forward pe",
                "forward p e",
                "fwd pe",
                "ntm pe",
                "fy1 pe",
                "预测市盈率",
                "动态市盈率",
            )
        ):
            return None, ""
        if metric_key == "avg_turnover_amount_20d" and not (
            ("20" in label or "20d" in label)
            and any(term in label for term in ("turnover", "trading value", "成交额"))
        ):
            return None, ""
        value = _safe_float(fact.get("value_numeric"))
        return value, f"server_direct({fact.get('evidence_id', '')})"

    target = _canonical_quarter(target_period)
    if not target:
        return None, ""
    if metric_key == "quarter_net_profit_yoy":
        if len(facts) != 2 or not _same_metric_label(facts):
            return None, ""
        current = _fact_for_period(facts, target)
        prior = _fact_for_period(facts, _prior_year_quarter(target))
        value = _ratio_growth(
            _safe_float((current or {}).get("value_numeric")),
            _safe_float((prior or {}).get("value_numeric")),
        )
        if value is None:
            return None, ""
        return value, (
            f"server_growth({(current or {}).get('evidence_id', '')},"
            f"{(prior or {}).get('evidence_id', '')})"
        )
    if metric_key == "quarter_gross_margin_qoq_delta":
        if len(facts) == 2 and _same_metric_label(facts):
            current = _fact_for_period(facts, target)
            prior = _fact_for_period(facts, _previous_quarter(target))
            current_value = _safe_float((current or {}).get("value_numeric"))
            prior_value = _safe_float((prior or {}).get("value_numeric"))
            if current_value is None or prior_value is None:
                return None, ""
            if 1.5 < abs(current_value) <= 100:
                current_value /= 100.0
            if 1.5 < abs(prior_value) <= 100:
                prior_value /= 100.0
            if not (-1.0 <= current_value <= 1.5 and -1.0 <= prior_value <= 1.5):
                return None, ""
            return current_value - prior_value, (
                f"server_delta({(current or {}).get('evidence_id', '')},"
                f"{(prior or {}).get('evidence_id', '')})"
            )
        if len(facts) == 4:
            by_period: dict[str, list[dict[str, Any]]] = {}
            for fact in facts:
                by_period.setdefault(_canonical_quarter(fact.get("period")), []).append(fact)

            def calculated_margin(period: str) -> tuple[float | None, list[str]]:
                period_facts = by_period.get(period) or []
                revenue = next(
                    (
                        fact
                        for fact in period_facts
                        if any(
                            term
                            in _normalize(
                                f"{fact.get('metric_name', '')} {fact.get('metric_alias', '')}"
                            )
                            for term in (
                                "revenue",
                                "revenues",
                                "sales",
                                "turnover",
                                "营业收入",
                                "收入",
                                "销售额",
                            )
                        )
                    ),
                    None,
                )
                gross = next(
                    (
                        fact
                        for fact in period_facts
                        if any(
                            term
                            in _normalize(
                                f"{fact.get('metric_name', '')} {fact.get('metric_alias', '')}"
                            )
                            for term in ("gross profit", "毛利润", "毛利")
                        )
                        and "margin"
                        not in _normalize(
                            f"{fact.get('metric_name', '')} {fact.get('metric_alias', '')}"
                        )
                        and "率"
                        not in _normalize(
                            f"{fact.get('metric_name', '')} {fact.get('metric_alias', '')}"
                        )
                    ),
                    None,
                )
                revenue_value = _safe_float((revenue or {}).get("value_numeric"))
                gross_value = _safe_float((gross or {}).get("value_numeric"))
                if revenue_value is None or gross_value is None or abs(revenue_value) <= 1e-12:
                    return None, []
                return gross_value / revenue_value, [
                    str((revenue or {}).get("evidence_id") or ""),
                    str((gross or {}).get("evidence_id") or ""),
                ]

            current_margin, current_ids = calculated_margin(target)
            prior_margin, prior_ids = calculated_margin(_previous_quarter(target))
            if current_margin is not None and prior_margin is not None:
                return current_margin - prior_margin, (
                    "server_margin_delta(" + ",".join(current_ids + prior_ids) + ")"
                )
        return None, ""
    if metric_key == "quarter_revenue_growth_qoq":
        if len(facts) != 4 or not _same_metric_label(facts):
            return None, ""
        previous = _previous_quarter(target)
        current = _fact_for_period(facts, target)
        current_yoy = _fact_for_period(facts, _prior_year_quarter(target))
        previous_fact = _fact_for_period(facts, previous)
        previous_yoy = _fact_for_period(facts, _prior_year_quarter(previous))
        current_growth = _ratio_growth(
            _safe_float((current or {}).get("value_numeric")),
            _safe_float((current_yoy or {}).get("value_numeric")),
        )
        previous_growth = _ratio_growth(
            _safe_float((previous_fact or {}).get("value_numeric")),
            _safe_float((previous_yoy or {}).get("value_numeric")),
        )
        if current_growth is None or previous_growth is None:
            return None, ""
        return current_growth - previous_growth, (
            "server_growth_delta("
            + ",".join(
                str((fact or {}).get("evidence_id", ""))
                for fact in (current, current_yoy, previous_fact, previous_yoy)
            )
            + ")"
        )
    return None, ""


def recalculate_agent_metrics(
    payload: dict[str, Any],
    *,
    evidence_packet: dict[str, Any],
    target_period_hint: str,
) -> dict[str, Any]:
    """Use Agent-selected evidence but never trust Agent arithmetic."""

    facts_by_id = {
        str(fact.get("evidence_id")): fact
        for fact in evidence_packet.get("fact_candidates") or []
        if isinstance(fact, dict) and fact.get("evidence_id")
    }
    raw_metrics = payload.get("metrics") if isinstance(payload.get("metrics"), list) else []
    target_period = _canonical_quarter(payload.get("target_period") or target_period_hint)
    warnings = payload.get("warnings") if isinstance(payload.get("warnings"), list) else []
    payload["warnings"] = warnings
    for raw in raw_metrics:
        if not isinstance(raw, dict) or raw.get("status") != "available":
            continue
        key = str(raw.get("metric_key") or "")
        if key not in _METRIC_UNITS:
            continue
        submitted_ids = [str(item) for item in raw.get("evidence_ids") or []]
        facts = [facts_by_id[item] for item in submitted_ids if item in facts_by_id]
        calculated, derivation = _server_calculation(key, facts, target_period)
        if calculated is None:
            raw["value_numeric"] = None
            raw["status"] = "unavailable"
            raw["method"] = "agent_evidence_not_calculable"
            warnings.append(f"指标 {key} 的 Agent 证据无法按固定公式重算，已置为空。")
            continue
        raw["value_numeric"] = calculated
        raw["method"] = "agent_identified_server_calculated"
        raw["derivation"] = derivation
        if key not in _DIRECT_METRICS:
            raw["period"] = target_period
    return payload


def reconcile_valuation_date(
    payload: dict[str, Any],
    *,
    evidence_packet: dict[str, Any],
) -> dict[str, Any]:
    """Prefer a full explicit filename date over coarse document metadata."""

    raw_date = payload.get("valuation_date")
    if not isinstance(raw_date, dict) or raw_date.get("status") != "available":
        return payload
    document = evidence_packet.get("document")
    document = document if isinstance(document, dict) else {}
    document_evidence = str(document.get("evidence_id") or "")
    evidence_ids = [str(item) for item in raw_date.get("evidence_ids") or []]
    has_cell_evidence = any(item.startswith("cell:") for item in evidence_ids)
    if document_evidence not in evidence_ids or has_cell_evidence:
        return payload
    filename = str(document.get("original_filename") or "")
    named = re.search(
        r"(?P<year>20\d{2})[_ .-](?P<month>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
        r"[_ .-](?P<day>\d{1,2})",
        filename,
        re.IGNORECASE,
    )
    parsed: date | None = None
    if named:
        try:
            parsed = date(
                int(named.group("year")),
                _MONTH_NUMBERS[named.group("month").lower()],
                int(named.group("day")),
            )
        except ValueError:
            parsed = None
    if parsed is None:
        numeric = re.search(
            r"(?P<year>20\d{2})[-_.]?(?P<month>0?[1-9]|1[0-2])"
            r"[-_.]?(?P<day>0?[1-9]|[12]\d|3[01])",
            filename,
        )
        if numeric:
            try:
                parsed = date(
                    int(numeric.group("year")),
                    int(numeric.group("month")),
                    int(numeric.group("day")),
                )
            except ValueError:
                parsed = None
    if parsed is None:
        return payload
    parsed_text = parsed.isoformat()
    submitted = str(raw_date.get("value") or "")
    if submitted and submitted != parsed_text:
        warnings = payload.get("warnings")
        warnings = warnings if isinstance(warnings, list) else []
        warnings.append(
            f"Agent 估值日 {submitted} 与完整文件名日期冲突，已采用 {parsed_text}。"
        )
        payload["warnings"] = warnings
    raw_date["value"] = parsed_text
    raw_date["source"] = filename
    raw_date["reason"] = "服务端从包含完整年月日的模型文件名格式化估值日。"
    return payload


def _empty_metric(key: str, target_period: str = "") -> dict[str, Any]:
    return {
        "metric_key": key,
        "value_numeric": None,
        "unit": _METRIC_UNITS[key],
        "period": target_period,
        "status": "unavailable",
        "confidence": 0.0,
        "method": "agent_not_found",
        "source": "",
        "evidence_ids": [],
        "derivation": "",
    }


def _metric_value_is_plausible(key: str, value: float) -> bool:
    if key == "forward_pe":
        return 0.0 < value < 2000.0
    if key == "avg_turnover_amount_20d":
        return value >= 0.0
    return -10.0 <= value <= 10.0


def validate_output(
    payload: dict[str, Any],
    *,
    allowed_evidence_ids: set[str],
    target_period_hint: str,
) -> dict[str, Any]:
    warnings = [str(item)[:500] for item in payload.get("warnings", []) if str(item).strip()]
    raw_metrics = payload.get("metrics") if isinstance(payload.get("metrics"), list) else []
    by_key: dict[str, dict[str, Any]] = {}
    for raw in raw_metrics:
        if not isinstance(raw, dict):
            continue
        key = str(raw.get("metric_key") or "")
        if key not in _METRIC_UNITS:
            warnings.append(f"忽略未知指标：{key or 'empty'}")
            continue
        if key in by_key:
            warnings.append(f"指标 {key} 返回多个候选，按不可用处理。")
            by_key[key] = {}
            continue
        by_key[key] = raw

    metrics: list[dict[str, Any]] = []
    for key in _METRIC_KEYS:
        raw = by_key.get(key) or {}
        raw_period = str(raw.get("period") or target_period_hint)
        normalized_period = (
            _canonical_quarter(raw_period)
            if key
            in {
                "quarter_net_profit_yoy",
                "quarter_gross_margin_qoq_delta",
                "quarter_revenue_growth_qoq",
            }
            else raw_period
        )
        result = _empty_metric(key, normalized_period)
        value = _safe_float(raw.get("value_numeric"))
        confidence = _confidence(raw.get("confidence"))
        evidence = [
            str(item)
            for item in (raw.get("evidence_ids") or [])
            if str(item) in allowed_evidence_ids
        ]
        submitted_evidence = [str(item) for item in (raw.get("evidence_ids") or [])]
        minimum_evidence = 1 if key in _DIRECT_METRICS else 2
        valid = (
            str(raw.get("status") or "") == "available"
            and value is not None
            and confidence >= MIN_CONFIDENCE
            and len(evidence) >= minimum_evidence
            and len(evidence) == len(submitted_evidence)
            and _metric_value_is_plausible(key, value)
        )
        if valid:
            result.update(
                {
                    "value_numeric": value,
                    "status": "available",
                    "confidence": confidence,
                    "method": str(raw.get("method") or "agent_skill"),
                    "source": str(raw.get("source") or ""),
                    "evidence_ids": list(dict.fromkeys(evidence)),
                    "derivation": str(raw.get("derivation") or ""),
                }
            )
        elif str(raw.get("status") or "") == "available":
            warnings.append(f"指标 {key} 未通过数值、置信度或证据校验，已置为空。")
        metrics.append(result)

    raw_date = payload.get("valuation_date")
    raw_date = raw_date if isinstance(raw_date, dict) else {}
    date_value = str(raw_date.get("value") or "")
    date_evidence = [
        str(item)
        for item in (raw_date.get("evidence_ids") or [])
        if str(item) in allowed_evidence_ids
    ]
    date_valid = False
    if date_value:
        try:
            parsed_date = date.fromisoformat(date_value)
            date_valid = 1990 <= parsed_date.year <= 2050
        except ValueError:
            date_valid = False
    date_valid = (
        date_valid
        and str(raw_date.get("status") or "") == "available"
        and _confidence(raw_date.get("confidence")) >= MIN_CONFIDENCE
        and bool(date_evidence)
        and len(date_evidence) == len(raw_date.get("evidence_ids") or [])
    )
    valuation_date = {
        "value": date_value if date_valid else None,
        "status": "available" if date_valid else "unavailable",
        "confidence": _confidence(raw_date.get("confidence")) if date_valid else 0.0,
        "source": str(raw_date.get("source") or "") if date_valid else "",
        "evidence_ids": list(dict.fromkeys(date_evidence)) if date_valid else [],
        "reason": str(raw_date.get("reason") or "")[:1000],
    }
    if date_value and not date_valid:
        warnings.append("估值日未通过日期、置信度或证据校验，已置为空。")
    return {
        "valuation_date": valuation_date,
        "target_period": _canonical_quarter(
            payload.get("target_period") or target_period_hint
        )
        or str(payload.get("target_period") or target_period_hint),
        "metrics": metrics,
        "warnings": list(dict.fromkeys(warnings)),
    }


def _row_payload(row: sqlite3.Row) -> dict[str, Any]:
    payload = dict(row)
    payload["formatted_output"] = _decode(payload.pop("output_json"), {})
    payload.pop("raw_response", None)
    return payload


def latest_agent_extraction(
    conn: sqlite3.Connection,
    *,
    model_version_id: str,
) -> dict[str, Any] | None:
    ensure_agent_extraction_schema(conn)
    row = conn.execute(
        """
        SELECT * FROM valuation_metric_agent_extractions
        WHERE model_version_id=?
        ORDER BY updated_at DESC LIMIT 1
        """,
        (model_version_id,),
    ).fetchone()
    return _row_payload(row) if row is not None else None


def extract_with_skill(
    conn: sqlite3.Connection,
    *,
    dataset_id: str,
    series_id: str,
    model_version_id: str,
    doc_id: str,
    version: dict[str, Any],
    target_period: str,
    llm_client: ValuationMetricChatClient,
) -> dict[str, Any]:
    ensure_agent_extraction_schema(conn)
    extraction_id = "vmae_" + _digest(model_version_id, EXTRACTOR_VERSION, target_period)
    cached = conn.execute(
        """
        SELECT * FROM valuation_metric_agent_extractions
        WHERE model_version_id=? AND extractor_version=? AND target_period=?
          AND status='completed'
        """,
        (model_version_id, EXTRACTOR_VERSION, target_period),
    ).fetchone()
    if cached is not None:
        return _row_payload(cached)

    packet = build_evidence_packet(
        conn,
        dataset_id=dataset_id,
        doc_id=doc_id,
        version=version,
        target_period=target_period,
    )
    allowed_evidence_ids = {
        str(packet["document"]["evidence_id"]),
        *(str(item["evidence_id"]) for item in packet["fact_candidates"]),
        *(str(item["evidence_id"]) for item in packet["date_candidates"]),
    }
    skill = _SKILL_PATH.read_text(encoding="utf-8")
    schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    messages = [
        {
            "role": "system",
            "content": (
                f"Apply the following skill exactly.\n\n{skill}\n\n"
                "Return a single JSON object only. Its JSON Schema is:\n"
                f"{json.dumps(schema, ensure_ascii=False)}"
            ),
        },
        {
            "role": "user",
            "content": (
                "Extract the valuation date and exactly five valuation metrics from this "
                "evidence packet. Use no outside facts.\n"
                + json.dumps(packet, ensure_ascii=False)
            ),
        },
    ]
    now = _now_iso()
    raw_response = ""
    try:
        raw_payload, raw_response = _chat_json(llm_client, messages)
        raw_payload = recalculate_agent_metrics(
            raw_payload,
            evidence_packet=packet,
            target_period_hint=target_period,
        )
        raw_payload = reconcile_valuation_date(raw_payload, evidence_packet=packet)
        formatted = validate_output(
            raw_payload,
            allowed_evidence_ids=allowed_evidence_ids,
            target_period_hint=target_period,
        )
        valuation_date = str((formatted.get("valuation_date") or {}).get("value") or "")
        conn.execute(
            """
            INSERT INTO valuation_metric_agent_extractions
                (extraction_id, dataset_id, series_id, model_version_id, doc_id,
                 extractor_version, skill_name, target_period, status, valuation_date,
                 output_json, raw_response, error_message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(model_version_id, extractor_version, target_period) DO UPDATE SET
                status='completed', valuation_date=excluded.valuation_date,
                output_json=excluded.output_json, raw_response=excluded.raw_response,
                error_message=NULL, updated_at=excluded.updated_at
            """,
            (
                extraction_id,
                dataset_id,
                series_id,
                model_version_id,
                doc_id,
                EXTRACTOR_VERSION,
                SKILL_NAME,
                target_period,
                valuation_date or None,
                _json(formatted),
                raw_response[:500_000],
                now,
                now,
            ),
        )
    except Exception as exc:  # noqa: BLE001 - invalid Agent output is persisted and isolated
        conn.execute(
            """
            INSERT INTO valuation_metric_agent_extractions
                (extraction_id, dataset_id, series_id, model_version_id, doc_id,
                 extractor_version, skill_name, target_period, status, valuation_date,
                 output_json, raw_response, error_message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', NULL, '{}', ?, ?, ?, ?)
            ON CONFLICT(model_version_id, extractor_version, target_period) DO UPDATE SET
                status='failed', raw_response=excluded.raw_response,
                error_message=excluded.error_message, updated_at=excluded.updated_at
            """,
            (
                extraction_id,
                dataset_id,
                series_id,
                model_version_id,
                doc_id,
                EXTRACTOR_VERSION,
                SKILL_NAME,
                target_period,
                raw_response[:500_000],
                str(exc)[:2000],
                now,
                now,
            ),
        )
    row = conn.execute(
        "SELECT * FROM valuation_metric_agent_extractions WHERE extraction_id=?",
        (extraction_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError("valuation metric Agent extraction was not persisted")
    return _row_payload(row)


__all__ = [
    "EXTRACTOR_VERSION",
    "SKILL_NAME",
    "build_evidence_packet",
    "ensure_agent_extraction_schema",
    "extract_with_skill",
    "latest_agent_extraction",
    "recalculate_agent_metrics",
    "reconcile_valuation_date",
    "validate_output",
]
