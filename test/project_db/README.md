# Project DB Tests

负责人：雷雷

本目录用于存放 Project DB / Company Collection / Analyst Space 相关测试。

建议内容：

```text
fixtures/                  DB 初始化样例数据
outputs/                   测试输出快照
test_schema_init.py         schema 初始化测试
test_migrations.py          migration 可重复执行测试
test_traceability.py        citation -> evidence -> document -> location 回溯测试
```

最低验收：

```text
给定 citation_id，可以查回 evidence、document、version 和 original file location。
```

