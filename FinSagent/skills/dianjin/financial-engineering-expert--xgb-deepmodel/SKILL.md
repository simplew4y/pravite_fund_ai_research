---
name: dianjin_financial_engineering_expert_xgb_deepmodel
description: "【DeepModel深度建模】当用户需要\"分群集成建模\"、\"分群+Stacking融合\"、\"子模型训练+集成\"时使用。核心能力：按业务分群条件训练多个 XGBoost 子模型，通过 Stacking 融合成主模型，并与单模型基线对比。适用于\"分群建模\"、\"按客群分别建模\"、\"子模型融合\"、\"集成学习\"等高级场景。包含三个脚本：sub_trainer（分群子模型训练）、stacker（XGBoost Stacking融合）、comparator（集成vs基线对比）。与 xgb-modeling 的区别：本 Skill 拆分客群分别建模再融合，xgb-modeling 全量样本统一建模。与 seg"
version: 0.1.0
category: dianjin_finance
---

# XGBoost DeepModel — 分群集成建模 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/xgb-deepmodel` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# XGBoost DeepModel — 分群集成建模 (portable)

分群训练多个 XGBoost 子模型，通过 OOF Stacking 融合成主模型，评估集成收益。

---

## 阶段1：训练分群子模型

### 参数说明

> 参数 spec：`_vendor/xgb_cli.py` 中 `domain=deepmodel-sub`。复杂嵌套 JSON（segments / features_per_segment / pos_weight_per_segment）**必须**走 `--config`。

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` / `-d` | ✅ | - | 数据文件路径 |
| `--target` / `-t` | ✅ | - | 目标变量列名 |
| `--segments` | ✅* | - | 分群条件 JSON（**推荐通过 `--config` 的 `segments` 字段**） |
| `--segment_col` | ✅* | - | 按列唯一值自动分群（与 segments 二选一） |
| `--time_col` | | `busi_dt` | 时间列名 |
| `--train_filter` | | 自动切分 | 全局训练集筛选条件 |
| `--val_filter` | | `val_ratio` 切出 | 全局验证集筛选条件 |
| `--oot_filter` | | 按时间切出 | OOT 测试集条件 |
| `--exclude_cols` | | - | 排除列，逗号分隔 |
| `--features` | | 自动筛选 | 全局特征列表，逗号分隔 |
| `--features_per_segment` | | - | 分群差异化特征 JSON（**走 `--config`**） |
| `--sample_weight_col` | | - | 样本权重列名 |
| `--pos_weight_per_segment` | | - | 各分群正样本权重 JSON（**走 `--config`**） |
| `--auto` | | `false` | flag。对 OOT Gap > 0.05 的分群自动调参 |
| `--output_dir` | | `./outputs/<ts>` | 子模型保存目录 |
| `--config` | | - | JSON 配置路径 |

### 执行方式

```bash
python scripts/sub_trainer.py \
  --data_path ./data.parquet --target y_label \
  --time_col busi_dt --exclude_cols "cust_code,busi_dt" \
  --auto --output_dir ./outputs/deepmodel
```

配合 `--config` 传入结构化 JSON：

```json
{
  "segments": {"高风险": "risk_score > 500", "低风险": "risk_score <= 500"},

## 注意事项

1. **分群互斥**：各分群条件应互斥（一个样本只属于一个分群），否则 Stacking 会有信息泄漏
2. **样本量**：每个分群的训练样本应 ≥ 500，过少的分群建议合并
3. **OOF 生成**：Stacking 的 OOF 预测在各分群内独立做 k-fold，保证无标签泄漏
4. **Meta-learner**：固定使用保守参数（max_depth=2），不做超参搜索，避免过拟合
5. **子模型路径传递**：stacker 和 comparator 支持从 `--config` 读取子模型路径
6. **三阶段顺序**：必须先 sub_trainer → stacker → comparator，阶段间通过文件系统传递产物
