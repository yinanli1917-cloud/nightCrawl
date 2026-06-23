# Security Model

nightCrawl runs as a local daemon with full access to the user's browser cookies,
passwords, and authenticated sessions. The security model defends against three
threat vectors: prompt injection from web content, SSRF via navigation, and
unauthorized agent access via the HTTP command surface.

## Layer 1: Content Security (Prompt Injection Defense)

`content-security.ts` implements a 4-layer pipeline applied to all page content
returned to AI agents:

1. **Hidden element stripping** (`stripHiddenElements`): detects 11 CSS hiding
   techniques (opacity < 0.1, font-size < 1px, off-screen positioning,
   visibility: hidden, display: none, clip-path, same fg/bg color, overflow:
   hidden + zero dimension, aria-hidden="true", ARIA label injection patterns).
   Runs in browser context via `page.evaluate()`.

2. **Exfiltration URL blocklist** (`isExfiltrationUrl`): blocks navigation to
   known data-capture services (requestbin, pipedream, webhook.site, hookbin,
   ngrok, interact.sh, canarytokens, etc.). Applied to `goto`, link clicks,
   and form actions.

3. **Datamarking** (`addDatamark`/`detectDatamark`): watermarks text with
   session-scoped zero-width Unicode characters (ZWSP=bit0, ZWNJ=bit1,
   ZWJ=separator, BOM=sentinel). Enables tracing leaked content back to the
   session that extracted it.

4. **Content envelope** (`wrapContentEnvelope`): wraps output in
   `════════ BEGIN/END UNTRUSTED WEB CONTENT ════════` markers with per-session
   nonce and escape prevention (zero-width space injection to break forged
   markers). `wrapUntrustedContent()` in `commands.ts` provides a secondary
   envelope for backward compatibility.

HTML comment injection stripping (`stripHtmlCommentInjections`): removes
`<!-- -->` comments matching 9 instruction-injection regex patterns.

## Layer 2: URL Validation (SSRF Defense)

`url-validation.ts` exports `validateNavigationUrl()`, called before every
Playwright navigation. Defense layers:

- **Scheme restriction**: only `http:` and `https:` allowed
- **Cloud metadata blocklist**: `169.254.169.254`, `metadata.google.internal`,
  `metadata.azure.internal` (plus hex/decimal/octal IP representations)
- **IPv6 reserved ranges**: loopback (`::1`), unspecified (`::`), ULA
  (`fc00::/7`), link-local (`fe80::/10`), IPv4-mapped addresses
  (`::ffff:x.x.x.x`) that map to blocked IPv4 ranges
- **DNS rebinding protection**: async DNS resolution of hostnames, checking both
  A and AAAA records against blocked IP ranges (skipped for literal IPs and
  localhost to avoid latency in tests)
- **Exfiltration URL check**: delegates to `isExfiltrationUrl()` from
  `content-security.ts`
- **Hostile domain check**: delegates to `assertSafeNavigation()` from
  `hostile-domains.ts`

`escapeRegExp()` is exported for the `frame --url` command to prevent ReDoS
when constructing RegExp from user input.

## Layer 3: Scoped Token System

`token-registry.ts` implements per-agent permission control. Scope hierarchy
(independent, not nested):

| Scope | Commands | Risk level |
|-------|----------|------------|
| `meta` | status, tabs, screenshots, snapshots | Safe introspection |
| `read` | text, html, links, forms, css, attrs | Page content extraction |
| `write` | click, fill, goto, scroll, wait | Page interaction |
| `admin` | js, eval, cookies, storage, headers, stop/restart, handoff | Dangerous |

`TokenRegistry` manages token lifecycle: `register()`, `get()`, `revoke()`.
Two factory methods:
- `createFullAccessToken()` -- all 4 scopes, used by the main CLI
- `createSidebarToken()` -- read + write + meta (no admin), used by sidebar agents

Rate limiting: per-token sliding window (default 60s). `checkRateLimit()` consumes
one credit per call and returns `false` when exhausted.

Domain restriction: `matchesDomain()` supports exact match and wildcard subdomains
(`*.example.com`). Domain checks are skipped for `meta`-scope commands.

`checkPermission()` is a pure function: token + command + optional URL -> allow/deny
with reason string.

## Layer 4: Hostile Domain Blocklist

`hostile-domains.ts` provides a hardcoded, code-level blocklist (not configurable
via YAML or env). Current entries include Xiaohongshu, Douyin, Weibo, LinkedIn,
and Instagram CDN domains.

Three enforcement functions:
- `isHostile(url)` -- hostname suffix match at hostname boundaries
- `assertSafeNavigation(url, env)` -- throws `HostileDomainError` unless
  `BROWSE_INCOGNITO=1` (for legitimate research with clean profile)
- `filterHostileCookies(cookies)` -- strips hostile-domain cookies regardless
  of incognito mode

Design rule: `filterHostileCookies` takes NO env parameter. Cookies for hostile
domains are ALWAYS filtered so the cookie file is safe to load even if a future
caller forgets the incognito flag.

## Daemon Security

`server.ts` binds to localhost only (127.0.0.1 or Unix domain socket at
`/tmp/nightcrawl-*.sock`). Auth tokens are generated per server lifetime via
`crypto.randomUUID()`. State file permissions are `0o600` (owner-only).

`cli.ts` validates server identity via HTTP health checks before adopting orphan
daemons. Lockfile-based concurrency control (`acquireServerLock`) prevents
duplicate daemon races.

## Verification Surface

Test files:
- `test/content-security.test.ts` -- all 4 content security layers
- `test/url-validation.test.ts` -- scheme/IP/metadata blocking
- `test/url-validation-hostile.test.ts` -- hostile URL variants
- `test/scoped-tokens.test.ts` -- permission checks and rate limiting
- `test/adversarial-security.test.ts` -- adversarial input fuzzing
- `test/hostile-domains.test.ts` -- blocklist enforcement
- `test/server-auth.test.ts` -- daemon auth validation
- `test/ipv6-dns-hardening.test.ts` -- IPv6 + DNS rebinding
- `test/sidebar-security.test.ts` -- sidebar token restrictions
