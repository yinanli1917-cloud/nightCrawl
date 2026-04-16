/**
 * Auto-updater orchestrator.
 *
 * Orchestrates the full update cycle:
 *   1. Gate: read auto_upgrade from config.yaml — skip if false
 *   2. Gate: 24h cooldown — skip if recently ran
 *   3. Detect: call checkForUpdates() to find outdated deps
 *   4. Compatibility gate: skip Playwright if no compatible rebrowser-patches
 *   5. Snapshot: capture package.json + bun.lock for rollback
 *   6. Execute: bun add for each safe outdated dep
 *   7. Re-apply CDP patches if Playwright was updated
 *   8. Verify: run stealth-verifier smoke test
 *   9. Rollback if verification or install failed
 *
 * All side effects are injected via AutoUpdateOptions so the
 * orchestrator can be unit-tested without touching the real
 * filesystem, network, or Bun subprocess.
 *
 * Update safety chain (do not violate):
 *   - CloakBrowser: always safe (independent Chromium + own C++ patches)
 *   - Playwright: only when rebrowser-patches has compatible release
 *   - rebrowser-patches: NEVER auto-updated (hand-adapted), only warn
 *
 * [INPUT]: AutoUpdateOptions (config reader, executor, verifier, snapshot fns)
 * [OUTPUT]: maybeAutoUpdate(), AutoUpdateResult
 * [POS]: Top-level coordinator for the auto-update system
 */

import {
  createUpdateSnapshot,
  saveSnapshot,
  deleteSnapshot,
  preserveFailedSnapshot,
  restoreSnapshotFiles,
  type UpdateSnapshot,
} from './update-snapshot';
import type { DependencyStatus, RebrowserCompatibility } from './update-checker';
import type { VerifyResult } from './stealth-verifier';
import type { ExecutorResult } from './update-executor';

// ─── Types ──────────────────────────────────────────────────────

export interface AutoUpdateOptions {
  // Paths
  stateDir: string;
  packageJsonPath: string;
  bunLockPath: string;
  patchesDir: string;
  cwd: string;

  // Injected I/O (so the orchestrator is unit-testable)
  readConfigValue: (key: string) => string | null;
  isCooldownActive: () => boolean;
  writeCooldown: () => void;
  detectUpdates: () => Promise<DependencyStatus[] | null>;
  checkRebrowserCompat: (pwVersion: string) => Promise<RebrowserCompatibility>;
  runExecutor: (cmd: string, pkg: string, version: string) => Promise<ExecutorResult>;
  runVerifier: () => Promise<VerifyResult>;
  applyPatches: () => Promise<void>;

  // Lifecycle hooks (optional)
  log?: (msg: string) => void;
  onSnapshot?: (snap: UpdateSnapshot) => void;
  onRollback?: (snap: UpdateSnapshot, reason: string) => void;
}

