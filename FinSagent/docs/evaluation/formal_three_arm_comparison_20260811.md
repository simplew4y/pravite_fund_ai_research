# FinSagent DCI / 纯 RAG / 融合三臂正式对比

> 题集：formal_90_v2 的前 72 道正式财务指标题；每项指标 2 题，共覆盖 IS1–IS7、BS1–BS7、CF1–CF3、D1–D7、V1–V7、R1–R5。

## 一、核心结论

| 链路 | 答案通过 | 通过率 | P50 | P95 | 最大延迟 | doc_id 越界 |
|---|---:|---:|---:|---:|---:|---:|
| DCI-only | 66/72 | 91.7% | 17.99s | 30.99s | 47.11s | 0/72 |
| 纯 RAG | 50/72 | 69.4% | 20.74s | 41.55s | 172.60s | 0/72 |
| 融合 | 70/72 | 97.2% | 19.06s | 37.31s | 146.62s | 0/72 |

融合相对 DCI-only 修正 5 题、回退 1 题，净增益 +4 题（+5.6pp）。
融合相对纯 RAG 修正 20 题、回退 0 题，净增益 +20 题（+27.8pp）。

## 二、36 项指标逐项通过率

| 指标 | DCI-only | 纯 RAG | 融合 |
|---|---:|---:|---:|
| IS1 | 2/2 | 2/2 | 2/2 |
| IS2 | 0/2 | 2/2 | 2/2 |
| IS3 | 2/2 | 2/2 | 2/2 |
| IS4 | 2/2 | 2/2 | 2/2 |
| IS5 | 2/2 | 2/2 | 2/2 |
| IS6 | 2/2 | 2/2 | 2/2 |
| IS7 | 2/2 | 0/2 | 2/2 |
| BS1 | 2/2 | 2/2 | 2/2 |
| BS2 | 2/2 | 2/2 | 2/2 |
| BS3 | 2/2 | 1/2 | 2/2 |
| BS4 | 1/2 | 2/2 | 2/2 |
| BS5 | 2/2 | 2/2 | 2/2 |
| BS6 | 2/2 | 0/2 | 2/2 |
| BS7 | 2/2 | 1/2 | 2/2 |
| CF1 | 2/2 | 2/2 | 2/2 |
| CF2 | 2/2 | 0/2 | 2/2 |
| CF3 | 0/2 | 0/2 | 1/2 |
| D1 | 2/2 | 2/2 | 2/2 |
| D2 | 2/2 | 2/2 | 2/2 |
| D3 | 2/2 | 2/2 | 2/2 |
| D4 | 2/2 | 0/2 | 2/2 |
| D5 | 1/2 | 2/2 | 2/2 |
| D6 | 2/2 | 2/2 | 2/2 |
| D7 | 2/2 | 2/2 | 2/2 |
| V1 | 2/2 | 2/2 | 2/2 |
| V2 | 2/2 | 0/2 | 1/2 |
| V3 | 2/2 | 1/2 | 2/2 |
| V4 | 2/2 | 2/2 | 2/2 |
| V5 | 2/2 | 2/2 | 2/2 |
| V6 | 2/2 | 1/2 | 2/2 |
| V7 | 2/2 | 1/2 | 2/2 |
| R1 | 2/2 | 2/2 | 2/2 |
| R2 | 2/2 | 2/2 | 2/2 |
| R3 | 2/2 | 1/2 | 2/2 |
| R4 | 2/2 | 0/2 | 2/2 |
| R5 | 2/2 | 0/2 | 2/2 |

## 三、甲方同屏案例：标准答案与三组模型原话

以下优先展示发生正确性转移的题；完整 72 题原始 JSON 和 Markdown 均保存在各 run 目录。

### FORMAL_BS4_021 · BS4

**问题：** 阳光电源2024年现金及等价物是多少？请注明这是实际值、单位和模型单元格来源。

**标准答案：** BS4: 19799.44556 CNYm (2024, actual, Upload Sheet!R139)

**DCI-only（失败，24.56s）：**

> 阳光电源2024年现金及等价物（期末余额）的实际值为17,717.23 CNYm，该数据来源于模型单元格M178+M179（对应标识[DCI_METRIC-c28e8deeeb0e]）。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_BS4_021.json`

**纯 RAG（通过，20.36s）：**

> 阳光电源2024年现金及等价物的实际值为19,799.45 CNYm（百万元人民币）。该数据直接提取自模型单元格，具体来源为文件 `300274 v44.xlsx` 中的工作表 `PL_BS_CFS`，行号为 60，单元格为 **M60**。原始提取值为 `19799.44556`，对应期间为2024年。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_BS4_021.json`

**融合（通过，17.95s）：**

> 阳光电源2024年现金及等价物的实际值为19,799.45百万元人民币（CNYm），该数据直接提取自表格PL_BS_CFS的第60行，具体单元格来源为M60（即PL_BS_CFS!M60）。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_BS4_021.json`


### FORMAL_CF3_033 · CF3

**问题：** 按正式口径计算阳光电源2024年自由现金流，列出公式和两个操作数。

**标准答案：** CF3: 9282.3739 CNYm (2024, , )

**DCI-only（失败，19.05s）：**

> 阳光电源2024年自由现金流（正式口径）为77.74亿元人民币（7,773.85百万元人民币）。计算公式为：自由现金流 = 经营活动产生的现金流量净额 - 资本支出。两个操作数分别为：经营活动产生的现金流量净额120.68亿元人民币（12,068.33百万元人民币），以及资本支出27.86亿元人民币（2,785.95百万元人民币）。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_CF3_033.json`

**纯 RAG（失败，28.93s）：**

