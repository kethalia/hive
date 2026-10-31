import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  type EvidenceR2Bucket,
  R2GitHubArtifactStore,
} from "@/lib/delivery/github-artifacts.server";

function fixture() {
  const bytes = new TextEncoder().encode('{"fixture":"bytes"}'),
    digest = createHash("sha256").update(bytes).digest("hex"),
    key = `delivery/${randomUUID()}/github/123/${"a".repeat(40)}/${digest}.json`;
  const values = new Map<string, Uint8Array>();
  const bucket: EvidenceR2Bucket = {
    put: vi.fn(async (path, value, options) => {
      expect(options.onlyIf.get("If-None-Match")).toBe("*");
      expect(options.sha256).toBe(digest);
      if (values.has(path)) return null;
      values.set(path, value);
      return { key: path };
    }),
    get: vi.fn(async (path) => {
      const value = values.get(path);
      return value
        ? {
            key: path,
            size: value.length,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(value.slice(0, 3));
                controller.enqueue(value.slice(3));
                controller.close();
              },
            }),
          }
        : null;
    }),
  };
  return { bytes, digest, key, bucket, values, store: new R2GitHubArtifactStore(bucket) };
}
describe("create-only R2 GitHub artifacts", () => {
  it("verifies full streamed bytes and concurrent exact replay without replacing an object", async () => {
    const f = fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.store.writeAndVerify(f.key, f.bytes, f.digest)),
    );
    for (const result of results)
      expect(result).toEqual({ contentDigest: f.digest, size: f.bytes.length });
    expect(f.values.size).toBe(1);
  });
  it("rejects a malformed key/digest, caller corruption and excess bytes before a storage operation", async () => {
    const f = fixture();
    for (const [key, bytes, digest] of [
      ["arbitrary/key", f.bytes, f.digest],
      [f.key, f.bytes, "a".repeat(64)],
      [f.key, new Uint8Array(2 * 1024 * 1024 + 1), f.digest],
      [f.key, new Uint8Array(), f.digest],
    ] as const)
      await expect(f.store.writeAndVerify(key, bytes, digest)).rejects.toThrow(
        "github_artifact_invalid",
      );
    expect(f.bucket.put).not.toHaveBeenCalled();
    expect(f.bucket.get).not.toHaveBeenCalled();
  });
  it("an existing same-size corrupted object is retained and never authorizes evidence", async () => {
    const f = fixture();
    f.values.set(f.key, new Uint8Array(f.bytes.length).fill(120));
    await expect(f.store.writeAndVerify(f.key, f.bytes, f.digest)).rejects.toThrow(
      "github_artifact_unverified",
    );
    expect(f.values.get(f.key)).toEqual(new Uint8Array(f.bytes.length).fill(120));
  });
  it("a lost write acknowledgement recovers only by verifying durable bytes", async () => {
    const f = fixture();
    vi.mocked(f.bucket.put).mockImplementationOnce(async (key, bytes) => {
      f.values.set(key, bytes);
      throw new Error("private write acknowledgement lost");
    });
    expect(await f.store.writeAndVerify(f.key, f.bytes, f.digest)).toEqual({
      contentDigest: f.digest,
      size: f.bytes.length,
    });
    f.values.clear();
    vi.mocked(f.bucket.put).mockRejectedValue(new Error("secret bucket token"));
    await expect(f.store.writeAndVerify(f.key, f.bytes, f.digest)).rejects.toThrow(
      "github_artifact_unavailable",
    );
  });
  it("metadata is insufficient: short, overflowing, failed and absent readbacks fail closed", async () => {
    for (const mode of ["short", "overflow", "failure", "missing"] as const) {
      const f = fixture();
      vi.mocked(f.bucket.get).mockImplementation(async () =>
        mode === "missing"
          ? null
          : {
              key: f.key,
              size: f.bytes.length,
              body: new ReadableStream({
                start(controller) {
                  if (mode === "failure") controller.error(new Error("private storage response"));
                  else {
                    controller.enqueue(
                      mode === "overflow" ? new Uint8Array(f.bytes.length + 1) : f.bytes.slice(1),
                    );
                    controller.close();
                  }
                },
              }),
            },
      );
      await expect(f.store.writeAndVerify(f.key, f.bytes, f.digest)).rejects.toThrow(
        mode === "missing" ? "github_artifact_unavailable" : "github_artifact_unverified",
      );
    }
  });
  it("bounds a stalled read without waiting for an uncooperative stream cancellation", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      vi.mocked(f.bucket.get).mockResolvedValue({
        key: f.key,
        size: f.bytes.length,
        body: new ReadableStream({ cancel: () => new Promise(() => {}) }),
      });
      const result = expect(f.store.writeAndVerify(f.key, f.bytes, f.digest)).rejects.toThrow(
        "github_artifact_unverified",
      );
      await vi.advanceTimersByTimeAsync(10001);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });
});
