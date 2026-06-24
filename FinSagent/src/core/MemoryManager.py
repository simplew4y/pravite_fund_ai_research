"""
基于文件系统范式的记忆与知识管理

- 使用本地文件系统存储 Markdown 内容
- 使用 SQLite 存储元数据和 L0/L1 以便检索
- 提供短期会话记忆追加与长期记忆提交（commit）能力

TODO
- 保存中间Response作为最终回答的上下文注入
- sessions持久化: sessions分离、sessions中断和恢复、sessions新建与删除
- 规则化抽取改为llm抽取 
- 将记忆应用到上下文
- * 数据的存储目录可能需要找个更好的地方
"""

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone

class MemoryManager:
    """
    记忆管理模块
    
    Attributes:
        write_memory: 存储记忆
        
    """
    def __init__(self, base_dir: str = ".memory"):
        self.base_dir = Path(base_dir).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        
        self.db_path = self.base_dir / "db_index.db"
        self._init_db()
        print(f"[MemoryManager] Initialization success, data path: {self.base_dir}")

    def _init_db(self):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS memory_index (
                uri TEXT PRIMARY KEY,
                type TEXT NOT NULL,          -- session, knowledge, agent
                abstract TEXT,
                overview TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        cursor.execute('''
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
                uri, abstract, overview, content='memory_index', content_rowid='rowid'
            )
        ''')
        
        cursor.execute('''
            CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_index BEGIN
                INSERT INTO memory_fts(rowid, uri, abstract, overview) 
                VALUES (new.rowid, new.uri, new.abstract, new.overview);
            END;
        ''')
        
        cursor.execute('''
            CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_index BEGIN
                INSERT INTO memory_fts(memory_fts, rowid, uri, abstract, overview) 
                VALUES('delete', old.rowid, old.uri, old.abstract, old.overview);
                INSERT INTO memory_fts(rowid, uri, abstract, overview) 
                VALUES (new.rowid, new.uri, new.abstract, new.overview);
            END;
        ''')
        
        conn.commit()
        conn.close()

    def _uri_to_path(self, uri: str) -> Path:
        if not uri.startswith("fin://"):
            raise ValueError(f"uri supposed to start with fin://, get: {uri}")
        relative_path = uri[6:]
        return self.base_dir / relative_path

    @staticmethod
    def _infer_uri_type(uri: str) -> str:
        try:
            return uri.split("://", 1)[1].split("/", 1)[0]
        except Exception:
            return "unknown"

    def _upsert_index(self, uri: str, abstract: str, overview: str):
        uri_type = self._infer_uri_type(uri)
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute(
            '''
            INSERT INTO memory_index (uri, type, abstract, overview, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(uri) DO UPDATE SET
                abstract=excluded.abstract,
                overview=excluded.overview,
                updated_at=CURRENT_TIMESTAMP
            ''',
            (uri, uri_type, abstract, overview),
        )
        conn.commit()
        conn.close()

    def write_memory(self, uri: str, content: str = "", abstract: str = "", overview: str = ""):
        """
        写入记忆/知识。
            
        Args:
            uri: 目录路径
            content: L2 完整内容
            abstract: L0 摘要
            overview: L1 概览
            
        Returns:
            None
        
        Examples:
            write_memory(uri='fin://sessions/session_001', '...', '...', '...')
        """
        dir_path = self._uri_to_path(uri)
        dir_path.mkdir(parents=True, exist_ok=True)
        
        if content:
            (dir_path / "content.md").write_text(content, encoding="utf-8")
        if abstract:
            (dir_path / ".abstract.md").write_text(abstract, encoding="utf-8")
        if overview:
            (dir_path / ".overview.md").write_text(overview, encoding="utf-8")
            
        # abstract 和 overview 存数据库，content 存文件
        self._upsert_index(uri=uri, abstract=abstract, overview=overview)
        print(f"[MemoryManager] file saved: {uri}")

    def append_session_message(
        self,
        session_id: str,
        role: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        追加一条会话消息到短期记忆（JSONL），并同步更新会话目录的 L2 markdown。

        短期目录结构:
            fin://sessions/{session_id}/
            - messages.jsonl
            - content.md
            - .overview.md (最近若干条)
            
        Args:
            session_id(str): 会话的唯一标识符
            role(str): 角色
            content(str): 具体对话内容
        """
        if not session_id.strip():
            raise ValueError("session_id cannot be empty")
        if role not in {"user", "assistant", "system", "tool"}:
            raise ValueError(f"unsupported role: {role}")

        session_uri = f"fin://sessions/{session_id}"
        session_path = self._uri_to_path(session_uri)
        session_path.mkdir(parents=True, exist_ok=True)

        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        record: dict[str, Any] = {
            "session_id": session_id,
            "role": role,
            "content": content,
            "timestamp": now,
            "metadata": metadata or {},
        }

        jsonl_path = session_path / "messages.jsonl"
        with open(jsonl_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

        md_path = session_path / "content.md"
        with open(md_path, "a", encoding="utf-8") as f:
            f.write(f"### [{record['timestamp']}] {role}\n\n{content}\n\n")

        latest = self.get_session_messages(session_id=session_id, limit=6)
        overview_lines = [
            f"- {m['timestamp']} | {m['role']}: {m['content'][:80].strip()}"
            for m in latest
        ]
        overview = "\n".join(overview_lines) if overview_lines else "No messages yet"

        abstract = self._build_session_abstract(latest)
        (session_path / ".overview.md").write_text(overview, encoding="utf-8")
        (session_path / ".abstract.md").write_text(abstract, encoding="utf-8")
        self._upsert_index(uri=session_uri, abstract=abstract, overview=overview)

        return record

    def _build_session_abstract(self, latest_messages: List[Dict[str, Any]]) -> str:
        if not latest_messages:
            return "Empty session"

        for msg in reversed(latest_messages):
            if msg.get("role") in {"user", "assistant"} and msg.get("content"):
                text = str(msg["content"]).strip().replace("\n", " ")
                return text[:120] + ("..." if len(text) > 120 else "")

        return "Session with non-user/assistant messages"

    def get_session_messages(self, session_id: str, limit: Optional[int] = None) -> List[Dict[str, Any]]:
        """读取会话 JSONL 记录，按写入顺序返回。"""
        session_uri = f"fin://sessions/{session_id}"
        session_path = self._uri_to_path(session_uri)
        jsonl_path = session_path / "messages.jsonl"

        if not jsonl_path.exists():
            return []

        rows: List[Dict[str, Any]] = []
        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue

        if limit is not None and limit > 0:
            return rows[-limit:]
        return rows

    def commit_session_to_long_term(
        self,
        session_id: str,
        agent_role: str = "quant",
        keep_session_files: bool = True,
    ) -> Dict[str, Any]:
        """
        将短期会话记忆转成长期记忆 case（markdown + sqlite 索引）。

        当前实现是规则化抽取（可后续替换为 LLM 抽取）：
        - 生成 case 的 abstract / overview / content
        - 写入 fin://agents/{agent_role}/memories/cases/{case_id}
        - 记录 commit 元数据
        """
        messages = self.get_session_messages(session_id=session_id)
        if not messages:
            return {
                "ok": False,
                "reason": "no messages in session",
                "session_id": session_id,
            }

        extracted = self._extract_case_from_messages(messages)
        case_id = datetime.now(timezone.utc).strftime("case_%Y%m%d_%H%M%S")
        case_uri = f"fin://agents/{agent_role}/memories/cases/{case_id}"

        self.write_memory(
            uri=case_uri,
            content=extracted["content"],
            abstract=extracted["abstract"],
            overview=extracted["overview"],
        )

        session_uri = f"fin://sessions/{session_id}"
        session_path = self._uri_to_path(session_uri)
        commit_note: dict[str, Any] = {
            "committed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "session_id": session_id,
            "case_uri": case_uri,
            "agent_role": agent_role,
            "message_count": len(messages),
        }
        (session_path / "last_commit.json").write_text(
            json.dumps(commit_note, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        if not keep_session_files:
            # 只清理 messages.jsonl，保留 commit 结果与目录结构
            jsonl_path = session_path / "messages.jsonl"
            if jsonl_path.exists():
                jsonl_path.unlink()

        return {
            "ok": True,
            "session_id": session_id,
            "case_uri": case_uri,
            "message_count": len(messages),
        }

    def _extract_case_from_messages(self, messages: List[Dict[str, Any]]) -> Dict[str, str]:
        """
        规则化抽取：
        - abstract: 最后一个 user 问题 + 最后一个 assistant 回答的简述
        - overview: 会话统计 + 关键片段
        - content: 全量 markdown 归档
        """
        user_msgs = [m for m in messages if m.get("role") == "user"]
        assistant_msgs = [m for m in messages if m.get("role") == "assistant"]

        last_user = str(user_msgs[-1]["content"]).strip() if user_msgs else ""
        last_assistant = str(assistant_msgs[-1]["content"]).strip() if assistant_msgs else ""

        if last_user and last_assistant:
            abstract = (
                f"user question: {last_user[:80]}"
                f" - agent answer: {last_assistant[:80]}"
            )
        elif last_user:
            abstract = f"user question: {last_user[:120]}"
        else:
            abstract = "session done, but lack of content."

        overview = (
            f"message_count={len(messages)}\n"
            f"user_count={len(user_msgs)}\n"
            f"assistant_count={len(assistant_msgs)}\n"
            f"last_user={last_user[:200]}\n"
            f"last_assistant={last_assistant[:200]}"
        )

        lines = ["# Session Case Archive", ""]
        for item in messages:
            ts = item.get("timestamp", "")
            role = item.get("role", "unknown")
            content = str(item.get("content", ""))
            lines.append(f"## {ts} [{role}]")
            lines.append("")
            lines.append(content)
            lines.append("")
        content = "\n".join(lines)

        return {
            "abstract": abstract[:300],
            "overview": overview,
            "content": content,
        }

    def read_memory(self, uri: str, level: str = "L2") -> str:
        """
        读取记忆
        
        Args:
            level: L0 (.abstract.md), L1 (.overview.md), L2 (content.md)
            
        Return:
            str: text in the level
        """
        dir_path = self._uri_to_path(uri)
        if not dir_path.exists():
            return f"PathNotFoundError: Can't find the path {uri}"
            
        file_map = {"L0": ".abstract.md", "L1": ".overview.md", "L2": "content.md"}
        target_file = dir_path / file_map.get(level, "content.md")
        
        if not target_file.exists():
            return f"FileNotFoundError: Can't find contents of {level} - ({target_file.name})"
            
        return target_file.read_text(encoding="utf-8")

    def list_dir(self, uri: str) -> str:
        """列出目录内容，附带子目录的 L0 摘要"""
        dir_path = self._uri_to_path(uri)
        if not dir_path.is_dir():
            return f"UriTypeError: {uri} is not a directory or is not exist."
            
        result: List[str] = []
        for item in dir_path.iterdir():
            if item.is_dir():
                abstract_path = item / ".abstract.md"
                abstract = abstract_path.read_text(encoding="utf-8").strip() if abstract_path.exists() else "no abstract"
                if len(abstract) > 50:
                    abstract = abstract[:47] + "..."
                result.append(f"[DIR] {item.name}/ - {abstract}")
            else:
                if not item.name.startswith("."):  # 隐藏内部文件
                    result.append(f"[FILE] {item.name}")
        return "\n".join(result) if result else "Empty dir"

    def search(self, query: str, limit: int = 5) -> List[Dict[str, str]]:
        """全文检索"""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        words = [w for w in query.split() if w.strip()]
        if not words:
            return []
            
        fts_query = " OR ".join([f"{word}*" for word in words])
        
        try:
            cursor.execute('''
                SELECT uri, abstract, overview 
                FROM memory_fts 
                WHERE memory_fts MATCH ? 
                ORDER BY rank 
                LIMIT ?
            ''', (fts_query, limit))
            results = [dict(row) for row in cursor.fetchall()]
        except sqlite3.OperationalError as e:
            print(f"[MemoryManager] Wrong search grammar: {e}")
            results = []
            
        conn.close()
        return results

if __name__ == "__main__":
    mm = MemoryManager(base_dir="./.memory_test")

    # 1) 写入知识
    mm.write_memory(
        uri="fin://knowledge/reports/AAPL/2024/Q3",
        content="# AAPL 2024 Q3 财报\n\n这里是完整财报内容...",
        abstract="AAPL 2024 Q3 财报摘要：营收与利润表现稳健。",
        overview="核心指标：营收、净利润、现金流、毛利率。",
    )

    # 2) 追加短期会话
    mm.append_session_message("session_001", "user", "帮我分析 AAPL 2024 Q3 的现金流质量")
    mm.append_session_message("session_001", "assistant", "先看经营现金流、资本开支和自由现金流。")
    mm.append_session_message("session_001", "user", "再对比上一季度")

    # 3) 检索
    print("\n--- 搜索 memory ---")
    for row in mm.search("AAPL 现金流", limit=5):
        print(row)

    # 4) commit 到长期记忆
    commit_res = mm.commit_session_to_long_term("session_001", agent_role="quant")
    print("\n--- commit result ---")
    print(commit_res)
