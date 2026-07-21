/**
 * [INPUT]: Pure module — no imports.
 * [OUTPUT]: PdfItem, reconstructTable, looksTabular.
 * [POS]: The last artifact-extraction lever. A PDF has no table structure — a "table" is
 *        just text drawn at x/y coordinates, so flat-text extraction loses the row/column
 *        grid and a weak model can't read an exact cell (a bid-summary amount, an FDR
 *        parameter). This reconstructs the grid GENERALLY: cluster text items into rows by
 *        y and columns by x, one algorithm for every PDF, no per-PDF logic. `looksTabular`
 *        gates it so a prose page falls back to flat text. Positions come from unpdf
 *        (item.transform = [a,b,c,d,x,y]); artifact-extract feeds them here.
 */

export interface PdfItem {
  str: string;
  x: number; // left edge (transform[4])
  y: number; // baseline (transform[5]); PDF y grows UPWARD, so higher y = higher on page
  w?: number;
}

// 1-D agglomerative clustering: adjacent values within `tol` join; returns cluster MEANS.
function cluster1D(values: number[], tol: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1];
    if (sorted[i] - last[last.length - 1] <= tol) last.push(sorted[i]);
    else clusters.push([sorted[i]]);
  }
  return clusters.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
}

function nearestIndex(centers: number[], v: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const d = Math.abs(centers[i] - v);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Reconstruct a grid from positioned text items. Two stages, one general algorithm:
 *   1) rows cluster by y (top-first); within a row, adjacent words merge into a CELL when the
 *      edge-to-edge gap is small (a space), so "New York" stays one cell;
 *   2) cells align into COLUMNS by a global x-model, so a missing cell stays empty instead of
 *      shifting neighbours left.
 * Tolerances default from the items' own geometry (median token width) so it adapts to font
 * size. No per-PDF logic.
 */
export function reconstructTable(
  items: PdfItem[],
  opts: { yTol?: number; xTol?: number; wordGap?: number } = {},
): string[][] {
  const real = items.filter((it) => (it.str ?? '').trim() !== '');
  if (real.length === 0) return [];

  const widthOf = (it: PdfItem) => it.w ?? Math.max(4, (it.str?.length ?? 1) * 5);
  const medW = median(real.map(widthOf));
  const yTol = opts.yTol ?? 4;                                  // < line height: same baseline
  const wordGap = opts.wordGap ?? Math.max(6, medW * 0.6);      // intra-cell space vs column gap
  const xTol = opts.xTol ?? Math.max(8, medW * 0.8);            // column alignment tolerance

  // Stage 1: rows, then merge words into cells by edge-gap.
  const rowCenters = cluster1D(real.map((i) => i.y), yTol).sort((a, b) => b - a);
  const rowItems: PdfItem[][] = rowCenters.map(() => []);
  for (const it of real) rowItems[nearestIndex(rowCenters, it.y)].push(it);

  interface Cell { str: string; x: number; right: number; }
  const rowCells: Cell[][] = rowItems.map((rowIt) => {
    const sorted = [...rowIt].sort((a, b) => a.x - b.x);
    const cells: Cell[] = [];
    for (const it of sorted) {
      const w = widthOf(it);
      const last = cells[cells.length - 1];
      if (last && it.x - last.right <= wordGap) {
        last.str += ` ${it.str.trim()}`;
        last.right = Math.max(last.right, it.x + w);
      } else {
        cells.push({ str: it.str.trim(), x: it.x, right: it.x + w });
      }
    }
    return cells;
  });

  // Stage 2: align cells into columns by clustering their left edges globally.
  const colCenters = cluster1D(rowCells.flat().map((c) => c.x), xTol);
  return rowCells.map((cells) => {
    const row = colCenters.map(() => '');
    for (const c of cells) {
      const ci = nearestIndex(colCenters, c.x);
      row[ci] = row[ci] ? `${row[ci]} ${c.str}` : c.str;
    }
    return row.map((s) => s.trim());
  });
}

/**
 * Is a reconstructed grid actually a TABLE (vs prose)? Needs >= 3 rows and >= 2 columns with
 * a reasonable fill ratio — so a page of paragraphs (one wide column) falls back to text.
 */
export function looksTabular(rows: string[][]): boolean {
  if (rows.length < 3) return false;
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols < 2) return false;
  const cells = rows.reduce((n, r) => n + r.length, 0);
  const filled = rows.reduce((n, r) => n + r.filter((c) => c !== '').length, 0);
  return filled / cells >= 0.5;
}
