import { createHash } from "node:crypto";
import { getDb, type Prisma } from "@hive/db";
import { z } from "zod";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { provisionRegisteredHost } from "@/lib/codex-session/bootstrap-delivery.server";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { createGuardianService } from "@/lib/codex-session/guardian-factory.server";
import type { GuardianProvisionStage } from "@/lib/codex-session/guardian-service.server";
import {
  createRegisteredSessionService,
  registeredSessionConfig,
} from "@/lib/codex-session/registered-session.server";
import { acceptanceServices } from "@/lib/delivery/acceptance-factory.server";
import { ProjectDiscoveryError } from "./errors";
import { type ProjectPrincipal, signedHostProjectRequest } from "./host.server";
import { resolvedRepositorySchema } from "./session-contracts";
import { resolveProjectSourceBase } from "./source-base.server";
import {
  type projectTaskFailureStageSchema,
  projectTaskReadSchema,
  projectTaskStartSchema,
  projectTaskStatusSchema,
} from "./task-contracts";
import {
  ProjectTaskIntents,
  pendingTaskStatus,
  reconcileTaskIntents,
  TaskExecutionStageError,
  TaskIntentConflict,
  taskRequestDigest,
} from "./task-intents.server";
import { recoveryInspectionSchema, recoveryScopeSchema } from "./task-recovery-contracts";
import { ProjectTaskRecoveries } from "./task-recovery-store.server";

export class ProjectTaskConflict extends Error {}
/** Deterministic UUIDv5 namespace: retries of the same owner/project/request refer
 * to the same intent. The host journal additionally checks the complete payload. */
