import { z } from "zod";
import { guardianDigestSchema } from "./guardian-contracts";

const uuid = z.string().uuid();
const positive = z.number().int().positive();
const project = z.object({ projectId: uuid, bindingDigest: guardianDigestSchema }).strict();
// Produced only by the pinned outer host after the native guardian's ECHILD
// acknowledgement AND successful process exit. This does not authorize deletion.
export const guardianTreeReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: z.literal("managed_native_tree_only"),
    cleanupAuthorized: z.literal(false),
    receiptId: uuid,
    lifetimeId: uuid,
    bindingDigest: guardianDigestSchema,
    ownershipDigest: guardianDigestSchema,
    projects: z.array(project).max(32),
    launchSetDigest: guardianDigestSchema,
    guardianSha256: guardianDigestSchema,
    guardianIdentity: z
      .object({
        pid: positive,
        startTime: z.string().regex(/^[1-9][0-9]{0,24}$/),
        bootId: uuid,
        executable: z.string().min(1).max(512),
        device: z.string().regex(/^[0-9]{1,24}$/),
        inode: z.string().regex(/^[1-9][0-9]{0,24}$/),
      })
      .strict(),
    generation: positive,
    closedRequestId: positive,
    drainRequestId: positive,
    finalWaitResult: z.literal("ECHILD"),
    waitFlags: z.literal("__WALL"),
    reaped: z.number().int().nonnegative(),
    decisions: z.array(project.extend({ decisionId: uuid }).strict()).max(32),
    workerBarrier: z
      .object({
        closed: z.literal(true),
        lifetimeId: uuid,
        generation: positive,
        ownershipDigest: guardianDigestSchema,
        barrierId: uuid,
      })
      .strict(),
    workerPid: positive,
    packageManifestSha256: guardianDigestSchema,
    workerSha256: guardianDigestSchema,
    nodeSha256: guardianDigestSchema,
    guardianExited: z.literal(true),
  })
  .strict();
export type GuardianTreeReceipt = z.infer<typeof guardianTreeReceiptSchema>;
