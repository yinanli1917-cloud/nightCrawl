# HANDOFF — 2026-04-24 (session 2)

## Current state

Branch `main`, all work pushed to `origin/main`. Four commits on top of
the prior `ab62019` checkpoint:

1. `13dab82` — `feat(sync): nc sync status / nc sync now`
2. `36fff25` — `feat(health): plain-English daemon snapshot; deep verifier moved to 'health stealth'`
3. `91c7360` — `refactor(engine): collapse PW engine path; CloakBrowser is the only engine`
4. `bb9e398` — `refactor(verifier): switch auto-update + reinforcement to CloakBrowser verifier; delete PW verifier`

## Status

### ✅ Sync telemetry (`nc sync status`, `nc sync now`)
- New `sync-state.ts` exposes in-memory telemetry (run/success/error/skipped
  counts, last timestamps, last error, intervalMs, last imported domains).
- `runBackgroundSync` updates telemetry on every cycle.
- `meta-commands.ts` adds the `sync` case with `status` (read) and `now`
  (trigger immediately) sub-commands.
- 11 new unit tests in `test/sync-state.test.ts`.
- Live-verified: `sync now` returned `Imported 0 cookies, 0 new domain(s)
  from arc` (correct — Arc state already synced from prior background runs);
  `sync status` reflected `Runs: 1 (success: 1...)`.

### ✅ Plain-English `browse health`
- `health-snapshot.ts` is a pure formatter for an aggregated daemon view:
  engine + seed, mode, PID, uptime, current URL/tabs/cookie count, sync
  cycle/last run/last success/error, granted + pinned domain lists.
- `meta-commands.ts` `health` handler aggregates state and calls the
  formatter. The deep stealth verifier moved to `health stealth`.
- 9 new unit tests in `test/health-snapshot.test.ts` (formatter shape,
  STALE/DEGRADED thresholds, large-list elision, fresh-daemon case).
- Live-verified: `health` showed real values (5 granted domains, 2 pinned,
  2943 cookies). `health stealth` still passes — HEALTHY in 11.9s.

### ✅ PW engine path collapsed (Stages 1-4)
Recorded decision (`project_cloakbrowser_default_decision.md`,
2026-04-14) honored: stock Playwright launch path is gone.

- `cloakbrowser-engine.ts`: `launchPlaywrightFallback` deleted. Failure
  now throws with install instructions (no silent fallback to the unsafe
  Chrome-for-Testing path).
- `browser-manager.ts`: `launch()` collapsed to CloakBrowser only
  (~50 lines removed). Dead imports of `applyStealthPatches`,
  `shouldSkipCdpPatches`, `findChromiumExecutable` removed.
- `engine-config.ts`: `BrowserEngine` is now the literal `'cloakbrowser'`.
  `BROWSE_ENGINE` env var no longer parsed. `VALID_ENGINES` set deleted.
- `browser-handoff.ts`: `launchHeaded` / `handoff` / `resume` collapsed
  to CloakBrowser only (3 if/else pairs removed).
- `meta-commands.ts`: `health stealth` no longer branches on engine.
- `server.ts`: auto-updater verifier and 6h reinforcement loop verifier
  both switched from `createPlaywrightVerifierBrowser` →
  `createCloakVerifierBrowser`. Per the project memory: "All verification
  signals have been meaningless" — they were testing the wrong browser.
- `stealth-verifier-playwright.ts` deleted.
- `CLAUDE.md` updated: stealth feature #9 reflects single engine, "Engine
  Configuration" section drops `BROWSE_ENGINE`.

Net across the 4 commits: ~+550 / −330 lines. 130 of 132 tests pass; the
2 failures in `cloakbrowser-integration.test.ts` are pre-existing on main
(parseEngineConfig assumes `fingerprintSeed` is `undefined` when no env
var is set, but the persistent-seed feature always returns a number).

## Watch-outs / known-pending

- **`applyStealthPatches` and `stealth/patches/cdp/` are NOT removed yet.**
  CloakBrowser depends on `playwright-core` for its API surface, so the
  JS-layer CDP patches against `playwright-core/lib/server/chromium/*.js`
  may still be helpful (or at least neutral) under CloakBrowser. Removing
  them would also delete `cdp-patches-v2.test.ts` and `stealth-cdp.test.ts`.
  Investigation deferred — needs an A/B verifier run on
  bot-detector.rebrowser.net with patches on vs off.
