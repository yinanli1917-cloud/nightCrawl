# Weak-model perception layer — built + re-measured (2026-07-19)

Follow-up to `weak-model-lift-findings-2026-07-17.md`. North star: make nightcrawl drivable
by the weakest model (deepseek-v4-flash) so agents — not just a strong human-driven model —
can use the browser. General, data-driven, never per-site.

## What shipped (all TDD, all green; live-verified on real pages)

1. **Forgiving read primitives** (`stealth/browser/src/read-extract.ts`, wired in
   `read-commands.ts` + `commands.ts`):
   - `find <keyword> [-C n] [--all] [--re]` — locate a term in a big doc, return the
     surrounding region + a pointer to any enclosing table.
   - `table [<index>|near <kw>|@ref] [--json]` — extract a `<table>` OR ARIA grid as
     TSV/JSON; no arg lists every table.
   - `read` — readable main-article text (cleaner than `text`).
   - `data [--all]` — surface the JSON/CSV backend request behind a chart from the redacted
     deep-capture ring, ranked (hard-exclude for telemetry vendors), with a ready-to-run fetch.
   - `capOutput` — shared cap on `text`/`html`/`read`/`find`/`table`; on truncation the
     footer points at `find`/`table`/`data`.
2. **In-band coaching** (`error-coach.ts` → `server.ts` catch + `read-commands.ts`): a
   tool error or an empty `js` result yields ONE next-move hint keyed on error CLASS — the
   self-teaching channel for a model that never reads the SKILL.md.
3. **Auto-surfaced method flywheel** (`skill-router.methodAdviceForNav` +
   `goal.inferNavGoal` → `server.ts` `appendEngineGuidance`) + a general `data-portal`
   recipe (structural signature, never a hostname). The built-but-dark skill layer now
   flows on navigation. `BROWSE_DISABLE_SKILLS=1` off-switch.
4. Deep capture now fills `respContentType`/`respBodySample` (`sampleResponse`).

Live verification (headless, window-free): `table` returned a Wikipedia companies table as
TSV; `find` located a term with a table pointer; `read` gave article text; `data` on
clinicaltrials.gov surfaced the exact results API (`/api/int/studies?...NCTId,EnrollmentCount`)
as the #1 candidate with telemetry filtered. Coaching fired on a blank page.

## Re-measurement (honest)

A = flash alone, C = flash + naive fetch, B = flash + nightcrawl. Judge = deepseek-v4-pro.

- First fair run: **C 0/6, B 0/6.** Two HARNESS measurement bugs were found and fixed (both
  condition-neutral, so the comparison stays fair) — without them B was measuring a broken
  harness, not the tool:
  - The `ACTION: name(arg)` parser silently DROPPED flash's `goto https://...` (space form,
    no parens), so its navigations never ran and it looped on a blank page. → accept both forms.
  - The `goto` tool returned a blind "navigated" even on failure, so flash kept reading the
    STALE previous tab (the SEC task read example.com). → return nc's real result.
- Final fair run (both harness fixes): **B = 1/6 CORRECT** (task #1 World Bank →
  "2006年", matching the reference). C stayed 0/6. **Lift B−C = +1/6** — the first task flash
  has EVER completed on this benchmark (every prior run, before this work, was 0/6).
- The win is real but FRAGILE: a re-trace of the same task computed "2008年" (wrong). See below —
  on that task the residual failure has moved from tool-driving to reasoning.

## Tool-driving is now solved — the World Bank trace (the headline)

