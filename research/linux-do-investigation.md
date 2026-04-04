# linux.do Investigation: High-Value Tools for nightCrawl

> Source: linux.do/t/topic/1798211 — timerring's curated AI resource list (March 2026)
> Investigated: 2026-04-03

Four tools/ecosystems identified as directly relevant to nightCrawl's mission of autonomous stealth web crawling. Each investigated in depth below.

---

## 1. jshook MCP — JS Reverse-Engineering Suite

**What:** An MCP server that turns an LLM into an autonomous JavaScript reverse engineer. 327 tools across 23 domains — CDP debugging, hook injection, deobfuscation, WASM analysis, network interception.

**Repos:**
- github.com/vmoranv/jshookmcp (1.1k stars, AGPL-3.0) — flagship, 327 tools
- github.com/wuji66dde/jshook-skill (119 stars, GPL-3.0) — Claude Code skill variant
- github.com/zhizhuodemao/js-reverse-mcp — Patchright-based, anti-detection focused
- npm: `@ai-jshook/mcp` v0.1.11

### Architecture

Progressive tool discovery via BM25 search — reduces token overhead from ~40K (all 327 tools) to ~3K (search tier). Three profiles: search, workflow, full. Tools lazy-instantiated via Proxy.

### Key Capabilities

| Domain | What It Does | nightCrawl Use |
|--------|-------------|----------------|
| **debugger** | CDP breakpoints, XHR/Fetch interception, step-through, call stack | Reverse-engineer anti-bot challenge scripts |
| **hooks** | AI-generated JS hooks from natural language, property hijacking, eval tracking | Intercept signing functions, reproduce API auth |
| **network** | HTTP traffic capture, request filtering, call stack per request | API endpoint discovery behind SPAs |
| **transform** | Deobfuscation of 20+ types (JSVMP, packers, control flow) via Babel AST | De-obfuscate Cloudflare/Akamai/PerimeterX scripts |
| **antidebug** | Bypass debugger statements, timing checks, headless fingerprinting | Sites that detect DevTools |
| **wasm** | Disassembly, binary entropy analysis, memory scanning | WASM-based fingerprinting (Kasada, Shape Security) |
| **sourcemap** | Source map reconstruction for minified code | Understand bundled anti-bot code |
| **browser** | Chromium + Camoufox orchestration, device simulation | Diversify browser fingerprints |

### Anti-Detection (from jshook-skill)

16 stealth features, 5 platform presets: WebDriver hiding, Chrome object simulation, Canvas/WebGL fingerprint noise, audio context spoofing, navigator consistency, Battery/Permissions/NetworkInfo API simulation.

### Anti-Detection (from js-reverse-mcp)

Six-layer defense using Patchright: C++ patches removing `navigator.webdriver` and CDP leaks, 60+ stealth launch args, harmful automation flag removal, silent CDP operation.

### Integration Strategy for nightCrawl

**Complementary layers, not competitors:**
- nightCrawl = transport-level stealth (TLS/JA3, HTTP/2 frame ordering, C++ fingerprinting)
- jshook = application-level reverse engineering (JS hooks, API discovery, crypto detection)

**Adopt:**
1. BM25 progressive tool discovery pattern — solves the "too many tools" problem for nightCrawl's MCP exposure
2. Hook injection system — AI generates JS hooks from natural language, injects into live pages for API reverse-engineering
3. Deobfuscation pipeline — Babel AST transforms for understanding anti-bot scripts before attempting bypass
4. Patchright integration (from js-reverse-mcp) — C++ anti-detection patches for Playwright, directly relevant since nightCrawl already uses Playwright

---

## 2. Business2API — Account Pool & Session Rotation Patterns

**What:** Tools that turn Google Gemini Business accounts into OpenAI-compatible API endpoints. The name literally means "Business [account] to API". Two implementations with patterns directly applicable to nightCrawl.

**Repos:**
- github.com/yukkcat/gemini-business2api (1.2k stars) — Python + Node.js, web dashboard
- github.com/XxxXTeam/business2api (476 stars) — Go, distributed C/S architecture

### Patterns Directly Relevant to nightCrawl

**1. Session Pool with Rotation**
- Maintains 10-100+ accounts with automatic rotation per request
- `use_cooldown_sec: 15` between uses of same account
- Auto-detection of 401/403 triggers account swap
- Failed accounts get cooldown, max-fail-count tracking, optional auto-delete
- **nightCrawl equivalent:** Session pool for any target site — rotate cookies/accounts to avoid rate limits and bans

