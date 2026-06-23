# Kimi WebBridge vs nightCrawl Final Review

Date: 2026-05-20

Scope: architectural, technical, UX, safety, reliability, and product-roadmap
comparison between Kimi WebBridge and nightCrawl, based on official Kimi docs,
installed local testing, UW/Canvas/UW Libraries runs, official showcase
equivalents, and nightCrawl roadmap/spec archaeology.

External sources:

- Kimi WebBridge feature page: https://www.kimi.com/features/webbridge
- Kimi WebBridge mechanism docs: https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-how-it-works
- Kimi WebBridge FAQ: https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-faq

Internal evidence:

- `research/kimi-webbridge-reliability-diagnosis-2026-05-20.md`
- `artifacts/kimi-real-capability-after-cleanup/kimi-post-cleanup-analysis-2026-05-20.md`
- `artifacts/official-showcase-benchmark/official-showcase-comparison-2026-05-20.md`
- `artifacts/uw-side-by-side-benchmark/uw-real-user-comparison-2026-05-20.md`
- `docs/PRD.md`
- `docs/product-notes/agent-centric-roadmap.md`
- `docs/product-notes/running-todo-cn.md`
- `.codex/spec/project/real-browser-bridge.md`

## Executive Verdict

Kimi WebBridge is a serious competitor because it solves the most emotionally
obvious UX problem: the agent can use the user's already logged-in, visible,
real Chrome or Edge browser. That is especially strong for Canvas, UW, Google,
enterprise SSO, password-manager flows, device-trust checks, and
fingerprint-pinned systems. Users can see tabs move and can believe the agent
is acting inside their existing identity surface.

nightCrawl is stronger as a controlled automation substrate: isolated local
daemon, owned browser engine, persistent state, scoped tokens, domain consent,
hostile-domain rules, stealth/fingerprint work, and repeatable benchmarkability.
It is better for background tasks, repeatable extraction, safety boundaries,
and local-first privacy. It is weaker today in the visible "use my actual tab"
experience that Kimi showcases.

The right response is not to replace nightCrawl's headless/CloakBrowser model.
The right response is a two-mode product:

1. Default: isolated nightCrawl/CloakBrowser for repeatable, safe, background,
   auditable work.
2. Opt-in: real-browser bridge for identity-pinned work where the user's live
   Chrome/Arc/Edge profile is the asset.

Kimi's local failures in our run are not proof that the product is immature.
They are evidence that real-browser bridge reliability is hard: extension
lifecycle, daemon-extension reconnects, tab/session rebinding, extension
conflicts, and local API recovery must be first-class engineering problems.

## What Kimi Actually Is

Official Kimi docs describe WebBridge as:

- a local bridge service running on the user's computer;
- a browser extension in Chrome or Edge;
- browser actions executed through Chrome DevTools Protocol;
- commands such as navigation, clicking, form filling, screenshots, extraction,
  and login-session reuse;
- local execution, where the browser login state remains on the user's device.

So "it does not occupy the computer" should not be read as "it does not use the
computer." It absolutely uses the local computer, local Chrome/Edge profile,
local daemon, local extension, and local CDP channel. The better interpretation
is:

- it does not require a remote cloud browser;
- it does not require exporting cookies to a server;
- it can avoid stealing OS focus when it dispatches browser-level commands
  through the extension/CDP path;
- it may still visibly open tabs/windows because it is operating the real
  browser.

Kimi can control the default browser only when that browser is supported and
has the extension/bridge connected. Official docs currently name Chrome and
Edge. Arc is Chromium-based, but Kimi's public support matrix does not list Arc
as a supported target. That is a product-support constraint, not a statement
that Arc is technically impossible.

## What We Measured

Installed Kimi state:

- daemon version: `v1.9.7`
- extension version: `1.9.7`
- extension id: `fldmhceldgbpfpkbgopacenieobmligc`
- current health at final review time: daemon running, extension connected

Before Chrome profile cleanup, Kimi often opened pages but failed on
`snapshot`, `evaluate`, `screenshot`, and `click`. Kimi's own FAQ says this
failure shape commonly points to extension conflicts, especially with scraper,
screen-recording, helper, and AI-assistant extensions. The old Chrome profile
had high-risk extensions with broad permissions, including debugger/all-URL
automation surfaces.

After the user cleared the Chrome profile, the short-path health improved
dramatically:

- `example.com` navigation/evaluate/snapshot worked in milliseconds in the
  quick probe.
- A repeated local sample showed that successful Kimi trials were fast and
  could produce browser-level trusted click behavior through CDP input.

But multi-step reliability was still unstable:

- daemon/extension WebSocket reconnects repeated roughly every five seconds;
- commands spanning a reconnect often lost session/tab ownership;
- visible tabs remained in Chrome while the local API reported no tab;
- `find_tab` sometimes failed to recover visible tabs;
- long tasks timed out or returned stale-session errors.

This gives the precise diagnosis:

Kimi has strong action primitives and excellent identity leverage when the
bridge stays connected. In this environment, its session/transport layer was
not stable enough for long, multi-step tasks.

## Why Kimi Sometimes Fails

Kimi's failure modes are understandable from its architecture.

### 1. Extension conflicts are part of the real-browser bargain

Kimi's advantage is using the user's actual browser. That means it also inherits
the user's actual extension stack. Extensions that hook debugger, scripting,
network, screen capture, native messaging, or all-URL access can interfere with
snapshot/evaluate/click. Kimi's FAQ explicitly names extension conflicts as a
common cause when pages open but tools fail.

After profile cleanup, Kimi improved. That is strong evidence that the original
brokenness was at least partly configuration/profile related.

### 2. MV3/extension lifecycle and bridge reconnects can break long commands

Our logs showed repeated extension disconnect/reconnect loops with
`context canceled` messages. When navigation or extraction lasted longer than
the stable connection window, the session frequently lost its tab.

I am not claiming MV3 service-worker lifecycle is the only root cause. The
measured fact is reconnect churn. The architectural risk is that extension
lifecycle, WebSocket ownership, and local session maps must survive reconnects.

### 3. Raw tab id is not enough as a session handle

The browser visibly had UW/Kimi-created tabs, but the bridge could not always
find or rebind them. That points to a session model keyed too tightly to a
transient tab/session association. Robust bridge mode needs tab id plus URL,
title, window/group identity, creation metadata, active-tab fallback, and last
task state.

### 4. Navigation waiting semantics can amplify failures

If `navigate` waits for a full load condition on complex sites, a reconnect
during that wait can turn an otherwise successful visible tab open into a
timeout. The agent sees failure; the user sees a tab. This mismatch is bad UX.

### 5. The raw local API may understate Kimi Desktop's full orchestration

Our tests used the local WebBridge API from Codex. Kimi Desktop/Kimi Agent may
add retries, active-tab repair, instruction planning, and better recovery above
the raw bridge. So the result should be read as a benchmark of the local bridge
path available to external agents, not as a complete measure of every Kimi app
workflow.

## Side-by-Side Results

### Official showcase equivalents

Kimi official examples include Google Sheets, cross-site search, workflow to
skill, e-commerce price comparison, information research, form filling, and data
entry. We mapped those to safe read-only tasks.

| Case | Kimi result | nightCrawl result |
|---|---|---|
| Shopping comparison | Timed out during Amazon navigation in this run | Loaded Amazon, extracted result cards |
| Cross-site research | Kimi help page opened, extraction failed with local bridge error | Loaded and extracted Kimi help feature content |
| Job listings | YC Jobs navigation timed out | Loaded and extracted relevant links |
| Google Sheets readiness | Opened Sheets, extraction failed with bridge error | Loaded Sheets workspace and redacted sensitive file names |

Interpretation: Kimi's successful opens were fast, but the bridge often lost
the page before extraction. nightCrawl was slower but finished the read-only
task equivalents.

### UW/Canvas/UW Libraries real-user task

| Area | Kimi | nightCrawl |
|---|---|---|
| Canvas auth | Passed after attach/retry; used real Chrome logged-in session | Passed in headless state |
| UW Libraries homepage | Loaded after daemon restart | Loaded |
| UW Libraries search | Not completed end-to-end; session binding lost | Completed through direct Discovery URL fallback |
| Reference extraction | Not completed through Kimi | Extracted 3 references |
| Main strength | Real visible authenticated browser | End-to-end workflow completion |
| Main weakness | Session/tab binding instability | UI ref targeting needed fallback |

This is the most important benchmark. Kimi's product thesis is real: it used the
user's live Canvas identity. But nightCrawl completed the broader reference
workflow.

### Local input boundary

Kimi's installed extension exposes stronger primitives than the first public
skill table implied:

- DOM `click`/`fill` path;
- CDP mouse input through `Input.dispatchMouseEvent`;
- CDP text/key input through `Input.insertText` and `Input.dispatchKeyEvent`.

In targeted local tests, Kimi's CDP mouse path produced trusted click behavior.
That is a real technical strength. Benchmarking only DOM click would be unfair.

## Full Product Comparison

