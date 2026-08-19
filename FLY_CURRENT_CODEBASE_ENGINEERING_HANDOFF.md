# Fly — Current Codebase Engineering Handoff

Last updated: 2026-08-19

Branch: `dev`

Latest implementation checkpoints before this documentation update: `21b5d57` and `c7aeb89`

## 1. Mission and current boundary

Fly takes an approved selected flight and traveler through an unfamiliar airline or OTA checkout, applies saved facts and policy, verifies every material result, reconciles the final transaction, and stops at verified payment review.

The current runtime must not accept legal terms, enter payment credentials, click Pay, or purchase. The long-term product adds a background runtime, web/iOS control surfaces, and a separately authorized payment boundary without replacing the checkout engine.

The current engineering priority is cross-airline structural generalization—not another architecture rewrite and not airline-specific selectors.

## 2. Current status

| Area | Status |
|---|---|
| Agent unit suite | 383/383 passing |
| Browser replay suite | 179-replay corpus; 178/178 prior uninterrupted baseline plus focused Croatia PAY-boundary proof |
| Build/type/syntax gate | `npm run check` passing |
| Live sites | EasyJet, GoToGate, Kiwi, and Turkish reached verified payment review in the latest technical canaries |
| Safety | No payment, card, legal, or purchase action in those review-only flows |
| Formal autonomous acceptance | Canary reports remain `review_required` until the operator records `--manual none` or `--manual yes` |
| Architecture | Single semantic compiler, TaskState authority, direct obligation mechanics, one governed action lease, bounded recovery, compact durable state |
| Main product gap | Representative structural portfolio: 8–10 sites, 6+ families, 4 direct-airline families, 3 OTAs |
| Main performance gap | Large browser observations and rescans; unnecessary ambiguity/model turns on some sites |

Latest live report:

| Site | Session | Terminal | Safety | Wall time | p95 observation |
|---|---|---:|---:|---:|---:|
| EasyJet | `chk_msn4eao235a7in` | ✅ | ✅ | 1m08s | 648.0 KB |
| GoToGate | `chk_msn4gnewrng0ai` | ✅ | ✅ | 2m30s | 512.2 KB |
| Kiwi | `chk_msn4k9vxkh0b6v` | ✅ | ✅ | 1m27s | 488.0 KB |
| Turkish Airlines | `chk_msn3eboeqhka33` | ✅ | ✅ | 1m39s | 360.4 KB |

Run `npm run canary:report -- --latest-by-site` for current evidence. A technically complete trace is not called autonomous until manual-intervention status is explicitly annotated.

## 3. Authoritative runtime flow

```text
selected booking + traveler policy
→ fresh immutable ObservationFrame
→ one DecisionFrame semantic compilation
→ one TaskState reduction and disposition
→ one CurrentObligation
→ mechanics-only binding
→ consequence governor
→ one ActionLease
→ browser mechanical result
→ semantic transition verification
→ compact TaskState/transaction commit
→ repeat, hand off, stop, or terminal review
```

Responsibility boundaries:

- Observation reports mechanics, state, ownership evidence, transaction evidence, and fresh identity.
- DecisionFrame compiles page meaning once.
- TaskState is the only publisher of semantic work and terminal disposition.
- Mechanics binding answers only which current actuator can perform the admitted obligation.
- The governor checks consequences immediately before dispatch.
- Browser verification proves the mechanic; backend transition verification proves the obligation.
- Transaction review independently proves the selected booking still matches the final review.

Do not add a second readiness meaning layer, planner, verifier, requirement lifecycle, recovery store, or completion receipt.

## 4. Code map

### Browser extension

Composition root:

- `apps/extension/src/content/runtime.js` — dependency wiring, startup, shared browser integration, and test hooks.
- `apps/extension/src/background/service-worker.js` — tab-scoped checkout lineage, app-supplied booking launch, explicit universal runtime injection, startup diagnostics, and trusted browser input.
- `apps/extension/src/content/runtime-context.js` — sole runtime state owner with scoped capabilities.

Observation:

- `apps/extension/src/content/observation/` — DOM/accessibility evidence, controls, logical graph, surfaces, stage exits, transaction evidence, signatures, page state, screenshots, and transport.
- `apps/extension/src/content/selected-booking.js` — browser-owned itinerary/total acquisition and final contract composition.
- `apps/extension/src/content/selected-booking-acquisition.js` — bounded mutation-driven startup acquisition.

Execution and verification:

- `apps/extension/src/content/execution/orchestrator.js` — one governed action lifecycle.
- `apps/extension/src/content/execution/targeting.js` — exact target resolution and freshness/actionability checks.
- `apps/extension/src/content/execution/interaction.js` — click/choice/keyboard/scroll mechanics.
- `apps/extension/src/content/execution/field-interaction.js` — controlled typing, native selects, and phone choice mechanics.
- `apps/extension/src/content/verification/outcomes.js` — expected-outcome and postcondition proof.

Controller and UI:

- `apps/extension/src/content/controller/` — session handshake, backend decisions, single-flight loop, destination wait, and checkout mutation watch.
- `apps/extension/src/content/ui/sidebar.js` — read-only user progress and diagnostics presentation.
- `apps/extension/src/content/diagnostics/` — bounded flow/debug output.

### Backend agent

- `apps/web/agent/authority-frames.js` — persisted/network authority frames.
- `apps/web/agent/canonical-decision.js` — semantic DecisionFrame compilation.
- `apps/web/agent/task-state/reducer.js` — sole TaskState reducer.
- `apps/web/agent/current-obligation.js` — canonical current work contract.
- `apps/web/agent/mechanics-binder.js` — direct `CurrentObligation + DecisionFrame → mechanics` path.
- `apps/web/agent/ambiguity-resolver.js` — closed-ID optional model boundary; zero calls for deterministic singleton mechanics.
- `apps/web/agent/action-governor.js` — final consequence authorization.
- `apps/web/agent/loop/orchestrator.js` — sole backend turn orchestrator.
- `apps/web/agent/transition-evaluator.js` — semantic action-result verification.
- `apps/web/agent/transaction-facts.js` and `invariants.js` — selected-booking and transaction reconciliation.
- `apps/web/agent/session-store.js` — compact durable TaskState, observation identity, and execution episodes.
- `apps/web/agent/trace-store.js` and `diagnostic-retention.js` — disposable bounded diagnostics.
- `apps/web/agent/session-service.js` and `next-action-service.js` — HTTP-facing session and planning services.

### Shared contracts

- `packages/shared/selected-booking/` — immutable starting itinerary/total/travelers.
- `packages/shared/agent-actions/` — `ActionLease/v1` and action/result normalization.
- `packages/shared/agent-state/` — durable state contracts.
- `packages/shared/semantic-owner/` — stable semantic owner identity.
- `packages/shared/policy/` and `requirements/` — traveler policy and requirement vocabulary.

### Tests and evidence

- `tests/agent/*.test.js` — unit and static architecture invariants.
- `tests/agent/durable-session.spec.js` — HTTP/session/persistence boundary.
- `tests/agent/semantic-control-replay.spec.js` — production-shaped browser replay matrix.
- `scripts/report-canary.js` — normalized live acceptance and latency report.
- `work/agent-traces/` — disposable sanitized trace sessions.
- `work/agent-client-logs/` — compact client timing logs.

## 5. Important recent corrections

### Strict selected-booking boundary

A new transaction requires one complete `SelectedBooking/v1`: itinerary, approved total/currency, and selected traveler. Browser acquisition owns site facts; the extension wallet owns traveler selection. Startup waits once for bounded hydration and creates no provisional transaction when the contract is unavailable. Resume uses the durable baseline.

### Explicit universal launch

The extension popup now starts Fly on the active HTTP(S) checkout through `chrome.scripting`, so an explicitly launched unfamiliar domain does not require a manifest content-script entry. The background worker may install an app-supplied complete `SelectedBooking/v1` before injection, or preserve current-tab browser acquisition under the same `CheckoutContext/v1`. It reinjects only an explicitly authorized active checkout with booking/resume evidence across full-page and cross-domain redirects. Startup phases are retained per tab and copied into the start-attempt diagnostic stream before session creation.

### Single-dispatch stage exit

A dispatched Continue remains `NAVIGATION_TRANSITION_PENDING` until material mutation or deadline. The browser repeat guard is scoped to the exact governed action lease—not DOM signature alone—so a fresh checkout stage may immediately reuse the same physical Continue control while exact duplicate dispatch remains blocked.

### Runtime modularization without new authority

Extension observation, execution, controller, verification, diagnostics, and UI are separate modules behind one runtime owner. Backend server, loop, and TaskState responsibilities are also split, but `runtime.js`, `loop/orchestrator.js`, and `task-state/reducer.js` remain their sole composition/authority roots.

## 6. Safety and stop behavior

