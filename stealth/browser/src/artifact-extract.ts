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

import { extractText, extractTextItems, getDocumentProxy } from 'unpdf';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TabView } from './session-view';
import { reconstructTable, looksTabular } from './pdf-tables';
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

const MAX_PDF_PAGES = 50;

/**
 * One pass over a PDF: merged text AND reconstructed per-page tables (position-based, general).
 * Only pages that `looksTabular` become tables, so a prose page just contributes text. Uses
 * unpdf's `extractTextItems` (positioned items, no-worker mode — a fillable AcroForm crashes
 * the raw getTextContent path with "object can not be cloned"). NEVER throws: a parse failure
 * returns empty, so the daemon can never die on a hostile PDF.
 */
export async function extractPdfContent(bytes: Uint8Array): Promise<{ text: string; tables: RawTable[] }> {
  let pages: any[][];
  try {
    const res = await extractTextItems(bytes);
    pages = (res.items || []).slice(0, MAX_PDF_PAGES);
  } catch {
    return { text: '', tables: [] };
  }
  const textParts: string[] = [];
  const tables: RawTable[] = [];
  pages.forEach((pageItems, p) => {
    let line = '';
    for (const it of pageItems) {
      if (typeof it.str !== 'string') continue;
      line += it.str;
      if (it.hasEOL) { textParts.push(line); line = ''; }
    }
    if (line.trim()) textParts.push(line);
    const items = pageItems
      .filter((it) => typeof it.str === 'string' && it.str.trim() !== '')
      .map((it) => ({ str: it.str, x: it.x, y: it.y, w: it.width }));
    const rows = reconstructTable(items);
    if (looksTabular(rows)) tables.push({ index: tables.length, caption: `page ${p + 1}`, rows });
  });
  return { text: textParts.join('\n'), tables };
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

export interface ArtifactResult {
  kind?: 'pdf' | 'spreadsheet' | 'none';
  ct?: string;
  text?: string;
  tables?: RawTable[];
  error?: string;
  mb?: number;
}

// Fetch AND parse in a DISPOSABLE subprocess. BOTH the HTTP fetch (Playwright's request
// client AND Bun's in-daemon fetch native-crash the daemon on some servers, e.g. irs.gov)
// and the pdfjs/xlsx parse are fragile IN the long-lived daemon though safe in a clean
// process. Any pathology dies in the child (killed on timeout); the daemon can never die or
// hang on a URL. Cookies pass via a 0600 temp file so they never appear in `ps`.
const ARTIFACT_FETCH_SCRIPT = path.join(import.meta.dir, '..', 'scripts', 'artifact-fetch.ts');

async function fetchAndParseIsolated(url: string, cookie: string): Promise<ArtifactResult> {
  const tmp = path.join(os.tmpdir(), `nc-af-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ url, cookie, maxBytes: MAX_ARTIFACT_BYTES }), { mode: 0o600 });
    const proc = Bun.spawn([process.execPath, 'run', ARTIFACT_FETCH_SCRIPT, tmp], { stdout: 'pipe', stderr: 'ignore' });
    const killer = setTimeout(() => { try { proc.kill(); } catch {} }, 40000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(killer);
    return JSON.parse(out || '{}') as ArtifactResult;
  } catch {
    return { error: 'the fetch/parse subprocess failed' };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
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
// A huge download (a whole "all contracts" dump) OOM-crashed the daemon, stranding the
// session — the worst kind of wasted step. Refuse oversized files loudly instead.
const MAX_ARTIFACT_BYTES = 30_000_000; // 30 MB
const tooBigMsg = (mb: number) =>
  `This file is ~${mb} MB — too large to extract inline (it likely lists many records). ` +
  `Narrow to a SPECIFIC record's file, or use the site's search/filter to reach one row.`;

export async function extractArtifact(bm: TabView, args: string[]): Promise<string> {
  const first = args[0];
  const isTarget = !!first && (first.startsWith('@') || /^https?:\/\//i.test(first) || /^\//.test(first));
  const target = isTarget ? first : undefined;
  const rest = isTarget ? args.slice(1) : args;

  const url = await resolveArtifactUrl(bm, target);
  const cookies = await bm.getPage().context().cookies(url).catch(() => [] as any[]);
  const cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');

  // Everything fragile — the fetch AND the parse — happens in the disposable subprocess.
  const r = await fetchAndParseIsolated(url, cookieHeader);
  if (r.error === 'too-large') return tooBigMsg(r.mb ?? 0);
  if (r.error) return `Could not fetch/parse ${url} (${r.error}). Try opening it with \`goto\` instead.`;

  if (r.kind === 'pdf') {
    const tables = r.tables ?? [];
    if (rest.includes('--tables')) {
      return tables.length
        ? formatArtifactSheets(tables, rest.filter((a) => a !== '--tables'))
        : 'No tables detected in this PDF (it may be prose or scanned images). Use `extract <url>` for its text.';
    }
    const footer = tables.length
      ? `\n\n(${tables.length} table(s) detected — use \`extract <url> --tables\` for structured rows you can --sort)`
      : '';
    return formatArtifactPdf(r.text ?? '') + footer;
  }
  if (r.kind === 'spreadsheet') return formatArtifactSheets(r.tables ?? [], rest);
  return `Not a PDF/Excel/CSV (content-type: ${r.ct || 'unknown'}). For an HTML page use \`read\`/\`text\`/\`table\` instead. URL: ${url}`;
}
