# """
# 文本相似度分析工具

# 本脚本是一个用于分析 JSON 格式文本数据相似度的工具。
# 它读取包含文本内容的 JSON 文件，进行文本预处理，计算文本嵌入，并基于余弦相似度找出相似的文本对。

# 功能特点：
# - 使用 jieba 进行中文文本分词。
# - 构建词表，支持低频词过滤以减少维度。
# - 使用 PyTorch 高效计算文本特征矩阵。
# - 基于批次的相似度计算，支持大规模数据集处理。
# - 支持配置相似度阈值、批量大小和计算设备（CPU 或 GPU）。
# - 多线程处理，支持同时分析多个 JSON 文件。

# 模块及主要组件：
# - `TextSimilarityAnalyzer`: 主类，用于分析单个 JSON 文件中的文本相似度。
# - `process_file`: 辅助函数，用于处理单个文件。
# - 命令行接口（CLI），支持批量文件处理，并可设置相似度阈值和线程数。

# 使用方法：
# **命令行使用**：
# python step4_similarity_analysis.py input_files [--threshold 阈值] [--max_workers 最大线程数]

# 参数说明：
# - `input_files`: 输入 JSON 文件的路径列表（支持通配符）。
# - `--threshold`: 相似度阈值（默认值：0.7）。
# - `--max_workers`: 最大线程数（默认值：4）。

# 使用示例：
#     # 处理单个文件
#     python step4_similarity_analysis.py path/to/file.json

# 类说明：
#     TextSimilarityAnalyzer: 用于分析 JSON 文件中文本相似度，并输出相似对的结果。    
    
# 输出：
#     日志文件保存到输入文件所在目录，文件名格式为 _similarity_analysis.log。
#     分析结果保存为 JSON 格式，文件名格式为 _similarity_results.json。
#     结果包含元数据（文件信息、阈值、处理统计）和相似文本对的列表。
# """

# import json
# import jieba
# import numpy as np
# from sklearn.feature_extraction.text import TfidfVectorizer
# from sklearn.metrics.pairwise import cosine_similarity
# import logging
# from concurrent.futures import ThreadPoolExecutor
# import re
# from collections import defaultdict
# import time
# import os
# import torch
# from torch.nn.functional import cosine_similarity
# from tqdm import tqdm
# import concurrent.futures

# class TextSimilarityAnalyzer:
#     def __init__(self, input_file, threshold=0.7, device='cuda', batch_size=10000):
#         self.input_file = input_file
#         self.threshold = threshold
#         self.input_filename = os.path.splitext(os.path.basename(input_file))[0]
#         self.input_dir = os.path.dirname(input_file)
#         self.setup_logging()
#         self.device = device
#         self.batch_size = batch_size
#         # 移除 TfidfVectorizer，直接使用 PyTorch 实现

#     def setup_logging(self):
#         log_filename = os.path.join(self.input_dir, f"{self.input_filename}_similarity_analysis.log")
#         logging.basicConfig(
#             filename=log_filename,
#             level=logging.INFO,
#             format='%(asctime)s - %(message)s',
#             encoding='utf-8'
#         )

#     def preprocess_text(self, text):
#         """优化的文本预处理"""
#         text = re.sub(r'[^\w\s]', '', text)
#         words = list(jieba.cut(text))
#         return words

#     def build_vocab(self, texts):
#         """构建词表"""
#         word_freq = defaultdict(int)
#         total_words = 0
        
#         # 第一遍：统计词频
#         for text in tqdm(texts, desc="统计词频"):
#             words = self.preprocess_text(text)
#             total_words += len(words)
#             for word in words:
#                 word_freq[word] += 1
        
#         # 过滤低频词，减少维度
#         min_freq = max(2, total_words // (len(texts) * 1000))  # 动态设置最小频率
#         vocab = {}
#         idx = 0
#         for word, freq in word_freq.items():
#             if freq > min_freq:
#                 vocab[word] = idx
#                 idx += 1
        
#         print(f"总词数: {len(word_freq)}")
#         print(f"过滤后词表大小: {len(vocab)}")
#         print(f"最小词频阈值: {min_freq}")
        
#         return vocab

