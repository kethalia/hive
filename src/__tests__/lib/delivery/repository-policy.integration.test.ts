import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { DeliveryRepository } from "@/lib/delivery/repository";
import {
  repositoryGateDescriptors,
  repositoryPolicyTextDigest,
} from "@/lib/delivery/repository-policy-contracts";
import { RepositoryPolicyStore } from "@/lib/delivery/repository-policy-store.server";
import { ProjectTaskIntents, type TaskIntentPayload } from "@/lib/projects/task-intents.server";
import { githubFixture } from "./github-fixture";

const url = process.env.HIVE_REPOSITORY_POLICY_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_delivery_test")
)
  throw new Error("Private local fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_delivery_test",
});
afterAll(() => db.$disconnect());
const intentText = "Implement the reviewed deterministic fixture.",
  outcome = "The dedicated acceptance check passes.",
  base = "a".repeat(40);
const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) =>
  db.$transaction(fn, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 10000,
  });
async function fixture() {
  const user = await db.user.create({
    data: {
      coderUrl: "https://fixture.invalid",
      coderUserId: randomUUID(),
      username: "policy-fixture",
      email: "fixture@example.invalid",
    },
  });
  const project = await db.deliveryProject.create({
    data: {
      ownerId: user.id,
      provider: "github",
      providerRepositoryId: "123",
      providerAccountId: "456",
      fullName: "fixture/policy",
    },
  });
  const legacy = await db.projectTaskIntent.create({
    data: {
      id: randomUUID(),
      ownerId: user.id,
      projectId: project.id,
      workspaceId: randomUUID(),
      requestId: randomUUID(),
      requestDigest: "a".repeat(64),
      repositoryId: "123",
      providerAccountId: "456",
      sourceSha: base,
    },
  });
  const evidenceGates = githubFixture().policy;
  evidenceGates.checks[0].criterionIds = ["repo:ci"];
  if (evidenceGates.codexReview) evidenceGates.codexReview.criterionIds = ["repo:review"];
  const policy = {
    schemaVersion: 1,
    source: {
      version: "source-v1",
      authorName: "Hive fixture",
      authorEmail: "fixture@example.invalid",
      baseBranch: "main",
      allowedPrefixes: ["src", "tests"],
      maxFiles: 10,
      maxFileBytes: 1000,
      maxBytes: 10000,
    },
    evidenceGates,
    acceptanceContracts: [
      {
        id: "narrow-fixture",
        intentTextDigest: repositoryPolicyTextDigest(intentText),
        taskOutcomeDigest: repositoryPolicyTextDigest(outcome),
        criteria: [
          {
            id: "C1",
            meaning: "A reviewed deterministic test proves exactly this fixture outcome.",
            kind: "check",
            evaluatorGateKeys: [
              repositoryGateDescriptors(evidenceGates).find((v) => v.kind === "check")?.key,
            ],
          },
        ],
      },
    ],
  };
  let catalog: unknown = [
    {
      ownerId: user.id,
      repositoryId: "123",
      providerAccountId: "456",
      fullName: project.fullName,
      policy,
    },
  ];
  const verified = {
    repositoryId: "123",
    providerAccountId: "456",
    fullName: project.fullName,
    defaultBranch: "main",
    defaultRevision: base,
    archived: false,
    permissions: { pull: true, push: true },
  };
  let observation: unknown = verified;
  const options = {
    enabled: true,
    readCatalog: () => catalog,
    verifyRepository: async () => observation,
  };
  const store = new RepositoryPolicyStore(db, options);
  const select = () => store.enroll(user.id, project.id);
  const selected = await select();
  async function intent(
    selection = selected,
    text = intentText,
    client?: Prisma.TransactionClient,
  ) {
    const insert = async (transaction: Prisma.TransactionClient) => {
      const pin = await store.pinIntent(
        transaction,
        {
          ownerId: user.id,
          projectId: project.id,
          repositoryId: "123",
          providerAccountId: "456",
          sourceSha: base,
          text,
        },
        selection,
      );
      const id = randomUUID(),
        workspaceId = randomUUID();
      await transaction.$executeRaw`INSERT INTO project_task_intents(id,owner_id,project_id,workspace_id,request_id,request_digest,repository_id,provider_account_id,source_sha,phase,updated_at,repository_policy_version_id,repository_policy_digest,intent_text_digest) VALUES(${id}::uuid,${user.id}::uuid,${project.id}::uuid,${workspaceId}::uuid,${randomUUID()}::uuid,${"a".repeat(64)},'123','456',${base},'running',clock_timestamp(),${pin.repositoryPolicyVersionId}::uuid,${pin.repositoryPolicyDigest},${pin.intentTextDigest})`;
      return { id, workspaceId, ...pin };
    };
    return client ? insert(client) : tx(insert);
  }
  async function task(existingIntent?: Awaited<ReturnType<typeof intent>>, criteria = ["C1"]) {
    const intentRow = existingIntent ?? (await intent());
    const conversation = await db.deliveryConversation.create({
      data: {
        ownerId: user.id,
        projectId: project.id,
        workspaceId: intentRow.workspaceId,
        nativeThreadId: randomUUID(),
        buildId: randomUUID(),
        serverInstanceId: randomUUID(),
      },
    });
    const binding = await db.deliveryManagerBinding.create({
      data: {
        id: randomUUID(),
        ownerId: user.id,
        projectId: project.id,
        preparationIntentId: intentRow.id,
        conversationId: conversation.id,
        workspaceId: intentRow.workspaceId,
        buildId: conversation.buildId,
        serverInstanceId: conversation.serverInstanceId,
        nativeThreadId: conversation.nativeThreadId,
        repositoryId: "123",
        sourceSha: base,
        leaseId: randomUUID(),
        leaseGeneration: 1,
        bindingDigest: githubSourceDigest(randomUUID()),
      },
    });
    const id = randomUUID(),
      stepId = randomUUID();
    const repository = new DeliveryRepository(db, undefined, undefined, undefined, undefined, (t) =>
      store.bindCreatedTask(t, user.id, id, intentRow.id).then(() => undefined),
    );
    await repository.createTask(user.id, {
      schemaVersion: 1,
      eventId: randomUUID(),
      id,
      projectId: project.id,
      conversationId: conversation.id,
      managerBindingId: binding.id,
      outcome,
      branch: "fixture",
      sourceSha: base,
      steps: [
        { id: stepId, kind: "implement", criterionIds: criteria, requiredEvidenceKinds: ["check"] },
      ],
      dependencies: [],
    });
    return {
      id,
      stepId,
      binding,
      intent: intentRow,
      resolve: () => tx((t) => store.resolveTask(t, user.id, id)),
    };
  }
  return {
    user,
    project,
    legacy,
    policy,
    store,
    selected,
    select,
    intent,
    task,
    options,
    setCatalog: (v: unknown) => {
      catalog = v;
    },
    setObservation: (v: unknown) => {
      observation = v;
    },
    verified,
  };
}

