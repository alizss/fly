# Fly — Product Requirements

Last updated: 2026-08-12

This is Fly's stable product contract. Implementation status belongs in [FLY_COVERAGE_MATRIX.md](./FLY_COVERAGE_MATRIX.md), engineering sequence in [FLY_FINAL_ROADMAP.md](./FLY_FINAL_ROADMAP.md), and current code orientation in [FLY_CURRENT_CODEBASE_ENGINEERING_HANDOFF.md](./FLY_CURRENT_CODEBASE_ENGINEERING_HANDOFF.md).

## 1. North star

> A user selects a flight and traveler, starts Fly, answers only genuinely missing or consequential questions, approves the exact transaction, and receives an independently verified booking confirmation.

The intended experience is approximately 1–3 user interactions. Fly is not an airline autofill script; it is one reusable checkout engine shared by the extension, background web runtime, and future iOS product.

## 2. Current product boundary

The current milestone ends when actual payment entry is verified:

```text
approved selected booking
→ traveler/contact/document completion
→ fares, bags, seats, insurance, and extras
→ correction of unauthorized selections
→ itinerary/traveler/currency/total reconciliation
→ pre-payment review
→ exact legal approval when required
→ accept only the approved attestation and advance
→ verify actual payment entry
→ stop before entering payment credentials, Pay, or purchase
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
- Any required legal attestation can be shown exactly and approved for this booking; payment-entry and purchase authority remain unavailable.

A `99%` claim must always name this eligibility scope. It must not count sold-out inventory, airline outages, mandatory human challenges, or unsupported purchase authority as ordinary agent-navigation failures.

## 5. Functional requirements

### Selected booking and traveler

- A new durable transaction starts only from one complete `SelectedBooking/v1`: itinerary, approved total/currency, and at least one selected traveler.
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

### Planning, action, and verification

- One fresh observation compiles deterministically when possible; bounded grounded semantic hypotheses may reconcile an uncertain or contradictory draft before one final semantic decision frame is published.
- TaskState publishes exactly one current obligation or typed disposition.
- Candidate binding finds mechanics only for that obligation.
- The governor checks consequences immediately before execution.
- The browser executes one exact leased action.
- Fresh evidence must verify the same semantic postcondition before progress persists.
- Failed mechanics use bounded distinct recovery; loops and stale action replay are prohibited.

### Pre-payment, legal, and payment-entry boundaries

Before advancing through a legal gate or reporting payment entry, Fly must reconcile:

- Route, dates, segments, and traveler identities.
- Fare and approved selections when authoritative evidence exists.
- Bags, seats, insurance, and other consequential outcomes.
- Currency and total.
- Expected verified-action/outcome coverage.

The observed boundaries are distinct: `PRE_PAYMENT_REVIEW`, `LEGAL_GATE`, `PAYMENT_ENTRY`, and `PURCHASE_COMMIT`. Review copy plus a legal checkbox plus a Confirm button is never payment-entry proof. `PAYMENT_ENTRY_REACHED` requires an owned payment-method component, card-number/expiry/CVC controls, or a hosted payment widget/frame. Generic payment wording, a URL, a click acknowledgement, or a page change is not completion evidence.

A legal approval is narrow: transaction, itinerary, travelers, total/currency, exact legal-text digest, checkbox owner, next control, and expiry. Fly first verifies the approved checkbox, then separately advances, then verifies payment entry. Changed legal text, price, traveler, itinerary, control, transaction, or an expired token invalidates the approval.

### Durability and background operation

The background product must reuse the same policy, TaskState, governor, action, verification, and transaction contracts. It adds isolated browsers, secure state, checkpoints, notifications, authentication handoff, and resume—not a second checkout engine.

## 6. Valid stop and handoff reasons

Fly may stop or pause for:

- A genuinely missing required traveler fact.
- Login, OTP, CAPTCHA, 3DS, bank approval, or another human challenge.
- A required legal attestation that the user declines or cannot be bound to exact current evidence.
- Payment credentials, Pay, transaction commit, or another purchase authority boundary.
- A paid choice, price/currency change, itinerary change, or identity ambiguity not covered by explicit policy.
- Sold-out inventory, expired session, airline outage, or a site that rejects valid completed input.
- No safe grounded actuator after bounded adaptation and fresh verification attempts.
- Verified actual payment entry under the current milestone.

The last mechanical case is an engineering coverage defect for an otherwise eligible journey. It must create a reusable replay and universal repair, not an airline branch.

Fly must not stop because a page is merely unfamiliar, a control is custom, optional fields are blank, dormant forms exist, a framework replaced a node, or a Continue button was reused.

## 7. Non-negotiable safety

Fly must never:

- Guess or substitute traveler identity.
- Change route, dates, airports, passengers, or currency without authority.
- Add or retain an unauthorized paid product.
- Infer price permission from page wording or an observed total.
- Accept legal terms without the exact current transaction-bound approval.
- Enter payment credentials, activate Pay, or commit a purchase under the current boundary.
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

- Autonomous verified-payment-entry rate for defined eligible journeys, with legal approvals counted separately as necessary user interaction.
- Safe-resolution and necessary-handoff rate.
- False completion and unauthorized-mutation rate.
- Recovery rate and duration.
- Median/p95 task duration, turns, observation bytes, model calls, and cost.

A defensible broad `99%` target requires approximately 300 representative eligible journeys distributed across sites, routes, dates, currencies, layouts, profiles, and time—not repetitions of one checkout.

## 10. Promotion gates

| Gate | Required evidence | Unlocks |
|---|---|---|
| A — Direct-airline generalization | Full-service and low-cost direct airlines reach verified actual payment entry; Kiwi and GoToGate stay green; no site workflow | Structural portfolio expansion |
| B — Structural portfolio | 8–10 sites, 6+ families, 4 direct-airline families, 3 OTA families | Internal/allowlisted checkout-to-payment-entry alpha |
| C — Profile and policy matrix | Multi-traveler, child, baggage, seat, dirty-checkout, missing-data, and auth scenarios on 2+ families | Limited review-only beta and payment sandbox work |
| D — Background product | Isolated durable jobs, secure state, restart safety, notification/handoff/resume, extension-equivalent behavior | Background web and iOS control experience |
| E — Broad payment-entry production | Defined reliability window, confidence analysis, observability, kill switch, rollback, zero false completion/irreversible mutation | Broader checkout-to-payment-entry availability |
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