#     def texts_to_matrix(self, texts, vocab):
#         """将文本批量转换为矩阵"""
#         try:
#             matrix = torch.zeros((len(texts), len(vocab)), 
#                                dtype=torch.float32, 
#                                device=self.device)
            
#             # 使用 tqdm 显示进度
#             for i, text in enumerate(tqdm(texts, desc="转换文本为矩阵")):
#                 words = self.preprocess_text(text)
#                 total_words = len(words)
#                 if total_words == 0:
#                     continue
                    
#                 word_freq = defaultdict(int)
#                 for word in words:
#                     if word in vocab:  # 只统计在词表中的词
#                         word_freq[word] += 1
                
#                 # 计算 TF
#                 for word, freq in word_freq.items():
#                     vocab_idx = vocab.get(word)
#                     if vocab_idx is not None:  # 确保词在词表中
#                         tf = freq / total_words
#                         matrix[i, vocab_idx] = tf
            
#             # 归一化
#             normalized_matrix = torch.nn.functional.normalize(matrix, p=2, dim=1)
            
#             # 检查是否有 NaN 值
#             if torch.isnan(normalized_matrix).any():
#                 print("警告：矩阵中存在 NaN 值，将被替换为 0")
#                 normalized_matrix = torch.nan_to_num(normalized_matrix, 0.0)
                
#             return normalized_matrix
            
#         except Exception as e:
#             print(f"转换矩阵时出错: {str(e)}")
#             print(f"当前处理的文本索引: {i}")
#             print(f"词表大小: {len(vocab)}")
#             print(f"矩阵形状: {matrix.shape}")
#             raise e

#     def calculate_batch_similarity(self, matrix, start_idx, batch_size):
#         """计算一个批次的相似度，并显示进度"""
#         end_idx = min(start_idx + batch_size, matrix.size(0))
#         batch = matrix[start_idx:end_idx]
        
#         # 分块计算相似度，避免内存溢出
#         chunk_size = 1000  # 可以根据GPU内存调整
#         n_chunks = (matrix.size(0) + chunk_size - 1) // chunk_size
#         similarities = []
        
#         for i in tqdm(range(n_chunks), desc=f"计算批次 {start_idx}-{end_idx} 的相似度"):
#             chunk_start = i * chunk_size
#             chunk_end = min((i + 1) * chunk_size, matrix.size(0))
#             chunk = matrix[chunk_start:chunk_end]
            
#             # 计算当前块的相似度
#             sim_chunk = torch.mm(batch, chunk.t())
#             similarities.append(sim_chunk.cpu())
            
#             # 清理GPU内存
#             torch.cuda.empty_cache()
        
#         # 合并所有块的结果
#         return torch.cat(similarities, dim=1).to(self.device)

#     def analyze(self):
#         try:
#             start_time = time.time()
#             logging.info("开始分析...")
#             print("开始分析...")

#             # 验证输入文件
#             print("验证输入文件...")
#             with open(self.input_file, 'r', encoding='utf-8') as f:
#                 chunks = json.load(f)
                
#             # 只保留类型为 text 的文档
#             valid_chunks = [
#                 chunk for chunk in chunks 
#                 if ('id' in chunk and 
#                     'content' in chunk and 
#                     'type' in chunk and 
#                     chunk['type'] == 'text')
#             ]
            
#             total_chunks = len(chunks)
#             text_chunks = len(valid_chunks)
#             skipped_chunks = total_chunks - text_chunks
            
#             print(f"文档统计:")
#             print(f"- 总文档数: {total_chunks}")
#             print(f"- 文本类型文档数: {text_chunks}")
#             print(f"- 跳过的其他类型文档数: {skipped_chunks}")
            
#             if not valid_chunks:
#                 raise ValueError("没有找到有效的文本类型文档")

#             # 构建词表
#             print("\n构建词表...")
#             texts = [chunk['content'] for chunk in valid_chunks]
#             vocab = self.build_vocab(texts)
#             print(f"词表大小: {len(vocab)}")

#             # 转换为矩阵
#             print("\n转换文本为矩阵...")
#             text_matrix = self.texts_to_matrix(texts, vocab)
#             print(f"特征矩阵形状: {text_matrix.shape}")

