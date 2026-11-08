import { z } from "zod";
import { githubSourceDigest } from "./github-evidence.server";

const id = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const automaticDatabaseActionSchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("automatic-database-job"),
    dispatchId: id,
    issuedAt: z.number().int().nonnegative().safe(),
    stage: z.enum(["approve", "advance", "activate"]),
    ownerId: id,
    taskId: id,
    releaseId: id,
    targetDigest: hash,
    generation: z.number().int().positive().safe(),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    catalogDigest: hash,
    planDigest: hash,
    planEventId: id.nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.stage === "approve") !== (v.planEventId === null))
      ctx.addIssue({ code: "custom", message: "Plan approval stage mismatch" });
  });
export type AutomaticDatabaseAction = z.infer<typeof automaticDatabaseActionSchema>;
export const automaticDatabaseRunSchema = z
  .object({
    provider: z.literal("github-actions"),
    dispatchId: id,
    stage: automaticDatabaseActionSchema.innerType().shape.stage,
    runId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    runAttempt: z.number().int().positive().safe(),
    workflowId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    dispatcherSha: z.string().regex(/^[a-f0-9]{40}$/),
    catalogDigest: hash,
    planDigest: hash,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
export function automaticDatabaseReceipt(
  requestDigest: string,
  evidence: z.infer<typeof automaticDatabaseRunSchema>,
) {
  return { requestDigest, evidence, receiptDigest: githubSourceDigest(evidence) };
}
