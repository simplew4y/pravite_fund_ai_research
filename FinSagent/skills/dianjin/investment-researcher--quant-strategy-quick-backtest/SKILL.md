---
name: dianjin_investment_researcher_quant_strategy_quick_backtest
description: "证券金融工程研究员轻量化策略速回测技能。当用户要求进行策略回测、量化策略测试、简易策略验证、快速计算年化收益/最大回撤/夏普比率、策略过拟合检测时使用。包括\"回测一下这个策略\"、\"测试均线交叉策略\"、\"策略速评\"、\"快速回测\"、\"算一下策略收益\"、\"策略有效性验证\"、\"帮我回测下\"、\"看看这个策略怎么样\"、\"策略表现如何\"、\"量化回测\"、\"策略回测报告\"等表述。即使用户只说\"回测\"、\"测试策略\"、\"算下收益\"等简短表述也要触发。本技能自动解析策略规则、获取行情数据或模拟数据、执行回测计算、输出核心绩效指标，并附带过拟合风险提示，生成标准化Markdown格式回测报告。"
version: 0.1.0
category: dianjin_finance
---

# 量化策略速回测技能 (Quant Strategy Quick Backtest)

> Adapted from `DianJin-SKILLS/investment-researcher/quant-strategy-quick-backtest` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 量化策略速回测技能 (Quant Strategy Quick Backtest)

## 技能定位

为金融工程研究员提供**轻量化、快速响应**的策略回测能力，支持简易策略规则的解析与验证，快速输出核心绩效指标，并系统性提示过拟合风险。

> **适用场景**：策略灵感快速验证、晨会策略速评、投研交流中的即时测算、策略框架初步筛选。
> **不适用场景**：高频策略回测、复杂多因子模型、需要精细交易成本模拟的实盘级回测。

## 数据采集指引 (上游外部金融数据服务 工具映射)

**所有行情数据必须通过 `上游外部金融数据服务` 服务获取**，具体工具调用如下：

### 1. 指数行情数据 (作为基准或标的)
```
上游工具命令 上游外部金融数据服务 IndexDailyQuote --body '{"query": "查询沪深300指数过去3年的每日收盘价、涨跌幅、成交量"}'
```
*   **用途**：获取宽基指数（如沪深300、中证500、创业板指）的历史日线行情，用于计算基准收益或作为 ETF 轮动策略的标的。

### 2. 个股行情数据 (作为策略标的)
```
上游工具命令 上游外部金融数据服务 StockDailyQuote --body '{"query": "查询贵州茅台过去3年的每日收盘价、开盘价、最高价、最低价、成交量"}'
```
*   **用途**：获取个股历史日线行情，用于单标的策略回测或构建股票池。

### 3. 财务/估值数据 (用于基本面策略)
```
上游工具命令 上游外部金融数据服务 StockValueAnalysis --body '{"query": "查询全市场A股最新PE(TTM)、PB(LF)"}'
```
*   **用途**：获取截面估值数据，辅助构建价值选股策略。

## 执行流程

### 第一步：解析策略规则

从用户输入中提取以下关键信息：

| 要素 | 说明 | 示例 |
|------|------|------|
| **策略类型** | 均线/动量/反转/突破/轮动/自定义 | 双均线交叉 |
| **标的范围** | 个股/指数/ETF/行业/自定义池 | 沪深300成分股 |
| **入场条件** | 触发买入的信号规则 | MA5上穿MA20 |
| **出场条件** | 触发卖出的信号规则 | MA5下穿MA20 / 止损8% |
| **持仓权重** | 等权/市值加权/自定义 | 等权配置 |
| **调仓频率** | 每日/每周/每月/信号驱动 | 信号驱动 |

## 执行流程

## 注意事项

1.  **数据源优先**：优先使用 `上游外部金融数据服务` 获取行情数据，确保数据质量和一致性。
2.  **参数稳健性**：建议在报告中展示参数敏感性分析（如参数 ±20% 的表现变化）。
3.  **基准选择**：基准应与策略风险特征匹配，股票策略用沪深300，债券策略用中债综合。
4.  **报告透明度**：若使用模拟数据，必须在报告开头显著位置标注。
5.  **迭代建议**：速回测仅用于初步筛选，有潜力的策略应进入深度回测流程。
