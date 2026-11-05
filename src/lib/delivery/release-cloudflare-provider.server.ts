import { z } from "zod";
import { githubSourceDigest } from "./github-evidence.server";
import type { ReleaseActionIdentity } from "./release-action-journal";
import { releaseBuildManifestSchema } from "./release-build-attestation.server";
import type { ReleaseEffectProvider } from "./release-effect-runner.server";

const uuid = z.string().uuid();
export const cloudflareReleaseTargetSchema = z
  .object({
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    environment: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    scripts: z
      .object({
        app: z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/),
        auth: z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/),
      })
      .strict(),
    // Operator acknowledges out-of-band writers can race: Cloudflare does not
    // document a compare-and-swap deployment precondition.
    hiveReleaseWriter: z.literal(true),
  })
  .strict()
  .refine((v) => v.scripts.app !== v.scripts.auth);
export function releaseTargetResources(rawTarget: unknown) {
  const target = cloudflareReleaseTargetSchema.parse(rawTarget);
  return Object.values(target.scripts)
    .map((script) =>
      githubSourceDigest({ provider: "cloudflare-worker", accountId: target.accountId, script }),
    )
    .sort();
}
export const cloudflareReleaseRequestSchema = z
  .object({
    component: z.enum(["app", "auth"]),
    expectedDeploymentId: uuid,
    expectedVersionId: uuid,
    versionId: uuid,
    mergedSha: z.string().regex(/^[a-f0-9]{40}$/),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    configDigest: z.string().regex(/^[a-f0-9]{64}$/),
    baselineSourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    baselineArtifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    baselineConfigDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const deploymentSchema = z
  .object({
    id: uuid,
    strategy: z.literal("percentage"),
    versions: z
      .array(z.object({ version_id: uuid, percentage: z.number() }).passthrough())
      .length(1),
    annotations: z.object({ "workers/message": z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

/** Fixed account/scripts supplied by operator deployment config. No factory is
 * installed by this slice. Authenticated provider facts and artifact provenance
 * must be separately verified before journal.begin authorizes this adapter. */
export class CloudflareReleaseProvider implements ReleaseEffectProvider {
  private readonly target: z.infer<typeof cloudflareReleaseTargetSchema>;
  constructor(
    rawTarget: unknown,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.target = cloudflareReleaseTargetSchema.parse(rawTarget);
    if (!token || token.length > 4096) throw new Error("release_provider_unavailable");
  }
  private validate(identity: ReleaseActionIdentity) {
    if (
      !["promote", "recover"].includes(identity.kind) ||
      githubSourceDigest(this.target) !== identity.targetDigest
    )
      throw new Error("release_provider_scope");
    return cloudflareReleaseRequestSchema.parse(identity.request);
  }
  private async call(path: string, init: RequestInit, signal: AbortSignal) {
    const response = await this.fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${this.target.accountId}/workers/scripts/${path}`,
      {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        redirect: "error",
        signal,
      },
    );
    if (!response.ok || !response.body) throw new Error("release_provider_unavailable");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 1024 * 1024) throw new Error("release_provider_limit");
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body?.success !== true) throw new Error("release_provider_unavailable");
    return body.result;
  }
  private async current(script: string, signal: AbortSignal) {
    const body = await this.call(
      `${encodeURIComponent(script)}/deployments?page=1&per_page=1`,
      { method: "GET" },
      signal,
    );
    if (!Array.isArray(body?.deployments) || body.deployments.length !== 1)
      throw new Error("release_provider_current_unknown");
    return deploymentSchema.parse(body.deployments[0]);
  }
  async inspectCurrent(component: "app" | "auth", signal: AbortSignal) {
    const deployment = await this.current(this.target.scripts[component], signal);
    if (deployment.versions[0].percentage !== 100)
      throw new Error("release_provider_current_unknown");
    return { deploymentId: deployment.id, versionId: deployment.versions[0].version_id };
  }
  async inspectVersion(component: "app" | "auth", versionId: string, signal: AbortSignal) {
    uuid.parse(versionId);
    const result = z
      .object({
        id: uuid,
        resources: z
          .object({
            script: z.object({ etag: z.string().min(1).max(256) }).passthrough(),
            bindings: z.unknown(),
            script_runtime: z.unknown(),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(
        await this.call(
          `${encodeURIComponent(this.target.scripts[component])}/versions/${versionId}`,
          { method: "GET" },
          signal,
        ),
      );
    if (
      result.id !== versionId ||
      result.resources.bindings === undefined ||
      result.resources.script_runtime === undefined ||
      signal.aborted
    )
      throw new Error("release_build_version_mismatch");
    return {
      providerScriptHash: result.resources.script.etag,
      configDigest: githubSourceDigest({
        bindings: result.resources.bindings,
        runtime: result.resources.script_runtime,
      }),
    };
  }
  async verifyUploaded(raw: unknown, signal: AbortSignal) {
    const manifest = releaseBuildManifestSchema.parse(raw);
    if (manifest.targetDigest !== githubSourceDigest(this.target))
      throw new Error("release_build_scope");
    for (const component of ["app", "auth"] as const) {
      const expected = manifest[component];
      if (expected.script !== this.target.scripts[component])
        throw new Error("release_build_scope");
      const result = await this.inspectVersion(component, expected.versionId, signal);
      if (
        result.providerScriptHash !== expected.providerScriptHash ||
        result.configDigest !== expected.configDigest
      )
        throw new Error("release_build_version_mismatch");
    }
    if (signal.aborted) throw new Error("release_build_verification_aborted");
    return true;
  }
  private result(
    identity: ReleaseActionIdentity,
    request: z.infer<typeof cloudflareReleaseRequestSchema>,
    deployment: z.infer<typeof deploymentSchema>,
  ) {
    if (
      deployment.versions[0].percentage !== 100 ||
      deployment.versions[0].version_id !== request.versionId ||
      deployment.annotations?.["workers/message"] !== `hive-release:${identity.id}`
    )
      return null;
    const evidence = {
      provider: "cloudflare",
      deploymentId: deployment.id,
      versionId: request.versionId,
      component: request.component,
      mergedSha: request.mergedSha,
      artifactDigest: request.artifactDigest,
      configDigest: request.configDigest,
      actionId: identity.id,
      targetDigest: identity.targetDigest,
    };
    return {
      requestDigest: identity.requestDigest,
      receiptDigest: githubSourceDigest(evidence),
      evidence,
    };
  }
  async dispatch(identity: ReleaseActionIdentity, signal: AbortSignal) {
    const request = this.validate(identity),
      script = this.target.scripts[request.component];
    const before = await this.current(script, signal);
    if (
      before.id !== request.expectedDeploymentId ||
      before.versions[0].percentage !== 100 ||
      before.versions[0].version_id !== request.expectedVersionId
    )
      throw new Error("release_baseline_changed");
    const result = deploymentSchema.parse(
      await this.call(
        `${encodeURIComponent(script)}/deployments`,
        {
          method: "POST",
          body: JSON.stringify({
            strategy: "percentage",
            versions: [{ version_id: request.versionId, percentage: 100 }],
            annotations: { "workers/message": `hive-release:${identity.id}` },
          }),
        },
        signal,
      ),
    );
    const receipt = this.result(identity, request, result);
    if (!receipt) throw new Error("release_provider_result_mismatch");
    const after = await this.current(script, signal);
    if (after.id !== result.id || !this.result(identity, request, after))
      throw new Error("release_provider_current_changed");
    return receipt;
  }
  async lookup(
    identity: ReleaseActionIdentity,
    _reference: Record<string, unknown> | null,
    signal: AbortSignal,
  ) {
    const request = this.validate(identity),
      script = this.target.scripts[request.component];
    const current = await this.current(script, signal);
    return this.result(identity, request, current);
  }
}
