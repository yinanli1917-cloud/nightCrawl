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
| Browser Use Box / bux (same team) | 24/7 VPS agent: Telegram bot → Claude Code → Browser Harness → BU Cloud. Zero stealth, no cookie import, cloud-dependent, bypassPermissions. Narrative threat: "text your agent from phone" UX. |
| Browserbase | Cloud datacenter IPs detectable in 50ms |
| Einstein AI | Shut down, cease-and-desist, no privacy (cloud-based) |
| CloakBrowser | No agent framework, no cookie import, no session management (integration target for v0.2) |
| Camoufox | Firefox-based, no network interception |
| gstack browse | QA tool for your own sites, not the authenticated or bot-protected web |

## Tech Stack

- TypeScript / Bun
- Playwright (patched — stealth as owned code, not dependency patches)
- CloakBrowser stealth Chromium — the only engine (48 C++ fingerprint patches: canvas, WebGL, audio, fonts, GPU, WebRTC)

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
4. **Auto-handover (consent-per-domain)** — detects login walls, opens headed Chrome, user logs in, auto-resumes headless. Detection ALWAYS runs; the gate is **per-domain consent** stored in `~/.nightcrawl/state/handoff-consent.json` keyed by eTLD+1 with TTL. Approve once per domain (`grant-handoff <domain>`), then nightCrawl auto-handles SSO autonomously for that domain (TTL 30d default). Unknown domains never silent-pop — they surface `CONSENT_REQUIRED` to the agent + macOS notification. Adds a per-domain consent gate in front of the `BROWSE_AUTO_HANDOVER` env-var gate (2026-04-14, after the UW Canvas regression incident): consent decides whether a domain may hand over at all (unknown domains never pop); the env var, off by default, still decides whether an approved hand-over opens a headed window or stays a headless sync returning `LOGIN_REQUIRED`.
5. **bypass-paywalls-chrome v4.3.4.5** — Manifest V3, declarativeNetRequest
6. **Cookie persistence** + import from Arc/Chrome/Firefox/Safari (AES-128-CBC decrypt via Keychain)
7. **Scoped token system** — per-agent permissions (read/write/admin/meta scopes), domain restrictions, rate limiting
8. **IPv6 + DNS hardening** — full fc00::/7, fe80::/10, IPv4-mapped IPv6, AAAA DNS rebinding, ReDoS-safe regex

