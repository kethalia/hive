import { describe, expect, it } from "vitest";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import type { ReleaseActionIdentity } from "@/lib/delivery/release-action-journal";
import { GitHubReleaseProvider } from "@/lib/delivery/release-github-provider.server";

const repo = { repositoryId: "123", owner: "fixture", name: "repo", allowedBaseRef: "preview" };
const request = {
  repositoryId: "123",
  pullRequestId: "124",
  pullNumber: 12,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  baseRef: "preview",
  rulesDigest: "c".repeat(64),
  method: "squash",
};
const identity: ReleaseActionIdentity = {
  id: "00000000-0000-4000-8000-000000000001",
  releaseId: "00000000-0000-4000-8000-000000000002",
  kind: "merge",
  targetDigest: "d".repeat(64),
  request,
  requestDigest: githubSourceDigest(request),
  generation: 1,
};
const requestId = "00000000-0000-4000-8000-000000000003",
  mergeSha = "e".repeat(40);
const pending = {
  status: "pending",
  details: { uuid: requestId, expected_head_sha: request.headSha, bypass_rules: false },
};
const response = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

describe("fixed GitHub merge provider", () => {
  it("records the 202 request identifier and accepts only attributed, verified completed merge", async () => {
    let posts = 0;
    const provider = new GitHubReleaseProvider(
      repo,
      "fixture",
      async () => true,
      async (_request, merged) => merged === mergeSha,
      async (url, init) => {
        expect(init?.redirect).toBe("error");
        if (init?.method === "PUT") {
          posts++;
          expect(String(url)).toBe(
            "https://api.github.com/repos/fixture/repo/pulls/12/merge-async",
          );
          expect(JSON.parse(String(init.body))).toEqual({
            sha: request.headSha,
            merge_method: "squash",
            merge_action: "default",
            bypass_rules: false,
          });
          return response(pending, 202);
        }
        expect(String(url).endsWith(`/12/merge-async/${requestId}`)).toBe(true);
        return response({ status: "merged", details: { sha: mergeSha } }, 200);
      },
    );
    const signal = new AbortController().signal;
    const accepted = await provider.dispatch(identity, signal);
    expect(accepted.reference.requestId).toBe(requestId);
    const result = await provider.lookup(identity, accepted.reference, signal);
    expect(result?.evidence.mergeSha).toBe(mergeSha);
    expect(posts).toBe(1);
  });
  it("holds lost identifiers, preexisting merges, pending or enqueued outcomes", async () => {
    let result: unknown = { status: "enqueued", details: {} },
      status = 200;
    const provider = new GitHubReleaseProvider(
      repo,
      "fixture",
      async () => true,
      async () => true,
      async () => response(result, status),
    );
    const signal = new AbortController().signal;
    await expect(provider.dispatch(identity, signal)).rejects.toThrow("release_github_uncertain");
    expect(await provider.lookup(identity, null, signal)).toBeNull();
    expect(await provider.lookup(identity, { provider: "github", requestId }, signal)).toBeNull();
    result = pending;
    status = 202;
    expect((await provider.dispatch(identity, signal)).pending).toBe(true);
  });
  it("does not mutate after failed preflight or adopt a mismatched repository", async () => {
    let calls = 0;
    const provider = new GitHubReleaseProvider(
      repo,
      "fixture",
      async () => false,
      async () => true,
      async () => {
        calls++;
        return response(pending, 202);
      },
    );
    await expect(provider.dispatch(identity, new AbortController().signal)).rejects.toThrow(
      "release_github_preflight_failed",
    );
    expect(calls).toBe(0);
  });
});
