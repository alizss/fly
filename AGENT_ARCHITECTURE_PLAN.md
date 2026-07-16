# Final Fly engineering roadmap

Your current foundation is usable. Do **not** rewrite it. Refactor it into one governed agent system, then improve its perception and generalization. The existing architecture already has the right loop, page map, screenshots, normalized actions, requirements, policy and traces. 

The order matters. Do not jump to seat-map vision, more airlines or iOS before P0 is complete.

---

# Scope freeze before P0

For the first reliable vertical slice, support only:

* One adult
* Economy
* One-way or return
* Guest checkout
* No loyalty points redemption
* No infants, pets or special assistance
* No complex multi-city trips
* Skip paid seats by default
* Baggage based on a predefined user policy
* Stop before payment until payment safety is complete

Select three structurally different checkout systems:

1. A normal full-service airline
2. A low-cost airline with aggressive upsells
3. An OTA or airline using a very different JavaScript checkout

Do not add more sites until these work reliably.

---

# P0 — Fix control, state and transaction safety

**Objective:** one brain, one executor, one transaction ledger.

This is the most important phase.

## P0.1 Remove extension-side autonomous actions

The original split-brain implementation included these direct actors:

* `settleAndHandleInterrupts()`
* `handleRoutineExtraOverlay()`
* `skipOptionalExtraSurface()`
* `skipNoExtraDropdownChoice()`
* `autoResolveNoExtrasSection()`
* `clickContinueGate()`

Those actor paths have now been removed from the live extension. Future helpers may exist only as detectors, mechanical skill steps, or action proposers; they must never authorize or discover a mutating target outside the canonical governed action.

Wrong:

```js
await clickElement(option);
```

Correct:

```js
return {
  type: "select",
  targetId: option.id,
  reason: "User policy rejects paid baggage",
  requirementId: "baggage_decision"
};
```

Every action then goes through:

```text
Propose
→ policy
→ invariants
→ execute
→ verify
→ record
```

### Acceptance criterion

There must never again be a page-changing action with:

```text
clientTurnId: ""
```

Every action needs:

* `transactionId`
* `turnId`
* `observationId`
* `actionId`

---

## P0.2 Create one authoritative transaction store

Remove the split between:

* `session-store.js`
* Shared agent state
* Old in-memory `agentSessions` in `server.js`

Create one durable booking transaction.

Suggested file:

```text
apps/web/agent/transaction-store.js
```

The transaction should contain:

```js
{
  transactionId,
  status,
  userIntent,
  itineraryFingerprint,
  offerSnapshot,
  travelerIds,
  requirements,
  currentStage,
  currentObservationId,
  actionLedger,
  priceHistory,
  approvalState,
  paymentState,
  confirmationState
}
```

SQLite is enough initially. Do not depend on memory.

---

## P0.3 Introduce immutable observations

Every page observation gets an ID and hash.

```js
{
  observationId: "obs_123",
  createdAt,
  pageUrl,
  pageMap,
  screenshotRef,
  snapshotHash
}
```

Every proposed action must reference the observation it was created from.

Before execution:

```text
Has the page materially changed since observation obs_123?
```

If yes:

```text
Reject action
→ observe again
→ replan
```

This prevents stale clicks after rerenders and surprise popups.

The authority hash is intentionally narrower than the diagnostic page diff. It
contains the route/stage, foreground ownership, canonical control state,
control-scoped validation status, decision-group state, graph integrity,
transaction fingerprints, and price. Raw validation prose, raw page text,
bounding boxes, scrolling, and layout are diagnostic evidence rather than
execution identity. Changing error wording alone is not material; a canonical
control entering or leaving an invalid state is material.

When a material change makes a governed skill atom stale before execution:

```text
Reject the old action without executing it
→ persist the unexecuted stale result
→ capture a fresh immutable observation
→ preserve the logical skill atom
→ bind it to the fresh canonical control
→ govern and issue a new action ID
```

Fresh rebinding succeeds only when the same logical obligation resolves to one
unambiguous current canonical control and executable operation. A missing
control or actuator is a typed recovery failure; absence never counts as
recovered, visible, or complete.

An executed action that fails its exact postcondition is not automatically
retried by this rule; it remains an ambiguity/failure for the planner.

---

