# Fly Current Codebase: Engineering Handoff

**Snapshot date:** 2026-07-26

**Branch:** `dev`

**Committed baseline:** `1b3d3d0 Fix destination readiness lifecycle`

**Working tree:** contains the uncommitted Logical Field Adapter and airline/OTA coverage work described below

**Backup:** `stash@{0}: backup before reverting to 1b3d3d0 on 2026-07-25`

Related planning documents:

- [`AGENT_ARCHITECTURE_PLAN.md`](./AGENT_ARCHITECTURE_PLAN.md)
- [`P_AGENT_ARCHITECTURE_TRACKER.md`](./P_AGENT_ARCHITECTURE_TRACKER.md)
- [`FLY_EXECUTION_TODO.md`](./FLY_EXECUTION_TODO.md)

This file is the current engineering handoff. Running code and fresh traces remain the final truth when this document disagrees with an older plan or tracker.

---

## 0. Engineering Brief

### Immediate objective

Restore one generic invariant:

> If the fresh browser observation exposes an unresolved logical component with a canonical executable operation, that component must remain executable through the backend and must be attempted before the agent hands off or stops.

The intended behavior is deliberately simple:

```text
observe
→ identify unresolved logical requirements
→ preserve their control and operation contracts
→ choose one executable requirement
→ execute one action
→ verify from a fresh observation
→ preserve successful progress
→ continue
```

This is a cross-site forms-engine requirement. It must not be implemented with Kiwi selectors, airline branches, fixed coordinates, or a hardcoded field sequence.

### Current production failure

The latest live Kiwi session, `chk_ms1zeif8wxokn5`, did not fail because the scheduler stopped at the first unavailable field. That earlier scheduling defect is no longer the first blocker.

The latest sequence was:

```text
names already filled and verified
→ try Title visual wrapper
→ OPTIONS_SURFACE_NOT_APPEARED
→ continue to another requirement
→ try DOB Month visual wrapper
→ OPTIONS_SURFACE_NOT_APPEARED
→ inspect the remaining DOB Day and Year controls
→ incorrectly classify Day and Year as SEMANTIC_AMBIGUITY
→ STRATEGIES_EXHAUSTED
→ stop
```

The final reason was:

```text
title.value=STRATEGIES_EXHAUSTED
date_of_birth.day=SEMANTIC_AMBIGUITY
date_of_birth.month=STRATEGIES_EXHAUSTED
date_of_birth.year=SEMANTIC_AMBIGUITY
```

However, the stored fresh observation says:

```text
DOB Day:
  component intended by the browser observer: day
  operation: type
  actuator: enabled, visible, in viewport, hit-tested
  actionability code: ACTIONABLE

DOB Year:
  component intended by the browser observer: year
  operation: type
  actuator: enabled, visible, in viewport, hit-tested
  actionability code: ACTIONABLE
```

The agent should therefore have typed `31` into Day and `2003` into Year. A blocked Title or Month widget must not prevent those actions.

### Verified root problem

The same control is being reinterpreted by multiple layers, and those layers disagree.

1. The browser observer creates the correct date-component contract, including `dateField.component` and date options.
2. `compactPageMap` preserves `dateField`.
3. The backend's `compactLogicalControl` compacts the control a second time but drops `dateField` and `options`.
4. `skill-expander` then calls the full-date codec again for each already-split date component.
5. Without the component metadata, Day and Year are treated as ambiguous full-date inputs instead of deterministic component inputs.

There is a second actionability contradiction:

1. The browser observer publishes a nearby disabled-select recovery region with `status: "unproven"`.
2. Candidate construction accepts the bounded region as executable.
3. The runtime affordance records the same actuator as `proven: true`.
4. Dispatch sends synthetic pointer/mouse events to the wrapper.
5. Kiwi exposes no option surface, so verification correctly fails.

The trace cannot prove whether the wrapper node is wrong, the synthetic event mechanism is insufficient, or both. It does prove that the region was never a proven executable actuator and must not have been represented as one.

### Minimal root fix

Do not add another controller. Repair the existing contract:

1. Preserve `dateField` and `options` through `compactLogicalControl`, ideally using one shared control serializer rather than two drifting whitelists.
2. For a logical date with `componentRole` equal to `day`, `month`, or `year`, use that component's desired value directly. Only run full-date order inference for one scalar full-date input.
3. Never promote `recovery.status !== "proven"` to a proven executable actuator.
4. For a custom dropdown, dispatch only through an observed executable activation member. If only an unproven visual region exists, it may be treated as a bounded experiment once, but a failure must not block other canonical fields.
5. Keep the current actionable-requirement scheduler. It now continues past failed fields; rewriting it again would not address the latest failure.

### Definition of done

- The exact latest Kiwi observation produces deterministic actions for DOB Day `31` and DOB Year `2003`.
- The agent never reports `STRATEGIES_EXHAUSTED` while any unresolved requirement has a fresh executable operation.
- A blocked Title or Month does not stop Day, Year, or any other actionable field.
- `dateField.component`, date options, and operation actionability survive extension → backend → planner round trips.
- Split date components never receive full-date values or full-date-order ambiguity.
- An `unproven` recovery is never recorded as `proven: true`.
- A failed custom-widget activation is bounded, remembered on the unchanged page, and does not erase verified component progress.
- A server-compaction regression test covers the real request boundary.
- A production-shaped browser test does not use a document-level listener that opens on any descendant click.
- Raw Kiwi advances beyond traveler information.
- Existing GoToGate behavior and all payment, purchase, legal, and paid-extra boundaries remain unchanged.

---

## 1. Current Status

Fly is a Chrome extension plus a local Node backend that operates an already-open airline or OTA checkout. It uses a saved traveler profile and user policy to complete traveler information, decline unwanted paid extras, navigate checkout surfaces, and stop at payment review.

The committed baseline already contains the main safety and lifecycle foundation:

- canonical browser observations;
- one-action-at-a-time execution;
- fresh post-action observation and verification;
- authoritative TaskState progression;
- grounded candidate IDs;
- action governor and transaction safeguards;
- paid-extra reconciliation;
- destination-readiness lifecycle after navigation;
- terminal payment boundary;
- bounded recovery and user handoff.

The current uncommitted work adds two focused capabilities:

1. A generic authoritative Logical Field Adapter for scalar and composite traveler requirements, including stable rerender identity and hierarchical verification.
2. Sidebar injection on a broader allowlist of airline and OTA domains, including Kiwi.

The current code is not yet committed or pushed.

### Latest validation and live result

An earlier full automated validation of this working tree reported:

- `175/175` unit tests;
- `64/64` browser regression tests;
- `npm run check`;
- `git diff --check`;
- existing clean and dirty GoToGate regressions;
- seat, review-modal, navigation-readiness, and payment-safety regressions;
- a sanitized production-shaped Kiwi split-DOB replay.

That result is no longer sufficient evidence of production correctness. The latest real Kiwi run failed at the traveler-information stage for the contract reasons documented in Section 0.

During the current diagnosis, these focused tests passed:

- the scheduler test that moves from an exhausted Title strategy to actionable Nationality;
- the bounded ambiguous-date unit test;
- the browser `Title visual recovery remains grounded` fixture.

These passes help locate the coverage gap:

- unit observations bypass the backend's second control compaction;
- the Title browser fixture opens from a document-level listener on any descendant of its wrapper;
- the fixture therefore does not prove that a real framework widget exposes the same actuator or accepts the same synthetic event sequence.

Do not describe the current tree as live-accepted on Kiwi. The latest live evidence is a failure with two specific shared-contract defects.

One browser stress test with 320 controls is functionally green but now takes roughly three minutes. Its timeout is currently `210_000 ms`. Treat this as a performance signal, not a correctness failure.

---

## 2. Product and Safety Boundary

The active release goal is:

```text
Open checkout
→ fill known traveler information
→ resolve required decisions
→ decline or remove policy-conflicting paid extras
→ navigate checkout
→ verify payment-review evidence
→ stop
```

The agent must not autonomously:

- enter or submit payment credentials;
- submit the final purchase;
- accept legal terms without authorization;
- add a paid product against policy;
- perform an irreversible cancellation or booking action;
- bypass OTP, CAPTCHA, bank approval, or explicit user authorization.

