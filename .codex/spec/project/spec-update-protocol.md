# Spec Update Protocol

Use specs for durable behavior, conventions, architecture boundaries,
operational rules, and bug-prevention lessons. Keep normal task flow light:
update specs only when a task creates or changes durable knowledge.

## Rules

- Update the smallest relevant spec or project document.
- Do not require a special PRD section or user-facing gate name for routine
  completion.
- If no durable lesson was created, state that no spec update was needed in
  the verification summary.
- Keep task-specific evidence in `prd.md`, `implement.jsonl`, `check.jsonl`,
  and focused research files rather than broad global notes.
