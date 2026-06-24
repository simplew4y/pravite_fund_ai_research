"""
基于相似度分析的文本去重工具（Union-Find 等价类版）

相对旧版的改动
----------------
旧版直接把每个 ``similar_pair`` 中的 ``chunk2.id`` 加入待删集合，再从 base file
里 filter 掉。这种做法在 ``(A,B), (B,C), (C,D)`` 这类传递性相似链上行为不可
预测：保留谁完全取决于 pair 出现的顺序，可能保留多份近重复，也可能误删有效
内容。

本版本将相似对视为图的边，用 Union-Find 形成等价类，每个等价类按可配置的
策略选出一个代表保留，其余删除：

- ``longest``  （默认）：保留 ``content`` 最长的 chunk。财报场景下通常意味
  着保留信息最完整的版本。
- ``smallest_id`` ：保留 id 字典序最小的 chunk（行为可复现）。
- ``first``    ：保留在 base file 中出现顺序最靠前的 chunk。

命令行使用说明
----------------
python step5_delete_similar_chunks.py similarity_file base_file \
       [--keep-policy {longest,smallest_id,first}]

输出
----
- ``{base_file}_deduped{ext}``：去重后的 chunks。
- ``{base_file}_dedup_report.json``：等价类与代表选择的诊断报告，便于复核。
"""


import argparse
import json
import os
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Tuple


