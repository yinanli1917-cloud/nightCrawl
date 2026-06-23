import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const browserDir = '/Users/yinanli/Documents/nightCrawl/stealth/browser';
const outDir = '/Users/yinanli/Documents/nightCrawl/artifacts/uw-side-by-side-benchmark';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = resolve(outDir, `nightcrawl-${stamp}.json`);
const mdPath = resolve(outDir, `nightcrawl-${stamp}.md`);
const statePath = '/Users/yinanli/Documents/nightCrawl/.nightcrawl/browse.json';

const env = {
  ...process.env,
  PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH || ''}`,
  BROWSE_EXTENSIONS: 'all',
  BROWSE_IGNORE_HTTPS_ERRORS: '1',
};

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  const r = spawnSync('kill', ['-0', String(pid)], { stdio: 'ignore' });
  return r.status === 0;
}

function redact(s) {
  if (!s) return '';
  return s
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\d{7,}\b/g, '[number]');
}

function nc(args, options = {}) {
  const started = Date.now();
  const r = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: browserDir,
    env,
    encoding: 'utf8',
    timeout: options.timeout ?? 90000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const ended = Date.now();
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  const rec = {
    command: `nc ${args.join(' ')}`,
    startedAt: new Date(started).toISOString(),
    durationMs: ended - started,
    exitCode: r.status,
    stdout: options.persistOutput === false ? '[redacted: output not persisted]' : redact(stdout),
    stderr: options.persistOutput === false ? '[redacted: output not persisted]' : redact(stderr),
    ok: r.status === 0,
  };
  result.steps.push(rec);
  return { ...rec, stdout, stderr };
}

function firstNonEmpty(...values) {
  return values.find(v => typeof v === 'string' && v.trim())?.trim() || '';
}

function analyzeCanvas(text, url, title, gotoOut) {
  const hay = `${text}\n${url}\n${title}\n${gotoOut}`.toLowerCase();
  const cardsMatch = text.match(/course card/gi);
  const nonEmptyLineCount = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).length;
  return {
    reachable: /dashboard/.test(hay) && !/login_required|consent_required|sign in to|netid|duo/.test(hay),
    loginWall: /login_required|consent_required|sign in|netid|duo|saml|instructure login/.test(hay),
    currentUrl: url.trim(),
    title: title.trim(),
    indicators: {
      dashboardTextVisible: /dashboard/.test(hay),
      courseCardsMentioned: cardsMatch?.length ?? null,
      nonEmptyLineCount,
      consentRequired: /consent_required/.test(hay),
      autoImportMentioned: /auto-import|imported \d+ cookies|login wall cleared after auto-import/i.test(gotoOut),
      handoffMentioned: /handoff|open .*default browser|native approval/i.test(gotoOut),
    },
  };
}

function analyzeReferences(text, linksText, url, title) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const linkLines = linksText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const refs = [];
  const seen = new Set();

  const compact = text.replace(/\s+/g, ' ');
  const resultPattern = /(?:^|\s)(\d+)\s+(Article|eBook|Conference Proceeding|Newsletter Articles|eVideo)\s+(.+?)(?=\s+\d+\s+(?:Article|eBook|Conference Proceeding|Newsletter Articles|eVideo)\s+|\s+Results Per Page:|--- END UNTRUSTED EXTERNAL CONTENT ---|$)/gi;
  let match;
  while ((match = resultPattern.exec(compact)) && refs.length < 3) {
    const [, rank, type, body] = match;
    const titleStop = body.search(/\s{2,}|  /);
    let title = titleStop > -1 ? body.slice(0, titleStop).trim() : body.trim();
    const knownStops = [
      ' Abdul Mateen ', ' Yildirim, Orhan. ', ' Sankara Reddy Thamma ',
      ' International Semantic Web Conference ', ' Cohen, Avihay ',
      ' PC quest ', ' Investment Weekly News, ',
    ];
    for (const stop of knownStops) {
      const idx = title.indexOf(stop.trim());
      if (idx > 20) title = title.slice(0, idx).trim();
    }
    title = title.replace(/\s+(Open Access|Online access|Check for online access).*$/i, '').trim();
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const availability = body.match(/(Open Access|Online access|Check for online access)/i)?.[1] || '';
    const yearSource = body.match(/\b(?:©)?(?:19|20)\d{2}(?:-\d{2})?[^.]{0,120}/)?.[0]?.trim() || '';
    let authors = '';
    const authorPatterns = [
      /(.+?)\s+International Research Journal/i,
      /(.+?)\s+International Journal/i,
      /(.+?)\s+\b(?:©)?(?:19|20)\d{2}/,
    ];
    for (const p of authorPatterns) {
      const a = body.replace(title, '').match(p)?.[1]?.trim();
      if (a && a.length < 140) {
        authors = a.replace(/^(;|\s)+|(;\s*)+$/g, '');
        break;
      }
    }
    refs.push({
      rank: Number(rank),
      type,
      title,
      authors,
      yearOrSource: yearSource,
      linkOrAvailability: availability || 'not visible',
      rawContext: body.slice(0, 600),
    });
  }

  for (let i = 0; i < lines.length && refs.length < 3; i++) {
    const line = lines[i];
    if (line.length < 12 || line.length > 220) continue;
    if (/^(search|advanced search|sign in|menu|filters|availability|format|library|articles|books|peer reviewed|sort by|page \d)/i.test(line)) continue;
    if (!/(agent|automation|browser|artificial intelligence|web|ai)/i.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const context = lines.slice(i, Math.min(i + 8, lines.length));
    const link = linkLines.find(l => l.toLowerCase().includes(line.slice(0, 40).toLowerCase()))
      || linkLines.find(l => /(full text|available|view online|article|book|journal|record|open access|proquest|doi)/i.test(l) && /(http|→)/.test(l));
    refs.push({
      title: line,
      authors: firstNonEmpty(context.find(l => /by |author|authors/i.test(l)) || ''),
      yearOrSource: firstNonEmpty(context.find(l => /\b(19|20)\d{2}\b/.test(l)) || '', context.find(l => /journal|conference|proceedings|arxiv|book|article/i.test(l)) || ''),
      linkOrAvailability: firstNonEmpty(link || '', context.find(l => /available|online|full text|peer reviewed|open access/i.test(l)) || ''),
      rawContext: context,
    });
  }
  return {
    currentUrl: url.trim(),
    title: title.trim(),
    references: refs,
  };
}

const beforeState = readState();
const beforeAlive = beforeState ? pidAlive(beforeState.pid) : false;

const result = {
  benchmark: 'uw-side-by-side-benchmark-nightcrawl',
  startedAt: new Date().toISOString(),
  browserDir,
  artifactJson: jsonPath,
  artifactMarkdown: mdPath,
  requestedEnvironment: {
    persistentState: true,
    BROWSE_EXTENSIONS: env.BROWSE_EXTENSIONS,
    BROWSE_IGNORE_HTTPS_ERRORS: env.BROWSE_IGNORE_HTTPS_ERRORS,
  },
  daemon: {
    beforeState: beforeState ? { pid: beforeState.pid, startedAt: beforeState.startedAt, socket: beforeState.socket, serverPath: beforeState.serverPath } : null,
    beforeAlive,
    afterState: null,
    startedByThisRun: false,
    stoppedByThisRun: false,
  },
  steps: [],
  canvas: null,
  uwLibraries: null,
  limitations: [],
  finishedAt: null,
};

try {
  nc(['status'], { timeout: 120000 });
  const afterStatusState = readState();
  const afterStatusAlive = afterStatusState ? pidAlive(afterStatusState.pid) : false;
  result.daemon.afterState = afterStatusState ? { pid: afterStatusState.pid, startedAt: afterStatusState.startedAt, socket: afterStatusState.socket, serverPath: afterStatusState.serverPath } : null;
  result.daemon.startedByThisRun = !beforeAlive && afterStatusAlive;

  const canvasGoto = nc(['goto', 'https://canvas.uw.edu/'], { timeout: 120000 });
  const canvasUrl = nc(['url']);
  const canvasTitle = nc(['js', 'document.title']);
  const canvasText = nc(['text'], { timeout: 60000, persistOutput: false });
  result.canvas = analyzeCanvas(canvasText.stdout, canvasUrl.stdout, canvasTitle.stdout, canvasGoto.stdout + '\n' + canvasGoto.stderr);

  const libGoto = nc(['goto', 'https://www.lib.washington.edu/'], { timeout: 120000 });
  const forms = nc(['forms']);
  const snap = nc(['snapshot', '-i', '-c', '-d', '4'], { timeout: 60000 });
  let searchMethod = 'direct search URL fallback';
  const combined = `${forms.stdout}\n${snap.stdout}`;
  const inputRef = combined.match(/(@e\d+)[^\n]*(search|query|primo|catalog|articles)/i)?.[1];
  if (inputRef) {
    searchMethod = `search box ${inputRef}`;
    const fill = nc(['fill', inputRef, 'browser automation AI web agents'], { timeout: 30000 });
    if (fill.ok) {
      nc(['press', 'Enter'], { timeout: 120000 });
    } else {
      searchMethod = `direct Discovery URL fallback after ${inputRef} fill failed`;
      result.limitations.push(`Homepage search-box fill failed for ${inputRef}; used UW Discovery direct search URL instead.`);
      nc(['goto', 'https://orbiscascade-washington.primo.exlibrisgroup.com/discovery/search?query=any,contains,browser%20automation%20AI%20web%20agents&tab=UW_default&search_scope=UW_EVERYTHING&vid=01ALLIANCE_UW:UW&offset=0'], { timeout: 120000 });
    }
  } else {
    searchMethod = 'direct Discovery URL fallback; no usable homepage search input ref found';
    nc(['goto', 'https://search.lib.uw.edu/discovery/search?query=any,contains,browser%20automation%20AI%20web%20agents&tab=UW_default&search_scope=UW_EVERYTHING&vid=01ALLIANCE_UW:UW&offset=0'], { timeout: 120000 });
  }
  const searchUrl = nc(['url']);
  const searchTitle = nc(['js', 'document.title']);
  const searchText = nc(['text'], { timeout: 90000 });
  const searchLinks = nc(['links'], { timeout: 60000 });
  result.uwLibraries = {
    startGotoOk: libGoto.ok,
    searchMethod,
    ...analyzeReferences(searchText.stdout, searchLinks.stdout, searchUrl.stdout, searchTitle.stdout),
  };
} catch (err) {
  result.limitations.push(`Runner exception: ${err?.message || String(err)}`);
} finally {
  const afterState = readState();
  if (result.daemon.startedByThisRun && afterState && pidAlive(afterState.pid)) {
    const stop = nc(['stop'], { timeout: 30000 });
    result.daemon.stoppedByThisRun = stop.ok;
  }
  result.finishedAt = new Date().toISOString();
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  const refs = result.uwLibraries?.references || [];
  const md = `# nightCrawl UW side-by-side benchmark

