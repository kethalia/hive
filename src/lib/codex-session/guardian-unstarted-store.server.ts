import { createHash, createPublicKey, verify } from "node:crypto";
import type { CodexGuardianRuntime, Prisma } from "@hive/db";
import {
  type GuardianPolicy,
  guardianCanonical,
  guardianDigest,
  preparationDigest,
} from "./guardian-contracts";
import type { GuardianRuntimeIdentity } from "./guardian-store.server";
import {
  type GuardianUnstartedTransfer,
  guardianUnstartedTransferSchema,
} from "./guardian-unstarted-contracts";
import type { RegistrationBinding } from "./registration.server";
import { RegistrationRejected } from "./registration-store.server";

type Tx = Prisma.TransactionClient;
type ControllerState = {
  schemaVersion?: number;
  identityDigest?: string;
  runtimeId?: string;
  lifetimeId?: string;
  generation?: number;
  pending?: unknown;
  hold?: boolean;
  projects?: Record<
    string,
    {
      phase?: string;
      admissionId?: string;
      admissionGeneration?: number;
      preparationDigest?: string;
      checkout?: unknown;
      producer?: unknown;
      nativeReceiptEventId?: unknown;
      metadataPinsDigest?: unknown;
    }
  >;
  applications?: Record<string, unknown>;
  accountMaintenance?: unknown;
  epicClosure?: unknown;
  launch?: {
    runtimeId?: string;
    runtimeGeneration?: number;
    nativeLaunchId?: string;
    launchIntentDigest?: string;
    policyDigest?: string;
    metadataPolicyDigest?: string;
    approvals?: Array<{
      firstNative?: boolean;
      projectId?: string;
      admissionId?: string;
      admissionGeneration?: number;
      taskId?: string;
      leaseId?: string;
      leaseGeneration?: number;
      checkoutIncarnation?: string;
      checkoutIdentity?: unknown;
      revision?: string;
      repositoryId?: string;
    }>;
  };
};
const check: (v: unknown) => asserts v = (v) => {
  if (!v) throw new RegistrationRejected();
};
const digestRaw = (v: string) => createHash("sha256").update(v).digest("hex");
function oldIdentity(r: CodexGuardianRuntime) {
  return {
    lifetimeId: r.lifetimeId,
    bindingDigest: r.bindingDigest,
    outerPublicKeyPem: r.outerPublicKeyPem,
    packageManifestSha256: r.packageManifestSha256,
    guardianElfSha256: r.guardianElfSha256,
    nodeSha256: r.nodeSha256,
    policyDigest: r.policyDigest,
    metadataPolicyDigest: r.metadataPolicyDigest,
    configSha256: r.configSha256,
  };
}
/** Called ONLY inside reserveRuntime's transaction, after current Coder ownership,
 * predecessor stop, signed successor identity and current package/config validation.
 * The existing DB role is trusted; SQL independently enforces structural invariants.
 */
