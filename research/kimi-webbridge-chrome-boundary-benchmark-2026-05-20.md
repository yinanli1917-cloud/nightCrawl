# Kimi WebBridge vs nightCrawl: Real Chrome Boundary Benchmark

Date: 2026-05-20  
Environment: macOS, Google Chrome with Kimi WebBridge extension v1.9.7, Kimi daemon v1.9.7, nightCrawl from this repo.

This is the real installed-browser pass. Kimi WebBridge was installed in Chrome, the daemon was running, and the extension reported connected. We also previously installed the same extension in Arc; Arc tab creation worked, but the debugger/session path hung in our run, so Chrome is the valid Kimi baseline below.

## Sources And Artifacts

- Official Kimi WebBridge page: https://www.kimi.com/features/webbridge
- User-provided WeChat/LinkedIn launch article: https://mp.weixin.qq.com/s/EUC1XLOkmo3MTblTvolFTg
- Kimi installed skill: `~/.agents/skills/kimi-webbridge/SKILL.md`
- Kimi daemon: `~/.kimi-webbridge/bin/kimi-webbridge`
- Kimi logs: `~/.kimi-webbridge/logs/daemon.log`
- Kimi Chrome extension:
  `~/Library/Application Support/Google/Chrome/Default/Extensions/fldmhceldgbpfpkbgopacenieobmligc/1.9.7_0/`
- Kimi Arc extension:
  `~/Library/Application Support/Arc/User Data/Default/Extensions/fldmhceldgbpfpkbgopacenieobmligc/1.9.7_0/`
- Test fixture:
  `artifacts/webbridge-boundary-suite/main.html`
  `artifacts/webbridge-boundary-suite/iframe.html`
- Kimi CSS-selector run:
  `artifacts/webbridge-boundary-suite/kimi-chrome-boundary-results-20260519-192345.json`
- Kimi best-path ref run:
  `artifacts/webbridge-boundary-suite/kimi-chrome-boundary-ref-results-20260519-192641.json`
- nightCrawl run:
  `artifacts/webbridge-boundary-suite/nightcrawl-boundary-results-20260519-192456.json`
- Screenshots/PDFs:
  `artifacts/webbridge-boundary-suite/kimi-chrome-boundary-ref-20260519-192641.png`
  `/tmp/kimi-webbridge-pdfs/kimi-chrome-boundary-ref-20260519-192641.pdf`
  `/tmp/nightcrawl-boundary-20260519-192456.png`
  `/tmp/nightcrawl-boundary-20260519-192456.pdf`

## Executive Verdict

Kimi WebBridge is a credible competitor, but it is not the same product shape as nightCrawl.

Kimi's core idea is: install an extension into the user's real Chrome/Edge-compatible browser, run a local daemon, then let the agent control existing browser tabs through that bridge. This gives it excellent auth reuse and low per-command latency because it is already inside the user's live browser profile. It also explains the claim that it "does not occupy your computer": it does not take over the macOS mouse/keyboard. It sends commands into the browser process through the extension/debugger path. The user can keep using other apps and even other tabs, while agent-controlled tabs still exist inside the visible browser.

That same design has hard limits. In our measured Chrome run, Kimi could navigate, read the accessibility tree, fill normal inputs, fill contenteditable, operate Shadow DOM when using accessibility refs, capture network, screenshot, and PDF. But it failed the textarea fill on this fixture, produced untrusted click events, could not upload a file, and could not operate an embedded cross-origin iframe in place. It could only work around the iframe by opening the iframe URL as its own top-level tab.

nightCrawl has a slower cold start, but it passed the stricter automation boundary cases: textarea, contenteditable, trusted click, open Shadow DOM selectors, file upload, and cross-origin iframe after explicit frame switch. For real web workflows that include file pickers, event trust checks, embedded apps, bot defenses, and automation-hostile surfaces, nightCrawl's browser-control model remains technically stronger. Kimi's UX/onboarding and real-browser auth reuse are the parts worth taking seriously.

## Mechanism: How Kimi Controls Chrome Without "Taking Over" The Computer

Official Kimi describes WebBridge as a local service paired with a browser extension. The agent sends commands to the local service, and the service uses Chrome DevTools Protocol to navigate, click, screenshot, and read pages in the existing browser.

The local install confirms that:

- Daemon listens on `127.0.0.1:10086`.
- Extension connects to `ws://127.0.0.1:10086/ws`.
- Extension manifest grants:
  - `tabs`
  - `activeTab`
  - `debugger`
  - `storage`
  - `alarms`
  - `tabGroups`
  - `windows`
  - host permission: `<all_urls>`
