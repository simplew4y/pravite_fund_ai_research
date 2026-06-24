from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
import pandas as pd

from model_utils import (
    ABLATION_ORDER,
    available_feature_groups,
    calibration_dataframe,
    compute_mean_ndcg_at_k,
    compute_metrics,
    incremental_ablation_columns,
    load_dataset,
    predict_relevant_proba,
    save_calibration_plot,
    save_dataset_shap_breakdown,
    save_global_shap_plot,
    save_model_bundle,
    stratified_group_split,
    train_lgbm,
    compute_shap_importance,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger("lightgbm.train_model")


def split_train_val(df: pd.DataFrame, random_state: int) -> Tuple[pd.DataFrame, pd.DataFrame]:
    if df["group_id"].nunique() <= 2:
        return df, df.iloc[0:0].copy()
    train_idx, val_idx = stratified_group_split(df, test_size=0.15, random_state=random_state)
    train_df = df.loc[train_idx].reset_index(drop=True)
    val_df = df.loc[val_idx].reset_index(drop=True)
    if len(val_df) == 0:
        return df, df.iloc[0:0].copy()
    return train_df, val_df


def evaluate_subset(
    model: Any,
    df: pd.DataFrame,
    feature_columns: List[str],
    categories: Dict[str, List[str]],
) -> Tuple[Dict[str, float], np.ndarray]:
    _, p_relevant = predict_relevant_proba(model, df, feature_columns, categories)
    metrics = compute_metrics(df["label"].astype(int).tolist(), p_relevant.tolist())
    metrics["mean_ndcg_at_5"] = compute_mean_ndcg_at_k(df, p_relevant, k=5)
    return metrics, p_relevant


def prediction_metadata_frame(df: pd.DataFrame) -> pd.DataFrame:
    base_columns = ["dataset_id", "group_id", "question_idx", "query_text", "chunk_key", "doc_id", "label"]
    optional_columns = ["agent"]
    selected_columns = [column for column in base_columns if column in df.columns]
    selected_columns.extend(column for column in optional_columns if column in df.columns)
    return df[selected_columns].copy()


def train_random_split(
    df: pd.DataFrame,
    feature_columns: List[str],
    categorical_columns: List[str],
    random_state: int,
    test_size: float,
    objective: str,
) -> Dict[str, Any]:
    train_idx, test_idx = stratified_group_split(df, test_size=test_size, random_state=random_state)
    train_full = df.loc[train_idx].reset_index(drop=True)
    test_df = df.loc[test_idx].reset_index(drop=True)
    train_df, val_df = split_train_val(train_full, random_state + 1)
    model, categories, objective_used = train_lgbm(train_df, val_df, feature_columns, categorical_columns, random_state, objective=objective)
    test_metrics, p_relevant = evaluate_subset(model, test_df, feature_columns, categories)
    by_dataset: List[Dict[str, Any]] = []
    for dataset_id, subset in test_df.groupby("dataset_id"):
        subset_metrics, subset_p_relevant = evaluate_subset(model, subset, feature_columns, categories)
        by_dataset.append({"dataset_id": dataset_id, **subset_metrics, "mean_predicted_risk": float((1.0 - subset_p_relevant).mean())})
    predictions = prediction_metadata_frame(test_df)
    predictions["p_relevant"] = p_relevant
    predictions["risk_hat"] = 1.0 - p_relevant
    calibration_df = calibration_dataframe(test_df["label"].astype(int).tolist(), p_relevant.tolist())
    return {
        "model": model,
        "categories": categories,
        "train_df": train_full,
        "test_df": test_df,
        "metrics": test_metrics,
        "by_dataset": pd.DataFrame(by_dataset),
        "predictions": predictions,
        "calibration_df": calibration_df,
        "objective_used": objective_used,
    }


def train_lodo(
    df: pd.DataFrame,
    feature_columns: List[str],
    categorical_columns: List[str],
    random_state: int,
    objective: str,
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    summary_rows: List[Dict[str, Any]] = []
    prediction_frames: List[pd.DataFrame] = []
    for holdout_dataset in sorted(df["dataset_id"].unique().tolist()):
        train_full = df[df["dataset_id"] != holdout_dataset].reset_index(drop=True)
        test_df = df[df["dataset_id"] == holdout_dataset].reset_index(drop=True)
        train_df, val_df = split_train_val(train_full, random_state + len(summary_rows) + 1)
        model, categories, objective_used = train_lgbm(
            train_df,
            val_df,
            feature_columns,
            categorical_columns,
            random_state + len(summary_rows) + 1,
            objective=objective,
        )
        metrics, p_relevant = evaluate_subset(model, test_df, feature_columns, categories)
        summary_rows.append({"holdout_dataset": holdout_dataset, **metrics, "mean_predicted_risk": float((1.0 - p_relevant).mean()), "objective_used": objective_used})
        pred = prediction_metadata_frame(test_df)
        pred["holdout_dataset"] = holdout_dataset
        pred["p_relevant"] = p_relevant
        pred["risk_hat"] = 1.0 - p_relevant
        prediction_frames.append(pred)
    summary_df = pd.DataFrame(summary_rows)
    prediction_df = pd.concat(prediction_frames, ignore_index=True) if prediction_frames else pd.DataFrame()
    return summary_df, prediction_df


def run_ablations(
    df: pd.DataFrame,
    feature_columns: List[str],
    categorical_columns: List[str],
    random_state: int,
    test_size: float,
    objective: str,
) -> pd.DataFrame:
    train_idx, test_idx = stratified_group_split(df, test_size=test_size, random_state=random_state)
    train_full = df.loc[train_idx].reset_index(drop=True)
    test_df = df.loc[test_idx].reset_index(drop=True)
    train_df, val_df = split_train_val(train_full, random_state + 7)
    ablation_rows: List[Dict[str, Any]] = []
    for stage_name, columns in incremental_ablation_columns(feature_columns):
        model, categories, objective_used = train_lgbm(
            train_df,
            val_df,
            columns,
            categorical_columns,
            random_state + len(ablation_rows) + 11,
            objective=objective,
        )
        within_metrics, _ = evaluate_subset(model, test_df, columns, categories)
        lodo_scores: List[float] = []
        lodo_prs: List[float] = []
        for holdout_dataset in sorted(df["dataset_id"].unique().tolist()):
            train_split = df[df["dataset_id"] != holdout_dataset].reset_index(drop=True)
            eval_split = df[df["dataset_id"] == holdout_dataset].reset_index(drop=True)
            split_train_df, split_val_df = split_train_val(train_split, random_state + len(ablation_rows) + 23)
            split_model, split_categories, _ = train_lgbm(
                split_train_df,
                split_val_df,
                columns,
                categorical_columns,
                random_state + len(ablation_rows) + 23,
                objective=objective,
            )
            holdout_metrics, _ = evaluate_subset(split_model, eval_split, columns, split_categories)
            lodo_scores.append(holdout_metrics["auc_roc_relevant"])
            lodo_prs.append(holdout_metrics["auc_pr_relevant"])
        ablation_rows.append(
            {
                "stage": stage_name,
                "num_features": len(columns),
                "features": "|".join(columns),
                "objective_used": objective_used,
                "within_auc_roc_relevant": within_metrics["auc_roc_relevant"],
                "within_auc_pr_relevant": within_metrics["auc_pr_relevant"],
                "lodo_mean_auc_roc_relevant": float(np.nanmean(lodo_scores)) if lodo_scores else float("nan"),
                "lodo_mean_auc_pr_relevant": float(np.nanmean(lodo_prs)) if lodo_prs else float("nan"),
            }
        )
    return pd.DataFrame(ablation_rows)


def train_final_model(
    df: pd.DataFrame,
    feature_columns: List[str],
    categorical_columns: List[str],
    random_state: int,
    objective: str,
) -> Dict[str, Any]:
    train_df, val_df = split_train_val(df, random_state + 101)
    model, categories, objective_used = train_lgbm(
        train_df,
        val_df,
        feature_columns,
        categorical_columns,
        random_state + 101,
        objective=objective,
    )
    x_full, p_relevant = predict_relevant_proba(model, df, feature_columns, categories)
    metrics = compute_metrics(df["label"].astype(int).tolist(), p_relevant.tolist())
    shap_df = compute_shap_importance(model, x_full)
    return {
        "model": model,
        "categories": categories,
        "metrics": metrics,
        "shap_df": shap_df,
        "objective_used": objective_used,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-csv", default=str(Path(__file__).resolve().parent / "data" / "chunk_features.csv"))
    parser.add_argument("--manifest-json", default=str(Path(__file__).resolve().parent / "data" / "feature_manifest.json"))
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parent / "outputs"))
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--random-state", type=int, default=42)
    parser.add_argument("--objective", choices=["lambdarank", "binary"], default="lambdarank")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    artifacts_dir = output_dir / "artifacts"
    plots_dir = output_dir / "plots"
    reports_dir = output_dir / "reports"
    for path in (artifacts_dir, plots_dir, reports_dir):
        path.mkdir(parents=True, exist_ok=True)

    df, feature_columns, categorical_columns = load_dataset(args.dataset_csv, args.manifest_json)
    logger.info("Loaded dataset with %s rows and %s features", len(df), len(feature_columns))

    random_result = train_random_split(df, feature_columns, categorical_columns, args.random_state, args.test_size, args.objective)
    random_result["predictions"].to_csv(reports_dir / "random_split_predictions.csv", index=False)
    random_result["by_dataset"].to_csv(reports_dir / "random_split_metrics_by_dataset.csv", index=False)
    random_result["calibration_df"].to_csv(reports_dir / "random_split_calibration.csv", index=False)
    save_calibration_plot(random_result["calibration_df"], str(plots_dir / "random_split_calibration.png"), "Random-split risk calibration")

    lodo_summary, lodo_predictions = train_lodo(df, feature_columns, categorical_columns, args.random_state, args.objective)
    lodo_summary.to_csv(reports_dir / "lodo_metrics.csv", index=False)
    lodo_predictions.to_csv(reports_dir / "lodo_predictions.csv", index=False)

    ablation_df = run_ablations(df, feature_columns, categorical_columns, args.random_state, args.test_size, args.objective)
    ablation_df.to_csv(reports_dir / "ablation.csv", index=False)

    final_result = train_final_model(df, feature_columns, categorical_columns, args.random_state, args.objective)
    final_result["shap_df"].to_csv(reports_dir / "global_shap_importance.csv", index=False)
    save_global_shap_plot(final_result["shap_df"], str(plots_dir / "global_shap_importance.png"))
    shap_breakdown_df = save_dataset_shap_breakdown(final_result["model"], df, feature_columns, final_result["categories"], str(plots_dir / "dataset_shap_breakdown.png"))
    shap_breakdown_df.to_csv(reports_dir / "dataset_shap_breakdown.csv", index=False)

    weak_lodo = lodo_summary[lodo_summary["auc_roc_relevant"].between(0.45, 0.55, inclusive="both")]["holdout_dataset"].tolist()
    summary = {
        "random_split": random_result["metrics"],
        "random_split_by_dataset": json.loads(random_result["by_dataset"].to_json(orient="records")),
        "lodo": json.loads(lodo_summary.to_json(orient="records")),
        "lodo_mean_auc_roc_relevant": float(lodo_summary["auc_roc_relevant"].mean()),
        "lodo_mean_auc_pr_relevant": float(lodo_summary["auc_pr_relevant"].mean()),
        "datasets_flagged_auc_near_half": weak_lodo,
        "final_model_train_metrics": final_result["metrics"],
        "objective_used": final_result["objective_used"],
        "feature_group_order": ABLATION_ORDER,
        "feature_groups": available_feature_groups(feature_columns),
        "risk_definition": "risk_hat = 1 - p_relevant",
    }
    with (reports_dir / "summary.json").open("w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    save_model_bundle(
        final_result["model"],
        final_result["categories"],
        feature_columns,
        categorical_columns,
        str(artifacts_dir),
        extra_metadata={
            "summary": summary,
        },
    )
    logger.info("Saved reports to %s", reports_dir)
    logger.info("Saved plots to %s", plots_dir)
    logger.info("Saved model artifacts to %s", artifacts_dir)


if __name__ == "__main__":
    main()
