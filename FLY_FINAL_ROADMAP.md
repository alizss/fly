# Fly — Final Product and Engineering Roadmap

## North star

Fly should complete checkout across different airline and OTA websites by dynamically understanding each page, using the selected traveler’s facts, preferences, constraints, and trip-specific instructions, handling unexpected situations safely, and stopping only when payment or explicit user authorization is required.

The Chrome extension is the first actuator and proving ground. The long-term product is one reusable checkout-intelligence engine shared by the browser extension, a secure background runtime, and an iOS experience.

Current release boundary:

```text
Selected flight
→ complete traveler and contact details
→ resolve fares, bags, seats, insurance, and other required choices
→ verify itinerary and price
→ reach payment review
→ stop before payment, legal acceptance, or purchase
```

“Handle every surprise” does not mean silently completing every situation. It means Fly always responds correctly: recover when safe, ask for the smallest missing decision, or stop clearly at a safety boundary.

## End-to-end system flow

```mermaid
flowchart TD
    A["Fresh multimodal observation"] --> B["Normalize into universal checkout model"]
    B --> C["Identify active foreground surface"]
    C --> D["Reconcile with durable task state"]
    D --> E["Find next unresolved requirement or decision"]
    E --> F["Apply traveler profile, trip instructions, and policy"]
    F --> G{"Can Fly resolve it safely?"}

    G -->|"Known fact or policy"| H["Choose deterministic skill"]
    G -->|"Safe UI ambiguity"| I["AI selects from grounded candidates"]
    G -->|"Missing fact or consequential preference"| J["Ask user for the minimum input"]
    G -->|"Payment, legal, CAPTCHA, OTP, or unsafe"| K["Stop or hand off safely"]

    H --> L["Compile one atomic action"]
    I --> L
    J --> D

    L --> M["Revalidate control identity, freshness, and permission"]
    M -->|"Invalid or stale"| A
    M -->|"Valid"| N["Execute one action"]
    N --> O["Observe again"]
    O --> P{"Semantic postcondition satisfied?"}

    P -->|"Yes"| Q["Persist verified progress"]
    Q --> R{"Payment review ready?"}
    R -->|"No"| A
    R -->|"Yes"| S["Verify itinerary and total, then stop"]

    P -->|"Recoverable failure"| T["Bounded recovery or alternate actuator"]
    T --> A
    P -->|"Semantic ambiguity remains"| J
    P -->|"Recovery exhausted"| K
```

## Core components

- **Universal checkout model** — Represents stages, passengers, fields, decisions, prices, selections, blockers, foreground surfaces, payment readiness, and terminal status independently of airline wording or markup.

- **Stable logical control identity** — Gives every logical control a unique identity, meaning, state, surface owner, available actuators, and a safe way to relocate it after rerenders.

- **Multimodal perception** — Combines DOM, accessibility data, visible text, screenshots, geometry, overlays, browser events, navigation state, and specialized perception for difficult components such as canvas seat maps.

- **Foreground-surface ownership** — Makes the active modal, drawer, warning, dropdown, or confirmation authoritative over unrelated background controls.

- **Logical field adapter** — Maps physical controls to scalar and composite requirements such as names, split dates, phone components, document data, custom dropdowns, and autocomplete fields.

- **Durable task state and reconciliation** — Remembers only verified progress, approvals, decisions, prices, failures, and checkpoints, while yielding to contradictory fresh page evidence.

- **Requirement and decision engine** — Converts every unresolved item into a structured field requirement or decision with options, risk, policy status, evidence, and completion state.

- **Profile and policy engine** — Applies hard safety rules, user facts, user preferences, trip-specific instructions, product defaults, and bounded agent judgment in that order.

- **Hierarchical planner and reusable skills** — Chooses the journey objective and a reusable skill, but compiles and executes only one freshly verified atomic action at a time.

- **Bounded AI ambiguity resolver** — Uses AI only when interpretation is genuinely required and permits selection only from current grounded, actionable, policy-safe candidates.

