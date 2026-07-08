import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyFailure,
  failureSignature,
  buildTaskCreateArgv,
  nightcrawlRepoRoot,
  failuresLogPath,
  recordFailure,
  readFailures,
  pruneFailures,
  claimSignature,
  collectDiagnostics,
  shouldCreateTask,
  type FailureRecord,
} from '../src/failure-collector';

// ─── Helpers ─────────────────────────────────────────────────
// Each test gets an isolated sink + a throwaway session stateDir, so nothing
// touches the real ~/.nightcrawl. We pass `env` explicitly rather than mutating
// process.env, so tests never leak into each other.
function mkEnv(extra: Record<string, string> = {}): Record<string, string> {
  const sink = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fail-sink-'));
  return { NIGHTCRAWL_FAILURE_DIR: sink, HOME: sink, ...extra };
}

function rec(over: Partial<FailureRecord> = {}): FailureRecord {
  return {
    ts: 1_700_000_000_000,
    layer: 'cli',
    category: 'command-timeout',
    family: 'daemon-unavailable',
    actionable: true,
    signature: 'daemon-unavailable',
    message: 'The operation timed out.',
    ...over,
  };
}

describe('failure-collector', () => {
  // ─── classifyFailure (data-driven signal table) ────────────
  describe('classifyFailure', () => {
    test('timeout → command-timeout / daemon-unavailable / actionable', () => {
      const c = classifyFailure('[browse] The operation timed out.');
      expect(c.category).toBe('command-timeout');
      expect(c.family).toBe('daemon-unavailable');
      expect(c.actionable).toBe(true);
    });

    test('"No active page" classifies as daemon-unavailable, NOT site', () => {
      const c = classifyFailure('No active page. Use "browse goto <url>" first.');
      expect(c.family).toBe('daemon-unavailable');
      expect(c.category).toBe('no-active-page');
    });

    test('startup failure → daemon-unavailable', () => {
      expect(classifyFailure('Server failed to start within 45s').family).toBe('daemon-unavailable');
    });

    test('port in use → daemon-unavailable', () => {
      const c = classifyFailure('bridge ws server not started: Failed to start server. Is port 10087 in use?');
      expect(c.category).toBe('port-in-use');
      expect(c.family).toBe('daemon-unavailable');
    });

    test('login wall → site / NOT actionable', () => {
      const c = classifyFailure('LOGIN_REQUIRED: sign in to continue');
      expect(c.family).toBe('site');
      expect(c.actionable).toBe(false);
    });

    test('site error → site / NOT actionable', () => {
      const c = classifyFailure('Bookmarks. Something went wrong. Try reloading.');
      expect(c.family).toBe('site');
      expect(c.actionable).toBe(false);
    });

    test('missing engine → env / actionable', () => {
      const c = classifyFailure('CloakBrowser is not installed. Run the install step.');
      expect(c.family).toBe('env');
      expect(c.actionable).toBe(true);
    });

    test('unrecognized text → unknown / actionable (so we still learn)', () => {
      const c = classifyFailure('a totally novel banana failure');
      expect(c.category).toBe('unknown');
      expect(c.family).toBe('unknown');
      expect(c.actionable).toBe(true);
    });

    test('hint is a fallback for opaque text', () => {
      const c = classifyFailure('some opaque crash with no keywords', 'daemon-fatal');
      expect(c.category).toBe('daemon-fatal');
      expect(c.family).toBe('daemon-unavailable');
      expect(c.actionable).toBe(true);
    });

    test('specific text wins over a generic hint', () => {
      // A startup crash whose text names CloakBrowser is an env problem, not a
      // generic startup failure — the more specific text classification wins.
      const c = classifyFailure('CloakBrowser is not installed', 'startup-failure');
      expect(c.category).toBe('cloakbrowser-missing');
      expect(c.family).toBe('env');
    });
  });

  // ─── failureSignature (coarse by family) ────────────────────
  describe('failureSignature', () => {
    test('daemon-unavailable is coarse (ignores domain/command) → one task per spree', () => {
      const a = failureSignature({ category: 'command-timeout', family: 'daemon-unavailable', domain: 'x.com' });
      const b = failureSignature({ category: 'no-active-page', family: 'daemon-unavailable', domain: 'y.org' });
      expect(a).toBe('daemon-unavailable');
      expect(b).toBe('daemon-unavailable');
    });

    test('site signature includes the domain', () => {
      const s = failureSignature({ category: 'login-required', family: 'site', domain: 'example.com' });
      expect(s).toContain('example.com');
    });

    test('env signature is host-scoped by category', () => {
      expect(failureSignature({ category: 'cloakbrowser-missing', family: 'env' })).toBe('env:cloakbrowser-missing');
    });
  });

  // ─── Persistence to the GLOBAL sink ─────────────────────────
  describe('recordFailure persistence', () => {
    test('writes a line to the global sink, not the session stateDir', () => {
      const env = mkEnv();
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-session-'));
      const config: any = {
        stateDir: sessionDir,
        consoleLog: path.join(sessionDir, 'browse-console.log'),
        networkLog: path.join(sessionDir, 'browse-network.log'),
        dialogLog: path.join(sessionDir, 'browse-dialog.log'),
      };
      recordFailure({ layer: 'cli', message: 'The operation timed out.', config, env });
      const all = readFailures(env);
      expect(all.length).toBe(1);
      expect(all[0].family).toBe('daemon-unavailable');
      // The line is in the sink, not the session dir.
      expect(fs.existsSync(failuresLogPath(env))).toBe(true);
      expect(fs.existsSync(path.join(sessionDir, 'failures.jsonl'))).toBe(false);
    });

    test('non-actionable failure (login wall) is still recorded, but no bundle', () => {
      const env = mkEnv();
      recordFailure({ layer: 'cli', message: 'LOGIN_REQUIRED', url: 'https://uw.edu/x', env });
      const all = readFailures(env);
      expect(all.length).toBe(1);
      expect(all[0].actionable).toBe(false);
      expect(all[0].bundleDir).toBeUndefined();
    });

    test('prune caps the log at 5000 lines', () => {
      const env = mkEnv();
      const dest = failuresLogPath(env);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const line = JSON.stringify(rec()) + '\n';
      fs.writeFileSync(dest, line.repeat(5005));
      pruneFailures(env);
      const kept = fs.readFileSync(dest, 'utf-8').split('\n').filter((l) => l.trim());
      expect(kept.length).toBe(5000);
    });

    test('never throws when the sink path is unusable', () => {
      // Point the sink at a regular FILE so mkdir/append fail — must be swallowed.
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-badsink-')), 'not-a-dir');
      fs.writeFileSync(f, 'x');
      const env = { NIGHTCRAWL_FAILURE_DIR: f, HOME: f };
      expect(() => recordFailure({ layer: 'cli', message: 'The operation timed out.', env })).not.toThrow();
    });

    test('kill switch records nothing', () => {
      const env = mkEnv({ NIGHTCRAWL_NO_FAILURE_CAPTURE: '1' });
      recordFailure({ layer: 'cli', message: 'The operation timed out.', env });
      expect(readFailures(env).length).toBe(0);
    });
  });

  // ─── Atomic dedup (race-safe) ───────────────────────────────
  describe('claimSignature', () => {
    test('novel once, repeat within TTL is not novel, novel again after TTL', () => {
      const env = mkEnv();
      const ttl = 6 * 60 * 60 * 1000;
      const t0 = 1_700_000_000_000;
      const first = claimSignature('daemon-unavailable', ttl, env, t0);
      expect(first.novel).toBe(true);
      const second = claimSignature('daemon-unavailable', ttl, env, t0 + 60_000);
      expect(second.novel).toBe(false);
      expect(second.count).toBe(2);
      const later = claimSignature('daemon-unavailable', ttl, env, t0 + 7 * 60 * 60 * 1000);
      expect(later.novel).toBe(true);
    });
  });

  // ─── Task-create argv (pure) ────────────────────────────────
  describe('buildTaskCreateArgv', () => {
    test('has task create + autofail slug + description, and NEVER --global', () => {
      const argv = buildTaskCreateArgv(rec({ domain: 'x.com' }), '/repo/root');
      expect(argv).toContain('task');
      expect(argv).toContain('create');
      const slugIdx = argv.indexOf('--slug');
      expect(slugIdx).toBeGreaterThan(-1);
      expect(argv[slugIdx + 1].startsWith('autofail-')).toBe(true);
      expect(argv).toContain('--description');
      expect(argv).not.toContain('--global');
      expect(argv[0]).toBe('python3');
      expect(argv.some((a) => a.endsWith('scripts/codex_harness.py'))).toBe(true);
    });
  });

  // ─── Task-creation gate ─────────────────────────────────────
  describe('shouldCreateTask', () => {
    test('non-actionable never files', () => {
      expect(shouldCreateTask(rec({ actionable: false }), {}, { repoRoot: '/x', gitRoot: '/y' })).toBe(false);
    });
    test('in-repo (git root == nightcrawl repo) does not file (self-spam)', () => {
      expect(shouldCreateTask(rec(), {}, { repoRoot: '/x', gitRoot: '/x' })).toBe(false);
    });
    test('a foreign project files', () => {
      expect(shouldCreateTask(rec(), {}, { repoRoot: '/x', gitRoot: '/y' })).toBe(true);
    });
    test('no harness found → cannot file', () => {
      expect(shouldCreateTask(rec(), {}, { repoRoot: null, gitRoot: '/y' })).toBe(false);
    });
  });

  // ─── Diagnostics bundle ─────────────────────────────────────
  describe('collectDiagnostics', () => {
    test('writes a bundle dir with record.json and daemon-processes.txt', () => {
      const env = mkEnv();
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-session-'));
      fs.writeFileSync(path.join(sessionDir, 'browse-console.log'), 'hello console\n');
      const config: any = {
        stateDir: sessionDir,
        consoleLog: path.join(sessionDir, 'browse-console.log'),
        networkLog: path.join(sessionDir, 'browse-network.log'),
        dialogLog: path.join(sessionDir, 'browse-dialog.log'),
      };
      const dir = collectDiagnostics(rec(), config, env);
      expect(dir).toBeTruthy();
      expect(fs.existsSync(path.join(dir!, 'record.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir!, 'daemon-processes.txt'))).toBe(true);
    });
  });

  // ─── Repo-root resolution (works from any caller cwd) ───────
  describe('nightcrawlRepoRoot', () => {
    test('finds the repo containing scripts/codex_harness.py', () => {
      const root = nightcrawlRepoRoot();
      expect(root).not.toBeNull();
      expect(fs.existsSync(path.join(root!, 'scripts', 'codex_harness.py'))).toBe(true);
    });
    test('returns null when no harness is found above the start dir', () => {
      expect(nightcrawlRepoRoot('/')).toBeNull();
    });
  });
});
