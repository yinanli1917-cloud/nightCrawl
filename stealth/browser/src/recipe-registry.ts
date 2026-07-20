/**
 * [INPUT]: site-profile types (SiteProfile/AuthKind/Vendor/Dynamism) + strategy-advisor
 *          Engine. Pure module — no I/O. The caller passes the live profile, the URL,
 *          and the page text it already has.
 * [OUTPUT]: Exports Recipe, RecipeMatch, RecipeSignals, RECIPES, matchRecipe, formatRecipe.
 * [POS]: Pillar 3 — capability + recipe surfacing. A data-driven registry that maps a
 *        site TYPE / content signature to an ADVISORY completion recipe and surfaces it
 *        in the engine-guidance block. It teaches the agent the high-level move (e.g. an
 *        authenticated SCORM/xAPI course completes via the LMS driver / an xAPI statement
 *        to the LRS, NOT by clicking slides) so it stops brute-forcing the DOM. Advisory
 *        only — nightcrawl NEVER auto-runs a recipe.
 *
 * Why this exists: in the texascourtclasses Cursor session the agent burned ~30 commands
 * and ~40 minutes clicking through a Storyline course before discovering SetReachedEnd /
 * TCAPI_SetCompleted. A surfaced recipe makes that the first move, not the last.
 *
 * False-positive guard: a recipe fires on an unambiguous course-PLAYER URL, OR on a
 * content signature corroborated by an authed profile — so a blog that merely mentions
 * "SCORM" never triggers.
 */

import type { Engine } from './strategy-advisor';
import type { SiteProfile, Vendor, AuthKind, Dynamism } from './site-profile';

// ─── Types ─────────────────────────────────────────────────

export interface RecipeMatch {
  vendor?: Vendor;      // hard constraint when set (applies to every trigger path)
  dynamism?: Dynamism;  // hard constraint when set
  // Path 1 — a strong, unambiguous course-player URL fires the recipe by itself.
  strongUrlRe?: RegExp;
  // Path 2 — a content signature, but ONLY with a corroborating authed profile, so a
  // blog that mentions the topic on an open page does not match.
  contentRe?: RegExp;
  authKindIn?: AuthKind[];
}

export interface Recipe {
  id: string;
  engine: Engine;   // the engine this task type actually needs
  title: string;    // one-line "what this is"
  steps: string[];  // the advisory recipe lines
  match: RecipeMatch;
}

export interface RecipeSignals {
  profile: SiteProfile;
  url: string;
  content?: string; // the page text the caller already read (may be empty)
}

// ─── Registry (data-driven) ────────────────────────────────

export const RECIPES: Recipe[] = [
  {
    id: 'xapi-course',
    engine: 'real',
    title: 'Authenticated SCORM / xAPI course (stateful, trusted interaction)',
    steps: [
      'Completion lives in your authenticated LMS/LRS session — an xAPI "completed"/"passed" statement to the LRS, NOT DOM clicks.',
      'Find the in-page course driver: GetPlayer() / SetReachedEnd / TCAPI_SetCompleted (Articulate Storyline), or the xAPI endpoint in the launch URL (endpoint=, auth=, actor=).',
      'Drive completion by calling that driver (or replaying its statement POST) with the course\'s OWN credentials — never fabricate progress.',
      'Prefer --engine=real so the call runs inside the live, logged-in session; verify on the dashboard / certificate page afterwards.',
    ],
    match: {
      // index_lms.html, tincan endpoints, client=Storyline, /scorm/ — never present on a blog.
      strongUrlRe: /index_lms|scormcontent|story[_-]?content|tincan|client=storyline|\/scorm\//i,
      contentRe: /\b(SCORM|xAPI|cmi5|tincanjs|scormdriver|articulate\s+storyline)\b/i,
      authKindIn: ['sso', 'login-wall'],
    },
  },
  {
    id: 'data-portal',
    engine: 'headless',
    title: 'Open-data / statistics portal (numbers live behind CSV/API, not the chart DOM)',
    steps: [
      'The page renders a chart or table from a backend feed — the numbers are NOT in the page text.',
      'Run `data` to surface the JSON/CSV request behind it (it prints a ready-to-run fetch), or open the table view and run `table`.',
      'Pull the raw series from that endpoint or the table — do not scrape the chart pixels.',
    ],
    match: {
      // Structural, cross-site — statistics/indicator/dataset paths + explicit data formats.
      // Public data is open, so NO authKindIn: the content path fires without a login.
      strongUrlRe: /\/(indicator|indicators|dataset|datasets|statistics|data-catalog)\b|[?&]format=(csv|json)\b/i,
      // Both a charting library AND a data affordance must co-occur (false-positive guard).
      contentRe: /(?=[\s\S]*(highcharts|echarts|plotly|chart\.js|d3\.js|amcharts|recharts|dygraph))(?=[\s\S]*(download|export|\.csv|\/api\/|dataset|\bjson\b))/i,
    },
  },
];

// ─── Matching (pure) ───────────────────────────────────────

function matches(m: RecipeMatch, sig: RecipeSignals): boolean {
  if (m.vendor && sig.profile.vendor !== m.vendor) return false;
  if (m.dynamism && sig.profile.dynamism !== m.dynamism) return false;

  const strong = !!m.strongUrlRe && m.strongUrlRe.test(sig.url);

  const contentHit = !!m.contentRe && !!sig.content && m.contentRe.test(sig.content);
  const authedOk = !m.authKindIn || m.authKindIn.includes(sig.profile.authKind);
  const contentPath = contentHit && authedOk;

  return strong || contentPath;
}

/** First recipe whose match passes, or null. Pure, total — never throws. */
export function matchRecipe(sig: RecipeSignals): Recipe | null {
  for (const r of RECIPES) if (matches(r.match, sig)) return r;
  return null;
}

// ─── Rendering ─────────────────────────────────────────────

/** Render a recipe as the advisory block appended to the guidance. */
export function formatRecipe(r: Recipe): string {
  const lines = [
    `recipe: ${r.title}`,
    ...r.steps.map((s) => `  • ${s}`),
    `  (advisory — nightcrawl never auto-runs this; recommended engine: --engine=${r.engine})`,
  ];
  return lines.join('\n');
}
