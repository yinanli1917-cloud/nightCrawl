# Hybrid architecture decision gate (2026-05-29)

Based on unattended benchmark `artifacts/competitor-benchmark/run-2026-05-29T08-04-05-598Z`.

## Scorecard (nightCrawl)

| Gate | Result |
|------|--------|
| S2 example.com | pass |
| S5 hostile (unit only, no live XHS) | pass |
| S1 Canvas dashboard | pass |
| S4 daemon restart | pass |
| S4b sync now | pass |
| S6 CF dash goto | pass |
| headed_windows | 0 (BROWSE_AUTO_HANDOVER=0) |

Kimi WebBridge daemon was **not running** during this run (`kimi_daemon: false`) — rerun Kimi comparison when daemon is up; not blocking nightCrawl persistence work.

## Decision

1. **Ship headless-first nightCrawl** with Arc/Chrome cookie sync as the identity path. No Kimi runtime dependency.
2. **Do not build Kimi adapter** until a fair Kimi side-by-side rerun shows nightCrawl loses Tier-2 auth after persistence fixes.
3. **Real-browser bridge (optional future):** only if fingerprint-pinned SSO still fails after sync; must remain headless-by-default and never use live XHS.
4. **Continue iteration loop** on CF checkout SPA cart (full S6) as a follow-up task — dash reachability passed; cart/checkout headless flow not fully automated in this run.

## Product contract

See [headless-persistence-contract.md](./headless-persistence-contract.md).
