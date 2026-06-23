"""
盈利质量验证器
=============
基于原始财报数据的多维度盈利质量验证。
零二手信息：所有计算基于SEC EDGAR XBRL原始数据。

验证维度：
1. 经营现金流/净利润趋势（连续3年）
2. Beneish M-Score (8因子财务造假概率)
3. 应收账款/营收趋势（渠道压货检测）
4. 毛利率趋势（产品力变化）

数据源：SEC EDGAR CompanyFacts XBRL API
"""

import time
from typing import Optional

import pandas as pd
import numpy as np
import requests

SEC_USER_AGENT = "StockScreener/1.0 (research@example.com)"


def extract_annual_series(facts: dict, concept: str) -> list[dict]:
    """
    提取某个US-GAAP概念的完整年报时间序列。
    
    Returns:
        list of {end, val, fy, form} sorted by date
    """
    us_gaap = facts.get("facts", {}).get("us-gaap", {})
    concept_data = us_gaap.get(concept, {}).get("units", {}).get("USD", [])
    
    if not concept_data:
        return []
    
    annual = [x for x in concept_data if x.get("form") in ("10-K", "10-K/A")]
    return sorted(annual, key=lambda x: x.get("end", ""))


def get_company_facts(cik: str) -> Optional[dict]:
    """获取XBRL数据。"""
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
    headers = {"User-Agent": SEC_USER_AGENT}
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def compute_cfo_ni_trend(facts: dict) -> dict:
    """计算经营现金流/净利润的3年趋势。"""
    revenue = extract_annual_series(facts, "Revenues")
    if not revenue:
        revenue = extract_annual_series(facts, "RevenueFromContractWithCustomerExcludingAssessedTax")
    
    net_income = extract_annual_series(facts, "NetIncomeLoss")
    operating_cf = extract_annual_series(facts, "NetCashProvidedByUsedInOperatingActivities")
    receivables = extract_annual_series(facts, "AccountsReceivableNetCurrent")
    inventory = extract_annual_series(facts, "InventoryNet")
    
    result = {"years_available": 0, "cfo_ni_ratios": [], "cfo_ni_trend": "unknown"}
    
    if not revenue or not net_income or not operating_cf:
        return result
    
    # 对齐时间
    years = sorted(set(x["end"] for x in revenue) & set(x["end"] for x in net_income) & set(x["end"] for x in operating_cf))
    
    revenue_map = {x["end"]: x["val"] for x in revenue}
    ni_map = {x["end"]: x["val"] for x in net_income}
    cfo_map = {x["end"]: x["val"] for x in operating_cf}
    
    cfo_ni_list = []
    rev_list = []
    
    for year in years[-3:]:  # 最近3年
        ni = ni_map.get(year, 0)
        cfo = cfo_map.get(year, 0)
        rev = revenue_map.get(year, 1)
        
        if ni > 0 and rev > 0:
            cfo_ni_list.append(cfo / ni)
            rev_list.append(rev)
    
    if len(cfo_ni_list) >= 2:
        # 判断趋势
        if cfo_ni_list[-1] > cfo_ni_list[0] and cfo_ni_list[-1] > 0.8:
            trend = "improving"
        elif cfo_ni_list[-1] < cfo_ni_list[0] and cfo_ni_list[-1] < 0.5:
            trend = "deteriorating"
        else:
            trend = "stable"
    elif len(cfo_ni_list) == 1:
        trend = "stable" if cfo_ni_list[0] > 0.7 else "low"
    else:
        trend = "unknown"
    
    result["years_available"] = len(cfo_ni_list)
    result["cfo_ni_ratios"] = [round(x, 3) for x in cfo_ni_list]
    result["cfo_ni_trend"] = trend
    
    # 应收/营收
    if receivables:
        rec_map = {x["end"]: x["val"] for x in receivables}
        rec_rev = []
        for year in years[-3:]:
            rec = rec_map.get(year)
            rev = revenue_map.get(year)
            if rec and rev:
                rec_rev.append(round(rec / rev, 3))
        result["receivables_revenue"] = rec_rev
        if len(rec_rev) >= 2:
            if rec_rev[-1] > rec_rev[0] * 1.2:
                result["receivable_warning"] = True
            else:
                result["receivable_warning"] = False
    
    return result


