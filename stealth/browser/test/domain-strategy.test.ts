/**
 * [INPUT]: Depends on domain-strategy.ts (per-domain engine memory).
 * [OUTPUT]: Verifies record/recall by eTLD+1, latest-winner semantics, TTL
 *           expiry, atomic write, and graceful handling of a missing store.
 * [POS]: Phase-1 advisor support test — the memory that feeds the engine
 *        recommendation the agent sees. Pure logic, no browser.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the store into a temp stateDir (domain-strategy derives its path from
// resolveConfig().stateDir, which is keyed off BROWSE_STATE_FILE).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-domstrat-'));
process.env.BROWSE_STATE_FILE = path.join(TMP, 'state', 'browse.json');
fs.mkdirSync(path.dirname(process.env.BROWSE_STATE_FILE), { recursive: true });

import {
  rememberedEngine,
  recordWin,
  pruneStrategy,
  listStrategy,
  strategyFilePath,
} from '../src/domain-strategy';

function clearStore() {
  try { fs.unlinkSync(strategyFilePath()); } catch {}
}

describe('domain-strategy memory', () => {
  beforeEach(clearStore);

  test('unknown domain returns null', () => {
    expect(rememberedEngine('https://never-seen.example/path')).toBeNull();
  });

  test('records a win and recalls it by eTLD+1 (subdomain-insensitive)', () => {
    recordWin('https://canvas.uw.edu/courses/1', 'real');
    // Different subdomain, same registrable domain → same memory.
    expect(rememberedEngine('https://www.uw.edu/library')).toBe('real');
  });

  test('remembers the LATEST winning engine (prefers headless when it works again)', () => {
    recordWin('https://example.com/a', 'real');
    expect(rememberedEngine('https://example.com/b')).toBe('real');
    recordWin('https://example.com/c', 'headless');
    expect(rememberedEngine('https://example.com/d')).toBe('headless');
  });

  test('expired entries (older than TTL) are treated as no memory', () => {
    recordWin('https://stale.example/x', 'real');
    // Backdate the entry past the 30-day TTL by editing the store directly.
    const store = JSON.parse(fs.readFileSync(strategyFilePath(), 'utf-8'));
    const key = Object.keys(store.entries)[0];
    store.entries[key].lastWin = Date.now() - 40 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(strategyFilePath(), JSON.stringify(store));
    expect(rememberedEngine('https://stale.example/y')).toBeNull();
  });

  test('pruneStrategy drops expired entries', () => {
    recordWin('https://keep.example/x', 'headless');
    recordWin('https://drop.example/x', 'real');
    const store = JSON.parse(fs.readFileSync(strategyFilePath(), 'utf-8'));
    store.entries['drop.example'].lastWin = Date.now() - 40 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(strategyFilePath(), JSON.stringify(store));
    pruneStrategy();
    const domains = listStrategy().map((e) => e.domain);
    expect(domains).toContain('keep.example');
    expect(domains).not.toContain('drop.example');
  });

  test('write is atomic — no leftover .tmp', () => {
    recordWin('https://example.org/x', 'real');
    expect(fs.existsSync(strategyFilePath())).toBe(true);
    expect(fs.existsSync(strategyFilePath() + '.tmp')).toBe(false);
  });

  test('recordWin bumps wins on repeat, resets on engine change', () => {
    recordWin('https://wins.example/x', 'headless');
    recordWin('https://wins.example/y', 'headless');
    let entry = listStrategy().find((e) => e.domain === 'wins.example')!;
    expect(entry.wins).toBe(2);
    recordWin('https://wins.example/z', 'real');
    entry = listStrategy().find((e) => e.domain === 'wins.example')!;
    expect(entry.engine).toBe('real');
    expect(entry.wins).toBe(1);
  });
});
