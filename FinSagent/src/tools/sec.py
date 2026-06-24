import logging
from typing import Any, Dict

import requests

logger = logging.getLogger(__name__)

SEC_XBRL_BASE = "https://data.sec.gov/api/xbrl/companyconcept"

VALID_CONCEPTS = {
    "CostOfRevenue",
    "GrossProfit",
    "OperatingIncomeLoss",
    "NetIncomeLoss",
    "Assets",
    "Liabilities",
    "CashAndCashEquivalentsAtCarryingValue",
}


def sec_company_concept(cik: str, concept: str) -> Dict[str, Any]:
    """Fetch a single US-GAAP financial concept for a company from the SEC XBRL API.

    cik: CIK number as a string (e.g. '0001954042').
    concept: one of CostOfRevenue, GrossProfit, OperatingIncomeLoss, NetIncomeLoss,
             Assets, Liabilities, CashAndCashEquivalentsAtCarryingValue.
    """
    if not cik:
        return {"error": "CIK cannot be empty."}
    if concept not in VALID_CONCEPTS:
        return {"error": f"Invalid concept '{concept}'. Valid values: {sorted(VALID_CONCEPTS)}"}

    cik_padded = str(cik).lstrip("0").zfill(10)
    url = f"{SEC_XBRL_BASE}/CIK{cik_padded}/us-gaap/{concept}.json"

    try:
        response = requests.get(
            url,
            headers={"User-Agent": "FinSagent research-use hwu3150@gmail.com"},
            timeout=20,
        )
        response.raise_for_status()
        payload = response.json()
        logger.info(f"[SEC COMPANY CONCEPT TOOL] cik={cik} concept={concept} entity={payload.get('entityName', '')}")
        return payload
    except Exception as e:
        logger.error(f"[SEC COMPANY CONCEPT] fetch failed cik={cik} concept={concept}: {e}")
        return {"error": f"SEC XBRL fetch failed for CIK={cik} concept={concept}: {e}"}
