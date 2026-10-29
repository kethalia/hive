import { createHash, randomUUID } from "node:crypto";
import { decrypt, encrypt } from "@hive/auth";
import type { PrismaClient, ProjectTaskIntent } from "@hive/db";
import { z } from "zod";
import { type ProjectTaskStatus, projectTaskStatusSchema } from "./task-contracts";

const uuid = z.string().uuid();
export const taskIntentPayloadSchema = z
  .object({
    ownerId: uuid,
    projectId: uuid,
    workspaceId: uuid,
    taskId: uuid,
    requestId: uuid,
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    hostRequest: z
      .object({
        schemaVersion: z.literal(1),
        projectId: uuid,
        repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
        expectedAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
        taskId: uuid,
        requestId: uuid,
        revision: z.string().regex(/^[a-f0-9]{40}$/),
        model: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
        effort: z.string().min(1).max(20),
        text: z
          .string()
          .min(1)
          .refine((v) => Buffer.byteLength(v) <= 32768),
      })
      .strict(),
  })
  .strict()
  .refine(
    (p) =>
      p.projectId === p.hostRequest.projectId &&
      p.taskId === p.hostRequest.taskId &&
      p.requestId === p.hostRequest.requestId,
  );
export type TaskIntentPayload = z.infer<typeof taskIntentPayloadSchema>;
export type TaskIntentExecution = {
  ownerId: string;
  projectId: string;
  workspaceId: string;
  taskId: string;
  requestId: string;
  repositoryId: string;
  providerAccountId: string;
  sourceSha: string;
  hostRequest?: TaskIntentPayload["hostRequest"];
};
export class TaskIntentConflict extends Error {}
export function taskRequestDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function pendingTaskStatus(
  row: Pick<ProjectTaskIntent, "id" | "projectId" | "status" | "phase">,
): ProjectTaskStatus {
  if (row.status) return projectTaskStatusSchema.parse(row.status);
  return {
    schemaVersion: 1,
    projectId: row.projectId,
    taskId: row.id,
    phase: row.phase === "blocked" ? "blocked" : "preparing",
    nativeThreadId: null,
    terminalSessionName: null,
    reason: row.phase === "blocked" ? "native_unavailable" : null,
  };
}
export class ProjectTaskIntents {
  constructor(
    private readonly db: PrismaClient,
    private readonly encryptionKey: string,
  ) {}
  async enqueue(value: TaskIntentPayload) {
    const input = taskIntentPayloadSchema.parse(value);
    const encrypted = encrypt(JSON.stringify(input), this.encryptionKey);
    const row = await this.db.projectTaskIntent.upsert({
      where: {
        ownerId_projectId_requestId: {
          ownerId: input.ownerId,
          projectId: input.projectId,
          requestId: input.requestId,
        },
      },
      create: {
        id: input.taskId,
        ownerId: input.ownerId,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        requestDigest: input.requestDigest,
        repositoryId: input.hostRequest.repositoryId,
        providerAccountId: input.hostRequest.expectedAccountId,
        sourceSha: input.hostRequest.revision,
        ciphertext: Uint8Array.from(encrypted.ciphertext),
        iv: Uint8Array.from(encrypted.iv),
        authTag: Uint8Array.from(encrypted.authTag),
      },
      update: {},
    });
    if (
      row.id !== input.taskId ||
      row.workspaceId !== input.workspaceId ||
      row.requestDigest !== input.requestDigest
    )
      throw new TaskIntentConflict("task_identity_conflict");
    return row;
  }
  async get(ownerId: string, projectId: string, taskId: string, workspaceId: string) {
    const row = await this.db.projectTaskIntent.findFirst({
      where: {
        id: uuid.parse(taskId),
        ownerId: uuid.parse(ownerId),
        projectId: uuid.parse(projectId),
        workspaceId: uuid.parse(workspaceId),
      },
    });
    if (!row) throw new TaskIntentConflict("task_not_found");
    return row;
  }
  async recoverySnapshot(ownerId: string, projectId: string, taskId: string, workspaceId: string) {
    for (const value of [ownerId, projectId, taskId, workspaceId]) uuid.parse(value);
    // Read the exact timestamp before loading the row. If it changes between
    // reads (or during the host request), recovery's compare-and-set must fail.
    const versions = await this.db.$queryRaw<{ version: string }[]>`
      SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS version
      FROM project_task_intents WHERE id=${taskId}::uuid AND owner_id=${ownerId}::uuid
        AND project_id=${projectId}::uuid AND workspace_id=${workspaceId}::uuid`;
    if (!versions[0]) throw new TaskIntentConflict("task_not_found");
    return {
      row: await this.get(ownerId, projectId, taskId, workspaceId),
      version: versions[0].version,
    };
  }
  async recover(snapshot: { row: ProjectTaskIntent; version: string }, value: ProjectTaskStatus) {
    const { row, version } = snapshot;
    const status = projectTaskStatusSchema.parse(value);
    if (status.taskId !== row.id || status.projectId !== row.projectId)
      throw new Error("Intent recovery binding mismatch");
    if (status.phase === "awaitingTask" || status.phase === "blocked") return false;
    const phase = status.phase === "running" ? "running" : "preparing";
    const count = await this.db.$executeRaw`
      UPDATE project_task_intents SET phase=${phase}, status=${JSON.stringify(status)}::jsonb,
        failure_count=0,lease_id=NULL,lease_until=NULL,progress_at=clock_timestamp(),updated_at=clock_timestamp(),next_attempt_at=clock_timestamp(),
        ciphertext=CASE WHEN ${phase}='running' THEN NULL ELSE ciphertext END,
        iv=CASE WHEN ${phase}='running' THEN NULL ELSE iv END,
        auth_tag=CASE WHEN ${phase}='running' THEN NULL ELSE auth_tag END
      WHERE id=${row.id}::uuid AND owner_id=${row.ownerId}::uuid AND project_id=${row.projectId}::uuid
        AND workspace_id=${row.workspaceId}::uuid AND phase='blocked'
        AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')=${version}`;
    return count === 1;
  }
  async claim(target?: { ownerId: string; taskId: string }) {
    if (target) {
      uuid.parse(target.ownerId);
      uuid.parse(target.taskId);
    }
    const leaseId = randomUUID();
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      WITH candidate AS (
        SELECT id, (phase <> 'running' AND progress_at < clock_timestamp()-interval '30 minutes') AS timed_out FROM project_task_intents
        WHERE phase IN ('queued','preparing','running') AND next_attempt_at <= clock_timestamp()
          AND (lease_until IS NULL OR lease_until <= clock_timestamp())
          AND (${target?.ownerId ?? null}::uuid IS NULL OR owner_id=${target?.ownerId ?? null}::uuid)
          AND (${target?.taskId ?? null}::uuid IS NULL OR id=${target?.taskId ?? null}::uuid)
        ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      UPDATE project_task_intents p SET lease_id=${leaseId}::uuid, lease_until=clock_timestamp()+interval '90 seconds', updated_at=clock_timestamp(),
        failure_count=LEAST(5,p.failure_count+CASE WHEN p.lease_until IS NOT NULL THEN 1 ELSE 0 END),
        phase=CASE WHEN c.timed_out OR (p.lease_until IS NOT NULL AND p.failure_count>=4) THEN 'blocked' ELSE p.phase END,
        status=CASE WHEN c.timed_out THEN jsonb_build_object('schemaVersion',1,'projectId',p.project_id,'taskId',p.id,'phase','blocked',
          'nativeThreadId',p.status->'nativeThreadId','terminalSessionName',p.status->'terminalSessionName','reason','preparation_timeout')
          WHEN p.lease_until IS NOT NULL AND p.failure_count>=4 THEN NULL ELSE p.status END
      FROM candidate c WHERE p.id=c.id RETURNING p.id`;
    if (!rows.length) return null;
    return this.db.projectTaskIntent.findFirst({ where: { id: rows[0].id, leaseId } });
  }
  execution(row: ProjectTaskIntent): TaskIntentExecution {
    const metadata = {
      ownerId: row.ownerId,
      projectId: row.projectId,
      workspaceId: row.workspaceId,
      taskId: row.id,
      requestId: row.requestId,
      repositoryId: row.repositoryId,
      providerAccountId: row.providerAccountId,
      sourceSha: row.sourceSha,
    };
    // A running/prepared intent can recover registration after a host restart
    // using immutable metadata; it must never submit the first prompt again.
    if (row.phase !== "queued") return metadata;
    const payload = this.payload(row);
    return { ...metadata, hostRequest: payload.hostRequest };
  }
  payload(row: ProjectTaskIntent) {
    if (!row.ciphertext || !row.iv || !row.authTag) throw new Error("Intent payload unavailable");
    const payload = taskIntentPayloadSchema.parse(
      JSON.parse(
        decrypt(
          {
            ciphertext: Buffer.from(row.ciphertext),
            iv: Buffer.from(row.iv),
            authTag: Buffer.from(row.authTag),
          },
          this.encryptionKey,
        ),
      ),
    );
    if (
      payload.ownerId !== row.ownerId ||
      payload.projectId !== row.projectId ||
      payload.taskId !== row.id ||
      payload.workspaceId !== row.workspaceId ||
      payload.requestId !== row.requestId ||
      payload.requestDigest !== row.requestDigest ||
      payload.hostRequest.repositoryId !== row.repositoryId ||
      payload.hostRequest.expectedAccountId !== row.providerAccountId ||
      payload.hostRequest.revision !== row.sourceSha
    )
      throw new Error("Intent payload binding mismatch");
    return payload;
  }
  async finish(row: ProjectTaskIntent, value: ProjectTaskStatus) {
    const status = projectTaskStatusSchema.parse(value);
    if (status.taskId !== row.id || status.projectId !== row.projectId)
      throw new Error("Intent result binding mismatch");
    const phase = ["running", "blocked"].includes(status.phase) ? status.phase : "preparing";
    const result = await this.db.$executeRaw`
      UPDATE project_task_intents SET phase=${phase}, status=${JSON.stringify(status)}::jsonb,
        progress_at=CASE WHEN status IS DISTINCT FROM ${JSON.stringify(status)}::jsonb THEN clock_timestamp() ELSE progress_at END,
        failure_count=0, lease_id=NULL, lease_until=NULL, next_attempt_at=clock_timestamp()+CASE WHEN ${phase}='running' THEN interval '30 seconds' ELSE interval '5 seconds' END, updated_at=clock_timestamp(),
        ciphertext=CASE WHEN ${phase}='running' THEN NULL ELSE ciphertext END,
        iv=CASE WHEN ${phase}='running' THEN NULL ELSE iv END,
        auth_tag=CASE WHEN ${phase}='running' THEN NULL ELSE auth_tag END
      WHERE id=${row.id}::uuid AND owner_id=${row.ownerId}::uuid AND lease_id=${row.leaseId}::uuid AND lease_until > clock_timestamp()`;
    return result === 1;
  }
  async fail(row: ProjectTaskIntent) {
    const blocked = pendingTaskStatus({ ...row, status: null, phase: "blocked" });
    return this.db.$executeRaw`
      UPDATE project_task_intents SET failure_count=LEAST(5,failure_count+1),
        phase=CASE WHEN failure_count>=4 THEN 'blocked' ELSE phase END,
        status=CASE WHEN failure_count>=4 THEN ${JSON.stringify(blocked)}::jsonb ELSE status END,
        lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp(),
        next_attempt_at=clock_timestamp()+interval '10 seconds'*power(2,LEAST(4,failure_count))
      WHERE id=${row.id}::uuid AND owner_id=${row.ownerId}::uuid AND lease_id=${row.leaseId}::uuid AND lease_until > clock_timestamp()`;
  }
}
export async function reconcileTaskIntents(
  store: ProjectTaskIntents,
  execute: (payload: TaskIntentExecution, phase: string) => Promise<ProjectTaskStatus>,
  target?: { ownerId: string; taskId: string },
  limit = 3,
) {
  z.number().int().min(1).max(3).parse(limit);
  const result = { processed: 0, retry: 0, stale: 0 };
  for (let index = 0; index < limit; index++) {
    const row = await store.claim(target);
    if (!row) break;
    if (row.phase === "blocked") {
      result.retry++;
      continue;
    }
    try {
      const value = await execute(store.execution(row), row.phase);
      if (await store.finish(row, value)) result.processed++;
      else result.stale++;
    } catch {
      await store.fail(row);
      result.retry++;
    }
  }
  return result;
}
