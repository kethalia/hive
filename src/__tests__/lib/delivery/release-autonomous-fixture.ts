import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { createReleaseAuthorizer } from "@/lib/delivery/release-authority.server";
import { ReleaseAutoOpener } from "@/lib/delivery/release-auto-open.server";
import { GitHubBuildRunVerifier } from "@/lib/delivery/release-build-run.server";
import { ReleaseBuildStore } from "@/lib/delivery/release-build-store.server";
import { GitHubReleaseChangeRisk } from "@/lib/delivery/release-change-risk.server";
import {
  CloudflareReleaseProvider,
  releaseTargetResources,
} from "@/lib/delivery/release-cloudflare-provider.server";
import { PostgresReleaseEffectJournal } from "@/lib/delivery/release-effect-journal.server";
import { ReleaseEffectRunner } from "@/lib/delivery/release-effect-runner.server";
import { verifyReleaseEvidence } from "@/lib/delivery/release-evidence.server";
import {
  ReleaseAuthorityFacts,
  verifyReleaseAuthorityFact,
} from "@/lib/delivery/release-facts.server";
import { releaseGitHubMerged } from "@/lib/delivery/release-github-merged.server";
import { releaseGitHubPreflight } from "@/lib/delivery/release-github-preflight.server";
import { GitHubReleaseProvider } from "@/lib/delivery/release-github-provider.server";
import { GitHubReleaseRules } from "@/lib/delivery/release-github-rules.server";
import { ReleaseLifecycle } from "@/lib/delivery/release-lifecycle.server";
import { ReleaseObservationController } from "@/lib/delivery/release-observation-controller.server";
import { CloudflareReleaseObserver } from "@/lib/delivery/release-observer.server";
import { ReleasePlanner } from "@/lib/delivery/release-planner.server";
import { GitHubReleaseSourceDiscovery } from "@/lib/delivery/release-source-discovery.server";
import { GitHubReleaseTestRunVerifier } from "@/lib/delivery/release-tested-run.server";
import { ReleaseTestStore } from "@/lib/delivery/release-tested-store.server";
import type { acceptanceCandidateFixture } from "./acceptance-candidate-fixture";

type Fixture = Awaited<ReturnType<typeof acceptanceCandidateFixture>>;
/** Real persisted acceptance/source/policy, with all GitHub/Cloudflare/health
 * reads explicitly doubled. No remote mutations or semantic verifier doubles. */
