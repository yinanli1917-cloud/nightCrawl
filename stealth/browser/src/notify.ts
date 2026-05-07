/**
 * [INPUT]: Native Swift alert app (~/.nightcrawl/NightCrawlNotify.app)
 * [OUTPUT]: notifyWithAction() — native macOS alert with approve/reject buttons
 * [POS]: System notification + approval dialog within browser module
 *
 * Uses a compiled Swift .app bundle (NSAlert, LSUIElement) for approval
 * prompts. Looks identical to system alerts (Cursor "access Photos", etc.)
 * — no Dock icon, floats on top, native Tahoe styling.
 *
 * Sound: "Tink" — warm and friendly.
 */

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const IS_MAC = os.platform() === 'darwin';
const SOUND = '/System/Library/Sounds/Tink.aiff';
const NOTIFY_APP = path.join(
  process.env.HOME || '/tmp',
  '.nightcrawl',
  'NightCrawlNotify.app',
);
const NOTIFY_BIN = path.join(NOTIFY_APP, 'Contents', 'MacOS', 'nightcrawl-notify');

// ─── Helpers ─────────────────────────────────────────────

function playSound(): void {
  try {
    spawn('afplay', [SOUND], { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

// ─── Approval Dialog ─────────────────────────────────────

export interface NotifyAction {
  label: string;
  onClick: string;
}

export type ApprovalResult = 'approved' | 'rejected' | 'error';

/**
 * Show a native macOS alert with approve/reject buttons.
 *
 * Uses the compiled Swift .app bundle for native Tahoe styling.
 *
 * Returns 'approved' if user clicks the action button (runs onClick),
 * 'rejected' if user clicks cancel/dismiss.
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

  if (fs.existsSync(NOTIFY_BIN)) {
    return launchNativeAlert(title, body, action);
  }
  console.error(`[nightcrawl] Native notification app missing: ${NOTIFY_BIN}`);
  return 'error';
}

async function launchNativeAlert(
  title: string,
  body: string,
  action: NotifyAction,
): Promise<ApprovalResult> {
  return new Promise<ApprovalResult>((resolve) => {
    const child = spawn('open', [
      NOTIFY_APP,
      '--args',
      '--title', title,
      '--body', body,
      '--approve', action.label,
      '--reject', 'Not Now',
      '--on-approve', action.onClick,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });

    child.on('close', () => {
      resolve(stdout.trim() === 'approved' ? 'approved' : 'rejected');
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
  return {
    label: label ?? `Focus ${appName}`,
    onClick: `open -a ${shellQuote(appName)}`,
  };
}

export function openUrlAction(url: string, label: string): NotifyAction {
  return { label, onClick: `open ${shellQuote(url)}` };
}
