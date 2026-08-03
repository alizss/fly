# Fly Agent Operating Guide

## Core mission (always)
From a flight chosen in cart, this agent must complete checkout on unfamiliar airline/OTA sites in a universal way:
- Understand current checkout decision state.
- Compile each decision into a canonical semantic effect contract.
- Apply traveler profile policy to select one exact action.
- Execute only grounded actuators on the observed page.
- Verify observed effects.
- Continue only when proof is complete.
- Stop at verified payment review, never trigger payment/card actions.

## Why this exists
Our success depends less on per-site button labels and more on a robust, reusable decision pipeline.

## Current non-negotiable components
1. Decision Evidence = what is actually on the page now.
2. Decision-Effect Compiler = what the decision changes if accepted/rejected/selected.
3. Profile Resolver = which decision is allowed/preferred from user policy.
4. Grounded Actuator = exact button/link/input to execute.
5. Verifier = checks whether the action changed the page as expected.
6. Outcome Journal / Transaction Ledger = durable proof that the right decisions were applied.
7. Transition Readiness = strict rules for moving to next step (seat, insurance, bundles, contacts, review).

If any stage lacks one of these links, we are not at a universal solution.

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
- Remove heuristic guesses like "continue always means safe", "no thanks always free", "any matching label satisfies decision".
- Remove navigation readiness that depends on stale or non-durable markers.
- Remove broad route parsing where it overfits unrelated text as route data.
- Remove any rule that asks user without bounded evidence deadline.

## What must always stay
- Outcome verification before final success.
- Bounded reobserve/retry loops with timeout.
- Stale-action and duplicate-action refusal.
- Route evidence dedup + richer-route merge rules.
- Explicit policy-boundary checks for paid extras and unsupported actions.

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
