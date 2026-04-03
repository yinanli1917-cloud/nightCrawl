# HANDOFF — 2026-04-03

## 当前任务
Plan and bootstrap an **independent stealth browser project** — forking gstack browse's CLI architecture into a standalone product that can operate on the hostile web (not just QA your own sites). This is a new project, separate from naTure.

## 完成状态
- ✅ Full competitive landscape research (agent-browser, camoufox-cli, browserbase, etc.)
- ✅ Confirmed gstack browse (official v0.15.1.0) is a QA verifier, not a general-purpose web agent
- ✅ Verified our patched version is unique: local CLI + stateful session + production stealth
- ✅ Retrieved user's Apple Notes ideas for the browser project
- ✅ Cataloged current anti-bot patches (UA fix + CDP Runtime.Enable disable)
- ✅ End-to-end proof: navigated fmhy.net → searched subtitle sites → reverse-engineered SubHD API → solved SVG captcha → downloaded 53-episode subtitle pack
- 🔄 Architecture planning for the independent project (not started)
- ⏳ C++ fingerprint integration design (from Camoufox research)
- ⏳ Cloudflare Turnstile v2 / JA3 / HTTP/2 fingerprint bypass research
- ⏳ Chinese internet anti-scraping tiers (WeChat/Zhihu/Xiaohongshu)

## 关键决策

### 1. The project must be independent from gstack
gstack browse = QA tool (snapshot → click → diff → assert for YOUR sites). What we built = browser agent that reverse-engineers APIs, solves captchas, bypasses anti-bot, and acquires data from the hostile web. Different product category entirely.

### 2. Competitive positioning confirmed
No existing tool combines: **local stateful CLI + anti-bot stealth + cookie import from real browsers + network interception + JS eval**. Closest:
- **Vercel agent-browser** (github.com/vercel-labs/agent-browser): CLI + network, NO stealth
- **Camoufox CLI** (github.com/Bin-Huang/camoufox-cli): CLI + C++ stealth, NO network interception, Firefox-based
- **Cloud platforms** (Browserbase $40M, Anchor $6M, Hyperbrowser YC): stealth but API-only, not local

### 3. Current patches are fragile — must own the stealth layer
UA fix and CDP patches live in Bun's cache — overwritten on any Playwright update. The independent project must own its stealth as first-class code, not patch a dependency.

## User's feature ideas (Apple Notes: "gstack/browse")
1. **国内反爬分阶梯** — WeChat articles (微信公众号), Zhihu (知乎), Xiaohongshu (小红书), tiered strategies
2. **YouTube/B站视频搜索** — integrate with metaso, auto-search video content
3. **接入 Grok MCP** — Grok API for real-time X/discussion search
4. **探索 L站**
5. **Meta browse skill** — self-reinforcing, self-evolving; subagents in worktrees resolve problems autonomously, stay in loop until fixed

## Technical inputs for architecture

### Current stealth stack (to migrate/upgrade)
- Patch 1: UA fix in `~/.gstack/browse/src/browser-manager.ts` L87-92 (removes HeadlessChrome)
- Patch 2: CDP `Runtime.Enable` disable — 6 files in `~/.bun/install/cache/playwright-core@1.58.2@@@1/lib/server/` (ported from rebrowser-patches github.com/rebrowser/rebrowser-patches)
- Bypass-paywalls-chrome extension via `BROWSE_EXTENSIONS_DIR`
- Cookie persistence at `~/.gstack/browse-cookies.json`
- Cookie import from Arc/Chrome browsers

### C++ fingerprint approach (from Camoufox research)
Camoufox achieves **0% headless detection** by spoofing at C++ level: canvas, WebGL, audio context, screen metrics, fonts. Deeper than CDP patches. Key question: can this be ported to Chromium, or does it require Firefox's architecture? Original maintainer (daijro) inactive since Mar 2025.

### Cloudflare new anti-scraper vectors (NEEDS DEEP RESEARCH)
Cloudflare has evolved beyond CDP detection:
- **TLS/JA3 fingerprinting** — TLS handshake signature identifies Playwright/Puppeteer
- **HTTP/2 frame ordering** — browser engines have distinct frame ordering patterns
- **Behavioral analysis** — mouse movements, scroll patterns, timing
- **Turnstile v2** — enhanced challenge harder to solve programmatically
User said "the Cloudflare stuff is in our conversation history" — this was discussed in a previous session, check memory and recent conversations.

### Official gstack browse features worth keeping
- `snapshot -i` with `@ref` targeting (better than raw JS queries)
- `snapshot -D` for diffs
- `chain` for multi-step flows
- `inspect` / `style` / `cleanup` / `prettyscreenshot` (new in v0.15.1.0)
- `connect` / `handoff` for headed mode

## Proof of capability (today's SubHD workflow)
Navigate fmhy.net → extract subtitle section via JS → search ASSRT (2.assrt.net) + SubHD → cross-reference Google to verify 破烂熊字幕组 didn't subtitle Silicon Valley → reverse-engineer SubHD's download API (inspected `<button>` attributes, read JS source, found POST `/api/sub/down` endpoint) → render SVG captcha in-browser → screenshot at 600x200 → visually read "Mj7m" → submit via `fetch()` → get download URL → `curl` 1.5MB zip → extract 53 ASS subtitle files across 6 seasons. **No other single tool can do this.**

## 已知问题 / 注意事项
- `subtitles/` directory in naTure has the downloaded subs — don't commit (large + not project code)
- gstack skill is v1.1.0 locally, repo is v0.15.1.0 — update with `cd ~/.claude/skills/gstack && git pull` (re-apply stealth patches after)
- `$B click` fails on JS `<button>` elements with `fetch()` handlers — use `$B js` with direct `fetch()` calls
- SubHD captcha is session-bound — must render and submit in the same browser session
- ASSRT's file CDN (`file0.assrt.net`) doesn't resolve from US — DNS issue or GFW

## 下一步行动
1. **Create new project directory** — separate repo, not inside naTure
2. **Deep research Cloudflare Turnstile v2 + JA3 + HTTP/2 fingerprinting** — understand the full threat model
3. **Architecture doc** — stealth as owned code (not patching deps), C++ fingerprint integration, Chinese internet tiers, self-evolving meta-skill
4. **Bootstrap the CLI** — fork gstack browse's CLI interface (stateful session, command set) into own codebase
5. **First milestone** — pass all bot detection sites: bot-detector.rebrowser.net, bot.sannysoft.com, creepjs

## Key references
- Vercel agent-browser: github.com/vercel-labs/agent-browser
- Camoufox CLI: github.com/Bin-Huang/camoufox-cli
- Patchright: github.com/Kaliiiiiiiiii-Vinyzu/patchright (patched Playwright fork)
- rebrowser-patches: github.com/rebrowser/rebrowser-patches (source of our CDP patches)
- gstack official: github.com/garrytan/gstack (v0.15.1.0, 31 skills)
- Stealth guide: o-mega.ai/articles/stealth-for-ai-browser-agents-the-ultimate-2026-guide
- Memory file: `reference_antibot_bypass.md` — full patch details + per-site results

---
*Created by Claude Code · 2026-04-03T03:00+08:00*
