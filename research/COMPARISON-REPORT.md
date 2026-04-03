# COMPARISON REPORT — Blind Reconstruction vs. Real System

**Reconstruction:** iteration-10 (from public corpus, 55+ files)
**Real System:** gstack v0.14.0.0 (commit `8151fcd5`)
**Date:** 2026-03-30
**Verification Score:** 19/22 (86.4% confirmed+partial)

## Executive Summary

The blind reconstruction is remarkably accurate at the architectural level. From public corpus alone — blog posts, YouTube transcripts, podcast notes, X posts — the synthesis correctly predicted that Garry Tan would build a Claude Code-centric developer workflow system organized around modular, reusable skill definitions (SKILL.md files), with a headless browser integration, evaluation frameworks, craft quality constraints, and explicit references to "taste" as a system value. These are not generic predictions — they are structurally specific, and the real system confirms them with surprising precision.

Where the reconstruction fails is in scope and sophistication. It imagined a personal developer harness — a coding environment for one builder. The real system is an open-source engineering team simulator with 29+ skills, a compiled Bun binary for browser automation, a Chrome extension with a sidebar AI agent, CI/CD infrastructure, multi-host support (Claude Code, OpenAI Codex, Gemini CLI, Factory Droid), telemetry, a GPT Image API-powered design CLI, and a community website design system. The reconstruction correctly identified the building blocks but dramatically underestimated how far Tan would take them. It predicted a campfire; the real system is a forge.

The negative predictions are almost perfect — 7/7 correct. No life dashboard, no calendar automation, no crypto tooling, no social media posting, no meditation tracking, no investor CRM, no academic paper processing. This validates the reconstruction's core model of Tan's priorities: he builds tools for building, not tools for managing. The method's strength is in predicting what someone would NOT build, which requires deep understanding of their values hierarchy.

## Convergences (Confirmed Predictions)

### Prediction 1: CLAUDE.md Configuration Files as the System's Skeleton — CONFIRMED

**Predicted:** "The system's primary artifact is one or more CLAUDE.md files that configure Claude Code's behavior."

**Reality:** CLAUDE.md is the 390-line spine of the entire project. It defines project structure, skill workflow, commit conventions, CHANGELOG rules, platform-agnostic design principles, community PR guardrails, and even effort compression tables. Every skill's preamble reads project-level CLAUDE.md files for context. The system also has ETHOS.md (builder philosophy injected into every skill), ARCHITECTURE.md, and CONTRIBUTING.md.

**Why the corpus contained enough signal:** Tan's "meta prompting" description — "you can take almost anything that you might do all the time and you just drop it into a context window" — directly maps to CLAUDE.md's function. The reconstruction correctly identified this as codified persistent configuration, not ad-hoc prompting.

### Prediction 2: Evaluation Frameworks (Evals) as a Core Component — CONFIRMED

**Predicted:** "The system contains codified evaluation criteria — prompts or scripts that assess output quality."

**Reality:** gstack has a three-tier eval system:
- Tier 1: Static skill validation (`skill-validation.test.ts`) — free, <1s
- Tier 2: E2E tests via `claude -p` (`skill-e2e-*.test.ts`) — ~$3.85/run
- Tier 3: LLM-as-judge quality evals (`skill-llm-eval.test.ts`) — ~$0.15/run

The system includes diff-based test selection (`touchfiles.ts`), eval persistence to `~/.gstack-dev/evals/`, auto-comparison between runs, and a two-tier gate/periodic classification for CI. The `eval:select`, `eval:compare`, and `eval:summary` scripts provide full eval lifecycle management.

**Why the corpus contained enough signal:** Tan's explicit statement "Prompt (agency) and evals (taste) will rule everything around us" combined with "Claude seems to be the best at evaluating the outputs" directly predicted LLM-as-judge evaluation. The reconstruction nailed both the concept AND the architectural separation of generation from evaluation.

### Prediction 3: Task Decomposition as Codified Practice — CONFIRMED

**Predicted:** "The system encodes a pattern of breaking complex tasks into small sequential steps."

