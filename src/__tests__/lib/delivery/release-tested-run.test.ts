import { expect, it } from "vitest";
import { GitHubReleaseTestRunVerifier } from "@/lib/delivery/release-tested-run.server";

const head = "a".repeat(40),
  base = "b".repeat(40),
  merge = "c".repeat(40);
const scope = {
  schemaVersion: 1,
  purpose: "release_test_challenge",
  repositoryId: "1",
  repositoryOwnerId: "2",
  pullNumber: 402,
  headSha: head,
  baseSha: base,
  mergeSha: merge,
  treeSha: "d".repeat(40),
  runId: "3",
  runAttempt: 1,
  controlDigest: "e".repeat(64),
};
function fixture(association: unknown[]) {
  const fetcher: typeof fetch = async (url) =>
    String(url).includes("/jobs?")
      ? Response.json({
          total_count: 1,
          jobs: [
            {
              id: 6,
              run_id: 3,
              run_attempt: 1,
              name: "fixed-tested-tree",
              status: "completed",
              conclusion: "success",
            },
          ],
        })
      : Response.json({
          id: 3,
          run_attempt: 1,
          workflow_id: 4,
          event: "pull_request",
          head_sha: head,
          status: "completed",
          conclusion: "success",
          repository: { id: 1 },
          head_repository: { id: 1 },
          pull_requests: association,
        });
  return new GitHubReleaseTestRunVerifier(
    {
      repositoryId: "1",
      owner: "test",
      name: "repo",
      workflowId: "4",
      testJobName: "fixed-tested-tree",
    },
    "fixture",
    fetcher,
  );
}
it("uses GitHub's PR-head run SHA and requires a unique current base/head association", async () => {
  const association = { number: 402, head: { sha: head }, base: { sha: base } };
  await expect(
    fixture([association]).verify(scope, true, AbortSignal.timeout(1000)),
  ).resolves.toMatchObject({ runId: "3", jobId: "6" });
  for (const invalid of [
    [],
    [association, association],
    [{ ...association, base: { sha: "f".repeat(40) } }],
    [{ ...association, number: 403 }],
  ])
    await expect(fixture(invalid).verify(scope, true, AbortSignal.timeout(1000))).rejects.toThrow();
});
