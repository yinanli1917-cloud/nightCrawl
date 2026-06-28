/**
 * [INPUT]: Depends on skill-journal (readSkills/skillJournalPath/SkillRecord) + fs.
 * [OUTPUT]: Exports listSkills, exportSkills, forgetSkills.
 * [POS]: Skill-library OWNERSHIP surface — "your data is yours" (the one good idea from
 *        the cloud bookmark tools, done locally). The user can inspect, export (JSON),
 *        and delete their learned skills. Full transparency + control; nothing is hidden
 *        and nothing leaves the machine.
 */

import * as fs from 'fs';
import { readSkills, skillJournalPath, type SkillRecord } from './skill-journal';
import type { GoalType } from './goal';

export interface SkillFilter {
  goalType?: GoalType;
  siteType?: string;
  domain?: string;
  all?: boolean;
}

/** Inspect every learned skill (recency-unfiltered — the user sees all of it). */
export function listSkills(env: Record<string, string | undefined> = process.env): SkillRecord[] {
  return readSkills({}, env);
}

/** Export the full library as pretty JSON (one-click "your data is yours"). */
export function exportSkills(env: Record<string, string | undefined> = process.env): string {
  return JSON.stringify(listSkills(env), null, 2);
}

function matchesFilter(r: SkillRecord, f: SkillFilter): boolean {
  if (f.all) return true;
  if (f.goalType && r.goalType !== f.goalType) return false;
  if (f.siteType && r.siteType !== f.siteType) return false;
  if (f.domain && r.domain !== f.domain) return false;
  // An empty filter (no keys) matches nothing — forgetting requires an explicit target.
  return !!(f.goalType || f.siteType || f.domain);
}

/**
 * Delete the skills matching the filter. Returns how many were removed. Rewrites the
 * journal atomically. An empty filter removes nothing (delete must be explicit).
 */
export function forgetSkills(
  filter: SkillFilter,
  env: Record<string, string | undefined> = process.env,
): number {
  const all = listSkills(env);
  const kept = all.filter((r) => !matchesFilter(r, filter));
  const removed = all.length - kept.length;
  if (removed === 0) return 0;
  try {
    const dest = skillJournalPath(env);
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch {}
  return removed;
}
