# Stealth Engine Architecture

CloakBrowser is the only browser engine. Stock Playwright (Chrome for Testing)
was removed because it is detectable by every Tier-1+ bot-detection vendor. There
is no fallback path -- if CloakBrowser is unavailable, launch fails with install
instructions. This is deliberate: silent fallback to a detectable binary caused
false-positive verifier passes before 2026-04-14.

## Engine Selection

`engine-config.ts` exports `parseEngineConfig()`. The return type `BrowserEngine`
is the literal `'cloakbrowser'`. The `BROWSE_ENGINE` env var is no longer parsed.

`cloakbrowser-engine.ts` exports `launchCloakBrowser()`, `shouldSkipCdpPatches()`,
and `patchScreencast()`. It dynamically imports the `cloakbrowser` npm package at
launch time. Failure to import throws a fatal error with `bun add cloakbrowser@latest`
as the fix.

## Fingerprint Seed Persistence

Bot-managed sites (Cloudflare Turnstile, DataDome, Kasada) pin session cookies to
the browser fingerprint that solved the challenge. If the seed changes between
sessions -- or between headless and headed handoff -- cookies become invalid.

Seed resolution order (in `engine-config.ts`):
1. `BROWSE_FINGERPRINT_SEED` env var (explicit override, range 10000-99999)
2. `~/.nightcrawl/state/engine-seed.json` (persistent per-machine)
3. Generate and persist a new random seed

`getPersistentSeed()` reads the JSON file synchronously. On first call it generates
a seed, writes it, and returns. Race-safe under concurrent processes: last-write-wins,
both agree on the same seed afterwards.

Every headless AND headed launch uses the same seed. `browser-handoff.ts` routes
both `launchHeaded` and handoff relaunches through `launchCloakBrowser` so the
fingerprint matches across mode transitions.

## CloakBrowser Launch Contract

`launchCloakBrowser()` in `cloakbrowser-engine.ts` accepts `CloakBrowserLaunchOptions`:
- `fingerprintSeed` -- passed as `--fingerprint=N` to Chromium args
- `extensionsDir` -- `--disable-extensions-except` + `--load-extension`
- `userDataDir` -- persistent context for extensions (uses temp profile if omitted)
- `headless` -- defaults to `true`
- `humanize` / `humanPreset` -- CloakBrowser behavioral humanization
- `locale` -- BCP 47 tag; passed as `--lang=` and `--accept-lang=` because
  CloakBrowser's C++ patches seed `navigator.language` from `--lang`, not from
  Playwright's `locale` option

Critical invariant: `stealthArgs: true` is ALWAYS passed, even when an explicit
fingerprint seed is provided. Turning off stealth args broke Cloudflare on
2026-04-19.

## CDP Patch Layer

`stealth.ts` provides `applyStealthPatches()` which copies rebrowser-patches
v1.0.19 (adapted for Playwright 1.58.2) over Playwright server files. The 6
patched files live at `stealth/patches/cdp/` (4 Chromium + 2 core). Patches target
both bun cache and local `node_modules`.

`isPatchCurrent()` compares file size + mtime to skip redundant copies.

`shouldSkipCdpPatches()` returns `true` for the `cloakbrowser` engine -- CloakBrowser
has its own CDP patches baked in. The manual patches exist for headed Chrome-for-Testing
fallback paths (e.g., legacy `launchHeaded` in `browser-handoff.ts`).

## JS-Level Stealth Scripts

`applyStealthScripts()` in `stealth.ts` injects init scripts into every page:
- Delete `navigator.webdriver` from prototype, redefine with getter returning `false`
- Remove `cdc_*` / `$cdc_*` ChromeDriver properties from `window`
- Set `navigator.languages` to `['en-US', 'en', 'zh-CN', 'zh']`
- Patch `navigator.permissions.query` for notifications
- Ensure `window.chrome` looks real (runtime, loadTimes, csi)

## PW 1.59.1 Screencast Compat

CloakBrowser pages skip Playwright's `Page` constructor that initializes the
`screencast` property. `BrowserContext.close()` crashes when it iterates
internal pages and calls `screencast.handlePageOrContextClose()`.

`patchScreencast()` adds a no-op stub. `patchContextClose()` wraps
`context.close()` to catch and swallow screencast errors. Non-screencast
errors are re-thrown.

## Fingerprint-Pinned Domain Detection

`fingerprint-pinned.ts` classifies domains whose bot-management vendor pins
sessions to the solving browser's fingerprint. Detection methods:
- Header sniffing via `sniffVendor()`: `cf-mitigated` (Cloudflare active challenge),
  `x-datadome` (DataDome), `x-kpsdk-*` (Kasada), `x-px-*` (PerimeterX)
- Observational marking via `markPinnedObserved()`: when Arc cookie import fails
  to clear a login wall, the domain is empirically pinned

Cache persisted to `~/.nightcrawl/state/fingerprint-pinned.json` with 30-day TTL.
Pinned domains get shortened default-browser poll intervals (5min -> 30s) and
route straight to headed CloakBrowser.

## Verification Surface

Test files:
- `test/cloakbrowser-integration.test.ts` -- engine launch and fingerprint
- `test/stealth-cdp.test.ts` -- CDP patch application
- `test/stealth-ua.test.ts` -- UA consistency
- `test/stealth-verify.test.ts` -- bot-detector pass/fail
- `test/stealth-extensions.test.ts` -- extension loading
- `test/handoff-poll.test.ts` -- fingerprint-pinned poll behavior

Bot detection benchmark targets: `bot-detector.rebrowser.net`, `bot.sannysoft.com`,
`creepjs`.
