# HANDOFF — 2026-04-27 (Session 9 Final)

## Current Task

Session 9 achieved seamless Cloudflare/Doubao/Canvas UX, built native macOS alert for handoff approval, fixed false fingerprint-pinning, and updated global CLAUDE.md with auto-escalation rules.

## Completed

- ✅ **Persistent Chromium profile** — `~/.nightcrawl/chromium-profile/` stores cookies natively in SQLite, survives daemon restarts (commit 91885b1)
- ✅ **Full cookie sync on watch** — When user logs in default browser, ALL cookies sync to persistent profile, not just new domains (commit 1ed4ffb)
- ✅ **No silent window pops** — All handoffs require explicit user approval (commit 8c689cc)
- ✅ **False fingerprint-pinning fix** — Google, GitHub, JSTOR no longer wrongly classified as "cloudflare-pinned"; only mark when vendor-specific cookies detected (commit 5b37064)
- ✅ **Native macOS alert** — Swift .app bundle (`NightCrawlNotify.app`) using NSAlert, LSUIElement, floats on top like system permission dialogs (commit 08390d6)
- ✅ **Canvas access** — Cookie import from Arc authenticates Canvas SSO (`canvas.uw.edu/?login_success=1`)
- ✅ **Cloudflare seamless UX** — Login in Octave → daemon restart → still authenticated at `/home/overview`
- ✅ **Doubao access** — Authenticated, chat history visible
- ✅ **Global CLAUDE.md updated** — Auto-escalation (jina.ai → nightcrawl), Chinese sites skip L1, reproduce-first debugging rule
- ✅ **Health audit** — gitignore fix, duplicate skill cleanup, gstack/browse removal (~11K tokens saved)

## Key Decisions

- **Cookie sync mode**: `all-domains` on watch trigger (real-time), `new-domains-only` on poll (periodic) — prevents stale cookies from blocking re-auth
- **Fingerprint-pinning**: Only mark when vendor-specific cookies present (cf_clearance → cloudflare, _dd_s → datadome). Login wall alone is NOT sufficient evidence.
- **Notification UX**: NSAlert via compiled Swift .app bundle > terminal-notifier (broken on macOS 26) > osascript display dialog (ugly). Copy follows Apple HIG — short title, two-sentence body, action-verb buttons.
- **Google auth**: Cookies genuinely not portable (Google's own auth, not Cloudflare). Arc CDP is the right solution, not cookie import fixes.

## Known Issues / Watch Out

- **google.com re-pinning**: The code that observationally marks domains as pinned was fixed, but if an OLD daemon session runs (pre-fix code), it can re-mark google.com. Clean with: `python3 -c "import json; d=json.load(open('~/.nightcrawl/state/fingerprint-pinned.json')); d['entries'].pop('google.com',None); json.dump(d,open('~/.nightcrawl/state/fingerprint-pinned.json','w'),indent=2)"`
- **SingletonLock** — Stale lock files from unclean shutdown cause "Failed to create ProcessSingleton." Startup cleanup handles this, but if it fails: `rm -f ~/.nightcrawl/chromium-profile/SingletonLock*`
- **NightCrawlNotify.app** lives at `~/.nightcrawl/NightCrawlNotify.app` (not in repo). Source at `stealth/browser/src/notify-helper/NightCrawlNotify.swift`. Rebuild: `swiftc -parse-as-library -o ~/.nightcrawl/NightCrawlNotify.app/Contents/MacOS/nightcrawl-notify -framework AppKit src/notify-helper/NightCrawlNotify.swift && codesign --force --sign - ~/.nightcrawl/NightCrawlNotify.app`

## Macro Roadmap — Next Steps

### v0.2 (current — near completion)
1. **Arc CDP for Tier-0 domains** — Connect to Arc via Chrome DevTools Protocol for Google/Apple/Microsoft. See previous HANDOFF (2026-04-26) for full plan: `arc-cdp.ts`, Tier-0 classifier, auto-fallback.
2. **Fiction Works L2 fallback** — evolve-fiction skill already works with nightcrawl for Zhihu/Douban (verified). Global CLAUDE.md auto-escalation rule is in place. No code change needed — skills just need to follow the rule.

### v0.3 (intelligence layer)
3. **Domain-skills flywheel** — Site-specific playbooks (`~/.nightcrawl/domain-skills/`) that accumulate knowledge per domain (selectors, traps, API endpoints). nightCrawl gets smarter with every visit. (ref: Browser Harness pattern)
4. **Self-healing learned patterns** — Read-only pattern store from successful visits. When a selector breaks, check if a newer pattern exists before failing. (ref: Browser Harness self-healing helpers, adapted as read-only for security)
5. **Loop detection + stall replanning** — Rolling window of action hashes detects stuck loops; auto-replan after 3 consecutive failures instead of blindly retrying. (ref: Browser Use patterns)
6. **TLS/JA3 fingerprint masking** — CloakBrowser handles canvas/WebGL/audio but TLS fingerprint is still stock Chromium
7. **Chinese internet tiers** — Xiaohongshu, Zhihu via separate identities (test accounts only, main accounts banned)
8. **Proactive session refresh** — Monitor cookie expiry, auto-refresh before they expire during idle

### v1.0 (product)
9. **Attach-to-running-browser** — CDP connect to user's actual Chrome/Arc (solves Google auth without Arc CDP from scratch). (ref: Browser Harness DevToolsActivePort discovery)
10. **Passive observation via browsing history DB** — Analyze user's browsing patterns, suggest automations
11. **Safety gates** — Read-only default, per-action confirm, audit log for all scenarios
12. **Onboarding** — PRD's 3-mode onboarding (Full twin / Ask per domain / Manual). Second user is girlfriend — iOS-style permissions, real feedback.

## Key Files Changed This Session

- `stealth/browser/src/engine-config.ts` — profileDir field for persistent Chromium profile
- `stealth/browser/src/browser-manager.ts` — Pass userDataDir to launchCloakBrowser
- `stealth/browser/src/browser-handoff.ts` — Shared profile handoff/resume, notification-first UX, HIG-compliant copy
- `stealth/browser/src/server.ts` — Full lock cleanup, vendor-aware pinning, all-domains sync mode
- `stealth/browser/src/handoff-cookie-import.ts` — syncMode parameter (all-domains vs new-domains-only)
- `stealth/browser/src/notify.ts` — Native Swift alert integration with osascript fallback
- `stealth/browser/src/notify-helper/NightCrawlNotify.swift` — Compiled NSAlert .app bundle
- `stealth/browser/src/fingerprint-pinned.ts` — sniffVendor export for server.ts
- `~/.claude/CLAUDE.md` — Auto-escalation rules, reproduce-first debugging

## Session 9 Commits (10 total)

```
ee55a08 chore: health audit fixes
08390d6 feat(notify): native macOS alert for handoff approval
64818d2 feat(notify): modal approval dialog with warm UX copy
f03c2c4 fix(ux): notification-first handoff with manifest
26240cf docs(handoff): session 9 status
5b37064 fix(pinned): stop false-marking non-Cloudflare sites
1ed4ffb feat(sync): full Arc-to-persistent sync on cookie watch
8c689cc fix(handoff): require user approval before auto-pop
91885b1 feat(persist): native Chromium cookie persistence
a88788c feat(detect): add Turnstile detection to detectLoginWall
```

---
*Created by Claude Code · 2026-04-27T13:40*
