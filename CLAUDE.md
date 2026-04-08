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
| `stealth/patches/cdp/` | CDP Runtime.Enable bypass (6 Playwright files, ported from rebrowser-patches) |
| `stealth/extensions/` | Chrome extensions (bypass-paywalls, nightCrawl extension) |
| `research/` | Competitive landscape, anti-bot research |
| `docs/` | PRD, architecture docs, origin handoff |
| `docs/PRD.md` | Product Requirements Document (v0.2 — the source of truth) |
| `subtitles/` | Proof-of-concept artifacts (gitignored) |

## Stealth Architecture

### Current
1. **UA fix** — consistent User-Agent across JS + HTTP levels, removes HeadlessChrome, sets real viewport
2. **CDP Runtime.Enable fix** — auto-applied at startup from `stealth/patches/cdp/` (6 files, ported from rebrowser-patches)
3. **Extension management** — `BROWSE_EXTENSIONS=none|paywall|all` controls extension loading per mode
4. **Auto-handover** — detects login walls, opens headed Chrome, user logs in, auto-resumes headless (on by default, opt-out with `BROWSE_AUTO_HANDOVER=0`)
5. **bypass-paywalls-chrome** extension
6. **Cookie persistence** + import from Arc/Chrome (AES-128-CBC decrypt via Keychain)

### Stealth Limitation (v0.1)
CDP patches fix basic automation detection, but canvas/WebGL/audio fingerprinting and
behavioral analysis are NOT patched. Sites with aggressive anti-bot (Xiaohongshu, DataDome)
may still detect automation. CloakBrowser integration (v0.2) will fix this with 48 C++ patches.

### Roadmap (v0.2+)
- CloakBrowser integration (48 C++ patches: canvas, WebGL, audio, fonts, GPU, WebRTC)
- Multi-identity sessions (isolated browser profiles for risky platforms)
- Behavioral humanization (mouse curves, keyboard timing, scroll patterns)
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