describe.skipIf(!url)("immutable repository policy enrollment on local PostgreSQL", () => {
  it("pins verified stable identity before intent and atomically binds model task without task UUID policy maps", async () => {
    const f = await fixture(),
      task = await f.task(),
      resolved = await task.resolve();
    expect(resolved?.binding.policyVersionId).toBe(f.selected.versionId);
    expect(resolved?.projection.pendingRequirements).toEqual([
      {
        stepId: task.stepId,
        criterionId: "C1",
        kind: "check",
        reason: "acceptance_evaluator_provenance_pending",
      },
    ]);
    expect(resolved?.projection.compiledEvidencePolicy.checks[0].criterionIds).toEqual(["repo:ci"]);
    expect(resolved?.projection.compiledEvidencePolicy.codexReview?.criterionIds).toEqual([
      "repo:review",
    ]);
    expect((await f.select()).versionId).toBe(f.selected.versionId);
  });
  it("owner enqueue commits encrypted intent and policy pin together, keeps replay pin, and rolls back on revoke", async () => {
    const f = await fixture();
    const taskId = randomUUID(),
      requestId = randomUUID(),
      workspaceId = randomUUID();
    const payload: TaskIntentPayload = {
      ownerId: f.user.id,
      projectId: f.project.id,
      workspaceId,
      taskId,
      requestId,
      requestDigest: "a".repeat(64),
      hostRequest: {
        schemaVersion: 1,
        projectId: f.project.id,
        repositoryId: "123",
        expectedAccountId: "456",
        taskId,
        requestId,
        revision: base,
        model: "fixture",
        effort: "low",
        text: intentText,
      },
    };
    const intents = new ProjectTaskIntents(db, "a".repeat(64), (t, input) =>
      f.store.pinIntent(
        t,
        {
          ownerId: input.ownerId,
          projectId: input.projectId,
          repositoryId: input.hostRequest.repositoryId,
          providerAccountId: input.hostRequest.expectedAccountId,
          sourceSha: input.hostRequest.revision,
          text: input.hostRequest.text,
        },
        f.selected,
      ),
    );
    const inserted = await Promise.all([intents.enqueue(payload), intents.enqueue(payload)]);
    expect(new Set(inserted.map((v) => v.id))).toEqual(new Set([taskId]));
    expect(inserted[0].repositoryPolicyVersionId).toBe(f.selected.versionId);
    expect(inserted[0].intentTextDigest).toBe(repositoryPolicyTextDigest(intentText));
    expect(inserted[0].ciphertext?.length).toBeGreaterThan(0);
    await f.store.revokeVersion(f.user.id, f.project.id, f.selected.versionId);
    // Historical request acknowledgement is factual, not fresh execution authority.
    expect((await intents.enqueue(payload)).repositoryPolicyVersionId).toBe(f.selected.versionId);
    await expect(tx((t) => f.store.authorizeIntent(t, f.user.id, taskId))).rejects.toThrow(
      "repository_policy_revoked",
    );
    const otherId = randomUUID(),
      otherRequest = randomUUID();
    await expect(
      intents.enqueue({
        ...payload,
        taskId: otherId,
        requestId: otherRequest,
        hostRequest: { ...payload.hostRequest, taskId: otherId, requestId: otherRequest },
      }),
    ).rejects.toThrow("repository_policy_revoked");
    expect(await db.projectTaskIntent.findUnique({ where: { id: otherId } })).toBeNull();
  });
  it("new active versions apply only to new intents; old task keeps full immutable digest", async () => {
    const f = await fixture(),
      task = await f.task();
    const next = structuredClone(f.policy);
    next.source.maxFiles++;
    f.setCatalog([
      {
        ownerId: f.user.id,
        repositoryId: "123",
        providerAccountId: "456",
        fullName: f.project.fullName,
        policy: next,
      },
    ]);
    const selected = await f.select();
    expect(selected.versionId).not.toBe(f.selected.versionId);
    await expect(f.intent()).rejects.toThrow("repository_policy_selection_changed");
    expect((await f.intent(selected)).repositoryPolicyVersionId).toBe(selected.versionId);
    expect((await task.resolve())?.binding.policyDigest).toBe(f.selected.policyDigest);
  });
  it("revocation fences old task and feature disable cannot restore weaker legacy task maps", async () => {
    const f = await fixture(),
      task = await f.task();
    const disabled = new RepositoryPolicyStore(db, { ...f.options, enabled: false });
    await expect(tx((t) => disabled.resolveTask(t, f.user.id, task.id))).rejects.toThrow(
      "repository_policy_disabled",
    );
    await f.store.revokeVersion(f.user.id, f.project.id, f.selected.versionId);
    await expect(task.resolve()).rejects.toThrow("repository_policy_revoked");
    await expect(f.intent()).rejects.toThrow("repository_policy_revoked");
    await expect(f.select()).rejects.toThrow("repository_policy_revoked");
  });
  it("flag-off cannot create a new legacy task or reuse a pre-enrollment intent in an enrolled repository", async () => {
    const f = await fixture(),
      disabled = new RepositoryPolicyStore(db, { ...f.options, enabled: false });
    await expect(tx((t) => disabled.authorizeIntent(t, f.user.id, f.legacy.id))).rejects.toThrow(
      "repository_policy_intent_unbound",
    );
    await expect(
      db.projectTaskIntent.create({
        data: {
          id: randomUUID(),
          ownerId: f.user.id,
          projectId: f.project.id,
          workspaceId: randomUUID(),
          requestId: randomUUID(),
          requestDigest: "a".repeat(64),
          repositoryId: "123",
          providerAccountId: "456",
          sourceSha: base,
        },
      }),
    ).rejects.toThrow("unbound intent");
    const task = await db.deliveryTask.create({
      data: {
        ownerId: f.user.id,
        projectId: f.project.id,
        outcome,
        sourceSha: base,
        branch: "legacy-fixture",
      },
    });
    await expect(tx((t) => disabled.resolveTask(t, f.user.id, task.id))).rejects.toThrow(
      "repository_policy_task_unbound",
    );
    expect(
      await db.deliveryTaskPolicyBinding.count({ where: { ownerId: f.user.id, taskId: task.id } }),
    ).toBe(0);
  });
  it("missing semantic evaluator is persisted pending and cannot remove mandatory repository gates", async () => {
    const f = await fixture(),
      task = await f.task(undefined, ["C999"]),
      value = await task.resolve();
    expect(value?.projection.pendingRequirements).toEqual([
      {
        stepId: task.stepId,
        criterionId: "C999",
        kind: "check",
        reason: "acceptance_evaluator_unavailable",
      },
    ]);
    expect(value?.projection.compiledEvidencePolicy).toEqual(f.policy.evidenceGates);
  });
  it("owner/account drift and nondefault ref fail closed instead of borrowing verified catalog identity", async () => {
    const f = await fixture();
    f.setObservation({ ...f.verified, providerAccountId: "457" });
    await expect(f.select()).rejects.toThrow("repository_policy_identity_changed");
    const g = await fixture(),
      policy = structuredClone(g.policy);
    policy.source.baseBranch = "codex/epic";
    g.setCatalog([
      {
        ownerId: g.user.id,
        repositoryId: "123",
        providerAccountId: "456",
        fullName: g.project.fullName,
        policy,
      },
    ]);
    const selection = await g.select();
    await expect(g.intent(selection)).rejects.toThrow("repository_policy_ref_resolution_pending");
    const task = await f.task();
    await db.deliveryProject.update({
      where: { id: f.project.id },
      data: { providerAccountId: "458" },
    });
    await expect(task.resolve()).rejects.toThrow("repository_policy_identity_changed");
  });
  it("SQL rejects unbound adoption, pin partial nulls, mutable versions/bindings and cross-owner references", async () => {
    const f = await fixture(),
      task = await f.task(),
      other = await fixture();
    for (const work of [
      () =>
        db.$executeRaw`UPDATE project_task_intents SET intent_text_digest=NULL WHERE id=${task.intent.id}::uuid`,
      () =>
        db.$executeRaw`UPDATE delivery_repository_policy_versions SET source_policy='{}'::jsonb WHERE id=${f.selected.versionId}::uuid`,
      () =>
        db.$executeRaw`UPDATE delivery_task_policy_bindings SET outcome_digest=${"f".repeat(64)} WHERE owner_id=${f.user.id}::uuid AND task_id=${task.id}::uuid`,
      () =>
        db.$executeRaw`UPDATE delivery_repository_policies SET active_version_id=${other.selected.versionId}::uuid,generation=generation+1 WHERE owner_id=${f.user.id}::uuid AND project_id=${f.project.id}::uuid`,
      () =>
        db.$executeRaw`DELETE FROM delivery_repository_policy_versions WHERE id=${f.selected.versionId}::uuid`,
    ])
      await expect(work()).rejects.toThrow();
    const existing = f.legacy;
    await expect(
      db.$executeRaw`UPDATE project_task_intents SET repository_policy_version_id=${f.selected.versionId}::uuid,repository_policy_digest=${f.selected.policyDigest},intent_text_digest=${repositoryPolicyTextDigest(intentText)} WHERE id=${existing.id}::uuid`,
    ).rejects.toThrow();
  });
  it("concurrent enrollment serializes one immutable version and revocation wins a stale writer snapshot", async () => {
    const f = await fixture(),
      task = await f.task();
    const selections = await Promise.all([f.select(), f.select(), f.select()]);
    expect(new Set(selections.map((v) => v.versionId))).toEqual(new Set([f.selected.versionId]));
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>((r) => {
        locked = r;
      }),
      go = new Promise<void>((r) => {
        release = r;
      });
    const revoke = tx(async (t) => {
      await t.$queryRaw`SELECT id FROM delivery_repository_policies WHERE owner_id=${f.user.id}::uuid AND project_id=${f.project.id}::uuid FOR UPDATE`;
      locked();
      await go;
      await t.$executeRaw`UPDATE delivery_repository_policy_versions SET revoked_at=clock_timestamp() WHERE id=${f.selected.versionId}::uuid`;
    });
    await acquired;
    const stale = tx(async (t) => {
      await t.deliveryTask.findUniqueOrThrow({ where: { id: task.id } });
      release();
      return f.store.resolveTask(t, f.user.id, task.id);
    });
    await revoke;
    await expect(stale).rejects.toThrow();
    await expect(task.resolve()).rejects.toThrow("repository_policy_revoked");
  });
});
