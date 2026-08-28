# Fly — Agent Rulebook

## Goal

Build one reusable checkout agent solution that works across unfamiliar airline sites, OTEs, and so on.
Do not build airline-specific workflows.
Goal is this for future long term to work on web/extension/ios app and so on aka engine.
It has to complete checkouts airline and based on user context profile and reach the payment stage dealing with all unfamilirites and obstacles, reason and figure it out to reach the goal.

Current milestone: given an authoritative selected booking, a selected traveler,
a complete profile, and standing checkout policy, one explicit Start must complete
all authorized routine pre-payment work on an unfamiliar airline/OTA checkout,
verify that real card-entry controls have been reached, and stop before entering
payment credentials, paying, or purchasing.

Routine checkout is zero-intervention. Ordinary profile fields, authorized
free/included choices, declined paid extras, standard terms, card-route selection,
navigation, and redirects must not ask the user or require a manual restart.
Questions are reserved for genuine exceptions such as missing profile facts,
CAPTCHA/login/OTP, unavailable inventory, exceptional declarations, or a material
itinerary/traveler/currency/price conflict outside explicit profile authority.

`SelectedBooking` is a startup invariant, not something checkout pages may
manufacture later. It must be supplied by the booking-selection owner or captured
from an explicit user flight/fare selection before Start, persisted with checkout
lineage, and locked for the durable session. Current-page observations compare
against it; they never promote themselves into transaction approval.

## How to think

Use this order whenever analyzing a trace, debugging, fixing a failure, or choosing the next step.

Two rules always apply:

1. A visible bug is usually a symptom or evidence. Find the deeper root bottleneck that allowed the whole class of failures, rather than fixing only the surface case.
2. Keep the solution as simple as possible. Do not add architecture, abstractions, state, or special cases unless they are necessary to remove the root bottleneck.

### 1. Simplify first

Ask:

- What is overcomplicated or overengineered?
- What duplicate authority, abstraction, workaround, compatibility layer, or stale state is constraining the system?
- What is blocking the existing solution from working?
- What can be removed, merged, demoted, or made derived?

Do not propose a new component until this is answered. Prefer deleting the cause over adding code around its symptoms.

### 2. Find the root bottleneck

Before changing code:

1. Define what must be true.
2. Find the earliest point where it stops being true.
3. Separate the root bottleneck from later symptoms.
4. Prove the hypothesis: it must explain the failure and predict which downstream problems the fix will remove.
5. Make the smallest change that restores the invariant.
6. Add a test at the owning boundary so the entire failure class cannot silently return.

Then ask:

- Is this the real cause, or only the place where a deeper problem became visible?
- What single core fact, capability, or contract is missing or wrong?
- Which owning layer should produce it?
- If it becomes true, which downstream failures disappear automatically?

Trace the failure upstream until you find the earliest incorrect or missing truth that explains the whole class of symptoms. Fix that root bottleneck first. Do not patch the visible bug and leave its cause in place.

Do not assume the root cause is large. Choose the smallest cause that fully explains the evidence.

### 3. Only if still necessary, challenge any addition

Here, a component means any module, service, planner, compiler, store, verifier, adapter, abstraction, state, fallback, or code path that owns system behavior.

Before adding one, challenge whether it should exist at all. First search the codebase for who already owns the same fact, decision, lifecycle, or capability.

Ask:

- Does this responsibility already exist somewhere?
- If it exists but is failing, why are we not fixing, simplifying, or replacing its current owner?
- Can an existing owner handle this responsibility?
- Can removing or simplifying something make the addition unnecessary?
- Does it own one necessary responsibility that nothing else should own?
- Would the system be clearer and still correct without it?

Never create a second component to compensate for an existing component that is incomplete, constrained, or broken. That creates conflicting authorities, duplicated state, and inconsistent behavior. Fix, simplify, reconnect, replace, or remove the existing owner instead.

If the addition cannot prove a new, necessary, non-overlapping responsibility, do not add it.

Never force an addition, component, layer, abstraction, state, fallback, or code path into the solution. Adding nothing is the preferred outcome when removal, simplification, correction, reconnection, or reuse fully solves the root bottleneck.

Add something only when removal, simplification, or correction cannot solve the problem.

Choose the smallest universal component that creates an order-of-magnitude improvement. It should solve a class of failures across unfamiliar sites, not one airline or one trace.

Use the simplest design that fully removes the bottleneck. More code, more layers, and more generality are costs—not signs of a better solution.

Complexity must earn its existence. Every new layer, state, abstraction, or fallback must solve a demonstrated problem that a simpler correction cannot solve.

### Universal unfamiliarity test

Always think universally. Fly's goal is to handle unfamiliar sites, encounter obstacles, reason from fresh evidence, and figure out a safe path to the goal.

Before accepting a solution, ask:

- What unfamiliar site structure or obstacle would break this assumption?
- Does the solution teach a reusable capability, or only encode the discovering site and trace?
- Can the engine infer what to do from evidence when labels, layout, order, controls, or navigation differ?

Use adversarial counterexamples to test the abstraction. Never solve unfamiliarity with an airline-specific condition or a memorized workflow.

Priority:

```text
remove unnecessary complexity
→ correct or reconnect existing authority
→ add one missing universal primitive
→ never stack patches around symptoms
```

## Engineering rules

- One authority per fact, decision, obligation, action, and result. Everything else is derived or diagnostic.
- A replacement is incomplete while the old component, fallback, state, or decision path can still compete with it. Remove the superseded authority.
- Prefer fewer authorities, states, transitions, and recovery paths. Make invalid or contradictory states impossible where practical.
- Follow the last verified fact in the trace. Never treat an intended effect as observed success.
- Repair the universal owning layer, not the discovering airline.
- Do not reopen completed or optional work without fresh evidence.
- Keep recovery bounded and remember failed strategies.
- Never repeat the same failed strategy without new information. Every retry must use changed evidence, conditions, or mechanics.
- One exact canonical actuator has one feasibility authority. Execution may revalidate current identity, visibility, enabled state, hit testing, surface ownership, and operation compatibility, but it must not contradict the observer with a generic CTA-size heuristic; native radios and checkboxes are valid small targets.
- A repeat-prohibited failure before dispatch is still a failed strategy. Persist it at the target-local semantic scope, clear stale selection, consume the finite budget, and choose a distinct actuator instead of repeating the same plan.
- Verify the exact fix and its downstream effect with a trace-derived replay, focused tests, the full relevant suite, and a retained canary.
- Never weaken safety merely to make a site pass.

## Safety boundary

- Preserve traveler, itinerary, price, currency, paid-choice, legal, and transaction identity.
- Respect explicit profile and booking policy; do not hard-code one user's preferences as universal behavior.
- Stop only when real owned card-number, expiry, and security-code controls—or an owned hosted card widget—are present.
- A page labeled Pay, a review page, legal consent, or a payment-method selector is not card-entry completion.
- Under the current milestone, never enter payment credentials, press Pay, or purchase.
- Ask the user only for genuinely missing personal facts, material transaction decisions, exceptional authority, or external challenges such as login, OTP, CAPTCHA, 3DS, or bank approval.

## Final check

Before finishing any analysis or fix, answer:

1. What did we remove or simplify?
2. What was the highest upstream blocker?
3. Why does this fix solve downstream failures?
4. Did we add only the smallest necessary universal capability?
