# Fly — Agent Rulebook

## Goal

Build one reusable checkout agent that works across unfamiliar airline sites. Do not build airline-specific workflows.

Current milestone: complete all authorized pre-payment checkout work, verify that real card-entry controls have been reached, and stop before entering payment credentials, paying, or purchasing.

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

### 3. Add only the highest-leverage component

Add something only when removal, simplification, or correction cannot solve the problem.

Choose the smallest universal component that creates an order-of-magnitude improvement. It should solve a class of failures across unfamiliar sites, not one airline or one trace.

Use the simplest design that fully removes the bottleneck. More code, more layers, and more generality are costs—not signs of a better solution.

Complexity must earn its existence. Every new layer, state, abstraction, or fallback must solve a demonstrated problem that a simpler correction cannot solve.

Priority:

```text
remove unnecessary complexity
→ correct or reconnect existing authority
→ add one missing universal primitive
→ never stack patches around symptoms
```

## Engineering rules

- One authority per fact, decision, obligation, action, and result. Everything else is derived or diagnostic.
- Follow the last verified fact in the trace. Never treat an intended effect as observed success.
- Repair the universal owning layer, not the discovering airline.
- Do not reopen completed or optional work without fresh evidence.
- Keep recovery bounded and remember failed strategies.
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