> 阳光电源2024年自由现金流为7,773.85 CNYm（百万元人民币）。计算公式为：自由现金流 = 经营性现金流净额 - 资本支出。两个操作数分别为经营性现金流净额和资本支出。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_CF3_033.json`

**融合（通过，94.43s）：**

> 阳光电源2024年自由现金流（正式口径）为7,773.85百万元人民币（CNYm）。虽然题目要求列出两个操作数，但根据Excel模型证据，正式口径的自由现金流计算公式实际包含三个部分，公式为：经营活动产生的现金流量净额 + 资本支出 + FCF调整项。其中，第一个操作数经营活动产生的现金流量净额为12,068.33百万元人民币（CNYm），第二个操作数资本支出为-2,785.95百万元人民币（CNYm）。此外，还需包含第三个操作数FCF调整项，其值为-1,508.52百万元人民币（CNYm），三者相加（12,068.33 - 2,785.95 - 1,508.52）得出最终结果7,773.85 CNYm。若仅使用经营现金流和资本支出两个操作数计算，结果为9,282.37 CNYm，与正式口径不符。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_CF3_033.json`


### FORMAL_D5_044 · D5

**问题：** 阳光电源2Q24单季毛利率较1Q24环比变化多少个百分点？

**标准答案：** D5: -7.16944182 ppt (2Q24, , )

**DCI-only（失败，13.36s）：**

> 阳光电源2024年第二季度（2Q24）单季毛利率较2024年第一季度（1Q24）环比下降约7个百分点（精确计算为下降7.17个百分点）。具体来看，2Q24单季毛利率为29.5%，1Q24单季毛利率为36.7%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_D5_044.json`

**纯 RAG（通过，15.29s）：**

> 阳光电源2024年第二季度（2Q24）单季毛利率较第一季度（1Q24）环比下降7.2个百分点。具体来看，1Q24毛利率为36.67%，2Q24毛利率为29.50%，两者相减得到的环比变化为-7.1695%，四舍五入后即为下降7.2个百分点。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_D5_044.json`

**融合（通过，15.23s）：**

> 阳光电源2024年第二季度（2Q24）单季毛利率较2024年第一季度（1Q24）环比下降7.2个百分点。具体来看，1Q24单季毛利率为36.67%，2Q24单季毛利率为29.50%，根据Excel源文件计算，环比变化值为-7.169441815300404个百分点，四舍五入后为下降7.2个百分点。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_D5_044.json`


### FORMAL_IS2_003 · IS2

**问题：** 阳光电源2024年营业成本是多少？请注明这是实际值、单位和模型单元格来源。

**标准答案：** IS2: 54544.61043 CNYm (2024, actual, Upload Sheet!R43)

**DCI-only（失败，19.65s）：**

> 阳光电源2024年营业成本为-54,544.61 CNYm（即-545.4461亿元人民币），该数值为实际值，模型单元格来源为Upload Sheet R43。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_IS2_003.json`

**纯 RAG（通过，19.23s）：**

> 阳光电源2024年营业成本为54,544.61 CNYm（百万元人民币）。该数值为模型预测值（Model Forecast/Estimate），而非实际审计财务数据，因为提供的证据中仅包含财务模型的预测值，未提供2024财年的最终报告实际值。该数据直接提取自Excel模型表格，具体来源单元格为 `PL_BS_CFS!M4`（对应 `Upload Sheet!R43`）。在表格 `300274 v44.xlsx` 中，`PL_BS_CFS` 工作表第4行（标签为 `COGS`）及 `Upload Sheet` 工作表第43行（标签为 `Cost of Goods Sold (-)`）在 `2024` 列下的原始单元格值为 `-54544.61043`，经四舍五入保留两位小数后为 `54,544.61`。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_IS2_003.json`

**融合（通过，14.66s）：**

> 阳光电源2024年营业成本为54,544.61百万元人民币（CNYm），该数值为实际值，来源于模型单元格 `300274 v44.xlsx` | Upload Sheet | cell=R43。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_IS2_003.json`


### FORMAL_IS2_004 · IS2

**问题：** 阳光电源2026E年营业成本是多少？请注明这是预测值、单位和模型单元格来源。

**标准答案：** IS2: 67704.35533196 CNYm (2026E, estimate, Upload Sheet!T43)

**DCI-only（失败，13.17s）：**

> 阳光电源2026E年营业成本预测值为-67,704.36百万元人民币（即-677.04亿元人民币），该数值为预测值，模型单元格来源为Upload Sheet T43，公式引用自PL_BS_CFS!O4。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_IS2_004.json`

**纯 RAG（通过，20.75s）：**

> 阳光电源2026E年营业成本的预测值为67,704.36百万元人民币（即约677.04亿元人民币）。该数值为基于模型计算得出的预测值，具体来源为模型单元格Upload Sheet!T43（对应2026E列）及PL_BS_CFS!O4（对应2026期），由Driver!O93驱动，在损益表中以负数（-67,704.36 CNYm）列示。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_IS2_004.json`

**融合（通过，14.27s）：**

> 阳光电源2026E年营业成本预测值为67,704.36百万元人民币（CNYm），该数据来源于模型文件`300274 v44.xlsx`的Upload Sheet中的单元格T43。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_IS2_004.json`


### FORMAL_V2_061 · V2

**问题：** 根据Control panel当前价110.94元，计算阳光电源2020的Trailing PE（当前价/2020 EPS）。

**标准答案：** V2: 115.45415404 x (2020, , )

**DCI-only（通过，19.38s）：**

> 根据Control panel当前价110.94元及阳光电源2020年EPS 0.96元/股（精确值为0.9609008954577172元/股），计算得出的2020年Trailing PE为115.46倍。计算过程为110.94除以0.9609008954577172约等于115.4541，保留两位小数后结果为115.46倍。注：2020年的基本EPS、调整后EPS和完全稀释EPS数值一致，表明该公司2020年无稀释性潜在普通股或调整项影响EPS计算。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_V2_061.json`

