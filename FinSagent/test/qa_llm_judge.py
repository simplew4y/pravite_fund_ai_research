#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LLM-as-Judge with key-point aware evaluation.

Summary:
- Uses the OpenAI client to judge generated answers and evaluate
  coverage/accuracy of provided key points.
- Pass/fail mirrors the LLM verdict (CORRECT passes). If LLM fails, a
  deterministic fallback labels verdict using key-point matches only.

Inputs:
- --input_json: GT JSON/JSONL file(s) containing `question`, `key_points`, and
  the reference answer.
- --generated_answers_json: Optional generated-answer JSON/JSONL file(s) to be
  evaluated against GT after qid/index matching, with unique question fallback.
- Optional: --corpus to enable precise 424B2 exclusion via doc titles/metadata
- OpenAI args: --model, --workers, --reasoning_effort

Outputs:
- results.json: per-QA evaluation (LLM verdict, key-point coverage, pass/fail)
- details.csv: row-by-row breakdown for spreadsheet review
- summary.json: overall + by QA type

Example:
python test/qa_llm_judge.py --generated_answers_json /root/autodl-tmp/cjj/FinSagent_0212/test/experiment_preview_modes_20260409_173214/zeekr_run4_preview.jsonl  --out_dir /root/autodl-tmp/cjj/FinSagent_0212/test/experiment_preview_modes_20260409_173214/judge_preview/ --workers 4

