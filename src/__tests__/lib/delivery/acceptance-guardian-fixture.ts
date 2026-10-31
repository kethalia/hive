import { randomUUID, sign } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { acceptanceProofPayload } from "@/lib/delivery/acceptance-contracts";
import { DeliveryAcceptanceService } from "@/lib/delivery/acceptance-service.server";
import { AcceptanceStore } from "@/lib/delivery/acceptance-store.server";
import { RepositoryPolicyStore } from "@/lib/delivery/repository-policy-store.server";
import { guardianFixture } from "../codex-session/guardian-fixture";
import { acceptanceFixtureKey, acceptanceFixtureProducer } from "./acceptance-fixture";
import { githubFixture } from "./github-fixture";

export async function acceptanceGuardianFixture(
  db: PrismaClient,
  materializeReview?: ConstructorParameters<typeof AcceptanceStore>[0]["materializeReview"],
  producer = acceptanceFixtureProducer,
  native: { managerThreadId?: string; parentTurnId?: string } = {},
) {
  let policies: RepositoryPolicyStore | undefined;
  const store = new AcceptanceStore({
    enabled: true,
    encryptionKey: acceptanceFixtureKey,
    producer,
    materializeReview:
      materializeReview ??
      (async () => {
        throw new Error("No candidate artifact in plan fixture");
      }),
  });
  const originalIntent = "Guardian storage synthetic task; no account inference";
  const f = await guardianFixture(db, {
    ...native,
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
