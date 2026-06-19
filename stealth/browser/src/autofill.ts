/**
 * [INPUT]: Depends on BrowserManager (DOM discovery + fill), field-matcher
 *          (pure matching), profile-store (the vault), sensitive-page (safety gate).
 * [OUTPUT]: Exports handleAutofill — the `autofill` write command.
 * [POS]: C2 autofill orchestration. Fills BLANK form fields from the local
 *        non-secret profile vault, after consulting the sensitive-page gate.
 *
 * Policy (gate → action):
 *   payment / account_security / destructive → REFUSE (never autofill these).
 *   personal_info                            → fill only with --confirm.
 *   unflagged (signup / contact / search)    → fill freely.
 * Secret fields can never be filled regardless — field-matcher returns null for
 * password/card/cvv/ssn/otp, and the vault has no key for them.
 */

import type { BrowserManager } from './browser-manager';
import { matchFields, type AutofillField, type ProfileKey } from './field-matcher';
import { readProfile } from './profile-store';
import { detectSensitivePage } from './sensitive-page';

interface AutofillOpts {
  dryRun: boolean;
  confirm: boolean;
  includeFilled: boolean;
  only: Set<string> | null;
}

function parseArgs(args: string[]): AutofillOpts {
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 && args[onlyIdx + 1]
    ? new Set(args[onlyIdx + 1].split(',').map((s) => s.trim()).filter(Boolean))
    : null;
  return {
    dryRun: args.includes('--dry-run'),
    confirm: args.includes('--confirm'),
    includeFilled: args.includes('--include-filled'),
    only,
  };
}

// Categories autofill must never touch — exactly what the gate already flags.
const REFUSE_CATEGORIES = new Set(['payment', 'account_security', 'destructive']);

/**
 * Discover every fillable field on the page, tagging each with a unique
 * data-nc-af attribute so we can target it precisely afterward (works even for
 * fields with no id/name). Adds autocomplete + aria-label that `forms` drops.
 */
async function discoverFields(target: any): Promise<(AutofillField & { ref: number })[]> {
  return await target.evaluate(() => {
    const els = [...document.querySelectorAll('input, select, textarea')];
    return els.map((el, i) => {
      const input = el as HTMLInputElement;
      el.setAttribute('data-nc-af', String(i));
      return {
        ref: i,
        tag: el.tagName.toLowerCase(),
        type: input.type || undefined,
        name: input.name || undefined,
        id: input.id || undefined,
        placeholder: input.placeholder || undefined,
        autocomplete: input.getAttribute('autocomplete') || undefined,
        ariaLabel: input.getAttribute('aria-label') || undefined,
        required: input.required || undefined,
        value: input.type === 'password' ? '[redacted]' : (input.value || undefined),
        options: el.tagName === 'SELECT'
          ? [...(el as HTMLSelectElement).options].map((o) => ({ value: o.value, text: o.text }))
          : undefined,
      };
    });
  });
}

export async function handleAutofill(args: string[], bm: BrowserManager): Promise<string> {
  const opts = parseArgs(args);
  const page = bm.getPage();
  const target = bm.getActiveFrameOrPage();
  const url = bm.getCurrentUrl();

  // ── Safety gate ──────────────────────────────────────────
  const sensitive = await detectSensitivePage(page).catch(() => null);
  if (sensitive && REFUSE_CATEGORIES.has(sensitive.category)) {
    return `Refusing autofill on a ${sensitive.category.replace('_', ' ')} page ` +
      `(signals: ${sensitive.signals.join(', ')}).\n` +
      `nightCrawl never auto-fills payment, security, or destructive forms — use 'open-handoff' to do it yourself.`;
  }
  const personalNeedsConfirm =
    sensitive?.category === 'personal_info' && !opts.confirm && !opts.dryRun;

  // ── Profile + matching ───────────────────────────────────
  const profile = readProfile().fields;
  if (Object.keys(profile).length === 0) {
    return `Profile is empty. Add non-secret fields first, e.g.:\n  nc profile set email you@example.com\n  nc profile set givenName Jane`;
  }

  const fields = await discoverFields(target);
  let results = matchFields(fields as AutofillField[], profile, { includeFilled: opts.includeFilled });
  if (opts.only) {
    results = results.map((r) =>
      r.match && opts.only!.has(r.match.profileKey) ? r : { ...r, match: r.match, skip: 'no-match' as const, profileValue: undefined });
  }

  const fillable = results.filter((r) => r.profileValue != null);
  const reportOnly = opts.dryRun || personalNeedsConfirm;

  // ── Fill (unless report-only) ────────────────────────────
  const filled: string[] = [];
  const failed: string[] = [];
  if (!reportOnly) {
    for (const r of fillable) {
      const ref = (r.field as AutofillField & { ref: number }).ref;
      const sel = `[data-nc-af="${ref}"]`;
      try {
        if (r.field.tag === 'select') await target.locator(sel).selectOption(r.profileValue!, { timeout: 5000 });
        else await target.locator(sel).fill(r.profileValue!, { timeout: 5000 });
        filled.push(`${describe(r.field)} ← ${r.match!.profileKey} "${preview(r.profileValue!)}" (${r.match!.confidence})`);
      } catch (e: any) {
        failed.push(`${describe(r.field)} ← ${r.match!.profileKey}: ${e?.message ?? e}`);
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
  }

  return formatReport(url, sensitive?.category ?? null, reportOnly, personalNeedsConfirm, fillable, filled, failed);
}

// ─── Reporting ──────────────────────────────────────────────

function describe(f: AutofillField): string {
  return f.id ? `#${f.id}` : f.name ? `[name=${f.name}]` : `<${f.tag}>`;
}
function preview(v: string): string {
  return v.length > 24 ? v.slice(0, 21) + '…' : v;
}

function formatReport(
  url: string,
  category: string | null,
  reportOnly: boolean,
  personalNeedsConfirm: boolean,
  fillable: ReturnType<typeof matchFields>,
  filled: string[],
  failed: string[],
): string {
  const head = `Autofill on ${url}${category ? ` (${category})` : ''}${reportOnly ? ' — dry run' : ''}`;
  const lines = [head];

  if (reportOnly) {
    for (const r of fillable) lines.push(`  · ${describe(r.field)} ← ${r.match!.profileKey} "${preview(r.profileValue!)}" (${r.match!.confidence})`);
    if (fillable.length === 0) lines.push('  (no blank fields matched your profile)');
    if (personalNeedsConfirm) lines.push(`\nPersonal-info form detected — re-run with --confirm to fill ${fillable.length} field(s).`);
    else lines.push(`\nWould fill ${fillable.length} field(s). Re-run without --dry-run to apply.`);
    return lines.join('\n');
  }

  for (const f of filled) lines.push(`  ✓ ${f}`);
  for (const f of failed) lines.push(`  ✗ ${f}`);
  lines.push(`Filled ${filled.length}${failed.length ? `, ${failed.length} failed` : ''}.`);
  return lines.join('\n');
}
