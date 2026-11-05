import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { PrismaClient } from "@hive/db";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalGitHubSource, githubSourceDigest } from "@/lib/delivery/github-evidence.server";
import { DeliveryOutbox } from "@/lib/delivery/outbox";
import { createReleaseAuthorizer } from "@/lib/delivery/release-authority.server";
import { ReleaseAutoOpener } from "@/lib/delivery/release-auto-open.server";
import { GitHubBuildRunVerifier } from "@/lib/delivery/release-build-run.server";
import { ReleaseBuildStore } from "@/lib/delivery/release-build-store.server";
import {
  CloudflareReleaseProvider,
  releaseTargetResources,
} from "@/lib/delivery/release-cloudflare-provider.server";
import {
  ReleaseDatabaseObserver,
  verifyReleaseDatabaseDeployment,
} from "@/lib/delivery/release-database-observer.server";
import { PostgresReleaseEffectJournal } from "@/lib/delivery/release-effect-journal.server";
import { ReleaseEffectRunner } from "@/lib/delivery/release-effect-runner.server";
import {
  ReleaseAuthorityFacts,
  verifyReleaseAuthorityFact,
} from "@/lib/delivery/release-facts.server";
import { GitHubReleaseProvider } from "@/lib/delivery/release-github-provider.server";
import { ReleaseLifecycle } from "@/lib/delivery/release-lifecycle.server";
import { ReleaseObservationController } from "@/lib/delivery/release-observation-controller.server";
import { CloudflareReleaseObserver } from "@/lib/delivery/release-observer.server";
import { ReleasePlanner } from "@/lib/delivery/release-planner.server";
import type { RepositoryPolicyStore } from "@/lib/delivery/repository-policy-store.server";

const url = process.env.HIVE_RELEASE_JOURNAL_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/hive_release_test")
)
  throw new Error("Private local release fixture only");
const db = new PrismaClient({
  datasourceUrl: url ?? "postgresql://unused@127.0.0.1:1/hive_release_test",
});
const buildKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
afterAll(() => db.$disconnect());

async function fixture() {
  const owner = randomUUID(),
    task = randomUUID(),
    source = randomUUID(),
    release = randomUUID(),
    action = randomUUID();
  const target = Buffer.from(randomUUID()).toString("hex").padEnd(64, "0").slice(0, 64);
  const request = githubSourceDigest({});
  const project = randomUUID();
  await db.$executeRaw`INSERT INTO users(id,coder_url,coder_user_id,username,email) VALUES (${owner}::uuid,'https://example.invalid',${randomUUID()}::uuid,'fixture','fixture@example.invalid')`;
  await db.$executeRaw`INSERT INTO delivery_projects(id,owner_id,provider,provider_repository_id,provider_account_id,full_name) VALUES (${project}::uuid,${owner}::uuid,'github','1','2','fixture/repo')`;
  await db.$executeRaw`INSERT INTO delivery_tasks(id,owner_id,project_id,outcome,source_sha,branch) VALUES (${task}::uuid,${owner}::uuid,${project}::uuid,'synthetic release',${"2".repeat(40)},'branch')`;
  // Only this isolated DB has a synthetic source seed with FK triggers disabled;
  // all release journal inserts, transitions, foreign keys and fences stay live.
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await tx.$executeRaw`INSERT INTO delivery_source_revisions (id,owner_id,task_id,manager_binding_id,step_id,producing_attempt_id,version,input_sha,head_sha,tree_sha,manifest_digest,operation_id,request_digest,producer,proof_digest,repository_id,provider_account_id,full_name,branch,base_branch,pull_request_id,pull_number)
      VALUES (${source}::uuid,${owner}::uuid,${task}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,1,${"1".repeat(40)},${"2".repeat(40)},${"3".repeat(40)},${"4".repeat(64)},${randomUUID()}::uuid,${"5".repeat(64)},'protected-source-broker-v1',${"6".repeat(64)},'1','2','fixture/repo','branch','main','3',1)`;
  });
  await db.$executeRaw`INSERT INTO delivery_release_targets(target_digest) VALUES (${target})`;
  await db.$executeRaw`INSERT INTO delivery_releases(id,owner_id,task_id,source_revision_id,target_digest,policy_digest,snapshot,snapshot_digest) VALUES (${release}::uuid,${owner}::uuid,${task}::uuid,${source}::uuid,${target},${"b".repeat(64)},'{}'::jsonb,${"c".repeat(64)})`;
  await db.$executeRaw`UPDATE delivery_release_targets SET active_release_id=${release}::uuid,generation=1 WHERE target_digest=${target}`;
  await db.$executeRaw`INSERT INTO delivery_release_actions(id,release_id,kind,target_digest,request,request_digest,generation) VALUES (${action}::uuid,${release}::uuid,'merge',${target},'{}'::jsonb,${request},1)`;
  return { owner, task, source, target, request, action, release };
}