#             # 收集相似对结果
#             similarity_results = {
#                 "metadata": {
#                     "file": self.input_file,
#                     "threshold": self.threshold,
#                     "total_chunks": total_chunks,
#                     "text_chunks": text_chunks,
#                     "skipped_chunks": skipped_chunks,
#                     "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
#                 },
#                 "similar_pairs": []
#             }

#             # 分批计算相似度
#             print("计算相似度矩阵...")
#             n = len(valid_chunks)
#             total_comparisons = n * (n - 1) // 2
#             processed_comparisons = 0
            
#             progress_bar = tqdm(total=total_comparisons, desc="总体进度")
            
#             for i in range(0, n, self.batch_size):
#                 batch_end = min(i + self.batch_size, n)
#                 print(f"\n处理批次 {i}-{batch_end} / {n}")
                
#                 # 计算当前批次的相似度
#                 batch_similarities = self.calculate_batch_similarity(
#                     text_matrix, i, self.batch_size)
                
#                 # 找出相似的文本对
#                 for idx1 in range(batch_end - i):
#                     global_idx1 = i + idx1
#                     similar_indices = torch.where(
#                         (batch_similarities[idx1, global_idx1+1:] >= self.threshold)
#                     )[0] + global_idx1 + 1
                    
#                     # 更新进度
#                     comparisons_in_this_step = n - global_idx1 - 1
#                     progress_bar.update(comparisons_in_this_step)
#                     processed_comparisons += comparisons_in_this_step
                    
#                     # 处理相似对
#                     for idx2 in similar_indices:
#                         chunk1 = valid_chunks[global_idx1]
#                         chunk2 = valid_chunks[idx2]
                        
#                         similarity_pair = {
#                             "chunk1": {
#                                 "id": chunk1['id'],
#                                 "content": chunk1['content']
#                             },
#                             "chunk2": {
#                                 "id": chunk2['id'],
#                                 "content": chunk2['content']
#                             },
#                             "similarity": float(batch_similarities[idx1, idx2].item())
#                         }
#                         similarity_results["similar_pairs"].append(similarity_pair)
                        
#                         # 定期输出发现的相似对数量
#                         if len(similarity_results["similar_pairs"]) % 100 == 0:
#                             print(f"\n已找到 {len(similarity_results['similar_pairs'])} 对相似文本")
                
#                 # 清理GPU内存
#                 torch.cuda.empty_cache()
                
#                 # 输出当前进度
#                 percentage = (processed_comparisons / total_comparisons) * 100
#                 print(f"\n总进度: {percentage:.2f}% ({processed_comparisons}/{total_comparisons})")
#                 print(f"当前内存使用: {torch.cuda.memory_allocated()/1024**3:.2f}GB")
            
#             progress_bar.close()
            
#             # 按相似度排序
#             similarity_results["similar_pairs"].sort(key=lambda x: x["similarity"], reverse=True)
            
#             # 保存结果到文件
#             output_file = os.path.join(self.input_dir, f"{self.input_filename}_similarity_results.json")
#             with open(output_file, 'w', encoding='utf-8') as f:
#                 json.dump(similarity_results, f, ensure_ascii=False, indent=2)
            
#             print(f"\n分析完成，结果已保存到: {output_file}")
#             print(f"共找到 {len(similarity_results['similar_pairs'])} 对相似文本")
            
#             return similarity_results

#         except Exception as e:
#             logging.error(f"分析过程出错: {str(e)}")
#             raise e

# if __name__ == "__main__":
#     import argparse
#     import concurrent.futures
#     from concurrent.futures import ThreadPoolExecutor
#     from pathlib import Path
    
#     def process_file(file_path, threshold):
#         """处理单个文件的函数"""
#         print(f"\n开始处理文件: {file_path}")
#         try:
#             analyzer = TextSimilarityAnalyzer(str(file_path), threshold=threshold)
#             results = analyzer.analyze()
#             print(f"文件 {file_path} 处理完成")
#             return file_path, len(results)
#         except Exception as e:
#             print(f"处理文件 {file_path} 时发生错误: {e}")
#             return file_path, -1

#     # 设置命令行参数
#     parser = argparse.ArgumentParser(description='文本相似度分析工具')
#     parser.add_argument('input_files', nargs='+', help='输入的JSON文件路径，支持多个文件')
#     parser.add_argument('--threshold', type=float, default=1, help='相似度阈值 (0-1 之间，默认: 0.9)')
#     parser.add_argument('--max_workers', type=int, default=4, help='最大线程数 (默认: 4)')
#     args = parser.parse_args()

