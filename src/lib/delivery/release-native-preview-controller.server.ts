import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@hive/db";
import { z } from "zod";
import { canonicalGitHubSource } from "./github-evidence.server";
import { type ReleaseActionIdentity, releaseActionIdentitySchema } from "./release-action-journal";
import { configuredReleasePolicies, createReleaseAuthorizer } from "./release-authority.server";
import { ReleaseAutoOpener } from "./release-auto-open.server";
import { GitHubReleaseChangeRisk } from "./release-change-risk.server";
import { PostgresReleaseEffectJournal } from "./release-effect-journal.server";
import { ReleaseEffectRunner } from "./release-effect-runner.server";
import { verifyReleaseEvidence } from "./release-evidence.server";
import { ReleaseAuthorityFacts, verifyReleaseAuthorityFact } from "./release-facts.server";
import { releaseGitHubMerged } from "./release-github-merged.server";
import { releaseGitHubPreflight } from "./release-github-preflight.server";
import { GitHubReleaseProvider } from "./release-github-provider.server";
import { GitHubReleaseRules } from "./release-github-rules.server";
import { ReleaseLifecycle } from "./release-lifecycle.server";
import {
  nativeBuildPolicySchema,
  verifyNativeBuilder,
} from "./release-native-preview-authority.server";
import {
  nativeArtifactSchema,
  nativeBaselineSchema,
  nativeBootstrapEnrollmentSchema,
  nativeDigest,
  nativePublicationRequestSchema,
  nativePublicConfigSchema,
  nativePublisherPolicySchema,
} from "./release-native-preview-contracts";
import { NativePreviewPublicationReadback } from "./release-native-preview-provider.server";
import { nativePreviewReleaseTargetSchema } from "./release-native-preview-reader.server";
import { NativePreviewPublicationStore } from "./release-native-preview-store.server";
import { prepareReleaseMergeFromFacts } from "./release-planner.server";
import { ReleaseScheduler } from "./release-scheduler.server";
import { GitHubReleaseSourceDiscovery } from "./release-source-discovery.server";
import { releaseTestWorkflowSchema } from "./release-tested-attestation.server";
import {
  GitHubReleaseTestRunVerifier,
  releaseTestRunConfigSchema,
} from "./release-tested-run.server";
import { ReleaseTestStore } from "./release-tested-store.server";
import { repositoryPolicyStore } from "./repository-policy.server";

const hex = z.string().regex(/^[a-f0-9]{64}$/),
  id = z.string().regex(/^[1-9][0-9]{0,19}$/),
  uuid = z.string().uuid();
export const nativeReleaseControllerConfigSchema = z
  .object({
    provider: z.literal("cloudflare-native-preview"),
    target: nativePreviewReleaseTargetSchema,
    externalWriterPolicy: z.literal("observed-drift-hold-no-atomic-cas"),
    github: z
      .object({
        repositoryId: id,
        owner: z.literal("kethalia"),
        name: z.literal("hive"),
        allowedBaseRef: z.literal("codex/delivery-system-design"),
      })
      .strict(),
    builder: nativeBuildPolicySchema,
    publisher: nativePublisherPolicySchema,
    publicConfig: nativePublicConfigSchema,
    privateBindingRevision: uuid,
    compatibilityRevision: uuid,
    riskCatalog: z
      .object({
        owner: z.literal("kethalia"),
        name: z.literal("hive"),
        allowedPrefixes: z.array(z.string()),
        databasePrefixes: z.array(z.string()).optional(),
      })
      .strict(),
    authority: z
      .object({
        targetDigest: hex,
        riskCatalogDigest: hex,
        mergeMethod: z.enum(["merge", "squash", "rebase"]),
        baselines: nativeBaselineSchema.nullable(),
        tested: z
          .object({ workflow: releaseTestWorkflowSchema, run: releaseTestRunConfigSchema })
          .strict(),
      })
      .strict(),
    observation: z
      .object({
        windowMs: z.number().int().min(1000).max(86400000),
        minimumSamples: z.number().int().min(2).max(1000),
      })
      .strict(),
    bootstrap: nativeBootstrapEnrollmentSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      nativeDigest(v.target) !== v.authority.targetDigest ||
      nativeDigest(v.riskCatalog) !== v.authority.riskCatalogDigest ||
      v.builder.repositoryId !== v.github.repositoryId ||
      v.publisher.repositoryId !== v.github.repositoryId ||
      v.builder.repositoryOwnerId !== v.publisher.repositoryOwnerId ||
      v.publicConfig.vars.HIVE_RELEASE_HEALTH_ENABLED !== "true" ||
      !v.publicConfig.secretNames.includes("HIVE_RELEASE_PROBE_SECRET")
    )
      ctx.addIssue({ code: "custom", message: "Native release enrollment inconsistent" });
  });
