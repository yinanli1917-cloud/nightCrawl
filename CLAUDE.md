# nightCrawl

Your digital twin in the browser. Browses the web as you, in the background, on your machine.

## What This Is

A local-first CLI browser daemon that acts as your digital twin — imports your real cookies
from Arc/Chrome/Brave, navigates with stealth patches, persists sessions, and hands control
to you when it needs a human touch. Everything stays on your machine. Always.

## Competitive Position

No existing tool combines: **local CLI + real browser cookies + stealth + persistent sessions + human handover + proactive workflow detection**.

| Competitor | What it lacks |
|-----------|---------------|
| OpenClaw | `web_fetch` fails on Cloudflare (#20375, closed "not planned"); ClawJacked vulnerability |
| Browser Use (90K stars) | Has basic stealth flags + Chrome profile reuse + storage state persistence now, but no CDP/fingerprint patches in open-source (paywalled to cloud). Agent framework + fine-tuned model (bu-30b) is their moat. PostHog telemetry by default. |
| Browser Harness (7.7K stars, 10 days) | 990-line CDP harness that attaches to user's running Chrome. Zero stealth (IS the real browser). No headless, no sandbox (raw exec), no handoff. Domain-skills flywheel is the interesting pattern. Same team as Browser Use. |
| Browserbase | Cloud datacenter IPs detectable in 50ms |
| Einstein AI | Shut down, cease-and-desist, no privacy (cloud-based) |
| CloakBrowser | No agent framework, no cookie import, no session management (integration target for v0.2) |
| Camoufox | Firefox-based, no network interception |
| gstack browse | QA tool for your own sites, not the hostile web |

## Tech Stack

- TypeScript / Bun
- Playwright (patched — stealth as owned code, not dependency patches)
- Chromium (with CloakBrowser C++ fingerprint spoofing roadmap for v0.2)

## Directory Structure

| Path | Purpose |
|------|---------|
| `stealth/` | Anti-bot stealth layer — the actual working code |
| `stealth/browser/` | Complete working browser engine (CLI + daemon + commands) |
| `stealth/patches/cdp/` | CDP Runtime.Enable bypass (5 files + VERSION, rebrowser-patches v1.0.19 adapted for PW 1.58.2) |
| `stealth/extensions/` | Chrome extensions (bypass-paywalls v4.3.4.5 MV3, nightCrawl extension) |
| `research/` | Competitive landscape, anti-bot research |
| `docs/` | PRD, architecture docs, origin handoff |
| `docs/PRD.md` | Product Requirements Document (v0.2 — the source of truth) |
| `docs/product-notes/` | Snapshots of user's Apple Notes about the product (point-in-time, not live) |
| `subtitles/` | Proof-of-concept artifacts (gitignored) |

## Stealth Architecture

### Current
1. **UA fix** — consistent User-Agent across JS + HTTP levels, removes HeadlessChrome, sets real viewport
2. **CDP Runtime.Enable fix** — rebrowser-patches v1.0.19, adapted for PW 1.58.2 (5 files, auto-applied with `isPatchCurrent` optimization)
3. **Extension management** — `BROWSE_EXTENSIONS=none|paywall|all` controls extension loading per mode
4. **Auto-handover (consent-per-domain)** — detects login walls, opens headed Chrome, user logs in, auto-resumes headless. Detection ALWAYS runs; the gate is **per-domain consent** stored in `~/.nightcrawl/state/handoff-consent.json` keyed by eTLD+1 with TTL. Approve once per domain (`grant-handoff <domain>`), then nightCrawl auto-handles SSO autonomously for that domain (TTL 30d default). Unknown domains never silent-pop — they surface `CONSENT_REQUIRED` to the agent + macOS notification. Replaces the prior `BROWSE_AUTO_HANDOVER` env-var gate (removed 2026-04-14 after the UW Canvas regression incident).
5. **bypass-paywalls-chrome v4.3.4.5** — Manifest V3, declarativeNetRequest
6. **Cookie persistence** + import from Arc/Chrome/Firefox/Safari (AES-128-CBC decrypt via Keychain)
7. **Scoped token system** — per-agent permissions (read/write/admin/meta scopes), domain restrictions, rate limiting
8. **IPv6 + DNS hardening** — full fc00::/7, fe80::/10, IPv4-mapped IPv6, AAAA DNS rebinding, ReDoS-safe regex

9. **CloakBrowser engine** — the only production engine. CloakBrowser's stealth Chromium with 48 C++ patches (canvas, WebGL, audio, fonts, GPU, WebRTC, etc.). Failure throws with install instructions; stock Playwright fallback was removed (Chrome for Testing is detectable by every Tier-1+ vendor).
10. **Fingerprint profiles** — `BROWSE_FINGERPRINT_SEED` or per-identity seeds in `~/.nightcrawl/identities/`. Deterministic fingerprints across all surfaces.
11. **Behavioral humanization** — `BROWSE_HUMANIZE=1` enables CloakBrowser's built-in Bezier mouse, typing jitter, non-linear scroll (Tier 4-5 sites only)
12. **Fingerprint-pinned domain classifier** — `fingerprint-pinned.ts` detects sites whose bot-management vendor pins sessions to the solving browser's fingerprint (Cloudflare `cf-mitigated`, DataDome, Kasada, PerimeterX). Persists to `~/.nightcrawl/state/fingerprint-pinned.json`. Header-sniffed on `document` responses OR marked observationally when Arc cookie import fails to clear the wall. Shortens the default-browser poll from 5 min → 30 s for pinned domains and routes straight to headed CloakBrowser.
13. **Actionable notifications** — `notify.ts` adds `notifyWithAction(title, body, action)` using optional `terminal-notifier` (`brew install terminal-notifier`). Clickable buttons for "Focus browser" / "Focus CloakBrowser". Degrades to passive `notify()` when terminal-notifier absent.
14. **Persistent fingerprint seed** — `engine-config.ts` persists the CloakBrowser fingerprint seed to `~/.nightcrawl/state/engine-seed.json`. Every headless AND headed launch on this machine uses the SAME seed so bot-managed sites (CF/Akamai/etc) see a consistent fingerprint across sessions and headless↔headed transitions. Previously each launch picked a random seed, invalidating cookies each time.
15. **CloakBrowser for headed handoff** — `browser-handoff.ts` routes both `launchHeaded` and the `handoff` relaunch through `launchCloakBrowser`. Fixes the v0.2 gap where headless was CloakBrowser but handoff was Chrome-for-Testing, breaking the whole fingerprint-match premise.
16. **Late-redirect watcher** — `server.ts` runs a 20-second background URL watcher after every goto whose initial detection returned null. If the URL settles on a login path (CF dash takes ~10s to client-redirect `/` → `/login`), invalidates auth-cache, marks the domain as observed-pinned, and fires auto-handover or a consent notification.

### Engine Configuration
- CloakBrowser stealth Chromium is the only engine. `BROWSE_ENGINE` is no longer parsed.
- `BROWSE_FINGERPRINT_SEED=12345` — explicit fingerprint seed (10000-99999); otherwise persisted in `~/.nightcrawl/state/engine-seed.json`
- `BROWSE_HUMANIZE=0|1` — behavioral humanization (Bezier mouse, typing jitter, non-linear scroll)

### Roadmap (v0.3+)
- TLS/JA3 fingerprint masking
- Chinese internet tiers (Xiaohongshu, Zhihu via separate identities)

## Key Design Principles

1. **Your digital twin** — acts as you, not as a bot
2. **Everything local** — cookies, passwords, data never leave your machine
3. **Stealth is first-class code** — no patching dependencies in cache directories
4. **Autonomous by default, human handover by exception** — headless 95%, headed 5%
5. **SSH-style trust** — ask once per domain, remember forever, no annoying popups
6. **Proactive** — analyzes browsing history to suggest automations

## Conventions

- Bun runtime: `export PATH="$HOME/.bun/bin:$PATH"`
- State directory: `~/.nightcrawl/` (config, cookies, identities, audit log)
- All anti-bot patches must pass: bot-detector.rebrowser.net, bot.sannysoft.com, creepjs
- `BROWSE_EXTENSIONS=none|paywall|all` — control extension loading (default: `all`)
- Auto-handover off by default — set `BROWSE_AUTO_HANDOVER=1` to opt in. Otherwise login walls are reported back to the agent without popping a window.
- Cookies auto-persisted after handoff/resume + every 5 min + on shutdown
- Handoff consent: `grant-handoff <domain>` / `revoke-handoff <domain>` / `list-handoff` — per-eTLD+1 approval with 30-day default TTL
- macOS notifications: `notify()` in `src/notify.ts` (best-effort, opt-out via `NIGHTCRAWL_NO_NOTIFY=1`)

## Key References

- PRD: docs/PRD.md (v0.2 — all product decisions)
- rebrowser-patches: github.com/rebrowser/rebrowser-patches
- CloakBrowser: github.com/CloakHQ/CloakBrowser (v0.2 integration target)
- Patchright: github.com/Kaliiiiiiiiii-Vinyzu/patchright
- Camoufox: github.com/Bin-Huang/camoufox-cli
- gstack: github.com/garrytan/gstack (foundation)
