/**
 * [INPUT]: Depends on bridge-hub.ts (daemon-side command/result correlation).
 * [OUTPUT]: Verifies dispatch→deliver round-trips, offline rejects, timeouts
 *           reject, errors propagate, and detach rejects everything in flight.
 * [POS]: Phase-3B bridge transport test. This is the reliability core: Kimi's
 *        bug was losing in-flight commands on disconnect — here detach/timeout
 *        ALWAYS settle the promise, never hang. Pure logic, no Chrome.
 */

import { describe, test, expect } from 'bun:test';
import { BridgeHub, type BridgeCommand } from '../src/bridge-hub';

describe('BridgeHub', () => {
  test('dispatch rejects when no bridge is attached (offline)', async () => {
    const hub = new BridgeHub();
    expect(hub.isConnected()).toBe(false);
    await expect(hub.dispatch('goto', ['x'])).rejects.toThrow(/offline/i);
  });

  test('attach → dispatch emits a command with an id, deliver resolves it', async () => {
    const hub = new BridgeHub();
    const sent: BridgeCommand[] = [];
    hub.attach((c) => sent.push(c));
    expect(hub.isConnected()).toBe(true);

    const p = hub.dispatch('goto', ['https://x.com']);
    expect(sent).toHaveLength(1);
    expect(sent[0].command).toBe('goto');
    expect(sent[0].id).toBeTruthy();

    hub.deliver(sent[0].id, { ok: true, text: 'hi' });
    await expect(p).resolves.toEqual({ ok: true, text: 'hi' });
  });

  test('deliver with an error rejects the matching promise', async () => {
    const hub = new BridgeHub();
    let id = '';
    hub.attach((c) => { id = c.id; });
    const p = hub.dispatch('click', ['#x']);
    hub.deliver(id, null, 'no element');
    await expect(p).rejects.toThrow(/no element/);
  });

  test('dispatch rejects on timeout (never hangs)', async () => {
    const hub = new BridgeHub();
    hub.attach(() => {});
    await expect(hub.dispatch('goto', ['x'], 40)).rejects.toThrow(/timeout/i);
  });

  test('detach rejects all in-flight commands and goes offline', async () => {
    const hub = new BridgeHub();
    hub.attach(() => {});
    const p = hub.dispatch('goto', ['x'], 5000);
    hub.detach();
    expect(hub.isConnected()).toBe(false);
    await expect(p).rejects.toThrow(/disconnect/i);
  });

  test('a late deliver for an unknown id is ignored (no throw)', () => {
    const hub = new BridgeHub();
    hub.attach(() => {});
    expect(() => hub.deliver('nonexistent', { ok: true })).not.toThrow();
  });

  test('a STALE connection detach does not clobber a newer attach (restart race)', () => {
    const hub = new BridgeHub();
    const sinkA = () => {};
    const sinkB = () => {};
    hub.attach(sinkA);
    hub.attach(sinkB);          // a newer SSE connection supersedes the old one
    hub.detach(sinkA);          // the OLD connection finally aborts
    expect(hub.isConnected()).toBe(true);  // still live via sinkB
    hub.detach(sinkB);          // the live connection aborts
    expect(hub.isConnected()).toBe(false);
  });
});
