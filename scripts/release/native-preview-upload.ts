import { createHash } from "node:crypto";
import { extname } from "node:path";
import { hash as blake3Hash } from "blake3-wasm";
import mime from "mime";
import { z } from "zod";
import {
  type NativePublicationGrant,
  type NativePublicationReceipt,
  nativeDigest,
  nativePublicationGrantSchema,
  nativePublicationReceiptSchema,
} from "../../src/lib/delivery/release-native-preview-contracts";
import { NativePreviewReleaseReader } from "../../src/lib/delivery/release-native-preview-reader.server";
import { publicationBody, publicationFetch } from "../../src/lib/templates/publication-io";
import { artifactDigest, readReleaseArtifact } from "./artifact.mjs";

export const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const token = z.string().regex(/^[!-~]{1,16384}$/);
// Exact algorithm and MIME database used by Wrangler 4.155.0 deploy-helpers.
// The asset identifier is NOT the SHA256 used for our artifact attestations.
export const nativeAssetHash = (data: Buffer, name: string) =>
  blake3Hash(data.toString("base64") + extname(name).substring(1))
    .toString("hex")
    .slice(0, 32);
const assetContentType = (name: string) => {
  const type = mime.getType(name);
  return type?.startsWith("text/") && !type.includes("charset")
    ? `${type}; charset=utf-8`
    : (type ?? "application/null");
};
function singleAssetUpload(jwt: string) {
  try {
    return (
      JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"))
        .wrangler_single_asset_uploads === true
    );
  } catch {
    return false;
  }
}

/** Recompute every claim from inert bytes. No candidate imports/config/builds. */
export async function inspectNativeArchive(archive: Buffer) {
  const files: Map<string, Buffer> = await readReleaseArtifact(archive, { topology: "single" });
  const modules: { name: string; contentType: string; data: Buffer }[] = [];
  const assets: Record<string, { hash: string; size: number }> = Object.create(null);
  const byHash = new Map<string, { data: Buffer; contentType: string }>();
  for (const [path, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (path.startsWith("app/")) {
      const name = path.slice(4);
      modules.push({
        name,
        data,
        contentType: name === "worker.js" ? "application/javascript+module" : "application/wasm",
      });
    } else if (["assets/_headers", "assets/_redirects"].includes(path)) {
      modules.push({ name: path.slice(7), data, contentType: "text/plain" });
    } else if (path.startsWith("assets/")) {
      const name = path.slice(7),
        hash = nativeAssetHash(data, name),
        contentType = assetContentType(name);
      const previous = byHash.get(hash);
      if (previous && (!previous.data.equals(data) || previous.contentType !== contentType))
        throw Error("native_asset_collision");
      assets[`/${name}`] = { hash, size: data.length };
      byHash.set(hash, { data, contentType });
    }
  }
  if (!Object.keys(assets).length) throw Error("native_assets_missing");
  modules.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    archiveDigest: sha256(archive),
    artifactDigest: artifactDigest(files, "app") as string,
    moduleManifestDigest: nativeDigest(
      modules.map(({ name, contentType, data }) => ({
        name,
        contentType,
        size: data.length,
        sha256: sha256(data),
      })),
    ),
    assetsManifestDigest: nativeDigest(assets),
    modules,
    assets,
    byHash,
  };
}

export async function nativeJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  limit = 1048576,
): Promise<unknown> {
  const response = await publicationFetch(
    Promise.resolve().then(() =>
      fetcher(url, { ...init, redirect: "manual", credentials: "omit", signal }),
    ),
    signal,
  );
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => {});
    throw Error("native_transport_held");
  }
  return JSON.parse(Buffer.from(await publicationBody(response, limit, signal)).toString("utf8"));
}

/** Grant already durably consumed before entry. Every provider write is once
 * only. No retry, resource creation/PATCH, routes, versions or production API. */
