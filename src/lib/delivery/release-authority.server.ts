import type { Prisma } from "@hive/db";
import { z } from "zod";
import { githubSourceDigest } from "./github-evidence.server";
import type { ReleaseActionIdentity } from "./release-action-journal";
import { releaseBaselinesSchema } from "./release-baseline-contracts";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import { releasePolicyCovers, releasePolicySchema } from "./release-policy-contracts";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    topology: z.literal("single").optional(),
    policyVersionId: z.string().uuid(),
    repositoryPolicyDigest: digest,
    repositoryBindingDigest: digest,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    riskAttestationDigest: digest,
    observationWindowMs: z.number().int().min(1000).max(86400000).safe(),
    observationConfigDigest: digest,
    buildAuthorityDigest: digest,
    authorityConfigDigest: digest,
    baselines: releaseBaselinesSchema,
    riskClass: z.literal("database").optional(),
    database: z
      .object({ catalogDigest: digest, planEventId: z.string().uuid(), planDigest: digest })
      .strict()
      .optional(),
  })
  .strict();
type Tx = Prisma.TransactionClient;

/** Deployment-owned catalog is an operator enrollment. Missing flag/catalog,
 * duplicates, malformed entries and policy rotation fail closed. This factory
 * installs no provider credential or external action. Catalog changes are a
 * separate deployment authority, never controlled by manager request bodies. */
export function configuredReleasePolicies(env: Record<string, string | undefined> = process.env) {
  if (env.HIVE_DELIVERY_RELEASE_ENABLED !== "true") return [];
  const raw = env.HIVE_DELIVERY_RELEASE_POLICIES_JSON;
  if (!raw || Buffer.byteLength(raw) > 262144) throw new Error("release_policy_unavailable");
  const policies = z.array(releasePolicySchema).max(32).parse(JSON.parse(raw));
  if (new Set(policies.map((p) => p.versionId)).size !== policies.length)
    throw new Error("release_policy_ambiguous");
  return policies;
}

/** The last verifier must independently authenticate risk classification,
 * current GitHub rules/review/checks, source and phase-specific artifact/health
 * facts under this transaction. It is deliberately required: no fallback can
 * turn absent D08/F06-F08 evidence into a production capability. */
export function createReleaseAuthorizer(options: {
  repositoryPolicies: RepositoryPolicyStore;
  policies: () => unknown;
  productionEnabled?: boolean;
  verifyDatabase?(
    tx: Tx,
    context: {
      ownerId: string;
      taskId: string;
      sourceSha: string;
      identity: ReleaseActionIdentity;
      database: { catalogDigest: string; planEventId: string; planDigest: string };
    },
  ): Promise<boolean>;
  verifyCurrent(
    tx: Tx,
    context: {
      identity: ReleaseActionIdentity;
      releaseId: string;
      ownerId: string;
      taskId: string;
      sourceSha: string;
      riskAttestationDigest: string;
      riskClass: "application_only" | "database";
      baselines: z.infer<typeof releaseBaselinesSchema>;
    },
  ): Promise<boolean>;
}) {
  return async (tx: Tx, identity: ReleaseActionIdentity): Promise<boolean> => {
    const rows = await tx.$queryRaw<
      {
        owner_id: string;
        task_id: string;
        source_revision_id: string;
        target_digest: string;
        policy_digest: string;
        snapshot: unknown;
        snapshot_digest: string;
        phase: string;
      }[]
    >`SELECT owner_id,task_id,source_revision_id,target_digest,policy_digest,snapshot,snapshot_digest,phase
      FROM delivery_releases WHERE id=${identity.releaseId}::uuid FOR UPDATE`;
    const release = rows[0];
    if (
      !release ||
      release.target_digest !== identity.targetDigest ||
      githubSourceDigest(release.snapshot) !== release.snapshot_digest
    )
      return false;
    const parsedSnapshot = snapshotSchema.safeParse(release.snapshot);
    if (!parsedSnapshot.success) return false;
    const snapshot = parsedSnapshot.data;
    if ((snapshot.riskClass === "database") !== !!snapshot.database) return false;
    const policies = z.array(releasePolicySchema).max(32).safeParse(options.policies());
    if (!policies.success) return false;
    const matching = policies.data.filter((p) => p.versionId === snapshot.policyVersionId);
    if (matching.length !== 1) return false;
    const policy = matching[0];
    if (policy.environmentKey !== "preview" && options.productionEnabled !== true) return false;
    if (githubSourceDigest(policy) !== release.policy_digest) return false;
    const bound = await options.repositoryPolicies.resolveTask(
      tx,
      release.owner_id,
      release.task_id,
    );
    if (
      !bound ||
      bound.task.pauseRequested ||
      bound.task.schedulingPaused ||
      bound.task.sourceRevisionId !== release.source_revision_id ||
      bound.task.sourceSha !== snapshot.sourceSha ||
      bound.binding.policyDigest !== snapshot.repositoryPolicyDigest ||
      bound.binding.bindingDigest !== snapshot.repositoryBindingDigest ||
      !bound.task.currentSourceRevision ||
      bound.task.currentSourceRevision.headSha !== snapshot.sourceSha
    )
      return false;
    const source = bound.task.currentSourceRevision;
    if (identity.kind === "merge") {
      const request = githubReleaseRequestSchema.safeParse(identity.request);
      if (
        !request.success ||
        request.data.repositoryId !== source.repositoryId ||
        request.data.pullRequestId !== source.pullRequestId ||
        request.data.pullNumber !== source.pullNumber ||
        request.data.headSha !== source.headSha ||
        request.data.baseRef !== source.baseBranch
      )
        return false;
    }
    const now = (
      await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`
    )[0].now.getTime();
    if (
      !releasePolicyCovers(
        policy,
        {
          ownerId: release.owner_id,
          repositoryId: source.repositoryId,
          providerAccountId: source.providerAccountId,
          environmentKey: policy.environmentKey,
          targetDigest: release.target_digest,
          action: identity.kind,
          // The attestation is only a claim here; verifyCurrent authenticates it.
          riskClass: snapshot.riskClass ?? "application_only",
        },
        now,
      )
    )
      return false;
    if (
      snapshot.database &&
      (!options.verifyDatabase ||
        (identity.kind !== "merge" &&
          !(await options.verifyDatabase(tx, {
            ownerId: release.owner_id,
            taskId: release.task_id,
            sourceSha: snapshot.sourceSha,
            identity,
            database: snapshot.database,
          }))))
    )
      return false;
    return options.verifyCurrent(tx, {
      identity,
      releaseId: identity.releaseId,
      ownerId: release.owner_id,
      taskId: release.task_id,
      sourceSha: snapshot.sourceSha,
      riskAttestationDigest: snapshot.riskAttestationDigest,
      riskClass: snapshot.riskClass ?? "application_only",
      baselines: snapshot.baselines,
    });
  };
}
