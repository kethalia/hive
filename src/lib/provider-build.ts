import { z } from "zod";
export const providerBuildIdentitySchema = z.discriminatedUnion("status", [
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("unavailable"),
      reason: z.literal("non_provider_build"),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      status: z.literal("available"),
      provider: z.literal("cloudflare-builds"),
      sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
      buildUuid: z.string().uuid(),
      branch: z.string().min(1).max(200),
    })
    .strict(),
]);
export type ProviderBuildIdentity = z.infer<typeof providerBuildIdentitySchema>;
export const unavailableProviderBuild: ProviderBuildIdentity = {
  schemaVersion: 1,
  status: "unavailable",
  reason: "non_provider_build",
};
