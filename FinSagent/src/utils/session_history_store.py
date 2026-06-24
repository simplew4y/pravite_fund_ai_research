"""
SQLite persistence for chat sessions (sessions + session_messages).

Uses logical foreign keys only (no REFERENCES). Path comes from config key session_history_db.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_TITLE_MAX_LEN = 120


class SessionHistoryStore:
    """Append-only turns per session; creates session row on first message."""

    def __init__(self, db_path: str):
        self._path = str(Path(db_path).expanduser().resolve())
        self._init_db()

    def _init_db(self):
        """Create tables if they don't exist."""
        conn = sqlite3.connect(self._path, timeout=30.0)
        try:
            cur = conn.cursor()
            cur.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    is_deleted INTEGER NOT NULL DEFAULT 0
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS session_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    question TEXT NOT NULL,
                    draft_answer TEXT,
                    final_answer TEXT NOT NULL,
                    activated_agents TEXT,
                    is_off_topic INTEGER NOT NULL DEFAULT 0,
                    sort_key INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                )
            """)
            conn.commit()
        except sqlite3.Error as e:
            logger.warning("_init_db failed: %s", e, exc_info=True)
        finally:
            conn.close()

    def append_turn(
        self,
        session_id: str,
        question: str,
        draft_answer: Optional[str],
        final_answer: str,
        activated_agents: Optional[List[str]],
        is_off_topic: bool,
    ) -> None:
        """
        Insert one QA row and bump sessions.updated_at.
        draft_answer may be None (non-preview or cancelled preview).
        """
        text = (final_answer or "").strip()
        if not text:
            return

        self.ensure_session(session_id, question)
        agents_json: Optional[str] = None
        if activated_agents is not None:
            agents_json = json.dumps(activated_agents, ensure_ascii=False)

        conn = sqlite3.connect(self._path, timeout=30.0)
        try:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.cursor()
            cur.execute(
                "SELECT COALESCE(MAX(sort_key), 0) FROM session_messages WHERE session_id = ?",
                (session_id,),
            )
            next_sort = int(cur.fetchone()[0]) + 1
            draft_val = draft_answer if (draft_answer and draft_answer.strip()) else None
            cur.execute(
                """
                INSERT INTO session_messages (
                    session_id, question, draft_answer, final_answer,
                    activated_agents, is_off_topic, sort_key, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                """,
                (
                    session_id,
                    question,
                    draft_val,
                    text,
                    agents_json,
                    1 if is_off_topic else 0,
                    next_sort,
                ),
            )
            cur.execute(
                "UPDATE sessions SET updated_at = datetime('now') WHERE id = ?",
                (session_id,),
            )
            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            logger.warning("session_history append_turn failed: %s", e, exc_info=True)
        finally:
            conn.close()

    def ensure_session(self, session_id: str, title_candidate: str) -> None:
        """Create sessions row if missing; title from first question snippet."""
        raw = (title_candidate or "").strip() or "新对话"
        title = raw if len(raw) <= _TITLE_MAX_LEN else raw[: _TITLE_MAX_LEN - 1] + "…"

        conn = sqlite3.connect(self._path, timeout=30.0)
        try:
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM sessions WHERE id = ? LIMIT 1", (session_id,))
            if cur.fetchone() is not None:
                return
            cur.execute(
                """
                INSERT INTO sessions (id, title, created_at, updated_at, is_deleted)
                VALUES (?, ?, datetime('now'), datetime('now'), 0)
                """,
                (session_id, title),
            )
            conn.commit()
        except sqlite3.Error as e:
            conn.rollback()
            logger.warning("session_history ensure_session failed: %s", e, exc_info=True)
        finally:
            conn.close()

    def list_sessions(self) -> List[Dict[str, Any]]:
        """未删除的会话，按 updated_at 降序。"""
        conn = sqlite3.connect(self._path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT id, title, created_at, updated_at, is_deleted
                FROM sessions
                WHERE is_deleted = 0
                ORDER BY updated_at DESC
                """
            )
            return [dict(r) for r in cur.fetchall()]
        except sqlite3.Error as e:
            logger.warning("list_sessions failed: %s", e, exc_info=True)
            return []
        finally:
            conn.close()

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        conn = sqlite3.connect(self._path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT id, title, created_at, updated_at, is_deleted FROM sessions WHERE id = ?",
                (session_id,),
            )
            r = cur.fetchone()
            return dict(r) if r else None
        finally:
            conn.close()

    def create_empty_session(self, session_id: str, title: str = "新对话") -> bool:
        """仅新建空会话行（用户点击「新对话」时）。"""
        t = (title or "新对话").strip() or "新对话"
        if len(t) > _TITLE_MAX_LEN:
            t = t[: _TITLE_MAX_LEN - 1] + "…"
        conn = sqlite3.connect(self._path, timeout=30.0)
        try:
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM sessions WHERE id = ? LIMIT 1", (session_id,))
            if cur.fetchone() is not None:
                return False
            cur.execute(
                """
                INSERT INTO sessions (id, title, created_at, updated_at, is_deleted)
                VALUES (?, ?, datetime('now'), datetime('now'), 0)
                """,
                (session_id, t),
            )
            conn.commit()
            return True
        except sqlite3.IntegrityError:
            conn.rollback()
            return False
        except sqlite3.Error as e:
            conn.rollback()
            logger.warning("create_empty_session failed: %s", e, exc_info=True)
            return False
        finally:
            conn.close()

    def update_session_title(self, session_id: str, title: str) -> bool:
        t = (title or "").strip() or "新对话"
        if len(t) > _TITLE_MAX_LEN:
            t = t[: _TITLE_MAX_LEN - 1] + "…"
        conn = sqlite3.connect(self._path, timeout=30.0)
        try:
            cur = conn.cursor()
            cur.execute(
                "UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ? AND is_deleted = 0",
                (t, session_id),
            )
            conn.commit()
            return cur.rowcount > 0
        except sqlite3.Error as e:
            conn.rollback()
            logger.warning("update_session_title failed: %s", e, exc_info=True)
            return False
        finally:
            conn.close()

    def soft_delete_session(self, session_id: str) -> bool:
        conn = sqlite3.connect(self._path, timeout=30.0)
        try:
            cur = conn.cursor()
            cur.execute(
                "UPDATE sessions SET is_deleted = 1, updated_at = datetime('now') WHERE id = ?",
                (session_id,),
            )
            conn.commit()
            return cur.rowcount > 0
        except sqlite3.Error as e:
            conn.rollback()
            logger.warning("soft_delete_session failed: %s", e, exc_info=True)
            return False
        finally:
            conn.close()

    def fetch_messages_if_active(self, session_id: str) -> Optional[List[Dict[str, Any]]]:
        """
        若会话不存在或已软删除，返回 None；否则返回该会话下全部轮次（可为空列表）。
        """
        meta = self.get_session(session_id)
        if meta is None or meta.get("is_deleted"):
            return None
        conn = sqlite3.connect(self._path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        try:
            cur = conn.cursor()
            cur.execute(
                """
                SELECT id, question, draft_answer, final_answer, activated_agents,
                       is_off_topic, sort_key, created_at
                FROM session_messages
                WHERE session_id = ?
                ORDER BY sort_key ASC, id ASC
                """,
                (session_id,),
            )
            out: List[Dict[str, Any]] = []
            for r in cur.fetchall():
                d = dict(r)
                ag = d.get("activated_agents")
                if ag:
                    try:
                        d["activated_agents"] = json.loads(ag)
                    except json.JSONDecodeError:
                        d["activated_agents"] = []
                else:
                    d["activated_agents"] = []
                d["is_off_topic"] = bool(d.get("is_off_topic", 0))
                out.append(d)
            return out
        except sqlite3.Error as e:
            logger.warning("fetch_messages_if_active failed: %s", e, exc_info=True)
            return None
        finally:
            conn.close()


def session_history_store_from_config(config: Any) -> Optional[SessionHistoryStore]:
    """Return store if session_history_db is set and parent directory exists."""
    p = config.get("session_history_db") if isinstance(config, dict) else None
    if not p or not isinstance(p, str):
        return None
    path = Path(p).expanduser().resolve()
    if not path.parent.is_dir():
        logger.warning("session_history_db parent missing, persistence disabled: %s", path.parent)
        return None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.warning("session_history_db mkdir failed: %s", e)
        return None
    logger.info("Session history DB: %s", path)
    return SessionHistoryStore(str(path))
