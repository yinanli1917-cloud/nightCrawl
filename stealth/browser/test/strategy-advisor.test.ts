/**
 * [INPUT]: Depends on strategy-advisor.ts (pure decision logic).
 * [OUTPUT]: Verifies the engine RECOMMENDATION per signal set, the enforcement
 *           tiers (soft advice / medium --force gate / hostile), and the
 *           injected guidance block. No browser, no fs — fully deterministic.
 * [POS]: Phase-1 advisor test. The agent decides; this proves the advice and
 *        the guardrails that surround that decision are correct.
 */

import { describe, test, expect } from 'bun:test';
import {
  advise,
  enforceChoice,
  formatGuidance,
  type AdvisorSignals,
} from '../src/strategy-advisor';

function signals(overrides: Partial<AdvisorSignals> = {}): AdvisorSignals {
  return {
    hostile: false,
    pinned: false,
    vendor: null,
    realBrowserSession: false,
    rememberedEngine: null,
    fileUploadTask: false,
    loginWall: false,
    cookieImportFailed: false,
    ...overrides,
  };
}

describe('advise — engine recommendation', () => {
  test('default is headless (background, safe)', () => {
    const a = advise(signals());
    expect(a.recommendation).toBe('headless');
    expect(a.strength).toBe('weak');
  });

  test('file-upload task strongly recommends headless (real cannot upload)', () => {
    const a = advise(signals({ fileUploadTask: true }));
    expect(a.recommendation).toBe('headless');
    expect(a.strength).toBe('strong');
  });

  test('fingerprint-pinned + logged-in real browser strongly recommends real', () => {
    const a = advise(signals({ pinned: true, vendor: 'cloudflare', realBrowserSession: true }));
    expect(a.recommendation).toBe('real');
    expect(a.strength).toBe('strong');
  });

  test('headless cookie replay failed but logged in → recommend real (borrow live session)', () => {
    const a = advise(signals({ cookieImportFailed: true, realBrowserSession: true }));
    expect(a.recommendation).toBe('real');
    expect(a.strength).toBe('strong');
  });

  test('login wall and NO session anywhere → handoff (the only legitimate handoff case)', () => {
    const a = advise(signals({ loginWall: true, realBrowserSession: false }));
    expect(a.recommendation).toBe('handoff');
  });

  test('remembered engine is used when no stronger signal applies', () => {
    const a = advise(signals({ rememberedEngine: 'real' }));
    expect(a.recommendation).toBe('real');
    expect(a.strength).toBe('weak');
  });

  test('a strong live signal overrides stale memory', () => {
    // Remembered headless, but the site is now pinned and we are logged in.
    const a = advise(signals({ rememberedEngine: 'headless', pinned: true, realBrowserSession: true }));
    expect(a.recommendation).toBe('real');
  });
});

describe('enforceChoice — the medium tier (--force gate)', () => {
  test('choosing headless against a STRONG real recommendation requires --force', () => {
    const s = signals({ pinned: true, realBrowserSession: true });
    const r = enforceChoice('headless', s, false);
    expect(r.allow).toBe(false);
    expect(r.code).toBe('ENGINE_OVERRIDE_REQUIRED');
  });

  test('the same choice is allowed once forced', () => {
    const s = signals({ pinned: true, realBrowserSession: true });
    expect(enforceChoice('headless', s, true).allow).toBe(true);
  });

  test('choosing real for a file-upload task requires --force (real cannot upload)', () => {
    const s = signals({ fileUploadTask: true });
    expect(enforceChoice('real', s, false).allow).toBe(false);
  });

  test('a choice that matches the recommendation is always allowed', () => {
    const s = signals({ pinned: true, realBrowserSession: true });
    expect(enforceChoice('real', s, false).allow).toBe(true);
  });

  test('a weak recommendation never gates the agent (no --force needed)', () => {
    const s = signals({ rememberedEngine: 'real' });
    expect(enforceChoice('headless', s, false).allow).toBe(true);
  });

  test('hostile domain is hard-blocked regardless of engine or --force', () => {
    const s = signals({ hostile: true });
    const r = enforceChoice('headless', s, true);
    expect(r.allow).toBe(false);
    expect(r.code).toBe('HOSTILE_BLOCKED');
  });
});

describe('formatGuidance — the injected block', () => {
  test('contains the recommendation, the chosen engine, and the live signals', () => {
    const s = signals({ pinned: true, vendor: 'cloudflare', realBrowserSession: true });
    const text = formatGuidance('headless', advise(s), s);
    expect(text).toContain('real');        // recommendation
    expect(text).toContain('cloudflare');  // vendor signal
    expect(text.toLowerCase()).toContain('headless'); // chosen engine surfaced
  });
});
