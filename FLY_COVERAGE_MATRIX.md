# Fly Coverage Matrix

Last updated: 2026-08-10 CEST

## Purpose

This file is the current evidence-based answer to:

- Which universal checkout capabilities are proven?
- Which capabilities are replay-only, partially proven, failing live, or untested?
- Which sites have reached Fly's current terminal boundary?
- What is the next highest-leverage gap?

Use the documentation files as follows:

- `PRD.md` — product vision, scope, requirements, and promotion gates.
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
| Production build, type, and syntax checks | ✅ | `npm run check` passes after authority convergence and removal of dead live requirement/classifier modules. |
| Agent unit suite | ✅ 346/346 | Canonical settlement, single-commit persistence, bounded surface feedback, Selected Booking admission, canary reporting, transaction, policy, and safety gates remain green. |
| Browser replay set | ✅ 168/168 | The latest complete suite passes after extension runtime modularization, including EasyJet quantity/Skip bags/travel purpose/payment boundary, selected-booking price acquisition, blank Kiwi hydration, GoToGate payment review, Turkish controls, and irreversible-action negatives. |
| Targeted terminal and multi-surface replay | ✅ | GoToGate terminal evidence, hidden-future-payment rejection, checkpoint safety, Flexible Ticket, and the repeated-leg seat episode are proven without exposing payment capabilities. |

## Universal capability coverage