**2. Stealth Browser Automation for Registration**
- Headless Chromium with "humanization": random delays, Bezier curve mouse movements, natural typing rhythms
- Configurable headless/headed mode
- 6 temp email provider integrations for automated signup
- **nightCrawl equivalent:** The behavioral evasion patterns (mouse, typing) are exactly what's needed for Cloudflare Turnstile v2

**3. uTLS / TLS Fingerprint Evasion (Go version)**
- Build tags `with_quic` and `with_utls` for TLS fingerprint spoofing
- Uses the `utls` library to mimic real browser TLS handshakes
- **nightCrawl equivalent:** Directly addresses JA3 fingerprint masking on the roadmap

**4. Proxy Pool with Health Checks**
- HTTP/SOCKS5 proxy support with subscription URL auto-refresh
- IP telemetry: RPM per IP, token usage tracking
- **nightCrawl equivalent:** Proxy rotation layer for distributed crawling

**5. Distributed Worker Architecture (Go version)**
- Server mode: manages account pool, serves API
- Client mode: worker nodes handle hostile interactions (registration, captcha, cookie refresh) via WebSocket
- **nightCrawl equivalent:** Separates "hostile web interaction" from "data serving" — headless farm + human handover

**6. Cookie Persistence & Refresh**
- Cookie-based auth (not API keys)
- Cookie files at `data/at/*.txt`
- Browser-based automatic cookie refresh when tokens expire
- **nightCrawl equivalent:** Already has cookie persistence — add automatic refresh

### Integration Strategy for nightCrawl

Business2API is a **domain-specific instance** of nightCrawl's generic mission. Key architecture to adopt:

1. **Session/account pool abstraction** — first-class concept with rotation, cooldown, health tracking, failover
2. **Behavioral humanization** — Bezier mouse curves, natural typing, random delays (for Turnstile v2)
3. **uTLS library integration** — proven approach to JA3 masking, available as Go library (need TypeScript equivalent or FFI)
4. **Distributed worker model** — separate hostile interaction workers from the main agent loop

---

## 3. Grok + Tavily — Search/Fetch Separation Architecture

**What:** MCP server that combines Grok (AI-powered search) with Tavily (content extraction) and Firecrawl (fallback extraction). The key insight: **separate "what to fetch" from "how to fetch it"**.

**Repo:** github.com/GuDaStudio/GrokSearch (`grok-with-tavily` branch)
**Author:** DaiSun (锦衣夜行孙大侠) on linux.do
**Source posts:**
- linux.do/t/topic/1606525 — original design
- linux.do/t/topic/1674101 — upgraded with Firecrawl fallback

### Architecture

```
Claude ──MCP──> GrokSearch MCP Server
                  ├─ web_search      ──> Grok API (returns answer + source URLs)
                  ├─ get_sources     ──> Cached citations from search session
                  ├─ web_fetch       ──> Tavily Extract -> Firecrawl (fallback)
                  ├─ web_map         ──> Tavily Map (site structure discovery)
                  ├─ search_planning ──> Multi-stage search plan generation
                  └─ toggle_builtin_tools ──> Disables Claude's native search
```

### How It Reduces Hallucination

1. **Grok searches broadly** — `extra_sources: 20` forces many source URLs instead of synthesized answers
2. **Tavily extracts actual pages** — HTML to Markdown, no LLM in the extraction step
3. **Claude reasons on real content** — not on Grok's potentially hallucinated summaries
4. **Cross-verification** — recommended prompt enforces 2+ independent sources per claim

### MCP Tools (8 total)

| Tool | Backend | Purpose |
|------|---------|---------|
| `web_search` | Grok API (OpenAI-compatible via grok2api) | AI search with source tracking |
| `get_sources` | Local cache | Retrieve citations by session_id |
| `web_fetch` | Tavily Extract -> Firecrawl | Full page content as Markdown |
| `web_map` | Tavily Map | Site structure discovery |
| `search_planning` | LLM | Multi-round search strategy |
| `get_config_info` | Internal | API connectivity diagnostics |
| `switch_model` | Config | Change Grok model |
| `toggle_builtin_tools` | `.claude/settings.json` | Disable Claude's native tools |

