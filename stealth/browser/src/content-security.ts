/**
 * Content security pipeline — 4-layer defense against prompt injection
 *
 * [INPUT]: Raw page content from Playwright commands
 * [OUTPUT]: Sanitized content safe for AI agent consumption
 * [POS]: Security layer between browser engine and agent output
 *
 * Layers:
 *   1. Hidden element stripping — detect/remove CSS-hidden injections
 *   2. Exfiltration URL blocklist — block known data-capture services
 *   3. Datamarking — watermark text with session-scoped zero-width Unicode
 *   4. Content envelope — strong trust boundary markers with escape prevention
 */

import { randomBytes } from 'crypto';
import type { Page, Frame } from 'playwright';

// ─── Layer 1: Hidden Element Stripping ─────────────────────────

/** ARIA label patterns that indicate injection attempts */
const ARIA_INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all)\s+instructions?/i,
  /you\s+are\s+(now|a)\s+/i,
  /system\s*:\s*/i,
  /\bdo\s+not\s+(follow|obey|listen)/i,
  /\bexecute\s+(the\s+)?following/i,
  /\bforget\s+(everything|all|your)/i,
  /\bnew\s+instructions?\s*:/i,
  /\breveal\s+(your|the)\s+(system|prompt)/i,
  /\benter\s+(developer|debug|admin)\s+mode/i,
];

export interface StripResult {
  strippedText: string;
  warnings: string[];
}

/**
 * Strip hidden elements from a page and return clean text.
 * Runs entirely in browser context via page.evaluate().
 *
 * Detection criteria (11 techniques):
 *   - opacity < 0.1
 *   - font-size < 1px
 *   - off-screen positioning (absolute/fixed beyond viewport)
 *   - visibility: hidden
 *   - display: none
 *   - clip-path: inset(100%) or clip: rect(0,0,0,0)
 *   - same foreground/background color (low contrast)
 *   - overflow: hidden with height: 0 or width: 0
 *   - aria-hidden="true" with text content
 *   - ARIA label injection patterns
 *   - HTML comments with instruction-like text (handled separately)
 */
