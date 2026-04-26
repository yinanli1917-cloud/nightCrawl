/**
 * [INPUT]: Native Swift alert app (~/.nightcrawl/NightCrawlNotify.app),
 *          fallback to osascript
 * [OUTPUT]: notify() — passive notification; notifyWithAction() — native
 *          macOS alert with approve/reject buttons
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

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

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
 * Show a native macOS alert with approve/reject buttons.
 *
 * Uses the compiled Swift .app bundle for native Tahoe styling.
 * Falls back to osascript if the .app is missing.
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
  return launchOsascriptFallback(title, body, action);
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

async function launchOsascriptFallback(
  title: string,
  body: string,
  action: NotifyAction,
): Promise<ApprovalResult> {
  playSound();
  const script = [
    `display dialog "${esc(body)}"`,
    `with title "${esc(title)}"`,
    `buttons {"Not Now", "${esc(action.label)}"}`,
    `default button "${esc(action.label)}"`,
    `with icon note`,
  ].join(' ');

  return new Promise<ApprovalResult>((resolve) => {
    const child = spawn('osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });

    child.on('close', (code) => {
      if (code === 0 && stdout.includes(action.label)) {
        try {
          spawn('sh', ['-c', action.onClick], { stdio: 'ignore', detached: true }).unref();
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
