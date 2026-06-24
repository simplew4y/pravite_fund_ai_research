"""
文本指代消解和摘要生成工具（单文件版）

本脚本用于对单个JSON文件进行指代消解和摘要生成处理

使用方法：
    python script_name.py input.json output.json [--generate-summary]
"""

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict
from datetime import datetime
import argparse
from collections import defaultdict
import tiktoken
import hashlib

from utils import LLMCallError, chat_complete, usage_tracker


def compute_group_hash(title: str, contents: List[str]) -> str:
    """Compute hash over (title, contents) using the exact order passed to the
    summarizer. A NUL separator avoids boundary-collision between concatenated
    contents (e.g. ['ab','c'] vs ['a','bc']).
    """
    key_src = title + "\0" + "\0".join(contents)
    return hashlib.sha256(key_src.encode('utf-8')).hexdigest()


def compute_chunk_hash(content: str, context: str, company_name: str) -> str:
    """Compute hash over all inputs that determine the anaphora-resolution
    output: (company_name, context, content). Hashing only `content` is unsafe
    because identical boilerplate chunks in different positions have different
    preceding contexts and therefore different correct resolutions.
    """
    key_src = company_name + "\0" + context + "\0" + content
    return hashlib.sha256(key_src.encode('utf-8')).hexdigest()


def get_context_from_previous_chunks(chunks: List[Dict], current_idx: int, max_context: int = 4) -> str:
    """获取前文上下文"""
    context = []
    start_idx = max(0, current_idx - max_context)
    
    if current_idx == 0:
        return ""
    
    for i in range(start_idx, current_idx):
        if 0 <= i < len(chunks) and 'content' in chunks[i]:
            context.append(chunks[i]["content"])
    
    return " ".join(context)

