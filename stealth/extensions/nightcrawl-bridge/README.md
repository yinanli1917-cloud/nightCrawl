# nightCrawl Bridge — Engine R (real-browser control)

Lets your local nightCrawl daemon drive **this real Chrome** in a background tab —
your real fingerprint, your live logged-in sessions — for the cases where the
headless engine can't pass (Google-class device-trust, hard fingerprint pins).
It is **opt-in** and the daemon stays the only network listener; the host
connects *out* to it with the daemon's Bearer token (the security fix vs Kimi's
open, unauthenticated port).

## Architecture (why it's stable where Kimi wasn't)

```
 nc goto … --engine=real
        │
   daemon  ── SSE /bridge/stream ──▶  bridge-host (native-messaging, OS-managed)
        ◀── POST /bridge/result ───        │ stdio (4-byte LE framed JSON)
                                           ▼
                              extension service worker
                                           │ chrome.debugger (CDP)
                                           ▼
                              an owned background tab in YOUR Chrome
```

Kimi held its daemon connection inside the MV3 service worker (evicted ~30s → a
5-second reconnect thrash that broke multi-step tasks). Here the durable link
lives in the **host process**; the worker only executes CDP and reconnects
calmly on wake (a `chrome.alarms` keepalive limits eviction).

## One-time setup

```bash
bash scripts/install-bridge-host.sh
```

This pins the extension ID, installs the native-messaging host manifest
(Chrome/Brave/Arc/Edge), and prints the ID. Then:

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `stealth/extensions/nightcrawl-bridge`.
3. Confirm the ID matches the one the script printed (the manifest `key` pins it).

## Verify (the live E2E)

```bash
nc goto https://example.com            # boots the daemon (headless, default)
nc goto https://example.com --engine=real
```

`--engine=real` should open a background tab in your real Chrome and return
`[real-browser] navigated to …`. If the bridge isn't connected yet, the command
falls back to headless and the response says so — load the extension and retry.

## Safety

- **Hostile domains stay blocked on both engines** (XHS et al.) — the real
  browser removes fingerprint-ban risk but NOT behavioral/policy-ban risk.
- The bridge drives an **owned background tab**, never hijacks your active tab.
- It can only run the bridge command surface (navigate/read/snapshot/screenshot/
  click/fill). File upload and bulk crawl stay on the headless engine.

## Uninstall

Remove the extension from `chrome://extensions` and delete the
`com.nightcrawl.bridge.json` files the install script listed.
