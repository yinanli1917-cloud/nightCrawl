/**
 * [INPUT]: A failure at a CLI or daemon chokepoint (message/stack/command/url),
 *          plus the failing session's BrowseConfig for reading live logs.
 * [OUTPUT]: recordFailure() — durable append to the GLOBAL failures.jsonl, a
 *           diagnostic bundle, and (for real tool bugs only, deduped) a new
 *           Codex investigation task in the nightCrawl project + a notification.
 * [POS]: The "no silent failures" layer. NightCrawl is used from any project on
 *        the machine; when it breaks there, the failure must be collected once
 *        and turned into a reproducible investigation, not lost to /dev/null.
 *
 * Mirrors engine-journal.ts idioms: never throws (telemetry must not break
 * navigation), 0o600 append, 5000-line prune, malformed-line-tolerant reads.
 * Data-driven classification (SIGNALS table), NOT per-failure if/else branches.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { eTldPlusOne } from './handoff-consent';
import type { BrowseConfig } from './config';

// ─── Types ───────────────────────────────────────────────────

export type FailureFamily = 'daemon-unavailable' | 'env' | 'site' | 'unknown';

export interface FailureSignal {
  category: string;
  pattern: RegExp;
  family: FailureFamily;
  /** Real tool bug worth an investigation task? Site walls/errors are false. */
  actionable: boolean;
}

export interface FailureInput {
  layer: 'cli' | 'daemon';
  message: string;
  stack?: string;
  command?: string;
  args?: string[];
  url?: string;
  /** Explicit category from the caller (e.g. daemon 'daemon-fatal') — wins over text. */
  hintCategory?: string;
  /** Where the failure surfaced: '500' | 'timeout' | 'global' | 'uncaught' | 'startup' … */
  exitContext?: string;
  /** The failing session's config, for reading its live log files. */
  config?: BrowseConfig;
  env?: Record<string, string | undefined>;
}

export interface FailureRecord {
  ts: number;
  layer: string;
  category: string;
  family: FailureFamily;
  actionable: boolean;
  domain?: string;
  signature: string;
  message: string;
  command?: string;
  args?: string[];
  exitContext?: string;
  bundleDir?: string;
}

// ─── Constants ───────────────────────────────────────────────

const MAX_FAILURE_LINES = 5000;
// One spree = one task within this window; a genuinely new problem later files
// fresh (mirrors the recency thinking in engine-journal / domain-strategy).
const TASK_DEDUP_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_MESSAGE_LEN = 2000;

/**
 * Ordered signal table — FIRST match wins, so put the specific daemon signals
 * before the generic ones. Add a new failure kind as ONE row here; the family
 * decides dedup coarseness and `actionable` decides record-only vs file-a-task.
 * "Real tool bugs only" = daemon-unavailable + env + unknown are actionable;
 * site walls/errors are expected behavior → recorded for stats, never a task.
 */
const SIGNALS: FailureSignal[] = [
  // ── daemon-unavailable: the tool itself is down. Coarse signature collapses a
  //    whole spree (many commands, both process layers) into ONE task. ──
  { category: 'port-in-use', pattern: /port \d+ (is )?in use|EADDRINUSE|address already in use/i, family: 'daemon-unavailable', actionable: true },
  { category: 'startup-timeout', pattern: /server failed to start/i, family: 'daemon-unavailable', actionable: true },
  { category: 'startup-failure', pattern: /failed to (launch|initialize|boot)/i, family: 'daemon-unavailable', actionable: true },
  { category: 'daemon-fatal', pattern: /FATAL (uncaught|unhandled)/i, family: 'daemon-unavailable', actionable: true },
  { category: 'conn-lost', pattern: /server (connection lost|crashed)|ECONNREFUSED|ECONNRESET|fetch failed/i, family: 'daemon-unavailable', actionable: true },
  { category: 'no-active-page', pattern: /no active page/i, family: 'daemon-unavailable', actionable: true },
  { category: 'command-timeout', pattern: /timed out|operation timed out|AbortError/i, family: 'daemon-unavailable', actionable: true },

  // ── env: host is missing something NightCrawl needs. Real, host-scoped. ──
  { category: 'cloakbrowser-missing', pattern: /cloakbrowser.*(not installed|not found|install)|install.*cloakbrowser/i, family: 'env', actionable: true },
  { category: 'command-not-found', pattern: /command not found|ENOENT.*(bun|node|python|playwright)/i, family: 'env', actionable: true },

  // ── site: expected behavior (login wall, their error). Record, do NOT file. ──
  { category: 'login-required', pattern: /LOGIN_REQUIRED|CONSENT_REQUIRED|LOGIN_WALL_DETECTED/, family: 'site', actionable: false },
  { category: 'site-error', pattern: /something went wrong|VERIFY_FAILED|TURNSTILE_DETECTED|FINGERPRINT_PINNED/i, family: 'site', actionable: false },
];

