import type { Prisma } from "@hive/db";
import type { WorkspaceResource } from "@/lib/coder/types";
import { type GuardianCheckout, type GuardianPolicy, guardianDigest } from "./guardian-contracts";
import {
  type GuardianRemountAttestation,
  type GuardianTransferContinuation,
  guardianRemountAttestationSchema,
  guardianRemountEnrollments,
  guardianRemountTicketSchema,
  guardianTransferContinuationSchema,
} from "./guardian-remount-contracts";
import type { GuardianRuntimeIdentity } from "./guardian-store.server";
import type { GuardianUnstartedTransfer } from "./guardian-unstarted-contracts";
import type { RegistrationBinding } from "./registration.server";
import { RegistrationRejected } from "./registration-store.server";

const check: (v: unknown) => asserts v = (v) => {
  if (!v) throw new RegistrationRejected();
};
export function resolveRemountAttestation(input: {
  proof: GuardianUnstartedTransfer;
  continuation: GuardianTransferContinuation;
  binding: RegistrationBinding;
  identity: GuardianRuntimeIdentity;
  policy: GuardianPolicy;
  enrollments: readonly GuardianRemountAttestation[];
  now?: number;
}) {
  const p = input.proof,
    c = guardianTransferContinuationSchema.parse(input.continuation),
    b = input.binding,
    h = c.unusedEpochHop,
    f = c.finalSuccessor;
  check(
    c.originalProofDigest === guardianDigest(p) &&
      h.originalProofDigest === c.originalProofDigest &&
      h.buildId === p.newBuildId &&
      h.configSha256 === p.newConfigSha256 &&
      h.packageManifestSha256 === p.newPackageManifestSha256 &&
      h.buildId !== f.buildId &&
      p.oldBuildId !== f.buildId &&
      h.lifetimeId !== f.lifetimeId &&
      p.oldLifetimeId !== h.lifetimeId &&
      p.oldLifetimeId !== f.lifetimeId,
  );
  check(
    f.buildId === b.buildId &&
      f.lifetimeId === input.identity.lifetimeId &&
      f.configSha256 === input.identity.configSha256 &&
      f.packageManifestSha256 === input.identity.packageManifestSha256 &&
      input.policy.packages.some((pin) => pin.packageManifestSha256 === h.packageManifestSha256),
  );
  const matches = input.enrollments.filter(
    (a) => a.ownerId === b.hiveUserId && a.taskId === p.taskId,
  );
  check(matches.length === 1);
  const a = guardianRemountAttestationSchema.parse(matches[0]);
  check(
    a.expiresAt > (input.now ?? Date.now()) &&
      a.coderOwnerId === b.ownerId &&
      a.workspaceId === b.workspaceId &&
      a.templateId === b.templateId &&
      a.projectId === p.projectId &&
      a.originalProofDigest === c.originalProofDigest &&
      a.oldBuildId === p.oldBuildId &&
      a.oldLifetimeId === p.oldLifetimeId &&
      guardianDigest(a.held) ===
        guardianDigest({
          buildId: h.buildId,
          lifetimeId: h.lifetimeId,
          configSha256: h.configSha256,
          packageManifestSha256: h.packageManifestSha256,
        }) &&
      guardianDigest(a.heldJournalDigests) === guardianDigest(h.oldJournalDigests) &&
      guardianDigest(a.final) === guardianDigest(f) &&
      a.volume.pvcName === `coder-${b.workspaceId}-home` &&
      a.volume.boundVolumeName === `pvc-${a.volume.pvcUid}` &&
      guardianDigest(a.mapping.old.checkout) === guardianDigest(p.checkout.checkoutIdentity),
  );
  return a;
}
export function verifyRemountResources(
  resources: WorkspaceResource[],
  a: GuardianRemountAttestation,
  agentId: string,
) {
  // Only the current, agent-bearing deployment resource can corroborate its actual
  // mount; an unrelated claim/custom resource with matching labels is insufficient.
  const rows = resources.filter(
    (r) => r.type === "kubernetes_deployment_v1" && r.name === "workspace",
  );
  check(
    rows.length === 1 &&
      rows[0].agents?.length === 1 &&
      rows[0].agents[0].id === agentId &&
      resources.flatMap((r) => r.agents ?? []).filter((agent) => agent.id === agentId).length === 1,
  );
  const metadata = rows[0].metadata ?? [],
    items = metadata.filter((m) => m.key === "hive_home_volume_v1");
  check(
    items.length === 1 &&
      !items[0].sensitive &&
      typeof items[0].value === "string" &&
      items[0].value.length <= 2048,
  );
  const value = items[0].value;
  check(typeof value === "string");
  check(guardianDigest(JSON.parse(value)) === guardianDigest(a.volume));
}
export async function assertUnusedIntermediate(
  tx: Prisma.TransactionClient,
  ownerId: string,
  workspaceId: string,
  c: GuardianTransferContinuation,
) {
  const h = c.unusedEpochHop;
  // reserveRuntime already holds the maintenance workspace advisory. Every
  // runtime/enrollment/admission needs that same fence; even closed history holds.
  const rows = await tx.$queryRaw<
    { present: boolean }[]
  >`SELECT EXISTS(SELECT 1 FROM codex_guardian_runtimes WHERE owner_id=${ownerId}::uuid AND workspace_id=${workspaceId}::uuid AND (build_id=${h.buildId}::uuid OR lifetime_id=${h.lifetimeId}::uuid)) OR EXISTS(SELECT 1 FROM codex_host_registrations r JOIN codex_host_slots s ON s.owner_id=r.owner_id AND s.id=r.slot_id WHERE r.owner_id=${ownerId}::uuid AND s.workspace_id=${workspaceId}::uuid AND r.build_id=${h.buildId}::uuid) OR EXISTS(SELECT 1 FROM codex_registration_grants g JOIN codex_host_slots s ON s.owner_id=g.owner_id AND s.id=g.slot_id WHERE g.owner_id=${ownerId}::uuid AND s.workspace_id=${workspaceId}::uuid AND g.binding->>'buildId'=${h.buildId}) AS present`;
  check(rows.length === 1 && !rows[0].present);
}
export async function readRemountRecoveryTicket(
  tx: Prisma.TransactionClient,
  env: Record<string, string | undefined>,
  scope: {
    ownerId: string;
    workspaceId: string;
    projectId: string;
    taskId: string;
    recoveryId: string;
  },
) {
  const events = await tx.codexGuardianOperationReceipt.findMany({
    where: {
      ownerId: scope.ownerId,
      action: "authorization_retired",
      response: { path: ["retirement", "recoveryId"], equals: scope.recoveryId },
    },
    take: 2,
  });
  const matching = events.filter((e) => {
    const r = (e.response as Prisma.JsonObject).retirement as Prisma.JsonObject;
    return r?.recoveryId === scope.recoveryId;
  });
  check(matching.length <= 1);
  if (!matching.length) return undefined;
  const r = (matching[0].response as Prisma.JsonObject).retirement as Prisma.JsonObject;
  if (!r.continuation) return undefined;
  const c = guardianTransferContinuationSchema.parse(r.continuation),
    a = guardianRemountEnrollments(env).find((a) => guardianDigest(a) === r.attestationDigest);
  check(
    a &&
      guardianDigest(a) === r.attestationDigest &&
      guardianDigest(c) === r.continuationDigest &&
      a.expiresAt > Date.now() &&
      a.ownerId === scope.ownerId &&
      a.workspaceId === scope.workspaceId &&
      a.projectId === scope.projectId &&
      a.taskId === scope.taskId &&
      guardianDigest(a.final) === guardianDigest(c.finalSuccessor),
  );
  return guardianRemountTicketSchema.parse({
    attestationDigest: guardianDigest(a),
    continuationDigest: guardianDigest(c),
    originalProofDigest: c.originalProofDigest,
    recoveryId: scope.recoveryId,
    ownerId: scope.ownerId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    taskId: scope.taskId,
    final: a.final,
    volume: a.volume,
    mapping: a.mapping,
    expiresAt: a.expiresAt,
  });
}

/** Remount changes only the attested physical identity. Original lease generation,
 * incarnation, source and task stay exact even under a valid new host signature. */
export async function assertRemountCheckout(
  tx: Prisma.TransactionClient,
  runtime: { ownerId: string; id: string; lifetimeId: string },
  checkout: GuardianCheckout,
) {
  const events = await tx.codexGuardianOperationReceipt.findMany({
    where: {
      ownerId: runtime.ownerId,
      action: "authorization_retired",
      response: { path: ["retirement", "newLifetimeId"], equals: runtime.lifetimeId },
    },
    take: 2,
  });
  check(events.length <= 1);
  if (!events.length) return;
  const retirement = (events[0].response as Prisma.JsonObject).retirement as Prisma.JsonObject;
  if (!retirement.continuation) return;
  const a = guardianRemountAttestationSchema.parse(retirement.attestation),
    proof = retirement.proof as Prisma.JsonObject;
  const original = proof.checkout as Prisma.JsonObject;
  check(
    guardianDigest(a) === retirement.attestationDigest &&
      guardianDigest(checkout) ===
        guardianDigest({ ...original, checkoutIdentity: a.mapping.current.checkout }),
  );
}
