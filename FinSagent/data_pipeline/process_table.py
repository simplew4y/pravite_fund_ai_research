import json
import os
import logging
import base64
import random
import re
import time
import glob
from pathlib import Path
from typing import List, Dict, Optional, Any, Sequence
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
import anthropic
from openai import OpenAI
from tqdm import tqdm
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('table_reconstruction.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


@dataclass
class RateLimiter:
    """简单的速率限制器，控制每分钟请求数"""
    requests_per_minute: int = 50
    _lock: Lock = field(default_factory=Lock)
    _request_times: List[float] = field(default_factory=list)
    
    def acquire(self):
        """获取请求许可，必要时等待"""
        with self._lock:
            now = time.time()
            # 清理超过1分钟的请求记录
            self._request_times = [t for t in self._request_times if now - t < 60]
            
            if len(self._request_times) >= self.requests_per_minute:
                # 需要等待
                wait_time = 60 - (now - self._request_times[0]) + 0.1
                if wait_time > 0:
                    logger.info(f"Rate limit reached, waiting {wait_time:.1f}s...")
                    time.sleep(wait_time)
            
            self._request_times.append(time.time())


def encode_image(image_path: str) -> tuple[str, str]:
    """将图片编码为 base64 格式"""
    suffix = Path(image_path).suffix.lower()
    media_type_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }
    media_type = media_type_map.get(suffix, "image/jpeg")
    
    with open(image_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode("utf-8")
    
    return image_data, media_type


def load_anthropic_api_keys(
    explicit_key: Optional[str] = None,
    explicit_keys: Optional[Sequence[str]] = None,
) -> List[str]:
    """
    Load Anthropic API keys from explicit args or environment.

    Supports the following env vars (in priority order):
    - ANTHROPIC_API_KEYS: comma/whitespace separated list of keys
    - ANTHROPIC_API_KEY_1, ANTHROPIC_API_KEY_2, ...: numbered keys
    - ANTHROPIC_API_KEY: single key fallback
    """
    if explicit_keys:
        keys = [k.strip() for k in explicit_keys if k and k.strip()]
        if keys:
            return keys

    if explicit_key and explicit_key.strip():
        return [explicit_key.strip()]

    keys: List[str] = []

    multi = os.environ.get("ANTHROPIC_API_KEYS", "").strip()
    if multi:
        keys = [k.strip() for k in re.split(r"[,\s]+", multi) if k.strip()]

    if not keys:
        numbered = []
        for name, value in os.environ.items():
            m = re.fullmatch(r"ANTHROPIC_API_KEY_(\d+)", name)
            if m and value.strip():
                numbered.append((int(m.group(1)), value.strip()))
        numbered.sort()
        keys = [v for _, v in numbered]

    if not keys:
        single = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        if single:
            keys = [single]

    return keys


def pick_claude_client(clients: Sequence[anthropic.Anthropic]) -> anthropic.Anthropic:
    """Pick a random Anthropic client from the pool."""
    if not clients:
        raise ValueError("No Anthropic clients available")
    return random.choice(list(clients))


def process_table_to_html_with_claude(
    claude_clients: Sequence[anthropic.Anthropic],
    image_path: str,
    rate_limiter: RateLimiter,
    model: str = "claude-sonnet-4-20250514",
    max_retries: int = 3,
) -> Optional[str]:
    """
    使用 Claude API 将表格图片转换为 HTML
    """
    if not os.path.exists(image_path):
        logger.error(f"Image file not found: {image_path}")
        return None

    image_data, media_type = encode_image(image_path)

    for attempt in range(1, max_retries + 1):
        try:
            rate_limiter.acquire()
            client = pick_claude_client(claude_clients)
            message = client.messages.create(
                model=model,
                max_tokens=8192,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": image_data,
                                },
                            },
                            {
                                "type": "text",
                                "text": """Please convert this table into HTML format.

Requirements:
1. Preserve the complete structure of the table (header, rows, columns)
2. Use <thead> and <tbody> to distinguish between the header and body of the table
3. If there are merged cells, use colspan and rowspan attributes
4. Preserve the exact format of numbers (including thousand separators, decimal points, etc.)
5. Do not add any CSS styles
6. Output only the HTML code, with no explanation and no markdown code block markers.""",
                            },
                        ],
                    }
                ],
            )

            html_content = message.content[0].text.strip()
            if html_content.startswith("``html"):
                html_content = html_content[7:]
            if html_content.startswith("`"):
                html_content = html_content[3:]
            if html_content.endswith("``"):
                html_content = html_content[:-3]
            return html_content.strip()

        except anthropic.RateLimitError as e:
            wait = 60
            logger.warning(f"[{attempt}/{max_retries}] Rate limit for {image_path}: {e}, waiting {wait}s...")
            if attempt < max_retries:
                time.sleep(wait)
        except Exception as e:
            wait = 5
            logger.error(f"[{attempt}/{max_retries}] Error for {image_path}: {e}, waiting {wait}s...")
            if attempt < max_retries:
                time.sleep(wait)

    logger.error(f"Giving up on {image_path} after {max_retries} attempts")
    return None