9. **CloakBrowser engine** — the only production engine. CloakBrowser's stealth Chromium with 48 C++ patches (canvas, WebGL, audio, fonts, GPU, WebRTC, etc.). Failure throws with install instructions; stock Playwright fallback was removed (Chrome for Testing is detectable by every Tier-1+ vendor).
10. **Fingerprint profiles** — `BROWSE_FINGERPRINT_SEED` or per-identity seeds in `~/.nightcrawl/identities/`. Deterministic fingerprints across all surfaces.
11. **Behavioral humanization** — `BROWSE_HUMANIZE=1` enables CloakBrowser's built-in Bezier mouse, typing jitter, non-linear scroll (Tier 4-5 sites only)
12. **Fingerprint-pinned domain classifier** — `fingerprint-pinned.ts` detects sites whose bot-management vendor pins sessions to the solving browser's fingerprint (Cloudflare `cf-mitigated`, DataDome, Kasada, PerimeterX). Persists to `~/.nightcrawl/state/fingerprint-pinned.json`. Header-sniffed on `document` responses OR marked observationally when Arc cookie import fails to clear the wall. Shortens the default-browser poll from 5 min → 30 s for pinned domains and routes straight to headed CloakBrowser.
13. **Actionable notifications** — `notify.ts` adds `notifyWithAction(title, body, action)` using the native SwiftUI `~/.nightcrawl/NightCrawlNotify.app`. Handoff/approval prompts must use this native app; if it is missing, fail loudly instead of falling back to terminal-style notification paths.
14. **Persistent fingerprint seed** — `engine-config.ts` persists the CloakBrowser fingerprint seed to `~/.nightcrawl/state/engine-seed.json`. Every headless AND headed launch on this machine uses the SAME seed so bot-managed sites (CF/Akamai/etc) see a consistent fingerprint across sessions and headless↔headed transitions. Previously each launch picked a random seed, invalidating cookies each time.
15. **CloakBrowser for headed handoff** — `browser-handoff.ts` routes both `launchHeaded` and the `handoff` relaunch through `launchCloakBrowser`. Fixes the v0.2 gap where headless was CloakBrowser but handoff was Chrome-for-Testing, breaking the whole fingerprint-match premise.
16. **Late-redirect watcher** — `server.ts` runs a 20-second background URL watcher after every goto whose initial detection returned null. If the URL settles on a login path (CF dash takes ~10s to client-redirect `/` → `/login`), invalidates auth-cache, marks the domain as observed-pinned, and fires auto-handover or a consent notification.
17. **Learned engine routing** — `engine-journal.ts` appends every nav/command outcome (engine, latency, timeouts, accessibility-fallback, re-login) to `~/.nightcrawl/state/engine-decisions.jsonl`. `engine-routing.ts` DERIVES the per-domain recommendation from that history (success rate → latency → timeouts) and lets it supersede the weak cold-start prior; the guidance block shows the evidence. Hard rules in `strategy-advisor.ts` are safety invariants only (hostile → headless, file-upload → headless) and always win. Advisory — never silently switches engines. Not a preset rule table: routing keeps improving from real outcomes.
    - **Recency window** — only outcomes within the last 30 days count (`filterRecent`, mirrors domain-strategy's TTL) so a wall a site fixed last week stops mis-routing it forever. Records with no usable `ts` are kept (older-schema safety).
    - **Exploration nudge** — `recommendFromStats` flags the engine with ZERO history on a domain (`untried`) so a better engine can be discovered; pure argmax alone could never surface it. Advisory only — `auto` never silently probes the live (real) browser.
    - **Reflection (recommended-vs-chosen)** — each record also stores `recommended` (what the router would pick at decision time) + `chosenBy` (`auto`|`explicit`). `adviceRegret` then splits outcomes into advice-FOLLOWED vs advice-OVERRIDDEN so the system can audit whether its own advice actually helped. `recordWin` (domain memory) is gated on the journal's honest `ok`, so a wall/timeout never counts as a "win".
    - **`engine-stats [domain]`** — human-readable reflection view: per-domain recommendation + the followed/overridden success split (`formatEngineStats`). This is how the user SEES whether dual-engine routing is good, not just that it runs.
18. **Engine R correctness (real-browser bridge)** — `bridge-commands.ts` + the extension `background.js` (kept in sync): in-page `js` awaits Promises (`awaitPromise`, so `async` fetch returns the resolved value, not `{}`); `click` is a TRUSTED gesture — resolve the element → `DOM.getBoxModel` for coords → `Input.dispatchMouseEvent` move/press/release (`buttons` bitmask required) — so `isTrusted`-gated sites and native-password submit work. Falls back to JS click only for off-DOM/zero-box nodes. **Non-disruptive (Kimi-faithful):** Engine R creates its work tab in the user's CURRENT window with `active:false` (the user's view never switches) and drives it via CDP with `Emulation.setFocusEmulationEnabled` on (so trusted input lands on the background tab). NEVER `chrome.windows.create` — that pops a visible window on macOS even with `focused:false` (verified). Reliability: `sendCdp` auto re-attaches on "Debugger is not attached"; run ONE daemon (it must own bridge port 10087 — proliferation → `connected:false`).
   - **Tab grouping (browser-dependent)** — drops the work tab into a collapsed `nightcrawl` tab group (`chrome.tabGroups`) so the user can manage automation tabs (mirrors Kimi). Works in Chrome; **Arc HANGS on `chrome.tabs.group`** (no tab-group backend), so grouping is timeout-guarded and self-disables in Arc — the tab stays a quiet `active:false` background tab. Kept because most users run Chrome.
   - **Self-reload** — `reload-extension` (daemon route → extension `chrome.runtime.reload()`, reloads code from disk), `bridge-status` (side-effect-free liveness), `bridge-tabinfo` (active/group diagnostic); helper `scripts/bridge-reload.mjs`. Lets the agent iterate on `background.js` without a manual extension toggle. NEW manifest permissions still need a one-time manual reload.
