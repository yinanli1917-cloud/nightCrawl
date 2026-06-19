/**
 * Deliverable verification — assert user-facing outcomes, not just CLI exit codes.
 *
 * [INPUT]: file paths, optional page text/URL from BrowserManager
 * [OUTPUT]: structured pass/fail with human-readable reasons
 * [POS]: Agent skill + `nc verify` enforce the DVC before claiming task done
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type DeliverableKind =
  | 'file-bytes'
  | 'publisher-pdf'
  | 'page-print-pdf'
  | 'image'
  | 'archive'
  | 'json'
  | 'text';

export interface VerifyFileOptions {
  filePath: string;
  kind?: DeliverableKind;
  contains?: string[];
  notContains?: string[];
  minBytes?: number;
  maxBytes?: number;
  minPages?: number;
  /** Reject PDFs whose Producer/Creator look like browser print (Skia/Chrome). */
  rejectBrowserPrint?: boolean;
}

export interface VerifyCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerifyFileResult {
  passed: boolean;
  kind: DeliverableKind;
  filePath: string;
  checks: VerifyCheck[];
  extracted?: {
    pageCount?: number;
    producer?: string;
    creator?: string;
    textSample?: string;
    byteSize: number;
  };
}

export interface VerifyPageOptions {
  urlIncludes?: string[];
  urlExcludes?: string[];
  textIncludes?: string[];
  textExcludes?: string[];
}

export interface VerifyPageResult {
  passed: boolean;
  url: string;
  checks: VerifyCheck[];
}

/** Read-only paths: artifacts, tmp, repo cwd, nightcrawl state. */
export function validateReadablePath(filePath: string): void {
  const resolved = path.resolve(filePath);
  const home = process.env.HOME || '';
  const allowedRoots = [
    path.join(home, 'Documents', 'nightCrawl'),
    path.join(home, '.nightcrawl'),
    '/tmp',
    os.tmpdir(),
    process.cwd(),
  ].filter(Boolean);

  const ok = allowedRoots.some(root => {
    const r = path.resolve(root);
    return resolved === r || resolved.startsWith(r + path.sep);
  });
  if (!ok) {
    throw new Error(
      `Verify path must be under an allowed root: ${allowedRoots.join(', ')}`,
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
}

function runCmd(cmd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) {
    return { ok: false, stdout: (r.stdout || '') + (r.stderr || '') };
  }
  return { ok: true, stdout: r.stdout || '' };
}

function extractPdfText(filePath: string): { text: string; pageCount?: number; producer?: string; creator?: string } {
  const info = runCmd('pdfinfo', [filePath]);
  let pageCount: number | undefined;
  let producer: string | undefined;
  let creator: string | undefined;
  if (info.ok) {
    const pagesMatch = info.stdout.match(/^Pages:\s+(\d+)/m);
    if (pagesMatch) pageCount = Number(pagesMatch[1]);
    const prodMatch = info.stdout.match(/^Producer:\s+(.+)$/m);
    if (prodMatch) producer = prodMatch[1].trim();
    const creatMatch = info.stdout.match(/^Creator:\s+(.+)$/m);
    if (creatMatch) creator = creatMatch[1].trim();
  }

  const textOut = runCmd('pdftotext', [filePath, '-']);
  if (textOut.ok && textOut.stdout.trim()) {
    return { text: textOut.stdout, pageCount, producer, creator };
  }

  // Fallback: scan raw bytes for readable strings (weak but better than nothing)
  const buf = fs.readFileSync(filePath);
  const chunks: string[] = [];
  let current = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 0x20 && c <= 0x7e) {
      current += String.fromCharCode(c);
    } else if (current.length >= 8) {
      chunks.push(current);
      current = '';
    } else {
      current = '';
    }
  }
  if (current.length >= 8) chunks.push(current);
  return { text: chunks.join('\n'), pageCount, producer, creator };
}

function detectKind(filePath: string, explicit?: DeliverableKind): DeliverableKind {
  if (explicit) return explicit;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'publisher-pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.zip', '.gz', '.tar'].includes(ext)) return 'archive';
  if (ext === '.json') return 'json';
  return 'file-bytes';
}

function isBrowserPrintPdf(producer?: string, creator?: string): boolean {
  const hay = `${producer || ''} ${creator || ''}`.toLowerCase();
  return /skia\/pdf|headlesschrome|chrome\/|playwright|webkit/.test(hay);
}

