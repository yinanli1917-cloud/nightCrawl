#!/usr/bin/env bun
/**
 * [INPUT]: Drives the nc CLI (which handles daemon discovery).
 * [OUTPUT]: Reloads the nightcrawl-bridge extension from disk + waits for reconnect.
 * [POS]: Dev tool — lets the agent iterate on the bridge extension's background.js
 *        WITHOUT a manual toggle. Sends `nc reload-extension` (the daemon relays it;
 *        the extension calls chrome.runtime.reload()), then polls the side-effect-
 *        free `nc bridge-status` until the WS reconnects.
 *
 * Caveat: chrome.runtime.reload() reloads CODE from disk. NEW manifest permissions
 * still require a one-time manual reload (Chrome won't auto-grant them).
 *
 * Usage: bun run scripts/bridge-reload.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const NC_DIR = join(dirname(import.meta.dirname), 'stealth', 'browser');
const env = { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH || ''}`, BROWSE_IGNORE_HTTPS_ERRORS: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nc(...args) {
  const r = spawnSync('bun', ['run', 'src/cli.ts', ...args], { cwd: NC_DIR, env, encoding: 'utf8', timeout: 30_000 });
  return ((r.stdout || '') + '').trim();
}
function connected() {
  try { return JSON.parse(nc('bridge-status').split('\n').pop()).connected === true; } catch { return false; }
}

if (!connected()) {
  console.log('bridge not connected — open Arc with the nightcrawl-bridge extension first.');
  process.exit(2);
}
console.log('reloading nightcrawl-bridge from disk…');
console.log('  ack:', nc('reload-extension').split('\n').pop());

// The SW tears down ~200ms after the ack; it reconnects via onStartup + keepalive.
await sleep(1500);
let back = false;
for (let i = 0; i < 30; i++) {
  if (connected()) { back = true; break; }
  await sleep(700);
}
console.log(back ? 'RELOAD_OK — bridge reconnected' : 'RELOAD_TIMEOUT — bridge did not reconnect');
process.exit(back ? 0 : 1);
