# Agent Architecture Tracker

Last updated: 2026-07-13

Status key:

- `[x]` Done
- `[~]` Partial / in progress
- `[ ]` Not started

## Current Status

Current phase: `P0.10 canonical decision/requirement groups`

- `P0`: `[~]` about 92%
- `P1`: `[~]` about 45%
- `P2`: `[ ]` 0%
- `P3`: `[ ]` 0%

This file is the tracker. Update it after every implementation pass and live test.

Expanded architecture reference: [AGENT_ARCHITECTURE_PLAN.md](./AGENT_ARCHITECTURE_PLAN.md)

## P0: Before Adding More Airlines

| # | Step | Status | Progress | Latest Feedback | Next |
| --- | --- | --- | --- | --- | --- |
| P0.1 | Stop extension helpers from executing outside the unified action pipeline. | `[x]` | `processCheckoutAgent()` always goes through the backend planner. Mutating helpers now require an active backend-approved action context. Legacy local auto-continue actors were removed. Backend action-producing fallbacks were removed from the live agent loop. | Original split-brain issue showed local helpers and backend fallbacks could act as hidden second brains. | Keep future helpers as mechanics only; any new mutating helper must pass through the same action execution context. |
| P0.2 | Assign every action a `turnId`, `actionId`, `observationId`, and transaction ledger entry. | `[x]` | Backend `actionId`, `observationId`, `observationHash`, `requirementId`, `intent`, `targetSnapshot`, and `expectedOutcome` now pass into the extension decision, execution ledger, verification ledger, action history, and next-turn `lastActionResult`. | Root issue: planner, executor, verifier, and ledger were reconstructing action meaning separately. | Future persistence can move the ledger from local JSONL/in-memory traces to durable storage, but the lifecycle contract is now shared. |
| P0.3 | Remove duplicate session-state systems. | `[x]` | API routes now use `agent/session-store.js` as the only live session store. The old `agentSessions` map and report fallback were removed. | Two state systems could disagree during tests. | Delete unused legacy planner functions later as cleanup, but they no longer own live session state. |
| P0.4 | Add transaction invariants. | `[~]` | Pre-payment invariants block payment/final actions, unsafe money actions, validation-error navigation, unresolved required sections, stale active-surface/background navigation, and observation-hash drift. Removed the old action-producing recovery that could override a correct planner action using stale classifier data. Invariants now need to consume canonical decision groups instead of broad section/label state. | Recent flexible-ticket/cancellation tests showed recovery could replace a correct Continue with a stale/broad decline search. | Finish group-scoped invariant checks: navigation is allowed only when every required decision group is satisfied or explicitly waived. |
| P0.5 | Expand compound actions into auditable atomic steps. | `[~]` | Compound helpers emit linked `atomic_result` ledger rows. | Still hard to know exactly which internal sub-action succeeded or failed. | Rewrite compound actions as skill invocations that expand into atomic click/type/select/verify steps. |
| P0.6 | Implement payment authorization as a one-time offer-bound object, not a boolean. | `[ ]` | Skipped for now. `paymentApproved: false` remains placeholder. | Not needed for current no-payment checkout testing. | Build before any real payment/final purchase action. |
| P0.7 | Prevent stale-target execution after page changes. | `[x]` | Target snapshots cover active-surface buttons/options, page buttons/fields, and section buttons/choices/fields, with target kind, semantic, risk, surface, section, required/value metadata. Extension validates live target identity/surface/label/box/coverage and rejects observation-hash drift before execution. | Repeated labels, active modals, and explanatory target labels exposed target binding issues. | P1.2 will add visual target IDs on screenshots for stronger model grounding, but stale-target execution is now guarded. |
| P0.8 | Evidence-backed requirement reconciliation. | `[~]` | Blind `satisfiedRequirementIds` merging is removed. Requirement evidence is now checked against canonical decision groups so evidence from one group cannot satisfy another group. Authority order remains deterministic current group/control state -> same-observation verifier evidence -> classifier/verifier interpretation -> historical memory. | Baggage requirement was previously verified using a flexible-ticket control because evidence was scoped to control text, not decision group. | Replay-test baggage/flexible/cancellation contradictions and ensure unresolved/conflicted group state blocks navigation. |
| P0.9 | Canonical logical control graph. | `[~]` | Implemented first live slice for DOM/ARIA controls. Extension now builds `page.controls` with one `controlId` across input/state element, label, wrapper, activation member, accessibility evidence, state, section/surface, actuators, and visual region. Server preserves it. Backend target binding can choose/bind `controlId`. Extension resolver activates the preferred verified actuator, validator accepts same-control membership, and verifier checks logical control state. | Radio/label/custom-card failures showed raw DOM node identity was still too brittle. | Add replay regression for the captured radio/label failures, then P1.2 screenshot annotations using these same `controlId`s. P1.5 extends this to canvas/SVG/seat-map regions. |
| P0.10 | Canonical decision/requirement groups. | `[~]` | First live slice implemented. Extension now builds `page.decisionGroups`; every logical choice control carries `decisionGroupId`; server compaction preserves groups; backend target snapshots/actions carry group identity; requirement reconciliation and extension verification use group-scoped evidence; target validation rejects cross-group target execution. Old broad paid-extra recovery was removed. | Root issue: controls were canonical, but baggage/flex/cancellation decisions were not. Unselected paid alternatives inside a satisfied group were treated as missing. | Replay-test the captured baggage, flexible-ticket, cancellation, and seat-preference failures; then make policy/invariants consume only group state for choice requirements. |

