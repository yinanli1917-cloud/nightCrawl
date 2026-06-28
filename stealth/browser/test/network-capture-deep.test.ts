/**
 * [INPUT]: Depends on network-capture-deep.ts (the discovery substrate, pure + a ring).
 * [OUTPUT]: Verifies API-only filtering, secret redaction (headers/body/url), and the
 *           bounded ring. The current network buffer logs only method+url, so the
 *           system cannot SEE the API payload to learn from — this fills that gap safely.
 * [POS]: Skill-library discovery substrate. Captures xhr/fetch bodies+headers REDACTED,
 *        in-memory only; only a verified, secret-stripped SHAPE is ever persisted.
 */

import { describe, test, expect } from 'bun:test';
import {
  isApiRequest,
  redactHeaders,
  redactBody,
  redactUrl,
  DeepNetRing,
  type DeepNetEntry,
} from '../src/network-capture-deep';

describe('network-capture-deep — API-only filter', () => {
  test('captures only xhr/fetch, never documents/media', () => {
    expect(isApiRequest('xhr')).toBe(true);
    expect(isApiRequest('fetch')).toBe(true);
    expect(isApiRequest('document')).toBe(false);
    expect(isApiRequest('image')).toBe(false);
    expect(isApiRequest('stylesheet')).toBe(false);
  });
});

describe('network-capture-deep — redaction (secrets never persist raw)', () => {
  test('headers: mask Authorization / Cookie, keep Content-Type', () => {
    const r = redactHeaders({ authorization: 'Bearer abc', Cookie: 'sid=xyz', 'content-type': 'application/json' });
    expect(r.authorization).toBe('[REDACTED]');
    expect(r.Cookie).toBe('[REDACTED]');
    expect(r['content-type']).toBe('application/json');
  });

  test('body: mask password/token fields and token-shaped values', () => {
    const b = redactBody('{"password":"hunter2","user":"jane","jwt":"eyJhbGc.eyJzdWI.sig"}', 'application/json');
    expect(b).not.toContain('hunter2');
    expect(b).not.toContain('eyJhbGc.eyJzdWI.sig');
    expect(b).toContain('jane'); // non-secret kept
  });

  test('body: mask form-encoded secrets', () => {
    expect(redactBody('user=jane&api_key=sk-livesecret123456789012&x=1')).not.toContain('sk-livesecret123456789012');
  });

  test('url: mask sensitive query params', () => {
    expect(redactUrl('https://x.com/cb?access_token=secret123&q=hello')).not.toContain('secret123');
    expect(redactUrl('https://x.com/cb?access_token=secret123&q=hello')).toContain('q=hello');
  });
});

describe('network-capture-deep — bounded ring', () => {
  test('never exceeds capacity, keeps newest', () => {
    const ring = new DeepNetRing(3);
    const mk = (i: number): DeepNetEntry => ({ timestamp: i, method: 'GET', url: `/u${i}`, resourceType: 'xhr' });
    for (let i = 0; i < 5; i++) ring.push(mk(i));
    const arr = ring.toArray();
    expect(arr.length).toBe(3);
    expect(arr.map((e) => e.url)).toEqual(['/u2', '/u3', '/u4']);
  });
});
