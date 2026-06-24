#!/usr/bin/env python3
"""
Build DCI-PageIndex 路由增强 PPT from scratch using only stdlib.
Produces a valid .pptx (Office Open XML) without python-pptx.

Design spec: semantic colors, no AI-taste, 16:9, Microsoft YaHei.
"""

import zipfile, io, os, copy
from xml.etree.ElementTree import Element, SubElement, tostring, register_namespace

# ── Namespaces ────────────────────────────────────────────────────────────────
NS = {
    "a":    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r":    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "p":    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "rel":  "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct":   "http://schemas.openxmlformats.org/package/2006/content-types",
}
for prefix, uri in NS.items():
    register_namespace(prefix, uri)

# EMU helpers (1 inch = 914400 EMU)
def inches(v): return int(v * 914400)
def pt_to_emu(v): return int(v * 12700)

# ── Color palette (semantic) ─────────────────────────────────────────────────
C = {
    "ink":       "1E293B",
    "inkSoft":   "475569",
    "muted":     "94A3B8",
    "rule":      "E2E8F0",
    "ruleSoft":  "F1F5F9",
    "white":     "FFFFFF",
    "navy":      "0A1A33",
    "navyText":  "E6ECF5",
    "navyDim":   "8FA3C7",
    "baseline":  "475569",
    "fail":      "B91C1C",
    "success":   "0F766E",
    "amber":     "B45309",
    "baselineBg":"F1F5F9",
    "failBg":    "FEF2F2",
    "successBg": "ECFDF5",
    "amberBg":   "FEF3C7",
}

SLIDE_W = inches(10)
SLIDE_H = inches(5.625)
FONT_MAIN = "Microsoft YaHei"
FONT_CODE = "Consolas"


# ── XML helpers ───────────────────────────────────────────────────────────────
def _ns(tag):
    """Expand 'a:solidFill' → '{http://...}solidFill'."""
    if ":" in tag:
        prefix, local = tag.split(":", 1)
        return f"{{{NS[prefix]}}}{local}"
    return tag

def E(tag, attrib=None, text=None, children=None):
    el = Element(_ns(tag), attrib or {})
    if text: el.text = text
    for c in (children or []):
        el.append(c)
    return el

def SE(parent, tag, attrib=None, text=None):
    el = SubElement(parent, _ns(tag), attrib or {})
    if text: el.text = text
    return el

def xml_bytes(root, declaration=True):
    raw = tostring(root, encoding="unicode")
    if declaration:
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + raw).encode("utf-8")
    return raw.encode("utf-8")


# ── Minimal theme ─────────────────────────────────────────────────────────────
def build_theme():
    t = E("a:theme", {"name": "FinSagent"})
    te = SE(t, "a:themeElements")
    cs = SE(te, "a:clrScheme", {"name": "Custom"})
    for name, color in [("dk1","1E293B"),("lt1","FFFFFF"),("dk2","475569"),("lt2","F1F5F9"),
                        ("accent1","0F766E"),("accent2","B91C1C"),("accent3","B45309"),
                        ("accent4","0A1A33"),("accent5","94A3B8"),("accent6","E2E8F0"),
                        ("hlink","0F766E"),("folHlink","475569")]:
        el = SE(cs, f"a:{name}")
        SE(el, "a:srgbClr", {"val": color})
    fs = SE(te, "a:fontScheme", {"name": "Custom"})
    for kind in ("majorFont", "minorFont"):
        f = SE(fs, f"a:{kind}")
        SE(f, "a:latin", {"typeface": FONT_MAIN})
        SE(f, "a:ea", {"typeface": FONT_MAIN})
        SE(f, "a:cs", {"typeface": FONT_MAIN})
    fmts = SE(te, "a:fmtScheme", {"name": "Custom"})
    for lst_name in ("fillStyleLst", "lnStyleLst", "effectStyleLst", "bgFillStyleLst"):
        lst = SE(fmts, f"a:{lst_name}")
        if "fill" in lst_name.lower() or "bg" in lst_name.lower():
            sf = SE(lst, "a:solidFill")
            SE(sf, "a:schemeClr", {"val": "phClr"})
        if "ln" in lst_name.lower():
            ln = SE(lst, "a:ln", {"w": "6350", "cap": "flat", "cmpd": "sng", "algn": "ctr"})
            sf2 = SE(ln, "a:solidFill")
            SE(sf2, "a:schemeClr", {"val": "phClr"})
        if "effect" in lst_name.lower():
            SE(lst, "a:effectLst")
    SE(t, "a:objectDefaults")
    SE(t, "a:extraClrSchemeLst")
    return t


# ── Shape builders ────────────────────────────────────────────────────────────
def _sp_tree():
    tree = E("p:spTree")
    gnf = SE(tree, "p:nvGrpSpPr")
    SE(gnf, "p:cNvPr", {"id": "1", "name": ""})
    SE(gnf, "p:cNvGrpSpPr")
    SE(gnf, "p:nvPr")
    gsp = SE(tree, "p:grpSpPr")
    SE(gsp, "a:xfrm")
    return tree

_shape_id = [1]
def next_id():
    _shape_id[0] += 1
    return str(_shape_id[0])

def _make_run(text, sz=1100, bold=False, color=None, font=None):
    r = E("a:r")
    rpr = SE(r, "a:rPr", {"lang": "zh-CN", "sz": str(sz), "dirty": "0"})
    if bold:
        rpr.set("b", "1")
    if color:
        sf = SE(rpr, "a:solidFill")
        SE(sf, "a:srgbClr", {"val": color})
    if font:
        SE(rpr, "a:latin", {"typeface": font})
        SE(rpr, "a:ea", {"typeface": font})
        SE(rpr, "a:cs", {"typeface": font})
    else:
        SE(rpr, "a:latin", {"typeface": FONT_MAIN})
        SE(rpr, "a:ea", {"typeface": FONT_MAIN})
    SE(r, "a:t").text = text
    return r

def _make_para(runs, align="l", spc_after=0):
    p = E("a:p")
    ppr = SE(p, "a:pPr", {"algn": align})
    if spc_after:
        SE(ppr, "a:spcAft").append(E("a:spcPts", {"val": str(spc_after)}))
    for run in runs:
        p.append(run)
    return p

def add_textbox(tree, x, y, w, h, paragraphs):
    sp = SE(tree, "p:sp")
    nvsp = SE(sp, "p:nvSpPr")
    SE(nvsp, "p:cNvPr", {"id": next_id(), "name": f"TextBox {_shape_id[0]}"})
    SE(nvsp, "p:cNvSpPr", {"txBox": "1"})
    SE(nvsp, "p:nvPr")
    sppr = SE(sp, "p:spPr")
    xfrm = SE(sppr, "a:xfrm")
    SE(xfrm, "a:off", {"x": str(x), "y": str(y)})
    SE(xfrm, "a:ext", {"cx": str(w), "cy": str(h)})
    SE(sppr, "a:prstGeom", {"prst": "rect"}).append(E("a:avLst"))
    SE(sppr, "a:noFill")
    txBody = SE(sp, "p:txBody")
    SE(txBody, "a:bodyPr", {"wrap": "square", "lIns": "91440", "tIns": "45720", "rIns": "91440", "bIns": "45720"})
    SE(txBody, "a:lstStyle")
    for para in paragraphs:
        txBody.append(para)
    return sp

def add_rect(tree, x, y, w, h, fill_color, border_color=None, border_w=0):
    sp = SE(tree, "p:sp")
    nvsp = SE(sp, "p:nvSpPr")
    SE(nvsp, "p:cNvPr", {"id": next_id(), "name": f"Rect {_shape_id[0]}"})
    SE(nvsp, "p:cNvSpPr")
    SE(nvsp, "p:nvPr")
    sppr = SE(sp, "p:spPr")
    xfrm = SE(sppr, "a:xfrm")
    SE(xfrm, "a:off", {"x": str(x), "y": str(y)})
    SE(xfrm, "a:ext", {"cx": str(w), "cy": str(h)})
    SE(sppr, "a:prstGeom", {"prst": "rect"}).append(E("a:avLst"))
    sf = SE(sppr, "a:solidFill")
    SE(sf, "a:srgbClr", {"val": fill_color})
    if border_color and border_w:
        ln = SE(sppr, "a:ln", {"w": str(border_w)})
        sf2 = SE(ln, "a:solidFill")
        SE(sf2, "a:srgbClr", {"val": border_color})
    else:
        SE(sppr, "a:ln").append(E("a:noFill"))
    return sp

def add_line(tree, x1, y1, x2, y2, color, w=6350):
    cxn = SE(tree, "p:cxnSp")
    nv = SE(cxn, "p:nvCxnSpPr")
    SE(nv, "p:cNvPr", {"id": next_id(), "name": f"Line {_shape_id[0]}"})
    SE(nv, "p:cNvCxnSpPr")
    SE(nv, "p:nvPr")
    sppr = SE(cxn, "p:spPr")
    xfrm = SE(sppr, "a:xfrm")
    SE(xfrm, "a:off", {"x": str(x1), "y": str(y1)})
    SE(xfrm, "a:ext", {"cx": str(x2 - x1), "cy": str(y2 - y1)})
    SE(sppr, "a:prstGeom", {"prst": "line"}).append(E("a:avLst"))
    ln = SE(sppr, "a:ln", {"w": str(w)})
    sf = SE(ln, "a:solidFill")
    SE(sf, "a:srgbClr", {"val": color})
    return cxn


