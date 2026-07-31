# Research Memory — 技术方案

> 负责人: 廖子兴
> 模块: Research Memory
> 基于 `src/core/MemoryManager.py` 扩展
> 更新: 2026-06-25

---

## 目录

1. [架构总览](#1-架构总览)
2. [数据模型](#2-数据模型)
3. [目录与 URI 约定](#3-目录与-uri-约定)
4. [核心流程](#4-核心流程)
5. [对外接口](#5-对外接口)
6. [后端实现](#6-后端实现)
7. [OpenViking 集成说明](#7-openviking-集成说明)
8. [正确性验证](#8-正确性验证)
9. [测试目录结构](#9-测试目录结构)
10. [Roadmap](#10-roadmap)

---

# 1. 架构总览

## 1.1 架构图

```
┌───────────────────────────────────────────────────────────┐
│                       用户提问                              │
│                "极氪毛利率变化趋势"                          │
└────────────────────────┬──────────────────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────┐
│  ChatService                                             │
│                                                          │
│  ① ResearchMemory.retrieve(query) → [Related History]   │
│     → 注入 synthesis prompt                              │
│                                                          │
│  ② LLM 生成回答 + citations                               │
│                                                          │
│  ③ ResearchMemory.record_turn(turn_data)                 │
│     → 写入 messages.jsonl + content.md + facts + ...     │
└──────────────┬──────────────────────┬────────────────────┘
               │                      │
               ▼                      ▼
┌────────────────────────┐  ┌────────────────────────────┐
│  SQLite (精确记忆)      │  │  文件系统 + OpenViking     │
│                        │  │  (语义记忆)                │
│  facts 表              │  │                           │
│  citations 表          │  │  messages.jsonl (原始消息) │
│  audit_trail 表        │  │  content.md (可读归档)     │
│  qa_sessions 表        │  │  .abstract.md (摘要)      │
│  qa_messages 表        │  │  .overview.md (概览)      │
│  memory_items 表(P1)   │  │  .checkpoint.md (长会话)   │
│                        │  │                           │
│  FTS5 全文检索          │  │  → add_resource() 索引    │
│                        │  │  → search() 语义检索      │
└────────────────────────┘  └────────────────────────────┘
```

## 1.2 模块定位

Research Memory 是投研系统的记忆层，负责：

- 每次问答的完整归档（原文 + 可读格式）
- 结构化关键事实的精确存储与检索
- 引用关系的记录与追溯
- 审计轨迹的持久化
- 跨会话的语义级历史召回

不负责：

- LLM 调用与回答生成（那是 ChatService / Agent 的事）
- 原始文档的解析与索引（那是 Ingestion / Evidence Schema 的事）
- 前端 UI

## 1.3 SQLite vs OpenViking 分工

| 维度 | SQLite | 文件系统 + OpenViking |
|------|--------|----------------------|
| 存储内容 | 结构化事实、引用、审计、会话元数据 | messages.jsonl、content.md |
| 检索方式 | FTS5 + 字段精确匹配 | search() 余弦相似度 |
| 溯源能力 | ✅ 精确到 source_ref | ❌ 模糊、辅助 recall |
| 写入时机 | 每次 QA 后 | 每次 QA 后 |

---

# 2. 数据模型

## 2.1 SQLite 表

### P0 表 (第一版实现)

```sql
-- ===================== P0 =====================

-- qa_sessions: 研究会话
CREATE TABLE IF NOT EXISTS qa_sessions (
    session_id TEXT PRIMARY KEY,
    project_id TEXT DEFAULT 'default',
    analyst_id TEXT DEFAULT '',           -- P1: 多用户时启用
    title TEXT DEFAULT '',
    topic TEXT DEFAULT '',
    entities TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- qa_messages: 每条问答消息
CREATE TABLE IF NOT EXISTS qa_messages (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT DEFAULT 'default',
    analyst_id TEXT DEFAULT '',
    role TEXT NOT NULL,                   -- user | assistant
    content TEXT NOT NULL,
    citation_ids TEXT DEFAULT '[]',
    metadata_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
);

-- facts: 结构化事实
CREATE TABLE IF NOT EXISTS facts (
    fact_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT DEFAULT 'default',
    analyst_id TEXT DEFAULT '',
    message_id TEXT,
    entity TEXT NOT NULL,
    metric TEXT NOT NULL,
    value TEXT NOT NULL,
    unit TEXT DEFAULT '',
    period TEXT DEFAULT '',
    fact_type TEXT DEFAULT 'metric',      -- metric | risk | catalyst | assumption | viewpoint | task
    source_ref TEXT DEFAULT '',
    primary_citation_id TEXT,
    needs_review INTEGER DEFAULT 0,
    confidence REAL DEFAULT 1.0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- citations: 引用关系
CREATE TABLE IF NOT EXISTS citations (
    citation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT DEFAULT 'default',
    analyst_id TEXT DEFAULT '',
    source_type TEXT NOT NULL,            -- qa_message | memo_section | fact
    source_id TEXT NOT NULL,
    evidence_id TEXT DEFAULT '',
    doc_id TEXT NOT NULL,
    doc_type TEXT DEFAULT '',
    page INTEGER,
    table_id TEXT DEFAULT '',
    cell_ref TEXT DEFAULT '',
    claim TEXT DEFAULT '',
    quote TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    display TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

-- audit_trail: 审计轨迹
CREATE TABLE IF NOT EXISTS audit_trail (
    audit_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT DEFAULT 'default',
    analyst_id TEXT DEFAULT '',
    message_id TEXT,
    query_text TEXT NOT NULL,
    rewritten_query TEXT DEFAULT '',
    sub_queries TEXT DEFAULT '[]',
    exact_results TEXT DEFAULT '[]',
    semantic_results TEXT DEFAULT '[]',
    merged_results TEXT DEFAULT '[]',
    used_evidence TEXT DEFAULT '[]',
    generated_answer TEXT DEFAULT '',
    facts_written TEXT DEFAULT '[]',
    citations_written TEXT DEFAULT '[]',
    status TEXT DEFAULT 'ok',
    error TEXT DEFAULT '',
    latency_ms INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity, metric);
CREATE INDEX IF NOT EXISTS idx_facts_period ON facts(entity, period);
CREATE INDEX IF NOT EXISTS idx_citations_source ON citations(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_citations_doc ON citations(doc_id);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_trail(session_id);
```

### P1 表 (后续实现)

```sql
-- ===================== P1 =====================

-- memory_items: 统一可语义检索的记忆条目
-- 作用: OpenViking 不直接扫业务表, 而是索引 memory_items 对应的 markdown 内容
CREATE TABLE IF NOT EXISTS memory_items (
    memory_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    analyst_id TEXT NOT NULL,
    memory_type TEXT NOT NULL,            -- qa | note | memo | fact | viewpoint
    source_id TEXT NOT NULL,
    title TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    content_md_path TEXT DEFAULT '',
    entities_json TEXT DEFAULT '[]',
    topics_json TEXT DEFAULT '[]',
    metrics_json TEXT DEFAULT '[]',
    tags_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
```

## 2.2 消息文件格式

```
.memory/{project_id}/
├── db_index.db
│
└── sessions/
    └── {session_id}/
        ├── messages.jsonl         ← 完整消息
        ├── content.md             ← 可读归档
        ├── .abstract.md           ← L0 摘要
        ├── .overview.md           ← L1 概览
        ├── .checkpoint.md         ← 长会话压缩点 (P0)
        └── last_commit.json       ← 归档记录

markdown_memory/                   ← 语义索引源 (P1)
└── ...
```

### messages.jsonl

```jsonl
{"message_id": "msg_001", "session_id": "sess_001", "role": "user", "content": "极氪FY2024毛利率变化怎么看？", "citation_ids": [], "timestamp": "2026-06-25T10:00:00Z"}
{"message_id": "msg_002", "session_id": "sess_001", "role": "assistant", "content": "毛利率变化主要来自产品结构和价格竞争...", "citation_ids": ["cit_001", "cit_002"], "timestamp": "2026-06-25T10:00:30Z"}
```

### content.md

```markdown
# QA Session sess_001

## User (2026-06-25T10:00:00Z)
极氪FY2024毛利率变化怎么看？

## Assistant (2026-06-25T10:00:30Z)
毛利率变化主要来自产品结构和价格竞争...

**引用：**
- cit_001: Zeekr_2024_AR.pdf p.42
- cit_002: Zeekr_valuation_model.xlsx DCF!E12
```

---

# 3. 目录与 URI 约定

保持现有 `fin://` URI 体系：

```
fin://sessions/{session_id}           → .memory/{project_id}/sessions/{session_id}/
fin://agents/{role}/memories/cases/   → .memory/{project_id}/agents/...

project_id 第一版固定为 "default"
analyst_id 字段已预留, 第一版传空字符串
```

---

# 4. 核心流程

## 4.1 record_turn 写入

```
record_turn(session_id, question, answer, citations, facts, audit)
  │
  ├── ① qa_messages 写入 user 消息
  ├── ② qa_messages 写入 assistant 消息 (含 citation_ids)
  ├── ③ messages.jsonl 追加
  ├── ④ content.md 追加
  ├── ⑤ citations 表写入
  ├── ⑥ facts 表写入
  ├── ⑦ audit_trail 表写入
  ├── ⑧ .abstract.md / .overview.md 更新
  ├── ⑨ 每5轮 checkpoint (长会话)
  └── ⑩ content.md embedding 更新
```

facts 由上层传入，Memory 不做 LLM 提取。

## 4.2 retrieve 检索

```
retrieve(query, top_k=5)
  │
  ├── SQLite facts 精确匹配 (entity/metric)
  ├── SQLite FTS5 全文匹配 (messages)
  ├── OpenViking search() 语义匹配
  ├── 合并: 精确 (score=1.0) + 语义 (score=0.7×相似度)
  │   精确在前, 语义在后, 去重
  └── 格式化为 [Related History] 文本 → 返回
```

## 4.3 短会话 vs 长会话

| 维度 | 短会话 (1-3轮) | 长会话 (10+轮) |
|------|---------------|---------------|
| content.md | 全部保留 | 压缩摘要在前 + 最近5轮完整在后 |
| checkpoint | 不需要 | 每5轮 LLM 增量压缩 |
| 话题漂移检测 | 不需要 | P1 实现 |

Checkpoint 实现（每5轮）：

```
1. 已有 .checkpoint.md? → 基于旧摘要+新5轮生成增量摘要
2. 无 → 基于全部消息生成首版摘要
3. content.md = 新摘要 + "---" + 最近5轮完整内容
4. .checkpoint.md 写入
5. .abstract.md / .overview.md 更新
```

---

# 5. 对外接口

## 5.1 Python 接口

```python
class ResearchMemory(MemoryManager):
    """继承 MemoryManager, 扩展 record_turn / retrieve 等方法。"""

    # ── 写入 ──

    def record_turn(self, session_id: str, question: str, answer: str,
                    citations: list = None, facts: list = None,
                    audit: dict = None) -> dict:
        """一次问答完成后的完整写入。facts 由上层传入。"""
        ...

    # ── 检索 ──

    def retrieve(self, query: str, top_k: int = 5) -> list:
        """两层检索 + 合并。返回 [{content, score, tier, source}]"""
        ...

    def retrieve_for_prompt(self, query: str, top_k: int = 5) -> str:
        """返回 [Related History] 文本, 直接注入 synthesis prompt。"""
        ...

    # ── 专有查询 ──

    def get_facts(self, entity: str, metric: str = None, limit: int = 10) -> list:
        ...

    def get_audit(self, session_id: str) -> list:
        ...

    def get_citations(self, source_type: str, source_id: str) -> list:
        ...

    # ── 配置注入 ──

    def set_embedding_fn(self, fn):
        self._embed = fn

    def set_llm_fn(self, fn):
        """仅用于长会话 checkpoint 摘要, 不做 fact 提取。"""
        self._llm = fn
```

## 5.2 REST API

```
POST   /memory/turn
  Body: {
    session_id, question, answer,
    citations: [{doc_id, page, evidence_text, claim}, ...],
    facts: [{entity, metric, value, unit, period, fact_type}, ...],
    audit: {model_name, latency_ms}
  }
  → 201

GET    /memory/retrieve?q=极氪毛利率&k=5
  → 200 {items: [{content, score, tier, source}, ...]}

GET    /memory/facts?entity=极氪&metric=毛利率
  → 200 {facts: [{entity, metric, value, period, source_ref}, ...]}

GET    /memory/audit/{session_id}
  → 200 {trail: [{query, generated_answer, latency_ms, status}, ...]}

GET    /memory/citations?source_type=qa_message&source_id=msg_002
  → 200 {citations: [{doc_id, page, evidence_text, display}, ...]}
```

---

# 6. 后端实现

## 6.1 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/MemoryManager.py` | 不动 | 保持现有 436 行不变 |
| `src/core/ResearchMemory.py` | 新建 | 继承 MemoryManager，加新功能 |
| `deploy/memory_routes.py` | 新建 | FastAPI 路由 |
| `test/research_memory/` | 新建 | 测试目录 |
| `config/production.yaml` | 改 | 加 memory 配置段 |

## 6.2 ResearchMemory.py 关键方法

```python
from core.MemoryManager import MemoryManager
import sqlite3, json, uuid
from datetime import datetime, timezone
from pathlib import Path

class ResearchMemory(MemoryManager):
    """在 MemoryManager 基础上扩展。"""

    def __init__(self, base_dir=".memory"):
        super().__init__(base_dir)
        self._init_p0_tables()
        self._embed = None
        self._llm = None  # 仅用于 checkpoint 摘要

    def _init_p0_tables(self):
        conn = sqlite3.connect(self.db_path)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS qa_sessions (...);
            CREATE TABLE IF NOT EXISTS qa_messages (...);
            CREATE TABLE IF NOT EXISTS facts (...);
            CREATE TABLE IF NOT EXISTS citations (...);
            CREATE TABLE IF NOT EXISTS audit_trail (...);
        """)
        conn.close()

    def record_turn(self, session_id, question, answer,
                    citations=None, facts=None, audit=None):
        now = datetime.now(timezone.utc).isoformat()
        msg_user_id = f"msg_{uuid.uuid4().hex[:12]}"
        msg_asst_id = f"msg_{uuid.uuid4().hex[:12]}"
        cit_ids = []

        if citations:
            for c in citations:
                cit_id = f"cit_{uuid.uuid4().hex[:12]}"
                cit_ids.append(cit_id)
                self._db_execute("""
                    INSERT INTO citations (...) VALUES (...)
                """, (cit_id, session_id, ..., c.get("doc_id"), ...))

        # qa_messages (user)
        self._db_execute("INSERT INTO qa_messages VALUES (?,?,?,?,?,?,?)",
            (msg_user_id, session_id, "user", question, "[]", "{}", now))
        # qa_messages (assistant)
        self._db_execute("INSERT INTO qa_messages VALUES (?,?,?,?,?,?,?)",
            (msg_asst_id, session_id, "assistant", answer,
             json.dumps(cit_ids), "{}", now))

        # messages.jsonl
        self.append_session_message(session_id, "user", question)
        self.append_session_message(session_id, "assistant", answer)

        # facts
        if facts:
            for f in facts:
                fid = f"fact_{uuid.uuid4().hex[:12]}"
                self._db_execute("""
                    INSERT INTO facts (...) VALUES (...)
                """, (fid, session_id, ..., f["entity"], f["metric"], ...))

        # audit
        if audit:
            aid = f"aud_{uuid.uuid4().hex[:12]}"
            self._db_execute("INSERT INTO audit_trail VALUES (?,?,?,?,?,?)",
                (aid, session_id, msg_asst_id, question, ..., audit.get("latency_ms", 0), now))

        # checkpoint
        turn_count = self._count_messages(session_id) // 2
        self._checkpoint_session(session_id, turn_count)

        return {"ok": True, "message_id": msg_asst_id, "citation_ids": cit_ids}

    def retrieve(self, query, top_k=5):
        """精确 + 语义混合检索。"""
        exact = self._search_exact(query, top_k * 2)
        semantic = self._search_semantic(query, top_k * 2)
        return self._merge(exact, semantic, top_k)

    def retrieve_for_prompt(self, query, top_k=5):
        items = self.retrieve(query, top_k)
        if not items:
            return ""
        parts = [f"[Related History]"]
        for item in items:
            prefix = "📌" if item["tier"] == "exact" else "🔗"
            parts.append(f"{prefix} {item['content']}")
        return "\n".join(parts)

    def _search_exact(self, query, limit):
        results = []
        # facts 表精确匹配
        rows = self._db_query(
            "SELECT entity, metric, value, unit, period, source_ref FROM facts WHERE entity=? OR metric LIKE ? LIMIT ?",
            (self._extract_entity(query), f"%{query}%", limit))
        for r in rows:
            results.append({"content": f"{r[0]} {r[1]}: {r[2]}{r[3]} ({r[4]})",
                            "score": 1.0, "tier": "exact", "source": r[5]})
        # FTS5 匹配
        try:
            fts = self._db_query(
                "SELECT uri, abstract FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?",
                (query, limit))
            for r in fts:
                results.append({"content": r[1], "score": 0.95, "tier": "exact", "source": r[0]})
        except:
            pass
        return results

    def _search_semantic(self, query, limit):
        if not self._embed:
            return []
        q_emb = self._embed(query)
        rows = self._db_query(
            "SELECT uri, abstract, embedding FROM memory_index WHERE embedding IS NOT NULL")
        scored = []
        for uri, abstract, emb_blob in rows:
            emb = json.loads(emb_blob)
            score = self._cosine_similarity(q_emb, emb)
            scored.append({"content": abstract, "score": score, "tier": "semantic", "source": uri})
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:limit]

    def _checkpoint_session(self, session_id, turn_count, interval=5):
        if turn_count % interval != 0 or turn_count < interval or not self._llm:
            return
        messages = self.get_session_messages(session_id)
        if len(messages) < interval * 2:
            return
        recent = messages[-interval * 2:]
        session_path = self._uri_to_path(f"fin://sessions/{session_id}")
        existing = ""
        if (session_path / ".checkpoint.md").exists():
            existing = (session_path / ".checkpoint.md").read_text(encoding="utf-8")
        if existing:
            summary = self._llm(f"基于已有摘要和最新对话生成更新摘要。\n已有摘要:\n{existing}\n最新对话:\n{self._fmt_messages(recent)}")
        else:
            summary = self._llm(f"总结以下投研对话的核心内容。\n{self._fmt_messages(recent)}")
        (session_path / ".checkpoint.md").write_text(summary, encoding="utf-8")
        recent_md = self._messages_to_md(recent[-interval*2:])
        new_content = f"{summary}\n\n---\n\n## 最新对话\n\n{recent_md}"
        (session_path / "content.md").write_text(new_content, encoding="utf-8")
        self._update_embedding(f"fin://sessions/{session_id}", new_content)

    @staticmethod
    def _cosine_similarity(a, b):
        dot = sum(x * y for x, y in zip(a, b))
        na = sum(x * x for x in a) ** 0.5
        nb = sum(x * x for x in b) ** 0.5
        return dot / (na * nb) if na and nb else 0

    # ── 专有查询 ──

    def get_facts(self, entity, metric=None, limit=10):
        sql = "SELECT * FROM facts WHERE entity=?"
        params = [entity]
        if metric:
            sql += " AND metric LIKE ?"
            params.append(f"%{metric}%")
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return self._db_query(sql, params)

    def get_audit(self, session_id):
        return self._db_query(
            "SELECT * FROM audit_trail WHERE session_id=? ORDER BY created_at", (session_id,))

    def get_citations(self, source_type, source_id):
        return self._db_query(
            "SELECT * FROM citations WHERE source_type=? AND source_id=?",
            (source_type, source_id))

    # ── 辅助 ──

    def set_embedding_fn(self, fn):
        self._embed = fn
    def set_llm_fn(self, fn):
        self._llm = fn
    def _db_execute(self, sql, params=()):
        conn = sqlite3.connect(self.db_path)
        conn.execute(sql, params)
        conn.commit(); conn.close()
    def _db_query(self, sql, params=()):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.execute(sql, params)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close(); return rows
    @staticmethod
    def _extract_entity(query): return query[:20]
    @staticmethod
    def _fmt_messages(msgs): return "\n".join(f"[{m.get('role','?')}] {m.get('content','')[:200]}" for m in msgs)
    @staticmethod
    def _messages_to_md(msgs):
        parts = []
        for m in msgs:
            parts.append(f"### [{m.get('timestamp','')}] {m.get('role','')}\n{m.get('content','')}")
        return "\n\n".join(parts)
    def _count_messages(self, session_id):
        return len(self.get_session_messages(session_id))
    def _update_embedding(self, uri, content):
        if not self._embed:
            return
        emb = self._embed(content[:1000])
        self._db_execute("UPDATE memory_index SET embedding=? WHERE uri=?", (json.dumps(emb), uri))
```

## 6.3 配置

```yaml
# config/production.yaml
memory:
  dir: ".memory"
  embedding_enabled: true
  search_top_k: 5
  checkpoint_interval: 5
```

---

# 7. OpenViking 集成说明

OpenViking 在本模块中承担语义检索。

- `.md` 文件通过 `add_resource()` 索引到 OpenViking
- 检索通过 `search(query)` 执行
- 搜索范围限定在 `memories/` 路径下的内容
- OpenViking schema 按 BGE-M3 1024 维配置（已就绪）

---

# 8. 正确性验证

| # | 测试 | 方法 | 通过标准 |
|---|------|------|---------|
| 1 | QA 写入 | record_turn() → 检查 messages.jsonl / content.md / facts 表 | 数据一致 |
| 2 | 事实追溯 | 给定 fact_id → 查到 source_ref / primary_citation_id | 能定位 |
| 3 | 引用追溯 | 给定 citation_id → doc_id + page + evidence_text | 一致 |
| 4 | 审计回放 | 给定 session_id → audit_trail 查到 query + answer | 能还原 |
| 5 | 混合检索 | 先写 facts("极氪","毛利率","15.2%") → retrieve("极氪毛利率") → 返回该 fact | 精确结果排前 |
| 6 | 语义检索 | 写 messages 含毛利率 → retrieve("盈利能力") → 能召回 | score > 0 |
| 7 | 长会话 | 6 轮后 content.md 出现摘要 | 有 checkpoint |
| 8 | 重启持久化 | 重启后 retrieve 结果不变 | 数据完整 |
| 9 | REST API | 调 /memory/retrieve?q=xxx → 200 + json | 接口通 |
| 10 | P1 字段存在 | analyst_id / fact_type 在 schema 中 | 已预留 |

---

# 9. 测试目录结构

```
test/research_memory/
├── README.md                            ← 测试说明
├── fixtures/
│   ├── sample_turn.json                 ← record_turn 的样例输入与期望回答
```

---

# 10. Roadmap

```
Week 1 (当前)
├── ResearchMemory.py 实现 (record_turn / retrieve / facts / citations / audit)
├── SQLite P0 表初始化
├── deploy/memory_routes.py
├── 验证: test #1 #2 #3 #4 #5 #8

Week 2
├── 语义检索接入 (set_embedding_fn + _search_semantic)
├── 长会话 checkpoint
├── 验证: test #5 #6 #7

Week 3
├── REST API 调试
├── 与 ChatService 联调
├── 全部 10 项验收
├── README 更新
```

---

> 文档状态: v2 · ready for review
> 基于初版修订: 加架构图/API/验收表; OpenViking 实际方案; P0/P1 分层