| Capability | Unit | Browser replay | Kiwi live | GoToGate live | Overall status | Current evidence / next proof |
|---|---:|---:|---:|---:|---|---|
| Scalar text and email entry | ✅ | ✅ | ✅ | ✅ | Proven | Email, confirm-email, name, and contact-field flows have verified normalized values. |
| Composite given-names field | ✅ | ✅ | ✅ | ✅ | **Replay-proven across shared/separate name layouts** | `First / Middle name` composes first plus optional middle and cannot invent a missing middle-name requirement; fresh Turkish live proof is pending. |
| Split-node exclusive profile choice | ✅ | ✅ | ✅ native | ✅ native | **Universal repair replay-proven; first half live-proven** | Turkish live proved wrapper/actuator merging and title classification. Broad accessibility contamination then collapsed both values to `mrs/ms`; exact ordinal-owned labels now produce distinct values and a `title:title` decision. Fresh live promotion is pending. |
| Stable logical identity across controlled rerender | ✅ | ✅ | ✅ | 🟡 | Broadly proven | Kiwi phone replacement/rebinding is accepted; retain GoToGate rerender coverage as checkout expands. |
| Native select with exact enum identity | ✅ | ✅ | ✅ | — | Proven | Kiwi nationality selects canonical Slovenia without substring mutation. |
| Editable autocomplete query → exact option → settled commit | ✅ | ✅ | ✅ | 🧪 | **Universal adaptive path live-proven on a direct airline** | Turkish `chk_msetj5a11ve2fi` used `386` only as a mechanical query, selected exact `Slovenia (+386)`, durably exposed `phone_country_code=+386`, then filled the local number and continued. Transfer to a second widget remains. |
| Composite phone field ownership | ✅ | ✅ | ✅ | 🧪 | **Cross-surface episode replay-proven** | Country prefix and national number remain one profile requirement; the opened option surface preserves the unfinished component objective until `+386` is semantically verified. |
| Canonical requirement admission | ✅ | ✅ | ✅ | ✅ | **Universal invariant live-proven on Turkish intake** | `chk_msdu1xuxy4j6y2` waived optional citizenship/marketing/loyalty, isolated the unfinished phone prefix, and opened its exact actuator. The later stop is a portal-continuation gap, not false obligation admission. |
| Authoritative Current Obligation | ✅ | ✅ full browser suite | ✅ retained | ✅ retained | **Universal authority, settlement, and lifecycle convergence replay-certified** | One obligation owns semantics, actuator candidates, action, verification, and recovery. A failed mechanic cannot silently schedule a later field, and useful progress clears the same episode's failed methods. Fresh EasyJet and retained-site live certification remain. |
| Canonical verified profile component | ✅ exact admission/invalidation | ✅ EasyJet blank-parent episode | ✅ retained | ✅ retained | **Single-settlement repair replay-proven; live pending** | Exact parent/child/value lineage, profile compatibility, successful dispatch, settled surface, clear owned validation, and unchanged price upgrade the canonical verifier to `LOGICAL_COMPONENT_COMMITTED`. TaskState durably remembers only that result; an incompatible fresh value or owned validation error reopens it. No second completion receipt exists. |
| Dormant decision exclusion and stage exit | ✅ shared lifecycle contract | ✅ combined EasyJet episode | ✅ retained | ✅ retained | **Universal repair replay-proven; live pending** | Explicitly dormant login/signup/future-step/duplicate controls remain observable diagnostics but cannot enter the actionable decision queue. Active requirements still outrank navigation; only after they settle does the existing exact enabled stage exit become the next goal. |
| Stage-exit candidate set | ✅ exact control/actuator evidence | ✅ occluded-first + ready-sibling replay | ✅ retained | ✅ retained | **Universal navigation admission replay-proven; live pending** | Every current Continue/Next representation is classified independently. One failed hit test cannot suppress an executable sibling. Failed hit tests record the actual top element and geometry, and internal readiness failures never become traveler questions. |
| Agent/page interaction isolation | ✅ exact underlying-target proof | ✅ sidebar-over-site replay | ✅ retained | ✅ retained | **Universal self-interference repair replay-proven; live pending** | Fly-owned sidebar/cursor/diagnostics become pointer-transparent only for bounded hit-testing and trusted dispatch. The exact underlying site actuator must match; genuine site overlays remain occluding and blocked. |
| Active profile branch admission | ✅ single lifecycle authority | ✅ complete EasyJet traversal | ✅ retained | ✅ retained | **Universal repair replay-proven; EasyJet live pending** | `active_rendered` versus `dormant_hidden` controls readiness, goals, skill planning, inferred blockers, and validation. The replay reaches real contact fields and enabled Continue without admitting hidden future templates. |
| Derived traveler facts | ✅ exact DOB/date arithmetic | ✅ age range boundary | ✅ retained | ✅ retained | **Universal deterministic adapter replay-proven** | `age_at_departure` comes only from DOB plus the selected-booking departure date (or an explicit supplied fact), then matches one freshly observed exact/range option. No departure date means no invented age. |
| Pre-goal semantic grounding | ✅ closed binding schema | ✅ lifecycle + binding replays | ✅ retained | ✅ retained | **Universal bounded bridge replay-proven; fresh-site live pending** | One unknown active component may bind only to an exact supplied component/type/source tuple. The model receives a complete bounded InteractionView but has no browser-action or value-authoring authority; unresolved evidence stops as `ACTIVE_REQUIREMENT_UNRESOLVED`. |
| Bounded adaptive surface operation | ✅ | ✅ | ✅ replay canary | ✅ replay canary | **Query-feedback episode replay-complete; fresh live promotion pending** | Exact target ownership survives normalization/governance. A narrow editable filter uses bounded mechanical hypotheses, remains intermediate-only, and hands off to one exact option; readonly openers and arbitrary textboxes cannot inherit filter or profile authority. |
| Consequence-gated no-goal interaction | ✅ | ✅ EasyJet seat-shell + commercial negative | ✅ retained | ✅ retained | **Universal source repair replay-proven; live pending** | Canonical goals remain first. When none exists, one exact current reversible control may proceed only if its consequences are low-risk and observable. Paid/legal/payment/identity/itinerary/marketing/external/purchase and unowned unknown commercial CTAs remain ineligible. |
| Compact interaction view + pre-surface actuator discovery | ✅ | ✅ full episode | ✅ retained replay | ✅ retained replay | **Universal open → exact choice → state settlement replay-proven; EasyJet live pending** | `interaction-view/v1` separates logical controls, exact actuators, and state representations. `pre-surface-discovery/v1` admits one bounded opener, exact token matching admits `Mr` but not `Mrs` for canonical `mr`, and verification reads retained state only from the compiled owner set. Hidden state geometry cannot trigger viewport recovery or override the visible actuator. |
| Cross-surface logical-field continuation | ✅ | ✅ | ✅ native/owned | 🟡 | **Ownership and exact candidate live-proven; reveal governance pending** | The logical phone component, dropdown surface, and Slovenia target all remained correct through planning. One surface-authority mismatch stops before scroll. |
| Canonical DOB and split-date handling | ✅ | ✅ | ✅ | ✅ | Proven | Canonical DOB verification works across native, scalar, and split controls. |
| Custom dropdown option binding | ✅ | ✅ | ✅ | 🧪 | Regression repaired; live recertification pending | Exact free option → child decline → retained-open completed parent now restores only its owning opener and never republishes a paid option. |
| Foreground surface ownership | ✅ | ✅ | ✅ | ✅ | **Structural modal versus persistent-chrome separation replay-proven** | Real dialogs, open dropdowns, substantial backdrops, focus-owning body locks, and actual center obstructions block background. Turkish bottom and easyJet side itinerary/price/seat summaries remain contextual even when their text contains an action such as `Choose seats for me`. Fresh direct-airline proof is pending. |
| Multi-surface parent/child decision episode | ✅ | ✅ | ✅ | 🧪 | Proven by exact replay; live recertification pending | Explicit lineage and fallback context are separate; exact actuator/postcondition evidence preserves the parent across stripped browser transport. |
| Exact completed-parent surface exit | ✅ | ✅ | — | 🧪 | Regression replay-proven; live recertification pending | The exit worked live in `chk_mscf4cw69xjhdj`; the discovering regression is now covered by an exact retained-open-parent replay that publishes only the owning opener. |
| Optional negative marketing handling | ✅ | ✅ | — | ✅ | Proven | Silent profile policy no longer turns newsletter opt-out into a required decision. |
| Paid bundle price/effect ownership | ✅ | ✅ | — | 🧪 | Repair replay-proven | Bidi/compact `EUR37.95` parses correctly, and typed `select_paid_option` is denied without exact authorization even if price/risk remains unknown. |
| Destination readiness and controller handoff | ✅ | ✅ | ✅ retained | ✅ retained | **Universal repair replay-certified; fresh EasyJet live pending** | Readiness owns only real loading/hydration, starts a fresh deadline for every stage/surface/URL destination, and hands stable checkout-relevant capabilities to TaskState. Blank Kiwi/payment shells remain transient; stable internal ambiguity never becomes a traveler question. |
| Fare, insurance, baggage, and seat policy resolution | ✅ | ✅ | ✅ | ✅ | Cross-site traversal proven | GoToGate resolved bundle, Flexible Ticket, both seat legs, final no-seat confirmation, and later ancillary declines from the profile. |
| Transaction fact provenance and durable reconciliation | ✅ | ✅ | ✅ | ✅ | **Direct-airline repair replay-proven; fresh live promotion pending** | `transaction-facts/v2` carries canonical monetary role/owner. The Turkish replay excludes XCover `66.25 EUR`, approves coherent `317.54 EUR`, reconciles the same payment total, and blocks a genuine `350 EUR` increase. |
| Payment-review terminal detection | ✅ | ✅ | ✅ | ✅ | **Cross-site live-proven** | `chk_msbs0ud3trktks` produced seven terminal signals on GoToGate's hosted/custom page, `boundaryObserved=true`, verified transaction facts, and zero payment capabilities. |
| Terminal outcome dominance / final arbitration | ✅ | ✅ | ✅ | ✅ | **Cross-site proven** | Full current replay passes; `chk_msbvdlbsznwy56` returned `final_review` in the fresh terminal turn with `payment_review_reached` and verified transaction evidence. |
| Profile-control role eligibility | ✅ | ✅ | ✅ | ✅ | **Cross-site proven** | Full current replay keeps payment commands out of profile fields; GoToGate payment scope contained no false contact controls and the activation-only Pay command did not become email. |
| Collision-free outcome-ledger identity and admission | ✅ | ✅ | ✅ | ✅ | **Cross-site live-proven** | GoToGate trace `chk_msdar6yu7k7bor` retained eight distinct expected owners for bundle, Flexible Ticket confirmation, and six sibling extras. No sibling inherited its predecessor. Flexible Ticket still has extra compatible audit representations to compact, but they do not compete with expected identity. |
| Verified-action journal coverage | ✅ | ✅ | ✅ | ✅ | **Cross-site live-proven** | GoToGate reconciled 8/8 durable action receipts with `missingActionIds=[]`, `missingDecisionInstanceIds=[]`, complete coverage, verified transaction facts, and `payment_review_reached`. |
| No payment, billing, legal, card, or purchase action | ✅ | ✅ | ✅ | ✅ so far | Safety green | This invariant must remain green even on incomplete runs. |
| Typed recovery, loop detection, and precise stop | ✅ | ✅ | ✅ | ✅ | **Simplified internal/user boundary replay-proven** | True hydration and dispatched no-effect recovery remain bounded. The removed `blocked_navigation` task can no longer wait four times or ask the traveler about internal mechanics; stable actionability exhaustion emits a diagnostic internal stop while consequential uncertainty still hands off safely. |
| Incremental single-authority runtime | ✅ | ✅ | 🧪 retained | 🧪 retained | **Implemented and replay-certified; fresh live timing pending** | One observation row feeds one TaskState turn commit; governed fields emit one result; action result/status/event commit atomically; conclusive local popup transitions avoid an immediate full rebuild while all ambiguous or consequential outcomes retain canonical verification. |

