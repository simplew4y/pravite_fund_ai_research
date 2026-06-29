# Evidence Schema / Citation / Provenance 阶段性进展与对齐报告

- 负责人：程景逸
- 报告日期：2026-06-28
- 模块定位：私募投研 AI 助手的「证据 / 引用 / 溯源」统一中间层
- 分支：`chengjingyi/evidence-schema/20260626-phase1-evidence`（已 push，未合并 main）
- 当前提交：`188b65f` `[evidence_schema] align qa adapter with research memory`
- 后续修复（待提交）：按 Draft PR #1 review 修 Excel 空 block 过滤与 Memo display，新增 3 个测试（详见 §4）

---

## 1. 一句话总结

本模块负责把**多种来源**（PDF / Excel / PPT / Word / Markdown / 问答消息 / 备忘录段落）
的内容，统一抽象成**可被引用、可被溯源的最小证据单元（Evidence）**，并在其上提供
**统一的引用（Citation）与质量校验（Citation Gate）**能力。核心原则一句话概括：

> **解析可以按类型分别处理，但「引用」必须全系统统一；每一条研究结论都能回溯到原始文件的具体位置。**

当前 Phase 1（核心 schema + 多类型适配 + 引用质量门）已完成并通过全部测试（39 passed，含按 Draft PR #1 review 的修复）。
需要明确边界：本阶段交付的是 **Evidence Schema 内部 MVP**（基于 mock / fixture / adapter /
citation gate），并已与下游 Research Memory（廖的 `lzx_memo` 分支）完成**只读接口对齐**；
**真实 DB 落库、真实 parser 接入、Memo pipeline 集成仍属下一阶段**，尚未完成。

---

## 2. 设计目标与核心原则

| 目标 | 说明 |
|---|---|
| 统一引用 | 输出（问答答案 / 备忘录段落 / 事实）引用的是 `citation_id`，**绝不直接引用文件** |
| 完整溯源 | `citation → evidence → (document, version, location) → 原始文件`，链路闭环 |
| 低耦合 | 上游 parser 字段名未定时，用 `pick()` 别名机制吸收差异，不写死上游字段 |
| 稳定可复现 | `evidence_id / citation_id` 由内容确定性哈希生成，重复入库结果一致 |
| 版本感知 | 同一 `document_version` 重复解析得到相同 `evidence_id`；新 `version_id` 产生新 `evidence_id`，**不破坏旧引用** |
| 无第三方模型库 | 仅用标准库 `dataclasses`，零额外依赖 |

---

## 3. 架构与已交付内容

### 3.1 核心数据模型（`src/evidence_schema/schema.py`）

确定性、纯 `dataclass`，作为冲突设计文档的「超集」以降低后续重构成本：

- `Document` / `DocumentVersion`：文档与其文件版本的稳定身份。
- `EvidenceLocation`：证据在原文中的位置；常用字段为显式列（page/slide/sheet/cell/
  heading/offset/bbox 等），类型特有字段进 `location_json`。
- `Evidence`：**最小可引用单元**（区别于检索 chunk），含 `content_text/content_json/metadata_json`。
- `Citation`：从输出到证据的引用关系，含 `claim / quote / reason / display` 四要素。
- 枚举：`EvidenceType`（7 类）、`SourceType`（5 类）、`VersionStatus`（pending/parsed/failed）。

### 3.2 稳定 ID 策略（`src/evidence_schema/ids.py`）

- `make_evidence_id(doc_id, version_id, evidence_type, location)` → `ev_<16位sha1>`，
  **不依赖入库时间**（`version_id` 参与哈希），保证稳定且**版本感知**。
- `make_citation_id(source_type, source_id, evidence_id, claim)` → `cit_…`。
- `now_iso()` 统一 UTC 时间戳。

### 3.3 多类型适配器（`src/evidence_schema/adapters/`，共 7 个）

通过 `ADAPTER_REGISTRY` 注册，统一基类 `BaseEvidenceAdapter` + `AdapterContext` 注入身份：

