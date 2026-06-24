import json
import os
import argparse
from collections import Counter

# 需要丢弃的辅助/视觉类型
DROP_TYPES = {
    "image", "chart", "table", "seal",
    "page_header", "page_footer", "page_number",
    "page_aside_text", "page_footnote",
}

# 视为正文内容、需要生成 chunk 的类型
CONTENT_TYPES = {
    "paragraph", "list", "index",
    "equation_interline", "code", "algorithm",
}

# 字符数低于该阈值的 chunk 会被向后/向前合并到相邻 chunk
# 合并时使用两者 title_path 的公共前缀作为新的 title_path，
# 而比公共前缀更深的子标题会被以行内 "### Subtitle" 形式保留在 content 中。
MIN_CHARACTER_THRESHOLD = 500


def load_json_file(json_path):
    with open(json_path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_json_file(data, output_path):
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _join_inline(items):
    """v2 中 *_content 普遍是 [{type:text, content:...}, ...] 形式。"""
    if not items:
        return ""
    parts = []
    for it in items:
        if isinstance(it, dict):
            c = it.get("content", "")
            if isinstance(c, str):
                parts.append(c)
        elif isinstance(it, str):
            parts.append(it)
    return " ".join(p.strip() for p in parts if p and p.strip()).strip()


def extract_title_text(item):
    content = item.get("content", {}) or {}
    return _join_inline(content.get("title_content", []))


def extract_title_level(item):
    content = item.get("content", {}) or {}
    lv = content.get("level")
    try:
        return int(lv) if lv is not None else 1
    except (TypeError, ValueError):
        return 1


def extract_content_text(item):
    """从 v2 的非标题内容块里抽取纯文本。"""
    t = item.get("type")
    content = item.get("content", {}) or {}

    if t == "paragraph":
        return _join_inline(content.get("paragraph_content", []))

    if t in ("list", "index"):
        items = content.get("list_items", []) or []
        lines = []
        for li in items:
            txt = _join_inline(li.get("item_content", []))
            if txt:
                lines.append(f"- {txt}")
        return "\n".join(lines)

    if t == "equation_interline":
        math = content.get("math_content", "")
        return math if isinstance(math, str) else ""

    if t == "code":
        body_raw = content.get("code_content", "")
        body = _join_inline(body_raw) if isinstance(body_raw, list) else (body_raw if isinstance(body_raw, str) else str(body_raw or ""))
        caption = _join_inline(content.get("code_caption", []))
        footnote = _join_inline(content.get("code_footnote", []))
        return "\n".join(x for x in [caption, body, footnote] if x)

    if t == "algorithm":
        body_raw = content.get("algorithm_content", "")
        body = _join_inline(body_raw) if isinstance(body_raw, list) else (body_raw if isinstance(body_raw, str) else str(body_raw or ""))
        caption = _join_inline(content.get("algorithm_caption", []))
        footnote = _join_inline(content.get("algorithm_footnote", []))
        return "\n".join(x for x in [caption, body, footnote] if x)

    return ""


def build_chunks_from_v2(data, initial_pairs=None):
    """遍历 v2 结构，维护标题栈，输出带 title_path 的 chunk 列表。

    data: list[list[item]]，外层按页分组。
    initial_pairs: 作为所有 chunk title_path 前缀的初始 (level, text) 对
        列表（例如公司名 + 文件名）。它不参与标题堆栈的 push/pop，
        不会被后续出现的同级/更深标题顶出。
    """
    initial_pairs = list(initial_pairs or [])
    title_stack = []  # 元素: (level:int, text:str)
    chunks = []

    for page_idx, page in enumerate(data):
        if not isinstance(page, list):
            continue
        for item in page:
            if not isinstance(item, dict):
                continue
            t = item.get("type")

            if t in DROP_TYPES:
                continue

            if t == "title":
                level = extract_title_level(item)
                text = extract_title_text(item)
                # 弹出同级或更深层的标题，再入栈
                while title_stack and title_stack[-1][0] >= level:
                    title_stack.pop()
                title_stack.append((level, text))
                continue

            if t in CONTENT_TYPES:
                text = extract_content_text(item)
                if not text:
                    continue
                # 内部使用 (level, text) 保留原始标题层级，
                # 便于后续合并时生成与原文一致的标题前缀。
                title_path_pairs = list(initial_pairs) + [(lv, tt) for lv, tt in title_stack]
                chunks.append({
                    "title_path_pairs": title_path_pairs,
                    "content": text,
                    "page_number": page_idx,
                    "type": "text",
                })
            # 其他未知类型默认忽略

    return chunks


def _common_prefix(a, b):
    out = []
    for x, y in zip(a, b):
        if x == y:
            out.append(x)
        else:
            break
    return out


def _segment_text(extra_pairs, text):
    """以原始标题 level 的 markdown 头 ("#"*level) 插入深层子标题。

    extra_pairs: list[(level:int, text:str)]。多个子标题各自一行，
    避免丢失层级信息。
    """
    headers = []
    for lv, tt in extra_pairs:
        if not tt:
            continue
        try:
            n = max(1, int(lv))
        except (TypeError, ValueError):
            n = 3
        headers.append(f"{'#' * n} {tt}")
    if headers:
        return "\n".join(headers) + "\n" + text
    return text


def _flush_window(window, out):
    """把一段连续的短 chunk 作为一个 title-merge 窗口刷出。

    每个 chunk 仍然作为独立 entry 写入，只是：
      * title_path 被改成窗口内所有 chunk 的 LCA；
      * 比 LCA 更深的子标题以 "#"*level header 形式插入到该 chunk 自己的 content 头部。
    """
    if not window:
        return
    # 计算窗口共同前缀（基于 (level, text) 对的相等性）
    lca = list(window[0]["title_path_pairs"])
    for c in window[1:]:
        lca = _common_prefix(lca, c["title_path_pairs"])
        if not lca:
            break

    for c in window:
        deeper = c["title_path_pairs"][len(lca):]
        new_content = _segment_text(deeper, c["content"]) if deeper else c["content"]
        out.append({
            "title_path_pairs": list(lca),
            "content": new_content,
            "page_number": c.get("page_number", 0),
            "type": "text",
        })


def merge_short_units_by_chars(chunks, min_chars=MIN_CHARACTER_THRESHOLD):
    """字符阈值驱动的跨标题 *title_path 合并*（保留原始 chunk 条目）。

    规则：
    - 顺序扫描 chunk；如果当前 chunk 本身 ≥ min_chars，先刷出当前窗口，再
      原样保留该长 chunk（title_path 不动）。
    - 否则把它加入当前窗口。窗口里所有 chunk 共享一个 LCA 作为新的
      title_path；比 LCA 更深的子标题以 "#"*level header 的形式插入各自
      content 的开头。
    - 当窗口内累积字符数 ≥ min_chars，刷出窗口（每个 chunk 仍是独立 entry）。
      尾部不足阈值的窗口在结束时一次性刷出。
    """
    out = []
    window = []
    window_chars = 0

    for c in chunks:
        pairs = list(c.get("title_path_pairs", []))
        text = c.get("content", "") or ""
        if not text.strip():
            continue

        # 长 chunk 独立输出，不参与窗口合并
        if len(text) >= min_chars:
            _flush_window(window, out)
            window, window_chars = [], 0
            out.append({
                "title_path_pairs": pairs,
                "content": text,
                "page_number": c.get("page_number", 0),
                "type": "text",
            })
            continue

        window.append({
            "title_path_pairs": pairs,
            "content": text,
            "page_number": c.get("page_number", 0),
        })
        window_chars += len(text)

        if window_chars >= min_chars:
            _flush_window(window, out)
            window, window_chars = [], 0

    _flush_window(window, out)
    return out


def process_json_file(json_path, output_base_dir, skip_image_chunks=True, company_name=None):
    """读取 *_content_list_v2.json，输出 base.json。

    skip_image_chunks 参数保留以兼容旧 pipeline，本版本始终跳过图片/表格。
    """
    input_filename = os.path.basename(json_path)
    input_filename = os.path.splitext(input_filename)[0]
    # 去掉 v2/v1 文件名后缀
    for suffix in ("_content_list_v2", "_content_list"):
        if input_filename.endswith(suffix):
            input_filename = input_filename[: -len(suffix)]
            break

    output_dir = os.path.join(output_base_dir, input_filename.replace(" ", "_"))
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "base.json")

    print(f"Loading JSON file from: {json_path}")
    data = load_json_file(json_path)

    # 兼容性：若传入的是 v1 (扁平 list[dict])，提示并按页分桶
    if data and isinstance(data, list) and isinstance(data[0], dict):
        print("[WARN] Input looks like v1 content_list (flat). "
              "Recommend feeding *_content_list_v2.json instead.")
        # 简单按 page_idx 分页以复用 v2 处理路径是不安全的（字段不同），直接退出
        raise ValueError(
            "step2_mineru2base.py 现在仅支持 *_content_list_v2.json，"
            "请改传 v2 文件。"
        )

    # 元数据头：与原版保持一致
    date_str = input_filename[:8] if len(input_filename) >= 8 else ""
    if date_str.isdigit():
        date_published = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    else:
        date_published = ""

    output = [{
        "start": 0,
        "end": 10000,
        "date_published": date_published,
    }]

    # 初始 title_path 前缀：公司名 + 文件名（作为所有 chunk 的公共祖先）
    initial_pairs = []
    if company_name:
        initial_pairs.append((1, company_name))
    if input_filename:
        initial_pairs.append((2, input_filename))

    # 1) 抽取 chunk + 维护标题栈
    chunks = build_chunks_from_v2(data, initial_pairs=initial_pairs)
    print(f"Extracted {len(chunks)} content chunks before merging.")

    # 2) 字符阈值驱动的跨标题合并（保留子标题为行内 header）
    chunks = merge_short_units_by_chars(chunks, MIN_CHARACTER_THRESHOLD)
    final_groups = Counter(tuple(tt for _, tt in c.get("title_path_pairs", [])) for c in chunks)
    print(
        f"After char-threshold merging (>= {MIN_CHARACTER_THRESHOLD} chars): "
        f"{len(chunks)} chunks across {len(final_groups)} title groups."
    )

    # 3) 落盘：将内部的 (level, text) 对展平为纯文本 title_path
    for c in chunks:
        pairs = c.get("title_path_pairs", [])
        title_path = [tt for _, tt in pairs if tt]
        title_str = " > ".join([t for t in title_path if t]).strip()
        output.append({
            "id": len(output),
            "content": c["content"],
            "page_number": c["page_number"],
            "title": title_str,
            "title_path": title_path,
            "type": c["type"],
        })

    save_json_file(output, output_path)
    print(f"Final output saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Convert MinerU *_content_list_v2.json into base.json chunks."
    )
    parser.add_argument("input_path", help="Path to *_content_list_v2.json")
    parser.add_argument("output_base_dir", help="Base directory for output")
    parser.add_argument(
        "--skip-image-chunks",
        action="store_true",
        help="(Deprecated) v2 pipeline always skips image/table chunks.",
    )
    parser.add_argument(
        "--company-name",
        default=None,
        help="公司名。当某个 chunk 合并后 title_path 为空时，"
             "会以 [company_name, filename] 作为默认 title_path。",
    )

    args = parser.parse_args()

    try:
        process_json_file(
            args.input_path,
            args.output_base_dir,
            skip_image_chunks=args.skip_image_chunks,
            company_name=args.company_name,
        )
        print(f"Successfully processed {os.path.basename(args.input_path)}")
    except Exception as e:
        print(f"Error processing {args.input_path}: {str(e)}")
        raise


if __name__ == "__main__":
    main()
