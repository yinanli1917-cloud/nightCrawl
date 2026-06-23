# Codex Workflow

This is the Codex-native source of truth for this project. Codex hooks and harness context load it automatically when available; `scripts/codex_harness.py context` is the pull-based fallback.

## Global Harness Projection

The harness is global and mandatory across active projects. Project-local
`.codex/workflow.md`, hook wrappers, agent templates, and
`scripts/codex_harness.py` are projected files from
`~/.codex/harness`, not independent project contracts.

When the global harness changes, apply it to active projects with
`python3 scripts/codex_harness.py migrate --all` from any harness-enabled
project. Migration bootstraps missing registered-project wrappers/spec indexes,
then records the applied global contract in `.codex/harness-state.json`.
`templates canonical-check` and the global verifier must fail stale projected
files, stale task schemas, or stale continuity state even if the old
project-local `.template-hashes.json` still passes.

Install/update should feel seamless: one install registers the selected project
plus real Codex-trusted work folders, registered active projects auto-migrate
after safe prechecks, scratch/session folders are ignored, and background work
is reported with concise notices.

## Expected Process

```
start request
  -> no_task: answer directly only for pure Q&A; route brainstorm/design/plan/new-feature requests to planning
  -> planning: use grill-me, record task questions, write prd.md, curate implement.jsonl/check.jsonl
  -> start: validate readiness, then enter implementation
  -> in_progress: codex-implement -> codex-check -> update-spec -> commit/verify -> finish-work
  -> finish: record session, finish/archive
```

## Workflow States

[workflow-state:no_task]
No active task. Direct Q&A can be answered inline only when the request is genuinely a small answer and is not feature/design/planning work. SKILL_ROUTING_GUARDRAIL: before searching, opening tools, creating a task, or answering, match the current request against available skills and load every clearly triggered specific, related, or relevant skill. Examples: use `nightcrawl` / `kimi-webbridge` / `browser` for real logged-in or live web access such as Canvas; use Gmail/Google Drive skills for mailbox or Drive files; use `read`, `learn`, or `deep-research` for source retrieval and research; use PDF/documents/spreadsheets/presentations skills for those artifact types. If the user says "brainstorm", "design", "plan", "thinking of creating", "should we build", "how should we build", or describes a new feature, architecture, product workflow, or multi-step investigation, treat it as planning work: create a Codex task first with `python3 scripts/codex_harness.py task create "<title>"`, then use `grill-me`. Do not answer brainstorm/design prompts as inline Q&A just because they are phrased as a question. For implementation, refactor, debugging, research-heavy work, harness changes, commit, or push work, create a task before editing. User override is per-turn only when the current message explicitly asks to skip task flow. NO_TASK_GUARDRAIL: do not edit files for implementation, refactor, debugging, research-heavy, or harness work until a task is created or the user explicitly skips task flow in this turn.
[/workflow-state:no_task]

[workflow-state:planning]
Planning task is active. SKILL_ROUTING_GUARDRAIL: before planning, searching, opening tools, or answering, match the current request against available skills and load every clearly triggered specific, related, or relevant skill. Empty PRD/context scaffolds are not a reason to drift into generic analysis; they are the reason to run the planning interview. Use `grill-me` as the planning interview loop immediately: ask one unresolved decision at a time, record it with `task question ask`, answer it with `task question answer`, and mirror the result into `prd.md`. Explore code only when a `grill-me` question can be answered from the repository without asking the user. Before implementation, `prd.md` must contain a real Goal and Acceptance Criteria, and `implement.jsonl` / `check.jsonl` must contain real files; the seed `_example` row does not count. Run `task question validate` and `task validate` until READY, then `task start`.
[/workflow-state:planning]

