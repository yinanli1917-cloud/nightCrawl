/**
 * [INPUT]: Depends on goal.ts (the task/goal vocabulary, pure).
 * [OUTPUT]: Verifies parseGoal (explicit --goal) and inferGoal (high-confidence only).
 * [POS]: Skill-library task dimension. "Optimize for tasks, not just sites" — the goal
 *        is the first-class key alongside site-type. Pure logic.
 */

import { describe, test, expect } from 'bun:test';
import { parseGoal, inferGoal, KNOWN_GOALS } from '../src/goal';

describe('goal — parseGoal (explicit --goal)', () => {
  test('a known goal parses (case-insensitive)', () => {
    expect(parseGoal('bulk-archive')).toBe('bulk-archive');
    expect(parseGoal('  COMPLETE-COURSE ')).toBe('complete-course');
  });
  test('absent or unknown → unknown', () => {
    expect(parseGoal()).toBe('unknown');
    expect(parseGoal('do-the-thing')).toBe('unknown');
  });
  test('every KNOWN_GOAL round-trips', () => {
    for (const g of KNOWN_GOALS) expect(parseGoal(g)).toBe(g);
  });
});

describe('goal — inferGoal (weak, high-confidence only)', () => {
  test('an export/download URL infers export-data', () => {
    expect(inferGoal('goto', 'https://x.com/api/export?format=csv')).toBe('export-data');
    expect(inferGoal('download', 'https://x.com/file')).toBe('export-data');
  });
  test('a SCORM/xAPI course-player URL infers complete-course', () => {
    expect(inferGoal('goto', 'https://x.com/uploads/uncanny-snc/index_lms.html?client=Storyline')).toBe('complete-course');
  });
  test('an ordinary page infers nothing (unknown)', () => {
    expect(inferGoal('goto', 'https://example.com/article')).toBe('unknown');
  });
});
