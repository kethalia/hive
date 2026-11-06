import { z } from "zod";
import { githubSourceDigest } from "./github-evidence.server";
import {
  nativePreviewProviderIdSchema,
  nativePreviewReleaseTargetSchema,
} from "./release-native-preview-reader.server";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  sha = z.string().regex(/^[a-f0-9]{40}$/);
const uuid = z.string().uuid(),
  providerId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const publicBooleanNames = new Set([
  "HIVE_NATIVE_PREVIEW_ENABLED",
  "HIVE_PREVIEW_ACCESS_REQUIRED",
  "HIVE_DISABLE_BACKGROUND_WORKERS",
  "HIVE_PROJECT_DISCOVERY_ENABLED",
  "HIVE_PROJECT_TASKS_ENABLED",
  "HIVE_DELIVERY_ENABLED",
  "HIVE_CODEX_GATEWAY_ENABLED",
  "HIVE_DELIVERY_DISPATCH_ENABLED",
  "HIVE_TOKEN_ROTATION_ENABLED",
  "HIVE_GENERIC_TERMINAL_ENABLED",
  "HIVE_TERMINAL_PASTE_ENABLED",
  "HIVE_CODEX_TERMINAL_ENABLED",
  "HIVE_CODEX_VOICE_ENABLED",
  "HIVE_AGENT_NOTIFICATION_EVENTS_ENABLED",
  "HIVE_AGENT_NOTIFICATION_SOURCES_ENABLED",
  "HIVE_CODER_OAUTH_ENABLED",
  "HIVE_RELEASE_HEALTH_ENABLED",
]);
export const nativePublicVarsSchema = z.record(z.string()).superRefine((vars, context) => {
  for (const [name, value] of Object.entries(vars)) {
    const valid = publicBooleanNames.has(name)
      ? ["true", "false"].includes(value)
      : name === "HIVE_NATIVE_MODE"
        ? value === "preview"
        : name === "HIVE_RUNTIME_TARGET"
          ? value === "cloudflare"
          : name === "CODER_URL"
            ? value === "https://coder.kethalia.com"
            : name === "HIVE_PUBLIC_ORIGIN" || name === "HIVE_PREVIEW_ORIGIN"
              ? value === "https://codex-delivery-system-design-hive.b00ste.workers.dev"
              : name === "HIVE_CODER_OAUTH_CLIENT_ID"
                ? value === "8a255ae5-7c91-4a6a-a27a-5107e82962d4"
                : name === "HIVE_RELEASE_SOURCE_SHA"
                  ? value === "{{source_sha}}"
                  : name === "HIVE_RELEASE_ARTIFACT_DIGEST"
                    ? value === "{{artifact_digest}}"
                    : false;
    if (!valid)
      context.addIssue({ code: "custom", message: "Unsupported public native configuration" });
  }
  for (const [name, value] of Object.entries({
    HIVE_NATIVE_MODE: "preview",
    HIVE_NATIVE_PREVIEW_ENABLED: "true",
    HIVE_RELEASE_SOURCE_SHA: "{{source_sha}}",
    HIVE_RELEASE_ARTIFACT_DIGEST: "{{artifact_digest}}",
  }))
    if (vars[name] !== value)
      context.addIssue({ code: "custom", message: "Missing native identity configuration" });
});
const secretName = z.enum([
  "DATABASE_URL",
  "ENCRYPTION_KEY",
  "COOKIE_SECRET",
  "AUTH_SERVICE_SECRET",
  "HIVE_CODER_OAUTH_CLIENT_SECRET",
  "HIVE_RELEASE_PROBE_SECRET",
]);
export const nativePublicConfigSchema = z
  .object({
    mainModule: z.literal("worker.js"),
    compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    compatibilityFlags: z.array(z.string().regex(/^[a-z0-9_]{1,128}$/)).max(32),
    cpuMs: z.number().int().min(1).max(100),
    placement: z.object({ region: z.literal("aws:us-east-1") }).strict(),
    vars: nativePublicVarsSchema,
    secretNames: z
      .array(secretName)
      .min(5)
      .max(6)
      .refine((v) => new Set(v).size === v.length),
    assets: z.object({ run_worker_first: z.literal(true) }).strict(),
  })
  .strict()
  .superRefine((v, context) => {
    for (const key of [
      "DATABASE_URL",
      "ENCRYPTION_KEY",
      "COOKIE_SECRET",
      "AUTH_SERVICE_SECRET",
      "HIVE_CODER_OAUTH_CLIENT_SECRET",
    ] as const)
      if (!v.secretNames.includes(key))
        context.addIssue({ code: "custom", message: "Missing enrolled secret name" });
  });
export const nativeBuilderSchema = z
  .object({
    repositoryId: providerId,
    repositoryOwnerId: providerId,
    runId: providerId,
    runAttempt: z.number().int().positive().safe(),
    artifactId: providerId,
    artifactZipDigest: digest,
    workflowId: providerId,
  })
  .strict();
