# Agent Architecture Tracker

Last updated: 2026-07-20

This tracker follows [AGENT_ARCHITECTURE_PLAN.md](./AGENT_ARCHITECTURE_PLAN.md) as the canonical roadmap. The plan defines the architecture and ordering; this file records implementation and live-test evidence.

For the short ordered execution list, see [FLY_EXECUTION_TODO.md](./FLY_EXECUTION_TODO.md). For the current code and runtime explanation, see [CURRENT_CODEBASE_ENGINEERING_HANDOFF.md](./CURRENT_CODEBASE_ENGINEERING_HANDOFF.md).

Status key:

- `[x]` Done and acceptance-proven for the stated scope
- `[~]` Partial, implemented but not acceptance-proven, or reopened by a live failure
- `[ ]` Not started

## Current Position

Current implementation pass: `the optional-control obligation regression and typed physical-effect layer are covered by tests. The newest live run completes traveler data, extras, scrolling/rebinding, and the seat flow, but loops at the final review modal because the unfinished reach-payment goal is replaced by a broad modal decision that permits dismissal`

Next architecture gate: `preserve one durable parent outcome across intermediate surfaces, build decision groups only from real alternatives/obligations, and detect no-net-progress surface cycles. Then filter by the parent-compatible effect and replay the final review modal repeatedly before starting the three-engine acceptance corpus`

- `P0`: `[~]` Durable transactions, immutable observations, prerequisite continuity, policy, invariants, atomic execution, fresh reobservation, verification, and bounded recovery are working together in live checkout. The immediate P0 gap is durable task-outcome truth: an intermediate surface can replace the parent goal, allowing a locally correct dismissal to count while payment remains unreached.
- `P1`: `[~]` Unified observation includes canonical controls, capabilities, surfaces, DOM/ARIA evidence, visual regions, fresh diffs, and bounded dense-surface projection. The immediate P1 gap is control-evidence lineage: nearby/surface text still overwrites the icon-only close control's label even though the typed physical-effect layer now recovers `dismiss_surface`.
- `P2`: `[~]` The current suite passes `110/110` unit tests and `37/37` browser/cross-layer tests. A local same-label close-vs-submit contract test passes, but the faithful reducer/lifecycle replay is missing: it does not reproduce the live modal becoming a generic decision and the `base → modal → base` cycle. There is still no three-engine replay corpus or repeated cross-site acceptance proof.
- `P3-P5`: `[ ]` Not started.

The current root objective is:

> Keep one durable transaction/stage outcome across every intermediate surface.
> Fresh observations may change the temporary surface/action subgoal and its
> physical binding, but only the exact parent postcondition can complete the
> parent outcome. Local action success is never automatically checkout progress.

### Current Core Architecture Gap — Durable Goal Hierarchy

TaskState should remain the sole production semantic authority. The regression is not evidence that the project should restore the earlier loose AI loop or parallel legacy controllers. The missing component is hierarchy inside that authority:

```text
transaction outcome: complete checkout safely
→ stage outcome: reach payment review
→ temporary surface subgoal: resolve current popup/review/seat/warning
→ atomic action: execute one grounded current capability
```

Current code recreates a flat `currentGoal` from each observation. In session `chk_mrtds157i3oqo5`, the final review surface therefore replaced `reach payment review` with a generic modal decision. Although the newer effect layer correctly typed the chosen close actuator as `dismiss_surface`, the broad replacement goal permitted that effect and compiled it to `command_acknowledged`. The local dismissal succeeded, payment did not, and the base page reopened the modal.

The gate closes only when:

- `[ ]` Parent goal IDs and postconditions survive popups, rerenders, scrolling, and intermediate pages.
- `[ ]` Foreground surfaces create temporary subgoals without replacing unfinished transaction/stage outcomes.
- `[ ]` Blocking decision groups require real alternatives or a proven obligation; navigation/review surfaces are not generic decisions.
- `[ ]` Candidate effects must satisfy both the parent outcome and current subgoal.
- `[ ]` Transition evaluation records local physical effect separately from net parent progress.
- `[ ]` Recovery detects `base → modal → base` and other semantic cycles under the stable parent goal.
- `[ ]` A faithful reducer/lifecycle replay reproduces the live modal decision-group shape and reaches fresh payment evidence.

This is the reusable correction for arbitrary airline/OTA popups and intermediate surfaces. It must not be implemented as a Gotogate selector, label rule, fixed step sequence, or new popup-specific skill.

### Live Optional-Control Obligation Regression - 2026-07-20

Sessions `chk_mrszs3fkaxbcun` and `chk_mrt0fbhf8zpgve` reproduce the same deterministic pre-dispatch failure after a refresh, proving this is deployed semantic-state behavior rather than a stale content script or transient model/API issue.

1. Contact details, country code, phone, names, and date of birth were observed on the traveler page. The required title radio group was still empty.
2. The current observation also contained the optional newsletter opt-out checkbox: `I do not wish to receive any newsletters...`.
3. `normalizeObservedDecision()` defaults every unresolved observed decision group to `active`, even when `group.required === false`; it waives an optional group only when the browser reports `not_applicable`.
4. `activeDecisions` therefore promoted the optional newsletter group into the authoritative current goal: `resolve the exact current decision decision`.
5. That group exposed one uncertain generic `choice`. The safe candidate filter correctly refused to execute it, while the required title and all later controls became context-only because they did not belong to the mistaken current goal.
6. The loop stopped with `No safe grounded candidate...` before any model call or browser dispatch. Restarting on a fresh session reproduced the same result.

Root conclusion: the new single-authority direction is correct, but its obligation predicate is incomplete. **Observed and unresolved does not mean required and blocking.** This is not a missing checkbox/title skill, perception failure, or Gotogate selector bug.

Required correction:

```text
fresh observed control/group
-> prove it is an obligation from required metadata, scoped validation,
   explicit user policy, or a progression constraint
-> only then allow it to become the blocking current goal
-> otherwise retain it as optional context and continue required work
```

Required generic regression:

```text
contact data filled
+ optional newsletter checkbox unchecked
+ required title empty
-> newsletter remains optional_available/non-blocking
-> TaskState chooses and resolves title
-> required traveler fields complete
-> baggage/extras/navigation continue normally
-> no user handoff for the newsletter control
```

Also cover the inverse cases: an explicit saved newsletter preference may create a goal, and a genuinely required legal/payment consent must remain governed and cannot be silently waived. Ask the user only when a **proven required** obligation lacks safe data or a safe grounded action.

### Current Code And Live-Run Audit - 2026-07-19

Current HEAD: `041a8a7 Add cross-site DOB codec to payment baseline`.

Verified automated baseline:

- `99/99` agent unit tests pass in the current TaskState consolidation.
- `35/35` browser and cross-layer tests pass.
- The browser suite required normal localhost permission; its first sandbox failure was an `EPERM` bind failure, not a product-test failure.

Latest live session `chk_mrs2u53jvr244r` proves the reusable foundation can:

1. Fill contact, country code, phone, traveler identity, and date of birth from the profile.
2. Traverse four different seat legs using current observed controls rather than a stored airline procedure.
3. Handle intermediate seat confirmations and continue from fresh foreground surfaces.
4. Resolve independent paid-extra decisions with free/no-extra choices.
5. Advance through `Continue to Payment` and reach `https://en-en.gotogate.com/rf/payment`.
6. Initially stop and ask the user at payment review because no authorized payment action exists.

This does **not** count as a safe consecutive acceptance pass. A later observation of the same payment URL was classified as `confirmation`, ordinary planning resumed, and the agent selected the travel-conditions checkbox. Legal acceptance is not traveler-profile data and must not be executed without explicit authorization.

The live result narrows the root problem. Fly is not missing another click, scroll, country-code, popup, or seat skill. It still has several layers that independently decide what the page means:

- The extension builds decision groups, section status, task queues, stage exits, and step classifications.
- The backend independently derives requirements, goals, semantic families, policy contradictions, task context, and transitions.
- Browser verification and backend transition evaluation both interpret semantic success.

When these authorities disagree, a valid current control is rejected, a background obligation can override a foreground popup, or a terminal payment page can become an ordinary checkout page again.

The next root-level implementation gates are:

- `[~]` **One authoritative semantic-state reducer.** `task-state-reducer.js` now consumes the prior state, fresh observation, last result, user policy, and traveler profile; it owns stage, foreground surface, decisions, preserved completions, current goal, ambiguity, and terminal output. It is not yet the sole downstream authority: the legacy requirement reconciliation/lifecycle is still written into `state.requirements`, and shared policy still uses those requirements to veto forward navigation.
- `[~]` **Grounded ambiguity resolution before handoff.** Unknown foreground surfaces and missing goal-relevant capabilities now produce `surface_ambiguity`; AI receives a closed current-observation candidate schema and a semantic outcome, while the governor remains the final dispatch gate. The current ambiguity candidate set still makes policy-denied money/legal/payment controls selectable rather than context-only, so a bad selection can cause an avoidable handoff instead of choosing a safe alternative.
- `[~]` **Sticky payment-review boundary.** The reducer already detects payment from combined route/progress/field/heading evidence, and the loop suppresses candidate generation when `payment_review_reached`. This was implemented despite payment being described as deferred. It is not sticky yet: `terminalStatus` is recomputed only from the latest observation and does not preserve a prior terminal state across an ambiguous or regressed observation.
- `[ ]` **Remove parallel/dead authorities after replay equivalence.** Retire unused page-state classifier, requirement extractor, verify-and-plan path, legacy direct form filling, and the unused persisted skill-plan/recovery machinery. Reduce the main loop to orchestration of reducer -> candidates -> selection -> governor -> lifecycle.
- `[ ]` **Three-engine acceptance corpus.** Prove the same semantic loop on a normal airline checkout, an aggressive low-cost/upsell checkout, and an OTA/custom-SPA checkout. Record checkout-to-payment rate, manual interventions, unsafe actions, model calls, latency, and typed handoff reasons.

Acceptance for this gate is not “Gotogate works once.” It is repeated payment-review arrival with zero paid extras, zero legal/payment actions, no manual correction, and no airline-specific procedure required across all three engine families.

### Post-Implementation Architecture Review - 2026-07-20

The uncommitted consolidation is directionally correct and mechanically green:

- `task-state-reducer.js` is present and integrated before new planning.
- The extension publishes `step: unknown` and no longer publishes an executable task queue, reducing extension-owned semantic authority.
- Background decisions are suspended under a foreground surface.
- Exact completed outcomes survive rerender, scrolling, and surface replacement.
- Unknown foreground surfaces expose current grounded capabilities to bounded AI selection.
- Candidate selection is schema-closed over current candidate IDs and now returns a typed semantic outcome.
- Legacy requirement output is stored under `legacyRequirementsDiagnostic`; shared policy and current candidate selection consume TaskState rather than `state.requirements`.
- AI receives the complete current-surface capability context with policy/selectability annotations, while its executable schema contains only policy-safe selectable candidate IDs.
- Deterministic selection and AI selection consume the same filtered candidate set; deterministic selection runs only for a singleton.
- `npm run check` passes.
- `101/101` unit tests pass.
- `35/35` browser and cross-layer tests pass.

The consolidation must remain `[~]` until these remaining boundaries are closed:

1. `goalForDecision()` still passes the exact TaskState decision back through the broad legacy `deriveObservationGoal()` classifier. This can rewrite a cabin-baggage decision as `decline checked baggage` and empty the safe selectable set despite a current free sibling.
2. Payment terminal handling is partial and non-sticky. Either remove the partial terminal branch until intentionally implemented or finish the durable invariant before another live payment run.
3. The old requirement/verification modules and diagnostic lifecycle calculations remain in the codebase. They are no longer correctness authorities, but should be removed only after reducer-driven replay equivalence; do not continue evolving them as a parallel planner.

No additional airline-specific skill is justified by this review. The immediate work is authority consolidation, then one live Gotogate replay, then the three-engine acceptance corpus.

### Live Exact-Decision Goal Regression - 2026-07-20

Session `chk_mrswcreqw6rzul` proves the TaskState and safe-candidate changes are deployed, but exposes one remaining parallel semantic authority:

1. The agent filled and canonically verified date of birth without a model call.
2. The fresh observation contained two independent current-surface baggage groups: cabin baggage and checked baggage. Each had its own alternatives and exact `decisionGroupId`.
3. TaskState correctly selected the first active instance, the cabin-baggage group.
4. `goalForDecision()` then called the older page-wide `deriveObservationGoal()` mapper. That mapper classifies every baggage family as `decline checked baggage`, regardless of the exact selected decision instance.
5. The cabin free alternative was observed as a generic `choice` with uncertain risk, while its sibling was a positive-price `add_paid_extra`. Because the goal/candidate contract did not normalize that exact contrast, the policy-safe selectable set became empty and the run stopped before browser dispatch with `No safe grounded candidate is available for the current goal: decline checked baggage.`
6. This was not an AI, scrolling, target-binding, governor, or executor failure. No model call or browser action was attempted for the failed turn.

The root correction is not a Gotogate baggage rule and must not restore a page-wide deterministic fallback. TaskState must construct the semantic goal directly from the exact active decision and its observed alternatives. The goal contract must preserve its `decisionGroupId`, eligible alternative control IDs, desired policy disposition, and exact postcondition unchanged through candidate construction. Within that exact group, a zero/no-price alternative contrasted with a positive-price sibling can be normalized as a safe free/decline outcome even when its raw control semantic is merely `choice`.

Required regression:

```text
observe cabin baggage: [no hand baggage, paid 8 kg]
and checked baggage: [no checked baggage, paid 10 kg, paid 20 kg]
→ TaskState owns the exact cabin group
→ select and verify its free alternative
→ fresh observation
→ TaskState owns the exact checked group
→ select and verify its free alternative
→ publish Continue only after both exact groups are resolved
```

Current verification after the live failure: `npm run check` passes, `101/101` unit tests pass, and `35/35` browser/cross-layer tests pass. The gate remains `[~]` because those tests do not yet include this exact two-group live shape.

### Live Close-Versus-Submit Semantic Collision - 2026-07-20

Session `chk_mrsxngupndkbft` proves the exact-decision correction materially improved the live path: the agent completed profile data, independent extras, flexible ticket decisions, four seat legs, seat confirmations, and every final-page no-extra decision. It reached the `Review Your Details` foreground modal immediately before payment. It then looped between the base-page `Continue` and that modal.

The trace proves the browser executor clicked the exact target selected by the backend. The failure occurred earlier, in observation semantics:

1. The modal exposed two different canonical buttons.
2. The icon-only close control had stable identity `testid:dialog-close` and a 50x50 region at the modal's top-right, but it was observed with label and accessible name `Continue to Payment`.
3. The real forward CTA had stable identity `testid:info-review-submit-button` and was also observed as `Continue to Payment`.
4. Both became safe selectable candidates with the same command effect and the same `command_acknowledged` postcondition.
5. The model selected the first candidate, which was the close control. Its exact actuator was dispatched, the modal disappeared, and generic dismissal verification marked the action successful.
6. Payment was not reached, so the base-page `Continue` became current again and reopened the same modal. The cycle repeated.

This is not a Gotogate procedure gap, an executor miss, or a need for another click skill. It is a reusable perception-and-postcondition defect: two physical commands with opposite effects were collapsed into one semantic action, and surface disappearance was accepted where the real goal required stage advancement.

Required correction:

```text
observe each physical command's own accessible/local evidence
→ classify close/dismiss separately from submit/advance
→ expose both as context, but only goal-compatible effects as selectable
→ dispatch the exact selected actuator
→ treat modal disappearance as intermediate evidence
→ complete only when the payment stage/route or another typed forward transition is observed
```

Required generic regression:

```text
foreground modal contains an icon-only X and a primary Continue to Payment CTA
→ X is observed as close/dismiss_surface
→ CTA is observed as submit/advance_stage
→ advance-to-payment goal cannot select the dismiss control
→ click exact CTA
→ modal dismissal alone is not terminal success
→ fresh payment-stage evidence satisfies the goal
→ base Continue is never reopened
```

Cover icon-only close controls, misleading or missing ARIA names, portal-rendered modals, rerendered element IDs, and close/submit controls with similar nearby text. Do not add a Gotogate text-selector procedure or an arbitrary delay as the primary fix.

Follow-up session `chk_mrt344jsgmy9r8` proves this gate remains open in the current working tree after the optional-control correction. The agent completed the preceding checkout flow, clicked base-page `Continue`, and observed the final `Review Your Details` surface. It then selected candidate 1 for `Continue to Payment`, whose stored stable identity was actually `testid:dialog-close`. The exact close actuator dispatched and generic `command_acknowledged/dismissed` verification marked it successful. The base-page `Continue` then became current again. Static checks, `104/104` unit tests, and `35/35` browser replays all pass, so the missing regression is specifically cross-layer local command-effect preservation and goal-compatible transition verification.

Newest reviewed session `chk_mrt52jzad6yzxd` reproduces the same collision after completing the expanded current checkout path: traveler/profile work, exact cabin and checked-baggage choices, bundle and flexible-ticket handling, governed viewport recovery, both seat legs, the seat warning, and all five final-page no-extra groups. The final stored target again has `testid:dialog-close`, a 50x50 top-right region, and the borrowed label `Continue to Payment`. It is emitted as `semanticEffect=advance` with `expectedEvidence=dismissed`; modal disappearance is accepted as `OBSERVABLE_CHANGE`, then base-page Continue reopens the modal. Current verification after this session is `npm run check`, `105/105` unit tests, and `36/36` browser/cross-layer tests. The architecture gate remains open because the passing suite still lacks the exact physical-effect collision.

Follow-up session `chk_mrtds157i3oqo5` proves the physical-effect correction is deployed but is not sufficient. The close actuator still borrows the CTA label, yet it now carries `physicalEffect=dismiss_surface`. The reducer nevertheless converts the entire review modal into an active `contact` decision group and replaces the unfinished `reach payment review` outcome with `resolve the exact current decision`. That broad decision contract permits `dismiss_surface`; because the control also has a decision-group ID, expected-outcome compilation downgrades it to `command_acknowledged`. The loop therefore alternates base Continue and modal close indefinitely. Recovery cannot see the net cycle because failed-strategy memory is keyed to the observation-scoped current goal, which changes on each surface. Current verification is `npm run check`, `110/110` unit tests, and `37/37` browser/cross-layer tests. The passing review-dialog replay explicitly assumes no modal decision group, so it does not reproduce this live reducer/lifecycle shape.

### Live Dense-Seat Strategy And Transport Regression - 2026-07-20

Session `chk_mrszf11j6xi43x` reached the seat stage after successfully resolving the preceding checkout decisions. The apparent seat-modal wait is not a model or executor stall. The trace proves two sequential failures:

1. The current observation exposed the seat surface, its `Next` transition, and seat-related controls.
2. TaskState restricted execution to the direct alternatives of the active seat decision. It therefore made the safe `Next` transition context-only even though this checkout expresses “no paid seat” indirectly as `Next -> fresh warning -> Continue`.
3. `decisionOptionContract()` inferred that any non-priced sibling of a paid option was a free option. This incorrectly admitted the traveler selector `Ali SIFRAR Not selected` as the one safe selectable candidate.
4. The executor clicked that exact selected target. Verification correctly rejected it with `EXACT_FREE_OPTION_NOT_VERIFIED`; this was not a missed click.
5. The resulting dense seat-map observation expanded to more than 200 controls. Every subsequent request exceeded the server's 5.5 MB observation limit and was rejected before the backend loop or model ran.
6. `smallerObservationTransport()` retained the full controls, aliases, operations, recovery regions, and actuators, so each retry remained oversized. The client then scheduled the same impossible retry indefinitely.

The close-versus-submit correction did not cause this failure. The wrong first action comes from the uncommitted TaskState option contract; the transport loop is an older latent P1.2 defect exposed by the larger seat surface.

Required root corrections:

```text
semantic outcome: no paid seat
-> observe candidate-local evidence
-> direct verified free option if one exists
-> otherwise allow grounded safe transition strategies such as Next
-> reobserve the fresh warning/confirmation surface
-> continue only while price and paid-selection evidence remain unchanged
-> complete when the typed no-paid-seat outcome is observed
```

- A control is free/decline only from positive evidence on that control itself: explicit zero price, free/skip/decline semantics, or an observed exact state. A paid sibling and the desired policy are not evidence that another control is free.
- Structural controls, legends, and traveler selectors cannot become decision alternatives unless their observed semantic effect matches the goal.
- Goal-compatible strategies may include current-surface transition commands, not only direct decision-group alternatives. Intermediate transitions remain incomplete until a fresh typed outcome proves the user policy.
- Build a bounded transport projection for dense surfaces. Aggregate repetitive paid seat cells, deduplicate alias/actuator/recovery evidence, preserve every unresolved decision and safe navigation control, and assert serialized bytes are below the client budget before sending.
- One compact retry is allowed. Repeating an unchanged oversized body is not recovery and must terminate with a typed diagnostic.

Required cross-layer regression:

```text
observe traveler selector + 200 paid/unavailable seat cells + Next
-> traveler selector and legend are not free alternatives
-> no direct free seat option exists
-> Next remains a selectable grounded transition strategy
-> serialized observation remains below the transport budget
-> click Next
-> observe warning/confirmation
-> choose the current safe no-paid-seat continuation
-> verify no paid seat and no price increase
-> advance to the next leg/stage without retry loop or handoff
```

This keeps P0.10, P1.2, P0.11, and P2.3 `[~]`. Do not add a Gotogate seat selector, raise the request limit as the primary fix, or restore a page-wide fallback.

### Live Multi-Leg Seat Lifecycle Regression - 2026-07-18

Session `chk_mrq3a7ykx5x3mi` reached the two-leg seat flow but did not complete it without handoff:

1. The agent selected free random seating for the first leg and verified `Next` by observing the second leg.
2. On the second leg, fresh observations exposed both `Next` and `Skip seat selection`. The agent repeatedly preferred `Skip seat selection`; browser dispatch succeeded, but the page did not change.
3. Bounded recovery eventually used `Next`, handled the `Are you sure?` modal with `Continue`, and reached the zero-price seat summary. This proves observation, target binding, clicking, fresh reobservation, and popup handling can work in the same run.
4. The zero-price summary still classified `Seat not selected` as an unresolved seat requirement. It therefore selected `Skip seat selection` again instead of treating the no-paid-seat policy as resolved and the remaining interface obligation as simple forward navigation.
5. Useful intermediate transitions (`Next`, `Continue`, summary/seat-map changes) did not clear the accumulated no-effect recovery state for the multi-step seat obligation. One more ineffective skip exhausted the execution budget while a current, enabled `Next` remained visible.

Root conclusion: the live blocker is the generic multi-step obligation lifecycle, not a missing Gotogate seat selector. A negative policy outcome such as `no paid seats` must be represented separately from interface progression. After that policy is resolved, current `Next`/`Continue` controls advance the flow, and no-effect strategy history must be scoped to the current surface/capability and reset after meaningful progress. P0.11, P1.3, and P2.3 remain `[~]` until this exact replay reaches the next checkout stage without handoff.

Follow-up session `chk_mrq5ugvbv91j4j` proves the lifecycle changes are present but do not yet close the gate:

1. The agent used current `Next`, handled the fresh no-seat confirmation with `Continue`, and reached the zero-price summary. The hidden `Skip seat selection` helper was correctly non-executable, and useful transitions no longer exhausted the prior execution budget.
2. The classifier still recreated an unresolved seat obligation on the zero-price summary and retained contradictory/stale seat evidence. This sent planning back toward seat-preference/seat-selection controls even though the user policy outcome was already satisfied and safe forward navigation remained.
3. On the final summary the current raw grounded set contained five candidates (`Next`, seat-preference link, `Choose seat`, `Price`, and `Back`). The model returned invented ID `obs_mrq67101_522:candidate_16` on all three attempts. The server correctly rejected it as `PLANNER_CANDIDATE_NOT_CURRENT`; no browser action was dispatched, but the loop handed off instead of selecting the uniquely policy-aligned safe `Next` candidate.

Acceptance remains open until one current-surface semantic state removes stale/background optional-extra obligations, and model selection is structurally constrained to an actual candidate from that state (with deterministic selection when filtering leaves one safe policy-aligned candidate). Repeating an unchanged prompt three times is not recovery.

Follow-up session `chk_mrq8lzr81ee851` advanced through both seat legs and their confirmations, reached the extra-services page, selected and browser-verified the free/no-extra AirHelp option, and derived a single navigation goal for `Continue`. The first observation correctly emitted a governed scroll because `Continue` was outside the viewport. The fresh post-scroll observation then proved the same canonical `Continue` control visible, enabled, hit-tested, current-surface-owned, and executable. Nevertheless, `requirementsWithDecisionGroups` converted five previously handled/offscreen decisions to `conflicted` because their canonical groups were absent from the fresh observation. The policy layer therefore denied the only `Continue` candidate as “5 required item(s) not yet satisfied”; selection received no allowed candidate, one identical server rebuild changed nothing, and the loop handed off without dispatching the visible button.

This reopens the acceptance gate on a sharper invariant: absence after scrolling or leaving an interaction region is not contradictory evidence and must never erase a browser-verified outcome. Resolved obligations must persist by stable semantic/scope identity, while current observation updates only the remaining interface goal. Candidate selection must also short-circuit truthfully when policy filtering produces zero candidates; it must not report this as model grounding failure. P0.11 remains `[~]` until the same flow preserves prior outcomes across viewport changes and dispatches the current safe `Continue`.

Follow-up session `chk_mrqbgnztag1of6` reproduced the same failure after the lifecycle refactor. The new pending-action schema and unified recovery state are present, but the ordinary candidate builder still replaces an offscreen `activate Continue` capability with a standalone `scroll_to` candidate. The lifecycle verified that scroll as an achieved action, cleared the original work, and entered planning again instead of rebinding/resuming `Continue`. The fresh observation exposed exactly one raw candidate—visible, safe `Continue`—but policy excluded it because the same five historical requirements remained falsely `conflicted`. The final allowed candidate set was empty; no model call occurred (`0` tokens, `0` calls), yet the UI incorrectly reported “AI planner or model API unavailable while choosing between multiple current candidates.”

Therefore the consolidation is partial, not acceptance-complete. Offscreen state must remain a property of the original candidate/capability rather than becoming a replacement semantic action; the single lifecycle must own reveal and resume. Missing/offscreen historical groups must preserve verified outcomes, and empty-after-policy must be reported and recovered as a semantic-policy inconsistency rather than model ambiguity.

Deeper inspection of `chk_mrqbgnztag1of6` corrects the ordering of causes: the first failure occurred before `Continue`. Perception placed AirHelp, baggage protection, mobile plan, SMS, and premium support radio pairs into one section-level canonical decision group (`contact`). Selecting only AirHelp `No thanks` therefore marked the entire group satisfied and derived navigation as the remaining goal, even though four independent required radio groups remained unresolved. The later scroll/resume and policy failures are downstream consequences. Canonical decision-group identity must be based on the smallest mutually exclusive choice set (native radio `name`, ARIA radiogroup/fieldset ownership, or an equivalent local choice container), not the broad visual section. One selected alternative may satisfy only its own group. The extras acceptance replay must prove every independent required group is resolved before `Continue` becomes eligible.

### First Live Checkout-To-Payment Success - 2026-07-18

Session `chk_mrqghs7tdvoni9` is the first recorded live run in this pass to complete traveler details, baggage/extras, both seat legs and confirmation surfaces, then reach `https://en-en.gotogate.com/rf/payment` without manual correction or a paid extra. The final observation preserved the two-leg ZAG-SJJ itinerary, traveler/contact facts, no checked baggage, and the observed `208 EUR` total. This counts as `1/5` toward the repeated live payment-page gate; it does not yet close that gate.

The terminal handoff is expected for the current supported scope: the persisted user intent explicitly says `Stop before real payment`, P0.8 payment authorization is not implemented, and P3 secure/tokenized payment work has not started. No card data or final purchase action should occur in this state.

Two payment-boundary correctness issues remain:

1. The `/rf/payment` observation is incorrectly labeled `confirmation`, so the lifecycle derives `continue checkout` and falls back to the generic `no current grounded control` message instead of declaring the payment handoff complete.
2. Before stopping, the agent classified the required travel-conditions checkbox as safe `traveler_title` and selected it. Legal acceptance is not traveler-profile data and should not be performed as an ordinary safe choice.

The root correction is a generic terminal-boundary contract, not a Gotogate payment patch: fresh URL, progress-marker, heading, and sensitive-field evidence must classify the current stage as `payment`; entering that stage must reconcile the transaction to `payment_review_reached`, suppress ordinary checkout planning, and produce an explicit user handoff. Legal acceptance, payment credentials, and purchase submission require their own typed semantics and authorization. The current release target remains reaching payment review; autonomous payment remains blocked by P0.8/P3.

## P0 Reliable Execution Vertical Slice

This milestone is the current release gate. Code/replay completion and live acceptance are tracked separately.

### Implemented And Replay-Tested

- `[x]` One persisted profile skill owns the required traveler fields in deterministic order: email, confirmation email, phone country code, local phone number, title, first/middle/last name, full name when present, date of birth, nationality, and visible document fields.
- `[x]` Phone data is normalized into country code and local number. The current Ali profile resolves Slovenia to `+386` and preserves the local number separately.
- `[x]` Date of birth is stored canonically and adapted to the observed input/options. The current profile date `2003-05-31` is emitted as `31-05-2003` for a `DD-MM-YYYY` field.
- `[x]` Native selects, radio/title choices, ordinary text fields, and custom comboboxes use governed atomic operations with fresh observations and exact expected outcomes.
- `[~]` A custom country-code combobox is modeled as persisted `open` and `choose` atoms, but the latest live run proves the declared `open` actuator does not yet flow unchanged through executor resolution. The executor fell back to the state/input member and the options surface never appeared.
- `[x]` No model call is required between ordinary deterministic profile atoms. Failed verification, ambiguity, a validation error, or an unexpected surface suspends the skill truthfully.
- `[x]` The backend creates the profile skill from canonical unresolved traveler/contact state before either model call. Profile completion no longer depends on the model proposing `fill_visible_profile_fields`.
- `[~]` The governor blocks later checkout work while canonical traveler/contact fields remain, but visible validation is still represented as global page strings rather than scope-owned issues.
- `[x]` Governor outcomes are typed as `allowed`, `recoverable`, `blocked_by_policy`, `blocked_by_safety`, or `requires_user`.
- `[~]` An offscreen canonical target preserves its pending skill atom or ordinary action and dispatches governed recovery, but the live executor still scrolls only the document viewport and can incorrectly treat a missing refreshed control as recovered.
- `[x]` Canonical semantic, risk, decision group, surface, and actuator ownership remain authoritative through planning, governance, execution, and verification. Live DOM text is not used to reinterpret a governed control.
- `[~]` `type` resolves only to the editable state member and `select` only to a native select state member. Exact operation-member click resolution is reopened: the latest live `open` action requested `atw-el-42` but executed `atw-el-3`.
- `[x]` Controlled-input rerenders are re-resolved and verified against the replacement live input.
- `[x]` Twenty deterministic blank-form profile replays pass.
- `[x]` Eleven browser DOM replays pass, including the complete profile, wrong-default country code, title, controlled-input rerender, canonical aliases, semantic label drift, safe/paid sibling separation, and exact foreground postconditions.
- `[~]` Focused orchestration coverage proves blank-profile auto-ownership and logical rebinding, but it does not yet cover suspended-plan resumption, scope-owned validation, nested scroll containers, or disappeared-target failure.

### Current Root Gate: Canonical Blocked-Obligation Continuity

This is the one high-leverage P0 gate. It is implemented through existing
P0.3/P0.4/P0.5/P0.7/P0.9/P0.11 rather than a new P number.

Every blocking fact must persist:

```js
{
  obligationId,
  kind,
  owner: { requirementId, skillPlanId, atomId },
  scope: {
    controlId,
    decisionGroupId,
    sectionId,
    sectionType,
    surfaceId,
    scrollContainerId
  },
  blocker: { code, sourceObservationId, evidence },
  status: "active | recovering | resolved | handed_off",
  recovery: { strategy, attempts, maxAttempts },
  resolution: { predicate, expectedValue }
}
```

Closure requires:

- `[ ]` A suspended required atom automatically resumes or rebuilds from fresh canonical state when it becomes executable.
- `[ ]` Dependent fields and later checkout stages cannot bypass that suspended prerequisite.
- `[ ]` Validation issues carry canonical control/section/surface scope; unrelated errors cannot block or satisfy another obligation.
- `[ ]` Viewport recovery scrolls the nearest effective scroll container, not always `window`.
- `[ ]` Missing, exhausted, or ambiguous recovery returns typed failure and never defaults to success.
- `[ ]` Only a fresh scoped resolution predicate or explicit truthful handoff releases ownership.

### Live Acceptance Still Required

- `[ ]` Twenty consecutive live blank Gotogate profile executions succeed.
- `[ ]` Country code, local phone, title, all required fields, and date of birth are correct in every live run.
- `[ ]` Zero visible validation errors remain and no baggage/extras action starts before profile completion.
- `[ ]` Safe decline and paid acceptance retain distinct controls and actuators on live popups, with zero registry conflicts and false intent mismatches.
- `[~]` One of five consecutive live Gotogate runs has reached the payment page without manual correction or paid extras while following the saved baggage/seat policy (`chk_mrqghs7tdvoni9`). Four more consecutive successes are required.
- `[ ]` Every live action has a verified ledger result and no false stale-target handoff occurs.

Until those live checks pass, P0.4, P0.7, and the ordinary-DOM portion of P0.9 remain `[~]` even though their implementation/replay contracts are green.

### Live Profile Regression - 2026-07-15

Session `chk_mrm0ibvcbb3ebn` disproved the claim that the governed custom-combobox path is acceptance-ready:

1. The profile skill correctly persisted seven ordered atoms and resumed without model calls.
2. It retyped email and confirmation email even though the canonical observation already reported both values present. The skill's plain-text satisfaction branch currently defaults to `false` instead of consuming canonical value state.
3. The country-code atom observed the wrong current value (`+44-1481`) and correctly needed `+386`.
4. The canonical registry exposed the combobox input as both state member and preferred click target. The governed `open_profile_choice` action clicked that input; a DOM mutation occurred, but the dropdown did not remain open and no foreground option surface was observed.
5. Exact verification correctly returned `ACTIVE_SURFACE_UNCHANGED`. SQLite persisted the skill as `suspended` and the transaction as `awaiting_user`; phone, first name, and surname atoms never ran.
6. The next model turn proposed `No checked baggage`. The central governor correctly rejected it with `PROFILE_SKILL_INCOMPLETE`, which is the visible stop the user encountered.
7. The semantic packet also contains conflicting state representations: canonical page/accessibility state reports `expanded: "false"`, while the material signature applies `Boolean("false")` and records `expanded: true`.
8. Existing browser replay manually clicks fixture elements and does not execute the complete producer -> skill -> governor -> executor -> verifier lifecycle against the real HeadlessUI actuation shape. Its green result did not cover this failure.

Root conclusion from the failed run: the governor failed closed correctly, but the producer published the country arrow both as the country control's `open` actuator and as an independent button control. That created ambiguous alias ownership. The repair makes operation actuators exclusive members of their parent canonical control, normalizes control state once, and makes the skill, governor, executor, hash, and verifier consume that same state/operation contract. The faithful browser replay now passes; live acceptance is still required.

### Follow-up Live Regression - 2026-07-15 16:35 Europe/Ljubljana

Session `chk_mrm6c9xegnre14` proves the representation repair reached the live extension but the full profile contract still did not own execution:

1. The observation correctly reports normalized values and boolean state. The country control publishes `normalizedValue: "+441481"`, `expanded: false`, and a distinct `open` actuator.
2. No `activeSkillPlan` was created. The model chose six independent actions for email, confirmation email, title, phone, first name, and surname. The compound profile skill remains optional because `loop.js` expands it only when the model happens to propose `fill_visible_profile_fields`.
3. Because the skill never ran, the known wrong country code was not reconciled to the traveler profile's `+386`. The local number `70328922` was typed under `+44-1481`, producing the visible error `The phone number you entered is too long`.
4. Despite that validation error, the next model action targeted `No checked baggage`. The profile sequencing guard did not apply because it currently depends on an active skill existing in session state.
5. The baggage control was canonical but 51 pixels below the observed viewport. The governor returned `TARGET_OUT_OF_VIEW`; `policyBlockedAction()` converted every denial into `ask_user`, so the agent stopped instead of performing a governed scroll/reobserve and rebinding the pending action.
6. SQLite confirms `activeSkillPlan` is null and the transaction ended `awaiting_user`. The live control representation is improved; transaction orchestration and recovery are the current root blockers.

Root conclusion: profile ownership must be selected deterministically from canonical transaction state, not delegated to model wording. Visible validation must block later checkout decisions independently of in-memory skill presence. A known off-screen target requires governed scroll/reobserve recovery, not a human-fix prompt.

### Operation-Actuator Live Regression - 2026-07-15 21:39 Europe/Ljubljana

Session `chk_mrmhde7realbpu` proves deterministic profile ownership is now active, but the producer -> executor operation-actuator contract is still broken:

1. The backend created and resumed persisted profile skill `skill_mrmhdk66_iwyqa` before model planning. Email and confirmation email ran as deterministic atoms with zero model calls and verified successfully.
2. The country control correctly observed `normalizedValue: "+441481"`, desired `+386`, and published `open.actuatorId: "atw-el-42"` with `actuatorIds: ["atw-el-42", "atw-el-3"]`. `atw-el-3` is the readable HeadlessUI combobox state/input member.
3. The first `open_profile_choice` action correctly requested `targetId: "atw-el-42"`. During execution, target resolution skipped that operation member and fell back to `atw-el-3`; the dispatched point was the center of the `+44-1481` display (`444,449`).
4. No foreground options surface appeared. Exact verification correctly returned `OPTIONS_SURFACE_NOT_APPEARED`.
5. The bounded retry then selected the second declared actuator, `atw-el-3`, and failed with the same result. The skill stopped owning the remaining profile work and the runtime fell back to expensive general model turns.
6. The repeated `control.registry_conflict` entries are not the direct cause: their payload reports `unresolvedCount: 0`, and the samples concern paid-extra controls. They remain noisy observation churn but do not explain the country click.

Root conclusion: this is not a Gotogate selector gap. Capability production, target binding, and live execution disagree about actionability. A node published as the canonical `open` actuator must either be executable as that exact member or must not be published. The executor may not silently substitute the state/input member after governance. Fix the generic operation-member contract and add a faithful producer -> skill -> governor -> executor -> verifier replay where the opener is a small sibling button and clicking the combobox input does nothing.

### Repeated Operation And Session-Continuity Regression - 2026-07-16 09:27 Europe/Ljubljana

The latest rerun proves the previous repair has not passed the live architecture contract and reveals a second root failure:

1. Deterministic profile ownership still starts correctly and fills the two email fields.
2. For the country control, the producer now publishes only `atw-el-3` as the `open` candidate, with reason `state-popup-contract`. The visible sibling arrow/toggle is absent from the candidate set.
3. Execution resolves `atw-el-3` to the `+44-1481` input/display and dispatches at approximately `444,449`. No options surface appears, so verification correctly returns `OPTIONS_SURFACE_NOT_APPEARED`.
4. Every client request in this visible run carries an empty `sessionId`. The backend therefore creates at least five different transaction IDs during what the user experiences as one agent run: `chk_mrn6qxjgb4f13j`, `chk_mrn6r91mzxix3f`, `chk_mrn6rdj7nrxqwe`, `chk_mrn6rhmep9p2mb`, and `chk_mrn6rliuea127u`.
5. Because `reportActionResult()` exits when `agent.sessionId` is empty, the failed country action is not attached to the durable transaction. The next backend turn cannot consume the prior typed failure or advance a bounded alternative-actuator retry.
6. The skill is recreated in fresh transactions and repeats the same `open phone_country_code` atom until the extension's local repeat guard stops the loop and asks the user.
7. Static code intends `/api/agent/session` to return a state containing `id`, so the precise live handshake defect still requires instrumentation. The proven fact is that the content script never retains a non-empty ID for this run; plausible causes include a failed session request, a stale extension runtime, or a response/runtime mismatch.
8. The existing clean fixture uses a conventional 38-pixel button and does not represent this live icon/sibling activation shape. Green replay results therefore do not cover either the missing candidate or the empty-session lifecycle.

Root conclusion: two generic contracts are broken. First, one Start Agent lifecycle must preserve one durable transaction ID through every observation, action, result, retry, and stop. Second, a combobox must not advertise its readable state/input as an `open` actuator merely because it has popup state; the producer must discover a genuinely clickable opener or report that no executable opener is known. Until both contracts are repaired and replayed together, the profile path is not live-acceptance-ready.

### Post-Fix Live Run - 2026-07-16 10:09 Europe/Ljubljana

Session `chk_mrn8a86qcsr91b` proves the durable-session repair is loaded and working, but the country-code repair is incomplete:

1. All captured turns, actions, verifications, and result reports retain the same non-empty session ID. The prior transaction-fragmentation failure is fixed in this run.
2. The deterministic profile skill starts and verifies the email atom. Confirmation email is already satisfied from current observation.
3. On the next observation, the canonical country-code control correctly reports current normalized value `+441481` and desired profile value `+386`, but publishes no `open` operation at all. Its operation record is `open: null`.
4. The profile skill therefore does not click the wrong input in this run. It suspends before country interaction with the exact reason: `The canonical phone_country_code control does not publish an executable open operation.`
5. The real Gotogate arrow/toggle remains absent from the canonical actuator list. The producer calculates a `rightEdgeControl` geometric relationship, but `rightEdgeControl` is not included in `provenCandidate`; geometry alone therefore cannot admit the candidate. Separately, `effectiveOperationActuator()` rejects boxes smaller than `24x16` before it can reliably promote a small icon to a larger clickable ancestor.
6. The green profile fixture does not cover this live shape. It uses a semantic 38-pixel `<button>` with `aria-haspopup` and `aria-controls`, so it is accepted through explicit button/ARIA contracts without exercising the icon-only/right-edge path.
7. After suspension, the orchestration loop falls through to general model planning. A suspended skill is excluded from deterministic recreation, while the governor permits profile-scoped `satisfy_field` actions.
8. The model consequently types local phone `70328922`, first name, title, and surname even though the earlier country prerequisite remains unresolved. With `+44-1481` still selected, Gotogate correctly raises `The phone number you entered is too long`.
9. The requirement layer also treats the contact decision as satisfied merely because `+44-1481` is selected; it does not preserve the stronger profile constraint that the selected country code must equal `+386`.
10. When the planner later proposes baggage, the governor correctly blocks it with `PROFILE_SKILL_INCOMPLETE`, and the run ultimately asks the user because the invalid phone remains.
11. The live country control is an editable combobox, but capability production currently makes `type` and dropdown behavior mutually exclusive: `editable && !dropdownLike` is required before publishing `type`. Because this control is `dropdownLike`, `type` is suppressed; because the arrow is not discovered, `open` is also null. The canonical record therefore exposes state but zero executable strategies.

Root conclusion: the latest code is safer and the session repair is successful, but the system now fails closed at capability production and then incorrectly continues around the failed prerequisite. The high-leverage repair is not another country skill. It is: (a) model controls as multi-capability components, including editable comboboxes that may support `type query`, `open`, and `choose`; (b) produce actionable regions for small/non-semantic component toggles through generic hit-region and parent activation discovery; and (c) keep the suspended deterministic prerequisite authoritative so dependent atoms and later AI planning cannot bypass it. Once those contracts hold, the reusable selectable-value skill can choose the best available strategy and verify the committed `+386` value.

### Live Blocked-Obligation Recovery Run - 2026-07-16 11:32 Europe/Ljubljana

Session `chk_mrnb9drky1n9fp` proves the newest deployment changed the live behavior but did not yet change the country code:

1. One durable session remains stable.
2. Email and confirmation email execute as ordered deterministic atoms and verify successfully.
3. The country atom remains the authoritative prerequisite. Phone, title, names, baggage, and later work do not bypass it.
4. The country control remains `+44-1481` with desired value `+386` and still publishes no executable DOM `open` operation.
5. The observation now publishes a bounded right-edge visual recovery region at approximately `x=471, y=425, width=35, height=48`, tied to the country control and `open` operation.
6. Three consecutive model recovery turns do not use that region. Each proposes unrelated/later work and is converted by ownership enforcement into `wait / recover_skill_observation`.
7. The recovery contract is contradictory: the planner is told to use `click_xy` inside a supplied recovery region for the owned atom, but is also told never to use `click_xy` to recover a DOM control.
8. The configured recovery model is the same `gpt-4.1-mini` model used for ordinary planning, so repeated attempts do not provide meaningful escalation.
9. The third recovery request was sent at 11:38:31 local time. As of 11:42:55, the client had received no response or terminal result, leaving the sidebar effectively stuck in `Thinking`. This is live evidence for the open P1.7 request-timeout/cancellation gap.

Root conclusion: session continuity and prerequisite ordering are now working, while recovery has become a safe wait loop that can also remain indefinitely `Thinking`. The generic repair is to prefer a proven DOM/parent actuator, otherwise permit exactly the observation-supplied bounded region for that canonical operation, verify `OPTIONS_SURFACE_APPEARED`, and stop truthfully after a finite failed-attempt and request-time budget.

### Visual-Recovery Serialization Regression - 2026-07-16 12:25 Europe/Ljubljana

Session `chk_mrnd3x4bdh7op3` proves the deterministic recovery dispatcher is now live, and identifies the exact cross-layer contract failure:

1. One durable session owns the run. Email and confirmation email execute and verify before country recovery.
2. The country obligation remains authoritative, with current value `+44-1481`, desired value `+386`, operation `open`, and expected recovery outcome `options_surface_appeared`.
3. The observation publishes and screenshot-annotates the bounded right-edge region `x=471, y=425, width=35, height=48`, centered at approximately `489,449`.
4. The backend deterministically produces `click_xy(489,449)`. The central governor accepts it with `VISUAL_CONTROL_RECOVERY_BOUND`, `VISUAL_FALLBACK_BOUND`, exact blocked-obligation ownership, and current-observation checks.
5. `normalizeAction()` preserves `x`, `y`, `width`, `height`, viewport size, and `surfaceId`, but drops the region's `centerX`, `centerY`, evidence, and confidence fields.
6. The extension's `validateVisualCoordinateTarget()` compares the fresh canonical recovery region to the serialized action region through `boxesCloseEnough()`, which requires the live region's center coordinates when the canonical candidate has centers. Because the serialized region has no centers, the comparison evaluates false and returns `VISUAL_CONTROL_RECOVERY_UNPROVEN`.
7. No click is dispatched. Nevertheless, `elementFromPoint(489,449)` resolves the point to Gotogate's real 20×20 HeadlessUI country-code button, proving the region and point were correctly grounded.
8. The next turn truthfully hands off instead of looping, but it records the rejected dispatch as the one attempted bounded candidate and reports that no actuator remains.
9. The focused governor test passes because it ends at backend authorization. Existing browser producer tests do not serialize the action through `normalizeAction()` and then run extension coordinate validation/execution. The missing test is the complete recovery handoff.

Root conclusion: this is not a country-code patch, model failure, bad coordinate, or missing atomic skill. The same visual-region capability has two incompatible identities: the backend authorizes it by edge geometry while the extension revalidates it by center geometry after the normalizer has discarded the centers. Define one shared normalized `VisualRegion` contract and one equality predicate, consume both in the governor and executor, preserve the screenshot annotation/operation/control binding, and add a producer -> normalizer -> governor -> executor -> verifier replay. When that contract passes, the already-correct point should click the real arrow and the next observation can verify the options surface.

### Roadmap Alignment Audit - 2026-07-16

The latest failure is also evidence of a broader implementation and planning drift. Atomic actions and reusable semantic skills are still aligned with the roadmap; deterministic interaction discovery as a prerequisite for AI recovery is not.

The original roadmap contract was:

```text
AI understands, plans and recovers.
Deterministic infrastructure controls, executes and verifies.
The transaction ledger remembers the truth.
```

The repository `HEAD` version also said that removed extension actors could remain as detectors or action proposers if they returned normalized actions, and ordered compressed observation, screenshot annotation, page diff, and richer feedback before the reusable skill library.

The current working plan later added stronger requirements that changed the boundary:

1. Profile skill ownership must start before general model planning.
2. Fresh binding requires an unambiguous canonical control and executable operation.
3. If no deterministic actuator is proven, the operation is declared non-executable and must reobserve or hand off.
4. The revised immediate order delays the remaining P1 perception/recovery work until after blank-profile live acceptance.

Those additions created a circular gate: live blank-profile acceptance on surprising custom controls requires the P1 visual/accessibility/browser fallback, but the current P0 gate refuses the interaction until deterministic metadata already proves its actuator.

The implementation reflects that inversion:

1. `loop.js` creates and advances the profile skill before either model call.
2. A suspended atom enters `canonicalBlockedRecoveryAction()` before AI planning.
3. If deterministic recovery cannot produce an accepted candidate, the transaction hands off immediately.
4. `verify-and-plan.js` simultaneously tells the model to use a supplied recovery region for an ambiguous owned atom and never to use `click_xy` for a DOM control.
5. Generic heuristics such as tag, role, pointer cursor, CSS class, box size, and right-edge geometry have become permission requirements. Their failure is treated as “cannot act,” rather than uncertainty evidence for AI/browser recovery.

What remains correct and should not be removed:

- Atomic browser actions with exact results.
- Semantic skills such as fill traveler details or select a value.
- One transaction, one observation identity, one governor, policy/invariant checks, and exact verification.
- Suspended prerequisite ownership so phone/baggage cannot bypass an unresolved country value.
- Payment and paid-extra safety gates.

The required correction is:

1. A skill owns the semantic obligation and desired postcondition, not the website-specific interaction method.
2. Deterministic binding is the fast path for familiar controls, not the only permitted path.
3. When deterministic binding is incomplete, AI receives the current semantic graph, accessibility evidence, annotated screenshot, and bounded browser evidence and proposes one grounded atomic action.
4. The governor checks observation freshness, foreground/surface, safe region, risk, policy, and expected outcome. It does not require the producer to have already understood the exact widget implementation.
5. The executor performs the atomic action and the next observation proves or disproves the postcondition.
6. Only repeated low-confidence or failed governed attempts hand off to the user.

Root conclusion: the roadmap did not require hardcoded airline workflows, and skills are not the regression. The drift was turning the canonical graph from shared identity/evidence into a complete capability whitelist, then moving AI-led perception and recovery behind that whitelist.

### Profile Contract Repair - 2026-07-15

- `[x]` Canonical state includes normalized value, checked, selected, disabled, expanded, value presence, and native-control facts.
- `[x]` Canonical controls publish typed `open`, `choose`, `type`, `select`, and `activate` capabilities with explicit actuator ownership, preconditions, and postconditions.
- `[x]` Operation actuator nodes are exclusively owned by their parent logical control and cannot be emitted as a second executable control.
- `[x]` The profile skill compares desired values against canonical normalized state and skips already-satisfied fields.
- `[x]` Mechanical failures report typed evidence, reobserve, rebind a registered operation actuator, and retry within a bounded skill contract before suspending.
- `[x]` The browser fixture proves the actual arrow opens the country options, Slovenia `+386` is selected and normalized, the surface closes, all required fields complete, no validation errors remain, and graph integrity is valid.
- `[x]` All 11 semantic-control browser replays and all 25 focused transaction/governor tests pass in this implementation pass.
- `[x]` The full agent contract suite passes all 43 tests, and `npm run check` passes the production Vite build, TypeScript validation, and configured JavaScript syntax checks.

## Verified Codebase Audit - 2026-07-14

### Where We Are

- The current uncommitted implementation completes the durable code path for P0.2-P0.7 and materially advances P0.9-P0.11 and P1.1/P1.4. The unused server planner/reconciliation architecture and extension-side semantic governor are removed. Canonical controls and decision groups flow through observation, planning, one central governor, execution, exact verification, and SQLite persistence. P0.3 now separates material execution authority from richer diagnostic page changes.
- `node --test tests/agent/*.test.js` passes all 43 contract tests. Coverage includes deterministic profile ownership before model planning, complete ordered profile skills, twenty deterministic blank-form runs, custom country-code open/select atoms, profile-stage validation blocking, typed viewport recovery for skills and ordinary actions, fresh-observation rebinding, restart reconstruction, immutable observations, duplicate-action rejection, typed policy, coordinate fallback constraints, canonical alias resolution and conflict rejection, persisted multi-atom continuation without model calls, stale unexecuted atom reissue, lifecycle scoping/staleness, and foreground-decline postconditions.
- `ATW_REPLAY_ONLY=1 npx playwright test tests/agent/semantic-control-replay.spec.js` passes all 11 producer replays. In addition to cloned-ID, footer, safe/paid, helper-node, material-hash, and single-flight coverage, the suite now proves the complete profile form, wrong-default custom country code, title selection, controlled-input replacement, operation-specific state-member typing, canonical aliasing, and semantic authority through live label drift.
- Syntax checks pass for the server, loop, governor, skill expander, SQLite store, extension content script, and shared policy/action/state modules.
- No live airline/OTA replay was run in the 2026-07-14 audit. This statement is now superseded by the failed 2026-07-15 Gotogate profile run documented above; the new code must not be called reliable until the governed profile path and the earlier baggage/seat cases pass faithful end-to-end replay and live acceptance.
- `npm run check` passes the production Vite build, TypeScript check, and all configured JavaScript syntax checks.

### How The Current System Works

1. The extension builds a DOM/ARIA page map, canonical control graph, decision groups, active-surface model, screenshot annotations, observation ID, and observation hash.
2. The server compacts that packet and performs two sequential model calls: page-state classification, then verification plus one-action planning.
3. `agent/loop.js` reconciles model output against deterministic current control/group state, persists the requirement lifecycle, expands a compound skill into one atomic action, and binds it to the immutable observation.
4. `agent/action-governor.js` is the single semantic authority for schema, current observation, canonical target, policy, invariants, approvals, expected outcome, and duplicate-action protection.
5. The extension verifies only live browser facts: observation drift, exact registered actuator, foreground ownership, hit testing/actionability, and the governed postcondition. It reports the typed result back to SQLite.
6. `agent/session-store.js` reconstructs transaction state, observations, governed actions, results, and events after process restart. JSON traces remain diagnostic only.

### Root Problem Found By This Audit

The original root problem was real: one physical control and checkout decision could acquire different identities and meanings across observation, planning, execution, verification, and stored state. The code-level repair now establishes one observation-local control registry, immutable observations, one typed action contract, one central semantic governor, exact postconditions, and one durable transaction store. The remaining question is empirical: whether the refreshed extension preserves that contract on the real Gotogate rerender/modal sequence. A live failure should now identify one violated contract code instead of triggering a hidden fallback.

### Important Open Code Findings

- P0.9-P0.11 have code and captured replay coverage, but the refreshed extension has not yet passed the original live Gotogate baggage, cancellation, and two-leg seat transitions. These rows remain partial for empirical acceptance, not because another label fallback or site rule is planned.
- P1.3 is still missing a compact typed before/after observation diff. Exact postconditions are enforced, but the model still receives larger page representations instead of a concise structural delta.
- P1.2 remains pathological: large overlapping page representations and the screenshot are sent to both sequential model calls. The latest live seat evidence remains roughly 700k+ input tokens per turn.
- P1.7 timeout handling is absent in `openai-client.js`: the fetch has no abort signal or request deadline, so an unresponsive model request can leave the UI in `Thinking` indefinitely.
- Section/task summaries remain available only in the extension's local observer UI. They are no longer sent to the governed backend as completion truth and cannot bind, authorize, replace, or verify an action.

## Scope Freeze

Until the P0/P1 exit criteria pass, the supported reliability slice remains:

- One adult in economy, one-way or return.
- Guest checkout.
- No loyalty redemption, infants, pets, special assistance, or complex multi-city trips.
- Skip paid seats by default.
- Apply baggage from predefined user policy.
- Stop before payment until P0.8 and P3 payment safety are complete.
- Validate against three structurally different checkout systems: full-service airline, aggressive low-cost airline, and structurally different OTA/checkout engine.
- Do not expand to additional sites until those three reliably reach final review.

## Latest Live Finding

The latest 2026-07-16 12:25 Gotogate profile run closes the earlier wait-loop diagnosis and exposes the exact remaining recovery blocker:

1. Durable session continuity and suspended country ownership remain fixed in session `chk_mrnd3x4bdh7op3`.
2. The backend now deterministically selects the screenshot-confirmed bounded country `open` region instead of asking the model to improvise recovery.
3. The governor accepts the exact owned `click_xy` at `489,449`.
4. The extension rejects the same action before dispatch with `VISUAL_CONTROL_RECOVERY_UNPROVEN`.
5. The point is correct: live hit testing at that coordinate finds Gotogate's actual 20×20 HeadlessUI arrow button.
6. The rejection is caused by a shared-contract mismatch: action normalization removes `centerX/centerY`, the governor compares `x/y/width/height`, and the extension compares centers.
7. The root repair is one canonical serialized `VisualRegion` plus one shared equality/containment predicate and one full cross-layer recovery replay. It is not a Gotogate selector, country-code rule, or additional skill.

The 2026-07-14 control-identity review found the actual remaining P0.9 gap:

1. Canonical IDs existed, but there was no single observation-local control registry.
2. The same DOM node could still be canonicalized multiple times with different section/surface context.
3. `liveTargetSnapshot`, accessibility extraction, section model building, and expected-outcome creation could rebuild identity after observation.
4. Target validation then correctly rejected the mismatch, but the graph itself had already produced contradictory identities.
5. The required repair is one `ControlRegistry` per observation: foreground controls register first, background scans reference existing ownership, and execution looks up observed control identity instead of recanonicalizing.

The 2026-07-13 Gotogate seat run disproved several previous completion claims:

1. The planner correctly chose `Skip seat selection` for a no-paid-seats policy.
2. The active seat modal inherited `cancellation_insurance` ownership from background checkout content.
3. Tiny 3x3 accessibility/helper nodes named `Skip seat selection` were exposed as actionable controls.
4. The executor clicked one of those nodes near the seat legend instead of the visible `Next` transition.
5. The active surface did not change.
6. Verification still returned `REQUIREMENT_EVIDENCE_VERIFIED` using cancellation-group state.
7. The next turn converted the modal's raw text into a missing requirement and asked the user.
8. Seat turns sent roughly 691k-758k input tokens and took roughly 138-141 seconds across two sequential model calls.

This is not merely a prompt or seat-specific targeting failure. It is an end-to-end semantic identity, requirement lifecycle, actionability, and outcome-verification failure.

## P0 - Fix Control, State, and Transaction Safety

These numbers now match the architecture plan. P0.9-P0.11 are explicit additions discovered during implementation.

