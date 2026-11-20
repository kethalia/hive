import { z } from "zod";

export const githubRevision = z.union([z.literal("initial"), z.string().uuid()]);
export const githubAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  ...(["start", "poll", "cancel", "disconnect"] as const).map((action) =>
    z.object({ action: z.literal(action), revision: githubRevision }).strict(),
  ),
]);
export const githubStatusSchema = z
  .object({
    revision: githubRevision,
    login: z
      .string()
      .regex(/^[a-zA-Z0-9-]{1,39}$/)
      .nullable(),
    pending: z
      .object({
        code: z.string().regex(/^[A-Z0-9-]{4,32}$/),
        interval: z.number().int().min(1).max(120),
        expiresAt: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    outcome: z.enum(["expired", "failed"]).nullable(),
  })
  .strict();
export type GitHubStatus = z.infer<typeof githubStatusSchema>;
