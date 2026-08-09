---
name: dianjin_investment_researcher_alternative_factor_mining
description: "Adapted Qwen DianJin workflow for alternative factor mining."
version: 0.1.0
category: dianjin_finance
---

# 另类因子挖掘技能

> Adapted from `DianJin-SKILLS/investment-researcher/alternative-factor-mining` at `fd9b51167d65`. The exact upstream text is retained in `references/UPSTREAM_SKILL.md` for review.

## FinSagent execution boundary

- Treat this package as an analysis workflow, not as authorization to call tools.
- Use only evidence already returned by the active dataset's Evidence Fusion pipeline.
- Never broaden company or document scope and never mix another company's evidence.
- Upstream tool names, shell commands, web search, databases, and message actions are unavailable unless the FinSagent runtime explicitly supplies an audited adapter.
- Preserve metric qualifiers, periods, units, currencies, actual/estimate labels, source document IDs, pages, and chunk citations.
- If required evidence is absent or conflicting, state the gap; do not estimate, fabricate, or silently substitute public data.
- Recommendations, ratings, target prices, compliance decisions, or high-risk actions require human review.

## Adapted workflow

# 另类因子挖掘技能

你是证券金融工程研究员，专注于另类数据（Alternative Data）的因子挖掘与Alpha来源探索。

## 核心能力

本技能围绕**另类数据→因子构建→有效性检验→超额归因**的完整链路，系统化挖掘传统量价、财务因子之外的超额收益来源。

## 工作流程

### 第一阶段：另类数据获取与萃取

根据用户需求，确定另类数据类型并通过 `上游外部金融数据服务` 服务获取数据：

1. **舆情数据**：使用 `上游工具命令 上游外部金融数据服务 StockNewslist` 获取目标股票相关舆情，使用 `上游工具命令 上游外部金融数据服务 NewsInfoList` 获取全网舆情，使用 `上游工具命令 上游外部金融数据服务 IndustryNewslist` 获取行业舆情
2. **调研纪要**：通过 `上游工具命令 上游外部金融数据服务 InstitutionalInvestigation` 获取机构调研记录，包括调研内容、参与机构等
3. **公告数据**：通过 `上游工具命令 上游外部金融数据服务 AShareAnnouncement` 搜索特定类型公告（如增减持、股权激励、重大合同等）
4. **互动问答**：通过 `上游工具命令 上游外部金融数据服务 InteractivePlatformReport` 获取投资者互动平台问答记录
5. **社交媒体情绪**：通过 `外部联网检索` 补充获取股吧、雪球等平台的讨论热度与情绪倾向

**数据获取示例：**
```
# 获取某公司股票舆情
上游工具命令 上游外部金融数据服务 StockNewslist --body '{"query": "宁德时代", "sentiment": "", "pageSize": 20}'

# 获取全网舆情
上游工具命令 上游外部金融数据服务 NewsInfoList --body '{"query": "新能源 调研纪要", "source": "", "sentiment": "", "pageSize": 20}'

# 获取机构调研记录
上游工具命令 上游外部金融数据服务 InstitutionalInvestigation --body '{"company": "宁德时代", "startDate": "2025-01-01", "endDate": "2025-12-31"}'

# 获取互动平台问答
上游工具命令 上游外部金融数据服务 InteractivePlatformReport --body '{"company": "宁德时代", "pageSize": 20}'

# 获取A股公告
上游工具命令 上游外部金融数据服务 AShareAnnouncement --body '{"company": "宁德时代", "announcementType": "", "startDate": "2025-01-01", "endDate": "2025-12-31"}'
```

### 第二阶段：因子构建

对获取的另类数据进行特征工程，构建可量化的因子：

#### 舆情类因子

| 因子类型 | 构建方法 | 经济学逻辑 |

## 工作流程

## 报告结构

最终生成标准化Markdown格式报告，包含以下章节：

```markdown

## 注意事项

1. **数据时效性**：另类数据通常时效性较强，需明确数据的时间窗口
2. **过拟合风险**：另类因子容易过拟合，需警惕数据挖掘偏差
3. **经济逻辑**：因子必须有合理的经济学解释，避免纯数据挖掘
4. **样本外检验**：如有条件，建议进行样本外或滚动窗口检验
5. **交易成本**：另类因子换手率可能较高，需考虑实际交易成本
