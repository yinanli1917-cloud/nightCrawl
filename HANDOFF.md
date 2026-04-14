# HANDOFF -- 2026-04-14 (Session 6 -- product reframe + consent-based handoff)

## What this session was

A long, conversational session that started as "verify Session 5's auto-updater works" and ended as a wholesale re-anchor of what nightCrawl actually IS, plus a regression-fix-as-redesign for the handoff system.

The product identity got a complete reframe (with the user's pushback driving it). Per-domain consent landed for the auto-handoff path. A pile of product knowledge that lived only in Apple Notes is now in-repo.

## What's done

### A. Product identity captured (memory + repo)

Every important product/UX/safety decision from this session is now in `/Users/yinanli/.claude/projects/-Users-yinanli-Documents-nightCrawl/memory/`:

- `project_product_identity.md` — **nightCrawl is a background browser FOR AI agents using user's real logged-in context. NOT a stealth/hacker tool.** This is the reframe the user demanded after I kept calling it "stealth."
- `project_wedge_positioning.md` — "Hermes owns terminal, Claude Code owns coding, nothing owns browser-as-you. That's the wedge."
- `project_user_scenarios.md` — green/yellow/red scenarios. China Judgments, Midjourney, Gemini, social uploads = green. Trading = yellow (needs gates). XHS posting = deleted.
- `project_open_todos.md` — user's running todos from Apple Notes + this session's decisions.
- `project_cloakbrowser_default_decision.md` — flip CloakBrowser to default; delete PW engine path; no Chrome for Testing.
- `project_canvas_regression_2026_04_14.md` — incident record for why the consent-per-domain design exists.
- `feedback_no_stealth_framing.md` — never call nightCrawl a stealth/hacker tool to the user.
- `feedback_proactive_handoff_ux.md` — the full proactive handoff design (consent + always-on detection + default-browser path).
- `feedback_universal_safety_layer.md` — every scenario needs gates, not just trading.
- `reference_product_docs.md` — map of in-repo docs, Apple Notes, external research.
- `reference_cloakbrowser_explainer.md` — plain-English answer to "what is CloakBrowser / do we still use Playwright."

`MEMORY.md` index updated with all of these. **Read the "Product Identity" section first when opening a new session.**

Apple Notes also captured in-repo at `docs/product-notes/` (5 markdown files + README index) so external readers / future sessions don't need Apple Notes access.

### B. Consent-based handoff (the Canvas regression fix)

**Problem solved:** UW Canvas (and any SSO-protected institutional site) was broken by commit `520a253` (2026-04-11) which flipped `BROWSE_AUTO_HANDOVER` to opt-in to fix an unrelated silent-popup on quark.cn. That punished well-behaved domains (Canvas worked autonomously thousands of times pre-520a253) to protect against unknown ones. Manual `handoff`/`resume` doesn't poll — agent guesses timing wrong, captures half-written cookie jar, Canvas re-bounces.

**Fix layer (right one this time):** consent is per `(agent-session × eTLD+1 domain)`, persisted to `~/.nightcrawl/state/handoff-consent.json` with TTL. Detection always runs. Window-pop gate moved from env var → consent store.

**New module:** `stealth/browser/src/handoff-consent.ts` (210 lines)
- `eTldPlusOne(urlOrHost)` with handcrafted two-level public-suffix list (`.co.uk`, `.com.cn`, `.edu.cn`, `.com.au`, `.co.jp`, `.com.hk`, etc.)
- `readConsent` / `writeConsent` (atomic, missing-file safe)
- `grant` / `revoke` / `isApproved` / `prune` (immutable ops, return new store)
- `defaultConsentPath()` → `~/.nightcrawl/state/handoff-consent.json`

**Modified `browser-handoff.ts`:**
- `detectLoginWall` removed env-var gate. Always runs (still skipped in headed mode). Returns `{ detected, reason, domain, approved }`.
- `autoHandover` has belt-and-suspenders consent check before opening any window. Returns `CONSENT_REQUIRED: <domain>` if called directly without prior approval.
- All four detection paths (URL pattern, password input, QR code, Chinese auth-barrier text) wrapped through `withConsent()` helper.

**Modified `server.ts`:** branches on `detection.approved`:
- approved → fire-and-forget `autoHandover()` (full polling autonomous SSO handling, the good code from `browser-handoff.ts:445-533`)
- not approved → `CONSENT_REQUIRED: <domain>` in HTTP response + macOS notification, no window opens

**New meta-commands** (`stealth/browser/src/meta-commands.ts` + `commands.ts`):
- `grant-handoff <domain-or-url> [ttl-days]` — approve auto-handoff for a domain (default 30 days)
- `revoke-handoff <domain-or-url>` — revoke
- `list-handoff` — list approved domains with grant + expiry dates

**Tests:**
- `test/handoff-consent.test.ts` — 16 unit tests for the consent module
- `test/login-wall-detection.test.ts` — rewritten for new shape; snapshots/restores user's real consent file so test runs never pollute it
- All passing: 31 in the touched files, 96 in the broader handoff/safety/auto-update suite

### C. macOS notifications (new helper)

**New module:** `stealth/browser/src/notify.ts`
- `notify(title, body)` — best-effort, fire-and-forget AppleScript notification
- macOS-only; no-op on other platforms
- Opt-out via `NIGHTCRAWL_NO_NOTIFY=1`
- Wired to fire on `CONSENT_REQUIRED` so user sees the prompt even when not watching the chat

**Tests:** `test/notify.test.ts` — 4 smoke tests (never throws, escape safety, kill switch).

### D. Documentation

- `CLAUDE.md` updated: handoff section reflects consent-per-domain (replaces opt-in env-var description); new commands documented; product-notes dir listed.
- `docs/product-notes/` — 5 Apple Notes preserved as markdown.

## Test status

```
96 pass, 0 fail across:
  - test/handoff-consent.test.ts         (16, NEW)
  - test/login-wall-detection.test.ts    (11, REWRITTEN for consent shape)
  - test/notify.test.ts                  (4, NEW)
  - test/hostile-domains.test.ts         (26, unchanged)
  - test/browser-manager-hostile.test.ts (6, unchanged)
  - test/update-snapshot.test.ts         (11, unchanged)
  - test/update-executor.test.ts         (6, unchanged)
  - test/auto-updater.test.ts            (14, unchanged)
  - test/stealth-reinforcement.test.ts   (6, unchanged)
```

**Pre-existing flakes (NOT regressions from this session):**
- `test/handoff.test.ts > resume without prior handoff works via meta command` — times out at `ariaSnapshot()`. Caused by commit `8dc179a` (Waves 2-5) which bumped Playwright 1.58.2→1.59.1 without re-porting CDP patches. Subagent investigation in this session confirmed the root cause.
- `test/cnki-login.test.ts` — Playwright `Disposable` channel mismatch from same PW 1.59.1 issue.

## What's deferred (next session)

### P1: CloakBrowser-as-default flip
- Decision is made (`project_cloakbrowser_default_decision.md`).
- Today's E2E test (Session 5 verifier test) revealed the verifier launches stock Playwright, not CloakBrowser — so all stealth-verification signals were testing the wrong engine. Flip `engine-config.ts` default from `playwright` → `cloakbrowser`, point verifier at CloakBrowser, delete the PW-engine code path. This also kills the PW 1.59.1 / CDP patches mismatch that breaks the two pre-existing test flakes — the patches become dead code.
- Risk: CloakBrowser binary auto-downloads ~200MB on first use; need to make sure error path is loud, not silent fallback to broken PW engine.

### P2: Default-browser handoff (open user's Arc/Chrome instead of headed Chromium)
- Designed in `feedback_proactive_handoff_ux.md` step 6.
- Why deferred: cookie sync from Arc/Chrome → nightCrawl daemon requires `cookie-import-browser`, which triggers Keychain dialog (per `feedback_no_windows.md` — user has been burned by this multiple times). Can't silently re-import after user logs in their default browser.
- Resolution path: either (a) accept Keychain prompt as part of the user-approved handoff flow (it's expected at that point), or (b) keep using spawned headed CloakBrowser as the only handoff medium.
- Requires user input on which path before coding.

### P3: Auto-updater verifier baseline comparison
- Today's E2E test showed the verifier reports "FAIL" on both pre-update and post-update versions because Playwright-engine has known stealth gaps. Rollback fires on every update.
- Fix: compare `verifyStealth()` output BEFORE update vs AFTER update. Only roll back if post is *worse* than pre. (Naturally, this becomes trivial after P1 — CloakBrowser engine should pass these sites cleanly.)

### P4: User-facing health command
- `browse health` → plain-English report ("✅ Google, ✅ Zhihu, ❌ bot.sannysoft").
- Non-technical user must be able to verify nightCrawl works without reading logs.
- Use the same `verifyStealth()` infrastructure but with friendly output.

### P5: Pre-existing handoff/snapshot test flakes
- Two tests time out on `ariaSnapshot()` under PW 1.59.1.
- Becomes dead code if P1 (CloakBrowser-only) ships, since CDP patches go away.
- If P1 deferred further, re-port CDP patches against PW 1.59.1 directly.

### Bigger product moves (from `project_open_todos.md` + Apple Notes)

Not for next session necessarily — these are months of work, listed so they're not forgotten:

- **Six moat features** from `docs/product-notes/agent-centric-roadmap.md`: intent-level API, habit memory, intent-based HITL, per-action trust scopes, audit log as product surface, passive observation mode ("watch me work").
- **Hermes-pattern adoptions** from `docs/product-notes/hermes-agent-synthesis.md`: COMMAND_REGISTRY central dispatch, progressive disclosure for skills, fenced memory injection (prompt-injection defense), subagent delegation with hard blocklist, profiles via env-var-before-import.
- **Bridge to Hermes**: ship `nightcrawl/skills/browser-twin` as a Hermes-installable skill that registers nightCrawl's MCP endpoint. nightCrawl owns "browser-as-you," Hermes owns terminal+messaging, the skill is the bridge.
- **Landing page scenarios** (from running todo): AI-information export, Canvas assignments, tax filing, customer-service battles, judgment search, etc. — to brainstorm + design.
- **Onboarding UX**: iOS-style cookie permissions ("import all / import per-domain / never"), folder path setup, persuasion that it's safe.
- **Question to answer**: skill vs standalone CLI as the final user-facing form?

## Working tree at handoff time

Clean except `bun.lock` change introduced earlier in session by the auto-updater E2E test (cloakbrowser entry was missing from the lockfile pre-session — `bun install` properly added it). Included in this session's commit.

## Account safety reminders (still load-bearing)

- Hostile-domain blocklist in `stealth/browser/src/hostile-domains.ts` is HARDCODED. Do NOT make it configurable.
- Tier 5 testing (XHS posting) is DELETED from the roadmap, not deferred. Do not re-add it.
- New feature with write-access to user accounts → ship with safety gate in the same PR (per `feedback_universal_safety_layer.md`).

## Memory state

`MEMORY.md` index reorganized with a "Product Identity" section at the top. Future sessions should read those files first. Total memories: 23 (was 20).

---

*Created by Claude Opus 4.6 (1M ctx) — 2026-04-14, Session 6. Conversational pivot from "verify Session 5" → "rebuild product identity" → "ship consent-based handoff fix for UW Canvas regression."*
