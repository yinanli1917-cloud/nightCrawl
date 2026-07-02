/**
 * [INPUT]: Depends on config.resolveConfig (stateDir).
 * [OUTPUT]: HandoverEvent type + recordHandoverEvent, readHandoverEvents,
 *           pruneHandoverEvents, handoverEventsPath, countByDecision.
 * [POS]: Benchmark instrumentation backbone. A durable, cause-labeled record of every
 *        handover / consent / resume / stay-autonomous decision, so the benchmark can
 *        classify TRUE vs FALSE handovers from an out-of-band log instead of scraping
 *        daemon output. The worst false handover (poll_resume) CLOSES a window and
 *        otherwise leaves no trace — this is where it becomes visible. To be wired into
 *        the six decision points next.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveConfig } from './config';

type Env = Record<string, string | undefined>;

export const MAX_HANDOVER_LINES = 5000;

/** What the poll/handoff logic decided. */
export type HandoverDecision = 'HANDOVER' | 'CONSENT_REQUIRED' | 'RESUME' | 'STAY_AUTONOMOUS';

/** Which of the six decision points produced the event. */
export type HandoverCause =
  | 'url_regex'
  | 'password_copy_form'
  | 'qr'
  | 'auth_barrier_text'
  | 'late_redirect'
  | 'poll_resume'
  | 'consent_cascade';

export interface HandoverEvent {
  ts: number;
  sessionId: string;
  domain: string;
  url: string;
  engine: 'headless' | 'real';
  decision: HandoverDecision;
  cause: HandoverCause;
  wallSeen?: boolean;              // was a wall observed on the page at decision time?
  loginWallSeenAtResume?: boolean; // for poll_resume: was a wall visible when we resumed?
  evidenceSnapshotPath?: string;   // optional saved snapshot for audit
}

// ─── Paths ─────────────────────────────────────────────────

export function handoverEventsPath(env: Env = process.env): string {
  return path.join(resolveConfig(env).stateDir, 'handover-events.jsonl');
}

// ─── Persistence ───────────────────────────────────────────

/** Append one event. Never throws — instrumentation must not break navigation. */
export function recordHandoverEvent(event: HandoverEvent, env: Env = process.env): void {
  try {
    const dest = handoverEventsPath(env);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.appendFileSync(dest, JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch {}
}

/**
 * Read all events (optionally for one domain). Malformed lines are skipped and a missing
 * file reads as empty — best-effort, never a hard error.
 */
export function readHandoverEvents(domain?: string, env: Env = process.env): HandoverEvent[] {
  let raw = '';
  try { raw = fs.readFileSync(handoverEventsPath(env), 'utf-8'); } catch { return []; }
  const out: HandoverEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.decision === 'string' && typeof e.domain === 'string') {
        if (!domain || e.domain === domain) out.push(e);
      }
    } catch {}
  }
  return out;
}

/** Trim to the most recent `max` events. Opportunistic, safe, testable via `max`. */
export function pruneHandoverEvents(env: Env = process.env, max: number = MAX_HANDOVER_LINES): void {
  try {
    const dest = handoverEventsPath(env);
    const lines = fs.readFileSync(dest, 'utf-8').split('\n').filter((l) => l.trim());
    if (lines.length <= max) return;
    const kept = lines.slice(lines.length - max).join('\n') + '\n';
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, kept, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch {}
}

// ─── Summary (pure) ────────────────────────────────────────

/** Count events by decision. Pure — the seed of the benchmark's handover scoring. */
export function countByDecision(events: HandoverEvent[]): Record<HandoverDecision, number> {
  const counts: Record<HandoverDecision, number> = {
    HANDOVER: 0,
    CONSENT_REQUIRED: 0,
    RESUME: 0,
    STAY_AUTONOMOUS: 0,
  };
  for (const e of events) counts[e.decision]++;
  return counts;
}
