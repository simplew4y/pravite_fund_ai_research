---
name: dianjin_financial_engineering_expert_xgb_modeling
description: "【XGBoost建模】当用户需要\"训练模型\"、\"跑一个基线\"、\"建个模型试试\"、\"对比特征方案效果\"、\"预测一下\"、\"跑个xgb\"、\"看AUC/KS/BCR\"时使用。支持多特征方案对比、AUC/KS/BCR/Brier评估、Bootstrap置信区间、概率校准曲线、稳定性分析（Mann-Kendall趋势检验）。前提条件：需要已完成特征分析并确定特征方案。**不做超参数调优，调参请用 xgb-tuning**；不做特征工程。与 auto-experiment 的区别：本 Skill 按用户指定方案训练，auto-experiment 自主探索特征组合。"
version: 0.1.0
category: dianjin_finance
---

# XGBoost 建模 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/xgb-modeling` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# XGBoost 建模 (portable)

基于 XGBoost 进行二分类建模，支持自动特征筛选、多方案对比、稳定性分析。可运行在任何 Python 环境，无平台耦合。调参请用 [`xgb-tuning`](./xgb-tuning/SKILL.md)。

**核心流程**：数据加载 → 特征筛选（四大算子）→ 多方案对比 → 最优方案训练 → 三段式评估 → 稳定性分析 → 报告生成

## 参数

> 通用参数 spec 定义在 `_vendor/xgb_cli.py`（domain=`modeling`）。

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` / `-d` | ✅ | - | 数据文件路径（parquet/csv） |
| `--target` / `-t` | ✅ | - | 目标变量列名（0/1 二分类） |
| `--time_col` | | `busi_dt` | 时间列名 |
| `--train_filter` | | 自动切分 | 训练集筛选条件（pandas query） |
| `--val_filter` | | `val_ratio` 切出 | 验证集筛选条件 |
| `--oot_filter` | | 按时间切出 | OOT 跨时间测试集条件 |
| `--oot_ratio` | | `0.20` | 未传 `--oot_filter` 时按时间切 OOT 的比例 |
| `--val_ratio` | | `0.25` | 未传 `--val_filter` 时从 train_full 切 val 的比例 |
| `--random_seed` | | `42` | 随机种子 |
| `--exclude_cols` | | - | 排除列，逗号分隔 |
| `--features` | | - | 指定单套特征，逗号分隔 |
| `--feature_sets` | | - | JSON 多方案；**复杂嵌套优先放到 `--config` 的 `feature_sets` 字段** |
| `--feature_scheme` | | - | 指定单套自动筛选方案：`full`/`decorr`/`high_iv`/`stable`；不传或传空则走 `--auto_select` 全量对比 |
| `--auto_select` | | `true` | 自动特征筛选（四大算子全量对比；指定 `--feature_scheme` 时忽略本参数） |
| `--baseline_filter` | | 同 train | PSI 基准条件 |
| `--comparison_filter` | | 同 oot | PSI 对比条件 |
| `--sample_strategy` | | `auto_weight` | `auto_weight` / `undersample` / `none` |
| `--model_name` | | 自动生成 | 模型名称（不含扩展名） |
| `--report_output` | | `xgb_modeling_report` | 报告基名 |
| `--output_dir` | | `./outputs/<ts>` | **portable 独有**：产物输出目录 |
| `--config` | | - | JSON 配置文件路径（命令行 > config > 默认） |

> **复杂嵌套参数（如 `feature_sets`）不要用命令行拼转义 JSON**，改走 `--config config.json` 结构化通道。

---

## 执行方式

```bash
python scripts/modeling.py \
  --data_path ./examples/toy.parquet \
  --target y_label \
  --time_col busi_dt \

## 报告结构

| 章节 | 内容 |
|------|------|
| 执行摘要 | 4 行业务结论：最优方案、Gap 状态、PSI 状态、头部特征风险 |
| 1. 数据概览 | 样本量、正样本率（Train/Test/OOT） |
| 2. 特征方案对比 | 各方案 AUC/KS/Gap 横向对比 |
| 3. 最优方案详情 | AUC/KS/Gini 指标、模型分数 IV 最优分箱、Lift 表、特征重要性、BCR @ Top5/10/20/30%、Brier Score + 校准曲线 |
| 4. 稳定性分析 | 按月 AUC/KS（含 95% Bootstrap 置信区间）、Mann-Kendall 趋势检验、分数 PSI |
| 5. 最终模型总结 | 特征列表、综合表现 |

---

## 注意事项

1. **目标变量**：必须为 0/1 二分类
2. **时间切分**：建议按时间切分，确保 OOT 为未来数据
3. **自动特征筛选**：需要数据同时满足 IV、PSI、缺失率条件
4. **样本策略**：强不均衡场景（正样本率 < 2%）建议 `--sample_strategy undersample`，一般场景用默认 `auto_weight`
5. **不提供调参**：需要调参请切 xgb-tuning（基于 Optuna TPE + 诊断驱动的约束搜索）
6. **模型保存**：每次训练自动保存最优模型至 `<output_dir>/models/`，无需传 `--save_model`；可用 `--model_name` 自定义文件名
7. **稳定性分析**：基准月份取自训练集时间段；Bootstrap CI 需样本量 >= 100 才计算
8. **BCR/校准曲线**：BCR（Bad Capture Rate）反映拒绝 Top K% 人群能捕获多少坏客户；校准曲线反映模型概率输出可信度
