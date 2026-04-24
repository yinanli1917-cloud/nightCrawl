/**
 * [INPUT]: A cookie SQLite DB path (e.g. ~/Library/.../Arc/User Data/Default/Cookies)
 * [OUTPUT]: Exports watchBrowserCookieDb, CookieWatcher
 * [POS]: Real-time bridge between the user's default browser and the
 *        background sync. Drives runBackgroundSync the moment Arc/Chrome
 *        writes a cookie, instead of waiting up to 10 minutes for the
 *        next poll cycle.
 *
 * SQLite writes come in bursts: page write → WAL flush → journal commit.
 * We watch the directory (file-level fs.watch is unreliable across
 * atomic-rename workflows on macOS) and debounce the burst into a single
 * onChange call. Default debounce is 2s — long enough to coalesce a
 * cookie set into one sync, short enough to feel real-time to the user.
 *
 * The 10-minute background poll in server.ts stays in place as a safety
 * net: macOS fs.watch occasionally drops events when a process is
 * sandboxed or the volume is throttled, and the poll is the canonical
 * "we will see your login eventually" guarantee.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CookieWatcher {
  /** Path being watched — exposed for telemetry / `nc sync status` */
  watchedPath: string;
  /** Stop the watcher and clear any pending debounce timer. Idempotent. */
  stop(): void;
}

export interface WatchOptions {
  /** Debounce window for SQLite write bursts. Default 2000ms. */
  debounceMs?: number;
}

/**
 * Watch the directory containing a cookie SQLite DB. When the DB file
 * (or its WAL/journal sidecars) changes, debounce and call onChange.
 *
 * Errors thrown by onChange are swallowed (logged via console.error
 * could be added if useful) so a buggy callback doesn't kill the
 * watcher. The next event still fires normally.
 */
export function watchBrowserCookieDb(
  dbPath: string,
  onChange: () => void,
  opts: WatchOptions = {},
): CookieWatcher {
  const debounceMs = opts.debounceMs ?? 2000;
  const watchDir = path.dirname(dbPath);
  const dbFilename = path.basename(dbPath);
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  // FSEvents on macOS fires a spurious "rename" event for whatever
  // file existed in the dir at watcher creation. Swallow events for
  // a brief settle window so unrelated-file detection isn't poisoned
  // by that initial echo.
  const warmAt = Date.now() + 30;

  const watcher = fs.watch(watchDir, (_event, filename) => {
    if (stopped) return;
    if (!filename) return;
    if (Date.now() < warmAt) return;
    // Cookies, Cookies-journal, Cookies-wal, Cookies-shm
    if (!filename.startsWith(dbFilename)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try { onChange(); } catch {}
    }, debounceMs);
  });

  return {
    watchedPath: dbPath,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try { watcher.close(); } catch {}
    },
  };
}
