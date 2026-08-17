# 当前系统 Skills 描述清单

生成日期：2026-08-04

## 统计口径

本清单记录当前私募研究工作台实际可发现的 10 个 Skills：

- 7 个随产品发布的内置私募投研 Skills。
- 1 个当前账号通过 Skills 市场安装的 Skill。
- 2 个位于用户全局 `~/.agents/skills` 目录、可被运行时发现的 Skills。

不包含测试夹具、Agent artifact 缓存副本、Codex 插件缓存和开发示例 Skills。

## 汇总

| 序号 | Skill | 类型 | 简要用途 |
|---:|---|---|---|
| 1 | `private-fund-knowledge-base` | 内置私募 Skill | 维护 Memo、报告和估值模型的证据链、版本谱系、差异与 Obsidian 投影 |
| 2 | `private-fund-memo` | 内置私募 Skill | 生成或修订有证据支持的 Markdown、HTML 和 PDF 投研 Memo |
| 3 | `private-fund-node` | 内置私募 Skill | 将结论、风险、催化剂、问题等保存为结构化、可溯源研究节点 |
| 4 | `private-fund-report-update` | 内置私募 Skill | 基于新证据创建旧报告的新版本并保留完整历史 |
| 5 | `private-fund-report` | 内置私募 Skill | 将选中的研究节点综合成长期专业投研报告 |
| 6 | `private-fund-valuation-impacts` | 内置私募 Skill | 从支持材料中提取对估值的上行、下行或混合影响路径 |
| 7 | `private-fund-valuation-metrics` | 内置私募 Skill | 从估值模型提取估值日期及五项标准指标 |
| 8 | `prediction-market-oracle-research` | 当前账号市场安装 | 研究预测市场概率能否作为决策和预警信号 |
| 9 | `coze-agent-collaboration` | 用户全局 Skill | 规范 Coze 项目中 Agent 之间的任务委派和结果返回 |
| 10 | `using-coze-cli` | 用户全局 Skill | 使用 Coze CLI 开发软件、Agent、工作流及生成多媒体内容 |

## 1. private-fund-knowledge-base

- 类型：内置私募 Skill
- 文件：`omnigent/omnigent/resources/private_fund_skills/private-fund-knowledge-base/SKILL.md`
- 中文说明：维护可读、可追溯的私募知识链，覆盖 Memo、报告和估值模型的版本谱系、相邻版本差异、质量门禁、证据卡片、复核状态与 Obsidian 投影。适用于创建、修订、刷新、比较、追踪、组织或解释多个研究版本。
- 原始 description：

> Maintain a readable, evidence-linked private-fund knowledge trail for versioned Memos and valuation models, including lineage, adjacent-version differences, quality gates, evidence cards, review state, and Obsidian projection. Use when the user asks to create, revise, refresh, compare, trace, organize, or explain multiple Memo/report/model versions, mentions Obsidian knowledge maintenance or provenance, or wants to know what changed and why.

## 2. private-fund-memo

- 类型：内置私募 Skill
- 文件：`omnigent/omnigent/resources/private_fund_skills/private-fund-memo/SKILL.md`
- 中文说明：针对公司、主题、问题、风险、催化剂、比较或选中的研究上下文，生成或修订带有可验证证据的聚焦型投研 Memo，并输出 Markdown、HTML 和 PDF。
- 原始 description：

> Generate or revise an evidence-backed private-fund research memo as Markdown, HTML, and PDF. Use when the user requests a focused memo about a company, topic, question, risk, catalyst, comparison, or selected research context rather than a comprehensive long-term report.

## 3. private-fund-node

- 类型：内置私募 Skill
- 文件：`omnigent/omnigent/resources/private_fund_skills/private-fund-node/SKILL.md`
- 中文说明：将用户选中的答案片段、证据、结论、假设、风险、催化剂、比较、问题或决策保存为结构化、可复用且可追溯的研究节点。
- 原始 description：

> Create and save a structured, traceable private-fund research node from information selected by the user. Use when the user asks to turn checked answer fragments, evidence, a conclusion, hypothesis, risk, catalyst, comparison, question, or decision into a reusable node for later analysis.

## 4. private-fund-report-update

- 类型：内置私募 Skill
- 文件：`omnigent/omnigent/resources/private_fund_skills/private-fund-report-update/SKILL.md`
- 中文说明：使用最新勾选的研究节点和证据，对已有私募投研报告进行滚动更新；创建可追溯的新版本并保留历史，而不是覆盖旧报告。
- 原始 description：

> Create a new traceable revision of an existing private-fund research report using newly checked nodes and evidence. Use when the user asks to update, revise, roll forward, refresh, or compare a prior report while preserving history instead of overwriting the old version.

## 5. private-fund-report

