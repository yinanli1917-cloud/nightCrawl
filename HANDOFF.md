# HANDOFF — 2026-04-04

## Current Task
Rebrand gstack to nightcrawl, fix stealth gaps, implement fully automatic login handover, and scrape anti-bot/scraper court cases from wenshu.court.gov.cn.

## Completion Status
- ✅ Track 1: Full gstack → nightcrawl rename (38 files, 351 occurrences)
- ✅ Track 1: README.md with Acknowledgments (Garry Tan + all open source projects)
- ✅ Track 2 Gap 1: HTTP-level UA leak fixed (consistent UA across JS + HTTP in all 3 code paths)
- ✅ Track 2 Gap 2: CDP patches auto-applied at startup (`applyStealthPatches()` — patches ALL playwright-core versions in bun cache)
- ✅ Track 2 Gap 4: `BROWSE_EXTENSIONS=none|paywall|all` env var
- ✅ Track 3: Auto-handover (`detectLoginWall()` + `autoHandover()` — fully automatic cycle)
- ✅ Tests: 5 test files, 24 unit/source-audit tests passing
- ✅ Chinese branding audit: zero Chinese branding found (only detection patterns)
- ✅ State migration: `.gstack/` → `.nightcrawl/` one-time cookie copy in `ensureStateDir()`
- 🔄 Court.gov.cn scraping — auto-handover cycle works (headless → headed → user logs in → headless), but cookies not surviving the `resume()` relaunch
- ⏳ Track 2 Gap 3: Multi-tab context isolation (architectural — separate BrowserContext per domain)
- ⏳ Track 2 Gap 5: XHS image carousel lazy loading (app-level)
- ⏳ Court.gov.cn: search for 爬虫/反爬虫/网络安全/数据抓取 cases and download judgment documents

## Key Decisions
- **Directory rename**: `stealth/gstack-browse-full/` → `stealth/browser/` (shorter, cleaner)
- **Extension rename**: `gstack-extension/` → `nightcrawl-extension/`
- **State dirs**: `.gstack/` → `.nightcrawl/` everywhere, with one-time migration in `config.ts`
- **CDP patches**: applied to ALL playwright-core versions in bun cache (not just the first), prevents version mismatch
- **UA fix**: removed `--user-agent` Chromium arg, added `DEFAULT_USER_AGENT` constant, set `contextOptions.userAgent` + `setExtraHTTPHeaders` consistently in launch/recreateContext/handoff
- **Auto-handover architecture**: fire-and-forget from server handler (non-blocking HTTP response), 15s grace period before polling, URL-change detection instead of DOM inspection
- **Lazy Playwright import**: `getChromium()` wrapper ensures CDP patches apply before Playwright loads
- **`findChromiumExecutable()`**: resolves correct Chromium binary when multiple versions exist in ms-playwright cache

## Known Issues / Blockers

### 1. `resume()` crash during headless relaunch
**Error**: `this._page._delegate._sessions is not an object` when `launch()` is called from `resume()` after closing the headed browser.
**Root cause**: The extension-mode `launchPersistentContext()` path in `launch()` fires even though `BROWSE_EXTENSIONS=none`. The check `if (extensionsDir)` evaluates `BROWSE_EXTENSIONS_DIR` (the old gstack env var that may still be set by the gstack binary). When it tries to launch persistent context, it conflicts with the just-closed headed context's user data directory.
**Fix needed**: In `resume()`, ensure `launch()` takes the standard (non-extension) code path. Or better: `resume()` should directly call `chromium.launch({ headless: true })` + `browser.newContext()` without going through `launch()` which has too many side effects.

### 2. Cookies not surviving auto-handover cycle
**Symptom**: After `resume()` relaunches headless, the court.gov.cn cookies from the user's login session are gone.
**Root cause**: `resume()` calls `this.saveState()` before closing headed browser (correct), then calls `this.launch()` which creates a fresh context, then `this.restoreState(state)`. But if `launch()` crashes (issue #1), restoreState never runs, cookies are lost.
**Fix needed**: Fix issue #1 first. Then verify `saveState()` captures all cookies from the headed context, and `restoreState()` applies them to the new headless context.

### 3. Playwright version mismatch
**Context**: bun cache has playwright-core 1.58.2 (chromium-1208) and 1.59.1 (chromium-1217). `NODE_PATH=~/.gstack/node_modules` resolves to 1.58.2, but Bun's own resolution sometimes picks 1.59.1.
**Current mitigation**: `findChromiumExecutable()` finds the correct binary and passes `executablePath` to `launchPersistentContext()`. CDP patches are applied to both versions.
**Long-term fix**: Pin Playwright version in nightCrawl's own package.json + bun.lock.

### 4. Court.gov.cn anti-scraping
**cipher() tokens**: The site generates binary-encoded session tokens with short TTLs. Direct API calls fail. Must navigate through the site's own UI (clicking, filling forms).
**Session expiry**: Login cookies expire quickly. Need to handle re-authentication gracefully.

## Next Steps
1. **Fix `resume()` relaunch** — make it use the simple headless path, not the full `launch()` method
2. **Verify cookie preservation** — save → close headed → launch headless → restore → verify cookies survived
3. **Scrape court.gov.cn** — after fixing resume, trigger auto-handover, log in, then search for 爬虫/反爬虫/网络安全/非法获取计算机信息系统数据 cases
4. **Pin Playwright version** — create package.json in `stealth/browser/` with playwright-core@1.58.2 dependency
5. **Gap 3: Multi-tab context isolation** — design per-domain BrowserContext for cookie isolation

## Key Files Modified
- `stealth/browser/src/browser-manager.ts` — core engine: UA fix, CDP patches, extension management, auto-handover, resume, findChromiumExecutable
- `stealth/browser/src/config.ts` — `.nightcrawl/` paths, cookie migration
- `stealth/browser/src/server.ts` — branding, auto-handover wiring (fire-and-forget from handleCommand)
- `stealth/browser/src/cli.ts` — branding, paths
- `stealth/browser/src/sidebar-agent.ts` — paths
- `stealth/browser/src/find-browse.ts` — paths
- `stealth/extensions/nightcrawl-extension/` — 7 files rebranded
- `stealth/browser/test/stealth-ua.test.ts` — UA consistency tests
- `stealth/browser/test/stealth-cdp.test.ts` — CDP patch source audits (13 tests)
- `stealth/browser/test/stealth-extensions.test.ts` — extension management audits (7 tests)
- `stealth/browser/test/login-wall-detection.test.ts` — login wall detection tests
- `stealth/browser/test/cookie-migration.test.ts` — migration tests (4 tests)
- `CLAUDE.md` — updated directory table, stealth architecture, conventions
- `README.md` — created with Acknowledgments section
- `.gitignore` — updated paths

---
*Created by Claude Code · 2026-04-04T07:35:00Z*
