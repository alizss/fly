# Fly Goal and Execution TODO

**Last verified:** 2026-07-20
**Current branch snapshot:** `041a8a7` on `dev` plus the uncommitted authoritative `TaskState` consolidation
**Detailed current-code handoff:** [`CURRENT_CODEBASE_ENGINEERING_HANDOFF.md`](./CURRENT_CODEBASE_ENGINEERING_HANDOFF.md)
**Architecture plan:** [`AGENT_ARCHITECTURE_PLAN.md`](./AGENT_ARCHITECTURE_PLAN.md)
**Evidence tracker:** [`P_AGENT_ARCHITECTURE_TRACKER.md`](./P_AGENT_ARCHITECTURE_TRACKER.md)
**Current product roadmap:** [`FLY_PRODUCT_ROADMAP.md`](./FLY_PRODUCT_ROADMAP.md)

This is the simple ordered execution list. The architecture plan explains the intended system, the handoff explains the current code, and the evidence tracker records what has actually passed.

---

## 1. Goal

Fly should complete most airline and OTA checkouts from an already-selected flight to payment review using the user's saved profile, context, and booking rules.

Target experience:

```text
User selects a flight
→ starts Fly
→ Fly handles the checkout and its surprises
→ user reaches payment review in roughly 1–3 meaningful interactions
```

Fly must work from current page evidence. It must not depend on hardcoded step-by-step procedures for each airline.

---

## 2. Long-Term Vision

Build one reusable transaction agent kernel that can later power:

- the current Chrome extension,
- other browsers and web surfaces,
- an iOS application,
- richer traveler rules and preferences,
- and, only after explicit authorization and safety work, payment and final booking.

Different clients may observe and operate their environment differently. They should share the same semantic goals, policy, action lifecycle, verification, safety rules, and transaction ledger.

---

## 3. Non-Negotiable Principles

- Fix shared points of failure, not one page or button.
- Prefer the smallest reusable correction that removes a whole class of failures.
- Observe the current page; do not predict a fixed airline flow.
- AI interprets ambiguity between grounded current options. It does not invent selectors or actions.
- The browser executor is mechanical: click, type, select, keypress, or scroll.
- Every meaningful action is followed by fresh observation.
- Success means the semantic outcome is observed, not merely that a click occurred.
- Required or explicitly requested decisions create work; untouched optional controls do not.
- Site knowledge may add evidence or hints, never own correctness.
- Never select an unintended paid extra, change the itinerary, accept legal terms, or submit payment without explicit authority.
- Keep one owner for semantic state, current surface, pending action, recovery, and handoff.
- Do not add complexity unless a failing replay or live trace proves the need.

---

## 4. Current Release Boundary

The current release should:

- fill and verify traveler/contact information,
- apply saved baggage, seat, and extra policies,
- handle custom controls, scrolling, rerenders, popups, portals, and intermediate pages,
- finish one-way or return guest checkout for one adult,
- reach payment review,
- stop safely before card entry, legal acceptance, or purchase submission.

Not in the current release:

- autonomous payment,
- final purchase submission,
- 3-D Secure completion,
- complex groups, infants, loyalty redemption, or irregular operations,
- production iOS integration.

---

## 5. Definition of Success

### Existing checkout engine

- [ ] 5/5 consecutive live checkouts reach payment review.
- [ ] No manual checkout correction.
- [ ] No paid extra or paid seat when policy declines them.
- [ ] No traveler, route, date, currency, or amount contradiction.
- [ ] No stale or background-surface action executes.
- [ ] Every dispatched action receives fresh semantic verification.
- [ ] Recovery is bounded and tries distinct grounded strategies.
- [ ] Payment review produces one explicit safe handoff.

### Generality

- [ ] The same acceptance contract passes on three structurally different systems:
  - [ ] full-service airline,
  - [ ] low-cost/upsell-heavy airline,
  - [ ] OTA or materially different SPA checkout.
- [ ] Correctness does not require an airline-specific action sequence.
- [ ] Every live failure becomes a generic fixture or cross-layer replay.

### Speed, after reliability

- [ ] p50/p95 checkout and per-action latency are measured.
- [ ] Uniquely safe actions use deterministic zero-model paths.
- [ ] AI is called only for genuine ambiguity.
- [ ] Observation/token reduction never removes correctness-critical controls.

---

## 6. Verified Current Position

### Working foundation — keep

- [x] Backend-owned authoritative `TaskState`.
- [x] Legacy requirements are diagnostic-only in production progression.
- [x] One main action lifecycle and pending-action recovery path.
- [x] Fresh observation-bound candidate IDs.
- [x] AI sees complete current-surface context but can return only safe selectable IDs.
- [x] Central governor and transaction invariants.
- [x] Atomic mechanical browser executor.
- [x] Fresh observation, typed diff, and bounded recovery.
- [x] SQLite transaction/observation/action ledger.
- [x] Optional untouched decisions no longer block progression.
- [x] Cross-site date-of-birth codec refuses ambiguous formats.
- [x] `npm run check` passes.
- [x] 110/110 unit tests pass.
- [x] 37/37 browser and cross-layer tests pass.
- [x] At least one live checkout reached payment review without final payment.

