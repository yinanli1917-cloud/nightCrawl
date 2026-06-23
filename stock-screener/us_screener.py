"""
美股隐形冠军初筛器
===================
从全市场美股中按硬指标过滤，输出初筛候选池。
数据源：SEC EDGAR XBRL CompanyFacts API（美国证监会官方API，免费无需认证）
零二手信息依赖：所有指标从SEC原始XBRL财报数据自行计算。

筛选条件（与A股一致）：
1. 毛利率 > 30%
2. 研发费用率 > 5%
3. 经营现金流净额/净利润 > 0.7
4. 营收 < $5B (对应A股的100亿人民币)

输出：初筛池CSV + 摘要JSON
"""

import time
import json
import warnings
from pathlib import Path
from typing import Optional

import pandas as pd
import numpy as np
import requests

warnings.filterwarnings("ignore")

OUTPUT_DIR = Path(__file__).parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

REVENUE_CAP_USD = 5_000_000_000  # $5B
GROSS_MARGIN_MIN = 0.30
RD_RATIO_MIN = 0.05
CFO_NI_RATIO_MIN = 0.70

SEC_USER_AGENT = "StockScreener/1.0 (research@example.com)"


def get_company_tickers() -> dict:
    """从SEC获取所有上市公司CIK-ticker映射。"""
    url = "https://www.sec.gov/files/company_tickers.json"
    headers = {"User-Agent": SEC_USER_AGENT}
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        result = {}
        for item in data.values():
            ticker = item.get("ticker", "").upper()
            if ticker:
                result[ticker] = {
                    "cik": str(item.get("cik_str", "")).zfill(10),
                    "title": item.get("title", ""),
                    "ticker": ticker,
                }
        return result
    except Exception as e:
        print(f"  Failed to get ticker list: {e}")
        return {}


def get_company_facts(cik: str) -> Optional[dict]:
    """获取单个公司的所有XBRL财务数据。"""
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
    headers = {"User-Agent": SEC_USER_AGENT}
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def extract_latest_annual(facts: dict, concept: str) -> Optional[float]:
    """从XBRL facts中提取最近一个年报(10-K)的数值。"""
    us_gaap = facts.get("facts", {}).get("us-gaap", {})
    concept_data = us_gaap.get(concept, {}).get("units", {}).get("USD", [])
    if not concept_data:
        return None
    annual = [x for x in concept_data if x.get("form") in ("10-K", "10-K/A")]
    if not annual:
        annual = sorted(concept_data, key=lambda x: x.get("end", ""), reverse=True)
    if not annual:
        return None
    annual_sorted = sorted(annual, key=lambda x: x.get("end", ""), reverse=True)
    return annual_sorted[0].get("val")


def compute_company_metrics(cik: str, facts: dict) -> Optional[dict]:
    """从单家公司XBRL facts计算筛选指标。"""
    revenue = extract_latest_annual(facts, "Revenues")
    if revenue is None or revenue <= 0:
        revenue = extract_latest_annual(facts, "RevenueFromContractWithCustomerExcludingAssessedTax")
    if revenue is None or revenue <= 0:
        return None
    
    gross_profit = extract_latest_annual(facts, "GrossProfit")
    rd_expense = extract_latest_annual(facts, "ResearchAndDevelopmentExpense")
    net_income = extract_latest_annual(facts, "NetIncomeLoss")
    operating_cf = extract_latest_annual(facts, "NetCashProvidedByUsedInOperatingActivities")
    
    if net_income is None:
        return None
    
    metrics = {
        "cik": cik,
        "revenue": revenue,
        "revenue_b": revenue / 1e9,
        "net_income": net_income,
        "net_income_m": net_income / 1e6,
    }
    
    if gross_profit and revenue > 0:
        metrics["gross_margin"] = gross_profit / revenue
        metrics["gross_profit_m"] = gross_profit / 1e6
    else:
        metrics["gross_margin"] = None
    
    if rd_expense and revenue > 0:
        metrics["rd_ratio"] = rd_expense / revenue
        metrics["rd_expense_m"] = rd_expense / 1e6
    else:
        metrics["rd_ratio"] = 0
    
    if operating_cf and net_income > 0:
        metrics["cfo_ni_ratio"] = operating_cf / net_income
        metrics["operating_cf_m"] = operating_cf / 1e6
    else:
        metrics["cfo_ni_ratio"] = None
    
    return metrics


def screen_company(metrics: dict, ticker: str, info: dict) -> Optional[dict]:
    """应用硬过滤条件。"""
    if metrics["revenue"] > REVENUE_CAP_USD:
        return None
    if metrics["revenue"] < 10_000_000:
        return None
    if metrics.get("gross_margin") is None or metrics["gross_margin"] <= GROSS_MARGIN_MIN:
        return None
    if metrics["rd_ratio"] is None or metrics["rd_ratio"] <= RD_RATIO_MIN:
        return None
    if metrics["net_income"] <= 0:
        return None
    cfo_ni = metrics.get("cfo_ni_ratio")
    if cfo_ni is None or cfo_ni <= CFO_NI_RATIO_MIN:
        return None
    
    return {
        "ticker": ticker,
        "cik": metrics["cik"],
        "name": info.get("title", ""),
        "revenue_b": round(metrics["revenue_b"], 3),
        "gross_margin": round(metrics["gross_margin"], 4),
        "rd_ratio": round(metrics["rd_ratio"], 4),
        "cfo_ni_ratio": round(cfo_ni, 3),
        "net_income_m": round(metrics["net_income_m"], 1),
        "gross_profit_m": round(metrics.get("gross_profit_m", 0), 1),
        "rd_expense_m": round(metrics.get("rd_expense_m", 0), 1),
        "operating_cf_m": round(metrics.get("operating_cf_m", 0), 1),
    }


