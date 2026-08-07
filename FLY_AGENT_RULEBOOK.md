# Fly Agent Operating Guide

## Core mission (always)
From a flight chosen in cart, this agent must complete checkout on unfamiliar airline/OTA sites in a universal way:
- Understand current checkout decision state.
- Compile each decision into a canonical semantic effect contract.
- Apply traveler profile policy to select one exact action.
- Execute only grounded actuators on the observed page.
- Verify observed effects.
- Use canonical semantics as the fast path; when semantics are incomplete, allow one exact low-consequence reversible mechanic through the shared governor and verifier.
- Continue only when the resulting state change is freshly verified.
- Stop at verified payment review, never trigger payment/card actions.

## Why this exists
Our success depends less on per-site button labels and more on a robust, reusable decision pipeline.

## Current non-negotiable components
1. Current Obligation = the one exact active requirement, decision, or stage exit Fly is solving now.
2. Decision Evidence = what is actually on the page now.
3. Decision-Effect Compiler = what the decision changes if accepted/rejected/selected.
4. Profile Resolver = which decision is allowed/preferred from user policy.
5. Grounded Actuator = exact button/link/input owned by the Current Obligation.
6. Verifier = checks whether the action changed the page as expected.
7. Outcome Journal / Transaction Ledger = durable proof that the right decisions were applied.
8. Consequence-Gated Adaptive Operator = the fallback that can try one exact current reversible control when canonical planning has no goal.
9. Transition Readiness = rules for moving to the next step (seat, insurance, bundles, contacts, review).

Transition Readiness owns only loading, hydration, and transport stability. It must not reinterpret semantic completeness, inherit a deadline from a different stage/surface/URL, or ask the traveler about internal mechanics. Once a destination is stable and exposes a checkout-relevant capability, the one runtime controller owns what to do next.

The full semantic chain is mandatory for consequential choices and completion. It is supporting evidence—not a veto—for a harmless, exact, reversible mechanic whose outcome can be observed immediately.

## How to triage failures (first principles)
When stuck, do not start with site-specific patches.

1. Confirm where it stops.
- stage id / step name
- what was waiting for
- what action was last performed

2. Decide if the issue is:
- missing decision interpretation (wrong meaning of page state),
- missing effect contract (action executed but result not represented),
- missing state continuity (no destination/action readiness binding),
- or page noise (irrelevant modal/ads/feedback overlay).

3. Fix the smallest universal layer first.
- Add/adjust parser or state transition logic.
- Do not add new per-site selectors unless the universal layer cannot represent behavior.

4. Re-run only after the fix is single-purpose.
- same flow should move forward, not reopen already completed choices.

## What to remove / simplify first
- Remove duplicate inferencing that re-derives meaning already provided by the compiler.
- Remove schedulers that skip the current field because its present actuator failed; keep the obligation and try bounded mechanics against it.
- Keep unknown-surface observations as context only. Generic ambiguity itself is never executable, but it may trigger one bounded task over exact current low-consequence controls.
- Remove heuristic guesses like "continue always means safe", "no thanks always free", "any matching label satisfies decision".
- Remove navigation readiness that depends on stale or non-durable markers.
- Remove broad route parsing where it overfits unrelated text as route data.
- Remove any rule that asks the user to diagnose internal mechanics. User questions are for missing profile facts, authentication/challenges, consequential choices, or authority boundaries.
- Remove any rule that promotes a positioned summary/sidebar to exclusive foreground from action words alone; blocking ownership requires structural evidence.

## What must always stay
- Outcome verification before final success.
- Bounded reobserve/retry loops with timeout.
- Stale-action and duplicate-action refusal.
- Route evidence dedup + richer-route merge rules.
- Explicit policy-boundary checks for paid extras and unsupported actions.
- Deterministic authority over identity, itinerary, price, legal acceptance, payment, purchase, and final completion.

## The one runtime loop

```text
Observe a compact fresh surface
→ prefer one canonical requirement/decision
→ otherwise admit one exact safe reversible control
→ consequence governor
→ execute one atomic action
→ fresh state-change verification
→ persist verified progress or try one distinct bounded mechanic
```

Do not add a second planner, a generic blocked-navigation journey, or another completion receipt. Semantic classifiers inform this loop; they do not independently stop it.

## Valid reasons to stop

- A required traveler fact is genuinely missing.
- CAPTCHA, OTP, login, bank approval, or another human challenge is active.
- A consequential choice lacks profile policy or explicit authority.
- Itinerary, price, currency, identity, legal, payment, or purchase evidence conflicts with the approved contract.
- The website is unavailable or rejects valid completed input.
- The bounded controller exhausted distinct grounded mechanics and reports an internal diagnostic.

Do not ask the traveler because Fly could not classify an ordinary enabled button or because an internal semantic goal is absent.

## Minimal test of a fix
Before moving to next bug:
- The same path no longer loops.
- The right profile choice is preserved across pages.
- `outcomeJournal` includes the executed verified decision outcomes.
- `transactionReview.outcomeLedger` is complete or explicitly blocked with reason.

## Progress discipline
Every run should update:
- `FLY_PROGRESS.md`
- `FLY_FINAL_ROADMAP.md`
- `FLY_COVERAGE_MATRIX.md`

Use short, skimmable entries:
- what blocked us,
- what fixed,
- what next,
- any regressions to watch for.

## Session handoff template
- User goal for this session:
- Current stage reached:
- Exact root bottleneck:
- Root fix applied:
- Evidence check:
- Risk of regression:
- Remove/simplify candidates:
- Next 1-2 moves:

## Core goal reminder
The long-term goal is not to optimize one airline.
The long-term goal is universal profile-safe checkout completion with evidence-backed state transitions across new airline and OTA sites.
