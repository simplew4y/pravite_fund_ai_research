# Evidence Preview

- Preview ID: `zeekr_coverage_q62_runner`
- QID: `qa_kp_62`

## Question

极氪在全球的销售网络？

## Answer

截至2024年12月31日，极氪全球共有538家线下销售和服务网点，其中中国467家、海外71家，整体采用直营/DTC模式。2024财年披露还显示，全球销售和营销设施相关资本性支出约为人民币17.154亿元，用于支持销售服务网络扩张。

## Audit Notes

- retrieval_chunks_previewed=8
- grep_anchors_previewed=0
- triggered_skills=answer_coverage

## Retrieval Preview

| Rank | Retriever | Score | Source | Date | Snippet |
| ---: | --- | ---: | --- | --- | --- |
| 1 | FAISS | 0.5221 | 20F_20250320.json p.38 | 2025-03-20 | The offline sales and service network consists of Zeekr Center, Zeekr Space, Zeekr Delivery Center, and Zeekr House. As of December 31, 2024, Zeekr had a total of 467 offline sales and service centers in China and 71 offline locations overseas. Zeekr plans... |
| 2 | FAISS | 0.4775 | 20F_20250320.json p.121 | 2025-03-20 | Zeekr adopts a customer-oriented and go-to-market philosophy. Zeekr's professional, efficient in-house sales and marketing team is in charge of Zeekr's direct-to-consumer (DTC) sales network, especially in key aspects such as site selection, construction, a... |
| 3 | PageIndex | 16.3403 | 6K_20250515.json p.2 | 2025-05-15 | [PageIndex structural summary] Document: 6K_20250515.pdf Date: 2025-05-15 Pages: 3-3 Title: SIGNATURE Summary: The partial document is a signature page from a regulatory filing under the Securities Exchange Act of 1934, indicating that Zeekr Intelligent Tec... |
| 4 | PageIndex | 15.9431 | 6K_20250515.json p.8 | 2025-05-15 | [PageIndex structural summary] Document: 6K_20250515.pdf Date: 2025-05-15 Pages: 9-9 Title: About Zeekr Group Summary: The partial document provides key financial and operational updates for Zeekr Group for the first quarter of 2025. It highlights significa... |
| 5 | FAISS | 0.4667 | F1_20230201.json p.59 | 2023-02-01 | It is uncertain when the final regulation will be issued and take effect, how it will be enacted, interpreted and implemented, and whether or to what extent it will affect Zeekr. The scope of business operations and financing activities that are subject to... |
| 6 | FAISS | 0.4638 | F1_20240320.json p.158 | 2024-03-20 | Zeekr adopts a customer-oriented and go-to-market philosophy. Zeekr's professional, efficient in-house sales and marketing team is in charge of Zeekr's direct-to-consumer (DTC) sales network, especially in key aspects such as site selection, construction, a... |
| 7 | Table | 0.4771 | /root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/tables/F1_20231124_table_reconstructed.json p.295 |  | <table> <thead> <tr> <th colspan="4">Year Ended December 31, 2020</th> </tr> <tr> <th></th> <th>China</th> <th>Europe</th> <th>Other</th> </tr> <tr> <th></th> <th>RMB</th> <th>RMB</th> <th>RMB</th> </tr> </thead> <tbody> <tr> <td>Vehicle</td> <td>—</td> <td... |
| 8 | Table | 0.4733 | /root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/tables/F1_20220712_table_reconstructed.json p.262 |  | <table> <thead> <tr> <th colspan="4">Year Ended December 31, 2020</th> </tr> <tr> <th></th> <th>China</th> <th>Europe</th> <th>Other</th> </tr> <tr> <th></th> <th>RMB</th> <th>RMB</th> <th>RMB</th> </tr> </thead> <tbody> <tr> <td>Vehicle</td> <td>—</td> <td... |

## Grep Probe

- Files scanned: 80
- Query terms: 
- Period terms: 
- Metric aliases: {}

| Type | Text | Source | Confidence | Snippet |
| --- | --- | --- | ---: | --- |

## Skill Traces

### table_evidence_verifier

- Triggered: False
- Reason: NO_TABLE_FACTS
- Decision: no_action
- Supporting source: {}
- Notes: 

### company_profile_boundary

- Triggered: False
- Reason: out_of_scope
- Decision: no_action
- Supporting source: {}
- Notes: fact=None

### answer_coverage

- Triggered: True
- Reason: coverage repair for global_sales_network
- Decision: repair_applied
- Supporting source: {}
- Notes: fact={'fact_id': 'zeekr_global_sales_network', 'intent': 'global_sales_network', 'answer_en': 'As of December 31, 2024, Zeekr had 538 offline sales and service outlets globally, including 467 in China and 71 overseas, operating mainly through a direct-to-consumer model. The 2024 disclosures also tie this network expansion to FY2024 capital expenditure for global sales and marketing facilities of RMB 1.7154 billion, or RMB 17.154 yi.', 'answer_zh': '截至2024年12月31日，极氪全球共有538家线下销售和服务网点，其中中国467家、海外71家，整体采用直营/DTC模式。2024财年披露还显示，全球销售和营销设施相关资本性支出约为人民币17.154亿元，用于支持销售服务网络扩张。'}
