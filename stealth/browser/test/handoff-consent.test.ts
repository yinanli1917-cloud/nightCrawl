/**
 * Unit tests for handoff-consent: per-domain approval store for auto-handover.
 *
 * See memory/feedback_proactive_handoff_ux.md for the design rationale.
 * The Canvas regression memory (project_canvas_regression_2026_04_14.md)
 * is the incident that motivated consent-per-domain over the env-var gate.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  eTldPlusOne,
  readConsent,
  writeConsent,
  isApproved,
  grant,
  revoke,
  prune,
  emptyStore,
  type ConsentStore,
} from '../src/handoff-consent';

// ─── eTLD+1 extraction ──────────────────────────────────────

describe('eTldPlusOne', () => {
  test('simple two-part TLD', () => {
    expect(eTldPlusOne('example.com')).toBe('example.com');
    expect(eTldPlusOne('canvas.uw.edu')).toBe('uw.edu');
    expect(eTldPlusOne('idp.u.washington.edu')).toBe('washington.edu');
    expect(eTldPlusOne('instructure.com')).toBe('instructure.com');
  });

  test('accepts URL input (not just hostname)', () => {
    expect(eTldPlusOne('https://canvas.uw.edu/courses/1')).toBe('uw.edu');
    expect(eTldPlusOne('http://foo.bar.example.com/?x=1')).toBe('example.com');
  });

  test('country-code TLDs with secondary suffix', () => {
    expect(eTldPlusOne('foo.co.uk')).toBe('foo.co.uk');
    expect(eTldPlusOne('bar.ac.uk')).toBe('bar.ac.uk');
    expect(eTldPlusOne('taobao.com.cn')).toBe('taobao.com.cn');
    expect(eTldPlusOne('sub.taobao.com.cn')).toBe('taobao.com.cn');
    expect(eTldPlusOne('university.edu.cn')).toBe('university.edu.cn');
  });

  test('lowercase normalization', () => {
    expect(eTldPlusOne('CANVAS.UW.EDU')).toBe('uw.edu');
    expect(eTldPlusOne('https://Example.Com/Path')).toBe('example.com');
  });

  test('localhost / single-label hosts return as-is', () => {
    expect(eTldPlusOne('localhost')).toBe('localhost');
    expect(eTldPlusOne('http://localhost:3000')).toBe('localhost');
  });

  test('strips port and trailing dot', () => {
    expect(eTldPlusOne('canvas.uw.edu:443')).toBe('uw.edu');
    expect(eTldPlusOne('canvas.uw.edu.')).toBe('uw.edu');
  });
});

// ─── Read/Write persistence ─────────────────────────────────

const TMP_BASE = path.join(os.tmpdir(), 'nightcrawl-consent-test');

function freshTmpDir(): string {
  const dir = `${TMP_BASE}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('readConsent / writeConsent', () => {
  test('readConsent returns empty store when file missing', () => {
    const dir = freshTmpDir();
    const store = readConsent(path.join(dir, 'missing.json'));
    expect(store.version).toBe(1);
    expect(Object.keys(store.entries)).toHaveLength(0);
  });

  test('readConsent returns empty store when file malformed', () => {
    const dir = freshTmpDir();
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{not valid json');
    const store = readConsent(file);
    expect(store.version).toBe(1);
    expect(Object.keys(store.entries)).toHaveLength(0);
  });

  test('writeConsent then readConsent round-trips entries', () => {
    const dir = freshTmpDir();
    const file = path.join(dir, 'consent.json');
    const now = new Date('2026-04-14T00:00:00Z');
    let store = emptyStore();
    store = grant(store, 'canvas.uw.edu', 30, now);
    writeConsent(file, store);

    const loaded = readConsent(file);
    expect(loaded.entries['uw.edu']).toBeDefined();
    expect(loaded.entries['uw.edu'].domain).toBe('uw.edu');
  });

  test('writeConsent is atomic (no partial file on crash-equivalent)', () => {
    const dir = freshTmpDir();
    const file = path.join(dir, 'consent.json');
    const store = grant(emptyStore(), 'uw.edu');
    writeConsent(file, store);
    // file exists and parses cleanly — atomic write means no dangling tmp
    expect(fs.existsSync(file)).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(file, 'utf-8'))).not.toThrow();
  });
});

// ─── grant / revoke / isApproved ────────────────────────────

describe('grant / revoke / isApproved', () => {
  test('fresh store has no approvals', () => {
    expect(isApproved(emptyStore(), 'canvas.uw.edu')).toBe(false);
  });

  test('grant approves the eTLD+1 and all its subdomains', () => {
    const store = grant(emptyStore(), 'canvas.uw.edu');
    expect(isApproved(store, 'canvas.uw.edu')).toBe(true);
    expect(isApproved(store, 'idp.u.washington.edu')).toBe(false); // different eTLD+1
    expect(isApproved(store, 'https://mycourses.canvas.uw.edu/x')).toBe(true);
    expect(isApproved(store, 'uw.edu')).toBe(true);
  });

  test('grant keys by eTLD+1 regardless of subdomain granted', () => {
    const store = grant(emptyStore(), 'https://some.sub.uw.edu/page');
    expect(store.entries['uw.edu']).toBeDefined();
    expect(isApproved(store, 'other.sub.uw.edu')).toBe(true);
  });

  test('expired entries are not approved', () => {
    const grantedAt = new Date('2026-01-01T00:00:00Z');
    const store = grant(emptyStore(), 'uw.edu', 30, grantedAt);
    const later = new Date('2026-03-01T00:00:00Z'); // 59 days later
    expect(isApproved(store, 'uw.edu', later)).toBe(false);
  });

  test('revoke removes the entry', () => {
    let store = grant(emptyStore(), 'uw.edu');
    expect(isApproved(store, 'uw.edu')).toBe(true);
    store = revoke(store, 'canvas.uw.edu');
    expect(isApproved(store, 'uw.edu')).toBe(false);
  });

  test('prune drops expired entries', () => {
    const old = new Date('2026-01-01T00:00:00Z');
    let store = grant(emptyStore(), 'old.com', 30, old);
    store = grant(store, 'fresh.com', 30, new Date('2026-04-14T00:00:00Z'));
    const pruned = prune(store, new Date('2026-04-14T00:00:00Z'));
    expect(pruned.entries['old.com']).toBeUndefined();
    expect(pruned.entries['fresh.com']).toBeDefined();
  });
});