## Site acceptance matrix

| Site | Traveler/contact | Reversible decisions | Seats | Transaction facts | Payment review | Irreversible-action safety | Current result | Latest evidence |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Kiwi | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **Accepted baseline; fresh canary passed** | `chk_msdaz8oiuvr170` reached verified payment review in about 3m21s with 5/5 durable receipts reconciled, zero missing IDs, one safe stale refusal, and no irreversible action. |
| GoToGate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **Accepted baseline** | `chk_msdar6yu7k7bor` reached verified payment review in about 3m06s with 8/8 receipt obligations reconciled, zero missing IDs, complete transaction review, one correct destination-hydration wait, and no irreversible action. |
| Turkish Airlines | ✅ traveler/contact + exact `+386` live autonomously | ✅ advanced additional services | ✅ advanced seat stage | ✅ v2 role/owner live-proven | ✅ transaction-verified payment review | ✅ no irreversible action | **Technical canary passed; autonomous annotation pending** | `chk_msmf1xe5on6zvr` reached verified payment review for two legs, one traveler, and `241 EUR` in about 52s. It used 17 trace turns, 18 client requests, two model calls, and no pre-boundary handoff. The trace cannot prove whether the user intervened, so final autonomous acceptance still requires explicit confirmation. |
| easyJet | ✅ names/title/derived age/contact/travel purpose live | ✅ seats, cabin/hold bags, and add-ons traversed | ✅ safe seat path live | 🟡 itinerary live; booking-total acquisition repaired, live pending | 🟡 payment boundary reached; verified baseline pending | ✅ safe boundary retained | **Traversal works; latency and complete selected-booking baseline are current gates** | `chk_msiw4zaiwm0q8c` reached the payment boundary after selecting Leisure and skipping paid extras. It took about 4m43s and stopped with baseline total/currency missing despite observing `362 EUR` at review. Incremental runtime and price-required acquisition are now replay-certified. |
| Structurally different OTA #2 | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | Not selected | Choose for interaction structures not already covered by Kiwi, GoToGate, and the direct airline. |

