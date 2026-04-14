/**
 * [INPUT]: macOS osascript (system) — best-effort, optional
 * [OUTPUT]: notify() — fire-and-forget user notification
 * [POS]: System notification helper within browser module
 *
 * Used to surface CONSENT_REQUIRED and other proactive prompts to the user
 * without requiring the agent to interrupt the chat. macOS-only for MVP;
 * other platforms get a no-op (the textual signal in the HTTP response is
 * still surfaced to the agent, so nothing is lost — only the OS-level ping
 * is missing).
 *
 * See memory/feedback_proactive_handoff_ux.md for the larger design.
 */

import { spawn } from 'child_process';
import * as os from 'os';

const IS_MAC = os.platform() === 'darwin';

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
    child.on('error', () => {}); // swallow ENOENT, etc.
    child.unref();
  } catch {
    // never bubble up — notifications are best-effort
  }
}
