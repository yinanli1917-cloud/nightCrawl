# nightCrawl vs Kimi WebBridge — real-task benchmark design

**Date:** 2026-06-19
**Goal:** measure nightCrawl against Kimi WebBridge on the four axes the user named —
**UX, performance, stability, durability** — using *real authenticated tasks*, not neutral
capability probes. The benchmark is built to be **fair and falsifiable**: where nightCrawl
loses, that is a bug to fix, not a number to spin.

---

## Why this benchmark exists (what the last one got wrong)

The 2026-06-19 capability run (`research/kimi-vs-nightcrawl-chrome-vs-arc-2026-06-19.md`) reached
parity on neutral sites but had two honesty holes we must close here:

1. **Latency was a driver artifact.** nightCrawl was driven by spawning `bun run src/cli.ts`
   *once per command* (cold-start ×2 per cycle); Kimi was a single `curl` to a persistent
   daemon socket. The numbers (nc ~150 ms vs kimi ~25 ms) measured the *test harness*, not the
   browser. **Fix: drive both tools over their persistent daemon sockets.** nightCrawl has a
   unix-socket daemon (`/tmp/nightcrawl-*.sock`); Kimi listens on `:10086`. Same transport class
   → comparable latency.
2. **A recorded Kimi failure (T3) was a harness artifact**, manually disproven 4×. **Fix:** any
   per-tool failure is reproduced manually before it is recorded as a result; non-reproducible
   results are marked artifact, not result.

Neutral capability is table stakes and already at parity. This benchmark moves to the layer that
actually decides the product: **real authenticated work done as the user, without interrupting
the user.**

---

## Runners

| Runner | Engine | Browser | Transport | Auth source |
|---|---|---|---|---|
| `nc-headless` | CloakBrowser | headless Chromium | nc daemon unix socket | imported cookies |
| `nc-real` | Engine R | user's **Arc** (live) | nc daemon unix socket → bridge WS | live Arc session |
| `kimi` | WebBridge | user's **Chrome** (live) | `:10086` HTTP socket | live Chrome session |

Each tool runs in its **home environment** (Kimi/Chrome, nightCrawl/Arc + headless). Both
browsers are **already logged in** before the run starts.

---

## The four axes → concrete, observable metrics

Every metric is scored from a recorded artifact (JSON log + screenshot), never self-reported.

### Axis 1 — UX (the digital-twin experience)
The product thesis: *act as you, in the background, without taking over your screen.*

