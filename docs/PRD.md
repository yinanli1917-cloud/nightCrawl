# nightCrawl PRD v0.2

> Your digital twin in the browser.

## Vision

Browser autopilot: automate all the drudge work that carries you from point A to point B,
and leave the real joy of browsing to you.

nightCrawl is a local CLI that runs in the background as your digital twin — it browses
the web as you, with your real cookies, your real IP, your real sessions. Everything stays
on your machine. Always.

## Problem

AI agents can't operate on the real web. The "real web" means sites behind Cloudflare,
paywalls, authentication, and anti-bot systems — where 95% of valuable information and
actions live.

- OpenClaw's `web_fetch` returns Cloudflare challenge pages ([#20375](https://github.com/openclaw/openclaw/issues/20375), closed "not planned")
- Browser Use: no stealth, no cookie import, loses session state ("awkward middle ground" — linux.do)
- Cloud browsers (Browserbase, Hyperbrowser): datacenter IPs detectable in 50ms
- Einstein AI (Canvas homework): [shut down via cease-and-desist](https://www.timeshighereducation.com/news/strange-case-einstein-ai-spotlights-chatbot-concerns) — no safety, no privacy

No existing tool combines: **local CLI + real browser cookies + stealth + persistent
sessions + human handover + proactive workflow detection**.

## Positioning

### What nightCrawl Is
- Your digital twin — browses as you, in the background, on your machine
- A local CLI tool, open source (MIT)
- Powerful AND safe by design

### What nightCrawl Is NOT
- Not a cloud service — your cookies, passwords, browsing data NEVER leave your machine
- Not a bot framework — it's you, authenticated, automated
- Not a scraping API — it's a browser, not a data pipeline

### Differentiation
> nightCrawl is your digital twin in the browser — it acts as you on the hostile web,
> with your real cookies, stealth patches, and persistent sessions, where every other
> tool gets blocked. Everything stays local.

### Privacy Promise (prominent in all UX)
**Your data never leaves your machine.** Cookies are decrypted locally from your browser's
SQLite database. Passwords are never read or stored. Session state lives in `~/.nightcrawl/`.
nightCrawl has no server, no analytics, no telemetry, no cloud. It's a local process on
your computer — like Vim or Git.

## Users

### Primary: AI Agent Developers
People using Claude Code / OpenClaw who hit the wall when `web_fetch` returns a Cloudflare
challenge page. They need a browser that works on authenticated, protected sites.

**Job**: "My AI agent needs to access a site that requires login and blocks automation."

### Secondary: Students & Knowledge Workers
People automating repetitive browser workflows — Canvas assignments, university portals,
paywalled research, enterprise dashboards, daily information gathering.

**Job**: "I waste hours doing the same browser tasks every day on sites I'm already logged into."

### Tertiary: Power Users & Data Practitioners
Researchers, journalists, quantitative analysts accessing protected content — paywalled
articles, financial data, government portals, social media feeds.

**Job**: "I need programmatic access to data behind authentication and anti-bot systems."

## Core Capabilities

### 1. Authenticated Browsing (Cookie Import)

Import real browser cookies from 6 Chromium browsers (Arc, Chrome, Brave, Edge, Chromium,
Comet). Decrypts AES-128-CBC cookies via macOS Keychain / Linux secret-tool. Includes
2FA/MFA session cookies — inherits the fully authenticated session.

```
nightcrawl auth canvas.university.edu        # import from default browser
nightcrawl auth --from chrome github.com     # specify browser
nightcrawl auth --all                        # full twin: import everything
```

### 2. Stealth Navigation

CDP Runtime.Enable bypass (rebrowser-patches), user agent normalization, bypass-paywalls
extension. Passes bot-detector.rebrowser.net, bot.sannysoft.com, creepjs.

```
nightcrawl goto "https://protected-site.com/dashboard"
```

**Stealth limitation (v0.1)**: CDP patches prevent basic automation detection, but advanced
fingerprinting (canvas, WebGL, audio) and behavioral analysis are NOT yet patched. Sites
with aggressive anti-bot (Xiaohongshu, DataDome max-security) may still detect automation.
See "Platform Warnings" below.

### 3. Page Interaction

Full action suite: navigate, read, fill, click, select, type, upload, execute JS,
intercept network, manage tabs.

```
nightcrawl text                          # page text
nightcrawl fill @e3 "My response"       # fill by element ref
nightcrawl click @e5                     # click by ref
nightcrawl screenshot /tmp/page.png      # capture
nightcrawl js "document.title"           # eval JS
```

### 4. Persistent Sessions

Daemon architecture — browser stays alive between commands (~100-200ms per command after
first launch). Cookies, localStorage, auth state persist. State save/load for resuming
across daemon restarts.

```
nightcrawl state save canvas-session
nightcrawl state load canvas-session     # next day, still logged in
```

### 5. Human Handover (working)

Auto-detects login walls and CAPTCHAs. Opens headed Chrome for user to resolve manually.
Auto-resumes headless when done. No manual commands needed.

### 6. Snapshot & Element Refs

ARIA-based accessibility tree with @ref targeting. Stable element references instead of
fragile CSS selectors.

```
nightcrawl snapshot -i          # interactive elements with @e refs
nightcrawl click @e3            # click by ref
nightcrawl snapshot -D          # diff: what changed?
```

### 7. X Feed & Daily Briefing

Browse X/Twitter as the user (with their real cookies and follow list), extract feed
content for AI summarization. Extends to any information source the user regularly checks.

```
nightcrawl auth x.com
nightcrawl goto "https://x.com/home"
nightcrawl text                          # agent summarizes → daily briefing
```

### 8. Cookie Export (Composable CLI)

Export cookies in standard formats so specialized tools can use nightCrawl's authenticated
sessions. nightCrawl handles auth and anti-bot; other tools handle extraction.

```
nightcrawl cookies --domain .youtube.com --format netscape > /tmp/yt-cookies.txt
yt-dlp --cookies /tmp/yt-cookies.txt --write-sub "https://youtube.com/watch?v=xyz"

nightcrawl cookies --domain .bilibili.com --format netscape > /tmp/bili-cookies.txt
yt-dlp --cookies /tmp/bili-cookies.txt "https://bilibili.com/video/BVxxx"
```

**Design principle: compose with existing tools, don't rebuild.** nightCrawl is a browser,
not a data pipeline. For video subtitles, use yt-dlp. For PDFs, use curl. For APIs, use
httpie. nightCrawl provides the authenticated session; specialized tools do the rest.

### 9. Proactive Workflow Detection

Analyzes the user's Chrome/Arc browsing history (local SQLite database, read-only) to
identify repetitive patterns and suggest automations.

**In onboarding** (fast, trust-building):
Shows top 5 most-visited domains. Proves capability without overwhelming.

**On demand** (full analysis):
```
nightcrawl suggest
> Analyzing browsing patterns...
>
> Found 3 automatable workflows:
>   1. Canvas assignment check (daily, ~2min manual)
>   2. X feed review (6x/day, ~5min each)
>   3. linux.do morning browse (daily, ~10min)
>
> Set up any of these? [1/2/3/skip]
```

**How it works**: Chrome/Arc's History database (SQLite) updates in real-time. nightCrawl
queries it on demand (not continuously), groups URLs by frequency and time-of-day, and
identifies repeating patterns. The history data never leaves the machine.

## Onboarding

Designed to build trust progressively. Fast, clear, no overwhelm.

```
$ nightcrawl init

  nightCrawl — your digital twin in the browser

  Everything stays on your machine.
  Cookies, passwords, browsing data — none of it ever leaves this computer.
  nightCrawl is a local process, like Git. No cloud, no server, no telemetry.

  Step 1: Browser
  Found: Arc, Chrome
  Which browser has your main sessions? → arc

  Step 2: Cookie Access
  nightCrawl can import your login sessions to act as you.
  How do you want to manage this?

  [1] Full twin — import all domains
      nightCrawl becomes you everywhere. You can revoke any domain later.
  [2] Ask per domain
      First time nightCrawl visits a new site, it asks once. Then remembers.
  [3] Manual only
      You decide each time with: nightcrawl auth <domain>

  → 2

  Step 3: Your Browsing Patterns
  nightCrawl can read your browsing history to suggest automations.

  Your most-visited sites:
    1. canvas.instructure.com  (284 visits/month)
    2. x.com                   (1,847 visits/month)
    3. github.com              (562 visits/month)
    4. linux.do                (203 visits/month)
    5. mail.google.com         (891 visits/month)

  Want nightCrawl to analyze your patterns and suggest automations?
  You can always do this later with: nightcrawl suggest
  [Y/n] → y

  Analyzing... found 3 automatable workflows.
  Run `nightcrawl suggest` to see them.

  Step 4: Ready
  Your digital twin is ready.
  Try: nightcrawl goto https://x.com/home
```

### Cookie Trust Model (SSH-style)

No iOS-style popups. No interruptions during work. Trust once, remember forever.

- **Full twin mode**: All domains trusted from the start. User can revoke with
  `nightcrawl revoke <domain>`.
- **Ask-per-domain mode**: First visit to a new authenticated domain asks once:
  `No cookies for canvas.edu. Import from Arc? [Y/n]`
  After "y", that domain is trusted forever. Stored in `~/.nightcrawl/trusted-domains`.
- **Manual mode**: User explicitly imports with `nightcrawl auth <domain>`.

No mode interrupts workflow after initial consent. Silent by default.

## Safety

### Platform Warnings

Some platforms aggressively detect automation and may ban accounts. nightCrawl warns
before first access to known high-risk platforms:

```
nightcrawl goto "https://xiaohongshu.com"
> ⚠ Xiaohongshu has aggressive anti-bot detection.
> Current stealth level may not prevent account flagging.
> Recommended: use a separate identity (nightcrawl identity create xhs)
> Continue with your real account? [y/N]
```

Known high-risk platforms (v0.1):
- Xiaohongshu (canvas/WebGL fingerprinting + behavioral analysis)
- WeChat articles (token-based, session-bound)
- LinkedIn (aggressive automation detection)
- Instagram (Meta's behavioral fingerprinting)

This warning appears once per platform. User can dismiss permanently.

### Audit Log

Every action logged silently. Reviewable on demand.

```
nightcrawl log
# 2026-04-05 14:22:01 | canvas.edu     | goto /assignments    | OK
# 2026-04-05 14:22:03 | canvas.edu     | text                 | 1.2KB
# 2026-04-05 14:22:05 | canvas.edu     | fill @e4 "..."       | OK
# 2026-04-05 14:22:07 | canvas.edu     | click "Submit"       | OK

nightcrawl log --domain x.com --today    # filter by domain/date
```

### Privacy Architecture

```
~/.nightcrawl/
├── config.json           # browser preference, cookie mode, settings
├── trusted-domains       # domains user has approved for cookie import
├── cookies/              # imported cookies (encrypted at rest)
├── state/                # saved browser states (named sessions)
├── identities/           # isolated browser profiles (multi-identity)
├── history-cache/        # analysis cache (derived from browser history)
└── log/                  # audit log (local only, never uploaded)
```

All data is local. No network calls except the browser itself navigating web pages.
No analytics. No telemetry. No crash reporting. The daemon listens only on localhost.

## Multi-Identity Sessions (v0.2)

Separate browser identities for different contexts. Protects your real account when
automating platforms with aggressive anti-bot detection.

```
nightcrawl identity create xhs-research    # isolated profile
nightcrawl identity use xhs-research       # switch to it
nightcrawl goto "https://xiaohongshu.com"  # safe: separate cookies, fingerprint
nightcrawl identity use default            # back to your real identity
nightcrawl identity list                   # see all identities
```

Each identity has:
- Its own cookie jar (isolated from your real browser)
- Its own browsing state
- Complete isolation from other identities
- When CloakBrowser integrates (v0.2): its own browser fingerprint

**Use cases**:
- Xiaohongshu research without risking your real account
- Separating work vs personal browsing contexts
- Testing how sites behave for new vs returning visitors
- Multiple accounts on the same platform

## Technical Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     nightcrawl CLI                           │
│  init · auth · goto · text · fill · click · suggest · log   │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP (localhost only)
┌────────────────────────▼────────────────────────────────────┐
│                   nightcrawl daemon                          │
│                                                              │
│  ┌──────────────┐  ┌─────────────┐  ┌───────────────────┐  │
│  │ Identity      │  │ Session     │  │ Stealth           │  │
│  │ Manager       │  │ Manager     │  │ Manager           │  │
│  │ (multi-       │  │ (cookies,   │  │ (CDP patches,     │  │
│  │  profile)     │  │  state,     │  │  UA, extensions,  │  │
│  │               │  │  trust DB)  │  │  platform warns)  │  │
│  └──────┬────────┘  └──────┬──────┘  └────────┬──────────┘  │
│         └──────────────────┼──────────────────┘              │
│                            │                                 │
│  ┌─────────────────────────▼───────────────────────────────┐│
│  │  Playwright (patched) + Chromium                         ││
│  │  CDP stealth · bypass-paywalls · cookie persistence      ││
│  └──────────────────────────────────────────────────────────┘│
│                                                              │
│  ┌──────────────────────────────────────────────────────────┐│
│  │  History Analyzer (read-only SQLite query on demand)      ││
│  │  Pattern detection · workflow suggestion · audit log      ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

### Foundation (inherited from gstack browse, working today)
- Bun runtime, TypeScript
- HTTP daemon with CLI client, persistent Chromium
- Playwright browser management, snapshot/ref targeting
- Cookie import + decryption from 6 browsers
- State save/load, headed/headless switching
- Auto-handover on login walls
- bypass-paywalls extension
- CDP stealth patches (rebrowser-patches port)

### nightCrawl Original (to build for v0.1)
- `nightcrawl` CLI binary (thin wrapper, own identity)
- `nightcrawl init` (onboarding flow)
- `nightcrawl auth` (SSH-style cookie trust model)
- `nightcrawl suggest` (browsing history analysis + pattern detection)
- Platform warning system (Xiaohongshu, LinkedIn, etc.)
- Audit log
- `~/.nightcrawl/` state directory
- Updated SKILL.md for Claude Code distribution

## Roadmap

### v0.1 — The Digital Twin (weeks 1-3)
- `nightcrawl` CLI binary
- `nightcrawl init` onboarding (browser, cookies, privacy message, pattern preview)
- `nightcrawl auth` with SSH-style trust model (3 modes)
- `nightcrawl suggest` — browsing history pattern detection + workflow suggestions
- All browse commands (goto, text, fill, click, snapshot, screenshot, tabs, state)
- Stealth (CDP patches, UA fix, bypass-paywalls)
- Human handover (already working)
- Platform warnings (Xiaohongshu, LinkedIn, etc.)
- Audit log (silent, reviewable)
- X feed browsing (daily briefing scenario)
- `nightcrawl cookies` — export cookies in Netscape format for yt-dlp, curl, wget
- Updated SKILL.md for Claude Code
- `~/.nightcrawl/` state directory with privacy architecture

### v0.2 — The Smart Twin (months 2-3)
- Multi-identity sessions (isolated browser profiles)
- CloakBrowser integration (48 C++ patches — fingerprint spoofing)
- Behavioral humanization (mouse curves, keyboard timing, scroll patterns)
- Proactive workflow detection from session replay (audit log patterns)
- MCP server wrapper (if demand from non-Claude-Code users)
- Chinese internet support via separate identities (Xiaohongshu, Zhihu)

### v0.3 — The Autonomous Twin (months 4+)
- Scheduled workflows (via Claude Code /schedule integration)
- Recorded action sequences (record → replay)
- Session replay pattern detection (audit log analysis)
- Multi-browser sync (import from Arc AND Chrome simultaneously)
- Self-reinforcing meta skill — nightCrawl skill evolves itself by dispatching subagents
  in worktrees to resolve failures, staying in the loop until issues are fixed
- Beautiful landing page with scenario demos (stock trading, Canvas, tax filing,
  customer service, court documents — all the scenarios that show imaginative power)
- Daily briefing as first-class feature (X, news, forums, customizable)
- UI exploration: lightweight status indicator (Dynamic Island style?) for background tasks

## GitHub README

The README should showcase imaginative scenarios — not just feature lists. Don't wait for
the landing page; the README IS the first impression. Scenarios to brainstorm and write
before launch (not now — when we're closer to shipping):

- Stock portfolio monitoring
- Canvas assignment automation
- Tax filing assistance
- Customer service navigation
- Court document retrieval (裁判文书)
- Daily X/news briefing
- Paywalled research access
- Enterprise dashboard automation
- Video subtitle extraction (via yt-dlp composition)

Each scenario: one paragraph + one code snippet. Show the power, not the plumbing.

## Open Source Strategy

- **Everything**: MIT license
- **Premium (future, if demand)**: managed fingerprint profiles, Turnstile solver,
  enterprise support, identity pool management

## Legal Foundation

- [Van Buren v. United States (2021)](https://www.congress.gov/crs-product/LSB10616): automating your own authenticated sessions is not a CFAA violation
- ToS violations are breach of contract (civil), not criminal. Worst case: account suspension.
- Open-source MIT license: standard no-warranty, no-liability protection
- [SEC/FINRA algorithmic trading rules](https://daytraderbusiness.com/regulations/sec-finra/sec-finra-rules-on-automated-trading-and-algorithms/) apply to broker-dealers, not retail users

## References

- [OpenClaw Cloudflare issue #20375](https://github.com/openclaw/openclaw/issues/20375) — "not planned"
- [ClawJacked vulnerability](https://www.oasis.security/blog/openclaw-vulnerability) — browser relay session hijacking
- [Einstein AI cease-and-desist](https://www.timeshighereducation.com/news/strange-case-einstein-ai-spotlights-chatbot-concerns)
- [Anthropic: Measuring Agent Autonomy](https://www.anthropic.com/research/measuring-agent-autonomy) — 73% use human-in-the-loop
- [$45M crypto breach via AI trading agents](https://www.kucoin.com/blog/en-ai-trading-agent-vulnerability-2026-how-a-45m-crypto-security-breach-exposed-protocol-risks)
- [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) — 48 C++ Chromium patches, potential v0.2 integration
- [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) — CDP stealth foundation
- [Browser Use CLI](https://linux.do/t/topic/1805601) — linux.do reception
- [knil's browser-cli](https://linux.do/t/topic/1744692) — developer building exactly what we're building
- [Xiaohongshu scraping tools](https://github.com/jackwener/xiaohongshu-cli) — reverse-engineered API approach

## Appendix: Original Brainstorm Notes (Apple Notes, 2026-04-05)

Preserved verbatim. These are the founder's original ideas that shaped this PRD. Each item
is annotated with where it landed in the product.

```
nightCrawl

加上国内的反爬（微信公众号、知乎、小红鼠等，分阶梯）
→ v0.2: Chinese internet via multi-identity sessions

youtube b站视频搜索，需要接入metaso吗
→ Replaced: cookie export + yt-dlp composition (don't rebuild, compose)

探索接入grok mcp用api整合？（尽可能不要有让用户配置和额外付费的东西）
→ Deferred: nightCrawl browses, doesn't search. Grok/search are separate tools.
  Design principle: no extra config, no extra cost for users.

提炼X信息 https://linux.do/t/topic/1365022
→ v0.1: X feed browsing + daily briefing scenario

调研到底claude cowork或通用agent那些可以同类实现吗，核心优势是什么
（后台进程不和你抢电脑+以你的身份浏览，如何放大这个优势？）
→ Core positioning: "background process that acts as you"
  Researched: OpenClaw can't bypass Cloudflare, Browser Use is stateless,
  Claude CUA steals your screen. nightCrawl runs silently in background.

初始化onboardding，包含了文件夹路径什（或者更多需要考虑的），
cookie项给几个选项（类似iOS问定位地址，按需导入还是全部导入，如何说服用户安全放心）
→ v0.1: Onboarding with 3 cookie modes (full twin / ask-per-domain / manual)
  Evolved from iOS-style to SSH-style (trust once, no annoying popups)

内嵌bypass paywall（UA标识为Google fetcher？）
→ Working: bypass-paywalls-chrome extension loaded by default

最终的呈现形式是skill还是单独的CLI，要如何面向最大多数的用户
→ Both: Skill = distribution (Claude Code users), CLI = product (developers)

是否要有UI，前台灵动岛吗
→ v0.3: UI exploration (Dynamic Island style status indicator)

是否变成proactive的可以识别用户浏览器导出的信息并识别反反复复的工作流并自动流程化的
→ v0.1: `nightcrawl suggest` — browsing history analysis + pattern detection
  Shows top 5 sites in onboarding, full analysis on demand

法律和合规问题
→ Researched: Van Buren v. US (legal), ToS = civil not criminal,
  MIT license protects author. Einstein AI cautionary tale documented.

一个美丽的landing page展示所有极具想象力的场景
（股票交易、canvas作业、报税、和客服斗智斗勇、裁判文书等等，仍需要脑暴）
→ v0.3: Landing page with scenario demos

浏览器的自动驾驶：把所有将人从一个地方送到另一个地方的枯燥工作自动化，
剩下的都是行驶browse的本真乐趣（我热爱GUI，把上帝遗落的空地留给它）
→ Vision statement: "Browser autopilot: automate all the drudge work,
  leave the real joy of browsing to you."

你在浏览器里的数字分身
→ Primary positioning: "Your digital twin in the browser"

meta browse skill, self reinforcing and evolving, ask subagents using worktree
to resolve problems, and staying in the loop until the issues fixed
→ v0.3: Self-reinforcing meta skill with worktree subagents
```

### Related Note: "OpenClaw is NOT an Agent OS Prototype" (2026-03-21)

```
openclaw并非agent os的雏形

没有建立秩序，skill和memory等等harness engineering的东西
没有os化没有直接让用户清晰自信地管理
（但这些逻辑到底是工程问题还是交互障碍）

→ Informs nightCrawl's design: clear state management (~/.nightcrawl/),
  explicit user control (trust model, identity management, audit log),
  not an OS — a tool you own and understand.
```