## Active capability queue

| Priority | Capability / invariant | Roadmap owner | Current evidence | Promotion gate |
|---:|---|---|---|---|
| 1 | Live-promote Incremental Single-Authority Runtime on EasyJet. | #3 + #7 + #13 + #16 | The full checkout now works, but the last run spent almost all wall time outside the model. Duplicate state/result work and immediate surface rescans are removed in source. | Restarted run materially reduces planning/report/observation wall time, reaches verified payment review, and performs no irreversible action. |
| 2 | Prove complete Selected Booking acquisition before checkout. | #5 + #15 | The last EasyJet capture had itinerary but omitted its selected total/currency, causing a correct late review stop. Admission now requires authoritative `booking_total` and currency. | Passenger-page session begins with route/date/traveler/currency/total baseline and reconciles the same `362 EUR` at review. |
| 3 | Represent consequential policy-compatible no-op decisions without fabricating executed-action receipts. | #6 + #13 + #15 | Turkish reached verified payment review with correct transaction facts but `0 expected / 0 journal / 0 ledger` because seat/insurance remained compatible without a commerce mutation. | One typed no-op decision outcome explains why no action was required, remains separate from the action receipt register, and final coverage is non-vacuous without weakening paid-extra or terminal gates. |

## Cross-airline validation tracker

Generate the objective report for the newest live run with:

```bash
npm run canary:report -- --latest
```

Use `--session chk_...` for a specific trace, `--latest-by-site` for the latest evidence per airline/OTA, and `--write` to persist the normalized JSON report under `work/canary-reports/`. Add `--manual none` only when no human altered the airline page; use `--manual yes` for an assisted run. Without that explicit annotation, technically complete evidence remains `review_required` rather than being called autonomous acceptance. The command reads the existing trace and compact client timing log; it does not create a second runtime authority or alter checkout state.

This is the operational checklist for Roadmap #17. Test checkout structures deliberately rather than accumulating airline brands. A primary site discovers missing capabilities; a confirmation site in the same family proves that the repair was generic.

### Portfolio checklist

| Wave | Structural family | Primary site | Confirmation site | Controlled baseline | Alternate route/date | Rerender/recovery run | Verified payment review | Latest trace / next action |
|---:|---|---|---|---:|---:|---:|---:|---|
| 0 | Existing OTA | GoToGate | — | [x] | [x] | [x] | [x] | Accepted on `chk_msdar6yu7k7bor`; retain as a canary. |
| 0 | Custom OTA | Kiwi | — | [x] | [x] | [x] | [x] | Accepted on `chk_msdaz8oiuvr170`; retain as a canary. |
| 1 | International full-service direct airline | Turkish Airlines | Lufthansa | [x] | [ ] | [x] site-failure restart | [x] transaction-verified | `chk_mseysb5cpjli9j` reached verified payment review with an approved `317.54 EUR` baseline and no contradiction. Add no-op decision accounting, retain canaries, then use Lufthansa as family confirmation. |
| 1 | European low-cost direct airline | easyJet | Ryanair or Wizz Air | [ ] | [ ] | [ ] | [ ] | Test ancillary, baggage, seat, and opt-out structure. |
| 1 | United States network airline | American or United | The other airline | [ ] | [ ] | [ ] | [ ] | Test US traveler, phone, address, and checkout conventions. |
| 1 | Long-haul international airline | Emirates or Qatar Airways | The other airline | [ ] | [ ] | [ ] | [ ] | Test nationality/document and long-haul checkout structure. |
| 1 | Regional airline | Croatia Airlines | Select after primary | [ ] | [ ] | [ ] | [ ] | Test a smaller and potentially less standardized checkout. |
| 1 | Structurally different OTA | Trip.com or eDreams/Opodo | Select after primary | [ ] | [ ] | [ ] | [ ] | Choose by observed structure, not brand count. |
| 2 | Asian/localized airline | Singapore Airlines or Korean Air | The other airline | [ ] | [ ] | [ ] | [ ] | Begin after the main Wave 1 families are stable. |

For every new primary site, use the same first scenario: one adult, complete profile, simple return itinerary, no paid extras, random/no specific seat, no extra baggage, and stop at verified payment review. Do not mix structural discovery with new profile-policy complexity.

### Site acceptance checklist

A site becomes accepted only when every item is checked:

- [ ] Tested commit and trace ID recorded.
- [ ] Traveler/contact facts semantically verified.
- [ ] Every consequential reversible decision follows explicit profile policy.
- [ ] Seats and baggage resolve without an unauthorized paid selection.
- [ ] Approved itinerary, traveler, currency, and total reconcile at final review.
- [ ] `terminalStatus=payment_review_reached` and `transactionReview.ready=true`.
- [ ] Outcome coverage is non-vacuous and complete; missing action and decision IDs are empty.
- [ ] No payment, billing, legal, card, Pay, purchase, or other irreversible action executes.
- [ ] Every material failure discovered during the run has an exact replay.
- [ ] The repair adds a universal contract or reusable pattern, never a site workflow.
- [ ] Unit tests, browser replays, and `npm run check` pass after the repair.
- [ ] The discovering site and at least one accepted canary pass after material core changes.

