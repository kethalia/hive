import { z } from "zod";
import {
  githubBotReviewProducer,
  githubCheckProducer,
  githubEvidencePolicySchema,
  githubFormalReviewProducer,
  githubSourceTargetSchema,
} from "./github-contracts";
import { canonicalGitHubSource, githubSourceDigest } from "./github-evidence.server";
import { githubEvidenceProducer } from "./github-persistence.server";
import type { ManagerPolicyScope, ResolvedManagerEvidencePolicy } from "./manager.server";
import { DeliveryConflict } from "./state";

export const githubTaskTargetPolicySchema = z
  .object({
    pullNumber: z.number().int().positive().max(2147483647),
    policy: githubEvidencePolicySchema,
  })
  .strict();
/** Never read this map from request JSON, repository files or host environment. */
export function resolveControllerGitHubTargetPolicy(
  taskId: string,
  readConfig = () => process.env.HIVE_DELIVERY_GITHUB_TARGETS_JSON,
) {
  const raw = readConfig();
  if (!raw || Buffer.byteLength(raw) > 65536)
    throw new Error("GitHub controller policy unavailable");
  let targets: Record<string, z.infer<typeof githubTaskTargetPolicySchema>>;
  try {
    targets = z.record(z.string().uuid(), githubTaskTargetPolicySchema).parse(JSON.parse(raw));
    if (Object.keys(targets).length > 100) throw new Error("Policy map limit");
  } catch {
    throw new Error("GitHub controller policy unavailable");
  }
  if (!Object.hasOwn(targets, taskId)) throw new DeliveryConflict("github_task_policy_missing");
  return targets[taskId];
}
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.string().uuid();
const publicationSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotDigest: digest,
    policyDigest: digest,
    evidenceIds: z.array(uuid).min(1).max(40),
    watermarks: z
      .array(z.object({ key: z.string().min(1).max(1000) }).passthrough())
      .min(1)
      .max(100),
  })
  .passthrough();
const receiptSchema = z
  .object({ challengeId: uuid, snapshotDigest: digest, policyDigest: digest })
  .strict();
const challengeBindingSchema = z
  .object({
    managerBindingId: uuid,
    checkoutBindingDigest: digest,
    policyDigest: digest,
    target: githubSourceTargetSchema,
  })
  .passthrough();

/** Resolve only after signed host authentication and persisted scope checks.
 * The returned closure checks independent persisted source provenance, not any
 * evidence status, producer or PR assertion supplied by the manager. */
