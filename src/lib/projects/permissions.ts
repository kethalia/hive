import { z } from "zod";

export const accessLevel = z.enum(["none", "read", "write"]);
export type AccessLevel = z.infer<typeof accessLevel>;
export const repoName = z
  .string()
  .regex(/^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/i)
  .refine((name) => ![".", ".."].includes(name.split("/")[1]));
export const repoId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const permissionView = z.object({
  managed: z.boolean(),
  repositories: z.array(
    z.object({
      id: repoId,
      name: repoName,
      access: accessLevel,
      revision: z.string().uuid().nullable(),
    }),
  ),
});
export type PermissionView = z.infer<typeof permissionView>;
