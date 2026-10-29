import { z } from "zod";
import {
  attemptFailureSchema,
  completionSchema,
  leaseRequestSchema,
  taskDefinitionSchema,
} from "./contracts";

const command = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create_task"),
      payload: taskDefinitionSchema.omit({
        schemaVersion: true,
        eventId: true,
        projectId: true,
        conversationId: true,
      }),
    })
    .strict(),
  z
    .object({
      operation: z.literal("claim_step"),
      payload: leaseRequestSchema.omit({
        schemaVersion: true,
        eventId: true,
        leaseHolder: true,
        effectiveModel: true,
        effectiveEffort: true,
      }),
    })
    .strict(),
  z
    .object({
      operation: z.literal("complete_step"),
      payload: completionSchema.omit({ schemaVersion: true, eventId: true }),
    })
    .strict(),
  z
    .object({
      operation: z.literal("fail_attempt"),
      payload: attemptFailureSchema.omit({ schemaVersion: true, eventId: true }),
    })
    .strict(),
]);
const nativeId = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/);
export const managerEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    registrationId: z.string().uuid(),
    serverInstanceId: nativeId,
    eventId: z.string().uuid(),
    managerThreadId: nativeId,
    nativeTurnId: nativeId,
    nativeCallId: nativeId,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    command,
    proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type ManagerEnvelope = z.infer<typeof managerEnvelopeSchema>;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
/** Sign the wire object, before schema defaults normalize the command payload. */
export function managerProofPayload(
  value: Omit<ManagerEnvelope, "proof"> | Record<string, unknown>,
) {
  const { proof: _proof, ...unsigned } = value as Record<string, unknown>;
  return `hive-delivery-host-v1\nPOST\n/api/delivery/host\n${JSON.stringify(canonical(unsigned))}`;
}
