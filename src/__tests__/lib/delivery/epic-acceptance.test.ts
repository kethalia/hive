import { expect, it } from "vitest";
import {
  acceptancePlanResultSchema,
  inheritedAcceptanceCriteriaSchema,
} from "@/lib/delivery/acceptance-contracts";
import { bindEpicAcceptance } from "@/lib/delivery/epic-acceptance";

const inherited = inheritedAcceptanceCriteriaSchema.parse({
  epicPlanDigest: "a".repeat(64),
  ownerPlanDigest: "b".repeat(64),
  requirements: [
    {
      id: "acceptance:owner",
      meaning: "The user can complete the intended workflow",
      phase: "implementation_preview",
    },
  ],
});
const plan = acceptancePlanResultSchema.parse({
  schemaVersion: 1,
  kind: "plan",
  intentDigest: "c".repeat(64),
  outcome: "ready",
  requirements: [
    {
      id: "acceptance:child",
      meaning: "Complete the workflow end to end",
      phase: "implementation_preview",
      intentRanges: [{ start: 0, end: 1 }],
      verification: "Inspect behavior",
    },
    {
      id: "acceptance:extra",
      meaning: "Preserve the fixture",
      phase: "implementation_preview",
      intentRanges: [{ start: 0, end: 1 }],
      verification: "Inspect fixture",
    },
  ],
  inheritedMappings: [
    { ownerCriterionId: "acceptance:owner", childRequirementId: "acceptance:child" },
  ],
  unresolved: [],
  rationale: "Independent producer fixture",
});
it("binds producer-selected child IDs while preserving independently discovered requirements", () => {
  expect(bindEpicAcceptance(inherited, plan)).toEqual([
    { ownerCriterionId: "acceptance:owner", childRequirementId: "acceptance:child" },
  ]);
  expect(plan.requirements).toHaveLength(2);
  expect(() => bindEpicAcceptance(inherited, { ...plan, inheritedMappings: [] })).toThrow(
    "epic_acceptance_mapping_incomplete",
  );
  expect(() =>
    bindEpicAcceptance(inherited, {
      ...plan,
      inheritedMappings: [
        { ownerCriterionId: "acceptance:owner", childRequirementId: "acceptance:missing" },
      ],
    }),
  ).toThrow("epic_acceptance_mapping_incomplete");
  expect(() =>
    bindEpicAcceptance(inherited, {
      ...plan,
      requirements: [
        { ...plan.requirements[0], phase: "activation_production" },
        plan.requirements[1],
      ],
    }),
  ).toThrow("epic_acceptance_mapping_incomplete");
});