export function projectTaskId(ownerId: string, projectId: string, requestId: string) {
  const hash = createHash("sha1")
    .update(Buffer.from("369ec1f59e0e41dfbf8c60f60eb9e13e", "hex"))
    .update(JSON.stringify([ownerId, projectId, requestId]))
    .digest();
  hash[6] = (hash[6] & 15) | 0x50;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function ownedProject(user: ProjectPrincipal, projectId: string) {
  z.string().uuid().parse(projectId);
  const project = await getDb().deliveryProject.findUnique({
    where: { ownerId_id: { ownerId: user.id, id: projectId } },
    include: { repositoryPolicy: { select: { id: true } } },
  });
  if (!project || project.provider !== "github")
    throw new ProjectDiscoveryError("workspace_forbidden");
  return project;
}
function status(value: unknown, projectId: string, taskId: string) {
  const result = projectTaskStatusSchema.safeParse(value);
  if (
    !result.success ||
    result.data.failureStage !== undefined ||
    result.data.projectId !== projectId ||
    result.data.taskId !== taskId
  )
    throw new ProjectDiscoveryError("github_invalid_response");
  return result.data;
}
export type TaskStartStage =
  | "validation"
  | "project"
  | "existing_intent"
  | "repository"
  | "source_base"
  | "runtime_policy"
  | "intent_store"
  | "policy_enrollment"
  | "enqueue";

export type TaskRecoveryStage =
  | GuardianProvisionStage
  | "guardian_recovery_resolve"
  | "guardian_recovery_ticket"
  | "guardian_recovery_predecessor"
  | "recovery_project"
  | "recovery_policy"
  | "recovery_snapshot"
  | "recovery_begin"
  | "recovery_continuity"
  | "recovery_inspect"
  | "recovery_identity"
  | "recovery_authorize"
  | "recovery_consume"
  | "recovery_finish"
  | "recovery_legacy";

export async function startProjectTask(
  user: ProjectPrincipal,
  projectId: string,
  value: unknown,
  onStage?: (stage: TaskStartStage) => void,
) {
  onStage?.("validation");
  const input = projectTaskStartSchema.parse(value);
  onStage?.("project");
  const project = await ownedProject(user, projectId);
  const taskId = projectTaskId(user.id, projectId, input.requestId);
  const requestDigest = taskRequestDigest([
    user.id,
    projectId,
    input.workspaceId,
    input.requestId,
    input.expectedRevision,
    input.text,
  ]);
  // An accepted request remains accepted even if main advances before its lost
  // acknowledgement is retried. The durable intent, not a fresh HEAD, owns replay.
  onStage?.("existing_intent");
  const existing = await getDb().projectTaskIntent.findUnique({
    where: { ownerId_id: { ownerId: user.id, id: taskId } },
  });
  if (existing) {
    if (
      existing.projectId !== projectId ||
      existing.workspaceId !== input.workspaceId ||
      existing.requestId !== input.requestId ||
      existing.requestDigest !== requestDigest
    )
      throw new TaskIntentConflict("task_identity_conflict");
    return pendingTaskStatus(existing);
  }
  onStage?.("repository");
  const parsedRepository = resolvedRepositorySchema.safeParse(
    await signedHostProjectRequest(user, input.workspaceId, "/projects/resolve", {
      schemaVersion: 1,
      repositoryId: project.providerRepositoryId,
      expectedAccountId: project.providerAccountId,
    }),
  );
  if (!parsedRepository.success) throw new ProjectDiscoveryError("github_invalid_response");
  const resolved = parsedRepository.data;
  if (
    resolved.providerAccountId !== project.providerAccountId ||
    resolved.repository.providerRepositoryId !== project.providerRepositoryId
  )
    throw new ProjectDiscoveryError("github_invalid_response");
  if (resolved.repository.archived || resolved.repository.permissions.push !== true)
    throw new ProjectDiscoveryError("github_permission_denied");
  onStage?.("source_base");
  const sourceBase = await resolveProjectSourceBase(user, input.workspaceId, resolved);
  if (sourceBase.revision !== input.expectedRevision)
    throw new ProjectTaskConflict("source_changed");
  // Runtime policy is deployment-owned. Models cannot promote themselves through
  // browser fields, and absent policy disables task execution.
  onStage?.("runtime_policy");
  const model = z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
    .safeParse(process.env.HIVE_CODEX_MANAGER_MODEL);
  const effort = z
    .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
    .safeParse(process.env.HIVE_CODEX_MANAGER_EFFORT);
  if (!model.success || !effort.success) throw new Error("Manager runtime policy is unavailable");
  onStage?.("intent_store");
  let store = taskIntentStore();
  if (process.env.HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED !== "true" && project.repositoryPolicy) {
    const { DeliveryConflict } = await import("@/lib/delivery/state");
    throw new DeliveryConflict("repository_policy_disabled");
  }
  if (process.env.HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED === "true") {
    const { repositoryPolicyStore } = await import("@/lib/delivery/repository-policy.server");
    const policies = repositoryPolicyStore(getDb(), async () => ({
      repositoryId: resolved.repository.providerRepositoryId,
      providerAccountId: resolved.providerAccountId,
      fullName: resolved.repository.fullName,
      defaultBranch: resolved.repository.defaultBranch,
      defaultRevision: resolved.defaultRevision,
      resolvedBase: sourceBase,
      archived: resolved.repository.archived,
      permissions: {
        pull: resolved.repository.permissions.pull,
        push: resolved.repository.permissions.push,
      },
    }));
    onStage?.("policy_enrollment");
    const selected = await policies.enroll(user.id, projectId);
    store = taskIntentStore((tx, payload) =>
      policies.pinIntent(
        tx,
        {
          ownerId: payload.ownerId,
          projectId: payload.projectId,
          repositoryId: payload.hostRequest.repositoryId,
          providerAccountId: payload.hostRequest.expectedAccountId,
          sourceSha: payload.hostRequest.revision,
          text: payload.hostRequest.text,
        },
        selected,
      ),
    );
  }
  onStage?.("enqueue");
  const row = await store.enqueue({
    ownerId: user.id,
    projectId,
    workspaceId: input.workspaceId,
    taskId,
    requestId: input.requestId,
    requestDigest,
    hostRequest: {
      schemaVersion: 1,
      projectId,
      repositoryId: project.providerRepositoryId,
      expectedAccountId: project.providerAccountId,
      taskId,
      requestId: input.requestId,
      revision: input.expectedRevision,
      model: model.data,
      effort: effort.data,
      text: input.text,
    },
  });
  return pendingTaskStatus(row);
}
function taskIntentStore(pinPolicy?: ConstructorParameters<typeof ProjectTaskIntents>[2]) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("Task intent encryption unavailable");
  const acceptance = acceptanceServices(getDb());
  return new ProjectTaskIntents(
    getDb(),
    key,
    pinPolicy,
    acceptance ? (tx, input, row) => acceptance.store.captureIntent(tx, input, row) : undefined,
  );
}
async function authorizeIntentPolicy(
  ownerId: string,
  taskId: string,
  transaction?: Prisma.TransactionClient,
) {
  const db = transaction ?? getDb();
  const row = await db.projectTaskIntent.findUnique({
    where: { ownerId_id: { ownerId, id: taskId } },
  });
  if (
    process.env.HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED !== "true" &&
    !row?.repositoryPolicyVersionId
  ) {
    const project =
      row &&
      (await db.deliveryProject.findUnique({
        where: { ownerId_id: { ownerId, id: row.projectId } },
        select: { repositoryPolicy: { select: { id: true } } },
      }));
    if (!project?.repositoryPolicy) return;
  }
  const { repositoryPolicyStore } = await import("@/lib/delivery/repository-policy.server");
  if (transaction) {
    await repositoryPolicyStore(getDb()).authorizeIntent(transaction, ownerId, taskId);
    return;
  }
  await getDb().$transaction(
    (tx) => repositoryPolicyStore(getDb()).authorizeIntent(tx, ownerId, taskId),
    {
      isolationLevel: "Serializable",
      maxWait: 5000,
      timeout: 10000,
    },
  );
}
export async function reconcileProjectTasks(
  target?: { ownerId: string; taskId: string },
  limit = 3,
  options: { signal?: AbortSignal } = {},
) {
  if (process.env.HIVE_PROJECT_TASKS_ENABLED !== "true") return { enabled: false as const };
  const result = await reconcileTaskIntents(
    taskIntentStore(),
    async (payload, phase) => {
      let stage: z.infer<typeof projectTaskFailureStageSchema> = "owner";
      try {
        options.signal?.throwIfAborted();
        const owner = await getDb().user.findUnique({ where: { id: payload.ownerId } });
        options.signal?.throwIfAborted();
        if (!owner) throw new Error("Task owner unavailable");
        const user = { id: owner.id, coderUserId: owner.coderUserId };
        stage = "project";
        const project = await ownedProject(user, payload.projectId);
        options.signal?.throwIfAborted();
        if (
          project.providerRepositoryId !== payload.repositoryId ||
          project.providerAccountId !== payload.providerAccountId
        )
          throw new Error("Task project identity changed");
        stage = "policy";
        await authorizeIntentPolicy(user.id, payload.taskId);
        options.signal?.throwIfAborted();
        if (phase === "queued" && !payload.hostRequest)
          throw new Error("Queued intent payload unavailable");
        if (payload.hostRequest) {
          const reservations = await getDb().$queryRaw<
            { workspace_id: string; build_id: string; phase: string; paused: boolean }[]
          >`SELECT e.workspace_id,e.build_id,e.phase,(t.pause_requested OR t.scheduling_paused) AS paused
          FROM delivery_epic_start_intents e
          JOIN delivery_epic_plan_heads h ON h.owner_id=e.owner_id AND h.epic_id=e.epic_id
          JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version
          JOIN delivery_tasks t ON t.owner_id=p.owner_id AND t.id=p.authored_by_task_id
          WHERE e.owner_id=${user.id}::uuid AND e.intent_id=${payload.taskId}::uuid`;
          if (
            reservations.length > 1 ||
            (reservations.length === 1 &&
              (reservations[0].phase !== "accepted" ||
                reservations[0].paused ||
                reservations[0].workspace_id !== payload.workspaceId))
          )
            throw new Error("Epic preparation reservation unavailable");
          // The durable intent exists before enrollment and preparation. This owner
          // exchange authenticates the installed outer; a host status or browser
          // request cannot substitute for the approved package/lifetime checks.
          if (process.env.HIVE_GUARDIAN_ENABLED === "true") {
            stage = "guardian";
            const enrollment = await createGuardianService({
              ...options,
              onProvisionStage: (next) => {
                stage = next;
              },
            }).provision(
              { hiveUserId: user.id, coderUserId: user.coderUserId },
              payload.workspaceId,
            );
            options.signal?.throwIfAborted();
            if (enrollment.enrolled !== true) throw new Error("Guardian enrollment unavailable");
          }
          stage = "host_start";
          return status(
            await signedHostProjectRequest(
              user,
              payload.workspaceId,
              "/projects/tasks/start",
              payload.hostRequest,
              ...(reservations.length
                ? [{ ...options, expectedBuildId: reservations[0].build_id }]
                : options.signal
                  ? [options]
                  : []),
            ),
            payload.projectId,
            payload.taskId,
          );
        }
        stage = "host_status";
        return await readHostProjectTask(
          user,
          payload.projectId,
          {
            workspaceId: payload.workspaceId,
            taskId: payload.taskId,
            requestId: payload.requestId,
          },
          options,
        );
      } catch {
        options.signal?.throwIfAborted();
        throw new TaskExecutionStageError(stage);
      }
    },
    target,
    limit,
    options,
  );
  return { enabled: true as const, ...result };
}
export async function readProjectTask(user: ProjectPrincipal, projectId: string, value: unknown) {
  const input = projectTaskReadSchema.parse(value);
  await ownedProject(user, projectId);
  const store = taskIntentStore();
  await store.get(user.id, projectId, input.taskId, input.workspaceId);
  // The browser may accelerate one durable claim; the scheduled controller runs
  // this same operation independently when no browser is connected.
  await reconcileProjectTasks({ ownerId: user.id, taskId: input.taskId }, 1);
  return pendingTaskStatus(await store.get(user.id, projectId, input.taskId, input.workspaceId));
}