const UNKNOWN = { category: 'unknown', family: 'unknown' as FailureFamily, actionable: true };

// ─── Classification (pure) ───────────────────────────────────

/**
 * Classify a failure. Specific text matches win (a "CloakBrowser not installed"
 * startup error is env, not a generic startup failure). A recognized `hint` (the
 * caller's explicit category, e.g. the daemon's 'daemon-fatal') is a FALLBACK
 * used only when the text matches nothing — so an opaque crash message still
 * lands in the right family. Unmatched text with no hint is `unknown` but still
 * actionable, so a novel failure mode surfaces instead of being silently dropped.
 */
export function classifyFailure(
  text: string,
  hint?: string,
): { category: string; family: FailureFamily; actionable: boolean } {
  const m = SIGNALS.find((s) => s.pattern.test(text));
  if (m) return { category: m.category, family: m.family, actionable: m.actionable };
  if (hint) {
    const h = SIGNALS.find((s) => s.category === hint);
    if (h) return { category: h.category, family: h.family, actionable: h.actionable };
  }
  return { ...UNKNOWN };
}

/**
 * The dedup key. `daemon-unavailable` is deliberately coarse (no domain, no
 * command) so ~10 failures from one dead daemon — across the CLI and daemon
 * layers — collapse to ONE task. Other families are scoped so two genuinely
 * different problems stay two tasks.
 */
export function failureSignature(rec: {
  category: string;
  family: FailureFamily;
  domain?: string;
}): string {
  switch (rec.family) {
    case 'daemon-unavailable':
      return 'daemon-unavailable';
    case 'env':
      return `env:${rec.category}`;
    case 'site':
      return `${rec.category}:${rec.domain || 'unknown'}`;
    default:
      return `unknown:${rec.domain || 'none'}`;
  }
}

// ─── Paths (GLOBAL sink — independent of git/config) ─────────
// Failures from ANY project must land in one place the nightCrawl project can
// find, so the sink is keyed on HOME (or an explicit override for tests), NEVER
// on the caller's git root. This is why it does not reuse resolveConfig().

export function failureSinkDir(env: Record<string, string | undefined> = process.env): string {
  return env.NIGHTCRAWL_FAILURE_DIR || path.join(env.HOME || process.env.HOME || '/tmp', '.nightcrawl');
}

export function failuresLogPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(failureSinkDir(env), 'failures.jsonl');
}

function dedupDir(env: Record<string, string | undefined>): string {
  return path.join(failureSinkDir(env), 'failure-dedup');
}

// ─── Persistence (mirror engine-journal) ─────────────────────

function appendLine(rec: FailureRecord, env: Record<string, string | undefined>): void {
  const dest = failuresLogPath(env);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.appendFileSync(dest, JSON.stringify(rec) + '\n', { mode: 0o600 });
}

/** Read all failure records. Malformed lines skipped; missing log reads empty. */
export function readFailures(env: Record<string, string | undefined> = process.env): FailureRecord[] {
  let raw = '';
  try {
    raw = fs.readFileSync(failuresLogPath(env), 'utf-8');
  } catch {
    return [];
  }
  const out: FailureRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.signature === 'string' && typeof r.family === 'string') out.push(r);
    } catch {}
  }
  return out;
}

/** Trim the log to its most recent MAX_FAILURE_LINES. Opportunistic, safe. */
export function pruneFailures(env: Record<string, string | undefined> = process.env): void {
  try {
    const dest = failuresLogPath(env);
    const lines = fs.readFileSync(dest, 'utf-8').split('\n').filter((l) => l.trim());
    if (lines.length <= MAX_FAILURE_LINES) return;
    const kept = lines.slice(lines.length - MAX_FAILURE_LINES).join('\n') + '\n';
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, kept, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  } catch {}
}

// ─── Dedup (atomic 'wx' — race-safe under a concurrent spree) ─
// ~10 near-simultaneous CLI processes can fail at once. A read-modify-write on a
// shared JSON would race and create multiple tasks. Exclusive-create (mirrors
// acquireServerLock in cli.ts) makes exactly one process the winner per signature.

