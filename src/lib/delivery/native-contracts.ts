import { z } from "zod";
import { managerCheckoutSchema } from "./manager-contracts";

const nativeId = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  parentTurnId: nativeId,
  spawnCallId: nativeId,
  childThreadId: nativeId,
  childTurnId: nativeId,
  observedAt: z.string().datetime({ offset: true }),
};
export const nativeSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("root_boundary"),
      parentTurnId: nativeId,
      nextParentTurnId: nativeId,
      cursorVersion: z.number().int().positive().max(2147483646),
      observedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("started"),
      requestedModel: nativeId.nullable(),
      requestedEffort: nativeId.nullable(),
      effectiveModel: nativeId.nullable(),
      effectiveEffort: nativeId.nullable(),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("command_completed"),
      itemId: nativeId,
      commandDigest: digest,
      outputDigest: digest,
      exitCode: z.number().int().nullable(),
      status: z.enum(["completed", "failed", "declined"]),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal("turn_completed"),
      status: z.enum(["completed", "failed", "interrupted"]),
    })
    .strict(),
]);
export const nativeSourceInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: uuid,
    managerBindingId: uuid,
    taskId: uuid,
    stepId: uuid,
    attemptId: uuid,
    leaseGeneration: z.number().int().positive(),
    sequence: z.number().int().positive().max(2147483647),
    source: nativeSourceSchema,
  })
  .strict();
export const nativeEnvelopeSchema = nativeSourceInputSchema
  .extend({
    registrationId: uuid,
    serverInstanceId: nativeId,
    managerThreadId: nativeId,
    checkoutBinding: managerCheckoutSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type NativeEnvelope = z.infer<typeof nativeEnvelopeSchema>;
function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
}
export function nativeProofPayload(value: Record<string, unknown> | Omit<NativeEnvelope, "proof">) {
  const { proof: _proof, ...unsigned } = value as Record<string, unknown>;
  return `hive-delivery-native-v1\nPOST\n/api/delivery/native\n${JSON.stringify(canonical(unsigned))}`;
}
export const NATIVE_OBSERVER_PRODUCER = "native-app-server-v1";