Fresh page facts are authoritative. TaskState is verified memory and progression state; it must not override a contradictory fresh observation.

---

## 3. Authoritative Runtime Loop

The intended production loop remains:

```text
observe
→ classify readiness
→ reconcile TaskState with fresh facts and policy
→ derive the current requirement
→ build grounded current candidates
→ select deterministically or use bounded AI for genuine ambiguity
→ govern
→ execute one action
→ reobserve
→ verify the semantic result
→ continue, recover, hand off, or stop
```

Important invariants:

- Candidate generation does not invent browser controls.
- AI may interpret ambiguity but may select only observed, grounded candidate IDs.
- A single safe grounded candidate should execute without a model call.
- Known profile values are deterministic and are never guessed by AI.
- A reversible policy conflict outranks checkout navigation.
- Payment, purchase, legal, and irreversible boundaries remain hard stops.
- Successful payment-review detection latches terminal completion for the current request.
- Failed strategies are scoped to the exact current decision or logical component.
- Navigation remains pending while the destination is only a shell or is hydrating.

---

## 4. Logical Field Adapter

### Purpose

The browser exposes physical controls, while the profile and planner reason about traveler requirements. The new adapter connects those layers:

```text
observed controls and field evidence
+ canonical traveler profile
→ logical field
→ next unresolved component
→ grounded operation
→ fresh observation
→ canonical verification
```

Primary file:

- [`apps/web/agent/logical-field.js`](./apps/web/agent/logical-field.js)

### Contract

A resolved logical field carries:

- stable `logicalFieldId`;
- traveler `subjectId`;
- canonical `semanticType`;
- one `controls` graph with component roles and grounded operations;
- desired canonical value from the profile;
- current reconstructed canonical value;
- `scalar` or `composite` structure;
- ordered components;
- field instructions and observed options;
- temporary current `controlId`;
- stable component identity based on the logical field and role;
- supported observed operations;
- component status;
- component-level and logical-field validation ownership;
- ambiguity and confidence.

Physical control IDs may change after a rerender. Logical progress rebinds using:

```text
subjectId + semanticType + componentRole
```

In production, profile planning now derives directly from this graph. The old
parallel field-descriptor completion path has been removed. Machine names and
autocomplete contracts are preferred for ownership; otherwise a stable tight
owner key is used. Generated DOM owner IDs, placeholders, entered values,
validation text, and dropdown open state do not define logical identity.

### Authoritative semantic evidence

Profile-field meaning is now resolved before logical grouping, using this precedence:

```text
raw name, id, and autocomplete
→ explicit associated label and ARIA
→ proven tight local owner
→ broad section context as non-authoritative support
```

Evidence channels remain separate. A broad passenger group cannot overwrite direct machine evidence. Current regressions prove:

```text
passengers.0.nationality → nationality
passengers.0.title       → title
passengers.0.idNumber    → document number
passengers.0.birthDay    → DOB day
```

Composite grouping requires the same traveler, semantic type, tight owner, and compatible component roles. A passenger `sectionId` alone is never a composite-field owner. Phone country code and local number may share a proven contact/phone owner.

### Supported traveler semantics

The current alias and profile resolution layer supports:

- title and gender;
- first, middle, last, and full name;
- email and confirmation email;
- phone country code and local number;
- date of birth;
- nationality;
- passport or document number;
- document issuing country;
- passport or document expiry date.

The schema is intentionally small and extensible. It is not a worldwide airline-field ontology.

### Scalar and composite behavior

The adapter supports:

- a single native date input;
- split day/month/year controls;
- three date dropdowns;
- phone country code plus local number;
- segmented passport expiry;
- ordinary text, select, choice, and custom-control operations already exposed by the observer.

For a composite DOB:

```text
day = 31
→ day component resolved
→ month remains current
→ year remains unresolved
→ whole DOB remains incomplete
```

A whole-group “complete the date” validation message does not cause an already-correct child component to be repeated. Exact component validation still blocks that component.

### Integration

The adapter is integrated into the existing architecture rather than introducing another planner:

- [`apps/web/agent/skill-expander.js`](./apps/web/agent/skill-expander.js) consumes the logical-field graph directly, derives component-aware profile goals, and builds grounded strategies.
- [`apps/web/agent/transition-evaluator.js`](./apps/web/agent/transition-evaluator.js) uses the shared logical-field verifier and reports component success separately from complete-field success.
- [`apps/web/agent/loop.js`](./apps/web/agent/loop.js) keeps ambiguity inside the grounded candidate lifecycle and hands off only after bounded safe strategies are exhausted.
- [`apps/extension/src/content/content.js`](./apps/extension/src/content/content.js) preserves direct field evidence, stable owner keys, instructions, validation ownership, disabled semantic state elements, and structurally related visible actuators.
- [`packages/shared/agent-actions/index.js`](./packages/shared/agent-actions/index.js) scopes retry and failed-strategy memory to the stable logical field plus exact component.
- [`package.json`](./package.json) includes the adapter in static syntax checks.

The existing planner, action lifecycle, date codec, executor, governor, and TaskState remain in place.

### Current contract defects

The intended Logical Field design is sound, but the current end-to-end implementation violates its own contract in two places.

#### 1. Date metadata is lost at the server boundary

The extension preserves:

```js
dateField: control.dateField || null
```

The server's `compactLogicalControl` preserves `name`, `autocomplete`, `placeholder`, operations, recovery, and actuators, but currently omits `dateField` and `options`.

The result is:

```text
browser: birthDay is a known day component with a type actuator
backend: dateField is missing
planner: date order is ambiguous
candidate set: empty
```

This is a serializer/schema drift problem. It should be fixed at the shared contract boundary, not by adding more label regexes.

#### 2. Component-aware planning reruns scalar-date inference

`logical-field.js` already resolves split DOB roles and desired component values. `skill-expander.js` nevertheless calls `encodeDateForField` on the full canonical date for every component.

Correct behavior:

```text
componentRole=day   → inputValue=31
componentRole=month → inputValue=05 or the matching observed option
componentRole=year  → inputValue=2003
componentRole=value → infer and encode one full-date representation
```

Current failure behavior attempts to treat an individual Day or Year input as if it might require `31/05/2003`, `05/31/2003`, or `2003-05-31`. Those full-date hypotheses are valid only for an ambiguous scalar full-date input.

#### 3. Unproven visual recovery is promoted to proven execution

For a disabled semantic select, the observer can publish a bounded nearby region as visual recovery. That is useful evidence, but geometry alone does not prove that the region owns an executable click handler.

The current code allows:

```text
recovery.status = unproven
→ bounded region matches
→ candidate considered grounded and executable
→ affordance.proven = true
```

That status transition is invalid. Bounded and observation-owned means safe to reason about; it does not mean mechanically proven.

### Bounded strategy behavior

For each unresolved component:

1. Choose one observed, grounded strategy.
2. Execute one action.
3. Reobserve.
4. Rebind after rerender.
5. Decode and compare the current canonical component value.
6. Continue to the next component only after verification.

The system does not repeat an already-correct component merely because the overall logical field remains incomplete. Distinct strategy attempts are bounded to three.

For an ambiguous scalar date representation, the planner publishes at most three grounded format hypotheses bound to the exact observed control. They require semantic judgment, execute one at a time, and verify the canonical date from a fresh observation. Failed strategies are not repeated. If no bounded strategy verifies, the agent asks the user.

This bounded scalar-date behavior must never be applied to a split component whose role is already known.

---

## 5. Browser Observation and Airline/OTA Coverage

The extension content script now runs on a curated airline/OTA allowlist rather than every website.

Current coverage includes:

- GoToGate;
- Kiwi;
- Skyscanner;
- Expedia, Kayak, Momondo, Priceline, Trip.com, Opodo, eDreams, Lastminute, Mytrip, Flightnetwork, Booking.com, Agoda, and other OTA families;
- major North American, European, Middle Eastern, Asian, Australian, and New Zealand airline domains.

Primary configuration:

- [`apps/extension/manifest.json`](./apps/extension/manifest.json)

