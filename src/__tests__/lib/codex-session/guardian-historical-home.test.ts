import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkspaceResource } from "@/lib/coder/types";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import {
  authorizeUnusedBootstrapRoot,
  readEmptyRootResource,
  readHistoricalHomeIdentity,
} from "@/lib/codex-session/guardian-empty-root.server";
import { emptyRootProposalSchema } from "@/lib/codex-session/guardian-empty-root-contracts";
import { verifyUnstartedCoderLifecycle } from "@/lib/codex-session/guardian-unstarted-contracts";
import historicalResources from "../../../../scripts/fixtures/historical-home-no-agents.json";
import wire from "../../../../scripts/fixtures/unused-bootstrap-root.json";

// Recorded eight-resource shape, with synthetic IDs and only allowlisted home
// metadata. Historical responses omit every agents property.
const resources = (): WorkspaceResource[] => structuredClone(historicalResources);
const agent = { id: randomUUID(), name: "fixture", status: "connected" as const };

describe("historical home resource associations", () => {
  it.each([
    "absent",
    "empty",
  ])("permits %s associations across the complete historical response", (shape) => {
    const rows = resources();
    if (shape === "empty") for (const row of rows) row.agents = [];
    const historical = readHistoricalHomeIdentity(rows);
    expect(rows).toHaveLength(8);
    expect(historical.resourceId).toBe(rows[7].id);
    expect(historical.identity.pvcUid).toBe("20000000-0000-4000-8000-000000000001");
    expect(historical.observedBoundVolumeName).toBe(`pvc-${historical.identity.pvcUid}`);
    expect(historical.identity).not.toHaveProperty("boundVolumeName");
    expect(() => readEmptyRootResource(rows, agent.id)).toThrow();
  });

  it("retains the unique deployment agent rule when associations are present", () => {
    const rows = resources();
    rows[7].agents = [agent];
    expect(readHistoricalHomeIdentity(rows).resourceId).toBe(rows[7].id);
    expect(readEmptyRootResource(rows, agent.id).resourceId).toBe(rows[7].id);
    expect(() => readEmptyRootResource(rows, randomUUID())).toThrow();
    rows[0].agents = [{ ...agent, id: randomUUID() }];
    expect(readHistoricalHomeIdentity(rows).resourceId).toBe(rows[7].id);
  });

  it.each([
    "association elsewhere",
    "multiple deployment agents",
    "duplicate agent",
  ])("rejects %s", (shape) => {
    const rows = resources();
    if (shape === "association elsewhere") rows[0].agents = [agent];
    if (shape === "multiple deployment agents")
      rows[7].agents = [agent, { ...agent, id: randomUUID() }];
    if (shape === "duplicate agent") {
      rows[7].agents = [agent];
      rows[0].agents = [agent];
    }
    expect(() => readHistoricalHomeIdentity(rows)).toThrow();
    expect(() => readEmptyRootResource(rows, agent.id)).toThrow();
  });

  it.each([
    "missing deployment",
    "duplicate deployment",
    "invalid resource ID",
    "sensitive metadata",
    "duplicate metadata",
    "unknown volume field",
    "read-only claim",
  ])("retains %s rejection without agents", (shape) => {
    const rows = resources();
    const home = rows[7];
    const metadata = home.metadata![0];
    if (shape === "missing deployment") rows.pop();
    if (shape === "duplicate deployment") rows.push(structuredClone(home));
    if (shape === "invalid resource ID") home.id = "invalid";
    if (shape === "sensitive metadata") metadata.sensitive = true;
    if (shape === "duplicate metadata") home.metadata!.push({ ...metadata });
    if (shape === "unknown volume field")
      metadata.value = JSON.stringify({ ...JSON.parse(metadata.value!), unexpected: true });
    if (shape === "read-only claim")
      metadata.value = JSON.stringify({ ...JSON.parse(metadata.value!), claimReadOnly: true });
    expect(() => readHistoricalHomeIdentity(rows)).toThrow();
  });

  it("composes historical absence with strict current volume, lifecycle and unused-bootstrap authorization", () => {
    const proposal = emptyRootProposalSchema.parse(wire);
    const proof = proposal.unusedBootstrap!;
    const binding = {
      coderOrigin: proof.coderOrigin,
      hiveUserId: proof.hiveUserId,
      ownerId: proof.ownerId,
      workspaceId: proof.workspaceId,
      templateId: proof.templateId,
      buildId: proof.newBuildId,
      agentId: agent.id,
      appOrigin: "https://app.fixture.invalid",
      appId: randomUUID(),
      projects: [],
    };
    const historical = readHistoricalHomeIdentity(resources());
    const currentResources = resources();
    currentResources[7].id = randomUUID();
    currentResources[7].agents = [agent];
    const current = readEmptyRootResource(currentResources, binding.agentId);
    const identity = {
      lifetimeId: randomUUID(),
      configSha256: proof.newConfigSha256,
      packageManifestSha256: proof.newPackageManifestSha256,
      bindingDigest: "a".repeat(64),
      outerPublicKeyPem: "fixture-unused",
      guardianElfSha256: "b".repeat(64),
      nodeSha256: "c".repeat(64),
      policyDigest: "d".repeat(64),
      metadataPolicyDigest: "e".repeat(64),
    };
    const now = Date.now();
    const volume = {
      ...current,
      templateVersionId: randomUUID(),
      buildId: binding.buildId,
      lifetimeId: identity.lifetimeId,
      volumeDigest: guardianDigest(current.volume),
      observedAt: now,
    };
    const scope = {
      workspaceId: binding.workspaceId,
      oldBuildId: proof.oldBuildId,
      newBuildId: binding.buildId,
    };
    const history = [
      {
        id: proof.oldBuildId,
        workspace_id: binding.workspaceId,
        build_number: 3,
        transition: "start",
        status: "running",
        job: { status: "succeeded" },
      },
      {
        id: randomUUID(),
        workspace_id: binding.workspaceId,
        build_number: 4,
        transition: "stop",
        status: "stopped",
        job: { status: "succeeded" },
      },
      {
        id: binding.buildId,
        workspace_id: binding.workspaceId,
        build_number: 5,
        transition: "start",
        status: "running",
        job: { status: "succeeded" },
      },
    ];
    expect(verifyUnstartedCoderLifecycle(history, scope)).toBe(true);
    expect(
      verifyUnstartedCoderLifecycle(
        history.filter((row) => row.transition !== "stop"),
        scope,
      ),
    ).toBe(false);
    const source = { ...historical, oldBuildId: proof.oldBuildId };
    const anchor = authorizeUnusedBootstrapRoot(binding, proposal, volume, identity, source, now);
    expect(anchor.unusedBootstrapDigest).toBe(guardianDigest(proof));
    expect(anchor.currentVolume).toEqual(volume);
    for (const mutation of [
      { ...source, oldBuildId: randomUUID() },
      { ...source, identity: { ...source.identity, pvcUid: randomUUID() } },
      { ...source, observedBoundVolumeName: `pvc-${randomUUID()}` },
    ])
      expect(() =>
        authorizeUnusedBootstrapRoot(binding, proposal, volume, identity, mutation, now),
      ).toThrow();
  });
});
