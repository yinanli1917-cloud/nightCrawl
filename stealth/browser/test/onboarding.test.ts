import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Each test gets a fresh tmp dir to simulate ~/.nightcrawl/
let tmpHome: string;

beforeEach(() => {
  tmpHome = path.join(os.tmpdir(), `nightcrawl-onboarding-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpHome, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('isFirstRun', () => {
  test('returns true when state dir does not exist', async () => {
    const { isFirstRun } = await import('../src/onboarding');
    const nonExistent = path.join(tmpHome, 'does-not-exist', 'browse-cookies.json');
    expect(isFirstRun(nonExistent)).toBe(true);
  });

  test('returns true when cookie file is empty', async () => {
    const cookiePath = path.join(tmpHome, 'browse-cookies.json');
    fs.writeFileSync(cookiePath, '');
    const { isFirstRun } = await import('../src/onboarding');
    expect(isFirstRun(cookiePath)).toBe(true);
  });

  test('returns true when cookie file has empty JSON object', async () => {
    const cookiePath = path.join(tmpHome, 'browse-cookies.json');
    fs.writeFileSync(cookiePath, '{}');
    const { isFirstRun } = await import('../src/onboarding');
    expect(isFirstRun(cookiePath)).toBe(true);
  });

  test('returns false when cookie file has real cookies', async () => {
    const cookiePath = path.join(tmpHome, 'browse-cookies.json');
    fs.writeFileSync(cookiePath, JSON.stringify({ cookies: [{ name: 'sid', value: 'abc' }] }));
    const { isFirstRun } = await import('../src/onboarding');
    expect(isFirstRun(cookiePath)).toBe(false);
  });
});

describe('OnboardingResult', () => {
  test('has required shape fields', () => {
    // Type-level check: construct a conforming object at runtime
    const result: import('../src/onboarding').OnboardingResult = {
      mode: 'full',
      imported: 0,
      browser: null,
    };
    expect(result.mode).toBe('full');
    expect(result.imported).toBe(0);
    expect(result.browser).toBeNull();
  });
});

describe('saveOnboardingConfig', () => {
  test('writes cookie_mode to config.yaml', async () => {
    const { saveOnboardingConfig } = await import('../src/onboarding');
    const configPath = path.join(tmpHome, 'state', 'config.yaml');
    saveOnboardingConfig('ask', configPath);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('cookie_mode: ask');
  });

  test('preserves existing config values', async () => {
    const { saveOnboardingConfig } = await import('../src/onboarding');
    const stateDir = path.join(tmpHome, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const configPath = path.join(stateDir, 'config.yaml');
    fs.writeFileSync(configPath, 'auto_upgrade: true\n');
    saveOnboardingConfig('manual', configPath);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toContain('auto_upgrade: true');
    expect(content).toContain('cookie_mode: manual');
  });
});