"""

import argparse
import csv
import json
import math
import os
import re
import glob
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional
import logging
from tqdm import tqdm
from openai import OpenAI
import yaml

NUM_RE = re.compile(r"(\d[\d,]*\.?\d*)")
PCT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*%")

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

LIKERT_DIMENSIONS = [
    "Information Coverage",
    "Reasoning Chain",
    "Factual Consistency",
    "Clarity of Expression",
    "Analytical Depth",
]

# Silence noisy per-request HTTP logs from the OpenAI SDK's httpx transport.
# (e.g., "INFO:httpx:HTTP Request: POST ... 200 OK")
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def _is_truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y"}
    return False


def load_json(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def load_json_or_jsonl(path: str) -> Any:
    """
    Load data from a JSON or JSONL file.
    For .jsonl files: returns a list of all JSON objects.
    For .json files: returns the parsed JSON object.
    """
    path_lower = path.lower()
    if path_lower.endswith('.jsonl') or path_lower.endswith('.jsonlines'):
        data = []
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    data.append(json.loads(line))
        return data
    else:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

def load_answers(answers_path: str) -> Dict[str, Dict[str, Any]]:
    """
    Load answers from a single JSON/JSONL file, a directory of JSON/JSONL files, or a glob pattern.

    Expect rows shaped like {qid, question, generated_answer, doc_ids_used}.
    Returns a dict keyed by qid. Later files can overwrite earlier qids.
    """
    paths: List[str]
    if any(ch in answers_path for ch in ("*", "?", "[", "]")):
        paths = sorted(glob.glob(answers_path))
    elif os.path.isdir(answers_path):
        # 同时支持 .json 和 .jsonl 文件
        json_paths = sorted(glob.glob(os.path.join(answers_path, "*.json")))
        jsonl_paths = sorted(glob.glob(os.path.join(answers_path, "*.jsonl")))
        paths = json_paths + jsonl_paths
    else:
        paths = [answers_path]

    out: Dict[str, Dict[str, Any]] = {}
    for p in paths:
        try:
            data = load_json_or_jsonl(p)
            if not isinstance(data, list):
                logger.warning("answers file is not a list: %s", p)
                continue
            for row in data:
                qid = str(row.get("qid", ""))
                if not qid:
                    continue
                out[qid] = row
        except Exception as e:
            logger.error("Failed to load %s: %s", p, e)
    return out


def load_rows(path_or_glob: str) -> List[Dict[str, Any]]:
    """
    Load rows from JSON or JSONL files.
    Supports glob patterns and directories.
    """
    paths: List[str]
    if any(ch in path_or_glob for ch in ("*", "?", "[", "]")):
        paths = sorted(glob.glob(path_or_glob))
    elif os.path.isdir(path_or_glob):
        # 同时支持 .json 和 .jsonl 文件
        json_paths = sorted(glob.glob(os.path.join(path_or_glob, "*.json")))
        jsonl_paths = sorted(glob.glob(os.path.join(path_or_glob, "*.jsonl")))
        paths = json_paths + jsonl_paths
    else:
        paths = [path_or_glob]

    rows: List[Dict[str, Any]] = []
    for p in paths:
        try:
            data = load_json_or_jsonl(p)
            if isinstance(data, list):
                rows.extend([row for row in data if isinstance(row, dict)])
            else:
                logger.warning("generated answers file is not a list: %s", p)
        except Exception as e:
            logger.error("Failed to load %s: %s", p, e)
    return rows


def combine_preview_answer(preliminary_draft: Any, final_answer: Any) -> str:
    parts: List[str] = []
    for value in (preliminary_draft, final_answer):
        text = str(value or "").strip()
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def build_match_key(row: Dict[str, Any]) -> str | None:
    question = re.sub(r"\s+", " ", str(row.get("question") or row.get("original_question") or "").strip())
    if not question:
        return None
    return question


def get_row_index(row: Dict[str, Any]) -> Any:
    if row.get("index") is not None:
        return row.get("index")
    return row.get("idx")


def get_row_qid(row: Dict[str, Any], fallback: str = "") -> str:
    qid = str(row.get("qid", "")).strip()
    if qid:
        return qid
    row_index = get_row_index(row)
    if row_index is not None:
        return f"idx_{row_index}"
    key = build_match_key(row)
    if key:
        return f"question::{key}"
    return fallback


def _id_key(value: Any) -> str | None:
    if value is None:
        return None
    key = str(value).strip()
    return key or None


def _add_unique_match(
    mapping: Dict[str, Dict[str, Any]],
    duplicate_keys: set[str],
    key: str | None,
    row: Dict[str, Any],
) -> None:
    if not key:
        return
    if key in mapping:
        duplicate_keys.add(key)
        return
    mapping[key] = row


def load_gt_match_maps(path_or_glob: str) -> Dict[str, Dict[str, Dict[str, Any]]]:
    """
    Build GT lookup maps for generated-answer merging.

    Matching preference is qid -> index -> unique normalized question. Question
    fallback deliberately drops duplicate question texts to avoid assigning the
    wrong GT row to repeated questions.
    """
    maps: Dict[str, Dict[str, Dict[str, Any]]] = {
        "qid": {},
        "index": {},
        "question": {},
    }
    duplicates: Dict[str, set[str]] = {
        "qid": set(),
        "index": set(),
        "question": set(),
    }

    for row in load_rows(path_or_glob):
        _add_unique_match(maps["qid"], duplicates["qid"], _id_key(row.get("qid")), row)
        _add_unique_match(maps["index"], duplicates["index"], _id_key(get_row_index(row)), row)
        _add_unique_match(maps["question"], duplicates["question"], build_match_key(row), row)

    for match_type, keys in duplicates.items():
        for key in keys:
            maps[match_type].pop(key, None)
        if keys:
            logger.warning(
                "Dropped %d duplicate GT %s match keys from fallback matching",
                len(keys),
                match_type,
            )
    return maps


def get_reference_answer(row: Dict[str, Any]) -> str:
    for field in ("ground_truth_answer", "gt_answer", "answer"):
        value = row.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, dict):
            nested = value.get("answer")
            if isinstance(nested, str) and nested.strip():
                return nested.strip()
    final_answer = row.get("final_answer")
    if isinstance(final_answer, str) and final_answer.strip():
        return final_answer.strip()
    if isinstance(final_answer, dict):
        nested = final_answer.get("answer")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()
    return ""


def lookup_gt_row(
    gt_maps: Dict[str, Dict[str, Dict[str, Any]]],
    row: Dict[str, Any],
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    qid = _id_key(row.get("qid"))
    if qid:
        gt_row = gt_maps["qid"].get(qid)
        if gt_row is not None:
            return gt_row, "qid"
        return None, None

    row_index = _id_key(get_row_index(row))
    if row_index:
        gt_row = gt_maps["index"].get(row_index)
        if gt_row is not None:
            return gt_row, "index"
        return None, None

    question_key = build_match_key(row)
    if question_key:
        gt_row = gt_maps["question"].get(question_key)
        if gt_row is not None:
            return gt_row, "question"
    return None, None


def inject_gt_into_generated_answers(
    gt_maps: Dict[str, Dict[str, Dict[str, Any]]],
    generated_rows: List[Dict[str, Any]],
) -> Tuple[Dict[str, Dict[str, Any]], int, int]:
    """
    Merge GT metadata into generated-answer rows.

    GT fields remain separate from generated content:
    - GT reference answer is stored in `gt_answer`
    - generated row `answer` / `preliminary_draft` / `final_answer` stay untouched
    - GT `qid`, `index`, `key_points`, and filtering metadata are copied in
    """
    merged: Dict[str, Dict[str, Any]] = {}
    matched = 0
    unmatched = 0

    for idx, row in enumerate(generated_rows):
        new_row = dict(row)
        gt_row, match_type = lookup_gt_row(gt_maps, new_row)
        if gt_row is not None:
            new_row["gt_answer"] = get_reference_answer(gt_row)
            new_row["gt_match_type"] = match_type
            # Store the GT question (original_question or answer field)
            if not new_row.get("question") and gt_row.get("original_question"):
                new_row["question"] = gt_row.get("original_question")
            for field, value in gt_row.items():
                if field in (
                    "key_points",
                    "qid",
                    "index",
                    "question",
                    "original_question",
                    "is_tool_call_question",
                    "diagnostic_meta",
                ):
                    new_row[field] = value
            if new_row.get("index") is None and gt_row.get("idx") is not None:
                new_row["index"] = gt_row.get("idx")
            matched += 1
        else:
            unmatched += 1
            continue
        row_qid = get_row_qid(new_row, fallback=f"generated_row_{idx}")
        merged[row_qid] = new_row
    return merged, matched, unmatched


def coerce_answer_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        nested = value.get("answer")
        if isinstance(nested, str):
            return nested.strip()
    return ""


def get_answers_to_judge(ex: Dict[str, Any]) -> List[Tuple[str, str]]:
    """
    Get all answers that need to be judged for a single example.
    Returns list of (answer_type, answer_text) tuples.

    For preview mode: both preliminary_draft and preliminary_draft + final_answer are judged.
    For non-preview mode: answer is judged.
    """
    answers: List[Tuple[str, str]] = []

    generated_answer = coerce_answer_text(ex.get("generated_answer"))
    if generated_answer:
        return [("generated_answer", generated_answer)]

    answer = coerce_answer_text(ex.get("answer"))
    reference_only_answer = (
        "generated_answer" in ex
        and not generated_answer
        and ("ground_truth_answer" in ex or "diagnostic_meta" in ex)
    )
    if answer and not reference_only_answer:
        return [("answer", answer)]

    if not reference_only_answer and ("preliminary_draft" in ex or "final_answer" in ex):
        preliminary_draft = coerce_answer_text(ex.get("preliminary_draft"))
        final_answer = coerce_answer_text(ex.get("final_answer"))
        if preliminary_draft:
            answers.append(("preliminary_draft", preliminary_draft))
        combined_answer = combine_preview_answer(preliminary_draft, final_answer)
        if combined_answer:
            answers.append(("answer", combined_answer))

    if not answers:
        ans = coerce_answer_text(ex.get("answer"))
        if ans and not reference_only_answer:
            answers.append(("answer", ans))

    return answers


def parse_target_indexes(values: List[str] | None) -> set[str]:
    if not values:
        return set()
    out: set[str] = set()
    for value in values:
        for part in str(value).split(","):
            part = part.strip()
            if part:
                out.add(part)
    return out


def compute_score_stats(rows: List[Dict[str, Any]], dimensions: List[str]) -> Dict[str, Dict[str, float | int | None]]:
    stats: Dict[str, Dict[str, float | int | None]] = {}
    for dim in dimensions:
        values: List[float] = []
        for row in rows:
            judge_scores = row.get("judge_scores")
            if not isinstance(judge_scores, dict):
                continue
            value = judge_scores.get(dim)
            if isinstance(value, (int, float)):
                values.append(float(value))

        if not values:
            stats[dim] = {"count": 0, "average": None, "std": None}
            continue

        avg = sum(values) / len(values)
        variance = sum((v - avg) ** 2 for v in values) / len(values)
        stats[dim] = {
            "count": len(values),
            "average": round(avg, 4),
            "std": round(math.sqrt(variance), 4),
        }
    return stats


def extract_error_message_from_llm_text(llm_text: str) -> str:
    if not llm_text:
        return ""
    analysis_match = re.search(r"ANALYSIS:\s*(.*?)(?=KEY POINTS:|KEY POINTS SUMMARY:|DIMENSIONAL SCORES:|VERDICT:|$)", llm_text, re.DOTALL)
    if analysis_match:
        return analysis_match.group(1).strip()
    return llm_text.strip()[:500]


def normalize_judge_scores(scores: Dict[str, int] | None) -> Dict[str, int]:
    out: Dict[str, int] = {}
    if isinstance(scores, dict):
        for dim in LIKERT_DIMENSIONS:
            value = scores.get(dim)
            if isinstance(value, int):
                out[dim] = value
            elif isinstance(value, float):
                out[dim] = int(value)
            else:
                out[dim] = 1
    else:
        out = {dim: 1 for dim in LIKERT_DIMENSIONS}
    return out


def row_has_generated_answer(row: Dict[str, Any]) -> bool:
    present = row.get("generated_answer_present")
    if isinstance(present, bool):
        return present
    return bool(get_answers_to_judge(row))


def merge_result_rows(previous_rows: List[Dict[str, Any]], new_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []

    def _key(row: Dict[str, Any], idx: int) -> str:
        answer_type = str(row.get("answer_type", "answer"))
        qid = get_row_qid(row)
        if qid:
            return f"qid:{qid}:answer_type:{answer_type}"
        index = get_row_index(row)
        if index is not None:
            return f"index:{index}:answer_type:{answer_type}"
        return f"fallback:{idx}"

    for i, row in enumerate(previous_rows):
        if not isinstance(row, dict):
            continue
        key = _key(row, i)
        if key not in merged:
            order.append(key)
        merged[key] = row

    offset = len(previous_rows)
    for i, row in enumerate(new_rows):
        if not isinstance(row, dict):
            continue
        key = _key(row, offset + i)
        if key not in merged:
            order.append(key)
        merged[key] = row

    out = [merged[key] for key in order]
    out.sort(key=lambda r: (
        0 if get_row_index(r) is not None else 1,
        str(get_row_index(r)) if get_row_index(r) is not None else "",
        get_row_qid(r),
    ))
    return out

def build_result_source_fields(ex: Dict[str, Any]) -> Dict[str, Any]:
    question = ex.get("question", "")
    gt_answer = ex.get("gt_answer", "")
    return {
        "question": question,
        "original_question": ex.get("original_question", question),
        "gt_answer": gt_answer,
        "original_answer": ex.get("original_answer", gt_answer),
        "answer": ex.get("answer", ""),
        "preliminary_draft": ex.get("preliminary_draft", ""),
        "final_answer": ex.get("final_answer", ""),
    }

def unwrap_qa_list(qa_data) -> List[Dict[str, Any]]:
    if isinstance(qa_data, list):
        return qa_data
    if isinstance(qa_data, dict):
        for k in ("data","items","qa","examples"):
            if k in qa_data and isinstance(qa_data[k], list):
                return qa_data[k]
        # fallback: merge lists in dict values
        merged=[]
        for v in qa_data.values():
            if isinstance(v, list):
                merged += v
        if merged:
            return merged
    return []

def normalize_text(s: str) -> str:
    if not s:
        return ""
    s = s.lower()
    # normalize whitespace
    s = re.sub(r"\s+", " ", s)
    # normalize commas in numbers: 10,000 -> 10000
    s = re.sub(r"(?<=\d),(?=\d)", "", s)
    # normalize percents: "20 percent" -> "20%"
    s = re.sub(r"(\d+(?:\.\d+)?)\s*percent", r"\1%", s)
    return s.strip()

def extract_keypoints(ex: Dict[str, Any]) -> List[str]:
    """
    Try multiple shapes:
      - ex["key_points"] = List[str]
      - ex["key_points"] = List[{"text": "..."}] or {"point": "..."} or {"kp": "..."}
      - ex["key_points"]["items"] = [...]
    """
    kps = ex.get("key_points")
    if not kps:
        return []
    if isinstance(kps, list):
        out=[]
        for item in kps:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict):
                for key in ("text","point","kp","value","content"):
                    if key in item and isinstance(item[key], str):
                        out.append(item[key])
                        break
        return [kp for kp in out if kp and kp.strip()]
    if isinstance(kps, dict):
        arr = None
        for key in ("items","points","list"):
            if key in kps and isinstance(kps[key], list):
                arr = kps[key]; break
        if arr is None:
            return []
        out=[]
        for item in arr:
            if isinstance(item, str):
                out.append(item)
            elif isinstance(item, dict):
                for key in ("text","point","kp","value","content"):
                    if key in item and isinstance(item[key], str):
                        out.append(item[key])
                        break
        return [kp for kp in out if kp and kp.strip()]
    return []

def qa_type_from_qid(qid: str) -> str:
    if not qid:
        return "unknown"
    if qid.startswith("qa_1_"):
        return "chunk_based_qa"
    if qid.startswith("qa_2_"):
        return "tracking_qa"
    if qid.startswith("qa_3_"):
        return "company_comparison_qa"
    return "unknown"

def point_matches_answer(point: str, answer: str) -> bool:
    """
    Simple heuristic: case-insensitive substring after normalization.
    You can make this stricter/looser as needed.
    """
    pt = normalize_text(point)
    ans = normalize_text(answer)
    if not pt or not ans:
        return False
    if pt in ans:
        return True
    pcts = PCT_RE.findall(pt)
    if pcts:
        for p in pcts:
            if f"{p}%" in ans:
                return True
    nums = NUM_RE.findall(pt)
    if nums:
        ok = True
        for n in nums:
            n_norm = n.replace(",", "")
            if n_norm and (n_norm not in ans):
                ok = False
                break
        if ok:
            return True
    return False


def load_corpus_if_needed(path: str|None) -> Dict[str, Dict[str, Any]]|None:
    if not path:
        return None
    corpus = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip(): continue
            d=json.loads(line)
            _id=str(d.get("_id",""))
            if not _id: continue
            corpus[_id]={"title":d.get("title",""),"metadata":d.get("metadata",{})}
    return corpus


def create_kp_judge_prompt(question: str, gold_answer: str, generated_answer: str, key_points: List[str]) -> str:
    """Build a prompt that asks the LLM to judge the answer and evaluate key points.

    We retain the ANALYSIS / DIMENSIONAL SCORES / VERDICT sections to stay close to
    the format in qa_judge_llm.py, and add a KEY POINTS EVALUATION section.
    """

    kp_lines = []
    for idx, kp in enumerate(key_points, start=1):
        kp_lines.append(f"{idx}. {kp}")
    kp_block = "\n".join(kp_lines) if kp_lines else "(none)"

    prompt = f"""<|begin_of_text|><|start_header_id|>system<|end_header_id|>
