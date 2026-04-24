# Notification & Real-Time Sync Design

This document captures the user requirements (from project memory + Apple Notes
+ explicit asks in this thread) for the notification system and the
default-browser → nightCrawl cookie sync, the design that satisfies them, and
the failure modes to watch for.

Last updated: 2026-04-24.

---

## 1. The user's actual goal

> "I want everything I log into in my default browser to always sync with
> NightCrawl. Updated in real time."
>
> "Notify before any window opens — never silently pop Chrome into foreground."

Two strict invariants follow:

- **Real-time, not periodic.** A user login in Arc must propagate to nightCrawl
  in seconds, not minutes. 10-minute polling violates the spirit of "always
  sync."
- **Visible before disruptive.** Any window that nightCrawl opens (headed
  CloakBrowser handoff, default-browser handoff) must be preceded by a
  notification the user can see and intercept. Silent popups burned trust in
  past incidents (UW Canvas regression 2026-04-14, the 520a253 over-correction).

---

## 2. Notification system — design

### Two surfaces, one fallback

| Function | Backend | When to use |
|---|---|---|
| `notify(title, body)` | `osascript -e 'display notification ...'` | Status pings, "we just did X" — passive, no action button |
| `notifyWithAction(title, body, action)` | `terminal-notifier -execute / -open` | Whenever the notification *means something the user might want to act on*: "doubao needs login — click to open" |

**Always-on fallback**: `notifyWithAction` *also* prints the actionable
command to stderr, every time. So even if the notification never reaches
Notification Center (permissions denied, Focus mode, terminal-notifier
uninstalled, unsigned-binary block on macOS 14+), the user still has a
copy-pasteable command in the daemon log. **Notifications are best-effort
delight, never load-bearing.**

### The `-group` flag (current behavior, double-edged)

`notifyWithAction` passes `-group nightcrawl-handoff` to terminal-notifier,
which causes new notifications in the same group to *replace* the previous
one. Pro: prevents 5 stale "doubao needs login" pings stacking up. Con: if
two unrelated handoffs fire within seconds, the second silently overwrites
the first. **Acceptable today; revisit if real users hit this.**

### Diagnostic: `nc notify-test`

Fires both kinds (passive + actionable) with a timestamp and prints a
permissions checklist. Shipped 2026-04-24 in commit `cad9f3f`.

If the user runs `nc notify-test` and sees nothing, the issue is downstream
of our code:

1. **macOS Notification Center permissions** — System Settings →
   Notifications → look for `osascript`, `Script Editor`, `terminal-notifier`.
   Each must be set to "Allow Notifications."
2. **Focus / Do Not Disturb** — silently suppresses everything.
3. **`NIGHTCRAWL_NO_NOTIFY=1`** — env var kill switch (unset by default).
4. **macOS 14+ entitlements** — unsigned binaries spawned from a non-app
   process can hit a hard wall here. We have no good workaround beyond
   asking the user to grant osascript notifications system-wide (which they
   may resist for privacy reasons).

---

## 3. Notification call sites (current)

| File | Trigger | Notification |
|---|---|---|
| `browser-handoff.ts:589` | Login wall detected, default-browser handoff path | "Opening {domain} in your browser. Auto-resume when done." |
| `browser-handoff.ts:705` | Default-browser cookies didn't clear a pinned-domain wall | "Default-browser cookies didn't clear {domain}. Run 'open-handoff'..." |
| `browser-handoff.ts:733` | Headed CloakBrowser auto-pop (pinned domain or env-gated) | "{domain} requires one-time login..." or "Headed CloakBrowser opening..." |
| `server.ts:1082` | Login wall detected, domain unapproved (CONSENT_REQUIRED) | "{domain} needs your approval to enable auto-handoff." |
| `server.ts:1133` | Late-redirect-to-login detected by 20s background watcher, domain unapproved | "{domain} redirected to a login page. Run 'grant-handoff'..." |

---

## 4. Real-time sync — design

### Two layers, complementary

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: REAL-TIME (cookie-watch.ts, fs.watch + 2s debounce)   │
│  Latency: ~3 seconds. Trigger: every Arc/Chrome cookie write.   │
│  Coverage: 95% of events (FSEvents on macOS occasionally drops). │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼  (calls runBackgroundSync('watch'))
┌─────────────────────────────────────────────────────────────────┐
│  syncAllCookies(context)                                        │
│  - listDomains(browser) — read Arc/Chrome SQLite (decrypt via   │
│    Keychain)                                                     │
│  - computeNewDomainsToSync — diff against current jar by eTLD+1, │
│    skip hostile (XHS/Douyin/Weibo/etc), batch ≤200 host_keys    │
│  - importCookies(browser, batch) — Playwright API import        │
│  - replaceCookiesFor(context, cookies) — atomic clear+add per   │
│    eTLD+1                                                        │
└─────────────────────────────────────────────────────────────────┘
                         ▲
