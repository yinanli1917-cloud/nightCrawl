# nightCrawl PRD v0.1

> Your personal browser daemon — acts as you on the web, under your control, on your machine.

## Problem

AI agents can't operate on the real web. The "real web" means sites behind Cloudflare, paywalls, authentication, and anti-bot systems — where 95% of valuable information and actions live.

- OpenClaw's `web_fetch` returns Cloudflare challenge pages (issue #20375, closed as "not planned")
- Browser Use has no stealth, no cookie import, loses session state
- Cloud browsers (Browserbase, Hyperbrowser) run from datacenter IPs detectable in 50ms
- Einstein AI (Canvas homework agent) was shut down via cease-and-desist — wrapper over OpenClaw with no safety architecture

No existing tool combines: **local CLI + real browser cookies + stealth + persistent sessions + human handover + safety guardrails**.

## Solution

nightCrawl is a local-first CLI browser daemon that:
1. Imports your real authenticated sessions from Arc/Chrome/Brave/Edge
2. Navigates the hostile web with stealth patches (CDP fix, fingerprint spoofing)
3. Persists session state across runs
4. Hands control to you when it encounters something only a human can resolve
5. Classifies actions by risk and applies appropriate safety gates

## Users

### Primary: AI Agent Developers
People using Claude Code / OpenClaw / Cursor who need their agents to operate on authenticated, protected sites. They've hit the wall where `web_fetch` returns a Cloudflare challenge page and there's no fallback.

**Job to be done**: "I need my AI agent to access a site that requires login and blocks automation."

### Secondary: Students & Knowledge Workers
People automating repetitive workflows on authenticated platforms — Canvas assignments, university portals, paywalled research, enterprise dashboards.

**Job to be done**: "I waste hours doing repetitive browser tasks on sites I'm already logged into."

### Tertiary: Power Users & Data Practitioners
Researchers, journalists, quantitative analysts who need programmatic access to protected content — paywalled articles, financial data, government portals.

**Job to be done**: "I need to access data behind authentication and anti-bot systems, locally and privately."

## Core Capabilities

### 1. Authenticated Browsing (Cookie Import)
Import real browser cookies from 6 Chromium browsers (Arc, Chrome, Brave, Edge, Chromium, Comet). Decrypts AES-128-CBC encrypted cookies via macOS Keychain / Linux secret-tool. Includes 2FA/MFA session cookies — inherits the fully authenticated session.

```
nightcrawl auth --from arc --domain canvas.university.edu
nightcrawl auth --from chrome --domain github.com
```

### 2. Stealth Navigation
CDP Runtime.Enable bypass (rebrowser-patches), user agent normalization, and browser fingerprint management. Passes bot-detector.rebrowser.net, bot.sannysoft.com, creepjs.

Roadmap: CloakBrowser integration for C++ level fingerprint spoofing (canvas, WebGL, audio, fonts, GPU — 32 patches compiled into Chromium binary, 30/30 detection tests passed).

```
nightcrawl goto "https://protected-site.com/dashboard"
nightcrawl goto "https://paywalled-news.com/article" --stealth high
```

### 3. Page Interaction
Full Playwright action suite: navigate, read text/HTML/links, fill forms, click buttons, select dropdowns, type, upload files, execute JavaScript, intercept network requests.

```
nightcrawl text                          # extract page text
nightcrawl fill "#answer" "My response"  # fill form field
nightcrawl click "Submit"                # click button
nightcrawl screenshot                    # capture page state
nightcrawl eval "document.title"         # run JS
```

### 4. Persistent Sessions
Daemon architecture (inherited from gstack browse) — browser stays alive between commands. Cookies, localStorage, auth state persist. State save/load for resuming sessions across daemon restarts.

```
nightcrawl state save canvas-session
nightcrawl state load canvas-session     # next day, still logged in
```

### 5. Human Handover
When the agent encounters something it can't solve autonomously (visual captcha, unexpected MFA prompt, judgment call), it transitions from headless to headed mode. The user resolves the issue manually. The agent resumes headless operation.

```
nightcrawl goto "https://site-with-captcha.com"
# → "Captcha detected. Opening browser for human input..."
# → User solves captcha
# → "Resuming headless operation. Session authenticated."
```

