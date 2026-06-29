"""
FastAPI 部署应用
提供 ChatService 的 HTTP API 接口
"""

import os
import sys
import sqlite3
import yaml
import logging
import json
import threading
import time
from typing import Optional, Any

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from starlette.responses import JSONResponse
from pydantic import BaseModel

from fastapi.staticfiles import StaticFiles

REPO_ROOT = os.path.realpath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "src"))
sys.path.insert(0, REPO_ROOT)

from core.ChatService import ChatService
from core.RAGManager import RAGManager

# 配置日志
API_LOG_PATH = os.environ.get(
    "FINSAGENT_API_LOG",
    os.path.join(REPO_ROOT, "pe_logs", "api.log"),
)
os.makedirs(os.path.dirname(API_LOG_PATH), exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(API_LOG_PATH),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# 全局变量
chat_service: Optional[ChatService] = None
active_dataset_id: Optional[str] = None

# 入库成功后热重载 RAG + ChatService（方案 B）；与并发入库线程互斥
_chat_stack_reload_lock = threading.Lock()
# 统计仍在处理中的、依赖 chat_service / RAG 的请求数，热重载前尽量等待归零（避免清空 RAGManager 类属性导致并发请求崩溃）
_active_rag_ops = 0
_active_rag_ops_lock = threading.Lock()
_rag_reload_in_progress = False

def load_config():
    """加载配置文件"""
    config_path = os.path.join(os.path.dirname(__file__), '..', 'config', 'production.yaml')
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            config = yaml.safe_load(f)
        return config
    except Exception as e:
        logger.error(f"加载配置文件失败: {e}")
        raise


def _reset_rag_manager_singleton() -> None:
    """清空 RAGManager 单例（与测试脚本 / load_data 子进程用法一致），便于从磁盘重新加载索引。"""
    RAGManager._instance = None
    RAGManager._config = None
    RAGManager._collections = {}
    RAGManager._retrievers = []
    RAGManager._embedding_lock = None


def _path_counts_toward_rag_busy(path: str) -> bool:
    """与 chat_service / RAG 相关的路由，用于热重载前等待空闲。"""
    if path.startswith("/chat"):
        return True
    if path.startswith("/sessions/"):
        return True
    if path.startswith("/metadata/"):
        return True
    if path.startswith("/pdf/"):
        return True
    return False


def _wait_for_rag_idle_unlocked(timeout_sec: float, poll_sec: float = 0.25) -> bool:
    """热重载期间 _rag_reload_in_progress=True，新 RAG 请求会被拒绝；轮询直至在途请求数为 0 或超时。"""
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        with _active_rag_ops_lock:
            if _active_rag_ops == 0:
                return True
        time.sleep(poll_sec)
    with _active_rag_ops_lock:
        still = _active_rag_ops
    logger.warning(
        "等待 RAG 相关请求结束超时（%.1fs），仍有 %s 个在途请求；将继续热重载，存在极低概率并发错误",
        timeout_sec,
        still,
    )
    return False


def _build_chat_stack(config: Optional[dict[str, Any]] = None) -> ChatService:
    """从配置构建 RAGManager + ChatService（启动、热重载、数据集切换共用）。"""
    config = config or load_config()
    logger.info("正在初始化 RAG Manager...")
    collection_name = config.get("collection_name")
    retrieve_top_k = int(config.get("retrieve_top_k"))
    rag_manager = RAGManager(config, collections={collection_name: retrieve_top_k})
    logger.info("正在初始化 Chat Service...")
    return ChatService(
        config=config,
        rag_manager=rag_manager,
        rerank_topk=int(config.get("rerank_top_k", 5)),
        session_timeout=1800,
    )


def _activate_chat_dataset(dataset_id: Optional[str] = None) -> dict[str, Any]:
    """切换单用户当前 ChatService 到指定数据集；空数据集会在 dataset_routes 中返回 409。"""
    global chat_service, active_dataset_id, _rag_reload_in_progress
    dataset = dataset_routes.get_dataset_for_chat(dataset_id)
    target_id = dataset["dataset_id"]
    if chat_service is not None and active_dataset_id == target_id:
        return dataset
    with _chat_stack_reload_lock:
        if chat_service is not None and active_dataset_id == target_id:
            return dataset
        _rag_reload_in_progress = True
        try:
            _reset_rag_manager_singleton()
            config = dataset_routes.config_for_dataset(dataset, load_config())
            chat_service = _build_chat_stack(config)
            active_dataset_id = target_id
            dataset_routes.activate_dataset_in_registry(target_id)
            logger.info("已切换 ChatService 数据集: %s (%s)", dataset.get("name"), target_id)
        finally:
            _rag_reload_in_progress = False
    return dataset


def reload_chat_stack_after_dataset_ingest(dataset_id: str, reason: str) -> bool:
    """入库成功后，仅当该 dataset 是 active dataset 时热重载 ChatService。"""
    global chat_service, active_dataset_id
    flag = os.environ.get("INGEST_AUTO_RELOAD_RAG", "1").strip().lower()
    if flag in ("0", "false", "no", "off"):
        logger.info("INGEST_AUTO_RELOAD_RAG 已关闭，跳过热重载（%s）", reason)
        return False
    if active_dataset_id != dataset_id:
        logger.info(
            "入库 dataset=%s 不是当前 active dataset=%s，跳过热重载（%s）",
            dataset_id,
            active_dataset_id,
            reason,
        )
        return False
    global _rag_reload_in_progress
    with _chat_stack_reload_lock:
        if active_dataset_id != dataset_id:
            return False
        _rag_reload_in_progress = True
        try:
            wait_sec = float(os.environ.get("INGEST_RELOAD_IDLE_WAIT_SEC", "120"))
            if wait_sec > 0:
                logger.info(
                    "热重载前等待在途 RAG 请求结束（最多 %.1fs，INGEST_RELOAD_IDLE_WAIT_SEC；"
                    "期间新的 /chat 等请求将返回 503）",
                    wait_sec,
                )
                _wait_for_rag_idle_unlocked(wait_sec)
            logger.info("热重载 RAG + ChatService（%s）", reason)
            _reset_rag_manager_singleton()
            try:
                dataset = dataset_routes.get_dataset_for_chat(dataset_id)
                config = dataset_routes.config_for_dataset(dataset, load_config())
                chat_service = _build_chat_stack(config)
            except Exception:
                logger.exception("热重载失败，Chat 接口将不可用直至进程重启")
                chat_service = None
                raise
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            logger.info("热重载完成，对话检索已对齐 dataset=%s", dataset_id)
        finally:
            _rag_reload_in_progress = False
    return True


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    global chat_service

    logger.info("🚀 启动 FastAPI 应用...")

    try:
        dataset_routes.init_dataset_registry(load_config())
        try:
            _activate_chat_dataset()
            logger.info("✅ Chat Service 初始化完成")
        except HTTPException as e:
            if e.status_code == 409:
                logger.warning("数据集尚未构建索引，Chat Service 暂不初始化: %s", e.detail)
            else:
                raise

        yield

    except Exception as e:
        logger.error(f"❌ 启动失败: {e}")
        raise
    finally:
        logger.info("🛑 关闭 FastAPI 应用...")
        # 清理资源
        if chat_service:
            del chat_service


# 创建 FastAPI 应用
app = FastAPI(
    title="FinSagent API",
    description="Financial Agent RAG API",
    version="1.0.0",
    lifespan=lifespan
)

# 配置 CORS（允许浏览器跨域访问）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境应该限制具体域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def rag_busy_counter_middleware(request: Request, call_next):
    global _active_rag_ops
    path = request.url.path
    track = _path_counts_toward_rag_busy(path)
    if track:
        if _rag_reload_in_progress:
            return JSONResponse(
                status_code=503,
                content={"detail": "RAG 索引正在热重载，请稍后重试"},
            )
        with _active_rag_ops_lock:
            _active_rag_ops += 1
    try:
        return await call_next(request)
    finally:
        if track:
            with _active_rag_ops_lock:
                _active_rag_ops -= 1


# 请求/响应模型
class ChatRequest(BaseModel):
    """聊天请求"""
    question: str
    session_id: str = "default"
    dataset_id: Optional[str] = None

    class Config:
        json_schema_extra = {
            "example": {
                "question": "极氪2023年的研发费用是多少？",
                "session_id": "user_123",
                "dataset_id": "tesla",
            }
        }


class ChatResponse(BaseModel):
    """聊天响应"""
    answer: str
    session_id: str

    class Config:
        json_schema_extra = {
            "example": {
                "answer": "根据检索到的信息...",
                "session_id": "user_123"
            }
        }


class HealthResponse(BaseModel):
    """健康检查响应"""
    status: str
    message: str
    chat_ready: bool = False
    active_dataset_id: Optional[str] = None


# API 路由
# 注意：不要定义 @app.get("/")，否则会覆盖前端静态文件
# 使用 /health 作为健康检查端点

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """健康检查"""
    registry_active_id = dataset_routes.get_active_dataset_id()
    return HealthResponse(
        status="healthy",
        message="API service is ready" if chat_service is None else "Chat service is ready",
        chat_ready=chat_service is not None,
        active_dataset_id=active_dataset_id or registry_active_id,
    )


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    聊天接口
    """
    try:
        _activate_chat_dataset(request.dataset_id)
        if chat_service is None:
            raise HTTPException(status_code=503, detail="Chat service not initialized")
        logger.info(f"收到请求 - Session: {request.session_id}, Question: {request.question}")

        # 调用 ChatService
        answer, _, _, _ = await chat_service.generate_response_async(
            question=request.question,
            session_id=request.session_id
        )

        logger.info(f"响应完成 - Session: {request.session_id}")

        return ChatResponse(
            answer=answer,
            session_id=request.session_id
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"处理请求失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """
    流式聊天接口 - 实时返回执行流程

    使用 Server-Sent Events (SSE) 格式返回:
    - start: 开始处理
    - orchestrator: 路由选择的代理列表
    - agents: 专家子图完成（包含各代理的子问题、草稿）
    - synthesis: 合成阶段
    - complete: 处理完成
    - error: 错误信息
    """
    _activate_chat_dataset(request.dataset_id)
    if chat_service is None:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    logger.info(f"收到流式请求 - Dataset: {request.dataset_id}, Session: {request.session_id}, Question: {request.question}")

    async def event_generator():
        try:
            async for event in chat_service.generate_response_stream(
                question=request.question,
                session_id=request.session_id
            ):
                # SSE format: "data: {json}\n\n"
                event_data = json.dumps(event, ensure_ascii=False)
                yield f"data: {event_data}\n\n"
        except Exception as e:
            logger.error(f"流式处理失败: {e}", exc_info=True)
            error_event = json.dumps({"event": "error", "data": {"message": str(e)}}, ensure_ascii=False)
            yield f"data: {error_event}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"  # Disable nginx buffering
        }
    )


@app.post("/chat/preview")
async def chat_preview(request: ChatRequest):
    """
    Two-phase preview endpoint (SSE).

    Streams:
      - Rich preview execution-flow events (start / orchestrator / preview_draft / agents / synthesis)
      - {"event": "preliminary", "data": {"answer": "..."}}       – fast general draft
      - {"event": "comprehensive", "data": {"answer": "...", ...}} – deep-dive continuation
      - {"event": "complete", "data": {...}}                         – preview request completed
      - {"event": "error", "data": {"message": "..."}}            – on failure
    """
    _activate_chat_dataset(request.dataset_id)
    if chat_service is None:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    logger.info(f"收到预览请求 - Dataset: {request.dataset_id}, Session: {request.session_id}, Question: {request.question}")

    async def event_generator():
        try:
            async for result in chat_service.generate_response_with_preview(
                question=request.question,
                session_id=request.session_id,
            ):
                if "event" in result and "data" in result:
                    payload = result
                else:
                    phase = result.get("phase")
                    if phase == "preliminary":
                        payload = {"event": "preliminary", "data": {"answer": result["answer"]}}
                    elif phase == "comprehensive":
                        payload = {
                            "event": "comprehensive",
                            "data": {
                                "answer": result["answer"],
                                "selected_agents": result.get("selected_agents", []),
                            },
                        }
                    elif phase == "error":
                        payload = {"event": "error", "data": {"message": result["answer"]}}
                    else:
                        continue
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        except Exception as e:
            logger.error(f"预览流处理失败: {e}", exc_info=True)
            error_payload = json.dumps({"event": "error", "data": {"message": str(e)}}, ensure_ascii=False)
            yield f"data: {error_payload}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/sessions/{session_id}/history")
async def get_history(session_id: str):
    """获取会话历史"""
    if chat_service is None:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    try:
        session_manager = chat_service.get_or_create_session(session_id)
        history = session_manager.get_chat_history_string()

        return {
            "session_id": session_id,
            "history": history
        }
    except Exception as e:
        logger.error(f"获取历史失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/metadata/{collection_name}/{doc_id}")
async def get_metadata(collection_name: str, doc_id: str):
    """返回 Chroma 集合中指定 doc_id 的原始 metadata 和 page_content（JSON）。"""
    if chat_service is None:
        raise HTTPException(status_code=503, detail="Chat service not initialized")
    try:
        # Use RAGManager via chat_service.rag.rag_manager to fetch document by doc_id
        rag_obj = getattr(chat_service, 'rag', None)
        if rag_obj is None or not getattr(rag_obj, 'rag_manager', None):
            raise HTTPException(status_code=500, detail="RAG manager not available")

        rag_manager = rag_obj.rag_manager
        docs = rag_manager.get_collection_documents(collection_name, doc_ids=[doc_id])
        if not docs:
            raise HTTPException(status_code=404, detail=f"doc_id {doc_id} not found in collection {collection_name}")

        # Return the first matched document
        doc = docs[0]

        # Normalize and extract common metadata fields (page number, filename, etc.)
        meta = doc.metadata or {}

        # Try to find a page number under common keys
        page_number = None
        for k in ("page_number", "page", "page_no", "page_num", "pagenumber"):
            if k in meta and meta[k] is not None:
                try:
                    page_number = int(meta[k])
                except Exception:
                    # keep original if cannot cast
                    page_number = meta[k]
                break

        # Try common filename keys
        filename = meta.get('filename') or meta.get('file_name') or meta.get('source') or meta.get('source_id')

        return {
            "doc_id": meta.get('doc_id') or doc_id,
            "page_number": page_number,
            "filename": filename,
            "metadata": meta,
            "page_content": doc.page_content,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to read metadata for {doc_id} in {collection_name}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# 会话持久化相关路由（独立模块）
# ============================================================
import dataset_routes
from session_routes import router as session_router

app.include_router(dataset_routes.router)
app.include_router(session_router)


# ============================================================
# 挂载前端静态文件（必须在所有 API 路由之后）
# ============================================================

# Serve raw PDF files for collections (mapping collection -> filesystem path)
PDF_COLLECTION_PATHS = {
    # collection name (lowercase): absolute path to folder with PDFs
    'zeekr': '/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/raw_pdf'
}


def _get_pdf_index_db_path():
    # data_pipeline/pdf_index.sqlite3 relative to repo root
    return os.path.realpath(os.path.join(os.path.dirname(__file__), '..', 'data_pipeline', 'pdf_index.sqlite3'))


@app.get('/pdf/{collection_name}/{pdf_name}')
async def serve_pdf(collection_name: str, pdf_name: str):
    """Serve a PDF by looking up the path in data_pipeline/pdf_index.sqlite3 first,
    falling back to the configured collection folder if index not available.
    """
    if chat_service is None:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    safe_name = os.path.basename(pdf_name)

    # Try to use sqlite index
    index_db = _get_pdf_index_db_path()
    pdf_real = None
    try:
        if os.path.exists(index_db):
            conn = sqlite3.connect(index_db)
            cur = conn.cursor()

            # 1) exact filename match
            cur.execute('SELECT filepath FROM pdf_index WHERE filename = ? LIMIT 2', (safe_name,))
            rows = cur.fetchall()
            if len(rows) == 1:
                pdf_real = rows[0][0]
            elif len(rows) > 1:
                raise HTTPException(status_code=400, detail=f"Ambiguous PDF filename: {safe_name}")

            # 2) try basename match
            if not pdf_real:
                base = os.path.splitext(safe_name)[0]
                cur.execute('SELECT filepath FROM pdf_index WHERE filename LIKE ? LIMIT 2', (base + '%',))
                rows = cur.fetchall()
                if len(rows) == 1:
                    pdf_real = rows[0][0]
                elif len(rows) > 1:
                    # attempt to find exact basename among candidates
                    for (p,) in rows:
                        if os.path.splitext(os.path.basename(p))[0].lower() == base.lower():
                            pdf_real = p
                            break
                    if not pdf_real:
                        raise HTTPException(status_code=400, detail=f"Ambiguous PDF basename: {base}")

            # 3) try doc_id match (pdf_name may actually be a doc_id)
            if not pdf_real:
                cur.execute('SELECT filepath FROM pdf_index WHERE doc_id = ? LIMIT 2', (safe_name,))
                rows = cur.fetchall()
                if len(rows) == 1:
                    pdf_real = rows[0][0]
                elif len(rows) > 1:
                    raise HTTPException(status_code=400, detail=f"Ambiguous doc_id for PDF: {safe_name}")

            conn.close()

        # Fallback to configured folder mapping
        if not pdf_real:
            root = PDF_COLLECTION_PATHS.get(collection_name.lower())
            if not root:
                raise HTTPException(status_code=404, detail=f"Unknown collection: {collection_name}")
            pdf_path = os.path.join(root, safe_name)
            pdf_real = os.path.realpath(pdf_path)

        # Prevent directory traversal and existence check
        if not os.path.exists(pdf_real):
            raise HTTPException(status_code=404, detail=f"PDF not found: {safe_name}")

        # Ensure the file is under allowed root (if using mapping)
        # If pdf_real was from index_db it should be allowed; still resolve realpath
        root_real = os.path.realpath(PDF_COLLECTION_PATHS.get(collection_name.lower(), os.path.dirname(pdf_real)))
        if not os.path.realpath(pdf_real).startswith(root_real):
            # allow if PDF came from index within data_pipeline
            index_root = os.path.realpath(os.path.join(os.path.dirname(__file__), '..', 'data_pipeline'))
            if not os.path.realpath(pdf_real).startswith(index_root):
                raise HTTPException(status_code=400, detail="Invalid pdf path")

        headers = {
            'Content-Disposition': f'inline; filename="{safe_name}"',
            'Accept-Ranges': 'bytes'
        }
        return FileResponse(pdf_real, media_type='application/pdf', headers=headers)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to serve PDF {pdf_name} for collection {collection_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

frontend_path = os.path.join(os.path.dirname(__file__), 'frontend')
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="frontend")
    logger.info(f"✅ 前端静态文件已挂载: {frontend_path}")
else:
    logger.warning(f"⚠️ 前端目录不存在: {frontend_path}")


if __name__ == "__main__":
    import uvicorn

    # 开发模式运行
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )
