import { randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { lockProducerAdmission } from "@/lib/codex-session/guardian-store.server";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import { SourcePublicationTransport } from "@/lib/delivery/source-transport.server";
import { sourceTransportProofPayload } from "@/lib/delivery/source-transport-contracts";
import { guardianFixture } from "../codex-session/guardian-fixture";

const url = process.env.HIVE_DELIVERY_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== "/hive_delivery_test"
  )
    throw new Error("Isolated local guardian fixture only");
}
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const f = await guardianFixture(db);
  vi.stubEnv("HIVE_GUARDIAN_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_PRODUCER_ENABLED", "true");
  vi.stubEnv("HIVE_GUARDIAN_APPROVED_PACKAGES_JSON", JSON.stringify(f.guardian.policy.packages));
  const manager = new DeliveryManagerService(db, { ...f.dependencies, progressionProtocol: 1 });
  await manager.execute(
    f.managerEnvelope({
      operation: "create_task",
      payload: {
        ...f.definition,
        steps: [
          {
            id: f.stepId,
            kind: "implement",
            criterionIds: ["C1"],
            requiredEvidenceKinds: ["check"],
          },
        ],
      },
    }),
  );
  const claim = z
    .object({
      attemptId: z.string(),
      managerBindingId: z.string(),
      leaseGeneration: z.number(),
      version: z.number(),
      nativeSequence: z.number(),
    })
    .parse(
      await manager.execute(
        f.managerEnvelope({
          operation: "claim_step",
          payload: {
            taskId: f.taskId,
            stepId: f.stepId,
            expectedVersion: 0,
            requestedModel: "gpt-6.1-sol",
            requestedEffort: "low",
          },
        }),
      ),
    );
  await f.native.ingest(
    f.sourceEnvelope(
      claim,
      {
        ...f.source,
        kind: "started",
        requestedModel: "gpt-6.1-sol",
        requestedEffort: "low",
        effectiveModel: "gpt-6.1-sol",
        effectiveEffort: "low",
      },
      1,
    ),
  );
  await f.native.ingest(
    f.sourceEnvelope(claim, { ...f.source, kind: "turn_completed", status: "completed" }, 2),
  );
  const policy = {
      version: "local-guardian-source",
      authorName: "Hive",
      authorEmail: "codex@kethalia.com",
      baseBranch: "main",
      allowedPrefixes: ["src"],
      maxFiles: 5,
      maxFileBytes: 1024,
      maxBytes: 4096,
    },
    manifest = {
      files: [
        {
          path: "src/change.ts",
          contentDigest: "c".repeat(64),
          size: 10,
          mode: "100644",
          blobSha: "f".repeat(40),
        },
      ],
      deletions: [],
    };
  let uploadHook = async () => {},
    objects = 0;
  const dependencies = {
    reauthorize: f.dependencies.reauthorize,
    resolvePolicy: () => policy,
    lockProducerAdmission: (
      tx: Parameters<typeof lockProducerAdmission>[0],
      scope: Parameters<typeof lockProducerAdmission>[1],
    ) => lockProducerAdmission(tx, scope, f.guardian.policy),
  };
  const artifacts = {
    writeAndVerify: async (_key: string, bytes: Uint8Array, digest: string) => {
      objects++;
      await uploadHook();
      return { contentDigest: digest, size: bytes.byteLength };
    },
  };
  const service = new SourcePublicationTransport(db, dependencies, artifacts);
  function envelope(phase: "policy" | "challenge" | "publish", extra: Record<string, unknown>) {
    const body = {
      schemaVersion: 1,
      action: "publish_source_revision",
      registrationId: f.registration().id,
      serverInstanceId: f.serverInstanceId,
      managerThreadId: f.managerThreadId,
      checkoutBinding: f.context,
      taskId: f.taskId,
      stepId: f.stepId,
      attemptId: claim.attemptId,
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 30000,
      ...extra,
    };
    return {
      ...body,
      proof: sign(
        null,
        Buffer.from(sourceTransportProofPayload(phase, body)),
        f.keys.privateKey,
      ).toString("base64url"),
    };
  }
  async function prepare() {
    const operationId = randomUUID(),
      grant = await service.issue(
        envelope("challenge", {
          requestId: randomUUID(),
          operationId,
          policyDigest: githubSourceDigest(policy),
          manifest,
          target: {
            headSha: "b".repeat(40),
            treeSha: "d".repeat(40),
            manifestDigest: githubSourceDigest(manifest),
          },
        }),
      );
    const publish = envelope("publish", {
      challengeId: grant.id,
      nonce: grant.nonce,
      readback: {
        observedAt: new Date().toISOString(),
        providerAccountId: grant.providerAccountId,
        repositoryId: grant.repositoryId,
        fullName: grant.fullName,
        manifest,
        commit: {
          sha: grant.target.headSha,
          treeSha: grant.target.treeSha,
          parentSha: grant.parentSha,
        },
        reference: {
          name: `refs/heads/${grant.branch}`,
          sha: grant.target.headSha,
          type: "commit",
        },
        pullRequest: {
          id: "901",
          number: 8,
          headRepositoryId: grant.repositoryId,
          baseRepositoryId: grant.repositoryId,
          headRef: grant.branch,
          headSha: grant.target.headSha,
          baseRef: grant.policy.baseBranch,
          state: "open",
          draft: true,
        },
      },
    });
    return { grant, publish };
  }
  return {
    ...f,
    service,
    dependencies,
    artifacts,
    claim,
    prepare,
    envelope,
    onUpload: (fn: () => Promise<void>) => {
      uploadHook = fn;
    },
    get objects() {
      return objects;
    },
  };
}
describe.skipIf(!url)(
  "source issuer with real staged guardian store (local authorization/pin fixtures, synthetic native/provider)",
  () => {
    it("publishes only under finalized persisted runtime/admission and preserves exact replay", async () => {
      const f = await fixture(),
        p = await f.prepare();
      expect(p.grant.admission).toMatchObject({
        runtimeId: f.guardian.runtime.id,
        admissionId: f.guardian.bound.admission.id,
        checkoutIncarnation: f.guardian.checkout.checkoutIncarnation,
        runtimeGeneration: 2,
        admissionGeneration: 3,
      });
      const accepted = await f.service.publish(p.publish),
        replay = await f.service.publish(p.publish);
      expect(accepted.sourceContext.headSha).toBe("b".repeat(40));
      expect(replay).toMatchObject({
        sourceContext: accepted.sourceContext,
        replayed: true,
        executionAuthorized: false,
      });
      expect(await db.deliverySourceRevision.count({ where: { ownerId: f.user.id } })).toBe(1);
      const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: f.claim.managerBindingId },
      });
      expect(binding.activeAttemptId).toBe(f.claim.attemptId);
    });
    it("observes persisted producer revocation after upload without consuming or releasing physical writer", async () => {
      const f = await fixture(),
        p = await f.prepare();
      f.onUpload(async () => {
        await db.codexGuardianRuntime.update({
          where: { id: f.guardian.runtime.id },
          data: { producerApproved: false },
        });
      });
      await expect(f.service.publish(p.publish)).rejects.toThrow();
      expect(f.objects).toBe(1);
      expect(await db.deliverySourceRevision.count({ where: { ownerId: f.user.id } })).toBe(0);
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "source_publication_consumed" },
        }),
      ).toBe(0);
      expect(
        await db.deliveryEvent.count({
          where: { ownerId: f.user.id, type: "source_publication_proof_reserved" },
        }),
      ).toBe(1);
      const binding = await db.deliveryManagerBinding.findUniqueOrThrow({
        where: { id: f.claim.managerBindingId },
      });
      expect(binding.activeAttemptId).toBe(f.claim.attemptId);
      const runtime = await db.codexGuardianRuntime.findUniqueOrThrow({
        where: { id: f.guardian.runtime.id },
      });
      expect(runtime.phase).toBe("open");
      expect(runtime.closedBarrierId).toBeNull();
    });
    it("cannot substitute a live registration for disabled independent producer authority", async () => {
      const f = await fixture();
      const disabled = new SourcePublicationTransport(
        db,
        {
          ...f.dependencies,
          lockProducerAdmission: (tx, scope) =>
            lockProducerAdmission(tx, scope, { ...f.guardian.policy, producerEnabled: false }),
        },
        f.artifacts,
      );
      await expect(
        disabled.policy(
          f.envelope("policy", { requestId: randomUUID(), operationId: randomUUID() }),
        ),
      ).rejects.toThrow();
      expect(f.objects).toBe(0);
    });
  },
);
