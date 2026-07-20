/**
 * [INPUT]: Depends on session-view.TabView (resolveRef) + network-capture-deep
 *          (deepNetBuffer, DeepNetEntry). Playwright Page/Frame types only.
 * [OUTPUT]: Exports capOutput + the forgiving high-level read primitives find / table /
 *           read / data (each a thin DOM-extract + a PURE format/select/rank helper).
 * [POS]: "Agents as our users" layer. A weak model can't reliably hand-write DOM JS, so
 *        these collapse the fumbling: locate a term (find), pull a table as rows (table),
 *        read the main article (read), or grab the JSON/CSV backend behind a chart (data).
 *        DOM walks run in-page via target.evaluate; the pure helpers are unit-tested and
 *        the walks are verified live. No per-site logic — every primitive is page-general.
 */

import type { Page, Frame } from 'playwright';
import type { TabView } from './session-view';
import { deepNetBuffer, type DeepNetEntry } from './network-capture-deep';

type Target = Page | Frame;

// ─── Shared output cap ─────────────────────────────────────────
// A weak model drowns in a full-page dump. Cap the big readers and, ONLY when we
// truncate, point the model at the primitive that targets what it wants.
const DEFAULT_OUTPUT_CAP = 12_000;
const DEFAULT_ROW_CAP = 200;

export function capOutput(text: string, limit = Number(process.env.BROWSE_MAX_OUTPUT) || DEFAULT_OUTPUT_CAP): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n— showing ${limit} of ${text.length} chars. Use \`find <keyword>\` to jump to a term, or \`table\`/\`data\` to pull structured data. —`;
}

// ─── find <keyword> ────────────────────────────────────────────
export interface FindMatch {
  context: string;
  tableIndex: number | null;
}

export interface FindOpts {
  context: number;
  all: boolean;
  regex: boolean;
}

/** Parse `find` args: keyword (multi-word), -C <chars>, --all, --re. Pure. */
export function parseFindArgs(args: string[]): { keyword: string } & FindOpts {
  let context = 120, all = false, regex = false, keyword = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-C') { context = parseInt(args[++i], 10) || context; }
    else if (a === '--all') all = true;
    else if (a === '--re') regex = true;
    else keyword = keyword ? `${keyword} ${a}` : a;
  }
  return { keyword, context, all, regex };
}

export function formatFind(matches: FindMatch[], keyword: string): string {
  if (matches.length === 0) {
    return `no "${keyword}" on this page — try \`read\` for the main text, \`table\` to list tables, or \`snapshot\` for structure.`;
  }
  return matches.map((m, i) => {
    const ptr = m.tableIndex != null ? `  → in table #${m.tableIndex} (use: table ${m.tableIndex})` : '';
    return `[match ${i + 1}] ${m.context}${ptr}`;
  }).join('\n');
}

export async function findInPage(target: Target, keyword: string, opts: FindOpts): Promise<string> {
  const raw = await target.evaluate(
    ({ keyword, context, max, regex }) => {
      const tables = [...document.querySelectorAll('table,[role="table"],[role="grid"]')];
      const kw = keyword.toLowerCase();
      const re = regex ? new RegExp(keyword, 'i') : null;
      const root = document.body || document.documentElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const out: { context: string; tableIndex: number | null }[] = [];
      let node: Node | null;
      const BLOCK = /^(P|DIV|TD|TH|LI|SECTION|ARTICLE|TR|H[1-6]|SPAN)$/;
      while ((node = walker.nextNode()) && out.length < max) {
        const parent = (node as Text).parentElement;
        if (!parent) continue;
        const st = getComputedStyle(parent);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const value = node.nodeValue || '';
        if ((re ? value.search(re) : value.toLowerCase().indexOf(kw)) === -1) continue;
        let block: HTMLElement | null = parent;
        while (block && block !== root && !BLOCK.test(block.tagName)) block = block.parentElement;
        const btext = ((block || parent).innerText || value).replace(/\s+/g, ' ').trim();
        const at = re ? btext.search(re) : btext.toLowerCase().indexOf(kw);
        const hitLen = re ? (btext.match(re)?.[0].length ?? keyword.length) : keyword.length;
        const start = Math.max(0, at - context);
        const end = at + hitLen + context;
        const ctx = (start > 0 ? '…' : '') + btext.slice(start, end) + (end < btext.length ? '…' : '');
        let tableIndex: number | null = null;
        for (let i = 0; i < tables.length; i++) { if (tables[i].contains(node)) { tableIndex = i; break; } }
        out.push({ context: ctx, tableIndex });
      }
      return out;
    },
    { keyword, context: opts.context, max: opts.all ? 25 : 5, regex: opts.regex },
  );
  return formatFind(raw, keyword);
}