## P1: Improve Generalization

| # | Step | Status | Progress | Latest Feedback | Next |
| --- | --- | --- | --- | --- | --- |
| P1.1 | Add accessibility-tree information. | `[x]` | Observations now include accessibility role/name/state for fields, page buttons, section choices, active-surface options/buttons, and compact page-level accessibility controls. Server compaction preserves this evidence for classifier/extractor/planner. | DOM-only view missed semantics on custom controls. | P1.2 will draw these stable target IDs directly onto screenshots. |
| P1.2 | Annotate screenshots with canonical control IDs. | `[ ]` | Not started. | Model still maps visual controls to DOM indirectly. | After P0.9, draw visible `controlId`s on screenshots and return actions against those IDs. |
| P1.3 | Record iframe and shadow-root context. | `[ ]` | Not started. | Needed for airline/payment widgets and embedded checkout components. | Add frame/shadow path to every observed element. |
| P1.4 | Improve overlay detection. | `[~]` | Surface stack, `currentSurface`, background task pausing, backend current-surface target binding, foreground confidence, foreground visual fingerprint, progress markers, accessibility evidence, and action-producing fallback removal are implemented. | Reopened because a reopened dropdown/choice surface could be treated as blocking even when its selected value was already correct. | Connect overlay/current-surface state to canonical decision groups so selected foreground controls close or proceed instead of becoming blockers. |
| P1.5 | Add visual element regions for canvas and SVG. | `[ ]` | Not started. | Seat maps may not be fully DOM-addressable. | Add visual regions with labels and coordinates. |
| P1.6 | Add explicit uncertainty thresholds. | `[ ]` | Not started. | Agent sometimes repeats instead of knowing confidence is too low. | Add confidence gates for target match, state classification, and stage exit. |
| P1.7 | Add before/after visual and structural verification. | `[x]` | Expected outcomes now carry before structural signatures plus before visual-state fingerprints; verification compares after structural state, foreground fingerprints, foreground progress markers, and visual control state. Same modal with different flight marker now counts as progress. | Continue/no-extra loops and repeated seat surfaces needed more than URL/DOM step comparison. | P1.2 can add annotated screenshot/crop evidence, but before/after structural and visual-state verification is implemented. |

## P2: Improve Scale