### Scenario and profile-policy tracker

Start this matrix only after several Wave 1 structural families pass the controlled baseline. Do not run the full Cartesian product. Prove every consequential scenario on at least two structurally different families, and give every accepted site the baseline plus at least one stress scenario.

| Scenario | Primary proof site | Second structural family | Replay | Live proof | Status / notes |
|---|---|---|---:|---:|---|
| Complete single traveler, no paid extras | Kiwi / GoToGate | Direct airline pending | [x] | [x] | Existing baseline is accepted; direct-airline proof pending. |
| Half-filled or incorrect traveler facts | Select after Wave 1 | Select after Wave 1 | [ ] | [ ] | Correct only the exact profile contradiction. |
| Required fact missing from profile | Select after Wave 1 | Select after Wave 1 | [ ] | [ ] | Ask one precise question and resume the same task. |
| Two adults | Select after Wave 1 | Select after Wave 1 | [ ] | [ ] | Preserve passenger-specific ownership. |
| Adult plus child | Select after Wave 1 | Select after Wave 1 | [ ] | [ ] | Exercise age and passenger-specific requirements. |
| Explicit paid baggage with maximum budget | Select after Wave 1 | Select after Wave 1 | [ ] | [ ] | Require exact typed authorization and total reconciliation. |
| Specific seat with maximum budget | Select after Wave 1 | Select after Wave 1 | [ ] | [ ] | Verify leg, passenger, seat, and price ownership. |
| Preselected unauthorized paid extra | GoToGate replay | Direct airline pending | [x] | [ ] | Reverse only the exact owned conflict before continuing. |
| Login required | Select after Wave 1 | Select after Wave 1 | [ ] | [ ] | Pause safely and resume without duplicating actions. |
| OTP or CAPTCHA required | Select after Wave 1 | Select after Wave 1 | [ ] | [ ] | Treat as an expected user handoff, not autonomous failure. |
| Multi-leg itinerary | GoToGate | Direct airline pending | [x] | [x] | Direct-airline confirmation pending. |
| Currency or total changes | Select after Wave 1 | Select after Wave 1 | [ ] | [ ] | Reconcile or request authority before consequential progress. |
| Airline outage, sold-out flight, or site failure | Kiwi | Direct airline pending | [x] | [x] | Report the external blocker without destructive recovery. |

### Promotion gates

| Gate | Required evidence | Status | Unlocks |
|---|---|---:|---|
| A — Direct-airline generalization | One full-service and one low-cost direct airline reach verified payment review; Kiwi and GoToGate remain green; no site workflow is introduced. | [ ] | Continue structural portfolio expansion. |
| B — Structural portfolio | Approximately 8–10 sites across at least 6 observed structural families, including at least 2 OTAs and confirmation on important direct-airline families. | [ ] | Internal/allowlisted checkout-to-review alpha. |
| C — Profile and policy coverage | Multi-traveler, missing-data handoff, paid baggage, seat authorization, dirty checkout correction, and login/OTP resume each pass on at least two structural families. | [ ] | Limited checkout-to-review beta and isolated payment sandbox work. |
| D — Reliability evidence | A defined acceptance window of about 300 distributed eligible journeys supports the target success rate; false completion and unauthorized consequential mutation remain zero. | [ ] | Broader checkout-to-review production consideration. |
| E — Payment safety architecture | PCI-appropriate vault/provider, explicit per-booking authorization checksum, idempotency, duplicate protection, 3DS/OTP pause-resume, and independent PNR/ticket confirmation are proven in sandbox. | [ ] | Narrow allowlisted payment pilot after security/compliance review. |

### Reliability scorecard

Do not claim `99%` from a handful of demonstrations. Track autonomous completion, safe resolution, and safety violations separately.

| Metric | Current evidence | Promotion target |
|---|---:|---:|
| Accepted structural families | 2 OTA families | At least 6 observed families |
| Accepted direct-airline families | 0 | At least 4 primary families, with confirmation where repairs were required |
| Accepted OTA families | 2 | At least 3 structurally different OTAs |
| Current-worktree live canaries | 0/2 rerun; historical baselines 2/2 | Kiwi and GoToGate green after every material core change |
| Automated unit suite | 288/288 | 100% green |
| Browser replay suite | Previous full baseline 142/142; current matrix 143 cases, final combined rerun pending | 100% green |
| Distributed eligible acceptance window | Not started | About 300 representative journeys, analyzed with a confidence bound |
| False terminal completion | 0 in current accepted canaries | 0 |
| Unauthorized irreversible mutation | 0 in current accepted canaries | 0 |

### Live-run log

Add one concise row for each material run. Keep detailed chronology in `FLY_PROGRESS.md`.

