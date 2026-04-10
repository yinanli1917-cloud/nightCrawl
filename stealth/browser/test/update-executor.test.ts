/**
 * Update executor tests.
 *
 * Verifies that the executor calls bun/playwright commands in the
 * right order with the right arguments. The actual subprocess is
 * injected so tests are fast and hermetic.
 *
 * [INPUT]: update-executor.ts
 * [OUTPUT]: Pass/fail per executor scenario
 * [POS]: Unit tests within stealth/browser/test
 */

import { describe, test, expect } from 'bun:test';
import {
  installPackage,
  installPlaywrightChromium,
  bunInstallAll,
  type CommandRunner,
} from '../src/update-executor';

// ─── Helpers ────────────────────────────────────────────────────

interface RecordedCall {
  cmd: string;
  args: string[];
}

function makeRecorder(exitCode: number = 0): {
  runner: CommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    return { exitCode, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('installPackage', () => {
  test('runs `bun add <pkg>@<version>`', async () => {
    const { runner, calls } = makeRecorder();
    const result = await installPackage('cloakbrowser', '0.3.22', { runner, cwd: '/tmp' });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('bun');
    expect(calls[0].args).toEqual(['add', 'cloakbrowser@0.3.22']);
  });

  test('returns success=false on non-zero exit', async () => {
    const { runner } = makeRecorder(1);
    const result = await installPackage('cloakbrowser', '0.3.22', { runner, cwd: '/tmp' });
    expect(result.success).toBe(false);
  });

  test('passes cwd to runner', async () => {
    let receivedCwd: string | undefined;
    const runner: CommandRunner = async (_cmd, _args, opts) => {
      receivedCwd = opts?.cwd;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await installPackage('x', '1.0.0', { runner, cwd: '/test/path' });
    expect(receivedCwd).toBe('/test/path');
  });
});

describe('installPlaywrightChromium', () => {
  test('runs `bunx playwright install chromium`', async () => {
    const { runner, calls } = makeRecorder();
    const result = await installPlaywrightChromium({ runner, cwd: '/tmp' });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('bunx');
    expect(calls[0].args).toEqual(['playwright', 'install', 'chromium']);
  });

  test('returns failure on non-zero exit', async () => {
    const { runner } = makeRecorder(2);
    const result = await installPlaywrightChromium({ runner, cwd: '/tmp' });
    expect(result.success).toBe(false);
  });
});

describe('bunInstallAll', () => {
  test('runs `bun install`', async () => {
    const { runner, calls } = makeRecorder();
    const result = await bunInstallAll({ runner, cwd: '/tmp' });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('bun');
    expect(calls[0].args).toEqual(['install']);
  });
});
