# Fly — Product Requirements Document

Last updated: 2026-08-03

## Document purpose

This document is the stable product contract for Fly: why it exists, what the product must become, what it must never do, and the evidence required before advancing to the next stage.

Use the documentation set as follows:

- `PRD.md` — product vision, scope, requirements, success criteria, and promotion gates.
- `FLY_FINAL_ROADMAP.md` — target architecture and engineering build order.
- `FLY_COVERAGE_MATRIX.md` — current capability, site, scenario, and reliability evidence.
- `FLY_PROGRESS.md` — chronological engineering and live-test history.
- `FLY_AGENT_RULEBOOK.md` — non-negotiable agent behavior and safety invariants.
- `FLY_CURRENT_CODEBASE_ENGINEERING_HANDOFF.md` — code-level orientation and implementation handoff.

When documents disagree, fresh code, automated tests, and sanitized live traces determine current engineering truth. This PRD remains the authority for product direction.

## 1. North star

> Goal is 1-3 click booked paid flight from user perspective. (One click booking flight)A user selects a flight, chooses a traveler, and starts Fly. Fly completes the booking correctly and safely with minimal interaction, pauses only when the user must provide information or authority (unlikely), and reports completion only after independent booking evidence exists.

> Goal is 1-3 click booked paid flight from user perspective seamless.

The desired user experience is:

```text
select flight
→ tap Fly
→ answer only genuinely missing or consequential questions (best if nothing or provide requirements if specific if not already in user profile) 
→ review the exact itinerary and total
→ explicitly authorize purchase when payment is supported
→ receive independently verified booking confirmation
```

Fly is not an airline-specific autofill script. It is a reusable, safety-constrained checkout agent shared by the browser extension, background runtime, web product, and iOS product.

## 2. Product vision

Fly becomes the trusted layer between “I found the flight” and “I have the ticket.”

It should combine the flexibility of a computer-use web agent with stronger transaction guarantees:

- Understand unfamiliar checkout layouts and custom controls.
- Use the correct traveler identity and saved facts.
- Apply explicit preferences, constraints, and booking-specific instructions.
- Never invent permission for price, identity, itinerary, legal, payment, or purchase decisions.
- Execute one fresh grounded action at a time.
- Verify what the website actually accepted.
- Recover from rerenders, loading, overlays, and unexpected surfaces.
- Preserve durable progress across pauses and restarts.
- Reconcile the final itinerary, travelers, selections, currency, and total.
- Produce an auditable explanation of what was changed and why.

## 3. Platform strategy

The Chrome extension is the first actuator and development proving ground, not the final product.

The platform sequence is:

```text
Chrome extension proving environment
→ universal checkout-to-review engine
→ secure background/cloud browser runtime
→ web and iOS task-control experiences
→ narrowly authorized payment execution
→ independently verified booking confirmation
```

The same core engine must be reused across every surface:

```text
Traveler profile and booking policy
                 ↓
Universal semantic checkout engine
                 ↓
Safety and transaction governor
                 ↓
Atomic action and verification contract
                 ↓
Extension, remote browser, or future permitted actuator
```

Moving from the extension to the cloud must change where the browser runs, not how identity, policy, safety, decisions, verification, or transaction truth work.

## 4. Current product boundary

The current release milestone ends at verified payment review:

```text
selected itinerary
→ traveler and contact details
→ fares, bags, seats, insurance, and extras
→ review and correct unauthorized selections
→ verify itinerary, travelers, currency, and total
→ reach payment review
→ stop before card entry, legal acceptance, Pay, or purchase
```

A correct run may also:

- Ask one precise question when required profile information is missing.
- Ask for explicit authority when a consequential choice is not covered by policy.
- Pause for login, OTP, CAPTCHA, or another user-only interaction.
- Stop with a precise diagnosis when the website fails or safe recovery is exhausted.

These are valid outcomes. Guessing, looping, unsafe mutation, and false completion are not.

## 5. Primary user jobs

### 5.1 Complete an ordinary checkout

The user has selected a flight and wants Fly to enter known traveler/contact facts, apply existing preferences, and reach review without repeated manual work.

### 5.2 Resolve checkout choices consistently

The user wants baggage, fare, seat, insurance, flexibility, check-in, and other choices handled from their saved policy and trip-specific instruction—not a blanket “always free” rule.

### 5.3 Handle uncertainty safely

When the site asks for unknown information or a consequential preference, Fly asks the minimum necessary question and resumes the same task.

### 5.4 Work without keeping the page open

In the background product, the user should be able to start a task from web or iOS, leave, respond to a notification if needed, and return to a durable result.

### 5.5 Complete an authorized purchase

In the later payment product, Fly executes exactly one approved transaction and reports success only from independent PNR, ticket, or equivalent confirmation evidence.

