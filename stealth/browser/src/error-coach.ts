/**
 * [INPUT]: Pure module — no imports.
 * [OUTPUT]: Exports CoachRule, COACH_RULES, coachHint, EMPTY_JS_HINT.
 * [POS]: The in-band self-teaching channel for weak/stateless drivers. A tool error or an
 *        empty `js` result maps to ONE next-move line, keyed on the error CLASS (never a
 *        site). A weak model won't internalize the SKILL.md, but it reacts to a hint in
 *        the immediate observation — so it self-corrects instead of burning steps looping.
 *        Data-driven: add a class here, not an if/else at each throw site.
 */

export interface CoachRule {
  test: RegExp;
  hint: string;
}

// Ordered: first match wins. Each hint names the concrete next command to try.
export const COACH_RULES: readonly CoachRule[] = [
  {
    test: /is not defined|ReferenceError/i,
    hint: 'that runs INSIDE the page — use browser globals (document, location, window, fetch), not Node. Or skip JS: `find <keyword>`, `table`, `read`, `data` return content directly.',
  },
  {
    test: /Unexpected token|SyntaxError/i,
    hint: 'pass a single expression (e.g. `document.title`); if you need multiple statements, end the code with `return <value>`.',
  },
  {
    test: /not found|resolved to \d+ element|Timeout.*(exceeded|waiting)|waiting for (locator|selector)/i,
    hint: 'the selector did not match — run `snapshot` for fresh @refs, or `find <keyword>` to locate the text first.',
  },
  {
    test: /Execution context was destroyed|navigation|detached|frame was detached/i,
    hint: 'the page navigated mid-command — re-run after `wait --load`.',
  },
  {
    test: /timed out after \d+ms/i,
    hint: 'the page or JS did not settle in time — `wait --load` then retry, or narrow the work to one `fetch(...).then(r=>r.json())`.',
  },
];

/** The bare-statement-list trap: `const x = ...` returns nothing. Weak models hit this a lot. */
export const EMPTY_JS_HINT =
  'js returned no value — a bare `const x = ...` returns nothing; end your code with `return <expr>`. Or prefer `find`/`table`/`read`/`data`, which return structured content directly.';

/**
 * Map an error message (and optional page context) to one next-move hint, or null when
 * there is nothing useful to say. Message match wins over the blank-page fallback.
 */
export function coachHint(msg: string, ctx: { url?: string } = {}): string | null {
  for (const rule of COACH_RULES) if (rule.test.test(msg)) return rule.hint;
  if (ctx.url === 'about:blank' || ctx.url === '') {
    return 'the active page is blank — the last action may have navigated away; `goto <url>` again before reading.';
  }
  return null;
}
