"""
Tier 1 Deep Dive: SEC 10-K XBRL multi-year analysis for top candidates.
Companies: ONTO, CGNX, NOVT, PODD
Output: summary tables, trend arrows, red flags, latest 10-K metadata.
Data: SEC EDGAR XBRL CompanyFacts + Submissions APIs only.
"""

import json
import time
import sys
import warnings
from pathlib import Path
from typing import Optional

import requests

warnings.filterwarnings("ignore")

USER_AGENT = "StockScreener/1.0 (research@example.com)"
OUTPUT_DIR = Path(__file__).parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

COMPANIES = {
    "ONTO": {"cik": "0000704532", "name": "Onto Innovation Inc."},
    "CGNX": {"cik": "0000851205", "name": "Cognex Corporation"},
    "NOVT": {"cik": "0001076930", "name": "Novanta Inc."},
    "PODD": {"cik": "0001145197", "name": "Insulet Corporation"},
}

# Primary + fallback concept names; we merge across all that yield 10-K data
METRIC_CONCEPTS = {
    "Revenues": [
        "Revenues",
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "SalesRevenueNet",
    ],
    "GrossProfit": ["GrossProfit"],
    "ResearchAndDevelopmentExpense": [
        "ResearchAndDevelopmentExpense",
        "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost",
    ],
    "NetIncomeLoss": ["NetIncomeLoss"],
    "NetCashProvidedByUsedInOperatingActivities": ["NetCashProvidedByUsedInOperatingActivities"],
    "AccountsReceivableNetCurrent": [
        "AccountsReceivableNetCurrent",
        "AccountsReceivableNet",
        "AccountsAndNotesReceivableNet",
    ],
    "Assets": ["Assets"],
    "InventoryNet": ["InventoryNet", "InventoryGross"],
}

RED_FLAG_CONCEPTS = {
    "Goodwill": ["Goodwill"],
    "PropertyPlantAndEquipmentNet": ["PropertyPlantAndEquipmentNet"],
}


def _get(url: str) -> Optional[dict]:
    headers = {"User-Agent": USER_AGENT}
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        print(f"    HTTP error: {exc}", file=sys.stderr)
        return None


def fetch_company_facts(cik: str) -> Optional[dict]:
    return _get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json")


def fetch_submissions(cik: str) -> Optional[dict]:
    return _get(f"https://data.sec.gov/submissions/CIK{cik}.json")


# ---------------------------------------------------------------------------
# Data extraction — MERGES across all concept names in the list
# ---------------------------------------------------------------------------

def _get_concept_10k_by_fy(facts: dict, name: str) -> dict[int, float]:
    """Extract {fy: value} from a single concept name using 10-K only."""
    us_gaap = facts.get("facts", {}).get("us-gaap", {})
    concept = us_gaap.get(name, {})
    if not concept:
        return {}
    items = concept.get("units", {}).get("USD", [])
    if not items:
        return {}

    # Filter 10-K
    annual = []
    for item in items:
        form = (item.get("form") or "").upper()
        if form in ("10-K", "10-K/A"):
            end = item.get("end", "")
            fy_raw = item.get("fy")
            fy = fy_raw or (end[:4] if len(end) >= 4 else None)
            val = item.get("val")
            if end and fy is not None and val is not None:
                annual.append({"end": end, "fy": int(fy), "val": val})

    # Deduplicate per fy: keep latest end date
    annual.sort(key=lambda x: x["end"], reverse=True)
    fy_map = {}
    for a in annual:
        if a["fy"] not in fy_map or a["end"] > fy_map[a["fy"]]["end"]:
            fy_map[a["fy"]] = a
    return {fy: item["val"] for fy, item in fy_map.items()}


def extract_metric_years(facts: dict, concept_names: list[str], label: str = "") -> dict[int, float]:
    """
    Merged {fy: value} across all concept names.
    For overlapping fy, the EARLIER concept in the list wins.
    """
    merged = {}
    contributions = []
    for name in concept_names:
        fy_data = _get_concept_10k_by_fy(facts, name)
        if fy_data:
            contributions.append((name, len(fy_data), sorted(fy_data.keys())))
            for fy, val in fy_data.items():
                if fy not in merged:
                    merged[fy] = val
    if label and contributions:
        detail = "; ".join(f"{n}({c}y)" for n, c, _ in contributions)
        total_years = sorted(merged.keys())
        print(f"    [{label}] Merged: {detail} → {len(total_years)} unique fy: {total_years}")
    return merged


# ---------------------------------------------------------------------------
# Calculations
# ---------------------------------------------------------------------------

def calc_cagr(values: list[float]) -> Optional[float]:
    if len(values) < 2 or values[0] <= 0 or values[-1] <= 0:
        return None
    years = len(values) - 1
    return (values[-1] / values[0]) ** (1 / years) - 1


