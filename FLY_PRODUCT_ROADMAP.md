# Fly Product Roadmap

**Last updated:** 2026-07-21
**Current verified milestone:** A live GoToGate checkout reached the payment page and stopped safely before payment entry or purchase.

This is the product-level roadmap: what to focus on next, in what order, and how to know when each phase is ready. Detailed architecture work and historical evidence remain in [`FLY_EXECUTION_TODO.md`](./FLY_EXECUTION_TODO.md) and [`P_AGENT_ARCHITECTURE_TRACKER.md`](./P_AGENT_ARCHITECTURE_TRACKER.md).

## Product Goal

Fly should reliably complete most airline and OTA checkouts from an already-selected flight to the payment page using the traveler's saved profile and booking preferences.

The current operating loop should stay simple:

```text
Observe the live foreground page
-> choose one grounded, safe, relevant action
-> act once
-> verify visible progress
-> repeat until fresh payment-page evidence appears
-> stop for user review
```

TaskState stores the durable goal, completed work, preferences, safety restrictions, and terminal payment status. It guides the agent but does not need to predict every intermediate page, popup, or button.

## Priority Order

```text
1. Preserve and repeatedly prove the working GoToGate flow
2. Handle generic form variations and unexpected surfaces
3. Prove the same engine across several airlines and OTAs
4. Expand traveler preferences and contextual decisions
5. Add a sandboxed, user-controlled payment handoff
6. Improve latency and investigate background/cloud execution
7. Polish the full UI/UX and later expand to iOS
```

The immediate focus is checkout reliability across different forms, surprises, and websites. Payment processing comes after reaching payment is consistently reliable.

---

## Phase 1 — Lock Down the Working Checkout Loop

- [ ] Save/checkpoint the current working version before further architecture changes.
- [ ] Add one automated regression test based on the successful GoToGate trace.
- [x] In that test, simulate:
  - [x] optional paid-extra decisions,
  - [x] multi-leg seat-map navigation,
  - [ ] a no-seat warning,
  - [x] the final review popup,
  - [x] `Continue to Payment`,
  - [x] verified payment evidence and a safe stop.
- [ ] Assert that the agent:
  - [x] reaches payment,
  - [x] does not select an unrequested paid extra,
  - [x] does not loop on a review close button,
  - [x] does not enter card details,
  - [ ] does not accept legal terms or submit a purchase.
- [ ] Run multiple live GoToGate checkouts covering:
  - [x] one-way and return itineraries,
  - [x] one and multiple flight segments,
  - [x] seat-map and no-seat-map variants,
  - [ ] different optional extras,
  - [ ] different valid traveler/profile inputs.
- [ ] Record for each run:
  - [ ] session ID,
  - [ ] whether payment was reached,
  - [ ] manual restarts or corrections,
  - [ ] user questions,
  - [ ] paid actions,
  - [ ] duration and repeated actions.

**Ready to move on when:** approximately 9/10 varied GoToGate runs reach payment without manual recovery, with zero unauthorized extras and a 100% safe stop at payment.

---

## Phase 2 — Handle Checkout Surprises Generically

This is the next main engineering focus.

### Form variations

- [ ] Support dates represented as:
  - [ ] `DD/MM/YYYY`,
  - [ ] `MM/DD/YYYY`,
  - [ ] `YYYY-MM-DD`,
  - [ ] separate day/month/year fields,
  - [ ] custom date pickers.
- [ ] Refuse ambiguous date formats instead of guessing.
- [ ] Support phone numbers with:
  - [ ] a separate country-code selector,
  - [ ] a combined international-number field,
  - [ ] local formatting and validation.
- [ ] Support different name layouts:
  - [ ] first/last,
  - [ ] first/middle/last,
  - [ ] combined full-name fields,
  - [ ] title or gender controls when genuinely required.
- [ ] Support address, postcode, nationality, document, and loyalty-field variations when required by the checkout.

### Control variations

- [ ] Native and custom dropdowns.
- [ ] Searchable comboboxes.
- [ ] Radio buttons, checkbox cards, and toggles.
- [ ] Buttons enabled only after validation.
- [ ] Controls rendered in portals, drawers, and nested scroll containers.
- [ ] Rerendered controls whose DOM identity changes after an action.

### Unexpected surfaces

- [ ] Modals, drawers, popovers, warnings, and confirmation dialogs.
- [ ] Cookie and region/language notices that block checkout.
- [ ] “Are you sure?” decisions.
- [ ] Multi-step seat maps and per-flight navigation.
- [ ] Intermediate review/confirmation pages.
- [ ] Validation errors, reset fields, and server-side feedback.
- [ ] Loading/partially hydrated pages without acting on incomplete observations.

