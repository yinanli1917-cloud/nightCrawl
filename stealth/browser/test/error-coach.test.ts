/**
 * [INPUT]: Depends on error-coach.ts (COACH_RULES, coachHint, EMPTY_JS_HINT).
 * [OUTPUT]: Verifies that a tool error maps to a one-line next-move hint keyed on error
 *           CLASS (never a site), so a weak model self-corrects instead of looping.
 * [POS]: The in-band self-teaching channel — a stateless weak model won't read the
 *        SKILL.md, but it reacts to a hint in the immediate observation.
 */

import { describe, test, expect } from 'bun:test';
import { COACH_RULES, coachHint, EMPTY_JS_HINT } from '../src/error-coach';

describe('coachHint — one hint per error class', () => {
  test('ReferenceError → "runs in the page" guidance', () => {
    const h = coachHint('ReferenceError: require is not defined');
    expect(h).toMatch(/page|document|find|table/i);
  });

  test('SyntaxError → single-expression / return-a-value guidance', () => {
    expect(coachHint('SyntaxError: Unexpected token const')).toMatch(/expression|return/i);
  });

  test('selector miss → snapshot/find guidance', () => {
    expect(coachHint('Error: locator.click: Timeout 30000ms exceeded waiting for locator')).toMatch(/snapshot|find/i);
    expect(coachHint('Element not found: #missing')).toMatch(/snapshot|find/i);
  });

  test('context destroyed / navigation → wait --load guidance', () => {
    expect(coachHint('Execution context was destroyed, most likely because of a navigation')).toMatch(/navigat|wait/i);
  });

  test('js timeout → settle / narrow guidance', () => {
    expect(coachHint('js timed out after 30000ms')).toMatch(/wait|settle|narrow|fetch/i);
  });

  test('unknown error → null (no noise)', () => {
    expect(coachHint('some entirely novel failure with no known class')).toBeNull();
  });

  test('about:blank page → blank-page guidance even when the message is unmatched', () => {
    const h = coachHint('weird', { url: 'about:blank' });
    expect(h).toMatch(/blank|goto/i);
  });

  test('a matched message wins over the blank-url fallback', () => {
    const h = coachHint('ReferenceError: x is not defined', { url: 'about:blank' });
    expect(h).toMatch(/page|document/i);
  });

  test('every rule is keyed on an error class, never a hostname', () => {
    for (const r of COACH_RULES) {
      expect(r.hint.length).toBeGreaterThan(0);
      // a hint must not hardcode a site
      expect(r.hint).not.toMatch(/https?:\/\/|\.com|\.gov|\.org/);
    }
  });

  test('EMPTY_JS_HINT teaches the return-a-value fix', () => {
    expect(EMPTY_JS_HINT).toMatch(/return/);
  });
});
