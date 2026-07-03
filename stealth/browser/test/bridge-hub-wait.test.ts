/**
 * [INPUT]: Depends on bridge-hub.ts (BridgeHub.waitForConnected).
 * [OUTPUT]: Proves an explicit --engine=real can ride out a reconnect gap: waitForConnected
 *           resolves true once the bridge attaches within the window, false otherwise.
 * [POS]: Track-B resilience. Stops a daemon restart from silently stranding a live
 *        Engine R session (falling back to headless with a misleading success).
 */

import { describe, test, expect } from 'bun:test';
import { BridgeHub } from '../src/bridge-hub';

describe('BridgeHub.waitForConnected', () => {
  test('returns true immediately when already connected', async () => {
    const hub = new BridgeHub();
    hub.attach(() => {});
    expect(await hub.waitForConnected(1000)).toBe(true);
  });

  test('returns true once the bridge attaches within the window', async () => {
    const hub = new BridgeHub();
    setTimeout(() => hub.attach(() => {}), 120);
    expect(await hub.waitForConnected(2000)).toBe(true);
  });

  test('returns false if the bridge never attaches', async () => {
    const hub = new BridgeHub();
    expect(await hub.waitForConnected(300)).toBe(false);
  });
});
