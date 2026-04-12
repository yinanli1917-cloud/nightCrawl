/**
 * Cookie Import Merge Safety tests
 *
 * Regression test for the "__puus disaster": an agent dumps document.cookie
 * (which silently omits httpOnly cookies), saves it to a JSON file, and
 * re-imports via `cookie-import`. Before the fix, this could leave the user
 * believing the session was preserved when in fact the auth cookie was gone.
 *
 * The fix has two layers:
 *   1. Playwright's addCookies upserts by (name, domain, path), so cookies
 *      not present in the import set are preserved. We assert that here.
 *   2. cookie-import refuses to silently shrink an existing domain's cookie
 *      set when the import is suspiciously partial (httpOnly cookies missing
 *      while non-httpOnly cookies are present), unless --force is passed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { BrowserManager } from '../src/browser-manager';
import { handleWriteCommand } from '../src/write-commands';

let bm: BrowserManager;
let tmpDir: string;

beforeAll(async () => {
  bm = new BrowserManager();
  await bm.launch();
  // Must live under '/tmp' (the literal path the cookie-import safe-dir
  // check accepts on macOS/Linux), not /private/tmp or os.tmpdir().
  tmpDir = fs.mkdtempSync('/tmp/nc-cookie-merge-');
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(0), 500);
});

// ─── Helpers ────────────────────────────────────────────────────

async function seedQuarkLikeSession() {
  const ctx = bm.getPage().context();
  // Clear any leftover state from prior tests
  await ctx.clearCookies();
  await ctx.addCookies([
    {
      name: '__puus',
      value: 'session-token-from-real-login',
      domain: '.example-pan.test',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    {
      name: 'isQuark',
      value: '1',
      domain: 'example-pan.test',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
    {
      name: 'b-user-id',
      value: 'visible-to-js',
      domain: 'example-pan.test',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    },
  ]);
}

function writeJson(name: string, data: unknown): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('cookie-import partial-import safety', () => {
  test('addCookies upserts: an honest partial import preserves cookies not in the set', async () => {
    await seedQuarkLikeSession();

    // A well-formed import that includes at least one httpOnly cookie — this
    // proves the import file came from a real source (Playwright,
    // cookie-import-browser, an Arc dump), not from a document.cookie round-trip.
    const partial = [
      {
        name: 'b-user-id',
        value: 'updated',
        domain: 'example-pan.test',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax' as const,
      },
      {
        name: '__puus',
        value: 'refreshed-token',
        domain: '.example-pan.test',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax' as const,
      },
    ];
    const file = writeJson('partial.json', partial);
    await handleWriteCommand('cookie-import', [file], bm);

    const cookies = await bm.getPage().context().cookies();
    const names = cookies.map((c) => c.name).sort();

    // The crucial assertion: isQuark (httpOnly, not in the import) survived
    // because addCookies upserts by (name, domain, path).
    expect(names).toContain('isQuark');
    // The explicit updates went through.
    expect(cookies.find((c) => c.name === 'b-user-id')?.value).toBe('updated');
    expect(cookies.find((c) => c.name === '__puus')?.value).toBe('refreshed-token');
  });

  test('refuses a document.cookie-style import that drops httpOnly cookies for an existing domain', async () => {
    await seedQuarkLikeSession();

    // Mimic exactly what `nc js "document.cookie"` -> JSON would produce:
    // only the non-httpOnly cookies, no `httpOnly` field at all.
    const jsDump = [
      {
        name: 'b-user-id',
        value: 'visible-to-js',
        domain: 'example-pan.test',
        path: '/',
      },
    ];
    const file = writeJson('js-dump.json', jsDump);

    let threw = false;
    let message = '';
    try {
      await handleWriteCommand('cookie-import', [file], bm);
    } catch (err: any) {
      threw = true;
      message = String(err?.message ?? err);
    }

    expect(threw).toBe(true);
    expect(message.toLowerCase()).toContain('httponly');
    // And the existing __puus must still be present.
    const cookies = await bm.getPage().context().cookies();
    const names = cookies.map((c) => c.name);
    expect(names).toContain('__puus');
  });

  test('--force bypasses the safety check (escape hatch for intentional partial imports)', async () => {
    await seedQuarkLikeSession();

    const jsDump = [
      {
        name: 'b-user-id',
        value: 'forced',
        domain: 'example-pan.test',
        path: '/',
      },
    ];
    const file = writeJson('js-dump-force.json', jsDump);

    // With --force, the import goes through.
    const result = await handleWriteCommand('cookie-import', [file, '--force'], bm);
    expect(result).toMatch(/Loaded 1 cookies/);

    // __puus is still preserved (addCookies upserts), but the user explicitly
    // signed off on the partial import.
    const cookies = await bm.getPage().context().cookies();
    const names = cookies.map((c) => c.name);
    expect(names).toContain('__puus');
    expect(cookies.find((c) => c.name === 'b-user-id')?.value).toBe('forced');
  });

  test('fresh domain (no existing cookies) does not trigger the safety check', async () => {
    const ctx = bm.getPage().context();
    await ctx.clearCookies();

    const fresh = [
      {
        name: 'session_id',
        value: 'abc',
        domain: 'fresh-domain.test',
        path: '/',
      },
    ];
    const file = writeJson('fresh.json', fresh);

    const result = await handleWriteCommand('cookie-import', [file], bm);
    expect(result).toMatch(/Loaded 1 cookies/);
  });
});