## P0.4 Separate skills from atomic actions

Atomic actions:

```text
click
click_xy
type
select
scroll
keypress
wait
```

Skills:

```text
fill_passenger_form
resolve_baggage
skip_optional_extra
handle_seat_selection
complete_contact_section
```

A skill must expand into observable atomic actions.

The expansion is a persisted plan, not a one-shot conversion:

```text
Create skill plan
→ persist logical atoms
→ bind one atom to the fresh canonical observation
→ govern and execute it
→ verify its exact postcondition
→ mark that atom complete
→ bind the next atom from the next observation
→ return to AI after completion or ambiguity
```

The skill owns the semantic obligation and postcondition, not the website's
interaction method.

Example:

```js
{
  skill: "select_profile_value",
  semanticType: "phone_country_code",
  desiredValue: "+386",
  postcondition: {
    type: "normalized_value_changed",
    expectedValue: "+386"
  }
}
```

The skill may use a native select, combobox typing, a sibling arrow, keyboard
interaction, an accessibility target, or a screenshot-grounded click. Those
are observation-time execution strategies, not separate country-code or
airline skills.

Skill atoms retain semantic field/decision identity, but never retain a stale
DOM target as execution authority. Every atom receives its own observation ID,
action ID, canonical control binding, expected outcome, governor decision,
ledger events, and verification result. A failed or missing exact result
suspends the current atom without releasing ownership of its unresolved
prerequisite. That prerequisite remains authoritative until fresh canonical
evidence proves it satisfied, a bounded typed recovery reissues it, or the
transaction truthfully hands control to the user. General model planning may
interpret or recover the suspended atom, but dependent atoms and later checkout
stages may not bypass it.

Skill ownership is deterministic. When the current observation contains
unresolved profile-mappable controls and the selected traveler has the required
values, the transaction orchestrator must create or resume the required profile
skill, including a persisted suspended skill whose prerequisite remains
unresolved, before general model planning. The model may help classify an
unknown field, but it must not be responsible for opting into the skill one
field at a time.

The skill must consume the canonical control's normalized current value and
state. It must not maintain a second field-satisfaction implementation. A field
that the current observation already proves equal to the desired profile value
is satisfied; it is not retyped merely because the skill cannot interpret the
raw DOM value itself.

Do not let `fill_visible_profile_fields` silently change twelve controls and return one vague result.

Each atomic action needs:

* Preconditions
* Execution result
* Expected outcome
* Verification result

---

## P0.5 Add transaction invariants

Create:

```text
apps/web/agent/invariants.js
```

Check continuously:

* Itinerary did not change
* Dates did not change
* Airports did not change
* Traveler set did not change
* Currency did not change
* Price remains within approved limits
* No unapproved paid extras are selected
* Required baggage is satisfied
* No unresolved validation errors exist
* Payment has not already been attempted

The model may explain changes. It cannot override invariants.

A visible validation error keeps the transaction in the control's current
stage. Baggage, extras, seats, and navigation cannot begin merely because no
profile skill happened to be active in memory.

---

## P0.6 Add a central action governor

Create:

```text
apps/web/agent/action-governor.js
```

Every AI or deterministic proposal passes through it.

```text
Proposed action
→ schema validation
→ stale-observation check
→ target validation
→ policy check
→ invariant check
→ approval check
→ allowed or blocked
```

No code path may bypass this component.

---

## P0.7 Strengthen target validation

Every target needs a fingerprint:

```js
{
  targetId,
  role,
  text,
  ariaLabel,
  boundingBox,
  frameId,
  domFingerprint,
  nearbyText,
  activeSurfaceId
}
```

Before clicking, confirm:

* Element still exists
* It is visible
* It is not covered
* Text and role still match
* It remains inside the expected modal or section
* Bounding box has not materially moved

If confidence is low, reobserve. Do not fuzzy-click another “Continue.”

A known canonical target that is outside the current viewport is recoverable,
not automatically a user handoff. Preserve the logical pending action, issue a
governed non-mutating scroll/reobserve step, and bind the action again to the
fresh observation. Ask the user only when the target cannot be brought into a
valid actionable viewport or the refreshed identity becomes ambiguous.

