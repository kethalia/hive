import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  nativeBuildPolicySchema,
  verifyNativeBuilder,
} from "../../src/lib/delivery/release-native-preview-authority.server";
import {
  nativeArtifactSchema,
  nativeDigest,
  nativePublicationGrantSchema,
  nativePublicConfigSchema,
  nativePublisherIdentitySchema,
  nativePublisherPolicySchema,
} from "../../src/lib/delivery/release-native-preview-contracts";
import { nativePreviewReleaseTargetSchema } from "../../src/lib/delivery/release-native-preview-reader.server";
import { downloadNativeArtifact } from "./native-preview-artifact-download";
import { inspectNativeArchive, nativeJson, uploadNativePreview } from "./native-preview-upload";

const id = z.string().regex(/^[1-9][0-9]{0,19}$/),
  uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const nativePublisherConfigSchema = z
  .object({
    controllerOrigin: z.string().url(),
    target: nativePreviewReleaseTargetSchema,
    publicConfig: nativePublicConfigSchema,
    privateBindingRevision: uuid,
    compatibilityRevision: uuid,
    builderPolicy: nativeBuildPolicySchema,
    publisherPolicy: nativePublisherPolicySchema,
    bootstrapEnabled: z.boolean().default(false),
  })
  .strict();
// Workflow inputs are selectors only. Both protected publisher and controller
// independently resolve their source/build/artifact authority before effects.
export const nativePublisherScopeSchema = z
  .object({
    purpose: z.enum(["bootstrap-baseline", "publish", "recover"]),
    ownerId: uuid,
    releaseId: uuid,
    artifactId: uuid,
    artifactReleaseId: uuid,
    actionId: uuid.optional(),
    sourceSha: sha,
    builderRunId: id,
    builderRunAttempt: z.number().int().positive().safe(),
    builderArtifactId: id,
  })
  .strict();
type PublisherOptions = {
  config: unknown;
  scope: unknown;
  publisher: unknown;
  githubToken: string;
  cloudflareToken: string;
  oidcUrl: string;
  oidcRequestToken: string;
  controllerBearer?: string;
  signal: AbortSignal;
  fetcher?: typeof fetch;
};

