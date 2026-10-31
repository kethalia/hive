import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { githubCheckProducer } from "@/lib/delivery/github-contracts";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import {
  resolveControllerGitHubManagerPolicy,
  resolveControllerGitHubTargetPolicy,
} from "@/lib/delivery/github-policy.server";
import type { ManagerPolicyScope } from "@/lib/delivery/manager.server";
import { githubFixture } from "./github-fixture";

function fixture() {
  const scope: ManagerPolicyScope = {
    ownerId: randomUUID(),
    projectId: randomUUID(),
    taskId: randomUUID(),
    stepId: randomUUID(),
    managerBindingId: randomUUID(),
    checkoutBindingDigest: "f".repeat(64),
    repositoryId: "42",
    providerAccountId: "7",
    fullName: "owner/repo",
    sourceSha: "a".repeat(40),
    branch: "fixture",
    stepKind: "validate",
    criterionIds: ["C1"],
    requiredEvidenceKinds: ["check"],
    acceptancePhase: "implementation_preview",
  };
  const config = { pullNumber: 5, policy: githubFixture().policy };
  return { scope, config, read: () => JSON.stringify({ [scope.taskId]: config }) };
}
describe("shared controller GitHub policy", () => {
  it("source and manager share normalized policy; producer binds every policy field", () => {
    const f = fixture(),
      source = resolveControllerGitHubTargetPolicy(f.scope.taskId, f.read),
      manager = resolveControllerGitHubManagerPolicy(f.scope, f.read);
    expect(manager?.policy.version).toBe(source.policy.version);
    expect(manager?.policy.maxAgeMs).toBe(source.policy.maxAgeMs);
    expect(manager?.policy.trustedProducers).toHaveLength(1);
    const producer = manager?.policy.trustedProducers[0];
    f.config.policy.checks[0].criterionIds = ["C2"];
    expect(
      resolveControllerGitHubManagerPolicy(f.scope, f.read)?.policy.trustedProducers[0],
    ).not.toBe(producer);
  });
  it("same-SHA PR changes bind authority even when policy producer is unchanged", () => {
    const f = fixture(),
      old = resolveControllerGitHubManagerPolicy(f.scope, f.read);
    f.config.pullNumber++;
    const current = resolveControllerGitHubManagerPolicy(f.scope, f.read);
    expect(old?.policy.trustedProducers).toEqual(current?.policy.trustedProducers);
    expect(old?.authorityDigest).not.toBe(current?.authorityDigest);
  });
  it("understand/analysis does not acquire a PR prerequisite or implicit success", () => {
    const f = fixture(),
      read = vi.fn(() => {
        throw new Error("No PR exists");
      });
    expect(
      resolveControllerGitHubManagerPolicy(
        { ...f.scope, stepKind: "understand", requiredEvidenceKinds: ["analysis"] },
        read,
      ),
    ).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(() =>
      resolveControllerGitHubManagerPolicy(
        { ...f.scope, stepKind: "understand", requiredEvidenceKinds: ["review"] },
        read,
      ),
    ).toThrow("No PR exists");
  });
  it("missing, oversized and malformed controller configuration grants no trust", () => {
    const f = fixture();
    for (const raw of [
      undefined,
      "not-json",
      "x".repeat(65537),
      JSON.stringify({ [f.scope.taskId]: { ...f.config, producer: "manager-choice" } }),
    ])
      expect(() => resolveControllerGitHubTargetPolicy(f.scope.taskId, () => raw)).toThrow(
        "policy unavailable",
      );
    expect(() => resolveControllerGitHubTargetPolicy(f.scope.taskId, () => "{}")).toThrow(
      "github_task_policy_missing",
    );
  });
  it("empty completion references cannot bypass controller coverage", async () => {
    const f = fixture(),
      selected = resolveControllerGitHubManagerPolicy(f.scope, f.read);
    if (!selected) throw new Error("Fixture policy missing");
    const transaction = { deliveryEvidence: { findMany: vi.fn() } };
    await expect(selected.authorizeReferences(transaction as never, [], true)).rejects.toThrow(
      "github_policy_evidence_missing",
    );
    expect(transaction.deliveryEvidence.findMany).not.toHaveBeenCalled();
    await expect(
      selected.authorizeReferences(transaction as never, [], false),
    ).resolves.toBeUndefined();
  });
  it("a publication missing a configured same-criterion group cannot authorize its claimed passing row", async () => {
    const f = fixture();
    f.config.policy.checks.push({
      ...f.config.policy.checks[0],
      workflowId: "999",
      name: "Required lint",
    });
    const selected = resolveControllerGitHubManagerPolicy(f.scope, f.read);
    if (!selected) throw new Error("Fixture policy missing");
    const id = randomUUID(),
      first = f.config.policy.checks[0];
    const transaction = {
      deliveryEvidence: {
        findMany: vi.fn().mockResolvedValue([
          {
            id,
            producer: selected.policy.trustedProducers[0],
            policyVersion: selected.policy.version,
            sourceSha: f.scope.sourceSha,
          },
        ]),
      },
      deliveryEvent: {
        findMany: vi.fn().mockResolvedValue([
          {
            policyVersion: selected.policy.version,
            payload: {
              schemaVersion: 1,
              snapshotDigest: "a".repeat(64),
              policyDigest: githubSourceDigest(f.config.policy),
              evidenceIds: [id],
              watermarks: [
                {
                  key: `${githubCheckProducer(f.scope.repositoryId, first.workflowId, first.appId)}/${first.name}`,
                },
              ],
            },
          },
        ]),
      },
    };
    await expect(selected.authorizeReferences(transaction as never, [id], true)).rejects.toThrow(
      "github_evidence_provenance_missing",
    );
  });
});
