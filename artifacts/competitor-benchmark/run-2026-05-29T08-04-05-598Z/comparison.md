# Benchmark run 2026-05-29T08-04-05-598Z

## Gates (nightCrawl)

| Gate | Pass |
|------|------|
| S2_example | yes |
| S5_hostile_unit | yes |
| S1_canvas | yes |
| S4_restart | yes |
| S4b_sync | yes |
| S6_cf_dash | yes |
| kimi_daemon | no |

## Notes

- No XHS URLs in this run.
- `BROWSE_AUTO_HANDOVER=0` (headless-only product path).
- Artifacts: `/Users/yinanli/Documents/nightCrawl/artifacts/competitor-benchmark/run-2026-05-29T08-04-05-598Z`

## Hybrid decision (Phase 2)

- **Default:** headless nightCrawl + Arc cookie sync; no Kimi runtime dependency.
- **Kimi:** competitor benchmark only; optional adapter only if Tier-2 auth gaps remain after persistence fixes.
- **Real-browser bridge:** background cookie sync first; visible bridge only if scorecard proves sync insufficient for fingerprint-pinned SSO.

