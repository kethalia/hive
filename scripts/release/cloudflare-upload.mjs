import { createHash } from "node:crypto";
import { extname } from "node:path";
import { hash as blake3Hash } from "blake3-wasm";
import mime from "mime";
import { artifactDigest, readReleaseArtifact } from "./artifact.mjs";

// Match the pinned Wrangler 4.155.0 asset uploader. Its provider asset hashes
// use BLAKE3; artifact/config attestation digests below remain SHA256.
const assetContentType = (path) => {
  const type = mime.getType(path);
  return type?.startsWith("text/") && !type.includes("charset")
    ? `${type}; charset=utf-8`
    : (type ?? "application/null");
};
function singleAssetUpload(jwt) {
  try {
    return (
      JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"))
        .wrangler_single_asset_uploads === true
    );
  } catch {
    return false;
  }
}
const tokenValid = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[\r\n]/.test(value);
async function api(fetcher, url, options, signal) {
  const response = await fetcher(url, { ...options, signal, redirect: "error" });
  if (!response.ok || !response.body) throw Error("upload_api_failed");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw Error("upload_aborted");
      const { done, value } = await reader.read();
      if (signal.aborted) throw Error("upload_aborted");
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw Error("upload_response_size");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (result?.success !== true || !result.result || typeof result.result !== "object")
    throw Error("upload_api_failed");
  return result.result;
}