19. **Form autofill (privacy-preserving)** — two tracks, never reads the browser password DB. Track 1: a local, user-populated, NON-SECRET profile vault (`profile-store.ts`, `~/.nightcrawl/state/profile.json`, 0600) + `autofill` command (`field-matcher.ts`, autocomplete-token-first matching) that fills blank signup/contact fields, gated by `sensitive-page.ts` (refuse payment/account-security/destructive; `--confirm` for personal-info; secret fields never match). Track 2: `autofill-login` (`autofill-login.ts`) submits the BROWSER's OWN saved password via Engine R — detect login form → per-domain consent (reuses `grant-handoff`) → trusted submit → 2FA detected and handed back.
20. **Session-scoped browsing (per-session tab isolation)** — one daemon, one shared (logged-in) browser, but each **session** owns its own tab(s) on **both** engines, so two Claude Code windows / Codex / Cursor / OpenClaw never steal, navigate, or close each other's tabs. Shared context (shared cookies) is kept on purpose — TABS are isolated, not the browser.
    - **Identity** (`session-id.ts`) — data-driven `SESSION_SOURCES` registry: `NIGHTCRAWL_SESSION_ID` > `CLAUDE_CODE_SESSION_ID` (→ `claude:<id>`) > `CODEX_*` > `CURSOR_*` > `proc:<ppid>` > `default`. Wire format is the `X-Nightcrawl-Session` header — the CLI sets it; any API/SDK agent self-identifies by sending it. Missing → `default` (back-compat: untagged callers behave exactly as before).
    - **Per-tab store** (`tab-store.ts`) — `TabStore` keeps a `sessionActive` map (one active tab PER session, no single global active) plus per-tab `refMap`/`activeFrame`/`lastSnapshot`/`lock`. `default` is the back-compat key.
    - **Facade** (`session-view.ts`) — `TabView` interface + `SessionView`; `handleCommand` resolves `bm.forSession(sessionId)` ONCE and hands the view to every handler (handler bodies unchanged). `BrowserManager` per-tab methods take the sessionId; `getPage()` NEVER falls back to another session's tab; `goto` lazily creates the session's OWN tab (`ensureActiveTab`); `closeTab`/`switchTab`/`tabs` are session-scoped; `tabs --all` + cross-session close require the **Admin** scope.
    - **Per-tab lock** (`runOnTab`) — commands on the SAME tab serialize; different tabs/sessions run fully concurrently.
    - **Handoff/detection** — login-wall detection (`detectLoginWall(sessionId)`) + the post-command auto-handover run on the CALLER's tab (fixes a non-default `claude:` session missing its wall); the headed handoff ACTION + restore/recreate stay whole-browser and re-own tabs as `default`.
    - **Engine R** (`bridge-hub.ts`, `bridge-ws.ts`, extension `background.js`) — `BridgeCommand` + the `tool_call` carry `sessionId`; the extension keeps `boundBySession` (one Arc background tab per session; `planBoundTab`/`clearBoundByTabId` in `bridge-session.ts` are the testable mirror). One socket multiplexes all sessions by `requestId`. **A background.js change needs a one-time Arc extension reload.**
21. **Automatic failure capture (no silent failures)** — `failure-collector.ts` turns any NightCrawl failure, from ANY project on the machine, into a durable record + an evidence bundle + (for real tool bugs only) a deduped Codex investigation task in THIS project, so failures are reproduced and fixed instead of lost. Mirrors `engine-journal.ts` idioms (never throws, 0o600 append, 5000-line prune, malformed-tolerant).
    - **Data-driven classification** — a `SIGNALS` table `[{category, pattern, family, actionable}]` (NOT per-failure if/else). Families: `daemon-unavailable` (coarse signature so a whole spree = ONE task, across the CLI + daemon layers), `env` (host-tool-scoped), `site` (login walls / their errors — recorded for stats, `actionable:false`, NEVER a task), `unknown` (still actionable so a novel mode surfaces).
    - **Global sink** — `failures.jsonl`, dedup markers, and bundles live under `~/.nightcrawl/` (independent of git/cwd, so a failure in fictionWorks lands where nightCrawl can find it), NOT in `resolveConfig().stateDir`. Bundle = `record.json` + `daemon-processes.txt` (`ps`/`lsof :10087`/socket list — the duplicate-daemon evidence that vanishes otherwise) + log tails.
    - **Atomic dedup** — a `'wx'` exclusive-create marker per signature (mirrors `acquireServerLock`) is race-safe under a concurrent spree: exactly one process files the task, losers bump a count. 6h TTL resets it.
    - **Task + notify** — a novel actionable signature spawns a detached (nohup, survives `process.exit`) `codex_harness.py task create --slug autofail-<signature>` (never `--global`) + a macOS notification. Wired at CLI chokepoints (`cli.ts` 500/timeout/global-catch, once-guarded) and the daemon's FATAL handlers + `start().catch` (the only capture path for a detached daemon whose stdout is `/dev/null`). Gates: `NIGHTCRAWL_NO_FAILURE_CAPTURE=1` (full off), in-repo dev records+bundles but skips task creation (self-spam).

