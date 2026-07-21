---
title: "{{title}} v{{from_version_no}} → v{{to_version_no}}"
tags:
  - private-fund
  - managed
  - valuation-change
entity_type: valuation-change
dataset_id: "{{dataset_id}}"
valuation_series_id: "{{series_id}}"
from_model_version_id: "{{from_model_version_id}}"
to_model_version_id: "{{to_model_version_id}}"
change_level: "{{change_level}}"
change_count: {{change_count}}
quarantined_change_count: {{quarantined_change_count}}
change_summary: "{{change_summary}}"
version_state: immutable
managed_by: omnigent
---

# 📝 估值 v{{from_version_no}} → v{{to_version_no}}

<!-- AUTO:BEGIN -->

## 版本结论

{{material_changes}}

## 可解释差异

{{change_table}}

## Agent 解释

{{analysis_link}}

<!-- AUTO:END -->

<!-- USER:BEGIN -->

## 差异复核

<!-- USER:END -->