# ── Card with left color bar ─────────────────────────────────────────────────
def add_card(tree, x, y, w, h, bar_color, bg_color, title_text, body_text,
             title_sz=1100, body_sz=1000, title_color=None, body_color=None):
    bar_w = inches(0.06)
    add_rect(tree, x, y, bar_w, h, bar_color)
    add_rect(tree, x + bar_w, y, w - bar_w, h, bg_color)
    paras = []
    if title_text:
        paras.append(_make_para(
            [_make_run(title_text, sz=title_sz, bold=True,
                       color=title_color or bar_color)], spc_after=400))
    if body_text:
        for line in (body_text if isinstance(body_text, list) else [body_text]):
            paras.append(_make_para(
                [_make_run(line, sz=body_sz, color=body_color or C["inkSoft"])],
                spc_after=200))
    add_textbox(tree, x + bar_w + inches(0.12), y + inches(0.08),
                w - bar_w - inches(0.24), h - inches(0.16), paras)


# ── Table builder ─────────────────────────────────────────────────────────────
def add_table(tree, x, y, col_widths, rows, header_bg=None, row_colors=None,
              font_sz=1000, header_font_sz=1000):
    """rows: list of list of str. First row = header."""
    n_cols = len(col_widths)
    n_rows = len(rows)
    total_w = sum(col_widths)
    row_h = inches(0.38)
    total_h = row_h * n_rows

    graphic_frame = SE(tree, "p:graphicFrame")
    nvgf = SE(graphic_frame, "p:nvGraphicFramePr")
    SE(nvgf, "p:cNvPr", {"id": next_id(), "name": f"Table {_shape_id[0]}"})
    SE(nvgf, "p:cNvGraphicFramePr").append(
        E("a:graphicFrameLocks", {"noGrp": "1"}))
    SE(nvgf, "p:nvPr")

    xfrm = SE(graphic_frame, "p:xfrm")
    SE(xfrm, "a:off", {"x": str(x), "y": str(y)})
    SE(xfrm, "a:ext", {"cx": str(total_w), "cy": str(total_h)})

    graphic = SE(graphic_frame, "a:graphic")
    gd = SE(graphic, "a:graphicData",
            {"uri": "http://schemas.openxmlformats.org/drawingml/2006/table"})

    tbl = SE(gd, "a:tbl")
    tblpr = SE(tbl, "a:tblPr", {"firstRow": "1", "bandRow": "1"})
    SE(tblpr, "a:noFill")

    tblgrid = SE(tbl, "a:tblGrid")
    for cw in col_widths:
        SE(tblgrid, "a:gridCol", {"w": str(cw)})

    for ri, row_data in enumerate(rows):
        tr = SE(tbl, "a:tr", {"h": str(row_h)})
        for ci, cell_text in enumerate(row_data):
            tc = SE(tr, "a:tc")
            txBody = SE(tc, "a:txBody")
            SE(txBody, "a:bodyPr")
            SE(txBody, "a:lstStyle")

            is_header = (ri == 0)
            txt_color = C["white"] if is_header else C["ink"]
            sz = header_font_sz if is_header else font_sz
            bold = is_header

            # Check if cell_text is a tuple (text, color, bold_override)
            cell_bold = bold
            cell_color = txt_color
            actual_text = cell_text
            if isinstance(cell_text, tuple):
                actual_text = cell_text[0]
                if len(cell_text) > 1 and cell_text[1]:
                    cell_color = cell_text[1]
                if len(cell_text) > 2:
                    cell_bold = cell_text[2]

            p = _make_para([_make_run(actual_text, sz=sz, bold=cell_bold, color=cell_color)])
            txBody.append(p)

            tcpr = SE(tc, "a:tcPr", {"marL": "68580", "marR": "68580",
                                      "marT": "34290", "marB": "34290"})
            if is_header:
                bg = header_bg or C["ink"]
                sf = SE(tcpr, "a:solidFill")
                SE(sf, "a:srgbClr", {"val": bg})
            elif row_colors and ri in row_colors:
                sf = SE(tcpr, "a:solidFill")
                SE(sf, "a:srgbClr", {"val": row_colors[ri]})
            else:
                SE(tcpr, "a:noFill")

            # Borders - thin and light
            for bname in ("lnL", "lnR", "lnT", "lnB"):
                ln = SE(tcpr, f"a:{bname}", {"w": "6350", "cap": "flat", "cmpd": "sng", "algn": "ctr"})
                sf = SE(ln, "a:solidFill")
                SE(sf, "a:srgbClr", {"val": C["rule"]})

    return graphic_frame


# ── Big number callout ────────────────────────────────────────────────────────
def add_big_number(tree, x, y, w, number_text, label_text, desc_text=None,
                   number_color=None, number_sz=3600):
    paras = []
    paras.append(_make_para(
        [_make_run(number_text, sz=number_sz, bold=True,
                   color=number_color or C["success"])], spc_after=200))
    paras.append(_make_para(
        [_make_run(label_text, sz=1200, bold=True, color=C["ink"])], spc_after=200))
    if desc_text:
        paras.append(_make_para(
            [_make_run(desc_text, sz=1000, color=C["muted"])]))
    add_textbox(tree, x, y, w, inches(1.6), paras)


# ── Slide background ─────────────────────────────────────────────────────────
def set_slide_bg(cSld, color):
    bg = SE(cSld, "p:bg")
    bgpr = SE(bg, "p:bgPr")
    sf = SE(bgpr, "a:solidFill")
    SE(sf, "a:srgbClr", {"val": color})
    SE(bgpr, "a:effectLst")


# ── Page title + subtitle ────────────────────────────────────────────────────
def add_page_header(tree, title, subtitle=None, title_color=None):
    paras = [_make_para(
        [_make_run(title, sz=2200, bold=True, color=title_color or C["ink"])],
        spc_after=300)]
    if subtitle:
        paras.append(_make_para(
            [_make_run(subtitle, sz=1300, color=C["inkSoft"])]))
    add_textbox(tree, inches(0.5), inches(0.35), inches(9.0), inches(0.9), paras)


# ── Page footer ──────────────────────────────────────────────────────────────
def add_footer(tree, left_text, right_text, color=None):
    c = color or C["muted"]
    add_textbox(tree, inches(0.5), inches(5.32), inches(4.0), inches(0.28),
                [_make_para([_make_run(left_text, sz=900, color=c)])])
    add_textbox(tree, inches(5.5), inches(5.32), inches(4.0), inches(0.28),
                [_make_para([_make_run(right_text, sz=900, color=c)], align="r")])


# ── Build individual slides ──────────────────────────────────────────────────

