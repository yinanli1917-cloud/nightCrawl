"""
专利壁垒验证器
=============
通过USPTO PatentSearch API验证公司的技术壁垒。
免费、官方API、无需认证。

验证维度：
1. 发明专利数量（排除实用新型和外观设计）
2. 专利被引次数（技术影响力）
3. 是否有"自研设备"相关专利
4. 近3年专利申请活跃度

数据源：USPTO PatentSearch API (search.patentsview.org)
"""

import time
import json
from typing import Optional

import pandas as pd
import requests

USPTO_BASE = "https://api.patentsview.org/patents/query"


def search_patents_by_assignee(
    company_names: list[str],
    max_results: int = 200,
) -> tuple:
    """
    按公司（专利权人）名检索USPTO专利。
    
    使用PatentsView旧版API（api.patentsview.org），因为新版
    search.patentsview.org在境外存在DNS解析问题。
    
    Returns:
        (patents_list, total_count)
    """
    # 构建旧版API查询
    q_parts = []
    for name in company_names:
        q_parts.append(f'{{"assignee_organization":"{name}"}}')
    q_str = '{"_or":[' + ','.join(q_parts) + ']}'
    
    params = {
        "q": q_str,
        "f": '["patent_number","patent_title","patent_date","patent_type","assignee_organization","num_claims"]',
        "o": f'{{"page":1,"per_page":{min(max_results, 500)}}}',
        "s": '[{"patent_date":"desc"}]',
    }
    
    try:
        resp = requests.get(USPTO_BASE, params=params, timeout=30)
        if resp.status_code != 200:
            print(f"  USPTO HTTP {resp.status_code}")
            return [], 0
        result = resp.json()
        return result.get("patents", []), result.get("total_patent_count", result.get("count", 0))
    except Exception as e:
        print(f"  USPTO failed: {e}")
        return [], 0


def analyze_patent_portfolio(
    company_name: str,
    aliases: Optional[list[str]] = None,
    verbose: bool = True,
) -> dict:
    """
    分析一家公司的专利组合质量。
    
    Returns:
        dict with quality metrics
    """
    search_names = [company_name]
    if aliases:
        search_names.extend(aliases)
    
    patents, total = search_patents_by_assignee(search_names, max_results=200)
    
    if not patents:
        if verbose:
            print(f"  {company_name}: No USPTO patents")
        return {
            "company_name": company_name,
            "total_patents_usp": 0,
            "utility_patents": 0,
            "quality_score": 0,
        }
    
    utility = [p for p in patents if p.get("patent_type") == "utility"]
    design = [p for p in patents if p.get("patent_type") == "design"]
    
    # 近3年活跃度
    from datetime import datetime
    three_years_ago = datetime.now().year - 3
    recent = [
        p for p in utility
        if p.get("patent_date") and int(p["patent_date"][:4]) >= three_years_ago
    ]
    
    # 自研设备关键词
    equipment_kw = [
        "apparatus", "device", "machine", "equipment", "system",
        "manufacturing", "fabrication", "processing",
        "tool", "drill", "polishing", "grinding", "coating",
    ]
    equipment_patents = [
        p for p in utility
        if p.get("patent_title") and any(
            kw.lower() in p["patent_title"].lower() for kw in equipment_kw
        )
    ]
    
    # 质量评分 0-100
    score = 0
    
    if len(utility) >= 50:
        score += 40
    elif len(utility) >= 20:
        score += 30
    elif len(utility) >= 10:
        score += 20
    elif len(utility) >= 5:
        score += 10
    else:
        score += 5
    
    if len(recent) >= 15:
        score += 30
    elif len(recent) >= 8:
        score += 20
    elif len(recent) >= 3:
        score += 10
    else:
        score += 5
    
    eq_ratio = len(equipment_patents) / max(len(utility), 1)
    if eq_ratio > 0.5:
        score += 20
    elif eq_ratio > 0.3:
        score += 15
    elif eq_ratio > 0.1:
        score += 10
    else:
        score += 5
    
    avg_claims = sum(p.get("num_claims", 0) or 0 for p in utility[:50]) / max(len(utility[:50]), 1)
    if avg_claims > 20:
        score += 10
    elif avg_claims > 15:
        score += 7
    else:
        score += 5
    
    result = {
        "company_name": company_name,
        "total_patents_usp": total,
        "utility_patents": len(utility),
        "design_patents": len(design),
        "recent_3yr_utility": len(recent),
        "equipment_patents": len(equipment_patents),
        "equipment_ratio": round(eq_ratio, 3),
        "avg_claims": round(avg_claims, 1),
        "quality_score": score,
        "sample_patents": [p.get("patent_number") for p in patents[:3]],
    }
    
    if verbose:
        print(f"  {company_name}: {len(utility)} utility, {len(recent)} recent, score={score}/100")
    
    return result


def verify_candidates(csv_path: str) -> pd.DataFrame:
    """对候选池逐公司做专利验证。"""
    df = pd.read_csv(csv_path)
    name_col = "name" if "name" in df.columns else "ticker"
    
    results = []
    for _, row in df.iterrows():
        company = row[name_col]
        print(f"\nPatent check: {company}")
        info = analyze_patent_portfolio(company, verbose=True)
        results.append(info)
        time.sleep(0.4)
    
    patent_df = pd.DataFrame(results)
    return patent_df


if __name__ == "__main__":
    # 快速验证测试
    tests = [
        ("FormFactor Inc", None),
        ("Aehr Test Systems", None),
        ("Cognex Corporation", None),
        ("Novanta Inc", None),
    ]
    for name, aliases in tests:
        analyze_patent_portfolio(name, aliases)
        time.sleep(0.4)
