# HANDOFF — 2026-04-28 (Session 10)

## 当前任务
Sensitive page gate: detect payment/checkout/personal-info pages and hand control to the user before the agent proceeds. Triggered by the Cloudflare domain purchase scenario where nightcrawl silently arrived at checkout with no notification.

## 完成状态
- ✅ `sensitive-page.ts` — generalized detector with 4 categories (payment, personal_info, account_security, destructive), signal-based thresholds, single `page.evaluate()`
- ✅ `server.ts` integration — `checkSensitivePage()` runs in both auth-cache fast path and post-login-wall flow
- ✅ `notifyWithAction()` migration — all `notify()` calls replaced with native Swift alert
- ✅ Arc-first cookie import — removed `if (!siteIsPinned)` gate so pinned domains try Arc before CloakBrowser
- ✅ `js`/`evaluate` commands added to detection trigger list (SPA navigations)
- 🔴 **END-TO-END CLOUDFLARE CHECKOUT: NOT VERIFIED CLEAN** — every fix introduced a new regression:
  - `open URL` (Arc) loses SPA cart state → switched to `open-handoff`
  - `open-handoff` (CloakBrowser) loses login state → SIGKILL kills cookies before flush
  - SIGTERM fix shipped but not verified because session expired again
  - Arc import works once but cookies lost on daemon restart
- 🔴 **Shine Connect false positive** — `detectLoginWall()` fires on every page with a password input, even if the login form IS the content (not a wall blocking access). Spammed user with 8 alerts.

## 10 Commits This Session (all pushed to main)
1. `98793a5` feat(detect): generalized sensitive page gate with native handoff
2. `9373baa` docs: update competitive landscape
3. `3113168` fix(handoff): SIGKILL headless Chromium before headed launch
4. `d00094f` fix(detect): broaden sensitive page patterns for real-world checkouts
5. `77de31c` refactor(notify): migrate all notify() to notifyWithAction()
6. `1e887de` fix(handoff): always try Arc cookie import before CloakBrowser
7. `d9c02c1` fix(detect): run sensitive page check after js/evaluate commands
8. `09c280d` fix(detect): use live page URL in Take Over notification, not stale
9. `49f120d` fix(detect): use open-handoff for sensitive page Take Over, not open URL
10. `1d0e9e2` fix(handoff): SIGTERM before SIGKILL to preserve cookie flush

## Root Cause Analysis — Why 10 Fixes Still Failed

**The fundamental problem: each fix was shipped without end-to-end verification of the FULL Cloudflare domain purchase flow.** Each fix passed its narrow test but broke something downstream.

The Cloudflare checkout flow has 4 coupled requirements:
1. **Session persistence** — cookies must survive headless→headed→headless transitions AND daemon restarts
2. **Cart state preservation** — SPA checkout state only exists in nightcrawl's browser context, not transferable to Arc
3. **Detection timing** — `js` commands cause SPA navigation AFTER the command, but detection runs based on pre-command state
4. **Notification correctness** — "Take Over" URL must be the post-navigation URL, and must open a browser that has the session

Each was fixed in isolation without testing the chain. Next session must design this as ONE coherent flow.

## Key Decisions Made
- Sensitive page "Take Over" → `open-handoff` (CloakBrowser, preserves session state), NOT `open URL` (Arc, loses cart)
- Login wall "Take Over" → `open URL` (Arc, user logs in on familiar browser, cookies sync)
- Fingerprint-pinning should NOT skip Arc import — Session 8 proved auth cookies work even when cf_clearance is pinned
- All notifications use `notifyWithAction()` (native Swift alert), zero `notify()` (osascript) remaining

## Known Issues / Landmines

### 1. Cookie loss on headless→headed transition
`handoff()` closes headless then opens headed CloakBrowser. Cookies imported via `context.addCookies()` (Arc import) are in Chromium's in-memory store. Graceful close SHOULD flush to SQLite, but the 5s timeout + SIGTERM/SIGKILL may not give enough time.

**Potential fix:** Before `handoff()` close, force cookie flush — navigate to `about:blank` (triggers internal cleanup), or write cookies to SQLite directly.

### 2. Cookie loss on daemon restart
Arc-imported cookies live in Chromium's in-memory store. Daemon stop/restart loses them. Session 8's cookie watcher (`syncAllCookies` with `all-domains` mode) should handle this — verify it's active.

### 3. False positive login wall detection (Shine Connect)
`detectLoginWall()` flags any page with `input[type="password"]`. Sites where the login form IS the content trigger repeated alerts (8x on Shine Connect).

**Fix:** Distinguish "redirected to login" (wall) from "navigated to a page with a login form" (intentional). Compare requested URL vs actual URL.

### 4. `js` command detection adds latency to ALL js calls
Adding `js` to the trigger list means every `js` command runs 2-8s stabilization + DOM checks. Most `js` commands are quick reads.

**Fix:** Only run detection if the URL changed after the `js` command.

## Next Session: Start Over with TDD

1. **Consider reverting** all 10 commits back to `7d16142` (clean Session 9 state)
2. **Write the failing test first** — full Cloudflare checkout scenario
3. **Design as ONE coherent feature**, not incremental patches
4. **Verify end-to-end on REAL Cloudflare checkout** before claiming done
5. **Fix false positive login wall detection** separately

## Related Files
- `stealth/browser/src/sensitive-page.ts` — NEW, the detector (solid, keep)
- `stealth/browser/src/server.ts` — heavily modified
- `stealth/browser/src/browser-handoff.ts` — modified: Arc-first, SIGTERM/SIGKILL
- `stealth/browser/src/meta-commands.ts` — modified: notify-test
- `stealth/browser/src/notify.ts` — unchanged

---
*Created by Claude Code · 2026-04-28T00:35*
