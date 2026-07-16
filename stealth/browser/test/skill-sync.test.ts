/**
 * [INPUT]: Reads the two nightcrawl SKILL.md copies at repo root
 *          (.claude/skills/nightcrawl/ and .agents/skills/nightcrawl/).
 * [OUTPUT]: Fails if the two copies drift apart, so `bun test` is the
 *           "always synced across all agents" guarantee the user asked for.
 * [POS]: Regression guard. The .agents copy silently fell behind the .claude
 *        copy once (missing the whole autofill feature); this stops that from
 *        happening again — Claude Code and Codex must trigger the SAME skill.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Repo root is three levels up from this test file (test/ -> browser/ ->
// stealth/ -> root). The two skill copies live under root.
// ---------------------------------------------------------------------------
const ROOT = join(import.meta.dir, '..', '..', '..');
const CLAUDE_COPY = join(ROOT, '.claude', 'skills', 'nightcrawl', 'SKILL.md');
const AGENTS_COPY = join(ROOT, '.agents', 'skills', 'nightcrawl', 'SKILL.md');

describe('nightcrawl skill copies stay synced', () => {
  test('both copies exist', () => {
    expect(existsSync(CLAUDE_COPY)).toBe(true);
    expect(existsSync(AGENTS_COPY)).toBe(true);
  });

  test('.claude and .agents SKILL.md are byte-identical', () => {
    const claude = readFileSync(CLAUDE_COPY, 'utf8');
    const agents = readFileSync(AGENTS_COPY, 'utf8');
    // A plain equality assertion keeps the failure message short; when it
    // fails, run `diff .claude/skills/nightcrawl/SKILL.md
    // .agents/skills/nightcrawl/SKILL.md` to see what drifted, then copy the
    // canonical (.claude) copy over the other.
    expect(agents).toBe(claude);
  });
});