You are an expert evaluator for financial Q&A tasks with retrieved evidence.

CORE DEFINITIONS:
- Use ONLY the provided GOLD ANSWER / KEY POINTS as reference.
- The generated answer may contain additional correct information beyond what's in the gold answer/key points.
- **CRITICAL CONSTRAINT: Without access to the full context/retrieved evidence, you cannot determine if additional information is unsubstantiated.**
- **Therefore: Only penalize for DIRECT CONTRADICTIONS with gold answer/key points.**
- **DO NOT penalize for information merely absent from gold answer/key points.**

VERDICT LABELS (use exactly one):

1. CORRECT:
   - All key points are correctly covered (explicitly or through reasonable paraphrase)
   - No factual errors or contradictions with gold answer/key points
   - Answer is relevant and complete
   - **May include additional correct information not in gold answer/key points**

2. PARTIAL:
   - Some key points are correctly covered, but important ones are missing
   - Missing key points are essential for answering the question
   - No factual errors or contradictions with gold answer/key points
   - Answer is relevant but incomplete
   - **May include additional correct information not in gold answer/key points**

3. INCORRECT:
   - **Contains DIRECT CONTRADICTIONS with gold answer/key points**
   - **Has clear factual errors that conflict with provided reference**
   - Answer is relevant but wrong
   - **DO NOT mark as incorrect for missing gold answer/key points info if answer has alternative correct info**