def build_slide_cover():
    """Slide 1: Dark cover with KPIs."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["navy"])
    tree = _sp_tree()
    cSld.append(tree)

    # Title
    add_textbox(tree, inches(0.6), inches(0.9), inches(8.8), inches(1.5),
        [_make_para([_make_run("DCI-PageIndex 路由增强", sz=4400, bold=True,
                               color=C["navyText"])], spc_after=400),
         _make_para([_make_run("NVIDIA SEC 问答评测  Filing Recall 优化报告",
                               sz=1600, color=C["navyDim"])])])

    # Thin separator line
    add_line(tree, inches(0.6), inches(2.7), inches(4.0), inches(2.7), C["navyDim"], w=9525)

    # Date & context
    add_textbox(tree, inches(0.6), inches(2.9), inches(4.0), inches(0.6),
        [_make_para([_make_run("2026-05-26  |  FinSagent  |  DCI-PageIndex Backend",
                               sz=1100, color=C["navyDim"])])])

    # 3 KPIs on the right
    kpi_x = inches(5.6)
    add_big_number(tree, kpi_x, inches(1.0), inches(3.8),
                   "+0.122", "Filing Recall", "30 题完整评测",
                   number_color=C["success"], number_sz=4400)
    add_big_number(tree, kpi_x, inches(2.6), inches(3.8),
                   "1.000", "Targeted Recall", "4 道历史失败题",
                   number_color=C["success"], number_sz=3600)
    add_big_number(tree, kpi_x, inches(3.9), inches(3.8),
                   "L0→1.0", "最简单层全满分", "从 0.900 提升至 1.000",
                   number_color=C["navyText"], number_sz=3000)

    # Footer
    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__", color=C["navyDim"])

    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_week_overview():
    """Dataset verification + expansion overview."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "本周工作概览",
                    "NVIDIA 数据集正确性确认 + 数据集扩展 + 180 题端到端评测")

    x_left = inches(0.5)
    x_right = inches(5.15)
    w_col = inches(4.35)

    # Left: Task 1
    add_rect(tree, x_left, inches(1.45), w_col, inches(0.08), C["success"])
    add_textbox(tree, x_left, inches(1.55), w_col, inches(0.35),
        [_make_para([_make_run("任务 1  数据集验证", sz=1200, bold=True, color=C["success"])])])
    add_card(tree, x_left, inches(1.95), w_col, inches(2.4),
             C["success"], C["successBg"],
             "30 题逐题校验", [
                 "逐题对照原始 SEC markdown 检查答案",
                 "每题标记 verified / corrected / wrong",
                 "记录证据出处（文件名 + 行号）",
                 "",
                 "产出：verified_v1/ 4 个 JSON + md 报告",
                 "结果：29 题 verified-correct，1 题元数据修正",
             ], title_sz=1050, body_sz=900, title_color=C["success"])

    # Right: Task 2
    add_rect(tree, x_right, inches(1.45), w_col, inches(0.08), C["baseline"])
    add_textbox(tree, x_right, inches(1.55), w_col, inches(0.35),
        [_make_para([_make_run("任务 2  数据集扩展", sz=1200, bold=True, color=C["baseline"])])])
    add_card(tree, x_right, inches(1.95), w_col, inches(2.4),
             C["baseline"], C["baselineBg"],
             "150 题新增（L0/L1/L2 各 50）", [
                 "从 17 份 SEC markdown 中抽取事实",
                 "补充跨季度时间线、跨文件拼接等题型",
                 "verify.js 字面校验：150/150 通过",
                 "",
                 "产出：expand_nvidia_questions/ 3 个 JSON",
                 "合计：30 + 150 = 180 道评测题",
             ], title_sz=1050, body_sz=900, title_color=C["baseline"])

    # Bottom summary bar
    add_rect(tree, inches(0.5), inches(4.6), inches(9.0), inches(0.55), C["ruleSoft"])
    add_textbox(tree, inches(0.65), inches(4.62), inches(8.7), inches(0.5),
        [_make_para([
            _make_run("180 题", sz=1100, bold=True, color=C["success"]),
            _make_run("  已全部通过字面校验 + LLM judge 评测，详见后续页",
                      sz=1050, color=C["ink"]),
        ])])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_verification():
    """30-question verification results + L0_002 correction."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "数据集验证：30 题逐题校验",
                    "29 题 verified-correct，1 题元数据修正（L0_002）")

    # Left: summary stats
    add_big_number(tree, inches(0.5), inches(1.5), inches(2.5),
                   "29/30", "Verified Correct", "答案事实全部正确",
                   number_color=C["success"], number_sz=3600)

    add_big_number(tree, inches(0.5), inches(3.0), inches(2.5),
                   "1", "元数据修正", "L0_002 expected_section",
                   number_color=C["amber"], number_sz=3600)

    add_big_number(tree, inches(0.5), inches(4.3), inches(2.5),
                   "0", "事实错误", "无需修改答案文本",
                   number_color=C["muted"], number_sz=3600)

    # Right: L0_002 detail card
    add_rect(tree, inches(3.5), inches(1.45), inches(6.0), inches(0.08), C["amber"])
    add_textbox(tree, inches(3.5), inches(1.55), inches(6.0), inches(0.3),
        [_make_para([_make_run("L0_002 修正详情", sz=1200, bold=True, color=C["amber"])])])

    # Question
    add_rect(tree, inches(3.5), inches(1.9), inches(6.0), inches(0.55), C["ruleSoft"])
    add_textbox(tree, inches(3.65), inches(1.92), inches(5.7), inches(0.5),
        [_make_para([
            _make_run("问题：", sz=950, bold=True, color=C["inkSoft"]),
            _make_run("2025 财年哪些市场平台贡献最大？各平台收入大概是多少？", sz=950, color=C["ink"]),
        ])])

    # Before
    add_card(tree, inches(3.5), inches(2.6), inches(6.0), inches(0.7),
             C["fail"], C["failBg"],
             "修改前 expected_section", [
                 "Item 7. Management's Discussion and Analysis",
                 "该段只有定性叙述，无四个平台的具体数字",
             ], title_sz=1000, body_sz=900)

    # After
    add_card(tree, inches(3.5), inches(3.45), inches(6.0), inches(0.7),
             C["success"], C["successBg"],
             "修改后 expected_section", [
                 "Note 16 - Segment Information",
                 "line 1920 Revenue by End Market 表含四个平台数字",
             ], title_sz=1000, body_sz=900, title_color=C["success"])

    # Evidence
    add_rect(tree, inches(3.5), inches(4.3), inches(6.0), inches(0.7), C["navy"])
    add_textbox(tree, inches(3.65), inches(4.35), inches(5.7), inches(0.6),
        [_make_para([_make_run("# 20250126_10-K.md", sz=900, color=C["navyDim"], font=FONT_CODE)], spc_after=150),
         _make_para([_make_run("line 1876  Note 16 章节起点", sz=900, color=C["navyText"], font=FONT_CODE)], spc_after=100),
         _make_para([_make_run("line 1920  Revenue by End Market 表", sz=900, color=C["navyText"], font=FONT_CODE)]),
        ])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_expansion():
    """150-question dataset expansion design."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "数据集扩展：150 题三层设计",
                    "从 17 份 SEC markdown 中抽取事实，按 L0/L1/L2 各补 50 题")

    # Layer breakdown table
    col_w = [inches(0.8), inches(2.0), inches(3.2), inches(3.0)]
    rows = [
        ["层", "考察方向", "字段", "新增覆盖"],
        ["L0", "SEC 路由常识", "expected_file + expected_section",
         "H20 出口、8-K 事件、proxy vote"],
        ["L1", "Query 拆解", "expected_slots + candidate_filings",
         "口语化别名、隐含时间、多 slot"],
        ["L2", "动态多步检索", "expected_files + expected_retrieval",
         "跨季度时间线、同事件多文件交叉"],
    ]
    row_colors = {1: C["successBg"], 2: C["amberBg"], 3: C["failBg"]}
    add_table(tree, inches(0.5), inches(1.55), col_w, rows,
              header_bg=C["ink"], row_colors=row_colors, font_sz=950, header_font_sz=950)

    # Coverage gaps filled
    add_textbox(tree, inches(0.5), inches(3.2), inches(4.5), inches(0.3),
        [_make_para([_make_run("原 30 题缺少的能力维度", sz=1100, bold=True, color=C["ink"])])])

    gaps = [
        ("跨季度时间线对比", "较少 → 多补", C["success"]),
        ("跨文件证据拼接", "较少 → 多补", C["success"]),
        ("同事件多文件交叉", "几乎没有 → 多补", C["success"]),
        ("口语化别名 / 隐含时间", "一般 → 多补", C["success"]),
    ]
    for i, (name, status, color) in enumerate(gaps):
        y = inches(3.55) + i * inches(0.38)
        add_textbox(tree, inches(0.7), y, inches(4.3), inches(0.35),
            [_make_para([
                _make_run(name, sz=1000, bold=True, color=C["ink"]),
                _make_run(f"  {status}", sz=1000, color=color),
            ])])

    # Right: Quality check
    add_rect(tree, inches(5.15), inches(3.2), inches(4.35), inches(1.85), C["ruleSoft"])
    add_textbox(tree, inches(5.35), inches(3.25), inches(4.0), inches(1.7),
        [_make_para([_make_run("字面校验结果 (verify.js)", sz=1100, bold=True, color=C["ink"])], spc_after=400),
         _make_para([
             _make_run("文件命中：", sz=1000, color=C["inkSoft"]),
             _make_run("150 / 150", sz=1000, bold=True, color=C["success"]),
         ], spc_after=200),
         _make_para([
             _make_run("Token 命中：", sz=1000, color=C["inkSoft"]),
             _make_run("150 / 150", sz=1000, bold=True, color=C["success"]),
         ], spc_after=200),
         _make_para([
             _make_run("首次失败 → 修复：", sz=1000, color=C["inkSoft"]),
             _make_run("42 题", sz=1000, bold=True, color=C["amber"]),
         ], spc_after=150),
         _make_para([_make_run("多数因节标题标点不一致 / 口语缩写", sz=900, color=C["muted"])]),
        ])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_eval_180():
    """180-question evaluation results."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "180 题评测总览",
                    "LLM Judge (Qwen3-4B, temp=0) 对三组数据集的评分")

    # Main results table
    col_w = [inches(2.2), inches(0.7), inches(1.0), inches(1.0), inches(1.0), inches(1.0), inches(1.3)]
    rows = [
        ["数据集", "题数", "平均分", "correct", "partial", "incorrect", "retr_failed"],
        [("原 30 题 (A1)", None, False), "30", ("97.5", C["success"], True),
         "28", "2", "0", "0"],
        [("verified 30 题 (A2)", None, False), "30", ("94.2", C["amber"], True),
         "27", "2", ("1", C["fail"], True), "0"],
        [("扩展 150 题 (A3)", None, False), "150", ("96.5", C["success"], True),
         "134", "14", ("1", C["fail"], False), ("1", C["amber"], False)],
    ]
    row_colors = {1: C["baselineBg"]}
    add_table(tree, inches(0.5), inches(1.55), col_w, rows,
              header_bg=C["ink"], row_colors=row_colors, font_sz=1000, header_font_sz=1000)

    # Score distribution for 150 questions
    add_textbox(tree, inches(0.5), inches(3.3), inches(4.0), inches(0.3),
        [_make_para([_make_run("扩展 150 题分数分布", sz=1100, bold=True, color=C["ink"])])])

    dist_col_w = [inches(1.2), inches(1.2)]
    dist_rows = [
        ["分段", "题数"],
        [("100 分", C["success"], True), ("124", C["success"], True)],
        ["90-99", "12"],
        ["70-89", "10"],
        [("40-69", C["amber"], False), ("2", C["amber"], False)],
        [("< 40", C["fail"], False), ("1", C["fail"], False)],
        ["未评分", "1"],
    ]
    add_table(tree, inches(0.5), inches(3.65), dist_col_w, dist_rows,
              header_bg=C["ink"], font_sz=950, header_font_sz=950)

    # Right: key takeaways
    add_textbox(tree, inches(5.0), inches(3.3), inches(4.5), inches(0.3),
        [_make_para([_make_run("关键发现", sz=1100, bold=True, color=C["ink"])])])

    findings = [
        (C["fail"], "L0_002 修正后 score 100→0",
         "元数据指错时 judge \"沉默通过\"打 100；修正后暴露真实评分"),
        (C["amber"], "L1 字段与 judge 不对齐",
         "expected_slots 无 section，judge 全文匹配 → partial 偏高"),
        (C["fail"], "L1_E003 事实疑误",
         "Networking 三季收入数字需复核"),
        (C["success"], "整体质量可用",
         "134/150 满分，问题集中在字段适配而非数据集"),
    ]
    for i, (color, title, desc) in enumerate(findings):
        y = inches(3.65) + i * inches(0.52)
        add_card(tree, inches(5.0), y, inches(4.5), inches(0.48),
                 color, C["white"], title, desc,
                 title_sz=950, body_sz=850)

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_l0002_deep():
    """L0_002 score change deep dive."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "核心发现：L0_002 的 Score 变化",
                    "元数据修正暴露了 judge 链路的 \"沉默通过\" 问题")

    x_left = inches(0.5)
    x_right = inches(5.15)
    w_col = inches(4.35)

    # Left: Before (A1)
    add_rect(tree, x_left, inches(1.45), w_col, inches(0.08), C["baseline"])
    add_textbox(tree, x_left, inches(1.55), w_col, inches(0.35),
        [_make_para([_make_run("修正前 (A1)  Score = 100", sz=1200, bold=True, color=C["baseline"])])])

    add_card(tree, x_left, inches(1.95), w_col, inches(0.6),
             C["baseline"], C["baselineBg"],
             "expected_section", "Item 7. MD&A",
             title_sz=1000, body_sz=950)

    add_card(tree, x_left, inches(2.65), w_col, inches(0.8),
             C["baseline"], C["baselineBg"],
             "retrieval 命中段落", [
                 "Item 7（无相关数字）",
                 "judge 看到 \"候选答案 vs 空段落\" → 无冲突 → 100 分",
             ], title_sz=1000, body_sz=900)

    add_rect(tree, x_left, inches(3.6), w_col, inches(0.55), C["amberBg"])
    add_rect(tree, x_left, inches(3.6), inches(0.06), inches(0.55), C["amber"])
    add_textbox(tree, x_left + inches(0.18), inches(3.63), w_col - inches(0.3), inches(0.5),
        [_make_para([
            _make_run("100 分是 \"虚高\"", sz=1050, bold=True, color=C["amber"]),
            _make_run(" — judge 没真的对数据，等于跳过判分", sz=1000, color=C["ink"]),
        ])])

    # Right: After (A2)
    add_rect(tree, x_right, inches(1.45), w_col, inches(0.08), C["fail"])
    add_textbox(tree, x_right, inches(1.55), w_col, inches(0.35),
        [_make_para([_make_run("修正后 (A2)  Score = 0", sz=1200, bold=True, color=C["fail"])])])

    add_card(tree, x_right, inches(1.95), w_col, inches(0.6),
             C["fail"], C["failBg"],
             "expected_section", "Note 16 - Segment Information",
             title_sz=1000, body_sz=950)

    add_card(tree, x_right, inches(2.65), w_col, inches(0.8),
             C["fail"], C["failBg"],
             "retrieval 命中段落", [
                 "Note 16 H2 → 选中 Segment 子表（非 Revenue by End Market）",
                 "judge 比对 segment 表数字 vs 平台数字 → 全错 → 0 分",
             ], title_sz=1000, body_sz=900)

    add_rect(tree, x_right, inches(3.6), w_col, inches(0.55), C["successBg"])
    add_rect(tree, x_right, inches(3.6), inches(0.06), inches(0.55), C["success"])
    add_textbox(tree, x_right + inches(0.18), inches(3.63), w_col - inches(0.3), inches(0.5),
        [_make_para([
            _make_run("方向正确", sz=1050, bold=True, color=C["success"]),
            _make_run(" — 需进一步精确到 \"Revenue by End Market\" 子表", sz=1000, color=C["ink"]),
        ])])

    # Bottom insight
    add_rect(tree, inches(0.5), inches(4.35), inches(9.0), inches(0.08), C["ink"])
    add_textbox(tree, inches(0.5), inches(4.5), inches(9.0), inches(0.6),
        [_make_para([
            _make_run("启示：", sz=1100, bold=True, color=C["ink"]),
            _make_run("元数据指错位置时 judge 会 \"沉默通过\" 打满分。", sz=1050, color=C["fail"]),
            _make_run(" verified 把沉默通过变成了真实失败 — 分数下降的本质是更严格的判分，不是数据集变差。",
                      sz=1050, color=C["ink"]),
        ])])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_problem():
    """Slide 2: Background & failure patterns."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "背景：四类稳定失败模式",
                    "DCI-PageIndex 在 NVIDIA SEC 评测中的 evidence filing recall 瓶颈")

    cards = [
        ("Earnings Release 漏检",
         "季度业绩问题只命中 10-Q，漏掉包含 press release / non-GAAP / guidance 的 8-K",
         C["fail"], C["failBg"]),
        ("No-PageIndex 文件被跳过",
         "20250528_8-K、20250827_8-K、20250604_DEFA14A 等文件因 has_pageindex=false 被弱化",
         C["fail"], C["failBg"]),
        ("缺少金融披露路由知识",
         "H20 出口限制、non-GAAP 毛利率、股东提案、Q1-Q3 趋势等问题需要领域知识辅助路由",
         C["amber"], C["amberBg"]),
        ("缺少生产级 Hard Routing",
         "历史低召回题需要可复现的 guardrails，但不能直接 hard code 最终答案",
         C["amber"], C["amberBg"]),
    ]

    y_start = inches(1.6)
    card_h = inches(0.82)
    gap = inches(0.12)
    for i, (title, body, bar_c, bg_c) in enumerate(cards):
        add_card(tree, inches(0.5), y_start + i * (card_h + gap),
                 inches(9.0), card_h, bar_c, bg_c, title, body,
                 title_sz=1100, body_sz=950)

    # Bottom callout: specific question failures
    add_rect(tree, inches(0.5), inches(4.5), inches(9.0), inches(0.65), C["ruleSoft"])
    add_textbox(tree, inches(0.65), inches(4.52), inches(8.7), inches(0.6),
        [_make_para([
            _make_run("典型失败：", sz=1000, bold=True, color=C["ink"]),
            _make_run("  L0_004 recall=0.0 (漏 8-K)   L2_002 recall=0.0 (漏双 8-K)   L1_010 recall=0.5 (漏 DEFA14A)",
                      sz=1000, color=C["fail"]),
        ])])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_defect_overview():
    """Slide NEW-1: 4 categories of retrieval chain defects (A/B/C/D)."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "检索链路四类缺陷",
                    "从 30 题评测中归纳的系统性失败根因")

    defects = [
        ("A", "Plan 路由错误", C["fail"], C["failBg"],
         "plan 给出 [10-Q, 8-K] 但 agent 只查了 10-Q 就停，或 plan 本身给错",
         "原 prompt 含 \"Trust this plan\"，ripgrep 无结果才允许换 filter"),
        ("B", "fiscal_period 语义错配", C["amber"], C["amberBg"],
         "read_manifest(fiscal_period=FY2025, DEF14A) → 0 rows，实际标签是 FY2026",
         "用户说\"2025\"是日历年，NVIDIA 财年偏移，模型搜 FY2025 匹配不上"),
        ("C", "多 filing 题只收敛一个", C["fail"], C["failBg"],
         "L1 多 filing 题全部只 retrieve 一个 filing",
         "原 prompt \"Stop once you have top_k snippets\" 鼓励单 filing 深挖"),
        ("D", "max_turn 耗尽无 EVIDENCE", C["amber"], C["amberBg"],
         "L0_008 已读到 Voting Matters 表但 max_turns 耗光，未输出 EVIDENCE",
         "无 turn budget 管理，无末轮强制收尾机制"),
    ]

    y_start = inches(1.5)
    card_h = inches(0.88)
    gap = inches(0.1)
    label_w = inches(0.55)

    for i, (letter, name, bar_c, bg_c, symptom, cause) in enumerate(defects):
        y = y_start + i * (card_h + gap)
        # Category label (colored block)
        add_rect(tree, inches(0.5), y, label_w, card_h, bar_c)
        add_textbox(tree, inches(0.5), y + inches(0.2), label_w, inches(0.45),
            [_make_para([_make_run(letter, sz=2000, bold=True, color=C["white"])], align="ctr")])
        # Card body
        add_rect(tree, inches(1.1), y, inches(8.4), card_h, bg_c)
        add_textbox(tree, inches(1.25), y + inches(0.06), inches(8.1), card_h - inches(0.12),
            [_make_para([_make_run(name, sz=1100, bold=True, color=bar_c)], spc_after=200),
             _make_para([
                 _make_run("现象  ", sz=950, bold=True, color=C["inkSoft"]),
                 _make_run(symptom, sz=950, color=C["ink"]),
             ], spc_after=100),
             _make_para([
                 _make_run("根因  ", sz=950, bold=True, color=C["inkSoft"]),
                 _make_run(cause, sz=950, color=C["ink"]),
             ])])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_defect_ab():
    """Slide NEW-2: A+B detail — Plan routing + fiscal_period mismatch."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "A / B 类：路由与语义层修复",
                    "Plan 执行不忠实 + fiscal_period 日历年 vs 财年错位")

    x_left = inches(0.5)
    x_right = inches(5.15)
    w_col = inches(4.35)

    # ── Left column: A 类 ──
    # Header bar
    add_rect(tree, x_left, inches(1.45), w_col, inches(0.08), C["fail"])
    add_textbox(tree, x_left, inches(1.55), w_col, inches(0.35),
        [_make_para([_make_run("A 类  Plan 路由错误", sz=1200, bold=True, color=C["fail"])])])

    # 现象
    add_card(tree, x_left, inches(1.95), w_col, inches(0.72),
             C["fail"], C["failBg"],
             "现象", "plan 给出 [10-Q, 8-K] 但 agent 只查 10-Q 就停，或 plan 本身有错",
             title_sz=1000, body_sz=900)

    # 根因
    add_rect(tree, x_left + inches(0.1), inches(2.8), w_col - inches(0.2), inches(0.55), C["ruleSoft"])
    add_textbox(tree, x_left + inches(0.2), inches(2.82), w_col - inches(0.4), inches(0.5),
        [_make_para([_make_run("根因：", sz=950, bold=True, color=C["inkSoft"]),
                     _make_run(" _system_prompt 含 \"Trust this plan\"，只有 ripgrep 无结果才允许换 filter",
                               sz=950, color=C["ink"])])])

    # 修改 (green = fix)
    add_card(tree, x_left, inches(3.5), w_col, inches(1.55),
             C["success"], C["successBg"],
             "修改", [
                 "a. 新增 Routing rules：",
                 "   form_types 含 N 个 → 必须对前 N 个各 read_manifest 一次",
                 "b. 重写 plan 块为 \"hypothesis, not commitment\"",
                 "   agent 可根据实际结果调整搜索策略",
             ], title_sz=1000, body_sz=900, title_color=C["success"])

    # ── Right column: B 类 ──
    add_rect(tree, x_right, inches(1.45), w_col, inches(0.08), C["amber"])
    add_textbox(tree, x_right, inches(1.55), w_col, inches(0.35),
        [_make_para([_make_run("B 类  fiscal_period 语义错配", sz=1200, bold=True, color=C["amber"])])])

    # 现象
    add_card(tree, x_right, inches(1.95), w_col, inches(0.72),
             C["amber"], C["amberBg"],
             "现象", "read_manifest(fiscal_period=FY2025, DEF14A) → 0 rows，实际标签 FY2026",
             title_sz=1000, body_sz=900)

    # 根因
    add_rect(tree, x_right + inches(0.1), inches(2.8), w_col - inches(0.2), inches(0.55), C["ruleSoft"])
    add_textbox(tree, x_right + inches(0.2), inches(2.82), w_col - inches(0.4), inches(0.5),
        [_make_para([_make_run("根因：", sz=950, bold=True, color=C["inkSoft"]),
                     _make_run(" 用户说\"2025\"是日历年，NVIDIA 财年偏移 → 模型搜 FY2025 匹配不上",
                               sz=950, color=C["ink"])])])

    # 修改
    add_card(tree, x_right, inches(3.5), w_col, inches(1.55),
             C["success"], C["successBg"],
             "修改", [
                 "a. Plan 与 prompt 加 Manifest 过滤语义说明：",
                 "   fiscal_period = manifest 行标签，非口语年份",
                 "b. 示例：用户说\"2025年\" →",
                 "   应搜 FY2026 (NVIDIA 财年偏移一年)",
             ], title_sz=1000, body_sz=900, title_color=C["success"])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_defect_cd():
    """Slide NEW-3: C+D detail — Multi-filing convergence + max_turn fallback."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "C / D 类：收敛与兜底层修复",
                    "多源证据收集不足 + 轮次耗尽无输出")

    x_left = inches(0.5)
    x_right = inches(5.15)
    w_col = inches(4.35)

    # ── Left column: C 类 ──
    add_rect(tree, x_left, inches(1.45), w_col, inches(0.08), C["fail"])
    add_textbox(tree, x_left, inches(1.55), w_col, inches(0.35),
        [_make_para([_make_run("C 类  多 filing 题只收敛一个", sz=1200, bold=True, color=C["fail"])])])

    # 现象
    add_card(tree, x_left, inches(1.95), w_col, inches(0.72),
             C["fail"], C["failBg"],
             "现象", "L1 多 filing baseline 题目全部只 retrieve 一个 filing",
             title_sz=1000, body_sz=900)

    # 根因
    add_rect(tree, x_left + inches(0.1), inches(2.8), w_col - inches(0.2), inches(0.55), C["ruleSoft"])
    add_textbox(tree, x_left + inches(0.2), inches(2.82), w_col - inches(0.4), inches(0.5),
        [_make_para([_make_run("根因：", sz=950, bold=True, color=C["inkSoft"]),
                     _make_run(" 原 prompt \"Stop once you have top_k snippets\" 鼓励单 filing 深挖",
                               sz=950, color=C["ink"])])])

    # 修改
    add_card(tree, x_left, inches(3.5), w_col, inches(1.55),
             C["success"], C["successBg"],
             "修改", [
                 "a. 加 Multi-source sufficiency 规则：",
                 "   列出子需求 → 每个需求需要独立 filing 支撑",
                 "b. 禁止 \"一个 filing 回答所有\" 的 early stop",
                 "c. 确保 evidence 覆盖 plan 中所有 form_types",
             ], title_sz=1000, body_sz=900, title_color=C["success"])

    # ── Right column: D 类 ──
    add_rect(tree, x_right, inches(1.45), w_col, inches(0.08), C["amber"])
    add_textbox(tree, x_right, inches(1.55), w_col, inches(0.35),
        [_make_para([_make_run("D 类  max_turn 耗尽无 EVIDENCE", sz=1200, bold=True, color=C["amber"])])])

    # 现象
    add_card(tree, x_right, inches(1.95), w_col, inches(0.72),
             C["amber"], C["amberBg"],
             "现象", "L0_008 已读到 Voting Matters 表但 max_turns 耗光，未输出 EVIDENCE",
             title_sz=1000, body_sz=900)

    # 根因
    add_rect(tree, x_right + inches(0.1), inches(2.8), w_col - inches(0.2), inches(0.55), C["ruleSoft"])
    add_textbox(tree, x_right + inches(0.2), inches(2.82), w_col - inches(0.4), inches(0.5),
        [_make_para([_make_run("根因：", sz=950, bold=True, color=C["inkSoft"]),
                     _make_run(" 无 turn budget 管理，无末轮强制收尾机制",
                               sz=950, color=C["ink"])])])

    # 修改
    add_card(tree, x_right, inches(3.5), w_col, inches(1.55),
             C["success"], C["successBg"],
             "修改", [
                 "a. Turn budget 机制：",
                 "   倒数第 2 轮注入 nudge，要求下轮输出 EVIDENCE",
                 "b. 末轮 tool_choice=\"none\"",
                 "   强制 LLM 收尾，不再调用工具",
             ], title_sz=1000, body_sz=900, title_color=C["success"])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_strategy():
    """Slide 3: 4 financial routing skills."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "核心策略：四项金融路由技能",
                    "根据 query 关键词自动注入 route_hints / critical_filings / fallback_searches")

    skills = [
        ("earnings_release_skill", C["success"], C["successBg"],
         "季度业绩 / Guidance / Non-GAAP",
         ["触发词：earnings, revenue, EPS, guidance, press release",
          "动作：强制加入对应季度 8-K + 10-Q",
          "示例：FY2026 Q1 → 20250427_10-Q + 20250528_8-K"]),
        ("sec_filing_skill (H20)", C["fail"], C["failBg"],
         "H20 出口限制 / 中国市场影响",
         ["触发词：H20, China, export, license, gross margin",
          "动作：覆盖 20250409_8-K ~ 20250528_8-K",
          "Fallback grep: H20.*China, unable to ship"]),
        ("proxy_governance_skill", C["amber"], C["amberBg"],
         "股东提案 / 董事会建议 / 投票",
         ["触发词：proposal, stockholder, vote, proxy, AGAINST",
          "动作：覆盖 DEF14A + DEFA14A (含 no-pageindex)",
          "解决 20250604_DEFA14A 被跳过的问题"]),
        ("financial_metric_skill", C["baseline"], C["baselineBg"],
         "年度规模 / Q1-Q3 趋势分析",
         ["触发词：FY2025 annual, Q1-Q3 trend, 增长",
          "动作：覆盖 10-K + 多份 10-Q",
          "确保跨季度对比能获取全部数据"]),
    ]

    card_w = inches(4.35)
    card_h = inches(1.7)
    x_left = inches(0.5)
    x_right = inches(5.15)
    y_top = inches(1.6)
    y_bot = inches(3.45)

    positions = [(x_left, y_top), (x_right, y_top), (x_left, y_bot), (x_right, y_bot)]
    for i, (name, bar_c, bg_c, subtitle, lines) in enumerate(skills):
        px, py = positions[i]
        add_card(tree, px, py, card_w, card_h, bar_c, bg_c,
                 name, lines, title_sz=1050, body_sz=900,
                 title_color=bar_c)
        # Subtitle under title
        add_textbox(tree, px + inches(0.18), py + inches(0.35), card_w - inches(0.3), inches(0.3),
            [_make_para([_make_run(subtitle, sz=950, bold=True, color=C["ink"])])])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_implementation():
    """Slide 4: 5-layer routing enhancement pipeline."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "实现：五层路由增强管线",
                    "从 query 理解到 evidence 输出的完整增强链路")

    layers = [
        ("1", "route_hints", "为 LLM agent 注入领域提示", "语义层", C["success"]),
        ("2", "critical_filings", "强制必查的 filing 清单", "文件层", C["success"]),
        ("3", "fallback_searches", "regex + glob 兜底搜索", "搜索层", C["amber"]),
        ("4", "auto-补证", "漏查 critical filing 时自动注入片段", "修复层", C["fail"]),
        ("5", "filing diversity 排序", "top-k 中优先保留 critical filings", "输出层", C["baseline"]),
    ]

    y_start = inches(1.6)
    row_h = inches(0.68)
    gap = inches(0.08)
    num_w = inches(0.55)
    name_w = inches(2.2)
    desc_w = inches(4.8)
    tag_w = inches(1.2)

    for i, (num, name, desc, tag, color) in enumerate(layers):
        y = y_start + i * (row_h + gap)
        # Number circle (just a colored rect for simplicity)
        add_rect(tree, inches(0.5), y, num_w, row_h, color)
        add_textbox(tree, inches(0.5), y + inches(0.12), num_w, inches(0.4),
            [_make_para([_make_run(num, sz=1800, bold=True, color=C["white"])], align="ctr")])
        # Name
        add_textbox(tree, inches(1.15), y + inches(0.08), name_w, row_h - inches(0.16),
            [_make_para([_make_run(name, sz=1200, bold=True, color=C["ink"])], spc_after=100),
             _make_para([_make_run(desc, sz=950, color=C["inkSoft"])])])
        # Tag
        add_rect(tree, inches(8.3), y + inches(0.15), tag_w, inches(0.36),
                 C["ruleSoft"], C["rule"], pt_to_emu(0.75))
        add_textbox(tree, inches(8.3), y + inches(0.15), tag_w, inches(0.36),
            [_make_para([_make_run(tag, sz=900, color=C["inkSoft"])], align="ctr")])

    # Arrow hints between layers
    for i in range(4):
        y = y_start + (i + 1) * (row_h + gap) - gap
        add_textbox(tree, inches(0.58), y - inches(0.05), inches(0.4), inches(0.2),
            [_make_para([_make_run("↓", sz=1000, color=C["muted"])], align="ctr")])

    # Code block at bottom right showing key config
    code_x = inches(3.8)
    code_y = inches(1.6)
    code_w = inches(4.3)
    code_h = inches(2.1)
    add_rect(tree, code_x, code_y, code_w, code_h, C["navy"])
    add_textbox(tree, code_x + inches(0.15), code_y + inches(0.1),
                code_w - inches(0.3), code_h - inches(0.2),
        [_make_para([_make_run("# _augment_plan_with_route_hints()", sz=900,
                               color=C["navyDim"], font=FONT_CODE)], spc_after=300),
         _make_para([_make_run('plan["route_hints"].append(...)', sz=950,
                               color=C["navyText"], font=FONT_CODE)], spc_after=200),
         _make_para([_make_run('plan["critical_filings"] = [', sz=950,
                               color=C["navyText"], font=FONT_CODE)], spc_after=100),
         _make_para([_make_run('  "20250528_8-K",  # Q1 earnings', sz=950,
                               color=C["navyText"], font=FONT_CODE)], spc_after=100),
         _make_para([_make_run('  "20250827_8-K",  # Q2 earnings', sz=950,
                               color=C["navyText"], font=FONT_CODE)], spc_after=100),
         _make_para([_make_run(']', sz=950,
                               color=C["navyText"], font=FONT_CODE)], spc_after=200),
         _make_para([_make_run('plan["fallback_searches"] = [...]', sz=950,
                               color=C["navyText"], font=FONT_CODE)]),
        ])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_results():
    """Slide 5: Full 30-question evaluation results table."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "完整 30 题评测结果",
                    "对比修改前后 filing recall、precision、hit rate、耗时")

    col_w = [inches(2.2), inches(1.4), inches(1.4), inches(1.4)]
    rows = [
        ["指标", "修改前", "修改后", "变化"],
        ["Mean Filing Recall", "0.772", ("0.894", C["success"], True), ("+0.122", C["success"], True)],
        ["Mean Precision", "0.828", "0.716", ("-0.112", C["fail"], False)],
        ["Hit Any Rate", "0.933", "0.967", ("+0.034", C["success"], False)],
        ["Avg Time (s)", "43.5", "58.5", ("+15.0", C["amber"], False)],
        ["Mean LLM Turns", "8.3", "7.57", ("-0.73", C["success"], False)],
        ["Mean Tool Calls", "9.7", "9.2", ("-0.5", C["success"], False)],
    ]

    row_colors = {
        1: C["successBg"],  # Recall row highlighted
    }

    add_table(tree, inches(0.5), inches(1.6), col_w, rows,
              header_bg=C["ink"], row_colors=row_colors, font_sz=1050, header_font_sz=1050)

    # Big number callout on the right
    add_big_number(tree, inches(7.0), inches(1.8), inches(2.5),
                   "+0.122", "Filing Recall",
                   "0.772 → 0.894",
                   number_color=C["success"], number_sz=4000)

    # Layer breakdown below
    add_textbox(tree, inches(7.0), inches(3.4), inches(2.5), inches(0.3),
        [_make_para([_make_run("分层效果", sz=1100, bold=True, color=C["ink"])])])

    layer_data = [
        ("L0 (简单)", "0.900 → 1.000", "+0.100", C["success"]),
        ("L1 (中等)", "0.617 → 0.800", "+0.183", C["success"]),
        ("L2 (困难)", "0.800 → 0.883", "+0.083", C["success"]),
    ]
    for i, (label, detail, delta, color) in enumerate(layer_data):
        y = inches(3.8) + i * inches(0.42)
        add_textbox(tree, inches(7.0), y, inches(2.5), inches(0.4),
            [_make_para([
                _make_run(label, sz=1000, bold=True, color=C["ink"]),
                _make_run(f"  {delta}", sz=1000, bold=True, color=color),
            ], spc_after=50)])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_targeted():
    """Slide 6: Targeted fix results - case study style."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "重点题 Targeted 评测：4/4 全部修复",
                    "历史反复失败的问题，修改后 mean recall = 1.000")

    cases = [
        ("L0_004", "0.0", "1.0", "Earnings Release",
         "成功命中 20250528_8-K"),
        ("L1_001", "0.33", "1.0", "H20 跨文件",
         "覆盖 20250409_8-K / 20250427_10-Q / 20250528_8-K"),
        ("L1_010", "0.50", "1.0", "Proxy Supplement",
         "命中 no-pageindex 的 20250604_DEFA14A"),
        ("L2_002", "0.0", "1.0", "双 8-K 对比",
         "同时命中 20250528_8-K 和 20250827_8-K"),
    ]

    y_start = inches(1.5)
    card_h = inches(0.85)
    gap = inches(0.12)

    for i, (qid, before, after, category, detail) in enumerate(cases):
        y = y_start + i * (card_h + gap)

        # Left: qid + delta
        add_rect(tree, inches(0.5), y, inches(1.3), card_h, C["successBg"])
        add_textbox(tree, inches(0.55), y + inches(0.05), inches(1.2), card_h,
            [_make_para([_make_run(qid, sz=1100, bold=True, color=C["ink"])], spc_after=100),
             _make_para([
                 _make_run(before, sz=1000, color=C["fail"]),
                 _make_run(" → ", sz=1000, color=C["muted"]),
                 _make_run(after, sz=1000, bold=True, color=C["success"]),
             ])])

        # Right: detail card
        add_card(tree, inches(1.95), y, inches(7.55), card_h,
                 C["success"], C["successBg"],
                 category, detail,
                 title_sz=1050, body_sz=950, title_color=C["success"])

    # Bottom summary callout
    add_rect(tree, inches(0.5), inches(4.55), inches(0.06), inches(0.6), C["success"])
    add_rect(tree, inches(0.56), inches(4.55), inches(8.94), inches(0.6), C["successBg"])
    add_textbox(tree, inches(0.7), inches(4.58), inches(8.7), inches(0.55),
        [_make_para([
            _make_run("Targeted 评测总结：", sz=1050, bold=True, color=C["success"]),
            _make_run("  4 题全部 recall=1.0，hit_any=100%，验证 hard routing guardrails 有效",
                      sz=1050, color=C["ink"]),
        ])])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_tradeoffs():
    """Slide 7: Trade-offs - precision vs recall, latency."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "代价与权衡",
                    "从 \"少而准\" 转向 \"保证关键证据覆盖\" 的自然结果")

    # Left column: trade-off cards
    x_left = inches(0.5)
    w_half = inches(4.35)

    # Precision drop
    add_card(tree, x_left, inches(1.6), w_half, inches(1.5),
             C["fail"], C["failBg"],
             "Precision 下降", [
                 "0.828 → 0.716 (-0.112)",
                 "策略主动补充相关 8-K / 10-Q / DEFA14A",
                 "多拿证据对答案正确性通常是正向的",
             ], title_sz=1100, body_sz=950)

    # Latency increase
    add_card(tree, x_left, inches(3.3), w_half, inches(1.5),
             C["amber"], C["amberBg"],
             "耗时上升", [
                 "43.5s → 58.5s (+15.0s)",
                 "更多 form type 被强制探索",
                 "no-pageindex 文件需要 ripgrep / read_file",
             ], title_sz=1100, body_sz=950)

    # Right column: why acceptable
    x_right = inches(5.15)
    add_rect(tree, x_right, inches(1.6), w_half, inches(3.2), C["ruleSoft"])
    add_textbox(tree, x_right + inches(0.2), inches(1.7), w_half - inches(0.4), inches(3.0),
        [_make_para([_make_run("为什么可接受", sz=1200, bold=True, color=C["ink"])], spc_after=600),
         _make_para([_make_run("1. ", sz=1050, bold=True, color=C["success"]),
                     _make_run("金融问答需要可解释的证据链，recall 优先于 precision",
                               sz=1050, color=C["inkSoft"])], spc_after=400),
         _make_para([_make_run("2. ", sz=1050, bold=True, color=C["success"]),
                     _make_run("返回 10-Q + 8-K 并非 \"不相关\"，当前 precision 指标过于严格",
                               sz=1050, color=C["inkSoft"])], spc_after=400),
         _make_para([_make_run("3. ", sz=1050, bold=True, color=C["success"]),
                     _make_run("耗时增加在 15s 以内，用户体验影响有限",
                               sz=1050, color=C["inkSoft"])], spc_after=400),
         _make_para([_make_run("4. ", sz=1050, bold=True, color=C["success"]),
                     _make_run("LLM turns 和 tool calls 反而减少，路由更精准",
                               sz=1050, color=C["inkSoft"])]),
        ])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_next():
    """Slide 8: Next steps."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["navy"])
    tree = _sp_tree()
    cSld.append(tree)

    add_textbox(tree, inches(0.6), inches(0.5), inches(8.8), inches(0.6),
        [_make_para([_make_run("后续方向", sz=2400, bold=True, color=C["navyText"])])])

    steps = [
        ("1", "Route Metadata 自动化",
         "从硬编码字典迁移为 corpus 构建阶段自动抽取 earnings release / reported quarter / proxy supplement"),
        ("2", "评测指标细化",
         "拆分 must_hit_recall 和 acceptable_support_recall，避免全部 candidate filings 被当硬命中"),
        ("3", "Precision 白名单归一化",
         "earnings 问题同时返回 10-Q + 8-K 不应被视为低 precision"),
        ("4", "No-PageIndex 文件补建索引",
         "为 DEFA14A 等文件补建轻量 pageindex 或 title-summary，减少全文 grep 耗时"),
        ("5", "完整 30 题终验",
         "纳入 Q2 / FY2025 / Q1-Q3 route 修正后的最终全量评测"),
    ]

    y_start = inches(1.4)
    card_h = inches(0.72)
    gap = inches(0.1)
    for i, (num, title, desc) in enumerate(steps):
        y = y_start + i * (card_h + gap)
        # Number
        add_textbox(tree, inches(0.6), y + inches(0.05), inches(0.5), inches(0.5),
            [_make_para([_make_run(num, sz=2000, bold=True, color=C["success"])], align="ctr")])
        # Title + desc
        add_textbox(tree, inches(1.2), y, inches(8.2), card_h,
            [_make_para([_make_run(title, sz=1150, bold=True, color=C["navyText"])], spc_after=150),
             _make_para([_make_run(desc, sz=950, color=C["navyDim"])])])

        if i < len(steps) - 1:
            add_line(tree, inches(1.2), y + card_h, inches(9.0), y + card_h,
                     C["navyDim"], w=3175)

    # Bottom
    add_textbox(tree, inches(0.6), inches(5.0), inches(8.8), inches(0.4),
        [_make_para([_make_run("颜色要有含义，留白要有自信，强调要节制。",
                               sz=1100, bold=True, color=C["navyDim"])], align="ctr")])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__", color=C["navyDim"])
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


