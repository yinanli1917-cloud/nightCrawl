# Real-Browser Bridge

This spec captures durable guidance from the Kimi WebBridge reliability diagnosis
on 2026-05-20. It applies to any future mode where nightCrawl controls the
user's real Arc/Chrome/Edge profile through an extension, CDP, native messaging,
or another local bridge.

## Product Boundary

Real-browser bridge is an explicit opt-in mode for identity-heavy workflows,
not the default browser engine. Keep CloakBrowser/headless as the normal path
for batch work, stealth work, repeatability, and non-disruptive automation.

Support three distinct bridge modes:

- Active-tab mode: attach to the tab the user is already viewing.
- Owned-tab mode: create a clearly labeled nightCrawl tab or window.
- Visible session mirror: show browser, profile, tab owner, current URL, last
  command, last error, and recovery action.

Never surprise-open windows on unapproved domains. Preserve domain-scoped
consent and audit logs for bridge work.

## Session Ownership

Do not rely on a raw tab id as the only session handle. Store tab id plus URL,
title, window/group identity, opener/created-by metadata, and last task state.

Bridge implementations must:

- Detect stale tab ids before issuing page commands.
- Rebind after extension reconnect, daemon restart, browser restart, tab group
  movement, and user tab switching.
- Expose session state as `connected`, `attached`, `stale`, `recovering`, or
  `failed`.
- Prefer explicit recovery messages over opaque transport failures.

## Input Tiers

Keep action primitives separate in code, docs, and benchmarks:

- DOM click/fill for simple pages and semantic targets.
- CDP mouse/key input for sites requiring browser-level events.
- OS-level handoff only for WebAuthn, 2FA, CAPTCHA, or genuinely trusted user
  input.

Do not evaluate a bridge by only one click path. A DOM-level click failure does
not prove CDP input failure.

## Extension Conflict Diagnostic

Before bridge benchmarks or live debugging, run a local health probe that:

- Enumerates installed extensions and relevant permissions.
- Flags risky classes: `debugger`, `<all_urls>`, `webRequestBlocking`,
  `nativeMessaging`, `scripting`, screen recording, AI assistant, scraper, and
  broad helper extensions.
- Exercises connect, navigate a local static page, evaluate, snapshot, and CDP
  mouse click.
- Produces plain-language repair guidance, including clean-test-profile and
  real-user-profile options.

## Local Endpoint Security

Bridge endpoints must stay local and authenticated. HTTP and WebSocket command
surfaces need auth tokens and origin checks, not just "localhost" binding.

Telemetry remains local by default. Any future analytics must be opt-in and
content-free.

## Benchmark Contract

A bridge benchmark suite must cover:

- Cold start and warm action latency.
- Navigate success and load-state handling.
- Session retention after tab group creation, reconnect, daemon restart,
  browser restart, and user tab switching.
- DOM click versus CDP mouse click.
- Fill versus CDP key input.
- Snapshot completeness and accessibility-tree stability.
- Cross-origin iframe handling.
- File upload.
- Authenticated workflows such as Google Docs/Sheets, Canvas/UW Library, and
  other identity-bound sites.
- Recovery after extension conflict, daemon restart, browser restart, and stale
  tab id.
- UX quality: transparency, consent, error clarity, handoff smoothness, and
  whether the user can see and control what is happening.
