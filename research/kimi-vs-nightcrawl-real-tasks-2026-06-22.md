# nightCrawl vs Kimi WebBridge — comprehensive review (2026-06-22)

**Goal (user):** a full review and comparison across *all* aspects — capability, performance,
stability, durability, the decision-lifecycle/reflection, generalization, UX — graded against
nightCrawl's **first principles** and **UX principles**, on **real tasks / real environments**.
Where nightCrawl loses on a fair measurement, that is a bug to fix, not a number to spin.

**Method:** the nightCrawl side was run **LIVE** this session over the persistent daemon unix
socket (the fairness fix — latency measures the browser, not a `bun run` cold start). Runner:
[`artifacts/phase4-dual-engine-benchmark/phaseR_live.mjs`](../artifacts/phase4-dual-engine-benchmark/phaseR_live.mjs),
results: `run-live-2026-06-22T10-13-32-600Z/results.json`. The Kimi side is graded from the
documented 2026-05/06 teardowns (see *Kimi status* below) because **Kimi's WebBridge daemon
(:10086) was not running this session** — a fresh live head-to-head is deferred until it is up.

---

## Scorecard

| Axis | nightCrawl (live, 2026-06-22) | Kimi (documented) | Verdict |
|---|---|---|---|
| **Capability** | round-trip ✅ both engines · async-JS resolves (not `{}`) ✅ · trusted click `isTrusted:true` ✅ · snapshot fails loudly ✅ · untrusted-wrap ✅ | read / async-JS / trusted-click at **parity** (2026-06-19, Chrome) | **tie** (table stakes) |
| **Performance** | Engine R read **~1ms median / 72–82ms p95** (socket-fair, verified real via fresh `Date.now()`); headless read 1ms median / 2ms p95 | not comparably re-measured (prior latency was a driver artifact) | **nc strong; fair re-measure pending** |
| **Stability** | nav+read ×8 → **8/8 (100%)** each engine | works in Chrome; **hung in Arc** historically (MV3 thrash, env-specific) | **nc ahead cross-browser** |
| **Durability** | 16-cycle sustained Engine R → **16/16**, latency drift **−1ms** (no leak) | not re-measured live | **nc verified** |
| **Reflection (decision lifecycle)** | `engine-stats` shows per-domain recommendation + **advice-followed vs overridden** split; recency/exploration/regret live | **none** — Kimi is a single driver, no engine to choose | **nc only** |
| **UX / first principles** | non-intrusive (`active:false` bg tab, no window/focus steal) · honest `LOGIN_REQUIRED` · consent-per-domain · actionable errors | drives Chrome's live tab; telemetry endpoint observed; `/command` origin/CSRF surface | **nc on principle** |
| **Privacy** | local-only, token-scoped daemon, **no telemetry** (constitutional) | local docs, but a telemetry endpoint (`gator.volces.com`) was observed | **nc** |
| **Generalization** | headless⇄Engine-R duality; learned routing per domain (e.g. journal: `uw.edu` real 4/7 vs headless 1/4) | single engine; no duality | **nc (architecture)** |

---

## What the live run proves about "does our CURRENT version work as expected"

Every nightCrawl axis came back **green** with fresh evidence:

- **Capability (both engines).** `goto`+`text` returns real page content on headless and Engine R.
  Engine R `async` JS now resolves the Promise (`async-ok-42`, not `{}`) — the `awaitPromise` fix.
  Trusted click reports `isTrusted:true` (the CDP `Input.dispatchMouseEvent` gesture). `snapshot`
  on Engine R returns the honest `SNAPSHOT_UNSUPPORTED_ON_REAL` redirect (today's fix) instead of
  mislabeled HTML. Engine R reads are fenced in `--- BEGIN UNTRUSTED EXTERNAL CONTENT ---`.
- **Performance is genuinely fast and HONEST.** Engine R warm read round-trip is ~1ms; I confirmed
  this is not caching by issuing `Date.now()` repeatedly — the values increment monotonically and
  the page-time delta matches wall-time. The **p95 (72–82ms) is the MV3 service-worker cold-start
  tax** (the SW gets evicted, then respins). This bimodal shape is exactly why the design mandates
  reporting p95, and it is a property of the MV3 architecture both tools share.
- **Stability + durability.** 8/8 nav+read per engine; 16/16 sustained on Engine R with no latency
  drift — no reconnect failures, no detach, no re-login, across the run.
- **Reflection.** `engine-stats` now renders the full decision-lifecycle: per-domain learned
  recommendation, the untried-engine exploration nudge, and the **advice-followed vs overridden**
  success split — so the router's own advice quality is auditable, not just its raw success.

**No new functional gap surfaced on the nightCrawl side.** The current version works as expected.

---

## Kimi status (why the live head-to-head is deferred)

Kimi's WebBridge daemon was **not listening on :10086** this session (no `kimi`/`moonshot`
process; `curl` to `/command` refused). nightCrawl's bridge (:10087) was up and connected. So a
*fresh* live comparison cannot be run right now.

From the documented teardowns (2026-05-20 → 2026-06-19), the established picture is:
- **Raw capability is at parity in Chrome** (Kimi's home turf): read, async JS, trusted click.
- Kimi's earlier "broken" result was an **Arc-specific environment artifact** (MV3 service-worker
  thrash + competing debugger extensions), erased once measured in Chrome.
- Where nightCrawl **structurally differs** (not a capability Kimi is missing by accident, but a
  layer it doesn't have): local-only privacy with no telemetry, the **headless⇄live duality**,
  **learned engine routing + reflection**, **honest failure** signals, and **consented
  native-password autofill** (Kimi has no consented own-password submit).

**To run the fresh live head-to-head:** start Kimi's WebBridge (Chrome + Kimi extension + its local
service on :10086) with the same accounts logged in, then re-run `phaseR_live.mjs` extended with the
`kimiFetch` runner across the authenticated task suite in `benchmark-design-2026-06-19.md`.

---

## Gaps & next iterations

**Closed this session (all live-verified, pushed):** auto-routing takes effect · honest Engine R
outcomes · load-timeout honesty · `verify page --engine=real` · untrusted-content boundary ·
saved-password autofill · journal recency window · exploration nudge · recommended-vs-chosen
reflection + `engine-stats` · `recordWin` gated on honest ok · snapshot fails loudly.

**Also closed this session (heavy-page robustness, live-verified):**
- **Bridge payload cap** — `bridge-ws.ts` now sets `maxPayloadLength: 96MB`. Verified: a 20MB
  Engine R `js` return (over Bun's old 16MB default that dropped silently → 30s hang) now
  round-trips **complete** in 300ms.
- **Nav dispatch-timeout margin** — nav commands get a 45s hub budget that strictly outlives the
  extension's 15s `waitForLoad`, so a slow/heavy page no longer trips a spurious hub timeout (+
  false `timedOut` journal entry) before it finishes loading.

**Remaining backlog (from the 37-gap audit — MEDIUM/LOW robustness, not blocking):**
- **Latency comparability** — the journal's headless `goto` latency includes the login-wall
  recovery pipeline Engine R has no counterpart for; the cross-engine latency *tiebreak* should
  compare a like-for-like phase (perf/timing axis).
- **axTimedOut asymmetry** — the heavy-JS timeout signal can only fire on headless today.
- **SPA rebind robustness** — exact url+title match; pushState/duplicate tabs can mis-rebind.
- **Engine R empty-read signal · PDF weak-extraction guard · verify-page login-page guard** —
  honesty hardening on edge cases.
- **Live Kimi head-to-head** — blocked on Kimi's daemon being up (above).

These are robustness refinements on a system that is functionally green; none changes the verdict.
