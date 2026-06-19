import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  verifyFile,
  verifyPage,
  formatVerifyFileResult,
  parseVerifyArgs,
} from '../src/deliverable-verify';

describe('deliverable-verify', () => {
  test('verifyPage passes when URL and text match', () => {
    const r = verifyPage(
      'https://canvas.uw.edu/',
      'Dashboard\nCOMMLD 515',
      { urlIncludes: ['canvas.uw.edu'], textIncludes: ['Dashboard'], textExcludes: ['sign in'] },
    );
    expect(r.passed).toBe(true);
  });

  test('verifyFile fails pdf-magic on garbage bytes', () => {
    const f = path.join('/tmp', `nc-verify-fake-${Date.now()}.pdf`);
    fs.writeFileSync(f, 'not a pdf');
    try {
      const r = verifyFile({ filePath: f, kind: 'file-bytes', rejectBrowserPrint: false });
      const magic = r.checks.find(c => c.name === 'pdf-magic');
      expect(magic?.passed).toBe(false);
    } finally {
      fs.unlinkSync(f);
    }
  });

  test('parseVerifyArgs builds file options', () => {
    const p = parseVerifyArgs([
      'file',
      '/tmp/x.pdf',
      '--contains',
      'AI Agent',
      '--min-pages',
      '2',
    ]);
    expect(p.mode).toBe('file');
    expect(p.file?.contains).toEqual(['AI Agent']);
    expect(p.file?.minPages).toBe(2);
  });

  test('formatVerifyFileResult includes VERIFY marker', () => {
    const s = formatVerifyFileResult({
      passed: false,
      kind: 'publisher-pdf',
      filePath: '/tmp/x.pdf',
      checks: [{ name: 'test', passed: false, detail: 'nope' }],
    });
    expect(s).toContain('VERIFY_FAILED');
  });
});
