"""
Research Memory — 投研记忆模块

Phase 1: SQLite 核心
- facts / citations / audit_trail 表
- record_turn() SQLite 写入
- get_facts / get_audit / get_citations 查询

继承 MemoryManager (src/core/MemoryManager.py)
"""

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from core.MemoryManager import MemoryManager


class ResearchMemory(MemoryManager):
    """扩展 MemoryManager，增加 facts/citations/audit 等结构化记忆能力。"""

    def __init__(self, base_dir: str = ".memory"):
        super().__init__(base_dir)
        self._init_p0_tables()
        self._embed = None
        self._llm = None

    def _init_p0_tables(self):
        """建 P0 表（幂等）。"""
        conn = sqlite3.connect(self.db_path)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS qa_sessions (
                session_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL DEFAULT 'default',
                analyst_id TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                topic TEXT NOT NULL DEFAULT '',
                entities TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS qa_messages (
                message_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                project_id TEXT NOT NULL DEFAULT 'default',
                analyst_id TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
                content TEXT NOT NULL,
                citation_ids TEXT NOT NULL DEFAULT '[]',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS facts (
                fact_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                project_id TEXT NOT NULL DEFAULT 'default',
                analyst_id TEXT NOT NULL DEFAULT '',
                message_id TEXT,
                entity TEXT NOT NULL,
                metric TEXT NOT NULL,
                value TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT '',
                period TEXT NOT NULL DEFAULT '',
                fact_type TEXT NOT NULL DEFAULT 'metric',
                source_ref TEXT NOT NULL DEFAULT '',
                primary_citation_id TEXT,
                needs_review INTEGER NOT NULL DEFAULT 0,
                confidence REAL NOT NULL DEFAULT 1.0,
                version INTEGER NOT NULL DEFAULT 1,
                superseded_at TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS citations (
                citation_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                project_id TEXT NOT NULL DEFAULT 'default',
                analyst_id TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL CHECK(source_type IN ('qa_message', 'fact', 'memo_section')),
                source_id TEXT NOT NULL,
                evidence_id TEXT NOT NULL DEFAULT '',
                doc_id TEXT NOT NULL,
                doc_type TEXT NOT NULL DEFAULT '',
                page INTEGER,
                table_id TEXT NOT NULL DEFAULT '',
                cell_ref TEXT NOT NULL DEFAULT '',
                claim TEXT NOT NULL DEFAULT '',
                quote TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                display TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS audit_trail (
                audit_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                project_id TEXT NOT NULL DEFAULT 'default',
                analyst_id TEXT NOT NULL DEFAULT '',
                message_id TEXT,
                query_text TEXT NOT NULL,
                rewritten_query TEXT NOT NULL DEFAULT '',
                sub_queries TEXT NOT NULL DEFAULT '[]',
                exact_results TEXT NOT NULL DEFAULT '[]',
                semantic_results TEXT NOT NULL DEFAULT '[]',
                merged_results TEXT NOT NULL DEFAULT '[]',
                used_evidence TEXT NOT NULL DEFAULT '[]',
                generated_answer TEXT NOT NULL DEFAULT '',
                facts_written TEXT NOT NULL DEFAULT '[]',
                citations_written TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL DEFAULT 'ok',
                error TEXT NOT NULL DEFAULT '',
                latency_ms INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session ON qa_messages(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity, metric);
            CREATE INDEX IF NOT EXISTS idx_facts_period ON facts(entity, period);
            CREATE INDEX IF NOT EXISTS idx_facts_citation ON facts(primary_citation_id);
            CREATE INDEX IF NOT EXISTS idx_citations_source ON citations(source_type, source_id);
            CREATE INDEX IF NOT EXISTS idx_citations_doc ON citations(doc_id);
            CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_trail(session_id, created_at);

            CREATE TABLE IF NOT EXISTS fact_citations (
                fact_id TEXT NOT NULL,
                citation_id TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'primary'
                    CHECK(role IN ('primary', 'supporting', 'conflicting')),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (fact_id, citation_id)
            );
        """)
        conn.commit()
        # Add embedding column if not present (migration)
        try:
            conn.execute("ALTER TABLE memory_index ADD COLUMN embedding TEXT")
        except Exception:
            pass  # already exists
        conn.close()

    # ── 写入 ───────────────────────────────────────

    def record_turn(
        self,
        session_id: str,
        question: str,
        answer: str,
        citations: Optional[List[Dict[str, Any]]] = None,
        facts: Optional[List[Dict[str, Any]]] = None,
        audit: Optional[Dict[str, Any]] = None,
        project_id: str = "default",
        analyst_id: str = "",
    ) -> Dict[str, Any]:
        """记录一次问答（仅 SQLite 写入，不写文件系统）。

        Args:
            session_id: 会话 ID
            question: 用户问题
            answer: 系统回答
            citations: 引用列表 [{doc_id, doc_type, page, evidence_text, display}]
            facts: 事实列表 [{entity, metric, value, unit, period, fact_type, source_ref}]
            audit: 审计元数据 {model_name, latency_ms, ...}

        Returns:
            {"ok": bool, "message_id": str, "citation_ids": list[str]}
        """
        now = datetime.now(timezone.utc).isoformat()
        msg_user_id = f"msg_{uuid.uuid4().hex[:12]}"
        msg_asst_id = f"msg_{uuid.uuid4().hex[:12]}"
        cit_ids: List[str] = []

        conn = sqlite3.connect(self.db_path)
        cur = conn.cursor()

        try:
            # ── citations ──
            if citations:
                for c in citations:
                    cit_id = f"cit_{uuid.uuid4().hex[:12]}"
                    cit_ids.append(cit_id)
                    cur.execute(
                        """INSERT INTO citations
                            (citation_id, session_id, project_id, analyst_id, source_type, source_id,
                             doc_id, doc_type, page, evidence_id, claim, display)
                           VALUES (?, ?, ?, ?, 'qa_message', ?, ?, ?, ?, ?, ?, ?)""",
                        (cit_id, session_id, project_id, analyst_id, msg_asst_id,
                         c.get("doc_id", ""), c.get("doc_type", ""),
                         c.get("page"), c.get("evidence_text", ""),
                         c.get("claim", ""), c.get("display", "")),
                    )

            # ── qa_messages (user) ──
            cur.execute(
                """INSERT INTO qa_messages
                    (message_id, session_id, project_id, analyst_id, role, content, citation_ids, created_at)
                   VALUES (?, ?, ?, ?, 'user', ?, ?, ?)""",
                (msg_user_id, session_id, project_id, analyst_id, question, "[]", now),
            )

            # ── qa_messages (assistant) ──
            cur.execute(
                """INSERT INTO qa_messages
                    (message_id, session_id, project_id, analyst_id, role, content, citation_ids, created_at)
                   VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?)""",
                (msg_asst_id, session_id, project_id, analyst_id, answer, json.dumps(cit_ids), now),
            )

            # ── facts ──
            if facts:
                for f in facts:
                    fid = f"fact_{uuid.uuid4().hex[:12]}"
                    entity = f.get("entity", "")
                    metric = f.get("metric", "")

                    # 标记旧版本 superseded
                    if entity and metric:
                        cur.execute(
                            """UPDATE facts SET superseded_at=?
                               WHERE entity=? AND metric=? AND superseded_at IS NULL""",
                            (now, entity, metric),
                        )

                    # 查询最新版本号
                    cur.execute(
                        "SELECT COALESCE(MAX(version), 0) + 1 FROM facts WHERE entity=? AND metric=?",
                        (entity, metric),
                    )
                    next_ver = cur.fetchone()[0]

                    cur.execute(
                        """INSERT INTO facts
                            (fact_id, session_id, project_id, analyst_id, message_id, entity, metric,
                             value, unit, period, fact_type, source_ref,
                             confidence, version)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (fid, session_id, project_id, analyst_id, msg_asst_id,
                         entity, metric,
                         f.get("value", ""), f.get("unit", ""),
                         f.get("period", ""), f.get("fact_type", "metric"),
                         f.get("source_ref", ""), f.get("confidence", 1.0),
                         next_ver),
                    )

                    # 关联 citations
                    for cid in cit_ids:
                        cur.execute(
                            "INSERT OR IGNORE INTO fact_citations (fact_id, citation_id, role) VALUES (?, ?, 'primary')",
                            (fid, cid),
                        )

            # ── audit ──
            if audit:
                aid = f"aud_{uuid.uuid4().hex[:12]}"
                cur.execute(
                    """INSERT INTO audit_trail
                        (audit_id, session_id, project_id, analyst_id, message_id, query_text,
                         latency_ms, status, rewritten_query, sub_queries,
                         exact_results, semantic_results, merged_results,
                         used_evidence, generated_answer,
                         facts_written, citations_written)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (aid, session_id, project_id, analyst_id, msg_asst_id, question,
                     audit.get("latency_ms", 0), audit.get("status", "ok"),
                     audit.get("rewritten_query", ""),
                     json.dumps(audit.get("sub_queries", [])),
                     json.dumps(audit.get("exact_results", [])),
                     json.dumps(audit.get("semantic_results", [])),
                     json.dumps(audit.get("merged_results", [])),
                     json.dumps(audit.get("used_evidence", [])),
                     answer,
                     json.dumps(audit.get("facts_written", [])),
                     json.dumps(audit.get("citations_written", []))),
                )

            conn.commit()
        except Exception as e:
            conn.rollback()
            return {"ok": False, "error": str(e), "message_id": "", "citation_ids": []}
        finally:
            conn.close()

        # ── Phase 2: 文件系统写入 (不阻塞) ──
        try:
            # 格式化回答尾部附加引用
            if citations and cit_ids:
                cit_lines = ["\n\n**引用：**"]
                for i, c in enumerate(citations):
                    display = c.get("display") or c.get("doc_id", "")
                    if c.get("page"):
                        display += f" p.{c['page']}"
                    cit_lines.append(f"- {cit_ids[i]}: {display}")
                answer_display = answer + "\n".join(cit_lines)
            else:
                answer_display = answer

            self.append_session_message(
                session_id, "user", question,
                metadata={"message_id": msg_user_id},
            )
            self.append_session_message(
                session_id, "assistant", answer_display,
                metadata={
                    "message_id": msg_asst_id,
                    "citation_ids": cit_ids,
                },
            )
        except Exception:
            pass  # 文件系统写入失败不阻塞

        # Phase 4: checkpoint
        try:
            tc = self._count_messages(session_id)
            self._checkpoint_session(session_id, tc)
        except Exception:
            pass

        # Phase 5: update embedding (semantic search)
        try:
            self._update_embedding(session_id)
        except Exception:
            pass

        return {"ok": True, "message_id": msg_asst_id, "citation_ids": cit_ids}

    # ── 查询 ───────────────────────────────────────

    def retrieve(
        self, query: str, top_k: int = 5, session_id: str = None
    ) -> List[Dict[str, Any]]:
        """两层检索（精确 + 语义）并合并排序。

        Args:
            query: 查询文本
            top_k: 返回条数
            session_id: 当前会话ID（提供时同会话结果加权）

        Returns:
            [{content, score, tier, source}, ...]
        """
        exact = self._search_exact(query, top_k * 2, session_id=session_id)
        semantic = self._search_semantic(query, top_k * 2, session_id=session_id)
        return self._merge(exact, semantic, top_k)

    def retrieve_for_prompt(
        self, query: str, top_k: int = 5, session_id: str = None
    ) -> str:
        """检索并格式化为 prompt 注入段。

        Returns:
            "[Related History]\n📌 xxx\n🔗 xxx" 或 ""（无结果）
        """
        items = self.retrieve(query, top_k, session_id=session_id)
        if not items:
            return ""

        parts = ["[Related History]"]
        for item in items:
            prefix = "📌" if item["tier"] == "exact" else "🔗"
            parts.append(f"{prefix} {item['content']}")
        return "\n".join(parts)

    # ── 内部检索 ───────────────────────────────────

    def _search_exact(
        self, query: str, limit: int, session_id: str = None
    ) -> List[Dict[str, Any]]:
        """FTS5 + facts 表精确检索。支持 session 内结果加权。"""
        results: List[Dict[str, Any]] = []
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row

        try:
            # ① facts 表精确匹配（全域）
            cur = conn.execute(
                """SELECT entity, metric, value, unit, period, source_ref, created_at, session_id
                   FROM facts
                   WHERE metric LIKE ? OR entity = ?
                   ORDER BY created_at DESC
                   LIMIT ?""",
                (f"%{query}%", self._extract_entity(query), limit),
            )
            for r in cur.fetchall():
                score = 1.0
                if session_id and r["session_id"] == session_id:
                    score = 1.3  # 同 session 结果加权
                results.append({
                    "content": f"{r['entity']} {r['metric']}: {r['value']}{r['unit']} ({r['period']})",
                    "score": score,
                    "tier": "exact",
                    "source": r["source_ref"] or f"fact/{r['created_at'][:10]}",
                })

            # ② 当前 session 的 qa_messages 精确匹配（优先于全域 FTS5）
            if session_id:
                cur = conn.execute(
                    """SELECT content, created_at, role
                       FROM qa_messages
                       WHERE session_id=? AND content LIKE ?
                       ORDER BY created_at DESC
                       LIMIT ?""",
                    (session_id, f"%{query}%", limit),
                )
                for r in cur.fetchall():
                    results.append({
                        "content": r["content"][:200],
                        "score": 1.2,
                        "tier": "exact",
                        "source": f"session/{session_id}",
                    })

            # ③ FTS5 全文匹配（全域）
            words = [w for w in query.split() if w.strip()]
            if words:
                fts_query = " OR ".join(f"{w}*" for w in words)
                cur = conn.execute(
                    """SELECT uri, abstract
                       FROM memory_fts
                       WHERE memory_fts MATCH ?
                       ORDER BY rank
                       LIMIT ?""",
                    (fts_query, limit),
                )
                for r in cur.fetchall():
                    score = 0.95
                    if session_id and session_id in r["uri"]:
                        score = 1.15  # 同 session 结果加权
                    results.append({
                        "content": r["abstract"] or r["uri"],
                        "score": score,
                        "tier": "exact",
                        "source": r["uri"],
                    })
        except Exception:
            pass
        finally:
            conn.close()

        return results

    def _search_semantic(
        self, query: str, limit: int, session_id: str = None
    ) -> List[Dict[str, Any]]:
        """语义检索。支持 session 内结果加权。"""
        if not self._embed:
            return []
        q_emb = self._embed(query)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT uri, abstract, embedding FROM memory_index "
            "WHERE embedding IS NOT NULL"
        ).fetchall()
        conn.close()

        scored = []
        for r in rows:
            if not r["embedding"]:
                continue
            emb = json.loads(r["embedding"])
            score = self._cosine_similarity(q_emb, emb)
            if score > 0.3:
                if session_id and session_id in r["uri"]:
                    score *= 1.3  # 同 session 语义结果加权
                scored.append({
                    "content": r["abstract"] or r["uri"],
                    "score": score,
                    "tier": "semantic",
                    "source": r["uri"],
                })

        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:limit]

    @staticmethod
    def _merge(
        exact: List[Dict[str, Any]],
        semantic: List[Dict[str, Any]],
        top_k: int,
    ) -> List[Dict[str, Any]]:
        """精确优先合并，语义结果降权。"""
        seen: set = set()
        merged: List[Dict[str, Any]] = []

        for item in exact:
            key = item["source"][:60]
            if key not in seen:
                merged.append(item)
                seen.add(key)

        for item in semantic:
            key = item["source"][:60]
            if key not in seen and len(merged) < top_k * 2:
                item["score"] *= 0.7
                merged.append(item)
                seen.add(key)

        merged.sort(key=lambda x: x["score"], reverse=True)
        return merged[:top_k]

    @staticmethod
    def _extract_entity(query: str) -> str:
        """简单实体提取（P0 版，后续可用 LLM）。"""
        import re
        known = re.findall(
            r"极氪|蔚来|小鹏|理想|比亚迪|特斯拉|宁德时代|腾讯|阿里|茅台|招行|平安",
            query,
        )
        return known[0] if known else ""

    @staticmethod
    def _cosine_similarity(
        a: List[float], b: List[float]
    ) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        na = sum(x * x for x in a) ** 0.5
        nb = sum(x * x for x in b) ** 0.5
        return dot / (na * nb) if na * nb else 0

    def get_facts(
        self,
        entity: str,
        metric: Optional[str] = None,
        period: Optional[str] = None,
        limit: int = 10,
    ) -> List[Dict[str, Any]]:
        """查询某实体的历史事实。"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        sql = "SELECT * FROM facts WHERE entity=?"
        params: List[Any] = [entity]
        if metric:
            sql += " AND metric LIKE ?"
            params.append(f"%{metric}%")
        if period:
            sql += " AND period=?"
            params.append(period)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
        conn.close()
        return rows

    def get_audit(self, session_id: str) -> List[Dict[str, Any]]:
        """查询某次会话的审计轨迹。"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM audit_trail WHERE session_id=? ORDER BY created_at",
                (session_id,),
            ).fetchall()
        ]
        conn.close()
        return rows

    def get_citations(
        self, source_type: str, source_id: str
    ) -> List[Dict[str, Any]]:
        """查询某条消息/事实的所有引用。"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        rows = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM citations WHERE source_type=? AND source_id=?",
                (source_type, source_id),
            ).fetchall()
        ]
        conn.close()
        return rows

    def get_fact_citations(
        self, fact_id: str
    ) -> List[Dict[str, Any]]:
        """查询某事实关联的所有引用（含 role）。"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        rows = [
            dict(r)
            for r in conn.execute(
                """SELECT fc.*, c.doc_id, c.page, c.display, c.evidence_id
                   FROM fact_citations fc
                   JOIN citations c ON fc.citation_id = c.citation_id
                   WHERE fc.fact_id=?
                   ORDER BY fc.role""",
                (fact_id,),
            ).fetchall()
        ]
        conn.close()
        return rows
        conn.close()
        return rows

    # ── Phase 4: 长会话管理 ───────────────────────

    def set_embedding_fn(self, fn):
        self._embed = fn

    def set_llm_fn(self, fn):
        self._llm = fn

    def _count_messages(self, session_id):
        return len(self.get_session_messages(session_id))

    def _checkpoint_session(self, session_id, turn_count, interval=5):
        if turn_count < interval or turn_count % interval != 0:
            return
        if not self._llm:
            return
        messages = self.get_session_messages(session_id)
        if len(messages) < interval * 2:
            return
        recent = messages[-interval * 2:]
        session_path = self._uri_to_path("fin://sessions/" + session_id)
        existing = ""
        cp = session_path / ".checkpoint.md"
        if cp.exists():
            existing = cp.read_text(encoding="utf-8")
        if existing:
            prompt = ("基于已有摘要和最新对话，生成更新的会话摘要。\n\n"
                      "已有摘要:\n" + existing + "\n\n最新对话:\n" + self._fmt_messages(recent))
        else:
            prompt = "总结以下投研对话的核心内容。\n\n" + self._fmt_messages(recent)
        summary = self._llm(prompt)
        cp.write_text(summary, encoding="utf-8")
        recent_md = self._messages_to_md(recent[-interval * 2:])
        new_content = summary + "\n\n---\n\n## 最新对话\n\n" + recent_md
        (session_path / "content.md").write_text(new_content, encoding="utf-8")
        abstract = summary[:120]
        if len(summary) > 120:
            abstract += "..."
        (session_path / ".abstract.md").write_text(abstract, encoding="utf-8")
        self._update_embedding(session_id)

    def _update_embedding(self, session_id):
        if not self._embed:
            return
        uri = "fin://sessions/" + session_id
        content = self.read_memory(uri, "L2")
        if not content or "PathNotFoundError" in content:
            return
        try:
            import json, sqlite3
            emb = self._embed(content[:1000])
            conn = sqlite3.connect(self.db_path)
            conn.execute("UPDATE memory_index SET embedding=? WHERE uri=?", (json.dumps(emb), uri))
            conn.commit()
            conn.close()
        except Exception:
            pass

    @staticmethod
    def _fmt_messages(messages):
        parts = []
        for m in messages:
            parts.append("[" + m.get("role", "?") + "] " + str(m.get("content", ""))[:200])
        return "\n".join(parts)

    @staticmethod
    def _messages_to_md(messages):
        parts = []
        for m in messages:
            ts = m.get("timestamp", m.get("created_at", ""))
            role = m.get("role", "?")
            content = m.get("content", "")
            parts.append("### [" + ts + "] " + role + "\n\n" + content)
        return "\n\n".join(parts)
