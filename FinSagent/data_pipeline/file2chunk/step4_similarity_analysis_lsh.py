"""
近重复文本检测（MinHash + Banded LSH + Jaccard / TF-IDF 精排）

本脚本是 ``step4_similarity_analysis.py`` 的 LSH 替代实现，专门面向 SEC 财报这种
**boilerplate 重复极多、规模可达数十万 chunk** 的场景。相对原版全量 TF-IDF +
O(N²) 余弦的方案：

* 不再做 dense GPU 矩阵，CPU 即可处理百万级 chunk。
* 候选对生成复杂度近似 O(N)（banded LSH）。
* 精排阶段对候选对真实计算 Jaccard 与/或 TF-IDF cosine，避免 LSH 误召回。
* 输出格式与 step4 保持兼容：``{"metadata": {...}, "similar_pairs": [...]}``，
  可直接被 ``step5_delete_similar_chunks.py``（Union-Find 版）消费。

设计要点（针对 SEC 财报）
----------------------------
1. **Word 5-gram shingles**：对短数字改动敏感，更能区分不同季度的 MD&A。
2. **可选数字归一化签名**：把 ``$1,234.5`` / ``2024`` / ``12.3%`` 替换成占位
   符。可用于后续判别"模板未变 + 数字更新"——本脚本默认只跑原文签名，但保留
   ``--normalize-numbers`` 开关以便消融实验。
3. **短 chunk 旁路**：``--min-tokens`` 以下的 chunk 不进 LSH，单独走精确字符
   串去重（直接构造 pair）。
4. **精排可选**：``--rerank {none, jaccard, tfidf, both}``，默认 ``both``。
   - ``jaccard``：在 shingle 集合上重新算精确 Jaccard。
   - ``tfidf``：对候选对临时构建 TF-IDF（仅候选涉及的 chunk）做余弦。

CLI
---
python step4_similarity_analysis_lsh.py input.json [input2.json ...] \
    [--threshold 0.85] [--num-perm 128] [--shingle-size 5] \
    [--min-tokens 30] [--rerank both] [--normalize-numbers] \
    [--max-workers 4]

输出
----
对每个输入 ``X.json`` 生成 ``X_similarity_results.json``，结构为：

```
{
  "metadata": { "file": ..., "threshold": 0.85, "method": "minhash_lsh+rerank",
                "params": {...}, "stats": {...} },
  "similar_pairs": [
      {"chunk1": {"id":..., "content":...},
       "chunk2": {"id":..., "content":...},
       "similarity": 0.93,
       "jaccard":  0.91,
       "tfidf":    0.95}
      ...
  ]
}
```
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
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from tqdm import tqdm


# ---------------------------------------------------------------------------
# Tokenisation & shingling
# ---------------------------------------------------------------------------
_NUM_RE = re.compile(r"\d[\d,]*\.?\d*")
_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
_PCT_RE = re.compile(r"\d+(?:\.\d+)?\s*%")
# Keep digit-bearing tokens (e.g. "2024", "150"); these matter for SEC dedup
# because period-over-period updates differ mainly in numbers.
_WORD_RE = re.compile(r"[a-z0-9]+")

# Minimal English stopword list to keep the script self-contained / offline-safe.
_STOPWORDS: Set[str] = {
    "the", "and", "a", "an", "of", "to", "in", "is", "it", "that", "this",
    "for", "on", "with", "as", "by", "at", "from", "be", "are", "was", "were",
    "or", "we", "our", "its", "their", "have", "has", "had", "but", "not",
    "which", "such", "these", "those",
}


def normalize_text(text: str, normalize_numbers: bool = False) -> str:
    """Lower-case + optional number/year/% normalisation."""
    if normalize_numbers:
        # order matters: percentages before bare numbers
        text = _PCT_RE.sub(" <PCT> ", text)
        text = _YEAR_RE.sub(" <YEAR> ", text)
        text = _NUM_RE.sub(" <NUM> ", text)
    return text.lower()


def tokenize(text: str, normalize_numbers: bool = False) -> List[str]:
    """
    Tokenise to lowercase alphanumeric words.
    - Default: keeps numeric tokens (``2024``, ``150``); SEC period-over-period
      updates differ mainly in numbers, so dropping them would falsely merge
      different quarters.
    - With ``normalize_numbers=True``: numbers/years/percentages are collapsed
      to ``<num>``/``<year>``/``<pct>`` placeholders for ablation studies.
    """
    text = normalize_text(text, normalize_numbers=normalize_numbers)
    if normalize_numbers:
        toks = re.findall(r"<[a-z]+>|[a-z]+", text)
    else:
        toks = _WORD_RE.findall(text)
    return [t for t in toks if t and t not in _STOPWORDS]


def shingles(tokens: Sequence[str], k: int) -> Set[str]:
    """Return the set of word k-grams. Falls back to single tokens for short docs."""
    if len(tokens) < k:
        return set(tokens)
    return {" ".join(tokens[i : i + k]) for i in range(len(tokens) - k + 1)}


# ---------------------------------------------------------------------------
# MinHash (numpy implementation, no external deps)
# ---------------------------------------------------------------------------
_MERSENNE_PRIME = (1 << 61) - 1
_MAX_HASH = (1 << 32) - 1


class MinHasher:
    """
    Universal-hashing MinHash:
        h_i(x) = ((a_i * x + b_i) mod p) mod 2^32
    where x is a 64-bit hash of the shingle.
    """

    def __init__(self, num_perm: int = 128, seed: int = 1):
        rng = np.random.default_rng(seed)
        self.num_perm = num_perm
        # a must be non-zero
        self.a = rng.integers(1, _MERSENNE_PRIME, size=num_perm, dtype=np.uint64)
        self.b = rng.integers(0, _MERSENNE_PRIME, size=num_perm, dtype=np.uint64)

    def signature(self, items: Iterable[str]) -> np.ndarray:
        """Return a uint32 vector of length num_perm. Empty set -> all _MAX_HASH."""
        # Hash shingle strings to 64-bit ints (Python's hash is fine for in-process LSH;
        # use a stable hash if you need cross-process determinism).
        x = np.fromiter(
            (hash(s) & 0xFFFFFFFFFFFFFFFF for s in items),
            dtype=np.uint64,
        )
        if x.size == 0:
            return np.full(self.num_perm, _MAX_HASH, dtype=np.uint32)
        # broadcast: (num_perm, n)
        h = (np.outer(self.a, x) + self.b[:, None]) % _MERSENNE_PRIME
        h &= _MAX_HASH
        return h.min(axis=1).astype(np.uint32)


# ---------------------------------------------------------------------------
# Banded LSH
# ---------------------------------------------------------------------------
class BandedLSH:
    """
    Standard b-bands × r-rows MinHash LSH. For threshold t and num_perm n,
    pick (b, r) such that b*r == n and (1/b)^(1/r) ≈ t.
    """

    def __init__(self, num_perm: int, threshold: float):
        self.num_perm = num_perm
        self.threshold = threshold
        self.b, self.r = self._optimal_bands(num_perm, threshold)
        self.buckets: List[Dict[bytes, List[int]]] = [
            {} for _ in range(self.b)
        ]

    @staticmethod
    def _optimal_bands(num_perm: int, threshold: float) -> Tuple[int, int]:
        """Pick (b, r) minimising weighted FP+FN around threshold."""
        best = None
        for b in range(1, num_perm + 1):
            if num_perm % b != 0:
                continue
            r = num_perm // b
            # probability of being a candidate at similarity t
            p = 1.0 - (1.0 - threshold ** r) ** b
            # we want p ~ 0.5..0.8 at threshold; minimise |p - 0.7|
            score = abs(p - 0.7)
            if best is None or score < best[0]:
                best = (score, b, r)
        assert best is not None
        return best[1], best[2]

    def insert(self, idx: int, sig: np.ndarray) -> None:
        # split signature into b bands of r rows each
        for band_id in range(self.b):
            band = sig[band_id * self.r : (band_id + 1) * self.r].tobytes()
            self.buckets[band_id].setdefault(band, []).append(idx)

    def candidate_pairs(self) -> Set[Tuple[int, int]]:
        """All unordered (i, j) with i<j sharing at least one band bucket."""
        pairs: Set[Tuple[int, int]] = set()
        for band in self.buckets:
            for ids in band.values():
                if len(ids) < 2:
                    continue
                ids_sorted = sorted(ids)
                # Within-bucket pairs are O(k^2); financial boilerplate buckets
                # are usually small but can spike. Cap to keep things sane.
                if len(ids_sorted) > 500:
                    # very common boilerplate: still compare them all but warn
                    logging.warning(
                        "LSH bucket has %d members; pair count = %d",
                        len(ids_sorted),
                        len(ids_sorted) * (len(ids_sorted) - 1) // 2,
                    )
                for i in range(len(ids_sorted)):
                    for j in range(i + 1, len(ids_sorted)):
                        pairs.add((ids_sorted[i], ids_sorted[j]))
        return pairs


# ---------------------------------------------------------------------------
# Analyzer
# ---------------------------------------------------------------------------
class LSHSimilarityAnalyzer:
    def __init__(
        self,
        input_file: str,
        threshold: float = 0.85,
        num_perm: int = 128,
        shingle_size: int = 5,
        min_tokens: int = 30,
        rerank: str = "both",  # none | jaccard | tfidf | both
        normalize_numbers: bool = False,
        seed: int = 1,
    ):
        assert rerank in {"none", "jaccard", "tfidf", "both"}
        self.input_file = input_file
        self.threshold = threshold
        self.num_perm = num_perm
        self.shingle_size = shingle_size
        self.min_tokens = min_tokens
        self.rerank = rerank
        self.normalize_numbers = normalize_numbers
        self.seed = seed

        self.input_filename = Path(input_file).stem
        self.input_dir = Path(input_file).parent
        self._setup_logging()

    def _setup_logging(self) -> None:
        log_path = self.input_dir / f"{self.input_filename}_similarity_lsh.log"
        # Use a per-instance handler so multi-thread runs don't clobber each other.
        self.logger = logging.getLogger(f"lsh.{self.input_filename}")
        self.logger.setLevel(logging.INFO)
        if not self.logger.handlers:
            fh = logging.FileHandler(log_path, encoding="utf-8")
            fh.setFormatter(
                logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
            )
            self.logger.addHandler(fh)

    # ------------------------------------------------------------------ I/O
    def _load_valid_chunks(self) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
        with open(self.input_file, encoding="utf-8") as f:
            chunks = json.load(f)
        valid = [
            c for c in chunks
            if c.get("type") == "text" and "content" in c and "id" in c
        ]
        stats = {
            "total": len(chunks),
            "text": len(valid),
            "skipped": len(chunks) - len(valid),
        }
        return valid, stats

    # ------------------------------------------------------------ pipeline
    def analyze(self) -> Dict[str, Any]:
        t0 = time.time()
        self.logger.info("Start LSH analysis on %s", self.input_file)
        print(f"\n=== Analyzing (LSH) {self.input_file} ===")

        valid_chunks, stats = self._load_valid_chunks()
        if not valid_chunks:
            raise RuntimeError("No valid text chunks found.")

        n = len(valid_chunks)
        docs = [c["content"] or "" for c in valid_chunks]

        # ---- 1. tokenise + shingle ----
        token_lists: List[List[str]] = []
        shingle_sets: List[Set[str]] = []
        short_idx: List[int] = []
        for i, txt in enumerate(tqdm(docs, desc="Tokenise+shingle")):
            toks = tokenize(txt, normalize_numbers=self.normalize_numbers)
            token_lists.append(toks)
            if len(toks) < self.min_tokens:
                short_idx.append(i)
                shingle_sets.append(set(toks))  # still kept for jaccard rerank
            else:
                shingle_sets.append(shingles(toks, self.shingle_size))

        # ---- 2. MinHash + LSH for long docs ----
        hasher = MinHasher(num_perm=self.num_perm, seed=self.seed)
        lsh = BandedLSH(num_perm=self.num_perm, threshold=self.threshold)
        short_set = set(short_idx)
        long_indices = [i for i in range(n) if i not in short_set]
        for i in tqdm(long_indices, desc="MinHash+LSH"):
            sig = hasher.signature(shingle_sets[i])
            lsh.insert(i, sig)

        candidates: Set[Tuple[int, int]] = lsh.candidate_pairs()

        # ---- 3. exact dedup for short chunks (group by token-tuple) ----
        short_groups: Dict[Tuple[str, ...], List[int]] = {}
        for i in short_idx:
            key = tuple(token_lists[i])
            if not key:
                continue  # skip empty content
            short_groups.setdefault(key, []).append(i)
        for ids in short_groups.values():
            if len(ids) < 2:
                continue
            for a in range(len(ids)):
                for b in range(a + 1, len(ids)):
                    candidates.add((ids[a], ids[b]))

        self.logger.info(
            "n=%d, long=%d, short=%d, lsh_bands=(%d,%d), candidates=%d",
            n, len(long_indices), len(short_idx), lsh.b, lsh.r, len(candidates),
        )
        print(f"LSH bands=(b={lsh.b}, r={lsh.r}); candidates: {len(candidates)}")

        # ---- 4. rerank ----
        similar_pairs: List[Dict[str, Any]] = []
        if not candidates:
            return self._save_result(valid_chunks, similar_pairs, stats, lsh, t0)

        # tfidf rerank: build a vectorizer over the whole corpus once (cheap)
        tfidf_mat = None
        if self.rerank in {"tfidf", "both"}:
            joined = [" ".join(token_lists[i]) for i in range(n)]
            vec = TfidfVectorizer(
                analyzer="word",
                tokenizer=str.split,
                preprocessor=None,
                lowercase=False,
                min_df=1,
                max_df=1.0,
                ngram_range=(1, 1),
                dtype=np.float32,
            )
            try:
                tfidf_mat = vec.fit_transform(joined)
            except ValueError:
                # all-empty corpus
                tfidf_mat = None

        for i, j in tqdm(sorted(candidates), desc="Rerank"):
            jacc = None
            tfidf_sim = None
            keep = True

            if self.rerank in {"jaccard", "both"}:
                a, b = shingle_sets[i], shingle_sets[j]
                if not a and not b:
                    jacc = 1.0
                elif not a or not b:
                    jacc = 0.0
                else:
                    inter = len(a & b)
                    union = len(a | b)
                    jacc = inter / union if union else 0.0
                if jacc < self.threshold:
                    keep = False

            if keep and self.rerank in {"tfidf", "both"} and tfidf_mat is not None:
                sim = cosine_similarity(tfidf_mat[i], tfidf_mat[j])[0, 0]
                tfidf_sim = float(sim)
                # for "both", require BOTH to clear threshold (more conservative,
                # safer for SEC: avoids deleting period-over-period updates).
                if self.rerank == "both":
                    if tfidf_sim < self.threshold:
                        keep = False
                elif self.rerank == "tfidf":
                    if tfidf_sim < self.threshold:
                        keep = False

            if not keep:
                continue

            # Use the strictest available signal as the headline similarity.
            sims_all = [s for s in (jacc, tfidf_sim) if s is not None]
            headline = min(sims_all) if sims_all else 1.0

            similar_pairs.append({
                "chunk1": {
                    "id": valid_chunks[i]["id"],
                    "content": docs[i],
                },
                "chunk2": {
                    "id": valid_chunks[j]["id"],
                    "content": docs[j],
                },
                "similarity": float(headline),
                "jaccard": float(jacc) if jacc is not None else None,
                "tfidf": float(tfidf_sim) if tfidf_sim is not None else None,
            })

        similar_pairs.sort(key=lambda p: p["similarity"], reverse=True)
        return self._save_result(valid_chunks, similar_pairs, stats, lsh, t0)

    # --------------------------------------------------------------- output
    def _save_result(
        self,
        valid_chunks: List[Dict[str, Any]],
        similar_pairs: List[Dict[str, Any]],
        stats: Dict[str, int],
        lsh: BandedLSH,
        t0: float,
    ) -> Dict[str, Any]:
        result = {
            "metadata": {
                "file": self.input_file,
                "method": "minhash_lsh+rerank",
                "threshold": self.threshold,
                "params": {
                    "num_perm": self.num_perm,
                    "shingle_size": self.shingle_size,
                    "min_tokens": self.min_tokens,
                    "rerank": self.rerank,
                    "normalize_numbers": self.normalize_numbers,
                    "lsh_bands": lsh.b,
                    "lsh_rows": lsh.r,
                    "seed": self.seed,
                },
                "stats": {
                    **stats,
                    "n_pairs": len(similar_pairs),
                    "elapsed_sec": round(time.time() - t0, 3),
                },
                "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            },
            "similar_pairs": similar_pairs,
        }
        out_path = self.input_dir / f"{self.input_filename}_similarity_results.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"Finished. {len(similar_pairs)} pairs >= {self.threshold}.")
        print(f"Saved to {out_path}")
        self.logger.info("Done. pairs=%d elapsed=%.2fs",
                         len(similar_pairs), time.time() - t0)
        return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _process_single(file_path: Path, kwargs: Dict[str, Any]) -> Tuple[str, int]:
    try:
        analyzer = LSHSimilarityAnalyzer(str(file_path), **kwargs)
        res = analyzer.analyze()
        return str(file_path), len(res["similar_pairs"])
    except Exception as exc:
        print(f"[ERROR] {file_path}: {exc}")
        return str(file_path), -1


def main() -> None:
    parser = argparse.ArgumentParser(
        "Near-duplicate detection via MinHash + Banded LSH (with optional rerank)"
    )
    parser.add_argument("input_files", nargs="+",
                        help="JSON files or glob patterns")
    parser.add_argument("--threshold", type=float, default=0.85,
                        help="Similarity threshold (default 0.85)")
    parser.add_argument("--num-perm", type=int, default=128,
                        help="Number of MinHash permutations (default 128)")
    parser.add_argument("--shingle-size", type=int, default=5,
                        help="Word n-gram shingle size (default 5)")
    parser.add_argument("--min-tokens", type=int, default=30,
                        help="Chunks shorter than this go through exact match "
                             "instead of LSH (default 30)")
    parser.add_argument("--rerank",
                        choices=["none", "jaccard", "tfidf", "both"],
                        default="both",
                        help="Rerank strategy on candidate pairs (default both)")
    parser.add_argument("--normalize-numbers", action="store_true",
                        help="Replace numbers/years/percentages with placeholders "
                             "before tokenisation. Useful as an ablation; for "
                             "SEC dedup, leaving it OFF protects period-over-"
                             "period updates from being merged.")
    parser.add_argument("--max-workers", type=int, default=4,
                        help="Thread pool size when multiple files given")
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()

    if not 0.0 < args.threshold < 1.0:
        raise SystemExit("Threshold must be in (0,1).")

    # Expand globs
    files: List[Path] = []
    for patt in args.input_files:
        p = Path(patt)
        if p.is_file():
            files.append(p)
        else:
            files.extend(sorted(Path().glob(patt)))
    files = [f for f in files if f.suffix == ".json"]
    if not files:
        raise SystemExit("No JSON files found.")

    print(f"Found {len(files)} file(s). threshold={args.threshold} "
          f"num_perm={args.num_perm} k={args.shingle_size} "
          f"rerank={args.rerank} normalize_numbers={args.normalize_numbers}")

    kwargs: Dict[str, Any] = dict(
        threshold=args.threshold,
        num_perm=args.num_perm,
        shingle_size=args.shingle_size,
        min_tokens=args.min_tokens,
        rerank=args.rerank,
        normalize_numbers=args.normalize_numbers,
        seed=args.seed,
    )

    summary: List[Tuple[str, int]] = []
    if len(files) == 1 or args.max_workers <= 1:
        for f in files:
            summary.append(_process_single(f, kwargs))
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as pool:
            fut2file = {pool.submit(_process_single, f, kwargs): f for f in files}
            for fut in concurrent.futures.as_completed(fut2file):
                summary.append(fut.result())

    print("\n=== Summary ===")
    for fp, n_pairs in summary:
        if n_pairs >= 0:
            print(f"[OK]   {fp} -> {n_pairs} similar pairs")
        else:
            print(f"[FAIL] {fp}")


if __name__ == "__main__":
    main()
