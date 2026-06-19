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
    learnedRecommendation: () => null,
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

  // ── A5: routing learns from the journal, but safety/strong rules still win.
  test('a learned recommendation supersedes the weak cold-start prior', () => {
    const text = buildNavGuidance('https://spa.example/x', 'headless', deps({
      learnedRecommendation: () => ({
        engine: 'real',
        evidence: 'real 6/6 ok ~0.7s · headless 1/5 ok, 4 timeouts',
        confidence: 'learned',
      }),
    }));
    expect(text!).toContain('recommended: real (learned)');
    expect(text!).toContain('evidence: real 6/6 ok');
  });

  test('a weak prior with no history is labeled honestly', () => {
    const text = buildNavGuidance('https://fresh.example/x', 'headless', deps());
    expect(text!).toContain('recommended: headless (prior — no history yet)');
  });

  test('learned does NOT override a strong/safety rule (hostile stays headless)', () => {
    const text = buildNavGuidance('https://hostile.example/x', 'headless', deps({
      isHostile: () => true,
      learnedRecommendation: () => ({ engine: 'real', evidence: 'real 9/9 ok', confidence: 'learned' }),
    }));
    expect(text!).toContain('recommended: headless (strong)');
    expect(text!).not.toContain('evidence:'); // learned layer not consulted
  });
});
