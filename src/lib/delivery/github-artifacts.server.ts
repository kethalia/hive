import { createHash } from "node:crypto";
import type { ImmutableGitHubArtifactStore } from "./github-persistence.server";
import { DeliveryConflict } from "./state";

export const GITHUB_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export interface EvidenceR2Object {
  key: string;
  size: number;
  body: ReadableStream<Uint8Array>;
}
/** Deliberately no delete, list, multipart, arbitrary URL or public-bucket API. */
export interface EvidenceR2Bucket {
  put(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    options: {
      onlyIf: Headers;
      sha256: string;
      httpMetadata: { contentType: string; cacheControl: string };
      customMetadata: { contentDigest: string };
    },
  ): Promise<unknown>;
  get(key: string): Promise<EvidenceR2Object | null>;
}
/** Content-addressed create-only writes with a full, bounded readback. Bucket
 * retention/IAM remain deployment gates; this class cannot establish WORM policy. */
export class R2GitHubArtifactStore implements ImmutableGitHubArtifactStore {
  constructor(private readonly bucket: EvidenceR2Bucket) {}

  async writeAndVerify(key: string, content: Uint8Array, digest: string) {
    const shape =
      /^delivery\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/github\/[1-9][0-9]{0,19}\/[a-f0-9]{40}\/([a-f0-9]{64})\.json$/.exec(
        key,
      );
    if (
      !shape ||
      shape[1] !== digest ||
      content.byteLength === 0 ||
      content.byteLength > GITHUB_ARTIFACT_MAX_BYTES ||
      createHash("sha256").update(content).digest("hex") !== digest
    )
      throw new DeliveryConflict("github_artifact_invalid");
    const deadline = Date.now() + 10000;
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (Date.now() >= deadline) throw new DeliveryConflict("github_artifact_unavailable");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new DeliveryConflict("github_artifact_unavailable")),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    // A failed response may hide a successful write. Verify existing bytes in
    // either case; never overwrite or delete an object to repair a failure.
    try {
      await bounded(() =>
        this.bucket.put(key, new Uint8Array(content), {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          sha256: digest,
          httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" },
          customMetadata: { contentDigest: digest },
        }),
      );
    } catch {
      /* A verified readback can safely recover a lost write acknowledgement. */
    }
    let object: EvidenceR2Object | null;
    try {
      object = await bounded(() => this.bucket.get(key));
    } catch {
      throw new DeliveryConflict("github_artifact_unavailable");
    }
    if (!object) throw new DeliveryConflict("github_artifact_unavailable");
    if (object.key !== key || object.size !== content.byteLength || !object.body) {
      if (object.body) void object.body.cancel().catch(() => {});
      throw new DeliveryConflict("github_artifact_unverified");
    }
    const reader = object.body.getReader(),
      hash = createHash("sha256");
    let size = 0;
    try {
      while (true) {
        const next = await bounded(() => reader.read());
        if (next.done) break;
        size += next.value.byteLength;
        if (size > content.byteLength || size > GITHUB_ARTIFACT_MAX_BYTES)
          throw new DeliveryConflict("github_artifact_unverified");
        hash.update(next.value);
      }
      if (size !== content.byteLength || hash.digest("hex") !== digest)
        throw new DeliveryConflict("github_artifact_unverified");
      return { contentDigest: digest, size };
    } catch {
      throw new DeliveryConflict("github_artifact_unverified");
    } finally {
      void reader.cancel().catch(() => {});
    }
  }
}
