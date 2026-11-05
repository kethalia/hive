import { describe, expect, it } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import type { ReleaseActionIdentity } from "@/lib/delivery/release-action-journal";
import { CloudflareReleaseProvider } from "@/lib/delivery/release-cloudflare-provider.server";

const target = {
  accountId: "a".repeat(32),
  environment: "preview",
  scripts: { app: "hive-app-preview", auth: "hive-auth-preview" },
  hiveReleaseWriter: true,
};
const before = "00000000-0000-4000-8000-000000000001",
  after = "00000000-0000-4000-8000-000000000002",
  version = "00000000-0000-4000-8000-000000000003";
const request = {
  component: "app",
  expectedDeploymentId: before,
  expectedVersionId: version,
  versionId: version,
  mergedSha: "a".repeat(40),
  artifactDigest: "b".repeat(64),
  configDigest: "c".repeat(64),
  baselineSourceSha: "d".repeat(40),
  baselineArtifactDigest: "e".repeat(64),
  baselineConfigDigest: "f".repeat(64),
};
const identity: ReleaseActionIdentity = {
  id: "00000000-0000-4000-8000-000000000004",
  releaseId: "00000000-0000-4000-8000-000000000005",
  kind: "promote",
  targetDigest: githubSourceDigest(target),
  request,
  requestDigest: githubSourceDigest(request),
  generation: 1,
};
const deployment = (id: string, v: string, marker?: string) => ({
  id,
  strategy: "percentage",
  versions: [{ version_id: v, percentage: 100 }],
  annotations: { "workers/message": marker },
});
const json = (result: unknown) =>
  new Response(JSON.stringify({ success: true, result }), { status: 200 });

describe("fixed Cloudflare release provider", () => {
  it("checks baseline, posts the pinned version and verifies current deployment", async () => {
    let posts = 0,
      reads = 0;
    const fetcher: typeof fetch = async (url, init) => {
      expect(String(url)).toContain(
        `/accounts/${target.accountId}/workers/scripts/hive-app-preview/deployments`,
      );
      expect(init?.redirect).toBe("error");
      if (init?.method === "POST") {
        posts++;
        expect(JSON.parse(String(init.body))).toEqual({
          strategy: "percentage",
          versions: [{ version_id: version, percentage: 100 }],
          annotations: { "workers/message": `hive-release:${identity.id}` },
        });
        return json(deployment(after, version, `hive-release:${identity.id}`));
      }
      reads++;
      return json({
        deployments: [
          reads === 1
            ? deployment(before, version)
            : deployment(after, version, `hive-release:${identity.id}`),
        ],
      });
    };
    const result = await new CloudflareReleaseProvider(target, "fixture", fetcher).dispatch(
      identity,
      new AbortController().signal,
    );
    expect(result.evidence.deploymentId).toBe(after);
    expect([reads, posts]).toEqual([2, 1]);
  });
  it("rejects changed baseline and holds when current state is unattributed", async () => {
    let posts = 0;
    const provider = new CloudflareReleaseProvider(target, "fixture", async (_url, init) => {
      if (init?.method === "POST") posts++;
      return json({ deployments: [deployment(after, version)] });
    });
    const signal = new AbortController().signal;
    await expect(provider.dispatch(identity, signal)).rejects.toThrow("release_baseline_changed");
    expect(await provider.lookup(identity, null, signal)).toBeNull();
    expect(posts).toBe(0);
  });
  it("recovers an acknowledged-or-lost action only when the exact marked version remains current", async () => {
    const provider = new CloudflareReleaseProvider(target, "fixture", async () =>
      json({ deployments: [deployment(after, version, `hive-release:${identity.id}`)] }),
    );
    const result = await provider.lookup(identity, null, new AbortController().signal);
    expect(result?.evidence.actionId).toBe(identity.id);
    await expect(
      provider.lookup(
        { ...identity, targetDigest: "d".repeat(64) },
        null,
        new AbortController().signal,
      ),
    ).rejects.toThrow("release_provider_scope");
  });
});
