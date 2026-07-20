/**
 * [INPUT]: Pure module — no imports.
 * [OUTPUT]: Exports SearchInputCandidate + rankSearchInput.
 * [POS]: Navigation-assist for weak drivers. A weak model guesses (often stale) URLs
 *        instead of using a site's own search box — the residual "navigation" wall after
 *        the perception layer. This ranks a page's inputs to find the real search box so
 *        the `search` primitive can fill+submit it in one step. Page-general, no hostnames;
 *        only the DOM-walk that gathers candidates lives in write-commands (live-verified).
 */

export interface SearchInputCandidate {
  index: number;        // position in the page's input list (used to target the element)
  type?: string;        // input type attribute
  name?: string;
  ariaLabel?: string;
  placeholder?: string;
  role?: string;
  inSearchForm?: boolean; // inside a <form role="search"> or action*="search"
  visible: boolean;
}

const SEARCH_NAME = /^(q|query|search|s|keyword|kw|term|wd|word)$/i;
const SEARCH_TEXT = /search|搜索|搜寻|查询|查找/i;
// Types that can hold a free-text query. Everything else (password/email/checkbox/…) is out.
const TEXTUAL = new Set(['', 'text', 'search', undefined as unknown as string]);

function score(c: SearchInputCandidate): number {
  if (!c.visible) return -Infinity;
  const type = (c.type || '').toLowerCase();
  if (type === 'search') return 6;                 // unambiguous
  if ((c.role || '').toLowerCase() === 'searchbox') return 6;
  if (!TEXTUAL.has(type)) return -Infinity;        // password/email/number/checkbox/… — not a query box
  let s = 0;
  if (c.name && SEARCH_NAME.test(c.name)) s += 4;
  if (c.ariaLabel && SEARCH_TEXT.test(c.ariaLabel)) s += 3;
  if (c.placeholder && SEARCH_TEXT.test(c.placeholder)) s += 3;
  if (c.inSearchForm) s += 2;
  return s;
}

/** Index (into `cands`) of the best search input, or -1 when none is plausible. Pure. */
export function rankSearchInput(cands: SearchInputCandidate[]): number {
  let best = -1, bestScore = 0;
  for (let i = 0; i < cands.length; i++) {
    const s = score(cands[i]);
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}
