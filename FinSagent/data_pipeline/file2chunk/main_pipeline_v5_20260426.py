"""
File-to-chunk pipeline v4 (2026-04-25)

相对 v3 的差异
================
- **Step 4** 改用 ``step4_similarity_analysis_lsh.py``：MinHash + Banded LSH 召回，
  Jaccard / TF-IDF 双重精排。CPU 即可处理百万级 chunk，避免旧版 dense GPU TF-IDF
  在大文档上的 OOM。
- **Step 5** 改用 ``step5_delete_similar_chunks_union_set.py``：基于 Union-Find
  的等价类去重，修复了旧版在传递性相似链上 (A,B,C,D) 行为不确定的问题。每个
  等价类按 ``--keep-policy`` 选代表（默认 ``longest``）。
- 其余步骤 (Step 2/3/6/7/8/9) 与 v3 完全一致。

被这些步骤生成的产物文件名也保持与 v3 兼容，因此 ``build_step_paths`` 无需修改。
"""

import concurrent.futures
import json
import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

os.sync()  # 强制将内存中的数据写入磁盘

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log_file = "/root/autodl-tmp/cjj/code/file2chunk/main_pipeline_v4_20260425.log"
logging.basicConfig(
    filename=log_file,
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)

# 锁：用于 check_file_existence，避免多线程同时争抢同一文件
lock = threading.Lock()


# ---------------------------------------------------------------------------
# Path helpers (same as v3)
# ---------------------------------------------------------------------------
def find_subdirs(root_path: Path):
    return [
        str(dir_path).split("/")[-1]
        for dir_path in root_path.iterdir()
        if dir_path.is_dir()
    ]


def replace_spaces_in_path(path: str) -> str:
    """替换路径中的空格为下划线"""
    return path.replace(" ", "_")


def validate_path(path: str) -> str:
    if not os.path.exists(path):
        raise FileNotFoundError(f"路径不存在: {path}")
    return os.path.abspath(path)


def build_step_paths(input_path: str, output_dir: str) -> dict:
    """构建各步骤路径的工厂函数。文件命名与 v3 保持一致。"""
    base_name = os.path.basename(input_path)
    # base_name = base_name.replace("_content_list", "").replace(".json", "")
    base_name = base_name.replace("_content_list_v2", "").replace("_content_list", "").replace(".json", "")
    base_name = replace_spaces_in_path(base_name)

    paths = {
        "step2_output": os.path.join(output_dir, base_name, "base.json"),
        "step3_output": os.path.join(output_dir, base_name, "base_remove_empty.json"),
        # step4_lsh 用 stem + "_similarity_results.json"，stem 来自 step3_output
        "step4_output": os.path.join(
            output_dir, base_name, "base_remove_empty_similarity_results.json"
        ),
        # step5 union-find 输出 *_deduped + *_dedup_report
        "step5_output": os.path.join(
            output_dir, base_name, "base_remove_empty_deduped.json"
        ),
        "step5_report": os.path.join(
            output_dir, base_name, "base_remove_empty_dedup_report.json"
        ),
        "step6_output": os.path.join(
            output_dir, base_name, "base_remove_empty_deduped_processed.json"
        ),
        "step7_output": os.path.join(
            output_dir, base_name, "base_processed_chunked.json"
        ),
        "step8_output": os.path.join(output_dir, base_name, "base_final.json"),
        "work_dir": os.path.join(output_dir, base_name),
    }
    return paths


def check_file_existence(file_path: str) -> None:
    """确保文件存在；轮询等待。"""
    with lock:
        while not os.path.exists(file_path):
            logging.info(f"文件 {file_path} 尚未生成，等待中...")
            time.sleep(1)


