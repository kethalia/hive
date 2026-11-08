import { z } from "zod";

const fence = { lifetimeId: z.string().uuid(), generation: z.number().int().nonnegative().safe() };
/** Managed native credentials only. The caller never selects a home, executable,
 * provider origin, token, or arbitrary app-server method. */
export const codexAccountRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  ...(["connect", "cancel", "reconnect", "disconnect"] as const).map((action) =>
    z.object({ action: z.literal(action), ...fence }).strict(),
  ),
]);
export const codexAccountStatusSchema = z
  .object({
    ...fence,
    scope: z.literal("managed-native"),
    state: z.enum([
      "signed-out",
      "signed-in",
      "pending",
      "busy",
      "unknown",
      "expired",
      "cancelled",
      "failed",
    ]),
    pending: z
      .object({
        verificationUrl: z.literal("https://auth.openai.com/codex/device"),
        userCode: z.string().regex(/^[A-Z0-9-]{4,32}$/),
        expiresAt: z.number().int().positive().safe(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type CodexAccountRequest = z.infer<typeof codexAccountRequestSchema>;
export type CodexAccountStatus = z.infer<typeof codexAccountStatusSchema>;
