/**
 * nightCrawl CLI — thin wrapper that talks to the persistent server
 *
 * Flow:
 *   1. Read .nightcrawl/browse.json for port + token
 *   2. If missing or stale PID → start server in background
 *   3. Health check + version mismatch detection
 *   4. Send command via HTTP POST
 *   5. Print response to stdout (or stderr for errors)
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveConfig, ensureStateDir, readVersionHash } from './config';
import { findInstalledBrowsers } from './cookie-import-browser';
import { notifyWithAction } from './notify';
import { resolveSessionId, SESSION_HEADER } from './session-id';
import { renderLauncher, chooseInstallDir } from './launcher';
import { classifyStartup, READY_TIMEOUT_MS, type StartupSnapshot } from './daemon-readiness';
import * as os from 'os';

const config = resolveConfig();
const IS_WINDOWS = process.platform === 'win32';

export function resolveServerScript(
  env: Record<string, string | undefined> = process.env,
  metaDir: string = import.meta.dir,
  execPath: string = process.execPath
): string {
  if (env.BROWSE_SERVER_SCRIPT) {
    return env.BROWSE_SERVER_SCRIPT;
  }

  // Dev mode: cli.ts runs directly from browse/src
  // On macOS/Linux, import.meta.dir starts with /
  // On Windows, it starts with a drive letter (e.g., C:\...)
  if (!metaDir.includes('$bunfs')) {
    const direct = path.resolve(metaDir, 'server.ts');
    if (fs.existsSync(direct)) {
      return direct;
    }
  }

  // Compiled binary: derive the source tree from browse/dist/browse
  if (execPath) {
    const adjacent = path.resolve(path.dirname(execPath), '..', 'src', 'server.ts');
    if (fs.existsSync(adjacent)) {
      return adjacent;
    }
  }

  throw new Error(
    'Cannot find server.ts. Set BROWSE_SERVER_SCRIPT env or run from the browse source tree.'
  );
}

const SERVER_SCRIPT = resolveServerScript();

/**
 * On Windows, resolve the Node.js-compatible server bundle.
 * Falls back to null if not found (server will use Bun instead).
 */
export function resolveNodeServerScript(
  metaDir: string = import.meta.dir,
  execPath: string = process.execPath
): string | null {
  // Dev mode
  if (!metaDir.includes('$bunfs')) {
    const distScript = path.resolve(metaDir, '..', 'dist', 'server-node.mjs');
    if (fs.existsSync(distScript)) return distScript;
  }

  // Compiled binary: browse/dist/browse → browse/dist/server-node.mjs
  if (execPath) {
    const adjacent = path.resolve(path.dirname(execPath), 'server-node.mjs');
    if (fs.existsSync(adjacent)) return adjacent;
  }

  return null;
}

const NODE_SERVER_SCRIPT = IS_WINDOWS ? resolveNodeServerScript() : null;

// On Windows, hard-fail if server-node.mjs is missing — the Bun path is known broken.
if (IS_WINDOWS && !NODE_SERVER_SCRIPT) {
  throw new Error(
    'server-node.mjs not found. Run `bun run build` to generate the Windows server bundle.'
  );
}

interface ServerState {
  pid: number;
  port: number;
  socket?: string;
  token: string;
  startedAt: string;
  serverPath: string;
  binaryVersion?: string;
  mode?: 'launched' | 'headed';
}

// ─── UDS/TCP Transport Helpers ──────────────────────────────────
function serverUrl(state: ServerState, pathname: string): string {
  // When using UDS, hostname is ignored by Bun — use a placeholder
  if (state.socket) return `http://localhost${pathname}`;
  return `http://127.0.0.1:${state.port}${pathname}`;
}

function fetchOptions(state: ServerState): Record<string, any> {
  if (state.socket) return { unix: state.socket };
  return {};
}