**Reality:** Every skill template is a multi-phase sequential workflow. The `/office-hours` skill has Phase 1 (Context Gathering), Phase 2A/2B (Startup/Builder diagnostic), Phase 3 (Premise Challenge), Phase 4 (Alternatives), Phase 5 (Design Doc). The `/plan-ceo-review` has a 10-section review process. The `/review` skill has sequential steps with explicit gates between them. Skills feed into each other: `/office-hours` writes a design doc that `/plan-ceo-review` reads.

**Why the corpus contained enough signal:** The Heller-derived decomposition pattern and the "assign role, provide clear instructions, specify output format" recipe from the Knowledge Project mapped directly to how skills are structured.

### Prediction 6: "Skills" or Reusable Prompt Modules — CONFIRMED

**Predicted:** "The system organizes recurring workflows into modular, reusable prompt definitions — named, versioned, and invocable."

**Reality:** gstack has 29+ named skills, each with versioned SKILL.md.tmpl templates, generated SKILL.md output, YAML frontmatter (name, version, description, allowed-tools), and a template composition system (`scripts/resolvers/`) that injects shared preambles, browse setup, and design review components. Skills are invocable as `/slash-commands`. The system includes `skill:check` (health dashboard), `dev:skill` (watch mode), and a full SKILL.md generation pipeline.

**Why the corpus contained enough signal:** Tan's "meta prompting" terminology and his six-skills taxonomy instinct directly predicted modular skill organization. The reconstruction was right about the concept but underestimated the engineering sophistication — versioned templates, a build pipeline, and a resolver system.

### Prediction 7: Craft Quality Constraints in Code Generation — CONFIRMED

**Predicted:** "Configuration files specify aesthetic and quality standards for generated code."

**Reality:** The ETHOS.md file codifies three builder principles injected into every skill's preamble: "Boil the Lake" (completeness is cheap with AI), "Search Before Building" (three layers of knowledge), and "User Sovereignty" (AI recommends, users decide). The CLAUDE.md has explicit quality directives: "Completeness is cheap. Don't recommend shortcuts when the complete implementation is a 'lake' (achievable)." The `/plan-ceo-review` has "Engineering Preferences" including "DRY is important," "well-tested code is non-negotiable," "bias toward explicit over clever," and "minimal diff."

**Why the corpus contained enough signal:** Tan's "sanded down" language and his designer-engineer dual identity correctly predicted that quality would be encoded as system constraints, not just aspirational principles.

### Prediction 8: Headless Browser Integration — CONFIRMED

**Predicted:** "The system includes a headless browser tool that lets Claude Code interact with web pages."

**Reality:** The browse tool is the most engineered component of gstack — a persistent Chromium daemon with sub-second latency (~100-200ms per command after first call), 60+ commands (goto, click, fill, snapshot, responsive, screenshot, pdf, diff, etc.), cookie import from real browsers, CDP-based anti-bot bypass patches, a Chrome extension side panel with a sidebar AI agent, headed mode (`$B connect`), handoff for CAPTCHA/auth (`$B handoff`/`$B resume`), and untrusted content sanitization. It's a compiled Bun binary (~58MB) with its own HTTP server, bearer token auth, and version auto-restart.

**Why the corpus contained enough signal:** Tan's X post asking "Is there any way I can connect Claude Code to use my browser and iOS simulator?" was the direct signal. The reconstruction correctly identified this as a capability he would build. It did not predict the scale — a full browser automation platform, not just a QA helper.

### Prediction 13: "Agency + Taste" as Explicit System Values — CONFIRMED

**Predicted:** "The system's configuration explicitly names 'agency' and 'taste' as the two human capabilities it must amplify."

**Reality:** "Taste" appears 30+ times across the system. The ETHOS.md states: "The engineering barrier is gone. What remains is taste, judgment, and the willingness to do the complete thing." The preamble injected into every skill says: "The user always has context you don't — domain knowledge, business relationships, strategic timing, taste." The `/office-hours` skill's closing message references "taste, ambition, agency" as the traits YC looks for. The `/plan-ceo-review` has a "Taste Calibration" section. The `/design-shotgun` has "taste memory."