- **Catch-block PW emergency fallback in `resume()` kept as-is.** Only
  fires when CloakBrowser launch already failed; gives the user a usable
  blank context instead of a dead daemon. Per the "fail loud" policy this
  could also throw, but the UX cost (dead daemon, no recovery path) seemed
  worse than the stealth cost (blank context with no real session).
- **2 pre-existing test failures in `cloakbrowser-integration.test.ts`.**
  `parseEngineConfig defaults to cloakbrowser` and `parseEngineConfig
  ignores non-numeric seed` both expect `fingerprintSeed === undefined`,
  but the persistent-seed feature (`engine-seed.json`) always returns a
  number. Either update the tests to clear `engine-seed.json` between
  runs, or change the contract.
- **Background sync first real-world cycle may trigger Keychain dialog**
  if the user hasn't clicked "Always Allow" yet. Still expected behavior.

## Still pending (need user / further scoping)

1. **Live-verify doubao re-auth** — destructive: wipes a working doubao
   session, requires user at the keyboard for Duo/OTP. Best done when
   the user is willing to spend a re-login. Expected: `nc goto doubao.com`
   → notification fires → CloakBrowser window pops → user logs in →
   window closes → headless goto works.
2. **Live-verify the 10-min background sync loop** — needs a fresh Arc
   login on a site not yet in the nightCrawl jar (e.g. throwaway HN
   account). Wait ≥10 min, then `nc goto news.ycombinator.com`. Expect
   logged in, no wall, no import trigger. Now diagnosable with
   `nc sync status` (shows runs/success/error counts).
3. **`default-browser-medium handoff`** — listed as P4 in the prior
   handoff, but the term doesn't appear in the code or docs. Needs the
   user to scope it: is "medium" a tier between notify-only and
   full-headed-handoff? A surface change (system browser vs
   CloakBrowser)? Surface this question before implementing.

## Next-step options (in priority order)

1. **Fix the 2 pre-existing `parseEngineConfig` test failures** by
   isolating the persistent seed file in test setup — small, mechanical,
   gets the test suite green.
2. **Investigate the CDP patches under CloakBrowser** — A/B verifier run
   to decide whether `stealth/patches/cdp/` and `applyStealthPatches`
   stay or go. Would close the last mile of the engine-collapse refactor
   and let `cdp-patches-v2.test.ts` / `stealth-cdp.test.ts` either be
   deleted or reframed.
3. **Live-verify doubao + 10-min sync** when the user can spare the
   re-logins / wait time.
4. **Scope default-browser-medium handoff** with the user before
   implementing.

## Relevant files (this session)

- [stealth/browser/src/sync-state.ts](stealth/browser/src/sync-state.ts) — telemetry singleton + `formatSyncStatus`
- [stealth/browser/src/health-snapshot.ts](stealth/browser/src/health-snapshot.ts) — pure formatter for `nc health`
- [stealth/browser/src/meta-commands.ts](stealth/browser/src/meta-commands.ts) — `sync` and `health` handlers
- [stealth/browser/src/server.ts](stealth/browser/src/server.ts) — telemetry hooks in `runBackgroundSync`, verifier switch in auto-update + reinforcement
- [stealth/browser/src/cloakbrowser-engine.ts](stealth/browser/src/cloakbrowser-engine.ts) — fail-loud (no PW fallback)
- [stealth/browser/src/browser-manager.ts](stealth/browser/src/browser-manager.ts) — single launch path
- [stealth/browser/src/browser-handoff.ts](stealth/browser/src/browser-handoff.ts) — single handoff/resume path
- [stealth/browser/src/engine-config.ts](stealth/browser/src/engine-config.ts) — single-engine config
- [CLAUDE.md](CLAUDE.md) — single-engine docs

---
*Created by Claude Opus 4.7 (1M ctx) — 2026-04-24 (session 2). Continued
from prior handoff dated same day; previous session shipped commit
`b180255` (background sync + auto-pop) and the doubao + 10-min verifies
remained pending. This session added telemetry, the plain-English
diagnostic, and finished the engine collapse — leaving the doubao verify
still pending the user, and the CDP-patches-under-CloakBrowser question
as the obvious next investigation.*