export async function openReleaseFromSignedEvidence(
  db: PrismaClient,
  f: Fixture,
  defect?:
    | "old_base"
    | "unrelated_check"
    | "control_path"
    | "wrong_tree"
    | "test_failed"
    | "ordinary_test"
    | "pending_checks"
    | "runner_config"
    | "dependency_control",
) {
  const source = await db.deliverySourceRevision.findFirstOrThrow({
    where: { ownerId: f.user.id, operationId: f.publication.operationId },
  });
  const [owner, name] = f.project.fullName.split("/"),
    repo = Number(f.project.providerRepositoryId);
  const target = {
    accountId: randomUUID().replaceAll("-", ""),
    environment: "production",
    scripts: { app: "fixture-app", auth: "fixture-auth" },
    hiveReleaseWriter: true,
  };
  const runtime = { bindings: [], runtime: {} },
    configDigest = githubSourceDigest(runtime),
    baseline = (name: string) => ({
      deploymentId: randomUUID(),
      versionId: randomUUID(),
      sourceSha: "9".repeat(40),
      artifactDigest: (name === "app" ? "a" : "b").repeat(64),
      configDigest,
    });
  const baselines = { app: baseline("app"), auth: baseline("auth") },
    riskCatalog = { owner, name, allowedPrefixes: ["src/"] };
  const testWorkflow = {
    audiencePrefix: "urn:hive:release-tested:fixture:",
    repositoryId: f.project.providerRepositoryId,
    repositoryOwnerId: f.project.providerAccountId,
    workflowRef: `${owner}/${name}/.github/workflows/test.yml@refs/heads/main`,
    workflowSha: "1".repeat(40),
    controlDigest: "3".repeat(64),
  };
  const testRun = {
    repositoryId: f.project.providerRepositoryId,
    owner,
    name,
    workflowId: defect === "pending_checks" ? "61" : "62",
    testJobName: "fixed-tested-tree",
  };
  const authority = {
    targetDigest: githubSourceDigest(target),
    riskCatalogDigest: githubSourceDigest(riskCatalog),
    mergeMethod: "squash" as const,
    baselines,
    tested: { workflow: testWorkflow, run: testRun },
  };
  const observation = {
    target,
    origin: "https://preview.example.invalid",
    minimumRequests: 1,
    maxErrorRate: 0,
    settleDelayMs: 60000,
  };
  const approved = {
    audiencePrefix: "urn:hive:release-build:production:",
    repositoryId: f.project.providerRepositoryId,
    repositoryOwnerId: f.project.providerAccountId,
    workflowRef: `${owner}/${name}/.github/workflows/upload.yml@refs/heads/main`,
    workflowSha: "1".repeat(40),
    branchRef: "refs/heads/main",
    mode: "production" as const,
    productionEnabled: true,
  };
  const runConfig = { repositoryId: f.project.providerRepositoryId, owner, name, workflowId: "99" },
    publisherConfigDigest = "c".repeat(64);
  const policy = {
    schemaVersion: 1,
    versionId: randomUUID(),
    ownerId: f.user.id,
    repositoryId: f.project.providerRepositoryId,
    providerAccountId: f.project.providerAccountId,
    environmentKey: "production",
    targetDigest: authority.targetDigest,
    targetResources: releaseTargetResources(target),
    actions: ["merge", "promote", "recover"],
    riskClasses: ["application_only"],
    observationWindowMs: 1000,
    observationConfigDigest: githubSourceDigest(observation),
    buildAuthorityDigest: githubSourceDigest({
      workflow: approved,
      run: runConfig,
      publisherConfigDigest,
    }),
    authorityConfigDigest: githubSourceDigest(authority),
    validFrom: Date.now() - 1000,
    expiresAt: Date.now() + 60000,
  };
  const baseSha = "d".repeat(40),
    testMergeSha = "e".repeat(40),
    pull = {
      id: Number(source.pullRequestId),
      number: source.pullNumber,
      state: "open",
      draft: false,
      changed_files: 1,
      merge_commit_sha: testMergeSha,
      head: { sha: source.headSha, repo: { id: repo } },
      base: { sha: baseSha, ref: source.baseBranch, repo: { id: repo } },
    };
  const protection = {
    required_status_checks: {
      strict: true,
      checks: [{ context: defect === "unrelated_check" ? "unrelated" : "Test", app_id: 81 }],
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
  };
  const remoteRequestId = randomUUID(),
    mergedSha = "8".repeat(40);
  const testKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const candidate = {
    app: { versionId: randomUUID(), artifactDigest: "c".repeat(64) },
    auth: { versionId: randomUUID(), artifactDigest: "d".repeat(64) },
  };
  const active = {
    app: { id: baselines.app.deploymentId, version: baselines.app.versionId, marker: "" },
    auth: { id: baselines.auth.deploymentId, version: baselines.auth.versionId, marker: "" },
  };
  let cloudflareWrites = 0,
    loseAppAck = true,
    failingSmoke = false;
  let effectsAllowed = false,
    mergeObserved = false,
    writes = 0;
  let workflowFinished = defect !== "pending_checks";
  const fetcher: typeof fetch = async (raw, init) => {
    const url = String(raw);
    if (url === "https://token.actions.githubusercontent.com/.well-known/jwks")
      return Response.json({
        keys: [
          {
            ...testKeys.publicKey.export({ format: "jwk" }),
            kid: "tested",
            use: "sig",
            alg: "RS256",
          },
        ],
      });
    if (init?.method === "PUT" && url.endsWith("/merge-async") && effectsAllowed) {
      const body = JSON.parse(String(init.body));
      if (body.sha !== source.headSha || body.bypass_rules !== false) throw Error("merge_scope");
      writes++;
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
    if (init?.method === "POST" && url.endsWith("/deployments") && effectsAllowed) {
      const component = url.includes("fixture-app") ? "app" : "auth",
        body = JSON.parse(String(init.body));
      active[component] = {
        id: randomUUID(),
        version: body.versions[0].version_id,
        marker: body.annotations["workers/message"],
      };
      cloudflareWrites++;
      if (component === "app" && loseAppAck) {
        loseAppAck = false;
        throw Error("lost acknowledgement");
      }
      return Response.json({
        success: true,
        result: {
          id: active[component].id,
          strategy: "percentage",
          versions: [{ version_id: active[component].version, percentage: 100 }],
          annotations: { "workers/message": active[component].marker },
        },
      });
    }
    if (url.includes("/graphql") && init?.method === "POST")
      return Response.json({
        data: {
          viewer: {
            accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 10, errors: 0 } }] }],
          },
        },
      });
    if (init?.method && init.method !== "GET") throw Error("unexpected write");
    if (url.endsWith(`/merge-async/${remoteRequestId}`)) {
      mergeObserved = true;
      return Response.json({ status: "merged", details: { sha: mergedSha } });
    }
    if (url.endsWith(`repos/${owner}/${name}`)) return Response.json({ id: repo });
    if (url.endsWith("/actions/runs/60/attempts/1"))
      return Response.json({
        id: 60,
        run_attempt: 1,
        workflow_id: defect === "pending_checks" ? 61 : 62,
        event: "pull_request",
        head_sha: source.headSha,
        pull_requests: [
          { number: source.pullNumber, head: { sha: source.headSha }, base: { sha: baseSha } },
        ],
        status: workflowFinished ? "completed" : "in_progress",
        conclusion: workflowFinished ? (defect === "test_failed" ? "failure" : "success") : null,
        repository: { id: repo },
        head_repository: { id: repo },
      });
    if (url.endsWith("/actions/runs/60/attempts/1/jobs?per_page=100"))
      return Response.json({
        total_count: defect === "pending_checks" ? 2 : 1,
        jobs: [
          {
            id: 63,
            run_id: 60,
            run_attempt: 1,
            name: "fixed-tested-tree",
            status: "completed",
            conclusion: defect === "test_failed" ? "failure" : "success",
            check_run_url: `https://api.github.com/repos/${owner}/${name}/check-runs/43`,
          },
          ...(defect === "pending_checks"
            ? [
                {
                  id: 64,
                  run_id: 60,
                  run_attempt: 1,
                  name: "Test",
                  status: workflowFinished ? "completed" : "in_progress",
                  conclusion: workflowFinished ? "success" : null,
                  check_run_url: `https://api.github.com/repos/${owner}/${name}/check-runs/42`,
                },
              ]
            : []),
        ],
      });
    if (url.endsWith(`/commits/${testMergeSha}`))
      return Response.json({
        sha: testMergeSha,
        commit: { tree: { sha: "f".repeat(40) } },
        parents: [
          { sha: defect === "old_base" ? "1".repeat(40) : baseSha },
          { sha: source.headSha },
        ],
      });
    if (url.includes(`/actions/runs?`))
      return Response.json({
        total_count: workflowFinished ? 1 : 0,
        workflow_runs: workflowFinished
          ? [
              {
                id: defect === "pending_checks" ? 60 : 41,
                workflow_id: 61,
                head_sha: source.headSha,
                event: "pull_request",
                status: "completed",
                conclusion: "success",
                run_attempt: 1,
              },
            ]
          : [],
      });
    if (url.includes(`/actions/runs/41/attempts/1/jobs?`))
      return Response.json({
        total_count: 1,
        jobs: [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            run_id: 41,
            run_attempt: 1,
            check_run_url: `https://api.github.com/repos/${owner}/${name}/check-runs/42`,
          },
        ],
      });
    if (url.endsWith(`/check-runs/42`))
      return Response.json({
        id: 42,
        head_sha: source.headSha,
        name: "Test",
        status: "completed",
        conclusion: "success",
        app: { id: 81 },
      });
    if (url.includes("/protection")) return Response.json(protection);
    if (url.includes("/rules/branches/")) return Response.json([]);
    if (url.includes("/branches/")) return Response.json({ commit: { sha: baseSha } });
    if (url.includes("/files?"))
      return Response.json([
        {
          filename:
            defect === "control_path"
              ? "src/lib/delivery/release-evidence.server.ts"
              : defect === "runner_config"
                ? "src/vitest.config.ts"
                : defect === "dependency_control"
                  ? "src/package.json"
                  : defect === "ordinary_test"
                    ? "src/__tests__/fixture.test.ts"
                    : "src/fixture.ts",
          status: "modified",
        },
      ]);
    if (url.includes("/pulls/"))
      return Response.json(
        mergeObserved
          ? { ...pull, state: "closed", merged: true, merge_commit_sha: mergedSha }
          : pull,
      );
    if (url.includes("/versions/")) {
      return Response.json({
        success: true,
        result: {
          id: url.split("/").at(-1),
          resources: { script: { etag: "fixture" }, bindings: [], script_runtime: {} },
        },
      });
    }
    if (url.includes("/deployments?")) {
      const component = url.includes("fixture-app") ? "app" : "auth",
        b = active[component];
      return Response.json({
        success: true,
        result: {
          deployments: [
            {
              id: b.id,
              strategy: "percentage",
              versions: [{ version_id: b.version, percentage: 100 }],
              annotations: { "workers/message": b.marker },
            },
          ],
        },
      });
    }
    if (url.includes("/.well-known/")) {
      if (failingSmoke) return new Response(null, { status: 503 });
      const health = (component: "app" | "auth") => {
        const current = active[component],
          isCandidate = current.version === candidate[component].versionId;
        return {
          component,
          ready: true,
          sourceSha: isCandidate ? mergedSha : baselines[component].sourceSha,
          artifactDigest: isCandidate
            ? candidate[component].artifactDigest
            : baselines[component].artifactDigest,
        };
      };
      return Response.json({ schemaVersion: 1, app: health("app"), auth: health("auth") });
    }
    if (url.includes("/graphql"))
      return Response.json({
        data: {
          viewer: {
            accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 10, errors: 0 } }] }],
          },
        },
      });
    throw Error("unexpected URL");
  };
  const rules = new GitHubReleaseRules({ owner, name }, "fixture", fetcher),
    risk = new GitHubReleaseChangeRisk(riskCatalog, "fixture", fetcher),
    provider = new CloudflareReleaseProvider(target, "fixture", fetcher);
  const observer = new CloudflareReleaseObserver(
    observation,
    { analyticsToken: "fixture", probeSecret: "e".repeat(64), previewBearer: "f".repeat(64) },
    (component, signal) => provider.inspectCurrent(component, signal),
    fetcher,
  );
  const policies = () => [policy],
    authorityDigest = githubSourceDigest(authority);
  const authorize = createReleaseAuthorizer({
    repositoryPolicies: f.policies,
    policies,
    productionEnabled: true,
    verifyCurrent: async (tx, c) =>
      (await verifyReleaseEvidence(tx, f.policies, c)) &&
      verifyReleaseAuthorityFact(tx, {
        ownerId: c.ownerId,
        taskId: c.taskId,
        sourceSha: c.sourceSha,
        targetDigest: c.identity.targetDigest,
        configDigest: authorityDigest,
        factDigest: c.riskAttestationDigest,
        baselines: c.baselines,
        ...(c.identity.kind === "merge" ? { request: c.identity.request } : {}),
        fresh: false,
      }),
  });
  const lifecycle = new ReleaseLifecycle(db, {
    repositoryPolicies: f.policies,
    policies,
    productionEnabled: true,
    verifyOpening: async (tx, c) =>
      (await verifyReleaseEvidence(tx, f.policies, c)) &&
      verifyReleaseAuthorityFact(tx, {
        ...c,
        configDigest: authorityDigest,
        factDigest: c.riskAttestationDigest,
        fresh: true,
      }),
    verifyAction: authorize,
    verifyObservation: async () => false,
  });
  const testedStore = new ReleaseTestStore(
    db,
    testWorkflow,
    new GitHubReleaseTestRunVerifier(testRun, "fixture", fetcher),
    f.policies,
    policies,
    authority.targetDigest,
    authorityDigest,
    rules,
    risk,
    fetcher,
  );
  {
    const request = {
      schemaVersion: 1,
      purpose: "release_test_challenge",
      repositoryId: testWorkflow.repositoryId,
      repositoryOwnerId: testWorkflow.repositoryOwnerId,
      pullNumber: source.pullNumber,
      headSha: source.headSha,
      baseSha,
      mergeSha: testMergeSha,
      treeSha: (defect === "wrong_tree" ? "0" : "f").repeat(40),
      runId: "60",
      runAttempt: 1,
      controlDigest: testWorkflow.controlDigest,
    };
    const token = (payload: unknown) => {
      const now = Math.floor(Date.now() / 1000),
        encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const claims = {
        iss: "https://token.actions.githubusercontent.com",
        aud: testWorkflow.audiencePrefix + githubSourceDigest(payload),
        repository_id: testWorkflow.repositoryId,
        repository_owner_id: testWorkflow.repositoryOwnerId,
        sha: testMergeSha,
        ref: `refs/pull/${source.pullNumber}/merge`,
        event_name: "pull_request",
        run_id: "60",
        run_attempt: "1",
        job_workflow_ref: testWorkflow.workflowRef,
        job_workflow_sha: testWorkflow.workflowSha,
        jti: randomUUID(),
        iat: now - 1,
        nbf: now - 1,
        exp: now + 300,
      };
      const message = `${encode({ alg: "RS256", kid: "tested" })}.${encode(claims)}`;
      return `${message}.${sign("RSA-SHA256", Buffer.from(message), testKeys.privateKey).toString("base64url")}`;
    };
    let challenge: Awaited<ReturnType<typeof testedStore.challenge>>;
    try {
      challenge = await testedStore.challenge(request, token(request), AbortSignal.timeout(10000));
    } catch (error) {
      if (defect && !["ordinary_test", "pending_checks"].includes(defect))
        throw Error("release_open_fixture_failed");
      throw error;
    }
    if (defect && !["ordinary_test", "pending_checks"].includes(defect))
      throw Error("release_defect_accepted");
    const { purpose: _, ...base } = request;
    const attestation = { ...base, purpose: "release_test_attestation", ...challenge };
    for (const invalid of [
      { ...attestation, nonce: "0".repeat(64) },
      { ...attestation, policyDigest: "0".repeat(64) },
      { ...attestation, checksDigest: "0".repeat(64) },
    ]) {
      let rejected = false;
      try {
        await testedStore.submit(invalid, token(invalid), AbortSignal.timeout(10000));
      } catch {
        rejected = true;
      }
      if (!rejected) throw Error("release_test_invalid_accepted");
    }
    await testedStore.submit(attestation, token(attestation), AbortSignal.timeout(10000));
    if (defect === "pending_checks") {
      const provisional = {
        repositoryId: source.repositoryId,
        pullRequestId: source.pullRequestId,
        pullNumber: source.pullNumber,
        headSha: source.headSha,
        baseSha,
        baseRef: source.baseBranch,
        rulesDigest: "0".repeat(64),
        method: "squash",
      };
      let held = false;
      try {
        await testedStore.verifyFresh(f.user.id, f.taskId, provisional, AbortSignal.timeout(10000));
      } catch {
        held = true;
      }
      if (!held) throw Error("release_test_pending_accepted");
      workflowFinished = true;
      await testedStore.verifyFresh(f.user.id, f.taskId, provisional, AbortSignal.timeout(10000));
    }
    let replayRejected = false;
    try {
      await testedStore.submit(attestation, token(attestation), AbortSignal.timeout(10000));
    } catch {
      replayRejected = true;
    }
    if (!replayRejected) throw Error("release_test_replay_accepted");
  }
  const facts = new ReleaseAuthorityFacts(
    db,
    authority,
    f.policies,
    policies,
    rules,
    risk,
    provider,
    observer,
    testedStore,
  );
  const discovery = new GitHubReleaseSourceDiscovery(
    {
      owner,
      name,
      repositoryId: f.project.providerRepositoryId,
      baseRef: "main",
      method: "squash",
    },
    "fixture",
    rules,
    fetcher,
  );
  const opener = new ReleaseAutoOpener(
    db,
    authority.targetDigest,
    authorityDigest,
    f.policies,
    policies,
    discovery,
    facts,
    lifecycle,
  );
  for (let i = 0; i < (defect ? 10 : 100); i++)
    if ((await opener.tick(AbortSignal.timeout(10000))) === "opened") break;
  const releases = await db.$queryRaw<
    { id: string }[]
  >`SELECT id FROM delivery_releases WHERE owner_id=${f.user.id}::uuid AND task_id=${f.taskId}::uuid AND target_digest=${authority.targetDigest}`;
  if (releases.length !== 1) throw Error("release_open_fixture_failed");
  const planner = new ReleasePlanner(db, authority.targetDigest, lifecycle);
  if ((await planner.advance(f.user.id, releases[0].id)) !== "prepared")
    throw Error("release_plan_fixture_failed");
  const simulateMerge = async (actionId: string) => {
    effectsAllowed = true;
    const github = new GitHubReleaseProvider(
      {
        owner,
        name,
        repositoryId: f.project.providerRepositoryId,
        allowedBaseRef: "main",
        mode: "production",
        productionEnabled: true,
      },
      "fixture",
      async (request, signal) =>
        (await releaseGitHubPreflight(rules, risk)(request, signal)) &&
        Boolean(await testedStore.verifyFresh(f.user.id, f.taskId, request, signal)),
      releaseGitHubMerged({ owner, name }, "fixture", fetcher),
      fetcher,
    );
    const journal = () => new PostgresReleaseEffectJournal(db, f.user.id, authorize);
    const signal = AbortSignal.timeout(10000);
    const first = await new ReleaseEffectRunner(journal(), github).dispatch(actionId, signal);
    const afterRestart = await new ReleaseEffectRunner(journal(), github).reconcile(
      actionId,
      signal,
    );
    return { first, afterRestart, writes };
  };
  const simulateRollout = async () => {
    const releaseId = releases[0].id,
      signal = AbortSignal.timeout(10000),
      keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const manifest = {
      schemaVersion: 1,
      releaseId,
      ownerId: f.user.id,
      repositoryId: f.project.providerRepositoryId,
      repositoryOwnerId: f.project.providerAccountId,
      mergeSha: mergedSha,
      targetDigest: authority.targetDigest,
      runId: "88",
      runAttempt: 1,
      app: {
        script: target.scripts.app,
        ...candidate.app,
        configDigest,
        providerScriptHash: "fixture",
      },
      auth: {
        script: target.scripts.auth,
        ...candidate.auth,
        configDigest,
        providerScriptHash: "fixture",
      },
    };
    const now = Math.floor(Date.now() / 1000),
      claims = {
        iss: "https://token.actions.githubusercontent.com",
        aud: `${approved.audiencePrefix}${githubSourceDigest(manifest)}`,
        repository_id: manifest.repositoryId,
        repository_owner_id: manifest.repositoryOwnerId,
        sha: mergedSha,
        ref: approved.branchRef,
        event_name: "push",
        run_id: "88",
        run_attempt: "1",
        job_workflow_ref: approved.workflowRef,
        job_workflow_sha: approved.workflowSha,
        jti: randomUUID(),
        iat: now - 1,
        nbf: now - 1,
        exp: now + 300,
      };
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"),
      content = `${encode({ alg: "RS256", kid: "fixture" })}.${encode(claims)}`,
      token = `${content}.${sign("RSA-SHA256", Buffer.from(content), keys.privateKey).toString("base64url")}`;
    const run = new GitHubBuildRunVerifier(runConfig, "fixture", async () =>
      Response.json({
        id: 88,
        run_attempt: 1,
        workflow_id: 99,
        status: "completed",
        conclusion: "success",
        event: "push",
        head_sha: mergedSha,
        repository: { id: repo },
        head_repository: { id: repo },
      }),
    );
    const builds = new ReleaseBuildStore(
      db,
      approved,
      provider,
      authorize,
      run,
      async () =>
        Response.json({
          keys: [
            {
              ...keys.publicKey.export({ format: "jwk" }),
              kid: "fixture",
              use: "sig",
              alg: "RS256",
            },
          ],
        }),
      authority.targetDigest,
      publisherConfigDigest,
    );
    await builds.submit(manifest, token, signal);
    await builds.verifyRun(f.user.id, releaseId, signal);
    const pending = async (kind: string) =>
      (
        await db.$queryRaw<
          { id: string }[]
        >`SELECT id FROM delivery_release_actions WHERE release_id=${releaseId}::uuid AND kind=${kind} AND phase='prepared'`
      )[0].id;
    const runner = () =>
      new ReleaseEffectRunner(new PostgresReleaseEffectJournal(db, f.user.id, authorize), provider);
    await planner.advance(f.user.id, releaseId);
    const app = await pending("promote");
    const first = await runner().dispatch(app, signal),
      recoveredAck = await runner().reconcile(app, signal);
    const observing = new ReleaseObservationController(
      db,
      observer,
      authorize,
      (verifyObservation) =>
        new ReleaseLifecycle(db, {
          repositoryPolicies: f.policies,
          policies,
          productionEnabled: true,
          verifyOpening: async () => false,
          verifyAction: authorize,
          verifyObservation,
        }),
    );
    const stage = (await observing.observe(f.user.id, releaseId, signal)).phase;
    await planner.advance(f.user.id, releaseId);
    const auth = await pending("promote");
    await runner().dispatch(auth, signal);
    failingSmoke = true;
    const regression = (await observing.observe(f.user.id, releaseId, signal)).phase;
    failingSmoke = false;
    await planner.advance(f.user.id, releaseId);
    const restoreApp = await pending("recover");
    await runner().dispatch(restoreApp, signal);
    await planner.advance(f.user.id, releaseId);
    const restoreAuth = await pending("recover");
    await runner().dispatch(restoreAuth, signal);
    // Only this dedicated local test ages timestamps; provider calls remain doubles.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`UPDATE delivery_release_actions SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id IN (${restoreApp}::uuid,${restoreAuth}::uuid)`;
    });
    const final = (await observing.observe(f.user.id, releaseId, signal)).phase;
    return { first, recoveredAck, stage, regression, final, cloudflareWrites };
  };
  return { releaseId: releases[0].id, authorize, simulateMerge, simulateRollout };
}
