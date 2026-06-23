# Verify GitHub upstream version claim

## Goal

Verify whether prior Kimi-vs-nightCrawl claims were supported by reproducible upstream code and local artifacts, specifically including whether Xiaohongshu is hard-blocked in nightCrawl. Produce a benchmark design that can compare Kimi WebBridge and nightCrawl with real tests without risking the user's real accounts or relying on untracked local state as if it were a release.

## Acceptance Criteria

- [ ] Confirm from source whether Xiaohongshu/XHS domains are in the hardcoded hostile-domain blocklist.
- [ ] Verify the relevant hostile-domain behavior with focused tests.
- [ ] Identify which prior benchmark artifacts are reproducible from committed code versus local-only/untracked state.
- [ ] Design a side-by-side benchmark covering local browser-control boundaries, public web workflows, authenticated read-only workflows, hostile-platform safety behavior, local endpoint security, recovery, and UX observability.
- [ ] State explicit safety boundaries: no live Xiaohongshu test with the user's real account/session; live hostile-platform probing requires `BROWSE_INCOGNITO=1` and a sacrificial test account.

## Notes

## Safety Boundaries

- Xiaohongshu must not be tested with the user's real account or real browser cookies.
- The default XHS benchmark is a safety benchmark: blocklist enforcement, cookie filtering, and incognito gate behavior.
- Any live XHS probe is opt-in, uses `BROWSE_INCOGNITO=1`, and requires a sacrificial test account.
## Decisions

- hostile-account-safety: Use blocklist verification as the default XHS benchmark; live XHS tests are opt-in and test-account-only.
