# Evidence Preview

- Preview ID: `nvidia_q15_source_conflict_runner`
- QID: `qa_kp_000015`

## Question

NVIDIA在2025年如何描述出口管制对中国Data Center业务的影响？

## Answer

按2025财年披露口径，NVIDIA对中国 Data Center 业务的出口管制影响描述并不是“已经被完全排除在中国市场之外”。公司表示，美国政府此前对面向中国（含香港、澳门）和俄罗斯的部分高性能芯片及相关系统设置许可要求，影响了 A100、H100、DGX 等产品。为继续服务客户，NVIDIA 扩展了 Data Center 产品组合，提供一些在每次出货前不需要许可证或提前通知的新方案，并推出了专为中国市场设计、且不需要出口管制许可证的新产品。在这个2025财年口径下，中国 Data Center 收入有所增长；但其占 Data Center 总收入的比例仍显著低于2023年10月出口管制开始前的水平。 因此，更准确的结论是：出口管制削弱并限制了 NVIDIA 在中国 Data Center 市场的产品组合和收入占比，但2025财年的披露同时强调了合规替代产品和中国 Data Center 收入增长。后续关于 H20、2026财年库存减值或2025年4月以后新许可要求的披露，属于更晚期间的情况，不应覆盖这道题要求的2025财年表述。

## Audit Notes

- retrieval_chunks_previewed=8
- grep_anchors_previewed=12
- triggered_skills=source_conflict
- period/source conflict repair preserved original answer for audit

## Retrieval Preview

| Rank | Retriever | Score | Source | Date | Snippet |
| ---: | --- | ---: | --- | --- | --- |
| 1 | Title Summary | 0.6620 | 20251026_10-Q_base_final.json p.36 | 2025-10-26 | On April 9, 2025, the USG informed nvidia that the USG requires a license for export to China (including Hong Kong and Macau) and D:5 countries, or to companies headquartered or with an ultimate parent therein, of nvidia's H20 integrated circuits and any ot... |
| 2 | Title Summary | 0.6620 | 20251026_10-Q_base_final.json p.36 | 2025-10-26 | Although nvidia is already effectively foreclosed from the China market by U.S. export controls, if those controls changed to allow nvidia to return to the market, the Chinese government could modify or implement the Action Plan in a way that effectively pr... |
| 3 | FAISS | 0.6562 | 20250126_10-K_base_final.json p.24 | 2025-01-26 | The USG has already imposed export controls restricting certain gaming GPUs, and if the USG expands such controls to restrict additional gaming products, the expanded controls may disrupt a significant portion of NVIDIA's supply and distribution chain and n... |
| 4 | FAISS | 0.6999 | 20250126_10-K_base_final.json p.35 | 2025-01-26 | In August 2022, the USG announced licensing requirements that, with certain exceptions, impact exports to China (including Hong Kong and Macau) and Russia of NVIDIA's A100 and H100 integrated circuits, DGX or any other systems or boards which incorporate A1... |
| 5 | FAISS | 0.6986 | 20250427_10-Q_base_final.json p.21 | 2025-04-27 | On April 9, 2025, the U.S. government, or USG, informed NVIDIA that the USG requires a license for export to China (including Hong Kong and Macau) and D:5 countries, or to companies headquartered or with an ultimate parent therein, of NVIDIA's H20 integrate... |
| 6 | Title Summary | 0.6620 | 20251026_10-Q_base_final.json p.36 | 2025-10-26 | Export controls targeting GPUs and semiconductors associated with AI have subjected and may in the future subject downstream users of NVIDIA's products to restrictions on the use, resale, repair, or transfer of NVIDIA's products, negatively impacting NVIDIA... |
| 7 | Table | 0.4747 | /root/autodl-tmp/RAG_Agent_data/lotus/20250701/filtered_pdf_processed_table/Lotus 20-F 20250430_table_reconstructed.json p.274 |  | <table> <thead> <tr> <th></th> <th colspan="3">Year ended December 31,</th> </tr> <tr> <th></th> <th>2024</th> <th>2023</th> <th>2022</th> </tr> <tr> <th></th> <th>US$</th> <th>US$</th> <th>US$</th> </tr> </thead> <tbody> <tr> <td>Provision of services(i)</... |
| 8 | Table | 0.4755 | /root/autodl-tmp/RAG_Agent_data/lotus/20250701/filtered_pdf_processed_table/Lotus 424B3 20240925_table_reconstructed.json p.312 |  | <table> <thead> <tr> <th></th> <th>2023</th> <th>2022</th> <th>2021</th> </tr> <tr> <th></th> <th>US$</th> <th>US$</th> <th>US$</th> </tr> </thead> <tbody> <tr> <td>Chinese mainland</td> <td>419,448</td> <td>8,816</td> <td>3,109</td> </tr> <tr> <td>UK</td>... |

## Grep Probe

- Files scanned: 15
- Query terms: export controls, export control, license, China, Chinese, Data Center, NVIDIA, 2025, Data, Center
- Period terms: 
- Metric aliases: {}