def resolve_anaphora(text: str, context: str = "", company_name:str = "Lotus Technology") -> str:
    """执行指代消解"""
    prompt = f''' 
    You are a language model assistant. Your task is to enhance the given text by replacing ambiguous or 
    context-dependent words with more specific and clear alternatives, based on the context of {company_name}'s financial reports.

    Here are some guidelines for replacements:
    - Replace pronouns like "we" with the appropriate entity, but only use entities that appear in the current context:
      ✓ CORRECT: If the text mentions "{company_name}'s R&D department" earlier, then "we" → "{company_name}'s R&D department"
      ✗ INCORRECT: Don't introduce new entities or products that aren't mentioned in the context
    
    - When replacing "it" or other pronouns:
      ✓ CORRECT: Only use specific names/entities that were previously mentioned in the same or immediately preceding paragraph
      ✓ CORRECT: If the specific reference is unclear, use a descriptive but general term (e.g., "the company", "this initiative")
      ✗ INCORRECT: Don't introduce specific product names or entities that aren't in the source text

    - For product references:
      ✓ CORRECT: Only use exact product names that appear in the text
      ✓ CORRECT: If the specific product name isn't clear, use general terms like "the vehicle", "this model"
      ✗ INCORRECT: Don't make assumptions about which specific product is being discussed

    Examples:
    Original: "We developed it with cutting-edge technology."
    ✓ CORRECT (if previously mentioned): "{company_name}'s engineering team developed the Eletre SUV with cutting-edge technology."
    ✓ CORRECT (if product unclear): "{company_name}'s engineering team developed this vehicle with cutting-edge technology."
    ✗ INCORRECT: "{company_name}'s engineering team developed the Elise with cutting-edge technology."

    Quality check:
    - Before making any replacement, verify that the entity or term exists in the current context
    - If unsure about the specific reference, prefer using more general but accurate terms
    - Never introduce new information that isn't present in the source text

    IMPORTANT - READ CAREFULLY:
    === REFERENCE CONTEXT (Use only for understanding references) ===
    {context}

    === TARGET TEXT (This is the ONLY text you should improve) ===
    {text}
    
    INSTRUCTIONS:
    1. Use the reference context ONLY to understand what pronouns and references refer to
    2. Modify and output ONLY the target text
    3. DO NOT include any part of the reference context in your output
    4. DO NOT add any explanations or notes - output only the improved text


    Please note:
    1. Use only the reference context to understand the direction of pronouns and referents
    2. Only modify and output the target text without repeating the reference context
    3. Do not include any explanations or additional information, only output the improved text
    '''
    
    content = chat_complete(
        category="anaphora",
        messages=[
            {"role": "system", "content": "You are a highly accurate and context-aware text editor."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.1,
    )
    return content.strip()


def _summarize_group(title: str, contents: List[str]) -> str:
    """单次 LLM 调用：基于 (title + 所有 contents) 生成该标题组的整体摘要。"""
    joined = "\n\n".join(f"[{i+1}] {c}" for i, c in enumerate(contents))
    user_prompt = (
        f"Summarize a section of a financial / corporate document.\n"
        f"Section title (breadcrumb): {title}\n\n"
        f"Below are the chunks that belong to this section, separated by [index]:\n"
        f"{joined}\n\n"
        f"Write a single concise, faithful summary of this section as a whole. "
        f"Do not output a list; produce one coherent paragraph. "
        f"Do not add information that is not present in the chunks."
    )

    return chat_complete(
        category="summary",
        messages=[
            {"role": "system", "content": "You summarize financial document chunks for retrieval indexing."},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.1,
    )


def process_file(input_path: str, output_path: str, generate_summary: bool = True, company_name: str = "Lotus Technology", max_workers: int = 8):
    """处理单个文件的主函数"""
    log_path = os.path.join(os.path.dirname(input_path), 
                          f"{os.path.splitext(os.path.basename(input_path))[0]}_processed.log")

    def log(message: str):
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{timestamp}] {message}"
        print(line)
        with open(log_path, 'a', encoding='utf-8') as f:
            f.write(line + "\n")

    # ---------- 断点续跑用的缓存文件（JSONL，append-only） ----------
    anaphora_cache_path = output_path + ".anaphora_cache.jsonl"
    summary_cache_path = output_path + ".summary_cache.jsonl"
    cache_write_lock = threading.Lock()

    def _load_jsonl_cache(path: str, hash_key: str, value_key: str) -> Dict:
        """Load cache with hash as key and content as value."""
        cache = {}
        if not os.path.isfile(path):
            return cache
        with open(path, "r", encoding="utf-8") as cf:
            for line in cf:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if hash_key in rec and value_key in rec:
                    cache[rec[hash_key]] = rec[value_key]
        return cache

    def _append_jsonl(path: str, record: Dict):
        line = json.dumps(record, ensure_ascii=False)
        with cache_write_lock:
            with open(path, "a", encoding="utf-8") as cf:
                cf.write(line + "\n")

    try:
        log(f"开始处理文件: {input_path}")

        # ===== 早退：最终输出已存在则视为已完成 =====
        if os.path.isfile(output_path):
            try:
                with open(output_path, "r", encoding="utf-8") as f:
                    existing = json.load(f)
                if isinstance(existing, list) and existing:
                    log(f"输出文件已存在，跳过处理: {output_path}")
                    return
            except Exception:
                log(f"已有输出文件无法解析，将重新处理: {output_path}")

        usage_tracker.reset()

        # 读取输入文件
        with open(input_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # 处理元数据
        metadata = data[0] if (data and isinstance(data[0], dict) and 'start' in data[0]) else None
        chunks = data[1:] if metadata else data

        # ===== 加载已有缓存 =====
        anaphora_cache = _load_jsonl_cache(anaphora_cache_path, "chunk_hash", "content")
        summary_cache = _load_jsonl_cache(summary_cache_path, "group_hash", "summary")
        if anaphora_cache or summary_cache:
            log(
                f"加载缓存：anaphora={len(anaphora_cache)} 项, summary={len(summary_cache)} 项"
            )

        processed_chunks = []

        # 按标题分组处理（v2 后 title 为面包屑字符串，可直接作 key）
        title_groups = defaultdict(list)
        for chunk in chunks:
            title = chunk.get('title', '')
            title_groups[title].append(chunk)

        groups_list = list(title_groups.items())
        log(f"共 {len(groups_list)} 个标题组，使用 {max_workers} 线程并行调用 LLM")

        # 包装：调用 LLM 后立刻把结果写入对应缓存文件，便于断点续跑
        def _anaphora_task(text, context, chunk_hash: str):
            result = resolve_anaphora(text, context, company_name)
            _append_jsonl(anaphora_cache_path, {"chunk_hash": chunk_hash, "content": result})
            return result

        def _summary_task(title, contents, group_hash: str):
            result = _summarize_group(title, contents)
            _append_jsonl(summary_cache_path, {"group_hash": group_hash, "summary": result})
            return result

        # ----------------- 并行调度 -----------------
        # 对每个标题组提交 n+1 个 LLM 调用：
        #   - n 个 anaphora_resolution（每个 chunk 一个，context 基于原文快照）
        #   - 1 个 group summary（整组 title + 所有 contents 一次性调用）
        # 命中缓存的任务直接跳过提交。max_workers 控制全局 LLM 调用并发度。
        with ThreadPoolExecutor(max_workers=max_workers) as ex:
            anaphora_futures = {}        # id(chunk) -> Future[str]
            summary_futures = {}         # title -> Future[str]
            chunk_hash_map = {}          # id(chunk) -> chunk_hash (for cache lookup at write-out)

            for title, group in groups_list:
                # 提交 anaphora 任务（context 基于原文，不受其他线程改写影响）
                for idx, chunk in enumerate(group):
                    if 'content' not in chunk:
                        continue
                    context = get_context_from_previous_chunks(group, idx)
                    chunk_hash = compute_chunk_hash(chunk['content'], context, company_name)
                    chunk_hash_map[id(chunk)] = chunk_hash
                    if chunk_hash in anaphora_cache:
                        continue  # Cache hit, skip
                    anaphora_futures[id(chunk)] = ex.submit(
                        _anaphora_task, chunk['content'], context, chunk_hash
                    )

                # 提交一次性 group 摘要任务（空 title 跳过）
                # Use group_hash directly as cache key
                if generate_summary and title:
                    contents = [c['content'] for c in group if c.get('content')]
                    if contents:
                        group_hash = compute_group_hash(title, contents)
                        if group_hash not in summary_cache:
                            summary_futures[title] = ex.submit(_summary_task, title, contents, group_hash)

            # 收集摘要
            summaries = {}  # title -> summary
            
            for title, f in summary_futures.items():
                try:
                    summaries[title] = f.result()
                except LLMCallError as e:
                    log(f"摘要生成失败（重试用尽，title={title}）: {e}")
                    summaries[title] = f"错误: 摘要生成失败 ({e})"
                except Exception as e:
                    log(f"摘要生成失败 (title={title}): {e}")
                    summaries[title] = f"错误: 摘要生成失败 ({e})"

            # 应用 anaphora 结果并组装输出
            # 关键：按 chunks 的原始顺序写出，避免按标题分组重排；
            #      title_groups / groups_list 的 insertion-order 也保证了
            #      "首次出现" 的标题组顺序与原文一致。
            logged_titles = set()
            for chunk in chunks:
                title = chunk.get('title', '')
                title_summary = summaries.get(title, "")
                if title not in logged_titles:
                    log(f"正在写出标题组: {title}")
                    logged_titles.add(title)

                # 1) 缓存命中 (validated by chunk_hash during task submission)
                chunk_hash = chunk_hash_map.get(id(chunk))
                if chunk_hash is not None and chunk_hash in anaphora_cache:
                    chunk['content'] = anaphora_cache[chunk_hash]
                else:
                    fut = anaphora_futures.get(id(chunk))
                    if fut is not None:
                        try:
                            chunk['content'] = fut.result()
                        except LLMCallError as e:
                            chunk_id = chunk.get('id', 'unknown')
                            log(f"指代消解失败（重试用尽，id={chunk_id}）: {e}")
                            # 保留原文内容；同时把错误标记到 title_summary
                            title_summary = (title_summary or "") + f"\n错误: chunk {chunk_id} 指代消解失败"
                        except Exception as e:
                            chunk_id = chunk.get('id', 'unknown')
                            log(f"处理chunk {chunk_id} 失败: {str(e)}")

                if title_summary:
                    chunk['title_summary'] = (
                        f"title: {title}\nsummary: {title_summary}"
                    )
                else:
                    chunk['title_summary'] = ""

                if 'title' in chunk:
                    del chunk['title']
                processed_chunks.append(chunk)

        # 写入输出文件
        tmp_path = output_path + ".tmp"
        with open(tmp_path, 'w', encoding='utf-8') as f:
            output_data = [metadata] + processed_chunks if metadata else processed_chunks
            json.dump(output_data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, output_path)

        log(f"处理完成，结果已保存到: {output_path}")
        log(f"LLM usage summary: {json.dumps(usage_tracker.snapshot(), ensure_ascii=False)}")

        # 输出成功后，清理缓存文件
        for p in (anaphora_cache_path, summary_cache_path):
            try:
                if os.path.isfile(p):
                    os.remove(p)
            except OSError:
                pass

    except Exception as e:
        log(f"处理失败: {str(e)}")
        raise

def generate_group_summary(title: str, contents: List[str]) -> str:
    """[兼容保留] 单次 LLM 调用生成分组摘要。"""
    try:
        return _summarize_group(title, contents)
    except Exception as e:
        return f"摘要生成失败: {str(e)}"


def main():
    parser = argparse.ArgumentParser(description='单文件文本处理工具')
    parser.add_argument('input', help='输入JSON文件路径')
    parser.add_argument('output', help='输出JSON文件路径')
    parser.add_argument('company_name', help='待处理文件的公司名称')
    parser.add_argument('--generate-summary', action='store_true',
                      help='是否生成摘要（默认启用）', default=True)
    parser.add_argument('--max-workers', type=int, default=8,
                      help='LLM 并发线程数（默认 8）')

    args = parser.parse_args()

    # 输入验证
    if not os.path.isfile(args.input):
        raise FileNotFoundError(f"输入文件不存在: {args.input}")
    if not args.input.endswith('.json'):
        raise ValueError("输入文件必须是JSON格式")

    process_file(
        args.input,
        args.output,
        args.generate_summary,
        args.company_name,
        max_workers=args.max_workers,
    )

if __name__ == "__main__":
    main()
