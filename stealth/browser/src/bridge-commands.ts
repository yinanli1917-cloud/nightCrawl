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
  return { method: 'Runtime.evaluate', params: { expression, returnByValue: true } };
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
