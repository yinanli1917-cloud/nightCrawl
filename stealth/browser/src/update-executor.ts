/**
 * Update executor — runs `bun add`, `bun install`, and
 * `bunx playwright install chromium` via an injectable subprocess
 * runner.
 *
 * Why a custom CommandRunner instead of just `Bun.spawn`?
 *   Tests need to verify the EXACT commands invoked without actually
 *   modifying the user's dependencies. The runner is a single seam
 *   that can be replaced in tests with a recorder, in production
 *   with `defaultRunner` (which wraps Bun.spawn).
 *
 * Functions:
 *   - installPackage(pkg, version)        — `bun add pkg@version`
 *   - installPlaywrightChromium()          — `bunx playwright install chromium`
 *   - bunInstallAll()                      — `bun install` (rollback path)
 *
 * Each returns { success, exitCode, stdout, stderr }. Never throws —
 * the auto-updater inspects success and decides what to do.
 *
 * [INPUT]: CommandRunner (default: Bun.spawn wrapper)
 * [OUTPUT]: install* functions, CommandRunner type, defaultRunner
 * [POS]: Subprocess layer for the auto-updater
 */

// ─── Types ──────────────────────────────────────────────────────

export interface RunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunnerOptions {
  cwd?: string;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  opts?: RunnerOptions,
) => Promise<RunnerResult>;

export interface ExecutorOptions {
  runner?: CommandRunner;
  cwd: string;
}

export interface ExecutorResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ─── Default runner (production) ────────────────────────────────

export const defaultRunner: CommandRunner = async (cmd, args, opts) => {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      cwd: opts?.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  } catch (err: any) {
    return { exitCode: -1, stdout: '', stderr: err?.message || String(err) };
  }
};

// ─── Helpers ────────────────────────────────────────────────────

async function run(
  cmd: string,
  args: string[],
  opts: ExecutorOptions,
): Promise<ExecutorResult> {
  const runner = opts.runner ?? defaultRunner;
  const result = await runner(cmd, args, { cwd: opts.cwd });
  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// ─── Public API ─────────────────────────────────────────────────

export function installPackage(
  pkg: string,
  version: string,
  opts: ExecutorOptions,
): Promise<ExecutorResult> {
  return run('bun', ['add', `${pkg}@${version}`], opts);
}

export function installPlaywrightChromium(
  opts: ExecutorOptions,
): Promise<ExecutorResult> {
  return run('bunx', ['playwright', 'install', 'chromium'], opts);
}

export function bunInstallAll(opts: ExecutorOptions): Promise<ExecutorResult> {
  return run('bun', ['install'], opts);
}
