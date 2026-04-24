# HANDOFF — 2026-04-24

## Current task
Two-tier cookie strategy for nightCrawl's generalized login flow. Continuous
background Arc→nightCrawl sync for the 95% of normal sites, and headed
CloakBrowser auto-pop for fingerprint-pinned domains (doubao, CF Turnstile,
DataDome). Plan: `~/.claude/plans/playful-mixing-quail.md`.

## Status

### ✅ Landed (commit `b180255`, pushed to `origin/main`)

- **Background sync** — `syncAllCookies()` in `handoff-cookie-import.ts` +
  `runBackgroundSync()` in `server.ts` (10-min cycle, hostile-domain filtered,
  batch of 200, skips incognito/headed, silent on error).
- **Pinned-domain auto-pop** — `browser-handoff.ts` drops the
  `BROWSE_AUTO_POP_HEADED` gate for pinned domains (no alternative path exists),
  fires a single proactive notification before launch with an
  "Open in browser" fallback action, cleans up the twice-fired
  pre-launch-stub notification pattern from before.
- **Message cleanup** — STEP 1 and STEP 2 response strings in `server.ts`
  removed the stale "run `nc open-handoff`" instruction; pinned branches now
  say "Arc cookies imported but wall persisted — auto-opening CloakBrowser."
- **Pure helper + unit tests** — extracted `computeNewDomainsToSync()` and
  `isHostileDomain()` as exported pure functions; added 9 unit tests covering
  eTLD+1 diff, subdomain dedupe, hostile filter, co.uk/edu.cn suffixes.
- **Live verification — Canvas control** — `nc goto canvas.uw.edu` → Dashboard
  loaded (COMMLD 512/515/525, to-dos, recent feedback). No wall, no window,
  no regression from the diff. Pre-existing autonomous auto-import path
  still works.

### Tests
- `handoff-cookie-import.test.ts`: 51 pass (was 42).
- Full handoff suite (`handoff-consent`, `login-wall-detection`,
  `handoff-poll`, `handoff-cookie-import`): 81 pass, 0 fail.

### ⏳ Still needs live verification (deferred — destructive in this session)

- **doubao re-auth**: clear doubao cookies → restart daemon → `nc goto doubao.com`
  → expect CloakBrowser auto-pops without `BROWSE_AUTO_POP_HEADED=1`. Will cost
  the user one re-login on doubao.com to re-verify. I did not run this because
  it wipes a working session and would need user attention to complete Duo/OTP.
- **10-min background sync**: log into a site not currently in the nightCrawl
  jar (e.g., create a fresh Hacker News account in Arc) → wait ≥10 min →
  `nc goto news.ycombinator.com` → expect logged in, no wall, no import trigger.

## Key decisions this session

1. **Auto-pop without env gate for pinned domains** — Previously guarded by
   `BROWSE_AUTO_POP_HEADED=1`. Decision: for pinned domains the env gate was
   friction without safety value — Arc cookies are structurally useless, so
   there's literally no quieter alternative to a window. Non-pinned domains
   still respect the gate.
2. **Accepted the one-time Keychain prompt** — the background sync calls
   `importCookies()` every 10 min, which on first run triggers the macOS
   Keychain dialog. The user has been burned by unexpected Keychain prompts
   before (see `feedback_no_windows.md`), but the plan explicitly accepts
   this as the tradeoff — "Always Allow" silences it forever after. If
   future-me is reviewing this: the right time to revisit is if the dialog
   re-fires after OS/browser updates.
3. **Replaced the whole HANDOFF.md rather than appending** — the previous
   file had 3 stacked 2026-04-14 sessions which are now in git history
   (search commits around that date). Clean slate reads better.

## Known concerns / watch-outs

- **Background sync is unverified in production** — ships with unit tests
  only. First real-world cycle will trigger the Keychain dialog if the user
  hasn't clicked "Always Allow" yet; that's expected but heads-up.
- **No telemetry on sync success** — `runBackgroundSync` swallows errors
  silently to avoid crashing the daemon. If syncs are failing, the only
  signal will be "new Arc logins don't appear in nightCrawl after 10 min."
  Consider adding a `nc sync status` command if this turns out to be the
  case in practice.
- **The old HANDOFF.md dated 2026-04-14 was deleted** — its content is
  reachable via `git log -- HANDOFF.md` if needed.

## Next-step options (in priority order)

1. **Live-verify doubao re-auth** when you're ready to spend a re-login.
   Expected: `nc goto doubao.com` → notification fires → CloakBrowser window
   pops → complete login → window closes → headless goto works.
2. **Live-verify the 10-min background sync loop.** Easiest test site is
   something where the user can create a throwaway account in Arc and watch
   it propagate into nightCrawl within the cycle.
3. **Add a `nc sync status` / `nc sync now` CLI command** — exposes the
   last sync timestamp, last `importedCount`, last error. Would let the
   user diagnose silent sync failures without reading logs.
4. **P4 items from prior handoff** still apply: re-port CDP patches for
   PW 1.59.1 (or kill PW path entirely now that CloakBrowser is default),
   default-browser-medium handoff, `browse health` plain-English command.

## Relevant files

- [stealth/browser/src/handoff-cookie-import.ts](stealth/browser/src/handoff-cookie-import.ts) — `syncAllCookies`, `computeNewDomainsToSync`, `isHostileDomain` (exported)
- [stealth/browser/src/server.ts](stealth/browser/src/server.ts) — `runBackgroundSync`, `backgroundSyncInterval`, pinned STEP 1/2 messages
- [stealth/browser/src/browser-handoff.ts](stealth/browser/src/browser-handoff.ts) — pinned-domain auto-pop, proactive notification
- [stealth/browser/test/handoff-cookie-import.test.ts](stealth/browser/test/handoff-cookie-import.test.ts) — 9 new tests, 51 total
- [~/.claude/plans/playful-mixing-quail.md](~/.claude/plans/playful-mixing-quail.md) — the plan this session executed

---
*Created by Claude Opus 4.7 (1M ctx) — 2026-04-24. Previous session
(`cfee4c10` / `playful-mixing-quail`) terminated by repeated API 400 errors
on "invalid thinking-block signature"; this session resumed from plan +
uncommitted diff and executed the pending commit/push/handoff sequence.*
