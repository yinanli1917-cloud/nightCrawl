/**
 * fingerprint-pinned must persist under the RESOLVED stateDir so that
 * BROWSE_STATE_FILE isolates it. The store was hardcoded to
 * $HOME/.nightcrawl/state, so it leaked the pinned-vendor cache across
 * otherwise-isolated daemon runs (e.g. benchmark ablation conditions),
 * contaminating the vendor half of every site-type profile key.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { markPinnedObserved, pinnedVendor, isPinned } from '../src/fingerprint-pinned';

describe('fingerprint-pinned — state path honors BROWSE_STATE_FILE', () => {
  test('persists under the resolved stateDir, not $HOME/.nightcrawl', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pin-'));
    // HOME also points into TMP so even the OLD (buggy) path stays in the
    // sandbox and never touches the user's real ~/.nightcrawl state.
    const env = {
      ...process.env,
      HOME: TMP,
      BROWSE_STATE_FILE: path.join(TMP, 'state', 'browse.json'),
    };

    markPinnedObserved('https://example.com/x', 'cloudflare', env);

    // BROWSE_STATE_FILE derives stateDir = TMP/state, so the store lands here.
    const wanted = path.join(TMP, 'state', 'fingerprint-pinned.json');
    expect(fs.existsSync(wanted)).toBe(true);
    expect(pinnedVendor('https://example.com/x', env)).toBe('cloudflare');
    expect(isPinned('https://example.com/x', env)).toBe(true);
  });
});