/** Deployed config and DB are operator-trusted, not isolated from candidate
 * application code. No native writer credential or candidate-selected target. */
export function createNativePreviewReleaseController(
  db: PrismaClient,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch,
) {
  if (env.HIVE_DELIVERY_RELEASE_ENABLED !== "true") return null;
  const raw = env.HIVE_DELIVERY_RELEASE_CONFIG_JSON;
  if (!raw || Buffer.byteLength(raw) > 65536) throw Error("native_controller_unavailable");
  const config = nativeReleaseControllerConfigSchema.parse(JSON.parse(raw));
  if (!/^[a-f0-9]{64}$/.test(env.HIVE_RELEASE_PROBE_SECRET ?? ""))
    throw Error("native_controller_unavailable");
  const githubToken = env.HIVE_DELIVERY_RELEASE_GITHUB_TOKEN ?? "",
    readToken = env.HIVE_DELIVERY_RELEASE_CLOUDFLARE_TOKEN ?? "";
  const targetDigest = nativeDigest(config.target),
    authorityDigest = nativeDigest(config.authority),
    repository = repositoryPolicyStore(db);
  const observationDigest = nativeDigest({
    target: config.target,
    observation: config.observation,
    healthScope: "sampled-health-no-atomic-exclusion",
  });
  const resource = nativeDigest({
    provider: "cloudflare-native-preview",
    accountId: config.target.accountId,
    workerName: config.target.workerName,
    previewId: config.target.previewId,
  });
  const policies = () =>
    configuredReleasePolicies(env).filter(
      (p) =>
        p.environmentKey === "preview" &&
        p.targetDigest === targetDigest &&
        p.authorityConfigDigest === authorityDigest &&
        p.buildAuthorityDigest ===
          nativeDigest({ builder: config.builder, publisher: config.publisher }) &&
        p.observationConfigDigest === observationDigest &&
        p.targetResources.length === 1 &&
        p.targetResources[0] === resource &&
        p.riskClasses.every((r) => r === "application_only"),
    );
  // Legacy GitHub readers use redirect:error. Native construction adapts their
  // transport without changing legacy callers, rejecting redirects after I/O.
  const portableFetch: typeof fetch = async (input, init) => {
    const response = await fetcher(input, { ...init, redirect: "manual" });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      throw Error("native_provider_redirect");
    }
    return response;
  };
  const rules = new GitHubReleaseRules(
      { owner: config.github.owner, name: config.github.name },
      githubToken,
      portableFetch,
    ),
    risk = new GitHubReleaseChangeRisk(config.riskCatalog, githubToken, portableFetch);
  const tested = new ReleaseTestStore(
    db,
    config.authority.tested.workflow,
    new GitHubReleaseTestRunVerifier(config.authority.tested.run, githubToken, portableFetch),
    repository,
    policies,
    targetDigest,
    authorityDigest,
    rules,
    risk,
    portableFetch,
  );
  const readback = new NativePreviewPublicationReadback(
    config.target,
    readToken,
    env.HIVE_RELEASE_PROBE_SECRET ?? "",
    fetcher,
  );
  let publications: NativePreviewPublicationStore;
  const baseAuthorize = createReleaseAuthorizer({
    repositoryPolicies: repository,
    policies,
    verifyCurrent: async (tx, scope) => {
      const row = (
        await tx.$queryRaw<
          { snapshot: Record<string, unknown>; snapshot_digest: string }[]
        >`SELECT snapshot,snapshot_digest FROM delivery_releases WHERE id=${scope.releaseId}::uuid`
      )[0];
      if (
        !row ||
        nativeDigest(row.snapshot) !== row.snapshot_digest ||
        row.snapshot.authorityConfigDigest !== authorityDigest ||
        !(await verifyReleaseEvidence(tx, repository, scope))
      )
        return false;
      const baselines = nativeBaselineSchema.safeParse(row.snapshot.baselines);
      if (
        !baselines.success ||
        !(await verifyReleaseAuthorityFact(tx, {
          ...scope,
          targetDigest,
          configDigest: authorityDigest,
          factDigest: String(row.snapshot.riskAttestationDigest),
          baselines: baselines.data,
          fresh: scope.identity.kind === "merge",
        }))
      )
        return false;
      if (scope.identity.kind === "merge") return true;
      const completed = await tx.$queryRaw<
        {
          id: string;
          kind: string;
          request: Record<string, unknown>;
          receipt: Record<string, unknown>;
        }[]
      >`SELECT id,kind,request,receipt FROM delivery_release_actions WHERE release_id=${scope.releaseId}::uuid AND phase='observed'`;
      return publications.verifyPreparation(
        tx,
        scope.ownerId,
        scope.identity,
        row.snapshot,
        completed,
      );
    },
  });
  const authorize = async (tx: Prisma.TransactionClient, identity: ReleaseActionIdentity) => {
    if (
      identity.request.provider !== "cloudflare-native-preview" ||
      identity.request.purpose !== "bootstrap-baseline"
    )
      return baseAuthorize(tx, identity);
    const b = nativeBootstrapEnrollmentSchema.safeParse(config.bootstrap);
    if (
      !b.success ||
      identity.kind !== "promote" ||
      identity.id !== b.data.artifactId ||
      identity.releaseId !== b.data.releaseId ||
      identity.targetDigest !== targetDigest
    )
      return false;
    const row = (
      await tx.$queryRaw<
        {
          owner_id: string;
          snapshot: Record<string, unknown>;
          snapshot_digest: string;
          policy_digest: string;
          source_sha: string | null;
          source_revision_id: string | null;
          pause_requested: boolean;
          scheduling_paused: boolean;
        }[]
      >`SELECT r.owner_id,r.snapshot,r.snapshot_digest,r.policy_digest,t.source_sha,t.source_revision_id,t.pause_requested,t.scheduling_paused FROM delivery_releases r JOIN delivery_tasks t ON t.id=r.task_id AND t.owner_id=r.owner_id WHERE r.id=${identity.releaseId}::uuid FOR UPDATE OF t,r`
    )[0];
    const now = (
      await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    if (
      !row ||
      row.owner_id !== b.data.ownerId ||
      row.policy_digest !== nativeDigest(b.data) ||
      nativeDigest(row.snapshot) !== row.snapshot_digest ||
      row.snapshot.bootstrapApprovalDigest !== nativeDigest(b.data) ||
      row.snapshot.authorityConfigDigest !== authorityDigest ||
      row.source_sha !== b.data.sourceSha ||
      row.source_revision_id !== b.data.sourceRevisionId ||
      row.pause_requested ||
      row.scheduling_paused ||
      now >= b.data.expiresAt
    )
      return false;
    return publications.verifyPreparation(tx, b.data.ownerId, identity, row.snapshot, []);
  };
  publications = new NativePreviewPublicationStore(
    db,
    {
      target: config.target,
      builderPolicy: config.builder,
      publisherPolicy: config.publisher,
      publicConfig: config.publicConfig,
      privateBindingRevision: config.privateBindingRevision,
      compatibilityRevision: config.compatibilityRevision,
      bootstrap: config.bootstrap,
    },
    githubToken,
    authorize,
    async (tx, a) => {
      if (publications.bootstrapMatches(a)) return true;
      const row = (
        await tx.$queryRaw<
          { task_id: string; snapshot: Record<string, unknown> }[]
        >`SELECT task_id,snapshot FROM delivery_releases WHERE id=${a.releaseId}::uuid AND owner_id=${a.ownerId}::uuid`
      )[0];
      return (
        !!row &&
        row.snapshot.authorityConfigDigest === authorityDigest &&
        (await verifyReleaseEvidence(tx, repository, {
          ownerId: a.ownerId,
          taskId: row.task_id,
          sourceSha: String(row.snapshot.sourceSha),
        }))
      );
    },
    portableFetch,
  );
  const lifecycleFactory = (expected?: Record<string, unknown>) =>
    new ReleaseLifecycle(db, {
      repositoryPolicies: repository,
      policies,
      nativeTarget: config.target,
      nativeBootstrap: config.bootstrap
        ? {
            enrollment: config.bootstrap,
            authorityConfigDigest: authorityDigest,
            observationConfigDigest: observationDigest,
            observationWindowMs: config.observation.windowMs,
          }
        : undefined,
      verifyOpening: async () => false,
      verifyNativeOpening: async (tx, scope) =>
        verifyReleaseAuthorityFact(tx, {
          ...scope,
          configDigest: authorityDigest,
          factDigest: scope.riskAttestationDigest,
          fresh: true,
        }),
      verifyAction: authorize,
      verifyNativePreparation: (tx, owner, identity, snapshot, completed) =>
        publications.verifyPreparation(tx, owner, identity, snapshot, completed),
      verifyObservation: async (tx, input) => {
        if (!expected || nativeDigest(expected) !== nativeDigest(input.evidence)) return false;
        const rows = await tx.$queryRaw<
          {
            id: string;
            release_id: string;
            kind: string;
            target_digest: string;
            request: Record<string, unknown>;
            request_digest: string;
            generation: number;
          }[]
        >`SELECT id,release_id,kind,target_digest,request,request_digest,generation FROM delivery_release_actions WHERE id=${String(input.evidence.actionId)}::uuid AND release_id=${input.releaseId}::uuid AND phase='observed'`;
        const row = rows[0];
        if (!row) return false;
        return authorize(
          tx,
          releaseActionIdentitySchema.parse({
            id: row.id,
            releaseId: row.release_id,
            kind: row.kind,
            targetDigest: row.target_digest,
            request: row.request,
            requestDigest: row.request_digest,
            generation: row.generation,
          }),
        );
      },
      recordNativeBaseline: (tx, owner, release, evidence, digest) =>
        publications.recordBaseline(tx, owner, release, evidence, digest),
    });
  const lifecycle = lifecycleFactory();
  const basicMergePreflight = releaseGitHubPreflight(rules, risk);
  const github = new GitHubReleaseProvider(
    { ...config.github, mode: "preview" },
    githubToken,
    async (request, signal) => {
      try {
        if (!(await basicMergePreflight(request, signal))) return false;
        const now = Date.now(),
          active = policies().filter(
            (p) =>
              p.repositoryId === request.repositoryId &&
              p.actions.includes("merge") &&
              p.validFrom <= now &&
              p.expiresAt > now,
          );
        if (active.length !== 1) return false;
        const tasks = await db.deliveryTask.findMany({
          where: {
            ownerId: active[0].ownerId,
            currentSourceRevision: {
              is: {
                repositoryId: request.repositoryId,
                pullRequestId: request.pullRequestId,
                headSha: request.headSha,
              },
            },
          },
          select: { id: true, ownerId: true },
          take: 2,
        });
        if (tasks.length !== 1) return false;
        const bound = await db.$transaction((tx) =>
          repository.resolveTask(tx, tasks[0].ownerId, tasks[0].id),
        );
        if (!bound || bound.task.sourceSha !== request.headSha) return false;
        if (
          (await rules.verifyTested(request, bound.policy.evidenceGates, signal)).rulesDigest !==
          request.rulesDigest
        )
          return false;
        await tested.verifyFresh(tasks[0].ownerId, tasks[0].id, request, signal);
        return !signal.aborted;
      } catch {
        return false;
      }
    },
    releaseGitHubMerged(
      { owner: config.github.owner, name: config.github.name },
      githubToken,
      portableFetch,
    ),
    portableFetch,
  );
  const makeRequest = (
    artifact: z.infer<typeof nativeArtifactSchema>,
    expectedCurrentDeploymentId: string,
    baseline: z.infer<typeof nativeBaselineSchema> | null,
    purpose: "bootstrap-baseline" | "publish" | "recover",
  ) =>
    nativePublicationRequestSchema.parse({
      provider: "cloudflare-native-preview",
      purpose,
      artifactId: artifact.id,
      expectedCurrentDeploymentId,
      sourceSha: artifact.sourceSha,
      artifactDigest: artifact.artifactDigest,
      publicConfigDigest: nativeDigest(artifact.publicConfig),
      privateBindingRevision: artifact.privateBindingRevision,
      compatibilityRevision: artifact.compatibilityRevision,
      recoveryBaseline: baseline,
    });
  const nativePlanner = {
    async prepareArtifact(artifact: z.infer<typeof nativeArtifactSchema>, signal: AbortSignal) {
      const existing = await db.$queryRaw<
        { id: string; request: unknown }[]
      >`SELECT id,request FROM delivery_release_actions WHERE id=${artifact.id}::uuid AND release_id=${artifact.releaseId}::uuid`;
      if (existing.length) {
        const request = nativePublicationRequestSchema.parse(existing[0].request);
        if (request.artifactId !== artifact.id)
          return Promise.reject(Error("native_action_conflict"));
        return { actionId: existing[0].id };
      }
      const bootstrap = publications.bootstrapMatches(artifact),
        baseline = bootstrap ? null : await publications.resolveBaseline();
      const current = await readback.readCurrent(signal);
      const request = makeRequest(
        artifact,
        current.deploymentId,
        baseline,
        bootstrap ? "bootstrap-baseline" : "publish",
      );
      await lifecycle.prepare(artifact.ownerId, {
        id: artifact.id,
        releaseId: artifact.releaseId,
        kind: "promote",
        request,
      });
      return { actionId: artifact.id };
    },
    async advance(ownerId: string, releaseId: string) {
      const release = (
        await db.$queryRaw<
          {
            phase: string;
            snapshot: Record<string, unknown>;
            snapshot_digest: string;
            task_id: string;
          }[]
        >`SELECT r.phase,r.snapshot,r.snapshot_digest,r.task_id FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.id=${releaseId}::uuid AND r.owner_id=${ownerId}::uuid AND r.target_digest=${targetDigest} AND t.active_release_id=r.id`
      )[0];
      if (!release || nativeDigest(release.snapshot) !== release.snapshot_digest) return "held";
      if (release.phase === "held") {
        const promotion = await publications.observedPublication(ownerId, releaseId, "promote");
        if (!promotion || promotion.grant.purpose === "bootstrap-baseline") return "held";
        const request = nativePublicationRequestSchema.parse(promotion.identity.request),
          baseline = request.recoveryBaseline;
        if (!baseline) return "held";
        const inFlight = await db.$queryRaw<
          { id: string }[]
        >`SELECT id FROM delivery_release_actions WHERE release_id=${releaseId}::uuid AND (kind='recover' OR phase IN ('prepared','effect_started','held')) LIMIT 1`;
        if (inFlight.length) return "waiting";
        const current = await readback.readCurrent(AbortSignal.timeout(10000));
        if (current.deploymentId !== promotion.receipt.deploymentId) return "held";
        const artifact = await publications.artifact(ownerId, baseline.artifactId);
        await lifecycle.prepare(ownerId, {
          id: randomUUID(),
          releaseId,
          kind: "recover",
          request: makeRequest(artifact, promotion.receipt.deploymentId, baseline, "recover"),
        });
        return "prepared";
      }
      if (release.phase !== "active") return "held";
      const actions = await db.$queryRaw<
        { kind: string; phase: string }[]
      >`SELECT kind,phase FROM delivery_release_actions WHERE release_id=${releaseId}::uuid`;
      if (actions.some((a) => ["prepared", "effect_started", "held"].includes(a.phase)))
        return "waiting";
      if (
        release.snapshot.native &&
        (release.snapshot.native as { purpose?: string }).purpose === "publication" &&
        !actions.some((a) => a.kind === "merge" && a.phase === "observed")
      )
        return prepareReleaseMergeFromFacts(db, lifecycle, {
          ownerId,
          releaseId,
          taskId: release.task_id,
          riskAttestationDigest: String(release.snapshot.riskAttestationDigest),
        });
      if (actions.some((a) => a.kind === "promote" && a.phase === "observed")) return "waiting";
      const artifacts = await db.$queryRaw<
        { manifest: unknown }[]
      >`SELECT manifest FROM delivery_native_release_artifacts WHERE owner_id=${ownerId}::uuid AND release_id=${releaseId}::uuid ORDER BY created_at,id LIMIT 2`;
      if (artifacts.length !== 1) return "waiting";
      await nativePlanner.prepareArtifact(
        nativeArtifactSchema.parse(artifacts[0].manifest),
        AbortSignal.timeout(10000),
      );
      return "prepared";
    },
  };
  const controller = {
    kind: "native-preview" as const,
    lifecycle,
    publications,
    async stageArtifact(raw: unknown, token: string, signal: AbortSignal) {
      const stored = await publications.submitArtifact(raw, token, signal);
      const action = await nativePlanner.prepareArtifact(nativeArtifactSchema.parse(raw), signal);
      return { ...stored, ...action };
    },
    async step(ownerId: string, actionId: string, signal: AbortSignal) {
      const row = (
        await db.$queryRaw<
          { kind: string; phase: string; expires_at: Date | null }[]
        >`SELECT a.kind,a.phase,g.expires_at FROM delivery_release_actions a JOIN delivery_releases r ON r.id=a.release_id LEFT JOIN delivery_native_publication_grants g ON g.action_id=a.id WHERE a.id=${actionId}::uuid AND r.owner_id=${ownerId}::uuid`
      )[0];
      if (!row) return "not_found";
      if (row.kind === "merge") {
        const runner = new ReleaseEffectRunner(
            new PostgresReleaseEffectJournal(db, ownerId, authorize),
            github,
          ),
          result = await runner.dispatch(actionId, signal);
        return result === "not_started" ? runner.reconcile(actionId, signal) : result;
      }
      if (row.phase === "prepared") return "waiting_for_protected_publisher";
      if (row.phase === "observed") return "observed";
      const pending = await publications.pendingReceipt(ownerId, actionId);
      if (!pending) {
        if (
          row.phase === "effect_started" &&
          row.expires_at &&
          row.expires_at.getTime() > Date.now()
        )
          return "publishing";
        await publications.holdUnacknowledged(ownerId, actionId);
        return "held";
      }
      try {
        const evidence = await readback.verify(pending.grant, pending.receipt, signal);
        return (await publications.record(ownerId, pending.identity, evidence))
          ? "observed"
          : "held";
      } catch {
        await publications.hold(ownerId, pending.identity);
        return "held";
      }
    },
    builds: {
      async verifyRun(ownerId: string, releaseId: string, signal: AbortSignal) {
        const rows = await db.$queryRaw<
          { manifest: unknown }[]
        >`SELECT manifest FROM delivery_native_release_artifacts WHERE owner_id=${ownerId}::uuid AND release_id=${releaseId}::uuid LIMIT 2`;
        if (rows.length !== 1) return "waiting";
        await verifyNativeBuilder(
          rows[0].manifest,
          config.builder,
          githubToken,
          signal,
          portableFetch,
        );
        return "verified";
      },
    },
    async observe(ownerId: string, releaseId: string, signal: AbortSignal) {
      const release = (
        await db.$queryRaw<
          { phase: string; target_digest: string; active_release_id: string | null }[]
        >`SELECT r.phase,r.target_digest,t.active_release_id FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest WHERE r.id=${releaseId}::uuid AND r.owner_id=${ownerId}::uuid`
      )[0];
      if (
        !release ||
        release.target_digest !== targetDigest ||
        release.active_release_id !== releaseId
      )
        return "held";
      const kind = release.phase === "held" ? "recover" : "promote",
        publication = await publications.observedPublication(ownerId, releaseId, kind);
      if (!publication) return "waiting";
      let sample: Record<string, unknown>;
      try {
        sample = await readback.sample(publication.grant, publication.receipt, signal);
      } catch {
        // Scope drift/unavailable identity is a hold. Only a still-current,
        // fully authenticated publication can produce a sampled regression.
        if (publication.grant.purpose === "bootstrap-baseline") {
          // A failed/unknown bootstrap sample cannot silently resume into a
          // known-good baseline on a later scheduler tick. This records only
          // the bounded observation failure, not a proved provider regression.
          const evidence = {
            provider: "cloudflare-native-preview",
            scope: "sampled-health-no-atomic-exclusion",
            actionId: publication.identity.id,
            artifactId: publication.grant.artifact.id,
            deploymentId: publication.receipt.deploymentId,
            outcome: "bootstrap-observation-unverified",
            smoke: "unverified",
            metrics: "sampled-only",
            sampledAt: Date.now(),
          };
          return lifecycleFactory(evidence).observe(ownerId, {
            releaseId,
            kind: "regression",
            evidence,
          });
        }
        try {
          await readback.verify(publication.grant, publication.receipt, signal);
        } catch {
          return "held";
        }
        const evidence = {
          provider: "cloudflare-native-preview",
          scope: "sampled-health-no-atomic-exclusion",
          actionId: publication.identity.id,
          artifactId: publication.grant.artifact.id,
          deploymentId: publication.receipt.deploymentId,
          sourceSha: publication.receipt.sourceSha,
          artifactDigest: publication.receipt.artifactDigest,
          publicConfigDigest: publication.receipt.publicConfigDigest,
          smoke: "failed",
          metrics: "sampled-only",
          sampledAt: Date.now(),
        };
        return lifecycleFactory(evidence).observe(ownerId, {
          releaseId,
          kind: "regression",
          evidence,
        });
      }
      const stage = {
        ...sample,
        stageActionId: publication.identity.id,
        stageReceiptDigest: nativeDigest(
          (
            await db.$queryRaw<
              { receipt: unknown }[]
            >`SELECT receipt FROM delivery_release_actions WHERE id=${publication.identity.id}::uuid`
          )[0].receipt,
        ),
      };
      if (kind === "promote")
        await lifecycleFactory(stage).stageReady(ownerId, { releaseId, evidence: stage });
      else
        await db.$transaction(async (tx) => {
          if (!(await authorize(tx, publication.identity)))
            throw Error("native_health_authorization");
          await tx.$executeRaw`INSERT INTO delivery_release_observations(id,release_id,kind,evidence,evidence_digest) VALUES (${randomUUID()}::uuid,${releaseId}::uuid,'stage_ready',${canonicalGitHubSource(stage)}::jsonb,${nativeDigest(stage)}) ON CONFLICT DO NOTHING`;
        });
      const samples = await db.$queryRaw<
        { evidence: Record<string, unknown>; evidence_digest: string }[]
      >`WITH scoped AS (SELECT id,created_at,evidence,evidence_digest FROM delivery_release_observations WHERE release_id=${releaseId}::uuid AND kind='stage_ready' AND evidence->>'actionId'=${publication.identity.id}), retained AS ((SELECT * FROM scoped ORDER BY created_at,id LIMIT 1) UNION (SELECT * FROM scoped ORDER BY created_at DESC,id DESC LIMIT 999)) SELECT evidence,evidence_digest FROM retained ORDER BY created_at,id`;
      const valid = samples.filter(
        (s) =>
          nativeDigest(s.evidence) === s.evidence_digest &&
          s.evidence.provider === "cloudflare-native-preview" &&
          s.evidence.deploymentId === publication.receipt.deploymentId,
      );
      if (valid.length < config.observation.minimumSamples) return "sampling";
      const startedAt = Number(valid[0].evidence.sampledAt),
        endedAt = Number(valid[valid.length - 1].evidence.sampledAt);
      if (endedAt - startedAt < config.observation.windowMs) return "sampling";
      // Final current-ID check; no native branch metrics are fabricated from
      // parent-script analytics. This remains explicitly sampled-only health.
      const current = await readback.readCurrent(signal);
      if (current.deploymentId !== publication.receipt.deploymentId) return "held";
      const evidence = {
        ...sample,
        startedAt,
        endedAt,
        samples: [valid[0].evidence_digest, valid[valid.length - 1].evidence_digest],
        sampleCount: valid.length,
        samplesDigest: nativeDigest(valid.map((s) => s.evidence_digest)),
      };
      return lifecycleFactory(evidence).observe(ownerId, {
        releaseId,
        kind: kind === "promote" ? "healthy" : "recovered",
        evidence,
      });
    },
  };
  let facts: ReleaseAuthorityFacts | null = null,
    opener: ReleaseAutoOpener | undefined;
  if (config.authority.baselines) {
    facts = new ReleaseAuthorityFacts(
      db,
      config.authority,
      repository,
      policies,
      rules,
      risk,
      null,
      null,
      tested,
      {
        targetDigest: () => targetDigest,
        resolveBaseline: () => publications.resolveBaseline(),
        verifyBaseline: async (baseline, signal) => {
          const retained = await publications.resolveBaseline();
          if (nativeDigest(retained) !== nativeDigest(baseline))
            throw Error("native_baseline_changed");
          const a = await publications.artifact(
            config.bootstrap?.ownerId ?? policies()[0]?.ownerId ?? "",
            baseline.artifactId,
          );
          await verifyNativeBuilder(a, config.builder, githubToken, signal, portableFetch);
          return baseline.healthyObservationDigest;
        },
      },
    );
    opener = new ReleaseAutoOpener(
      db,
      targetDigest,
      authorityDigest,
      repository,
      policies,
      new GitHubReleaseSourceDiscovery(
        {
          owner: config.github.owner,
          name: config.github.name,
          repositoryId: config.github.repositoryId,
          baseRef: config.github.allowedBaseRef,
          method: config.authority.mergeMethod,
        },
        githubToken,
        rules,
        portableFetch,
      ),
      facts,
      lifecycle,
    );
  }
  return {
    ...controller,
    facts,
    planner: nativePlanner,
    tested,
    scheduler: new ReleaseScheduler(db, targetDigest, controller, nativePlanner, opener),
    readback,
  };
}