export async function retireUnstartedAuthorization(
  tx: Tx,
  input: {
    binding: RegistrationBinding;
    identity: GuardianRuntimeIdentity;
    transfer: GuardianUnstartedTransfer;
    policy: GuardianPolicy;
  },
) {
  const p = guardianUnstartedTransferSchema.parse(input.transfer),
    b = input.binding;
  check(
    input.policy.enabled &&
      input.policy.producerEnabled &&
      p.ownerId === b.hiveUserId &&
      p.coderOwnerId === b.ownerId &&
      p.workspaceId === b.workspaceId &&
      p.templateId === b.templateId &&
      p.newBuildId === b.buildId &&
      p.newConfigSha256 === input.identity.configSha256 &&
      p.newPackageManifestSha256 === input.identity.packageManifestSha256 &&
      p.oldBuildId !== b.buildId &&
      p.oldLifetimeId !== input.identity.lifetimeId &&
      b.projects.length === 0,
  );
  await tx.$queryRaw`SELECT id FROM codex_host_slots WHERE owner_id=${p.ownerId}::uuid AND workspace_id=${p.workspaceId}::uuid ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM codex_guardian_runtimes WHERE owner_id=${p.ownerId}::uuid AND id=${p.oldRuntimeId}::uuid FOR UPDATE`;
  const r = await tx.codexGuardianRuntime.findUniqueOrThrow({
    where: { ownerId_id: { ownerId: p.ownerId, id: p.oldRuntimeId } },
  });
  const prior = await tx.codexGuardianOperationReceipt.findUnique({
    where: {
      ownerId_runtimeId_eventId: { ownerId: p.ownerId, runtimeId: r.id, eventId: p.transferId },
    },
  });
  const proofDigest = guardianDigest(p);
  if (prior) {
    const response = prior.response as Prisma.JsonObject;
    const retirement = response.retirement as Prisma.JsonObject;
    check(
      prior.action === "authorization_retired" &&
        prior.requestDigest === proofDigest &&
        r.phase === "authorization_retired" &&
        retirement.newLifetimeId === input.identity.lifetimeId &&
        guardianDigest(retirement.newBinding) === guardianDigest(b) &&
        guardianDigest(retirement.newIdentity) === guardianDigest(input.identity),
    );
    return;
  }
  check(
    r.phase === "open" &&
      r.operationReceiptsEnabled &&
      r.workspaceId === p.workspaceId &&
      r.buildId === p.oldBuildId &&
      r.lifetimeId === p.oldLifetimeId &&
      r.configSha256 === p.oldConfigSha256 &&
      r.packageManifestSha256 === p.oldPackageManifestSha256 &&
      !r.producerApproved &&
      !r.serverInstanceId &&
      !r.hostKeyFingerprint &&
      !r.closedBarrierId &&
      r.nativeLaunchId === p.nativeLaunchId &&
      r.nativeLaunchDigest === p.launchIntentDigest &&
      r.nativeLaunchAt,
  );
  const oldBinding = r.binding as unknown as RegistrationBinding;
  check(
    oldBinding.hiveUserId === b.hiveUserId &&
      oldBinding.ownerId === b.ownerId &&
      oldBinding.workspaceId === b.workspaceId &&
      oldBinding.templateId === b.templateId &&
      oldBinding.coderOrigin === b.coderOrigin &&
      oldBinding.buildId === r.buildId,
  );
  check(
    input.policy.packages.some(
      (pin) =>
        pin.packageManifestSha256 === r.packageManifestSha256 &&
        pin.guardianElfSha256 === r.guardianElfSha256 &&
        pin.nodeSha256 === r.nodeSha256 &&
        pin.policyDigest === r.policyDigest &&
        pin.metadataPolicyDigest === r.metadataPolicyDigest,
    ),
  );
  const predecessor = p.predecessorController,
    c = predecessor.state as ControllerState,
    key = createPublicKey(r.outerPublicKeyPem);
  check(
    key.asymmetricKeyType === "ed25519" &&
      verify(
        null,
        Buffer.from(guardianCanonical(c)),
        key,
        Buffer.from(predecessor.signature, "base64url"),
      ),
  );
  check(
    createHash("sha256")
      .update(key.export({ format: "der", type: "spki" }))
      .digest("hex") === r.outerKeyFingerprint &&
      input.identity.outerPublicKeyPem === r.outerPublicKeyPem,
  );
  check(
    p.oldIdentityDigest === guardianDigest(oldIdentity(r)) &&
      c.schemaVersion === 1 &&
      c.identityDigest === p.oldIdentityDigest &&
      c.runtimeId === r.id &&
      c.lifetimeId === r.lifetimeId &&
      c.generation === r.generation &&
      c.pending === null &&
      c.hold === false &&
      Object.keys(c.projects ?? {}).join() === p.projectId &&
      Object.keys(c.applications ?? {}).length === 0 &&
      !c.accountMaintenance &&
      !c.epicClosure,
  );
  check(digestRaw(`${JSON.stringify(predecessor)}\n`) === p.oldJournalDigests.controller);
  await tx.$queryRaw`SELECT id FROM codex_guardian_admissions WHERE owner_id=${p.ownerId}::uuid AND runtime_id=${r.id}::uuid ORDER BY id FOR UPDATE`;
  const admissions = await tx.codexGuardianAdmission.findMany({
    where: { ownerId: p.ownerId, runtimeId: r.id },
  });
  check(admissions.length === 1);
  const a = admissions[0];
  check(
    a.projectId === p.projectId &&
      a.preparationIntentId === p.taskId &&
      a.phase === "checkout" &&
      guardianDigest(a.preparation) === guardianDigest(p.preparation) &&
      guardianDigest(a.checkoutBinding) === guardianDigest(p.checkout) &&
      a.preparationDigest === preparationDigest(p.preparation) &&
      p.preparation.requestDigest === p.hostRequestDigest &&
      p.preparation.ownerId === b.ownerId &&
      p.preparation.workspaceId === b.workspaceId &&
      p.preparation.buildId === r.buildId &&
      p.preparation.projectId === p.projectId &&
      p.preparation.taskId === p.taskId &&
      p.preparation.requestId === p.requestId &&
      p.preparation.baseSha === p.sourceSha &&
      p.preparation.repositoryId === p.repositoryId &&
      p.preparation.providerAccountId === p.providerAccountId,
  );
  check(
    p.checkout.projectId === p.projectId &&
      p.checkout.preparationIntentId === p.taskId &&
      p.checkout.repositoryId === p.repositoryId &&
      p.checkout.revision === p.sourceSha,
  );
  const local = c.projects?.[p.projectId],
    launch = c.launch;
  check(local && launch && Array.isArray(launch.approvals));
  check(
    local.phase === "checkout" &&
      local.admissionId === a.id &&
      local.admissionGeneration === a.generation &&
      local.preparationDigest === a.preparationDigest &&
      guardianDigest(local.checkout) === guardianDigest(a.checkoutBinding) &&
      !local.producer &&
      !local.nativeReceiptEventId &&
      !local.metadataPinsDigest,
  );
  check(
    launch?.runtimeId === r.id &&
      launch.runtimeGeneration === r.generation &&
      launch.nativeLaunchId === r.nativeLaunchId &&
      launch.launchIntentDigest === r.nativeLaunchDigest &&
      launch.policyDigest === r.policyDigest &&
      launch.metadataPolicyDigest === r.metadataPolicyDigest &&
      launch.approvals?.length === 1,
  );
  const expectedLaunch = guardianDigest({
    runtimeId: r.id,
    runtimeGeneration: r.generation,
    nativeLaunchId: r.nativeLaunchId,
    inventory: [{ admissionId: a.id, admissionGeneration: a.generation, checkout: p.checkout }],
  });
  check(expectedLaunch === r.nativeLaunchDigest);
  const ap = launch.approvals[0];
  check(
    ap.firstNative === true &&
      ap.projectId === p.projectId &&
      ap.admissionId === a.id &&
      ap.admissionGeneration === a.generation &&
      ap.taskId === p.taskId &&
      ap.leaseId === p.checkout.leaseId &&
      ap.leaseGeneration === p.checkout.leaseGeneration &&
      ap.checkoutIncarnation === p.checkout.checkoutIncarnation &&
      guardianDigest(ap.checkoutIdentity) === guardianDigest(p.checkout.checkoutIdentity) &&
      ap.revision === p.sourceSha &&
      ap.repositoryId === p.repositoryId,
  );
  await tx.$queryRaw`SELECT id FROM project_task_intents WHERE owner_id=${p.ownerId}::uuid AND id=${p.taskId}::uuid FOR UPDATE`;
  const intent = await tx.projectTaskIntent.findUniqueOrThrow({
    where: { ownerId_id: { ownerId: p.ownerId, id: p.taskId } },
  });
  const records = await tx.$queryRaw<
    { id: string; scope: Prisma.JsonObject; phase: string }[]
  >`SELECT id,scope,phase FROM project_task_recoveries WHERE owner_id=${p.ownerId}::uuid AND task_id=${p.taskId}::uuid AND phase<>'consumed' FOR UPDATE`;
  check(records.length === 1 && records[0].phase === "inspecting");
  const recovery = records[0];
  check(
    intent.phase === "blocked" &&
      intent.ciphertext &&
      intent.requestDigest === a.intentRequestDigest &&
      recovery.scope.intentDigest === intent.requestDigest &&
      recovery.scope.hostRequestDigest === p.hostRequestDigest,
  );
  const response = {
    runtime: { id: r.id, ownerId: r.ownerId, generation: r.generation },
    admission: {
      id: a.id,
      runtimeId: r.id,
      generation: a.generation,
      preparationIntentId: a.preparationIntentId,
    },
    retirement: {
      schemaVersion: 1,
      purpose: "unused-metadata-authorization",
      proofDigest,
      proof: p,
      recoveryId: recovery.id,
      intentDigest: intent.requestDigest,
      newLifetimeId: input.identity.lifetimeId,
      newBinding: b,
      newIdentity: input.identity,
      nativeTreeExited: false,
      cleanupAuthorized: false,
      writerReleased: false,
    },
  };
  await tx.codexGuardianOperationReceipt.create({
    data: {
      ownerId: p.ownerId,
      runtimeId: r.id,
      eventId: p.transferId,
      action: "authorization_retired",
      requestDigest: proofDigest,
      inputRuntimeGeneration: r.generation,
      resultRuntimeGeneration: r.generation,
      resultAdmissionGeneration: a.generation,
      response: response as unknown as Prisma.InputJsonObject,
      responseDigest: guardianDigest(response),
      lifetimeId: r.lifetimeId,
      buildId: r.buildId,
      configSha256: r.configSha256,
      outerKeyFingerprint: r.outerKeyFingerprint,
    },
  });
  await tx.codexGuardianRuntime.update({
    where: { id: r.id },
    data: { phase: "authorization_retired" },
  });
}
/** Only an immutable, exact owner recovery event can extend an original epic
 * start allocation to its approved successor. The original row is never edited. */
