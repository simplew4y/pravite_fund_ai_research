---
name: dianjin_financial_engineering_expert_dnn_modeling
description: "【DNN深度学习建模】当用户需要\"深度学习\"、\"DNN建模\"、\"神经网络\"、\"MLP\"、\"跑个DNN\"、\"深度模型\"时使用。基于 PyTorch 实现多层全连接网络（MLP）进行二分类建模。支持 BatchNorm、Dropout、学习率调度、早停。复用平台已有的三段式数据切分、AUC/KS/BCR评估体系、稳定性分析。前提条件：需要已有数据集。与 xgb-modeling 的区别：本 Skill 使用深度神经网络，适合高维特征交互场景；xgb-modeling 使用 XGBoost 树模型。"
version: 0.1.0
category: dianjin_finance
---

# DNN 深度学习建模 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/dnn-modeling` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# DNN 深度学习建模 (portable)

基于 PyTorch 实现 MLP (Multi-Layer Perceptron) 进行二分类建模。

**核心流程**：特征标准化 → MLP 训练（BatchNorm + Dropout + Early Stopping） → 概率预测 → 三段式评估

**适用场景**：
- 高维特征交互建模
- 特征间存在复杂非线性关系
- 数据量充足（>10k 样本）
- 对模型性能有极致追求（可与 XGBoost 做 ensemble）

---

## 参数说明

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` / `-d` | ✅ | - | 数据文件路径（parquet/csv） |
| `--target` / `-t` | ✅ | - | 目标变量列名（0/1 二分类） |
| `--time_col` | | `busi_dt` | 时间列名 |
| `--train_filter` | | 自动切分 | 训练集筛选条件（pandas query） |
| `--oot_filter` | | 按时间切出 | OOT 跨时间测试集条件 |
| `--oot_ratio` | | `0.20` | 未传 `--oot_filter` 时按时间切 OOT 的比例 |
| `--val_ratio` | | `0.25` | 从 train_full 切 val 的比例 |
| `--random_seed` | | `42` | 随机种子 |
| `--exclude_cols` | | - | 排除列，逗号分隔 |
| `--features` | | - | 指定特征列表，逗号分隔；不传则自动推断 |
| `--hidden_dims` | | `128,64,32` | 隐藏层维度，逗号分隔 |
| `--dropout` | | `0.3` | Dropout 比率 |
| `--learning_rate` | | `0.001` | 学习率 |
| `--batch_size` | | `512` | 批次大小 |
| `--epochs` | | `100` | 最大训练轮次 |
| `--patience` | | `10` | 早停耐心轮数 |
| `--weight_decay` | | `1e-4` | 权重衰减（L2 正则化） |
| `--pos_weight` | | `auto` | 正样本权重（auto=自动计算） |
| `--model_name` | | 自动生成 | 模型名称 |
| `--report_output` | | 自动生成 | 报告输出路径 |
| `--output_dir` | | `./outputs/<ts>` | 产物输出目录 |
| `--config` | | - | JSON 配置文件路径 |

---

## 执行方式

## 注意事项

1. **数据要求**：目标变量必须为 0/1 二分类
2. **数据量**：建议训练样本 > 10k，DNN 在小样本上易过拟合
3. **缺失值**：脚本自动使用中位数填充 + 添加缺失指示列
4. **标准化**：自动对数值特征做 StandardScaler 标准化
5. **早停**：当 val loss 连续 `patience` 轮不下降时自动停止
6. **不提供调参**：需要调参请切 `dnn-tuning`（搜索网络架构 + 训练参数）
7. **GPU**：自动检测 CUDA，无 GPU 时回退到 CPU
8. **模型保存**：模型文件保存到 `<output_dir>/models/`
