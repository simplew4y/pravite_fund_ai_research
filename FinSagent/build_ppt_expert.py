#!/usr/bin/env python3
"""
Build 金融检索专家路由系统 PPT.
Reuses infrastructure from build_ppt.py.
"""

from build_ppt import (
    E, SE, _ns, xml_bytes, inches, pt_to_emu,
    C, NS, SLIDE_W, SLIDE_H, FONT_MAIN, FONT_CODE,
    _sp_tree, _shape_id, next_id,
    _make_run, _make_para,
    add_textbox, add_rect, add_line, add_card, add_table,
    add_big_number, set_slide_bg, add_page_header, add_footer,
    build_theme,
    register_namespace,
)
import zipfile, os


# ── Slide builders ────────────────────────────────────────────────────────────

def build_slide_cover():
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["navy"])
    tree = _sp_tree()
    cSld.append(tree)

    add_textbox(tree, inches(0.6), inches(0.7), inches(8.8), inches(1.5),
        [_make_para([_make_run("金融检索专家路由系统", sz=4400, bold=True,
                               color=C["navyText"])], spc_after=400),
         _make_para([_make_run("SEC Filing Retrieval · Expert Routing Architecture",
                               sz=1600, color=C["navyDim"])])])

    add_line(tree, inches(0.6), inches(2.5), inches(4.0), inches(2.5), C["navyDim"], w=9525)

    add_textbox(tree, inches(0.6), inches(2.7), inches(5.0), inches(0.5),
        [_make_para([_make_run("FinSagent · DCI-PageIndex Backend · 2026-05",
                               sz=1100, color=C["navyDim"])])])

    # 7 experts listed on the right
    experts = [
        ("1", "Earnings Release", C["success"]),
        ("2", "H20 Export Control", C["fail"]),
        ("3", "Proxy Governance", C["amber"]),
        ("4", "Annual Performance", C["success"]),
        ("5", "Quarterly Trend", C["baseline"]),
        ("6", "No-PageIndex Fallback", C["amber"]),
        ("7", "Critical Evidence", C["fail"]),
    ]
    for i, (num, name, color) in enumerate(experts):
        y = inches(1.0) + i * inches(0.55)
        add_textbox(tree, inches(5.8), y, inches(3.6), inches(0.45),
            [_make_para([
                _make_run(f"{num}  ", sz=1400, bold=True, color=color),
                _make_run(name, sz=1100, color=C["navyText"]),
            ])])

    # Core quote
    add_textbox(tree, inches(0.6), inches(4.6), inches(8.8), inches(0.6),
        [_make_para([_make_run("先判断问题属于哪种披露场景，再选择最可能承载答案的 SEC 文件组合",
                               sz=1100, bold=True, color=C["navyDim"])], align="ctr")])

    add_footer(tree, "金融检索专家路由系统", "__PAGE__", color=C["navyDim"])
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


# ── DCI Grep System Design Slides (inserted after cover) ─────────────────────

