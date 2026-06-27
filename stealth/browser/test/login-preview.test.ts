/**
 * [INPUT]: Depends on login-preview.ts (pure auto-preview decision).
 * [OUTPUT]: Verifies WHEN nightCrawl may auto-fire a login PREVIEW (fill, never
 *           submit) at a consented wall, and that it never loops or acts unconsented.
 * [POS]: Track B P0-4. The real session dead-ended at "LOGIN_REQUIRED: google.com ...
 *        Headed handover disabled" on an ALREADY-consented domain because wall
 *        detection and autofill-login never met. This is the pure decision that chains
 *        them: a consented + bridge-bound wall auto-previews; everything else is
 *        reported, never auto-submitted. The submit/preview restructuring of
 *        autofill-login.ts is integration.
 */

import { describe, test, expect } from 'bun:test';
import { decideLoginPreview, type LoginPreviewSignals } from '../src/login-preview';

const sig = (over: Partial<LoginPreviewSignals> = {}): LoginPreviewSignals => ({
  wallDetected: true,
  domainApproved: true,
  bridgeBound: true,
  alreadyPreviewed: false,
  ...over,
});

describe('login-preview — consent-gated, preview-only auto-fill', () => {
  test('a consented + bridge-bound wall auto-previews (fixes the dead-end)', () => {
    expect(decideLoginPreview(sig())).toBe('preview');
  });

  test('a wall on an UNCONSENTED domain is skipped (report, never silent-act)', () => {
    expect(decideLoginPreview(sig({ domainApproved: false }))).toBe('skip');
  });

  test('no bound Engine-R tab → skip (cannot drive the real browser)', () => {
    expect(decideLoginPreview(sig({ bridgeBound: false }))).toBe('skip');
  });

  test('no wall present → skip', () => {
    expect(decideLoginPreview(sig({ wallDetected: false }))).toBe('skip');
  });

  test('already previewed this visit → skip (never loop the fill)', () => {
    expect(decideLoginPreview(sig({ alreadyPreviewed: true }))).toBe('skip');
  });

  test('the decision is only ever preview or skip — never an auto-submit', () => {
    const all: LoginPreviewSignals[] = [sig(), sig({ domainApproved: false }), sig({ wallDetected: false })];
    for (const s of all) expect(['preview', 'skip']).toContain(decideLoginPreview(s));
  });
});
