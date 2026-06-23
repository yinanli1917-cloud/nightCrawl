# Plan COMMLD 515 agent prototype integration

## Goal

Plan the Week 9 COMMLD 515 "LLM Prompter Prototype" submission for Lumi as a scenario-based prompt/persona verifier inside the instructor-provided Agent Behavior Maker workflow, not a full end-to-end Lumi UI build. In parallel, define a budget-friendly Gemini strategy for next week's full Lumi UI prototype.

## Acceptance Criteria

- [ ] Primary deliverable is a reliable screen-recorded prompt-refiner flow for the Canvas assignment.
- [ ] Prototype demonstrates one happy path and one failure/edge case using Lumi's existing agent persona.
- [ ] This week's recording happens in Agent Behavior Maker: product proposal + user persona + agent framework -> generated scenarios -> conversation playground -> behavior controls/export.
- [ ] Gemini app output may be used upstream to discover YouTube videos, extract time-coded cooking steps, and stage realistic source material.
- [ ] Gemini API is optional behind a "live" toggle; recorded submission must not depend on live API success, quota, Wi-Fi, or account state.
- [ ] Do not embed the Gemini app as the main product UI; Lumi should remain the visible product surface.
- [ ] Scope stays limited to this week's LLM prompt-refiner assignment, not the full final Lumi prototype.
- [ ] Next week's UI plan uses Gemini 3.5 Flash API for live mode, with Gemini app / AI Studio for preparation and cached fallback for reliability.
- [ ] Next week's Gemini integration renders model output as structured Lumi-native UI blocks, not raw markdown or copied Gemini-app chat.
- [ ] Full UI plan maps Gemini-backed data to existing Lumi screens: recommendations, recipe detail, setup checklist, active voice QA, deviation modals, wait drills, post-bake review, memory, library, and arc planning.

## Notes

- Decision: reliable recording first; live Gemini toggle second.
- Decision: this week's assignment is the instructor tool's scenario verifier, not the full product prototype.
- Decision: Gemini app is currently stronger than API output for YouTube/video discovery and "eyes" style process extraction, based on user screenshots comparing API vs app.
- Nightcrawl validation of https://agentmaker.perfectpixels.com/ confirms the workflow: three text inputs, Generate Scenarios, suggested scenarios, conversation playground, tone/behavior controls, and Export Framework.
- Budget constraint: user has roughly $20 remaining for API usage, so live calls should be minimized and cache/stage successful outputs.
- Recommended architecture for this week: Lumi materials -> Agent Behavior Maker -> generated scenarios/conversations -> tune controls -> export framework -> submit recording.
- Recommended architecture for next week: Lumi UI -> local proxy/API route -> Gemini 3.5 Flash for live mode -> cached JSON fallback for recording/final presentation resilience.
- Rendering decision: Gemini returns constrained structured data, Lumi renders it through its own visual language. Candidate schema objects include RecipeCandidate, VideoStepTimeline, Citation, ConfidenceSignal, DeviationPlan, PracticeDrill, MemoryDelta, RealismScore, and ArcPlan.
- Existing prototype reviewed: `assignments/w6_wireframes/Group 3 Week6  Wireframe.html` contains 25 iPad screens across onboarding, home, memory, recommendations, recipe detail, setup, active cook, wait window, review, session saved, deviations, joint timeline, occasion planning, arc planning, sessions, library, and settings.
- Implementation correction: the live Gemini prototype must use the existing Lumi wireframe surface, not a separate explanatory dashboard. Gemini-backed content maps directly into existing buttons/screens: A1 recommendations, A2 detail, A3 setup, A4 active cook voice Q&A, A5 wait drills, A3'/A4' deviation modals, and the standalone voice QA screen.

## Decisions

- gemini-integration-path: Staged Gemini app source + optional API toggle; no direct app embed as core UI.
- delivery-strategy: Reliable recording first; Gemini app as upstream research/process source; optional live toggle for demo resilience.
- instructor-tool-scope: This week: instructor tool scenario verifier. Next week: full Lumi UI implementation.
- next-week-model-strategy: Next week: Gemini 3.5 Flash API for live mode, Gemini app/AI Studio for preparation, cached fallback for budget and reliability.
- gemini-output-rendering: Render Gemini through structured Lumi-native components, not raw markdown/chat.
- implementation-target: Local server/API proxy serving the existing Lumi prototype UI with cached fallback, no client-side key exposure, and Gemini updates rendered into existing Lumi screens/buttons.
