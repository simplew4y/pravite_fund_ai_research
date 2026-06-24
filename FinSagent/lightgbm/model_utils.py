from __future__ import annotations

import importlib
import json
import logging
import pickle
import sys
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.metrics import average_precision_score, brier_score_loss, ndcg_score, roc_auc_score

CURRENT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = CURRENT_DIR.parent
logger = logging.getLogger("lightgbm.model_utils")

NON_FEATURE_COLUMNS = {
    "collection_name",
    "group_id",
    "question_idx",
    "agent",
    "dataset_id",
    "query_text",
    "original_question",
    "chunk_key",
    "chunk_text",
    "doc_id",
    "source_file",
    "label",
    "label_source",
}

FEATURE_GROUPS = {
    "path": [
        "retrieval_path",
        "num_retrieval_paths",
        "has_faiss",
        "has_bm25",
        "has_title_summary",
        "has_table",
        "faiss_score",
        "bm25_score",
        "title_summary_score",
        "table_score",
        "faiss_rank",
        "bm25_rank",
        "title_summary_rank",
        "table_rank",
        "min_rank",
    ],
    "lexical": [
        "query_token_len",
        "chunk_token_len",
        "token_overlap_count",
        "token_overlap_ratio_query",
        "token_overlap_ratio_chunk",
        "token_jaccard",
        "query_number_count",
        "chunk_number_count",
        "number_overlap_count",
        "year_overlap_count",
        "title_summary_token_len",
    ],
    "metadata": [
        "chunk_type",
        "page_number",
        "doc_year",
    ],
    "query_context": [
        # "dataset_id",
        "query_language",
    ],
    "reranker": ["cross_encoder_score"],
}

ABLATION_ORDER = ["path", "lexical", "metadata", "query_context", "reranker"]


def import_external_lightgbm():
    blocked = {CURRENT_DIR.resolve(), PROJECT_ROOT.resolve()}
    removed: List[str] = []
    for path in list(sys.path):
        try:
            resolved = Path(path or ".").resolve()
        except Exception:
            continue
        if resolved in blocked:
            removed.append(path)
            sys.path.remove(path)
    try:
        try:
            return importlib.import_module("lightgbm")
        except ModuleNotFoundError as exc:
            raise ModuleNotFoundError(
                "The external 'lightgbm' package is not installed in the current environment. "
                "Install it in lotusenv before running lightgbm/train_model.py."
            ) from exc
    finally:
        for path in reversed(removed):
            if path not in sys.path:
                sys.path.insert(0, path)


lgb = import_external_lightgbm()


