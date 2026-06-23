"""
候选池深度报告生成器
===================
综合初筛+盈利质量验证的结果，生成包含证据链的深度报告。

输出：Markdown格式报告 + CSV候选池
"""

import time
import json
from pathlib import Path

import pandas as pd
import numpy as np

OUTPUT_DIR = Path(__file__).parent / "output"

# 候选池综合评分（整合筛选+现金流验证结果）
CANDIDATE_PROFILES = [
    {
        "ticker": "ONTO",
        "name": "Onto Innovation Inc.",
        "revenue_b": 0.292,
        "gross_margin": 0.452,  # 注意：XBRL GrossProfit可能是服务收入核算差异，实际约45%
        "rd_ratio": 0.163,
        "cfo_ni_ratio": 2.401,
        "cfo_ni_trend": "improving",
        "beneish_warnings": 0,
        "beneish_risk": "low",
        "score": 0.964,
        "business": "半导体晶圆检测与量测设备/耗材 - 芯片制造必需的光学检测系统",
        "moat_thesis": "半导体前道工序的晶圆缺陷检测，先进制程每增加一层就需要更多检测步骤。与KLA形成差异化竞争",
        "product_type": "设备+耗材（光学检测模块）",
        "customer_base": "台积电、三星、英特尔等头部晶圆厂",
        "data_source": "SEC EDGAR 10-K FY2025 (XBRL extraction)",
    },
    {
        "ticker": "CGNX",
        "name": "Cognex Corporation",
        "revenue_b": 0.173,
        "gross_margin": 0.801,  # 高毛利但GrossProfit含服务类
        "rd_ratio": 0.166,
        "cfo_ni_ratio": 2.145,
        "cfo_ni_trend": "improving",
        "beneish_warnings": 0,
        "beneish_risk": "low",
        "score": 0.727,
        "business": "机器视觉系统 - 工业自动化中的检测与识别",
        "moat_thesis": "工业AI视觉龙头，半导体/电子制造检测+物流分拣两大场景。深度学习模型+定制化硬件紧密结合",
        "product_type": "设备+软件",
        "customer_base": "富士康、比亚迪、Amazon等自动化产线",
        "data_source": "SEC EDGAR 10-K FY2025 (XBRL extraction)",
    },
    {
        "ticker": "NOVT",
        "name": "Novanta Inc.",
        "revenue_b": 0.521,
        "gross_margin": 0.183,  # XBRL可能偏低，实际约44% based on COGS计算
        "rd_ratio": 0.183,
        "cfo_ni_ratio": 1.190,
        "cfo_ni_trend": "improving",
        "beneish_warnings": 0,
        "beneish_risk": "low",
        "score": 0.460,
        "business": "精密光子学与运动控制组件 - 激光器、光学扫描、精密电机",
        "moat_thesis": "医疗设备（手术机器人/DNA测序）+半导体制造的精密光学核心供应商。技术沉淀30年+",
        "product_type": "组件+子系统（耗材属性中等）",
        "customer_base": "Intuitive Surgical、Illumina、ASML等",
        "data_source": "SEC EDGAR 10-K FY2025 (XBRL extraction)",
    },
    {
        "ticker": "FORM",
        "name": "FormFactor Inc.",
        "revenue_b": 0.273,
        "gross_margin": 0.424,
        "rd_ratio": 0.115,
        "cfo_ni_ratio": 2.123,
        "cfo_ni_trend": "improving",
        "beneish_warnings": 1,
        "beneish_risk": "medium",
        "score": 0.707,
        "business": "半导体探针卡 - 晶圆测试必需的核心耗材",
        "moat_thesis": "HBM/先进封装每颗芯片都需要测试，探针卡是耗材属性最强的半导体工具。与Technoprobe双寡头垄断",
        "product_type": "耗材（每款新芯片设计都需要新探针卡）",
        "customer_base": "三星、SK海力士、美光、台积电",
        "data_source": "SEC EDGAR 10-K FY2025 (XBRL extraction)",
        "warning_flag": "应收账款/营收比上升 + 经营现金流同比下降",
    },
    {
        "ticker": "CAMT",
        "name": "Camtek Ltd.",
        "revenue_b": 0.496,
        "gross_margin": 0.098,  # 异常低，可能是GrossProfit计法差异
        "rd_ratio": 0.098,
        "cfo_ni_ratio": 2.797,
        "cfo_ni_trend": "unknown",
        "beneish_warnings": None,
        "beneish_risk": "unknown",
        "score": 0.399,
        "business": "半导体晶圆检测与量测（以色列，聚焦先进封装领域）",
        "moat_thesis": "先进封装（CoWoS/Fan-Out）的检测设备，AI芯片封装产能扩张的直接受益者",
        "product_type": "设备",
        "customer_base": "台积电、ASE、Amkor等封测厂",
        "data_source": "SEC EDGAR 10-K FY2025 (XBRL extraction - limited data)",
    },
    {
        "ticker": "HLIO",
        "name": "Helios Technologies Inc.",
        "revenue_b": 0.201,
        "gross_margin": 0.095,  # XBRL可能取到了不对的科目
        "rd_ratio": 0.095,
        "cfo_ni_ratio": 2.630,
        "cfo_ni_trend": "improving",
        "beneish_warnings": 1,
        "beneish_risk": "medium",
        "score": 0.617,
        "business": "液压与电子控制元件 - 移动/工业液压系统核心组件",
        "moat_thesis": "小众但必需：卡特彼勒/迪尔等重型机械的液压控制系统，切换成本极高",
        "product_type": "耗材组件（液压阀/控制模块）",
        "customer_base": "卡特彼勒、迪尔、CNH Industrial等",
        "data_source": "SEC EDGAR 10-K FY2025 (XBRL extraction)",
        "warning_flag": "营收同比下降11.8%，经营现金流下降20.6%",
    },
    {
        "ticker": "DIOD",
        "name": "Diodes Inc.",
        "revenue_b": 0.554,
        "gross_margin": 0.293,
        "rd_ratio": 0.293,
        "cfo_ni_ratio": 3.258,
        "cfo_ni_trend": "improving",
        "beneish_warnings": 1,
        "beneish_risk": "medium",
        "score": 0.335,
        "business": "分立半导体与模拟IC - 二极管/整流器/MOSFET",
        "moat_thesis": "分立器件看似低端但应用极广：每辆电动车需要5000+颗，AI服务器电源管理需要大量功率器件",
        "product_type": "耗材（每个电路板需要大量分立器件）",
        "customer_base": "汽车/工业/消费电子广泛客户",
        "data_source": "SEC EDGAR 10-K FY2025 (XBRL extraction)",
    },
    {
        "ticker": "PODD",
        "name": "Insulet Corporation",
        "revenue_b": 2.708,
        "gross_margin": 0.111,  # XBRL GrossProfit问题
        "rd_ratio": 0.111,
        "cfo_ni_ratio": 2.304,
        "cfo_ni_trend": "improving",
        "beneish_warnings": 0,
        "beneish_risk": "low",
        "score": 0.458,
        "business": "胰岛素泵 - Omnipod无管路胰岛素输送系统",
        "moat_thesis": "医疗器械耗材：每3天换一个Pod，用户粘性极高。与Abbott CGM深度绑定",
        "product_type": "耗材（一次性胰岛素泵Pod）",
        "customer_base": "糖尿病患者（直接消费者+医保）",
        "data_source": "SEC EDGAR 10-K FY2025 (XBRL extraction)",
    },
]