- **Deterministic execution plane** — Executes tightly specified operations such as click, type, select, scroll, wait, and navigation after local freshness and actionability checks.

- **Semantic postcondition verification** — Verifies the intended result after every action: exact value accepted, decision resolved, modal dismissed, error cleared, price preserved, or stage advanced.

- **Recovery and loop detection** — Relocates controls, changes actuator, refreshes observation, retries a bounded strategy, returns to a verified checkpoint, detects loops, and hands off when recovery is exhausted.

- **Safety and transaction governor** — Blocks unauthorized paid extras, identity substitution, itinerary changes, price increases, legal acceptance, payment entry, final purchase, and other irreversible actions.

- **Trace, replay, and regression system** — Captures sanitized observations, decisions, actions, outcomes, and failures so every real-site problem becomes a reproducible generic regression test.

- **Lightweight site adaptation layer** — Reuses aliases, component patterns, reliable actuators, dialog signatures, and known traps without creating airline-specific end-to-end workflows.

- **Shared secure platform** — Synchronizes encrypted profiles, policies, approvals, task state, audit history, and notifications across browser, future background execution, and iOS.

## Ambiguity and surprise routing

| Situation | Required behavior |
|---|---|
| Known traveler fact | Fill deterministically and verify the accepted canonical value. |
| Missing required traveler fact | Ask the user; never invent identity information. |
| Choice resolved by explicit policy | Select deterministically and verify the decision outcome. |
| Consequential choice without applicable policy | Ask the user before changing price, itinerary, flexibility, or important trip properties. |
| Unfamiliar UI with safe grounded options | Let AI interpret the surface and select only a supplied candidate. |
| Recognized control fails to respond | Try a finite sequence of proven or bounded alternate actuators. |
| Page rerenders or changes unexpectedly | Discard stale assumptions, observe again, rebind controls, and replan. |
| Validation error appears | Convert it into an unresolved requirement and repair it before continuing. |
| Price, currency, airport, or itinerary changes | Compare with the approved state and require authorization when outside policy. |
| CAPTCHA, OTP, bank approval, login, or legal acceptance | Pause and hand off with exact instructions, then resume from fresh state. |
| Recovery budget is exhausted | Stop safely and explain the exact unresolved requirement and attempted strategies. |

## Exact build order

The order below follows technical dependencies. Each item should establish a reliable contract for the items after it. Later components may be prototyped earlier, but they should not become correctness-critical until their dependencies are complete.

