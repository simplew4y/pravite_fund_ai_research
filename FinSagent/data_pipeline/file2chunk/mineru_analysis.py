
#!/usr/bin/env python3

"""
批量调用 mineru
固定把 INPUT_DIR 下的所有 PDF 送入 mineru
结果统一写到 OUTPUT_DIR。
"""

import subprocess
from pathlib import Path
import sys
import os
env = os.environ.copy()
env["MINERU_MODEL_SOURCE"] = "modelscope"
env["MINERU_TOOLS_CONFIG_JSON"] = "/root/mineru.json"
env["MINERU_FORMULA_ENABLE"] = "true"

# ======== 在这里修改 =========
#INPUT_DIR  = Path("/root/autodl-tmp/RAG_Agent_data/pdf/2025_4/4")   # PDF 文件夹
#OUTPUT_DIR = Path("/root/autodl-tmp/file2chunk/script/pipeline_test")     # 输出文件夹

# INPUT_DIR  = Path("/root/autodl-tmp/A100/RAG_Agent_data/finDER/10k_pdf")   # PDF 文件夹
# OUTPUT_DIR = Path("/root/autodl-tmp/A100/RAG_Agent_data/finDER/magic_pdf_out")     # 输出文件夹

# INPUT_DIR = Path("/root/autodl-tmp/RAG_Agent_data/Zeekr/20260301/raw_pdf")
# OUTPUT_DIR = Path("/root/autodl-tmp/RAG_Agent_data/Zeekr/20260301/processed_pdf")

# * Finance bench
# INPUT_DIR = Path("/root/autodl-tmp/RAG_Agent_data/finance_bench/financebench-main/pdfs_filtered")
# OUTPUT_DIR = Path("/root/autodl-tmp/RAG_Agent_data/finance_bench/financebench-main/pdfs_filtered_processed")

# * Lotus 20250701
# INPUT_DIR = Path("/root/autodl-tmp/RAG_Agent_data/lotus/20250701/all_pdf")
# OUTPUT_DIR = Path("/root/autodl-tmp/RAG_Agent_data/lotus/20250701/all_pdf_processed")

# SECQUE
# INPUT_DIR = Path("/root/autodl-tmp/RAG_Agent_data/secque/raw_pdf")
# OUTPUT_DIR = Path("/root/autodl-tmp/RAG_Agent_data/secque/processed_pdf")

# NVIDIA
INPUT_DIR = Path("/root/autodl-tmp/RAG_Agent_data/nvidia/20260424/0_raw_pdf")
OUTPUT_DIR = Path("/root/autodl-tmp/RAG_Agent_data/nvidia/20260424/1_processed_pdf")


LANG       = "en"                                        # 语言代码
# =============================

def run_magic(pdf_path: Path):
    """对单个 PDF 调用 mineru"""
    cmd = [
        "mineru",
        "-p", str(pdf_path),
        "-o", str(OUTPUT_DIR),
        "-b", "hybrid-auto-engine",
        "-l", LANG,
        "--gpu-memory-utilization", "0.2",
    ]
    try:
        subprocess.run(cmd, check=True, env=env)
        print(f"[✓] {pdf_path.name}")
        import gc
        gc.collect()
    except subprocess.CalledProcessError as e:
        print(f"[✗] {pdf_path.name} 处理失败：{e}", file=sys.stderr)

def main():
    # 确保输出目录存在
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # 找到所有 PDF（只查这一层；改为 rglob("*.pdf") 可递归）
    pdf_files = sorted(p for p in INPUT_DIR.glob("*.pdf") if p.is_file())
    if not pdf_files:
        print("未找到任何 PDF 文件", file=sys.stderr)
        return

    for pdf in pdf_files:
        # out_subdir = OUTPUT_DIR / pdf.stem
        expected = OUTPUT_DIR / pdf.stem / "hybrid_auto" / f"{pdf.stem}.md" 
        if expected.exists():
            print(f"[⊘] {pdf.name} 已存在，跳过")
            continue
        run_magic(pdf)

if __name__ == "__main__":
    main()