| Metric | How measured | Scoring |
|---|---|---|
| **Re-login when already authed** | task hits `LOGIN_REQUIRED`/`Duo`/`sign in` though the browser holds the session | **any occurrence = task FAIL** (user's first principle) |
| **Focus interruptions** | count of focus-steals / tab-jumps / windows popped over the user's work during the task | 0 = full marks; each interruption −1 |
| **Manual steps** | human actions required to finish (a 2FA tap is honest/unavoidable and labeled separately) | fewer is better; 0 = fully autonomous |
| **Consent behavior** | does it ask once and remember (SSH-style), nag, or silently act? | ask-once-remember = 2, nag = 1, silent = 0 |
| **Error legibility** | on failure, is the message actionable (`LOGIN_REQUIRED` + fix) or opaque (HTML/hang)? | actionable = 2, vague = 1, opaque/hang = 0 |
| **Deliverable fidelity** | did it return the actual asked-for data (DVC `VERIFY_OK` + on-disk artifact)? | verified = 2, partial = 1, empty/wrong = 0 |

### Axis 2 — Performance (apples-to-apples, socket-driven)
| Metric | How measured |
|---|---|
| **Time-to-first-result** | dispatch → first usable data, over the persistent socket |
| **Time-to-deliverable** | task start → `VERIFY_OK` artifact on disk |
| **Per-command latency** | median **and p95** over N identical ops on the *same* page (navigate / read / eval / click) |

Report median **and p95** — tail latency is what hurts long sessions. Single medians hide it.

### Axis 3 — Stability (does it work every time)
| Metric | How measured |
|---|---|
| **Success rate** | N=10 runs per task; % reaching `VERIFY_OK` with no re-login / hang / error |
| **Error taxonomy** | each failure classified: timeout · hang · detach · re-login · wrong-result |
| **Transient recovery** | induce a disconnect (Engine R: SW eviction; Kimi: socket drop) mid-task → does it self-heal and finish? |
| **Heavy-JS resilience** | a real heavy SPA: does the read complete, and does learned routing pick the engine that wins? |

### Axis 4 — Durability (endurance over a long session)
| Metric | How measured |
|---|---|
| **Sustained run** | 50 navigate+read cycles on an authed page; success rate over time (decay?) |
| **SW-eviction survival** | Engine R idle past MV3 eviction (~30 s+), then resume — reconnect + complete? (Kimi: same idle test) |
| **Restart persistence** | restart daemon (+ browser) → session persists, **no re-login**? |
| **Latency drift** | does per-command latency grow across the 50-cycle run? (leak signal) |

---

## Real task suite (authenticated green scenarios; both browsers logged in)

All are the user's own legitimate sessions. **No main accounts on hostile platforms** (no XHS);
the login-autofill task uses a public practice site with a saved password, not a real account.

1. **Research behind a login** — Canvas dashboard → extract a structured deliverable (assignments
   + due dates) → DVC verify. (Green scenario: research behind logins.)
2. **Paywalled paper via EZproxy** — UW Libraries: reach a paywalled article's full text/PDF →
   DVC verify. *This is the duality showcase:* `nc-headless` is expected to hit the Shibboleth
   wall (documents **why** Engine R exists); `nc-real` and `kimi` drive the live session.
3. **Multi-step extraction** — a real site: navigate → search → paginate → extract a structured
   table → DVC. (Tests multi-command sequencing + result fidelity.)
4. **Heavy-JS SPA read** — a real JS-rendered dashboard → read rendered content. (Axis 3 + 4;
   exercises learned routing.)
5. **Login-autofill (C1)** — public saved-password practice site: consent → trusted submit →
   logged in; a 2FA variant → reaches the 2FA step → hands back. (nightCrawl-only capability;
   Kimi has no consented native-password submit.)
6. **Durability loop** — 50 navigate+read cycles on an authed page: success rate, latency drift,
   **0 focus interruptions** (verifies the focus-steal fix under load).

---

## Grading & integrity

- **DVC gate:** no task scores `pass` without `VERIFY_OK` + an on-disk artifact
  (`stealth/browser/src/deliverable-verify.ts`).
- **Adversarial verification:** a second pass tries to *refute* each `pass` (re-open the
  artifact, re-derive the claim). A pass that can't be reproduced is downgraded.
- **Manual reproduction of failures:** any recorded per-tool failure is reproduced by hand first;
  non-reproducible → marked harness artifact, not a result.
- **Privacy delta (re-confirmed, not re-scored):** Kimi's daemon ships command telemetry to
  `gator.volces.com` and its `/command` endpoint accepts hostile `Origin`s (CSRF surface), per
  the 2026-05-20 teardown. nightCrawl: no telemetry, token-scoped local daemon.

## "Beat Kimi" definition
nightCrawl wins the benchmark only if, **with no honesty caveat hiding a loss**, it wins or ties
on every axis — and strictly wins on the axes the product is built for (UX: focus/consent/no
re-login; the headless⇄Engine-R duality on task 2; consented native-password autofill on task 5).
Anywhere nc loses on a fair measurement, the result is filed as a **bug to fix before re-running**,
not spun.

---

## Output artifacts
- `artifacts/phase4-real-task-benchmark/run-<stamp>/results.json` + per-task screenshots + logs.
- `research/kimi-vs-nightcrawl-real-tasks-2026-06-19.md` — scorecard with evidence links and every
  caveat disclosed.

## Prerequisites (build before running)
1. **Socket-fair runner** — drive nc over its persistent unix socket (verify against `nc-headless`
   first; no reload needed). This is the fairness fix; without it the performance axis is invalid.
2. **Focus-steal fix live-verified** — Engine R click while the user works in another window:
   confirm 0 focus interruptions AND the click still lands (`isTrusted:true`). *Needs the
   extension reload.*
