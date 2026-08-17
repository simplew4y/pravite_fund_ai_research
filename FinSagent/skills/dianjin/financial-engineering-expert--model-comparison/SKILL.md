---
name: dianjin_financial_engineering_expert_model_comparison
description: "【多模型效果对比】当用户需要\"对比算法\"、\"多模型对比\"、\"XGB和LR对比\"、\"三种算法都试试\"、\"哪个算法好\"、\"都跑一下对比看看\"、\"自动调参后对比\"、\"公平对比\"时使用。基于同一份数据切分，横向运行 XGBoost / LR评分卡 / DNN 等多种算法，补齐 Brier/BCR/真实 PSI 等多维指标，做 DeLong 显著性、样本一致性、特征重叠分析，并产出 **Pareto 前沿候选集 + 客观事实清单**（不做主观加权评分、不做门禁淘汰），最终推荐交由 LLM 基于事实与业务背景推理得出。输出多算法叠加 ROC/KS/Lift 曲线。**公平对比推荐的调用顺序**：xgb-t"
version: 0.1.0
category: dianjin_finance
---

# 多模型效果对比 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/model-comparison` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 多模型效果对比 (portable)

基于**同一份数据切分**，横向运行多种算法，统一评估并生成**客观事实报告**。

**设计原则（v3 重要变更）**：
- **只陈述事实，不做主观推荐**：删除了旧版的"五维加权综合评分"与"门禁淘汰"。主观权重本质上将多个不可比指标压成一个数，丢失信息并引入拍脑袋假设；门禁阈值则不同业务差异巨大。
- **Pareto 前沿（无主观权重）**：在 OOT AUC / OOT KS / BCR@10% / KS Gap / PSI 五个方向明确的目标上，识别未被任何算法严格优于的候选集。
- **LLM 推理接手**：报告末尾提供「已知事实清单 + 开放问题」，交由对话中的 AI 结合业务背景推理取舍。
- 同数据同切分 → 消除数据差异对对比结论的干扰
- 多维指标原始陈述 → OOT AUC/KS/BCR/Brier + KS Gap + PSI + 特征数 + 可解释性
- 统计显著性 → DeLong 检验回答"差距是真的还是采样噪声"

---

## 推荐工作流：先调参再对比

"哪个算法好"这个问题只有在**三个算法都调优后**对比才公平。默认超参下对比只能作为初筛。推荐三步调用：

```
1. xgb-tuning  → 产出 xgb_tuning_best_*_meta.json
2. lr-tuning   → 产出 lr_tuning_best_*_meta.json
3. dnn-tuning  → 产出 dnn_tuning_best_*_meta.json
4. model-comparison --use_tuned   → 自动扫描上述产物使用最优超参跑对比
```

---

## 参数说明

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` / `-d` | ✅ | - | 数据文件路径（parquet/csv） |
| `--target` / `-t` | ✅ | - | 目标变量列名（0/1 二分类） |
| `--time_col` | | `busi_dt` | 时间列（用于 OOT 切分与分月表现） |
| `--train_filter` | | 自动切分 | 训练集筛选条件 |
| `--oot_filter` | | 按时间切出 | OOT 测试集条件 |
| `--oot_ratio` | | `0.20` | OOT 占比 |
| `--val_ratio` | | `0.25` | Val 占比 |
| `--random_seed` | | `42` | 随机种子 |
| `--exclude_cols` | | - | 排除列，逗号分隔 |
| `--features` | | - | 指定特征，逗号分隔；不传则自动推断 |
| `--algorithms` | | `xgb,lr,dnn` | 对比算法列表，逗号分隔 |
| `--scenario` | | `general` | `general` / `scorecard` / `fraud` / `stability_first` |
| `--use_tuned` | flag | 关 | 自动扫描 models 目录加载最新调参最优参数 |
| `--tuned_params_file` | | - | 显式指定 `{"xgb":{},"lr":{},"dnn":{}}` JSON |

## 注意事项

1. **公平对比**："哪个算法好"只有在三个算法都调优后对比才公平
2. **同数据同切分**：本技能确保所有算法使用完全相同的数据切分
3. **DeLong 检验**：p < 0.05 才认为差距统计显著
4. **Pareto 前沿**：只识别未被任何算法严格优于的候选集，不做主观排序
5. **场景标签**：`--scenario` 仅作文本标签，不参与加权评分
6. **产物位置**：模型和报告保存到 `<output_dir>/`