def build_slide_system_overview():
    """Slide: DCI-PageIndex 系统全景 — query → plan → route → loop → evidence."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "DCI-PageIndex 检索系统全景",
                    "LLM as Agent：循环调用 4 个工具在 SEC 语料库中搜证据，不走 embedding / 不走 reranker")

    # ── Six-stage pipeline ──
    stages = [
        ("Query\nPlanning",    C["white"], C["ink"],       inches(0.3),  inches(1.3)),
        ("Route\nAugment",     C["white"], C["success"],   inches(1.85), inches(1.3)),
        ("Agent\nLoop ≤12t",   C["white"], C["fail"],      inches(3.4),  inches(1.3)),
        ("Evidence\nParsing",  C["white"], C["amber"],     inches(4.95), inches(1.3)),
        ("Critical\nSupplement", C["white"], C["baseline"], inches(6.5),  inches(1.3)),
        ("Diversity\nSort",    C["success"], C["successBg"], inches(8.05), inches(1.3)),
    ]
    stage_y = inches(1.5)
    stage_h = inches(0.75)

    for label, text_c, bg_c, x, w in stages:
        add_rect(tree, x, stage_y, w, stage_h, bg_c)
        add_textbox(tree, x, stage_y + inches(0.05), w, stage_h,
            [_make_para([_make_run(label, sz=900, bold=True, color=text_c)], align="ctr")])

    # Arrows between stages
    for x in [inches(1.65), inches(3.2), inches(4.75), inches(6.3), inches(7.85)]:
        add_textbox(tree, x, stage_y + inches(0.12), inches(0.2), inches(0.5),
            [_make_para([_make_run("→", sz=1100, color=C["muted"])], align="ctr")])

    # ── Left: 2-step design principle ──
    add_textbox(tree, inches(0.3), inches(2.55), inches(4.5), inches(0.3),
        [_make_para([_make_run("核心设计原则", sz=1100, bold=True, color=C["ink"])])])

    principles = [
        ("两步分离", "Step 1 只做 query → 结构化 plan；Step 2 拿 plan 去搜。小模型专注单任务表现远优于边想边搜",
         C["success"]),
        ("Manifest-first 路由", "Agent 第一轮即调 read_manifest 缩小 filing 范围 → 第二轮 ripgrep 精搜 → 第三轮 read_file 取完整 chunk",
         C["amber"]),
        ("三层兜底", "wrap-up nudge 提醒 → critical filing 自动补证 → filing diversity 排序避免单文件独占 top-k",
         C["fail"]),
    ]
    for i, (title, desc, color) in enumerate(principles):
        y = inches(2.9) + i * inches(0.65)
        add_rect(tree, inches(0.3), y, inches(0.06), inches(0.55), color)
        add_textbox(tree, inches(0.5), y, inches(4.3), inches(0.55),
            [_make_para([_make_run(title, sz=1000, bold=True, color=color)], spc_after=80),
             _make_para([_make_run(desc, sz=850, color=C["inkSoft"])])])

    # ── Right: key numbers ──
    add_rect(tree, inches(5.1), inches(2.55), inches(4.5), inches(2.4), C["ruleSoft"])
    add_textbox(tree, inches(5.25), inches(2.6), inches(4.2), inches(0.3),
        [_make_para([_make_run("关键参数", sz=1050, bold=True, color=C["ink"])])])

    params = [
        ("max_turns", "12", "Agent 最大工具调用轮数"),
        ("top_k", "5", "最终返回 evidence 数量"),
        ("tools", "4", "read_manifest / read_pageindex / ripgrep / read_file"),
        ("filings", "15+", "NVIDIA SEC 语料库文件数"),
        ("rg timeout", "20s", "单次 ripgrep 超时"),
        ("output", "EVIDENCE_START…END", "结构化证据输出格式"),
    ]
    for i, (key, val, note) in enumerate(params):
        y = inches(2.95) + i * inches(0.32)
        add_textbox(tree, inches(5.3), y, inches(4.1), inches(0.3),
            [_make_para([
                _make_run(f"{key}: ", sz=900, bold=True, color=C["ink"], font=FONT_CODE),
                _make_run(val, sz=950, bold=True, color=C["success"], font=FONT_CODE),
                _make_run(f"  {note}", sz=850, color=C["muted"]),
            ])])

    add_footer(tree, "金融检索专家路由系统", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_corpus():
    """Slide: 三层语料库 + Manifest 元数据增强."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "三层语料库与 Manifest 元数据",
                    "pageindex → 导航树，markdown → 全文，tables → 数字表格")

    # ── Left: corpus tree diagram ──
    add_textbox(tree, inches(0.4), inches(1.45), inches(4.0), inches(0.3),
        [_make_para([_make_run("语料库目录结构", sz=1100, bold=True, color=C["ink"])])])

    add_rect(tree, inches(0.4), inches(1.8), inches(4.5), inches(2.9), C["navy"])
    tree_lines = [
        ("dci_corpus_pageindex/",            C["navyText"], False),
        ("├── manifest.json",                C["navyText"], False),
        ("│   ↳ filing_id, form_type, ...",  C["navyDim"],  True),
        ("│   ↳ reported_fiscal_period ★",   C["navyDim"],  True),
        ("│   ↳ event_tags, search_aliases ★", C["navyDim"], True),
        ("├── pageindex/",                   C["navyText"], False),
        ("│   └── <fid>_structure.json",     C["navyText"], False),
        ("│       ↳ section tree (title, node_id, range)", C["navyDim"], True),
        ("├── markdown/",                    C["navyText"], False),
        ("│   └── <fid>.md",                 C["navyText"], False),
        ("│       ↳ MinerU OCR 全文",        C["navyDim"],  True),
        ("└── tables/",                      C["navyText"], False),
        ("    └── <fid>_tables.json",        C["navyText"], False),
        ("        ↳ HTML 重建表格 (数字)",    C["navyDim"],  True),
    ]
    tree_paras = []
    for line, color, is_note in tree_lines:
        sz = 800 if is_note else 880
        tree_paras.append(_make_para([_make_run(line, sz=sz, color=color, font=FONT_CODE)], spc_after=60))
    add_textbox(tree, inches(0.55), inches(1.88), inches(4.2), inches(2.7), tree_paras)

    # ── Right: Manifest enrichment ──
    add_textbox(tree, inches(5.2), inches(1.45), inches(4.5), inches(0.3),
        [_make_para([_make_run("Manifest 元数据增强（★ 为新增字段）", sz=1100, bold=True, color=C["ink"])])])

    # Original vs enriched fields
    fields = [
        ("基础字段",  [
            "filing_id · form_type · filed_date",
            "fiscal_period · period_of_report",
            "has_pageindex · has_markdown · has_tables",
        ], C["baseline"], C["baselineBg"]),
        ("增强字段 ★", [
            "reported_fiscal_period — 8-K 报告的实际季度",
            "is_earnings_release — 是否为 earnings 8-K",
            "event_tags — [earnings, h20, proxy, ...]",
            "search_aliases — 替代搜索词列表",
        ], C["success"], C["successBg"]),
    ]

    y = inches(1.8)
    for title, items, bar_c, bg_c in fields:
        h = inches(0.35 + 0.28 * len(items))
        add_rect(tree, inches(5.2), y, inches(0.06), h, bar_c)
        add_rect(tree, inches(5.26), y, inches(4.34), h, bg_c)
        paras = [_make_para([_make_run(title, sz=1000, bold=True, color=bar_c)], spc_after=120)]
        for item in items:
            paras.append(_make_para([_make_run(item, sz=880, color=C["ink"], font=FONT_CODE)], spc_after=80))
        add_textbox(tree, inches(5.35), y + inches(0.05), inches(4.15), h - inches(0.1), paras)
        y += h + inches(0.12)

    # Filing example
    add_rect(tree, inches(5.2), y, inches(4.4), inches(0.9), C["navy"])
    ex_lines = [
        ("// 20250528_8-K manifest 示例", C["navyDim"]),
        ('reported_fiscal_period: "FY2026 Q1"', C["navyText"]),
        ('event_tags: ["earnings_release","h20","non_gaap"]', C["navyText"]),
        ('search_aliases: ["Q1 press release","H20 export"]', C["navyText"]),
    ]
    ex_paras = []
    for line, color in ex_lines:
        ex_paras.append(_make_para([_make_run(line, sz=850, color=color, font=FONT_CODE)], spc_after=70))
    add_textbox(tree, inches(5.35), y + inches(0.05), inches(4.15), inches(0.8), ex_paras)

    add_footer(tree, "金融检索专家路由系统", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_four_tools():
    """Slide: 四个 Agent 工具详解."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "四个 Agent 工具",
                    "LLM Agent 通过 tool_choice=auto 自主决定调用顺序和参数")

    tools = [
        ("read_manifest", "路由起点",
         "过滤 form_type / fiscal_period / year / event_tag\n返回候选 filing 列表（≤12000字符）",
         "form_type, fiscal_period,\nyear, event_tag, fields",
         C["success"], C["successBg"]),
        ("read_pageindex", "导航地图",
         "返回 filing 的章节树结构\n(title, node_id, start/end index)\n无 pageindex 时提示改用 ripgrep",
         "filing_id, max_depth,\ninclude_summary",
         C["amber"], C["amberBg"]),
        ("ripgrep", "关键字精搜",
         "正则/关键词搜索 markdown + tables\n含 / 的 glob 自动下沉目录前缀\nmax_count 限制命中，输出≤8000字符",
         "pattern, glob,\nmax_count, context_lines",
         C["fail"], C["failBg"]),
        ("read_file", "取完整 chunk",
         "按 start_line + limit 读取文件片段\n路径遍历防护（拒绝 .. 和绝对路径）\n支持 symlink，输出≤8000字符",
         "path, start_line,\nlimit (≤500)",
         C["baseline"], C["baselineBg"]),
    ]

    card_w = inches(4.55)
    card_h = inches(1.62)
    gap_x = inches(0.2)
    gap_y = inches(0.15)
    x1 = inches(0.3)
    x2 = x1 + card_w + gap_x
    y1 = inches(1.5)
    y2 = y1 + card_h + gap_y

    positions = [(x1, y1), (x2, y1), (x1, y2), (x2, y2)]

    for i, (name, role, desc, params, bar_c, bg_c) in enumerate(tools):
        x, y = positions[i]

        # Background card
        add_rect(tree, x, y, card_w, card_h, bg_c)
        # Left color bar
        add_rect(tree, x, y, inches(0.06), card_h, bar_c)

        # Tool name + role
        add_textbox(tree, x + inches(0.15), y + inches(0.06), card_w - inches(0.25), inches(0.35),
            [_make_para([
                _make_run(name, sz=1050, bold=True, color=bar_c, font=FONT_CODE),
                _make_run(f"  — {role}", sz=950, color=C["inkSoft"]),
            ])])

        # Description
        desc_lines = desc.split("\n")
        desc_paras = []
        for dl in desc_lines:
            desc_paras.append(_make_para([_make_run(dl, sz=880, color=C["ink"])], spc_after=60))
        add_textbox(tree, x + inches(0.15), y + inches(0.42), card_w - inches(0.25), inches(0.75),
                    desc_paras)

        # Params in a subtle box at bottom
        add_rect(tree, x + inches(0.12), y + card_h - inches(0.4), card_w - inches(0.24), inches(0.32),
                 C["navy"])
        param_lines = params.split("\n")
        pp = []
        for pl in param_lines:
            pp.append(_make_para([_make_run(pl, sz=800, color=C["navyText"], font=FONT_CODE)], spc_after=30))
        add_textbox(tree, x + inches(0.2), y + card_h - inches(0.38),
                    card_w - inches(0.4), inches(0.3), pp)

    add_footer(tree, "金融检索专家路由系统", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_agent_loop():
    """Slide: Agent 循环 + Evidence 管线."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "Agent 循环与 Evidence 管线",
                    "12 轮工具调用 → EVIDENCE 块输出 → 补证 → 多样性排序")

    # ── Left: Agent loop stages ──
    add_textbox(tree, inches(0.3), inches(1.45), inches(4.8), inches(0.3),
        [_make_para([_make_run("Agent Loop（最多 12 轮）", sz=1100, bold=True, color=C["ink"])])])

    loop_steps = [
        ("Turn 1–8", "tool_choice=auto",
         "LLM 自主选择工具 → dispatch → 注入 tool result → 下一轮",
         C["success"]),
        ("Turn 9–10", "wrap-up nudge",
         "检查未探索的 form_type 和未访问的 critical_filing → 注入提醒消息",
         C["amber"]),
        ("Turn 11", "budget warning",
         "\"Turn budget running low, output EVIDENCE unless zero evidence collected\"",
         C["amber"]),
        ("Turn 12", "tool_choice=none",
         "强制禁止工具调用 → LLM 只能输出 EVIDENCE 块",
         C["fail"]),
    ]

    y = inches(1.8)
    for turn_label, mode, desc, color in loop_steps:
        add_rect(tree, inches(0.3), y, inches(0.06), inches(0.6), color)
        add_rect(tree, inches(0.36), y, inches(4.7), inches(0.6), C["ruleSoft"])
        add_textbox(tree, inches(0.5), y + inches(0.03), inches(4.5), inches(0.55),
            [_make_para([
                _make_run(turn_label, sz=950, bold=True, color=C["ink"]),
                _make_run(f"  {mode}", sz=900, bold=True, color=color, font=FONT_CODE),
            ], spc_after=80),
             _make_para([_make_run(desc, sz=850, color=C["inkSoft"])])])
        y += inches(0.68)

    # ── Right: Post-loop pipeline ──
    add_textbox(tree, inches(5.4), inches(1.45), inches(4.3), inches(0.3),
        [_make_para([_make_run("后处理管线（Agent 结束后）", sz=1100, bold=True, color=C["ink"])])])

    pipeline = [
        ("① _parse_evidence", "解析 EVIDENCE_START…END 块",
         "正则抓取 date_published + doc_id + content\n截到 top_k=5 条",
         C["baseline"]),
        ("② _supplement_critical", "关键 Filing 自动补证",
         "对比 critical_filings 与 evidence 覆盖\n缺失 → grep markdown/tables → 注入 score=0.95",
         C["fail"]),
        ("③ _limit_with_diversity", "Filing Diversity 排序",
         "第一轮：每个 critical filing 取 1 chunk\n第二轮：按发现顺序补满 top_k",
         C["success"]),
    ]

    y = inches(1.8)
    for title, subtitle, desc, color in pipeline:
        h = inches(0.95)
        add_rect(tree, inches(5.4), y, inches(4.3), h, C["navy"])
        desc_lines = desc.split("\n")
        dp = [_make_para([_make_run(title, sz=1000, bold=True, color=color, font=FONT_CODE)], spc_after=60),
              _make_para([_make_run(subtitle, sz=900, color=C["navyDim"])], spc_after=80)]
        for dl in desc_lines:
            dp.append(_make_para([_make_run(dl, sz=850, color=C["navyText"], font=FONT_CODE)], spc_after=40))
        add_textbox(tree, inches(5.55), y + inches(0.06), inches(4.0), h - inches(0.12), dp)
        y += h + inches(0.08)

    add_footer(tree, "金融检索专家路由系统", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_architecture():
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "核心架构：Expert Router",
                    "每位专家不负责回答问题，只负责回答 \"去哪些文件找、先查什么、怎么兜底\"")

    # Flow: Question → Router → Experts → Retrieval Plan
    flow_y = inches(1.55)
    flow_h = inches(0.5)
    flow_items = [
        ("用户问题", C["ink"], C["ruleSoft"], inches(0.5), inches(1.5)),
        ("Expert Router", C["white"], C["ink"], inches(2.3), inches(1.6)),
        ("专家路径", C["white"], C["success"], inches(4.2), inches(1.5)),
        ("检索计划", C["white"], C["navy"], inches(6.0), inches(1.5)),
        ("Evidence", C["success"], C["successBg"], inches(7.8), inches(1.5)),
    ]
    for label, text_c, bg_c, x, w in flow_items:
        add_rect(tree, x, flow_y, w, flow_h, bg_c)
        add_textbox(tree, x, flow_y + inches(0.05), w, flow_h,
            [_make_para([_make_run(label, sz=1050, bold=True, color=text_c)], align="ctr")])

    # Arrows
    for x in [inches(2.05), inches(3.95), inches(5.75), inches(7.55)]:
        add_textbox(tree, x, flow_y + inches(0.05), inches(0.25), flow_h,
            [_make_para([_make_run("→", sz=1200, color=C["muted"])], align="ctr")])

    # 7 experts in compact grid
    add_textbox(tree, inches(0.5), inches(2.3), inches(9.0), inches(0.3),
        [_make_para([_make_run("七类金融检索专家", sz=1200, bold=True, color=C["ink"])])])

    experts = [
        ("Earnings Release", "季度业绩、EPS、non-GAAP、guidance", C["success"], C["successBg"]),
        ("H20 Export Control", "H20、中国市场、出口许可、gross margin", C["fail"], C["failBg"]),
        ("Proxy Governance", "股东提案、董事会建议、投票", C["amber"], C["amberBg"]),
        ("Annual Performance", "年度收入、10-K、增长规模", C["success"], C["successBg"]),
        ("Quarterly Trend", "Q1-Q3 趋势、跨季度对比", C["baseline"], C["baselineBg"]),
        ("No-PageIndex Fallback", "无索引文件兜底检索", C["amber"], C["amberBg"]),
        ("Critical Evidence", "路由后覆盖检查 + 自动补证", C["fail"], C["failBg"]),
    ]

    # 4 + 3 layout
    card_w = inches(2.12)
    card_h = inches(0.82)
    gap = inches(0.08)
    y1 = inches(2.65)
    y2 = y1 + card_h + gap

    for i, (name, desc, bar_c, bg_c) in enumerate(experts):
        if i < 4:
            x = inches(0.5) + i * (card_w + gap)
            y = y1
        else:
            x = inches(0.5) + (i - 4) * (card_w + gap)
            y = y2
        add_card(tree, x, y, card_w, card_h, bar_c, bg_c,
                 name, desc, title_sz=950, body_sz=850)

    # Output format
    add_rect(tree, inches(0.5), inches(4.5), inches(9.0), inches(0.65), C["navy"])
    add_textbox(tree, inches(0.65), inches(4.53), inches(8.7), inches(0.6),
        [_make_para([
            _make_run("统一输出：", sz=1000, bold=True, color=C["navyDim"], font=FONT_CODE),
            _make_run('  { expert_paths, critical_filings, search_terms, fallback_searches, facts_to_extract }',
                      sz=950, color=C["navyText"], font=FONT_CODE),
        ])])

    add_footer(tree, "金融检索专家路由系统", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def _expert_detail_slide(title, subtitle,
                         left_name, left_color, left_bg, left_desc, left_logic, left_files,
                         right_name, right_color, right_bg, right_desc, right_logic, right_files):
    """Build a two-column expert detail slide."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, title, subtitle)

    x_left = inches(0.5)
    x_right = inches(5.15)
    w_col = inches(4.35)

    for side, (name, color, bg, desc, logic, files) in enumerate([
        (left_name, left_color, left_bg, left_desc, left_logic, left_files),
        (right_name, right_color, right_bg, right_desc, right_logic, right_files),
    ]):
        x = x_left if side == 0 else x_right

        # Header bar
        add_rect(tree, x, inches(1.45), w_col, inches(0.08), color)
        add_textbox(tree, x, inches(1.55), w_col, inches(0.35),
            [_make_para([_make_run(name, sz=1200, bold=True, color=color)])])

        # Description
        add_rect(tree, x, inches(1.95), w_col, inches(0.45), bg)
        add_textbox(tree, x + inches(0.12), inches(1.98), w_col - inches(0.24), inches(0.4),
            [_make_para([_make_run(desc, sz=950, color=C["ink"])])])

        # Logic steps
        add_card(tree, x, inches(2.5), w_col, inches(1.7),
                 color, bg, "核心逻辑", logic,
                 title_sz=1000, body_sz=880, title_color=color)

        # Files
        add_rect(tree, x, inches(4.35), w_col, inches(0.7), C["navy"])
        file_paras = [_make_para([_make_run("典型文件", sz=900, bold=True,
                                            color=C["navyDim"], font=FONT_CODE)], spc_after=150)]
        for f in files:
            file_paras.append(_make_para([_make_run(f, sz=900, color=C["navyText"], font=FONT_CODE)],
                                         spc_after=80))
        add_textbox(tree, x + inches(0.12), inches(4.38), w_col - inches(0.24), inches(0.65),
                    file_paras)

    add_footer(tree, "金融检索专家路由系统", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_earnings_h20():
    return _expert_detail_slide(
        "Earnings Release + H20 Export Control",
        "季度业绩路由 + H20 跨文件事件路由",
        # Left
        "Earnings Release Expert", C["success"], C["successBg"],
        "季度业绩问题不能只看 10-Q — earnings 8-K 包含 non-GAAP、guidance、outlook",
        [
            "1. 识别季度 → 找对应 10-Q + earnings 8-K",
            "2. GAAP 数字 → 优先 10-Q tables",
            "3. non-GAAP / guidance → 优先 8-K markdown",
            "4. 注意 8-K filing date 晚于 quarter end",
            "5. 无 pageindex 时直接 grep",
        ],
        ["FY2026 Q1: 20250427_10-Q + 20250528_8-K",
         "FY2026 Q2: 20250727_10-Q + 20250827_8-K",
         "FY2026 Q3: 20251026_10-Q + 20251119_8-K"],
        # Right
        "H20 Export Control Expert", C["fail"], C["failBg"],
        "H20 是跨文件事件 — 需要同时看事件首披、季报、earnings release",
        [
            "1. 事件首次披露 → 20250409_8-K",
            "2. Q1 影响 → 10-Q + earnings 8-K",
            "3. 毛利率剔除 → earnings 8-K",
            "4. Q2 中国市场变化 → Q2 10-Q + 8-K",
            "5. grep: H20.*China, unable to ship",
        ],
        ["20250409_8-K  (首次披露)",
         "20250427_10-Q + 20250528_8-K  (Q1)",
         "20250727_10-Q + 20250827_8-K  (Q2)"],
    )


def build_slide_proxy_annual():
    return _expert_detail_slide(
        "Proxy Governance + Annual Performance",
        "公司治理投票路由 + 年度经营表现路由",
        # Left
        "Proxy Governance Expert", C["amber"], C["amberBg"],
        "Proxy 问题不能只看 DEF14A — DEFA14A 补充材料可能没有 pageindex 但同样关键",
        [
            "1. 股东提案 / 董事会建议 → DEF14A",
            "2. 同时查 DEFA14A (即使无 pageindex)",
            "3. 初稿 / 变化 → PRE14A",
            "4. 同时找 proposal title + board recommendation",
            "5. grep: Proposal 5|6|7, Board Recommends",
        ],
        ["20250513_DEF14A",
         "20250604_DEFA14A  (无 pageindex)",
         "20250425_PRE14A"],
        # Right
        "Annual Performance Expert", C["success"], C["successBg"],
        "年度表现主证据是 10-K，但 annual 8-K 和 proxy summary 也提供候选证据",
        [
            "1. 年度数字 → 10-K income statement",
            "2. 增长规模 → MD&A summary tables",
            "3. 新闻稿口径 → annual results 8-K",
            "4. 公司叙事 → proxy DEF14A summary",
            "5. 数字问题优先读 tables",
        ],
        ["20250126_10-K  (年度报告)",
         "20250226_8-K  (年度 earnings)",
         "20250513_DEF14A  (proxy summary)"],
    )


def build_slide_trend_fallback():
    return _expert_detail_slide(
        "Quarterly Trend + No-PageIndex Fallback",
        "跨季度趋势分析路由 + 无索引文件兜底路由",
        # Left
        "Quarterly Trend Expert", C["baseline"], C["baselineBg"],
        "多季度趋势应优先使用同口径 10-Q 财务报表，不混用 earnings 8-K",
        [
            "1. 识别涉及哪些季度",
            "2. 每个季度找对应 10-Q",
            "3. 用 income statement table 保持口径一致",
            "4. 不优先使用 8-K",
            "5. 10-Q 表格无法找到时再用 8-K 补充",
        ],
        ["20250427_10-Q  (Q1)",
         "20250727_10-Q  (Q2)",
         "20251026_10-Q  (Q3)"],
        # Right
        "No-PageIndex Fallback Expert", C["amber"], C["amberBg"],
        "没有 pageindex 不代表文件不重要 — 过去系统偏好有索引的文件导致关键 filing 被跳过",
        [
            "1. 检查 manifest 中的 has_pageindex",
            "2. has_pageindex=false → 不调 read_pageindex",
            "3. 直接 ripgrep 搜 markdown",
            "4. 数字/表格问题 → 也搜 tables",
            "5. 用 event_tags 判断文件是否重要",
        ],
        ["markdown/<filing_id>.md  (直接搜)",
         "tables/<filing_id>_tables.json",
         "manifest.json → event_tags, search_aliases"],
    )


def build_slide_critical_evidence():
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "Critical Evidence Expert",
                    "路由后检查器 — 防止 LLM 提前结束、漏掉必须命中的文件")

    # 4-step flow
    steps = [
        ("1", "读取 critical_filings",
         "从 route plan 中获取必须命中的 filing 清单",
         C["baseline"]),
        ("2", "对比 evidence 覆盖",
         "从 final evidence chunks 中提取 filing_id，与 critical list 比对",
         C["baseline"]),
        ("3", "自动补证",
         "未覆盖的 critical filing → 搜 markdown/tables → 找匹配片段 → 注入 evidence",
         C["fail"]),
        ("4", "Filing Diversity 排序",
         "top-k 中优先保留不同 critical filing 的 chunks，避免单文件独占",
         C["success"]),
    ]

    y_start = inches(1.55)
    step_h = inches(0.78)
    gap = inches(0.1)

    for i, (num, title, desc, color) in enumerate(steps):
        y = y_start + i * (step_h + gap)
        # Number block
        add_rect(tree, inches(0.5), y, inches(0.55), step_h, color)
        add_textbox(tree, inches(0.5), y + inches(0.15), inches(0.55), inches(0.45),
            [_make_para([_make_run(num, sz=1800, bold=True, color=C["white"])], align="ctr")])
        # Content
        add_rect(tree, inches(1.1), y, inches(4.4), step_h,
                 C["failBg"] if i == 2 else (C["successBg"] if i == 3 else C["baselineBg"]))
        add_textbox(tree, inches(1.22), y + inches(0.06), inches(4.2), step_h - inches(0.12),
            [_make_para([_make_run(title, sz=1100, bold=True, color=C["ink"])], spc_after=150),
             _make_para([_make_run(desc, sz=950, color=C["inkSoft"])])])

    # Right side: code block showing the logic
    add_rect(tree, inches(5.8), inches(1.55), inches(3.7), inches(3.5), C["navy"])
    code_lines = [
        ("# _supplement_critical_evidence()", C["navyDim"]),
        ("", None),
        ("critical = plan['critical_filings']", C["navyText"]),
        ("present = {c.filing_id for c in chunks}", C["navyText"]),
        ("unvisited = critical - present", C["navyText"]),
        ("", None),
        ("for filing in unvisited:", C["navyText"]),
        ("  md = read(f'markdown/{filing}.md')", C["navyText"]),
        ("  match = grep(patterns, md)", C["navyText"]),
        ("  if match:", C["navyText"]),
        ("    chunks.append(match, score=0.95)", C["navyText"]),
        ("", None),
        ("# diversity sort: critical first", C["navyDim"]),
        ("for f in critical_order:", C["navyText"]),
        ("  top_k.take_first_from(f)", C["navyText"]),
    ]
    code_paras = []
    for line, color in code_lines:
        if not line:
            code_paras.append(_make_para([_make_run(" ", sz=800, font=FONT_CODE)], spc_after=50))
        else:
            code_paras.append(_make_para(
                [_make_run(line, sz=850, color=color, font=FONT_CODE)], spc_after=80))
    add_textbox(tree, inches(5.95), inches(1.65), inches(3.4), inches(3.3), code_paras)

    add_footer(tree, "金融检索专家路由系统", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_router():
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "总体 Expert Router Controller",
                    "统一控制器：分类问题 → 选择专家路径 → 生成检索计划")

    # Left: Router steps
    router_steps = [
        "1. Identify financial intent（识别金融意图）",
        "2. Select expert_path(s)（选择专家路径）",
        "3. Determine reported_fiscal_period（确定报告期）",
        "4. Select form_types（选择 SEC 表单类型）",
        "5. Select critical_filings（选定关键文件）",
        "6. Generate fallback_searches（生成兜底搜索）",
        "7. Generate facts/metrics_to_extract（要提取的指标）",
        "8. Do not produce final answer（不产生最终答案）",
    ]
    add_textbox(tree, inches(0.5), inches(1.45), inches(4.5), inches(0.35),
        [_make_para([_make_run("路由步骤", sz=1150, bold=True, color=C["ink"])])])

    step_paras = []
    for step in router_steps:
        step_paras.append(_make_para(
            [_make_run(step, sz=1000, color=C["ink"])], spc_after=250))
    add_textbox(tree, inches(0.5), inches(1.85), inches(4.5), inches(3.2), step_paras)

    # Right: Output JSON schema
    add_rect(tree, inches(5.3), inches(1.45), inches(4.2), inches(3.6), C["navy"])
    json_lines = [
        ("// 统一输出 JSON", C["navyDim"]),
        ("{", C["navyText"]),
        ('  "expert_paths": [],', C["navyText"]),
        ('  "reported_fiscal_period": null,', C["navyText"]),
        ('  "form_types": [],', C["navyText"]),
        ('  "critical_filings": [],', C["navyText"]),
        ('  "search_terms": [],', C["navyText"]),
        ('  "fallback_searches": [],', C["navyText"]),
        ('  "facts_to_extract": [],', C["navyText"]),
        ('  "metrics_to_extract": [],', C["navyText"]),
        ('  "notes": []', C["navyText"]),
        ("}", C["navyText"]),
    ]
    json_paras = []
    for line, color in json_lines:
        json_paras.append(_make_para(
            [_make_run(line, sz=900, color=color, font=FONT_CODE)], spc_after=100))
    add_textbox(tree, inches(5.45), inches(1.55), inches(3.9), inches(3.4), json_paras)

    add_footer(tree, "金融检索专家路由系统", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_example():
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "完整示例：H20 Q1 影响",
                    "从用户问题到专家路由输出的完整链路")

    # Question box
    add_rect(tree, inches(0.5), inches(1.45), inches(9.0), inches(0.55), C["ruleSoft"])
    add_textbox(tree, inches(0.65), inches(1.48), inches(8.7), inches(0.5),
        [_make_para([
            _make_run("用户问题：", sz=1050, bold=True, color=C["inkSoft"]),
            _make_run("H20 出口限制对第一季度业绩造成了什么具体影响？",
                      sz=1100, bold=True, color=C["ink"]),
        ])])

    # Expert paths activated
    add_textbox(tree, inches(0.5), inches(2.15), inches(3.0), inches(0.3),
        [_make_para([_make_run("激活的专家路径", sz=1100, bold=True, color=C["ink"])])])

    paths = [
        ("h20_export_control", C["fail"]),
        ("earnings_release", C["success"]),
        ("financial_metric", C["amber"]),
    ]
    for i, (path, color) in enumerate(paths):
        y = inches(2.5) + i * inches(0.35)
        add_rect(tree, inches(0.5), y, inches(0.06), inches(0.3), color)
        add_textbox(tree, inches(0.7), y, inches(2.5), inches(0.3),
            [_make_para([_make_run(path, sz=1000, bold=True, color=color, font=FONT_CODE)])])

    # Critical filings
    add_textbox(tree, inches(0.5), inches(3.55), inches(3.0), inches(0.3),
        [_make_para([_make_run("Critical Filings", sz=1100, bold=True, color=C["ink"])])])

    filings = [
        ("20250409_8-K", "首次披露"),
        ("20250427_10-Q", "Q1 正式报告"),
        ("20250528_8-K", "Q1 earnings"),
    ]
    for i, (fid, label) in enumerate(filings):
        y = inches(3.9) + i * inches(0.32)
        add_textbox(tree, inches(0.7), y, inches(2.8), inches(0.3),
            [_make_para([
                _make_run(fid, sz=950, bold=True, color=C["ink"], font=FONT_CODE),
                _make_run(f"  {label}", sz=900, color=C["muted"]),
            ])])

    # Right: search terms + fallback + facts
    add_rect(tree, inches(4.0), inches(2.15), inches(5.5), inches(2.9), C["navy"])
    right_lines = [
        ("// search_terms", C["navyDim"]),
        ('"H20", "China", "license required",', C["navyText"]),
        ('"unable to ship", "gross margin", "non-GAAP"', C["navyText"]),
        ("", None),
        ("// fallback_searches", C["navyDim"]),
        ('{ "H20.*China|China.*H20", "markdown/*.md" }', C["navyText"]),
        ('{ "unable to ship|no H20 sales", "*.md" }', C["navyText"]),
        ("", None),
        ("// facts_to_extract", C["navyDim"]),
        ('"license requirement"', C["navyText"]),
        ('"inventory & purchase obligation charge"', C["navyText"]),
        ('"gross margin excluding H20 impact"', C["navyText"]),
        ("", None),
        ("// metrics_to_extract", C["navyDim"]),
        ('"$4.5B charge", "$4.6B H20 sales"', C["navyText"]),
        ('"$2.5B unable to ship", "non-GAAP GM"', C["navyText"]),
    ]
    rp = []
    for line, color in right_lines:
        if not line:
            rp.append(_make_para([_make_run(" ", sz=750, font=FONT_CODE)], spc_after=30))
        else:
            rp.append(_make_para([_make_run(line, sz=880, color=color, font=FONT_CODE)], spc_after=80))
    add_textbox(tree, inches(4.15), inches(2.22), inches(5.2), inches(2.75), rp)

    add_footer(tree, "金融检索专家路由系统", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_summary():
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["navy"])
    tree = _sp_tree()
    cSld.append(tree)

    add_textbox(tree, inches(0.6), inches(0.5), inches(8.8), inches(0.6),
        [_make_para([_make_run("总结", sz=2400, bold=True, color=C["navyText"])])])

    # Core insight
    add_textbox(tree, inches(0.6), inches(1.3), inches(8.8), inches(1.0),
        [_make_para([_make_run("这些专家路径本质上是在模仿金融分析师的检索习惯：",
                               sz=1300, color=C["navyDim"])], spc_after=400),
         _make_para([_make_run("先判断问题属于哪种披露场景，再选择最可能承载答案的 SEC 文件组合，",
                               sz=1200, bold=True, color=C["navyText"])]),
         _make_para([_make_run("最后用关键词、表格、fallback 和补证机制确保关键 evidence 被召回。",
                               sz=1200, bold=True, color=C["navyText"])]),
        ])

    # 3 design principles
    principles = [
        ("路由即知识", "专家路径把金融披露知识编码为检索策略，而不是硬编码答案", C["success"]),
        ("兜底即保障", "fallback + 自动补证 + diversity 排序三层兜底，确保 critical filing 不遗漏", C["amber"]),
        ("泛化即目标", "面向 \"披露模式\" 设计而非 \"具体题目\"，新题自动匹配正确路径", C["navyText"]),
    ]
    y_start = inches(3.0)
    for i, (title, desc, color) in enumerate(principles):
        y = y_start + i * inches(0.72)
        add_textbox(tree, inches(0.6), y + inches(0.05), inches(0.5), inches(0.5),
            [_make_para([_make_run(str(i + 1), sz=1800, bold=True, color=color)], align="ctr")])
        add_textbox(tree, inches(1.2), y, inches(8.2), inches(0.65),
            [_make_para([_make_run(title, sz=1150, bold=True, color=C["navyText"])], spc_after=150),
             _make_para([_make_run(desc, sz=950, color=C["navyDim"])])])
        if i < 2:
            add_line(tree, inches(1.2), y + inches(0.65), inches(9.0), y + inches(0.65),
                     C["navyDim"], w=3175)

    add_footer(tree, "金融检索专家路由系统", "__PAGE__", color=C["navyDim"])
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


# ── Package ───────────────────────────────────────────────────────────────────

def build_pptx(out_path):
    slides = [
        build_slide_cover,
        build_slide_system_overview,
        build_slide_corpus,
        build_slide_four_tools,
        build_slide_agent_loop,
        build_slide_architecture,
        build_slide_earnings_h20,
        build_slide_proxy_annual,
        build_slide_trend_fallback,
        build_slide_critical_evidence,
        build_slide_router,
        build_slide_example,
        build_slide_summary,
    ]

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # [Content_Types].xml
        ct_xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        ct_xml += f'<Types xmlns="{NS["ct"]}">'
        ct_xml += '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        ct_xml += '<Default Extension="xml" ContentType="application/xml"/>'
        ct_xml += '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        ct_xml += '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        ct_xml += '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        ct_xml += '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        for i in range(len(slides)):
            ct_xml += f'<Override PartName="/ppt/slides/slide{i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        ct_xml += '</Types>'
        zf.writestr("[Content_Types].xml", ct_xml.encode("utf-8"))

        # _rels/.rels
        rels_xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{NS["rel"]}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>'
        zf.writestr("_rels/.rels", rels_xml.encode("utf-8"))

        # ppt/presentation.xml
        pres = E("p:presentation", {"saveSubsetFonts": "1"})
        smsIdLst = SE(pres, "p:sldMasterIdLst")
        SE(smsIdLst, "p:sldMasterId", {"id": "2147483648", _ns("r:id"): "rId1"})
        sIdLst = SE(pres, "p:sldIdLst")
        for i in range(len(slides)):
            SE(sIdLst, "p:sldId", {"id": str(256 + i), _ns("r:id"): f"rId{i+10}"})
        SE(pres, "p:sldSz", {"cx": str(SLIDE_W), "cy": str(SLIDE_H), "type": "custom"})
        SE(pres, "p:notesSz", {"cx": str(SLIDE_H), "cy": str(SLIDE_W)})
        zf.writestr("ppt/presentation.xml", xml_bytes(pres))

        # ppt/_rels/presentation.xml.rels
        prels = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{NS["rel"]}">'
        prels += f'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
        prels += f'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
        for i in range(len(slides)):
            prels += f'<Relationship Id="rId{i+10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i+1}.xml"/>'
        prels += '</Relationships>'
        zf.writestr("ppt/_rels/presentation.xml.rels", prels.encode("utf-8"))

        # Theme
        zf.writestr("ppt/theme/theme1.xml", xml_bytes(build_theme()))

        # Slide Master
        sm = E("p:sldMaster")
        sm_cSld = SE(sm, "p:cSld")
        sm_bg = SE(sm_cSld, "p:bg")
        SE(SE(sm_bg, "p:bgRef", {"idx": "1001"}), "a:schemeClr", {"val": "bg1"})
        sm_cSld.append(_sp_tree())
        SE(sm, "p:clrMap", {
            "bg1": "lt1", "tx1": "dk1", "bg2": "lt2", "tx2": "dk2",
            "accent1": "accent1", "accent2": "accent2", "accent3": "accent3",
            "accent4": "accent4", "accent5": "accent5", "accent6": "accent6",
            "hlink": "hlink", "folHlink": "folHlink"
        })
        sm_sll = SE(sm, "p:sldLayoutIdLst")
        SE(sm_sll, "p:sldLayoutId", {"id": "2147483649", _ns("r:id"): "rId1"})
        zf.writestr("ppt/slideMasters/slideMaster1.xml", xml_bytes(sm))

        smrels = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{NS["rel"]}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>'
        zf.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", smrels.encode("utf-8"))

        # Slide Layout
        sl = E("p:sldLayout", {"type": "blank", "preserve": "1"})
        sl_cSld = SE(sl, "p:cSld", {"name": "Blank"})
        sl_cSld.append(_sp_tree())
        SE(sl, "p:clrMapOvr").append(E("a:masterClrMapping"))
        zf.writestr("ppt/slideLayouts/slideLayout1.xml", xml_bytes(sl))

        slrels = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{NS["rel"]}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>'
        zf.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", slrels.encode("utf-8"))

        # Slides
        total = len(slides)
        for i, builder in enumerate(slides):
            _shape_id[0] = 1
            sld_xml = builder()
            raw = xml_bytes(sld_xml).decode("utf-8")
            raw = raw.replace("__PAGE__", f"{i+1} / {total}")
            zf.writestr(f"ppt/slides/slide{i+1}.xml", raw.encode("utf-8"))
            srels = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="{NS["rel"]}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>'
            zf.writestr(f"ppt/slides/_rels/slide{i+1}.xml.rels", srels.encode("utf-8"))

    print(f"Done: {out_path}  ({os.path.getsize(out_path)} bytes)")


if __name__ == "__main__":
    build_pptx("金融检索专家路由系统.pptx")
