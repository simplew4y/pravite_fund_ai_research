---
name: dianjin_investment_researcher_quant_factor_tracker
description: "证券金融工程研究员因子跟踪与评估技能。当用户要求跟踪量化因子表现、更新因子库、计算因子IC/IR、分析分组超额收益、评估因子有效性、监控因子衰减或生成因子跟踪报告时触发。包括“因子跟踪”、“计算因子IC”、“因子失效分析”、“生成因子评估报告”、“因子库更新”、“看看这些因子最近表现怎么样”、“跑一下IC和分组收益”等表述。本技能自动获取或接收因子截面数据与下期收益率，计算Rank IC、IR、分组超额收益，执行单调性与衰减检验，标记因子强弱状态与失效预警，输出标准化Markdown格式因子跟踪报告。"
version: 0.1.0
category: dianjin_finance
---

# 量化因子跟踪与评估 (Quant Factor Tracker)

> Adapted from `DianJin-SKILLS/investment-researcher/quant-factor-tracker` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 量化因子跟踪与评估 (Quant Factor Tracker)

## 概述

本技能专为**证券金融工程研究员**设计，旨在提供系统化的**量化因子跟踪与有效性评估**。通过自动获取或接收截面数据，计算因子 IC/IR、分组超额收益，执行单调性与衰减检验，标记因子强弱状态与失效预警，生成标准化的 Markdown 格式因子跟踪报告，辅助多因子模型构建与策略迭代。

**所有数据查询必须使用 `上游外部金融数据服务` 服务**。

## 核心分析框架

### 1. 因子有效性评估 (Factor Effectiveness)
*   **Rank IC (Information Coefficient)**: 因子值与下期收益率的秩相关系数。
    *   **IC Mean**: 衡量因子预测能力的强弱。通常 |IC| > 0.03 为有效。
    *   **ICIR (IC / std(IC))**: 衡量因子预测能力的稳定性。通常 ICIR > 0.5 为优秀。
    *   **IC 胜率**: IC > 0 的期数占比。
*   **分组收益 (Grouped Returns)**:
    *   将股票按因子值分为 5 组或 10 组。
    *   **多空收益 (Long-Short Return)**: 第 1 组 (最高) - 第 5 组 (最低) 的收益差。
    *   **单调性**: 各组收益率是否严格单调递增/递减。

### 2. 因子衰减与换手 (Decay & Turnover)
*   **IC 衰减**: 计算因子值与 T+1, T+2, ... T+N 期收益率的 IC，观察预测能力随时间的衰减速度。
*   **因子换手率**: 因子值排名的变动幅度，评估交易成本对因子收益的侵蚀。

### 3. 因子状态监控 (Status Monitoring)
*   **🟢 强势因子**: ICIR > 0.5，多空收益显著，单调性好。
*   **🟡 震荡/观察**: IC 均值尚可但波动大，或多空收益不稳定。
*   **🔴 失效/预警**: IC 均值接近 0，ICIR < 0.2，或出现反向信号 (IC 持续为负)。

## 数据采集指引 (上游外部金融数据服务 工具映射)

**所有数据必须通过 `上游外部金融数据服务` 服务获取**，具体工具调用如下：

### 1. 因子截面数据获取
根据因子类型，调用相应工具获取全市场或指定股票池的截面数据：

*   **价值因子 (Value)**: PE(TTM), PB(LF), PS(TTM), 股息率。
    ```
    上游工具命令 上游外部金融数据服务 StockValueAnalysis --body '{"query": "查询沪深300成分股最新PE、PB、PS、股息率"}'
    ```
*   **成长/质量因子 (Growth/Quality)**: ROE, 净利润增长率, 营收增长率, 毛利率。
    ```
    上游工具命令 上游外部金融数据服务 FinancialAnalysis --body '{"query": "查询全市场A股最新ROE、净利润同比增长率、毛利率"}'
    ```
*   **动量/反转因子 (Momentum/Reversal)**: 过去 N 日涨跌幅、波动率。

## 执行流程

1.  **数据采集**:
    *   使用 `上游外部金融数据服务` 获取指定股票池的因子截面数据 (Factor Exposure)。
    *   获取该截面日期后的下期收益率 (Return)。
2.  **因子计算**:
    *   **数据清洗**: 剔除 ST、停牌、新股、金融股（视策略而定）。
    *   **去极值与标准化**: 对因子进行 MAD 去极值和 Z-Score 标准化。
    *   **行业市值中性化** (可选): 剔除行业和市值因子的影响。
3.  **绩效评估**:
    *   计算 **Rank IC** 序列。
    *   计算 **分组收益** (Top/Bottom 组收益及多空收益)。
    *   执行 **单调性检验** (Spearman 相关系数)。
4.  **报告生成**:
    *   生成 Markdown 格式的因子跟踪与评估报告。

## 注意事项

*   **数据源唯一性**: 所有因子数据、收益率数据必须通过 `上游外部金融数据服务` 服务获取。
*   **中性化处理**: 在评估单一因子时，务必考虑行业和市值的影响，建议进行中性化处理以提取纯 Alpha。
*   **样本外测试**: 因子评估应包含样本内和样本外测试，避免过拟合。
*   **动态跟踪**: 因子有效性会随市场周期变化，需定期（周/月）更新跟踪报告。
