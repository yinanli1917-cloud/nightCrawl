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
  sampleResponse,
  looksLikeData,
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

describe('network-capture-deep — looksLikeData (JSONP / JSON vs code)', () => {
  test('JSONP callback wrapper is data', () => {
    expect(looksLikeData('jsonp_12345({"data":[1,2,3]})')).toBe(true);
    expect(looksLikeData('cb( [ {"year":2006} ] )')).toBe(true);
  });
  test('JSONP behind anti-hijacking /**/ armor is data (GitHub-style)', () => {
    expect(looksLikeData('/**/cb({"login":"torvalds"})', 'application/javascript')).toBe(true);
  });
  test('bare JSON object/array is data', () => {
    expect(looksLikeData('[{"a":1},{"b":2}]')).toBe(true);
    expect(looksLikeData('{"series":[1,2]}')).toBe(true);
  });
  test('a JS bundle is NOT data (starts with code, not a value)', () => {
    expect(looksLikeData('!function(e){var t=1}(window)')).toBe(false);
    expect(looksLikeData('(function(){console.log(1)})()')).toBe(false);
    expect(looksLikeData('var app = new Vue({})')).toBe(false);
  });
  test('json/csv content-type short-circuits to data', () => {
    expect(looksLikeData('anything at all', 'text/csv')).toBe(true);
  });
  test('empty is not data', () => {
    expect(looksLikeData('')).toBe(false);
  });
});

describe('network-capture-deep — sampleResponse for script/JSONP', () => {
  const res = (headers: Record<string, string>, body?: string) => ({
    headers: () => headers, text: async () => body ?? '',
  });
  test('a script response carrying JSONP data IS sampled', async () => {
    const r = await sampleResponse(res({ 'content-type': 'application/javascript' }, 'cb({"gdp":[2006,2007]})'), 'script');
    expect(r.bodySample).toContain('gdp');
  });
  test('a script response that is real code is NOT sampled', async () => {
    const r = await sampleResponse(res({ 'content-type': 'application/javascript' }, '!function(){}()'), 'script');
    expect(r.bodySample).toBeUndefined();
  });
  test('a fetch response is unaffected by the script gate (JSON body still sampled)', async () => {
    const r = await sampleResponse(res({ 'content-type': 'application/json' }, '[{"a":1}]'), 'fetch');
    expect(r.bodySample).toBe('[{"a":1}]');
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

describe('network-capture-deep — sampleResponse', () => {
  const res = (headers: Record<string, string>, body?: string) => ({
    headers: () => headers,
    text: async () => body ?? '',
  });

  test('captures content-type and a JSON body sample', async () => {
    const r = await sampleResponse(res({ 'content-type': 'application/json' }, '[{"a":1}]'));
    expect(r.contentType).toBe('application/json');
    expect(r.bodySample).toBe('[{"a":1}]');
  });

  test('skips the body for non-data content types (keeps content-type)', async () => {
    const r = await sampleResponse(res({ 'content-type': 'text/html' }, '<html>...'));
    expect(r.contentType).toBe('text/html');
    expect(r.bodySample).toBeUndefined();
  });

  test('skips the body when content-length exceeds the cap', async () => {
    const r = await sampleResponse(res({ 'content-type': 'application/json', 'content-length': '9999999' }, '[]'));
    expect(r.bodySample).toBeUndefined();
  });

  test('redacts secrets in the sampled body', async () => {
    const r = await sampleResponse(res({ 'content-type': 'application/json' }, '{"token":"sk-livesecret123456789012"}'));
    expect(r.bodySample).not.toContain('sk-livesecret123456789012');
  });

  test('never throws on a null/odd response', async () => {
    expect(await sampleResponse(null)).toEqual({});
    expect(await sampleResponse({})).toEqual({});
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
