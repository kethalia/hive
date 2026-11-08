import { createPublicKey, randomUUID, verify } from "node:crypto";
import type { Prisma, PrismaClient } from "@hive/db";
import {
  type AccountMaintenanceState,
  accountMaintenanceIdleSnapshotSchema,
  accountMaintenanceStateSchema,
  accountMaintenanceViewSchema,
  type MaintenanceOwnerResume,
  maintenanceArchiveSchema,
  maintenanceOwnerResumeSchema,
  maintenanceResumeScopeSchema,
} from "./account-maintenance-contracts";
import { guardianCanonical, guardianDigest } from "./guardian-contracts";
import type { RegistrationBinding } from "./registration.server";
import { RegistrationRejected } from "./registration-store.server";

type Tx = Prisma.TransactionClient;
type WorkspaceScope = Pick<RegistrationBinding, "hiveUserId" | "coderOrigin" | "workspaceId">;
const requireValue: (condition: unknown) => asserts condition = (condition) => {
  if (!condition) throw new RegistrationRejected();
};
type Slot = {
  id: string;
  ownerId: string;
  coderOwnerId: string;
  coderOrigin: string;
  workspaceId: string;
  accountMaintenance: unknown;
  accountMaintenanceVersion: number;
};
/** Shared BEFORE slot/runtime locks, including a newly inserted agent slot.
 * Account maintenance applies to the fixed workspace credential root, not one
 * historical registration. No caller chooses the lock key or credential path. */
export async function lockAccountMaintenanceWorkspace(tx: Tx, scope: WorkspaceScope) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hive-account-maintenance-v1:${scope.hiveUserId}:${scope.coderOrigin}:${scope.workspaceId}`},0))`;
}
export function parseAccountMaintenance(value: unknown): AccountMaintenanceState | null {
  return value === null || value === undefined ? null : accountMaintenanceStateSchema.parse(value);
}
export async function assertAccountMaintenanceAdmission(
  tx: Tx,
  scope: WorkspaceScope,
  operation:
    | { kind: "enroll"; empty: boolean }
    | { kind: "native"; runtimeId: string; projectId?: string; preparationIntentId?: string },
) {
  await lockAccountMaintenanceWorkspace(tx, scope);
  const slots = await tx.codexHostSlot.findMany({
    where: {
      ownerId: scope.hiveUserId,
      coderOrigin: scope.coderOrigin,
      workspaceId: scope.workspaceId,
    },
  });
  for (const slot of slots) {
    const held = parseAccountMaintenance(slot.accountMaintenance);
    if (!held || held.phase === "finished") continue;
    requireValue(
      held.ownerId === scope.hiveUserId &&
        held.workspaceId === scope.workspaceId &&
        held.coderOrigin === scope.coderOrigin,
    );
    if (operation.kind === "enroll") {
      // Only a new EMPTY host may enroll while parked. Prepare/native launch is
      // separately fenced below; this never grants a managed credential reader.
      requireValue(operation.empty && (held.phase === "ready" || held.phase === "resuming"));
    } else {
      requireValue(held.phase === "resuming" && held.idleRuntimeId === operation.runtimeId);
      if (operation.projectId !== undefined)
        requireValue(
          held.projects.some(
            (p) =>
              p.projectId === operation.projectId &&
              (!operation.preparationIntentId ||
                p.preparationIntentId === operation.preparationIntentId),
          ),
        );
    }
  }
}
const view = (slot: Slot | null, runtime?: { id: string; generation: number }) => {
  const state = parseAccountMaintenance(slot?.accountMaintenance);
  return accountMaintenanceViewSchema.parse({
    schemaVersion: 1,
    version: slot?.accountMaintenanceVersion ?? 0,
    maintenanceId: state?.id ?? null,
    state: state?.phase ?? "available",
    holdReason: state?.holdReason ?? null,
    runtimeId: runtime?.id ?? null,
    runtimeGeneration: runtime?.generation ?? null,
  });
};

