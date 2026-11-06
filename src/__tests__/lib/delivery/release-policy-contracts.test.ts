import { describe, expect, it } from "vitest";
import { releasePolicyCovers, releasePolicySchema } from "@/lib/delivery/release-policy-contracts";

const policy = {
  schemaVersion: 1,
  versionId: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000002",
  repositoryId: "101",
  providerAccountId: "102",
  environmentKey: "preview",
  targetDigest: "a".repeat(64),
  targetResources: ["a".repeat(64), "b".repeat(64)],
  actions: ["merge", "promote"],
  riskClasses: ["application_only"],
  observationWindowMs: 1000,
  observationConfigDigest: "f".repeat(64),
  authorityConfigDigest: "f".repeat(64),
  buildAuthorityDigest: "e".repeat(64),
  validFrom: 100,
  expiresAt: 200,
};
const scope = {
  ownerId: policy.ownerId,
  repositoryId: policy.repositoryId,
  providerAccountId: policy.providerAccountId,
  environmentKey: policy.environmentKey,
  targetDigest: policy.targetDigest,
  action: "merge",
  riskClass: "application_only",
};
describe("bounded release policy scope", () => {
  it("covers a future release in its enrolled scope without a per-release approval", () => {
    expect(releasePolicyCovers(policy, scope, 100)).toBe(true);
    expect(releasePolicyCovers(policy, { ...scope, action: "promote" }, 199)).toBe(true);
    expect(releasePolicyCovers(policy, scope, 99)).toBe(false);
    expect(releasePolicyCovers(policy, scope, 200)).toBe(false);
  });
  it("rejects foreign identities, target drift, unapproved actions and database or unknown risk", () => {
    for (const changed of [
      { ownerId: "00000000-0000-4000-8000-000000000003" },
      { repositoryId: "103" },
      { providerAccountId: "104" },
      { environmentKey: "production" },
      { targetDigest: "b".repeat(64) },
      { action: "recover" },
      { riskClass: "database" },
      { riskClass: "unknown" },
    ])
      expect(releasePolicyCovers(policy, { ...scope, ...changed }, 150)).toBe(false);
  });
  it("rejects malformed or broadened policy declarations", () => {
    expect(() => releasePolicySchema.parse({ ...policy, actions: ["merge", "merge"] })).toThrow();
    expect(
      releasePolicyCovers(
        { ...policy, riskClasses: ["database"] },
        { ...scope, riskClass: "database" },
        150,
      ),
    ).toBe(true);
    expect(() =>
      releasePolicySchema.parse({ ...policy, riskClasses: ["database", "database"] }),
    ).toThrow();
    expect(() => releasePolicySchema.parse({ ...policy, expiresAt: 100 })).toThrow();
    expect(() => releasePolicySchema.parse({ ...policy, bypassRules: true })).toThrow();
  });
});