def load_dataset(dataset_csv: str, manifest_json: str | None = None) -> Tuple[pd.DataFrame, List[str], List[str]]:
    df = pd.read_csv(dataset_csv)
    manifest: Dict[str, Any] = {}
    if manifest_json and Path(manifest_json).exists():
        with open(manifest_json, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    categorical_columns = manifest.get("categorical_columns") or ["retrieval_path", "chunk_type", "dataset_id", "query_language"]
    feature_columns = manifest.get("feature_columns") or [column for column in df.columns if column not in NON_FEATURE_COLUMNS]
    feature_columns = [column for column in feature_columns if column != "dataset_id"]
    categorical_columns = [column for column in categorical_columns if column in feature_columns]
    for column in categorical_columns:
        if column in df.columns:
            df[column] = df[column].fillna("missing").astype(str)
    for column in feature_columns:
        if column in df.columns and column not in categorical_columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")
    df["label"] = df["label"].astype(int)
    return df, feature_columns, categorical_columns


def available_feature_groups(feature_columns: Sequence[str]) -> Dict[str, List[str]]:
    return {group: [column for column in columns if column in feature_columns] for group, columns in FEATURE_GROUPS.items()}


def stratified_group_split(df: pd.DataFrame, test_size: float, random_state: int) -> Tuple[pd.Index, pd.Index]:
    rng = np.random.default_rng(random_state)
    group_frame = df[["group_id", "dataset_id"]].drop_duplicates().reset_index(drop=True)
    train_groups: List[str] = []
    test_groups: List[str] = []
    for _, subset in group_frame.groupby("dataset_id"):
        group_ids = subset["group_id"].tolist()
        if len(group_ids) <= 1:
            train_groups.extend(group_ids)
            continue
        shuffled = list(group_ids)
        rng.shuffle(shuffled)
        test_count = max(1, int(round(len(shuffled) * test_size)))
        test_count = min(test_count, len(shuffled) - 1)
        test_groups.extend(shuffled[:test_count])
        train_groups.extend(shuffled[test_count:])
    train_mask = df["group_id"].isin(train_groups)
    test_mask = df["group_id"].isin(test_groups)
    return df.index[train_mask], df.index[test_mask]


def _apply_categories(df: pd.DataFrame, feature_columns: Sequence[str], categories: Dict[str, List[str]]) -> pd.DataFrame:
    x = df.loc[:, feature_columns].copy()
    for column, allowed in categories.items():
        if column in x.columns:
            x[column] = pd.Categorical(df[column].fillna("missing").astype(str), categories=allowed)
    return x


def prepare_train_eval(
    train_df: pd.DataFrame,
    eval_df: pd.DataFrame,
    feature_columns: Sequence[str],
    categorical_columns: Sequence[str],
) -> Tuple[pd.DataFrame, pd.DataFrame, Dict[str, List[str]]]:
    categories: Dict[str, List[str]] = {}
    for column in categorical_columns:
        if column not in feature_columns:
            continue
        categories[column] = sorted(train_df[column].fillna("missing").astype(str).unique().tolist())
    return _apply_categories(train_df, feature_columns, categories), _apply_categories(eval_df, feature_columns, categories), categories


def _ordered_group_frame(df: pd.DataFrame) -> pd.DataFrame:
    if len(df) == 0:
        return df.copy()
    group_col = "group_id" if "group_id" in df.columns else "question_idx"
    sort_columns = [group_col]
    if "question_idx" in df.columns and "question_idx" != group_col:
        sort_columns.append("question_idx")
    if "chunk_key" in df.columns:
        sort_columns.append("chunk_key")
    return df.sort_values(sort_columns, kind="mergesort").reset_index(drop=True)


def _group_sizes(df: pd.DataFrame) -> np.ndarray:
    if len(df) == 0:
        return np.asarray([], dtype=int)
    group_col = "group_id" if "group_id" in df.columns else "question_idx"
    return df.groupby(group_col, sort=False).size().to_numpy(dtype=int)


def train_lgbm(
    train_df: pd.DataFrame,
    val_df: pd.DataFrame,
    feature_columns: Sequence[str],
    categorical_columns: Sequence[str],
    random_state: int,
    objective: str = "lambdarank",
) -> Tuple[Any, Dict[str, List[str]], str]:
    train_df = _ordered_group_frame(train_df)
    val_df = _ordered_group_frame(val_df)
    x_train, x_val, categories = prepare_train_eval(train_df, val_df, feature_columns, categorical_columns)
    y_train = train_df["label"].astype(int)
    y_val = val_df["label"].astype(int)
    cat_features = [column for column in categorical_columns if column in feature_columns]
    if objective == "lambdarank":
        model = lgb.LGBMRanker(
            objective="lambdarank",
            metric="ndcg",
            n_estimators=1200,
            learning_rate=0.03,
            num_leaves=15,
            max_depth=5,
            min_child_samples=80,
            subsample=0.7,
            colsample_bytree=0.7,
            reg_alpha=0.5,
            reg_lambda=3.0,
            random_state=random_state,
            n_jobs=-1,
            label_gain=[0, 1],
        )
        fit_kwargs = {
            "X": x_train,
            "y": y_train,
            "group": _group_sizes(train_df),
            "categorical_feature": cat_features,
        }
        if len(val_df):
            fit_kwargs["eval_set"] = [(x_val, y_val)]
            fit_kwargs["eval_group"] = [_group_sizes(val_df)]
            fit_kwargs["eval_metric"] = "ndcg"
            fit_kwargs["callbacks"] = [lgb.early_stopping(stopping_rounds=50, verbose=False)]
        model.fit(**fit_kwargs)
        return model, categories, "lambdarank"
    if objective != "binary":
        raise ValueError(f"Unsupported objective: {objective}")
    model = lgb.LGBMClassifier(
        objective="binary",
        n_estimators=1200,
        learning_rate=0.05,
        num_leaves=63,
        min_child_samples=25,
        subsample=0.85,
        colsample_bytree=0.85,
        reg_alpha=0.1,
        reg_lambda=1.0,
        random_state=random_state,
        n_jobs=-1,
        # class_weight="balanced",
    )
    fit_kwargs = {
        "X": x_train,
        "y": y_train,
        "categorical_feature": cat_features,
    }
    if len(val_df) and y_val.nunique() > 1:
        fit_kwargs["eval_set"] = [(x_val, y_val)]
        fit_kwargs["eval_metric"] = ["auc", "average_precision"]
        fit_kwargs["callbacks"] = [lgb.early_stopping(stopping_rounds=50, verbose=False)]
    model.fit(**fit_kwargs)
    return model, categories, "binary"


def predict_relevant_proba(model: Any, df: pd.DataFrame, feature_columns: Sequence[str], categories: Dict[str, List[str]]) -> Tuple[pd.DataFrame, np.ndarray]:
    x = _apply_categories(df, feature_columns, categories)
    if hasattr(model, "predict_proba"):
        proba = model.predict_proba(x)[:, 1]
    else:
        scores = np.asarray(model.predict(x), dtype=float)
        proba = 1.0 / (1.0 + np.exp(-scores))
    return x, proba


def _safe_metric(func, y_true: Sequence[int], scores: Sequence[float]) -> float:
    try:
        if len(set(y_true)) < 2:
            return float("nan")
        return float(func(y_true, scores))
    except Exception:
        return float("nan")


def compute_metrics(y_true: Sequence[int], p_relevant: Sequence[float]) -> Dict[str, float]:
    y_true = np.asarray(y_true, dtype=int)
    p_relevant = np.asarray(p_relevant, dtype=float)
    p_risk = 1.0 - p_relevant
    y_negative = 1 - y_true
    return {
        "rows": int(len(y_true)),
        "positive_rate": float(y_true.mean()) if len(y_true) else float("nan"),
        "auc_roc_relevant": _safe_metric(roc_auc_score, y_true, p_relevant),
        "auc_pr_relevant": _safe_metric(average_precision_score, y_true, p_relevant),
        "auc_roc_risk": _safe_metric(roc_auc_score, y_negative, p_risk),
        "auc_pr_risk": _safe_metric(average_precision_score, y_negative, p_risk),
        "brier_relevant": float(brier_score_loss(y_true, p_relevant)) if len(set(y_true)) > 1 else float("nan"),
        "brier_risk": float(brier_score_loss(y_negative, p_risk)) if len(set(y_negative)) > 1 else float("nan"),
    }


def compute_mean_ndcg_at_k(df: pd.DataFrame, scores: Sequence[float], k: int = 5) -> float:
    if len(df) == 0:
        return float("nan")
    group_col = "group_id" if "group_id" in df.columns else "question_idx"
    score_array = np.asarray(scores, dtype=float)
    ndcg_values: List[float] = []
    for _, indices in df.groupby(group_col, sort=False).groups.items():
        group_labels = df.loc[list(indices), "label"].astype(float).to_numpy()
        group_positions = df.index.get_indexer(indices)
        if np.any(group_positions < 0):
            continue
        group_scores = score_array[group_positions]
        if len(group_labels) == 0:
            continue
        try:
            ndcg_values.append(float(ndcg_score(group_labels.reshape(1, -1), group_scores.reshape(1, -1), k=k)))
        except Exception:
            continue
    return float(np.mean(ndcg_values)) if ndcg_values else float("nan")


def calibration_dataframe(y_true: Sequence[int], p_relevant: Sequence[float], n_bins: int = 10) -> pd.DataFrame:
    y_negative = 1 - np.asarray(y_true, dtype=int)
    p_risk = 1.0 - np.asarray(p_relevant, dtype=float)
    if len(y_negative) == 0 or len(np.unique(y_negative)) < 2:
        return pd.DataFrame({"predicted_risk": [], "actual_negative_rate": []})
    prob_true, prob_pred = calibration_curve(y_negative, p_risk, n_bins=n_bins, strategy="quantile")
    return pd.DataFrame({"predicted_risk": prob_pred, "actual_negative_rate": prob_true})


def save_calibration_plot(calibration_df: pd.DataFrame, output_path: str, title: str) -> None:
    plt.figure(figsize=(6, 6))
    plt.plot([0, 1], [0, 1], linestyle="--", color="gray")
    if len(calibration_df):
        plt.plot(calibration_df["predicted_risk"], calibration_df["actual_negative_rate"], marker="o")
    plt.xlabel("Predicted risk")
    plt.ylabel("Observed negative rate")
    plt.title(title)
    plt.tight_layout()
    plt.savefig(output_path, dpi=200)
    plt.close()


def compute_shap_importance(model: Any, x: pd.DataFrame) -> pd.DataFrame:
    shap_values = model.booster_.predict(x, pred_contrib=True)
    if shap_values.ndim == 2 and shap_values.shape[1] == len(x.columns) + 1:
        shap_values = shap_values[:, :-1]
    importance = np.abs(shap_values).mean(axis=0)
    return pd.DataFrame({"feature": list(x.columns), "mean_abs_shap": importance}).sort_values("mean_abs_shap", ascending=False)


def save_global_shap_plot(importance_df: pd.DataFrame, output_path: str, top_n: int = 20) -> None:
    plot_df = importance_df.head(top_n).iloc[::-1]
    plt.figure(figsize=(8, max(6, 0.35 * len(plot_df))))
    plt.barh(plot_df["feature"], plot_df["mean_abs_shap"])
    plt.xlabel("Mean |SHAP|")
    plt.title("Global feature importance")
    plt.tight_layout()
    plt.savefig(output_path, dpi=200)
    plt.close()


def save_dataset_shap_breakdown(model: Any, df: pd.DataFrame, feature_columns: Sequence[str], categories: Dict[str, List[str]], output_path: str, top_n: int = 15) -> pd.DataFrame:
    frames: List[pd.DataFrame] = []
    for dataset_id, subset in df.groupby("dataset_id"):
        x_subset = _apply_categories(subset, feature_columns, categories)
        importance_df = compute_shap_importance(model, x_subset).head(top_n).copy()
        importance_df["dataset_id"] = dataset_id
        frames.append(importance_df)
    combined = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=["feature", "mean_abs_shap", "dataset_id"])
    if len(combined):
        pivot = combined.pivot_table(index="feature", columns="dataset_id", values="mean_abs_shap", fill_value=0.0)
        ordered = pivot.mean(axis=1).sort_values(ascending=False).head(top_n).index
        pivot = pivot.loc[ordered]
        plt.figure(figsize=(8, max(6, 0.35 * len(pivot))))
        plt.imshow(pivot.values, aspect="auto")
        plt.xticks(range(len(pivot.columns)), pivot.columns, rotation=45, ha="right")
        plt.yticks(range(len(pivot.index)), pivot.index)
        plt.colorbar(label="Mean |SHAP|")
        plt.title("Per-dataset feature importance")
        plt.tight_layout()
        plt.savefig(output_path, dpi=200)
        plt.close()
    return combined


def incremental_ablation_columns(feature_columns: Sequence[str]) -> List[Tuple[str, List[str]]]:
    groups = available_feature_groups(feature_columns)
    selected: List[str] = []
    ablations: List[Tuple[str, List[str]]] = []
    for group in ABLATION_ORDER:
        for column in groups.get(group, []):
            if column not in selected:
                selected.append(column)
        ablations.append((group, list(selected)))
    return ablations


def save_model_bundle(
    model: Any,
    categories: Dict[str, List[str]],
    feature_columns: Sequence[str],
    categorical_columns: Sequence[str],
    output_dir: str,
    extra_metadata: Dict[str, Any],
) -> None:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "model.pkl").open("wb") as f:
        pickle.dump(
            {
                "model": model,
                "feature_columns": list(feature_columns),
                "categorical_columns": list(categorical_columns),
                "categories": categories,
                "risk_definition": "risk_hat = 1 - p_relevant",
                **extra_metadata,
            },
            f,
        )
    model.booster_.save_model(str(out_dir / "model.txt"))
