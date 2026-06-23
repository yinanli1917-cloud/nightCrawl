# Kimi WebBridge Real Arc Benchmark

Date: 2026-05-20

This is the real install/run benchmark in the user's default Arc browser. It supersedes the earlier static-only review for Arc behavior.

## Install State

Kimi WebBridge is installed in the real user environment:

- Daemon: `~/.kimi-webbridge/bin/kimi-webbridge`
- Daemon version: `v1.9.7`
- Daemon status: `running: true`
- Listening address: `127.0.0.1:10086`
- Extension connected: `true`
- Extension ID: `fldmhceldgbpfpkbgopacenieobmligc`
- Extension version: `1.9.7`
- Arc extension path: `~/Library/Application Support/Arc/User Data/Default/Extensions/fldmhceldgbpfpkbgopacenieobmligc/1.9.7_0`
- Installed skills:
  - `~/.codex/skills/kimi-webbridge`
  - `~/.claude/skills/kimi-webbridge`
  - `~/.config/agents/skills/kimi-webbridge`
  - `~/.agents/skills/kimi-webbridge`

Footprint observed:

- `~/.kimi-webbridge`: 9.1 MB
- `~/.codex/skills/kimi-webbridge`: 20 KB
- Arc extension files: 324 KB
- Daemon RSS during benchmark: ~20 MB

## Extension Permissions

Arc's installed extension manifest has:

```json
{
  "permissions": ["tabs", "activeTab", "debugger", "storage", "alarms", "tabGroups", "windows"],
  "host_permissions": ["<all_urls>"]
}
```

This is a powerful browser-control surface. `debugger` is the key permission: it lets the extension use Chrome DevTools Protocol operations against tabs. `<all_urls>` gives the extension host access everywhere.

## Mechanism

The WeChat article says WebBridge marks the browser tab it is operating, but does not occupy the mouse or keyboard. The installed skill and extension code explain how:

- Agent sends HTTP commands to the local daemon at `http://127.0.0.1:10086/command`.
- Daemon forwards tool calls over WebSocket to the browser extension.
- Extension uses browser APIs:
  - `chrome.tabs.create/query/get/group`
  - `chrome.tabGroups`
  - `chrome.debugger.attach`
  - `chrome.debugger.sendCommand`
- Extension uses CDP commands:
  - `Page.navigate`
  - `Runtime.evaluate`
  - `DOM.querySelector`
  - `Input.dispatchMouseEvent`
  - `Input.dispatchKeyEvent`
  - `Network.enable`
  - `Network.getResponseBody`

This does not require OS-level mouse movement or keyboard focus. It sends commands directly into the browser/tab process. That is why the user can keep using the computer. It still controls the browser tab/profile where the extension is installed.

The installed Kimi skill also documents a product boundary: DOM-level click/fill are synthetic and can have `isTrusted=false`, so strict sites may reject them.

## Arc Real-Run Result

Task: navigate Arc to a local benchmark page, fill two fields, click Generate, and read result text.

Benchmark target:

- `artifacts/kimi-real-benchmark/target.html`
- served during test at `http://127.0.0.1:8765/target.html`

Kimi WebBridge in Arc:

| Step | Result | Latency |
|---|---|---:|
| `navigate` local benchmark page | Visibly opened the page in Arc, but HTTP command timed out | 30,015 ms |
| `snapshot` | failed: session had no bound tab / 502 | 0.7 ms |
| `fill #name` | failed: session had no bound tab / 502 | 0.4 ms |
| `fill #notes` | failed: session had no bound tab / 502 | 0.4 ms |
| `click #generate` | failed: session had no bound tab / 502 | 0.3 ms |
| `evaluate result` | failed: session had no bound tab / 502 | 0.3 ms |
| `list_tabs` | succeeded but returned empty tabs for the session | 0.8 ms |

Second task: navigate to `https://example.com`.

