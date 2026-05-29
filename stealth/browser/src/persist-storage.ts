/**
 * Persist browser cookies + page storage to ~/.nightcrawl/browse-cookies.json
 * so sessions survive daemon restarts and headless context closes.
 */

import * as fs from 'fs';
import type { BrowserManager } from './browser-manager';
import { resolveConfig } from './config';

export async function persistBrowserStorage(bm: BrowserManager): Promise<number> {
  if (process.env.BROWSE_INCOGNITO === '1') return 0;
  try {
    const state = await bm.saveState();
    const count = state.cookies.length;
    if (count === 0) return 0;
    const config = resolveConfig();
    const tmpFile = config.storageFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmpFile, config.storageFile);
    return count;
  } catch {
    return 0;
  }
}
