# Kimi WebBridge Reliability Diagnosis

Date: 2026-05-20

## Bottom line

Kimi WebBridge is not architecturally unserious. The design is a strong and obvious fit for identity-heavy browsing: local daemon, real Chrome/Edge extension, Chrome DevTools Protocol, real user profile, and existing login state. The failures observed in our tests are better described as local bridge/session reliability failures in this Chrome environment, not as proof that the product cannot perform.

The current evidence says our local WebBridge installation is broken enough that even simple pages fail after navigation. This is not target-site complexity. A local fixture and `example.com` both showed the same pattern: Chrome receives/loads the page, but the daemon-side command times out; later `evaluate`, `snapshot`, `click`, or `mouse_click` return HTTP 502; session tab lists are empty.

## Evidence

- Official architecture: Kimi says WebBridge pairs a local service with a browser extension, and the extension uses Chrome DevTools Protocol to navigate, click, screenshot, and read pages in the user's existing Chrome/Edge browser.
- Official failure guidance: Kimi says that when pages open but `snapshot`, `evaluate`, `screenshot`, or `click` keep failing, the common cause is conflict with other browser extensions, especially scraping tools, helper extensions, screen recording extensions, and AI assistant extensions.
- Installed version: daemon `v1.9.7`, extension `1.9.7`, extension id `fldmhceldgbpfpkbgopacenieobmligc`.
- Extension manifest: permissions include `tabs`, `activeTab`, `debugger`, `storage`, `alarms`, `tabGroups`, `windows`, and host permission `<all_urls>`.
- Chrome profile is not clean. Installed/conflicting-relevant extensions include:
  - Claude extension: `debugger`, `scripting`, `tabGroups`, `tabs`, `webNavigation`, `nativeMessaging`, `<all_urls>`.
  - Tampermonkey: `webRequest`, `webRequestBlocking`, `scripting`, `userScripts`, `cookies`, `<all_urls>`.
  - DeepL: `activeTab`, `tabs`, `scripting`, `webRequest`, `cookies`.
  - New Bing Anywhere: `webRequest`, `cookies`, broad search/OpenAI host access.
- Kimi daemon logs from the official-case run show repeated WebSocket disconnect/reconnect loops and stale tab messages. One grep over the current and previous daemon logs found 1,467 matching command/connection/failure lines, with the previous log accounting for 1,458 of them.
- Minimal reliability probe after daemon restart:
  - `navigate https://example.com/`: timed out after 25.0s.
  - `evaluate` at 0s, 2s, 6s, and 12s after navigate: HTTP 502.
  - `snapshot`: HTTP 502.
  - `list_tabs`: succeeded but returned zero tabs.
- Local fixture targeted rerun:
  - The local HTTP server served `GET /main.html`.
  - Kimi `navigate` still timed out after 18.0s.
  - Follow-up `click`, `evaluate`, and `mouse_click` returned HTTP 502.
  - `close_session` succeeded but closed zero tabs.

## Important correction to the earlier benchmark

The installed extension contains stronger tools than the public skill file exposed during the first benchmark:

- `mouse_click` uses CDP `Input.dispatchMouseEvent`.
- `key_type` uses CDP `Input.insertText`.
- `send_keys` uses CDP `Input.dispatchKeyEvent`.

That means the earlier "trusted click failed" result only applies to Kimi's DOM-level `click` path, not necessarily to Kimi's strongest input path. The stronger path could not be fairly measured because the bridge/session layer is currently failing before interaction.

## Likely root causes

1. Browser-extension conflict or profile-level interference is the leading hypothesis.
   - This exactly matches Kimi's own FAQ pattern: page opens, but `snapshot`/`evaluate`/`click` fail.
   - Our Chrome profile has multiple extensions with all-URL, debugger, scripting, webRequest, and native messaging capabilities.

2. Session binding is fragile under disconnect/reconnect.
   - Logs show stale tab IDs and recurrent WebSocket reconnects.
   - The visible browser can open a tab while the daemon's session model loses ownership of it.
   - Result: `list_tabs` returns empty and later commands fail with 502.

3. Our benchmark initially underused Kimi's capability surface.
   - We used the documented skill API, but the installed extension exposes additional low-level input primitives.
   - Future comparisons must include DOM click, CDP mouse click, key typing, and keyboard shortcuts separately.

4. Target-site complexity is not the primary explanation.
   - Amazon, YC Jobs, UW, and Google Sheets are all complex enough to fail for many reasons.
   - But `example.com` and a local static fixture reproduced the same bridge failure pattern.

5. The raw local API is weaker than the product orchestration.
   - Kimi Desktop/Kimi Agent may add retry, active-tab repair, and instruction planning around the raw bridge.
   - Our side-by-side test used the local bridge API directly, which is still relevant for Codex/local-agent support, but may understate the fully integrated Kimi UX.

## What nightCrawl should learn

Kimi's strongest product insight is real-browser identity leverage. It can use the user's already-authenticated Chrome/Edge profile without exporting cookies or asking for a separate headless identity. That is a better UX for identity-pinned tasks, SSO, and fingerprint-sensitive flows.

nightCrawl should not copy this as the only mode. We should add it as a deliberate "real browser bridge" mode while keeping CloakBrowser/headless as the default for batch work, stealth work, repeatability, and non-disruptive automation.

Concrete improvements:

- Add a real-browser bridge mode:
  - Attach to Chrome/Arc/Edge when the user explicitly chooses "use my live browser".
  - Support active-tab mode, owned-tab mode, and visible session mirror.
  - Keep domain-scoped consent and audit logs.

- Harden session ownership:
  - Store stable tab identity with URL/title/group fallback.
  - Detect stale tab IDs immediately.
  - Rebind after extension/daemon reconnect by active tab, tab group, URL, and last known task.
  - Expose session state as "connected / attached / stale / recovering / failed".

- Split action primitives:
  - DOM click/fill for simple pages.
  - CDP mouse/key input for sites that require browser-level events.
  - OS-level handoff only when real trusted user input or WebAuthn/2FA/captcha is required.

- Build an extension-conflict diagnostic:
  - Enumerate installed extensions and permissions.
  - Flag `debugger`, `<all_urls>`, `webRequestBlocking`, `nativeMessaging`, `scripting`, screen recording, AI assistant, and scraper classes.
  - Run a five-step health probe: connect, navigate local static page, evaluate, snapshot, mouse click.
  - Produce a plain-language repair suggestion before a benchmark starts.

- Improve UX beyond Kimi:
  - Show a live status panel: browser, profile, extension, tab owner, last command, current URL, last error, recovery action.
  - Make reconnects visible and recoverable instead of surfacing generic 502s.
  - Provide a one-click "clean test profile" and "real user profile" toggle.
  - Never surprise-open windows on unapproved domains.

- Improve security posture:
  - Require a local auth token on command endpoints.
  - Enforce origin checks for all HTTP commands, not only WebSocket.
  - Keep telemetry local by default; if analytics exist, make them opt-in and content-free.

## Benchmark changes needed

The next suite should measure:

- Cold start and warm action latency.
- Navigate success and load-state handling.
- Session retention after tab group creation, reconnect, restart, and user tab switching.
- DOM click versus CDP mouse click.
- Fill versus CDP key input.
- Snapshot completeness and accessibility-tree stability.
- Cross-origin iframe handling.
- File upload.
- Google Docs/Sheets/Canvas/UW Library authenticated workflows.
- Recovery after extension conflict, daemon restart, browser restart, and stale tab ID.
- UX quality: transparency, consent, error clarity, handoff smoothness, and whether the user can see/control what is happening.

