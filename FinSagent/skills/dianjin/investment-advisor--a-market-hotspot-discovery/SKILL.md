---
name: dianjin_investment_advisor_a_market_hotspot_discovery
description: "面向A股市场热点发现的综合能力。适用于用户提出“今日热点是什么”“最近哪些板块最热”“当前热股有哪些”等泛化问题时，返回结构化的Markdown热点报告。覆盖热点资讯、热门板块、热门股票等维度。触发核心条件：用户关注市场层面的热门方向或事件热度，而非单一标的的深度诊断或指标计算。数据查询请使用 上游外部金融数据服务 服务。"
version: 0.1.0
category: dianjin_finance
---

# A股市场热点发现技能

> Adapted from `DianJin-SKILLS/investment-advisor/a-market-hotspot-discovery` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# A股市场热点发现技能

## 概述
本技能专注于**A股市场盘面热点与资金情绪监测**。当用户询问市场整体热门方向、资金聚集地、突发题材或个股异动时，通过整合板块涨幅、资金流向、龙虎榜数据及全网舆情，输出结构化的《A股市场热点监测报告》。

## 核心触发条件
- 用户询问“今日市场热点”、“今天什么板块涨得好”、“最近炒什么概念”。
- 用户关注“资金在买什么”、“龙虎榜有哪些大佬进场”、“今日热门股”。
- 用户需要了解“盘面情绪”、“题材轮动”、“政策/事件驱动方向”。

## 数据工具集 (上游外部金融数据服务)

| 工具名称 | 核心作用 | 关键参数 |
|----------|----------|----------|
| `SectorRank` | **板块热度排序** | 获取行业/概念/地域板块列表，按涨跌幅、换手率等排序 |
| `SectorFundFlowRank` | **板块资金流向** | 按主力资金流向对板块进行排序，识别资金主攻方向 |
| `DailyStockHeroDetails` | **龙虎榜/热门股** | 获取当日龙虎榜上榜个股明细、异动原因及主力买卖额 |
| `NewsInfoList` / `MarketNewslist` | **热点舆情资讯** | 检索全网/市场最新舆情，捕捉政策、事件、行业利好 |

## 工作流程

1.  **意图解析**：识别用户关注的热点维度（板块、个股、资金、资讯）。
2.  **并行查询**：
    *   **板块热度**：调用 `SectorRank`，查询“今日涨幅靠前的概念和行业板块”。
    *   **资金主攻**：调用 `SectorFundFlowRank`，查询“今日主力资金净流入排名靠前的板块”。
    *   **个股异动**：调用 `DailyStockHeroDetails`，查询“今日龙虎榜上榜股票及原因”。
    *   **舆情驱动**：调用 `NewsInfoList`，查询“今日A股市场热点资讯或重大新闻”。
3.  **交叉验证**：将资讯驱动的题材与板块涨幅、资金流向进行匹配，找出逻辑自洽的“真热点”。
4.  **报告生成**：按照标准模板输出 Markdown 报告。

## 报告输出模板

```markdown
# 🔥 A股市场热点监测报告

## 📅 报告日期：[YYYY-MM-DD]

### 📊 一、 今日热门板块/概念
| 排名 | 板块名称 | 涨跌幅(%) | 换手率(%) | 领涨股 | 热度点评 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | [概念/行业] | +X.XX | X.XX | [股票名称] | [驱动逻辑简述] |
| 2 | ... | ... | ... | ... | ... |
| 3 | ... | ... | ... | ... | ... |

### 💰 二、 资金主攻方向

## 工作流程

1.  **意图解析**：识别用户关注的热点维度（板块、个股、资金、资讯）。
2.  **并行查询**：
    *   **板块热度**：调用 `SectorRank`，查询“今日涨幅靠前的概念和行业板块”。
    *   **资金主攻**：调用 `SectorFundFlowRank`，查询“今日主力资金净流入排名靠前的板块”。
    *   **个股异动**：调用 `DailyStockHeroDetails`，查询“今日龙虎榜上榜股票及原因”。
    *   **舆情驱动**：调用 `NewsInfoList`，查询“今日A股市场热点资讯或重大新闻”。
3.  **交叉验证**：将资讯驱动的题材与板块涨幅、资金流向进行匹配，找出逻辑自洽的“真热点”。
4.  **报告生成**：按照标准模板输出 Markdown 报告。

## 报告输出模板

```markdown

## 注意事项
- 热点具有时效性，所有数据必须基于**最新交易日**。
- 在分析驱动逻辑时，务必将**资讯面**与**盘面表现**结合，避免单纯罗列数据。
- 对于没有明确利好支撑的纯资金博弈热点，应在报告中提示“纯情绪炒作风险”。
