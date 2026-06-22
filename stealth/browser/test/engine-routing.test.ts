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
  resolveAutoEngine,
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

  // A single lucky sample must NOT read as settled knowledge (LOW gap: thin prose).
  test('a THIN learned recommendation says it is tentative, not "overrides the default"', () => {
    const text = buildNavGuidance('https://thin.example/x', 'headless', deps({
      learnedRecommendation: () => ({
        engine: 'real', evidence: 'real 1/1 ok', confidence: 'thin', samples: 1,
      }),
    }));
    expect(text!).toContain('recommended: real (thin)');
    expect(text!.toLowerCase()).toContain('tentative');
    expect(text!).not.toContain('overrides the cold-start default');
  });

  test('a LEARNED recommendation keeps the authoritative "overrides the default" prose', () => {
    const text = buildNavGuidance('https://solid.example/x', 'headless', deps({
      learnedRecommendation: () => ({
        engine: 'real', evidence: 'real 6/6 ok', confidence: 'learned', samples: 6,
      }),
    }));
    expect(text!).toContain('recommended: real (learned)');
    expect(text!).toContain('overrides the cold-start default');
  });

  // Exploration nudge surfaces when the alternative engine has never run here.
  test('an untried alternative engine is surfaced as a comparison nudge', () => {
    const text = buildNavGuidance('https://oneengine.example/x', 'headless', deps({
      learnedRecommendation: () => ({
        engine: 'headless', evidence: 'headless 4/4 ok', confidence: 'learned', samples: 4, untried: 'real',
      }),
    }));
    expect(text!.toLowerCase()).toContain('untried');
    expect(text!).toContain('real');
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

describe('resolveAutoEngine — the advice TAKES EFFECT on auto', () => {
  test('learned (>=3 samples) that real wins -> routes to real', () => {
    const d = deps({ learnedRecommendation: () => ({ engine: 'real', evidence: 'real 5/6 ok', confidence: 'learned' }) });
    expect(resolveAutoEngine('https://canvas.uw.edu/', d).engine).toBe('real');
  });

  test('hostile domain NEVER auto-routes to real, even if learned real (safety)', () => {
    const d = deps({ isHostile: () => true, learnedRecommendation: () => ({ engine: 'real', evidence: 'real 9/9 ok', confidence: 'learned' }) });
    expect(resolveAutoEngine('https://xiaohongshu.com/', d).engine).toBe('headless');
  });

  test('THIN learned (1-2 samples) stays headless — advisory only until confident', () => {
    const d = deps({ learnedRecommendation: () => ({ engine: 'real', evidence: 'real 1/1 ok', confidence: 'thin' }) });
    expect(resolveAutoEngine('https://new.example/', d).engine).toBe('headless');
  });

  test('cold start (no history) stays headless', () => {
    expect(resolveAutoEngine('https://fresh.example/', deps()).engine).toBe('headless');
  });

  test('learned that HEADLESS wins stays headless', () => {
    const d = deps({ learnedRecommendation: () => ({ engine: 'headless', evidence: 'headless 5/5 ok', confidence: 'learned' }) });
    expect(resolveAutoEngine('https://example.com/', d).engine).toBe('headless');
  });

  test('blank url stays headless', () => {
    expect(resolveAutoEngine('about:blank', deps()).engine).toBe('headless');
  });
});
