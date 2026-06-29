#!/usr/bin/env python3
"""Step 5: optional LLM labeling for semantic Excel chunks."""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from common import dump_json, load_json


def _load_env(path: str | Path | None) -> dict[str, str]:
    values: dict[str, str] = {}
    if path:
        env_path = Path(path)
        if env_path.is_file():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue
                key, value = stripped.split("=", 1)
                values[key.strip()] = value.strip().strip("\"'")
    for key in ("excel_llm_model_name", "excel_llm_api_key", "excel_llm_base_url"):
        if os.environ.get(key):
            values[key] = os.environ[key]
    return values


def _chat_completion(*, base_url: str, api_key: str, model: str, prompt: str, timeout: int = 60) -> dict[str, Any]:
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "You label Excel chunks for investment research. Return compact valid JSON only.",
            },
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.1,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _prompt(chunk: dict[str, Any]) -> str:
    content = str(chunk.get("content") or "")
    if len(content) > 4000:
        content = content[:4000] + "\n...[truncated]"
    return (
        "Given one semantic Excel chunk from a private-fund investment research corpus, "
        "return JSON with keys title, summary, content_type. "
        "content_type must be one of excel_table, excel_section, excel_model_section. "
        "Do not invent facts. Use only the content.\n\n"
        f"Current title: {chunk.get('title')}\n"
        f"Current content_type: {chunk.get('content_type')}\n"
        f"Source: {chunk.get('source_ref')}\n\n"
        f"Content:\n{content}"
    )


def apply_llm_labels(chunks: list[dict[str, Any]], *, env_path: str | Path | None, enabled: bool) -> list[dict[str, Any]]:
    if not enabled:
        return chunks
    env = _load_env(env_path)
    model = env.get("excel_llm_model_name")
    api_key = env.get("excel_llm_api_key")
    base_url = env.get("excel_llm_base_url")
    if not (model and api_key and base_url):
        return chunks

    updated: list[dict[str, Any]] = []
    for item in chunks:
        chunk = dict(item)
        try:
            response = _chat_completion(base_url=base_url, api_key=api_key, model=model, prompt=_prompt(chunk))
            message = response["choices"][0]["message"]["content"]
            parsed = json.loads(message)
            title = str(parsed.get("title") or "").strip()
            summary = str(parsed.get("summary") or "").strip()
            content_type = str(parsed.get("content_type") or "").strip()
            if title:
                path = chunk.get("title_path") if isinstance(chunk.get("title_path"), list) else []
                chunk["title"] = title
                chunk["title_path"] = [*path[:-1], title] if path else [title]
            if summary:
                chunk["summary"] = summary
            if content_type in {"excel_table", "excel_section", "excel_model_section"}:
                chunk["content_type"] = content_type
                chunk["type"] = content_type
            metadata = dict(chunk.get("metadata") or {})
            metadata["llm_label"] = {
                "title": title,
                "summary": summary,
                "content_type": content_type,
                "model": model,
            }
            chunk["metadata"] = metadata
        except (urllib.error.URLError, KeyError, json.JSONDecodeError, TimeoutError, ValueError):
            pass
        updated.append(chunk)
    return updated


def main() -> None:
    parser = argparse.ArgumentParser(description="Optionally label semantic Excel chunks with LLM.")
    parser.add_argument("--input", required=True, help="Path to base_final.raw.json")
    parser.add_argument("--output", required=True, help="Path to base_final.json")
    parser.add_argument("--env", default=str(Path(__file__).resolve().parents[1] / ".env"))
    parser.add_argument("--enable", action="store_true")
    args = parser.parse_args()
    chunks = load_json(args.input)
    dump_json(apply_llm_labels(chunks, env_path=args.env, enabled=args.enable), args.output)


if __name__ == "__main__":
    main()
