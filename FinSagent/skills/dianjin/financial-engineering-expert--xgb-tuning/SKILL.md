---
name: dianjin_financial_engineering_expert_xgb_tuning
description: "【XGBoost超参数调优 — 唯一调参入口】当用户说\"帮我调参\"、\"模型过拟合了怎么办\"、\"调整learning_rate/max_depth等参数\"时使用。核心能力：基于 Optuna TPE 贝叶斯优化 + 诊断驱动的约束搜索（过拟合→收紧树深度上限，欠拟合→抬高树深度下限），每轮输出诊断报告供用户确认。不做特征探索/特征工程，不批量跑多种方案对比。前置条件：需先用 xgb-modeling 训练出基线模型。与 auto-experiment 的区别：本Skill只调整\"模型超参数\"，auto-experiment 负责\"自主探索特征和方案\"。"
version: 0.1.0
category: dianjin_finance
---

# XGBoost 参数调优 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/xgb-tuning` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# XGBoost 参数调优 (portable)

XGBoost 调参的**唯一入口**，基于 `_vendor/tuning_engine.TuningEngine`。核心设计：

1. **基线参数智能推断** — 根据数据特征推荐合理起点
2. **模型状态诊断** — 过拟合/欠拟合判定（`diagnose_model`）
3. **约束式贝叶斯搜索** — 诊断结论定向收缩 Optuna 搜索空间
4. **用户知识融合** — 接受用户领域经验调整策略

---

## 调优流程

```
用户需求 → 数据特征分析 → LLM 推断基线参数 → 训练评估 → 诊断分析 → 参数调整 → 迭代直到满意
                                         ↑                                        ↓
                                         └───────────── 用户反馈/知识输入 ─────────────┘
```

---

## 执行模式

| 模式 | 触发条件 | 行为 |
|------|---------|------|
| **交互式**（默认） | 用户说"调参"/"帮我调一下"/"优化一下" | 每轮暂停等待用户反馈 |
| **AUTO** | 用户说"自动调优"/"帮我调到最优"/"一直调到收敛" | Agent 自动迭代直到收敛，每轮输出进度 |

**默认模式**: 交互式（更安全，用户可控）

### 交互式模式行为规范

1. **单轮调优后必须暂停**，输出结构化诊断报告，等待用户反馈
2. 用户可能的反馈：
   - "继续" / "再调一轮" → 执行下一轮
   - "Gap 还是大" / "再保守点" → 调整策略后执行
   - "可以了" / "停" → 生成最终报告
3. **禁止**在交互式模式下连续执行多轮调优

### AUTO 模式行为规范

1. 每轮调优后同样输出完整的结构化诊断报告（格式同交互式模式），然后自动进入下一轮
2. 收敛条件：Gap < 0.03 或 连续2轮提升 < 0.002
3. 收敛后自动生成最终报告

## 输出格式规范

> **核心原则：每轮必须完整输出**
> 禁止只输出最终调参报告。每一轮调参完成后，不论交互式还是 AUTO 模式，**必须**立即输出该轮的完整诊断分析过程和结果，包括：参数变化及调整理由、训练指标详情、与上一轮的对比、诊断结论、下一步建议。用户需要看到每一轮的诊断推理过程，而非仅看到最终参数。

## 注意事项

1. **数据要求**：目标变量必须为 0/1 二分类
2. **特征要求**：需提供已筛选的特征列表（`--features` 必填）
3. **基线参数**：可传入自定义基线参数，否则使用默认值
4. **收敛判定**：连续2轮提升不足 0.001 自动停止
5. **最大轮数**：默认最多 5 轮，避免过度调优
6. **复杂 JSON**：`--params` / `--baseline` 等复杂 JSON 优先通过 `--config config.json` 传入
7. **产物位置**：模型和报告保存到 `<output_dir>/models/` 和 `<output_dir>/`