4. FAILURE:
    - Refuses to answer the question
    - Irrelevant/unrelated to the question
    - Empty/blank/no answer

5. ERROR:
    - API call failed
    - Other unexpected errors

KEY POINTS EVALUATION RULES:
- Check each key point against the generated answer.
- For each key point, label as one of:
  PRESENT (correctly mentioned), PARTIAL (partially addressed),
  MISSING (not addressed), INCORRECT (addressed but factually wrong).
- Consider numeric/date/percent equivalence and allow reasonable paraphrases.

ERROR TYPE TAXONOMY (choose NONE if VERDICT=CORRECT):

B) Generation-related
  B1. Hallucination: answer not entailed by retrieved evidence
    - **Hallucination = Information that CONTRADICTS gold answer/key points**
    - **NOT hallucination = Information absent from but not contradicting gold answer/key points**
    - B1 Error Subtypes (select the applicable label(s)):
    - B1-1: Numeric or Categorical Hallucination - Fabricated numbers, percentages, ratings, years, categories, or other hard values that contradict or are absent from evidence. 
    Examples: Making up specific percentages, case counts, or numerical comparisons when evidence doesn't provide them.
    - B1-2: Entity Attribute Hallucination - Fabricated attributes, states, policies, or strategies of a single entity that contradict or are absent from evidence.
    Examples: Claiming a company has an ESG rating system, specific litigation status, or strategic policy when evidence doesn't mention it.
    - B1-3: Comparative Stance Hallucination - Fabricated comparative statements (A is more/less than B) without sufficient evidence support.
    Examples: Claiming "A has significantly lower risk than B" or "A is more diversified than B" when evidence doesn't support such comparisons.
    - B1-4: Trend or Trajectory Hallucination - Fabricated trends or trajectories over multiple periods without sufficient evidence.
    Examples: Claiming "continuously increasing", "steadily declining", or "long-term trend" when evidence only covers partial periods or doesn't support such strong trend statements.

  B2. Contradicts Evidence: contains internal logical inconsistencies, explicitly conflicts with evidence it mentioned before
  B3. Excessive Inference: generalizes beyond a reasonable range based on the evidence
  B4. Evidence Fusion Failure: fails to correctly synthesize multiple evidence pieces (complementary or conflicting)

C) Finance-specific numeric & semantic errors
  C1. Numerical Precision: rounding/tolerance mistakes; % vs bps confusion
  C2. Units and scales: millions vs billions; ratio vs absolute confusion; currency/unit mismatch
  C3. Time mismatch: wrong period (e.g., annual vs quarterly, wrong FY/Q)
  C4. Computation Logic: uses correct data but computes incorrectly (formula/arithmetic error)

D) Query and context errors
  D1. Query misunderstanding: misidentifies intent, key entity, or asked metric
    - D1 Error Types (select the applicable label(s)):
    - D1-1: Intent Misunderstanding - The generated answer misunderstands the true intent of the question.
    - D1-2: Entity Misidentification - Incorrectly identifies key entities (company names, person names, metric names, etc.).
    - D1-3: Metric Misidentification - Incorrectly identifies the asked metric or measurement.
  D2. Context window abuse: loses key info due to length limits or fails to prioritize relevant parts

ERROR TAGGING RULES:
- Output 1 PRIMARY error group (B/C/D) and 1 PRIMARY subtype (B1..D2) when VERDICT != CORRECT.
- Optionally output up to 2 SECONDARY subtypes if multiple issues contribute.
- Prefer the MOST CAUSAL error: e.g., if evidence is present but model ignores it -> B/C; if question misunderstood -> D.

RESPONSE FORMAT (strict):
ALL SECTIONS BELOW ARE MANDATORY. Do not omit any section. Use exactly the headings and labels as shown. Do not add extra text outside this format.
Final reminder:
- You must output all 5 dimensional scores.
- Each dimensional score must be a single integer from 1 to 5.
- Do not skip any heading.
- Do not rename any heading.
- Do not output prose outside the required template.

ANALYSIS: [Concise analysis of answer quality, groundedness, and any numeric/unit/period issues]

KEY POINTS:
1. [PRESENT|PARTIAL|MISSING|INCORRECT] - brief justification
2. [PRESENT|PARTIAL|MISSING|INCORRECT] - brief justification
... (one line per key point)

KEY POINTS SUMMARY: matched=<int>; partial=<int>; missing=<int>; incorrect=<int> 
DIMENSIONAL SCORES: 
1. Information Coverage: [1-5]
- Includes all query-critical facts/constraints needed to answer.
- Avoids spending space on irrelevant details that don’t support the answer.
2. Reasoning Chain: [1-5]
- Provides a logical sequence linking evidence → intermediate conclusions → final answer.
- Not just paraphrasing; shows why the conclusion follows.
3. Factual Consistency: [1-5]
- Every stated claim is supported by the given evidence/context.
- No contradictions with evidence; no unsupported additions.
4. Clarity of Expression: [1-5]
- Main answer is easy to find; structure is organized (e.g., bullet points, clear sentences).
- Minimal redundancy; no “burying the lead” with unnecessary text.
5. Analytical Depth: [1-5]
- Selects and prioritizes relevant evidence rather than summarizing everything.
- Synthesizes/comparisons/inferences are reasonable and grounded in evidence.
- Produces a decisive, query-directed outcome (e.g., classification, comparison, recommendation).

