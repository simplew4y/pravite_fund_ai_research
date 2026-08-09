---
name: dianjin_financial_engineering_expert_feature_analysis
description: "【特征深度分析】当用户需要\"全面分析特征\"、\"生成特征报告\"、\"看相关性\"、\"推荐建模方案\"、\"跑一遍特征\"、\"特征全景\"、\"哪些特征有用\"时使用。包含四大维度：基础统计、IV值、PSI稳定性、相关性分析，输出四套建模特征方案。前提条件：必须提供目标变量。不做单特征快速探索，不做模型训练。与 univariate-analysis 的区别：本 Skill 是全量特征深度分析+方案推荐，univariate-analysis 聚焦少量特征快速分析。"
version: 0.1.0
category: dianjin_finance
---

# 建模特征分析报告 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/feature-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 建模特征分析报告 (portable)

基于 `scripts/analyzer.py` 主脚本，对数据集特征进行全面分析并生成 Markdown 报告。

---

## 参数说明

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` | ✅ | - | 数据文件路径（parquet/csv） |
| `--target` | ✅ | - | 目标变量列名（0/1 二分类） |
| `--exclude_cols` | | - | 排除列，逗号分隔 |
| `--baseline_filter` | | - | PSI 基准数据条件（pandas query） |
| `--comparison_filter` | | - | PSI 对比数据条件（pandas query） |
| `--top_n` | | `10` | 输出 IV 排名前 N 的特征分箱明细（默认 10） |
| `--specified_features` | | - | 指定特征分箱明细，逗号分隔 |
| `--output` | | `feature_analysis_report.md` | 报告输出名称 |
| `--output_dir` | | `./outputs/<ts>` | 产物输出目录 |
| `--config` | | - | JSON 配置文件路径 |

---

## 执行方式

```bash
python scripts/analyzer.py \
  --data_path ./data.parquet --target y_label \
  --exclude_cols "cust_code,busi_dt" \
  --baseline_filter "busi_dt <= '20250501'" \
  --comparison_filter "busi_dt > '20250701'" \
  --output_dir ./outputs/fa_run
```

---

## 常用场景

### 场景一：基础分析（不含 PSI）

适用于无时间维度的数据集：

```bash
python scripts/analyzer.py --data_path ./data.parquet --target y_label --output_dir ./outputs/fa_run
```

## 注意事项

1. **目标变量**：必须为数值型
2. **PSI 分析**：需同时提供 `baseline_filter` 和 `comparison_filter`，否则跳过
3. **相关性**：仅对数值型特征有效，非数值列自动跳过
4. **大数据集**：报告默认展示 IV Top 20，完整数据在文件中
5. **产物位置**：报告保存到 `<output_dir>/`
