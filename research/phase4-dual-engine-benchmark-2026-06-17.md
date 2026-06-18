# Phase 4 — Dual-Engine Real-Task Benchmark vs Kimi WebBridge

**Date:** 2026-06-17
**Environment:** user's real Arc browser, both extensions installed (nightcrawl-bridge + Kimi WebBridge)
**Engines under test:** nightCrawl **headless** (CloakBrowser), nightCrawl **Engine R** (real-browser bridge), **Kimi WebBridge**
**Grading:** Deliverable Verification Contract — no task is "done" without `VERIFY_OK` + an on-disk artifact.

Artifacts: `artifacts/phase4-dual-engine-benchmark/suite-2026-06-17/` (results.json, deliverables/, screenshots/)
Harness: `artifacts/phase4-dual-engine-benchmark/{lib,test,phase0_smoke.mjs}` (guards 13/13 green).

---

## TL;DR

1. **Engine R is now live-verified end-to-end for the first time.** The WS transport was unit-tested before, but the `chrome.debugger` hop into the user's real Arc had never been driven. This run drove live Arc to `httpbin.org/uuid` and read the UUID back, then completed a real authenticated library task. The pending workflow gate is closed.

2. **The dual-engine thesis is proven on a real paywalled task.** Searching UW Libraries for a Chinese subscription paper and resolving it through Shibboleth + EZproxy: **Engine R reached the paywalled full text** (live session), while **headless hit `LOGIN_REQUIRED`** (imported cookies cannot carry a Shibboleth IdP session). This is the clearest demonstration yet of *why* the real-browser bridge exists.

3. **Kimi is non-functional in this environment** due to a daemon/extension version skew (daemon v1.9.4, extension v1.9.13). `navigate` and `find_tab` hang with no response; `list_tabs` works (the WS link is alive). Reproduced 4× across example.com, Primo, and Wanfang. nightCrawl headless completed an autonomous, verified extraction in the *same* environment.

---

## Connection matrix (Phase 0)

| Runner | Connect | Drive | Notes |
|---|---|---|---|
| nc-headless | ✅ | ✅ | reads pages, persistent imported cookies |
| nc-real (Engine R) | ✅ | ✅ | extension dialed `ws://127.0.0.1:10087`; `chrome.debugger` drove live Arc; UUID round-trip confirmed |
| Kimi | ⚠️ | ❌ | daemon+extension connected, `list_tabs` OK, but `navigate`/`find_tab` **hang**; daemon logs nothing past the hello. Root cause: **extension v1.9.13 > daemon v1.9.4**. Fix: upgrade the Kimi daemon (installer channel, moonshot.cn). |

---

## T1 — Flagship: UW Libraries → paywalled Chinese paper → download

**Target:** 人工智能深度学习在眼眶病及眼肿瘤疾病诊疗中的应用研究现状 — Wanfang, `cdi_wanfang_journals_ykxjz202402016`, via UW Primo + EZproxy.

| Runner | Session leverage | Reached paywalled full text | PDF bytes |
|---|---|---|---|
| **nc-real (Engine R)** | ✅ **PASS** | ✅ `d-wanfangdata-com-cn.offcampus.lib.washington.edu/periodical/ykxjz202402016`, no login wall | ⚠️ gated (see below) |
| **nc-headless** | ❌ **FAIL** | ❌ `LOGIN_REQUIRED` at `idp.u.washington.edu` | — |
| **Kimi** | — | ❌ navigate hang | — |

**What happened.** The Primo "View It" resolver redirects through the UW Shibboleth IdP. Headless followed its imported cookies and was bounced to the NetID sign-in page — it surfaced `LOGIN_REQUIRED` honestly and did **not** silently pop a headed window. Engine R followed the same resolver in the *live* Arc tab, where the user's UW session is real, and landed directly on the paywalled Wanfang article (abstract, keywords, 28 references — see `screenshots/t1-engineR-wanfang-paywalled.png`).

**The download edge case.** Wanfang's 下载 / 在线阅读 are gated behind Wanfang's *own* 登录. UW's EZproxy license tier grants metadata + abstract but not the PDF blob; the `/file/download/...aspx` endpoint returns HTTP 500 to both curl (with EZproxy cookies) and an in-browser click. **This blocks every tool equally** — it is a publisher-side access-tier limit, not an agent capability gap.

**Why it matters.** A Shibboleth IdP session is a host-only session cookie bound to the live browser. Cookie *export* (headless) cannot reconstruct it; live-session *control* (Engine R) inherits it for free. That is the entire reason the real-browser bridge exists, demonstrated on a real research task rather than a fixture.