### Stateless-caller resilience (Track B — from the texascourtclasses Cursor-course post-mortem)

Driven by the real failure taxonomy of an external agent (Cursor) that runs each CLI
command in a FRESH shell: 28x "No active page", 23x re-export boilerplate, ~30 cmds of
SCORM DOM brute-force, async-js empties, "Server failed to start within 8s", stale @refs.
The fix makes nightcrawl safe for STATELESS, UNINFORMED callers — self-healing execution
+ self-teaching capability — instead of assuming a stateful, knowledgeable driver.

- **Session continuity** (`session-id.ts`) — untagged callers ALL map to one shared
  `default` workspace (the `proc:<ppid>` fragmentation is gone). A fresh-shell follow-up
  command finds the prior tab. Tagged agents (env-var sessions) stay isolated.
- **Lazy tab re-bind** (`tab-store.ts`) — `activePageFor` recovers the session's own
  most-recent tab (default may take the newest overall) when the active pointer is lost,
  instead of throwing "No active page". Only an empty store throws.
- **Stale-ref auto-refresh** (`write-commands.ts`) — a click/fill/etc. on a stale `@ref`
  re-snapshots ONCE and retries (`resolveRefWithRefresh`), then errors if still gone.
- **Robust async `js` + `wait-for`** (`read-commands.ts`, `commands.ts`) — `js`/`eval`
  always wrap in an async IIFE that RETURNS the value (so `fetch().then()` resolves) under
  a 30s cap; `wait-for <js-predicate> [timeoutMs]` polls in-page (replaces `sleep`).