export async function effectiveUnstartedSuccessor(
  tx: Tx,
  input: {
    ownerId: string;
    taskId: string;
    workspaceId: string;
    oldBuildId: string;
    newBuildId: string;
    recoveryId?: string;
  },
) {
  if (input.oldBuildId === input.newBuildId) return true;
  const rows = await tx.$queryRaw<
    { response: Prisma.JsonObject; phase: string; build_id: string }[]
  >`SELECT e.response,r.phase,r.build_id FROM codex_guardian_operation_receipts e JOIN codex_guardian_runtimes r ON r.owner_id=e.owner_id AND r.id=e.runtime_id WHERE e.owner_id=${input.ownerId}::uuid AND e.action='authorization_retired' AND e.response->'retirement'->'proof'->>'taskId'=${input.taskId} AND e.response->'retirement'->'proof'->>'workspaceId'=${input.workspaceId} AND e.response->'retirement'->'proof'->>'oldBuildId'=${input.oldBuildId} AND e.response->'retirement'->'proof'->>'newBuildId'=${input.newBuildId}`;
  if (rows.length !== 1) return false;
  const e = rows[0],
    retirement = e.response.retirement as Prisma.JsonObject;
  if (
    e.phase !== "authorization_retired" ||
    e.build_id !== input.oldBuildId ||
    (input.recoveryId && retirement.recoveryId !== input.recoveryId)
  )
    return false;
  const newIdentity = retirement.newIdentity as Prisma.JsonObject;
  const successors = await tx.codexGuardianRuntime.findMany({
    where: {
      ownerId: input.ownerId,
      lifetimeId: String(newIdentity.lifetimeId),
      workspaceId: input.workspaceId,
      buildId: input.newBuildId,
    },
  });
  return (
    successors.length === 1 &&
    successors[0].configSha256 === newIdentity.configSha256 &&
    successors[0].packageManifestSha256 === newIdentity.packageManifestSha256 &&
    successors[0].outerPublicKeyPem === newIdentity.outerPublicKeyPem &&
    ["open", "barrier_closed", "tree_closed"].includes(successors[0].phase)
  );
}
