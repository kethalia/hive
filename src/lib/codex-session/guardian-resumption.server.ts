import type { Prisma } from "@hive/db";
import type { RecoveryScope } from "../projects/task-recovery-contracts";
import { guardianDigest } from "./guardian-contracts";
import {
  guardianRemountEnrollments,
  guardianRemountTicketSchema,
  guardianTransferContinuationSchema,
} from "./guardian-remount-contracts";
import { guardianResumptionApprovals } from "./guardian-resumption-contracts";
import { RegistrationRejected } from "./registration-store.server";

const check: (v: unknown) => asserts v = (v) => {
  if (!v) throw new RegistrationRejected();
};
export async function readRecoveryResumption(
  db: Prisma.TransactionClient,
  env: Record<string, string | undefined>,
  scope: Pick<RecoveryScope, "ownerId" | "workspaceId" | "projectId" | "taskId" | "recoveryId">,
) {
  const approval = guardianResumptionApprovals(env).find(
    (a) => a.ownerId === scope.ownerId && a.recoveryId === scope.recoveryId,
  );
  if (!approval) return undefined;
  const [clock] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  check(
    approval.issuedAt <= clock.now.getTime() &&
      approval.expiresAt > clock.now.getTime() &&
      approval.workspaceId === scope.workspaceId &&
      approval.projectId === scope.projectId &&
      approval.taskId === scope.taskId,
  );
  const events = await db.codexGuardianOperationReceipt.findMany({
    where: {
      ownerId: scope.ownerId,
      eventId: approval.retirementEventId,
      action: "authorization_retired",
    },
    take: 2,
  });
  check(events.length === 1);
  const retirement = (events[0].response as Prisma.JsonObject).retirement as Prisma.JsonObject;
  const attestation = guardianRemountEnrollments(env).find(
    (a) => guardianDigest(a) === approval.attestationDigest,
  );
  const continuation = guardianTransferContinuationSchema.parse(retirement.continuation);
  const runtime = await db.codexGuardianRuntime.findUnique({
    where: { ownerId_id: { ownerId: scope.ownerId, id: approval.runtimeId } },
  });
  check(
    attestation &&
      runtime &&
      retirement.recoveryId === scope.recoveryId &&
      retirement.attestationDigest === approval.attestationDigest &&
      guardianDigest(retirement.attestation) === approval.attestationDigest &&
      guardianDigest(continuation) === approval.continuationDigest &&
      retirement.continuationDigest === approval.continuationDigest &&
      retirement.newLifetimeId === runtime.lifetimeId &&
      guardianDigest(retirement.newBinding) === guardianDigest(runtime.binding) &&
      attestation.ownerId === scope.ownerId &&
      attestation.coderOwnerId === approval.coderOwnerId &&
      attestation.workspaceId === scope.workspaceId &&
      attestation.projectId === scope.projectId &&
      attestation.taskId === scope.taskId &&
      guardianDigest(attestation.final) === guardianDigest(approval.final) &&
      guardianDigest(continuation.finalSuccessor) === guardianDigest(approval.final) &&
      runtime.buildId === approval.final.buildId &&
      runtime.lifetimeId === approval.final.lifetimeId &&
      runtime.configSha256 === approval.final.configSha256 &&
      runtime.packageManifestSha256 === approval.final.packageManifestSha256,
  );
  const ticket = guardianRemountTicketSchema.parse({
    attestationDigest: approval.attestationDigest,
    continuationDigest: approval.continuationDigest,
    originalProofDigest: continuation.originalProofDigest,
    recoveryId: scope.recoveryId,
    ownerId: scope.ownerId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    taskId: scope.taskId,
    final: attestation.final,
    volume: attestation.volume,
    mapping: attestation.mapping,
    // This deadline is explicitly approved separately; the original digest/record
    // remains the legacy evidence pinned by the installed enrollment ACK.
    expiresAt: approval.expiresAt,
  });
  return { approval, attestation, continuation, runtime, retirement, ticket };
}

/** Ordinary ticket consumers may use an extension only after its atomic renewal.
 * Revocation or alteration of either operator enrollment still fails closed. */
export async function resumedRecoveryTicket(
  db: Prisma.TransactionClient,
  env: Record<string, string | undefined>,
  scope: Parameters<typeof readRecoveryResumption>[2],
) {
  const context = await readRecoveryResumption(db, env, scope);
  if (!context) return undefined;
  const receipt = await db.codexGuardianOperationReceipt.findUnique({
    where: {
      ownerId_runtimeId_eventId: {
        ownerId: scope.ownerId,
        runtimeId: context.runtime.id,
        eventId: context.approval.id,
      },
    },
  });
  check(
    receipt &&
      receipt.action === "unused_recovery_resumed" &&
      receipt.requestDigest === guardianDigest(context.approval),
  );
  const r = (receipt.response as Prisma.JsonObject).resumption as Prisma.JsonObject;
  check(
    guardianDigest(r.ticket) === guardianDigest(context.ticket) &&
      r.recoveryId === scope.recoveryId,
  );
  return context.ticket;
}
