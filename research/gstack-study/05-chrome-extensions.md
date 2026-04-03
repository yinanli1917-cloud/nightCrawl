# Chrome Extensions in gstack browse — How Our Contribution Works

> Date: 2026-03-23
> Context: We contributed PR #315 to gstack, adding Chrome extension support.
> This document explains the full mechanism from the ground up.

---

## Layer 1: What IS a Chrome Extension

A Chrome extension is just a folder of files. Nothing magical:

```
~/Downloads/bypass-paywalls-chrome-clean-master/
├── manifest.json          ← the "ID card" — tells Chrome what this extension does
├── background.js          ← code that runs in the background, intercepting requests
├── contentScript.js       ← code that gets injected INTO web pages
├── sites.js               ← list of sites this extension knows how to handle
└── ...
```

The most important file is `manifest.json`. It's like a `package.json` for extensions — it declares:

- **Name and version** — what is this extension
- **Permissions** — what it's allowed to do (read URLs, modify HTTP headers, inject scripts)
- **Background scripts** — code that runs persistently, watching all browser traffic
- **Content scripts** — code that gets injected into specific web pages

---

## Layer 2: How Chrome Loads an Extension

When Chrome starts, it looks for extensions in two ways:

1. **Installed extensions** — stored in Chrome's internal user data directory, downloaded from Chrome Web Store
2. **Side-loaded extensions** — loaded from a local folder via command-line flags

The command-line flags are:

```
--load-extension=/path/to/extension/folder
--disable-extensions-except=/path/to/extension/folder
```

The first flag says "load this folder as an extension." The second says "don't load anything else — only this one." Together, they give you a clean Chromium with exactly one extension.

---

## Layer 3: What bypass-paywalls Actually Does

This is the interesting part. When you visit `wsj.com/tech`, here's what normally happens:

```
Your browser → HTTP request → WSJ server
                                  ↓
                          WSJ checks: "Is this a paying subscriber?"
                                  ↓
                          Checks cookies, checks Referer header
                                  ↓
                          No subscription cookie → 401 Unauthorized
```

What bypass-paywalls does is intercept the HTTP request **before it leaves your browser** and modify the headers:

```
Your browser → bypass-paywalls intercepts → modifies headers → WSJ server
                                                                    ↓
                                                  WSJ checks modified request
                                                                    ↓
                                                  Sees Googlebot Referer → 200 OK
```

Many paywall sites have a loophole: they let Google's crawler read their full content (so articles appear in search results). The extension exploits this by adding or modifying HTTP headers to make the request look like it's coming from Google's crawler.

For different sites, it uses different strategies — some need a modified `Referer` header, some need modified cookies, some need JavaScript removed from the page. That's what `background.js` does — it registers a listener on **every HTTP request** the browser makes, checks if the URL matches a known paywall site (from `sites.js`), and if so, modifies the request headers before they're sent.

---

## Layer 4: Why Headless Mode Blocks Extensions

Chromium has two modes:

- **Headed** — normal browser with a window, full feature set
- **Headless** — no window, stripped-down for speed

Headless mode was designed for automated testing and server-side rendering. Google deliberately **disabled extension loading** in headless mode. The reasoning: headless is for automation, extensions are for humans, mixing them creates security risks (malicious extensions in automated pipelines).

There's also `--headless=new` (a newer headless mode that more closely mimics headed behavior), but it also doesn't support extensions. We tested both — confirmed they don't work:

| Mode | Extensions Work? | Test Result |
|------|-----------------|-------------|
| `headless: true` | No | WSJ returned anti-bot verification page |
| `--headless=new` | No | Same — captcha challenge page |
| `headless: false` (headed) | Yes | WSJ returned full article content |

---

## Layer 5: The Off-Screen Window Trick

Since extensions require headed mode, but gstack browse needs to behave like headless (no visible window, runs in background), we use a trick:

```
headed mode + window at position (-9999, -9999) + window size 1x1
= effectively invisible, but Chromium thinks it's headed
= extensions load and work normally
```

The window exists, but it's 9999 pixels off the left edge of your screen. You never see it. macOS doesn't even render it. But Chromium's internal code sees "I'm in headed mode" and loads the extensions.