| Date | Site | Commit | Scenario | Trace | Result | First failed contract / key evidence | Safety | Replay / next action |
|---|---|---|---|---|---|---|---|---|
| 2026-08-03 | GoToGate | `5a2ce6b` | Controlled baseline | `chk_msdar6yu7k7bor` | ✅ Payment review | 8/8 expected receipts; complete transaction review | ✅ No irreversible action | Retain as canary. |
| 2026-08-03 | Kiwi | `5a2ce6b` | Controlled baseline | `chk_msdaz8oiuvr170` | ✅ Payment review | 5/5 expected receipts; complete transaction review | ✅ No irreversible action | Retain as canary. |
| 2026-08-04 | Turkish Airlines | dirty `dev` worktree | Controlled baseline | `chk_msen80j7gvbmu1` | ❌ Traveler-page site failure | Valid surface-owned filter suppressed by false opener/filter graph conflict; reveal fallback eventually committed `+386`, then Turkish rejected Continue. | ✅ Explicit site failure stopped; no irreversible action | Add exact cooperative-component ownership replay, repair #2/#9/#11, rerun Turkish, then canaries. |
| 2026-08-04 | Turkish Airlines | dirty `dev` worktree | Controlled baseline | `chk_msetj5a11ve2fi` | 🟡 Payment reached; certification blocked | Adaptive `386` → exact `+386` and browser navigation passed live. XCover `66.25 EUR` option price contaminated the collecting booking baseline; final `317.54 EUR` triggered false `UNAPPROVED_PRICE_CHANGE`. | ✅ No payment, card, legal, billing, or purchase action | Add monetary role/owner and coherent-baseline replays; rerun Turkish, then Kiwi/GoToGate. |
| 2026-08-04 | Turkish Airlines | dirty `dev` worktree | Controlled baseline | `chk_mseysb5cpjli9j` | ✅ Transaction-verified payment review; accounting acceptance pending | Approved two-leg `317.54 EUR` baseline matched payment; XCover `66.25 EUR` remained ancillary; `missingFacts=[]`, `contradictions=[]`, terminal latch complete. Coverage was vacuous `0/0`; phone selection remained slow. | ✅ No payment, card, legal, billing, or purchase action | Add a universal no-op decision outcome contract, rerun Kiwi/GoToGate canaries, and transfer the direct-airline proof to Lufthansa. |
| 2026-08-04 | easyJet | dirty `dev` worktree | Controlled baseline | `chk_msez60hyieyxll` | ❌ Traveler title custom select | First/last name verified; `title=mr` was known, but hidden state and visible opener were not one proven capability. Three reveal attempts exhausted safely. A fare-rule sentence also became a false partial route. | ✅ No consequential or irreversible action | Add the exact composite custom-select and false-route replays; repair the shared graph/capability boundary; rerun easyJet and retained canaries. |
| 2026-08-05 | easyJet | dirty `dev` worktree | Controlled baseline after composite settlement | `chk_msg26ymqhrvb9z` | 🟡 Title passed; traveler profile stopped | Exact `Mr` returned `LOGICAL_COMPONENT_COMMITTED`. Four hidden `0×0` email inputs from dormant branches plus synthetic hidden confirm-email validation became current requirements; age placeholder was also considered selected. | ✅ Safe stop; no consequential or irreversible action | Add active-lifecycle requirement admission and shared placeholder commitment replays; rerun easyJet, then Kiwi/GoToGate. |
| 2026-08-05 | easyJet-shaped replay | dirty `dev` worktree | Dormant alternate forms → rendered contact hydration | automated replay | ✅ Universal repair proven | Hidden sign-in/signup/contact emails remain observable but dormant; no profile goal, inferred blocker, or confirm-email validation is published. `Age at time of travel` remains uncommitted. Revealing contact immediately publishes the exact email goal. | ✅ 275 unit + 137 browser; no safety boundary changed | Reload/restart and rerun EasyJet live, then one accepted canary. |
| 2026-08-05 | Selected Booking / EasyJet-shaped replay | dirty `dev` worktree | Flight selection route/date → passenger page with hidden itinerary | automated session + browser replay | ✅ Acquisition and durable derivation proven | Fully owned typed route/date enters the existing invariant baseline before passenger rendering. Resume retains it; age derives from DOB + baseline only. Missing date is reported as a booking-source gap, not missing traveler age. | ✅ 285 unit + 138 browser; no payment or site-specific action added | Reload extension/restart backend; run EasyJet from selection to payment review, then Kiwi or GoToGate canary. |
| 2026-08-05 | easyJet | dirty `dev` worktree | Persistent itinerary Edit controls on passenger page | `chk_msg7m2u5rjzrga` | ❌ Acquisition incomplete; safe precise stop | Names and exact `Mr` completed. Both full route/date legs were visible in owned Edit controls, but browser transaction facts and durable baseline retained `segments=[]`; age was therefore unavailable. Capture polling continued on extension-driven mutations after handoff. | ✅ No invented age, paid action, Edit action, payment, legal, card, or purchase mutation | Add universal exact itinerary-action evidence, stop post-session capture polling, expose acquisition status, then rerun EasyJet and one accepted canary. |
| 2026-08-05 | easyJet-shaped exact replay | dirty `dev` worktree | Live Edit-route controls → durable selected booking → derived age | automated browser/session replay | ✅ Universal acquisition repair proven | Exact live labels compile to `LJUBLJANA → EDINBURGH · 2026-08-15` and return; unrelated passenger Edit text is rejected. Edit controls are context-only, capture stops after session creation, and sidebar status is visible. | ✅ 285 unit + 138 browser; all irreversible-action boundaries retained | Reload/restart and live-run EasyJet, then Kiwi or GoToGate canary. |
| 2026-08-05 | easyJet | dirty `dev` worktree | Published age task → raw-page actuator binding | `chk_msg80sof1olh25` + exact replay | 🧪 Source repaired; live proof pending | The live run had a complete immutable itinerary and published `age_at_departure=23`, but downstream candidate reconstruction discarded it and emitted zero candidates. Execution now consumes that published task and only rebinds current mechanics; the replay passes without candidate-time Selected Booking injection. | ✅ 285 unit + 138 browser; Kiwi/GoToGate/Turkish and irreversible-action boundaries retained | Reload/restart, rerun EasyJet to payment review, then run one accepted Kiwi/GoToGate canary. |
| 2026-08-05 | easyJet | dirty `dev` worktree | Verified age opener → child option surface → committed category | `chk_msgcbwd0wx62ab` + exact replay | 🧪 Source repaired; live proof pending | Age `23` and the correct opener were known, but transient page readiness blocked exact task transfer; generic planning replaced it and treated `18+` as potentially paid. Verified openers now retain task ownership and shared semantic compatibility maps `23` to `18+` through planning and verification. | ✅ 285 unit + all 139 browser cases green; no paid, stale, payment, legal, card, or purchase boundary changed | Reload extension/restart backend; rerun EasyJet to payment review, then run one accepted Kiwi/GoToGate canary. |
| 2026-08-05 | easyJet | dirty `dev` worktree | Causal dropdown-settlement experiment | live run + rollback matrix | ⛔ Rejected and fully rolled back | Popup closure plus newly enabled Continue was too weak as profile-field completion authority: the live run slowed down and revisited completed work. Removed synthetic parent commitment, reconstructed-goal rewriting, and duplicate-decision suppression; restored canonical selected value/state verification. | ✅ After rollback: 284 unit + 139 browser + repository check; retained Kiwi/GoToGate/Turkish and irreversible-action boundaries | Reload extension/restart backend and rerun EasyJet from the restored baseline before proposing another fix. |
| 2026-08-06 | easyJet | dirty `dev` worktree | Post-rollback traveler form | `chk_msgg67or6wz1w7` | ❌ Exact age selected; canonical settlement incomplete | Title and names completed. Exact `18+` dispatched once and closed its popup, but the parent age control stayed blank and verification returned `LOGICAL_COMPONENT_NOT_COMMITTED`; Age reopened instead of Continue. Four stale-hash refusals and ~141 MB of trace state amplified latency. | ✅ No wrong age, paid, navigation, payment, legal, card, or purchase action | Superseded: exact child evidence now upgrades the canonical verifier directly and TaskState persists only that verified component. |
| 2026-08-06 | easyJet + retained canaries | dirty `dev` worktree | Authority convergence and agent/page isolation | automated full suite | ✅ Universal source repair certified; live promotion pending | Agent UI cannot occlude its governed site actuator; unfocused-tab dispatch has no rAF dependency; every Continue remains a candidate; exact child settlement has one canonical verifier; recovery has one episode; legacy live requirement inference is removed. Delayed choice readiness and useful-progress reset are exact regressions. | ✅ 286/286 unit, 142/142 browser, focused isolation replay, full repository check; irreversible boundaries unchanged | Reload/restart and live-run EasyJet. Accept only after one `18+`, one exact Continue, no Age revisit/internal question; then rerun Kiwi and GoToGate. |
| 2026-08-06 | easyJet + retained canaries | dirty `dev` worktree | Canonical child settlement through lifecycle rewriting | `chk_mshedz2z3uhhki` + exact replay | 🧪 Source repaired; live proof pending | Browser correctly verified exact `18+`, but generic parent transition downgraded the local result because EasyJet's framework select stayed blank. Lifecycle now preserves canonical local settlement and tracks broader progress separately; TaskState advances to enabled Continue. | ✅ 286/286 unit, 142/142 browser, full repository check; no receipt restored and irreversible boundaries unchanged | Reload/restart and rerun EasyJet. Then run Kiwi and GoToGate canaries. Track transport latency separately. |
| 2026-08-06 | easyJet | dirty `dev` worktree | Traveler page → Seats | `chk_mshf1di35xcw1t` / `chk_mshf6rwlyu4s8z` + exact replay | 🧪 Live discovery; universal source repaired | Traveler fields, exact derived `18+`, and Continue advanced correctly. On Seats, a persistent itinerary/price/seat summary was falsely exclusive and the exact safe `Choose seats for me` actuator had no canonical goal. Structural foreground ownership plus one consequence-gated no-goal interaction now admits the safe actuator while an unowned commercial `Continue with Standard` negative remains denied. | ✅ 288/288 unit and repository checks; no paid, identity, itinerary, legal, payment, card, purchase, or unknown commercial action admitted | Complete full 143-case browser rerun; reload/restart and rerun EasyJet to payment review, then Kiwi and GoToGate canaries. |
| 2026-08-06 | easyJet | dirty `dev` worktree | Traveler page → stable Seats destination | `chk_mshja11iu8lys0` | ❌ Readiness bypassed the controller | The run was materially faster and exact traveler/age/Continue actions succeeded. Seats exposed 110 controls, 5,409 characters, two enabled safe `Choose seats for me` controls, paid seat controls, and disabled Next on `surface-page`. Legacy readiness nevertheless required a recognized seat contract plus an advancing control, reused the prior traveler deadline, then emitted `ask_user` before TaskState/adaptive interaction. | ✅ No paid or irreversible action; the stop was internal and unnecessary | Make readiness hydration-only, reset deadline on destination-key change, require checkout relevance in fallback admission, and replay the complete transition before rerunning EasyJet and retained canaries. |
| 2026-08-08 | Diagnostic storage safety | dirty `dev` worktree | Trace/log persistence under constrained disk | retention unit tests + complete automated suite | ✅ Implemented | Durable V2 SQLite is isolated from disposable diagnostics; sessions/files/bytes/age are bounded; explicit `.pinned` evidence is preserved; JSONL rotates; low disk skips diagnostics instead of stopping checkout; diagnostic and transaction paths can use different volumes. | ✅ Free space recovered from 934 MB to 36 GB; 313/313 unit, 154/154 uninterrupted browser replays, and repository checks pass | Keep SQLite local/external for current development; use Postgres/Supabase for compact hosted transaction rows and lifecycle-managed object storage for trace blobs. |
| 2026-08-08 | GoToGate-shaped root convergence + retained canaries | dirty `dev` worktree | Non-ARIA seats → exact safe exit → bounded re-observation | integrated replay + complete automated suite | 🧪 Authority convergence certified; live promotion pending | `CurrentSurface` exclusively owns overlay blocking; full/incremental stage exits agree; disabled Add-to-cart state is non-commerce; genuine selected paid items still require exact reversal; hidden Skip cannot borrow Next/Back; unselected paid-only surfaces may use an independently proven safe exit; unchanged waits send one compact reference retry. | ✅ 311/311 unit, 154/154 uninterrupted browser replays, and repository checks; payment/legal/purchase boundaries unchanged | Restart extension/backend; run GoToGate, EasyJet, Kiwi, and Turkish canaries and record median/p95 client round-trip plus server phase timings. |
| 2026-08-10 | Turkish Airlines | pre-report `dev` worktree | Controlled baseline after extension modularization | `chk_msmf1xe5on6zvr` | 🟡 Technical payment-review pass; autonomous annotation pending | Verified payment review, complete two-leg itinerary, one traveler, and `241 EUR`; 52s trace wall time, 17 turns, 18 requests, two model calls, 77ms median / ~3s p95 client round trip, and ~2.9MB p95 observation payload. | ✅ No prohibited executed action observed; zero pre-boundary user handoffs | Confirm whether the run had manual page intervention, then run fresh EasyJet, GoToGate, and Kiwi canaries with `npm run canary:report`. |
| 2026-08-06 | easyJet + retained canaries | dirty `dev` worktree | Readiness → one runtime controller | complete automated suite | 🧪 Universal source repair certified; live promotion pending | Readiness is hydration-only, destination deadlines cannot leak across stages/surfaces/URLs, stable relevant controls reach TaskState, and irrelevant reversible utility controls cannot become progress. The exact EasyJet-shaped boundary chooses only `Choose seats for me`; paid seats remain excluded. | ✅ 291/291 unit, 143/143 browser, and repository checks; blank Kiwi/payment shells and all irreversible boundaries remain green | Reload extension/restart backend; run EasyJet to payment review, then Kiwi and GoToGate canaries. |
| 2026-08-06 | easyJet | dirty `dev` worktree | Seats → Cabin bags | `chk_mshk9hv0gp9ums` | ❌ Luggage decision/effect ownership | Traveler details, Continue, and safe random/no-paid seating advanced live. `Same for all flights` was a checked scope toggle but inherited the nearby `41.24 EUR` bag price and became a false paid selection; `Add a large cabin bag → Bring onboard` became a false route; visible `Skip bags` was not the exact owned safe resolution. | ✅ Transaction governor stopped; no paid or irreversible action | Add the live-shaped ownership replay, separate scope from commerce effects, require exact price ownership and travel-qualified route evidence, bind free exit to baggage subject, then rerun EasyJet and canaries. |
| 2026-08-05 | Turkish Airlines | dirty `dev` worktree | Controlled baseline repeat | `chk_msfzb5l8oa9b0h` | ✅ Transaction-verified payment review; latency/accounting pending | `317.54 EUR` and both legs reconciled with zero contradictions; `66.25 EUR` remained ancillary. 21 turns, ~226s backend round-trip, ~28.9s observation, ~14.9 MB transport; coverage `0/0`. | ✅ No payment, card, legal, billing, or purchase action | Preserve as correctness canary; fix compact interaction/transport and pre-surface discovery before another Turkish timing run. |

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
