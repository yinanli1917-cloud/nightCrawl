/**
 * [INPUT]: Depends on handover-events.ts (durable cause-labeled handover log).
 * [OUTPUT]: Verifies append/read round-trip, BROWSE_STATE_FILE isolation, malformed-line
 *           tolerance, decision counting, and pruning to a cap.
 * [POS]: Benchmark instrumentation backbone — proves the log the false-handover scoring
 *        reads from is durable and isolated. Pure I/O in a temp dir, window-free.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordHandoverEvent,
  readHandoverEvents,
  pruneHandoverEvents,
  handoverEventsPath,
  countByDecision,
  causeFromDetectionReason,
  type HandoverEvent,
} from '../src/handover-events';

function tmpEnv() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-handover-'));
  return { ...process.env, HOME: TMP, BROWSE_STATE_FILE: path.join(TMP, 'state', 'browse.json') } as Record<string, string | undefined>;
}

const ev = (over: Partial<HandoverEvent>): HandoverEvent => ({
  ts: 1_000_000, sessionId: 'default', domain: 'canvas.uw.edu', url: 'https://canvas.uw.edu/login',
  engine: 'headless', decision: 'HANDOVER', cause: 'url_regex', ...over,
});

describe('handover-events — durable cause-labeled log', () => {
  test('append/read round-trip preserves order and fields', () => {
    const env = tmpEnv();
    recordHandoverEvent(ev({ decision: 'CONSENT_REQUIRED', cause: 'auth_barrier_text' }), env);
    recordHandoverEvent(ev({ decision: 'RESUME', cause: 'poll_resume', loginWallSeenAtResume: false }), env);
    const got = readHandoverEvents(undefined, env);
    expect(got.length).toBe(2);
    expect(got[0].decision).toBe('CONSENT_REQUIRED');
    expect(got[1].decision).toBe('RESUME');
    expect(got[1].loginWallSeenAtResume).toBe(false);
  });

  test('path is under the resolved stateDir (BROWSE_STATE_FILE isolates it)', () => {
    const env = tmpEnv();
    recordHandoverEvent(ev({}), env);
    const p = handoverEventsPath(env);
    expect(p.startsWith(path.dirname(env.BROWSE_STATE_FILE!))).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  test('malformed lines are skipped, missing file reads empty', () => {
    const env = tmpEnv();
    expect(readHandoverEvents(undefined, env)).toEqual([]); // missing → empty
    const p = handoverEventsPath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'not json\n' + JSON.stringify(ev({ decision: 'STAY_AUTONOMOUS' })) + '\n');
    const got = readHandoverEvents(undefined, env);
    expect(got.length).toBe(1);
    expect(got[0].decision).toBe('STAY_AUTONOMOUS');
  });

  test('domain filter selects only matching events', () => {
    const env = tmpEnv();
    recordHandoverEvent(ev({ domain: 'a.com' }), env);
    recordHandoverEvent(ev({ domain: 'b.com' }), env);
    expect(readHandoverEvents('a.com', env).length).toBe(1);
  });

  test('causeFromDetectionReason maps each detectLoginWall reason', () => {
    expect(causeFromDetectionReason('Login URL detected: https://x/login')).toBe('url_regex');
    expect(causeFromDetectionReason('Login form detected at https://x')).toBe('password_copy_form');
    expect(causeFromDetectionReason('QR code login detected at https://x')).toBe('qr');
    expect(causeFromDetectionReason('Auth barrier text detected at https://x')).toBe('auth_barrier_text');
  });

  test('countByDecision tallies each decision kind', () => {
    const counts = countByDecision([
      ev({ decision: 'HANDOVER' }), ev({ decision: 'HANDOVER' }),
      ev({ decision: 'RESUME' }), ev({ decision: 'STAY_AUTONOMOUS' }),
    ]);
    expect(counts.HANDOVER).toBe(2);
    expect(counts.RESUME).toBe(1);
    expect(counts.STAY_AUTONOMOUS).toBe(1);
    expect(counts.CONSENT_REQUIRED).toBe(0);
  });

  test('pruneHandoverEvents trims to the most recent cap', () => {
    const env = tmpEnv();
    for (let i = 0; i < 5; i++) recordHandoverEvent(ev({ url: `https://x/${i}` }), env);
    pruneHandoverEvents(env, 2);
    const got = readHandoverEvents(undefined, env);
    expect(got.length).toBe(2);
    expect(got[0].url).toBe('https://x/3'); // oldest three dropped
    expect(got[1].url).toBe('https://x/4');
  });
});
