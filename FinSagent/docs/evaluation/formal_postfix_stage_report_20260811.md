# FinSagent RAG 修复与 Skill Combo 阶段报告（2026-08-11）

## 结论

- 当前开发分支：`RAG`。
- `ygdy_data` 与 `ygdy_report_skill_lab` 的 Chroma/table/title/BM25 已完成重建，六次严格预检全部通过，可以继续正式评测。
- 修复后的 C0（无 Skills、evidence fusion）36 指标覆盖集：`70/72` 题通过，`34/36` 指标两题全通过，公司/doc_id 越界率 `0%`。
- C2 prompt-only 初版的 10 个代表题为 `8/10`，且多项配置 Skill 未实际生效，不能将波动归因于 Skill。
- C2 active + `financial_formula_verifier` 的 6 个公式代表题为 `6/6`，公式 Skill 触发率 `6/6`，修正了 FCF、Trailing PE 和总市值/单位换算。

## 1. 根因

### RAG 索引失效

标准数据路径中的 Chroma 集合为空且 BM25 文件缺失。旧“融合”运行虽然名称为 evidence fusion，实际主要由 DCI 支撑，因此不能代表真实 RAG。

### 财务指标漏召回

`metric_facts` 检索只对 `metric_name` 做中文原词 LIKE，缺少中英文别名、模型字段别名和比较期推导。现金、存货、经营现金流、CAPEX、总股本等中文问题无法稳定命中英文 Excel 行；同比、ROE 又缺少上年操作数。

### Skill 配置启用但不生效

评测 runner 将所有 Combo 强制为 `prompt_active`。该模式只注入 prompt Skill，不应用 post-answer built-in 修复；因此 `table_evidence_verifier` 等即使出现在 allowlist，也只能留轨迹，不能改变答案。财务数值 Skill 的关键词还遗漏 PE、PB、EPS、BVPS、股本和市值。

### 裸模型算术与口径不稳定

C0 曾输出 `110.94 / 0.9609 = 25.8x`，并将 `230,002 CNYm` 错换为 `230.00亿元`；FCF 还会优先采用模型 DCF 三项调整口径，而不是正式指标定义 `CF_OP_IND - abs(CAPEX_IND)`。

## 2. 修改文件与关键位置

- `data_pipeline/rebuild_private_fund_indexes.py`：从 canonical SQLite 原子重建 Chroma/table/title/BM25，写 manifest，并支持回滚。
- `src/utils/cascade_retriever.py`：正式指标中英文字段映射、`metric_alias` 查询、年度/季度比较期推导、canonical operand 排序、公式与单元格透传。
- `src/retrieval_control/evidence_fusion.py`：表格优先、精确财务行 rescue、caption fallback。
- `src/core/RAG.py`：财务行标签加权与表格候选保护。
- `src/agents/shared.py`：请求 doc_id 边界与 RAG 非空成功判定。
- `evaluation/e2e/run_e2e.py`：每题注入 `allowed_doc_ids`；Skill execution mode 改为由 Combo 显式声明。
- `evaluation/e2e/skill_combos.yaml`：C2 改为 `active`，加入 `financial_formula_verifier`。
- `skills/finance/financial-numeric-synthesis/manifest.yaml`：补齐 PE/PB/EPS/BVPS/股本/市值触发词。
- `skills/finance/financial-formula-verifier/`：新增 fail-closed 确定性公式 Skill。
- `src/utils/financial_formula_repair.py`：从同公司、同期间 metric facts 计算 FCF/PE/PB/市值；操作数不全则不修改答案。
- `src/skills_runtime/legacy_adapters.py`：接入 `financial_formula_verifier` built-in handler。
- `configs/skill_cards/financial_formula_verifier.yaml`：治理镜像卡。
- 回归测试：`test/retrieval_control/` 与 `test/skills_runtime/`，当前 `69 passed`。

## 3. collection/BM25 修复前后

| 数据集 | 修复前 | 修复后 |
|---|---|---|
| `ygdy_data` | 标准路径 Chroma 空、BM25 缺失 | main 1333；table 1215；title 3；BM25 1333；manifest ready |
| `ygdy_report_skill_lab` | 标准路径 Chroma 空、BM25 缺失 | main 83；table 71；title 6；BM25 83；manifest ready |

