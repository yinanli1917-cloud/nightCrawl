/**
 * [INPUT]: Depends on bridge-protocol.ts (native-messaging stdio framing).
 * [OUTPUT]: Verifies 4-byte little-endian length framing round-trips and the
 *           streaming decoder handles split/coalesced/byte-by-byte arrivals.
 * [POS]: Phase-3B bridge foundation test. Native messaging frames every message
 *        as [uint32 LE length][UTF-8 JSON]; a framing bug here corrupts the whole
 *        daemon↔Chrome channel, so this is the first thing to get right.
 */

import { describe, test, expect } from 'bun:test';
import { encodeMessage, FrameDecoder } from '../src/bridge-protocol';

describe('bridge-protocol native-messaging framing', () => {
  test('encode then decode round-trips an object', () => {
    const dec = new FrameDecoder();
    const out = dec.push(encodeMessage({ command: 'goto', args: ['https://x.com'] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ command: 'goto', args: ['https://x.com'] });
  });

  test('header is 4-byte little-endian payload length', () => {
    const frame = encodeMessage({ a: 1 });
    const payload = JSON.stringify({ a: 1 });
    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(payload, 'utf-8'));
    expect(frame.length).toBe(4 + Buffer.byteLength(payload, 'utf-8'));
  });

  test('two messages coalesced in one chunk both decode', () => {
    const dec = new FrameDecoder();
    const chunk = Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2 })]);
    const out = dec.push(chunk);
    expect(out.map((m) => m.n)).toEqual([1, 2]);
  });

  test('a message split across two chunks decodes once complete', () => {
    const dec = new FrameDecoder();
    const frame = encodeMessage({ hello: 'world' });
    const first = dec.push(frame.subarray(0, 6));   // header + a few bytes
    expect(first).toHaveLength(0);                   // incomplete → nothing yet
    const second = dec.push(frame.subarray(6));
    expect(second).toEqual([{ hello: 'world' }]);
  });

  test('byte-by-byte arrival still decodes exactly one message', () => {
    const dec = new FrameDecoder();
    const frame = encodeMessage({ k: 'v', big: 'x'.repeat(300) });
    let emitted: any[] = [];
    for (const byte of frame) emitted = emitted.concat(dec.push(Buffer.from([byte])));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].big.length).toBe(300);
  });

  test('multi-byte UTF-8 payloads frame by byte length, not char count', () => {
    const dec = new FrameDecoder();
    const msg = { t: '日本語テスト' };
    const out = dec.push(encodeMessage(msg));
    expect(out[0]).toEqual(msg);
  });
});