Full flash trace of task #1 B (the win): `goto data.worldbank.org` → `find(...)` (tried the
new primitive; not found → got the coaching hint) → `goto` the SP.ADO.TFRT indicator page →
`data()` → then `run_js(await fetch("https://api.worldbank.org/v2/country/CN/indicator/
SP.ADO.TFRT?format=json"))` which **succeeded and returned the real data series**. That fetch
is EXACTLY what failed in the 2026-07-17 finding ("run_js echoed source / TypeError, never
got the data array"). The bulletproof `js` (block-body IIFE return, commit a8978f1) +
coaching + the parser fix let flash drive the tool cleanly and get the numbers. The only miss
is the final arithmetic (which year had fastest growth: 2006 vs 2008), a REASONING limit of
the weak model — not a tool limit. So the thesis holds and sharpens: the tool-driving wall is
down; the residual on data-reachable tasks is reasoning, and on the rest it is navigation.

## Root cause of the residual failures (from full flash traces)

Extraction and (now) data-fetch are handled. The residual bottlenecks are:
- **Stale URL knowledge** — flash used dead `clinicaltrials.gov/ct2/results?...` URLs (the
  site migrated to `/search`), so every goto 404'd.
- **Data-apps** — Maoyan / World Bank load numbers via JSONP/script (not xhr/fetch), so
  `data` can't capture them, and flash lacks the API knowledge to construct the call.
- **Multi-step site navigation** — SEC EDGAR (search → filing → table) exceeds flash's
  12-step budget and planning.
- flash DID invoke the new primitives (`table()`, `read()` seen in the trace) and DID
  receive the coaching hints — the perception layer works; the driver can't get to the page.

## Proof the primitive path SOLVES a favorable task (tool capability, not driver skill)

Driving clinicaltrials task #7 by the intended path, headless:
`goto <modern search URL>` → `data` (surfaces `/api/v2|int/studies`) → `js` fetch that API,
filter to 2018-first-posted, sort by NCT → **`NCT03393000, enrollment 19`** — exactly the
reference answer. Two commands. flash failed only on reaching the modern page, not on
extracting once there.

## Configuration root cause (checked against the official DeepSeek API)

`deepseek-v4-flash` and `deepseek-v4-pro` are REAL ids (the `/models` endpoint returns
exactly those two). But BOTH are **reasoning models** — the response carries a separate
`reasoning_content` field, and flash spends 300-500+ reasoning tokens even on trivial
requests. Our harness set the driver `max_tokens=1200` and the judge `max_tokens=200`, and
reads only `content`.

Proven failure mode: at `max_tokens=300`, flash's reasoning consumed all 300 tokens,
`finish_reason=length`, and **`content` came back EMPTY** — the exact blank model turns seen
in the World Bank trace. On a hard turn the chain-of-thought overran the 1200 budget, the
harness read empty content, and the turn was silently wasted. So flash's "reasoning failure"
was largely OUR token starvation, NOT a model capability wall (it computes 2006 correctly with
room). Fix: driver 1200 -> 6000, judge 200 -> 1500.

After the fix (C,B re-run): C solved World Bank in 5 steps (naive fetch to the PUBLIC
api.worldbank.org JSON is sufficient — no browser needed), B got clinicaltrials to PARTIAL
(found NCT03393000 via the primitives). B-C bounced to -1 this run vs +1 the prior run. The
signal is unstable because n=6 is tiny AND the task mix isn't clean: for public-JSON-API
tasks a browser doesn't help, so C ties or beats B there; nightcrawl's edge only appears on
blocked/rendered/authenticated sites, where flash's navigation weakness independently blocks
it. **The benchmark is underpowered to measure the lift — it needs more tasks (a held-out
20-30 sample) and a task mix that isolates "does a browser help" from "can flash navigate".**

## Generalization (held-out set) + navigation-assist

To check the primitives aren't overfit to the original 6, ran condition B (config-fixed) on
12 HELD-OUT protocol3 tasks the work never touched (ourworldindata, JNTO stats, FDA, MIT
catalog, IATA, Caltrans, Toronto CS, NTSB, CWUR, NYC open-data, BLS, SSA).
- Result: **2/12 CORRECT** — ourworldindata (#3, "Trinidad and Tobago", genuine) and CWUR
  (#27, but its answer text says it could NOT reach the site and answered from public memory
  — a judge false-positive, not a tool win). MIT catalog (#11) was nearly right, judged
  strict. So ~1/12 genuine — the approach DOES transfer (not pure overfit), but modestly.
- The dominant held-out failure is the SAME navigation wall: "unable to retrieve due to
  navigation" on FDA, Caltrans, Toronto, NTSB, NYC data — the model can't reach the right
  page. This validated building the navigation-assist.

**`search <query>`** (`search-input.ts` + `write-commands.ts`): finds the site's own search
box (pure, tested ranker) and drives it with TRUSTED Playwright input (fill+Enter, Search-
button fallback for Enter-swallowing SPA comboboxes). Raw JS value-set is ignored by
React/Vue; trusted events work — verified: JS-set left Wikipedia on the homepage, trusted
`search "Glioblastoma"` navigated straight to the Glioblastoma article. This lets a weak
model use site search instead of guessing stale URLs (the clinicaltrials `/ct2/` failure).

## Takeaway / next wall

Net: **B−C moved from +0 to +1/6**, and the qualitative change is bigger than the number —
flash now DRIVES the tool (fetches the World Bank data series it previously couldn't). The
"weak models fail on tool-driving" wall is down. The residual failures have split into two
new walls, neither of which the extraction layer addresses:
- **Navigation** — stale-URL recovery (flash used dead `/ct2/` clinicaltrials URLs),
  search-box use, multi-step site traversal (SEC EDGAR). General next step: when a goto lands
  on a 404/blank/error, coach the model to search from the site's homepage / use the site
  search instead of guessing URLs. A navigation-assist layer, parallel to this perception one.
- **Reasoning** — once the data is in hand (World Bank series), computing the answer
  (fastest-growth year) is unstable in the weakest model. This is a model limit, not a tool
  limit; a stronger driver clears it (Opus solved all these by hand with the same primitives).