export interface AutoUpdateResult {
  skipped: boolean;
  reason?: string;
  updated: string[];           // package names actually updated
  verified?: boolean;
  rolledBack?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────

function nameOf(d: DependencyStatus): string {
  return d.name;
}

function isPlaywright(name: string): boolean {
  return name === 'playwright-core' || name === 'playwright';
}

async function rollback(
  snapshot: UpdateSnapshot,
  opts: AutoUpdateOptions,
  reason: string,
): Promise<void> {
  const log = opts.log ?? (() => {});
  log(`[auto-update] Rolling back: ${reason}`);
  try {
    restoreSnapshotFiles(snapshot, {
      packageJsonPath: opts.packageJsonPath,
      bunLockPath: opts.bunLockPath,
    });
    preserveFailedSnapshot(opts.stateDir, snapshot);
    opts.onRollback?.(snapshot, reason);
  } catch (err: any) {
    log(`[auto-update] Rollback file restore failed: ${err?.message || err}`);
  }
}

interface PlannedUpdate {
  name: string;
  current: string;
  target: string;
  isPlaywright: boolean;
}

async function planUpdates(
  outdated: DependencyStatus[],
  opts: AutoUpdateOptions,
): Promise<PlannedUpdate[]> {
  const log = opts.log ?? (() => {});
  const plan: PlannedUpdate[] = [];

  for (const dep of outdated) {
    if (!dep.outdated || !dep.latest) continue;

    if (isPlaywright(dep.name)) {
      // Compatibility gate: only update Playwright if rebrowser-patches is ready
      const compat = await opts.checkRebrowserCompat(dep.latest);
      if (!compat.compatible) {
        log(
          `[auto-update] Skipping ${dep.name} ${dep.latest}: ` +
          `no compatible rebrowser-patches (latest: ${compat.latestRebrowser ?? 'unknown'}). ` +
          `rebrowser-patches must be hand-adapted before this update can land.`,
        );
        continue;
      }
      log(`[auto-update] Planning ${dep.name}: ${dep.current} -> ${dep.latest} ` +
          `(rebrowser-patches ${compat.matchedRelease} compatible)`);
    } else {
      log(`[auto-update] Planning ${dep.name}: ${dep.current} -> ${dep.latest}`);
    }

    plan.push({
      name: dep.name,
      current: dep.current,
      target: dep.latest,
      isPlaywright: isPlaywright(dep.name),
    });
  }

  return plan;
}

async function executePlan(
  plan: PlannedUpdate[],
  opts: AutoUpdateOptions,
): Promise<{ success: boolean; updated: string[]; failedAt?: string }> {
  const updated: string[] = [];
  for (const item of plan) {
    const result = await opts.runExecutor('install', item.name, item.target);
    if (!result.success) {
      return { success: false, updated, failedAt: item.name };
    }
    updated.push(item.name);
  }
  return { success: true, updated };
}

// ─── Public API ─────────────────────────────────────────────────

export async function maybeAutoUpdate(
  opts: AutoUpdateOptions,
): Promise<AutoUpdateResult> {
  const log = opts.log ?? (() => {});

  // Gate 1: config
  if (opts.readConfigValue('auto_upgrade') !== 'true') {
    return { skipped: true, reason: 'auto_upgrade disabled in config', updated: [] };
  }

  // Gate 2: cooldown
  if (opts.isCooldownActive()) {
    return { skipped: true, reason: 'cooldown active', updated: [] };
  }

  // Gate 3: detection
  const outdated = await opts.detectUpdates();
  if (outdated === null) {
    return { skipped: true, reason: 'detection skipped or failed', updated: [] };
  }
  const anyOutdated = outdated.some((d) => d.outdated);
  if (!anyOutdated) {
    opts.writeCooldown();
    return { skipped: true, reason: 'all dependencies up to date', updated: [] };
  }

  // Gate 4: compatibility — build the plan
  const plan = await planUpdates(outdated.filter((d) => d.outdated), opts);
  if (plan.length === 0) {
    log('[auto-update] All outdated deps blocked by compatibility gate');
    return { skipped: false, updated: [] };
  }

  // Baseline: capture pre-update stealth score for comparison
  const preResult = await opts.runVerifier();
  const prePassCount = preResult.checks.filter((c) => c.passed).length;
  log(`[auto-update] Baseline stealth: ${prePassCount}/${preResult.checks.length} checks pass`);

  // Snapshot before any mutation
  const snapshot = createUpdateSnapshot({
    packageJsonPath: opts.packageJsonPath,
    bunLockPath: opts.bunLockPath,
  });
  saveSnapshot(snapshot, opts.stateDir);
  opts.onSnapshot?.(snapshot);

  // Execute
  const exec = await executePlan(plan, opts);
  if (!exec.success) {
    await rollback(snapshot, opts, `install failed at ${exec.failedAt}`);
    return { skipped: false, updated: exec.updated, rolledBack: true };
  }

  // Re-apply CDP patches if Playwright was touched
  if (plan.some((p) => p.isPlaywright)) {
    try {
      await opts.applyPatches();
    } catch (err: any) {
      await rollback(snapshot, opts, `patch re-application failed: ${err?.message || err}`);
      return { skipped: false, updated: exec.updated, rolledBack: true };
    }
  }

  // Verify: compare post-update against pre-update baseline
  const postResult = await opts.runVerifier();
  const postPassCount = postResult.checks.filter((c) => c.passed).length;
  log(`[auto-update] Stealth: pre=${prePassCount}/${preResult.checks.length}, post=${postPassCount}/${postResult.checks.length}`);

  if (postPassCount < prePassCount) {
    const failedChecks = postResult.checks.filter((c) => !c.passed).map((c) => c.name).join(',');
    await rollback(snapshot, opts, `stealth regression: ${failedChecks} (was ${prePassCount}/${preResult.checks.length}, now ${postPassCount}/${postResult.checks.length})`);
    return { skipped: false, updated: exec.updated, verified: false, rolledBack: true };
  }

  // Success — clean up snapshot, write cooldown
  deleteSnapshot(opts.stateDir);
  opts.writeCooldown();
  log(`[auto-update] Success: updated ${exec.updated.join(', ')}, stealth ${postPassCount}/${postResult.checks.length}`);

  return { skipped: false, updated: exec.updated, verified: true };
}
