---
name: dianjin_financial_engineering_expert_segment_modeling
description: "【分群自主探索】当用户需要\"分群建模\"、\"客群拆分训练\"、\"探索最优分群方案\"、\"按xxx分组建模\"、\"不同客群分别训练\"、\"分群策略\"时使用。支持规则分群（人类先验）、聚类分群（无监督发现）、决策树分群（有监督优化），自动探索最优分群策略并汇总子模型。前提条件：需要已完成基线建模（xgb-modeling）。不做全量样本统一建模，不做超参数调优。与 xgb-modeling 的区别：本 Skill 拆分客群分别建模，xgb-modeling 全量样本统一建模。"
version: 0.1.0
category: dianjin_finance
---

# 分群自主探索 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/segment-modeling` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 分群自主探索 (portable)

在用户指定或 AI 自主发现的分群策略下，拆分客群训练子模型，自动探索最优分群方案。

**核心理念**：

```
探索空间（策略 × 参数 × 组合）
        │
        ▼
Try → Measure → Keep/Discard → Repeat
        │
        ▼
    最优分群方案 + 子模型
```

---

## 三种分群策略

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| **规则分群** | 用户指定规则（如 `age < 30`） | 有业务先验知识 |
| **聚类分群** | K-Means 等无监督自动发现 | 探索数据内在结构 |
| **决策树分群** | 有监督找最优分割点 | 直接优化目标变量 |

---

## 参数说明

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` | ✅ | - | 数据文件路径（parquet/csv） |
| `--target` | ✅ | - | 目标变量列名（0/1 二分类） |
| `--mode` | | `auto` | 模式: `auto`(自主探索) / `manual`(指定策略) |
| `--max_rounds` | | `5` | 自主探索最大轮数 |
| `--segment_rules` | | - | 规则分群，JSON格式 |
| `--segment_col` | | - | 直接指定分群列名 |
| `--n_clusters` | | `3` | 聚类分群数 |
| `--tree_depth` | | `2` | 决策树分群深度 |
| `--tree_features` | | - | 决策树使用的特征，逗号分隔 |
| `--min_segment_ratio` | | `0.05` | 最小分群占比（<5%会警告） |
| `--merge_strategy` | | `route` | 汇总策略: `route` / `stacking` |
| `--metric` | | `ks` | 优化指标（auc/ks） |
| `--significance` | | `2.0` | 显著性阈值（MAD倍数） |

## 注意事项

1. **分群数量**：建议 2-5 群，太多易过拟合
2. **最小样本量**：每群建议 > 5% 总样本
3. **稳定性**：关注 OOT 分群比例是否稳定
4. **业务可解释**：决策树分群规则更易解释
5. **组合使用**：可先分群再对各群做特征探索