def reset_ids(file_path: str) -> None:
    """重设 JSON 文件中的 ID，从 1 开始。"""
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    current_id = 1
    for item in data:
        if "id" in item:
            item["id"] = current_id
            current_id += 1
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def generate_final_json(step7_output_path: str, final_output_path: str) -> None:
    with open(step7_output_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    with open(final_output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Per-document pipeline
# ---------------------------------------------------------------------------
def process_document(
    input_path: str,
    output_dir: str,
    *,
    # Step 4 (LSH) options
    lsh_threshold: float = 0.85,
    lsh_num_perm: int = 128,
    lsh_shingle_size: int = 5,
    lsh_min_tokens: int = 30,
    lsh_rerank: str = "both",
    lsh_normalize_numbers: bool = False,
    # Step 5 (union-find) options
    keep_policy: str = "longest",
    # Step 6 anaphora resolution
    company_name: str,
    llm_api_max_workers: int = 8,
    # misc
    enable_summary: bool = True,
) -> None:
    try:
        # ============= 初始化验证 =============
        input_path = validate_path(input_path)
        output_dir = validate_path(output_dir)
        os.makedirs(output_dir, exist_ok=True)

        path_config = build_step_paths(input_path, output_dir)
        work_dir = path_config["work_dir"]
        os.makedirs(work_dir, exist_ok=True)

        # 已处理则跳过
        if os.path.isfile(path_config["step8_output"]):
            logging.info(
                f"已存在 base_final.json，跳过处理: {path_config['step8_output']}"
            )
            print(f"[SKIP] base_final.json already exists: {path_config['step8_output']}")
            return

        # ============= Step 2: 基础处理 =============
        logging.info("[Step 2/9] 启动基础处理流程 (跳过图片分析)...")
        step2_cmd = [
            "python",
            "step2_mineru2base_v2.py",
            input_path,
            output_dir,
            "--skip-image-chunks",
            "--company-name", company_name,
        ]
        subprocess.run(step2_cmd, check=True)
        check_file_existence(path_config["step2_output"])
        logging.info(f"基础处理完成: {path_config['step2_output']}")

        # ============= Step 3: 数据清洗 =============
        logging.info("[Step 3/9] 启动数据清洗...")
        step3_cmd = [
            "python",
            "step3_remove_empty_content.py",
            path_config["step2_output"],
        ]
        subprocess.run(step3_cmd, check=True)
        check_file_existence(path_config["step3_output"])
        logging.info(f"数据清洗完成: {path_config['step3_output']}")

        # ============= Step 4: 相似度分析 (MinHash + LSH) =============
        logging.info("[Step 4/9] 启动相似度分析 (MinHash+LSH)...")
        # step4_cmd = [
        #     "python",
        #     "step4_similarity_analysis_lsh.py",
        #     path_config["step3_output"],
        #     "--threshold", str(lsh_threshold),
        #     "--num-perm", str(lsh_num_perm),
        #     "--shingle-size", str(lsh_shingle_size),
        #     "--min-tokens", str(lsh_min_tokens),
        #     "--rerank", lsh_rerank,
        #     "--max-workers", "1",  # 外层已经有线程池，内层串行即可
        # ]
        # if lsh_normalize_numbers:
        #     step4_cmd.append("--normalize-numbers")

        # ---- [LEGACY] 老版 Step 4: dense TF-IDF 全量余弦 ----
        # 两版 step4 输出 schema 一致（similar_pairs[*].chunk1.id/chunk2.id），
        # 老版阈值语义是 TF-IDF cosine，建议 0.95+；LSH 版建议 0.85。
        # 切换时取消下方注释并注释掉上方 step4_cmd。
        step4_cmd = [
            "python",
            "step4_similarity_analysis.py",
            path_config["step3_output"],
            "--threshold", str(lsh_threshold),
            "--max_workers", "1",
        ]

        subprocess.run(step4_cmd, check=True)
        check_file_existence(path_config["step4_output"])
        logging.info(f"相似度分析完成: {path_config['step4_output']}")

        # ============= Step 5: 去重 (Union-Find 等价类) =============
        print("[Step 5/9] 启动去重处理 (Union-Find)...")
        # step5_cmd = [
        #     "python",
        #     "step5_delete_similar_chunks_union_set.py",
        #     path_config["step4_output"],
        #     path_config["step3_output"],
        #     "--keep-policy", keep_policy,
        # ]

        # ---- [LEGACY] 老版 Step 5: 直接删 chunk2（无等价类，存在传递性 bug） ----
        # 仅作 baseline 对比用；日常请使用上方 union-find 版。
        step5_cmd = [
            "python",
            "step5_delete_similar_chunks.py",
            path_config["step4_output"],
            path_config["step3_output"],
        ]

        subprocess.run(step5_cmd, check=True)
        check_file_existence(path_config["step5_output"])
        logging.info(f"去重处理完成: {path_config['step5_output']}")
        if os.path.exists(path_config["step5_report"]):
            logging.info(f"去重诊断报告: {path_config['step5_report']}")

        time.sleep(2)  # 让磁盘 flush 一下

        # ============= Step 6: 指代消解与摘要生成 =============
        print("[Step 6/9] 启动指代消解与摘要生成...")
        check_file_existence(path_config["step5_output"])
        try:
            with open(path_config["step5_output"], "r", encoding="utf-8") as f:
                data = json.load(f)
                if not data:
                    raise ValueError("步骤5输出文件为空")
        except Exception as e:
            raise ValueError(f"步骤5输出文件无效: {str(e)}")

        os.makedirs(os.path.dirname(path_config["step6_output"]), exist_ok=True)
        step6_cmd = [
            "python",
            "step6_anaphora_resolution_general.py",
            os.path.abspath(path_config["step5_output"]),
            os.path.abspath(path_config["step6_output"]),
            company_name,
            "--max-workers", str(llm_api_max_workers),
            "--generate-summary" if enable_summary else "",
        ]
        # 过滤空字符串参数
        step6_cmd = [a for a in step6_cmd if a]
        subprocess.run(step6_cmd, check=True)
        check_file_existence(path_config["step6_output"])
        logging.info(f"指代消解与摘要生成完成: {path_config['step6_output']}")

        # ============= Step 7: 文本分块 =============
        logging.info("[Step 7/9] 启动文本分块处理...")
        step7_cmd = [
            "python",
            "step7_split_chunks.py",
            "-i", path_config["step6_output"],
            "-o", path_config["step7_output"],
            "-s", str(256),
        ]
        subprocess.run(step7_cmd, check=True)
        check_file_existence(path_config["step7_output"])
        logging.info(f"文本分块处理完成: {path_config['step7_output']}")

        # ============= Step 8: 重设 ID =============
        logging.info("[Step 8/9] 启动 ID 重设处理...")
        reset_ids(path_config["step7_output"])

        # ============= Step 9: 生成 final.json =============
        logging.info("[Step 9/9] 生成 final.json 文件...")
        generate_final_json(path_config["step7_output"], path_config["step8_output"])
        logging.info(f"final.json 生成完成: {path_config['step8_output']}")

    except subprocess.CalledProcessError as e:
        logging.error(f"子流程执行失败: {str(e)}")
        sys.exit(1)
    except Exception as e:
        logging.error(f"流程错误: {str(e)}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    # ===== 路径与目录配置（按需修改） =====
    # root_folder = "/root/autodl-tmp/RAG_Agent_data/Zeekr/20260301/processed_pdf"
    # output_dir = "/root/autodl-tmp/RAG_Agent_data/Zeekr/20260301/final_pdf"

    root_folder = "/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/1_processed_pdf"
    output_dir = "/root/autodl-tmp/RAG_Agent_data/nvidia/20260425/2_final_pdf_v2"

    # ===== Step 4 / Step 5 关键参数 =====
    # 注：v3 用的是 0.98 的高阈值（旧 dense TF-IDF 余弦），LSH 路线建议 0.85；
    # 若想保留 v3 的"几乎逐字才合并"语义，可以把 lsh_threshold 调到 0.95+。
    lsh_threshold = 0.98 # 0.85
    lsh_num_perm = 128
    lsh_shingle_size = 5
    lsh_min_tokens = 30
    lsh_rerank = "both"            # none | jaccard | tfidf | both
    lsh_normalize_numbers = False  # SEC 财报建议 False，避免误合并不同季度
    keep_policy = "longest"        # longest | smallest_id | first

    company_name = "nvidia"

    llm_api_max_workers = 8  # 文档串行处理；step6 内部 LLM 调用并行度
    enable_summary = True

    # ===== 创建输出目录（如果不存在）=====
    os.makedirs(output_dir, exist_ok=True)

    # ===== 收集需要处理的 _content_list.json =====
    processed = find_subdirs(Path(output_dir))
    whole_list = find_subdirs(Path(root_folder))
    unfinished = [x for x in whole_list if x not in processed]

    content_list_files = []
    for subdir, _, files in os.walk(root_folder):
        for file in files:
            if file.endswith("_content_list_v2.json"):
                if subdir.split("/")[-2] in unfinished:
                    content_list_files.append(os.path.join(subdir, file))
                else:
                    print(subdir)

    for content_file in content_list_files:
        logging.info(f"{content_file}")
    logging.info(f"{len(content_list_files)} files in total")
    print(f"Found {len(content_list_files)} files to process")

    # ===== 串行处理每个文档（step6 内部并行调用 LLM） =====
    for idx, input_path in enumerate(content_list_files, start=1):
        print(f"\n=== [{idx}/{len(content_list_files)}] Processing: {input_path} ===")
        logging.info(f"=== [{idx}/{len(content_list_files)}] Processing: {input_path} ===")
        try:
            process_document(
                input_path,
                output_dir,
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
        except SystemExit as e:
            logging.error(f"文档处理失败 (SystemExit={e.code}): {input_path}")
            print(f"[ERROR] 文档处理失败: {input_path}")
        except Exception as e:
            logging.error(f"文档处理异常: {input_path} -> {e}")
            print(f"[ERROR] 文档处理异常: {input_path} -> {e}")


if __name__ == "__main__":
    main()