- Extension code contains `chrome.debugger.attach(..., "1.3")`.
- Extension code references CDP-style operations including `Runtime.evaluate`, `Accessibility.getFullAXTree`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`, `Page.printToPDF`, and `Network.enable`.

So "not occupying your computer" means:

1. It does not move the physical mouse pointer.
2. It does not type through the OS keyboard focus.
3. It asks the browser extension/debugger to mutate pages and tabs from inside Chrome.
4. It can still visibly open tabs, group tabs, navigate tabs, and modify page state in your browser.

This is also why event-trust boundaries matter. A real user click delivered by the browser/OS normally reaches page JavaScript with `event.isTrusted === true`. Kimi's measured `click` action produced `trusted-click:false` in the fixture, which means at least this click primitive is not equivalent to a real user click. That is exactly the sort of difference that banking sites, auth flows, captcha widgets, file upload controls, and anti-bot scripts can use.

## Architecture Comparison

| Dimension | Kimi WebBridge | nightCrawl |
|---|---|---|
| Browser target | User's existing Chrome/Edge-compatible browser profile | Separate persistent CloakBrowser/Chromium profile managed by nightCrawl |
| Auth reuse | Excellent: runs inside the user's logged-in browser profile | Uses imported/persisted cookies and consent-based handoff |
| User disruption | Does not steal OS mouse/keyboard, but does create/control visible tabs in the user's browser | Headless by default; no visible browser unless handoff is approved |
| Control channel | Agent -> local daemon on `127.0.0.1:10086` -> extension WebSocket -> Chrome debugger/extension APIs | CLI -> local daemon/state file/token -> Playwright/CloakBrowser |
| Extension requirement | Yes. Official install flow requires the extension | No extension required for core browser; optional extensions managed by nightCrawl |
| Stealth posture | Uses the user's real Chrome profile and browser surface; no explicit stealth/fingerprint system found | Built around CloakBrowser, fingerprint seed persistence, CDP patches, hostile-domain policy, consent handoff |
| Input semantics | Measured click produced `event.isTrusted:false`; file upload failed | Playwright click produced `event.isTrusted:true`; file upload passed |
| Iframe model | Top-frame commands only; workaround is opening iframe URL directly | Can switch active context into iframe and operate it |
| Security boundary | Local unauthenticated `/command` POST accepted hostile `Origin` for simple POST | Tokenized local state/CLI contract; narrower command entrypoint |
| Telemetry | DataRangers/VolcEngine telemetry enabled; command metadata observed | Local-first; no comparable external command telemetry observed in this benchmark |

## Boundary Suite

The test page intentionally included cases that separate browser-control architectures:

- Dynamic form with `<input>`, `<textarea>`, and `contenteditable`
- Disabled submit button that only enables after real input events
- Hidden prompt-injection text using `display:none`
- `event.isTrusted` click gate
- Open Shadow DOM component
- File upload input
- Cross-origin iframe on another localhost port
- Network capture
- Screenshot and PDF export

The fixture was served from:

- Main page: `http://127.0.0.1:8876/main.html`
- Cross-origin iframe: `http://127.0.0.1:8877/iframe.html`

Different ports are different origins, so parent-page JavaScript cannot read the iframe document.

## Measured Results

### Core Workflow

| Task | Kimi WebBridge in Chrome | nightCrawl |
|---|---:|---:|
| Cold/ready status | Already running; extension connected | 11,140 ms cold start |
| Navigate to fixture | 58 ms | 2,264 ms |
| Snapshot/accessibility | 5 ms; good AX tree with refs | 5,050 ms; AX timed out, DOM fallback worked |
| Fill normal input | Pass, 5.7 ms | Pass, 76 ms |
| Fill textarea | Fail: `fill: Uncaught` | Pass, 63 ms |
| Fill contenteditable | Pass, 4 ms | Pass, 56 ms |
| Submit dynamic form | Partial fail because textarea was not filled | Pass, result included all fields |
| Hidden prompt injection exposure | Not exposed in visible summary | Not exposed in visible summary |

Kimi is extremely fast once connected, but the textarea failure is important because it prevented the full form workflow from completing. This was tested both with CSS selector `#notes` and the Kimi-recommended accessibility ref `@e2`; both failed.

### Hard Browser Boundaries

