#!/usr/bin/env python3
"""Train a small generic evidence-rescue scorer from weak key-point labels.

This intentionally does not learn company facts. Labels are derived from whether
a candidate chunk appears to cover GT key-point text/numbers, while features are
limited to query/candidate retrieval signals available at inference time.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from utils.evidence_rescue_scorer import build_rescue_features, chunk_text_for_rescue


TOKEN_RE = re.compile(r"[\u4e00-\u9fff]|[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?")
NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")


def _load_rows(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        raise ValueError(f"{path} must be a JSON list")
    return rows


def _tokens(text: Any) -> set[str]:
    return {token.lower() for token in TOKEN_RE.findall(str(text or ""))}


def _numbers(text: Any) -> set[str]:
    return set(NUMBER_RE.findall(str(text or "")))


def _qid(row: dict[str, Any]) -> str:
    return str(row.get("qid") or row.get("index") or "")


def _key_points(row: dict[str, Any]) -> list[str]:
    value = row.get("key_points") or row.get("gt_keypoints") or []
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, str) and item.strip():
            out.append(item.strip())
        elif isinstance(item, dict):
            text = item.get("text") or item.get("point") or item.get("kp") or item.get("content")
            if isinstance(text, str) and text.strip():
                out.append(text.strip())
    return out


def _weak_label(question: str, key_points: list[str], chunk: dict[str, Any]) -> int:
    text = chunk_text_for_rescue(chunk).lower()
    text_tokens = _tokens(text)
    if not text_tokens:
        return 0
    question_tokens = _tokens(question)
    for key_point in key_points:
        kp_tokens = _tokens(key_point)
        if not kp_tokens:
            continue
        kp_numbers = _numbers(key_point)
        number_hit = bool(kp_numbers) and len(kp_numbers & _numbers(text)) >= max(1, min(2, len(kp_numbers)))
        kp_overlap = len(kp_tokens & text_tokens) / max(1, len(kp_tokens))
        question_overlap = len(question_tokens & text_tokens) / max(1, len(question_tokens)) if question_tokens else 0.0
        if number_hit and kp_overlap >= 0.18:
            return 1
        if not kp_numbers and kp_overlap >= 0.35 and question_overlap >= 0.15:
            return 1
    return 0


def _iter_examples(paths: list[str], use_pre_rerank: bool) -> list[dict[str, Any]]:
    examples: list[dict[str, Any]] = []
    for path in paths:
        for row in _load_rows(path):
            question = str(row.get("question") or row.get("original_question") or "")
            key_points = _key_points(row)
            chunks = row.get("pre_rerank_candidates") if use_pre_rerank else row.get("retrieved_chunks")
            if not question or not key_points or not chunks:
                continue
            for rank, chunk in enumerate(chunks, start=1):
                features = build_rescue_features(question, chunk)
                features["candidate_rank"] = float(rank)
                examples.append(
                    {
                        "qid": _qid(row),
                        "index": row.get("index"),
                        "question": question,
                        "rank": rank,
                        "features": features,
                        "label": _weak_label(question, key_points, chunk),
                    }
                )
    return examples


def _feature_names(examples: list[dict[str, Any]]) -> list[str]:
    names: set[str] = set()
    for ex in examples:
        names.update(ex["features"].keys())
    return sorted(names)


def _matrix(examples: list[dict[str, Any]], feature_names: list[str]) -> tuple[np.ndarray, np.ndarray, list[str]]:
    x = np.array([[float(ex["features"].get(name, 0.0)) for name in feature_names] for ex in examples], dtype=float)
    y = np.array([int(ex["label"]) for ex in examples], dtype=float)
    qids = [str(ex["qid"]) for ex in examples]
    return x, y, qids


def _standardize(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    means = x.mean(axis=0) if len(x) else np.zeros(x.shape[1])
    scales = x.std(axis=0) if len(x) else np.ones(x.shape[1])
    scales = np.where(scales < 1e-9, 1.0, scales)
    return (x - means) / scales, means, scales


def _sigmoid(logits: np.ndarray) -> np.ndarray:
    logits = np.clip(logits, -50, 50)
    return 1.0 / (1.0 + np.exp(-logits))


def _train_logistic(x: np.ndarray, y: np.ndarray, epochs: int, lr: float, l2: float) -> tuple[np.ndarray, float]:
    weights = np.zeros(x.shape[1], dtype=float)
    bias = 0.0
    pos = max(1.0, float(y.sum()))
    neg = max(1.0, float(len(y) - y.sum()))
    pos_weight = min(20.0, neg / pos)
    sample_weight = np.where(y > 0, pos_weight, 1.0)
    for _ in range(epochs):
        pred = _sigmoid(x @ weights + bias)
        err = (pred - y) * sample_weight
        weights -= lr * ((x.T @ err) / len(y) + l2 * weights)
        bias -= lr * float(err.mean())
    return weights, bias


def _auc(y: np.ndarray, scores: np.ndarray) -> float | None:
    positives = scores[y == 1]
    negatives = scores[y == 0]
    if len(positives) == 0 or len(negatives) == 0:
        return None
    wins = 0.0
    total = float(len(positives) * len(negatives))
    for pos in positives:
        wins += float((pos > negatives).sum())
        wins += 0.5 * float((pos == negatives).sum())
    return round(wins / total, 4)


def _average_precision(y: np.ndarray, scores: np.ndarray) -> float | None:
    if y.sum() == 0:
        return None
    order = np.argsort(-scores)
    hits = 0
    precision_sum = 0.0
    for rank, idx in enumerate(order, start=1):
        if y[idx] == 1:
            hits += 1
            precision_sum += hits / rank
    return round(precision_sum / y.sum(), 4)


def _topk_hit(examples: list[dict[str, Any]], scores: np.ndarray, k: int) -> float | None:
    grouped: dict[str, list[tuple[float, int]]] = defaultdict(list)
    for ex, score in zip(examples, scores):
        grouped[str(ex["qid"])].append((float(score), int(ex["label"])))
    considered = 0
    hits = 0
    for values in grouped.values():
        if not any(label for _, label in values):
            continue
        considered += 1
        top = sorted(values, reverse=True)[:k]
        hits += int(any(label for _, label in top))
    if considered == 0:
        return None
    return round(hits / considered, 4)


def _evaluate(examples: list[dict[str, Any]], feature_names: list[str], means: np.ndarray, scales: np.ndarray, weights: np.ndarray, bias: float) -> dict[str, Any]:
    if not examples:
        return {"rows": 0}
    x, y, _ = _matrix(examples, feature_names)
    xz = (x - means) / scales
    scores = _sigmoid(xz @ weights + bias)
    return {
        "rows": len(examples),
        "positive_rows": int(y.sum()),
        "positive_rate": round(float(y.mean()), 4),
        "auc": _auc(y, scores),
        "average_precision": _average_precision(y, scores),
        "top1_hit_by_question": _topk_hit(examples, scores, 1),
        "top3_hit_by_question": _topk_hit(examples, scores, 3),
        "top5_hit_by_question": _topk_hit(examples, scores, 5),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train_json", action="append", required=True)
    parser.add_argument("--eval_json", action="append", default=[])
    parser.add_argument("--out_model", required=True)
    parser.add_argument("--out_report", required=True)
    parser.add_argument("--use_pre_rerank", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--epochs", type=int, default=800)
    parser.add_argument("--lr", type=float, default=0.08)
    parser.add_argument("--l2", type=float, default=0.001)
    parser.add_argument("--seed", type=int, default=13)
    args = parser.parse_args()

    random.seed(args.seed)
    train_examples = _iter_examples(args.train_json, args.use_pre_rerank)
    eval_examples = _iter_examples(args.eval_json, args.use_pre_rerank) if args.eval_json else []
    if not train_examples:
        raise ValueError("No training examples found")

    feature_names = _feature_names(train_examples)
    x, y, _ = _matrix(train_examples, feature_names)
    xz, means, scales = _standardize(x)
    weights, bias = _train_logistic(xz, y, args.epochs, args.lr, args.l2)

    model_path = Path(args.out_model)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    model = {
        "model_type": "linear_logistic_evidence_rescue_scorer",
        "feature_names": feature_names,
        "weights": weights.tolist(),
        "bias": float(bias),
        "means": {name: float(value) for name, value in zip(feature_names, means)},
        "scales": {name: float(value) for name, value in zip(feature_names, scales)},
        "training": {
            "train_json": args.train_json,
            "use_pre_rerank": args.use_pre_rerank,
            "weak_label_policy": "keypoint numeric/text overlap only; no company fact labels as features",
        },
    }
    model_path.write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")

    report = {
        "model": str(model_path),
        "feature_count": len(feature_names),
        "train": _evaluate(train_examples, feature_names, means, scales, weights, bias),
        "eval": _evaluate(eval_examples, feature_names, means, scales, weights, bias) if eval_examples else None,
        "top_positive_weights": [],
        "top_negative_weights": [],
    }
    weighted = sorted(zip(feature_names, weights), key=lambda item: item[1], reverse=True)
    report["top_positive_weights"] = [{"feature": name, "weight": round(float(weight), 4)} for name, weight in weighted[:12]]
    report["top_negative_weights"] = [{"feature": name, "weight": round(float(weight), 4)} for name, weight in weighted[-12:]]
    report_path = Path(args.out_report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
