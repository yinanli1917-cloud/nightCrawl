# nightCrawl: lessons from Hermes Agent (NousResearch)

> Snapshot of Apple Note, last updated 2026-04-10

Three parallel subagents researched github.com/NousResearch/hermes-agent on 2026-04-09. Full reports in `naTure/research/hermes-agent/`.

## The single most important sentence

> **Hermes owns terminal + messaging. Claude Code owns coding. Nothing owns the browser-as-you. That's the wedge.**

## Four findings that change nightCrawl's roadmap

### 1. Hermes has zero passive observation. Cannot bolt it on cleanly.

Confirmed by all three subagents independently. Hermes's learning loop is entirely active and conversational. There is no daemon, no event ingestion process, no semantic diffing. The closest hook (`plugins/memory/`) would require three architectural pieces Hermes doesn't have. Hermes runs on a VPS — architecturally upstream of the user's actual machine. CANNOT see Arc cookies, tabs, or history.

**nightCrawl is at the one position in the stack where passive observation is natural.** It already runs locally, already imports real cookies, already drives a real browser. Sitting AS the browser is what makes the killer feature buildable.

This is the moat. Everything else is implementation detail.

### 2. Hermes confirms what's table stakes for an agent product in 2026

Reading Hermes's feature list as a checklist: nightCrawl ships ~3 of ~15 capabilities a serious agent CLI is expected to ship.

**Missing from nightCrawl that Hermes has:**
- Interactive TUI with streaming + slash autocomplete + interrupt
- `nightcrawl --continue` session resume
- One-line install script
- Cron via natural language
- MCP server interface
- `nightcrawl insights` (FTS5 session search + report)
- Approval modes (manual/smart/off)
- Per-user profiles via env var
- Skill system with hub
- Central `COMMAND_REGISTRY`

**The killer feature doesn't matter if the basic UX isn't there.** Nobody installs a tool to observe their browsing if the tool doesn't even have a TUI.

### 3. Hermes has solved patterns nightCrawl will need verbatim

**(a) Memory as fenced injection, not persisted message.** When recalled memory enters the prompt: `[System note: ... NOT new user input]` — strip fence-escape sequences + never persist to history. Two wins: prompt-injection defense + doesn't break prompt caching. **NON-NEGOTIABLE** for passive observation — visited pages WILL try to prompt-inject.

**(b) Frozen-snapshot prompt + live tool responses.** Memory writes hit disk immediately but don't re-render into system prompt until next session. "Do NOT alter past context mid-conversation" is a documented project policy. Difference between $0.05 and $0.50 per session for daemon-grade workloads.

**(c) Subagent delegation with hard blocklist.** `delegate_task` spawns isolated children with no recursive delegation, no memory writes, no send_message, no code_execution. `MAX_CONCURRENT_CHILDREN=3`, `MAX_DEPTH=2`. Right shape for "propose 5 automations in parallel from a week of observation."

**(d) Central `COMMAND_REGISTRY`.** One CommandDef list feeds CLI dispatch, gateway dispatch, Telegram menu, Slack subcommand map, autocomplete, help. Adding a slash command is one line. **Build BEFORE drift sets in.**

**(e) Progressive disclosure for skills.** Level 0 = 3k-token JSON index. Level 1 = full skill on demand. Level 2 = reference file on demand. nightCrawl will accumulate recipes; loading them all is fatal.

**(f) Cron jobs cannot create cron jobs.** Hardcoded rule. Prevents runaway-loop on the user's bank at 3am. **Load-bearing.**

**(g) Profiles via env var set before imports.** `HERMES_HOME` set in `_apply_profile_override()` before any module import. All 119+ `get_hermes_home()` call sites scope automatically. Maps directly to nightCrawl's existing `identities/`.

### 4. Hermes is a complement, not a competitor. Build the bridge.

Both products are strictly better in their lane.
- Hermes will never import Arc cookies, run 48 C++ patches, or watch your browser
- nightCrawl will never be a 15-platform messaging gateway

**The integration hook is ALREADY THERE.** Hermes's skill system has `garrytan/gstack` listed as a default tap. nightCrawl was born from gstack. The path:

1. Ship `nightcrawl/skills/browser-twin` as installable Hermes skill on day one of v1.0
2. Skill registers nightCrawl's MCP endpoint
3. nightCrawl exposes intent-level API as MCP tools
4. Hermes users get "hands"
5. nightCrawl users get "brain"

**DON'T build a messaging gateway. DON'T build a general agent. SHIP THE BRIDGE.**

## What NOT to copy from Hermes

- Monolithic `run_agent.py` (487 KB) and `cli.py` (400 KB) — violates nightCrawl's 800-line rule by 10x. Hermes can absorb it (3000+ tests, paid team); nightCrawl can't.
- The messaging gateway — Hermes's lane
- 40+ general-purpose tools — nightCrawl is browser-native
- Multi-LLM provider routing — v1.5 problem

## Open questions before next session

1. MCP-bridge framing correct, or build self-contained?
2. Table-stakes-first (safe) vs killer-feature-early (risky)?
3. Arc-specific (read history DB, fragile) vs Chrome-generic (extension)?

## Recommended next-session shape

1. ~~(this session) Hermes deep dive — DONE~~
2. **NEXT: PRD rewrite.** Three sections — Table Stakes, The Wedge, The Bridge. NO code.
3. **Then: Architecture spec.** Map items to file structure. Flag 800-line risks.
4. **Then: Implementation.** Table stakes first, moats next, killer feature last (depends on everything else).
