/**
 * Tests for onboarding route handler
 *
 * Tests the HTTP layer directly — no browser or server needed.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { handleOnboardingRoute } from '../src/onboarding-routes';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = path.join(os.tmpdir(), `nc-onboarding-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpHome, { recursive: true });
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// ─── Helpers ────────────────────────────────────────────────────

function makeReq(method: string, urlPath: string, body?: any): Request {
  const url = `http://127.0.0.1:9400${urlPath}`;
  const opts: RequestInit = { method };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return new Request(url, opts);
}

// ─── Tests ──────────────────────────────────────────────────────

describe('onboarding-routes', () => {
  describe('GET /onboarding', () => {
    test('returns 200 with HTML content-type', async () => {
      const req = makeReq('GET', '/onboarding');
      const res = await handleOnboardingRoute(req);

      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get('Content-Type')).toContain('text/html');
    });

    test('HTML contains privacy messaging', async () => {
      const req = makeReq('GET', '/onboarding');
      const res = await handleOnboardingRoute(req);
      const html = await res!.text();

      expect(html).toContain('never leave your machine');
      expect(html).toContain('nightCrawl');
    });

    test('HTML contains all three mode buttons', async () => {
      const req = makeReq('GET', '/onboarding');
      const res = await handleOnboardingRoute(req);
      const html = await res!.text();

      expect(html).toContain('full');
      expect(html).toContain('ask');
      expect(html).toContain('manual');
    });
  });

  describe('POST /onboarding/choose', () => {
    test('valid mode "full" returns success HTML', async () => {
      const req = makeReq('POST', '/onboarding/choose', { mode: 'full' });
      const res = await handleOnboardingRoute(req);

      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get('Content-Type')).toContain('text/html');
      const html = await res!.text();
      expect(html).toContain('Setup complete');
    });

    test('valid mode "ask" saves config and returns success', async () => {
      const req = makeReq('POST', '/onboarding/choose', { mode: 'ask' });
      const res = await handleOnboardingRoute(req);

      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);

      // Verify config was written
      const cfgPath = path.join(tmpHome, '.nightcrawl', 'state', 'config.yaml');
      const content = fs.readFileSync(cfgPath, 'utf-8');
      expect(content).toContain('cookie_mode: ask');
    });

    test('valid mode "manual" saves config', async () => {
      const req = makeReq('POST', '/onboarding/choose', { mode: 'manual' });
      await handleOnboardingRoute(req);

      const cfgPath = path.join(tmpHome, '.nightcrawl', 'state', 'config.yaml');
      const content = fs.readFileSync(cfgPath, 'utf-8');
      expect(content).toContain('cookie_mode: manual');
    });

    test('invalid mode returns 400', async () => {
      const req = makeReq('POST', '/onboarding/choose', { mode: 'yolo' });
      const res = await handleOnboardingRoute(req);

      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });

    test('missing mode returns 400', async () => {
      const req = makeReq('POST', '/onboarding/choose', {});
      const res = await handleOnboardingRoute(req);

      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });

    test('invalid JSON body returns 400', async () => {
      const req = new Request('http://127.0.0.1:9400/onboarding/choose', {
        method: 'POST',
        body: 'not-json',
        headers: { 'Content-Type': 'application/json' },
      });
      const res = await handleOnboardingRoute(req);

      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
    });
  });

  describe('non-matching routes', () => {
    test('returns null for unrelated path', async () => {
      const req = makeReq('GET', '/command');
      const res = await handleOnboardingRoute(req);
      expect(res).toBeNull();
    });

    test('returns null for /health', async () => {
      const req = makeReq('GET', '/health');
      const res = await handleOnboardingRoute(req);
      expect(res).toBeNull();
    });

    test('returns null for /cookie-picker', async () => {
      const req = makeReq('GET', '/cookie-picker');
      const res = await handleOnboardingRoute(req);
      expect(res).toBeNull();
    });
  });
});
