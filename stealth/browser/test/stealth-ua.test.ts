/**
 * UA Consistency tests — verify stealth user-agent handling.
 *
 * Integration tests: real browser via BrowserManager + test-server /echo endpoint.
 * Checks that JS navigator.userAgent, HTTP-level User-Agent header, and custom UA
 * all stay in sync and don't leak HeadlessChrome.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startTestServer } from './test-server';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';
import { handleReadCommand } from '../src/read-commands';

let testServer: ReturnType<typeof startTestServer>;
let bm: BrowserManager;
let baseUrl: string;

beforeAll(async () => {
  testServer = startTestServer(0);
  baseUrl = testServer.url;

  bm = new BrowserManager();
  await bm.launch();
});

afterAll(() => {
  try { testServer.server.stop(); } catch {}
  setTimeout(() => process.exit(0), 500);
});

// ─── UA Does Not Leak HeadlessChrome ────────────────────────────

describe('UA stealth', () => {
  test('navigator.userAgent does NOT contain HeadlessChrome', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const jsUA = await page.evaluate(() => navigator.userAgent);
    expect(jsUA).not.toContain('HeadlessChrome');
  }, 15000);

  test('JS UA matches HTTP-level User-Agent header', async () => {
    // Navigate to /echo which returns request headers as JSON
    await handleWriteCommand('goto', [baseUrl + '/echo'], bm);
    const page = bm.getPage();

    // Get the JS-level UA
    const jsUA = await page.evaluate(() => navigator.userAgent);

    // Get the HTTP-level UA from the echo response body
    const bodyText = await page.evaluate(() => document.body.innerText);
    const headers = JSON.parse(bodyText);
    const httpUA = headers['user-agent'];

    expect(httpUA).toBe(jsUA);
  }, 15000);

  test('UA contains a realistic Chrome version (not futuristic)', async () => {
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);
    const page = bm.getPage();
    const jsUA = await page.evaluate(() => navigator.userAgent);

    // Extract Chrome/XXX.Y.Z.W version
    const match = jsUA.match(/Chrome\/(\d+)\./);
    expect(match).not.toBeNull();
    const majorVersion = parseInt(match![1], 10);

    // Chrome version should be within a realistic range
    // Current stable is ~130-140 range. Anything above 145 is suspiciously futuristic.
    expect(majorVersion).toBeGreaterThan(100);
    expect(majorVersion).toBeLessThan(145);
  }, 15000);
});

// ─── setUserAgent Updates Both Levels ───────────────────────────

describe('setUserAgent', () => {
  test('updates both JS and HTTP User-Agent', async () => {
    const customUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 NightCrawlTest/1.0';

    bm.setUserAgent(customUA);

    // Navigate to echo endpoint to check HTTP header
    await handleWriteCommand('goto', [baseUrl + '/echo'], bm);
    const page = bm.getPage();

    const bodyText = await page.evaluate(() => document.body.innerText);
    const headers = JSON.parse(bodyText);
    expect(headers['user-agent']).toBe(customUA);
  }, 15000);
});

// ─── recreateContext Preserves UA Consistency ────────────────────

describe('recreateContext UA', () => {
  test('preserves UA consistency after context recreation', async () => {
    const customUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 RecreateTest/1.0';

    bm.setUserAgent(customUA);
    await handleWriteCommand('goto', [baseUrl + '/basic.html'], bm);

    // Recreate context (saves/restores state)
    await bm.recreateContext();

    // Navigate to echo to check HTTP-level UA
    await handleWriteCommand('goto', [baseUrl + '/echo'], bm);
    const page = bm.getPage();

    const bodyText = await page.evaluate(() => document.body.innerText);
    const headers = JSON.parse(bodyText);
    expect(headers['user-agent']).toBe(customUA);

    // Also check JS-level UA
    const jsUA = await page.evaluate(() => navigator.userAgent);
    expect(jsUA).toBe(customUA);
  }, 30000);
});
