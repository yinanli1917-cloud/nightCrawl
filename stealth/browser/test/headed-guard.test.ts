/**
 * [INPUT]: assertHeadedAllowed from cloakbrowser-engine.ts.
 * [OUTPUT]: Verifies the test-mode choke point: when NIGHTCRAWL_BLOCK_HEADED=1,
 *           any HEADED CloakBrowser launch (headless:false) is refused, so a
 *           verification/test run can never pop a visible browser window.
 * [POS]: Guardrail test. All visible-window paths (launchHeaded/handoff/
 *        autoHandover) funnel through launchCloakBrowser with headless:false;
 *        this guard is the single chokepoint that blocks them in test mode.
 */

import { describe, test, expect } from 'bun:test';
import { assertHeadedAllowed } from '../src/cloakbrowser-engine';

describe('assertHeadedAllowed (no-window test-mode choke point)', () => {
  test('blocks a HEADED launch when NIGHTCRAWL_BLOCK_HEADED=1', () => {
    expect(() => assertHeadedAllowed(false, { NIGHTCRAWL_BLOCK_HEADED: '1' }))
      .toThrow(/blocked|NIGHTCRAWL_BLOCK_HEADED/);
  });

  test('allows a HEADLESS launch even when the flag is set (headless is windowless)', () => {
    expect(() => assertHeadedAllowed(true, { NIGHTCRAWL_BLOCK_HEADED: '1' })).not.toThrow();
    // undefined headless defaults to headless:true downstream → not a headed launch.
    expect(() => assertHeadedAllowed(undefined, { NIGHTCRAWL_BLOCK_HEADED: '1' })).not.toThrow();
  });

  test('allows a HEADED launch when the flag is NOT set (normal handoff still works)', () => {
    expect(() => assertHeadedAllowed(false, {})).not.toThrow();
    expect(() => assertHeadedAllowed(false, { NIGHTCRAWL_BLOCK_HEADED: '0' })).not.toThrow();
  });
});
