import { describe, expect, it } from "vitest";
import { completionSchema } from "@/lib/delivery/contracts";
import {
  assertAcyclicSteps,
  assertCompletionEvidence,
  assertStepTransition,
  dependencySatisfied,
} from "@/lib/delivery/state";

describe("delivery state contracts", () => {
  it("rejects self and indirect cycles, unknown nodes and duplicate steps", () => {
    expect(() => assertAcyclicSteps(["a"], [{ stepId: "a", dependsOnStepId: "a" }])).toThrow(
      "dependency_cycle",
    );
    expect(() =>
      assertAcyclicSteps(
        ["a", "b"],
        [
          { stepId: "a", dependsOnStepId: "b" },
          { stepId: "b", dependsOnStepId: "a" },
        ],
      ),
    ).toThrow("dependency_cycle");
    expect(() => assertAcyclicSteps(["a"], [{ stepId: "a", dependsOnStepId: "missing" }])).toThrow(
      "unknown_dependency",
    );
    expect(() => assertAcyclicSteps(["a", "a"], [])).toThrow("duplicate_step");
    expect(() =>
      assertAcyclicSteps(["a", "b"], [{ stepId: "b", dependsOnStepId: "a" }]),
    ).not.toThrow();
  });
  it("requires an explicit reopening and refuses fabricated success transitions", () => {
    expect(() => assertStepTransition("succeeded", "running")).toThrow("invalid_transition");
    expect(() => assertStepTransition("pending", "succeeded")).toThrow("invalid_transition");
    expect(() => assertStepTransition("succeeded", "pending")).not.toThrow();
  });
  it("reported analysis is a guarded dependency outcome, not a verified success transition", () => {
    const analysis = {
      state: "reported",
      kind: "understand",
      acceptancePhase: "implementation_preview",
      requiredEvidenceKinds: ["analysis"],
    };
    expect(dependencySatisfied(analysis)).toBe(true);
    expect(dependencySatisfied({ ...analysis, kind: "review" })).toBe(false);
    expect(dependencySatisfied({ ...analysis, acceptancePhase: "activation_production" })).toBe(
      false,
    );
    expect(dependencySatisfied({ ...analysis, requiredEvidenceKinds: ["analysis", "check"] })).toBe(
      false,
    );
    expect(() => assertStepTransition("reported", "succeeded")).toThrow("invalid_transition");
    expect(() => assertStepTransition("reported", "pending")).not.toThrow();
  });
  const claim = () => ({
    ownerId: "owner",
    stepId: "step",
    sourceSha: "a".repeat(40),
    criterionIds: ["C1", "C2"],
    requiredKinds: ["check"],
    acceptancePhase: "implementation_preview",
    policyVersion: "test-v1",
    trustedProducers: ["trusted-check"],
    now: new Date(1000),
    maxAgeMs: 500,
    evidence: [
      {
        ownerId: "owner",
        stepId: "step",
        sourceSha: "a".repeat(40),
        producer: "trusted-check",
        policyVersion: "test-v1",
        status: "passed",
        verificationMode: "simulated",
        kind: "check",
        criterionIds: ["C1", "C2"],
        invalidatedAt: null as Date | null,
        observedAt: new Date(900),
      },
    ],
  });
  it("requires every criterion and evidence kind", () => {
    expect(() => assertCompletionEvidence(claim())).not.toThrow();
    const value = claim();
    value.evidence[0].criterionIds = ["C1"];
    expect(() => assertCompletionEvidence(value)).toThrow("missing_evidence");
    value.evidence[0].criterionIds = ["C1", "C2"];
    value.requiredKinds.push("review");
    expect(() => assertCompletionEvidence(value)).toThrow("missing_evidence");
  });

  it("prevents simulated preview evidence from passing a production criterion", () => {
    const value = claim();
    value.acceptancePhase = "activation_production";
    expect(() => assertCompletionEvidence(value)).toThrow("invalid_evidence");
    value.evidence[0].verificationMode = "production";
    expect(() => assertCompletionEvidence(value)).not.toThrow();
  });
  it.each([
    "ownerId",
    "stepId",
    "sourceSha",
    "producer",
    "policyVersion",
    "status",
  ] as const)("rejects a mismatched persisted evidence %s", (field) => {
    const value = claim();
    value.evidence[0][field] = "untrusted";
    expect(() => assertCompletionEvidence(value)).toThrow("invalid_evidence");
  });
  it("rejects invalidated, future, and stale evidence", () => {
    for (const observedAt of [new Date(0), new Date(2000)]) {
      const value = claim();
      value.evidence[0].observedAt = observedAt;
      expect(() => assertCompletionEvidence(value)).toThrow("invalid_evidence");
    }
    const value = claim();
    value.evidence[0].invalidatedAt = new Date(950);
    expect(() => assertCompletionEvidence(value)).toThrow("invalid_evidence");
  });
  it("rejects manager-supplied producer and verification claims in completion reports", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const value = {
      schemaVersion: 1,
      eventId: id,
      taskId: id,
      stepId: id,
      attemptId: id,
      expectedVersion: 1,
      leaseGeneration: 1,
      sourceSha: "a".repeat(40),
      evidenceIds: [id],
      report: {
        summary: "Fixture",
        difficulty: "low",
        difficultyReason: "Fixture",
        issues: [],
        remainingUncertainty: "No production",
        nextAction: "Review",
      },
    };
    expect(completionSchema.safeParse(value).success).toBe(true);
    expect(
      completionSchema.safeParse({ ...value, verified: true, producer: "trusted-check" }).success,
    ).toBe(false);
    expect(
      completionSchema.safeParse({
        ...value,
        report: { ...value.report, evidence: [{ status: "passed" }] },
      }).success,
    ).toBe(false);
  });
});
