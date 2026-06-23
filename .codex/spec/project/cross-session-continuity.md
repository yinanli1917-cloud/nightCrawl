# Cross-Session Continuity

This spec defines the durable continuity contract for Codex harness sessions.
It is intentionally index-first: startup may read the project spec index and a
short task-memory summary, but full spec bodies stay on-demand through
`context --full`, `context --preview-sources`, or task context manifests.

## Goals

- Distinguish continuation work from unrelated parallel work.
- Preserve high-signal task facts without relying on raw chat memory.
- Keep default startup bounded and predictable.
- Make continuity native to the existing harness lifecycle.

## Default Startup Budget

- Rank nonterminal tasks with cheap metadata first: title, description, status,
  phase, branch, package, scope, PRD goal summary, context file refs, and
  related paths.
- Read task-local compact memory only for the top 3 candidates.
- Read about 1-2 KB of compact memory per candidate.
- Do not load raw transcripts, full journals, full PRDs, handoff bodies, or
  broad source previews by default.

## Task Memory

Each task may have `memory.jsonl` for compact continuity facts.

Allowed entry types:

- `decision`
- `constraint`
- `reference`
- `next_action`
- `open_question`
- `phase`
- `note`

Entries should include an id, type, text, source, timestamp, confidence, and
optional path/tag/supersedes metadata. Store facts such as design references,
constraints, open questions, target areas, and current next action. Do not store
raw dialogue, implementation logs, generic session summaries, or transcript
compression.

## Matching Rules

- Auto-bind only when one task is a high-confidence match and there is no close
  competing candidate.
- When continuity is ambiguous, ask the user or remain detached.
- Requests that explicitly ask for new, unrelated, separate, or parallel work
  must not auto-bind to old task memory.
- Latest explicit user instruction wins over compact memory. If memory appears
  stale or conflicting, surface a short warning and follow the current request.

## Update Boundaries

Compact memory updates happen only at explicit boundaries:

- planning decision answered
- task phase change
- finish-work/task completion
- explicit `task memory add` request
- explicit memory tombstone or compaction

Do not run per-turn summarization.

## Verification

Continuity changes should verify:

- bounded startup output remains compact
- no raw transcript/full journal default load
- clear-match auto-bind works
- ambiguous matches stay detached
- task memory add/list/tombstone/compact works
- projected spec and workflow files migrate cleanly
- latest user request takes precedence over stale memory
