import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { releaseBaselinesSchema } from "./release-baseline-contracts";
import type { CloudflareReleaseProvider } from "./release-cloudflare-provider.server";

type Tx = Prisma.TransactionClient;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pinSchema = z
  .object({ catalogDigest: digest, planEventId: z.string().uuid(), planDigest: digest })
  .strict();
const stateSchema = z
  .object({
    releaseId: z.string().uuid(),
    ownerId: z.string().uuid(),
    taskId: z.string().uuid(),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    targetDigest: digest,
    generation: z.number().int().positive(),
    snapshotDigest: digest,
    database: pinSchema,
    expected: releaseBaselinesSchema,
  })
  .strict();
type State = z.infer<typeof stateSchema>;

/** Read the immutable release and observed effect receipts under the target
 * lock. Any unresolved provider effect prevents a deployment assertion. */
async function state(
  tx: Tx,
  ownerId: string,
  releaseId: string,
  reconcilingActionId?: string,
): Promise<State> {
  const rows = await tx.$queryRaw<
    {
      owner_id: string;
      task_id: string;
      source_sha: string;
      target_digest: string;
      generation: number;
      snapshot: unknown;
      snapshot_digest: string;
    }[]
  >`
    SELECT r.owner_id,r.task_id,s.head_sha AS source_sha,r.target_digest,t.generation,r.snapshot,r.snapshot_digest
    FROM delivery_releases r JOIN delivery_release_targets t ON t.target_digest=r.target_digest
    JOIN delivery_source_revisions s ON s.id=r.source_revision_id AND s.owner_id=r.owner_id
    WHERE r.id=${releaseId}::uuid AND r.owner_id=${ownerId}::uuid AND t.active_release_id=r.id AND r.phase IN ('active','held') FOR UPDATE OF t,r`;
  const row = rows[0];
  if (rows.length !== 1 || githubSourceDigest(row.snapshot) !== row.snapshot_digest)
    throw Error("release_database_observation_scope");
  const snapshot = z
    .object({ database: pinSchema, baselines: releaseBaselinesSchema })
    .passthrough()
    .parse(row.snapshot);
  const actions = await tx.$queryRaw<
    {
      id: string;
      kind: string;
      phase: string;
      request: unknown;
      request_digest: string;
      receipt: unknown;
      receipt_digest: string | null;
    }[]
  >`
    SELECT id,kind,phase,request,request_digest,receipt,receipt_digest FROM delivery_release_actions
    WHERE release_id=${releaseId}::uuid AND kind IN ('promote','recover') ORDER BY created_at,id`;
  if (
    actions.some(
      (a) => (a.phase === "effect_started" || a.phase === "held") && a.id !== reconcilingActionId,
    )
  )
    throw Error("release_database_observation_uncertain");
  const expected = structuredClone(snapshot.baselines);
  for (const action of actions.filter((a) => a.phase === "observed")) {
    const request = z
      .object({
        component: z.enum(["app", "auth"]),
        versionId: z.string().uuid(),
        mergedSha: z.string().regex(/^[a-f0-9]{40}$/),
        artifactDigest: digest,
        configDigest: digest,
      })
      .passthrough()
      .parse(action.request);
    const receipt = z
      .object({
        deploymentId: z.string().uuid(),
        versionId: z.string().uuid(),
        component: z.enum(["app", "auth"]),
        targetDigest: digest,
        mergedSha: z.string().regex(/^[a-f0-9]{40}$/),
        artifactDigest: digest,
        configDigest: digest,
      })
      .passthrough()
      .parse(action.receipt);
    if (
      githubSourceDigest(action.request) !== action.request_digest ||
      githubSourceDigest(action.receipt) !== action.receipt_digest ||
      receipt.component !== request.component ||
      receipt.versionId !== request.versionId ||
      receipt.targetDigest !== row.target_digest ||
      receipt.mergedSha !== request.mergedSha ||
      receipt.artifactDigest !== request.artifactDigest ||
      receipt.configDigest !== request.configDigest
    )
      throw Error("release_database_observation_receipt");
    expected[request.component] = {
      deploymentId: receipt.deploymentId,
      versionId: request.versionId,
      sourceSha: request.mergedSha,
      artifactDigest: request.artifactDigest,
      configDigest: request.configDigest,
    };
  }
  return stateSchema.parse({
    releaseId,
    ownerId,
    taskId: row.task_id,
    sourceSha: row.source_sha,
    targetDigest: row.target_digest,
    generation: row.generation,
    snapshotDigest: row.snapshot_digest,
    database: snapshot.database,
    expected,
  });
}