**Why the corpus contained enough signal:** Tan's repeated "agency + taste" formula across 5+ public appearances was correctly identified as a system-level value, not just a talking point.

### Prediction 14: Multiple Concurrent Projects (Worktree Pattern) — CONFIRMED

**Predicted:** "The system supports running multiple independent Claude Code projects simultaneously."

**Reality:** gstack explicitly supports 10-15 parallel sprints via Conductor. The system has `lib/worktree.ts` for workspace isolation, session tracking (`~/.gstack/sessions/`), random port selection (10000-60000) for multi-workspace browse daemons, per-project config (`~/.gstack/projects/`), and the README explicitly describes: "I regularly run 10-15 parallel sprints." The architecture is designed around concurrent isolated workspaces.

**Why the corpus contained enough signal:** Tan's "three different projects going right now" statement and his "10 people working for you" framing correctly predicted the need for concurrency infrastructure. The reconstruction underestimated the scale (predicted 3 concurrent; reality is 10-15).

### Prediction 15: Anti-Blitzscaling Team Structure — CONFIRMED

**Predicted:** "The system is designed for a 1-person or very small team — no multi-user permissions."

**Reality:** gstack is a single-user tool. There are no team permissions, no access control, no multi-tenant features. The entire system assumes one builder with multiple AI agents. The README positions it for "Founders and CEOs — especially technical ones who still want to ship." The ETHOS.md celebrates "A single person with AI can now build what used to take a team of twenty."

**Why the corpus contained enough signal:** Tan's solo-builder-with-agents philosophy was correctly distinguished from a team infrastructure tool.

## Partial Matches

### Prediction 4: Zero-Bug-Before-New-Feature Discipline — PARTIAL

**Predicted:** "The system enforces a rule that bugs must be fixed before new feature work proceeds."

**Reality:** There is no explicit "zero bugs before new features" rule in CLAUDE.md or ETHOS.md. However, the system encodes a rigorous debugging discipline: `/investigate` enforces "Iron Law: no fixes without investigation," the `/qa` skill auto-generates regression tests for every bug fix, and the `/review` skill catches bugs before shipping. The E2E eval failure blame protocol in CLAUDE.md says "never claim 'not related to our changes' without proving it." The spirit of the Carmack discipline is present, but it's encoded as process rigor rather than an explicit priority rule.

**What's missing:** A literal instruction saying "fix all bugs before starting new features." The system's approach is more nuanced — it enforces that bugs are fixed properly (with investigation, tests, and verification) rather than mandating sequencing.

### Prediction 9: Anti-Corporatism Coding Norms — PARTIAL

**Predicted:** "The system explicitly prohibits corporate-style code patterns."

**Reality:** The CLAUDE.md has extensive "NEVER" rules (12+ instances), but they target development workflow anti-patterns (never commit binaries, never resolve SKILL.md conflicts manually, never skip evals) rather than corporate code patterns. The ETHOS.md's "Anti-patterns" sections target engineering mistakes ("Ship the shortcut" is legacy thinking, "Accepting blog posts uncritically"). The `/plan-ceo-review` lists "Engineering Preferences" including "minimal diff" and "bias toward explicit over clever." The community PR guardrails protect against corporate sanitization: "PRs that rewrite voice to be more 'neutral' or 'professional' must be rejected."

**What's missing:** Explicit "NEVER use unnecessary abstraction" or "no enterprise patterns" rules. The anti-corporate instinct manifests as voice protection and workflow simplicity rather than code-level prohibitions.

### Prediction 11: Vertical AI / Startup Evaluation Framework — PARTIAL

**Predicted:** "The system contains a structured framework for evaluating startup ideas."

**Reality:** The `/office-hours` skill in Startup Mode has six forcing questions that form a structured evaluation framework: Demand Reality, Status Quo, Desperate Specificity, Narrowest Wedge, Observation & Surprise, and Future-Fit. Smart routing adjusts questions based on product stage (pre-product, has users, has paying customers). This IS a startup evaluation framework — but it evaluates product-market fit for individual founders, not Tan's personal "Why Now?" deal-flow filter. The `/plan-ceo-review` adds CEO-level cognitive patterns (Bezos one-way/two-way doors, Grove's paranoid scanning, Munger's inversion).

