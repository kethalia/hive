import { z } from "zod";
import { repositoryProjectSchema } from "@/lib/projects/contracts";

const id = z.string().regex(/^[1-9][0-9]{0,19}$/),
  sha = z.string().regex(/^[a-f0-9]{40}$/);
const branch = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/)
  .refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock")),
  );
const request = {
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  repositoryId: id,
  expectedAccountId: id,
  baseBranch: branch,
};
export const epicGitHubReadRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...request,
      operation: z.literal("observe_merge"),
      pullRequestId: id,
      pullNumber: z.number().int().positive().safe(),
      headSha: sha,
      sourceBranch: branch,
    })
    .strict(),
  z.object({ ...request, operation: z.literal("lineage"), baseSha: sha, headSha: sha }).strict(),
]);
const result = {
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  providerAccountId: id,
  repository: repositoryProjectSchema,
  baseBranch: branch,
  branchHeadSha: sha,
  headSha: sha,
};
export const epicGitHubReadResultSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...result,
      operation: z.literal("observe_merge"),
      sourceBranch: branch,
      pullRequestId: id,
      pullNumber: z.number().int().positive().safe(),
      merged: z.boolean(),
      mergeSha: sha.nullable(),
    })
    .strict(),
  z
    .object({
      ...result,
      operation: z.literal("lineage"),
      baseSha: sha,
      status: z.enum(["ahead", "identical"]),
      mergeBaseSha: sha,
    })
    .strict(),
]);
export type EpicGitHubReadRequest = z.infer<typeof epicGitHubReadRequestSchema>;
export type EpicGitHubReadResult = z.infer<typeof epicGitHubReadResultSchema>;
