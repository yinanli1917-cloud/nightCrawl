/**
 * [INPUT]: Depends on bridge-commands.ts (nightcrawl command → CDP call mapping).
 * [OUTPUT]: Verifies each supported command maps to the right CDP method/params,
 *           selectors/values are safely embedded, and unknown commands throw.
 * [POS]: Phase-3B bridge foundation test. The daemon builds these CDP calls; the
 *        extension executes them via chrome.debugger.sendCommand. Pure logic.
 */

import { describe, test, expect } from 'bun:test';
import { toCdp, isBridgeCommand } from '../src/bridge-commands';

describe('bridge-commands → CDP mapping', () => {
  test('goto maps to Page.navigate with the url', () => {
    expect(toCdp('goto', ['https://example.com'])).toEqual({
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    });
  });

  test('text maps to Runtime.evaluate of innerText, by value', () => {
    const c = toCdp('text', []);
    expect(c.method).toBe('Runtime.evaluate');
    expect(c.params.expression).toContain('innerText');
    expect(c.params.returnByValue).toBe(true);
  });

  test('screenshot maps to Page.captureScreenshot (png)', () => {
    expect(toCdp('screenshot', [])).toEqual({
      method: 'Page.captureScreenshot',
      params: { format: 'png' },
    });
  });

  test('js/eval pass the expression straight to Runtime.evaluate', () => {
    expect(toCdp('js', ['1+1']).params.expression).toBe('1+1');
    expect(toCdp('eval', ['foo()']).params.expression).toBe('foo()');
  });

  test('click embeds the selector safely (JSON-encoded, no raw interpolation)', () => {
    const c = toCdp('click', ['#btn']);
    expect(c.method).toBe('Runtime.evaluate');
    expect(c.params.expression).toContain('"#btn"');     // JSON.stringify'd selector
    expect(c.params.expression.toLowerCase()).toContain('click');
  });

  test('fill embeds selector and value safely', () => {
    const c = toCdp('fill', ['#email', 'a@b.co']);
    expect(c.params.expression).toContain('"#email"');
    expect(c.params.expression).toContain('"a@b.co"');
  });

  test('a value containing quotes cannot break out of the expression', () => {
    const c = toCdp('fill', ['#x', '"); alert(1); ("']);
    // The dangerous value must be JSON-encoded, not raw-interpolated.
    expect(c.params.expression).toContain(JSON.stringify('"); alert(1); ("'));
  });

  test('isBridgeCommand reflects the supported relay surface', () => {
    expect(isBridgeCommand('goto')).toBe(true);
    expect(isBridgeCommand('snapshot')).toBe(true);
    expect(isBridgeCommand('upload')).toBe(false); // upload stays on headless
  });

  test('unknown commands throw (not silently mis-mapped)', () => {
    expect(() => toCdp('frobnicate', [])).toThrow();
  });
});