This is the key insight that makes the whole thing work.

---

## Layer 6: The Full Chain

Here's what happens when Claude Code runs `$B goto https://www.wsj.com/tech` with our change:

```
1. Claude Code executes:
   ~/.gstack/browse/dist/browse goto https://www.wsj.com/tech

2. CLI reads browse.json → finds daemon is not running → starts server

3. Server calls BrowserManager.launch()
   → reads process.env.BROWSE_EXTENSIONS_DIR
   → finds: ~/Downloads/bypass-paywalls-chrome-clean-master
   → sets launch args:
       --load-extension=~/Downloads/bypass-paywalls-chrome-clean-master
       --disable-extensions-except=~/Downloads/bypass-paywalls-chrome-clean-master
       --window-position=-9999,-9999
       --window-size=1,1
   → sets headless: false

4. Playwright calls chromium.launch({ headless: false, args: [...] })
   → Chromium process starts
   → Chromium sees --load-extension flag
   → Reads manifest.json from the extension folder
   → Loads background.js as a service worker
   → bypass-paywalls is now active, watching all HTTP traffic

5. Server creates BrowserContext + Page (same as before, unchanged)

6. CLI sends HTTP POST to daemon: goto https://www.wsj.com/tech

7. Daemon calls page.goto("https://www.wsj.com/tech")
   → Chromium prepares HTTP request to wsj.com
   → bypass-paywalls background.js intercepts the request
   → Checks sites.js — wsj.com is a known paywall site
   → Modifies Referer header to look like Google
   → Request goes out with modified headers

8. WSJ server receives request
   → Sees Google-like Referer
   → Returns 200 OK with full article content

9. Daemon returns "Navigated to https://www.wsj.com/tech (200)"

10. Next command: $B text
    → Returns full WSJ article text
    → Claude Code reads it, uses it for research
```

---

## Layer 7: Why Our Change is Minimal

The beauty of what we did is that we only changed **one decision point** in `launch()`:

```typescript
// BEFORE (always headless, no extensions possible)
this.browser = await chromium.launch({ headless: true });

// AFTER (check env var, conditionally enable extensions)
const extensionsDir = process.env.BROWSE_EXTENSIONS_DIR;
if (extensionsDir) {
  // headed + off-screen + load extension
} else {
  // headless as before — zero behavior change
}
```

Everything downstream — the context creation, page management, cookie handling, command routing, error handling — is completely untouched. The rest of gstack doesn't know or care whether an extension is loaded. It just sees that pages return different content now.

That's why the PR was a clean 22-line addition with no risk of breaking existing behavior. If `BROWSE_EXTENSIONS_DIR` is not set, the code path is identical to the original.

---

## Layer 8: The Design Decision — Environment Variable, Not Config File

We chose an environment variable (`BROWSE_EXTENSIONS_DIR`) over a config file for three reasons:

1. **Fits gstack's existing pattern.** gstack already uses env vars for configuration (`BROWSE_PORT`, `BROWSE_IDLE_TIMEOUT`). Adding another one is consistent.

2. **One line to enable, one line to disable.** Add `export BROWSE_EXTENSIONS_DIR=...` to `.zshrc` and it's always on. Remove the line and it's gone. No config files to manage, no JSON to parse.

3. **The daemon inherits the env var.** When the CLI starts the server process, the child process inherits all environment variables from the parent. So if `.zshrc` sets `BROWSE_EXTENSIONS_DIR`, every browse daemon launched from that shell automatically has it. No plumbing needed.

---

## Relationship to Document 04

This document extends Section 4 (Browser Automation) and Section 7 (Full Workflow) of `04-technical-foundations.md`. Specifically:

- **Section 4** explained how Playwright controls Chromium. This document adds: Chromium can also load extensions, which modify browser behavior at the HTTP request level.
- **Section 7** traced the full chain from CLI command to page navigation. This document adds a new step between "Chromium prepares HTTP request" and "request goes out" — the extension interception layer.
- **Section 9** (Error Handling Philosophy) still applies: if the extension fails or the env var points to an invalid path, Chromium silently ignores it and launches normally. No crash, no error. The "don't try to self-heal, just degrade gracefully" principle is preserved.