| # | Step | Status | Progress | Latest Feedback | Next |
| --- | --- | --- | --- | --- | --- |
| P2.1 | Build reusable checkout skills. | `[ ]` | Not started. | Current helpers are mechanics, not reusable audited skills. | Build after P0 action contract is stable. |
| P2.2 | Build declarative airline/site knowledge packs. | `[ ]` | Not started. | Gotogate is still the proving ground. | Wait until P0/P1 stabilize. |
| P2.3 | Build a redacted page-state replay corpus. | `[ ]` | Not started. | We have logs/screenshots but not replay fixtures. | Convert Gotogate failures into fixtures. |
| P2.4 | Run regression tests against every recorded failure. | `[ ]` | Not started. | Manual testing is still the validation loop. | Add replay tests for first page, seats, no-seat confirmation, repeated extras. |
| P2.5 | Measure success by stage and interaction type, not only complete checkout rate. | `[ ]` | Not started. | Evaluation is mostly manual. | Add metrics by stage: profile fields, baggage, extras, seats, payment gate. |

## P3: Product / iOS Path

| # | Step | Status | Progress | Latest Feedback | Next |
| --- | --- | --- | --- | --- | --- |
| P3.1 | Shared profile/policy/transaction model for extension and iOS. | `[ ]` | Not started. | Extension architecture is still stabilizing. | Start after P0/P1 reliability improves. |
| P3.2 | Native approval/payment UX. | `[ ]` | Not started. | Payment authorization object does not exist yet. | Start after P0.6. |
| P3.3 | iOS implementation. | `[ ]` | Not started. | Extension is still proving the loop. | Start after core agent is reliable. |

## Live Feedback Log

