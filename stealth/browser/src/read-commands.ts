/**
 * Read commands — extract data from pages without side effects
 *
 * text, html, links, forms, accessibility, js, eval, wait-for, css, attrs,
 * console, network, cookies, storage, perf
 *
 * js/eval run inside an async IIFE that always returns its value (promises resolve)
 * under a hard timeout; wait-for polls a JS predicate in-page (replaces sleep).
 */

import type { TabView } from './session-view';
import { consoleBuffer, networkBuffer, dialogBuffer } from './buffers';
import type { Page, Frame } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { TEMP_DIR, isPathWithin } from './platform';
import { stripHiddenElements } from './content-security';
import { gateJsCode } from './integrity-gate';
import { capOutput, parseFindArgs, findInPage, extractTables, readableText, findDataRequests } from './read-extract';
import { EMPTY_JS_HINT } from './error-coach';

/**
 * Stringify a js/eval result. An empty/undefined result is the bare-statement-list trap
 * (`const x = ...` returns nothing) — the #1 weak-model fumble — so coach the fix inline
 * instead of returning a blank that reads as "nothing happened".
 */
function jsResultString(result: unknown): string {
  const out = typeof result === 'object' && result !== null ? JSON.stringify(result, null, 2) : String(result ?? '');
  return out === '' || out === 'undefined' ? `(js returned no value)\n${EMPTY_JS_HINT}` : out;
}

// ─── AsyncFunction ctor: PARSE-test whether code is a single returned expression ───
// Used only to parse `return (code)` (top-level `await` allowed). Parsing never
// resolves identifiers, so page-only globals (document, window, …) are irrelevant
// until the wrapped code actually runs inside page.evaluate().
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as FunctionConstructor;

/**
 * Wrap code for page.evaluate() in an async IIFE that ALWAYS returns its value, so a
 * promise (even one with no `await` keyword, e.g. `fetch(u).then(...)`) is awaited and
 * its resolved value comes back — parity with Engine R's awaitPromise. A single
 * expression — INCLUDING a block-body IIFE like `(() => { …; return x })()` — gets
 * `return (...)` injected; a genuine multi-statement list keeps its own `return`.
 *
 * The expression-vs-statements decision is made by actually PARSING `return (code)`
 * rather than sniffing for keywords. The old sniff misread block-body IIFEs (whose
 * `const`/`return`/`;` live inside their own braces) as statement lists, so the outer
 * IIFE never returned the value → the "nc js returned empty" bug. Exported for tests.
 */
export function wrapForEvaluate(code: string): string {
  const trimmed = code.trim();
  const asExpr = `return (${trimmed})`;
  let body: string;
  try {
    new AsyncFunction(asExpr); // parses iff `code` is one (awaitable) expression
    body = asExpr;
  } catch {
    body = trimmed; // genuine statement list — the author owns its own `return`
  }
  return `(async () => { ${body} })()`;
}

/**
 * Resolve `eval`'s argument to code. If the arg is a short, existing file path, run its
 * contents; otherwise treat the arg AS inline code (same as `js`, and same as `eval` on
 * the real-browser engine). This makes `eval` forgiving and engine-consistent so the
 * IDENTICAL command never flips between working on one engine and "File not found" on the
 * other after a silent engine switch. `fs.existsSync` never throws (a too-long string just
 * reads as not-a-file), and the length guard avoids probing huge inline blobs. Exported
 * for tests.
 */
export function resolveEvalCode(arg: string): { code: string; fromFile: boolean } {
  let fromFile = false;
  try { fromFile = arg.length < 1024 && fs.existsSync(arg); } catch { fromFile = false; }
  return fromFile
    ? { code: fs.readFileSync(arg, 'utf-8'), fromFile: true }
    : { code: arg, fromFile: false };
}

// Cap a single in-page evaluate so a runaway fetch/promise fails fast instead of
// blocking past the bridge/command timeout (the Cursor-course 66s hang).
const JS_EVAL_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

// Security: Path validation to prevent path traversal attacks
// Resolve safe directories through realpathSync to handle symlinks (e.g., macOS /tmp → /private/tmp)
const SAFE_DIRECTORIES = [TEMP_DIR, process.cwd()].map(d => {
  try { return fs.realpathSync(d); } catch { return d; }
});

