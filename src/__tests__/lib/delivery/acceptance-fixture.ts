import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { type AcceptanceProducer, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import {
  ACCEPTANCE_PROMPT_DIGEST,
  ACCEPTANCE_SCHEMA_DIGEST,
} from "@/lib/delivery/acceptance-prompts";
import { type AcceptanceAuthority, AcceptanceStore } from "@/lib/delivery/acceptance-store.server";
import { RepositoryPolicyStore } from "@/lib/delivery/repository-policy-store.server";
import { ProjectTaskIntents, type TaskIntentPayload } from "@/lib/projects/task-intents.server";
import { githubFixture } from "./github-fixture";

export const acceptanceFixtureProducer: AcceptanceProducer = {
  schemaVersion: 1,
  codeDigest: "a".repeat(64),
  promptDigest: ACCEPTANCE_PROMPT_DIGEST,
  schemaDigest: ACCEPTANCE_SCHEMA_DIGEST,
  permissionsDigest: "5cb0236664ba9833dc964200828cc6b650583eb0b7d2bd43d587889c5a9b175b",
  runtimeVersion: "0.165.0",
  model: "fixture-evaluator",
  effort: "low",
  maxDurationMs: 30000,
  maxInputBytes: 262144,
  maxOutputBytes: 65536,
};
export const acceptanceFixtureKey = "12".repeat(32);
export async function acceptanceFixture(db: PrismaClient) {
  const user = await db.user.create({
    data: {
      coderUrl: "https://acceptance.invalid",
      coderUserId: randomUUID(),
      username: "acceptance-fixture",
      email: "acceptance@example.invalid",
    },
  });
  const project = await db.deliveryProject.create({
    data: {
      ownerId: user.id,
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "fixture/acceptance",
    },
  });
  const gates = githubFixture().policy;
  gates.checks[0].criterionIds = ["repo:ci"];
  if (gates.codexReview) gates.codexReview.criterionIds = ["repo:review"];
  const policy = {
    schemaVersion: 1,
    source: {
      version: "source-fixture",
      authorName: "Fixture",
      authorEmail: "fixture@example.invalid",
      baseBranch: "main",
      allowedPrefixes: ["src", "tests"],
      maxFiles: 10,
      maxFileBytes: 1000,
      maxBytes: 10000,
    },
    evidenceGates: gates,
    acceptanceContracts: [],
  };
  const policies = new RepositoryPolicyStore(db, {
    enabled: true,
    readCatalog: () => [
      {
        ownerId: user.id,
        repositoryId: "123",
        providerAccountId: "456",
        fullName: project.fullName,
        policy,
      },
    ],
    verifyRepository: async () => ({
      repositoryId: "123",
      providerAccountId: "456",
      fullName: project.fullName,
      defaultBranch: "main",
      defaultRevision: "a".repeat(40),
      archived: false,
      permissions: { pull: true, push: true },
    }),
  });
  const selection = await policies.enroll(user.id, project.id);
  const store = new AcceptanceStore({
    enabled: true,
    encryptionKey: acceptanceFixtureKey,
    producer: acceptanceFixtureProducer,
    materializeReview: async () => {
      throw new Error("Fixture review material unavailable");
    },
  });
  const intents = new ProjectTaskIntents(
    db,
    acceptanceFixtureKey,
    (tx, input) =>
      policies.pinIntent(
        tx,
        {
          ownerId: input.ownerId,
          projectId: input.projectId,
          repositoryId: input.hostRequest.repositoryId,
          providerAccountId: input.hostRequest.expectedAccountId,
          sourceSha: input.hostRequest.revision,
          text: input.hostRequest.text,
        },
        selection,
      ),
    (tx, input, row) => store.captureIntent(tx, input, row),
  );
  const taskId = randomUUID(),
    requestId = randomUUID();
  const input: TaskIntentPayload = {
    ownerId: user.id,
    projectId: project.id,
    workspaceId: randomUUID(),
    taskId,
    requestId,
    requestDigest: "e".repeat(64),
    hostRequest: {
      schemaVersion: 1,
      projectId: project.id,
      repositoryId: "123",
      expectedAccountId: "456",
      taskId,
      requestId,
      revision: "a".repeat(40),
      model: "fixture-manager",
      effort: "low",
      text: "Reject negative integer parser input. Preserve existing positive input behavior.",
    },
  };
  const row = await intents.enqueue(input);
  const authority: AcceptanceAuthority = {
    ownerId: user.id,
    projectId: project.id,
    preparationIntentId: taskId,
    registrationId: randomUUID(),
    serverInstanceId: "fixture-server",
    managerThreadId: "fixture-manager-thread",
    producer: {
      runtimeId: randomUUID(),
      runtimeGeneration: 1,
      admissionId: randomUUID(),
      admissionGeneration: 3,
      producerDigest: "f".repeat(64),
      checkoutIncarnation: randomUUID(),
      barrierGeneration: 0,
    },
  };
  const transaction = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(fn, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000,
    });
  const plan = {
    schemaVersion: 1 as const,
    kind: "plan" as const,
    intentDigest: requireIntentDigest(input.hostRequest.text),
    outcome: "ready" as const,
    requirements: [
      {
        id: "acceptance:negative",
        meaning: "Reject negative integer input",
        phase: "implementation_preview" as const,
        intentRanges: [{ start: 0, end: 36 }],
        verification: "Inspect parser and boundary tests.",
      },
      {
        id: "acceptance:compatibility",
        meaning: "Preserve positive input behavior",
        phase: "implementation_preview" as const,
        intentRanges: [{ start: 37, end: Buffer.byteLength(input.hostRequest.text) }],
        verification: "Inspect compatibility checks.",
      },
    ],
    unresolved: [],
    rationale: "Complete owner-intent requirements.",
  };
  return { user, project, policies, store, intents, input, row, authority, transaction, plan };
}
