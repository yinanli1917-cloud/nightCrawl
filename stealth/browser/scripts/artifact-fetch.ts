/**
 * [INPUT]: argv[2] = path to a JSON file {url, cookie, maxBytes}. Imports the pure parse
 *          helpers from artifact-extract (detectArtifactType, extractPdfContent,
 *          extractSpreadsheet).
 * [OUTPUT]: writes JSON to stdout:
 *           {kind:'pdf', ct, text, tables} | {kind:'spreadsheet', ct, tables}
 *           | {kind:'none', ct} | {error} | {error:'too-large', mb}
 * [POS]: ISOLATED fetch+parse subprocess. BOTH the HTTP fetch (Playwright's request client
 *        AND Bun's in-daemon fetch native-crash the long-lived daemon on some servers, e.g.
 *        irs.gov) and the pdfjs parse (fillable AcroForms) are fragile IN the daemon though
 *        fine in a clean process. The daemon spawns THIS disposable process with a timeout,
 *        so no server or PDF can ever crash or hang it. Cookies come via the JSON file (not
 *        argv) so they never show up in `ps`.
 */
import { readFileSync } from 'fs';
import { detectArtifactType, extractPdfContent, extractSpreadsheet } from '../src/artifact-extract';

function out(o: unknown): void { process.stdout.write(JSON.stringify(o)); }

async function main(): Promise<void> {
  try {
    const { url, cookie, maxBytes } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const cap = Number(maxBytes) || 30_000_000;
    const resp = await fetch(url, { headers: cookie ? { cookie } : {}, redirect: 'follow' });
    const ct = resp.headers.get('content-type') || undefined;
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > cap) { out({ error: 'too-large', mb: Math.round(declared / 1e6) }); return; }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.length > cap) { out({ error: 'too-large', mb: Math.round(bytes.length / 1e6) }); return; }

    const kind = detectArtifactType(ct, url, bytes);
    if (kind === 'pdf') { const { text, tables } = await extractPdfContent(bytes); out({ kind, ct, text, tables }); }
    else if (kind === 'spreadsheet') { out({ kind, ct, tables: extractSpreadsheet(bytes) }); }
    else out({ kind: 'none', ct });
  } catch (e: any) {
    out({ error: String(e?.message ?? e) });
  }
}

main().finally(() => process.exit(0));
