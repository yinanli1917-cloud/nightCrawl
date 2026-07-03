/**
 * [INPUT]: Depends on read-commands.ts (wrapForEvaluate + handleReadCommand).
 * [OUTPUT]: Verifies robust async-evaluate (always wrap+return, so .then() chains
 *           resolve) and the wait-for predicate primitive.
 * [POS]: Pillar 2 test. Pure-ish — fakes the Playwright target so no Chrome runs.
 *        Encodes the fix for the Cursor-course "nc js returned empty / async timed out".
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { wrapForEvaluate, handleReadCommand, resolveEvalCode } from '../src/read-commands';

// Minimal fake TabView — read commands only call getPage/getActiveFrameOrPage here.
const fakeBm = (target: any): any => ({
  getPage: () => target,
  getActiveFrameOrPage: () => target,
});

describe('wrapForEvaluate (robust async eval)', () => {
  test('returns a bare expression from an async IIFE', () => {
    const w = wrapForEvaluate('1+1');
    expect(w.startsWith('(async')).toBe(true);
    expect(w).toContain('return (1+1)');
  });

  test('wraps + returns a .then() chain that has NO await keyword (the bug)', () => {
    // Was returned UNWRAPPED → value dropped → empty. Now it resolves.
    const w = wrapForEvaluate('fetch(u).then(r=>r.status)');
    expect(w).toContain('return (fetch(u).then(r=>r.status))');
  });

  test('wraps an await expression', () => {
    expect(wrapForEvaluate('await foo()')).toContain('return (await foo())');
  });

  test('leaves a multi-statement block body intact (author owns its return)', () => {
    const w = wrapForEvaluate('const x=1; return x');
    expect(w).toContain('const x=1; return x');
    expect(w).not.toContain('return (const');
  });
});

describe('wait-for', () => {
  test('forwards the predicate + timeout to waitForFunction', async () => {
    const calls: any[] = [];
    const target = {
      waitForFunction: (p: any, _arg: any, opts: any) => { calls.push([p, opts]); return Promise.resolve(true); },
    };
    const out = await handleReadCommand('wait-for', ['document.readyState==="complete"', '5000'], fakeBm(target));
    expect(calls[0][0]).toBe('document.readyState==="complete"');
    expect(calls[0][1].timeout).toBe(5000);
    expect(out).toContain('document.readyState');
  });

  test('defaults the timeout when omitted', async () => {
    const calls: any[] = [];
    const target = { waitForFunction: (p: any, _a: any, o: any) => { calls.push(o); return Promise.resolve(true); } };
    await handleReadCommand('wait-for', ['true'], fakeBm(target));
    expect(calls[0].timeout).toBeGreaterThan(0);
  });

  test('throws a usage error without a predicate', async () => {
    const target = { waitForFunction: () => Promise.resolve(true) };
    await expect(handleReadCommand('wait-for', [], fakeBm(target))).rejects.toThrow(/Usage/);
  });
});

describe('resolveEvalCode — file-or-inline, engine-consistent', () => {
  test('a short inline expression is run inline, not treated as a file', () => {
    expect(resolveEvalCode('location.hostname+location.pathname')).toEqual({
      code: 'location.hostname+location.pathname', fromFile: false,
    });
  });

  test('long inline code does not throw (ENAMETOOLONG) and is inline', () => {
    const long = "fetch('/api/x').then(r=>r.json())" + '/*'.padEnd(5000, 'x') + '*/';
    const r = resolveEvalCode(long);
    expect(r.fromFile).toBe(false);
    expect(r.code).toBe(long);
  });

  test('a non-existent path is inline, not a "File not found" error', () => {
    expect(resolveEvalCode('/no/such/file/here.js').fromFile).toBe(false);
  });

  test('a real, existing file is read as its contents', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-eval-'));
    const f = path.join(dir, 'snippet.js');
    fs.writeFileSync(f, 'return 40 + 2;');
    expect(resolveEvalCode(f)).toEqual({ code: 'return 40 + 2;', fromFile: true });
  });
});

describe('eval handler — inline code runs, never "File not found"', () => {
  test('the exact command that triggered the reset now runs inline', async () => {
    const seen: string[] = [];
    const target = { evaluate: (code: string) => { seen.push(code); return Promise.resolve('canvas.uw.edu/'); } };
    const out = await handleReadCommand('eval', ['location.hostname+location.pathname'], fakeBm(target));
    expect(out).toBe('canvas.uw.edu/');
    expect(seen[0]).toContain('location.hostname+location.pathname'); // ran inline, not read as a file
  });
});
