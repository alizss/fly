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

These functions must stop directly clicking:

* `settleAndHandleInterrupts()`
* `handleRoutineExtraOverlay()`
* `skipOptionalExtraSurface()`
* `skipNoExtraDropdownChoice()`
* `autoResolveNoExtrasSection()`
* `clickContinueGate()`

They can remain as detectors or action proposers, but they must return a normalized action.

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

## P0 exit criteria

P0 is complete only when:

* Every interaction is traceable
* No local helper acts independently
* One store owns transaction state
* Stale actions cannot execute
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

Start in this exact order:

1. Remove autonomous local clicks.
2. Add unified transaction IDs, observation IDs and action IDs.
3. Consolidate session state.
4. Add the action governor and transaction invariants.
5. Separate skills from atomic actions.
6. Add stale-target validation.
7. Add the compressed page representation.
8. Add annotated screenshots.
9. Add the page-diff engine.
10. Add richer execution feedback.
11. Build reusable skills.
12. Add site knowledge packs.
13. Build the regression corpus.
14. Complete payment authorization and confirmation verification.
15. Port the shared engine to Safari and iOS.

The central architecture is:

> **AI understands, plans and recovers.
> Deterministic infrastructure controls, executes and verifies.
> The transaction ledger remembers the truth.**