Viewport recovery must scroll the canonical target's nearest effective
scrollable ancestor, using the document viewport only when no inner scroll
owner exists. Each attempt is bounded and followed by a fresh observation.
Recovery succeeds only when the fresh registry contains the same unambiguous
logical control and operation actuator, and that actuator is visible,
intersecting the actionable viewport, unobscured, and hit-testable. If the
control disappears, the scroll owner cannot move farther, or the refreshed
binding is ambiguous, return a typed recovery failure. Never default a missing
target to in-view.

---

## P0.8 Create a proper payment authorization object

Do not use:

```js
paymentApproved: true
```

Use a one-time authorization bound to:

* Transaction
* Exact itinerary fingerprint
* Exact travelers
* Maximum amount
* Currency
* Fare brand
* Approved extras
* Expiration
* Single-use status

Payment submission must refuse when any bound property changed.

Also create explicit payment states:

```text
NOT_STARTED
AUTHORIZED
SUBMISSION_STARTED
SUBMISSION_RESULT_UNKNOWN
SUCCEEDED
FAILED
```

Never automatically retry from `SUBMISSION_RESULT_UNKNOWN`.

---

## P0.9 Create one canonical logical control graph

Each observation must create exactly one control registry. Every semantic model,
screenshot annotation, accessibility node, planner target, executor target, and
verification result must reference records from that registry rather than
reconstructing identity independently.

A logical control owns:

```js
{
  controlId,
  decisionGroupId,
  stateElementId,
  operations: {
    open: { actuatorId, precondition, expectedOutcome },
    choose: { actuatorIds, precondition, expectedOutcome },
    type: { actuatorId, precondition, expectedOutcome },
    select: { actuatorId, precondition, expectedOutcome }
  },
  actuators,
  semantic,
  risk,
  state: {
    checked,
    selected,
    disabled,
    expanded,
    valuePresent,
    normalizedValue
  },
  validation: {
    status: "valid | invalid | unknown",
    issueIds: []
  },
  scrollContext: {
    ownerId,
    axis,
    canScrollBackward,
    canScrollForward
  },
  scope
}
```

Rules:

* Geometry is observation evidence, not semantic identity.
* Foreground ownership outranks background ownership.
* DOM/ARIA strings are normalized once at the observation boundary. For
  example, `aria-expanded="false"` is canonical `false`, never truthy because it
  is a non-empty string.
* The observation hash, skill preconditions, governor, executor, and verifier
  consume the same normalized control state; none may rebuild a different
  boolean or selected-value interpretation.
* Reading state and actuating an operation are separate capabilities. A
  combobox text input may expose value state while a sibling button or wrapper
  owns `open`; clicking the state element is forbidden unless the registry
  explicitly proves it is also the `open` actuator.
* If an operation has no unambiguous deterministic actuator, the deterministic
  fast path is unavailable. Preserve the semantic obligation and invoke bounded
  ambiguity recovery using current accessibility, browser hit-target, and
  screenshot evidence. Reobserve or hand off only after those governed
  strategies are unavailable or fail within budget. Never substitute an
  ungrounded generic click.
* Two incompatible controls may never share a state node or actuator.
* Broad containers containing sibling actions are context, never shared actuators.
* Hidden, tiny, clipped, covered, or pointer-inert helper nodes are not actionable controls.
* `type` and `select` must resolve a compatible current canonical control.
  Ordinary DOM `click` should resolve a current canonical control or registered
  actuator. A governed browser/coordinate fallback may instead resolve an
  observation-scoped visual target or region when deterministic control binding
  is incomplete. Visible text alone is never execution authority.
* Every observation publishes one canonical alias index: `controlId`, `stateElementId`, `preferredActivationElementId`, every label/wrapper/activation actuator node ID, and `visualRef` all map to the same `controlId`.
* An alias owned by incompatible controls is removed from the executable index and invalidates governed execution; no layer chooses the first match.
* Planner binding, the action governor, browser execution, and requirement evidence consume this alias index instead of independently scanning controls.
* Every validation issue is a typed observation record with `issueId`,
  `semanticType`, `stage`, and the narrowest known `controlId`, `sectionId`,
  and `surfaceId`. Consumers may block only matching obligations or an
  explicitly typed stage-wide blocker. Unscoped visible prose is diagnostic
  and may trigger reobservation, but it may not be treated as a profile,
  baggage, seat, or payment error by default.