export async function uploadNativePreview(options: {
  grant: NativePublicationGrant;
  archive: Buffer;
  cloudflareToken: string;
  reauthorize: (grant: NativePublicationGrant, signal: AbortSignal) => Promise<void>;
  persistReceipt: (receipt: NativePublicationReceipt, signal: AbortSignal) => Promise<void>;
  fetcher?: typeof fetch;
  signal: AbortSignal;
}) {
  const grant = nativePublicationGrantSchema.parse(options.grant),
    a = grant.artifact;
  const fetcher = options.fetcher ?? fetch;
  token.parse(options.cloudflareToken);
  const active = () => {
    options.signal.throwIfAborted();
    if (Date.now() >= grant.expiresAt) throw Error("native_grant_expired");
  };
  active();
  const bytes = await inspectNativeArchive(options.archive);
  for (const key of [
    "archiveDigest",
    "artifactDigest",
    "moduleManifestDigest",
    "assetsManifestDigest",
  ] as const)
    if (bytes[key] !== a[key]) throw Error("native_artifact_changed");
  if (a.targetDigest !== nativeDigest(grant.target)) throw Error("native_target_changed");
  const t = grant.target,
    base = `https://api.cloudflare.com/client/v4/accounts/${t.accountId}/workers`;
  const reader = new NativePreviewReleaseReader(t, options.cloudflareToken, fetcher);
  const preflight = async () => {
    active();
    await options.reauthorize(grant, options.signal);
    if (
      (await reader.readCurrent(options.signal)).deploymentId !== grant.expectedCurrentDeploymentId
    )
      throw Error("native_current_changed");
    active();
  };
  const post = async (
    url: string,
    body: BodyInit,
    bearer: string,
    json = false,
    contentType?: string,
  ) => {
    active();
    return z.object({ success: z.literal(true), result: z.unknown() }).parse(
      await nativeJson(
        fetcher,
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            ...(json
              ? { "Content-Type": "application/json" }
              : contentType
                ? { "Content-Type": contentType }
                : {}),
          },
          body,
        },
        options.signal,
      ),
    ).result;
  };
  await preflight();
  const session = z
    .object({ jwt: token, buckets: z.array(z.array(z.string()).min(1).max(10000)).max(10000) })
    .parse(
      await post(
        `${base}/scripts/${t.workerName}/assets-upload-session`,
        JSON.stringify({ manifest: bytes.assets }),
        options.cloudflareToken,
        true,
      ),
    );
  // Validate the COMPLETE response before submitting even the first bucket.
  const seen = new Set<string>();
  for (const bucket of session.buckets)
    for (const hash of bucket) {
      if (!bytes.byHash.has(hash) || seen.has(hash)) throw Error("native_asset_bucket_invalid");
      seen.add(hash);
    }
  let completion = session.buckets.length ? undefined : session.jwt;
  const single = singleAssetUpload(session.jwt);
  const buckets = single ? session.buckets.flat().map((hash) => [hash]) : session.buckets;
  for (const bucket of buckets) {
    let uploaded: unknown;
    if (single) {
      const hash = bucket[0],
        entry = bytes.byHash.get(hash);
      if (!entry) throw Error("native_asset_bucket_invalid");
      uploaded = await post(
        `${base}/assets/upload/${hash}`,
        new Uint8Array(entry.data),
        session.jwt,
        false,
        entry.contentType,
      );
    } else {
      const form = new FormData();
      for (const hash of bucket) {
        const entry = bytes.byHash.get(hash);
        if (!entry) throw Error("native_asset_bucket_invalid");
        form.append(
          hash,
          new Blob([entry.data.toString("base64")], { type: entry.contentType }),
          hash,
        );
      }
      uploaded = await post(`${base}/assets/upload?base64=true`, form, session.jwt);
    }
    const result = z.object({ jwt: token.optional() }).parse(uploaded);
    if (result.jwt) completion = result.jwt;
  }
  if (!completion) throw Error("native_assets_incomplete");
  const c = a.publicConfig,
    env: Record<string, unknown> = { ASSETS: { type: "assets" } };
  for (const [name, value] of Object.entries(c.vars))
    env[name] = {
      type: "plain_text",
      text:
        name === "HIVE_RELEASE_SOURCE_SHA"
          ? a.sourceSha
          : name === "HIVE_RELEASE_ARTIFACT_DIGEST"
            ? a.artifactDigest
            : value,
    };
  for (const name of c.secretNames) env[name] = { type: "inherit" };
  const metadata = {
    main_module: c.mainModule,
    compatibility_date: c.compatibilityDate,
    compatibility_flags: c.compatibilityFlags,
    limits: { cpu_ms: c.cpuMs },
    placement: c.placement,
    env,
    assets: { jwt: completion, config: c.assets },
    annotations: {
      "workers/commit_sha": a.sourceSha,
      "workers/message": `hive-release:${grant.actionId}`,
    },
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  for (const module of bytes.modules)
    form.append(
      "files",
      new Blob([new Uint8Array(module.data)], { type: module.contentType }),
      module.name,
    );
  await preflight();
  // An exception here is irreducible unknown ACK. Never infer from annotations.
  const result = z
    .object({
      id: nativePublicationReceiptSchema.shape.deploymentId,
      created_on: nativePublicationReceiptSchema.shape.providerCreatedAt,
    })
    .parse(
      await post(
        `${base}/workers/${t.workerName}/previews/${encodeURIComponent(t.previewId)}/deployments`,
        form,
        options.cloudflareToken,
      ),
    );
  const receipt = nativePublicationReceiptSchema.parse({
    schemaVersion: 1,
    provider: "cloudflare-native-preview",
    grantId: grant.id,
    actionId: grant.actionId,
    requestDigest: grant.requestDigest,
    previewId: t.previewId,
    deploymentId: result.id,
    providerCreatedAt: result.created_on,
    sourceSha: a.sourceSha,
    artifactDigest: a.artifactDigest,
    publicConfigDigest: nativeDigest(a.publicConfig),
    archiveDigest: a.archiveDigest,
    moduleManifestDigest: a.moduleManifestDigest,
    assetsManifestDigest: a.assetsManifestDigest,
    publisher: grant.publisher,
  });
  // No provider readback before this acknowledgement. The installed controller
  // independently verifies exact deployment/config/currentness during reconcile.
  await options.persistReceipt(receipt, options.signal);
  return receipt;
}