export async function stripHiddenElements(page: Page | Frame): Promise<StripResult> {
  const ariaPatternSources = ARIA_INJECTION_PATTERNS.map(p => p.source);

  const warnings: string[] = await page.evaluate((patterns: string[]) => {
    const found: string[] = [];
    const body = document.body;
    if (!body) return found;

    const elements = body.querySelectorAll('*');
    for (const el of elements) {
      if (!(el instanceof HTMLElement)) continue;

      const text = el.textContent?.trim() || '';
      if (!text) continue;

      const style = window.getComputedStyle(el);
      let isHidden = false;
      let reason = '';

      // 1. opacity < 0.1
      const opacity = parseFloat(style.opacity);
      if (opacity < 0.1) {
        isHidden = true;
        reason = `opacity: ${opacity}`;
      }
      // 2. font-size < 1px
      else if (parseFloat(style.fontSize) < 1) {
        isHidden = true;
        reason = `font-size: ${style.fontSize}`;
      }
      // 3. off-screen positioning
      else if (style.position === 'absolute' || style.position === 'fixed') {
        const rect = el.getBoundingClientRect();
        if (rect.right < -100 || rect.bottom < -100 ||
            rect.left > window.innerWidth + 100 || rect.top > window.innerHeight + 100) {
          isHidden = true;
          reason = 'off-screen';
        }
      }
      // 4. visibility: hidden
      if (!isHidden && style.visibility === 'hidden') {
        isHidden = true;
        reason = 'visibility: hidden';
      }
      // 5. display: none
      if (!isHidden && style.display === 'none') {
        isHidden = true;
        reason = 'display: none';
      }
      // 6. clip-path / clip hiding
      if (!isHidden && (
        style.clipPath === 'inset(100%)' ||
        style.clip === 'rect(0px, 0px, 0px, 0px)'
      )) {
        isHidden = true;
        reason = 'clip hiding';
      }
      // 7. same fg/bg color (text.length > 10 to avoid false positives on icons)
      if (!isHidden && style.color === style.backgroundColor && text.length > 10) {
        isHidden = true;
        reason = 'same fg/bg color';
      }
      // 8. overflow: hidden with zero dimensions
      if (!isHidden && style.overflow === 'hidden') {
        const h = parseFloat(style.height);
        const w = parseFloat(style.width);
        if ((h === 0 || w === 0) && text.length > 0) {
          isHidden = true;
          reason = 'overflow: hidden + zero dimension';
        }
      }
      // 9. aria-hidden="true" with text
      if (!isHidden && el.getAttribute('aria-hidden') === 'true' && text.length > 0) {
        isHidden = true;
        reason = 'aria-hidden="true"';
      }

      if (isHidden) {
        el.setAttribute('data-nc-hidden', 'true');
        found.push(`[${el.tagName.toLowerCase()}] ${reason}: "${text.slice(0, 80)}"`);
      }

      // 10. ARIA label injection (independent of visibility)
      const ariaLabel = el.getAttribute('aria-label') || '';
      if (ariaLabel) {
        for (const patternSrc of patterns) {
          if (new RegExp(patternSrc, 'i').test(ariaLabel)) {
            el.setAttribute('data-nc-hidden', 'true');
            found.push(`[${el.tagName.toLowerCase()}] ARIA injection: "${ariaLabel.slice(0, 80)}"`);
            break;
          }
        }
      }
    }

    return found;
  }, ariaPatternSources);

  // Extract clean text with hidden elements removed
  const strippedText = await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    const clone = body.cloneNode(true) as HTMLElement;
    // Remove standard noise
    clone.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
    // Remove hidden-marked elements
    clone.querySelectorAll('[data-nc-hidden]').forEach(el => el.remove());
    const text = clone.innerText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
    return text;
  });

  // Clean up markers from live DOM
  await page.evaluate(() => {
    document.querySelectorAll('[data-nc-hidden]').forEach(el => {
      el.removeAttribute('data-nc-hidden');
    });
  });

  return { strippedText, warnings };
}

// ─── Layer 2: Exfiltration URL Blocklist ───────────────────────

export const EXFILTRATION_DOMAINS = [
  'requestbin.com',
  'pipedream.com',
  'webhook.site',
  'hookbin.com',
  'requestcatcher.com',
  'burpcollaborator.net',
  'oastify.com',
  'interact.sh',
  'canarytokens.com',
  'ngrok.io',
  'ngrok-free.app',
  'loca.lt',
  'serveo.net',
];

/**
 * Check if a URL points to a known exfiltration/data-capture service.
 * Applied to: goto command, link clicks, form actions.
 */
export function isExfiltrationUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  for (const domain of EXFILTRATION_DOMAINS) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      return true;
    }
  }
  return false;
}

// ─── Layer 3: Datamarking ──────────────────────────────────────

// Zero-width characters used for binary encoding
const ZW_ZERO = '\u200B'; // zero-width space = bit 0
const ZW_ONE = '\u200C';  // zero-width non-joiner = bit 1
const ZW_SEP = '\u200D';  // zero-width joiner = separator
const ZW_MARK = '\uFEFF'; // byte order mark = datamark start sentinel

let _sessionNonce: string | null = null;

/** Reset session (for testing) */
export function resetDatamarkSession(): void {
  _sessionNonce = null;
}

function ensureNonce(): string {
  if (!_sessionNonce) {
    _sessionNonce = randomBytes(4).toString('hex');
  }
  return _sessionNonce;
}

/** Encode a string as zero-width characters (binary encoding) */
function encodeZeroWidth(text: string): string {
  const bytes = Buffer.from(text, 'utf-8');
  let result = ZW_MARK; // sentinel
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) {
      result += (byte >> i) & 1 ? ZW_ONE : ZW_ZERO;
    }
    result += ZW_SEP;
  }
  return result;
}