* Scroll-container ancestry is observation evidence attached to the canonical
  control. It determines mechanical recovery, but it does not become semantic
  identity.

---

### P0/P1 bridge: bounded ambiguity recovery

This is the current root implementation gate.

The canonical graph is shared identity and evidence. It is not a requirement
that deterministic code perfectly understand every custom widget before the
agent may act.

Use this loop:

```text
Persist semantic obligation and desired postcondition
→ try deterministic canonical binding
→ if unavailable, collect current ambiguity evidence
→ let AI choose one grounded atomic action
→ govern freshness, surface, region, risk, policy and invariants
→ execute through the browser adapter
→ observe again
→ verify the semantic postcondition
→ continue, try a different bounded strategy, or hand off
```

The ambiguity evidence packet must include:

```js
{
  observationId,
  semanticGoal,
  desiredValue,
  canonicalControlId,       // optional when identity is incomplete
  accessibilityCandidates,
  browserHitTargets,
  screenshotTargets,
  boundedVisualRegions,
  activeSurface,
  failedExecutedAttempts,
  expectedPostcondition,
  risk
}
```

Rules:

* Deterministic binding is the preferred fast path, not the only allowed path.
* AI chooses among targets and regions supplied by the current observation. It
  never invents page coordinates or executes arbitrary JavaScript.
* The governor validates observation freshness, foreground ownership, target or
  region bounds, occlusion/actionability, policy, invariants, approvals, and
  expected outcome.
* The governor does not require deterministic code to have already classified
  the exact custom-widget implementation when the current grounded evidence is
  otherwise safe.
* A proposal, governor approval, or pre-dispatch validation rejection is not an
  executed attempt. Only browser dispatch consumes an attempt.
* Every failed dispatched action returns typed browser and page-diff evidence.
  The next recovery must use new evidence or a different candidate.
* Low-confidence, high-risk, exhausted, or repeatedly ineffective recovery
  hands control to the user truthfully.

Required first acceptance replay:

```text
Goal: phone country code becomes +386
→ deterministic opener unavailable
→ current screenshot/accessibility/browser evidence identifies the arrow region
→ one governed atomic click opens the options surface
→ current options identify Slovenia / +386
→ one governed atomic choice commits it
→ fresh canonical state verifies +386
→ profile skill continues to local phone and remaining fields
```

The replay must run the real producer, action normalization, AI/deterministic
proposal boundary, governor, browser executor, result reporting, fresh
observation, and verifier. Backend-only or producer-only fixtures are
insufficient.

This bridge must pass before repeated blank-profile live acceptance. It is not a
site-specific skill, selector patch, or separate airline workflow.

---

## P0.10 Create canonical decision groups

Every logical choice belongs to one observed decision group. The group, not an
individual alternative or a model-generated label, is the unit of requirement
state.

```js
{
  decisionGroupId,
  scope: { stage, surfaceId, sectionId, instanceId },
  alternatives,
  selectedControlId,
  status,
  evidenceObservationId
}
```

A choice-like requirement without a current canonical decision group is
`conflicted`, never satisfied by text, section summaries, task hints, or evidence
from another group.

---

## P0.11 Create one requirement lifecycle

Persistent transaction facts and current interface obligations must share one
typed lifecycle without being confused with each other.

```js
{
  requirementId,
  semanticType,
  scope: { stage, surfaceId, decisionGroupId, instanceId },
  desiredDisposition,
  lifecycleStatus,
  interfaceStatus,
  evidence,
  createdObservationId,
  lastObservedObservationId,
  resolvedObservationId
}
```

Only typed evidence from the current observation may change completion state.
Legacy satisfied-ID lists, broad section status, task queues, click dispatch,
and generic DOM mutation are not completion evidence. The lifecycle must
eventually live in the P0.2 transaction store and be governed at the P0.6 boundary.

Required continuity rules:

1. A required obligation remains active or blocked when its skill atom
   suspends. Skill execution status does not determine requirement truth.
2. Validation evidence may block or reopen only the requirement whose canonical
   scope it matches, or an explicitly typed stage-wide requirement.
3. Recovery dispatch, scrolling, DOM mutation, and disappearance of an
   executor target are not satisfaction evidence. Only the expected scoped
   postcondition in a fresh observation may resolve the obligation.

