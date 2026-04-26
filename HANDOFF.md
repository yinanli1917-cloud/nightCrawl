# HANDOFF — 2026-04-26

## Current Task

Fix nightcrawl's inability to authenticate with Google services (Drive, Docs, Gmail). This session exposed that the entire auto-handoff pipeline — cookie import → headed fallback → resume — breaks completely on Google because Google's auth is fingerprint-pinned, session-bound, and demands interactive MFA/passkey verification that no amount of cookie shuffling can bypass.

## What Happened

User asked to upload a .docx to Google Drive. Should take 10 seconds. Instead:

1. `nc goto https://drive.google.com` → `LOGIN_WALL_DETECTED`
2. `grant-handoff google.com` → granted, auto-import pulled 83 cookies from Arc → still `LOGIN_WALL_DETECTED`
3. `handoff` → opened headed CloakBrowser → landed on Google sign-in, NOT logged in
4. Headed CloakBrowser has no Google session because Google ties auth to browser profile + device fingerprint + passkey, not just cookies
5. Fell back to AppleScript hacks to drive Arc directly → fragile, didn't work
6. Total failure. User rightfully furious.

## Root Cause

Google (and Apple ID, Microsoft, banking) uses a fundamentally different auth model than nightcrawl was built for:

- **Session cookies are not portable.** Google ties sessions to browser fingerprint, TLS state, and device attestation. Cookie from Arc → CloakBrowser = dead cookie. Google sees a different browser identity and invalidates.
- **Headed fallback doesn't help.** CloakBrowser has zero Google session state. The passkey is bound to Arc/Chrome's credential store, not CloakBrowser.
- **The consent-per-domain model assumes cookie import works.** For Google, it fundamentally cannot. The entire gate logic is predicated on cookie portability. For Tier-0 auth providers, cookies aren't portable.

## Completed

- ✅ Identified exact failure mode and root cause
- ✅ Confirmed this is architectural, not a bug in cookie-import or handoff code
- ✅ Google should be fingerprint-pinned but the handler didn't route to a viable fallback

## Proposed Solutions

### Option A: Arc CDP (RECOMMENDED)

Arc is Chromium. Connect to Arc's Chrome DevTools Protocol:
- Find Arc's CDP WebSocket URL (`/json/version`)
- `connectOverCDP()` via Playwright — full programmatic control of a real, authenticated Arc session
- All `nc` commands work as normal, user doesn't know the backend switched
- After operation, release the Arc tab

Implementation:
1. Detect Arc running, find CDP endpoint
2. New engine mode: `BROWSE_ENGINE=arc-cdp`
3. When Tier-0 domain + cookie-import fails → auto-fallback to Arc CDP
4. New file: `src/arc-cdp.ts` — connection manager

### Option B: Arc-as-Engine via AppleScript/Accessibility

Control Arc via macOS Accessibility API for Tier-0 domains. Fragile but zero-setup.

### Option C: Profile Sharing

Mount Arc's Chrome profile as CloakBrowser's user data dir. Most complete session transfer but locks Arc's profile and passkeys still won't transfer.

### Option D: Tier-0 Classifier + Default Browser Delegation

Extend `fingerprint-pinned.ts` to classify Tier-0 domains. For Tier-0: skip nightcrawl entirely, delegate to `open -a "Arc" <url>` + lightweight JS bridge. Pragmatic but breaks the headless promise.

## Files to Touch

- `stealth/browser/src/engine-config.ts` — Arc CDP engine detection
- `stealth/browser/src/browser-launch.ts` — `connectOverCDP()` path
- `stealth/browser/src/fingerprint-pinned.ts` — Tier-0 domain classification
- `stealth/browser/src/login-wall.ts` — Arc-CDP fallback in detection handler
- `stealth/browser/src/server.ts` — route Tier-0 domains to Arc CDP
- New: `stealth/browser/src/arc-cdp.ts` — Arc CDP connection manager

## Context

User was building a Red Roulette (红色赌盘) reference document. The doc is done:
- MD: `/Users/yinanli/Downloads/red-roulette-research/final-deliverables/红色赌盘-综合参考文档.md`
- PDF: same path, `.pdf` (20 pages, per-page footnotes, xelatex)
- DOCX: same path, `.docx` (57KB)
- Empty Google Doc created via MCP: `https://docs.google.com/document/d/1k_wdk586klv4C959SHJm66kihDJSlHChmP6_i22Htpw/edit`
- The docx still needs to be uploaded/imported into that Google Doc

## Next Steps

1. Research Arc's CDP exposure (does it need `--remote-debugging-port`?)
2. Prototype `arc-cdp.ts` — connect, navigate, verify auth
3. Add Tier-0 domain list (google.com, apple.com, microsoft.com, live.com)
4. Wire into login-wall handler: cookie-import fails on Tier-0 → Arc CDP fallback
5. Test with Google Drive upload end-to-end

---
*Created by Claude Code · 2026-04-26T14:00*
