import { z } from "zod";
import { sourceContextSchema } from "./contracts";

const id = z.string().uuid(),
  nativeId = z.string().min(1).max(160),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
// Installed factual snapshot only. Never part of the manager tool schema, and
// never a claim of physical-writer or kernel-process quiescence.
export const acceptanceTerminalSchema = z
  .object({
    schemaVersion: z.literal(1),
    managerBindingId: id,
    taskId: id,
    stepId: id,
    attemptId: id,
    managerThreadId: nativeId,
    parentTurnId: nativeId,
    cursorVersion: z.number().int().positive(),
    nativeSequence: z.number().int().nonnegative(),
    sourceContext: sourceContextSchema,
    observedAt: z.string().datetime(),
    historyDigest: digest,
    loadedInventoryDigest: digest,
    sourceJournalDigest: digest,
    rootCompleted: z.literal(true),
    pendingHandlers: z.literal(0),
    pendingObservers: z.literal(0),
    unknownInputs: z.literal(0),
    cohort: z
      .array(
        z
          .object({
            parentTurnId: nativeId,
            spawnCallId: nativeId,
            childThreadId: nativeId,
            childTurnId: nativeId,
            effectiveModel: z.string().min(1).max(160),
            effectiveEffort: z.string().min(1).max(40),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export type AcceptanceTerminal = z.infer<typeof acceptanceTerminalSchema>;