export function verifyFile(options: VerifyFileOptions): VerifyFileResult {
  validateReadablePath(options.filePath);
  const resolved = path.resolve(options.filePath);
  const stat = fs.statSync(resolved);
  const kind = detectKind(resolved, options.kind);
  const checks: VerifyCheck[] = [];
  const byteSize = stat.size;

  checks.push({
    name: 'exists',
    passed: true,
    detail: `${byteSize} bytes`,
  });

  if (options.minBytes !== undefined) {
    checks.push({
      name: 'min-bytes',
      passed: byteSize >= options.minBytes,
      detail: `${byteSize} >= ${options.minBytes}`,
    });
  }
  if (options.maxBytes !== undefined) {
    checks.push({
      name: 'max-bytes',
      passed: byteSize <= options.maxBytes,
      detail: `${byteSize} <= ${options.maxBytes}`,
    });
  }

  const head = fs.readFileSync(resolved, { encoding: null }).subarray(0, 8).toString('utf8');
  let extracted: VerifyFileResult['extracted'] = { byteSize };

  if (kind === 'publisher-pdf' || kind === 'page-print-pdf' || kind === 'file-bytes' && resolved.endsWith('.pdf')) {
    const magicOk = head.startsWith('%PDF');
    checks.push({
      name: 'pdf-magic',
      passed: magicOk,
      detail: magicOk ? 'starts with %PDF' : `unexpected header: ${JSON.stringify(head)}`,
    });

    const { text, pageCount, producer, creator } = extractPdfText(resolved);
    extracted = { ...extracted, pageCount, producer, creator, textSample: text.slice(0, 500) };

    if (options.minPages !== undefined && pageCount !== undefined) {
      checks.push({
        name: 'min-pages',
        passed: pageCount >= options.minPages,
        detail: `${pageCount} >= ${options.minPages}`,
      });
    } else if (kind === 'publisher-pdf' && options.minPages === undefined) {
      // Default publisher PDF expectation: not a single-page print stub
      if (pageCount !== undefined) {
        checks.push({
          name: 'publisher-pdf-pages',
          passed: pageCount >= 2,
          detail: `${pageCount} pages (publisher articles are usually multi-page)`,
        });
      }
    }

    const browserPrint = isBrowserPrintPdf(producer, creator);
    const rejectPrint = options.rejectBrowserPrint ?? kind === 'publisher-pdf';
    if (rejectPrint) {
      checks.push({
        name: 'not-browser-print',
        passed: !browserPrint,
        detail: browserPrint
          ? `looks like print-to-PDF (Producer/Creator: ${producer || creator}) — use publisher download URL, not nc pdf`
          : `Producer: ${producer || 'unknown'}`,
      });
    }

    for (const needle of options.contains || []) {
      const found = text.toLowerCase().includes(needle.toLowerCase());
      checks.push({
        name: `contains:${needle.slice(0, 40)}`,
        passed: found,
        detail: found ? 'found in extracted text' : 'not found in extracted text',
      });
    }
    for (const needle of options.notContains || []) {
      const found = text.toLowerCase().includes(needle.toLowerCase());
      checks.push({
        name: `not-contains:${needle.slice(0, 40)}`,
        passed: !found,
        detail: found ? 'unexpected match in text' : 'absent as expected',
      });
    }
  }

  if (kind === 'json') {
    let parsed: unknown;
    let parseOk = false;
    try {
      parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      parseOk = true;
    } catch (e) {
      checks.push({
        name: 'json-parse',
        passed: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    if (parseOk) {
      checks.push({
        name: 'json-parse',
        passed: true,
        detail: Array.isArray(parsed)
          ? `array length ${(parsed as unknown[]).length}`
          : typeof parsed,
      });
    }
  }

  const passed = checks.every(c => c.passed);
  return { passed, kind, filePath: resolved, checks, extracted };
}

export function verifyPage(
  url: string,
  pageText: string,
  options: VerifyPageOptions,
): VerifyPageResult {
  const checks: VerifyCheck[] = [];
  const urlLower = url.toLowerCase();
  const textLower = pageText.toLowerCase();

  for (const part of options.urlIncludes || []) {
    const ok = urlLower.includes(part.toLowerCase());
    checks.push({
      name: `url-includes:${part}`,
      passed: ok,
      detail: ok ? url : `current: ${url}`,
    });
  }
  for (const part of options.urlExcludes || []) {
    const bad = urlLower.includes(part.toLowerCase());
    checks.push({
      name: `url-excludes:${part}`,
      passed: !bad,
      detail: bad ? `blocked fragment in URL: ${part}` : 'ok',
    });
  }
  for (const part of options.textIncludes || []) {
    const ok = textLower.includes(part.toLowerCase());
    checks.push({
      name: `text-includes:${part.slice(0, 40)}`,
      passed: ok,
      detail: ok ? 'found' : 'not found on page',
    });
  }
  for (const part of options.textExcludes || []) {
    const bad = textLower.includes(part.toLowerCase());
    checks.push({
      name: `text-excludes:${part.slice(0, 40)}`,
      passed: !bad,
      detail: bad ? 'unexpected text on page' : 'ok',
    });
  }

  return { passed: checks.every(c => c.passed), url, checks };
}

export function formatVerifyFileResult(result: VerifyFileResult): string {
  const lines = [
    result.passed ? 'VERIFY_OK' : 'VERIFY_FAILED',
    `kind: ${result.kind}`,
    `file: ${result.filePath}`,
  ];
  if (result.extracted?.pageCount !== undefined) {
    lines.push(`pages: ${result.extracted.pageCount}`);
  }
  if (result.extracted?.producer) {
    lines.push(`producer: ${result.extracted.producer}`);
  }
  for (const c of result.checks) {
    lines.push(`${c.passed ? '  ✓' : '  ✗'} ${c.name}: ${c.detail}`);
  }
  return lines.join('\n');
}

export function formatVerifyPageResult(result: VerifyPageResult): string {
  const lines = [
    result.passed ? 'VERIFY_OK' : 'VERIFY_FAILED',
    `url: ${result.url}`,
  ];
  for (const c of result.checks) {
    lines.push(`${c.passed ? '  ✓' : '  ✗'} ${c.name}: ${c.detail}`);
  }
  return lines.join('\n');
}

/** Parse: verify file <path> [--kind publisher-pdf] [--contains X] ... */
export function parseVerifyArgs(args: string[]): {
  mode: 'file' | 'page';
  file?: VerifyFileOptions;
  page?: VerifyPageOptions;
} {
  if (args.length === 0) {
    throw new Error(
      'Usage: verify file <path> [--kind publisher-pdf|page-print-pdf|json|image] [--contains TEXT] [--not-contains TEXT] [--min-pages N] [--min-bytes N]\n' +
        '       verify page [--url-includes FRAG] [--url-excludes FRAG] [--text-includes TEXT] [--text-excludes TEXT]',
    );
  }

  const mode = args[0] as 'file' | 'page';
  if (mode !== 'file' && mode !== 'page') {
    throw new Error('First argument must be "file" or "page"');
  }

  if (mode === 'file') {
    if (args.length < 2) throw new Error('verify file requires a path');
    const filePath = args[1];
    const opts: VerifyFileOptions = { filePath };
    for (let i = 2; i < args.length; i++) {
      const flag = args[i];
      const next = () => {
        if (i + 1 >= args.length) throw new Error(`Missing value for ${flag}`);
        return args[++i];
      };
      switch (flag) {
        case '--kind':
          opts.kind = next() as DeliverableKind;
          break;
        case '--contains':
          opts.contains = [...(opts.contains || []), next()];
          break;
        case '--not-contains':
          opts.notContains = [...(opts.notContains || []), next()];
          break;
        case '--min-pages':
          opts.minPages = Number(next());
          break;
        case '--min-bytes':
          opts.minBytes = Number(next());
          break;
        case '--max-bytes':
          opts.maxBytes = Number(next());
          break;
        case '--allow-browser-print':
          opts.rejectBrowserPrint = false;
          break;
        default:
          throw new Error(`Unknown flag: ${flag}`);
      }
    }
    return { mode: 'file', file: opts };
  }

  const page: VerifyPageOptions = {};
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const next = () => {
      if (i + 1 >= args.length) throw new Error(`Missing value for ${flag}`);
      return args[++i];
    };
    switch (flag) {
      case '--url-includes':
        page.urlIncludes = [...(page.urlIncludes || []), next()];
        break;
      case '--url-excludes':
        page.urlExcludes = [...(page.urlExcludes || []), next()];
        break;
      case '--text-includes':
        page.textIncludes = [...(page.textIncludes || []), next()];
        break;
      case '--text-excludes':
        page.textExcludes = [...(page.textExcludes || []), next()];
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return { mode: 'page', page };
}