def generate_table_summary_with_tencent(
    client: OpenAI,
    html_content: str,
    previous_context: str,
    table_caption: str = "",
    table_footnote: str = "",
    model: str = "deepseek-v3",
    max_retries: int = 3,
) -> Optional[str]:
    """
    生成表格摘要
    """
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

Please output only the descriptive text, without any formatting marks or prefixes. Do not include any conversational text or markdown formatting. Begin with a concrete noun or named entity. Never begin with prefixes like 'Based on', 'The text', 'Given', 'The document', 'The table'.\n\nSummary:"""

    for attempt in range(1, max_retries + 1):
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a professional document analysis assistant, skilled at understanding and summarizing table content. Please describe the table information in accurate language."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                extra_body={"enable_thinking": False},
            )
            return response.choices[0].message.content.strip()

        except Exception as e:
            logger.error(f"[{attempt}/{max_retries}] Error generating table summary: {e}")
            if attempt < max_retries:
                time.sleep(5)

    logger.error(f"Giving up on table summary after {max_retries} attempts")
    return None


def process_single_table(
    claude_clients: Sequence[anthropic.Anthropic],
    tencent_client: OpenAI,
    item: Dict[str, Any],
    idx: int,
    base_image_dir: str,
    previous_context: str,
    rate_limiter: RateLimiter,
    claude_model: str = "claude-sonnet-4-20250514",
    tencent_model: str = "deepseek-v3"
) -> Optional[Dict[str, Any]]:
    """处理单个表格项"""
    img_path = item.get('img_path', '')
    if not img_path:
        logger.warning(f"Table at index {idx} has no img_path, skipping")
        return None
    
    # 根据 content_list.json 中的路径找图片
    if os.path.isabs(img_path):
        full_image_path = img_path
    else:
        full_image_path = os.path.join(base_image_dir, os.path.basename(img_path))
        if not os.path.exists(full_image_path):
            full_image_path = os.path.join(os.path.dirname(base_image_dir), img_path)
    
    if not os.path.exists(full_image_path):
        logger.warning(f"Image not found: {full_image_path}, skipping")
        return None
    
    # Step 1: 使用 Claude 将表格图片转换为 HTML
    html_content = process_table_to_html_with_claude(
        claude_clients, full_image_path, rate_limiter, claude_model
    )
    
    if html_content is None:
        logger.warning(f"Failed to generate HTML for table at index {idx}, skipping")
        return None
    
    # 获取原始 caption 和 footnote
    original_caption = item.get('table_caption', [])
    if isinstance(original_caption, list):
        original_caption = ' '.join(original_caption)

    original_footnote = item.get('table_footnote', [])
    if isinstance(original_footnote, list):
        original_footnote = ' '.join(original_footnote)

    # Step 2: 使用腾讯云生成表格摘要
    summary_text = generate_table_summary_with_tencent(
        tencent_client, html_content, previous_context, original_caption, original_footnote, tencent_model
    )
    if summary_text is None:
        logger.warning(f"Failed to generate summary for table at index {idx}, skipping")
        return None

    # 构建结果字典
    table_dict = {
        'type': 'table',
        'summary': summary_text,
        'content': html_content,
        'page_idx': item.get('page_idx'),
        'original_img_path': img_path,
        'table_caption': item.get('table_caption', []),
        'table_footnote': item.get('table_footnote', []),
        'original_index': idx
    }
    
    logger.info(f"Successfully processed table at index {idx}")
    return table_dict


def find_content_list_json(base_dir: str) -> Optional[str]:
    """在目录中查找 content_list.json 文件"""
    auto_dir = os.path.join(base_dir, "hybrid_auto")
    
    pattern = os.path.join(auto_dir, "*_content_list.json")
    matches = glob.glob(pattern)
    
    if matches:
        return matches[0]
    
    direct_path = os.path.join(auto_dir, "content_list.json")
    if os.path.exists(direct_path):
        return direct_path
    
    return None


def reconstruct_table_chunks(
    input_dir: str,
    output_json_path: Optional[str] = None,
    anthropic_api_key: Optional[str] = None,
    anthropic_api_keys: Optional[Sequence[str]] = None,
    tencent_api_key: Optional[str] = None,
    tencent_base_url: str = "https://api.lkeap.cloud.tencent.com/v1",
    claude_model: str = "claude-sonnet-4-20250514",
    tencent_model: str = "deepseek-v3.2",
    max_workers: int = 5,
    requests_per_minute: int = 50,
    context_window: int = 3,
    save_interval: int = 10
) -> List[Dict[str, Any]]:
    """
    主函数：重建表格 chunks，将图片转换为 HTML 并生成摘要
    
    Args:
        input_dir: 输入目录，包含 /hybrid_auto/*_content_list.json 和 /hybrid_auto/images/
        output_json_path: 输出 JSON 路径（可选，默认在 input_dir 下生成）
        anthropic_api_key: 单个 Anthropic API Key（可选）
        anthropic_api_keys: 多个 Anthropic API Key 列表，每次调用随机选一个
            （可选，默认从环境变量 ANTHROPIC_API_KEYS / ANTHROPIC_API_KEY_N / ANTHROPIC_API_KEY 读取）
        tencent_api_key: 腾讯云 API Key
        tencent_base_url: 腾讯云 API Base URL
        claude_model: Claude 模型名称
        tencent_model: 腾讯云模型名称
        max_workers: 最大并行数
        requests_per_minute: 每分钟最大请求数（速率限制）
        context_window: 上下文窗口大小（取前 N 个 text chunk）
        save_interval: 每处理多少个表格保存一次
    
    Returns:
        处理后的表格 chunks 列表
    """
    logger.info(f"Starting table reconstruction from {input_dir}")
    
    # 查找 content_list.json
    content_list_path = find_content_list_json(input_dir)
    if content_list_path is None:
        raise FileNotFoundError(f"Cannot find *_content_list.json in {input_dir}/hybrid_auto/")
    
    logger.info(f"Found content list: {content_list_path}")
    
    # 确定图片目录
    image_dir = os.path.join(input_dir, "hybrid_auto", "images")
    if not os.path.exists(image_dir):
        logger.warning(f"Image directory not found: {image_dir}, skipping")
        return []
    
    logger.info(f"Image directory: {image_dir}")
    
    # 确定输出路径
    if output_json_path is None:
        dir_name = os.path.basename(input_dir.rstrip('/'))
        output_json_path = os.path.join(input_dir, f"{dir_name}_table_reconstructed.json")
    
    # 初始化 Claude 客户端池（支持多个 API key，每次调用随机选一个）
    api_keys = load_anthropic_api_keys(
        explicit_key=anthropic_api_key,
        explicit_keys=anthropic_api_keys,
    )
    if not api_keys:
        raise ValueError(
            "No Anthropic API keys found. Set ANTHROPIC_API_KEYS (comma-separated), "
            "ANTHROPIC_API_KEY_1/2/..., or ANTHROPIC_API_KEY in .env, "
            "or pass --anthropic-api-keys."
        )
    claude_clients = [anthropic.Anthropic(api_key=k) for k in api_keys]
    logger.info(
        f"Initialized {len(claude_clients)} Anthropic client(s) with model: {claude_model}"
    )
    
    # 初始化腾讯云客户端
    if tencent_api_key is None:
        tencent_api_key = os.environ.get("TENCENT_API_KEY")
    if tencent_api_key is None:
        raise ValueError("tencent_api_key is required (set TENCENT_API_KEY in .env or pass --tencent-api-key)")
    
    tencent_client = OpenAI(api_key=tencent_api_key, base_url=tencent_base_url)
    logger.info(f"Initialized Tencent client with model: {tencent_model}")
    
    # 初始化速率限制器
    rate_limiter = RateLimiter(requests_per_minute=requests_per_minute)
    
    # 读取输入 JSON
    with open(content_list_path, 'r', encoding='utf-8') as f:
        content_list = json.load(f)
    
    logger.info(f"Loaded {len(content_list)} items from input JSON")
    
    # 预处理：为每个表格收集上下文
    table_tasks = []
    previous_text_chunks = []
    
    for idx, item in enumerate(content_list):
        if item.get('type') == 'text':
            text_content = item.get('text', '')
            if text_content:
                previous_text_chunks.append(text_content)
                if len(previous_text_chunks) > context_window:
                    previous_text_chunks.pop(0)
        
        elif item.get('type') == 'table':
            previous_context = '\n\n'.join(previous_text_chunks[-context_window:])
            table_tasks.append((idx, item, previous_context))
    
    logger.info(f"Found {len(table_tasks)} tables to process")
    
    if not table_tasks:
        logger.warning("No tables found in input JSON")
        return []
    
    # 创建输出目录
    output_dir = os.path.dirname(output_json_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    # 恢复已处理结果（断点续传）
    table_chunks = []
    processed_indices = set()
    if os.path.exists(output_json_path):
        with open(output_json_path, 'r', encoding='utf-8') as f:
            table_chunks = json.load(f)
        processed_indices = {chunk['original_index'] for chunk in table_chunks}
        logger.info(f"Resuming: found {len(processed_indices)} already-processed tables")

    # 过滤掉已处理的任务
    table_tasks = [t for t in table_tasks if t[0] not in processed_indices]
    logger.info(f"Remaining tables to process: {len(table_tasks)}")

    if not table_tasks:
        logger.info("All tables already processed, nothing to do")
        return table_chunks

    results_lock = Lock()
    
    def process_task(task):
        idx, item, previous_context = task
        return process_single_table(
            claude_clients, tencent_client, item, idx, image_dir,
            previous_context, rate_limiter, claude_model, tencent_model
        )
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_task, task): task for task in table_tasks}
        
        with tqdm(total=len(table_tasks), desc="Processing tables") as pbar:
            for future in as_completed(futures):
                result = future.result()
                
                if result is not None:
                    with results_lock:
                        table_chunks.append(result)
                        
                        if len(table_chunks) % save_interval == 0:
                            sorted_chunks = sorted(table_chunks, key=lambda x: x.get('original_index', 0))
                            with open(output_json_path, 'w', encoding='utf-8') as f:
                                json.dump(sorted_chunks, f, indent=2, ensure_ascii=False)
                            logger.info(f"Checkpoint: saved {len(table_chunks)} tables")
                
                pbar.update(1)
    
    # 最终保存
    table_chunks = sorted(table_chunks, key=lambda x: x.get('original_index', 0))
    
    with open(output_json_path, 'w', encoding='utf-8') as f:
        json.dump(table_chunks, f, indent=2, ensure_ascii=False)
    
    logger.info(f"Successfully saved {len(table_chunks)} table chunks to {output_json_path}")
    
    return table_chunks


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="使用 Claude API 重建表格 chunks")
    parser.add_argument("input_dir", help="输入目录，包含 /hybrid_auto/*_content_list.json 和 /hybrid_auto/images/")
    parser.add_argument("-o", "--output", help="输出 JSON 路径")
    parser.add_argument("--anthropic-api-key", help="单个 Anthropic API Key（或设置 ANTHROPIC_API_KEY 环境变量）")
    parser.add_argument(
        "--anthropic-api-keys",
        help="多个 Anthropic API Key，逗号分隔；每次调用随机选一个 "
             "（或设置 ANTHROPIC_API_KEYS / ANTHROPIC_API_KEY_1/2/...）",
    )
    parser.add_argument("--tencent-api-key", help="腾讯云 API Key（或设置 TENCENT_API_KEY 环境变量）")
    parser.add_argument("--tencent-base-url", default="https://api.lkeap.cloud.tencent.com/v1", help="腾讯云 API Base URL")
    parser.add_argument("--claude-model", default="claude-sonnet-4-6", help="Claude 模型名称")
    parser.add_argument("--tencent-model", default="deepseek-v4-pro", help="腾讯云模型名称")
    parser.add_argument("-w", "--workers", type=int, default=5, help="最大并行数（默认5）")
    parser.add_argument("--rpm", type=int, default=50, help="每分钟最大请求数（默认50）")
    parser.add_argument("--context-window", type=int, default=3, help="上下文窗口大小（默认3）")
    parser.add_argument("--save-interval", type=int, default=10, help="保存间隔（默认10）")
    
    args = parser.parse_args()
    
    keys_arg = None
    if args.anthropic_api_keys:
        keys_arg = [k.strip() for k in re.split(r"[,\s]+", args.anthropic_api_keys) if k.strip()]

    reconstruct_table_chunks(
        input_dir=args.input_dir,
        output_json_path=args.output,
        anthropic_api_key=args.anthropic_api_key,
        anthropic_api_keys=keys_arg,
        tencent_api_key=args.tencent_api_key,
        tencent_base_url=args.tencent_base_url,
        claude_model=args.claude_model,
        tencent_model=args.tencent_model,
        max_workers=args.workers,
        requests_per_minute=args.rpm,
        context_window=args.context_window,
        save_interval=args.save_interval
    )