export const nativeArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("cloudflare-native-preview"),
    id: uuid,
    ownerId: uuid,
    releaseId: uuid,
    targetDigest: digest,
    sourceSha: sha,
    archiveDigest: digest,
    artifactDigest: digest,
    moduleManifestDigest: digest,
    assetsManifestDigest: digest,
    builder: nativeBuilderSchema,
    publicConfig: nativePublicConfigSchema,
    privateBindingRevision: uuid,
    compatibilityRevision: uuid,
  })
  .strict();
export type NativeArtifact = z.infer<typeof nativeArtifactSchema>;
export const nativeBaselineSchema = z
  .object({
    provider: z.literal("cloudflare-native-preview"),
    artifactId: uuid,
    sourceSha: sha,
    artifactDigest: digest,
    publicConfigDigest: digest,
    privateBindingRevision: uuid,
    compatibilityRevision: uuid,
    healthyObservationDigest: digest,
  })
  .strict();
export const nativeReleaseSnapshotSchema = z
  .object({
    provider: z.literal("cloudflare-native-preview"),
    target: nativePreviewReleaseTargetSchema,
    externalWriterPolicy: z.literal("observed-drift-hold-no-atomic-cas"),
    recoveryBaseline: nativeBaselineSchema.nullable(),
    purpose: z.enum(["bootstrap-baseline", "publication"]),
  })
  .strict();
export const nativePublicationRequestSchema = z
  .object({
    provider: z.literal("cloudflare-native-preview"),
    artifactId: uuid,
    purpose: z.enum(["bootstrap-baseline", "publish", "recover"]),
    expectedCurrentDeploymentId: nativePreviewProviderIdSchema,
    sourceSha: sha,
    artifactDigest: digest,
    publicConfigDigest: digest,
    privateBindingRevision: uuid,
    compatibilityRevision: uuid,
    recoveryBaseline: nativeBaselineSchema.nullable(),
  })
  .strict()
  .refine((v) => (v.purpose === "bootstrap-baseline") === (v.recoveryBaseline === null));
export type NativePublicationRequest = z.infer<typeof nativePublicationRequestSchema>;
export const nativePublisherIdentitySchema = z
  .object({
    repositoryId: providerId,
    repositoryOwnerId: providerId,
    runId: providerId,
    runAttempt: z.number().int().positive().safe(),
    workflowSha: sha,
  })
  .strict();
export const nativePublisherPolicySchema = z
  .object({
    repositoryId: providerId,
    repositoryOwnerId: providerId,
    workflowRef: z
      .string()
      .regex(
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_.-]+\.yml@(?:refs\/heads\/[A-Za-z0-9_./-]+|[a-f0-9]{40})$/,
      ),
    workflowSha: sha,
    ref: z.string().regex(/^refs\/heads\/[A-Za-z0-9_./-]+$/),
    contextSha: sha,
    audiencePrefix: z.string().regex(/^urn:hive:native-release:[a-z0-9_-]{1,48}:$/),
  })
  .strict();
export const nativePublicationGrantSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("cloudflare-native-preview"),
    id: uuid,
    purpose: z.enum(["bootstrap-baseline", "publish", "recover"]),
    actionId: uuid,
    releaseId: uuid,
    ownerId: uuid,
    generation: z.number().int().positive(),
    requestDigest: digest,
    target: nativePreviewReleaseTargetSchema,
    artifact: nativeArtifactSchema,
    publisher: nativePublisherIdentitySchema,
    expectedCurrentDeploymentId: nativePreviewProviderIdSchema,
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
  })
  .strict();
export type NativePublicationGrant = z.infer<typeof nativePublicationGrantSchema>;
export const nativePublicationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal("cloudflare-native-preview"),
    grantId: uuid,
    actionId: uuid,
    requestDigest: digest,
    previewId: nativePreviewProviderIdSchema,
    deploymentId: nativePreviewProviderIdSchema,
    providerCreatedAt: z.string().datetime({ offset: true }),
    sourceSha: sha,
    artifactDigest: digest,
    publicConfigDigest: digest,
    archiveDigest: digest,
    moduleManifestDigest: digest,
    assetsManifestDigest: digest,
    publisher: nativePublisherIdentitySchema,
  })
  .strict();
export type NativePublicationReceipt = z.infer<typeof nativePublicationReceiptSchema>;
export const nativeDigest = githubSourceDigest;

export const nativeBootstrapEnrollmentSchema = z
  .object({
    enabled: z.literal(true),
    ownerId: uuid,
    releaseId: uuid,
    taskId: uuid,
    sourceRevisionId: uuid,
    artifactId: uuid,
    sourceSha: sha,
    artifactDigest: digest,
    archiveDigest: digest,
    publicConfigDigest: digest,
    expiresAt: z.number().int().nonnegative().safe(),
  })
  .strict();