ERROR TYPE:
PRIMARY_GROUP: [GENERATION_RELATED|FINANCE_NUMERIC_SEMANTIC|QUERY_CONTEXT|NONE]
PRIMARY_SUBTYPE: [B2|B3|B4|C1|C2|C3|C4|D1|D2|NONE]
SECONDARY_SUBTYPES: [<subtype>|<subtype>|NONE]
EVIDENCE_IDS_USED: [comma-separated ids from the provided evidence; or NONE]

VERDICT: [CORRECT|INCORRECT|PARTIAL|FAILURE]
(All sections are mandatory; the VERDICT line must contain only one of the listed labels.)
<|eot_id|><|start_header_id|>user<|end_header_id|>

QUESTION:
{question}

GOLD ANSWER:
{gold_answer}

GENERATED ANSWER:
{generated_answer}

KEY POINTS TO CHECK:
{kp_block}
<|eot_id|><|start_header_id|>assistant<|end_header_id|>
"""
    return prompt


def load_config(config_path: str) -> Dict[str, Any]:
    """Load YAML config file if available."""
    if yaml is None:
        logger.warning("PyYAML not installed, cannot load config from %s", config_path)
        return {}
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception as e:
        logger.warning("Failed to load config from %s: %s", config_path, e)
        return {}


def _call_openai(
    prompt: str,
    model_name: str,
    reasoning_effort: str | None = "low",
    base_url: str | None = None,
    api_key: str | None = None,
) -> str:
    try:

        if not api_key:
            return "ANALYSIS: Missing OPENAI_API_KEY\nVERDICT: ERROR"

        client = OpenAI(base_url=base_url, api_key=api_key, max_retries=5)
        is_gpt5_family = model_name.startswith("gpt-5")

        if is_gpt5_family:
            try:
                responses_params: Dict[str, Any] = {
                    "model": model_name,
                    "input": prompt,
                    "max_output_tokens": 2048,
                }
                if reasoning_effort is not None:
                    responses_params["reasoning"] = {"effort": reasoning_effort}
                resp = client.responses.create(**responses_params)
                text = resp.output_text
            except Exception:
                completion = client.chat.completions.create(
                    model=model_name,
                    messages=[{"role": "user", "content": prompt}],
                    max_completion_tokens=2048,
                    temperature=0,
                )
                text = completion.choices[0].message.content or ""
        else:
            completion = client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=2048,
                temperature=0,
                top_p=0.95,
                extra_body={"thinking": {"type": "disabled"}},
            )
            text = completion.choices[0].message.content or ""

        if text:
            text = re.sub(r"grounded\s*[\s\S]*?grounded\s*", "", text, flags=re.IGNORECASE)
        return text
    except Exception as e:
        logger.error("OpenAI judge call failed: %s", e)
        return f"ANALYSIS: OpenAI API call failed: {e}\nVERDICT: ERROR"


def run_judge_requests_parallel(
    prompts_to_run: List[Tuple[str, str, str, str]],
    *,
    model_name: str,
    reasoning_effort: str | None,
    workers: int,
    base_url: str | None = None,
    api_key: str | None = None,
) -> Dict[str, Dict[str, str]]:
    """
    Run judge requests in parallel.
    Returns dict: {qid -> {answer_type -> llm_response}}
    """
    llm_responses: Dict[str, Dict[str, str]] = {}
    if not prompts_to_run:
        return llm_responses

    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        future_to_meta = {
            executor.submit(_call_openai, prompt, model_name, reasoning_effort, base_url, api_key): (qid, question, answer_type)
            for qid, question, prompt, answer_type in prompts_to_run
        }
        pbar = tqdm(total=len(future_to_meta), desc="Judging QAs", unit="qa")
        for future in as_completed(future_to_meta):
            qid, question, answer_type = future_to_meta[future]
            try:
                llm_text = future.result()
            except Exception as e:
                logger.error("Judge request failed qid=%s question=%s error=%s", qid, question[:120], e)
                print(f"[JUDGE_FAILED] qid={qid} question={question} error={e}")
                llm_text = f"ANALYSIS: OpenAI API call failed: {e}\nVERDICT: ERROR"

            if "VERDICT: ERROR" in llm_text:
                logger.error("Judge returned error qid=%s question=%s answer_type=%s", qid, question[:120], answer_type)
                print(f"[JUDGE_FAILED] qid={qid} answer_type={answer_type} question={question} detail={llm_text[:500]}")

            if qid not in llm_responses:
                llm_responses[qid] = {}
            llm_responses[qid][answer_type] = llm_text
            pbar.update(1)
        pbar.close()

    return llm_responses


def parse_kp_judge_response(text: str) -> Tuple[str, Dict[str, int], Dict[str, int], str, Dict[str, Any], List[str]]:
    """Parse LLM response.

    Returns:
    - analysis: str
    - scores: dict[str,int] for five dimensions
    - kp_counts: dict with keys 'matched','partial','missing','incorrect'
    - verdict: str
    - error_info: dict with keys error_primary_group, error_primary_subtype, error_secondary_subtypes
    - evidence_ids_used: list[str]
    """
    analysis_match = re.search(r"ANALYSIS:\s*(.*?)(?=KEY POINTS:|KEY POINTS SUMMARY:|DIMENSIONAL SCORES:|VERDICT:|$)", text, re.DOTALL)
    analysis = analysis_match.group(1).strip() if analysis_match else "No analysis provided"

    kp_counts = {"matched": None, "partial": None, "missing": None, "incorrect": None}
    kp_sum_block = re.search(r"KEY POINTS SUMMARY:\s*(.*?)(?=DIMENSIONAL SCORES:|VERDICT:|$)", text, re.IGNORECASE | re.DOTALL)
    if kp_sum_block:
        block = kp_sum_block.group(1)
        def _find(label: str) -> int | None:
            m = re.search(fr"{label}\s*[:=]\s*(\d+)", block, re.IGNORECASE)
            return int(m.group(1)) if m else None
        m = _find("matched")
        p = _find("partial")
        mi = _find("missing")
        inc = _find("incorrect")
        if any(v is not None for v in (m, p, mi, inc)):
            kp_counts = {
                "matched": m if m is not None else 0,
                "partial": p if p is not None else 0,
                "missing": mi if mi is not None else 0,
                "incorrect": inc if inc is not None else 0,
            }

    if kp_counts["matched"] is None:
        kp_block_match = re.search(r"KEY POINTS:\s*(.*?)(?=KEY POINTS SUMMARY:|DIMENSIONAL SCORES:|VERDICT:|$)", text, re.IGNORECASE | re.DOTALL)
        if kp_block_match:
            block = kp_block_match.group(1)
            present = len(re.findall(r"\bPRESENT\b", block, re.IGNORECASE))
            partial = len(re.findall(r"\bPARTIAL\b", block, re.IGNORECASE))
            missing = len(re.findall(r"\bMISSING\b", block, re.IGNORECASE))
            incorrect = len(re.findall(r"\bINCORRECT\b", block, re.IGNORECASE))
            total_detected = present + partial + missing + incorrect
            if total_detected > 0:
                kp_counts = {
                    "matched": present,
                    "partial": partial,
                    "missing": missing,
                    "incorrect": incorrect,
                }

    scores: Dict[str, int] = {}
    dims = [
        "Information Coverage",
        "Reasoning Chain",
        "Factual Consistency",
        "Clarity of Expression",
        "Analytical Depth",
    ]
    dim_block = re.search(r"DIMENSIONAL SCORES:(.*?)(?=VERDICT:|$)", text, re.DOTALL)
    if dim_block:
        s = dim_block.group(1)
        for d in dims:
            m = re.search(fr"{re.escape(d)}:\s*([1-5])", s)
            if m:
                scores[d] = int(m.group(1))
    if not scores:
        scores = {d: 1 for d in dims}

    # Parse verdict
    verdict_match = re.search(r"VERDICT:\s*(CORRECT|INCORRECT|PARTIAL|FAILURE|ERROR)", text, re.IGNORECASE)
    verdict = verdict_match.group(1).upper() if verdict_match else "UNCLEAR"

    # Parse ERROR TYPE block
    group_match = re.search(r"PRIMARY_GROUP:\s*\[?([A-Z_]+|NONE)\]?", text, re.IGNORECASE)
    error_primary_group = (group_match.group(1).upper() if group_match else "NONE")
    subtype_match = re.search(r"PRIMARY_SUBTYPE:\s*\[?([A-Z]\d+|NONE)\]?", text, re.IGNORECASE)
    error_primary_subtype = (subtype_match.group(1).upper() if subtype_match else "NONE")
    sec_match = re.search(r"SECONDARY_SUBTYPES:\s*\[?(.*?)\]?(?=\n|$)", text, re.IGNORECASE | re.DOTALL)
    error_secondary_subtypes: List[str] = []
    if sec_match:
        raw = sec_match.group(1)
        parts = [p.strip().upper() for p in re.split(r"[,\s]+", raw) if p.strip()]
        error_secondary_subtypes = [p for p in parts if p not in ("NONE",)]

    # Parse evidence ids used
    ev_match = re.search(r"EVIDENCE_IDS_USED:\s*\[?(.*?)\]?(?=\n|$)", text, re.IGNORECASE | re.DOTALL)
    evidence_ids_used: List[str] = []
    if ev_match:
        raw = ev_match.group(1).strip()
        if raw.upper() != "NONE" and raw != "":
            parts = [p.strip().strip("'").strip('"') for p in raw.split(",")]
            evidence_ids_used = [p for p in parts if p]

    error_info = {
        "error_primary_group": error_primary_group,
        "error_primary_subtype": error_primary_subtype,
        "error_secondary_subtypes": error_secondary_subtypes,
    }

    return analysis, scores, kp_counts, verdict, error_info, evidence_ids_used

def compute_correctness_score(verdict_counts: Dict[str, int], evaluated_qas: int) -> float:
    if evaluated_qas <= 0:
        return 0.0

    total_score = (
        verdict_counts.get("CORRECT", 0) * 5
        + verdict_counts.get("PARTIAL", 0) * 3
        + verdict_counts.get("INCORRECT", 0) * 1
        # FAILURE / ERROR/UNCLEAR 默认就是 0 分，不用单独加
    )
    return round(total_score / evaluated_qas, 4)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="/root/autodl-tmp/dir_lzx/FinSagent_bf/config/production.yaml", help="Path to YAML config file containing llm_model_name, llm_base_url, llm_api_key.")
    ap.add_argument("--input_json", default="/root/autodl-tmp/RAG_Agent_data/nvidia/gt/nvidia_sec_questions_30_2025_with_key_pts.json", help="Path to GT JSON file(s) (file, dir, or glob). Each entry should contain question/key_points and the GT answer.")
    ap.add_argument("--generated_answers_json", required=True, help="Generated-answer JSON file(s) to evaluate after matching against GT by qid/index, with unique question fallback.")
    ap.add_argument("--out_dir", type=str,
                        default="/root/autodl-tmp/dir_lzx/FinSagent_bf/test/nvidia_expriments/judge",
                        help="Output directory for evaluation results.")
    ap.add_argument("--corpus", default=None, help="Optional corpus jsonl")
    ap.add_argument("--workers", type=int, default=None, help="Number of concurrent judge requests (overrides config).")
    ap.add_argument(
        "--reasoning_effort",
        default=None,
        choices=["low", "medium", "high", "none"],
        help="Reasoning effort for gpt-5* models (overrides config).",
    )
    ap.add_argument("--target_index", action="append", default=None)
    ap.add_argument("--max_examples", type=int, default=None)
    ap.add_argument("--start_index", type=int, default=1)
    args = ap.parse_args()

    # Load LLM config from file
    config = load_config(args.config)
    if not config:
        raise ValueError(f"Failed to load config from {args.config}")

    llm_model = config.get("llm_model_name")
    llm_base_url = config.get("llm_base_url")
    llm_api_key = config.get("llm_api_key")
    llm_workers = args.workers if args.workers is not None else config.get("workers", 1)
    llm_reasoning_effort = args.reasoning_effort if args.reasoning_effort is not None else config.get("reasoning_effort", "low")

    if not llm_model:
        raise ValueError(f"llm_model_name not found in config: {args.config}")
    if not llm_api_key:
        raise ValueError(f"llm_api_key not found in config: {args.config}")
    target_indexes = parse_target_indexes(args.target_index)

    if args.start_index < 1:
        raise ValueError("--start_index must be >= 1 (1-indexed)")

    Path(args.out_dir).mkdir(parents=True, exist_ok=True)

    gt_maps = load_gt_match_maps(args.input_json)
    _ = load_corpus_if_needed(args.corpus)
    used_generated_answers_file = bool(args.generated_answers_json)

    generated_answers_matched = 0
    generated_answers_unmatched = 0
    # if args.generated_answers_json:
    generated_rows = load_rows(args.generated_answers_json)
    qa_data_map, generated_answers_matched, generated_answers_unmatched = inject_gt_into_generated_answers(
        gt_maps,
        generated_rows,
    )
    logger.info(
        "Merged GT from %s into generated answers from %s: matched=%d unmatched=%d",
        args.input_json,
        args.generated_answers_json,
        generated_answers_matched,
        generated_answers_unmatched,
    )
    # else:
    #     qa_data_map = load_answers(args.input_json)

    total_input_rows = len(qa_data_map)
    skipped_tool_call_questions = 0
    matched_target_index_rows = 0
    skipped_unmatched_generated_answers = 0

    res_path = Path(args.out_dir) / "results.json"
    previous_results: List[Dict[str, Any]] = []
    if res_path.exists():
        try:
            with open(res_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, list):
                previous_results = loaded
            else:
                logger.warning("Existing results.json is not a list; will ignore previous results: %s", res_path)
                previous_results = []
        except Exception as e:
            logger.warning("Failed to load existing results.json; will ignore previous results (%s): %s", res_path, e)
            previous_results = []

    rows_to_process: List[Tuple[str, Dict[str, Any]]] = []
    seen_after_filters = 0
    for qid, ex in qa_data_map.items():
        if _is_truthy(ex.get("is_tool_call_question")):
            skipped_tool_call_questions += 1
            continue
        row_index = get_row_index(ex)
        if target_indexes and str(row_index) not in target_indexes:
            continue
        if used_generated_answers_file and not get_answers_to_judge(ex):
            skipped_unmatched_generated_answers += 1
            continue
        seen_after_filters += 1
        if seen_after_filters < args.start_index:
            continue
        rows_to_process.append((qid, ex))
        matched_target_index_rows += 1
        if args.max_examples is not None and len(rows_to_process) >= args.max_examples:
            break

    if target_indexes and matched_target_index_rows == 0:
        raise ValueError(f"No non-tool-call GT row found with index in {sorted(target_indexes)}")

    # Structure: (qid, question, prompt, answer_type)
    prompts_to_run: List[Tuple[str, str, str, str]] = []
    for qid, ex in rows_to_process:
        # Always process for LLM judge even when no key_points
        # (will use gold_answer as reference)
        kps = extract_keypoints(ex)
        question = ex.get("question", "")
        gold_answer = ex["gt_answer"]

        # Get all answers to judge (handles both preview and non-preview formats)
        answers_to_judge = get_answers_to_judge(ex)

        for answer_type, gen in answers_to_judge:
            prompt = create_kp_judge_prompt(question, gold_answer, gen, kps)
            prompts_to_run.append((qid, question, prompt, answer_type))

    effort = None if llm_reasoning_effort == "none" else llm_reasoning_effort
    llm_responses = run_judge_requests_parallel(
        prompts_to_run,
        model_name=llm_model,
        reasoning_effort=effort,
        workers=llm_workers,
        base_url=llm_base_url,
        api_key=llm_api_key,
    )

    results = []
    failure_logs: List[Dict[str, Any]] = []
    total_considered = len(rows_to_process)
    no_keypoints_count = 0
    missing_generated_answer_count = 0
    judge_error_count = 0

    for qid, ex in tqdm(rows_to_process, desc="Processing QAs"):
        kps = extract_keypoints(ex)
        qa_type = qa_type_from_qid(qid)
        question = ex.get("question", "")
        gold_answer = ex["gt_answer"]
        source_fields = build_result_source_fields(ex)

        # Get all answers to judge for this example
        answers_to_judge = get_answers_to_judge(ex)
        if not answers_to_judge:
            missing_generated_answer_count += 1

        if not kps:
            no_keypoints_count += 1
            # Note: still process with LLM judge using gold_answer as reference
            # (removed continue - we still call LLM for evaluation)

        # Get LLM responses for all answer types of this qid
        qid_responses = llm_responses.get(qid, {})

        for answer_type, gen in answers_to_judge:
            if not gen:
                missing_generated_answer_count += 1

            llm_text = qid_responses.get(answer_type, "")
            if llm_text and "VERDICT: ERROR" in llm_text:
                failure_logs.append({
                    "qid": get_row_qid(ex, fallback=qid),
                    "answer_type": answer_type,
                    "index": get_row_index(ex),
                    "question": question,
                    "error_message": extract_error_message_from_llm_text(llm_text),
                    "failure_stage": "judge_request",
                })

            judge_analysis = None
            judge_scores: Dict[str, int] = {}
            kp_counts = {"matched": None, "partial": None, "missing": None, "incorrect": None}
            judge_verdict = None

            parsed_error_info: Dict[str, Any] = {}
            parsed_evidence_ids: List[str] = []
            if llm_text:
                try:
                    analysis, scores, kp_counts_parsed, verdict, error_info, evidence_ids_used = parse_kp_judge_response(llm_text)
                    judge_analysis = analysis
                    judge_scores = normalize_judge_scores(scores)
                    kp_counts = kp_counts_parsed
                    judge_verdict = verdict
                    parsed_error_info = error_info or {}
                    parsed_evidence_ids = evidence_ids_used or []
                except Exception as e:
                    logger.error("Failed to parse LLM response, falling back: %s", e)
                    print(f"[JUDGE_PARSE_FAILED] qid={qid} answer_type={answer_type} question={question} error={e}")
                    failure_logs.append({
                        "qid": get_row_qid(ex, fallback=qid),
                        "answer_type": answer_type,
                        "index": get_row_index(ex),
                        "question": question,
                        "error_message": str(e),
                        "failure_stage": "judge_parse",
                    })

            if judge_verdict in (None, "UNCLEAR", "ERROR"):
                judge_error_count += 1
                try:
                    if kp_counts["matched"] is not None:
                        matched_count = int(kp_counts.get("matched") or 0)
                        partial_count = int(kp_counts.get("partial") or 0)
                        incorrect_count = int(kp_counts.get("incorrect") or 0)
                        total_kps = len(kps)
                        if total_kps > 0 and matched_count == total_kps:
                            judge_verdict = "CORRECT"
                        elif matched_count > 0 or partial_count > 0:
                            judge_verdict = "PARTIAL"
                        elif incorrect_count > 0 or (total_kps > 0 and matched_count == 0 and partial_count == 0):
                            judge_verdict = "INCORRECT"
                except Exception as e:
                    logger.warning("Failed to infer verdict from KP counts: %s", e)

            if kp_counts["matched"] is None:
                matched = sum(1 for kp in kps if point_matches_answer(kp, gen))
                kp_counts = {
                    "matched": matched,
                    "partial": 0,
                    "missing": max(0, len(kps) - matched),
                    "incorrect": 0,
                }
                if not judge_verdict:
                    judge_verdict = "CORRECT" if matched == len(kps) else ("PARTIAL" if matched > 0 else "INCORRECT")
                if not judge_analysis:
                    judge_analysis = "Rule-based fallback applied."

            judge_scores = normalize_judge_scores(judge_scores)
            kp_coverage_ratio = kp_counts["matched"] / max(1, len(kps))
            if judge_verdict in (None, "UNCLEAR", "ERROR"):
                matched_count = int(kp_counts.get("matched") or 0)
                partial_count = int(kp_counts.get("partial") or 0)
                incorrect_count = int(kp_counts.get("incorrect") or 0)
                total_kps = len(kps)
                if total_kps > 0 and matched_count == total_kps:
                    judge_verdict = "CORRECT"
                elif matched_count > 0 or partial_count > 0:
                    judge_verdict = "PARTIAL"
                elif incorrect_count > 0 or (total_kps > 0 and matched_count == 0 and partial_count == 0):
                    judge_verdict = "INCORRECT"

            passed = (judge_verdict == "CORRECT")

            result_row = {
                "qid": get_row_qid(ex, fallback=qid),
                "index": get_row_index(ex),
                "qa_type": qa_type,
                **source_fields,
                "answer_type": answer_type,
                "n_keypoints": len(kps),
                "generated_answer_present": bool(gen),
                "kp_matched": kp_counts["matched"],
                "kp_partial": kp_counts["partial"],
                "kp_missing": kp_counts["missing"],
                "kp_incorrect": kp_counts["incorrect"],
                "kp_coverage_ratio": round(kp_coverage_ratio, 4),
                "judge_verdict": judge_verdict,
                "judge_analysis": judge_analysis,
                "judge_scores": judge_scores,
                "error_primary_group": parsed_error_info.get("error_primary_group"),
                "error_primary_subtype": parsed_error_info.get("error_primary_subtype"),
                "error_secondary_subtypes": parsed_error_info.get("error_secondary_subtypes"),
                "evidence_ids_used": parsed_evidence_ids,
                "passed": bool(passed),
            }
            results.append(result_row)

    all_rows_for_output = merge_result_rows(previous_results, results)
    if used_generated_answers_file:
        all_rows_for_output = [row for row in all_rows_for_output if row_has_generated_answer(row)]
    with open(res_path, "w", encoding="utf-8") as f:
        json.dump(all_rows_for_output, f, ensure_ascii=False, indent=2)

    # write CSV
    csv_path = Path(args.out_dir) / "details.csv"
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "qid","qa_type","answer_type","n_keypoints",
            "kp_matched","kp_partial","kp_missing","kp_incorrect",
            "kp_coverage_ratio","judge_verdict","passed"
        ])
        for r in all_rows_for_output:
            w.writerow([
                r["qid"], r["qa_type"], r.get("answer_type", "answer"),
                r["n_keypoints"],
                r.get("kp_matched"), r.get("kp_partial"), r.get("kp_missing"), r.get("kp_incorrect"),
                r.get("kp_coverage_ratio"), r.get("judge_verdict"), r["passed"]
            ])

    # summary
    all_results_for_summary = all_rows_for_output
    verdict_counts = {
        "CORRECT": sum(1 for r in all_results_for_summary if r.get("judge_verdict") == "CORRECT"),
        "PARTIAL": sum(1 for r in all_results_for_summary if r.get("judge_verdict") == "PARTIAL"),
        "INCORRECT": sum(1 for r in all_results_for_summary if r.get("judge_verdict") == "INCORRECT"),
        "FAILURE": sum(1 for r in all_results_for_summary if r.get("judge_verdict") == "FAILURE"),
        "ERROR/UNCLEAR": sum(1 for r in all_results_for_summary if r.get("judge_verdict") in ("ERROR", "UNCLEAR", None)),
    }
    overall = {
        "evaluated_qas": len(all_results_for_summary),
        "total_considered_after_filters": len(all_results_for_summary),
        "verdict_counts": verdict_counts,
        "correctness_score": compute_correctness_score(
            verdict_counts,
            len(all_results_for_summary),
        ),
        "likert_stats": compute_score_stats(all_results_for_summary, LIKERT_DIMENSIONS),
    }
    by_type: Dict[str, Dict[str, Any]] = {}
    for r in all_results_for_summary:
        t = r["qa_type"]
        by_type.setdefault(t, {"count":0,"passed":0,"avg_ratio_sum":0.0,"with_ratio":0})
        by_type[t]["count"] += 1
        if r["passed"] is True:
            by_type[t]["passed"] += 1
        if r.get("kp_coverage_ratio") is not None:
            by_type[t]["avg_ratio_sum"] += r["kp_coverage_ratio"]
            by_type[t]["with_ratio"] += 1
    for t, s in by_type.items():
        s["pass_rate"] = round(s["passed"]/max(1,s["count"]), 4)
        s["avg_match_ratio"] = round(s["avg_ratio_sum"]/max(1,s["with_ratio"]), 4)
        rows_for_type = [r for r in all_results_for_summary if r["qa_type"] == t]
        s["likert_stats"] = compute_score_stats(rows_for_type, LIKERT_DIMENSIONS)

    simple_stats = {
        "total_input_rows": total_input_rows,
        "rows_after_tool_call_skip": total_input_rows - skipped_tool_call_questions,
        "skipped_tool_call_questions": skipped_tool_call_questions,
        "target_indexes": sorted(target_indexes),
        "matched_target_index_rows": matched_target_index_rows,
        "rows_considered": total_considered,
        "skipped_unmatched_generated_answers": skipped_unmatched_generated_answers,
        "rows_without_keypoints": no_keypoints_count,
        "rows_missing_generated_answer": missing_generated_answer_count,
        "judge_error_or_fallback_count": judge_error_count,
        "generated_answers_matched": len(all_results_for_summary) if used_generated_answers_file else generated_answers_matched,
        "generated_answers_unmatched": skipped_unmatched_generated_answers if used_generated_answers_file else generated_answers_unmatched,
    }

    summary = {"overall": overall, "by_type": by_type, "simple_stats": simple_stats}
    sum_path = Path(args.out_dir) / "summary.json"
    with open(sum_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    failures_path = Path(args.out_dir) / "judge_failures.json"
    with open(failures_path, "w", encoding="utf-8") as f:
        json.dump(failure_logs, f, ensure_ascii=False, indent=2)

    print(json.dumps({
        "results": str(res_path),
        "details_csv": str(csv_path),
        "summary": str(sum_path),
        "judge_failures": str(failures_path),
        "simple_stats": simple_stats,
        "generated_answers_json": args.generated_answers_json,
        "generated_answers_matched": generated_answers_matched,
        "generated_answers_unmatched": generated_answers_unmatched,
        **summary
    }, indent=2))

if __name__ == "__main__":
    main()