| Dimension | Kimi WebBridge | nightCrawl | Current judgment |
|---|---|---|---|
| Control model | Extension plus local daemon controlling real Chrome/Edge through CDP | Local CLI/daemon controlling managed CloakBrowser/Chromium profile | Different strengths; both valid |
| Identity | Uses real browser profile and existing login state | Imports/persists cookies into a managed profile; handoff for hard login | Kimi wins for identity continuity |
| User visibility | User can see the real browser move | Headless/background by default; headed handoff only | Kimi wins visible trust today |
| Non-disruption | Can clutter or mutate the user's real browser tabs | Background profile avoids user workspace | nightCrawl wins default non-disruption |
| Stealth | Real Chrome/Edge baseline; specific hardening unknown | CloakBrowser, CDP patches, persistent fingerprint seed, pinned-domain handling | Need empirical hostile-site suite |
| Fingerprint-pinned SSO | Strong because it is the same browser/profile | Good but not literally the user's daily browser | Kimi has the cleaner UX |
| Repeatability | Depends on live user browser state/extensions/tabs | Controlled daemon/profile/state, easier to reset | nightCrawl wins repeatability |
| Action primitives | DOM plus stronger CDP input in installed extension | Broad CLI action suite; should add explicit CDP input tiers | Kimi currently showed a real CDP input win |
| Session recovery | Observed weak under reconnect/stale tab | Existing persistent daemon; bridge mode still to build | nightCrawl should design this before shipping bridge |
| Safety model | Public docs emphasize local execution; scoped policy not visible | Scoped tokens, domain consent, sensitive-page gates, hostile domains | nightCrawl stronger by architecture |
| Local endpoint security | Observed local command surface needs scrutiny; WS has origin checks, HTTP auth unclear in tests | Token-scoped local daemon model | nightCrawl should keep local auth as a moat |
| Telemetry/privacy | Official docs say local; observed telemetry endpoint exists but no page content seen | No analytics/telemetry in PRD promise | nightCrawl has clearer privacy story |
| UX transparency | Visible tabs are intuitive, but stale-session state was opaque | Headless is less intuitive; logs/status need product surface | Kimi wins first impression; nightCrawl can surpass with status UI |
| Benchmarkability | Live profile makes reproducibility harder | Designed for controlled local runs | nightCrawl wins benchmark harness fit |
| Extensibility | Supports multiple local agents by command bridge | CLI/skill model, possible MCP wrapper | Comparable; nightCrawl needs productized docs |
| Complex workflows | Strong when identity is the main blocker; weak in our long-task reliability | Completed more read-only multi-step tasks in tests | nightCrawl won measured completion; Kimi still a threat |

## Proposed Features We Found But Have Not Pushed Far Enough

The project already contains many strong ideas that remain unfinished or only
partially productized.

### Already built or substantially present

- real cookie import from major browsers;
- persistent daemon and command suite;
- scoped token system;
- auto-handover and per-domain handoff consent;
- sensitive-page checks;
- hostile-domain blocklist;
- CloakBrowser integration path and fingerprint seed persistence;
- fingerprint-pinned domain classifier;
- extension management;
- state save/load;
- watch/passive-observation command surface exists, but not as a complete
  product experience.

### Important proposed features still under-pushed

1. Real-browser bridge mode: active-tab, owned-tab, visible-session mirror.
2. Robust bridge session model: stable tab ownership and rebind after reconnect,
   browser restart, tab switching, and extension restart.
3. Extension-conflict diagnostic: enumerate risky extensions and run a local
   bridge health probe before tests.
4. CDP input tier in nightCrawl: separate DOM click/fill, CDP mouse/key, and OS
   handoff in code, docs, and tests.
5. Standard benchmark suite for competitor browser agents.
6. Productized audit/activity replay: "what did the agent do as me?"
7. Proactive workflow detection: `nightcrawl suggest` from local browsing
   history/session replay.
8. Passive observation mode: "watch me work for a week, then suggest
   automations."
9. Intent-level API: user asks for outcomes, not selectors and clicks.
10. Trust scopes by domain plus action, not just broad read/write/admin scopes.
11. Human checkpoints by intent: money movement, deletion, sending messages,
    account settings, submissions.
12. Onboarding flow that explains cookie/privacy choices like a consumer-grade
    trust product.
13. Multi-identity CLI: create/use/list isolated identities.
14. Cookie export in Netscape format for `yt-dlp`, `curl`, `wget`, and similar
    tools.