/** Explicit owner recovery never includes a prompt or changes task identity.
 * The installed host proves a pre-execution retry is safe, or returns the already
 * running task. Ambiguous execution remains held by the host journal. */
export async function retryProjectTask(
  user: ProjectPrincipal,
  projectId: string,
  value: unknown,
  onStage?: (stage: TaskRecoveryStage) => void,
) {
  const input = projectTaskReadSchema.parse(value);
  onStage?.("recovery_project");
  const project = await ownedProject(user, projectId);
  const store = taskIntentStore();
  onStage?.("recovery_policy");
  await authorizeIntentPolicy(user.id, input.taskId);
  onStage?.("recovery_snapshot");
  const snapshot = await store.recoverySnapshot(
    user.id,
    projectId,
    input.taskId,
    input.workspaceId,
  );
  if (
    snapshot.row.repositoryId !== project.providerRepositoryId ||
    snapshot.row.providerAccountId !== project.providerAccountId
  )
    throw new TaskIntentConflict("task_identity_conflict");
  if (process.env.HIVE_GUARDIAN_ENABLED === "true") {
    const recoveries = new ProjectTaskRecoveries(getDb(), store);
    onStage?.("recovery_begin");
    let attempt = await recoveries.begin({
      ownerId: user.id,
      coderOwnerId: user.coderUserId,
      projectId,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      recoveryId: input.requestId,
    });
    if (!attempt || attempt.phase === "consumed")
      return pendingTaskStatus(
        await store.get(user.id, projectId, input.taskId, input.workspaceId),
      );
    if (attempt.phase === "inspecting") {
      const service = createGuardianService({ onProvisionStage: onStage });
      const resumption = await service.unusedRecoveryResumption(attempt.scope);
      if (!resumption)
        await service.provision(
          { hiveUserId: user.id, coderUserId: user.coderUserId },
          input.workspaceId,
        );
      onStage?.("recovery_continuity");
      const continuity = resumption ?? (await service.recoveryContinuity(attempt.scope, onStage));
      onStage?.("recovery_inspect");
      const inspected = z
        .object({
          schemaVersion: z.literal(1),
          scope: recoveryScopeSchema,
          inspection: recoveryInspectionSchema,
          identity: z.unknown(),
        })
        .strict()
        .parse(
          await signedHostProjectRequest(
            user,
            input.workspaceId,
            "/projects/tasks/recovery-inspect",
            { schemaVersion: 1, scope: attempt.scope, ...(continuity ? { continuity } : {}) },
          ),
        );
      if (guardianDigest(inspected.scope) !== guardianDigest(attempt.scope))
        throw new TaskIntentConflict("task_identity_conflict");
      onStage?.("recovery_identity");
      const { runtime, packet } = await service.verifyRecoveryIdentity(
        { hiveUserId: user.id, coderUserId: user.coderUserId },
        input.workspaceId,
        inspected.identity,
        guardianDigest({ scope: attempt.scope, inspection: inspected.inspection }),
        resumption
          ? {
              scope: attempt.scope,
              inspection: inspected.inspection,
              authorize: (tx) => authorizeIntentPolicy(user.id, input.taskId, tx),
            }
          : undefined,
      );
      if (
        packet.identity.lifetimeId !== inspected.inspection.lifetimeId ||
        packet.startup.generation !== inspected.inspection.guardianGeneration
      )
        throw new TaskIntentConflict("task_identity_conflict");
      onStage?.("recovery_authorize");
      attempt = await recoveries.authorize(attempt, inspected.inspection, runtime, (tx) =>
        authorizeIntentPolicy(user.id, input.taskId, tx),
      );
    }
    if (!attempt.authorization) throw new TaskIntentConflict("task_identity_conflict");
    onStage?.("recovery_consume");
    const receipt = await signedHostProjectRequest(
      user,
      input.workspaceId,
      "/projects/tasks/recovery-consume",
      { schemaVersion: 1, scope: attempt.scope, authorization: attempt.authorization },
      { expectedBuildId: attempt.authorization.buildId },
    );
    onStage?.("recovery_finish");
    await recoveries.finish(attempt, receipt);
    return pendingTaskStatus(await store.get(user.id, projectId, input.taskId, input.workspaceId));
  }
  if (snapshot.row.phase !== "blocked") return pendingTaskStatus(snapshot.row);
  onStage?.("recovery_legacy");
  const current = status(
    await signedHostProjectRequest(user, input.workspaceId, "/projects/tasks/retry", {
      schemaVersion: 1,
      projectId,
      taskId: input.taskId,
      requestId: input.requestId,
    }),
    projectId,
    input.taskId,
  );
  await store.recover(snapshot, current);
  return pendingTaskStatus(await store.get(user.id, projectId, input.taskId, input.workspaceId));
}

