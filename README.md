# nightCrawl

Autonomous stealth browser agent. Crawls the hostile web on its own, hands off to you when it needs a human touch.

## What This Is

A local-first, stateful CLI browser agent that operates on the hostile web -- anti-bot stealth, captcha solving, API reverse-engineering, cookie persistence. Not a cloud API, not a QA tool. An autonomous partner that handles 95% on its own, and seamlessly hands control to you for the 5% only a human can resolve.

## Features

- **Stealth-first** -- CDP Runtime.Enable bypass, consistent UA across JS + HTTP, AutomationControlled disabled
- **Cookie persistence** -- save/restore across sessions, import from Arc/Chrome
- **Autonomous by default, human handover by exception** -- runs headless, auto-detects login walls, switches to headed mode for human assist
- **Extension management** -- bypass-paywalls, nightCrawl sidepanel, controllable per-mode
- **Local-first** -- no cloud dependency, your machine, your data

## Setup

### Optional: bypass-paywalls extension

The paywall bypass extension is not bundled in this repo. To install it:

```bash
git clone https://github.com/AstralWatcher/bypass-paywalls-chrome-clean.git \
  stealth/extensions/bypass-paywalls-chrome
```

nightCrawl will detect and load it automatically when present.

## Tech Stack

- TypeScript / Bun
- Playwright (patched -- stealth as owned code)
- Chromium

## Acknowledgments

nightCrawl stands on the shoulders of these open source projects. Thank you.

- [gstack](https://github.com/garrytan/gstack) by **Garry Tan** -- nightCrawl's browser engine is forked from gstack browse. Garry merged our stealth contributions upstream. We forked to pursue a different product direction: autonomous hostile-web browsing rather than QA verification. Thank you, Garry.
- [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) -- CDP Runtime.Enable bypass that defeats Cloudflare, PerimeterX, and DataDome detection
- [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) -- Playwright stealth patching inspiration
- [Camoufox](https://github.com/Bin-Huang/camoufox-cli) -- C++ fingerprint spoofing research and roadmap inspiration
- [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) -- agent browser architecture research
- [bypass-paywalls-chrome](https://github.com/AstralWatcher/bypass-paywalls-chrome-clean) -- paywall bypass extension
- [Playwright](https://playwright.dev/) -- browser automation framework
- [Bun](https://bun.sh/) -- JavaScript runtime

## License

MIT
