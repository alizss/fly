# Fly — Coverage and Acceptance Matrix

Last updated: 2026-08-12

This file is the current acceptance truth. Product scope belongs in [FLY_VISION_PRD.md](./FLY_VISION_PRD.md); architecture in [FLY_FINAL_ROADMAP.md](./FLY_FINAL_ROADMAP.md); chronological implementation evidence in [FLY_PROGRESS.md](./FLY_PROGRESS.md).

## 1. Current milestone

For an eligible selected booking, Fly must complete unfamiliar airline/OTA checkout, apply the selected traveler and explicit policy, reconcile the transaction, obtain narrow approval for any exact required legal attestation, verify actual payment entry, and stop before payment credentials, Pay, transaction commit, or purchase.

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
| Agent unit suite | ✅ 388/388 | Semantic authority, scene reconciliation, exact legal authorization, navigation episodes, profile codecs, policy, transaction, recovery, persistence, and architecture invariants |
| Browser replay suite | ✅ 178/178 | One uninterrupted run including the real controller/backend Croatia CheckoutMandate → exact attestation → separate advance → actual payment-entry loop, authorized cross-origin resume, and all established structural canaries |
| Durable session boundary | ✅ | Complete `SelectedBooking/v1`, strict traveler membership, resume identity, typed failures |
| Payment/legal boundary | 🧪 | Durable CheckoutMandate, exact AttestationReceipt, and closed-loop attestation → advance → payment-entry regressions pass; fresh live proof pending; credentials, Pay, commit, and purchase remain prohibited |

## 4. Universal capability status

| Capability | Status | Remaining proof |
|---|---|---|
| Scalar/combined text and email fields | ✅ | Expand live structural portfolio |
| Split names, DOB, phone, and documents | ✅ | Adult-plus-child and additional document families |
| Native/custom selects and autocomplete | ✅ | Transfer to more localized widgets |
| Placeholder/sentinel commitment (`-1`, prompt options, punctuation placeholders) | 🧪 | Croatia structural replay is green; fresh live Croatia proof pending |
| Phone representation codec (combined international vs split prefix/local) | 🧪 | Croatia combined-field replay and Turkish/GoToGate split-phone regressions are green; fresh live proof pending |
| Validation ownership and exact-field repair | 🧪 | Native-invalid and section-level phone validation reopen the exact primary owner in replay; fresh live proof pending |
| Immutable CheckoutScene and grounded reconciliation | 🧪 | Known scenes use zero calls; one final scene owns stage/exit; a deliberately ambiguous fixture proves one neutral closed-ID patch; fresh unfamiliar live proof pending |
| Checkout mandate and standard attestations | 🧪 | Selected booking + traveler identities create one immutable mandate; Croatia replay proves zero prompt, exact checkbox ownership, exact receipt, separate Confirm, and stop at hosted payment entry; fresh live promotion pending |
| Logical identity across framework rerender | ✅ | Continue live confirmation across new frameworks |
| Active-surface and dormant-branch ownership | ✅ | New modal/drawer implementations |
| Repeated passenger/leg decision ownership | ✅ | Multi-traveler live matrix |
| Fares, baggage, seats, insurance, extras policy | ✅ baseline | Explicit paid budgets and dirty checkout on 2+ families |
| Bounded adaptive reversible mechanics | ✅ | Additional previously unseen controls |
| Action-scoped navigation, redirects, and hydration wait | ✅ replay | Same-document, cross-origin, noopener/new-tab, redirect, exact-session resume, source non-closure, and hydration regressions pass; fresh Croatia hosted-provider proof pending |
| Transaction facts and selected-booking reconciliation | ✅ | More currencies/fare structures and price-change scenarios |
| Pre-payment/legal/payment-entry boundary detection | 🧪 | Four typed boundaries and mandate-covered standard attestation → exact receipt → separate advance are covered in focused tests; hosted/direct live payment-entry proof pending |
| Durable pause/restart/recovery | ✅ replay | Live authentication/OTP resume |
| Background/cloud execution | ⏳ | Begins after structural and scenario gates |
| Authorized payment and booking confirmation | ⏳ | Separate security/product gate |

## 5. Latest live site evidence

`npm run canary:report -- --latest-by-site` currently reports:

| Site | Structural family | Session | Prior review milestone | Safety | Wall time | Current status |
|---|---|---|---:|---:|---:|---|
| Kiwi | Custom OTA | `chk_msn4k9vxkh0b6v` | ✅ | ✅ | 1m27s | 🟡 Technical pass; intervention annotation pending |
| GoToGate | OTA checkout | `chk_msn4gnewrng0ai` | ✅ | ✅ | 2m30s | 🟡 Technical pass; intervention annotation pending |
| EasyJet | European low-cost direct | `chk_msn4eao235a7in` | ✅ | ✅ | 1m08s | 🟡 Technical pass; intervention annotation pending |
| Turkish Airlines | International full-service direct | `chk_msn3eboeqhka33` | ✅ | ✅ | 1m39s | 🟡 Technical pass; intervention annotation pending |
| Croatia Airlines | Regional direct | `chk_mskklx6tgq8k7l` | ❌ | ✅ | 11s | Not accepted; stale/incomplete discovery trace |

These traces prove the earlier review milestone, not the expanded actual-payment-entry milestone. Fresh live runs must now reach owned payment-method, credential-component, or hosted-payment evidence. Formal autonomous acceptance additionally requires an explicit operator annotation:

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
- Stop only after verified actual payment entry.

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
- [ ] Pre-payment review and legal gate are not reported as terminal completion.
- [ ] If legal acceptance is required, approval is bound to the exact transaction, itinerary, travelers, total/currency, legal text, checkbox, next control, and expiry.
- [ ] The exact legal checkbox is freshly verified before a separate advance-to-payment action.
- [ ] `terminalStatus=payment_entry_reached` only when an owned payment method, credential component, or hosted payment widget is visible and transaction review is ready.
- [ ] Expected action/outcome coverage is non-vacuous and complete.
- [ ] No payment credentials, billing mutation, Pay, transaction commit, purchase, or unauthorized legal/irreversible action executes.
- [ ] Every material new failure has an exact replay.
- [ ] Operator records whether manual page intervention occurred.
- [ ] Full unit, browser, and repository checks remain green after any repair.

## 9. Promotion gates

| Gate | Requirement | Status |
|---|---|---|
| A — Direct-airline generalization | Full-service + low-cost direct reach actual payment entry; Kiwi/GoToGate retained; no site workflow | 🧪 Prior review evidence exists; fresh expanded-milestone canaries and confirmation sites pending |
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
