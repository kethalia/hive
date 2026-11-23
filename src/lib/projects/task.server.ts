import { createHash } from "node:crypto";
import { getDb } from "@hive/db";
import { z } from "zod";
import { getCoderClientForUser } from "@/lib/coder/user-client";
import { provisionRegisteredHost } from "@/lib/codex-session/bootstrap-delivery.server";
import { createGuardianService } from "@/lib/codex-session/guardian-factory.server";
import {
  createRegisteredSessionService,
  registeredSessionConfig,
} from "@/lib/codex-session/registered-session.server";
import { managedProjectTemplateIds } from "./config";
import { ProjectDiscoveryError } from "./errors";
import { type ProjectPrincipal, signedHostProjectRequest } from "./host.server";
import { resolvedRepositorySchema } from "./session-contracts";
import {
  projectCleanupStatusSchema,
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

export class ProjectTaskConflict extends Error {}

export function managedProjectTasksEnabled() {
  return managedProjectTemplateIds().length > 0;
}
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
    result.data.taskId !== taskId ||
    result.data.phase === "awaitingTask"
  )
    throw new ProjectDiscoveryError("github_invalid_response");
  return result.data;
}
export async function startProjectTask(
  user: ProjectPrincipal,
  projectId: string,
  value: unknown,
  signal?: AbortSignal,
) {
  const input = projectTaskStartSchema.parse(value);
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
  const parsedRepository = resolvedRepositorySchema.safeParse(
    await signedHostProjectRequest(
      user,
      input.workspaceId,
      "/projects/resolve",
      {
        schemaVersion: 1,
        repositoryId: project.providerRepositoryId,
        expectedAccountId: project.providerAccountId,
      },
      { signal },
    ),
  );
  if (!parsedRepository.success) throw new ProjectDiscoveryError("github_invalid_response");
  const resolved = parsedRepository.data;
  if (
    resolved.providerAccountId !== project.providerAccountId ||
    resolved.repository.providerRepositoryId !== project.providerRepositoryId
  )
    throw new ProjectDiscoveryError("github_invalid_response");
  if (
    resolved.repository.archived ||
    !resolved.repository.permissions.pull ||
    !resolved.repository.permissions.push
  )
    throw new ProjectDiscoveryError("github_permission_denied");
  if (resolved.defaultRevision !== input.expectedRevision)
    throw new ProjectTaskConflict("source_changed");
  // Runtime policy is deployment-owned. Models cannot promote themselves through
  // browser fields, and absent policy disables task execution.
  const model = z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
    .safeParse(process.env.HIVE_CODEX_MANAGER_MODEL);
  const effort = z
    .enum(["low", "medium", "high", "xhigh", "max", "ultra"])
    .safeParse(process.env.HIVE_CODEX_MANAGER_EFFORT);
  if (!model.success || !effort.success) throw new Error("Manager runtime policy is unavailable");
  const store = taskIntentStore();
  signal?.throwIfAborted();
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
function taskIntentStore() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("Task intent encryption unavailable");
  return new ProjectTaskIntents(getDb(), key);
}
export async function reconcileProjectTask(
  target: { ownerId: string; taskId: string },
  signal: AbortSignal,
) {
  if (!managedProjectTasksEnabled()) return;
  return reconcileTaskIntents(
    taskIntentStore(),
    async (payload, phase) => {
      let stage: ConstructorParameters<typeof TaskExecutionStageError>[0] = "owner";
      try {
        const owner = await getDb().user.findUnique({ where: { id: payload.ownerId } });
        if (!owner) throw new Error("Task owner unavailable");
        signal.throwIfAborted();
        const user = { id: owner.id, coderUserId: owner.coderUserId };
        stage = "project";
        const project = await ownedProject(user, payload.projectId);
        if (
          project.providerRepositoryId !== payload.repositoryId ||
          project.providerAccountId !== payload.providerAccountId
        )
          throw new Error("Task project identity changed");
        if (phase === "queued") {
          if (!payload.hostRequest) throw new Error("Queued intent payload unavailable");
          stage = "guardian";
          const enrollment = await createGuardianService({
            signal,
            onProvisionStage: (next) => {
              stage = next;
            },
          }).provision({ hiveUserId: user.id, coderUserId: user.coderUserId }, payload.workspaceId);
          const runtime = await getDb().codexGuardianRuntime.findUniqueOrThrow({
            where: { ownerId_id: { ownerId: user.id, id: enrollment.runtimeId } },
            select: { buildId: true, workspaceId: true, phase: true },
          });
          if (runtime.workspaceId !== payload.workspaceId || runtime.phase !== "open")
            throw new Error("Guardian authorization unavailable");
          stage = "host_start";
          return status(
            await signedHostProjectRequest(
              user,
              payload.workspaceId,
              "/projects/tasks/start",
              payload.hostRequest,
              { signal, expectedBuildId: runtime.buildId },
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
          signal,
        );
      } catch {
        signal.throwIfAborted();
        throw new TaskExecutionStageError(stage);
      }
    },
    target,
    1,
    { signal },
  );
}
export async function readProjectTask(user: ProjectPrincipal, projectId: string, value: unknown) {
  const input = projectTaskReadSchema.parse(value);
  await ownedProject(user, projectId);
  return pendingTaskStatus(
    await taskIntentStore().get(user.id, projectId, input.taskId, input.workspaceId),
  );
}

/** Explicit owner recovery never includes a prompt or changes task identity.
 * The installed host proves a pre-execution retry is safe, or returns the already
 * running task. Ambiguous execution remains held by the host journal. */
export async function retryProjectTask(
  user: ProjectPrincipal,
  projectId: string,
  value: unknown,
  signal?: AbortSignal,
) {
  const input = projectTaskReadSchema.parse(value);
  const project = await ownedProject(user, projectId);
  const store = taskIntentStore();
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
  if (snapshot.row.phase !== "blocked") return pendingTaskStatus(snapshot.row);
  const current = status(
    await signedHostProjectRequest(
      user,
      input.workspaceId,
      "/projects/tasks/retry",
      { schemaVersion: 1, projectId, taskId: input.taskId, requestId: input.requestId },
      { signal },
    ),
    projectId,
    input.taskId,
  );
  await store.recover(snapshot, current);
  return pendingTaskStatus(await store.get(user.id, projectId, input.taskId, input.workspaceId));
}

export async function requestProjectCleanup(
  user: ProjectPrincipal,
  projectId: string,
  value: unknown,
  signal?: AbortSignal,
) {
  const input = projectTaskReadSchema.parse(value);
  const project = await ownedProject(user, projectId);
  const task = await taskIntentStore().get(user.id, projectId, input.taskId, input.workspaceId);
  if (
    task.repositoryId !== project.providerRepositoryId ||
    task.providerAccountId !== project.providerAccountId ||
    !pendingTaskStatus(task).nativeThreadId
  )
    throw new TaskIntentConflict("task_identity_conflict");
  const result = projectCleanupStatusSchema.safeParse(
    await signedHostProjectRequest(
      user,
      input.workspaceId,
      "/projects/tasks/cleanup",
      { schemaVersion: 1, projectId, taskId: task.id, requestId: input.requestId },
      { signal },
    ),
  );
  if (!result.success || result.data.requestId !== input.requestId)
    throw new ProjectDiscoveryError("github_invalid_response");
  return result.data;
}

async function readHostProjectTask(
  user: ProjectPrincipal,
  projectId: string,
  value: unknown,
  signal: AbortSignal,
) {
  const input = projectTaskReadSchema.parse(value);
  await ownedProject(user, projectId);
  const read = () =>
    signedHostProjectRequest(
      user,
      input.workspaceId,
      "/projects/tasks/status",
      { schemaVersion: 1, projectId, taskId: input.taskId, requestId: input.requestId },
      { signal },
    );
  const current = status(await read(), projectId, input.taskId);
  if (current.phase !== "awaitingRegistration") return current;
  // Registration itself freshly verifies owner/build/app. Recover only the
  // current slot's known projects, never every historic conversation in the DB.
  const service = createRegisteredSessionService(getDb(), registeredSessionConfig(), { signal });
  const principal = { hiveUserId: user.id, coderUserId: user.coderUserId };
  const { resolveVerifiedWorkspaceHost } = await import("@/lib/codex-session/registration.server");
  const coder = await getCoderClientForUser(user.id, { signal });
  const { binding } = await resolveVerifiedWorkspaceHost(
    registeredSessionConfig(),
    async () => coder,
    principal,
    input.workspaceId,
  );
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
  const prior = slot?.activeRegistrationId
    ? await getDb().codexHostRegistration.findUnique({
        where: { ownerId_id: { ownerId: user.id, id: slot.activeRegistrationId } },
        include: { threads: true },
      })
    : null;
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
    { signal },
  );
  return status(await read(), projectId, input.taskId);
}