### Tavily API Quick Reference

| API | What | Cost |
|-----|------|------|
| Search | Web search with results | 1 credit/search |
| Extract | Page to Markdown, optional images | 1 credit/5 URLs |
| Map | Discover all pages on a site | 1 credit/10 pages |
| Crawl | Systematic site crawl with instructions | Per-page |

Free tier: 1000 requests/month. Firecrawl also has a free tier.

### Integration Strategy for nightCrawl

**Current L3 weakness:** Browsing `x.com/i/grok?text=...` via headless browser is fragile (DOM changes), slow (full render), and limited (no structured source URLs).

**Proposed enhancement — new L3+ tier:**
1. **Grok API** (via grok2api reverse proxy) for search *discovery* — returns structured source URLs
2. **Route URLs back through nightCrawl's L1/L2 pipeline** for *content retrieval* — stealth Playwright is strictly better than Tavily for sites with serious anti-bot
3. This separates concerns: Grok finds what to read, nightCrawl's stealth browser handles how to read it

**Setup requirements:**
- Grok API key (via grok2api self-hosted reverse proxy, or X API)
- Tavily API key (free tier: 1000 req/month) — useful as lightweight fallback before escalating to full stealth browser
- Firecrawl API key (free tier) — second fallback

---

## 4. jina.ai — Untapped API Surface

**What:** We use `r.jina.ai` as our L1 tier. jina.ai now has **6 endpoints** — we're using 1.

**Business note:** Elastic acquired Jina AI in October 2025 — long-term stability assured.

### Complete API Surface (2026)

| Endpoint | Purpose | We Use It? |
|----------|---------|------------|
| `r.jina.ai` | URL to Markdown | Yes (L1) |
| `s.jina.ai` | Web search, top-5 results as Markdown | **No** |
| `g.jina.ai` | Fact-checking / grounding against live web | **No** |
| `deepsearch.jina.ai` | Iterative multi-step search+read+reason | **No** |
| `mcp.jina.ai` | Remote MCP server (19 tools) | **No** |
| `eu.r.jina.ai` / `eu.s.jina.ai` | EU-jurisdiction variants | **No** |

### r.jina.ai Parameters We Should Be Using

**High-impact parameters:**

| Header | What It Does | Why We Need It |
|--------|-------------|----------------|
| `X-Engine: browser\|direct\|cf-browser-rendering` | Select rendering engine | `direct` for static (fast), `browser` for JS-heavy, `cf-browser-rendering` experimental |
| `X-Set-Cookie` | Forward cookies to jina's server | Bypass cache, access authenticated content at L1 |
| `X-Proxy-Url` / `X-Proxy` | Use our proxy or jina's country-specific proxy | Geo-restricted content without escalating to L2 |
| `injectPageScript` (POST body) | Execute JS before extraction | Anti-bot workarounds at L1 level |
| `X-Target-Selector` | CSS selector to focus extraction | Skip noise, get only the content we need |
| `X-Remove-Selector` | CSS selector to strip elements | Remove nav, ads, footer |
| `X-Wait-For-Selector` | Wait for dynamic content | JS-heavy sites that load late |
| `X-Respond-With: readerlm-v2` | Use ReaderLM-v2 (1.5B model) for conversion | 3x cost but dramatically better on complex pages |
| `X-With-Links-Summary` | Append all links at end | Agent navigation — discover next pages to crawl |
| `X-Return-Format: screenshot\|pageshot` | Return screenshot URL | Visual analysis of pages |
| `X-With-Shadow-Dom: true` | Extract Shadow DOM content | Modern web components |
| `X-With-Iframe: true` | Extract iframe content | Embedded content |
| `X-Token-Budget` | Hard token limit per request | Cost control |
| `X-Locale` | Browser locale | Sites serving different content by locale |
| `X-No-Cache: true` | Skip cache | Fresh content for time-sensitive crawls |

**Streaming mode:** `Accept: text/event-stream` — progressive chunks, each more complete. Good for JS-heavy sites.

### s.jina.ai (Search API) — Should Be Our New Default Search

Web search that returns top-5 results **already converted to Markdown**. SERP + reader in one call.

- `X-Site` header for domain-restricted search
- POST body: `gl` (country), `location` (city), `hl` (language), `num`, `page`
- Same rendering options as r.jina.ai
- 100 RPM free, 1000 RPM premium