def run_targeted_screen() -> list:
    """定向筛选：对预选的潜在隐形冠军股票池做硬指标过滤。"""
    print("=" * 60)
    print("美股隐形冠军定向筛选 (SEC EDGAR XBRL)")
    print("=" * 60)
    
    interesting = [
        # 半导体设备/耗材/封装测试
        "FORM", "AEHR", "ACLS", "UCTT", "ONTO", "NVMI", "CAMT",
        "ICHR", "PLAB", "COHU", "ASYS", "VECO", "AXTI",
        # 精密制造/特种材料
        "NOVT", "CGNX", "IPGP", "VNT", "TRMB", "ESE", "AIN",
        # 医疗精密器械
        "GKOS", "AXNX", "MASI", "PEN", "INSP", "PODD", "TNDM",
        # 航天/国防精密件
        "HEI", "TDY", "WWD", "CW",
        # 中小盘半导体
        "SITM", "SLAB", "SMTC", "DIOD", "MTSI", "RMBS", "PI",
        # 日本ADR(半导体材料/设备)
        "HTHIY", "TOELY", "SMCAY", "ATEYY",
        # 特种化学品
        "IOSP", "KWR", "SXT",
        # 自动化/机器人零部件
        "HLIO", "GGG", "IEX", "NDSN",
    ]
    
    print(f"\n[Step 1] Fetching SEC ticker map...")
    tickers_data = get_company_tickers()
    print(f"  SEC has {len(tickers_data)} registered companies")
    
    print(f"\n[Step 2] Screening {len(interesting)} target stocks...")
    print(f"  Rules: GM > {GROSS_MARGIN_MIN*100:.0f}% | RD > {RD_RATIO_MIN*100:.0f}% | CFO/NI > {CFO_NI_RATIO_MIN} | Rev < ${REVENUE_CAP_USD/1e9:.0f}B")
    print()
    
    candidates = []
    not_found = []
    failed_rev = []
    failed_gm = []
    failed_rd = []
    failed_cfo = []
    failed_loss = []
    no_xbrl = []
    
    for ticker in interesting:
        if ticker not in tickers_data:
            not_found.append(ticker)
            continue
        
        info = tickers_data[ticker]
        cik = info["cik"]
        
        time.sleep(0.12)  # SEC rate limit: 10/sec
        
        facts = get_company_facts(cik)
        if facts is None:
            no_xbrl.append(ticker)
            continue
        
        metrics = compute_company_metrics(cik, facts)
        if metrics is None:
            no_xbrl.append(ticker)
            continue
        
        result = screen_company(metrics, ticker, info)
        if result:
            candidates.append(result)
            print(f"  [PASS] {ticker:6s} {info['title'][:45]:45s} rev=${result['revenue_b']:5.1f}B  GM={result['gross_margin']*100:5.1f}%  RD={result['rd_ratio']*100:5.1f}%  CFO/NI={result['cfo_ni_ratio']:5.2f}")
        else:
            # 诊断失败原因
            if metrics["revenue"] > REVENUE_CAP_USD:
                failed_rev.append(ticker)
            elif metrics.get("gross_margin") is None or metrics["gross_margin"] <= GROSS_MARGIN_MIN:
                failed_gm.append(ticker)
            elif metrics.get("rd_ratio", 0) <= RD_RATIO_MIN:
                failed_rd.append(ticker)
            elif metrics["net_income"] <= 0:
                failed_loss.append(ticker)
            elif metrics.get("cfo_ni_ratio") is None or metrics["cfo_ni_ratio"] <= CFO_NI_RATIO_MIN:
                failed_cfo.append(ticker)
    
    # 总结
    print(f"\n{'='*60}")
    print(f"Results:")
    print(f"  PASSED: {len(candidates)}")
    print(f"  No XBRL data: {len(no_xbrl)} -> {no_xbrl}")
    print(f"  Not in SEC: {len(not_found)} -> {not_found}")
    print(f"  Rev > cap: {len(failed_rev)}")
    print(f"  GM failed: {len(failed_gm)}")
    print(f"  RD failed: {len(failed_rd)}")
    print(f"  Net loss: {len(failed_loss)}")
    print(f"  CFO/NI failed: {len(failed_cfo)}")
    
    # 保存
    if candidates:
        df = pd.DataFrame(candidates)
        df["score"] = (
            df["gross_margin"] * 0.4
            + df["rd_ratio"] * 0.3
            + df["cfo_ni_ratio"].clip(0, 5) * 0.06
        )
        df = df.sort_values("score", ascending=False)
        
        csv_path = OUTPUT_DIR / "us_candidates.csv"
        df.to_csv(csv_path, index=False)
        print(f"\n  Saved to {csv_path}")
        
        pd.set_option("display.max_columns", 12)
        pd.set_option("display.width", 140)
        pd.set_option("display.float_format", "{:.3f}".format)
        print("\nCandidates ranked by composite score:")
        print(df.to_string())
    
    return candidates


if __name__ == "__main__":
    candidates = run_targeted_screen()
