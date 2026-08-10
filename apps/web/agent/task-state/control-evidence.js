function controlHasExecutableCapability(control = {}) {
  const disabledState = control.disabled === true || control.state?.disabled === true;
  return Object.values(control.operations || {}).some((capability) => {
    const actuatorId = capability?.actuatorId || "";
    const disabledActuator = disabledState
      && (!actuatorId || actuatorId === control.stateElementId);
    return !disabledActuator && (
      capability?.actionability?.executable === true
      || capability?.actionability?.revealable === true
    );
  });
}

module.exports = { controlHasExecutableCapability };

