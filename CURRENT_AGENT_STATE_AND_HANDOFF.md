# Fly Agent Current Code Map

Last updated: 2026-07-11

This document describes how the current Fly / Air Travel Wallet agent code works today. It is intended as neutral context for Codex, Claude Code, or another engineer.

## Product Context

Fly is being built to reduce flight booking friction. The current working surface is a browser extension that assists on live airline / OTA checkout pages.

The current agent uses:

- a Chrome extension content script for page observation and DOM execution
- a local Node backend for traveler profile data, agent sessions, OpenAI calls, traces, and logs
- shared packages for action normalization, page-state normalization, requirements, policy, and session state

## Important Files

### Extension

- `apps/extension/src/content/content.js`
- `apps/extension/src/content/sidebar.css`

### Backend

- `apps/web/server.js`
- `apps/web/agent/loop.js`
- `apps/web/agent/page-state-classifier.js`
- `apps/web/agent/verify-and-plan.js`
- `apps/web/agent/policy.js`
- `apps/web/agent/schemas.js`
- `apps/web/agent/session-store.js`
- `apps/web/agent/trace-store.js`

### Shared Packages

- `packages/shared/agent-actions/index.js`
- `packages/shared/agent-state/index.js`
- `packages/shared/page-state/index.js`
- `packages/shared/policy/index.js`
- `packages/shared/requirements/index.js`

### Docs / Logs

- `AGENT_FLOW_LOGGING.md`
- `work/agent-client-logs/<sessionId>.jsonl`
- `work/agent-traces/<sessionId>/`

## Current Runtime Overview

At runtime, the extension observes the current checkout page, sends a compact page map plus screenshot to the backend, receives one action, executes it on the page, then loops.

High-level loop:

1. Extension injects sidebar.
2. User clicks `Start agent`.
3. Extension starts or resumes an agent session.
4. Extension builds a page map from the live DOM.
5. Extension captures a screenshot.
6. Extension sends page map + screenshot + user/traveler context to backend.
7. Backend classifies page state.
8. Backend verifies previous action and plans the next action.
9. Backend policy-checks the action.
10. Backend returns one client action.
11. Extension resolves the target on the live page.
12. Extension executes the action.
13. Extension logs/report results.
14. Loop repeats.

## Extension State

Main state object is in:

- `apps/extension/src/content/content.js`

Current `agent` state includes:

```js
{
  running,
  sessionId,
  apiBase,
  awaiting,
  messages,
  lastClickSignature,
  repeatClickCount,
  skipPaidExtrasApproved,
  skipRoutineRunning,
  autopilotMode,
  pendingUserMessage,
  currentAction,
  currentReason,
  currentStage,
  userGoal,
  reasoningLog,
  actionHistory,
  sectionProgress,
  completedSections,
  completedFields,
  sectionPlan,
  taskQueue,
  debugLog,
  flowLog,
  flowSeq,
  activeTurnId,
  lastBackendDebug,
  pageMap,
  pageUnderstanding,
  observerTab
}
```

Important fields:

- `agent.running`: whether agent loop is active
- `agent.sessionId`: backend session id
- `agent.userGoal`: user instruction from sidebar
- `agent.actionHistory`: recent executed actions/results
- `agent.flowLog`: extension-side event log
- `agent.activeTurnId`: current backend request turn id
- `agent.pageMap`: last observed page map

## Starting The Agent

Primary file:

- `apps/extension/src/content/content.js`

Important functions:

- `renderSidebar()`
- `handleChatSubmit()`
- `startAgentSession()`
- `processCheckoutAgent()`

Current flow:

1. Sidebar is rendered by `renderSidebar()`.
2. User clicks `Start agent`.
3. The extension stores the typed instruction in `agent.userGoal`.
4. The extension sets `agent.running = true`.
5. The extension builds a page map using `buildPageMap()`.
6. The extension calls `startAgentSession()`.
7. `startAgentSession()` sends:

```text
POST /api/agent/session
```

8. Backend returns a session id.
9. Extension stores it in `agent.sessionId`.
10. Extension calls:

```js
processCheckoutAgent()
```

## Main Extension Loop

Primary function:

- `processCheckoutAgent()`

Current simplified shape:

```js
async function processCheckoutAgent() {
  if (!agent.running) return;

  warnings = runRiskChecks();
  const map = rememberPagePlan(buildPageMap());
  agent.pageMap = map;

  const interrupt = await settleAndHandleInterrupts("agent loop");
  if (interrupt.handled) {
    await continueAfterAction(500);
    return;
  }
  if (interrupt.blocked) {
    agent.running = false;
    agent.awaiting = "manual";
    renderSidebar("agent");
    return;
  }

  let stableMap = rememberPagePlan(buildPageMap());
  agent.pageMap = stableMap;

  if (shouldAutoDeclinePaidExtras() && await skipNoExtraDropdownChoice(stableMap)) {
    await continueAfterAction(450);
    return;
  }

  if (canUseContinueGate(stableMap)) {
    await clickContinueGate(stableMap);
    return;
  }

  const userMessage = agent.pendingUserMessage;
  agent.pendingUserMessage = "";
  const decision = await requestAgentDecision(stableMap, userMessage);
  await executeAgentDecision(decision, stableMap);
}
```

Current behavior note:

- Some extension-side helper functions can act before `requestAgentDecision()`.
- When that happens, terminal `client flow` logs may have `clientTurnId: ""`.
- Backend-planned actions usually have a non-empty turn id generated by `requestAgentDecision()`.

## Extension Page Observation

Primary function:

- `buildPageMap()`

Related functions:

- `candidateInputs()`
- `candidateButtons()`
- `activeOverlayElements()`
- `buildActiveSurface()`
- `rememberPagePlan()`
- `compactPageMap()`
- `pageSignature()`

`buildPageMap()` scans the live page and returns a structured map.

Important page map fields:

```js
{
  site,
  step,
  fields,
  buttons,
  sections,
  taskQueue,
  activeSurface,
  overlays,
  stageExit,
  errors,
  paidChoices,
  completedFields,
  completedSections,
  coverage,
  summary
}
```

### `fields`

Each field generally includes:

```js
{
  id,
  label,
  box,
  kind,
  field,
  required,
  value,
  confidence
}
```

### `buttons`

Each button generally includes:

```js
{
  id,
  label,
  box,
  risk
}
```

### `sections`

Sections are inferred visual/task groupings on the page.

Each section can include:

```js
{
  id,
  label,
  type,
  status,
  objective,
  fields,
  buttons,
  choices,
  selected
}
```

### `activeSurface`

Active surface describes a currently open modal, dropdown, popover, or page-level surface.

Shape:

```js
{
  type,
  id,
  label,
  role,
  taskHint,
  options,
  buttons,
  box
}
```

### `taskQueue`

`taskQueue` is an inferred list of unfinished page sections/tasks.

Shape:

```js
{
  sectionId,
  sectionLabel,
  sectionType,
  status,
  objective,
  rule
}
```

## Extension Screenshot Capture

Primary function:

- `captureVisibleScreenshot()`

It calls the extension runtime:

```js
chrome.runtime.sendMessage({ type: "ATW_CAPTURE_VISIBLE_TAB" })
```

Returned screenshot is sent to backend as:

```js
page.screenshotDataUrl
```

## Backend Request From Extension

Primary function:

- `requestAgentDecision(map, userMessage)`

Current behavior:

1. Creates a turn id:

```js
const turnId = nextFlowId("turn");
agent.activeTurnId = turnId;
```

2. Logs:

```text
backend.request.prepare
backend.request.send
```

3. Captures screenshot.
4. Sends:

```text
POST /api/agent/next-action
```

Payload shape:

```js
{
  sessionId: agent.sessionId,
  clientTurnId: turnId,
  userIntent: userIntentText(),
  userMessage,
  traveler: traveler(),
  approvalState: {
    skipPaidExtrasApproved: shouldAutoDeclinePaidExtras(),
    paymentApproved: false
  },
  actionHistory: agent.actionHistory.slice(-12),
  lastActionResult: agent.actionHistory[agent.actionHistory.length - 1] || null,
  page: {
    ...compactPageMap(map),
    screenshotDataUrl
  }
}
```

## Backend Server

Primary file:

- `apps/web/server.js`

Server starts with:

```bash
node apps/web/server.js
```

Default URL:

```text
http://localhost:4173
```

API base used by extension:

```text
http://localhost:4173/api
```

## Backend API Endpoints

### Bootstrap

```text
GET /api/extension/bootstrap
```

Used by extension to load traveler/profile data.

### Agent Session

```text
POST /api/agent/session
```

Creates an agent session and returns summarized session data.

### Next Action

```text
POST /api/agent/next-action
```

Main backend planner endpoint.

Server function path:

```js
handleApi()
decideAgentNextActionViaLoop()
agentLoop.runLoopTurn()
```

### Agent Report

```text
POST /api/agent/report
```

Used by extension to report action result/session events.

### Agent Session Read

```text
GET /api/agent/session/<sessionId>
```

Reads stored agent session state.

### Agent Traces

```text
GET /api/agent/traces/<sessionId>
```

Lists backend trace files.

