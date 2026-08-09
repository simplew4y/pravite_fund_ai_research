---
name: dianjin_investment_advisor_stock_tech_analysis
description: "股票深度技术分析技能。专业诊断趋势、量价、支撑压力、技术指标四大核心维度，结合个股市值规模（盘子大小）与行业属性，客观判断股价走势强弱与关键交易区间。当用户需要深度技术面诊断、寻找买卖点参考、分析趋势强度时使用。"
version: 0.1.0
category: dianjin_finance
---

# 股票深度技术分析技能

> Adapted from `DianJin-SKILLS/investment-advisor/stock-tech-analysis` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 股票深度技术分析技能

## 概述
本技能专注于**股票技术面的深度诊断**，超越基础的行情播报，提供基于多维度的逻辑研判。通过综合分析趋势结构、量价配合、关键位及技术指标，并结合**流通盘大小**和**行业特征**进行修正，为用户提供客观的走势强弱评估和关键交易区间参考。

## 数据工具集 (上游外部金融数据服务)

| 工具名称 | 核心作用 | 关键参数 |
|----------|----------|----------|
| `AShareLiveQuote` | **实时行情与市值** | 获取现价、换手率、量比、总市值、流通市值（判断盘子大小） |
| `StockQuoteTechIndex` | **技术指标全览** | 获取 MA、MACD、KDJ、RSI、BOLL 指标及支撑/压力位数值 |
| `StockRangeQuotation` | **区间统计** | 计算近期高低点、振幅、成交额，辅助判断支撑压力 |
| `StockMultiPeriodQuote` | **多周期共振** | 日/周/月线趋势对比，判断大级别方向 |

## 核心分析维度

### 1. 趋势诊断 (Trend Diagnosis)
*   **均线系统**：
    *   **多头/空头排列**：MA5>MA10>MA20 为多头强势；反之为空头。
    *   **趋势斜率**：均线向上发散角度越大，趋势越强。
*   **高低点结构**：
    *   **上升通道**：低点不断抬高，高点不断刷新。
    *   **下降通道**：高点不断降低，低点不断击穿。
    *   **多周期共振**：日线趋势需服从周线趋势。若日线反弹但周线空头，则视为“反弹”而非“反转”。

### 2. 量价分析 (Volume-Price Analysis)
*   **量价配合逻辑**：
    *   **量增价升**：健康上涨，资金认可度高。
    *   **缩量上涨**：动能减弱，需警惕诱多（除非是高度控盘的大盘股）。
    *   **放量下跌**：恐慌盘涌出，趋势可能恶化。
    *   **地量地价**：极度缩量往往对应阶段性底部。
*   **换手率解读 (结合盘子大小)**：
    *   **大盘股 (>1000亿)**：换手率 >3% 即为活跃，>5% 为极度活跃。
    *   **中小盘股 (<200亿)**：换手率 >7% 为活跃，>15% 为游资接力特征。

### 3. 支撑与压力 (Support & Resistance)
*   **动态支撑/压力**：
    *   **均线支撑**：MA20 (生命线)、MA60 (决策线) 是关键防守位。
    *   **布林线轨道**：上轨为压力，下轨为支撑，中轨为强弱分界。
*   **静态支撑/压力**：
    *   **前期高低点**：区间最高价/最低价。
    *   **筹码密集区**：前期成交密集区域（通过区间成交额估算）。
*   **支撑压力转换**：突破压力位后，压力变支撑；跌破支撑位后，支撑变压力。

### 4. 技术指标研判 (Indicators)

## 工作流程

1.  **获取基础数据**：查询 `AShareLiveQuote` 获取市值、现价、换手率。
2.  **获取技术指标**：查询 `StockQuoteTechIndex` 获取 MA, MACD, KDJ, BOLL 及支撑压力数值。
3.  **获取区间数据**：查询 `StockRangeQuotation` (近 20 日/60 日) 确认高低点和趋势。
4.  **综合诊断**：
    *   判断趋势方向（多/空/震荡）。
    *   评估量价健康度。
    *   确认当前股价在支撑压力网中的位置。
    *   结合市值特征给出差异化解读。
5.  **生成报告**：输出结构化的诊断结果。

## 报告输出模板

```markdown
