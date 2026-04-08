# HANDOFF — 2026-04-07

## Current Task
Architecture revolution to surpass gstack browse v0.15 in every dimension. Wave 1 complete and pushed. Waves 2-5 defined and ready for autonomous self-reinforcing execution.

## Completion Status
- ✅ Full audit: gstack browse v0.15 vs nightCrawl (content-security, token-registry, cdp-inspector)
- ✅ Full audit: MediaCrawler/MediaCrawlerPro (not a competitor — scraper vs digital twin)
- ✅ Wave 1A: Cookie revolution — Firefox + Safari import, mmap optimization (42 tests)
- ✅ Wave 1B: Content security pipeline — 4-layer defense (56 tests)
- ✅ Wave 1C: Unix domain socket IPC — 2x faster (14 tests)
- ✅ Wave 1D: Page cleanup command — 9 categories, token savings (20 tests)
- ✅ Wave 1E: Pre-warmed browser pool — 66x faster startup (7 tests)
- ✅ Integration: all 5 worktrees merged, 179 tests passing, 0 new failures
- ✅ Dependency audit complete, pushed to GitHub (55f6087 + 6f28d40)
- 🔄 Wave 2: CDP patch re-port + Playwright upgrade (CRITICAL)
- ⏳ Wave 3: Security hardening (scoped tokens, IPv6, ReDoS)
- ⏳ Wave 4: CloakBrowser integration (v0.2)
- ⏳ Wave 5: TLS/JA3, behavioral humanization

## Key Decisions
- **Product-first filter**: every upgrade must pass "does this make the twin more like you?"
- **Rejected**: actor model, event sourcing, gRPC, plugin architecture (engineering toys, not user features)
- **MediaCrawler**: scraper (extracts data FROM platforms) vs nightCrawl digital twin (acts AS you). Zero overlap.
- **gstack v0.15 has real new code**: content-security.ts, token-registry.ts, cdp-inspector.ts. But still NO stealth.
- **CDP patches 6 releases behind**: rebrowser-patches v1.0.19 changed format. MUST re-port before Playwright upgrade.

## Known Issues
- **CDP patches**: target PW ~1.48. Upgrading to 1.59 without re-porting BREAKS stealth. New format: unified .patch files.
- **Arc iCloud Keychain**: may have migrated keys to Apple's Passwords.app (yt-dlp#13710). Not confirmed broken.
- **browser-manager.ts over 800 lines**: pre-warm agent inlined stealth functions. Consider splitting.
- **Pre-existing test failures**: 2 flaky tests in commands.test.ts (not Wave 1 related).

## Next Steps — Autonomous Self-Reinforcing Evolution

Execute all waves using parallel subagents in worktrees. Each agent: research online → write tests → implement → verify → iterate.

### Wave 2: Stealth Foundation (CRITICAL PATH)
1. Re-port CDP patches from rebrowser-patches v1.0.19 (new unified .patch format)
2. Upgrade Playwright to 1.59.1 (AFTER patches)
3. Update bypass-paywalls-chrome to 4.3.4.0
4. Verify: bot-detector.rebrowser.net + bot.sannysoft.com must pass

### Wave 3: Security Hardening
1. Scoped token system (read/write/admin/meta scopes, domain globs, tab ownership)
2. IPv6 ULA full-range blocking (fc00::/7 + AAAA DNS)
3. ReDoS fixes (frame --url regex)

### Wave 4: CloakBrowser (v0.2)
1. 48 C++ patches: canvas, WebGL, audio, fonts, GPU, WebRTC
2. Drop-in Playwright replacement
3. Test against DataDome, Cloudflare Turnstile, PerimeterX

### Wave 5: Advanced Stealth
1. TLS/JA3/JA4 masking
2. HTTP/2 fingerprinting defense
3. Behavioral humanization (mouse curves, typing jitter, scroll momentum)

## Key Files Changed in Wave 1
- `stealth/browser/src/content-security.ts` — 4-layer content security
- `stealth/browser/src/cleanup.ts` — smart page noise removal
- `stealth/browser/src/cookie-import-firefox.ts` — Firefox cookies
- `stealth/browser/src/cookie-import-safari.ts` — Safari binary cookies
- `stealth/browser/src/server.ts` — UDS + parallel startup
- `stealth/browser/src/cli.ts` — UDS client
- `stealth/browser/src/config.ts` — socketPath
- `stealth/browser/src/browser-manager.ts` — pre-warm + patch caching

## Memory References
- `project_gstack_v015_audit.md` — full gstack v0.14→v0.15 diff
- `project_mediacrawler_analysis.md` — scraper, not competitor
- `project_architecture_revolution_plan.md` — 4-wave plan

---
*Created by Claude Code · 2026-04-07*
