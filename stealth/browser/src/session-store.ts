/**
 * [INPUT]: Depends on config.resolveConfig (stateDir), hostile-domains.filterHostileCookies,
 *          handoff-cookie-import.replaceCookiesFor, and a Playwright BrowserContext.
 * [OUTPUT]: Exports sessionFilePath, checkpointSession, restoreSession, flushNativeProfile.
 * [POS]: The SINGLE cookie-checkpoint chokepoint for the browser lifecycle.
 *
 * Why this module exists (Phase-0 persistence foundation):
 *   nightCrawl kept TWO cookie stores that drifted — Chromium's native profile
 *   SQLite (lazy WAL flush) and a JSON backup written only every 5 min / on
 *   graceful shutdown. A SIGKILL/crash, or a headless<->headed transition that
 *   SIGKILLs Chromium before its lazy flush, dropped freshly-set cookies. See
 *   memory/project_canvas_stale_request_2026_04_20 and the Session 10 HANDOFF.
 *
 *   The fix: ONE writer (checkpointSession) and ONE reader (restoreSession),
 *   both built on Playwright's own atomic storageState dump and routed through
 *   the existing replaceCookiesFor chokepoint so the dedup + hostile-cookie
 *   filter invariant is preserved. Callers checkpoint BEFORE any context.close()
 *   or kill, and restore (merge) AFTER every relaunch/startup, so neither a
 *   crash nor a transition can silently lose state.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BrowserContext } from 'playwright';
import { resolveConfig } from './config';
import { filterHostileCookies } from './hostile-domains';
import { replaceCookiesFor } from './handoff-cookie-import';

// ─── Paths ─────────────────────────────────────────────────

/**
 * The canonical session snapshot path. Lives in the per-project stateDir
 * (isolatable via BROWSE_STATE_FILE) next to browse.json, NOT in the global
 * profile — so each daemon owns its own backup and tests stay hermetic.
 */
export function sessionFilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveConfig(env).stateDir, 'session.json');
}

// ─── Checkpoint (the single writer) ────────────────────────

/**
 * Atomically snapshot the context's full storage state (cookies + per-origin
 * localStorage) to disk. Returns the cookie count written.
 *
 * Built on context.storageState(), which forces Playwright to read the LIVE
 * cookie set from Chromium — so a snapshot taken right after a navigation
 * captures cookies that have not yet flushed to the profile SQLite. The
 * tmp+rename keeps the file readable at all times even if we crash mid-write.
 */
export async function checkpointSession(
  context: BrowserContext,
  dest: string = sessionFilePath(),
): Promise<number> {
  if (process.env.BROWSE_INCOGNITO === '1') return 0;
  try {
    // Cookies only — restoreSession reads only `.cookies`, and storageState()
    // would also serialize every origin's localStorage (hundreds of KB on a
    // real profile) on a write that runs every ~1.5s during active use.
    // context.cookies() is the same live read, just scoped to what we restore.
    // Race a timeout — the read can hang if Chromium is mid-teardown, and this
    // runs on the close path where a hang would block shutdown/handoff.
    const cookies = await Promise.race([
      context.cookies(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('cookies read timeout')), 3000),
      ),
    ]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ cookies }), { mode: 0o600 });
    fs.renameSync(tmp, dest);
    return cookies.length;
  } catch {
    return 0;
  }
}

// ─── Restore (the single reader) ───────────────────────────

/**
 * Re-seed cookies from a checkpoint into the context.
 *
 *   'merge'   (default) — upsert via addCookies; cookies already in the context
 *             win on conflict. Use after a relaunch/startup where the live
 *             context (native profile) may legitimately hold NEWER cookies than
 *             the snapshot — we only want to recover anything that was lost.
 *   'replace' — clear-per-domain then add via replaceCookiesFor. Use when the
 *             snapshot is authoritative.
 *
 * Always routes through filterHostileCookies first (XHS et al. never restored,
 * see hostile-domains.ts + project_xhs_account_ban_2026_04_09). Returns the
 * number of cookies applied; 0 (never throws) on a missing/garbage file.
 */
export async function restoreSession(
  context: BrowserContext,
  src: string = sessionFilePath(),
  mode: 'merge' | 'replace' = 'merge',
): Promise<number> {
  if (process.env.BROWSE_INCOGNITO === '1') return 0;
  let parsed: { cookies?: unknown[] };
  try {
    parsed = JSON.parse(fs.readFileSync(src, 'utf-8'));
  } catch {
    return 0;
  }
  const cookies = Array.isArray(parsed?.cookies) ? (parsed.cookies as any[]) : [];
  const safe = filterHostileCookies(cookies as any);
  if (safe.length === 0) return 0;
  try {
    if (mode === 'replace') {
      await replaceCookiesFor(context, safe as any);
    } else {
      await context.addCookies(safe as any);
    }
    return safe.length;
  } catch {
    return 0;
  }
}

// ─── Native-profile WAL nudge ──────────────────────────────

/**
 * Best-effort nudge for Chromium to checkpoint its cookie SQLite WAL before a
 * forced kill. Opening + closing a throwaway about:blank page gives Chromium a
 * lifecycle beat to flush. Cheap belt-and-suspenders on the close path; the
 * JSON checkpoint above is the real durability guarantee.
 */
export async function flushNativeProfile(context: BrowserContext): Promise<void> {
  try {
    const page = await context.newPage();
    await page.goto('about:blank').catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
    await page.close().catch(() => {});
  } catch {
    // Non-fatal — flush is opportunistic.
  }
}
