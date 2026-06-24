"""
Fix Chinese summaries in processed table/text JSONs.

Two modes:
  --scan-only   Just report which files/fields contain Chinese characters (no API needed).
  (default)     Detect and re-generate summaries that contain Chinese via LLM API.

Object types handled differently:
  - type=table  → regenerate per-object 'summary' field  (same as before)
  - type=text   → group all objects sharing the same 'title_summary',
                   concatenate their contents, regenerate group summary once
"""

import json
import os
import re
import time
import logging
import argparse
from pathlib import Path
from collections import defaultdict
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler("fix_chinese_summaries.log"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)

CHINESE_CHAR_PATTERN = re.compile(r"[\u4e00-\u9fff]")
CONTEXT_CHAR_LIMIT = 60000  # conservative limit for long documents
MAX_RETRIES = 15


class FatalAPIError(Exception):
    """Raised when API calls fail fatally after max retries."""
    pass


def has_chinese(text: str) -> bool:
    return bool(CHINESE_CHAR_PATTERN.search(text))


# ── Scan-only mode ───────────────────────────────────────────────────────────


def scan_folder(folder: str):
    """Quick scan: report every JSON file that contains Chinese characters."""
    hit_files = 0
    for filename in sorted(os.listdir(folder)):
        if not filename.endswith(".json"):
            continue
        filepath = os.path.join(folder, filename)
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()

        matches = CHINESE_CHAR_PATTERN.findall(content)
        if matches:
            print(
                f"[HIT] {filename} — {len(matches)} Chinese char(s) found, "
                f"e.g.: {''.join(matches[:10])}"
            )
            hit_files += 1
        else:
            print(f"[OK]  {filename}")

    print(f"\nScan complete. {hit_files} file(s) contain Chinese characters.")


# ── LLM call helpers ────────────────────────────────────────────────────────


def _llm_call(client, messages: list, model: str) -> str:
    """LLM call with retry logic (rate-limit aware)."""
    delay = 1.0
    retries = 0
    while True:
        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=1,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str or "429" in error_str or "too many" in error_str:
                logger.warning(f"Rate limited. Retrying in {delay:.1f}s...")
                time.sleep(delay)
                delay = min(delay * 2, 120)
                continue
            retries += 1
            if retries >= MAX_RETRIES:
                raise FatalAPIError(
                    f"API call failed {MAX_RETRIES} times. Last error: {e}"
                )
            logger.error(f"API error ({retries}/{MAX_RETRIES}): {e}. Retrying in {delay:.1f}s...")
            time.sleep(delay)
            delay = min(delay * 2, 60)


# ── Table: per-object summary regeneration ───────────────────────────────────


