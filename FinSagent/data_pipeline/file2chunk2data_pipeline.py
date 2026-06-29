#!/usr/bin/env python3
"""
file2chunk2data_pipeline.py — 上传 + mineru + file2chunk v5 + table + Chroma/BM25 + PageIndex

六步串联：
  Step 1: 0_raw/pdf  → mineru → 1_processed/pdf
  Step 2: 1_processed/pdf → file2chunk v5 → 2_final/pdf_v2/<stem>/base_final.json
  Step 3: 1_processed/pdf 表格图片 → process_table → 4_processed_table/<stem>_table_reconstructed.json
  Step 4: 同步 base_final.json 到 3_base_final/<stem>.json → load_data → Chroma + BM25
  Step 5: 4_processed_table → load_table_chroma → table_chroma
  Step 6: 0_raw/pdf → build_pageindex_index → {persist_directory}/pageindex/

目录布局（dataset_root = dirname(config['persist_directory'])）::

    {dataset_root}/
      0_raw/pdf/         # 源 PDF（API 上传后落到这里）
      1_processed/pdf/   # mineru 输出（每份 PDF 一个子目录）
      2_final/pdf_v2/    # file2chunk v5 中间产物 + base_final.json
      3_base_final/      # 平铺 base_final.json，load_data 一次性扫描
      4_processed_table/ # process_table 输出：<stem>_table_reconstructed.json

    {persist_directory}/
      chroma/ ts_chroma/ table_chroma/
      bm25_index/{collection_name}/
      pageindex/         # PageIndex 结构树 JSON（*_structure.json）

Step 1 (mineru) 严格对齐 file2chunk/mineru_analysis.py::

    env  MINERU_MODEL_SOURCE=modelscope
         MINERU_FORMULA_ENABLE=true
         [MINERU_TOOLS_CONFIG_JSON=/root/mineru.json]
    mineru -p <pdf>  -o <1_processed/pdf>
           -b hybrid-auto-engine -l en --gpu-memory-utilization 0.2

Step 2 (file2chunk v5) 直接 import 现有实现::

    from main_pipeline_v5_20260426 import process_document
    process_document(<*_content_list_v2.json>, <2_final/pdf_v2>,
                     company_name=..., lsh_threshold=..., keep_policy=...,
                     llm_api_max_workers=..., enable_summary=...)

中间产物：``2_final/pdf_v2/<stem>/base_final.json``

Step 3 (process_table) 直接 import data_pipeline/process_table.py::

    reconstruct_table_chunks(input_dir=<1_processed/pdf>/<stem>,
                             output_json_path=<4_processed_table>/<stem>_table_reconstructed.json,
                             ...)

默认只读取 ``data_pipeline/.env`` 中的表格模型配置：
``process_table_llm_api_key / process_table_llm_base_url / process_table_llm_model_name``。
如需跳过可加 ``--skip-process-table``。

Step 4 (Chroma + BM25) 直接 import data_pipeline/load_data.py::

    cp 2_final/pdf_v2/<stem>/base_final.json -> 3_base_final/<stem>.json
    import_collection_from_dir(rag, collection_name, 3_base_final/, batch_size)
    load_from_chroma_and_save(rag.get_collection_documents(coll), bm25_dir)

Step 5 (table_chroma) 直接 import data_pipeline/load_table_chroma.py::

    import_tables_into_chroma(rag, collection_name, 4_processed_table/*, batch_size)

mineru 可执行文件：默认 ``/root/autodl-tmp/cjj/code/file2chunk/.venv/bin/mineru``
（与 file2chunk/mineru_analysis.py 一致）。如需覆盖，传 ``--mineru-bin <path>``。

CLI 用法::

    # 单文件
    python data_pipeline/file2chunk2data_pipeline.py \\
        --config config/production.yaml \\
        --pdf /path/to/a.pdf

    # 多文件
    python data_pipeline/file2chunk2data_pipeline.py \\
        --config config/production.yaml \\
        --pdf /path/a.pdf --pdf /path/b.pdf

    # 整个目录 + 跑 file2chunk
    python data_pipeline/file2chunk2data_pipeline.py \\
        --config config/production.yaml \\
        --pdf-dir /tmp/incoming/ \\
        --company-name Zeekr

    # 只跑到 mineru 为止（不跑 file2chunk）
    python data_pipeline/file2chunk2data_pipeline.py \\
        --config config/production.yaml --pdf /path/a.pdf \\
        --skip-file2chunk
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Sequence

import yaml

# ---------------------------------------------------------------------------
# 路径常量
# ---------------------------------------------------------------------------
PIPELINE_ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = PIPELINE_ROOT.parent
FILE2CHUNK_DIR = PIPELINE_ROOT / "file2chunk"
SRC_DIR = PROJECT_ROOT / "src"

# ---------------------------------------------------------------------------
# 默认参数（不暴露到 CLI / API，需要调整直接改这里）
# ---------------------------------------------------------------------------
# 与 file2chunk/mineru_analysis.py 一致的 mineru 可执行文件路径。
# 如需覆盖：CLI 传 --mineru-bin，或调用 run_step_pdf_to_processed(mineru_bin=...)。
DEFAULT_MINERU_BIN = "/root/autodl-tmp/cjj/code/file2chunk/.venv/bin/mineru"

# Step 1 mineru
DEFAULT_LANG = "en"
DEFAULT_MINERU_BACKEND = "hybrid-auto-engine"
DEFAULT_MINERU_MODEL_SOURCE = "modelscope"
DEFAULT_MINERU_FORMULA_ENABLE = True
DEFAULT_MINERU_GPU_MEMORY_UTILIZATION = 0.2
DEFAULT_MINERU_TOOLS_CONFIG = ""  # 空串 = 不设置 MINERU_TOOLS_CONFIG_JSON

# Step 2 file2chunk v5
DEFAULT_LSH_THRESHOLD = 0.85
DEFAULT_LSH_NUM_PERM = 128
DEFAULT_LSH_SHINGLE_SIZE = 5
DEFAULT_LSH_MIN_TOKENS = 30
DEFAULT_LSH_RERANK = "both"
DEFAULT_LSH_NORMALIZE_NUMBERS = False
DEFAULT_KEEP_POLICY = "longest"
DEFAULT_LLM_MAX_WORKERS = 8
DEFAULT_ENABLE_SUMMARY = True

# Step 3 process_table（API key 走 .env，CLI 不暴露）   
DEFAULT_TENCENT_BASE_URL = ""
DEFAULT_CLAUDE_MODEL = ""
DEFAULT_TENCENT_MODEL = ""
DEFAULT_TABLE_WORKERS = 5
DEFAULT_TABLE_RPM = 50
DEFAULT_TABLE_CONTEXT_WINDOW = 3
DEFAULT_TABLE_SAVE_INTERVAL = 10
DEFAULT_TABLE_BATCH_SIZE = 64

# Step 4 load_data
DEFAULT_BATCH_SIZE = 100

# Step 6 PageIndex（仅当 config['pageindex_mode'] 不为 off/none/false 时实际运行）
DEFAULT_PAGEINDEX_REPO_PATH = "/root/autodl-tmp/PageIndex"

# 日志走 stderr；由 API 启动子进程时会把 stdout/stderr 重定向到每任务独立的 .log，避免多任务共写一份文件。
# 环境变量 INGEST_LOG_FILE 由 deploy/app.py 设置，供排查时知晓路径，本模块不再单独 FileHandler 打开同一路径（避免双 FD 交错写入）。
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 配置 & 路径布局
# ---------------------------------------------------------------------------
@dataclass
class DatasetLayout:
    """目录命名：0_raw/pdf / 1_processed/pdf / 2_final/pdf_v2 / 3_base_final / 4_processed_table"""

    dataset_root: Path
    raw_pdf: Path             # 0_raw/pdf
    processed_pdf: Path       # 1_processed/pdf
    final_pdf: Path           # 2_final/pdf_v2
    base_final_flat: Path     # 3_base_final（load_data 扫描的平铺目录）
    processed_table: Path     # 4_processed_table（process_table 输出 + load_table_chroma 扫描）
    persist_directory: Path   # 来自 config['persist_directory']
    collection_name: str      # 来自 config['collection_name']

    @classmethod
    def from_config(cls, config: dict) -> "DatasetLayout":
        persist = Path(config["persist_directory"]).resolve()
        root = persist.parent
        return cls(
            dataset_root=root,
            raw_pdf=root / "0_raw" / "pdf",
            processed_pdf=root / "1_processed" / "pdf",
            final_pdf=root / "2_final" / "pdf_v2",
            base_final_flat=root / "3_base_final",
            processed_table=root / "4_processed_table",
            persist_directory=persist,
            collection_name=str(config.get("collection_name", "default")),
        )

    def ensure_dirs(self) -> None:
        for p in (
            self.raw_pdf,
            self.processed_pdf,
            self.final_pdf,
            self.base_final_flat,
            self.processed_table,
            self.persist_directory,
        ):
            p.mkdir(parents=True, exist_ok=True)


def load_config(config_path: Path) -> dict:
    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Step 1.0: 把 PDF 复制到 0_raw/pdf/
# ---------------------------------------------------------------------------
def save_pdfs_to_layout(pdfs: Sequence[Path], layout: DatasetLayout) -> List[Path]:
    """将多个 PDF 复制到 ``0_raw/pdf/``，返回目标路径列表（保持输入顺序）。"""
    layout.ensure_dirs()
    out: List[Path] = []
    for src in pdfs:
        src = src.resolve()
        if not src.is_file():
            raise FileNotFoundError(f"PDF 不存在: {src}")
        dest = layout.raw_pdf / src.name
        if dest.resolve() != src.resolve():
            shutil.copy2(src, dest)
            logger.info("已保存源文件: %s", dest)
        else:
            logger.info("源文件已在 0_raw/pdf 下，跳过复制: %s", dest)
        out.append(dest)
    return out


# ---------------------------------------------------------------------------
# Step 1.1: 单 PDF / 批量 PDF 调用 mineru CLI
# ---------------------------------------------------------------------------
def run_mineru_one(
    pdf_path: Path,
    processed_pdf_root: Path,
    *,
    mineru_executable: str = DEFAULT_MINERU_BIN,
    backend: str = "hybrid-auto-engine",
    lang: str = "en",
    gpu_memory_utilization: float = 0.2,
    model_source: str = "modelscope",
    formula_enable: bool = True,
    mineru_tools_config: Optional[str] = None,
    extra_env: Optional[dict] = None,
) -> Path:
    """单个 PDF 调用 mineru CLI（严格对齐 mineru_analysis.py）。

    输出目录：``<processed_pdf_root>/<pdf_stem>/``。返回这个目录的 Path。
    若已存在且非空，则视为已处理过、跳过。
    """
    out_subdir = processed_pdf_root / pdf_path.stem
    if out_subdir.exists() and any(out_subdir.iterdir()):
        logger.info("1_processed/pdf 已存在子目录，跳过 mineru: %s", out_subdir)
        return out_subdir

    env = os.environ.copy()
    env["MINERU_MODEL_SOURCE"] = model_source
    env["MINERU_FORMULA_ENABLE"] = "true" if formula_enable else "false"
    if mineru_tools_config:
        env["MINERU_TOOLS_CONFIG_JSON"] = mineru_tools_config
    if extra_env:
        env.update(extra_env)

    cmd = [
        mineru_executable,
        "-p", str(pdf_path),
        "-o", str(processed_pdf_root),
        "-b", backend,
        "-l", lang,
        "--gpu-memory-utilization", str(gpu_memory_utilization),
    ]

    env_summary = (
        f"MINERU_MODEL_SOURCE={env['MINERU_MODEL_SOURCE']}, "
        f"MINERU_FORMULA_ENABLE={env['MINERU_FORMULA_ENABLE']}"
    )
    if mineru_tools_config:
        env_summary += f", MINERU_TOOLS_CONFIG_JSON={mineru_tools_config}"
    logger.info("运行 mineru (env: %s): %s", env_summary, " ".join(cmd))

    subprocess.run(cmd, check=True, env=env)
    return out_subdir


def run_mineru_batch(
    pdfs: Iterable[Path],
    processed_pdf_root: Path,
    *,
    mineru_executable: str = DEFAULT_MINERU_BIN,
    backend: str = "hybrid-auto-engine",
    lang: str = "en",
    gpu_memory_utilization: float = 0.2,
    model_source: str = "modelscope",
    formula_enable: bool = True,
    mineru_tools_config: Optional[str] = None,
) -> List[Path]:
    """批量 mineru。返回每个 PDF 的输出子目录列表。"""
    processed_pdf_root.mkdir(parents=True, exist_ok=True)
    out_subdirs: List[Path] = []
    for pdf in pdfs:
        try:
            out_subdir = run_mineru_one(
                pdf,
                processed_pdf_root,
                mineru_executable=mineru_executable,
                backend=backend,
                lang=lang,
                gpu_memory_utilization=gpu_memory_utilization,
                model_source=model_source,
                formula_enable=formula_enable,
                mineru_tools_config=mineru_tools_config,
            )
            out_subdirs.append(out_subdir)
        except subprocess.CalledProcessError as e:
            logger.error("mineru 失败: %s -> %s", pdf, e)
            raise
    return out_subdirs


# ---------------------------------------------------------------------------
# 主入口（仅 Step 1：上传 + mineru）
# ---------------------------------------------------------------------------
def run_step_pdf_to_processed(
    pdfs: Sequence[Path],
    config_path: Path,
    *,
    mineru_bin: str = DEFAULT_MINERU_BIN,
    mineru_backend: str = "hybrid-auto-engine",
    mineru_model_source: str = "modelscope",
    mineru_formula_enable: bool = True,
    mineru_gpu_memory_utilization: float = 0.2,
    mineru_tools_config: Optional[str] = None,
    lang: str = "en",
    skip_mineru: bool = False,
) -> dict:
    """执行 Step 1：把 PDF 落到 0_raw/pdf/，再用 mineru 解析到 1_processed/pdf/。

    mineru 可执行文件直接使用 ``mineru_bin``（默认为 DEFAULT_MINERU_BIN）。
    返回各阶段产物路径字典。
    """
    if not pdfs:
        raise ValueError("pdfs 列表为空，无文件可处理")

    config = load_config(config_path)
    if "persist_directory" in config:
        config["persist_directory"] = str(Path(config["persist_directory"]).resolve())

    layout = DatasetLayout.from_config(config)
    layout.ensure_dirs()

    # ----- 1.0 复制源文件到 0_raw/pdf/ -----
    saved_pdfs = save_pdfs_to_layout([Path(p) for p in pdfs], layout)

    result: dict = {
        "dataset_root": str(layout.dataset_root),
        "raw_pdf_dir": str(layout.raw_pdf),
        "processed_pdf_dir": str(layout.processed_pdf),
        "saved_pdfs": [str(p) for p in saved_pdfs],
        "mineru_executable": mineru_bin,
    }

    if skip_mineru:
        logger.info("--skip-mineru：跳过 mineru 解析")
        result["mineru_outputs"] = []
        return result

    if not os.path.isfile(mineru_bin):
        raise FileNotFoundError(
            f"mineru 不存在: {mineru_bin}。请通过 --mineru-bin 指定正确路径。"
        )

    # ----- 1.1 调 mineru -----
    tools_cfg = mineru_tools_config or config.get("mineru_tools_config_json")
    mineru_outputs = run_mineru_batch(
        saved_pdfs,
        layout.processed_pdf,
        mineru_executable=mineru_bin,
        backend=mineru_backend,
        lang=lang,
        gpu_memory_utilization=mineru_gpu_memory_utilization,
        model_source=mineru_model_source,
        formula_enable=mineru_formula_enable,
        mineru_tools_config=tools_cfg,
    )
    result["mineru_outputs"] = [str(p) for p in mineru_outputs]
    return result


# ---------------------------------------------------------------------------
# Step 2.0: 在 1_processed/pdf 下找到 *_content_list_v2.json
# ---------------------------------------------------------------------------
def find_content_list_v2_jsons(
    processed_pdf_root: Path,
    pdf_stems: Sequence[str],
    fallback_roots: Optional[Sequence[Path]] = None,
) -> List[Path]:
    """对一批 PDF stem，返回各自的 ``*_content_list_v2.json`` 路径。

    每个 stem 在 ``processed_pdf_root/<stem>/`` 下递归找；多个匹配时取路径最短的
    那个。任何一个 stem 找不到都直接抛错（v5 流程只接受 v2）。
    """
    out: List[Path] = []
    roots = [processed_pdf_root, *(fallback_roots or [])]
    for stem in pdf_stems:
        stem_dir = next((root / stem for root in roots if (root / stem).is_dir()), processed_pdf_root / stem)
        if not stem_dir.is_dir():
            raise FileNotFoundError(
                f"未找到 mineru 输出目录: {stem_dir}；也未在 fallback 中找到。"
            )
        cands = sorted(
            (p for p in stem_dir.rglob("*_content_list_v2.json") if p.is_file()),
            key=lambda x: len(str(x)),
        )
        if not cands:
            raise FileNotFoundError(
                f"在 {stem_dir} 下未找到 *_content_list_v2.json。"
                "请确认 mineru 是否以 -b hybrid-auto-engine 模式跑成功。"
            )
        out.append(cands[0])
    return out


def _processed_pdf_stem_dir(layout: DatasetLayout, stem: str) -> Path:
    """Return the MinerU output dir for a stem, preferring the new 1_processed/pdf layout."""
    primary = layout.processed_pdf / stem
    if primary.is_dir():
        return primary
    legacy = layout.dataset_root / "1_processed_pdf" / stem
    if legacy.is_dir():
        logger.info("使用历史 MinerU 输出目录: %s", legacy)
        return legacy
    return primary


# ---------------------------------------------------------------------------
# Step 2.1: 调用 main_pipeline_v5_20260426.process_document
# ---------------------------------------------------------------------------
def _ensure_file2chunk_importable() -> None:
    """把 file2chunk/ 加到 sys.path，便于 ``import main_pipeline_v5_20260426``。"""
    sp = str(FILE2CHUNK_DIR)
    if sp not in sys.path:
        sys.path.insert(0, sp)


def run_file2chunk_one(
    content_list_v2_json: Path,
    final_pdf_dir: Path,
    *,
    company_name: str,
    lsh_threshold: float = 0.85,
    lsh_num_perm: int = 128,
    lsh_shingle_size: int = 5,
    lsh_min_tokens: int = 30,
    lsh_rerank: str = "both",
    lsh_normalize_numbers: bool = False,
    keep_policy: str = "longest",
    llm_api_max_workers: int = 8,
    enable_summary: bool = True,
) -> Path:
    """单文档跑 file2chunk v5。返回 ``<final_pdf_dir>/<stem>/base_final.json``。

    process_document 内部用 subprocess 调 ``python step2_*.py`` 但**不指定 cwd**，
    所以要求当前进程的 cwd 是 file2chunk/。这里临时 chdir，结束恢复。
    """
    _ensure_file2chunk_importable()
    from main_pipeline_v5_20260426 import process_document  # type: ignore

    final_pdf_dir.mkdir(parents=True, exist_ok=True)

    prev_cwd = os.getcwd()
    try:
        os.chdir(FILE2CHUNK_DIR)
        process_document(
            str(content_list_v2_json),
            str(final_pdf_dir),
            lsh_threshold=lsh_threshold,
            lsh_num_perm=lsh_num_perm,
            lsh_shingle_size=lsh_shingle_size,
            lsh_min_tokens=lsh_min_tokens,
            lsh_rerank=lsh_rerank,
            lsh_normalize_numbers=lsh_normalize_numbers,
            keep_policy=keep_policy,
            company_name=company_name,
            llm_api_max_workers=llm_api_max_workers,
            enable_summary=enable_summary,
        )
    finally:
        os.chdir(prev_cwd)

    # process_document 的 stem 处理：去掉 _content_list_v2 / _content_list 后空格转 _
    stem = (
        content_list_v2_json.name
        .replace("_content_list_v2", "")
        .replace("_content_list", "")
        .replace(".json", "")
        .replace(" ", "_")
    )
    base_final = final_pdf_dir / stem / "base_final.json"
    if not base_final.is_file():
        raise FileNotFoundError(
            f"process_document 未产出 base_final.json: {base_final}"
        )
    return base_final


def run_file2chunk_batch(
    content_list_jsons: Sequence[Path],
    final_pdf_dir: Path,
    *,
    company_name: str,
    lsh_threshold: float = 0.85,
    lsh_num_perm: int = 128,
    lsh_shingle_size: int = 5,
    lsh_min_tokens: int = 30,
    lsh_rerank: str = "both",
    lsh_normalize_numbers: bool = False,
    keep_policy: str = "longest",
    llm_api_max_workers: int = 8,
    enable_summary: bool = True,
) -> List[Path]:
    """批量执行 file2chunk v5。串行处理（与 main_pipeline_v5_20260426.main 一致）。"""
    base_finals: List[Path] = []
    skipped: List[Path] = []
    for idx, cj in enumerate(content_list_jsons, start=1):
        logger.info("[%d/%d] file2chunk: %s", idx, len(content_list_jsons), cj)
        try:
            base_final = run_file2chunk_one(
                cj,
                final_pdf_dir,
                company_name=company_name,
                lsh_threshold=lsh_threshold,
                lsh_num_perm=lsh_num_perm,
                lsh_shingle_size=lsh_shingle_size,
                lsh_min_tokens=lsh_min_tokens,
                lsh_rerank=lsh_rerank,
                lsh_normalize_numbers=lsh_normalize_numbers,
                keep_policy=keep_policy,
                llm_api_max_workers=llm_api_max_workers,
                enable_summary=enable_summary,
            )
            base_finals.append(base_final)
        except Exception as e:
            logger.error(
                "[%d/%d] file2chunk 失败，跳过该文件（不中止整批）: %s — %s",
                idx, len(content_list_jsons), cj, e,
            )
            skipped.append(cj)
    if skipped:
        logger.warning("file2chunk 批量完成：成功 %d / %d，跳过 %d 个文件: %s",
                       len(base_finals), len(content_list_jsons), len(skipped),
                       [str(p) for p in skipped])
    return base_finals


# ---------------------------------------------------------------------------
# Step 2 入口
# ---------------------------------------------------------------------------
def run_step_processed_to_final(
    pdf_stems: Sequence[str],
    config_path: Path,
    *,
    company_name: str,
    lsh_threshold: float = 0.85,
    lsh_num_perm: int = 128,
    lsh_shingle_size: int = 5,
    lsh_min_tokens: int = 30,
    lsh_rerank: str = "both",
    lsh_normalize_numbers: bool = False,
    keep_policy: str = "longest",
    llm_api_max_workers: int = 8,
    enable_summary: bool = True,
) -> dict:
    """从 1_processed/pdf 起跑 file2chunk v5，结果落到 2_final/pdf_v2。"""
    if not pdf_stems:
        raise ValueError("pdf_stems 列表为空")
    if not company_name or not company_name.strip():
        raise ValueError("company_name 必填（step2_v2 / step6 都需要）")
    company_name = company_name.strip()

    config = load_config(config_path)
    if "persist_directory" in config:
        config["persist_directory"] = str(Path(config["persist_directory"]).resolve())

    layout = DatasetLayout.from_config(config)
    layout.ensure_dirs()

    content_jsons = find_content_list_v2_jsons(
        layout.processed_pdf,
        pdf_stems,
        fallback_roots=[layout.dataset_root / "1_processed_pdf"],
    )
    base_finals = run_file2chunk_batch(
        content_jsons,
        layout.final_pdf,
        company_name=company_name,
        lsh_threshold=lsh_threshold,
        lsh_num_perm=lsh_num_perm,
        lsh_shingle_size=lsh_shingle_size,
        lsh_min_tokens=lsh_min_tokens,
        lsh_rerank=lsh_rerank,
        lsh_normalize_numbers=lsh_normalize_numbers,
        keep_policy=keep_policy,
        llm_api_max_workers=llm_api_max_workers,
        enable_summary=enable_summary,
    )
    return {
        "final_pdf_dir": str(layout.final_pdf),
        "company_name": company_name,
        "content_list_jsons": [str(p) for p in content_jsons],
        "base_finals": [str(p) for p in base_finals],
    }


# ---------------------------------------------------------------------------
# Step 3.0: 调用 data_pipeline/process_table.reconstruct_table_chunks
# ---------------------------------------------------------------------------
def _ensure_data_pipeline_importable() -> None:
    """把 data_pipeline/ 加到 sys.path，便于 ``import process_table``。"""
    sp = str(PIPELINE_ROOT)
    if sp not in sys.path:
        sys.path.insert(0, sp)


def run_process_table_one(
    stem_dir: Path,
    processed_table_dir: Path,
    *,
    anthropic_api_key: Optional[str] = None,
    anthropic_api_keys: Optional[Sequence[str]] = None,
    tencent_api_key: Optional[str] = None,
    tencent_base_url: str = DEFAULT_TENCENT_BASE_URL,
    claude_model: str = DEFAULT_CLAUDE_MODEL,
    tencent_model: str = DEFAULT_TENCENT_MODEL,
    max_workers: int = 5,
    requests_per_minute: int = 50,
    context_window: int = 3,
    save_interval: int = 10,
) -> Path:
    """单个 ``1_processed/pdf/<stem>/`` 跑表格重建，输出到
    ``4_processed_table/<stem>_table_reconstructed.json``。

    ``stem_dir`` 必须包含 ``hybrid_auto/*_content_list.json``（v1 扁平格式）和
    ``hybrid_auto/images/`` —— mineru hybrid-auto-engine 同时输出 v1+v2，所以
    这里复用同一份 mineru 产物。
    """
    _ensure_data_pipeline_importable()
    from process_table import reconstruct_table_chunks  # type: ignore

    processed_table_dir.mkdir(parents=True, exist_ok=True)
    output_json_path = processed_table_dir / f"{stem_dir.name}_table_reconstructed.json"

    # process_table 内部会做断点续跑（已存在则跳过已处理项），这里只是早退优化日志
    if output_json_path.is_file():
        try:
            with open(output_json_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            if isinstance(existing, list) and existing:
                logger.info(
                    "4_processed_table 已存在且非空，跳过 process_table: %s",
                    output_json_path,
                )
                return output_json_path
        except Exception:
            pass

    reconstruct_table_chunks(
        input_dir=str(stem_dir),
        output_json_path=str(output_json_path),
        anthropic_api_key=anthropic_api_key,
        anthropic_api_keys=anthropic_api_keys,
        tencent_api_key=tencent_api_key,
        tencent_base_url=tencent_base_url,
        claude_model=claude_model,
        tencent_model=tencent_model,
        max_workers=max_workers,
        requests_per_minute=requests_per_minute,
        context_window=context_window,
        save_interval=save_interval,
    )
    return output_json_path


def run_process_table_batch(
    stem_dirs: Sequence[Path],
    processed_table_dir: Path,
    *,
    anthropic_api_key: Optional[str] = None,
    anthropic_api_keys: Optional[Sequence[str]] = None,
    tencent_api_key: Optional[str] = None,
    tencent_base_url: str = DEFAULT_TENCENT_BASE_URL,
    claude_model: str = DEFAULT_CLAUDE_MODEL,
    tencent_model: str = DEFAULT_TENCENT_MODEL,
    max_workers: int = 5,
    requests_per_minute: int = 50,
    context_window: int = 3,
    save_interval: int = 10,
) -> List[Path]:
    """批量执行 process_table。串行处理（每个 stem 内部 max_workers 并发）。"""
    out: List[Path] = []
    for idx, sd in enumerate(stem_dirs, start=1):
        logger.info("[%d/%d] process_table: %s", idx, len(stem_dirs), sd)
        out.append(
            run_process_table_one(
                sd,
                processed_table_dir,
                anthropic_api_key=anthropic_api_key,
                anthropic_api_keys=anthropic_api_keys,
                tencent_api_key=tencent_api_key,
                tencent_base_url=tencent_base_url,
                claude_model=claude_model,
                tencent_model=tencent_model,
                max_workers=max_workers,
                requests_per_minute=requests_per_minute,
                context_window=context_window,
                save_interval=save_interval,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Step 3 入口
# ---------------------------------------------------------------------------
def run_step_process_table(
    pdf_stems: Sequence[str],
    config_path: Path,
    *,
    anthropic_api_key: Optional[str] = None,
    anthropic_api_keys: Optional[Sequence[str]] = None,
    tencent_api_key: Optional[str] = None,
    tencent_base_url: str = DEFAULT_TENCENT_BASE_URL,
    claude_model: str = DEFAULT_CLAUDE_MODEL,
    tencent_model: str = DEFAULT_TENCENT_MODEL,
    max_workers: int = 5,
    requests_per_minute: int = 50,
    context_window: int = 3,
    save_interval: int = 10,
) -> dict:
    """对一批 PDF stem 跑 process_table，输出到 4_processed_table/。

    表格处理默认由 data_pipeline/process_table.py 读取 data_pipeline/.env：
    process_table_llm_api_key / process_table_llm_base_url / process_table_llm_model_name。
    """
    if not pdf_stems:
        raise ValueError("pdf_stems 列表为空")

    config = load_config(config_path)
    if "persist_directory" in config:
        config["persist_directory"] = str(Path(config["persist_directory"]).resolve())
    layout = DatasetLayout.from_config(config)
    layout.ensure_dirs()

    stem_dirs: List[Path] = []
    for stem in pdf_stems:
        sd = _processed_pdf_stem_dir(layout, stem)
        if not sd.is_dir():
            raise FileNotFoundError(f"未找到 mineru 输出目录: {sd}")
        stem_dirs.append(sd)

    table_jsons = run_process_table_batch(
        stem_dirs,
        layout.processed_table,
        anthropic_api_key=anthropic_api_key,
        anthropic_api_keys=anthropic_api_keys,
        tencent_api_key=tencent_api_key,
        tencent_base_url=tencent_base_url,
        claude_model=claude_model,
        tencent_model=tencent_model,
        max_workers=max_workers,
        requests_per_minute=requests_per_minute,
        context_window=context_window,
        save_interval=save_interval,
    )
    return {
        "processed_table_dir": str(layout.processed_table),
        "table_jsons": [str(p) for p in table_jsons],
    }


# ---------------------------------------------------------------------------
# Step 4.0: 把 2_final/pdf_v2/<stem>/base_final.json 同步到 3_base_final/<stem>.json
# ---------------------------------------------------------------------------
def sync_base_finals_to_flat(
    base_finals: Sequence[Path], base_final_flat: Path
) -> List[Path]:
    """同步本次新增的 base_final.json 到 ``3_base_final/<stem>.json``。

    文件名直接用 PDF stem，后续 metadata 中的 ``filename`` 字段会等于
    ``<stem>.json``。同名时覆盖。
    """
    base_final_flat.mkdir(parents=True, exist_ok=True)
    out: List[Path] = []
    for src in base_finals:
        # base_final.json 所在目录名 = PDF stem
        stem = src.parent.name
        dest = base_final_flat / f"{stem}.json"
        shutil.copy2(src, dest)
        logger.info("同步到 3_base_final: %s -> %s", src, dest)
        out.append(dest)
    return out


# ---------------------------------------------------------------------------
# Step 4.1: load_data + BM25（直接 import 现有实现）
# ---------------------------------------------------------------------------
def _ensure_runtime_importable() -> None:
    """让 src/ 排在 sys.path 最前，确保 ``from utils.X import Y`` 走 src/utils/ 包。

    必须在这里把 ``data_pipeline/file2chunk/`` 从 sys.path 中拿掉——它里面的
    ``utils.py``（单文件模块）会屏蔽 ``src/utils/`` 这个包，导致
    RAGManager 里 ``from utils.EnsembleRetriever import EnsembleRetriever``
    报 ``'utils' is not a package``。同时清理可能已经被缓存的错的 ``utils``
    单文件模块。
    """
    f2c = str(FILE2CHUNK_DIR)
    sys.path[:] = [p for p in sys.path if p != f2c]

    # 强制把 SRC_DIR 排在最前（即使原本已在 sys.path 中也 reposition 一遍）
    for p in (PIPELINE_ROOT, SRC_DIR):
        sp = str(p)
        while sp in sys.path:
            sys.path.remove(sp)
        sys.path.insert(0, sp)

    # 若 file2chunk/utils.py 已经被早先的 import 缓存为 ``utils``，evict 掉
    cached_utils = sys.modules.get("utils")
    if cached_utils is not None and not hasattr(cached_utils, "__path__"):
        # __path__ 只有"包"才有；单文件模块没有 → 是被屏蔽的 file2chunk/utils.py
        sys.modules.pop("utils", None)


def run_load_data(
    config: dict,
    layout: DatasetLayout,
    *,
    batch_size: int = 100,
    reset_persist: bool = False,
) -> dict:
    """加载 ``3_base_final/`` 下所有 JSON 到 Chroma，再写 BM25 索引。

    与 ``data_pipeline/load_data.py`` 主流程一致：
    1. 可选 ``reset_persist``：先 rmtree 整个 persist_directory；
    2. ``RAGManager(config)`` + ``create_collection(coll)``；
    3. ``import_collection_from_dir`` 会先 reset 集合再全量重导；
    4. 取出全部文档，写入 ``persist_directory/bm25_index/<coll>/``。
    """
    _ensure_runtime_importable()
    from core.RAGManager import RAGManager  # type: ignore
    from load_data import import_collection_from_dir  # type: ignore
    from utils.bm25Retriever import load_from_chroma_and_save  # type: ignore

    if reset_persist and layout.persist_directory.exists():
        logger.warning("--reset-persist：删除 %s", layout.persist_directory)
        shutil.rmtree(layout.persist_directory)
        layout.persist_directory.mkdir(parents=True, exist_ok=True)

    # 同进程内重复调用需清空单例
    RAGManager._instance = None
    RAGManager._collections = {}
    RAGManager._retrievers = []

    rag = RAGManager(config)
    coll = layout.collection_name
    if coll not in rag._collections:
        rag.create_collection(coll)

    flat_dir = str(layout.base_final_flat)
    json_files = [f for f in os.listdir(flat_dir) if f.endswith(".json")]
    if not json_files:
        raise FileNotFoundError(
            f"3_base_final 平铺目录无 JSON: {flat_dir}\n"
            "请先跑完 file2chunk 并同步到该目录。"
        )

    logger.info("从 %s 导入 %d 个 JSON 到集合 %s", flat_dir, len(json_files), coll)
    import_collection_from_dir(rag, coll, flat_dir, batch_size, ignore_range=False)

    documents = rag.get_collection_documents(coll)
    bm25_dir = os.path.join(str(layout.persist_directory), "bm25_index", coll)
    os.makedirs(bm25_dir, exist_ok=True)
    load_from_chroma_and_save(documents, bm25_dir)
    logger.info("BM25 已写入: %s", bm25_dir)

    return {
        "collection_name": coll,
        "persist_directory": str(layout.persist_directory),
        "bm25_dir": bm25_dir,
        "loaded_json_count": len(json_files),
    }


# ---------------------------------------------------------------------------
# Step 4 入口
# ---------------------------------------------------------------------------
def run_step_final_to_chroma(
    base_finals: Sequence[Path],
    config_path: Path,
    *,
    batch_size: int = 100,
    reset_persist: bool = False,
) -> dict:
    """同步 base_final.json 到 ``3_base_final/``，再写 Chroma + BM25。"""
    config = load_config(config_path)
    if "persist_directory" in config:
        config["persist_directory"] = str(Path(config["persist_directory"]).resolve())
    layout = DatasetLayout.from_config(config)
    layout.ensure_dirs()

    flat_paths = sync_base_finals_to_flat(base_finals, layout.base_final_flat)
    out = run_load_data(
        config, layout, batch_size=batch_size, reset_persist=reset_persist
    )
    out["base_final_flat_dir"] = str(layout.base_final_flat)
    out["synced_flat_paths"] = [str(p) for p in flat_paths]
    return out


# ---------------------------------------------------------------------------
# Step 5.0: load_table_chroma（直接 import 现有实现）
# ---------------------------------------------------------------------------
def run_load_table_chroma(
    config: dict,
    layout: DatasetLayout,
    *,
    batch_size: int = 64,
) -> dict:
    """扫描 ``4_processed_table/*_table_reconstructed.json``，全量重导到 table_chroma。

    与 ``data_pipeline/load_table_chroma.py`` 主流程一致：
    1. ``RAGManager(config)`` + ``create_collection(coll)``（与 text 共用同一 collection）；
    2. ``import_tables_into_chroma`` 内部会 ``table_chroma.reset_collection()``，
       再把扫描到的全部 ``*_table_reconstructed.json`` 写进去。
    """
    _ensure_runtime_importable()
    from core.RAGManager import RAGManager  # type: ignore
    from load_table_chroma import (  # type: ignore
        import_tables_into_chroma,
        iter_table_json_files,
    )

    # 同进程内重复调用需清空单例（与 run_load_data 行为一致）
    RAGManager._instance = None
    RAGManager._collections = {}
    RAGManager._retrievers = []

    rag = RAGManager(config)
    coll = layout.collection_name
    if coll not in rag._collections:
        rag.create_collection(coll)

    table_files = sorted(iter_table_json_files(str(layout.processed_table)))
    if not table_files:
        logger.warning(
            "4_processed_table 下无 *_table_reconstructed.json: %s（跳过 table_chroma 入库）",
            layout.processed_table,
        )
        return {
            "collection_name": coll,
            "table_chroma_loaded": 0,
            "processed_table_dir": str(layout.processed_table),
        }

    total = import_tables_into_chroma(rag, coll, table_files, batch_size)
    logger.info("table_chroma 入库 %d 个表格 chunk（集合 %s）", total, coll)
    return {
        "collection_name": coll,
        "table_chroma_loaded": total,
        "processed_table_dir": str(layout.processed_table),
        "table_files": table_files,
    }


# ---------------------------------------------------------------------------
# Step 5 入口
# ---------------------------------------------------------------------------
def run_step_load_table(
    config_path: Path,
    *,
    batch_size: int = 64,
) -> dict:
    """从 ``4_processed_table/`` 把所有表格 JSON 加载到 table_chroma。"""
    config = load_config(config_path)
    if "persist_directory" in config:
        config["persist_directory"] = str(Path(config["persist_directory"]).resolve())
    layout = DatasetLayout.from_config(config)
    layout.ensure_dirs()
    return run_load_table_chroma(config, layout, batch_size=batch_size)


# ---------------------------------------------------------------------------
# Step 6 入口
# ---------------------------------------------------------------------------
def run_step_build_pageindex(
    config_path: Path,
    *,
    pageindex_repo_path: str = "",
) -> dict:
    """从 ``0_raw/pdf/`` 为所有 PDF 构建 PageIndex 结构树。

    输出目录优先读取 config 中的 ``pageindex_index_dir``；
    未配置时自动回退到 ``{persist_directory}/pageindex/``。
    仅当 config 中 ``pageindex_mode`` 不为 off / none / false / 空字符串时运行；
    否则直接返回 ``{"skipped": True}``。

    PageIndex 构建通过调用同目录的 ``build_pageindex_index.py`` 子进程完成。
    已存在的 ``*_structure.json`` 默认跳过（幂等）；传 ``--force`` 可强制重建。
    """
    config = load_config(config_path)
    pageindex_mode = str(config.get("pageindex_mode", "off")).lower()
    if pageindex_mode in ("off", "none", "false", ""):
        logger.info("Step 6 PageIndex: pageindex_mode=%s，跳过构建", pageindex_mode)
        return {"skipped": True, "reason": f"pageindex_mode={pageindex_mode}"}

    layout = DatasetLayout.from_config({
        **config,
        "persist_directory": str(Path(config["persist_directory"]).resolve()),
    })
    input_dir = layout.raw_pdf

    # 优先使用 config 中显式指定的目录，未配置时 fallback 到 {persist_directory}/pageindex/
    explicit_dir = (config.get("pageindex_index_dir") or "").strip()
    if explicit_dir:
        output_dir = Path(explicit_dir)
        logger.info("Step 6 PageIndex: 使用 config 指定的 pageindex_index_dir: %s", output_dir)
    else:
        output_dir = layout.persist_directory / "pageindex"
        logger.info("Step 6 PageIndex: pageindex_index_dir 未配置，使用默认路径: %s", output_dir)

    if not input_dir.exists():
        logger.warning("Step 6 PageIndex: 0_raw/pdf 不存在，跳过: %s", input_dir)
        return {"skipped": True, "reason": f"input_dir not found: {input_dir}"}

    build_script = PIPELINE_ROOT / "build_pageindex_index.py"
    if not build_script.is_file():
        logger.warning("Step 6 PageIndex: build_pageindex_index.py 不存在，跳过: %s", build_script)
        return {"skipped": True, "reason": f"build_script not found: {build_script}"}

    output_dir.mkdir(parents=True, exist_ok=True)

    cmd = [
        sys.executable, str(build_script),
        "--input_dir", str(input_dir),
        "--output_dir", str(output_dir),
        "--config_path", str(config_path),
    ]
    repo = pageindex_repo_path or DEFAULT_PAGEINDEX_REPO_PATH
    if repo:
        cmd += ["--pageindex_repo_path", repo]

    logger.info(
        "Step 6 PageIndex 构建: input=%s output=%s", input_dir, output_dir
    )
    proc = subprocess.run(cmd, cwd=str(PIPELINE_ROOT))
    if proc.returncode != 0:
        raise RuntimeError(
            f"build_pageindex_index.py 退出码非零: {proc.returncode}，"
            f"input={input_dir}，output={output_dir}"
        )

    logger.info("Step 6 PageIndex 构建完成: output=%s", output_dir)
    return {
        "input_dir": str(input_dir),
        "output_dir": str(output_dir),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _collect_pdfs_from_args(
    pdf_args: Sequence[str], pdf_dirs: Sequence[str]
) -> List[Path]:
    pdfs: List[Path] = []
    seen: set[str] = set()

    def _add(p: Path) -> None:
        rp = str(p.resolve())
        if rp not in seen and p.is_file() and p.suffix.lower() == ".pdf":
            seen.add(rp)
            pdfs.append(p)

    for s in pdf_args:
        _add(Path(s))
    for d in pdf_dirs:
        dp = Path(d)
        if not dp.is_dir():
            raise FileNotFoundError(f"--pdf-dir 不是目录: {dp}")
        for p in sorted(dp.glob("*.pdf")):
            _add(p)
    return pdfs


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Step 1 (mineru) + Step 2 (file2chunk v5) + Step 3 (process_table) "
            "+ Step 4 (Chroma + BM25) + Step 5 (table_chroma) "
            "+ Step 6 (PageIndex) 流水线。"
            "其余调优参数见模块顶部 DEFAULT_* 常量。"
        ),
    )
    parser.add_argument(
        "--config", type=Path,
        default=PROJECT_ROOT / "config" / "production.yaml",
        help="YAML 配置（含 persist_directory）",
    )
    parser.add_argument(
        "--pdf", action="append", default=[],
        help="输入 PDF 路径，可重复多次",
    )
    parser.add_argument(
        "--pdf-dir", action="append", default=[],
        help="输入 PDF 目录（取该目录下一级 *.pdf），可重复多次",
    )
    parser.add_argument(
        "--company-name", default="",
        help="公司名（step2_v2 / step6 必需）；省略则使用 config['collection_name']",
    )
    parser.add_argument(
        "--mineru-bin", default=DEFAULT_MINERU_BIN,
        help=f"mineru 可执行文件绝对路径（默认 {DEFAULT_MINERU_BIN}）",
    )
    parser.add_argument("--skip-mineru", action="store_true",
                        help="跳过 Step 1 mineru（要求 1_processed/pdf 已就绪）")
    parser.add_argument("--skip-file2chunk", action="store_true",
                        help="跳过 Step 2 file2chunk（要求 2_final/pdf_v2 已就绪）")
    parser.add_argument("--skip-process-table", action="store_true",
                        help="跳过 Step 3 process_table（连不上 anthropic 时使用）")
    parser.add_argument("--skip-load", action="store_true",
                        help="跳过 Step 4 load_data，不写 text Chroma / BM25")
    parser.add_argument("--skip-load-table", action="store_true",
                        help="跳过 Step 5 load_table_chroma，不写 table_chroma")
    parser.add_argument("--skip-pageindex", action="store_true",
                        help="跳过 Step 6 PageIndex 构建（输出目录：{persist_directory}/pageindex/）")
    parser.add_argument("--pageindex-repo-path", default=DEFAULT_PAGEINDEX_REPO_PATH,
                        help="PageIndex 仓库本地路径（透传给 build_pageindex_index.py --pageindex_repo_path）")
    parser.add_argument("--reset-persist", action="store_true",
                        help="入库前删除整个 persist_directory（全新库）")

    args = parser.parse_args()
    if not args.config.is_file():
        sys.exit(f"配置不存在: {args.config}")

    pdfs = _collect_pdfs_from_args(args.pdf, args.pdf_dir)
    if not pdfs:
        sys.exit("没有任何 PDF：请用 --pdf <file>（可重复）或 --pdf-dir <dir>")

    logger.info("待处理 PDF: %d 个", len(pdfs))
    for p in pdfs:
        logger.info("  - %s", p)

    # ---------- Step 1 ----------
    out1 = run_step_pdf_to_processed(
        pdfs,
        args.config,
        mineru_bin=args.mineru_bin,
        mineru_backend=DEFAULT_MINERU_BACKEND,
        mineru_model_source=DEFAULT_MINERU_MODEL_SOURCE,
        mineru_formula_enable=DEFAULT_MINERU_FORMULA_ENABLE,
        mineru_gpu_memory_utilization=DEFAULT_MINERU_GPU_MEMORY_UTILIZATION,
        mineru_tools_config=DEFAULT_MINERU_TOOLS_CONFIG or None,
        lang=DEFAULT_LANG,
        skip_mineru=args.skip_mineru,
    )
    logger.info("Step 1 完成: %s", out1)

    cfg = load_config(args.config)
    pdf_stems = [Path(p).stem for p in pdfs]

    # ---------- Step 2 ----------
    if args.skip_file2chunk:
        logger.info("--skip-file2chunk：跳过 file2chunk，直接收集已有的 base_final.json")
        layout = DatasetLayout.from_config({
            **cfg,
            "persist_directory": str(Path(cfg["persist_directory"]).resolve()),
        })
        base_finals: List[Path] = []
        for stem in pdf_stems:
            bf = layout.final_pdf / stem.replace(" ", "_") / "base_final.json"
            if not bf.is_file():
                sys.exit(f"--skip-file2chunk 但缺少: {bf}")
            base_finals.append(bf)
    else:
        company_name = args.company_name.strip() or str(cfg.get("collection_name", "")).strip()
        if not company_name:
            sys.exit("--company-name 与 config['collection_name'] 都为空，无法确定公司名")

        out2 = run_step_processed_to_final(
            pdf_stems,
            args.config,
            company_name=company_name,
            lsh_threshold=DEFAULT_LSH_THRESHOLD,
            lsh_num_perm=DEFAULT_LSH_NUM_PERM,
            lsh_shingle_size=DEFAULT_LSH_SHINGLE_SIZE,
            lsh_min_tokens=DEFAULT_LSH_MIN_TOKENS,
            lsh_rerank=DEFAULT_LSH_RERANK,
            lsh_normalize_numbers=DEFAULT_LSH_NORMALIZE_NUMBERS,
            keep_policy=DEFAULT_KEEP_POLICY,
            llm_api_max_workers=DEFAULT_LLM_MAX_WORKERS,
            enable_summary=DEFAULT_ENABLE_SUMMARY,
        )
        logger.info("Step 2 完成: %s", out2)
        base_finals = [Path(p) for p in out2["base_finals"]]

    # ---------- Step 3: process_table ----------
    # 表格模型配置默认走 data_pipeline/.env 的 process_table_llm_*，不读取回答模型配置。
    if args.skip_process_table:
        logger.info("--skip-process-table：跳过 Step 3")
    else:
        out3 = run_step_process_table(
            pdf_stems,
            args.config,
            anthropic_api_key=None,
            anthropic_api_keys=None,
            tencent_api_key=None,
            tencent_base_url=DEFAULT_TENCENT_BASE_URL,
            claude_model=DEFAULT_CLAUDE_MODEL,
            tencent_model=DEFAULT_TENCENT_MODEL,
            max_workers=DEFAULT_TABLE_WORKERS,
            requests_per_minute=DEFAULT_TABLE_RPM,
            context_window=DEFAULT_TABLE_CONTEXT_WINDOW,
            save_interval=DEFAULT_TABLE_SAVE_INTERVAL,
        )
        logger.info("Step 3 完成: %s", out3)

    # ---------- Step 4: load_data (text) ----------
    if args.skip_load:
        logger.info("--skip-load：跳过 Step 4")
    else:
        out4 = run_step_final_to_chroma(
            base_finals,
            args.config,
            batch_size=DEFAULT_BATCH_SIZE,
            reset_persist=args.reset_persist,
        )
        logger.info("Step 4 完成: %s", out4)

    # ---------- Step 5: load_table_chroma ----------
    if args.skip_load_table:
        logger.info("--skip-load-table：跳过 Step 5")
    else:
        out5 = run_step_load_table(
            args.config,
            batch_size=DEFAULT_TABLE_BATCH_SIZE,
        )
        logger.info("Step 5 完成: %s", out5)

    # ---------- Step 6: PageIndex ----------
    if args.skip_pageindex:
        logger.info("--skip-pageindex：跳过 Step 6")
    else:
        out6 = run_step_build_pageindex(
            args.config,
            pageindex_repo_path=args.pageindex_repo_path,
        )
        logger.info("Step 6 完成: %s", out6)

    logger.info(
        "全部完成。若通过 deploy API 异步入库，完成后默认会热重载 API 进程内的 RAG；"
        "直接跑脚本的场景仍需自行重启 API 或触发重建。"
    )


if __name__ == "__main__":
    main()
