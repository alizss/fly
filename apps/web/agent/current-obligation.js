const CURRENT_OBLIGATION_VERSION = "current-obligation/v3";
const {
  normalizeSemanticOwner,
  semanticOwnerId
} = require("../../../packages/shared/semantic-owner");

function isCurrentObligation(value = null) {
  return Boolean(value && value.contractVersion === CURRENT_OBLIGATION_VERSION);
}

function semanticOwner(obligation = null) {
  if (!isCurrentObligation(obligation)) return null;
  return obligation.semanticOwner ? normalizeSemanticOwner(obligation.semanticOwner) : null;
}

function currentSemanticOwnerId(obligation = null) {
  if (!isCurrentObligation(obligation)) return "";
  return String(obligation.semanticOwnerId || semanticOwnerId(semanticOwner(obligation)));
}

module.exports = {
  CURRENT_OBLIGATION_VERSION,
  isCurrentObligation,
  semanticOwner,
  semanticOwnerId: currentSemanticOwnerId
};