| Order | Component to build | What it must include | Why it comes here | Done when |
|---:|---|---|---|---|
| 1 | **Universal checkout model** | Canonical schemas for stages, surfaces, passengers, logical fields, decisions, options, prices, blockers, approvals, payment readiness, and terminal states. | Every other component needs the same vocabulary. Without it, each layer reinterprets the page differently. | Extension, backend, planner, executor, and verifier exchange the same versioned objects without dropping or redefining semantic data. |
| 2 | **Stable logical control identity** | Unique logical IDs, component roles, surface ownership, state, actuator references, rerender fingerprints, and relocation rules. | Fly must know exactly which logical control an action targets before it can execute or verify anything reliably. | Two different choices never share an identity, and the same logical control can be safely rebound after a rerender. |
| 3 | **Fresh multimodal observation** | DOM, accessibility, visible text, screenshot regions, geometry, visibility, overlap, browser events, navigation, validation, selected state, price evidence, and canvas/iframe evidence where required. | The canonical model and identities need current, independent evidence from unfamiliar pages. | Every observation reports what is visible, actionable, selected, blocked, and foreground-owned with explicit evidence and confidence. |
| 4 | **Foreground ownership and readiness** | Active modal/drawer/dropdown detection, background suspension, hydration/loading classification, and foreground-first stage inference. | Fly cannot choose the next requirement correctly if background controls override the surface the user must handle now. | The Kiwi seat modal and equivalent foreground cases become `READY` and own the next action even when older controls remain behind them. |
| 5 | **Logical field adapter** | Scalar fields, split dates, phone components, document fields, custom dropdowns, autocomplete, calendars, validation errors, and hierarchical completion. | Raw controls must become traveler requirements before profile data can be applied safely across different markup. | Known profile values compile into deterministic component-level operations without losing metadata across system boundaries. |
| 6 | **Durable task state and reconciliation** | Verified completions, unresolved requirements, decisions, approvals, selected/declined extras, prices, checkpoints, failures, and contradictions. | Once observation is trustworthy, Fly needs memory that preserves real progress without overruling fresh evidence. | A fresh contradiction reopens the relevant requirement, while unrelated verified progress remains intact. |
| 7 | **Requirement and decision engine** | Explicit decision IDs, types, options, required/optional status, selected outcome, risk, evidence, policy compatibility, and blockers. | Profile policy cannot safely operate on vague page text; it needs structured unresolved decisions. | Fly can always explain what remains unresolved and why checkout may or may not continue. |
| 8 | **Profile and policy engine** | Hard safety rules → traveler facts/preferences → trip instructions → product defaults → bounded judgment; plus price and itinerary tolerances. | Only after decisions are explicit can Fly distinguish facts it knows, choices it may make, and choices requiring the user. | Fly never invents identity or preference data, and identical policy inputs produce consistent decisions. |
| 9 | **Grounded candidate builder** | Current candidates tied to canonical controls, exact surface, supported operation, actionability, policy result, risk, and semantic outcome. | Both deterministic logic and AI need one safe, finite action space. | Nothing can be selected unless it exists in the current observation and is relevant, actionable, and policy-allowed. |
| 10 | **Hierarchical planner and reusable skills** | Journey objective, reusable closed-loop skills, and compilation into exactly one atomic action per turn. | Planning becomes useful only after the state, requirement, policy, and available actions are trustworthy. | Form, fare, baggage, seat, insurance, dialog, review, and navigation skills advance one verified action at a time. |
| 11 | **Bounded AI ambiguity resolver** | Interpretation of unfamiliar surfaces and choices using only supplied candidates, evidence, profile context, and allowed semantic outcomes. | AI should fill only the gap that deterministic contracts cannot resolve; it should not own identity, state, or execution. | The model cannot invent a control, value, permission, or action outside the current candidate set. |
| 12 | **Deterministic execution and freshness plane** | Atomic commands, observation versions, control fingerprints, short action leases, target rebinding, local revalidation, and stale-action refusal. | A correct plan is unsafe if the page or target changed before execution. | Every action revalidates its exact assumptions immediately before execution and refuses stale, ambiguous, or unproven targets. |
| 13 | **Semantic postcondition verifier** | Outcome contracts for data entry, selection, dismissal, transition, policy resolution, price preservation, and payment-review readiness. | Execution success is not task success. Fly must prove what changed before storing progress. | No action is marked complete from an event acknowledgement alone; a fresh observation proves the intended semantic result. |
| 14 | **Recovery and uncertainty router** | Failure classification, bounded retry, relocation, alternate actuator, re-observation, checkpoint return, loop detection, user question, and precise handoff. | Once actions and verification are dependable, failure can be recovered without corrupting state or guessing. | Every failure ends in verified recovery, one minimal user request, or a clear safe stop—never an infinite loop or false completion. |
| 15 | **Safety and transaction governor** | Paid-extra constraints, identity protection, itinerary/airport/currency/price checks, irreversible-action boundaries, action ledger, and duplicate-attempt protection. | Safety checks exist earlier through policy, but the full transaction layer needs verified state, actions, and outcomes to enforce end-to-end invariants. | Unauthorized paid, legal, payment, purchase, identity, or itinerary actions are structurally impossible. |
| 16 | **Replay and regression infrastructure** | Sanitized DOM/accessibility/screenshot observations, decisions, candidates, actions, outcomes, failures, and production-shaped browser fixtures. | The full loop must now be improved with repeatable evidence instead of repeated manual live bookings. Initial traces should be captured throughout earlier work. | Every real-site failure becomes an offline replay, and engine changes must pass all previously accepted behaviors. |
| 17 | **Cross-airline coverage and lightweight adaptation** | Generic injection, control aliases, reusable UI patterns, known component actuators, dialog signatures, canvas behavior, failure signatures, and a semantic coverage matrix. | The universal contracts must be proven before site knowledge is allowed to optimize coverage. | A new airline mainly adds patterns and tests, never a separate end-to-end checkout script. |
| 18 | **Secure shared platform** | Encrypted profile/policy storage, task-state synchronization, approvals, audit history, authentication boundaries, and notifications. | Browser-only reliability should be proven before moving sensitive state and authority across devices and runtimes. | One authoritative task can be viewed, approved, paused, and resumed securely from multiple clients. |
| 19 | **Background execution runtime** | Isolated remote browsers, durable jobs, checkpoints, retries, resumability, secure session handoff, and CAPTCHA/OTP/login/approval pauses. | Background autonomy reuses the same proven model, planner, governor, executor contract, and verifier through a new actuator. | A background task can pause and resume without duplicate actions, lost progress, or different safety behavior from the extension. |
| 20 | **iOS product and permitted actuators** | Profile management, live task status, approvals, interventions, deep-link resume, notifications, and platform-permitted observation/execution. | iOS should be another interface and actuator around the shared engine, not an independently implemented agent. | Users can start, monitor, approve, intervene in, and resume the same authoritative Fly task from iOS. |
| 21 | **Optional authorized payment and confirmation** | PCI-appropriate vault, narrow approval tokens, final checksums, idempotency, duplicate-booking detection, PNR/ticket/total verification, and explicit terminal states. | This is a separate, higher-risk product boundary and should follow proven checkout-to-payment-review reliability. | Fly never performs an irreversible action without auditable authority and never reports confirmation without independent booking evidence. |

## Component specifications

### 1. Universal checkout model

- **What it is:** The shared, versioned language used to describe every checkout independently of airline-specific wording or HTML.
- **How it works:** It normalizes observations into canonical stages, surfaces, travelers, fields, decisions, options, prices, blockers, approvals, and terminal states.
- **Goal:** Ensure every Fly subsystem has the same interpretation of the current checkout.
- **Purpose:** Prevent extension, backend, planner, executor, and verifier logic from creating contradictory versions of the same page.
- **Success criteria:** The same canonical object survives every system boundary without lost fields, changed meanings, or site-specific branches.

### 2. Stable logical control identity

- **Implementation status (2026-08-01):** Stable keys cross browser observation, backend aliases, bound actions, and post-rerender relocation. Current values and value-derived input meaning have been removed from identity; controlled-input replays and live Kiwi contact entry prove the replacement field retains its logical identity and normalized phone value. Wider rerender coverage continues under Components 16–17.
- **What it is:** A persistent semantic identity for each field, choice, and action control, separate from its temporary DOM node.
- **How it works:** It combines logical ID, component role, decision ownership, foreground surface, state, actuators, and rerender fingerprints, then safely rebinds to fresh physical elements.
- **Goal:** Always act on the intended logical control, even after dynamic page changes.
- **Purpose:** Prevent the dangerous case where Fly understands the right choice but clicks a different or stale target.
- **Success criteria:** Different options never share identities, and the same logical control can be relocated after rerenders without semantic drift.

### 3. Fresh multimodal observation

- **What it is:** A current, combined view of the checkout built from all useful browser evidence.
- **How it works:** It collects DOM, accessibility, visible text, screenshot regions, geometry, overlap, browser events, navigation, validation, selections, prices, and specialized iframe/canvas evidence.
- **Goal:** Describe what actually exists and is actionable now on an unfamiliar page.
- **Purpose:** Avoid trusting a single weak source such as HTML structure or screenshot interpretation alone.
- **Success criteria:** Each observation accurately reports visible controls, current values, selected options, blockers, prices, foreground ownership, and supported operations with evidence.

### 4. Foreground ownership and readiness

- **Implementation status (2026-08-01):** Destination-stage commitment is implemented and regression-tested across fast, slow-hydrating, foreground-error, and payment-review paths. Route paths and visible semantics are separate; loading shells remain transient inside the existing navigation lifecycle; destination-specific evidence is required before planning. The next milestone is live slow-site validation, followed by cross-airline coverage under Components 16–17.
- **What it is:** The contract that decides which active page surface currently owns interaction and whether it is ready for action.
- **How it works:** It detects modals, drawers, dialogs, dropdowns, overlays, loading states, and hydration, then temporarily suspends unrelated background controls.
- **Goal:** Make Fly handle the surface directly in front of the user before reasoning about the page behind it.
- **Purpose:** Prevent background fields or an unchanged URL from incorrectly blocking an actionable foreground decision.
- **Success criteria:** Foreground surfaces such as the Kiwi seat modal become ready and own the next action even when older traveler controls remain visible behind them.

### 5. Logical field adapter

- **What it is:** The bridge from physical website controls to canonical traveler and contact requirements.
- **How it works:** It groups scalar and composite controls, assigns component roles, maps profile values to exact operations, and verifies completion hierarchically.
- **Goal:** Fill the same traveler fact correctly across different field layouts and widget implementations.
- **Purpose:** Handle split dates, phone prefixes, document components, custom dropdowns, calendars, autocomplete, and validation without per-site workflows.
- **Success criteria:** Known profile values compile into correct component-level operations and retain all semantic metadata through observation, planning, execution, and verification.

### 6. Durable task state and reconciliation

- **Implementation status (2026-08-01):** Requirement reconciliation is lifecycle- and owner-scoped and verified choices survive to final review. Terminal task state is dominant: mutually reinforcing owned review/payment evidence freezes payment, billing, legal, and generic work before planning; only unresolved contact email/phone may finish, after which verified transaction state latches completion. A derived process-awareness view exposes current semantic position, verified achievements, unresolved obligations, current objective, and final outcome without becoming a parallel action authority. Clean, dirty, modal, contact-boundary, and process-state replays pass, and the contract is live-proven on Kiwi. Cross-airline expansion follows under Components 16–17.
- **What it is:** Fly’s authoritative memory of verified progress across the full checkout.
- **How it works:** It stores completed requirements, decisions, approvals, extras, prices, failures, and checkpoints, then reconciles them against every fresh observation.
- **Goal:** Preserve real progress while immediately recognizing when the page contradicts previous state.
- **Purpose:** Avoid both forgetting completed work and continuing from stale assumptions.
- **Success criteria:** Contradictions reopen only affected requirements, verified unrelated progress survives, and state never overrides stronger fresh evidence.

### 7. Requirement and decision engine

- **What it is:** A structured inventory of everything that must be filled, chosen, declined, approved, or resolved before checkout can advance.
- **How it works:** It creates explicit IDs, types, options, required status, risk, evidence, policy compatibility, blockers, selected outcomes, and lifecycle states.
- **Goal:** Make the exact next unresolved checkout obligation explicit.
- **Purpose:** Prevent vague or contradictory states such as an extra being simultaneously declined and still pending.
- **Success criteria:** Fly can always state what remains unresolved, what evidence supports it, and why continuing is allowed or blocked.

### 8. Profile and policy engine

- **What it is:** The decision authority that translates user data and preferences into safe checkout choices.
- **How it works:** It applies hard safety rules, traveler facts and preferences, trip instructions, product defaults, and bounded judgment in a fixed priority order.
- **Goal:** Make checkout decisions correctly for the selected user rather than from generic assumptions.
- **Purpose:** Resolve fares, baggage, seats, insurance, flexibility, and price tolerance without inventing preferences.
- **Success criteria:** Known choices resolve consistently; missing facts and consequential uncovered choices result in targeted user questions rather than guesses.

### 9. Grounded candidate builder

- **What it is:** The finite list of actions Fly is currently allowed to consider.
- **How it works:** It binds the current requirement to observed controls, supported operations, exact surface ownership, actionability, risk, policy outcome, and expected semantic result.
- **Goal:** Give deterministic logic and AI a small, safe, current action space.
- **Purpose:** Prevent invented selectors, irrelevant controls, stale targets, and policy-conflicting actions from reaching selection.
- **Success criteria:** Every selectable candidate exists in the fresh observation, is relevant to the current requirement, is actionable, and passes policy.

