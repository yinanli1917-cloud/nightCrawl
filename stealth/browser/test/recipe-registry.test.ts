/**
 * [INPUT]: Depends on recipe-registry.ts (matchRecipe + RECIPES) and site-profile types.
 * [OUTPUT]: Verifies recipe matching fires on real course-player signals and does NOT
 *           fire on a blog that merely mentions the topic (the false-positive guard).
 * [POS]: Pillar 3 test. Pure logic, no Chrome — proves the data-driven classifier that
 *        surfaces the "use the LMS driver, not DOM clicks" recipe.
 */

import { describe, test, expect } from 'bun:test';
import { matchRecipe, formatRecipe, RECIPES } from '../src/recipe-registry';
import type { SiteProfile } from '../src/site-profile';

const prof = (authKind: SiteProfile['authKind'], dynamism: SiteProfile['dynamism'] = 'heavy-spa'): SiteProfile => ({
  vendor: 'none',
  authKind,
  dynamism,
});

describe('matchRecipe', () => {
  test('fires on a Storyline/xAPI course player by its launch URL alone', () => {
    // The real failing case: index_lms.html + tincan endpoint + client=Storyline.
    const r = matchRecipe({
      profile: prof('login-wall'),
      url: 'https://texascourtclasses.com/wp-content/uploads/uncanny-snc/11/index_lms.html?endpoint=https://texascourtclasses.com/ucTinCan/&client=Storyline',
      content: '',
    });
    expect(r?.id).toBe('xapi-course');
    expect(r?.engine).toBe('real');
  });

  test('fires on a content signature WITH an authed profile (no strong URL needed)', () => {
    const r = matchRecipe({
      profile: prof('sso'),
      url: 'https://portal.example.org/training/play',
      content: 'Created using Articulate Storyline 360; scormdriver loaded',
    });
    expect(r?.id).toBe('xapi-course');
  });

  test('does NOT fire on a blog that merely mentions SCORM/xAPI', () => {
    const r = matchRecipe({
      profile: prof('open', 'static'),
      url: 'https://blog.example.com/what-is-scorm-and-xapi',
      content: 'A blog post explaining what SCORM and xAPI are for course authors.',
    });
    expect(r).toBeNull();
  });

  test('does NOT fire on a generic LMS-ish URL with no real signal and no content', () => {
    const r = matchRecipe({
      profile: prof('login-wall'),
      url: 'https://lms.example.com/course/1',
      content: undefined,
    });
    expect(r).toBeNull();
  });

  test('formatRecipe renders an advisory block naming the engine and steps', () => {
    const block = formatRecipe(RECIPES[0]);
    expect(block).toContain('recipe:');
    expect(block).toContain('--engine=real');
    expect(block.toLowerCase()).toContain('xapi');
  });
});
