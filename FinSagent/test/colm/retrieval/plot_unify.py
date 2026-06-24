#!/usr/bin/env python3
"""
Combined 1x3 subplot figure for ICML:
1) Agent activation (count & percentage)
2) GT chunks retrieved (exclusive vs shared) with PIECEWISE nonlinear x-axis
3) Pairwise co-retrieval heatmap

Designed for single-column ICML figures (full text-width ~6.75 inches).
"""
import argparse
import importlib.util
from collections import Counter
from pathlib import Path
from types import ModuleType

import numpy as np
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors

# ── defaults ────────────────────────────────────────────────────────────
DEFAULT_RESULTS_ROOT = Path(
    "/root/autodl-tmp/cjj/FinSagent_0212/test/e2e/"
    "0322_force_general_lightgbm_new_calibrate_ts10_fb_table_rerun"
)
DEFAULT_GT_ROOT = Path("/root/autodl-tmp/cjj/FinSagent_0212/test/gt")
DEFAULT_OUTPUT_PATH = Path(
    "/root/autodl-tmp/cjj/FinSagent_0212/test/colm/retrieval/agent_combined_analysis.pdf"
)
DEFAULT_ANALYSIS_SCRIPT = Path(
    "/root/autodl-tmp/cjj/FinSagent_0212/test/colm/retrieval/analyze_agent_ablation.py"
)
DEFAULT_DATASETS = ["zeekr", "lotus", "secque", "finder", "financebench"]
DEFAULT_AGENTS = ["general", "quant", "market_researcher", "company_researcher", "legal_risk"]

AGENT_LABELS = {
    "general":            "General",
    "quant":              "Quantitative",
    "market_researcher":  "Market",
    "company_researcher": "Company",
    "legal_risk":         "Legal",
}

# Colors
COLOR_EXCLUSIVE  = "#2b6ca3"
COLOR_SHARED     = "#a8cce4"
COLOR_ACTIVATION = "#4a7bb7"

# ICML full text width ≈ 6.75 in
FIG_WIDTH  = 6.75
FIG_HEIGHT = 2.45


# ── CLI ─────────────────────────────────────────────────────────────────
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--results-root",    type=Path, default=DEFAULT_RESULTS_ROOT)
    p.add_argument("--gt-root",         type=Path, default=DEFAULT_GT_ROOT)
    p.add_argument("--analysis-script", type=Path, default=DEFAULT_ANALYSIS_SCRIPT)
    p.add_argument("--datasets", nargs="+", default=list(DEFAULT_DATASETS))
    p.add_argument("--agents",   nargs="+", default=list(DEFAULT_AGENTS))
    p.add_argument("--output-path", type=Path, default=DEFAULT_OUTPUT_PATH)
    p.add_argument("--dpi", type=int, default=300)
    p.add_argument("--run-number", type=int, default=5)
    return p.parse_args()


