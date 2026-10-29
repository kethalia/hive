import { z } from "zod";
import { githubSnapshotSchema, githubSourceTargetSchema } from "./github-contracts";
import { canonicalGitHubSource } from "./github-evidence.server";
import { managerCheckoutSchema } from "./manager-contracts";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid();
const host = {
  schemaVersion: z.literal(1),
  action: z.literal("collect_github_evidence"),
  registrationId: uuid,
  serverInstanceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  managerThreadId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  checkoutBinding: managerCheckoutSchema,
  taskId: uuid,
  stepId: uuid,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
};
export const githubChallengeRequestSchema = z.object({ ...host, requestId: uuid }).strict();
export const githubCollectionChallengeSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal("collect_github_evidence"),
    id: uuid,
    nonce: digest,
    registrationId: uuid,
    managerBindingId: uuid,
    target: githubSourceTargetSchema,
    policyDigest: digest,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export const githubSourceEnvelopeSchema = z
  .object({
    ...host,
    challengeId: uuid,
    nonce: digest,
    policyDigest: digest,
    snapshot: githubSnapshotSchema,
  })
  .strict();
export type GitHubChallengeRequest = z.infer<typeof githubChallengeRequestSchema>;
export type GitHubCollectionChallenge = z.infer<typeof githubCollectionChallengeSchema>;
export type GitHubSourceEnvelope = z.infer<typeof githubSourceEnvelopeSchema>;
export function githubTransportProofPayload(
  phase: "challenge" | "snapshot",
  value: Record<string, unknown>,
) {
  const { proof: _proof, ...unsigned } = value;
  const path =
    phase === "challenge" ? "/api/delivery/github-source/challenge" : "/api/delivery/github-source";
  return `hive-github-source-v1\nPOST\n${path}\n${canonicalGitHubSource(unsigned)}`;
}
