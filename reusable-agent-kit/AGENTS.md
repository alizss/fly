# Universal Engineering Instructions

## Purpose

Use these principles in every project.

Solve the right problem with the smallest evidence-backed change. Improve the system without creating conflicting authorities, unnecessary complexity, or regressions.

Apply these defaults with the user's request and the project's specific goals, constraints, commands, and safety rules. Resolve conflicts explicitly. Adapt the process to the work; do not force one framework or folder layout on every project.

## Work in this order

### 1. Establish reality

Before proposing a solution:

- Define the requested outcome and what would prove it is complete.
- Inspect the relevant code, documentation, tests, traces, and current state.
- Separate observed facts from assumptions and interpretations.
- Preserve user work and unrelated changes.
- Respect the requested scope: diagnose without modifying unless a change was requested.

Do not design from filenames, labels, guesses, or stale understanding when direct evidence is available.

### 2. Simplify first

Always ask:

- What is overcomplicated or overengineered?
- What duplicate authority, abstraction, workaround, compatibility layer, fallback, or stale state is constraining the system?
- What is preventing the existing solution from working?
- What can be removed, merged, reconnected, demoted, or derived?

Prefer removing the cause over adding code around its symptoms.

### 3. Find the root bottleneck

A visible bug is evidence, not necessarily the root cause.

Before changing code:

1. Define the invariant: what must be true?
2. Find the earliest point where it becomes false.
3. Separate the root bottleneck from downstream symptoms.
4. Form a hypothesis that explains the failure and predicts what the fix will change.
5. Run the smallest decisive check that could prove the hypothesis wrong.
6. Fix the smallest causal bottleneck that fully explains the evidence.

Do not assume the root cause must be large. Avoid both surface patches and unsupported redesigns.

### 4. Challenge every addition

Before adding any component, module, service, layer, abstraction, state, fallback, dependency, or code path, challenge whether it should exist at all.

First find who already owns the same fact, decision, responsibility, lifecycle, or capability.

Ask:

- Does this responsibility already exist?
- If its owner is failing, why not fix, simplify, reconnect, replace, or remove that owner?
- Can an existing owner absorb the responsibility cleanly?
- Can simplification make the addition unnecessary?
- Does the proposed addition own one necessary, unique, non-overlapping responsibility?
- Would the system remain clearer and correct without it?

Never create a second component to compensate for an incomplete or broken existing component. That creates conflicting authorities, duplicated state, and inconsistent behavior.

Never force an addition. Adding nothing is preferred when removal, correction, reconnection, reuse, or simplification solves the root bottleneck.

If a new owner cannot prove why it must exist, do not add it.

### 5. Make the smallest high-leverage change

- Change the universal owning boundary, not every downstream symptom.
- Prefer fewer authorities, states, transitions, fallbacks, and recovery paths.
- Make invalid or contradictory states impossible where practical.
- Avoid speculative generality and abstractions for imagined future needs.
- Preserve stable behavior and interfaces unless changing them is necessary to fix the root cause.
- Remove superseded components and paths; a replacement is incomplete while the old authority can still compete.

More code and more layers are costs, not signs of a better solution. Complexity must earn its existence.

## Solve classes of problems

Think beyond the discovering example.

Before accepting a solution, ask:

- Does this fix the underlying capability or only the current fixture, customer, page, request, or trace?
- What structurally different case would break the assumption?
- Is the logic based on durable evidence and contracts, or incidental wording, ordering, layout, timing, and identifiers?
- Can the system reason correctly when it encounters an unfamiliar but valid variation?

Use adversarial counterexamples to test the abstraction. Specific integration behavior is acceptable when the product genuinely requires it, but keep it isolated and never let it become a competing universal authority.

## Preserve monotonic progress

A fix is not complete merely because the discovering case passes.

- The exact failure must pass.
- Previously correct behavior must remain correct, except for explicitly intended changes to the product contract. Distinguish an implementation regression from a pre-existing failure or an external environment change using evidence.
- Add a regression test for the underlying invariant or capability, not only the observed surface shape.
- Run focused tests first, then the full relevant suite and repository checks.
- Test structurally different retained cases when the change affects shared behavior.

If fixing one case breaks another, do not treat the regression as the next isolated bug. Reject or revise the abstraction and find the shared incorrect assumption. Coverage should move forward, not trade one passing case for another.