# ── helpers ─────────────────────────────────────────────────────────────
def load_analysis_module(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("agent_ablation_analysis", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load analysis module from {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── unified data collection ─────────────────────────────────────────────
def collect_all_stats(
    analysis: ModuleType,
    results_root: Path,
    gt_root: Path,
    datasets: list[str],
    run_number: int,
    agents: list[str],
) -> dict:
    agg_patterns: Counter[tuple[str, ...]] = Counter()
    agg_hits: Counter[str] = Counter()
    agg_only: Counter[str] = Counter()
    activation: Counter[str] = Counter()
    total_gt = covered_gt = total_questions = 0

    for ds in datasets:
        gt_path = analysis.get_gt_path(gt_root, ds)
        res_path = analysis.find_result_path(results_root, ds, run_number)
        if res_path is None:
            continue
        
        gt_items = analysis.load_json(gt_path)
        results_by_q = analysis.build_question_map(analysis.load_jsonl(res_path))

        for gt_item in gt_items:
            q = analysis.get_question(gt_item)
            gt_chunks = analysis.extract_gt_chunks(gt_item)
            if not q or not gt_chunks:
                continue
            entry = results_by_q.get(q)
            if entry is None:
                continue
            total_questions += 1

            for a in agents:
                if len(entry.get("per_agent_texts", {}).get(a, [])) > 0:
                    activation[a] += 1

            for gc in gt_chunks:
                total_gt += 1
                matched = [
                    a for a in agents
                    if any(
                        analysis.chunks_match(gc.get("text", ""), t)
                        for t in entry.get("per_agent_texts", {}).get(a, [])
                    )
                ]
                if not matched:
                    continue
                
                covered_gt += 1
                key = tuple(sorted(matched))
                agg_patterns[key] += 1
                
                for a in matched:
                    agg_hits[a] += 1
                if len(matched) == 1:
                    agg_only[matched[0]] += 1

    return {
        "agents": agents,
        "total_questions": total_questions,
        "total_gt": total_gt,
        "covered_gt": covered_gt,
        "hit_counts":        {a: agg_hits.get(a, 0)   for a in agents},
        "exclusive_counts":  {a: agg_only.get(a, 0)   for a in agents},
        "shared_counts":     {a: agg_hits.get(a, 0) - agg_only.get(a, 0) for a in agents},
        "activation_counts": {a: activation.get(a, 0) for a in agents},
        "agent_only_counts": {a: agg_only.get(a, 0)   for a in agents},
        "exclusive_pattern_counts": {
            "|".join(p): c
            for p, c in sorted(agg_patterns.items(), key=lambda x: (len(x[0]), x[0]))
        },
    }


# ── figure styling ──────────────────────────────────────────────────────
def configure_style() -> None:
    plt.rcParams.update({
        "font.family":      "serif",
        "font.serif":       ["Times New Roman", "DejaVu Serif", "serif"],
        "mathtext.fontset": "stix",
        "font.size":        9,
        "axes.titlesize":   10,
        "axes.labelsize":   9,
        "xtick.labelsize":  8,
        "ytick.labelsize":  8,
        "legend.fontsize":  8,
        "pdf.fonttype":     42,
        "ps.fonttype":      42,
        "axes.linewidth":   0.5,
        "figure.dpi":       150,
    })

def format_bar_axes(ax: plt.Axes) -> None:
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_visible(False)
    ax.spines["bottom"].set_color("#888888")
    ax.tick_params(axis="y", length=0)
    ax.tick_params(axis="x", color="#888888")
    ax.grid(axis="x", color="#E0E0E0", alpha=0.7, linewidth=0.4, zorder=0)
    ax.set_axisbelow(True)


# ── Subplot 1: Activation ───────────────────────────────────────────────
def draw_activation_chart(ax: plt.Axes, stats: dict) -> None:
    agents = stats["agents"]
    n = len(agents)
    y = np.arange(n, dtype=float)
    # 增加柱子厚度，减少垂直方向的空白
    bar_height = 0.75  
    
    activations = [stats["activation_counts"][a] for a in agents]
    total_q = stats["total_questions"]

    bars = ax.barh(
        y, activations, height=bar_height,
        color=COLOR_ACTIVATION, edgecolor="white", linewidth=0.4, zorder=3
    )

    x_max = max(activations) if activations else 1
    for i, rect in enumerate(bars):
        w = rect.get_width()
        pct = (w / total_q * 100) if total_q else 0
        text = f"{int(w)} ({pct:.0f}%)"
        ax.text(
            w + x_max * 0.03, y[i], text,
            va="center", ha="left", fontsize=8, color="#333333"
        )

    ylabels = [AGENT_LABELS.get(a, a.title()) for a in agents]
    ax.set_yticks(y)
    ax.set_yticklabels(ylabels)
    ax.invert_yaxis()
    
    format_bar_axes(ax)
    ax.set_xlim(0, x_max * 1.35)
    ax.set_xlabel("Questions Activated")
    ax.set_title("(a) Agent Activation", pad=20)


# ── Subplot 2: GT Contribution (Piecewise Linear) ───────────────────────
def draw_contribution_chart(ax: plt.Axes, stats: dict) -> None:
    agents = stats["agents"]
    n = len(agents)
    y = np.arange(n, dtype=float)
    bar_height = 0.75  # 与左图保持一致

    exclusive = [stats["exclusive_counts"][a] for a in agents]
    total_hit = [stats["hit_counts"][a]       for a in agents]

    # --- 核心修改：分段坐标轴映射 (Piecewise Mapping) ---
    # 规则: 0~500 保持原比例，>500 的部分压缩为原来的 25% 长度
    BREAK_POINT = 500
    COMPRESS_RATIO = 0.25

    def scale_val(val):
        if val <= BREAK_POINT:
            return val
        else:
            return BREAK_POINT + (val - BREAK_POINT) * COMPRESS_RATIO

    # 计算映射后的宽度
    exc_scaled = [scale_val(v) for v in exclusive]
    tot_scaled = [scale_val(v) for v in total_hit]
    shr_scaled = [t - e for t, e in zip(tot_scaled, exc_scaled)]

    ax.barh(
        y, exc_scaled, height=bar_height,
        color=COLOR_EXCLUSIVE, edgecolor="white", linewidth=0.4,
        label="Exclusive", zorder=3,
    )
    ax.barh(
        y, shr_scaled, height=bar_height, left=exc_scaled,
        color=COLOR_SHARED, edgecolor="white", linewidth=0.4,
        label="Shared", zorder=3,
    )

    x_max_scaled = max(tot_scaled) if tot_scaled else 1

    for i in range(n):
        # Exclusive数字：够宽就在正中间，极窄（如27）就在旁边
        if exclusive[i] > 40:  
            ax.text(
                scale_val(exclusive[i] / 2), y[i], str(exclusive[i]),
                va="center", ha="center", fontsize=7.5, color="white", fontweight="bold", zorder=4
            )
        elif exclusive[i] > 0:
            ax.text(
                scale_val(exclusive[i]) + x_max_scaled * 0.015, y[i], str(exclusive[i]),
                va="center", ha="left", fontsize=7.5, color=COLOR_EXCLUSIVE, fontweight="bold", zorder=4
            )
            
        # Total hit 永远标在缩放后的终点外面
        ax.text(
            tot_scaled[i] + x_max_scaled * 0.02, y[i], str(total_hit[i]),
            va="center", ha="left", fontsize=8, color="#333333"
        )

    ax.set_yticks(y)
    ax.set_yticklabels([])
    ax.invert_yaxis()
    format_bar_axes(ax)

    # 绘制自定义的非线性 X 轴刻度
    raw_ticks = [0, 250, 500, 1000]
    scaled_ticks = [scale_val(t) for t in raw_ticks]
    ax.set_xticks(scaled_ticks)
    ax.set_xticklabels([str(t) for t in raw_ticks])

    # 画一条虚线提示断点
    ax.axvline(BREAK_POINT, color="#bbbbbb", linestyle="--", linewidth=0.8, zorder=0)

    ax.set_xlim(0, x_max_scaled * 1.15)
    ax.set_xlabel("GT Chunks Retrieved")
    ax.set_title("(b) GT Chunk Contribution", pad=20)
    
    ax.legend(
        loc="lower center", bbox_to_anchor=(0.5, 1.01),
        ncol=2, frameon=False, fontsize=8, handletextpad=0.3, columnspacing=1.0
    )


# ── Subplot 3: Heatmap ──────────────────────────────────────────────────
def draw_pairwise_heatmap(ax: plt.Axes, stats: dict) -> None:
    agents = stats["agents"]
    n = len(agents)
    matrix = np.zeros((n, n), dtype=int)

    for i, a in enumerate(agents):
        matrix[i, i] = stats["agent_only_counts"].get(a, 0)

    for pat_str, count in stats["exclusive_pattern_counts"].items():
        if not pat_str:
            continue
        pat_agents = pat_str.split("|")
        for i, a1 in enumerate(agents):
            for j, a2 in enumerate(agents):
                if i != j and a1 in pat_agents and a2 in pat_agents:
                    matrix[i, j] += count

    cmap = mcolors.LinearSegmentedColormap.from_list(
        "blue_seq", ["#f0f4fa", "#4a7bb7", "#1a3a5c"]
    )
    ax.imshow(matrix, cmap=cmap, aspect="equal")

    labels = [AGENT_LABELS.get(a, a.title()) for a in agents]
    ax.set_xticks(np.arange(n))
    ax.set_yticks(np.arange(n))
    ax.set_xticklabels(labels, rotation=35, ha="right", fontsize=8)
    ax.set_yticklabels(labels, fontsize=8) 

    for spine in ax.spines.values():
        spine.set_visible(False)

    ax.set_xticks(np.arange(n + 1) - 0.5, minor=True)
    ax.set_yticks(np.arange(n + 1) - 0.5, minor=True)
    ax.grid(which="minor", color="white", linewidth=1.5)
    ax.tick_params(which="minor", bottom=False, left=False)
    ax.tick_params(which="major", bottom=False, left=False)

    threshold = matrix.max() / 2.0
    for i in range(n):
        for j in range(n):
            val = matrix[i, j]
            if val > 0:
                color = "white" if val > threshold else "black"
                weight = "bold" if i == j else "normal"
                ax.text(
                    j, i, str(val),
                    ha="center", va="center",
                    color=color, fontsize=8, fontweight=weight,
                )
    
    ax.set_title("(c) Co-Retrieval Heatmap", pad=20)


# ── main ────────────────────────────────────────────────────────────────
def main() -> None:
    args = parse_args()
    analysis = load_analysis_module(args.analysis_script)

    print("Collecting integrated stats...")
    stats = collect_all_stats(
        analysis, args.results_root, args.gt_root,
        list(args.datasets), args.run_number, list(args.agents),
    )

    configure_style()
    
    # 修改横向占比：给中间图（1.4）更多的宽度空间
    fig, (ax1, ax2, ax3) = plt.subplots(
        1, 3, 
        figsize=(FIG_WIDTH, FIG_HEIGHT),
        gridspec_kw={'width_ratios': [0.95, 1.4, 1.05]}
    )
    
    draw_activation_chart(ax1, stats)
    draw_contribution_chart(ax2, stats)
    draw_pairwise_heatmap(ax3, stats)

    # 降低子图间的横向间距，把宝贵的空间让给柱状图
    plt.tight_layout(w_pad=0.2)
    
    args.output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.output_path, dpi=args.dpi, bbox_inches="tight")
    print(f"\nSuccess! Wrote 1x3 combined plot → {args.output_path}")


if __name__ == "__main__":
    main()
