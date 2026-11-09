import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { automaticReleaseConfigSchema } from "@/lib/delivery/release-automatic-contracts";
import type { verifiedEpicPreviewFixture } from "./epic-readiness-fixture";

/** Only GitHub HTTP and its OIDC signing key are local doubles. The connected
 * helper, rules, tested-tree/run and journal verifiers remain real code. */
export async function automaticReleaseProviderFixture(
  db: PrismaClient,
  fixture: Awaited<ReturnType<typeof verifiedEpicPreviewFixture>>,
) {
  const source = await db.deliverySourceRevision.findUniqueOrThrow({
    where: {
      id: (await db.deliveryTask.findUniqueOrThrow({ where: { id: fixture.taskId } }))
        .sourceRevisionId!,
    },
  });
  const [owner, name] = source.fullName.split("/"),
    repo = Number(source.repositoryId);
  const config = automaticReleaseConfigSchema.parse({
    mode: "automatic-main-builds",
    target: {
      accountId: randomUUID().replaceAll("-", ""),
      worker: "hive",
      origin: "https://hive.example.invalid",
    },
    observation: { windowMs: 1000 },
    policy: {
      schemaVersion: 1,
      purpose: "automatic_production",
      pipelineUsage: "existing-connected-builds",
      cutoverApproval: {
        id: randomUUID(),
        approvedBy: "explicit local owner approval double",
        approvedAt: Date.now() - 2000,
      },
      versionId: randomUUID(),
      ownerId: fixture.user.id,
      repositoryId: source.repositoryId,
      providerAccountId: source.providerAccountId,
      baseBranch: source.baseBranch,
      method: "squash",
      validFrom: Date.now() - 1000,
      expiresAt: Date.now() + 600000,
    },
    risk: { owner, name, allowedPrefixes: ["src/"] },
    tested: {
      workflow: {
        audiencePrefix: "urn:hive:release-tested:epicfixture:",
        repositoryId: source.repositoryId,
        repositoryOwnerId: source.providerAccountId,
        workflowRef: `${source.fullName}/.github/workflows/test.yml@refs/heads/main`,
        workflowSha: "1".repeat(40),
        controlDigest: "3".repeat(64),
      },
      run: {
        repositoryId: source.repositoryId,
        owner,
        name,
        workflowId: "62",
        testJobName: "fixed-tested-tree",
      },
    },
  });
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const remote = {
    baseSha: "d".repeat(40),
    mergeSha: "8".repeat(40),
    testMergeSha: "f".repeat(40),
    treeSha: "7".repeat(40),
    defaultBranch: "main",
    writes: 0,
    lookups: 0,
    merged: false,
    lose202: false,
    failedCheck: false,
    failedRules: false,
    filename: "src/fixture.ts",
    previousFilename: undefined as string | undefined,
    reads: [] as string[],
  };
  const remoteRequestId = randomUUID();
  const fetcher: typeof fetch = async (raw, init) => {
    const url = new URL(String(raw));
    if (url.origin === "https://token.actions.githubusercontent.com")
      return Response.json({
        keys: [
          { ...keys.publicKey.export({ format: "jwk" }), kid: "tested", use: "sig", alg: "RS256" },
        ],
      });
    if (url.origin !== "https://api.github.com") throw Error("No external provider in fixture");
    if (init?.redirect !== "manual") throw Error("Redirects must be rejected explicitly");
    const path = url.pathname + url.search;
    if (init?.method === "PUT") {
      if (path !== `/repos/${source.fullName}/pulls/${source.pullNumber}/merge-async`)
        throw Error("Unexpected write");
      const body = JSON.parse(String(init.body));
      if (
        body.sha !== source.headSha ||
        body.bypass_rules !== false ||
        body.merge_action !== "default"
      )
        throw Error("Wrong write scope");
      remote.writes++;
      return Response.json(
        {
          status: "pending",
          details: {
            uuid: remoteRequestId,
            expected_head_sha: source.headSha,
            bypass_rules: false,
          },
        },
        { status: 202 },
      );
    }
    if (init?.method && init.method !== "GET") throw Error("Unexpected provider method");
    remote.reads.push(path);
    if (path === "/user") return Response.json({ id: Number(source.providerAccountId) });
    const metadata = {
      id: repo,
      full_name: source.fullName,
      pushed_at: `volatile-fixture-read-${remote.reads.length}`,
      default_branch: remote.defaultBranch,
      archived: false,
      permissions: { pull: true, push: true },
    };
    if (path === `/repositories/${source.repositoryId}` || path === `/repos/${source.fullName}`)
      return Response.json(metadata);
    if (path.endsWith(`/merge-async/${remoteRequestId}`)) {
      remote.lookups++;
      remote.merged = true;
      return Response.json({ status: "merged", details: { sha: remote.mergeSha } });
    }
    if (path.includes("/protection"))
      return Response.json({
        required_status_checks: {
          strict: !remote.failedRules,
          checks: [{ context: "Test", app_id: 81 }],
        },
        enforce_admins: { enabled: true },
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
        },
      });
    if (path.includes("/rules/branches/")) return Response.json([]);
    if (path.includes("/branches/")) return Response.json({ commit: { sha: remote.baseSha } });
    if (path.endsWith(`/commits/${remote.testMergeSha}`))
      return Response.json({
        sha: remote.testMergeSha,
        commit: { tree: { sha: remote.treeSha } },
        parents: [{ sha: remote.baseSha }, { sha: source.headSha }],
      });
    if (path.includes("/actions/runs?"))
      return Response.json({
        total_count: 1,
        workflow_runs: [
          {
            id: 41,
            workflow_id: 61,
            head_sha: source.headSha,
            event: "pull_request",
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
          },
        ],
      });
    if (path.includes("/actions/runs/41/attempts/1/jobs?"))
      return Response.json({
        total_count: 1,
        jobs: [
          {
            name: "Test",
            status: "completed",
            conclusion: remote.failedCheck ? "failure" : "success",
            run_id: 41,
            run_attempt: 1,
            check_run_url: `https://api.github.com/repos/${source.fullName}/check-runs/42`,
          },
        ],
      });
    if (path.endsWith("/check-runs/42"))
      return Response.json({
        id: 42,
        head_sha: source.headSha,
        name: "Test",
        status: "completed",
        conclusion: "success",
        app: { id: 81 },
      });
    if (path.endsWith("/actions/runs/60/attempts/1"))
      return Response.json({
        id: 60,
        run_attempt: 1,
        workflow_id: 62,
        event: "pull_request",
        head_sha: source.headSha,
        pull_requests: [
          {
            number: source.pullNumber,
            head: { sha: source.headSha },
            base: { sha: remote.baseSha },
          },
        ],
        status: "completed",
        conclusion: "success",
        repository: { id: repo },
        head_repository: { id: repo },
      });
    if (path.endsWith("/actions/runs/60/attempts/1/jobs?per_page=100"))
      return Response.json({
        total_count: 1,
        jobs: [
          {
            id: 63,
            run_id: 60,
            run_attempt: 1,
            name: "fixed-tested-tree",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    if (path.includes("/files?"))
      return Response.json([
        {
          filename: remote.filename,
          status: remote.previousFilename ? "renamed" : "modified",
          ...(remote.previousFilename ? { previous_filename: remote.previousFilename } : {}),
        },
      ]);
    if (path === `/repos/${source.fullName}/pulls/${source.pullNumber}`)
      return Response.json({
        id: Number(source.pullRequestId),
        number: source.pullNumber,
        state: remote.merged ? "closed" : "open",
        merged: remote.merged,
        draft: false,
        changed_files: 1,
        merge_commit_sha: remote.merged ? remote.mergeSha : remote.testMergeSha,
        head: { sha: source.headSha, ref: source.branch, repo: { id: repo } },
        base: { sha: remote.baseSha, ref: source.baseBranch, repo: { id: repo } },
      });
    throw Error(`Unimplemented local fixture path ${path}`);
  };
  const testRequest = {
    schemaVersion: 1,
    purpose: "release_test_challenge",
    repositoryId: source.repositoryId,
    repositoryOwnerId: source.providerAccountId,
    pullNumber: source.pullNumber,
    headSha: source.headSha,
    baseSha: remote.baseSha,
    mergeSha: remote.testMergeSha,
    treeSha: remote.treeSha,
    runId: "60",
    runAttempt: 1,
    controlDigest: config.tested.workflow.controlDigest,
  };
  const token = (payload: unknown) => {
    const now = Math.floor(Date.now() / 1000),
      encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = {
      iss: "https://token.actions.githubusercontent.com",
      aud: config.tested.workflow.audiencePrefix + githubSourceDigest(payload),
      repository_id: source.repositoryId,
      repository_owner_id: source.providerAccountId,
      sha: remote.testMergeSha,
      ref: `refs/pull/${source.pullNumber}/merge`,
      event_name: "pull_request",
      run_id: "60",
      run_attempt: "1",
      job_workflow_ref: config.tested.workflow.workflowRef,
      job_workflow_sha: config.tested.workflow.workflowSha,
      jti: randomUUID(),
      iat: now - 1,
      nbf: now - 1,
      exp: now + 300,
    };
    const text = `${encode({ alg: "RS256", kid: "tested" })}.${encode(claims)}`;
    return `${text}.${sign("RSA-SHA256", Buffer.from(text), keys.privateKey).toString("base64url")}`;
  };
  return { config, source, remote, fetcher, testRequest, token };
}
