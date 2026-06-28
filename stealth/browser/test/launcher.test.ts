/**
 * [INPUT]: Depends on launcher.ts (renderLauncher, shellQuote, chooseInstallDir).
 * [OUTPUT]: Verifies the generated launcher execs bun+cli with "$@", quoting is safe,
 *           and the install dir is chosen as on-PATH+writable first.
 * [POS]: Pillar A5 test. Pure logic — proves the zero-setup launcher that removes the
 *        23x PATH/NC re-export blocks seen in the Cursor-course session.
 */

import { describe, test, expect } from 'bun:test';
import { renderLauncher, shellQuote, chooseInstallDir } from '../src/launcher';

describe('shellQuote', () => {
  test('single-quotes and escapes embedded quotes', () => {
    expect(shellQuote('/a/b')).toBe("'/a/b'");
    expect(shellQuote("/a b/c")).toBe("'/a b/c'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('renderLauncher', () => {
  test('execs bun run <cli> forwarding all args', () => {
    const s = renderLauncher('/Users/x/.bun/bin/bun', '/repo/stealth/browser/src/cli.ts');
    expect(s.startsWith('#!/bin/sh')).toBe(true);
    expect(s).toContain("exec '/Users/x/.bun/bin/bun' run '/repo/stealth/browser/src/cli.ts' \"$@\"");
  });
});

describe('chooseInstallDir', () => {
  const writableAll = () => true;
  const HOME_LOCAL = '/h/.local/bin';
  const HOME_BUN = '/h/.bun/bin';
  const FALLBACK = '/h/.nightcrawl/bin';

  test('prefers a candidate that is on PATH AND writable', () => {
    const r = chooseInstallDir([HOME_BUN, '/usr/bin'], [HOME_LOCAL, HOME_BUN], FALLBACK, writableAll);
    expect(r).toEqual({ dir: HOME_BUN, onPath: true }); // .local not on PATH → picks .bun
  });

  test('falls back to a writable off-PATH candidate when none are on PATH', () => {
    const r = chooseInstallDir(['/usr/bin'], [HOME_LOCAL, HOME_BUN], FALLBACK, (d) => d === HOME_LOCAL);
    expect(r).toEqual({ dir: HOME_LOCAL, onPath: false });
  });

  test('falls back to the dedicated dir when no candidate is writable', () => {
    const r = chooseInstallDir(['/usr/bin'], [HOME_LOCAL, HOME_BUN], FALLBACK, () => false);
    expect(r).toEqual({ dir: FALLBACK, onPath: false });
  });
});
