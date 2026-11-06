import type { CodexGuardianRuntime, Prisma, PrismaClient } from "@hive/db";
import { guardianDigest } from "@/lib/codex-session/guardian-contracts";
import { type ProjectTaskIntents, taskRequestDigest } from "./task-intents.server";
import {
  type RecoveryAuthorization,
  type RecoveryInspection,
  type RecoveryScope,
  recoveryAuthorizationSchema,
  recoveryInspectionSchema,
  recoveryReceiptSchema,
  recoveryScopeSchema,
} from "./task-recovery-contracts";

type Tx = Prisma.TransactionClient;
export type RecoveryRecord = {
  id: string;
  phase: "inspecting" | "authorized" | "consumed";
  scope: RecoveryScope;
  inspection: RecoveryInspection | null;
  authorization: RecoveryAuthorization | null;
  receipt: unknown;
};
const check: (v: unknown) => asserts v = (v) => {
  if (!v) throw new Error("retry_not_available");
};
async function lockedIntent(tx: Tx, ownerId: string, taskId: string) {
  const [v] = await tx.$queryRaw<
    { version: string }[]
  >`SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS version
    FROM project_task_intents WHERE owner_id=${ownerId}::uuid AND id=${taskId}::uuid FOR UPDATE`;
  const row = await tx.projectTaskIntent.findUnique({
    where: { ownerId_id: { ownerId, id: taskId } },
  });
  check(v && row);
  return { row, version: v.version };
}
async function assertEpicRecovery(tx: Tx, scope: RecoveryScope, buildId: string) {
  const rows = await tx.$queryRaw<
    { workspace_id: string; build_id: string; phase: string; paused: boolean }[]
  >`
    SELECT e.workspace_id,e.build_id,e.phase,(t.pause_requested OR t.scheduling_paused) AS paused
    FROM delivery_epic_start_intents e
    JOIN delivery_epic_plan_heads h ON h.owner_id=e.owner_id AND h.epic_id=e.epic_id
    JOIN delivery_epic_plans p ON p.owner_id=h.owner_id AND p.epic_id=h.epic_id AND p.version=h.version
    JOIN delivery_tasks t ON t.owner_id=p.owner_id AND t.id=p.authored_by_task_id
    WHERE e.owner_id=${scope.ownerId}::uuid AND e.intent_id=${scope.taskId}::uuid`;
  check(
    rows.length === 0 ||
      (rows.length === 1 &&
        rows[0].phase === "accepted" &&
        !rows[0].paused &&
        rows[0].workspace_id === scope.workspaceId &&
        rows[0].build_id === buildId),
  );
}
export async function assertTaskRecoveryOperation(
  tx: Tx,
  input: {
    ownerId: string;
    projectId: string;
    runtime: CodexGuardianRuntime;
    recovery?: { recoveryId: string; authorizationDigest: string };
  },
) {
  const rows = await tx.$queryRaw<
    (RecoveryRecord & { task_id: string })[]
  >`SELECT * FROM project_task_recoveries
    WHERE owner_id=${input.ownerId}::uuid AND scope->>'projectId'=${input.projectId}
      AND (phase<>'consumed' OR id=${input.recovery?.recoveryId ?? null}::uuid)`;
  if (!rows.length) {
    check(!input.recovery);
    return;
  }
  check(rows.length === 1 && input.recovery);
  const r = rows[0],
    a = recoveryAuthorizationSchema.parse(r.authorization),
    s = recoveryScopeSchema.parse(r.scope);
  check(
    r.id === input.recovery.recoveryId &&
      guardianDigest(a) === input.recovery.authorizationDigest &&
      s.workspaceId === input.runtime.workspaceId &&
      a.lifetimeId === input.runtime.lifetimeId &&
      a.buildId === input.runtime.buildId,
  );
  if (r.phase === "consumed") return; // Historical local grant is no longer a special authority; normal live checks still run.
  check(r.phase === "authorized");
  const { row, version } = await lockedIntent(tx, input.ownerId, r.task_id);
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  check(
    version === a.authorizedVersion &&
      clock.now.getTime() < a.expiresAt &&
      row.phase !== "blocked" &&
      row.requestDigest === s.intentDigest,
  );
  await assertEpicRecovery(tx, s, a.buildId);
  return a.expiresAt;
}
export class ProjectTaskRecoveries {
  constructor(
    private db: PrismaClient,
    private intents: ProjectTaskIntents,
  ) {}
  async begin(input: {
    ownerId: string;
    coderOwnerId: string;
    projectId: string;
    taskId: string;
    workspaceId: string;
    recoveryId: string;
  }) {
    return this.db.$transaction(async (tx) => {
      const { row, version } = await lockedIntent(tx, input.ownerId, input.taskId);
      check(row.projectId === input.projectId && row.workspaceId === input.workspaceId);
      const rows = await tx.$queryRaw<RecoveryRecord[]>`SELECT * FROM project_task_recoveries
        WHERE owner_id=${input.ownerId}::uuid AND task_id=${input.taskId}::uuid
          AND (phase<>'consumed' OR id=${input.recoveryId}::uuid) ORDER BY created_at DESC`;
      if (rows.length) {
        check(rows.length === 1);
        return rows[0];
      }
      if (row.phase !== "blocked") return null;
      const payload = this.intents.payload(row);
      const scope = recoveryScopeSchema.parse({
        recoveryId: input.recoveryId,
        ownerId: input.ownerId,
        coderOwnerId: input.coderOwnerId,
        projectId: row.projectId,
        taskId: row.id,
        workspaceId: row.workspaceId,
        originalRequestId: row.requestId,
        intentVersion: version,
        intentDigest: row.requestDigest,
        hostRequestDigest: taskRequestDigest(payload.hostRequest),
        repositoryId: row.repositoryId,
        providerAccountId: row.providerAccountId,
        revision: row.sourceSha,
      });
      await tx.$executeRaw`INSERT INTO project_task_recoveries(owner_id,task_id,id,scope)
        VALUES(${input.ownerId}::uuid,${row.id}::uuid,${input.recoveryId}::uuid,${JSON.stringify(scope)}::jsonb)`;
      return {
        id: input.recoveryId,
        phase: "inspecting" as const,
        scope,
        inspection: null,
        authorization: null,
        receipt: null,
      };
    });
  }
  async authorize(
    record: RecoveryRecord,
    inspection: unknown,
    runtime: CodexGuardianRuntime,
    policy: (tx: Tx) => Promise<void>,
  ) {
    const i = recoveryInspectionSchema.parse(inspection),
      s = recoveryScopeSchema.parse(record.scope);
    return this.db.$transaction(async (tx) => {
      // Same lock ordering as guardian operations: runtime, then intent.
      await tx.$queryRaw`SELECT id FROM codex_guardian_runtimes WHERE owner_id=${s.ownerId}::uuid AND id=${runtime.id}::uuid FOR UPDATE`;
      const current = await tx.codexGuardianRuntime.findUnique({
        where: { ownerId_id: { ownerId: s.ownerId, id: runtime.id } },
      });
      const { row, version } = await lockedIntent(tx, s.ownerId, s.taskId);
      const [r] = await tx.$queryRaw<
        RecoveryRecord[]
      >`SELECT * FROM project_task_recoveries WHERE owner_id=${s.ownerId}::uuid AND id=${record.id}::uuid FOR UPDATE`;
      check(r && guardianDigest(r.scope) === guardianDigest(s));
      if (r.phase !== "inspecting") {
        check(guardianDigest(r.inspection) === guardianDigest(i));
        return r;
      }
      check(
        current &&
          current.phase === "open" &&
          current.operationReceiptsEnabled &&
          current.generation === i.guardianGeneration &&
          current.ownerId === s.ownerId &&
          current.workspaceId === s.workspaceId &&
          current.buildId === i.buildId &&
          current.lifetimeId === i.lifetimeId &&
          version === s.intentVersion &&
          row.phase === "blocked" &&
          row.requestDigest === s.intentDigest &&
          row.ciphertext,
      );
      const admission = await tx.codexGuardianAdmission.findFirst({
        where: { ownerId: s.ownerId, runtimeId: current.id, projectId: s.projectId },
      });
      check(
        i.outcome === "task_absent"
          ? !admission
          : !admission || admission.preparationIntentId === s.taskId,
      );
      await policy(tx);
      await assertEpicRecovery(tx, s, i.buildId);
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const expiresAt = Math.min(clock.now.getTime() + 60000, current.authorityUntil.getTime());
      check(expiresAt > clock.now.getTime() + 1000);
      const [changed] = await tx.$queryRaw<{ version: string }[]>`UPDATE project_task_intents
        SET phase=${i.outcome === "task_absent" ? "queued" : "preparing"},lease_id=NULL,lease_until=NULL,failure_count=0,
          progress_at=clock_timestamp(),next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE owner_id=${s.ownerId}::uuid AND id=${s.taskId}::uuid
        RETURNING to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS version`;
      const authorization = recoveryAuthorizationSchema.parse({
        inspectionDigest: guardianDigest(i),
        authorizedVersion: changed.version,
        buildId: i.buildId,
        lifetimeId: i.lifetimeId,
        expiresAt,
      });
      await tx.$executeRaw`UPDATE project_task_recoveries SET phase='authorized',inspection=${JSON.stringify(i)}::jsonb,
        "authorization"=${JSON.stringify(authorization)}::jsonb WHERE owner_id=${s.ownerId}::uuid AND id=${r.id}::uuid`;
      return { ...r, phase: "authorized" as const, inspection: i, authorization };
    });
  }
  async finish(record: RecoveryRecord, value: unknown) {
    const s = recoveryScopeSchema.parse(record.scope),
      a = recoveryAuthorizationSchema.parse(record.authorization),
      receipt = recoveryReceiptSchema.parse(value);
    check(
      receipt.recoveryId === record.id &&
        receipt.scopeDigest === guardianDigest(s) &&
        receipt.inspectionDigest === a.inspectionDigest &&
        receipt.authorizationDigest === guardianDigest(a) &&
        receipt.buildId === a.buildId &&
        receipt.lifetimeId === a.lifetimeId &&
        receipt.outcome === record.inspection?.outcome,
    );
    return this.db.$transaction(async (tx) => {
      const { row, version } = await lockedIntent(tx, s.ownerId, s.taskId);
      const [r] = await tx.$queryRaw<
        RecoveryRecord[]
      >`SELECT * FROM project_task_recoveries WHERE owner_id=${s.ownerId}::uuid AND id=${record.id}::uuid FOR UPDATE`;
      check(r);
      if (r.phase === "consumed") {
        check(guardianDigest(r.receipt) === guardianDigest(receipt));
        return;
      }
      check(
        r.phase === "authorized" &&
          guardianDigest(r.authorization) === guardianDigest(a) &&
          version === a.authorizedVersion &&
          row.phase !== "blocked",
      );
      await tx.$executeRaw`UPDATE project_task_intents SET status=NULL,updated_at=clock_timestamp()
        WHERE owner_id=${s.ownerId}::uuid AND id=${s.taskId}::uuid`;
      await tx.$executeRaw`UPDATE project_task_recoveries SET phase='consumed',receipt=${JSON.stringify(receipt)}::jsonb
        WHERE owner_id=${s.ownerId}::uuid AND id=${record.id}::uuid`;
    });
  }
}
