import { z } from "zod";

const uuid = z.string().uuid();
export const epicLeaseReleaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    repositoryId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    taskId: uuid,
    leaseId: uuid,
    leaseGeneration: z.number().int().positive(),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    checkoutIncarnation: uuid,
    checkoutIdentity: z
      .object({
        device: z.string().regex(/^[0-9]{1,24}$/),
        inode: z.string().regex(/^[1-9][0-9]{0,24}$/),
      })
      .strict(),
    releasedAt: z.number().int().positive().safe(),
  })
  .strict();
export type EpicLeaseRelease = z.infer<typeof epicLeaseReleaseSchema>;
