import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@hive/db";
import { z } from "zod";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { releaseBaselinesSchema } from "./release-baseline-contracts";
import { releaseBuildManifestSchema } from "./release-build-attestation.server";
import type { GitHubReleaseChangeRisk } from "./release-change-risk.server";
import type { CloudflareReleaseProvider } from "./release-cloudflare-provider.server";
import { verifyReleaseEvidence } from "./release-evidence.server";
import { githubReleaseRequestSchema } from "./release-github-provider.server";
import type { GitHubReleaseRules } from "./release-github-rules.server";
import { nativeBaselineSchema } from "./release-native-preview-contracts";
import type { CloudflareReleaseObserver } from "./release-observer.server";
import { releasePolicySchema } from "./release-policy-contracts";
import { releaseTestWorkflowSchema } from "./release-tested-attestation.server";
import { releaseTestRunConfigSchema } from "./release-tested-run.server";
import { type ReleaseTestStore, verifyReleaseTestReceipt } from "./release-tested-store.server";
import type { RepositoryPolicyStore } from "./repository-policy-store.server";

const configSchema = z
  .object({
    targetDigest: z.string().regex(/^[a-f0-9]{64}$/),
    riskCatalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
    mergeMethod: z.enum(["merge", "squash", "rebase"]),
    baselines: z.union([releaseBaselinesSchema, nativeBaselineSchema]),
    tested: z
      .object({ workflow: releaseTestWorkflowSchema, run: releaseTestRunConfigSchema })
      .strict()
      .optional(),
  })
  .strict();
const inputSchema = z
  .object({
    ownerId: z.string().uuid(),
    taskId: z.string().uuid(),
    policyVersionId: z.string().uuid(),
    request: githubReleaseRequestSchema,
  })
  .strict();
const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: z.number().int().nonnegative().safe(),
    request: githubReleaseRequestSchema,
    baselines: z.union([releaseBaselinesSchema, nativeBaselineSchema]),
    risk: z.object({ riskClass: z.enum(["application_only", "database"]) }).passthrough(),
    rules: z.unknown(),
    testedMergeSha: z.string().regex(/^[a-f0-9]{40}$/),
    testedAttestationDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    healthDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** Only the deployment-owned producer can mint these facts. The DB write locks
 * and revalidates exact persisted source/evidence after all bounded remote reads.
 * Historical facts bind a release; fresh merge dispatch separately rereads GitHub. */
