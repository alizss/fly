# Fly — Current Progress

Last updated: 2026-08-12

This is the concise chronological engineering record. Current acceptance truth belongs in [FLY_COVERAGE_MATRIX.md](./FLY_COVERAGE_MATRIX.md); stable product scope in [FLY_VISION_PRD.md](./FLY_VISION_PRD.md); architecture and sequence in [FLY_FINAL_ROADMAP.md](./FLY_FINAL_ROADMAP.md).

## Current snapshot

| Question | Answer |
|---|---|
| Product milestone | Universal unfamiliar checkout to actual payment entry; exact legal approval when required; no credentials/Pay/commit/purchase |
| Architecture | One ObservationFrame → DecisionFrame → TaskState/CurrentObligation → mechanics → governor → ActionLease → verification loop |
| Automated baseline | 379/379 unit, 175/175 browser, `npm run check` |
| Live evidence | EasyJet, GoToGate, Kiwi, and Turkish reached the prior review milestone; Croatia exposed the legal-approval execution gap now closed in replay |
| Formal evidence gap | Fresh actual-payment-entry canaries and explicit intervention annotations |
| Highest-priority product gap | Cross-airline structural portfolio, not another architecture rewrite |
| Secondary gap | Browser observation/rescan and ambiguity latency |
| Safety target | Zero false terminal completion and zero unauthorized irreversible mutation |

## Active objective

Prove that the current universal loop transfers to unfamiliar structural families:

1. Lufthansa confirms the Turkish/full-service family.
2. Ryanair or Wizz confirms the EasyJet/low-cost family.
3. American or United adds US checkout conventions.
4. Emirates or Qatar adds long-haul nationality/document structure.
5. Croatia Airlines adds regional structure.
6. Trip.com or eDreams/Opodo adds a third OTA family.

Every failure must produce an exact replay and a universal repair. A new DOM, ordinary field, custom control, or unusual grouping is not an expected handoff.

## Latest implementation checkpoints

### 2026-08-10 — Strict checkout admission and transition settling

Commit: `21b5d57`

- New durable transactions require one complete `SelectedBooking/v1`.
- Browser itinerary/total facts and extension-selected traveler compose at one boundary.
- Startup uses one bounded mutation-driven acquisition and creates no provisional transaction on timeout.
- Resume uses only the durable baseline.
- A dispatched stage exit remains pending until material mutation or deadline and cannot be clicked repeatedly while settling.
- Exact delayed EasyJet/GoToGate acquisition and Kiwi-style Continue regressions were added.

Validation: 359/359 unit, 169/169 browser, and repository checks.

### 2026-08-10 — Repeat guard scoped to the action lease

Commit: `c7aeb89`

- The browser repeat guard no longer treats a reused DOM signature as the same checkout action.
- Exact replay of the same governed action lease remains blocked.
- A fresh authoritative action may immediately reuse the same physical Continue mechanic on a new stage.
- The existing backend execution episode remains the semantic duplicate authority.

Validation: focused regression, 359/359 unit, 169/169 uninterrupted browser, and repository checks.

### 2026-08-10 — Extension runtime ownership modularized

Checkpoint: `bb227e8`

- `runtime-context` is the sole browser runtime state owner.
- Observation, execution, verification, controller, diagnostics, acquisition, and UI responsibilities live in explicit modules.
- `runtime.js` remains the one integration/composition root and no second semantic authority was introduced.
- The earlier `pointBelongsToElement` extraction regression was repaired and covered.

### 2026-08-08 to 2026-08-10 — Backend and authority convergence

- TaskState reducer and turn loop were split by responsibility without splitting authority.
- Direct `CurrentObligation + DecisionFrame → mechanics` replaced goal-shaped compatibility round trips.
- `ActionLease/v1` became the sole enumerable execution wire contract.
- One compact `ExecutionEpisode/v2` replaced duplicate recovery/lifecycle state.
- DecisionFrame compiles meaning once; TaskState alone publishes work and terminal disposition.
- One bounded ambiguity resolver uses zero model calls for deterministic mechanics and at most one closed-ID call per ambiguous turn.
- Observation storage retains metadata while bounding active full payloads.
- Redundant `actionHistory` transport was removed.
- Backend loop exceptions remain typed and preserve session identity.

