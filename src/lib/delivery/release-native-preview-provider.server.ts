import type { z } from "zod";
import {
  RELEASE_HEALTH_PATH,
  withReleaseDeadline,
} from "../../../deploy/cloudflare/app/release-health";
import { publicationBody, publicationFetch } from "../templates/publication-io";
import {
  type NativePublicationGrant,
  type NativePublicationReceipt,
  nativeDigest,
  nativePublicationGrantSchema,
  nativePublicationReceiptSchema,
} from "./release-native-preview-contracts";
import {
  NativePreviewReleaseReader,
  nativePreviewReleaseTargetSchema,
} from "./release-native-preview-reader.server";

/** Controller has a READ credential only. Publication is performed solely by
 * the protected byte-only publisher. Readback does not redispatch unknown work. */
export class NativePreviewPublicationReadback {
  readonly target: z.infer<typeof nativePreviewReleaseTargetSchema>;
  private readonly reader: NativePreviewReleaseReader;
  constructor(
    target: unknown,
    private readonly token: string,
    private readonly probeSecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.target = nativePreviewReleaseTargetSchema.parse(target);
    this.reader = new NativePreviewReleaseReader(this.target, token, fetcher);
    if (probeSecret && !/^[a-f0-9]{64}$/.test(probeSecret))
      throw Error("native_readback_unavailable");
  }
  readCurrent(signal: AbortSignal) {
    return this.reader.readCurrent(signal);
  }
  private async get(url: string, headers: Record<string, string>, signal: AbortSignal) {
    const response = await publicationFetch(
      Promise.resolve().then(() =>
        this.fetcher(url, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers,
          signal,
        }),
      ),
      signal,
    );
    if (response.status !== 200 || response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw Error();
    }
    return JSON.parse(Buffer.from(await publicationBody(response, 65536, signal)).toString("utf8"));
  }
  private async current(receipt: NativePublicationReceipt, signal: AbortSignal) {
    const current = await this.reader.readCurrent(signal);
    if (current.previewId !== receipt.previewId || current.deploymentId !== receipt.deploymentId)
      throw Error();
  }
  async verify(rawGrant: unknown, rawReceipt: unknown, parent: AbortSignal) {
    try {
      return await withReleaseDeadline(
        async (signal) => {
          const grant = nativePublicationGrantSchema.parse(rawGrant),
            receipt = nativePublicationReceiptSchema.parse(rawReceipt),
            a = grant.artifact,
            c = a.publicConfig;
          if (
            nativeDigest(grant.target) !== nativeDigest(this.target) ||
            receipt.grantId !== grant.id ||
            receipt.actionId !== grant.actionId ||
            receipt.requestDigest !== grant.requestDigest ||
            receipt.previewId !== this.target.previewId ||
            receipt.sourceSha !== a.sourceSha ||
            receipt.artifactDigest !== a.artifactDigest ||
            receipt.publicConfigDigest !== nativeDigest(c) ||
            receipt.archiveDigest !== a.archiveDigest ||
            receipt.moduleManifestDigest !== a.moduleManifestDigest ||
            receipt.assetsManifestDigest !== a.assetsManifestDigest ||
            nativeDigest(receipt.publisher) !== nativeDigest(grant.publisher)
          )
            throw Error();
          const created = Date.parse(receipt.providerCreatedAt);
          if (created < grant.issuedAt || created >= grant.expiresAt) throw Error();
          await this.current(receipt, signal);
          const envelope = await this.get(
            `https://api.cloudflare.com/client/v4/accounts/${this.target.accountId}/workers/workers/hive/previews/${encodeURIComponent(this.target.previewId)}/deployments/${encodeURIComponent(receipt.deploymentId)}`,
            { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
            signal,
          );
          if (envelope.success !== true || envelope.errors?.length) throw Error();
          const d = envelope.result;
          if (
            d?.id !== receipt.deploymentId ||
            d.created_on !== receipt.providerCreatedAt ||
            d.main_module !== c.mainModule ||
            d.compatibility_date !== c.compatibilityDate ||
            nativeDigest([...(d.compatibility_flags ?? [])].sort()) !==
              nativeDigest([...c.compatibilityFlags].sort()) ||
            d.limits?.cpu_ms !== c.cpuMs ||
            d.placement?.region !== c.placement.region ||
            d.annotations?.["workers/message"] !== `hive-release:${grant.actionId}` ||
            d.assets?.config?.run_worker_first !== c.assets.run_worker_first
          )
            throw Error();
          const expectedVars = {
            ...c.vars,
            HIVE_RELEASE_SOURCE_SHA: a.sourceSha,
            HIVE_RELEASE_ARTIFACT_DIGEST: a.artifactDigest,
          };
          const expectedNames = [...Object.keys(expectedVars), ...c.secretNames, "ASSETS"].sort();
          if (
            !d.env ||
            Array.isArray(d.env) ||
            nativeDigest(Object.keys(d.env).sort()) !== nativeDigest(expectedNames)
          )
            throw Error();
          // Compare approved public values, NEVER hash/read/return secret payloads.
          for (const [name, text] of Object.entries(expectedVars))
            if (d.env[name]?.type !== "plain_text" || d.env[name]?.text !== text) throw Error();
          for (const name of c.secretNames) if (d.env[name]?.type !== "secret_text") throw Error();
          if (d.env.ASSETS?.type !== "assets") throw Error();
          await this.current(receipt, signal);
          return {
            provider: "cloudflare-native-preview" as const,
            actionId: grant.actionId,
            requestDigest: grant.requestDigest,
            previewId: receipt.previewId,
            deploymentId: receipt.deploymentId,
            artifactId: a.id,
            sourceSha: a.sourceSha,
            artifactDigest: a.artifactDigest,
            publicConfigDigest: nativeDigest(c),
            privateBindingRevision: a.privateBindingRevision,
            compatibilityRevision: a.compatibilityRevision,
            publicationReceiptDigest: nativeDigest(receipt),
          };
        },
        parent,
        20000,
      );
    } catch {
      throw Error("native_publication_readback_held");
    }
  }
  /** A bounded authenticated sample, not global metrics or continuous exclusion.
   * Identity is read before/after every probe and no parent-script analytics are
   * attributed to a branch. Lifecycle uses an explicit sampled-only discriminator. */
  async sample(
    grant: NativePublicationGrant,
    receipt: NativePublicationReceipt,
    parent: AbortSignal,
  ) {
    try {
      return await withReleaseDeadline(
        async (signal) => {
          if (!this.probeSecret) throw Error();
          await this.current(receipt, signal);
          const health = await this.get(
            `${this.target.origin}${RELEASE_HEALTH_PATH}`,
            { "X-Hive-Release-Probe": this.probeSecret },
            signal,
          );
          if (health.schemaVersion !== 1) throw Error();
          for (const component of ["app", "auth"] as const)
            if (
              health[component]?.component !== component ||
              health[component]?.ready !== true ||
              health[component]?.sourceSha !== receipt.sourceSha ||
              health[component]?.artifactDigest !== receipt.artifactDigest
            )
              throw Error();
          await this.current(receipt, signal);
          return {
            provider: "cloudflare-native-preview" as const,
            scope: "sampled-health-no-atomic-exclusion" as const,
            actionId: grant.actionId,
            artifactId: grant.artifact.id,
            previewId: receipt.previewId,
            deploymentId: receipt.deploymentId,
            sourceSha: receipt.sourceSha,
            artifactDigest: receipt.artifactDigest,
            publicConfigDigest: receipt.publicConfigDigest,
            sampledAt: Date.now(),
            smoke: "passed" as const,
            metrics: "sampled-only" as const,
          };
        },
        parent,
        20000,
      );
    } catch {
      throw Error("native_sampled_health_held");
    }
  }
}
