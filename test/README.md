# Test Workspace

当前阶段各模块单独开发，所有测试、fixture、验证脚本、验证输出样例都放在本目录下的模块子目录中。

目录分工：

```text
test/project_db/        雷雷：Project DB / Company Collection / Analyst Space
test/research_memory/   廖：Research Memory
test/memo_generation/   朝龙：Memo Generation
test/evidence_schema/   程景逸：Evidence Schema / Citation / Provenance
```

每个模块目录可以包含：

```text
fixtures/        测试数据、样例 documents、样例 parsed json
outputs/         测试生成的可检查输出
test_*.py        自动化测试
README.md        模块测试说明
```

提交代码时，README 的“验证方式”必须指向对应测试目录或具体测试文件。

