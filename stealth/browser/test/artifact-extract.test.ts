/**
 * [INPUT]: Depends on artifact-extract.ts (detectArtifactType, extractSpreadsheet,
 *          formatArtifactPdf) and xlsx (to synthesize a workbook for the round-trip).
 * [OUTPUT]: Verifies the residual hard-tail capability: a weak model reaches a PDF/Excel
 *           (Caltrans bid summary, NTSB FDR report) but read/text/table can't see inside a
 *           binary file — this parses PDF text + spreadsheet rows. Type detection + the
 *           spreadsheet round-trip are unit-tested; PDF text is live-verified separately.
 * [POS]: General artifact extraction, no per-site logic.
 */

import { describe, test, expect } from 'bun:test';
import * as XLSX from 'xlsx';
import {
  detectArtifactType,
  extractSpreadsheet,
  formatArtifactPdf,
} from '../src/artifact-extract';

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);        // PK.. (xlsx)
const OLE_MAGIC = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);        // legacy .xls

describe('detectArtifactType', () => {
  test('PDF by magic bytes (beats a misleading URL)', () => {
    expect(detectArtifactType('text/html', 'https://x/file', PDF_MAGIC)).toBe('pdf');
  });
  test('PDF by content-type / extension', () => {
    expect(detectArtifactType('application/pdf', 'https://x/a', undefined)).toBe('pdf');
    expect(detectArtifactType(undefined, 'https://x/report.PDF', undefined)).toBe('pdf');
  });
  test('xlsx by zip magic + content-type/extension', () => {
    expect(detectArtifactType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'https://x/a', ZIP_MAGIC)).toBe('spreadsheet');
    expect(detectArtifactType(undefined, 'https://x/bid.xlsx', ZIP_MAGIC)).toBe('spreadsheet');
  });
  test('legacy .xls by OLE magic', () => {
    expect(detectArtifactType(undefined, 'https://x/old.xls', OLE_MAGIC)).toBe('spreadsheet');
  });
  test('CSV by content-type / extension → spreadsheet path', () => {
    expect(detectArtifactType('text/csv', 'https://x/a', undefined)).toBe('spreadsheet');
    expect(detectArtifactType(undefined, 'https://x/data.csv', undefined)).toBe('spreadsheet');
  });
  test('a plain zip that is not a spreadsheet is not misread', () => {
    expect(detectArtifactType('application/zip', 'https://x/photos.zip', ZIP_MAGIC)).toBeNull();
  });
  test('an HTML page → null (use read/text)', () => {
    expect(detectArtifactType('text/html', 'https://x/page', new Uint8Array([0x3c, 0x21]))).toBeNull();
  });
  test('an HTML 404 page served at a .pdf URL → null (bytes beat the extension)', () => {
    const html404 = new TextEncoder().encode('<!DOCTYPE html><html><title>404 Not Found</title>');
    expect(detectArtifactType('text/html', 'https://x/report.pdf', html404)).toBeNull();
  });
});

describe('extractSpreadsheet — round-trip real xlsx bytes', () => {
  test('parses every sheet into RawTable rows (strings)', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Contract', 'Bid'], ['04-0K1204', '1250000']]), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x'], ['y']]), 'Sheet2');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    const tables = extractSpreadsheet(bytes);
    expect(tables.length).toBe(2);
    expect(tables[0].caption).toBe('Summary');
    expect(tables[0].rows[0]).toEqual(['Contract', 'Bid']);
    expect(tables[0].rows[1]).toEqual(['04-0K1204', '1250000']); // numbers stringified
  });

  test('parses CSV bytes too', () => {
    const bytes = new TextEncoder().encode('a,b\n1,2\n3,4\n');
    const tables = extractSpreadsheet(bytes);
    expect(tables[0].rows).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
});

describe('formatArtifactPdf', () => {
  test('non-empty text is returned (capped by capOutput)', () => {
    const out = formatArtifactPdf('Bid Summary\nContract 04-0K1204 total $1,250,000');
    expect(out).toContain('04-0K1204');
  });
  test('empty text (scanned/image PDF) → an actionable hint, never blank', () => {
    expect(formatArtifactPdf('   \n  ')).toMatch(/no extractable text|scanned|image/i);
  });
});
