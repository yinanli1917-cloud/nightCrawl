# GEB Documentation Protocol

GEB is the live L1-L3 documentation protocol migrated from the Claude harness. It is not Global/Environment/Backlog.

## L1 Project Docs

Use L1 for project constitution, architecture, tech stack, and conventions.

Update L1 when architecture, module boundaries, major workflows, or durable harness behavior changes.

## L2 Module Docs

Use L2 for module member lists, interfaces, and responsibilities.

Update L2 when files are added, removed, moved, or when module interfaces/responsibilities change.

## L3 File Headers

Use L3 for file-level role comments when the source format supports comments and the file participates in a module contract:

```text
[INPUT]: depends on upstream module or capability
[OUTPUT]: exports functions, types, artifacts, or behavior
[POS]: position/role inside the module
```

Update L3 when a file's dependencies, exports, or role changes.

## Completion Check

Before claiming completion for durable code or harness changes:

- decide whether the change affects L1, L2, or L3
- update the affected docs before `finish-work`
- if no GEB layer is affected, state that explicitly in the verification summary