| Type | Text | Source | Confidence | Snippet |
| --- | --- | --- | ---: | --- |
| nearby_number | 025 | retrieval/nvidia_mini10_period_source_conflict_20260605/e2e_q15_period_repair_summary.json | 0.78 | The repaired answer uses NVIDIA FY2025 10-K framing: export controls constrained China Data Center product mix and share, but NVIDIA offered compliant alternatives, ramped China-designed products that did not require... |
| nearby_number | 026 | retrieval/nvidia_mini10_period_source_conflict_20260605/e2e_q15_period_repair_summary.json | 0.78 | : export controls constrained China Data Center product mix and share, but NVIDIA offered compliant alternatives, ramped China-designed products that did not require export-control licenses, and China Data Center reve... |
| nearby_number | $5.5 | nvidia_mini10_cap2_20260601/judge/results.json | 0.78 | 有所放松，中国自身的监管措施仍可能构成持续障碍，而反复变动的出口管制规则也增加了合规负担，扰乱供应链和客户需求交付。 The generated answer directly contradicts key points from the gold answer. Specifically, it claims NVIDIA is “substantially excluded” from China’s data center... |
| nearby_number | 8.01 | retrieval/nvidia_mini10_period_source_conflict_20260605/mini10_period_repaired.json | 0.78 | if the Form 8-K filing is intended to simultaneously satisfy the filing obligation of NVIDIA Corporation under any of the following provisions: title: nvidia > 20250113_8-K summary: NVIDIA Corporation filed a Form 8-K... |
| nearby_number | 29,600 | retrieval/nvidia_mini10_period_source_conflict_20260605/mini10_period_repaired.json | 0.78 | logy from third parties. Its worldwide activities are subject to U.S. and foreign government regulations. In sustainability, NVIDIA plans to build Earth-2, a digital twin of the Earth for climate change prediction and... |
| nearby_number | $4.5 billion | retrieval/nvidia_mini10_period_source_conflict_20260605/mini10_period_repaired.json | 0.78 | ns worldwide, with a primary focus on U.S. government export restrictions targeting AI-related semiconductors. These controls have increasingly limited NVIDIA's ability to sell products like the A100, H100, and H20 to... |
| nearby_number | 32449 | retrieval/nvidia_mini10_period_source_conflict_20260605/mini10_period_repaired.json | 0.78 | and "Graphics," as described in Note 15 of the Notes to Condensed Consolidated Financial Statements. Headquartered in Santa Clara, California, NVIDIA was incorporated in California in April 1993 and reincorporated in... |
| nearby_number | -404 | retrieval/nvidia_mini10_period_source_conflict_20260605/mini10_period_repaired.json | 0.78 | ics," as described in Note 15 of the Notes to Condensed Consolidated Financial Statements. Headquartered in Santa Clara, California, NVIDIA was incorporated in California in April 1993 and reincorporated in Delaware i... |
| exact_phrase | NVIDIA | nvidia_mini10_period_source_conflict_20260605/judge/results.json | 0.65 | NVIDIA属于半导体行业，采用无晶圆厂（fabless）商业模式，专注于产品设计、质量保证、营销和客户支持，而将晶圆制造、封装和测试等生产环节外包给第三方供应商。其核心业务围绕加速计算和人工智能技术展开，源于1999年发明的GPU。 公司主要通过两个可报告经营分部开展业务：“Compute & Networking”（计算与网络）和“Graphics”（图形）。其中，“Compute & Networking”分部包括数据中心加... |
| exact_phrase | NVIDIA | nvidia_mini10_cap2_20260601/judge/results.json | 0.65 | NVIDIA属于半导体行业，采用无晶圆厂（fabless）商业模式，专注于产品设计、质量保证、营销和客户支持，而将晶圆制造、封装和测试等生产环节外包给第三方供应商。其核心业务围绕加速计算和人工智能技术展开，源于1999年发明的GPU。 公司主要通过两个可报告经营分部开展业务：“Compute & Networking”（计算与网络）和“Graphics”（图形）。其中，“Compute & Networking”分部包括数据中心加... |
| exact_phrase | NVIDIA | retrieval/nvidia_mini10_period_source_conflict_20260605/e2e_q15_period_repair_summary.json | 0.65 | The repaired answer uses NVIDIA FY2025 10-K framing: export controls constrained China Data Center product mix and share, but NVIDIA offered compliant alternatives, ramped China-designed products that did not require... |
| exact_phrase | 2025 | retrieval/nvidia_mini10_period_source_conflict_20260605/e2e_q15_period_repair_summary.json | 0.65 | The repaired answer uses NVIDIA FY2025 10-K framing: export controls constrained China Data Center product mix and share, but NVIDIA offered compliant alternatives, ramped China-designed products that did not require... |

## Skill Traces

### source_conflict

- Triggered: True
- Reason: period_source_conflict_nvidia_fy2025_export_control
- Decision: repair_applied
- Supporting source: {'filename': '20250126_10-K_base_final.json', 'matched_phrase': 'Data Center revenue in China grew in fiscal year 2025'}
- Notes:
