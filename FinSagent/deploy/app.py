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
import uuid
import subprocess
import threading
import time
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Any

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks, File, UploadFile, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from starlette.responses import JSONResponse
from pydantic import BaseModel

from fastapi.staticfiles import StaticFiles

DEPLOY_ROOT = os.path.realpath(os.path.dirname(__file__))
REPO_ROOT = os.path.realpath(os.path.join(DEPLOY_ROOT, ".."))
PROJECT_ROOT = os.path.realpath(os.path.join(REPO_ROOT, ".."))
PDF_RESEARCH_SRC = os.path.join(PROJECT_ROOT, "src")
if PDF_RESEARCH_SRC not in sys.path:
    sys.path.insert(0, PDF_RESEARCH_SRC)
if DEPLOY_ROOT not in sys.path:
    sys.path.insert(0, DEPLOY_ROOT)
sys.path.insert(0, os.path.join(REPO_ROOT, "src"))
sys.path.insert(0, REPO_ROOT)

CORE_IMPORT_ERROR: Optional[BaseException] = None
try:
    from core.ChatService import ChatService
    from core.RAGManager import RAGManager
    from doc_agent import DocumentTriageAgent
except Exception as exc:
    ChatService = None
    RAGManager = None
    DocumentTriageAgent = None
    CORE_IMPORT_ERROR = exc
from pdf_research_demo import PdfResearchDemo
from pdf_research_demo.llm import OpenAICompatibleChatClient, load_llm_config
from utils.session_history_store import SessionHistoryStore

from data_pipeline.ingest_documents_db import (
    fetch_job_snapshot,
    fetch_recent_jobs_page,
    resolve_db_path,
    try_insert_document_rows,
    try_update_job_documents,
)

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
chat_service: Optional[Any] = None
pdf_research_demo: Optional[PdfResearchDemo] = None
pdf_research_document: Optional[Any] = None
pdf_research_llm_summary: dict[str, Any] = {}
pdf_research_init_error: Optional[str] = None
pdf_research_lock = threading.Lock()
fallback_session_history_store: Optional[SessionHistoryStore] = None
fallback_session_history_lock = threading.Lock()

# 入库成功后热重载 RAG + ChatService（方案 B）；与并发入库线程互斥
_chat_stack_reload_lock = threading.Lock()
# 统计仍在处理中的、依赖 chat_service / RAG 的请求数，热重载前尽量等待归零（避免清空 RAGManager 类属性导致并发请求崩溃）
_active_rag_ops = 0
_active_rag_ops_lock = threading.Lock()
_rag_reload_in_progress = False

# 文档入库异步任务（子进程跑 file2chunk2data_pipeline，避免破坏当前进程的 RAGManager 单例）
DATA_PIPELINE_DIR = os.path.join(REPO_ROOT, "data_pipeline")
INGEST_SCRIPT = os.path.join(DATA_PIPELINE_DIR, "file2chunk2data_pipeline.py")
CONFIG_PATH = os.path.join(REPO_ROOT, "config", "production.yaml")
PDF_RESEARCH_PDF_PATH = os.environ.get(
    "PDF_RESEARCH_PDF_PATH",
    os.path.join(PROJECT_ROOT, "tesla_extracted", "20260129_10-K_0001628280-26-003952.pdf"),
)
PDF_RESEARCH_TEXT_PATH = os.environ.get(
    "PDF_RESEARCH_TEXT_PATH",
    os.path.join(PROJECT_ROOT, "tmp", "pdfs", "tesla_text", "20260129_10-K_0001628280-26-003952.txt"),
)
FALLBACK_SESSION_HISTORY_DB = os.environ.get(
    "FINSAGENT_SESSION_HISTORY_DB",
    os.path.join(DEPLOY_ROOT, ".memory", "research_sessions.sqlite3"),
)
_ingest_jobs_lock = threading.Lock()
_ingest_jobs: dict[str, dict[str, Any]] = {}
# 每个入库任务独立日志文件，避免多请求并发写同一文件导致错乱。可通过环境变量覆盖目录。
INGEST_LOG_DIR = os.environ.get(
    "INGEST_LOG_DIR",
    os.path.join(REPO_ROOT, "pe_logs", "ingest_jobs"),
).rstrip(os.sep)
os.makedirs(INGEST_LOG_DIR, exist_ok=True)


