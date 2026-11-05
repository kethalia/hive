import { expect, it } from "vitest";
import { releaseGitHubMerged } from "@/lib/delivery/release-github-merged.server";

const request = {
  repositoryId: "1",
  pullRequestId: "2",
  pullNumber: 3,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  baseRef: "preview",
  rulesDigest: "c".repeat(64),
  method: "squash",
};
it("verifies the exact merged PR readback, not merely a desired branch state", async () => {
  const pull = {
    id: 2,
    number: 3,
    state: "closed",
    merged: true,
    merge_commit_sha: "d".repeat(40),
    head: { sha: request.headSha, repo: { id: 1 } },
    base: { ref: "preview", repo: { id: 1 } },
  };
  const check = releaseGitHubMerged({ owner: "test", name: "repo" }, "fixture", async () =>
    Response.json(pull),
  );
  expect(await check(request, pull.merge_commit_sha, new AbortController().signal)).toBe(true);
  expect(await check(request, "e".repeat(40), new AbortController().signal)).toBe(false);
});