### 2026-08-08 — Diagnostic storage safety

- Transaction state and disposable diagnostics were separated.
- Trace sessions, screenshots, and JSONL logs gained age/count/size limits.
- A low-disk circuit breaker drops diagnostics rather than checkout work.
- Storage cleanup recovered tens of gigabytes without deleting transaction databases.

### 2026-08-04 to 2026-08-07 — Cross-site universal mechanics

- Turkish country-code query and exact option settlement became a bounded reusable adaptive episode.
- EasyJet hidden state/visible actuator ownership, exact title/age settlement, dormant branch exclusion, quantity/baggage progression, travel purpose, and payment boundary were repaired universally.
- GoToGate multi-surface Flexible Ticket, repeated seat legs, sibling extras, payment terminal evidence, and durable outcome coverage were reconciled.
- Kiwi split fields, rerender identity, seat hydration, and review boundary remained retained canaries.

## Latest live canaries

| Site | Session | Result | Wall time | Note |
|---|---|---|---:|---|
| EasyJet | `chk_msn4eao235a7in` | Verified payment review | 1m08s | Complete immutable baseline and safety green |
| GoToGate | `chk_msn4gnewrng0ai` | Verified payment review | 2m30s | Three model calls; largest remaining task latency |
| Kiwi | `chk_msn4k9vxkh0b6v` | Verified payment review | 1m27s | Zero model calls; repeat-guard correction followed |
| Turkish | `chk_msn3eboeqhka33` | Verified payment review | 1m39s | Full-service direct canary |

The canary tool reports these as `review_required` until operator intervention is explicitly recorded. Technical terminal/safety proof and formal autonomous acceptance are separate.

## What is proven

- Canonical traveler/profile fields across scalar, combined, split, native, custom, and rerendered controls.
- Active-surface ownership and dormant hidden-branch exclusion.
- Exact selected-booking admission and transaction reconciliation.
- One current semantic obligation and mechanics-only binding.
- Consequence-gated bounded adaptation for unfamiliar reversible mechanics.
- Exact action freshness, duplicate refusal, semantic verification, and bounded recovery.
- Fare, baggage, seat, insurance, and extras handling for the current baseline policies.
- Payment-review detection without exposing executable payment controls.
- Exact transaction-bound legal approval, one verified attestation action, and a separate advance to actual payment entry are covered by the closed-loop Croatia replay.
- No payment credential entry, Pay, transaction commit, or purchase.

## What is not yet proven

- A representative 8–10-site / 6-family structural portfolio.
- Four accepted direct-airline families and three OTA families.
- Confirmation-site transfer for important discovered repairs.
- Multi-adult, child, paid baggage, specific-seat budget, login/OTP, and price-change scenarios on two families each.
- Background/cloud-browser operational equivalence.
- A distributed approximately 300-journey reliability window supporting a broad `99%` claim.
- Production latency targets based on representative median/p95 evidence.
- Authorized payment, idempotency, 3DS, or independent booking confirmation.

## Next work

1. Record explicit intervention annotations for the latest four canaries.
2. Run Lufthansa controlled baseline; classify any failure before editing code.
3. Convert material failure into an exact replay and universal component repair.
4. Rerun the discovering site plus EasyJet or Kiwi retained canary.
5. Run Ryanair or Wizz confirmation baseline.
6. Continue the structural portfolio before the complex profile-policy Cartesian matrix.
7. In parallel, measure observation construction, serialization, transport, persistence, ambiguity calls, dispatch, and verification; optimize only proven hot paths.

## Update rule

Add an entry only for a material root-cause decision, implementation checkpoint, full validation, or live acceptance result. Keep detailed historical discussion in Git history and traces; keep the top snapshot and next work current.
