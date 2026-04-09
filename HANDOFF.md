# HANDOFF — 2026-04-09 (Session 3)

## Mission
CloakBrowser engine is installed but not battle-tested. Switch from "would fix" to "does fix". Run real fingerprint tests with `BROWSE_ENGINE=cloakbrowser`, iterate until we pass Tier 1-4 bot detection sites. Everything must be verified against real websites, not unit tests.

## What's Done (Waves 2-5 — all pushed to GitHub)

### Wave 2: Stealth Foundation
- ✅ CDP patches re-ported from rebrowser-patches v1.0.19 (were a NO-OP before, now active)
- ✅ Fixed ConsoleMessage timestamp crash (Playwright 1.59.1 dispatcher validation — `Date.now()` in patched page.js)
- ✅ Playwright upgraded 1.58.2 → 1.59.1 (patched files identical, clean upgrade)
- ✅ bypass-paywalls-chrome updated to v4.3.4.5 MV3
- ✅ Re-enabled `applyStealthPatches()` in browser-manager.ts (was commented out by Wave 2 agent)

### Wave 3: Security Hardening
- ✅ Scoped token system: read/write/admin/meta per-agent permissions, domain globs, rate limiting (51 tests)
- ✅ IPv6 + DNS hardening: fc00::/7, fe80::/10, IPv4-mapped IPv6, AAAA DNS rebinding (19 tests)
- ✅ ReDoS fix: `frame --url` regex escaped via `escapeRegExp()`

### Wave 4: CloakBrowser Engine
- ✅ Dual engine architecture: `BROWSE_ENGINE=playwright|cloakbrowser` with graceful fallback
- ✅ `cloakbrowser@0.3.21` installed (48 C++ patches, Chromium 145, macOS ARM64)
- ✅ Fingerprint profiles: per-identity seeds in `~/.nightcrawl/identities/`
- ✅ `engine-config.ts`, `cloakbrowser-engine.ts`, `fingerprint-profiles.ts` (21 tests)
- ⚠️ **NOT YET TESTED with real websites** — only unit tests confirm package loads

### Wave 5: Behavioral Humanization
- ✅ `BROWSE_HUMANIZE=1` config wired to CloakBrowser's built-in Bezier mouse, typing jitter, scroll
- ⚠️ **NOT YET TESTED** — needs CloakBrowser engine to be working first