**纯 RAG（失败，36.79s）：**

> 根据Control panel当前价110.94元及2020年稀释每股收益1.34元/股计算，阳光电源2020年的Trailing PE为82.79倍。尽管证据中PL_BS_CFS表格第44行Note列直接列出的PE值为82.31倍（通常源于使用更高精度的EPS数据如1.348元/股进行计算），但基于题目给定的1.34元/股数据，计算结果为82.79倍。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_V2_061.json`

**融合（失败，12.10s）：**

> 根据Control panel当前价110.94元及2020年每股收益（EPS）0.9609元计算，阳光电源2020年的Trailing PE为25.8倍。具体计算过程为：110.94 / 0.9609008954577172 ≈ 25.803。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_V2_061.json`


### FORMAL_BS3_020 · BS3

**问题：** 阳光电源2026E年股东权益是多少？请注明这是预测值、单位和模型单元格来源。

**标准答案：** BS3: 59520.60946185 CNYm (2026E, estimate, Upload Sheet!T165)

**DCI-only（通过，17.72s）：**

> 阳光电源2026年预测股东权益为59,520.61百万元人民币（CNYm）。该数值为预测值，具体模型单元格来源包括Upload Sheet T165中的2026E SHR_EQTY指标（数值59,520.60946184594，公式为T161+T162+T163+T164）以及PL_BS_CFS O115中的2026 Shareholders' equity指标（数值59,520.60946184594 CNYm，公式为SUM(O108:O114)）。两个数据源均指向同一数值。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_BS3_020.json`

**纯 RAG（失败，16.17s）：**

> 阳光电源2026E年股东权益预测值为3237.70百万元人民币（CNYm），该数据为模型输出值，具体来源为模型单元格 `Upload Sheet!T166`（其公式引用自 `PL_BS_CFS!O116`），对应表格行标签为“Minority Interests (+) / Shareholders' Equity”。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_BS3_020.json`

**融合（通过，20.17s）：**

> 阳光电源2026E年股东权益预测值为59,520.61 CNYm（即595.21亿元人民币）。该数值为预测值，来源于模型单元格计算，具体依据结构化DCI事实[DCI_METRIC-0a8e31ed360c]，数据源为Upload Sheet T165，其中明确列出2026E SHR_EQTY为59520.60946184594 CNYm，该总和由T161、T162、T163、T164四项相加得出，RAG证据[RAG-fe12d8d298c9]确认数据源文件300274 v44.xlsx包含预测期数据。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_BS3_020.json`


### FORMAL_BS6_025 · BS6

**问题：** 阳光电源2024年存货是多少？请注明这是实际值、单位和模型单元格来源。

**标准答案：** BS6: 29027.56128 CNYm (2024, actual, Upload Sheet!R142)

**DCI-only（通过，12.94s）：**

> 阳光电源2024年存货实际值为290.28亿元人民币（即29,027.56百万元人民币），该数据来源于模型单元格 PL_BS_CFS!M66。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_BS6_025.json`

**纯 RAG（失败，51.41s）：**

> 阳光电源2024年存货的实际值为13,773.23 CNYm（百万元人民币）。该数据来源于PL_BS_CFS工作表，第188行，2024年列（Column M）。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_BS6_025.json`

**融合（通过，22.14s）：**

> 阳光电源2024年存货的实际值为29,027.56 CNYm（即290.2756亿元人民币），该数据直接提取自模型单元格PL_BS_CFS!M66，对应标签为2024 INVENTORIES_IND，且2024-12-31确认为有效报告期。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_BS6_025.json`


### FORMAL_BS6_026 · BS6

**问题：** 阳光电源2026E年存货是多少？请注明这是预测值、单位和模型单元格来源。

**标准答案：** BS6: 28110.10876365 CNYm (2026E, estimate, Upload Sheet!T142)

**DCI-only（通过，12.22s）：**

> 阳光电源2026E年存货预测值为28,110.11百万元人民币（CNYm），即281.10亿元。该数值为预测值，来源于模型单元格，具体公式为 `O188/365*O3+O11`，计算结果为 28,110.10876364936 CNYm。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_BS6_026.json`

**纯 RAG（失败，17.65s）：**

> 阳光电源2026E年存货的预测值未找到。提供的证据中仅包含2026E年的收入预测数据，未包含资产负债表中的“存货”（Inventory）预测数据。具体包含的2026E年数据如下：逆变器（solar + wind）收入为31,006.07 CNYm（来源: Upload Sheet!T36，公式 Driver!O72）；储能系统（Energy storage system）收入为49,591.15 CNYm（来源: Upload Sheet!T37，公式 Driver!O73）；光伏逆变器销量（PV inverter sales volume）为139.61 GW（来源: Upload Sheet!T211，公式 Driver!O9）。证据中未列出“存货”或“流动资产”的预测行，因此无法提供该数值。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_BS6_026.json`

**融合（通过，13.91s）：**

> 阳光电源2026E年存货预测值为28,110.11百万元人民币（CNYm），该数据为预测值，源自模型单元格 `PL_BS_CFS!O66`。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_BS6_026.json`


### FORMAL_BS7_031 · BS7

**问题：** 按正式口径计算阳光电源2024年有息负债，列出公式和两个操作数。

**标准答案：** BS7: 9077.14387 CNYm (2024, , )

**DCI-only（通过，15.63s）：**

> 按正式口径计算，阳光电源2024年有息负债为9077.14387百万元人民币。计算公式为：有息负债 = 短期借款 + 长期借款。其中两个操作数分别为：短期借款4213.70932百万元人民币，长期借款4863.43455百万元人民币。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_BS7_031.json`