export function claimSignature(
  sig: string,
  ttlMs: number,
  env: Record<string, string | undefined> = process.env,
  now: number = Date.now(),
): { novel: boolean; count: number } {
  const dir = dedupDir(env);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const file = path.join(dir, createHash('sha1').update(sig).digest('hex').slice(0, 16) + '.json');
  try {
    const fd = fs.openSync(file, 'wx'); // exclusive create → this process won
    fs.writeSync(fd, JSON.stringify({ sig, firstTs: now, lastTs: now, count: 1 }));
    fs.closeSync(fd);
    return { novel: true, count: 1 };
  } catch {
    // Someone already owns it (or a stale marker past TTL).
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof d.firstTs === 'number' && now - d.firstTs > ttlMs) {
        fs.unlinkSync(file);
        return claimSignature(sig, ttlMs, env, now); // reset — a new spree
      }
      d.count = (typeof d.count === 'number' ? d.count : 1) + 1;
      d.lastTs = now;
      fs.writeFileSync(file, JSON.stringify(d));
      return { novel: false, count: d.count };
    } catch {
      return { novel: false, count: 0 };
    }
  }
}

// ─── Diagnostics bundle ──────────────────────────────────────

function safeSpawn(argv: string[]): string {
  try {
    const r = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: 3000 });
    return (r.stdout?.toString() || '') + (r.stderr?.toString() || '');
  } catch (e) {
    return `(capture failed: ${String(e)})\n`;
  }
}

function tailFile(src: string, maxBytes = 16_000): string {
  try {
    const buf = fs.readFileSync(src);
    return buf.length > maxBytes ? buf.subarray(buf.length - maxBytes).toString() : buf.toString();
  } catch {
    return '';
  }
}

function writeTail(dir: string, name: string, src: string): void {
  const content = tailFile(src);
  if (!content) return;
  try {
    fs.writeFileSync(path.join(dir, name), content, { mode: 0o600 });
  } catch {}
}

/**
 * Snapshot the volatile evidence that vanishes otherwise: which daemons are
 * alive, who owns the bridge port, which sockets exist, plus tails of the live
 * logs. Writes to the global sink; reads sources from the failing session config.
 */