# ---------------------------------------------------------------------------
# Union-Find
# ---------------------------------------------------------------------------
class UnionFind:
    """Path-compressed + union-by-size disjoint set over hashable ids."""

    def __init__(self, items: Iterable[Any] = ()):
        self.parent: Dict[Any, Any] = {}
        self.size: Dict[Any, int] = {}
        for it in items:
            self.add(it)

    def add(self, x: Any) -> None:
        if x not in self.parent:
            self.parent[x] = x
            self.size[x] = 1

    def find(self, x: Any) -> Any:
        self.add(x)
        # iterative path compression
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a: Any, b: Any) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.size[ra] < self.size[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        self.size[ra] += self.size[rb]

    def groups(self) -> Dict[Any, List[Any]]:
        out: Dict[Any, List[Any]] = defaultdict(list)
        for x in self.parent:
            out[self.find(x)].append(x)
        return out


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------
def build_equivalence_classes(
    similarity_file: str,
) -> Tuple[UnionFind, int]:
    """Read similarity pairs and union them; returns (UnionFind, n_pairs)."""
    print(f"Reading similarity file: {similarity_file}")
    with open(similarity_file, "r", encoding="utf-8") as f:
        sim_data = json.load(f)

    pairs = sim_data.get("similar_pairs", [])
    print(f"Found {len(pairs)} similar pairs")

    uf = UnionFind()
    for pair in pairs:
        try:
            id1 = pair["chunk1"]["id"]
            id2 = pair["chunk2"]["id"]
        except (KeyError, TypeError):
            print(f"Warning: skipping malformed pair: {pair}")
            continue
        uf.union(id1, id2)

    return uf, len(pairs)


def pick_representative(
    members: List[Dict[str, Any]],
    policy: str,
) -> Dict[str, Any]:
    """Select one chunk to keep from an equivalence class."""
    if policy == "longest":
        # primary: longest content; tie-break: smallest id (deterministic)
        ranked = sorted(
            members,
            key=lambda c: (-len(c.get("content", "") or ""), _id_rank(c.get("id"))),
        )
        return ranked[0]
    if policy == "smallest_id":
        return min(members, key=lambda c: _id_rank(c.get("id")))
    if policy == "first":
        # caller should pass members already in original order
        return members[0]
    raise ValueError(f"Unknown keep policy: {policy}")


def _id_rank(x: Any):
    """Order ids: ints before strings, strings lexicographically."""
    if isinstance(x, int):
        return (0, x)
    return (1, str(x))


def process_base_file(
    base_file: str,
    uf: UnionFind,
    policy: str = "longest",
) -> None:
    """Filter base file according to equivalence classes derived from `uf`."""
    print(f"\nProcessing base file: {base_file}")
    with open(base_file, "r", encoding="utf-8") as f:
        base_data: List[Dict[str, Any]] = json.load(f)

    original_count = len(base_data)
    print(f"Original chunk count: {original_count}")

    # Index chunks by id; preserve original order for "first" policy.
    id_to_chunk: Dict[Any, Dict[str, Any]] = {}
    id_to_order: Dict[Any, int] = {}
    for i, chunk in enumerate(base_data):
        cid = chunk.get("id")
        if cid is None:
            print(f"Warning: chunk without id skipped: {chunk}")
            continue
        id_to_chunk[cid] = chunk
        id_to_order[cid] = i

    # Group chunks by their equivalence-class root.
    # Chunks not appearing in any similar_pair are singletons -> always kept.
    class_to_members: Dict[Any, List[Dict[str, Any]]] = defaultdict(list)
    singletons: List[Dict[str, Any]] = []
    for cid, chunk in id_to_chunk.items():
        if cid in uf.parent:
            class_to_members[uf.find(cid)].append(chunk)
        else:
            singletons.append(chunk)

    # For each non-trivial class, pick a representative.
    kept_ids: set = set(c["id"] for c in singletons)
    report_classes: List[Dict[str, Any]] = []
    removed_total = 0

    for root, members in class_to_members.items():
        if policy == "first":
            members = sorted(members, key=lambda c: id_to_order.get(c["id"], 1 << 30))
        rep = pick_representative(members, policy)
        kept_ids.add(rep["id"])
        removed_ids = [m["id"] for m in members if m["id"] != rep["id"]]
        removed_total += len(removed_ids)
        if len(members) > 1:
            report_classes.append(
                {
                    "size": len(members),
                    "kept_id": rep["id"],
                    "kept_len": len(rep.get("content", "") or ""),
                    "removed_ids": removed_ids,
                }
            )

    # Preserve original order in the output.
    filtered_data = [c for c in base_data if c.get("id") in kept_ids]

    file_name, file_ext = os.path.splitext(base_file)
    output_file = f"{file_name}_deduped{file_ext}"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(filtered_data, f, ensure_ascii=False, indent=2)

    report_path = f"{file_name}_dedup_report.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "base_file": base_file,
                "policy": policy,
                "original_count": original_count,
                "final_count": len(filtered_data),
                "removed_count": removed_total,
                "n_equivalence_classes": len(class_to_members),
                "n_nontrivial_classes": len(report_classes),
                "classes": report_classes,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"Equivalence classes (incl. singletons): "
          f"{len(class_to_members) + len(singletons)}")
    print(f"Non-trivial classes (size > 1): {len(report_classes)}")
    print(f"Removed {removed_total} duplicate chunks "
          f"(policy={policy})")
    print(f"Final chunk count: {len(filtered_data)}")
    print(f"Output saved to:  {output_file}")
    print(f"Report saved to:  {report_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Remove duplicate chunks based on similarity analysis "
                    "(Union-Find equivalence classes)."
    )
    parser.add_argument("similarity_file",
                        help="Path to the similarity analysis JSON file")
    parser.add_argument("base_file",
                        help="Path to the base JSON file")
    parser.add_argument("--keep-policy",
                        choices=["longest", "smallest_id", "first"],
                        default="longest",
                        help="How to pick the representative within each "
                             "equivalence class (default: longest)")
    args = parser.parse_args()

    print("=== Starting Deduplication Process ===\n")
    try:
        uf, _ = build_equivalence_classes(args.similarity_file)
        process_base_file(args.base_file, uf, policy=args.keep_policy)
        print("\n=== Deduplication Process Completed Successfully ===")
    except Exception as e:
        print(f"\nError occurred: {e}")
        raise


if __name__ == "__main__":
    main()
