# Fly Coverage Matrix

Last updated: 2026-08-03 CEST

## Purpose

This file is the current evidence-based answer to:

- Which universal checkout capabilities are proven?
- Which capabilities are replay-only, partially proven, failing live, or untested?
- Which sites have reached Fly's current terminal boundary?
- What is the next highest-leverage gap?

Use the documentation files as follows:

- `FLY_FINAL_ROADMAP.md` — product goal, architecture, and build order.
- `FLY_PROGRESS.md` — chronological engineering and live-test history.
- `FLY_COVERAGE_MATRIX.md` — current capability and site acceptance truth.

## Current milestone

Fly must take a selected flight through an unfamiliar airline or OTA checkout by:

1. Understanding the current page and foreground surface.
2. Filling the selected traveler's known facts.
3. Resolving reversible fares, bags, seats, insurance, and extras from explicit profile policy.
4. Recovering safely from rerenders, hydration, custom controls, and multi-surface interactions.
5. Verifying the authorized itinerary, selections, currency, and total.
6. Reaching verified payment review.
7. Stopping before payment entry, legal acceptance, or purchase.

Success is not limited to completing a site. A correct result may also be a precise user question or a safe, diagnostic stop when authority or a supported capability is genuinely missing. Fly must never guess, loop indefinitely, perform an unauthorized action, or report false completion.

## Status legend

| Mark | Meaning |
|---|---|
| ✅ | Proven at the indicated level with exact semantic verification. |
| 🧪 | Proven by automated replay but fresh live acceptance is still pending. |
| 🟡 | Partially proven or known coverage is incomplete. |
| ❌ | Current live evidence disproves completion. |
| ⏳ | Not tested yet. |
| — | Not applicable to that site or acceptance journey. |

## Current verification baseline

| Verification layer | Current result | Notes |
|---|---:|---|
| Production build, type, and syntax checks | ✅ | Current worktree passes `npm run check`. |
| Agent unit suite | ✅ 266/266 | Includes receipt-only expectation authority, stale-page sibling isolation, exact foreground-child aggregation, explicit/fallback lineage separation, compact resolved-target ownership, canonical payment coverage, typed paid-effect denial, and stale-episode recovery. |
| Browser replay set | ✅ 127/127 | Full current matrix passes, including retained-open Flexible Ticket, exact foreground Next, dirty sibling repair, both seat legs, review submit/dismiss separation, hydration, transport, and terminal safety. |
| Targeted terminal and multi-surface replay | ✅ | GoToGate terminal evidence, hidden-future-payment rejection, checkpoint safety, Flexible Ticket, and the repeated-leg seat episode are proven without exposing payment capabilities. |

## Universal capability coverage

