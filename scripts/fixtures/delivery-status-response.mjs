// Explicit server-response double for bounded client/factory tests only.
export function statusResponse(input, ownerId, meta) {
  const observedAt = Date.now() - 1;
  const admission = Object.fromEntries(
    [
      "runtimeId",
      "runtimeGeneration",
      "admissionId",
      "admissionGeneration",
      "producerDigest",
      "checkoutIncarnation",
      "barrierGeneration",
    ].map((key) => [key, meta[key]]),
  );
  return {
    schemaVersion: 1,
    action: "read_delivery_status",
    requestId: input.requestId,
    observedAt,
    expiresAt: Math.min(observedAt + 29000, input.expiresAt),
    scope: {
      ownerId,
      registrationId: input.registrationId,
      serverInstanceId: input.serverInstanceId,
      managerThreadId: input.managerThreadId,
      managerBindingId: input.managerBindingId,
      checkoutBindingDigest: "f".repeat(64),
      checkoutBinding: input.checkoutBinding,
      taskId: input.taskId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      attemptLeaseGeneration: input.attemptLeaseGeneration,
      inputSourceSha: input.inputSourceSha,
      inputSourceContext: input.inputSourceContext,
    },
    admission,
    metadata: {
      pins: meta.metadataPins,
      pinsDigest: meta.metadataPinsDigest,
      policyDigest: meta.metadataPolicyDigest,
      namespaceReceiptDigest: meta.namespaceReceiptDigest,
    },
    task: { version: 1, pauseRequested: false, schedulingPaused: false },
    step: {
      kind: "validate",
      state: "running",
      version: 1,
      acceptancePhase: "implementation_preview",
      criterionIds: ["C1"],
      requiredEvidenceKinds: ["check"],
    },
    attempt: { outcome: "running", leaseExpiresAt: Date.now() + 60000 },
    source: {
      physicalBase: input.checkoutBinding.revision,
      headSha: input.inputSourceContext?.headSha ?? input.checkoutBinding.revision,
      sourceContext: input.inputSourceContext,
      applicationPhase: input.inputSourceContext ? "applied" : "base",
      operationId: null,
      pullNumber: null,
    },
    evidence: {
      policyVersion: null,
      requirementStatus: "held",
      referenceIds: [],
      observations: [],
    },
    blockers: ["policy_unavailable"],
    executionAuthorized: false,
    publicationAuthorized: false,
    cleanupAuthorized: false,
  };
}