/** Existing DB/guardian authority remains operator-trusted. This store records
 * owner intent and the exact parked cohort; no model/tool gets a stop decision. */
export class AccountMaintenanceStore {
  constructor(private readonly db: PrismaClient) {}
  private transaction<T>(run: (tx: Tx) => Promise<T>) {
    return this.db.$transaction(run, {
      isolationLevel: "Serializable",
      maxWait: 5000,
      timeout: 10000,
    });
  }
  private async slots(tx: Tx, binding: RegistrationBinding) {
    await lockAccountMaintenanceWorkspace(tx, binding);
    const user = await tx.user.findUnique({ where: { id: binding.hiveUserId } });
    requireValue(user?.coderUserId === binding.ownerId && user.coderUrl === binding.coderOrigin);
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM codex_host_slots
      WHERE owner_id=${binding.hiveUserId}::uuid AND coder_origin=${binding.coderOrigin}
      AND workspace_id=${binding.workspaceId}::uuid ORDER BY id FOR UPDATE`;
    requireValue(rows.length > 0 && rows.length <= 16);
    const slots = await tx.codexHostSlot.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      orderBy: { id: "asc" },
    });
    requireValue(slots.every((s) => s.coderOwnerId === binding.ownerId));
    return slots;
  }
  private async save(tx: Tx, slots: Slot[], state: AccountMaintenanceState) {
    const parsed = accountMaintenanceStateSchema.parse(state);
    for (const slot of slots)
      await tx.codexHostSlot.update({
        where: { id: slot.id },
        data: {
          accountMaintenance: parsed as unknown as Prisma.InputJsonObject,
          accountMaintenanceVersion: { increment: 1 },
        },
      });
  }
  async status(binding: RegistrationBinding) {
    return this.transaction(async (tx) => {
      const slot = (await this.slots(tx, binding)).find((s) => s.agentId === binding.agentId);
      requireValue(slot);
      const runtime = await tx.codexGuardianRuntime.findMany({
        where: {
          ownerId: binding.hiveUserId,
          slotId: slot.id,
          buildId: binding.buildId,
          phase: "open",
        },
        take: 2,
      });
      requireValue(runtime.length <= 1);
      const publicView = view(slot, runtime[0]),
        state = parseAccountMaintenance(slot.accountMaintenance);
      if (state?.phase === "finished" && state.idleRuntimeId) {
        const bindings = await tx.deliveryManagerBinding.findMany({
          where: { ownerId: binding.hiveUserId, executionEpochRuntimeId: state.idleRuntimeId },
          take: 33,
        });
        requireValue(bindings.length <= 32);
        for (const b of bindings) {
          if (!b.currentAttemptId || !b.executionEpochResumeEventId) continue;
          const event = await tx.deliveryEvent.findUniqueOrThrow({
            where: { id: b.executionEpochResumeEventId },
          });
          const scope = maintenanceResumeScopeSchema.parse(event.payload);
          if (b.currentAttemptId !== scope.currentAttemptId) continue; // A new claim uses normal task status.
          const prior = await tx.deliveryAttempt.findUniqueOrThrow({
            where: { id: b.currentAttemptId },
          });
          if (!["reported", "succeeded"].includes(prior.outcome))
            publicView.holdReason = "external-outcome-unknown";
        }
      }
      return publicView;
    });
  }
  /** Called only after owner session + CSRF validation and fresh Coder binding
   * resolution. No host/model envelope accepts this action. The empty host is a
   * new actor; the retained native thread and first prompt stay provenance. */
  async requestResume(
    binding: RegistrationBinding,
    input: {
      requestId: string;
      expectedVersion: number;
      maintenanceId: string;
    },
    rawArchive: unknown,
  ) {
    return this.transaction(async (tx) => {
      const slots = await this.slots(tx, binding);
      const selected = slots.find((s) => s.agentId === binding.agentId);
      requireValue(selected);
      const state = parseAccountMaintenance(selected.accountMaintenance);
      requireValue(state && state.id === input.maintenanceId && state.buildId === binding.buildId);
      requireValue(
        slots.every((s) => guardianDigest(s.accountMaintenance) === guardianDigest(state)),
      );
      if (state.resumeRequestId === input.requestId) {
        requireValue(state.resumeIntentRuntimeId && state.resumeIntentEventId);
        const saved = await tx.codexGuardianOperationReceipt.findUnique({
          where: {
            ownerId_runtimeId_eventId: {
              ownerId: binding.hiveUserId,
              runtimeId: state.resumeIntentRuntimeId,
              eventId: state.resumeIntentEventId,
            },
          },
        });
        requireValue(saved?.action === "maintenance_resume_intent");
        return view(selected);
      }
      requireValue(
        state.phase === "ready" &&
          !state.resumeRequestId &&
          selected.accountMaintenanceVersion === input.expectedVersion,
      );
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM codex_guardian_runtimes
        WHERE owner_id=${binding.hiveUserId}::uuid AND workspace_id=${binding.workspaceId}::uuid
        ORDER BY id FOR UPDATE`;
      const runtimes = await tx.codexGuardianRuntime.findMany({
        where: { id: { in: locked.map((r) => r.id) } },
      });
      const open = runtimes.filter((r) => r.phase !== "tree_closed");
      requireValue(open.length === 1);
      const idle = open[0];
      requireValue(
        idle.phase === "open" &&
          idle.slotId === selected.id &&
          idle.buildId === binding.buildId &&
          !idle.producerApproved &&
          !idle.nativeLaunchId &&
          !idle.serverInstanceId &&
          (await tx.codexGuardianAdmission.count({
            where: { ownerId: binding.hiveUserId, runtimeId: idle.id },
          })) === 0,
      );
      const archive = maintenanceArchiveSchema.parse(rawArchive);
      const { proof, ...archiveBody } = archive;
      const key = createPublicKey(idle.outerPublicKeyPem);
      requireValue(
        key.asymmetricKeyType === "ed25519" &&
          verify(
            null,
            Buffer.from(`hive-account-maintenance-archive-v1\n${guardianCanonical(archiveBody)}`),
            key,
            Buffer.from(proof, "base64url"),
          ) &&
          archive.ownerId === binding.hiveUserId &&
          archive.workspaceId === binding.workspaceId &&
          archive.buildId === binding.buildId &&
          archive.maintenanceId === state.id &&
          archive.maintenanceVersion === selected.accountMaintenanceVersion &&
          archive.requestId === input.requestId &&
          archive.runtimeId === idle.id &&
          archive.runtimeGeneration === idle.generation &&
          archive.expiresAt > archive.issuedAt &&
          archive.expiresAt - archive.issuedAt <= 30000 &&
          archive.projects.length === state.projects.length &&
          new Set(archive.projects.map((p) => p.preparationIntentId)).size ===
            state.projects.length,
      );
      const projects: MaintenanceOwnerResume["projects"] = [];
      for (const parked of state.projects) {
        const old = runtimes.filter((r) => state.runtimes.some((p) => p.runtimeId === r.id));
        const admissions = await tx.codexGuardianAdmission.findMany({
          where: {
            ownerId: binding.hiveUserId,
            runtimeId: { in: old.map((r) => r.id) },
            preparationIntentId: parked.preparationIntentId,
          },
        });
        requireValue(admissions.length === 1);
        const admission = admissions[0],
          prior = old.find((r) => r.id === admission.runtimeId);
        requireValue(
          prior?.phase === "tree_closed" && prior.closedBarrierId && admission.phase === "native",
        );
        const barrier = await tx.codexGuardianBarrier.findUniqueOrThrow({
          where: { id: prior.closedBarrierId },
        });
        const trees = await tx.$queryRaw<
          { receiptId: string; digest: string }[]
        >`SELECT receipt_id AS "receiptId",digest FROM codex_guardian_tree_receipts WHERE owner_id=${binding.hiveUserId}::uuid AND runtime_id=${prior.id}::uuid AND barrier_id=${barrier.id}::uuid`;
        const decision = await tx.codexGuardianStopDecision.findUniqueOrThrow({
          where: {
            ownerId_barrierId_admissionId: {
              ownerId: binding.hiveUserId,
              barrierId: barrier.id,
              admissionId: admission.id,
            },
          },
        });
        requireValue(
          barrier.purpose === "account-maintenance" &&
            barrier.maintenanceId === state.id &&
            trees.length === 1 &&
            state.barrierIds.includes(barrier.id) &&
            state.treeReceiptDigests.includes(trees[0].digest),
        );
        const fact = decision.state as Record<string, unknown>;
        const observation = accountMaintenanceIdleSnapshotSchema.parse(fact.observation);
        const archived = archive.projects.find(
          (p) => p.preparationIntentId === parked.preparationIntentId,
        );
        requireValue(
          archived &&
            archived.nativeThreadId === parked.nativeThreadId &&
            archived.checkoutDigest === parked.checkoutDigest &&
            archived.leaseId === parked.leaseId &&
            archived.leaseGeneration === parked.leaseGeneration &&
            archived.firstPromptRequestId === observation.firstPromptRequestId &&
            archived.firstPromptDigest === observation.firstPromptDigest &&
            archived.historyDigest === observation.historyDigest &&
            fact.purpose === "account-maintenance" &&
            fact.maintenanceId === state.id &&
            fact.writerCleanupAuthorized === false &&
            guardianDigest(decision.state) === decision.stateDigest &&
            observation.rootTurns > 0 &&
            observation.admissionId === admission.id &&
            observation.managerThreadId === parked.nativeThreadId &&
            admission.nativeThreadId === parked.nativeThreadId &&
            admission.leaseId === parked.leaseId &&
            admission.leaseGeneration === parked.leaseGeneration &&
            guardianDigest(admission.checkoutBinding) === parked.checkoutDigest,
        );
        await tx.$queryRaw`SELECT id FROM project_task_intents WHERE owner_id=${binding.hiveUserId}::uuid
          AND id=${parked.preparationIntentId}::uuid FOR UPDATE`;
        const intent = await tx.projectTaskIntent.findUniqueOrThrow({
          where: { id: parked.preparationIntentId },
        });
        requireValue(
          intent.ownerId === binding.hiveUserId &&
            intent.workspaceId === binding.workspaceId &&
            intent.projectId === parked.projectId &&
            intent.requestId === observation.firstPromptRequestId &&
            intent.requestDigest === admission.intentRequestDigest &&
            intent.phase !== "blocked",
        );
        projects.push({
          ...parked,
          requestId: intent.requestId,
          requestDigest: intent.requestDigest,
          sourceSha: intent.sourceSha,
          firstPromptRequestId: observation.firstPromptRequestId,
          firstPromptDigest: observation.firstPromptDigest,
          historyDigest: observation.historyDigest,
          oldRuntimeId: prior.id,
          oldBarrierId: barrier.id,
          oldTreeReceiptId: trees[0].receiptId,
          oldTreeReceiptDigest: trees[0].digest,
        });
      }
      const root = runtimes.find((r) => r.id === projects[0].oldRuntimeId);
      requireValue(root?.operationReceiptsEnabled);
      const admission = await tx.codexGuardianAdmission.findFirstOrThrow({
        where: {
          ownerId: binding.hiveUserId,
          runtimeId: root.id,
          preparationIntentId: projects[0].preparationIntentId,
        },
      });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      requireValue(idle.authorityUntil > clock.now);
      requireValue(
        archive.issuedAt <= clock.now.getTime() && archive.expiresAt > clock.now.getTime(),
      );
      const eventId = randomUUID();
      const resume = maintenanceOwnerResumeSchema.parse({
        schemaVersion: 1,
        purpose: "maintenance_resume_intent",
        ownerId: binding.hiveUserId,
        workspaceId: binding.workspaceId,
        buildId: binding.buildId,
        slotId: selected.id,
        maintenanceId: state.id,
        maintenanceVersion: selected.accountMaintenanceVersion + 1,
        requestId: input.requestId,
        idleRuntimeId: idle.id,
        idleRuntimeGeneration: idle.generation,
        parkedJournalDigest: archive.parkedJournalDigest,
        projects,
      });
      const response = {
        runtime: { id: root.id, ownerId: root.ownerId, generation: root.generation },
        admission: { id: admission.id, runtimeId: root.id, generation: admission.generation },
        maintenance: resume,
      };
      await this.save(tx, slots, {
        ...state,
        phase: "resuming",
        idleRuntimeId: idle.id,
        resumeRequestId: input.requestId,
        resumeIntentRuntimeId: root.id,
        resumeIntentEventId: eventId,
      });
      await tx.codexGuardianOperationReceipt.create({
        data: {
          ownerId: binding.hiveUserId,
          runtimeId: root.id,
          eventId,
          action: "maintenance_resume_intent",
          requestDigest: guardianDigest(resume),
          inputRuntimeGeneration: root.generation,
          resultRuntimeGeneration: root.generation,
          resultAdmissionGeneration: admission.generation,
          response: response as unknown as Prisma.InputJsonObject,
          responseDigest: guardianDigest(response),
          lifetimeId: root.lifetimeId,
          buildId: root.buildId,
          configSha256: root.configSha256,
          outerKeyFingerprint: root.outerKeyFingerprint,
        },
      });
      const [settled] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      requireValue(idle.authorityUntil > settled.now);
      requireValue(archive.expiresAt > settled.now.getTime());
      return view({
        ...selected,
        accountMaintenance: {
          ...state,
          phase: "resuming",
          idleRuntimeId: idle.id,
          resumeRequestId: input.requestId,
          resumeIntentRuntimeId: root.id,
          resumeIntentEventId: eventId,
        },
        accountMaintenanceVersion: selected.accountMaintenanceVersion + 1,
      });
    });
  }
  async request(
    binding: RegistrationBinding,
    input: {
      requestId: string;
      expectedVersion: number;
      runtimeId: string;
      runtimeGeneration: number;
    },
  ) {
    return this.transaction(async (tx) => {
      const slots = await this.slots(tx, binding),
        selected = slots.find((s) => s.agentId === binding.agentId);
      requireValue(selected);
      const prior = parseAccountMaintenance(selected.accountMaintenance);
      if (prior?.id === input.requestId) {
        requireValue(
          prior.buildId === binding.buildId &&
            prior.runtimes.some(
              (r) =>
                r.runtimeId === input.runtimeId && r.runtimeGeneration === input.runtimeGeneration,
            ),
        );
        return view(selected);
      }
      requireValue(
        selected.accountMaintenanceVersion === input.expectedVersion &&
          slots.every(
            (s) =>
              !s.accountMaintenance ||
              parseAccountMaintenance(s.accountMaintenance)?.phase === "finished",
          ),
      );
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM codex_guardian_runtimes
        WHERE owner_id=${binding.hiveUserId}::uuid AND workspace_id=${binding.workspaceId}::uuid
        AND phase <> 'tree_closed' ORDER BY id FOR UPDATE`;
      requireValue(rows.length > 0 && rows.length <= 16);
      const runtimes = await tx.codexGuardianRuntime.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        orderBy: { id: "asc" },
      });
      requireValue(
        runtimes.every(
          (r) =>
            r.phase === "open" &&
            r.buildId === binding.buildId &&
            slots.some((s) => s.id === r.slotId),
        ) &&
          runtimes.some(
            (r) =>
              r.id === input.runtimeId &&
              r.generation === input.runtimeGeneration &&
              r.slotId === selected.id,
          ),
      );
      const admissions = await tx.codexGuardianAdmission.findMany({
        where: {
          ownerId: binding.hiveUserId,
          runtimeId: { in: runtimes.map((r) => r.id) },
        },
        orderBy: { id: "asc" },
      });
      requireValue(
        admissions.length > 0 &&
          admissions.length <= 32 &&
          admissions.every(
            (a) =>
              a.phase === "native" &&
              a.nativeThreadId &&
              a.leaseId &&
              a.leaseGeneration &&
              a.checkoutBinding,
          ),
      );
      const ids = await tx.$queryRaw<{ id: string }[]>`SELECT t.id FROM delivery_tasks t
        JOIN delivery_manager_bindings m ON m.owner_id=t.owner_id AND m.id=t.manager_binding_id
        WHERE t.owner_id=${binding.hiveUserId}::uuid AND m.preparation_intent_id IN
          (SELECT preparation_intent_id FROM codex_guardian_admissions WHERE owner_id=${binding.hiveUserId}::uuid AND runtime_id IN
            (SELECT id FROM codex_guardian_runtimes WHERE owner_id=${binding.hiveUserId}::uuid AND workspace_id=${binding.workspaceId}::uuid AND phase<>'tree_closed'))
        ORDER BY t.id FOR UPDATE OF t`;
      requireValue(ids.length <= 32);
      const tasks = await tx.deliveryTask.findMany({
        where: { ownerId: binding.hiveUserId, id: { in: ids.map((r) => r.id) } },
        orderBy: { id: "asc" },
      });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const state = accountMaintenanceStateSchema.parse({
        schemaVersion: 1,
        purpose: "account-maintenance",
        id: input.requestId,
        ownerId: binding.hiveUserId,
        coderOwnerId: binding.ownerId,
        coderOrigin: binding.coderOrigin,
        workspaceId: binding.workspaceId,
        buildId: binding.buildId,
        phase: "requested",
        requestedAt: clock.now.toISOString(),
        runtimes: runtimes.map((r) => ({
          runtimeId: r.id,
          runtimeGeneration: r.generation,
          lifetimeId: r.lifetimeId,
          buildId: r.buildId,
          configSha256: r.configSha256,
        })),
        tasks: tasks.map((t) => ({
          taskId: t.id,
          version: t.version,
          sourceVersion: t.sourceVersion,
          pauseRequested: t.pauseRequested,
          schedulingPaused: t.schedulingPaused,
          pauseEventId: randomUUID(),
        })),
        projects: admissions.map((a) => ({
          projectId: a.projectId,
          preparationIntentId: a.preparationIntentId,
          nativeThreadId: a.nativeThreadId,
          leaseId: a.leaseId,
          leaseGeneration: a.leaseGeneration,
          checkoutDigest: guardianDigest(a.checkoutBinding),
        })),
        barrierIds: [],
        treeReceiptDigests: [],
        idleRuntimeId: null,
        resumeRequestId: null,
        resumeIntentRuntimeId: null,
        resumeIntentEventId: null,
        holdReason: null,
      });
      for (const task of tasks) {
        const snapshot = state.tasks.find((t) => t.taskId === task.id);
        requireValue(snapshot);
        if (snapshot.pauseRequested) continue;
        const running = await tx.deliveryAttempt.count({
          where: { ownerId: binding.hiveUserId, step: { taskId: task.id }, outcome: "running" },
        });
        await tx.deliveryTask.update({
          where: { id: task.id },
          data: {
            pauseRequested: true,
            schedulingPaused: running === 0,
            version: { increment: 1 },
          },
        });
        await tx.deliveryEvent.create({
          data: {
            id: snapshot.pauseEventId,
            ownerId: binding.hiveUserId,
            taskId: task.id,
            aggregateKey: `task/${task.id}`,
            aggregateVersion: task.version + 1,
            type: "pause_requested",
            requestDigest: guardianDigest({
              purpose: state.purpose,
              id: state.id,
              taskId: task.id,
            }),
            payload: { paused: true, reason: "account-maintenance", maintenanceId: state.id },
            policyVersion: "account-maintenance-v1",
          },
        });
      }
      await this.save(tx, slots, state);
      return view({
        ...selected,
        accountMaintenance: state,
        accountMaintenanceVersion: selected.accountMaintenanceVersion + 1,
      });
    });
  }
}

/** Called only inside existing locked guardian closure transactions. */
export async function updateAccountMaintenanceState(tx: Tx, state: AccountMaintenanceState) {
  const parsed = accountMaintenanceStateSchema.parse(state);
  const slots = await tx.codexHostSlot.findMany({
    where: {
      ownerId: parsed.ownerId,
      coderOrigin: parsed.coderOrigin,
      workspaceId: parsed.workspaceId,
    },
  });
  for (const slot of slots) {
    if (guardianDigest(slot.accountMaintenance) === guardianDigest(parsed)) continue;
    await tx.codexHostSlot.update({
      where: { id: slot.id },
      data: {
        accountMaintenance: parsed as unknown as Prisma.InputJsonObject,
        accountMaintenanceVersion: { increment: 1 },
      },
    });
  }
}

export async function accountMaintenanceTreeClosed(
  tx: Tx,
  runtimeId: string,
  scope: WorkspaceScope,
) {
  const slots = await tx.codexHostSlot.findMany({
    where: {
      ownerId: scope.hiveUserId,
      coderOrigin: scope.coderOrigin,
      workspaceId: scope.workspaceId,
    },
  });
  const held = parseAccountMaintenance(slots[0]?.accountMaintenance);
  requireValue(held);
  requireValue(
    held?.runtimes.some((r) => r.runtimeId === runtimeId) &&
      slots.every(
        (s) =>
          guardianDigest(parseAccountMaintenance(s.accountMaintenance)) === guardianDigest(held),
      ),
  );
  const rows = await tx.$queryRaw<{ runtimeId: string; barrierId: string; digest: string }[]>`
    SELECT r.id AS "runtimeId",b.id AS "barrierId",q.digest
    FROM codex_guardian_runtimes r JOIN codex_guardian_barriers b ON b.owner_id=r.owner_id AND b.id=r.closed_barrier_id
    JOIN codex_guardian_tree_receipts q ON q.owner_id=r.owner_id AND q.runtime_id=r.id AND q.barrier_id=b.id
    WHERE r.owner_id=${scope.hiveUserId}::uuid AND r.phase='tree_closed' AND b.purpose='account-maintenance'
      AND b.maintenance_id=${held.id}::uuid ORDER BY r.id`;
  requireValue(
    rows.length <= held.runtimes.length &&
      rows.every((r) => held.runtimes.some((p) => p.runtimeId === r.runtimeId)),
  );
  if (
    rows.length !== held.runtimes.length ||
    ["ready", "resuming", "finished"].includes(held.phase)
  )
    return;
  const ready = accountMaintenanceStateSchema.parse({
    ...held,
    phase: "ready",
    barrierIds: rows.map((r) => r.barrierId),
    treeReceiptDigests: rows.map((r) => r.digest),
    holdReason: null,
  });
  await updateAccountMaintenanceState(tx, ready);
  // Retain old registration/history rows and all writer anchors. Only the pointer
  // and input generation retire AFTER verified physical closure, so the existing
  // outer can enroll an empty host with zero native credential readers.
  await tx.codexHostSlot.updateMany({
    where: { id: { in: slots.map((s) => s.id) } },
    data: {
      activeRegistrationId: null,
      generation: { increment: 1 },
    },
  });
}
