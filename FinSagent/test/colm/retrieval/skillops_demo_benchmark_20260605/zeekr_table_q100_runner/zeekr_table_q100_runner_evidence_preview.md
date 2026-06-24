# Evidence Preview

- Preview ID: `zeekr_table_q100_runner`
- QID: `qa_kp_100`

## Question

极氪2024年一季度毛利率

## Answer

极氪2024年第一季度（1月1日至3月31日）的毛利率在不同公开文件中存在不一致的披露：一份于2024年6月11日发布的文件（6K_20240611.pdf，第4页）显示毛利率为11.8%；而另一份于2025年5月15日发布的文件（6K_20250515.pdf，第4页）则显示为16.3%。目前尚无公开信息解释这两项数据之间的差异，也未说明16.3%是否包含领克（Lynk & Co）在内的极氪集团合并数据，还是仅指极氪品牌的单体数据。因此，关于极氪2024年一季度的确切毛利率，存在来源冲突且缺乏进一步澄清。

## Audit Notes

- retrieval_chunks_previewed=8
- grep_anchors_previewed=12
- triggered_skills=table_evidence_verifier

## Retrieval Preview

| Rank | Retriever | Score | Source | Date | Snippet |
| ---: | --- | ---: | --- | --- | --- |
| 1 | PageIndex | 40.2139 | 6K_20250515.json p.6 | 2025-05-15 | [PageIndex structural summary] Document: 6K_20250515.pdf Date: 2025-05-15 Pages: 7-7 Title: Cost of Revenues and Gross Margin Summary: The partial document provides a detailed financial performance overview for the first quarter of 2025, comparing results y... |
| 2 | PageIndex | 38.9472 | 6K_20250515.json p.4 | 2025-05-15 | [PageIndex structural summary] Document: 6K_20250515.pdf Date: 2025-05-15 Pages: 5-5 Title: Delivery Update Summary: The partial document outlines key financial results and recent operational developments for the first quarter of 2025. It reports a net loss... |
| 3 | PageIndex | 38.2572 | 6K_20250515.json p.7 | 2025-05-15 | [PageIndex structural summary] Document: 6K_20250515.pdf Date: 2025-05-15 Pages: 7-8 Title: Operating Expenses Summary: The partial document provides a detailed financial performance overview for the first quarter of 2025, comparing results year-over-year (... |
| 4 | PageIndex | 35.4422 | 6K_20240611.json p.3 | 2024-06-11 | [PageIndex structural summary] Document: 6K_20240611.pdf Date: 2024-06-11 Pages: 4-4 Title: Operating Highlights for the First Quarter of 2024 Summary: The partial document presents ZEEKR Intelligent Technology Holding Limited’s unaudited financial and oper... |
| 5 | PageIndex | 37.4941 | 6K_20240611.json p.5 | 2024-06-11 | [PageIndex structural summary] Document: 6K_20240611.pdf Date: 2024-06-11 Pages: 6-7 Title: Revenues Summary: The partial document highlights ZEEKR’s strong operational and financial performance in the first quarter of 2024. Key points include record-high v... |
| 6 | PageIndex | 38.0714 | 6K_20240611.json p.6 | 2024-06-11 | [PageIndex structural summary] Document: 6K_20240611.pdf Date: 2024-06-11 Pages: 7-7 Title: Cost of Revenues and Gross Margin Summary: The partial document provides a detailed financial overview of the company's performance for the first quarter of 2024 com... |
| 7 | PageIndex | 35.2250 | 6K_20240821.json p.3 | 2024-08-21 | [PageIndex structural summary] Document: 6K_20240821.pdf Date: 2024-08-21 Pages: 4-4 Title: Exhibit 99.1 Summary: The partial document presents ZEEKR Intelligent Technology Holding Limited’s unaudited financial and operational results for the second quarter... |
| 8 | PageIndex | 38.4645 | 6K_20241114.json p.4 | 2024-11-14 | [PageIndex structural summary] Document: 6K_20241114.pdf Date: 2024-11-14 Pages: 5-5 Title: Key Financial Results Summary: The partial document outlines key financial results and recent operational developments for a company (likely ZEEKR) in the third quar... |

## Grep Probe

- Files scanned: 17
- Query terms: gross margin, 2024
- Period terms: 
- Metric aliases: {}

| Type | Text | Source | Confidence | Snippet |
| --- | --- | --- | ---: | --- |
| nearby_number | 467 | e2e_rescue_full_20260524_160443/judge/results.json | 0.78 | 截至2024年12月31日，极氪在中国拥有总计467个线下销售和服务中心，覆盖了ZEEKR Center、ZEEKR Space、ZEEKR Delivery Center和ZEEKR House等多种形式。极氪计划进一步扩展其线下销售和服务网络，以提升品牌影响力和用户体验。这些中心不仅为用户提供车辆展示和试驾服务，还涵盖了交付和售后支持，确保用户在整个购车生命周期中都能享受到优质服务。极氪的销售网络布局充分体现了其以用户为中心的... |
| nearby_number | 467 | e2e_rescue_full_20260524_160443/judge_small30_qidaware_20260528/results.json | 0.78 | 截至2024年12月31日，极氪在中国拥有总计467个线下销售和服务中心，覆盖了ZEEKR Center、ZEEKR Space、ZEEKR Delivery Center和ZEEKR House等多种形式。极氪计划进一步扩展其线下销售和服务网络，以提升品牌影响力和用户体验。这些中心不仅为用户提供车辆展示和试驾服务，还涵盖了交付和售后支持，确保用户在整个购车生命周期中都能享受到优质服务。极氪的销售网络布局充分体现了其以用户为中心的... |
| nearby_number | 467 | retrieval/diagnostic_testsets_20260526/zeekr_small_30_diagnostic.json | 0.78 | 截至2024年12月31日，极氪在中国拥有总计467个线下销售和服务中心，覆盖了ZEEKR Center、ZEEKR Space、ZEEKR Delivery Center和ZEEKR House等多种形式。极氪计划进一步扩展其线下销售和服务网络，以提升品牌影响力和用户体验。这些中心不仅为用户提供车辆展示和试驾服务，还涵盖了交付和售后支持，确保用户在整个购车生命周期中都能享受到优质服务。极氪的销售网络布局充分体现了其以用户为中心的... |
| nearby_number | 467 | retrieval/diagnostic_testsets_20260526/zeekr_large_100_regression.json | 0.78 | 截至2024年12月31日，极氪在中国拥有总计467个线下销售和服务中心，覆盖了ZEEKR Center、ZEEKR Space、ZEEKR Delivery Center和ZEEKR House等多种形式。极氪计划进一步扩展其线下销售和服务网络，以提升品牌影响力和用户体验。这些中心不仅为用户提供车辆展示和试驾服务，还涵盖了交付和售后支持，确保用户在整个购车生命周期中都能享受到优质服务。极氪的销售网络布局充分体现了其以用户为中心的... |
| nearby_number | 467 | retrieval/e2e_rescue_full_20260524_160443/answer_gate.json | 0.78 | 截至2025年5月15日，极氪在中国的销售网络最新可确认的数据仍为截至2024年12月31日的官方统计：全国共有467家线下销售与服务中心。这些网点由四种类型组成——极氪中心（Zeekr Center）、极氪空间（Zeekr Space）、极氪交付中心（Zeekr Delivery Center）和极氪之家（Zeekr House），主要布局于购物中心或城市核心区域，以强化品牌高端形象并支持纯电动车销售。相较2023年12月31日... |
| nearby_number | 340 | retrieval/e2e_rescue_full_20260524_160443/answer_gate.json | 0.78 | 截至2025年5月15日，极氪在中国的销售网络最新可确认的数据仍为截至2024年12月31日的官方统计：全国共有467家线下销售与服务中心。这些网点由四种类型组成——极氪中心（Zeekr Center）、极氪空间（Zeekr Space）、极氪交付中心（Zeekr Delivery Center）和极氪之家（Zeekr House），主要布局于购物中心或城市核心区域，以强化品牌高端形象并支持纯电动车销售。相较2023年12月31日... |
| nearby_number | 240 | retrieval/e2e_rescue_full_20260524_160443/answer_gate.json | 0.78 | 截至2025年5月15日，极氪在中国的销售网络最新可确认的数据仍为截至2024年12月31日的官方统计：全国共有467家线下销售与服务中心。这些网点由四种类型组成——极氪中心（Zeekr Center）、极氪空间（Zeekr Space）、极氪交付中心（Zeekr Delivery Center）和极氪之家（Zeekr House），主要布局于购物中心或城市核心区域，以强化品牌高端形象并支持纯电动车销售。相较2023年12月31日... |
| nearby_number | 130 | retrieval/e2e_rescue_full_20260524_160443/BOSS_QUICK_DEMO_PACK_20260525.md | 0.78 | # Boss Quick Demo Pack - PageIndex Hybrid RAG Purpose: quick representative questions to demonstrate current full-run accuracy. All listed judged rows are CORRECT in the full judge output. Full-run summary: generated... |
| exact_phrase | 2024 | e2e_rescue_full_20260524_160443/judge/results.json | 0.65 | 截至2024年12月31日，极氪在中国拥有总计467个线下销售和服务中心，覆盖了ZEEKR Center、ZEEKR Space、ZEEKR Delivery Center和ZEEKR House等多种形式。极氪计划进一步扩展其线下销售和服务网络，以提升品牌影响力和用户体验。这些中心不仅为用户提供车辆展示和试驾服务，还涵盖了交付和售后支持，确保用户在整个购车生命周期中都能享受到优质服务。极氪的销售网络布局充分体现了其以用户为中心的... |
| exact_phrase | 2024 | e2e_rescue_full_20260524_160443/judge_small30_qidaware_20260528/results.json | 0.65 | 截至2024年12月31日，极氪在中国拥有总计467个线下销售和服务中心，覆盖了ZEEKR Center、ZEEKR Space、ZEEKR Delivery Center和ZEEKR House等多种形式。极氪计划进一步扩展其线下销售和服务网络，以提升品牌影响力和用户体验。这些中心不仅为用户提供车辆展示和试驾服务，还涵盖了交付和售后支持，确保用户在整个购车生命周期中都能享受到优质服务。极氪的销售网络布局充分体现了其以用户为中心的... |
| exact_phrase | 2024 | retrieval/diagnostic_testsets_20260526/zeekr_small_30_diagnostic.json | 0.65 | 截至2024年12月31日，极氪在中国拥有总计467个线下销售和服务中心，覆盖了ZEEKR Center、ZEEKR Space、ZEEKR Delivery Center和ZEEKR House等多种形式。极氪计划进一步扩展其线下销售和服务网络，以提升品牌影响力和用户体验。这些中心不仅为用户提供车辆展示和试驾服务，还涵盖了交付和售后支持，确保用户在整个购车生命周期中都能享受到优质服务。极氪的销售网络布局充分体现了其以用户为中心的... |
| exact_phrase | 2024 | retrieval/diagnostic_testsets_20260526/zeekr_large_100_regression.json | 0.65 | 截至2024年12月31日，极氪在中国拥有总计467个线下销售和服务中心，覆盖了ZEEKR Center、ZEEKR Space、ZEEKR Delivery Center和ZEEKR House等多种形式。极氪计划进一步扩展其线下销售和服务网络，以提升品牌影响力和用户体验。这些中心不仅为用户提供车辆展示和试驾服务，还涵盖了交付和售后支持，确保用户在整个购车生命周期中都能享受到优质服务。极氪的销售网络布局充分体现了其以用户为中心的... |

## Skill Traces

### table_evidence_verifier

- Triggered: True
- Reason: deterministic source-precedence gross-margin repair for 2024 Q1
- Decision: repair_applied
- Supporting source: {}
- Notes: verification_attached
