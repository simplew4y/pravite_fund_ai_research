---
name: dianjin_financial_engineering_expert_model_explanation
description: "【模型解释】当用户问\"为什么模型这样预测\"、\"哪些特征最重要\"、\"解释一下这个样本\"、\"模型怎么做的决策\"、\"feature importance\"、\"为什么给这个分数\"时使用。基于SHAP的模型解释，支持全局特征重要性、单样本预测解释、特征交互分析。前提条件：需要已训练好的XGBoost模型。不做模型训练，不做特征筛选。与 feature-analysis 的区别：本 Skill 解释\"已训练模型的决策逻辑\"，feature-analysis 分析\"建模前的特征质量\"。"
version: 0.1.0
category: dianjin_finance
---

# 模型解释报告 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/model-explanation` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 模型解释报告 (portable)

基于 SHAP (SHapley Additive exPlanations) 对 XGBoost 模型进行可解释性分析，生成包含可视化图表的 Markdown 报告。

---

## 参数说明

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--model_path` | ✅ | - | XGBoost 模型文件路径 (.json) |
| `--data_path` | ✅ | - | 数据文件路径（parquet/csv） |
| `--target` | ✅ | - | 目标变量列名 |
| `--features` | | *auto* | 特征列表，逗号分隔。不传时从 `<model>_meta.json` 自动读取 |
| `--sample_id` | | - | 单样本解释：样本索引或ID |
| `--sample_filter` | | - | 单样本解释：pandas query 条件 |
| `--top_n` | | `20` | 全局解释显示 Top N 特征 |
| `--interaction_features` | | - | 交互分析特征对，如 `f1,f2` |
| `--output_dir` | | `./outputs/<ts>` | 产物输出目录 |
| `--output_name` | | `model_explanation_report` | 报告基名 |
| `--config` | | - | JSON 配置文件路径 |

---

## 执行方式

```bash
python scripts/explainer.py \
  --model_path ./models/my_model.json \
  --data_path ./examples/toy.parquet \
  --target y_label \
  --output_dir ./outputs/explain_run
```

单样本解释：

```bash
python scripts/explainer.py \
  --model_path ./models/my_model.json \
  --data_path ./examples/toy.parquet \
  --target y_label \
  --sample_id 1001 \
  --output_dir ./outputs/explain_run
```

## 注意事项

1. **模型格式**：仅支持 XGBoost JSON 格式模型文件
2. **数据一致性**：`--data_path` 需与训练时使用的数据字段一致
3. **样本定位**：`--sample_id` 为数据框的整数索引，非业务ID
4. **内存占用**：大数据集的全局 SHAP 计算可能耗时较长
5. **图表依赖**：需要 matplotlib 和 shap 库支持
6. **base_score 兼容**：XGBoost >= 1.7 的 `base_score` 为数组，脚本会自动修复为标量以兼容 SHAP
