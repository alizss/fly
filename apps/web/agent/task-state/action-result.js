function actionPostconditions(result = null) {
  const action = result?.action || {};
  const task = action.affordance?.task || {};
  return [
    result?.expectedOutcome,
    action.expectedOutcome,
    action.affordance?.postcondition,
    ...(Array.isArray(result?.expectedPostconditions) ? result.expectedPostconditions : []),
    ...(Array.isArray(action.expectedPostconditions) ? action.expectedPostconditions : []),
    ...(Array.isArray(task.expectedPostconditions) ? task.expectedPostconditions : [])
  ].filter((entry) => entry && typeof entry === "object");
}

module.exports = { actionPostconditions };