### Client Logs

```text
POST /api/agent/client-log
```

Receives extension flow logs and writes:

```text
work/agent-client-logs/<sessionId>.jsonl
```

Also prints compact terminal logs:

```text
[agent xx:xx:xx.xxx] client flow {...}
```

## Backend Agent Session State

Session state is handled by:

- `apps/web/agent/session-store.js`
- `packages/shared/agent-state/index.js`

In `apps/web/server.js`, `decideAgentNextActionViaLoop()` calls:

```js
agentSessionStore.getOrCreateSession(...)
agentLoop.runLoopTurn(...)
agentSessionStore.saveSession(nextState)
```

The older in-memory `agentSessions` map is also still present in `server.js` for `/api/agent/session` and `/api/agent/report` style summary/reporting.

## Backend Brain Loop

Primary file:

- `apps/web/agent/loop.js`

Main function:

- `runLoopTurn()`

Current loop:

1. Receive observation from extension.
2. Extract screenshot from `observation.page.screenshotDataUrl`.
3. Classify typed page state:

```js
classifyPageState(...)
```

4. Derive requirements from typed page state:

```js
requirementsFromPageState(pageState)
```

5. Verify previous action and plan next action:

```js
verifyAndPlan(...)
```

6. Merge verifier-satisfied requirements.
7. Update session state.
8. Track price history if price changed.
9. Calculate missing actionable requirements.
10. Detect repeated no-progress attempts.
11. Optionally choose deterministic navigation action.
12. Run policy check:

```js
checkPolicy(...)
```

13. Convert final action to extension decision:

```js
toClientDecision(finalAction)
```

14. Write trace:

```js
writeTrace(...)
```

15. Return:

```js
{
  state: nextState,
  clientDecision,
  debug
}
```

## Page State Classifier

Primary file:

- `apps/web/agent/page-state-classifier.js`

Main function:

- `classifyPageState()`

Input:

- page map
- screenshot
- traveler
- user intent
- last action result

Output:

```js
{
  pageState,
  pageStep,
  requirements,
  uncertainties,
  summary
}
```

The typed `pageState` shape:

```js
{
  pageStep,
  requiredFields,
  requiredChoices,
  optionalPaidExtras,
  navigationActions,
  riskGates,
  activeSurface,
  uncertainties,
  summary
}
```

Normalization lives in:

- `packages/shared/page-state/index.js`

## Requirements

Requirements are derived from page state by:

- `requirementsFromPageState()`

File:

- `packages/shared/page-state/index.js`

Requirement examples:

- `traveler_field`
- `contact_field`
- `document_field`
- `baggage_decision`
- `seat_decision`
- `paid_extra_decision`
- `legal_acceptance`
- `payment`

Requirements are used for:

- missing requirement count
- verifier merge
- stall detection
- policy decisions
- safe navigation checks

## Verify And Plan

Primary file:

- `apps/web/agent/verify-and-plan.js`

Main function:

- `verifyAndPlan()`

This is one OpenAI structured-output call that returns:

```js
{
  verification,
  action
}
```

Verification shape:

```js
{
  ok,
  changed,
  lastActionWorked,
  blockers,
  priceChanged,
  riskChanged,
  evidence,
  confidence,
  satisfiedRequirementIds
}
```

Action is normalized through:

- `packages/shared/agent-actions/index.js`

## Action Contract

Shared file:

- `packages/shared/agent-actions/index.js`

Supported action types:

```text
click
click_xy
type
select
scroll
keypress
wait
ask_user
final_review
stop
fill_known_fields
fill_visible_profile_fields
skip_optional_extra
close_modal
save_trip
```

Normalized action shape:

```js
{
  id,
  type,
  targetId,
  targetLabel,
  value,
  x,
  y,
  scrollY,
  keys,
  reason,
  requirementId,
  risk,
  requiresApproval
}
```

Backend converts this to the extension-compatible decision shape:

```js
{
  source: "agent-loop",
  action,
  targetId,
  targetLabel,
  value,
  x,
  y,
  scrollY,
  keys,
  message,
  needsApproval,
  risk,
  reason,
  debug
}
```

## Policy

Backend policy files:

- `apps/web/agent/policy.js`
- `packages/shared/policy/index.js`

Policy is applied in:

- `apps/web/agent/loop.js`

Current policy stage receives:

- planned action
- checkout session state
- traveler profile
- approvals

It returns a policy decision. If blocked, backend may return fallback actions like:

- `ask_user`
- `wait`
- `skip_optional_extra`

## Backend Traces

Trace writer:

- `apps/web/agent/trace-store.js`

Trace output:

```text
work/agent-traces/<sessionId>/<turnId>.json
work/agent-traces/<sessionId>/<turnId>.jpg
```

Trace JSON includes:

- observation
- pageState
- requirements
- verification
- plannedAction
- policyDecision
- executionResult
- debug

## Extension Decision Execution

Primary function:

- `executeAgentDecision(decision, map)`

Important helper:

- `resolveDecisionTarget(decision, map)`

Execution flow:

1. Log:

```text
execute.start
```

2. Resolve target:
   - direct `targetId`
   - active surface label
   - visible text
   - coordinates for `click_xy`

3. Log resolution:

```text
target.resolve
```

or:

```text
target.resolve_failed
```

4. Execute action.

For DOM clicks, extension uses:

```js
userLikeClick(element)
```

which dispatches:

- pointerdown
- mousedown
- pointerup
- mouseup
- click

5. Log click:

```text
dom.click.dispatch
```

For coordinate clicks:

```js
clickViewportPoint(x, y)
```

and log:

```text
dom.click_xy.dispatch
```

6. Wait for page reaction.
7. Schedule next loop:

```js
continueAfterAction()
```

8. Log:

```text
loop.schedule_next
```

## Extension Local Helper Actions

The current extension contains local helper functions that can act outside the backend turn.

Relevant functions:

- `settleAndHandleInterrupts()`
- `handleRoutineExtraOverlay()`
- `skipOptionalExtraSurface()`
- `skipNoExtraDropdownChoice()`
- `autoResolveNoExtrasSection()`
- `canUseContinueGate()`
- `clickContinueGate()`

Current behavior:

- These helpers may click or interact before `requestAgentDecision()` is called.
- Logs for those actions can show `clientTurnId: ""`.
- Backend `loop turn start` / `loop turn decision` logs will not appear for actions that happen entirely inside these helpers.

## Client Flow Logging

Extension function:

- `logFlow()`

Extension logs are stored in memory:

```js
agent.flowLog
```

They are also sent to backend:

```text
POST /api/agent/client-log
```

Backend writes full log rows:

```text
work/agent-client-logs/<sessionId>.jsonl
```

Common phases:

- `backend.request.prepare`
- `backend.request.send`
- `backend.response`
- `backend.error`
- `execute.start`
- `target.resolve`
- `target.resolve_failed`
- `dom.click.dispatch`
- `dom.click_xy.dispatch`
- `loop.schedule_next`
- `action.report`

## Reading Current Logs

### Backend-Planned Action

Usually includes:

- non-empty `clientTurnId`
- `backend.request.prepare`
- `backend.request.send`
- backend `loop turn start`
- backend `loop turn decision`
- `backend.response`
- `execute.start`
- `target.resolve`
- `dom.click.dispatch`

### Extension-Local Action

Usually includes:

- `clientTurnId: ""`
- `dom.click.dispatch`
- no backend `loop turn start`
- no backend `loop turn decision`

### Example From Latest Observed Failure

Terminal showed:

```text
client flow {"clientTurnId":"","phase":"dom.click.dispatch","target":"Choose",...}
client flow {"clientTurnId":"","phase":"dom.click.dispatch","target":"All passengers ... None of the passengers ... 0EUR",...}
```

This indicates the click came from extension-local code, not the backend agent turn.

## Recent Current-Code Changes

### Client Flow Logs

Added:

- extension sends `flowLog` entries to backend
- backend endpoint `/api/agent/client-log`
- terminal `client flow` summaries
- JSONL files under `work/agent-client-logs/`

### Dropdown Option Selection

Updated in:

- `apps/extension/src/content/content.js`

Current behavior:

- option matching prefers smaller specific option rows/inputs
- broad mixed containers with paid and no-extra choices are penalized
- no-extra dropdown selection needs selected-state/value verification
- removed the old `safe-no-extra-assumed` behavior

## Current Test Command

Run backend:

```bash
node apps/web/server.js
```

Then:

1. reload extension
2. refresh checkout page
3. click `Start agent`
4. watch terminal logs
5. inspect:

```text
work/agent-client-logs/<sessionId>.jsonl
work/agent-traces/<sessionId>/
```

## File Reading Order For Current Code

Suggested order for understanding current behavior:

1. `apps/extension/src/content/content.js`
2. `apps/web/server.js`
3. `apps/web/agent/loop.js`
4. `apps/web/agent/page-state-classifier.js`
5. `apps/web/agent/verify-and-plan.js`
6. `packages/shared/page-state/index.js`
7. `packages/shared/agent-actions/index.js`
8. `packages/shared/policy/index.js`
9. `AGENT_FLOW_LOGGING.md`