export function validateReadPath(filePath: string): void {
  // Always resolve to absolute first (fixes relative path symlink bypass)
  const resolved = path.resolve(filePath);
  // Resolve symlinks — throw on non-ENOENT errors
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // File doesn't exist — resolve directory part for symlinks (e.g., /tmp → /private/tmp)
      try {
        const dir = fs.realpathSync(path.dirname(resolved));
        realPath = path.join(dir, path.basename(resolved));
      } catch {
        realPath = resolved;
      }
    } else {
      throw new Error(`Cannot resolve real path: ${filePath} (${err.code})`);
    }
  }
  const isSafe = SAFE_DIRECTORIES.some(dir => isPathWithin(realPath, dir));
  if (!isSafe) {
    throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
  }
}

/**
 * Extract clean text from a page with content security stripping.
 * Strips script/style/noscript/svg AND CSS-hidden prompt injection elements.
 * Exported for DRY reuse in meta-commands (diff).
 */
export async function getCleanText(page: Page | Frame): Promise<string> {
  const result = await stripHiddenElements(page);
  // Log warnings to stderr for observability (but don't block output)
  if (result.warnings.length > 0) {
    console.error(`[content-security] Stripped ${result.warnings.length} hidden element(s)`);
  }
  return result.strippedText;
}