def _ingest_job_log_path(job_id: str) -> str:
    return os.path.join(INGEST_LOG_DIR, f"{job_id}.log")


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


def load_doc_agent_config() -> dict[str, Any]:
    """加载文档分诊 agent 配置；缺少 production.yaml 时允许用环境变量测试。"""
    try:
        config = load_config()
    except Exception:
        config = {}
    env_overrides = {
        "llm_base_url": os.environ.get("LLM_BASE_URL") or os.environ.get("OPENAI_BASE_URL"),
        "llm_api_key": os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY"),
        "llm_model_name": os.environ.get("LLM_MODEL_NAME") or os.environ.get("OPENAI_MODEL"),
    }
    for key, value in env_overrides.items():
        if value:
            config[key] = value
    return config


def _reset_rag_manager_singleton() -> None:
    """清空 RAGManager 单例（与测试脚本 / load_data 子进程用法一致），便于从磁盘重新加载索引。"""
    if RAGManager is None:
        raise RuntimeError(f"RAGManager dependency unavailable: {CORE_IMPORT_ERROR}")
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


def _build_chat_stack() -> Any:
    """从 production.yaml 构建 RAGManager + ChatService（启动与热重载共用）。"""
    if ChatService is None or RAGManager is None:
        raise RuntimeError(f"ChatService dependencies unavailable: {CORE_IMPORT_ERROR}")
    config = load_config()
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


