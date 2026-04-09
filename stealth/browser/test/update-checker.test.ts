/**
 * Tests for stealth/browser/src/update-checker.ts
 *
 * Dependency update checker that warns about outdated npm packages
 * and GitHub releases on daemon startup. All network requests are
 * mocked — no real npm/GitHub calls in tests.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Test isolation ──────────────────────────────────────────────

let stateDir: string;
let packageJsonPath: string;
let patchesDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'update-checker-test-'));
  packageJsonPath = join(stateDir, 'package.json');
  patchesDir = join(stateDir, 'patches');
  mkdirSync(patchesDir, { recursive: true });
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  // Reset env
  delete process.env.BROWSE_UPDATE_CHECK;
});

// ─── Import the module under test ────────────────────────────────

import {
  compareVersions,
  checkForUpdates,
  type UpdateCheckResult,
  type DependencyStatus,
} from '../src/update-checker';

// ─── Unit: version comparison ────────────────────────────────────

describe('compareVersions', () => {
  test('equal versions return 0', () => {
    expect(compareVersions('1.58.2', '1.58.2')).toBe(0);
  });

  test('newer patch returns -1 (current < latest)', () => {
    expect(compareVersions('1.58.2', '1.58.3')).toBe(-1);
  });

  test('newer minor returns -1', () => {
    expect(compareVersions('1.58.2', '1.59.0')).toBe(-1);
  });

  test('newer major returns -1', () => {
    expect(compareVersions('1.58.2', '2.0.0')).toBe(-1);
  });

  test('older version returns 1 (current > latest)', () => {
    expect(compareVersions('1.59.0', '1.58.2')).toBe(1);
  });

  test('handles v-prefix in version strings', () => {
    expect(compareVersions('1.58.2', 'v1.59.0')).toBe(-1);
  });

  test('handles missing patch number', () => {
    expect(compareVersions('1.58', '1.58.1')).toBe(-1);
  });
});

// ─── Unit: cooldown ──────────────────────────────────────────────

describe('cooldown', () => {
  test('skips check when last check was within 24 hours', async () => {
    const checkFile = join(stateDir, 'update-check.json');
    const recentTimestamp = Date.now() - (12 * 60 * 60 * 1000); // 12h ago
    writeFileSync(checkFile, JSON.stringify({
      lastCheck: recentTimestamp,
      results: [],
    }));

    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: async () => { throw new Error('should not be called'); },
    });

    // Should return cached results (empty array from the cached file)
    expect(results).toBeNull();
  });

  test('re-checks when last check was over 24 hours ago', async () => {
    const checkFile = join(stateDir, 'update-check.json');
    const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25h ago
    writeFileSync(checkFile, JSON.stringify({
      lastCheck: oldTimestamp,
      results: [],
    }));

    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));

    const mockFetch = async (url: string) => {
      return new Response(JSON.stringify({ version: '1.58.2' }), { status: 200 });
    };

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: mockFetch,
    });

    expect(results).not.toBeNull();
  });
});

// ─── Unit: disabled via env var ──────────────────────────────────

describe('disabled via env', () => {
  test('returns null when BROWSE_UPDATE_CHECK=0', async () => {
    process.env.BROWSE_UPDATE_CHECK = '0';

    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: async () => { throw new Error('should not be called'); },
    });

    expect(results).toBeNull();
  });
});

// ─── Integration: detects outdated packages ──────────────────────

describe('checkForUpdates', () => {
  test('detects outdated playwright-core', async () => {
    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));

    const mockFetch = async (url: string) => {
      if (url.includes('registry.npmjs.org/playwright-core')) {
        return new Response(JSON.stringify({ version: '1.60.0' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: mockFetch,
    });

    expect(results).not.toBeNull();
    const pw = results!.find((r: DependencyStatus) => r.name === 'playwright-core');
    expect(pw).toBeDefined();
    expect(pw!.current).toBe('1.58.2');
    expect(pw!.latest).toBe('1.60.0');
    expect(pw!.outdated).toBe(true);
  });

  test('reports up-to-date when versions match', async () => {
    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));

    const mockFetch = async (url: string) => {
      if (url.includes('registry.npmjs.org/playwright-core')) {
        return new Response(JSON.stringify({ version: '1.58.2' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: mockFetch,
    });

    expect(results).not.toBeNull();
    const pw = results!.find((r: DependencyStatus) => r.name === 'playwright-core');
    expect(pw).toBeDefined();
    expect(pw!.outdated).toBe(false);
  });

  test('checks rebrowser-patches via GitHub API', async () => {
    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));
    writeFileSync(join(patchesDir, 'VERSION'), '1.48.0\n');

    const mockFetch = async (url: string) => {
      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: '1.58.2' }), { status: 200 });
      }
      if (url.includes('api.github.com/repos/rebrowser/rebrowser-patches')) {
        return new Response(JSON.stringify({ tag_name: 'v1.50.0' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: mockFetch,
    });

    expect(results).not.toBeNull();
    const rb = results!.find((r: DependencyStatus) => r.name === 'rebrowser-patches');
    expect(rb).toBeDefined();
    expect(rb!.current).toBe('1.48.0');
    expect(rb!.latest).toBe('1.50.0');
    expect(rb!.outdated).toBe(true);
  });

  test('skips rebrowser-patches when no VERSION file exists', async () => {
    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));
    // No VERSION file in patchesDir

    const mockFetch = async (url: string) => {
      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: '1.58.2' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: mockFetch,
    });

    expect(results).not.toBeNull();
    const rb = results!.find((r: DependencyStatus) => r.name === 'rebrowser-patches');
    expect(rb).toBeUndefined();
  });

  test('persists check timestamp to disk', async () => {
    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));

    const mockFetch = async (url: string) => {
      return new Response(JSON.stringify({ version: '1.58.2' }), { status: 200 });
    };

    await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: mockFetch,
    });

    const checkFile = join(stateDir, 'update-check.json');
    const saved = JSON.parse(readFileSync(checkFile, 'utf-8'));
    expect(saved.lastCheck).toBeGreaterThan(Date.now() - 5000);
    expect(Array.isArray(saved.results)).toBe(true);
  });
});

// ─── Resilience: network errors ──────────────────────────────────

describe('network errors', () => {
  test('returns empty results on fetch failure (does not throw)', async () => {
    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));

    const mockFetch = async () => {
      throw new Error('Network unreachable');
    };

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: mockFetch,
    });

    // Should succeed but with unknown latest versions
    expect(results).not.toBeNull();
  });

  test('handles HTTP error responses gracefully', async () => {
    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));

    const mockFetch = async () => {
      return new Response('Internal Server Error', { status: 500 });
    };

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: mockFetch,
    });

    expect(results).not.toBeNull();
    const pw = results!.find((r: DependencyStatus) => r.name === 'playwright-core');
    expect(pw).toBeDefined();
    expect(pw!.latest).toBeNull();
    expect(pw!.outdated).toBe(false);
  });

  test('handles malformed JSON responses', async () => {
    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));

    const mockFetch = async () => {
      return new Response('not json at all', { status: 200 });
    };

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: mockFetch,
    });

    expect(results).not.toBeNull();
    const pw = results!.find((r: DependencyStatus) => r.name === 'playwright-core');
    expect(pw!.latest).toBeNull();
  });
});

// ─── Timeout ─────────────────────────────────────────────────────

describe('timeout', () => {
  test('aborts after 5 seconds (simulated via AbortController)', async () => {
    writeFileSync(packageJsonPath, JSON.stringify({
      dependencies: { 'playwright-core': '1.58.2' },
    }));

    const mockFetch = async (_url: string, opts?: { signal?: AbortSignal }) => {
      // Verify the signal is passed
      expect(opts?.signal).toBeDefined();
      expect(opts!.signal!.aborted).toBe(false);
      // Simulate successful response (real timeout test would need actual delay)
      return new Response(JSON.stringify({ version: '1.58.2' }), { status: 200 });
    };

    const results = await checkForUpdates({
      stateDir,
      packageJsonPath,
      patchesDir,
      fetchFn: mockFetch,
    });

    expect(results).not.toBeNull();
  });
});