### Bug Fixes (Session 3)
- ✅ Server EPIPE crash: CLI uses `nohup` for true process detachment
- ✅ Auto-handover default: `BROWSE_AUTO_HANDOVER` now on by default (was opt-in, logic was inverted)
- ✅ Auto-handover detection: QR code login (XHS), "登录后" text, SPA rendering wait (2s)
- ✅ Auto-resume: detects login wall disappearance (not just URL change) for SPA sites
- ✅ Auto-resume: waits for login wall to appear in headed mode before polling (prevents false-positive)
- ✅ Auto-resume: force-kills headed Chrome via `pkill nightcrawl-handoff` (context.close() wasn't enough)
- ✅ Incognito mode: `BROWSE_INCOGNITO=1` — no cookie restore, no cookie persist
- ✅ Auto-update checker: warns on outdated deps at startup (24h cooldown, 5s timeout)

---

## ACCOUNT SAFETY — CRITICAL RULE (ELEVATED)

**NEVER load real user cookies when testing hostile platforms.**

On 2026-04-08, I loaded the user's 3,259 real Arc cookies, navigated to XHS while already logged in as the user, and opened a headed browser — exposing their real account to anti-bot detection. This is a CRITICAL violation.

**Protocol for hostile platform testing:**
1. `BROWSE_INCOGNITO=1` — ALWAYS. No exceptions.
2. Ask for test account FIRST, get explicit confirmation
3. Only then navigate to Tier 4-5 sites
4. Cookie restore happens automatically — `BROWSE_INCOGNITO=1` is the ONLY way to prevent it

Hostile platforms (Tier 4-5): Xiaohongshu, Douyin, Weibo, LinkedIn, Instagram

Safe to test freely (Tier 1-3): bot-detector.rebrowser.net, creepjs, bot.sannysoft.com, bot.incolumitas.com, The Atlantic, Medium, any public page

---

## Real-World Test Results (Playwright Engine)

| Site | Result | Gap |
|------|--------|-----|
| bot-detector.rebrowser.net | 5/6 green | useragent red (Chrome for Testing, not real Chrome) |
| bot.sannysoft.com | Mostly pass | Plugins=0, Chrome object missing (headless shell) |
| CreepJS | FP generated | SwiftShader in WebGL (headless marker), real IP in WebRTC |
| bot.incolumitas.com | Behavioral=0 | No mouse/keyboard interaction |
| The Atlantic | Full content | Paywall bypassed |
| XHS (public) | Full content | No bot block |
| XHS (QR login) | Auto-handover works | Full cycle: detect → headed → scan → auto-resume |

### What Playwright Engine Cannot Fix
These require CloakBrowser's C++ patches:
- Canvas/WebGL fingerprint → SwiftShader reveals headless
- userAgentData → Chrome for Testing brand exposed
- Behavioral score → no mouse/keyboard/scroll patterns
- Audio fingerprint → headless audio context differs
- GPU vendor/renderer → SwiftShader, not real GPU

---

## What Needs Doing Next

### Priority 1: CloakBrowser Real-World Verification (THE CRITICAL PATH)
The engine is installed but never tested against real sites. This is the gap.

1. **Start with safe Tier 1 sites** — `BROWSE_ENGINE=cloakbrowser BROWSE_INCOGNITO=1`
   - bot-detector.rebrowser.net → should pass ALL tests (including useragent)
   - CreepJS → should show real GPU strings, not SwiftShader
   - bot.incolumitas.com → should get canvas/WebGL/audio fingerprints that look human

2. **Compare Playwright vs CloakBrowser side-by-side** — same sites, document differences

3. **If CloakBrowser binary doesn't download or launch**, investigate:
   - `~/.cloakbrowser/` directory for binary
   - Network errors (200MB download)
   - Architecture mismatch
   - Fall back to alternative: try patchright (`npm install patchright`)

4. **Test CloakBrowser with BROWSE_HUMANIZE=1** on bot.incolumitas.com
   - Behavioral score should jump from 0 to >0.5
   - Mouse movement, scroll, typing patterns

5. **Tier 4 test** (BROWSE_INCOGNITO=1 ONLY):
   - Bilibili public page
   - Zhihu public Q&A

### Priority 2: Consolidate Duplicated Code
- `stealth.ts` duplicates `browser-manager.ts` patch logic — consolidate
- `browser-manager.ts` is over 800 lines — needs splitting

### Priority 3: Pre-Existing Test Failures
- 3 tests in `stealth-cdp.test.ts` fail (browser-manager doesn't import from stealth module)
- CNKI integration test requires VPN
- `nightcrawl-update-check.test.ts` has 4 failing tests (--force flag, cache expiry)

---

## Auto-Handover Flow (Verified Working)

```
CLI: goto https://www.xiaohongshu.com
  → server.ts: handleWriteCommand("goto")
  → 2s SPA wait
  → detectLoginWall(): QR code detected OR "登录后" text
  → autoHandover():
    → handoff(): close headless, open headed Chrome
    → 15s grace period
    → 10s confirm login wall appeared in headed mode
    → poll every 3s:
      Strategy 1: URL changed? → login success
      Strategy 2: QR code / login text disappeared? → login success
    → resume(): save cookies, kill headed Chrome (pkill nightcrawl-handoff), launch headless
```

---

## File Map (Session 3 Changes)

```
NEW:  stealth/browser/src/token-registry.ts        — per-agent permission system
NEW:  stealth/browser/src/update-checker.ts         — auto-update check on startup
NEW:  stealth/browser/src/cloakbrowser-engine.ts    — CloakBrowser launch wrapper
NEW:  stealth/browser/src/engine-config.ts          — BROWSE_ENGINE/SEED/HUMANIZE config
NEW:  stealth/browser/src/fingerprint-profiles.ts   — per-identity seed management
NEW:  stealth/browser/test/scoped-tokens.test.ts    — 51 tests
NEW:  stealth/browser/test/ipv6-dns-hardening.test.ts — 19 tests
NEW:  stealth/browser/test/cdp-patches-v2.test.ts   — 47 tests
NEW:  stealth/browser/test/cloakbrowser-integration.test.ts — 21 tests
NEW:  stealth/browser/test/update-checker.test.ts   — 19 tests
NEW:  stealth/browser/test/bypass-paywalls-update.test.ts — 10 tests
NEW:  stealth/patches/cdp/VERSION                   — rebrowser-patches v1.0.19 + PW 1.59.1
MOD:  stealth/browser/src/browser-manager.ts        — CloakBrowser engine, auto-handover, incognito
MOD:  stealth/browser/src/server.ts                 — token system, update checker, incognito, auto-handover
MOD:  stealth/browser/src/cli.ts                    — nohup server detachment, startup error log
MOD:  stealth/browser/src/url-validation.ts         — IPv6 full range, AAAA DNS rebinding
MOD:  stealth/browser/src/meta-commands.ts          — ReDoS fix in frame --url
MOD:  stealth/browser/src/stealth.ts                — removed screencast.js
MOD:  stealth/browser/package.json                  — playwright 1.59.1, cloakbrowser 0.3.21
MOD:  stealth/patches/cdp/page.js                   — ConsoleMessage timestamp fix
DEL:  stealth/patches/cdp/screencast.js             — no modifications needed
MOD:  CLAUDE.md                                     — full architecture update
```

## Environment Notes
- nightCrawl skill: use `export BROWSE_EXTENSIONS=none BROWSE_EXTENSIONS_DIR= BROWSE_IGNORE_HTTPS_ERRORS=1`
- Incognito: add `BROWSE_INCOGNITO=1` for hostile platform tests
- CloakBrowser: add `BROWSE_ENGINE=cloakbrowser` to test C++ patches
- Server runs via `bun run stealth/browser/src/cli.ts <command>` or direct server + curl

## Memory References
- `feedback_cookie_isolation_critical.md` — CRITICAL: never load real cookies for hostile tests
- `feedback_test_accounts_safety.md` — ask for test accounts first
- `project_architecture_revolution_plan.md` — 4-wave plan
- `reference_antibot_2026_landscape.md` — threat landscape and test sites

---
*Created by Claude Code · 2026-04-09T01:05:00Z*
