import { describe, expect, it } from "vitest";
import { type EligibilityInput, evaluateDeliveryEligibility } from "@/lib/delivery/eligibility";

const sha = "a".repeat(40);
function input(): EligibilityInput {
  return {
    sourceSha: sha,
    now: 1000,
    paused: false,
    policy: {
      version: "reviewed-policy-1",
      requiredChecks: [{ name: "CI", producer: "github-actions" }],
      requireIndependentReview: true,
      maxEvidenceAgeMs: 500,
    },
    trustedCheckProducers: ["github-actions"],
    trustedReviewProducers: ["codex-review"],
    checks: [
      {
        name: "CI",
        sourceSha: sha,
        observedAt: 900,
        sourceUpdatedAt: 890,
        remoteId: "remote-1",
        runSequence: 1,
        runAttempt: 1,
        producer: "github-actions",
        status: "success",
        verified: true,
      },
    ],
    reviews: [
      {
        sourceSha: sha,
        observedAt: 900,
        sourceUpdatedAt: 890,
        remoteId: "remote-1",
        runSequence: 1,
        runAttempt: 1,
        producer: "codex-review",
        status: "completed",
        unresolvedFindings: 0,
        independent: true,
        verified: true,
      },
    ],
  };
}

describe("delivery eligibility observation", () => {
  it("passes current independent evidence without granting merge authority", () => {
    expect(evaluateDeliveryEligibility(input())).toEqual({
      mode: "observation",
      eligible: true,
      sourceSha: sha,
      policyVersion: "reviewed-policy-1",
      blockers: [],
    });
  });
  it("invalidates all evidence when the PR head changes", () => {
    const value = input();
    value.sourceSha = "b".repeat(40);
    expect(evaluateDeliveryEligibility(value).blockers).toEqual([
      "check-missing:CI",
      "review-missing",
    ]);
  });
  it.each([
    "failure",
    "pending",
    "skipped",
    "unknown",
  ] as const)("rejects a newer %s rerun after success", (status) => {
    const value = input();
    value.checks.push({
      ...value.checks[0],
      observedAt: 950,
      sourceUpdatedAt: 940,
      remoteId: "remote-2",
      runSequence: 2,
      status,
    });
    expect(evaluateDeliveryEligibility(value).blockers).toContain("check-not-passed:CI");
  });
  it("rejects conflicting results at the same timestamp regardless of order", () => {
    const value = input();
    value.checks.push({ ...value.checks[0], status: "failure" });
    expect(evaluateDeliveryEligibility(value).eligible).toBe(false);
    value.checks.reverse();
    expect(evaluateDeliveryEligibility(value).eligible).toBe(false);
  });
  it.each([0, 1100, Number.NaN])("rejects stale or invalid evidence time %s", (observedAt) => {
    const value = input();
    value.checks[0].observedAt = observedAt;
    expect(evaluateDeliveryEligibility(value).eligible).toBe(false);
  });
  it("does not treat task-submitted evidence as authenticated review", () => {
    const value = input();
    value.reviews[0].verified = false;
    expect(evaluateDeliveryEligibility(value).blockers).toContain("review-missing");
  });
  it("rejects a spoofed check producer", () => {
    const value = input();
    value.checks[0].producer = "task-agent";
    expect(evaluateDeliveryEligibility(value).blockers).toContain("check-missing:CI");
  });
  it("does not reuse an earlier successful review after new findings", () => {
    const value = input();
    value.reviews.push({
      ...value.reviews[0],
      observedAt: 950,
      sourceUpdatedAt: 940,
      remoteId: "remote-2",
      runSequence: 2,
      unresolvedFindings: 1,
    });
    expect(evaluateDeliveryEligibility(value).blockers).toContain("review-not-passed");
  });
  it("does not allow another reviewer to overwrite unresolved findings", () => {
    const value = input();
    value.reviews[0].unresolvedFindings = 1;
    value.trustedReviewProducers.push("second-reviewer");
    value.reviews.push({
      ...value.reviews[0],
      producer: "second-reviewer",
      observedAt: 950,
      sourceUpdatedAt: 940,
      remoteId: "remote-2",
      runSequence: 2,
      unresolvedFindings: 0,
    });
    expect(evaluateDeliveryEligibility(value).blockers).toContain("review-not-passed");
  });
  it("does not let delayed old success erase a newer failed run", () => {
    const value = input();
    value.checks[0].observedAt = 990;
    value.checks.push({
      ...value.checks[0],
      remoteId: "remote-2",
      runSequence: 2,
      sourceUpdatedAt: 940,
      observedAt: 950,
      status: "failure",
    });
    expect(evaluateDeliveryEligibility(value).blockers).toContain("check-not-passed:CI");
  });
  it("binds required checks to the expected producer", () => {
    const value = input();
    value.checks[0].status = "failure";
    value.trustedCheckProducers.push("other-workflow");
    value.checks.push({
      ...value.checks[0],
      producer: "other-workflow",
      remoteId: "other-1",
      sourceUpdatedAt: 940,
      observedAt: 950,
      status: "success",
    });
    expect(evaluateDeliveryEligibility(value).blockers).toContain("check-not-passed:CI");
  });
  it("cannot pass when an older run finishes after a newer run starts", () => {
    const value = input();
    value.checks[0].sourceUpdatedAt = 980;
    value.checks[0].observedAt = 990;
    value.checks.push({
      ...value.checks[0],
      remoteId: "run-2",
      runSequence: 2,
      sourceUpdatedAt: 940,
      observedAt: 950,
      status: "pending",
    });
    expect(evaluateDeliveryEligibility(value).blockers).toContain("check-not-passed:CI");
  });
  it("orders retries within one run before finish timestamps", () => {
    const value = input();
    value.checks[0].sourceUpdatedAt = 980;
    value.checks[0].observedAt = 990;
    value.checks.push({
      ...value.checks[0],
      runAttempt: 2,
      sourceUpdatedAt: 940,
      observedAt: 950,
      status: "pending",
    });
    expect(evaluateDeliveryEligibility(value).eligible).toBe(false);
  });
  it("does not hide a new nonindependent run behind an old independent success", () => {
    const value = input();
    value.reviews.push({
      ...value.reviews[0],
      runSequence: 2,
      remoteId: "review-2",
      sourceUpdatedAt: 940,
      observedAt: 950,
      independent: false,
      unresolvedFindings: 1,
    });
    expect(evaluateDeliveryEligibility(value).eligible).toBe(false);
  });
  it("refreshes an identical remote observation without retaining its stale fetch", () => {
    const value = input();
    value.checks[0].sourceUpdatedAt = 100;
    value.checks[0].observedAt = 200;
    value.checks.push({ ...value.checks[0], observedAt: 950 });
    expect(evaluateDeliveryEligibility(value).eligible).toBe(true);
  });
  it("requires independent review", () => {
    const value = input();
    value.reviews[0].independent = false;
    expect(evaluateDeliveryEligibility(value).eligible).toBe(false);
  });
  it("does not schedule delivery while paused", () => {
    const value = input();
    value.paused = true;
    expect(evaluateDeliveryEligibility(value).blockers).toContain("delivery-paused");
  });
  it.each(
    [[], ["CI", "CI"], [""]].map((names) => ({
      requiredChecks: names.map((name) => ({ name, producer: "github-actions" })),
    })),
  )("rejects empty or ambiguous required check policy %j", ({ requiredChecks }) => {
    const value = input();
    value.policy.requiredChecks = requiredChecks;
    expect(evaluateDeliveryEligibility(value).blockers).toContain("invalid-policy");
  });
});
