#!/usr/bin/env python3
"""
run_sec_batch_pipeline.py — 批量为 SEC-filings-USA 下多个公司构建 FinSagent 数据集

架构
----
- 每个公司作为独立的子进程串行执行，彼此完全隔离
- 主进程（调度器）只负责依次启动各公司子进程并汇总结果
- 各公司子进程负责：读配置、收集 PDF、生成临时 config、调用 pipeline

目录约定
--------
源 PDF 位于：
    {SEC_SRC}/{company}/{year}_source_documents/*.pdf
    → SEC_SRC = /root/autodl-tmp/RAG_Agent_data/SEC-filings-USA

构建产物放在：
    {DATA_ROOT}/{company}/5_database_{company}/   ← persist_directory
    {DATA_ROOT}/{company}/0_raw_pdf/              ← pipeline 自动生成（DatasetLayout）
    {DATA_ROOT}/{company}/1_processed_pdf/
    ...
    {DATA_ROOT}/{company}/5_database_{company}/pageindex/
    → DATA_ROOT = /root/autodl-tmp/RAG_Agent_data

日志
----
- 调度器日志：pe_logs/sec_batch/batch_{ts}.log
- 每个公司独立日志：pe_logs/sec_batch/{company}_{ts}.log

用法
----
    # 按脚本内 COMPANIES 配置全量运行
    python data_pipeline/run_sec_batch_pipeline.py

    # 指定公司和年份
    python data_pipeline/run_sec_batch_pipeline.py --companies google meta --years 2025 2026

    # 跑 COMPANIES 配置中的全部公司
    python data_pipeline/run_sec_batch_pipeline.py --companies all

    # 跑全部公司，但统一限定年份
    python data_pipeline/run_sec_batch_pipeline.py --companies all --years 2025

    # 跳过某些步骤
    python data_pipeline/run_sec_batch_pipeline.py --skip-process-table --skip-pageindex

    # 先 dry-run 确认命令
    python data_pipeline/run_sec_batch_pipeline.py --dry-run --companies google --years 2025
"""

from __future__ import annotations

import argparse
import copy
import logging
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import yaml

# ---------------------------------------------------------------------------
# ★ 在这里配置要跑哪些公司和年份
# ---------------------------------------------------------------------------
# 格式：{公司名: [年份列表]}
#   - 年份列表为空 [] 表示跑该公司下所有 {year}_source_documents 目录
#   - 注释掉某公司 = 跳过
COMPANIES: dict[str, list[int]] = {
    "amazon":    [2025, 2026],           # 空列表 = 所有年份 
    "amd":       [2025, 2026],
    "apple":     [2025, 2026],
    "eli_lilly": [2025, 2026], #14
    "google":    [2025, 2026],
    "meta":      [2025, 2026],
    "micron":    [2025, 2026],
    "microsoft": [2025, 2026],
    "netflix":   [2025, 2026], #13
    "oracle":    [2025, 2026],
    "palantir":  [2025, 2026], #12
    "sandisk":   [2025, 2026],
    "tesla":     [2025, 2026],
    "tsmc":      [2025, 2026], #15
}

