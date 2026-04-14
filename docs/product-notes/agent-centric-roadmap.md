# nightCrawl: agent-centric roadmap

> Snapshot of Apple Note, last updated 2026-04-09

The reframing: nightCrawl is NOT a hardened scraper. It's the user's digital twin in the browser — acts as you, with your authority, on your machine, with human-in-the-loop checkpoints when judgment is needed.

Stealth, cookie import, auto-update, hostile-domain blocklist = **INFRASTRUCTURE**. Not features. The features are about what the agent can do on your behalf.

## What's done (infrastructure layer — Sessions 1-5)

- Real cookie import (Arc, Chrome, Firefox, Safari)
- CloakBrowser stealth engine + CDP patches
- Persistent daemon, headless ↔ headed handover
- Scoped token system (per-agent permissions, domain restrictions)
- Auto-handover on login walls
- Self-verifying auto-updater + 6h reinforcement loop (Session 5)
- Hardcoded hostile-domain blocklist enforced in code (Session 5, after 2026-04-09 XHS account ban incident)

## Queued tactical items from Session 5 HANDOFF

- E2E test of auto-updater against real `bun add` / `playwright install`
- Reinforcement loop fire-test with shortened interval
- Investigate pre-existing handoff edge cases flake
- Bump CloakBrowser to 0.3.22

## Queued from earlier sessions (PRD-level, never started)

- TLS/JA3 fingerprint masking
- Behavioral humanization beyond CloakBrowser defaults
- Proactive workflow detection (mentioned in PRD competitive table, zero code exists)

## The agent-centric gaps that aren't on the list yet — THE MOAT

These are the things no competitor has and that turn nightCrawl from scraper into digital twin.

### 1. Intent-level API for agents

Right now agents send goto / click / fill — they have to model the page. Product should let an agent say "log into my Cathay account and download this month's statements" and have nightCrawl decompose that. This is the difference between giving an agent a keyboard and giving an agent a butler.

### 2. Memory of the user's habits

A digital twin should know that you check your bank on the 1st, that you have three Gmail accounts and the personal one is for newsletters, that you never click promotional emails. Persistent, local, per-user behavioral context. NO cloud agent can match this — that's the moat.

### 3. Human-in-the-loop checkpoints by INTENT, not by event

Auto-handover currently fires on login walls (event). The right model is "before you transfer money, before you delete anything, before you reply to a real person — ping me." Policy layer above the browser.

### 4. Trust scopes by domain + action

Token system has read/write/admin/meta scopes per-agent but not per-action-per-domain. "This agent can read my Gmail but only reply to threads where I've already replied" is the kind of granular trust a digital twin needs.

### 5. Activity replay / audit log as a first-class artifact

What did the agent do as me yesterday? Today? With what cookies? Can I review and undo? An audit log file exists somewhere but is not a product surface. Should be a CLI command + UI.

### 6. Passive observation mode (the "watch me work" feature)

The most powerful version of "your digital twin" learns from watching you actually use Arc/Chrome and proposes automations. Ship a passive mode that runs alongside Arc for a week and surfaces "you do X every Tuesday — want me to do it for you?" This is the proactive workflow detection line in the PRD that's never been built. Probably the single most differentiating feature on this entire list.

## Recommended next-session shape

1. NOT engineering. Product redefinition.
2. Use deep-research skill to investigate the agent-centric browser space — who else is trying to build a digital twin (not a scraper, not a CUA framework), what their actual UX is for the user, what makes nightCrawl irreplaceable.
3. Output: NOT code. A new PRD section: "Agent-Centric Surface v1.0"
4. Then a third session takes the new PRD + the existing infrastructure and starts implementation.

The temptation will be to skip steps 1-2 and start coding. Resist it — one wrong implementation week costs more than two right research days.
