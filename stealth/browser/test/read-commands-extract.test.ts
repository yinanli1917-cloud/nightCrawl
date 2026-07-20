/**
 * [INPUT]: Depends on read-extract.ts (capOutput + find/table/read/data helpers).
 * [OUTPUT]: Verifies the forgiving high-level read primitives that let a WEAK model
 *           extract data without hand-writing DOM JS: find, table, read, data, and the
 *           shared output cap. Pure functions tested directly; DOM extraction is faked
 *           at target.evaluate (live-verified separately) — same posture as
 *           read-commands-eval.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import {
  capOutput,
  formatFind,
  parseFindArgs,
  findInPage,
  type FindMatch,
  formatTableList,
  selectTable,
  formatTable,
  extractTables,
  parseNumeric,
  resolveColumn,
  sortRows,
  parseTableOpts,
  type RawTable,
  scoreDataRequest,
  rankDataRequests,
  findDataRequests,
} from '../src/read-extract';
import type { DeepNetEntry } from '../src/network-capture-deep';

const fakeBm = (target: any): any => ({
  getPage: () => target,
  getActiveFrameOrPage: () => target,
  resolveRef: async (sel: string) => ({ selector: sel }),
});

// ─── capOutput ───────────────────────────────────────────────
describe('capOutput', () => {
  test('leaves short text untouched (no footer)', () => {
    expect(capOutput('hello', 100)).toBe('hello');
  });

  test('truncates over-limit text and appends a targeting footer', () => {
    const out = capOutput('x'.repeat(50), 10);
    expect(out.startsWith('x'.repeat(10))).toBe(true);
    expect(out).toContain('showing 10 of 50 chars');
    expect(out).toContain('find <keyword>');
    expect(out).toContain('table');
  });

  test('honors BROWSE_MAX_OUTPUT when no explicit limit is passed', () => {
    const prev = process.env.BROWSE_MAX_OUTPUT;
    process.env.BROWSE_MAX_OUTPUT = '5';
    try {
      expect(capOutput('abcdefgh')).toContain('showing 5 of 8 chars');
    } finally {
      if (prev === undefined) delete process.env.BROWSE_MAX_OUTPUT;
      else process.env.BROWSE_MAX_OUTPUT = prev;
    }
  });
});

// ─── find ────────────────────────────────────────────────────
describe('find', () => {
  test('parseFindArgs: keyword, -C context, --all, --re, multi-word', () => {
    expect(parseFindArgs(['Thereafter'])).toEqual({ keyword: 'Thereafter', context: 120, all: false, regex: false });
    expect(parseFindArgs(['-C', '40', 'Operating', 'lease'])).toEqual({ keyword: 'Operating lease', context: 40, all: false, regex: false });
    expect(parseFindArgs(['--all', '--re', 'foo\\d+'])).toEqual({ keyword: 'foo\\d+', context: 120, all: true, regex: true });
    // the -C value must NOT be mistaken for the keyword
    expect(parseFindArgs(['-C', '40', 'x']).keyword).toBe('x');
  });

  test('formatFind renders matches with a table pointer', () => {
    const m: FindMatch[] = [
      { context: '…Thereafter 524…', tableIndex: 3 },
      { context: '…another Thereafter…', tableIndex: null },
    ];
    const out = formatFind(m, 'Thereafter');
    expect(out).toContain('[match 1] …Thereafter 524…');
    expect(out).toContain('→ in table #3 (use: table 3)');
    expect(out).toContain('[match 2]');
    expect(out.split('\n')[1]).not.toContain('table #'); // second has no table pointer
  });

  test('formatFind returns a coaching line, never empty, when nothing matches', () => {
    const out = formatFind([], 'nowhere');
    expect(out).toContain('no "nowhere"');
    expect(out).toContain('read');
    expect(out).toContain('snapshot');
  });

  test('findInPage formats the raw matches from the page', async () => {
    const target = { evaluate: async () => [{ context: '…hit…', tableIndex: 1 }] };
    const out = await findInPage(target as any, 'hit', { context: 120, all: false, regex: false });
    expect(out).toContain('[match 1] …hit…');
    expect(out).toContain('table 1');
  });
});

// ─── table ───────────────────────────────────────────────────
const TABLES: RawTable[] = [
  { index: 0, rows: [['Year', 'Amount'], ['2024', '524']], caption: 'Operating lease' },
  { index: 1, rows: [['A', 'B'], ['1', '2']], caption: '' },
];

describe('table', () => {
  test('formatTableList lists dims, caption, header preview', () => {
    const out = formatTableList(TABLES);
    expect(out).toContain('#0  2×2 "Operating lease"  Year | Amount');
    expect(out).toContain('#1  2×2');
    expect(out).toContain('table <index>');
  });

  test('formatTableList coaches when there are no tables', () => {
    expect(formatTableList([])).toContain('no tables');
  });

  test('selectTable by index', () => {
    expect(selectTable(TABLES, ['1'])).toEqual(TABLES[1]);
  });

  test('selectTable near <keyword> matches on cell content', () => {
    expect(selectTable(TABLES, ['near', '524'])).toEqual(TABLES[0]);
  });

  test('selectTable near miss returns a coaching error', () => {
    const r = selectTable(TABLES, ['near', 'zzz']);
    expect('error' in r && r.error).toContain('no table contains');
  });

  test('formatTable emits TSV by default', () => {
    expect(formatTable(TABLES[0], { json: false, rowCap: 200 })).toBe('Year\tAmount\n2024\t524');
  });

  test('formatTable --json keys body rows by the header row', () => {
    const out = formatTable(TABLES[0], { json: true, rowCap: 200 });
    expect(JSON.parse(out)).toEqual([{ Year: '2024', Amount: '524' }]);
  });

  test('formatTable applies the row cap with a footer', () => {
    const big: RawTable = { index: 0, rows: Array.from({ length: 10 }, (_, i) => [String(i)]), caption: '' };
    const out = formatTable(big, { json: false, rowCap: 3 });
    expect(out.split('\n').filter(l => !l.includes('showing')).join('\n').trim().split('\n').length).toBe(3);
    expect(out).toContain('showing 3 of 10 rows');
  });

  test('extractTables with no arg lists all tables', async () => {
    const target = { evaluate: async () => TABLES };
    const out = await extractTables(target as any, fakeBm(target), []);
    expect(out).toContain('#0');
    expect(out).toContain('#1');
  });

  test('extractTables with an index returns that table as TSV', async () => {
    const target = { evaluate: async () => TABLES };
    const out = await extractTables(target as any, fakeBm(target), ['0']);
    expect(out).toContain('2024\t524');
  });
});

// ─── table --sort/--desc/--top (reasoning-reducer) ───────────
describe('table sort/top', () => {
  test('parseNumeric strips commas/currency/percent', () => {
    expect(parseNumeric('1,234')).toBe(1234);
    expect(parseNumeric('$5.6')).toBe(5.6);
    expect(parseNumeric('78%')).toBe(78);
    expect(parseNumeric('2006')).toBe(2006);
    expect(parseNumeric('n/a')).toBeNull();
    expect(parseNumeric('')).toBeNull();
  });

  test('resolveColumn accepts an index or a header name (substring, case-insensitive)', () => {
    const header = ['Country', 'Population', 'GDP per capita'];
    expect(resolveColumn(header, '1')).toBe(1);
    expect(resolveColumn(header, 'population')).toBe(1);
    expect(resolveColumn(header, 'gdp')).toBe(2);
    expect(resolveColumn(header, 'nope')).toBe(-1);
  });

  test('sortRows sorts numerically, keeps the header, honors desc', () => {
    const rows = [['City', 'Pop'], ['A', '1,000'], ['B', '90'], ['C', '300']];
    const asc = sortRows(rows, 1, false);
    expect(asc.map(r => r[0])).toEqual(['City', 'B', 'C', 'A']); // 90 < 300 < 1000
    const desc = sortRows(rows, 1, true);
    expect(desc.map(r => r[0])).toEqual(['City', 'A', 'C', 'B']);
  });

  test('sortRows falls back to lexical when a column is non-numeric', () => {
    const rows = [['Name'], ['Charlie'], ['alice'], ['Bob']];
    expect(sortRows(rows, 0, false).map(r => r[0])).toEqual(['Name', 'alice', 'Bob', 'Charlie']);
  });

  test('parseTableOpts pulls --sort/--desc/--top and leaves positional intact', () => {
    const o = parseTableOpts(['2', '--sort', 'Population', '--desc', '--top', '3', '--json']);
    expect(o.positional).toEqual(['2']);
    expect(o.sortCol).toBe('Population');
    expect(o.desc).toBe(true);
    expect(o.top).toBe(3);
    expect(o.json).toBe(true);
  });

  test('extractTables --sort --desc --top gives the max row first, capped', async () => {
    const T: RawTable[] = [{ index: 0, caption: '', rows: [['City', 'Pop'], ['A', '1,000'], ['B', '90'], ['C', '300']] }];
    const target = { evaluate: async () => T };
    const out = await extractTables(target as any, fakeBm(target), ['--sort', 'Pop', '--desc', '--top', '1']);
    const lines = out.split('\n').filter(l => l && !l.includes('showing') && !l.startsWith('(') && !l.startsWith('—'));
    expect(lines[0]).toBe('City\tPop');
    expect(lines[1]).toBe('A\t1,000'); // the max
    expect(lines.length).toBe(2);      // header + top 1
  });

  test('extractTables warns when the sort column is not found (unsorted, with a note)', async () => {
    const T: RawTable[] = [{ index: 0, caption: '', rows: [['City', 'Pop'], ['A', '1'], ['B', '2']] }];
    const target = { evaluate: async () => T };
    const out = await extractTables(target as any, fakeBm(target), ['--sort', 'ZZZ']);
    expect(out).toMatch(/not found|unsorted/i);
  });
});

// ─── data (backend data-request finder) ──────────────────────
const entry = (o: Partial<DeepNetEntry>): DeepNetEntry => ({
  timestamp: 0, method: 'GET', url: 'https://x/', resourceType: 'fetch', ...o,
});

describe('data', () => {
  test('scoreDataRequest rewards JSON/CSV + data-shaped URLs, punishes analytics', () => {
    const api = entry({ url: 'https://api.worldbank.org/v2/country/CN/indicator/SP.ADO.TFRT?format=json', respContentType: 'application/json', respBodySample: '[{"date":"2006"}]' });
    const analytics = entry({ url: 'https://www.google-analytics.com/collect?v=1' });
    const plain = entry({ url: 'https://x/logo.png', resourceType: 'fetch' });
    expect(scoreDataRequest(api)).toBeGreaterThan(0);
    expect(scoreDataRequest(analytics)).toBeLessThan(0);
    expect(scoreDataRequest(api)).toBeGreaterThan(scoreDataRequest(plain));
  });

  test('a script/JSONP response carrying data is scored as data (Maoyan/World Bank class)', () => {
    const jsonp = entry({ url: 'https://box.maoyan.com/promovie/api/box/second.json', resourceType: 'script', respContentType: 'application/javascript', respBodySample: 'cb({"movieList":[{"boxInfo":"3.2亿"}]})' });
    expect(scoreDataRequest(jsonp)).toBeGreaterThan(0);
    // an analytics script is still excluded even when its body looks structured
    const trackScript = entry({ url: 'https://www.googletagmanager.com/gtm.js', resourceType: 'script', respBodySample: '{"e":1}' });
    expect(scoreDataRequest(trackScript)).toBeLessThan(0);
  });

  test('de-ranks third-party telemetry vendors, even JSON POSTs (App Insights, etc.)', () => {
    const appInsights = entry({ method: 'POST', url: 'https://dc.services.visualstudio.com/v2/track', respContentType: 'application/json' });
    const newrelic = entry({ method: 'POST', url: 'https://bam.nr-data.net/events/1/abc', respContentType: 'application/json' });
    expect(scoreDataRequest(appInsights)).toBeLessThan(0);
    expect(scoreDataRequest(newrelic)).toBeLessThan(0);
    expect(rankDataRequests([appInsights, newrelic])).toEqual([]);
  });

  test('rankDataRequests drops non-data noise and sorts best-first', () => {
    const api = entry({ url: 'https://api.site.com/v2/data.json', respContentType: 'application/json', respBodySample: '[1,2,3]' });
    const analytics = entry({ url: 'https://segment.io/collect' });
    const ranked = rankDataRequests([analytics, api]);
    expect(ranked[0]).toBe(api);
    expect(ranked).not.toContain(analytics);
  });

  test('findDataRequests emits a runnable fetch shortcut per candidate', () => {
    const api = entry({ url: 'https://api.site.com/v2/data.json', respContentType: 'application/json', respBodySample: '[1]' });
    const out = findDataRequests([], [api]);
    expect(out).toContain('GET https://api.site.com/v2/data.json');
    expect(out).toContain('fetch: browse js');
    expect(out).toContain('await fetch("https://api.site.com/v2/data.json")');
  });

  test('findDataRequests coaches when nothing data-like was captured', () => {
    const out = findDataRequests([], [entry({ url: 'https://cdn/app.js' })]);
    expect(out).toContain('no data-like requests');
  });
});
