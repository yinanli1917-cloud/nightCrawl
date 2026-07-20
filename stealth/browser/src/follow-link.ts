/**
 * [INPUT]: Pure module — no imports.
 * [OUTPUT]: LinkCandidate + rankLinks(cands, keyword).
 * [POS]: Navigation-assist for weak drivers. Reaching a target page is often a chain of
 *        "click the link that says X" (search result -> filing -> document). A weak model
 *        burns its step budget snapshotting the page and resolving @refs for each hop.
 *        `follow <keyword>` collapses one hop into a single keyword-driven step; this is
 *        its pure ranker (visible text > aria/title > href path). Page-general, no
 *        hostnames — the DOM-walk that gathers candidates lives in write-commands.
 */

export interface LinkCandidate {
  index: number;        // position in the page's link list (used to target the element)
  text: string;         // visible link text
  href?: string;
  ariaLabel?: string;
  title?: string;
  visible: boolean;
}

// Tokens: ASCII words/numbers, or individual CJK characters (so 年度报告 matches by char).
function tokenize(s: string | undefined): string[] {
  if (!s) return [];
  const ascii = s.toLowerCase().match(/[a-z0-9]+/g) || [];
  const cjk = s.match(/[一-鿿]/g) || [];
  return [...ascii, ...cjk];
}

function score(c: LinkCandidate, kwTokens: string[], kwPhrase: string): number {
  if (!c.visible) return -Infinity;
  const text = (c.text || '').toLowerCase().trim();
  if (!text && !c.ariaLabel && !c.title && !c.href) return -Infinity;

  let s = 0;
  // Strongest: the visible text IS the keyword, or contains it as a phrase.
  if (text && text === kwPhrase) s += 12;
  else if (kwPhrase && text.includes(kwPhrase)) s += 8;

  // Each keyword token found in the visible text.
  const textTokens = tokenize(c.text);
  s += kwTokens.filter((t) => textTokens.includes(t)).length * 3;

  // aria-label / title (medium — used when the text is an icon).
  const metaTokens = tokenize(`${c.ariaLabel || ''} ${c.title || ''}`);
  s += kwTokens.filter((t) => metaTokens.includes(t)).length * 2;

  // href path (weak — hrefs are noisy, so lowest weight and path-only).
  const hrefPath = (c.href || '').replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
  const hrefTokens = tokenize(hrefPath);
  s += kwTokens.filter((t) => hrefTokens.includes(t)).length * 1;

  return s;
}

/** Index (into `cands`) of the best link for `keyword`, or -1 when none is plausible. Pure. */
export function rankLinks(cands: LinkCandidate[], keyword: string): number {
  const kwTokens = tokenize(keyword);
  const kwPhrase = keyword.toLowerCase().trim();
  let best = -1;
  let bestScore = 0; // strictly-positive threshold: a zero-score link is not a match
  for (let i = 0; i < cands.length; i++) {
    const sc = score(cands[i], kwTokens, kwPhrase);
    if (sc > bestScore) { bestScore = sc; best = i; }
  }
  return best;
}