**What's missing:** The specific "Why Now?" framework and severity-x-reach matrix that the reconstruction predicted as personal evaluation tools. Instead, the system encodes Tan's evaluation philosophy as advice for OTHER founders, not as his own deal-flow pipeline.

### Prediction 10: Founder Psychology Content — PARTIAL

**Predicted:** "The system references psychological frameworks (Jung, Girard, ACE) in prompts or content templates."

**Reality:** The `/office-hours` skill's closing recommendations include Tan's YouTube video "Unconventional Advice for Founders" which "covers everything a pre-launch founder needs: get therapy before your psychology kills your company." The system references psychological concepts indirectly — the `/office-hours` anti-sycophancy rules encode a specific psychological posture ("Comfort means you haven't pushed hard enough"). The `/plan-ceo-review` has "Cognitive Patterns — How Great CEOs Think" which encodes psychological frameworks from Bezos, Grove, Munger, Horowitz, and Graham.

**What's missing:** Direct references to Jung, Girard, mimetic desire, or ACE. The psychological content is encoded as behavioral instructions (how to push founders, how to think like a CEO) rather than named frameworks.

## Divergences (Refuted Predictions)

### Prediction 5: YouTube Script Generation Pipeline — REFUTED

**Predicted:** "The system contains prompts or automation for generating YouTube video scripts."

**Reality:** gstack contains zero YouTube script generation features. No content creation pipeline. No video script templates. The YouTube references in the system are links to Tan's existing videos (recommended in `/office-hours` closing), not generation tools. The system is entirely a software engineering workflow tool.

**Why the reconstruction missed:** The corpus showed Tan describing his YouTube script workflow explicitly ("Fed scripts from top-performing YouTube videos into Gemini. Extracted common structural patterns"). This was real — but it turned out to be a workflow he does MANUALLY or in separate tooling, not something he encoded into gstack. The reconstruction correctly identified the behavior but incorrectly assumed it would be part of the same system.

**Method limitation:** Public descriptions of "I use AI for X" do not guarantee that X is part of the primary system. Tan uses AI for many things; gstack is specifically his engineering workflow tool.

### Prediction 12: X/Twitter Bookmark Monitoring — REFUTED

**Predicted:** "The system includes automated monitoring of X bookmarks for tech intelligence gathering."

**Reality:** gstack has zero X/Twitter integration. No bookmark monitoring, no social media scraping, no intelligence gathering. The browse tool can navigate to X.com (it can navigate anywhere), but there are no X-specific skills or automation.

**Why the reconstruction missed:** The reconstruction projected the user's (yinanli's) naTure project onto Tan's system. The X bookmark monitoring exists in the user's own naTure project, not in gstack. Tan's X engagement is real but is not codified as a tool. This is a projection error — the reconstruction saw Tan's heavy X presence and assumed tool-building behavior, but Tan's X usage is human-direct, not automated.

**Method limitation:** Heavy usage of a platform does not imply building automation for it. The reconstruction overcorrected by applying a builder identity to all behaviors, when Tan selectively chooses what to automate.

## Surprises

These are features in the real system that the blind reconstruction did not predict at all. They represent the method's true blind spots.

### 1. Open Source Product with Community Infrastructure

The reconstruction predicted a personal developer harness. The real system is an MIT-licensed open source project with:
- GitHub CI workflows (evals.yml, skill-docs.yml, actionlint.yml)
- Docker image for CI (pre-baked toolchain + Playwright/Chromium)
- Community PR guardrails protecting voice and ETHOS.md
- CONTRIBUTING.md with detailed contributor setup
- Community dashboard (`gstack-community-dashboard`)
- Telemetry (opt-in, Supabase-backed)
- CHANGELOG written as user-facing release notes
- Hiring ad ("We're hiring. Want to ship 10K+ LOC/day?")

