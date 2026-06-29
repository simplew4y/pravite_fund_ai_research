#!/usr/bin/env python3
"""Step 3: optional LLM labels for Word semantic chunks."""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from common import dump_json, load_json, sha256_text


VALID_CONTENT_TYPES = {"word_section", "word_table", "word_image_ocr"}


def _load_env(path: str | Path | None) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path:
        return values
    env_path = Path(path)
    if not env_path.is_file():
        return values
    for raw_line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _cfg(env_path: str | Path | None) -> dict[str, str]:
    loaded = _load_env(env_path)
    return {
        "model": os.environ.get("word_llm_model_name") or loaded.get("word_llm_model_name") or "",
        "api_key": os.environ.get("word_llm_api_key") or loaded.get("word_llm_api_key") or "",
        "base_url": (os.environ.get("word_llm_base_url") or loaded.get("word_llm_base_url") or "").rstrip("/"),
    }


def _call_openai_compatible(cfg: dict[str, str], content: str) -> dict[str, str]:
    prompt = (
        "You are a financial document parsing assistant. Based on the Word document "
        "chunk below, generate a concise Chinese title and a one-sentence Chinese summary. "
        "Return JSON only with fields: title, summary.\n\n"
        f"{content[:4000]}"
    )
    body = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": "Return compact valid JSON only."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.1,
    }
    request = urllib.request.Request(
        cfg["base_url"] + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.loads(response.read().decode("utf-8"))
    text = data["choices"][0]["message"]["content"].strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        parsed = json.loads(text[start : end + 1]) if start >= 0 and end > start else {}
    return {"title": str(parsed.get("title") or ""), "summary": str(parsed.get("summary") or "")}


def apply_llm_labels(chunks: list[dict[str, Any]], *, env_path: str | Path | None = None, enabled: bool = False) -> list[dict[str, Any]]:
    if not enabled:
        return chunks
    cfg = _cfg(env_path)
    if not cfg["model"] or not cfg["api_key"] or not cfg["base_url"]:
        raise ValueError("Word LLM labeling requires word_llm_model_name, word_llm_api_key, and word_llm_base_url")
    for chunk in chunks:
        if chunk.get("content_type") not in VALID_CONTENT_TYPES:
            continue
        try:
            label = _call_openai_compatible(cfg, str(chunk.get("content") or ""))
        except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as exc:
            metadata = dict(chunk.get("metadata") or {})
            metadata["llm_label_error"] = str(exc)
            chunk["metadata"] = metadata
            continue
        if label.get("title"):
            path = list(chunk.get("title_path") or [])
            if path:
                path[-1] = label["title"]
            else:
                path = [label["title"]]
            chunk["title"] = label["title"]
            chunk["title_path"] = path
        if label.get("summary"):
            chunk["summary"] = label["summary"]
        chunk["content_hash"] = sha256_text(str(chunk.get("content") or ""))
    return chunks


def main() -> None:
    parser = argparse.ArgumentParser(description="Optionally label Word chunks with an OpenAI-compatible LLM.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--env", default=str(Path(__file__).resolve().parents[1] / ".env"))
    parser.add_argument("--enable", action="store_true")
    args = parser.parse_args()
    dump_json(apply_llm_labels(load_json(args.input), env_path=args.env, enabled=args.enable), args.output)


if __name__ == "__main__":
    main()
