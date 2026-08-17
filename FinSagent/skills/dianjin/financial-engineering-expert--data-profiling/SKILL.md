---
name: dianjin_financial_engineering_expert_data_profiling
description: "【数据轮廓速览】当用户刚上传数据、问\"数据有多少行\"、\"有哪些字段\"、\"数据长什么样\"时使用。描述数据结构（行列数、字段类型、缺失率、分布特征、数据质量），不计算建模指标。无需目标变量。与 feature-analysis 的区别：只做\"描述\"不做\"分析\"，不计算IV/PSI/相关性等建模指标。"
version: 0.1.0
category: dianjin_finance
---

# 数据洞察报告 (portable)

> Adapted from `DianJin-SKILLS/financial-engineering-expert/data-profiling` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 数据洞察报告 (portable)

基于 `scripts/profiler.py` 主脚本，对数据集进行轮廓扫描，生成数据概况报告。

---

## 参数说明

| 参数 | 必选 | 默认值 | 说明 |
|------|:----:|--------|------|
| `--data_path` | ✅ | - | 数据文件路径（parquet/csv） |
| `--output` | | `data_profiling_report.md` | 报告输出路径 |
| `--output_dir` | | `./outputs/<ts>` | 产物输出目录 |
| `--output_name` | | `data_profiling_report` | 报告基名（不含扩展名） |
| `--config` | | - | JSON 配置文件路径 |

---

## 执行方式

```bash
python scripts/profiler.py \
  --data_path ./examples/toy.parquet \
  --output_dir ./outputs/profile_run
```

执行结束后：
- 产物目录 `<output_dir>/` 下生成：
  - `report.md` — 数据概况报告
  - `result.json` — 结构化产物清单（见 PROTOCOL.md）
- stdout 末行打印 `result.json` 绝对路径，Agent 读这个文件即可

---

## 产物示例

```json
{
  "skill": "data-profiling",
  "status": "success",
  "files": [
    {"path": ".../report.md", "role": "report"}
  ],
  "metrics": {"n_rows": 10000, "n_cols": 28, "n_missing_cols": 5},
  "summary": "中等规模数据集（10,000行），28 个字段，数值型为主，发现 2 个高缺失字段"

## 注意事项

1. **无需目标变量**：本 Skill 不需要提供目标变量，纯数据描述
2. **快速轻量**：执行速度快，适合大数据集的快速扫描
3. **自动类型推断**：识别数值型、类别型、布尔型、时间型、文本型字段