| Date | Stage | Result | Tracker Update |
| --- | --- | --- | --- |
| 2026-07-11 | Traveler/contact/baggage page | Improved, but speed and occasional stalls remain. | P0.2, P0.4, P0.5 still partial. |
| 2026-07-11 | Seat map and no-seat confirmation | Improved; agent can skip seats and pass confirmation more often. | P0.7 improved; P1.4 partial. |
| 2026-07-11 | Seat summary / random seating state | Improved but still needs clearer state classification. | P1 typed surface state needed. |
| 2026-07-11 | Extra services with repeated `No thanks` cards | Got to page 3; repeated SMS/support cards exposed bad coarse memory. | P0.7 fixed: scoped `No thanks`, exact-section verification, no coarse completion memory for repeated extras. |
| 2026-07-12 | Expected-outcome loop | Added stage-exit blockers and before/after structural verification for clicks, selects, types, and modal actions. | P0.2, P0.4, P0.7, P1.7 improved. |
| 2026-07-12 | No-seat confirmation modal | Backend chose correct `Continue`, but invariant blocked it because background seat task stayed pending while active modal asked to continue without seats. | P0.4 fixed: seat skip confirmation is now treated as the active surface decision and is not blocked by stale seat task. |
| 2026-07-12 | Surface model implementation | Added `surfaceStack`, `currentSurface`, `currentSurfaceTasks`, and `backgroundTasks`; backend target binding now prefers `currentSurface`. | P1.4 advanced; P0.4/P0.7 now use surface-scoped state instead of flat page state. |
| 2026-07-12 | Bundle `No, thanks` choice | Backend chose the right no-cost decline, but invariant treated the phrase `continue without bundle` as a stage-exit button and blocked it. | P0.4/P0.7 fixed: stage-exit guards now use explicit navigation intent and snapshots, not loose text substring matching. |
| 2026-07-12 | Hidden local Continue actors | Removed local `canUseContinueGate()`, `clickContinueGate()`, and the legacy branch that could skip extras or click Continue before backend planning. | P0.1 done: page-changing helpers only run during backend-approved action execution. |
| 2026-07-12 | Duplicate session store | Removed the live `agentSessions` map and `/agent/report` fallback path. | P0.3 done: API routes use `agent/session-store.js` as the single live session state source. |
| 2026-07-12 | No seat map / seat preference surface | Backend fallback chose `Next` while `Random seating 0EUR` was visible and unresolved; invariant then blocked it and asked the user. | P0.1 corrected: backend action-producing fallbacks removed. P0.4 kept the invariant block. P1 next: improve planner perception with typed surfaces/accessibility/target IDs instead of fallback rules. |
| 2026-07-12 | Backend fallback removal | Live agent loop no longer creates checkout-changing actions from model errors, no-seat heuristics, deterministic safe navigation, or policy replacement. | P0.1 strengthened: fallbacks may stop/ask, but may not decide checkout actions. Legacy unused server planner still needs cleanup later under P0.3. |
| 2026-07-12 | Unified typed action lifecycle | Backend-planned actions now keep the same identity and typed target contract through client decision, execution, verification, ledger, and next-turn feedback. | P0.2/P0.7 advanced; P0.4 can now consume typed intent instead of guessing from labels. |
| 2026-07-12 | Flexible ticket / bundle typed policy | Policy and extension invariants now distinguish opening a choice control from selecting a paid extra, and distinguish no-cost decline actions from paid choices using typed target snapshots. Observation hashes are stable against local DOM id churn. | P0.2 done, P0.4 pre-payment invariants done, P0.7 done. |
| 2026-07-13 | Visual grounding pass | Added accessibility role/name/state to observations, foreground surface fingerprints/progress markers, and before/after visual-state verification. Backend prompts now use foreground/accessibility evidence. | P1.1 done, P1.4 done, P1.7 done. Next: P1.2 annotated screenshot target IDs, then P1.5 visual regions for canvas/SVG seat maps. |
| 2026-07-13 | Cancellation guarantee pending choice | Planner saw cancellation insurance was pending but proposed `Continue`; extension invariant correctly blocked navigation. | P0.4 strengthened: when no-extras policy is active and navigation conflicts with an unresolved paid-extra decision, the loop recovers to the visible safe decline choice before policy/execution. |
| 2026-07-13 | Contradictory verifier/page requirement state | Attachment identified blind `satisfiedRequirementIds` merge and radio/label target identity issue. | P0.8 added and implemented: no blind merge, deterministic observed control/section/task state has highest authority, contradictions become `conflicted`, backend blocks Continue. Immediate resolver order now tries exact `targetId` before semantic fallback. |
| 2026-07-13 | Canonical interaction-state graph decision | Reframed logical controls as a P0 blocker, not a later visual polish item. | Added P0.9. Correct order is now: P0.8 reconciliation -> P0.9 canonical graph -> replay radio failure -> P1.2 annotated screenshots with canonical IDs -> P1.6 uncertainty thresholds -> P1.3/P1.5 frame/canvas/SVG extensions. |
| 2026-07-13 | P0.9 canonical graph implementation | First live DOM/ARIA control graph implemented across extension observation, server compaction, backend target binding, extension target resolution, validation, and verification. | P0.9 partial: logical controls now exist and flow through the agent. Remaining: replay regression and P1.2 screenshot annotations with canonical IDs. |
| 2026-07-13 | Latency instrumentation | Added per-turn latency spans for observation build, screenshot capture, backend request round trip, classifier model call, verify/plan model call, policy, target resolution, click-to-first-mutation, page settle, outcome verification, next-loop delay, token counts, and model name. | Measurement pass before more architecture changes: use these logs to prove whether slowness is model latency, screenshot/request upload, target resolution, page settling, or verification. |
| 2026-07-13 | Canonical decision groups | Added first P0.10 slice and removed old broad paid-extra recovery. Choice controls now carry `decisionGroupId`; page observations include `decisionGroups`; reconciliation/verification/target validation are group-aware. | P0.10 partial, P0.4/P0.8/P1.4 reopened to partial until replay/live tests prove baggage/flexible/cancellation groups resolve independently. |
