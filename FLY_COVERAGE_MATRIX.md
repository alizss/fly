# Fly — Coverage and Acceptance Matrix

Last updated: 2026-08-19

This file is the current acceptance truth. Product scope belongs in [FLY_VISION_PRD.md](./FLY_VISION_PRD.md); architecture in [FLY_FINAL_ROADMAP.md](./FLY_FINAL_ROADMAP.md); chronological implementation evidence in [FLY_PROGRESS.md](./FLY_PROGRESS.md).

## 1. Current milestone

For an eligible selected booking, Fly must complete unfamiliar airline/OTA checkout, apply the selected traveler and explicit policy, reconcile the transaction, reach verified payment review, and stop before legal acceptance, payment entry, Pay, or purchase.

Ordinary unfamiliar DOMs, new fields, custom widgets, rerenders, overlays, unusual grouping, or reused Continue controls are coverage responsibilities—not expected handoffs.

## 2. Status legend

| Mark | Meaning |
|---|---|
| ✅ | Proven at the indicated level |
| 🧪 | Automated/replay proof; fresh live proof pending |
| 🟡 | Technical live proof exists, but formal acceptance evidence is incomplete |
| ❌ | Current evidence disproves completion |
| ⏳ | Not tested |

## 3. Verification baseline

| Layer | Result | Evidence |
|---|---:|---|
| Build, type, and syntax | ✅ | `npm run check` |
| Agent unit suite | ✅ 386/386 | Obligation-driven situation authority, typed validation lifecycle, scene/decision reconciliation, profile codecs, policy, transaction, recovery, persistence, universal explicit launch, and architecture invariants |
| Browser replay suite | ✅ 179/179 | Uninterrupted corpus covering app-supplied and browser-captured tab lineage, unrelated-provider redirects, Croatia traveler/PAY boundaries, mixed controls, causal post-action validation, and all established canaries |
| Durable session boundary | ✅ | Tab-scoped app launch or current-tab acquisition → complete `SelectedBooking/v1`, background-owned checkout lineage, strict traveler membership, cross-checkout isolation, resume identity, typed failures |
| Explicit universal runtime launch | 🧪 | Active-tab `chrome.scripting` injection works on an unlisted HTTPS checkout; app-supplied `SelectedBooking/v1` starts an itinerary-free unfamiliar passenger page; fresh live Lufthansa/Wizz proof pending |
| Irreversible-action boundary | ✅ | No payment, billing, legal, card, Pay, or purchase action in current review-only replays/canaries |

## 4. Universal capability status

| Capability | Status | Remaining proof |
|---|---|---|
| Scalar/combined text and email fields | ✅ | Expand live structural portfolio |
| Split names, DOB, phone, and documents | ✅ | Adult-plus-child and additional document families |
| Native/custom selects and autocomplete | ✅ | Transfer to more localized widgets |
| Placeholder/sentinel commitment (`-1`, prompt options, punctuation placeholders) | 🧪 | Croatia structural replay is green; fresh live Croatia proof pending |
| Phone representation codec (combined international vs split prefix/local) | 🧪 | Croatia combined-field replay and Turkish/GoToGate split-phone regressions are green; fresh live proof pending |
| Validation lifecycle, ownership, and exact-field repair | 🧪 | Croatia-style `0 error` is clear; native-invalid and positive active failures remain blocking in replay; fresh live Croatia proof pending |
| Grounded Semantic Scene Reconciliation | 🧪 | Known scenes use zero calls; closed-ID field/validation hypotheses and descriptive decision typing cannot publish work or authority; fresh unfamiliar live proof pending |
| Logical identity across framework rerender | ✅ | Continue live confirmation across new frameworks |
| Active-surface and dormant-branch ownership | ✅ | New modal/drawer implementations |
| Repeated passenger/leg decision ownership | ✅ | Multi-traveler live matrix |
| Fares, baggage, seats, insurance, extras policy | ✅ baseline | Explicit paid budgets and dirty checkout on 2+ families |
| Bounded adaptive reversible mechanics | ✅ | Additional previously unseen controls |
| Single-dispatch navigation and hydration wait | ✅ | Fresh live repeat-guard confirmation after `c7aeb89` |
| Transaction facts and selected-booking reconciliation | ✅ | More currencies/fare structures and price-change scenarios |
| Payment-review terminal detection | ✅ | Additional hosted/direct payment-review structures |
| Durable pause/restart/recovery | ✅ replay | Live authentication/OTP resume |
| Background/cloud execution | ⏳ | Begins after structural and scenario gates |
| Authorized payment and booking confirmation | ⏳ | Separate security/product gate |