┌────────────────────────┴────────────────────────────────────────┐
│  Layer 2: 10-min POLL (server.ts setInterval, fallback)         │
│  Latency: 0–10 minutes. Trigger: timer.                         │
│  Coverage: catches anything Layer 1 misses (FSEvents drops,     │
│  daemon was offline during a write, etc).                       │
└─────────────────────────────────────────────────────────────────┘
```

### Why both?

`fs.watch` on macOS is built on FSEvents, which is reliable in steady state
but occasionally drops events under sandboxing, volume throttling, or sleep
cycles. The 10-min poll guarantees eventual consistency: even if the watcher
silently dies, you'll never wait more than 10 minutes for a fresh login to
propagate.

### What runs when

- **Daemon startup** — watcher attaches; FSEvents fires a "rename" event for
  the existing Cookies file (~30ms after attach), which our 30ms warm-up
  swallows. No spurious initial sync.
- **User logs into example.com in Arc** — Arc writes cookies → file changes →
  fs.watch fires → 2s debounce coalesces the burst (page write + WAL flush
  + journal commit) → `runBackgroundSync('watch')` → `nc sync status` shows
  `Triggers: watch +1`, `Last run: 3s ago (watch)`, the new domain in
  `lastNewDomains`.
- **Daemon idle 10 min** — poll fires → `runBackgroundSync('poll')`. If the
  watcher caught everything, this finds 0 new domains and is a cheap no-op.

### What it doesn't do

- **Doesn't watch Firefox or Safari.** They use different storage
  (SQLite-with-different-schema for Firefox, binary file for Safari). Adding
  them is straightforward but deferred until someone uses them as a default.
- **Doesn't sync deletions.** If the user logs OUT of a site in Arc, the
  cookies stay in nightCrawl's jar until they expire naturally. Fixing this
  requires diffing instead of additive import — design TBD.
- **Doesn't handle mid-sync browser switches.** If the user changes their
  default browser while the daemon is running, the watcher stays on the old
  browser. Daemon restart picks up the new default.

---

## 5. Inventory of user requirements (from memory + Apple Notes)

These are the rules the system is built to honor. Each is a hard constraint,
not a preference.

### Notifications

- **Notify before any window opens** (`feedback_no_windows.md`) — never
  silently pop Chrome. User works in VSCode; surprise windows are extremely
  disruptive.
- **macOS native notification for `CONSENT_REQUIRED`**
  (`project_onboarding_design.md`) — user gets pinged when a new domain
  needs approval.
- **Notification asks "approve auto-login for {domain}?"**
  (`feedback_proactive_handoff_ux.md`) — TTL-gated approval. Approve once
  per domain, autonomous handoffs for 30 days after.

### Auto-handoff UX

- **Delete `BROWSE_AUTO_HANDOVER` env var** — replace with consent-per-domain
  (done — see `8a1f39f`).
- **`detectLoginWall` always runs** — no env-var gate. Detection is free;
  *handoff* is consent-gated.
- **Consent persisted to `~/.nightcrawl/handoff-consent.json`** (eTLD+1, 30d
  TTL).
- **Preferred handoff medium: user's default browser** (Arc, Chrome) — uses
  their password manager + extensions + existing session. Spawned headed
  CloakBrowser is a fallback for headless environments.
- **Watch source browser's cookie SQLite for login completion** — let user
  use their normal browser; nightCrawl detects login by seeing fresh cookies.
- **5-minute timeout on cookie-watch handoff** — if login not detected, ask
  user in chat instead of infinite-waiting.
- **`autoHandover()` polling loop is battle-tested — do NOT touch its timing**
  (`project_canvas_regression_2026_04_14.md`).
- **Atomic cookie swap (clear before add)** on import — Shibboleth + Okta
  store randomized per-session cookie names; additive import mixes stale +
  fresh (`project_canvas_stale_request_2026_04_20.md`).

### Real-time cookie sync

- **"Updated in real time"** (this thread, 2026-04-24) — sub-3s latency from
  Arc login to nightCrawl jar.
- **Auto-import from default browser on login wall, if domain approved**
  (`project_auto_import_regression_2026_04_14.md`) — silent path via
  `tryAutoImportForWall()`. Restored after 520a253 over-banned it.
- **Cookie import via Playwright API only**, not via JS `document.cookie`
  round-trip — httpOnly cookies (auth tokens like `__puus`) can't be read
  by JS.
- **Never load real cookies on hostile platforms** — use `BROWSE_INCOGNITO=1`.
  XHS, Douyin, Weibo, LinkedIn, Instagram are hardcoded blocklist
  (`project_xhs_account_ban_2026_04_09.md` — 2 real XHS accounts perma-banned
  from soft-rule failure; blocklist is enforced in code).
- **Always ask for test account FIRST** before hostile-platform testing.

### General product UX / safety

- **Every mutating scenario needs a safety layer** — not just trading. Read-only
  default, per-action confirmation for writes, audit log for sensitive ops.
- **Per-action confirmation for writes** (post, upload, send, order, delete) —
  "SSH-style trust, but per-ORDER not per-domain."
- **Audit log of every mutating action.**
- **Dry-run / preview mode** for complex pipelines.
- **Hostile-domain blocklist FIRST** — hostile platforms cannot be approved
  via consent flow. Hard gate.

### Key principle

> **Privacy via consent, not feature removal.** When a feature is "too
> dangerous," gate it; don't delete it. The 520a253 fix tried to delete
> auto-import entirely; that broke Canvas. The right answer is per-domain
> consent + hostile-domain hardcoded blocklist + read-only default.

---

## 6. Open questions

- **Does the user actually see notifications?** Pending answer to
  `nc notify-test`. If no, the next move is permissions diagnosis on their
  Mac, not more code.
- **The `-group nightcrawl-handoff` coalescing.** Should two unrelated
  pinned-domain handoffs in the same minute use different groups so neither
  gets overwritten? Easy fix if it happens.
- **doubao end-to-end verify.** The auto-pop has been wired since `b180255`
  but no human has driven it on real doubao.com from a fresh "no cookies"
  state. Cost: one re-login. The user has many existing doubao logins; the
  test would prove the *first-time* path works.
- **Default-browser-medium handoff.** Term used in prior HANDOFF.md but
  doesn't exist in code. Likely means: a tier between "notify only, no
  window" and "full headed CloakBrowser handoff" — possibly opening the
  user's actual default browser (Arc) rather than a spawned CloakBrowser.
  Needs scoping with the user.
