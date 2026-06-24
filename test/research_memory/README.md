# Research Memory Tests

负责人：廖

本目录用于存放 Research Memory 相关测试。

建议内容：

```text
fixtures/                  QA messages、content.md、facts/citations 样例
outputs/                   memory 写入和语义召回输出
test_qa_writer.py          QA 后写入 messages.jsonl / content.md / qa_messages
test_fact_citations.py     facts 和 citations 追溯测试
test_audit_trail.py        audit 回放测试
test_semantic_recall.py    历史研究语义召回测试
```

最低验收：

```text
重启系统后，问“之前是否讨论过某问题”，能召回历史 QA、facts 和 citations。
```

