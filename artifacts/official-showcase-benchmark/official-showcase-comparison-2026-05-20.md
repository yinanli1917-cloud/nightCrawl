# Official Kimi WebBridge Showcase Benchmark: Kimi vs nightCrawl

Date: 2026-05-20  
Benchmark basis: Kimi's own public WebBridge feature page and Help Center.

## Official Claims / Use Cases Used

Kimi's feature page describes WebBridge as "a browser extension for AI agents" that can click, fill, navigate, and extract. The page showcases:

- Build Google Sheets
- Cross-Site Search
- Convert Workflow to Skill

Kimi's Help Center describes the mechanism as:

- Local bridge service receives agent instructions.
- Browser extension executes browser actions using Chrome DevTools Protocol.
- Execution happens locally, with existing browser login states available.

The Help Center's feature/use-case list includes:

- Web navigation
- Element clicking
- Form filling
- Page screenshots
- Content extraction
- Login session persistence
- E-commerce price comparison
- Information research
- Form filling
- Data entry

Important official troubleshooting note: Kimi says if pages open normally but `snapshot`, `evaluate`, `screenshot`, or `click` keep failing, a common cause is conflict with other browser extensions. The observed Kimi failures in this run match that pattern.

## Safe Test Mapping

I did not run purchases, applications, messages, submissions, or Drive mutations.

| Official case | Test used | Mutation risk |
|---|---|---|
| E-commerce price comparison | Amazon search for mechanical keyboards under $150 / high rating | Read-only; no cart actions |
| Information research / Cross-Site Search | Kimi WebBridge Help Center extraction | Read-only |
| Collect Job Listings | Y Combinator jobs search for `ai agent` | Read-only; no applications |
| Build Google Sheets / data entry | Google Sheets workspace readiness | Read-only; no sheet creation/editing |

Raw results:

- `artifacts/official-showcase-benchmark/official-showcase-results-2026-05-19T20-14-44.json`
- `artifacts/official-showcase-benchmark/official-showcase-extracted-items.csv`
- Runner: `artifacts/official-showcase-benchmark/run_official_showcase_benchmark.py`

## Measured Results

| Case | Kimi WebBridge in Chrome | nightCrawl |
|---|---|---|
| Shopping comparison | Failed: `navigate` timed out after 45s | Passed: Amazon loaded in 3.86s; extracted 12 result cards; 5 saved to CSV |
| Cross-site research | Partial: Kimi Help page opened in 1.92s, but extraction failed with local bridge `502 Bad Gateway` | Passed: loaded in 2.86s; extracted Kimi Help feature table |
| Job listings | Failed: YC jobs navigation timed out after 45s | Passed: loaded in 3.19s; extracted 10 relevant/navigation/job-related links |
| Sheets readiness | Partial: Sheets page opened in 1.97s, but extraction failed with local bridge `502 Bad Gateway` | Passed: loaded in 7.14s; confirmed Google Sheets workspace and redacted recent-file list |

## What Kimi Did Well

Kimi's architecture is directionally right for identity-heavy tasks. On this machine it has already proven it can attach to the user's real authenticated Chrome Canvas session. That is a major product advantage:

- It uses the user's actual Chrome profile.
- It gets real cookies, SSO state, device trust, and browser fingerprint continuity.
- It avoids cookie import/handoff friction.
- It aligns with the user's mental model: "use the browser I already use."

For pages where Kimi opened the tab successfully, navigation was fast:

- Kimi Help Center: 1.92s
- Google Sheets workspace: 1.97s

This is exactly the UX threat: when the bridge is healthy, it feels like the agent is simply using your already-logged-in browser.

## Where Kimi Failed In This Run

Kimi repeatedly lost the ability to operate pages after opening them:

- `evaluate` calls returned local bridge `502 Bad Gateway`.
- Logs showed repeated extension disconnect/reconnect cycles.
- Logs also included stale-tab cleanup such as `stale tab ... removing from session`.
- Live Chrome still had Kimi-opened tabs, but WebBridge could not reliably re-bind to them.
- `find_tab` sometimes failed even for visible Chrome tabs unless a tab was active and the bridge was in a good state.

This is not a claim that Kimi cannot do these tasks in a clean environment. It is a measured claim about this real default Chrome environment. Kimi's own FAQ says this failure shape commonly points to extension conflicts. That matters because using the user's real default browser is both the product advantage and the reliability risk.

## What nightCrawl Did Well

nightCrawl completed all four safe official-case equivalents in one run:

- Amazon product extraction succeeded, including prices and ratings.
- Kimi Help Center extraction succeeded.
- YC jobs page extraction succeeded, though the simple extractor captured some navigation links along with job-related links.
- Google Sheets readiness succeeded using the existing authenticated state; recent file names were redacted from artifacts.

Performance was slower on navigation than Kimi's successful opens, but much more stable:

- Amazon: 3.86s navigation + 54ms extraction
- Kimi Help: 2.86s navigation + 53ms extraction
- YC jobs: 3.19s navigation + 49ms extraction
- Google Sheets: 7.14s navigation + 55ms extraction

## Identity / Fingerprint Analysis

I agree with the core argument: Kimi's identity/fingerprint position is stronger for a class of tasks.

Kimi uses the real browser profile. That means a site sees:

- The same Chrome install the user normally uses.
- The same login cookies and SSO state.
- The same browser extensions and local browser storage.
- The same device-trust profile that Google/UW/Amazon/etc may already know.
- The same visible browser continuity if the user has already opened the page.

nightCrawl uses a separate managed browser profile. It can import/persist cookies and uses stealth/fingerprint work, but it is not literally the user's daily Chrome profile. For fingerprint-pinned systems, Kimi's model can be better. For workflows where being "the exact user's browser" matters more than headless isolation, Kimi's approach is the cleaner UX.

But that same real-browser dependency creates a product tax:

- Other Chrome extensions can break the bridge.
- User tab state becomes part of the automation state.
- Visible tabs accumulate in the user's browser.
- Debugging can require browser-extension management.
- Broad `<all_urls>` and debugger permissions are required.

nightCrawl's tradeoff is the opposite:

- Less exact identity continuity than the user's live Chrome.
- More isolation from user workspace.
- More reliable batch-style extraction.
- Safer default behavior for background automation.
- Better fit for repeatable benchmark/test-suite execution.

## Performance / Accuracy / Speed / UX

### Performance

Kimi has the best theoretical warm path because it does not launch a separate browser and can operate inside an already-open Chrome tab. In this run, that advantage only appeared at the navigation-open stage. It did not survive extraction because the bridge kept losing session binding.

nightCrawl was slower to load pages, especially Google Sheets, but completed the extraction steps consistently.

### Accuracy

nightCrawl produced usable structured outputs for all four cases. Kimi did not produce structured outputs in this official-case run because extraction failed after navigation.

For the prior UW Canvas test, Kimi was accurate enough to confirm the logged-in Dashboard. That remains the strongest evidence for Kimi's real-identity strength.

### Speed

Kimi successful opens were around 2 seconds. Failed navigations consumed the full 45-second timeout.

nightCrawl navigations were 2.9-7.1 seconds, with extraction around 50ms after page load.

### UX

Kimi's good UX:

- Very simple install story.
- Uses the browser/account the user already trusts.
- Best when the user says "use the tab I already have open."
- Strong for human-supervised workflows.

Kimi's bad UX in this run:

- Bridge health was not transparent enough.
- Tabs opened but became unbound.
- Restarting the daemon temporarily helped, but did not remove the root instability.
- Official troubleshooting may require disabling other extensions, which is invasive in a real user's default Chrome.

nightCrawl's good UX:

- Runs in the background.
- Does not clutter Chrome.
- Good for repeatable tasks and benchmark suites.
- Completed all read-only showcase equivalents.

nightCrawl's bad UX:

- Setup story is harder to explain.
- Auth/fingerprint story is less magical.
- The user cannot naturally "watch it use my existing tab" unless we add a visible/session mirror.

## Product Implication

Kimi is a real threat because it owns the "real browser identity" story. I do not think we should dismiss that.

The right product response is not to copy Kimi wholesale. The right response is a two-mode strategy:

1. **Keep nightCrawl's isolated headless engine** for reliable, stealthy, repeatable background work.
2. **Add an explicit real-browser bridge mode** for identity-pinned tasks where the user's live Chrome/Arc session is the asset.

That bridge mode should not inherit Kimi's weakest points:

- It needs token-authenticated local commands.
- It needs origin/CSRF protection.
- It needs strong tab/session observability.
- It needs "attach to current tab" as a first-class primitive.
- It needs clean extension-conflict diagnostics.
- It should not send external command telemetry by default.

## Next Benchmark To Run

The fairest next Kimi run is a "clean Chrome" pass:

1. Disable all non-Kimi Chrome extensions temporarily, as Kimi's FAQ recommends.
2. Restart Chrome and WebBridge.
3. Run the same four official cases again.
4. Separately run "real default Chrome" as the user-experience baseline.

That will separate "Kimi's architecture is weak" from "the default Chrome extension stack is breaking Kimi." Right now, the evidence points more to the latter.
