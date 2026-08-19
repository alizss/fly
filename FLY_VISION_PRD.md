# Fly — Product Requirements

Last updated: 2026-08-10

This is Fly's stable product contract. Implementation status belongs in [FLY_COVERAGE_MATRIX.md](./FLY_COVERAGE_MATRIX.md), engineering sequence in [FLY_FINAL_ROADMAP.md](./FLY_FINAL_ROADMAP.md), and current code orientation in [FLY_CURRENT_CODEBASE_ENGINEERING_HANDOFF.md](./FLY_CURRENT_CODEBASE_ENGINEERING_HANDOFF.md).

## 1. North star

> A user selects a flight and traveler, starts Fly, answers only genuinely missing or consequential questions, approves the exact transaction, and receives an independently verified booking confirmation.

The intended experience is approximately 1–3 user interactions. Fly is not an airline autofill script; it is one reusable checkout engine shared by the extension, background web runtime, and future iOS product.

## 2. Current product boundary

The current milestone ends at verified payment review:

```text
approved selected booking
→ traveler/contact/document completion
→ fares, bags, seats, insurance, and extras
→ correction of unauthorized selections
→ itinerary/traveler/currency/total reconciliation
→ verified payment review
→ stop before legal acceptance, payment entry, Pay, or purchase
```

Payment and confirmed booking are later product gates requiring explicit per-booking authorization, a secure payment provider, idempotency, OTP/3DS handling, and independent PNR/ticket evidence.

## 3. Product principles

Fly must:

- Understand unfamiliar checkout layouts and controls without airline workflows.
- Use the exact selected traveler and approved booking contract.
- Apply saved profile policy and trip-specific instructions.
- Act automatically when facts, authority, and a safe mechanic are known.
- Ask only for a genuinely missing fact, authentication, or consequential decision.
- Execute one fresh grounded action at a time and verify what the site accepted.
- Preserve durable progress across rerenders, navigation, pauses, and restarts.
- Tell the truth about completion, blockage, and uncertainty.

Deterministic systems own traveler identity, itinerary, price, permission, transaction state, execution freshness, safety, and completion. A model may resolve bounded ambiguity among fresh supplied reversible candidates; it may not invent controls, facts, work, permission, or transaction truth.

## 4. Eligible journey

A journey is eligible for autonomous checkout-to-review when:

- The selected itinerary is available and inventory remains bookable.
- The starting total/currency and selected traveler are approved.
- Required traveler facts are available or can be requested.
- The site is reachable and exposes a usable browser/accessibility surface.
- No unresolved legal, payment, identity, itinerary, or price authority is required.

A `99%` claim must always name this eligibility scope. It must not count sold-out inventory, airline outages, mandatory human challenges, or unsupported purchase authority as ordinary agent-navigation failures.

## 5. Functional requirements

### Selected booking and traveler

- A new durable transaction starts only from one complete `SelectedBooking/v1`: itinerary, approved total/currency, and at least one selected traveler.
- One extension-owned pre-session `BookingAdmission/v1` obtains that strict contract from either an explicit tab-scoped app launch (`ATW_SELECTED_BOOKING_LAUNCH`) or current-tab selection evidence. The background worker owns one `CheckoutContext/v1` lineage per tab: an explicit app launch or new flight selection rotates it, same-tab redirects preserve it across unrelated domains, and closing the tab clears it. Admission derives `absent`, `candidate`, `confirmed`, `conflict`, or `expired`; only `confirmed` may create a transaction. Another tab, a different lineage, or a globally recent contract can never authorize the checkout, and resume uses only the backend's immutable baseline.
- If current-tab selection identity cannot be proven, Fly reports the exact missing booking facts before session creation. It never creates a partial transaction or asks the running agent/model to invent route, date, total, currency, or traveler identity.
- Traveler facts are canonical and independent of site wording or layout.
- Optional facts never become fabricated requirements.
- Profile silence is not permission for a consequential decision.

### Universal checkout understanding

Fly must handle reusable patterns including:

- Ordinary and combined text fields.
- Split names, dates, phone, and document fields.
- Native and custom selects, autocomplete, portal listboxes, cards, radios, switches, and steppers.
- Repeated passenger/leg controls, seat maps, nested confirmations, overlays, and sticky checkout summaries.
- Framework rerenders, changing DOM identities, delayed hydration, and offscreen controls.
- Localized labels and unfamiliar grouping when fresh ownership and mechanics can be established.

Ordinary DOM differences, a new textbox, unfamiliar wording, or the absence of a site-specific skill are not valid reasons to stop.

When deterministic interpretation is uncertain or internally contradictory, Fly may run one bounded **Semantic Scene Reconciliation** pass before constructing the final decision frame. The model may propose grounded hypotheses about fields, component roles, input formats, decisions, attestations, validations, consequences, and ownership, but every hypothesis must reference fresh observed controls, text, surfaces, or regions. A hypothesis is evidence only: it cannot create an action, traveler fact, requirement, permission, transaction fact, or completion claim.

Known scenes remain deterministic with no model call. Semantic reconciliation consumes the same at-most-one ambiguity call available for the turn; it does not create a second model path. The deterministic compiler remains responsible for producing exactly one final `DecisionFrame`, and TaskState remains the only authority that publishes the next obligation.

Unfamiliar observed decision groups may additionally receive one descriptive type from the closed vocabulary `baggage`, `seat`, `insurance`, `bundle`, `flexible_ticket`, `check_in_method`, `optional_support`, `loyalty_enrollment`, `legal_acceptance`, or `stage_exit`. This hypothesis may refine canonical ownership evidence only. It cannot change requiredness, price effect, policy, permission, the next obligation, or completion.

Validation is active state, not matching prose. Each observation classifies validation evidence as `clear`, `diagnostic`, `active_control_error`, `active_stage_error`, or `unresolved`. Zero-error summaries, hidden/dormant alerts, stale instructions, and unowned generic error text cannot block checkout. Blocking requires an exact active invalid owner or explicit active stage failure; a fresh executable Continue remains eligible when only diagnostic validation prose exists.

### Planning, action, and verification

- One fresh observation compiles deterministically when possible; bounded grounded semantic hypotheses may reconcile an uncertain or contradictory draft before one final semantic decision frame is published.
- TaskState publishes exactly one current obligation or typed disposition.
- Candidate binding finds mechanics only for that obligation.
- The governor checks consequences immediately before execution.
- The browser executes one exact leased action.
- Fresh evidence must verify the same semantic postcondition before progress persists.
- Failed mechanics use bounded distinct recovery; loops and stale action replay are prohibited.

### Transaction review

Before reporting payment review, Fly must reconcile:

- Route, dates, segments, and traveler identities.
- Fare and approved selections when authoritative evidence exists.
- Bags, seats, insurance, and other consequential outcomes.
- Currency and total.
- Expected verified-action/outcome coverage.

Generic payment wording, a URL, a click acknowledgement, or a page change is not completion evidence.

### Durability and background operation

The background product must reuse the same policy, TaskState, governor, action, verification, and transaction contracts. It adds isolated browsers, secure state, checkpoints, notifications, authentication handoff, and resume—not a second checkout engine.

## 6. Valid stop and handoff reasons

Fly may stop or pause for:

- A genuinely missing required traveler fact.
- Login, OTP, CAPTCHA, 3DS, bank approval, or another human challenge.
- Required legal consent or payment/purchase authority.
- A paid choice, price/currency change, itinerary change, or identity ambiguity not covered by explicit policy.
- Sold-out inventory, expired session, airline outage, or a site that rejects valid completed input.
- No safe grounded actuator after bounded adaptation and fresh verification attempts.
- Verified payment review under the current milestone.

The last mechanical case is an engineering coverage defect for an otherwise eligible journey. It must create a reusable replay and universal repair, not an airline branch.

Fly must not stop because a page is merely unfamiliar, a control is custom, optional fields are blank, dormant forms exist, a framework replaced a node, or a Continue button was reused.

