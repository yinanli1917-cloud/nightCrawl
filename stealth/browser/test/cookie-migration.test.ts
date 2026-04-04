/**
 * Cookie Migration tests — .gstack/ to .nightcrawl/ state migration.
 *
 * Unit tests: temp dirs simulating old .gstack/ layout, verify ensureStateDir()
 * migrates cookies and doesn't overwrite existing .nightcrawl/ cookies.
 */

import { describe, test, expect } from 'bun:test';
import { resolveConfig, ensureStateDir } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Migration: .gstack → .nightcrawl ──────────────────────────

describe('cookie migration from .gstack to .nightcrawl', () => {
  test('copies cookies from old .gstack/ to new .nightcrawl/ location', () => {
    const tmpDir = path.join(os.tmpdir(), `browse-migration-test-${Date.now()}`);
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    // Create old .gstack/ cookie file
    const oldGstackDir = path.join(tmpDir, 'fake-home', '.gstack');
    fs.mkdirSync(oldGstackDir, { recursive: true });
    const oldCookies = JSON.stringify([{ name: 'session', value: 'abc123', domain: '.example.com' }]);
    fs.writeFileSync(path.join(oldGstackDir, 'browse-cookies.json'), oldCookies);

    // Temporarily override HOME so ensureStateDir finds old cookies
    const origHome = process.env.HOME;
    process.env.HOME = path.join(tmpDir, 'fake-home');

    try {
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(projectDir, '.nightcrawl', 'browse.json') });

      // The new storage file should not exist yet
      expect(fs.existsSync(config.storageFile)).toBe(false);

      ensureStateDir(config);

      // Verify cookies were copied to new location
      expect(fs.existsSync(config.storageFile)).toBe(true);
      const newCookies = fs.readFileSync(config.storageFile, 'utf-8');
      expect(newCookies).toBe(oldCookies);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does NOT overwrite existing .nightcrawl/ cookies', () => {
    const tmpDir = path.join(os.tmpdir(), `browse-migration-test-${Date.now()}`);
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    // Create old .gstack/ cookie file
    const oldGstackDir = path.join(tmpDir, 'fake-home', '.gstack');
    fs.mkdirSync(oldGstackDir, { recursive: true });
    const oldCookies = JSON.stringify([{ name: 'old', value: 'stale' }]);
    fs.writeFileSync(path.join(oldGstackDir, 'browse-cookies.json'), oldCookies);

    // Create existing .nightcrawl/ cookie file (should NOT be overwritten)
    const newDir = path.join(tmpDir, 'fake-home', '.nightcrawl');
    fs.mkdirSync(newDir, { recursive: true });
    const existingCookies = JSON.stringify([{ name: 'existing', value: 'keep-me' }]);
    fs.writeFileSync(path.join(newDir, 'browse-cookies.json'), existingCookies);

    const origHome = process.env.HOME;
    process.env.HOME = path.join(tmpDir, 'fake-home');

    try {
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(projectDir, '.nightcrawl', 'browse.json') });
      ensureStateDir(config);

      // Existing cookies should be preserved (not overwritten by old ones)
      const cookies = fs.readFileSync(config.storageFile, 'utf-8');
      expect(cookies).toBe(existingCookies);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('no-op when old .gstack/ cookies do not exist', () => {
    const tmpDir = path.join(os.tmpdir(), `browse-migration-test-${Date.now()}`);
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    // No .gstack/ directory at all
    const origHome = process.env.HOME;
    process.env.HOME = path.join(tmpDir, 'fake-home');

    try {
      // Ensure fake-home exists but has no .gstack/
      fs.mkdirSync(path.join(tmpDir, 'fake-home'), { recursive: true });

      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(projectDir, '.nightcrawl', 'browse.json') });
      ensureStateDir(config);

      // storageFile should not exist (no migration source, no creation)
      expect(fs.existsSync(config.storageFile)).toBe(false);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('creates parent directory for storageFile during migration', () => {
    const tmpDir = path.join(os.tmpdir(), `browse-migration-test-${Date.now()}`);
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    // Create old .gstack/ cookie file
    const oldGstackDir = path.join(tmpDir, 'fake-home', '.gstack');
    fs.mkdirSync(oldGstackDir, { recursive: true });
    fs.writeFileSync(path.join(oldGstackDir, 'browse-cookies.json'), '[]');

    const origHome = process.env.HOME;
    process.env.HOME = path.join(tmpDir, 'fake-home');

    try {
      const config = resolveConfig({ BROWSE_STATE_FILE: path.join(projectDir, '.nightcrawl', 'browse.json') });

      // The .nightcrawl/ dir for storageFile should not exist yet
      const storageDir = path.dirname(config.storageFile);
      expect(fs.existsSync(storageDir)).toBe(false);

      ensureStateDir(config);

      // Migration should have created the directory
      expect(fs.existsSync(storageDir)).toBe(true);
      expect(fs.existsSync(config.storageFile)).toBe(true);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