## 5. Latest live site evidence

`npm run canary:report -- --latest-by-site` currently reports:

| Site | Structural family | Session | Payment review | Safety | Wall time | Formal status |
|---|---|---|---:|---:|---:|---|
| Kiwi | Custom OTA | `chk_msn4k9vxkh0b6v` | ✅ | ✅ | 1m27s | 🟡 Technical pass; intervention annotation pending |
| GoToGate | OTA checkout | `chk_msn4gnewrng0ai` | ✅ | ✅ | 2m30s | 🟡 Technical pass; intervention annotation pending |
| EasyJet | European low-cost direct | `chk_msn4eao235a7in` | ✅ | ✅ | 1m08s | 🟡 Technical pass; intervention annotation pending |
| Turkish Airlines | International full-service direct | `chk_msn3eboeqhka33` | ✅ | ✅ | 1m39s | 🟡 Technical pass; intervention annotation pending |
| Croatia Airlines | Regional direct | `chk_mskklx6tgq8k7l` | ❌ | ✅ | 11s | Not accepted; stale/incomplete discovery trace |

Technical completion means terminal and transaction review are verified and safety is green. Formal autonomous acceptance additionally requires an explicit operator annotation:

```bash
npm run canary:report -- --session chk_... --manual none --write
```

Use `--manual yes` for an assisted run. Never infer autonomous acceptance from a trace alone.

## 6. Structural portfolio tracker

Test structures deliberately. A primary site discovers a universal defect; a confirmation site proves the repair transferred.

| Wave | Family | Primary | Confirmation | Baseline | Next action |
|---:|---|---|---|---:|---|
| 0 | Custom OTA | Kiwi | — | 🟡 | Record formal no-intervention annotation; retain canary |
| 0 | OTA checkout | GoToGate | — | 🟡 | Record formal annotation; retain canary |
| 1 | International full-service direct | Turkish | Lufthansa | 🟡 | Run Lufthansa controlled baseline |
| 1 | European low-cost direct | EasyJet | Ryanair or Wizz Air | 🟡 | Run confirmation-site controlled baseline |
| 1 | United States network direct | American or United | The other | ⏳ | Test address/contact conventions |
| 1 | Long-haul international direct | Emirates or Qatar | The other | ⏳ | Test nationality/document structure |
| 1 | Regional direct | Croatia Airlines | Select after primary | 🧪 | Structural repair replay is green; rerun a fresh controlled live baseline and record intervention status |
| 1 | Third structurally different OTA | Trip.com or eDreams/Opodo | Select after primary | ⏳ | Choose by observed structure, not brand count |
| 2 | Asian/localized direct | Singapore or Korean Air | The other | ⏳ | Begin after Wave 1 stability |

Controlled baseline for every new primary:

- One adult with complete profile.
- Simple return itinerary.
- No paid extras or additional baggage.
- Random/no specific seat.
- Approved starting itinerary, total/currency, and traveler.
- Stop at verified payment review.

Do not combine structural discovery with a new complex profile scenario.

## 7. Scenario and policy tracker

Begin the full scenario matrix only after several Wave 1 families pass. Prove each consequential scenario on at least two structurally different families.

| Scenario | Replay | Live proof | Status / next proof |
|---|---:|---:|---|
| Complete one traveler, no paid extras | ✅ | ✅ on four sites | Formal autonomous annotations pending |
| Missing required fact and resume | ✅ | ⏳ | Two live families |
| Two adults | 🟡 components | ⏳ | Passenger-specific ownership |
| Adult plus child | 🟡 derived age | ⏳ | Passenger/age/document ownership |
| Explicit paid baggage with budget | ✅ safety/policy | ⏳ | Two families and total reconciliation |
| Specific seat with budget | ✅ safety/policy | ⏳ | Leg/passenger/seat/price ownership |
| Preselected unauthorized paid extra | ✅ | 🟡 | Direct-airline confirmation |
| Login/account handoff and resume | 🟡 | ⏳ | Expected typed handoff |
| OTP/CAPTCHA/3DS handoff | 🟡 | ⏳ | Expected typed handoff |
| Multi-leg itinerary | ✅ | ✅ | Additional direct family |
| Currency or total change | ✅ | ⏳ | Approval and resume on two families |
| Sold out/outage/site failure | ✅ | 🟡 | Additional direct-family proof |

