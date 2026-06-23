"""
A股隐形冠军初筛器 v2
===================
使用 akshare 作为主要数据源，批量+逐股补充R&D数据。
数据源：
  - akshare.stock_yjbb_em()     → 业绩报表（营收、毛利率、净利润、每股经营现金流）
  - akshare.stock_xjll_em()     → 现金流量表（经营性现金流净额）
  - akshare.stock_financial_benefit_ths() → 利润表详细（研发费用, R&D补充）

筛选条件：
1. 毛利率 > 30%
2. 研发费用率 > 5%
3. 经营现金流净额/净利润 > 0.7（3年均值）
4. 营收 1亿-100亿
5. 非ST、非*ST

输出：ashare_candidates.csv
"""

import akshare as ak
import pandas as pd
import numpy as np
from pathlib import Path
import time
import warnings
import sys

warnings.filterwarnings("ignore")

# --- 配置 ---
OUTPUT_DIR = Path(__file__).parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

REVENUE_MIN_YI = 1        # 营收下限（亿元）
REVENUE_MAX_YI = 100      # 营收上限（亿元）
GROSS_MARGIN_MIN = 0.30   # 最低毛利率 30%
RD_RATIO_MIN = 0.05       # 最低研发费用率 5%
CFO_NI_RATIO_MIN = 0.70   # 经营现金流/净利润最低 0.7

# 目标年份
TARGET_YEARS = ["20231231", "20241231", "20251231"]


def fetch_yjbb_batch(years: list) -> dict:
    """
    批量获取多年业绩报表数据。
    返回 {year_date: DataFrame}
    """
    results = {}
    for yr in years:
        print(f"\n  Fetching stock_yjbb_em(date='{yr}')...", end=" ", flush=True)
        try:
            df = ak.stock_yjbb_em(date=yr)
            results[yr] = df
            print(f"OK ({len(df)} rows)")
        except Exception as e:
            print(f"FAILED: {e}")
            # Try fallback date
            fallback = yr[:4] + "0331"
            print(f"    Trying fallback '{fallback}'...", end=" ", flush=True)
            try:
                df = ak.stock_yjbb_em(date=fallback)
                results[yr] = df
                print(f"OK ({len(df)} rows)")
            except Exception as e2:
                print(f"FAILED: {e2}")
        time.sleep(1)
    return results


def fetch_cashflow_batch() -> pd.DataFrame:
    """获取现金流量表数据。"""
    print("\n  Fetching stock_xjll_em...", end=" ", flush=True)
    try:
        df = ak.stock_xjll_em(date="20251231")
    except Exception:
        print("(20251231 failed, trying 20250331)", end=" ", flush=True)
        try:
            df = ak.stock_xjll_em(date="20250331")
        except Exception:
            print("(also failed, trying 20240930)", end=" ", flush=True)
            try:
                df = ak.stock_xjll_em(date="20240930")
            except Exception as e:
                print(f"ALL FAILED: {e}")
                return pd.DataFrame()
    print(f"OK ({len(df)} rows)")
    print(f"    Columns: {df.columns.tolist()}")
    return df