# ── Generalization evaluation slides ─────────────────────────────────────────

def build_slide_generalization_overview():
    """Zero-shot generalization: 30 new questions, no tuning."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "泛化验证：30 道全新题 · 零优化",
                    "扩展数据集中选取 30 题直接评测，不做任何针对性调整")

    # Left: key metrics
    add_big_number(tree, inches(0.5), inches(1.5), inches(2.8),
                   "0.833", "Mean Filing Recall", "30 题完整评测",
                   number_color=C["success"], number_sz=3600)

    add_big_number(tree, inches(0.5), inches(3.0), inches(2.8),
                   "0.867", "Hit Any Rate", "26/30 至少命中一个 filing",
                   number_color=C["success"], number_sz=3600)

    add_big_number(tree, inches(0.5), inches(4.3), inches(2.8),
                   "24/30", "完整命中", "全部 expected filing 都找到",
                   number_color=C["success"], number_sz=2800)

    # Right: breakdown
    add_textbox(tree, inches(3.8), inches(1.45), inches(5.7), inches(0.35),
        [_make_para([_make_run("结果分布", sz=1200, bold=True, color=C["ink"])])])

    col_w = [inches(1.5), inches(0.8), inches(3.2)]
    rows = [
        ["类别", "题数", "说明"],
        [("完整命中", C["success"], True), ("24", C["success"], True),
         "expected filing 全部检索到"],
        [("部分命中", C["amber"], False), ("2", C["amber"], False),
         "命中部分 filing (recall=0.5)"],
        [("未命中", C["fail"], False), ("3", C["fail"], False),
         "路由偏差或时间语义错误"],
        [("超时", C["fail"], False), ("1", C["fail"], False),
         "检索方向正确但 LLM 调用超时"],
    ]
    row_colors = {1: C["successBg"]}
    add_table(tree, inches(3.8), inches(1.85), col_w, rows,
              header_bg=C["ink"], row_colors=row_colors, font_sz=1000, header_font_sz=1000)

    # Bottom callout
    add_rect(tree, inches(0.5), inches(4.85), inches(0.06), inches(0.55), C["success"])
    add_rect(tree, inches(0.56), inches(4.85), inches(8.94), inches(0.55), C["successBg"])
    add_textbox(tree, inches(0.7), inches(4.88), inches(8.7), inches(0.5),
        [_make_para([
            _make_run("关键结论：", sz=1050, bold=True, color=C["success"]),
            _make_run("路由增强架构在全新题目上直接泛化，无需逐题优化。", sz=1050, color=C["ink"]),
            _make_run(" H20、8-K earnings、薪酬、网络安全、shelf registration 等场景均稳定命中。",
                      sz=950, color=C["inkSoft"]),
        ])])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_generalization_errors():
    """Error analysis for the 4 failed + 2 partial questions."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["white"])
    tree = _sp_tree()
    cSld.append(tree)

    add_page_header(tree, "失败模式分析：6 道未完整命中",
                    "4 道未命中 + 2 道部分命中，归纳为三类边界问题")

    # 3 categories of failures
    y_start = inches(1.5)

    # Category 1: Timeout
    add_card(tree, inches(0.5), y_start, inches(9.0), inches(0.85),
             C["baseline"], C["baselineBg"],
             "超时 (1 题)", [
                 "L0_E007：模型已读到 20250625_8-K voting results 表，但最后一次 LLM 调用超时",
                 "检索方向完全正确，属于稳定性问题而非路由错误",
             ], title_sz=1050, body_sz=900)

    # Category 2: Time semantics
    add_card(tree, inches(0.5), y_start + inches(0.97), inches(9.0), inches(1.15),
             C["amber"], C["amberBg"],
             "时间语义偏差 (2 题)", [
                 "L0_E030：\"Blackwell Ultra 计划在 Q2 FY2026 出货\" → 展望在 Q1 文件，但检索去了 Q2 文件",
                 "L0_E016：返回 20251119_8-K (事实正确) 但 expected 是 20251026_10-Q",
                 "核心问题：\"Q2 的展望\" 发布于 Q1 文件 vs \"Q2 的结果\" 在 Q2 文件",
             ], title_sz=1050, body_sz=900)

    # Category 3: Name/governance
    add_card(tree, inches(0.5), y_start + inches(2.24), inches(9.0), inches(1.0),
             C["fail"], C["failBg"],
             "人名/治理路由 (1 题 + 2 partial)", [
                 "L0_E008：\"Ellen Ochoa 离开董事会\" 被人名吸到投票表，漏掉 departure 事件的 8-K",
                 "L0_E013 / L0_E024：命中主要 filing 但漏掉补充 filing (recall=0.5)",
                 "需要事件动词 (resignation/departure) 作为强约束，而非仅靠人名匹配",
             ], title_sz=1050, body_sz=900)

    # Bottom: why these are edge cases
    add_rect(tree, inches(0.5), inches(4.65), inches(9.0), inches(0.55), C["ruleSoft"])
    add_textbox(tree, inches(0.65), inches(4.68), inches(8.7), inches(0.5),
        [_make_para([
            _make_run("共性：", sz=1050, bold=True, color=C["ink"]),
            _make_run("这 6 题全部属于原 30 题训练集中未覆盖的边界场景。", sz=1050, color=C["inkSoft"]),
            _make_run(" 24/30 的稳定命中说明核心路由架构已具备跨场景泛化能力。",
                      sz=1050, color=C["success"]),
        ])])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__")
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