## 8. Site acceptance checklist

A site/scenario is accepted only when all applicable checks pass:

- [ ] Complete approved starting itinerary, traveler, currency, and total.
- [ ] Required known profile facts are filled and verified.
- [ ] Prompt/sentinel select values are unresolved until an exact non-placeholder option commits.
- [ ] Phone values follow the observed field representation contract; combined international fields include the saved country code while split fields preserve separate components.
- [ ] Fresh validation reopens its exact active owner before optional or unrelated fields can become work.
- [ ] Optional/dormant controls do not block progress.
- [ ] Reversible decisions match explicit policy.
- [ ] Unauthorized paid selections are absent or exactly corrected.
- [ ] Transaction itinerary, traveler, outcomes, currency, and total reconcile.
- [ ] `terminalStatus=payment_review_reached` and transaction review is ready.
- [ ] Expected action/outcome coverage is non-vacuous and complete.
- [ ] No payment, billing, legal, card, Pay, purchase, or unauthorized irreversible action executes.
- [ ] Every material new failure has an exact replay.
- [ ] Operator records whether manual page intervention occurred.
- [ ] Full unit, browser, and repository checks remain green after any repair.

## 9. Promotion gates

| Gate | Requirement | Status |
|---|---|---|
| A — Direct-airline generalization | Full-service + low-cost direct reach review; Kiwi/GoToGate retained; no site workflow | 🟡 Technical evidence achieved; formal annotations and confirmation sites pending |
| B — Structural portfolio | 8–10 sites, 6+ families, 4 direct families, 3 OTAs | ⏳ |
| C — Profile/policy portfolio | Complex scenarios on 2+ families | ⏳ |
| D — Background product | Durable isolated jobs and safe handoff/resume equivalent to extension | ⏳ |
| E — Broad review-only production | Defined reliability window, confidence analysis, operational controls, zero critical safety violations | ⏳ |
| F — Payment pilot | Separate payment security, authorization, idempotency, 3DS, confirmation architecture | ⏳ |

## 10. Reliability scorecard

| Metric | Current evidence | Broad target |
|---|---|---|
| Accepted structural families | 2 OTA + 2 direct technical families | 6+ observed families |
| Accepted direct-airline families | 2 technical | 4+ with confirmation where repairs were required |
| Accepted OTA families | 2 technical | 3+ structurally different OTAs |
| Representative eligible journeys | Small canary set | Approximately 300 distributed journeys |
| False terminal completion | 0 in current accepted evidence | 0 |
| Unauthorized irreversible mutation | 0 in current accepted evidence | 0 |
| Observation p95 | 360–648 KB across latest four canaries | Measure and reduce without weakening evidence |
| Task duration | 1m08s–2m30s across latest four canaries | Establish median/p95 after broader portfolio |

Do not claim `99%` until the eligible denominator and distributed acceptance window are explicit.

## 11. Failure intake loop

```text
controlled live run
→ classify expected handoff, site failure, or universal defect
→ preserve sanitized trace
→ create exact replay
→ repair the owning universal component
→ run full unit/browser/check gates
→ rerun discovering site
→ rerun one retained canary
→ confirm on a related second site
→ update this matrix
```

Never add an airline end-to-end workflow because a normal textbox, dropdown, layout, or DOM owner is unfamiliar.

For semantic uncertainty, the replay must additionally prove whether the deterministic fast path or Semantic Scene Reconciliation ran. A known fixture must use zero model calls. An ambiguous fixture may use at most one call and must accept only supplied fresh evidence/control IDs; the resulting hypothesis remains non-authoritative until deterministic reconciliation publishes the final `DecisionFrame`.

## 12. Update rule

- Update this file after material live evidence or a promotion-gate change.
- Keep historical narrative in Git history and concise entries in `FLY_PROGRESS.md`.
- Update the roadmap only when component status or engineering priority changes.
- Update the PRD only when product scope, safety boundary, or promotion criteria change.