#     # 验证输入参数
#     if not (0 < args.threshold <= 1):
#         print("错误：阈值必须在0到1之间")
#         exit(1)

#     # 验证文件路径
#     input_files = []
#     for file_pattern in args.input_files:
#         # 将字符串路径转换为Path对象
#         pattern_path = Path(file_pattern)
#         if pattern_path.is_file():
#             # 如果是具体文件，直接添加
#             if pattern_path.suffix == '.json':
#                 input_files.append(pattern_path)
#         else:
#             # 如果是模式，使用父目录进行glob
#             parent = pattern_path.parent
#             pattern = pattern_path.name
#             matches = list(parent.glob(pattern))
#             input_files.extend([p for p in matches if p.is_file() and p.suffix == '.json'])

#     if not input_files:
#         print("错误：未找到有效的JSON文件")
#         exit(1)

#     print(f"找到 {len(input_files)} 个JSON文件待处理")
#     print(f"使用阈值: {args.threshold}")
#     print(f"最大线程数: {args.max_workers}")

#     # 使用线程池并行处理文件
#     with ThreadPoolExecutor(max_workers=args.max_workers) as executor:
#         # 提交所有任务
#         future_to_file = {
#             executor.submit(process_file, str(file_path), args.threshold): file_path
#             for file_path in input_files
#         }

#         # 收集结果
#         results_summary = []
#         for future in concurrent.futures.as_completed(future_to_file):
#             file_path = future_to_file[future]
#             try:
#                 file_path, num_pairs = future.result()
#                 results_summary.append({
#                     'file': str(file_path),
#                     'status': 'success' if num_pairs >= 0 else 'error',
#                     'similar_pairs': num_pairs if num_pairs >= 0 else None
#                 })
#             except Exception as e:
#                 print(f"处理文件 {file_path} 时发生异常: {e}")
#                 results_summary.append({
#                     'file': str(file_path),
#                     'status': 'error',
#                     'similar_pairs': None
#                 })

#     # 打印最终汇总
#     print("\n=== 处理结果汇总 ===")
#     for result in results_summary:
#         status_str = "成功" if result['status'] == 'success' else "失败"
#         pairs_str = f"发现 {result['similar_pairs']} 对相似文本" if result['similar_pairs'] is not None else "处理失败"
#         print(f"文件: {result['file']}")
#         print(f"状态: {status_str}")
#         print(f"结果: {pairs_str}")
#         print("-" * 40)

#!/usr/bin/env python
# -*- coding: utf-8 -*-
# """
# English‑text similarity detector (GPU‑ready, TF‑IDF + cosine)

# Run example:
#     python similarity.py data/*.json --threshold 0.8 --max_workers 8
# JSON schema (each file):
# [
#   {"id": "...", "type": "text", "content": "First sentence."},
#   ...
# ]
# """

# import argparse
# import concurrent.futures
# import json
# import logging
# import os
# import re
# import time
# from pathlib import Path
# from typing import List

# import nltk
# import numpy as np
# import torch
# from sklearn.feature_extraction.text import TfidfVectorizer
# from tqdm import tqdm


# # ─────────────────────────────────── helpers ──────────────────────────────────
# def nltk_prepare() -> None:
#     """Download punkt & stopwords on first run (silent if already present)."""
#     for pkg in ("punkt", "stopwords"):
#         try:
#             nltk.data.find(f"tokenizers/{pkg}")
#         except LookupError:
#             nltk.download(pkg, quiet=True)


# def tokenize_en(text: str, stopwords_set) -> List[str]:
#     """Lower‑case → strip non‑letters → word tokenise → remove stop words."""
#     text = re.sub(r"[^A-Za-z\s]", " ", text).lower()
#     tokens = nltk.word_tokenize(text)
#     return [tok for tok in tokens if tok and tok not in stopwords_set]


