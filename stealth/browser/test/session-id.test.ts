/**
 * [INPUT]: Depends on session-id.ts (session identity resolver).
 * [OUTPUT]: Verifies resolveSessionId precedence/namespacing/fallbacks and
 *           sanitizeSessionId clamping/charset filtering.
 * [POS]: Session identity layer test. Pure logic, no Chrome, no daemon — this is
 *        the data-driven multi-agent mapping that keeps two sessions' tabs apart.
 */

import { describe, test, expect } from 'bun:test';
import {
  resolveSessionId,
  sanitizeSessionId,
  SESSION_SOURCES,
  DEFAULT_SESSION_ID,
} from '../src/session-id';

describe('sanitizeSessionId', () => {
  test('empty / null / undefined → default', () => {
    expect(sanitizeSessionId('')).toBe(DEFAULT_SESSION_ID);
    expect(sanitizeSessionId(null)).toBe(DEFAULT_SESSION_ID);
    expect(sanitizeSessionId(undefined)).toBe(DEFAULT_SESSION_ID);
  });

  test('strips unsafe characters, keeps [A-Za-z0-9._:-]', () => {
    expect(sanitizeSessionId('claude:ab cd/ef')).toBe('claude:abcdef');
    expect(sanitizeSessionId('a_b.c-d:e')).toBe('a_b.c-d:e'); // . _ - : all allowed
  });

  test('clamps to 64 chars', () => {
    const long = 'x'.repeat(200);
    expect(sanitizeSessionId(long).length).toBe(64);
  });

  test('all-unsafe input collapses to default', () => {
    expect(sanitizeSessionId('////')).toBe(DEFAULT_SESSION_ID);
  });
});

describe('resolveSessionId', () => {
  test('explicit NIGHTCRAWL_SESSION_ID wins, verbatim (no prefix)', () => {
    expect(resolveSessionId({ NIGHTCRAWL_SESSION_ID: 'my-job' })).toBe('my-job');
  });

  test('override beats a known agent harness var', () => {
    const id = resolveSessionId({
      NIGHTCRAWL_SESSION_ID: 'manual',
      CLAUDE_CODE_SESSION_ID: 'abc',
    });
    expect(id).toBe('manual');
  });

  test('Claude Code session id is namespaced with claude:', () => {
    expect(resolveSessionId({ CLAUDE_CODE_SESSION_ID: 'bc47588b-9c84' })).toBe(
      'claude:bc47588b-9c84',
    );
  });

  test('registry precedence: earlier source wins over later', () => {
    // claude row precedes codex/cursor in SESSION_SOURCES
    const id = resolveSessionId({
      CLAUDE_CODE_SESSION_ID: 'cc',
      CODEX_SESSION_ID: 'cx',
      CURSOR_SESSION_ID: 'cu',
    });
    expect(id).toBe('claude:cc');
  });

  test('untagged plain-shell callers share the one default workspace', () => {
    // Was proc:<ppid>, which fragmented every fresh-shell CLI call into its own
    // empty workspace ("No active page" x28 in the Cursor-course session). Untagged
    // callers now share `default` so a follow-up command finds the prior tab.
    expect(resolveSessionId({})).toBe(DEFAULT_SESSION_ID);
    expect(resolveSessionId({ FOO: 'bar' })).toBe(DEFAULT_SESSION_ID);
  });

  test('blank env values fall back to default (whitespace-only ignored)', () => {
    expect(resolveSessionId({ CLAUDE_CODE_SESSION_ID: '   ' })).toBe(DEFAULT_SESSION_ID);
  });

  test('deterministic for the same input', () => {
    const env = { CLAUDE_CODE_SESSION_ID: 'same' };
    expect(resolveSessionId(env)).toBe(resolveSessionId(env));
  });

  test('SESSION_SOURCES is extensible and ordered (override first)', () => {
    expect(SESSION_SOURCES[0].env).toBe('NIGHTCRAWL_SESSION_ID');
    expect(SESSION_SOURCES[0].prefix).toBe('');
    expect(SESSION_SOURCES.some((s) => s.env === 'CLAUDE_CODE_SESSION_ID')).toBe(true);
  });
});
