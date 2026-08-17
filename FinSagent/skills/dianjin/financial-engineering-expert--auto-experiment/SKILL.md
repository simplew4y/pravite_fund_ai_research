---
name: dianjin_financial_engineering_expert_auto_experiment
description: "【自主实验循环·特征组级探索】当用户说\"自动探索哪些特征组有用\"、\"批量对比不同特征组贡献\"、\"帮我自主试多种方案\"、\"自动跑一下\"、\"试各种特征组合\"、\"自动特征选择\"、\"消融分析\"时使用。核心能力：自动发现数据中的特征分组，按组执行 独立评估→增量叠加→消融分析→精细筛选 四阶段渐进探索。不做超参数调优，不做单次固定方案训练。与 xgb-tuning 的区别：本 Skill 负责\"自主探索特征和方案\"，xgb-tuning 负责\"调整模型超参数\"。与 xgb-modeling 的区别：本 Skill 自主多轮探索，xgb-modeling 按指定方案单次训练。"
version: 0.1.0
category: dianjin_finance
---

# 自主实验循环 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/auto-experiment` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 自主实验循环 (portable)

自动发现数据中的特征分组，执行四阶段渐进式探索实验，每轮完整展示探索逻辑和量化结果。

---

## 核心理念

借鉴 autoresearch 的自主循环思想，升级为**组级探索**：

```
发现特征组 → 组独立评估 → 组间叠加 → 组级消融 → 精细筛选
```

---

## 四阶段探索流程

### Phase 1: 特征组独立评估
- 自动发现数据中的特征分组（按前缀聚合: `firefly_*`, `mob3_*`, `umeng_*` 等）
- 逐组单独建模，评估每组的独立预测能力
- 输出各组的独立 AUC/KS 排名

### Phase 2: 组间增量叠加
- 从 Phase 1 表现最佳的组开始
- 逐步叠加下一个最强组，观察边际增量
- 找到最优组合点

### Phase 3: 组级消融分析
- 从全量特征出发，逐组移除
- 量化每个组的不可替代性
- 如果移除后指标不降，说明该组信息已被其他组覆盖

### Phase 4: 组内精细筛选
- 在最优组合内，逐个尝试移除特征
- 剔除冗余特征，精简模型

---

## 参数说明

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` | ✅ | - | 数据文件路径（parquet/csv） |
| `--target` | ✅ | - | 目标变量列名（0/1 二分类） |

### 单轮输出格式（每轮必须使用）

```markdown

## 注意事项

1. **探索方向**：可以是宽泛的（如"探索各特征组贡献"），系统会自动发现分组
2. **轮数建议**：设置为特征组数的2-3倍（如6个组建议10-15轮），以覆盖多个探索阶段
3. **基线策略**：默认使用全量特征作为基线，也可指定特定特征集
4. **显著性阈值**：默认2.0×，数据量小时可适当降低
5. **可打断**：用户可随时停止，已有结果会保留
6. **产物位置**：报告和模型保存到 `<output_dir>/`
