import { describe, expect, test } from 'bun:test';
import { shouldRunPostCommandChecks } from '../src/post-command-checks';

describe('post-command checks', () => {
  test('navigation-like commands always run detection checks', () => {
    expect(shouldRunPostCommandChecks('goto', 'https://a.test', 'https://a.test')).toBe(true);
    expect(shouldRunPostCommandChecks('click', 'https://a.test', 'https://a.test')).toBe(true);
  });

  test('read-only js skips detection checks when URL is unchanged', () => {
    expect(shouldRunPostCommandChecks('js', 'https://a.test/page', 'https://a.test/page')).toBe(false);
    expect(shouldRunPostCommandChecks('evaluate', 'https://a.test/page', 'https://a.test/page')).toBe(false);
  });

  test('js still runs detection checks after client-side navigation', () => {
    expect(shouldRunPostCommandChecks('js', 'https://a.test/page', 'https://a.test/login')).toBe(true);
    expect(shouldRunPostCommandChecks('evaluate', 'https://a.test/page', 'https://a.test/login')).toBe(true);
  });

  test('unrelated read commands do not run detection checks', () => {
    expect(shouldRunPostCommandChecks('text', 'https://a.test', 'https://b.test')).toBe(false);
  });
});