### Simple recovery contract

- [ ] Observe fresh state after every meaningful action.
- [ ] Accept visible progress such as:
  - [ ] step or flight ordinal changed,
  - [ ] popup appeared, disappeared, or was replaced,
  - [ ] field/selection/validation state changed,
  - [ ] route or checkout stage changed,
  - [ ] payment evidence appeared.
- [ ] If nothing changes, re-observe and try a distinct grounded strategy.
- [ ] Ask the user only when no safe grounded interpretation remains.
- [ ] Do not add airline-specific step sequences or wording patches for generic problems.

**Ready to move on when:** the generic engine handles the common form/control/surface families above without manual restarts and without weakening payment or paid-extra safety.

---

## Phase 3 — Prove the Engine Across Airlines and OTAs

- [ ] Test Croatia Airlines.
- [ ] Test Turkish Airlines.
- [ ] Test American Airlines.
- [ ] Test at least one additional OTA or materially different SPA checkout.
- [ ] Include a mix of:
  - [ ] full-service airline checkout,
  - [ ] upsell-heavy or low-cost checkout,
  - [ ] OTA/custom-SPA checkout.
- [ ] For every failure, capture:
  - [ ] what was observed,
  - [ ] the chosen action and its evidence,
  - [ ] what actually changed,
  - [ ] the shared component that failed.
- [ ] Collect two or three similar failures before changing architecture when possible.
- [ ] Convert each confirmed shared failure into a reusable replay fixture.
- [ ] Avoid site-specific procedures; site knowledge may only add evidence, codecs, or risk hints.

### Metrics

- [ ] Checkout-to-payment success rate by site.
- [ ] Manual interventions/restarts per checkout.
- [ ] User questions per checkout.
- [ ] Repeated or ineffective actions per checkout.
- [ ] Incorrect paid extras: target `0`.
- [ ] Legal/payment actions without approval: target `0`.
- [ ] Safe payment-page stop rate: target `100%`.

**Ready to move on when:** the same core loop reliably reaches payment on at least three structurally different checkout engines without site-owned action sequences.

---

## Phase 4 — Expand Traveler Context and Preferences

Model preferences as constraints and desired outcomes, not fixed website procedures.

- [ ] Paid-extras default policy.
- [ ] Seat preference: window, aisle, middle, or no seat.
- [ ] Maximum acceptable seat price.
- [ ] Sit-together policy for multiple travelers.
- [ ] Hand and checked baggage preferences.
- [ ] Fast-track, priority boarding, or fast-check-in preference.
- [ ] Travel insurance preference.
- [ ] Meal, accessibility, and assistance requirements.
- [ ] Loyalty-program details.
- [ ] Ask the user when several acceptable options require personal judgment.
- [ ] Show which preference caused an action when useful.

**Ready to move on when:** preferences influence decisions consistently across sites without becoming full authority over page navigation.

---

## Phase 5 — Add Payment as a Separate, Safe Component

Do not make real payment the main focus until the cross-site checkout engine consistently reaches payment.

### First payment milestone: review and handoff

- [ ] Detect and verify the payment page using fresh evidence.
- [ ] Present the itinerary, selected options, and final total for user review.
- [ ] Require explicit user approval before entering any payment information.
- [ ] Use only test/sandbox payment pages and fake test cards during development.
- [ ] Keep payment actions separate:

```text
reach payment
-> user reviews booking and total
-> explicit approval to enter test credentials
-> authentication/user takeover if required
-> separate explicit approval for final purchase
```

### Security boundaries

- [ ] Never store or log raw card numbers or CVV.
- [ ] Prefer provider-hosted/tokenized payment fields.
- [ ] Stop and hand control to the user for:
  - [ ] 3-D Secure,
  - [ ] bank-app approval,
  - [ ] Face ID or platform biometrics,
  - [ ] SMS/email verification,
  - [ ] CAPTCHA.
- [ ] Require separate, explicit approval before final purchase submission.
- [ ] Verify the exact amount, currency, traveler, and itinerary immediately before submission.
- [ ] Treat legal acceptance, credential entry, authentication, purchase submission, and booking confirmation as different states and permissions.

**Ready to move on when:** sandbox payment entry and handoff are reliable, sensitive data is not persisted, and no irreversible action occurs without explicit approval.

---

## Phase 6 — Performance and Background/Cloud Execution

Reliability comes before optimization.

### Performance