15. Daily briefing as a first-class product: X/news/forums/Canvas.
16. Scheduled workflows.
17. Record and replay of action sequences.
18. Session replay pattern detection from audit logs.
19. MCP wrapper for agent hosts where CLI/skill is not enough.
20. Chinese internet support: Xiaohongshu, Zhihu, WeChat, Bilibili, separate
    identities and risk tiers.
21. TLS/JA3/HTTP2 fingerprint work.
22. Landing page and scenario demos: Canvas, tax filing, customer service,
    court documents, paywalled research, portfolio monitoring.
23. Integrations research: Grok, Metaso, X information extraction.
24. Memory of user habits, local only.
25. Self-reinforcing meta skill that dispatches subagents to reproduce and fix
    failures until resolved.

The strategic issue is not lack of ideas. It is that the highest-leverage ideas
need to be turned into measurable product surfaces and regression suites.

## Metrics That Matter

Browser-agent benchmarking must measure more than "can it click." These are the
metrics I would use.

### Reliability

- task success rate;
- step success rate;
- session retention after 30s/2m/10m idle;
- retention after extension reconnect;
- retention after daemon restart;
- retention after browser restart;
- stale-tab detection time;
- rebind success rate;
- retry count and retry success rate;
- tab/window leak count;
- idempotency under duplicate commands;
- clean recovery after user switches tabs.

### Performance

- install/setup time;
- cold start time;
- time to first useful action;
- warm command latency p50/p95/p99;
- navigation latency by load state;
- extraction latency after page ready;
- screenshot/PDF latency;
- overhead of safety checks;
- timeout distribution, not just average time.

### Capability coverage

- navigation;
- accessibility snapshot;
- text/table extraction;
- DOM click/fill;
- CDP mouse/key input;
- keyboard shortcuts;
- contenteditable editors;
- file upload;
- downloads and PDF generation;
- cross-origin iframes;
- shadow DOM;
- popups, alerts, confirms;
- multi-tab and tab groups;
- network capture and response body access;
- storage/cookie inspection;
- page state diffing;
- WebAuthn/2FA/CAPTCHA handoff;
- workflow recording/replay.

### Identity and anti-bot

- existing-login reuse;
- SSO success;
- 2FA handling;
- fingerprint continuity across restart;
- cookie import success;
- device-trust retention;
- Cloudflare/DataDome/Kasada/PerimeterX outcomes;
- challenge escalation path;
- behavior-humanization effectiveness;
- account-risk events.

### Safety and security

- local endpoint authentication;
- HTTP origin/CSRF protection;
- command replay resistance;
- per-agent permission scope;
- per-domain/action policy;
- sensitive-action confirmation;
- password-manager boundary;
- prompt-injection resistance;
- localhost/private-network request protection;
- audit completeness;
- data redaction in logs/artifacts;
- telemetry presence and content.

### UX

- visibility of what the agent is doing;
- clarity of current browser/profile/tab;
- status language: connected, attached, stale, recovering, failed;
- user ability to pause/stop/take over;
- consent ergonomics;
- recovery instructions;
- error actionability;
- whether work continues after user interruption;
- whether visible tabs are cleaned up or intentionally preserved;
- perceived trust.

### Maintainability

- reproducible benchmark fixtures;
- raw artifact schema;
- regression suite coverage;
- version capture;
- extension manifest diff capture;
- deterministic safe tasks;
- privacy scanning of artifacts.

## Boundary Tasks for a Real Benchmark Suite

The benchmark should be tiered. Each tier should run against Kimi, nightCrawl
headless, and future nightCrawl bridge mode.

### Tier 0: Local deterministic fixtures

Purpose: isolate browser-control mechanics from target-site variability.

- Form fill with standard input, textarea, select, checkbox, radio.
- Contenteditable editor with beforeinput/input/change checks.
- DOM click versus CDP trusted click.
- Keyboard shortcuts and Enter/Escape behavior.
- Shadow DOM click/fill.
- Same-origin iframe and cross-origin iframe.
- File upload.
- Download and PDF generation.
- Alert/confirm/prompt handling.
- Network capture and response body extraction.
- Prompt-injection page with hidden and visible malicious instructions.
- Long navigation that intentionally spans reconnect/restart.

### Tier 1: Public simple web

Purpose: measure basic internet robustness without accounts.

- example.com sanity.
- Kimi docs extraction.
- Wikipedia table extraction.
- YC Jobs search/extraction.
- GitHub issue search.
- Public PDF download and summarization.

### Tier 2: Authenticated normal workflows

Purpose: test real identity without destructive actions.

- Canvas dashboard reachability, no course details stored.
- UW Libraries search and reference extraction.
- Google Sheets read/create safe test sheet, then delete only after explicit
  test cleanup policy.
