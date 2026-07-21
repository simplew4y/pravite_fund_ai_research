---
title: "{{title}} v{{version_no}}"
tags:
  - private-fund
  - managed
  - valuation-version
entity_type: valuation-version
entity_id: "{{model_version_id}}"
dataset_id: "{{dataset_id}}"
valuation_series_id: "{{series_id}}"
model_version_id: "{{model_version_id}}"
version_no: {{version_no}}
decision_status: "{{decision_status}}"
evidence_coverage: "{{evidence_coverage}}"
quarantined_node_count: {{quarantined_node_count}}
parent_model_version_id: "{{parent_model_version_id}}"
reverted_to_version_id: "{{reverted_to_version_id}}"
valuation_date: "{{valuation_date}}"
version_state: immutable
managed_by: omnigent
---

# 📝 {{title}} v{{version_no}}

<!-- AUTO:BEGIN -->

> [!warning] {{decision_status}}
> {{evidence_coverage}}；低质量节点已从正文隔离。

## 核心输出

{{outputs}}

## 关键假设

{{assumptions}}

## 经营预测

{{forecasts}}

> [!abstract]- 公式审计

{{formulas}}

<!-- AUTO:END -->

<!-- USER:BEGIN -->

## 版本复核

<!-- USER:END -->