### P0 root gate: canonical blocked-obligation continuity

The recurring stale-target, anonymous-validation, and failed-scroll loops are
one architecture problem. Every unresolved condition that can block progress
must be a persisted canonical obligation:

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

Rules:

* Prose explains; it never controls execution.
* A required obligation keeps transaction ownership while blocked or recovering.
* Every fresh observation reevaluates the obligation against its canonical scope.
* Recovery succeeds only when the same logical owner exists and its resolution predicate is true.
* Missing or ambiguous identity is a typed failure, never success.
* Only `resolved` or explicit `handed_off` releases dependent work.

This is a cross-cutting P0 gate implemented through P0.3, P0.4, P0.5, P0.7,
P0.9, and P0.11. It is not a new site skill and does not receive a separate P
number.

---

## P0 exit criteria

P0 is complete only when:

* Every interaction is traceable
* No local helper acts independently
* One store owns transaction state
* Stale actions cannot execute
* All mutating targets resolve through the current canonical control graph
* Choice completion is derived from a current canonical decision group
* Requirement state changes only from typed current-observation evidence
* Suspended required work cannot be bypassed by general planning or later-stage actions
* Validation blockers are canonical and scope-matched rather than global page strings
* Recovery succeeds only from a fresh actionable canonical binding
* Every action has a verified result
* Price and itinerary changes are caught
* Payment cannot be duplicated
* A transaction can be reconstructed from the ledger

---

# P1 — Build the agent environment properly

**Objective:** give the model better eyes, memory and feedback.

This is where the video is most relevant.

## P1.1 Build a unified observation packet

Send three complementary representations.

The minimum P1.1 slice required by the P0/P1 ambiguity bridge must be completed
before blank-profile live acceptance: accessibility candidates, annotated
screenshot targets/regions, active-surface ownership, and browser hit-target
feedback for the currently blocked semantic obligation.

### A. Semantic checkout model

Your existing:

* Fields
* Buttons
* Sections
* Requirements
* Prices
* Errors
* Active surfaces

### B. Generic interaction graph

Add:

* DOM role
* Accessibility role
* Visible text
* ARIA label
* Bounding box
* Enabled/disabled
* Selected state
* Frame identity
* Shadow-root identity
* Parent-child relationships
* Nearby labels

### C. Annotated screenshot

Overlay stable element IDs:

```text
[B12] Continue
[F4] First name
[O7] No checked baggage
[R2] Seat map
```

The model reasons visually but returns target IDs.

---

## P1.2 Add compressed whole-page representation

Generate model-friendly Markdown:

```text
[Page] Passenger information

[Section S1] Passenger 1
  [Input F1] First name — required — empty
  [Input F2] Last name — required — empty
  [Select F3] Nationality — required

[Modal M1] Select baggage
  [Option O1] No checked bag — €0
  [Option O2] One checked bag — €35

[Button B1] Continue
```

Do not send raw 20,000-token DOM dumps.

Also do not overcompress until critical controls disappear.

---

## P1.3 Build the page-diff engine

Create:

```text
apps/web/agent/observation-diff.js
```

Compare observation N against N+1.

Return:

```js
{
  appeared,
  disappeared,
  changed,
  becameEnabled,
  becameDisabled,
  modalOpened,
  modalClosed,
  errorsAppeared,
  priceChanged,
  stageChanged,
  urlChanged,
  targetReacted
}
```

This is one of the highest-value improvements from the video.

The model should not repeatedly rediscover the entire page. Tell it exactly what changed.

---

## P1.4 Improve action feedback

Replace vague results like:

```text
Click dispatched
```

with:

```js
{
  targetFound: true,
  targetVisible: true,
  dispatchSucceeded: true,
  domChanged: true,
  visualChanged: true,
  navigationOccurred: false,
  overlayAppeared: true,
  validationAppeared: false,
  priceChanged: false
}
```

Dispatch success is not outcome success.

Generic DOM or overlay progress is evidence only. It must never override the
typed postcondition. For example, `active_surface_dismissed` succeeds only when
that surface is actually gone or the explicitly allowed transition is observed.

---

## P1.5 Support difficult browser surfaces

Add explicit support for:

* Nested iframes
* Shadow DOM
* Custom dropdowns
* Sticky overlays
* Lazy-loaded content
* SVG controls
* Canvas controls
* Virtualized lists
* Payment-provider frames

Use this fallback sequence:

```text
Semantic DOM target
→ accessibility target
→ browser-level mouse/keyboard interaction
→ visual coordinate interaction
→ user intervention
```

Coordinates are a fallback, not the default.

---

## P1.6 Add hierarchical planning

Use:

```text
Plan long
→ execute short
```

The model can maintain:

```text
Complete passenger data
Resolve baggage
Resolve seats
Reject unwanted extras
Reach final review
```

But execution happens in small safe chunks.

Replan after:

* Navigation
* Modal appearance
* Price change
* Validation error
* Unexpected state
* Failed action

---

## P1.7 Add confidence and escalation

Every understanding and proposed action should carry confidence.

Example:

```text
High confidence
→ execute through normal governor

Medium confidence
→ gather more DOM/visual evidence

Low confidence
→ use stronger model or request user action
```

Do not let low-confidence actions become speculative clicks.

---

## P1 exit criteria

* Agent sees the whole page compactly
* Agent can visually ground targets
* Agent receives explicit page changes
* Iframes, modals and shadow DOM are represented
* Failed clicks produce actionable feedback
* Unknown pages do not immediately require site-specific selectors
* The agent stops repeating actions that had no effect

---

# P2 — Build reusable checkout intelligence

**Objective:** generalize across airlines without building a complete script per airline.

## P2.1 Create a reusable skills library

Build these first:

```text
fill_passenger_details
fill_contact_details
select_custom_dropdown
resolve_baggage
skip_paid_extra
dismiss_optional_modal
handle_calendar
handle_seat_selection
skip_seat_selection
read_checkout_summary
detect_price_change
complete_payment_form
handle_3ds_handoff
verify_booking_confirmation
```

Skills use the generic observation and action system.

They should not be airline-specific unless unavoidable.

---

## P2.2 Add site knowledge packs

Each supported site gets declarative context:

```js
{
  domains,
  checkoutEngine,
  knownPageSignatures,
  terminologyAliases,
  stableSelectors,
  knownOverlays,
  knownUpsells,
  seatMapType,
  priceLocations,
  confirmationPatterns,
  knownFailureModes
}
```

The hierarchy:

```text
Generic engine
→ reusable skill
→ site knowledge pack
→ custom packaged adapter only when necessary
```

Do not build full independent airline workflows.

---

## P2.3 Build seat handling in layers

Do not begin with “perfectly choose every airplane seat.”

Implement:

### Level 1

Skip optional paid seat selection.

### Level 2

Select a seat from semantic DOM or accessible SVG.

### Level 3

Use DOM structure plus screenshot reasoning.

### Level 4

Use coordinate interaction for canvas-rendered maps.

Always verify:

* Seat number
* Seat price
* Passenger assignment
* Booking summary change

---

## P2.4 Add model routing

Use:

* Deterministic skills for familiar forms
* Cheap multimodal model for ordinary unknown pages
* Stronger reasoning model after uncertainty or repeated failure
* User handoff for unresolved high-risk states

Do not use the strongest model on every action.

---

## P2.5 Build the replay and regression system

Every failure becomes a permanent test.

Store redacted:

* Observation
* Screenshot
* Interaction graph
* Page diff
* Proposed action
* Actual result
* Correct action

Run every code or prompt change against this corpus.

The repository's documented test commands must collect the intended suites
without cross-runner contamination. Node contract tests run under `node --test`;
Playwright collects only browser specs through explicit `testMatch` or dedicated
test directories. The standard combined verification command must fail when a
suite is miscollected, skipped unexpectedly, or reports zero intended tests.

Replay the real producer and executor, not only hand-constructed backend
objects. At minimum, cover canonical registry ownership, sibling actuator
separation, layout movement, tiny helper rejection, target resolution, governed
execution, and exact postcondition verification.

Add mutation tests:

* Button label changes
* New banner appears
* Modal inserted
* CSS classes change
* Price format changes
* Element moves
* Language changes

---

## P2.6 Measure the correct metrics

Track:

