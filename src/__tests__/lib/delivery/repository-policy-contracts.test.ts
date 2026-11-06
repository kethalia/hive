import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compileRepositoryTaskPolicy,
  repositoryGateDescriptors,
  repositoryPolicyCatalogSchema,
  repositoryPolicyDefinitionSchema,
  repositoryPolicyTextDigest,
} from "@/lib/delivery/repository-policy-contracts";
import { githubFixture } from "./github-fixture";

function fixture() {
  const evidenceGates = githubFixture().policy;
  evidenceGates.checks[0].criterionIds = ["repo:ci"];
  if (evidenceGates.codexReview) evidenceGates.codexReview.criterionIds = ["repo:review"];
  const source = {
    version: "fixture-source-v1",
    authorName: "Hive fixture",
    authorEmail: "fixture@example.invalid",
    baseBranch: "codex/epic",
    allowedPrefixes: ["src", "tests"],
    maxFiles: 10,
    maxFileBytes: 1000,
    maxBytes: 10000,
  };
  const intent = "Implement the reviewed deterministic fixture.",
    outcome = "The dedicated acceptance check passes.";
  const check = repositoryGateDescriptors(evidenceGates).find((v) => v.kind === "check");
  if (!check) throw new Error("Fixture check missing");
  const policy = {
    schemaVersion: 1,
    source,
    evidenceGates,
    acceptanceContracts: [
      {
        id: "deterministic-fixture",
        intentTextDigest: repositoryPolicyTextDigest(intent),
        taskOutcomeDigest: repositoryPolicyTextDigest(outcome),
        criteria: [
          {
            id: "C1",
            meaning: "The reviewed deterministic test proves its specific result.",
            kind: "check",
            evaluatorGateKeys: [check.key],
          },
        ],
      },
    ],
  };
  const step = {
    id: randomUUID(),
    kind: "validate" as const,
    criterionIds: ["C1"],
    requiredEvidenceKinds: ["check" as const],
    attemptBudget: 3,
    acceptancePhase: "implementation_preview" as const,
  };
  return { policy, intent, outcome, step };
}
describe("repository gates and exact semantic acceptance contracts", () => {
  it("retains reviewed meaning as pending without relabeling ordinary CI or dropping repository review", () => {
    const f = fixture(),
      value = compileRepositoryTaskPolicy(
        f.policy,
        repositoryPolicyTextDigest(f.intent),
        f.outcome,
        [f.step],
      );
    expect(value.pendingRequirements).toEqual([
      {
        stepId: f.step.id,
        criterionId: "C1",
        kind: "check",
        reason: "acceptance_evaluator_provenance_pending",
      },
    ]);
    expect(value.criterionCoverage).toHaveLength(1);
    expect(value.compiledEvidencePolicy.checks[0].criterionIds).toEqual(["repo:ci"]);
    expect(value.compiledEvidencePolicy.codexReview?.criterionIds).toEqual(["repo:review"]);
    expect(f.policy.evidenceGates.checks[0].criterionIds).toEqual(["repo:ci"]);
  });
  it("a reused criterion label, different owner intent or outcome does not inherit goal verification", () => {
    const f = fixture();
    for (const [intent, outcome] of [
      [`${f.intent} Different goal`, f.outcome],
      [f.intent, `${f.outcome} Different meaning`],
    ]) {
      const value = compileRepositoryTaskPolicy(
        f.policy,
        repositoryPolicyTextDigest(intent),
        outcome,
        [f.step],
      );
      expect(value.criterionCoverage).toEqual([]);
      expect(value.pendingRequirements).toEqual([
        {
          stepId: f.step.id,
          criterionId: "C1",
          kind: "check",
          reason: "acceptance_evaluator_unavailable",
        },
      ]);
      expect(value.compiledEvidencePolicy.checks[0].criterionIds).toEqual(["repo:ci"]);
    }
  });
  it("unknown criteria/kinds and informational plans cannot remove repository gates", () => {
    const f = fixture();
    const steps = [
      { ...f.step, criterionIds: ["C2"] },
      {
        ...f.step,
        id: randomUUID(),
        kind: "understand" as const,
        requiredEvidenceKinds: ["analysis" as const],
      },
    ];
    const value = compileRepositoryTaskPolicy(
      f.policy,
      repositoryPolicyTextDigest(f.intent),
      f.outcome,
      steps,
    );
    expect(value.pendingRequirements).toHaveLength(2);
    expect(value.compiledEvidencePolicy).toEqual(f.policy.evidenceGates);
    expect(() =>
      compileRepositoryTaskPolicy(f.policy, repositoryPolicyTextDigest(f.intent), f.outcome, [
        { ...f.step, criterionIds: ["repo:ci"] },
      ]),
    ).toThrow("repository_criterion_reserved");
  });
  it("rejects unknown evaluators, duplicate contracts, unreserved gate criteria and opaque extra fields", () => {
    const f = fixture();
    for (const mutate of [
      (p: typeof f.policy) =>
        (p.acceptanceContracts[0].criteria[0].evaluatorGateKeys = ["f".repeat(64)]),
      (p: typeof f.policy) => p.acceptanceContracts.push(p.acceptanceContracts[0]),
      (p: typeof f.policy) => (p.evidenceGates.checks[0].criterionIds = ["C1"]),
    ]) {
      const value = structuredClone(f.policy);
      mutate(value);
      expect(repositoryPolicyDefinitionSchema.safeParse(value).success).toBe(false);
    }
    expect(
      repositoryPolicyDefinitionSchema.safeParse({ ...f.policy, taskId: randomUUID() }).success,
    ).toBe(false);
    const entry = {
      ownerId: randomUUID(),
      repositoryId: "123",
      providerAccountId: "456",
      fullName: "fixture/repo",
      policy: f.policy,
    };
    expect(repositoryPolicyCatalogSchema.safeParse([entry, entry]).success).toBe(false);
  });
});
