/**
 * [INPUT]: unpdf (extractText/getDocumentProxy), xlsx (SheetJS), read-extract (RawTable,
 *          capOutput, table select/format/sort helpers), session-view (TabView).
 * [OUTPUT]: detectArtifactType, extractPdfText, extractSpreadsheet, formatArtifactPdf,
 *           extractArtifact (the `extract` command handler).
 * [POS]: The residual hard-tail wall. A weak model reaches a PDF/Excel (Caltrans bid
 *        summary, NTSB FDR report, publisher PDF) but `read`/`text`/`table` can't see inside
 *        a binary file. This fetches the bytes AUTH-AWARE (through the browser context, so
 *        the session's cookies apply) and parses PDF text + spreadsheet rows, so the same
 *        find/table affordances work on the file's content. General, no per-site logic.
 */

import { extractText, getDocumentProxy } from 'unpdf';
import * as XLSX from 'xlsx';
import type { TabView } from './session-view';
import {
  capOutput,
  formatTable,
  formatTableList,
  selectTable,
  parseTableOpts,
  resolveColumn,
  sortRows,
  type RawTable,
} from './read-extract';

export type ArtifactType = 'pdf' | 'spreadsheet' | null;

/**
 * Classify a fetched resource. Magic bytes win (most reliable), then content-type, then the
 * URL extension. A plain zip that is not a spreadsheet is deliberately NOT treated as one.
 */
export function detectArtifactType(
  contentType: string | undefined,
  url: string,
  bytes?: Uint8Array,
): ArtifactType {
  const ct = (contentType || '').toLowerCase();
  const u = (url || '').toLowerCase().split(/[?#]/)[0];
  const looksSheet = /spreadsheet|ms-excel|excel|text\/csv/.test(ct) || /\.(xlsx|xls|csv)$/.test(u);

  if (bytes && bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf'; // %PDF
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return 'spreadsheet'; // OLE (legacy .xls)
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // PK — xlsx is a zip, but so is a .zip
    if (isZip) {
      // A gov download is often an .xlsx served as octet-stream with no extension. Attempt
      // it (extractSpreadsheet fails gracefully); only reject a zip that ANNOUNCES it is one.
      if (looksSheet) return 'spreadsheet';
      const generic = !ct || ct.includes('octet-stream') || ct.includes('download');
      return generic ? 'spreadsheet' : null;
    }
    // Bytes are AUTHORITATIVE over a URL extension: an HTML error page served at a `.pdf`
    // URL (a 404/login wall) must NOT be parsed as a PDF. CSV is the only text artifact.
    const head = String.fromCharCode(...bytes.slice(0, 64)).trimStart().toLowerCase();
    if (head.startsWith('<')) return looksSheet && /csv/.test(ct + u) ? 'spreadsheet' : null;
  }
  if (ct.includes('pdf') || /\.pdf$/.test(u)) return 'pdf';
  if (looksSheet) return 'spreadsheet';
  return null;
}

/** PDF → merged plain text (unpdf wraps pdf.js; runs in Bun). Never throws for empty. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : String(text ?? '');
}

/** Spreadsheet (xlsx/xls/csv) → one RawTable per sheet, cells stringified. [] if unparseable. */
export function extractSpreadsheet(bytes: Uint8Array): RawTable[] {
  let wb;
  try { wb = XLSX.read(bytes, { type: 'array' }); } catch { return []; }
  return wb.SheetNames.map((name, index) => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
      header: 1, blankrows: false, raw: false,
    });
    return {
      index,
      caption: name,
      rows: rows.map((r) => (r || []).map((c) => String(c ?? ''))),
    };
  }).filter((t) => t.rows.length > 0);
}

export function formatArtifactPdf(text: string): string {
  const clean = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) {
    return 'This PDF has no extractable text (likely scanned images). Try `data` for a backend data source, or read the surrounding page.';
  }
  return capOutput(clean);
}

// ─── the `extract` command ─────────────────────────────────────
// Reuses the table select/sort/format helpers so `extract <url> [<sheet>] [--sort ..] [--top]`
// behaves like `table` on the file's content.
function formatArtifactSheets(tables: RawTable[], args: string[]): string {
  if (tables.length === 0) return 'The spreadsheet has no rows.';
  const opts = parseTableOpts(args);
  const sel = opts.positional.length ? selectTable(tables, opts.positional) : tables[0];
  if ('error' in sel) return `${sel.error}\n\n${formatTableList(tables)}`;
  let rows = sel.rows;
  if (opts.sortCol) {
    const col = resolveColumn(rows[0] ?? [], opts.sortCol);
    if (col >= 0) rows = sortRows(rows, col, opts.desc);
  }
  if (opts.top !== undefined && rows.length > 1) rows = [rows[0], ...rows.slice(1, 1 + Math.max(0, opts.top))];
  const header = tables.length > 1 ? `[sheet "${sel.caption}" of ${tables.length}; other sheets: extract <url> <index>]\n` : '';
  return header + formatTable({ ...sel, rows }, { json: opts.json, rowCap: 200 });
}

async function resolveArtifactUrl(bm: TabView, arg: string | undefined): Promise<string> {
  const current = bm.getCurrentUrl();
  if (!arg) return current;
  if (arg.startsWith('@')) {
    const resolved = await bm.resolveRef(arg);
    const loc = 'locator' in resolved ? resolved.locator : bm.getActiveFrameOrPage().locator(resolved.selector);
    const href = await loc.evaluate((el: Element) => (el as HTMLAnchorElement).href || el.getAttribute('href') || '');
    if (!href) throw new Error(`${arg} has no href to extract`);
    return new URL(href, current).href;
  }
  return new URL(arg, current).href;
}

/**
 * `extract [<url>|@ref] [<sheet>] [--json] [--sort <col>] [--desc] [--top N]`
 * Fetch a PDF/Excel/CSV (auth-aware, via the browser context) and return its text/rows.
 */
export async function extractArtifact(bm: TabView, args: string[]): Promise<string> {
  const first = args[0];
  const isTarget = !!first && (first.startsWith('@') || /^https?:\/\//i.test(first) || /^\//.test(first));
  const target = isTarget ? first : undefined;
  const rest = isTarget ? args.slice(1) : args;

  const url = await resolveArtifactUrl(bm, target);
  const resp = await bm.getPage().context().request.get(url, { timeout: 30000 });
  const ct = resp.headers()['content-type'];
  const bytes = new Uint8Array(await resp.body());
  const type = detectArtifactType(ct, url, bytes);

  if (type === 'pdf') return formatArtifactPdf(await extractPdfText(bytes));
  if (type === 'spreadsheet') return formatArtifactSheets(extractSpreadsheet(bytes), rest);
  return `Not a PDF/Excel/CSV (content-type: ${ct || 'unknown'}). For an HTML page use \`read\`/\`text\`/\`table\` instead. URL: ${url}`;
}