[workflow-state:in_progress]
Implementation task is active. SKILL_ROUTING_GUARDRAIL: before implementation, checking, research, browser work, or answering, match the current request against available skills and load every clearly triggered specific, related, or relevant skill. Use `prd.md`, `implement.jsonl`, and `check.jsonl` as the context contract. Main-session default: dispatch `codex-implement` for implementation and `codex-check` for verification unless the user's current message explicitly asks to work inline. Sub-agent self-exemption: if you are already `codex-implement` or `codex-check`, do the assigned work directly and do not spawn another same-role agent. Required sequence: implement -> check -> update specs only when durable patterns changed -> verify -> commit if the user requested commit/publish or the task completion contract requires it -> `finish-work`. Keep backend maintenance details in diagnostics unless they truly block the user's requested work.
[/workflow-state:in_progress]

[workflow-state:paused]
Task is paused. Resume with `python3 scripts/codex_harness.py task continue <task>` and inspect `current_phase` / `next_action` before editing.
[/workflow-state:paused]

[workflow-state:completed]
Task is completed. Archive it if no further work remains. If code or docs are still dirty because of this task, finish verification and cleanup before archiving.
[/workflow-state:completed]

## Spec Update Rule

Update specs when the task creates a durable pattern, convention, architecture
boundary, operational rule, or bug-prevention lesson. Do not expose impact-level
taxonomy in normal user-facing workflow; if impact analysis is useful, keep it
as internal check/update-spec reasoning.

## Task Commands

```bash
python3 scripts/codex_harness.py session decide --request "<current user request>"
python3 scripts/codex_harness.py task create "<title>"
python3 scripts/codex_harness.py task question ask <slug-or-dir> "<question>" --recommended-answer "<answer>"
python3 scripts/codex_harness.py task question answer <slug-or-dir> <id> "<answer>"
python3 scripts/codex_harness.py task question list <slug-or-dir>
python3 scripts/codex_harness.py task question validate <slug-or-dir>
python3 scripts/codex_harness.py task validate <slug-or-dir>
python3 scripts/codex_harness.py task continue [slug-or-dir]
python3 scripts/codex_harness.py task start <slug-or-dir>
python3 scripts/codex_harness.py task current
python3 scripts/codex_harness.py task finish [slug-or-dir]
python3 scripts/codex_harness.py task archive <slug-or-dir>
python3 scripts/codex_harness.py task add-context <slug-or-dir> implement <path> "<reason>"
python3 scripts/codex_harness.py task add-context <slug-or-dir> check <path> "<reason>"
python3 scripts/codex_harness.py task agent-context <slug-or-dir> implement
python3 scripts/codex_harness.py task agent-context <slug-or-dir> check
python3 scripts/codex_harness.py task memory add <slug-or-dir> reference "Use AMLL as the UX reference" --source "user:decision"
python3 scripts/codex_harness.py task memory list <slug-or-dir>
python3 scripts/codex_harness.py record-session --title "<title>" --summary "<summary>"
python3 scripts/codex_harness.py finish-work --complete --archive --request "<current user request>" --summary "<summary>"
python3 scripts/codex_harness.py templates hash-check
python3 scripts/codex_harness.py templates canonical-check
python3 scripts/codex_harness.py migrate --all
```

## Skill And Command Mapping

- Trellis `brainstorm`: Codex `grill-me` skill during `planning`.
- Trellis `before-dev`: Codex `task validate`, `task agent-context`, and `task start`.
- Trellis `check`: Codex review stance plus task-specific checks from `check.jsonl`.
- Trellis `update-spec`: Codex spec update only when durable patterns changed.
- Trellis `finish-work`: Codex `finish-work` with verification, journal record, finish, and optional archive.
- Trellis `continue`: Codex `task continue`, driven by `status`, `current_phase`, `next_action`, and readiness.

## Completion Contract

Do not claim task completion until:

- required files are changed
- `python3 scripts/codex_harness.py health` has been run
- task-specific checks have been run and reported
- durable behavior changes have required spec updates, or spec update is explicitly not applicable
- workflow-state required steps are represented in the matching breadcrumb block
- `python3 scripts/codex_harness.py templates hash-check` passes when harness/spec files changed
- `python3 scripts/codex_harness.py templates canonical-check` passes when harness/spec/workflow files changed
- recovery notes are written only when explicitly requested or needed for cross-session transfer
- task status is marked `completed`
- task is archived if no further work remains
