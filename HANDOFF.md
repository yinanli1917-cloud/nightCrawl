# HANDOFF -- 2026-04-09 (Session 5 -- safety + auto-update)

## Mission Status

**Critical safety fix shipped + full auto-update infrastructure landed.**

This session pivoted hard mid-stream. The user reported that two of their real Xiaohongshu accounts had been permanently banned -- not from posting, but because a prior nightCrawl session logged in with real cookies on a non-incognito profile. XHS detected the automated Chromium fingerprint and banned both accounts.

The "never load real cookies on hostile platforms" rule had existed only as soft guidance in CLAUDE.md and memory files. Soft rules cannot enforce safety. The fix had to be code that throws errors.

## What's Done

### P1: Hostile-Domain Blocklist (the safety fix the ban demanded)

Hardcoded blocklist enforced by code in `stealth/browser/src/hostile-domains.ts`. Blocked domains: xiaohongshu.com, xhscdn.com, xhslink.com, douyin.com, iesdouyin.com, douyinpic.com, weibo.com, weibo.cn, weibocdn.com, linkedin.com, licdn.com, instagram.com, cdninstagram.com.

Wired into every entry path:
- `browser-manager.ts:newTab()` -- refuses navigation to hostile URL via `assertSafeNavigation()`
- `browser-manager.ts:restoreCookies()` -- unconditionally filters hostile cookies (no incognito bypass for cookies)
- `browser-manager.ts:restoreState()` -- filters hostile cookies + skips re-navigation to hostile saved URLs
- `browser-handoff.ts:handoff()` -- refuses headed mode if current URL is hostile
- `browser-handoff.ts:autoHandover()` -- refuses to open headed Chrome on hostile login walls (this is the EXACT path that triggered the XHS ban)

`BROWSE_INCOGNITO=1` is the only escape hatch for navigation, and even then cookies are still filtered.

**Tests:** 26 unit tests + 6 integration tests, all green.

### P2: Auto-Updater + Self-Verification

Replaced detect-only `checkForUpdates()` with `maybeAutoUpdate()` orchestrator. New files:

| File | Lines | Purpose |
|------|-------|---------|
| `src/hostile-domains.ts` | 121 | Hardcoded blocklist + assertSafeNavigation/filterHostileCookies |
| `src/auto-updater.ts` | 218 | Orchestrator: gates, plan, execute, verify, rollback |
| `src/update-snapshot.ts` | 117 | Capture/restore package.json + bun.lock |
| `src/update-executor.ts` | 112 | Injectable subprocess runner (bun add, playwright install, bun install) |
| `src/stealth-verifier.ts` | 178 | Smoke test launcher (Tier 1-2 ONLY, never hostile platforms) |
| `src/stealth-verifier-playwright.ts` | 110 | Production VerifierBrowser using real Playwright |
| `src/stealth-reinforcement.ts` | 152 | Background loop with escalation ladder |

Modified files:
- `package.json` -- added `cloakbrowser: "0.3.21"` (was unlisted)
- `update-checker.ts` -- added `cloakbrowser` to NPM_DEPS, exported `checkRebrowserCompatibility(targetPwVersion)`
- `config.ts` -- added `readConfigValue(key)` for YAML config
- `browser-manager.ts` -- safety wiring (see P1)
- `browser-handoff.ts` -- safety wiring (see P1)
- `server.ts` -- replaced fire-and-forget `checkForUpdates()` with `maybeAutoUpdate()` + `startReinforcementLoop()`

**Update safety chain (do not violate):**
1. CloakBrowser: always safe to update (independent Chromium + own C++ patches)
2. Playwright: only when `checkRebrowserCompatibility()` returns compatible. Otherwise warn-and-skip.
3. rebrowser-patches: NEVER auto-updated (hand-adapted), only warn

**Verification scope (strict):** Tier 1-2 ONLY -- bot.sannysoft.com, bot-detector.rebrowser.net. The verifier itself obeys the hostile-domain blocklist and will never hit Tier 4-5 sites.

**Rollback:** snapshot package.json + bun.lock before update; on verification failure, restore files + `bun install` + re-apply CDP patches. Failed snapshots preserved as `update-snapshot-failed-{timestamp}.json` for forensics.

**Activation:** auto-update is opt-in. Set `auto_upgrade: true` in `~/.nightcrawl/state/config.yaml`. Otherwise the server still does detect-only logging on startup as before.

**Tests:** 11 + 6 + 10 + 14 = 41 unit tests across the four orchestration files, all green.

### P3: Autonomous Reinforcement Loop

`stealth-reinforcement.ts` -- background loop while server runs:
- First check: 1h after startup
- Subsequent checks: every 6h
- Calls the same `verifyStealth()` used by the auto-updater

Escalation ladder on consecutive failures:
1. First fail: re-apply `applyStealthPatches()` as self-heal, re-verify
2. Second fail: same + log elevated warning
3. Third fail: write `~/.nightcrawl/stealth-alert.json`. Server does NOT auto-shutdown (would break user session); CLI surfaces the status.

Any successful verification resets the counter and clears the alert file.

Disabled in tests/CI via `BROWSE_REINFORCEMENT=0`.

**Tests:** 6 unit tests, all green.

---

## Test Suite

**240 tests pass, 0 failures** across all relevant test files (P1+P2+P3 + existing). Run with:

```bash
cd stealth/browser
BROWSE_REINFORCEMENT=0 BROWSE_UPDATE_CHECK=0 bun test \
  test/hostile-domains.test.ts test/browser-manager-hostile.test.ts \
  test/update-snapshot.test.ts test/update-executor.test.ts \
  test/stealth-verifier.test.ts test/auto-updater.test.ts \
  test/stealth-reinforcement.test.ts test/update-checker.test.ts \
  test/cloakbrowser-integration.test.ts test/stealth-cdp.test.ts \
  test/stealth-extensions.test.ts test/cdp-patches-v2.test.ts \
  test/nightcrawl-update-check.test.ts test/nightcrawl-config.test.ts \
  --timeout 60000
```

**Pre-existing flake:** `test/handoff.test.ts > handoff edge cases > resume without prior handoff works via meta command` was already failing on `main` before this session's changes. Verified by stashing, running on main, getting the same failure, then restoring. Not a regression. Worth investigating but unrelated to P1/P2/P3.

---

## ACCOUNT SAFETY -- the rule that's now in code, not just markdown

The hostile-domain blocklist in `stealth/browser/src/hostile-domains.ts` is HARDCODED. It is NOT config-driven. It is NOT a YAML key. Editing it requires a code change + commit + review.

**DO NOT propose making it configurable.** The whole point is that config can be edited in a moment of weakness; code requires deliberate review.

**Tier 5 testing (Xiaohongshu) is DELETED from the roadmap, not deferred.** Do not re-add it. The verifier covers Tier 1-2 only, which is sufficient for nightCrawl's actual use case (read-only research + non-hostile automation).

See `project_xhs_account_ban_2026_04_09` memory for the full incident report.

---

## What Needs Doing Next

### Priority 1: Verify auto-updater end-to-end with real subprocess

The auto-updater is fully unit-tested but has not been exercised against real `bun add` / `bunx playwright install`. Steps:
1. Create `~/.nightcrawl/state/config.yaml` with `auto_upgrade: true`
2. Manually downgrade a non-Playwright dep in `package.json` (e.g. `cloakbrowser: 0.3.20`)
3. Restart the server
4. Watch logs: should see detection -> plan -> snapshot -> install -> verify -> success
5. Confirm `cloakbrowser` is back at 0.3.21 (or whatever latest is)
6. Repeat with intentionally-broken state to verify rollback fires

### Priority 2: Verify reinforcement loop fires

1. Set a short interval temporarily: in `server.ts`, change `intervalMs: 6 * 60 * 60 * 1000` to `60 * 1000` and `initialDelayMs: 60 * 60 * 1000` to `5 * 1000`
2. Restart server, wait ~1 min, watch logs for `[reinforcement]` activity
3. Revert the interval change before committing

### Priority 3: Pre-existing handoff test flake

`handoff edge cases > resume without prior handoff works via meta command` times out. Was failing on `main` before this session. Worth a TDD-style root-cause investigation: what caused the regression, when, and what was the original intent.

### Priority 4: CloakBrowser package update

`cloakbrowser@0.3.22` is available and the auto-updater will now pick it up automatically once `auto_upgrade: true` is set. Or update manually: `cd stealth/browser && bun add cloakbrowser@latest`.

---

## File Map (Session 5 Changes)

```
NEW:  stealth/browser/src/hostile-domains.ts                  -- 121 lines, hardcoded blocklist
NEW:  stealth/browser/src/auto-updater.ts                     -- 218 lines, orchestrator
NEW:  stealth/browser/src/update-snapshot.ts                  -- 117 lines, snapshot/restore
NEW:  stealth/browser/src/update-executor.ts                  -- 112 lines, bun subprocess wrapper
NEW:  stealth/browser/src/stealth-verifier.ts                 -- 178 lines, smoke test
NEW:  stealth/browser/src/stealth-verifier-playwright.ts      -- 110 lines, real-browser impl
NEW:  stealth/browser/src/stealth-reinforcement.ts            -- 152 lines, background loop

NEW:  stealth/browser/test/hostile-domains.test.ts            -- 26 unit tests
NEW:  stealth/browser/test/browser-manager-hostile.test.ts    -- 6 integration tests
NEW:  stealth/browser/test/update-snapshot.test.ts            -- 11 unit tests
NEW:  stealth/browser/test/update-executor.test.ts            -- 6 unit tests
NEW:  stealth/browser/test/stealth-verifier.test.ts           -- 10 unit tests
NEW:  stealth/browser/test/auto-updater.test.ts               -- 14 unit tests
NEW:  stealth/browser/test/stealth-reinforcement.test.ts      -- 6 unit tests

MOD:  stealth/browser/package.json                            -- declared cloakbrowser dep
MOD:  stealth/browser/src/update-checker.ts                   -- cloakbrowser + checkRebrowserCompatibility
MOD:  stealth/browser/src/config.ts                           -- readConfigValue
MOD:  stealth/browser/src/browser-manager.ts                  -- hostile-domain wiring
MOD:  stealth/browser/src/browser-handoff.ts                  -- hostile-domain wiring on handoff/autoHandover
MOD:  stealth/browser/src/server.ts                           -- maybeAutoUpdate + startReinforcementLoop wiring
```

## Memory Updated

- NEW: `project_xhs_account_ban_2026_04_09.md` -- incident record + architectural lesson
- INDEX: added to `MEMORY.md`

---

*Created by Claude Code -- 2026-04-09 (session 5, mid-conversation pivot from auto-updater feature to safety incident response)*
