import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import type { CodexGuardianRuntime, PrismaClient } from "@hive/db";
import { expect, it, vi } from "vitest";

vi.mock("@/lib/delivery/epic-dependency.server", () => ({
  epicDependencyRelease: async () => ({ mergeSha: "e".repeat(40) }),
}));

import { closedTaskScope, submitEpicRelease } from "@/lib/delivery/epic-closure.server";
import { epicDigest } from "@/lib/delivery/epic-contracts";

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
it("issues an archive token only for the exact closed lease and retained source", async () => {
  const { privateKey } = generateKeyPairSync("ed25519"),
    pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const runtime = {
    id: u(1),
    ownerId: u(2),
    workspaceId: u(3),
    buildId: u(4),
    lifetimeId: u(5),
    closedBarrierId: u(6),
    phase: "tree_closed",
    serverInstanceId: "closed-native-server",
    binding: { ownerId: u(7) },
  } as unknown as CodexGuardianRuntime;
  const checkout = {
    projectId: u(8),
    preparationIntentId: u(9),
    repositoryId: "123",
    revision: "a".repeat(40),
    leaseId: u(10),
    leaseGeneration: 1,
    checkoutIncarnation: u(11),
    checkoutIdentity: { device: "12", inode: "13" },
  };
  const release = {
    schemaVersion: 1 as const,
    repositoryId: "123",
    taskId: u(9),
    leaseId: u(10),
    leaseGeneration: 1,
    revision: "b".repeat(40),
    checkoutIncarnation: u(11),
    checkoutIdentity: { device: "12", inode: "13" },
    releasedAt: Date.now(),
  };
  let query = 0,
    writes = 0,
    barrierPurpose = "completion",
    allocationBuild = u(4),
    successorConfig = "current-config";
  const db = {
    codexGuardianBarrier: {
      findUnique: async () => ({ purpose: barrierPurpose }),
    },
    codexGuardianAdmission: {
      findFirst: async () => ({
        checkoutBinding: checkout,
        preparationIntentId: u(9),
        intent: { requestId: u(12) },
      }),
    },
    deliveryTask: {
      findMany: async () => [
        {
          id: u(13),
          epicId: u(14),
          sourceSha: release.revision,
          managerBinding: {
            leaseId: u(10),
            leaseGeneration: 1,
            serverInstanceId: "closed-native-server",
            executionEpochVersion: 0,
            executionEpochRuntimeId: null,
            executionEpochEventId: null,
            executionEpochResumeEventId: null,
            buildId: u(4),
          },
        },
      ],
    },
    codexGuardianRuntime: {
      findMany: async () => [
        {
          ...runtime,
          configSha256: "current-config",
          packageManifestSha256: "current-package",
          outerPublicKeyPem: "current-key",
        },
      ],
    },
    $queryRaw: async (parts: TemplateStringsArray) => {
      if (parts.join("").includes("e.response,r.phase,r.build_id"))
        return [
          {
            phase: "authorization_retired",
            build_id: allocationBuild,
            response: {
              retirement: {
                newIdentity: {
                  lifetimeId: runtime.lifetimeId,
                  configSha256: successorConfig,
                  packageManifestSha256: "current-package",
                  outerPublicKeyPem: "current-key",
                },
              },
            },
          },
        ];
      query++;
      return query === 1
        ? [{ digest: "c".repeat(64) }]
        : query === 2
          ? [{ phase: "accepted" }]
          : query === 3
            ? [{ workspace_id: u(3), build_id: allocationBuild }]
            : query === 4
              ? [{ artifact_digest: "d".repeat(64) }]
              : [{ receipt_digest: epicDigest(release), runtime_id: u(1) }];
    },
    $executeRaw: async () => {
      writes++;
      return 1;
    },
  } as unknown as PrismaClient;
  const result = await submitEpicRelease(db, runtime, u(8), release, pem);
  const [encoded, signature] = result.token.split(".");
  expect(
    verify(
      null,
      Buffer.from(`hive-project-archive-v1\n${encoded}`),
      createPublicKey(privateKey),
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  expect(JSON.parse(Buffer.from(encoded, "base64url").toString())).toMatchObject({
    ownerId: u(7),
    hiveUserId: u(2),
    taskId: u(9),
    repositoryId: "123",
    leaseReleaseDigest: epicDigest(release),
  });
  // Unused retirement changes only the allocation's effective build. The
  // manager binding belongs to the first actual native actor on the new build.
  allocationBuild = u(44);
  query = 0;
  expect((await closedTaskScope(db, runtime, u(8))).task.managerBinding!.buildId).toBe(u(4));
  successorConfig = "foreign-config";
  query = 0;
  await expect(closedTaskScope(db, runtime, u(8))).rejects.toThrow("epic_task_unbound");
  allocationBuild = u(4);
  query = 0;
  await expect(
    submitEpicRelease(db, runtime, u(8), { ...release, leaseGeneration: 2 }, pem),
  ).rejects.toThrow("epic_release_scope_changed");
  barrierPurpose = "account-maintenance";
  query = 0;
  writes = 0;
  await expect(submitEpicRelease(db, runtime, u(8), release, pem)).rejects.toThrow(
    "epic_completion_closure_required",
  );
  expect(query).toBe(0);
  expect(writes).toBe(0);
});