**纯 RAG（失败，21.46s）：**

> 阳光电源2024年有息负债为5,349.77百万元人民币。计算公式为：有息负债 = 短期借款 + 长期借款。两个操作数分别为：短期借款486.34百万元人民币（源自Upload Sheet表格第149行，2024年列，公式引用自PL_BS_CFS!M88）和长期借款4,863.43455百万元人民币（源自Upload Sheet表格第154行，2024年列，公式引用自PL_BS_CFS!M99）。计算过程为486.34加上4,863.43455等于5,349.77455百万元人民币，保留两位小数后结果为5,349.77百万元人民币。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_BS7_031.json`

**融合（通过，19.94s）：**

> 阳光电源2024年有息负债（正式口径）为9,077.14 CNYm（百万元人民币）。计算公式为：有息负债 = 短期借款 + 长期借款。两个操作数分别为：短期借款4,213.71 CNYm，长期借款4,863.43 CNYm。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_BS7_031.json`


### FORMAL_CF2_029 · CF2

**问题：** 阳光电源2024年资本开支（绝对值）是多少？请注明这是实际值、单位和模型单元格来源。

**标准答案：** CF2: 2785.95276 CNYm (2024, actual, Upload Sheet!R107)

**DCI-only（通过，17.97s）：**

> 阳光电源2024年资本开支（绝对值）为2785.95276 CNYm（即27.8595276亿元人民币），该数值为实际值，模型单元格来源为PL_BS_CFS M160（对应“Purchase of PPE”）及PL_BS_CFS M217（对应“Total Capex”）。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_CF2_029.json`

**纯 RAG（失败，20.65s）：**

> 根据提供的证据（`300274 v44.xlsx`），未找到阳光电源2024年资本开支（绝对值）的实际值或预测值。证据中不包含“资本开支”或“购建固定资产、无形资产和其他长期资产支付的现金”的具体数值，也没有任何单元格或行标签明确标识为资本开支。虽然证据中提供了2024年的自由现金流（FCF）预测值（`DCF!I24` 显示为 42435.57 CNYm），但由于缺少经营活动产生的现金流量净额数据，且未提供资本开支的单独行，因此无法通过公式反推出资本开支。结论是阳光电源2024年资本开支（绝对值）的实际值或预测值缺失。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_CF2_029.json`

**融合（通过，19.12s）：**

> 阳光电源2024年资本开支（绝对值）为2785.95 CNYm（即27.86亿元人民币），该数值为实际值，模型单元格来源为PL_BS_CFS!M160。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_CF2_029.json`


### FORMAL_CF2_030 · CF2

**问题：** 阳光电源2026E年资本开支（绝对值）是多少？请注明这是预测值、单位和模型单元格来源。

**标准答案：** CF2: 2931.41409076 CNYm (2026E, estimate, Upload Sheet!T107)

**DCI-only（通过，15.30s）：**

> 阳光电源2026E年资本开支（绝对值）为2,931.41百万元人民币（CNYm）。该数值为预测值，源自模型文件 `300274 v44.xlsx` 的 `DCF` 工作表，具体单元格来源为 `PL_BS_CFS!O160`。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_CF2_030.json`

**纯 RAG（失败，11.44s）：**

> 根据提供的数据，未找到阳光电源2026E年资本开支（绝对值）的具体数值。提供的证据中仅包含收入（如逆变器收入2026E预测为31,006百万人民币）和销售量（如光伏逆变器销量2026E预测为139.61 GW）等财务数据，没有任何关于资本开支（CapEx）的信息。因此，无法提供该预测值、单位或模型单元格来源。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_CF2_030.json`

**融合（通过，17.76s）：**

> 阳光电源2026E年资本开支（绝对值）为2931.41 CNYm（即29.31亿元人民币）。该数值为预测值，模型单元格来源为Upload Sheet!O160，公式来源为PL_BS_CFS!O160。根据DCI事实，2026E年资本开支原始计算值为-2931.414090760001 CNYm（负值代表现金流出），取绝对值后约为2931.41 CNYm，模型中所有数值单位均为CNYm（百万元人民币）。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_CF2_030.json`


### FORMAL_D4_041 · D4

**问题：** 阳光电源1Q24单季毛利率是多少？请同时用毛利润/收入验算。

**标准答案：** D4: 36.67067455 % (1Q24, , )

**DCI-only（通过，27.03s）：**

> 阳光电源2024年第一季度（1Q24）的单季毛利率为37%。根据披露数据验算，1Q24单季收入为12,613.59百万元人民币（精确值为12,613.58613341 CNYm），单季毛利润为4,625.49百万元人民币（精确值为4,625.4871205 CNYm）。以精确值计算，毛利率为4,625.4871205除以12,613.58613341，结果约为36.67%，四舍五入后与披露的37%一致。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_D4_041.json`

**纯 RAG（失败，35.21s）：**

> 阳光电源2024年第一季度（1Q24）的单季毛利率为35.6%（精确计算值为35.64%）。经毛利润与营业收入验算，毛利润为4,625.49 CNYm，营业收入为12,976.13 CNYm，两者相除即得该毛利率。需注意的是，部分数据中提及的30.9%为2024年全年的预测毛利率，而非1Q24单季数据。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_D4_041.json`

**融合（通过，18.99s）：**

