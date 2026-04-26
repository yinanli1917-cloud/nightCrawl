# HANDOFF — 2026-04-26 (Session 9)

## Completed This Session

### 1. Persistent Profile + Cookie Sync (VERIFIED WORKING)
- **Persistent profile**: `~/.nightcrawl/chromium-profile/` stores cookies natively in Chromium SQLite
- **Full sync on watch**: When user logs in default browser → cookie watcher fires → syncs ALL cookies (not just new domains)
- **Tested**: Cloudflare dashboard — login in Octave → daemon restart → still authenticated at `/home/overview`
- **Commits**: 91885b1, 1ed4ffb

### 2. No Silent Window Pops (FIXED)
- Fingerprint-pinned domains were auto-popping CloakBrowser without user approval
- Fix: ALL window pops require explicit `nc open-handoff` or notification button click
- **Commit**: 8c689cc

### 3. False Fingerprint-Pinned Classification (FIXED)
- `markPinnedObserved(url, 'cloudflare')` was called for ANY domain where cookies failed
- Google, GitHub, JSTOR, Canvas all wrongly marked as "cloudflare-pinned"
- Fix: Only mark when vendor-specific cookie markers detected (cf_clearance, _dd_s)
- **Result**: Canvas now works via cookie sync! Google Drive correctly falls through to default-browser handoff
- **Commit**: 5b37064

### 4. Canvas Access (WORKING)
- Cookie import from Arc authenticated Canvas successfully
- URL: `canvas.uw.edu/?login_success=1` — Dashboard, Courses, Groups visible

## Remaining Issues

### Google Auth (Tier-0 — Architectural Limitation)
Google cookies are genuinely not portable between browsers. Cookie import from Arc → CloakBrowser fails because Google ties sessions to browser identity + device attestation. This is NOT fingerprint-pinning (no Cloudflare involved) — it's Google's own auth system.

**Proposed solution**: Arc CDP fallback (connect to Arc via Chrome DevTools Protocol for Tier-0 domains). See previous handoff for full plan.

**Current behavior**: Correctly detects login wall → imports cookies → detects failure → falls through to "open default browser for login" without falsely marking as pinned.

### Fiction Works — Zhihu/Douban Blocking
**Root cause**: evolve-fiction skill uses WebFetch via jina.ai (L1 tier) which gets 403 from Chinese platforms.

**nightcrawl CAN access both sites** (verified this session):
- Zhihu: Full article content (齐泽克电影批评对拉康理论的应用)
- Douban: Full review (Žižek's Eyes Wide Shut analysis, 5000+ chars)

**Fix needed**: Update evolve-fiction skill to fall back to nightcrawl (L2) when jina.ai fails. The CLAUDE.md already documents L1→L2 escalation, but the skill doesn't implement it.

## Key Commits This Session
- 91885b1: Persistent Chromium profile
- 8c689cc: Fix silent auto-pop
- 1ed4ffb: Full cookie sync on watch
- 5b37064: Fix false fingerprint-pinned classification

All pushed to origin/main.

---
*Created by Claude Code · 2026-04-26T22:30*