// ─── table [<index> | near <keyword> | @ref] [--json] ──────────
export interface RawTable {
  index: number;
  rows: string[][];
  caption: string;
}

export function formatTableList(tables: RawTable[]): string {
  if (tables.length === 0) return 'no tables on this page — try `read` for the main text or `data` for a backend data request.';
  const lines = tables.map((t) => {
    const cols = t.rows[0]?.length ?? 0;
    const cap = t.caption ? ` "${t.caption}"` : '';
    const header = (t.rows[0] ?? []).join(' | ').slice(0, 100);
    return `#${t.index}  ${t.rows.length}×${cols}${cap}  ${header}`;
  });
  return `${lines.join('\n')}\n\n(use \`table <index>\` for rows, or \`table near <keyword>\`)`;
}

export function selectTable(tables: RawTable[], args: string[]): RawTable | { error: string } {
  if (tables.length === 0) return { error: 'no tables on this page' };
  if (args[0] === 'near') {
    const kw = args.slice(1).join(' ').toLowerCase();
    if (!kw) return { error: 'Usage: table near <keyword>' };
    const hit = tables.find((t) => t.rows.flat().join(' ').toLowerCase().includes(kw));
    return hit ?? { error: `no table contains "${kw}" — run \`table\` to list all tables` };
  }
  const idx = parseInt(args[0], 10);
  if (Number.isNaN(idx)) return { error: 'Usage: table [<index> | near <keyword> | @ref] [--json]' };
  return tables.find((t) => t.index === idx) ?? { error: `no table #${idx} — run \`table\` to list all tables` };
}

export function formatTable(t: RawTable, opts: { json: boolean; rowCap: number }): string {
  const rows = t.rows.slice(0, opts.rowCap);
  let out: string;
  if (opts.json) {
    const [header = [], ...body] = rows;
    out = JSON.stringify(
      body.map((r) => Object.fromEntries(r.map((c, i) => [header[i] ?? `col${i}`, c]))),
      null, 2,
    );
  } else {
    out = rows.map((r) => r.join('\t')).join('\n');
  }
  if (t.rows.length > opts.rowCap) out += `\n\n— showing ${opts.rowCap} of ${t.rows.length} rows. —`;
  return out;
}

