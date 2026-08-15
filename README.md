# Fly

Fly is a universal, safety-constrained flight-checkout agent.

The user selects a flight and traveler, starts Fly, and Fly completes an unfamiliar airline or OTA checkout according to the traveler profile and booking policy. When a required legal attestation blocks progress, Fly obtains exact transaction-bound approval, verifies that attestation separately, and stops only after actual payment entry is visible. It does not enter payment credentials, click Pay, commit, or purchase.

## Product direction

Long-term user experience:

```text
select flight and traveler
→ tap Fly
→ answer only genuinely missing or consequential questions
→ approve the exact transaction
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
7. Reconcile pre-payment review, automatically resolve standard mandatory carrier attestations covered by the checkout mandate, and verify actual payment entry before stopping safely.

Ordinary DOM variation, new text fields, custom dropdowns, rerenders, overlays, or unusual grouping are not valid reasons to stop. Valid pauses/stops are missing user facts, authentication/challenges, exceptional attestations outside the checkout mandate, consequential ambiguity, transaction contradiction, website failure, exhausted safe mechanics, verified payment entry, or a forbidden payment/purchase boundary.

## Runtime model

```text
fresh ObservationFrame
→ one immutable CheckoutScene
→ TaskState publishes one CurrentObligation
→ bind exact current mechanics
→ consequence governor
→ execute one ActionLease
→ verify the same obligation
→ persist compact durable facts
```

The model is optional and bounded. Deterministic singleton mechanics use zero model calls. When ambiguity remains, the model may select only supplied reversible candidates; it cannot invent work, targets, traveler facts, permissions, or transaction truth.

Starting an eligible transaction creates an immutable `CheckoutMandate/v1` from the selected booking, approved total/currency, and selected traveler IDs. It covers ordinary mandatory carrier/fare/purchase/dangerous-goods attestations, while explicitly forbidding marketing consent, optional data sharing, insurance, subscriptions, financing, payment credentials, transaction commit, and purchase. Exceptional attestations outside that mandate are a typed handoff—not a normal checkout prompt.

## Current evidence

- 379/379 agent unit tests
- 178/178 uninterrupted browser replays
- Complete checkout-mandate → exact attestation → separate advance → payment-entry replay proof, with no mid-checkout prompt
- Prior technical review passes on EasyJet, GoToGate, Kiwi, and Turkish Airlines; fresh expanded-milestone canaries remain required
- No payment credentials, Pay, transaction commit, or purchase capability
- Next product gate: live-prove actual payment entry, then expand to a representative structural portfolio

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
