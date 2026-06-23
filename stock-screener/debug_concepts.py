"""Quick diagnostic: what XBRL concepts are available for each company?"""
import json, time, requests

USER_AGENT = "StockScreener/1.0 (research@example.com)"
COMPANIES = {
    "ONTO": "0000704532",
    "CGNX": "0000851205",
    "NOVT": "0001076930",
    "PODD": "0001145197",
}

REVENUE_NAMES = [
    "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet",
    "SalesRevenueGoodsNet", "SalesRevenueServicesNet", "RevenueNet",
]

for ticker, cik in COMPANIES.items():
    time.sleep(0.12)
    resp = requests.get(
        f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
        headers={"User-Agent": USER_AGENT}, timeout=30
    )
    if resp.status_code == 404:
        print(f"{ticker}: 404 — no XBRL data")
        continue
    data = resp.json()
    us_gaap = data.get("facts", {}).get("us-gaap", {})
    concepts = list(us_gaap.keys())
    print(f"\n{ticker} ({cik}): {len(concepts)} us-gaap concepts")
    
    # Look for revenue-like concepts
    rev_concepts = []
    for c in concepts:
        if any(kw in c.lower() for kw in ["revenue", "sales", "income"]):
            items = us_gaap[c].get("units", {}).get("USD", [])
            annual = [i for i in items if i.get("form") in ("10-K", "10-K/A")]
            if annual:
                years = sorted(set(i.get("fy") for i in annual if i.get("fy")))
                rev_concepts.append((c, years))
    
    if rev_concepts:
        print(f"  Revenue-like concepts with 10-K data:")
        for c, yrs in rev_concepts:
            print(f"    {c}: years {yrs}")
    else:
        # Check if there's data in non-USD units
        print(f"  No revenue concepts in USD with 10-K data.")
        for name in REVENUE_NAMES:
            if name in us_gaap:
                units = list(us_gaap[name].get("units", {}).keys())
                print(f"    {name} units: {units}")
    
    # Look for gross profit
    gp_concepts = [c for c in concepts if "gross" in c.lower() or "cost" in c.lower()]
    for c in gp_concepts:
        items = us_gaap[c].get("units", {}).get("USD", [])
        annual = [i for i in items if i.get("form") in ("10-K", "10-K/A")]
        if annual:
            years = sorted(set(i.get("fy") for i in annual if i.get("fy")))
            print(f"    {c}: 10-K years {years}")
