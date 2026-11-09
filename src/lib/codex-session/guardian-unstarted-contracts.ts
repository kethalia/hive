import { z } from "zod";
import {
  guardianCanonical,
  guardianCheckoutSchema,
  guardianDigestSchema,
  guardianPreparationSchema,
} from "./guardian-contracts";

const uuid = z.string().uuid();
// This predecessor's reviewed producer persists reservationRequested before waiting,
// and reserved before entering the native factory. Other producers are not inferred.
export const UNSTARTED_PREDECESSOR_MANIFEST =
  "7eb52d53f4c6664743d4da182ff35dbe042bde53017647d18209b4eb885180c7";
export const guardianUnstartedTransferSchema = z
  .object({
    schemaVersion: z.literal(1),
    transferId: uuid,
    ownerId: uuid,
    coderOwnerId: uuid,
    workspaceId: uuid,
    templateId: uuid,
    projectId: uuid,
    taskId: uuid,
    requestId: uuid,
    hostRequestDigest: guardianDigestSchema,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    providerAccountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    oldRuntimeId: uuid,
    oldBuildId: uuid,
    oldLifetimeId: uuid,
    oldIdentityDigest: guardianDigestSchema,
    oldConfigSha256: guardianDigestSchema,
    oldPackageManifestSha256: z.literal(UNSTARTED_PREDECESSOR_MANIFEST),
    newBuildId: uuid,
    newConfigSha256: guardianDigestSchema,
    newPackageManifestSha256: guardianDigestSchema,
    nativeLaunchId: uuid,
    launchIntentDigest: guardianDigestSchema,
    preparation: guardianPreparationSchema,
    checkout: guardianCheckoutSchema,
    oldJournalDigests: z
      .object({
        lifetime: guardianDigestSchema,
        controller: guardianDigestSchema,
        project: guardianDigestSchema,
        supervisor: guardianDigestSchema,
      })
      .strict(),
    predecessorController: z
      .object({
        state: z
          .record(z.string(), z.unknown())
          .refine((v) => Buffer.byteLength(guardianCanonical(v)) <= 8192),
        signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
      })
      .strict(),
    neverStarted: z
      .object({
        metadataPhase: z.literal("reservationRequested"),
        status: z.literal("starting"),
        nativeProcess: z.null(),
        executionIdentity: z.null(),
        projectCount: z.literal(0),
        nativeCreationAttempted: z.literal(false),
        firstPromptSubmissionAttempted: z.literal(false),
        nativeThreadId: z.null(),
        terminalSessionName: z.null(),
      })
      .strict(),
  })
  .strict()
  .refine((v) => Buffer.byteLength(guardianCanonical(v)) <= 16384);
export const guardianUnstartedTransferReceiptSchema = z
  .object({
    transferId: uuid,
    oldRuntimeId: uuid,
    proofDigest: guardianDigestSchema,
    continuationDigest: guardianDigestSchema.optional(),
    attestationDigest: guardianDigestSchema.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.continuationDigest) === Boolean(v.attestationDigest));
export type GuardianUnstartedTransfer = z.infer<typeof guardianUnstartedTransferSchema>;

/** Coder status belongs to that build's job/transition, not later builds. Require
 * the normal consecutive start/stop/start chain, not an old-start stopped label. */
export function verifyUnstartedCoderLifecycle(
  raw: unknown,
  scope: { workspaceId: string; oldBuildId: string; newBuildId: string },
  historical = false,
) {
  const result = z
    .array(
      z
        .object({
          id: uuid,
          workspace_id: uuid,
          build_number: z.number().int().positive(),
          transition: z.enum(["start", "stop", "delete"]),
          status: z.string(),
          job: z.object({ status: z.string() }).passthrough(),
        })
        .passthrough(),
    )
    .min(3)
    .max(16)
    .safeParse(raw);
  if (!result.success || scope.oldBuildId === scope.newBuildId) return false;
  const rows = result.data,
    old = rows.filter((r) => r.id === scope.oldBuildId),
    next = rows.filter((r) => r.id === scope.newBuildId);
  if (
    old.length !== 1 ||
    next.length !== 1 ||
    rows.some((r) => r.workspace_id !== scope.workspaceId) ||
    new Set(rows.map((r) => r.id)).size !== rows.length ||
    new Set(rows.map((r) => r.build_number)).size !== rows.length
  )
    return false;
  const before = old[0],
    after = next[0],
    stop = rows.filter((r) => r.build_number === before.build_number + 1);
  return (
    before.transition === "start" &&
    before.job.status === "succeeded" &&
    after.transition === "start" &&
    (historical || after.status === "running") &&
    after.job.status === "succeeded" &&
    after.build_number === before.build_number + 2 &&
    stop.length === 1 &&
    stop[0].transition === "stop" &&
    stop[0].status === "stopped" &&
    stop[0].job.status === "succeeded" &&
    Math.max(...rows.map((r) => r.build_number)) === after.build_number
  );
}

/** One extra unused start only. Each stop/start edge is independently proven;
 * no arbitrary build omission or additional intermediate is accepted. */
export function verifyUnusedEpochCoderLifecycle(
  raw: unknown,
  scope: { workspaceId: string; oldBuildId: string; heldBuildId: string; newBuildId: string },
) {
  const parsed = z
    .array(z.object({ id: uuid, build_number: z.number().int().positive() }).passthrough())
    .max(16)
    .safeParse(raw);
  if (!parsed.success) return false;
  const held = parsed.data.find((r) => r.id === scope.heldBuildId);
  if (!held) return false;
  return (
    verifyUnstartedCoderLifecycle(
      parsed.data.filter((r) => r.build_number <= held.build_number),
      {
        workspaceId: scope.workspaceId,
        oldBuildId: scope.oldBuildId,
        newBuildId: scope.heldBuildId,
      },
      true,
    ) &&
    verifyUnstartedCoderLifecycle(raw, {
      workspaceId: scope.workspaceId,
      oldBuildId: scope.heldBuildId,
      newBuildId: scope.newBuildId,
    })
  );
}