### Current live blocker

The newest reviewed session, `chk_mrtds157i3oqo5`, completes nearly the entire checkout but loops at the final review modal.

The icon-only close control still inherits the CTA label `Continue to Payment`. The newer physical-effect layer nevertheless identifies it correctly as `dismiss_surface`. Fly still selects it because the task reducer replaces the unfinished parent goal (`reach payment review`) with a generic modal decision, whose broad outcome contract permits dismissal. The base page then reopens the same modal.

Root failure:

```text
unfinished parent outcome is discarded at the intermediate modal
→ the whole modal becomes a generic decision group
→ that broad decision contract permits dismiss_surface
→ local dismissal is accepted while payment remains unreached
→ base Continue reopens the modal
```

This is not primarily a scrolling, AI availability, click execution, or Gotogate-procedure problem. It is a goal-continuity and semantic-cycle problem. The browser also still needs to stop borrowing the CTA label for the close icon, but fixing that label alone would not make the parent checkout outcome durable.

---

## 7. Ordered Core Work

Do these gates in order. Do not start a later gate because an earlier one feels slow.

### Gate 0 — Make physical command meaning truthful

This is the current highest-leverage work.

- [ ] Preserve direct/local evidence separately from surrounding surface context:
  - [ ] direct accessible name,
  - [ ] direct text or icon evidence,
  - [ ] role/type/state,
  - [ ] structural attributes as raw evidence,
  - [ ] geometry and surface relationship.
- [ ] Do not let nearby CTA text overwrite an icon-only or unnamed control.
- [ ] When direct evidence is ambiguous, publish `unknown` instead of a confident borrowed meaning.
- [x] Normalize authoritative physical effects including dismissal, advancement, opening, selection, value-setting, and reveal.
- [~] Preserve that effect unchanged from observation/candidate through governor, executor, and verifier. The newest live trace carries `dismiss_surface`, but later task/outcome logic still treats it as a satisfiable generic decision command.

Expected result: close, submit, open, choose, and field controls remain distinct on unfamiliar pages without site-specific procedures.

### Gate 1 — Enforce goal-compatible candidates and exact verification

- [ ] Preserve one durable parent semantic outcome across intermediate foreground surfaces. A modal may create a subgoal, but must not replace `reach payment review` until fresh payment evidence satisfies it.
- [ ] Create decision groups only from real mutually exclusive alternatives or proven obligations. Do not convert an entire review/confirmation modal into a generic required decision whose close icon is an alternative.
- [ ] Match selectable effects to the current semantic goal.
- [ ] For `reach payment review`, expose `advance_stage` as selectable and keep `dismiss_surface` context-only.
- [ ] Replace generic `command_acknowledged` as proof of navigation.
- [ ] Verify effects separately:
  - [ ] dismissal requires the exact surface to disappear,
  - [ ] advancement requires fresh route/stage/progress evidence or a typed intermediate surface,
  - [ ] an unexpected useful change is progress, not goal completion.
- [ ] Keep the same semantic goal active until its exact postcondition is observed.
- [ ] Detect semantic cycles such as `base → modal → base` when there is no net progress toward the durable parent outcome; suppress the repeated strategy and choose another compatible current action.

Required regression:

```text
modal contains icon-only X and Continue to Payment
→ X = dismiss_surface
→ CTA = advance_stage
→ advance goal cannot select X
→ exact CTA is clicked
→ fresh payment-stage evidence verifies success
→ base Continue is not reopened
```

- [ ] Cover misleading/missing accessibility names.
- [ ] Cover portal-rendered modals.
- [ ] Cover rerendered control IDs.
- [ ] Cover a valid intermediate confirmation page.

Expected result: the same correction fixes a broad class of popup, warning, confirmation, and next-page failures.

### Gate 2 — Make payment review a durable terminal boundary

- [ ] Classify payment from several fresh signals: route, progress, heading, sensitive fields, and form roles.
- [ ] Persist `payment_review_reached` as the current release terminal result.
- [ ] Suppress ordinary checkout planning at that boundary.
- [ ] Type legal consent, card entry, amount authorization, final purchase, and confirmation separately.
- [ ] Ensure no loose text matcher can downgrade a legal/payment control to ordinary safe input.
- [ ] Add payment, voucher, receipt, legal-checkbox, and purchase-button negative replays.

Expected result: reaching payment is an explicit success and handoff, never another normal form-filling turn.

### Gate 3 — Prove repeatability on the current engine

- [ ] Run five consecutive live checkout-to-payment tests.
- [ ] Include blank and partially completed profiles.
- [ ] Include wrong default country code and custom inputs.
- [ ] Include offscreen and nested-scroll controls.
- [ ] Include popup/portal and rerender transitions.
- [ ] Include multiple independent paid-extra groups.
- [ ] Include both seat legs, seat-map and no-seat-map variants.
- [ ] Record session ID, result, intervention count, paid-action count, duration, and model calls.
- [ ] Convert every failure into a generic replay before accepting its correction.