def build_base_metrics(yjbb_dict: dict, cf_df: pd.DataFrame) -> pd.DataFrame:
    """
    从 yjbb 和现金流数据构建基础指标表。
    合并多年数据，计算3年均值。
    """
    print("\n  Building base metrics...")

    all_frames = []
    for yr, df in yjbb_dict.items():
        if df.empty:
            continue
        yr_label = yr[:4]

        # Normalize columns
        col_map = {}
        for c in df.columns:
            if '营业总收入-营业总收入' in c or c == '营业总收入':
                col_map[c] = 'revenue'
            elif '净利润-净利润' in c or c == '净利润':
                col_map[c] = 'net_profit'
            elif '销售毛利率' in c:
                col_map[c] = 'gross_margin'
            elif '每股收益' in c:
                col_map[c] = 'eps'
            elif '每股经营现金流量' in c:
                col_map[c] = 'eps_cf'
            elif '股票代码' in c:
                col_map[c] = 'code'
            elif '股票简称' in c:
                col_map[c] = 'name'
            elif '所处行业' in c:
                col_map[c] = 'industry'

        sub = df.rename(columns=col_map)
        keep = [v for v in col_map.values() if v in sub.columns]
        sub = sub[keep].copy()

        # Ensure code is string
        if 'code' in sub.columns:
            sub['code'] = sub['code'].astype(str).str.strip().str.zfill(6)

        # Tag year
        for metric in ['revenue', 'net_profit', 'gross_margin', 'eps', 'eps_cf']:
            if metric in sub.columns:
                sub[f'{metric}_{yr_label}'] = pd.to_numeric(sub[metric], errors='coerce')

        all_frames.append(sub)

    if not all_frames:
        print("  ERROR: No yjbb data loaded")
        return pd.DataFrame()

    # Merge all years on code, name, industry
    merged = all_frames[0][['code']]
    for c in ['name', 'industry']:
        if c in all_frames[0].columns:
            merged[c] = all_frames[0][c]

    for frame in all_frames:
        yr_cols = [c for c in frame.columns if c not in ['code', 'name', 'industry']]
        merge_cols = ['code'] + yr_cols
        merged = merged.merge(frame[merge_cols], on='code', how='left')

    # Use latest year's revenue/NI/gross_margin (2025)
    yr_labels = sorted(set(
        c.split('_')[-1] for c in merged.columns
        if c.startswith(('revenue_', 'net_profit_', 'gross_margin_', 'eps_', 'eps_cf_'))
        and c.split('_')[-1].isdigit()
    ))

    latest_yr = yr_labels[-1] if yr_labels else None

    if latest_yr:
        merged['revenue'] = merged.get(f'revenue_{latest_yr}', np.nan)
        merged['net_profit'] = merged.get(f'net_profit_{latest_yr}', np.nan)
        merged['gross_margin_raw'] = merged.get(f'gross_margin_{latest_yr}', np.nan)
        merged['eps'] = merged.get(f'eps_{latest_yr}', np.nan)
        merged['eps_cf'] = merged.get(f'eps_cf_{latest_yr}', np.nan)

    # Calculate 3-year average CFO/NI from per-share data
    eps_cf_cols = [c for c in merged.columns if c.startswith('eps_cf_')]
    eps_cols = [c for c in merged.columns if c.startswith('eps_')]

    if eps_cf_cols and eps_cols:
        # Average per-share CF over available years
        merged['eps_cf_avg'] = merged[eps_cf_cols].mean(axis=1)
        merged['eps_avg'] = merged[eps_cols].mean(axis=1)

        # CFO/NI ratio from per-share data
        mask = merged['eps_avg'].abs() > 0.001
        merged['cfo_ni_ratio'] = np.where(
            mask,
            merged['eps_cf_avg'] / merged['eps_avg'],
            np.nan
        )
        # Clip extreme values
        merged['cfo_ni_ratio'] = merged['cfo_ni_ratio'].clip(-50, 50)
    else:
        merged['cfo_ni_ratio'] = np.nan

    # Revenue in 亿
    merged['revenue_yi'] = merged['revenue'] / 1e8

    # Use yjbb's pre-calculated gross margin (it's already a percentage/ratio)
    # stock_yjbb_em returns 销售毛利率 as percentage (e.g., 30.5 means 30.5%)
    # Normalize to 0-1 range
    if 'gross_margin_raw' in merged.columns:
        gm = pd.to_numeric(merged['gross_margin_raw'], errors='coerce')
        # If values are >1, they're percentages; divide by 100
        merged['gross_margin'] = np.where(gm > 1, gm / 100, gm)
    else:
        merged['gross_margin'] = np.nan

    # Merge cash flow data for verification (optional)
    if not cf_df.empty:
        cf_sub = pd.DataFrame()
        code_col_cf = None
        for c in ['股票代码', 'SECURITY_CODE']:
            if c in cf_df.columns:
                code_col_cf = c
                break
        if code_col_cf:
            cf_sub['code'] = cf_df[code_col_cf].astype(str).str.strip().str.zfill(6)
            for c in cf_df.columns:
                if '经营性现金流-现金流量净额' in c:
                    cf_sub['operating_cf_amount'] = pd.to_numeric(cf_df[c], errors='coerce')
                    break
            if 'operating_cf_amount' in cf_sub.columns:
                merged = merged.merge(cf_sub, on='code', how='left')
                # Verify CFO/NI using absolute amounts
                mask2 = merged['net_profit'].abs() > 1e6
                merged['cfo_ni_from_abs'] = np.where(
                    mask2,
                    merged['operating_cf_amount'] / merged['net_profit'],
                    np.nan
                )
                merged['cfo_ni_from_abs'] = merged['cfo_ni_from_abs'].clip(-50, 50)

                # Use per-share calculation if available, fall back to absolute
                if merged['cfo_ni_ratio'].isna().all():
                    merged['cfo_ni_ratio'] = merged['cfo_ni_from_abs']

    print(f"    Base metrics built for {len(merged)} companies")
    print(f"    Years available: {yr_labels}")
    return merged