def build_slide_architecture_advantage():
    """Architecture advantage summary — why zero-shot works."""
    sld = E("p:sld")
    cSld = SE(sld, "p:cSld")
    set_slide_bg(cSld, C["navy"])
    tree = _sp_tree()
    cSld.append(tree)

    add_textbox(tree, inches(0.6), inches(0.45), inches(8.8), inches(0.9),
        [_make_para([_make_run("架构优越性：为什么能零优化泛化", sz=2200, bold=True,
                               color=C["navyText"])], spc_after=300),
         _make_para([_make_run("路由增强设计面向 \"金融披露模式\" 而非 \"具体题目\"",
                               sz=1300, color=C["navyDim"])])])

    advantages = [
        ("1", "金融技能抽象层",
         "earnings_release / sec_filing / proxy_governance / financial_metric 四项技能覆盖 SEC 披露的核心模式，新题自动匹配",
         C["success"]),
        ("2", "Manifest 语义过滤",
         "reported_fiscal_period + event_tag 让 agent 按 \"文件讨论什么\" 而非 \"文件何时提交\" 检索，天然适应新 query",
         C["success"]),
        ("3", "Critical Filing 兜底",
         "auto-补证 + filing diversity 排序确保关键文件不因 LLM 遗忘而丢失，对 unseen 题同样有效",
         C["success"]),
        ("4", "Hypothesis-not-Commitment",
         "Plan 重写为 \"假设而非承诺\"，agent 可根据实际搜索结果动态调整，不被错误 plan 锁死",
         C["success"]),
    ]

    y_start = inches(1.7)
    card_h = inches(0.82)
    gap = inches(0.08)
    for i, (num, title, desc, color) in enumerate(advantages):
        y = y_start + i * (card_h + gap)
        add_textbox(tree, inches(0.6), y + inches(0.08), inches(0.5), inches(0.5),
            [_make_para([_make_run(num, sz=2000, bold=True, color=color)], align="ctr")])
        add_textbox(tree, inches(1.2), y, inches(8.2), card_h,
            [_make_para([_make_run(title, sz=1150, bold=True, color=C["navyText"])], spc_after=150),
             _make_para([_make_run(desc, sz=950, color=C["navyDim"])])])
        if i < len(advantages) - 1:
            add_line(tree, inches(1.2), y + card_h, inches(9.0), y + card_h,
                     C["navyDim"], w=3175)

    # Bottom metrics comparison
    add_rect(tree, inches(0.5), inches(4.55), inches(4.0), inches(0.7), C["successBg"])
    add_rect(tree, inches(0.5), inches(4.55), inches(0.06), inches(0.7), C["success"])
    add_textbox(tree, inches(0.7), inches(4.58), inches(3.7), inches(0.65),
        [_make_para([_make_run("原 30 题 (有优化)", sz=1000, bold=True, color=C["success"])], spc_after=150),
         _make_para([_make_run("recall 0.894 / hit_any 0.967", sz=1050, bold=True, color=C["navyText"])]),
        ])

    add_rect(tree, inches(5.1), inches(4.55), inches(4.4), inches(0.7), C["successBg"])
    add_rect(tree, inches(5.1), inches(4.55), inches(0.06), inches(0.7), C["success"])
    add_textbox(tree, inches(5.3), inches(4.58), inches(4.1), inches(0.65),
        [_make_para([_make_run("新 30 题 (零优化)", sz=1000, bold=True, color=C["success"])], spc_after=150),
         _make_para([_make_run("recall 0.833 / hit_any 0.867", sz=1050, bold=True, color=C["navyText"])]),
        ])

    add_footer(tree, "DCI-PageIndex 路由增强", "__PAGE__", color=C["navyDim"])
    SE(sld, "p:clrMapOvr").append(E("a:masterClrMapping"))
    return sld


