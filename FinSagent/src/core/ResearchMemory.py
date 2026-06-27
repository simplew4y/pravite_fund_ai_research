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
        """)
        conn.commit()
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
                            (citation_id, session_id, source_type, source_id,
                             doc_id, doc_type, page, evidence_id, claim, display)
                           VALUES (?, ?, 'qa_message', ?, ?, ?, ?, ?, ?, ?)""",
                        (cit_id, session_id, msg_asst_id,
                         c.get("doc_id", ""), c.get("doc_type", ""),
                         c.get("page"), c.get("evidence_text", ""),
                         c.get("claim", ""), c.get("display", "")),
                    )

            # ── qa_messages (user) ──
            cur.execute(
                """INSERT INTO qa_messages
                    (message_id, session_id, role, content, citation_ids, created_at)
                   VALUES (?, ?, 'user', ?, ?, ?)""",
                (msg_user_id, session_id, question, "[]", now),
            )

            # ── qa_messages (assistant) ──
            cur.execute(
                """INSERT INTO qa_messages
                    (message_id, session_id, role, content, citation_ids, created_at)
                   VALUES (?, ?, 'assistant', ?, ?, ?)""",
                (msg_asst_id, session_id, answer, json.dumps(cit_ids), now),
            )

            # ── facts ──
            if facts:
                for f in facts:
                    fid = f"fact_{uuid.uuid4().hex[:12]}"
                    cur.execute(
                        """INSERT INTO facts
                            (fact_id, session_id, message_id, entity, metric,
                             value, unit, period, fact_type, source_ref, confidence)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (fid, session_id, msg_asst_id,
                         f.get("entity", ""), f.get("metric", ""),
                         f.get("value", ""), f.get("unit", ""),
                         f.get("period", ""), f.get("fact_type", "metric"),
                         f.get("source_ref", ""), f.get("confidence", 1.0)),
                    )

            # ── audit ──
            if audit:
                aid = f"aud_{uuid.uuid4().hex[:12]}"
                cur.execute(
                    """INSERT INTO audit_trail
                        (audit_id, session_id, message_id, query_text,
                         latency_ms, status, rewritten_query, sub_queries,
                         exact_results, semantic_results, merged_results,
                         used_evidence, generated_answer,
                         facts_written, citations_written)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (aid, session_id, msg_asst_id, question,
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

        return {"ok": True, "message_id": msg_asst_id, "citation_ids": cit_ids}

    # ── 查询 ───────────────────────────────────────

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
