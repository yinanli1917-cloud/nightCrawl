# HANDOFF — 2026-04-07 (Session 2)

## Mission
Surpass gstack browse v0.15 in every dimension. Wave 1 shipped. Continue with Waves 2-5 autonomously, self-reinforcing through parallel subagents. Every change must be verified against REAL websites, not just unit test fixtures.

## What's Done (Wave 1 — pushed to GitHub)
- **Cookie revolution**: Firefox + Safari import, mmap optimization (42 tests, 8 browsers total)
- **Content security**: 4-layer defense — hidden element stripping, exfil blocklist, datamarking, envelope (56 tests)
- **Unix domain sockets**: 2x faster IPC, backwards-compatible TCP fallback (14 tests)
- **Page cleanup**: 9 categories of noise removal, token savings reporting (20 tests)
- **Pre-warmed startup**: 66x faster (3377ms → 51ms server-internal, ~2.6s real cold start) (7 tests)
- **Dependency audit**: Playwright 1.59.1 available, rebrowser-patches 6 releases behind, bypass-paywalls 5 months behind
- **Real-world verified**: bot.sannysoft.com passes, The Atlantic paywall bypassed, Forbes cleanup works, webhook.site blocked, 38ms/command

---

## ACCOUNT SAFETY — CRITICAL RULE

**NEVER use the user's main accounts for testing on hostile platforms.**

Before touching ANY site that requires login on an aggressive anti-bot platform, ASK the user for a test account. The user has offered to provide test accounts for Chinese platforms.

Hostile platforms (will ban accounts on detection):
- Xiaohongshu (小红书) — device fingerprinting + behavioral ML + account scoring
- Douyin (抖音) — TLS fingerprinting + request signing + device binding
- Weibo (微博) — IP reputation + behavioral patterns
- LinkedIn — aggressive automation detection + account restriction
- Instagram — Meta behavioral fingerprinting + shadow bans

Safe to test without accounts:
- Bot detection test sites (bot.sannysoft.com, creepjs, browserleaks.com, bot-detector.rebrowser.net)
- Paywalled news (The Atlantic, Medium, Forbes — no login needed)
- Public pages (GitHub, Wikipedia, Hacker News)

---

## Real-World Verification Test Suite

### Tier 1: Bot Detection Sites (SAFE — no account needed, test after every change)
| Site | What it checks | Must pass | Priority |
|------|---------------|-----------|----------|
| `bot-detector.rebrowser.net` | CDP Runtime.Enable leak, Playwright-specific traces | Green | **#1 — tests exactly what our patches fix** |
| `bot.incolumitas.com` | 30+ classifiers: fingerprint + behavioral + network + proxy/VPN | Score > 0.7 | **#2 — best overall bot test** |
| `abrahamjuliot.github.io/creepjs` | 50+ fingerprint metrics, cross-metric contradiction detection | Trust score > 70% | **#3 — detects spoofed values** |
| `demo.fingerprint.com/web-scraping` | Commercial FingerprintJS (what real sites actually use) | Not flagged | **#4 — real-world detection** |
| `pixelscan.net` | Browser fingerprint consistency, OS/browser mismatch | Consistent | #5 |
| `bot.sannysoft.com` | WebDriver, Chrome object, Plugins, Languages | All green | #6 — outdated (2019-era), minimum bar only |
| `browserleaks.com` | WebRTC, Canvas, WebGL, fonts, screen | No headless markers | #7 — manual inspection |

### Tier 2: Anti-Bot Protected Sites (SAFE — public pages, no login)
| Site | Anti-bot system | What to test |
|------|----------------|-------------|
| `cloudflare.com/cdn-cgi/trace` | Cloudflare | Returns connection info (not challenge page) |
| Any Cloudflare-protected site | Turnstile | Page loads, not stuck on challenge |
| `medium.com` (any article) | Cloudflare | Full article text via bypass-paywalls |
| `bloomberg.com` | Akamai | Page loads without bot block |
| `linkedin.com/jobs` (public) | LinkedIn WAF | Job listings load (no login needed) |

### Tier 3: Paywalled Sites (SAFE — bypass-paywalls, no login)
| Site | Paywall type | Expected result |
|------|-------------|----------------|
| `theatlantic.com` | Metered paywall | Full article text (VERIFIED: 10,421 chars) |
| `nytimes.com` | Hard paywall | Article text or paywall indicator |
| `washingtonpost.com` | Metered | Full article text |
| `wired.com` | Metered | Full article text |

