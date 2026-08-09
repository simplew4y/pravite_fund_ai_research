---
name: dianjin_financial_engineering_expert_dnn_tuning
description: "【DNN调参】当用户说\"DNN调参\"、\"深度学习调参\"、\"调整网络结构\"、\"调整dropout\"、\"DNN过拟合\"时使用。基于 Optuna TPE 贝叶斯优化，搜索网络架构（层数、宽度、dropout）和训练参数（learning_rate、weight_decay、batch_size），诊断驱动约束搜索空间。前置条件：需先用 dnn-modeling 训练出基线模型。"
version: 0.1.0
category: dianjin_finance
---

# DNN 深度学习参数调优 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/dnn-tuning` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# DNN 深度学习参数调优 (portable)

DNN 调参的**唯一入口**，基于 `_vendor/tuning/dnn_engine.DNNTuningEngine`。

核心设计：搜索期间缩减 epochs（加速），诊断驱动动态约束搜索空间。

---

## 调优流程

```
基线 DNN 模型 → 诊断分析(过拟合/欠拟合) → 约束空间构造 → Optuna 搜索(30 epochs) → 最优参数 → 迭代
```

---

## 执行模式

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| **交互式**（默认） | 用户说"调参"/"帮我调一下DNN" | 每轮暂停等待用户反馈 |
| **AUTO** | 用户说"自动调优"/"帮我调到最优" | Agent 自动迭代直到收敛 |

**默认模式**: 交互式（更安全，用户可控）

---

## 参数说明

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` / `-d` | ✅ | - | 数据文件路径（parquet/csv） |
| `--target` / `-t` | ✅ | - | 目标变量列名（0/1 二分类） |
| `--features` | | 自动推断 | 特征列表，逗号分隔 |
| `--time_col` | | `busi_dt` | 时间列名 |
| `--train_filter` | | 自动切分 | 训练集筛选条件 |
| `--val_filter` | | `val_ratio` 切出 | 验证集筛选条件 |
| `--oot_filter` | | 按时间切出 | OOT 条件 |
| `--oot_ratio` | | `0.20` | OOT 占比 |
| `--val_ratio` | | `0.25` | Val 占比 |
| `--random_seed` | | `42` | 随机种子 |
| `--exclude_cols` | | - | 排除列，逗号分隔 |
| `--n_layers` | | `3` | 隐藏层数 |
| `--layer_width` | | `128` | 首层宽度 |
| `--dropout` | | `0.3` | Dropout 率 |

## 输出格式规范

与 xgb-tuning 保持一致的逐轮诊断报告格式。

每轮调优结束后，**必须**输出以下结构化信息：

```markdown

## 注意事项

1. **数据要求**：目标变量必须为 0/1 二分类
2. **搜索加速**：搜索期间使用 `search_epochs=30`，最终模型使用 `epochs=100`
3. **收敛判定**：连续2轮提升不足 0.001 自动停止
4. **最大轮数**：默认最多 5 轮
5. **产物位置**：模型和报告保存到 `<output_dir>/models/` 和 `<output_dir>/`