| Step | Result | Latency |
|---|---|---:|
| `navigate` example.com | Visibly opened the page in Arc, but HTTP command timed out | 60,014 ms |
| `snapshot` | failed: session had no bound tab / 502 | 0.7 ms |
| `list_tabs` | succeeded but returned empty tabs | 0.9 ms |

Probe: `find_tab` on active `example.com` tab timed out after 8 seconds, even though the tab was visibly open.

## Likely Arc Failure Layer

Arc is Chromium-based, and WebBridge definitely installed and connected. The failure is not "Arc is not Chromium."

The observed sequence is:

1. `chrome.tabs.create` works, because Kimi WebBridge visibly opens/navigates Arc tabs.
2. The extension then tries to group/bind/attach the tab to the Kimi session.
3. The command never returns.
4. Follow-up tools fail because the daemon has no session tab.

Static extension code shows `navigate` does this after creating the tab:

- set current tab id
- optionally group it through `chrome.tabGroups`
- call `chrome.debugger.attach({ tabId }, "1.3")`
- wait for load
- send `tool_result` back to daemon

`find_tab` also times out, and its code path reaches `chrome.debugger.attach` after locating the active tab. The strongest current hypothesis is that Arc accepts tab creation but the extension's debugger attach/session path does not complete correctly in Arc.

This is an empirical finding, not a Chromium-family claim.

## nightCrawl Same Task Result

Same local target, same fill/click/read task, using nightCrawl with `BROWSE_EXTENSIONS=none`:

| Step | Result | Latency |
|---|---|---:|
| `status` | healthy after cold launch | 10,889 ms |
| `goto` local benchmark page | success | 2,242 ms |
| `fill #name` | success | 82.5 ms |
| `fill #notes` | success | 49.5 ms |
| `click #generate` | success | 71.6 ms |
| `js result text` | `Result: nightCrawl | real benchmark` | 46.7 ms |

## Local Service Security Findings

The WebSocket endpoint rejects a raw non-extension WebSocket request:

- `GET /ws` without an approved origin returned `403 forbidden origin`.

However, the HTTP command endpoint accepted commands from a hostile Origin header:

```text
POST /command
Origin: https://evil.example
Content-Type: application/json
```

returned `200 OK`.

It also accepted a simple `text/plain` POST with a hostile Origin:

```text
POST /command
Origin: https://evil.example
Content-Type: text/plain
```

returned `200 OK`.

This matters because a malicious webpage may not be able to read responses due to CORS, but it may be able to send simple POSTs that trigger local side effects unless the daemon rejects browser Origins or requires an unguessable token. This needs deeper CSRF/browser-origin testing before calling the local service safe.

## Telemetry Findings

Kimi's docs say login states and page content stay local. The daemon logs show separate telemetry is enabled.

Observed log facts:

- `telemetry: enabled`
- outbound requests to `gator.volces.com` through DataRangers Golang SDK
- daemon sends events:
  - `webbridge_daemon_start`
  - `webbridge_daemon_alive`
  - `webbridge_command_call`
- command telemetry includes at least:
  - daemon version
  - OS/arch
  - device ID
  - session name
  - tool/action name

I did not observe page content in the telemetry logs, but command metadata does leave the machine.

## Current Bottom Line

Kimi WebBridge is installed in the user's real Arc browser and connected. It can visibly open/navigate Arc tabs without taking over the OS mouse/keyboard. In this Arc run, it did not complete command responses or bind controlled tabs to sessions, so it failed the real fill/click/read benchmark.

nightCrawl completed the same local task successfully.

The architectural distinction remains:

- Kimi WebBridge controls the real browser through extension + daemon + CDP.
- It does not need OS-level computer control.
- In Arc specifically, the extension connects and tab creation works, but the deeper debugger/session control path appears broken or hanging.
- The daemon also has telemetry and an HTTP `/command` surface that needs stronger adversarial testing.