- 类型：内置私募 Skill
- 文件：`omnigent/omnigent/resources/private_fund_skills/private-fund-report/SKILL.md`
- 中文说明：将用户勾选的研究节点综合成有来源支撑的长期报告、尽调报告、投委会报告或研究基线，并输出 Markdown、HTML、PDF、JSON 和相关图表。
- 原始 description：

> Build a source-backed, long-form private-fund research report from user-checked research nodes. Use when the user asks to compile selected nodes into a durable investment report, due-diligence report, investment-committee report, research baseline, or other Markdown, HTML, and PDF deliverable.

## 6. private-fund-valuation-impacts

- 类型：内置私募 Skill
- 文件：`omnigent/omnigent/resources/private_fund_skills/private-fund-valuation-impacts/SKILL.md`
- 中文说明：从研究报告、会议纪要、财务报告、公告等支持材料中提取对当前估值模型的上行、下行或混合影响路径，形成可审计的固定结构 JSON，但不直接修改模型数值。
- 原始 description：

> Extract evidence-backed valuation-impact paths from research reports, meeting minutes, financial reports, announcements, and other supporting documents, then return fixed-shape JSON for valuation tracking. Use when supporting materials must be translated into upside, downside, or mixed effects on a current valuation model without changing model values.

## 7. private-fund-valuation-metrics

- 类型：内置私募 Skill
- 文件：`omnigent/omnigent/resources/private_fund_skills/private-fund-valuation-metrics/SKILL.md`
- 中文说明：从 Excel 事实或其他可溯源证据中识别估值日期及五项标准估值指标，适配不同公司的模型模板和标签，返回经过验证的固定结构 JSON。
- 原始 description：

> Identify a valuation model's valuation date and the five standard model metrics from Excel facts or source-backed evidence, then return validated, fixed-shape JSON. Use when extracting or reviewing single-quarter net-profit growth, gross-margin sequential change, Forward PE, 20-day average turnover amount, single-quarter revenue-growth acceleration, valuation dates, or when model templates and labels vary across companies.

## 8. prediction-market-oracle-research

- 类型：当前账号通过 Skills 市场安装
- 作者：`affaan-m`
- 来源：[GitHub](https://github.com/affaan-m/ECC/tree/main/skills/prediction-market-oracle-research)
- 安装时间：2026-08-03 14:58:46（Asia/Shanghai）
- 本地文件：`/Users/Admin/Library/Application Support/私募研究工作台/data/users/5f33d8b1-165c-4e0a-ba15-346be0310666/.agents/skills/prediction-market-oracle-research/SKILL.md`
- 中文说明：把预测市场作为产品、Agent、仪表盘或企业决策系统的数据源和预言机信号进行研究；分析市场隐含概率、信号质量、局限与集成方式，但不提供投资建议。
- 原始 description：

> Research prediction markets as data sources or oracle signals for products, agents, dashboards, and corporate decision intelligence. Use for source-grounded analysis of market-implied probabilities, caveats, and integration patterns without investment advice.

## 9. coze-agent-collaboration

- 类型：用户全局 Skill
- 版本：`0.3.5`
- 本地文件：`/Users/Admin/.agents/skills/coze-agent-collaboration/SKILL.md`
- 中文说明：定义 Coze 项目中 Agent 协作协议，包括委派任务、返回结果、发现 Agent 成员、消费协作响应以及在传输结果不确定时安全重试。
- 原始 description：

> CRITICAL Coze project Agent collaboration protocol: use `coze agent at --mode request` to delegate to peer Agents and `coze agent at --mode response` to return a result for an inbound Agent-targeted request. A visible @mention never dispatches or responds. Also use this skill to discover Agent members, consume collaboration responses without creating a loop, or retry an unchanged call after an unknown transport outcome.

## 10. using-coze-cli

- 类型：用户全局 Skill
- 版本：`0.3.5`
- 本地文件：`/Users/Admin/.agents/skills/using-coze-cli/SKILL.md`
- 中文说明：在用户需要开发、修改、调试、运行或迭代软件产品时，通过 Coze CLI 创建和维护网页、Web App、App、小程序、Agent、工作流和 Skill；同时覆盖部署、环境变量、数据库、图片、语音、视频及长任务产物。
- 原始 description：

> 【核心触发·软件开发】当用户意图是开发、修改、调试、运行或迭代软件产品时，加载本技能并通过 coze code 调起；典型场景：创建或迭代网页、Web App、App、小程序等可运行、可维护、可迭代的工程项目。判定边界：仅当用户明确想做可维护、可迭代的产品/工程项目时才导流到扣子编程；不要因请求中出现 CLI、文件读写、HTML、可视化、卡片、报告、图片等词就导流。其它子模块（满足任一即触发，无需显式点名 coze）：coze code 还覆盖 Agent/工作流/skill 及发需求、预览、部署、环境变量/域名/数据库；coze generate—文生图/语音 TTS/视频；coze session（Claw）—对话、PPT、播客、长任务产物；coze file—本地文件转在线链接；输入以 /coze-cli、/coze 开头（仅作路由）。

