# Evidence Preview

- Preview ID: `lotus_q1_success_runner`
- QID: `lotus_gen_01`

## Question

What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023?

## Answer

For the nine months ended September 30, 2024, Lotus Technology reported revenue of $652.8 million, compared to $317.9 million for the same period in 2023. This represents a year-over-year increase of 105%, which the company attributes to growing vehicle deliveries.

## Audit Notes

- retrieval_chunks_previewed=8
- grep_anchors_previewed=12

## Retrieval Preview

| Rank | Retriever | Score | Source | Date | Snippet |
| ---: | --- | ---: | --- | --- | --- |
| 1 | BM25 | 14.1590 | 1121_ppt.json p.22 | 2024-11-21 | In the first nine months of 2024, Lotus achieved a 105% year-on-year increase in topline growth, attributed to growing deliveries. Sales of goods reached $624 million, reflecting a 104% year-on-year increase. Service revenues also surged by 129% year-on-yea... |
| 2 | FAISS | 0.7710 | 1121_ppt.json p.41 | 2024-11-21 | For the nine months ended September 30, 2024, Lotus reported a revenue of $652,823,000, a significant increase from $317,941,000 for the same period in 2023. The cost of revenues rose to $593,708,000 from $284,193,000, resulting in a gross profit of $59,115... |
| 3 | Title Summary | 0.5525 | 0919_final.json p.164 | 2024-09-19 | Research and development expenses. Lotus Technology's research and development expenses increased by US$22.3 million from US$152.5 million for the six months ended June 30, 2023, to US$174.9 million for the six months ended June 30, 2024, primarily due to t... |
| 4 | FAISS | 0.7261 | 1121_ppt.json p.43 | 2024-11-21 | In the nine months ending September 30, 2024, Lotus reported a net loss of $666,520,000, an increase from the $526,524,000 reported in the same period in 2023. The adjusted net loss, which accounts for share-based compensation expenses, was $632,955,000 for... |
| 5 | FAISS | 0.7525 | 20240112_final.json p.54 | 2024-01-12 | The following sets forth the unaudited condensed consolidated financial statements of Lotus Technology as of and for the nine months ended September 30, 2023. |
| 6 | FAISS | 0.7525 | 20240112_final.json p.58 | 2024-01-12 | Revenues. Lotus Technology had revenues of US$317.9 million in the nine months ended September 30, 2023, representing an increase of 8,594.0% from US$3.7 million in the nine months ended September 30, 2022, primarily due to the commencement of battery elect... |
| 7 | FAISS | 0.7525 | 20240112_final.json p.58 | 2024-01-12 | As a result of the foregoing, Lotus Technology had a net loss of US$526.5 million in the nine months ended September 30, 2023, representing an increase of 43.6% from US$366.6 million in the nine months ended September 30, 2022. Accounts receivable. As of Se... |
| 8 | FAISS | 0.7525 | 20240112_final.json p.58 | 2024-01-12 | As of September 30, 2023, Lotus Technology had accrued expenses and other current liabilities of US$536.9 million, compared with US$506.5 million as of December 31, 2022. The accrued expenses and other current liabilities were primarily related to the acqui... |

## Grep Probe

- Files scanned: 28
- Query terms: Lotus, revenue, nine, months, September, 30, 2024, 2023
- Period terms: nine months ended September 30, 2024, 2023
- Metric aliases: {'revenue': ['revenue', 'revenues', 'total revenue', 'net revenue', 'sales']}

| Type | Text | Source | Confidence | Snippet |
| --- | --- | --- | ---: | --- |
| period_phrase | nine months ended September 30 | retrieval/lotus_mini10_generalization_20260604/lotus_mini10.json | 0.80 | What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023? For the nine months ended September 30, 2024, Lotus Technology revenue was about 652... |
| period_phrase | nine months ended September 30 | retrieval/lotus_mini10_generalization_20260604/lotus_profile_repair_check.json | 0.80 | What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023? For the nine months ended September 30, 2024, Lotus Technology revenue was about 652... |
| period_phrase | nine months ended September 30 | lotus_mini10_generalization_20260604/smoke2_v2_judge/results.json | 0.80 | What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023? What was Lotus Technology revenue for the nine months ended September 30, 2024, and... |
| period_phrase | nine months ended September 30 | lotus_mini10_generalization_20260604/smoke2_v3_judge/results.json | 0.80 | What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023? What was Lotus Technology revenue for the nine months ended September 30, 2024, and... |
| metric_alias | revenue | retrieval/lotus_mini10_generalization_20260604/lotus_mini10.json | 0.75 | What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023? For the nine months ended September 30, 2024, Lotus Technology revenue was about 652... |
| metric_alias | revenue | retrieval/lotus_mini10_generalization_20260604/lotus_profile_repair_check.json | 0.75 | What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023? For the nine months ended September 30, 2024, Lotus Technology revenue was about 652... |
| metric_alias | revenue | lotus_mini10_generalization_20260604/smoke2_v2_judge/results.json | 0.75 | What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023? What was Lotus Technology revenue for the nine months ended September 30, 2024, and... |
| metric_alias | revenue | lotus_mini10_generalization_20260604/smoke2_v3_judge/results.json | 0.75 | What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023? What was Lotus Technology revenue for the nine months ended September 30, 2024, and... |
| nearby_number | 8 million | lotus_mini10_generalization_20260604/smoke2_judge/results.json | 0.94 | Lotus Technology reported total revenue of about US.8 million for the nine months ended September 30, 2024, compared with about US.9 million for the same period in 2023. This shows revenue more than doubled year over... |
| nearby_number | 9 million | lotus_mini10_generalization_20260604/smoke2_judge/results.json | 0.94 | Lotus Technology reported total revenue of about US.8 million for the nine months ended September 30, 2024, compared with about US.9 million for the same period in 2023. This shows revenue more than doubled year over... |
| nearby_number | 652.8 million | retrieval/lotus_mini10_generalization_20260604/lotus_mini10.json | 0.94 | What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023? For the nine months ended September 30, 2024, Lotus Technology revenue was about 652... |
| nearby_number | 652.8 million | retrieval/lotus_mini10_generalization_20260604/lotus_profile_repair_check.json | 0.94 | What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023? For the nine months ended September 30, 2024, Lotus Technology revenue was about 652... |

## Skill Traces

- No skill trace fields were detected in this row.