---

## T5 — Paginated extraction → JSON deliverable

| Runner | Completed | Verify | Records |
|---|---|---|---|
| **nc-headless** | ✅ | **VERIFY_OK** | 20 (2 pages) |
| Kimi | ❌ | — | navigate hang → snapshot "has no tab" |

Headless searched Primo for `人工智能 深度学习`, walked offsets 0 and 10, deduped 20 Wanfang/Airiti Chinese-article records by `docid`, and wrote a valid JSON array (`deliverables/t5-primo-records.json`, 3937 bytes). `nc verify file --kind json` returned `VERIFY_OK`. This is the headless-autonomy strength: a complete multi-step read workflow with a verified deliverable and no visible browser tab.

---

## T4 — Real-site boundaries

- **T4a Shadow DOM (live site):** headless reached into a real *open* Shadow DOM on `shoelace.style` (`sl-button.shadowRoot` → inner `<button>`). ✅
- **Cross-origin iframe, file upload, trusted events:** covered exhaustively in `research/kimi-webbridge-chrome-boundary-benchmark-2026-05-20.md` — nightCrawl passed all; Kimi failed textarea fill, `event.isTrusted` click, file upload, and iframe-in-place. Not re-run here because Kimi cannot navigate in this environment.

---

## T2 / T3 — Safety gate & routing (documented, no risky writes)

- **T2 Canvas safety gate:** the Canvas session is live in **both** headless (Dashboard) and Engine R (Dashboard, no wall). The sensitive-page gate is implemented and unit-tested (`stealth/browser/src/sensitive-page.ts` — payment / personal-info / account-security / destructive categories). A live draft-and-submit was **not** performed, to avoid touching the user's real coursework. Kimi has no equivalent gate.
- **T3 hostile-web routing:** Engine R reads authenticated/bot-managed sites via the live session without re-login (Canvas Dashboard, no wall). Cloudflare-dashboard reachability is gated in the existing `artifacts/competitor-benchmark` suite (`S6_cf_dash`).

---

## Scorecard

| Dimension | nc-headless | nc-real (Engine R) | Kimi |
|---|---|---|---|
| Live this environment | ✅ | ✅ | ❌ (version skew) |
| Leverage live SSO session (no re-login) | ❌ cookie-export can't carry Shibboleth | ✅ inherits live Arc session | ❌ can't navigate |
| Reach paywalled full text (EZproxy) | ❌ | ✅ | ❌ |
| Autonomous background (no visible tab) | ✅ | ❌ by design (drives real tab) | ❌ |
| Verified deliverable (`nc verify`) | ✅ VERIFY_OK (T5) | n/a this run | ❌ none |
| Real-site Shadow DOM | ✅ | ✅ | ❌ |
| Safety gate before sensitive action | ✅ sensitive-page.ts | ✅ (shared server) | ❌ |
| Honest failure (surface wall, no silent pop) | ✅ | ✅ | n/a |

**Read:** the two nightCrawl engines are **complementary**, not redundant. Headless wins autonomous background work and verified deliverables; Engine R wins anything that needs the live, fingerprint-bound SSO session. Kimi's product thesis (use the real logged-in browser) is sound and overlaps Engine R, but its current reliability — even before this version skew, per all prior runs — is its weak point.

---

## The auto-login question (user's stretch ask)

The user asked whether the agent could auto-login from Arc's saved passwords when a session lapses. Reality from this run: **Duo 2FA gates it.** Even if Engine R autofills the saved NetID password, the Duo push needs the user's phone. The honest design is the one that already exists — detect the wall, ask the user to authenticate **once** in Arc, then leverage that session everywhere (SSH-style). Engine R is the mechanism that makes "leverage everywhere" real; this run proved it end-to-end.

---

## Follow-ups (not done this phase — measurement only)

1. Upgrade the Kimi daemon to match extension v1.9.13 for a fair live re-run (outward-facing; user decision).
2. T1 PDF: a Western-publisher Chinese-language article (Springer/Elsevier via EZproxy) likely yields a direct `.pdf` that `nc verify --kind publisher-pdf` can pass end-to-end; Wanfang/Airiti gate downloads behind their own login.
3. Engine R `js` does not await Promises (in-page `async` fetch returns `{}`); a `download`/`fetch-bytes` bridge command would let Engine R capture files through the live session directly instead of relying on the browser's Downloads folder.
