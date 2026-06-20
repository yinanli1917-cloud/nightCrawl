/**
 * [INPUT]: None (pure command → CDP mapping).
 * [OUTPUT]: Exports CdpCall, BRIDGE_COMMANDS, isBridgeCommand, toCdp.
 * [POS]: Phase-3B bridge — the daemon translates a nightcrawl command into the
 *        CDP method+params the extension runs via chrome.debugger.sendCommand.
 *
 * Minimal relay surface only: navigate / read / snapshot / screenshot / click /
 * fill / js. Bulk crawl and file upload deliberately stay on the headless engine
 * (real-browser control can't drive file inputs, and bulk work is where headless
 * wins) — see strategy-advisor.ts.
 *
 * Selectors/values are ALWAYS JSON-encoded into the evaluate expression, never
 * raw-interpolated, so a hostile page value can't break out and inject script.
 */

export interface CdpCall {
  method: string;
  params: Record<string, any>;
}

export const BRIDGE_COMMANDS = new Set([
  'goto', 'text', 'html', 'snapshot', 'screenshot', 'click', 'fill', 'js', 'eval',
]);

export function isBridgeCommand(command: string): boolean {
  return BRIDGE_COMMANDS.has(command);
}

function evaluate(expression: string): CdpCall {
  // awaitPromise: an in-page `async` expression returns a Promise; without this CDP
  // serializes the still-pending Promise as `{}`. Awaiting resolves it first. It is
  // a no-op for non-Promise results, so it is safe on every evaluate command.
  return {
    method: 'Runtime.evaluate',
    params: { expression, returnByValue: true, awaitPromise: true },
  };
}

export function toCdp(command: string, args: string[]): CdpCall {
  switch (command) {
    case 'goto':
      return { method: 'Page.navigate', params: { url: args[0] ?? '' } };

    case 'text':
      return evaluate('document.body ? document.body.innerText : ""');

    case 'html':
    case 'snapshot':
      return evaluate('document.documentElement.outerHTML');

    case 'screenshot':
      return { method: 'Page.captureScreenshot', params: { format: 'png' } };

    case 'js':
    case 'eval':
      return evaluate(args[0] ?? '');

    case 'click': {
      // Fallback only. The real path is a TRUSTED gesture (clickProbeCall +
      // mouseClickCalls); the extension uses this JS-click only when the element
      // has no box (off-screen / zero-size), where Input coords don't exist.
      const sel = JSON.stringify(args[0] ?? '');
      return evaluate(
        `(() => { const el = document.querySelector(${sel}); if (!el) throw new Error('no element: ' + ${sel}); ` +
        `el.scrollIntoView({block:'center'}); el.click(); return true; })()`,
      );
    }

    case 'fill': {
      const sel = JSON.stringify(args[0] ?? '');
      const val = JSON.stringify(args[1] ?? '');
      return evaluate(
        `(() => { const el = document.querySelector(${sel}); if (!el) throw new Error('no element: ' + ${sel}); ` +
        `el.focus(); el.value = ${val}; ` +
        `el.dispatchEvent(new Event('input', {bubbles:true})); ` +
        `el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`,
      );
    }

    default:
      throw new Error(`Command '${command}' is not part of the real-browser bridge surface.`);
  }
}

// ─── Trusted click (A2) ──────────────────────────────────────
// el.click() fires an isTrusted:false event that bot-managed sites reject, and it
// will not submit a password the browser native-autofilled (the browser only
// releases an autofilled credential on a real user gesture). A CDP
// Input.dispatchMouseEvent IS isTrusted:true. The gesture is two steps because
// the second needs coordinates from the first — so it lives in the extension's
// execute(); these pure builders are the unit-tested spec it mirrors.
//
// Coordinate source: the extension resolves coords via CDP DOM.getBoxModel (which
// works on a non-selected background tab), NOT page getBoundingClientRect.
// clickProbeCall below is the JS-coordinate fallback variant.
//
// Non-disruptive by design: the extension creates its work tab in the user's
// CURRENT window with active:false and drives it with Emulation.setFocusEmulationEnabled
// on, so this gesture lands on the background tab without switching the user's view
// or popping a window — it never steals the user's focus.

/**
 * Probe an element's click point: scroll it into view and return its viewport
 * center {x, y}, or null if it's missing or has no box. Selector is JSON-encoded.
 */
export function clickProbeCall(selector: string): CdpCall {
  const sel = JSON.stringify(selector);
  return evaluate(
    `(() => { const el = document.querySelector(${sel}); if (!el) return null; ` +
    `el.scrollIntoView({block:'center',inline:'center'}); ` +
    `const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null; ` +
    `return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
}

/**
 * A trusted left click at viewport coords: move → press → release. CDP marks
 * these events isTrusted:true, so sites that gate on trusted input accept them
 * and the browser releases any native-autofilled credential on submit.
 */
export function mouseClickCalls(x: number, y: number): CdpCall[] {
  // The `buttons` bitmask is REQUIRED: without it Chromium dispatches the raw
  // mouse events but never synthesizes the DOM click. Left = bit 1; held during
  // the press, cleared on release. (Matches Puppeteer/Playwright.)
  return [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, button: 'none', buttons: 0 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 } },
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 } },
  ];
}
