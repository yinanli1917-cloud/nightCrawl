// ─────────────────────────────────────────────────────────────────────────
// Guards for the Phase-4 dual-engine benchmark. Written test-first.
// These encode the user's HARD rules into machine checks:
//   - a re-login prompt while the live session should already be valid = FAIL
//   - an unexpected headed-window pop during a headless run = FAIL
//   - no task counts as "passed" without a VERIFY_OK from `nc verify`
// ─────────────────────────────────────────────────────────────────────────
import { test, expect } from 'bun:test';
import { isReloginPrompt, isHeadedPop, isVerifyOk } from '../lib/guards.mjs';

// ── isReloginPrompt ──────────────────────────────────────────────────────
test('isReloginPrompt flags nightcrawl LOGIN_REQUIRED marker', () => {
  expect(isReloginPrompt('LOGIN_REQUIRED: canvas.uw.edu needs sign-in')).toBe(true);
});
test('isReloginPrompt flags CONSENT_REQUIRED marker', () => {
  expect(isReloginPrompt('CONSENT_REQUIRED: lib.uw.edu (eTLD+1 uw.edu)')).toBe(true);
});
test('isReloginPrompt flags an explicit sign-in wall', () => {
  expect(isReloginPrompt('Please sign in to your UW NetID to continue')).toBe(true);
});
test('isReloginPrompt flags a Duo 2FA wall', () => {
  expect(isReloginPrompt('Duo two-factor authentication required')).toBe(true);
});
test('isReloginPrompt does NOT flag a logged-in dashboard', () => {
  expect(isReloginPrompt('Dashboard\nSigned in as Yinan Li\nCourses')).toBe(false);
});
test('isReloginPrompt does NOT flag a page that merely has a Sign out link', () => {
  expect(isReloginPrompt('Account · Sign out · Settings')).toBe(false);
});

// ── isHeadedPop ──────────────────────────────────────────────────────────
test('isHeadedPop flags launchHeaded in output', () => {
  expect(isHeadedPop('[handoff] launchHeaded -> opening CloakBrowser')).toBe(true);
});
test('isHeadedPop flags open-handoff', () => {
  expect(isHeadedPop('routing to open-handoff for sensitive page')).toBe(true);
});
test('isHeadedPop flags a headed Chromium launch', () => {
  expect(isHeadedPop('headed Chromium launched on display')).toBe(true);
});
test('isHeadedPop is quiet for a normal headless navigation', () => {
  expect(isHeadedPop('Navigated to https://example.com (200)')).toBe(false);
});

// ── isVerifyOk ───────────────────────────────────────────────────────────
test('isVerifyOk true for a VERIFY_OK block', () => {
  expect(isVerifyOk('VERIFY_OK\nkind: publisher-pdf\npages: 12')).toBe(true);
});
test('isVerifyOk false for VERIFY_FAILED', () => {
  expect(isVerifyOk('VERIFY_FAILED\n  ✗ min-pages: 1 < 3')).toBe(false);
});
test('isVerifyOk false for empty/garbage', () => {
  expect(isVerifyOk('')).toBe(false);
  expect(isVerifyOk('some unrelated stdout')).toBe(false);
});
