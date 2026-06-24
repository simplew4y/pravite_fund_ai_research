# Evidence Schema Tests

负责人：程景逸

本目录用于存放 Evidence Schema / Citation / Provenance 相关测试。

建议内容：

```text
fixtures/                       PDF/PPT/Word/Excel/Markdown parsed 样例
outputs/                        evidence 和 citation display 输出快照
test_evidence_normalizer.py      parsed blocks -> unified evidence
test_location_rendering.py       evidence location -> display citation
test_excel_evidence.py           sheet/cell/value/formula 测试
test_citation_traceability.py    citation -> evidence -> location 回溯测试
```

最低验收：

```text
给定 evidence_id，可以定位到原始文件位置；Excel evidence 必须返回 sheet/cell/value/formula。
```