| Capability | Unit | Browser replay | Kiwi live | GoToGate live | Overall status | Current evidence / next proof |
|---|---:|---:|---:|---:|---|---|
| Scalar text and email entry | ✅ | ✅ | ✅ | ✅ | Proven | Email, confirm-email, name, and contact-field flows have verified normalized values. |
| Stable logical identity across controlled rerender | ✅ | ✅ | ✅ | 🟡 | Broadly proven | Kiwi phone replacement/rebinding is accepted; retain GoToGate rerender coverage as checkout expands. |
| Native select with exact enum identity | ✅ | ✅ | ✅ | — | Proven | Kiwi nationality selects canonical Slovenia without substring mutation. |
| Editable autocomplete query → exact option → settled commit | ✅ | ✅ | ✅ | ❌ intermittent | **Live branch incomplete** | GoToGate sometimes commits `+386` directly and sometimes leaves exact `Slovenia (+386)` open. The direct branch passes; the open-dropdown branch currently loses logical-field continuation and stops. |
| Composite phone field ownership | ✅ | ✅ | ✅ | 🟡 | **Cross-site semantics proven; GoToGate settlement intermittent** | Profile data is correct and direct commit passes, but the active country-option surface must remain owned by the phone component until exact selection settles. |
| Canonical DOB and split-date handling | ✅ | ✅ | ✅ | ✅ | Proven | Canonical DOB verification works across native, scalar, and split controls. |
| Custom dropdown option binding | ✅ | ✅ | ✅ | 🧪 | Regression repaired; live recertification pending | Exact free option → child decline → retained-open completed parent now restores only its owning opener and never republishes a paid option. |
| Foreground surface ownership | ✅ | ✅ | ✅ | ✅ | Proven | Latest GoToGate run correctly blocked the background phone field while the country dropdown remained active. |
| Multi-surface parent/child decision episode | ✅ | ✅ | ✅ | 🧪 | Proven by exact replay; live recertification pending | Explicit lineage and fallback context are separate; exact actuator/postcondition evidence preserves the parent across stripped browser transport. |
| Exact completed-parent surface exit | ✅ | ✅ | — | 🧪 | Regression replay-proven; live recertification pending | The exit worked live in `chk_mscf4cw69xjhdj`; the discovering regression is now covered by an exact retained-open-parent replay that publishes only the owning opener. |
| Optional negative marketing handling | ✅ | ✅ | — | ✅ | Proven | Silent profile policy no longer turns newsletter opt-out into a required decision. |
| Paid bundle price/effect ownership | ✅ | ✅ | — | 🧪 | Repair replay-proven | Bidi/compact `EUR37.95` parses correctly, and typed `select_paid_option` is denied without exact authorization even if price/risk remains unknown. |
| Slow destination hydration and readiness | ✅ | ✅ | ✅ | ⏳ | Proven on Kiwi | Blank successor pages remain transient until destination semantics hydrate. |
| Fare, insurance, baggage, and seat policy resolution | ✅ | ✅ | ✅ | ✅ | Cross-site traversal proven | GoToGate resolved bundle, Flexible Ticket, both seat legs, final no-seat confirmation, and later ancillary declines from the profile. |
| Transaction fact provenance and durable reconciliation | ✅ | ✅ | ✅ | ✅ | **Cross-site live-proven** | `chk_msbqdht2llspb8` preserved owned outbound `AYT → SAW`, return `SAW → AYT`, Ali SIFRAR, 70 EUR base, 107 EUR total, and zero contradictions through the real payment transition. |
| Payment-review terminal detection | ✅ | ✅ | ✅ | ✅ | **Cross-site live-proven** | `chk_msbs0ud3trktks` produced seven terminal signals on GoToGate's hosted/custom page, `boundaryObserved=true`, verified transaction facts, and zero payment capabilities. |
| Terminal outcome dominance / final arbitration | ✅ | ✅ | ✅ | ✅ | **Cross-site proven** | Full current replay passes; `chk_msbvdlbsznwy56` returned `final_review` in the fresh terminal turn with `payment_review_reached` and verified transaction evidence. |
| Profile-control role eligibility | ✅ | ✅ | ✅ | ✅ | **Cross-site proven** | Full current replay keeps payment commands out of profile fields; GoToGate payment scope contained no false contact controls and the activation-only Pay command did not become email. |
| Collision-free outcome-ledger identity and admission | ✅ | ✅ | ✅ | ✅ | **Cross-site live-proven** | GoToGate trace `chk_msdar6yu7k7bor` retained eight distinct expected owners for bundle, Flexible Ticket confirmation, and six sibling extras. No sibling inherited its predecessor. Flexible Ticket still has extra compatible audit representations to compact, but they do not compete with expected identity. |
| Verified-action journal coverage | ✅ | ✅ | ✅ | ✅ | **Cross-site live-proven** | GoToGate reconciled 8/8 durable action receipts with `missingActionIds=[]`, `missingDecisionInstanceIds=[]`, complete coverage, verified transaction facts, and `payment_review_reached`. |
| No payment, billing, legal, card, or purchase action | ✅ | ✅ | ✅ | ✅ so far | Safety green | This invariant must remain green even on incomplete runs. |
| Typed recovery, loop detection, and precise stop | ✅ | ✅ | ✅ | ✅ | Proven safety behavior | GoToGate stopped with `UNAPPROVED_SELECTED_EXTRA` instead of bypassing transaction safety. Recovery remains dependent on truthful upstream commitment state. |

## Site acceptance matrix

| Site | Traveler/contact | Reversible decisions | Seats | Transaction facts | Payment review | Irreversible-action safety | Current result | Latest evidence |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Kiwi | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **Accepted baseline; fresh canary passed** | `chk_msdaz8oiuvr170` reached verified payment review in about 3m21s with 5/5 durable receipts reconciled, zero missing IDs, one safe stale refusal, and no irreversible action. |
| GoToGate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **Accepted baseline** | `chk_msdar6yu7k7bor` reached verified payment review in about 3m06s with 8/8 receipt obligations reconciled, zero missing IDs, complete transaction review, one correct destination-hydration wait, and no irreversible action. |
| Direct airline #1 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | Not selected | Choose after Kiwi and GoToGate are green on the same commit. |
| Structurally different OTA #2 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | Not selected | Choose for interaction structures not already covered by Kiwi, GoToGate, and the direct airline. |