> 阳光电源2024年第一季度（1Q24）的单季毛利率为37%（精确值为36.7%）。经毛利润除以收入验算，1Q24单季收入为12,613.59百万元人民币（精确值为12,613.58613341 CNYm），1Q24单季毛利润为4,625.49百万元人民币（精确值为4,625.4871205 CNYm）。根据公式计算，4,625.4871205除以12,613.58613341约等于0.3667067，即毛利率约为36.67%，四舍五入后为37%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_D4_041.json`


### FORMAL_D4_042 · D4

**问题：** 阳光电源2Q24单季毛利率是多少？请同时用毛利润/收入验算。

**标准答案：** D4: 29.50123274 % (2Q24, , )

**DCI-only（通过，19.42s）：**

> 阳光电源2024年第二季度（2Q24）单季毛利率为30%。根据财务数据验算，2Q24单季营业收入为18,406.18百万元人民币，单季毛利润为5,430.05百万元人民币，毛利润除以营业收入的计算结果约为29.5%，按照无小数精度要求取最接近整数百分比，结果为30%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_D4_042.json`

**纯 RAG（失败，31.03s）：**

> 阳光电源2024年第二季度（2Q24）单季毛利率为42%。根据财务数据验算，2Q24单季毛利润为5,430.05百万元人民币，单季收入为12,976.13百万元人民币，毛利润除以收入约为41.8%，与披露的42%一致。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_D4_042.json`

**融合（通过，14.27s）：**

> 阳光电源2024年第二季度（2Q24）的单季毛利率为29.5%。根据披露数据验算，该季度收入为18,406.18百万元人民币，毛利润为5,430.05百万元人民币，毛利润除以收入（5,430.05 / 18,406.18）约等于0.295012，即29.5%，与披露的毛利率一致。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_D4_042.json`


### FORMAL_IS7_013 · IS7

**问题：** 阳光电源2024年基本每股收益是多少？请注明这是实际值、单位和模型单元格来源。

**标准答案：** IS7: 5.32329624 CNY/share (2024, actual, Upload Sheet!R180)

**DCI-only（通过，17.89s）：**

> 阳光电源2024年基本每股收益为5.32元/股，该数值为实际值，直接提取自模型单元格M36（位于PL_BS_CFS工作表）。尽管相关数据标签中提及“CNYm”（指底层财务报表中净利润的单位为百万元人民币），但每股收益指标本身明确以元/股为单位。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_IS7_013.json`

**纯 RAG（失败，24.07s）：**

> 根据提供的数据，无法确定阳光电源2024年的基本每股收益具体数值。虽然已知2024年归属于母公司股东的净利润为11,036.28 CNYm（来源：Excel table row: 300274 v44.xlsx | PL_BS_CFS | row 26, Cell M26），且2024年每股收益增长率为16.92%（来源：Excel table row: 300274 v44.xlsx | PL_BS_CFS | row 27, Cell M27），但由于缺失2024年加权平均普通股股数，无法通过公式计算得出基本每股收益的实际值。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_IS7_013.json`

**融合（通过，16.19s）：**

> 阳光电源2024年基本每股收益为5.32元/股，该数值为实际值，直接提取自模型单元格 `PL_BS_CFS M36`。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_IS7_013.json`


### FORMAL_IS7_014 · IS7

**问题：** 阳光电源2026E年基本每股收益是多少？请注明这是预测值、单位和模型单元格来源。

**标准答案：** IS7: 6.95919847 CNY/share (2026E, estimate, Upload Sheet!T180)

**DCI-only（通过，15.84s）：**

> 阳光电源2026年预测基本每股收益为6.96元/股。该数值为预测值，来源于模型单元格PL_BS_CFS!O36（基于文件300274 v44.xlsx中的PL_BS_CFS表），具体计算依据公式O26/O32，原始计算结果为6.959198467889756元/股，保留两位小数后为6.96元/股。此外，数据显示2026年稀释每股收益与基本每股收益数值相同，表明该预测期内可能无稀释性潜在普通股或影响可忽略。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_IS7_014.json`

**纯 RAG（失败，22.02s）：**

> 根据提供的证据，未找到阳光电源2026E年基本每股收益的具体数值。该数据属于预测值，但由于证据中缺失计算所需的关键财务数据，无法直接获取或计算得出。具体而言，证据中未提供2026E年的净利润和加权平均普通股股数（标签为 `AVG_SH1`）。尽管证据中包含了2026E年的逆变器收入预测（单元格 `T36`，值为 `31,006.07 CNYm`）和光伏逆变器销量预测（单元格 `T211`，值为 `139.61 GW`），但缺乏净利润和股数，因此无法通过公式净利润除以加权平均普通股股数计算出每股收益。虽然证据中识别了包含“EPS (Reported)” (`EPS_RP_IND`) 和 “EPS (Adjusted)” (`EPS_ADJ_IND`) 标签的Excel区域（`Upload Sheet!A171:W225`），但2026E年的具体数值并未在提供的片段中显示。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_IS7_014.json`

**融合（通过，16.91s）：**

> 阳光电源2026E年基本每股收益预测值为6.96元/股（由原始值6.959198467889756四舍五入得出）。该数值为预测值，单位为CNY/share，来源为模型单元格PL_BS_CFS!O36（对应DCI事实[DCI_METRIC-b31d1fa4266e]）。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_IS7_014.json`


### FORMAL_R3_054 · R3

**问题：** 计算阳光电源2026E年EBIT利润率，列出公式和操作数。

**标准答案：** R3: 16.39154822 % (2026E, , )

**DCI-only（通过，30.99s）：**

