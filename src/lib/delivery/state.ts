import type { DeliveryStepState } from "./contracts";

export class DeliveryConflict extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const transitions: Record<DeliveryStepState, readonly DeliveryStepState[]> = {
  pending: ["ready", "canceled"],
  ready: ["running", "blocked", "canceled"],
  running: ["waiting_external", "blocked", "succeeded", "failed", "canceled"],
  waiting_external: ["running", "blocked", "failed", "canceled"],
  blocked: ["ready", "canceled"],
  failed: ["ready", "canceled"],
  succeeded: ["pending"],
  canceled: [],
};
export function assertStepTransition(from: DeliveryStepState, to: DeliveryStepState) {
  if (!transitions[from].includes(to)) throw new DeliveryConflict("invalid_transition");
}

export function assertAcyclicSteps(
  stepIds: string[],
  dependencies: { stepId: string; dependsOnStepId: string }[],
) {
  const nodes = new Map(stepIds.map((id) => [id, [] as string[]]));
  if (nodes.size !== stepIds.length) throw new DeliveryConflict("duplicate_step");
  const edges = new Set<string>();
  for (const { stepId, dependsOnStepId } of dependencies) {
    const key = `${stepId}/${dependsOnStepId}`;
    if (!nodes.has(stepId) || !nodes.has(dependsOnStepId))
      throw new DeliveryConflict("unknown_dependency");
    if (edges.has(key)) throw new DeliveryConflict("duplicate_dependency");
    edges.add(key);
    nodes.get(stepId)?.push(dependsOnStepId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new DeliveryConflict("dependency_cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of nodes.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of stepIds) visit(id);
}

export function dependentClosure(
  rootIds: string[],
  dependencies: { stepId: string; dependsOnStepId: string }[],
) {
  const result = new Set(rootIds);
  const queue = [...rootIds];
  for (let index = 0; index < queue.length; index++)
    for (const edge of dependencies) {
      if (edge.dependsOnStepId === queue[index] && !result.has(edge.stepId)) {
        result.add(edge.stepId);
        queue.push(edge.stepId);
      }
    }
  return result;
}

interface EvidenceClaim {
  ownerId: string;
  stepId: string;
  sourceSha: string;
  producer: string;
  policyVersion: string;
  status: string;
  verificationMode: string;
  kind: string;
  criterionIds: string[];
  invalidatedAt: Date | null;
  observedAt: Date;
}
export function assertCompletionEvidence(input: {
  ownerId: string;
  stepId: string;
  sourceSha: string;
  criterionIds: string[];
  requiredKinds: string[];
  acceptancePhase: string;
  policyVersion: string;
  trustedProducers: readonly string[];
  now: Date;
  maxAgeMs: number;
  evidence: EvidenceClaim[];
}) {
  if (!["implementation_preview", "activation_production"].includes(input.acceptancePhase))
    throw new DeliveryConflict("invalid_acceptance_phase");
  const valid = input.evidence.every(
    (evidence) =>
      evidence.ownerId === input.ownerId &&
      evidence.stepId === input.stepId &&
      evidence.sourceSha === input.sourceSha &&
      evidence.policyVersion === input.policyVersion &&
      evidence.status === "passed" &&
      (input.acceptancePhase !== "activation_production" ||
        evidence.verificationMode === "production") &&
      evidence.invalidatedAt === null &&
      input.trustedProducers.includes(evidence.producer) &&
      evidence.observedAt.getTime() <= input.now.getTime() &&
      input.now.getTime() - evidence.observedAt.getTime() <= input.maxAgeMs,
  );
  if (!valid) throw new DeliveryConflict("invalid_evidence");
  for (const criterionId of input.criterionIds)
    for (const kind of input.requiredKinds)
      if (
        !input.evidence.some(
          (evidence) => evidence.kind === kind && evidence.criterionIds.includes(criterionId),
        )
      )
        throw new DeliveryConflict("missing_evidence");
}
