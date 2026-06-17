/**
 * [INPUT]: Depends on engine-routing.ts (server-side glue) which composes the
 *          pure advisor with the live signal sources (injectable here).
 * [OUTPUT]: Verifies signal gathering maps the classifiers correctly and the
 *           nav-guidance block is produced for real URLs and skipped for blank.
 * [POS]: Phase-2 wiring test. The advisor logic itself is covered by
 *        strategy-advisor.test.ts; this proves the glue feeds it correctly.
 */

import { describe, test, expect } from 'bun:test';
import {
  gatherSignals,
  buildNavGuidance,
  NAV_COMMANDS,
  type SignalDeps,
} from '../src/engine-routing';

function deps(over: Partial<SignalDeps> = {}): SignalDeps {
  return {
    isHostile: () => false,
    isPinned: () => false,
    pinnedVendor: () => null,
    hasRealBrowserSession: () => false,
    rememberedEngine: () => null,
    ...over,
  };
}

describe('engine-routing glue', () => {
  test('NAV_COMMANDS covers the navigation verbs', () => {
    expect(NAV_COMMANDS.has('goto')).toBe(true);
    expect(NAV_COMMANDS.has('reload')).toBe(true);
    expect(NAV_COMMANDS.has('text')).toBe(false);
  });

  test('gatherSignals maps each classifier into the advisor signal shape', () => {
    const s = gatherSignals('https://canvas.uw.edu/x', deps({
      isPinned: () => true,
      pinnedVendor: () => 'cloudflare',
      hasRealBrowserSession: () => true,
    }));
    expect(s.pinned).toBe(true);
    expect(s.vendor).toBe('cloudflare');
    expect(s.realBrowserSession).toBe(true);
    expect(s.hostile).toBe(false);
  });

  test('buildNavGuidance produces the injected block for a real URL', () => {
    const text = buildNavGuidance(
      'https://example.com/x',
      'headless',
      deps({ isPinned: () => true, pinnedVendor: () => 'cloudflare', hasRealBrowserSession: () => true }),
    );
    expect(text).not.toBeNull();
    expect(text!).toContain('engine guidance');
    expect(text!).toContain('real'); // strong recommendation for pinned+session
  });

  test('buildNavGuidance returns null for blank/empty URLs (no noise)', () => {
    expect(buildNavGuidance('about:blank', 'headless', deps())).toBeNull();
    expect(buildNavGuidance('', 'headless', deps())).toBeNull();
  });
});