The content-script allowlist contains 63 match patterns, including the local demo checkout. It does not inject the sidebar into unrestricted sites such as social media.

The manifest still contains broad `<all_urls>` host permission inherited from the existing extension. Sidebar injection itself is restricted by `content_scripts.matches`. Permission minimization remains separate cleanup work.

---

## 6. Destination Readiness Baseline

Commit `1b3d3d0` is the known committed baseline for destination readiness.

After an advancing action:

```text
action dispatched
→ navigation or surface transition observed
→ destination lifecycle remains open
→ incomplete shell is classified as not ready
→ client reobserves on cadence and relevant DOM mutation
→ semantic destination controls appear
→ transition completes
```

Readiness uses a shared wall-clock deadline. Observation attempts are telemetry and rate limiting; a fixed count of unchanged observations does not terminate waiting.

This prevents:

- a second Start click after slow navigation;
- indefinite “Observing” when the page later hydrates;
- planning from a partial header-only shell;
- premature user handoff after three quick observations.

Do not replace this with a larger fixed sleep or a site-specific delay.

---

## 7. Current Test Coverage

### Logical Field unit tests

Primary file:

- [`tests/agent/logical-field.test.js`](./tests/agent/logical-field.test.js)

Important regressions:

- `dob_partial_group_validation_does_not_retry_completed_component`;
- `dob_rerender_rebinds_component_without_losing_progress`;
- `dob_complete_value_verifies_canonically`;
- native date input resolves as one scalar logical requirement;
- three-dropdown date selects only the next unresolved component;
- ambiguous full date publishes only three grounded bounded strategies;
- raw machine semantics outrank broad passenger-group text;
- DOB owns only its day, month, and year components;
- component success survives unresolved whole-group validation;
- phone and passport expiry reuse the same adapter contract;
- logical and component identity survive DOM recreation, value/placeholder changes, validation changes, and generated owner-ID changes;
- the graph publishes controls, instructions, options, current/desired canonical values, and hierarchical validation;
- transition verification reports component progress without inventing whole-field completion;
- retry memory is scoped to the exact stable logical component.

### Production-shaped browser replay

Primary file:

- [`tests/agent/semantic-control-replay.spec.js`](./tests/agent/semantic-control-replay.spec.js)

The Kiwi-shaped replay includes:

- a broad passenger container;
- DOB, title, nationality, and passport siblings;
- a disabled native month state control;
- a separate anonymous visible month wrapper;
- rerender after the month interaction;
- year completion;
- canonical reconstruction to `2003-05-31`.

The broad passenger container deliberately contains competing DOB, nationality, title, and passport context. The replay asserts that nationality, title, and document number are not grouped into DOB.

The test exercises the real observer, profile goal derivation, grounded candidate construction, existing browser action execution, fresh observation, portal option selection, rerender rebinding, and canonical logical verification. It no longer manually clicks the month option or fills the year through Playwright shortcuts.

Important limitation discovered by the live trace:

- the browser replay calls the extension's `compactPageMap`, but it does not pass that result through the backend's `compactLogicalControl`, so it cannot detect server-side loss of `dateField` or `options`;
- the Title recovery fixture uses a document-level click listener that opens whenever the click target is inside the test wrapper, which is more permissive than the live Kiwi component;
- therefore the replay proves the fixture contract, not the real custom-widget actuator.

Add an end-to-end request-compaction test and make the widget fixture require the exact activation mechanism expected in production.

### Commands

```bash
npm run check
npm run test:agent:unit
npm run test:agent:browser
npm run test:agent
```

The live demo suite remains:

```bash
npm run test:agent:live
```

---

## 8. Current Working-Tree Scope

Modified files:

```text
CURRENT_CODEBASE_ENGINEERING_HANDOFF.md
apps/extension/manifest.json
apps/extension/src/content/content.js
apps/web/agent/action-governor.js
apps/web/agent/action-semantics.js
apps/web/agent/current-candidate-builder.js
apps/web/agent/loop.js
apps/web/agent/session-store.js
apps/web/agent/skill-expander.js
apps/web/agent/task-state-reducer.js
apps/web/agent/transition-evaluator.js
apps/web/server.js
package.json
packages/shared/agent-actions/index.js
packages/shared/agent-state/index.js
tests/agent/semantic-control-replay.spec.js
tests/agent/transaction-governor.test.js
tests/agent/transition-evaluator.test.js
```