**This could replace or supplement WebSearch** — returns actual page content, not just snippets.

### deepsearch.jina.ai — Iterative Research Agent

OpenAI-compatible endpoint (`jina-deepsearch-v1`) that iteratively searches, reads, and reasons.

- Controls: `budget_tokens`, `max_attempts`, `team_size` (parallel agents), `reasoning_effort`
- Source controls: `boost_hostnames`, `bad_hostnames`, `only_hostnames`
- Average: ~70K tokens/query, ~20s response, up to 120s for complex research
- 50 RPM free/paid, 500 RPM premium

### mcp.jina.ai — 19-Tool MCP Server

Streamable HTTP MCP server exposing: web search, arXiv/SSRN search, image search, URL-to-markdown, screenshot, PDF extraction, query expansion, reranking, classification, semantic deduplication, parallel search.

Single URL: `mcp.jina.ai/v1` with optional Bearer token.

### Rate Limits

| Tier | r.jina.ai RPM | s.jina.ai RPM | Concurrent | TPM |
|------|--------------|--------------|------------|-----|
| No key | 20 | - | 2 | 100K |
| Free key | 200 | 100 | 2 | 2M |
| Paid | 500 | 100 | 50 | 2M |
| Premium | 5,000 | 1,000 | 500 | 50M |

10M free tokens for new API keys.

### Integration Strategy for nightCrawl

**Immediate wins (L1 tier):**
1. Use `X-Engine` header — select per site category
2. Use `X-Set-Cookie` — forward cookies from our persistence layer
3. Use `X-Proxy` with country codes — geo-restricted content without L2
4. Use `injectPageScript` — pre-extraction JS at L1
5. Use `X-Target-Selector` / `X-Remove-Selector` — precision extraction
6. Use `X-With-Links-Summary` — agent discovers next crawl targets
7. Set `X-Token-Budget` and `X-Timeout` as defaults

**New tiers to add:**
- `s.jina.ai` as search tier (replaces/supplements WebSearch)
- `deepsearch.jina.ai` for complex research queries
- `mcp.jina.ai` if nightCrawl adopts MCP protocol

---

## Updated Escalation Tiers (Proposed)

| Tier | Method | When to Use |
|------|--------|-------------|
| **L1** | `r.jina.ai` (enhanced with new headers) | Default — fast, handles most sites. Use `X-Engine`, `X-Set-Cookie`, `X-Proxy` |
| **L1+** | `s.jina.ai` | Search + full content in one call. Replaces WebSearch for content-rich results |
| **L2** | nightCrawl stealth browser (headless) | Paywalled or bot-protected sites requiring real browser |
| **L2+** | nightCrawl + cookie import | DataDome max-security (WSJ) |
| **L3** | Grok API (via grok2api) for discovery | Real-time discussions, community intel. Returns source URLs |
| **L3+** | Grok discovery -> nightCrawl L2 extraction | Grok finds what to read, stealth browser fetches it |
| **L4** | jshook MCP reverse engineering | When anti-bot requires understanding the JS — deobfuscate, hook, reproduce |

---

## Summary: What to Build Next

### Immediate (enhance existing)
- [ ] Add jina.ai headers to L1 tier (`X-Engine`, `X-Set-Cookie`, `X-Proxy`, `X-Target-Selector`)
- [ ] Integrate `s.jina.ai` as L1+ search tier
- [ ] Set up grok2api for structured L3 access (replace browser-based Grok)

### Medium-term (new capabilities)
- [ ] Session pool abstraction (from Business2API patterns) — rotation, cooldown, health tracking
- [ ] Behavioral humanization layer — Bezier mouse, natural typing (from Business2API, for Turnstile v2)
- [ ] jshook MCP integration — application-level reverse engineering as L4 tier
- [ ] Patchright evaluation — C++ anti-detection patches for Playwright (from js-reverse-mcp)

### Long-term (architecture)
- [ ] uTLS / JA3 fingerprint masking (from Business2API Go implementation, need TS equivalent)
- [ ] BM25 progressive tool discovery (from jshook) for nightCrawl's own MCP exposure
- [ ] Distributed worker architecture (from Business2API) — separate hostile interaction from agent loop
- [ ] Deobfuscation pipeline (from jshook) — Babel AST transforms for anti-bot script analysis
