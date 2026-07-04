# Session-scoped browsing: per-session tab isolation (both engines)

Full design spec: `~/.claude/plans/joyful-snacking-sphinx.md` (source of truth).

## Goal

One daemon, one shared (logged-in) browser context, but each **session** owns its
own tab(s) and per-tab state on **both** engines (headless + Engine R). Concurrent
sessions (two Claude Code windows, Codex, Cursor, OpenClaw) never touch each other's
tabs. Untagged callers keep today's behavior as a shared `"default"` session.

Keep one browser context (shared cookies) — isolate TABS per session only. Do NOT
use `browser.newContext()` per session.

## Acceptance Criteria

- [ ] Session identity resolves data-driven: `NIGHTCRAWL_SESSION_ID` >
      `CLAUDE_CODE_SESSION_ID` > `CODEX_*` > `CURSOR_*` > `proc:<ppid>` > `default`;
      wire format `X-Nightcrawl-Session` header for API agents. (stage 1 ✅)
- [ ] Per-tab state (refMap, activeFrame, lastSnapshot) moved global→per-tab. (stage 2 ✅)
- [ ] `SessionView`/`TabView` facade; handler param types `BrowserManager`→`TabView`,
      bodies unchanged. (stage 3)
- [ ] Per-session active tab; `getPage()` never falls back to another session's tab;
      lazy `goto`-create owned tab; scoped `closeTab`/`switchTab`/`tabs`; cross-session
      close needs Admin scope. (stage 4)
- [ ] `runOnTab` per-tab lock: same tab serializes, different tabs/sessions concurrent. (stage 5)
- [ ] handoff/restore/recreate route tab mutations through helpers; restored tabs
      owned by `default`. (stage 6)
- [ ] Engine R: `BridgeCommand` + `tool_call` carry `sessionId`; extension
      `bound` → `boundBySession` Map; per-session bound tab in Arc. (stage 7)
- [ ] `bun test` green (new + updated suites); live 2-session verification per engine.
- [ ] Back-compat: plain `nc goto` with no session env behaves exactly as today.

## Notes

Staged delivery: 7 stages, one commit + push to `main` each, TDD per stage, real
2-session verification where applicable. Stages 1–2 already committed and pushed
(03c26f6, dbed280).
