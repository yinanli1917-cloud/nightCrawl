/**
 * [INPUT]: Depends on metric-budget.isVerifyOk, skill-discovery.discoverSkill,
 *          skill-journal (recordSkill/pruneSkillJournal/SkillRecord),
 *          site-profile.profileKey, goal.GoalType, network-capture-deep.DeepNetEntry.
 * [OUTPUT]: Exports SkillOutcomeInput, closeLoop.
 * [POS]: Skill-library loop CLOSURE — the flywheel. On a verified success it discovers +
 *        records the method that worked (a backend shortcut if one correlated, else a
 *        DOM procedure); on failure it records the miss so the router down-ranks it. The
 *        agent's own outcomes determine what enters the library, no human annotation.
 *        Execution stays advisory + gated — closeLoop only records, never replays.
 */

import { isVerifyOk, type MetricVector } from './metric-budget';
import { discoverSkill } from './skill-discovery';
import { recordSkill, pruneSkillJournal, type SkillRecord } from './skill-journal';
import { profileKey, type SiteProfile } from './site-profile';
import type { DeepNetEntry } from './network-capture-deep';
import type { GoalType } from './goal';

export interface SkillOutcomeInput {
  goalType: GoalType;
  url: string;
  domain: string;
  profile: SiteProfile;
  verifyText: string;       // the command output, scanned with isVerifyOk
  metrics: MetricVector;    // built like buildOutcomeMetrics
  entries: DeepNetEntry[];  // deep-capture snapshot for discovery on success
  now: number;
}

function plainRecord(input: SkillOutcomeInput, method: SkillRecord['method'], ok: boolean): SkillRecord {
  return {
    ts: input.now,
    goalType: input.goalType,
    siteType: profileKey(input.profile),
    domain: input.domain,
    profile: input.profile,
    method,
    shape: { steps: [] },
    integritySensitive: false,
    metrics: input.metrics,
    ok,
  };
}

/**
 * Close the loop on a command outcome. VERIFY_OK → discover the backend shortcut (or
 * record a DOM success when no API call correlated); else record the miss. Persists and
 * prunes. Returns the recorded record. Never replays.
 */
export function closeLoop(
  input: SkillOutcomeInput,
  env: Record<string, string | undefined> = process.env,
): SkillRecord | null {
  if (isVerifyOk(input.verifyText)) {
    const disc = discoverSkill(
      { entries: input.entries, verifiedAt: input.now, goalType: input.goalType, profile: input.profile, domain: input.domain },
      input.metrics,
    );
    const record = disc ? disc.record : plainRecord(input, 'dom', true);
    recordSkill(record, env);
    pruneSkillJournal(env);
    return record;
  }
  const miss = plainRecord(input, 'dom', false);
  recordSkill(miss, env);
  return miss;
}