两套 manifest 的 source fingerprint 均与 canonical SQLite 匹配。

## 4. 六次预检原始输出

根目录：

`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/rag_rebuild_preflight_fusion_20260810`

原始 JSON：

1. `raw_outputs/evidence_fusion/C0/ygdy_data/PREFLIGHT_01_YGDY_TEXT.json`
2. `raw_outputs/evidence_fusion/C0/ygdy_data/PREFLIGHT_02_YGDY_ANNUAL_TABLE.json`
3. `raw_outputs/evidence_fusion/C0/ygdy_data/PREFLIGHT_03_YGDY_QUARTER_TABLE.json`
4. `raw_outputs/evidence_fusion/C0/ygdy_report_skill_lab/PREFLIGHT_04_LAB_VERSION_TEXT.json`
5. `raw_outputs/evidence_fusion/C0/ygdy_report_skill_lab/PREFLIGHT_05_LAB_FORECAST_TABLE.json`
6. `raw_outputs/evidence_fusion/C0/ygdy_report_skill_lab/PREFLIGHT_06_LAB_SENSITIVITY_TABLE.json`

六题均满足：`rag_executed=true`、`rag_succeeded=true`、RAG chunks 非空、source_doc_id 未越界。

## 5. 正式结果与可展示原话

### C0 无 Skills 融合基线

目录：

`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c0_fusion_20260810`

结果：`70/72`，仅 CF3 2026E 和 V2 首次裸算术失败；P50 约 19.81 秒，单题最大 146.62 秒（该 run 的汇总含修复前首轮时延记录）。

失败原话示例：

- FCF 2026E：将 `16,561.24 + (-2,931.41) + (-1,325.35)` 的 DCF 调整口径作为主答案 `12,304.47 CNYm`，未遵循正式二操作数口径。
- Trailing PE：曾将 `110.94 / 0.9609008955` 算成 `25.8倍`。

### C2 prompt-only 失效对照

目录：

`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c2_financial_closure_20260811`

结果：`8/10`。轨迹证明部分 Skills 未触发，post-answer built-ins 也未被应用，因此只能作为修复前 Combo 对照。

### C2 active 公式闭环

目录：

`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/formal_postfix_c2_active_formula_20260811`

结果：`6/6`，P50 `32.685s`，最大 `40.095s`。六题均触发 `financial_formula_verifier`。

修复后原话示例：

- `按正式评测口径，自由现金流 = 经营活动现金流 - 资本开支绝对值。2026E经营活动现金流为16,561.24 CNYm，资本开支绝对值为2,931.41 CNYm，因此自由现金流为13,629.83 CNYm。`
- `Trailing PE = 当前价 / EPS = 110.94 / 0.9609008955 = 115.45倍。`
- `总市值 = 股价 × 总股本 = 110.94元/股 × 2,073.211420百万股 = 230,002.07 CNYm，即2,300.02亿元人民币。`

## 6. 是否满足继续 formal_90 的条件

满足。

已满足的前置条件：

- 两套测试数据集索引 ready，BM25 与 Chroma 非空。
- 六次真实 RAG 预检全通过且 doc_id 不越界。
- C0 36 指标覆盖集达到 70/72；剩余裸模型公式风险已由 C2 active 的确定性 Skill 在代表题上 6/6 关闭。
- retrieval/skills 回归 69/69 通过。
- 所有原始 JSON、Markdown、evidence、scorecards 与 Skill traces 均保存于固定结果根目录。

## 7. 剩余非阻断项

- 继续完成 DCI-only、RAG-only、融合三臂同题比较，计算净增益。
- 扩展 C2 active 至其余正式财务题并统计 Skill 触发精确率/召回率。
- 按场景运行 C3/C4/C5/C6/C8/C9/C13 等 Combo，生成完整研报与横向展示案例。
- 完成并发 1/2/4/8 的 P50/P95、吞吐、超时率测试。
- 为引用正确率增加来源单元格/页码级 scorer；当前 formal scorer 主要验证答案原子与 doc_id 边界。
