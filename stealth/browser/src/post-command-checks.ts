/**
 * Decide whether a command should pay the post-navigation detection cost.
 *
 * `goto` and `click` can reveal login walls without changing URL immediately
 * (for example modal overlays), so they always run checks. `js`/`evaluate`
 * are usually read probes; only run the expensive stabilization/detection
 * pass when they actually changed the page URL.
 */
export function shouldRunPostCommandChecks(
  command: string,
  beforeUrl: string | undefined | null,
  afterUrl: string | undefined | null,
): boolean {
  if (command === 'goto' || command === 'click') return true;
  if (command !== 'js' && command !== 'evaluate') return false;
  return Boolean(beforeUrl && afterUrl && beforeUrl !== afterUrl);
}
