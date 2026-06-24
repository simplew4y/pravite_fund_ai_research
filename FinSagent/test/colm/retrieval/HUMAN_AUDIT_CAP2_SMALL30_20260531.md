# Human Audit: Cap2 Small30

Scope:

```text
Run:
test/colm/retrieval/subquery_cap2_small30_20260530/small30_coverage_repaired_v1.json

Validation:
test/colm/retrieval/subquery_cap2_small30_20260530/standard_validation_coverage_v1_judge/validation_summary.json

Sample size: 20 / 30
Auditor: Codex manual review against GT answer and key points
Purpose: sanity-check correctness beyond same-pipeline judge
```

Summary:

```text
Manual PASS: 20
Manual PARTIAL: 0
Manual FAIL: 0

Notes:
- Numeric/table questions match the required figures and units.
- Business-structure and governance questions cover the required entities and consequences.
- Some answers include extra context beyond the GT, but the audited extra context does not contradict the GT.
- This is a manual confidence check, not a replacement for a truly independent LLM judge.
```

Audited rows:

| index | qid | topic | manual verdict | note |
| --- | --- | --- | --- | --- |
| 1 | qa_kp_1 | China sales network | PASS | Covers 467 centers and the four store/service formats. |
| 3 | qa_kp_3 | VIE / holding company | PASS | Correctly says Cayman holding-company structure and no explicit VIE disclosure. |
| 6 | qa_kp_6 | Autonomous-driving partnerships | PASS | Covers Waymo, Qualcomm, NVIDIA DRIVE AGX Thor, and Mobileye. |
| 7 | qa_kp_7 | Geely privatization rationale | PASS | Covers integration, strategy, competitiveness, flexibility, short-term pressure, and Lynk/Geely synergy. |
| 8 | qa_kp_8 | Non-vehicle-sale services | PASS | Covers Carefree, Power Delivery, subscriptions, CPO/certification, financing, and lifecycle services. |
| 54 | qa_kp_54 | 2024 quarterly deliveries | PASS | Q1/Q2/Q3/Q4 values match: 33,059 / 54,811 / 55,003 / 79,250. |
| 58 | qa_kp_58 | Based / listing context | PASS | Covers Zhejiang, Hangzhou/Ningbo, Cayman incorporation, HK listing, and US ADS trading. |
| 62 | qa_kp_62 | Global sales network | PASS | Covers 538 global sites, 467 China, 71 overseas, DTC/direct model, and RMB 1.7154B capex. |
| 68 | qa_kp_68 | Holding structure | PASS | Covers Cayman parent, HK intermediary, PRC/Swedish operations, Lynk stake, Geely control, and privatization agreement. |
| 76 | qa_kp_76 | 2024 annual deliveries | PASS | Covers 222,123 deliveries and 87% YoY growth. |
| 83 | qa_kp_83 | 2024 Q4 deliveries | PASS | Covers 79,250 and 9.8% YoY growth. |
| 89 | qa_kp_89 | 2024 Q2 gross margin | PASS | Covers 17.2%, 2023 Q2 12.3%, 2024 Q1 11.8%, and cause context. |
| 99 | qa_kp_99 | 2023 Q4 gross margin | PASS | Covers 14%. |
| 107 | qa_kp_107 | 2022 BEV demand environment | PASS | Covers limited COVID disruption, BEV recovery/growth, 5.4M sales, and 81.6% growth; extra context is acceptable. |
| 110 | qa_kp_110 | 2022 net loss despite gross profit | PASS | Covers R&D, SG&A, total operating expenses, loss from operations, and net loss widening. |
| 113 | qa_kp_113 | June 2023 working capital strain | PASS | Covers current assets, current liabilities, and RMB 6,657,807 thousand shortfall. |
| 118 | qa_kp_118 | Pro forma capitalization change | PASS | Covers total capitalization improvement, paid-in capital increase, and unchanged accumulated deficit. |
| 125 | qa_kp_125 | 2023 net loss despite gross profit | PASS | Covers gross profit increase, R&D, SG&A, total operating expenses, and net loss widening. |
| 133 | qa_kp_133 | Controlled company | PASS | Covers Geely 55.3% voting power and the NYSE governance exemptions; notes FPI exemption context. |
| 136 | qa_kp_136 | Cost-of-revenues concentration | PASS | Covers vehicle-sales cost share rising to 64.3%, 2021 mix, and concentration interpretation. |

Decision:

```text
The manual audit is strong enough for a progress report:
- cap2 small30 keeps the same internal-judge result: 30/30 CORRECT
- numeric gate remains clean: ALLOW 30
- manual sample: 20/20 PASS
- independent GPT judge is still blocked by OpenAI API connection errors on this server

Next confidence step should be either:
1. run independent judge from a network path that can reach OpenAI; or
2. do another manual audit on a holdout/new test set, not the same small30.
```
