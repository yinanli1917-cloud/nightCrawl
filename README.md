# nightCrawl

Your digital twin in the browser. It browses the web as you, in the background on your machine, and hands control to you when a page needs a human.

## What This Is

A local-first CLI browser that runs as your digital twin. It imports your real Arc/Chrome cookies and keeps your logged-in sessions, so it can use the sites you already have accounts for: research behind a login, a paywall you subscribe to, a tool you use every day. Stealth patches let sites treat it as your real browser, so pages that block automation still work. Everything stays on your machine. It handles about 95% on its own and hands control to you for the 5% only a human can resolve, like a login or a CAPTCHA. Not a cloud API, not a QA tool.

## Features

- **Looks like your real browser** -- CDP Runtime.Enable patch, consistent UA across JS + HTTP, AutomationControlled off, so sites treat it as you and not a bot
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
- CloakBrowser stealth Chromium (48 C++ fingerprint patches)

## Acknowledgments

nightCrawl stands on the shoulders of these open source projects. Thank you.

- [gstack](https://github.com/garrytan/gstack) by **Garry Tan** -- nightCrawl's browser engine is forked from gstack browse. Garry merged our stealth contributions upstream. We forked to pursue a different product direction: an autonomous digital-twin browser that acts as you across your logged-in web, rather than QA verification. Thank you, Garry.
- [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) -- CDP Runtime.Enable bypass that defeats Cloudflare, PerimeterX, and DataDome detection
- [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) -- Playwright stealth patching inspiration
- [Camoufox](https://github.com/Bin-Huang/camoufox-cli) -- C++ fingerprint spoofing research and roadmap inspiration
- [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) -- agent browser architecture research
- [bypass-paywalls-chrome](https://github.com/AstralWatcher/bypass-paywalls-chrome-clean) -- paywall bypass extension
- [Playwright](https://playwright.dev/) -- browser automation framework
- [Bun](https://bun.sh/) -- JavaScript runtime

## License

MIT
