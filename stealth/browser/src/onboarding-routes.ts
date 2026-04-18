/**
 * Onboarding route handler — permission chooser HTTP endpoint
 *
 * [INPUT]: Depends on onboarding's saveOnboardingConfig
 * [INPUT]: Depends on cookie-import-browser's findInstalledBrowsers
 * [OUTPUT]: Exports handleOnboardingRoute
 * [POS]: HTTP glue for onboarding within browser module
 *
 * Routes (no auth — localhost-only, opened in user's browser):
 *   GET  /onboarding         -> serves the permission chooser HTML page
 *   POST /onboarding/choose  -> saves mode to config, returns success HTML
 */

import { saveOnboardingConfig, type CookieMode } from './onboarding';
import { findInstalledBrowsers } from './cookie-import-browser';

// ─── Constants ──────────────────────────────────────────────────

const VALID_MODES = new Set<CookieMode>(['full', 'ask', 'manual']);

// ─── Route Handler ──────────────────────────────────────────────

/**
 * Handle onboarding routes. Returns null for non-matching paths
 * so server.ts can fall through to command dispatch.
 */
export async function handleOnboardingRoute(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === '/onboarding' && req.method === 'GET') {
    return serveChooserPage();
  }

  if (pathname === '/onboarding/choose' && req.method === 'POST') {
    return handleChoose(req);
  }

  return null;
}

// ─── GET /onboarding ────────────────────────────────────────────

function detectDefaultBrowserName(): string {
  const installed = findInstalledBrowsers();
  return installed.length > 0 ? installed[0].name : 'your browser';
}

function serveChooserPage(): Response {
  const browserName = detectDefaultBrowserName();
  const html = buildChooserHTML(browserName);
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ─── POST /onboarding/choose ────────────────────────────────────

async function handleChoose(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const mode = body?.mode;
  if (!mode || !VALID_MODES.has(mode)) {
    return new Response(
      JSON.stringify({ error: `Invalid mode: ${mode}. Expected full, ask, or manual.` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  saveOnboardingConfig(mode as CookieMode);

  return new Response(buildSuccessHTML(), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ─── HTML Builders ──────────────────────────────────────────────

function buildChooserHTML(browserName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup — nightCrawl</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 24px; background: #f5f5f7; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0a; color: #f5f5f7; }
    .card { background: #1c1c1e; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
    .subtitle, .btn-desc { color: #98989d; }
    .btn-secondary { background: #2c2c2e; color: #f5f5f7; }
    .btn-secondary:hover { background: #3a3a3c; }
    .btn-tertiary { color: #98989d; }
    .btn-tertiary:hover { color: #f5f5f7; background: #2c2c2e; }
  }
  .card { max-width: 440px; width: 100%; background: #fff; border-radius: 20px; padding: 40px 32px; box-shadow: 0 8px 32px rgba(0,0,0,0.08); text-align: center; }
  .moon { font-size: 48px; margin-bottom: 16px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  .subtitle { font-size: 15px; line-height: 1.5; color: #6e6e73; margin-bottom: 32px; }
  .prompt { font-size: 14px; font-weight: 600; margin-bottom: 20px; }
  .buttons { display: flex; flex-direction: column; gap: 12px; }
  button { width: 100%; border: none; border-radius: 12px; padding: 14px 20px; font-family: inherit; font-size: 15px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; text-align: left; }
  .btn-primary { background: #0071e3; color: #fff; }
  .btn-primary:hover { background: #0077ed; transform: scale(1.01); }
  .btn-secondary { background: #f0f0f0; color: #1d1d1f; }
  .btn-secondary:hover { background: #e8e8e8; }
  .btn-tertiary { background: transparent; color: #6e6e73; font-weight: 500; }
  .btn-tertiary:hover { background: #f0f0f0; color: #1d1d1f; }
  .btn-desc { font-size: 13px; font-weight: 400; color: #6e6e73; margin-top: 4px; line-height: 1.4; }
</style>
</head>
<body>
  <div class="card">
    <div class="moon">\u{1F319}</div>
    <h1>nightCrawl Setup</h1>
    <p class="subtitle">
      nightCrawl needs access to your browser cookies to browse the web as you.<br>
      Your cookies never leave your machine. Not even the AI can see them.
    </p>
    <p class="prompt">How would you like to handle cookies?</p>
    <div class="buttons">
      <button class="btn-primary" onclick="choose('full')">
        \u{1F513} Import All
        <div class="btn-desc">Import all cookies from ${esc(browserName)}.<br>Best for personal computers.</div>
      </button>
      <button class="btn-secondary" onclick="choose('ask')">
        \u{1F512} Ask Each Time
        <div class="btn-desc">nightCrawl will ask before importing<br>cookies from each new website.</div>
      </button>
      <button class="btn-tertiary" onclick="choose('manual')">
        \u26D4 Manual Only
        <div class="btn-desc">Never auto-import. You'll run<br>cookie-import-browser yourself.</div>
      </button>
    </div>
  </div>
  <script>
    async function choose(mode) {
      document.querySelectorAll('button').forEach(b => b.disabled = true);
      try {
        const res = await fetch('/onboarding/choose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        if (res.ok) {
          document.body.innerHTML = await res.text();
        } else {
          const err = await res.json().catch(() => ({ error: 'Unknown error' }));
          alert(err.error || 'Something went wrong.');
          document.querySelectorAll('button').forEach(b => b.disabled = false);
        }
      } catch (e) {
        alert('Could not reach nightCrawl. Is the daemon running?');
        document.querySelectorAll('button').forEach(b => b.disabled = false);
      }
    }
  </script>
</body>
</html>`;
}

function buildSuccessHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Setup Complete — nightCrawl</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 24px; background: #f5f5f7; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #f5f5f7; } .card { background: #1c1c1e; box-shadow: 0 8px 32px rgba(0,0,0,0.5); } .hint { color: #98989d; } }
  .card { max-width: 400px; width: 100%; background: #fff; border-radius: 20px; padding: 48px 32px; box-shadow: 0 8px 32px rgba(0,0,0,0.08); text-align: center; }
  .check { font-size: 56px; margin-bottom: 16px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
  .hint { font-size: 14px; color: #6e6e73; }
</style>
</head>
<body>
  <div class="card">
    <div class="check">\u2705</div>
    <h1>Setup complete!</h1>
    <p class="hint">You can close this tab.</p>
  </div>
</body>
</html>`;
}

// ─── Helpers ────────────────────────────────────────────────────

/** Escape HTML special characters for safe template interpolation. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
