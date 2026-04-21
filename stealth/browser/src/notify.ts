/**
 * [INPUT]: macOS osascript (system), terminal-notifier (optional, brew install)
 * [OUTPUT]: notify() — passive notification; notifyWithAction() — clickable
 *          notification whose button runs a shell command on click
 * [POS]: System notification helper within browser module
 *
 * Used to surface CONSENT_REQUIRED and other proactive prompts to the user
 * without requiring the agent to interrupt the chat. macOS-only for MVP;
 * other platforms get a no-op (the textual signal in the HTTP response is
 * still surfaced to the agent, so nothing is lost — only the OS-level ping
 * is missing).
 *
 * terminal-notifier is OPTIONAL. When absent, notifyWithAction silently
 * degrades to a passive notification — the body text still tells the user
 * what's happening, they just can't one-click the action button.
 *
 * See memory/feedback_proactive_handoff_ux.md for the larger design.
 */

import { spawn, spawnSync } from 'child_process';
import * as os from 'os';

const IS_MAC = os.platform() === 'darwin';

// ─── Capability Detection ─────────────────────────────────
// Cache the terminal-notifier check for the life of the process.
// Spawning `which` every notification would be wasteful.

let tnCached: string | null | undefined = undefined;

function terminalNotifierPath(): string | null {
  if (tnCached !== undefined) return tnCached;
  try {
    const r = spawnSync('which', ['terminal-notifier'], { encoding: 'utf-8' });
    const out = (r.stdout || '').trim();
    tnCached = out && r.status === 0 ? out : null;
  } catch {
    tnCached = null;
  }
  return tnCached;
}

// ─── Passive Notification ─────────────────────────────────

/**
 * Display a macOS notification. Best-effort — never throws, never blocks.
 * On non-macOS, this is a no-op.
 *
 * Inputs are escaped for the AppleScript double-quoted string context:
 * backslash + double-quote are the only chars that can break out.
 */
export function notify(title: string, body: string): void {
  if (!IS_MAC) return;
  if (process.env.NIGHTCRAWL_NO_NOTIFY === '1') return;

  const safe = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${safe(body)}" with title "${safe(title)}" sound name "Glass"`;

  try {
    const child = spawn('osascript', ['-e', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// ─── Actionable Notification ──────────────────────────────

export interface NotifyAction {
  /** Button label shown on the notification. */
  label: string;
  /** Shell command to execute when the user clicks the button. */
  onClick: string;
}

/**
 * Display a notification with a clickable action button.
 *
 * Requires terminal-notifier (brew install terminal-notifier). When absent,
 * falls back to passive notify() — the body already describes the state,
 * only the one-click is missing. Install-hint is printed ONCE per process
 * so the user sees it without getting spammed.
 *
 * The onClick command runs through `sh -c` on click. Callers are
 * responsible for quoting; this helper does not escape for them (the
 * common case is a short osascript or open invocation authored by us,
 * not user input).
 */
let installHintShown = false;

export function notifyWithAction(
  title: string,
  body: string,
  action: NotifyAction,
): void {
  // Even on non-Mac or with notifications suppressed, the user still
  // needs a way to see and run the action. Print it to the terminal
  // unconditionally — this is the reliable fallback for silenced
  // notifications, broken permissions, or click-does-nothing cases
  // (terminal-notifier 2.0.0's action-button support was removed,
  // see below). The user can always copy-paste from stderr.
  printActionable(title, body, action);

  if (!IS_MAC) return;
  if (process.env.NIGHTCRAWL_NO_NOTIFY === '1') return;

  const tn = terminalNotifierPath();
  if (!tn) {
    notify(title, `${body} (install terminal-notifier for clickable notifications)`);
    if (!installHintShown) {
      installHintShown = true;
      console.log(
        '[nightcrawl] Install terminal-notifier for clickable notifications: brew install terminal-notifier',
      );
    }
    return;
  }

  // terminal-notifier 2.0.0 removed -actions (user report + `tn -help`
  // shows no such flag). What IS supported:
  //   -execute COMMAND → runs on click of the notification BODY
  //   -open URL        → opens URL on click (more reliable on modern macOS)
  //
  // If the action is a simple `open URL`, use -open (Apple's happy path).
  // Otherwise -execute. Both map to "click the notification" — no button
  // is rendered. The stderr hint above already tells the user what
  // command will run.
  const args: string[] = [
    '-title', title,
    '-message', body,
    '-sound', 'Glass',
    '-group', 'nightcrawl-handoff',
  ];
  const openMatch = action.onClick.match(/^open\s+"?([^"]+)"?\s*$/);
  if (openMatch) {
    args.push('-open', openMatch[1]);
  } else {
    args.push('-execute', action.onClick);
  }

  try {
    const child = spawn(tn, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

/**
 * Print the actionable command to stderr so the user always has a
 * paste-able fallback. Uses a compact, scannable format so the command
 * stands out in agent logs.
 */
function printActionable(title: string, body: string, action: NotifyAction): void {
  try {
    console.error(`[nightcrawl] ${title}: ${body}`);
    console.error(`[nightcrawl]   → ${action.label}: ${action.onClick}`);
  } catch {}
}

// ─── Action Helpers ───────────────────────────────────────
// Pre-built actions for the common cases. Keeping these here (rather than
// inline at call sites) so the osascript incantations live in one place.

/**
 * Action that brings the named macOS app to the foreground.
 */
export function focusAppAction(appName: string, label?: string): NotifyAction {
  const safe = appName.replace(/"/g, '\\"');
  return {
    label: label ?? `Focus ${appName}`,
    onClick: `osascript -e 'tell application "${safe}" to activate'`,
  };
}

/**
 * Action that opens a URL in the user's default browser.
 */
export function openUrlAction(url: string, label: string): NotifyAction {
  const safe = url.replace(/"/g, '\\"');
  return { label, onClick: `open "${safe}"` };
}
