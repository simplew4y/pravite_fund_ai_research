# Evidence Preview

- Preview ID: `lotus_q1_success_runner`
- QID: `lotus_gen_01`

## Question

What was Lotus Technology revenue for the nine months ended September 30, 2024, and how did it compare with the same period in 2023?

## Answer

For the nine months ended September 30, 2024, Lotus Technology reported revenue of $652.8 million, compared to $317.9 million for the same period in 2023. This represents a year-over-year increase of approximately 105%, driven by growing vehicle deliveries and expansion in both sales of goods and service revenues.

## Audit Notes

- retrieval_chunks_previewed=8
- grep_anchors_previewed=12

## Retrieval Preview

| Rank | Retriever | Score | Source | Date | Snippet |
| ---: | --- | ---: | --- | --- | --- |
| 1 | BM25 | 14.1590 | 1121_ppt.json p.22 | 2024-11-21 | In the first nine months of 2024, Lotus achieved a 105% year-on-year increase in topline growth, attributed to growing deliveries. Sales of goods reached $624 million, reflecting a 104% year-on-year increase. Service revenues also surged by 129% year-on-yea... |
| 2 | FAISS | 0.7709 | 1121_ppt.json p.41 | 2024-11-21 | For the nine months ended September 30, 2024, Lotus reported a revenue of $652,823,000, a significant increase from $317,941,000 for the same period in 2023. The cost of revenues rose to $593,708,000 from $284,193,000, resulting in a gross profit of $59,115... |
| 3 | FAISS | 0.6587 | 0919_final.json p.164 | 2024-09-19 | Research and development expenses. Lotus Technology's research and development expenses increased by US$22.3 million from US$152.5 million for the six months ended June 30, 2023, to US$174.9 million for the six months ended June 30, 2024, primarily due to t... |
| 4 | FAISS | 0.7262 | 1121_ppt.json p.43 | 2024-11-21 | In the nine months ending September 30, 2024, Lotus reported a net loss of $666,520,000, an increase from the $526,524,000 reported in the same period in 2023. The adjusted net loss, which accounts for share-based compensation expenses, was $632,955,000 for... |
| 5 | FAISS | 0.7524 | 20240112_final.json p.54 | 2024-01-12 | The following sets forth the unaudited condensed consolidated financial statements of Lotus Technology as of and for the nine months ended September 30, 2023. |
| 6 | FAISS | 0.7524 | 20240112_final.json p.58 | 2024-01-12 | Revenues. Lotus Technology had revenues of US$317.9 million in the nine months ended September 30, 2023, representing an increase of 8,594.0% from US$3.7 million in the nine months ended September 30, 2022, primarily due to the commencement of battery elect... |
| 7 | FAISS | 0.7524 | 20240112_final.json p.58 | 2024-01-12 | As a result of the foregoing, Lotus Technology had a net loss of US$526.5 million in the nine months ended September 30, 2023, representing an increase of 43.6% from US$366.6 million in the nine months ended September 30, 2022. Accounts receivable. As of Se... |
| 8 | FAISS | 0.7524 | 20240112_final.json p.58 | 2024-01-12 | As of September 30, 2023, Lotus Technology had accrued expenses and other current liabilities of US$536.9 million, compared with US$506.5 million as of December 31, 2022. The accrued expenses and other current liabilities were primarily related to the acqui... |

## Grep Probe

- Files scanned: 54
- Query terms: Lotus, revenue, nine, months, September, 30, 2024, 2023
- Period terms: nine months ended September 30, 2024, 2023
- Metric aliases: {'revenue': ['revenue', 'revenues', 'total revenue', 'net revenue', 'sales']}

| Type | Text | Source | Confidence | Snippet |
| --- | --- | --- | ---: | --- |
| period_phrase | 2024 | 20250701/final_meta/1121_ppt.json | 0.80 | In the first nine months of 2024, Lotus delivered over 7,600 vehicles, marking a 136% increase compared to the same period in 2023, when 3,221 vehicles were delivered. The third quarter alone saw 2,755 vehicles delive... |
| period_phrase | 2024 | 20250701/final_meta/first_half_final.json | 0.80 | How was Lotus Technology's performance in the first half of the year? Total revenue for the first half of 2024 was $398 million, representing a year-on-year increase of 206%. Lotus Technology's Average Selling Price (... |
| period_phrase | 2024 | 20250701/final_meta/Lotus_424B3_20240529_final.json | 0.80 | This prospectus supplement is being filed to update and supplement the information contained in the prospectus dated May 27, 2024 (as supplemented or amended from time to time, the “Prospectus”), which forms a part of... |
| period_phrase | 2024 | 20250701/final_meta/Lotus_424B3_20240624_final.json | 0.80 | This prospectus supplement is being filed to update and supplement the information contained in the prospectus dated May 27, 2024 (as supplemented or amended from time to time, the “Prospectus”), which forms a part of... |
| metric_alias | revenue | 20250701/final_meta/first_half_final.json | 0.75 | How was Lotus Technology's performance in the first half of the year? Total revenue for the first half of 2024 was $398 million, representing a year-on-year increase of 206%. Lotus Technology's Average Selling Price (... |
| metric_alias | total revenue | 20250701/final_meta/first_half_final.json | 0.75 | How was Lotus Technology's performance in the first half of the year? Total revenue for the first half of 2024 was $398 million, representing a year-on-year increase of 206%. Lotus Technology's Average Selling Price (... |
| metric_alias | revenues | 20250701/final_meta/1121.json | 0.75 | us reached approximately \$130 million for Lotus intelligent driving solutions following earlier agreements with multiple auto conglomerates such as Farizon and a top Japanese tier-one supplier. Financial Highlights f... |
| metric_alias | revenues | 20250701/final_meta/20250422.json | 0.75 | %$ of total deliveries with nearly $90 \%$ YoY growth. In the fourth quarter of 2024, the Company started to deliver Emeya in Malaysia, Thailand, Singapore, UAE and Philippines Deliveries1 by Model Type Financial High... |
| nearby_number | 7,600 | 20250701/final_meta/1121_ppt.json | 0.94 | In the first nine months of 2024, Lotus delivered over 7,600 vehicles, marking a 136% increase compared to the same period in 2023, when 3,221 vehicles were delivered. The third quarter alone saw 2,755 vehicles delive... |
| nearby_number | 136% | 20250701/final_meta/1121_ppt.json | 0.94 | In the first nine months of 2024, Lotus delivered over 7,600 vehicles, marking a 136% increase compared to the same period in 2023, when 3,221 vehicles were delivered. The third quarter alone saw 2,755 vehicles delive... |
| nearby_number | $398 million | 20250701/final_meta/first_half_final.json | 0.94 | How was Lotus Technology's performance in the first half of the year? Total revenue for the first half of 2024 was $398 million, representing a year-on-year increase of 206%. Lotus Technology's Average Selling Price (... |
| nearby_number | 3,221 | 20250701/final_meta/1121_ppt.json | 0.94 | In the first nine months of 2024, Lotus delivered over 7,600 vehicles, marking a 136% increase compared to the same period in 2023, when 3,221 vehicles were delivered. The third quarter alone saw 2,755 vehicles delive... |

## Skill Traces

- No skill trace fields were detected in this row.