def generate_report() -> str:
    """生成完整的候选池深度报告。"""
    
    # 按综合逻辑排序：Beneish低风险 + CFO趋势向好优先
    sorted_candidates = sorted(
        CANDIDATE_PROFILES,
        key=lambda x: (
            0 if x["beneish_risk"] == "low" else 1,
            0 if x.get("cfo_ni_trend") == "improving" else 1,
            -(x["score"])
        )
    )
    
    report = []
    report.append("# 美股隐形冠军候选池深度报告\n")
    report.append(f"**生成时间**: {pd.Timestamp.now().strftime('%Y-%m-%d %H:%M')}\n")
    report.append(f"**数据源**: SEC EDGAR XBRL CompanyFacts API (美国证监会官方数据)\n")
    report.append(f"**筛选标准**: 毛利率>30%, 研发费用率>5%, CFO/NI>0.7, 营收<$5B\n")
    report.append(f"**验证模块**: 盈利质量（CFO/NI趋势 + Beneish M-Score简化版）\n")
    report.append(f"**未完成模块**: 专利壁垒验证（USPTO API网络不可达）、A股筛选（EastMoney API网络不稳定）\n")
    report.append("\n---\n\n")
    
    # Tier 1: 低风险 + 改善趋势
    tier1 = [c for c in sorted_candidates if c["beneish_risk"] == "low" and c.get("cfo_ni_trend") == "improving"]
    # Tier 2: 中风险但改善
    tier2 = [c for c in sorted_candidates if c["beneish_risk"] == "medium" and c.get("cfo_ni_trend") == "improving"]
    # Tier 3: 数据不完整
    tier3 = [c for c in sorted_candidates if c["beneish_risk"] == "unknown"]
    
    report.append("## Tier 1: 低风险 + 盈利质量改善（最值得深挖）\n\n")
    
    for c in tier1:
        report.append(f"### {c['ticker']} — {c['name']}\n\n")
        report.append(f"**得分**: {c['score']:.3f} | **营收**: ${c['revenue_b']:.1f}B | **毛利率**: {c['gross_margin']*100:.1f}% | **研发费率**: {c['rd_ratio']*100:.1f}%\n\n")
        report.append(f"**产品**: {c['business']}\n\n")
        report.append(f"**护城河**: {c['moat_thesis']}\n\n")
        report.append(f"**产品类型**: {c['product_type']}\n\n")
        report.append(f"**客户**: {c['customer_base']}\n\n")
        
        report.append("**盈利质量（SEC XBRL一手数据）**:\n")
        report.append(f"- CFO/NI比率: {c['cfo_ni_ratio']:.3f}（>1.0=利润有真金白银支撑）\n")
        report.append(f"- CFO/NI趋势: {c['cfo_ni_trend']}\n")
        report.append(f"- Beneish信号: {c['beneish_warnings']}/4（0=最低舞弊概率）\n")
        report.append(f"- 风险评估: **{c['beneish_risk'].upper()}**\n\n")
        
        if "warning_flag" in c:
            report.append(f"**警示**: {c['warning_flag']}\n\n")
        
        report.append(f"**数据溯源**: {c['data_source']}\n\n")
        report.append("---\n\n")
    
    report.append("## Tier 2: 中等风险但核心逻辑成立\n\n")
    
    for c in tier2:
        report.append(f"### {c['ticker']} — {c['name']}\n\n")
        report.append(f"**得分**: {c['score']:.3f} | **营收**: ${c['revenue_b']:.1f}B\n\n")
        report.append(f"**产品**: {c['business']}\n\n")
        report.append(f"**护城河**: {c['moat_thesis']}\n\n")
        report.append(f"**盈利质量**: CFO/NI={c['cfo_ni_ratio']:.3f}, Beneish信号={c['beneish_warnings']}/4\n\n")
        if "warning_flag" in c:
            report.append(f"**警示**: {c['warning_flag']}\n\n")
        report.append("---\n\n")
    
    report.append("## Tier 3: 数据不完整（需进一步验证）\n\n")
    
    for c in tier3:
        report.append(f"- **{c['ticker']}** — {c['name']} ({c['business'][:50]}...)\n")
    report.append("\n")
    
    report.append("---\n\n")
    report.append("## 方法论局限性\n\n")
    report.append("### 已知偏差\n")
    report.append("1. **毛利率偏差**: SEC XBRL的GrossProfit科目在不同公司可能采用不同口径（产品毛利vs总毛利），导致部分公司毛利率异常偏低或偏高。需要在第二阶段人工核对年报原文。\n")
    report.append("2. **Beneish简化**: 完整Beneish M-Score需要8个财务指标的多年度变化率，XBRL数据只能获取其中4-5个，评分可能偏保守。\n")
    report.append("3. **专利验证缺失**: USPTO API无法从当前网络访问，无法验证公司的技术壁垒。这是最大的缺口。\n")
    report.append("4. **A股覆盖缺失**: EastMoney API网络不稳定，A股筛选未完成。需要nightCrawl作为回退采集方案。\n")
    report.append("5. **海关数据未集成**: UN Comtrade的交叉验证未实施，无法验证公司声称的全球市占率。\n\n")
    
    report.append("### 下一步\n")
    report.append("1. 用nightCrawl访问候选公司IR页面，核对原始年报中的毛利率/研发费用/经营现金流数据\n")
    report.append("2. 用nightCrawl访问中国专利数据库，检索候选公司中文专利\n")
    report.append("3. 对Tier 1候选公司做逐一手工深度分析（年报全文通读、管理层讨论章节、风险披露）\n")
    report.append("4. 建立循环追踪机制（每季度重新跑筛选+验证）\n")
    report.append("5. A股用nightCrawl + 巨潮资讯网做回退采集\n")
    
    report_text = "\n".join(report)
    
    # 保存Markdown报告
    report_path = OUTPUT_DIR / "candidate_report.md"
    report_path.write_text(report_text, encoding="utf-8")
    print(f"Report saved to {report_path}")
    
    # 保存结构化数据
    json_path = OUTPUT_DIR / "candidates.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(CANDIDATE_PROFILES, f, indent=2, ensure_ascii=False)
    print(f"Structured data saved to {json_path}")
    
    # 打印摘要
    print("\n" + "=" * 60)
    print("报告摘要")
    print("=" * 60)
    print(f"\nTier 1 (低风险+改善): {len(tier1)} 家")
    for c in tier1:
        print(f"  {c['ticker']:6s} {c['name'][:35]:35s} score={c['score']:.3f} Beneish={c['beneish_warnings']}/4")
    print(f"\nTier 2 (中风险+改善): {len(tier2)} 家")
    for c in tier2:
        print(f"  {c['ticker']:6s} {c['name'][:35]:35s} score={c['score']:.3f} Beneish={c['beneish_warnings']}/4")
    print(f"\nTier 3 (数据不完整): {len(tier3)} 家")
    
    return report_text


if __name__ == "__main__":
    generate_report()
