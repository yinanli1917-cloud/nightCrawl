# Notification sync TDD rebuild

## Goal

Rebuild or stabilize the notification/sync path using a test-first loop so recurring failures are captured as regression tests instead of one-off fixes.

## Acceptance Criteria

- [ ] Identify the current notification/sync entry points and any existing failing or flaky behavior.
- [ ] Add focused regression coverage before changing behavior where feasible.
- [ ] Preserve existing browser/cookie/stealth assumptions documented by the NightCrawl skill.
- [ ] Verify with the local test command or a documented manual reproduction path.
- [ ] Record remaining risk and next debugging steps in the task notes or journal.

## Notes

Promoted from migrated Claude/NightCrawl workflow state. This is a durable backlog task, not an instruction to casually refactor the browser harness.
