# nightCrawl

Autonomous stealth browser agent. Crawls the hostile web on its own, hands off to you when it needs a human touch.

## What This Is

A local-first, stateful CLI browser agent that operates on the hostile web — anti-bot stealth, captcha solving, API reverse-engineering, cookie persistence. Not a cloud API, not a QA tool. An autonomous partner that handles 95% on its own, and seamlessly hands control to you for the 5% only a human can resolve (a click, a visual captcha, a judgment call).

## Competitive Position

No existing tool combines: **local stateful CLI + anti-bot stealth + cookie import from real browsers + network interception + JS eval + human handover**.

| Competitor | What it lacks |
|-----------|---------------|
| Vercel agent-browser | No stealth |
| Camoufox CLI | No network interception, Firefox-based |
| Cloud platforms (Browserbase, Anchor, Hyperbrowser) | Not local, API-only |
| gstack browse | QA tool for your own sites, not hostile web |

## Tech Stack

- TypeScript / Bun
- Playwright (patched — stealth as owned code, not dependency patches)
- Chromium (with C++ fingerprint spoofing roadmap)

## Directory Structure

| Path | Purpose |
|------|---------|
| `stealth/` | Anti-bot stealth layer — the actual working code |
| `stealth/browser/` | Complete working browser engine (full source + tests) |
| `stealth/patches/cdp/` | CDP Runtime.Enable bypass (6 Playwright files, ported from rebrowser-patches) |
| `stealth/extensions/` | Chrome extensions (bypass-paywalls, nightCrawl extension) |
| `research/` | Competitive landscape, anti-bot research |
| `docs/` | Architecture docs, origin handoff |
| `subtitles/` | Proof-of-concept artifacts (gitignored) |

## Stealth Architecture

### Current
1. **UA fix** — consistent User-Agent across JS + HTTP levels, removes HeadlessChrome, sets real viewport
2. **CDP Runtime.Enable fix** — auto-applied at startup from `stealth/patches/cdp/` (6 files, ported from rebrowser-patches)
3. **Extension management** — `BROWSE_EXTENSIONS=none|paywall|all` controls extension loading per mode
4. **Auto-handover** — detects login walls, opens headed Chrome, user logs in, auto-resumes headless (on by default, opt-out with `BROWSE_AUTO_HANDOVER=0`)
5. **bypass-paywalls-chrome** extension
6. **Cookie persistence** + import from Arc/Chrome

### Roadmap
- C++ fingerprint spoofing (canvas, WebGL, audio context, fonts) — from Camoufox research
- TLS/JA3 fingerprint masking
- HTTP/2 frame ordering normalization
- Behavioral analysis evasion (mouse, scroll, timing)
- Cloudflare Turnstile v2 solver
- Chinese internet anti-scraping tiers (WeChat, Zhihu, Xiaohongshu)

## Key Design Principles

1. **Stealth is first-class code** — no patching dependencies in cache directories
2. **Autonomous by default, human handover by exception** — agent runs headless, pops headed mode only when stuck
3. **Stateful sessions** — cookies, localStorage, auth state persist across runs
4. **Local-first** — no cloud dependency, your machine, your data

## Conventions

- Bun runtime: `export PATH="$HOME/.bun/bin:$PATH"`
- State directory: `.nightcrawl/` (per-project), `~/.nightcrawl/` (global cookies)
- All anti-bot patches must pass: bot-detector.rebrowser.net, bot.sannysoft.com, creepjs
- `BROWSE_EXTENSIONS=none|paywall|all` — control extension loading (default: `all`)
- Auto-handover on by default — login walls auto-open headed Chrome (opt-out: `BROWSE_AUTO_HANDOVER=0`)
- Cookies auto-persisted after handoff/resume + every 5 min + on shutdown

## Key References

- rebrowser-patches: github.com/rebrowser/rebrowser-patches
- Patchright: github.com/Kaliiiiiiiiii-Vinyzu/patchright
- Camoufox: github.com/Bin-Huang/camoufox-cli
- Vercel agent-browser: github.com/vercel-labs/agent-browser
- gstack: github.com/garrytan/gstack
