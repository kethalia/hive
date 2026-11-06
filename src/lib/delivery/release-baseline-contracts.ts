import { z } from "zod";

const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  sha = z.string().regex(/^[a-f0-9]{40}$/);
export const releaseBaselineSchema = z
  .object({
    deploymentId: uuid,
    versionId: uuid,
    sourceSha: sha,
    artifactDigest: digest,
    configDigest: digest,
  })
  .strict();
export const releaseBaselinesSchema = z
  .object({ app: releaseBaselineSchema, auth: releaseBaselineSchema })
  .strict();
