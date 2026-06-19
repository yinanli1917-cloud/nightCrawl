# Kimi-in-Chrome vs nightCrawl-in-Arc — capability + reliability head-to-head

**Date:** 2026-06-19
**Environment:** Kimi WebBridge in **Chrome** (its tested home), nightCrawl in the user's **Arc**.
Both browsers already logged in; the contract: a re-login when the browser is already
authenticated counts as a **failure**, never a silent retry.
**Engines under test:** nightCrawl **headless** (CloakBrowser), nightCrawl **Engine R** (real
Arc via the bridge), **Kimi** (real Chrome).
**Harness:** `artifacts/phase4-dual-engine-benchmark/{phase0_smoke.mjs, phaseB_capability.mjs, lib/}`.
**Runs:** `run-2026-06-19T01-47-45Z` (phase 0), `run-2026-06-19T01-56-27Z` (final phase B).

---

## TL;DR

1. **The fair-environment rematch erases Kimi's earlier failure.** In the last run Kimi *could
   not navigate* in Arc (MV3 service-worker thrash + four debugger extensions). Moved to its
   home turf (Chrome, matched daemon+extension v1.10.0), **Kimi navigates, reads, evals, and
   trusted-clicks reliably** — 5/5 on every dimension it was tested on.

2. **On raw capability the three are at parity.** Read, async JS, trusted click, and a 5-cycle
   reliability loop all pass on all three. The two fixes this session (Engine R now awaits async
   JS; Engine R clicks are now trusted) closed the gaps that *would* have shown here.

3. **nightCrawl's edge is not raw capability — it's the model around it:** privacy (everything
   local; Kimi ships command telemetry off-box), the headless⇄Engine-R duality (autonomous
   background work *and* live-session leverage), learned engine routing, and consent-gated
   autofill. Kimi is a single real-browser driver; nightCrawl is a digital-twin runtime.

---

## Phase 0 — connection matrix

| Runner | Connect | Drive | Notes |
|---|---|---|---|
| nc-headless | ✅ | ✅ | persistent imported cookies |
| nc-real (Engine R, Arc) | ✅ | ✅ | extension dialed `ws://127.0.0.1:10087`; `chrome.debugger` drove live Arc |
| kimi (Chrome) | ✅ | ✅ | daemon+extension **v1.10.0 matched**; `navigateOk: true`, **no hang** (vs the Arc hang last time) |

Kimi's action surface (probed): `navigate, find_tab, evaluate, network, snapshot, click,
fill, mouse_click, cdp, key_type, send_keys, screenshot, save_as_pdf, upload, close_tab,
list_tabs, close_session`.

---

## Phase B — capability + reliability

| Dimension | nc-headless | nc-real (Arc) | kimi (Chrome) |
|---|---|---|---|
| **T1 navigate + read** | ✅ | ✅ | ✅ |
| **T2 async JS resolves** | ✅ | ✅ | ✅ |
| **T3 trusted click (`isTrusted`)** | ✅ | ✅ | ✅ \* |
| **T4 reliability (5 nav+read cycles)** | 5/5 | 5/5 | 5/5 |

\* The scripted harness recorded Kimi T3 as `false`, but that was **not reproducible** — Kimi's
`mouse_click` produced a genuine trusted click in 4/4 manual reproductions (including with Chrome
backgrounded). The benchmark `false` traces to a tab-targeting artifact in the harness's
multi-tab Kimi sequence (T1 opens a fresh tab with `newTab:true`; tabs accumulate across runs),
not a Kimi capability limit. **Trusted click is parity.** Note: nightCrawl's `click` is *always*
trusted (it activates the bound tab + dispatches CDP `Input` with the `buttons` bitmask — both
discovered necessary by live testing this session); Kimi exposes a separate `mouse_click` for the
trusted variant (its `click` is `isTrusted:false`).

### Latency is NOT comparable here (driver artifact)

Median per-cycle latency: nc-headless ~147 ms, nc-real ~174 ms, kimi ~25 ms. This gap is the
**test driver**, not the browser: the harness drives nightCrawl by spawning `bun run src/cli.ts`
**once per command** (cold-start overhead ×2 commands/cycle), while Kimi is a single `curl` to a
**persistent daemon socket**. A like-for-like latency test would drive nightCrawl over its own
persistent daemon socket. The comparable metric is **reliability (5/5 for all three)**.

### What the two session fixes changed

- **T2 (async JS):** before this session, Engine R's in-page `js` returned `{}` for an `async`
  fetch (the Promise serialized before resolving). After the `awaitPromise` fix it returns the
  resolved value — reaching parity with Kimi's `evaluate` (which already awaited).
- **T3 (trusted click):** before this session, Engine R's `click` was `el.click()`
  (`isTrusted:false`). It's now a real CDP `Input.dispatchMouseEvent` gesture — verified
  `mousedown/mouseup/click` all `isTrusted:true` against live Arc.

---

## Where nightCrawl is actually different (beyond this capability grid)

These weren't scored above because Kimi has no equivalent, but they are the product thesis:

- **Privacy / locality.** Everything stays on the machine. Prior teardown
  (`research/kimi-webbridge-*-2026-05-20.md`) found Kimi's daemon ships **command telemetry** to
  `gator.volces.com` (daemon version, OS/arch, device id, session + tool names) and its local
  HTTP `/command` endpoint accepts hostile `Origin`s (CSRF surface). nightCrawl: no telemetry,
  token-scoped local daemon.
- **Two engines, one runtime.** Headless does autonomous **background** work with a verifiable
  deliverable (DVC); Engine R leverages the **live, fingerprint-bound** session (e.g. Shibboleth
  SSO that cookie export cannot reconstruct). Kimi only drives the real browser.
- **Learned engine routing.** nightCrawl records every outcome and *learns* which engine wins per
  domain (`engine-journal.ts`); Kimi has one mode.
- **Autofill, privacy-preserving.** `autofill` fills non-secret profile fields (gated by the
  sensitive-page detector); `autofill-login` submits the **browser's own** saved password via a
  trusted submit (consent-gated) **without ever reading the password DB**. 2FA is detected and
  handed back.
- **Honest failure.** Re-login walls surface as `LOGIN_REQUIRED`/`CONSENT_REQUIRED`; no silent
  headed pop.

---

## Verdict

In its own best environment Kimi is a competent, reliable real-browser driver — the earlier
"Kimi is broken" picture was an Arc-specific environment artifact, and the fair rematch shows
it. On raw page-control capability nightCrawl matches it (after this session's two Engine R
fixes). nightCrawl wins on the layer Kimi doesn't have: local-only privacy, the headless⇄live
duality, learned routing, and consent-gated autofill of the user's own credentials. Capability
is table stakes; the digital-twin runtime is the moat.

### Harness honesty notes

- Kimi T3 `false` is a recorded harness artifact (see \*), corrected here, not a Kimi result.
- Latency numbers are driver-bound and intentionally not used for ranking.
- Authenticated-parity tasks (Canvas/EZproxy in *both* browsers) were not run this pass — the
  capability/reliability suite is neutral-site. The earlier Phase-4 run
  (`research/phase4-dual-engine-benchmark-2026-06-17.md`) already showed Engine R reaching a
  paywalled EZproxy paper that headless could not.