| Boundary | Kimi WebBridge in Chrome | nightCrawl |
|---|---|---|
| Trusted click | Fail: `trusted-click:false` | Pass: `trusted-click:true` |
| Open Shadow DOM | CSS selector failed; accessibility refs `@e6`/`@e7` passed | CSS selector passed |
| File upload | Fail: `DOM Error while querying` or CDP `Not allowed` | Pass: `upload-fixture.txt:24` |
| Cross-origin iframe in place | Fail from parent; direct iframe navigation works as separate tab | Pass after `frame #xframe`, parent received postMessage |
| Parent reading iframe document | Correctly blocked by same-origin policy | Correctly blocked by same-origin policy |
| Network capture | Pass; captured local `iframe.html` request | Pass; listed main and iframe requests |
| Screenshot | Pass; PNG 2656x1450 / 92 KB | Pass; PNG 1920x1080 / 78 KB |
| PDF | Pass; 3 pages / 152 KB | Pass; 2 pages / 147 KB |

### Final Fixture State

Kimi best-path summary:

```json
{
  "dynamic": "",
  "trusted": "trusted-click:false",
  "shadow": "shadow:Kimi Ref Shadow",
  "upload": "no-file",
  "iframe": "iframe-not-read",
  "hiddenTextExposed": false
}
```

nightCrawl summary:

```json
{
  "dynamic": "{\"name\":\"nightCrawl Chrome comparison\",\"notes\":\"Boundary benchmark notes from nightCrawl\",\"editor\":\"Contenteditable text from nightCrawl\",\"trusted\":true}",
  "trusted": "trusted-click:true",
  "shadow": "shadow:nightCrawl Shadow",
  "upload": "upload-fixture.txt:24",
  "iframe": "iframe-message:frame:nightCrawl iframe value",
  "hiddenTextExposed": false
}
```

## UX/UI Comparison

### Kimi Strengths

- Installation narrative is simple: install browser extension, run one shell command, agent can use Chrome.
- Existing-login UX is compelling. If the user is already logged in, the agent gets that session immediately.
- Agent tabs are visible and familiar. This helps trust because the user can see what is happening.
- Session grouping is a good UX primitive for multi-site work.
- Commands are fast after the daemon and extension are connected.

### Kimi UX Costs

- It does occupy browser state, even if it does not occupy the whole computer. It creates tabs, changes tab contents, and can alter the user's active browser workspace.
- Visible-tab automation is cognitively noisy for users who already live in Chrome/Arc.
- The extension requires broad browser permissions and `<all_urls>`.
- If the bridge is connected to the user's everyday browser profile, mistakes happen in the user's real session by default.
- The local daemon command surface is easy for any local process to reach; browser-origin simple POSTs need stronger protection.

### nightCrawl Strengths

- Headless default is a better "background digital twin" UX. The user can keep working without agent tabs appearing in their daily browser.
- Consent-based handoff is safer for login walls and sensitive domains.
- Separate persistent profile avoids directly mutating the user's live browser tab workspace.
- Stronger primitive coverage on hard browser tasks.
- Stealth/fingerprint work is aligned with hostile web reality.

### nightCrawl UX Costs

- Cold start is visibly slower in this benchmark.
- Auth reuse is less magical than Kimi's extension-in-real-browser model.
- Snapshot had a 5-second accessibility timeout and fell back to DOM refs. That is a concrete UX/performance issue for agent loops.
- For normal users, "install extension + connect to Chrome" is easier to explain than cookie import, fingerprint seeds, and headless/handoff semantics.

## Security And Privacy Findings

### Kimi Telemetry

Kimi's daemon logs show telemetry enabled:

- Destination/config includes `https://gator.volces.com`.
- User-Agent includes `DataRangers Golang SDK`.
- Events observed:
  - `webbridge_daemon_start`
  - `webbridge_daemon_alive`
  - `webbridge_command_call`
- Command telemetry includes at least:
  - session name
  - tool/action name
  - daemon version
  - OS/architecture
  - user/device identifier

I did not see page content, selectors, URLs, or filled values in the telemetry log lines inspected. But command metadata does leave the machine. That weakens a literal "everything local" story.

### Kimi Local API Risk

The daemon listens on loopback, which is good. But `/command` accepted an unauthenticated simple POST with a hostile web origin:

```http
POST http://127.0.0.1:10086/command
Origin: https://evil.example
Content-Type: text/plain

{"action":"list_tabs","args":{},"session":"csrf-proof"}
```

Observed response:

```json
{"ok":true,"data":{"success":true,"tabs":[]}}
```