// All target and metadata values must come from deployment-owned reviewed
// configuration, never the candidate artifact or reusable workflow inputs.
// Upload creates versions only and does not create a deployment or routes.
export async function uploadReleaseVersion({
  archive,
  component,
  accountId,
  script,
  metadata,
  expectedConfigDigest,
  sourceSha,
  apiToken,
  fetcher = fetch,
  signal,
  topology,
}) {
  if (
    !["app", "auth"].includes(component) ||
    !/^[a-f0-9]{32}$/.test(accountId) ||
    !/^[a-zA-Z0-9_-]{1,63}$/.test(script) ||
    !/^[a-f0-9]{64}$/.test(expectedConfigDigest) ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    !tokenValid(apiToken) ||
    !signal ||
    signal.aborted
  )
    throw Error("upload_scope");
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.keys(metadata).some(
      (k) => !["compatibility_date", "compatibility_flags", "bindings", "assets"].includes(k),
    ) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(metadata.compatibility_date) ||
    !Array.isArray(metadata.bindings) ||
    !Array.isArray(metadata.compatibility_flags) ||
    (component === "auth" && metadata.assets)
  )
    throw Error("upload_config");
  if (!Buffer.isBuffer(archive) || archive.length === 0 || archive.length > 128 * 1024 * 1024)
    throw Error("artifact_size");
  if (topology === "single" && component !== "app") throw Error("upload_scope");
  const files = await readReleaseArtifact(Buffer.from(archive), { topology });
  const artifact = artifactDigest(files, component);
  const identityFields = {
    HIVE_RELEASE_SOURCE_SHA: { expected: sourceSha, placeholder: "{{source_sha}}" },
    HIVE_RELEASE_ARTIFACT_DIGEST: { expected: artifact, placeholder: "{{artifact_digest}}" },
  };
  function replaceIdentity(bindings, mode) {
    const counts = new Map(Object.keys(identityFields).map((k) => [k, 0]));
    const changed = bindings.map((binding) => {
      const entry = Object.hasOwn(identityFields, binding?.name)
        ? identityFields[binding.name]
        : undefined;
      if (!entry) return binding;
      counts.set(binding.name, counts.get(binding.name) + 1);
      if (
        binding.type !== "plain_text" ||
        binding.text !== (mode === "write" ? entry.placeholder : entry.expected)
      )
        throw Error("upload_identity_changed");
      return { ...binding, text: mode === "write" ? entry.expected : entry.placeholder };
    });
    if ([...counts.values()].some((value) => value !== 1)) throw Error("upload_identity_changed");
    return changed;
  }
  const fixedBindings = replaceIdentity(metadata.bindings, "write");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers`;
  const target = `${base}/scripts/${script}`;
  const request = (url, body, token, json = false, contentType) =>
    api(
      fetcher,
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(json
            ? { "Content-Type": "application/json" }
            : contentType
              ? { "Content-Type": contentType }
              : {}),
        },
        body,
      },
      signal,
    );
  let completion;
  if (component === "app") {
    const manifest = Object.create(null),
      byHash = new Map();
    for (const [name, data] of files)
      if (name.startsWith("assets/")) {
        const path = name.slice(7),
          extension = extname(path).slice(1),
          hash = blake3Hash(data.toString("base64") + extension)
            .toString("hex")
            .slice(0, 32);
        const contentType = assetContentType(path);
        if (
          byHash.has(hash) &&
          (!byHash.get(hash).data.equals(data) || byHash.get(hash).contentType !== contentType)
        )
          throw Error("upload_asset_collision");
        manifest[`/${path}`] = { hash, size: data.length };
        byHash.set(hash, { data, contentType });
      }
    if (!Object.keys(manifest).length) throw Error("upload_assets_missing");
    const session = await request(
      `${target}/assets-upload-session`,
      JSON.stringify({ manifest }),
      apiToken,
      true,
    );
    if (
      !tokenValid(session.jwt) ||
      !Array.isArray(session.buckets) ||
      session.buckets.length > 10000
    )
      throw Error("upload_session_invalid");
    const seen = new Set();
    completion = session.buckets.length ? undefined : session.jwt;
    // Validate the entire provider response before the first bucket effect.
    for (const bucket of session.buckets) {
      if (!Array.isArray(bucket) || !bucket.length || bucket.length > 10000)
        throw Error("upload_bucket_invalid");
      for (const hash of bucket) {
        if (typeof hash !== "string" || !byHash.has(hash) || seen.has(hash))
          throw Error("upload_bucket_invalid");
        seen.add(hash);
      }
    }
    const single = singleAssetUpload(session.jwt);
    const buckets = single ? session.buckets.flat().map((hash) => [hash]) : session.buckets;
    for (const bucket of buckets) {
      let result;
      if (single) {
        const hash = bucket[0],
          { data, contentType } = byHash.get(hash);
        result = await request(
          `${base}/assets/upload/${hash}`,
          new Uint8Array(data),
          session.jwt,
          false,
          contentType,
        );
      } else {
        const form = new FormData();
        for (const hash of bucket) {
          const { data, contentType } = byHash.get(hash);
          form.append(hash, new Blob([data.toString("base64")], { type: contentType }), hash);
        }
        result = await request(`${base}/assets/upload?base64=true`, form, session.jwt);
      }
      if (result.jwt !== undefined) {
        if (!tokenValid(result.jwt)) throw Error("upload_session_invalid");
        completion = result.jwt;
      }
    }
    if (!completion) throw Error("upload_incomplete");
  }
  const form = new FormData();
  const fixedMetadata = {
    ...metadata,
    bindings: fixedBindings,
    main_module: "worker.js",
    ...(completion ? { assets: { ...metadata.assets, jwt: completion } } : {}),
  };
  form.append("metadata", JSON.stringify(fixedMetadata));
  for (const [name, data] of files)
    if (name.startsWith(`${component}/`)) {
      const filename = name.slice(component.length + 1);
      form.append(
        filename,
        new Blob([data], {
          type: filename === "worker.js" ? "application/javascript+module" : "application/wasm",
        }),
        filename,
      );
    }
  const result = await request(`${target}/versions?bindings_inherit=strict`, form, apiToken);
  if (
    typeof result.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.id)
  )
    throw Error("upload_receipt_invalid");
  const version = await api(
    fetcher,
    `${target}/versions/${result.id}`,
    { method: "GET", headers: { Authorization: `Bearer ${apiToken}` } },
    signal,
  );
  const resources = version.resources;
  if (
    version.id !== result.id ||
    !resources ||
    !Array.isArray(resources.bindings) ||
    !resources.script_runtime ||
    typeof resources.script?.etag !== "string" ||
    !resources.script.etag ||
    resources.script.etag.length > 256
  )
    throw Error("upload_readback_invalid");
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  const actualConfig = { bindings: resources.bindings, runtime: resources.script_runtime };
  const configDigest = createHash("sha256")
    .update(JSON.stringify(canonical(actualConfig)))
    .digest("hex");
  const normalized = {
    bindings: replaceIdentity(resources.bindings, "read"),
    runtime: resources.script_runtime,
  };
  const templateDigest = createHash("sha256")
    .update(JSON.stringify(canonical(normalized)))
    .digest("hex");
  if (templateDigest !== expectedConfigDigest) throw Error("upload_config_changed");
  return {
    script,
    versionId: result.id,
    artifactDigest: artifact,
    configDigest,
    providerScriptHash: resources.script.etag,
  };
}