// In-page: extract every table (real <table> + ARIA grid) as capped rows. Self-contained
// (evaluate can't close over module scope). Cells collapsed + truncated to bound transfer.
function extractAllTablesInPage(): RawTable[] {
  const CELL_CAP = 200, ROW_CAP = 500;
  const cell = (el: Element) => ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, CELL_CAP);
  const nodes = [...document.querySelectorAll('table,[role="table"],[role="grid"]')];
  return nodes.map((t, index) => {
    let rows: string[][];
    if (t.tagName === 'TABLE') {
      rows = [...(t as HTMLTableElement).rows].slice(0, ROW_CAP).map((r) => [...r.cells].map(cell));
    } else {
      rows = [...t.querySelectorAll('[role="row"]')].slice(0, ROW_CAP).map((r) =>
        [...r.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')].map(cell));
    }
    const caption = (t.querySelector('caption') as HTMLElement | null)?.innerText?.trim() || '';
    return { index, rows, caption };
  }).filter((t) => t.rows.length > 0);
}

export async function extractTables(target: Target, bm: TabView, args: string[]): Promise<string> {
  const json = args.includes('--json');
  const positional = args.filter((a) => a !== '--json');

  if (positional[0]?.startsWith('@')) {
    const resolved = await bm.resolveRef(positional[0]);
    const loc = 'locator' in resolved ? resolved.locator : target.locator(resolved.selector);
    const rows = await loc.evaluate((el: Element) => {
      const cell = (c: Element) => ((c as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (el.tagName === 'TABLE') return [...(el as HTMLTableElement).rows].map((r) => [...r.cells].map(cell));
      return [...el.querySelectorAll('[role="row"]')].map((r) =>
        [...r.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')].map(cell));
    });
    return formatTable({ index: 0, rows, caption: '' }, { json, rowCap: DEFAULT_ROW_CAP });
  }

  const tables = await target.evaluate(extractAllTablesInPage);
  if (positional.length === 0) return formatTableList(tables);
  const sel = selectTable(tables, positional);
  if ('error' in sel) return `${sel.error}\n\n${formatTableList(tables)}`;
  return formatTable(sel, { json, rowCap: DEFAULT_ROW_CAP });
}

// ─── read (Readability-style main content) ─────────────────────
// Live-DOM innerText of the main-content root — innerText respects layout, so
// display:none / visibility:hidden / 0-size injections are excluded by construction.
// Envelope-wrapped downstream like every PAGE_CONTENT command.
export async function readableText(target: Target): Promise<string> {
  return await target.evaluate(() => {
    const clean = (el: HTMLElement) =>
      (el.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    const main = document.querySelector('article,main,[role="main"]') as HTMLElement | null;
    if (main && (main.innerText || '').length > 200) return clean(main);
    let best: HTMLElement = document.body, score = 0;
    for (const el of [...document.querySelectorAll('div,section')] as HTMLElement[]) {
      let p = 0;
      el.querySelectorAll(':scope p').forEach((x) => { p += (x as HTMLElement).innerText?.length || 0; });
      if (p > score) { score = p; best = el; }
    }
    return clean(best);
  });
}

// ─── data (backend data-request finder) ────────────────────────
// The numbers on a chart/statistics page live in a JSON/CSV backend request, not the
// DOM. Surface it from the redacted in-memory deep-capture ring so any agent can grab the
// series directly instead of writing fetch+parse JS. General URL-shape scoring — the
// analytics penalty targets third-party telemetry vendors, never the site's own host.
const DATA_CT_RE = /json|csv|xml/i;
const DATA_URL_RE = /\/api\/|\/v\d+\/|graphql|format=csv|\.json(\?|$)|\.csv(\?|$)|\/data\b|indicator|dataset|query/i;
// Third-party telemetry VENDORS + telemetry verbs (never a site's own host) — de-ranked so
// the model sees data, not analytics beacons. Broadened after a live World Bank run
// surfaced Azure App Insights (dc.services.visualstudio.com/v2/track) as if it were data.
const ANALYTICS_RE = /google-analytics|googletagmanager|doubleclick|[?&]gtm|\/collect\b|\/beacon\b|\/pixel\b|\/track\b|segment\.(io|com)|mixpanel|amplitude|sentry|hotjar|clarity\.ms|applicationinsights|visualstudio\.com|nr-data\.net|newrelic|datadoghq|\/rum\b|\/telemetry\b/i;

export function scoreDataRequest(e: DeepNetEntry): number {
  if (ANALYTICS_RE.test(e.url)) return -100; // telemetry vendor — never data, even a JSON POST to /v2/track
  let s = 0;
  if (e.respContentType && DATA_CT_RE.test(e.respContentType)) s += 3;
  if (DATA_URL_RE.test(e.url)) s += 2;
  if (e.respBodySample && /^\s*[[{]/.test(e.respBodySample)) s += 2;
  if (e.method && e.method !== 'GET') s += 1;
  return s;
}

export function rankDataRequests(entries: DeepNetEntry[]): DeepNetEntry[] {
  return entries
    .map((e) => ({ e, s: scoreDataRequest(e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.e);
}

export function formatDataRequests(ranked: DeepNetEntry[], all: boolean): string {
  if (ranked.length === 0) {
    return 'no data-like requests captured yet — interact with the page (change a filter/date) then run `data` again, or use `table`.';
  }
  const top = all ? ranked : ranked.slice(0, 5);
  return top.map((e) => {
    const ct = e.respContentType ? `, ${e.respContentType.split(';')[0]}` : '';
    return `${e.method} ${e.url}  (${e.resourceType}${ct})\n  fetch: browse js 'await fetch("${e.url}").then(r=>r.text())'`;
  }).join('\n');
}

export function findDataRequests(args: string[], entries: DeepNetEntry[] = deepNetBuffer.toArray()): string {
  return formatDataRequests(rankDataRequests(entries), args.includes('--all'));
}
