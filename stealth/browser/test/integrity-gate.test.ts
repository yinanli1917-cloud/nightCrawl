/**
 * [INPUT]: Depends on integrity-gate.ts (the legitimacy boundary, pure).
 * [OUTPUT]: Verifies that fact-asserting writes to third parties require confirmation,
 *           efficiency writes pass, unknown assertion-like writes fail safe to confirm,
 *           and requireConfirmation never auto-approves.
 * [POS]: Skill-library safety core — built FIRST. The court-class forgery (a direct
 *        xAPI `completed` POST) is exactly what this gate stops: it becomes a gated,
 *        confirm-required action, never a silent capability. Pure logic, no I/O.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyAction,
  classifyShapeIntegrity,
  isEfficiencyWrite,
  requireConfirmation,
  gateJsCode,
  type ActionDescriptor,
} from '../src/integrity-gate';

const act = (over: Partial<ActionDescriptor>): ActionDescriptor => ({ url: 'https://x.com/api', ...over });

describe('integrity-gate — fact-asserting writes require confirmation', () => {
  test('an xAPI `completed` statement to an LRS → confirm (the court-class forgery)', () => {
    const v = classifyAction(act({
      verb: 'POST',
      url: 'https://texascourtclasses.com/ucTinCan/statements',
      body: '{"verb":{"id":"http://adlnet.gov/expapi/verbs/completed"},"result":{"completion":true}}',
    }));
    expect(v.kind).toBe('confirm-required');
  });

  test('an exam/quiz submission → confirm', () => {
    expect(classifyAction(act({ verb: 'POST', url: 'https://x.com/wp-admin/admin-ajax.php?action=wpProQuiz', body: '{"results":{"score":100}}' })).kind).toBe('confirm-required');
    expect(classifyAction(act({ verb: 'POST', url: 'https://x.com/api/exam/submit-attempt' })).kind).toBe('confirm-required');
  });

  test('payment / identity / e-sign / attendance → confirm', () => {
    expect(classifyAction(act({ verb: 'POST', url: 'https://x.com/v1/payment-intents' })).kind).toBe('confirm-required');
    expect(classifyAction(act({ verb: 'POST', url: 'https://x.com/api/kyc/verify-identity' })).kind).toBe('confirm-required');
    expect(classifyAction(act({ verb: 'POST', url: 'https://x.com/docusign/sign', body: 'I certify under penalty' })).kind).toBe('confirm-required');
    expect(classifyAction(act({ verb: 'POST', url: 'https://x.com/course/attendance/checkin' })).kind).toBe('confirm-required');
  });
});

describe('integrity-gate — efficiency writes pass freely', () => {
  test('owner bulk archive/delete/label passes', () => {
    expect(classifyAction(act({ verb: 'POST', url: 'https://mail.google.com/mail/v1/batchModify', body: '{"removeLabelIds":["INBOX"]}', goalType: 'bulk-archive' })).kind).toBe('pass');
  });
  test('a data export passes', () => {
    expect(classifyAction(act({ verb: 'POST', url: 'https://x.com/api/export?format=csv', goalType: 'export-data' })).kind).toBe('pass');
  });
  test('a plain read (GET) passes', () => {
    expect(classifyAction(act({ verb: 'GET', url: 'https://x.com/api/search?q=hello' })).kind).toBe('pass');
  });
  test('isEfficiencyWrite recognizes batch/export/label endpoints', () => {
    expect(isEfficiencyWrite(act({ verb: 'POST', url: 'https://x.com/api/messages/batchModify' }))).toBe(true);
    expect(isEfficiencyWrite(act({ verb: 'POST', url: 'https://x.com/api/grade/submit' }))).toBe(false);
  });
});

describe('integrity-gate — fail-safe for unknown assertion-like writes', () => {
  test('an unknown write whose body looks like a status assertion → confirm', () => {
    const v = classifyAction(act({ verb: 'POST', url: 'https://unknown-third-party.com/api/do', body: '{"status":"complete","certified":true}' }));
    expect(v.kind).toBe('confirm-required');
    if (v.kind === 'confirm-required') expect(v.signals).toContain('fail-safe');
  });
  test('an unknown write with a benign body passes (not every write gates)', () => {
    expect(classifyAction(act({ verb: 'POST', url: 'https://x.com/api/notes', body: '{"text":"hello world"}' })).kind).toBe('pass');
  });
});

describe('integrity-gate — shape classification (for discovered skills)', () => {
  test('a shape whose urlPattern/goal is course-completion is integrity-sensitive', () => {
    expect(classifyShapeIntegrity({ verb: 'POST', urlPattern: '/ucTinCan/statements' }, 'complete-course')).toBe(true);
    expect(classifyShapeIntegrity({ verb: 'GET', urlPattern: '/api/search' }, 'extract-data')).toBe(false);
  });
});

describe('integrity-gate — gateJsCode (the runtime js intercept)', () => {
  test('a hand-written xAPI completed fetch → confirm (the court-class forgery, blocked)', () => {
    const code = `await fetch("/ucTinCan/statements",{method:"POST",body:'{"verb":"completed"}'})`;
    expect(gateJsCode(code).kind).toBe('confirm-required');
  });
  test('a POST to a /complete endpoint → confirm (fail-safe assertion-like)', () => {
    expect(gateJsCode(`fetch("https://x.com/api/courses/40122/complete",{method:"POST"})`).kind).toBe('confirm-required');
  });
  test('a benign read fetch passes', () => {
    expect(gateJsCode(`await fetch("/api/search?q=hi").then(r=>r.json())`).kind).toBe('pass');
  });
  test('non-network JS (DOM) passes — only network calls are gated here', () => {
    expect(gateJsCode(`document.querySelector('.next').click()`).kind).toBe('pass');
  });
  test('an XMLHttpRequest open to a payment endpoint → confirm', () => {
    expect(gateJsCode(`var x=new XMLHttpRequest();x.open("POST","/v1/charge")`).kind).toBe('confirm-required');
  });
});

describe('integrity-gate — requireConfirmation never auto-approves', () => {
  const v = { kind: 'confirm-required', reason: 'r', signals: ['x'] } as const;
  test('approved notify → true', async () => {
    expect(await requireConfirmation(act({}), v, { notify: async () => 'approved' })).toBe(true);
  });
  test('rejected notify → false', async () => {
    expect(await requireConfirmation(act({}), v, { notify: async () => 'rejected' })).toBe(false);
  });
  test('notify error → false (fail closed)', async () => {
    expect(await requireConfirmation(act({}), v, { notify: async () => 'error' })).toBe(false);
  });
});
