# Fly

Fly is a universal, safety-constrained flight-checkout agent.

The user selects a flight and confirms Book/Pay once. Fly completes an unfamiliar airline or OTA checkout from saved traveler facts and policy, handles authorized standard terms and payment, purchases exactly the approved transaction, and independently verifies the booking. Today’s engineering milestone stops at verified payment review while the legal, payment, idempotency, and confirmation components are built.

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
6. Reconcile itinerary, traveler, selections, currency, and total.
7. Reach verified payment review and stop safely.

Ordinary DOM variation, new text fields, custom dropdowns, rerenders, overlays, or unusual grouping are not valid reasons to stop. Valid stops are missing user facts, authentication/challenges, consequential approval, transaction contradiction, website failure, exhausted safe mechanics, or the payment/legal/purchase boundary.

## Runtime model

```text
fresh ObservationFrame
→ one DecisionFrame
→ grounded CheckoutSituation (obligations + consequences)
→ TaskState publishes one CurrentObligation
→ bind exact current mechanics
→ consequence governor
→ execute one ActionLease
→ verify the same obligation
→ persist compact durable facts
```

The model is optional and bounded. Deterministic singleton mechanics use zero model calls. When ambiguity remains, the model may select only supplied reversible candidates; it cannot invent work, targets, traveler facts, permissions, or transaction truth.

## Current evidence

- 386/386 agent unit tests
- 179/179 uninterrupted browser replays
- Explicit active-tab runtime launch is replay-proven on an unlisted checkout domain
- Fresh technical payment-review passes on EasyJet, GoToGate, Kiwi, and Turkish Airlines
- No payment, card, legal, or purchase action in the accepted review-only flows
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