- **Recipe surfacing** (`recipe-registry.ts` -> `engine-routing.buildNavGuidance`) — a
  data-driven, advisory registry classifies a task/site (e.g. SCORM/xAPI course) and
  surfaces the right move ("use `--engine=real`; completion is an xAPI statement to the
  LRS, not DOM clicks"). Never auto-executes.
- **Daemon readiness** (`daemon-readiness.ts` -> `cli.ts`) — startup/lock-wait loops wait
  up to 45s for a cold CloakBrowser boot but fail FAST on a dead process / startup-error
  log (`classifyStartup`), ending the "failed to start within 8s" churn.
- **Zero-setup launcher** (`launcher.ts` -> `browse install`) — drops a `browse`/
  `nightcrawl` launcher on PATH so a fresh shell needs no `export PATH/NC` block. `nc` is
  NOT installed (it would shadow netcat); `alias nc=browse` if wanted.

### Weak-model perception layer (agents as our users — democratize the browser)

Driven by the weak-model-lift benchmark (`research/weak-model-lift-findings-2026-07-17.md`):
deepseek-v4-flash knew WHAT to do but fumbled the low-level tool-driving (run_js returned
empty on a bare statement list, the answer was pasted into FINISH unexecuted, data lived in
a backend the DOM text never showed). The fix gives a weak/stateless driver forgiving,
high-level primitives so it never needs to hand-write DOM JS, plus in-band coaching so it
self-corrects. All page-general — no per-site logic.

- **Forgiving read primitives** (`read-extract.ts` -> `read-commands.ts`, registered in
  `commands.ts` READ + PAGE_CONTENT): `find <keyword> [-C n] [--all] [--re]` locates a term
  in a big page and returns the surrounding region + a pointer to any enclosing table;
  `table [<index>|near <kw>|@ref] [--json]` extracts a `<table>` OR ARIA grid as TSV/JSON;
  `read` returns the readable main article (cleaner than `text`); `data [--all]` surfaces
  the JSON/CSV backend request behind a chart from the redacted deep-capture ring
  (`network-capture-deep.ts`, now filling `respContentType`/`respBodySample` via
  `sampleResponse`), ranked with a hard exclude for third-party telemetry vendors, and
  prints a ready-to-run `fetch`. `text`/`html`/`read`/`find`/`table` share `capOutput` so a
  weak model is never flooded — on truncation the footer points at `find`/`table`/`data`.
  `table` also takes `--sort <col> [--desc] [--top N]` (numeric-aware: commas/currency/%
  stripped, lexical fallback) so a weak model READS OFF the max/min/rank instead of
  eyeballing 200 rows and comparing long numbers in its head (the residual REASONING wall on
  data-reachable tasks). Verified live on Wikipedia's 242-row population table.
- **Data-app capture (script/JSONP)** (`network-capture-deep.ts`): the numbers on a
  data-app (Maoyan, some gov portals) load via `<script>`/JSONP, not xhr/fetch, so `data`
  never saw them. Capture now also records a `script` response, but ONLY when its body is
  really DATA (`looksLikeData`: a JSON value, or a `callback({…})`/`([…])` wrapper, even
  behind GitHub-style `/**/` anti-hijacking armor) — never framework code, so the ring stays
  clean. `scoreDataRequest` rewards it. Verified live: `data` surfaced a JSONP `<script>`
  request (api.github.com) that was previously invisible.
- **In-band coaching** (`error-coach.ts` -> `server.ts` catch + `read-commands.ts` js/eval):
  a data-driven `{errorPattern -> hint}` table keyed on error CLASS (never a site) turns a
  thrown error or an empty `js` result into ONE next-move line (`coach:` / `EMPTY_JS_HINT`),
  so a stateless driver that never reads the SKILL.md still self-corrects instead of looping.
- **Navigation-assist** (`search-input.ts` + `follow-link.ts` + `nav-recovery.ts` ->
  `write-commands.ts`): a weak model guesses (often stale) URLs instead of using a site's own
  navigation — the residual "navigation" wall after the perception layer. Three general,
  page-general (no hostnames) moves, each a pure tested ranker/classifier + a trusted DOM
  drive:
  - `search <query>` finds the site's search box (ranker over `type=search`/`role=searchbox`/
    common names/placeholders incl. 搜索/search-forms) and drives it with TRUSTED Playwright
    input (fill+Enter, Search-button fallback for Enter-swallowing SPA comboboxes) — raw JS
    value-set is ignored by React/Vue, trusted events are not. Verified on Wikipedia's search.
  - `follow <keyword>` clicks the on-page link that best matches a keyword in ONE step (ranker
    over visible text > aria/title > href path; forces same-tab), collapsing the snapshot ->
    find @ref -> click chain a weak model fumbles on multi-step traversal (search result ->
    filing -> document). Verified live (Apple_Inc → `follow "Tim Cook"` → /wiki/Tim_Cook).
  - `goto` auto-recovery (`nav-recovery.ts`): a failed navigation (4xx/5xx status OR a soft-404
    "page not found" body at 200) appends ONE recovery line — use THIS site's `search`/homepage
    (seeded with terms from the failed URL), not another guess. `goto` also now reports the
    FINAL landing URL on redirect (`… (redirected from …)`) so the model isn't misled. Verified
    live on SEC/FDA 404s + the clinicaltrials /ct2 → /search redirect.
- **Auto-surfaced method flywheel** (`skill-router.methodAdviceForNav` +
  `goal.inferNavGoal` -> `server.ts` `appendEngineGuidance`): the already-built
  skill/recipe layer was dark (only reachable via explicit `nc skills`). Now nav-time goal
  is inferred from the URL and the best learned method / curated recipe auto-flows in the
  guidance block. Quiet by default; `BROWSE_DISABLE_SKILLS=1` turns it off. A general
  `data-portal` recipe (structural signature, never a hostname) nudges chart/statistics
  pages toward `data`/`table`.

