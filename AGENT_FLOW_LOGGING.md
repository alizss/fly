# Fly Agent Flow And Logs

## Runtime Flow

1. **Extension observes the live page**
   - Builds a page map from DOM, overlays, fields, buttons, boxes, active surface, task queue, and visible text.
   - Captures a screenshot.
   - Writes browser-side `flowLog` entries and streams them to the local backend.

2. **Backend classifies typed page state**
   - `requiredFields`
   - `requiredChoices`
   - `optionalPaidExtras`
   - `navigationActions`
   - `riskGates`
   - `activeSurface`

3. **Backend verifies and plans**
   - Checks whether the last action changed the page.
   - Chooses one next action.
   - Applies policy.
   - Writes trace JSON and screenshot under `work/agent-traces/<sessionId>/`.

4. **Extension resolves and executes**
   - Resolves `targetId` or visible text to a live DOM element.
   - Logs the resolved element, click point, top element at click point, and page snapshot before the click.
   - Dispatches DOM events.
   - Logs page snapshot before the next loop.

5. **Verifier loop repeats**
   - The next backend turn compares the new screenshot/page state to the previous action.

## Where To Look

- **Terminal logs**
  - `node apps/web/server.js`
  - Shows backend decision summary and extension-side client flow events.
  - Client flow lines look like:
    - `client flow {"phase":"target.resolve", ...}`
    - `client flow {"phase":"dom.click.dispatch", ...}`
    - `client flow {"phase":"loop.schedule_next", ...}`
  - Backend decision summaries include:
    - `clientTurnId`
    - `action`
    - `target`
    - `missing`
    - `nav`
    - `riskGates`
    - `deterministic`
    - `reason`

- **Extension client-flow files**
  - `work/agent-client-logs/<sessionId>.jsonl`
  - Full extension-side event stream:
    - backend request/response
    - visible controls snapshot
    - target resolution
    - click dispatch point
    - top element at the click point
    - page snapshot before the next loop

- **Backend trace files**
  - `work/agent-traces/<sessionId>/<turnId>.json`
  - `work/agent-traces/<sessionId>/<turnId>.jpg`
  - The JSON includes:
    - `observation`
    - `pageState`
    - `requirements`
    - `verification`
    - `plannedAction`
    - `policyDecision`
    - `executionResult`
    - `debug`

- **Extension debug copy**
  - Sidebar -> `Profile and logs` -> copy debug.
  - Includes:
    - `debugLog`
    - `flowLog`
    - `actionHistory`
    - `lastBackendDebug`
    - latest page map

## How To Diagnose A Failure

Ask these in order:

1. **Did perception see the control?**
   - Check `flowLog[].payload.page.visibleControls`.
   - Check backend `pageState.navigationActions` / `requiredChoices` / `optionalPaidExtras`.

2. **Did backend choose the right action?**
   - Check terminal `target`, `missing`, `nav`, `riskGates`, `reason`.
   - Check trace `plannedAction`, `policyDecision`, `debug.final`.

3. **Did extension resolve the target?**
   - Check `flow:target.resolve` or `flow:target.resolve_failed`.

4. **Did the click hit the intended element?**
   - Check `flow:dom.click.dispatch`.
   - Look at:
     - `target`
     - `point`
     - `target.topAtCenter`
     - `clickClear`

5. **Did the page change?**
   - Compare `pageBefore.signature` from click dispatch with `loop.schedule_next.pageAfterAction.signature`.
   - Check trace `verification.changed` and `lastActionWorked` on the next backend turn.

## Meaning Of Common Failure Shapes

- **Control is visible in screenshot but absent from visibleControls**
  - Perception/DOM/overlay scanner missed it.

- **Control is in pageState but backend chose wait**
  - Planner/policy mismatch.

- **Backend chose target but `target.resolve_failed`**
  - Stale DOM id or bad visible-text matching.

- **Target resolved but topAtCenter is another element**
  - Click is blocked by overlay/layer/scroll issue.

- **Click dispatch happened but after signature unchanged**
  - Wrong element, disabled control, custom widget needs different event path, or verifier is too strict.