describe.skipIf(!url)("release journal isolated PostgreSQL", () => {
  it("persists provider observations only for a stable release lease and rejects drift", async () => {
    const f = await fixture();
    const baseline = {
      deploymentId: randomUUID(),
      versionId: randomUUID(),
      sourceSha: "a".repeat(40),
      artifactDigest: "b".repeat(64),
      configDigest: "c".repeat(64),
    };
    const snapshot = {
      baselines: { app: baseline, auth: baseline },
      database: {
        catalogDigest: "d".repeat(64),
        planEventId: randomUUID(),
        planDigest: "e".repeat(64),
      },
    };
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`UPDATE delivery_releases SET snapshot=${canonicalGitHubSource(snapshot)}::jsonb,snapshot_digest=${githubSourceDigest(snapshot)} WHERE id=${f.release}::uuid`;
    });
    let drift = false,
      race = false;
    const provider = {
      inspectCurrent: async () => {
        if (race) {
          race = false;
          await db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
            await tx.$executeRaw`UPDATE delivery_release_targets SET generation=generation+1 WHERE target_digest=${f.target}`;
          });
        }
        return {
          deploymentId: baseline.deploymentId,
          versionId: drift ? randomUUID() : baseline.versionId,
        };
      },
      inspectVersion: async () => ({ configDigest: baseline.configDigest }),
    };
    const observer = new ReleaseDatabaseObserver(db, provider as never);
    await observer.observe(f.owner, f.release, new AbortController().signal);
    expect(
      await db.$transaction((tx) => verifyReleaseDatabaseDeployment(tx, f.owner, f.release)),
    ).toBe(true);
    const actionId = f.action;
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`UPDATE delivery_release_actions SET kind='promote',phase='effect_started' WHERE id=${actionId}::uuid`;
    });
    await expect(
      db.$transaction((tx) => verifyReleaseDatabaseDeployment(tx, f.owner, f.release)),
    ).rejects.toThrow();
    expect(
      await db.$transaction((tx) =>
        verifyReleaseDatabaseDeployment(tx, f.owner, f.release, actionId),
      ),
    ).toBe(true);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`UPDATE delivery_release_actions SET kind='merge',phase='prepared' WHERE id=${actionId}::uuid`;
    });
    drift = true;
    await expect(
      observer.observe(f.owner, f.release, new AbortController().signal),
    ).rejects.toThrow();
    drift = false;
    race = true;
    await expect(
      observer.observe(f.owner, f.release, new AbortController().signal),
    ).rejects.toThrow();
    expect(
      await db.$transaction((tx) => verifyReleaseDatabaseDeployment(tx, f.owner, f.release)),
    ).toBe(false);
  });
  it("persists task pagination across fresh scheduler instances", async () => {
    for (let i = 0; i < 9; i++) {
      const f = await fixture();
      // Synthetic source chains are linked only in this isolated fixture DB.
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        await tx.$executeRaw`UPDATE delivery_tasks SET source_revision_id=${f.source}::uuid,source_version=1 WHERE id=${f.task}::uuid`;
      });
    }
    const target = randomUUID().replaceAll("-", "").repeat(2),
      config = "1".repeat(64),
      policy = {
        schemaVersion: 1,
        versionId: randomUUID(),
        ownerId: randomUUID(),
        repositoryId: "1",
        providerAccountId: "2",
        environmentKey: "preview",
        targetDigest: target,
        targetResources: ["2".repeat(64), "3".repeat(64)],
        actions: ["merge"],
        riskClasses: ["application_only"],
        observationWindowMs: 1000,
        observationConfigDigest: "4".repeat(64),
        buildAuthorityDigest: "5".repeat(64),
        authorityConfigDigest: config,
        validFrom: Date.now() - 1000,
        expiresAt: Date.now() + 60000,
      };
    const create = () =>
      new ReleaseAutoOpener(
        db,
        target,
        config,
        {} as never,
        () => [policy],
        {} as never,
        {} as never,
        {} as never,
      );
    expect(await create().tick(new AbortController().signal)).toBe("idle");
    const first = (
      await db.$queryRaw<
        { opener_cursor: string }[]
      >`SELECT opener_cursor FROM delivery_release_scheduler_cursors WHERE target_digest=${target}`
    )[0].opener_cursor;
    expect(first).not.toBe("00000000-0000-0000-0000-000000000000");
    expect(await create().tick(new AbortController().signal)).toBe("idle");
    const second = (
      await db.$queryRaw<
        { opener_cursor: string }[]
      >`SELECT opener_cursor FROM delivery_release_scheduler_cursors WHERE target_digest=${target}`
    )[0].opener_cursor;
    expect(second).not.toBe(first);
  });
  it("binds immutable authority facts to exact source, target, config and expiry", async () => {
    const f = await fixture(),
      configDigest = "6".repeat(64);
    const item = {
      deploymentId: randomUUID(),
      versionId: randomUUID(),
      sourceSha: "a".repeat(40),
      artifactDigest: "b".repeat(64),
      configDigest: "c".repeat(64),
    };
    const baselines = {
      app: item,
      auth: { ...item, deploymentId: randomUUID(), versionId: randomUUID() },
    };
    const request = {
      repositoryId: "1",
      pullRequestId: "3",
      pullNumber: 1,
      headSha: "2".repeat(40),
      baseSha: "3".repeat(40),
      baseRef: "main",
      rulesDigest: "4".repeat(64),
      method: "squash",
    };
    const payload = {
      schemaVersion: 1,
      observedAt: Date.now(),
      request,
      baselines,
      risk: { riskClass: "application_only", fixture: true },
      rules: { fixture: true },
      testedMergeSha: "7".repeat(40),
      healthDigest: "5".repeat(64),
    };
    const factDigest = githubSourceDigest(payload),
      encoded = canonicalGitHubSource(payload);
    await db.$executeRaw`INSERT INTO delivery_release_authority_facts(id,owner_id,task_id,source_sha,target_digest,config_digest,payload,payload_digest,observed_at,expires_at) VALUES (${randomUUID()}::uuid,${f.owner}::uuid,${f.task}::uuid,${request.headSha},${f.target},${configDigest},${encoded}::jsonb,${factDigest},${new Date(payload.observedAt)},${new Date(payload.observedAt + 20000)})`;
    const input = {
      ownerId: f.owner,
      taskId: f.task,
      sourceSha: request.headSha,
      targetDigest: f.target,
      configDigest,
      factDigest,
      baselines,
      request,
      fresh: true,
    };
    expect(await db.$transaction((tx) => verifyReleaseAuthorityFact(tx, input))).toBe(true);
    expect(
      await db.$transaction((tx) =>
        verifyReleaseAuthorityFact(tx, { ...input, riskClass: "database" }),
      ),
    ).toBe(false);
    expect(
      await db.$transaction((tx) =>
        verifyReleaseAuthorityFact(tx, { ...input, configDigest: "0".repeat(64) }),
      ),
    ).toBe(false);
    expect(
      await db.$transaction((tx) =>
        verifyReleaseAuthorityFact(tx, {
          ...input,
          request: { ...request, baseSha: "9".repeat(40) },
        }),
      ),
    ).toBe(false);
    await expect(
      db.$executeRaw`UPDATE delivery_release_authority_facts SET payload='{}'::jsonb WHERE payload_digest=${factDigest}`,
    ).rejects.toThrow();
  });
  it("persists a lost acknowledgement and reconciles once after restart", async () => {
    const f = await fixture();
    let sends = 0;
    const journal = () => new PostgresReleaseEffectJournal(db, f.owner, async () => true);
    const provider = {
      async dispatch() {
        sends++;
        throw Error("lost ack");
      },
      async lookup() {
        return {
          requestDigest: f.request,
          receiptDigest: githubSourceDigest({ operation: "fixture" }),
          evidence: { operation: "fixture" },
        };
      },
    };
    const first = new ReleaseEffectRunner(journal(), provider);
    expect(await first.dispatch(f.action, new AbortController().signal)).toBe("held");
    const restarted = new ReleaseEffectRunner(journal(), provider);
    expect(await restarted.dispatch(f.action, new AbortController().signal)).toBe("not_started");
    expect(await restarted.reconcile(f.action, new AbortController().signal)).toBe("observed");
    expect(sends).toBe(1);
    const rows = await db.$queryRaw<
      { phase: string; receipt_digest: string }[]
    >`SELECT phase,receipt_digest FROM delivery_release_actions WHERE id=${f.action}::uuid`;
    expect(rows[0]).toEqual({
      phase: "observed",
      receipt_digest: githubSourceDigest({ operation: "fixture" }),
    });
    await expect(
      db.$executeRaw`UPDATE delivery_release_targets SET active_release_id=NULL WHERE target_digest=${f.target}`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE delivery_release_actions SET phase='effect_started',receipt_digest=NULL WHERE id=${f.action}::uuid`,
    ).rejects.toThrow();
  });
  it("allows only one concurrent dispatch and blocks foreign owners and revoked authorization", async () => {
    const f = await fixture();
    const foreign = new PostgresReleaseEffectJournal(db, randomUUID(), async () => true);
    expect(await foreign.begin(f.action)).toBeNull();
    const denied = new PostgresReleaseEffectJournal(db, f.owner, async () => false);
    expect(await denied.begin(f.action)).toBeNull();
    const journal = new PostgresReleaseEffectJournal(db, f.owner, async () => true);
    const attempts = await Promise.allSettled([journal.begin(f.action), journal.begin(f.action)]);
    expect(attempts.filter((v) => v.status === "fulfilled" && v.value !== null)).toHaveLength(1);
    const row = await db.$queryRaw<
      { phase: string }[]
    >`SELECT phase FROM delivery_release_actions WHERE id=${f.action}::uuid`;
    expect(row[0].phase).toBe("effect_started");
    await expect(
      db.$executeRaw`UPDATE delivery_release_targets SET active_release_id=NULL WHERE target_digest=${f.target}`,
    ).rejects.toThrow();
  });
  it("persists an asynchronous provider reference across restart", async () => {
    const f = await fixture();
    const reference = { requestId: randomUUID() };
    const evidence = { status: "merged", mergeSha: "f".repeat(40) };
    const journal = () => new PostgresReleaseEffectJournal(db, f.owner, async () => true);
    let received: unknown;
    const provider = {
      async dispatch() {
        return { pending: true, reference };
      },
      async lookup(_identity: unknown, ref: unknown) {
        received = ref;
        return { requestDigest: f.request, receiptDigest: githubSourceDigest(evidence), evidence };
      },
    };
    const signal = new AbortController().signal;
    expect(await new ReleaseEffectRunner(journal(), provider).dispatch(f.action, signal)).toBe(
      "held",
    );
    expect(await new ReleaseEffectRunner(journal(), provider).reconcile(f.action, signal)).toBe(
      "observed",
    );
    expect(received).toEqual(reference);
  });
  it.each([
    "healthy",
    "metrics",
    "smoke",
    "recovery",
    "partial",
    "partial_smoke",
    "production",
  ])("runs a synthetic merge and Worker promotion with lost ACK followed by %s", async (outcome) => {
    const f = await fixture();
    const production = outcome === "production",
      baseBranch = production ? "main" : "preview";
    const target = {
      accountId: "a".repeat(32),
      environment: production ? "production" : "preview",
      scripts: {
        app: production ? "fixture-app-prod" : "fixture-app",
        auth: production ? "fixture-auth-prod" : "fixture-auth",
      },
      hiveReleaseWriter: true,
    };
    const observationConfig = {
      target,
      origin: "https://preview.example.invalid",
      minimumRequests: 2,
      maxErrorRate: 0.1,
      settleDelayMs: 60000,
    };
    const approved = {
      audiencePrefix: "urn:hive:release-build:preview:",
      repositoryId: "1",
      repositoryOwnerId: "2",
      workflowRef: "trusted/build/.github/workflows/upload.yml@refs/tags/v1",
      workflowSha: "1".repeat(40),
      branchRef: `refs/heads/${baseBranch}`,
      ...(production ? { mode: "production", productionEnabled: true } : {}),
    };
    const buildRunConfig = { repositoryId: "1", owner: "fixture", name: "repo", workflowId: "99" };
    const publisherConfigDigest = "f".repeat(64);
    const policy = {
      schemaVersion: 1,
      versionId: randomUUID(),
      ownerId: f.owner,
      repositoryId: "1",
      providerAccountId: "2",
      environmentKey: target.environment,
      targetDigest: githubSourceDigest(target),
      targetResources: releaseTargetResources(target),
      actions: ["merge", "promote", "recover"],
      riskClasses: ["application_only"],
      observationWindowMs: 1000,
      observationConfigDigest: githubSourceDigest(observationConfig),
      authorityConfigDigest: "6".repeat(64),
      buildAuthorityDigest: githubSourceDigest({
        workflow: approved,
        run: buildRunConfig,
        publisherConfigDigest,
      }),
      validFrom: Date.now() - 1000,
      expiresAt: Date.now() + 60000,
    };
    const risk = "7".repeat(64),
      sourceSha = "2".repeat(40),
      mergeSha = "8".repeat(40),
      baseline = randomUUID(),
      currentVersion = randomUUID(),
      candidateVersion = randomUUID(),
      authBaseline = randomUUID(),
      authCurrent = randomUUID(),
      authCandidate = randomUUID();
    const baselines = {
      app: {
        deploymentId: baseline,
        versionId: currentVersion,
        sourceSha: "9".repeat(40),
        artifactDigest: "e".repeat(64),
        configDigest: "f".repeat(64),
      },
      auth: {
        deploymentId: authBaseline,
        versionId: authCurrent,
        sourceSha: "9".repeat(40),
        artifactDigest: "e".repeat(64),
        configDigest: "f".repeat(64),
      },
    };
    const bound = {
      task: {
        pauseRequested: false,
        schedulingPaused: false,
        sourceRevisionId: f.source,
        sourceSha,
        currentSourceRevision: {
          id: f.source,
          headSha: sourceSha,
          repositoryId: "1",
          providerAccountId: "2",
          pullRequestId: "3",
          pullNumber: 1,
          baseBranch,
        },
      },
      binding: { policyDigest: "9".repeat(64), bindingDigest: "a".repeat(64) },
    };
    const repositoryPolicies = {
      resolveTask: async () => bound,
    } as unknown as RepositoryPolicyStore;
    const authorize = createReleaseAuthorizer({
      repositoryPolicies,
      policies: () => [policy],
      productionEnabled: production,
      verifyCurrent: async (_tx, context) =>
        context.riskAttestationDigest === risk && context.sourceSha === sourceSha,
    });
    const lifecycle = new ReleaseLifecycle(db, {
      repositoryPolicies,
      policies: () => [policy],
      productionEnabled: production,
      verifyOpening: async (_tx, context) => context.riskAttestationDigest === risk,
      verifyAction: authorize,
      verifyObservation: async (tx, context) => {
        const actions = await tx.$queryRaw<
          { kind: string; phase: string }[]
        >`SELECT kind,phase FROM delivery_release_actions WHERE release_id=${context.releaseId}::uuid`;
        return context.kind === "regression"
          ? context.evidence.smoke === "failed" &&
              actions.some((a) => a.kind === "promote" && a.phase === "observed")
          : context.kind === "recovered" &&
              context.evidence.smoke === "recovered" &&
              actions.some((a) => a.kind === "recover" && a.phase === "observed");
      },
    });
    const releaseId = randomUUID();
    const opened = await lifecycle.open({
      id: releaseId,
      ownerId: f.owner,
      taskId: f.task,
      policyVersionId: policy.versionId,
      riskAttestationDigest: risk,
      baselines,
    });
    expect(opened.replay).toBe(false);
    const overlapPolicy = {
      ...policy,
      versionId: randomUUID(),
      targetDigest: "b".repeat(64),
      targetResources: [policy.targetResources[0], "f".repeat(64)].sort(),
    };
    const overlapping = new ReleaseLifecycle(db, {
      repositoryPolicies,
      policies: () => [overlapPolicy],
      verifyOpening: async () => true,
      verifyAction: async () => false,
      verifyObservation: async () => false,
    });
    await expect(
      overlapping.open({
        id: randomUUID(),
        ownerId: f.owner,
        taskId: f.task,
        policyVersionId: overlapPolicy.versionId,
        riskAttestationDigest: risk,
        baselines,
      }),
    ).rejects.toThrow();
    const mergeAction = randomUUID(),
      mergeRequest = {
        repositoryId: "1",
        pullRequestId: "3",
        pullNumber: 1,
        headSha: sourceSha,
        baseSha: "1".repeat(40),
        baseRef: baseBranch,
        rulesDigest: "b".repeat(64),
        method: "squash",
      };
    await lifecycle.prepare(f.owner, {
      id: mergeAction,
      releaseId,
      kind: "merge",
      request: mergeRequest,
    });
    bound.task.pauseRequested = true;
    expect(
      await new PostgresReleaseEffectJournal(db, f.owner, authorize).begin(mergeAction),
    ).toBeNull();
    bound.task.pauseRequested = false;
    const mergeId = randomUUID();
    const github = new GitHubReleaseProvider(
      {
        repositoryId: "1",
        owner: "fixture",
        name: "repo",
        allowedBaseRef: baseBranch,
        ...(production ? { mode: "production", productionEnabled: true } : {}),
      },
      "fixture",
      async () => true,
      async (_r, sha) => sha === mergeSha,
      async (_url, init) =>
        new Response(
          JSON.stringify(
            init?.method === "PUT"
              ? {
                  status: "pending",
                  details: { uuid: mergeId, expected_head_sha: sourceSha, bypass_rules: false },
                }
              : { status: "merged", details: { sha: mergeSha } },
          ),
          { status: init?.method === "PUT" ? 202 : 200 },
        ),
    );
    const journal = () => new PostgresReleaseEffectJournal(db, f.owner, authorize),
      signal = new AbortController().signal;
    expect(await new ReleaseEffectRunner(journal(), github).dispatch(mergeAction, signal)).toBe(
      "held",
    );
    expect(await new ReleaseEffectRunner(journal(), github).reconcile(mergeAction, signal)).toBe(
      "observed",
    );
    const active = {
      app: { id: baseline, version: currentVersion, marker: "" },
      auth: { id: authBaseline, version: authCurrent, marker: "" },
    };
    const buildResources = { bindings: {}, script_runtime: { compatibility_date: "2026-10-29" } };
    const buildConfigDigest = githubSourceDigest({
      bindings: buildResources.bindings,
      runtime: buildResources.script_runtime,
    });
    let loseAck = true;
    const cloudflare = new CloudflareReleaseProvider(target, "fixture", async (url, init) => {
      const component = String(url).includes("fixture-auth") ? "auth" : "app";
      if (String(url).includes("/versions/"))
        return Response.json({
          success: true,
          result: {
            id: component === "app" ? candidateVersion : authCandidate,
            resources: { ...buildResources, script: { etag: `${component}-etag` } },
          },
        });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        active[component] = {
          id: randomUUID(),
          version: body.versions[0].version_id,
          marker: body.annotations["workers/message"],
        };
        if (loseAck) {
          loseAck = false;
          throw new Error("lost ACK");
        }
        return new Response(
          JSON.stringify({
            success: true,
            result: {
              id: active[component].id,
              strategy: "percentage",
              versions: [{ version_id: active[component].version, percentage: 100 }],
              annotations: { "workers/message": active[component].marker },
            },
          }),
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            deployments: [
              {
                id: active[component].id,
                strategy: "percentage",
                versions: [{ version_id: active[component].version, percentage: 100 }],
                annotations: { "workers/message": active[component].marker },
              },
            ],
          },
        }),
      );
    });
    let promoteId: string = randomUUID(),
      promotion = {
        component: "app",
        expectedDeploymentId: baseline,
        expectedVersionId: currentVersion,
        versionId: candidateVersion,
        mergedSha: mergeSha,
        artifactDigest: "c".repeat(64),
        configDigest: buildConfigDigest,
        baselineSourceSha: "9".repeat(40),
        baselineArtifactDigest: "e".repeat(64),
        baselineConfigDigest: "f".repeat(64),
      };
    await expect(
      lifecycle.prepare(f.owner, { id: promoteId, releaseId, kind: "promote", request: promotion }),
    ).rejects.toThrow();
    const manifest = {
      schemaVersion: 1,
      releaseId,
      ownerId: f.owner,
      repositoryId: "1",
      repositoryOwnerId: "2",
      mergeSha,
      targetDigest: policy.targetDigest,
      runId: "88",
      runAttempt: 1,
      app: {
        script: target.scripts.app,
        versionId: candidateVersion,
        artifactDigest: promotion.artifactDigest,
        configDigest: buildConfigDigest,
        providerScriptHash: "app-etag",
      },
      auth: {
        script: target.scripts.auth,
        versionId: authCandidate,
        artifactDigest: promotion.artifactDigest,
        configDigest: buildConfigDigest,
        providerScriptHash: "auth-etag",
      },
    };
    const now = Math.floor(Date.now() / 1000),
      buildClaims = {
        iss: "https://token.actions.githubusercontent.com",
        aud: `${approved.audiencePrefix}${githubSourceDigest(manifest)}`,
        repository_id: "1",
        repository_owner_id: "2",
        sha: mergeSha,
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
      content = `${encode({ alg: "RS256", kid: "fixture" })}.${encode(buildClaims)}`;
    const token = `${content}.${sign("RSA-SHA256", Buffer.from(content), buildKeys.privateKey).toString("base64url")}`;
    const buildRun = new GitHubBuildRunVerifier(buildRunConfig, "fixture", async () =>
      Response.json({
        id: 88,
        run_attempt: 1,
        workflow_id: 99,
        status: "completed",
        conclusion: "success",
        event: "push",
        head_sha: mergeSha,
        repository: { id: 1 },
        head_repository: { id: 1 },
      }),
    );
    const buildStore = new ReleaseBuildStore(
      db,
      approved,
      cloudflare,
      authorize,
      buildRun,
      async () =>
        Response.json({
          keys: [
            {
              ...buildKeys.publicKey.export({ format: "jwk" }),
              kid: "fixture",
              use: "sig",
              alg: "RS256",
            },
          ],
        }),
      policy.targetDigest,
      publisherConfigDigest,
    );
    const {
      app: _app,
      auth: _auth,
      ownerId: _owner,
      releaseId: _release,
      ...challengeFields
    } = manifest;
    const challenge = {
      ...challengeFields,
      purpose: "release_build_challenge",
      publisherConfigDigest,
    };
    const challengeClaims = {
      ...buildClaims,
      aud: `${approved.audiencePrefix}${githubSourceDigest(challenge)}`,
      jti: randomUUID(),
    };
    const challengeContent = `${encode({ alg: "RS256", kid: "fixture" })}.${encode(challengeClaims)}`;
    const challengeToken = `${challengeContent}.${sign("RSA-SHA256", Buffer.from(challengeContent), buildKeys.privateKey).toString("base64url")}`;
    expect(await buildStore.challenge(challenge, challengeToken, signal)).toEqual({
      releaseId,
      ownerId: f.owner,
      targetDigest: policy.targetDigest,
      publisherConfigDigest,
      mergeSha,
    });
    await expect(
      buildStore.challenge({ ...challenge, mergeSha: "4".repeat(40) }, challengeToken, signal),
    ).rejects.toThrow();
    await expect(buildStore.challenge(challenge, token, signal)).rejects.toThrow();
    const foreignConfig = { ...challenge, publisherConfigDigest: "0".repeat(64) };
    const foreignClaims = {
      ...challengeClaims,
      aud: `${approved.audiencePrefix}${githubSourceDigest(foreignConfig)}`,
    };
    const foreignContent = `${encode({ alg: "RS256", kid: "fixture" })}.${encode(foreignClaims)}`;
    const foreignToken = `${foreignContent}.${sign("RSA-SHA256", Buffer.from(foreignContent), buildKeys.privateKey).toString("base64url")}`;
    await expect(buildStore.challenge(foreignConfig, foreignToken, signal)).rejects.toThrow(
      "release_build_unavailable",
    );
    expect((await buildStore.submit(manifest, token, signal)).manifestDigest).toBe(
      githubSourceDigest(manifest),
    );
    expect((await buildStore.submit(manifest, token, signal)).manifestDigest).toBe(
      githubSourceDigest(manifest),
    );
    await expect(
      buildStore.submit({ ...manifest, mergeSha: "4".repeat(40) }, token, signal),
    ).rejects.toThrow();
    await expect(
      lifecycle.prepare(f.owner, { id: promoteId, releaseId, kind: "promote", request: promotion }),
    ).rejects.toThrow();
    expect((await buildStore.verifyRun(f.owner, releaseId, signal)).manifestDigest).toBe(
      githubSourceDigest(manifest),
    );
    const planner = new ReleasePlanner(db, policy.targetDigest, lifecycle);
    expect(await planner.advance(f.owner, releaseId)).toBe("prepared");
    promoteId = (
      await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_release_actions WHERE release_id=${releaseId}::uuid AND kind='promote' AND phase='prepared'`
    )[0].id;
    expect(await new ReleaseEffectRunner(journal(), cloudflare).dispatch(promoteId, signal)).toBe(
      "held",
    );
    expect(await new ReleaseEffectRunner(journal(), cloudflare).reconcile(promoteId, signal)).toBe(
      "observed",
    );
    const authPromotion = {
      ...promotion,
      component: "auth",
      expectedDeploymentId: authBaseline,
      expectedVersionId: authCurrent,
      versionId: authCandidate,
    };
    let authPromoteId: string = randomUUID();
    if (outcome !== "partial" && outcome !== "partial_smoke") {
      await expect(
        lifecycle.prepare(f.owner, {
          id: authPromoteId,
          releaseId,
          kind: "promote",
          request: authPromotion,
        }),
      ).rejects.toThrow();
      const stageObserver = new CloudflareReleaseObserver(
        observationConfig,
        { analyticsToken: "fixture", probeSecret: "e".repeat(64), previewBearer: "f".repeat(64) },
        async (component) => ({
          deploymentId: active[component].id,
          versionId: active[component].version,
        }),
        async () =>
          Response.json({
            schemaVersion: 1,
            app: {
              component: "app",
              ready: true,
              sourceSha: mergeSha,
              artifactDigest: promotion.artifactDigest,
            },
            auth: {
              component: "auth",
              ready: true,
              sourceSha: baselines.auth.sourceSha,
              artifactDigest: baselines.auth.artifactDigest,
            },
          }),
      );
      const stageController = new ReleaseObservationController(
        db,
        stageObserver,
        authorize,
        (verifyObservation) =>
          new ReleaseLifecycle(db, {
            repositoryPolicies,
            policies: () => [policy],
            verifyOpening: async () => true,
            verifyAction: authorize,
            verifyObservation,
          }),
      );
      expect((await stageController.observe(f.owner, releaseId, signal)).phase).toBe("stage_ready");
      expect(await planner.advance(f.owner, releaseId)).toBe("prepared");
      authPromoteId = (
        await db.$queryRaw<
          { id: string }[]
        >`SELECT id FROM delivery_release_actions WHERE release_id=${releaseId}::uuid AND kind='promote' AND phase='prepared'`
      )[0].id;
      expect(
        await new ReleaseEffectRunner(journal(), cloudflare).dispatch(authPromoteId, signal),
      ).toBe("observed");
    }
    if (outcome === "partial_smoke") {
      const failingObserver = new CloudflareReleaseObserver(
        observationConfig,
        { analyticsToken: "fixture", probeSecret: "e".repeat(64), previewBearer: "f".repeat(64) },
        async (component) => ({
          deploymentId: active[component].id,
          versionId: active[component].version,
        }),
        async () => new Response(null, { status: 503 }),
      );
      const controller = new ReleaseObservationController(
        db,
        failingObserver,
        authorize,
        (verifyObservation) =>
          new ReleaseLifecycle(db, {
            repositoryPolicies,
            policies: () => [policy],
            verifyOpening: async () => true,
            verifyAction: authorize,
            verifyObservation,
          }),
      );
      expect((await controller.observe(f.owner, releaseId, signal)).phase).toBe("held");
    }
    if (
      outcome === "healthy" ||
      outcome === "production" ||
      outcome === "metrics" ||
      outcome === "smoke"
    ) {
      // Simulate an already elapsed observation window only in this isolated
      // fixture; production journal transition triggers remain enabled.
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        await tx.$executeRaw`UPDATE delivery_release_actions SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id IN (${promoteId}::uuid,${authPromoteId}::uuid)`;
      });
      const observer = new CloudflareReleaseObserver(
        observationConfig,
        { analyticsToken: "fixture", probeSecret: "e".repeat(64), previewBearer: "f".repeat(64) },
        async (component) => ({
          deploymentId: active[component].id,
          versionId: active[component].version,
        }),
        async (url) =>
          String(url).includes(".well-known")
            ? outcome === "smoke"
              ? new Response(null, { status: 503 })
              : Response.json({
                  schemaVersion: 1,
                  app: {
                    component: "app",
                    ready: true,
                    sourceSha: mergeSha,
                    artifactDigest: promotion.artifactDigest,
                  },
                  auth: {
                    component: "auth",
                    ready: true,
                    sourceSha: mergeSha,
                    artifactDigest: authPromotion.artifactDigest,
                  },
                })
            : Response.json({
                data: {
                  viewer: {
                    accounts: [
                      {
                        workersInvocationsAdaptive: [
                          { sum: { requests: 100, errors: outcome === "metrics" ? 20 : 1 } },
                        ],
                      },
                    ],
                  },
                },
              }),
      );
      const controller = new ReleaseObservationController(
        db,
        observer,
        authorize,
        (verifyObservation) =>
          new ReleaseLifecycle(db, {
            repositoryPolicies,
            policies: () => [policy],
            verifyOpening: async () => true,
            verifyAction: authorize,
            verifyObservation,
          }),
      );
      expect((await controller.observe(f.owner, releaseId, signal)).phase).toBe(
        outcome === "healthy" || outcome === "production" ? "healthy" : "held",
      );
      if (outcome === "healthy" || outcome === "production") {
        const current = await db.$queryRaw<
          { active_release_id: string | null }[]
        >`SELECT active_release_id FROM delivery_release_targets WHERE target_digest=${policy.targetDigest}`;
        expect(current[0].active_release_id).toBeNull();
        const authority = new ReleaseAuthorityFacts(
          db,
          {
            targetDigest: policy.targetDigest,
            riskCatalogDigest: "d".repeat(64),
            mergeMethod: "squash",
            baselines,
          },
          repositoryPolicies,
          () => [policy],
          null as never,
          null as never,
          null as never,
          null as never,
        );
        expect(await authority.resolveBaseline()).toEqual({
          app: {
            deploymentId: active.app.id,
            versionId: candidateVersion,
            sourceSha: mergeSha,
            artifactDigest: promotion.artifactDigest,
            configDigest: promotion.configDigest,
          },
          auth: {
            deploymentId: active.auth.id,
            versionId: authCandidate,
            sourceSha: mergeSha,
            artifactDigest: authPromotion.artifactDigest,
            configDigest: authPromotion.configDigest,
          },
        });
        return;
      }
    }
    if (outcome === "recovery" || outcome === "partial") {
      await expect(
        lifecycle.observe(f.owner, { releaseId, kind: "healthy", evidence: { smoke: "failed" } }),
      ).rejects.toThrow();
      expect(
        (
          await lifecycle.observe(f.owner, {
            releaseId,
            kind: "regression",
            evidence: { smoke: "failed" },
          })
        ).phase,
      ).toBe("held");
    }
    expect(await planner.advance(f.owner, releaseId)).toBe("prepared");
    const recoveryId = (
      await db.$queryRaw<
        { id: string }[]
      >`SELECT id FROM delivery_release_actions WHERE release_id=${releaseId}::uuid AND kind='recover' AND phase='prepared'`
    )[0].id;
    expect(await new ReleaseEffectRunner(journal(), cloudflare).dispatch(recoveryId, signal)).toBe(
      "observed",
    );
    await expect(
      lifecycle.observe(f.owner, {
        releaseId,
        kind: "recovered",
        evidence: { smoke: "recovered" },
      }),
    ).rejects.toThrow();
    let authRecovery: string = randomUUID();
    if (outcome !== "partial" && outcome !== "partial_smoke") {
      expect(await planner.advance(f.owner, releaseId)).toBe("prepared");
      authRecovery = (
        await db.$queryRaw<
          { id: string }[]
        >`SELECT id FROM delivery_release_actions WHERE release_id=${releaseId}::uuid AND kind='recover' AND phase='prepared'`
      )[0].id;
      expect(
        await new ReleaseEffectRunner(journal(), cloudflare).dispatch(authRecovery, signal),
      ).toBe("observed");
    }
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`UPDATE delivery_release_actions SET updated_at=clock_timestamp()-interval '2 minutes' WHERE id IN (${recoveryId}::uuid,${authRecovery}::uuid)`;
    });
    const recoveryObserver = new CloudflareReleaseObserver(
      observationConfig,
      { analyticsToken: "fixture", probeSecret: "e".repeat(64), previewBearer: "f".repeat(64) },
      async (component) => ({
        deploymentId: active[component].id,
        versionId: active[component].version,
      }),
      async (url) =>
        String(url).includes(".well-known")
          ? Response.json({
              schemaVersion: 1,
              app: {
                component: "app",
                ready: true,
                sourceSha: baselines.app.sourceSha,
                artifactDigest: baselines.app.artifactDigest,
              },
              auth: {
                component: "auth",
                ready: true,
                sourceSha: baselines.auth.sourceSha,
                artifactDigest: baselines.auth.artifactDigest,
              },
            })
          : Response.json({
              data: {
                viewer: {
                  accounts: [
                    { workersInvocationsAdaptive: [{ sum: { requests: 100, errors: 1 } }] },
                  ],
                },
              },
            }),
    );
    const recoveryController = new ReleaseObservationController(
      db,
      recoveryObserver,
      authorize,
      (verifyObservation) =>
        new ReleaseLifecycle(db, {
          repositoryPolicies,
          policies: () => [policy],
          verifyOpening: async () => true,
          verifyAction: authorize,
          verifyObservation,
        }),
    );
    expect((await recoveryController.observe(f.owner, releaseId, signal)).phase).toBe("recovered");
    const observations = await db.$queryRaw<
      { evidence: Record<string, unknown> }[]
    >`SELECT evidence FROM delivery_release_observations WHERE release_id=${releaseId}::uuid AND kind='recovered'`;
    expect(
      await lifecycle.observe(f.owner, {
        releaseId,
        kind: "recovered",
        evidence: observations[0].evidence,
      }),
    ).toMatchObject({ replay: true, historical: true });
    const notices = await db.$queryRaw<
      { type: string }[]
    >`SELECT e.type FROM delivery_events e JOIN delivery_outbox o ON o.event_id=e.id AND o.owner_id=e.owner_id WHERE e.owner_id=${f.owner}::uuid AND e.task_id=${f.task}::uuid ORDER BY e.type`;
    expect(notices.map((row) => row.type)).toEqual([
      "release_action_held",
      "release_recovered",
      "release_regression",
    ]);
    const outbox = new DeliveryOutbox(db),
      claims = await outbox.claim(f.owner);
    const messages = await Promise.all(claims.map((claim) => outbox.notification(claim)));
    expect(messages.map((message) => message?.payload.title).sort()).toEqual(
      [
        "Release action requires reconciliation",
        "Release recovery verified",
        "Release regression detected",
      ].sort(),
    );
    const targetRows = await db.$queryRaw<
      { active_release_id: string | null }[]
    >`SELECT active_release_id FROM delivery_release_targets WHERE target_digest=${policy.targetDigest}`;
    expect(targetRows[0].active_release_id).toBeNull();
  });
});
