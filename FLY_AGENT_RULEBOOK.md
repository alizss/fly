# Fly — Agent and Engineering Rulebook

Last updated: 2026-08-10

## Core mission

Given an approved selected booking, traveler, and policy, Fly must complete an unfamiliar airline/OTA checkout to verified payment review, ask only when user facts or authority are genuinely required, and never perform payment, legal, or purchase actions under the current milestone.

Fly learns reusable checkout mechanics—not airline workflows.

## One runtime loop

```text
fresh immutable observation
→ compile meaning once
→ TaskState publishes one obligation/disposition
→ bind exact mechanics for that obligation
→ consequence governor
→ execute one leased action
→ fresh mechanical and semantic verification
→ persist compact verified facts
→ continue, recover, ask, stop, or finish review
```

Do not add a second semantic compiler, requirement lifecycle, planner, readiness authority, verifier, recovery store, or completion receipt.

## Responsibility rules

1. **Observation** reports mechanics, current state, ownership evidence, and transaction evidence.
2. **DecisionFrame** compiles semantic entities once.
3. **TaskState** alone decides what work exists and how the turn ends.
4. **Mechanics binder** finds actuators only for the admitted obligation.
5. **Governor** checks consequences immediately before execution.
6. **Browser verifier** proves the mechanic occurred.
7. **Transition verifier** proves the same semantic obligation was satisfied.
8. **Transaction review** independently reconciles the selected booking and outcomes.

Actionability does not create work. A model may choose only supplied fresh reversible candidate IDs. It may not invent targets, facts, obligations, effects, or permission.

## Behavior on unfamiliar sites

Fly should autonomously handle:

- New ordinary textboxes and textareas.
- Different DOM nesting, wrappers, and visual order.
- Combined or split names, DOB, phone, address, and document fields.
- Native/custom selects, autocomplete, portal listboxes, radios, cards, switches, and steppers.
- Rerendered controls with new physical identities.
- Shadow/portal/overlay surfaces when usable evidence exists.
- Offscreen controls, delayed hydration, localized labels, and reused Continue buttons.
- Optional blank fields and dormant login/signup/future-step representations.

The absence of an airline-specific skill is never a stop reason.

## Valid stop or pause reasons

- Required traveler data is genuinely missing.
- Login, OTP, CAPTCHA, 3DS, bank approval, or another human challenge is active.
- Legal, payment, purchase, identity, itinerary, price, currency, or paid-choice authority is missing or contradictory.
- Inventory is sold out, the session expired, the airline is unavailable, or valid completed input is rejected.
- Distinct safe grounded mechanics are exhausted after bounded recovery.
- Verified payment review is reached under the current milestone.

Exhausted mechanics on an otherwise eligible journey is an engineering coverage defect, not a desired product handoff.

Do not ask the user to diagnose DOMs, buttons, selectors, readiness, or internal agent mechanics.

## Non-negotiable safety

Always preserve:

- Exact selected traveler and booking identity.
- Exact target freshness and ActionLease identity.
- Stale-action and exact-duplicate refusal.
- Consequence governance for paid extras, route, dates, identity, price, currency, legal, payment, and purchase.
- Fresh semantic postcondition verification.
- Bounded recovery and failed-strategy memory.
- Transaction and outcome reconciliation.
- Zero payment/legal/card/Pay/purchase capability under the current milestone.

Never weaken safety to make a site pass.

## Failure triage

For every material live failure:

1. Identify the last verified obligation, action, and fresh surface.
2. Classify it as expected handoff, external website failure, or universal contract/mechanics defect.
3. Locate the owning layer: observation, semantic compilation, TaskState admission, mechanics binding, governance, execution, verification, recovery, or transaction review.
4. Add the smallest exact trace-derived replay.
5. Repair the universal component; never start with an airline conditional.
6. Run focused test, full unit suite, full browser suite, and repository checks.
7. Rerun the discovering site and one retained canary.
8. Confirm important repairs on a related second site.

## Simplification test

Remove or demote anything that independently:

- Re-discovers work after DecisionFrame/TaskState.
- Reinterprets policy during mechanics binding.
- Treats a declared effect as observed success.
- Persists turn-local candidate/observation graphs as semantic memory.
- Polls unchanged full observations instead of waiting for mutation/deadline.
- Converts diagnostics or compatibility state into runtime authority.

Do not remove distinct safety roles merely because they inspect related evidence. TaskState/governor, browser/backend verification, deterministic/adaptive mechanics, and transaction/payment boundaries serve different purposes.

## Acceptance after a fix

- The exact failure replay passes.
- No completed work reopens or loops.
- Correct profile/policy state survives navigation and rerender.
- 359/359 unit tests pass.
- 169/169 browser replays pass uninterrupted.
- `npm run check` and `git diff --check` pass.
- The discovering site and one retained canary pass.
- No unauthorized irreversible action executes.
- Manual intervention is explicitly annotated in the canary report.

## Documentation discipline

- PRD changes only for product scope, safety, or promotion gates.
- Roadmap changes for architecture status or engineering sequence.
- Coverage matrix changes for material live/site/scenario acceptance evidence.
- Progress changes for material implementation or root-cause decisions.
- Handoff stays current with code structure, commands, risks, and next work.
- Keep historical detail in Git history and sanitized traces, not duplicated across current documents.