# ---------------------------------------------------------------------------
# 路径常量
# ---------------------------------------------------------------------------
# 构建产物根目录（{DATA_ROOT}/{company}/...）
DATA_ROOT     = Path("/root/autodl-tmp/RAG_Agent_data")
# 源 PDF 根目录（{SEC_SRC}/{company}/{year}_source_documents/*.pdf）
SEC_SRC       = DATA_ROOT / "SEC-filings-USA"
REPO_ROOT     = Path(__file__).resolve().parent.parent   # FinSagent_corpus/
BASE_CONFIG   = REPO_ROOT / "config" / "production.yaml"
PIPELINE      = REPO_ROOT / "data_pipeline" / "file2chunk2data_pipeline.py"
PYTHON        = sys.executable
BATCH_LOG_DIR = REPO_ROOT / "pe_logs" / "sec_batch"
THIS_SCRIPT   = Path(__file__).resolve()


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def _setup_logging(log_path: Path, name: str = "sec_batch") -> logging.Logger:
    """配置 logging，同时输出到终端和指定日志文件。"""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    if logger.handlers:
        return logger
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    fh = logging.FileHandler(str(log_path), encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(sh)
    logger.addHandler(fh)
    return logger


def _find_source_years(company_src_dir: Path, year_filter: list[int]) -> list[int]:
    """扫描 {company_src_dir}/{year}_source_documents，返回匹配年份（升序）。"""
    years: list[int] = []
    for entry in sorted(company_src_dir.iterdir()):
        if not entry.is_dir():
            continue
        name = entry.name
        if not name.endswith("_source_documents"):
            continue
        year_str = name.replace("_source_documents", "")
        if not year_str.isdigit():
            continue
        year = int(year_str)
        if year_filter and year not in year_filter:
            continue
        years.append(year)
    return sorted(years)


def _collect_pdfs(company_src_dir: Path, years: list[int]) -> list[Path]:
    """收集指定年份 source_documents 目录下的所有 PDF（按文件名升序）。"""
    pdfs: list[Path] = []
    seen: set[str] = set()
    for year in years:
        src_dir = company_src_dir / f"{year}_source_documents"
        if not src_dir.is_dir():
            continue
        for pdf in sorted(src_dir.glob("*.pdf")):
            if pdf.name not in seen:
                seen.add(pdf.name)
                pdfs.append(pdf)
    return pdfs


def _make_company_config(company: str, persist_dir: Path) -> dict:
    """读取 base config，覆盖公司专属字段，返回深拷贝 dict。"""
    with open(BASE_CONFIG, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    cfg = copy.deepcopy(cfg)
    cfg["persist_directory"]   = str(persist_dir)
    cfg["collection_name"]     = company
    cfg["pageindex_index_dir"] = str(persist_dir / "pageindex")
    return cfg


def _write_temp_config(cfg: dict, tmp_dir: str) -> str:
    """把 config dict 写入临时 YAML 文件，返回路径。"""
    path = os.path.join(tmp_dir, "pipeline_config.yaml")
    with open(path, "w", encoding="utf-8") as f:
        yaml.dump(cfg, f, allow_unicode=True, default_flow_style=False)
    return path


def _run_pipeline(
    config_path: str,
    pdfs: list[Path],
    company: str,
    pipeline_log: Path,
    *,
    skip_mineru: bool = False,
    skip_file2chunk: bool = False,
    skip_process_table: bool = False,
    skip_load: bool = False,
    skip_load_table: bool = False,
    skip_pageindex: bool = False,
    dry_run: bool = False,
) -> int:
    """调用 file2chunk2data_pipeline.py，日志追加到 pipeline_log，返回 returncode。"""
    cmd = [PYTHON, str(PIPELINE), "--config", config_path, "--company-name", company]
    for pdf in pdfs:
        cmd += ["--pdf", str(pdf)]
    if skip_mineru:        cmd.append("--skip-mineru")
    if skip_file2chunk:    cmd.append("--skip-file2chunk")
    if skip_process_table: cmd.append("--skip-process-table")
    if skip_load:          cmd.append("--skip-load")
    if skip_load_table:    cmd.append("--skip-load-table")
    if skip_pageindex:     cmd.append("--skip-pageindex")

    cmd_str = " ".join(str(c) for c in cmd)
    if dry_run:
        print(f"[DRY-RUN] {cmd_str}")
        return 0

    pipeline_log.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PYTHONPATH"] = (
        str(REPO_ROOT / "src") + os.pathsep
        + str(REPO_ROOT / "data_pipeline") + os.pathsep
        + env.get("PYTHONPATH", "")
    )
    with open(pipeline_log, "a", encoding="utf-8") as lf:
        lf.write(f"{'='*60}\nPIPELINE CMD: {cmd_str}\n\n")
        lf.flush()
        proc = subprocess.run(
            cmd, cwd=str(REPO_ROOT), env=env,
            stdout=lf, stderr=subprocess.STDOUT,
        )
    return proc.returncode


# ---------------------------------------------------------------------------
# 单公司执行模式（由调度器以子进程方式调用）
# ---------------------------------------------------------------------------
def _exec_company(args: argparse.Namespace) -> int:
    """在独立子进程中执行单个公司的完整 pipeline。"""
    company    = args.companies[0]
    year_filter: list[int] = list(args.years or [])
    ts         = args._ts

    company_log = BATCH_LOG_DIR / f"{company}_{ts}.log"
    logger = _setup_logging(company_log, name=f"sec.{company}")
    logger.info("=" * 60)
    logger.info("[%s] 子进程启动 (ts=%s)", company, ts)

    src_dir = SEC_SRC / company
    if not src_dir.is_dir():
        logger.error("[%s] 源目录不存在: %s", company, src_dir)
        return 1

    years = _find_source_years(src_dir, year_filter)
    if not years:
        logger.warning("[%s] 无匹配 _source_documents（年份过滤=%s）", company, year_filter)
        return 1

    pdfs = _collect_pdfs(src_dir, years)
    if not pdfs:
        logger.warning("[%s] 无 PDF (years=%s)", company, years)
        return 1

    logger.info("[%s] 年份=%s，共 %d 个 PDF", company, years, len(pdfs))

    persist_dir = DATA_ROOT / company / f"5_database_{company}"
    cfg = _make_company_config(company, persist_dir)

    with tempfile.TemporaryDirectory(prefix=f"sec_{company}_") as tmp_dir:
        config_path = _write_temp_config(cfg, tmp_dir)
        rc = _run_pipeline(
            config_path=config_path,
            pdfs=pdfs,
            company=company,
            pipeline_log=company_log,
            skip_mineru=args.skip_mineru,
            skip_file2chunk=args.skip_file2chunk,
            skip_process_table=args.skip_process_table,
            skip_load=args.skip_load,
            skip_load_table=args.skip_load_table,
            skip_pageindex=args.skip_pageindex,
            dry_run=args.dry_run,
        )

    if rc == 0:
        logger.info("[%s] ✅ 全部完成", company)
    else:
        logger.error("[%s] ❌ 失败 (returncode=%d)", company, rc)
    return rc


# ---------------------------------------------------------------------------
# 调度器模式（主进程）
# ---------------------------------------------------------------------------
def _build_companies_to_run(args: argparse.Namespace) -> dict[str, list[int]]:
    companies: dict[str, list[int]] = {}
    if args.companies:
        if any(str(c).lower() == "all" for c in args.companies):
            companies = dict(COMPANIES)
        else:
            for c in args.companies:
                if c not in COMPANIES:
                    logging.getLogger("sec_batch").warning("公司 %s 不在 COMPANIES 配置中，已跳过", c)
                    continue
                companies[c] = COMPANIES[c]
    else:
        companies = dict(COMPANIES)
    if args.years:
        companies = {c: list(args.years) for c in companies}
    return companies


def _spawn_company(company: str, year_filter: list[int], ts: str, args: argparse.Namespace) -> int:
    """以独立子进程方式运行单个公司，返回 returncode。"""
    cmd = [
        PYTHON, str(THIS_SCRIPT),
        "--_exec-company", "--_ts", ts,
        "--companies", company,
    ]
    if year_filter:
        cmd += ["--years"] + [str(y) for y in year_filter]
    if args.skip_mineru:        cmd.append("--skip-mineru")
    if args.skip_file2chunk:    cmd.append("--skip-file2chunk")
    if args.skip_process_table: cmd.append("--skip-process-table")
    if args.skip_load:          cmd.append("--skip-load")
    if args.skip_load_table:    cmd.append("--skip-load-table")
    if args.skip_pageindex:     cmd.append("--skip-pageindex")
    if args.dry_run:            cmd.append("--dry-run")

    result = subprocess.run(cmd, cwd=str(REPO_ROOT))
    return result.returncode


def _orchestrate(args: argparse.Namespace) -> None:
    """调度器：串行启动各公司的独立子进程。"""
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = BATCH_LOG_DIR / f"batch_{ts}.log"
    logger = _setup_logging(log_file, name="sec_batch")
    logger.info("SEC 批量 pipeline 启动，日志: %s", log_file)

    companies_to_run = _build_companies_to_run(args)
    if not companies_to_run:
        logger.error("没有有效公司，退出")
        sys.exit(1)

    logger.info("待处理公司（共 %d 个）：%s", len(companies_to_run), list(companies_to_run))

    success_list: list[str] = []
    failure_list: list[tuple[str, int]] = []

    for idx, (company, year_filter) in enumerate(companies_to_run.items(), 1):
        company_log = BATCH_LOG_DIR / f"{company}_{ts}.log"
        logger.info(
            "[%d/%d] %s 启动独立子进程 → 日志: %s",
            idx, len(companies_to_run), company, company_log,
        )
        rc = _spawn_company(company, year_filter, ts, args)
        if rc == 0:
            logger.info("[%d/%d] %s ✅ 成功", idx, len(companies_to_run), company)
            success_list.append(company)
        else:
            logger.error(
                "[%d/%d] %s ❌ 失败 (rc=%d)，详见 %s",
                idx, len(companies_to_run), company, rc, company_log,
            )
            failure_list.append((company, rc))

    logger.info("=" * 60)
    logger.info("批量完成：成功 %d / %d", len(success_list), len(companies_to_run))
    if success_list:
        logger.info("✅ 成功：%s", ", ".join(success_list))
    if failure_list:
        logger.error("❌ 失败：%s", ", ".join(f"{c}(rc={r})" for c, r in failure_list))
        sys.exit(1)


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="SEC-filings 批量 pipeline 构建脚本")
    parser.add_argument("--companies", nargs="*", default=None,
                        help="只跑指定公司；传 all 表示跑 COMPANIES 中的全部公司（默认同样跑全部）")
    parser.add_argument("--years", nargs="*", type=int, default=None,
                        help="覆盖所有公司的年份过滤（如 --years 2025 2026）")
    parser.add_argument("--skip-mineru",        action="store_true", help="跳过 Step 1 mineru")
    parser.add_argument("--skip-file2chunk",    action="store_true", help="跳过 Step 2 file2chunk")
    parser.add_argument("--skip-process-table", action="store_true", help="跳过 Step 3 process_table")
    parser.add_argument("--skip-load",          action="store_true", help="跳过 Step 4 load_data")
    parser.add_argument("--skip-load-table",    action="store_true", help="跳过 Step 5 load_table_chroma")
    parser.add_argument("--skip-pageindex",     action="store_true", help="跳过 Step 6 PageIndex 构建")
    parser.add_argument("--dry-run",            action="store_true", help="只打印命令，不实际运行")
    # 内部参数（调度器调用子进程时使用，不暴露给用户）
    parser.add_argument("--_exec-company", dest="_exec_company", action="store_true",
                        help=argparse.SUPPRESS)
    parser.add_argument("--_ts", dest="_ts", default=None, help=argparse.SUPPRESS)
    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if args._exec_company:
        # 单公司子进程模式
        if not args.companies or len(args.companies) != 1:
            print("--_exec-company 需要通过 --companies 指定恰好一个公司", file=sys.stderr)
            sys.exit(2)
        if not args._ts:
            args._ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        sys.exit(_exec_company(args))
    else:
        # 调度器模式
        _orchestrate(args)


if __name__ == "__main__":
    main()