### 10. Hierarchical planner and reusable skills

- **What it is:** The planning layer that connects the checkout objective to reusable capabilities and atomic actions.
- **How it works:** It chooses a journey objective, invokes a reusable closed-loop skill, and compiles only the next single action before observing again.
- **Goal:** Reuse reliable behavior without asking AI to reason from scratch for every keystroke.
- **Purpose:** Make form, fare, baggage, seat, insurance, dialog, review, and navigation behavior faster and more consistent while remaining closed-loop.
- **Success criteria:** Skills never run open-loop; every step uses a fresh observation, one action, and semantic verification before continuing.

### 11. Bounded AI ambiguity resolver

- **What it is:** The interpretation layer for genuinely unfamiliar or semantically ambiguous checkout surfaces.
- **How it works:** It receives page evidence, current requirement, user context, allowed outcomes, and a finite grounded candidate set, then selects one candidate or requests authority.
- **Goal:** Generalize to new airline interfaces without giving the model unrestricted browser control.
- **Purpose:** Use AI where flexible interpretation adds value while deterministic systems retain identity, permission, execution, and state authority.
- **Success criteria:** AI never invents a control, value, profile fact, permission, or action outside the supplied candidate contract.

### 12. Deterministic execution and freshness plane

- **What it is:** The narrow runtime that turns one approved atomic command into a browser interaction.
- **How it works:** It validates observation version, identity, fingerprint, surface, visibility, actionability, policy, and action lease immediately before dispatching click, type, select, scroll, wait, or navigation.
- **Goal:** Execute the intended current action and refuse anything stale or ambiguous.
- **Purpose:** Separate probabilistic planning from tightly controlled physical browser mutation.
- **Success criteria:** No stale, hidden, covered, mismatched, unproven, or unauthorized target is executed.

### 13. Semantic postcondition verifier

- **What it is:** The outcome checker that determines whether an action accomplished its intended task result.
- **How it works:** It compares fresh before-and-after evidence against explicit contracts for data entry, selection, dismissal, transition, policy resolution, price preservation, and readiness.
- **Goal:** Store progress only after the browser proves the desired semantic outcome.
- **Purpose:** Distinguish “an event was sent” from “the field was accepted,” “the modal closed,” or “the checkout advanced.”
- **Success criteria:** No mutation is marked complete from an acknowledgement alone, and every completion has fresh supporting evidence.

### 14. Recovery and uncertainty router

- **What it is:** The controlled response system for failures, surprises, and remaining ambiguity.
- **How it works:** It classifies the failure, then chooses bounded retry, relocation, alternate actuator, re-observation, checkpoint return, user question, or safe handoff while detecting loops.
- **Goal:** Recover from normal website instability without guessing or corrupting checkout state.
- **Purpose:** Make “works across airlines” mean failures are detected, contained, and handled correctly rather than assumed not to occur.
- **Success criteria:** Every failure ends in verified recovery, one minimal user request, or a precise safe stop; there are no infinite loops or false completions.

### 15. Safety and transaction governor

- **Implementation status (2026-08-01):** Core checkout-to-review state, durable outcome ledger, terminal dominance, pre-review transaction anchoring, and authoritative fact provenance are implemented, regression-verified, and live-proven on Kiwi. Trace `chk_msap7ph8zcet8r` preserved a pre-review Antalya → Istanbul anchor through transport, matched it with Basic Saver, traveler, currency, total, and authorized outcomes at final review, emitted `payment_review_reached`, and stopped before payment/billing/legal/card/purchase work. A stage label is no longer terminal authority; verified payment-review evidence latches before ordinary planning, while incomplete review freezes safely. Whole-page route/fare guessing, token-subset fare equivalence, and final-review self-seeding remain removed. **241 unit tests**, **116 browser replays**, and repository checks pass. Components 16–17 are now next: add the observed passenger-age route-noise replay, tighten endpoint evidence/deduplication, and prove the same contract on GoToGate plus a structurally different checkout.
- **What it is:** The final authority that enforces user permission and irreversible-action boundaries across the whole transaction.
- **How it works:** It checks paid extras, identity integrity, itinerary, airport, currency, price, legal acceptance, payment, purchase, action history, and duplicate-attempt risk before allowing actions.
- **Goal:** Make dangerous or unauthorized outcomes structurally impossible.
- **Purpose:** Protect the user from incorrect charges, changed travel, duplicate bookings, identity errors, and unapproved commitments.
- **Success criteria:** Unauthorized paid, identity, itinerary, legal, payment, and purchase actions cannot reach execution, even if another layer proposes them.

