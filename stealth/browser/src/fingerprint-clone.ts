/**
 * [INPUT]: Depends on config.resolveConfig (stateDir) and the CloakBrowser launch
 *          option shape. Capture probes a live page; apply is pure.
 * [OUTPUT]: Exports DeviceAnchor, anchorFilePath, save/load/captureDeviceAnchor,
 *           applyAnchor.
 * [POS]: Phase-3 Engine-H "fingerprint anchor" (Tier 1). Aligns the headless
 *        twin's SOFT fingerprint (UA, screen, timezone, locale) to the user's
 *        real device so cookies/anti-bot checks that key on those signals don't
 *        re-challenge.
 *
 * HONEST SCOPE: CloakBrowser derives canvas/WebGL/GPU/audio from a single integer
 * seed and exposes NO per-dimension injection API — so this CANNOT clone those
 * hardware hashes. We deliberately KEEP the persistent seed (so headless↔headed
 * fingerprint continuity, the load-bearing premise, is preserved) and only align
 * the independent launch options. Full canvas/WebGL parity is a CloakBrowser-
 * binary research item, not something this module can promise.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveConfig } from './config';
import type { CloakBrowserLaunchOptions } from './cloakbrowser-engine';

export interface DeviceAnchor {
  userAgent: string;
  screen: { width: number; height: number; deviceScaleFactor: number };
  platform: string;
  timezone: string;
  languages: string[];
  capturedAt: number;
}

export function anchorFilePath(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveConfig(env).stateDir, 'device-anchor.json');
}

export function saveDeviceAnchor(anchor: DeviceAnchor): void {
  try {
    const dest = anchorFilePath();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(anchor, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch {}
}

export function loadDeviceAnchor(): DeviceAnchor | null {
  try {
    const a = JSON.parse(fs.readFileSync(anchorFilePath(), 'utf-8'));
    if (a && typeof a.userAgent === 'string' && a.screen && a.timezone) return a;
  } catch {}
  return null;
}

/**
 * Probe a live page for the device's soft fingerprint and persist it. Best used
 * on a real-browser (Engine R) page or a headed session — wherever the page is
 * presenting the user's actual device. Returns null (never throws) on failure.
 */
export async function captureDeviceAnchor(page: any): Promise<DeviceAnchor | null> {
  try {
    const probe = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      width: (globalThis as any).screen?.width ?? 0,
      height: (globalThis as any).screen?.height ?? 0,
      dpr: (globalThis as any).devicePixelRatio ?? 1,
      platform: navigator.platform,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      languages: Array.from((navigator as any).languages || []),
    }));
    const anchor: DeviceAnchor = {
      userAgent: probe.userAgent,
      screen: { width: probe.width, height: probe.height, deviceScaleFactor: probe.dpr },
      platform: probe.platform,
      timezone: probe.timezone,
      languages: probe.languages as string[],
      capturedAt: Date.now(),
    };
    if (!anchor.userAgent || !anchor.timezone) return null;
    saveDeviceAnchor(anchor);
    return anchor;
  } catch {
    return null;
  }
}

/**
 * Merge the anchor's soft signals into launch options. The persistent
 * fingerprintSeed is left untouched (continuity), and any explicit caller value
 * (userAgent/viewport/locale/timezone) wins over the anchor.
 */
export function applyAnchor(
  opts: CloakBrowserLaunchOptions,
  anchor: DeviceAnchor | null,
): CloakBrowserLaunchOptions {
  if (!anchor) return opts;
  return {
    ...opts,
    userAgent: opts.userAgent ?? anchor.userAgent,
    viewport: opts.viewport ?? { width: anchor.screen.width, height: anchor.screen.height },
    locale: opts.locale ?? anchor.languages[0],
    timezone: opts.timezone ?? anchor.timezone,
  };
}
