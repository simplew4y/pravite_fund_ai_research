import json
import matplotlib.pyplot as plt
from pathlib import Path
from collections import defaultdict

# ── 1. Read data ──────────────────────────────────────────────
path = Path('/root/autodl-tmp/cjj/FinSagent_0212/test/colm/ablation/lambda/agent_lambda_ablation_20260330_130534.json')

with path.open('r', encoding='utf-8') as f:
    data = json.load(f)

experiments = data['experiments']
by_dataset = defaultdict(lambda: defaultdict(list))

for e in experiments:
    by_dataset[e['dataset']][e['target_agent']].append(e)

# ── 2. Extract per-agent curves ───────────────────────────────
# Display name mapping & style config
style_map = {
    'company_researcher': {'label': 'Company Researcher', 'marker': 'o', 'color': '#1f77b4'},
    'quant':              {'label': 'Quant',              'marker': 's', 'color': '#ff7f0e'},
    'market_researcher':  {'label': 'Market Researcher',  'marker': '^', 'color': '#2ca02c'},
    'legal_risk':         {'label': 'Legal Risk',         'marker': 'D', 'color': '#d62728'},
}

for dataset in sorted(by_dataset):
    agent_curves = {}
    print(f'DATASET\t{dataset}')

    for agent in sorted(by_dataset[dataset]):
        vals = sorted(by_dataset[dataset][agent], key=lambda x: float(x['lambda_value']))
        lambdas = [float(v['lambda_value']) for v in vals]
        micro   = [v['replay_summary']['micro_recall'] for v in vals]
        n       = vals[0]['records_evaluated']
        agent_curves[agent] = {'lambdas': lambdas, 'micro': micro, 'n': n}

        print(f'AGENT\t{agent}')
        print('lambda\tn\treplay_micro\treplay_macro\treplay_jaccard\tdelta_micro\tdelta_macro\tdelta_jaccard')
        for e in vals:
            rs, ds = e['replay_summary'], e['delta_summary']
            print(f"{float(e['lambda_value']):.1f}\t{e['records_evaluated']}\t"
                  f"{rs['micro_recall']:.4f}\t{rs['macro_recall']:.4f}\t{rs['avg_jaccard']:.4f}\t"
                  f"{ds['micro_recall']:.4f}\t{ds['macro_recall']:.4f}\t{ds['avg_jaccard']:.4f}")

        zero = next((v for v in vals if abs(float(v['lambda_value'])) < 1e-12), None)
        nonzero_vals = [v for v in vals if float(v['lambda_value']) > 0]
        if zero is not None and nonzero_vals:
            best_nz = max(nonzero_vals,
                          key=lambda e: (e['replay_summary']['micro_recall'],
                                         e['replay_summary']['macro_recall'],
                                         e['replay_summary']['avg_jaccard']))
            zrs, brs = zero['replay_summary'], best_nz['replay_summary']
            print('BEST_NONZERO', best_nz['lambda_value'], best_nz['records_evaluated'],
                  brs['micro_recall'], brs['macro_recall'], brs['avg_jaccard'])
            print('GAIN_OVER_ZERO',
                  round(brs['micro_recall'] - zrs['micro_recall'], 4),
                  round(brs['macro_recall'] - zrs['macro_recall'], 4),
                  round(brs['avg_jaccard'] - zrs['avg_jaccard'], 4))
        print()

    if not agent_curves:
        continue

    plt.figure(figsize=(7, 4.5))
    plt.rcParams['font.family'] = 'sans-serif'

    for agent, curve in agent_curves.items():
        s = style_map.get(agent, {'label': agent, 'marker': 'P', 'color': '#888888'})
        plt.plot(curve['lambdas'], curve['micro'],
                 marker=s['marker'], markersize=8, linewidth=2, color=s['color'],
                 label=f"{s['label']}")

    plt.xlabel(r'Gating Weight ($\lambda$)', fontsize=12, fontweight='bold')
    plt.ylabel('Micro Recall', fontsize=12, fontweight='bold')
    # plt.title(dataset, fontsize=12, fontweight='bold')
    all_lambdas = sorted({l for c in agent_curves.values() for l in c['lambdas']})
    plt.xticks(all_lambdas, fontsize=10)
    plt.yticks(fontsize=10)
    plt.grid(True, linestyle='--', alpha=0.6)
    plt.legend(fontsize=8, loc='upper right', bbox_to_anchor=(0.98, 0.85), frameon=True, framealpha=0.9, edgecolor='#cccccc')
    plt.tight_layout()

    safe_dataset = ''.join(ch if ch.isalnum() or ch in ('-', '_') else '_' for ch in dataset)
    out_png = f'micro_recall_ablation_{safe_dataset}.png'
    out_pdf = f'micro_recall_ablation_{safe_dataset}.pdf'
    plt.savefig(out_png, dpi=300, bbox_inches='tight')
    plt.savefig(out_pdf, bbox_inches='tight')
    plt.close()
    print(f'Saved [{dataset}]: {out_png}, {out_pdf}')
    print()
