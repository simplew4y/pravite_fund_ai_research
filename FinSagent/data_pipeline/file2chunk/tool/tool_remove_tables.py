import os
import glob
import json
import time
import sys
from collections import defaultdict
from typing import List, Tuple
from multiprocessing import Pool
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm

load_dotenv()


NUM_WORKERS = 8
CONTEXT_CHAR_LIMIT = 60000  # conservative limit for 96k token context
MAX_RETRIES = 15


class FatalAPIError(Exception):
    """Raised when API calls fail fatally after max retries."""
    pass


def _get_client() -> OpenAI:
    """Create an OpenAI client (one per worker process)."""
    return OpenAI(api_key=os.getenv("LLM_API_KEY"), base_url=os.getenv("LLM_BASE_URL"))


def _llm_call(client: OpenAI, messages: list) -> str:
    """Make an LLM call with retry logic.
    - Rate limit errors: exponential backoff, retry indefinitely.
    - Other errors: retry up to MAX_RETRIES times, then raise FatalAPIError.
    """
    model = os.getenv("LLM_MODEL_NAME", "deepseek-v3.2")
    delay = 1.0
    retries = 0
    while True:
        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.3,
            )
            return response.choices[0].message.content
        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str or "429" in error_str or "too many" in error_str:
                print(f"[Worker {os.getpid()}] Rate limited. Retrying in {delay:.1f}s...", flush=True)
                time.sleep(delay)
                delay = min(delay * 2, 120)
                continue
            retries += 1
            if retries >= MAX_RETRIES:
                raise FatalAPIError(
                    f"API call failed {MAX_RETRIES} times. Last error: {e}"
                )
            print(f"[Worker {os.getpid()}] API error ({retries}/{MAX_RETRIES}): {e}. Retrying in {delay:.1f}s...", flush=True)
            time.sleep(delay)
            delay = min(delay * 2, 60)


def generate_group_summary(client: OpenAI, title: str, contents: List[str]) -> str:
    """生成分组摘要: concatenate all chunks, split if >64k context, chain summaries."""
    full_text = "\n\n".join(contents)

    # Split into segments if the concatenated text exceeds the context char limit
    if len(full_text) <= CONTEXT_CHAR_LIMIT:
        segments = [full_text]
    else:
        segments = [
            full_text[i : i + CONTEXT_CHAR_LIMIT]
            for i in range(0, len(full_text), CONTEXT_CHAR_LIMIT)
        ]

    summary = ""
    for idx, segment in enumerate(segments):
        if summary:
            prompt = (
                f"You are a strict summarization API. Update the running summary for the document titled '{title}'. "
                f"Seamlessly blend the facts from the 'New Content' into the 'Previous Summary' to create a single, cohesive, up-to-date narrative. "
                f"Do not reference the summarization process. Start generating the factual summary immediately from the very first word. Begin with a concrete noun or named entity. Never begin with prefixes like 'Based on', 'The text', 'Given', 'The document'.\n\n"
                f"Previous Summary:\n{summary}\n\n"
                f"New Content:\n{segment}\n\n"
                f"Updated Summary:"
            )
        else:
            prompt = (
                f"Summarize the information provided below titled '{title}'. "
                f"Do not include any conversational text or markdown formatting. Begin with a concrete noun or named entity. Never begin with prefixes like 'Based on', 'The text', 'Given', 'The document'.\n\n"
                f"Content:\n{segment}\n\n"
                f"Summary:"
            )

        summary = _llm_call(client, [{"role": "user", "content": prompt}])

    return summary

