# stealth/

nightCrawl's anti-bot stealth layer. Everything here is **the actual working code** — not documentation, not research.

## Directory Layout

```
stealth/
├── browser/                          # Complete working browser engine
│   ├── src/                          # Full TypeScript source (21 files)
│   │   ├── browser-manager.ts        # Browser lifecycle, UA fix, extension loader, stealth flags
│   │   ├── server.ts                 # HTTP daemon, cookie persistence, session management
│   │   ├── commands.ts               # Core commands: goto, click, type, screenshot, js, fetch
│   │   ├── read-commands.ts          # Observation: snapshot, inspect, style, network logs
│   │   ├── write-commands.ts         # Mutation: fill, select, upload, dialog handling
│   │   ├── meta-commands.ts          # Meta: chain, wait, connect, handoff to headed mode
│   │   ├── cookie-import-browser.ts  # Import cookies from Arc/Chrome browsers
│   │   ├── snapshot.ts               # Accessibility tree snapshot engine
│   │   ├── cli.ts                    # CLI entry point + REPL
│   │   └── ...                       # Activity, buffers, config, platform, sidebar, URL validation
│   ├── test/                         # Test suite (25 test files + fixtures)
│   ├── bin/                          # Shell scripts (find-browse, remote-slug)
│   ├── scripts/                      # Build scripts
│   └── dist/                         # Build artifacts (binaries gitignored, small files kept)
├── patches/
│   └── cdp/                          # CDP Runtime.Enable bypass (6 files, applied to Playwright cache)
│       ├── chromium/
│       │   ├── crConnection.js       # __re__ methods: emitExecutionContext, getMainWorld, getIsolatedWorld
│       │   ├── crPage.js             # Conditional Runtime.enable skip
│       │   ├── crServiceWorker.js    # Service worker context skip
│       │   └── crDevTools.js         # DevTools context skip
│       ├── frames.js                 # Calls __re__emitExecutionContext instead of Runtime.enable
│       └── page.js                   # Worker execution context via patched method
└── extensions/
    ├── nightcrawl-extension/         # Chrome extension (snapshot, sidepanel, etc.)
    └── bypass-paywalls-chrome/       # Paywall bypass (The Atlantic, Medium, etc.)
```

## The Browser Engine (browser/)

A stateful, headless browser daemon that:
- Launches Chromium with stealth flags (UA, viewport, AutomationControlled disabled)
- Applies CDP Runtime.Enable bypass patches at startup
- Persists cookies across sessions (save every 5 min + on shutdown, restore on startup)
- Imports cookies from Arc/Chrome for sites requiring real browser auth
- Loads Chrome extensions (bypass-paywalls, nightCrawl sidepanel) — controllable via `BROWSE_EXTENSIONS` env var
- Exposes HTTP API for commands: goto, click, type, screenshot, js eval, network interception
- Supports headed mode handover (`connect`/`handoff`) for human intervention
- Auto-detects login walls and switches to headed mode — opt-in only, set `BROWSE_AUTO_HANDOVER=1` to enable. Default behavior reports login walls without popping a window.

## CDP Runtime.Enable Bypass (patches/cdp/)

The critical anti-detection layer. `Runtime.Enable` is the primary detection vector for Cloudflare, PerimeterX/HUMAN, and DataDome since 2024. Our patches:
1. Wrap all `Runtime.enable` calls with env-var check (`REBROWSER_PATCHES_RUNTIME_FIX_MODE`)
2. Replace with custom binding detection (`__re__emitExecutionContext`) that sites cannot distinguish from real browser behavior
3. Ported from [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) for Playwright 1.58.2
4. Applied automatically at browser startup via `applyStealthPatches()` in browser-manager.ts
