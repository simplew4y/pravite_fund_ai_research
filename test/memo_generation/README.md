# Memo Generation Tests

负责人：朝龙

本目录用于存放 Memo Generation 相关测试。

建议内容：

```text
fixtures/                     evidence pack、historical memory、expected sections
outputs/                      生成的 memo.md 和 citation gate 报告
test_evidence_pack.py          evidence pack 构建测试
test_section_generation.py     memo section 生成测试
test_citation_gate.py          unsupported claim / needs_review 测试
test_markdown_export.py        memo.md 导出测试
```

最低验收：

```text
输入 company_id，能生成一版带 citation 的 memo.md；无证据核心结论必须标记 needs_review。
```

