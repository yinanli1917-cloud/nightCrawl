/**
 * Extension Management tests -- source-level audits for BROWSE_EXTENSIONS handling.
 *
 * Verifies that the BROWSE_EXTENSIONS env var is checked in all browser launch paths
 * and that 'none' mode correctly skips extension loading.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

// Core class in browser-manager.ts, handoff methods in browser-handoff.ts
const BROWSER_MANAGER_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../src/browser-manager.ts'), 'utf-8'
);
const BROWSER_HANDOFF_SRC = fs.readFileSync(
  path.join(import.meta.dir, '../src/browser-handoff.ts'), 'utf-8'
);

// Helper: extract a block of source between two markers
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Marker not found: ${startMarker}`);
  const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`End marker not found: ${endMarker}`);
  return source.slice(startIdx, endIdx);
}

// ─── Source-Level Audit: BROWSE_EXTENSIONS Checked ──────────────

describe('BROWSE_EXTENSIONS handling (source audit)', () => {
  test('launch() checks BROWSE_EXTENSIONS env var', () => {
    const launchBlock = sliceBetween(BROWSER_MANAGER_SRC, 'async launch()', 'async close()');
    expect(launchBlock).toContain("BROWSE_EXTENSIONS");
    expect(launchBlock).toContain("'none'");
  });

  test('launchHeaded() checks BROWSE_EXTENSIONS env var', () => {
    const headedBlock = sliceBetween(BROWSER_HANDOFF_SRC, 'export async function launchHeaded', 'export async function handoff');
    expect(headedBlock).toContain("BROWSE_EXTENSIONS");
    expect(headedBlock).toContain("'none'");
  });

  test('handoff() checks BROWSE_EXTENSIONS env var', () => {
    const handoffBlock = sliceBetween(BROWSER_HANDOFF_SRC, 'export async function handoff', 'export async function resume');
    expect(handoffBlock).toContain("BROWSE_EXTENSIONS");
    expect(handoffBlock).toContain("'none'");
  });
});

// ─── BROWSE_EXTENSIONS=none Skips Extension Loading ─────────────

describe('BROWSE_EXTENSIONS=none behavior (source audit)', () => {
  test('launch() sets extensionsDir to undefined when mode is none', () => {
    const launchBlock = sliceBetween(BROWSER_MANAGER_SRC, 'async launch()', 'async close()');
    // Pattern: extensionMode !== 'none' ? <something> : undefined
    expect(launchBlock).toMatch(/extensionMode\s*!==\s*'none'\s*\?\s*\S+\s*:\s*undefined/);
  });

  test('launchHeaded() sets extensionPath to null when mode is none', () => {
    const headedBlock = sliceBetween(BROWSER_HANDOFF_SRC, 'export async function launchHeaded', 'export async function handoff');
    // Pattern: extensionMode !== 'none' ? <something> : null
    expect(headedBlock).toMatch(/extensionMode\s*!==\s*'none'\s*\?\s*\S+\s*:\s*null/);
  });

  test('handoff() sets extensionPath to null when mode is none', () => {
    const handoffBlock = sliceBetween(BROWSER_HANDOFF_SRC, 'export async function handoff', 'export async function resume');
    // Same pattern as launchHeaded
    expect(handoffBlock).toMatch(/extensionMode\s*!==\s*'none'\s*\?\s*\S+\s*:\s*null/);
  });

  test('extensions are only loaded when extensionsDir/extensionPath is truthy', () => {
    const launchBlock = sliceBetween(BROWSER_MANAGER_SRC, 'async launch()', 'async close()');
    // The extension loading block is gated by: if (extensionsDir)
    expect(launchBlock).toMatch(/if\s*\(extensionsDir\)/);

    const headedBlock = sliceBetween(BROWSER_HANDOFF_SRC, 'export async function launchHeaded', 'export async function handoff');
    // The extension loading block is gated by: if (extensionPath)
    expect(headedBlock).toMatch(/if\s*\(extensionPath\)/);
  });
});
