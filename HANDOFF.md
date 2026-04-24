# HANDOFF — 2026-04-24 (session 3)

## Current state

Branch `main`, all work pushed. Seven commits on top of `ab62019`:

1. `13dab82` — `feat(sync): nc sync status / nc sync now`
2. `36fff25` — `feat(health): plain-English daemon snapshot; deep verifier moved to 'health stealth'`
3. `91c7360` — `refactor(engine): collapse PW engine path; CloakBrowser is the only engine`
4. `bb9e398` — `refactor(verifier): switch auto-update + reinforcement to CloakBrowser verifier`
5. `851a8e2` — `docs: handoff session 2 wrap`
6. `b28c5cf` — **`feat(sync): real-time fs.watch on default-browser cookie DB (sub-3s sync)`**
7. `cad9f3f` — `feat(notify): add 'nc notify-test' diagnostic command`

## What this session shipped

### ✅ Real-time cookie sync (the headline)
The 10-min poll is now a *fallback*, not the primary path. `cookie-watch.ts`
attaches `fs.watch` to the user's default-browser cookie SQLite directory.
On any write to `Cookies` / `Cookies-journal` / `Cookies-wal`, debounces
2 seconds (SQLite write bursts) and triggers `runBackgroundSync('watch')`.

**Verified live**: `touch ~/Library/Application\ Support/Arc/User\ Data/Default/Cookies`
→ within 3 seconds, `nc sync status` showed `Triggers: watch 1`,
`Last run: 2s ago (watch)`, `imported 0 cookies, 0 new domain(s) from arc`.

User-facing impact: log into a site in Arc → nightCrawl knows ~3 seconds
later. Was: 0–10 minutes.

### ✅ `nc notify-test` diagnostic command
Fires both passive (osascript) and actionable (terminal-notifier)
notifications with a timestamp, plus prints a System Settings checklist
for diagnosing "I never see notifications." Code path tests clean — if
the user runs it and sees nothing, it's a downstream macOS permissions
issue (System Settings → Notifications → osascript / terminal-notifier).

### ✅ Notification + sync design doc
`docs/notification-and-sync-design.md` captures the full design + the
inventory of every notification / handoff / real-time-sync requirement
the user has expressed across the project memory and Apple Notes.

### ✅ Sync telemetry now distinguishes triggers
`nc sync status` shows per-trigger counters (`Triggers: watch X, poll Y,
manual Z`) and labels each run with its origin (e.g.
`Last run: 2s ago (watch)`). Lets the user diagnose whether real-time
or poll is doing the work.

## Status

| Item | Status |
|---|---|
| `nc sync status` / `sync now` (telemetry) | ✅ shipped (`13dab82`) |
| `nc health` plain-English snapshot | ✅ shipped (`36fff25`) |
| PW engine path collapse | ✅ shipped (`91c7360`, `bb9e398`) |
| **Real-time cookie sync (fs.watch)** | ✅ shipped (`b28c5cf`) |
| **`nc notify-test`** | ✅ shipped (`cad9f3f`) |
| Notification design doc | ✅ shipped (`docs/notification-and-sync-design.md`) |
| Notifications actually visible to user | ❓ pending user check of `nc notify-test` |
| doubao.com end-to-end live verify | ⏳ pending (destructive — needs user re-login) |
| `default-browser-medium handoff` | ⏳ deferred — term doesn't exist in code, needs user scoping |
| CDP-patches-under-CloakBrowser investigation | ⏳ deferred (A/B verifier run needed) |

## What I corrected mid-session

The user pushed back on two earlier overclaims:

1. **"We built the auto-pop feature."** Not true. Auto-handoff goes back to
   `92468d8` and earlier. Commit `b180255` (prior session, not me) added
   *background polling* and *removed the env-var gate* for pinned domains.
   The auto-handoff machinery itself is the user's, not mine.
2. **"Verified" without driving real sites.** I had only verified that
   `sync now` returned a no-op success and that the daemon launched. Real
   end-to-end on doubao.com remains unverified. This session's watcher
   verification used `touch` on the Arc cookie file — proves the wiring
   works, doesn't prove a real Arc login propagates (because I'd need
   to log into a fresh site as the user to do that).

## What's still pending

1. **You see the test notifications?** Run `nc notify-test` (already ran
   during this session). If you see neither: System Settings → Notifications
   → search for `osascript` and `terminal-notifier`, set both to "Allow
   Notifications." If you see them: notifications work; any "not working"
   reports are about specific handoff scenarios that may need their own
   investigation.

2. **End-to-end real-Arc-login verify.** Open Arc, log into a site you've
   never touched in nightCrawl (a throwaway Hacker News account is the
   easiest), then run `nc sync status`. Expected: within ~10 seconds of
   your Arc login, `lastNewDomains` shows the new domain and `Triggers:
   watch +1`.

3. **Doubao end-to-end.** Wipe doubao cookies from the jar, restart daemon,
   `nc goto doubao.com` → expect notification → expect CloakBrowser auto-pop
   → log in → expect headless resume to work. Costs you one re-login.

4. **`default-browser-medium handoff`** — needs scoping. Best guess: a tier
   that opens your actual default browser (Arc) for the login instead of
   spawning a headed CloakBrowser. Aligns with the consent-flow intent
   ("Preferred handoff medium: user's default browser") in
   `feedback_proactive_handoff_ux.md`.

## Watch-outs

- **Watcher only watches the *default* browser.** If you switch your default
  browser while the daemon is running, the watcher stays on the old one until
  daemon restart. `nc sync status` will show the old path under `Watcher:`.
- **Watcher swallows the FSEvents-on-macOS startup echo** (30ms warm-up).
  A real Arc cookie write within the first 30ms after daemon launch would
  be missed — vanishingly unlikely in practice.
- **Watcher doesn't sync deletions.** If you log OUT of a site in Arc, the
  cookies linger in nightCrawl's jar until they expire naturally. Fix would
  require diff instead of additive import.

## Relevant files

- [stealth/browser/src/cookie-watch.ts](stealth/browser/src/cookie-watch.ts) — fs.watch wrapper, 2s debounce
- [stealth/browser/src/sync-state.ts](stealth/browser/src/sync-state.ts) — telemetry with `triggeredBy: 'poll'|'watch'|'manual'`
- [stealth/browser/src/server.ts](stealth/browser/src/server.ts) — watcher startup at lines 663–688
- [stealth/browser/src/cookie-import-browser.ts](stealth/browser/src/cookie-import-browser.ts) — `cookieDbPath()` resolver added
- [stealth/browser/src/meta-commands.ts](stealth/browser/src/meta-commands.ts) — `notify-test` handler
- [docs/notification-and-sync-design.md](docs/notification-and-sync-design.md) — full design + requirements inventory

---
*Created by Claude Opus 4.7 (1M ctx) — 2026-04-24 (session 3). The user's
ask this session was "build the real-time watcher and investigate why
notifications aren't working." Watcher built and verified. Notifications:
all code-path tests pass; pending user confirmation on whether `nc notify-test`
actually surfaces in their Notification Center.*