def filter_st(stocks: pd.DataFrame) -> pd.DataFrame:
    """排除ST/退市股票。"""
    if 'name' in stocks.columns:
        before = len(stocks)
        stocks = stocks[~stocks['name'].str.contains('ST|退', na=False)]
        print(f"    Non-ST filter: {before} → {len(stocks)}")
    return stocks


def first_pass_screen(df: pd.DataFrame) -> pd.DataFrame:
    """第一轮筛选（不含R&D，使用批量数据）。"""
    print("\n--- First Pass Screen (without R&D) ---")
    initial = len(df)

    # Filter 0: Non-ST
    df = filter_st(df)

    # Filter 1: Revenue range
    mask_rev = df['revenue_yi'].notna() & (df['revenue_yi'] >= REVENUE_MIN_YI) & (df['revenue_yi'] < REVENUE_MAX_YI)
    print(f"    Revenue {REVENUE_MIN_YI}亿-{REVENUE_MAX_YI}亿: {mask_rev.sum()}")

    # Filter 2: Gross margin
    mask_gm = df['gross_margin'].notna() & (df['gross_margin'] > GROSS_MARGIN_MIN)
    print(f"    Gross margin > {GROSS_MARGIN_MIN*100:.0f}%: {mask_gm.sum()}")

    # Filter 3: CFO/NI ratio
    mask_cfo = df['cfo_ni_ratio'].notna() & (df['cfo_ni_ratio'] > CFO_NI_RATIO_MIN)
    print(f"    CFO/NI > {CFO_NI_RATIO_MIN}: {mask_cfo.sum()}")

    combined = mask_rev & mask_gm & mask_cfo
    print(f"    Combined: {combined.sum()} / {initial}")

    return df[combined].copy()


def fetch_rd_for_candidates(candidates: pd.DataFrame) -> pd.DataFrame:
    """
    对初筛通过的股票，逐股获取R&D费用数据。
    使用 stock_financial_benefit_ths。
    """
    codes = candidates['code'].tolist()
    total = len(codes)
    print(f"\n--- Fetching R&D data for {total} candidates ---")

    rd_records = []
    for i, code in enumerate(codes):
        if (i + 1) % 20 == 0 or i == 0:
            print(f"    Progress: {i+1}/{total}", flush=True)

        try:
            df = ak.stock_financial_benefit_ths(symbol=code, indicator='按报告期')

            if df.empty or '研发费用' not in df.columns:
                rd_records.append({'code': code, 'rd_expense': np.nan, 'operating_cost': np.nan})
                continue

            # Get the latest report with R&D data
            df = df.sort_values('报告期', ascending=False)
            rd_vals = pd.to_numeric(df['研发费用'], errors='coerce')
            # Find the first valid (non-null, non-zero) R&D value
            valid_rd = rd_vals[rd_vals.notna() & (rd_vals != 0)]
            rd_expense = valid_rd.iloc[0] if len(valid_rd) > 0 else np.nan

            # Get operating cost (营业成本) from the same report
            cost_col = None
            for c in ['营业成本', '其中：营业成本']:
                if c in df.columns:
                    cost_col = c
                    break
            operating_cost = np.nan
            if cost_col:
                cost_vals = pd.to_numeric(df[cost_col], errors='coerce')
                valid_cost = cost_vals[cost_vals.notna() & (cost_vals != 0)]
                operating_cost = valid_cost.iloc[0] if len(valid_cost) > 0 else np.nan

            rd_records.append({
                'code': code,
                'rd_expense': rd_expense,
                'operating_cost': operating_cost,
            })

        except Exception as e:
            rd_records.append({'code': code, 'rd_expense': np.nan, 'operating_cost': np.nan})

        time.sleep(0.12)  # Rate limit

    print(f"    Done. Fetched R&D for {len(rd_records)} stocks")
    rd_df = pd.DataFrame(rd_records)
    return candidates.merge(rd_df, on='code', how='left')