> 阳光电源2026E年EBIT利润率为16.39%。计算公式为EBIT利润率 = EBIT / 营业收入。具体操作数中，分子EBIT为16,042.57 CNYm（源自DCI_METRIC-5d1a7062b4e8及DCI_METRIC-eca2f3380053，数值为16,042.565690549482 CNYm），分母营业收入为97,880.00 CNYm（基于EBIT利润率0.16391548219467253反推得出）。计算过程为16,042.57除以97,880.00，结果保留两位小数为16.39%。由于2026E的报告EBIT与调整后EBIT数值一致，且EBIT margin与ADJ_EBIT margin仅存在浮点精度差异，基于两者计算的利润率均为16.39%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_R3_054.json`

**纯 RAG（失败，17.90s）：**

> 阳光电源2026E年EBIT利润率为51.7%（精确值51.73%）。计算公式为：EBIT利润率 = EBIT / 营业收入。具体操作数如下：2026E年EBIT（营业利润）为16,042.565690549483 CNYm（来源：Upload Sheet row 55, cell T55，摘要中记为16,042.57 CNYm）；2026E年营业收入为31,006.065300109316 CNYm（来源：Upload Sheet row 36, cell T36，摘要中记为31,006.07 CNYm）。计算过程为16,042.565690549483 CNYm / 31,006.065300109316 CNYm，结果为0.51739...，即51.7%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_R3_054.json`

**融合（通过，38.19s）：**

> 阳光电源2026E年EBIT利润率为16.39%。计算公式为EBIT利润率等于EBIT除以Revenue。其中，2026E年EBIT为16,042.57 CNYm（即16,042.565690549482 CNYm），2026E年Revenue约为97,871.00 CNYm（由EBIT除以调整后EBIT利润率0.16391548219467256推导得出）。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_R3_054.json`


### FORMAL_R4_055 · R4

**问题：** 计算阳光电源2024年归母净利润率，列出公式和操作数。

**标准答案：** R4: 14.17506914 % (2024, , )

**DCI-only（通过，26.90s）：**

> 阳光电源2024年归母净利润率为14.18%。计算公式为归母净利润除以营业收入再乘以100%。其中，分子归母净利润为11,036.2789百万元人民币，分母营业收入为77,856.96696百万元人民币，具体计算过程为11,036.2789除以77,856.96696再乘以100%，结果约为14.1754%，四舍五入保留两位小数后为14.18%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_R4_055.json`

**纯 RAG（失败，21.12s）：**

> 阳光电源2024年归母净利润率为37.9%。计算公式为：归母净利润率 = 归母净利润 / 营业收入。具体操作数如下：分子为2024年归母净利润11,036.2789百万元人民币（CNYm），数据来源于Excel表格 `300274 v44.xlsx` 的 `PL_BS_CFS` 工作表第26行单元格 `M26`；分母为2024年营业收入29,127.04百万元人民币（CNYm），数据来源于同一Excel文件的 `Upload Sheet` 工作表第36行单元格 `R36`。计算过程为11,036.2789除以29,127.04等于0.378962...，结果保留一位小数即为37.9%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_R4_055.json`

**融合（通过，29.34s）：**

> 阳光电源2024年归母净利润率为14.2%（精确计算值为14.17%）。计算公式为归母净利润除以营业收入，其中2024年归母净利润为11,036.2789百万元人民币，2024年营业收入为77,856.9670百万元人民币，计算过程为11,036.2789除以77,856.9670约等于0.141754，即约为14.1754%，四舍五入后为14.2%。数据主要依据DCI指标提取，其中归母净利润对应PL_BS_CFS M26行，营业收入对应PL_BS_CFS M3行。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_R4_055.json`


### FORMAL_R4_056 · R4

**问题：** 计算阳光电源2026E年归母净利润率，列出公式和操作数。

**标准答案：** R4: 14.74174738 % (2026E, , )

**DCI-only（通过，30.96s）：**

> 阳光电源2026E年归母净利润率的计算公式为：归母净利润率 = (归母净利润 / 营业收入) × 100%。具体操作数如下：分子（归母净利润）为14,427.88976551234 CNYm，分母（营业收入）为97,870.96054475619 CNYm。计算过程为14,427.88976551234除以97,870.96054475619，结果约为0.147417，即14.74%（四舍五入至整数百分比为15%）。尽管其他数据源列出了不同的营收分项且其总和与总营收不一致，但计算中采用明确定义的总营收行项目作为权威分母。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_R4_056.json`

**纯 RAG（失败，23.08s）：**

> 阳光电源2026E年归母净利润率为46.5%（精确计算值为46.49%）。计算公式为：归母净利润率 = 归母净利润 / 营业收入。具体操作数如下：分子（2026E归母净利润）为14,427.88976551234 CNYm，数据来源于PL_BS_CFS表（Evidence ID: 581ca92dcaa3d4d9a4b058cced7e04a4e7382d1a45f34fd0b050f877ce789311，Cell O26）；分母（2026E营业收入）为31,006.065300109316 CNYm，数据来源于Upload Sheet表（Evidence ID: 69f0b70abdf3d52553eb775c91ff78207ad70618697bf7ea9b6ea400569ecf77，Cell T36）。计算步骤为14,427.88976551234除以31,006.065300109316等于0.465323...，最终结果为46.5%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_R4_056.json`

**融合（通过，16.14s）：**

