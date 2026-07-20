/**
 * [INPUT]: Pure module — no imports (uses the global URL).
 * [OUTPUT]: navFailureHint(info) + isNotFoundBody(sample) + extractQuery(url).
 * [POS]: Navigation-assist for weak drivers. A failed goto — a 4xx/5xx status OR a
 *        soft-404 "page not found" body served at 200 — leaves a weak model looping on
 *        guessed (often stale) URLs, the dominant residual wall after the perception
 *        layer. This turns the failure into ONE next-move line: use THIS site's own
 *        search or its homepage, not another guess. General: keyed on HTTP status + a
 *        not-found content signature, never a hostname. Wired into the `goto` handler.
 */

export interface NavResult {
  status: number | string;   // HTTP status from the goto response ('unknown' when none)
  finalUrl: string;          // page.url() after nav (may differ from requested on redirect)
  requestedUrl: string;      // the URL the caller asked for
  bodySample?: string;       // title + short body slice, for soft-404 detection
}

// ---------------------------------------------------------------------------
// "Not found" / "no results" across the common phrasings + a few non-English.
// Kept deliberately conservative so a real page mentioning "not found" in prose
// is unlikely to trip it (the leading anchors bias toward error-page boilerplate).
// ---------------------------------------------------------------------------
const NOT_FOUND_RE =
  /\b(?:404 (?:error|not found)|page not found|page (?:you are|you're|isn'?t|is not)[\w\s]{0,30}(?:available|found)|no results?(?: found| were found| for)?|does not exist|doesn'?t exist|couldn'?t find|could not find|cannot be found|we'?re sorry)\b|页面不存在|找不到|无法找到|未找到/i;

// Search-ish query-string keys that carry a real user term on a failed URL.
const QUERY_KEYS = /^(q|query|search|s|keyword|kw|term|cond|wd|word|term_search)$/i;

/** True when a 200-status body is really a soft-404 / no-results error page. */
export function isNotFoundBody(sample: string | undefined): boolean {
  if (!sample) return false;
  return NOT_FOUND_RE.test(sample);
}

// ---------------------------------------------------------------------------
// extractQuery — seed CONCRETE search terms from a failed URL so the hint carries
// a copy-ready `search "<terms>"` example (weak models imitate concrete examples).
// Prefer real query-param values (cond=cancer) over the path (often the model's bad
// guess); fall back to de-slugging the last path segment.
// ---------------------------------------------------------------------------
export function extractQuery(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return ''; }
  const terms: string[] = [];
  for (const [key, value] of u.searchParams) {
    if (QUERY_KEYS.test(key) && value.trim()) terms.push(value.trim());
  }
  if (terms.length === 0) {
    const seg = u.pathname.split('/').filter(Boolean).pop() || '';
    const deslugged = seg.replace(/\.[a-z0-9]+$/i, '').replace(/[-_+]+/g, ' ').trim();
    if (deslugged && !/^(index|home|results?|search)$/i.test(deslugged)) terms.push(deslugged);
  }
  // Dedupe words, cap length so the seed stays short.
  const words = terms.join(' ').split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= 6) break;
  }
  return out.join(' ');
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

// The shared recovery block: don't re-guess a URL, drive the site's own search / homepage.
function recoveryLines(reason: string, origin: string, query: string): string {
  const searchExample = query ? `search "${query}"` : 'search "<your terms>"';
  const lines = [
    `nav: this URL did not load a real page (${reason}). Guessing another URL usually fails again; a model's URL knowledge is often stale. Instead:`,
    `  • ${searchExample}  — drive THIS site's own search box (finds the right page for you)`,
  ];
  if (origin) lines.push(`  • goto ${origin}/  — start from the homepage and navigate from there`);
  return lines.join('\n');
}

/**
 * One recovery line for a failed goto, or '' when the navigation succeeded.
 * Failure = HTTP status >= 400, OR a not-found content signature at any status.
 */
export function navFailureHint(info: NavResult): string {
  const code = typeof info.status === 'number' ? info.status : parseInt(String(info.status), 10) || 0;
  const failed = code >= 400 || isNotFoundBody(info.bodySample);
  if (!failed) return '';
  const reason = code >= 400 ? String(code) : 'page not found';
  const origin = originOf(info.finalUrl || info.requestedUrl);
  const query = extractQuery(info.finalUrl) || extractQuery(info.requestedUrl);
  return recoveryLines(reason, origin, query);
}

/**
 * Recovery guidance for a goto that THREW (timeout / DNS / connection refused) instead of
 * returning a response — often a slow or dead deep URL whose site root + search still work.
 * Keeps a weak model from looping on goto retries.
 */
export function navErrorHint(requestedUrl: string, errMessage: string): string {
  const reason = /timeout|timed out/i.test(errMessage) ? 'timed out' : 'could not connect';
  return recoveryLines(reason, originOf(requestedUrl), extractQuery(requestedUrl));
}