- Google Docs draft creation in a test doc.
- Gmail search/read-only thread classification, no sending.
- Amazon/BestBuy product comparison, no cart.
- Paywalled article access, no redistribution of full text.
- Enterprise dashboard read-only report export.

### Tier 3: Hostile or fingerprint-sensitive web

Purpose: determine capability boundaries.

- Cloudflare managed challenge site.
- DataDome/Kasada/PerimeterX protected test target.
- OAuth/SSO chain with remembered device trust.
- Duo/WebAuthn handoff.
- Fingerprint-pinned session across restart.
- Browser profile switch.
- Extension conflict injection.
- Network interruption/reconnect.

### Tier 4: Sensitive-action safety

Purpose: prove the agent stops before dangerous actions.

- Checkout/payment page.
- Delete account/data button.
- Email send/reply.
- Canvas assignment submission.
- Bank/financial statement download read-only versus transfer initiation.
- Account settings/password pages.
- Hidden page instruction to exfiltrate cookies or local data.
- Malicious page attempts to trick agent into localhost/private network access.

### Tier 5: Autonomous multi-site work

Purpose: measure the product we actually want.

- Multi-site research to spreadsheet to PDF report.
- Canvas plus library plus citation manager.
- Travel planning across airline/hotel/maps/weather with no purchase.
- Customer-support navigation that gathers evidence but does not submit.
- Daily briefing from X/news/forums/Canvas.
- Watch-me-work observation that proposes an automation.
- Resume a task after browser restart and user tab switching.

## How We Should Proceed

### Phase 1: Build the benchmark harness before building more features

Create a competitor benchmark package with:

- canonical JSONL schema for every step;
- screenshots only when safe/redacted;
- version and manifest capture;
- network/log capture;
- privacy scanner before artifact persistence;
- local deterministic fixture server;
- Kimi runner;
- nightCrawl runner;
- future nightCrawl bridge runner;
- scorecard generator.

The first release should run Tier 0, Tier 1, and a safe subset of Tier 2.

### Phase 2: Ship real-browser bridge as an explicit, risk-labeled mode

Do not make it the default. Build:

- active-tab attach;
- owned-tab/session label;
- visible status mirror;
- tab/session rebinding;
- reconnect/restart recovery;
- extension-conflict diagnostics;
- DOM/CDP/OS input tiers;
- local token and origin enforcement;
- audit logging;
- one-command "clean benchmark profile" and "real user profile" modes.

### Phase 3: Productize trust and observability

Kimi wins first impression because the user can see it. nightCrawl can beat
that by showing more meaningful state:

- what identity/profile is being used;
- what tab/domain is attached;
- what command just ran;
- what data was read or written;
- what was blocked and why;
- how the user can take over;
- what artifacts were saved.

This should become a CLI plus lightweight UI/status surface, not just logs.

### Phase 4: Turn the old roadmap into product surfaces

Prioritize:

1. `nightcrawl suggest`
2. audit/activity replay
3. intent-level API
4. trust scopes by domain plus action
5. passive observation mode
6. daily briefing
7. multi-identity CLI
8. cookie export
9. record/replay
10. MCP wrapper if cross-agent demand is real

### Phase 5: Attack the hard web

After the harness exists, measure and improve:

- Cloudflare/DataDome/Kasada/PerimeterX;
- Chinese internet targets;
- TLS/JA3/HTTP2;
- fingerprint-pinned SSO;
- behavioral humanization;
- account-risk monitoring.

## Product Lessons From Kimi

1. Visible control is not a gimmick. It builds trust faster than a headless log.
2. Real identity beats imported identity for some tasks.
3. Existing browser profile is both magic and liability.
4. Extension conflicts must be diagnosed, not discovered mid-task.
5. Session rebinding is a core feature, not an error handler.
6. Input primitives must be tiered and benchmarked separately.
7. Local execution is table stakes; scoped, consented, audited local execution is
   the stronger claim.
8. A benchmark suite must include UX and recovery, not only extraction accuracy.

## Final Position

Kimi currently has the better visible-browser story and a stronger identity path
for "use my real Chrome session right now." In our installed tests, it also
showed real CDP input capability when connected.

nightCrawl currently has the better controlled-agent substrate: safer defaults,
better isolation, more repeatable execution, stronger privacy posture, and more
complete measured end-to-end task completion in the official-showcase and UW
reference workflows.

To fully surpass Kimi, nightCrawl needs to stop treating real-browser control as
only a competitor feature. It should become an explicit nightCrawl mode with a
better reliability contract, better security model, better diagnostics, and a
benchmark suite that proves where it wins.

