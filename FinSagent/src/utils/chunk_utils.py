import hashlib
from typing import Any, Dict, Iterable, List

EXCLUDED_OUTPUT_METADATA_KEYS = {"next_chunk_id", "prev_chunk_id"}


def build_chunk_dedupe_key(chunk: Dict[str, Any]) -> str:
    """
    Build a stable key for deduplicating chunks across retrievers, sub-queries,
    and specialist agents.
    """
    metadata = chunk.get("metadata") or {}
    doc_id = metadata.get("doc_id")
    if doc_id:
        return f"doc_id:{doc_id}"

    source_file = metadata.get("source_file") or metadata.get("source") or ""
    page = metadata.get("page_idx", metadata.get("page", metadata.get("page_number", metadata.get("pageIndex", ""))))
    table_index = metadata.get("table_index", "")
    original_index = metadata.get("original_index", "")
    caption = metadata.get("caption") or metadata.get("table_caption") or ""
    content_type = metadata.get("content_type") or chunk.get("retriever") or "text"
    page_content = chunk.get("page_content") or ""
    fallback = (
        f"{content_type}|{source_file}|{page}|{table_index}|"
        f"{original_index}|{caption}|{page_content[:256]}"
    )
    return "fallback:" + hashlib.sha1(fallback.encode("utf-8")).hexdigest()


def dedupe_chunks(chunks: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Deduplicate chunks while keeping the first-seen ordering stable.
    """
    unique_chunks: List[Dict[str, Any]] = []
    seen_keys = set()
    for chunk in chunks:
        key = build_chunk_dedupe_key(chunk)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        unique_chunks.append(chunk)
    return unique_chunks


def sanitize_chunk_for_output(chunk: Dict[str, Any]) -> Dict[str, Any]:
    metadata = dict((chunk.get("metadata") or {}))
    for key in EXCLUDED_OUTPUT_METADATA_KEYS:
        metadata.pop(key, None)
    sanitized = dict(chunk)
    sanitized["metadata"] = metadata
    return sanitized


def sanitize_chunks_for_output(chunks: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [sanitize_chunk_for_output(chunk) for chunk in chunks]


def get_chunk_source_id(chunk: Dict[str, Any]) -> str:
    metadata = chunk.get("metadata") or {}
    return metadata.get("doc_id") or build_chunk_dedupe_key(chunk)


def collect_pre_rerank_chunks_from_evidences(evidences: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    collected: List[Dict[str, Any]] = []
    for evidence in evidences:
        collected.extend(evidence.get("pre_rerank_chunks", []) or evidence.get("chunks", []))
    return dedupe_chunks(collected)


def collect_pre_rerank_chunks_from_agent_outputs(agent_outputs: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    collected: List[Dict[str, Any]] = []
    for payload in agent_outputs.values():
        collected.extend(collect_pre_rerank_chunks_from_evidences(payload.get("evidence", [])))
    return dedupe_chunks(collected)