export class ReleaseAuthorityFacts {
  private readonly config: z.infer<typeof configSchema>;
  constructor(
    private readonly db: PrismaClient,
    rawConfig: unknown,
    private readonly store: RepositoryPolicyStore,
    private readonly policies: () => unknown,
    private readonly rules: GitHubReleaseRules,
    private readonly risk: GitHubReleaseChangeRisk,
    private readonly cloudflare: CloudflareReleaseProvider | null,
    private readonly observer: CloudflareReleaseObserver | null,
    private readonly testedStore?: ReleaseTestStore,
    private readonly native?: {
      targetDigest(): string;
      resolveBaseline(): Promise<z.infer<typeof nativeBaselineSchema>>;
      verifyBaseline(
        baseline: z.infer<typeof nativeBaselineSchema>,
        signal: AbortSignal,
      ): Promise<string>;
    },
  ) {
    this.config = configSchema.parse(rawConfig);
  }
  /** Carry forward the last journaled healthy deployment; the enrolled
   * bootstrap baseline is used only before the first healthy Hive release. */
  async resolveBaseline() {
    if (this.native) return this.native.resolveBaseline();
    // Resolving retained journal history (or the enrolled bootstrap) is a
    // database-only read. Live provider dependencies are required by capture,
    // which separately verifies configuration/readiness before minting facts.
    const rows = await this.db.$queryRaw<
      { id: string; manifest: unknown; manifest_digest: string }[]
    >`SELECT r.id,b.manifest,b.manifest_digest FROM delivery_releases r JOIN delivery_release_build_attestations b ON b.release_id=r.id AND b.owner_id=r.owner_id JOIN delivery_release_build_verifications v ON v.attestation_id=b.id AND v.owner_id=b.owner_id WHERE r.target_digest=${this.config.targetDigest} AND r.phase='healthy' ORDER BY r.created_at DESC,r.id DESC LIMIT 1`;
    if (!rows.length) return releaseBaselinesSchema.parse(this.config.baselines);
    const row = rows[0];
    if (githubSourceDigest(row.manifest) !== row.manifest_digest)
      throw Error("release_facts_baseline");
    const manifest = releaseBuildManifestSchema.parse(row.manifest);
    if (manifest.targetDigest !== this.config.targetDigest || manifest.releaseId !== row.id)
      throw Error("release_facts_baseline");
    const actions = await this.db.$queryRaw<
      { receipt: unknown; receipt_digest: string }[]
    >`SELECT receipt,receipt_digest FROM delivery_release_actions WHERE release_id=${row.id}::uuid AND kind='promote' AND phase='observed'`;
    if (actions.length !== (manifest.topology === "single" ? 1 : 2))
      throw Error("release_facts_baseline");
    const result: Record<string, unknown> = {};
    for (const action of actions) {
      if (githubSourceDigest(action.receipt) !== action.receipt_digest)
        throw Error("release_facts_baseline");
      const receipt = z
        .object({
          provider: z.literal("cloudflare"),
          component: z.enum(["app", "auth"]),
          deploymentId: z.string().uuid(),
          versionId: z.string().uuid(),
          mergedSha: z.string(),
          artifactDigest: z.string(),
          configDigest: z.string(),
          targetDigest: z.string(),
        })
        .passthrough()
        .parse(action.receipt);
      const built = manifest[receipt.component];
      if (manifest.topology === "single" && receipt.component !== "app")
        throw Error("release_facts_baseline");
      if (
        result[receipt.component] ||
        receipt.targetDigest !== this.config.targetDigest ||
        receipt.versionId !== built.versionId ||
        receipt.mergedSha !== manifest.mergeSha ||
        receipt.artifactDigest !== built.artifactDigest ||
        receipt.configDigest !== built.configDigest
      )
        throw Error("release_facts_baseline");
      result[receipt.component] = {
        deploymentId: receipt.deploymentId,
        versionId: receipt.versionId,
        sourceSha: receipt.mergedSha,
        artifactDigest: receipt.artifactDigest,
        configDigest: receipt.configDigest,
      };
    }
    if (manifest.topology === "single" && result.app) result.auth = result.app;
    return releaseBaselinesSchema.parse(result);
  }
  async capture(raw: unknown, signal: AbortSignal) {
    if (
      this.config.riskCatalogDigest !== this.risk.configDigest() ||
      this.config.targetDigest !== (this.native?.targetDigest() ?? this.observer?.targetDigest())
    )
      throw Error("release_facts_scope");
    const input = inputSchema.parse(raw),
      configDigest = githubSourceDigest(this.config),
      started = (await this.db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
    if (input.request.method !== this.config.mergeMethod) throw Error("release_facts_scope");
    const enrolled = await this.db.$transaction((tx) =>
      this.store.resolveTask(tx, input.ownerId, input.taskId),
    );
    if (!enrolled) throw Error("release_facts_scope");
    const tested = await this.rules.verifyTested(
      input.request,
      enrolled.policy.evidenceGates,
      signal,
    );
    if (tested.rulesDigest !== input.request.rulesDigest) throw Error("release_facts_scope");
    if (this.config.tested && !this.testedStore)
      throw Error("release_test_attestation_unavailable");
    const testedAttestationDigest = this.testedStore
      ? await this.testedStore.verifyFresh(input.ownerId, input.taskId, input.request, signal)
      : undefined;
    const baselines = await this.resolveBaseline();
    const legacyBaselines = this.native ? null : releaseBaselinesSchema.parse(baselines);
    const cloudflare = this.cloudflare,
      observer = this.observer;
    if (!this.native && (!cloudflare || !observer)) throw Error("release_facts_unavailable");
    if (
      legacyBaselines &&
      cloudflare?.singleWorker() &&
      githubSourceDigest(legacyBaselines.app) !== githubSourceDigest(legacyBaselines.auth)
    )
      throw Error("release_facts_baseline");
    const before = await this.rules.inspect(input.request, signal);
    if (before.digest !== input.request.rulesDigest) throw Error("release_facts_scope");
    const risk = await this.risk.inspect(input.request, signal);
    const after = await this.rules.inspect(input.request, signal);
    if (after.digest !== before.digest || signal.aborted) throw Error("release_facts_scope");
    if (legacyBaselines && cloudflare)
      for (const component of cloudflare.singleWorker()
        ? (["app"] as const)
        : (["app", "auth"] as const)) {
        const version = await cloudflare.inspectVersion(
          component,
          legacyBaselines[component].versionId,
          signal,
        );
        if (version.configDigest !== legacyBaselines[component].configDigest)
          throw Error("release_facts_baseline");
      }
    const probeInput = {
      startedAt: started.getTime(),
      endedAt: Date.now(),
      ...Object.fromEntries(
        Object.entries(legacyBaselines ?? {}).map(([key, value]) => [
          key,
          {
            deploymentId: value.deploymentId,
            versionId: value.versionId,
            sourceSha: value.sourceSha,
            artifactDigest: value.artifactDigest,
          },
        ]),
      ),
    };
    const health = this.native
      ? {
          evidence: { smoke: "passed" },
          evidenceDigest: await this.native.verifyBaseline(
            nativeBaselineSchema.parse(baselines),
            signal,
          ),
        }
      : observer
        ? await observer.probe(probeInput, signal)
        : null;
    if (!health || health.evidence.smoke !== "passed" || signal.aborted)
      throw Error("release_facts_baseline");
    const payload = payloadSchema.parse({
      schemaVersion: 1,
      observedAt: started.getTime(),
      request: input.request,
      baselines,
      risk: risk.evidence,
      rules: after.evidence,
      testedMergeSha: tested.mergeSha,
      ...(testedAttestationDigest ? { testedAttestationDigest } : {}),
      healthDigest: health.evidenceDigest,
    });
    const encoded = canonicalGitHubSource(payload),
      payloadDigest = githubSourceDigest(payload);
    if (Buffer.byteLength(encoded) > 131072) throw Error("release_facts_limit");
    await this.db.$transaction(
      async (tx) => {
        const bound = await this.store.resolveTask(tx, input.ownerId, input.taskId);
        const source = bound?.task.currentSourceRevision;
        const policies = z
          .array(releasePolicySchema)
          .max(32)
          .parse(this.policies())
          .filter((p) => p.versionId === input.policyVersionId);
        const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
        if (
          !bound ||
          bound.binding.bindingDigest !== enrolled.binding.bindingDigest ||
          !source ||
          policies.length !== 1 ||
          policies[0].ownerId !== input.ownerId ||
          policies[0].repositoryId !== source.repositoryId ||
          policies[0].providerAccountId !== source.providerAccountId ||
          policies[0].targetDigest !== this.config.targetDigest ||
          policies[0].authorityConfigDigest !== configDigest ||
          policies[0].validFrom > now.getTime() ||
          policies[0].expiresAt <= now.getTime() ||
          source.repositoryId !== input.request.repositoryId ||
          source.pullRequestId !== input.request.pullRequestId ||
          source.pullNumber !== input.request.pullNumber ||
          source.headSha !== input.request.headSha ||
          source.baseBranch !== input.request.baseRef ||
          started.getTime() > now.getTime() ||
          now.getTime() - started.getTime() >= 30000 ||
          signal.aborted ||
          (testedAttestationDigest !== undefined &&
            !(await verifyReleaseTestReceipt(tx, {
              ownerId: input.ownerId,
              taskId: input.taskId,
              digest: testedAttestationDigest,
              request: input.request,
            }))) ||
          !(await verifyReleaseEvidence(tx, this.store, {
            ownerId: input.ownerId,
            taskId: input.taskId,
            sourceSha: input.request.headSha,
          }))
        )
          throw Error("release_facts_scope");
        const expiry = new Date(started.getTime() + 30000);
        await tx.$executeRaw`INSERT INTO delivery_release_authority_facts(id,owner_id,task_id,source_sha,target_digest,config_digest,payload,payload_digest,observed_at,expires_at) VALUES (${randomUUID()}::uuid,${input.ownerId}::uuid,${input.taskId}::uuid,${input.request.headSha},${this.config.targetDigest},${configDigest},${encoded}::jsonb,${payloadDigest},${started},${expiry}) ON CONFLICT DO NOTHING`;
        const rows = await tx.$queryRaw<
          { payload: unknown; expires_at: Date }[]
        >`SELECT payload,expires_at FROM delivery_release_authority_facts WHERE owner_id=${input.ownerId}::uuid AND task_id=${input.taskId}::uuid AND payload_digest=${payloadDigest} FOR SHARE`;
        if (
          rows.length !== 1 ||
          canonicalGitHubSource(rows[0].payload) !== encoded ||
          rows[0].expires_at.getTime() <= now.getTime()
        )
          throw Error("release_facts_scope");
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 },
    );
    return {
      riskAttestationDigest: payloadDigest,
      riskClass: risk.evidence.riskClass,
      baselines,
      request: input.request,
    };
  }
}

/** Revalidate immutable producer facts in the caller's locked transaction. The
 * caller chooses freshness according to lifecycle phase: opening/merge need a
 * live fact; later actions retain historical source/risk identity and perform
 * their own fresh provider/readiness checks. */
export async function verifyReleaseAuthorityFact(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string;
    taskId: string;
    sourceSha: string;
    targetDigest: string;
    configDigest: string;
    factDigest: string;
    baselines: unknown;
    request?: unknown;
    fresh: boolean;
    riskClass?: "application_only" | "database";
  },
) {
  const rows = await tx.$queryRaw<
    {
      source_sha: string;
      target_digest: string;
      config_digest: string;
      payload: unknown;
      observed_at: Date;
      expires_at: Date;
      now: Date;
    }[]
  >`SELECT source_sha,target_digest,config_digest,payload,observed_at,expires_at,clock_timestamp() AS now FROM delivery_release_authority_facts WHERE owner_id=${input.ownerId}::uuid AND task_id=${input.taskId}::uuid AND payload_digest=${input.factDigest} FOR SHARE`;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.source_sha !== input.sourceSha ||
    row.target_digest !== input.targetDigest ||
    row.config_digest !== input.configDigest ||
    githubSourceDigest(row.payload) !== input.factDigest ||
    (input.fresh && row.expires_at.getTime() <= row.now.getTime())
  )
    return false;
  const parsed = payloadSchema.safeParse(row.payload);
  if (
    !parsed.success ||
    parsed.data.risk.riskClass !== (input.riskClass ?? "application_only") ||
    parsed.data.observedAt !== row.observed_at.getTime() ||
    parsed.data.request.headSha !== input.sourceSha ||
    canonicalGitHubSource(parsed.data.baselines) !== canonicalGitHubSource(input.baselines)
  )
    return false;
  if (
    input.request &&
    canonicalGitHubSource(parsed.data.request) !== canonicalGitHubSource(input.request)
  )
    return false;
  return true;
}