No `Access-Control-Allow-Origin` header was returned, so a malicious website likely cannot read responses. But simple `text/plain` POSTs do not need CORS preflight, so a malicious page may be able to fire-and-forget commands to the local bridge if the daemon is running. That is a serious design smell for a browser-control daemon.

The WebSocket path is better protected: `/ws` rejected a normal hostile origin with `403 forbidden origin`, and accepted the real extension origin.

### Kimi Binary/Install Notes

- Daemon path: `~/.kimi-webbridge/bin/kimi-webbridge`
- Running process: `~/.kimi-webbridge/bin/kimi-webbridge run`
- Binding: `127.0.0.1:10086`
- Binary signature: ad-hoc; no TeamIdentifier observed.
- No LaunchAgent/LaunchDaemon found in the inspected locations; startup appears CLI-managed.
- `kimi-webbridge start --help` documents `--addr 0.0.0.0:10086` and warns that any network client can drive the browser if exposed.

## Arc Result

Arc is Chromium-based, and the extension installed correctly in Arc:

- Extension ID: `fldmhceldgbpfpkbgopacenieobmligc`
- Version: `1.9.7`
- Daemon reported `extension_connected:true`

Empirical result:

- Kimi could visibly create/open Arc tabs.
- The deeper command path hung or failed to bind sessions; `snapshot`, `fill`, `click`, and `evaluate` failed after navigation.

So the issue was not "Arc is not Chromium." The observed issue was narrower: this Kimi build's extension/debugger/session path did not complete reliably in Arc during our test. Chrome was the correct baseline for a working Kimi run.

## Product Implications For nightCrawl

### What Kimi Should Make Us Copy

1. Simpler setup story.
   Kimi's "install extension, paste command" flow is easier to understand than our current conceptual stack.

2. Browser-visible trust affordance.
   Users like seeing what the agent is doing. We should consider optional visible session dashboards or lightweight tab/status mirroring, without making visible tabs the default.

3. Session grouping/naming.
   Kimi's tab grouping model is a nice UX metaphor. nightCrawl sessions should have clearer names, status, current URL, and ownership.

4. Very fast warm-loop operations.
   Kimi's already-connected Chrome bridge is sub-10 ms for many simple operations. nightCrawl warm actions are tens of ms, which is fine, but snapshot fallback at 5 seconds is not fine.

### What nightCrawl Should Not Copy

1. Do not make the user's daily browser profile the primary mutation surface.
   That is convenient, but it increases blast radius.

2. Do not expose unauthenticated local command endpoints.
   Loopback is not enough; browser-origin CSRF is real for local services.

3. Do not depend on untrusted synthetic DOM clicks for core workflows.
   The `event.isTrusted:false` result is a capability ceiling.

4. Do not send command telemetry externally by default.
   A browser-control product should treat command metadata as sensitive.

## Recommended Benchmark Suite Going Forward

Keep this fixture and turn it into a recurring benchmark with these dimensions:

| Category | Required Checks |
|---|---|
| Install/connect | Extension installed, daemon running, browser connected, version match |
| Auth/session | Existing logged-in browser profile, imported-cookie profile, expired-cookie handoff |
| Inputs | input, textarea, select, contenteditable, IME/non-ASCII typing |
| Event semantics | `event.isTrusted`, keyboard events, drag/drop, file picker |
| DOM boundaries | Shadow DOM, same-origin iframe, cross-origin iframe, sandboxed iframe |
| Browser artifacts | screenshot, PDF, download, upload |
| Network | request list, detail, body visibility, redirect handling |
| Safety | local endpoint auth, CSRF, origin checks, token scope, sensitive-page policy |
| Privacy | telemetry on/off, event payload inspection, local storage of logs |
| UX | tab visibility, tab grouping, user interruption, cleanup/recovery |
| Reliability | repeated runs, browser restart, daemon restart, extension disconnect/reconnect |
| Stealth | bot.sannysoft.com, bot-detector.rebrowser.net, creepjs, Cloudflare/DataDome/Kasada paths |

## Bottom Line

Kimi WebBridge is strongest as a low-friction real-browser bridge for everyday logged-in workflows where the user accepts visible agent tabs and broad extension permissions. It is not, based on this benchmark, stronger than nightCrawl on hard browser-control boundaries or stealth-oriented automation.

The competitive threat is UX and distribution, not raw browser-control depth. The technical gap we should close is setup clarity and warm-loop observability. The technical moat we should preserve is headless isolation, stealth, trusted input semantics, file/iframe coverage, tokenized local control, and no external command telemetry.
