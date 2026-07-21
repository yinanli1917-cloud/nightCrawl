/**
 * [INPUT]: Depends on pdf-tables.ts (PdfItem, reconstructTable, looksTabular).
 * [OUTPUT]: Verifies GENERAL position-based table reconstruction from PDF text items —
 *           cluster into rows by y, columns by x — so a weak model can read an exact cell
 *           (bid summary, FDR param) instead of a flat text blob. No per-PDF logic; the
 *           same algorithm for every PDF, with a `looksTabular` gate for graceful fallback.
 * [POS]: The last artifact-extraction lever. Positions come from unpdf (item.transform);
 *        this pure core is tested with synthetic items, the real PDF path is live-verified.
 */

import { describe, test, expect } from 'bun:test';
import { reconstructTable, looksTabular, type PdfItem } from '../src/pdf-tables';

// PDF y grows UPWARD, so a higher y is a higher row. Build a 3x3 grid.
const grid3x3: PdfItem[] = [
  { str: 'City', x: 10, y: 100, w: 20 }, { str: 'Pop', x: 100, y: 100, w: 18 }, { str: 'Year', x: 200, y: 100, w: 22 },
  { str: 'Tokyo', x: 10, y: 86, w: 26 }, { str: '37', x: 100, y: 86, w: 12 }, { str: '2020', x: 200, y: 86, w: 22 },
  { str: 'Delhi', x: 10, y: 72, w: 24 }, { str: '31', x: 100, y: 72, w: 12 }, { str: '2021', x: 200, y: 72, w: 22 },
];

describe('reconstructTable — rows by y, columns by x', () => {
  test('a clean 3x3 grid reconstructs in reading order (top row first)', () => {
    const rows = reconstructTable(grid3x3);
    expect(rows).toEqual([
      ['City', 'Pop', 'Year'],
      ['Tokyo', '37', '2020'],
      ['Delhi', '31', '2021'],
    ]);
  });

  test('slight y jitter within a line stays one row', () => {
    const jittered = grid3x3.map((it) => ({ ...it, y: it.y + (it.x === 100 ? 1.5 : 0) }));
    expect(reconstructTable(jittered).length).toBe(3);
  });

  test('a missing cell becomes an empty string (global column model), not a shift', () => {
    const withGap = grid3x3.filter((it) => !(it.y === 86 && it.x === 100)); // drop Tokyo's Pop
    const rows = reconstructTable(withGap);
    expect(rows[1]).toEqual(['Tokyo', '', '2020']);
  });

  test('multiple items in one cell join with a space (multi-word cell)', () => {
    const items: PdfItem[] = [
      { str: 'New', x: 10, y: 50, w: 18 }, { str: 'York', x: 30, y: 50, w: 20 }, { str: '8000000', x: 100, y: 50, w: 40 },
    ];
    expect(reconstructTable(items, { xTol: 12 })[0]).toEqual(['New York', '8000000']);
  });

  test('empty input → empty', () => {
    expect(reconstructTable([])).toEqual([]);
  });
});

describe('looksTabular — the graceful-fallback gate', () => {
  test('a real grid is tabular', () => {
    expect(looksTabular(reconstructTable(grid3x3))).toBe(true);
  });
  test('a single column (prose lines) is NOT tabular', () => {
    const prose = reconstructTable([
      { str: 'The quick brown fox', x: 10, y: 100, w: 90 },
      { str: 'jumps over the lazy dog', x: 10, y: 86, w: 110 },
    ]);
    expect(looksTabular(prose)).toBe(false);
  });
  test('two rows is too few to call a table', () => {
    expect(looksTabular([['a', 'b']])).toBe(false);
  });
});
