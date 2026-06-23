# Handoff Lifecycle

## Headed UI Is Best Effort

Headed takeover windows are part of the user's control surface. Once a headed
browser has opened, non-critical UI adornments must not be allowed to crash the
server or trigger emergency cleanup.

Avoid `BrowserContext.addInitScript()` for decorative headed-only UI such as the
nightcrawl control indicator. CloakBrowser and Playwright protocol versions can
disagree about newer return channels such as `Disposable`; a mismatch can throw
after the window has opened and make the browser appear to flash and collapse.

Preferred pattern:

- Use protocol-sensitive init scripts only for load-bearing stealth/auth logic.
- For headed-only visual indicators, inject into already-open pages with
  `page.evaluate()` and tolerate failure.
- If future headed UI needs all-new-page coverage, add a guarded compatibility
  layer and a focused regression check before using context-level init scripts.

## Preserve Volatile Context State

The persistent Chromium profile is necessary but not sufficient for handoff.
Cookies imported with `context.addCookies()`, `sessionStorage`, and SPA tab state
can still be in memory when the headless browser is closed. Handoff and resume
must capture `saveState()` before closing the current context and overlay that
state into the newly launched context with `restoreState()`.

This is load-bearing for checkout/cart flows and auth handoffs: relying only on
eventual SQLite flush can lose the exact session the user is trying to take over.

## Test Isolation

Handoff integration tests must not use the user's real
`~/.nightcrawl/chromium-profile`, and multiple `BrowserManager` instances must
not compete for one persistent profile. Use a temporary `BROWSE_PROFILE_DIR` per
integration case.

For tests or embedded demo-agent flows that need to observe disconnects without
killing the whole runner, set `NIGHTCRAWL_NO_EXIT_ON_DISCONNECT=1`. Production
daemon paths may still exit on unexpected browser death so the CLI can restart
from a clean state.