## 7. Non-negotiable safety

Fly must never:

- Guess or substitute traveler identity.
- Change route, dates, airports, passengers, or currency without authority.
- Add or retain an unauthorized paid product.
- Infer price permission from page wording or an observed total.
- Accept legal terms, enter payment credentials, or purchase under the current boundary.
- Execute a stale, hidden, occluded, mismatched, or ungrounded target.
- Treat dispatch, navigation, or visual change as semantic success.
- Claim completion with missing or vacuous transaction/outcome evidence.
- Learn weaker safety or permission from previous success.
- Add an airline-specific workflow to bypass universal contracts.

Targets for false terminal completion and unauthorized irreversible mutation are zero.

## 8. Generalization and learning

Every material live failure must become one of:

1. A universal contract defect with an exact replay and repair.
2. A reusable component/actuator pattern.
3. A genuine user-authority or authentication handoff.
4. A precisely detected website/inventory failure.

Learning is offline, sanitized, regression-tested, reviewed, versioned, and reversible. Fly may learn aliases, component patterns, timing distributions, failure signatures, and successful bounded mechanics. It may not learn permission or weaken verification.

## 9. Success criteria

### Structural coverage

- Approximately 8–10 live sites across at least 6 observed structural checkout families.
- At least 4 direct-airline families.
- At least 3 structurally different OTA families.
- Every important discovered repair confirmed on a second relevant site.
- Existing Kiwi, GoToGate, EasyJet, and Turkish canaries remain green after material core changes.

### Scenario coverage

At least two structurally different families must prove:

- Complete single traveler and missing-data resume.
- Multiple adults and adult-plus-child ownership.
- Explicit baggage and seat authorization with budgets.
- Unauthorized preselected-extra correction.
- Login/OTP pause and resume.
- Multi-leg itinerary and currency/total change.
- Airline outage, changed availability, or expired session.

### Reliability evidence

Track separately:

- Autonomous verified-payment-review rate for defined eligible journeys.
- Safe-resolution and necessary-handoff rate.
- False completion and unauthorized-mutation rate.
- Recovery rate and duration.
- Median/p95 task duration, turns, observation bytes, model calls, and cost.

A defensible broad `99%` target requires approximately 300 representative eligible journeys distributed across sites, routes, dates, currencies, layouts, profiles, and time—not repetitions of one checkout.

## 10. Promotion gates

| Gate | Required evidence | Unlocks |
|---|---|---|
| A — Direct-airline generalization | Full-service and low-cost direct airlines reach verified payment review; Kiwi and GoToGate stay green; no site workflow | Structural portfolio expansion |
| B — Structural portfolio | 8–10 sites, 6+ families, 4 direct-airline families, 3 OTA families | Internal/allowlisted checkout-to-review alpha |
| C — Profile and policy matrix | Multi-traveler, child, baggage, seat, dirty-checkout, missing-data, and auth scenarios on 2+ families | Limited review-only beta and payment sandbox work |
| D — Background product | Isolated durable jobs, secure state, restart safety, notification/handoff/resume, extension-equivalent behavior | Background web and iOS control experience |
| E — Broad review-only production | Defined reliability window, confidence analysis, observability, kill switch, rollback, zero false completion/irreversible mutation | Broader checkout-to-review availability |
| F — Payment pilot | Gate E plus payment vault/provider, authorization checksum, idempotency, 3DS/OTP, compliance review, and independent confirmation | Narrow controlled purchase pilot |

## 11. Decision filter

Prioritize work only when it:

1. Advances the North Star user outcome.
2. Improves a reusable capability rather than one site.
3. Transfers to the background/web/iOS engine.
4. Preserves or strengthens safety and verification.
5. Has replay or live acceptance evidence.
6. Is required by the next promotion gate.

Fly succeeds when the user can trust this promise:

> Choose the flight and traveler. Fly will handle the checkout according to your facts and rules, ask only when it truly needs you, never make an unauthorized consequential decision, and tell you the truth about whether the trip is ready, blocked, or confirmed.
