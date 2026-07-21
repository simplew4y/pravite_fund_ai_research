---
title: "{{title}}"
aliases: []
tags:
  - private-fund
  - managed
entity_type: research-node
entity_id: "{{node_id}}"
node_type: "{{node_type}}"
dataset_id: "{{dataset_id}}"
company: "{{company}}"
status: "{{status}}"
review_state: "{{review_state}}"
evidence_state: "{{evidence_state}}"
confidence: "{{confidence}}"
parent_node_ids: {{parent_node_ids}}
evidence_ids: {{evidence_ids}}
source_system: omnigent
source_version: "{{version_no}}"
sync_key: "dataset:{{dataset_id}}:research-node:{{node_id}}"
sync_hash: "{{sync_hash}}"
managed_by: omnigent
sensitivity: internal
created_at: "{{created_at}}"
updated_at: "{{updated_at}}"
---

# 📝 模板：投研研究节点

<!-- AUTO:BEGIN -->

## 📝 结论

{{summary}}

## 📝 分析与证据

{{content_markdown}}

## 📝 关系

- 📝 所属项目：[[{{project_note}}]]
- 📝 上游节点：{{parent_node_links}}
- 📝 证据来源：{{evidence_links}}

## 📝 不确定性与下一步

{{uncertainty_and_next_steps}}

<!-- AUTO:END -->

<!-- USER:BEGIN -->

## 📝 研究员批注

> [!note] 📝 手写区
> 本区域由研究员维护，后台同步不得覆盖。

<!-- USER:END -->
