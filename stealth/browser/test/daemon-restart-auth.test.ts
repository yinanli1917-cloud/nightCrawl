/**
 * Gate S4: graceful daemon stop → restart → headless goto still works on public URL.
 * Uses isolated profile; does not touch hostile or auth-heavy domains.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

const browserDir = path.resolve(__dirname, '..');
const cliPath = path.join(browserDir, 'src/cli.ts');

function runNc(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 90_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bun', ['run', cliPath, ...args], {
      cwd: browserDir,
      env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`, ...env },
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('daemon restart persistence (public URL)', () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-restart-profile-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-restart-state-'));
  const stateFile = path.join(stateDir, 'browse.json');
  const baseEnv: Record<string, string> = {
    BROWSE_STATE_FILE: stateFile,
    BROWSE_PROFILE_DIR: profileDir,
    BROWSE_EXTENSIONS: 'none',
    BROWSE_AUTO_HANDOVER: '0',
  };

  afterAll(() => {
    try {
      if (fs.existsSync(stateFile)) {
        const pid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid;
        if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
  });

  test('survives SIGTERM restart for example.com', async () => {
    const first = await runNc(['goto', 'https://example.com'], baseEnv);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/Navigated|200/i);

    expect(fs.existsSync(stateFile)).toBe(true);
    const pid = JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid as number;
    expect(pid).toBeGreaterThan(0);

    process.kill(pid, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 3000));

    const second = await runNc(['goto', 'https://example.com'], baseEnv);
    expect(second.code).toBe(0);
    expect(second.stdout + second.stderr).toMatch(/Navigated|200|Starting server/i);

    const title = await runNc(['js', 'document.title'], baseEnv);
    expect(title.stdout).toContain('Example Domain');
  }, 120_000);
});