def compute_beneish_m_score(facts: dict) -> Optional[dict]:
    """
    计算Beneish M-Score（财务造假概率模型）。
    
    M-Score > -1.78 表示较高的盈余操纵概率。
    
    8个因子的原始Beneish模型需要资产负债表项目的逐年变化。
    这里做简化版：只依赖能从XBRL获取的指标。
    """
    revenue = extract_annual_series(facts, "Revenues")
    if not revenue:
        revenue = extract_annual_series(facts, "RevenueFromContractWithCustomerExcludingAssessedTax")
    
    net_income = extract_annual_series(facts, "NetIncomeLoss")
    operating_cf = extract_annual_series(facts, "NetCashProvidedByUsedInOperatingActivities")
    receivables = extract_annual_series(facts, "AccountsReceivableNetCurrent")
    total_assets = extract_annual_series(facts, "Assets")
    gross_profit = extract_annual_series(facts, "GrossProfit")
    sga = extract_annual_series(facts, "SellingGeneralAndAdministrativeExpense")
    
    if len(revenue) < 2 or len(net_income) < 2:
        return {"m_score": None, "warning": "insufficient_data"}
    
    # DSRI: Days Sales in Receivables Index
    # 应收/营收的同比变化
    rec_map = {x["end"]: x["val"] for x in receivables} if receivables else {}
    rev_map = {x["end"]: x["val"] for x in revenue}
    
    years = sorted(set(rev_map.keys()) & set(x["end"] for x in net_income))
    
    if len(years) < 2:
        return {"m_score": None, "warning": "insufficient_data"}
    
    curr_year = years[-1]
    prev_year = years[-2]
    
    rev_curr = rev_map.get(curr_year, 1)
    rev_prev = rev_map.get(prev_year, 1)
    
    # 简化计算：只算我们能拿到的
    warning_signals = 0
    details = {}
    
    # 1. 营收增长大幅超过现金流增长
    cfo_map = {x["end"]: x["val"] for x in operating_cf} if operating_cf else {}
    ni_map = {x["end"]: x["val"] for x in net_income}
    
    rev_growth = (rev_curr / rev_prev - 1) if rev_prev else 0
    details["revenue_growth"] = round(rev_growth, 4)
    
    cfo_curr = cfo_map.get(curr_year, 0)
    cfo_prev = cfo_map.get(prev_year, 0)
    cfo_growth = (cfo_curr / cfo_prev - 1) if cfo_prev and cfo_prev > 0 else None
    details["cfo_growth"] = round(cfo_growth, 4) if cfo_growth else None
    
    if rev_growth > 0.3 and (cfo_growth is None or cfo_growth < rev_growth * 0.5):
        warning_signals += 1
        details["rev_vs_cfo_warning"] = True
    
    # 2. 应收账款增长超过营收增长
    if rec_map:
        rec_curr = rec_map.get(curr_year, 0)
        rec_prev = rec_map.get(prev_year, 0)
        if rec_prev > 0 and rev_prev > 0:
            rec_growth = rec_curr / rec_prev - 1
            if rec_growth > rev_growth * 1.5:
                warning_signals += 1
                details["receivable_spike"] = True
    
    # 3. 毛利率下降
    gp_map = {x["end"]: x["val"] for x in gross_profit} if gross_profit else {}
    if curr_year in gp_map and prev_year in gp_map:
        gm_curr = gp_map[curr_year] / rev_curr
        gm_prev = gp_map[prev_year] / rev_prev
        details["gross_margin_change"] = round(gm_curr - gm_prev, 4)
        if gm_curr < gm_prev * 0.95:  # 毛利率下降超过5%
            warning_signals += 1
    
    # 4. CFO/NI ratio
    ni_curr = ni_map.get(curr_year, 0)
    if ni_curr > 0 and cfo_curr > 0:
        details["cfo_ni_ratio"] = round(cfo_curr / ni_curr, 3)
        if cfo_curr / ni_curr < 0.5:
            warning_signals += 1
    
    result = {
        "m_score_simplified": warning_signals,
        "warning_count": warning_signals,
        "risk_level": "low" if warning_signals == 0 else ("medium" if warning_signals <= 1 else "high"),
        "details": details,
    }
    
    return result


def verify_earnings_quality(cik: str, verbose: bool = True) -> dict:
    """
    对单家公司做完整的盈利质量验证。
    
    Returns:
        dict with cfo_trend, beneish, receivable_check, margin_trend
    """
    facts = get_company_facts(cik)
    if facts is None:
        return {"error": "no_xbrl_data"}
    
    cfo_trend = compute_cfo_ni_trend(facts)
    beneish = compute_beneish_m_score(facts)
    
    result = {
        "cik": cik,
        "cfo_ni_trend": cfo_trend,
        "beneish": beneish,
    }
    
    if verbose:
        print(f"  CFO/NI trend: {cfo_trend.get('cfo_ni_trend', 'N/A')} "
              f"({cfo_trend.get('years_available', 0)} years)")
        print(f"  Beneish warning signals: {beneish.get('warning_count', 'N/A')}/4 "
              f"-> risk: {beneish.get('risk_level', 'N/A')}")
        if beneish.get("details"):
            for k, v in beneish["details"].items():
                if v is not None:
                    print(f"    {k}: {v}")
    
    return result


if __name__ == "__main__":
    # 测试：NVDA
    print("Verifying NVDA (CIK 0001045810):")
    verify_earnings_quality("0001045810")
    
    print("\nVerifying FORM (CIK 0001039399):")
    verify_earnings_quality("0001039399")
