import { randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { acceptanceProofPayload, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { DeliveryAcceptanceService } from "@/lib/delivery/acceptance-service.server";
import { AcceptanceStore } from "@/lib/delivery/acceptance-store.server";
import { RepositoryPolicyStore } from "@/lib/delivery/repository-policy-store.server";
import { guardianFixture } from "../codex-session/guardian-fixture";
import { acceptanceFixtureKey, acceptanceFixtureProducer } from "./acceptance-fixture";
import { githubFixture } from "./github-fixture";

const url = process.env.HIVE_ACCEPTANCE_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !(
      new URL(url).pathname.startsWith("/hive_acceptance_test") ||
      new URL(url).pathname === "/hive_delivery_test"
    ))
)
  throw new Error("Private local acceptance fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_acceptance_test",
});
afterAll(() => db.$disconnect());
async function fixture() {
  let policies: RepositoryPolicyStore | undefined;
  const store = new AcceptanceStore({
    enabled: true,
    encryptionKey: acceptanceFixtureKey,
    producer: acceptanceFixtureProducer,
    materializeReview: async () => {
      throw new Error("No candidate artifact in plan fixture");
    },
  });
  const originalIntent = "Guardian storage synthetic task; no account inference";
  const f = await guardianFixture(db, {
    beforeIntent: async ({ user, project, context }) => {
      const gates = githubFixture().policy;
      gates.checks[0].criterionIds = ["repo:ci"];
      if (gates.codexReview) gates.codexReview.criterionIds = ["repo:review"];
      policies = new RepositoryPolicyStore(db, {
        enabled: true,
        readCatalog: () => [
          {
            ownerId: user.id,
            repositoryId: "123",
            providerAccountId: "456",
            fullName: project.fullName,
            policy: {
              schemaVersion: 1,
              source: {
                version: "fixture-v1",
                authorName: "Fixture",
                authorEmail: "fixture@example.invalid",
                baseBranch: "main",
                allowedPrefixes: ["src"],
                maxFiles: 10,
                maxFileBytes: 1000,
                maxBytes: 10000,
              },
              evidenceGates: gates,
              acceptanceContracts: [],
            },
          },
        ],
        verifyRepository: async () => ({
          repositoryId: "123",
          providerAccountId: "456",
          fullName: project.fullName,
          defaultBranch: "main",
          defaultRevision: context.revision,
          archived: false,
          permissions: { pull: true, push: true },
        }),
      });
      const selection = await policies.enroll(user.id, project.id),
        current = policies;
      return db.$transaction((tx) =>
        current.pinIntent(
          tx,
          {
            ownerId: user.id,
            projectId: project.id,
            repositoryId: "123",
            providerAccountId: "456",
            sourceSha: context.revision,
            text: originalIntent,
          },
          selection,
        ),
      );
    },
    afterQueuedIntent: (payload, row) =>
      db.$transaction((tx) => store.captureIntent(tx, payload, row)),
  });
  if (!policies) throw new Error("Policy fixture unavailable");
  const service = new DeliveryAcceptanceService(db, store, {
    reauthorize: async (v) => v,
    policies,
    guardianPolicy: f.guardian.policy,
  });
  const envelope = (data: Record<string, unknown>) => {
    const value = {
      schemaVersion: 1,
      requestId: randomUUID(),
      registrationId: f.registration().id,
      serverInstanceId: f.serverInstanceId,
      managerThreadId: f.managerThreadId,
      checkoutBinding: f.context,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30000,
      ...data,
    };
    return {
      ...value,
      proof: sign(null, Buffer.from(acceptanceProofPayload(value)), f.keys.privateKey).toString(
        "base64url",
      ),
    };
  };
  return { ...f, store, service, envelope, originalIntent, policies };
}
describe.skipIf(!url)("signed independent acceptance service", () => {
  it("automatically claims the original-intent plan without manager task or model-selected policy", async () => {
    const f = await fixture();
    const reply = await f.service.dispatch(f.envelope({ action: "claim_acceptance" }));
    expect(reply.executionAuthorized).toBe(false);
    expect(reply.cleanupAuthorized).toBe(false);
    expect(reply.result).toMatchObject({
      phase: "leased",
      kind: "plan",
      payload: {
        originalIntent: f.originalIntent,
        intentDigest: requireIntentDigest(f.originalIntent),
      },
    });
    expect(await db.deliveryTask.count({ where: { ownerId: f.user.id } })).toBe(0);
    await expect(
      f.service.dispatch(f.envelope({ action: "claim_acceptance", model: "model-selected" })),
    ).rejects.toThrow();
    expect(
      (await f.service.dispatch(f.envelope({ action: "claim_acceptance" }))).result,
    ).toMatchObject({ phase: "reconcile" });
  });
  it("rejects foreign checkout, changed native lifetime and revoked pinned repository policy", async () => {
    const f = await fixture();
    await expect(
      f.service.dispatch(
        f.envelope({
          action: "claim_acceptance",
          checkoutBinding: { ...f.context, projectId: randomUUID() },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      f.service.dispatch(
        f.envelope({ action: "claim_acceptance", serverInstanceId: "other-server" }),
      ),
    ).rejects.toThrow();
    const intent = await db.projectTaskIntent.findUniqueOrThrow({
      where: { id: f.context.preparationIntentId },
    });
    if (!intent.repositoryPolicyVersionId) throw new Error("Expected policy pin");
    await f.policies.revokeVersion(f.user.id, f.project.id, intent.repositoryPolicyVersionId);
    await expect(f.service.dispatch(f.envelope({ action: "claim_acceptance" }))).rejects.toThrow();
    expect(
      await db.deliveryAcceptanceJob.count({ where: { ownerId: f.user.id, phase: "queued" } }),
    ).toBe(1);
  });
  it("rejects registration revocation before returning evaluator material", async () => {
    const f = await fixture();
    await db.codexHostRegistration.update({
      where: { id: f.registration().id },
      data: { revokedAt: new Date() },
    });
    await expect(f.service.dispatch(f.envelope({ action: "claim_acceptance" }))).rejects.toThrow();
    expect(
      await db.deliveryAcceptanceJob.count({ where: { ownerId: f.user.id, phase: "queued" } }),
    ).toBe(1);
  });
  it("serializes competing plan claims without creating two evaluator leases", async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.service.dispatch(f.envelope({ action: "claim_acceptance" })),
      f.service.dispatch(f.envelope({ action: "claim_acceptance" })),
    ]);
    expect(results.map((r) => (r.result as { phase: string }).phase).sort()).toEqual([
      "leased",
      "reconcile",
    ]);
    expect(
      await db.deliveryAcceptanceJob.count({ where: { ownerId: f.user.id, phase: "leased" } }),
    ).toBe(1);
  });
});