### 6. Snapshot & Element Refs
ARIA-based accessibility tree snapshots with @ref element targeting. Agents use stable @e1, @e2 refs instead of fragile CSS selectors. Refs persist across navigations.

```
nightcrawl snapshot -i          # interactive elements only
nightcrawl click @e3            # click element by ref
nightcrawl fill @e7 "answer"   # fill by ref
```

## Safety Architecture

### Three-Tier Risk Model

Based on industry standard (Anthropic research: 73% of production agents use human-in-the-loop; NVIDIA OpenShell policy-based guardrails).

| Tier | Actions | Behavior |
|------|---------|----------|
| **Auto** | `text`, `screenshot`, `links`, `html`, `eval` (read-only JS), `snapshot` | Runs without asking |
| **Notify** | `fill`, `type`, `select`, `hover`, `scroll`, cookie import for non-sensitive domains | Runs and logs what it did |
| **Confirm** | `click` on submit/send/buy/delete buttons, cookie import for financial/government domains, any scheduled write action | Requires explicit `[y/N]` approval |

### Domain Risk Classification

Auto-detect sensitive domains. Not a blocklist — a friction layer.

| Category | Domains | Behavior |
|----------|---------|----------|
| Financial | `*.schwab.com`, `*.fidelity.com`, `*.bankofamerica.com`, `*.robinhood.com`, major banks/brokerages | Confirm tier for all write actions |
| Government | `*.gov`, `*.irs.gov`, `*.ssa.gov` | Confirm tier + session timeout |
| Email | `*.gmail.com`, `*.outlook.com` | Confirm tier for send actions |
| Normal | Everything else | Standard tier classification |

Users can reclassify domains: `nightcrawl config --classify canvas.edu=auto`

### Scope Declaration

Sessions can be scoped to specific domains:

```
nightcrawl session --scope canvas.edu,github.com
# This session can ONLY access these domains
# Attempts to navigate elsewhere are blocked
```

### Audit Log

Every action logged with timestamp, domain, action type, element, and result:

```
nightcrawl log
# 2026-04-03 14:22:01 | canvas.edu | goto /assignments | OK
# 2026-04-03 14:22:03 | canvas.edu | text | 1.2KB extracted
# 2026-04-03 14:22:05 | canvas.edu | fill #answer "..." | OK
# 2026-04-03 14:22:07 | canvas.edu | click "Submit" | CONFIRMED → OK
```

### Dry-Run Mode

```
nightcrawl --dry-run click "Submit Transfer"
# → Would click button "Submit Transfer" on schwab.com
# → Action type: CONFIRM (financial domain)
# → Not executed (dry-run mode)
```

### Scheduling Guardrails

Scheduled tasks can only replay pre-approved action sequences:

```
nightcrawl record canvas-check        # start recording
nightcrawl goto "https://canvas.edu/assignments"
nightcrawl text
nightcrawl record stop                # save sequence

nightcrawl schedule canvas-check --every "8am weekdays"
# → Replays recorded sequence on schedule
# → Read-only actions only (no write actions in schedule by default)
# → Write actions require --allow-writes flag + confirmation
```

## Positioning

### What nightCrawl Is
- A local CLI tool that gives you an authenticated, stealthy browser
- Your personal browser daemon — acts as you, under your control
- Open source (MIT) with optional premium features