def process_single_file(args: Tuple[str, str]) -> str:
    """Worker function: process one JSON file and save the result."""
    file_path, output_path = args
    filename = os.path.basename(file_path)
    output_file_path = os.path.join(output_path, filename)

    client = _get_client()

    print(f"[Worker {os.getpid()}] Processing: {file_path}", flush=True)

    with open(file_path, 'r', encoding='utf-8') as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            print(f"[Worker {os.getpid()}] Error decoding JSON: {file_path}. Skipping.", flush=True)
            return file_path

    total_tables = sum(1 for obj in data if obj.get('type') == 'table')
    print(f"[Worker {os.getpid()}]   - Total tables found: {total_tables}", flush=True)

    # 1. Group ALL objects by their original title_summary (sorted by id within each group)
    groups = defaultdict(list)
    for obj in sorted(data, key=lambda x: x.get('id', 0)):
        summary_key = obj.get('title_summary', '')
        groups[summary_key].append(obj)

    final_data = []
    processed_tables = 0

    # 2. Evaluate each group independently
    for original_title_summary, group_objs in groups.items():
        table_count_in_group = sum(1 for obj in group_objs if obj.get('type') == 'table')
        has_tables = table_count_in_group > 0

        if has_tables:
            non_tables = sorted(
                [obj for obj in group_objs if obj.get('type') != 'table'],
                key=lambda x: x.get('id', 0),
            )

            if non_tables:
                # print(f"[Worker {os.getpid()}]   - {table_count_in_group} table removed. Regenerating summary for group: '{original_title_summary[:30]}...'", flush=True)
                contents = [obj.get('content', '') for obj in non_tables]

                title = original_title_summary.split("\nsummary:")[0].replace("title:", "").strip()
                new_summary_text = generate_group_summary(client, title, contents)
                new_title_summary = f"title: {title}\nsummary: {new_summary_text}"

                for obj in non_tables:
                    obj['title_summary'] = new_title_summary
                # print(f"{new_title_summary=}")
                final_data.extend(non_tables)
            processed_tables += table_count_in_group
            print(f"[Worker {os.getpid()}]   - Table progress: {processed_tables}/{total_tables}", flush=True)

        else:
            final_data.extend(group_objs)

    # 3. Restore chronological order based on 'id'
    final_data.sort(key=lambda x: x.get('id', 0))

    # 4. Save the modified data to the NEW output path
    with open(output_file_path, 'w', encoding='utf-8') as f:
        json.dump(final_data, f, ensure_ascii=False, indent=4)

    print(f"[Worker {os.getpid()}] Finished: {output_file_path}", flush=True)
    return file_path


def process_json_directory(base_path: str, output_path: str):
    """Processes JSON files with multiple workers, supports resume."""

    # Ensure the output directory exists
    os.makedirs(output_path, exist_ok=True)

    search_pattern = os.path.join(base_path, "*.json")
    json_files = glob.glob(search_pattern)

    if not json_files:
        print(f"No JSON files found in {base_path}")
        return

    # Resume support: skip files already present in output dir
    existing_files = set(os.listdir(output_path))
    pending_files = [f for f in json_files if os.path.basename(f) not in existing_files]
    skipped = len(json_files) - len(pending_files)

    print(f"Total files: {len(json_files)}, Already done: {skipped}, Pending: {len(pending_files)}", flush=True)

    if not pending_files:
        print("All files already processed. Nothing to do.")
        return

    tasks = [(f, output_path) for f in pending_files]

    with Pool(processes=NUM_WORKERS) as pool:
        try:
            for _ in tqdm(
                pool.imap_unordered(process_single_file, tasks),
                total=len(tasks),
                desc="Files processed",
                unit="file",
            ):
                pass
        except FatalAPIError as e:
            print(f"\nFatal API error occurred: {e}", flush=True)
            print("Terminating all worker processes and exiting...", flush=True)
            pool.terminate()
            pool.join()
            sys.exit(1)
        except Exception as e:
            print(f"\nUnexpected worker error: {e}", flush=True)
            print("Terminating all worker processes and exiting...", flush=True)
            pool.terminate()
            pool.join()
            sys.exit(1)

    print("\nAll files processed.", flush=True)

# --- Execution ---
if __name__ == "__main__":
    
    # * zeekr 20250729
    TARGET_DIRECTORY = "/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/base_finals"
    OUTPUT_DIRECTORY = "/root/autodl-tmp/RAG_Agent_data/Zeekr/20250729/base_finals_wo_table"

    # * zeekr 20260301
    # TARGET_DIRECTORY = "/root/autodl-tmp/RAG_Agent_data/Zeekr/20260301/base_final/" 
    # OUTPUT_DIRECTORY = "/root/autodl-tmp/RAG_Agent_data/Zeekr/20260301/base_final_wo_table/"

    # * financebench (filtered)
    # TARGET_DIRECTORY = "/root/autodl-tmp/cjj/data/financebench/lotus"
    # OUTPUT_DIRECTORY = "/root/autodl-tmp/cjj/data/financebench/lotus_wo_table/"

    # * lotus
    # TARGET_DIRECTORY = "/root/autodl-tmp/irelia_pipeline/training/tmp/2025_06_all/lotus" 
    # OUTPUT_DIRECTORY = "/root/autodl-tmp/irelia_pipeline/training/tmp/2025_06_all/lotus_wo_table"

    # * finder (filtered)
    # TARGET_DIRECTORY = "/root/autodl-tmp/RAG_Agent_data/finder/final_base_jsons"
    # OUTPUT_DIRECTORY = "/root/autodl-tmp/RAG_Agent_data/finder/final_base_jsons_wo_table"
    
    process_json_directory(TARGET_DIRECTORY, OUTPUT_DIRECTORY)
