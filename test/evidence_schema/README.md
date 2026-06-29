# Evidence Schema Tests

负责人：程景逸

本目录用于存放 Evidence Schema / Citation / Provenance 相关测试。

## 未确认接口与假设（ASSUMPTIONS）

当前 parser / DB / Research Memory / Memo 接口都**尚未最终确认**。Evidence Schema
先做成可替换、可兼容、可测试的中间层；以下假设一旦被推翻，只需改 adapter 局部
（字段 alias）或 AdapterContext，不影响下游。

### 已对齐（RESOLVED — 经 `lzx_memo` 分支真实代码核对）

通过只读核对廖的 `lzx_memo` 分支（`FinSagent/src/core/ResearchMemory.py`，Research
Memory 模块），以下假设已被其真实 SQLite DDL 证实，不再是开放问题：

- **QA adapter schema 正确**：`qa_messages` 列
  （`message_id / session_id / role / content / citation_ids / metadata_json / created_at`）
  与 adapter 假设逐字一致，`role` 还带 `CHECK IN (user/assistant/system/tool)`。
- **citations 表含 `claim / quote / reason / display` 四列**：memo / gate 需要的字段
  在 Research Memory 侧全部落库，无需我方额外存储。
- **`citations.evidence_id` 直接对接我方 evidence_id**：该列就是留给 Evidence Schema
  的 `evidence_id` 复用入口（fact ↔ citation ↔ evidence 链路成立）。
- **citation 落 Research Memory / analyst 侧 SQLite**：citations 表位于 RM 的 SQLite，
  此前"collection.db 还是 analyst.db"之争已确定为 analyst 侧。

### 新发现的非阻塞差异（与 `lzx_memo` 现状的差别，待后续收敛）

- **fact↔citation 当前为 `facts.primary_citation_id` 单列（1:1）**，而非我方设想的
  `fact_citations` 多对多结表；后续若需多引用再收敛，不影响当前中间层。
- **citations 反范式保存 `page / table_id / cell_ref / doc_type`**：廖侧直接挂在
  citation 上，没有独立 `evidence_locations` 表。
- **`citations.evidence_id` 目前是占位**：`record_turn` 里被填成 `evidence_text`，
  真正的 evidence_id 接入是后续的集成缝。
- **`evidence_text` ≈ 我方的 `quote` / evidence content**：语义对应，对接时按此映射。

- **parser 归属**：是否由廖提供 `parsed_blocks`（文件→blocks 这步谁做）未确认。
  adapter 入口按"接收 parsed_blocks"设计。
- **字段名未定（已用 alias 兼容）**：adapter 通过 `pick()` 读多个别名，不写死上游字段：
  - PDF：`page` / `page_no` / `page_index`；`paragraph` / `paragraph_no`；`bbox` / `bbox_json`
  - PPT：`slide` / `slide_no`；`shape` / `shape_id`；`note` / `notes`
  - Word：`heading` / `heading_path` / `headings`；`paragraph` / `paragraph_no`；`label` / `labels`
  - Excel：`file` / `file_name`；`sheet` / `sheet_name`；`range` / `cell_range`；`cell`/`value`/`formula`
  - Markdown：`heading`；`frontmatter` / `front_matter`；`tag` / `tags`；`wikilinks` / `wiki_links` / `links`
  - QA：`session` / `session_id`；`msg_id` / `message_id` / `id`；`content` / `text` / `body`；`metadata` / `metadata_json`
  - Memo：`memo` / `memo_id`；`section` / `section_id`；`title` / `heading`
  - 通用：`text` / `content`；`file` / `file_name`
- **Excel 证据动态生成**：canonical 字段为 `file/sheet/range/cell/value/formula`；
  `upstream_cells` / `number_format` 为 optional metadata，**绝不必填**。
- **身份与表结构未定**：`doc_id` / `version_id` / `evidence_id` 生成规则与我方
  `evidence / evidence_locations` 表结构仍未确认。当前只用 `AdapterContext`
  注入身份 + 内存 mock，**不做真实 DB migration**。（citation 落 analyst 侧已确认，
  见上"已对齐"。）
- **QA parsed blocks 来源/结构**：已对齐——`qa_messages` 行结构经 `lzx_memo` 核对，
  `citation_ids` 为顶层列（adapter 已识别顶层 + 兼容 `metadata_json.citation_ids`）。
  QA 证据通常无 `file_name`，靠 `location_json` 里的 `session_id` 追溯。
- **Memo parsed blocks 来源/结构**：`memo_sections` 行结构（`memo_id/section_id/heading/content`）
  按 memo_generation 设计假设；朝龙侧实际字段未最终确认。
- **citation gate 归属**：`check_citation_quality` 暂放 Evidence Schema 对外暴露；
  设计文档把"citation quality gate"列在 Evidence Schema 第三阶段，而 memo §11.6
  把 `citation_gate.py` 放在 Memo 模块——最终归属未定。函数逻辑自包含，若改归 Memo
  只迁移文件、不改逻辑。gate 需要的字段（`evidence_id` / `claim` / `display` 或可
  render；`quote` 可选）也待与朝龙最终对齐。

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
adapters/ppt_adapter.py     PPT slides -> ppt_slide evidence（slide_no/shape_id，notes 进 content_json）
adapters/word_adapter.py    Word sections -> word_section evidence（heading_path 进 location_json、labels 进 metadata）
adapters/markdown_adapter.py Markdown blocks -> markdown_block evidence（frontmatter/tags/wikilinks 进 location_json）
adapters/qa_adapter.py      QA messages -> qa_message evidence（session_id/message_id/role 进 location_json）
adapters/memo_adapter.py    Memo sections -> memo_section evidence（memo_id/section_id 进 location_json，可被 build_citation 消费）
normalizer.py    校验 doc_id/version_id/type/content/location/可渲染 display
display.py       render_citation_display：按类型渲染人读 citation
citation_gate.py check_citation_quality + CitationGateResult（纯校验，缺核心字段 -> needs_review）
repository.py    EvidenceRepository 接口 + InMemoryEvidenceRepository + build_citation
```

实际测试文件：

```text
conftest.py                      把 src/ 加入 sys.path，提供 fixtures
fixtures/pdf_parsed.json         PDF parsed 样例
fixtures/excel_parsed.json       Excel parsed 样例
fixtures/ppt_parsed.json         PPT parsed 样例
fixtures/word_parsed.json        Word parsed 样例
fixtures/markdown_parsed.json    Markdown parsed 样例
fixtures/qa_parsed.json          QA messages parsed 样例
fixtures/memo_parsed.json        Memo sections parsed 样例
outputs/citation_display.txt     display 渲染快照（测试生成）
test_evidence_normalizer.py      parsed blocks -> unified evidence + 校验 + 字段 alias 契约（PDF/PPT/Word/Markdown）
test_qa_memo_adapters.py         QA/Memo blocks -> evidence + alias + display + build_citation 消费
test_citation_gate.py            citation quality gate：缺核心字段 -> needs_review
test_location_rendering.py       7 种类型 location -> display
test_excel_evidence.py           sheet/cell/value/formula/upstream + file/file_name alias 与 display
test_citation_traceability.py    citation 回溯 + 版本不变性
```

运行方式：

```text
pytest test/evidence_schema/      # 34 passed
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

