# Fly — PRD

*Last updated after a full debugging session against real GoToGate checkout flows. This revision replaces optimistic earlier claims with verified, code-read status.*

## 1. Goal

Turn booking a flight from a ~20-field checkout into 1-3 clicks, on any airline/OTA site, using a stored user profile — without hardcoding per-site logic.

## 2. Vision

Fly is the default layer between "I found a flight" and "I have a ticket." It starts as a Chrome extension (fast to iterate, full DOM access, easy to test against real airline sites) and expands to an iOS app that does the same thing system-wide. The extension is not the product — it's the proving ground for one core capability: an agent that can look at an arbitrary checkout flow, understand it, and complete it correctly and safely using the user's saved data.

## 3. What currently exists (verified by reading the code, not by memory)

**Extension** (`apps/extension/`): Chrome MV3, content script (~4,450 lines) injected only on 5 hardcoded domains (Skyscanner, Croatia Airlines, GoToGate — see §7). Per checkout cycle it: scans the DOM for fields/buttons/sections, captures a screenshot, detects open dropdowns/modals, and renders a sidebar with a traveler picker, a free-text "anything specific for this booking?" box, a section-progress checklist, and a reasoning log. A floating "AI" cursor badge shows what it's about to touch and carries the current reasoning as a tooltip. When the agent needs input, an on-page prompt appears next to the cursor (not in the sidebar).

**Backend** (`apps/web/server.js`, ~1,640 lines): plain Node `http` server, no framework. Every decision cycle calls OpenAI (`gpt-4.1-mini`) with the page snapshot + screenshot + traveler profile + session memory, and gets back one atomic action (`click`/`type`/`select`/`wait`/`ask_user`/etc.). Payment/CVC fields are excluded from what the model can even see, upstream, before any decision logic runs. A session tracks completed fields/sections and a stall counter.

**Data**: JSON file store (`work/air-travel-wallet-db.json`), not a real database. Supabase schema exists in `/supabase` but nothing in the code talks to it — aspirational, unused.

## 4. Agent core loop, as actually implemented

1. **Perceive** — DOM scan + screenshot, every cycle.
2. **Server-side reconciliation** — merges in session memory, computes `allowedTargetIds` (union of everything detected, not narrowed to a "current task" anymore).
3. **Decide** — one OpenAI call returns one atomic action.
4. **Validate** — reject only if the target genuinely doesn't exist on the page and has no usable text label to fall back on (loosened this session; previously over-rejected).
5. **Stall check** — 3 identical repeats with zero change in section status → stop calling OpenAI, hand control to the user via the on-page prompt, instead of looping.
6. **Act** — resolve by DOM id first, live text-label re-match second (handles stale ids from React re-renders).
7. **Recurse** from step 1.

This loop is real and the mechanism is sound. What's not yet true: a full run completing this loop from start to "ready to pay" without a stall. See §6.

## 5. Core components

| Component | Status | Notes |
|---|---|---|
| Perception (DOM scan + screenshot, every cycle) | Built | Real, verified |
| Decision engine (LLM call) | Built | Every action goes through a real OpenAI call — no deterministic bypass (`deterministicReconciledDecision` exists in `server.js` but is dead code, never called) |
| Scope/target validation | Built, loosened this session | Was over-rejecting valid decisions; now permissive by design |
| Stall detection + human handoff | Built | 3-repeat threshold, hands off via on-page prompt, not silent looping |
| Traveler profile vault + per-booking free-text instruction | Built | Sidebar collects a one-off instruction, merged into every decision's context |
| Payment/CVC guardrail | Built | Structural exclusion at the perception layer, not just a prompt instruction |
| Section/field completeness detection | **Partial, the core weak point** | Hand-written JS heuristics (`inferSectionStatus`, `hasSelectPlaceholder`, `classifyStep`) guess whether a section is done. Every distinct bug found this session traced back to one of these guesses being wrong on a specific site's markup, and the model trusting that guess instead of independently verifying against the screenshot. |
| Guardrail/policy engine as an isolated module | **Not real** | `packages/shared/risk-rules` is scaffolded, unused. Decline-paid-extras logic is inline in `server.js`. |
| Any-site support | **Not real** | `manifest.json` hardcodes 5 domains. Contradicts the goal structurally, independent of loop quality. |
| Actuator-agnostic decision layer (for iOS later) | Partially true | The decision engine returns structured actions, not raw DOM calls — reusable in principle. But the perception layer is deeply DOM-specific (`data-atw-element-id` stamping), which does not port to iOS. |
| iOS actuator | Not started | Correctly deferred — see §9. |

