import { describe, expect, it } from "vitest";
import { GitHubBuildRunVerifier } from "@/lib/delivery/release-build-run.server";

const manifest = {
  schemaVersion: 1,
  releaseId: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000002",
  repositoryId: "123",
  repositoryOwnerId: "456",
  mergeSha: "a".repeat(40),
  targetDigest: "b".repeat(64),
  runId: "789",
  runAttempt: 2,
  app: {
    script: "preview-app",
    versionId: "00000000-0000-4000-8000-000000000003",
    artifactDigest: "c".repeat(64),
    configDigest: "d".repeat(64),
    providerScriptHash: "app",
  },
  auth: {
    script: "preview-auth",
    versionId: "00000000-0000-4000-8000-000000000004",
    artifactDigest: "e".repeat(64),
    configDigest: "f".repeat(64),
    providerScriptHash: "auth",
  },
};
const config = { repositoryId: "123", owner: "fixture", name: "repo", workflowId: "999" };
const run = {
  id: 789,
  run_attempt: 2,
  workflow_id: 999,
  status: "completed",
  conclusion: "success",
  event: "push",
  head_sha: manifest.mergeSha,
  repository: { id: 123 },
  head_repository: { id: 123 },
};
describe("trusted release build run", () => {
  it("requires a completed successful exact workflow attempt after manifest creation", async () => {
    const verifier = new GitHubBuildRunVerifier(config, "fixture", async (url, init) => {
      expect(String(url)).toBe(
        "https://api.github.com/repos/fixture/repo/actions/runs/789/attempts/2",
      );
      expect(init?.redirect).toBe("error");
      return Response.json(run);
    });
    expect((await verifier.verify(manifest, new AbortController().signal)).evidence).toMatchObject({
      status: "completed",
      conclusion: "success",
      mergeSha: manifest.mergeSha,
    });
  });
  it("rejects pending, failure, changed source or a different workflow or repository", async () => {
    for (const changed of [
      { status: "in_progress", conclusion: null },
      { conclusion: "failure" },
      { head_sha: "1".repeat(40) },
      { workflow_id: 1000 },
      { head_repository: { id: 777 } },
      { run_attempt: 3 },
    ]) {
      const verifier = new GitHubBuildRunVerifier(config, "fixture", async () =>
        Response.json({ ...run, ...changed }),
      );
      await expect(verifier.verify(manifest, new AbortController().signal)).rejects.toThrow();
    }
  });
});