def final_screen(df: pd.DataFrame) -> pd.DataFrame:
    """最终筛选（加入R&D条件）。"""
    print("\n--- Final Screen (with R&D) ---")

    # Calculate R&D ratio
    mask_valid = df['revenue'].notna() & (df['revenue'] > 0) & df['rd_expense'].notna() & (df['rd_expense'] > 0)
    df['rd_ratio'] = np.where(mask_valid, df['rd_expense'] / df['revenue'], np.nan)

    # Also calculate gross margin from operating cost (more accurate than yjbb's)
    mask_cost = df['revenue'].notna() & df['operating_cost'].notna() & (df['revenue'] > 0)
    df['gross_margin_calc'] = np.where(
        mask_cost,
        (df['revenue'] - df['operating_cost']) / df['revenue'],
        np.nan
    )

    # Use calculated gross margin if available, else use yjbb's
    df['gross_margin_final'] = df['gross_margin_calc'].fillna(df['gross_margin'])

    with_rd = df['rd_ratio'].notna() & (df['rd_ratio'] > RD_RATIO_MIN)
    print(f"    With R&D data: {df['rd_ratio'].notna().sum()}")
    print(f"    R&D ratio > {RD_RATIO_MIN*100:.0f}%: {with_rd.sum()}")

    gm_ok = df['gross_margin_final'].notna() & (df['gross_margin_final'] > GROSS_MARGIN_MIN)
    print(f"    Gross margin (calc) > {GROSS_MARGIN_MIN*100:.0f}%: {gm_ok.sum()}")

    df = df[with_rd & gm_ok].copy()

    # Composite score
    df['score'] = (
        df['gross_margin_final'].fillna(0) * 0.35 +
        df['rd_ratio'].fillna(0) * 0.35 +
        df['cfo_ni_ratio'].clip(0, 3).fillna(0) * 0.30
    )
    df = df.sort_values('score', ascending=False)

    return df