## 6. Honest current status

Every real test this session — run against live GoToGate checkout flows — **stalled and required human intervention before reaching payment.** The pattern across runs: each fix let the next run get further into the flow before hitting a *new, distinct* bug (a dropdown that wouldn't close, a required field bundled invisibly into an already-"complete" section, a "Continue" button truncated out of a large surface's option list, a virtualized seat map silently reassigning a cached element reference). Zero completed runs, on any site, this session. Real, meaningful progress — each fix was a genuine bug, correctly diagnosed and fixed — but "the extension reliably completes a checkout" is not yet true, and shouldn't be claimed as done until a full run actually completes without a hand-off.

## 7. The core architectural problem

Every distinct bug this session reduces to the same root cause: **hand-written JS heuristics decide "is this section/field/page done" before the model ever looks, and that guess is trusted as if it were verified.** When the guess is wrong — which happens on every new site's markup eventually — the model never finds out, because it's never asked to independently check. This is not a reasoning-quality problem (every time the model was actually shown accurate information, its judgment was correct); it's a trust-placement problem.

The fix is not another heuristic patch. It's architectural: stop trusting `inferSectionStatus`/`classifyStep`/`stageExit.continueAllowed` as ground truth. Before anything consequential (especially clicking Continue), require the model to independently verify completeness from the current screenshot, every time, regardless of what the internal tracking claims. JS's role shrinks to "fast first guess" / UI display hint, never "gate."

A partial version of this (requiring a fresh visual check before trusting `continueAllowed`) was implemented this session via prompt instructions. The fuller version — removing the JS pre-classification layer's authority more broadly, not just at the Continue moment — has not been done yet.

## 8. Alternatives evaluated

**Skyvern** (github.com/skyvern-ai/skyvern) was evaluated hands-on this session (installed locally, ran against the demo checkout). Its underlying loop philosophy (perceive fresh every step, don't trust cached state, rich action vocabulary including SCROLL/RELOAD_PAGE/structured failure classification) is exactly the right blueprint and validates the direction above. **Rejected for adoption** because it's architected as a multi-tenant automation platform ("give me a URL, I'll run an independent bot against it") rather than something that augments a user's own already-open, already-logged-in browser tab — a fundamental product-shape mismatch with what Fly is. The specific *design patterns* (explicit scroll/reload actions, structured retry/failure classification) are worth folding into the custom build; the platform itself is not worth adopting.

**browser-use** and **Stagehand** were reviewed but not hands-on tested. browser-use shares Skyvern's fresh-every-step philosophy (same product-shape mismatch would likely apply). Stagehand's caching/replay-of-successful-actions model is the opposite of what's needed — it deliberately trusts prior-run memory, which is the same failure mode being fixed here, just packaged differently.

## 9. What's next, in order

1. **The completeness-verification fix, done properly** — not just at the Continue moment (partially done), but as a general principle: JS-computed status is a hint, never a gate. This is the single highest-leverage remaining fix, and the thing to prove before claiming any reliability.
2. **Re-test to an actual completed run** — the real success signal isn't "this specific bug is gone," it's a full run, start to "ready to pay," with zero hand-offs, on a site tested fresh.
3. Extract guardrail/policy logic into `packages/shared/risk-rules` (still dead code), made a pure function of (action, profile) → allow/deny, independent of DOM detection.
4. Replace the static 5-domain manifest allowlist with `activeTab`-triggered injection — the actual "works on any site" fix.
5. Only after #1-2 hold up on a second, previously-untested site: begin iOS actuator research. Not before — the perception layer's DOM-specificity needs to shrink first, or the iOS work starts from a much weaker foundation than it should.
