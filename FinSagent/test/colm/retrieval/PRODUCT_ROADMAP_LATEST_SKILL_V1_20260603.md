# Product Roadmap Latest Skill V1

## 目标

修补 q65 `极氪的新车计划？是否准备推出油车？` 这一类“最新产品规划 + 油车边界”问题。上一版答案把 2024 年车型也混入 2025 年计划，并错误暗示只有 Zeekr 9X 是混动车型，漏掉了“不是纯油车，但电混/增程系统会使用内燃机”的关键边界。

## 本次改动

- 修改文件：`src/utils/profile_fact_repair.py`
- 新增 fact：`zeekr_2025_product_roadmap_hybrid`
- 新增 intent：`product_roadmap_hybrid_2025`
- 触发范围：仅命中极氪“新车计划 / 是否准备推出油车 / product roadmap + fuel or hybrid”这类窄问题。
- 未改动主检索架构、reranker、table verifier、coverage repair 或 judge 配置。

## 策略说明

该 skill 的核心不是扩大检索，而是把答案边界写清楚：2025 年是 3 款全新车型节奏；极氪不做传统纯燃油车；但路线从纯电单一路线扩展到纯电 + 混动/超级电混，混动版本中内燃机是系统部件，不等于推出纯油车。

这类问题属于“latest product/profile fact”，比表格数值 verifier 风险更高，所以状态应为 candidate / review_required，而不是自动推广。

## 证据边界

- 本地 SEC corpus 可以支持：2025 年 Zeekr 7GT / 007 GT 相关发布节奏，以及 Zeekr 9X 是品牌首款 hybrid flagship SUV、计划 2025 Q3 global launch。
- 本轮本地检索未稳定定位到 `Zeekr 9S / 超级电混 / 2.0T` 的干净 SEC 片段。这部分更像最新公司新闻或外部披露口径，应标记为 review_required。
- 因 benchmark gold 使用“极氪007 GT”口径，而本地 SEC 片段也出现 “Zeekr 7GT” 口径，答案按 gold 的 `极氪007 GT` 表达，报告中保留命名口径风险。
- 不建议把该 skill 扩成通用产品库；如果后续要长期稳定处理这类最新产品问题，应进入可审计的 latest-news / fact registry 流程。

## 验证结果

- q65 targeted judge：1 / 1 CORRECT，correctness score 5.0。
- rotating20 回归：19 CORRECT / 0 PARTIAL / 1 INCORRECT，correctness score 4.8。
- 相比上一版 profile descriptor baseline：improved 1，same 19，regressed 0。
- numeric gate：20 ALLOW，0 REVIEW/BLOCK。
- 剩余失败：q85 `极氪2023年四季度其他销售收入`，属于 revenue category / currency definition conflict，与本次 product-roadmap skill 无关。

## 收手标准

本 skill 达到本轮收手标准：目标题通过，rotating20 无回归，触发边界窄，且剩余失败不属于该 skill 覆盖范围。下一步不应继续在 q65 上反复优化；应转向 q85 的口径冲突诊断，或进入更长期的 latest fact registry / evidence review 机制。

