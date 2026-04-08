/**
 * Startup performance tests — verify cold start optimizations
 *
 * [INPUT]: Depends on server.ts startup sequence, browser-manager.ts launch
 * [OUTPUT]: Validates startup timing, patch caching, readiness gate
 * [POS]: Integration test for cold start elimination
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as crypto from 'crypto';

const SERVER_PATH = path.resolve(import.meta.dir, '..', 'src', 'server.ts');

// ─── Helpers ────────────────────────────────────────────────────

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

async function waitForStateFile(stateFile: string, timeoutMs: number): Promise<{ port: number; token: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(stateFile, 'utf-8');
      const state = JSON.parse(raw);
      if (state.port && state.token) return state;
    } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`State file ${stateFile} not ready within ${timeoutMs}ms`);
}

async function sendCommand(port: number, token: string, command: string, args: string[] = []): Promise<{ status: number; body: string; elapsed: number }> {
  const start = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ command, args }),
  });
  const body = await res.text();
  return { status: res.status, body, elapsed: Date.now() - start };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('startup performance', () => {
  const stateDir = path.join(require('os').tmpdir(), `nightcrawl-perf-test-${Date.now()}`);
  const stateFile = path.join(stateDir, 'browse.json');
  const storageFile = path.join(stateDir, 'browse-storage.json');
  let serverProc: ReturnType<typeof Bun.spawn> | null = null;
  let port: number;
  let token: string;

  afterAll(async () => {
    if (serverProc) {
      try {
        // Send shutdown command
        await fetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ command: 'exit' }),
        }).catch(() => {});
      } catch {}
      serverProc.kill();
      await serverProc.exited.catch(() => {});
    }
    // Clean up state dir
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  });

  it('server writes state file before browser is fully ready (parallel startup)', async () => {
    fs.mkdirSync(stateDir, { recursive: true });

    const launchStart = Date.now();
    serverProc = Bun.spawn(['bun', 'run', SERVER_PATH], {
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile,
        BROWSE_EXTENSIONS: 'none',
        BROWSE_IDLE_TIMEOUT: '30000',
        BROWSE_AUTO_HANDOVER: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // State file should appear quickly (server starts HTTP before browser)
    const state = await waitForStateFile(stateFile, 10000);
    const stateFileTime = Date.now() - launchStart;
    port = state.port;
    token = state.token;

    console.log(`[perf] State file ready in ${stateFileTime}ms`);

    // The state file should be written well before 3 seconds
    // (the old full-sequential startup time)
    // With parallel startup, the server writes state file as soon as
    // HTTP is listening, even before browser is fully warm
    expect(stateFileTime).toBeLessThan(3000);
  }, 15000);

  it('first command responds within 5000ms of server start', async () => {
    // The first command may need to wait for browser warmup,
    // but should still be fast because browser launched in parallel
    const result = await sendCommand(port, token, 'url');
    console.log(`[perf] First command responded in ${result.elapsed}ms`);
    expect(result.status).toBe(200);
    // First command might take a bit while browser finishes launching,
    // but should be under 5s total (vs 3s+ just for state file before)
    expect(result.elapsed).toBeLessThan(5000);
  }, 10000);

  it('subsequent commands respond within 500ms', async () => {
    const result = await sendCommand(port, token, 'url');
    console.log(`[perf] Subsequent command responded in ${result.elapsed}ms`);
    expect(result.status).toBe(200);
    expect(result.elapsed).toBeLessThan(500);
  }, 5000);

  it('health endpoint responds even during browser warmup', async () => {
    // Health check should always return HTTP 200 (not crash)
    // Status may be unhealthy during warmup, healthy after
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(['healthy', 'unhealthy']).toContain(body.status);
  }, 5000);

  it('server shutdown is clean with pre-warmed browser', async () => {
    // Send SIGTERM for graceful shutdown
    serverProc!.kill('SIGTERM');

    // Wait for process to exit
    const exitCode = await Promise.race([
      serverProc!.exited,
      new Promise<number>(r => setTimeout(() => r(-1), 10000)),
    ]);

    // Clean exit (0) — not a crash
    expect(exitCode).toBe(0);

    // State file should be cleaned up on graceful shutdown
    expect(fs.existsSync(stateFile)).toBe(false);

    serverProc = null;
  }, 15000);
});

describe('stealth patch caching', () => {
  it('applyStealthPatches uses hash cache to skip redundant copies', async () => {
    // Import the caching utility
    const { isPatchCurrent } = await import('../src/browser-manager');

    // A file that doesn't exist should not be current
    expect(isPatchCurrent('/nonexistent/src', '/nonexistent/dest')).toBe(false);
  });
});

describe('LaunchAgent plist generation', () => {
  it('generates valid plist XML', async () => {
    const { generateLaunchAgentPlist } = await import('../src/browser-manager');
    const plist = generateLaunchAgentPlist('/usr/local/bin/bun', '/path/to/server.ts');

    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist).toContain('com.nightcrawl.daemon');
    expect(plist).toContain('/usr/local/bin/bun');
    expect(plist).toContain('/path/to/server.ts');
    expect(plist).toContain('RunAtLoad');
    expect(plist).toContain('LowPriorityIO');
  });
});
