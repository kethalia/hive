import { z } from "zod";

const fence = { lifetimeId: z.string().uuid(), generation: z.number().int().nonnegative().safe() };
export const claudeAccountRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  ...(["connect", "cancel", "reconnect", "disconnect"] as const).map((action) =>
    z.object({ action: z.literal(action), ...fence }).strict(),
  ),
  z
    .object({ action: z.literal("code"), ...fence, code: z.string().regex(/^[!-~]{1,2048}$/) })
    .strict(),
]);
export const claudeAccountStatusSchema = z
  .object({
    ...fence,
    scope: z.literal("workspace-cli"),
    account: z
      .object({
        type: z.literal("claude"),
        email: z.string().email().max(254).nullable(),
        plan: z.string().max(80).nullable(),
      })
      .strict()
      .nullable()
      .optional(),
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
        verificationUrl: z
          .string()
          .max(8192)
          .refine((value) => {
            if (
              Array.from(value).some(
                (char) =>
                  char.charCodeAt(0) < 32 ||
                  (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
              ) ||
              value.toLowerCase().split("https://claude.com/cai/oauth/authorize").length !== 2
            )
              return false;
            try {
              const u = new URL(value);
              return (
                u.protocol === "https:" &&
                u.host === "claude.com" &&
                u.pathname === "/cai/oauth/authorize" &&
                !u.username &&
                !u.password &&
                !u.hash &&
                !!u.search
              );
            } catch {
              return false;
            }
          }),
        codeSubmitted: z.boolean(),
        expiresAt: z.number().int().positive().safe(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ClaudeAccountRequest = z.infer<typeof claudeAccountRequestSchema>;
export type ClaudeAccountStatus = z.infer<typeof claudeAccountStatusSchema>;
