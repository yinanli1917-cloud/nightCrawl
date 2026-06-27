# Multi-session coordination — TWO sessions editing this repo concurrently

Last updated by Session A on 2026-06-27. If you are starting a new session on this
repo, READ THIS FIRST, then edit only your side's files.

## Who owns what

### Session A — Learning loop + integration (in progress)
The self-tuning engine-routing loop and its Track B real-task fix cores, plus wiring
them into the daemon. Already pushed to `main`: metric-budget, engine-journal scoring,
site-profile, self-tune, resolveAction, refineBudget, banner-gate, tab-reaper,
latency-split, login-preview.

OWNS (will edit):
- `stealth/browser/src/metric-budget.ts`
- `stealth/browser/src/engine-journal.ts`
- `stealth/browser/src/site-profile.ts`
- `stealth/browser/src/self-tune.ts`
- `stealth/browser/src/engine-routing.ts`
- `stealth/browser/src/strategy-advisor.ts`
- `stealth/browser/src/banner-gate.ts`
- `stealth/browser/src/tab-reaper.ts`
- `stealth/browser/src/login-preview.ts`
- `stealth/browser/src/server.ts` — ONLY these functions: `recordEngineOutcome`,
  `appendEngineGuidance`, and the auto-resolution block that calls `resolveAutoEngine`
  (around the `handleCommand` dispatch). Plus a module-level `bannerSeen` Set + imports.
- their `test/*.test.ts`

### Session B — Generalized state + capability fixes (Pillars 1-3, the Cursor-course root cause)
The fixes for why the Texas court-class task failed: state continuity, async-js, recipes.

OWNS (will edit):
- `stealth/browser/src/session-id.ts` — Pillar 1 (stop `proc:<ppid>` fragmentation;
  untagged callers share one persistent workspace).
- `stealth/browser/src/browser-manager.ts` — Pillar 1 (`getPage` / `ensureActiveTab`
  re-bind the most-recent tab instead of "No active page").
- `stealth/browser/src/tab-store.ts` — Pillar 1.
- `stealth/browser/src/read-commands.ts` — Pillar 2 (robust async `js` await, replace
  the `hasAwait` token-sniff; sane eval timeout that returns the value).
- `stealth/browser/src/commands.ts` — Pillar 2 (`wait-for <js-predicate>` primitive).
- new capability/recipe modules — Pillar 3 (classify task/site-type, surface
  "use --engine=real + recipe").
- `stealth/browser/src/server.ts` — session-header parsing + session/tab dispatch
  functions ONLY (NOT Session A's three functions above).

## The one shared-danger file: `server.ts` (2479 lines)

Partitioned by function. Session A edits `recordEngineOutcome` / `appendEngineGuidance`
/ the auto-resolution block. Session B edits session/tab/js-dispatch areas. Before
editing `server.ts`: `git pull --rebase`, edit only your declared functions, commit
immediately. If you must touch the other side's function, leave a note here first.

## Protocol
- Commit small and often; push to `main`.
- `git pull --rebase` before each `server.ts` edit.
- TDD: failing test first; tests in `stealth/browser/test/<name>.test.ts`, isolate
  state via `BROWSE_STATE_FILE` set before import; run `bun test test/<file>`.
- No completion claims without fresh passing output.

## Sequencing / dependency (decided 2026-06-27)

**The loop's final step is ON HOLD until Pillar 1 lands.** Session A finished all
conflict-safe, unit-verifiable loop work (13 commits; ~115 tests). The ONLY remaining
loop step is:
1. `server.ts` `recordEngineOutcome`: add `profile: liveProfile(url)` (from
   `site-profile.ts`) + spread in `buildOutcomeMetrics(text, runtime)` (from
   `engine-journal.ts`) — the runtime = cpu/rss sample, tabDelta, windowPopped,
   bannerEmitted, latency marks.
2. `server.ts` `appendEngineGuidance`: gate the banner with `shouldEmitBanner`
   (`banner-gate.ts`); switch the auto-resolution block from `resolveAutoEngine` to
   `resolveAction` (`engine-routing.ts`).
3. Live end-to-end verification: window-free (`NIGHTCRAWL_BLOCK_HEADED=1`), ONE daemon,
   with the user's go-ahead.

**Why held:** verifying the loop on a daemon that fragments sessions by `proc:<ppid>`
(the bug Pillar 1 fixes) scatters the journal across phantom sessions and corrupts the
learning being verified. Honest end-to-end verification requires a post-Pillar-1 daemon.

**Session B: when Pillar 1 lands, note it here** (or ping) so the loop session resumes
the 3 steps above. Run ONE daemon only (bridge port 10087) — don't both start daemons.