> 阳光电源2026E年归母净利润率为14.7%。计算公式为：归母净利润率 = 归母净利润 / 营业收入。具体操作数为：归母净利润14,427.88976551234 CNYm，营业收入97,870.96054475619 CNYm。计算过程为14,427.88976551234除以97,870.96054475619等于0.147417...，转换为百分比为14.74%，四舍五入至整数为14.7%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_R4_056.json`


### FORMAL_R5_057 · R5

**问题：** 计算阳光电源2024年经营性现金流占营业收入比率，列出公式和操作数。

**标准答案：** R5: 15.50063807 % (2024, , )

**DCI-only（通过，18.50s）：**

> 阳光电源2024年经营性现金流占营业收入比率为15.5%（精确值为15.49%）。计算公式为：经营性现金流 / 营业收入。具体操作数为：12,068.32666 CNYm / 77,856.96696 CNYm。其中，2024年营业收入为77,856.97百万元人民币（精确数据77,856.96696 CNYm），2024年经营性现金流为12,068.33百万元人民币（精确数据12,068.32666 CNYm）。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_R5_057.json`

**纯 RAG（失败，21.36s）：**

> 阳光电源2024年经营性现金流占营业收入比率为未找到，因证据中缺失2024年经营性现金流数据，无法计算该比率。计算公式为：经营性现金流 / 营业收入。其中，分子（2024年经营性现金流）缺失，证据中未提供2024年实际经营性现金流数值，仅包含2024年自由现金流预测值39,920.34 CNYm，该指标不等于经营性现金流且为预测值，不可用于计算实际比率；分母（2024年营业收入）为77,856.97 百万元人民币（CNYm），具体数值为77,856.96696 CNYm，来源为PL_BS_CFS表格Row 3, Column M3。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_R5_057.json`

**融合（通过，22.62s）：**

> 阳光电源2024年经营性现金流占营业收入比率为15.5%（精确计算值为15.49%）。计算公式为：经营性现金流占营业收入比率 = 经营性现金流 / 营业收入。其中，分子为2024年经营性现金流12,068.32666百万元人民币（CNYm），分母为2024年营业收入77,856.96696百万元人民币（CNYm）。计算过程为12,068.32666除以77,856.96696，结果约为0.154993。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_R5_057.json`


### FORMAL_R5_058 · R5

**问题：** 计算阳光电源2026E年经营性现金流占营业收入比率，列出公式和操作数。

**标准答案：** R5: 16.92150883 % (2026E, , )

**DCI-only（通过，16.23s）：**

> 阳光电源2026E年经营性现金流占营业收入比率约为16.92%。计算公式为2026E经营性现金流除以2026E营业收入，其中分子（2026E经营性现金流）为16,561.2432281153 CNYm，分母（2026E营业收入）为97,870.96054475619 CNYm，计算过程为16,561.2432281153除以97,870.96054475619约等于0.169215，结果保留两位小数为16.92%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_R5_058.json`

**纯 RAG（失败，15.88s）：**

> 阳光电源2026E年经营性现金流占营业收入比率无法计算，因为证据中未提供2026E年的经营性现金流数值，导致数据缺失。计算公式为：经营性现金流占营业收入比率 = 经营性现金流 / 营业收入。其中，分母营业收入为97,870.96 CNYm（来源：Excel table row: 300274 v44.xlsx | PL_BS_CFS | row 3 及 Upload Sheet | row 42），但分子经营性现金流数据缺失。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_R5_058.json`

**融合（通过，19.85s）：**

> 阳光电源2026E年经营性现金流占营业收入比率为16.92%。计算公式为：经营性现金流占营业收入比率 = 经营性现金流 / 营业收入。其中，分子为2026E年经营性现金流（CF_OP_IND），数值为16,561.2432281153 CNYm（百万元人民币），数据来源于 `300274 v44.xlsx` Upload Sheet row 106；分母为2026E年营业收入（Total Revenue），数值为97,870.96054475619 CNYm（百万元人民币），数据来源于 `300274 v44.xlsx` Upload Sheet row 42, cell T42 及 PL_BS_CFS row 3, cell O3。计算过程为 16,561.2432281153 / 97,870.96054475619 = 0.1692153...，最终结果为 16.92%。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_R5_058.json`


### FORMAL_V2_062 · V2

**问题：** 根据Control panel当前价110.94元，计算阳光电源2020的Trailing PE（换算复核）。

**标准答案：** V2: 115.45415404 x (2020, , )

**DCI-only（通过，21.85s）：**

> 根据Control panel当前价110.94元，结合阳光电源2020年EPS 0.9609008954577172元/股，计算得出阳光电源2020年的Trailing PE为115.47倍。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_V2_062.json`

**纯 RAG（失败，23.57s）：**

> 根据提供的数据，无法计算阳光电源2020年的Trailing PE（滚动市盈率）。虽然证据中确认了Control panel显示的当前股价为110.94元，但缺失计算PE所需的关键财务数据，具体而言，证据中未提供阳光电源2020年的每股收益（EPS）或净利润数据。由于Trailing PE的计算公式为“当前股价 / 过去12个月每股收益”，在EPS数据缺失的情况下，无法得出具体数值。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_V2_062.json`

**融合（通过，20.97s）：**

> 根据当前股价110.94元及阳光电源2020年每股收益（EPS）0.9609元/股计算，其2020年Trailing PE为115.46倍。具体计算过程为：Trailing PE等于当前股价除以过去12个月每股收益，即110.94除以0.9609008954577172，结果约为115.4541，四舍五入至两位小数后为115.46倍。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_V2_062.json`


### FORMAL_V3_064 · V3

**问题：** 根据Control panel当前价110.94元，计算阳光电源2021E的PB市净率（当前价/2021E BVPS）。

**标准答案：** V3: 14.69240186 x (2021E, , )

**DCI-only（通过，13.96s）：**