New files:

```text
apps/web/agent/logical-field.js
tests/agent/logical-field.test.js
```

These changes are local and uncommitted. The latest committed code remains `1b3d3d0`.

The prior post-baseline work is recoverable from:

```text
stash@{0}: backup before reverting to 1b3d3d0 on 2026-07-25
```

Do not apply that stash blindly. It contains the broader work that was intentionally set aside before returning to the destination-readiness baseline.

---

## 9. What Is Proven

The current automated evidence proves:

- existing GoToGate clean checkout behavior remains green;
- known preselected paid extras are repaired before navigation in dirty regressions;
- payment and purchase safeguards remain active;
- destination hydration is handled by the committed lifecycle;
- scalar and composite logical traveler fields use one adapter;
- profile planning consumes that graph directly; the parallel legacy completion path is no longer active;
- direct machine semantics outrank broad passenger-section text;
- composite fields are not grouped by passenger section alone;
- logical and component IDs survive DOM recreation and mutable presentation changes;
- DOB partial progress survives rerenders and retry history is reset for the next component;
- completed DOB components are not repeated because of group validation;
- complete DOB is verified canonically;
- transition evidence distinguishes local component success from complete logical-field success;
- phone and passport expiry reuse the same logical-field abstraction;
- the sanitized Kiwi fixture can execute its modeled open, choose, type, reobserve, and split-DOB verification path without site-specific code;
- the live scheduler continues from a failed Title strategy to another unresolved requirement instead of stopping immediately;
- plain name inputs still fill and verify successfully on the current live Kiwi page;
- broader airline/OTA sidebar injection does not use unrestricted content-script matching.

The automated Kiwi fixture does not prove the backend control-compaction boundary or the live Kiwi custom-widget actuator.

---

## 10. What Is Not Yet Proven

Do not claim the following as complete:

- a real live Kiwi checkout reaching payment with no manual correction;
- correct split-DOB planning after the server compacts the browser observation;
- Kiwi title/gender custom-widget completion in live production;
- that a bounded visible wrapper is an executable actuator merely because it geometrically owns a disabled semantic select;
- nationality, document, and address behavior across several live engines;
- repeated 5/5 live GoToGate acceptance on the current uncommitted tree;
- three structurally different airline/OTA engines reaching payment consecutively;
- performance targets for very large observed pages;
- production authentication, tenant isolation, or credential-vault security;
- autonomous payment or purchase submission.

The Logical Field Adapter currently depends on the browser observer exposing a real grounded operation and the backend preserving that operation's semantic metadata. If a site has a hidden or disabled semantic state element whose visible actuator cannot be mechanically proven, the correct result is to continue other actionable requirements and eventually produce a precise bounded handoff—not to relabel an arbitrary nearby region as proven.

---

## 11. Recommended Next Work

Work in this order and change only the component demonstrated to be responsible by a trace or replay.

### 1. Repair the control round-trip

Preserve at least:

```text
dateField.component
dateField.format
dateField.options
control.options
canonical operations
operation actionability
recovery status
```

Prefer one shared schema/serializer used by both the extension and backend. At minimum, update `compactLogicalControl` and add a regression that sends a split date control through the real backend compaction boundary.

### 2. Make split components deterministic

When `logical-field.js` has already published `componentRole=day|month|year`, use `component.desiredValue` directly. Do not call scalar full-date inference again.

The first expected decisions for the latest stored observation are:

```text
type DOB Day = 31
type DOB Year = 2003
```

Ordering between those two is not important. Executing both before terminal handoff is important.

### 3. Correct custom-widget actionability

Maintain a strict distinction:

```text
proven executable operation
≠
observation-owned unproven recovery region
```

Use an observed activation member only when its operation-level actionability is executable. If an unproven recovery is attempted as a bounded experiment, do not mark it proven, do not repeat it on the unchanged page, and do not let its failure block other executable fields.