| 适配器 | 证据类型 | 关键处理 |
|---|---|---|
| `PdfEvidenceAdapter` | `pdf_page_section` | 页码 / 段落 / bbox |
| `ExcelEvidenceAdapter` | `excel_cell` | **保留公式与 sheet/cell 上下文**，不做纯文本切块；空 block 跳过、`content_json` 不写 None |
| `PptEvidenceAdapter` | `ppt_slide` | slide / shape / notes |
| `WordEvidenceAdapter` | `word_section` | heading 路径 / 段落 |
| `MarkdownEvidenceAdapter` | `markdown_block` | frontmatter / tags / wikilinks |
| `QaEvidenceAdapter` | `qa_message` | session/message/role，识别顶层 `citation_ids` |
| `MemoEvidenceAdapter` | `memo_section` | memo/section/heading，产物可直接喂 `build_citation()` |

所有适配器统一采用 `pick(block, *aliases)` 别名模式，上游字段名变化只需在 `pick` 加 alias，
**不动 schema、不动 ID 生成逻辑**。

### 3.4 引用质量门（`src/evidence_schema/citation_gate.py`）

纯函数 `check_citation_quality(citation, evidence=None)`，不接 LLM、不接 DB：

- 校验 `evidence_id`、`claim`、以及 `display`（或可由 evidence 渲染出 display）。
- `quote` 为可选。
- 缺核心字段 → 返回 `needs_review=true` + `missing` 列表，供下游（如 Memo）标记「待复核」。
- 逻辑自包含，若后续归属调整到 Memo 模块，只迁移文件、不改逻辑。

### 3.5 渲染与归一化

- `display.py`：按类型渲染人类可读引用串（如 `session_001, assistant message msg_002`）。
- `normalizer.py`：`normalize_many()` 批量补全 id/时间戳；`_has_traceable_location()`
  确保每条证据可溯源（QA 无 file_name 也可凭 session_id 溯源）。

---

## 4. 测试与质量

- **全量测试：39 passed**（`python -m pytest test/evidence_schema/ -q`）。
- 覆盖：7 类适配器归一化、稳定 id 复现、Excel 公式/单元格保留、引用质量门、
  QA `citation_ids` 顶层优先 + 嵌套向后兼容；空 Excel block 不生成证据、`content_json` 不含 None、
  Memo display 用人读 heading（形如 `memo_001, section 核心观点`）等。
- 每类型均有 `fixtures/*.json` 样例；IDE 静态检查无告警。

---

## 5. 与下游 Research Memory（廖 `lzx_memo` 分支）的接口对齐

通过**只读**核对廖的 `FinSagent/src/core/ResearchMemory.py` 真实 SQLite DDL，
验证并确认了本模块此前的多项关键假设。需强调本节性质：

- 这些结论**已通过廖 `lzx_memo` 分支的真实代码确认**（不是凭设计文档推测）；
- 但**仍未接真实 SQLite**，本模块当前仍走 mock / fixture；
- 因此属于**只读接口对齐**，**不等于跨模块集成已完成**。

### 已确认（RESOLVED — 经真实代码只读核对）

| 项 | 结论 |
|---|---|
| QA 消息结构 | `qa_messages`（message_id/session_id/role/content/citation_ids/metadata_json/created_at）与适配器假设**逐字一致** |
| 引用字段落库 | `citations` 表**同时含 `claim / quote / reason / display`**，Memo / Gate 所需字段下游全部落库 |
| evidence_id 复用 | `citations.evidence_id` 列即留给本模块 `evidence_id` 的复用入口（fact↔citation↔evidence 链路成立） |
| 落库位置（部分确认） | 至少在 citation 落库位置上，已基本确认 citation 落 Research Memory / **analyst 侧 SQLite**；evidence 本体仍按设计归 **collection 侧**。DB 总体设计仍需雷雷确认 |

### 已知非阻塞差异（后续收敛）

- 事实↔引用当前为 `facts.primary_citation_id` 单列（1:1），非多对多结表 `fact_citations`。
- citations 反范式保存 `page / table_id / cell_ref / doc_type`，下游暂无独立 `evidence_locations` 表。
- `citations.evidence_id` 目前被填成 `evidence_text` 占位，**真正 evidence_id 的接入是后续集成缝**。
- `evidence_text` ≈ 本模块的 `quote` / evidence content，对接时按此映射。

---

## 6. 进度评估