export function resolveControllerGitHubManagerPolicy(
  scope: ManagerPolicyScope,
  readConfig = () => process.env.HIVE_DELIVERY_GITHUB_TARGETS_JSON,
): ResolvedManagerEvidencePolicy | null {
  if (
    !(
      ["implement", "review", "validate", "release"].includes(scope.stepKind) ||
      scope.requiredEvidenceKinds.some((kind) => kind === "check" || kind === "review")
    )
  )
    return null;
  const configured = resolveControllerGitHubTargetPolicy(scope.taskId, readConfig);
  const policyDigest = githubSourceDigest(configured.policy);
  const target = githubSourceTargetSchema.parse({
    schemaVersion: 1,
    providerRepositoryId: scope.repositoryId,
    providerAccountId: scope.providerAccountId,
    fullName: scope.fullName,
    expectedHeadSha: scope.sourceSha,
    pullNumber: configured.pullNumber,
  });
  const producer = githubEvidenceProducer(scope.repositoryId, configured.policy);
  const policy = {
    version: configured.policy.version,
    maxAgeMs: configured.policy.maxAgeMs,
    trustedProducers: [producer],
  };
  const groups = [
    ...configured.policy.checks.map((check) => ({
      key: `${githubCheckProducer(scope.repositoryId, check.workflowId, check.appId)}/${check.name}`,
      kind: "check",
      criterionIds: check.criterionIds,
    })),
    ...(configured.policy.codexReview
      ? [
          {
            key: githubBotReviewProducer(
              scope.repositoryId,
              configured.policy.codexReview.userId,
              configured.policy.codexReview.appId,
            ),
            kind: "review",
            criterionIds: configured.policy.codexReview.criterionIds,
          },
        ]
      : []),
    ...configured.policy.formalReviewers.map((review) => ({
      key: githubFormalReviewProducer(scope.repositoryId, review.userId),
      kind: "review",
      criterionIds: review.criterionIds,
    })),
  ];
  return {
    policy,
    authorityDigest: githubSourceDigest({ scope, target, policyDigest }),
    async authorizeReferences(tx, evidenceIds, requireCoverage) {
      if (!evidenceIds.length) {
        if (requireCoverage) throw new DeliveryConflict("github_policy_evidence_missing");
        return;
      }
      const rows = await tx.deliveryEvidence.findMany({
        where: { ownerId: scope.ownerId, stepId: scope.stepId, id: { in: evidenceIds } },
      });
      if (
        rows.length !== evidenceIds.length ||
        rows.some(
          (row) =>
            row.producer !== producer ||
            row.policyVersion !== policy.version ||
            row.sourceSha !== target.expectedHeadSha,
        )
      )
        throw new DeliveryConflict("github_evidence_scope_mismatch");
      const events = await tx.deliveryEvent.findMany({
        where: {
          ownerId: scope.ownerId,
          taskId: scope.taskId,
          stepId: scope.stepId,
          type: "github_evidence_observed",
          OR: evidenceIds.map((id) => ({
            payload: { path: ["evidenceIds"], array_contains: [id] },
          })),
        },
        take: 41,
      });
      if (events.length > 40) throw new DeliveryConflict("github_evidence_provenance_ambiguous");
      const covered = new Set<string>();
      for (const event of events) {
        const parsed = publicationSchema.safeParse(event.payload);
        if (
          !parsed.success ||
          parsed.data.policyDigest !== policyDigest ||
          event.policyVersion !== policy.version
        )
          throw new DeliveryConflict("github_evidence_provenance_missing");
        const published = parsed.data;
        // The publisher aggregates every group for a kind+criterion into its
        // evidence row. Bind that row to the complete configured group set;
        // a passing subset cannot stand for another check/reviewer sharing C1.
        if (
          groups.some(
            (group) => published.watermarks.filter((mark) => mark.key === group.key).length !== 1,
          )
        )
          throw new DeliveryConflict("github_evidence_provenance_missing");
        const consumed = await tx.deliveryEvent.findFirst({
          where: {
            ownerId: scope.ownerId,
            taskId: scope.taskId,
            stepId: scope.stepId,
            type: "github_source_consumed",
            payload: { path: ["snapshotDigest"], equals: published.snapshotDigest },
          },
          orderBy: { createdAt: "desc" },
        });
        const receipt = receiptSchema.safeParse(consumed?.payload);
        if (
          !receipt.success ||
          receipt.data.policyDigest !== policyDigest ||
          consumed?.policyVersion !== policy.version
        )
          throw new DeliveryConflict("github_evidence_provenance_missing");
        const requested = await tx.deliveryEvent.findUnique({
          where: { ownerId_id: { ownerId: scope.ownerId, id: receipt.data.challengeId } },
        });
        const challenge = challengeBindingSchema.safeParse(requested?.payload);
        if (
          !challenge.success ||
          requested?.type !== "github_source_challenge" ||
          requested.taskId !== scope.taskId ||
          requested.stepId !== scope.stepId ||
          challenge.data.managerBindingId !== scope.managerBindingId ||
          challenge.data.checkoutBindingDigest !== scope.checkoutBindingDigest ||
          challenge.data.policyDigest !== policyDigest ||
          canonicalGitHubSource(challenge.data.target) !== canonicalGitHubSource(target)
        )
          throw new DeliveryConflict("github_evidence_target_mismatch");
        for (const id of published.evidenceIds.filter((id) => evidenceIds.includes(id))) {
          if (covered.has(id)) throw new DeliveryConflict("github_evidence_provenance_ambiguous");
          covered.add(id);
        }
      }
      if (covered.size !== evidenceIds.length)
        throw new DeliveryConflict("github_evidence_provenance_missing");
      if (requireCoverage) {
        if (
          groups.some((group) =>
            group.criterionIds.some(
              (criterion) =>
                !rows.some(
                  (row) => row.kind === group.kind && row.criterionIds.includes(criterion),
                ),
            ),
          )
        )
          throw new DeliveryConflict("github_policy_evidence_missing");
      }
    },
  };
}