/** Provider reads happen outside transactions. A second locked state comparison
 * rejects release, pin, generation or receipt changes during either read. */
export class ReleaseDatabaseObserver {
  constructor(
    private readonly db: PrismaClient,
    private readonly provider: CloudflareReleaseProvider,
  ) {}
  async observe(ownerId: string, releaseId: string, signal: AbortSignal) {
    const first = await this.db.$transaction((tx) => state(tx, ownerId, releaseId));
    const started = Date.now();
    for (const component of ["app", "auth"] as const) {
      const current = await this.provider.inspectCurrent(component, signal);
      const version = await this.provider.inspectVersion(component, current.versionId, signal);
      const after = await this.provider.inspectCurrent(component, signal);
      const expected = first.expected[component];
      if (
        current.deploymentId !== expected.deploymentId ||
        current.versionId !== expected.versionId ||
        canonicalGitHubSource(current) !== canonicalGitHubSource(after) ||
        version.configDigest !== expected.configDigest ||
        signal.aborted
      )
        throw Error("release_database_observation_drift");
    }
    await this.db.$transaction(
      async (tx) => {
        const current = await state(tx, ownerId, releaseId);
        const now = (
          await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
        )[0].now.getTime();
        if (
          githubSourceDigest(current) !== githubSourceDigest(first) ||
          started > now ||
          now - started >= 30000 ||
          signal.aborted
        )
          throw Error("release_database_observation_stale");
        const evidence = { ...first, startedAt: started };
        await tx.$executeRaw`INSERT INTO delivery_release_deployment_observations(id,release_id,generation,evidence,evidence_digest) VALUES (${randomUUID()}::uuid,${releaseId}::uuid,${first.generation},${canonicalGitHubSource(evidence)}::jsonb,${githubSourceDigest(evidence)})`;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}

/** Only the deployment-owned producer writes these immutable observations. */
export async function readReleaseDatabaseDeployment(
  tx: Tx,
  ownerId: string,
  releaseId: string,
  reconcilingActionId?: string,
) {
  const current = await state(tx, ownerId, releaseId, reconcilingActionId);
  const rows = await tx.$queryRaw<
    { evidence: unknown; evidence_digest: string; observed_at: Date; now: Date }[]
  >`
    SELECT evidence,evidence_digest,observed_at,clock_timestamp() AS now FROM delivery_release_deployment_observations
    WHERE release_id=${releaseId}::uuid AND generation=${current.generation} ORDER BY observed_at DESC,id DESC LIMIT 1`;
  if (rows.length !== 1 || githubSourceDigest(rows[0].evidence) !== rows[0].evidence_digest)
    return null;
  const parsed = stateSchema
    .extend({ startedAt: z.number().int().safe() })
    .safeParse(rows[0].evidence);
  if (!parsed.success) return null;
  const { startedAt, ...recorded } = parsed.data;
  if (
    !(
      startedAt <= rows[0].observed_at.getTime() &&
      rows[0].now.getTime() - startedAt < 30000 &&
      githubSourceDigest(recorded) === githubSourceDigest(current)
    )
  )
    return null;
  return { ...current, startedAt, expiresAt: startedAt + 30000 };
}
export async function verifyReleaseDatabaseDeployment(
  tx: Tx,
  ownerId: string,
  releaseId: string,
  reconcilingActionId?: string,
) {
  return !!(await readReleaseDatabaseDeployment(tx, ownerId, releaseId, reconcilingActionId));
}