export async function handleReadCommand(
  command: string,
  args: string[],
  bm: TabView
): Promise<string> {
  const page = bm.getPage();
  // Frame-aware target for content extraction
  const target = bm.getActiveFrameOrPage();

  switch (command) {
    case 'text': {
      return capOutput(await getCleanText(target));
    }

    // ─── Forgiving high-level extraction (find/table/read/data) ───
    // Collapse the DOM-scraping a weak model can't reliably hand-write.
    case 'find': {
      const { keyword, context, all, regex } = parseFindArgs(args);
      if (!keyword) throw new Error('Usage: browse find <keyword> [-C N] [--all] [--re]');
      return capOutput(await findInPage(target, keyword, { context, all, regex }));
    }

    case 'table': {
      return capOutput(await extractTables(target, bm, args));
    }

    case 'read': {
      return capOutput(await readableText(target));
    }

    case 'data': {
      return findDataRequests(args);
    }

    case 'html': {
      const selector = args[0];
      if (selector) {
        const resolved = await bm.resolveRef(selector);
        if ('locator' in resolved) {
          return capOutput(await resolved.locator.innerHTML({ timeout: 5000 }));
        }
        return capOutput(await target.locator(resolved.selector).innerHTML({ timeout: 5000 }));
      }
      // page.content() is page-only; use evaluate for frame compat
      const doctype = await target.evaluate(() => {
        const dt = document.doctype;
        return dt ? `<!DOCTYPE ${dt.name}>` : '';
      });
      const html = await target.evaluate(() => document.documentElement.outerHTML);
      return capOutput(doctype ? `${doctype}\n${html}` : html);
    }

    case 'links': {
      const links = await target.evaluate(() =>
        [...document.querySelectorAll('a[href]')].map(a => ({
          text: a.textContent?.trim().slice(0, 120) || '',
          href: (a as HTMLAnchorElement).href,
        })).filter(l => l.text && l.href)
      );
      return links.map(l => `${l.text} → ${l.href}`).join('\n');
    }

    case 'forms': {
      const forms = await target.evaluate(() => {
        return [...document.querySelectorAll('form')].map((form, i) => {
          const fields = [...form.querySelectorAll('input, select, textarea')].map(el => {
            const input = el as HTMLInputElement;
            return {
              tag: el.tagName.toLowerCase(),
              type: input.type || undefined,
              name: input.name || undefined,
              id: input.id || undefined,
              placeholder: input.placeholder || undefined,
              required: input.required || undefined,
              value: input.type === 'password' ? '[redacted]' : (input.value || undefined),
              options: el.tagName === 'SELECT'
                ? [...(el as HTMLSelectElement).options].map(o => ({ value: o.value, text: o.text }))
                : undefined,
            };
          });
          return {
            index: i,
            action: form.action || undefined,
            method: form.method || 'get',
            id: form.id || undefined,
            fields,
          };
        });
      });
      return JSON.stringify(forms, null, 2);
    }

    case 'accessibility': {
      try {
        return await withTimeout(target.locator("body").ariaSnapshot(), 5000, 'accessibility snapshot');
      } catch (err: any) {
        const text = await getCleanText(target).catch(() => '');
        return [
          `(accessibility snapshot unavailable: ${err.message || String(err)})`,
          text.trim(),
        ].filter(Boolean).join('\n');
      }
    }

    case 'js': {
      const expr = args[0];
      if (!expr) throw new Error('Usage: browse js <expression>');
      const gate = gateJsCode(expr);
      if (gate.kind === 'confirm-required') {
        return `CONFIRM_REQUIRED: ${gate.reason}. This js asserts a fact to a third party — get explicit user confirmation first; nightcrawl will not run it unconfirmed.`;
      }
      const wrapped = wrapForEvaluate(expr);
      const result = await withTimeout(target.evaluate(wrapped), JS_EVAL_TIMEOUT_MS, 'js');
      return jsResultString(result);
    }

    case 'eval': {
      const arg = args[0];
      if (!arg) throw new Error('Usage: browse eval <js-file-or-expression>');
      // Forgiving + engine-consistent: a real file's contents, else the arg as inline code.
      const { code, fromFile } = resolveEvalCode(arg);
      if (fromFile) validateReadPath(arg); // path-safety only applies to real files
      const gate = gateJsCode(code);
      if (gate.kind === 'confirm-required') {
        return `CONFIRM_REQUIRED: ${gate.reason}. This code asserts a fact to a third party — get explicit user confirmation first; nightcrawl will not run it unconfirmed.`;
      }
      const wrapped = wrapForEvaluate(code);
      const result = await withTimeout(target.evaluate(wrapped), JS_EVAL_TIMEOUT_MS, 'eval');
      return jsResultString(result);
    }

    case 'wait-for': {
      const predicate = args[0];
      if (!predicate) throw new Error('Usage: browse wait-for <js-predicate> [timeoutMs]');
      const timeout = args[1] ? parseInt(args[1], 10) : 15000;
      // Native in-page polling (rAF/mutation), not a sleep loop — replaces the
      // Cursor-course `sleep 180/480` blocking waits with a real settle-wait.
      await target.waitForFunction(predicate, undefined, { timeout, polling: 'raf' });
      return `Predicate became truthy: ${predicate.slice(0, 120)}`;
    }

    case 'css': {
      const [selector, property] = args;
      if (!selector || !property) throw new Error('Usage: browse css <selector> <property>');
      const resolved = await bm.resolveRef(selector);
      if ('locator' in resolved) {
        const value = await resolved.locator.evaluate(
          (el, prop) => getComputedStyle(el).getPropertyValue(prop),
          property
        );
        return value;
      }
      const value = await target.evaluate(
        ([sel, prop]) => {
          const el = document.querySelector(sel);
          if (!el) return `Element not found: ${sel}`;
          return getComputedStyle(el).getPropertyValue(prop);
        },
        [resolved.selector, property]
      );
      return value;
    }

    case 'attrs': {
      const selector = args[0];
      if (!selector) throw new Error('Usage: browse attrs <selector>');
      const resolved = await bm.resolveRef(selector);
      if ('locator' in resolved) {
        const attrs = await resolved.locator.evaluate((el) => {
          const result: Record<string, string> = {};
          for (const attr of el.attributes) {
            result[attr.name] = attr.value;
          }
          return result;
        });
        return JSON.stringify(attrs, null, 2);
      }
      const attrs = await target.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return `Element not found: ${sel}`;
        const result: Record<string, string> = {};
        for (const attr of el.attributes) {
          result[attr.name] = attr.value;
        }
        return result;
      }, resolved.selector);
      return typeof attrs === 'string' ? attrs : JSON.stringify(attrs, null, 2);
    }

    case 'console': {
      if (args[0] === '--clear') {
        consoleBuffer.clear();
        return 'Console buffer cleared.';
      }
      const entries = args[0] === '--errors'
        ? consoleBuffer.toArray().filter(e => e.level === 'error' || e.level === 'warning')
        : consoleBuffer.toArray();
      if (entries.length === 0) return args[0] === '--errors' ? '(no console errors)' : '(no console messages)';
      return entries.map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`
      ).join('\n');
    }

    case 'network': {
      if (args[0] === '--clear') {
        networkBuffer.clear();
        return 'Network buffer cleared.';
      }
      if (networkBuffer.length === 0) return '(no network requests)';
      return networkBuffer.toArray().map(e =>
        `${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`
      ).join('\n');
    }

    case 'dialog': {
      if (args[0] === '--clear') {
        dialogBuffer.clear();
        return 'Dialog buffer cleared.';
      }
      if (dialogBuffer.length === 0) return '(no dialogs captured)';
      return dialogBuffer.toArray().map(e =>
        `[${new Date(e.timestamp).toISOString()}] [${e.type}] "${e.message}" → ${e.action}${e.response ? ` "${e.response}"` : ''}`
      ).join('\n');
    }

    case 'is': {
      const property = args[0];
      const selector = args[1];
      if (!property || !selector) throw new Error('Usage: browse is <property> <selector>\nProperties: visible, hidden, enabled, disabled, checked, editable, focused');

      const resolved = await bm.resolveRef(selector);
      let locator;
      if ('locator' in resolved) {
        locator = resolved.locator;
      } else {
        locator = target.locator(resolved.selector);
      }

      switch (property) {
        case 'visible':  return String(await locator.isVisible());
        case 'hidden':   return String(await locator.isHidden());
        case 'enabled':  return String(await locator.isEnabled());
        case 'disabled': return String(await locator.isDisabled());
        case 'checked':  return String(await locator.isChecked());
        case 'editable': return String(await locator.isEditable());
        case 'focused': {
          const isFocused = await locator.evaluate(
            (el) => el === document.activeElement
          );
          return String(isFocused);
        }
        default:
          throw new Error(`Unknown property: ${property}. Use: visible, hidden, enabled, disabled, checked, editable, focused`);
      }
    }

    case 'cookies': {
      const cookies = await page.context().cookies();
      return JSON.stringify(cookies, null, 2);
    }

    case 'storage': {
      if (args[0] === 'set' && args[1]) {
        const key = args[1];
        const value = args[2] || '';
        await target.evaluate(([k, v]: string[]) => localStorage.setItem(k, v), [key, value]);
        return `Set localStorage["${key}"]`;
      }
      const storage = await target.evaluate(() => ({
        localStorage: { ...localStorage },
        sessionStorage: { ...sessionStorage },
      }));
      // Redact values that look like secrets (tokens, keys, passwords, JWTs)
      const SENSITIVE_KEY = /(^|[_.-])(token|secret|key|password|credential|auth|jwt|session|csrf)($|[_.-])|api.?key/i;
      const SENSITIVE_VALUE = /^(eyJ|sk-|sk_live_|sk_test_|pk_live_|pk_test_|rk_live_|sk-ant-|ghp_|gho_|github_pat_|xox[bpsa]-|AKIA[A-Z0-9]{16}|AIza|SG\.|Bearer\s|sbp_)/;
      const redacted = JSON.parse(JSON.stringify(storage));
      for (const storeType of ['localStorage', 'sessionStorage'] as const) {
        const store = redacted[storeType];
        if (!store) continue;
        for (const [key, value] of Object.entries(store)) {
          if (typeof value !== 'string') continue;
          if (SENSITIVE_KEY.test(key) || SENSITIVE_VALUE.test(value)) {
            store[key] = `[REDACTED — ${value.length} chars]`;
          }
        }
      }
      return JSON.stringify(redacted, null, 2);
    }

    case 'perf': {
      const timings = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        if (!nav) return 'No navigation timing data available.';
        return {
          dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
          tcp: Math.round(nav.connectEnd - nav.connectStart),
          ssl: Math.round(nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0),
          ttfb: Math.round(nav.responseStart - nav.requestStart),
          download: Math.round(nav.responseEnd - nav.responseStart),
          domParse: Math.round(nav.domInteractive - nav.responseEnd),
          domReady: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
          load: Math.round(nav.loadEventEnd - nav.startTime),
          total: Math.round(nav.loadEventEnd - nav.startTime),
        };
      });
      if (typeof timings === 'string') return timings;
      return Object.entries(timings)
        .map(([k, v]) => `${k.padEnd(12)} ${v}ms`)
        .join('\n');
    }

    default:
      throw new Error(`Unknown read command: ${command}`);
  }
}