### Engine Configuration
- **One global daemon per machine.** When `BROWSE_STATE_FILE` is unset, `resolveConfig` (`config.ts`) resolves the state dir / socket / lock to the global `~/.nightcrawl/` regardless of the caller's git root or cwd. Scoping them per git-root was the root cause of duplicate daemons (a call from project A and project B hashed different sockets → two daemons → they fought over the one shared Chromium profile + bridge port → SingletonLock crash → 45s startup + goto timeouts). Every project now adopts the ONE daemon; tab isolation stays keyed by the `X-Nightcrawl-Session` header, not stateDir. `BROWSE_STATE_FILE` still overrides (tests, benchmarks).
- CloakBrowser stealth Chromium is the only engine. `BROWSE_ENGINE` is no longer parsed.
- `BROWSE_FINGERPRINT_SEED=12345` — explicit fingerprint seed (10000-99999); otherwise persisted in `~/.nightcrawl/state/engine-seed.json`
- `BROWSE_HUMANIZE=0|1` — behavioral humanization (Bezier mouse, typing jitter, non-linear scroll)
- `NIGHTCRAWL_BLOCK_HEADED=1` — **no-window test/verification mode.** CloakBrowser is anti-detect Chromium: a HEADED launch shows a visible window (headless is windowless). `launchCloakBrowser` (the single chokepoint for launchHeaded/handoff/autoHandover) refuses any `headless:false` launch when set, so a verification or CI run can never pop a window. Set it (and skip the headed-requiring suites: `handoff`, `default-browser-handoff`, `stealth-extensions`) for window-free verification. Headless launches always proceed.
- `BROWSE_DISABLE_FLYWHEEL=1` — benchmark ablation switch. `closeLoop` no-ops (records no skill), so a generalization suite can measure a clean flywheel-OFF baseline against the same held-out tasks.
- `BROWSE_DISABLE_RECIPES=1` — benchmark ablation switch. `appendRecipe` surfaces no curated recipe, isolating the flywheel's contribution from the hand-authored recipe registry.
- `BROWSE_DISABLE_SKILLS=1` — turn off the auto-surfaced method advice on navigation (`methodAdviceForNav`). Symmetric to `BROWSE_DISABLE_RECIPES`; the explicit `nc skills` command still works.
- `BROWSE_MAX_OUTPUT=<chars>` — cap for the big readers (`text`/`html`/`read`/`find`/`table`, default 12000). On truncation a footer points the model at `find`/`table`/`data`. Benchmarks set it below their observation cap so the footer survives.
- `NIGHTCRAWL_NO_FAILURE_CAPTURE=1` — full off switch for automatic failure capture (`failure-collector.ts`); records nothing, files no task.
- `NIGHTCRAWL_FAILURE_DIR=<dir>` — override the failure sink (default `~/.nightcrawl/`); used by tests for isolation.

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
- Auto-handover has two gates: per-domain consent (`grant-handoff`) decides IF a domain may hand over at all; `BROWSE_AUTO_HANDOVER=1` (off by default) decides whether an approved hand-over opens a headed window. With it off, login walls come back to the agent as `LOGIN_REQUIRED` / `CONSENT_REQUIRED` with no window.
- Cookies auto-persisted after handoff/resume + every 5 min + on shutdown
- Handoff consent: `grant-handoff <domain>` / `revoke-handoff <domain>` / `list-handoff` — per-eTLD+1 approval with 30-day default TTL
- macOS handoff approvals: `notifyWithAction()` in `src/notify.ts` uses the native SwiftUI `NightCrawlNotify.app` only (opt-out via `NIGHTCRAWL_NO_NOTIFY=1`)
- The nightcrawl skill ships as two byte-identical copies — `.claude/skills/nightcrawl/SKILL.md` (Claude Code) and `.agents/skills/nightcrawl/SKILL.md` (Codex/other agents). Edit `.claude` as canonical, then copy it over `.agents`; `test/skill-sync.test.ts` fails if they drift. Never edit SKILL.md by hand — use `/skill-creator`.

## Key References

- PRD: docs/PRD.md (v0.2 — all product decisions)
- rebrowser-patches: github.com/rebrowser/rebrowser-patches
- CloakBrowser: github.com/CloakHQ/CloakBrowser (v0.2 integration target)
- Patchright: github.com/Kaliiiiiiiiii-Vinyzu/patchright
- Camoufox: github.com/Bin-Huang/camoufox-cli
- gstack: github.com/garrytan/gstack (foundation)

## Codex Harness

Codex does not receive Claude hook injections automatically. Treat `.codex/workflow.md` and `scripts/codex_harness.py context` as the native pull-based context layer.

Common commands:

```bash
python3 scripts/codex_harness.py context
python3 scripts/codex_harness.py health
python3 scripts/codex_harness.py task create "<title>"
python3 scripts/codex_harness.py task start <slug-or-dir>
python3 scripts/codex_harness.py task finish [slug-or-dir]
python3 scripts/codex_harness.py task archive <slug-or-dir>
```
