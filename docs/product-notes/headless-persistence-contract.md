# Headless persistence UX contract

> Product rule for nightCrawl agent-facing browser automation.

## UX definition

- **Seamless headless** — agents use `nc goto`, `snapshot`, `extract` in background CloakBrowser only.
- **Zero effort** — no nightCrawl-headed window in the default path; user logs in Arc/Chrome if needed.
- **Persistence is the UX** — once identity exists for a domain, it survives daemon restarts and the next headless visit.

## Identity flow

1. User authenticates in Arc/Chrome (their normal browser).
2. nightCrawl imports via `sync now`, cookie watch, and startup `syncAllCookies(..., 'all-domains')`.
3. Cookies land in `~/.nightcrawl/chromium-profile` and `~/.nightcrawl/browse-cookies.json`.

## On login wall (default)

1. Read persisted profile cookies.
2. Merge JSON backup if profile is thin.
3. `syncAllCookies` from default browser.
4. Retry navigation headless.
5. Return `LOGIN_REQUIRED` / `CONSENT_REQUIRED` to the agent — **no headed recovery** unless `BROWSE_AUTO_HANDOVER=1`.

## Headed / handover

- Opt-in only: `export BROWSE_AUTO_HANDOVER=1`
- Without it, approved domains still get silent sync + retry; they do not pop CloakBrowser or auto-handover loops.

## Hostile platforms

- No live testing of 小红书 / Xiaohongshu in benchmarks.
- `assertSafeNavigation` blocks navigation at the URL gate.

## Release gates

- S4: daemon restart → headless re-goto → still authenticated
- S4b: Arc session → `sync now` → headless `goto` → authenticated
- `headed_windows === 0`, `relogin_required === false`