# # ────────────────────────────── Similarity class ─────────────────────────────
# class TextSimilarityAnalyzer:
#     def __init__(
#         self,
#         input_file: str,
#         threshold: float = 0.75,
#         device: str = "cuda",
#         batch_size: int = 10_000,
#         min_df: int | float = 2,
#         max_df: float = 0.8,
#     ):
#         self.input_file = input_file
#         self.threshold = threshold
#         self.input_filename = Path(input_file).stem
#         self.input_dir = Path(input_file).parent.as_posix()
#         self.device = torch.device(device if torch.cuda.is_available() else "cpu")
#         self.batch_size = batch_size
#         self.min_df = min_df
#         self.max_df = max_df
#         self._setup_logging()
#         nltk_prepare()
#         self.stop = set(nltk.corpus.stopwords.words("english"))

#     # ───────────────────────────── internal utils ────────────────────────────
#     def _setup_logging(self) -> None:
#         log_path = Path(self.input_dir) / f"{self.input_filename}_similarity.log"
#         logging.basicConfig(
#             filename=log_path,
#             level=logging.INFO,
#             format="%(asctime)s - %(message)s",
#             encoding="utf-8",
#         )

#     # ───────────────────────────── core pipeline ─────────────────────────────
#     def _load_valid_chunks(self):
#         with open(self.input_file, encoding="utf-8") as f:
#             chunks = json.load(f)

#         valid = [
#             c for c in chunks if c.get("type") == "text" and "content" in c and "id" in c
#         ]
#         stats = {
#             "total": len(chunks),
#             "text": len(valid),
#             "skipped": len(chunks) - len(valid),
#         }
#         return valid, stats

#     def _texts_to_tfidf(self, docs: List[str]) -> torch.Tensor:
#         """
#         Pre‑tokenise, then feed token strings ("w1 w2 ...") into sklearn TF‑IDF.
#         Returns L2‑normalised dense FloatTensor on self.device.
#         """
#         token_strs = []
#         for txt in tqdm(docs, desc="Tokenising"):
#             tokens = tokenize_en(txt, self.stop)
#             token_strs.append(" ".join(tokens))

#         vectorizer = TfidfVectorizer(
#             analyzer="word",
#             tokenizer=str.split,      # identity on the space‑joined string
#             preprocessor=None,
#             lowercase=False,
#             min_df=self.min_df,
#             max_df=self.max_df,
#             ngram_range=(1, 1),
#             dtype=np.float32,
#         )

#         tfidf_csr = vectorizer.fit_transform(token_strs)  # (n_docs, |V|)
#         tfidf_dense = torch.tensor(
#             tfidf_csr.toarray(), dtype=torch.float32, device=self.device
#         )
#         return torch.nn.functional.normalize(tfidf_dense, p=2, dim=1)

#     def _cosine_blocks(
#         self, matrix: torch.Tensor, start: int, end: int, chunk: int = 2000
#     ) -> torch.Tensor:
#         """
#         Compute cosine sims between docs[start:end] and all docs, in chunks to
#         keep GPU memory in check. Returns (end-start, n_docs) tensor on device.
#         """
#         tgt = matrix[start:end]  # (b, d)
#         n_docs = matrix.size(0)
#         sims = []

#         n_chunks = (n_docs + chunk - 1) // chunk
#         for i in range(n_chunks):
#             c0, c1 = i * chunk, min((i + 1) * chunk, n_docs)
#             sims.append(torch.mm(tgt, matrix[c0:c1].T))
#             torch.cuda.empty_cache()

#         return torch.cat(sims, dim=1)

#     def analyze(self) -> dict:
#         logging.info("Start analysis")
#         print(f"\n=== Analyzing {self.input_file} ===")

#         valid_chunks, stats = self._load_valid_chunks()
#         if not valid_chunks:
#             raise RuntimeError("No valid text chunks found.")

#         docs = [c["content"] for c in valid_chunks]
#         tfidf = self._texts_to_tfidf(docs)
#         n = tfidf.shape[0]
#         total_pairs = n * (n - 1) // 2

#         result = {
#             "metadata": {
#                 **stats,
#                 "file": self.input_file,
#                 "threshold": self.threshold,
#                 "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
#             },
#             "similar_pairs": [],
#         }

