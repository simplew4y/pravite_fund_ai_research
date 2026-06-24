"""
SEC EDGAR API 示例
运行: python sec_api_demo.py --ticker AAPL --form 10-K
"""

import argparse
import json
import requests

# ── 唯一需要改的地方：填你自己的邮箱 ────────────────────────────
HEADERS = {
    "User-Agent": "personal-research yourname@example.com",
    "Accept-Encoding": "gzip, deflate",
}


# ── 1. ticker → CIK ─────────────────────────────────────────────
def get_cik_from_ticker(ticker: str) -> str:
    url = "https://www.sec.gov/files/company_tickers.json"
    resp = requests.get(url, headers=HEADERS, timeout=10)
    resp.raise_for_status()
    for entry in resp.json().values():
        if entry["ticker"] == ticker.upper():
            return str(entry["cik_str"]).zfill(10)
    raise ValueError(f"Ticker '{ticker}' not found")


# ── 2. CIK → 最近 filings 列表 ──────────────────────────────────
def find_filings(cik: str, form_type: str, limit: int = 5) -> list:
    url = f"https://data.sec.gov/submissions/CIK{cik}.json"
    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    recent = resp.json()["filings"]["recent"]
    for i, form in enumerate(recent["form"]):
        print(f"primaryDocDescription: {recent['primaryDocDescription'][i]}, accessionNumber: {recent['accessionNumber'][i]}")

    results = []
    for i, form in enumerate(recent["form"]):
        if form == form_type:
            accession_clean = recent["accessionNumber"][i].replace("-", "")
            results.append({
                "filingDate":     recent["filingDate"][i],
                "accessionNumber": recent["accessionNumber"][i],
                "primaryDocument": recent["primaryDocument"][i],
                "documentUrl": (
                    f"https://www.sec.gov/Archives/edgar/data/"
                    f"{int(cik)}/{accession_clean}/{recent['primaryDocument'][i]}"
                ),
            })
        if len(results) >= limit:
            break
    return results


# ── 3. 一个 filing 的所有附件列表（含 Exhibit 99.1 等）──────────
def get_filing_documents(cik: str, accession_number: str) -> list:
    accession_clean = accession_number.replace("-", "")
    url = (
        f"https://www.sec.gov/Archives/edgar/data/"
        f"{int(cik)}/{accession_clean}/index.json"
    )
    resp = requests.get(url, headers={**HEADERS, "Host": "www.sec.gov"}, timeout=15)
    resp.raise_for_status()
    return resp.json().get("documents", [])


# ── 4. XBRL 财务数字（直接拿结构化数据，不解析 HTML）────────────
COMMON_CONCEPTS = {
    "revenue":     "Revenues",
    "gross_profit": "GrossProfit",
    "net_income":  "NetIncomeLoss",
    "assets":      "Assets",
    "eps":         "EarningsPerShareBasic",
}

def get_concept_history(
    cik: str,
    taxonomy: str,
    concept: str,
    allowed_forms: list[str] | None = None,
    periods: int = 5,
    prefer_annual_only: bool = False,
) -> list:
    """
    taxonomy: 例如 'us-gaap' / 'ifrs-full' / 'dei'
    concept:  例如 'Revenues' / 'Revenue' / 'NetIncomeLoss'
    allowed_forms: 允许的表单类型，如 ['10-K'], ['10-Q'], ['20-F'], ['20-F', 'F-1', 'F-1/A']
    prefer_annual_only: 是否只保留 FY / 年度口径
    """
    cik = str(cik).zfill(10)
    url = f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/{taxonomy}/{concept}.json"

    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.raise_for_status()

    units = resp.json().get("units", {})
    unit_data = next(iter(units.values()), [])

    filtered = unit_data

    if allowed_forms:
        allowed = set(allowed_forms)
        filtered = [x for x in filtered if x.get("form") in allowed]

    if prefer_annual_only:
        filtered = [x for x in filtered if x.get("fp") == "FY"]

    # 去重：同一 end date 取最新 filed
    seen = {}
    for item in filtered:
        key = item.get("end")
        if not key:
            continue
        if key not in seen or item.get("filed", "") > seen[key].get("filed", ""):
            seen[key] = item

    return sorted(seen.values(), key=lambda x: x["end"], reverse=True)[:periods]


