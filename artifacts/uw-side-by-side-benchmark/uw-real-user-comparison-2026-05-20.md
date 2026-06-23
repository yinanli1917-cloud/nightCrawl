# UW Real-User Side-by-Side: Kimi WebBridge vs nightCrawl

Date: 2026-05-20  
Task: use the user's authenticated UW context to check Canvas reachability, then search UW Libraries for references on `browser automation AI web agents`.

Safety bounds used:

- No Canvas edits.
- No submissions.
- No intentional grades/account-settings access.
- No paywalled full-text downloads.
- Search forms only.
- Summary below avoids course/grade details; raw nightCrawl output was redacted for score-like fragments.

## Artifacts

- Kimi subagent result: `artifacts/uw-side-by-side-benchmark/kimi-results.json`
- Kimi subagent note: `artifacts/uw-side-by-side-benchmark/kimi-note.md`
- Kimi raw timing: `artifacts/uw-side-by-side-benchmark/kimi-raw.jsonl`
- nightCrawl result: `artifacts/uw-side-by-side-benchmark/nightcrawl-2026-05-20T02-55-23-146Z.json`
- nightCrawl note: `artifacts/uw-side-by-side-benchmark/nightcrawl-2026-05-20T02-55-23-146Z.md`
- nightCrawl runner: `artifacts/uw-side-by-side-benchmark/nightcrawl-benchmark-runner.mjs`

## Result Summary

| Area | Kimi WebBridge in Chrome | nightCrawl |
|---|---|---|
| Health/connect | Passed: daemon v1.9.7, extension v1.9.7 connected | Passed after daemon start |
| Canvas auth | Passed after direct retry: Kimi attached to existing Chrome tab and snapshot title `Dashboard` at `https://canvas.uw.edu/` | Passed: `https://canvas.uw.edu/`, title `Dashboard`, authenticated dashboard visible |
| Canvas disruption | Used the real visible Chrome tab/profile | Headless; no visible user-browser tab needed |
| UW Libraries homepage | Passed after Kimi daemon restart: loaded `https://lib.uw.edu/`, title `UW Libraries`, search box visible | Passed |
| UW Libraries search | Not completed through Kimi: session binding was repeatedly lost between commands; direct Discovery navigations timed out or left unbound tabs | Completed via direct UW Discovery URL fallback |
| Reference extraction | Not completed through Kimi | Completed: 3 references captured |
| Main friction | Kimi session/tab binding instability after navigation/snapshot; extension WebSocket reconnect loop seen in logs | Homepage search ref initially targeted the open-search button; direct Discovery URL fallback worked |

## Kimi Details

The first Kimi worker result was too pessimistic for Canvas: it reported a brief `Dashboard` tab but failed before snapshot. A direct follow-up confirmed Kimi can attach to the already-open Canvas tab and read the accessibility tree:

- `find_tab` for `https://canvas.uw.edu/` succeeded.
- `snapshot` returned URL `https://canvas.uw.edu/` and title `Dashboard`.
- The tree showed Canvas global navigation and dashboard structure.

So for Canvas auth, Kimi works in the way its product is designed to work: it uses the user's existing real Chrome session.

UW Libraries was less stable:

- After restarting Kimi WebBridge and waiting for extension reconnect, `navigate` to `https://lib.uw.edu/` succeeded.
- `snapshot` showed title `UW Libraries` and the catalog search textbox.
- The next command often failed with `session "...\" tab was closed` or `has no tab`, even though Chrome still visibly had UW Libraries tabs open.
- `find_tab` only worked reliably when the relevant Chrome tab was manually made active; non-active matching often failed for the UW Libraries tabs.
- Kimi logs showed repeated extension disconnect/reconnect messages roughly every few seconds during this phase.
- Direct navigation to UW Discovery / Primo search URLs timed out in several attempts.

This means the Kimi result should not be interpreted as "Kimi cannot load UW Libraries." It can. The failure was multi-step session reliability: keeping the tab bound long enough to fill/search/extract references.

## nightCrawl Details

nightCrawl used normal persistent state/profile with:

- `BROWSE_EXTENSIONS=all`
- `BROWSE_IGNORE_HTTPS_ERRORS=1`

Canvas:

- Navigated to `https://canvas.uw.edu/`.
- Title was `Dashboard`.
- Dashboard/course context was reachable.
- No login wall, 2FA wall, consent-required message, auto-import, or handoff was observed.

UW Libraries:

- Reached `https://lib.uw.edu/`.
- Form inspection found the Primo/Discovery search form.
- Initial snapshot ref selection targeted the open-search button, so direct fill failed.
- Fallback to the UW Discovery URL succeeded:
  `https://orbiscascade-washington.primo.exlibrisgroup.com/discovery/search?...`
- It extracted 3 references.

Captured references:

1. **AI Agent with Browser Automation**
   Abdul Mateen; Priyanka K R; Chethana BM; Leela C; Sujith Kumar S.
   International Research Journal on Advanced Engineering Hub, 2026. Open Access.

2. **Agentic AI for offensive cybersecurity: build and automate smarter penetration testing workflows using AI-driven agents**
   Orhan Yildirim.
   Packt Publishing, 2026. Online access.

3. **The Rise and Role of AI Browser Agents in Modern Digital Workflows**
   Sankara Reddy Thamma.
   International Journal of Scientific Research in Computer Science, Engineering and Information Technology, 2025. Open Access.

## Interpretation

For this real UW task, the comparison is different from the synthetic boundary fixture:

- Kimi's product thesis is valid. It really can use the user's existing logged-in Chrome session, and Canvas is the strongest proof point.
- Kimi's UX model is better for "I am already logged in, use this exact browser state."
- nightCrawl's headless model is better for completing the whole workflow without using visible Chrome tabs.
- Kimi's failure here was not basic capability; it was reliability of the daemon-extension session binding across repeated UW Libraries commands.
- nightCrawl's failure was smaller and recoverable: one wrong UI ref on the UW homepage search; direct Discovery search completed the task.

## Follow-Up Benchmark Improvements

The next fair version should:

1. Start Kimi from a clean daemon state, wait for extension connected, and avoid concurrent Kimi sessions.
2. Treat `find_tab(active:true)` as a first-class Kimi path, because real WebBridge usage often starts from the user's currently open tab.
3. Add Chrome-tab observability using AppleScript only for benchmark instrumentation, not for browser actions.
4. Add a "recover lost session by active-tab attach" step before declaring Kimi failed.
5. Compare against nightCrawl's direct Discovery URL path and a stricter UI-only path separately.

## Bottom Line

Kimi WebBridge looked much better on the real UW Canvas part than the synthetic test suggested. It successfully used the real logged-in Chrome session. The UW Libraries search still did not complete end-to-end through Kimi in this run because session binding became unstable after page navigation/snapshot. nightCrawl completed the full Canvas + UW Libraries reference task, but with a fallback from UI search to direct Discovery URL.
