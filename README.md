# Fly

Fly is a universal, safety-constrained flight-checkout agent.

The user selects a flight and confirms Book/Pay once. Fly completes an unfamiliar airline or OTA checkout from saved traveler facts and policy, handles authorized standard terms and payment, purchases exactly the approved transaction, and independently verifies the booking. Today’s engineering milestone proves that a newly added unfamiliar checkout can be solved from the selected profile and policy until actual card-number, expiry, and security-code entry is visible—directly or in an owned hosted card widget—then stops before credentials, Pay, or purchase. The current baseline profile declines paid extras, makes no optional selections, and prefers card payment; different profiles must produce different choices.

## Product direction

Long-term user experience:

```text
select flight
→ confirm Book/Pay once
→ Fly resolves the checkout under the saved mandate
→ receive independently verified booking confirmation
```

The same checkout engine is intended for the browser extension, a background web runtime, and future iOS control surfaces. Fly learns reusable component and interaction patterns—not airline-specific checkout scripts.

## Current milestone

Fly must:

1. Start from one approved itinerary, total/currency, and selected traveler.
2. Fill known traveler, contact, and document facts.
3. Resolve fares, baggage, seats, insurance, and extras from explicit policy.
4. Adapt to unfamiliar but reversible controls and layouts.
5. Verify every material state change from fresh browser evidence.
6. Reconcile itinerary, traveler, selections, currency, and total as an independent safety projection.
7. Reach verified actual payment entry and stop safely before credentials or purchase; incomplete reconciliation cannot cause navigation beyond the observed card form.

Ordinary DOM variation, new text fields, custom dropdowns, rerenders, overlays, unusual grouping, or a pre-payment page labeled PAY are not valid reasons to stop. Valid stops are missing user facts, authentication/challenges, authority outside the mandate, transaction contradiction, website failure, exhausted safe mechanics, actual payment entry, or the purchase boundary.

## Runtime model

```text
fresh ObservationFrame
→ one DecisionFrame
→ grounded CheckoutSituation (obligations + consequences)
→ minimal DesiredStateDelta from observed state + profile/policy
→ TaskState publishes one CurrentObligation
→ bind exact current mechanics
→ consequence governor
→ execute one ActionLease
→ verify the same obligation
→ persist compact durable facts
```

The model is optional and semantic-only. Known scenes and deterministic mechanics use zero model calls. When exact required meaning remains unresolved, the model may propose only closed-ID grounded semantic hypotheses; it cannot create work, select targets or mechanics, invent traveler facts, grant permission, or establish transaction truth.

## Current evidence

- 407/407 agent unit tests
- 184/184 uninterrupted browser replays
- Explicit active-tab runtime launch is replay-proven on an unlisted checkout domain
- Croatia-shaped PaymentForm desired-state repair is replay-proven; fresh live rerun remains pending
- Earlier EasyJet, GoToGate, Kiwi, and Turkish traces reached the former review boundary and require corrected card-entry reclassification/reruns
- No credential, Pay, purchase, or unauthorized legal action in the corrected replay corpus
- Next product gate: expand from four live sites to a representative structural portfolio

A broad `99%` claim requires a defined eligible scope and approximately 300 representative journeys across sites, structural families, routes, dates, currencies, and scenarios.

## Run locally

Requirements: Node.js and Chrome.

```bash
npm install
npm run dev
```

Open `http://localhost:4173`.

Install the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `apps/extension`.
5. Reload the extension after every content-script build.

Useful commands:

```bash
npm run check
npm run test:agent:unit
npm run test:agent:browser
npm run canary:report -- --latest-by-site
```

## Storage

Authoritative local transaction state is stored in `work/agent-transactions-v2.sqlite`. Traces, screenshots, client logs, and JSONL ledgers under `work/` are disposable diagnostics with retention limits and a low-disk circuit breaker.

```bash
npm run diagnostics:prune
npm run storage:compact
```

Hosted deployment should keep compact transaction state in Postgres/Supabase and expiring diagnostics in object storage.

## Documentation

| Document | Authority |
|---|---|
| [FLY_VISION_PRD.md](./FLY_VISION_PRD.md) | Stable product promise, scope, and promotion gates |
| [FLY_FINAL_ROADMAP.md](./FLY_FINAL_ROADMAP.md) | Target architecture and engineering sequence |
| [FLY_COVERAGE_MATRIX.md](./FLY_COVERAGE_MATRIX.md) | Current capability, site, scenario, and reliability truth |
| [FLY_PROGRESS.md](./FLY_PROGRESS.md) | Concise chronological implementation and live evidence |
| [FLY_AGENT_RULEBOOK.md](./FLY_AGENT_RULEBOOK.md) | Runtime and engineering invariants |
| [FLY_CURRENT_CODEBASE_ENGINEERING_HANDOFF.md](./FLY_CURRENT_CODEBASE_ENGINEERING_HANDOFF.md) | Current code map, commands, risks, and next work |

When documentation disagrees, current code, automated tests, and sanitized live traces determine engineering truth. The PRD remains the authority for product direction.
