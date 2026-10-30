import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID, sign } from "node:crypto";
import type { DeliveryProject, PrismaClient, User } from "@hive/db";
import type { RegistrationBinding } from "@/lib/codex-session/registration.server";
import { PrismaRegistrationStore } from "@/lib/codex-session/registration-store.server";
import { DeliveryManagerService } from "@/lib/delivery/manager.server";
import type { ManagerCheckout } from "@/lib/delivery/manager-contracts";
import { managerProofPayload } from "@/lib/delivery/manager-contracts";
import { DeliveryNativeSourceService } from "@/lib/delivery/native.server";
import { nativeProofPayload } from "@/lib/delivery/native-contracts";

export interface NativeFixtureHooks {
  physical?: { revision: string; leaseId: string; leaseGeneration: number };
  beforeIntent?(scope: {
    user: User;
    project: DeliveryProject;
    host: RegistrationBinding;
    context: ManagerCheckout;
  }): Promise<{
    repositoryPolicyVersionId: string;
    repositoryPolicyDigest: string;
    intentTextDigest: string;
  }>;
  beforeRegister?(scope: {
    user: User;
    project: DeliveryProject;
    host: RegistrationBinding;
    keys: { publicKey: KeyObject; privateKey: KeyObject };
    serverInstanceId: string;
    context: ManagerCheckout;
  }): Promise<void>;
}
export async function nativeFixture(
  db: PrismaClient,
  managerThreadId: string = randomUUID(),
  hooks: NativeFixtureHooks = {},
) {
  const user = await db.user.create({
    data: {
      coderUrl: "https://fixture.invalid",
      coderUserId: randomUUID(),
      username: "native-fixture",
      email: "fixture@example.invalid",
    },
  });
  const project = await db.deliveryProject.create({
    data: {
      ownerId: user.id,
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "fixture/native",
    },
  });
  const keys = generateKeyPairSync("ed25519"),
    serverInstanceId = randomUUID();
  const host: RegistrationBinding = {
    coderOrigin: user.coderUrl,
    hiveUserId: user.id,
    ownerId: user.coderUserId,
    workspaceId: randomUUID(),
    buildId: randomUUID(),
    agentId: randomUUID(),
    templateId: randomUUID(),
    appOrigin: "https://fixture-app.invalid",
    appId: randomUUID(),
    projects: [{ projectId: project.id, repositoryId: "123" }],
  };
  const store = new PrismaRegistrationStore(db);
  let registrationId = "";
  async function register(server = serverInstanceId) {
    const id = randomUUID(),
      now = Math.floor(Date.now() / 1000),
      grantDigest = randomBytes(32).toString("hex");
    const generation = await store.reserve({ grantId: id, binding: host, expiresAt: now + 60 });
    await store.seal({ grantId: id, generation, grantDigest });
    if (
      !(await store.consumeAndRegister({
        grantId: id,
        grantDigest,
        expiresAt: now + 60,
        now,
        registration: {
          binding: host,
          serverInstanceId: server,
          protocolVersion: "0.165.0",
          threads: [{ projectId: project.id, repositoryId: "123", threadId: managerThreadId }],
          hostPublicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
          generation,
          registeredAt: now,
          expiresAt: now + 60,
        },
      }))
    )
      throw new Error("Fixture registration failed");
    registrationId = id;
    return id;
  }
  const context = {
    projectId: project.id,
    preparationIntentId: randomUUID(),
    repositoryId: "123",
    revision: "a".repeat(40),
    leaseId: randomUUID(),
    leaseGeneration: 1,
    ...hooks.physical,
  };
  const policyPin = await hooks.beforeIntent?.({ user, project, host, context });
  await db.projectTaskIntent.create({
    data: {
      ...policyPin,
      id: context.preparationIntentId,
      ownerId: user.id,
      projectId: project.id,
      workspaceId: host.workspaceId,
      requestId: randomUUID(),
      requestDigest: "a".repeat(64),
      repositoryId: "123",
      providerAccountId: "456",
      sourceSha: context.revision,
      phase: "running",
      status: {
        schemaVersion: 1,
        projectId: project.id,
        taskId: context.preparationIntentId,
        phase: "running",
        nativeThreadId: managerThreadId,
        terminalSessionName: null,
        reason: null,
      },
    },
  });
  await hooks.beforeRegister?.({ user, project, host, keys, serverInstanceId, context });
  await register();
  const policy = {
    version: "native-fixture-v1",
    trustedProducers: ["fixture-ci"],
    maxAgeMs: 60000,
  };
  const dependencies = {
    reauthorize: async (value: RegistrationBinding) => value,
    evidencePolicy: policy,
    allowedModelEfforts: [{ model: "gpt-6.1-sol", effort: "low" }],
  };
  const manager = new DeliveryManagerService(db, dependencies),
    native = new DeliveryNativeSourceService(db, dependencies);
  const taskId = randomUUID(),
    stepId = randomUUID(),
    parentTurnId = randomUUID();
  const definition = {
    id: taskId,
    outcome: "Native observer synthetic fixture",
    branch: "fixture",
    steps: [
      { id: stepId, kind: "validate", criterionIds: ["C1"], requiredEvidenceKinds: ["check"] },
    ],
  };
  function managerEnvelope(command: unknown, overrides = {}) {
    const value = {
      schemaVersion: 2,
      registrationId,
      serverInstanceId,
      managerThreadId,
      checkoutBinding: context,
      eventId: randomUUID(),
      nativeTurnId: parentTurnId,
      nativeCallId: randomUUID(),
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 30000,
      command,
      ...overrides,
    };
    return {
      ...value,
      proof: sign(null, Buffer.from(managerProofPayload(value)), keys.privateKey).toString(
        "base64url",
      ),
    };
  }
  async function create(definitionInput = definition) {
    return manager.execute(managerEnvelope({ operation: "create_task", payload: definitionInput }));
  }
  async function claim(task = taskId, step = stepId) {
    return (await manager.execute(
      managerEnvelope({
        operation: "claim_step",
        payload: {
          taskId: task,
          stepId: step,
          expectedVersion: 0,
          requestedModel: "gpt-6.1-sol",
          requestedEffort: "low",
        },
      }),
    )) as unknown as {
      attemptId: string;
      managerBindingId: string;
      leaseGeneration: number;
      version: number;
      nativeSequence: number;
    };
  }
  function sourceEnvelope(
    attempt: Awaited<ReturnType<typeof claim>>,
    source: unknown,
    sequence: number,
    overrides = {},
  ) {
    const value = {
      schemaVersion: 1,
      registrationId,
      serverInstanceId,
      managerThreadId,
      checkoutBinding: context,
      eventId: randomUUID(),
      taskId,
      stepId,
      attemptId: attempt.attemptId,
      managerBindingId: attempt.managerBindingId,
      leaseGeneration: attempt.leaseGeneration,
      sequence,
      source,
      issuedAt: Date.now() - 100,
      expiresAt: Date.now() + 30000,
      ...overrides,
    };
    return {
      ...value,
      proof: sign(null, Buffer.from(nativeProofPayload(value)), keys.privateKey).toString(
        "base64url",
      ),
    };
  }
  const source = {
    parentTurnId,
    spawnCallId: "spawn-fixture",
    childThreadId: randomUUID(),
    childTurnId: randomUUID(),
    observedAt: new Date(Date.now() - 100).toISOString(),
  };
  return {
    user,
    project,
    keys,
    host,
    context,
    policy,
    dependencies,
    manager,
    native,
    taskId,
    stepId,
    parentTurnId,
    definition,
    managerThreadId,
    serverInstanceId,
    register,
    registration: () => ({
      id: registrationId,
      serverInstanceId,
      expiresAt: Date.now() + 30000,
      threads: [{ projectId: project.id, threadId: managerThreadId }],
    }),
    managerEnvelope,
    sourceEnvelope,
    create,
    claim,
    source,
  };
}
