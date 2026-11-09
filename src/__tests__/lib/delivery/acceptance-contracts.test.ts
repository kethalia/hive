import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptanceDigest,
  acceptanceJobScopeSchema,
  requireIntentDigest,
  validatePlan,
  validateReview,
} from "@/lib/delivery/acceptance-contracts";

const original = "Add a parser that rejects negative integers. Preserve existing behavior.";
const plan = {
  schemaVersion: 1 as const,
  kind: "plan" as const,
  intentDigest: requireIntentDigest(original),
  outcome: "ready" as const,
  requirements: [
    {
      id: "acceptance:parser",
      meaning: "Reject negative integer inputs",
      phase: "implementation_preview" as const,
      intentRanges: [{ start: 0, end: 43 }],
      verification: "Inspect exact candidate parser and independent boundary test.",
    },
    {
      id: "acceptance:compatibility",
      meaning: "Preserve existing positive-input behavior",
      phase: "implementation_preview" as const,
      intentRanges: [{ start: 44, end: Buffer.byteLength(original) }],
      verification: "Inspect compatibility tests and candidate changes.",
    },
  ],
  unresolved: [],
  rationale: "Both requested behaviors are represented.",
};
function fixture() {
  const expected = {
    intentDigest: plan.intentDigest,
    plan,
    planDigest: acceptanceDigest(plan),
    sourceSha: "a".repeat(40),
    inputDigest: "b".repeat(64),
    criterionIds: ["acceptance:parser"],
    phase: "implementation_preview" as const,
    artifacts: new Map([["parser", { digest: "c".repeat(64), bytes: 100 }]]),
  };
  const result = {
    schemaVersion: 1,
    kind: "review",
    intentDigest: expected.intentDigest,
    planDigest: expected.planDigest,
    sourceSha: expected.sourceSha,
    inputDigest: expected.inputDigest,
    outcome: "pass",
    requirements: plan.requirements.map((r, i) => ({
      id: r.id,
      meaningDigest: requireIntentDigest(r.meaning),
      outcome: i === 0 ? "pass" : "outside_step_scope",
      rationale: "The cited candidate implements the scoped requirement.",
      citations:
        i === 0 ? [{ artifactDigest: "c".repeat(64), entryId: "parser", start: 0, end: 10 }] : [],
    })),
    unresolved: [],
    rationale: "This step passes; overall intent is not yet complete.",
  };
  return { expected, result };
}
describe("independent acceptance contracts", () => {
  it("binds exact owner bytes and keeps the full intent plan even for a subset task", () => {
    expect(validatePlan(plan, original)).toEqual(plan);
    const { result, expected } = fixture();
    expect(validateReview(result, expected).requirements).toHaveLength(2);
    expect(() => validatePlan(plan, `${original} `)).toThrow("acceptance_intent_mismatch");
  });
  it("rejects omitted requirements, changed meanings and self-declared source identity", () => {
    const { result, expected } = fixture();
    expect(() =>
      validateReview({ ...result, requirements: result.requirements.slice(0, 1) }, expected),
    ).toThrow("acceptance_review_coverage_missing");
    const changed = structuredClone(result);
    changed.requirements[0].meaningDigest = "d".repeat(64);
    expect(() => validateReview(changed, expected)).toThrow(
      "acceptance_requirement_meaning_mismatch",
    );
    expect(() => validateReview({ ...result, sourceSha: "d".repeat(40) }, expected)).toThrow(
      "acceptance_review_scope_mismatch",
    );
  });
  it("requires real sealed citations and never promotes preview evidence to production", () => {
    const { result, expected } = fixture();
    const changed = structuredClone(result);
    changed.requirements[0].citations[0].end = 101;
    expect(() => validateReview(changed, expected)).toThrow("acceptance_citation_invalid");
    expect(() => validateReview(result, { ...expected, phase: "activation_production" })).toThrow(
      "acceptance_review_evidence_missing",
    );
    expect(() =>
      validateReview({ ...result, unresolved: ["Missing runtime observation"] }, expected),
    ).toThrow("acceptance_review_not_satisfied");
  });
  it("cannot hide a requested criterion outside the step or use a manager-created ID", () => {
    const { result, expected } = fixture();
    expect(() =>
      validateReview(result, { ...expected, criterionIds: ["acceptance:compatibility"] }),
    ).toThrow("acceptance_review_coverage_missing");
    expect(() =>
      validateReview(result, { ...expected, criterionIds: ["manager_claimed_success"] }),
    ).toThrow("acceptance_requirement_unknown");
  });
  it("requires all or none of the candidate context for plan versus review jobs", () => {
    const scope = {
      ownerId: randomUUID(),
      projectId: randomUUID(),
      preparationIntentId: randomUUID(),
      repositoryPolicyVersionId: randomUUID(),
      repositoryPolicyDigest: "a".repeat(64),
      intentDigest: plan.intentDigest,
      producerDigest: "b".repeat(64),
      kind: "plan",
      taskId: null,
      stepId: null,
      attemptId: null,
      planDigest: null,
      sourceRevisionId: null,
      sourceSha: null,
      sourceVersion: null,
      sourceTreeSha: null,
      evidenceDigest: null,
      artifactDigest: null,
    };
    expect(acceptanceJobScopeSchema.parse(scope)).toEqual(scope);
    expect(() => acceptanceJobScopeSchema.parse({ ...scope, kind: "review" })).toThrow();
    expect(() => acceptanceJobScopeSchema.parse({ ...scope, sourceSha: "c".repeat(40) })).toThrow();
  });
});