#         processed = 0
#         pbar = tqdm(total=total_pairs, desc="Overall progress")
#         for i in range(0, n, self.batch_size):
#             j = min(i + self.batch_size, n)
#             sims = self._cosine_blocks(tfidf, i, j)
#             for local_idx in range(j - i):
#                 global_idx1 = i + local_idx
#                 # only look at upper triangle
#                 mask = sims[local_idx, global_idx1 + 1 :] >= self.threshold
#                 idx2s = torch.where(mask)[0] + global_idx1 + 1
#                 for idx2 in idx2s.tolist():
#                     result["similar_pairs"].append(
#                         {
#                             "chunk1": {
#                                 "id": valid_chunks[global_idx1]["id"],
#                                 "content": docs[global_idx1],
#                             },
#                             "chunk2": {
#                                 "id": valid_chunks[idx2]["id"],
#                                 "content": docs[idx2],
#                             },
#                             "similarity": float(sims[local_idx, idx2]),
#                         }
#                     )
#             processed += (n - i) * (j - i) - (j - i) * (j - i + 1) // 2
#             pbar.update((n - i) * (j - i) - (j - i) * (j - i + 1) // 2)
#         pbar.close()

#         result["similar_pairs"].sort(key=lambda x: x["similarity"], reverse=True)

#         out_path = Path(self.input_dir) / f"{self.input_filename}_similarity.json"
#         with open(out_path, "w", encoding="utf-8") as f:
#             json.dump(result, f, ensure_ascii=False, indent=2)

#         print(f"Finished. {len(result['similar_pairs'])} pairs ≥ {self.threshold}.")
#         print(f"Saved to {out_path}")
#         return result


# # ──────────────────────────────── CLI driver ────────────────────────────────
# def _process_single(file_path: Path, threshold: float) -> tuple[str, int]:
#     try:
#         analyzer = TextSimilarityAnalyzer(str(file_path), threshold=threshold)
#         res = analyzer.analyze()
#         return str(file_path), len(res["similar_pairs"])
#     except Exception as exc:
#         print(f"[ERROR] {file_path}: {exc}")
#         return str(file_path), -1


# def main() -> None:
#     parser = argparse.ArgumentParser("English text similarity (TF‑IDF)")
#     parser.add_argument("input_files", nargs="+", help="JSON files or glob pattern")
#     parser.add_argument("--threshold", type=float, default=0.75, help="Cosine cut‑off")
#     parser.add_argument("--max_workers", type=int, default=4, help="Thread pool size")
#     args = parser.parse_args()

#     if not 0.0 < args.threshold < 1.0:
#         raise SystemExit("Threshold must be in (0,1).")

#     # Expand globs
#     files: list[Path] = []
#     for patt in args.input_files:
#         p = Path(patt)
#         if p.is_file():
#             files.append(p)
#         else:  # glob pattern
#             files.extend(sorted(Path().glob(patt)))
#     files = [f for f in files if f.suffix == ".json"]
#     if not files:
#         raise SystemExit("No JSON files found.")

#     print(f"Found {len(files)} file(s).  Threshold = {args.threshold}")
#     summary = []
#     with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as pool:
#         fut2file = {pool.submit(_process_single, f, args.threshold): f for f in files}
#         for fut in concurrent.futures.as_completed(fut2file):
#             fp, n_pairs = fut.result()
#             summary.append((fp, n_pairs))

#     # Final report
#     print("\n=== Summary ===")
#     for fp, n_pairs in summary:
#         if n_pairs >= 0:
#             print(f"[OK]  {fp} → {n_pairs} similar pairs")
#         else:
#             print(f"[FAIL] {fp}")


# if __name__ == "__main__":
#     main()
 