def main():
    print("=" * 65)
    print("  A股隐形冠军初筛器 v2")
    print("=" * 65)
    print(f"  Criteria: GM>{GROSS_MARGIN_MIN*100:.0f}% | R&D>{RD_RATIO_MIN*100:.0f}% | CFO/NI>{CFO_NI_RATIO_MIN} | Rev {REVENUE_MIN_YI}-{REVENUE_MAX_YI}亿")
    print()

    # Step 1: Fetch yjbb batch data (multi-year for 3-year averages)
    print("[Step 1] Fetching业绩报表 (yjbb) for multiple years...")
    yjbb_data = fetch_yjbb_batch(TARGET_YEARS)
    if not yjbb_data:
        print("ERROR: Failed to fetch any yjbb data")
        return None
    # Print columns from first successful year
    first_yr = next(iter(yjbb_data.values()))
    print(f"\n  yjbb columns: {first_yr.columns.tolist()}")
    print(f"  Sample (first 3 rows):")
    print(first_yr.head(3).to_string())

    # Step 2: Fetch cash flow data
    print("\n[Step 2] Fetching现金流量表 (xjll)...")
    cf_df = fetch_cashflow_batch()

    # Step 3: Build base metrics
    print("\n[Step 3] Building base metrics...")
    base = build_base_metrics(yjbb_data, cf_df)
    if base.empty:
        print("ERROR: Failed to build metrics")
        return None
    print(f"  Base metrics: {len(base)} companies")
    print(f"  Columns: {base.columns.tolist()}")
    print(f"  Sample revenue_yi stats: min={base['revenue_yi'].min():.2f}, max={base['revenue_yi'].max():.2f}")
    if 'gross_margin' in base.columns:
        print(f"  Sample gross_margin stats: min={base['gross_margin'].min():.3f}, max={base['gross_margin'].max():.3f}")
    if 'cfo_ni_ratio' in base.columns:
        print(f"  Sample cfo_ni_ratio stats: min={base['cfo_ni_ratio'].min():.3f}, max={base['cfo_ni_ratio'].max():.3f}")

    # Step 4: First pass screen
    print("\n[Step 4] First pass screen (without R&D)...")
    candidates = first_pass_screen(base)
    print(f"  First pass candidates: {len(candidates)}")

    if len(candidates) == 0:
        print("  No candidates passed first screen.")
        return None

    # Step 5: Fetch R&D for candidates
    print(f"\n[Step 5] Fetching R&D data for {len(candidates)} candidates...")
    enriched = fetch_rd_for_candidates(candidates)

    # Step 6: Final screen
    print("\n[Step 6] Final screen (with R&D)...")
    final = final_screen(enriched)

    if len(final) == 0:
        print("  No candidates passed final screen.")
        return None

    # Step 7: Output
    print(f"\n{'=' * 65}")
    print(f"  FINAL CANDIDATE POOL: {len(final)} companies")
    print(f"{'=' * 65}")

    # Save CSV
    csv_path = OUTPUT_DIR / "ashare_candidates.csv"
    output_cols = ['code', 'name', 'revenue_yi', 'gross_margin', 'gross_margin_calc',
                   'gross_margin_final', 'rd_expense', 'rd_ratio',
                   'cfo_ni_ratio', 'net_profit', 'industry', 'score']
    available_cols = [c for c in output_cols if c in final.columns]
    final[available_cols].to_csv(csv_path, index=False, encoding='utf-8-sig')
    print(f"\n  Saved to: {csv_path}")

    # Print top 30
    pd.set_option('display.max_columns', 12)
    pd.set_option('display.width', 140)
    pd.set_option('display.float_format', '{:.3f}'.format)

    display_cols = ['code', 'name', 'revenue_yi', 'gross_margin_final', 'rd_ratio',
                    'cfo_ni_ratio', 'industry', 'score']
    available_display = [c for c in display_cols if c in final.columns]
    top30 = final[available_display].head(30).reset_index(drop=True)

    print(f"\n{'─' * 100}")
    print("  TOP 30 CANDIDATES")
    print(f"{'─' * 100}")
    print(top30.to_string())
    print(f"{'─' * 100}")

    # Summary stats
    print(f"\n  Summary Statistics:")
    if 'gross_margin_final' in final.columns:
        print(f"    Gross margin: median={final['gross_margin_final'].median():.1%}, mean={final['gross_margin_final'].mean():.1%}")
    if 'rd_ratio' in final.columns:
        print(f"    R&D ratio: median={final['rd_ratio'].median():.1%}, mean={final['rd_ratio'].mean():.1%}")
    if 'cfo_ni_ratio' in final.columns:
        print(f"    CFO/NI: median={final['cfo_ni_ratio'].median():.2f}, mean={final['cfo_ni_ratio'].mean():.2f}")
    if 'revenue_yi' in final.columns:
        print(f"    Revenue (亿): median={final['revenue_yi'].median():.1f}, mean={final['revenue_yi'].mean():.1f}")

    # Industry breakdown
    if 'industry' in final.columns:
        print(f"\n  Top Industries:")
        industry_counts = final['industry'].value_counts().head(10)
        for ind, count in industry_counts.items():
            print(f"    {ind}: {count}")

    return final


if __name__ == "__main__":
    result = main()