## Active capability queue

| Priority | Capability / invariant | Roadmap owner | Current evidence | Promotion gate |
|---:|---|---|---|---|
| 1 | Third-site structural coverage begins without a new workflow. | #17 Cross-airline Coverage | Kiwi and GoToGate are accepted on the universal engine with safe payment-review stopping. | One direct airline reaches payment review primarily by composing existing capabilities; then one structurally different OTA does the same. |
| 2 | Compact compatible multi-step audit representations. | #6 + #13 + #15 | GoToGate coverage is correct and complete, but Flexible Ticket parent/confirmation evidence leaves 9 journal rows and 11 ledger rows for 8 expected receipts. | One semantic Flexible Ticket outcome remains user-visible while every exact action receipt stays independently reconcilable; no accepted traversal or safety behavior regresses. |
| 3 | Retain logical-field continuation across both custom-dropdown settlement branches. | #4 + #5 + #13 + #16 | The accepted GoToGate run committed `+386` and completed contact data. Earlier query-only runs remain regression evidence. | Query-only and direct-commit branches continue settling the same canonical phone-code component without a global missing-actuator stop. |

## Evidence promotion rules

A capability moves through these levels:

```text
Unit proof
→ browser replay
→ live proof on the discovering site
→ live proof on a structurally different site
→ established universal capability
```

Rules:

1. A click acknowledgement is never completion evidence.
2. A row becomes ✅ only when the intended semantic outcome is verified.
3. Replay-only proof remains 🧪 until a fresh live run exercises the implemented path.
4. A live contradiction immediately downgrades the affected capability, even if older tests remain green.
5. Safety is tracked independently from completion. A run may fail functionally while still passing irreversible-action safety.
6. A site is accepted only when it reaches verified payment review and performs no payment, billing, legal, card, or purchase action.
7. Site-specific end-to-end workflows do not qualify as universal capability proof.

## Failure intake and learning loop

Every material live failure must become one of:

| Classification | Required response |
|---|---|
| Universal contract defect | Add an exact replay, repair the owning canonical component, and run the complete regression matrix. |
| Reusable perception-pattern gap | Add a bounded component signature, alias, or actuator pattern without creating a site workflow. |
| Missing user authority | Ask one precise question; do not guess identity, preference, itinerary, or price authority. |
| Expected handoff | Pause for CAPTCHA, OTP, login, legal acceptance, payment, or another prohibited boundary. |
| Website failure | Detect, report, and stop without destructive recovery navigation. |

The engineering loop is:

```text
Live trace
→ sanitize and fingerprint
→ classify by capability
→ reproduce as a browser replay
→ repair the universal contract or reusable pattern
→ run all historical tests
→ rerun the discovering site
→ rerun one accepted live canary after material core changes
→ update this matrix
→ commit the checkpoint
```

## Safe self-improvement ladder

| Level | Automation | Status |
|---:|---|---|
| 0 | Capture sanitized traces and verified outcomes. | Implemented |
| 1 | Classify failures by roadmap component and interaction fingerprint. | Next after the current multi-surface decision-episode repair |
| 2 | Suggest missing replay fixtures and reusable component patterns. | Planned after several diverse live sites |
| 3 | Generate a patch proposal and run the complete matrix in isolation. | Later, human-reviewed |
| 4 | Open a reviewed change with evidence and rollback scope. | Later |
| 5 | Rewrite or deploy core safety behavior without review. | Prohibited |

Fly may learn actuator preferences, timing distributions, component signatures, and verified recovery patterns. It may never learn permission to purchase, accept legal terms, add paid extras, change identity, weaken safety, or treat an unverified outcome as success.

## Update checklist

After every material live run:

1. Record the tested commit/worktree identity and trace ID.
2. Update the site acceptance row.
3. Upgrade or downgrade every capability directly exercised by the run.
4. Add the discovered failure to the active capability queue.
5. Link the exact replay once created.
6. Record whether any irreversible action was planned, dispatched, or verified.
7. Update `FLY_PROGRESS.md` with the chronological explanation.
8. Update `FLY_FINAL_ROADMAP.md` whenever the trace changes a core component's implementation status or priority.

Do not add a new status document for the same purpose. Keep this file as the single current coverage matrix.
