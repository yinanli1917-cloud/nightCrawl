# Cookie Management Pipeline

Cookies flow through four stages: import, decrypt, watch, and persist. Each stage
has distinct failure modes and security constraints.

## Stage 1: Import

`cookie-import-browser.ts` is the unified entry point. It dispatches by browser
type:

- Chromium-family (Chrome, Arc, Brave, Edge, Chromium, Comet): reads the
  `Cookies` SQLite DB directly via `bun:sqlite`, decrypts AES-128-CBC values
- Firefox: delegates to `cookie-import-firefox.ts`, reads `cookies.sqlite`
- Safari: delegates to `cookie-import-safari.ts`, reads `Cookies.binarycookies`

Browser registry is hardcoded in `BROWSER_REGISTRY` (6 Chromium browsers) plus
`FIREFOX_BROWSER_INFO` and `SAFARI_BROWSER_INFO`. User input is never interpolated
into shell commands.

Profile resolution: `listProfiles()` scans `Default` and `Profile N` directories.
Display names are read from the browser's `Preferences` JSON (email > profile name
> directory name).

Domain expansion: `importCookies()` expands each domain to include dot-prefixed
variants (`.zhihu.com` for domain-wide vs `www.zhihu.com` for host-only). Without
this, auth cookies are missed.

## Stage 2: Decrypt

Decryption pipeline (Chromium-family only):

1. Resolve cookie DB: `~/Library/Application Support/<browser>/<profile>/Cookies`
   (macOS) or `~/.config/<browser>/<profile>/Cookies` (Linux)
2. Derive AES key:
   - macOS v10: Keychain password via `security find-generic-password`, then
     `PBKDF2(password, 'saltysalt', iterations=1003, keyLen=16, sha1)`
   - Linux v10: `PBKDF2('peanuts', 'saltysalt', iterations=1, keyLen=16, sha1)`
   - Linux v11: libsecret password via `secret-tool lookup`, iterations=1
3. For each `encrypted_value` starting with `v10`/`v11`:
   - Ciphertext = `encrypted_value[3:]`
   - IV = 16 bytes of `0x20` (space character)
   - Plaintext = AES-128-CBC-decrypt, remove PKCS7 padding
   - Skip first 32 bytes (Chromium metadata), remainder is the cookie value
4. Chromium epoch: microseconds since 1601-01-01; convert via
   `(epoch - 11644473600000000) / 1000000` for Unix seconds

Key caching: `keyCache` (Map) stores derived keys per browser. First import per
browser incurs Keychain + PBKDF2 cost; subsequent imports reuse the cache.

DB locking: if the browser holds a WAL lock (`SQLITE_BUSY`), `openDbFromCopy()`
copies the DB + WAL + SHM to `/tmp`, opens read-only, and cleans up on close.

Keychain timeout: `getMacKeychainPassword()` spawns `security` with a 10-second
timeout. If macOS shows an Allow/Deny dialog, the error message tells the user
to click Allow.

## Stage 3: Watch

`cookie-watch.ts` exports `watchBrowserCookieDb()`. It watches the directory
containing the cookie SQLite DB (not the file itself -- `fs.watch` is unreliable
for atomic-rename on macOS). Events are debounced (default 2 seconds) to coalesce
SQLite write bursts (page write -> WAL flush -> journal commit).

A 30ms warmup window swallows the spurious FSEvents "rename" event that fires at
watcher creation.

The watcher is a supplement, not a replacement: the 10-minute background poll in
`server.ts` remains as a safety net because macOS `fs.watch` occasionally drops
events under sandboxing or volume throttling.

## Stage 4: Persist (session checkpoint)

`session-store.ts` is the SINGLE cookie-checkpoint chokepoint — one writer
(`checkpointSession`) and one reader (`restoreSession`), replacing the old
`persist-storage.ts` dual-store (deleted). `checkpointSession()` reads the live
cookies via `context.cookies()` (races a 3s timeout so it can never hang the
close path) and writes `{cookies}` to `<stateDir>/session.json` via atomic
rename (`.tmp` -> final, `mode: 0o600`). `restoreSession()` reads it back and,
default `'merge'`, upserts via `context.addCookies` (or `'replace'` via
`replaceCookiesFor`), always after `filterHostileCookies`. `flushNativeProfile()`
opens+closes an `about:blank` page to nudge Chromium's cookie-SQLite WAL flush
before a forced kill.

Checkpoint triggers (the discipline — snapshot BEFORE any close/kill, restore
AFTER any relaunch/startup):
- Debounced ~1.5s after every cookie-mutating WRITE command (`server.ts`
  `scheduleCheckpoint`) — survives a SIGKILL/crash seconds after a fresh login.
- Before every `context.close()` in `browser-manager.close()`, `handoff()`,
  `resume()` (+ `flushNativeProfile`).
- Every 5 minutes (`storageFlushInterval`) and on daemon shutdown (SIGTERM).
- Restore: `server.ts` startup does an unconditional `restoreSession(..,'merge')`
  (replacing the old `nativeCookies < 50` heuristic that skipped fresh logins
  behind a populated profile); first-launch migration seeds once from the legacy
  `~/.nightcrawl/browse-cookies.json` if `session.json` is absent.

Skipped entirely when `BROWSE_INCOGNITO=1`.

## Hostile Domain Cookie Filtering

`hostile-domains.ts` provides `filterHostileCookies()` which strips cookies for
domains in the hardcoded `HOSTILE_DOMAINS` list (Xiaohongshu, Douyin, Weibo,
LinkedIn, Instagram, etc.). This filter takes NO env -- hostile-domain cookies
are ALWAYS filtered regardless of incognito mode. The cookie file must be safe
to load even if a future caller forgets the flag.

Background: 2026-04-09 incident where two Xiaohongshu accounts were permanently
banned because nightCrawl auto-restored real cookies on a hostile platform.

## Verification Surface

Test files:
- `test/cookie-import-browser.test.ts` -- Chromium import + decryption
- `test/cookie-import-firefox.test.ts` -- Firefox import
- `test/cookie-import-merge.test.ts` -- domain expansion and merge
- `test/cookie-watch.test.ts` -- FS watcher debounce
- `test/cookie-migration.test.ts` -- legacy format migration
- `test/hostile-domains.test.ts` -- blocklist enforcement
- `test/browser-manager-hostile.test.ts` -- hostile domain navigation blocking