**Blind spot:** The corpus showed Tan as a solo builder. The reconstruction did not predict he would package his personal tooling as an open source community product. This is a classic "what you do with what you build" gap — public output reveals what someone builds, but not how they distribute it.

### 2. Multi-Host Support (Codex, Gemini, Factory Droid)

gstack works across Claude Code, OpenAI Codex CLI, Gemini CLI, and Factory Droid. The `setup` script auto-detects installed agents. SKILL.md templates have host-specific resolvers. Codex E2E tests run alongside Claude E2E tests. The system is agent-agnostic despite being built primarily for Claude Code.

**Blind spot:** The corpus showed Tan deeply committed to Claude Code specifically. The reconstruction assumed Claude Code exclusivity. The real system treats agent support as a platform decision — Claude is primary, but the system is designed to be portable.

### 3. Design CLI (GPT Image API)

A complete design generation tool (`design/src/`) with commands for generate, variants, compare, iterate, evolve, gallery, serve, and design-to-code. Uses the GPT Image API (OpenAI). Has session state, design memory (`memory.ts`), design language extraction, and mockup diffing. This is a second compiled binary alongside the browse binary.

**Blind spot:** While the reconstruction predicted "craft quality constraints," it did not anticipate a dedicated AI-powered design generation tool. Tan's designer-engineer identity was correctly identified but its expression as a GPT Image API pipeline was unpredictable from public output.

### 4. Chrome Extension with Side Panel and Sidebar Agent

A Chrome extension (`extension/`) with a side panel showing a live activity feed, a chat sidebar where users can direct Claude in natural language, and visual indicators (green shimmer) showing which Chrome window gstack controls. The sidebar agent runs isolated Claude instances for browser tasks.

**Blind spot:** No public signal predicted this level of browser UI integration. The browse tool was predicted; a Chrome extension co-presence model was not.

### 5. Sprint Process as System Architecture

The reconstruction predicted skills. The real system is organized as a complete sprint: Think → Plan → Build → Review → Test → Ship → Reflect. Skills feed into each other deterministically. The `/autoplan` skill chains CEO → design → eng review automatically. The `/ship` skill auto-invokes `/document-release`. The `/retro` runs cross-project analysis. This is process engineering, not just tool collection.

**Blind spot:** The reconstruction predicted modular skills but not the directed acyclic graph of skill dependencies that forms a complete engineering process.

### 6. Safety Skills (careful, freeze, guard)

Defensive guardrails that warn before destructive commands (rm -rf, DROP TABLE, force-push), lock edits to specific directories, and auto-freeze during investigations. These are invoked by saying "be careful" in natural language.

**Blind spot:** No public signal predicted defensive safety tooling. This is a practitioner-level concern that emerges from actual experience with AI agents accidentally destroying things.

### 7. Learnings System (Persistent Cross-Session Knowledge)

`gstack-learnings-log`, `gstack-learnings-search`, per-project `learnings.jsonl`, and a `/learn` skill for managing what the system has learned across sessions. Skills automatically capture patterns, pitfalls, and insights.

**Blind spot:** The Posthaven/preservationist instinct was identified in the reconstruction's Peripheral Corpus Items (P3) but not promoted to a prediction. It should have been — the reconstruction correctly saw the signal but rated it too peripheral.

### 8. Proactive Skill Suggestions

gstack notices what stage the user is in and suggests appropriate skills. Controlled by `gstack-config set proactive true/false`. The routing table in the main SKILL.md maps user patterns to skill invocations.

**Blind spot:** This is emergent UX design — predicting not just what tools exist but how they surface themselves. Unpredictable from public output.

## Negative Predictions Assessment

### N1: NO Life Dashboard or Personal Knowledge Management — CORRECT

gstack has no Notion-like knowledge base, no journaling, no second brain. The learnings system (`learnings.jsonl`) is project-scoped technical knowledge, not personal information management. The reconstruction correctly identified that Tan's intellectual life is externalized (blog, YouTube, X) and not captured in a private PKM system.

### N2: NO Calendar/Email Automation — CORRECT

Zero calendar, email, or scheduling features. gstack is purely for software engineering workflows. The reconstruction correctly identified that Tan's solution to email overload was human delegation, not tool automation.

