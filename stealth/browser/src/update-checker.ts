/**
 * [INPUT]: package.json for installed versions, patches/cdp/VERSION for rebrowser
 * [OUTPUT]: Exports checkForUpdates(), compareVersions(), DependencyStatus, UpdateCheckResult
 * [POS]: Startup utility within stealth/browser — non-blocking dependency freshness check
 *
 * Checks npm registry and GitHub releases for newer versions of key dependencies.
 * Runs once per 24 hours (cooldown persisted to ~/.nightcrawl/update-check.json).
 * Fails silently on all errors — never blocks daemon startup.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Types ──────────────────────────────────────────────────────

export interface DependencyStatus {
  name: string;
  current: string;
  latest: string | null;
  outdated: boolean;
}

export interface UpdateCheckResult {
  lastCheck: number;
  results: DependencyStatus[];
}

export interface CheckOptions {
  stateDir: string;
  packageJsonPath: string;
  patchesDir: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  cooldownMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const TIMEOUT_MS = 5_000;
const NPM_REGISTRY = 'https://registry.npmjs.org';
const GITHUB_API = 'https://api.github.com/repos';
const REBROWSER_REPO = 'rebrowser/rebrowser-patches';

// npm packages to check (keys must match package.json dependency names)
const NPM_DEPS = ['playwright-core'] as const;

// ─── Version comparison ─────────────────────────────────────────

/**
 * Compare two semver strings. Returns:
 *   -1 if current < latest (outdated)
 *    0 if equal
 *    1 if current > latest
 */
export function compareVersions(current: string, latest: string): number {
  const parse = (v: string): number[] => {
    const parts = v.replace(/^v/, '').split('.').map(Number);
    while (parts.length < 3) parts.push(0);
    return parts;
  };

  const a = parse(current);
  const b = parse(latest);

  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// ─── Registry fetchers ──────────────────────────────────────────

async function fetchNpmLatest(
  pkg: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetchFn(`${NPM_REGISTRY}/${pkg}/latest`, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}

async function fetchGitHubLatest(
  repo: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetchFn(`${GITHUB_API}/${repo}/releases/latest`, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

// ─── Cooldown ───────────────────────────────────────────────────

function readCooldown(stateDir: string): UpdateCheckResult | null {
  try {
    const raw = readFileSync(join(stateDir, 'update-check.json'), 'utf-8');
    return JSON.parse(raw) as UpdateCheckResult;
  } catch {
    return null;
  }
}

function writeCooldown(stateDir: string, result: UpdateCheckResult): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'update-check.json'),
      JSON.stringify(result, null, 2),
    );
  } catch {
    // Disk write failure — not critical
  }
}

// ─── Main entry point ───────────────────────────────────────────

/**
 * Check key dependencies for available updates.
 *
 * Returns null if checks are disabled or skipped (cooldown).
 * Returns DependencyStatus[] with check results otherwise.
 * Never throws — all errors are caught and handled silently.
 */
export async function checkForUpdates(
  opts: CheckOptions,
): Promise<DependencyStatus[] | null> {
  // Disabled via env var
  if (process.env.BROWSE_UPDATE_CHECK === '0') return null;

  const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;

  // Check cooldown
  const cached = readCooldown(opts.stateDir);
  if (cached && (Date.now() - cached.lastCheck) < cooldownMs) {
    return null;
  }

  // Read installed versions from package.json
  let installedDeps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(opts.packageJsonPath, 'utf-8'));
    installedDeps = pkg.dependencies || {};
  } catch {
    return null; // Can't read package.json — nothing to check
  }

  // Read rebrowser-patches version if available
  let rebrowserVersion: string | null = null;
  try {
    rebrowserVersion = readFileSync(join(opts.patchesDir, 'VERSION'), 'utf-8').trim();
    if (!rebrowserVersion) rebrowserVersion = null;
  } catch {
    // No VERSION file — skip rebrowser check
  }

  // Set up abort controller for timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const results: DependencyStatus[] = [];

    // Check npm packages in parallel
    const npmChecks = NPM_DEPS.map(async (name) => {
      const current = installedDeps[name];
      if (!current) return;

      const latest = await fetchNpmLatest(name, fetchFn, controller.signal);
      results.push({
        name,
        current,
        latest,
        outdated: latest !== null && compareVersions(current, latest) < 0,
      });
    });

    // Check rebrowser-patches via GitHub
    const githubCheck = rebrowserVersion
      ? (async () => {
          const latest = await fetchGitHubLatest(REBROWSER_REPO, fetchFn, controller.signal);
          results.push({
            name: 'rebrowser-patches',
            current: rebrowserVersion!,
            latest,
            outdated: latest !== null && compareVersions(rebrowserVersion!, latest) < 0,
          });
        })()
      : Promise.resolve();

    await Promise.all([...npmChecks, githubCheck]);

    // Log warnings for outdated packages
    for (const dep of results) {
      if (dep.outdated) {
        console.log(
          `[nightcrawl] Update available: ${dep.name} ${dep.current} \u2192 ${dep.latest}`,
        );
      }
    }

    // Persist cooldown
    writeCooldown(opts.stateDir, {
      lastCheck: Date.now(),
      results,
    });

    return results;
  } catch {
    return null; // Network timeout or other failure — fail silently
  } finally {
    clearTimeout(timer);
  }
}
