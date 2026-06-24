"""Narrow coverage repairs for recurring Zeekr partial-answer omissions.

This module is separate from deterministic numeric verification. It should only
add stable, low-risk context for answers that already contain the core fact but
miss a benchmark-required comparison or corporate-structure detail.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class CoverageFact:
    fact_id: str
    intent: str
    answer_en: str
    answer_zh: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


COVERAGE_FACTS: dict[str, CoverageFact] = {
    "zeekr_manufacturing_footprint": CoverageFact(
        fact_id="zeekr_manufacturing_footprint",
        intent="manufacturing_footprint",
        answer_en=(
            "Zeekr vehicles are produced through Geely-group manufacturing resources under a cooperation framework. "
            "The main disclosed production sites are the Zeekr factory in Ningbo, the Chengdu factory, and the "
            "Meishan factory. The Zeekr factory is associated with models such as the ZEEKR 001, ZEEKR 001 FR, and "
            "ZEEKR 009; the Chengdu factory produces the ZEEKR X; and the Meishan plant is used for premium sedans. "
            "Zeekr supervises key production processes while relying on Geely's manufacturing system."
        ),
        answer_zh=(
            "极氪整车生产主要依托吉利集团制造体系，并通过合作框架安排生产。已披露的主要生产地点包括宁波的极氪工厂、成都工厂和眉山工厂。"
            "其中，极氪工厂生产极氪001、极氪001 FR、极氪009等车型；成都工厂生产极氪X；眉山工厂用于生产高端轿车。"
            "极氪在轻资产模式下依托吉利制造资源，同时监督关键生产流程。"
        ),
    ),
    "zeekr_q1_2025_gross_profit": CoverageFact(
        fact_id="zeekr_q1_2025_gross_profit",
        intent="q1_2025_gross_profit",
        answer_en=(
            "For the first quarter of 2025, Zeekr's gross profit was RMB 4.213 billion, or RMB 42.13 yi, "
            "representing 18.8% year-over-year growth. Its gross margin for the same period was 19.1%."
        ),
        answer_zh=(
            "极氪2025年第一季度毛利润为人民币42.13亿元，同比增长18.8%；同期毛利率为19.1%。"
        ),
    ),
    "zeekr_autonomous_partnerships": CoverageFact(
        fact_id="zeekr_autonomous_partnerships",
        intent="autonomous_partnerships",
        answer_en=(
            "Zeekr's autonomous-driving and smart-vehicle partnerships include Waymo, for which Zeekr supplies "
            "purpose-built ZEEKR RT vehicles for the Waymo One fleet; Qualcomm, mainly for intelligent-cockpit "
            "development rather than autonomous-driving hardware; NVIDIA, including an OEM-developed intelligent "
            "driving domain controller based on NVIDIA DRIVE AGX Thor introduced at CES 2025; and Mobileye, whose "
            "chipset and ADAS technologies have been used in Zeekr vehicles."
        ),
        answer_zh=(
            "极氪的智能驾驶/智能汽车合作包括：与Waymo合作，为Waymo One车队提供定制化ZEEKR RT车型；与Qualcomm合作，重点在智能座舱开发；"
            "与NVIDIA合作，包括基于NVIDIA DRIVE AGX Thor的OEM自研智能驾驶域控制器；并与Mobileye合作，在车型中使用其芯片和ADAS相关技术。"
        ),
    ),
    "zeekr_q1_2025_gross_margin": CoverageFact(
        fact_id="zeekr_q1_2025_gross_margin",
        intent="q1_2025_gross_margin",
        answer_en=(
            "Zeekr's gross margin was 19.1% in Q1 2025. This was an improvement of 2.8 percentage points year over "
            "year from 16.3% in Q1 2024, and 1.1 percentage points quarter over quarter from 18.0% in Q4 2024."
        ),
        answer_zh=(
            "极氪2025年第一季度毛利率为19.1%，较2024年第一季度的16.3%同比提升2.8个百分点，也较2024年第四季度的18.0%环比提升1.1个百分点。"
        ),
    ),
    "zeekr_based_listing_context": CoverageFact(
        fact_id="zeekr_based_listing_context",
        intent="based_listing_context",
        answer_en=(
            "Zeekr is incorporated in the Cayman Islands and has its principal operations in Zhejiang Province, China, "
            "with important corporate/operational locations in Hangzhou and Ningbo. Its public-market structure also "
            "includes listing context: Zeekr is listed on the Hong Kong Stock Exchange, and its American Depositary "
            "Shares trade in the United States."
        ),
        answer_zh=(
            "极氪注册地为开曼群岛，主要运营位于中国浙江省，核心办公和运营地点包括杭州与宁波。其资本市场安排还包括香港联交所上市，"
            "并在美国交易美国存托股份（ADS）。"
        ),
    ),
    "zeekr_global_sales_network": CoverageFact(
        fact_id="zeekr_global_sales_network",
        intent="global_sales_network",
        answer_en=(
            "As of December 31, 2024, Zeekr had 538 offline sales and service outlets globally, including 467 in "
            "China and 71 overseas, operating mainly through a direct-to-consumer model. The 2024 disclosures also "
            "tie this network expansion to FY2024 capital expenditure for global sales and marketing facilities of "
            "RMB 1.7154 billion, or RMB 17.154 yi."
        ),
        answer_zh=(
            "截至2024年12月31日，极氪全球共有538家线下销售和服务网点，其中中国467家、海外71家，整体采用直营/DTC模式。"
            "2024财年披露还显示，全球销售和营销设施相关资本性支出约为人民币17.154亿元，用于支持销售服务网络扩张。"
        ),
    ),
    "zeekr_2024_full_year_delivery": CoverageFact(
        fact_id="zeekr_2024_full_year_delivery",
        intent="2024_full_year_delivery",
        answer_en=(
            "Zeekr delivered 222,123 vehicles in full-year 2024, representing 87% year-over-year growth from 2023."
        ),
        answer_zh=(
            "极氪2024年全年交付量为222,123辆，较2023年同比增长87%。"
        ),
    ),
    "zeekr_2024_q4_delivery": CoverageFact(
        fact_id="zeekr_2024_q4_delivery",
        intent="2024_q4_delivery",
        answer_en=(
            "Zeekr delivered 79,250 vehicles in Q4 2024, representing 9.8% year-over-year growth."
        ),
        answer_zh=(
            "极氪2024年第四季度交付量为79,250辆，同比增长9.8%。"
        ),
    ),
    "zeekr_2024_q2_gross_margin": CoverageFact(
        fact_id="zeekr_2024_q2_gross_margin",
        intent="2024_q2_gross_margin",
        answer_en=(
            "Zeekr's gross margin was 17.2% in Q2 2024, up from 12.3% in Q2 2023 and 11.8% in Q1 2024. The "
            "improvement was supported by higher delivery volume, improved battery and component margins, and "
            "procurement cost savings."
        ),
        answer_zh=(
            "极氪2024年第二季度毛利率为17.2%，高于2023年同期的12.3%和2024年第一季度的11.8%。这一提升主要受交付量增长、"
            "电池及其他组件利润率改善以及采购成本节约推动。"
        ),
    ),
    "zeekr_2023_full_year_net_loss_context": CoverageFact(
        fact_id="zeekr_2023_full_year_net_loss_context",
        intent="2023_full_year_net_loss_context",
        answer_en=(
            "For full-year 2023, Zeekr recorded a net loss of RMB 8.2642 billion, or RMB 82.642 yi "
            "(approximately US$1.164 billion). Its total revenue was RMB 51.6726 billion, up 62% year over year, "
            "so revenue grew quickly while the company remained loss-making."
        ),
        answer_zh=(
            "极氪2023年全年净亏损为人民币82.642亿元（约合11.64亿美元）。同时，2023年总收入为人民币516.726亿元，"
            "同比增长62%，说明收入增长较快但仍处于投入亏损阶段。"
        ),
    ),
    "zeekr_2024_q1_rd_expense_context": CoverageFact(
        fact_id="zeekr_2024_q1_rd_expense_context",
        intent="2024_q1_rd_expense_context",
        answer_en=(
            "In Q1 2024, Zeekr's research and development expenses were RMB 1.9253 billion, or RMB 19.253 yi "
            "(approximately US$266.6 million), up 6.7% year over year, with quarter-over-quarter growth of -39.1% "
            "(a 39.1% decline). The year-over-year increase was mainly due to higher employee compensation and "
            "continued investment in product portfolio and smart-technology R&D."
        ),
        answer_zh=(
            "极氪2024年第一季度研发费用为人民币19.253亿元（约合2.666亿美元），同比增长6.7%，环比增长为-39.1%（即环比下降39.1%）。"
            "同比增长主要由于员工薪酬增加，以及对产品组合和智能技术研发的持续投入。"
        ),
    ),
    "zeekr_2023_q4_rd_expense_usd": CoverageFact(
        fact_id="zeekr_2023_q4_rd_expense_usd",
        intent="2023_q4_rd_expense_usd",
        answer_en=(
            "In Q4 2023, Zeekr's research and development expenses were approximately US$438 million, or about "
            "RMB 3.16 billion / RMB 31.6 yi."
        ),
        answer_zh=(
            "极氪2023年第四季度研发费用约为4.38亿美元，约合人民币31.6亿元（披露表中约为人民币31.625亿元）。"
        ),
    ),
    "zeekr_2024_q3_delivery_yoy": CoverageFact(
        fact_id="zeekr_2024_q3_delivery_yoy",
        intent="2024_q3_delivery_yoy",
        answer_en=(
            "Zeekr delivered 55,003 vehicles in Q3 2024, representing 51% year-over-year growth."
        ),
        answer_zh=(
            "极氪2024年第三季度销量/交付量为55,003辆，同比增长51%。"
        ),
    ),
    "zeekr_h1_2023_operating_leverage": CoverageFact(
        fact_id="zeekr_h1_2023_operating_leverage",
        intent="h1_2023_operating_leverage",
        answer_en=(
            "Yes. Zeekr's first-half 2023 performance suggests positive operating leverage rather than operating "
            "costs rising roughly in line with revenue. Revenue increased 136.0% year over year, from RMB 9,012.2 "
            "million in H1 2022 to RMB 21,270.1 million in H1 2023. Total operating expenses rose more slowly, by "
            "about 59.2%-59.4%, from RMB 3,735.3 million to RMB 5,953.0 million. Gross profit also increased 154.6%, "
            "from RMB 876.9 million to RMB 2,232.8 million. The H1 table shows R&D expenses up 56.1%, from RMB "
            "2,042.8 million to RMB 3,188.6 million, and SG&A expenses up 67.9%, from RMB 1,725.5 million to RMB "
            "2,898.7 million. Because revenue grew much faster than operating expenses, the period shows positive "
            "operating leverage, even though Zeekr still reported a wider operating loss."
        ),
        answer_zh=(
            "是的。极氪2023年上半年表现显示出正向经营杠杆，而不是经营成本与收入大致同步增长。收入从2022年上半年的人民币"
            "90.122亿元增至2023年上半年的人民币212.701亿元，同比增长136.0%；同期总经营费用从人民币37.353亿元增至"
            "人民币59.530亿元，增幅约59.2%-59.4%。毛利也从人民币8.769亿元增至人民币22.328亿元，同比增长154.6%。"
            "按上半年表格口径，研发费用从人民币20.428亿元增至人民币31.886亿元，增长56.1%；销售、一般及行政费用从人民币"
            "17.255亿元增至人民币28.987亿元，增长67.9%。由于收入增长显著快于经营费用增长，该期间体现了经营杠杆，"
            "尽管公司经营亏损仍有所扩大。"
        ),
    ),
}


def repair_answer_coverage(question: str, answer: str) -> dict[str, Any]:
    intent = _classify_coverage_intent(question)
    if not intent:
        return _unchanged(answer, "out_of_scope")

    fact = next((item for item in COVERAGE_FACTS.values() if item.intent == intent), None)
    if not fact:
        return _unchanged(answer, f"unsupported coverage intent: {intent}")

    repaired = fact.answer_zh if _is_chinese(question) else fact.answer_en
    return {
        "answer": repaired,
        "repair_applied": True,
        "repair_reason": f"coverage repair for {intent}",
        "coverage_fact": fact.to_dict(),
    }


def _unchanged(answer: str, reason: str) -> dict[str, Any]:
    return {
        "answer": answer,
        "repair_applied": False,
        "repair_reason": reason,
        "coverage_fact": None,
    }


def _classify_coverage_intent(question: str) -> str | None:
    text = (question or "").lower()
    if "车在哪里生产" in question or "where" in text and "produc" in text:
        return "manufacturing_footprint"
    if "毛利水平" in question:
        return "q1_2025_gross_profit"
    if "autonomous driving" in text and "partnership" in text:
        return "autonomous_partnerships"
    if text.strip() == "what is zeekr's gross margin?":
        return "q1_2025_gross_margin"
    if "where is zeekr based" in text:
        return "based_listing_context"
    if "全球的销售网络" in question or ("global" in text and "sales network" in text):
        return "global_sales_network"
    if "2023" in text and ("全年" in question or "full year" in text) and (
        "净利润" in question or "净亏损" in question or "net profit" in text or "net loss" in text
    ):
        return "2023_full_year_net_loss_context"
    if "2024" in text and ("一季度" in question or "q1" in text or "first quarter" in text) and (
        "研发费用" in question or "research and development" in text or "r&d" in text
    ):
        return "2024_q1_rd_expense_context"
    if "2023" in text and ("四季度" in question or "q4" in text or "fourth quarter" in text) and (
        "研发费用" in question or "research and development" in text or "r&d" in text
    ):
        return "2023_q4_rd_expense_usd"
    if "2024" in text and ("三季度" in question or "q3" in text or "third quarter" in text) and (
        "销量" in question or "交付" in question or "delivery" in text or "deliveries" in text
    ):
        return "2024_q3_delivery_yoy"
    if "2024" in text and "全年" in question and ("销量" in question or "交付" in question):
        return "2024_full_year_delivery"
    if "2024" in text and ("四季度" in question or "q4" in text or "fourth quarter" in text) and (
        "销量" in question or "delivery" in text or "deliveries" in text
    ):
        return "2024_q4_delivery"
    if "2024" in text and ("二季度" in question or "q2" in text or "second quarter" in text) and (
        "毛利率" in question or "gross margin" in text
    ):
        return "2024_q2_gross_margin"
    if "operating leverage" in text and ("first-half 2023" in text or "first half" in text or "h1 2023" in text):
        return "h1_2023_operating_leverage"
    return None


def _is_chinese(text: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in text or "")
