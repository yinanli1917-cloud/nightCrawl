# nightCrawl Bridge — Engine R (real-browser control)

Lets your local nightCrawl daemon drive **this real Chrome/Arc** in a background
tab — your real fingerprint, your live logged-in sessions — for the cases where
the headless engine can't pass (Google-class device-trust, hard fingerprint
pins). Opt-in, local-only.

## Architecture (the Kimi-proven model)

```
 nc goto … --engine=real
        │
   daemon  ── WebSocket server :10087 ──▶  extension service worker
   (hub: dispatch/await)   ◀── tool_result ──   │ chrome.debugger (CDP)
                                                ▼
                              an owned background tab in YOUR Chrome/Arc
```

The **extension dials OUT** to the daemon's localhost WebSocket and drives pages
via `chrome.debugger`. There is **no native-messaging host** — those die under
Chrome's bare spawn environment and can't keep an MV3 service worker alive. An
outbound WebSocket + `chrome.alarms` keepalive makes the inevitable
service-worker reconnect harmless (this is exactly how Kimi WebBridge,
Playwright-MCP `--extension`, and BrowserMCP do it).

Security: the WS server binds `127.0.0.1` only and accepts the upgrade only from
our pinned extension's `chrome-extension://…` Origin (a hostile web page's WS
carries a page Origin and is rejected). The daemon is the only listener; nothing
is reachable off-host.

## Setup (one time)

There is **nothing to install** — the WS server starts with the daemon, and the
extension's ID is pinned by the manifest `key`. Just load the extension:

1. Chrome/Arc → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder (`stealth/extensions/nightcrawl-bridge`).
3. Confirm the ID is `obapdlogondaffdidmnndlcbefockbjc` (the manifest `key` pins it;
   the daemon's Origin allowlist expects exactly this id).

The extension auto-connects whenever a nightcrawl daemon is running (it retries on
a calm 3s backoff + a 30s `chrome.alarms` keepalive, surviving SW eviction).

## Verify (live E2E)

```bash
nc goto https://example.com            # boots the daemon (headless, default)
nc goto https://example.com --engine=real
```

`--engine=real` opens a background tab in your real browser and returns
`[real-browser] navigated to …`. If the extension isn't connected yet, the
command falls back to headless and says so.

## Safety

- **Hostile domains stay blocked on both engines** (XHS et al.) — the real
  browser removes fingerprint-ban risk but NOT behavioral/policy-ban risk.
- The bridge drives an **owned background tab**, never your active tab.
- Command surface only: navigate/read/snapshot/screenshot/click/fill. File upload
  and bulk crawl stay on the headless engine.

## Uninstall

Remove the extension from `chrome://extensions`. (No host manifests to clean up —
there are none.)