### Tier 4: Chinese Protected Sites (CAUTION — public pages only, NO login)
| Site | Detection | What to test (public only) |
|------|----------|--------------------------|
| `zhihu.com` (public Q&A) | Moderate anti-bot | Can read public answers |
| `bilibili.com` (public video page) | Moderate | Can read video info |
| `xiaohongshu.com` (public posts) | **EXTREME** — device fingerprint, canvas, WebGL, audio, behavioral | Even loading public pages may flag IP |
| `douyin.com` (public) | **EXTREME** — TLS/JA3, request signing | Public page load without block |

### Tier 5: Chinese Protected Sites (DANGEROUS — requires test account from user)
| Site | What to test | Pre-requisite |
|------|-------------|--------------|
| XHS login + browse | Session persistence, no account flag | CloakBrowser (Wave 4) + test account |
| Douyin login + browse | Cookie import, session maintenance | CloakBrowser (Wave 4) + test account |
| Weibo login + browse | Feed browsing, content reading | Wave 2 stealth upgrade + test account |

---

## Waves 2-5: Autonomous Self-Reinforcing Evolution

### How to Execute
Launch parallel subagents in isolated worktrees. Each agent:
1. **Research online** (WebSearch/WebFetch) for latest techniques and best practices — NEVER rely solely on training data
2. **Write failing tests first** (TDD iron law)
3. **Implement** the feature
4. **Run unit tests** to verify
5. **Run real-world tests** (Tier 1-3 from the test suite above) to verify user experience
6. **Iterate** until both unit AND real-world tests pass

### Wave 2: Stealth Foundation (CRITICAL PATH)