def _reload_chat_stack_after_ingest(reason: str) -> bool:
    """
    入库子进程成功更新磁盘索引后，在本进程内重置单例并重建 ChatService。
    可通过环境变量 INGEST_AUTO_RELOAD_RAG=0 关闭（返回 False）。

    Returns:
        True 若已执行热重载；False 若因环境变量跳过。
    """
    global chat_service
    flag = os.environ.get("INGEST_AUTO_RELOAD_RAG", "1").strip().lower()
    if flag in ("0", "false", "no", "off"):
        logger.info("INGEST_AUTO_RELOAD_RAG 已关闭，跳过热重载（%s）", reason)
        return False
    global _rag_reload_in_progress
    with _chat_stack_reload_lock:
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
            logger.info("♻️ 热重载 RAG + ChatService（%s）", reason)
            _reset_rag_manager_singleton()
            try:
                chat_service = _build_chat_stack()
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
            logger.info("✅ 热重载完成，对话检索已对齐磁盘索引")
        finally:
            _rag_reload_in_progress = False
    return True


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    global chat_service

    logger.info("🚀 启动 FastAPI 应用...")

    try:
        skip_chat_init = os.environ.get("FINSAGENT_SKIP_CHAT_INIT", "").strip().lower() in ("1", "true", "yes", "on")
        if skip_chat_init:
            chat_service = None
            logger.warning("FINSAGENT_SKIP_CHAT_INIT 已开启，跳过 ChatService 初始化；PDF Research 与静态 UI 仍可用")
        else:
            chat_service = _build_chat_stack()
            logger.info("✅ Chat Service 初始化完成")

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

    class Config:
        json_schema_extra = {
            "example": {
                "question": "极氪2023年的研发费用是多少？",
                "session_id": "user_123",
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


class PdfResearchAskRequest(BaseModel):
    question: str
    session_id: str = "default"


class PdfResearchMemoRequest(BaseModel):
    company_name: str = "Tesla, Inc."
    ticker: str = "TSLA"


def _jsonable(value: Any) -> Any:
    if hasattr(value, "to_dict"):
        return _jsonable(value.to_dict())
    if is_dataclass(value):
        return _jsonable(asdict(value))
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _pdf_research_trace_payload(demo: PdfResearchDemo, citations: list[Any]) -> list[dict[str, Any]]:
    return [_jsonable(demo.trace_citation(citation.citation_id)) for citation in citations]


def _get_pdf_research_stack() -> tuple[PdfResearchDemo, Any, dict[str, Any]]:
    """Lazily load the local PDF evidence demo and its configured real LLM."""
    global pdf_research_demo, pdf_research_document, pdf_research_llm_summary, pdf_research_init_error
    with pdf_research_lock:
        if pdf_research_demo is not None and pdf_research_document is not None:
            return pdf_research_demo, pdf_research_document, pdf_research_llm_summary

        try:
            llm_config = load_llm_config(CONFIG_PATH)
            llm_client = OpenAICompatibleChatClient(llm_config) if llm_config else None
            demo = PdfResearchDemo(llm_client=llm_client)
            document = demo.ingest_pdf(PDF_RESEARCH_PDF_PATH, PDF_RESEARCH_TEXT_PATH)
            pdf_research_demo = demo
            pdf_research_document = document
            pdf_research_llm_summary = (
                llm_config.safe_summary()
                if llm_config
                else {"enabled": False, "model_name": "", "base_url": "", "source": CONFIG_PATH}
            )
            pdf_research_init_error = None
            logger.info(
                "PDF Research initialized: pdf=%s evidence=%s llm=%s",
                PDF_RESEARCH_PDF_PATH,
                len(demo.store.evidence),
                pdf_research_llm_summary.get("model_name") or "disabled",
            )
            return demo, document, pdf_research_llm_summary
        except Exception as exc:
            pdf_research_init_error = str(exc)
            logger.error("PDF Research 初始化失败: %s", exc, exc_info=True)
            raise HTTPException(status_code=500, detail=f"PDF Research 初始化失败: {exc}") from exc


def get_session_history_store() -> SessionHistoryStore:
    """Return the main ChatService session store or a lightweight research fallback store."""
    global fallback_session_history_store
    store = getattr(chat_service, "session_history_store", None) if chat_service is not None else None
    if store is not None:
        return store

    with fallback_session_history_lock:
        if fallback_session_history_store is None:
            path = Path(FALLBACK_SESSION_HISTORY_DB).expanduser().resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            fallback_session_history_store = SessionHistoryStore(str(path))
            logger.info("Research fallback session DB: %s", path)
        return fallback_session_history_store


def _history_answer_with_citations(answer: str, citations: list[Any]) -> str:
    lines = [(answer or "").strip()]
    if citations:
        lines.extend(["", "Citations:"])
        for citation in citations:
            lines.append(f"- `{citation.citation_id}`: {citation.display}")
    return "\n".join(lines).strip()


def _pdf_research_answer_payload(question: str, session_id: str) -> dict[str, Any]:
    demo, _, _ = _get_pdf_research_stack()
    with pdf_research_lock:
        result = demo.answer_question(question)
        try:
            store = get_session_history_store()
            store.append_turn(
                session_id=session_id,
                question=question,
                draft_answer=None,
                final_answer=_history_answer_with_citations(result.answer, result.citations),
                activated_agents=["pdf_research"],
                is_off_topic=False,
            )
        except Exception:
            logger.warning("PDF Research session persist failed", exc_info=True)
        return {
            "question": result.question,
            "answer": result.answer,
            "needs_review": result.needs_review,
            "llm_used": result.llm_used,
            "llm_error": result.llm_error,
            "citations": _jsonable(result.citations),
            "traces": _pdf_research_trace_payload(demo, result.citations),
        }


def _conda_base_bin_for_python() -> Optional[str]:
    """
    若当前解释器位于 miniconda/mamba 的 envs/<name>/bin/python，则返回安装根目录下的 bin
    （许多工具只装在 base env，子环境 PATH 里找不到 mineru）。
    """
    try:
        exe = Path(sys.executable).resolve()
        parts = exe.parts
        if "envs" not in parts:
            return None
        i = parts.index("envs")
        root = Path(*parts[:i])
        b = root / "bin"
        return str(b) if b.is_dir() else None
    except (ValueError, OSError):
        return None


def _safe_upload_basename(name: Optional[str]) -> str:
    base = os.path.basename(name or "upload.pdf")
    if ".." in base or base.startswith("."):
        base = "upload.pdf"
    if not base.lower().endswith(".pdf"):
        base = base + ".pdf"
    return f"{uuid.uuid4().hex[:10]}_{base}"


def _read_log_tail(path: str, max_bytes: int = 2000) -> str:
    """读取日志文件最后 max_bytes 字节，文件不存在时返回空字符串。"""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def _ingest_subprocess_worker(
    job_id: str,
    pdf_paths: list[str],
    extra_args: list[str],
    documents_db_path: str,
) -> None:
    """在后台线程中启动子进程执行流水线，不修改当前 uvicorn 进程内的 RAGManager。

    pdf_paths 支持批量；每个 PDF 以 ``--pdf <path>`` 透传给 v2 脚本。
    """
    job_log = _ingest_job_log_path(job_id)
    with _ingest_jobs_lock:
        _ingest_jobs[job_id]["status"] = "running"
        _ingest_jobs[job_id]["started_at"] = datetime.now(timezone.utc).isoformat()
        _ingest_jobs[job_id]["log_file"] = job_log

    try_update_job_documents(documents_db_path, job_id, "running", None, None)

    env = os.environ.copy()
    env["INGEST_LOG_FILE"] = job_log
    base_bin = _conda_base_bin_for_python()
    if base_bin:
        env["PATH"] = base_bin + os.pathsep + env.get("PATH", "")
    src_path = os.path.join(REPO_ROOT, "src")
    env["PYTHONPATH"] = src_path + os.pathsep + DATA_PIPELINE_DIR + os.pathsep + env.get("PYTHONPATH", "")

    cmd: list[str] = [sys.executable, INGEST_SCRIPT, "--config", CONFIG_PATH]
    for p in pdf_paths:
        cmd += ["--pdf", p]
    cmd += extra_args
    logger.info("[ingest %s] log=%s %s", job_id, job_log, " ".join(cmd))

    try:
        os.makedirs(INGEST_LOG_DIR, exist_ok=True)
        with open(job_log, "w", encoding="utf-8") as log_f:
            log_f.write(f"{'='*60}\n[ingest {job_id}] started at {datetime.now(timezone.utc).isoformat()}\n")
            log_f.write("CMD: " + " ".join(cmd) + "\n\n")
            log_f.flush()
            proc = subprocess.run(
                cmd,
                cwd=REPO_ROOT,
                env=env,
                stdout=log_f,
                stderr=subprocess.STDOUT,
                timeout=None,
            )
        final_msg: str | None = None
        final_status: str
        if proc.returncode == 0:
            final_status = "completed"
            skip_load = "--skip-load" in extra_args
            if not skip_load:
                try:
                    did_reload = _reload_chat_stack_after_ingest(f"ingest job_id={job_id}")
                    if did_reload:
                        final_msg = (
                            "流水线已完成；磁盘 Chroma/BM25 已更新，"
                            "本 API 进程内检索索引已热重载，可直接对话检索新数据。"
                        )
                    else:
                        final_msg = (
                            "流水线已完成；磁盘 Chroma/BM25 已更新。"
                            "INGEST_AUTO_RELOAD_RAG 已关闭，未热重载内存索引；"
                            "请重启 API 或开启该环境变量后重新入库一次。"
                        )
                except Exception as reload_exc:
                    logger.exception("[ingest %s] 入库成功但热重载失败", job_id)
                    final_msg = (
                        "流水线已完成且磁盘索引已更新，但本进程热重载失败："
                        f"{reload_exc!s}。请重启 API 服务后再试检索。"
                    )
            else:
                final_msg = (
                    "流水线已完成（已跳过向量入库 --skip-load）；"
                    "未执行热重载。"
                )
        else:
            tail = _read_log_tail(job_log, 2000)
            final_status = "failed"
            final_msg = f"子进程非零退出（code {proc.returncode}）。错误尾部：\n{tail}"

        with _ingest_jobs_lock:
            _ingest_jobs[job_id]["returncode"] = proc.returncode
            _ingest_jobs[job_id]["log_file"] = job_log
            _ingest_jobs[job_id]["status"] = final_status
            _ingest_jobs[job_id]["message"] = final_msg
        try_update_job_documents(
            documents_db_path,
            job_id,
            final_status,
            final_msg,
            proc.returncode,
        )
    except Exception as e:
        logger.exception("[ingest %s] failed", job_id)
        with _ingest_jobs_lock:
            _ingest_jobs[job_id]["status"] = "failed"
            _ingest_jobs[job_id]["message"] = str(e)
        try_update_job_documents(documents_db_path, job_id, "failed", str(e), None)
    finally:
        with _ingest_jobs_lock:
            _ingest_jobs[job_id]["finished_at"] = datetime.now(timezone.utc).isoformat()


def _schedule_ingest(
    job_id: str,
    pdf_paths: list[str],
    extra_args: list[str],
    documents_db_path: str,
) -> None:
    """供 BackgroundTasks 调用的同步入口。"""
    t = threading.Thread(
        target=_ingest_subprocess_worker,
        args=(job_id, pdf_paths, extra_args, documents_db_path),
        daemon=True,
    )
    t.start()


# API 路由
# 注意：不要定义 @app.get("/")，否则会覆盖前端静态文件
# 使用 /health 作为健康检查端点

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """健康检查"""
    if chat_service is None:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    return HealthResponse(
        status="healthy",
        message="Chat service is ready"
    )


@app.get("/pdf-research/health")
async def pdf_research_health():
    """本地 PDF Research 工作台状态。"""
    demo, document, llm_summary = _get_pdf_research_stack()
    return {
        "status": "ok",
        "document": document.to_dict(),
        "pdf_path": PDF_RESEARCH_PDF_PATH,
        "text_path": PDF_RESEARCH_TEXT_PATH,
        "evidence_count": len(demo.store.evidence),
        "citation_count": len(demo.store.citations),
        "llm": llm_summary,
        "init_error": pdf_research_init_error,
    }


@app.post("/pdf-research/ask")
async def pdf_research_ask(request: PdfResearchAskRequest):
    """基于本地 PDF evidence 检索后调用真实 LLM 回答，并保留 citation trace。"""
    question = request.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is required.")
    session_id = (request.session_id or "default").strip() or "default"
    return _pdf_research_answer_payload(question, session_id)


@app.post("/pdf-research/memo")
async def pdf_research_memo(request: PdfResearchMemoRequest):
    """基于本地 PDF evidence 生成带 citation 的 memo。"""
    company_name = request.company_name.strip()
    ticker = request.ticker.strip()
    if not company_name or not ticker:
        raise HTTPException(status_code=400, detail="Company name and ticker are required.")
    demo, _, _ = _get_pdf_research_stack()
    with pdf_research_lock:
        memo = demo.generate_memo(company_name, ticker)
        return {
            "memo_id": memo.memo_id,
            "title": memo.title,
            "markdown": memo.to_markdown(),
            "sections": _jsonable(memo.sections),
            "llm_used": memo.llm_used,
            "llm_error": memo.llm_error,
            "citations": _jsonable(memo.citations),
            "traces": _pdf_research_trace_payload(demo, memo.citations),
        }


@app.get("/pdf-research/trace/{citation_id}")
async def pdf_research_trace(citation_id: str):
    """从 citation_id 回溯到本地 PDF evidence / document version / page / paragraph。"""
    demo, _, _ = _get_pdf_research_stack()
    with pdf_research_lock:
        trace = demo.trace_citation(citation_id)
    if not trace:
        raise HTTPException(status_code=404, detail="Citation not found.")
    return _jsonable(trace)


@app.post("/doc-agent/analyze")
async def doc_agent_analyze(
    file: UploadFile = File(..., description="待识别和摘要的文档，支持 PDF/DOCX/TXT/MD/HTML/JSON 等"),
    use_llm: bool = Query(True, description="是否调用 LLM；关闭后只使用规则兜底"),
):
    """测试阶段文档分诊 agent：上传单个文档，返回类型识别和 summary。"""
    body = await file.read()
    if not body:
        raise HTTPException(status_code=400, detail="空文件")
    config = load_doc_agent_config()
    if DocumentTriageAgent is None:
        raise HTTPException(status_code=503, detail=f"Document agent dependencies unavailable: {CORE_IMPORT_ERROR}")
    agent = DocumentTriageAgent(config)
    try:
        return await agent.analyze_upload(file.filename or "upload", body, use_llm=use_llm)
    except Exception as e:
        logger.error("文档分诊失败: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/doc-agent/analyze-batch")
async def doc_agent_analyze_batch(
    files: list[UploadFile] = File(..., description="待批量识别和摘要的文档"),
    use_llm: bool = Query(True, description="是否调用 LLM；关闭后只使用规则兜底"),
):
    """测试阶段文档分诊 agent：批量上传文档，逐个返回类型识别和 summary。"""
    if not files:
        raise HTTPException(status_code=400, detail="未提供任何文件")
    config = load_doc_agent_config()
    if DocumentTriageAgent is None:
        raise HTTPException(status_code=503, detail=f"Document agent dependencies unavailable: {CORE_IMPORT_ERROR}")
    agent = DocumentTriageAgent(config)
    results = []
    for uploaded in files:
        body = await uploaded.read()
        if not body:
            results.append(
                {
                    "filename": uploaded.filename or "upload",
                    "error": "空文件",
                }
            )
            continue
        try:
            results.append(await agent.analyze_upload(uploaded.filename or "upload", body, use_llm=use_llm))
        except Exception as e:
            logger.warning("文档分诊失败 filename=%s: %s", uploaded.filename, e, exc_info=True)
            results.append(
                {
                    "filename": uploaded.filename or "upload",
                    "error": str(e),
                }
            )
    return {"count": len(results), "results": results}


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """
    聊天接口
    """
    if chat_service is None:
        raise HTTPException(status_code=503, detail="Chat service not initialized")

    try:
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
    logger.info(f"收到流式请求 - Session: {request.session_id}, Question: {request.question}")

    async def event_generator():
        try:
            if chat_service is None:
                yield f"data: {json.dumps({'event': 'start', 'data': {'message': 'Research started'}}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'event': 'orchestrator', 'data': {'selected_agents': ['pdf_research'], 'routing_reason': '主 RAG 未初始化，使用本地 PDF evidence research fallback。'}}, ensure_ascii=False)}\n\n"
                result = _pdf_research_answer_payload(request.question, request.session_id)
                agent_payload = {
                    "agent_outputs": [
                        {
                            "agent": "pdf_research",
                            "sub_queries": [request.question],
                            "draft_answer": result["answer"],
                            "evidence_count": len(result["citations"]),
                            "evidence": result["citations"],
                            "tool_results": {},
                        }
                    ]
                }
                yield f"data: {json.dumps({'event': 'agents', 'data': agent_payload}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'event': 'synthesis', 'data': {'final_answer': result['answer']}}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'event': 'complete', 'data': {'final_answer': result['answer']}}, ensure_ascii=False)}\n\n"
                return
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
    logger.info(f"收到预览请求 - Session: {request.session_id}, Question: {request.question}")

    async def event_generator():
        try:
            if chat_service is None:
                yield f"data: {json.dumps({'event': 'start', 'data': {'message': 'Research started'}}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'event': 'orchestrator', 'data': {'selected_agents': ['pdf_research'], 'routing_reason': '主 RAG 未初始化，使用本地 PDF evidence research fallback。'}}, ensure_ascii=False)}\n\n"
                result = _pdf_research_answer_payload(request.question, request.session_id)
                draft_payload = {
                    "stage": "finalize",
                    "message": "本地 PDF evidence 检索完成",
                    "evidence_count": len(result["citations"]),
                }
                yield f"data: {json.dumps({'event': 'preview_draft', 'data': draft_payload}, ensure_ascii=False)}\n\n"
                comprehensive_payload = {
                    "answer": result["answer"],
                    "selected_agents": ["pdf_research"],
                }
                yield f"data: {json.dumps({'event': 'comprehensive', 'data': comprehensive_payload}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'event': 'complete', 'data': {'final_answer': result['answer']}}, ensure_ascii=False)}\n\n"
                return
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


@app.post("/ingest/upload")
async def ingest_upload(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(..., description="PDF 文件（支持多文件批量）"),
    company_name: str = Query("", description="公司名（step2_v2 / step6 必需，省略则回退 config['collection_name']）"),
    mineru_bin: str = Query("", description="mineru 可执行文件绝对路径；空则用 production.yaml mineru_bin 或脚本默认 DEFAULT_MINERU_BIN"),
    skip_mineru: bool = Query(False, description="已存在 mineru 输出时跳过"),
    skip_file2chunk: bool = Query(False, description="已有 base_final 时跳过 file2chunk"),
    skip_process_table: bool = Query(False, description="跳过 Step 3 process_table（连不上 Anthropic 时使用）"),
    skip_load: bool = Query(False, description="只生成 JSON，不写向量库"),
    skip_load_table: bool = Query(False, description="跳过 Step 5 load_table_chroma，不写 table_chroma"),
    skip_pageindex: bool = Query(False, description="跳过 Step 6 PageIndex 构建（输出至 {persist_directory}/pageindex/）"),
    reset_persist: bool = Query(False, description="入库前删除 persist_directory（慎用）"),
):
    """
    批量上传 PDF，异步执行 `data_pipeline/file2chunk2data_pipeline.py`（子进程），
    不阻塞当前请求。一次 job 处理本次上传的所有文件，最后只做一次 load_data 入库。

    每个任务单独写入 ``INGEST_LOG_DIR/<job_id>.log``（默认目录见环境变量说明），避免多任务共写一份日志错乱。

    完成后磁盘上的库会更新；默认（``INGEST_AUTO_RELOAD_RAG`` 未设为 0）会在本进程内**热重载** RAG 与 ChatService，
    无需重启即可检索新数据。若关闭自动热重载或热重载失败，则需重启 API。
    """
    if not os.path.isfile(INGEST_SCRIPT):
        raise HTTPException(status_code=500, detail=f"未找到入库脚本: {INGEST_SCRIPT}")

    if not files:
        raise HTTPException(status_code=400, detail="未提供任何文件")

    cfg = load_config()
    persist = Path(cfg["persist_directory"]).resolve()
    dataset_root = persist.parent
    # 与 v2 DatasetLayout 严格对齐：0_raw_pdf
    raw_pdf_dir = dataset_root / "0_raw_pdf"
    raw_pdf_dir.mkdir(parents=True, exist_ok=True)

    max_bytes = int(os.environ.get("INGEST_MAX_UPLOAD_MB", "200")) * 1024 * 1024
    saved_entries: list[tuple[str, str, Path]] = []
    for f in files:
        body = await f.read()
        if not body:
            raise HTTPException(status_code=400, detail=f"空文件: {f.filename}")
        if len(body) > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"{f.filename} 超过单文件限制 {max_bytes // (1024 * 1024)} MB",
            )
        safe_name = _safe_upload_basename(f.filename)
        dest_path = raw_pdf_dir / safe_name
        with open(dest_path, "wb") as out_f:
            out_f.write(body)
        orig_name = (f.filename or "upload.pdf").strip() or "upload.pdf"
        saved_entries.append((orig_name, safe_name, dest_path.resolve()))

    job_id = uuid.uuid4().hex[:16]
    job_log = _ingest_job_log_path(job_id)
    documents_db_path = str(resolve_db_path(dataset_root))
    uploaded_at = datetime.now(timezone.utc).isoformat()
    collection_name = cfg.get("collection_name")
    try_insert_document_rows(
        documents_db_path,
        [
            {
                "job_id": job_id,
                "original_filename": orig,
                "stored_basename": safe,
                "stored_path": str(path),
                "status": "queued",
                "collection_name": collection_name,
                "uploaded_at": uploaded_at,
                "returncode": None,
                "message": None,
                "log_file": job_log,
            }
            for orig, safe, path in saved_entries
        ],
    )

    saved_paths = [path for _, _, path in saved_entries]
    with _ingest_jobs_lock:
        _ingest_jobs[job_id] = {
            "status": "queued",
            "saved_paths": [str(p) for p in saved_paths],
            "file_count": len(saved_paths),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "log_file": job_log,
        }

    extra: list[str] = []
    if company_name.strip():
        extra.extend(["--company-name", company_name.strip()])
    mb = (mineru_bin or "").strip() or (str(cfg.get("mineru_bin") or "")).strip()
    if mb:
        extra.extend(["--mineru-bin", mb])
    if skip_mineru:
        extra.append("--skip-mineru")
    if skip_file2chunk:
        extra.append("--skip-file2chunk")
    if skip_process_table:
        extra.append("--skip-process-table")
    if skip_load:
        extra.append("--skip-load")
    if skip_load_table:
        extra.append("--skip-load-table")
    if skip_pageindex:
        extra.append("--skip-pageindex")
    if reset_persist:
        extra.append("--reset-persist")

    background_tasks.add_task(
        _schedule_ingest,
        job_id,
        [str(p) for p in saved_paths],
        extra,
        documents_db_path,
    )

    return {
        "job_id": job_id,
        "status": "queued",
        "file_count": len(saved_paths),
        "saved_paths": [str(p) for p in saved_paths],
        "log_file": job_log,
        "message": (
            "已排队批量异步入库；可用 GET /ingest/jobs/{job_id} 查询状态。"
            f" 本任务日志：{job_log}。"
            "完成后默认会自动热重载检索索引（可通过 INGEST_AUTO_RELOAD_RAG=0 关闭）。"
        ),
    }


@app.get("/ingest/jobs/{job_id}")
async def ingest_job_status(job_id: str):
    """查询异步入库任务状态。"""
    with _ingest_jobs_lock:
        job = _ingest_jobs.get(job_id)
    if job:
        return dict(job)

    cfg = load_config()
    persist = Path(cfg["persist_directory"]).resolve()
    dataset_root = persist.parent
    db_path = resolve_db_path(dataset_root)
    if not db_path.is_file():
        raise HTTPException(status_code=404, detail="未知 job_id")
    snap = fetch_job_snapshot(db_path, job_id)
    if not snap:
        raise HTTPException(status_code=404, detail="未知 job_id")
    return {"job_id": job_id, **snap}


@app.get("/ingest/jobs")
async def ingest_jobs_list(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
):
    """历史入库任务分页列表（``meta/ingest_documents.db``，按批次最近上传时间倒序；每任务含 ``files``）。"""
    cfg = load_config()
    persist = Path(cfg["persist_directory"]).resolve()
    dataset_root = persist.parent
    db_path = resolve_db_path(dataset_root)
    offset = (page - 1) * page_size
    try:
        jobs, has_more = fetch_recent_jobs_page(db_path, page_size, offset)
    except Exception as e:
        logger.warning("读取 ingest 任务列表失败: %s", e, exc_info=True)
        jobs, has_more = [], False
    return {
        "jobs": jobs,
        "page": page,
        "page_size": page_size,
        "has_more": has_more,
    }


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
from session_routes import router as session_router

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