/** Decode zero-width characters back to string */
function decodeZeroWidth(encoded: string): string | null {
  const startIdx = encoded.indexOf(ZW_MARK);
  if (startIdx === -1) return null;

  const zwChars = encoded.slice(startIdx + 1);
  const bytes: number[] = [];
  let currentByte = 0;
  let bitCount = 0;

  for (const ch of zwChars) {
    if (ch === ZW_SEP) {
      if (bitCount === 8) {
        bytes.push(currentByte);
      }
      currentByte = 0;
      bitCount = 0;
      continue;
    }
    if (ch === ZW_ZERO) {
      currentByte = (currentByte << 1) | 0;
      bitCount++;
    } else if (ch === ZW_ONE) {
      currentByte = (currentByte << 1) | 1;
      bitCount++;
    }
    // Skip non-ZW chars
  }

  if (bytes.length === 0) return null;
  return Buffer.from(bytes).toString('utf-8');
}

/**
 * Add a session-scoped watermark to text content.
 * Inserts zero-width encoded session ID after the first sentence boundary.
 * Only modifies text that has sentence boundaries (". " pattern).
 */
export function addDatamark(text: string, sessionId: string): string {
  const marker = encodeZeroWidth(sessionId);
  // Insert after first sentence boundary
  const idx = text.indexOf('. ');
  if (idx === -1) return text; // no sentence boundary, leave unchanged
  return text.slice(0, idx + 2) + marker + text.slice(idx + 2);
}

/**
 * Detect and extract a datamark from text.
 * Returns the session ID if found, null otherwise.
 */
export function detectDatamark(text: string): string | null {
  return decodeZeroWidth(text);
}

// ─── Layer 4: Content Envelope ─────────────────────────────────

export const ENVELOPE_BEGIN = '════════ BEGIN UNTRUSTED WEB CONTENT ════════';
export const ENVELOPE_END = '════════ END UNTRUSTED WEB CONTENT ════════';

/**
 * Wrap content in a strong trust boundary envelope.
 * Escapes ALL known boundary-forging techniques:
 *   - Literal marker strings in content
 *   - Unicode box-drawing homoglyphs
 *   - Newline injection via URL
 */
export function wrapContentEnvelope(content: string, url: string): string {
  // Sanitize URL: strip newlines, truncate
  const safeUrl = url.replace(/[\n\r]/g, '').slice(0, 200);

  // Session nonce makes each envelope unique (harder to forge)
  const nonce = ensureNonce();

  // Escape envelope markers in content using zero-width space injection
  const zwsp = '\u200B';
  const safeContent = content
    .replace(/════════ BEGIN UNTRUSTED WEB CONTENT ════════/g,
      `════════ BEGIN UNTRUSTED WEB C${zwsp}ONTENT ════════`)
    .replace(/════════ END UNTRUSTED WEB CONTENT ════════/g,
      `════════ END UNTRUSTED WEB C${zwsp}ONTENT ════════`)
    // Also catch partial markers (triple box-drawing chars)
    .replace(/═══/g, `═${zwsp}══`);

  return [
    `${ENVELOPE_BEGIN} (source: ${safeUrl}) (nonce: ${nonce})`,
    safeContent,
    ENVELOPE_END,
  ].join('\n');
}

// ─── HTML Comment Injection Stripping ──────────────────────────

const COMMENT_INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all)\s+instructions?/i,
  /you\s+are\s+(now|a)\s+/i,
  /system\s*:\s*/i,
  /\bdo\s+not\s+(follow|obey|listen)/i,
  /\bexecute\s+(the\s+)?following/i,
  /\bforget\s+(everything|all|your)/i,
  /\bnew\s+instructions?\s*:/i,
  /\benter\s+(developer|debug|admin)\s+mode/i,
  /\breveal\s+(your|the)\s+(system|prompt)/i,
];

/**
 * Strip HTML comments that contain instruction-like injection patterns.
 * Preserves normal comments (e.g., "navigation section", "TODO: fix").
 */
export function stripHtmlCommentInjections(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, (comment) => {
    const inner = comment.slice(4, -3); // strip <!-- and -->
    for (const pattern of COMMENT_INJECTION_PATTERNS) {
      if (pattern.test(inner)) return '';
    }
    return comment; // preserve non-suspicious comments
  });
}
