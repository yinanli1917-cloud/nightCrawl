/**
 * [INPUT]: Depends on handoff-poll.ts (decidePoll, pure).
 * [OUTPUT]: A labeled corpus of login-poll scenarios scored as a confusion matrix.
 *           false-resume = quit while the user was still logging in (the bug); it MUST be 0.
 *           missed-resume = failed to finish when login was actually done; kept low.
 * [POS]: Artifact 1 (offline false-handover gate), pure-logic layer — the permanent
 *        regression wall around the "quits mid-login" fix. No browser, window-free.
 *
 * Each scenario is a sequence of poll ticks. The oracle labels the sequence:
 *   'in-progress' → the human is still logging in; decidePoll must NEVER resume on any tick.
 *   'complete'    → login has truly landed; decidePoll must resume by the final tick.
 */

import { describe, test, expect } from 'bun:test';
import { decidePoll, initialPollState, defaultPollOptions } from '../src/handoff-poll';

const LOGIN = 'https://idp.u.washington.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s1';
const DUO = 'https://api-57f2a007.duosecurity.com/frame/frameless/v4/auth?sid=abc';
const DUO_CB = 'https://idp.u.washington.edu/idp/profile/Duo/2FA/duo-callback?token=x';
const SAML = 'https://canvas.uw.edu/login/saml/consume?SAMLResponse=zzz';
const PW = 'https://idp.u.washington.edu/idp/Authn/UserPassword'; // non-login-pattern
const QR = 'https://passport.example.com/scan';                  // non-login-pattern
const DASH = 'https://canvas.uw.edu/?login_success=1';           // landed, non-login-pattern

interface Tick { url: string; hasWall: boolean; elapsedMs: number; }
interface Scenario { name: string; ticks: Tick[]; oracle: 'in-progress' | 'complete'; }

const CORPUS: Scenario[] = [
  // ── Login still in progress: decidePoll must NEVER resume ──
  { name: 'slow-painting wall appears after the confirm window', oracle: 'in-progress',
    ticks: [{ url: PW, hasWall: false, elapsedMs: 0 }, { url: PW, hasWall: true, elapsedMs: 6000 }] },
  { name: 'password wall visible the whole time', oracle: 'in-progress',
    ticks: [{ url: PW, hasWall: true, elapsedMs: 1000 }, { url: PW, hasWall: true, elapsedMs: 7000 }, { url: PW, hasWall: true, elapsedMs: 13000 }] },
  { name: 'IdP -> Duo -> callback -> SAML chain still bouncing', oracle: 'in-progress',
    ticks: [{ url: LOGIN, hasWall: false, elapsedMs: 1000 }, { url: DUO, hasWall: false, elapsedMs: 3000 }, { url: DUO_CB, hasWall: false, elapsedMs: 5000 }, { url: SAML, hasWall: false, elapsedMs: 7000 }] },
  { name: 'QR / 2FA code visible on a stable URL', oracle: 'in-progress',
    ticks: [{ url: QR, hasWall: true, elapsedMs: 2000 }, { url: QR, hasWall: true, elapsedMs: 9000 }] },
  { name: 'still parked on the login URL even after it stabilizes', oracle: 'in-progress',
    ticks: [{ url: LOGIN, hasWall: false, elapsedMs: 1000 }, { url: LOGIN, hasWall: false, elapsedMs: 9000 }] },
  { name: 'wall flickers off for one tick but user is still on it', oracle: 'in-progress',
    ticks: [{ url: PW, hasWall: true, elapsedMs: 1000 }, { url: PW, hasWall: false, elapsedMs: 3000 }, { url: PW, hasWall: true, elapsedMs: 5000 }, { url: PW, hasWall: true, elapsedMs: 11000 }] },

  // ── Login truly complete: decidePoll must resume by the end ──
  { name: 'clean landing on the dashboard, settled', oracle: 'complete',
    ticks: [{ url: DASH, hasWall: false, elapsedMs: 1000 }, { url: DASH, hasWall: false, elapsedMs: 6500 }] },
  { name: 'multi-hop chain then settles on the dashboard', oracle: 'complete',
    ticks: [{ url: LOGIN, hasWall: false, elapsedMs: 1000 }, { url: DUO, hasWall: false, elapsedMs: 2000 }, { url: DASH, hasWall: false, elapsedMs: 4000 }, { url: DASH, hasWall: false, elapsedMs: 9500 }] },
  { name: 'wall clears, user navigates to the dashboard, settles', oracle: 'complete',
    ticks: [{ url: PW, hasWall: true, elapsedMs: 1000 }, { url: PW, hasWall: false, elapsedMs: 3000 }, { url: DASH, hasWall: false, elapsedMs: 5000 }, { url: DASH, hasWall: false, elapsedMs: 10500 }] },
  { name: 'slow login but eventually lands and settles', oracle: 'complete',
    ticks: [{ url: PW, hasWall: true, elapsedMs: 2000 }, { url: DASH, hasWall: false, elapsedMs: 8000 }, { url: DASH, hasWall: false, elapsedMs: 13500 }] },
];

// Replay a scenario; return every action decidePoll produced across its ticks.
function replay(s: Scenario): string[] {
  const opts = defaultPollOptions(s.ticks[0].url);
  const state = initialPollState(s.ticks[0].url);
  return s.ticks.map((t) => decidePoll(t, opts, state).action);
}

describe('handoff-poll corpus — false/missed resume confusion matrix', () => {
  const inProgress = CORPUS.filter((s) => s.oracle === 'in-progress');
  const complete = CORPUS.filter((s) => s.oracle === 'complete');

  test('false-resume rate is 0 — never quits while the user is still logging in', () => {
    const falseResumes = inProgress.filter((s) => replay(s).includes('resume'));
    expect(falseResumes.map((s) => s.name)).toEqual([]);
    expect(falseResumes.length / inProgress.length).toBe(0);
  });

  test('missed-resume rate is 0 — always finishes once login has truly landed', () => {
    const missed = complete.filter((s) => {
      const actions = replay(s);
      return actions[actions.length - 1] !== 'resume';
    });
    expect(missed.map((s) => s.name)).toEqual([]);
    expect(missed.length / complete.length).toBe(0);
  });
});
