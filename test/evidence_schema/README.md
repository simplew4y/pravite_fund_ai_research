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

## 当前实现（第一阶段）

源码位于仓库根的 `src/evidence_schema/`：

```text
schema.py        Document / DocumentVersion / Evidence / EvidenceLocation / Citation + 枚举
ids.py           稳定且可复现的 evidence_id / citation_id / location_id（含 now_iso）
adapters/base.py adapter 接口 + AdapterContext + _build_evidence
adapters/pdf_adapter.py     PDF parsed blocks -> pdf_page_section evidence
adapters/excel_adapter.py   Excel cells -> excel_cell evidence（保留 sheet/cell/value/formula/upstream）
normalizer.py    校验 doc_id/version_id/type/content/location/可渲染 display
display.py       render_citation_display：按类型渲染人读 citation
repository.py    EvidenceRepository 接口 + InMemoryEvidenceRepository + build_citation
```

实际测试文件：

```text
conftest.py                      把 src/ 加入 sys.path，提供 fixtures
fixtures/pdf_parsed.json         PDF parsed 样例
fixtures/excel_parsed.json       Excel parsed 样例
outputs/citation_display.txt     display 渲染快照（测试生成）
test_evidence_normalizer.py      parsed blocks -> unified evidence + 校验
test_location_rendering.py       7 种类型 location -> display
test_excel_evidence.py           sheet/cell/value/formula/upstream 与 display
test_citation_traceability.py    citation 回溯 + 版本不变性
```

运行方式：

```text
pytest test/evidence_schema/      # 11 passed
```

## 与 Project DB（雷雷）的字段对齐清单

以下为接入 `collection.db` 前需要确认的差异，确认后才把 `repository.py`
的内存实现替换为 SQLite 实现：

```text
1. evidence 是否增加 project_id / collection_id 两列
2. evidence 是否增加 updated_at
3. 位置定位用 paragraph_no 还是 start_offset/end_offset（或都留）
4. evidence_locations 是否增加 bbox_json
5. PPT shape_id 进通用列还是 location_json
6. citations 是否落库 claim / display（display 落库还是运行时渲染）
7. citation 主表归 collection.db 还是 analyst.db.personal_citations
8. evidence_id 统一用确定性 hash（doc_id+version_id+type+location），见 ids.py
9. doc_id / version_id 由谁生成、命名规则、checksum 是否进 version_id
10. JSON 列统一命名为 content_json / metadata_json / location_json
```

