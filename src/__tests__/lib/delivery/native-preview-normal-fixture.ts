import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@hive/db";
import { vi } from "vitest";
import { acceptanceDigest, requireIntentDigest } from "@/lib/delivery/acceptance-contracts";
import { GitHubReleaseRules } from "@/lib/delivery/release-github-rules.server";
import { nativeDigest } from "@/lib/delivery/release-native-preview-contracts";
import { GitHubReleaseSourceDiscovery } from "@/lib/delivery/release-source-discovery.server";
import {
  collectCompletionProviderFacts,
  completionServices,
} from "./acceptance-completion-fixture";
import type { nativeInstalledFixture } from "./native-preview-installed-fixture";

/** Complete the genuine independent review/source/repository gate before using
 * the installed native facts/opener. Provider transports alone are doubled. */
export async function prepareNativeNormalRelease(
  db: PrismaClient,
  f: Awaited<ReturnType<typeof nativeInstalledFixture>>,
) {
  const a = f.source;
  for (const name of [
    "HIVE_DELIVERY_ACCEPTANCE_ENABLED",
    "HIVE_DELIVERY_EXECUTION_ENABLED",
    "HIVE_DELIVERY_MANAGER_ENABLED",
    "HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED",
  ])
    vi.stubEnv(name, "true");
  vi.stubEnv("HIVE_DELIVERY_ACCEPTANCE_PRODUCER", JSON.stringify(a.store.producer));
  vi.stubEnv("HIVE_DELIVERY_REPOSITORY_POLICIES_JSON", JSON.stringify(a.repositoryCatalog));
  const reviewer = completionServices(db, a).service;
  await reviewer.dispatch(a.envelope({ action: "prepare_review", candidate: a.candidate }));
  await a.claimAndFinish(reviewer, (job) => ({
    schemaVersion: 1,
    kind: "review",
    intentDigest: a.plan.intentDigest,
    planDigest: acceptanceDigest(a.plan),
    sourceSha: a.publication.headSha,
    inputDigest: job.inputDigest,
    outcome: "pass",
    requirements: [
      {
        id: "acceptance:behavior",
        meaningDigest: requireIntentDigest(a.plan.requirements[0].meaning),
        outcome: "pass",
        rationale: "Exact source independently reviewed",
        citations: [
          {
            entryId: "source:0",
            artifactDigest: a.candidate.manifest.files[0].contentDigest,
            start: 0,
            end: 10,
          },
        ],
      },
    ],
    unresolved: [],
    rationale: "Synthetic independent evaluator",
  }));
  await collectCompletionProviderFacts(db, a, a.publication.operationId, { review: true });
  const task = await db.deliveryTask.findUniqueOrThrow({ where: { id: a.taskId } });
  await reviewer.dispatch(
    a.envelope({
      action: "complete_verified",
      terminal: {
        schemaVersion: 1,
        managerBindingId: a.claim.managerBindingId,
        taskId: a.taskId,
        stepId: a.stepId,
        attemptId: a.claim.attemptId,
        managerThreadId: a.managerThreadId,
        parentTurnId: a.parentTurnId,
        cursorVersion: 1,
        nativeSequence: 2,
        sourceContext: {
          revisionId: task.sourceRevisionId,
          version: task.sourceVersion,
          headSha: task.sourceSha,
        },
        observedAt: new Date().toISOString(),
        historyDigest: "1".repeat(64),
        loadedInventoryDigest: "2".repeat(64),
        sourceJournalDigest: "3".repeat(64),
        rootCompleted: true,
        pendingHandlers: 0,
        pendingObservers: 0,
        unknownInputs: 0,
        cohort: [
          {
            parentTurnId: a.source.parentTurnId,
            spawnCallId: a.source.spawnCallId,
            childThreadId: a.source.childThreadId,
            childTurnId: a.source.childTurnId,
            effectiveModel: "gpt-6.1-sol",
            effectiveEffort: "low",
          },
        ],
      },
    }),
  );
  const baseline = await f.native.publications.resolveBaseline();
  const controllerConfig = {
    ...f.controllerConfig,
    authority: { ...f.controllerConfig.authority, baselines: baseline },
  };
  const configDigest = nativeDigest(controllerConfig.authority),
    targetDigest = nativeDigest(controllerConfig.target);
  const resource = nativeDigest({
    provider: "cloudflare-native-preview",
    accountId: f.config.target.accountId,
    workerName: "hive",
    previewId: f.config.target.previewId,
  });
  const policy = {
    schemaVersion: 1,
    versionId: randomUUID(),
    ownerId: a.user.id,
    repositoryId: a.project.providerRepositoryId,
    providerAccountId: a.project.providerAccountId,
    environmentKey: "preview",
    targetDigest,
    targetResources: [resource],
    actions: ["merge", "promote", "recover"],
    riskClasses: ["application_only"],
    observationWindowMs: 1000,
    observationConfigDigest: nativeDigest({
      target: f.config.target,
      observation: controllerConfig.observation,
      healthScope: "sampled-health-no-atomic-exclusion",
    }),
    buildAuthorityDigest: nativeDigest({
      builder: f.config.builderPolicy,
      publisher: f.config.publisherPolicy,
    }),
    authorityConfigDigest: configDigest,
    validFrom: Date.now() - 1000,
    expiresAt: Date.now() + 120000,
  };
  Object.assign(f.env, { HIVE_DELIVERY_RELEASE_POLICIES_JSON: JSON.stringify([policy]) });
  const baseSha = "d".repeat(40),
    testMergeSha = "e".repeat(40),
    mergedSha = "8".repeat(40),
    repo = Number(a.project.providerRepositoryId),
    remoteId = randomUUID();
  let merged = false;
  const pull = {
    id: Number(f.revision.pullRequestId),
    number: f.revision.pullNumber,
    state: "open",
    draft: false,
    changed_files: 1,
    merge_commit_sha: testMergeSha,
    head: { sha: f.revision.headSha, repo: { id: repo } },
    base: { sha: baseSha, ref: f.revision.baseBranch, repo: { id: repo } },
  };
  f.state.github = async (url, init) => {
    const path = url.pathname;
    if (init?.method === "PUT" && path.endsWith("/merge-async"))
      return Response.json(
        {
          status: "pending",
          details: { uuid: remoteId, expected_head_sha: f.revision.headSha, bypass_rules: false },
        },
        { status: 202 },
      );
    if (path.endsWith(`/merge-async/${remoteId}`)) {
      merged = true;
      return Response.json({ status: "merged", details: { sha: mergedSha } });
    }
    if (path === "/repos/kethalia/hive") return Response.json({ id: repo });
    if (path.endsWith("/actions/runs/60/attempts/1"))
      return Response.json({
        id: 60,
        run_attempt: 1,
        workflow_id: 62,
        event: "pull_request",
        head_sha: f.revision.headSha,
        pull_requests: [
          {
            number: f.revision.pullNumber,
            head: { sha: f.revision.headSha },
            base: { sha: baseSha },
          },
        ],
        status: "completed",
        conclusion: "success",
        repository: { id: repo },
        head_repository: { id: repo },
      });
    if (path.endsWith("/actions/runs/60/attempts/1/jobs"))
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
            check_run_url: "https://api.github.com/repos/kethalia/hive/check-runs/43",
          },
        ],
      });
    if (path.endsWith(`/commits/${testMergeSha}`))
      return Response.json({
        sha: testMergeSha,
        commit: { tree: { sha: "f".repeat(40) } },
        parents: [{ sha: baseSha }, { sha: f.revision.headSha }],
      });
    if (path.endsWith("/actions/runs"))
      return Response.json({
        total_count: 1,
        workflow_runs: [
          {
            id: 41,
            workflow_id: 61,
            head_sha: f.revision.headSha,
            event: "pull_request",
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
          },
        ],
      });
    if (path.endsWith("/actions/runs/41/attempts/1/jobs"))
      return Response.json({
        total_count: 1,
        jobs: [
          {
            name: "Test",
            status: "completed",
            conclusion: "success",
            run_id: 41,
            run_attempt: 1,
            check_run_url: "https://api.github.com/repos/kethalia/hive/check-runs/42",
          },
        ],
      });
    if (path.endsWith("/check-runs/42"))
      return Response.json({
        id: 42,
        head_sha: f.revision.headSha,
        name: "Test",
        status: "completed",
        conclusion: "success",
        app: { id: 81 },
      });
    if (path.endsWith("/protection"))
      return Response.json({
        required_status_checks: { strict: true, checks: [{ context: "Test", app_id: 81 }] },
        enforce_admins: { enabled: true },
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
        },
      });
    if (path.includes("/rules/branches/")) return Response.json([]);
    if (path.includes("/branches/")) return Response.json({ commit: { sha: baseSha } });
    if (path.endsWith("/files"))
      return Response.json([{ filename: "src/fixture.ts", status: "modified" }]);
    if (path.includes("/pulls/"))
      return Response.json(
        merged ? { ...pull, state: "closed", merged: true, merge_commit_sha: mergedSha } : pull,
      );
    return null;
  };
  const native = f.install(controllerConfig);
  const challengeInput = {
    schemaVersion: 1,
    purpose: "release_test_challenge",
    repositoryId: a.project.providerRepositoryId,
    repositoryOwnerId: a.project.providerAccountId,
    pullNumber: f.revision.pullNumber,
    headSha: f.revision.headSha,
    baseSha,
    mergeSha: testMergeSha,
    treeSha: "f".repeat(40),
    runId: "60",
    runAttempt: 1,
    controlDigest: controllerConfig.authority.tested.workflow.controlDigest,
  };
  const challenge = await native.tested.challenge(
    challengeInput,
    f.testedToken(challengeInput, testMergeSha),
    AbortSignal.timeout(10000),
  );
  const { purpose: _, ...base } = challengeInput,
    attestation = { ...base, purpose: "release_test_attestation", ...challenge };
  await native.tested.submit(
    attestation,
    f.testedToken(attestation, testMergeSha),
    AbortSignal.timeout(10000),
  );
  const rules = new GitHubReleaseRules(
    { owner: "kethalia", name: "hive" },
    "fixture-github-read",
    f.fetcher,
  );
  const discovery = new GitHubReleaseSourceDiscovery(
    {
      owner: "kethalia",
      name: "hive",
      repositoryId: a.project.providerRepositoryId,
      baseRef: f.revision.baseBranch,
      method: "squash",
    },
    "fixture-github-read",
    rules,
    f.fetcher,
  );
  const request = await discovery.read(
    {
      repositoryId: a.project.providerRepositoryId,
      pullRequestId: f.revision.pullRequestId,
      pullNumber: f.revision.pullNumber,
      headSha: f.revision.headSha,
      baseRef: f.revision.baseBranch,
    },
    AbortSignal.timeout(10000),
  );
  const captured = await native.facts!.capture(
    { ownerId: a.user.id, taskId: a.taskId, policyVersionId: policy.versionId, request },
    AbortSignal.timeout(10000),
  );
  const opened = await native.lifecycle.open({
    id: randomUUID(),
    ownerId: a.user.id,
    taskId: a.taskId,
    policyVersionId: policy.versionId,
    riskAttestationDigest: captured.riskAttestationDigest,
    baselines: captured.baselines,
    riskClass: captured.riskClass,
  });
  if ((await native.planner.advance(a.user.id, opened.releaseId)) !== "prepared")
    throw Error("native planner did not derive merge from persisted authority facts");
  const mergeAction = (
    await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM delivery_release_actions WHERE release_id=${opened.releaseId}::uuid AND kind='merge'`
  )[0].id;
  await native.step(a.user.id, mergeAction, AbortSignal.timeout(10000));
  await native.step(a.user.id, mergeAction, AbortSignal.timeout(10000));
  return { native, opened, mergedSha, baseline, controllerConfig, policy };
}