### N3: NO Crypto/Web3 Infrastructure — CORRECT

No blockchain, crypto, or Web3 anything. Despite funding Coinbase. The reconstruction correctly separated Tan's investment thesis from his building behavior.

### N4: NO Social Media Posting Automation — CORRECT

No auto-posting, no scheduling, no content distribution. The reconstruction correctly identified that Tan's social media presence is intensely personal and real-time, making automation antithetical to his values.

### N5: NO Meditation/Wellness Tracking — CORRECT

No wellness features of any kind. The reconstruction correctly applied the "uses as consumer vs. builds as engineer" filter.

### N6: NO Investor CRM or Deal Pipeline — CORRECT

No CRM, no deal tracking. The `/office-hours` skill gives startup advice to OTHER founders — it does not track Tan's own investments. The reconstruction correctly separated Tan's professional institutional tools (YC's Bookface, application review) from his personal building system.

### N7: NO Academic/Research Paper Processing — CORRECT

No arXiv, no paper processing. The reconstruction correctly identified Tan as a practitioner, not a researcher. His intellectual inputs are practitioners' content (PG essays, podcasts, X posts), not academic papers.

## Method Insights

### What Blind Reconstruction Can See

1. **Architectural patterns** — The prediction that the system would be Claude Code-centric, CLAUDE.md-configured, skills-based, eval-driven, and browser-integrated was correct across every dimension. Public output reveals how someone thinks about building, and that thinking maps directly to system architecture.

2. **Value hierarchies** — The 7/7 negative prediction accuracy proves that public output reliably reveals what someone does NOT care about automating. Tan's complete silence on PKM, calendar, crypto, and wellness in a building context correctly predicted their absence.

3. **Philosophy-to-code mapping** — "Taste" as a system value, quality constraints in code generation, task decomposition patterns — these philosophical stances map to specific code artifacts with high fidelity.

### What Blind Reconstruction Cannot See

1. **Distribution decisions** — Will the builder keep it personal or open source it? The corpus showed a solo builder; the system is a community product. Distribution strategy is invisible in public intellectual output.

2. **Engineering sophistication** — The reconstruction predicted "a browser tool." The reality is a compiled Bun binary with a persistent daemon, CDP, bearer token auth, anti-bot patches, a Chrome extension, and a sidebar agent. The concept was predictable; the engineering depth was not.

3. **Emergent features** — Safety skills, proactive suggestions, learnings persistence, multi-host support — these emerge from practitioner experience, not from public philosophy. They are solutions to problems you only discover by using the system extensively.

4. **Scope escalation** — The reconstruction predicted a personal harness with ~15 capabilities. The real system has 29+ skills, two compiled binaries, a Chrome extension, CI infrastructure, and community tooling. Public output shows intensity of usage but not rate of feature accumulation.

### What Would Improve the Method

1. **Distribution heuristic** — Tan's public emphasis on "sharing" (Posthaven, blog posts, YouTube, open source YC) should have been weighted as a signal for open-sourcing personal tools.

2. **Practitioner-problem prediction** — A catalog of "problems that every power user of AI coding tools eventually encounters" (agents destroying files, context isolation, stale skills) could predict emergent safety and management features.

3. **Scope multiplier** — When someone demonstrates 4am-level obsession, multiply predicted scope by 3-5x. The reconstruction's 15 predictions should have been 40.

4. **Peripheral promotion** — The Posthaven/preservationist instinct (P3) correctly anticipated the learnings system but was not promoted to a prediction. Peripheral signals that align with core identity should be promoted.

## Side-by-Side Table

| # | Prediction | Reality | Result | Analysis |
|---|-----------|---------|--------|----------|
| 1 | CLAUDE.md as system skeleton | 390-line CLAUDE.md + ETHOS.md + ARCHITECTURE.md configure entire system | **CONFIRMED** | Strongest hit. "Meta prompting" directly maps to CLAUDE.md's function. |
| 2 | Evaluation frameworks (evals) | Three-tier eval system: static validation, E2E via `claude -p`, LLM-as-judge | **CONFIRMED** | "Evals are the moat" predicted both concept and architecture. |
| 3 | Task decomposition codified | Every skill is a multi-phase sequential workflow with explicit gates | **CONFIRMED** | Heller-derived pattern mapped directly to skill structure. |
| 4 | Zero-bug-before-new-feature | Rigorous debugging discipline and regression tests, but no explicit sequencing rule | **PARTIAL** | Spirit is present; letter is absent. Encoded as process rigor, not priority rule. |
| 5 | YouTube script generation | Zero content creation features; gstack is purely engineering workflow | **REFUTED** | "I use AI for X" does not mean X is in this system. Separate workflow. |
| 6 | Reusable prompt modules (skills) | 29+ named, versioned skills with template composition system | **CONFIRMED** | "Meta prompting" + taxonomy instinct correctly predicted modular skills. |
| 7 | Craft quality constraints | ETHOS.md "Boil the Lake" + engineering preferences in every review skill | **CONFIRMED** | "Sanded down" language correctly predicted encoded quality standards. |
| 8 | Headless browser integration | Full browser automation platform: persistent daemon, 60+ commands, Chrome extension | **CONFIRMED** | Direct X post signal. Scale dramatically exceeded prediction. |
| 9 | Anti-corporatism coding norms | Voice protection guardrails, workflow simplicity, but not code-level anti-patterns | **PARTIAL** | Anti-corporate instinct manifests as voice/process, not code prohibitions. |
| 10 | Founder psychology content | CEO cognitive patterns, anti-sycophancy rules, "get therapy" advice in /office-hours | **PARTIAL** | Psychological frameworks encoded as behavioral instructions, not named theories. |
| 11 | Startup evaluation framework | /office-hours has 6 forcing questions; /plan-ceo-review has CEO cognitive patterns | **PARTIAL** | Framework exists but for advising other founders, not personal deal-flow. |
| 12 | X/Twitter bookmark monitoring | Zero X integration; no social media tooling | **REFUTED** | Projection error — heavy platform usage ≠ building automation for it. |
| 13 | "Agency + taste" as values | "Taste" appears 30+ times; embedded in ETHOS.md and every skill preamble | **CONFIRMED** | Most repeated public formula correctly predicted as system-level value. |
| 14 | Multiple concurrent projects | 10-15 parallel sprints, worktree support, Conductor integration, session isolation | **CONFIRMED** | "Three projects" understated; reality is 10-15x parallelism. |
| 15 | Anti-blitzscaling team structure | Single-user tool, no team permissions, "one builder with AI agents" philosophy | **CONFIRMED** | Solo-builder-with-agents model confirmed exactly. |
| N1 | NO life dashboard/PKM | Correct — no PKM, no journaling, no second brain | **CORRECT** | Externalized intellectual life correctly predicted absence. |
| N2 | NO calendar/email automation | Correct — zero scheduling or email features | **CORRECT** | Human-delegation solution correctly predicted non-automation. |
| N3 | NO crypto/Web3 | Correct — no blockchain anything | **CORRECT** | Investment thesis ≠ building behavior, correctly separated. |
| N4 | NO social media auto-posting | Correct — no posting automation | **CORRECT** | Personal + real-time X presence correctly predicted non-automation. |
| N5 | NO meditation/wellness | Correct — no wellness features | **CORRECT** | Consumer vs. builder filter correctly applied. |
| N6 | NO investor CRM | Correct — advises founders, doesn't track investments | **CORRECT** | Professional tools vs. personal system correctly distinguished. |
| N7 | NO academic paper processing | Correct — no arXiv or paper tooling | **CORRECT** | Practitioner vs. researcher identity correctly identified. |

**Summary:** 9 confirmed, 4 partial, 2 refuted out of 15 positive predictions. 7/7 negative predictions correct. Total: 20/22 claims validated (confirmed + partial + correct negatives), yielding a **90.9% accuracy rate**. The two refuted predictions (YouTube scripts, X bookmarks) share a common failure mode: assuming that a described AI workflow would be part of the primary system rather than a separate practice.
