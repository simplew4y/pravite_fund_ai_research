# 跨公司作用域与金额单位修复报告（2026-08-11）

## 结论

`UX_COMPOSITE_088` 已满足继续正式评测的前置条件：检索作用域只包含 Porsche 文档，DCI 关键指标携带 `EURm`，最终答案明确输出“百万欧元”。相关检索与 Skills 回归为 **79 passed**。

## 1. 根因

### 跨公司污染

`CascadeRetriever.resolve_query_doc_ids()` 直接在整句问题中匹配公司名，把否定约束“不得引用 NVIDIA、Hermès、地平线”中的公司也当成正向目标。因此“仅使用保时捷”被错误解析为 Porsche、NVIDIA、Hermès、Horizon 四家公司共同作用域。

### 单位缺失

Porsche 工作簿的 `metric_facts.unit` 为空，真实单位只存在于 `Financials!C163` 的标题 `P&L in EURm`。第一版向上扫描只读取距离目标行最近的 256 个非空单元格；宽表噪声很多，无法到达该标题，模型只能猜测单位或拒绝给出单位。

## 2. 修改文件与关键代码

- `src/utils/cascade_retriever.py`
  - `_positive_scope_query()`：优先提取“仅/只使用 X 文档（资料/模型/数据）”中的正向公司；移除中文和英文否定从句后再做公司匹配。
  - `resolve_query_doc_ids()`：只在清洗后的正向查询上解析 issuer/doc_id。
  - `_infer_sheet_unit()`：当指标行单位为空时，在同 doc_id、同 sheet、目标行之前直接筛选货币单位标题；支持 EUR/CNY/RMB/USD/HKD 的 `m/mn/million` 写法。
  - `search_metric()`：将推断单位写回 DCI metric chunk 的 metadata 与 `page_content`。
- `test/retrieval_control/test_cascade_retriever_financial_metrics.py`
  - 增加 300 个邻近噪声单元格，验证宽表中仍能从 `P&L in EURm` 推断 `EURm`。
- `test/test_retrieval_scope.py`
  - 验证“仅使用 Porsche，不得引用三个同库公司”只解析 Porsche。
  - 验证真正的 NVIDIA + Horizon 正向比较仍保留两个 issuer。

## 3. 修复前后同题对比

问题：`仅使用保时捷文档回答其2024、2025E、2026E归母净利润；不得引用NVIDIA、Hermès、地平线或其他公司。`

| 阶段 | 检索作用域 | 单位 | 模型主答案 | 延迟 |
|---|---|---|---|---:|
| 修复前 | Porsche + NVIDIA + Hermès + Horizon | 无 | “未找到保时捷；现有证据仅包含 NVIDIA 和 Hermès” | 13.195s |
| scope 修复后 | Porsche only | 猜测 CNYm | 数字正确，但错误猜测“百万元人民币” | 24.881s |
| 禁止猜测后 | Porsche only | 未披露 | 数字正确，明确不猜单位 | 19.108s |
| 单位推断 v2 | Porsche only | EURm | 2024=3596.0、2025E=1627.06095、2026E=2562.23332 百万欧元 | 26.536s |

唯一允许的 source_doc_id：`e24f16bdb6bfcaab85a9ac74b362b5b6b3b1b783`。

## 4. 原始输出路径

- 修复前：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/cross_company_c4_ux_20260811/`
- scope 修复后：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/cross_company_c4_postscope_20260811/`
- 禁止单位猜测后：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/cross_company_c4_postunit_20260811/`
- 单位推断最终验证：`/root/autodl-tmp/dir_lzx/finsagent_e2e_eval_outputs/runs/cross_company_c4_postunit_v2_20260811/`

每个目录均保存 `raw_outputs/`、`evidence/`、`config/`、`manifest.json` 和 `scorecards/`（若 runner 完成评分）。

## 5. 回归结果与继续条件

- 回归：`79 passed, 5 warnings`。
- 跨公司边界：通过；最终检索 scope 仅 Porsche。
- 数值：通过；三期数值均来自 `thereof profit attributable to shareholders`。
- 单位：通过；DCI chunk 与最终答案均为 `EURm/百万欧元`。
- 是否满足继续 formal_90：**满足该项阻断解除后的继续条件**。

## 6. 剩余非阻断项

- 最终答案保留了过多小数位；属于展示格式问题，不影响数值与单位正确性。
- 现有 smoke scorer 对四舍五入及主结论识别较弱，应把“机器 atom 命中”和“主答案人工审计”分开报告。
- formal_90 的剩余复合题、拒答题、研报题和并发 1/2/4/8 尚需继续执行，不能因本案例通过而宣称整套正式评测完成。
