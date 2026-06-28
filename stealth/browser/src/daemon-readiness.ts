/**
 * [INPUT]: Pure module — no I/O. The cli startup/lock-wait loops sample the live
 *          signals (health, state file, process liveness, error log) and pass them in.
 * [OUTPUT]: Exports StartupStatus, StartupSnapshot, classifyStartup, READY_TIMEOUT_MS.
 * [POS]: Pillar A4 — daemon lifecycle robustness. Decides, each poll, whether the
 *        daemon is READY, has FAILED, or is still booting (WAITING). The old loops used
 *        a flat 8s timeout and could not tell "Chromium still cold-booting" from "the
 *        process died", so a slow-but-fine boot surfaced "Server failed to start within
 *        8s" (seen repeatedly in the Cursor-course session) while a real failure waited
 *        the full window. This separates the two: fail FAST on a dead process / logged
 *        error, wait PATIENTLY (up to READY_TIMEOUT_MS) while the process is alive.
 */

export type StartupStatus = 'ready' | 'failed' | 'waiting';

export interface StartupSnapshot {
  healthy: boolean;     // /health responded ok — definitive proof of readiness
  errorLogged: boolean; // browse-startup-error.log has content (explicit boot failure)
}

/**
 * Classify one startup poll. Health wins outright. An explicit startup-error log (the
 * server writes one on a real boot failure) is a definitive FAILURE — fail fast. Anything
 * else is still booting, so keep waiting up to READY_TIMEOUT_MS.
 *
 * Deliberately does NOT infer failure from process-liveness: the daemon is spawned
 * detached (nohup/sh), so a transient or leftover browse.json with an unverifiable pid
 * would otherwise trip a FALSE "failed" mid-boot. The error log + the timeout are the
 * reliable signals.
 */
export function classifyStartup(s: StartupSnapshot): StartupStatus {
  if (s.healthy) return 'ready';
  if (s.errorLogged) return 'failed';
  return 'waiting';
}

// A cold CloakBrowser (stealth Chromium, 48 patches + fingerprint init) can take well
// over 8s to be healthy. Wait this long for HEALTH, but classifyStartup still fails fast
// the moment the process dies or logs an error, so a real failure never waits the whole
// budget.
export const READY_TIMEOUT_MS = 45_000;