def trend_arrow(years, values) -> str:
    if len(years) < 2:
        return "—"
    first, last = values[0], values[-1]
    if last > first * 1.02:
        return "↑"
    elif last < first * 0.98:
        return "↓"
    else:
        return "→"


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def analyze_company(ticker: str, info: dict) -> dict:
    cik = info["cik"]
    name = info["name"]

    print(f"\n{'=' * 70}")
    print(f"Analyzing {ticker}: {name} (CIK {cik})")
    print(f"{'=' * 70}")

    time.sleep(0.12)
    facts = fetch_company_facts(cik)
    if not facts:
        print(f"  ERROR: No XBRL company facts")
        return {"ticker": ticker, "name": name, "error": "No XBRL data"}

    time.sleep(0.12)
    submissions = fetch_submissions(cik)

    all_data = {}
    for mname, names in METRIC_CONCEPTS.items():
        all_data[mname] = extract_metric_years(facts, names, f"{ticker}/{mname}")

    red_flag_data = {}
    for mname, names in RED_FLAG_CONCEPTS.items():
        red_flag_data[mname] = extract_metric_years(facts, names, f"{ticker}/{mname}")

    rev_fy = sorted(all_data.get("Revenues", {}).keys())
    if not rev_fy:
        print("  ERROR: No revenue 10-K data")
        return {"ticker": ticker, "name": name, "error": "No revenue data"}

    # Pick 3 most recent complete years
    analysis_years = rev_fy[-3:] if len(rev_fy) >= 3 else rev_fy

    rows = []
    for fy in analysis_years:
        rev = all_data["Revenues"].get(fy)
        gp = all_data["GrossProfit"].get(fy)
        rd = all_data["ResearchAndDevelopmentExpense"].get(fy)
        ni = all_data["NetIncomeLoss"].get(fy)
        cfo = all_data["NetCashProvidedByUsedInOperatingActivities"].get(fy)

        gm = (gp / rev) if (gp is not None and rev and rev > 0) else None
        rd_pct = (rd / rev * 100) if (rd is not None and rev and rev > 0) else None
        cfo_ni = (cfo / ni) if (cfo is not None and ni and ni > 0) else None

        rows.append({
            "year": fy,
            "revenue": rev,
            "gross_margin": gm,
            "rd_pct": rd_pct,
            "net_income": ni,
            "cfo": cfo,
            "cfo_ni": cfo_ni,
        })

    # Trend arrows
    rev_vals = [r["revenue"] for r in rows if r["revenue"] is not None]
    rev_yrs = [r["year"] for r in rows if r["revenue"] is not None]
    gm_vals = [r["gross_margin"] for r in rows if r["gross_margin"] is not None]
    gm_yrs = [r["year"] for r in rows if r["gross_margin"] is not None]
    rd_vals = [r["rd_pct"] for r in rows if r["rd_pct"] is not None]
    rd_yrs = [r["year"] for r in rows if r["rd_pct"] is not None]
    cfo_ni_vals = [r["cfo_ni"] for r in rows if r["cfo_ni"] is not None]
    cfo_ni_yrs = [r["year"] for r in rows if r["cfo_ni"] is not None]

    rev_arrow = trend_arrow(rev_yrs, rev_vals)
    gm_arrow = trend_arrow(gm_yrs, gm_vals)
    rd_arrow = trend_arrow(rd_yrs, rd_vals)
    cfo_ni_arrow = trend_arrow(cfo_ni_yrs, cfo_ni_vals)
    rev_trend = rev_arrow

    # Revenue CAGR (all available years, full range)
    cagr_rev_vals = [all_data["Revenues"].get(fy) for fy in rev_fy if all_data["Revenues"].get(fy) is not None]
    revenue_cagr = calc_cagr([v for v in cagr_rev_vals if v is not None])

    # --- Red flags ---
    red_flags = []

    # Goodwill / Assets
    gw_data = red_flag_data.get("Goodwill", {})
    assets_data = all_data.get("Assets", {})
    for fy in analysis_years:
        gw = gw_data.get(fy)
        assets = assets_data.get(fy)
        if gw and assets and assets > 0:
            ratio = gw / assets
            if ratio > 0.50:
                red_flags.append(f"FY{fy}: Goodwill/Assets = {ratio:.1%} — acquisition-heavy balance sheet (>50%)")
            elif ratio > 0.30:
                red_flags.append(f"FY{fy}: Goodwill/Assets = {ratio:.1%} — elevated goodwill, watch for impairment risk")

    # PP&E vs revenue divergence
    ppe_data = red_flag_data.get("PropertyPlantAndEquipmentNet", {})
    ppe_yrs = sorted([fy for fy in ppe_data if fy in analysis_years])
    ppe_vals = [ppe_data[fy] for fy in ppe_yrs]
    if len(ppe_vals) >= 2:
        ppe_trend = trend_arrow(ppe_yrs, ppe_vals)
        if rev_trend == "↑" and ppe_trend in ("→", "↓"):
            red_flags.append("PP&E flat/declining while revenue grows — growth may be acquisition or intangible driven, not organic capacity")

    # AR / Revenue
    ar_data = all_data.get("AccountsReceivableNetCurrent", {})
    ar_ratios = []
    for fy in analysis_years:
        ar = ar_data.get(fy)
        rev = all_data["Revenues"].get(fy)
        if ar is not None and rev and rev > 0:
            ar_ratios.append((fy, ar / rev))
    if len(ar_ratios) >= 2:
        ar_yrs_list = [x[0] for x in ar_ratios]
        ar_vals_list = [x[1] for x in ar_ratios]
        if trend_arrow(ar_yrs_list, ar_vals_list) == "↑":
            red_flags.append("Accounts Receivable / Revenue is rising — potential channel stuffing or loosening credit terms")
        if ar_vals_list[-1] > 0.25:
            red_flags.append(f"FY{ar_yrs_list[-1]}: AR/Revenue = {ar_vals_list[-1]:.1%} — high DSO, consider collection risk")

    # Inventory / Revenue
    inv_data = all_data.get("InventoryNet", {})
    inv_ratios = []
    for fy in analysis_years:
        inv = inv_data.get(fy)
        rev = all_data["Revenues"].get(fy)
        if inv is not None and rev and rev > 0:
            inv_ratios.append((fy, inv / rev))
    if len(inv_ratios) >= 2:
        inv_yrs_list = [x[0] for x in inv_ratios]
        inv_vals_list = [x[1] for x in inv_ratios]
        if trend_arrow(inv_yrs_list, inv_vals_list) == "↑":
            red_flags.append("Inventory / Revenue is rising — potential slowing demand or inventory buildup")

    # --- Latest 10-K metadata ---
    latest_10k = None
    if submissions:
        filings = submissions.get("filings", {}).get("recent", {})
        forms = filings.get("form", [])
        fd = filings.get("filingDate", [])
        rd_dates = filings.get("reportDate", [])
        for i, form in enumerate(forms):
            if form in ("10-K", "10-K/A"):
                latest_10k = {
                    "form": form,
                    "filing_date": fd[i] if i < len(fd) else "N/A",
                    "period_end": rd_dates[i] if i < len(rd_dates) else "N/A",
                }
                break

    assessment = build_assessment(
        ticker, rows, gm_arrow, rd_arrow, cfo_ni_arrow,
        revenue_cagr, red_flags, rev_trend
    )

    return {
        "ticker": ticker,
        "name": name,
        "cik": cik,
        "analysis_years": analysis_years,
        "rows": rows,
        "trends": {
            "revenue": rev_arrow,
            "gross_margin": gm_arrow,
            "rd_pct": rd_arrow,
            "cfo_ni": cfo_ni_arrow,
        },
        "revenue_cagr": revenue_cagr,
        "red_flags": red_flags,
        "latest_10k": latest_10k,
        "assessment": assessment,
    }


