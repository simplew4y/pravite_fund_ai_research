"""
Example command:
python lightgbm/filter_query_balance.py --input-csv lightgbm/data/chunk_features_reduced_46804.csv --output-csv lightgbm/data/chunk_features_reduced_13788.csv
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd


DEFAULT_QUERY_COLUMNS = ["group_id", "query_text"]
POSITIVE_LABEL = 1
NEGATIVE_LABEL = 0
DEFAULT_NEG_RATIO = 4
DEFAULT_MIN_NEG = 2
DEFAULT_HARD_NEG_FRACTION = 0.6
DEFAULT_RANDOM_STATE = 42


def sort_group_rows(df: pd.DataFrame, positive: bool) -> pd.DataFrame:
    sort_columns: list[str] = []
    ascending: list[bool] = []

    if "cross_encoder_score" in df.columns:
        sort_columns.append("cross_encoder_score")
        ascending.append(False)
    if "min_rank" in df.columns:
        sort_columns.append("min_rank")
        ascending.append(True)
    if "num_retrieval_paths" in df.columns:
        sort_columns.append("num_retrieval_paths")
        ascending.append(False)
    if "chunk_key" in df.columns:
        sort_columns.append("chunk_key")
        ascending.append(True)

    if not sort_columns:
        return df.copy()

    return df.sort_values(sort_columns, ascending=ascending, kind="mergesort")


def balance_group(
    group: pd.DataFrame,
    neg_ratio: int = DEFAULT_NEG_RATIO,
    min_neg: int = DEFAULT_MIN_NEG,
    hard_neg_fraction: float = DEFAULT_HARD_NEG_FRACTION,
    random_state: int = DEFAULT_RANDOM_STATE,
) -> pd.DataFrame:
    positives = group[group["label"] == POSITIVE_LABEL]
    negatives = group[group["label"] == NEGATIVE_LABEL]

    if len(positives) == 0:
        return group.iloc[0:0].copy()

    max_neg = max(len(positives) * neg_ratio, min_neg)
    max_neg = min(max_neg, len(negatives))

    hard_fraction = min(max(hard_neg_fraction, 0.0), 1.0)
    n_hard = min(int(max_neg * hard_fraction), len(negatives))
    n_random = max_neg - n_hard

    hard_negatives = sort_group_rows(negatives, positive=False).head(n_hard)
    remaining = negatives.drop(hard_negatives.index)
    if n_random > 0 and len(remaining) > 0:
        random_negatives = remaining.sample(n=min(n_random, len(remaining)), random_state=random_state)
        kept_negatives = pd.concat([hard_negatives, random_negatives], axis=0)
    else:
        kept_negatives = hard_negatives

    combined = pd.concat([positives, kept_negatives], axis=0)
    return combined.sort_index(kind="stable")


def balance_dataset(
    df: pd.DataFrame,
    query_columns: list[str],
    neg_ratio: int = DEFAULT_NEG_RATIO,
    min_neg: int = DEFAULT_MIN_NEG,
    hard_neg_fraction: float = DEFAULT_HARD_NEG_FRACTION,
    random_state: int = DEFAULT_RANDOM_STATE,
) -> pd.DataFrame:
    missing = [column for column in query_columns + ["label"] if column not in df.columns]
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    invalid_labels = sorted(set(df["label"].dropna().unique()) - {NEGATIVE_LABEL, POSITIVE_LABEL})
    if invalid_labels:
        raise ValueError(f"Expected binary labels 0/1, found: {invalid_labels}")

    balanced_groups = []
    grouped = df.groupby(query_columns, dropna=False, sort=False)
    for _, group in grouped:
        balanced = balance_group(
            group,
            neg_ratio=neg_ratio,
            min_neg=min_neg,
            hard_neg_fraction=hard_neg_fraction,
            random_state=random_state,
        )
        if not balanced.empty:
            balanced_groups.append(balanced)

    if not balanced_groups:
        return df.iloc[0:0].copy()

    return pd.concat(balanced_groups, axis=0).sort_index(kind="stable")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-csv", required=True)
    parser.add_argument("--output-csv", default=None)
    parser.add_argument("--query-columns", nargs="+", default=DEFAULT_QUERY_COLUMNS)
    parser.add_argument("--neg-ratio", type=int, default=DEFAULT_NEG_RATIO)
    parser.add_argument("--min-neg", type=int, default=DEFAULT_MIN_NEG)
    parser.add_argument("--hard-neg-fraction", type=float, default=DEFAULT_HARD_NEG_FRACTION)
    parser.add_argument("--random-state", type=int, default=DEFAULT_RANDOM_STATE)
    args = parser.parse_args()

    input_csv = Path(args.input_csv)
    output_csv = Path(args.output_csv) if args.output_csv else input_csv

    df = pd.read_csv(input_csv, low_memory=False)
    balanced = balance_dataset(
        df,
        list(args.query_columns),
        neg_ratio=args.neg_ratio,
        min_neg=args.min_neg,
        hard_neg_fraction=args.hard_neg_fraction,
        random_state=args.random_state,
    )
    balanced.to_csv(output_csv, index=False)

    group_sizes = balanced.groupby(args.query_columns, dropna=False)["label"].agg(["count", "sum"])
    positive_rate = float(balanced["label"].mean()) if len(balanced) else 0.0

    print(f"input_rows={len(df)}")
    print(f"output_rows={len(balanced)}")
    print(f"queries_kept={len(group_sizes)}")
    print(f"positive_rate={positive_rate:.6f}")
    if not group_sizes.empty:
        query_positive_rates = group_sizes["sum"] / group_sizes["count"]
        print(f"query_positive_rate_min={query_positive_rates.min():.6f}")
        print(f"query_positive_rate_max={query_positive_rates.max():.6f}")
        print(f"queries_with_negatives={(group_sizes['count'] > group_sizes['sum']).sum()}")
    else:
        print("query_positive_rate_min=0.000000")
        print("query_positive_rate_max=0.000000")
        print("queries_with_negatives=0")


if __name__ == "__main__":
    main()