export async function publishNativePreview(options: PublisherOptions) {
  const config = nativePublisherConfigSchema.parse(options.config),
    scope = nativePublisherScopeSchema.parse(options.scope);
  const publisher = nativePublisherIdentitySchema.parse(options.publisher),
    fetcher = options.fetcher ?? fetch;
  const origin = new URL(config.controllerOrigin),
    oidc = new URL(options.oidcUrl);
  if (
    origin.protocol !== "https:" ||
    origin.origin === config.target.origin ||
    origin.username ||
    origin.password ||
    origin.port ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    oidc.protocol !== "https:" ||
    oidc.username ||
    oidc.password ||
    oidc.port ||
    oidc.hash ||
    !oidc.hostname.endsWith(".actions.githubusercontent.com") ||
    !/^[!-~]{1,16384}$/.test(options.oidcRequestToken) ||
    !/^[!-~]{1,4096}$/.test(options.cloudflareToken) ||
    (options.controllerBearer !== undefined && !/^[!-~]{1,4096}$/.test(options.controllerBearer)) ||
    publisher.repositoryId !== config.publisherPolicy.repositoryId ||
    publisher.repositoryOwnerId !== config.publisherPolicy.repositoryOwnerId ||
    publisher.workflowSha !== config.publisherPolicy.workflowSha ||
    (scope.purpose === "bootstrap-baseline" && !config.bootstrapEnabled) ||
    (scope.purpose !== "recover" && scope.artifactReleaseId !== scope.releaseId) ||
    (scope.purpose === "recover" && !scope.actionId)
  )
    throw Error("native_publisher_scope_invalid");
  options.signal.throwIfAborted();
  const post = async (
    operation: "artifact" | "grant" | "reauthorize" | "receipt",
    body: unknown,
  ) => {
    const audience = `${config.publisherPolicy.audiencePrefix}${operation}:${nativeDigest(body)}`;
    const request = new URL(oidc);
    request.searchParams.set("audience", audience);
    const authorization = z.object({ value: z.string().regex(/^[A-Za-z0-9_.-]{1,16384}$/) }).parse(
      await nativeJson(
        fetcher,
        request.toString(),
        {
          method: "GET",
          headers: { Authorization: `Bearer ${options.oidcRequestToken}` },
        },
        options.signal,
        32768,
      ),
    );
    return nativeJson(
      fetcher,
      new URL(`/api/internal/native-release/${operation}`, origin).toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hive-Release-OIDC": authorization.value,
          ...(options.controllerBearer
            ? { Authorization: `Bearer ${options.controllerBearer}` }
            : {}),
        },
        body: JSON.stringify(body),
      },
      options.signal,
      65536,
    );
  };
  const downloaded = await downloadNativeArtifact({
    artifactId: scope.builderArtifactId,
    token: options.githubToken,
    signal: options.signal,
    fetcher,
  });
  const inspected = await inspectNativeArchive(downloaded.archive);
  const artifact = nativeArtifactSchema.parse({
    schemaVersion: 1,
    provider: "cloudflare-native-preview",
    id: scope.artifactId,
    ownerId: scope.ownerId,
    releaseId: scope.artifactReleaseId,
    targetDigest: nativeDigest(config.target),
    sourceSha: scope.sourceSha,
    archiveDigest: inspected.archiveDigest,
    artifactDigest: inspected.artifactDigest,
    moduleManifestDigest: inspected.moduleManifestDigest,
    assetsManifestDigest: inspected.assetsManifestDigest,
    builder: {
      repositoryId: config.builderPolicy.repositoryId,
      repositoryOwnerId: config.builderPolicy.repositoryOwnerId,
      runId: scope.builderRunId,
      runAttempt: scope.builderRunAttempt,
      artifactId: scope.builderArtifactId,
      artifactZipDigest: downloaded.artifactZipDigest,
      workflowId: config.builderPolicy.workflowId,
    },
    publicConfig: config.publicConfig,
    privateBindingRevision: config.privateBindingRevision,
    compatibilityRevision: config.compatibilityRevision,
  });
  await verifyNativeBuilder(
    artifact,
    config.builderPolicy,
    options.githubToken,
    options.signal,
    fetcher,
  );
  let actionId = scope.actionId;
  if (scope.purpose !== "recover") {
    const result = z
      .object({ artifactId: uuid, actionId: uuid })
      .parse(await post("artifact", artifact));
    if (
      result.artifactId !== artifact.id ||
      result.actionId !== artifact.id ||
      (actionId && actionId !== result.actionId)
    )
      throw Error("native_artifact_receipt_changed");
    actionId = result.actionId;
  }
  const grant = nativePublicationGrantSchema.parse(
    await post("grant", { actionId, ownerId: scope.ownerId, publisher }),
  );
  // Recovery restores the exact retained public configuration authenticated by
  // the controller's grant. Its bytes, builder/source/selectors and approved
  // private/compatibility revisions still must match independently recomputed
  // facts. Ordinary publication must use the protected current configuration.
  const expectedArtifact =
    scope.purpose === "recover"
      ? { ...artifact, publicConfig: grant.artifact.publicConfig }
      : artifact;
  if (
    grant.actionId !== actionId ||
    grant.ownerId !== scope.ownerId ||
    grant.releaseId !== scope.releaseId ||
    grant.purpose !== scope.purpose ||
    nativeDigest(grant.publisher) !== nativeDigest(publisher) ||
    nativeDigest(grant.target) !== nativeDigest(config.target) ||
    nativeDigest(grant.artifact) !== nativeDigest(expectedArtifact)
  )
    throw Error("native_grant_scope_changed");
  // Once this grant is issued, every failure is held. In particular, no loop or
  // job retry can recover the right to upload by calling grant again.
  return uploadNativePreview({
    grant,
    archive: downloaded.archive,
    cloudflareToken: options.cloudflareToken,
    signal: options.signal,
    fetcher,
    reauthorize: async (current) => {
      const result = z.object({ authorized: z.literal(true), grantDigest: z.string() }).parse(
        await post("reauthorize", {
          grantId: current.id,
          actionId: current.actionId,
          ownerId: current.ownerId,
          publisher,
        }),
      );
      if (result.grantDigest !== nativeDigest(grant)) throw Error("native_grant_scope_changed");
    },
    persistReceipt: async (receipt) => {
      const result = z
        .object({ stored: z.literal(true), receiptDigest: z.string() })
        .parse(await post("receipt", receipt));
      if (result.receiptDigest !== nativeDigest(receipt)) throw Error("native_receipt_ack_changed");
    },
  });
}

async function main() {
  if (process.env.HIVE_NATIVE_RELEASE_PUBLISH_ENABLED !== "true")
    throw Error("native_publisher_disabled");
  const parse = (value: string | undefined) => {
    if (!value || Buffer.byteLength(value) > 32768) throw Error("native_publisher_config_invalid");
    return JSON.parse(value);
  };
  const config = nativePublisherConfigSchema.parse(
    parse(process.env.HIVE_NATIVE_RELEASE_PUBLISH_CONFIG_JSON),
  );
  const receipt = await publishNativePreview({
    config,
    scope: parse(process.env.HIVE_NATIVE_RELEASE_SCOPE_JSON),
    publisher: {
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      repositoryOwnerId: process.env.GITHUB_REPOSITORY_OWNER_ID,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      workflowSha: config.publisherPolicy.workflowSha,
    },
    githubToken: process.env.GITHUB_TOKEN ?? "",
    cloudflareToken: process.env.HIVE_NATIVE_RELEASE_CLOUDFLARE_TOKEN ?? "",
    oidcUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "",
    oidcRequestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "",
    controllerBearer: process.env.HIVE_NATIVE_RELEASE_CONTROLLER_BEARER || undefined,
    signal: AbortSignal.timeout(240000),
  });
  process.stdout.write(
    `Native publication receipt stored: ${receipt.actionId} ${receipt.deploymentId}\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write(
      "Native publication held; reconcile the existing action. Do not retry upload.\n",
    );
    process.exitCode = 1;
  });