# ── Package into PPTX ────────────────────────────────────────────────────────
def build_pptx(out_path):
    slides = [
        build_slide_cover,
        build_slide_week_overview,
        build_slide_verification,
        build_slide_expansion,
        build_slide_eval_180,
        build_slide_l0002_deep,
        build_slide_problem,
        build_slide_defect_overview,
        build_slide_defect_ab,
        build_slide_defect_cd,
        build_slide_strategy,
        build_slide_implementation,
        build_slide_results,
        build_slide_targeted,
        build_slide_tradeoffs,
        build_slide_generalization_overview,
        build_slide_generalization_errors,
        build_slide_architecture_advantage,
        build_slide_next,
    ]

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # ── [Content_Types].xml ──
        types = E("ct:Types", {"xmlns": NS["ct"]})
        SE(types, "ct:Default", {"Extension": "rels", "ContentType": "application/vnd.openxmlformats-package.relationships+xml"})
        SE(types, "ct:Default", {"Extension": "xml", "ContentType": "application/xml"})
        SE(types, "ct:Override", {"PartName": "/ppt/presentation.xml",
            "ContentType": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"})
        SE(types, "ct:Override", {"PartName": "/ppt/theme/theme1.xml",
            "ContentType": "application/vnd.openxmlformats-officedocument.theme+xml"})
        SE(types, "ct:Override", {"PartName": "/ppt/slideMasters/slideMaster1.xml",
            "ContentType": "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"})
        SE(types, "ct:Override", {"PartName": "/ppt/slideLayouts/slideLayout1.xml",
            "ContentType": "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"})
        for i in range(len(slides)):
            SE(types, "ct:Override", {"PartName": f"/ppt/slides/slide{i+1}.xml",
                "ContentType": "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"})
        # Use expanded namespace for Content_Types
        ct_raw = tostring(types, encoding="unicode")
        ct_raw = ct_raw.replace(f'{{{NS["ct"]}}}', '')
        ct_raw = ct_raw.replace(f'xmlns:ns0="{NS["ct"]}"', f'xmlns="{NS["ct"]}"')
        # Fix: just rebuild properly
        ct_xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        ct_xml += f'<Types xmlns="{NS["ct"]}">'
        ct_xml += f'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        ct_xml += f'<Default Extension="xml" ContentType="application/xml"/>'
        ct_xml += f'<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        ct_xml += f'<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        ct_xml += f'<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        ct_xml += f'<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        for i in range(len(slides)):
            ct_xml += f'<Override PartName="/ppt/slides/slide{i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        ct_xml += '</Types>'
        zf.writestr("[Content_Types].xml", ct_xml.encode("utf-8"))

        # ── _rels/.rels ──
        rels_xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        rels_xml += f'<Relationships xmlns="{NS["rel"]}">'
        rels_xml += f'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>'
        rels_xml += '</Relationships>'
        zf.writestr("_rels/.rels", rels_xml.encode("utf-8"))

        # ── ppt/presentation.xml ──
        pres = E("p:presentation", {"saveSubsetFonts": "1"})
        smsIdLst = SE(pres, "p:sldMasterIdLst")
        SE(smsIdLst, "p:sldMasterId", {"id": "2147483648", _ns("r:id"): "rId1"})
        sIdLst = SE(pres, "p:sldIdLst")
        for i in range(len(slides)):
            SE(sIdLst, "p:sldId", {"id": str(256 + i), _ns("r:id"): f"rId{i+10}"})
        sldSz = SE(pres, "p:sldSz", {"cx": str(SLIDE_W), "cy": str(SLIDE_H), "type": "custom"})
        notesSz = SE(pres, "p:notesSz", {"cx": str(SLIDE_H), "cy": str(SLIDE_W)})
        zf.writestr("ppt/presentation.xml", xml_bytes(pres))

        # ── ppt/_rels/presentation.xml.rels ──
        prels = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        prels += f'<Relationships xmlns="{NS["rel"]}">'
        prels += f'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
        prels += f'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
        for i in range(len(slides)):
            prels += f'<Relationship Id="rId{i+10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{i+1}.xml"/>'
        prels += '</Relationships>'
        zf.writestr("ppt/_rels/presentation.xml.rels", prels.encode("utf-8"))

        # ── Theme ──
        zf.writestr("ppt/theme/theme1.xml", xml_bytes(build_theme()))

        # ── Slide Master ──
        sm = E("p:sldMaster")
        sm_cSld = SE(sm, "p:cSld")
        sm_bg = SE(sm_cSld, "p:bg")
        sm_bgpr = SE(sm_bg, "p:bgRef", {"idx": "1001"})
        SE(sm_bgpr, "a:schemeClr", {"val": "bg1"})
        sm_tree = _sp_tree()
        sm_cSld.append(sm_tree)
        sm_cm = SE(sm, "p:clrMap", {
            "bg1": "lt1", "tx1": "dk1", "bg2": "lt2", "tx2": "dk2",
            "accent1": "accent1", "accent2": "accent2", "accent3": "accent3",
            "accent4": "accent4", "accent5": "accent5", "accent6": "accent6",
            "hlink": "hlink", "folHlink": "folHlink"
        })
        sm_sll = SE(sm, "p:sldLayoutIdLst")
        SE(sm_sll, "p:sldLayoutId", {"id": "2147483649", _ns("r:id"): "rId1"})
        zf.writestr("ppt/slideMasters/slideMaster1.xml", xml_bytes(sm))

        # ── Slide Master rels ──
        smrels = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        smrels += f'<Relationships xmlns="{NS["rel"]}">'
        smrels += f'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
        smrels += f'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>'
        smrels += '</Relationships>'
        zf.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", smrels.encode("utf-8"))

        # ── Slide Layout ──
        sl = E("p:sldLayout", {"type": "blank", "preserve": "1"})
        sl_cSld = SE(sl, "p:cSld", {"name": "Blank"})
        sl_cSld.append(_sp_tree())
        SE(sl, "p:clrMapOvr").append(E("a:masterClrMapping"))
        zf.writestr("ppt/slideLayouts/slideLayout1.xml", xml_bytes(sl))

        # ── Slide Layout rels ──
        slrels = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        slrels += f'<Relationships xmlns="{NS["rel"]}">'
        slrels += f'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
        slrels += '</Relationships>'
        zf.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", slrels.encode("utf-8"))

        # ── Slides ──
        total = len(slides)
        for i, builder in enumerate(slides):
            _shape_id[0] = 1  # reset per slide
            sld_xml = builder()
            raw = xml_bytes(sld_xml).decode("utf-8")
            raw = raw.replace("__PAGE__", f"{i+1} / {total}")
            zf.writestr(f"ppt/slides/slide{i+1}.xml", raw.encode("utf-8"))
            # slide rels
            srels = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            srels += f'<Relationships xmlns="{NS["rel"]}">'
            srels += f'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
            srels += '</Relationships>'
            zf.writestr(f"ppt/slides/_rels/slide{i+1}.xml.rels", srels.encode("utf-8"))

    print(f"Done: {out_path}  ({os.path.getsize(out_path)} bytes)")


if __name__ == "__main__":
    build_pptx("DCI_PageIndex_路由增强_报告.pptx")
