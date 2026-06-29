"""
会话列表、创建、重命名、删除、持久化消息等路由。

依赖主模块中的 `session_history_db` 配置。日期/侧栏分组由前端根据
`created_at` / `updated_at` 自行处理。
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import List, Optional

import app as app_module
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from utils.session_history_store import SessionHistoryStore

router = APIRouter(tags=["sessions"])
_session_store: Optional[SessionHistoryStore] = None
_session_store_path: Optional[str] = None


def _require_session_store() -> SessionHistoryStore:
    global _session_store, _session_store_path
    config = app_module.load_config()
    db_path = str(config.get("session_history_db") or "").strip()
    if not db_path:
        raise HTTPException(
            status_code=503,
            detail="Session history is not configured (set session_history_db in config)",
        )
    resolved = str(Path(db_path).expanduser().resolve())
    Path(resolved).parent.mkdir(parents=True, exist_ok=True)
    if _session_store is None or _session_store_path != resolved:
        _session_store = SessionHistoryStore(resolved)
        _session_store_path = resolved
    return _session_store


class SessionListItem(BaseModel):
    id: str
    title: str
    created_at: str
    updated_at: str


class SessionListResponse(BaseModel):
    sessions: List[SessionListItem]


class SessionIdResponse(BaseModel):
    """分配新会话 id；若已配置 session_history_db，会同步插入默认 sessions 行（侧栏可立即展示）。"""

    id: str


class SessionPatchRequest(BaseModel):
    title: str


class PersistedMessageItem(BaseModel):
    id: int
    question: str
    draft_answer: Optional[str] = None
    final_answer: Optional[str] = None
    activated_agents: List[str] = Field(default_factory=list)
    is_off_topic: bool = False
    sort_key: int
    created_at: str


class SessionMessagesResponse(BaseModel):
    session_id: str
    messages: List[PersistedMessageItem]


@router.get("/sessions", response_model=SessionListResponse)
async def list_chat_sessions():
    """侧栏会话列表，按 `updated_at` 降序；日期分组由前端用 `created_at`/`updated_at` 计算。"""
    store = _require_session_store()
    rows = await asyncio.to_thread(store.list_sessions)
    items = [
        SessionListItem(
            id=r["id"],
            title=r["title"],
            created_at=r["created_at"],
            updated_at=r["updated_at"],
        )
        for r in rows
    ]
    return SessionListResponse(sessions=items)


_DEFAULT_NEW_SESSION_TITLE = "新对话"


@router.post("/sessions", response_model=SessionIdResponse, status_code=201)
async def allocate_session_id():
    """生成 session_id，并写入一条默认 sessions 行（无消息），便于侧栏立即展示、长流程中可切换回来。

    首轮对话持久化后由 ChatService 按需更新标题；响应体仍只含 id。
    """
    sid = str(uuid.uuid4())
    store = _require_session_store()
    await asyncio.to_thread(store.create_empty_session, sid, _DEFAULT_NEW_SESSION_TITLE)
    return SessionIdResponse(id=sid)


@router.get("/sessions/{session_id}/messages", response_model=SessionMessagesResponse)
async def get_session_messages_persisted(session_id: str):
    """从 SQLite 读取该会话下全部轮次。尚未落库、仅已分配 id 的会话返回空列表。"""
    store = _require_session_store()
    meta = await asyncio.to_thread(store.get_session, session_id)
    if meta is not None and meta.get("is_deleted"):
        raise HTTPException(status_code=404, detail="Session not found or deleted")
    if meta is None:
        return SessionMessagesResponse(session_id=session_id, messages=[])
    raw = await asyncio.to_thread(store.fetch_messages_if_active, session_id)
    if raw is None:
        return SessionMessagesResponse(session_id=session_id, messages=[])
    messages = [
        PersistedMessageItem(
            id=m["id"],
            question=m["question"],
            draft_answer=m.get("draft_answer"),
            final_answer=m.get("final_answer"),
            activated_agents=m.get("activated_agents") or [],
            is_off_topic=bool(m.get("is_off_topic", 0)),
            sort_key=m["sort_key"],
            created_at=m["created_at"],
        )
        for m in raw
    ]
    return SessionMessagesResponse(session_id=session_id, messages=messages)


@router.patch("/sessions/{session_id}")
async def patch_session_title(session_id: str, body: SessionPatchRequest):
    """重命名会话（侧栏更多菜单）。"""
    store = _require_session_store()
    ok = await asyncio.to_thread(store.update_session_title, session_id, body.title)
    if not ok:
        raise HTTPException(status_code=404, detail="Session not found or deleted")
    row = await asyncio.to_thread(store.get_session, session_id)
    if not row or row.get("is_deleted"):
        raise HTTPException(status_code=404, detail="Session not found or deleted")
    return {
        "id": row["id"],
        "title": row["title"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_chat_session(session_id: str):
    """软删除会话；侧栏不再展示。"""
    store = _require_session_store()
    ok = await asyncio.to_thread(store.soft_delete_session, session_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Session not found")
    return Response(status_code=204)