### 16. Replay and regression infrastructure

- **What it is:** A reproducible test system built from sanitized real checkout behavior.
- **How it works:** It captures DOM, accessibility, screenshots, canonical observations, state, decisions, candidates, actions, postconditions, and failures, then replays them offline and in browser fixtures.
- **Goal:** Turn every production failure into permanent, repeatable coverage.
- **Purpose:** Improve reliability without repeatedly depending on slow, costly, and unstable live booking sessions.
- **Success criteria:** Every material real-site failure has a regression, and all previously accepted behaviors must pass before engine changes ship.

### 17. Cross-airline coverage and lightweight adaptation

- **What it is:** Reusable knowledge that improves the universal engine on common and difficult airline UI patterns.
- **How it works:** It stores aliases, component patterns, proven actuators, dialog signatures, canvas behavior, known traps, successful trajectories, and failure signatures without owning full workflows.
- **Goal:** Expand coverage efficiently across direct airlines and structurally different OTAs.
- **Purpose:** Reuse proven site knowledge without turning every airline into a separate automation project.
- **Success criteria:** A new airline primarily adds patterns and regression cases, while universal contracts remain the correctness authority.

### 18. Secure shared platform

- **What it is:** The cross-device backend for sensitive profile data, policy, approvals, task state, notifications, and audit history.
- **How it works:** It encrypts stored and transmitted data, enforces authentication and authorization, synchronizes authoritative state, and exposes narrowly scoped approval and notification interfaces.
- **Goal:** Let browser, background runtime, and iOS safely participate in the same task.
- **Purpose:** Avoid fragmented user data, duplicated state, inconsistent permissions, and insecure credential handling across clients.
- **Success criteria:** One authoritative task can be securely viewed, approved, paused, resumed, and audited from multiple clients without leaking sensitive data.

### 19. Background execution runtime

- **What it is:** A secure remote-browser actuator capable of continuing Fly tasks without the user keeping an active checkout tab open.
- **How it works:** It runs isolated browser sessions as durable jobs with checkpoints, retries, resumability, session handoff, notifications, and pauses for CAPTCHA, OTP, login, or approval.
- **Goal:** Allow safe asynchronous checkout progress using the same intelligence as the extension.
- **Purpose:** Move from user-attended browser assistance toward dependable background task execution.
- **Success criteria:** Tasks pause and resume without duplicate actions or lost progress, and background execution obeys exactly the same policy and verification contracts as the extension.

### 20. iOS product and permitted actuators

- **What it is:** The mobile interface—and where platform permissions permit, an actuator—for the shared Fly system.
- **How it works:** It manages profiles, shows progress, receives notifications, collects approvals and interventions, resumes tasks through deep links, and sends authorized input to the shared task.
- **Goal:** Let users start, monitor, approve, intervene in, and resume Fly work from iPhone.
- **Purpose:** Make Fly available beyond the desktop without rebuilding the checkout intelligence as a separate iOS agent.
- **Success criteria:** iOS operates on the same authoritative task, policy, evidence, and approval history as browser and background clients.

### 21. Optional authorized payment and confirmation