**Agent 1: Re-port CDP patches**
- Clone rebrowser-patches latest from GitHub
- Understand new unified .patch format (lib.patch + src.patch)
- Port to nightCrawl's patch system in stealth.ts
- Test against Tier 1 bot detection sites
- MUST pass bot-detector.rebrowser.net (the rebrowser project's own test)

**Agent 2: Upgrade Playwright to 1.59.1**
- BLOCKED on Agent 1 (patches must work first)
- Update package.json, run bun install
- Run full test suite + Tier 1 real-world tests
- New features: screencast API, browser.bind(), locator.normalize()

**Agent 3: Update bypass-paywalls-chrome to 4.3.4.0**
- Download from gitflic.ru/project/magnolia1234/bypass-paywalls-chrome-clean
- Replace stealth/extensions/bypass-paywalls-chrome/
- Test against Tier 3 paywalled sites

### Wave 3: Security Hardening

**Agent 1: Scoped token system**
- Per-agent permissions: read/write/admin/meta scopes
- Domain restriction globs
- Rate limiting per client
- Test: sidebar agent cannot run `js`, `cookie`, `storage set`

**Agent 2: IPv6 + DNS hardening**
- fc00::/7 ULA full-range blocking
- AAAA record resolution in DNS rebinding check
- fe80::1 and ::ffff:169.254.169.254 blocked
- ReDoS fixes (frame --url regex, escapeRegExp)

### Wave 4: CloakBrowser Integration (v0.2 — the stealth revolution)

This is the gate to Chinese internet. Without C++ level fingerprint spoofing, Tier 4-5 sites will detect us.

**Research first:**
- How does CloakBrowser npm package work?
- What are the 48 C++ patches? (canvas, WebGL, audio, fonts, GPU, WebRTC, screen, automation, behavioral, storage)
- Can it be used as a drop-in Playwright replacement?
- What fingerprint seed format does it use?

**Then implement:**
- Integration as alternative browser engine
- Fingerprint profile generation and persistence
- Test against Tier 1 → Tier 2 → Tier 4 (progressive)
- Only attempt Tier 5 (XHS/Douyin login) with user's test account

### Wave 5: Advanced Stealth + Behavioral

**TLS/JA3/JA4 masking:**
- Playwright's bundled Chromium has a real Chrome TLS fingerprint
- But proxy traffic may have different JA3 — detect and warn
- Research: does CloakBrowser handle this already?

**HTTP/2 fingerprinting:**
- SETTINGS frame ordering must match real Chrome
- Research: is this handled by Chromium itself or needs patching?

**Behavioral humanization:**
- Bezier mouse curves (not straight lines)
- Typing jitter (not instant fills)
- Scroll momentum (not instant jumps)
- Only needed for Tier 5 sites — Tier 1-3 don't care about behavior

---

## Anti-Bot Threat Landscape (2026) — from web research

### Critical insight: TLS fingerprinting is the #1 blocker
Playwright's bundled Chromium has a JA3 hash matching NO real Chrome release. Akamai's sensor.js reads your TLS ClientHello BEFORE any HTTP traffic. Detection happens before JavaScript runs. JS-level patches CANNOT fix this. Only C++ binary patches (CloakBrowser) can.

### Detection difficulty ranking
| Tier | System | Key signals | nightCrawl status |
|------|--------|------------|-------------------|
| 1 | Basic WAF | IP, headers, rate | **PASS** (cookie import = real session) |
| 2 | Cloudflare standard | JS challenge | **PASS** (CDP patches) |
| 3 | Cloudflare Turnstile v2 | CDP detection (Chrome bug since Feb 2025) + TLS + fingerprint + crypto | **PARTIAL** (CDP patches help, but multi-layer) |
| 3 | Bilibili, Zhihu | Standard fingerprint + rate limiting | **LIKELY PASS** (CDP patches + cookies) |
| 4 | DataDome | 35+ signals, 85,000 customer-specific ML models, behavioral | **FAIL** (need CloakBrowser + behavioral) |
| 4 | PerimeterX/HUMAN | px.js deep fingerprinting + behavioral biometrics, quarterly updates | **FAIL** (need CloakBrowser) |
| 5 | Akamai | sensor.js: TLS ClientHello BEFORE HTTP, behavioral ML, session flow | **FAIL** (TLS mismatch = instant block) |
| 5 | XHS | x-s/x-s-common/x-t proprietary signatures + device fingerprint + behavioral + active AI account crackdown (March 2026) | **FAIL** (need CloakBrowser + reverse-engineering + test account) |
| 5 | Douyin | X-Bogus/A-Bogus proprietary tokens + TLS + device binding | **FAIL** (need CloakBrowser + signature reverse-engineering) |

### What makes Chinese platforms especially dangerous
- **Proprietary signature systems**: XHS uses x-s/x-t tokens, Douyin uses X-Bogus/A-Bogus. These are NOT standard anti-bot — they require reverse-engineering platform-specific token generation. Generic stealth patches are irrelevant.
- **Device binding**: XHS ties fingerprint to account. Get flagged once = flagged forever on that device fingerprint.
- **Active crackdown**: XHS specifically targeting AI-managed accounts as of March 2026 (TechNode report).
- **IP flagging**: Even loading public XHS pages without login may flag IP for later account detection.
- **puppeteer-extra-stealth declared "fundamentally unsustainable"** against DataDome/Akamai/Chinese platforms — detection uses TLS + behavioral, not just automation flags.

### The path forward
1. **Wave 2** (CDP patches + Playwright upgrade) → pass Tier 1-2 reliably
2. **Wave 4** (CloakBrowser) → pass Tier 3-4, attempt Tier 5 with test accounts
3. **Wave 5** (behavioral humanization) → sustain access on Tier 5 without account flags

---

## Known Issues
- **CDP patches 6 releases behind**: rebrowser-patches v1.0.19 uses new unified .patch format (was individual JS files). Must re-port.
- **Arc iCloud Keychain**: may have migrated encryption keys to Apple's Passwords.app. Not confirmed broken. Flagged by yt-dlp#13710.
- **browser-manager.ts over 800 lines**: pre-warm agent inlined stealth functions. Consider splitting.
- **Pre-existing test failures**: 2 flaky tests in commands.test.ts (console buffer noise + stale cookies).
- **Cold start still 2.6s for user**: 51ms is server-internal metric. Real user experience includes binary spawn + Chromium launch. Pre-warm helps subsequent commands (38ms each).

## File Map (Wave 1 changes)
```
NEW:  stealth/browser/src/content-security.ts    — 4-layer defense
NEW:  stealth/browser/src/cleanup.ts             — smart noise removal
NEW:  stealth/browser/src/cookie-import-firefox.ts — Firefox cookies
NEW:  stealth/browser/src/cookie-import-safari.ts  — Safari cookies
MOD:  stealth/browser/src/server.ts              — UDS + parallel startup
MOD:  stealth/browser/src/cli.ts                 — UDS client
MOD:  stealth/browser/src/config.ts              — socketPath
MOD:  stealth/browser/src/browser-manager.ts     — pre-warm + patch cache
MOD:  stealth/browser/src/commands.ts            — cleanup + enhanced trust
MOD:  stealth/browser/src/read-commands.ts       — hidden element stripping
MOD:  stealth/browser/src/url-validation.ts      — exfil URL blocklist
MOD:  stealth/browser/src/write-commands.ts      — cleanup handler
MOD:  stealth/browser/src/cookie-import-browser.ts — FF/Safari dispatch
```

## Memory References
- `project_gstack_v015_audit.md` — full gstack v0.14→v0.15 diff
- `project_architecture_revolution_plan.md` — product-aligned wave plan
- `feedback_test_accounts_safety.md` — NEVER use main accounts on hostile sites
- `reference_antibot_bypass.md` — per-site stealth strategies
- `reference_stealth_roadmap.md` — C++ fingerprinting, JA3, Chinese tiers

---
*Created by Claude Code · 2026-04-07*