Fly should handle ordinary unfamiliar DOMs, textboxes, split/grouped fields, custom dropdowns, rerenders, overlays, offscreen controls, and reused navigation mechanics without user help.

Valid pause/stop reasons:

- Missing required traveler fact.
- Login, OTP, CAPTCHA, 3DS, bank approval, or user-only authentication.
- Legal acceptance, payment, or purchase boundary.
- Consequential ambiguity or unauthorized price/currency/itinerary/identity change.
- Sold-out inventory, expired session, site outage, or explicit website rejection.
- No safe grounded mechanic after bounded distinct recovery.
- Verified payment review under the current milestone.

For an otherwise eligible journey, exhausted mechanics is an engineering coverage failure. Capture the trace, add the exact replay, repair the universal owner, and rerun retained canaries. Do not add an airline workflow.

## 7. Development and validation

```bash
npm install
npm run dev
npm run check
npm run test:agent:unit
npm run test:agent:browser
npm run canary:report -- --latest-by-site
```

Full acceptance after a material core change:

1. Focused trace-derived replay passes.
2. 383 unit tests pass.
3. The 179-replay browser corpus has a 178/178 uninterrupted baseline plus focused Croatia PAY-boundary proof.
4. `npm run check` and `git diff --check` pass.
5. Discovering site reaches verified payment review or the expected typed handoff.
6. At least one retained canary passes.
7. No payment/legal/card/purchase action executes.

## 8. Storage and diagnostics

- Transaction DB: `work/agent-transactions-v2.sqlite`
- Traces: `work/agent-traces`
- Client logs: `work/agent-client-logs`
- Diagnostic ledger: `work/agent-ledger`

Diagnostics rotate and fail open below the free-space floor; checkout must never stop because trace storage is full. Use `ATW_TRANSACTION_DB` and `ATW_DIAGNOSTIC_DIR` to separate durable and diagnostic volumes.

## 9. Current risks and next work

### Priority 1 — Structural generalization

Current four-site evidence is promising but insufficient for a universal claim. Next controlled baseline order:

1. Lufthansa as full-service confirmation for Turkish.
2. Ryanair or Wizz Air as low-cost confirmation for EasyJet.
3. American or United for US address/contact conventions.
4. Emirates or Qatar for long-haul nationality/document structure.
5. Croatia Airlines for a smaller regional structure.
6. Trip.com or eDreams/Opodo as a third OTA family.

Use one adult, complete profile, simple return, no paid extras, no extra baggage, random/no specific seat. Do not combine a new structural family with a new complex profile scenario.

### Priority 2 — Scenario portfolio

After several Wave 1 families pass, test multiple adults, adult plus child, explicit paid baggage/seat budgets, dirty checkout correction, missing data, login/OTP resume, multi-leg, price/currency changes, and website failure on at least two families each.

### Priority 3 — Measured latency

The semantic backend is usually fast; browser observation construction, 360–648 KB payloads, rescans, persistence, and some ambiguity calls dominate slow runs. Instrument and optimize phase-by-phase without removing safety boundaries. Do not start another broad architecture rewrite.

### Formal evidence gap

The latest four traces technically reached payment review and passed safety, but normalized reports still show `review_required` until manual intervention is explicitly annotated. Record `--manual none` only when no human altered the airline page.

## 10. Engineering rules

- Fix universal contracts and reusable mechanics, never airline journeys.
- Separate semantic obligation from mechanical candidate binding.
- Preserve exact target identity, action leases, consequence governance, and semantic verification.
- One fresh obligation, one action, one verification, one durable commit.
- Deterministic singleton candidates use zero model calls.
- Treat rich observations as private evidence; keep model packets compact and closed.
- Keep historical adapters under tests, not callable production paths.
- Preserve user changes in a dirty worktree and stage documentation/code intentionally.
- Update the coverage matrix after material live evidence; update progress after material implementation or root-cause decisions; change the PRD only when product scope changes.

## 11. One-paragraph handoff

Fly currently has one authoritative checkout loop, compact durable transaction state, strict selected-booking admission, exact action leases, bounded adaptive mechanics, transaction reconciliation, and hard payment/legal/purchase boundaries. The complete automated baseline is green, and the latest EasyJet, GoToGate, Kiwi, and Turkish traces all technically reached verified payment review safely. The next bottleneck is external validity: prove the same universal loop across additional direct-airline and OTA structural families, converting every failure into a trace-derived universal replay while retaining the four canaries. Latency optimization follows measured browser observation and ambiguity hot paths; it should not trigger another authority rewrite.
