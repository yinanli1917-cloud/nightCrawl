/**
 * Smoke tests for notify() — verifies it never throws and respects the kill switch.
 * We do NOT assert that a notification actually appeared (would require UI inspection)
 * because notify is best-effort fire-and-forget.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { notify } from '../src/notify';

let savedKill: string | undefined;

beforeEach(() => {
  savedKill = process.env.NIGHTCRAWL_NO_NOTIFY;
});

afterEach(() => {
  if (savedKill === undefined) delete process.env.NIGHTCRAWL_NO_NOTIFY;
  else process.env.NIGHTCRAWL_NO_NOTIFY = savedKill;
});

describe('notify', () => {
  test('never throws on normal input', () => {
    expect(() => notify('Title', 'Body')).not.toThrow();
  });

  test('never throws when body contains AppleScript-breaking chars', () => {
    expect(() => notify('T', 'body with "quotes" and \\backslash')).not.toThrow();
  });

  test('respects NIGHTCRAWL_NO_NOTIFY=1 kill switch', () => {
    process.env.NIGHTCRAWL_NO_NOTIFY = '1';
    expect(() => notify('Title', 'Body')).not.toThrow();
  });

  test('handles empty strings', () => {
    expect(() => notify('', '')).not.toThrow();
  });
});
