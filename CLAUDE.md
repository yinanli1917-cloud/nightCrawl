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
| Browser Use | No stealth, no cookie import, stateless ("awkward middle ground") |
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
| `subtitles/` | Proof-of-concept artifacts (gitignored) |

## Stealth Architecture

### Current
1. **UA fix** — consistent User-Agent across JS + HTTP levels, removes HeadlessChrome, sets real viewport
2. **CDP Runtime.Enable fix** — rebrowser-patches v1.0.19, adapted for PW 1.58.2 (5 files, auto-applied with `isPatchCurrent` optimization)
3. **Extension management** — `BROWSE_EXTENSIONS=none|paywall|all` controls extension loading per mode
4. **Auto-handover** — detects login walls, opens headed Chrome, user logs in, auto-resumes headless (on by default, opt-out with `BROWSE_AUTO_HANDOVER=0`)
5. **bypass-paywalls-chrome v4.3.4.5** — Manifest V3, declarativeNetRequest
6. **Cookie persistence** + import from Arc/Chrome/Firefox/Safari (AES-128-CBC decrypt via Keychain)
7. **Scoped token system** — per-agent permissions (read/write/admin/meta scopes), domain restrictions, rate limiting
8. **IPv6 + DNS hardening** — full fc00::/7, fe80::/10, IPv4-mapped IPv6, AAAA DNS rebinding, ReDoS-safe regex

9. **CloakBrowser engine** — `BROWSE_ENGINE=cloakbrowser` uses CloakBrowser's stealth Chromium with 48 C++ patches (canvas, WebGL, audio, fonts, GPU, WebRTC, etc.). Falls back to stock Playwright if unavailable.
10. **Fingerprint profiles** — `BROWSE_FINGERPRINT_SEED` or per-identity seeds in `~/.nightcrawl/identities/`. Deterministic fingerprints across all surfaces.
11. **Behavioral humanization** — `BROWSE_HUMANIZE=1` enables CloakBrowser's built-in Bezier mouse, typing jitter, non-linear scroll (Tier 4-5 sites only)

### Engine Selection
- `BROWSE_ENGINE=playwright` (default) — stock Playwright Chromium with CDP patches
- `BROWSE_ENGINE=cloakbrowser` — CloakBrowser stealth Chromium (skips CDP patches, uses 48 C++ patches instead)
- `BROWSE_FINGERPRINT_SEED=12345` — explicit fingerprint seed (10000-99999)
- `BROWSE_HUMANIZE=0|1` — behavioral humanization (CloakBrowser only)

### Stealth Limitation (Playwright engine)
CDP patches fix basic automation detection, but canvas/WebGL/audio fingerprinting and
behavioral analysis are NOT patched. Switch to `BROWSE_ENGINE=cloakbrowser` for full stealth.

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
- Auto-handover on by default — login walls auto-open headed Chrome (opt-out: `BROWSE_AUTO_HANDOVER=0`)
- Cookies auto-persisted after handoff/resume + every 5 min + on shutdown

## Key References

- PRD: docs/PRD.md (v0.2 — all product decisions)
- rebrowser-patches: github.com/rebrowser/rebrowser-patches
- CloakBrowser: github.com/CloakHQ/CloakBrowser (v0.2 integration target)
- Patchright: github.com/Kaliiiiiiiiii-Vinyzu/patchright
- Camoufox: github.com/Bin-Huang/camoufox-cli
- gstack: github.com/garrytan/gstack (foundation)