def build_assessment(ticker, rows, gm_arrow, rd_arrow, cfo_ni_arrow, cagr, red_flags, rev_trend) -> str:
    parts = []
    latest_rev = rows[-1]["revenue"]
    if latest_rev:
        parts.append(f"Revenue ${latest_rev/1e6:,.0f}M")
    if cagr is not None:
        parts.append(f"Revenue CAGR {cagr*100:+.1f}%")
    latest_gm = rows[-1]["gross_margin"]
    if latest_gm is not None:
        parts.append(f"Gross margin {latest_gm*100:.1f}% ({gm_arrow})")
    latest_rd = rows[-1]["rd_pct"]
    if latest_rd is not None:
        parts.append(f"R&D {latest_rd:.1f}% of revenue ({rd_arrow})")
    latest_cfo_ni = rows[-1]["cfo_ni"]
    if latest_cfo_ni is not None:
        parts.append(f"CFO/NI {latest_cfo_ni:.2f}x ({cfo_ni_arrow})")
    ni_vals = [r["net_income"] for r in rows if r["net_income"] is not None]
    if len(ni_vals) >= 2 and ni_vals[-1] > 0 and ni_vals[0] > 0:
        ni_growth = (ni_vals[-1] / ni_vals[0] - 1) * 100
        parts.append(f"Net income {ni_growth:+.1f}% over {len(ni_vals)-1}yr")
    summary = "; ".join(parts) + "."

    score = 0
    if gm_arrow in ("↑", "→"):
        score += 1
    if latest_gm and latest_gm > 0.40:
        score += 1
    if rd_arrow in ("↑", "→"):
        score += 1
    if latest_rd and latest_rd > 0.07:
        score += 1
    if cfo_ni_arrow in ("↑", "→"):
        score += 1
    if latest_cfo_ni and latest_cfo_ni > 1.0:
        score += 1
    if cagr and cagr > 0.05:
        score += 1
    if rev_trend == "↑":
        score += 1
    if len(red_flags) == 0:
        score += 2
    elif len(red_flags) <= 1:
        score += 1

    if score >= 8:
        verdict = "WORTH DEEP-DIVE — strong fundamentals with minimal red flags in raw EDGAR data."
    elif score >= 5:
        verdict = "WATCH — decent fundamentals but some concerning signals; flag-specific diligence needed."
    else:
        verdict = "CAUTION — multiple red flags or weakening trends; proceed only with a specific thesis."
    if red_flags:
        verdict += f" Red flags found: {len(red_flags)}."
    return f"{summary}\n  Assessment ({score}/10 signals positive): {verdict}"


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def fmt_dollar(v) -> str:
    if v is None:
        return "N/A"
    if abs(v) >= 1e9:
        return f"${v/1e9:,.1f}B"
    return f"${v/1e6:,.0f}M"


