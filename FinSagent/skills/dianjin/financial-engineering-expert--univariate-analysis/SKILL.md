---
name: dianjin_financial_engineering_expert_univariate_analysis
description: "【单变量分析】当用户提到\"分析某个/某些特征\"、\"看看xxx特征\"、\"xxx特征分布\"、\"帮我分箱\"、\"交叉分布\"、\"筛选特征\"、\"分析一下xxx\"等涉及少量特征分析的请求时使用。支持两种模式：(1) 无目标变量：等频/等距分箱分布、交叉分布表；(2) 有目标变量：IV值和分箱明细。适用场景关键词：分析特征、看特征、特征分布、分箱、交叉分析、IV值、单个特征、几个特征。与 feature-analysis 的区别：聚焦少量特征的快速分析，不含全量相关性和方案推荐。"
version: 0.1.0
category: dianjin_finance
---

# 单变量分析 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/univariate-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 单变量分析 (portable)

基于 `scripts/analyzer.py` 主脚本，对指定特征进行单变量级别的分布分析或预测力评估。

---

## 功能定位

| 模式 | 目标变量 | 核心功能 | 使用场景 |
|------|:--------:|----------|----------|
| 数据探索模式 | ❌ 无 | 分布分析、交叉分布 | 刚上传数据、初步了解特征分布 |
| 特征筛选模式 | ✅ 有 | IV值、分箱表、筛选建议 | 建模前快速筛选特征 |

---

## 参数说明

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` | ✅ | - | 数据文件路径（parquet/csv） |
| `--features` | ✅ | - | 待分析特征列名，逗号分隔，或 `"all"` |
| `--target` | | - | 目标变量列名（可选，有则进入筛选模式） |
| `--exclude_cols` | | - | 排除的列，逗号分隔 |
| `--binning_method` | | `quantile` | 分箱方式：`quantile`(等频) / `distance`(等距) |
| `--n_bins` | | `10` | 分箱数量 |
| `--cross` | | - | 交叉分布的两个特征，逗号分隔 |
| `--output` | | 自动生成 | 报告输出名称 |
| `--output_dir` | | `./outputs/<ts>` | 产物输出目录 |
| `--config` | | - | JSON 配置文件路径 |

---

## 执行方式

### 数据探索模式（无目标变量）

```bash
python scripts/analyzer.py \
  --data_path ./data.parquet --features "age,income,score" \
  --output_dir ./outputs/uni_run
```

### 特征筛选模式（有目标变量）

```bash

## 注意事项

1. **特征数量**：建议单次分析不超过 50 个特征，大量特征请分批处理
2. **分箱数量**：默认 10 箱，可根据数据量调整（数据量少时建议 5 箱）
3. **交叉分布**：仅支持两个特征的交叉，建议选择离散或已分箱的特征
4. **IV 计算**：需要目标变量为 0/1 二分类
5. **产物位置**：报告保存到 `<output_dir>/`