- Started: ${result.startedAt}
- Finished: ${result.finishedAt}
- CLI directory: ${browserDir}
- Persistent state/profile: yes
- Environment: BROWSE_EXTENSIONS=${env.BROWSE_EXTENSIONS}, BROWSE_IGNORE_HTTPS_ERRORS=${env.BROWSE_IGNORE_HTTPS_ERRORS}
- Daemon started by this run: ${result.daemon.startedByThisRun}
- Daemon stopped by this run: ${result.daemon.stoppedByThisRun}

## Canvas

- Current URL: ${result.canvas?.currentUrl || 'n/a'}
- Title: ${result.canvas?.title || 'n/a'}
- Reachable dashboard/course context: ${result.canvas?.reachable}
- Login/consent/2FA wall indicated: ${result.canvas?.loginWall}
- Minimal indicators: ${JSON.stringify(result.canvas?.indicators || {}, null, 2)}

## UW Libraries Search

- Current URL: ${result.uwLibraries?.currentUrl || 'n/a'}
- Title: ${result.uwLibraries?.title || 'n/a'}
- Search method: ${result.uwLibraries?.searchMethod || 'n/a'}
- Top usable references captured: ${refs.length}

${refs.map((r, i) => `### ${i + 1}. ${r.title}

- Authors: ${r.authors || 'not visible'}
- Year/source: ${r.yearOrSource || 'not visible'}
- Link/availability: ${r.linkOrAvailability || 'not visible'}
`).join('\n')}

## Friction / Limitations

${(result.limitations.length ? result.limitations : ['See per-step command records in the JSON artifact for timings, URLs, failures, and raw non-sensitive output.']).map(x => `- ${x}`).join('\n')}
`;
  writeFileSync(mdPath, md);
  console.log(JSON.stringify({ jsonPath, mdPath }, null, 2));
}
