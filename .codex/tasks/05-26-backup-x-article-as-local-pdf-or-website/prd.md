# Backup X article as local PDF or website

## Goal

Create a faithful local backup of the X article at
`https://x.com/MaxForAI/article/2058910873947910558` after the user-approved
interactive login/handoff. Prefer a browser-rendered PDF and a self-contained
local website capture; if X reports the article is deleted or otherwise
unavailable after login, preserve evidence of that state instead.

## Acceptance Criteria

- [ ] Confirm whether the target article renders in an authenticated X session.
- [ ] Save a well-rendered PDF backup when the article content is accessible.
- [ ] Save a local website-style backup when feasible without losing visual structure.
- [ ] Save capture metadata with source URL, capture time, and availability status.
- [ ] Verify the resulting artifact(s) open locally and are not just the X login page.

## Notes

- User approved interactive X login/handoff on 2026-05-26.
## Decisions

- x-login-handoff: Use interactive X login/handoff, then capture PDF and local website if the article renders.
