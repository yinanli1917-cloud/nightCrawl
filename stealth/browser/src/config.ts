/**
 * Shared config for browse CLI + server.
 *
 * Resolution:
 *   1. BROWSE_STATE_FILE env → derive stateDir from parent (used by the CLI when
 *      it spawns the server, and by tests for isolation)
 *   2. otherwise → the GLOBAL ~/.nightcrawl/ (a single daemon per machine,
 *      independent of cwd / git root — see resolveConfig for why)
 *
 * The CLI computes the config and passes BROWSE_STATE_FILE to the
 * spawned server. The server derives all paths from that env var.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface BrowseConfig {
  projectDir: string;
  stateDir: string;
  stateFile: string;
  socketPath: string;
  storageFile: string;
  consoleLog: string;
  networkLog: string;
  dialogLog: string;
}

/**
 * Detect the git repository root, or null if not in a repo / git unavailable.
 */
export function getGitRoot(): string | null {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 2_000, // Don't hang if .git is broken
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve all browse config paths.
 *
 * If BROWSE_STATE_FILE is set (e.g. by CLI when spawning server, or by tests for
 * isolation), all paths are derived from it. Otherwise everything resolves to the
 * GLOBAL ~/.nightcrawl/ — a single daemon per machine, independent of cwd.
 */
export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): BrowseConfig {
  let stateFile: string;
  let stateDir: string;
  let projectDir: string;

  if (env.BROWSE_STATE_FILE) {
    stateFile = env.BROWSE_STATE_FILE;
    stateDir = path.dirname(stateFile);
    projectDir = path.dirname(stateDir); // parent of .nightcrawl/
  } else {
    // ── Single global daemon ──────────────────────────────────────────────
    // The state dir / socket / lock live under ~/.nightcrawl/ REGARDLESS of the
    // caller's git root or cwd. Scoping them per git-root was the root cause of
    // duplicate daemons: a call from project A and a call from project B hashed
    // different socket paths → two independent daemons → they fought over the ONE
    // shared Chromium profile (~/.nightcrawl/chromium-profile) and bridge port
    // 10087 → SingletonLock crash → 45s "Server failed to start" + goto timeouts.
    // A single global state dir means every project adopts the ONE daemon instead
    // of spawning a second. Tab isolation is keyed by the X-Nightcrawl-Session
    // header (session-id.ts), NOT by stateDir, so concurrent cross-project
    // sessions still each get their own tab in the one shared browser.
    stateDir = path.join(env.HOME || process.env.HOME || '/tmp', '.nightcrawl');
    projectDir = path.dirname(stateDir);
    stateFile = path.join(stateDir, 'browse.json');
  }

  // Socket path must be short — macOS sun_path limit is 104 bytes.
  // Use /tmp/ with a hash of the stateDir to keep it well under the limit.
  const { createHash } = require('crypto');
  const dirHash = createHash('md5').update(stateDir).digest('hex').slice(0, 8);
  const socketPath = `/tmp/nightcrawl-${dirHash}.sock`;

  return {
    projectDir,
    stateDir,
    stateFile,
    socketPath,
    storageFile: path.join(process.env.HOME || '/tmp', '.nightcrawl', 'browse-cookies.json'),
    consoleLog: path.join(stateDir, 'browse-console.log'),
    networkLog: path.join(stateDir, 'browse-network.log'),
    dialogLog: path.join(stateDir, 'browse-dialog.log'),
  };
}

/**
 * Create the .nightcrawl/ state directory if it doesn't exist.
 * Throws with a clear message on permission errors.
 */
export function ensureStateDir(config: BrowseConfig): void {
  // One-time migration from .gstack → .nightcrawl
  const oldStorage = path.join(process.env.HOME || '/tmp', '.gstack', 'browse-cookies.json');
  if (fs.existsSync(oldStorage) && !fs.existsSync(config.storageFile)) {
    const newDir = path.dirname(config.storageFile);
    fs.mkdirSync(newDir, { recursive: true });
    fs.copyFileSync(oldStorage, config.storageFile);
  }

  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
  } catch (err: any) {
    if (err.code === 'EACCES') {
      throw new Error(`Cannot create state directory ${config.stateDir}: permission denied`);
    }
    if (err.code === 'ENOTDIR') {
      throw new Error(`Cannot create state directory ${config.stateDir}: a file exists at that path`);
    }
    throw err;
  }

  // The global state dir (~/.nightcrawl) is not inside a project repo, so there
  // is nothing to gitignore — only maintain .gitignore for project-local
  // (BROWSE_STATE_FILE-scoped) state dirs.
  const homeDir = process.env.HOME || '/tmp';
  if (config.stateDir === path.join(homeDir, '.nightcrawl')) return;

  // Ensure .nightcrawl/ is in the project's .gitignore
  const gitignorePath = path.join(config.projectDir, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.match(/^\.nightcrawl\/?$/m)) {
      const separator = content.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(gitignorePath, `${separator}.nightcrawl/\n`);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      // Write warning to server log (visible even in daemon mode)
      const logPath = path.join(config.stateDir, 'browse-server.log');
      try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Warning: could not update .gitignore at ${gitignorePath}: ${err.message}\n`);
      } catch {
        // stateDir write failed too — nothing more we can do
      }
    }
    // ENOENT (no .gitignore) — skip silently
  }
}

/**
 * Derive a slug from the git remote origin URL (owner-repo format).
 * Falls back to the directory basename if no remote is configured.
 */
export function getRemoteSlug(): string {
  try {
    const proc = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 2_000,
    });
    if (proc.exitCode !== 0) throw new Error('no remote');
    const url = proc.stdout.toString().trim();
    // SSH:   git@github.com:owner/repo.git → owner-repo
    // HTTPS: https://github.com/owner/repo.git → owner-repo
    const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) return `${match[1]}-${match[2]}`;
    throw new Error('unparseable');
  } catch {
    const root = getGitRoot();
    return path.basename(root || process.cwd());
  }
}

/**
 * Read the binary version (git SHA) from browse/dist/.version.
 * Returns null if the file doesn't exist or can't be read.
 */
export function readVersionHash(execPath: string = process.execPath): string | null {
  try {
    const versionFile = path.resolve(path.dirname(execPath), '.version');
    return fs.readFileSync(versionFile, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read a single value from ~/.nightcrawl/state/config.yaml.
 *
 * Matches the format used by the bash `nightcrawl-config get` script:
 * one `key: value` per line, comments and blank lines ignored.
 *
 * Returns null if the file or key doesn't exist.
 */
export function readConfigValue(key: string): string | null {
  try {
    const home = process.env.HOME || '/tmp';
    const cfgPath = path.join(home, '.nightcrawl', 'state', 'config.yaml');
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}:\\s*(.+?)\\s*$`, 'm');
    const match = raw.match(re);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}
