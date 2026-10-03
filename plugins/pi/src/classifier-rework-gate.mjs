/** Host-local presentation for the shared classifier-rework receipt. */
export function formatClassifierRework(value) {
  if (value?.schema !== "statewright/classifier-rework/v1"
      || !Number.isSafeInteger(value.attempts)
      || !Number.isSafeInteger(value.max_reworks)) return null;
  if (value.action === "approval_required") {
    return "Classifier rework budget exhausted; this exact classified intent now requires native human approval.";
  }
  if (value.action === "rework") {
    return `Classifier rework attempt ${value.attempts}/${value.max_reworks}; after this budget, the same classified intent must be sent for human approval.`;
  }
  if (value.action === "exact_invocation_denied") {
    return "The exact denied invocation cannot count as rework; change it on the reported structural axis.";
  }
  return null;
}