- [ ] Measure p50/p95 time for observation, planning, execution, verification, and full checkout.
- [ ] Remove redundant observations, repeated candidate generation, and unnecessary model calls.
- [ ] Keep uniquely safe actions deterministic/model-free.
- [ ] Reuse already verified outcomes where safe.
- [ ] Provide immediate UI feedback even when a site is loading.
- [ ] Optimize only with regression proof that required controls and safety evidence remain available.

### Background/cloud execution

- [ ] Test background browser tabs first.
- [ ] Preserve authenticated sessions and recover from expiry.
- [ ] Design explicit user-takeover points.
- [ ] Investigate remote/cloud browser execution separately.
- [ ] Account for CAPTCHA, anti-bot checks, browser fingerprinting, 3DS, and session transfer.
- [ ] Never weaken payment safety to make unattended execution easier.

**Ready to move on when:** foreground reliability is preserved, measured latency improves, and background execution has clear authentication and takeover boundaries.

---

## Phase 7 — Product UI/UX and Platform Expansion

Basic safety controls should exist early; full polish follows engine reliability.

- [ ] Clear current-action and current-stage status.
- [ ] Pause, stop, resume, and take-over controls.
- [ ] Clear explanation when user input or approval is required.
- [ ] Final itinerary, selections, and price review.
- [ ] Useful failure and recovery messages.
- [ ] Checkout history without sensitive payment data.
- [ ] Reduce technical/debug language in the customer-facing interface.
- [ ] Full UI/UX refinement after the engine is stable.
- [ ] Explore iOS and other platforms after the shared engine and handoff model are proven.

---

## Decision Rule for New Engineering Work

Before adding another rule, enum, state layer, or site-specific behavior, answer:

1. Which reproduced failure does this solve?
2. Is the failure observation, grounding, policy, execution, verification, or recovery?
3. Can the smallest shared correction solve the whole failure class?
4. What replay will fail before the change and pass after it?
5. Does the change preserve successful checkout-to-payment behavior?

Do not redesign the architecture after one isolated site failure. Preserve the simple authority split:

```text
TaskState: durable objective, memory, preferences, safety, terminal status
Live page: current grounded possibilities
Planner: safest relevant next action
Verifier: whether meaningful progress actually occurred
```

## Current ToDo

- Fixed the picking seat bug, added components to revers and reason when wrong choices appere based on user profile.
- Fixing latency making faster due recent changes.
- Dealing with the observartion picking best most efficent route to the goal (continue vs x, if not, reason) aka planning.


### Tests GoToGate

- [x] Direct Way
- [x] Normal Checking Turkish Eastern EU
- [ ] EU International (London, Paris etc.)
- [ ] American Traveling
- [x] 2 legs and multi legs
- [x] Half way filled out and so on
- [x] Wrongly inserted data (wrong date, name, radio button or email)
- [x] Wrongly inserted wrong seats and so on.


Bug noticed

- Sometimes it goes ahead and returns back as forgot smth but i dont think this bad tbf just want to know why not in order.
- Wont fix if the messup or wrong fields like bundels, wrong radio buttons pick seats and so on it just continued didnt look back or rever. for the inputs it did fix so its good and for baggag maybe becuse explicitly said. Picks seats, baggage, flexible ticket, wrong raido buttons etc.
- Picking the most efficent route to the goal or prgoress not sure how to name this but. Wrote it down below.



### Overall Checklist

- [ ] Test on the multiple checkout on GoToGate reaching payments page
- [ ] Add payments component to solution (credit card fake and everything payment processing wise, FaceID or message verifications)
- [ ] Deal with suprieses, diff forms (e.g. How date is entered differently then we have it, Different radio buttons or dropdown, filters, buttons on difference checkouts)
- [ ] Different user profile context actions (Pick seats next to the window, or give me fast checkin and so on)
- [ ] Testing on multiple airlines checkouts tests (Croatia, Turkish, American and others)
- [ ] Ensuring minimal close subzero latency making it fast.
- [ ] Ensure making it work in background / cloud / no navigating on screen.
- [ ] Start focusing on UI / UX development once working smooth
(Later / Long term)
- [ ] Focusing on IOS and so on...


### Observations

1. Most or a lot of stuff are hidden like dropdown and so on so we need to test or ensure that if ai doesnt know or sure or if user profile needs to read to return or ask the user or pick the right choice if complex. As we will need to return information live ot user at some point etc.

2. Find the beast frictionless way to move forward. For example seat picking pop up has way to continue click x to close pop up or move forrward dont pick seats both way correct but one way is long other is click x pop up appers to contineu without seats and boom already on the next page while for other need to pick through each page to came ot that same stuff. Ofc if the goal is from user profile that seat picking irrelevant and dont want to pick it etc. of
