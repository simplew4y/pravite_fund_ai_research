# Evidence Preview

- Preview ID: `nvidia_q15_source_conflict_repair`
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

- Files scanned: 3
- Query terms: export controls, export control, license, China, Chinese, Data Center, NVIDIA, 2025, Data, Center
- Period terms: 
- Metric aliases: {}

| Type | Text | Source | Confidence | Snippet |
| --- | --- | --- | ---: | --- |
| nearby_number | $4.5 billion | 2_final_pdf_v2/20250427_10-Q/base_final.json | 0.78 | mpanies headquartered or with an ultimate parent therein, of NVIDIA's H20 integrated circuits and any other circuits achieving the H20’s memory bandwidth, interconnect bandwidth, or combination thereof. As a result of... |
| nearby_number | 36,000 | 2_final_pdf_v2/20250126_10-K/base_final.json | 0.78 | foreign government regulations. Sustainability efforts include the Earth-2 initiative to create a digital twin of Earth for climate change predictions and adaptation strategies. Human capital management emphasizes emp... |
| nearby_number | 27,100 | 2_final_pdf_v2/20250126_10-K/base_final.json | 0.78 | tions. Sustainability efforts include the Earth-2 initiative to create a digital twin of Earth for climate change predictions and adaptation strategies. Human capital management emphasizes employees as a key asset, wi... |
| nearby_number | 8,900 | 2_final_pdf_v2/20250126_10-K/base_final.json | 0.78 | ity efforts include the Earth-2 initiative to create a digital twin of Earth for climate change predictions and adaptation strategies. Human capital management emphasizes employees as a key asset, with approximately 3... |
| nearby_number | 2788 | 2_final_pdf_v2/20250126_10-K/base_final.json | 0.78 | aware # NVIDIA CORPORATION (State or other jurisdiction of # NVIDIA CORPORATION incorporation or organization) # NVIDIA CORPORATION 94-3177549 # NVIDIA CORPORATION (I.R.S. Employer # NVIDIA CORPORATION (I.R.S. Employe... |
| nearby_number | 405 | 2_final_pdf_v2/20250126_10-K/base_final.json | 0.78 | uired to file such reports), and (2) has been subject to such filing requirements for the past 90 days. Yes ☒ No ☐ Indicate by check mark whether the registrant has submitted electronically every Interactive Data File... |
| nearby_number | 232.405 | 2_final_pdf_v2/20250126_10-K/base_final.json | 0.78 | ts), and (2) has been subject to such filing requirements for the past 90 days. Yes ☒ No ☐ Indicate by check mark whether the registrant has submitted electronically every Interactive Data File required to be submitte... |
| nearby_number | 2025042 | 2_final_pdf_v2/20250427_10-Q/base_final.json | 0.78 | e of a chip, the “performance density” of a chip, the interconnect bandwidth of a chip, and the memory bandwidth of a chip. NVIDIA may be unable to create a competitive product for China’s data center market that rece... |
| exact_phrase | export controls | 2_final_pdf_v2/20250126_10-K/base_final.json | 0.65 | NVIDIA’s competitive position and may continue to do so if further changes occur, potentially excluding the company from markets such as China and Tier 2 countries, while also raising risks related to supply chain con... |
| exact_phrase | export controls | 2_final_pdf_v2/20250126_10-K/base_final.json | 0.65 | NVIDIA’s competitive position and may continue to do so if further changes occur, potentially excluding the company from markets such as China and Tier 2 countries, while also raising risks related to supply chain con... |
| exact_phrase | export controls | 2_final_pdf_v2/20250126_10-K/base_final.json | 0.65 | which will be subject to new compliance burdens and related extraterritorial regulatory obligations. The AI Diffusion IFR would expose U.S. providers and the U.S. industry to an enhanced risk of retaliation from other... |
| exact_phrase | export controls | 2_final_pdf_v2/20250126_10-K/base_final.json | 0.65 | ve a greater impact on NVIDIA's ability to compete in markets subject to those controls. Export controls may disrupt NVIDIA's supply and distribution chain for a substantial portion of NVIDIA's products, which are war... |

## Skill Traces

### source_conflict

- Triggered: True
- Reason: period_source_conflict_nvidia_fy2025_export_control
- Decision: repair_applied
- Supporting source: {'filename': '20250126_10-K_base_final.json', 'matched_phrase': 'Data Center revenue in China grew in fiscal year 2025'}
- Notes:
