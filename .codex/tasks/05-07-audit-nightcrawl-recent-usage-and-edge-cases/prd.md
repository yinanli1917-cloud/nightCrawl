# Audit nightCrawl recent usage and edge cases

## Goal

Review recent cross-session nightCrawl usage, reproduce the remembered JavaScript/performance issues with real command loops, and stabilize any confirmed UX, performance, or bug regressions without weakening the digital-twin safety contract.

## Acceptance Criteria

- [ ] Prior handoff/memory evidence is reviewed and converted into a short diagnostic checklist.
- [ ] Real edge-case command runs cover at least: JavaScript evaluation correctness, JavaScript command latency, login-wall false positives, sensitive-page checks, and authenticated/handoff safety signals.
- [ ] Confirmed regressions are fixed with focused regression coverage where a deterministic seam exists.
- [ ] `js`/`eval` behavior remains correct for async object expressions and multiline scripts.
- [ ] Routine `js` inspection that does not navigate avoids the post-navigation login/sensitive-page stabilization tax.
- [ ] Unknown-domain handoff still reports consent requirements rather than opening silent windows.
- [ ] Verification includes targeted tests plus at least one real CLI smoke pass.

## Notes

- Evidence source: `HANDOFF.md` identifies unresolved issues around `js` detection latency, complex async JS results, Shine Connect login-wall false positives, cookie/session persistence, and end-to-end verification gaps.
- Current related task: `.codex/tasks/05-06-capture-fxbaogao-pdf/prd.md` records the FXBaogao scenario, including `nc js` returning blank for complex async object expressions.