"""
English‑text similarity detector (offline‑safe: regex tokenizer fallback)

Usage example
-------------
python similarity.py data/*.json --threshold 0.8 --max_workers 8
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import List

import numpy as np
import torch
from sklearn.feature_extraction.text import TfidfVectorizer
from tqdm import tqdm

# ────────────────────── optional NLTK (auto‑fallback) ───────────────────────

nltk = None

_USE_NLTK_TOKENIZER = False
_STOPWORDS: set[str]


def _init_nltk() -> None:
    """Try to ensure punkt & stopwords; fall back gracefully if offline."""
    global _USE_NLTK_TOKENIZER, _STOPWORDS

    # default fallback stopwords (short list)
    _STOPWORDS = {
        "the",
        "and",
        "a",
        "an",
        "of",
        "to",
        "in",
        "is",
        "it",
        "that",
        "this",
        "for",
        "on",
        "with",
        "as",
        "by",
        "at",
        "from",
        "be",
        "are",
        "was",
        "were",
    }

    if nltk is None:
        return  # no nltk; keep regex + fallback stopwords

    try:
        _nltk_find("tokenizers/punkt")
        _USE_NLTK_TOKENIZER = True
    except LookupError:
        try:
            nltk.download("punkt", quiet=True, raise_on_error=True)
            _USE_NLTK_TOKENIZER = True
        except Exception:
            _USE_NLTK_TOKENIZER = False

    try:
        _nltk_find("corpora/stopwords")
        _STOPWORDS = set(_nltk_stopwords.words("english"))
    except LookupError:
        try:
            nltk.download("stopwords", quiet=True, raise_on_error=True)
            _STOPWORDS = set(_nltk_stopwords.words("english"))
        except Exception:
            pass  # keep fallback list


def _tokenize_en(text: str) -> List[str]:
    """
    - Lower‑case, strip non‑letters.
    - Use nltk.word_tokenize if available; else regex `[a-z]+`.
    - Remove stop words.
    """
    text = re.sub(r"[^A-Za-z\s]", " ", text).lower()
    if _USE_NLTK_TOKENIZER:
        tokens = nltk.word_tokenize(text)  # type: ignore[attr-defined]
    else:
        tokens = re.findall(r"[a-z]+", text)
    return [tok for tok in tokens if tok and tok not in _STOPWORDS]


# ────────────────────────── similarity analyzer ─────────────────────────────
class TextSimilarityAnalyzer:
    def __init__(
        self,
        input_file: str,
        threshold: float = 0.75,
        device: str = "cuda",
        batch_size: int = 10_000,
        min_df: int | float = 2,
        max_df: float = 0.8,
    ):
        self.input_file = input_file
        self.threshold = threshold
        self.input_filename = Path(input_file).stem
        self.input_dir = Path(input_file).parent.as_posix()
        self.device = torch.device(device if torch.cuda.is_available() else "cpu")
        self.batch_size = batch_size
        self.min_df = min_df
        self.max_df = max_df
        self._setup_logging()

    # ───────────────────────────── logging ──────────────────────────────
    def _setup_logging(self) -> None:
        log_path = Path(self.input_dir) / f"{self.input_filename}_similarity.log"
        logging.basicConfig(
            filename=log_path,
            level=logging.INFO,
            format="%(asctime)s - %(message)s",
            encoding="utf-8",
        )

    # ──────────────────────── loading & preprocessing ───────────────────
    def _load_valid_chunks(self):
        with open(self.input_file, encoding="utf-8") as f:
            chunks = json.load(f)

        valid = [
            c
            for c in chunks
            if c.get("type") == "text" and "content" in c and "id" in c
        ]
        stats = {
            "total": len(chunks),
            "text": len(valid),
            "skipped": len(chunks) - len(valid),
        }
        return valid, stats

    def _texts_to_tfidf(self, docs: List[str]) -> torch.Tensor:
        """
        Pre‑tokenise, then feed space‑joined tokens into sklearn TF‑IDF.
        Returns L2‑normalised dense FloatTensor on self.device.
        """
        token_strs = []
        for txt in tqdm(docs, desc="Tokenising"):
            token_strs.append(" ".join(_tokenize_en(txt)))

        vectorizer = TfidfVectorizer(
            analyzer="word",
            tokenizer=str.split,  # identity on space‑joined string
            preprocessor=None,
            lowercase=False,
            min_df=self.min_df,
            max_df=self.max_df,
            ngram_range=(1, 1),
            dtype=np.float32,
        )
        tfidf_csr = vectorizer.fit_transform(token_strs)
        tfidf_dense = torch.tensor(
            tfidf_csr.toarray(), dtype=torch.float32, device=self.device
        )
        return torch.nn.functional.normalize(tfidf_dense, p=2, dim=1)

    def _cosine_blocks(
        self, matrix: torch.Tensor, start: int, end: int, chunk: int = 2000
    ) -> torch.Tensor:
        tgt = matrix[start:end]
        n_docs = matrix.size(0)
        sims = []
        n_chunks = (n_docs + chunk - 1) // chunk
        for i in range(n_chunks):
            c0, c1 = i * chunk, min((i + 1) * chunk, n_docs)
            sims.append(torch.mm(tgt, matrix[c0:c1].T))
            torch.cuda.empty_cache()
        return torch.cat(sims, dim=1)

    def analyze(self) -> dict:
        logging.info("Start analysis")
        print(f"\n=== Analyzing {self.input_file} ===")

        valid_chunks, stats = self._load_valid_chunks()
        if not valid_chunks:
            raise RuntimeError("No valid text chunks found.")

        docs = [c["content"] for c in valid_chunks]
        tfidf = self._texts_to_tfidf(docs)
        n = tfidf.shape[0]
        total_pairs = n * (n - 1) // 2

        result = {
            "metadata": {
                **stats,
                "file": self.input_file,
                "threshold": self.threshold,
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            },
            "similar_pairs": [],
        }

        pbar = tqdm(total=total_pairs, desc="Overall progress")
        for i in range(0, n, self.batch_size):
            j = min(i + self.batch_size, n)
            sims = self._cosine_blocks(tfidf, i, j)
            for local_idx in range(j - i):
                g1 = i + local_idx
                mask = sims[local_idx, g1 + 1 :] >= self.threshold
                idx2s = torch.where(mask)[0] + g1 + 1
                for g2 in idx2s.tolist():
                    result["similar_pairs"].append(
                        {
                            "chunk1": {
                                "id": valid_chunks[g1]["id"],
                                "content": docs[g1],
                            },
                            "chunk2": {
                                "id": valid_chunks[g2]["id"],
                                "content": docs[g2],
                            },
                            "similarity": float(sims[local_idx, g2]),
                        }
                    )
            # update progress
            done = (n - i) * (j - i) - (j - i) * (j - i + 1) // 2
            pbar.update(done)
        pbar.close()

        result["similar_pairs"].sort(key=lambda x: x["similarity"], reverse=True)

        out_path = Path(self.input_dir) / f"{self.input_filename}_similarity_results.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        print(f"Finished. {len(result['similar_pairs'])} pairs ≥ {self.threshold}.")
        print(f"Saved to {out_path}")
        return result


# ──────────────────────────── CLI convenience ───────────────────────────────
def _process_single(file_path: Path, threshold: float) -> tuple[str, int]:
    try:
        analyzer = TextSimilarityAnalyzer(str(file_path), threshold=threshold)
        res = analyzer.analyze()
        return str(file_path), len(res["similar_pairs"])
    except Exception as exc:
        print(f"[ERROR] {file_path}: {exc}")
        return str(file_path), -1


def main() -> None:
    _init_nltk()  # prepare tokenizer / stopwords

    parser = argparse.ArgumentParser("English text similarity (offline‑safe)")
    parser.add_argument("input_files", nargs="+", help="JSON files or glob pattern")
    parser.add_argument("--threshold", type=float, default=0.75, help="Cosine cut‑off")
    parser.add_argument("--max_workers", type=int, default=4, help="Thread pool size")
    args = parser.parse_args()

    if not 0.0 < args.threshold < 1.0:
        raise SystemExit("Threshold must be in (0,1).")

    # Expand globs
    files: list[Path] = []
    for patt in args.input_files:
        p = Path(patt)
        if p.is_file():
            files.append(p)
        else:
            files.extend(sorted(Path().glob(patt)))
    files = [f for f in files if f.suffix == ".json"]
    if not files:
        raise SystemExit("No JSON files found.")

    print(f"Found {len(files)} file(s). Threshold = {args.threshold}")
    summary = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as pool:
        fut2file = {pool.submit(_process_single, f, args.threshold): f for f in files}
        for fut in concurrent.futures.as_completed(fut2file):
            fp, n_pairs = fut.result()
            summary.append((fp, n_pairs))

    # Final report
    print("\n=== Summary ===")
    for fp, n_pairs in summary:
        if n_pairs >= 0:
            print(f"[OK]   {fp} → {n_pairs} similar pairs")
        else:
            print(f"[FAIL] {fp}")


if __name__ == "__main__":
    main()