// ─── State File ────────────────────────────────────────────────
function readState(): ServerState | null {
  try {
    const data = fs.readFileSync(config.stateFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Scan /tmp for nightcrawl socket files belonging to daemons that were NOT
 * started by this CLI invocation (i.e. have a different socket hash).
 *
 * If a healthy orphan is found, the CLI adopts it by writing its state to
 * our stateFile. This prevents duplicate daemons when the server was started
 * manually from a different directory (different git root → different socket).
 *
 * Discovery protocol:
 *   1. GET /health (unauthenticated) → includes stateFile path
 *   2. Read that stateFile (0o600, owner-only) → contains token
 *   3. Adopt: write state to our config.stateFile for future CLI invocations
 */
async function findAndAdoptOrphan(): Promise<ServerState | null> {
  if (IS_WINDOWS) return null; // no UDS sockets on Windows
  const ourSocket = config.socketPath;
  let tmpFiles: string[];
  try {
    tmpFiles = fs.readdirSync('/tmp');
  } catch {
    return null;
  }
  const sockets = tmpFiles
    .filter(f => f.startsWith('nightcrawl-') && f.endsWith('.sock'))
    .map(f => `/tmp/${f}`)
    .filter(s => s !== ourSocket);

  for (const sock of sockets) {
    try {
      const resp = await fetch('http://localhost/health', {
        unix: sock,
        signal: AbortSignal.timeout(2000),
      } as any);
      if (!resp.ok) continue;
      const health = await resp.json() as any;
      if (health.status !== 'healthy' || !health.stateFile) continue;

      // Read the orphan's stateFile (0o600 — only our user can read it)
      let orphanState: ServerState;
      try {
        orphanState = JSON.parse(fs.readFileSync(health.stateFile, 'utf-8'));
      } catch {
        continue; // Different user or missing file — skip
      }
      if (!orphanState.token || !orphanState.socket) continue;

      console.error(
        `[browse] Adopting existing daemon (PID ${orphanState.pid}) at ${sock}` +
        ` — was started outside the project directory.`,
      );
      // Persist adoption so future CLI calls find it without scanning
      try {
        fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
        const tmpFile = config.stateFile + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(orphanState, null, 2), { mode: 0o600 });
        fs.renameSync(tmpFile, config.stateFile);
      } catch {
        // Best effort — we can still use the adopted state in-memory
      }
      return orphanState;
    } catch {
      // Dead socket or connection refused — skip
    }
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  if (IS_WINDOWS) {
    // Bun's compiled binary can't signal Windows PIDs (always throws ESRCH).
    // Use tasklist as a fallback. Only for one-shot calls — too slow for polling loops.
    try {
      const result = Bun.spawnSync(
        ['tasklist', '/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
        { stdout: 'pipe', stderr: 'pipe', timeout: 3000 }
      );
      return result.stdout.toString().includes(`"${pid}"`);
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * HTTP health check — definitive proof the server is alive and responsive.
 * Supports both UDS (socket path) and TCP (port) transports.
 */
function isLocalSocketPermissionError(err: any): boolean {
  return err?.code === 'EACCES' || err?.code === 'EPERM';
}

function sandboxSocketDeniedMessage(err: any): string {
  const code = err?.code || 'UNKNOWN';
  return `[browse] Cannot start or restart nightCrawl here: ${code}. ` +
    `This local execution environment denied server sockets. ` +
    `Run nightCrawl through an approved launcher or outside the sandbox.`;
}

async function assertCanStartLocalServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const srv = require('net').createServer();
    srv.once('error', (err: any) => {
      if (isLocalSocketPermissionError(err)) {
        reject(new Error(sandboxSocketDeniedMessage(err)));
        return;
      }
      resolve();
    });
    srv.listen(0, '127.0.0.1', () => {
      srv.close(() => resolve());
    });
  });
}

export async function isServerHealthy(portOrState: number | ServerState): Promise<boolean> {
  try {
    const state: ServerState = typeof portOrState === 'number'
      ? { pid: 0, port: portOrState, token: '', startedAt: '', serverPath: '' }
      : portOrState;
    const resp = await fetch(serverUrl(state, '/health'), {
      ...fetchOptions(state),
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;
    const health = await resp.json() as any;
    return health.status === 'healthy';
  } catch {
    return false;
  }
}

// ─── Process Management ─────────────────────────────────────────
async function killServer(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;

  if (IS_WINDOWS) {
    // taskkill /T /F kills the process tree (Node + Chromium)
    try {
      Bun.spawnSync(
        ['taskkill', '/PID', String(pid), '/T', '/F'],
        { stdout: 'pipe', stderr: 'pipe', timeout: 5000 }
      );
    } catch {}
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await Bun.sleep(100);
    }
    return;
  }

  try { process.kill(pid, 'SIGTERM'); } catch { return; }

  // Wait up to 2s for graceful shutdown
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await Bun.sleep(100);
  }

  // Force kill if still alive
  if (isProcessAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

/**
 * Clean up legacy /tmp/browse-server*.json files from before project-local state.
 * Verifies PID ownership before sending signals.
 */
function cleanupLegacyState(): void {
  // No legacy state on Windows — /tmp and `ps` don't exist, and nightCrawl
  // never ran on Windows before the Node.js fallback was added.
  if (IS_WINDOWS) return;

  try {
    const files = fs.readdirSync('/tmp').filter(f => f.startsWith('browse-server') && f.endsWith('.json'));
    for (const file of files) {
      const fullPath = `/tmp/${file}`;
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        if (data.pid && isProcessAlive(data.pid)) {
          // Verify this is actually a browse server before killing
          const check = Bun.spawnSync(['ps', '-p', String(data.pid), '-o', 'command='], {
            stdout: 'pipe', stderr: 'pipe', timeout: 2000,
          });
          const cmd = check.stdout.toString().trim();
          if (cmd.includes('bun') || cmd.includes('server.ts')) {
            try { process.kill(data.pid, 'SIGTERM'); } catch {}
          }
        }
        fs.unlinkSync(fullPath);
      } catch {
        // Best effort — skip files we can't parse or clean up
      }
    }
    // Clean up legacy log files too
    const logFiles = fs.readdirSync('/tmp').filter(f =>
      f.startsWith('browse-console') || f.startsWith('browse-network') || f.startsWith('browse-dialog')
    );
    for (const file of logFiles) {
      try { fs.unlinkSync(`/tmp/${file}`); } catch {}
    }
  } catch {
    // /tmp read failed — skip legacy cleanup
  }
}

// ─── Server Lifecycle ──────────────────────────────────────────
async function startServer(extraEnv?: Record<string, string>): Promise<ServerState> {
  ensureStateDir(config);

  // Clean up stale state file and error log
  try { fs.unlinkSync(config.stateFile); } catch {}
  try { fs.unlinkSync(path.join(config.stateDir, 'browse-startup-error.log')); } catch {}

  let proc: any = null;

  if (IS_WINDOWS && NODE_SERVER_SCRIPT) {
    // Windows: Bun.spawn() + proc.unref() doesn't truly detach on Windows —
    // when the CLI exits, the server dies with it. Use Node's child_process.spawn
    // with { detached: true } instead, which is the gold standard for Windows
    // process independence. Credit: PR #191 by @fqueiro.
    const launcherCode =
      `const{spawn}=require('child_process');` +
      `spawn(process.execPath,[${JSON.stringify(NODE_SERVER_SCRIPT)}],` +
      `{detached:true,stdio:['ignore','ignore','ignore'],env:Object.assign({},process.env,` +
      `{BROWSE_STATE_FILE:${JSON.stringify(config.stateFile)}})}).unref()`;
    Bun.spawnSync(['node', '-e', launcherCode], { stdio: ['ignore', 'ignore', 'ignore'] });
  } else {
    // macOS/Linux: Use shell nohup to fully detach the server process.
    // Bun.spawn + unref() doesn't truly detach — Bun kills child processes
    // on parent exit regardless of unref. Shell-level detachment works.
    const envStr = Object.entries({ ...process.env, BROWSE_STATE_FILE: config.stateFile, ...extraEnv })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    Bun.spawnSync(['sh', '-c', `nohup env ${envStr} bun run ${JSON.stringify(SERVER_SCRIPT)} </dev/null >/dev/null 2>&1 &`], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, BROWSE_STATE_FILE: config.stateFile, ...extraEnv },
    });
  }

  // Wait for the server to become healthy. A cold CloakBrowser boot can take well
  // over 8s, so we wait up to READY_TIMEOUT_MS — but classifyStartup fails FAST the
  // moment the daemon dies or logs an error, so a real failure never waits the whole
  // budget (the "Server failed to start within 8s" churn from the Cursor-course run).
  const start = Date.now();
  let lastError = '';
  while (Date.now() - start < READY_TIMEOUT_MS) {
    const state = readState();
    const errLog = startupErrorLog();
    if (errLog) lastError = errLog;
    const snap: StartupSnapshot = {
      healthy: state ? await isServerHealthy(state) : false,
      errorLogged: !!errLog,
    };
    const status = classifyStartup(snap);
    if (status === 'ready') return state!;
    if (status === 'failed') break;
    await Bun.sleep(100);
  }

  if (lastError) throw new Error(`Server failed to start:\n${lastError}`);
  throw new Error(`Server failed to start within ${Math.round((Date.now() - start) / 1000)}s`);
}

/** Contents of the daemon's startup-error log, or '' if none. */
function startupErrorLog(): string {
  try {
    return fs.readFileSync(path.join(config.stateDir, 'browse-startup-error.log'), 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Acquire an exclusive lockfile to prevent concurrent ensureServer() races (TOCTOU).
 * Returns a cleanup function that releases the lock.
 */
function acquireServerLock(): (() => void) | null {
  const lockPath = `${config.stateFile}.lock`;
  try {
    // 'wx' — create exclusively, fails if file already exists (atomic check-and-create)
    // Using string flag instead of numeric constants for Bun Windows compatibility
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    return () => { try { fs.unlinkSync(lockPath); } catch {} };
  } catch {
    // Lock already held — check if the holder is still alive
    try {
      const holderPid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
      if (holderPid && isProcessAlive(holderPid)) {
        return null; // Another live process holds the lock
      }
      // Stale lock — remove and retry
      fs.unlinkSync(lockPath);
      return acquireServerLock();
    } catch {
      return null;
    }
  }
}

async function ensureServer(): Promise<ServerState> {
  const state = readState();

  // Health-check-first: HTTP is definitive proof the server is alive and responsive.
  // This replaces the PID-gated approach which breaks on Windows (Bun's process.kill
  // always throws ESRCH for Windows PIDs in compiled binaries).
  if (state && await isServerHealthy(state)) {
    // Check for binary version mismatch (auto-restart on update)
    const currentVersion = readVersionHash();
    if (currentVersion && state.binaryVersion && currentVersion !== state.binaryVersion) {
      console.error('[browse] Binary updated, restarting server...');
      await killServer(state.pid);
      return startServer();
    }
    return state;
  }

  // Guard: never silently replace a headed server with a headless one.
  // Headed mode means a user-visible Chrome window is (or was) controlled.
  // Silently replacing it would be confusing — tell the user to reconnect.
  if (state && state.mode === 'headed' && isProcessAlive(state.pid)) {
    console.error(`[browse] Headed server running (PID ${state.pid}) but not responding.`);
    console.error(`[browse] Run '$B connect' to restart.`);
    process.exit(1);
  }

  // Orphan detection: before spawning a brand-new daemon, check whether a
  // healthy nightcrawl process is already running under a different socket
  // (i.e. started from a directory with a different git root, or started
  // manually outside the CLI). Adopting it avoids duplicate daemons and
  // preserves any authenticated sessions (cookies, doubao login, etc.).
  const orphan = await findAndAdoptOrphan();
  if (orphan) return orphan;

  // Ensure state directory exists before lock acquisition (lock file lives there)
  ensureStateDir(config);

  // Acquire lock to prevent concurrent restart races (TOCTOU)
  const releaseLock = acquireServerLock();
  if (!releaseLock) {
    // Another process is starting the server — wait for it. Same patient budget as a
    // cold boot, but bail early if that starter died without ever becoming healthy.
    console.error('[browse] Another instance is starting the server, waiting...');
    const start = Date.now();
    while (Date.now() - start < READY_TIMEOUT_MS) {
      const freshState = readState();
      const snap: StartupSnapshot = {
        healthy: freshState ? await isServerHealthy(freshState) : false,
        errorLogged: !!startupErrorLog(),
      };
      const status = classifyStartup(snap);
      if (status === 'ready') return freshState!;
      if (status === 'failed') break;
      await Bun.sleep(200);
    }
    throw new Error('Timed out waiting for another instance to start the server');
  }

  try {
    // Re-read state under lock in case another process just started the server
    const freshState = readState();
    if (freshState && await isServerHealthy(freshState)) {
      return freshState;
    }

    // If this environment cannot create local server sockets, fail before
    // deleting state or killing an outside-sandbox daemon that may be healthy.
    await assertCanStartLocalServer();

    // Kill the old server to avoid orphaned chromium processes
    if (state && state.pid) {
      await killServer(state.pid);
    }
    console.error('[browse] Starting server...');
    return await startServer();
  } finally {
    releaseLock();
  }
}

// ─── Command Dispatch ──────────────────────────────────────────
// Engine selection chosen by the agent via --engine / --force. Module-scoped so
// the single sendCommand path can attach them to the /command body. Default
// 'auto' lets the daemon advise; the agent overrides per call.
let cliEngine: 'auto' | 'headless' | 'real' = 'auto';
let cliForce = false;

// Session identity for THIS client process (one per agent window/run). Resolved
// once and attached to every command so the daemon scopes tabs per session.
// See session-id.ts for the data-driven source registry.
const SESSION_ID = resolveSessionId();

async function sendCommand(state: ServerState, command: string, args: string[], retries = 0): Promise<void> {
  const body = JSON.stringify({ command, args, engine: cliEngine, force: cliForce });

  try {
    const resp = await fetch(serverUrl(state, '/command'), {
      ...fetchOptions(state),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
        [SESSION_HEADER]: SESSION_ID,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });

    if (resp.status === 401) {
      // Token mismatch — server may have restarted
      console.error('[browse] Auth failed — server may have restarted. Retrying...');
      const newState = readState();
      if (newState && newState.token !== state.token) {
        return sendCommand(newState, command, args);
      }
      throw new Error('Authentication failed');
    }

    const text = await resp.text();

    if (resp.ok) {
      process.stdout.write(text);
      if (!text.endsWith('\n')) process.stdout.write('\n');
    } else {
      // Try to parse as JSON error
      try {
        const err = JSON.parse(text);
        console.error(err.error || text);
        if (err.hint) console.error(err.hint);
      } catch {
        console.error(text);
      }
      process.exit(1);
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.error('[browse] Command timed out after 30s');
      process.exit(1);
    }
    // Connection error — server may have crashed
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.message?.includes('fetch failed')) {
      if (retries >= 1) throw new Error('[browse] Server crashed twice in a row — aborting');
      console.error('[browse] Server connection lost. Restarting...');
      // Kill the old server to avoid orphaned chromium processes
      const oldState = readState();
      if (oldState && oldState.pid) {
        await killServer(oldState.pid);
      }
      const newState = await startServer();
      return sendCommand(newState, command, args, retries + 1);
    }
    throw err;
  }
}

// ─── First-Run Onboarding ─────────────────────────────────────
function showWelcome(): void {
  const globalDir = path.join(process.env.HOME || '/tmp', '.nightcrawl');
  const welcomeFlag = path.join(globalDir, '.welcomed');
  if (fs.existsSync(welcomeFlag)) return;

  // Mark as shown first — even if the message fails, don't nag
  try {
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(welcomeFlag, new Date().toISOString());
  } catch {}

  const browsers = findInstalledBrowsers();
  const names = browsers.map(b => b.name);

  console.error('');
  console.error('  Welcome to nightCrawl.');
  console.error('');
  console.error('  Tip: Import cookies from your browser so nightCrawl can access');
  console.error('  sites you\'re already logged into:');
  console.error('');
  if (names.length > 0) {
    console.error(`    Detected: ${names.join(', ')}`);
    console.error('');
    console.error(`    browse cookie-import-browser ${names[0].toLowerCase()} --domain <site>`);
    console.error('    browse cookie-import-browser    (interactive picker)');
  } else {
    console.error('    browse cookie-import-browser    (interactive picker)');
  }
  console.error('');
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`nightCrawl — Fast headless browser for AI coding agents

Usage: browse <command> [args...]

Navigation:     goto <url> | back | forward | reload | url
Content:        text | html [sel] | links | forms | accessibility
Interaction:    click <sel> | fill <sel> <val> | select <sel> <val>
                hover <sel> | type <text> | press <key>
                scroll [sel] | wait <sel|--networkidle|--load> | viewport <WxH>
                upload <sel> <file1> [file2...]
                cookie-import <json-file>
                cookie-import-browser [browser] [--domain <d>]
Inspection:     js <expr> | eval <file> | css <sel> <prop> | attrs <sel>
                console [--clear|--errors] | network [--clear] | dialog [--clear]
                cookies | storage [set <k> <v>] | perf
                is <prop> <sel> (visible|hidden|enabled|disabled|checked|editable|focused)
Visual:         screenshot [--viewport] [--clip x,y,w,h] [@ref|sel] [path]
                pdf [path] | responsive [prefix]
Snapshot:       snapshot [-i] [-c] [-d N] [-s sel] [-D] [-a] [-o path] [-C]
                -D/--diff: diff against previous snapshot
                -a/--annotate: annotated screenshot with ref labels
                -C/--cursor-interactive: find non-ARIA clickable elements
Compare:        diff <url1> <url2>
Multi-step:     chain (reads JSON from stdin)
Tabs:           tabs | tab <id> | newtab [url] | closetab [id]
Server:         status | cookie <n>=<v> | header <n>:<v>
                useragent <str> | stop | restart
                sync (status|now)
Setup:          install (drop a browse launcher on PATH — no per-call env setup)
Dialogs:        dialog-accept [text] | dialog-dismiss

Refs:           After 'snapshot', use @e1, @e2... as selectors:
                click @e3 | fill @e4 "value" | hover @e1
                @c refs from -C: click @c1`);
    process.exit(0);
  }

  // One-time cleanup of legacy /tmp state files
  cleanupLegacyState();

  const command = args[0];
  let commandArgs = args.slice(1);

  // ─── Engine selection flags (agent-decided routing) ─────────
  // --engine=auto|headless|real (default auto), --force to deliberately go
  // against a strong recommendation. Stripped here so they never reach the
  // command handler as positional args; carried to the server in the body.
  commandArgs = commandArgs.filter((a) => {
    const m = /^--engine=(auto|headless|real)$/.exec(a);
    if (m) { cliEngine = m[1] as typeof cliEngine; return false; }
    if (a === '--force') { cliForce = true; return false; }
    return true;
  });

  // ─── Install launcher (client-only, pre-server) ─────────────
  // Drops a `browse`/`nightcrawl` launcher on PATH so a stateless shell can call
  // commands with NO per-call `export PATH/NC` + `nc()` block (A5). `nc` is NOT
  // installed — it would shadow netcat; suggest an alias instead.
  if (command === 'install') {
    const home = os.homedir();
    const cliPath = path.join(import.meta.dir, 'cli.ts');
    const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const candidates = [path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin')];
    const fallback = path.join(home, '.nightcrawl', 'bin');
    const isWritable = (d: string): boolean => {
      try {
        if (fs.existsSync(d)) { fs.accessSync(d, fs.constants.W_OK); return true; }
        fs.accessSync(path.dirname(d), fs.constants.W_OK); // can we create it?
        return true;
      } catch { return false; }
    };
    const choice = chooseInstallDir(pathEntries, candidates, fallback, isWritable);
    fs.mkdirSync(choice.dir, { recursive: true });
    const script = renderLauncher(process.execPath, cliPath);
    for (const name of ['browse', 'nightcrawl']) {
      const dest = path.join(choice.dir, name);
      fs.writeFileSync(dest, script, { mode: 0o755 });
      fs.chmodSync(dest, 0o755);
    }
    console.log(`Installed launcher: browse, nightcrawl → ${choice.dir}`);
    if (choice.onPath) {
      console.log('Ready: run `browse goto <url>` from any shell — no setup needed.');
    } else {
      console.log(`\n${choice.dir} is not on your PATH. Add it once:`);
      console.log(`  export PATH="${choice.dir}:$PATH"`);
    }
    console.log('(tip: `alias nc=browse` for the short name — `nc` is not installed to avoid shadowing netcat.)');
    process.exit(0);
  }

  // ─── Headed Connect (pre-server command) ────────────────────
  // connect must be handled BEFORE ensureServer() because it needs
  // to restart the server in headed mode with the Chrome extension.
  if (command === 'connect') {
    // Check if already in headed mode and healthy
    const existingState = readState();
    if (existingState && existingState.mode === 'headed' && isProcessAlive(existingState.pid)) {
      try {
        const resp = await fetch(serverUrl(existingState, '/health'), {
          ...fetchOptions(existingState),
          signal: AbortSignal.timeout(2000),
        });
        if (resp.ok) {
          console.log('Already connected in headed mode.');
          process.exit(0);
        }
      } catch {
        // Headed server alive but not responding — kill and restart
      }
    }

    const approval = await notifyWithAction(
      'nightCrawl handoff',
      'Open the headed digital-twin browser and sync cookies from your default browser first?',
      { label: 'Open Browser', onClick: ':' },
    );
    if (approval !== 'approved') {
      console.log('Connect cancelled. No headed browser opened.');
      process.exit(0);
    }

    // Kill ANY existing server (SIGTERM → wait 2s → SIGKILL)
    if (existingState && isProcessAlive(existingState.pid)) {
      try { process.kill(existingState.pid, 'SIGTERM'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (isProcessAlive(existingState.pid)) {
        try { process.kill(existingState.pid, 'SIGKILL'); } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Kill orphaned Chromium processes that may still hold the profile lock.
    // The server PID is the Bun process; Chromium is a child that can outlive it
    // if the server is killed abruptly (SIGKILL, crash, manual rm of state file).
    const profileDir = path.join(process.env.HOME || '/tmp', '.nightcrawl', 'chromium-profile');
    try {
      const singletonLock = path.join(profileDir, 'SingletonLock');
      const lockTarget = fs.readlinkSync(singletonLock); // e.g. "hostname-12345"
      const orphanPid = parseInt(lockTarget.split('-').pop() || '', 10);
      if (orphanPid && isProcessAlive(orphanPid)) {
        try { process.kill(orphanPid, 'SIGTERM'); } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (isProcessAlive(orphanPid)) {
          try { process.kill(orphanPid, 'SIGKILL'); } catch {}
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } catch {
      // No lock symlink or not readable — nothing to kill
    }

    // Clean up Chromium profile locks (can persist after crashes)
    for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.unlinkSync(path.join(profileDir, lockFile)); } catch {}
    }

    // Delete stale state file
    try { fs.unlinkSync(config.stateFile); } catch {}

    console.log('Launching headed Chromium with extension + sidebar agent...');
    try {
      // Start server in headed mode with extension auto-loaded
      // Use a well-known port so the Chrome extension auto-connects
      const serverEnv: Record<string, string> = {
        BROWSE_HEADED: '1',
        BROWSE_PORT: '34567',
        BROWSE_SIDEBAR_CHAT: '1',
      };
      const newState = await startServer(serverEnv);

      // Print connected status
      const resp = await fetch(serverUrl(newState, '/command'), {
        ...fetchOptions(newState),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${newState.token}`,
        },
        body: JSON.stringify({ command: 'status', args: [] }),
        signal: AbortSignal.timeout(5000),
      });
      const status = await resp.text();
      console.log(`Connected to real Chrome\n${status}`);

      // Auto-start sidebar agent
      // __dirname is inside $bunfs in compiled binaries — resolve from execPath instead
      let agentScript = path.resolve(__dirname, 'sidebar-agent.ts');
      if (!fs.existsSync(agentScript)) {
        agentScript = path.resolve(path.dirname(process.execPath), '..', 'src', 'sidebar-agent.ts');
      }
      try {
        if (!fs.existsSync(agentScript)) {
          throw new Error(`sidebar-agent.ts not found at ${agentScript}`);
        }
        // Clear old agent queue
        const agentQueue = path.join(process.env.HOME || '/tmp', '.nightcrawl', 'sidebar-agent-queue.jsonl');
        try { fs.writeFileSync(agentQueue, ''); } catch {}

        // Resolve browse binary path the same way — execPath-relative
        let browseBin = path.resolve(__dirname, '..', 'dist', 'browse');
        if (!fs.existsSync(browseBin)) {
          browseBin = process.execPath; // the compiled binary itself
        }

        // Kill any existing sidebar-agent processes before starting a new one.
        // Old agents have stale auth tokens and will silently fail to relay events,
        // causing the server to mark the agent as "hung".
        try {
          const { spawnSync } = require('child_process');
          spawnSync('pkill', ['-f', 'sidebar-agent\\.ts'], { stdio: 'ignore', timeout: 3000 });
        } catch {}

        const agentProc = Bun.spawn(['bun', 'run', agentScript], {
          cwd: config.projectDir,
          env: {
            ...process.env,
            BROWSE_BIN: browseBin,
            BROWSE_STATE_FILE: config.stateFile,
            BROWSE_SERVER_PORT: String(newState.port),
          },
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        agentProc.unref();
        console.log(`[browse] Sidebar agent started (PID: ${agentProc.pid})`);
      } catch (err: any) {
        console.error(`[browse] Sidebar agent failed to start: ${err.message}`);
        console.error(`[browse] Run manually: bun run ${agentScript}`);
      }
    } catch (err: any) {
      console.error(`[browse] Connect failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // ─── Stop (pre-server command) ───────────────────────────────
  // stop must not auto-start a daemon just to shut it down. This matters in
  // restricted agent sandboxes where server socket creation is denied.
  if (command === 'stop') {
    const existingState = readState();
    if (!existingState) {
      console.log('nightCrawl is not running.');
      process.exit(0);
    }

    try {
      const resp = await fetch(serverUrl(existingState, '/command'), {
        ...fetchOptions(existingState),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${existingState.token}`,
        },
        body: JSON.stringify({ command: 'stop', args: [] }),
        signal: AbortSignal.timeout(3000),
      });
      const text = await resp.text();
      if (text) console.log(text);
      process.exit(resp.ok ? 0 : 1);
    } catch {
      if (existingState.pid && isProcessAlive(existingState.pid)) {
        try { process.kill(existingState.pid, 'SIGTERM'); } catch {}
      }
      try { fs.unlinkSync(config.stateFile); } catch {}
      if (existingState.socket) { try { fs.unlinkSync(existingState.socket); } catch {} }
      console.log('nightCrawl was not responding; cleaned stale state.');
      process.exit(0);
    }
  }

  // ─── Headed Disconnect (pre-server command) ─────────────────
  // disconnect must be handled BEFORE ensureServer() because the headed
  // guard blocks all commands when the server is unresponsive.
  if (command === 'disconnect') {
    const existingState = readState();
    if (!existingState || existingState.mode !== 'headed') {
      console.log('Not in headed mode — nothing to disconnect.');
      process.exit(0);
    }
    // Try graceful shutdown via server
    try {
      const resp = await fetch(serverUrl(existingState, '/command'), {
        ...fetchOptions(existingState),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${existingState.token}`,
        },
        body: JSON.stringify({ command: 'disconnect', args: [] }),
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        console.log('Disconnected from real browser.');
        process.exit(0);
      }
    } catch {
      // Server not responding — force cleanup
    }
    // Force kill + cleanup
    if (isProcessAlive(existingState.pid)) {
      try { process.kill(existingState.pid, 'SIGTERM'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (isProcessAlive(existingState.pid)) {
        try { process.kill(existingState.pid, 'SIGKILL'); } catch {}
      }
    }
    // Clean profile locks and state file
    const profileDir = path.join(process.env.HOME || '/tmp', '.nightcrawl', 'chromium-profile');
    for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.unlinkSync(path.join(profileDir, lockFile)); } catch {}
    }
    try { fs.unlinkSync(config.stateFile); } catch {}
    console.log('Disconnected (server was unresponsive — force cleaned).');
    process.exit(0);
  }

  // Special case: chain reads from stdin
  if (command === 'chain' && commandArgs.length === 0) {
    const stdin = await Bun.stdin.text();
    commandArgs.push(stdin.trim());
  }

  const state = await ensureServer();
  showWelcome();
  await sendCommand(state, command, commandArgs);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[browse] ${err.message}`);
    process.exit(1);
  });
}
