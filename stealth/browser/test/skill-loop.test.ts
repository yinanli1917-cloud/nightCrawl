/**
 * [INPUT]: Depends on skill-loop.ts (closeLoop) + skill-store-ops.ts (ownership).
 * [OUTPUT]: Verifies the flywheel — on VERIFY_OK discover+record a method; on failure
 *           record the miss — and the user-ownership surface (inspect/export/forget).
 * [POS]: Skill-library loop closure + control. The agent's own outcomes determine what
 *        enters the library (self-improving, no annotation); the user fully owns it.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-skillloop-'));
process.env.BROWSE_STATE_FILE = path.join(TMP, 'state', 'browse.json');
fs.mkdirSync(path.dirname(process.env.BROWSE_STATE_FILE), { recursive: true });

import { closeLoop, type SkillOutcomeInput } from '../src/skill-loop';
import { listSkills, exportSkills, forgetSkills } from '../src/skill-store-ops';
import { readSkills, skillJournalPath } from '../src/skill-journal';
import type { DeepNetEntry } from '../src/network-capture-deep';
import type { SiteProfile } from '../src/site-profile';

const OPEN: SiteProfile = { vendor: 'none', authKind: 'open', dynamism: 'static' };
const T = 1_000_000;
const clear = () => { try { fs.unlinkSync(skillJournalPath()); } catch {} };
function input(over: Partial<SkillOutcomeInput> = {}): SkillOutcomeInput {
  return { goalType: 'extract-data', url: 'https://a.com/x', domain: 'a.com', profile: OPEN, verifyText: '', metrics: { verifyOkRate: 1 }, entries: [], now: T, ...over };
}
const net = (over: Partial<DeepNetEntry>): DeepNetEntry =>
  ({ timestamp: T - 1000, method: 'GET', url: 'https://a.com/api/search?q=hi', resourceType: 'xhr', status: 200, ...over });

describe('skill-loop — closeLoop (the flywheel)', () => {
  beforeEach(clear);
  test('VERIFY_OK with a correlated API call records a backend-api skill', () => {
    const r = closeLoop(input({ verifyText: 'VERIFY_OK\npages:1', entries: [net({})] }));
    expect(r!.method).toBe('backend-api');
    expect(r!.ok).toBe(true);
    expect(readSkills().length).toBe(1);
  });
  test('VERIFY_OK with no API call records a dom skill (success still happened)', () => {
    const r = closeLoop(input({ verifyText: 'VERIFY_OK', entries: [] }));
    expect(r!.method).toBe('dom');
    expect(r!.ok).toBe(true);
  });
  test('a non-success (no VERIFY_OK) records the miss', () => {
    const r = closeLoop(input({ verifyText: 'VERIFY_FAILED', entries: [] }));
    expect(r!.ok).toBe(false);
    expect(readSkills().length).toBe(1);
  });
  test('BROWSE_DISABLE_FLYWHEEL=1 makes closeLoop a no-op (records nothing)', () => {
    const r = closeLoop(
      input({ verifyText: 'VERIFY_OK', entries: [net({})] }),
      { ...process.env, BROWSE_DISABLE_FLYWHEEL: '1' },
    );
    expect(r).toBeNull();
    expect(readSkills().length).toBe(0);
  });
});

describe('skill-store-ops — the user owns the library', () => {
  beforeEach(() => {
    clear();
    closeLoop(input({ domain: 'a.com', verifyText: 'VERIFY_OK', entries: [net({ url: 'https://a.com/api/x' })] }));
    closeLoop(input({ domain: 'b.com', verifyText: 'VERIFY_OK', entries: [net({ url: 'https://b.com/api/y' })] }));
  });
  test('listSkills inspects everything', () => {
    expect(listSkills().length).toBe(2);
  });
  test('exportSkills emits valid JSON of the skills', () => {
    const parsed = JSON.parse(exportSkills());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });
  test('forgetSkills(domain) removes only the matching skills', () => {
    const removed = forgetSkills({ domain: 'a.com' });
    expect(removed).toBe(1);
    expect(listSkills().map((s) => s.domain)).toEqual(['b.com']);
  });
  test('forgetSkills({all:true}) wipes the library', () => {
    expect(forgetSkills({ all: true })).toBe(2);
    expect(listSkills()).toEqual([]);
  });
});