## 6. Functional requirements

### FR1 — Selected-itinerary intake

Fly must start from an itinerary selected or explicitly approved by the user. It must preserve route, dates, passengers, fare identity when known, and currency/price expectations as an immutable or progressively promoted baseline.

### FR2 — Canonical traveler profile

Fly must store traveler facts independently of site wording or field layout. The profile must distinguish facts that websites often conflate.

Canonical profile areas include:

- Explicit title/honorific.
- Gender/sex when genuinely required.
- Legal given names, optional middle names, surname, and additional surname.
- Date and place of birth where needed.
- Nationality/citizenship and country of residence.
- Email and phone split into canonical country code and national number.
- Address facts.
- Passport or other document facts, issuing country, and expiry.
- Loyalty-program identifiers.
- Accessibility or assistance requirements.

Absence of an optional fact must never become a fabricated required answer. Sensitive fields must use appropriate encryption, access control, redaction, and retention rules.

### FR3 — Profile policy and booking instructions

Fly must translate saved preferences and one-off instructions into explicit authority for decisions such as:

- Fare flexibility.
- Baggage quantity and maximum price.
- Random or specific seat preferences and maximum price.
- Insurance and protection products.
- Check-in products.
- Marketing and loyalty enrollment.
- Acceptable currency or total changes.

Profile silence is not permission. Consequential uncovered choices require a targeted question.

### FR4 — Universal page and component understanding

Fly must reconstruct logical checkout components before policy or planning runs.

One logical component may combine:

- Visual owner/container.
- Label and contextual evidence.
- State-bearing node.
- Click/type/select actuator.
- Options rendered inside or outside the owner.
- Popup, listbox, drawer, or modal surface.
- Requiredness and validation.
- Passenger, leg, product, and stage ownership.

The compiler must support ordinary fields, composite names, split dates, native and custom selects, autocomplete, exclusive card/radio groups, portal popups, seat maps, repeated passenger/leg controls, and persistent checkout chrome.

When deterministic reconstruction is genuinely ambiguous, a bounded multimodal model may propose component structure using only currently observed node IDs and evidence. AI may interpret structure; it may not invent controls, state, profile facts, or permission.

### FR5 — Grounded action planning

Fly must expose a finite set of fresh, relevant, actionable, policy-compatible candidates. AI selection, when needed, is restricted to that set.

No action may execute from label search, stale history, model invention, or unverified site workflow memory.

### FR6 — Atomic execution and semantic verification

Fly must:

1. Observe current state.
2. Choose one atomic action.
3. Revalidate identity, surface, freshness, actionability, and permission.
4. Execute once.
5. Observe again.
6. Verify the semantic postcondition.
7. Persist only verified progress.

A dispatched event or page change is never sufficient completion evidence.

### FR7 — Recovery and handoff

Fly must classify failures and choose bounded re-observation, relocation, alternate actuator, exact correction, checkpoint return, user handoff, or safe stop.

It must pause and resume without duplicate actions for:

- Login.
- OTP or 3-D Secure challenge.
- CAPTCHA.
- Missing traveler data.
- Consequential approval.
- Website outage or changed availability.

### FR8 — Durable task and outcome state

Verified facts, actions, decisions, approvals, failures, and transaction outcomes must survive rerenders, page navigation, process restart, and background pause/resume.

Expected outcome coverage must be independent of successful journal admission so missing evidence cannot disappear from the expected set.

### FR9 — Transaction review

Before declaring the current milestone complete, Fly must reconcile:

- Itinerary segments and dates.
- Travelers.
- Fare when authoritative evidence exists.
- Bags, seats, insurance, and other consequential selections.
- Currency and total.
- Unauthorized paid selections.
- Durable verified-action coverage.

Payment review must be detected from typed terminal evidence, not generic wording or a URL alone.

### FR10 — User-visible progress and audit

The user must be able to see:

- Current task stage.
- What Fly has verified.
- What remains unresolved.
- Why Fly chose or declined an option.
- What question or approval is needed.
- Final verified result.

Audit data must be useful without exposing unnecessary personal or payment data.

### FR11 — Background execution

The remote runtime must provide isolated browsers, durable jobs, encrypted state, checkpoints, bounded retries, resumability, notifications, and safe handoff. It must use the same policy, governor, action, and verification contracts as the extension.

### FR12 — Web and iOS control surfaces

Web and iOS should start and monitor tasks, select travelers, provide booking instructions, answer questions, complete user-only authentication, approve a specific transaction, and receive final status. They are orchestration surfaces, not separate checkout engines.

### FR13 — Future authorized payment

Payment is a separate product boundary. It requires:

- A PCI-appropriate vault/provider and security/compliance review.
- Explicit per-booking authorization.
- A checksum over traveler, itinerary, selections, currency, and maximum total.
- Idempotency and duplicate-booking protection.
- OTP/3DS pause and resume.
- Clear `AUTHORIZED`, `SUBMITTED`, `CONFIRMED`, `FAILED`, and `UNKNOWN` states.
- Independent PNR/ticket/booking confirmation evidence.

Fly must never report a confirmed booking from a Pay click or payment acknowledgement alone.

## 7. Non-negotiable safety requirements

Fly must never:

- Substitute or guess traveler identity.
- Change the approved route, dates, airports, passengers, or currency without authority.
- Add or retain an unauthorized paid extra.
- Infer price permission from a starting total or page wording.
- Accept legal terms autonomously under the current boundary.
- Enter payment credentials or submit a purchase under the current boundary.
- Execute a stale, hidden, occluded, mismatched, or ungrounded control.
- Treat navigation, acknowledgement, or generic page change as semantic success.
- Claim completion when required action/outcome coverage is missing.
- Hide a failure behind `0 expected / 0 recorded` or another vacuous success condition.
- Learn weaker permission or safety behavior from prior success.
- Create an airline-specific workflow to bypass the universal contracts.

Safety and functional completion are measured separately. A run may fail functionally while still stopping safely.

## 8. Universal-generalization requirement

Fly should learn reusable interaction patterns, not airline workflows.

Reusable patterns include:

- Scalar and composite text fields.
- Native and custom dropdowns.
- Portal listboxes and autocomplete.
- Split-node card/radio groups.
- Date pickers and segmented dates.
- Passenger- and leg-scoped repeated controls.
- Seat maps.
- Modal and nested confirmation episodes.
- Sticky itinerary/price summaries.
- Paid-option detection and reversal.
- Review and hosted-payment surfaces.

Every material live failure must become either:

- A universal contract repair.
- A reusable bounded perception/actuator pattern.
- A genuine user-authority requirement.
- An expected authentication or safety handoff.
- A precisely detected website failure.

## 9. Product success criteria

### 9.1 Basic traveler-form universality

- At least 8 of 10 diverse, previously unseen or independently captured traveler forms advance without new site-specific code.
- All 10 avoid incorrect or unsafe mutation.
- Required known fields map correctly.
- Optional fields do not block.
- Unknown required facts produce one precise question.

### 9.2 Structural checkout coverage

- Approximately 8–10 sites across at least 6 observed structural checkout families.
- At least 4 direct-airline families.
- At least 3 structurally different OTA families, including accepted Kiwi and GoToGate baselines.
- Important repairs are validated on a second airline/site rather than only the discovering site.

### 9.3 Scenario and profile-policy coverage

At least two structurally different families must prove each consequential scenario:

- Complete single traveler.
- Incorrect or partially filled profile facts.
- Missing required information and resume.
- Multiple adults.
- Adult plus child.
- Explicit baggage authorization.
- Explicit seat authorization.
- Preselected unauthorized extra correction.
- Login and user-authentication handoff.
- Multi-leg itinerary.
- Currency/total change.
- Website failure or changed availability.

### 9.4 Reliability evidence

Track separately:

- Autonomous verified-payment-review rate for defined eligible journeys.
- Safe-resolution rate, including correct questions and handoffs.
- False terminal completion rate.
- Unauthorized consequential mutation rate.
- Recovery rate and time.
- Median and p95 task duration, actions, model calls, latency, and cost.

A broad `99%` claim requires a defined eligibility scope and a distributed acceptance window large enough for a confidence bound. As an approximate target, use about 300 representative eligible journeys across sites, routes, dates, currencies, layouts, and time—not 300 repetitions of one checkout.

False terminal completion and unauthorized irreversible mutation targets are zero.

## 10. Promotion gates

### Gate A — Universal traveler forms

Required:

- Owner-first component reconstruction.
- Bounded multimodal reconstruction fallback.
- 8/10 diverse traveler forms advance without site-specific code.
- 10/10 stop safely or advance correctly.

Unlocks: deeper cross-airline checkout testing.

### Gate B — Checkout-to-review structural portfolio

Required:

- At least 6 structural families.
- Full-service and low-cost direct airlines reach verified payment review.
- At least one additional structurally different OTA passes.
- Kiwi and GoToGate remain green canaries.
- Every material failure has a replay.

Unlocks: monitored internal/allowlisted checkout-to-review alpha.

### Gate C — Profile and policy matrix

Required:

- Multi-traveler, missing-data, baggage, seat, dirty-checkout, and login/OTP scenarios pass on at least two families.
- Durable pause/resume and exact user questions are proven.

Unlocks: limited checkout-to-review beta and isolated payment sandbox development.

### Gate D — Background product

Required:

- Durable isolated remote browser jobs.
- Restart-safe state and idempotent actions.
- Secure profile/policy service.
- Notification, question, approval, authentication, and resume flows.
- Behavioral equivalence with the extension engine.