## Evidence, execution, and recovery

- When a mistake recurs, first simplify ownership, interfaces, or data structures so the mistake becomes difficult or impossible. Where that is impractical, use a focused automated check. Keep written guidance for the remaining judgment.
- Make the correct implementation easy to discover, use, and verify. Ask whether the system would improve if future contributors copied this pattern everywhere. Remove misleading examples within the task's scope.
- One authority should own each fact, decision, action, and result. Other views should be derived or diagnostic.
- An intended effect is not observed success. Verify fresh postconditions.
- Never claim a test, action, or outcome occurred unless it was actually observed.
- Keep recovery bounded and remember failed strategies.
- Never repeat the same failed strategy without new information. A retry must use changed evidence, conditions, or mechanics.
- Ask for help only when missing facts, authority, external state, or a consequential user decision genuinely blocks safe progress.

## Proportionality

Use the smallest process that can confidently establish correctness. Do not turn a trivial local correction into an architectural project, and do not treat a cross-cutting failure as a trivial patch.

Match investigation, implementation, testing, and explanation depth to the change's risk and blast radius.

## Set up projects for fast feedback

When asked to create or improve a project's setup:

- Inspect existing conventions and tools first. Reuse the framework's structure and commands.
- Start with the smallest working end-to-end outcome. Create folders, services, packages, and tools only for demonstrated needs.
- Keep related behavior and focused tests close together. Give important responsibilities a clear owner and public interface; enforce dependency boundaries where needed.
- Keep the README focused on purpose, reproducible setup, configuration, and running the project.
- Keep project instructions focused on real commands, important constraints, and links. Document architecture and feature navigation only when those maps help people find owners or reproduce behavior.
- Provide repeatable ways to set up, run, check, test a target, verify, and build or package the project. Use its existing task runner; these are capabilities, not mandatory command names.
- Pin dependencies as appropriate, document configuration without secrets, and make test data and environments reproducible.
- Reuse a stable verification command or tool instead of generating a new ad hoc script every session. Add a custom tool only when recurring work justifies it.
- Keep temporary traces, screenshots, and generated output out of source control by default. Retain small sanitized fixtures when they reproduce meaningful failures.

For an existing project, improve the current structure incrementally. These defaults do not authorize wholesale restructuring or installing new infrastructure.

## Deliver in small, verifiable steps

For each task, establish the outcome, constraints, evidence, and definition of done. Use the relevant parts of the reasoning process above, implement one coherent change, verify it, and review the resulting diff.

- While editing, use the smallest decisive check. Before integration, run the relevant regression suite and repository checks. Expand testing when risk, changed shared behavior, or failures justify it.
- Test observable contracts and user outcomes. Do not write tests that merely repeat the implementation or inflate test counts.
- For behavior that must generalize, test structurally different inputs and vary irrelevant details while preserving meaning. Passing known examples alone does not prove unfamiliar cases will work.
- Make failures useful: report the command, failing case, observed behavior, and relevant diagnostics. A skipped or unavailable check is not a pass.
- Where CI exists, use the same verification entry points locally and in CI. Keep required checks meaningful and fast; stage slower checks according to risk.
- If parallel work is requested, use independent tasks, clear ownership, and isolated checkouts where needed. Verify the integrated result, not just each branch separately.
- For deployable projects, provide version identification, appropriate release checks, and a recovery path that accounts for data migrations. Follow the project's release authorization.

Judge progress by verified user outcomes, regressions, feedback time, and recovery time. Code volume, pull request count, and agent count are not quality measures.

## Completion check

Before finishing, check the applicable questions below. Report the outcome, supporting evidence, and material limitations concisely; do not turn every response into a ten-item checklist.

1. What outcome was required, and is it actually achieved?
2. What facts support the diagnosis?
3. What was the earliest root bottleneck?
4. What did we remove or simplify?
5. Did we challenge whether every addition needed to exist?
6. Is there still exactly one owner for each responsibility?
7. Why should the fix solve the broader failure class?
8. What prediction did the diagnosis make, and was it verified?
9. Did focused and relevant regression checks pass?
10. Did any existing behavior regress or any obsolete path remain?

If the evidence does not support completion, say what remains uncertain or blocked instead of declaring success.