Determine separately whether production needs:

- a different observed activation node;
- a browser-level trusted click mechanism;
- or a more faithful custom-widget operation contract.

Do not answer that question with a Kiwi selector or a permanent coordinate.

### 4. Re-run live Kiwi traveler-information acceptance

Verify:

- title/gender;
- DOB day, month, and year;
- nationality;
- any requested document fields;
- no repeated completed component;
- no site-specific selector or wording rule;
- no unsafe fallback.

Convert each reproduced failure into a sanitized production-shaped replay before changing architecture.

### 5. Re-run clean and dirty GoToGate acceptance

Confirm:

- clean checkout reaches payment unchanged;
- manually selected paid bundle, ticket, seat, baggage, or add-on is removed before navigation;
- no paid extra is added;
- no card field is filled;
- no purchase action occurs;
- terminal payment completion remains latched.

### 6. Test one airline and one structurally different OTA

Use failures to expand shared observation or logical-field evidence only when the production trace proves a generic gap.

### 7. Measure and reduce large-page latency

Profile the 320-control stress replay. Preserve:

- bounded model packets;
- deterministic single-candidate fast paths;
- screenshot skipping when DOM evidence is sufficient;
- fresh verification and safety checks.

---

## 12. Engineering Rules

Keep:

- fresh browser truth;
- one control contract preserved end to end;
- one authoritative TaskState;
- canonical observations;
- grounded control and candidate IDs;
- deterministic profile values;
- the existing action lifecycle and executor;
- the governor;
- transaction ledger;
- destination readiness;
- post-action reobservation and semantic verification;
- payment, legal, purchase, and irreversible boundaries.

Do not add:

- airline-specific workflows;
- site-specific selectors or button wording;
- fixed coordinate procedures;
- a second control serializer with a different field whitelist;
- another planner, TaskState, or lifecycle controller;
- AI-generated selectors, JavaScript, controls, or profile data;
- completion based only on a click or DOM event;
- a retry of an already-correct logical component;
- a blanket wait increase to hide hydration races.

Core principle:

> Observe the current page, understand the logical traveler requirement, execute one grounded operation, and verify the complete canonical result from a fresh observation.

For split components, “understand once” is important: after the logical layer has resolved `day`, `month`, or `year`, no later layer should reinterpret that component as an ambiguous full-date field.

---

## 13. Local Development

Start the app:

```bash
npm run dev
```

Load the extension from:

```text
apps/extension
```

After changing `manifest.json` or the content script:

1. Reload the extension from `chrome://extensions`.
2. Reload the checkout tab.
3. Confirm the backend is running.
4. Start a new agent session.

For a failed run, preserve:

- the agent ledger;
- client logs;
- before/after observations;
- action ID and candidate ID;
- current TaskState;
- validation and price facts;
- screenshot only when DOM evidence is insufficient.

---

## 14. One-Paragraph Handoff

Fly is on `dev` at committed baseline `1b3d3d0`, with a large uncommitted Logical Field Adapter, scheduler, recovery, actionability, and airline/OTA coverage change set. The existing safety, paid-extra, destination-readiness, and payment boundaries remain in scope and must not be weakened. The latest live Kiwi trace proves that the scheduler now continues past a failed field and that plain name inputs still fill, but it exposes two shared-contract defects: the extension observes split-DOB metadata that `compactLogicalControl` drops before planning, causing actionable Day and Year inputs to be misclassified as ambiguous full-date fields; and an `unproven` disabled-select recovery region is later represented as a `proven` executable actuator even though its synthetic click exposes no options. Earlier unit and browser suites passed because they bypass the server compaction loss and use a permissive custom-widget fixture, so those passes are not live acceptance. The immediate work is to preserve one control contract end to end, use deterministic component values for split dates, keep unproven recovery distinct from proven execution, and add a real request-round-trip regression. Do not rewrite the scheduler or add Kiwi selectors, field sequences, controllers, or coordinate procedures. Completion requires the latest Kiwi observation to type Day `31` and Year `2003`, continue around blocked widgets, advance past traveler information, preserve GoToGate behavior, and leave payment/purchase safeguards unchanged.