def generate_table_summary(
    client,
    html_content: str,
    model: str,
    previous_context: str = "",
    table_caption: str = "",
    table_footnote: str = "",
) -> str:
    prompt = f"""Please generate a descriptive summary of the table based on the table content and surrounding context below.

## Context text before the table:
{previous_context if previous_context else "(No context)"}

## Original table caption:
{table_caption if table_caption else "(No caption)"}

## Table footnote:
{table_footnote if table_footnote else "(No footnote)"}

## Table HTML content:
{html_content}

Please generate a natural descriptive text including:
- The title or theme of the table
- The main columns/fields included in the table
- Key data points or notable values
- Important information such as the time range of the data, comparison dimensions or other relevant details

Please output only the descriptive text, without any formatting marks or prefixes. Do not include any conversational text or markdown formatting. Begin with a concrete noun or named entity. Never begin with prefixes like 'Based on', 'The text', 'Given', 'The document', 'The table'.

Summary:"""

    max_chinese_retries = 3
    chinese_retries = 0

    while True:
        result = _llm_call(
            client,
            [
                {
                    "role": "system",
                    "content": (
                        "You are a professional document analysis assistant, "
                        "skilled at understanding and summarizing table content. "
                        "Please describe the table information in accurate language."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            model=model,
        )

        if has_chinese(result):
            chinese_retries += 1
            if chinese_retries >= max_chinese_retries:
                raise ValueError(
                    f"Table summary still contains Chinese after {max_chinese_retries} retries"
                )
            logger.warning(
                f"Re-generated table summary still contains Chinese "
                f"(attempt {chinese_retries}/{max_chinese_retries}), retrying..."
            )
            time.sleep(2)
            continue

        return result


# ── Text: group summary regeneration ─────────────────────────────────────────


def generate_group_summary(client, title: str, contents: list[str], model: str) -> str:
    """Concatenate all chunk contents, split if too long, chain summaries."""
    full_text = "\n\n".join(contents)

    if len(full_text) <= CONTEXT_CHAR_LIMIT:
        segments = [full_text]
    else:
        segments = [
            full_text[i : i + CONTEXT_CHAR_LIMIT]
            for i in range(0, len(full_text), CONTEXT_CHAR_LIMIT)
        ]

    summary = ""
    for segment in segments:
        if summary:
            prompt = (
                f"You are a strict summarization API. Update the running summary for the document titled '{title}'. "
                f"Seamlessly blend the facts from the 'New Content' into the 'Previous Summary' to create a single, cohesive, up-to-date narrative. "
                f"Do not reference the summarization process. Start generating the factual summary immediately from the very first word. "
                f"Begin with a concrete noun or named entity. Never begin with prefixes like 'Based on', 'The text', 'Given', 'The document'.\n\n"
                f"Previous Summary:\n{summary}\n\n"
                f"New Content:\n{segment}\n\n"
                f"Updated Summary:"
            )
        else:
            prompt = (
                f"Summarize the information provided below titled '{title}'. "
                f"Do not include any conversational text or markdown formatting. "
                f"Begin with a concrete noun or named entity. Never begin with prefixes like 'Based on', 'The text', 'Given', 'The document'.\n\n"
                f"Content:\n{segment}\n\n"
                f"Summary:"
            )

        summary = _llm_call(client, [{"role": "user", "content": prompt}], model=model)

    # Retry if final summary still has Chinese
    max_chinese_retries = 3
    if has_chinese(summary):
        for attempt in range(1, max_chinese_retries + 1):
            logger.warning(
                f"Group summary for '{title[:40]}' contains Chinese "
                f"(attempt {attempt}/{max_chinese_retries}), regenerating..."
            )
            time.sleep(2)
            summary = _llm_call(
                client,
                [{"role": "user", "content": (
                    f"Rewrite the following summary in English only. "
                    f"Do not include any Chinese characters.\n\n{summary}"
                )}],
                model=model,
            )
            if not has_chinese(summary):
                break
        else:
            raise ValueError(
                f"Group summary for '{title[:40]}' still contains Chinese after retries"
            )

    return summary


# ── Main fix logic ───────────────────────────────────────────────────────────


def fix_folder(
    folder: str,
    api_key: str = None,
    base_url: str = None,
    model: str = None,
):
    from openai import OpenAI

    api_key = api_key or os.environ.get("LLM_API_KEY")
    base_url = base_url or os.environ.get("LLM_BASE_URL")
    model = model or os.environ.get("LLM_MODEL_NAME") or "deepseek-v3.1"

    if not api_key:
        raise ValueError("LLM_API_KEY not set in .env or via --api-key")
    if not base_url:
        raise ValueError("LLM_BASE_URL not set in .env or via --base-url")

    logger.info(f"Using model={model}, base_url={base_url}")
    client = OpenAI(api_key=api_key, base_url=base_url)

    json_files = sorted(Path(folder).glob("*.json"))
    logger.info(f"Found {len(json_files)} JSON files in {folder}")

    total_tables_fixed = 0
    total_groups_fixed = 0

    for json_path in json_files:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if not isinstance(data, list):
            logger.warning(f"Skipping {json_path.name}: top-level is not a list")
            continue

        file_tables_fixed = 0
        file_groups_fixed = 0

        # ── 1. Fix table objects (per-object 'summary' field) ────────────
        for i, obj in enumerate(data):
            if obj.get("type") != "table":
                continue
            summary = obj.get("summary", "")
            if not summary or not has_chinese(summary):
                continue

            html_content = obj.get("content", "")
            table_caption = obj.get("table_caption", "")
            if isinstance(table_caption, list):
                table_caption = " ".join(table_caption)
            table_footnote = obj.get("table_footnote", "")
            if isinstance(table_footnote, list):
                table_footnote = " ".join(table_footnote)

            logger.info(
                f"[{json_path.name}] table obj {i}: Chinese in summary, regenerating..."
            )
            logger.info(f"  Old summary: {summary[:80]}")

            try:
                new_summary = generate_table_summary(
                    client,
                    html_content,
                    model=model,
                    table_caption=table_caption,
                    table_footnote=table_footnote,
                )
            except (ValueError, FatalAPIError) as e:
                logger.error(f"[{json_path.name}] table obj {i}: {e}, skipping.")
                continue

            obj["summary"] = new_summary
            file_tables_fixed += 1
            logger.info(f"  New summary: {new_summary[:80]}")

        # ── 2. Fix text objects (group-level 'title_summary' field) ──────
        #    Group by title_summary, only process groups whose title_summary
        #    contains Chinese. Each group is processed exactly once.
        groups_to_fix: dict[str, list[int]] = defaultdict(list)
        for i, obj in enumerate(data):
            if obj.get("type") != "text":
                continue
            ts = obj.get("title_summary", "")
            if ts and has_chinese(ts):
                groups_to_fix[ts].append(i)

        fixed_title_summaries: set[str] = set()
        for original_ts, indices in groups_to_fix.items():
            if original_ts in fixed_title_summaries:
                continue

            # Parse title from "title: X\nsummary: Y"
            title_line = original_ts.split("\nsummary:")[0]
            title = title_line.replace("title:", "").strip()

            # Collect ALL objects sharing this title_summary (not just those
            # in indices -- indices only tracks text objects, but we want the
            # full group for content concatenation).
            group_objs = sorted(
                [data[idx] for idx in indices],
                key=lambda x: x.get("id", 0),
            )
            contents = [obj.get("content", "") for obj in group_objs if obj.get("content")]

            logger.info(
                f"[{json_path.name}] text group '{title[:50]}': "
                f"{len(indices)} chunk(s) with Chinese title_summary, regenerating..."
            )

            if not contents:
                logger.warning(f"  No content found for group, skipping.")
                continue

            try:
                new_summary_text = generate_group_summary(client, title, contents, model=model)
            except (ValueError, FatalAPIError) as e:
                logger.error(f"[{json_path.name}] text group '{title[:50]}': {e}, skipping.")
                continue

            new_title_summary = f"title: {title}\nsummary: {new_summary_text}"

            # Update ALL objects in the file that share this original title_summary
            for obj in data:
                if obj.get("title_summary") == original_ts:
                    obj["title_summary"] = new_title_summary

            fixed_title_summaries.add(original_ts)
            file_groups_fixed += 1
            logger.info(f"  New group summary: {new_summary_text[:80]}")

        # ── 3. Save if anything changed ──────────────────────────────────
        if file_tables_fixed > 0 or file_groups_fixed > 0:
            with open(json_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            logger.info(
                f"[{json_path.name}] Fixed {file_tables_fixed} table summary(s), "
                f"{file_groups_fixed} text group(s). Saved."
            )
            total_tables_fixed += file_tables_fixed
            total_groups_fixed += file_groups_fixed
        else:
            logger.info(f"[{json_path.name}] No Chinese summaries found, skipped.")

    logger.info(
        f"Done. Total fixed: {total_tables_fixed} table summary(s), "
        f"{total_groups_fixed} text group(s)."
    )


# ── CLI ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Scan for / fix Chinese summaries in table & text JSONs"
    )
    parser.add_argument(
        "folder",
        nargs="?",
        # default="/root/autodl-tmp/RAG_Agent_data/finder/final_base_jsons_wo_table",
        # default="/root/autodl-tmp/RAG_Agent_data/finder/required_magic_pdf_table",
        # default="/root/autodl-tmp/RAG_Agent_data/lotus/20250701/filtered_pdf_processed_table",
        default="/root/autodl-tmp/RAG_Agent_data/lotus/20250701/final_meta_wo_table",
        # default="/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/base_finals_wo_table",
        # default="/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/tables",
        help="Folder containing JSON files",
    )
    parser.add_argument(
        "--scan-only",
        action="store_true",
        help="Only report files with Chinese characters (no LLM calls)",
    )
    parser.add_argument("--api-key", help="LLM API Key (or set LLM_API_KEY in .env)")
    parser.add_argument("--base-url", help="LLM Base URL (or set LLM_BASE_URL in .env)")
    parser.add_argument("--model", help="Model name (or set LLM_MODEL_NAME in .env)")

    args = parser.parse_args()

    if args.scan_only:
        scan_folder(args.folder)
    else:
        fix_folder(
            folder=args.folder,
            api_key=args.api_key,
            base_url=args.base_url,
            model=args.model,
        )