| 维度 | 完成度 | 说明 |
|---|---|---|
| **Evidence Schema 模块内部 MVP** | **约 90%** | 核心 schema、7 类适配器、稳定 id、引用质量门、测试、下游只读对齐均已落地 |
| **跨模块端到端闭环** | **约 60%–70%** | 真实 DB、真实 parser、真实 Memo pipeline 尚未完全接入，需依赖他人交付 |

> 说明：余下部分多为**跨模块集成**与**真实落库**，需待 DB DDL（雷雷）、真实 parser 输出（廖）、
> Memo 字段与 Gate 归属（朝龙）确认后才能闭环。本模块已为这些预留了低耦合接缝，
> 但在依赖到位前，端到端真实集成**尚未完成**，不计入已完成范围。

---

## 7. 后续计划与工作量预估

> 预估以「理想人日」计，不含等待他人交付的阻塞时间；实际排期取决于上游依赖到位时间。

### Phase 3（可先做 schema/mock 层推进，真实接入仍依赖 parser / DB 输出）

| 任务 | 内容 | 预估 |
|---|---|---|
| 表格区域级证据 | Excel 区域级证据可先在 schema / mock 层推进；**PDF 表格区域级证据真实接入可能依赖 parser 输出（如 Camelot / PyMuPDF 等结果）**，因此这部分并非完全不依赖他人 | 2–3 人日（schema/mock 层） |
| 版本失效标记 | evidence/citation 的 `superseded_at` / 版本失效与回溯机制，可先在 schema / mock 层推进 | 1–2 人日 |
| 真实 fixtures 替换 | 用廖真实 parser 输出替换合成样例，必要时补 `pick()` alias（依赖廖交付真实输出） | 0.5–1 人日 |

### Phase 4（需跨模块协作 / 真实落库）

| 任务 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| 真实 SQLite Repository | 落地 `evidence / evidence_locations` 表与读写层 | 雷雷（DDL） | 2–3 人日 |
| evidence_id 真实接入 | 把本模块 evidence_id 接入 `citations.evidence_id`（替换占位） | 廖（集成时点） | 1–2 人日 |
| Citation Gate 归属定稿 | 确认 Gate 留本模块或迁 Memo，定字段集 | 朝龙 | 0.5 人日 |
| 端到端溯源回归 | 从输出 → citation → evidence → 原文件 全链路集成测试 | 全体 | 2 人日 |

**合计**：schema/mock 层可先行部分约 **4–6 人日**；协作落库 / 真实接入部分约 **6–8 人日**（含等待依赖）。

---

## 8. 待确认事项（需对接）

- 🔴 **雷雷**：`evidence / evidence_locations` 表 DDL，`doc_id / version_id / evidence_id` 最终生成规则。
- 🔴 **朝龙**：`memo_sections` 真实字段；Citation Gate 最终归属与字段集。
- 🟡 **廖**：真正 evidence_id 接入 `citations.evidence_id` 的集成时点；fact↔citation 是否从 1:1 演进为多对多。

---

## 9. 风险与控制

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 上游 parser 字段名变动 | 适配器读取失败 | `pick()` 别名机制，改动 ≤ 数行，不动 schema |
| DB DDL 未定 | 无法真实落库 | 当前内存 mock + `AdapterContext` 注入，DDL 到位即可平滑接入 |
| Gate 归属未定 | 跨模块返工 | Gate 逻辑自包含，迁移只动文件不动逻辑 |
| 多模块集成时序 | 端到端打通延后 | 已预留集成缝（evidence_id 占位、超集 dataclass）降低返工 |

---

## 10. 交付物清单（本阶段）

- 源码：`src/evidence_schema/`（schema / ids / display / normalizer / citation_gate + 7 适配器）。
- 测试：`test/evidence_schema/`（39 passed，含 fixtures 与 README/ASSUMPTIONS）。
- 文档：本报告 + `test/evidence_schema/README.md`（含已对齐 / 非阻塞差异清单）。
- 协作点：Draft PR #1（`chengjingyi/evidence-schema/20260626-phase1-evidence`）已创建并收到 review；两条意见已修复，待提交后转 ready-for-review。下一阶段（SQLite / DB 对齐 / RM 接入）另开 PR。