- **What it is:** A future high-risk extension from verified payment review to authorized purchase and independently verified ticket confirmation.
- **How it works:** It uses a PCI-appropriate vault, narrow approval tokens, final passenger/itinerary/currency/price checksums, idempotency, duplicate protection, and confirmation evidence such as PNR or ticket number.
- **Goal:** Complete a purchase safely only when the product explicitly adopts this responsibility and the user provides auditable authority.
- **Purpose:** Prevent duplicate charges, unauthorized purchases, incorrect totals, and false claims that a payment or booking succeeded.
- **Success criteria:** No irreversible action occurs without explicit authority, and Fly reports `CONFIRMED` only from independent booking evidence rather than a click or payment acknowledgement.

### Immediate implementation sequence

The next work in the current repository is therefore:

1. Turn the live passenger-age false-route evidence into a permanent Component 16 regression.
2. Tighten the existing bounded route compiler with travel-endpoint semantics and canonical segment deduplication while preserving the live Antalya → Istanbul anchor.
3. Run the unchanged checkout-to-review contract on GoToGate and a structurally different airline/OTA.
4. Convert each new-site miss into a universal semantic pattern and replay; do not introduce a site-owned workflow.
5. Keep `payment_review_reached` as the current terminal product boundary and preserve the structural prohibition on payment, billing, legal, card, and purchase mutation.

### Current execution checklist

- [x] Latch `payment_review_reached` from strong owned evidence before ordinary planning.
- [x] Publish no payment, billing, legal, newsletter, Edit, or generic candidate after the terminal latch.
- [x] Remove mutable values from stable logical identity and verify phone rerender continuity.
- [x] Reject unowned generic route pairs and certify the owned Kiwi itinerary.
- [x] Fix foreground ownership and readiness with the Kiwi seat-modal replay.
- [x] Reconcile verified task state and expose the exact next unresolved requirement.
- [x] Apply profile policy and produce only grounded, safe candidates.
- [x] Execute fresh atomic actions and verify their semantic postconditions.
- [x] Pass Kiwi checkout-to-payment-review acceptance.
- [ ] Reject route-shaped passenger/age copy without losing legitimate untagged itinerary routes.
- [ ] Prove the same terminal contract on GoToGate and a structurally different checkout.
- [ ] Pass clean and dirty GoToGate regressions.
- [ ] Pass one direct airline and one structurally different OTA.
- [ ] Convert every new failure into a replay test and rerun the full suite.

## Success metrics

- Percentage of eligible checkouts reaching verified payment review without intervention.
- Percentage completed after safe autonomous recovery.
- User handoffs per checkout and whether each handoff was necessary and actionable.
- Incorrect field, extra, fare, seat, itinerary, price, and completion decisions.
- Unsafe or unauthorized actions, with a target of zero.
- False completion reports, with a target of zero.
- Median actions, model calls, latency, and cost per completed checkout.
- Fresh-site success across component patterns not present in the training and replay corpus.
- Regression pass rate across all previously supported sites and difficult components.

## Architectural rules

1. Fresh combined page evidence is authoritative; durable state is verified memory.
2. Every logical control has one stable identity and explicit surface ownership.
3. AI interprets ambiguity but never invents controls, profile facts, or permission.
4. The executor accepts only grounded, current, policy-safe atomic actions.
5. Every state-changing action requires a semantic postcondition from a fresh observation.
6. Recovery is bounded, recorded, and scoped to the exact requirement or control.
7. A failed requirement does not erase verified progress or block unrelated executable work.
8. Consequential ambiguity goes to the user; mechanical ambiguity goes to bounded recovery or grounded AI.
9. Site knowledge may improve performance but may not override the universal contracts.
10. Browser, background, and iOS runtimes share one checkout model, policy system, task state, and verification logic.

## Final architecture statement

```text
Universal checkout intelligence
+ browser extension actuator
+ future secure background-browser actuator
+ future iOS interface and permitted actuators
+ shared encrypted profile, policy, approval, and task-state platform
```

The durable competitive advantage is not an AI that clicks more intelligently. It is a universal checkout execution system in which AI handles genuine ambiguity while deterministic contracts control identity, state, execution, verification, recovery, and safety.