export function collectDiagnostics(
  rec: FailureRecord,
  config: BrowseConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  try {
    const dir = path.join(failureSinkDir(env), 'failures', `${rec.ts}-${rec.category}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(rec, null, 2), { mode: 0o600 });

    const port = parseInt(env.BRIDGE_WS_PORT || '10087', 10);
    const procState = [
      '=== ps (server.ts daemons) ===',
      safeSpawn(['sh', '-c', "ps aux | grep 'server.ts' | grep -v grep || true"]),
      `=== lsof -i :${port} (bridge port owner) ===`,
      safeSpawn(['sh', '-c', `lsof -nP -i :${port} 2>/dev/null || true`]),
      '=== /tmp/nightcrawl-*.sock ===',
      safeSpawn(['sh', '-c', 'ls -la /tmp/nightcrawl-*.sock 2>/dev/null || true']),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'daemon-processes.txt'), procState + '\n', { mode: 0o600 });

    if (config) {
      writeTail(dir, 'browse-console.log', config.consoleLog);
      writeTail(dir, 'browse-network.log', config.networkLog);
      writeTail(dir, 'browse-startup-error.log', path.join(config.stateDir, 'browse-startup-error.log'));
    }
    const sink = failureSinkDir(env);
    writeTail(dir, 'engine-decisions.tail.jsonl', path.join(sink, 'engine-decisions.jsonl'));
    writeTail(dir, 'handover-events.tail.jsonl', path.join(sink, 'handover-events.jsonl'));
    return dir;
  } catch {
    return undefined;
  }
}

// ─── Repo-root resolution ────────────────────────────────────

/**
 * Find the nightCrawl repo root by walking up from a start dir looking for
 * scripts/codex_harness.py. Works no matter which project invoked the CLI, so a
 * failure in fictionWorks can still file a task in nightCrawl. Default start dir
 * is this module's own location.
 */
export function nightcrawlRepoRoot(startDir: string = import.meta.dir): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'scripts', 'codex_harness.py'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function gitRootOfCwd(): string | null {
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 2000,
    });
    if (r.exitCode !== 0) return null;
    return r.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

// ─── Task creation (fire-and-forget; survives process.exit) ──

function sanitizeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unknown';
}

function taskDescription(rec: FailureRecord): string {
  const repro = rec.command
    ? `browse ${rec.command}${rec.args && rec.args.length ? ' ' + rec.args.join(' ') : ''}`
    : '(n/a)';
  const lines = [
    `Auto-filed by the failure collector (no silent failures).`,
    `category=${rec.category} family=${rec.family} layer=${rec.layer} exitContext=${rec.exitContext || '-'}`,
    rec.domain ? `domain=${rec.domain}` : ``,
    `repro: ${repro}`,
    `error: ${rec.message}`,
    rec.bundleDir ? `evidence bundle: ${rec.bundleDir}` : ``,
  ].filter(Boolean);
  return lines.join('\n');
}

/** Build the argv for `codex_harness.py task create`. Pure; NEVER passes --global. */
export function buildTaskCreateArgv(rec: FailureRecord, repoRoot: string): string[] {
  const title = `browse failure: ${rec.category}${rec.domain ? ' on ' + rec.domain : ''}`;
  return [
    'python3',
    path.join(repoRoot, 'scripts', 'codex_harness.py'),
    'task',
    'create',
    title,
    '--slug',
    `autofail-${sanitizeSlug(rec.signature)}`,
    '--description',
    taskDescription(rec),
  ];
}

/** Whether this failure should open an investigation task. */
export function shouldCreateTask(
  rec: FailureRecord,
  env: Record<string, string | undefined> = process.env,
  deps: { repoRoot?: string | null; gitRoot?: string | null } = {},
): boolean {
  if (!rec.actionable) return false;
  const repoRoot = deps.repoRoot !== undefined ? deps.repoRoot : nightcrawlRepoRoot();
  if (!repoRoot) return false; // no harness reachable → cannot file
  const gitRoot = deps.gitRoot !== undefined ? deps.gitRoot : gitRootOfCwd();
  // In-repo dev sees failures directly — auto-filing there is self-spam.
  if (gitRoot && path.resolve(gitRoot) === path.resolve(repoRoot)) return false;
  return true;
}

const shQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const appleStr = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`;

function createInvestigationTask(rec: FailureRecord, env: Record<string, string | undefined>): void {
  const repoRoot = nightcrawlRepoRoot();
  if (!repoRoot) return;
  const cmd = buildTaskCreateArgv(rec, repoRoot).map(shQuote).join(' ');
  const notify =
    env.NIGHTCRAWL_NO_NOTIFY === '1'
      ? ''
      : `osascript -e ${shQuote(
          `display notification ${appleStr(`${rec.category} — see ${rec.bundleDir || failureSinkDir(env)}`)} ` +
            `with title ${appleStr('NightCrawl failure filed')} sound name "Tink"`,
        )} || true`;
  // A tiny script file avoids fragile nested shell quoting, and nohup detaches it
  // so it outlives the CLI's imminent process.exit (Bun.spawn+unref does not).
  try {
    const scriptPath = path.join(
      rec.bundleDir || failureSinkDir(env),
      `.filetask-${rec.ts}.sh`,
    );
    fs.writeFileSync(scriptPath, ['#!/bin/sh', cmd, notify, ''].filter(Boolean).join('\n'), { mode: 0o700 });
    Bun.spawnSync(['sh', '-c', `nohup sh ${shQuote(scriptPath)} </dev/null >/dev/null 2>&1 &`], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {}
}

// ─── Orchestrator ────────────────────────────────────────────

function safeDomain(url: string): string | undefined {
  try {
    const d = eTldPlusOne(url);
    return d || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record a failure. Never throws. Always appends a durable line (even for
 * non-actionable site walls — useful for stats); for real tool bugs it also
 * collects an evidence bundle and, once per signature per TTL, files an
 * investigation task + notifies.
 */
export function recordFailure(input: FailureInput): void {
  try {
    const env = input.env || process.env;
    if (env.NIGHTCRAWL_NO_FAILURE_CAPTURE === '1') return;

    const text = `${input.message || ''} ${input.stack || ''}`;
    const { category, family, actionable } = classifyFailure(text, input.hintCategory);
    const domain = input.url ? safeDomain(input.url) : undefined;
    const rec: FailureRecord = {
      ts: Date.now(),
      layer: input.layer,
      category,
      family,
      actionable,
      domain,
      signature: failureSignature({ category, family, domain }),
      message: (input.message || '').slice(0, MAX_MESSAGE_LEN),
      command: input.command,
      args: input.args,
      exitContext: input.exitContext,
    };

    if (actionable) {
      const bundle = collectDiagnostics(rec, input.config, env);
      if (bundle) rec.bundleDir = bundle;
    }
    appendLine(rec, env);
    pruneFailures(env);

    if (!actionable) return;
    if (!shouldCreateTask(rec, env)) return;
    const claim = claimSignature(rec.signature, TASK_DEDUP_TTL_MS, env);
    if (claim.novel) createInvestigationTask(rec, env);
  } catch {
    // Never let failure capture become a failure.
  }
}