export async function readHostProjectTask(
  user: ProjectPrincipal,
  projectId: string,
  value: unknown,
  options: { signal?: AbortSignal } = {},
) {
  options.signal?.throwIfAborted();
  const input = projectTaskReadSchema.parse(value);
  await ownedProject(user, projectId);
  options.signal?.throwIfAborted();
  await authorizeIntentPolicy(user.id, input.taskId);
  options.signal?.throwIfAborted();
  const read = () =>
    signedHostProjectRequest(
      user,
      input.workspaceId,
      "/projects/tasks/status",
      {
        schemaVersion: 1,
        projectId,
        taskId: input.taskId,
        requestId: input.requestId,
      },
      ...(options.signal ? [options] : []),
    );
  const current = status(await read(), projectId, input.taskId);
  options.signal?.throwIfAborted();
  if (current.phase !== "awaitingRegistration") return current;
  // Registration itself freshly verifies owner/build/app. Recover only the
  // current slot's known projects, never every historic conversation in the DB.
  const service = createRegisteredSessionService(getDb(), registeredSessionConfig(), options);
  const principal = { hiveUserId: user.id, coderUserId: user.coderUserId };
  const { resolveVerifiedWorkspaceHost } = await import("@/lib/codex-session/registration.server");
  options.signal?.throwIfAborted();
  const coder = options.signal
    ? await getCoderClientForUser(user.id, options)
    : await getCoderClientForUser(user.id);
  options.signal?.throwIfAborted();
  const { binding } = await resolveVerifiedWorkspaceHost(
    registeredSessionConfig(),
    async () => coder,
    principal,
    input.workspaceId,
  );
  options.signal?.throwIfAborted();
  const slot = await getDb().codexHostSlot.findUnique({
    where: {
      ownerId_coderOrigin_workspaceId_agentId: {
        ownerId: user.id,
        coderOrigin: binding.coderOrigin,
        workspaceId: binding.workspaceId,
        agentId: binding.agentId,
      },
    },
  });
  options.signal?.throwIfAborted();
  const prior = slot?.activeRegistrationId
    ? await getDb().codexHostRegistration.findUnique({
        where: { ownerId_id: { ownerId: user.id, id: slot.activeRegistrationId } },
        include: { threads: true },
      })
    : null;
  options.signal?.throwIfAborted();
  const projectIds = [
    ...new Set([
      ...(prior && prior.buildId === binding.buildId && !prior.revokedAt
        ? prior.threads.map((t) => t.projectId)
        : []),
      projectId,
    ]),
  ];
  await provisionRegisteredHost(
    service.authority,
    coder,
    principal,
    binding.workspaceId,
    binding.agentId,
    projectIds,
    ...(options.signal ? [options] : []),
  );
  options.signal?.throwIfAborted();
  return status(await read(), projectId, input.taskId);
}
