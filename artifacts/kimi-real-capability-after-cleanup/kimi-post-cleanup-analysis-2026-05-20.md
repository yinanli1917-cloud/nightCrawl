# Kimi WebBridge Post-Cleanup Capability Analysis

Date: 2026-05-20

## Setup

The user cleared the Chrome profile before this retest. The Chrome extension set was materially cleaner than the previous run:

- Kimi WebBridge `1.9.7`
- Google Docs Offline
- Chrome built-ins

The prior all-URL/debugger competitors such as Claude extension and Tampermonkey were no longer present in the installed extension manifest set.

## What improved

Kimi immediately passed a sanity probe after cleanup:

- `navigate https://example.com`: 471 ms in the quick probe, 45 ms in the broad run.
- `evaluate document.title`: 5.5 ms in the quick probe, 1 ms in the broad run.
- `snapshot`: 4.3 ms in the quick probe, 5 ms in the broad run.
- `list_tabs` retained the session correctly for the quick probe.

This proves the earlier completely broken state was at least partly configuration/profile related.

## What still failed

The daemon/extension WebSocket continued to disconnect and reconnect about every 5 seconds:

```text
[ws] read error: failed to read JSON message: failed to get reader: context canceled
[ws] extension disconnected
[ws] extension connected
[ws] hello from extension v1.9.7 (daemon v1.9.7)
```

That timing dominates reliability. Commands that finish before the next reconnect are excellent. Commands that span a reconnect often lose their tab/session and then return `502` with errors like:

- `session "... " has no tab - navigate or find_tab first`
- `session "... " tab was closed - navigate first to recreate`

## Real-task benchmark

Raw broad result:

- `/Users/yinanli/Documents/nightCrawl/artifacts/kimi-real-capability-after-cleanup/kimi-real-capability-2026-05-19T22-48-46.json`

Summary:

| Task | Result | Notes |
|---|---:|---|
| `sanity_example` | Pass | Fast navigate/evaluate/snapshot all worked. |
| `kimi_help_research` | Fail | `navigate` timed out after 45s; 9 disconnect/reconnect cycles during task. |
| `uw_library_references` | Fail | Initial UW navigate succeeded in 336 ms, but the session was stale/closed before extraction. Fallback Discovery URL also opened, then session was lost. |
| `shopping_compare` | Fail | Amazon navigate timed out after 55s; 12 disconnect/reconnect cycles. |
| `sheets_readiness` | Fail | Google Sheets navigate timed out after 45s; 10 disconnect/reconnect cycles. |
| `canvas_readiness` | Fail | Canvas navigate timed out after 45s; 10 disconnect/reconnect cycles. |
| `local_input_boundary` | Invalid in broad run | Fixture port was already in use; runner patched afterward. |

Chrome inspection after the run showed the Kimi-created UW tabs were visible:

- `https://lib.uw.edu/`
- UW Libraries Discovery search for `agentic browser automation`

That means Kimi did open visible tabs for at least part of the UW task, but the local API lost the ability to operate on those tabs.

## Targeted recovery test

An explicit `find_tab` recovery attempt against the visible UW Discovery tab failed:

- Browser visibly had the UW Discovery search tab.
- `find_tab` returned: `no open tab found matching https://orbiscascade-washington.primo.exlibrisgroup.com`.
- Follow-up `evaluate` returned `session has no tab`.

This is a session/tab discovery defect, not a target-site extraction defect.

## Input primitive test

The installed Kimi extension contains stronger tools than the public skill table originally suggested:

- `mouse_click`: CDP `Input.dispatchMouseEvent`
- `key_type`: CDP `Input.insertText`
- `send_keys`: CDP `Input.dispatchKeyEvent`

Targeted local test results:

- DOM `click` path can produce untrusted events.
- CDP `mouse_click` produced `trusted-click:true`.
- `send_keys` dispatched keyboard input successfully on macOS.

This is a real Kimi strength. Our earlier benchmark undercounted it.

Repeated local sample:

- Raw result: `/Users/yinanli/Documents/nightCrawl/artifacts/kimi-real-capability-after-cleanup/kimi-local-sample-2026-05-19T23-27-05.json`
- 8 trials total.
- 4/8 succeeded.
- Successful trials had fast local navigate and `trusted-click:true`.
- Failed trials timed out during `navigate`, and each failed trial had two reconnect/context-canceled cycles.

The conclusion is precise: Kimi's action primitives are strong when the bridge stays connected, but transport/session reliability is currently not good enough for multi-step real tasks in this environment.

## UX judgment

The user is right that Kimi's visible-browser UX is better in principle. Seeing Chrome move is more legible and confidence-building than a purely headless browser. It also uses the real profile and real identity surface, which is better for SSO-heavy or fingerprint-pinned tasks.

But a visible browser is not enough. In this retest, Kimi sometimes left visible tabs behind while the API reported no tab/session. That is a UX failure mode: the user can see that something happened, but the agent cannot explain or continue from that state.

The product lesson for nightCrawl is not "replace headless with visible browser." It is:

- Keep CloakBrowser/headless as the stable default for batch work.
- Add an explicit real-browser bridge for identity-pinned work.
- Make bridge state visible and recoverable: connected, attached, stale, recovering, failed.
- Implement robust tab/session rebinding after reconnects.
- Separate DOM, CDP, and OS input tiers.
- Diagnose extension conflicts and reconnect loops before starting real work.

## Roadmap/doc updates made

The roadmap/PRD updates were implemented in:

- `/Users/yinanli/Documents/nightCrawl/docs/PRD.md`
- `/Users/yinanli/Documents/nightCrawl/docs/product-notes/agent-centric-roadmap.md`
- `/Users/yinanli/Documents/nightCrawl/.codex/spec/project/real-browser-bridge.md`
- `/Users/yinanli/Documents/nightCrawl/.codex/spec/project/index.md`

Gaps now captured:

- Real-browser bridge UX.
- Visible-session mode.
- Extension-conflict diagnostics.
- Robust tab/session rebinding.
- DOM vs CDP vs OS input tiers.
- Bridge-specific benchmark and security requirements.