| # | Architecture step | Status | Current evidence | Required closure |
| --- | --- | --- | --- | --- |
| P0.1 | Remove extension-side autonomous actions | `[x]` | Live checkout-changing actions go through the backend-approved action lifecycle. Local auto-continue/skip/close actors, compound skip/close action types, and the unused server planner/reconciliation architecture were removed. | Keep all future helpers mechanical; no helper may independently decide a checkout action. |
| P0.2 | Create one authoritative transaction store | `[x]` | SQLite stores transaction intent/state, policies/approvals, invariant fingerprints, requirement lifecycle, immutable observations, governed actions, typed results, payment/confirmation state, and events. A restart test reconstructs the transaction without trace files. | Keep JSON traces diagnostic; schema migrations are future production hardening. |
| P0.3 | Introduce immutable observations | `[~]` | Each observation has a persisted ID/hash and exactly one current marker. The execution hash now represents material semantic state rather than raw text/layout. A materially stale action is reported as unexecuted; a pending skill atom survives, rebinds to the fresh canonical control, and receives a new governed action ID. The extension loop is now single-flight: duplicate triggers coalesce into one rerun, planner responses are accepted only by their originating lifecycle/loop token, and cancelled or late responses cannot execute under a newer turn. Browser and contract regressions cover harmless validation/layout churn, true foreground change, stale-atom reissue, and duplicate loop triggers. | Reload and capture live Gotogate evidence that one planner request is active at a time, harmless validation/layout churn does not cancel an action, and a real popup/control-state change rejects and reissues it. P1.3 still owns the richer typed diagnostic diff. |
| P0.4 | Separate skills from atomic actions | `[~]` | The transaction loop derives canonical profile readiness before model planning, persists one governed atom at a time, and retains suspended prerequisite ownership through an exact blocked obligation. Dependent atoms remain blocked until the same owner/control/operation/outcome is verified or handed off. | Pass twenty consecutive live blank profiles and prove restart continuity during a suspended recovery. |
| P0.5 | Add transaction invariants | `[~]` | Core traveler, itinerary, offer, currency, price, authorization, and duplicate-payment invariants exist. Profile readiness now consumes canonical control/section/surface-owned validation issues or explicit stage-wide blockers. | Live-test scoped validation plus route/price observations. Payment remains outside the current supported scope until P0.8. |
| P0.6 | Add a central action governor | `[x]` | `agent/action-governor.js` is the single semantic allow/block boundary. The extension's duplicate label/money/stage semantic governor was deleted; browser code now enforces live actionability and exact verification only. Policy consumes typed intent/risk/control state rather than button wording. | Preserve this boundary for extension, future browser service, and iOS executors. |
| P0.7 | Strengthen target validation | `[~]` | Canonical aliasing, operation-specific binding, and logical pending-action preservation work. Recovery scrolls the nearest effective container, requires the fresh canonical target to remain present/in-view, and returns `TARGET_DISAPPEARED` instead of default success. | Capture live nested-container and covered-target evidence; constructed browser replays now cover nested scrolling and disappearance. |
| P0.8 | Create a proper payment authorization object | `[ ]` | `paymentApproved: false` remains a placeholder. | Build an offer-bound, amount-bound, itinerary-bound, expiring authorization before any real payment or final purchase action. |
| P0.9 | Canonical logical control graph | `[~]` | Ordinary DOM identity, state normalization, operation actuators, aliases, graph conflict rejection, bounded recovery regions, and control/section/surface-owned validation issues are implemented. Unrelated validation is contract-tested not to block profile readiness. | Add canonical scroll-context metadata and pass the live profile and complex-surface replays. Canvas/SVG regions remain P1.5. |
| P0.10 | Canonical decision groups | `[~]` | Ordinary choice/dropdown controls carry stable `decisionGroupId`s, and group-aware targeting/reconciliation rejects known cross-group evidence. Foreground modal decision groups now include stage/surface/instance scope, while transient dropdown/listbox surfaces can still inherit the parent group to preserve collapsed-open continuity. | Still reopened until live replay proves background baggage selection and foreground baggage/seat confirmation remain distinct and reconcile only through observed transitions. |
| P0.11 | Canonical requirement lifecycle and reconciliation | `[~]` | Scoped lifecycle objects and cross-group reconciliation exist. Suspended skill truth now persists as one blocked obligation, and only scope-matched validation plus exact recovery proof can release its owner. | Pass live baggage, cancellation, and two-leg seat transitions and unify remaining non-skill requirements with the same obligation lifecycle. |

### P0.11 Required Contract

Each requirement/decision instance must contain at least:

```js
{
  requirementId,
  semanticType,
  scope: { stage, surfaceId, decisionGroupId, instanceId },
  required,
  desiredDisposition,
  lifecycleStatus,
  interfaceStatus,
  value,
  evidence,
  createdObservationId,
  lastObservedObservationId,
  resolvedByActionId,
  confidence
}
```

Lifecycle statuses:

```text
active | satisfied | waived_by_policy | blocked | conflicted | stale
```

Required rules:

1. Stage- and surface-scoped requirements become stale when their scope disappears. Persistent transaction facts remain in the ledger but leave the active planning set.
2. Requirements come only from semantic decisions or explicit fields, never raw modal/page text.
3. Fresh deterministic observation outranks historical memory and model interpretation.
4. Evidence must match the same requirement scope or an explicitly typed transition relationship.
5. User policy determines the desired disposition, such as declining paid seats; it does not falsely claim that the website already accepted that disposition.
6. Policy resolution and interface completion remain separate. A waived paid-seat choice may still require clicking `Next` and handling a confirmation.
7. Contradictions become `conflicted`; they are never silently merged.
8. Every planned action has a typed semantic postcondition tied to the current stage/surface instance.
9. Only an observed postcondition may satisfy the action. Dispatch, pre-existing state, or unrelated group evidence is insufficient.
10. A required obligation remains active or blocked when its skill atom suspends. Skill execution status does not determine requirement truth.
11. Validation evidence may block or reopen only the requirement whose canonical scope it matches, or an explicitly typed stage-wide requirement.
12. Recovery dispatch, scrolling, DOM mutation, and disappearance of an executor target are not satisfaction evidence. Only the expected scoped postcondition in a fresh observation may resolve the obligation.

### P0 Exit Criteria

P0 is not complete until all are true:

- Exactly one system can authorize and execute checkout-changing actions.
- Every action is tied to one immutable observation and one ledger lifecycle.
- Every interaction is traceable and the transaction can be reconstructed from the durable ledger.
- One durable store owns transaction state across process restart.
- The current active requirement set is stage-, surface-, group-, and observation-scoped.
- Background or stale requirements cannot enter foreground planning.
- Suspended required work cannot be bypassed by general planning or later-stage actions.
- Validation blockers are canonical and scope-matched rather than global page strings.
- Recovery succeeds only from a fresh actionable canonical binding.
- Non-actionable helper/accessibility nodes cannot become execution targets.
- A result is accepted only when its exact semantic postcondition is observed.
- Price, currency, itinerary, dates, airports, traveler-set, and extras changes are continuously caught.
- Duplicate or ambiguous payment submission cannot be retried automatically.
- Real payment remains blocked without P0.8 authorization.

## P1 - Build the Agent Environment Properly

These rows match the architecture plan. Earlier tracker versions incorrectly reduced P1.1 to accessibility alone and omitted compressed representation and the explicit page-diff engine.

| # | Architecture step | Status | Current evidence | Required closure |
| --- | --- | --- | --- | --- |
| P1.1 | Build a unified observation packet | `[~]` | Semantic checkout sections, fields, buttons, errors, prices, active surfaces, DOM/ARIA roles and states, bounding boxes, canonical IDs, foreground fingerprints, progress markers, screenshot annotation metadata, and capture-time visual overlays now exist. The model can see refs like `[B3]`, `[F2]`, `[O7]`, and `[C1]`; backend allowed-target lists and target binding accept those same refs; extension resolution maps them back to canonical controls. | Still partial until frame/shadow ancestry, parent-child/nearby-label relationships, explicit evidence-vs-actuator distinction, and canvas/SVG visual regions are represented in the same packet. |
| P1.2 | Add compressed whole-page representation | `[~]` | Server compaction and payload clamps exist. | Current seat turns still reach roughly 700k+ input tokens. Aggregate repeated seat cells/options, preserve safe navigation and unresolved decisions, remove duplicated raw/accessibility text, and enforce a per-turn observation/token budget. |
| P1.3 | Build the page-diff engine | `[~]` | Structural signatures, foreground fingerprints, progress markers, URL/stage comparisons, and before/after snapshots exist. | Add an explicit typed diff result: appeared/disappeared/changed/enabled/disabled/modal opened/closed/errors/price/stage/URL/target reaction. Stop making the verifier rediscover the whole page. |
| P1.4 | Improve action feedback | `[~]` | Target resolution, click dispatch, mutation timing, page-settle timing, structural/visual checks, and ledger verification codes exist. Foreground declines carry `active_surface_dismissed`; dispatch/mutation remain evidence only; exact typed verification alone determines success. Contract and browser replay tests prove a changed-but-still-open surface does not pass. | Capture the same exact-postcondition behavior on live baggage, seat, and no-seat confirmation modals, then add the compact P1.3 typed diff. |
| P1.5 | Support difficult browser surfaces | `[~]` | Deep queries inspect open shadow roots and same-origin frames. Canonical DOM actions are separate from governed `click_xy`, which requires an observation-bound visual region plus viewport, foreground, hit-test, occlusion, size, opacity, pointer, and risk checks. | Add frame/shadow paths to identity, cross-origin-frame handling, and first-class SVG/canvas region extraction. Seat-map navigation must pass live without requiring perfect seat selection. |
| P1.6 | Add hierarchical planning | `[~]` | Classifier plus verify/plan calls, task queues, and one-action-per-turn behavior provide a partial hierarchy. | Maintain a transaction-level stage plan and create small interaction plans only for the current surface. Avoid two full-page model passes and complete rediscovery on every turn. |
| P1.7 | Add confidence and escalation | `[~]` | Stall handling and user handoff exist. Model fetches have no abort signal/deadline, so an unresponsive request can leave the UI thinking indefinitely. | Add explicit confidence thresholds for surface ownership, semantic classification, target actionability, expected postcondition, and stage exit. Add bounded request timeout/cancellation and a small transient retry budget; low confidence or timeout must stop truthfully before execution. |

### P1 Exit Criteria

- The model receives a compact, internally consistent multimodal observation.
- Screenshot annotations, semantic controls, and executable targets use the same trusted identity.
- Foreground controls cannot inherit unrelated background requirement groups.
- Every turn receives the previous action's typed page diff instead of rediscovering all state.
- Iframes, modals, shadow DOM, virtualized content, and difficult visual surfaces are explicitly represented.
- Unknown pages can use the generic environment before requiring site-specific selectors.
- Failed clicks produce actionable feedback and no-effect actions are not repeated.
- Latency is bounded with explicit request timeout, cancellation, transient retry, and truthful UI status.
- Complex surfaces degrade safely to navigation, decline, wait, or handoff.

## P2 - Build Reusable Checkout Intelligence