* Page-stage classification accuracy
* Target-resolution success
* Action outcome success
* Recovery success
* Repeated-action rate
* User-intervention rate
* Price-invariant violations
* Wrong-extra rate
* Completion by checkout stage
* New-site setup effort

Do not only track “booking succeeded.” That hides where the system is failing.

---

## P2 exit criteria

* New sites mostly require a knowledge pack, not a rewritten flow
* Common checkout components are reusable skills
* Seat skipping works reliably
* Basic seat selection works on several different implementations
* Recorded failures cannot regress silently
* Model cost and latency are controlled
* Three structurally different checkouts reach final review reliably

---

# P3 — Complete real transactional booking

**Objective:** safely move from final review to confirmed booking.

Implement:

* Secure traveler vault
* Payment-provider or tokenized payment storage
* One-time purchase authorization
* Payment idempotency
* 3-D Secure user handoff
* Ambiguous-payment handling
* Confirmation-page verification
* PNR and ticket-number extraction
* Confirmation email reconciliation
* Duplicate-booking detection
* Receipt and fare-condition storage

A booking is successful only when Fly has evidence:

```text
Correct passengers
Correct itinerary
Correct amount
PNR or booking reference
Ticket status when available
```

A successful click on “Pay” is not a confirmed booking.

---

# P4 — Prepare for iOS

Do not build a separate iOS agent.

First extract shared packages:

```text
booking-kernel
transaction-state
policy
invariants
requirements
skills
observation-schema
action-schema
site-packs
```

Then build platform adapters:

```text
Chrome adapter
Safari Web Extension adapter
iOS native app adapter
Share Extension adapter
```

The iOS experience becomes:

```text
User shares or opens flight
→ Fly creates booking intent
→ Safari/API/browser execution
→ Fly requests only necessary approval
→ booking confirmed in native app
```

You cannot reliably control arbitrary third-party iOS apps. Safari, shared links and Fly-controlled web sessions are the practical execution surfaces.

---

# P5 — Expand airline coverage

Only after P0–P3 work.

Add airlines by checkout-engine family, not randomly:

* Amadeus-powered flows
* Sabre-powered flows
* Navitaire low-cost flows
* Custom airline flows
* Major OTA flows

Airlines sharing infrastructure often reuse interaction patterns. Build knowledge around those families.

Roll out in modes:

```text
Observe only
→ autofill only
→ navigate to final review
→ purchase with user authorization
```

Do not enable autonomous purchase on a newly supported site immediately.

---

# Do not do these things now

* Do not build an API wrapper manually for every airline
* Do not add more extension-side auto-click shortcuts
* Do not create multiple independent AI agents
* Do not build the native iOS app before the booking kernel works
* Do not attempt perfect seat selection first
* Do not optimize model cost before measuring reliability
* Do not let the model execute arbitrary JavaScript
* Do not treat a screenshot as the only page representation
* Do not treat the DOM map as the only page representation

# Immediate implementation order

The historical foundation order remains valid. From the current codebase
position, continue in this exact order:

1. Keep the completed P0 foundation: one durable transaction, immutable observations, one governor, policy/invariants, atomic execution, exact verification, and prerequisite continuity.
2. Implement the P0/P1 bounded ambiguity-recovery bridge. Skills own semantic goals/postconditions; deterministic binding is a fast path; AI/perception chooses one grounded fallback action when binding is incomplete.
3. Complete the minimum P1.1/P1.4 evidence required by that bridge: accessibility candidates, annotated screenshot targets/regions, browser hit-target feedback, active-surface ownership, and typed action results.
4. Unify the visual-target/region schema and validation predicates across observation, action normalization, governor, browser executor, and verifier.
5. Count recovery attempts only from browser-dispatched actions and retain pre-dispatch rejections as retryable evidence.
6. Add the faithful end-to-end custom-dropdown ambiguity replay, including open, choose, and final normalized-value verification.
7. Pass repeated blank-profile live acceptance with zero early dependent actions or validation errors.
8. Re-run baggage, cancellation, confirmation, and multi-leg seat transitions using the same generic recovery loop.
9. Continue P1 compression and typed diffing, then P2 reusable skills/site packs, payment authorization, and platform expansion in roadmap order.

The central architecture is:

> **AI understands, plans and recovers.
> Deterministic infrastructure controls, executes and verifies.
> The transaction ledger remembers the truth.**