### What nightCrawl Is NOT
- Not a cloud service (your data stays on your machine)
- Not a bot framework (it's YOU, authenticated, automated)
- Not unrestricted (safety guardrails by default, power users can opt out)
- Not a scraping API (it's a browser, not a data pipeline)

### Differentiation Sentence
> nightCrawl is the only local CLI that lets AI agents browse the hostile web — authenticated as you, with your real cookies, stealth patches, and safety guardrails — where every other tool gets blocked.

## Technical Architecture

```
┌─────────────────────────────────────────────────────┐
│                   nightcrawl CLI                      │
│  auth · goto · text · fill · click · snapshot · ...  │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP (localhost)
┌──────────────────────▼──────────────────────────────┐
│               nightcrawl daemon                       │
│  ┌─────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Safety   │  │ Session  │  │ Stealth Manager    │  │
│  │ Gate     │  │ Manager  │  │ (CDP patches,      │  │
│  │ (3-tier) │  │ (cookies,│  │  fingerprints,     │  │
│  │          │  │  state)  │  │  UA, extensions)   │  │
│  └────┬─────┘  └────┬─────┘  └────────┬───────────┘  │
│       └──────────────┼────────────────┘               │
│                      │                                │
│  ┌───────────────────▼──────────────────────────────┐│
│  │  Playwright (patched) + Chromium/CloakBrowser     ││
│  │  bypass-paywalls extension · cookie persistence   ││
│  └───────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────┘
```

### Foundation (inherited from gstack browse)
- Bun runtime, TypeScript
- HTTP daemon with CLI client
- Playwright browser management
- Snapshot/ref element targeting
- Cookie import from 6 browsers
- State save/load
- Headed/headless mode switching

### nightCrawl Original (to build)
- Safety gate (three-tier risk model)
- Domain risk classification
- Scope declaration
- Audit logging
- Stealth manager (profile selection per-domain)
- Human handover protocol (automatic captcha/MFA detection → headed transition)
- Scheduling with guardrails
- nightcrawl CLI wrapper (hostile-web-specific commands)

## v0.1 Scope (MVP)

### Must Have
1. `nightcrawl auth` — cookie import with domain scoping
2. `nightcrawl goto` — stealth navigation with CDP patches
3. `nightcrawl text/html/screenshot` — page reading
4. `nightcrawl fill/click/type` — page interaction
5. `nightcrawl snapshot` — element ref targeting
6. Three-tier safety gate (auto/notify/confirm)
7. Audit log
8. Domain risk classification (basic list)

### Should Have
9. `nightcrawl state save/load` — session persistence
10. `nightcrawl handover` — explicit headed mode transition
11. `nightcrawl --dry-run` — action preview
12. Scope declaration

### Could Have
13. Scheduled task recording and replay
14. CloakBrowser integration
15. MCP server wrapper
16. Automatic captcha detection → handover

### Won't Have (v0.1)
- Captcha solving (use human handover)
- Chinese internet support (WeChat, Zhihu)
- TLS/JA3 fingerprint masking
- Behavioral analysis evasion
- GUI / desktop app

## Open Source Strategy

- **Core CLI + daemon**: MIT license (maximum adoption)
- **Stealth patches**: MIT (contribution to the ecosystem)
- **Safety architecture**: MIT (raise the bar for all tools)
- **Premium (future)**: Managed fingerprint profiles, Turnstile solver, session pools, enterprise support

## Competitive Response Playbook

| If competitor does... | nightCrawl response |
|----------------------|---------------------|
| Browserbase adds local mode | They still can't import your real cookies or run from your IP |
| OpenClaw fixes web_fetch for Cloudflare | They still don't have cookie import, stealth patches, or session persistence |
| Browser Use adds stealth | They still don't have cookie import or human handover |
| CloakBrowser adds agent framework | Integrate CloakBrowser as nightCrawl's stealth engine (composition, not competition) |
| Someone clones nightCrawl | Safety architecture is the moat — easy to copy features, hard to copy trust |

## Success Metrics

### Adoption
- GitHub stars (target: 1K in first month)
- npm downloads / Homebrew installs
- linux.do thread engagement

### Usage
- Daily active sessions
- Domains accessed per session
- Human handover rate (lower = better stealth)

### Safety
- Confirm-tier actions approved vs. denied (measures if safety gates are calibrated right)
- Audit log adoption rate
- Zero security incidents in first 6 months

## References

- [Van Buren v. United States (2021)](https://www.congress.gov/crs-product/LSB10616) — CFAA narrow interpretation
- [Anthropic: Measuring Agent Autonomy](https://www.anthropic.com/research/measuring-agent-autonomy) — 73% human-in-the-loop
- [Einstein AI cease-and-desist](https://www.timeshighereducation.com/news/strange-case-einstein-ai-spotlights-chatbot-concerns) — cautionary tale
- [OpenClaw Cloudflare issue #20375](https://github.com/openclaw/openclaw/issues/20375) — "not planned"
- [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) — 32 C++ Chromium patches, potential integration
- [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) — CDP stealth foundation
