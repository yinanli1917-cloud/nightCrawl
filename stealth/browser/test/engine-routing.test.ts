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
  resolveAction,
  NAV_COMMANDS,
  type SignalDeps,
  type ActionDeps,
} from '../src/engine-routing';
import type { ResolveResult } from '../src/self-tune';
import type { SiteProfile } from '../src/site-profile';

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

  // ── Pillar 3: a SCORM/xAPI course-player URL surfaces the completion recipe.
  test('buildNavGuidance appends the xAPI-course recipe for a course-player URL', () => {
    const text = buildNavGuidance(
      'https://x.com/wp-content/uploads/uncanny-snc/11/index_lms.html?client=Storyline',
      'headless',
      deps(),
    );
    expect(text!).toContain('recipe:');
    expect(text!).toContain('--engine=real');
  });

  test('buildNavGuidance omits the recipe for an ordinary page', () => {
    const text = buildNavGuidance('https://example.com/article', 'headless', deps());
    expect(text!).not.toContain('recipe:');
  });

  test('BROWSE_DISABLE_RECIPES=1 omits the recipe even for a course-player URL', () => {
    const prev = process.env.BROWSE_DISABLE_RECIPES;
    process.env.BROWSE_DISABLE_RECIPES = '1';
    try {
      const text = buildNavGuidance(
        'https://x.com/wp-content/uploads/uncanny-snc/11/index_lms.html?client=Storyline',
        'headless',
        deps(),
      );
      expect(text ?? '').not.toContain('recipe:');
    } finally {
      if (prev === undefined) delete process.env.BROWSE_DISABLE_RECIPES;
      else process.env.BROWSE_DISABLE_RECIPES = prev;
    }
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

describe('resolveAction — conservative-auto boundary + knobs', () => {
  const OPEN: SiteProfile = { vendor: 'none', authKind: 'open', dynamism: 'static' };
  function res(over: Partial<ResolveResult> = {}): ResolveResult {
    return { recommendation: null, source: 'cold-start', profile: OPEN, winner: null, ...over };
  }
  const learnedReal = (source: ResolveResult['source']): ResolveResult =>
    res({ recommendation: { engine: 'real', evidence: 'real 5/5 ok', confidence: 'learned', samples: 5 }, source });
  function actionDeps(over: Partial<ActionDeps> = {}): ActionDeps {
    return { isHostile: () => false, resolve: () => res(), ...over };
  }

  test('a DOMAIN-learned real recommendation auto-switches the engine to real', () => {
    const a = resolveAction('https://canvas.uw.edu/', false, actionDeps({ resolve: () => learnedReal('domain') }));
    expect(a.engine).toBe('real');
    expect(a.policyViolated).toBe(false);
  });

  test('a SITE-TYPE real recommendation does NOT auto-switch (stays headless, advises)', () => {
    const a = resolveAction('https://never-seen.com/', false, actionDeps({ resolve: () => learnedReal('site-type') }));
    expect(a.engine).toBe('headless'); // generalized evidence informs, never flips the live browser
    expect(a.source).toBe('site-type');
  });

  test('a hostile domain forces headless and flags the overridden real recommendation', () => {
    const a = resolveAction('https://xiaohongshu.com/', false, actionDeps({
      isHostile: () => true,
      resolve: () => learnedReal('domain'),
    }));
    expect(a.engine).toBe('headless');
    expect(a.policyViolated).toBe(true); // a real recommendation on a hostile domain is unsafe
  });

  test('a file-upload task forces headless even with a domain-learned real recommendation', () => {
    const a = resolveAction('https://example.com/', true, actionDeps({ resolve: () => learnedReal('domain') }));
    expect(a.engine).toBe('headless');
  });

  test('cold start stays headless', () => {
    expect(resolveAction('https://fresh.com/', false, actionDeps()).engine).toBe('headless');
  });

  test('always returns clamped tuning knobs alongside the engine', () => {
    const a = resolveAction('https://example.com/', false, actionDeps());
    expect(typeof a.tune.timeoutBudgetMs).toBe('number');
    expect(a.tune.timeoutBudgetMs).toBeGreaterThanOrEqual(10000);
    expect(a.tune.viewport.width).toBeGreaterThan(0);
  });
});
