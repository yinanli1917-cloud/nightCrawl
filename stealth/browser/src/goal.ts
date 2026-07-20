/**
 * [INPUT]: Pure module — no imports.
 * [OUTPUT]: Exports GoalType, KNOWN_GOALS, parseGoal, inferGoal, inferNavGoal.
 * [POS]: Skill-library task dimension. "Optimize for tasks, not just sites" — the goal
 *        is a first-class key alongside the site type, so a recipe for (complete-course
 *        × SCORM/xAPI) transfers across every such site. A coarse string-label set, not
 *        a switch: consumers treat GoalType as an opaque key; only inferGoal branches.
 */

export type GoalType =
  | 'fetch-article' // read one page's content
  | 'extract-data'  // pull structured data (search results, listings)
  | 'export-data'   // trigger a bulk export the user owns
  | 'bulk-archive'  // bulk mutate items the user owns (archive/delete/label)
  | 'fill-form'     // fill the user's own data into a form
  | 'submit-form'   // submit a form (may assert a fact — the gate decides)
  | 'complete-course' // LMS/SCORM/xAPI completion — ALWAYS integrity-sensitive
  | 'unknown';

export const KNOWN_GOALS: readonly GoalType[] = [
  'fetch-article', 'extract-data', 'export-data', 'bulk-archive',
  'fill-form', 'submit-form', 'complete-course',
];

/** Parse an explicit --goal value. Absent/unknown → 'unknown'. Never throws. */
export function parseGoal(raw?: string): GoalType {
  if (!raw) return 'unknown';
  const v = raw.trim().toLowerCase();
  return (KNOWN_GOALS as readonly string[]).includes(v) ? (v as GoalType) : 'unknown';
}

/**
 * Weak inference from the command + URL when --goal is absent. HIGH-confidence only —
 * a strong signal or nothing. Never overrides an explicit goal (the caller prefers
 * parseGoal). Pure.
 */
export function inferGoal(command: string, url: string): GoalType {
  const u = url.toLowerCase();
  if (/index_lms|scormcontent|story[_-]?content|tincan|client=storyline|\/scorm\//.test(u)) return 'complete-course';
  if (/\/export\b|format=csv|\/download\b/.test(u) || command === 'download') return 'export-data';
  return 'unknown';
}

/**
 * Nav-time goal inference from the URL ALONE — the goto response carries no page body, so
 * content-based inference isn't available cheaply here. High-precision: a strong URL
 * signature or 'unknown' (never guess, to keep the auto nav-guidance quiet). Reuses
 * inferGoal for the export/course shapes, then adds the data-portal + article shapes. Pure.
 */
export function inferNavGoal(url: string): GoalType {
  const explicit = inferGoal('goto', url);
  if (explicit !== 'unknown') return explicit;
  const u = url.toLowerCase();
  if (/\/(indicator|indicators|dataset|datasets|statistics|data-catalog)\b|[?&]format=json\b|\bapi\./.test(u)) return 'extract-data';
  if (/\/(article|articles|news|story|report|reports|blog|posts?)\//.test(u)) return 'fetch-article';
  return 'unknown';
}
