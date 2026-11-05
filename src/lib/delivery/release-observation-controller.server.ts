import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { releaseActionIdentitySchema } from "./release-action-journal";
import { releaseBaselinesSchema } from "./release-baseline-contracts";
import type { ReleaseLifecycle } from "./release-lifecycle.server";
import type { CloudflareReleaseObserver } from "./release-observer.server";

type Tx = Prisma.TransactionClient;
const uuid = z.string().uuid();
const component = z
  .object({
    deploymentId: uuid,
    versionId: uuid,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Fixed producer-to-lifecycle bridge. The caller authenticates the owner; this
 * controller derives both identities from durable provider receipts, never
 * from a manager or browser. The lifecycle factory binds its verifier to this
 * exact producer output. Candidate policy/evidence authorization is repeated
 * in both transactions through the required action verifier. */
export class ReleaseObservationController {
  constructor(
    private readonly db: PrismaClient,
    private readonly observer: CloudflareReleaseObserver,
    private readonly authorize: (
      tx: Tx,
      identity: z.infer<typeof releaseActionIdentitySchema>,
    ) => Promise<boolean>,
    private readonly lifecycleFactory: (
      verify: (
        tx: Tx,
        input: {
          releaseId: string;
          kind: "stage_ready" | "healthy" | "regression" | "recovered";
          evidence: Record<string, unknown>;
        },
      ) => Promise<boolean>,
    ) => ReleaseLifecycle,
  ) {}
  private async scope(tx: Tx, ownerId: string, releaseId: string) {
    const rows = await tx.$queryRaw<
      {
        phase: string;
        target_digest: string;
        snapshot: unknown;
        snapshot_digest: string;
        generation: number;
      }[]
    >`SELECT r.phase,r.target_digest,r.snapshot,r.snapshot_digest,t.generation FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest
      WHERE r.id=${releaseId}::uuid AND r.owner_id=${ownerId}::uuid AND t.active_release_id=r.id FOR UPDATE OF t,r`;
    const release = rows[0];
    if (
      !release ||
      !["active", "held"].includes(release.phase) ||
      release.target_digest !== this.observer.targetDigest() ||
      githubSourceDigest(release.snapshot) !== release.snapshot_digest
    )
      throw new Error("release_observation_scope_changed");
    const config = z
      .object({
        observationWindowMs: z.number().int().min(1000).max(86400000),
        observationConfigDigest: z.string().regex(/^[a-f0-9]{64}$/),
        baselines: releaseBaselinesSchema,
      })
      .passthrough()
      .parse(release.snapshot);
    if (config.observationConfigDigest !== this.observer.configDigest())
      throw new Error("release_observation_scope_changed");
    const duration = config.observationWindowMs;
    const kind = release.phase === "active" ? "promote" : "recover";
    const actions = await tx.$queryRaw<
      {
        id: string;
        kind: string;
        target_digest: string;
        request: Record<string, unknown>;
        request_digest: string;
        generation: number;
        receipt: Record<string, unknown>;
        receipt_digest: string;
        updated_at: Date;
      }[]
    >`SELECT id,kind,target_digest,request,request_digest,generation,receipt,receipt_digest,updated_at FROM delivery_release_actions
      WHERE release_id=${releaseId}::uuid AND phase='observed' AND kind=${kind} ORDER BY id`;
    const promotions = await tx.$queryRaw<
      { request: Record<string, unknown> }[]
    >`SELECT request FROM delivery_release_actions WHERE release_id=${releaseId}::uuid AND phase='observed' AND kind='promote'`;
    const pending = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM delivery_release_actions WHERE release_id=${releaseId}::uuid AND phase IN ('prepared','effect_started','held') LIMIT 1`;
    if (
      pending.length ||
      (kind === "promote" && (actions.length < 1 || actions.length > 2)) ||
      (kind === "recover" && (!promotions.length || actions.length !== promotions.length))
    )
      throw new Error("release_observation_scope_changed");
    const result: Partial<Record<"app" | "auth", z.infer<typeof component>>> = {};
    let startedAt = 0;
    for (const action of actions) {
      const identity = releaseActionIdentitySchema.parse({
        id: action.id,
        releaseId,
        kind: action.kind,
        targetDigest: action.target_digest,
        request: action.request,
        requestDigest: action.request_digest,
        generation: action.generation,
      });
      if (
        identity.generation !== release.generation ||
        githubSourceDigest(action.receipt) !== action.receipt_digest ||
        !(await this.authorize(tx, identity))
      )
        throw new Error("release_observation_scope_changed");
      const name = z.enum(["app", "auth"]).parse(action.request.component);
      if (
        result[name] ||
        action.receipt.provider !== "cloudflare" ||
        action.receipt.actionId !== identity.id ||
        action.receipt.targetDigest !== identity.targetDigest ||
        action.receipt.component !== name ||
        action.receipt.versionId !== action.request.versionId ||
        action.receipt.mergedSha !== action.request.mergedSha ||
        action.receipt.artifactDigest !== action.request.artifactDigest
      )
        throw new Error("release_observation_scope_changed");
      result[name] = component.parse({
        deploymentId: action.receipt.deploymentId,
        versionId: action.receipt.versionId,
        sourceSha: action.receipt.mergedSha,
        artifactDigest: action.receipt.artifactDigest,
      });
      startedAt = Math.max(startedAt, action.updated_at.getTime());
    }
    if (kind === "recover" || (kind === "promote" && actions.length === 1)) {
      for (const name of ["app", "auth"] as const) {
        if (!result[name]) {
          if (kind === "recover" && promotions.some((p) => p.request.component === name))
            throw new Error("release_observation_scope_changed");
          const baseline = config.baselines[name];
          result[name] = component.parse({
            deploymentId: baseline.deploymentId,
            versionId: baseline.versionId,
            sourceSha: baseline.sourceSha,
            artifactDigest: baseline.artifactDigest,
          });
        }
      }
    }
    if (
      !result.app ||
      !result.auth ||
      (kind === "promote" && actions.length === 2 && result.app.sourceSha !== result.auth.sourceSha)
    )
      throw new Error("release_observation_scope_changed");
    return {
      startedAt,
      app: result.app,
      auth: result.auth,
      duration,
      mode: kind,
      fullyPromoted: kind !== "promote" || actions.length === 2,
      stageActionId: kind === "promote" && actions.length === 1 ? actions[0].id : null,
      stageReceiptDigest:
        kind === "promote" && actions.length === 1 ? actions[0].receipt_digest : null,
      snapshotDigest: release.snapshot_digest,
    };
  }
  async observe(ownerId: string, releaseId: string, signal: AbortSignal) {
    uuid.parse(ownerId);
    uuid.parse(releaseId);
    const first = await this.db.$transaction(
      async (tx) => {
        const scope = await this.scope(tx, ownerId, releaseId),
          now = (
            await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
          )[0].now.getTime();
        return { scope, endedAt: now - this.observer.settleDelayMs() };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 },
    );
    const scope = {
      startedAt: first.scope.startedAt,
      endedAt: Math.max(0, first.endedAt),
      app: first.scope.app,
      auth: first.scope.auth,
    };
    const smoke = await this.observer.probe(scope, signal);
    if (smoke.evidence.smoke === "passed" && !first.scope.fullyPromoted) {
      const evidence = {
        ...smoke.evidence,
        stageActionId: first.scope.stageActionId,
        stageReceiptDigest: first.scope.stageReceiptDigest,
      };
      const digest = githubSourceDigest(evidence);
      const lifecycle = this.lifecycleFactory(async (tx, candidate) => {
        if (
          candidate.releaseId !== releaseId ||
          candidate.kind !== "stage_ready" ||
          githubSourceDigest(candidate.evidence) !== digest ||
          canonicalGitHubSource(candidate.evidence) !== canonicalGitHubSource(evidence)
        )
          return false;
        return (
          canonicalGitHubSource(await this.scope(tx, ownerId, releaseId)) ===
          canonicalGitHubSource(first.scope)
        );
      });
      if (signal.aborted) return { phase: "pending" as const };
      return lifecycle.stageReady(ownerId, { releaseId, evidence });
    }
    if (
      smoke.evidence.smoke === "passed" &&
      first.endedAt - first.scope.startedAt < first.scope.duration
    )
      return { phase: "pending" as const };
    const result =
      smoke.evidence.smoke === "failed" ? smoke : await this.observer.observe(scope, signal);
    if (
      first.scope.mode === "recover" &&
      (result.evidence.metrics !== "passed" || result.evidence.smoke !== "passed")
    )
      return { phase: "pending" as const };
    const kind =
      first.scope.mode === "recover"
        ? ("recovered" as const)
        : result.evidence.metrics === "passed" && result.evidence.smoke === "passed"
          ? ("healthy" as const)
          : ("regression" as const);
    const lifecycle = this.lifecycleFactory(async (tx, candidate) => {
      if (
        candidate.releaseId !== releaseId ||
        candidate.kind !== kind ||
        githubSourceDigest(candidate.evidence) !== result.evidenceDigest ||
        canonicalGitHubSource(candidate.evidence) !== canonicalGitHubSource(result.evidence)
      )
        return false;
      const current = await this.scope(tx, ownerId, releaseId);
      return canonicalGitHubSource(current) === canonicalGitHubSource(first.scope);
    });
    if (signal.aborted) return { phase: "pending" as const };
    return lifecycle.observe(ownerId, { releaseId, kind, evidence: result.evidence });
  }
}
