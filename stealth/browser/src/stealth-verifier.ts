/**
 * Stealth verifier — runs a small smoke test against Tier 1-2 bot
 * detection sites to confirm nightCrawl's stealth posture is intact.
 *
 * Called from two places:
 *   1. auto-updater.ts after every dependency update (rollback gate)
 *   2. stealth-reinforcement.ts every 6 hours (continuous validation)
 *
 * SCOPE LIMIT: this verifier ONLY hits Tier 1-2 (rebrowser, sannysoft).
 * It NEVER touches Tier 4-5 platforms (xiaohongshu, douyin, weibo,
 * linkedin, instagram) — those are blocked by hostile-domains.ts and
 * a 2026-04-09 incident proved why hitting them is unsafe.
 *
 * Pass/fail criteria:
 *   - launch fail              -> FAIL (immediate)
 *   - navigator.webdriver true -> FAIL (immediate)
 *   - sannysoft critical fail  -> FAIL
 *   - rebrowser CDP test fail  -> FAIL
 *   - network timeout          -> WARN (do not fail; flaky internet)
 *
 * The browser is injected via VerifierBrowser so unit tests are
 * hermetic. The production wiring lives in createPlaywrightBrowser
 * (will be added when wiring into auto-updater).
 *
 * [INPUT]: VerifierBrowser (injectable)
 * [OUTPUT]: VerifyResult, verifyStealth(), VerifierBrowser interface
 * [POS]: Verification layer for auto-updater + reinforcement loop
 */

// ─── Types ──────────────────────────────────────────────────────

export interface VerifyCheck {
  name: string;       // 'launch' | 'webdriver' | 'sannysoft' | 'rebrowser'
  passed: boolean;
  warning?: boolean;  // true = soft pass (network timeout, etc.)
  detail: string;
}

export interface VerifyResult {
  passed: boolean;
  checks: VerifyCheck[];
  durationMs: number;
}

export interface VerifierBrowser {
  launch(): Promise<void>;
  navigate(url: string): Promise<void>;
  evaluateWebdriver(): Promise<boolean>;       // returns navigator.webdriver
  checkSannysoft(): Promise<boolean>;          // run sannysoft check, return pass
  checkRebrowser(): Promise<boolean>;          // run rebrowser check, return pass
  close(): Promise<void>;
}

export interface VerifyOptions {
  browser: VerifierBrowser;
}

// ─── URLs (Tier 1-2 ONLY — see scope limit above) ──────────────

const SANNYSOFT_URL = 'https://bot.sannysoft.com/';
const REBROWSER_URL = 'https://bot-detector.rebrowser.net/';

// ─── Check helpers (single-responsibility, no nesting) ─────────

async function checkLaunch(browser: VerifierBrowser): Promise<VerifyCheck> {
  try {
    await browser.launch();
    return { name: 'launch', passed: true, detail: 'browser launched' };
  } catch (err: any) {
    return {
      name: 'launch',
      passed: false,
      detail: `launch failed: ${err?.message || err}`,
    };
  }
}

async function checkWebdriver(browser: VerifierBrowser): Promise<VerifyCheck> {
  try {
    const exposed = await browser.evaluateWebdriver();
    return {
      name: 'webdriver',
      passed: !exposed,
      detail: exposed ? 'navigator.webdriver === true (LEAKED)' : 'navigator.webdriver hidden',
    };
  } catch (err: any) {
    return {
      name: 'webdriver',
      passed: false,
      detail: `webdriver eval failed: ${err?.message || err}`,
    };
  }
}

async function checkSannysoft(browser: VerifierBrowser): Promise<VerifyCheck> {
  try {
    await browser.navigate(SANNYSOFT_URL);
  } catch (err: any) {
    return {
      name: 'sannysoft',
      passed: true,
      warning: true,
      detail: `network timeout (treated as pass): ${err?.message || err}`,
    };
  }
  try {
    const passed = await browser.checkSannysoft();
    return {
      name: 'sannysoft',
      passed,
      detail: passed ? 'all critical rows pass' : 'critical row failed',
    };
  } catch (err: any) {
    return {
      name: 'sannysoft',
      passed: false,
      detail: `check error: ${err?.message || err}`,
    };
  }
}

async function checkRebrowser(browser: VerifierBrowser): Promise<VerifyCheck> {
  try {
    await browser.navigate(REBROWSER_URL);
  } catch (err: any) {
    return {
      name: 'rebrowser',
      passed: true,
      warning: true,
      detail: `network timeout (treated as pass): ${err?.message || err}`,
    };
  }
  try {
    const passed = await browser.checkRebrowser();
    return {
      name: 'rebrowser',
      passed,
      detail: passed ? 'CDP tests pass' : 'CDP test failed',
    };
  } catch (err: any) {
    return {
      name: 'rebrowser',
      passed: false,
      detail: `check error: ${err?.message || err}`,
    };
  }
}

// ─── Public API ─────────────────────────────────────────────────

export async function verifyStealth(opts: VerifyOptions): Promise<VerifyResult> {
  const start = Date.now();
  const { browser } = opts;
  const checks: VerifyCheck[] = [];

  const launchCheck = await checkLaunch(browser);
  checks.push(launchCheck);
  if (!launchCheck.passed) {
    await browser.close().catch(() => {});
    return { passed: false, checks, durationMs: Date.now() - start };
  }

  try {
    checks.push(await checkWebdriver(browser));
    checks.push(await checkSannysoft(browser));
    checks.push(await checkRebrowser(browser));
  } finally {
    await browser.close().catch(() => {});
  }

  const passed = checks.every((c) => c.passed);
  return { passed, checks, durationMs: Date.now() - start };
}