Expected result: the vertical slice is repeatable rather than accidental.

### Gate 4 — Prove portability across checkout engines

- [ ] Select three structurally different test sites/engines.
- [ ] Run the same acceptance contract on each.
- [ ] Add missing generic perception capabilities rather than site procedures.
- [ ] Permit site knowledge only as optional labels, evidence, risk hints, or codecs.
- [ ] Reject any design where a site pack owns step order, lifecycle, execution, or success truth.

Expected result: evidence that Fly solves checkout patterns, not only Gotogate.

### Gate 5 — Optimize for speed

- [ ] Measure current p50/p95 latency by observation, planning, execution, and verification.
- [ ] Reuse already verified semantic outcomes.
- [ ] Send typed diffs instead of redundant history.
- [ ] Keep deterministic singleton actions model-free.
- [ ] Add model request deadlines and clear outage behavior.
- [ ] Reduce observation/token size only with regression proof that no required control disappears.
- [ ] Consider safe batching only for low-risk fields with verification boundaries.

Expected result: fast checkout without weakening correctness.

### Gate 6 — Add richer traveler preferences

- [ ] Model preferences as policy, not procedures.
- [ ] Example:

```text
preference: window seat
constraint: free only
fallback: continue without seat
```

- [ ] Add baggage, seating, meal, loyalty, and accessibility preferences incrementally.
- [ ] Preserve explicit price/risk constraints and exact verification.

Expected result: personalized decisions across different sites without hardcoded navigation.

### Gate 7 — Build production payment and booking

Start only after Gates 0–6 meet their acceptance criteria.

- [ ] Tokenized credential vault.
- [ ] Explicit authorization bound to itinerary, offer, currency, and amount.
- [ ] Separate legal approval.
- [ ] 3-D Secure/user-presence handoff.
- [ ] Idempotent purchase submission.
- [ ] Confirmation and booking-reference reconciliation.
- [ ] Receipt/trip persistence.
- [ ] Recovery for uncertain transaction outcomes.

Expected result: safe payment and booking rather than merely browser automation.

### Gate 8 — Add iOS and other clients

- [ ] Extract the stable shared kernel contracts.
- [ ] Define a client adapter interface for observation and atomic execution.
- [ ] Keep semantic state, policy, governor, lifecycle, verification, and transaction truth shared.
- [ ] Build iOS observation/execution adapters without forking agent meaning or safety.

Expected result: one product intelligence layer across browser and mobile clients.

---

## 8. What Not to Do Now

- [ ] Do not revert the current architecture consolidation as a first response.
- [ ] Do not add a Gotogate-specific `dialog-close` procedure as the primary fix.
- [ ] Do not add another independent planner, verifier, pending-action manager, or recovery controller.
- [ ] Do not make every optional observed control a required task.
- [ ] Do not equate page change, click dispatch, or modal disappearance with semantic success.
- [ ] Do not optimize model calls before the cross-site correctness gates pass.
- [ ] Do not begin autonomous payment while payment review is not yet a durable accepted boundary.
- [ ] Do not refactor the large content script broadly until the affected behavior is protected by replays.

---

## 9. What Is Needed From Product/Test Owner

- [ ] Confirm the immediate definition of done:

```text
reach payment review
with zero unintended paid extras,
zero payment/legal submission,
and zero manual checkout correction
```

- [ ] Provide one complete safe test traveler profile.
- [ ] Confirm default rules for baggage, seats, and paid extras.
- [ ] Choose three representative checkout engines for Gate 4.
- [ ] Provide reproducible test itineraries that do not require purchase.
- [ ] On failure, preserve session ID, screenshot, and trace before manually correcting the page.
- [ ] Do not provide live card details during the current release phase.

---

## 10. Completion Rule

A checkbox is complete only when its stated acceptance evidence exists.

```text
implemented
≠ tested in isolation
≠ proven live
```

Use:

- `[x]` only for acceptance-proven scope,
- `[~]` in the detailed tracker for implemented but live-partial work,
- `[ ]` here until the gate's evidence is recorded.

The next engineering action is **Gate 0**, followed immediately by its Gate 1 cross-layer regression. Everything else waits behind that proof.

## 11. Ali Notes / Checklist / Todolist

- [ ] Test on the multiple checkout on GoToGate reaching payments page
- [ ] Add payments component to solution (credit card fake and everything payment processing wise, FaceID or message verifications)
- [ ] Deal with supries, diff forms (e.g. How date is entered differently then we have it, Different radio buttons or dropdowns, filters, buttons on difference checkouts)
- [ ] Different user profile context actions (Pick seats next to the window, or give me fast checkin and so on)
- [ ] Testing on multiple airlines checkouts tests (Croatia, Turkish, American and others)
- [ ] Ensuring minimal close subzero latency making it fast.
- [ ] Ensure making it work in background / cloud / no navigating on screen.
- [ ] Start focusing on UI / UX development once working smooth
(Later / Long term)
- [ ] Focusing on IOS and so on...
