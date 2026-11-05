import { expect, it } from "vitest";
import { epicDependencyRelease } from "@/lib/delivery/epic-dependency.server";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";

const source = "a".repeat(40),
  squash = "b".repeat(40),
  base = "c".repeat(40),
  rules = "d".repeat(64);
const request = {
  repositoryId: "123",
  pullRequestId: "456",
  pullNumber: 1,
  headSha: source,
  baseSha: base,
  baseRef: "integration",
  rulesDigest: rules,
  method: "squash",
};
const receipt = {
  provider: "github",
  repositoryId: "123",
  pullRequestId: "456",
  pullNumber: 1,
  headSha: source,
  baseSha: base,
  mergeSha: squash,
  requestId: "00000000-0000-4000-8000-000000000001",
  rulesDigest: rules,
};
it("uses the attributed squash merge commit rather than the PR head and rejects changed evidence", async () => {
  let rows = [
    {
      release_id: "00000000-0000-4000-8000-000000000002",
      source_sha: source,
      repository_id: "123",
      request,
      request_digest: githubSourceDigest(request),
      receipt,
      receipt_digest: githubSourceDigest(receipt),
    },
  ];
  const tx = { $queryRaw: async () => rows } as never;
  expect((await epicDependencyRelease(tx, "owner", "task")).mergeSha).toBe(squash);
  rows = [{ ...rows[0], receipt: { ...receipt, headSha: "e".repeat(40) } }];
  await expect(epicDependencyRelease(tx, "owner", "task")).rejects.toThrow(
    "epic_dependency_release_invalid",
  );
});
