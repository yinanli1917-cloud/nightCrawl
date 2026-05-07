/**
 * Bypass Paywalls extension updater.
 *
 * NightCrawl loads extensions as unpacked directories with --load-extension.
 * Chromium's native CRX update machinery is designed for installed packed or
 * external extensions, so the daemon mirrors the CRX update feed into the
 * repo-managed unpacked directory before browser launch.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { compareVersions } from './update-checker';

export const BPC_UPDATE_URL = 'https://gitflic.ru/project/magnolia1234/bpc_updates/blob/raw?file=updates.xml';
export const BPC_EXTENSION_DIR = path.resolve(__dirname, '..', '..', 'extensions', 'bypass-paywalls-chrome');

const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 30_000;
const APP_ID_RE = /<app\s+[^>]*appid=['"]([^'"]+)['"][^>]*>/i;
const UPDATE_RE = /<updatecheck\s+[^>]*codebase=['"]([^'"]+)['"][^>]*version=['"]([^'"]+)['"][^>]*\/?>/i;

export interface BypassPaywallsUpdateInfo {
  appId: string | null;
  version: string;
  codebase: string;
}

export interface BypassPaywallsUpdateResult {
  currentVersion: string | null;
  latestVersion: string | null;
  updated: boolean;
  skipped: boolean;
  reason?: string;
  updateUrl: string;
  codebase?: string;
}

function statePath(stateDir: string): string {
  return path.join(stateDir, 'bypass-paywalls-update.json');
}

function readCurrentVersion(extensionDir = BPC_EXTENSION_DIR): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf-8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function cooldownActive(stateDir: string, cooldownMs: number): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(stateDir), 'utf-8'));
    return typeof raw.lastCheck === 'number' && Date.now() - raw.lastCheck < cooldownMs;
  } catch {
    return false;
  }
}

function writeState(stateDir: string, result: BypassPaywallsUpdateResult): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath(stateDir), JSON.stringify({ lastCheck: Date.now(), ...result }, null, 2));
  } catch {}
}

export function parseBypassPaywallsUpdateXml(xml: string): BypassPaywallsUpdateInfo | null {
  const appId = APP_ID_RE.exec(xml)?.[1] ?? null;
  const update = UPDATE_RE.exec(xml);
  if (!update) return null;
  return { appId, codebase: update[1], version: update[2] };
}

function crxZipOffset(buf: Buffer): number {
  if (buf.subarray(0, 4).toString('utf-8') !== 'Cr24') {
    throw new Error('not a CRX file');
  }
  const version = buf.readUInt32LE(4);
  if (version !== 3) throw new Error(`unsupported CRX version ${version}`);
  const headerSize = buf.readUInt32LE(8);
  const offset = 12 + headerSize;
  if (buf.subarray(offset, offset + 4).toString('binary') !== 'PK\u0003\u0004') {
    throw new Error('CRX payload is not a zip archive');
  }
  return offset;
}

async function fetchText(url: string, timeoutMs: number, fetchFn: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url: string, timeoutMs: number, fetchFn: typeof fetch): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function installCrxBuffer(buf: Buffer, extensionDir: string): void {
  const zipOffset = crxZipOffset(buf);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcrawl-bpc-update-'));
  const zipPath = path.join(tmpDir, 'extension.zip');
  const unpackDir = path.join(tmpDir, 'unpacked');
  try {
    fs.mkdirSync(unpackDir);
    fs.writeFileSync(zipPath, buf.subarray(zipOffset));
    const unzip = spawnSync('unzip', ['-q', zipPath, '-d', unpackDir], { timeout: 10_000 });
    if (unzip.status !== 0) {
      throw new Error(`unzip failed: ${unzip.stderr?.toString() || unzip.status}`);
    }
    if (!fs.existsSync(path.join(unpackDir, 'manifest.json'))) {
      throw new Error('updated extension has no manifest.json');
    }
    const backupDir = `${extensionDir}.bak`;
    const oldDir = `${extensionDir}.old`;
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
    if (fs.existsSync(extensionDir)) fs.renameSync(extensionDir, backupDir);
    fs.renameSync(unpackDir, extensionDir);
    try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch {}
    try { if (fs.existsSync(backupDir)) fs.renameSync(backupDir, oldDir); } catch {}
  } catch (err) {
    const backupDir = `${extensionDir}.bak`;
    if (!fs.existsSync(extensionDir) && fs.existsSync(backupDir)) {
      try { fs.renameSync(backupDir, extensionDir); } catch {}
    }
    throw err;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

export async function updateBypassPaywallsExtension(opts: {
  stateDir: string;
  extensionDir?: string;
  updateUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  cooldownMs?: number;
  force?: boolean;
}): Promise<BypassPaywallsUpdateResult> {
  const extensionDir = opts.extensionDir ?? BPC_EXTENSION_DIR;
  const updateUrl = opts.updateUrl ?? BPC_UPDATE_URL;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;
  const currentVersion = readCurrentVersion(extensionDir);

  if (!opts.force && cooldownActive(opts.stateDir, cooldownMs)) {
    return { currentVersion, latestVersion: null, updated: false, skipped: true, reason: 'cooldown', updateUrl };
  }

  try {
    const xml = await fetchText(updateUrl, timeoutMs, fetchFn);
    const info = parseBypassPaywallsUpdateXml(xml);
    if (!info) throw new Error('update feed did not contain an updatecheck entry');

    if (currentVersion && compareVersions(currentVersion, info.version) >= 0) {
      const result = {
        currentVersion,
        latestVersion: info.version,
        updated: false,
        skipped: true,
        reason: 'already-current',
        updateUrl,
        codebase: info.codebase,
      };
      writeState(opts.stateDir, result);
      return result;
    }

    const crx = await fetchBuffer(info.codebase, timeoutMs, fetchFn);
    installCrxBuffer(crx, extensionDir);
    const nextVersion = readCurrentVersion(extensionDir);
    const result = {
      currentVersion,
      latestVersion: nextVersion ?? info.version,
      updated: true,
      skipped: false,
      updateUrl,
      codebase: info.codebase,
    };
    writeState(opts.stateDir, result);
    return result;
  } catch (err: any) {
    const result = {
      currentVersion,
      latestVersion: null,
      updated: false,
      skipped: true,
      reason: err?.message || String(err),
      updateUrl,
    };
    writeState(opts.stateDir, result);
    return result;
  }
}
