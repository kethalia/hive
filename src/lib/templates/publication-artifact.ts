import { createHash } from "node:crypto";
import manifest from "./artifact-manifest.json";
import { KNOWN_TEMPLATES, type KnownTemplate } from "./catalog";
import {
  PUBLICATION_LIMITS,
  type TemplateArtifactIdentity,
  TemplatePublicationError,
} from "./publication-contracts";
import { cancelPublicationBody, publicationBody, publicationFetch } from "./publication-io";

export function templatePublicationArtifact(name: string): TemplateArtifactIdentity {
  if (!(KNOWN_TEMPLATES as readonly string[]).includes(name))
    throw new TemplatePublicationError("invalid_request");
  const entry = manifest.templates[name as KnownTemplate];
  if (
    manifest.schemaVersion !== 1 ||
    ![entry.contentHash, entry.archiveDigest].every((v) => /^[a-f0-9]{64}$/.test(v)) ||
    !Number.isSafeInteger(entry.archiveBytes) ||
    entry.archiveBytes <= 0 ||
    entry.archiveBytes > PUBLICATION_LIMITS.artifactBytes
  )
    throw new TemplatePublicationError("artifact_unavailable");
  return {
    name,
    contentHash: entry.contentHash,
    archiveDigest: entry.archiveDigest,
    archiveBytes: entry.archiveBytes,
    manifestDigest: createHash("sha256")
      .update(JSON.stringify({ schemaVersion: 1, name, ...entry }))
      .digest("hex"),
  };
}
export interface TemplateAssets {
  fetch: typeof fetch;
}
/** A fixed ASSETS binding, never an external URL or a runtime source directory. */
export function templateAssetsLoader(assets: TemplateAssets) {
  if (!assets || typeof assets.fetch !== "function")
    throw new TemplatePublicationError("artifact_unavailable");
  return async (identity: TemplateArtifactIdentity) => {
    const expected = templatePublicationArtifact(identity.name);
    if (
      Object.keys(identity).length !== Object.keys(expected).length ||
      !Object.keys(expected).every(
        (k) =>
          expected[k as keyof TemplateArtifactIdentity] ===
          identity[k as keyof TemplateArtifactIdentity],
      )
    )
      throw new TemplatePublicationError("artifact_changed");
    const signal = AbortSignal.timeout(5000);
    const response = await publicationFetch(
      assets.fetch(
        new Request(
          `https://hive-artifacts.invalid/hive-template-artifacts/${identity.archiveDigest}.tar`,
          {
            redirect: "manual",
            credentials: "omit",
            headers: { "Accept-Encoding": "identity" },
            signal,
          },
        ),
      ),
      signal,
    );
    if (response.status !== 200 || response.redirected) {
      await cancelPublicationBody(response);
      throw new TemplatePublicationError("artifact_unavailable");
    }
    const bytes = await publicationBody(response, identity.archiveBytes, signal);
    if (
      bytes.byteLength !== identity.archiveBytes ||
      createHash("sha256").update(bytes).digest("hex") !== identity.archiveDigest
    )
      throw new TemplatePublicationError("artifact_changed");
    return bytes;
  };
}
