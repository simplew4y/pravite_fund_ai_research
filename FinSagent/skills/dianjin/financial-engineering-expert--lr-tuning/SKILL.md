---
name: dianjin_financial_engineering_expert_lr_tuning
description: "【LR评分卡调参】当用户说\"LR调参\"、\"评分卡调优\"、\"调整分箱数\"、\"调整C值\"、\"LR过拟合\"时使用。基于 Optuna TPE 贝叶斯优化，联合搜索 WoE 分箱参数（max_n_bins、iv_threshold）和 LR 模型参数（C、regularization），诊断驱动约束搜索空间。前置条件：需先用 lr-modeling 训练出基线模型。"
version: 0.1.0
category: dianjin_finance
---

# LR 评分卡参数调优 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/lr-tuning` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# LR 评分卡参数调优 (portable)

LR 评分卡调参的**唯一入口**，基于 `_vendor/tuning/lr_engine.LRTuningEngine`。

核心设计：WoE 分箱参数与 LR 正则化参数**联合搜索**，确保最优组合。

---

## 调优流程

```
基线 LR 模型 → 诊断分析(过拟合/欠拟合) → 约束空间构造 → Optuna 搜索 → 最优参数 → 迭代
```

---

## 执行模式

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| **交互式**（默认） | 用户说"调参"/"帮我调一下LR" | 每轮暂停等待用户反馈 |
| **AUTO** | 用户说"自动调优"/"帮我调到最优" | Agent 自动迭代直到收敛 |

---

## 参数说明

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` / `-d` | ✅ | - | 数据文件路径 |
| `--target` / `-t` | ✅ | - | 目标变量列名 |
| `--features` | | 自动推断 | 特征列表，逗号分隔 |
| `--time_col` | | `busi_dt` | 时间列名 |
| `--train_filter` | | 自动切分 | 训练集筛选条件 |
| `--val_filter` | | `val_ratio` 切出 | 验证集筛选条件 |
| `--oot_filter` | | 按时间切出 | OOT 条件 |
| `--oot_ratio` | | `0.20` | OOT 占比 |
| `--val_ratio` | | `0.25` | Val 占比 |
| `--random_seed` | | `42` | 随机种子 |
| `--exclude_cols` | | - | 排除列 |
| `--max_n_bins` | | `8` | 当前 WoE 分箱数 |
| `--iv_threshold` | | `0.02` | 当前 IV 阈值 |
| `--C` | | `1.0` | 当前正则化强度倒数 |
| `--regularization` | | `l2` | 正则化类型 |
| `--round` / `-r` | | `0` | 当前轮次 |

## 输出格式规范

每轮调优结束后，**必须**输出以下结构化信息：

```markdown

## 注意事项

1. **数据要求**：目标变量必须为 0/1 二分类
2. **联合搜索**：WoE 分箱与 LR 参数联合优化，确保最优组合
3. **收敛判定**：连续2轮提升不足 0.001 自动停止
4. **最大轮数**：默认最多 5 轮
5. **产物位置**：模型和报告保存到 `<output_dir>/models/` 和 `<output_dir>/`