| # | Architecture step | Status | Current evidence | Required closure |
| --- | --- | --- | --- | --- |
| P2.1 | Create a reusable skills library | `[ ]` | Existing helpers are mechanics, not audited reusable skills. | Build inspect/fill/select/decline/advance/modal/seat/payment/recovery skills after the P0 contract stabilizes. |
| P2.2 | Add site knowledge packs | `[ ]` | Gotogate remains the proving ground; behavior is mostly generic plus scattered heuristics. | Add declarative hints only after generic P0/P1 behavior is reliable. |
| P2.3 | Build seat handling in layers | `[~]` | The agent has sometimes skipped seats and advanced through confirmation surfaces. | Stabilize Level 1 no-paid-seat navigation first, then semantic DOM/SVG selection, screenshot-assisted selection, and finally canvas coordinates. |
| P2.4 | Add model routing | `[ ]` | Most turns use the same two-call model path. | Route familiar mechanics deterministically, ordinary perception cheaply, difficult reasoning selectively, and unresolved states to handoff. |
| P2.5 | Build replay and regression system | `[~]` | `npm run test:agent` now runs Node contracts and deterministic Playwright API/browser specs through separate explicit entrypoints. The environment-dependent live extension acceptance has its own `test:agent:live` command. Replays cover suspended exact recovery, blocked-operation mismatch, scoped validation, nested-scroll-container recovery, and missing-target failure. | Expand the corpus across live checkout-engine families and fail CI on zero tests or skipped required acceptance scenarios. |
| P2.6 | Measure the correct metrics | `[~]` | Per-turn timings, model spans, token counts, target resolution, mutation, settle, verification, and next-loop delay are logged. | Aggregate success/failure and latency by stage, surface, interaction type, model, and recovery path. |

### P2 Exit Criteria

- New sites primarily require knowledge packs, not rewritten checkout flows.
- Common checkout components use reusable audited skills.
- Paid-seat skipping is reliable and basic seat selection works across several implementations.
- Recorded failures cannot silently regress.
- Model cost and latency are measured and controlled.
- Three structurally different checkout systems reliably reach final review.

## P3 - Complete Real Transactional Booking

Status: `[ ]` Not started. Start only after P0 exits and P0.8 payment authorization exists.

Required deliverables:

- Secure traveler vault and tokenized/payment-provider storage.
- One-time purchase authorization and payment idempotency.
- 3-D Secure user handoff.
- Ambiguous-payment handling without blind retry.
- Confirmation-page verification, PNR/ticket extraction, and confirmation-email reconciliation.
- Duplicate-booking detection plus receipt and fare-condition storage.
- Success evidence must prove correct passengers, itinerary, amount, booking reference/PNR, and ticket status when available.

## P4 - Prepare For iOS

Status: `[ ]` Not started. Do not create a separate iOS agent.

Required shared packages:

```text
booking-kernel | transaction-state | policy | invariants | requirements
skills | observation-schema | action-schema | site-packs
```

Required adapters:

```text
Chrome | Safari Web Extension | iOS native app | Share Extension
```

Safari, shared links, and Fly-controlled web sessions are the practical execution surfaces; arbitrary third-party iOS apps are not assumed controllable.

## P5 - Expand Airline Coverage

Status: `[ ]` Not started. Begin only after the P0-P3 gates and replay corpus pass.

- Expand by checkout-engine family: Amadeus, Sabre, Navitaire, custom airline, and major OTA flows.
- Reuse generic engine -> reusable skill -> site knowledge pack -> custom adapter only when unavoidable.
- Roll out each new family through `observe only -> autofill only -> final review -> authorized purchase`.
- Never enable autonomous purchase immediately on a newly supported site.

## Immediate Implementation Order

This is the current dependency order, grounded in the architecture plan and latest live evidence:

1. **`[~]` Restore the intended authority boundary.** Keep durable obligation ownership, but make the skill own the semantic goal/postcondition rather than the interaction method. Deterministic binding is a fast path; unresolved safe interaction returns to AI/perception recovery before handoff.
2. **`[x]` Preserve prerequisite ownership after suspension.** The first unresolved profile atom remains authoritative while suspended, receives exact atom-scoped model/visual recovery, resumes from verified fresh evidence, and blocks phone or later atoms from bypassing country code.
3. **`[x]` Canonicalize validation evidence.** Validation issues publish control/section/surface ownership, and profile readiness consumes only matching issues or explicit stage-wide blockers.
4. **`[x]` Make P0.7 recovery proof-based for the current profile gate.** Scroll the nearest effective container, reobserve, rebind the same logical owner, and reject disappeared or still-hidden targets instead of defaulting to success.
5. **`[x]` Finish generic operation-capability production for the current profile gate.** Canonical controls now separate state from proven open actuators, discover split/icon/pointer members generically, and publish bounded non-executable visual recovery regions when no DOM actuator is proven.
6. **`[x]` Repair the P2.5 standard test entrypoint.** Node contracts run under `node --test`, deterministic Playwright API/browser specs are explicitly listed, `npm run test:agent` intentionally runs both, and the environment-dependent demo acceptance stays separate under `test:agent:live`.
7. **`[ ]` Bring the required P1 perception slice before live acceptance.** Ensure ambiguous controls expose semantic context, accessibility relationships, screenshot refs/regions, and useful action feedback to the recovery planner instead of requiring perfect deterministic operation discovery.
8. **`[~]` Add a faithful generic ambiguity-recovery replay.** Carry a custom dropdown from semantic goal through observation, AI/deterministic proposal, `normalizeAction`, governor approval, extension validation, click dispatch, options-surface verification, choice, and final normalized-value verification. The fixture must not depend on a conventional semantic button.
9. **`[ ]` Unify the `VisualRegion` schema and predicates.** Preserve or derive centers consistently, keep control/operation/observation/surface binding, and make the governor and every executor consume the same equality, containment, viewport, occlusion, and hit-test rules.
10. **`[ ]` Count attempts from browser truth.** A proposal or governor approval is not an executed attempt. Only a browser-dispatched action may consume an actuator/recovery attempt; pre-dispatch rejection must remain retryable after fresh evidence.
11. **`[ ]` Pass repeated live blank-profile acceptance.** Capture one stable session, correct country/local phone/title/names/DOB, zero scoped errors, no early dependent actions, exact verification, and ledger evidence.
12. **Close the P0.9/P0.10/P0.11 complex-surface pass with live proof.** Re-run baggage, cancellation, confirmation, and multi-leg seat failures only after the blank profile passes.
13. **Add P1.3 typed observation diff.** Store obligation/control appeared, resolved, moved, lost, enabled, disabled, modal, price, stage, and URL changes with the action result.
14. **Bound P1.2/P1.7 cost and latency.** Enforce observation/token budgets and request timeout/cancellation with truthful handoff.
15. **Continue P1/P2/P3 in roadmap order** after the execution-continuity gate passes; do not add site-specific fallbacks first.

Do not prioritize site-specific seat selectors, more fallback click rules, or screenshot annotations over the semantic-state and actionability work above.

## Acceptance Scenarios For The Current Pass

The next P0/P1 pass is not complete until these replay/live scenarios pass:

1. Starting mid-checkout adopts already-selected dropdown/radio state without reopening it.
2. Flexible ticket, cancellation, baggage, and seats cannot share or satisfy each other's decision groups.
3. Entering `seats` removes traveler-only optional requirements from the active planning set.
4. A seat modal heading remains surface context and never becomes a requirement.
5. `no paid seats` resolves the policy choice but retains the interface obligation to advance safely.
6. `Next` on `Flight 1 of 4` verifies only after observing `Flight 2 of 4`, a confirmation surface, modal closure, or another explicitly allowed postcondition.
7. A 3x3 helper node cannot be selected as an actuator.
8. An unchanged foreground surface cannot produce `REQUIREMENT_EVIDENCE_VERIFIED`.
9. A seat observation remains within the defined control/token budget while preserving the active surface, safe navigation, policy-relevant choices, and progress marker.
10. Planner/network timeout produces a bounded retry or truthful handoff instead of indefinite `Thinking`.
11. A live custom combobox exposes separate canonical state and `open` actuators; opening it observes the exact options surface, choosing the desired option verifies normalized value, and already-satisfied plain fields are not retyped.
12. Canonical state, material observation hash, skill preconditions, and verifier agree on boolean attributes such as `expanded=false`.
13. One `Start agent` lifecycle retains one non-empty transaction ID across every observation, action, failure result, bounded retry, and terminal state; no turn silently creates a replacement transaction.
14. If a required profile atom suspends, dependent atoms such as local phone and all later checkout work remain blocked until that exact prerequisite is recovered, satisfied, or truthfully handed to the user.
15. An editable combobox can publish both a query-typing capability and dropdown open/choose capabilities; the selected transaction value is complete only after the desired normalized option is committed and verified.
16. A validation issue is linked to its canonical control, section, and surface; an unrelated baggage/extras issue cannot block or satisfy profile work.
17. A suspended required atom resumes automatically when its operation becomes available, with zero model calls between deterministic atoms.
18. An offscreen target inside a modal or nested panel scrolls that container rather than the document viewport.
19. Recovery succeeds only after the same logical control is freshly observed and actionable; disappearance or ambiguity returns typed identity loss.
20. A suspended owned atom may not emit repeated `wait` actions against an unchanged observation. It must execute an allowed recovery, gather materially new evidence, escalate, or hand off within a finite budget.

## Do Not Do Now

- Do not build a manual API wrapper for every airline.
- Do not add extension-side autonomous click shortcuts or multiple independent planning agents.
- Do not build the native iOS app before the shared booking kernel is stable.
- Do not attempt perfect seat selection before reliable paid-seat skipping.
- Do not optimize model cost before measuring reliability, but do remove pathological observation duplication that prevents reliable operation.
- Do not let the model execute arbitrary JavaScript.
- Do not treat either screenshots or the DOM map as the sole page representation.

## Decisions We Are Keeping

- The backend AI remains the only planning brain.
- The extension observes, validates, executes atomic mechanics, and verifies; it does not invent checkout actions.
- Deterministic code controls safety, identity, lifecycle, evidence, authorization, and ledger truth.
- Models interpret ambiguous current state and propose actions within the deterministic contract.
- Current foreground observation outranks stale task memory and prior model claims.
- No real payment or final purchase occurs before P0.8.
- New airlines wait until the P0/P1 acceptance scenarios and replay corpus are stable.