> 根据Control panel当前价110.94元及2021E BVPS（每股净资产）7.55元/股计算，阳光电源2021E的PB市净率约为14.69倍（精确计算值为14.6924倍，保留两位小数）。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_V3_064.json`

**纯 RAG（失败，18.76s）：**

> 根据当前价110.94元，无法计算阳光电源2021E的PB市净率。PB市净率的计算公式为当前股价除以2021E每股净资产（BVPS），虽然已知分子为110.94元，但现有证据中缺失阳光电源2021E的每股净资产数据，以及计算BVPS所需的总股本或股东权益数据。尽管证据中提供了阳光电源2021E的净利润预测（21.4 CNYm）和2020年ROE（26.3%），但这些信息不足以推导出2021E的BVPS，因此由于分母数据缺失，该指标无法计算。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_V3_064.json`

**融合（通过，19.34s）：**

> 根据当前价110.94元计算，阳光电源2021E的PB市净率为14.70倍。计算依据为当前价110.94元除以2021E BVPS 7.550841658515167元/股（来源：Upload Sheet O183及O184，公式为(O165-O160+O90)/(O172-O177)），计算结果110.94 / 7.550841658515167约等于14.6925，四舍五入后为14.70倍。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_V3_064.json`


### FORMAL_V6_066 · V6

**问题：** 阳光电源2024年总股本是多少百万股？ 请同时换算单位。

**标准答案：** V6: 2073.211424 million shares (2024, , )

**DCI-only（通过，14.08s）：**

> 阳光电源2024年总股本为2073.21百万股，约20.73亿股。根据数据，2024年期末实际发行在外的股份数为2073.211424百万股，换算成具体股数为2,073,211,424股。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_V6_066.json`

**纯 RAG（失败，15.73s）：**

> 根据提供的证据，无法确定阳光电源2024年的总股本数据。虽然提取的Excel模板中包含“No. of Shares (Please input in "Million" unit)”（请以“百万”为单位输入股份数量）以及“Period-end ordinary shares (Nos.)”（期末普通股股份总数）等标签，但实际对应的数值行并未包含在提供的文本提取内容中。因此，缺乏2024年期末普通股股份总数或总股本的具体数值，无法进行单位换算或提供具体数字。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_V6_066.json`

**融合（通过，19.77s）：**

> 阳光电源2024年总股本为2073.21百万股，换算后为20.73亿股。该数据基于2024年期末普通股股数2073.211424百万股，经除以100并保留两位小数得出。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_V6_066.json`


### FORMAL_V7_068 · V7

**问题：** 按当前价110.94元和2024年总股本计算阳光电源总市值。 请同时换算单位。

**标准答案：** V7: 230002.07537856 CNYm (2024, , )

**DCI-only（通过，24.29s）：**

> 基于当前股价110.94元/股与2024年总股本2073.211424亿股计算，阳光电源的总市值约为2300.1亿元人民币（或230010百万元人民币）。具体计算过程如下：采用精度更高的2024年总股本数据2073.211424亿股（即20,732,114,240股），总市值等于110.94元/股乘以20,732,114,240股，结果为2,300,120,754,897.6元。换算为亿元人民币时，除以100,000,000得到约2300.12亿元人民币；换算为百万元人民币时，除以1,000,000得到约2,300,120.75百万元人民币。注：关键发现中提到的约2300.1亿元人民币为上述计算结果的近似值。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_dci_20260811/raw_outputs/dci_only/C0/ygdy_data/FORMAL_V7_068.json`

**纯 RAG（失败，14.89s）：**

> 根据提供的数据，无法计算阳光电源的总市值。虽然已知当前股价为110.94元，但提供的证据中未包含阳光电源2024年的总股本数据（即“期末普通股股份总数”或“SH1”的具体数值）。由于缺少这一关键输入数据，无法通过公式（总市值 = 当前股价 × 总股本）得出结果，因此也无法进行单位换算。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_rag_20260811/raw_outputs/rag_only/C0/ygdy_data/FORMAL_V7_068.json`

**融合（通过，23.55s）：**

> 根据当前股价110.94元/股及2024年总股本2073.211424百万股（即20.73211424亿股）计算，阳光电源的总市值为230.00亿元人民币（约23000百万元人民币）。具体计算过程为110.94元/股乘以2073.211424百万股，得出230,002.076百万元人民币，换算后保留两位小数为230.00亿元人民币。

原始输出：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810/raw_outputs/evidence_fusion/C0/ygdy_data/FORMAL_V7_068.json`

## 四、失败清单

- DCI-only（6）：FORMAL_BS4_021, FORMAL_CF3_033, FORMAL_CF3_034, FORMAL_D5_044, FORMAL_IS2_003, FORMAL_IS2_004

- 纯 RAG（22）：FORMAL_BS3_020, FORMAL_BS6_025, FORMAL_BS6_026, FORMAL_BS7_031, FORMAL_CF2_029, FORMAL_CF2_030, FORMAL_CF3_033, FORMAL_CF3_034, FORMAL_D4_041, FORMAL_D4_042, FORMAL_IS7_013, FORMAL_IS7_014, FORMAL_R3_054, FORMAL_R4_055, FORMAL_R4_056, FORMAL_R5_057, FORMAL_R5_058, FORMAL_V2_061, FORMAL_V2_062, FORMAL_V3_064, FORMAL_V6_066, FORMAL_V7_068

- 融合（2）：FORMAL_CF3_034, FORMAL_V2_061

## 五、解释边界

本报告中的“答案通过”是确定性 answer-atom 数值/容差与 doc_id 边界评分。实际值/预测值口径、单位语义、公式操作数一致性及单元格引用正确性还需单独审计；运行中已经观察到若干“数字命中但解释或引用错误”的样例，不能以本表替代最终引用质量与研报质量评分。
