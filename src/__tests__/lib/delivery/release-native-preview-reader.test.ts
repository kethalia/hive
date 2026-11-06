import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareReleaseProvider } from "@/lib/delivery/release-cloudflare-provider.server";
import {
  NATIVE_PREVIEW_IDENTITY_BODY_BYTES,
  NATIVE_PREVIEW_IDENTITY_DEADLINE_MS,
  NativePreviewReleaseReader,
} from "@/lib/delivery/release-native-preview-reader.server";

const target = {
  provider: "cloudflare-native-preview",
  accountId: "225177f82b9234ede14e897fe15e0cb5",
  workerName: "hive",
  previewId: "9b772c5c22f84deeb1af85e68f819798",
  previewName: "codex/delivery-system-design",
  previewSlug: "codex-delivery-system-design",
  origin: "https://codex-delivery-system-design-hive.b00ste.workers.dev",
};
const deploymentId = "22222222-2222-4222-8222-222222222222",
  source = "a".repeat(40);
const action = "33333333-3333-4333-8333-333333333333";
const privateValue = "private-provider-credential-value";
function fixture(change: (value: any, count: number, deployment: boolean) => void = () => {}) {
  let count = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    count++;
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token");
    const deployment = String(url).endsWith("/deployments/latest");
    expect(String(url)).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/workers/workers/hive/previews/${deployment ? `${target.previewId}/deployments/latest` : "codex%2Fdelivery-system-design"}`,
    );
    const result: any = deployment
      ? {
          id: deploymentId,
          annotations: {
            "workers/commit_sha": source,
            "workers/message": `hive-release:${action}`,
            "workers/private": privateValue,
          },
          env: { SECRET: { type: "secret_text", text: privateValue } },
        }
      : {
          id: target.previewId,
          name: target.previewName,
          slug: target.previewSlug,
          private: privateValue,
        };
    change(result, count, deployment);
    return Response.json({ success: true, result });
  });
  const reader = new NativePreviewReleaseReader(target, "fixture-token", fetcher);
  return { reader, fetcher, read: () => reader.readCurrent(new AbortController().signal) };
}
afterEach(() => vi.useRealTimers());
describe("native Preview branch release identity foundation", () => {
  it("uses only branch APIs, pins Preview identity and returns bounded public identity annotations", async () => {
    const f = fixture(),
      current = await f.read();
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    expect(current).toMatchObject({
      scope: "native-preview-current-identity",
      previewId: target.previewId,
      deploymentId,
      annotatedSourceSha: source,
      annotatedActionId: action,
    });
    expect(JSON.stringify(current)).not.toContain(privateValue);
    expect(current).not.toHaveProperty("versionId");
    expect(current).not.toHaveProperty("configDigest");
    expect(current).not.toHaveProperty("artifactDigest");
  });
  it("never exports arbitrary message annotations or infers provenance from desired state", async () => {
    const f = fixture((value, _, deployment) => {
      if (deployment) value.annotations = { "workers/message": privateValue };
    });
    const value = await f.read();
    expect(value.annotatedActionId).toBeNull();
    expect(value.annotatedSourceSha).toBeNull();
    expect(JSON.stringify(value)).not.toContain(privateValue);
  });
  it.each([
    "accountId",
    "workerName",
    "previewName",
    "previewSlug",
    "origin",
  ])("rejects substituted target %s before network", (field) => {
    const fetcher = vi.fn();
    expect(
      () => new NativePreviewReleaseReader({ ...target, [field]: "other" }, "fixture", fetcher),
    ).toThrow("release_native_preview_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    "recreated",
    "branch",
    "slug",
    "deployment",
    "commit",
    "action",
  ])("holds observed %s drift", async (kind) => {
    const f = fixture((value, count, deployment) => {
      if (!deployment && kind === "recreated") value.id = "recreated-preview";
      if (!deployment && kind === "branch") value.name = "main";
      if (!deployment && kind === "slug") value.slug = "other";
      if (deployment && count === 4 && kind === "deployment") value.id = "new-deployment";
      if (deployment && count === 4 && kind === "commit")
        value.annotations["workers/commit_sha"] = "b".repeat(40);
      if (deployment && count === 4 && kind === "action")
        value.annotations["workers/message"] = "unattributed";
    });
    await expect(f.read()).rejects.toThrow("release_native_preview_identity_hold");
  });
  it("preserves the integrated native Preview mutation guard", () => {
    expect(
      () =>
        new CloudflareReleaseProvider(
          {
            topology: "single",
            accountId: target.accountId,
            environment: "preview",
            scripts: { app: "hive", auth: "hive" },
            hiveReleaseWriter: true,
          },
          "fixture",
        ),
    ).toThrow("release_native_preview_unsupported");
  });
  it("bounds malformed, oversized, redirected and private provider error responses", async () => {
    for (const fetcher of [
      async () => new Response(null, { status: 302 }),
      async () => Response.json({ success: false, errors: [{ message: privateValue }] }),
      async () => new Response("x".repeat(NATIVE_PREVIEW_IDENTITY_BODY_BYTES + 1)),
      async () => {
        throw new Error(privateValue);
      },
    ])
      await expect(
        new NativePreviewReleaseReader(target, "fixture", fetcher).readCurrent(
          new AbortController().signal,
        ),
      ).rejects.toThrow("release_native_preview_identity_hold");
  });
  it("holds a stalled body and cancels it at the finite deadline", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            pull() {},
            cancel() {
              cancelled = true;
            },
          }),
        ),
    );
    const work = new NativePreviewReleaseReader(target, "fixture", fetcher).readCurrent(
      new AbortController().signal,
    );
    const rejected = expect(work).rejects.toThrow("release_native_preview_identity_hold");
    await vi.advanceTimersByTimeAsync(NATIVE_PREVIEW_IDENTITY_DEADLINE_MS);
    await rejected;
    expect(cancelled).toBe(true);
  });
  it("bounds ignored fetch cancellation and closes a late response body", async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void,
      cancelled = false;
    const work = new NativePreviewReleaseReader(
      target,
      "fixture",
      () =>
        new Promise((r) => {
          finish = r;
        }),
    ).readCurrent(new AbortController().signal);
    const rejected = expect(work).rejects.toThrow("release_native_preview_identity_hold");
    await vi.advanceTimersByTimeAsync(NATIVE_PREVIEW_IDENTITY_DEADLINE_MS);
    await rejected;
    finish(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toBe(true);
  });
});

describe("existing release observer/controller native read-only integration seam", () => {
  it("is default-off and exposes only discriminated identity facts with unverified eligibility", async () => {
    const { createReleaseIdentityObservationController } = await import(
      "@/lib/delivery/release-controller.server"
    );
    const f = fixture();
    expect(createReleaseIdentityObservationController({}, f.fetcher)).toBeNull();
    expect(f.fetcher).not.toHaveBeenCalled();
    const controller = createReleaseIdentityObservationController(
      {
        nativePreviewIdentityEnabled: "true",
        nativePreviewIdentityTargetJson: JSON.stringify(target),
        cloudflareToken: "fixture-token",
      },
      f.fetcher,
    )!;
    expect(Object.keys(controller).sort()).toEqual(["kind", "observeIdentity"]);
    const fact = await controller.observeIdentity(new AbortController().signal);
    expect(fact).toMatchObject({
      kind: "native-preview-identity",
      state: "observed",
      eligibility: "unverified",
      identity: { previewId: target.previewId, deploymentId },
    });
    expect(fact).not.toHaveProperty("healthy");
    expect(fact).not.toHaveProperty("receiptDigest");
    expect(fact).not.toHaveProperty("artifactDigest");
  });
  it("returns a sanitized hold on unknown scope and fails closed on malformed enrollment", async () => {
    const { createReleaseIdentityObservationController } = await import(
      "@/lib/delivery/release-controller.server"
    );
    const f = fixture((value, _, deployment) => {
      if (!deployment) value.id = "recreated";
    });
    const env = {
      nativePreviewIdentityEnabled: "true",
      nativePreviewIdentityTargetJson: JSON.stringify(target),
      cloudflareToken: "fixture-token",
    };
    const controller = createReleaseIdentityObservationController(env, f.fetcher)!;
    expect(await controller.observeIdentity(new AbortController().signal)).toEqual({
      kind: "native-preview-identity",
      state: "hold",
      eligibility: "unverified",
    });
    expect(() =>
      createReleaseIdentityObservationController(
        { ...env, nativePreviewIdentityTargetJson: "invalid" },
        f.fetcher,
      ),
    ).toThrow("release_native_preview_unavailable");
  });
});

it("accepts the primary-observed native deployment shape without inferring a source revision", async () => {
  // Safe field projection of the primary's actual provider read. The actual
  // annotations lack workers/commit_sha; independent build HEAD is not readback.
  const actualDeployment = {
    id: "9edad607-b052-4f79-b5ac-7576d06557a7",
    number: 1,
    startup_time_ms: 1,
    placement: {},
    limits: { cpu_ms: 100 },
    compatibility_date: "2026-10-29",
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    main_module: "worker.js",
    annotations: {
      "workers/message": "ordinary build message",
      "workers/repository_url": "https://github.com/kethalia/hive",
      "workers/tag": "ordinary build tag",
      "workers/triggered_by": "upload",
    },
    usage_model: "standard",
    urls: [],
    source: "api",
    created_on: "2026-11-06T10:10:44.504283Z",
    env: { SECRET: { type: "secret_text", text: privateValue } },
    assets: { jwt: privateValue },
    author_id: "private-author",
    author_email: "private@example.invalid",
  };
  const f = fixture((value, _, deployment) => {
    if (deployment) {
      for (const key of Object.keys(value)) delete value[key];
      Object.assign(value, actualDeployment);
    }
  });
  const result = await f.read();
  expect(result.deploymentId).toBe(actualDeployment.id);
  expect(result.annotatedSourceSha).toBeNull();
  expect(result.annotatedActionId).toBeNull();
  expect(JSON.stringify(result)).not.toContain(privateValue);
  expect(result).not.toHaveProperty("sourceSha");
  expect(result).not.toHaveProperty("versionId");
});
