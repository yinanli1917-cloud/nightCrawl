/**
 * [INPUT]: Pure module — no imports. The daemon owns the `seen` Set (one per process,
 *          keyed by session+domain) and passes it in; the gate logic stays pure.
 * [OUTPUT]: Exports shouldEmitBanner, clearBannerSession.
 * [POS]: Track B P0-2. The engine-guidance banner is useful ONCE per domain — after
 *        that it is noise (the real Gmail session printed it ~333 times). This gate
 *        collapses it to the first command per (session, domain), unless --verbose.
 *        The emit decision also drives the loop's bannerNoiseRate signal. Keeping the
 *        state in the caller (a Set) makes the decision a pure, testable function.
 */

/**
 * Decide whether to print the engine-guidance banner for this command. Emits once per
 * (session, domain); a repeat is suppressed. --verbose always emits. Mutates `seen`
 * (the caller's per-daemon state) to record that this pair has now been shown.
 */
export function shouldEmitBanner(
  seen: Set<string>,
  sessionId: string,
  domain: string,
  verbose: boolean,
): boolean {
  if (verbose) return true;
  const key = `${sessionId}|${domain}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/** Re-arm a session (e.g. on session end / new task) without touching other sessions. */
export function clearBannerSession(seen: Set<string>, sessionId: string): void {
  const prefix = `${sessionId}|`;
  for (const key of seen) if (key.startsWith(prefix)) seen.delete(key);
}