def print_company_report(result: dict):
    ticker = result["ticker"]
    if "error" in result:
        print(f"\n  ** ERROR: {result['error']} **\n")
        return

    print(f"\n  {'─' * 62}")
    print(f"  {ticker} — Key Metrics (SEC 10-K XBRL Data Only)")
    print(f"  {'─' * 62}")
    hdr = f"  {'Year':>6}  {'Revenue':>14}  {'GrossMgn':>9}  {'R&D%':>7}  {'NetIncome':>12}  {'CFO':>14}  {'CFO/NI':>7}"
    print(hdr)
    print(f"  {'─' * len(hdr)}")

    for r in result["rows"]:
        rev = fmt_dollar(r["revenue"])
        gm = f"{r['gross_margin']*100:5.1f}%" if r["gross_margin"] is not None else "   N/A"
        rd = f"{r['rd_pct']:4.1f}%" if r["rd_pct"] is not None else "  N/A"
        ni = fmt_dollar(r["net_income"])
        cfo = fmt_dollar(r["cfo"])
        cfo_ni = f"{r['cfo_ni']:5.2f}x" if r["cfo_ni"] is not None else "   N/A"
        print(f"  {r['year']:>6}  {rev:>14}  {gm:>9}  {rd:>7}  {ni:>12}  {cfo:>14}  {cfo_ni:>7}")

    print()
    t = result["trends"]
    cagr = result["revenue_cagr"]
    print(f"  Trends ({len(result['analysis_years'])}yr):")
    print(f"    Revenue          {t['revenue']}")
    gm_l = "(improving)" if t['gross_margin']=="↑" else "(declining)" if t['gross_margin']=="↓" else "(stable)"
    print(f"    Gross Margin     {t['gross_margin']}  {gm_l}")
    rd_l = "(growing)" if t['rd_pct']=="↑" else "(shrinking)" if t['rd_pct']=="↓" else "(stable)"
    print(f"    R&D % of Rev     {t['rd_pct']}  {rd_l}")
    cfo_l = "(improving)" if t['cfo_ni']=="↑" else "(weakening)" if t['cfo_ni']=="↓" else "(stable)"
    print(f"    CFO / NI         {t['cfo_ni']}  {cfo_l}")
    if cagr is not None:
        print(f"    Revenue CAGR     {cagr*100:+.1f}%")

    flags = result["red_flags"]
    if flags:
        print(f"\n  Red Flags ({len(flags)}):")
        for f in flags:
            print(f"    * {f}")
    else:
        print(f"\n  No red flags detected from XBRL data.")

    k10 = result.get("latest_10k")
    if k10:
        print(f"\n  Latest 10-K: {k10['form']} filed {k10['filing_date']}, period ended {k10['period_end']}")

    print(f"\n  {result['assessment']}")
    print(f"\n  Source: SEC EDGAR XBRL CompanyFacts API (CIK {result['cik']})")


def main():
    print("=" * 70)
    print("Tier 1 Deep Dive — SEC 10-K XBRL Multi-Year Analysis")
    print("=" * 70)
    print(f"Companies: {', '.join(COMPANIES.keys())}")
    print()

    all_results = []
    for ticker, info in COMPANIES.items():
        result = analyze_company(ticker, info)
        all_results.append(result)
        print_company_report(result)
        if ticker != list(COMPANIES.keys())[-1]:
            time.sleep(0.3)

    json_path = OUTPUT_DIR / "tier1_deep_dive.json"
    with open(json_path, "w") as f:
        json.dump(all_results, f, indent=2, default=str)
    print(f"\n{'=' * 70}")
    print(f"Raw data saved to {json_path}")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    main()