Unlocks: background web product and iOS task-control experience.

### Gate E — Broad review-only production

Required:

- Defined reliability acceptance window and confidence analysis.
- Monitoring, alerting, kill switch, version identity, and rollback.
- Zero false terminal completion and unauthorized irreversible mutation in the acceptance window.
- Clear supported-site/scenario eligibility policy.

Unlocks: broader checkout-to-payment-review availability.

### Gate F — Payment pilot

Required:

- Gate E plus the payment safety architecture in FR13.
- Security, privacy, PCI, legal, and compliance review.
- Narrow site allowlist and transaction limits.
- Explicit approval immediately before purchase.
- Independent confirmation evidence and unknown-state recovery.

Unlocks: controlled real-payment pilot, not general payment autonomy.

## 11. Non-goals for the current milestone

The current milestone does not include:

- General-purpose web browsing or computer-use automation unrelated to travel checkout.
- Autonomous legal acceptance.
- Payment credential entry or purchase submission.
- Claiming universal airline coverage from a small site sample.
- Building separate workflows for Turkish, easyJet, Kiwi, GoToGate, or any other site.
- Fully autonomous online self-modification of policy or safety code.
- iOS-specific checkout logic that duplicates the shared engine.
- Optimizing UI polish ahead of core reliability and safety evidence.

## 12. Product interaction principles

- Default to action when facts and authority are known.
- Ask only when the answer is genuinely missing or consequential.
- Ask one small, contextual question rather than handing the entire page back.
- Explain price, itinerary, identity, and safety blockers plainly.
- Show verified progress, not simulated confidence.
- Allow takeover and resume without losing task state.
- Never require the user to understand DOM, selectors, or internal agent terminology.

## 13. Learning and adaptation model

Fly may improve from sanitized traces by learning:

- Component and actuator patterns.
- Semantic aliases.
- Timing and hydration distributions.
- Failure signatures.
- Proven recovery strategies.
- Successful component-level trajectories.

Learning is offline, regression-tested, reviewed, versioned, and reversible. Fly may not learn permission to purchase, weaken safety, or treat unverified outcomes as success.

## 14. Architecture principles

1. One canonical semantic contract is compiled upstream and consumed downstream.
2. Fresh browser evidence outranks stale memory.
3. Logical identity is independent of mutable DOM identity, text value, and layout.
4. Foreground ownership is semantic, not purely geometric.
5. Deterministic systems own the objective, traveler and itinerary truth, permission, transaction state, execution freshness, verification, and completion claims.
6. AI may choose reversible browser mechanics only inside a causally owned surface, explicit allowed/forbidden effect boundary, fresh grounded evidence, and bounded attempt budget.
7. Every action is atomic and closed-loop.
8. Every consequential completion has fresh semantic proof.
9. Every expected verified action must reconcile into durable coverage.
10. Extension, cloud, web, and iOS reuse the same core engine.
11. Site knowledge may improve patterns but cannot own end-to-end workflows.
12. Payment remains structurally inaccessible until its explicit product gate.

## 15. Current highest-leverage focus

The current focus is the universal interaction kernel at the start of the pipeline:

- Reconstruct one canonical owner for split-node exclusive choices.
- Attach state, presentation, actuator, popup, options, requiredness, and validation to that owner.
- Preserve the component through rerender and portal surfaces.
- Preserve the known objective when exact deterministic actuator ownership is incomplete.
- Prefer deterministic execution when mechanics are proven; otherwise use one bounded adaptive surface episode for reversible mechanics before stopping.
- Keep paid extras, legal consent, payment, purchase, identity, itinerary, price, and completion authority outside the adaptive operator.
- Prove the design through the cross-airline traveler-form benchmark.

This focus advances the extension, background runtime, web product, iOS experience, and future payment product because all of them depend on the same checkout understanding.

The exact current implementation and live blockers belong in `FLY_PROGRESS.md` and `FLY_COVERAGE_MATRIX.md`, not in this stable PRD.

## 16. Decision filter for future work

Before prioritizing a feature or repair, ask:

1. Does it move Fly toward the North Star user outcome?
2. Does it improve a reusable capability rather than one site workflow?
3. Will it transfer to the background/web/iOS engine?
4. Does it preserve or strengthen safety and verification?
5. Can success be measured by replay or live acceptance evidence?
6. Is it required before the next promotion gate?

If most answers are no, the work is probably not the current priority.

## 17. Definition of product success

Fly succeeds when a user can trust this promise:

> “Choose the flight and traveler. Fly will handle the checkout according to your facts and rules, ask only when it truly needs you, never make an unauthorized consequential decision, and tell you the truth about whether the trip is ready, blocked, or confirmed.”
