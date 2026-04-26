/**
 * [INPUT]: macOS osascript (system)
 * [OUTPUT]: notify() — passive notification; notifyWithAction() — modal dialog
 *          with Approve / Not now buttons that returns the user's choice
 * [POS]: System notification + approval dialog within browser module
 *
 * Uses osascript `display dialog` for approval prompts — this is modal,
 * always visible (can't be silenced by Focus mode), and returns which
 * button the user pressed. terminal-notifier is NOT used (broken on
 * macOS 26 — clicking opens Script Editor instead of running the action).
 *
 * Sound: "Tink" — warm and friendly, matching the "nightCrawl needs you" tone.
 */

import { spawn, spawnSync, execSync } from 'child_process';
import * as os from 'os';

const IS_MAC = os.platform() === 'darwin';
const SOUND = '/System/Library/Sounds/Tink.aiff';

// ─── Helpers ─────────────────────────────────────────────

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function playSound(): void {
  try {
    spawn('afplay', [SOUND], { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

// ─── Passive Notification ────────────────────────────────

export function notify(title: string, body: string): void {
  if (!IS_MAC) return;
  if (process.env.NIGHTCRAWL_NO_NOTIFY === '1') return;

  playSound();
  const script = `display notification "${esc(body)}" with title "${esc(title)}"`;
  try {
    const child = spawn('osascript', ['-e', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// ─── Approval Dialog ─────────────────────────────────────

export interface NotifyAction {
  label: string;
  onClick: string;
}

export type ApprovalResult = 'approved' | 'rejected' | 'error';

/**
 * Show a modal approval dialog with Approve / Not now buttons.
 *
 * - Plays warm "Tink" sound to get attention without startling
 * - Shows a manifest: what happened, what will happen
 * - User clicks "Let's go!" → returns 'approved', runs onClick
 * - User clicks "Not now"   → returns 'rejected', does nothing
 * - Dialog is modal — always visible, can't be missed
 *
 * Non-blocking from the caller's perspective (returns a Promise).
 * The daemon continues serving other requests while waiting.
 */
export async function notifyWithAction(
  title: string,
  body: string,
  action: NotifyAction,
): Promise<ApprovalResult> {
  printActionable(title, body, action);

  if (!IS_MAC || process.env.NIGHTCRAWL_NO_NOTIFY === '1') {
    return 'error';
  }

  playSound();

  const script = [
    `display dialog "${esc(body)}"`,
    `with title "${esc(title)}"`,
    `buttons {"Not now", "${esc(action.label)}"}`,
    `default button "${esc(action.label)}"`,
    `with icon note`,
  ].join(' ');

  return new Promise<ApprovalResult>((resolve) => {
    const child = spawn('osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0 && stdout.includes(action.label)) {
        // User clicked the approve button — run the action
        try {
          const sh = spawn('sh', ['-c', action.onClick], {
            stdio: 'ignore', detached: true,
          });
          sh.unref();
        } catch {}
        resolve('approved');
      } else {
        resolve('rejected');
      }
    });

    child.on('error', () => resolve('error'));
  });
}

function printActionable(title: string, body: string, action: NotifyAction): void {
  try {
    console.error(`[nightcrawl] ${title}: ${body}`);
    console.error(`[nightcrawl]   → ${action.label}: ${action.onClick}`);
  } catch {}
}

// ─── Action Helpers ──────────────────────────────────────

export function focusAppAction(appName: string, label?: string): NotifyAction {
  const safe = appName.replace(/"/g, '\\"');
  return {
    label: label ?? `Focus ${appName}`,
    onClick: `osascript -e 'tell application "${safe}" to activate'`,
  };
}

export function openUrlAction(url: string, label: string): NotifyAction {
  const safe = url.replace(/"/g, '\\"');
  return { label, onClick: `open "${safe}"` };
}