# ── 5. EDGAR 全文搜索 ────────────────────────────────────────────
def full_text_search(query: str, form_type: str = "", start_date: str = "", end_date: str = "", limit: int = 5) -> list:
    """
    在 EDGAR 所有 filing 全文里搜索关键词
    query:      搜索词，支持引号短语 "vehicle deliveries"
    form_type:  6-K / 8-K / 10-K / 10-Q 等，空字符串表示不限
    start_date: YYYY-MM-DD
    end_date:   YYYY-MM-DD
    """
    params = {"q": f'"{query}"', "dateRange": "", "forms": form_type}
    if start_date and end_date:
        params["dateRange"] = "custom"
        params["startdt"] = start_date
        params["enddt"] = end_date

    resp = requests.get(
        "https://efts.sec.gov/LATEST/search-index",
        params={k: v for k, v in params.items() if v},
        headers={**HEADERS, "Host": "efts.sec.gov"},
        timeout=15,
    )
    resp.raise_for_status()
    hits = resp.json().get("hits", {}).get("hits", [])
    return [
        {
            "filedAt":    h["_source"].get("file_date"),
            "formType":   h["_source"].get("form_type"),
            "companyName": h["_source"].get("display_names"),
            "documentUrl": f"https://www.sec.gov{h['_source'].get('file_path', '')}",
        }
        for h in hits[:limit]
    ]


# ── CLI ──────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ticker", default="AAPL")
    parser.add_argument("--form",   default="10-K", help="10-K / 10-Q / 8-K / 6-K")
    parser.add_argument("--concept", default="Revenues", help="us-gaap concept name")
    parser.add_argument("--search",  default="", help="全文搜索关键词")
    args = parser.parse_args()

    # 1. CIK
    print(f"\n{'='*50}")
    print(f"Ticker: {args.ticker}")
    # cik = get_cik_from_ticker(args.ticker)
    cik = "0001954042"
    print(f"CIK: {cik}")

    # 2. 最近 filings
    print(f"\n最近 {args.form} filings:")
    filings = find_filings(cik, args.form, limit=3)
    for f in filings:
        print(f"  {f['filingDate']}  {f['documentUrl']}")

    # 3. 第一个 filing 的附件列表
    if filings:
        print(f"\n最新 filing 附件列表 ({filings[0]['accessionNumber']}):")
        docs = get_filing_documents(cik, filings[0]["accessionNumber"])
        for d in docs[:8]:
            print(f"  [{d.get('type','?'):15s}] {d.get('document','?')}")

    # 4. XBRL 财务数字
    print(f"\n{args.concept} 历年数据 ({args.form}):")
    try:
        rows = get_concept_history(
            cik="1954042",
            taxonomy="ifrs-full",
            concept="Revenue",
            allowed_forms=["20-F"],
            periods=5,
            prefer_annual_only=True,
        )
        for r in rows:
            val = r['val']
            display = f"${val:>20,.0f}" if val > 1000 else f"{val:>20.4f}"
            print(f"  {r['end']}  {display}  (filed: {r['filed']})")
    except Exception as e:
        print(f"  XBRL 数据不可用: {e}")

    # 5. 全文搜索
    if args.search:
        print(f"\nEDGAR 全文搜索: '{args.search}'")
        results = full_text_search(args.search, form_type=args.form)
        for r in results:
            print(f"  {r['filedAt']}  {r['formType']:6s}  {r['companyName']}")
            print(f"           {r['documentUrl']}")


if __name__ == "__main__":
    main()